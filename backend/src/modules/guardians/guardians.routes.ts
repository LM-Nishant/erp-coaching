import { Router } from 'express';
import { Op } from 'sequelize';
import { z } from 'zod';
import type { ChildSummaryDto } from '@erp/shared';
import { parse } from '../../shared/utilities/validation';
import { idParam, paginated, paginationSchema, toLimitOffset } from '../../shared/utilities/pagination';
import { authenticate } from '../../shared/middleware/authenticate';
import { requireModule, requirePermission, requireTenant } from '../../shared/middleware/authorize';
import { requireTenantContext } from '../../shared/context';
import { NotFound } from '../../shared/errors';
import { Branch } from '../branches/branch.model';
import { Student } from '../students/models';
import { buildProfile, guardianRelationSchema, guardiansOf, studentRepo } from '../students/students.service';
import { Guardian, StudentGuardian } from './models';
import { assertGuardianOf } from './guardian-access';
import {
  guardianInputSchema,
  linkGuardian,
  toGuardianDto,
  toLinkDto,
  unlink,
  updateLink,
} from './guardians.service';

const linkParams = z.object({
  id: z.coerce.number().int().positive(),
  linkId: z.coerce.number().int().positive(),
});

const linkPatch = z
  .object({
    status: z.enum(['active', 'pending', 'revoked']).optional(),
    relation: guardianRelationSchema.optional(),
    isPrimary: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');

export function guardianRoutes(api: Router) {
  // ---- staff: guardians of a student (access to the student is branch-checked by studentRepo)
  const s = Router();
  s.use(authenticate, requireTenant, requireModule('students'));

  s.get('/:id/guardians', requirePermission('guardians', 'view'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    await studentRepo.findById(id);
    res.json(await guardiansOf(id));
  });

  s.post('/:id/guardians', requirePermission('guardians', 'create'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    const body = parse(guardianInputSchema, req.body);
    const student = await studentRepo.findById(id);
    const { link, guardian } = await linkGuardian(student, body);
    res.status(201).json(toLinkDto(link, guardian));
  });

  s.patch('/:id/guardians/:linkId', requirePermission('guardians', 'edit'), async (req, res) => {
    const { id, linkId } = parse(linkParams, req.params);
    const body = parse(linkPatch, req.body);
    const student = await studentRepo.findById(id);
    const link = await updateLink(student, linkId, body);
    res.json(toLinkDto(link, link.guardian!));
  });

  s.delete('/:id/guardians/:linkId', requirePermission('guardians', 'delete'), async (req, res) => {
    const { id, linkId } = parse(linkParams, req.params);
    await unlink(await studentRepo.findById(id), linkId);
    res.status(204).end();
  });

  api.use('/students', s);

  // ---- staff: guardian directory
  const g = Router();
  g.use(authenticate, requireTenant, requireModule('students'));

  /** Guardians with at least one child in the user's allowed branches. */
  async function visibleGuardianIds(): Promise<number[] | null> {
    const { instituteId, allowedBranchIds, activeBranchId } = requireTenantContext();
    const branches = activeBranchId ? [activeBranchId] : allowedBranchIds;
    if (branches === null) return null;
    const links = await StudentGuardian.findAll({
      where: { instituteId },
      include: [
        { model: Student, as: 'student', attributes: [], where: { branchId: { [Op.in]: branches } } },
      ],
      attributes: ['guardianId'],
    });
    return [...new Set(links.map((l) => l.guardianId))];
  }

  g.get('/', requirePermission('guardians', 'view'), async (req, res) => {
    const q = parse(
      paginationSchema.extend({ status: z.enum(['active', 'pending', 'revoked']).optional() }),
      req.query,
    );
    const { instituteId } = requireTenantContext();
    const visible = await visibleGuardianIds();
    const where: Record<string | symbol, unknown> = { instituteId };
    if (visible) where.id = { [Op.in]: visible };
    if (q.search) {
      const like = `%${q.search}%`;
      where[Op.or] = [
        { name: { [Op.like]: like } },
        { mobile: { [Op.like]: like } },
        { email: { [Op.like]: like } },
      ];
    }
    const { rows, count } = await Guardian.findAndCountAll({
      where,
      include: [
        {
          model: StudentGuardian,
          as: 'links',
          ...(q.status ? { where: { status: q.status }, required: true } : { required: false }),
        },
      ],
      distinct: true,
      order: [['name', 'ASC']],
      ...toLimitOffset(q),
    });
    const studentIds = [...new Set(rows.flatMap((r) => (r.links ?? []).map((l) => l.studentId)))];
    const students = studentIds.length
      ? await Student.findAll({
          where: { instituteId, id: { [Op.in]: studentIds } },
          attributes: ['id', 'name'],
        })
      : [];
    const names = new Map(students.map((st) => [st.id, st.name]));
    res.json(
      paginated(
        rows.map((r) => toGuardianDto(r, names)),
        count,
        q,
      ),
    );
  });

  g.get('/:id', requirePermission('guardians', 'view'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    const { instituteId } = requireTenantContext();
    const visible = await visibleGuardianIds();
    if (visible && !visible.includes(id)) throw NotFound('Guardian');
    const guardian = await Guardian.findOne({
      where: { instituteId, id },
      include: [{ model: StudentGuardian, as: 'links' }],
    });
    if (!guardian) throw NotFound('Guardian');
    const ids = (guardian.links ?? []).map((l) => l.studentId);
    const students = ids.length
      ? await Student.findAll({ where: { instituteId, id: { [Op.in]: ids } }, attributes: ['id', 'name'] })
      : [];
    res.json(toGuardianDto(guardian, new Map(students.map((st) => [st.id, st.name]))));
  });

  g.patch('/:id', requirePermission('guardians', 'edit'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    const body = parse(
      guardianInputSchema.pick({ name: true, email: true, occupation: true, address: true }).partial(),
      req.body,
    );
    const { instituteId } = requireTenantContext();
    const visible = await visibleGuardianIds();
    if (visible && !visible.includes(id)) throw NotFound('Guardian');
    const guardian = await Guardian.findOne({ where: { instituteId, id } });
    if (!guardian) throw NotFound('Guardian');
    await guardian.update(body);
    res.json({
      id: guardian.id,
      name: guardian.name,
      email: guardian.email,
      occupation: guardian.occupation,
      address: guardian.address,
    });
  });

  api.use('/guardians', g);

  // ---- parent self-service: only actively linked children are visible
  const p = Router();
  p.use(authenticate, requireTenant);

  p.get('/children', requirePermission('guardian-portal', 'view'), async (_req, res) => {
    const { instituteId, userId } = requireTenantContext();
    const guardian = userId ? await Guardian.findOne({ where: { instituteId, userId } }) : null;
    if (!guardian) {
      res.json([]);
      return;
    }
    const links = await StudentGuardian.findAll({
      where: { instituteId, guardianId: guardian.id, status: 'active' },
      include: [{ model: Student, as: 'student' }],
    });
    const branchIds = [...new Set(links.map((l) => l.student!.branchId))];
    const branches = branchIds.length
      ? await Branch.findAll({
          where: { instituteId, id: { [Op.in]: branchIds } },
          attributes: ['id', 'name'],
        })
      : [];
    const branchNames = new Map(branches.map((b) => [b.id, b.name]));
    const children: ChildSummaryDto[] = links.map((l) => ({
      studentId: l.studentId,
      name: l.student!.name,
      admissionNumber: l.student!.admissionNumber,
      rollNumber: l.student!.rollNumber ?? null,
      branchId: l.student!.branchId,
      branchName: branchNames.get(l.student!.branchId) ?? null,
      status: l.student!.status,
      relation: l.relation,
      isPrimary: l.isPrimary,
    }));
    res.json(children);
  });

  p.get('/children/:id', requirePermission('guardian-portal', 'view'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    await assertGuardianOf(id);
    const { instituteId } = requireTenantContext();
    const student = await Student.findOne({ where: { instituteId, id } });
    if (!student) throw NotFound('Student');
    const profile = await buildProfile(student);
    res.json({ ...profile, history: [] });
  });

  api.use('/guardian-portal', p);
}
