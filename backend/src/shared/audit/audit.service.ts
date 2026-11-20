import { getContext, type RequestContext } from '../context';
import { AuditEvent } from './audit-event.model';
import { logger } from '../../infrastructure/logger';

export interface AuditInput {
  /** Dotted verb, e.g. `institute.suspended`, `role.permissions_changed`, `fee.refunded`. */
  action: string;
  entityType?: string;
  entityId?: string | number;
  metadata?: Record<string, unknown>;
  /** Defaults to the current tenant context. */
  instituteId?: number | null;
  /**
   * Branch the event belongs to (branch-restricted users see only their branches' events). Defaults
   * to the `branchId` in `metadata` (`after`, `before` or top level), else — for a branch-restricted
   * actor — their selected branch or only branch. `null` marks an institute-wide event, which only
   * users with access to all branches see.
   */
  branchId?: number | null;
}

const asBranchId = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : undefined;

function branchOf(input: AuditInput, instituteId: number | null, ctx: RequestContext): number | null {
  if (input.branchId !== undefined) return input.branchId;
  if (instituteId === null) return null;
  const m = input.metadata;
  for (const source of [m?.after, m?.before, m]) {
    if (source && typeof source === 'object') {
      const id = asBranchId((source as Record<string, unknown>).branchId);
      if (id) return id;
    }
  }
  // Whatever a branch-restricted user does happens inside their branches.
  if (instituteId === ctx.instituteId && ctx.allowedBranchIds) {
    if (ctx.activeBranchId) return ctx.activeBranchId;
    if (ctx.allowedBranchIds.length === 1) return ctx.allowedBranchIds[0];
  }
  return null;
}

/** Records an audit event with actor/impersonator/ip taken from the request context. */
export async function audit(input: AuditInput): Promise<void> {
  const ctx = getContext();
  const instituteId = input.instituteId !== undefined ? input.instituteId : (ctx.instituteId ?? null);
  try {
    await AuditEvent.create({
      instituteId,
      branchId: branchOf(input, instituteId, ctx),
      actorUserId: ctx.userId ?? null,
      impersonatorUserId: ctx.impersonatorId ?? null,
      action: input.action,
      entityType: input.entityType ?? null,
      entityId: input.entityId != null ? String(input.entityId) : null,
      metadata: input.metadata ?? null,
      ip: ctx.ip ?? null,
      userAgent: ctx.userAgent?.slice(0, 255) ?? null,
    });
  } catch (err) {
    logger.error({ err, action: input.action }, 'Failed to write audit event');
    throw err;
  }
}
