/**
 * Turning AI output for question-paper pages into reviewable question drafts.
 *
 * The model only transcribes: it must not solve questions. Answers come from the paper itself
 * (inline "Ans:" lines or an answer key, possibly on another page or in a separate PDF) and are
 * mapped to questions by number. Anything missing or ambiguous is flagged for the teacher.
 */
import {
  QUESTION_TYPES,
  type AnswerKey,
  type QuestionImportFlag,
  type QuestionInput,
  type QuestionType,
} from '@erp/shared';
import { questionShapeError } from './schemas';
import type { Box } from './pdf-reader';

export const EXTRACTION_FEATURE = 'question-bank.pdf-import';

/** Marker the mock provider recognises; keep it in the system prompt. */
export const EXTRACTION_MARKER = 'QUESTION PAPER EXTRACTION';

export const EXTRACTION_SYSTEM = `${EXTRACTION_MARKER}
You transcribe ONE page of an existing exam question paper into JSON for a teacher's question bank.
Copy what is printed. Never solve questions, never invent questions, options or answers.

Return only JSON:
{"questions":[{"number":"5","type":"single|multiple|numerical|true_false|descriptive","text":"...",
"options":[{"key":"A","text":"..."}],"answer":"B" or null,"explanation":null,"figures":["F1"],
"diagramBox":[left,top,right,bottom] or null,"continued":false,"confidence":0.9}],
"answerKey":[{"number":"5","answer":"B","explanation":null}]}

Rules:
- "answer" is ONLY an answer printed on this page next to the question (e.g. "Ans: B"). Otherwise null.
- If the page contains an answer key / answers section, list every entry in "answerKey" (number + answer as printed).
- type: single = one correct option, multiple = more than one may be correct, numerical = numeric answer,
  true_false, descriptive = written answer. Option keys are letters A, B, C...
- Write equations as plain text with Unicode (x², √2, π, ≤, ∫, Δ, H₂O, a/b). If an equation, table or graph
  cannot be written as text, include its region in "diagramBox".
- The page text below may contain [FIGURE Fn] markers where pictures sit: put the ids of the pictures that
  belong to a question in its "figures". For drawn diagrams without a marker (or on scanned pages) give
  "diagramBox" as fractions 0-1 of the page width/height from the top-left corner.
- If the page starts with the remainder of a question from the previous page (no number), return it as one
  item with "continued": true containing only the remaining text/options.
- Skip headings, instructions, marks tables and page furniture.
- "confidence" 0-1: how sure you are the transcription is exact (lower for blurry or handwritten pages).`;

export function extractionUserPrompt(page: number, pageCount: number, text: string, kind: 'paper' | 'key') {
  return [
    kind === 'key'
      ? `This is page ${page} of ${pageCount} of a separate ANSWER KEY document. Return its entries in "answerKey".`
      : `Question paper page ${page} of ${pageCount}.`,
    'Page text (from the PDF text layer; empty or partial for scanned pages, use the image when given):',
    '<<<',
    text || '(no text layer)',
    '>>>',
  ].join('\n');
}

// ------------------------------------------------------------------ raw model output

export interface RawQuestion {
  number?: unknown;
  type?: unknown;
  text?: unknown;
  options?: unknown;
  answer?: unknown;
  explanation?: unknown;
  figures?: unknown;
  figure?: unknown;
  diagramBox?: unknown;
  continued?: unknown;
  confidence?: unknown;
}

export interface RawAnswer {
  number?: unknown;
  answer?: unknown;
  explanation?: unknown;
}

export interface ParsedPage {
  questions: RawQuestion[];
  answerKey: RawAnswer[];
}

export function parsePageOutput(parsed: unknown): ParsedPage {
  const o = (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>;
  const list = Array.isArray(parsed) ? parsed : Array.isArray(o.questions) ? o.questions : [];
  const key = Array.isArray(o.answerKey) ? o.answerKey : Array.isArray(o.answers) ? o.answers : [];
  return {
    questions: list.filter((q): q is RawQuestion => !!q && typeof q === 'object'),
    answerKey: key.filter((a): a is RawAnswer => !!a && typeof a === 'object'),
  };
}

// ------------------------------------------------------------------ drafts

/** Draft as stored on the import row while the teacher reviews it. */
export interface StoredDraft {
  id: string;
  number: string | null;
  page: number;
  question: QuestionInput;
  /** Whether the paper (inline or answer key) provided an answer. */
  answered: boolean;
  flags: QuestionImportFlag[];
  confidence: number | null;
  diagramFileIds: number[];
}

/** Draft while its page is being processed: diagrams are still page regions. */
export interface PendingDraft extends StoredDraft {
  figures: string[];
  diagramBox: Box | null;
}

const str = (v: unknown) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '').trim();
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s);

export function normaliseNumber(v: unknown): string | null {
  const s = str(v)
    .replace(/^(q(uestion)?\.?\s*(no\.?)?)\s*/i, '')
    .replace(/[.):\s]+$/, '');
  return s ? s.slice(0, 10) : null;
}

function normaliseBox(v: unknown): Box | null {
  if (!Array.isArray(v) || v.length !== 4 || !v.every((n) => typeof n === 'number' && isFinite(n)))
    return null;
  let [l, t, r, b] = (v as number[]).map((n) => (n > 1 && n <= 100 ? n / 100 : n));
  [l, r] = [Math.min(l, r), Math.max(l, r)];
  [t, b] = [Math.min(t, b), Math.max(t, b)];
  const box: Box = [l, t, r, b].map((n) => Math.min(1, Math.max(0, n))) as Box;
  return box[2] - box[0] > 0.01 && box[3] - box[1] > 0.01 ? box : null;
}

function normaliseOptions(v: unknown): { key: string; text: string }[] {
  if (!Array.isArray(v)) return [];
  const out: { key: string; text: string }[] = [];
  v.slice(0, 10).forEach((o, i) => {
    const key =
      (typeof o === 'object' && o ? str((o as { key?: unknown }).key) : '')
        .replace(/[^A-Za-z0-9]/g, '')
        .toUpperCase()
        .slice(0, 3) || String.fromCharCode(65 + i);
    const text = typeof o === 'object' && o ? str((o as { text?: unknown }).text) : str(o);
    out.push({ key, text: clip(text, 2000) });
  });
  return out;
}

/** Letters of correct options in an answer such as "B", "(a) and (c)", "A, C". */
function answerLetters(answer: string, keys: string[]): string[] | null {
  const cleaned = answer.toUpperCase().replace(/\b(AND|&|OR|OPTION|OPTIONS|ANS|ANSWER)\b/g, ' ');
  const tokens = cleaned.match(/\b[A-Z0-9]{1,3}\b/g) ?? [];
  if (!tokens.length || !tokens.every((t) => keys.includes(t))) return null;
  return [...new Set(tokens)].sort();
}

function parseNumber(s: string): number | null {
  const m = /^[-+]?\d+(?:\.\d+)?(?:e[-+]?\d+)?$/i.exec(s.replace(/,/g, '').trim());
  return m ? Number(m[0]) : null;
}

/** Applies an answer printed on the paper to the question; false when it cannot be understood. */
export function applyAnswer(q: QuestionInput, raw: unknown): boolean {
  if (raw === null || raw === undefined || raw === '') return false;
  if (typeof raw === 'boolean') {
    if (q.type !== 'true_false') return false;
    q.answerKey = { value: raw };
    return true;
  }
  const answer = clip(str(raw), 10000);
  if (!answer) return false;
  switch (q.type) {
    case 'single':
    case 'multiple': {
      const letters = answerLetters(
        answer,
        (q.options ?? []).map((o) => o.key),
      );
      if (!letters) return false;
      if (q.type === 'single' && letters.length > 1) q.type = 'multiple';
      q.answerKey = { options: letters };
      return true;
    }
    case 'true_false': {
      const v = answer.toLowerCase().replace(/[^a-z]/g, '');
      if (['true', 't', 'yes', 'correct'].includes(v)) q.answerKey = { value: true };
      else if (['false', 'f', 'no', 'incorrect', 'wrong'].includes(v)) q.answerKey = { value: false };
      else return false;
      return true;
    }
    case 'numerical': {
      const s = answer.replace(/\s*(units?|[a-zA-ZµΩ°/%]+\.?)$/u, '').trim();
      const pm = /^(.+?)\s*(?:±|\+\/-|\+-)\s*(.+)$/.exec(s);
      if (pm) {
        const value = parseNumber(pm[1]);
        const tolerance = parseNumber(pm[2]);
        if (value === null || tolerance === null) return false;
        q.answerKey = { value, tolerance: Math.abs(tolerance) };
        return true;
      }
      const range = /^(-?[\d.]+)\s*(?:to|–|-)\s*(-?[\d.]+)$/.exec(s);
      if (range) {
        const min = parseNumber(range[1]);
        const max = parseNumber(range[2]);
        if (min === null || max === null) return false;
        q.answerKey = { min: Math.min(min, max), max: Math.max(min, max) };
        return true;
      }
      const value = parseNumber(s);
      if (value === null) return false;
      q.answerKey = { value, tolerance: 0 };
      return true;
    }
    case 'descriptive':
      q.answerKey = { modelAnswer: answer };
      return true;
  }
}

function inferType(rawType: string, options: unknown[], answer: string, text: string): QuestionType {
  if ((QUESTION_TYPES as readonly string[]).includes(rawType)) return rawType as QuestionType;
  if (/^(true|false)$/i.test(answer) || /true or false|true\/false/i.test(text)) return 'true_false';
  if (options.length >= 2) return /,|\band\b/i.test(answer) ? 'multiple' : 'single';
  if (parseNumber(answer) !== null) return 'numerical';
  return 'descriptive';
}

/** One raw question from the model → a pending draft (answer applied when printed on the page). */
export function toPendingDraft(raw: RawQuestion, page: number, index: number): PendingDraft {
  const options = normaliseOptions(raw.options);
  const answerText = typeof raw.answer === 'boolean' ? String(raw.answer) : str(raw.answer);
  const text = clip(str(raw.text), 10000);
  let type = inferType(str(raw.type).toLowerCase(), options, answerText, text);
  if ((type === 'single' || type === 'multiple') && options.length < 2) type = 'descriptive';
  const question: QuestionInput = {
    type,
    text,
    options: type === 'single' || type === 'multiple' ? options : undefined,
    answerKey: {},
    explanation: str(raw.explanation) ? clip(str(raw.explanation), 10000) : null,
    source: 'import',
  };
  const answered = applyAnswer(question, raw.answer);
  const figures = [
    ...(Array.isArray(raw.figures) ? raw.figures.map(str) : []),
    ...(str(raw.figure) ? [str(raw.figure)] : []),
  ].filter((f) => /^F\d{1,3}$/i.test(f));
  const confidence =
    typeof raw.confidence === 'number' && isFinite(raw.confidence)
      ? Math.min(1, Math.max(0, raw.confidence))
      : null;
  return {
    id: `p${page}-${index + 1}`,
    number: normaliseNumber(raw.number),
    page,
    question,
    answered,
    flags: [],
    confidence,
    diagramFileIds: [],
    figures: [...new Set(figures.map((f) => f.toUpperCase()))],
    diagramBox: normaliseBox(raw.diagramBox),
  };
}

/** Appends a `continued` fragment to the last question of the previous page. */
export function mergeContinuation(target: StoredDraft, raw: RawQuestion): void {
  const extra = clip(str(raw.text), 10000);
  if (extra) target.question.text = clip(`${target.question.text}\n${extra}`.trim(), 10000);
  const options = normaliseOptions(raw.options);
  if (options.length) {
    const existing = target.question.options ?? [];
    const keys = new Set(existing.map((o) => o.key));
    target.question.options = [...existing, ...options.filter((o) => !keys.has(o.key))].slice(0, 10);
    if (target.question.type === 'descriptive' && target.question.options.length >= 2)
      target.question.type = 'single';
  }
  if (!target.answered) target.answered = applyAnswer(target.question, raw.answer);
  if (!target.flags.includes('spans_pages')) target.flags.push('spans_pages');
}

/**
 * Fills answers from answer-key entries by question number. A number printed more than once in the
 * paper (e.g. sections restarting at 1) is ambiguous and is left for the teacher.
 */
export function applyAnswerKey(drafts: StoredDraft[], entries: RawAnswer[]): void {
  const byNumber = new Map<string, StoredDraft[]>();
  for (const d of drafts) if (d.number) byNumber.set(d.number, [...(byNumber.get(d.number) ?? []), d]);
  for (const e of entries) {
    const n = normaliseNumber(e.number);
    const matches = n ? byNumber.get(n) : undefined;
    if (!matches || matches.length !== 1) continue;
    const d = matches[0];
    const before = JSON.stringify(d.question.answerKey);
    const probe: QuestionInput = { ...d.question, options: d.question.options, answerKey: {} };
    if (!applyAnswer(probe, e.answer)) continue;
    if (d.answered) {
      if (JSON.stringify(probe.answerKey) !== before && !d.flags.includes('answer_conflict'))
        d.flags.push('answer_conflict');
      continue;
    }
    d.question.type = probe.type;
    d.question.answerKey = probe.answerKey;
    d.answered = true;
    const explanation = str(e.explanation);
    if (explanation && !d.question.explanation) d.question.explanation = clip(explanation, 10000);
  }
}

/** Validation problem of a draft (null when it can be saved as-is). */
export function draftProblem(q: QuestionInput): string | null {
  if (!q.text.trim()) return 'The question text is empty';
  return questionShapeError(q);
}

/** Final flags once all pages and answer keys are processed. */
export function finaliseFlags(d: StoredDraft): void {
  const keep = d.flags.filter((f) => f === 'spans_pages' || f === 'answer_conflict');
  const flags = new Set<QuestionImportFlag>(keep);
  if (!d.answered) flags.add('answer_missing');
  const problem = draftProblem(d.question);
  if (problem && d.answered) flags.add('needs_fix');
  if (!d.question.text.trim()) flags.add('needs_fix');
  if (d.diagramFileIds.length) flags.add('has_diagram');
  if (d.confidence !== null && d.confidence < 0.6) flags.add('low_confidence');
  d.flags = [...flags];
}

export type { AnswerKey };
