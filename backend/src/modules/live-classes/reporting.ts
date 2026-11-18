import {
  SqlFilter,
  isoInstant,
  limitSql,
  num,
  percent,
  reportQuery,
  round,
  type ReportScope,
} from '../../shared/reporting';

/**
 * Read-only live-class report queries for the reports module (spec §4.17). Attendance compares
 * students who joined an ended session with the batch's current active enrolment.
 */

const STATS = `COUNT(*) sessions, SUM(s.status = 'ended') ended, SUM(s.status = 'cancelled') cancelled,
  SUM(s.status IN ('scheduled', 'live') AND s.scheduled_end_at >= UTC_TIMESTAMP()) upcoming,
  SUM(s.status = 'scheduled' AND s.scheduled_end_at < UTC_TIMESTAMP()) missed,
  SUM(s.delivered_secs) delivered_secs, SUM(CASE WHEN s.status = 'ended' THEN s.joined END) joined,
  SUM(CASE WHEN s.status = 'ended' THEN s.enrolled END) enrolled,
  SUM(CASE WHEN s.status = 'ended' THEN s.student_secs END) student_secs`;

const stats = (r: Record<string, unknown> | undefined) => {
  const joined = num(r?.joined);
  return {
    sessions: num(r?.sessions),
    ended: num(r?.ended),
    cancelled: num(r?.cancelled),
    upcoming: num(r?.upcoming),
    missed: num(r?.missed),
    hoursDelivered: round(num(r?.delivered_secs) / 3600, 1),
    attendees: joined,
    attendance: percent(joined, num(r?.enrolled)),
    avgMinutesAttended: joined ? round(num(r?.student_secs) / joined / 60, 1) : null,
  };
};

export async function liveClassReport(scope: ReportScope) {
  const personal = scope.studentUserIds !== null;
  const f = new SqlFilter()
    .where('ls.institute_id = ?', scope.instituteId)
    .instantBetween('ls.scheduled_start_at', scope.start, scope.end)
    .in('ls.branch_id', scope.branchIds)
    .eq('ls.batch_id', scope.batchId)
    .eq('b.course_id', scope.courseId);
  if (scope.batchIds) {
    f.where(
      '(ls.batch_id IN (?) OR ls.teacher_user_id = ?)',
      scope.batchIds.length ? scope.batchIds : [0],
      scope.teacherUserId ?? 0,
    );
  }
  const students = scope.studentUserIds?.length ? scope.studentUserIds : [0];
  if (personal) {
    f.where(
      'EXISTS (SELECT 1 FROM batch_students bs WHERE bs.batch_id = ls.batch_id AND bs.student_user_id IN (?))',
      students,
    );
  }
  const sessions = `(SELECT ls.id, ls.title, ls.status, ls.scheduled_start_at, ls.scheduled_end_at,
      ls.teacher_user_id, ls.branch_id, ls.batch_id,
      CASE WHEN ls.started_at IS NOT NULL AND ls.ended_at IS NOT NULL
        THEN TIMESTAMPDIFF(SECOND, ls.started_at, ls.ended_at) END delivered_secs,
      TIMESTAMPDIFF(SECOND, ls.scheduled_start_at, ls.scheduled_end_at) scheduled_secs,
      (SELECT COUNT(*) FROM live_participants p WHERE p.live_session_id = ls.id AND p.role = 'student'
        AND p.first_joined_at IS NOT NULL) joined,
      (SELECT COALESCE(SUM(p.total_seconds), 0) FROM live_participants p WHERE p.live_session_id = ls.id
        AND p.role = 'student') student_secs,
      (SELECT COUNT(*) FROM batch_students bs WHERE bs.batch_id = ls.batch_id AND bs.status = 'active') enrolled
    FROM live_sessions ls JOIN batches b ON b.id = ls.batch_id WHERE ${f.sql}) s`;

  const [t] = await reportQuery<Record<string, unknown>>(`SELECT ${STATS} FROM ${sessions}`, f.params);
  const byTeacher = (
    await reportQuery<Record<string, unknown>>(
      `SELECT s.teacher_user_id, u.name, ${STATS} FROM ${sessions} LEFT JOIN users u ON u.id = s.teacher_user_id
       GROUP BY s.teacher_user_id, u.name ORDER BY u.name`,
      f.params,
    )
  ).map((r) => ({ teacherUserId: num(r.teacher_user_id), teacher: String(r.name ?? ''), ...stats(r) }));
  const byBranch = (
    await reportQuery<Record<string, unknown>>(
      `SELECT s.branch_id, br.name, ${STATS} FROM ${sessions} LEFT JOIN branches br ON br.id = s.branch_id
       GROUP BY s.branch_id, br.name ORDER BY br.name`,
      f.params,
    )
  ).map((r) => ({ branchId: num(r.branch_id), branch: String(r.name ?? ''), ...stats(r) }));

  const minutes = (secs: unknown) => (secs === null || secs === undefined ? null : round(num(secs) / 60, 0));
  let rows: Record<string, string | number | null>[] = [];
  let totalRows = num(t?.sessions);
  if (personal) {
    // One row per session per own/linked student: did they attend, and for how long.
    const p = f.nested().where('bs.student_user_id IN (?)', students);
    const personalFrom = `FROM ${sessions}
      JOIN (SELECT DISTINCT bs.batch_id, bs.student_user_id FROM batch_students bs WHERE ${p.sql}) e
        ON e.batch_id = s.batch_id
      JOIN users su ON su.id = e.student_user_id
      LEFT JOIN live_participants lp ON lp.live_session_id = s.id AND lp.user_id = e.student_user_id
      LEFT JOIN batches b2 ON b2.id = s.batch_id
      LEFT JOIN users u ON u.id = s.teacher_user_id`;
    const [c] = await reportQuery<Record<string, unknown>>(`SELECT COUNT(*) n ${personalFrom}`, f.params);
    totalRows = num(c?.n);
    rows = scope.limit
      ? (
          await reportQuery<Record<string, unknown>>(
            `SELECT s.scheduled_start_at, s.title, s.status, b2.name batch, u.name teacher, su.name student,
               lp.first_joined_at, lp.total_seconds
             ${personalFrom} ORDER BY s.scheduled_start_at DESC, su.name ${limitSql(scope.limit)}`,
            f.params,
          )
        ).map((r) => ({
          startAt: isoInstant(r.scheduled_start_at),
          title: String(r.title ?? ''),
          batch: (r.batch as string | null) ?? null,
          teacher: (r.teacher as string | null) ?? null,
          status: String(r.status ?? ''),
          student: String(r.student ?? ''),
          attended: r.first_joined_at ? 'Yes' : r.status === 'ended' ? 'No' : null,
          minutesAttended: minutes(r.total_seconds),
        }))
      : [];
  } else if (scope.limit) {
    rows = (
      await reportQuery<Record<string, unknown>>(
        `SELECT s.*, b2.name batch, br.name branch, u.name teacher
         FROM ${sessions}
         LEFT JOIN batches b2 ON b2.id = s.batch_id
         LEFT JOIN branches br ON br.id = s.branch_id
         LEFT JOIN users u ON u.id = s.teacher_user_id
         ORDER BY s.scheduled_start_at DESC, s.id DESC ${limitSql(scope.limit)}`,
        f.params,
      )
    ).map((r) => {
      const joined = num(r.joined);
      const ended = r.status === 'ended';
      return {
        startAt: isoInstant(r.scheduled_start_at),
        title: String(r.title ?? ''),
        batch: (r.batch as string | null) ?? null,
        branch: (r.branch as string | null) ?? null,
        teacher: (r.teacher as string | null) ?? null,
        status: String(r.status ?? ''),
        scheduledMinutes: minutes(r.scheduled_secs),
        deliveredMinutes: minutes(r.delivered_secs),
        enrolled: num(r.enrolled),
        attendees: joined,
        attendance: ended ? percent(joined, num(r.enrolled)) : null,
        avgMinutesAttended: joined ? round(num(r.student_secs) / joined / 60, 1) : null,
      };
    });
  }
  return { totals: stats(t), byTeacher, byBranch, rows, totalRows };
}
