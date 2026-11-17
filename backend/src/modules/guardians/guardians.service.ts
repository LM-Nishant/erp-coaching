import type { Transaction } from 'sequelize';
import { Op } from 'sequelize';
import { z } from 'zod';
import type { GuardianDto, GuardianLinkStatus, StudentGuardianDto } from '@erp/shared';
import { getSequelize } from '../../infrastructure/database/sequelize';
import { requireTenantContext } from '../../shared/context';
import { BadRequest, Conflict, NotFound } from '../../shared/errors';
import { audit } from '../../shared/audit/audit.service';
import { parse } from '../../shared/utilities/validation';
import { Student } from '../students/models';
import {
  findOrCreateUser,
  guardianRelationSchema,
  mobileSchema,
  recordHistory,
} from '../students/students.service';
import { getStudentSettings } from '../students/settings';
import { Guardian, StudentGuardian } from './models';
import { syncParentRoles } from './guardian-access';

export const guardianInputSchema = z.object({
  name: z.string().trim().min(2).max(150),
  mobile: mobileSchema,
  email: z.string().trim().toLowerCase().email().max(150).nullable().optional(),
  relation: guardianRelationSchema.default('guardian'),
  isPrimary: z.boolean().optional(),
  occupation: z.string().trim().max(100).nullable().optional(),
  address: z.string().trim().max(1000).nullable().optional(),
});
export type GuardianInput = z.input<typeof guardianInputSchema>;

export function toLinkDto(link: StudentGuardian, guardian: Guardian): StudentGuardianDto {
  return {
    linkId: link.id,
    guardianId: guardian.id,
    userId: guardian.userId,
    name: guardian.name,
    mobile: guardian.mobile,
    email: guardian.email ?? null,
    relation: link.relation,
    isPrimary: link.isPrimary,
    status: link.status,
  };
}

export function toGuardianDto(g: Guardian, students: Map<number, string>): GuardianDto {
  return {
    id: g.id,
    userId: g.userId,
    name: g.name,
    mobile: g.mobile,
    email: g.email ?? null,
    occupation: g.occupation ?? null,
    address: g.address ?? null,
    children: (g.links ?? []).map((l) => ({
      linkId: l.id,
      studentId: l.studentId,
      name: students.get(l.studentId) ?? '',
      relation: l.relation,
      status: l.status,
    })),
  };
}

async function assertBelowMax(studentId: number, transaction?: Transaction) {
  const { instituteId } = requireTenantContext();
  const { maxGuardiansPerStudent } = await getStudentSettings();
  const count = await StudentGuardian.count({
    where: { instituteId, studentId, status: { [Op.in]: ['active', 'pending'] } },
    transaction,
  });
  if (count >= maxGuardiansPerStudent)
    throw Conflict(
      `A student can have at most ${maxGuardiansPerStudent} guardians`,
      'GUARDIAN_LIMIT_REACHED',
      { max: maxGuardiansPerStudent },
    );
}

async function setPrimary(studentId: number, linkId: number, transaction?: Transaction) {
  const { instituteId } = requireTenantContext();
  await StudentGuardian.update(
    { isPrimary: false },
    { where: { instituteId, studentId, id: { [Op.ne]: linkId } }, transaction },
  );
}

/**
 * Creates (or reuses) the guardian's user account and profile and links it to the student.
 * One guardian account can be linked to many children; a student can have up to the configured
 * maximum. Active links grant the branch-scoped Parent role. The caller must have checked access
 * to the student.
 */
export async function linkGuardian(
  student: Student,
  raw: GuardianInput,
  opts: { status?: GuardianLinkStatus; transaction?: Transaction } = {},
): Promise<{ link: StudentGuardian; guardian: Guardian; userCreated: boolean }> {
  const input = parse(guardianInputSchema, raw);
  const run = async (transaction: Transaction) => {
    const { instituteId } = requireTenantContext();
    const { user, created } = await findOrCreateUser(
      { name: input.name, mobile: input.mobile, email: input.email ?? null },
      transaction,
    );
    if (student.userId && user.id === student.userId)
      throw BadRequest('A student cannot be their own guardian');
    let guardian = await Guardian.findOne({ where: { instituteId, userId: user.id }, transaction });
    if (!guardian) {
      guardian = await Guardian.create(
        {
          instituteId,
          userId: user.id,
          name: input.name,
          mobile: user.mobile,
          email: input.email ?? user.email ?? null,
          occupation: input.occupation ?? null,
          address: input.address ?? null,
        },
        { transaction },
      );
    }
    const status = opts.status ?? 'active';
    let link = await StudentGuardian.findOne({
      where: { instituteId, studentId: student.id, guardianId: guardian.id },
      transaction,
    });
    if (link && link.status !== 'revoked')
      throw Conflict('Guardian is already linked to this student', 'ALREADY_LINKED');
    await assertBelowMax(student.id, transaction);
    const isFirst = !(await StudentGuardian.count({
      where: { instituteId, studentId: student.id, status: 'active' },
      transaction,
    }));
    const isPrimary = input.isPrimary ?? (isFirst && status === 'active');
    if (link) await link.update({ status, relation: input.relation, isPrimary }, { transaction });
    else
      link = await StudentGuardian.create(
        {
          instituteId,
          studentId: student.id,
          guardianId: guardian.id,
          relation: input.relation,
          isPrimary,
          status,
        },
        { transaction },
      );
    if (isPrimary) await setPrimary(student.id, link.id, transaction);
    await syncParentRoles(guardian.id, transaction);
    await recordHistory(
      student.id,
      'guardian_linked',
      { to: guardian.name, details: { guardianId: guardian.id, relation: input.relation, status } },
      transaction,
    );
    return { link, guardian, userCreated: created };
  };
  const result = opts.transaction ? await run(opts.transaction) : await getSequelize().transaction(run);
  await audit({
    action: 'guardian.linked',
    entityType: 'student',
    entityId: student.id,
    metadata: { guardianId: result.guardian.id, linkId: result.link.id, status: result.link.status },
  });
  return result;
}

export async function findLink(studentId: number, linkId: number) {
  const { instituteId } = requireTenantContext();
  const link = await StudentGuardian.findOne({
    where: { instituteId, studentId, id: linkId },
    include: [{ model: Guardian, as: 'guardian' }],
  });
  if (!link) throw NotFound('Guardian link');
  return link;
}

export async function updateLink(
  student: Student,
  linkId: number,
  patch: { status?: GuardianLinkStatus; relation?: StudentGuardian['relation']; isPrimary?: boolean },
) {
  const link = await findLink(student.id, linkId);
  const before = { status: link.status, relation: link.relation, isPrimary: link.isPrimary };
  await getSequelize().transaction(async (transaction) => {
    if (patch.status === 'active' && link.status !== 'active') {
      // Approving / re-activating counts against the limit (pending links already count).
      if (link.status === 'revoked') await assertBelowMax(student.id, transaction);
    }
    await link.update(
      { ...patch, ...(patch.status === 'revoked' ? { isPrimary: false } : {}) },
      { transaction },
    );
    if (link.isPrimary) await setPrimary(student.id, link.id, transaction);
    await syncParentRoles(link.guardianId, transaction);
    if (patch.status && patch.status !== before.status)
      await recordHistory(
        student.id,
        patch.status === 'revoked' ? 'guardian_revoked' : 'guardian_status_changed',
        { from: before.status, to: patch.status, details: { guardianId: link.guardianId } },
        transaction,
      );
  });
  await audit({
    action: 'guardian.link_updated',
    entityType: 'student',
    entityId: student.id,
    metadata: { linkId, before, after: patch },
  });
  return link;
}

export async function unlink(student: Student, linkId: number) {
  const link = await findLink(student.id, linkId);
  await getSequelize().transaction(async (transaction) => {
    await link.destroy({ transaction });
    await syncParentRoles(link.guardianId, transaction);
    await recordHistory(
      student.id,
      'guardian_removed',
      { from: link.guardian?.name ?? null, details: { guardianId: link.guardianId } },
      transaction,
    );
  });
  await audit({
    action: 'guardian.unlinked',
    entityType: 'student',
    entityId: student.id,
    metadata: { linkId, guardianId: link.guardianId },
  });
}
