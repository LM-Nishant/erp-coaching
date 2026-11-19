/** Student attendance (spec §4.6). Students are keyed by login user id, like academics rosters. */

export const ATTENDANCE_STATUSES = ['present', 'absent', 'late', 'leave', 'half_day'] as const;
export type AttendanceStatus = (typeof ATTENDANCE_STATUSES)[number];

/** Methods an institute can enable. `live` (live classroom) and `leave`/`correction` are system-applied. */
export const ATTENDANCE_METHODS = ['manual', 'mobile', 'qr', 'biometric'] as const;
export type AttendanceMethod = (typeof ATTENDANCE_METHODS)[number];
export type AttendanceRecordSource = AttendanceMethod | 'live' | 'leave' | 'correction' | 'system';

/** `class`: one attendance session per academics class session; `daily`: one per batch per day. */
export type AttendanceMode = 'class' | 'daily';
export type AttendanceSessionKind = 'class' | 'daily' | 'live';
export type AttendanceSessionStatus = 'open' | 'closed';
/** Who approves correction requests: applied immediately, the class teacher, or attendance admins. */
export type CorrectionApproval = 'auto' | 'teacher' | 'admin';
export type AttendanceRequestStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';
export type DeviceEventStatus = 'applied' | 'duplicate' | 'unmatched' | 'no_session' | 'ignored';

export interface Geofence {
  lat: number;
  lng: number;
  radiusM: number;
}

export interface AttendanceSettingsDto {
  mode: AttendanceMode;
  methods: AttendanceMethod[];
  /** Minutes after the class start at which a self check-in counts as late. */
  lateAfterMinutes: number;
  /** Self check-in (mobile/QR) opens this many minutes before class start… */
  checkInOpensMinutes: number;
  /** …and closes this many minutes after class start. */
  checkInClosesMinutes: number;
  qrRotateSeconds: number;
  requireGeofence: boolean;
  /** Geofence per branch id. */
  geofences: Record<string, Geofence>;
  correctionApproval: CorrectionApproval;
  /** Parents may also raise correction requests (students always can). */
  parentCorrections: boolean;
  /** Days after the session date within which corrections may be requested. */
  correctionWindowDays: number;
  absentAlerts: boolean;
  /** Approved-leave sessions are excluded from the percentage denominator. */
  excludeLeaveFromTotal: boolean;
  /** Half day counts as this fraction of a present day. */
  halfDayWeight: number;
  /** Shortage threshold (percentage) highlighted in reports. */
  minPercentage: number;
  /** A live-class student counts as present after watching at least this share (%) of the class. */
  liveMinPercent: number;
}

export interface AttendanceSessionDto {
  id: number;
  branchId: number;
  batchId: number;
  batchName?: string;
  classSessionId: number | null;
  subjectName?: string | null;
  kind: AttendanceSessionKind;
  date: string;
  startTime: string | null;
  endTime: string | null;
  teacherUserId: number | null;
  status: AttendanceSessionStatus;
  closedAt: string | null;
  counts?: Partial<Record<AttendanceStatus, number>> & { unmarked?: number; total?: number };
}

export interface RosterEntryDto {
  studentUserId: number;
  name: string;
  status: AttendanceStatus | null;
  source: AttendanceRecordSource | null;
  markedAt: string | null;
  remarks: string | null;
  onLeave: boolean;
}

export interface AttendanceRosterDto {
  session: AttendanceSessionDto;
  roster: RosterEntryDto[];
}

export interface QrTokenDto {
  token: string;
  expiresAt: string;
  rotateSeconds: number;
}

export interface CheckInResult {
  status: AttendanceStatus;
  duplicate: boolean;
  sessionId: number;
}

export interface AttendanceCorrectionDto {
  id: number;
  attendanceSessionId: number;
  studentUserId: number;
  studentName?: string;
  date?: string;
  batchName?: string;
  requestedByUserId: number;
  currentStatus: AttendanceStatus | null;
  requestedStatus: AttendanceStatus;
  reason: string;
  status: AttendanceRequestStatus;
  decidedByUserId: number | null;
  decidedAt: string | null;
  decisionNote: string | null;
  createdAt: string;
}

export interface StudentLeaveRequestDto {
  id: number;
  studentUserId: number;
  studentName?: string;
  requestedByUserId: number;
  fromDate: string;
  toDate: string;
  reason: string;
  status: AttendanceRequestStatus;
  decidedByUserId: number | null;
  decidedAt: string | null;
  decisionNote: string | null;
  createdAt: string;
}

export interface AttendanceTotals {
  present: number;
  absent: number;
  late: number;
  leave: number;
  half_day: number;
  /** Sessions counted in the denominator. */
  total: number;
  /** null when there is nothing to count. */
  percentage: number | null;
}

export interface StudentAttendanceReportRow extends AttendanceTotals {
  studentUserId: number;
  name: string;
  belowThreshold: boolean;
}

export interface GroupAttendanceReportRow extends AttendanceTotals {
  id: number;
  name: string;
  students: number;
}

export interface MonthlyAttendanceRow extends AttendanceTotals {
  month: string; // YYYY-MM
}

export interface StudentAttendanceSummaryDto {
  studentUserId: number;
  name: string;
  year: number;
  overall: AttendanceTotals;
  months: MonthlyAttendanceRow[];
  records: {
    date: string;
    batchName: string;
    subjectName: string | null;
    startTime: string | null;
    status: AttendanceStatus;
    source: AttendanceRecordSource;
    attendanceSessionId: number;
  }[];
}

/**
 * How a device sends punches: `api` = the generic punch API (serial + API key, any device or
 * middleware); `adms` = ZKTeco/eSSL ADMS push (`/iclock/*`, identified by serial number).
 */
export const DEVICE_PROTOCOLS = ['api', 'adms'] as const;
export type DeviceProtocol = (typeof DEVICE_PROTOCOLS)[number];

/** What an ADMS device reports about itself. */
export interface DeviceInfoDto {
  deviceName?: string;
  firmware?: string;
  platform?: string;
  vendor?: string;
  users?: number;
  fingerprints?: number;
  faces?: number;
  attLogs?: number;
  ip?: string;
  mac?: string;
  pushVersion?: string;
}

export interface AttendanceDeviceDto {
  id: number;
  branchId: number | null;
  name: string;
  serial: string;
  adapter: string;
  protocol: DeviceProtocol;
  active: boolean;
  lastSeenAt: string | null;
  /** Returned once, on create or key rotation (punch API devices only). */
  apiKey?: string;
  /** Zone of the device clock (IANA); null = the institute's zone. */
  timeZone: string | null;
  /** IPs/CIDRs allowed to push (ADMS); empty = any. */
  ipAllowlist: string[];
  /** Accept plain-HTTP pushes (ADMS devices without HTTPS firmware). */
  allowHttp: boolean;
  lastIp: string | null;
  info: DeviceInfoDto | null;
  lastError: string | null;
  lastErrorAt: string | null;
}

/** Commands queued for an ADMS device, delivered when it next polls. */
export const DEVICE_COMMAND_KINDS = [
  'sync_clock',
  'device_info',
  'fetch_users',
  'fetch_user',
  'fetch_logs',
] as const;
export type DeviceCommandKind = (typeof DEVICE_COMMAND_KINDS)[number];
export type DeviceCommandStatus = 'pending' | 'sent' | 'done' | 'failed' | 'expired';

export interface DeviceCommandDto {
  id: number;
  deviceId: number;
  kind: DeviceCommandKind;
  command: string;
  status: DeviceCommandStatus;
  /** Device return code (0 = success). */
  returnCode: number | null;
  createdAt: string;
  sentAt: string | null;
  completedAt: string | null;
}

/** Who a device user PIN belongs to. */
export type DevicePinTarget =
  { type: 'student'; studentUserId: number } | { type: 'employee'; employeeId: number };

/** A device user PIN with its mapping, merged from device user lists, mappings and punches. */
export interface DevicePinDto {
  pin: string;
  /** Name stored on the device, when a device reported its user list. */
  deviceName: string | null;
  deviceIds: number[];
  student: { userId: number; name: string } | null;
  /** Employee name is included only for users who can view HR. */
  employee: { id: number; name: string | null } | null;
  /** Mapped to a student or employee outside the caller's branches (who is not shown). */
  hidden: boolean;
  /** Unmatched punches with this PIN within the backfill window (`ADMS_BACKFILL_DAYS`). */
  unmatchedPunches: number;
  lastPunchAt: string | null;
}

/** Change a PIN's mapping; `target: null` unmaps it. */
export interface DevicePinUpdate {
  pin: string;
  target: DevicePinTarget | null;
}

export interface DeviceIngestResult {
  received: number;
  applied: number;
  duplicate: number;
  unmatched: number;
  noSession: number;
  ignored: number;
}

/** One class (class mode) or batch (daily mode) on the staff day view. */
export interface AttendanceDayItemDto {
  classSessionId: number | null;
  batchId: number;
  batchName: string;
  subjectName: string | null;
  startTime: string | null;
  endTime: string | null;
  attendance: {
    id: number;
    status: AttendanceSessionStatus;
    counts: Partial<Record<AttendanceStatus, number>>;
  } | null;
}

export interface AttendanceDayDto {
  date: string;
  mode: AttendanceMode;
  items: AttendanceDayItemDto[];
}

export interface CheckInOptionDto {
  classSessionId: number | null;
  batchId: number;
  batchName: string;
  subjectName: string | null;
  startTime: string | null;
  endTime: string | null;
  attendanceSessionId: number | null;
  sessionStatus: AttendanceSessionStatus | null;
  myStatus: AttendanceStatus | null;
  canCheckIn: boolean;
}

export interface CheckInOptionsDto {
  date: string;
  mode: AttendanceMode;
  methods: AttendanceMethod[];
  items: CheckInOptionDto[];
}

export interface BiometricEnrolmentDto {
  id: number;
  studentUserId: number;
  studentName: string;
  enrolmentId: string;
}

export interface DeviceEventDto {
  id: number;
  branchId: number | null;
  deviceId: number | null;
  deviceSerial: string;
  enrolmentId: string;
  punchedAt: string;
  direction: string | null;
  status: DeviceEventStatus;
  studentUserId: number | null;
  attendanceRecordId: number | null;
  note: string | null;
  createdAt: string;
}
