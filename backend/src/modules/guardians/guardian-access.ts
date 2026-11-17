import type { Transaction } from 'sequelize';
import { requireTenantContext } from '../../shared/context';
import { NotFound } from '../../shared/errors';
import { Student } from '../students/models';
import { syncBranchRoles } from '../students/membership';
import { Guardian, StudentGuardian } from './models';

/**
 * Student ids the signed-in user is an *active* guardian of in the current institute.
 * Pending/revoked links grant nothing.
 */
export async function linkedStudentIds(userId = requireTenantContext().userId): Promise<number[]> {
  const { instituteId } = requireTenantContext();
  if (!userId) return [];
  const guardian = await Guardian.findOne({ where: { instituteId, userId } });
  if (!guardian) return [];
  const links = await StudentGuardian.findAll({
    where: { instituteId, guardianId: guardian.id, status: 'active' },
    attributes: ['studentId'],
  });
  return links.map((l) => l.studentId);
}

/** True when the signed-in user is an active guardian of the student. */
export async function isGuardianOf(studentId: number): Promise<boolean> {
  return (await linkedStudentIds()).includes(studentId);
}

/**
 * Reusable guard for other modules (fees, attendance, results…): throws 404 unless the signed-in
 * user is an active guardian of `studentId`. 404 (not 403) so unlinked ids are indistinguishable
 * from ids that don't exist.
 */
export async function assertGuardianOf(studentId: number): Promise<void> {
  if (!(await isGuardianOf(studentId))) throw NotFound('Student');
}

/**
 * Keeps a guardian's Parent role in line with the branches of their actively linked children
 * (one branch-scoped assignment per branch). Call after linking, approving, revoking or transferring.
 */
export async function syncParentRoles(guardianId: number, transaction?: Transaction): Promise<void> {
  const { instituteId } = requireTenantContext();
  const guardian = await Guardian.findOne({ where: { instituteId, id: guardianId }, transaction });
  if (!guardian) return;
  const links = await StudentGuardian.findAll({
    where: { instituteId, guardianId, status: 'active' },
    include: [{ model: Student, as: 'student', attributes: ['id', 'branchId'] }],
    transaction,
  });
  const branchIds = [...new Set(links.map((l) => l.student!.branchId))];
  await syncBranchRoles(guardian.userId, 'parent', branchIds, transaction);
}

export async function syncParentRolesForStudent(studentId: number, transaction?: Transaction): Promise<void> {
  const { instituteId } = requireTenantContext();
  const links = await StudentGuardian.findAll({ where: { instituteId, studentId }, transaction });
  for (const guardianId of new Set(links.map((l) => l.guardianId)))
    await syncParentRoles(guardianId, transaction);
}

// ---------------------------------------------------------------- integration helpers
// Plain lookups for other modules (notification recipient resolvers, grievance parent links…).
// `instituteId` defaults to the current tenant so they also work from jobs with an explicit id.

/** User ids of the student's active guardians (for "notify parents"). */
export async function getGuardianUserIds(
  studentId: number,
  instituteId = requireTenantContext().instituteId,
): Promise<number[]> {
  const links = await StudentGuardian.findAll({
    where: { instituteId, studentId, status: 'active' },
    include: [{ model: Guardian, as: 'guardian', attributes: ['userId'] }],
  });
  return [...new Set(links.map((l) => l.guardian!.userId))];
}

/** Login user id of a student, or null when the student has no account of their own. */
export async function getStudentUserId(
  studentId: number,
  instituteId = requireTenantContext().instituteId,
): Promise<number | null> {
  const s = await Student.findOne({ where: { instituteId, id: studentId }, attributes: ['userId'] });
  return s?.userId ?? null;
}

/** Students a parent user is actively linked to. */
export async function getLinkedStudents(
  parentUserId: number,
  instituteId = requireTenantContext().instituteId,
): Promise<{ id: number; name: string }[]> {
  const guardian = await Guardian.findOne({ where: { instituteId, userId: parentUserId } });
  if (!guardian) return [];
  const links = await StudentGuardian.findAll({
    where: { instituteId, guardianId: guardian.id, status: 'active' },
    include: [{ model: Student, as: 'student', attributes: ['id', 'name'] }],
  });
  return links.map((l) => ({ id: l.student!.id, name: l.student!.name }));
}
