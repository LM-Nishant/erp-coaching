import { Op, type Transaction } from 'sequelize';
import type { MktOrderRefundsDto, MktPage, MktRefundDto, MktRefundStatus } from '@erp/shared';
import { getSequelize } from '../../infrastructure/database/sequelize';
import { logger } from '../../infrastructure/logger';
import { createPaymentGateway, GatewayRequestError } from '../../infrastructure/payment-gateways';
import { audit } from '../../shared/audit/audit.service';
import { getContext } from '../../shared/context';
import { BadRequest, Conflict, NotFound } from '../../shared/errors';
import { resolveGateway } from './commerce.service';
import {
  notifyRefundDecision,
  REFUND_FAILED_EVENT,
  REFUND_REFUNDED_EVENT,
  REFUND_REJECTED_EVENT,
} from './decisions.notify';
import { MktCourse, MktEnrolment, MktOrder, MktOrderItem, MktSaleLedger } from './models';
import { MktRefund } from './payouts.models';
import { payoutSettings } from './payouts.service';
import { iso } from './util';

const DAY_MS = 86_400_000;
const OPEN: MktRefundStatus[] = ['requested'];

/**
 * Paid items of the order that no refund covers yet. A refund claims its items (`refund_id`) before the
 * gateway is called and keeps them when it fails, so each item can be refunded only once.
 */
async function refundableItems(order: MktOrder, transaction?: Transaction): Promise<MktOrderItem[]> {
  const items = await MktOrderItem.findAll({ where: { orderId: order.id }, transaction });
  const refunded = await MktSaleLedger.findAll({
    where: { orderId: order.id, entryType: 'refund' },
    attributes: ['orderItemId'],
    transaction,
  });
  const done = new Set(refunded.map((r) => r.orderItemId));
  return items.filter((i) => i.paidPaise > 0 && !i.refundId && !done.has(i.id));
}

/** Conflict when the order's items are held by a refund that failed: that refund must be retried. */
async function failedRefundOn(order: MktOrder, courseId?: number | null) {
  const claimed = await MktOrderItem.findAll({
    where: { orderId: order.id, refundId: { [Op.ne]: null }, ...(courseId ? { courseId } : {}) },
  });
  const failed = claimed.length
    ? await MktRefund.findOne({ where: { id: claimed.map((i) => i.refundId!), status: 'failed' } })
    : null;
  if (failed)
    throw Conflict(
      `Refund #${failed.id} of this order failed; retry it on Marketplace refunds`,
      'REFUND_FAILED_RETRY',
    );
}

/**
 * Claims the items for the refund in the caller's transaction: a conditional update, so two refunds
 * racing for the same item can't both win.
 */
async function claimItems(refundId: number, items: MktOrderItem[], transaction: Transaction) {
  const ids = items.filter((i) => i.refundId !== refundId).map((i) => i.id);
  if (!ids.length) return;
  const [n] = await MktOrderItem.update(
    { refundId },
    { where: { id: ids, refundId: { [Op.is]: null } }, transaction },
  );
  if (n !== ids.length) throw Conflict('These courses are already being refunded');
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
async function targetItems(order: MktOrder, courseId: number | null | undefined, transaction?: Transaction) {
  const open = await refundableItems(order, transaction);
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
  const r = (await MktRefund.findByPk(id))!;
  const [dto] = await toRefundDtos([r]);
  await notifyRefundDecision(REFUND_REJECTED_EVENT, {
    userId: r.userId,
    amountPaise: r.amountPaise,
    orderNumber: dto.orderNumber,
    course: dto.courseTitle,
    note: r.decisionNote,
  });
  return dto;
}

/** Approves a learner's request: claims its courses and refunds them. */
export async function approveRefund(id: number, note?: string | null) {
  const r = await getSequelize().transaction(async (transaction) => {
    const r = await MktRefund.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!r) throw NotFound('Refund request');
    if (r.status === 'failed') throw Conflict('This refund failed; retry it instead', 'REFUND_FAILED_RETRY');
    if (r.status !== 'requested') throw Conflict('This refund request was already decided');
    const order = await MktOrder.findByPk(r.orderId, { transaction });
    if (!order || order.status !== 'paid') throw BadRequest('Only paid orders can be refunded');
    const items = (await refundableItems(order, transaction)).filter(
      (i) => !r.orderItemId || i.id === r.orderItemId,
    );
    if (!items.length) throw Conflict('These courses were already refunded');
    await claimItems(r.id, items, transaction);
    return r;
  });
  return processRefund(r, note ?? null);
}

/** Sends a failed refund to the gateway again, with the same refund id, so it is never paid twice. */
export async function retryRefund(id: number) {
  const r = await MktRefund.findByPk(id);
  if (!r) throw NotFound('Refund request');
  if (r.status !== 'failed') throw Conflict('Only a failed refund can be retried');
  await audit({
    action: 'marketplace.refund.retried',
    entityType: 'mkt_refund',
    entityId: r.id,
    instituteId: null,
  });
  return processRefund(r, null);
}

/**
 * Creates a refund and claims its items in one transaction, so a second refund of the same course can't
 * start (it fails on the claim, and its row is rolled back).
 */
async function startRefund(
  order: MktOrder,
  items: MktOrderItem[],
  input: { reason: string; initiatedBy: 'admin' | 'system'; wholeOrder: boolean },
  transaction: Transaction,
) {
  const r = await MktRefund.create(
    {
      orderId: order.id,
      orderItemId: input.wholeOrder ? null : items[0].id,
      userId: order.userId,
      amountPaise: items.reduce((t, i) => t + i.paidPaise, 0),
      reason: input.reason.trim(),
      initiatedBy: input.initiatedBy,
    },
    { transaction },
  );
  await claimItems(r.id, items, transaction);
  return r;
}

/** Refund a paid order (or one course of it) without a learner request. No refund window applies. */
export async function adminRefundOrder(orderId: number, input: { courseId?: number | null; reason: string }) {
  const o = await MktOrder.findByPk(orderId);
  if (!o) throw NotFound('Order');
  if (o.status !== 'paid') throw BadRequest('Only paid orders can be refunded');
  if (await MktRefund.count({ where: { orderId, status: OPEN } }))
    throw Conflict('This order has a refund request waiting for review; approve or reject it');
  const r = await getSequelize().transaction(async (transaction) => {
    await MktOrder.findByPk(orderId, { transaction, lock: transaction.LOCK.UPDATE });
    const items = await targetItems(o, input.courseId, transaction).catch(async (err) => {
      await failedRefundOn(o, input.courseId);
      throw err;
    });
    if (!items.length) {
      await failedRefundOn(o);
      throw BadRequest('Nothing left to refund on this order');
    }
    return startRefund(
      o,
      items,
      { reason: input.reason, initiatedBy: 'admin', wholeOrder: !input.courseId },
      transaction,
    );
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
 * The learner paid for courses they already own through another order (a second checkout of the same
 * basket after the order-reuse window). Those items are not credited to the seller; their money goes
 * back automatically. A failed refund shows under Failed in Marketplace refunds. Never throws.
 */
export async function refundDuplicatePurchase(orderId: number, itemIds: number[]) {
  try {
    const o = await MktOrder.findByPk(orderId);
    if (!o) return;
    const r = await getSequelize().transaction(async (transaction) => {
      const items = (await refundableItems(o, transaction)).filter((i) => itemIds.includes(i.id));
      if (!items.length) return null;
      const all = (await refundableItems(o, transaction)).length === items.length;
      return startRefund(
        o,
        items,
        {
          reason: 'Automatic refund: the learner already owned this course',
          initiatedBy: 'system',
          wholeOrder: all && items.length > 1,
        },
        transaction,
      );
    });
    if (!r) return;
    await audit({
      action: 'marketplace.refund.initiated',
      entityType: 'mkt_refund',
      entityId: r.id,
      instituteId: null,
      metadata: { orderId, duplicate: true, amountPaise: r.amountPaise },
    });
    await processRefund(r, null);
  } catch (err) {
    logger.error({ orderId, reason: (err as Error).message }, 'Marketplace duplicate purchase refund failed');
  }
}

/**
 * A second captured payment for an order that is already paid (or refunded): it is never credited.
 * One refund per gateway payment (unique key) returns just that payment. Never throws.
 */
export async function refundExtraPayment(orderId: number, gatewayPaymentId: string, amountPaise: number) {
  try {
    const o = await MktOrder.findByPk(orderId);
    if (!o) return;
    let r: MktRefund;
    try {
      r = await MktRefund.create({
        orderId,
        orderItemId: null,
        userId: o.userId,
        amountPaise,
        reason: `Automatic refund: order ${o.number} was paid more than once`,
        initiatedBy: 'system',
        gatewayPaymentId,
      });
    } catch (err) {
      if ((err as { name?: string }).name === 'SequelizeUniqueConstraintError') return;
      throw err;
    }
    logger.warn({ orderId, gatewayPaymentId }, 'Marketplace order paid twice; refunding the extra payment');
    await audit({
      action: 'marketplace.refund.initiated',
      entityType: 'mkt_refund',
      entityId: r.id,
      instituteId: null,
      metadata: { orderId, gatewayPaymentId, amountPaise, extraPayment: true },
    });
    await processRefund(r, null);
  } catch (err) {
    logger.error({ orderId, reason: (err as Error).message }, 'Marketplace extra payment refund failed');
  }
}

async function notifyOutcome(r: MktRefund, order: MktOrder, items: MktOrderItem[]) {
  const event = r.status === 'refunded' ? REFUND_REFUNDED_EVENT : REFUND_FAILED_EVENT;
  await notifyRefundDecision(event, {
    userId: r.userId,
    amountPaise: r.amountPaise,
    orderNumber: order.number,
    course: items.length === 1 ? items[0].title : null,
  });
}

/**
 * Sends the money back through the gateway (our refund id is idempotent at the gateway), then in one
 * transaction: a refund ledger row per item reversing its sale (deducted from the seller's next payout,
 * even when the sale was paid out), the enrolment removed, and the order marked refunded once nothing
 * paid is left. The refund's items were claimed beforehand. A gateway failure saves the refund as
 * `failed` (items stay claimed, so only a retry can refund them) and returns it: callers show its status.
 */
async function processRefund(r: MktRefund, note: string | null): Promise<MktRefundDto> {
  const order = await MktOrder.findByPk(r.orderId);
  if (!order) throw NotFound('Order');
  const extra = !!r.gatewayPaymentId;
  if (!extra && order.status !== 'paid') throw BadRequest('Only paid orders can be refunded');
  const items = extra ? [] : await MktOrderItem.findAll({ where: { orderId: order.id, refundId: r.id } });
  if (!extra && !items.length) throw Conflict('These courses were already refunded');
  const amountPaise = extra ? r.amountPaise : items.reduce((t, i) => t + i.paidPaise, 0);
  const decided = { decidedAt: new Date(), decidedByUserId: getContext().userId ?? null, decisionNote: note };

  let gatewayRefundId: string | null = null;
  if (amountPaise > 0 && order.gateway && order.gatewayOrderId) {
    try {
      const cfg = await resolveGateway(order.gateway, 'verify');
      const result = await createPaymentGateway(cfg.gateway, cfg.credentials).refund({
        gatewayOrderId: order.gatewayOrderId,
        gatewayPaymentId: r.gatewayPaymentId ?? order.gatewayPaymentId ?? '',
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
      const firstFailure = r.status !== 'failed';
      await r.update({ status: 'failed', ...decided, decisionNote: message.slice(0, 1000), amountPaise });
      await audit({
        action: 'marketplace.refund.failed',
        entityType: 'mkt_refund',
        entityId: r.id,
        instituteId: null,
        metadata: { message },
      });
      if (firstFailure) await notifyOutcome(r, order, items);
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
    if (!extra && !(await paidItemsLeft(order.id, r.id, transaction)))
      await locked!.update({ status: 'refunded' }, { transaction });
    await r.update({ status: 'refunded', gatewayRefundId, amountPaise, ...decided }, { transaction });
  });
  await audit({
    action: 'marketplace.refund.refunded',
    entityType: 'mkt_refund',
    entityId: r.id,
    instituteId: null,
    metadata: {
      orderId: order.id,
      amountPaise,
      gatewayRefundId,
      items: items.map((i) => i.courseId),
      ...(extra && { gatewayPaymentId: r.gatewayPaymentId }),
    },
  });
  await notifyOutcome(r, order, items);
  return (await toRefundDtos([r]))[0];
}

/** Paid items of the order not refunded by another refund (unclaimed, or claimed by one not yet refunded). */
async function paidItemsLeft(orderId: number, refundId: number, transaction: Transaction) {
  const items = await MktOrderItem.findAll({ where: { orderId }, transaction });
  const others = items.filter((i) => i.paidPaise > 0 && i.refundId !== refundId);
  const claimedBy = others.map((i) => i.refundId).filter((x): x is number => !!x);
  const done = claimedBy.length
    ? new Set(
        (await MktRefund.findAll({ where: { id: claimedBy, status: 'refunded' }, transaction })).map(
          (x) => x.id,
        ),
      )
    : new Set<number>();
  return others.filter((i) => !i.refundId || !done.has(i.refundId)).length;
}
