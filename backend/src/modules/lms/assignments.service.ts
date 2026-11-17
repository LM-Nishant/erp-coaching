import { Op, type WhereOptions } from 'sequelize';
import type { LmsAssignmentDto, LmsSubmissionDto } from '@erp/shared';
import { enqueueJob } from '../../infrastructure/jobs/queue';
import { getSequelize } from '../../infrastructure/database/sequelize';
import { hasPermission, requireTenantContext } from '../../shared/context';
import { BadRequest, Conflict, Forbidden, NotFound } from '../../shared/errors';
import { TenantRepository } from '../../shared/tenancy/tenant-repository';
import { audit } from '../../shared/audit/audit.service';
import { Batch, BatchStudent, Chapter, Subject, Topic } from '../academics/api';
import { FileObject } from '../files/file.model';
import { fileRepo } from '../files/files.service';
import { getLinkedStudentUsers } from '../guardians/guardian-access';
import { User } from '../users/user.model';
import { activeBatchIds } from './entitlements';
import { LmsAssignment, LmsAssignmentFile, LmsSubmission, LmsSubmissionFile } from './models';
import { notifyHomeworkAssigned, notifyHomeworkDue, notifyHomeworkGraded } from './notifications';
import { fileRef } from './uploads.service';

export const DUE_REMINDER_JOB = 'lms.assignment-due';
const REMIND_BEFORE_MS = 24 * 3600_000;

export const assignmentRepo = new TenantRepository(LmsAssignment, {
  entity: 'Assignment',
  branchScoped: true,
});

const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);
const isAssignmentStaff = () => hasPermission('lms-assignments.edit');

const assignmentInclude = [
  { model: Batch, as: 'batch', attributes: ['id', 'name', 'branchId'] },
  { model: Subject, as: 'subject', attributes: ['id', 'name'] },
  { model: User, as: 'creator', attributes: ['id', 'name'] },
  { model: LmsAssignmentFile, as: 'files', include: [{ model: FileObject, as: 'file' }] },
];
const submissionInclude = [
  { model: User, as: 'student', attributes: ['id', 'name'] },
  { model: User, as: 'grader', attributes: ['id', 'name'] },
  { model: LmsSubmissionFile, as: 'files', include: [{ model: FileObject, as: 'file' }] },
];

function toSubmissionDto(s: LmsSubmission): LmsSubmissionDto {
  return {
    id: s.id,
    assignmentId: s.assignmentId,
    student: { id: s.studentUserId, name: s.student?.name ?? '' },
    text: s.text,
    status: s.status,
    isLate: s.isLate,
    submittedAt: s.submittedAt.toISOString(),
    marks: s.marks,
    feedback: s.feedback,
    gradedBy: s.grader ? { id: s.grader.id, name: s.grader.name } : null,
    gradedAt: iso(s.gradedAt),
    files: (s.files ?? []).filter((f) => f.file).map((f) => fileRef(f.file!, true)),
  };
}

function toAssignmentDto(a: LmsAssignment): LmsAssignmentDto {
  return {
    id: a.id,
    batchId: a.batchId,
    batchName: a.batch?.name ?? null,
    branchId: a.branchId,
    subjectId: a.subjectId,
    subjectName: a.subject?.name ?? null,
    chapterId: a.chapterId,
    topicId: a.topicId,
    title: a.title,
    instructions: a.instructions,
    dueAt: a.dueAt.toISOString(),
    maxMarks: a.maxMarks,
    allowLate: a.allowLate,
    status: a.status,
    publishedAt: iso(a.publishedAt),
    createdBy: a.creator ? { id: a.creator.id, name: a.creator.name } : null,
    files: (a.files ?? []).filter((f) => f.file).map((f) => fileRef(f.file!, true)),
  };
}

async function activeStudentIds(instituteId: number, batchId: number) {
  const rows = await BatchStudent.findAll({
    where: { instituteId, batchId, status: 'active' },
    attributes: ['studentUserId'],
  });
  return [...new Set(rows.map((r) => r.studentUserId))];
}

async function withCounts(a: LmsAssignment): Promise<LmsAssignmentDto> {
  const students = (await activeStudentIds(a.instituteId, a.batchId)).length;
  const submitted = await LmsSubmission.count({ where: { instituteId: a.instituteId, assignmentId: a.id } });
  const graded = await LmsSubmission.count({
    where: { instituteId: a.instituteId, assignmentId: a.id, status: 'graded' },
  });
  return { ...toAssignmentDto(a), counts: { students, submitted, graded } };
}

// ---------------------------------------------------------------------------------------------
// Staff
// ---------------------------------------------------------------------------------------------

export interface AssignmentWriteInput {
  batchId: number;
  subjectId?: number | null;
  chapterId?: number | null;
  topicId?: number | null;
  title: string;
  instructions?: string | null;
  dueAt: Date;
  maxMarks?: number | null;
  allowLate?: boolean;
  fileIds?: number[];
}

async function resolveBatch(instituteId: number, batchId: number) {
  const batch = await Batch.findOne({ where: { instituteId, id: batchId } });
  if (!batch) throw BadRequest('Unknown batch');
  assignmentRepo.assertBranchAllowed(batch.branchId);
  return batch;
}

async function assertTaxonomy(instituteId: number, v: Partial<AssignmentWriteInput>) {
  if (v.subjectId && !(await Subject.count({ where: { instituteId, id: v.subjectId } })))
    throw BadRequest('Unknown subject');
  if (v.chapterId && !(await Chapter.count({ where: { instituteId, id: v.chapterId } })))
    throw BadRequest('Unknown chapter');
  if (v.topicId && !(await Topic.count({ where: { instituteId, id: v.topicId } })))
    throw BadRequest('Unknown topic');
}

async function assertFiles(fileIds: number[] | undefined, ownerUserId?: number) {
  const ids = [...new Set(fileIds ?? [])];
  for (const id of ids) {
    const f = await fileRepo.findById(id);
    if (ownerUserId && f.ownerUserId !== ownerUserId) throw BadRequest('Attach files you uploaded yourself');
  }
  return ids;
}

export async function listAssignments(q: {
  page: number;
  pageSize: number;
  search?: string;
  batchId?: number;
  status?: string;
}) {
  const where: WhereOptions = {};
  if (q.batchId) Object.assign(where, { batchId: q.batchId });
  if (q.status) Object.assign(where, { status: q.status });
  if (q.search) Object.assign(where, { title: { [Op.like]: `%${q.search}%` } });
  const { rows, count } = await assignmentRepo.findAndCountAll({
    where,
    include: assignmentInclude,
    order: [['dueAt', 'DESC']],
    limit: q.pageSize,
    offset: (q.page - 1) * q.pageSize,
    // count parents, not joined hasMany rows
    ...({ distinct: true } as object),
  });
  return { items: await Promise.all(rows.map(withCounts)), total: count, page: q.page, pageSize: q.pageSize };
}

export async function createAssignment(v: AssignmentWriteInput) {
  const { instituteId, userId } = requireTenantContext();
  const batch = await resolveBatch(instituteId, v.batchId);
  await assertTaxonomy(instituteId, v);
  const fileIds = await assertFiles(v.fileIds);
  const a = await getSequelize().transaction(async (transaction) => {
    const row = await assignmentRepo.create(
      {
        branchId: batch.branchId,
        batchId: batch.id,
        subjectId: v.subjectId ?? null,
        chapterId: v.chapterId ?? null,
        topicId: v.topicId ?? null,
        title: v.title,
        instructions: v.instructions ?? null,
        dueAt: v.dueAt,
        maxMarks: v.maxMarks ?? null,
        allowLate: v.allowLate ?? false,
        createdByUserId: userId,
      },
      { transaction },
    );
    if (fileIds.length)
      await LmsAssignmentFile.bulkCreate(
        fileIds.map((fileId) => ({ instituteId, assignmentId: row.id, fileId })),
        { transaction },
      );
    return row;
  });
  await audit({ action: 'lms.assignment.created', entityType: 'lms_assignment', entityId: a.id });
  return getAssignment(a.id);
}

export async function updateAssignment(id: number, patch: Partial<AssignmentWriteInput>) {
  const { instituteId } = requireTenantContext();
  const a = await assignmentRepo.findById(id);
  if (a.status === 'closed') throw Conflict('Closed homework cannot be edited', 'ASSIGNMENT_CLOSED');
  if (patch.batchId && patch.batchId !== a.batchId) {
    if (a.status !== 'draft')
      throw Conflict('The batch of published homework cannot change', 'ASSIGNMENT_PUBLISHED');
    await resolveBatch(instituteId, patch.batchId);
  }
  await assertTaxonomy(instituteId, patch);
  const fileIds = patch.fileIds ? await assertFiles(patch.fileIds) : undefined;
  const batch = patch.batchId ? await resolveBatch(instituteId, patch.batchId) : null;
  const dueChanged = patch.dueAt && patch.dueAt.getTime() !== a.dueAt.getTime();
  await getSequelize().transaction(async (transaction) => {
    const { fileIds: _ignored, ...fields } = patch;
    await a.update({ ...fields, ...(batch ? { branchId: batch.branchId } : {}) }, { transaction });
    if (fileIds) {
      await LmsAssignmentFile.destroy({ where: { instituteId, assignmentId: a.id }, transaction });
      if (fileIds.length)
        await LmsAssignmentFile.bulkCreate(
          fileIds.map((fileId) => ({ instituteId, assignmentId: a.id, fileId })),
          { transaction },
        );
    }
  });
  if (dueChanged && a.status === 'published') await scheduleDueReminder(a);
  await audit({
    action: 'lms.assignment.updated',
    entityType: 'lms_assignment',
    entityId: a.id,
    metadata: { fields: Object.keys(patch) },
  });
  return getAssignment(a.id);
}

export async function deleteAssignment(id: number) {
  const { instituteId } = requireTenantContext();
  const a = await assignmentRepo.findById(id);
  if (await LmsSubmission.count({ where: { instituteId, assignmentId: a.id } }))
    throw Conflict('Homework with submissions cannot be deleted; close it instead', 'HAS_SUBMISSIONS');
  await getSequelize().transaction(async (transaction) => {
    await LmsAssignmentFile.destroy({ where: { instituteId, assignmentId: a.id }, transaction });
    await a.destroy({ transaction });
  });
  await audit({ action: 'lms.assignment.deleted', entityType: 'lms_assignment', entityId: id });
}

async function scheduleDueReminder(a: LmsAssignment) {
  const runAt = new Date(a.dueAt.getTime() - REMIND_BEFORE_MS);
  if (a.dueAt <= new Date()) return;
  await enqueueJob(
    DUE_REMINDER_JOB,
    { assignmentId: a.id, dueAt: a.dueAt.toISOString() },
    { runAt: runAt > new Date() ? runAt : new Date() },
  );
}

export async function publishAssignment(id: number) {
  const { instituteId } = requireTenantContext();
  const a = await assignmentRepo.findById(id, { include: assignmentInclude });
  if (a.status !== 'draft') throw Conflict('Homework is already published', 'ALREADY_PUBLISHED');
  if (a.dueAt <= new Date()) throw BadRequest('Set a due date in the future before publishing');
  await a.update({ status: 'published', publishedAt: new Date() });
  await notifyHomeworkAssigned({
    batchId: a.batchId,
    branchId: a.branchId,
    title: a.title,
    subject: a.subject?.name ?? null,
    dueAt: a.dueAt,
    studentUserIds: await activeStudentIds(instituteId, a.batchId),
  });
  await scheduleDueReminder(a);
  await audit({ action: 'lms.assignment.published', entityType: 'lms_assignment', entityId: a.id });
  return getAssignment(a.id);
}

export async function closeAssignment(id: number) {
  const a = await assignmentRepo.findById(id);
  if (a.status !== 'published') throw Conflict('Only published homework can be closed', 'NOT_PUBLISHED');
  await a.update({ status: 'closed' });
  await audit({ action: 'lms.assignment.closed', entityType: 'lms_assignment', entityId: a.id });
  return getAssignment(a.id);
}

/** Job: reminds students who have not submitted, 24h before the due time (skips stale schedules). */
export async function runDueReminder(payload: { assignmentId: number; dueAt: string }) {
  const { instituteId } = requireTenantContext();
  const a = await LmsAssignment.findOne({ where: { instituteId, id: payload.assignmentId } });
  if (!a || a.status !== 'published' || a.dueAt.toISOString() !== payload.dueAt || a.dueAt <= new Date())
    return;
  const students = await activeStudentIds(instituteId, a.batchId);
  const submitted = new Set(
    (
      await LmsSubmission.findAll({
        where: { instituteId, assignmentId: a.id },
        attributes: ['studentUserId'],
      })
    ).map((s) => s.studentUserId),
  );
  await notifyHomeworkDue({
    branchId: a.branchId,
    title: a.title,
    dueAt: a.dueAt,
    studentUserIds: students.filter((id) => !submitted.has(id)),
  });
}

export async function listSubmissions(assignmentId: number): Promise<LmsSubmissionDto[]> {
  const { instituteId } = requireTenantContext();
  const a = await assignmentRepo.findById(assignmentId);
  const rows = await LmsSubmission.findAll({
    where: { instituteId, assignmentId: a.id },
    include: submissionInclude,
    order: [['submittedAt', 'ASC']],
  });
  return rows.map(toSubmissionDto);
}

export async function gradeSubmission(
  id: number,
  v: { marks?: number | null; feedback?: string | null; status?: 'graded' | 'returned' },
) {
  const { instituteId, userId } = requireTenantContext();
  const s = await LmsSubmission.findOne({ where: { instituteId, id } });
  if (!s) throw NotFound('Submission');
  const a = await assignmentRepo.findById(s.assignmentId); // enforces branch scope
  const status = v.status ?? 'graded';
  if (status === 'graded' && a.maxMarks !== null && v.marks === undefined)
    throw BadRequest('Enter marks for this homework');
  if (v.marks !== undefined && v.marks !== null && a.maxMarks !== null && v.marks > a.maxMarks)
    throw BadRequest(`Marks cannot exceed ${a.maxMarks}`);
  await s.update({
    status,
    marks: v.marks === undefined ? s.marks : v.marks,
    feedback: v.feedback === undefined ? s.feedback : v.feedback,
    gradedByUserId: userId,
    gradedAt: new Date(),
  });
  await notifyHomeworkGraded({
    branchId: a.branchId,
    title: a.title,
    studentUserId: s.studentUserId,
    marks: s.marks,
    maxMarks: a.maxMarks,
    status,
  });
  await audit({
    action: 'lms.submission.graded',
    entityType: 'lms_submission',
    entityId: s.id,
    metadata: { marks: s.marks, status },
  });
  return toSubmissionDto(
    (await LmsSubmission.findOne({ where: { instituteId, id }, include: submissionInclude }))!,
  );
}

// ---------------------------------------------------------------------------------------------
// Learner / parent
// ---------------------------------------------------------------------------------------------

async function learnerAssignments(
  instituteId: number,
  studentUserId: number,
  q: { status?: 'pending' | 'done' },
) {
  const batchIds = await activeBatchIds(instituteId, studentUserId);
  if (!batchIds.length) return [];
  const rows = await LmsAssignment.findAll({
    where: { instituteId, batchId: batchIds, status: ['published', 'closed'] },
    include: assignmentInclude,
    order: [['dueAt', 'DESC']],
  });
  const subs = await LmsSubmission.findAll({
    where: { instituteId, studentUserId, assignmentId: rows.map((r) => r.id) },
    include: submissionInclude,
  });
  const byAssignment = new Map(subs.map((s) => [s.assignmentId, s]));
  return rows
    .map((a) => {
      const sub = byAssignment.get(a.id);
      return { ...toAssignmentDto(a), mySubmission: sub ? toSubmissionDto(sub) : null };
    })
    .filter((d) => {
      if (!q.status) return true;
      const pending = !d.mySubmission || d.mySubmission.status === 'returned';
      return q.status === 'pending' ? pending && d.status === 'published' : !pending;
    });
}

export async function myAssignments(q: { status?: 'pending' | 'done' }) {
  const { instituteId, userId } = requireTenantContext();
  return learnerAssignments(instituteId, userId!, q);
}

export async function childrenAssignments(q: { status?: 'pending' | 'done'; studentUserId?: number }) {
  const { instituteId, userId } = requireTenantContext();
  const children = (await getLinkedStudentUsers(userId!, instituteId)).filter(
    (c) => !q.studentUserId || c.id === q.studentUserId,
  );
  const out: LmsAssignmentDto[] = [];
  for (const c of children)
    for (const a of await learnerAssignments(instituteId, c.id, q))
      out.push({ ...a, student: { id: c.id, name: c.name } });
  return out.sort((a, b) => b.dueAt.localeCompare(a.dueAt));
}

/** Staff see any assignment in scope; learners only those of their batches; parents their children's. */
export async function getAssignment(id: number): Promise<LmsAssignmentDto> {
  const { instituteId, userId } = requireTenantContext();
  if (isAssignmentStaff())
    return withCounts(await assignmentRepo.findById(id, { include: assignmentInclude }));
  const a = await LmsAssignment.findOne({
    where: { instituteId, id, status: ['published', 'closed'] },
    include: assignmentInclude,
  });
  if (!a) throw NotFound('Assignment');
  const own = await activeBatchIds(instituteId, userId!);
  if (own.includes(a.batchId)) {
    const sub = await LmsSubmission.findOne({
      where: { instituteId, assignmentId: a.id, studentUserId: userId! },
      include: submissionInclude,
    });
    return { ...toAssignmentDto(a), mySubmission: sub ? toSubmissionDto(sub) : null };
  }
  for (const c of await getLinkedStudentUsers(userId!, instituteId)) {
    if (!(await activeBatchIds(instituteId, c.id)).includes(a.batchId)) continue;
    const sub = await LmsSubmission.findOne({
      where: { instituteId, assignmentId: a.id, studentUserId: c.id },
      include: submissionInclude,
    });
    return {
      ...toAssignmentDto(a),
      mySubmission: sub ? toSubmissionDto(sub) : null,
      student: { id: c.id, name: c.name },
    };
  }
  throw NotFound('Assignment');
}

export async function submitAssignment(id: number, v: { text?: string | null; fileIds?: number[] }) {
  const { instituteId, userId } = requireTenantContext();
  const a = await LmsAssignment.findOne({ where: { instituteId, id, status: ['published', 'closed'] } });
  if (!a || !(await activeBatchIds(instituteId, userId!)).includes(a.batchId)) throw NotFound('Assignment');
  if (a.status === 'closed') throw Conflict('This homework is closed', 'ASSIGNMENT_CLOSED');
  const now = new Date();
  const late = now > a.dueAt;
  if (late && !a.allowLate) throw Conflict('The due date has passed', 'PAST_DUE');
  if (!v.text?.trim() && !v.fileIds?.length) throw BadRequest('Add an answer or attach a file');
  const fileIds = await assertFiles(v.fileIds, userId!);
  const sub = await getSequelize().transaction(async (transaction) => {
    const existing = await LmsSubmission.findOne({
      where: { instituteId, assignmentId: a.id, studentUserId: userId! },
      lock: transaction.LOCK.UPDATE,
      transaction,
    });
    if (existing?.status === 'graded')
      throw Conflict('This homework has already been graded', 'ALREADY_GRADED');
    const values = { text: v.text ?? null, status: 'submitted' as const, isLate: late, submittedAt: now };
    const row = existing
      ? await existing.update(values, { transaction })
      : await LmsSubmission.create(
          { instituteId, assignmentId: a.id, studentUserId: userId!, ...values },
          { transaction },
        );
    await LmsSubmissionFile.destroy({ where: { instituteId, submissionId: row.id }, transaction });
    if (fileIds.length)
      await LmsSubmissionFile.bulkCreate(
        fileIds.map((fileId) => ({ instituteId, submissionId: row.id, fileId })),
        { transaction },
      );
    return row;
  });
  await audit({
    action: 'lms.assignment.submitted',
    entityType: 'lms_assignment',
    entityId: a.id,
    metadata: { submissionId: sub.id, late },
  });
  return toSubmissionDto(
    (await LmsSubmission.findOne({ where: { instituteId, id: sub.id }, include: submissionInclude }))!,
  );
}

export function assertCanSubmit() {
  if (isAssignmentStaff()) throw Forbidden('Staff accounts cannot submit homework', 'STAFF_CANNOT_SUBMIT');
}
