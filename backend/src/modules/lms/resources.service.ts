import crypto from 'node:crypto';
import { Op, type WhereOptions } from 'sequelize';
import type {
  LmsAccessType,
  LmsCourseContentsDto,
  LmsGrantDto,
  LmsLearnerResourceDto,
  LmsLibraryCourseDto,
  LmsOfflineLicenseDto,
  LmsOfflineLicenseSummary,
  LmsPlaybackDto,
  LmsProgressDto,
  LmsResourceAnalyticsRow,
  LmsResourceDto,
  LmsResourceType,
} from '@erp/shared';
import { config } from '../../infrastructure/config';
import { decryptSecret, encryptSecret } from '../../infrastructure/crypto';
import { enqueueJob } from '../../infrastructure/jobs/queue';
import { getSequelize } from '../../infrastructure/database/sequelize';
import { hasPermission, requireTenantContext } from '../../shared/context';
import { BadRequest, Conflict, Forbidden, NotFound } from '../../shared/errors';
import { TenantRepository } from '../../shared/tenancy/tenant-repository';
import { audit } from '../../shared/audit/audit.service';
import { Batch, BatchStudent, Chapter, Course, CourseSubject, Subject, Topic } from '../academics/api';
import { Device } from '../authentication/models';
import { FileObject } from '../files/file.model';
import { fileRepo, signedUrlFor } from '../files/files.service';
import { UserRole } from '../permissions/models';
import { User } from '../users/user.model';
import {
  activeBatchIds,
  listLearnerCourseIds,
  resolveCourseEntitlement,
  type CourseEntitlement,
} from './entitlements';
import { LmsAccessGrant, LmsOfflineLicense, LmsProgress, LmsResource, LmsResourceBatch } from './models';
import { playbackTtlSeconds, signStreamToken } from './stream-token';
import { fileRef } from './uploads.service';
import { removeRendition } from './transcode.job';

export const resourceRepo = new TenantRepository(LmsResource, {
  entity: 'Resource',
  branchScoped: true,
  instituteWideRows: true,
});
const grantRepo = new TenantRepository(LmsAccessGrant, { entity: 'Access grant' });

/** Seconds of a single progress report that count as watched (guards against inflated reports). */
const MAX_WATCH_DELTA = 120;
const COMPLETE_AT_PERCENT = 90;
export const MAX_ACTIVE_OFFLINE_LICENSES = 25;
const OFFLINE_DOWNLOAD_URL_TTL = 3600;
const NATIVE_PLATFORMS = new Set(['android', 'ios']);

export const isStaff = () => hasPermission('lms.edit');

const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);
const minDate = (...ds: (Date | null)[]) =>
  ds.filter((d): d is Date => !!d).sort((a, b) => a.getTime() - b.getTime())[0] ?? null;

// ---------------------------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------------------------

const resourceInclude = [
  { model: FileObject, as: 'file' },
  { model: LmsResourceBatch, as: 'batchLinks', attributes: ['batchId'] },
  { model: Course, as: 'course', attributes: ['id', 'name'] },
];

export function toResourceDto(r: LmsResource): LmsResourceDto {
  return {
    id: r.id,
    courseId: r.courseId,
    courseName: r.course?.name,
    subjectId: r.subjectId,
    chapterId: r.chapterId,
    topicId: r.topicId,
    branchId: r.branchId,
    batchIds: (r.batchLinks ?? []).map((b) => b.batchId),
    title: r.title,
    description: r.description,
    type: r.type,
    status: r.status,
    access: r.access,
    accessDays: r.accessDays,
    availableFrom: iso(r.availableFrom),
    availableUntil: iso(r.availableUntil),
    downloadable: r.downloadable,
    offlineAllowed: r.offlineAllowed,
    offlineExpiryHours: r.offlineExpiryHours,
    durationSeconds: r.durationSeconds,
    sortOrder: r.sortOrder,
    externalUrl: r.externalUrl,
    file: r.file ? fileRef(r.file) : null,
    transcodeStatus: r.transcodeStatus,
    publishedAt: iso(r.publishedAt),
    createdAt: iso(r.createdAt)!,
  };
}

function toProgressDto(p: LmsProgress | null | undefined): LmsProgressDto | null {
  if (!p) return null;
  return {
    positionSeconds: p.positionSeconds,
    durationSeconds: p.durationSeconds,
    watchedSeconds: p.watchedSeconds,
    percent: p.percent,
    completed: !!p.completedAt,
    completedAt: iso(p.completedAt),
    lastViewedAt: iso(p.lastViewedAt),
  };
}

// ---------------------------------------------------------------------------------------------
// Staff: content management
// ---------------------------------------------------------------------------------------------

export interface ResourceWriteInput {
  courseId: number;
  subjectId?: number | null;
  chapterId?: number | null;
  topicId?: number | null;
  branchId?: number | null;
  batchIds?: number[];
  title: string;
  description?: string | null;
  type: LmsResourceType;
  fileId?: number | null;
  externalUrl?: string | null;
  durationSeconds?: number | null;
  access?: LmsAccessType;
  accessDays?: number | null;
  availableFrom?: Date | null;
  availableUntil?: Date | null;
  downloadable?: boolean;
  offlineAllowed?: boolean;
  offlineExpiryHours?: number;
  sortOrder?: number;
}

/** Validates that the taxonomy chain belongs to this institute and is internally consistent. */
async function assertTaxonomy(v: ResourceWriteInput, instituteId: number) {
  const course = await Course.findOne({ where: { instituteId, id: v.courseId } });
  if (!course) throw BadRequest('Unknown course');
  let subjectId = v.subjectId ?? null;
  let chapterId = v.chapterId ?? null;
  if (v.topicId) {
    const topic = await Topic.findOne({ where: { instituteId, id: v.topicId } });
    if (!topic) throw BadRequest('Unknown topic');
    if (chapterId && chapterId !== topic.chapterId) throw BadRequest('Topic is not in this chapter');
    chapterId = topic.chapterId;
  }
  if (chapterId) {
    const chapter = await Chapter.findOne({ where: { instituteId, id: chapterId } });
    if (!chapter) throw BadRequest('Unknown chapter');
    if (subjectId && subjectId !== chapter.subjectId) throw BadRequest('Chapter is not in this subject');
    subjectId = chapter.subjectId;
  }
  if (subjectId) {
    const subject = await Subject.findOne({ where: { instituteId, id: subjectId } });
    if (!subject) throw BadRequest('Unknown subject');
    const linked = await CourseSubject.count({ where: { instituteId, courseId: v.courseId } });
    if (linked && !(await CourseSubject.count({ where: { instituteId, courseId: v.courseId, subjectId } })))
      throw BadRequest('Subject is not part of this course');
  }
  if (v.batchIds?.length) {
    const ok = await Batch.count({
      where: { instituteId, courseId: v.courseId, id: [...new Set(v.batchIds)] },
    });
    if (ok !== new Set(v.batchIds).size) throw BadRequest('Every batch must belong to the course');
  }
  return { subjectId, chapterId, topicId: v.topicId ?? null };
}

async function assertContent(v: ResourceWriteInput) {
  if (v.type === 'link') {
    if (!v.externalUrl) throw BadRequest('A link resource needs an externalUrl');
    return null;
  }
  if (!v.fileId) return null; // a draft may be saved before its upload completes
  const file = await fileRepo.findById(v.fileId);
  if (v.type === 'video' && !file.mimeType.startsWith('video/'))
    throw BadRequest('A video resource needs a video file');
  return file;
}

function maybeQueueTranscode(r: LmsResource, previousFileId: number | null) {
  if (r.type !== 'video' || !r.fileId || r.fileId === previousFileId) return null;
  return enqueueJob('lms.transcode', { resourceId: r.id });
}

export async function listResources(q: {
  page: number;
  pageSize: number;
  search?: string;
  courseId?: number;
  subjectId?: number;
  chapterId?: number;
  topicId?: number;
  type?: LmsResourceType;
  status?: string;
}) {
  const where: WhereOptions = {};
  for (const k of ['courseId', 'subjectId', 'chapterId', 'topicId', 'type', 'status'] as const)
    if (q[k] !== undefined) Object.assign(where, { [k]: q[k] });
  if (q.search) Object.assign(where, { title: { [Op.like]: `%${q.search}%` } });
  const { rows, count } = await resourceRepo.findAndCountAll({
    where,
    include: resourceInclude,
    order: [
      ['sortOrder', 'ASC'],
      ['id', 'DESC'],
    ],
    limit: q.pageSize,
    offset: (q.page - 1) * q.pageSize,
    // count parents, not joined hasMany rows
    ...({ distinct: true } as object),
  });
  return { items: rows.map(toResourceDto), total: count, page: q.page, pageSize: q.pageSize };
}

export async function getResource(id: number) {
  return toResourceDto(await resourceRepo.findById(id, { include: resourceInclude }));
}

export async function createResource(v: ResourceWriteInput) {
  const { instituteId, userId } = requireTenantContext();
  const tax = await assertTaxonomy(v, instituteId);
  await assertContent(v);
  const r = await getSequelize().transaction(async (transaction) => {
    const row = await resourceRepo.create(
      {
        branchId: v.branchId ?? null,
        courseId: v.courseId,
        ...tax,
        title: v.title,
        description: v.description ?? null,
        type: v.type,
        fileId: v.type === 'link' ? null : (v.fileId ?? null),
        externalUrl: v.type === 'link' ? v.externalUrl! : null,
        durationSeconds: v.durationSeconds ?? null,
        access: v.access ?? 'paid',
        accessDays: v.accessDays ?? null,
        availableFrom: v.availableFrom ?? null,
        availableUntil: v.availableUntil ?? null,
        downloadable: v.type === 'video' ? false : (v.downloadable ?? false),
        offlineAllowed: v.type === 'video' ? (v.offlineAllowed ?? false) : false,
        offlineExpiryHours: v.offlineExpiryHours ?? 72,
        sortOrder: v.sortOrder ?? 0,
        createdByUserId: userId,
      },
      { transaction },
    );
    if (v.batchIds?.length)
      await LmsResourceBatch.bulkCreate(
        [...new Set(v.batchIds)].map((batchId) => ({ instituteId, resourceId: row.id, batchId })),
        { transaction },
      );
    return row;
  });
  await maybeQueueTranscode(r, null);
  await audit({ action: 'lms.resource.created', entityType: 'lms_resource', entityId: r.id });
  return getResource(r.id);
}

export async function updateResource(id: number, patch: Partial<ResourceWriteInput>) {
  const { instituteId } = requireTenantContext();
  const r = await resourceRepo.findById(id, { include: resourceInclude });
  resourceRepo.assertRowWritable(r);
  const merged: ResourceWriteInput = {
    ...toResourceDto(r),
    fileId: r.fileId,
    availableFrom: r.availableFrom,
    availableUntil: r.availableUntil,
    batchIds: (r.batchLinks ?? []).map((b) => b.batchId),
    ...patch,
  };
  const tax = await assertTaxonomy(merged, instituteId);
  await assertContent(merged);
  if (patch.branchId !== undefined) resourceRepo.assertBranchAllowed(patch.branchId);
  const previousFileId = r.fileId;
  const fileChanged = merged.type !== 'link' && (merged.fileId ?? null) !== previousFileId;
  await getSequelize().transaction(async (transaction) => {
    await r.update(
      {
        branchId: merged.branchId ?? null,
        courseId: merged.courseId,
        ...tax,
        title: merged.title,
        description: merged.description ?? null,
        type: merged.type,
        fileId: merged.type === 'link' ? null : (merged.fileId ?? null),
        externalUrl: merged.type === 'link' ? (merged.externalUrl ?? null) : null,
        durationSeconds: merged.durationSeconds ?? null,
        access: merged.access ?? r.access,
        accessDays: merged.accessDays ?? null,
        availableFrom: merged.availableFrom ?? null,
        availableUntil: merged.availableUntil ?? null,
        downloadable: merged.type === 'video' ? false : !!merged.downloadable,
        offlineAllowed: merged.type === 'video' ? !!merged.offlineAllowed : false,
        offlineExpiryHours: merged.offlineExpiryHours ?? r.offlineExpiryHours,
        sortOrder: merged.sortOrder ?? r.sortOrder,
        ...(fileChanged ? { transcodeStatus: 'none' as const, hlsPrefix: null, transcodeError: null } : {}),
      },
      { transaction },
    );
    if (patch.batchIds) {
      await LmsResourceBatch.destroy({ where: { instituteId, resourceId: r.id }, transaction });
      if (patch.batchIds.length)
        await LmsResourceBatch.bulkCreate(
          [...new Set(patch.batchIds)].map((batchId) => ({ instituteId, resourceId: r.id, batchId })),
          { transaction },
        );
    }
  });
  if (fileChanged) await maybeQueueTranscode(r, previousFileId);
  await audit({
    action: 'lms.resource.updated',
    entityType: 'lms_resource',
    entityId: r.id,
    metadata: { fields: Object.keys(patch) },
  });
  return getResource(r.id);
}

export async function setResourceStatus(id: number, status: 'published' | 'draft' | 'archived') {
  const r = await resourceRepo.findById(id);
  resourceRepo.assertRowWritable(r);
  if (status === 'published' && r.type !== 'link' && !r.fileId)
    throw Conflict('Attach the file before publishing', 'FILE_REQUIRED');
  await r.update({
    status,
    ...(status === 'published' && !r.publishedAt ? { publishedAt: new Date() } : {}),
  });
  await audit({ action: `lms.resource.${status}`, entityType: 'lms_resource', entityId: r.id });
  return getResource(r.id);
}

export async function deleteResource(id: number) {
  const { instituteId } = requireTenantContext();
  const r = await resourceRepo.findById(id);
  resourceRepo.assertRowWritable(r);
  await getSequelize().transaction(async (transaction) => {
    for (const M of [LmsResourceBatch, LmsProgress, LmsOfflineLicense] as const)
      await (M as typeof LmsResourceBatch).destroy({ where: { instituteId, resourceId: r.id }, transaction });
    await r.destroy({ transaction });
  });
  await removeRendition(r.hlsPrefix);
  await audit({ action: 'lms.resource.deleted', entityType: 'lms_resource', entityId: id });
}

export async function requestTranscode(id: number) {
  const r = await resourceRepo.findById(id);
  resourceRepo.assertRowWritable(r);
  if (r.type !== 'video' || !r.fileId) throw Conflict('Only uploaded videos can be transcoded', 'NOT_VIDEO');
  await r.update({ transcodeStatus: 'pending', transcodeError: null });
  await enqueueJob('lms.transcode', { resourceId: r.id });
  return getResource(r.id);
}

/** Per-student progress on one resource, for every active student of the batches it targets. */
export async function resourceAnalytics(id: number): Promise<LmsResourceAnalyticsRow[]> {
  const { instituteId } = requireTenantContext();
  const r = await resourceRepo.findById(id, { include: resourceInclude });
  const restricted = (r.batchLinks ?? []).map((b) => b.batchId);
  const batches = await Batch.findAll({
    where: { instituteId, courseId: r.courseId, ...(restricted.length ? { id: restricted } : {}) },
    attributes: ['id'],
  });
  const members = await BatchStudent.findAll({
    where: { instituteId, batchId: batches.map((b) => b.id), status: 'active' },
    include: [{ model: User, as: 'student', attributes: ['id', 'name'] }],
  });
  const progress = await LmsProgress.findAll({ where: { instituteId, resourceId: r.id } });
  const byUser = new Map(progress.map((p) => [p.studentUserId, p]));
  const seen = new Set<number>();
  return members
    .filter((m) => m.student && !seen.has(m.studentUserId) && seen.add(m.studentUserId))
    .map((m) => {
      const p = byUser.get(m.studentUserId);
      return {
        student: { id: m.student!.id, name: m.student!.name },
        percent: p?.percent ?? 0,
        watchedSeconds: p?.watchedSeconds ?? 0,
        completed: !!p?.completedAt,
        lastViewedAt: iso(p?.lastViewedAt),
      };
    })
    .sort((a, b) => a.student.name.localeCompare(b.student.name));
}

// ---------------------------------------------------------------------------------------------
// Learner access evaluation
// ---------------------------------------------------------------------------------------------

interface LearnerScope {
  instituteId: number;
  studentUserId: number;
  batchIds: Set<number>;
  entitlements: Map<number, CourseEntitlement>;
  now: Date;
}

async function learnerScope(instituteId: number, studentUserId: number): Promise<LearnerScope> {
  return {
    instituteId,
    studentUserId,
    batchIds: new Set(await activeBatchIds(instituteId, studentUserId)),
    entitlements: new Map(),
    now: new Date(),
  };
}

async function entitlementFor(s: LearnerScope, courseId: number) {
  let e = s.entitlements.get(courseId);
  if (!e) {
    e = await resolveCourseEntitlement(
      { instituteId: s.instituteId, studentUserId: s.studentUserId, courseId },
      s.now,
    );
    s.entitlements.set(courseId, e);
  }
  return e;
}

/** Batch-restricted resources are invisible to learners outside those batches. */
function visibleTo(r: LmsResource, s: LearnerScope) {
  const links = r.batchLinks ?? [];
  return !links.length || links.some((l) => s.batchIds.has(l.batchId));
}

export interface AccessVerdict {
  locked: boolean;
  lockReason: LmsLearnerResourceDto['lockReason'];
  accessUntil: Date | null;
}

/**
 * Free resources open for anyone who can see them; paid ones need a course entitlement. `accessDays`
 * counts from the start of the entitlement and is capped by its end and the availability window.
 */
export function evaluateAccess(r: LmsResource, e: CourseEntitlement, now: Date): AccessVerdict {
  if (r.availableFrom && r.availableFrom > now)
    return { locked: true, lockReason: 'not-yet-available', accessUntil: null };
  if (r.access === 'paid' && !e.entitled)
    return { locked: true, lockReason: 'not-entitled', accessUntil: null };
  const byDays =
    r.accessDays && e.since ? new Date(new Date(e.since).getTime() + r.accessDays * 86400_000) : null;
  const accessUntil = minDate(byDays, r.access === 'paid' ? e.until : null, r.availableUntil);
  if (accessUntil && accessUntil <= now) return { locked: true, lockReason: 'expired', accessUntil };
  return { locked: false, lockReason: null, accessUntil };
}

async function toLearnerDto(
  r: LmsResource,
  s: LearnerScope,
  progress: LmsProgress | null | undefined,
): Promise<LmsLearnerResourceDto> {
  const v = evaluateAccess(r, await entitlementFor(s, r.courseId), s.now);
  const dto = toResourceDto(r);
  return {
    ...dto,
    // learners never get file ids/urls from listings; playback goes through /play
    file: dto.file ? { ...dto.file, id: 0 } : null,
    externalUrl: v.locked ? null : dto.externalUrl,
    locked: v.locked,
    lockReason: v.lockReason,
    accessUntil: iso(v.accessUntil),
    progress: toProgressDto(progress),
  };
}

const publishedWhere = (now: Date): WhereOptions => ({
  status: 'published',
  [Op.or]: [
    { availableUntil: null },
    { availableUntil: { [Op.gt]: new Date(now.getTime() - 30 * 86400_000) } },
  ],
});

async function visibleResources(s: LearnerScope, courseIds: number[]) {
  if (!courseIds.length) return [];
  const rows = await resourceRepo.findAll({
    where: { ...publishedWhere(s.now), courseId: courseIds },
    include: resourceInclude,
    order: [
      ['sortOrder', 'ASC'],
      ['id', 'ASC'],
    ],
  });
  return rows.filter((r) => visibleTo(r, s));
}

async function progressMap(s: LearnerScope, resourceIds: number[]) {
  if (!resourceIds.length) return new Map<number, LmsProgress>();
  const rows = await LmsProgress.findAll({
    where: { instituteId: s.instituteId, studentUserId: s.studentUserId, resourceId: resourceIds },
  });
  return new Map(rows.map((p) => [p.resourceId, p]));
}

/** Courses a learner can browse: enrolled/entitled ones plus any course with free content they see. */
async function libraryCourseIds(s: LearnerScope) {
  const ids = new Set(await listLearnerCourseIds(s.instituteId, s.studentUserId));
  const free = await resourceRepo.findAll({
    where: { ...publishedWhere(s.now), access: 'free' },
    include: [{ model: LmsResourceBatch, as: 'batchLinks', attributes: ['batchId'] }],
    attributes: ['id', 'courseId'],
  });
  free.filter((r) => visibleTo(r, s)).forEach((r) => ids.add(r.courseId));
  return [...ids];
}

export async function learnerLibrary(studentUserId?: number): Promise<LmsLibraryCourseDto[]> {
  const ctx = requireTenantContext();
  const s = await learnerScope(ctx.instituteId, studentUserId ?? ctx.userId!);
  const courseIds = await libraryCourseIds(s);
  if (!courseIds.length) return [];
  const courses = await Course.findAll({ where: { instituteId: s.instituteId, id: courseIds } });
  const resources = await visibleResources(s, courseIds);
  const progress = await progressMap(
    s,
    resources.map((r) => r.id),
  );
  const out: LmsLibraryCourseDto[] = [];
  for (const c of courses) {
    const e = await entitlementFor(s, c.id);
    const mine = resources.filter((r) => r.courseId === c.id);
    const completed = mine.filter((r) => progress.get(r.id)?.completedAt).length;
    out.push({
      id: c.id,
      name: c.name,
      code: c.code,
      entitled: e.entitled,
      entitlementUntil: iso(e.until),
      resourceCount: mine.length,
      completedCount: completed,
      percent: mine.length ? Math.round((completed / mine.length) * 100) : 0,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export async function courseContents(
  courseId: number,
  studentUserId?: number,
): Promise<LmsCourseContentsDto> {
  const ctx = requireTenantContext();
  const s = await learnerScope(ctx.instituteId, studentUserId ?? ctx.userId!);
  const course = await Course.findOne({ where: { instituteId: s.instituteId, id: courseId } });
  if (!course || !(await libraryCourseIds(s)).includes(courseId)) throw NotFound('Course');
  const resources = await visibleResources(s, [courseId]);
  const progress = await progressMap(
    s,
    resources.map((r) => r.id),
  );
  const dtos = await Promise.all(resources.map((r) => toLearnerDto(r, s, progress.get(r.id))));
  const e = await entitlementFor(s, courseId);

  const subjectIds = [...new Set(dtos.map((d) => d.subjectId).filter((x): x is number => !!x))];
  const chapterIds = [...new Set(dtos.map((d) => d.chapterId).filter((x): x is number => !!x))];
  const topicIds = [...new Set(dtos.map((d) => d.topicId).filter((x): x is number => !!x))];
  const [subjects, chapters, topics, order] = await Promise.all([
    subjectIds.length ? Subject.findAll({ where: { instituteId: s.instituteId, id: subjectIds } }) : [],
    chapterIds.length ? Chapter.findAll({ where: { instituteId: s.instituteId, id: chapterIds } }) : [],
    topicIds.length ? Topic.findAll({ where: { instituteId: s.instituteId, id: topicIds } }) : [],
    CourseSubject.findAll({ where: { instituteId: s.instituteId, courseId } }),
  ]);
  const subjectOrder = new Map(order.map((o) => [o.subjectId, o.sortOrder]));
  const bySort = <T extends { sortOrder?: number; id: number }>(a: T, b: T) =>
    (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.id - b.id;

  const tree = subjects
    .map((sub) => ({ id: sub.id, name: sub.name, sortOrder: subjectOrder.get(sub.id) ?? 0 }))
    .sort(bySort)
    .map((sub) => ({
      id: sub.id,
      name: sub.name,
      resources: dtos.filter((d) => d.subjectId === sub.id && !d.chapterId),
      chapters: chapters
        .filter((ch) => ch.subjectId === sub.id)
        .sort(bySort)
        .map((ch) => ({
          id: ch.id,
          name: ch.name,
          resources: dtos.filter((d) => d.chapterId === ch.id && !d.topicId),
          topics: topics
            .filter((t) => t.chapterId === ch.id)
            .sort(bySort)
            .map((t) => ({ id: t.id, name: t.name, resources: dtos.filter((d) => d.topicId === t.id) })),
        })),
    }));
  const completed = dtos.filter((d) => d.progress?.completed).length;
  return {
    course: { id: course.id, name: course.name, code: course.code },
    entitled: e.entitled,
    entitlementUntil: iso(e.until),
    subjects: tree,
    resources: dtos.filter((d) => !d.subjectId),
    stats: {
      total: dtos.length,
      completed,
      percent: dtos.length ? Math.round((completed / dtos.length) * 100) : 0,
    },
  };
}

/** Loads a published resource the current learner can see, with its access verdict. */
async function learnerResource(id: number) {
  const ctx = requireTenantContext();
  const s = await learnerScope(ctx.instituteId, ctx.userId!);
  const r = await resourceRepo.findOne({ where: { id, status: 'published' }, include: resourceInclude });
  if (!r || !visibleTo(r, s)) throw NotFound('Resource');
  const verdict = evaluateAccess(r, await entitlementFor(s, r.courseId), s.now);
  return { r, s, verdict };
}

export async function learnerResourceDetail(id: number) {
  const { r, s } = await learnerResource(id);
  const progress = await LmsProgress.findOne({
    where: { instituteId: s.instituteId, resourceId: r.id, studentUserId: s.studentUserId },
  });
  return toLearnerDto(r, s, progress);
}

function assertUnlocked(v: AccessVerdict) {
  if (!v.locked) return;
  const messages = {
    'not-entitled': 'This content is part of a paid course you are not enrolled in',
    expired: 'Your access to this content has expired',
    'not-yet-available': 'This content is not available yet',
  } as const;
  throw Forbidden(messages[v.lockReason!], `LMS_${v.lockReason!.toUpperCase().replace(/-/g, '_')}`);
}

async function watermarkText(userId: number) {
  const u = await User.findByPk(userId, { attributes: ['name', 'mobile'] });
  return [u?.name, u?.mobile].filter(Boolean).join(' · ');
}

/**
 * Issues a short-lived playback link. Staff may preview anything they can manage (drafts included);
 * learners need an unlocked, published resource. Videos stream as HLS once transcoded, otherwise as
 * progressive MP4 (signed file URL with Range support). `prefer: 'mp4'` serves clients without HLS.
 */
export async function play(id: number, prefer?: 'hls' | 'mp4'): Promise<LmsPlaybackDto> {
  const ctx = requireTenantContext();
  let r: LmsResource;
  let progress: LmsProgress | null = null;
  if (isStaff()) {
    r = await resourceRepo.findById(id, { include: resourceInclude });
  } else {
    const l = await learnerResource(id);
    assertUnlocked(l.verdict);
    r = l.r;
    [progress] = await LmsProgress.findOrCreate({
      where: { instituteId: ctx.instituteId, resourceId: r.id, studentUserId: ctx.userId! },
      defaults: {
        instituteId: ctx.instituteId,
        resourceId: r.id,
        studentUserId: ctx.userId!,
        durationSeconds: r.durationSeconds,
      },
    });
    await progress.update({ lastViewedAt: new Date() });
  }
  const base = {
    resourceId: r.id,
    watermark: { text: await watermarkText(ctx.userId!) },
    resumeAtSeconds: progress && !progress.completedAt ? progress.positionSeconds : 0,
    downloadable: r.type !== 'video' && r.downloadable,
    offlineAllowed: r.type === 'video' && r.offlineAllowed,
  };
  if (r.type === 'link')
    return { ...base, kind: 'link', url: r.externalUrl!, mimeType: null, expiresAt: null };
  if (!r.file) throw Conflict('This resource has no file yet', 'FILE_REQUIRED');
  const ttl = playbackTtlSeconds(r.durationSeconds);
  if (r.type === 'video' && r.transcodeStatus === 'ready' && r.hlsPrefix && prefer !== 'mp4') {
    const { token, expiresAt } = signStreamToken(r.id, ctx.instituteId, ctx.userId!, ttl);
    return {
      ...base,
      kind: 'hls',
      url: `${config.API_PUBLIC_URL}/api/lms/public/hls/${token}/index.m3u8`,
      mimeType: 'application/vnd.apple.mpegurl',
      expiresAt: expiresAt.toISOString(),
    };
  }
  const signed = signedUrlFor(r.file, r.type === 'video' ? ttl : undefined);
  return {
    ...base,
    kind: r.type === 'video' ? 'mp4' : 'file',
    url: signed.url,
    mimeType: r.file.mimeType,
    expiresAt: signed.expiresAt.toISOString(),
  };
}

/** Notes/documents marked downloadable. Videos are never downloadable (offline copies use licenses). */
export async function downloadLink(id: number) {
  const r = isStaff()
    ? await resourceRepo.findById(id, { include: resourceInclude })
    : await learnerResource(id).then((l) => (assertUnlocked(l.verdict), l.r));
  if (r.type === 'video' || r.type === 'link' || !r.file || (!isStaff() && !r.downloadable))
    throw Forbidden('This resource cannot be downloaded', 'LMS_NOT_DOWNLOADABLE');
  const { url, expiresAt } = signedUrlFor(r.file);
  await audit({ action: 'lms.resource.downloaded', entityType: 'lms_resource', entityId: r.id });
  return { url, expiresAt: expiresAt.toISOString(), fileName: r.file.originalName };
}

export async function recordProgress(
  id: number,
  input: {
    positionSeconds: number;
    durationSeconds?: number | null;
    watchedDeltaSeconds?: number;
    completed?: boolean;
  },
): Promise<LmsProgressDto> {
  const ctx = requireTenantContext();
  const { r, verdict } = await learnerResource(id);
  assertUnlocked(verdict);
  return getSequelize().transaction(async (transaction) => {
    const [p] = await LmsProgress.findOrCreate({
      where: { instituteId: ctx.instituteId, resourceId: r.id, studentUserId: ctx.userId! },
      defaults: {
        instituteId: ctx.instituteId,
        resourceId: r.id,
        studentUserId: ctx.userId!,
        durationSeconds: r.durationSeconds,
      },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    const duration = r.durationSeconds ?? input.durationSeconds ?? p.durationSeconds ?? null;
    const position = Math.max(0, Math.min(input.positionSeconds, duration ?? input.positionSeconds));
    const delta = Math.max(0, Math.min(input.watchedDeltaSeconds ?? 0, MAX_WATCH_DELTA));
    const watched = duration ? Math.min(p.watchedSeconds + delta, duration) : p.watchedSeconds + delta;
    let percent = p.percent;
    if (r.type === 'video')
      percent = duration ? Math.max(percent, Math.round((watched / duration) * 100)) : percent;
    const isDone =
      !!p.completedAt ||
      (r.type === 'video' ? percent >= COMPLETE_AT_PERCENT : !!input.completed) ||
      (r.type !== 'video' && percent >= 100);
    if (isDone) percent = Math.max(percent, r.type === 'video' ? percent : 100);
    await p.update(
      {
        positionSeconds: Math.round(position),
        durationSeconds: duration,
        watchedSeconds: Math.round(watched),
        percent: Math.min(100, percent),
        lastViewedAt: new Date(),
        completedAt: p.completedAt ?? (isDone ? new Date() : null),
      },
      { transaction },
    );
    return toProgressDto(p)!;
  });
}

// ---------------------------------------------------------------------------------------------
// Offline (mobile app only)
// ---------------------------------------------------------------------------------------------

async function assertNativeDevice() {
  const { deviceId, userId } = requireTenantContext();
  const device = deviceId ? await Device.findOne({ where: { id: deviceId, userId: userId! } }) : null;
  if (!device || device.status !== 'active' || !NATIVE_PLATFORMS.has((device.platform ?? '').toLowerCase()))
    throw Forbidden('Offline downloads are only available in the mobile app', 'LMS_OFFLINE_APP_ONLY');
  return device;
}

/**
 * Issues an offline licence: a per-download AES key the app uses to encrypt its private copy, plus a
 * one-hour signed source URL. The copy stops playing at `expiresAt` (licence hours, capped by access).
 */
export async function issueOfflineLicense(id: number): Promise<LmsOfflineLicenseDto> {
  const ctx = requireTenantContext();
  const device = await assertNativeDevice();
  const { r, verdict } = await learnerResource(id);
  assertUnlocked(verdict);
  if (r.type !== 'video' || !r.offlineAllowed || !r.file)
    throw Forbidden('This video cannot be saved offline', 'LMS_OFFLINE_NOT_ALLOWED');
  const now = new Date();
  const active = await LmsOfflineLicense.count({
    where: {
      instituteId: ctx.instituteId,
      userId: ctx.userId!,
      revokedAt: null,
      expiresAt: { [Op.gt]: now },
      resourceId: { [Op.ne]: r.id },
    },
  });
  if (active >= MAX_ACTIVE_OFFLINE_LICENSES)
    throw Conflict('Remove some offline videos before saving more', 'LMS_OFFLINE_LIMIT', {
      limit: MAX_ACTIVE_OFFLINE_LICENSES,
    });
  await LmsOfflineLicense.update(
    { revokedAt: now },
    {
      where: {
        instituteId: ctx.instituteId,
        userId: ctx.userId!,
        deviceId: device.id,
        resourceId: r.id,
        revokedAt: null,
      },
    },
  );
  const key = crypto.randomBytes(32).toString('base64');
  const expiresAt = minDate(new Date(now.getTime() + r.offlineExpiryHours * 3600_000), verdict.accessUntil)!;
  const lic = await LmsOfflineLicense.create({
    instituteId: ctx.instituteId,
    resourceId: r.id,
    userId: ctx.userId!,
    deviceId: device.id,
    contentKey: encryptSecret(key),
    expiresAt,
  });
  const signed = signedUrlFor(r.file, OFFLINE_DOWNLOAD_URL_TTL);
  await audit({
    action: 'lms.offline.issued',
    entityType: 'lms_resource',
    entityId: r.id,
    metadata: { deviceId: device.id, expiresAt: expiresAt.toISOString() },
  });
  return {
    id: lic.id,
    resourceId: r.id,
    title: r.title,
    downloadUrl: signed.url,
    downloadUrlExpiresAt: signed.expiresAt.toISOString(),
    contentKey: key,
    expiresAt: expiresAt.toISOString(),
    mimeType: r.file.mimeType,
    sizeBytes: Number(r.file.sizeBytes),
    watermark: { text: await watermarkText(ctx.userId!) },
  };
}

/**
 * Licences of this device. Licences whose content is no longer accessible are revoked here, so the
 * app deletes the copies on its next sync. The key is returned again for still-valid licences
 * (needed to decrypt for playback after an app restart; the app never stores it on disk).
 */
export async function listOfflineLicenses(): Promise<
  (LmsOfflineLicenseSummary & { contentKey: string | null })[]
> {
  const ctx = requireTenantContext();
  const device = await assertNativeDevice();
  const rows = await LmsOfflineLicense.findAll({
    where: { instituteId: ctx.instituteId, userId: ctx.userId!, deviceId: device.id },
    include: [{ model: LmsResource, as: 'resource', include: resourceInclude }],
    order: [['id', 'DESC']],
  });
  const s = await learnerScope(ctx.instituteId, ctx.userId!);
  const out = [];
  for (const l of rows) {
    const r = l.resource;
    let valid = !l.revokedAt && l.expiresAt > s.now && !!r && r.status === 'published' && r.offlineAllowed;
    if (valid && r)
      valid = visibleTo(r, s) && !evaluateAccess(r, await entitlementFor(s, r.courseId), s.now).locked;
    if (!valid && !l.revokedAt && l.expiresAt > s.now) await l.update({ revokedAt: s.now });
    out.push({
      id: l.id,
      resourceId: l.resourceId,
      title: r?.title ?? '',
      expiresAt: l.expiresAt.toISOString(),
      revokedAt: iso(l.revokedAt),
      createdAt: l.createdAt.toISOString(),
      contentKey: valid ? decryptSecret(l.contentKey) : null,
    });
  }
  return out;
}

export async function revokeOfflineLicense(id: number) {
  const ctx = requireTenantContext();
  const l = await LmsOfflineLicense.findOne({
    where: { instituteId: ctx.instituteId, id, userId: ctx.userId! },
  });
  if (!l) throw NotFound('Offline licence');
  if (!l.revokedAt) await l.update({ revokedAt: new Date() });
}

// ---------------------------------------------------------------------------------------------
// Manual access grants (scholarships, trials, offline payments)
// ---------------------------------------------------------------------------------------------

function toGrantDto(g: LmsAccessGrant): LmsGrantDto {
  return {
    id: g.id,
    studentUserId: g.studentUserId,
    studentName: g.student?.name ?? null,
    courseId: g.courseId,
    courseName: g.course?.name ?? null,
    validFrom: g.validFrom.toISOString(),
    validUntil: iso(g.validUntil),
    source: g.source,
    note: g.note,
    createdAt: g.createdAt.toISOString(),
  };
}

const grantInclude = [
  { model: User, as: 'student', attributes: ['id', 'name'] },
  { model: Course, as: 'course', attributes: ['id', 'name'] },
];

export async function listGrants(q: {
  page: number;
  pageSize: number;
  courseId?: number;
  studentUserId?: number;
}) {
  const where: WhereOptions = { revokedAt: null };
  if (q.courseId) Object.assign(where, { courseId: q.courseId });
  if (q.studentUserId) Object.assign(where, { studentUserId: q.studentUserId });
  const { rows, count } = await grantRepo.findAndCountAll({
    where,
    include: grantInclude,
    order: [['id', 'DESC']],
    limit: q.pageSize,
    offset: (q.page - 1) * q.pageSize,
  });
  return { items: rows.map(toGrantDto), total: count, page: q.page, pageSize: q.pageSize };
}

export async function createGrant(v: {
  studentUserId: number;
  courseId: number;
  validUntil?: Date | null;
  note?: string | null;
}) {
  const { instituteId, userId } = requireTenantContext();
  if (!(await Course.count({ where: { instituteId, id: v.courseId } }))) throw BadRequest('Unknown course');
  if (!(await UserRole.count({ where: { instituteId, userId: v.studentUserId } })))
    throw BadRequest('Unknown student');
  if (v.validUntil && v.validUntil <= new Date()) throw BadRequest('validUntil must be in the future');
  const g = await grantRepo.create({
    studentUserId: v.studentUserId,
    courseId: v.courseId,
    validFrom: new Date(),
    validUntil: v.validUntil ?? null,
    source: 'manual',
    note: v.note ?? null,
    grantedByUserId: userId,
  });
  await audit({
    action: 'lms.access.granted',
    entityType: 'lms_access_grant',
    entityId: g.id,
    metadata: { studentUserId: v.studentUserId, courseId: v.courseId, validUntil: iso(v.validUntil) },
  });
  return toGrantDto((await grantRepo.findById(g.id, { include: grantInclude }))!);
}

export async function revokeGrant(id: number) {
  const g = await grantRepo.findById(id);
  if (!g.revokedAt) await g.update({ revokedAt: new Date() });
  await audit({ action: 'lms.access.revoked', entityType: 'lms_access_grant', entityId: id });
}
