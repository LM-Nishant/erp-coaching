import { Op, type WhereOptions } from 'sequelize';
import type {
  AskDoubtInput,
  DoubtBox,
  DoubtCountsDto,
  DoubtDetailDto,
  DoubtDto,
  DoubtOptionsDto,
  DoubtReplyDto,
  DoubtStatus,
  DoubtUserRef,
} from '@erp/shared';
import { getContext, hasPermission, requireTenantContext } from '../../shared/context';
import { TenantRepository } from '../../shared/tenancy/tenant-repository';
import { BadRequest, Conflict, Forbidden, NotFound } from '../../shared/errors';
import { audit } from '../../shared/audit/audit.service';
import { paginated, toLimitOffset } from '../../shared/utilities/pagination';
import { FileObject } from '../files/file.model';
import { saveUploadedFile, signedUrlFor } from '../files/files.service';
import { User } from '../users/user.model';
import { Batch, BatchStudent, BatchTeacher, CourseSubject, Subject } from '../academics/api';
import { LmsResource, LmsResourceBatch } from '../lms/api';
import { LiveSession } from '../live-classes/api';
import { Doubt, DoubtReply, authorInclude, doubtIncludes } from './doubts.models';
import { notifyDoubtAnswered, notifyDoubtAsked } from './doubts.notifications';

export const MODULE = 'doubts';
const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];

/** Every doubt in the user's branches (admins, coordinators). */
const doubtRepo = new TenantRepository(Doubt, { entity: 'Doubt', branchScoped: true });
/** Doubts reached through ownership or teaching; access is checked per row. */
const anyDoubtRepo = new TenantRepository(Doubt, { entity: 'Doubt' });
const replyRepo = new TenantRepository(DoubtReply, { entity: 'Reply' });
const batchRepo = new TenantRepository(Batch, { entity: 'Batch' });
const batchStudentRepo = new TenantRepository(BatchStudent, { entity: 'Batch student' });
const batchTeacherRepo = new TenantRepository(BatchTeacher, { entity: 'Batch teacher' });
const subjectRepo = new TenantRepository(Subject, { entity: 'Subject' });
const courseSubjectRepo = new TenantRepository(CourseSubject, { entity: 'Course subject' });
const lectureRepo = new TenantRepository(LmsResource, { entity: 'Lecture' });
const lectureBatchRepo = new TenantRepository(LmsResourceBatch, { entity: 'Lecture batch' });
const liveRepo = new TenantRepository(LiveSession, { entity: 'Live class' });

type UploadedFile = { path: string; originalname: string; mimetype: string; size: number };

const me = () => requireTenantContext().userId!;

const discard = (file?: UploadedFile) =>
  file ? import('node:fs').then((fs) => fs.promises.rm(file.path, { force: true })) : Promise.resolve();

function branchAllowed(branchId: number | null) {
  const allowed = getContext().allowedBranchIds;
  return branchId == null || allowed == null || allowed.includes(branchId);
}

async function myActiveBatchIds(userId: number) {
  const rows = await batchStudentRepo.findAll({
    where: { studentUserId: userId, status: 'active' },
    attributes: ['batchId'],
  });
  return rows.map((r) => r.batchId);
}

async function myTeachingBatchIds(userId: number) {
  const rows = await batchTeacherRepo.findAll({ where: { teacherUserId: userId }, attributes: ['batchId'] });
  return [...new Set(rows.map((r) => r.batchId))];
}

/** Teacher-side rows: assigned to me, or unassigned in a batch I teach. */
function teacherWhere(userId: number, batchIds: number[]): WhereOptions {
  const or: WhereOptions[] = [{ teacherUserId: userId }];
  if (batchIds.length) or.push({ teacherUserId: null, batchId: { [Op.in]: batchIds } });
  return { [Op.or]: or };
}

interface Access {
  doubt: Doubt;
  isMine: boolean;
  canAnswer: boolean;
}

async function accessDoubt(id: number): Promise<Access> {
  const doubt = await anyDoubtRepo.findOne({ where: { id }, include: doubtIncludes() });
  if (!doubt) throw NotFound('Doubt');
  const userId = me();
  const isMine = doubt.studentUserId === userId;
  let canAnswer = false;
  if (!isMine && hasPermission('doubts.edit')) {
    if (doubt.teacherUserId === userId) canAnswer = true;
    else if (hasPermission('doubts.export') && branchAllowed(doubt.branchId)) canAnswer = true;
    else if (doubt.batchId) canAnswer = (await myTeachingBatchIds(userId)).includes(doubt.batchId);
  }
  const canSee = isMine || canAnswer || (hasPermission('doubts.export') && branchAllowed(doubt.branchId));
  if (!canSee) throw NotFound('Doubt');
  return { doubt, isMine, canAnswer };
}

const userRef = (u?: User | null): DoubtUserRef | null => (u ? { id: u.id, name: u.name } : null);

function doubtDto(d: Doubt): DoubtDto {
  return {
    id: d.id,
    status: d.status,
    question: d.question,
    hasPhoto: d.fileId != null,
    student: userRef(d.student) ?? { id: d.studentUserId, name: '' },
    teacher: userRef(d.teacher),
    batch: d.batch ? { id: d.batch.id, name: d.batch.name } : null,
    subject: d.subject ? { id: d.subject.id, name: d.subject.name } : null,
    lecture: d.lecture
      ? { id: d.lecture.id, title: d.lecture.title, positionSeconds: d.positionSeconds }
      : null,
    liveClass: d.liveClass ? { id: d.liveClass.id, title: d.liveClass.title } : null,
    replyCount: d.replyCount,
    lastActivityAt: d.lastActivityAt.toISOString(),
    answeredAt: d.answeredAt ? d.answeredAt.toISOString() : null,
    resolvedAt: d.resolvedAt ? d.resolvedAt.toISOString() : null,
    createdAt: d.createdAt.toISOString(),
  };
}

async function photoUrl(fileId: number | null) {
  if (!fileId) return null;
  const { instituteId } = requireTenantContext();
  const file = await FileObject.findOne({ where: { id: fileId, instituteId } });
  return file ? (await signedUrlFor(file)).url : null;
}

async function savePhoto(file: UploadedFile, branchId: number | null) {
  const saved = await saveUploadedFile({
    tempPath: file.path,
    originalName: file.originalname,
    mimeType: file.mimetype,
    sizeBytes: file.size,
    module: MODULE,
    branchId,
  });
  return saved.id;
}

function checkPhoto(file?: UploadedFile) {
  if (file && !PHOTO_TYPES.includes(file.mimetype))
    throw BadRequest('Attach a photo (JPG, PNG, WEBP or HEIC)');
}

// ---------------------------------------------------------------- list

export async function listDoubts(q: { box: DoubtBox; status?: DoubtStatus; page: number; pageSize: number }) {
  const userId = me();
  let where: WhereOptions;
  let repo = anyDoubtRepo;
  if (q.box === 'mine') where = { studentUserId: userId };
  else if (q.box === 'inbox') {
    if (!hasPermission('doubts.edit')) throw Forbidden();
    where = teacherWhere(userId, await myTeachingBatchIds(userId));
  } else {
    if (!hasPermission('doubts.export')) throw Forbidden();
    repo = doubtRepo;
    where = {};
  }
  if (q.status) where = { ...where, status: q.status };
  const { rows, count } = await repo.findAndCountAll({
    where,
    include: doubtIncludes(),
    order:
      q.box === 'mine'
        ? [['lastActivityAt', 'DESC']]
        : [
            ['status', 'ASC'],
            ['lastActivityAt', 'ASC'],
          ],
    ...toLimitOffset(q),
  });
  return paginated(rows.map(doubtDto), count, q);
}

export async function doubtCounts(): Promise<DoubtCountsDto> {
  const userId = me();
  const answered = await anyDoubtRepo.count({ studentUserId: userId, status: 'answered' });
  let waiting = 0;
  if (hasPermission('doubts.edit')) {
    waiting = await anyDoubtRepo.count({
      [Op.and]: [teacherWhere(userId, await myTeachingBatchIds(userId)), { status: 'open' }],
    } as WhereOptions<Doubt>);
  }
  return { waiting, answered };
}

/** Batches and subjects the student can ask about. */
export async function doubtOptions(): Promise<DoubtOptionsDto> {
  const batchIds = await myActiveBatchIds(me());
  if (!batchIds.length) return { batches: [] };
  const batches = await batchRepo.findAll({
    where: { id: { [Op.in]: batchIds } },
    attributes: ['id', 'name', 'courseId'],
    order: [['name', 'ASC']],
  });
  const links = await courseSubjectRepo.findAll({
    where: { courseId: { [Op.in]: [...new Set(batches.map((b) => b.courseId))] } },
    attributes: ['courseId', 'subjectId'],
  });
  const subjects = await subjectRepo.findAll({
    where: { id: { [Op.in]: [...new Set(links.map((l) => l.subjectId))] } },
    attributes: ['id', 'name'],
    order: [['name', 'ASC']],
  });
  return {
    batches: batches.map((b) => {
      const ids = new Set(links.filter((l) => l.courseId === b.courseId).map((l) => l.subjectId));
      return {
        id: b.id,
        name: b.name,
        subjects: subjects.filter((s) => ids.has(s.id)).map((s) => ({ id: s.id, name: s.name })),
      };
    }),
  };
}

// ---------------------------------------------------------------- ask

async function routeTeacher(batchId: number | null, subjectId: number | null) {
  if (!batchId) return null;
  const teachers = await batchTeacherRepo.findAll({
    where: { batchId },
    attributes: ['teacherUserId', 'subjectId'],
    order: [['id', 'ASC']],
  });
  const match = subjectId ? teachers.find((t) => t.subjectId === subjectId) : undefined;
  return (match ?? teachers[0])?.teacherUserId ?? null;
}

export async function askDoubt(input: AskDoubtInput, file?: UploadedFile): Promise<DoubtDetailDto> {
  const userId = me();
  let batchId: number | null = null;
  let subjectId: number | null = input.subjectId ?? null;
  let teacherUserId: number | null = null;
  let lectureId: number | null = null;
  let liveClassId: number | null = null;
  try {
    checkPhoto(file);
    const myBatches = await myActiveBatchIds(userId);
    if (input.liveClassId) {
      const live = await liveRepo.findOne({ where: { id: input.liveClassId } });
      if (!live || !myBatches.includes(live.batchId)) throw NotFound('Live class');
      liveClassId = live.id;
      batchId = live.batchId;
      subjectId = live.subjectId ?? subjectId;
      teacherUserId = live.teacherUserId;
    } else if (input.lectureId) {
      const lecture = await lectureRepo.findOne({ where: { id: input.lectureId } });
      if (!lecture) throw NotFound('Lecture');
      lectureId = lecture.id;
      subjectId = lecture.subjectId ?? subjectId;
      const linked = await lectureBatchRepo.findAll({
        where: { resourceId: lecture.id, batchId: { [Op.in]: myBatches.length ? myBatches : [0] } },
        attributes: ['batchId'],
      });
      if (linked.length) batchId = linked[0].batchId;
      else if (myBatches.length) {
        const sameCourse = await batchRepo.findOne({
          where: { id: { [Op.in]: myBatches }, courseId: lecture.courseId },
          attributes: ['id'],
        });
        batchId = sameCourse?.id ?? null;
      }
    } else if (input.batchId) {
      if (!myBatches.includes(input.batchId)) throw NotFound('Batch');
      batchId = input.batchId;
    } else if (myBatches.length) {
      batchId = myBatches[0];
    }
    if (subjectId && !(await subjectRepo.findOne({ where: { id: subjectId }, attributes: ['id'] })))
      throw NotFound('Subject');
    teacherUserId = teacherUserId ?? (await routeTeacher(batchId, subjectId));
  } catch (err) {
    await discard(file);
    throw err;
  }
  const batch = batchId
    ? await batchRepo.findOne({ where: { id: batchId }, attributes: ['branchId'] })
    : null;
  const branchId = batch?.branchId ?? null;
  const fileId = file ? await savePhoto(file, branchId) : null;
  const doubt = await anyDoubtRepo.create({
    branchId,
    studentUserId: userId,
    teacherUserId,
    batchId,
    subjectId,
    lectureId,
    positionSeconds: lectureId ? (input.positionSeconds ?? null) : null,
    liveClassId,
    question: input.question,
    fileId,
  });
  await audit({
    action: 'doubt.created',
    entityType: 'doubt',
    entityId: doubt.id,
    branchId,
    metadata: { batchId, subjectId, lectureId, liveClassId, teacherUserId, hasPhoto: !!fileId },
  });
  const full = await accessDoubt(doubt.id);
  const recipients = teacherUserId ? [teacherUserId] : batchId ? await myTeachingCandidates(batchId) : [];
  await notifyDoubtAsked({
    doubtId: doubt.id,
    branchId,
    teacherUserIds: recipients,
    student: full.doubt.student?.name ?? '',
    subject: full.doubt.subject?.name ?? null,
    question: doubt.question,
  });
  return detailDto(full);
}

async function myTeachingCandidates(batchId: number) {
  const rows = await batchTeacherRepo.findAll({ where: { batchId }, attributes: ['teacherUserId'] });
  return [...new Set(rows.map((r) => r.teacherUserId))];
}

// ---------------------------------------------------------------- detail and replies

async function detailDto(a: Access): Promise<DoubtDetailDto> {
  const replies = await replyRepo.findAll({
    where: { doubtId: a.doubt.id },
    include: [authorInclude()],
    order: [['id', 'ASC']],
  });
  const replyDtos: DoubtReplyDto[] = [];
  for (const r of replies) {
    replyDtos.push({
      id: r.id,
      author: userRef(r.author),
      fromTeacher: r.fromTeacher,
      body: r.body,
      photoUrl: await photoUrl(r.fileId),
      createdAt: r.createdAt.toISOString(),
    });
  }
  return {
    ...doubtDto(a.doubt),
    photoUrl: await photoUrl(a.doubt.fileId),
    replies: replyDtos,
    canAnswer: a.canAnswer,
    isMine: a.isMine,
  };
}

export async function getDoubt(id: number) {
  return detailDto(await accessDoubt(id));
}

export async function replyToDoubt(id: number, body: string | undefined, file?: UploadedFile) {
  let access: Access;
  try {
    access = await accessDoubt(id);
    if (!access.isMine && !access.canAnswer) throw Forbidden('You cannot reply to this doubt');
    if (access.doubt.status === 'resolved')
      throw Conflict('This doubt is resolved; ask a new doubt instead', 'DOUBT_RESOLVED');
    checkPhoto(file);
    if (!body?.trim() && !file) throw BadRequest('Write a reply or attach a photo');
  } catch (err) {
    await discard(file);
    throw err;
  }
  const { doubt, canAnswer } = access;
  const fromTeacher = canAnswer;
  const fileId = file ? await savePhoto(file, doubt.branchId) : null;
  const reply = await replyRepo.create({
    doubtId: doubt.id,
    authorUserId: me(),
    fromTeacher,
    body: body?.trim() || null,
    fileId,
  });
  const now = new Date();
  await doubt.update({
    replyCount: doubt.replyCount + 1,
    lastActivityAt: now,
    ...(fromTeacher
      ? {
          status: 'answered' as const,
          answeredAt: doubt.answeredAt ?? now,
          teacherUserId: doubt.teacherUserId ?? me(),
        }
      : { status: 'open' as const }),
  });
  await audit({
    action: 'doubt.replied',
    entityType: 'doubt',
    entityId: doubt.id,
    branchId: doubt.branchId,
    metadata: { replyId: reply.id, fromTeacher, hasPhoto: !!fileId },
  });
  const full = await accessDoubt(id);
  if (fromTeacher) {
    const author = await User.findByPk(me(), { attributes: ['id', 'name'] });
    await notifyDoubtAnswered({
      doubtId: doubt.id,
      branchId: doubt.branchId,
      studentUserId: doubt.studentUserId,
      teacher: author?.name ?? '',
      subject: full.doubt.subject?.name ?? null,
      question: doubt.question,
    });
  } else {
    const recipients = doubt.teacherUserId
      ? [doubt.teacherUserId]
      : doubt.batchId
        ? await myTeachingCandidates(doubt.batchId)
        : [];
    await notifyDoubtAsked({
      doubtId: doubt.id,
      branchId: doubt.branchId,
      teacherUserIds: recipients,
      student: full.doubt.student?.name ?? '',
      subject: full.doubt.subject?.name ?? null,
      question: body?.trim() || doubt.question,
    });
  }
  return detailDto(full);
}

export async function resolveDoubt(id: number) {
  const access = await accessDoubt(id);
  if (!access.isMine && !access.canAnswer) throw Forbidden('You cannot close this doubt');
  if (access.doubt.status !== 'resolved') {
    await access.doubt.update({ status: 'resolved', resolvedAt: new Date(), lastActivityAt: new Date() });
    await audit({
      action: 'doubt.resolved',
      entityType: 'doubt',
      entityId: id,
      branchId: access.doubt.branchId,
      metadata: { byStudent: access.isMine },
    });
  }
  return detailDto(await accessDoubt(id));
}
