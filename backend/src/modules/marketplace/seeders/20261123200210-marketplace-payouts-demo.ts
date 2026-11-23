import { Op } from 'sequelize';
import type { Migration } from '../../../infrastructure/database/migration-helpers';
import { config } from '../../../infrastructure/config';
import { encryptSecret } from '../../../infrastructure/crypto';
import { hashPassword } from '../../../infrastructure/password';
import { User } from '../../users/user.model';
import { Institute } from '../../institutes/institute.model';
import { MktCourse, MktEnrolment, MktOrder, MktOrderItem, MktSaleLedger, MktSeller } from '../models';
import { MktPayout, MktPayoutAccount, MktPayoutRun, MktRefund } from '../payouts.models';
import { istMonthStart, payoutSettings } from '../payouts.service';
import { platformSettings, splitSale } from '../util';

const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY);

/** [days ago, learner index, course index, refunded after N days?] */
type Sale = [number, number, number, number?];
const RIYA_PAID: Sale[] = [
  [95, 0, 0],
  [80, 1, 0],
  [66, 2, 0],
];
const RIYA_PENDING: Sale[] = [
  [40, 3, 0],
  [20, 4, 0],
  [12, 5, 0, 4],
  [9, 6, 0],
  [3, 7, 0],
];
const APEX_PENDING: Sale[] = [
  [70, 0, 0],
  [25, 1, 0],
  [5, 2, 1],
];

/**
 * Demo revenue for the marketplace: a few months of sales for Riya Sharma and the Apex storefront,
 * one refund, Riya's (encrypted) bank details and one finalized payout run with her payout paid by
 * bank transfer. Writes rows directly, so no notifications or audit entries are produced. Idempotent;
 * only with SEED_DEMO_DATA=true.
 */
export const up: Migration = async () => {
  await payoutSettings();
  if (!config.SEED_DEMO_DATA) return;
  if (await MktOrder.count({ where: { number: { [Op.like]: 'MKT-DEMO-%' } } })) return;

  const riyaUser = await User.findOne({ where: { mobile: '9640000001' } });
  const riya = riyaUser && (await MktSeller.findOne({ where: { userId: riyaUser.id } }));
  if (!riya) return;
  const apexInstitute = await Institute.findOne({ where: { slug: 'apex' } });
  const apex = apexInstitute && (await MktSeller.findOne({ where: { ownerInstituteId: apexInstitute.id } }));

  const hash = await hashPassword(config.SEED_DEMO_PASSWORD);
  const learners: User[] = [];
  for (const [i, name] of [
    'Kabir Mehta',
    'Sana Iqbal',
    'Rohan Das',
    'Meera Pillai',
    'Arjun Nair',
    'Ishita Roy',
    'Dev Malhotra',
    'Tara Joshi',
  ].entries()) {
    const mobile = `96700000${String(i + 1).padStart(2, '0')}`;
    const [u] = await User.findOrCreate({
      where: { mobile },
      defaults: { mobile, name, email: null, passwordHash: hash, isSuperAdmin: false, lastLoginAt: null },
    });
    learners.push(u);
  }

  const { commissionPercent } = await platformSettings();
  let seq = 0;
  const sell = async (seller: MktSeller, [ago, learner, courseIndex, refundAfter]: Sale) => {
    const courses = await MktCourse.findAll({
      where: { sellerId: seller.id, status: 'published', pricePaise: { [Op.gt]: 0 } },
      order: [['id', 'ASC']],
    });
    const course = courses[courseIndex % Math.max(courses.length, 1)];
    const buyer = learners[learner];
    if (!course || (await MktEnrolment.count({ where: { userId: buyer.id, courseId: course.id } })))
      return null;
    const at = daysAgo(ago);
    const order = await MktOrder.create({
      number: `MKT-DEMO-${String(++seq).padStart(4, '0')}`,
      userId: buyer.id,
      status: refundAfter ? 'refunded' : 'paid',
      subtotalPaise: course.pricePaise,
      discountPaise: 0,
      totalPaise: course.pricePaise,
      couponId: null,
      couponCode: null,
      gateway: 'mock',
      gatewayOrderId: `demo_order_${seq}`,
      gatewayPaymentId: `demo_pay_${seq}`,
      idempotencyKey: null,
      buyerName: buyer.name,
      buyerMobile: buyer.mobile,
      buyerEmail: null,
      paidAt: at,
      createdAt: at,
    });
    const item = await MktOrderItem.create({
      orderId: order.id,
      courseId: course.id,
      sellerId: seller.id,
      title: course.title,
      pricePaise: course.pricePaise,
      discountPaise: 0,
      paidPaise: course.pricePaise,
      createdAt: at,
    });
    const percent = seller.commissionPercent ?? commissionPercent;
    const { commission, net } = splitSale(course.pricePaise, percent);
    const row = {
      orderId: order.id,
      orderItemId: item.id,
      courseId: course.id,
      sellerId: seller.id,
      grossPaise: course.pricePaise,
      commissionPercent: percent,
      commissionPaise: commission,
      netPaise: net,
    };
    const sale = await MktSaleLedger.create({ ...row, entryType: 'sale', createdAt: at });
    if (refundAfter) {
      const refundedAt = daysAgo(ago - refundAfter);
      await MktRefund.create({
        orderId: order.id,
        orderItemId: item.id,
        userId: buyer.id,
        amountPaise: course.pricePaise,
        reason: 'Bought the wrong course by mistake',
        status: 'refunded',
        initiatedBy: 'learner',
        decisionNote: 'Approved within the refund window',
        decidedAt: refundedAt,
        gatewayRefundId: `demo_rfnd_${seq}`,
        createdAt: daysAgo(ago - 1),
      });
      await MktSaleLedger.create({ ...row, entryType: 'refund', createdAt: refundedAt });
    } else {
      await MktEnrolment.create({
        userId: buyer.id,
        courseId: course.id,
        orderId: order.id,
        source: 'purchase',
        createdAt: at,
      });
      await MktCourse.increment('enrolmentCount', { where: { id: course.id } });
    }
    return sale;
  };

  const paidRows: MktSaleLedger[] = [];
  for (const s of RIYA_PAID) {
    const row = await sell(riya, s);
    if (row) paidRows.push(row);
  }
  for (const s of RIYA_PENDING) await sell(riya, s);
  if (apex) for (const s of APEX_PENDING) await sell(apex, s);

  const accountNumber = '50100234567812';
  const account = await MktPayoutAccount.create({
    sellerId: riya.id,
    method: 'bank',
    holderName: 'Riya Sharma',
    bankName: 'HDFC Bank',
    ifsc: 'HDFC0001234',
    accountEncrypted: encryptSecret(JSON.stringify({ accountNumber })),
    masked: `XXXX${accountNumber.slice(-4)}`,
    updatedByUserId: riyaUser.id,
  });
  if (!paidRows.length) return;

  // Last month's run (covering sales before the start of last month), paid by NEFT a week later.
  const periodEnd = istMonthStart(new Date(istMonthStart(new Date()).getTime() - 1));
  const periodStart = istMonthStart(new Date(paidRows[0].createdAt.getTime()));
  const created = new Date(periodEnd.getTime() + 5 * DAY);
  const paidAt = new Date(periodEnd.getTime() + 7 * DAY);
  const run = await MktPayoutRun.create({
    periodStart,
    periodEnd,
    eligibleBefore: periodEnd,
    status: 'finalized',
    createdByUserId: null,
    finalizedAt: paidAt,
    createdAt: created,
  });
  const sum = (k: 'grossPaise' | 'commissionPaise' | 'netPaise') => paidRows.reduce((t, r) => t + r[k], 0);
  const payout = await MktPayout.create({
    runId: run.id,
    sellerId: riya.id,
    status: 'paid',
    grossPaise: sum('grossPaise'),
    commissionPaise: sum('commissionPaise'),
    refundsPaise: 0,
    netPaise: sum('netPaise'),
    entries: paidRows.length,
    reference: 'HDFCN52026110712345',
    paidToMasked: `HDFC Bank ${account.masked} (HDFC0001234)`,
    paidToEncrypted: encryptSecret(
      JSON.stringify({ accountNumber, holderName: 'Riya Sharma', ifsc: 'HDFC0001234', method: 'bank' }),
    ),
    paidAt,
    paidByUserId: null,
    createdAt: created,
  });
  await MktSaleLedger.update({ payoutId: payout.id }, { where: { id: paidRows.map((r) => r.id) } });
};

export const down: Migration = async () => {};
