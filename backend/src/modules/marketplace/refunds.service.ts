import { Op } from 'sequelize';
import type { MktOrderRefundsDto, MktPage, MktRefundDto, MktRefundStatus } from '@erp/shared';
import { getSequelize } from '../../infrastructure/database/sequelize';
import { logger } from '../../infrastructure/logger';
import { createPaymentGateway, GatewayRequestError } from '../../infrastructure/payment-gateways';
import { audit } from '../../shared/audit/audit.service';
import { getContext } from '../../shared/context';
import { BadRequest, Conflict, NotFound } from '../../shared/errors';
import { resolveGateway } from './commerce.service';
import { MktCourse, MktEnrolment, MktOrder, MktOrderItem, MktSaleLedger } from './models';
import { MktRefund } from './payouts.models';
import { payoutSettings } from './payouts.service';
import { iso } from './util';

const DAY_MS = 86_400_000;
const OPEN: MktRefundStatus[] = ['requested'];

/** Paid items of the order that are not refunded yet (refund ledger row = refunded). */
async function refundableItems(order: MktOrder): Promise<MktOrderItem[]> {
  const items = order.items ?? (await MktOrderItem.findAll({ where: { orderId: order.id } }));
  const refunded = await MktSaleLedger.findAll({
    where: { orderId: order.id, entryType: 'refund' },
    attributes: ['orderItemId'],
  });
  const done = new Set(refunded.map((r) => r.orderItemId));
  return items.filter((i) => i.paidPaise > 0 && !done.has(i.id));
}

function refundDeadline(order: MktOrder, windowDays: number): Date | null {
  if (order.status !== 'paid' || !order.paidAt) return null;
  return new Date(order.paidAt.getTime() + windowDays * DAY_MS);
}

async function toRefundDtos(rows: MktRefund[]): Promise<MktRefundDto[]> {
  const orders = await MktOrder.findAll({ where: { id: [...new Set(rows.map((r) => r.orderId))] } });
  const items = await MktOrderItem.findAll({
    where: { id: rows.map((r) => r.orderItemId).filter((x): x is number => !!x) },
  });
  return rows.map((r) => {
    const o = orders.find((x) => x.id === r.orderId);
    const item = items.find((x) => x.id === r.orderItemId) ?? null;
    return {
      id: r.id,
      orderId: r.orderId,
      orderNumber: o?.number ?? '',
      courseId: item?.courseId ?? null,
      courseTitle: item?.title ?? null,
      buyer: { name: o?.buyerName ?? '', mobile: o?.buyerMobile ?? null },
      amountPaise: r.amountPaise,
      reason: r.reason,
      status: r.status,
      initiatedBy: r.initiatedBy,
      decisionNote: r.decisionNote,
      gatewayRefundId: r.gatewayRefundId,
      createdAt: iso(r.createdAt)!,
      decidedAt: iso(r.decidedAt),
    };
  });
}

/** The items a refund covers: one course, or every refundable course of the order. */
async function targetItems(order: MktOrder, courseId: number | null | undefined) {
  const open = await refundableItems(order);
  if (!courseId) return open;
  const item = open.find((i) => i.courseId === courseId);
  if (!item) throw BadRequest('This course is not refundable on this order');
  return [item];
}

// ---------------------------------------------------------------- learner

async function ownPaidOrder(orderId: number) {
  const o = await MktOrder.findOne({
    where: { id: orderId, userId: getContext().userId! },
    include: [{ model: MktOrderItem, as: 'items' }],
  });
  if (!o) throw NotFound('Order');
  return o;
}

export async function orderRefunds(orderId: number): Promise<MktOrderRefundsDto> {
  const o = await ownPaidOrder(orderId);
  const settings = await payoutSettings();
  const deadline = refundDeadline(o, settings.refundWindowDays);
  const requests = await MktRefund.findAll({ where: { orderId }, order: [['id', 'DESC']] });
  const pendingItems = new Set(
    requests.filter((r) => OPEN.includes(r.status)).map((r) => r.orderItemId ?? 'all'),
  );
  const open = deadline && deadline.getTime() > Date.now() && !pendingItems.has('all');
  const items = open ? (await refundableItems(o)).filter((i) => !pendingItems.has(i.id)) : [];
  return {
    refundableUntil: open && items.length ? iso(deadline)! : null,
    refundableCourseIds: items.map((i) => i.courseId),
    requests: await toRefundDtos(requests),
  };
}

export async function requestRefund(orderId: number, input: { courseId?: number | null; reason: string }) {
  const o = await ownPaidOrder(orderId);
  const settings = await payoutSettings();
  const deadline = refundDeadline(o, settings.refundWindowDays);
  if (!deadline) throw BadRequest('Only paid orders can be refunded');
  if (deadline.getTime() <= Date.now())
    throw BadRequest(`Refunds can be requested within ${settings.refundWindowDays} days of purchase`);
  const items = await targetItems(o, input.courseId);
  if (!items.length) throw BadRequest('Nothing left to refund on this order');
  const open = await MktRefund.findAll({ where: { orderId, status: OPEN } });
  if (open.some((r) => !r.orderItemId || items.some((i) => i.id === r.orderItemId)))
    throw Conflict('A refund request for this order is already waiting for review');
  const refund = await MktRefund.create({
    orderId,
    orderItemId: input.courseId ? items[0].id : null,
    userId: o.userId,
    amountPaise: items.reduce((t, i) => t + i.paidPaise, 0),
    reason: input.reason.trim(),
    initiatedBy: 'learner',
  });
  await audit({
    action: 'marketplace.refund.requested',
    entityType: 'mkt_refund',
    entityId: refund.id,
    instituteId: null,
    metadata: { orderId, courseId: input.courseId ?? null, amountPaise: refund.amountPaise },
  });
  return (await toRefundDtos([refund]))[0];
}

// ---------------------------------------------------------------- admin

export async function listRefunds(q: {
  status?: MktRefundStatus;
  page?: number;
  pageSize?: number;
}): Promise<MktPage<MktRefundDto>> {
  const page = Math.max(1, q.page ?? 1);
  const pageSize = Math.min(200, Math.max(1, q.pageSize ?? 50));
  const { rows, count } = await MktRefund.findAndCountAll({
    where: q.status ? { status: q.status } : {},
    order: [['id', 'DESC']],
    limit: pageSize,
    offset: (page - 1) * pageSize,
  });
  return { items: await toRefundDtos(rows), total: count, page, pageSize };
}

export async function rejectRefund(id: number, note: string) {
  const [n] = await MktRefund.update(
    {
      status: 'rejected',
      decisionNote: note.trim(),
      decidedAt: new Date(),
      decidedByUserId: getContext().userId ?? null,
    },
    { where: { id, status: 'requested' } },
  );
  if (!n) {
    if (!(await MktRefund.count({ where: { id } }))) throw NotFound('Refund request');
    throw Conflict('This refund request was already decided');
  }
  await audit({
    action: 'marketplace.refund.rejected',
    entityType: 'mkt_refund',
    entityId: id,
    instituteId: null,
    metadata: { note },
  });
  return (await toRefundDtos([(await MktRefund.findByPk(id))!]))[0];
}

export async function approveRefund(id: number, note?: string | null) {
  const r = await MktRefund.findByPk(id);
  if (!r) throw NotFound('Refund request');
  if (r.status !== 'requested' && r.status !== 'failed')
    throw Conflict('This refund request was already decided');
  return processRefund(r, note ?? null);
}

/** Refund a paid order (or one course of it) without a learner request. No refund window applies. */
export async function adminRefundOrder(orderId: number, input: { courseId?: number | null; reason: string }) {
  const o = await MktOrder.findByPk(orderId, { include: [{ model: MktOrderItem, as: 'items' }] });
  if (!o) throw NotFound('Order');
  if (o.status !== 'paid') throw BadRequest('Only paid orders can be refunded');
  const items = await targetItems(o, input.courseId);
  if (!items.length) throw BadRequest('Nothing left to refund on this order');
  if (await MktRefund.count({ where: { orderId, status: OPEN } }))
    throw Conflict('This order has a refund request waiting for review; approve or reject it');
  const r = await MktRefund.create({
    orderId,
    orderItemId: input.courseId ? items[0].id : null,
    userId: o.userId,
    amountPaise: items.reduce((t, i) => t + i.paidPaise, 0),
    reason: input.reason.trim(),
    initiatedBy: 'admin',
  });
  await audit({
    action: 'marketplace.refund.initiated',
    entityType: 'mkt_refund',
    entityId: r.id,
    instituteId: null,
    metadata: { orderId, courseId: input.courseId ?? null, amountPaise: r.amountPaise },
  });
  return processRefund(r, null);
}

/**
 * Sends the money back through the gateway (our refund id is idempotent at the gateway), then in one
 * transaction: a refund ledger row per item reversing its sale (deducted from the seller's next payout,
 * even when the sale was paid out), the enrolment removed, and the order marked refunded once nothing
 * paid is left.
 */
async function processRefund(r: MktRefund, note: string | null): Promise<MktRefundDto> {
  const order = await MktOrder.findByPk(r.orderId, { include: [{ model: MktOrderItem, as: 'items' }] });
  if (!order || order.status !== 'paid') throw BadRequest('Only paid orders can be refunded');
  const items = (await refundableItems(order)).filter((i) => !r.orderItemId || i.id === r.orderItemId);
  if (!items.length) throw Conflict('These courses were already refunded');
  const amountPaise = items.reduce((t, i) => t + i.paidPaise, 0);
  const decided = { decidedAt: new Date(), decidedByUserId: getContext().userId ?? null, decisionNote: note };

  let gatewayRefundId: string | null = null;
  if (amountPaise > 0 && order.gateway && order.gatewayOrderId) {
    try {
      const cfg = await resolveGateway(order.gateway, 'verify');
      const result = await createPaymentGateway(cfg.gateway, cfg.credentials).refund({
        gatewayOrderId: order.gatewayOrderId,
        gatewayPaymentId: order.gatewayPaymentId ?? '',
        amountPaise,
        refundId: `mktrf-${r.id}`,
        note: r.reason.slice(0, 100),
      });
      if (result.status === 'failed') throw new Error(result.message ?? 'The gateway rejected the refund');
      gatewayRefundId = result.gatewayRefundId ?? result.refundId;
    } catch (err) {
      const message =
        err instanceof GatewayRequestError && err.retryable
          ? 'The gateway did not answer; try again (the refund will not be sent twice)'
          : (err as Error).message;
      logger.warn({ refundId: r.id, reason: (err as Error).message }, 'Marketplace refund failed');
      await r.update({ status: 'failed', ...decided, decisionNote: message.slice(0, 1000), amountPaise });
      await audit({
        action: 'marketplace.refund.failed',
        entityType: 'mkt_refund',
        entityId: r.id,
        instituteId: null,
        metadata: { message },
      });
      return (await toRefundDtos([r]))[0];
    }
  }

  await getSequelize().transaction(async (transaction) => {
    const locked = await MktOrder.findByPk(order.id, { transaction, lock: transaction.LOCK.UPDATE });
    for (const item of items) {
      const sale = await MktSaleLedger.findOne({
        where: { orderItemId: item.id, entryType: 'sale' },
        transaction,
      });
      const already = await MktSaleLedger.count({
        where: { orderItemId: item.id, entryType: 'refund' },
        transaction,
      });
      if (sale && !already)
        await MktSaleLedger.create(
          {
            entryType: 'refund',
            orderId: sale.orderId,
            orderItemId: sale.orderItemId,
            courseId: sale.courseId,
            sellerId: sale.sellerId,
            grossPaise: sale.grossPaise,
            commissionPercent: sale.commissionPercent,
            commissionPaise: sale.commissionPaise,
            netPaise: sale.netPaise,
          },
          { transaction },
        );
      const removed = await MktEnrolment.destroy({
        where: { userId: order.userId, courseId: item.courseId, orderId: order.id },
        transaction,
      });
      if (removed)
        await MktCourse.decrement('enrolmentCount', {
          where: { id: item.courseId, enrolmentCount: { [Op.gt]: 0 } },
          transaction,
        });
    }
    const left = (await refundableItems(order)).filter((i) => !items.some((x) => x.id === i.id));
    if (!left.length) await locked!.update({ status: 'refunded' }, { transaction });
    await r.update({ status: 'refunded', gatewayRefundId, amountPaise, ...decided }, { transaction });
  });
  await audit({
    action: 'marketplace.refund.refunded',
    entityType: 'mkt_refund',
    entityId: r.id,
    instituteId: null,
    metadata: { orderId: order.id, amountPaise, gatewayRefundId, items: items.map((i) => i.courseId) },
  });
  return (await toRefundDtos([r]))[0];
}
