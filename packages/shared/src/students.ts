/** Admissions, students and guardians (spec §2, §4.3, §4.12). */

export const STUDENT_STATUSES = ['active', 'suspended', 'discontinued', 'inactive'] as const;
export type StudentStatus = (typeof STUDENT_STATUSES)[number];

export const STUDENT_SOURCES = ['self_registration', 'admin', 'enquiry', 'application'] as const;
export type StudentSource = (typeof STUDENT_SOURCES)[number];

export const ENQUIRY_STATUSES = [
  'new',
  'contacted',
  'follow_up',
  'interested',
  'not_interested',
  'converted',
  'lost',
] as const;
export type EnquiryStatus = (typeof ENQUIRY_STATUSES)[number];

export const DEFAULT_ENQUIRY_SOURCES = [
  'walk_in',
  'website',
  'phone',
  'referral',
  'social_media',
  'advertisement',
  'other',
] as const;

export const APPLICATION_STATUSES = [
  'pending',
  'waitlisted',
  'approved',
  'rejected',
  'admitted',
  'withdrawn',
] as const;
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

export const GUARDIAN_RELATIONS = ['father', 'mother', 'guardian', 'sibling', 'relative', 'other'] as const;
export type GuardianRelation = (typeof GUARDIAN_RELATIONS)[number];

/** `pending` links (e.g. created from public self-registration for an existing account) need admin approval. */
export type GuardianLinkStatus = 'active' | 'pending' | 'revoked';

export const FORM_FIELD_TYPES = [
  'text',
  'textarea',
  'number',
  'date',
  'email',
  'phone',
  'select',
  'checkbox',
] as const;
export type FormFieldType = (typeof FORM_FIELD_TYPES)[number];

/** Institute-defined custom field on an admission / enquiry / self-registration form. */
export interface FormFieldDef {
  /** snake_case key stored in `customFields`. */
  key: string;
  label: string;
  type: FormFieldType;
  required?: boolean;
  options?: string[];
  helpText?: string;
}

export type AdmissionFormPurpose = 'enquiry' | 'admission' | 'self_registration';

export interface AdmissionFormDto {
  id: number;
  branchId: number | null;
  name: string;
  description: string | null;
  purpose: AdmissionFormPurpose;
  fields: FormFieldDef[];
  isActive: boolean;
}

/**
 * Number formats support tokens: `{YYYY}` `{YY}` `{MM}` `{INST}` (institute slug, upper case)
 * `{BRANCH}` (branch code) and `{SEQ:n}` (zero-padded sequence, n = width). The sequence counter is
 * kept per rendered prefix, so `{YYYY}` resets numbering every year and `{BRANCH}` keeps one series
 * per branch.
 */
export interface StudentSettings {
  admissionNumberFormat: string;
  rollNumberFormat: string;
  /** Generate a roll number automatically on admission. */
  autoRollNumber: boolean;
  /** Max active guardians per student. */
  maxGuardiansPerStudent: number;
  selfRegistrationEnabled: boolean;
  /** Branch used for self-registrations that don't pick one; null = first active branch. */
  defaultBranchId: number | null;
  enquirySources: string[];
  /** Follow-up reminder lead time in minutes. */
  followUpReminderMinutes: number;
}

export const DEFAULT_STUDENT_SETTINGS: StudentSettings = {
  admissionNumberFormat: '{INST}/{YYYY}/{SEQ:5}',
  rollNumberFormat: '{BRANCH}-{SEQ:4}',
  autoRollNumber: true,
  maxGuardiansPerStudent: 2,
  selfRegistrationEnabled: true,
  defaultBranchId: null,
  enquirySources: [...DEFAULT_ENQUIRY_SOURCES],
  followUpReminderMinutes: 30,
};

export interface AcademicInfo {
  schoolName?: string | null;
  classGrade?: string | null;
  board?: string | null;
  previousPercentage?: number | null;
  targetExam?: string | null;
}

export interface StudentDto {
  id: number;
  branchId: number;
  userId: number | null;
  admissionNumber: string;
  rollNumber: string | null;
  name: string;
  mobile: string;
  email: string | null;
  dateOfBirth: string | null;
  gender: 'male' | 'female' | 'other' | null;
  address: string | null;
  city: string | null;
  state: string | null;
  pincode: string | null;
  idType: string | null;
  idNumber: string | null;
  academicInfo: AcademicInfo | null;
  customFields: Record<string, unknown> | null;
  status: StudentStatus;
  statusReason: string | null;
  source: StudentSource;
  admittedAt: string;
  createdAt: string;
}

export interface StudentGuardianDto {
  linkId: number;
  guardianId: number;
  userId: number;
  name: string;
  mobile: string;
  email: string | null;
  relation: GuardianRelation;
  isPrimary: boolean;
  status: GuardianLinkStatus;
}

export interface StudentDocumentDto {
  id: number;
  docType: string;
  title: string | null;
  fileId: number;
  originalName: string;
  mimeType: string;
  url: string;
  createdAt: string;
}

export interface StudentHistoryDto {
  id: number;
  eventType: string;
  fromValue: string | null;
  toValue: string | null;
  details: Record<string, unknown> | null;
  actorUserId: number | null;
  createdAt: string;
}

export interface AcademicRecordDto {
  id: number;
  academicYear: string | null;
  institution: string | null;
  classGrade: string | null;
  board: string | null;
  result: string | null;
  percentage: number | null;
  remarks: string | null;
}

export interface StudentProfileDto extends StudentDto {
  guardians: StudentGuardianDto[];
  documents: StudentDocumentDto[];
  academicRecords: AcademicRecordDto[];
  history: StudentHistoryDto[];
}

export interface DuplicateMatch {
  kind: 'student' | 'enquiry' | 'application';
  id: number;
  name: string;
  mobile: string;
  reference: string | null;
  matchedOn: ('mobile' | 'email' | 'idNumber')[];
}

export interface SelfRegistrationInfo {
  institute: { name: string; slug: string };
  enabled: boolean;
  branches: { id: number; name: string }[];
  fields: FormFieldDef[];
}

export interface SelfRegistrationInput {
  name: string;
  mobile: string;
  password?: string;
  email?: string | null;
  branchId?: number;
  dateOfBirth?: string | null;
  gender?: 'male' | 'female' | 'other' | null;
  academicInfo?: AcademicInfo | null;
  parent?: { name: string; mobile: string; email?: string | null; relation?: GuardianRelation } | null;
  customFields?: Record<string, unknown>;
}

export interface SelfRegistrationResult {
  studentId: number;
  admissionNumber: string;
  rollNumber: string | null;
  status: StudentStatus;
  /** False when the account has no password yet: sign in with mobile OTP. */
  hasPassword: boolean;
}

export interface EnquiryDto {
  id: number;
  branchId: number;
  name: string;
  mobile: string;
  email: string | null;
  source: string;
  status: EnquiryStatus;
  counsellorUserId: number | null;
  counsellorName?: string | null;
  courseInterest: string | null;
  courseId: number | null;
  notes: string | null;
  nextFollowUpAt: string | null;
  studentId: number | null;
  customFields: Record<string, unknown> | null;
  createdAt: string;
}

export interface EnquiryFollowUpDto {
  id: number;
  enquiryId: number;
  note: string | null;
  scheduledAt: string | null;
  completedAt: string | null;
  remindedAt: string | null;
  outcome: string | null;
  createdByUserId: number | null;
  createdAt: string;
}

export interface ApplicationDto {
  id: number;
  branchId: number;
  enquiryId: number | null;
  formId: number | null;
  name: string;
  mobile: string;
  email: string | null;
  courseId: number | null;
  batchId: number | null;
  status: ApplicationStatus;
  waitlistPosition: number | null;
  formData: Record<string, unknown> | null;
  studentId: number | null;
  remarks: string | null;
  createdAt: string;
}

export interface ChildSummaryDto {
  studentId: number;
  name: string;
  admissionNumber: string;
  rollNumber: string | null;
  branchId: number;
  branchName: string | null;
  status: StudentStatus;
  relation: GuardianRelation;
  isPrimary: boolean;
}

export interface GuardianDto {
  id: number;
  userId: number;
  name: string;
  mobile: string;
  email: string | null;
  occupation: string | null;
  address: string | null;
  children: {
    linkId: number;
    studentId: number;
    name: string;
    relation: GuardianRelation;
    status: GuardianLinkStatus;
  }[];
}
