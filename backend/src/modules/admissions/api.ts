/** Public cross-module API of the admissions module. Import from here, not from internal files. */
import type { Transaction } from 'sequelize';
import { enquiryRepo } from './admissions.service';
import type { Enquiry } from './models';

export {
  onAdmissionCompleted,
  type AdmissionCompletedEvent,
  type AdmissionCompletedListener,
} from './admission-events';
export { activeForm, validateCustomFields } from './forms.service';

export interface CreateEnquiryInput {
  branchId: number;
  name: string;
  mobile: string;
  email?: string | null;
  source: string;
  counsellorUserId?: number | null;
  courseInterest?: string | null;
  courseId?: number | null;
  notes?: string | null;
  customFields?: Record<string, unknown> | null;
  createdByUserId?: number | null;
}

/**
 * Creates an enquiry in the current tenant context (e.g. website enquiry/demo forms). The caller
 * validates the input (branch, custom fields, course) and writes its own audit entry.
 */
export function createEnquiry(
  input: CreateEnquiryInput,
  opts: { transaction?: Transaction } = {},
): Promise<Enquiry> {
  return enquiryRepo.create(
    {
      branchId: input.branchId,
      name: input.name,
      mobile: input.mobile,
      email: input.email ?? null,
      source: input.source,
      counsellorUserId: input.counsellorUserId ?? null,
      courseInterest: input.courseInterest ?? null,
      courseId: input.courseId ?? null,
      notes: input.notes ?? null,
      customFields: input.customFields ?? null,
      createdByUserId: input.createdByUserId ?? null,
    },
    opts,
  );
}

/** Read-only report queries (reports module, spec §4.17); callers pass a validated `ReportScope`. */
export { admissionFunnelReport } from './reporting';
