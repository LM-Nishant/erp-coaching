/**
 * Selling courses online: which courses are paid, their display price, the website checkout
 * handoff and the student "buy this course" flow (fee account + online checkout with coupon and
 * referral attribution).
 */
import { Op } from 'sequelize';
import type { CheckoutOrderDto, CourseQuoteDto, PaymentGatewayKey } from '@erp/shared';
import { webAppBaseUrl } from '../../shared/public-urls';
import { requireTenantContext } from '../../shared/context';
import { Conflict, NotFound } from '../../shared/errors';
import {
  Batch,
  Course,
  batchAvailability,
  batchUnavailableError,
  openBatchesForCourse,
} from '../academics/api';
import { Student } from '../students/api';
import { isModuleEnabled } from '../subscriptions/subscription.service';
import { validateCoupon } from '../website/api';
import { FeeAccount, FeeCourseEnrolment, FeePayment, FeeStructure } from './models';
import { findStructureFor } from './structures.service';
import { generateAccount } from './accounts.service';
import { couponCustomerKey, createCheckout } from './payments.service';
import { enabledGateways } from './gateways.service';
import { batchOptionDto } from './course-enrolment';

/** A course is sold through fees when it has an active course fee structure. */
export async function isPaidCourse(instituteId: number, courseId: number): Promise<boolean> {
  const n = await FeeStructure.count({
    where: { instituteId, courseId, kind: 'course', status: 'active' },
  });
  return n > 0;
}

/** Fees gates a course only when the module is enabled and the course has a price. */
export async function feesGatesCourse(instituteId: number, courseId: number | null): Promise<boolean> {
  if (!courseId) return false;
  if (!(await isModuleEnabled(instituteId, 'fees'))) return false;
  return isPaidCourse(instituteId, courseId);
}

const inr = (paise: number) =>
  `₹${(paise / 100).toLocaleString('en-IN', { maximumFractionDigits: paise % 100 ? 2 : 0 })}`;

/** Display prices for the website catalogue (lowest active course structure; "From" when they differ). */
export async function coursePrices(courseIds: number[]): Promise<Map<number, string>> {
  const { instituteId } = requireTenantContext();
  const out = new Map<number, string>();
  if (!courseIds.length || !(await isModuleEnabled(instituteId, 'fees'))) return out;
  const rows = await FeeStructure.findAll({
    where: {
      instituteId,
      courseId: { [Op.in]: courseIds },
      batchId: null,
      kind: 'course',
      status: 'active',
    },
    attributes: ['courseId', 'total'],
  });
  const byCourse = new Map<number, number[]>();
  for (const r of rows) byCourse.set(r.courseId!, [...(byCourse.get(r.courseId!) ?? []), r.total]);
  for (const [courseId, totals] of byCourse) {
    const min = Math.min(...totals);
    out.set(courseId, `${new Set(totals).size > 1 ? 'From ' : ''}${inr(min)}`);
  }
  return out;
}

/**
 * Website "Buy" button target: the app's course purchase page when the course is sold online
 * (fees enabled, priced, an online gateway configured); null makes the website fall back to
 * online admission.
 */
export async function courseCheckoutUrl(input: {
  instituteId: number;
  courseId: number;
  batchId: number | null;
  couponCode: string | null;
  referralCode: string | null;
  appUrl?: string | null;
}): Promise<{ url: string } | null> {
  if (!(await feesGatesCourse(input.instituteId, input.courseId))) return null;
  if (!(await enabledGateways()).length) return null;
  const base = webAppBaseUrl(input.appUrl);
  const url = new URL(`${base}/my-fees/buy/${input.courseId}`);
  if (input.batchId) url.searchParams.set('batchId', String(input.batchId));
  if (input.couponCode) url.searchParams.set('coupon', input.couponCode);
  if (input.referralCode) url.searchParams.set('ref', input.referralCode);
  return { url: url.toString() };
}

async function purchaseTarget(studentId: number, courseId: number, batchId: number | null) {
  const { instituteId } = requireTenantContext();
  const [student, course] = await Promise.all([
    Student.findOne({ where: { instituteId, id: studentId } }),
    Course.findOne({ where: { instituteId, id: courseId } }),
  ]);
  if (!student) throw NotFound('Student');
  if (!course) throw NotFound('Course');
  const account = await FeeAccount.findOne({
    where: { instituteId, studentId, courseId, status: 'active' },
    order: [['id', 'DESC']],
  });
  const structure = account
    ? null
    : await findStructureFor({ branchId: student.branchId, courseId, batchId });
  if (!account && !structure) throw Conflict('This course is not sold online', 'NOT_FOR_SALE');
  return { student, course, account, structure };
}

/** Price of a course for a student (existing account balance or the structure total) with a coupon. */
export async function quoteCourse(input: {
  studentId: number;
  courseId: number;
  batchId?: number | null;
  couponCode?: string | null;
}): Promise<CourseQuoteDto> {
  const { student, course, account, structure } = await purchaseTarget(
    input.studentId,
    input.courseId,
    input.batchId ?? null,
  );
  const amount = account ? Math.max(0, account.balance) : structure!.total;
  let coupon: CourseQuoteDto['coupon'] = null;
  let discount = 0;
  if (input.couponCode && amount > 0) {
    const v = await validateCoupon({
      code: input.couponCode,
      amountPaise: amount,
      courseId: course.id,
      customerKey: couponCustomerKey(student.id),
    });
    coupon = { code: v.code, valid: v.valid, message: v.message };
    discount = v.valid ? v.discountPaise : 0;
    // The student's own open checkout holds a reservation; a new checkout supersedes it.
    if (!v.valid && v.reason === 'CUSTOMER_LIMIT' && account) {
      const open = await FeePayment.findOne({
        where: {
          instituteId: student.instituteId,
          accountId: account.id,
          mode: 'online',
          status: 'pending',
          couponCode: v.code,
        },
        order: [['id', 'DESC']],
      });
      if (open?.couponDiscount) {
        discount = Math.min(open.couponDiscount, amount - 1);
        coupon = { code: v.code, valid: true, message: 'Coupon applied' };
      }
    }
  }
  const chosen = input.batchId ?? account?.batchId ?? null;
  const [availability, open, enrolment, batchFixed] = await Promise.all([
    chosen
      ? batchAvailability(chosen, {
          courseId: course.id,
          branchId: student.branchId,
          studentUserId: student.userId,
        })
      : null,
    openBatchesForCourse(course.id, student.branchId),
    account
      ? FeeCourseEnrolment.findOne({ where: { instituteId: student.instituteId, accountId: account.id } })
      : null,
    purchaseBatchFixed(account),
  ]);
  const enrolledBatch = enrolment?.batchId
    ? await Batch.findOne({
        where: { instituteId: student.instituteId, id: enrolment.batchId },
        attributes: ['name'],
      })
    : null;
  return {
    courseId: course.id,
    courseName: course.name,
    accountId: account?.id ?? null,
    amount,
    discount,
    payable: amount - discount,
    coupon,
    alreadyPaid: !!account && account.balance <= 0,
    batch: availability
      ? {
          id: chosen!,
          // Another branch's batch is invisible to the student: report it without its name.
          name: availability.batch && availability.reason !== 'other_branch' ? availability.batch.name : null,
          available: !availability.reason,
          reason: availability.reason,
        }
      : null,
    batchFixed,
    openBatches: open.map(batchOptionDto),
    enrolment: enrolment
      ? { status: enrolment.status, batchId: enrolment.batchId, batchName: enrolledBatch?.name ?? null }
      : null,
  };
}

/** Once money is in, or when the price itself is the batch's, a purchase stays with its batch. */
async function purchaseBatchFixed(account: FeeAccount | null): Promise<boolean> {
  if (!account) return false;
  if (account.paid > 0) return true;
  if (!account.structureId) return false;
  const structure = await FeeStructure.findOne({
    where: { instituteId: account.instituteId, id: account.structureId },
    attributes: ['batchId'],
  });
  return !!structure?.batchId;
}

/**
 * The batch chosen at checkout must be one the student can join now (409 BATCH_FULL / BATCH_CLOSED
 * otherwise). An unpaid purchase may switch batch unless purchaseBatchFixed.
 */
async function applyCheckoutBatch(
  target: Awaited<ReturnType<typeof purchaseTarget>>,
  batchId: number | null,
): Promise<void> {
  if (!batchId) return;
  const { student, course, account } = target;
  const { reason } = await batchAvailability(batchId, {
    courseId: course.id,
    branchId: student.branchId,
    studentUserId: student.userId,
  });
  if (reason) throw batchUnavailableError(reason);
  if (!account || account.batchId === batchId) return;
  if (await purchaseBatchFixed(account))
    throw Conflict('This course purchase is already for another batch', 'PURCHASE_BATCH_FIXED');
  await account.update({ batchId });
}

/** Creates (or reuses) the student's fee account for the course and starts an online checkout. */
export async function startCoursePurchase(input: {
  studentId: number;
  courseId: number;
  batchId?: number | null;
  couponCode?: string | null;
  referralCode?: string | null;
  gateway?: PaymentGatewayKey;
  idempotencyKey?: string | null;
}): Promise<CheckoutOrderDto> {
  const { instituteId } = requireTenantContext();
  const batchId = input.batchId ?? null;
  const target = await purchaseTarget(input.studentId, input.courseId, batchId);
  if (target.account && target.account.balance <= 0)
    throw Conflict('This course is already paid for', 'ALREADY_PAID');
  await applyCheckoutBatch(target, batchId);
  let account = target.account;
  if (!account) {
    // A cancelled earlier purchase keeps its sourceRef, so number the attempts.
    const previous = await FeeAccount.count({
      where: { instituteId, sourceRef: { [Op.like]: `purchase:${input.studentId}:${input.courseId}:%` } },
    });
    account = (
      await generateAccount({
        studentId: input.studentId,
        structureId: target.structure!.id,
        title: `${target.course.name} fees`,
        source: 'online',
        sourceRef: `purchase:${input.studentId}:${input.courseId}:${previous + 1}`,
        batchId,
      })
    ).account;
  }
  if (account.balance <= 0) throw Conflict('This course is already paid for', 'ALREADY_PAID');
  return createCheckout({
    accountId: account.id,
    gateway: input.gateway,
    idempotencyKey: input.idempotencyKey ?? null,
    couponCode: input.couponCode ?? null,
    referralCode: input.referralCode ?? null,
  });
}
