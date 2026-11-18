import { Op, type Transaction } from 'sequelize';
import { requireTenantContext } from '../../shared/context';
import { Student } from '../students/models';
import { queueCourseEnrolment } from './course-enrolment';
import { FeeAccount, FeeEntitlement, type FeeInstalment } from './models';
import { getFeeSettings } from './settings.service';

/**
 * Grants course/subject access once the first N instalments (setting
 * `entitlementAfterInstalment`) are fully paid; revokes it again if a refund/cancellation
 * leaves them unpaid. Runs inside posting transactions; a change on an online course purchase also
 * queues its admission and batch enrolment (`course-enrolment.ts`).
 */
export async function evaluateEntitlement(
  account: FeeAccount,
  instalments: FeeInstalment[],
  transaction: Transaction,
) {
  if (!account.courseId && !account.subjectId) return;
  const settings = await getFeeSettings();
  const n = Math.max(1, settings.entitlementAfterInstalment);
  const required = instalments.filter((i) => i.seq <= n);
  const satisfied = account.status === 'active' && required.every((i) => i.balance <= 0);
  const existing = await FeeEntitlement.findOne({
    where: { instituteId: account.instituteId, accountId: account.id },
    transaction,
    lock: transaction.LOCK.UPDATE,
  });
  if (satisfied) {
    if (existing && !existing.revokedAt) return;
    if (!existing)
      await FeeEntitlement.create(
        {
          instituteId: account.instituteId,
          studentId: account.studentId,
          studentUserId: account.studentUserId,
          courseId: account.courseId,
          subjectId: account.subjectId,
          accountId: account.id,
          grantedAt: new Date(),
          revokedAt: null,
        },
        { transaction },
      );
    else await existing.update({ revokedAt: null, grantedAt: new Date() }, { transaction });
  } else if (existing && !existing.revokedAt) {
    await existing.update({ revokedAt: new Date() }, { transaction });
  } else return;
  // A bought course also admits the student and enrolls them in a batch (or takes them out again).
  await queueCourseEnrolment(account, transaction);
}

async function studentIdsForUser(instituteId: number, studentUserId: number) {
  const rows = await Student.findAll({ where: { instituteId, userId: studentUserId }, attributes: ['id'] });
  return rows.map((r) => r.id);
}

/** The student's active (not revoked) paid entitlement for a course, if any. */
export async function activeCourseEntitlement(
  instituteId: number,
  studentUserId: number,
  courseId: number,
): Promise<FeeEntitlement | null> {
  const studentIds = await studentIdsForUser(instituteId, studentUserId);
  return FeeEntitlement.findOne({
    where: {
      instituteId,
      courseId,
      revokedAt: null,
      [Op.or]: [{ studentUserId }, ...(studentIds.length ? [{ studentId: { [Op.in]: studentIds } }] : [])],
    },
    order: [['grantedAt', 'ASC']],
  });
}

/** True when the student (login user id, as used by rosters) has paid for the course. */
export async function hasCourseEntitlement(studentUserId: number, courseId: number): Promise<boolean> {
  const { instituteId } = requireTenantContext();
  return !!(await activeCourseEntitlement(instituteId, studentUserId, courseId));
}

/** True when the student has paid for a separately purchasable subject. */
export async function hasSubjectEntitlement(studentUserId: number, subjectId: number): Promise<boolean> {
  const { instituteId } = requireTenantContext();
  const studentIds = await studentIdsForUser(instituteId, studentUserId);
  const row = await FeeEntitlement.findOne({
    where: {
      instituteId,
      subjectId,
      revokedAt: null,
      [Op.or]: [{ studentUserId }, ...(studentIds.length ? [{ studentId: { [Op.in]: studentIds } }] : [])],
    },
    attributes: ['id'],
  });
  return !!row;
}

/** Course ids the student is entitled to (for LMS catalogue filtering). */
export async function entitledCourseIds(
  studentUserId: number,
  instituteId = requireTenantContext().instituteId,
): Promise<number[]> {
  const studentIds = await studentIdsForUser(instituteId, studentUserId);
  const rows = await FeeEntitlement.findAll({
    where: {
      instituteId,
      courseId: { [Op.ne]: null },
      revokedAt: null,
      [Op.or]: [{ studentUserId }, ...(studentIds.length ? [{ studentId: { [Op.in]: studentIds } }] : [])],
    },
    attributes: ['courseId'],
  });
  return [...new Set(rows.map((r) => r.courseId!))];
}
