import { Op, type Transaction } from 'sequelize';
import type {
  AdmissionBatchEnrolment,
  ApplicationDto,
  CourseBatchOptionDto,
  EnquiryDto,
  EnquiryFollowUpDto,
} from '@erp/shared';
import { getSequelize } from '../../infrastructure/database/sequelize';
import { enqueueJob } from '../../infrastructure/jobs/queue';
import { logger } from '../../infrastructure/logger';
import { requireTenantContext } from '../../shared/context';
import { BadRequest, NotFound } from '../../shared/errors';
import {
  Batch,
  Course,
  batchAvailability,
  batchUnavailableError,
  enrollStudentsInBatch,
  openBatchesForCourse,
} from '../academics/api';
import { guardiansOf, notify, studentUserOf } from '../notifications/api';
import { TenantRepository } from '../../shared/tenancy/tenant-repository';
import { UserRole } from '../permissions/models';
import { User } from '../users/user.model';
import { Student } from '../students/api';
import { ensureStudentUser, recordHistory } from '../students/students.service';
import { getStudentSettings } from '../students/settings';
import { AdmissionApplication, Enquiry, EnquiryFollowUp } from './models';

export const FOLLOW_UP_REMINDER_JOB = 'admissions.follow-up-reminder';
export const FOLLOW_UP_DUE_EVENT = 'admissions.follow-up-due';

export const enquiryRepo = new TenantRepository(Enquiry, { entity: 'Enquiry', branchScoped: true });
export const applicationRepo = new TenantRepository(AdmissionApplication, {
  entity: 'Application',
  branchScoped: true,
});

const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);

export function toEnquiryDto(e: Enquiry): EnquiryDto {
  return {
    id: e.id,
    branchId: e.branchId,
    name: e.name,
    mobile: e.mobile,
    email: e.email,
    source: e.source,
    status: e.status,
    counsellorUserId: e.counsellorUserId,
    counsellorName: e.counsellor?.name ?? null,
    courseInterest: e.courseInterest,
    courseId: e.courseId,
    notes: e.notes,
    nextFollowUpAt: iso(e.nextFollowUpAt),
    studentId: e.studentId ?? null,
    customFields: e.customFields,
    createdAt: iso(e.createdAt)!,
  };
}

export function toFollowUpDto(f: EnquiryFollowUp): EnquiryFollowUpDto {
  return {
    id: f.id,
    enquiryId: f.enquiryId,
    note: f.note,
    scheduledAt: iso(f.scheduledAt),
    completedAt: iso(f.completedAt),
    remindedAt: iso(f.remindedAt),
    outcome: f.outcome,
    createdByUserId: f.createdByUserId,
    createdAt: iso(f.createdAt)!,
  };
}

/** Adds the course and batch names to application list rows. */
export async function withCourseNames(dtos: ApplicationDto[]): Promise<ApplicationDto[]> {
  const { instituteId } = requireTenantContext();
  const ids = (k: 'courseId' | 'batchId') => [...new Set(dtos.flatMap((d) => (d[k] ? [d[k]] : [])))];
  const [courseIds, batchIds] = [ids('courseId'), ids('batchId')];
  const [courses, batches] = await Promise.all([
    courseIds.length
      ? Course.findAll({ where: { instituteId, id: courseIds }, attributes: ['id', 'name'] })
      : [],
    batchIds.length
      ? Batch.findAll({ where: { instituteId, id: batchIds }, attributes: ['id', 'name'] })
      : [],
  ]);
  const courseNames = new Map(courses.map((c) => [c.id, c.name]));
  const batchNames = new Map(batches.map((b) => [b.id, b.name]));
  return dtos.map((d) => ({
    ...d,
    courseName: (d.courseId && courseNames.get(d.courseId)) || null,
    batchName: (d.batchId && batchNames.get(d.batchId)) || null,
  }));
}

export function toApplicationDto(a: AdmissionApplication): ApplicationDto {
  return {
    id: a.id,
    branchId: a.branchId,
    enquiryId: a.enquiryId,
    formId: a.formId,
    name: a.name,
    mobile: a.mobile,
    email: a.email,
    courseId: a.courseId,
    batchId: a.batchId,
    status: a.status,
    waitlistPosition: a.waitlistPosition ?? null,
    formData: a.formData,
    studentId: a.studentId ?? null,
    remarks: a.remarks ?? null,
    createdAt: iso(a.createdAt)!,
  };
}

/** Counsellors must be members of the institute (any role). */
export async function assertInstituteMember(userId: number) {
  const { instituteId } = requireTenantContext();
  if (!(await UserRole.count({ where: { instituteId, userId } })))
    throw BadRequest('Counsellor must be a member of this institute');
}

export async function assertValidSource(source: string) {
  const { enquirySources } = await getStudentSettings();
  if (!enquirySources.includes(source)) throw BadRequest(`Unknown enquiry source "${source}"`);
}

// ---------------------------------------------------------------- follow-up reminders

/** Schedules the counsellor reminder `followUpReminderMinutes` before the follow-up. */
export async function scheduleReminder(f: EnquiryFollowUp) {
  if (!f.scheduledAt || f.completedAt) return;
  const { followUpReminderMinutes } = await getStudentSettings();
  const runAt = new Date(Math.max(Date.now(), f.scheduledAt.getTime() - followUpReminderMinutes * 60_000));
  await enqueueJob(
    FOLLOW_UP_REMINDER_JOB,
    { followUpId: f.id, scheduledAt: f.scheduledAt.toISOString() },
    { runAt, instituteId: f.instituteId },
  );
}

/** Recomputes the enquiry's next open follow-up time. */
export async function refreshNextFollowUp(enquiry: Enquiry, transaction?: Transaction) {
  const next = await EnquiryFollowUp.findOne({
    where: {
      instituteId: enquiry.instituteId,
      enquiryId: enquiry.id,
      completedAt: null,
      scheduledAt: { [Op.ne]: null },
    },
    order: [['scheduledAt', 'ASC']],
    transaction,
  });
  await enquiry.update({ nextFollowUpAt: next?.scheduledAt ?? null }, { transaction });
}

/**
 * Job handler. Runs in a system context bound to the institute. Stale jobs (follow-up completed,
 * rescheduled or already reminded) are no-ops, so rescheduling just enqueues a fresh job.
 */
export async function followUpReminderJob(payload: Record<string, unknown>) {
  const { instituteId } = requireTenantContext();
  const followUp = await EnquiryFollowUp.findOne({ where: { instituteId, id: Number(payload.followUpId) } });
  if (!followUp || followUp.completedAt || followUp.remindedAt || !followUp.scheduledAt) return;
  // Rescheduled since this job was queued (DATETIME columns keep whole seconds only).
  const sec = (d: Date) => Math.floor(d.getTime() / 1000);
  if (sec(followUp.scheduledAt) !== sec(new Date(String(payload.scheduledAt)))) return;
  const enquiry = await Enquiry.findOne({ where: { instituteId, id: followUp.enquiryId } });
  if (!enquiry || ['converted', 'lost', 'not_interested'].includes(enquiry.status)) return;
  const recipientId = enquiry.counsellorUserId ?? followUp.createdByUserId;
  const recipient = recipientId ? await User.findByPk(recipientId) : null;
  if (!recipient) {
    logger.warn({ followUpId: followUp.id }, 'Follow-up reminder has no recipient');
    return;
  }
  const when = followUp.scheduledAt.toISOString().slice(0, 16).replace('T', ' ');
  await notify({
    event: FOLLOW_UP_DUE_EVENT,
    recipients: [{ userIds: [recipient.id] }],
    branchId: enquiry.branchId,
    data: {
      enquiry: { id: enquiry.id, name: enquiry.name, mobile: enquiry.mobile },
      followUpId: followUp.id,
      when,
      note: followUp.note ?? '',
    },
  });
  await followUp.update({ remindedAt: new Date() });
}

// ---------------------------------------------------------------- waitlist

function waitlistScope(a: { instituteId: number; branchId: number; courseId: number | null }) {
  return {
    instituteId: a.instituteId,
    branchId: a.branchId,
    courseId: a.courseId,
    status: 'waitlisted' as const,
  };
}

/** Next waitlist position for the application's branch + course. */
export async function nextWaitlistPosition(
  a: { instituteId: number; branchId: number; courseId: number | null },
  transaction?: Transaction,
) {
  const max = (await AdmissionApplication.max('waitlistPosition', {
    where: waitlistScope(a),
    transaction,
  })) as number | null;
  return (max ?? 0) + 1;
}

/** Removes the application from its waitlist and closes the gap behind it. */
export async function leaveWaitlist(a: AdmissionApplication, transaction: Transaction) {
  if (a.status !== 'waitlisted' || a.waitlistPosition == null) return;
  const position = a.waitlistPosition;
  await a.update({ waitlistPosition: null }, { transaction });
  await AdmissionApplication.decrement('waitlistPosition', {
    by: 1,
    where: { ...waitlistScope(a), waitlistPosition: { [Op.gt]: position } },
    transaction,
  });
}

export async function addToWaitlist(a: AdmissionApplication) {
  await getSequelize().transaction(async (transaction) => {
    const position = await nextWaitlistPosition(a, transaction);
    await a.update({ status: 'waitlisted', waitlistPosition: position }, { transaction });
  });
}

export async function moveInWaitlist(a: AdmissionApplication, target: number) {
  if (a.status !== 'waitlisted' || a.waitlistPosition == null)
    throw BadRequest('Application is not waitlisted');
  await getSequelize().transaction(async (transaction) => {
    const last = (await nextWaitlistPosition(a, transaction)) - 1;
    const to = Math.min(Math.max(1, target), last);
    const from = a.waitlistPosition!;
    if (to === from) return;
    const scope = waitlistScope(a);
    if (to < from)
      await AdmissionApplication.increment('waitlistPosition', {
        by: 1,
        where: { ...scope, waitlistPosition: { [Op.gte]: to, [Op.lt]: from } },
        transaction,
      });
    else
      await AdmissionApplication.decrement('waitlistPosition', {
        by: 1,
        where: { ...scope, waitlistPosition: { [Op.gt]: from, [Op.lte]: to } },
        transaction,
      });
    await a.update({ waitlistPosition: to }, { transaction });
  });
}

/**
 * Validates an application's batch through academics: it must exist in the institute, belong to the
 * application's branch and, when a course is given, to that course. Returns the batch's course id.
 */
export async function assertAdmissionBatch(
  batchId: number,
  branchId: number,
  courseId?: number | null,
): Promise<number> {
  const { instituteId } = requireTenantContext();
  const batch = await Batch.findOne({ where: { instituteId, id: batchId } });
  if (!batch) throw NotFound('Batch');
  if (batch.branchId !== branchId) throw BadRequest('The batch belongs to a different branch');
  if (courseId && batch.courseId !== courseId)
    throw BadRequest('The batch is not part of the selected course');
  return batch.courseId;
}

/**
 * Where an application is for, validated the same way when it is made and when it is edited: a
 * batch must be in the branch (and in the course, when one is given) and sets the course; a course
 * without a batch must exist in the institute. `currentCourseId` (an edit) is not looked up again.
 */
export async function resolveAdmissionPlacement(
  branchId: number,
  courseId: number | null | undefined,
  batchId: number | null | undefined,
  opts: { currentCourseId?: number | null } = {},
): Promise<{ courseId: number | null; batchId: number | null }> {
  if (batchId) return { courseId: await assertAdmissionBatch(batchId, branchId, courseId), batchId };
  if (courseId && courseId !== opts.currentCourseId) {
    const { instituteId } = requireTenantContext();
    if (!(await Course.count({ where: { instituteId, id: courseId } }))) throw NotFound('Course');
  }
  return { courseId: courseId ?? null, batchId: null };
}

/** The branch admitting puts the student in: their own for a linked application, else the application's. */
async function admissionBranchId(a: AdmissionApplication): Promise<number> {
  if (!a.studentId) return a.branchId;
  const student = await Student.findOne({
    where: { instituteId: a.instituteId, id: a.studentId },
    attributes: ['branchId'],
  });
  return student?.branchId ?? a.branchId;
}

/** Batches an application can be admitted into: open batches of its course, with free seats, in the student's branch. */
export async function admissionBatchOptions(a: AdmissionApplication): Promise<CourseBatchOptionDto[]> {
  if (!a.courseId) return [];
  const options = await openBatchesForCourse(a.courseId, await admissionBranchId(a));
  return options.map(({ batch, seatsLeft }) => ({
    id: batch.id,
    name: batch.name,
    startDate: batch.startDate,
    seatsLeft,
  }));
}

/**
 * Applies the batch chosen when admitting, inside the admit transaction: `null` admits without a
 * batch (assigned later in academics), a batch must be in the student's branch and the application's
 * course (or sets the course), and `undefined` keeps the application's batch.
 */
export async function chooseAdmissionBatch(
  a: AdmissionApplication,
  batchId: number | null | undefined,
  branchId: number,
  transaction: Transaction,
) {
  if (batchId === undefined || batchId === a.batchId) return;
  const courseId = batchId ? await assertAdmissionBatch(batchId, branchId, a.courseId) : a.courseId;
  await a.update({ batchId, courseId }, { transaction });
}

/**
 * Marks the application admitted (and its enquiry converted) and, when it names a batch, enrolls the
 * new student's login in it through academics (`batch_students`), inside the admit transaction so a
 * batch that can't take the student (409 BATCH_FULL / BATCH_CLOSED) rolls the admission back.
 * Every student has a login of their own, siblings sharing a parent's mobile included; one recorded
 * before that rule gets theirs here (`ensureStudentUser`).
 * `enrol: false` means the caller has already enrolled the student in `a.batchId` (e.g. a course
 * purchase picking a batch with free seats). Returns the student user ids newly added to the batch.
 */
export async function completeAdmission(
  a: AdmissionApplication,
  student: Student,
  branchId: number,
  transaction: Transaction,
  opts: { enrol?: boolean } = {},
): Promise<{ batchEnrolment: AdmissionBatchEnrolment; enrolled: number[] }> {
  const studentId = student.id;
  const { userId } = requireTenantContext();
  const studentUserId = await ensureStudentUser(student, transaction);
  await leaveWaitlist(a, transaction);
  await a.update(
    { status: 'admitted', studentId, decidedByUserId: userId ?? null, decidedAt: new Date() },
    { transaction },
  );
  let batchEnrolment: AdmissionBatchEnrolment = null;
  let enrolled: number[] = [];
  if (a.batchId) {
    if (opts.enrol !== false) {
      // Same rules as any batch choice for a course: open, in the course and branch, a free seat.
      if (a.courseId) {
        const { reason } = await batchAvailability(a.batchId, {
          courseId: a.courseId,
          branchId,
          studentUserId,
          transaction,
        });
        if (reason) throw batchUnavailableError(reason);
      }
      ({ enrolled } = await enrollStudentsInBatch(a.batchId, [studentUserId], { branchId, transaction }));
    }
    batchEnrolment = 'enrolled';
  }
  if (a.courseId || a.batchId)
    await recordHistory(
      studentId,
      'admitted_for_course',
      {
        to: a.courseId ? `course:${a.courseId}` : a.batchId ? `batch:${a.batchId}` : null,
        details: { courseId: a.courseId, batchId: a.batchId, branchId, batchEnrolment },
      },
      transaction,
    );
  if (a.enquiryId)
    await Enquiry.update(
      { status: 'converted', studentId },
      { where: { instituteId: a.instituteId, id: a.enquiryId }, transaction },
    );
  return { batchEnrolment, enrolled };
}

/**
 * Sends `admissions.confirmed` to the new student and their guardians. Called after the admit
 * transaction commits; a delivery problem never undoes the admission.
 */
export async function notifyAdmissionConfirmed(
  a: Pick<AdmissionApplication, 'id' | 'courseId' | 'batchId'>,
  student: { id: number; name: string; branchId: number },
) {
  try {
    const { instituteId } = requireTenantContext();
    const [course, batch] = await Promise.all([
      a.courseId ? Course.findOne({ where: { instituteId, id: a.courseId }, attributes: ['name'] }) : null,
      a.batchId ? Batch.findOne({ where: { instituteId, id: a.batchId }, attributes: ['name'] }) : null,
    ]);
    await notify({
      event: 'admissions.confirmed',
      recipients: [studentUserOf(student.id), guardiansOf(student.id)],
      branchId: student.branchId,
      data: {
        student: { id: student.id, name: student.name },
        course: course?.name ?? 'the institute',
        batch: batch?.name ?? 'batch to be assigned',
        applicationId: a.id,
      },
    });
  } catch (err) {
    logger.warn({ applicationId: a.id, err }, 'Admission confirmation notification failed');
  }
}
