import { Op, UniqueConstraintError } from 'sequelize';
import type {
  AnswerPageDto,
  AnswerResponse,
  AttemptSessionDto,
  DeliveredQuestion,
  SaveAnswerInput,
  SaveAnswerResult,
  StudentExamListItem,
} from '@erp/shared';
import { TenantRepository } from '../../shared/tenancy/tenant-repository';
import { requireTenantContext } from '../../shared/context';
import { BadRequest, Conflict, NotFound } from '../../shared/errors';
import { audit } from '../../shared/audit/audit.service';
import { enqueueJob } from '../../infrastructure/jobs/queue';
import { getStorage } from '../../infrastructure/storage';
import { logger } from '../../infrastructure/logger';
import { FileObject } from '../files/file.model';
import { saveUploadedFile, signedUrlFor } from '../files/files.service';
import {
  ExamAnswer,
  ExamAnswerPage,
  ExamAttempt,
  ExamEvaluation,
  ExamQuestion,
  ExamResultCorrection,
  type Exam,
} from './models';
import {
  attemptRepo,
  examDto,
  examQuestionRepo,
  examTenantRepo,
  examsForStudent,
  isEligible,
  me,
  sectionDto,
  sectionRepo,
} from './exams.service';
import { isAnswered, round2, scoreObjective, shuffle } from './scoring';

export const AUTO_SUBMIT_JOB = 'exams.auto-submit';
/** Network slack for saves that were sent just before the deadline. */
const GRACE_MS = 15_000;
const MAX_PAGES = 20;

export const answerRepo = new TenantRepository(ExamAnswer, { entity: 'Answer' });
export const pageRepo = new TenantRepository(ExamAnswerPage, { entity: 'Answer page' });
export const evaluationRepo = new TenantRepository(ExamEvaluation, { entity: 'Evaluation' });
export const correctionRepo = new TenantRepository(ExamResultCorrection, { entity: 'Correction' });

export const instituteFiles = (ids: number[]) =>
  ids.length
    ? FileObject.findAll({ where: { instituteId: requireTenantContext().instituteId, id: ids } })
    : Promise.resolve([]);

// ---------------------------------------------------------------- student exam list

export async function listMyExams(): Promise<StudentExamListItem[]> {
  const userId = me();
  const exams = await examsForStudent(userId, { status: 'scheduled' });
  const attempts = exams.length
    ? await attemptRepo.findAll({ where: { studentUserId: userId, examId: exams.map((e) => e.id) } })
    : [];
  const byExam = new Map(attempts.map((a) => [a.examId, a]));
  const now = new Date();
  const items: StudentExamListItem[] = [];
  for (const e of exams) {
    let a = byExam.get(e.id) ?? null;
    if (a) a = await closeIfExpired(a, e);
    items.push({
      exam: examDto(e),
      attempt: a ? { id: a.id, status: a.status, submittedAt: a.submittedAt?.toISOString() ?? null } : null,
      canStart: now >= e.startAt && now < e.endAt && (!a || a.status === 'in_progress'),
    });
  }
  return items;
}

// ---------------------------------------------------------------- start / resume

async function orderedExamQuestions(examId: number) {
  const sections = await sectionRepo.findAll({
    where: { examId },
    order: [
      ['sortOrder', 'ASC'],
      ['id', 'ASC'],
    ],
  });
  const eqs = await examQuestionRepo.findAll({
    where: { examId },
    order: [
      ['sortOrder', 'ASC'],
      ['id', 'ASC'],
    ],
  });
  return { sections, eqs };
}

export async function startAttempt(examId: number): Promise<AttemptSessionDto> {
  const userId = me();
  const exam = await examTenantRepo.findById(examId);
  if (!(await isEligible(exam, userId))) throw NotFound('Exam');
  const existing = await attemptRepo.findOne({ where: { examId, studentUserId: userId } });
  if (existing) {
    const a = await closeIfExpired(existing, exam);
    if (a.status !== 'in_progress') throw Conflict('You have already submitted this exam', 'ATTEMPT_CLOSED');
    return sessionDto(a, exam);
  }
  const now = new Date();
  if (exam.status !== 'scheduled') throw Conflict('This exam is not open', 'EXAM_NOT_OPEN');
  if (now < exam.startAt) throw Conflict('The exam has not started yet', 'EXAM_NOT_OPEN');
  if (now >= exam.endAt) throw Conflict('The exam window has closed', 'EXAM_CLOSED');

  const { sections, eqs } = await orderedExamQuestions(examId);
  const order: number[] = [];
  for (const s of sections) {
    const inSection = eqs.filter((q) => q.sectionId === s.id).map((q) => q.id);
    order.push(...(exam.shuffleQuestions ? shuffle(inSection) : inSection));
  }
  const optionOrders: Record<string, string[]> = {};
  if (exam.shuffleOptions)
    for (const q of eqs)
      if (q.snapshot.type === 'single' || q.snapshot.type === 'multiple')
        optionOrders[q.id] = shuffle(q.snapshot.options.map((o) => o.key));

  const deadlineAt = new Date(Math.min(now.getTime() + exam.durationMinutes * 60000, exam.endAt.getTime()));
  let attempt: ExamAttempt;
  try {
    attempt = await attemptRepo.create({
      branchId: exam.branchId,
      examId,
      studentUserId: userId,
      startedAt: now,
      deadlineAt,
      submittedAt: null,
      lastSeenAt: now,
      questionOrder: order,
      optionOrders: exam.shuffleOptions ? optionOrders : null,
      maxScore: round2(eqs.reduce((s, q) => s + q.marks, 0)),
      rank: null,
      percentile: null,
    });
  } catch (err) {
    // Double-click / two devices: return the attempt that won the race.
    if (err instanceof UniqueConstraintError) {
      const a = await attemptRepo.findOne({ where: { examId, studentUserId: userId } });
      if (a) return sessionDto(a, exam);
    }
    throw err;
  }
  await enqueueJob(
    AUTO_SUBMIT_JOB,
    { attemptId: attempt.id },
    { runAt: new Date(deadlineAt.getTime() + GRACE_MS) },
  );
  await audit({
    action: 'exam.attempt_started',
    entityType: 'exam_attempt',
    entityId: attempt.id,
    metadata: { examId },
  });
  return sessionDto(attempt, exam);
}

async function ownAttempt(attemptId: number): Promise<ExamAttempt> {
  const a = await attemptRepo.findOne({ where: { id: attemptId, studentUserId: me() } });
  if (!a) throw NotFound('Attempt');
  return a;
}

export async function resumeAttempt(attemptId: number): Promise<AttemptSessionDto> {
  let a = await ownAttempt(attemptId);
  const exam = await examTenantRepo.findById(a.examId);
  a = await closeIfExpired(a, exam);
  if (a.status !== 'in_progress') throw Conflict('This attempt has been submitted', 'ATTEMPT_CLOSED');
  await a.update({ lastSeenAt: new Date() });
  return sessionDto(a, exam);
}

export function pageDto(p: ExamAnswerPage): AnswerPageDto {
  return { id: p.id, fileId: p.fileId, pageNo: p.pageNo, url: p.file ? signedUrlFor(p.file).url : '' };
}

async function sessionDto(a: ExamAttempt, exam: Exam): Promise<AttemptSessionDto> {
  const { sections, eqs } = await orderedExamQuestions(exam.id);
  const byId = new Map(eqs.map((q) => [q.id, q]));
  const fileIds = eqs.flatMap((q) => [
    ...q.snapshot.assetFileIds,
    ...(q.snapshot.options.map((o) => o.imageFileId).filter(Boolean) as number[]),
  ]);
  const files = new Map((await instituteFiles([...new Set(fileIds)])).map((f) => [f.id, f]));
  const url = (id: number) => (files.get(id) ? signedUrlFor(files.get(id)!).url : null);
  const questions: DeliveredQuestion[] = a.questionOrder
    .map((id) => byId.get(id))
    .filter((q): q is ExamQuestion => !!q)
    .map((q) => {
      const order = a.optionOrders?.[q.id];
      const opts = order
        ? order.map((k) => q.snapshot.options.find((o) => o.key === k)!).filter(Boolean)
        : q.snapshot.options;
      return {
        examQuestionId: q.id,
        sectionId: q.sectionId,
        type: q.snapshot.type,
        text: q.snapshot.text,
        options: opts.map((o) => ({
          key: o.key,
          text: o.text,
          imageUrl: o.imageFileId ? url(o.imageFileId) : null,
        })),
        assets: q.snapshot.assetFileIds.map((id) => ({ id, url: url(id) ?? '' })),
        marks: q.marks,
        negativeMarks: q.negativeMarks,
      };
    });
  const answers = await answerRepo.findAll({
    where: { attemptId: a.id },
    include: [{ model: ExamAnswerPage, as: 'pages', include: [{ model: FileObject, as: 'file' }] }],
  });
  return {
    attemptId: a.id,
    examId: exam.id,
    title: exam.title,
    instructions: exam.instructions,
    status: a.status,
    startedAt: a.startedAt.toISOString(),
    deadlineAt: a.deadlineAt.toISOString(),
    serverNow: new Date().toISOString(),
    sections: sections.map((s) => sectionDto(s, eqs.filter((q) => q.sectionId === s.id).length)),
    questions,
    answers: answers.map((ans) => ({
      examQuestionId: ans.examQuestionId,
      response: ans.response,
      markedForReview: ans.markedForReview,
      visited: ans.visited,
      timeSpentSeconds: ans.timeSpentSeconds,
      pages: [...(ans.pages ?? [])].sort((x, y) => x.pageNo - y.pageNo).map(pageDto),
    })),
  };
}

// ---------------------------------------------------------------- autosave

function validateResponse(eq: ExamQuestion, r: AnswerResponse | null | undefined): AnswerResponse | null {
  if (r == null) return null;
  const t = eq.snapshot.type;
  if (t === 'single' || t === 'multiple') {
    const keys = new Set(eq.snapshot.options.map((o) => o.key));
    const chosen = [...new Set((r.options ?? []).map((k) => k.toUpperCase()))];
    if (chosen.some((k) => !keys.has(k))) throw BadRequest('Unknown option');
    if (t === 'single' && chosen.length > 1) throw BadRequest('Choose only one option');
    return { options: chosen };
  }
  if (t === 'numerical') {
    if (r.value != null && (typeof r.value !== 'number' || !Number.isFinite(r.value)))
      throw BadRequest('Enter a number');
    return { value: r.value ?? null };
  }
  if (t === 'true_false') {
    if (r.value != null && typeof r.value !== 'boolean') throw BadRequest('Choose true or false');
    return { value: r.value ?? null };
  }
  return { text: (r.text ?? '').slice(0, 20000) };
}

/** Loads an in-progress attempt of the current student, closing it if the deadline has passed. */
async function writableAttempt(attemptId: number): Promise<{ attempt: ExamAttempt; exam: Exam }> {
  const attempt = await ownAttempt(attemptId);
  const exam = await examTenantRepo.findById(attempt.examId);
  if (attempt.status !== 'in_progress') throw Conflict('This attempt has been submitted', 'ATTEMPT_CLOSED');
  if (Date.now() > attempt.deadlineAt.getTime() + GRACE_MS || exam.status === 'cancelled') {
    await closeIfExpired(attempt, exam, true);
    throw Conflict('Time is up; your answers were submitted automatically', 'ATTEMPT_CLOSED');
  }
  return { attempt, exam };
}

async function examQuestionOf(attempt: ExamAttempt, examQuestionId: number) {
  const eq = await examQuestionRepo.findOne({ where: { id: examQuestionId, examId: attempt.examId } });
  if (!eq) throw NotFound('Question');
  return eq;
}

async function upsertAnswer(attemptId: number, examQuestionId: number) {
  const found = await answerRepo.findOne({ where: { attemptId, examQuestionId } });
  if (found) return found;
  try {
    return await answerRepo.create({
      attemptId,
      examQuestionId,
      response: null,
      autoScore: null,
      isCorrect: null,
      savedAt: null,
    });
  } catch (err) {
    if (err instanceof UniqueConstraintError)
      return (await answerRepo.findOne({ where: { attemptId, examQuestionId } }))!;
    throw err;
  }
}

export async function saveAnswer(
  attemptId: number,
  examQuestionId: number,
  input: SaveAnswerInput,
): Promise<SaveAnswerResult> {
  const { attempt } = await writableAttempt(attemptId);
  const eq = await examQuestionOf(attempt, examQuestionId);
  const answer = await upsertAnswer(attempt.id, eq.id);
  const now = new Date();
  const changes: Partial<ExamAnswer> = { savedAt: now };
  if (input.response !== undefined) changes.response = validateResponse(eq, input.response);
  if (input.markedForReview !== undefined) changes.markedForReview = input.markedForReview;
  if (input.visited !== undefined) changes.visited = input.visited;
  if (input.timeSpentSeconds !== undefined)
    changes.timeSpentSeconds = Math.max(answer.timeSpentSeconds, input.timeSpentSeconds);
  await answer.update(changes);
  await attempt.update({ lastSeenAt: now });
  return {
    savedAt: now.toISOString(),
    deadlineAt: attempt.deadlineAt.toISOString(),
    serverNow: now.toISOString(),
  };
}

// ---------------------------------------------------------------- handwritten pages

async function descriptiveAnswer(attemptId: number, examQuestionId: number) {
  const { attempt } = await writableAttempt(attemptId);
  const eq = await examQuestionOf(attempt, examQuestionId);
  if (eq.snapshot.type !== 'descriptive')
    throw BadRequest('Pages can only be attached to descriptive answers');
  return { attempt, answer: await upsertAnswer(attempt.id, eq.id) };
}

async function listPages(answerId: number) {
  const pages = await pageRepo.findAll({
    where: { answerId },
    include: [{ model: FileObject, as: 'file' }],
    order: [
      ['pageNo', 'ASC'],
      ['id', 'ASC'],
    ],
  });
  return pages.map(pageDto);
}

export async function addPage(
  attemptId: number,
  examQuestionId: number,
  file: Express.Multer.File,
): Promise<AnswerPageDto[]> {
  const { attempt, answer } = await descriptiveAnswer(attemptId, examQuestionId);
  if (!/^image\/|^application\/pdf$/.test(file.mimetype))
    throw BadRequest('Upload a photo (image) or PDF of the page');
  const count = await pageRepo.count({ answerId: answer.id });
  if (count >= MAX_PAGES) throw BadRequest(`At most ${MAX_PAGES} pages per answer`);
  const saved = await saveUploadedFile({
    tempPath: file.path,
    originalName: file.originalname,
    mimeType: file.mimetype,
    sizeBytes: file.size,
    module: 'exams',
    branchId: attempt.branchId,
  });
  await pageRepo.create({ answerId: answer.id, fileId: saved.id, pageNo: count + 1 });
  await answer.update({ savedAt: new Date() });
  return listPages(answer.id);
}

export async function reorderPages(
  attemptId: number,
  examQuestionId: number,
  pageIds: number[],
): Promise<AnswerPageDto[]> {
  const { answer } = await descriptiveAnswer(attemptId, examQuestionId);
  const pages = await pageRepo.findAll({ where: { answerId: answer.id } });
  if (pages.length !== pageIds.length || pages.some((p) => !pageIds.includes(p.id)))
    throw BadRequest('Send every page id of this answer exactly once');
  for (const p of pages) await p.update({ pageNo: pageIds.indexOf(p.id) + 1 });
  return listPages(answer.id);
}

export async function deletePage(
  attemptId: number,
  examQuestionId: number,
  pageId: number,
): Promise<AnswerPageDto[]> {
  const { answer } = await descriptiveAnswer(attemptId, examQuestionId);
  const page = await pageRepo.findOne({
    where: { id: pageId, answerId: answer.id },
    include: [{ model: FileObject, as: 'file' }],
  });
  if (!page) throw NotFound('Page');
  await page.destroy();
  if (page.file) {
    await page.file.destroy();
    await getStorage()
      .delete(page.file.storageKey)
      .catch((err) => logger.warn({ err }, 'page file delete failed'));
  }
  const rest = await pageRepo.findAll({ where: { answerId: answer.id }, order: [['pageNo', 'ASC']] });
  for (const [i, p] of rest.entries()) if (p.pageNo !== i + 1) await p.update({ pageNo: i + 1 });
  return listPages(answer.id);
}

// ---------------------------------------------------------------- submit & scoring

export async function submitAttempt(attemptId: number) {
  const attempt = await ownAttempt(attemptId);
  if (attempt.status !== 'in_progress')
    throw Conflict('This attempt has already been submitted', 'ATTEMPT_CLOSED');
  const exam = await examTenantRepo.findById(attempt.examId);
  const late = Date.now() > attempt.deadlineAt.getTime() + GRACE_MS;
  await finalizeAttempt(attempt, exam, late ? 'auto_submitted' : 'submitted');
  const done = await attemptRepo.findById(attempt.id);
  return { id: done.id, status: done.status, submittedAt: done.submittedAt!.toISOString() };
}

/** Lazily closes an attempt whose deadline has passed (or when forced). */
export async function closeIfExpired(a: ExamAttempt, exam: Exam, force = false): Promise<ExamAttempt> {
  if (a.status !== 'in_progress') return a;
  if (!force && Date.now() <= a.deadlineAt.getTime() + GRACE_MS && exam.status !== 'cancelled') return a;
  await finalizeAttempt(a, exam, 'auto_submitted');
  return attemptRepo.findById(a.id);
}

export async function runAutoSubmit(payload: { attemptId: number }) {
  const a = await attemptRepo.findOne({ where: { id: payload.attemptId } });
  if (!a || a.status !== 'in_progress') return;
  const exam = await examTenantRepo.findById(a.examId);
  if (Date.now() < a.deadlineAt.getTime()) {
    // Deadline was extended (window end moved); re-check later.
    await enqueueJob(
      AUTO_SUBMIT_JOB,
      { attemptId: a.id },
      { runAt: new Date(a.deadlineAt.getTime() + GRACE_MS) },
    );
    return;
  }
  await finalizeAttempt(a, exam, 'auto_submitted');
}

/** Hook for AI grading (set by grading.service to avoid an import cycle). */
let onAttemptFinalized: ((exam: Exam, answerIds: number[]) => Promise<void>) | null = null;
export function setOnAttemptFinalized(fn: typeof onAttemptFinalized) {
  onAttemptFinalized = fn;
}

/**
 * Freezes the attempt, auto-scores objective answers and queues descriptive answers for evaluation.
 * Idempotent: only the caller that flips `in_progress` → submitted does the work.
 */
export async function finalizeAttempt(a: ExamAttempt, exam: Exam, status: 'submitted' | 'auto_submitted') {
  const submittedAt = new Date();
  const [flipped] = await ExamAttempt.update(
    { status, submittedAt },
    { where: { id: a.id, instituteId: a.instituteId, status: 'in_progress' } },
  );
  if (!flipped) return;
  const eqs = await examQuestionRepo.findAll({ where: { examId: a.examId } });
  const answers = await answerRepo.findAll({
    where: { attemptId: a.id },
    include: [{ model: ExamAnswerPage, as: 'pages' }],
  });
  const byEq = new Map(answers.map((x) => [x.examQuestionId, x]));
  const toGrade: number[] = [];
  for (const eq of eqs) {
    const ans = byEq.get(eq.id);
    if (eq.snapshot.type === 'descriptive') {
      if (!ans) continue;
      const hasContent = isAnswered(eq.snapshot, ans.response) || (ans.pages?.length ?? 0) > 0;
      if (!hasContent) {
        await ans.update({ autoScore: 0, isCorrect: null });
        continue;
      }
      const [ev] = await ExamEvaluation.findOrCreate({
        where: { instituteId: a.instituteId, answerId: ans.id },
        defaults: {
          instituteId: a.instituteId,
          answerId: ans.id,
          aiResultId: null,
          aiMarks: null,
          aiFeedback: null,
          teacherMarks: null,
          teacherFeedback: null,
          evaluatedByUserId: null,
          evaluatedAt: null,
          finalMarks: null,
        },
      });
      toGrade.push(ev.answerId);
      continue;
    }
    const result = scoreObjective(eq.snapshot, eq, ans?.response)!;
    if (ans) await ans.update({ autoScore: result.score, isCorrect: result.isCorrect });
  }
  await recomputeAttempt(a.id);
  await audit({
    action: `exam.attempt_${status}`,
    entityType: 'exam_attempt',
    entityId: a.id,
    metadata: { examId: a.examId },
  });
  if (toGrade.length && exam.evaluationMode !== 'manual' && onAttemptFinalized) {
    await onAttemptFinalized(exam, toGrade).catch((err) =>
      logger.warn({ err, attemptId: a.id }, 'Could not queue AI grading; answers stay pending'),
    );
  }
}

/** Effective marks of each answer: latest correction › evaluation final marks › auto score. */
export async function effectiveMarks(answerIds: number[]): Promise<Map<number, number | null>> {
  const out = new Map<number, number | null>();
  if (!answerIds.length) return out;
  const answers = await answerRepo.findAll({
    where: { id: answerIds },
    include: [{ model: ExamEvaluation, as: 'evaluation' }],
  });
  const corrections = await correctionRepo.findAll({
    where: { answerId: answerIds },
    order: [['id', 'ASC']],
  });
  const latest = new Map(corrections.map((c) => [c.answerId, c.afterMarks]));
  for (const a of answers) {
    if (latest.has(a.id)) out.set(a.id, latest.get(a.id)!);
    else if (a.evaluation) out.set(a.id, a.evaluation.finalMarks);
    else out.set(a.id, a.autoScore ?? 0);
  }
  return out;
}

/** Recalculates objective/descriptive/total scores and pending evaluations of an attempt. */
export async function recomputeAttempt(attemptId: number) {
  const attempt = await attemptRepo.findById(attemptId);
  const eqs = await examQuestionRepo.findAll({ where: { examId: attempt.examId } });
  const typeOf = new Map(eqs.map((q) => [q.id, q.snapshot.type]));
  const answers = await answerRepo.findAll({ where: { attemptId }, attributes: ['id', 'examQuestionId'] });
  const marks = await effectiveMarks(answers.map((a) => a.id));
  let objective = 0;
  let descriptive = 0;
  let pending = 0;
  for (const a of answers) {
    const m = marks.get(a.id);
    if (m == null) {
      pending++;
      continue;
    }
    if (typeOf.get(a.examQuestionId) === 'descriptive') descriptive += m;
    else objective += m;
  }
  await attempt.update({
    objectiveScore: round2(objective),
    descriptiveScore: round2(descriptive),
    totalScore: round2(objective + descriptive),
    maxScore: round2(eqs.reduce((s, q) => s + q.marks, 0)),
    pendingEvaluations: pending,
  });
  return attempt;
}

/** Auto-submits every overdue attempt of an exam (used before evaluation/publishing). */
export async function closeOverdueAttempts(exam: Exam) {
  const open = await attemptRepo.findAll({
    where: {
      examId: exam.id,
      status: 'in_progress',
      deadlineAt: { [Op.lt]: new Date(Date.now() - GRACE_MS) },
    },
  });
  for (const a of open) await finalizeAttempt(a, exam, 'auto_submitted');
}
