/**
 * Self-registration for a course (`/register/:slug?courseId=…&ref=…`) → an admissions intent the
 * admissions team can act on: an enquiry (source `referral` when the referral code was counted,
 * else `website`) and a pending application for the course, both linked to the new student. An
 * open enquiry or application the same person made earlier without a student record is linked
 * instead of being duplicated. Admitting the application admits that student (no new record).
 */
import { Op } from 'sequelize';
import { getSequelize } from '../../infrastructure/database/sequelize';
import { audit } from '../../shared/audit/audit.service';
import { requireTenantContext } from '../../shared/context';
import { Course } from '../academics/api';
import { applicationRepo, enquiryRepo } from './admissions.service';
import { AdmissionApplication, Enquiry } from './models';

export interface SelfRegistrationIntentInput {
  student: {
    id: number;
    name: string;
    mobile: string;
    email: string | null;
    branchId: number;
    admissionNumber: string;
  };
  courseId: number;
  referralCode?: string | null;
  /** True when the referral code was recognised and the signup counted for it. */
  referralCounted?: boolean;
}

export interface SelfRegistrationIntent {
  courseId: number;
  enquiryId: number;
  applicationId: number;
  /** True when an earlier enquiry / application of the same person was linked instead of created. */
  linkedEnquiry: boolean;
  linkedApplication: boolean;
}

const OPEN_ENQUIRY = ['new', 'contacted', 'follow_up', 'interested'] as const;
const OPEN_APPLICATION = ['pending', 'waitlisted', 'approved'] as const;

/**
 * Records the intent in the current tenant context. Returns null (and records nothing) when the
 * course is not an active course of the institute.
 */
export async function recordSelfRegistrationIntent(
  input: SelfRegistrationIntentInput,
): Promise<SelfRegistrationIntent | null> {
  const { instituteId } = requireTenantContext();
  const { student } = input;
  const course = await Course.findOne({
    where: { instituteId, id: input.courseId, status: 'active', isTemplate: false },
    attributes: ['id', 'name'],
  });
  if (!course) return null;
  const code = input.referralCode?.trim().toUpperCase() || null;
  const referral = code ? `, referral code ${code}${input.referralCounted ? '' : ' (not recognised)'}` : '';
  const note = `Self-registered online for ${course.name} (admission no. ${student.admissionNumber})${referral}.`;

  const intent = await getSequelize().transaction(async (transaction) => {
    const lock = transaction.LOCK.UPDATE;
    const unlinked = { instituteId, branchId: student.branchId, mobile: student.mobile, studentId: null };
    const application = await AdmissionApplication.findOne({
      where: {
        ...unlinked,
        courseId: course.id,
        name: student.name,
        status: { [Op.in]: [...OPEN_APPLICATION] },
      },
      order: [['id', 'DESC']],
      transaction,
      lock,
    });
    // The application's own enquiry (whatever its status) is the lead; else an open unlinked one.
    let enquiry = application?.enquiryId
      ? await Enquiry.findOne({ where: { instituteId, id: application.enquiryId }, transaction, lock })
      : null;
    enquiry ??= await Enquiry.findOne({
      where: {
        ...unlinked,
        status: { [Op.in]: [...OPEN_ENQUIRY] },
        [Op.or]: [{ courseId: course.id }, { courseId: null }],
      },
      order: [['id', 'DESC']],
      transaction,
      lock,
    });

    const linkedEnquiry = !!enquiry;
    if (enquiry)
      await enquiry.update(
        {
          studentId: enquiry.studentId ?? student.id,
          courseId: enquiry.courseId ?? course.id,
          courseInterest: enquiry.courseInterest ?? course.name,
          notes: [enquiry.notes, note].filter(Boolean).join('\n'),
        },
        { transaction },
      );
    else
      enquiry = await enquiryRepo.create(
        {
          branchId: student.branchId,
          name: student.name,
          mobile: student.mobile,
          email: student.email,
          source: input.referralCounted ? 'referral' : 'website',
          counsellorUserId: null,
          courseInterest: course.name,
          courseId: course.id,
          notes: note,
          studentId: student.id,
          customFields: null,
          createdByUserId: null,
        },
        { transaction },
      );

    const linkedApplication = !!application;
    const app = application
      ? await application.update(
          { studentId: student.id, enquiryId: application.enquiryId ?? enquiry.id },
          { transaction },
        )
      : await applicationRepo.create(
          {
            branchId: student.branchId,
            enquiryId: enquiry.id,
            formId: null,
            name: student.name,
            mobile: student.mobile,
            email: student.email,
            courseId: course.id,
            batchId: null,
            formData: null,
            studentId: student.id,
            remarks: note.slice(0, 255),
          },
          { transaction },
        );
    return {
      courseId: course.id,
      enquiryId: enquiry.id,
      applicationId: app.id,
      linkedEnquiry,
      linkedApplication,
    };
  });

  const metadata = { source: 'self_registration', studentId: student.id, courseId: course.id };
  await audit({
    action: intent.linkedEnquiry ? 'enquiry.updated' : 'enquiry.created',
    entityType: 'enquiry',
    entityId: intent.enquiryId,
    metadata,
  });
  await audit({
    action: intent.linkedApplication ? 'application.linked' : 'application.created',
    entityType: 'application',
    entityId: intent.applicationId,
    metadata: { ...metadata, enquiryId: intent.enquiryId },
  });
  return intent;
}
