/**
 * Coverage configuration for the authorization and tenant-isolation suite (`test/security`).
 *
 * The suite reads every route from the route registry and probes it automatically. Most routes
 * need nothing here: the table behind a `/:id` param is inferred from the URL (`fees/heads/:id`
 * → `fee_heads`). Add an entry only when a test failure tells you to — the failure message names
 * the map and key. See CONTRIBUTING.md › "Authorization and tenant-isolation suite".
 */

/** Route params that are not record ids, with a sample value used to build URLs. */
export const NON_ID_PARAMS: Record<string, string> = {
  action: 'approve',
  channel: 'sms',
  eventKey: 'attendance.absent',
  gateway: 'mock',
  key: 'isolation.sample',
  name: 'index.m3u8',
  site: 'isolation-unknown-site',
  slug: 'isolation-unknown-slug',
  token: 'isolation-token',
  transition: 'accept',
  webhookKey: 'isolation-key',
};

/**
 * Table behind a route param, keyed by the path up to the param with earlier params as `*` and
 * without `/api/` (`/api/hr/employees/:id/contracts/:childId` → `hr/employees/*\/contracts`).
 * Only needed where the naming convention does not find the table.
 */
export const SEGMENT_TABLES: Record<string, string> = {
  'academics/schedules': 'class_schedules',
  'attendance/devices': 'attendance_devices',
  'attendance/leaves': 'attendance_leave_requests',
  'attendance/me/children': 'users',
  'attendance/me/leaves': 'attendance_leave_requests',
  'attendance/reports/students': 'users',
  'exams/children/results': 'exam_attempts',
  'exams/my': 'exams',
  'exams/my/results': 'exam_attempts',
  'fees/rules': 'fee_concession_rules',
  grievances: 'grievance_tickets',
  'guardian-portal/children': 'students',
  'hr/leaves': 'leave_applications',
  'hr/me/leaves': 'leave_applications',
  'live-classes': 'live_sessions',
  'lms/grants': 'lms_access_grants',
  'notifications/inbox': 'notification_messages',
  'payroll/settlements': 'final_settlements',
  'public/sites/*/checkout': 'courses',
  'public/sites/*/media': 'files',
  'website/referrals': 'website_referral_codes',
};

/** Table behind a param name wherever it appears. */
export const PARAM_TABLES: Record<string, string> = {
  deviceId: 'devices',
  studentId: 'students',
  studentUserId: 'users',
  teacherUserId: 'users',
  userId: 'users',
};

/** For params that point at `users`: the system role the user must have (param or segment key). */
export const USER_ROLE_HINTS: Record<string, string> = {
  studentUserId: 'student',
  teacherUserId: 'teacher',
  'attendance/me/children': 'student',
  'attendance/reports/students': 'student',
};

/** Table-name prefixes per module, used by the naming convention (`fees/heads` → `fee_heads`). */
export const TABLE_PREFIXES: Record<string, string[]> = {
  academics: ['academic', 'class'],
  admissions: ['admission'],
  appointments: ['appointment'],
  attendance: ['attendance'],
  exams: ['exam'],
  fees: ['fee', 'finance', 'bank', 'payment'],
  grievances: ['grievance'],
  hr: ['employee', 'employment', 'leave'],
  'live-classes': ['live'],
  lms: ['lms'],
  notifications: ['notification'],
  payroll: ['payroll', 'salary'],
  'question-bank': ['question'],
  students: ['student'],
  website: ['website'],
};

export interface ParamSql {
  /** Table of the record the route acts on (for messages and snapshots). */
  table: string;
  /**
   * Returns one column per route param. `:v` is the institute; add a `branchId` column to support
   * the branch crawl, and owner columns (see `owner`) to support the portal crawl.
   */
  sql: string;
  branch?: boolean;
  /** Result column → owner key (`student_user_id`, `student_id`, `user_id`, `employee_id`). */
  owner?: Record<string, string>;
}

/**
 * Custom resolution for routes whose params cannot be derived from one table's foreign keys
 * (keyed like `SEGMENT_TABLES`, by the segment of the route's last id param).
 */
export const PARAM_SQL: Record<string, ParamSql> = {
  'academics/batches/*/students': {
    table: 'batch_students',
    branch: true,
    owner: { student_user_id: 'student_user_id' },
    sql: `SELECT bs.batch_id AS id, bs.student_user_id AS studentUserId, bs.student_user_id,
                 b.branch_id AS branchId
            FROM batch_students bs JOIN batches b ON b.id = bs.batch_id
           WHERE bs.institute_id = :v`,
  },
  'exams/*/evaluations': {
    table: 'exam_answers',
    branch: true,
    owner: { student_user_id: 'student_user_id' },
    sql: `SELECT at.exam_id AS id, a.id AS answerId, at.student_user_id, at.branch_id AS branchId
            FROM exam_answers a JOIN exam_attempts at ON at.id = a.attempt_id
           WHERE a.institute_id = :v`,
  },
  'exams/my/attempts/*/answers': {
    table: 'exam_answers',
    branch: true,
    owner: { student_user_id: 'student_user_id' },
    sql: `SELECT at.id AS id, q.id AS eqId, at.student_user_id, at.branch_id AS branchId
            FROM exam_attempts at JOIN exam_questions q ON q.exam_id = at.exam_id
           WHERE at.institute_id = :v`,
  },
  'exams/my/attempts/*/answers/*/pages': {
    table: 'exam_answer_pages',
    branch: true,
    owner: { student_user_id: 'student_user_id' },
    sql: `SELECT at.id AS id, a.exam_question_id AS eqId, p.id AS pageId, at.student_user_id,
                 at.branch_id AS branchId
            FROM exam_answer_pages p
            JOIN exam_answers a ON a.id = p.answer_id
            JOIN exam_attempts at ON at.id = a.attempt_id
           WHERE p.institute_id = :v`,
  },
  'lms/uploads': {
    table: 'lms_upload_sessions',
    branch: true,
    owner: { user_id: 'user_id' },
    sql: `SELECT upload_id AS uploadId, branch_id AS branchId, user_id
            FROM lms_upload_sessions WHERE institute_id = :v`,
  },
  'public/sites/*/p': {
    table: 'website_pages',
    sql: `SELECT slug AS page FROM website_pages WHERE institute_id = :v AND published_version_id IS NOT NULL`,
  },
  'public/sites/*/pages': {
    table: 'website_pages',
    sql: `SELECT slug AS page FROM website_pages WHERE institute_id = :v AND published_version_id IS NOT NULL`,
  },
  'public/sites/*/forms': {
    table: 'website_pages',
    sql: `SELECT slug AS page FROM website_pages WHERE institute_id = :v AND published_version_id IS NOT NULL`,
  },
  'public/sites/*/r': {
    table: 'website_referral_codes',
    sql: `SELECT code FROM website_referral_codes WHERE institute_id = :v`,
  },
  'public/sites/*/referrals': {
    table: 'website_referral_codes',
    sql: `SELECT code FROM website_referral_codes WHERE institute_id = :v`,
  },
};

/**
 * Self-service routes: the caller acts on their own record, or their child's, so they are probed
 * by the portal crawl (student 1 vs student 2, guardian 1 vs guardian 2, employee 1 vs employee 2).
 * Matched in order; anything not listed is a staff route.
 */
export const SELF_FAMILIES: { family: 'student' | 'guardian' | 'employee'; pattern: RegExp }[] = [
  {
    family: 'guardian',
    pattern: /^\/api\/(parent-portal|guardian-portal)\/children\/|^\/api\/[^/]+\/(me\/)?children\//,
  },
  { family: 'employee', pattern: /^\/api\/(hr|payroll)\/me\// },
  {
    family: 'student',
    pattern: /^\/api\/[^/]+\/(my|me)\/|^\/api\/notifications\/inbox\/|^\/api\/auth\/devices\//,
  },
];

/**
 * Self-service routes whose record is shared by the whole institute rather than owned by the
 * caller (any student may get a quote for any course), so the portal crawl skips them.
 */
export const PORTAL_SHARED: Record<string, string> = {
  'GET /api/fees/me/courses/:id/quote': 'course catalogue is institute-wide',
  'POST /api/fees/me/courses/:id/checkout': 'course catalogue is institute-wide',
};

/**
 * Record routes whose record is deliberately shared by every branch even though it has a branch
 * (so the branch crawl skips them), with the reason.
 */
export const BRANCH_SHARED: Record<string, string> = {};

/** Authenticated routes that need no permission (self-service for any signed-in user). */
export const SELF_SERVICE_ROUTES: Record<string, string> = {
  'GET /api/auth/me': 'own profile',
  'POST /api/auth/select-institute': 'switch between own institutes',
  'GET /api/auth/devices': 'own devices',
  'DELETE /api/auth/devices/:id': 'own devices',
  'POST /api/auth/impersonation/stop': 'end own impersonation',
  'POST /api/lms/files': 'checks lms upload permission in the handler',
  'POST /api/lms/uploads': 'checks lms upload permission in the handler',
  'GET /api/lms/uploads/:uploadId': 'own upload sessions',
  'PUT /api/lms/uploads/:uploadId/chunk': 'own upload sessions',
  'POST /api/lms/uploads/:uploadId/complete': 'own upload sessions',
  'DELETE /api/lms/uploads/:uploadId': 'own upload sessions',
};

/** Public routes outside `/public/` (everything else public must live under `/api/public/...`). */
export const PUBLIC_OUTSIDE_PUBLIC_PREFIX: Record<string, string> = {
  'GET /api/health': 'liveness probe',
  'GET /api/ready': 'readiness probe',
  'POST /api/auth/login': 'sign-in',
  'POST /api/auth/otp/request': 'sign-in',
  'POST /api/auth/otp/verify': 'sign-in',
  'POST /api/auth/refresh': 'refresh token is the credential',
  'POST /api/auth/logout': 'refresh token is the credential',
  'GET /api/files/signed/:token': 'signed URL is the credential',
};

/**
 * Column values for rows the synthesizer creates (victim-data.ts), per table, where the schema
 * alone does not produce a record its owner can read (e.g. a page must be `published` to be public).
 */
export const SYNTHESIS_HINTS: Record<string, Record<string, string | number | null>> = {};

/**
 * GET routes whose owner (positive control) cannot return 2xx for a valid record, with the
 * statuses that are acceptable and why. Prefer creating victim data in the right state instead.
 */
export const OWNER_STATUS: Record<string, { status: number[]; reason: string }> = {};

/**
 * Routes the crawls cannot probe yet, with the reason. A stale entry (the route is gone, or now
 * covered) fails the suite so the list stays honest.
 */
export const KNOWN_UNCOVERED: Record<string, string> = {};
