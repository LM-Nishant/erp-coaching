import crypto from 'node:crypto';
import { Op, type Transaction } from 'sequelize';
import type {
  CheckoutReturnInput,
  MktCartDto,
  MktCheckoutDto,
  MktOrderDto,
  PaymentGatewayKey,
} from '@erp/shared';
import { config } from '../../infrastructure/config';
import { getSequelize } from '../../infrastructure/database/sequelize';
import { logger } from '../../infrastructure/logger';
import {
  createPaymentGateway,
  GatewayRequestError,
  PAYMENT_GATEWAY_NAMES,
  WebhookSignatureError,
  type GatewayCredentials,
  type GatewayWebhookEvent,
  type MockPaymentGateway,
  type PaymentGatewayName,
  type VerifiedPayment,
} from '../../infrastructure/payment-gateways';
import { audit } from '../../shared/audit/audit.service';
import { getContext } from '../../shared/context';
import { AppError, BadRequest, Conflict, NotFound } from '../../shared/errors';
import { checkoutReturnUrl } from '../../shared/utilities/checkout-return';
import { User } from '../users/user.model';
import {
  MktCartItem,
  MktCoupon,
  MktCourse,
  MktEnrolment,
  MktOrder,
  MktOrderItem,
  MktSaleLedger,
  MktSeller,
  MktWebhookEvent,
} from './models';
import { applyCoupon, type PricedItem } from './coupons.service';
import { cardInclude, toCard } from './courses.service';
import { iso, platformSettings, splitSale } from './util';

// ---------------------------------------------------------------- gateway resolution

export interface MarketplaceGatewayConfig {
  gateway: PaymentGatewayName;
  credentials: GatewayCredentials;
}

/** The platform's gateway (the platform module registers the same resolver as for subscriptions). */
export type MarketplaceGatewayResolver = (input: {
  gateway?: string;
  purpose: 'checkout' | 'verify';
}) => Promise<MarketplaceGatewayConfig | null>;

let gatewayResolver: MarketplaceGatewayResolver | null = null;

export function setMarketplaceGatewayResolver(fn: MarketplaceGatewayResolver | null): void {
  gatewayResolver = fn;
}

/** Without a configured gateway the mock gateway serves development and tests (never production). */
export async function resolveGateway(gateway: string | undefined, purpose: 'checkout' | 'verify') {
  const cfg = gatewayResolver ? await gatewayResolver({ gateway, purpose }) : null;
  if (cfg) return cfg;
  if ((gateway ?? 'mock') === 'mock' && !config.isProd)
    return { gateway: 'mock', credentials: {} } satisfies MarketplaceGatewayConfig;
  throw new AppError(503, 'GATEWAY_NOT_CONFIGURED', 'Online payment is not configured yet; please try later');
}

// ---------------------------------------------------------------- cart

const me = () => getContext().userId!;

async function liveCourses(ids: number[]) {
  if (!ids.length) return [];
  return MktCourse.findAll({
    where: { id: ids, status: 'published' },
    include: cardInclude,
  }).then((rows) => rows.filter((c) => c.seller?.status === 'active'));
}

async function enrolledIds(userId: number, courseIds: number[]) {
  if (!courseIds.length) return new Set<number>();
  const rows = await MktEnrolment.findAll({
    where: { userId, courseId: courseIds },
    attributes: ['courseId'],
  });
  return new Set(rows.map((r) => r.courseId));
}

/** The cart, priced with `couponCode`. Courses that were unpublished or bought meanwhile drop out. */
export async function getCart(couponCode?: string | null): Promise<MktCartDto> {
  const userId = me();
  const rows = await MktCartItem.findAll({ where: { userId }, order: [['id', 'ASC']] });
  const live = await liveCourses(rows.map((r) => r.courseId));
  const owned = await enrolledIds(
    userId,
    live.map((c) => c.id),
  );
  const keep = live.filter((c) => !owned.has(c.id));
  const stale = rows.filter((r) => !keep.some((c) => c.id === r.courseId)).map((r) => r.id);
  if (stale.length) await MktCartItem.destroy({ where: { id: stale, userId } });
  const ordered = rows.map((r) => keep.find((c) => c.id === r.courseId)).filter((c): c is MktCourse => !!c);
  const priced: PricedItem[] = ordered.map((c) => ({
    courseId: c.id,
    sellerId: c.sellerId,
    pricePaise: c.pricePaise,
    discountPaise: 0,
  }));
  const { coupon, message } = await applyCoupon(couponCode, priced);
  const subtotal = priced.reduce((a, i) => a + i.pricePaise, 0);
  const discount = priced.reduce((a, i) => a + i.discountPaise, 0);
  return {
    items: ordered.map((c, n) => ({ course: toCard(c), discountPaise: priced[n].discountPaise })),
    couponCode: coupon?.code ?? null,
    couponMessage: message,
    subtotalPaise: subtotal,
    discountPaise: discount,
    totalPaise: subtotal - discount,
  };
}

export async function addToCart(courseId: number) {
  const userId = me();
  const [c] = await liveCourses([courseId]);
  if (!c) throw NotFound('Course');
  if (c.pricePaise === 0) throw BadRequest('Free courses do not need a cart; enrol directly');
  if ((await enrolledIds(userId, [courseId])).size)
    throw Conflict('You already own this course', 'ALREADY_ENROLLED');
  await MktCartItem.findOrCreate({ where: { userId, courseId }, defaults: { userId, courseId } });
  return getCart();
}

export async function removeFromCart(courseId: number) {
  await MktCartItem.destroy({ where: { userId: me(), courseId } });
  return getCart();
}

export async function cartCount(userId: number) {
  return MktCartItem.count({ where: { userId } });
}

/** Whether the signed-in user owns / has in cart the course (landing page buttons). */
export async function courseAccess(courseId: number) {
  const userId = me();
  const [enrolled, inCart] = await Promise.all([
    MktEnrolment.count({ where: { userId, courseId } }),
    MktCartItem.count({ where: { userId, courseId } }),
  ]);
  return { enrolled: enrolled > 0, inCart: inCart > 0 };
}

/** Free courses are joined directly, without an order. */
export async function enrolFree(courseId: number) {
  const userId = me();
  const [c] = await liveCourses([courseId]);
  if (!c) throw NotFound('Course');
  if (c.pricePaise > 0) throw Conflict('This course is paid; buy it first', 'COURSE_NOT_FREE');
  const [, created] = await MktEnrolment.findOrCreate({
    where: { userId, courseId },
    defaults: { userId, courseId, orderId: null, source: 'free' },
  });
  if (created) await MktCourse.increment('enrolmentCount', { where: { id: courseId } });
  return { enrolled: true };
}

// ---------------------------------------------------------------- orders

function orderNumber() {
  const d = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return `MKT-${d}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}

export async function toOrderDto(o: MktOrder): Promise<MktOrderDto> {
  const items = o.items ?? (await MktOrderItem.findAll({ where: { orderId: o.id }, order: [['id', 'ASC']] }));
  const courses = await MktCourse.findAll({
    where: { id: items.map((i) => i.courseId) },
    attributes: ['id', 'slug', 'sellerId'],
    include: [{ model: MktSeller, as: 'seller', attributes: ['displayName'] }],
  });
  return {
    id: o.id,
    number: o.number,
    status: o.status,
    gateway: o.gateway,
    gatewayPaymentId: o.gatewayPaymentId,
    couponCode: o.couponCode,
    subtotalPaise: o.subtotalPaise,
    discountPaise: o.discountPaise,
    totalPaise: o.totalPaise,
    items: items.map((i) => {
      const c = courses.find((x) => x.id === i.courseId);
      return {
        courseId: i.courseId,
        title: i.title,
        slug: c?.slug ?? '',
        sellerName: c?.seller?.displayName ?? '',
        pricePaise: i.pricePaise,
        discountPaise: i.discountPaise,
        paidPaise: i.paidPaise,
      };
    }),
    buyer: { name: o.buyerName, mobile: o.buyerMobile, email: o.buyerEmail },
    createdAt: iso(o.createdAt)!,
    paidAt: iso(o.paidAt),
  };
}

async function ownOrder(id: number) {
  const o = await MktOrder.findOne({
    where: { id, userId: me() },
    include: [{ model: MktOrderItem, as: 'items' }],
  });
  if (!o) throw NotFound('Order');
  return o;
}

export async function listOrders(): Promise<MktOrderDto[]> {
  const rows = await MktOrder.findAll({
    where: { userId: me(), status: { [Op.ne]: 'cancelled' } },
    include: [{ model: MktOrderItem, as: 'items' }],
    order: [['id', 'DESC']],
    limit: 200,
  });
  return Promise.all(rows.map(toOrderDto));
}

export async function getOrder(id: number) {
  return toOrderDto(await ownOrder(id));
}

/**
 * Grants what a paid order bought, inside the caller's transaction: enrolments, one ledger row
 * per item (gross, commission, seller net), coupon usage, course counters, cart cleanup. The
 * ledger's unique (entry_type, order_item_id) key makes it safe to run twice.
 */
async function fulfil(o: MktOrder, transaction: Transaction) {
  const items = await MktOrderItem.findAll({ where: { orderId: o.id }, transaction });
  const settings = await platformSettings();
  const sellers = await MktSeller.findAll({
    where: { id: [...new Set(items.map((i) => i.sellerId))] },
    attributes: ['id', 'commissionPercent'],
    transaction,
  });
  for (const i of items) {
    const [, created] = await MktEnrolment.findOrCreate({
      where: { userId: o.userId, courseId: i.courseId },
      defaults: { userId: o.userId, courseId: i.courseId, orderId: o.id, source: 'purchase' },
      transaction,
    });
    if (created) await MktCourse.increment('enrolmentCount', { where: { id: i.courseId }, transaction });
    if (
      i.paidPaise > 0 &&
      !(await MktSaleLedger.count({ where: { entryType: 'sale', orderItemId: i.id }, transaction }))
    ) {
      const seller = sellers.find((s) => s.id === i.sellerId);
      const percent = seller?.commissionPercent ?? settings.commissionPercent;
      const { commission, net } = splitSale(i.paidPaise, percent);
      await MktSaleLedger.create(
        {
          orderId: o.id,
          orderItemId: i.id,
          courseId: i.courseId,
          sellerId: i.sellerId,
          grossPaise: i.paidPaise,
          commissionPercent: percent,
          commissionPaise: commission,
          netPaise: net,
        },
        { transaction },
      );
    }
  }
  if (o.couponId) await MktCoupon.increment('usedCount', { where: { id: o.couponId }, transaction });
  await MktCartItem.destroy({
    where: { userId: o.userId, courseId: items.map((i) => i.courseId) },
    transaction,
  });
}

const RECENT_CHECKOUT_MS = 30 * 60_000;

function checkoutDto(o: MktOrder): MktCheckoutDto {
  return {
    orderId: o.id,
    number: o.number,
    status: o.status,
    amountPaise: o.totalPaise,
    payment:
      o.status === 'pending' && o.gateway && o.gatewayOrderId
        ? {
            paymentId: o.id,
            gateway: o.gateway as PaymentGatewayKey,
            gatewayOrderId: o.gatewayOrderId,
            checkout: o.checkoutPayload ?? {},
          }
        : null,
  };
}

/**
 * Starts checkout for `courseIds` (default: the cart). A total of zero (100% coupon) completes
 * at once; otherwise a gateway order is created and the webhook completes it. Repeats with the
 * same idempotency key, and the same basket within 30 minutes, return the same order.
 */
export async function startCheckout(input: {
  courseIds?: number[];
  couponCode?: string | null;
  idempotencyKey?: string | null;
  returnTo?: CheckoutReturnInput | null;
}): Promise<MktCheckoutDto> {
  const userId = me();
  const key = input.idempotencyKey?.slice(0, 160) ?? null;
  if (key) {
    const existing = await MktOrder.findOne({ where: { userId, idempotencyKey: key } });
    if (existing) return checkoutDto(existing);
  }
  const ids = input.courseIds?.length
    ? [...new Set(input.courseIds)]
    : (await MktCartItem.findAll({ where: { userId }, attributes: ['courseId'] })).map((r) => r.courseId);
  if (!ids.length) throw BadRequest('Your cart is empty');
  const courses = await liveCourses(ids);
  if (courses.length !== ids.length) throw Conflict('A course is no longer available', 'COURSE_UNAVAILABLE');
  if ((await enrolledIds(userId, ids)).size)
    throw Conflict('You already own one of these courses', 'ALREADY_ENROLLED');
  if (courses.some((c) => c.pricePaise === 0)) throw BadRequest('Free courses are joined without checkout');
  const priced: PricedItem[] = courses.map((c) => ({
    courseId: c.id,
    sellerId: c.sellerId,
    pricePaise: c.pricePaise,
    discountPaise: 0,
  }));
  const { coupon, message } = await applyCoupon(input.couponCode, priced);
  if (input.couponCode && !coupon) throw BadRequest(message ?? 'This coupon code is not valid');
  const subtotal = priced.reduce((a, i) => a + i.pricePaise, 0);
  const discount = priced.reduce((a, i) => a + i.discountPaise, 0);
  const total = subtotal - discount;
  const user = (await User.findByPk(userId))!;

  if (total > 0) {
    const recent = await MktOrder.findAll({
      where: {
        userId,
        status: 'pending',
        totalPaise: total,
        couponId: coupon?.id ?? null,
        createdAt: { [Op.gte]: new Date(Date.now() - RECENT_CHECKOUT_MS) },
      },
      include: [{ model: MktOrderItem, as: 'items' }],
      order: [['id', 'DESC']],
    });
    const same = recent.find(
      (o) =>
        o.checkoutPayload &&
        o.items!.length === ids.length &&
        o.items!.every((i) => ids.includes(i.courseId)),
    );
    if (same) return checkoutDto(same);
  }

  let order: MktOrder;
  try {
    order = await getSequelize().transaction(async (transaction) => {
      const o = await MktOrder.create(
        {
          number: orderNumber(),
          userId,
          status: total === 0 ? 'paid' : 'pending',
          subtotalPaise: subtotal,
          discountPaise: discount,
          totalPaise: total,
          couponId: coupon?.id ?? null,
          couponCode: coupon?.code ?? null,
          idempotencyKey: key,
          buyerName: user.name,
          buyerMobile: user.mobile,
          buyerEmail: user.email,
          ...(total === 0 && { paidAt: new Date() }),
        },
        { transaction },
      );
      for (const [n, c] of courses.entries())
        await MktOrderItem.create(
          {
            orderId: o.id,
            courseId: c.id,
            sellerId: c.sellerId,
            title: c.title,
            pricePaise: priced[n].pricePaise,
            discountPaise: priced[n].discountPaise,
            paidPaise: priced[n].pricePaise - priced[n].discountPaise,
          },
          { transaction },
        );
      if (total === 0) await fulfil(o, transaction);
      return o;
    });
  } catch (err) {
    if (key && (err as { name?: string }).name === 'SequelizeUniqueConstraintError') {
      const existing = await MktOrder.findOne({ where: { userId, idempotencyKey: key } });
      if (existing) return checkoutDto(existing);
    }
    throw err;
  }
  await audit({
    action: 'marketplace.order.created',
    entityType: 'mkt_order',
    entityId: order.id,
    instituteId: null,
    metadata: { total, courses: ids },
  });
  if (total === 0) return checkoutDto(order);

  const cfg = await resolveGateway(undefined, 'checkout');
  try {
    const g = await createPaymentGateway(cfg.gateway, cfg.credentials).createOrder({
      orderId: `mkt_${order.id}`,
      amountPaise: total,
      currency: 'INR',
      customer: {
        id: `u${userId}`,
        name: user.name,
        mobile: user.mobile ?? '',
        ...(user.email && { email: user.email }),
      },
      callbackUrl: checkoutReturnUrl(
        'marketplace',
        { instituteId: null, paymentId: order.id },
        input.returnTo ?? undefined,
        '/market/orders',
      ),
      notifyUrl: `${config.API_PUBLIC_URL}/api/marketplace/public/webhooks/${cfg.gateway}`,
      description: `Course order ${order.number}`.slice(0, 80),
      metadata: { orderNumber: order.number },
    });
    await order.update({
      gateway: cfg.gateway,
      gatewayOrderId: g.gatewayOrderId,
      checkoutPayload: g.checkout,
    });
  } catch (err) {
    logger.error(
      { orderId: order.id, gateway: cfg.gateway, reason: (err as Error).message },
      'Marketplace checkout failed',
    );
    await order.update({
      status: 'failed',
      gateway: cfg.gateway,
      failureReason: 'The gateway order could not be created',
    });
    throw new AppError(502, 'GATEWAY_ERROR', 'The payment gateway is unavailable; please try again');
  }
  return checkoutDto(order);
}

export type MktWebhookOutcome =
  | 'paid'
  | 'failed'
  | 'pending'
  | 'already_processed'
  | 'amount_mismatch'
  | 'unmatched'
  | 'duplicate'
  | 'ignored';

/**
 * Applies a verified gateway status once: the (gateway, event key) row is written in the same
 * transaction, so a replay hits the unique index; the order row is locked and its status checked.
 */
async function applyVerified(gateway: string, v: VerifiedPayment, eventKey: string) {
  const key = eventKey.slice(0, 191);
  const pre = await MktOrder.findOne({
    where: { gateway, gatewayOrderId: v.gatewayOrderId },
    attributes: ['id'],
  });
  let outcome: MktWebhookOutcome = 'pending';
  try {
    await getSequelize().transaction(async (transaction) => {
      const event = await MktWebhookEvent.create(
        { gateway, eventKey: key, orderId: pre?.id ?? null, outcome: 'received' },
        { transaction },
      );
      const o = pre ? await MktOrder.findByPk(pre.id, { transaction, lock: transaction.LOCK.UPDATE }) : null;
      if (!o) outcome = 'unmatched';
      else if (v.status === 'success') {
        if (o.status === 'paid') outcome = 'already_processed';
        else if (v.amountPaise !== o.totalPaise) {
          outcome = 'amount_mismatch';
          logger.error(
            { orderId: o.id, expected: o.totalPaise, got: v.amountPaise },
            'Marketplace amount mismatch',
          );
        } else {
          await o.update(
            {
              status: 'paid',
              gatewayPaymentId: v.gatewayPaymentId || o.gatewayPaymentId,
              paidAt: new Date(),
              failureReason: null,
            },
            { transaction },
          );
          await fulfil(o, transaction);
          outcome = 'paid';
        }
      } else if (v.status === 'failed') {
        if (o.status === 'pending') {
          await o.update(
            {
              status: 'failed',
              gatewayPaymentId: v.gatewayPaymentId || null,
              failureReason: 'Payment failed',
            },
            { transaction },
          );
          outcome = 'failed';
        } else outcome = 'already_processed';
      }
      await event.update({ outcome }, { transaction });
    });
  } catch (err) {
    if ((err as { name?: string }).name === 'SequelizeUniqueConstraintError') {
      const dup = await MktWebhookEvent.findOne({ where: { gateway, eventKey: key } });
      if (dup) return { outcome: 'duplicate' as const, orderId: dup.orderId };
    }
    throw err;
  }
  const final = outcome as MktWebhookOutcome;
  if (pre && final === 'paid')
    await audit({
      action: 'marketplace.order.paid',
      entityType: 'mkt_order',
      entityId: pre.id,
      instituteId: null,
    });
  return { outcome: final, orderId: pre?.id ?? null };
}

/** Public webhook: the signature is checked with the platform's credentials before anything is trusted. */
export async function processWebhook(
  gatewayName: string,
  rawBody: Buffer,
  headers: Record<string, string | string[] | undefined>,
) {
  if (!(PAYMENT_GATEWAY_NAMES as readonly string[]).includes(gatewayName)) throw NotFound('Webhook');
  let cfg: MarketplaceGatewayConfig;
  try {
    cfg = await resolveGateway(gatewayName, 'verify');
  } catch {
    throw NotFound('Webhook');
  }
  let event: GatewayWebhookEvent;
  try {
    event = await createPaymentGateway(cfg.gateway, cfg.credentials).verifyWebhook(headers, rawBody);
  } catch (err) {
    if (err instanceof WebhookSignatureError)
      throw new AppError(401, 'INVALID_SIGNATURE', 'Invalid webhook signature');
    if (err instanceof GatewayRequestError && err.retryable)
      throw new AppError(503, 'GATEWAY_UNAVAILABLE', 'Gateway status check failed; retry later');
    throw new AppError(400, 'INVALID_WEBHOOK', (err as Error).message);
  }
  if (event.kind !== 'payment') return { outcome: 'ignored' as const, orderId: null };
  const eventKey = event.eventId ?? `${event.gatewayPaymentId || event.gatewayOrderId}:${event.status}`;
  return applyVerified(cfg.gateway, event, eventKey);
}

/** Development/test only: simulates the mock gateway's hosted checkout and delivers its webhook. */
export async function completeMockCheckout(orderId: number, outcome: 'success' | 'failed') {
  if (config.isProd) throw NotFound('Order');
  const o = await ownOrder(orderId);
  if (o.gateway !== 'mock' || !o.gatewayOrderId) throw BadRequest('Not a mock gateway order');
  const gateway = createPaymentGateway('mock', {}) as MockPaymentGateway;
  const { body, headers } = gateway.completeCheckout(o.gatewayOrderId, outcome, o.totalPaise);
  const result = await processWebhook('mock', Buffer.from(body), headers);
  return { outcome: result.outcome, order: await getOrder(orderId) };
}

async function syncOrder(o: MktOrder) {
  if (o.status !== 'pending' || !o.gateway || !o.gatewayOrderId) return o.status;
  const cfg = await resolveGateway(o.gateway, 'verify');
  const v = await createPaymentGateway(cfg.gateway, cfg.credentials).fetchStatus(o.gatewayOrderId);
  if (v.status !== 'pending')
    await applyVerified(cfg.gateway, v, `status:${v.gatewayPaymentId || v.gatewayOrderId}:${v.status}`);
  return v.status;
}

/** Server-side status check after the payer returns (a webhook may be late). */
export async function syncPayment(orderId: number) {
  const o = await ownOrder(orderId);
  try {
    await syncOrder(o);
  } catch (err) {
    logger.warn({ orderId, reason: (err as Error).message }, 'Marketplace status check failed');
  }
  return getOrder(orderId);
}

/** The payer's browser came back from a redirect checkout (signed link; no session). */
export async function syncReturnedOrder(orderId: number) {
  const o = await MktOrder.findByPk(orderId);
  if (o) await syncOrder(o);
}
