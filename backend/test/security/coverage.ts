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
  'tenant-data/exports': 'data_exports',
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
  /** Nullable foreign keys a synthesized `table` row must set for `sql` to find it. */
  need?: string[];
}

/**
 * Custom resolution for routes whose params cannot be derived from one table's foreign keys, keyed
 * by route (`GET /api/lms/courses/:id/contents`, checked first) or like `SEGMENT_TABLES`, by the
 * segment of the route's last id param (applies to every route under that segment).
 */
export const PARAM_SQL: Record<string, ParamSql> = {
  'GET /api/fees/me/courses/:id/quote': {
    table: 'fee_structures',
    need: ['course_id'],
    sql: `SELECT course_id AS id FROM fee_structures
           WHERE institute_id = :v AND course_id IS NOT NULL AND batch_id IS NULL
             AND status = 'active' AND kind = 'course'`,
  },
  'GET /api/lms/courses/:id/contents': {
    table: 'lms_access_grants',
    owner: { student_user_id: 'student_user_id' },
    sql: `SELECT course_id AS id, student_user_id FROM lms_access_grants
           WHERE institute_id = :v AND revoked_at IS NULL
             AND (valid_until IS NULL OR valid_until > UTC_TIMESTAMP())`,
  },
  'attendance/reports/students': {
    table: 'attendance_records',
    branch: true,
    owner: { student_user_id: 'student_user_id' },
    sql: `SELECT student_user_id AS id, student_user_id, branch_id AS branchId
            FROM attendance_records WHERE institute_id = :v`,
  },
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
    table: 'exam_evaluations',
    branch: true,
    owner: { student_user_id: 'student_user_id' },
    sql: `SELECT at.exam_id AS id, a.id AS answerId, at.student_user_id, at.branch_id AS branchId
            FROM exam_evaluations e
            JOIN exam_answers a ON a.id = e.answer_id
            JOIN exam_attempts at ON at.id = a.attempt_id
           WHERE e.institute_id = :v`,
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
  'public/sites/*/media': {
    table: 'files',
    sql: `SELECT CAST(JSON_EXTRACT(v.media_file_ids, '$[0]') AS UNSIGNED) AS fileId
            FROM website_page_versions v JOIN website_pages p ON p.published_version_id = v.id
           WHERE v.institute_id = :v AND JSON_LENGTH(v.media_file_ids) > 0`,
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
    pattern:
      /^\/api\/[^/]+\/(my|me)\/|^\/api\/notifications\/inbox\/|^\/api\/auth\/devices\/|^\/api\/lms\/courses\/:id\/contents$/,
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
  'GET /api/subscription/status': 'subscription banner state for every member',
  'DELETE /api/auth/devices/:id': 'own devices',
  'POST /api/auth/activity': 'own session keep-alive (inactivity timeout)',
  'POST /api/auth/capture-events': 'reports screen capture on own device',
  'POST /api/auth/biometric': 'enrol own device for biometric unlock',
  'DELETE /api/auth/biometric': 'remove own biometric unlock',
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
  'POST /api/auth/biometric/unlock': 'sign-in (device-bound unlock key is the credential)',
  'POST /api/auth/refresh': 'refresh token is the credential',
  'POST /api/auth/logout': 'refresh token is the credential',
  'GET /api/files/signed/:token': 'signed URL is the credential',
};

/**
 * Column values for rows the synthesizer creates (victim-data.ts), per table, where the schema
 * alone does not produce a record its owner can read (e.g. results must be published to be seen).
 * Objects and arrays are stored as JSON.
 */
export const SYNTHESIS_HINTS: Record<string, Record<string, unknown>> = {
  exams: { status: 'scheduled', results_published_at: '2024-06-01 10:00:00' },
  // Resumable by its student; result views do not depend on the attempt's status.
  exam_attempts: { status: 'in_progress', deadline_at: '2099-12-31 00:00:00', question_order: [] },
  exam_questions: {
    snapshot: {
      type: 'descriptive',
      text: 'Synthesized question',
      options: [],
      answerKey: {},
      explanation: null,
      assetFileIds: [],
      chapterId: null,
      chapterName: null,
      topicId: null,
      topicName: null,
    },
  },
  // Payslips are visible to the employee, and printable, once their run is locked.
  payroll_runs: { status: 'locked' },
  fee_structures: { status: 'active', kind: 'course', instalment_plan: { type: 'one_time' } },
};

/** Query string a route needs to get past validation (`?date=…`), keyed by route. */
export const ROUTE_QUERY: Record<string, Record<string, string>> = {
  'GET /api/academics/classrooms/:id/availability': { date: '2030-01-07' },
  'GET /api/appointments/teachers/:teacherUserId/availability': { from: '2030-01-07', to: '2030-01-13' },
};

/**
 * GET routes whose owner (positive control) cannot return 2xx/3xx for a valid record, with the
 * statuses that are acceptable and why. Prefer creating victim data in the right state instead.
 */
export const OWNER_STATUS: Record<string, { status: number[]; reason: string }> = {
  'GET /api/exams/:id/evaluations/:answerId/history': {
    status: [409],
    reason: 'synthesized attempts stay in progress for the resume routes; history exists once submitted',
  },
};

/**
 * Routes that deliberately answer every caller the same way whether or not the record exists (so
 * the response cannot reveal it), with the reason. Their probes accept any status below 500; the
 * leak checks (marker in the body, rows of the other institute loaded) still apply.
 */
export const UNIFORM_RESPONSE: Record<string, string> = {
  'GET /api/public/sites/:site/r/:code':
    "unknown referral codes redirect to the site's home page, like known ones",
  'POST /api/public/sites/:site/referrals/:code/click': 'click tracking always answers 200',
};

/**
 * Open security findings the suite detects, keyed `<crawl> <METHOD> <path>` (crawls: cross-tenant,
 * branch, student, guardian, employee, public, tenant-lists, branch-lists), with severity and
 * description. Their failures are reported as known instead of failing the suite. Fix the route and
 * remove the entry: an entry that no longer fails is stale and fails the suite. Critical and high
 * findings must be fixed, never listed here. Also listed in docs/security.md.
 */
export const KNOWN_FINDINGS: Record<string, string> = {
  'branch-lists GET /api/guardians':
    'low: a guardian with children in several branches lists all of them (names included) to staff restricted to one of those branches',
  'branch-lists GET /api/audit-events':
    'medium: the audit log is not branch-filtered, so branch-restricted staff with audit access see events (and their metadata) from every branch',
};

/**
 * Routes the crawls cannot probe yet, with the reason. A stale entry (the route is gone, or now
 * covered) fails the suite so the list stays honest.
 */
export const KNOWN_UNCOVERED: Record<string, string> = {};
