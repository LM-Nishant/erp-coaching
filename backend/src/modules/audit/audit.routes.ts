import { Router } from 'express';
import { Op, type WhereOptions } from 'sequelize';
import { z } from 'zod';
import { parse } from '../../shared/utilities/validation';
import { paginated, paginationSchema, toLimitOffset } from '../../shared/utilities/pagination';
import { authenticate } from '../../shared/middleware/authenticate';
import { requirePermission, requireSuperAdmin } from '../../shared/middleware/authorize';
import { requireTenantContext } from '../../shared/context';
import { AuditEvent } from '../../shared/audit/audit-event.model';

const filters = paginationSchema.extend({
  action: z.string().max(100).optional(),
  entityType: z.string().max(60).optional(),
  actorUserId: z.coerce.number().int().positive().optional(),
  instituteId: z.coerce.number().int().positive().optional(),
});

function buildWhere(q: z.infer<typeof filters>): Record<string, unknown> {
  const where: Record<string, unknown> = {};
  if (q.action) where.action = { [Op.like]: `${q.action}%` };
  if (q.entityType) where.entityType = q.entityType;
  if (q.actorUserId) where.actorUserId = q.actorUserId;
  return where;
}

export function auditRoutes(api: Router) {
  api.get('/audit-events', authenticate, requirePermission('audit', 'view'), async (req, res) => {
    const q = parse(filters, req.query);
    const { instituteId } = requireTenantContext();
    const { rows, count } = await AuditEvent.findAndCountAll({
      where: { ...buildWhere(q), instituteId } as WhereOptions,
      order: [['id', 'DESC']],
      ...toLimitOffset(q),
    });
    res.json(paginated(rows, count, q));
  });

  api.get('/admin/audit-events', authenticate, requireSuperAdmin, async (req, res) => {
    const q = parse(filters, req.query);
    const where = buildWhere(q);
    if (q.instituteId) where.instituteId = q.instituteId;
    const { rows, count } = await AuditEvent.findAndCountAll({ where: where as WhereOptions, order: [['id', 'DESC']], ...toLimitOffset(q) });
    res.json(paginated(rows, count, q));
  });
}
