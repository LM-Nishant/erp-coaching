/** Parent-teacher appointments (spec §4.16). */

export const APPOINTMENT_MODES = ['online', 'offline'] as const;
export type AppointmentMode = (typeof APPOINTMENT_MODES)[number];

/** Modes a teacher offers in an availability slot. */
export const SLOT_MODES = ['online', 'offline', 'both'] as const;
export type SlotMode = (typeof SLOT_MODES)[number];

export const SLOT_KINDS = ['recurring', 'one_off'] as const;
export type SlotKind = (typeof SLOT_KINDS)[number];

export const APPOINTMENT_STATUSES = [
  'requested',
  'confirmed',
  'rejected',
  'cancelled',
  'completed',
  'no_show',
] as const;
export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number];

/** Statuses that occupy the teacher's time (block other bookings). */
export const ACTIVE_APPOINTMENT_STATUSES: readonly AppointmentStatus[] = ['requested', 'confirmed'];

export type AppointmentEventAction =
  | 'requested'
  | 'approved'
  | 'rejected'
  | 'rescheduled'
  | 'cancelled'
  | 'completed'
  | 'no_show'
  | 'notes_updated'
  | 'reminder_sent';

export interface AppointmentSlotDto {
  id: number;
  branchId: number;
  teacherUserId: number;
  teacherName: string | null;
  kind: SlotKind;
  /** 0 = Sunday … 6 = Saturday (recurring slots). */
  dayOfWeek: number | null;
  /** `YYYY-MM-DD` (one-off slots). */
  date: string | null;
  startTime: string;
  endTime: string;
  slotMinutes: number;
  mode: SlotMode;
  location: string | null;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  isActive: boolean;
}

export interface AppointmentSlotInput {
  branchId?: number;
  /** Staff with `appointments.configure` may manage another teacher's slots. */
  teacherUserId?: number;
  kind: SlotKind;
  dayOfWeek?: number | null;
  date?: string | null;
  startTime: string;
  endTime: string;
  slotMinutes?: number;
  mode?: SlotMode;
  location?: string | null;
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
  isActive?: boolean;
}

/** A bookable chunk of a teacher's availability. */
export interface AvailableSlotDto {
  slotId: number;
  branchId: number;
  date: string;
  startTime: string;
  endTime: string;
  modes: AppointmentMode[];
  location: string | null;
}

export interface AppointmentTeacherDto {
  teacherUserId: number;
  name: string;
  batches: { id: number; name: string; subject: string | null }[];
}

export interface AppointmentUserRef {
  id: number;
  name: string;
}

export interface AppointmentDto {
  id: number;
  branchId: number;
  slotId: number | null;
  teacher: AppointmentUserRef | null;
  requestedBy: AppointmentUserRef | null;
  studentId: number;
  studentName: string | null;
  date: string;
  startTime: string;
  endTime: string;
  mode: AppointmentMode;
  status: AppointmentStatus;
  agenda: string | null;
  location: string | null;
  meetingUrl: string | null;
  responseNote: string | null;
  cancelReason: string | null;
  rescheduleCount: number;
  /** Visible to the parent once written. */
  sharedSummary: string | null;
  /** Only returned to the teacher and staff managing appointments; never to parents. */
  privateNotes?: string | null;
  completedAt: string | null;
  createdAt: string;
}

export interface AppointmentEventDto {
  id: number;
  action: AppointmentEventAction;
  actor: AppointmentUserRef | null;
  fromStatus: AppointmentStatus | null;
  toStatus: AppointmentStatus | null;
  note: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export interface AppointmentDetailDto extends AppointmentDto {
  history: AppointmentEventDto[];
}

export interface RequestAppointmentInput {
  studentId: number;
  teacherUserId: number;
  date: string;
  startTime: string;
  mode: AppointmentMode;
  agenda?: string | null;
}

export interface AppointmentReportSummary {
  total: number;
  byStatus: Record<AppointmentStatus, number>;
  byMode: Record<AppointmentMode, number>;
  byBranch: { branchId: number; branchName: string | null; total: number; completed: number }[];
  byTeacher: {
    teacherUserId: number;
    teacherName: string | null;
    total: number;
    confirmed: number;
    completed: number;
    rejected: number;
    cancelled: number;
  }[];
  /** Average hours from request to the teacher's first response (approve/reject/reschedule). */
  avgResponseHours: number | null;
}
