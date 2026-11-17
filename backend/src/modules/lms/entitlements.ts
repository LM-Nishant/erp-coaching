import { Op } from 'sequelize';
import { Batch, BatchStudent } from '../academics/api';
import { LmsAccessGrant } from './models';

/** Whether a student may open paid content of a course, and for how long. */
export interface CourseEntitlement {
  entitled: boolean;
  /** Start of access; `accessDays` of time-limited resources count from here. */
  since: Date | null;
  /** End of access (null = lifetime / open-ended). */
  until: Date | null;
  /** Who granted it, e.g. `batch`, `fees`, `manual`. */
  source: string;
}

export interface EntitlementQuery {
  instituteId: number;
  /** Login user id of the student (academics rosters key students by user id). */
  studentUserId: number;
  courseId: number;
}

/**
 * Extension point for the module that sells courses (fees). Register it from the provider's
 * `integrations.ts` in `onReady`:
 *
 *   import { setCourseEntitlementProvider } from '../lms/api';
 *   setCourseEntitlementProvider({
 *     hasCourseEntitlement: async (q, batchDefault) => { ...paid/unpaid logic, may call batchDefault(q) },
 *     listEntitledCourseIds: async ({ instituteId, studentUserId }) => [...courses bought outside a batch],
 *   });
 *
 * Without a provider, access follows active batch enrolment (`batchEnrolmentEntitlement`). Manual
 * grants (`lms_access_grants`) always add access on top of whatever the provider decides.
 */
export interface CourseEntitlementProvider {
  hasCourseEntitlement(
    query: EntitlementQuery,
    batchDefault: (q: EntitlementQuery) => Promise<CourseEntitlement>,
  ): Promise<CourseEntitlement>;
  /** Extra courses to list in a learner's library (e.g. bought without a batch). */
  listEntitledCourseIds?(query: { instituteId: number; studentUserId: number }): Promise<number[]>;
}

let provider: CourseEntitlementProvider | null = null;

export function setCourseEntitlementProvider(p: CourseEntitlementProvider | null): void {
  provider = p;
}

const NONE: CourseEntitlement = { entitled: false, since: null, until: null, source: 'none' };

/** Default rule: an active enrolment in any batch of the course grants open-ended access. */
export async function batchEnrolmentEntitlement(q: EntitlementQuery): Promise<CourseEntitlement> {
  const rows = await BatchStudent.findAll({
    where: { instituteId: q.instituteId, studentUserId: q.studentUserId, status: 'active' },
    include: [
      {
        model: Batch,
        as: 'batch',
        where: { instituteId: q.instituteId, courseId: q.courseId },
        attributes: ['id'],
      },
    ],
    attributes: ['joinedOn'],
  });
  if (!rows.length) return NONE;
  const since = rows.map((r) => new Date(r.joinedOn)).sort((a, b) => a.getTime() - b.getTime())[0];
  return { entitled: true, since, until: null, source: 'batch' };
}

async function activeGrant(q: EntitlementQuery, now: Date): Promise<LmsAccessGrant | null> {
  return LmsAccessGrant.findOne({
    where: {
      instituteId: q.instituteId,
      studentUserId: q.studentUserId,
      courseId: q.courseId,
      revokedAt: null,
      validFrom: { [Op.lte]: now },
      [Op.or]: [{ validUntil: null }, { validUntil: { [Op.gt]: now } }],
    },
    order: [['validUntil', 'DESC']],
  });
}

const later = (a: Date | null, b: Date | null) => (a === null || b === null ? null : a > b ? a : b);
const earlier = (a: Date | null, b: Date | null) => (!a ? b : !b ? a : a < b ? a : b);

export async function resolveCourseEntitlement(
  q: EntitlementQuery,
  now = new Date(),
): Promise<CourseEntitlement> {
  let base = provider
    ? await provider.hasCourseEntitlement(q, batchEnrolmentEntitlement)
    : await batchEnrolmentEntitlement(q);
  if (base.entitled && base.until && base.until <= now) base = { ...base, entitled: false };
  const grant = await activeGrant(q, now);
  if (!grant) return base;
  if (!base.entitled)
    return { entitled: true, since: grant.validFrom, until: grant.validUntil, source: grant.source };
  return {
    entitled: true,
    since: earlier(base.since, grant.validFrom),
    until: later(base.until, grant.validUntil),
    source: base.source,
  };
}

/** Courses a learner's library lists: batch courses, active grants and provider extras. */
export async function listLearnerCourseIds(instituteId: number, studentUserId: number): Promise<number[]> {
  const now = new Date();
  const ids = new Set<number>();
  const enrolments = await BatchStudent.findAll({
    where: { instituteId, studentUserId, status: 'active' },
    include: [{ model: Batch, as: 'batch', attributes: ['courseId'] }],
  });
  enrolments.forEach((e) => e.batch && ids.add(e.batch.courseId));
  const grants = await LmsAccessGrant.findAll({
    where: {
      instituteId,
      studentUserId,
      revokedAt: null,
      [Op.or]: [{ validUntil: null }, { validUntil: { [Op.gt]: now } }],
    },
    attributes: ['courseId'],
  });
  grants.forEach((g) => ids.add(g.courseId));
  if (provider?.listEntitledCourseIds)
    (await provider.listEntitledCourseIds({ instituteId, studentUserId })).forEach((id) => ids.add(id));
  return [...ids];
}

/** Active batch ids of a student (for batch-restricted resources and homework). */
export async function activeBatchIds(instituteId: number, studentUserId: number): Promise<number[]> {
  const rows = await BatchStudent.findAll({
    where: { instituteId, studentUserId, status: 'active' },
    attributes: ['batchId'],
  });
  return [...new Set(rows.map((r) => r.batchId))];
}
