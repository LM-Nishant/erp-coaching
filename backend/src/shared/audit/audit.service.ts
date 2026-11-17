import { getContext } from '../context';
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
}

/** Records an audit event with actor/impersonator/ip taken from the request context. */
export async function audit(input: AuditInput): Promise<void> {
  const ctx = getContext();
  try {
    await AuditEvent.create({
      instituteId: input.instituteId !== undefined ? input.instituteId : (ctx.instituteId ?? null),
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
