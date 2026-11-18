/**
 * Online course purchases → admission and batch enrolment. Fees calls these (through `api.ts`) when
 * a purchase grants or loses its course entitlement. They join the caller's transaction; audit
 * entries and notifications are written only after it commits.
 */
import { Op, type Transaction } from 'sequelize';
import type { CourseBatchIssue } from '@erp/shared';
import { logger } from '../../infrastructure/logger';
import { audit } from '../../shared/audit/audit.service';
import { requireTenantContext } from '../../shared/context';
import { AppError, BadRequest, Conflict, NotFound } from '../../shared/errors';
import {
  activeBatchForCourse,
  batchAvailability,
  batchUnavailableError,
  enrollStudentsInBatch,
  leaveBatch,
  openBatchesForCourse,
} from '../academics/api';
import { Student } from '../students/models';
import { recordHistory } from '../students/students.service';
import { emitAdmissionCompleted } from './admission-events';
import { applicationRepo, completeAdmission, notifyAdmissionConfirmed } from './admissions.service';
import { AdmissionApplication } from './models';

/** Why a purchase could not be placed in a batch (or in the batch chosen at checkout). */
export type PurchaseBatchIssue = CourseBatchIssue;

export interface CoursePurchaseAdmission {
  applicationId: number;
  /** The student's branch (the batch search is limited to it). */
  branchId: number;
  /** The student's own login (batch rosters are by user id); null for a sibling sharing a mobile. */
  studentUserId: number | null;
  /** True when this call admitted the student; false when an earlier admission for the course is reused. */
  newlyAdmitted: boolean;
  /** Batch of the course the student is actively enrolled in after the call (null: none available). */
  batchId: number | null;
  /** True when this call enrolled the student in `batchId`. */
  addedToBatch: boolean;
  /**
   * Why the batch chosen at checkout was not used, or why no batch was found; null when the chosen
   * batch (or, without a choice, any batch) was used.
   */
  batchIssue: PurchaseBatchIssue | null;
}

const OPEN_STATUSES = ['pending', 'waitlisted', 'approved'] as const;

/** The error for an admin assignment (or checkout) that can't use the batch. */
export function purchaseBatchError(issue: PurchaseBatchIssue): AppError {
  if (issue === 'no_login')
    return BadRequest('The student has no login of their own yet, so they cannot be enrolled in a batch');
  if (issue === 'no_open_batch')
    return Conflict('No open batch of the course has free seats', 'NO_OPEN_BATCH');
  return batchUnavailableError(issue);
}

/** The student's admission for the course: their own (admitted first), else an open unlinked one. */
async function findApplication(student: Student, courseId: number, transaction: Transaction) {
  const base = { instituteId: student.instituteId, courseId };
  const lock = transaction.LOCK.UPDATE;
  return (
    (await AdmissionApplication.findOne({
      where: { ...base, studentId: student.id, status: 'admitted' },
      order: [['id', 'ASC']],
      transaction,
      lock,
    })) ??
    (await AdmissionApplication.findOne({
      where: { ...base, studentId: student.id, status: { [Op.in]: [...OPEN_STATUSES] } },
      order: [['id', 'DESC']],
      transaction,
      lock,
    })) ??
    // An application made before the student had a record (e.g. a website admission form).
    (await AdmissionApplication.findOne({
      where: {
        ...base,
        studentId: null,
        branchId: student.branchId,
        mobile: student.mobile,
        name: student.name,
        status: { [Op.in]: [...OPEN_STATUSES] },
      },
      order: [['id', 'DESC']],
      transaction,
      lock,
    }))
  );
}

/**
 * Admits a student who bought a course online and enrolls them in a batch of it: the batch chosen
 * at checkout, else the batch their application names, else the open batch of the course (in the
 * student's branch) that started first and still has seats. A student already in a batch of the
 * course stays there. An open application for the course is completed (an admitted one is reused);
 * without one an application is created. When no batch can be used the student is still admitted
 * and `batchId` is null, so the caller can queue them for an admin.
 *
 * `fallback: false` (an admin assigning a batch) uses only `batchId` and throws when it is unavailable.
 * Re-running is safe: an existing admission and enrolment are reused.
 */
export async function admitForCoursePurchase(
  input: {
    studentId: number;
    courseId: number;
    feeAccountId: number;
    batchId?: number | null;
    fallback?: boolean;
  },
  opts: { transaction: Transaction },
): Promise<CoursePurchaseAdmission> {
  const { transaction } = opts;
  const { instituteId } = requireTenantContext();
  const fallback = input.fallback !== false;
  const { courseId, feeAccountId } = input;
  const student = await Student.findOne({ where: { instituteId, id: input.studentId }, transaction });
  if (!student) throw NotFound('Student');
  const branchId = student.branchId;
  const found = await findApplication(student, courseId, transaction);

  let batchId: number | null = null;
  let addedToBatch = false;
  let batchIssue: PurchaseBatchIssue | null = null;
  const userId = student.userId;
  if (!userId) {
    if (!fallback) throw purchaseBatchError('no_login');
    batchIssue = 'no_login';
  } else {
    const current = await activeBatchForCourse(userId, courseId, { transaction });
    if (current) batchId = current.id;
    else {
      // Locks each batch row, so a seat found here is still free when the student is enrolled.
      const tryBatch = async (id: number) => {
        const { reason } = await batchAvailability(id, {
          courseId,
          branchId,
          studentUserId: userId,
          transaction,
        });
        if (reason) {
          if (!fallback) throw purchaseBatchError(reason);
          return { reason, added: false };
        }
        const { enrolled } = await enrollStudentsInBatch(id, [userId], { branchId, transaction });
        return { reason: null, added: enrolled.length > 0 };
      };
      const preferred = [input.batchId, fallback ? found?.batchId : null].filter((id): id is number => !!id);
      const open = fallback
        ? (await openBatchesForCourse(courseId, branchId, { transaction })).map((o) => o.batch.id)
        : [];
      for (const id of new Set([...preferred, ...open])) {
        const r = await tryBatch(id);
        if (r.reason) {
          if (id === input.batchId) batchIssue = r.reason;
          continue;
        }
        batchId = id;
        addedToBatch = r.added;
        break;
      }
      if (!batchId) {
        batchIssue ??= 'no_open_batch';
        if (!fallback) throw purchaseBatchError(batchIssue);
      }
    }
  }

  const newlyAdmitted = found?.status !== 'admitted';
  const application =
    found ??
    (await applicationRepo.create(
      {
        branchId,
        enquiryId: null,
        formId: null,
        name: student.name,
        mobile: student.mobile,
        email: student.email ?? null,
        courseId,
        batchId,
        formData: null,
        remarks: `Bought the course online (fee account #${feeAccountId})`,
      },
      { transaction },
    ));
  if (newlyAdmitted) {
    if (application.batchId !== batchId) await application.update({ batchId }, { transaction });
    await completeAdmission(application, { id: student.id, userId }, branchId, transaction, { enrol: false });
    await emitAdmissionCompleted(
      {
        applicationId: application.id,
        studentId: student.id,
        studentUserId: userId,
        branchId,
        courseId,
        batchId,
        feeAccountId,
      },
      { transaction },
    );
  } else if (addedToBatch) {
    if (!application.batchId) await application.update({ batchId }, { transaction });
    await recordHistory(
      student.id,
      'enrolled_in_batch',
      { to: `batch:${batchId}`, details: { courseId, batchId, source: 'course_purchase', feeAccountId } },
      transaction,
    );
  }

  transaction.afterCommit(async () => {
    try {
      if (newlyAdmitted)
        await audit({
          action: 'application.admitted',
          entityType: 'application',
          entityId: application.id,
          metadata: { studentId: student.id, source: 'course_purchase', feeAccountId, batchId, batchIssue },
        });
      if (newlyAdmitted || addedToBatch)
        await notifyAdmissionConfirmed({ id: application.id, courseId, batchId }, student);
    } catch (err) {
      logger.warn({ applicationId: application.id, err }, 'Course purchase admission follow-up failed');
    }
  });
  return {
    applicationId: application.id,
    branchId,
    studentUserId: userId,
    newlyAdmitted,
    batchId,
    addedToBatch,
    batchIssue,
  };
}

/**
 * Takes a student back out of the batch a course purchase put them in (full refund or cancellation).
 * The admission itself stays: the student remains on the rolls. Returns false when not enrolled.
 */
export async function releaseCoursePurchaseBatch(
  input: { studentId: number; studentUserId: number; batchId: number; feeAccountId: number },
  opts: { transaction: Transaction },
): Promise<boolean> {
  const left = await leaveBatch(input.batchId, input.studentUserId, { transaction: opts.transaction });
  if (left)
    await recordHistory(
      input.studentId,
      'left_batch',
      {
        from: `batch:${input.batchId}`,
        details: { batchId: input.batchId, source: 'course_refund', feeAccountId: input.feeAccountId },
      },
      opts.transaction,
    );
  return left;
}
