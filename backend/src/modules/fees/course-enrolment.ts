/**
 * Online course purchases → admission and batch enrolment. When a purchase account (sourceRef
 * `purchase:…`, see `startCoursePurchase`) gains or loses its course entitlement, a job reconciles
 * it with admissions and academics: the paid student is admitted and enrolled in a batch (the one
 * chosen at checkout, else an open batch of the course with seats), or queued for an admin when no
 * batch can take them. Losing the entitlement (refund, reversal) takes them back out of the batch
 * the purchase put them in. The job reads the current state, so replays and retries are no-ops.
 */
import { Op, type Transaction } from 'sequelize';
import {
  COURSE_BATCH_ISSUE_LABELS,
  type CourseBatchOptionDto,
  type CourseEnrolmentDto,
  type FeeCourseEnrolmentStatus,
} from '@erp/shared';
import { getSequelize } from '../../infrastructure/database/sequelize';
import { enqueueJob } from '../../infrastructure/jobs/queue';
import { logger } from '../../infrastructure/logger';
import { requireTenantContext } from '../../shared/context';
import { Conflict } from '../../shared/errors';
import { TenantRepository } from '../../shared/tenancy/tenant-repository';
import { Batch, Course, openBatchesForCourse } from '../academics/api';
import { admitForCoursePurchase, releaseCoursePurchaseBatch } from '../admissions/api';
import { notify } from '../notifications/api';
import { Student } from '../students/api';
import { FeeAccount, FeeCourseEnrolment, FeeEntitlement } from './models';
import { auditFee, withLockRetry } from './util';

export const COURSE_ENROLMENT_JOB = 'fees.course-enrolment';
export const COURSE_ENROLMENT_PENDING_EVENT = 'fees.course-enrolment-pending';

export const courseEnrolmentRepo = new TenantRepository(FeeCourseEnrolment, {
  branchScoped: true,
  entity: 'Course enrolment',
});

/** Accounts opened by the online "buy course" checkout. */
export const isPurchaseAccount = (a: Pick<FeeAccount, 'courseId' | 'sourceRef'>) =>
  !!a.courseId && !!a.sourceRef?.startsWith('purchase:');

/**
 * Queues enrolment reconciliation for a purchase whose entitlement was granted or revoked. Runs in
 * the posting transaction, so the job exists exactly when the entitlement change commits.
 */
export async function queueCourseEnrolment(account: FeeAccount, transaction: Transaction): Promise<void> {
  if (!isPurchaseAccount(account)) return;
  await enqueueJob(
    COURSE_ENROLMENT_JOB,
    { accountId: account.id },
    { transaction, instituteId: account.instituteId },
  );
}

export async function courseEnrolmentJob(payload: Record<string, unknown>): Promise<void> {
  const accountId = Number(payload.accountId);
  if (!Number.isInteger(accountId) || accountId <= 0) return;
  await reconcileCourseEnrolment(accountId);
}

/**
 * Brings a purchase's admission and batch enrolment in line with its entitlement:
 * - entitled, not yet enrolled → admit and enroll (status `enrolled`), or queue for an admin
 *   (`awaiting_batch`, admins notified once per transition);
 * - not entitled → leave the batch the purchase added the student to and mark the row `revoked`.
 *
 * `assign` is an admin placing a queued (`awaiting_batch`) purchase in a specific batch; it fails
 * (instead of falling back to another batch) when that batch can't take the student.
 */
export async function reconcileCourseEnrolment(
  accountId: number,
  assign?: { batchId: number },
): Promise<FeeCourseEnrolment | null> {
  const { instituteId, userId } = requireTenantContext();
  return withLockRetry(() =>
    getSequelize().transaction(async (transaction) => {
      const account = await FeeAccount.findOne({
        where: { instituteId, id: accountId },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (!account || !isPurchaseAccount(account)) return null;
      const entitlement = await FeeEntitlement.findOne({
        where: { instituteId, accountId, revokedAt: null },
        attributes: ['id'],
        transaction,
      });
      const row = await FeeCourseEnrolment.findOne({
        where: { instituteId, accountId },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      const before = row?.status ?? null;
      if (assign && (before !== 'awaiting_batch' || !entitlement))
        throw Conflict('This course purchase is not waiting for a batch', 'NOT_AWAITING_BATCH');

      if (!entitlement) {
        if (!row || row.status === 'revoked') return row;
        let released = false;
        if (row.status === 'enrolled' && row.addedToBatch && row.batchId && row.studentUserId)
          released = await releaseCoursePurchaseBatch(
            {
              studentId: row.studentId,
              studentUserId: row.studentUserId,
              batchId: row.batchId,
              feeAccountId: account.id,
            },
            { transaction },
          );
        await row.update({ status: 'revoked', revokedAt: new Date() }, { transaction });
        afterCommit(transaction, row, 'revoked', { before, released });
        return row;
      }
      if (row?.status === 'enrolled') return row;

      const result = await admitForCoursePurchase(
        {
          studentId: account.studentId,
          courseId: account.courseId!,
          feeAccountId: account.id,
          batchId: assign ? assign.batchId : account.batchId,
          fallback: !assign,
        },
        { transaction },
      );
      const status: FeeCourseEnrolmentStatus = result.batchId ? 'enrolled' : 'awaiting_batch';
      const values = {
        branchId: result.branchId,
        studentId: account.studentId,
        studentUserId: result.studentUserId,
        courseId: account.courseId!,
        requestedBatchId: account.batchId,
        batchId: result.batchId,
        applicationId: result.applicationId,
        status,
        addedToBatch: result.addedToBatch,
        reason: result.batchIssue,
        enrolledAt: result.batchId ? new Date() : null,
        revokedAt: null,
        assignedByUserId: assign ? (userId ?? null) : null,
        ...(status === 'awaiting_batch' && before !== 'awaiting_batch' ? { notifiedAt: new Date() } : {}),
      };
      // A replay that still finds no batch changes nothing worth another audit entry.
      const unchanged =
        row?.status === status && row.batchId === values.batchId && row.reason === values.reason;
      const saved = row
        ? await row.update(values, { transaction })
        : await FeeCourseEnrolment.create({ instituteId, accountId: account.id, ...values }, { transaction });
      if (!unchanged)
        afterCommit(transaction, saved, assign ? 'assign' : status, {
          before,
          notifyAdmins: status === 'awaiting_batch' && before !== 'awaiting_batch',
        });
      return saved;
    }),
  );
}

/** Audit and (for a newly queued purchase) the admin notification, once the change commits. */
function afterCommit(
  transaction: Transaction,
  row: FeeCourseEnrolment,
  action: FeeCourseEnrolmentStatus | 'assign',
  extra: { before: FeeCourseEnrolmentStatus | null; released?: boolean; notifyAdmins?: boolean },
) {
  transaction.afterCommit(async () => {
    try {
      await auditFee({
        action: `fees.course_enrolment.${action}`,
        entityType: 'fee_course_enrolment',
        entityId: row.id,
        before: { status: extra.before },
        after: { status: row.status, batchId: row.batchId, reason: row.reason },
        metadata: {
          accountId: row.accountId,
          studentId: row.studentId,
          courseId: row.courseId,
          applicationId: row.applicationId,
          ...(extra.released !== undefined ? { leftBatch: extra.released } : {}),
        },
      });
      if (extra.notifyAdmins) await notifyAdminsOfQueuedPurchase(row);
    } catch (err) {
      logger.warn({ courseEnrolmentId: row.id, err }, 'Course enrolment follow-up failed');
    }
  });
}

async function notifyAdminsOfQueuedPurchase(row: FeeCourseEnrolment) {
  const [student, course] = await Promise.all([
    Student.findOne({ where: { instituteId: row.instituteId, id: row.studentId }, attributes: ['name'] }),
    Course.findOne({ where: { instituteId: row.instituteId, id: row.courseId }, attributes: ['name'] }),
  ]);
  await notify({
    event: COURSE_ENROLMENT_PENDING_EVENT,
    recipients: [{ role: 'institute-admin' }, { role: 'branch-admin', branchId: row.branchId }],
    branchId: row.branchId,
    data: {
      student: { id: row.studentId, name: student?.name ?? 'A student' },
      course: course?.name ?? 'a course',
      reason: row.reason ? COURSE_BATCH_ISSUE_LABELS[row.reason] : 'no batch was available',
      courseEnrolmentId: row.id,
    },
  });
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export async function courseEnrolmentDtos(rows: FeeCourseEnrolment[]): Promise<CourseEnrolmentDto[]> {
  if (!rows.length) return [];
  const { instituteId } = requireTenantContext();
  const ids = (pick: (r: FeeCourseEnrolment) => number | null) => [
    ...new Set(rows.map(pick).filter((id): id is number => !!id)),
  ];
  const batchIds = ids((r) => r.batchId).concat(ids((r) => r.requestedBatchId));
  const [students, courses, batches] = await Promise.all([
    Student.findAll({
      where: { instituteId, id: { [Op.in]: ids((r) => r.studentId) } },
      attributes: ['id', 'name', 'admissionNumber'],
    }),
    Course.findAll({
      where: { instituteId, id: { [Op.in]: ids((r) => r.courseId) } },
      attributes: ['id', 'name'],
    }),
    batchIds.length
      ? Batch.findAll({ where: { instituteId, id: { [Op.in]: batchIds } }, attributes: ['id', 'name'] })
      : [],
  ]);
  const student = new Map(students.map((s) => [s.id, s]));
  const course = new Map(courses.map((c) => [c.id, c.name]));
  const batch = new Map(batches.map((b) => [b.id, b.name]));
  return rows.map((r) => ({
    id: r.id,
    accountId: r.accountId,
    branchId: r.branchId,
    studentId: r.studentId,
    studentName: student.get(r.studentId)?.name ?? null,
    admissionNumber: student.get(r.studentId)?.admissionNumber ?? null,
    courseId: r.courseId,
    courseName: course.get(r.courseId) ?? null,
    status: r.status,
    requestedBatchId: r.requestedBatchId,
    requestedBatchName: r.requestedBatchId ? (batch.get(r.requestedBatchId) ?? null) : null,
    batchId: r.batchId,
    batchName: r.batchId ? (batch.get(r.batchId) ?? null) : null,
    applicationId: r.applicationId,
    reason: r.reason,
    enrolledAt: iso(r.enrolledAt),
    revokedAt: iso(r.revokedAt),
    createdAt: r.createdAt.toISOString(),
  }));
}

export const batchOptionDto = ({
  batch,
  seatsLeft,
}: {
  batch: Batch;
  seatsLeft: number;
}): CourseBatchOptionDto => ({
  id: batch.id,
  name: batch.name,
  startDate: batch.startDate,
  seatsLeft,
});

/** Batches an admin can place a queued purchase in: open batches of its course in its branch with free seats. */
export async function courseEnrolmentBatchOptions(row: FeeCourseEnrolment): Promise<CourseBatchOptionDto[]> {
  return (await openBatchesForCourse(row.courseId, row.branchId)).map(batchOptionDto);
}
