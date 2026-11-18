import {
  SqlFilter,
  isoInstant,
  limitSql,
  num,
  reportQuery,
  utcSql,
  type ReportScope,
} from '../../shared/reporting';

/** Read-only student report queries for the reports module (spec §4.17). */

const WITHDRAWN = ['discontinued', 'inactive'];
const ADMITTED_AT = 'COALESCE(s.admitted_at, s.created_at)';

/** Students rows in scope (branch, own/children, and course/batch membership). */
function studentFilter(scope: ReportScope) {
  const f = new SqlFilter()
    .where('s.institute_id = ?', scope.instituteId)
    .in('s.branch_id', scope.branchIds)
    .in('s.id', scope.studentIds)
    .in('s.user_id', scope.studentUserIds);
  if (scope.courseId || scope.batchId || scope.batchIds) {
    const cohort = f
      .nested()
      .eq('b.course_id', scope.courseId)
      .eq('b.id', scope.batchId)
      .in('b.id', scope.batchIds);
    f.where(
      `EXISTS (SELECT 1 FROM batch_students bs JOIN batches b ON b.id = bs.batch_id
        WHERE bs.institute_id = s.institute_id AND bs.student_user_id = s.user_id AND ${cohort.sql})`,
    );
  }
  return f;
}

/** Admissions (by admission date) and withdrawals (status changed to discontinued/inactive). */
export async function studentMovementReport(scope: ReportScope) {
  const f = studentFilter(scope);
  f.params.start = utcSql(scope.start);
  f.params.end = utcSql(scope.end);
  const admittedWhere = `${f.sql} AND ${ADMITTED_AT} >= :start AND ${ADMITTED_AT} < :end`;
  const withdrawnWhere = `${f.sql} AND h.institute_id = s.institute_id AND h.event_type = 'status_changed'
    AND h.to_value IN (:withdrawn) AND h.created_at >= :start AND h.created_at < :end`;
  f.params.withdrawn = WITHDRAWN;
  const fromHistory = 'FROM student_history h JOIN students s ON s.id = h.student_id';

  const [t] = await reportQuery<Record<string, unknown>>(
    `SELECT COUNT(*) total, SUM(s.status = 'active') active,
       SUM(${ADMITTED_AT} >= :start AND ${ADMITTED_AT} < :end) admitted
     FROM students s WHERE ${f.sql}`,
    f.params,
  );
  const [w] = await reportQuery<Record<string, unknown>>(
    `SELECT COUNT(*) events, COUNT(DISTINCT h.student_id) students ${fromHistory} WHERE ${withdrawnWhere}`,
    f.params,
  );
  const totals = {
    students: num(t?.total),
    active: num(t?.active),
    admitted: num(t?.admitted),
    withdrawn: num(w?.students),
  };

  const branchRows = await reportQuery<Record<string, unknown>>(
    `SELECT s.branch_id, br.name branch, SUM(s.status = 'active') active,
       SUM(${ADMITTED_AT} >= :start AND ${ADMITTED_AT} < :end) admitted
     FROM students s LEFT JOIN branches br ON br.id = s.branch_id
     WHERE ${f.sql} GROUP BY s.branch_id, br.name ORDER BY br.name`,
    f.params,
  );
  const withdrawnByBranch = new Map(
    (
      await reportQuery<Record<string, unknown>>(
        `SELECT s.branch_id, COUNT(DISTINCT h.student_id) n ${fromHistory} WHERE ${withdrawnWhere}
         GROUP BY s.branch_id`,
        f.params,
      )
    ).map((r) => [num(r.branch_id), num(r.n)]),
  );
  const byBranch = branchRows.map((r) => ({
    branchId: num(r.branch_id),
    branch: String(r.branch ?? ''),
    active: num(r.active),
    admitted: num(r.admitted),
    withdrawn: withdrawnByBranch.get(num(r.branch_id)) ?? 0,
  }));

  const rows = scope.limit
    ? (
        await reportQuery<Record<string, unknown>>(
          `SELECT * FROM (
             SELECT 'Admitted' event, ${ADMITTED_AT} at, s.name, s.admission_number, br.name branch,
               s.status, s.source detail
             FROM students s LEFT JOIN branches br ON br.id = s.branch_id WHERE ${admittedWhere}
             UNION ALL
             SELECT 'Withdrawn' event, h.created_at at, s.name, s.admission_number, br.name branch,
               h.to_value status, JSON_UNQUOTE(JSON_EXTRACT(h.details, '$.reason')) detail
             ${fromHistory} LEFT JOIN branches br ON br.id = s.branch_id WHERE ${withdrawnWhere}
           ) m ORDER BY m.at DESC ${limitSql(scope.limit)}`,
          f.params,
        )
      ).map((r) => ({
        at: isoInstant(r.at),
        event: String(r.event),
        student: String(r.name ?? ''),
        admissionNumber: (r.admission_number as string | null) ?? null,
        branch: (r.branch as string | null) ?? null,
        status: (r.status as string | null) ?? null,
        detail: r.detail === null || r.detail === undefined || r.detail === 'null' ? null : String(r.detail),
      }))
    : [];
  return { totals, byBranch, rows, totalRows: totals.admitted + num(w?.events) };
}

/** `students` rows (id, name, branch) of the given login users. */
export async function studentRecordsForUsers(instituteId: number, userIds: number[]) {
  if (!userIds.length) return [];
  return (
    await reportQuery<Record<string, unknown>>(
      `SELECT id, user_id, name, branch_id FROM students WHERE institute_id = :inst AND user_id IN (:ids)`,
      { inst: instituteId, ids: userIds },
    )
  ).map((r) => ({
    id: num(r.id),
    userId: num(r.user_id),
    name: String(r.name ?? ''),
    branchId: num(r.branch_id),
  }));
}

/**
 * Platform-wide student counts per institute (super admin SaaS dashboard only; no tenant
 * context). Never expose this to institute users.
 */
export async function platformStudentCounts(period: { start: Date; end: Date }) {
  return (
    await reportQuery<Record<string, unknown>>(
      `SELECT s.institute_id, COUNT(*) total, SUM(s.status = 'active') active,
         SUM(${ADMITTED_AT} >= :start AND ${ADMITTED_AT} < :end) admitted
       FROM students s GROUP BY s.institute_id`,
      { start: utcSql(period.start), end: utcSql(period.end) },
    )
  ).map((r) => ({
    instituteId: num(r.institute_id),
    total: num(r.total),
    active: num(r.active),
    admitted: num(r.admitted),
  }));
}
