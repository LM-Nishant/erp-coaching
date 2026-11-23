import { inflateSync } from 'node:zlib';
import {
  AiProviderError,
  type ChatMessage,
  type ChatRequest,
  type ChatResponse,
  type ProviderConnection,
} from './openai-compatible.client';

/**
 * Deterministic offline AI provider for development and tests. It never calls the network and
 * returns the same output for the same input:
 * - grading prompts: keyword overlap of the student's answer (typed text + simulated OCR) with the
 *   model answer and rubric;
 * - question generation: well-formed sample questions of the requested type;
 * - question paper extraction: parses the page text layer (numbered questions, (A)-(D) options,
 *   "Ans:" lines, answer-key sections, [FIGURE Fn] markers); pages without text yield nothing;
 * - connection tests and any other chat: a short fixed reply.
 *
 * Simulated OCR reads text embedded in PNG `tEXt`/`iTXt`/`zTXt` chunks (keywords below) or JPEG
 * comments, so tests can attach "handwritten" pages whose content is known.
 *
 * Usage is reported like a real provider: ~4 characters per token plus a flat token cost per image.
 */

export const MOCK_TOKENS_PER_IMAGE = 765;
/** Any message containing this marker makes the mock fail like a provider error (tests only). */
export const MOCK_FAILURE_MARKER = '[[mock:fail]]';

const OCR_KEYWORDS = new Set(['ocr', 'answer', 'text', 'description', 'comment', 'handwriting']);

const STOPWORDS = new Set(
  (
    'the and for are but not you all any can had has have her his how its our out was who why with ' +
    'this that these those from into than then them they there their what when where which while ' +
    'will would should could about above after again also been being both each few more most ' +
    'other some such only own same very just over under use used using your yours ours per via ' +
    'does did doing done get got give given let may might must shall upon onto off one two ' +
    'answer question marks mark student students model rubric award points point state explain ' +
    'write show find give typed none provided'
  ).split(/\s+/),
);

export function mockChatCompletion(conn: ProviderConnection, req: ChatRequest): ChatResponse {
  const started = Date.now();
  const system = req.messages
    .filter((m) => m.role === 'system')
    .map(textOf)
    .join('\n');
  const lastUser = [...req.messages].reverse().find((m) => m.role === 'user');
  const userText = lastUser ? textOf(lastUser) : '';
  const images = req.messages.flatMap(imagesOf);

  if (req.messages.some((m) => textOf(m).includes(MOCK_FAILURE_MARKER))) {
    throw new AiProviderError('AI provider returned 500: simulated mock provider failure', 500);
  }

  let content: string;
  if (/Question \(max [\d.]+ marks?\)/.test(userText)) {
    content = JSON.stringify(gradeAnswer(userText, images));
  } else if (/"questions"/.test(system) && /Number of questions:/i.test(userText)) {
    content = JSON.stringify({ questions: generateQuestions(userText) });
  } else if (/QUESTION PAPER EXTRACTION/.test(system)) {
    content = JSON.stringify(extractPaperPage(userText));
  } else if (/\{"ok": ?true\}/.test(system)) {
    content = JSON.stringify({ ok: true });
  } else if (/single word OK/i.test(system)) {
    content = 'OK';
  } else {
    const gist = userText.replace(/\s+/g, ' ').trim().slice(0, 160);
    content = req.jsonMode
      ? JSON.stringify({ reply: `Mock response to: ${gist}` })
      : `Mock response to: ${gist}`;
  }

  const promptChars = req.messages.reduce((n, m) => n + textOf(m).length, 0);
  const promptTokens = Math.ceil(promptChars / 4) + images.length * MOCK_TOKENS_PER_IMAGE;
  const completionTokens = Math.ceil(content.length / 4);
  return {
    content,
    model: conn.model,
    usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens },
    latencyMs: Date.now() - started,
  };
}

function textOf(m: ChatMessage): string {
  if (typeof m.content === 'string') return m.content;
  return m.content
    .map((p) => (p.type === 'text' ? p.text : ''))
    .filter(Boolean)
    .join('\n');
}

function imagesOf(m: ChatMessage): string[] {
  if (typeof m.content === 'string') return [];
  return m.content.flatMap((p) => (p.type === 'image_url' ? [p.image_url.url] : []));
}

/** Number of image parts in a request (used for metering). */
export function countImages(messages: ChatMessage[]): number {
  return messages.reduce((n, m) => n + imagesOf(m).length, 0);
}

// ------------------------------------------------------------------------------ grading

function section(text: string, start: RegExp, end: RegExp): string {
  const s = start.exec(text);
  if (!s) return '';
  const rest = text.slice(s.index + s[0].length);
  const e = end.exec(rest);
  return (e ? rest.slice(0, e.index) : rest).trim();
}

function keywords(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.toLowerCase().match(/[\p{L}\p{N}]+(?:\.\p{N}+)?/gu) ?? []) {
    const word = raw.replace(/^\.+|\.+$/g, '');
    if (seen.has(word) || STOPWORDS.has(word)) continue;
    if (word.length < 3 && !/\d/.test(word)) continue;
    seen.add(word);
    out.push(word);
  }
  return out;
}

/** Crude stemming so "forces" matches "force" and "accelerates" matches "acceleration". */
const stem = (w: string) => (/\d/.test(w) || w.length < 5 ? w : w.slice(0, 5));

function uniqueByStem(words: string[]) {
  const byStem = new Map<string, string>();
  for (const w of words) if (!byStem.has(stem(w))) byStem.set(stem(w), w);
  return [...byStem.values()];
}

export function gradeAnswer(prompt: string, images: string[]) {
  const max = Number(/Question \(max ([\d.]+) marks?\)/.exec(prompt)?.[1] ?? 0);
  const question = section(
    prompt,
    /Question \(max [\d.]+ marks?\):\n/,
    /\n\n(Model answer|Rubric|Student's)/,
  );
  const modelAnswer = /Model answer: \(none provided\)/.test(prompt)
    ? ''
    : section(prompt, /Model answer:\n/, /\n\n(Rubric:|Student's typed answer:)/);
  const rubric = section(prompt, /Rubric:\n/, /\n\nStudent's typed answer:/);
  let typed = section(prompt, /Student's typed answer:\n<<<\n/, /\n>>>/);
  if (typed === '(no typed answer)') typed = '';

  const ocr = images.map(simulatedOcr);
  const unreadable = ocr.filter((t) => t === null).length;
  const handwritten = ocr.filter((t): t is string => !!t).join('\n');
  const answer = [typed, handwritten].filter(Boolean).join('\n').trim();

  if (!answer) {
    return images.length
      ? {
          marks: 0,
          feedback:
            'The handwritten pages could not be read (simulated OCR found no text). Please mark this answer manually.',
          confidence: 0.2,
        }
      : { marks: 0, feedback: 'No answer was provided.', confidence: 0.95 };
  }

  // Rubric numbers are usually marks or percentages, not content the student should mention.
  const rubricWords = keywords(rubric).filter((w) => !/\d/.test(w));
  let reference = uniqueByStem([...keywords(modelAnswer), ...rubricWords]);
  if (!reference.length) reference = uniqueByStem(keywords(question));
  const answerStems = new Set(keywords(answer).map(stem));
  const matched = reference.filter((w) => answerStems.has(stem(w)));
  const missing = reference.filter((w) => !answerStems.has(stem(w)));
  const coverage = reference.length ? matched.length / reference.length : 0;
  const marks = Math.min(max, Math.max(0, Math.round(coverage * max * 2) / 2));

  let confidence = reference.length >= 3 ? 0.85 : 0.4;
  if (unreadable) confidence = Math.min(confidence, 0.5);
  const list = (ws: string[]) => ws.slice(0, 8).join(', ') + (ws.length > 8 ? ', …' : '');
  const feedback = [
    `Covered ${matched.length} of ${reference.length} key points (${Math.round(coverage * 100)}%).`,
    matched.length ? `Mentions: ${list(matched)}.` : '',
    missing.length ? `Missing: ${list(missing)}.` : '',
    handwritten ? 'Handwritten pages were read with simulated OCR.' : '',
    unreadable ? `${unreadable} page(s) could not be read.` : '',
  ]
    .filter(Boolean)
    .join(' ');
  return { marks, feedback, confidence };
}

// ---------------------------------------------------------------------- simulated OCR

/** Text embedded in a `data:` image (PNG text chunks or JPEG comments); null when nothing is readable. */
export function simulatedOcr(url: string): string | null {
  const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(url);
  if (!m) return null;
  const bytes = m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]), 'latin1');
  const text = isPng(bytes) ? pngText(bytes) : isJpeg(bytes) ? jpegComments(bytes) : [];
  const joined = text.join('\n').trim();
  return joined || null;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const isPng = (b: Buffer) => b.length > 8 && b.subarray(0, 8).equals(PNG_SIGNATURE);
const isJpeg = (b: Buffer) => b.length > 4 && b[0] === 0xff && b[1] === 0xd8;

function pngText(b: Buffer): string[] {
  const out: string[] = [];
  let off = 8;
  while (off + 12 <= b.length) {
    const len = b.readUInt32BE(off);
    const type = b.toString('latin1', off + 4, off + 8);
    const data = b.subarray(off + 8, Math.min(off + 8 + len, b.length));
    off += 12 + len;
    if (type === 'IEND') break;
    try {
      const nul = data.indexOf(0);
      if (nul < 0) continue;
      const keyword = data.toString('latin1', 0, nul).toLowerCase();
      if (!OCR_KEYWORDS.has(keyword)) continue;
      if (type === 'tEXt') out.push(data.toString('latin1', nul + 1));
      else if (type === 'zTXt') out.push(inflateSync(data.subarray(nul + 2)).toString('latin1'));
      else if (type === 'iTXt') {
        const compressed = data[nul + 1] === 1;
        const langEnd = data.indexOf(0, nul + 3);
        const transEnd = data.indexOf(0, langEnd + 1);
        if (langEnd < 0 || transEnd < 0) continue;
        const body = data.subarray(transEnd + 1);
        out.push((compressed ? inflateSync(body) : body).toString('utf8'));
      }
    } catch {
      /* malformed chunk: treat as unreadable */
    }
  }
  return out;
}

function jpegComments(b: Buffer): string[] {
  const out: string[] = [];
  let off = 2;
  while (off + 4 <= b.length && b[off] === 0xff) {
    const marker = b[off + 1];
    if (marker === 0xda || marker === 0xd9) break; // start of scan / end of image
    const len = b.readUInt16BE(off + 2);
    if (marker === 0xfe) out.push(b.toString('utf8', off + 4, Math.min(off + 2 + len, b.length)));
    off += 2 + len;
  }
  return out;
}

// ----------------------------------------------------------------- question generation

const DIFFICULTIES = ['easy', 'medium', 'hard'] as const;

function generateQuestions(prompt: string) {
  const field = (name: string) => new RegExp(`^${name}:\\s*(.*)$`, 'im').exec(prompt)?.[1]?.trim() ?? '';
  const topic = field('Topic') || 'General studies';
  const type = field('Question type') || 'single';
  const count = Math.min(Math.max(Number(field('Number of questions')) || 1, 1), 20);
  const requested = field('Difficulty');
  const tag = topic.split('›').pop()!.trim().toLowerCase().slice(0, 40) || 'general';

  return Array.from({ length: count }, (_, i) => {
    const n = i + 1;
    const difficulty = (DIFFICULTIES as readonly string[]).includes(requested)
      ? requested
      : DIFFICULTIES[i % DIFFICULTIES.length];
    const base = {
      type,
      explanation: `Sample explanation ${n} for ${topic}.`,
      difficulty,
      tags: [tag, 'mock'],
    };
    switch (type) {
      case 'multiple':
        return {
          ...base,
          text: `[Mock] Which statements about ${topic} are correct? (${n})`,
          options: ['A', 'B', 'C', 'D'].map((key) => ({ key, text: `Statement ${key} about ${topic}` })),
          answerKey: { options: n % 2 ? ['A', 'C'] : ['B', 'D'] },
        };
      case 'true_false':
        return {
          ...base,
          text: `[Mock] True or false: statement ${n} about ${topic}.`,
          answerKey: { value: n % 2 === 1 },
        };
      case 'numerical':
        return {
          ...base,
          text: `[Mock] Compute quantity ${n} for ${topic}.`,
          answerKey: { value: n * 10, tolerance: 0 },
        };
      case 'descriptive':
        return {
          ...base,
          text: `[Mock] Explain concept ${n} of ${topic}.`,
          answerKey: {
            modelAnswer: `A complete answer defines ${topic}, states the governing principle and gives an example.`,
            rubric: 'Definition 40%, principle 40%, example 20%.',
          },
        };
      default:
        return {
          ...base,
          text: `[Mock] Which option best describes ${topic}? (${n})`,
          options: ['A', 'B', 'C', 'D'].map((key) => ({ key, text: `Option ${key} for ${topic}` })),
          answerKey: { options: [['A', 'B', 'C', 'D'][i % 4]] },
        };
    }
  });
}

// ---------------------------------------------------------------- question paper extraction

interface MockExtracted {
  number: string | null;
  type: string;
  text: string;
  options: { key: string; text: string }[];
  answer: string | null;
  figures: string[];
  continued: boolean;
  confidence: number;
}

const Q_START = /^(?:Q\.?\s*)?(\d{1,3})[.)]\s+(.*)$/i;
const ANS_LINE = /^ans(?:wer)?\s*[:.-]\s*(.+)$/i;
const KEY_HEADING = /^(answer\s*key|answers|key)\b[:\s]*$/i;
const KEY_ENTRY = /(\d{1,3})\s*[-:.)]\s*([A-H](?:\s*,\s*[A-H])*(?![A-Za-z])|-?\d+(?:\.\d+)?|true|false)/gi;

/** Deterministic transcription of a question paper page from its text layer. */
function extractPaperPage(userText: string) {
  const m = /<<<\n([\s\S]*?)\n>>>/.exec(userText);
  const raw = m && m[1] !== '(no text layer)' ? m[1] : '';
  const pageNo = Number(/page (\d+) of/i.exec(userText)?.[1] ?? 1);
  const keyDoc = /ANSWER KEY document/.test(userText);
  const questions: MockExtracted[] = [];
  const answerKey: { number: string; answer: string }[] = [];
  let current: MockExtracted | null = null;
  let inKey = keyDoc;
  const lead: string[] = [];

  const addOptions = (q: MockExtracted, line: string) => {
    const parts = line.split(/\(([A-H])\)\s*/);
    for (let i = 1; i < parts.length; i += 2) q.options.push({ key: parts[i], text: parts[i + 1].trim() });
    return parts[0].trim();
  };
  for (const line of raw
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)) {
    if (KEY_HEADING.test(line)) {
      inKey = true;
      continue;
    }
    if (inKey) {
      for (const e of line.matchAll(KEY_ENTRY))
        answerKey.push({ number: e[1], answer: e[2].replace(/\s+/g, '') });
      continue;
    }
    const fig = /^\[FIGURE (F\d+)\]$/.exec(line);
    if (fig) {
      current?.figures.push(fig[1]);
      continue;
    }
    const start = Q_START.exec(line);
    if (start) {
      current = {
        number: start[1],
        type: '',
        text: '',
        options: [],
        answer: null,
        figures: [],
        continued: false,
        confidence: 0.95,
      };
      questions.push(current);
      current.text = addOptions(current, start[2]);
      continue;
    }
    const ans = ANS_LINE.exec(line);
    if (ans && current) {
      current.answer = ans[1].trim();
      continue;
    }
    if (!current) {
      lead.push(line);
      continue;
    }
    const rest = addOptions(current, line);
    if (rest) current.text = `${current.text}\n${rest}`.trim();
  }
  if (lead.length && pageNo > 1 && !keyDoc) {
    const c: MockExtracted = {
      number: null,
      type: '',
      text: '',
      options: [],
      answer: null,
      figures: [],
      continued: true,
      confidence: 0.9,
    };
    for (const l of lead) {
      const rest = (() => {
        const parts = l.split(/\(([A-H])\)\s*/);
        for (let i = 1; i < parts.length; i += 2)
          c.options.push({ key: parts[i], text: parts[i + 1].trim() });
        return parts[0].trim();
      })();
      if (rest) c.text = `${c.text}\n${rest}`.trim();
    }
    questions.unshift(c);
  }
  for (const q of questions) {
    if (q.continued) continue;
    if (q.options.length >= 2)
      q.type =
        /,/.test(q.answer ?? '') || /which of (these|the following) are|select all|one or more/i.test(q.text)
          ? 'multiple'
          : 'single';
    else if (/true or false|true\/false/i.test(q.text)) q.type = 'true_false';
    else if (
      /^-?\d+(\.\d+)?$/.test(q.answer ?? '') ||
      /\b(find|calculate|compute|how many|value of)\b/i.test(q.text)
    )
      q.type = 'numerical';
    else q.type = 'descriptive';
  }
  return { questions, answerKey };
}
