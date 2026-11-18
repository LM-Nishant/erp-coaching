import {
  SqlFilter,
  dateOnly,
  limitSql,
  num,
  percent,
  reportQuery,
  round,
  type ReportScope,
} from '../../shared/reporting';

/** Read-only appointment report queries for the reports module (spec §4.16, §4.17). */

const RESPONSE_SECS = 'TIMESTAMPDIFF(SECOND, a.created_at, a.responded_at)';
const STATS = `COUNT(*) total, SUM(a.status = 'requested') requested, SUM(a.status = 'confirmed') confirmed,
  SUM(a.status = 'rejected') rejected, SUM(a.status = 'cancelled') cancelled, SUM(a.status = 'completed') completed,
  SUM(a.status = 'no_show') no_show, SUM(a.mode = 'online') online, AVG(${RESPONSE_SECS}) response_secs`;

const stats = (r: Record<string, unknown> | undefined) => {
  const completed = num(r?.completed);
  const noShow = num(r?.no_show);
  return {
    appointments: num(r?.total),
    requested: num(r?.requested),
    confirmed: num(r?.confirmed),
    rejected: num(r?.rejected),
    cancelled: num(r?.cancelled),
    completed,
    noShow,
    online: num(r?.online),
    avgResponseHours:
      r?.response_secs === null || r?.response_secs === undefined
        ? null
        : round(num(r.response_secs) / 3600, 2),
    attendanceRate: percent(completed, completed + noShow),
  };
};

export async function appointmentReport(scope: ReportScope) {
  const f = new SqlFilter()
    .where('a.institute_id = ?', scope.instituteId)
    .dateBetween('a.date', scope.from, scope.to)
    .in('a.branch_id', scope.branchIds)
    .eq('a.teacher_user_id', scope.teacherUserId);
  if (scope.studentIds || scope.studentUserIds) {
    f.where(
      '(a.student_id IN (?) OR a.student_user_id IN (?))',
      scope.studentIds?.length ? scope.studentIds : [0],
      scope.studentUserIds?.length ? scope.studentUserIds : [0],
    );
  }
  const from = 'FROM appointments a';
  const [t] = await reportQuery<Record<string, unknown>>(`SELECT ${STATS} ${from} WHERE ${f.sql}`, f.params);
  const byTeacher = (
    await reportQuery<Record<string, unknown>>(
      `SELECT a.teacher_user_id, u.name, ${STATS} ${from} LEFT JOIN users u ON u.id = a.teacher_user_id
       WHERE ${f.sql} GROUP BY a.teacher_user_id, u.name ORDER BY u.name`,
      f.params,
    )
  ).map((r) => ({ teacherUserId: num(r.teacher_user_id), teacher: String(r.name ?? ''), ...stats(r) }));
  const byBranch = (
    await reportQuery<Record<string, unknown>>(
      `SELECT a.branch_id, br.name, ${STATS} ${from} LEFT JOIN branches br ON br.id = a.branch_id
       WHERE ${f.sql} GROUP BY a.branch_id, br.name ORDER BY br.name`,
      f.params,
    )
  ).map((r) => ({ branchId: num(r.branch_id), branch: String(r.name ?? ''), ...stats(r) }));
  const rows = scope.limit
    ? (
        await reportQuery<Record<string, unknown>>(
          `SELECT a.date, a.start_time, a.end_time, br.name branch, u.name teacher, s.name student, a.mode, a.status,
             ${RESPONSE_SECS} response_secs
           ${from}
           LEFT JOIN branches br ON br.id = a.branch_id
           LEFT JOIN users u ON u.id = a.teacher_user_id
           LEFT JOIN students s ON s.id = a.student_id
           WHERE ${f.sql} ORDER BY a.date DESC, a.start_time DESC, a.id DESC ${limitSql(scope.limit)}`,
          f.params,
        )
      ).map((r) => ({
        date: dateOnly(r.date),
        time: `${String(r.start_time ?? '').slice(0, 5)}–${String(r.end_time ?? '').slice(0, 5)}`,
        branch: (r.branch as string | null) ?? null,
        teacher: (r.teacher as string | null) ?? null,
        student: (r.student as string | null) ?? null,
        mode: String(r.mode ?? ''),
        status: String(r.status ?? ''),
        responseHours:
          r.response_secs === null || r.response_secs === undefined
            ? null
            : round(num(r.response_secs) / 3600, 2),
      }))
    : [];
  const totals = stats(t);
  return { totals, byTeacher, byBranch, rows, totalRows: totals.appointments };
}
