import type { AttendanceStatus } from '@erp/shared';
import { SqlFilter, num, numOrNull, reportQuery, type ReportScope } from '../../shared/reporting';
import { computeTotals } from './reports.service';
import { getAttendanceSettings } from './settings';

/**
 * Read-only attendance report queries for the reports module (spec §4.17). Percentages follow the
 * institute's attendance settings (leave exclusion, half-day weight), so this needs a tenant
 * context for `scope.instituteId` (request or job).
 */

const COUNTS = `SUM(r.status = 'present') present, SUM(r.status = 'absent') absent, SUM(r.status = 'late') late,
  SUM(r.status = 'leave') on_leave, SUM(r.status = 'half_day') half_day`;

const counts = (r: Record<string, unknown>): Partial<Record<AttendanceStatus, number>> => ({
  present: num(r.present),
  absent: num(r.absent),
  late: num(r.late),
  leave: num(r.on_leave),
  half_day: num(r.half_day),
});

export async function attendanceReport(scope: ReportScope) {
  const settings = await getAttendanceSettings();
  const pct = (r: Record<string, unknown>) => computeTotals(counts(r), settings).percentage;
  const f = new SqlFilter()
    .where('r.institute_id = ?', scope.instituteId)
    .dateBetween('r.date', scope.from, scope.to)
    .in('r.branch_id', scope.branchIds)
    .eq('r.batch_id', scope.batchId)
    .in('r.batch_id', scope.batchIds)
    .eq('b.course_id', scope.courseId)
    .in('r.student_user_id', scope.studentUserIds);
  const from = 'FROM attendance_records r LEFT JOIN batches b ON b.id = r.batch_id';

  const [t] = await reportQuery<Record<string, unknown>>(
    `SELECT COUNT(*) records, COUNT(DISTINCT r.attendance_session_id) sessions,
       COUNT(DISTINCT r.student_user_id) students, ${COUNTS}
     ${from} WHERE ${f.sql}`,
    f.params,
  );
  const overall = computeTotals(counts(t ?? {}), settings);

  const students = (
    await reportQuery<Record<string, unknown>>(
      `SELECT r.student_user_id, u.name, MAX(s.admission_number) admission_number,
         GROUP_CONCAT(DISTINCT b.name ORDER BY b.name SEPARATOR ', ') batches,
         GROUP_CONCAT(DISTINCT br.name ORDER BY br.name SEPARATOR ', ') branches, ${COUNTS}
       ${from}
       LEFT JOIN users u ON u.id = r.student_user_id
       LEFT JOIN students s ON s.user_id = r.student_user_id AND s.institute_id = r.institute_id
       LEFT JOIN branches br ON br.id = r.branch_id
       WHERE ${f.sql} GROUP BY r.student_user_id, u.name`,
      f.params,
    )
  )
    .map((r) => {
      const c = computeTotals(counts(r), settings);
      return {
        studentUserId: num(r.student_user_id),
        student: String(r.name ?? ''),
        admissionNumber: (r.admission_number as string | null) ?? null,
        batch: (r.batches as string | null) ?? null,
        branch: (r.branches as string | null) ?? null,
        present: c.present,
        absent: c.absent,
        late: c.late,
        leave: c.leave,
        halfDay: c.half_day,
        total: c.total,
        percentage: c.percentage,
        belowThreshold: c.percentage !== null && c.percentage < settings.minPercentage ? 'Yes' : 'No',
      };
    })
    .sort((a, b) => (a.percentage ?? 101) - (b.percentage ?? 101) || a.student.localeCompare(b.student));

  const grouped = async (key: string, name: string, join = '') =>
    reportQuery<Record<string, unknown>>(
      `SELECT ${key} id, ${name} name, COUNT(DISTINCT r.attendance_session_id) sessions,
         COUNT(DISTINCT r.student_user_id) students, ${COUNTS}
       ${from} ${join} WHERE ${f.sql} GROUP BY ${key}, ${name} ORDER BY ${name}`,
      f.params,
    );
  const byBatch = (await grouped('r.batch_id', 'b.name')).map((r) => ({
    batchId: numOrNull(r.id),
    batch: (r.name as string | null) ?? null,
    sessions: num(r.sessions),
    students: num(r.students),
    percentage: pct(r),
  }));
  const byBranch = (
    await grouped('r.branch_id', 'br.name', 'LEFT JOIN branches br ON br.id = r.branch_id')
  ).map((r) => ({
    branchId: num(r.id),
    branch: String(r.name ?? ''),
    sessions: num(r.sessions),
    students: num(r.students),
    percentage: pct(r),
  }));
  const byTeacher = (
    await grouped(
      'a.teacher_user_id',
      'u.name',
      'JOIN attendance_sessions a ON a.id = r.attendance_session_id LEFT JOIN users u ON u.id = a.teacher_user_id',
    )
  ).map((r) => ({
    teacherUserId: numOrNull(r.id),
    teacher: (r.name as string | null) ?? null,
    sessions: num(r.sessions),
    students: num(r.students),
    percentage: pct(r),
  }));

  return {
    minPercentage: settings.minPercentage,
    totals: {
      records: num(t?.records),
      sessions: num(t?.sessions),
      students: num(t?.students),
      present: overall.present,
      absent: overall.absent,
      late: overall.late,
      leave: overall.leave,
      halfDay: overall.half_day,
      percentage: overall.percentage,
      belowThreshold: students.filter((s) => s.belowThreshold === 'Yes').length,
    },
    byBatch,
    byBranch,
    byTeacher,
    rows: scope.limit ? students.slice(0, scope.limit) : [],
    totalRows: students.length,
  };
}
