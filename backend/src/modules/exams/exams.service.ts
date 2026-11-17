import { Op, UniqueConstraintError, type WhereOptions } from 'sequelize';
import type {
  AddExamQuestionsInput,
  ExamDetailDto,
  ExamDto,
  ExamInput,
  ExamPhase,
  ExamSectionDto,
  ExamSectionInput,
  UpdateExamQuestionInput,
} from '@erp/shared';
import { TenantRepository } from '../../shared/tenancy/tenant-repository';
import { hasPermission, requireTenantContext } from '../../shared/context';
import { BadRequest, Conflict, Forbidden, NotFound } from '../../shared/errors';
import { audit } from '../../shared/audit/audit.service';
import { paginated, toLimitOffset } from '../../shared/utilities/pagination';
import { enqueueJob } from '../../infrastructure/jobs/queue';
import { logger } from '../../infrastructure/logger';
import { Batch, BatchStudent, Course, Subject } from '../academics/api';
import { loadReusableQuestions, questionDtos, Question } from '../question-bank/api';
import { batchMembersOf, notify } from '../notifications/api';
import { Exam, ExamAttempt, ExamQuestion, ExamSection, PromptVersion, type QuestionSnapshot } from './models';
import { round2 } from './scoring';

export const MODULE = 'exams';
export const REMINDER_JOB = 'exams.reminder';

/** Staff access: branch-scoped (exams without a branch are institute-wide). */
export const examRepo = new TenantRepository(Exam, { branchScoped: true, instituteWideRows: true, entity: 'Exam' });
/** Candidate/guardian access: institute-scoped; eligibility is checked through enrolment instead. */
export const examTenantRepo = new TenantRepository(Exam, { entity: 'Exam' });
export const sectionRepo = new TenantRepository(ExamSection, { entity: 'Section' });
export const examQuestionRepo = new TenantRepository(ExamQuestion, { entity: 'Exam question' });
export const attemptRepo = new TenantRepository(ExamAttempt, { entity: 'Attempt' });
const batchRepo = new TenantRepository(Batch, { branchScoped: true, entity: 'Batch' });
const courseRepo = new TenantRepository(Course, { entity: 'Course' });
const subjectRepo = new TenantRepository(Subject, { entity: 'Subject' });
const batchStudentRepo = new TenantRepository(BatchStudent, { entity: 'Enrolment' });
const promptRepo = new TenantRepository(PromptVersion, { entity: 'Prompt version' });

export const me = () => requireTenantContext().userId!;

export function examPhase(e: Exam, now = new Date()): ExamPhase {
  if (e.status === 'cancelled') return 'cancelled';
  if (e.status === 'draft') return 'draft';
  if (e.resultsPublishedAt) return 'published';
  if (now < e.startAt) return 'upcoming';
  if (now < e.endAt) return 'live';
  return 'closed';
}

export function examDto(e: Exam, stats?: { totalMarks: number; questionCount: number }): ExamDto {
  const qs = e.questions;
  const totalMarks = stats?.totalMarks ?? round2((qs ?? []).reduce((s, q) => s + q.marks, 0));
  return {
    id: e.id,
    branchId: e.branchId,
    title: e.title,
    description: e.description,
    instructions: e.instructions,
    batchId: e.batchId,
    batchName: e.batch?.name ?? null,
    courseId: e.courseId,
    courseName: e.course?.name ?? null,
    subjectId: e.subjectId,
    startAt: e.startAt.toISOString(),
    endAt: e.endAt.toISOString(),
    durationMinutes: e.durationMinutes,
    status: e.status,
    phase: examPhase(e),
    evaluationMode: e.evaluationMode,
    promptVersionId: e.promptVersionId,
    shuffleQuestions: e.shuffleQuestions,
    shuffleOptions: e.shuffleOptions,
    partialMarking: e.partialMarking,
    defaultMarks: e.defaultMarks,
    defaultNegativeMarks: e.defaultNegativeMarks,
    passMarks: e.passMarks,
    totalMarks,
    questionCount: stats?.questionCount ?? qs?.length ?? 0,
    resultsPublishedAt: e.resultsPublishedAt?.toISOString() ?? null,
    createdByUserId: e.createdByUserId,
    createdAt: e.createdAt.toISOString(),
  };
}

const examIncludes = () => [
  { model: Batch, as: 'batch', attributes: ['id', 'name'] },
  { model: Course, as: 'course', attributes: ['id', 'name'] },
  { model: ExamQuestion, as: 'questions', attributes: ['id', 'marks'] },
];

export async function examDtos(exams: Exam[]): Promise<ExamDto[]> {
  return exams.map((e) => examDto(e));
}

/** Loads an exam with batch/course/question totals for DTOs. */
export async function loadExamForDto(id: number, repo = examRepo): Promise<Exam> {
  return repo.findById(id, { include: examIncludes() });
}

// ---------------------------------------------------------------- eligibility

/** Batch ids whose active students may sit the exam. */
export async function examBatchIds(exam: Exam): Promise<number[]> {
  if (exam.batchId) return [exam.batchId];
  if (!exam.courseId) return [];
  const where: Record<string, unknown> = { courseId: exam.courseId, instituteId: exam.instituteId };
  if (exam.branchId) where.branchId = exam.branchId;
  const batches = await Batch.findAll({ where, attributes: ['id'] });
  return batches.map((b) => b.id);
}

export async function eligibleStudentUserIds(exam: Exam): Promise<number[]> {
  const batchIds = await examBatchIds(exam);
  if (!batchIds.length) return [];
  const rows = await batchStudentRepo.findAll({
    where: { batchId: batchIds, status: 'active' },
    attributes: ['studentUserId'],
  });
  return [...new Set(rows.map((r) => r.studentUserId))];
}

export async function isEligible(exam: Exam, studentUserId: number): Promise<boolean> {
  const batchIds = await examBatchIds(exam);
  if (!batchIds.length) return false;
  return (await batchStudentRepo.count({ batchId: batchIds, studentUserId, status: 'active' })) > 0;
}

/** Scheduled exams the student is enrolled for (through batch or course). */
export async function examsForStudent(studentUserId: number, extra: WhereOptions<Exam> = {}): Promise<Exam[]> {
  const enrolments = await batchStudentRepo.findAll({
    where: { studentUserId, status: 'active' },
    include: [{ model: Batch, as: 'batch', attributes: ['id', 'courseId', 'branchId'] }],
  });
  if (!enrolments.length) return [];
  const batchIds = enrolments.map((e) => e.batchId);
  const courseConds = enrolments
    .filter((e) => e.batch)
    .map((e) => ({
      courseId: e.batch!.courseId,
      batchId: null,
      [Op.or]: [{ branchId: null }, { branchId: e.batch!.branchId }],
    }));
  return examTenantRepo.findAll({
    where: {
      ...(extra as object),
      status: { [Op.ne]: 'draft' },
      [Op.or]: [{ batchId: batchIds }, ...courseConds],
    } as WhereOptions<Exam>,
    include: examIncludes(),
    order: [['startAt', 'DESC']],
  });
}

// ---------------------------------------------------------------- exams CRUD

export interface ExamFilter {
  page: number;
  pageSize: number;
  status?: string;
  phase?: ExamPhase;
  batchId?: number;
  courseId?: number;
  q?: string;
}

export async function listExams(f: ExamFilter) {
  const where: Record<string | symbol, unknown> = {};
  if (f.status) where.status = f.status;
  if (f.batchId) where.batchId = f.batchId;
  if (f.courseId) where.courseId = f.courseId;
  if (f.q) where.title = { [Op.like]: `%${f.q}%` };
  const now = new Date();
  if (f.phase === 'upcoming') Object.assign(where, { status: 'scheduled', startAt: { [Op.gt]: now } });
  if (f.phase === 'live')
    Object.assign(where, { status: 'scheduled', startAt: { [Op.lte]: now }, endAt: { [Op.gt]: now } });
  if (f.phase === 'closed')
    Object.assign(where, { status: 'scheduled', endAt: { [Op.lte]: now }, resultsPublishedAt: null });
  if (f.phase === 'published') where.resultsPublishedAt = { [Op.ne]: null };
  if (f.phase === 'draft') where.status = 'draft';
  if (f.phase === 'cancelled') where.status = 'cancelled';
  const { rows, count } = await examRepo.findAndCountAll({
    where: where as WhereOptions<Exam>,
    include: examIncludes(),
    order: [['startAt', 'DESC']],
    ...toLimitOffset(f),
  });
  return paginated(await examDtos(rows), count, f);
}

async function resolveTarget(input: Partial<ExamInput>, current?: Exam) {
  const batchId = input.batchId !== undefined ? input.batchId : (current?.batchId ?? null);
  const courseId = input.courseId !== undefined ? input.courseId : (current?.courseId ?? null);
  if (!batchId && !courseId) throw BadRequest('Choose a batch or a course for the exam');
  if (batchId) {
    const batch = await batchRepo.findById(batchId);
    return { batchId, courseId: batch.courseId, branchId: batch.branchId };
  }
  await courseRepo.findById(courseId!);
  const branchId = input.branchId !== undefined ? input.branchId : (current?.branchId ?? null);
  return { batchId: null, courseId, branchId: branchId ?? null };
}

function assertWindow(startAt: Date, endAt: Date, durationMinutes: number) {
  if (endAt <= startAt) throw BadRequest('The exam window must end after it starts');
  if (durationMinutes * 60000 > endAt.getTime() - startAt.getTime())
    throw BadRequest('Duration cannot exceed the exam window');
}

async function assertEvaluationMode(mode: string | undefined, promptVersionId?: number | null) {
  if (mode === 'ai_only' && !hasPermission(`${MODULE}.configure`))
    throw Forbidden('AI-only evaluation requires the exams.configure permission', 'AI_ONLY_FORBIDDEN');
  if (promptVersionId) {
    const pv = await promptRepo.findById(promptVersionId);
    if (pv.feature !== 'exams.grading') throw BadRequest('Prompt version is not for exam grading');
  }
}

export async function createExam(input: ExamInput): Promise<ExamDetailDto> {
  const target = await resolveTarget(input);
  const startAt = new Date(input.startAt);
  const endAt = new Date(input.endAt);
  assertWindow(startAt, endAt, input.durationMinutes);
  await assertEvaluationMode(input.evaluationMode, input.promptVersionId);
  if (input.subjectId) await subjectRepo.findById(input.subjectId);
  const exam = await examRepo.create({
    ...target,
    title: input.title,
    description: input.description ?? null,
    instructions: input.instructions ?? null,
    subjectId: input.subjectId ?? null,
    startAt,
    endAt,
    durationMinutes: input.durationMinutes,
    evaluationMode: input.evaluationMode ?? 'manual',
    promptVersionId: input.promptVersionId ?? null,
    shuffleQuestions: input.shuffleQuestions ?? false,
    shuffleOptions: input.shuffleOptions ?? false,
    partialMarking: input.partialMarking ?? false,
    defaultMarks: input.defaultMarks ?? 1,
    defaultNegativeMarks: input.defaultNegativeMarks ?? 0,
    passMarks: input.passMarks ?? null,
    resultsPublishedAt: null,
    resultsPublishedBy: null,
    createdByUserId: me(),
  });
  await sectionRepo.create({ examId: exam.id, title: 'Section A', instructions: null, sortOrder: 0 });
  await audit({ action: 'exam.created', entityType: 'exam', entityId: exam.id, metadata: { title: exam.title } });
  return getExamDetail(exam.id);
}

async function hasAttempts(examId: number) {
  return (await attemptRepo.count({ examId })) > 0;
}

/** Structure (questions, marks, sections) is frozen once a candidate has started. */
async function assertStructureEditable(exam: Exam) {
  if (exam.status === 'cancelled') throw Conflict('The exam is cancelled', 'EXAM_CANCELLED');
  if (await hasAttempts(exam.id))
    throw Conflict('Candidates have already started this exam; its questions are locked', 'EXAM_LOCKED');
}

export async function updateExam(id: number, input: Partial<ExamInput>): Promise<ExamDetailDto> {
  const exam = await examRepo.findById(id);
  examRepo.assertRowWritable(exam);
  if (exam.resultsPublishedAt) throw Conflict('Results are published; the exam can no longer be edited');
  const started = await hasAttempts(id);
  const structural = ['batchId', 'courseId', 'branchId', 'shuffleQuestions', 'shuffleOptions', 'partialMarking', 'startAt', 'durationMinutes'];
  if (started && structural.some((k) => (input as Record<string, unknown>)[k] !== undefined))
    throw Conflict('Candidates have already started; only the end time, texts and evaluation settings can change', 'EXAM_LOCKED');
  const changes: Record<string, unknown> = { ...input };
  if (input.batchId !== undefined || input.courseId !== undefined || input.branchId !== undefined)
    Object.assign(changes, await resolveTarget(input, exam));
  const startAt = input.startAt ? new Date(input.startAt) : exam.startAt;
  const endAt = input.endAt ? new Date(input.endAt) : exam.endAt;
  if (input.startAt || input.endAt || input.durationMinutes)
    assertWindow(startAt, endAt, input.durationMinutes ?? exam.durationMinutes);
  if (input.startAt) changes.startAt = startAt;
  if (input.endAt) changes.endAt = endAt;
  if (input.evaluationMode !== undefined || input.promptVersionId)
    await assertEvaluationMode(input.evaluationMode, input.promptVersionId);
  if (input.subjectId) await subjectRepo.findById(input.subjectId);
  const before = exam.get({ plain: true });
  await exam.update(changes);
  if (input.startAt && exam.status === 'scheduled') await scheduleReminder(exam);
  await audit({
    action: 'exam.updated',
    entityType: 'exam',
    entityId: id,
    metadata: {
      changes: Object.keys(input),
      before: Object.fromEntries(Object.keys(input).map((k) => [k, (before as Record<string, unknown>)[k]])),
    },
  });
  return getExamDetail(id);
}

export async function deleteExam(id: number): Promise<void> {
  const exam = await examRepo.findById(id);
  examRepo.assertRowWritable(exam);
  if (await hasAttempts(id)) throw Conflict('Exams with attempts cannot be deleted; cancel it instead', 'EXAM_LOCKED');
  await exam.destroy();
  await audit({ action: 'exam.deleted', entityType: 'exam', entityId: id, metadata: { title: exam.title } });
}

export async function getExamDetail(id: number): Promise<ExamDetailDto> {
  const exam = await loadExamForDto(id);
  const sections = await sectionRepo.findAll({ where: { examId: id }, order: [['sortOrder', 'ASC'], ['id', 'ASC']] });
  const eqs = await examQuestionRepo.findAll({
    where: { examId: id },
    include: [{ model: Question, as: 'question', include: [{ association: 'chapter' }, { association: 'topic' }, { association: 'assets', include: [{ association: 'file' }] }] }],
    order: [['sortOrder', 'ASC'], ['id', 'ASC']],
  });
  const qDtos = await questionDtos(eqs.map((e) => e.question!).filter(Boolean));
  const byId = new Map(qDtos.map((q) => [q.id, q]));
  const sectionOrder = new Map(sections.map((s, i) => [s.id, i]));
  eqs.sort((a, b) => (sectionOrder.get(a.sectionId) ?? 0) - (sectionOrder.get(b.sectionId) ?? 0) || a.sortOrder - b.sortOrder || a.id - b.id);
  return {
    ...examDto(exam),
    sections: sections.map((s) => sectionDto(s, eqs.filter((q) => q.sectionId === s.id).length)),
    questions: eqs.map((eq) => ({
      id: eq.id,
      sectionId: eq.sectionId,
      questionId: eq.questionId,
      sortOrder: eq.sortOrder,
      marks: eq.marks,
      negativeMarks: eq.negativeMarks,
      partialMarking: eq.partialMarking,
      // The frozen snapshot is what candidates see; surface it over the live bank copy.
      question: { ...byId.get(eq.questionId)!, ...snapshotOverlay(eq.snapshot) },
    })),
  };
}

function snapshotOverlay(s: QuestionSnapshot) {
  return { type: s.type, text: s.text, answerKey: s.answerKey, explanation: s.explanation, chapterName: s.chapterName, topicName: s.topicName };
}

export function sectionDto(s: ExamSection, questionCount?: number): ExamSectionDto {
  return { id: s.id, title: s.title, instructions: s.instructions, sortOrder: s.sortOrder, questionCount };
}

// ---------------------------------------------------------------- sections & questions

async function editableExam(id: number) {
  const exam = await examRepo.findById(id);
  examRepo.assertRowWritable(exam);
  await assertStructureEditable(exam);
  return exam;
}

export async function addSection(examId: number, input: ExamSectionInput): Promise<ExamSectionDto> {
  await editableExam(examId);
  const sortOrder = input.sortOrder ?? (await sectionRepo.count({ examId }));
  const s = await sectionRepo.create({ examId, title: input.title, instructions: input.instructions ?? null, sortOrder });
  await audit({ action: 'exam.section_added', entityType: 'exam', entityId: examId, metadata: { sectionId: s.id } });
  return sectionDto(s, 0);
}

export async function updateSection(examId: number, sectionId: number, input: Partial<ExamSectionInput>) {
  const exam = await examRepo.findById(examId);
  examRepo.assertRowWritable(exam);
  const s = await sectionRepo.findOne({ where: { id: sectionId, examId } });
  if (!s) throw NotFound('Section');
  if (input.sortOrder !== undefined) await assertStructureEditable(exam);
  await s.update(input);
  await audit({ action: 'exam.section_updated', entityType: 'exam', entityId: examId, metadata: { sectionId } });
  return sectionDto(s);
}

export async function deleteSection(examId: number, sectionId: number) {
  await editableExam(examId);
  const s = await sectionRepo.findOne({ where: { id: sectionId, examId } });
  if (!s) throw NotFound('Section');
  if ((await sectionRepo.count({ examId })) <= 1) throw Conflict('An exam needs at least one section');
  if ((await examQuestionRepo.count({ sectionId })) > 0) throw Conflict('Move or remove the questions of this section first');
  await s.destroy();
  await audit({ action: 'exam.section_deleted', entityType: 'exam', entityId: examId, metadata: { sectionId } });
}

export function snapshotOf(q: Question): QuestionSnapshot {
  return {
    type: q.type,
    text: q.text,
    options: (q.options ?? []).map((o) => ({ key: o.key, text: o.text, imageFileId: o.imageFileId ?? null })),
    answerKey: q.answerKey,
    explanation: q.explanation,
    assetFileIds: [...(q.assets ?? [])].filter((a) => a.role === 'question').sort((a, b) => a.sortOrder - b.sortOrder).map((a) => a.fileId),
    chapterId: q.chapterId,
    chapterName: q.chapter?.name ?? null,
    topicId: q.topicId,
    topicName: q.topic?.name ?? null,
  };
}

export async function addQuestions(examId: number, input: AddExamQuestionsInput): Promise<ExamDetailDto> {
  const exam = await editableExam(examId);
  const section = await sectionRepo.findOne({ where: { id: input.sectionId, examId } });
  if (!section) throw NotFound('Section');
  const questions = await loadReusableQuestions([...new Set(input.questionIds)]);
  const archived = questions.find((q) => q.status === 'archived');
  if (archived) throw BadRequest(`Question #${archived.id} is archived`);
  const existing = new Set((await examQuestionRepo.findAll({ where: { examId }, attributes: ['questionId'] })).map((e) => e.questionId));
  let sortOrder = await examQuestionRepo.count({ examId, sectionId: section.id });
  const byId = new Map(questions.map((q) => [q.id, q]));
  for (const qid of input.questionIds) {
    if (existing.has(qid)) continue;
    const q = byId.get(qid)!;
    try {
      await examQuestionRepo.create({
        examId,
        sectionId: section.id,
        questionId: qid,
        sortOrder: sortOrder++,
        // A question's own marks apply only when customised away from the bank defaults (1 / 0).
        marks: input.marks ?? (Number(q.defaultMarks) !== 1 ? Number(q.defaultMarks) : exam.defaultMarks),
        negativeMarks: input.negativeMarks ?? (Number(q.defaultNegativeMarks) !== 0 ? Number(q.defaultNegativeMarks) : exam.defaultNegativeMarks),
        partialMarking: exam.partialMarking,
        snapshot: snapshotOf(q),
      });
      existing.add(qid);
    } catch (err) {
      if (!(err instanceof UniqueConstraintError)) throw err;
    }
  }
  await audit({ action: 'exam.questions_added', entityType: 'exam', entityId: examId, metadata: { questionIds: input.questionIds } });
  return getExamDetail(examId);
}

export async function updateExamQuestion(examId: number, eqId: number, input: UpdateExamQuestionInput) {
  const exam = await editableExam(examId);
  const eq = await examQuestionRepo.findOne({ where: { id: eqId, examId } });
  if (!eq) throw NotFound('Exam question');
  if (input.sectionId) {
    const s = await sectionRepo.findOne({ where: { id: input.sectionId, examId } });
    if (!s) throw NotFound('Section');
  }
  await eq.update(input);
  await audit({ action: 'exam.question_updated', entityType: 'exam', entityId: exam.id, metadata: { examQuestionId: eqId, ...input } });
  return getExamDetail(examId);
}

/** Re-copies the latest bank version into the exam (only before anyone starts). */
export async function refreshSnapshot(examId: number, eqId: number) {
  await editableExam(examId);
  const eq = await examQuestionRepo.findOne({ where: { id: eqId, examId } });
  if (!eq) throw NotFound('Exam question');
  const [q] = await loadReusableQuestions([eq.questionId]);
  await eq.update({ snapshot: snapshotOf(q) });
  return getExamDetail(examId);
}

export async function removeExamQuestion(examId: number, eqId: number) {
  await editableExam(examId);
  const eq = await examQuestionRepo.findOne({ where: { id: eqId, examId } });
  if (!eq) throw NotFound('Exam question');
  await eq.destroy();
  await audit({ action: 'exam.question_removed', entityType: 'exam', entityId: examId, metadata: { examQuestionId: eqId } });
  return getExamDetail(examId);
}

// ---------------------------------------------------------------- lifecycle

export async function scheduleExam(id: number): Promise<ExamDetailDto> {
  const exam = await examRepo.findById(id, { include: examIncludes() });
  examRepo.assertRowWritable(exam);
  if (exam.status !== 'draft') throw Conflict('Only draft exams can be scheduled');
  if (!(exam.questions ?? []).length) throw BadRequest('Add at least one question before scheduling');
  if (exam.endAt <= new Date()) throw BadRequest('The exam window has already ended');
  await exam.update({ status: 'scheduled' });
  await audit({ action: 'exam.scheduled', entityType: 'exam', entityId: id });
  await notifyScheduled(exam);
  await scheduleReminder(exam);
  return getExamDetail(id);
}

async function notifyScheduled(exam: Exam) {
  try {
    const recipients = exam.batchId
      ? [batchMembersOf(exam.batchId)]
      : [{ userIds: await eligibleStudentUserIds(exam), type: 'student' as const }];
    await notify({
      event: 'exams.scheduled',
      recipients,
      data: { exam: exam.title, date: exam.startAt.toISOString(), batch: exam.batch?.name ?? exam.course?.name ?? '' },
      branchId: exam.branchId,
    });
  } catch (err) {
    logger.warn({ err, examId: exam.id }, 'exams.scheduled notification failed');
  }
}

/** Reminder 24h before start (or 1h when scheduled less than a day ahead). */
async function scheduleReminder(exam: Exam) {
  const now = Date.now();
  const start = exam.startAt.getTime();
  const runAt = start - 24 * 3600_000 > now ? start - 24 * 3600_000 : start - 3600_000 > now ? start - 3600_000 : null;
  if (runAt) await enqueueJob(REMINDER_JOB, { examId: exam.id, startAt: exam.startAt.toISOString() }, { runAt: new Date(runAt) });
}

export async function runReminder(payload: { examId: number; startAt: string }) {
  const exam = await examTenantRepo.findOne({ where: { id: payload.examId }, include: examIncludes() });
  if (!exam || exam.status !== 'scheduled' || exam.startAt.toISOString() !== payload.startAt) return;
  const recipients = exam.batchId
    ? [batchMembersOf(exam.batchId)]
    : [{ userIds: await eligibleStudentUserIds(exam), type: 'student' as const }];
  await notify({ event: 'exams.reminder', recipients, data: { exam: exam.title, date: exam.startAt.toISOString() }, branchId: exam.branchId });
}

export async function cancelExam(id: number, reason?: string): Promise<ExamDetailDto> {
  const exam = await examRepo.findById(id);
  examRepo.assertRowWritable(exam);
  if (exam.status === 'cancelled') throw Conflict('The exam is already cancelled');
  if (exam.resultsPublishedAt) throw Conflict('Published exams cannot be cancelled');
  await exam.update({ status: 'cancelled' });
  await audit({ action: 'exam.cancelled', entityType: 'exam', entityId: id, metadata: { reason: reason ?? null } });
  return getExamDetail(id);
}

/** Copies an exam (sections + question snapshots) as a new draft. */
export async function duplicateExam(id: number): Promise<ExamDetailDto> {
  const src = await examRepo.findById(id);
  const plain = src.get({ plain: true }) as Record<string, unknown>;
  for (const k of ['id', 'instituteId', 'createdAt', 'updatedAt', 'resultsPublishedAt', 'resultsPublishedBy', 'status', 'createdByUserId']) delete plain[k];
  const copy = await examRepo.create({ ...(plain as object), title: `${src.title} (copy)`, status: 'draft', resultsPublishedAt: null, resultsPublishedBy: null, createdByUserId: me() } as never);
  const sections = await sectionRepo.findAll({ where: { examId: id } });
  for (const s of sections) {
    const ns = await sectionRepo.create({ examId: copy.id, title: s.title, instructions: s.instructions, sortOrder: s.sortOrder });
    const eqs = await examQuestionRepo.findAll({ where: { sectionId: s.id } });
    for (const eq of eqs)
      await examQuestionRepo.create({ examId: copy.id, sectionId: ns.id, questionId: eq.questionId, sortOrder: eq.sortOrder, marks: eq.marks, negativeMarks: eq.negativeMarks, partialMarking: eq.partialMarking, snapshot: eq.snapshot });
  }
  await audit({ action: 'exam.duplicated', entityType: 'exam', entityId: copy.id, metadata: { from: id } });
  return getExamDetail(copy.id);
}
