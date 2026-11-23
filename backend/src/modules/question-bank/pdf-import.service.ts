/**
 * Question paper PDF import: upload → background extraction (text layer + vision model for scans,
 * diagrams and equations) → teacher reviews/edits drafts → only the selected drafts are saved.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Op } from 'sequelize';
import {
  QUESTION_PDF_IMPORT_LIMITS,
  type QuestionImportDto,
  type QuestionImportSaveItem,
  type QuestionImportSaveResult,
} from '@erp/shared';
import { TenantRepository } from '../../shared/tenancy/tenant-repository';
import { getContext, requireTenantContext, runWithContext } from '../../shared/context';
import { AppError, BadRequest, Conflict, Forbidden } from '../../shared/errors';
import { audit } from '../../shared/audit/audit.service';
import { logger } from '../../infrastructure/logger';
import { getStorage } from '../../infrastructure/storage';
import { getSequelize } from '../../infrastructure/database/sequelize';
import { enqueueJob } from '../../infrastructure/jobs/queue';
import type { Job } from '../../infrastructure/jobs/job.model';
import { deleteFile, fileRepo, saveUploadedFile, signedUrlFor } from '../files/files.service';
import { FileObject } from '../files/file.model';
import { aiChat, assertAiQuota, getAiAvailability } from '../ai/ai.service';
import type { ChatMessage } from '../../infrastructure/ai-providers/openai-compatible.client';
import { QuestionImport } from './models';
import { openPdf, type Box, type OpenedPdf, type PdfPageContent as PdfPageInfo } from './pdf-reader';
import {
  EXTRACTION_FEATURE,
  EXTRACTION_SYSTEM,
  applyAnswerKey,
  draftProblem,
  extractionUserPrompt,
  finaliseFlags,
  mergeContinuation,
  parsePageOutput,
  toPendingDraft,
  type PendingDraft,
  type RawAnswer,
  type StoredDraft,
} from './pdf-import.extract';
import {
  MODULE,
  assetRepo,
  buildQuestionValues,
  extractJson,
  findEditableBank,
  findVisibleBank,
  isManager,
  me,
  questionRepo,
} from './question-bank.service';
import { questionShapeError } from './schemas';

export const PDF_IMPORT_JOB = 'question-bank.pdf-import';
export const MAX_ANSWER_KEY_PAGES = 10;

const importRepo = new TenantRepository(QuestionImport, { entity: 'PDF import' });

export interface UploadedPdf {
  path: string;
  originalname: string;
  size: number;
  mimetype: string;
}

// ---------------------------------------------------------------- start

async function inspectPdf(file: UploadedPdf, maxPages: number, label: string): Promise<number> {
  if (file.size > QUESTION_PDF_IMPORT_LIMITS.maxMb * 1048576)
    throw new AppError(
      413,
      'PDF_TOO_LARGE',
      `${label} is larger than ${QUESTION_PDF_IMPORT_LIMITS.maxMb} MB`,
    );
  const pdf = await openPdf(await fs.promises.readFile(file.path));
  try {
    if (pdf.numPages > maxPages)
      throw new AppError(
        400,
        'PDF_TOO_MANY_PAGES',
        `${label} has ${pdf.numPages} pages; the limit is ${maxPages}. Split it and import the parts separately`,
      );
    return pdf.numPages;
  } finally {
    await pdf.close();
  }
}

export async function startPdfImport(
  bankId: number,
  files: { paper: UploadedPdf; answerKey?: UploadedPdf },
): Promise<QuestionImportDto> {
  const temps = [files.paper.path, files.answerKey?.path].filter(Boolean) as string[];
  try {
    const bank = await findEditableBank(bankId);
    const { instituteId } = requireTenantContext();
    const pageCount = await inspectPdf(
      files.paper,
      QUESTION_PDF_IMPORT_LIMITS.maxPages,
      'The question paper',
    );
    const keyPages = files.answerKey
      ? await inspectPdf(files.answerKey, MAX_ANSWER_KEY_PAGES, 'The answer key')
      : 0;
    const availability = await getAiAvailability(instituteId);
    if (availability.reason === 'AI_NOT_CONFIGURED')
      throw new AppError(503, 'AI_NOT_CONFIGURED', 'AI is not set up on this server');
    await assertAiQuota(instituteId);

    const save = (f: UploadedPdf) =>
      saveUploadedFile({
        tempPath: f.path,
        originalName: f.originalname,
        mimeType: 'application/pdf',
        sizeBytes: f.size,
        module: MODULE,
        branchId: bank.branchId,
      });
    const paper = await save(files.paper);
    const key = files.answerKey ? await save(files.answerKey) : null;
    const row = await getSequelize().transaction(async (transaction) => {
      const created = await importRepo.create(
        {
          branchId: bank.branchId,
          bankId: bank.id,
          createdByUserId: me(),
          status: 'queued',
          fileId: paper.id,
          answerKeyFileId: key?.id ?? null,
          fileName: files.paper.originalname.slice(0, 255),
          answerKeyFileName: files.answerKey?.originalname.slice(0, 255) ?? null,
          pageCount: pageCount + keyPages,
          drafts: [],
          warnings: [],
        },
        { transaction },
      );
      await enqueueJob(PDF_IMPORT_JOB, { importId: created.id }, { maxAttempts: 1, transaction });
      return created;
    });
    await audit({
      action: 'question.pdf_import_started',
      entityType: 'question_bank',
      entityId: bank.id,
      metadata: { importId: row.id, pages: pageCount, answerKeyPages: keyPages },
    });
    return toDto(row);
  } finally {
    await Promise.all(temps.map((p) => fs.promises.rm(p, { force: true })));
  }
}

// ---------------------------------------------------------------- read / list / discard

async function findOwnImport(id: number): Promise<QuestionImport> {
  const row = await importRepo.findById(id);
  if (!isManager() && row.createdByUserId !== me())
    throw Forbidden('Only the teacher who uploaded this paper can open it');
  await findVisibleBank(row.bankId);
  return row;
}

export async function getPdfImport(id: number): Promise<QuestionImportDto> {
  return toDto(await findOwnImport(id));
}

/** Imports of a bank that are still open (processing or waiting for review). */
export async function listPdfImports(bankId: number): Promise<QuestionImportDto[]> {
  await findVisibleBank(bankId);
  const rows = await importRepo.findAll({
    where: {
      bankId,
      status: { [Op.in]: ['queued', 'processing', 'ready', 'failed'] },
      ...(isManager() ? {} : { createdByUserId: me() }),
    },
    order: [['id', 'DESC']],
    limit: 20,
  });
  return Promise.all(rows.map((r) => toDto(r, { withDrafts: false })));
}

async function removeFiles(ids: (number | null | undefined)[]) {
  for (const id of ids) {
    if (!id) continue;
    try {
      await deleteFile(id);
    } catch (err) {
      logger.warn({ err, fileId: id }, 'Could not delete PDF import file');
    }
  }
}

const allDiagramIds = (drafts: StoredDraft[] | null) => (drafts ?? []).flatMap((d) => d.diagramFileIds);

export async function discardPdfImport(id: number): Promise<void> {
  const row = await findOwnImport(id);
  if (row.status === 'saved' || row.status === 'discarded') return;
  if (row.status === 'processing' || row.status === 'queued')
    throw Conflict('This paper is still being read. Wait for it to finish', 'IMPORT_IN_PROGRESS');
  const files = [row.fileId, row.answerKeyFileId, ...allDiagramIds(row.drafts)];
  await row.update({ status: 'discarded', fileId: null, answerKeyFileId: null, drafts: [] });
  await removeFiles(files);
  await audit({ action: 'question.pdf_import_discarded', entityType: 'question_bank', entityId: row.bankId });
}

// ---------------------------------------------------------------- save

export async function savePdfImport(
  id: number,
  items: QuestionImportSaveItem[],
): Promise<QuestionImportSaveResult> {
  const row = await findOwnImport(id);
  if (row.status !== 'ready') throw Conflict('This import is not waiting for review', 'IMPORT_NOT_READY');
  const bank = await findEditableBank(row.bankId);
  const drafts = new Map((row.drafts ?? []).map((d) => [d.id, d]));
  const seen = new Set<string>();
  for (const [i, item] of items.entries()) {
    const draft = drafts.get(item.draftId);
    if (!draft || seen.has(item.draftId)) throw BadRequest(`Question ${i + 1} is not part of this import`);
    seen.add(item.draftId);
    const err = questionShapeError(item.question);
    if (err) throw BadRequest(`Question ${draft.number ?? i + 1}: ${err}`);
    if ((item.diagramFileIds ?? []).some((f) => !draft.diagramFileIds.includes(f)))
      throw BadRequest(`Question ${draft.number ?? i + 1}: unknown diagram`);
  }

  const sourceFiles = [row.fileId, row.answerKeyFileId];
  const questionIds: number[] = [];
  const kept = new Set<number>();
  await getSequelize().transaction(async (transaction) => {
    for (const item of items) {
      const draft = drafts.get(item.draftId)!;
      const q = await questionRepo.create(
        {
          bankId: bank.id,
          ...(await buildQuestionValues(item.question, bank)),
          source: 'import',
          createdByUserId: me(),
        },
        { transaction },
      );
      questionIds.push(q.id);
      const diagrams = item.diagramFileIds ?? draft.diagramFileIds;
      for (const [sortOrder, fileId] of diagrams.entries()) {
        kept.add(fileId);
        await assetRepo.create({ questionId: q.id, fileId, role: 'question', sortOrder }, { transaction });
      }
    }
    await row.update(
      { status: 'saved', savedCount: items.length, fileId: null, answerKeyFileId: null, drafts: [] },
      { transaction },
    );
  });
  await removeFiles([
    ...sourceFiles,
    ...[...drafts.values()].flatMap((d) => d.diagramFileIds).filter((f) => !kept.has(f)),
  ]);
  await audit({
    action: 'question.pdf_imported',
    entityType: 'question_bank',
    entityId: bank.id,
    metadata: { importId: row.id, created: questionIds.length, drafts: drafts.size, file: row.fileName },
  });
  return { created: questionIds.length, questionIds };
}

// ---------------------------------------------------------------- dto

async function toDto(row: QuestionImport, opts: { withDrafts?: boolean } = {}): Promise<QuestionImportDto> {
  const drafts = opts.withDrafts === false ? [] : (row.drafts ?? []);
  const fileIds = [...new Set([row.fileId, ...allDiagramIds(drafts)].filter((f): f is number => !!f))];
  const files = fileIds.length ? await fileRepo.findAll({ where: { id: fileIds } }) : [];
  const urls = new Map(files.map((f: FileObject) => [f.id, signedUrlFor(f).url]));
  return {
    id: row.id,
    bankId: row.bankId,
    status: row.status,
    fileName: row.fileName,
    answerKeyFileName: row.answerKeyFileName,
    fileUrl: row.fileId ? (urls.get(row.fileId) ?? null) : null,
    pageCount: row.pageCount,
    pagesDone: row.pagesDone,
    drafts: drafts.map((d) => ({
      id: d.id,
      number: d.number,
      page: d.page,
      question: d.question,
      flags: d.flags,
      problem: draftProblem(d.question),
      confidence: d.confidence,
      diagrams: d.diagramFileIds
        .filter((f) => urls.has(f))
        .map((fileId) => ({ fileId, url: urls.get(fileId)! })),
    })),
    warnings: row.warnings ?? [],
    error: row.error,
    model: row.model,
    visionPages: row.visionPages,
    savedCount: row.savedCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// ---------------------------------------------------------------- background extraction

/** Pages whose text layer alone is not enough: scans, pictures, drawn diagrams, heavy maths, little text. */
export function needsVision(p: PdfPageInfo): boolean {
  return p.scanned || p.figures.length > 0 || p.vectorDrawing || p.mathSymbols >= 5 || p.charCount < 200;
}

async function readStoredFile(fileId: number): Promise<Buffer> {
  const file = await fileRepo.findById(fileId);
  const chunks: Buffer[] = [];
  for await (const c of await getStorage().getStream(file.storageKey)) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

async function saveCrop(png: Buffer, name: string, branchId: number | null): Promise<number> {
  const tmp = path.join(os.tmpdir(), `qb-crop-${crypto.randomUUID()}.png`);
  await fs.promises.writeFile(tmp, png);
  const file = await saveUploadedFile({
    tempPath: tmp,
    originalName: name,
    mimeType: 'image/png',
    sizeBytes: png.length,
    module: MODULE,
    branchId,
  });
  return file.id;
}

/** Errors that make every further AI call fail too (quota, plan, provider not configured). */
const isFatalAiError = (err: unknown) =>
  err instanceof AppError && [429, 403, 503].includes(err.status) && err.code !== 'AI_PROVIDER_ERROR';

interface PageResult {
  questions: PendingDraft[];
  continuations: ReturnType<typeof parsePageOutput>['questions'];
  answerKey: RawAnswer[];
  tokens: number;
  model: string;
  vision: boolean;
}

async function extractPage(
  pdf: OpenedPdf,
  n: number,
  kind: 'paper' | 'key',
  info: PdfPageInfo,
): Promise<PageResult> {
  const vision = needsVision(info);
  const prompt = extractionUserPrompt(n, pdf.numPages, info.text, kind);
  const content: ChatMessage['content'] = vision
    ? [
        { type: 'text', text: prompt },
        {
          type: 'image_url',
          image_url: { url: `data:image/jpeg;base64,${(await pdf.renderJpeg(n)).toString('base64')}` },
        },
      ]
    : prompt;
  const res = await aiChat({
    feature: EXTRACTION_FEATURE,
    jsonMode: true,
    temperature: 0,
    messages: [
      { role: 'system', content: EXTRACTION_SYSTEM },
      { role: 'user', content },
    ],
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJson(res.content));
  } catch {
    throw new AppError(502, 'AI_BAD_OUTPUT', 'the AI response was not valid JSON');
  }
  const out = parsePageOutput(parsed);
  const questions: PendingDraft[] = [];
  const continuations: PageResult['continuations'] = [];
  if (kind === 'paper')
    out.questions.forEach((raw, i) => {
      if (raw.continued === true && i === 0) continuations.push(raw);
      else questions.push(toPendingDraft(raw, n, i));
    });
  return {
    questions,
    continuations,
    answerKey: out.answerKey,
    tokens: res.usage.totalTokens,
    model: res.model,
    vision,
  };
}

async function attachDiagrams(
  pdf: OpenedPdf,
  info: PdfPageInfo,
  drafts: PendingDraft[],
  branchId: number | null,
  warnings: string[],
) {
  for (const d of drafts) {
    const boxes: Box[] = [];
    for (const f of d.figures) {
      const fig = info.figures.find((x) => x.id === f);
      if (fig) boxes.push(fig.box);
    }
    if (d.diagramBox && !boxes.length) boxes.push(d.diagramBox);
    for (const [i, box] of boxes.slice(0, 4).entries()) {
      try {
        const png = await pdf.crop(info.number, box);
        d.diagramFileIds.push(
          await saveCrop(png, `page${info.number}-q${d.number ?? d.id}-${i + 1}.png`, branchId),
        );
      } catch (err) {
        warnings.push(`Could not cut out the diagram of question ${d.number ?? d.id} (page ${info.number})`);
        logger.warn({ err }, 'PDF import diagram crop failed');
      }
    }
  }
}

const stored = (d: PendingDraft): StoredDraft => ({
  id: d.id,
  number: d.number,
  page: d.page,
  question: d.question,
  answered: d.answered,
  flags: d.flags,
  confidence: d.confidence,
  diagramFileIds: d.diagramFileIds,
});

export async function runPdfImportJob(payload: { importId: number }): Promise<void> {
  const row = await importRepo.findOne({ where: { id: payload.importId } });
  if (!row || row.status !== 'queued') return;
  // AI usage and crop files are attributed to the uploader.
  await runWithContext({ ...getContext(), userId: row.createdByUserId ?? undefined }, () =>
    processImport(row),
  );
}

async function processImport(row: QuestionImport): Promise<void> {
  await row.update({ status: 'processing', pagesDone: 0, error: null });
  const drafts: StoredDraft[] = [];
  const keyEntries: RawAnswer[] = [];
  const warnings: string[] = [];
  let tokens = 0;
  let visionPages = 0;
  let model: string | null = null;
  let pagesDone = 0;
  let failedPages = 0;
  let stopped: string | null = null;
  // JSON columns are compared by value with the last saved copy, so never hand Sequelize live objects.
  const snapshot = () => ({ drafts: structuredClone(drafts), warnings: [...warnings] });

  const runDoc = async (fileId: number, kind: 'paper' | 'key') => {
    const pdf = await openPdf(await readStoredFile(fileId));
    try {
      for (let n = 1; n <= pdf.numPages && !stopped; n++) {
        const label = kind === 'key' ? `Answer key page ${n}` : `Page ${n}`;
        try {
          const info = await pdf.page(n);
          const res = await extractPage(pdf, n, kind, info);
          tokens += res.tokens;
          model = res.model;
          if (res.vision) visionPages++;
          keyEntries.push(...res.answerKey);
          const prev = drafts[drafts.length - 1];
          for (const c of res.continuations) {
            if (prev) mergeContinuation(prev, c);
            else res.questions.unshift(toPendingDraft({ ...c, continued: false }, n, res.questions.length));
          }
          await attachDiagrams(pdf, info, res.questions, row.branchId, warnings);
          const room = QUESTION_PDF_IMPORT_LIMITS.maxDrafts - drafts.length;
          if (res.questions.length > room)
            warnings.push(`Only the first ${QUESTION_PDF_IMPORT_LIMITS.maxDrafts} questions were kept`);
          drafts.push(...res.questions.slice(0, Math.max(0, room)).map(stored));
          if (kind === 'paper' && !res.questions.length && !res.continuations.length && !res.answerKey.length)
            warnings.push(
              info.charCount
                ? `${label}: no questions found`
                : `${label}: no questions found (scanned page; check it was read correctly)`,
            );
        } catch (err) {
          if (isFatalAiError(err)) {
            stopped = (err as AppError).message;
            warnings.push(`${label} and later pages were not read: ${stopped}`);
            break;
          }
          failedPages++;
          warnings.push(
            `${label} could not be read: ${err instanceof AppError ? err.message : 'unexpected error'}`,
          );
          logger.warn({ err, importId: row.id, page: n }, 'PDF import page failed');
        }
        pagesDone++;
        await row.update({ pagesDone, ...snapshot(), totalTokens: tokens, visionPages, model });
      }
    } finally {
      await pdf.close();
    }
  };

  if (row.fileId) await runDoc(row.fileId, 'paper');
  if (row.answerKeyFileId && !stopped) await runDoc(row.answerKeyFileId, 'key');

  applyAnswerKey(drafts, keyEntries);
  drafts.forEach(finaliseFlags);
  const nothingRead = drafts.length === 0 && (stopped !== null || failedPages >= pagesDone);
  await row.update({
    status: nothingRead ? 'failed' : 'ready',
    error: nothingRead ? (stopped ?? 'No page of the PDF could be read') : null,
    ...snapshot(),
    pagesDone,
    totalTokens: tokens,
    visionPages,
    model,
  });
}

export async function failPdfImportJob(job: Job, error: string): Promise<void> {
  const importId = Number((job.payload as { importId?: unknown }).importId);
  if (!importId) return;
  const row = await importRepo.findOne({ where: { id: importId } });
  if (!row || !['queued', 'processing'].includes(row.status)) return;
  await row.update({ status: 'failed', error: `Reading the PDF failed: ${error}`.slice(0, 500) });
}
