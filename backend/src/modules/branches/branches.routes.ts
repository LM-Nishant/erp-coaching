import { Router } from 'express';
import { Op } from 'sequelize';
import { z } from 'zod';
import { parse } from '../../shared/utilities/validation';
import { idParam } from '../../shared/utilities/pagination';
import { authenticate } from '../../shared/middleware/authenticate';
import { requirePermission, requireTenant } from '../../shared/middleware/authorize';
import { hasPermission, requireTenantContext } from '../../shared/context';
import { TenantRepository } from '../../shared/tenancy/tenant-repository';
import { BadRequest, Conflict, Forbidden } from '../../shared/errors';
import { audit } from '../../shared/audit/audit.service';
import { assertWithinLimit } from '../subscriptions/subscription.service';
import { Branch } from './branch.model';
import { branchClosureBlockers } from './api';

/** Reference implementation of a tenant-scoped CRUD module. Copy this pattern. */
export const branchRepo = new TenantRepository(Branch, { entity: 'Branch' });

const branchBody = z.object({
  name: z.string().trim().min(2).max(150),
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9-]{2,30}$/),
  address: z.string().max(1000).nullable().optional(),
  city: z.string().max(80).nullable().optional(),
  phone: z.string().max(20).nullable().optional(),
  email: z.string().email().nullable().optional(),
  status: z.enum(['active', 'closed']).optional(),
});

/** Branch rows are themselves limited to the user's allowed branches. */
function allowedBranchWhere() {
  const { allowedBranchIds } = requireTenantContext();
  return allowedBranchIds === null ? {} : { id: { [Op.in]: allowedBranchIds } };
}

function assertBranchVisible(id: number) {
  const { allowedBranchIds } = requireTenantContext();
  if (allowedBranchIds !== null && !allowedBranchIds.includes(id))
    throw Forbidden('You do not have access to this branch', 'BRANCH_FORBIDDEN');
}

export function branchRoutes(api: Router) {
  const r = Router();
  r.use(authenticate);

  /**
   * Any institute member may list their own branches: many pages (students, admissions, batches,
   * attendance) label and filter by branch. Contact details still need `branches.view`.
   */
  r.get('/', requireTenant, async (_req, res) => {
    const attributes = hasPermission('branches.view') ? undefined : ['id', 'name', 'code', 'status'];
    res.json(await branchRepo.findAll({ where: allowedBranchWhere(), attributes, order: [['name', 'ASC']] }));
  });

  r.get('/:id', requirePermission('branches', 'view'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    assertBranchVisible(id);
    res.json(await branchRepo.findById(id));
  });

  r.post('/', requirePermission('branches', 'create'), async (req, res) => {
    const body = parse(branchBody, req.body);
    const { instituteId } = requireTenantContext();
    if (body.status !== 'closed')
      await assertWithinLimit(instituteId, 'maxBranches', await branchRepo.count({ status: 'active' }));
    const branch = await branchRepo.create({
      name: body.name,
      code: body.code,
      address: body.address ?? null,
      city: body.city ?? null,
      phone: body.phone ?? null,
      email: body.email ?? null,
      status: body.status,
    });
    await audit({ action: 'branch.created', entityType: 'branch', entityId: branch.id });
    res.status(201).json(branch);
  });

  r.patch('/:id', requirePermission('branches', 'edit'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    assertBranchVisible(id);
    if (req.body && typeof req.body === 'object' && 'status' in req.body)
      throw BadRequest('Use the close/activate actions to change a branch status');
    const body = parse(branchBody.omit({ status: true }).partial(), req.body);
    const branch = await branchRepo.update(id, body);
    await audit({
      action: 'branch.updated',
      entityType: 'branch',
      entityId: id,
      metadata: { fields: Object.keys(body) },
    });
    res.json(branch);
  });

  /** Closure keeps the branch and its history but stops it counting towards the plan's branches. */
  r.post('/:id/close', requirePermission('branches', 'configure'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    assertBranchVisible(id);
    const { reason } = parse(z.object({ reason: z.string().trim().max(500).optional() }), req.body ?? {});
    const branch = await branchRepo.findById(id);
    if (branch.status === 'closed') {
      res.json(branch);
      return;
    }
    if ((await branchRepo.count({ status: 'active' })) <= 1)
      throw Conflict('An institute needs at least one active branch', 'LAST_ACTIVE_BRANCH');
    const blockers = await branchClosureBlockers(id);
    if (blockers.length)
      throw Conflict(`This branch cannot be closed yet: ${blockers.join('; ')}`, 'BRANCH_IN_USE', {
        blockers,
      });
    const updated = await branchRepo.update(id, { status: 'closed' });
    await audit({
      action: 'branch.closed',
      entityType: 'branch',
      entityId: id,
      metadata: { reason: reason ?? null },
    });
    res.json(updated);
  });

  r.post('/:id/activate', requirePermission('branches', 'configure'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    assertBranchVisible(id);
    const branch = await branchRepo.findById(id);
    if (branch.status === 'active') {
      res.json(branch);
      return;
    }
    const { instituteId } = requireTenantContext();
    await assertWithinLimit(instituteId, 'maxBranches', await branchRepo.count({ status: 'active' }));
    const updated = await branchRepo.update(id, { status: 'active' });
    await audit({ action: 'branch.activated', entityType: 'branch', entityId: id });
    res.json(updated);
  });

  r.delete('/:id', requirePermission('branches', 'delete'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    assertBranchVisible(id);
    await branchRepo.destroy(id);
    await audit({ action: 'branch.deleted', entityType: 'branch', entityId: id });
    res.status(204).end();
  });

  api.use('/branches', r);
}
