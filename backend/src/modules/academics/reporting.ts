import {
  SqlFilter,
  num,
  numOrNull,
  percent,
  reportQuery,
  round,
  type ReportScope,
} from '../../shared/reporting';

/** Read-only academics report queries for the reports module (spec §4.17). */

const ENROLLED = `(SELECT COUNT(*) FROM batch_students bs WHERE bs.batch_id = b.id AND bs.status = 'active')`;
const PLANNED_MINUTES = 'TIME_TO_SEC(TIMEDIFF(cs.end_time, cs.start_time)) / 60';

/** Running/planned batches: seats vs active enrolments; classroom bookings in the period. */
export async function capacityReport(scope: ReportScope) {
  const f = new SqlFilter()
    .where('b.institute_id = ?', scope.instituteId)
    .where(`b.status IN ('planned', 'active')`)
    .in('b.branch_id', scope.branchIds)
    .eq('b.course_id', scope.courseId)
    .eq('b.id', scope.batchId)
    .in('b.id', scope.batchIds);
  const batches = (
    await reportQuery<Record<string, unknown>>(
      `SELECT b.id, b.name, b.code, b.capacity, b.status, br.name branch, c.name course, ${ENROLLED} enrolled
       FROM batches b LEFT JOIN branches br ON br.id = b.branch_id LEFT JOIN courses c ON c.id = b.course_id
       WHERE ${f.sql} ORDER BY br.name, b.name`,
      f.params,
    )
  ).map((r) => {
    const capacity = numOrNull(r.capacity) || null;
    const enrolled = num(r.enrolled);
    return {
      batchId: num(r.id),
      batch: String(r.name ?? ''),
      code: (r.code as string | null) ?? null,
      branch: (r.branch as string | null) ?? null,
      course: (r.course as string | null) ?? null,
      status: String(r.status),
      capacity,
      enrolled,
      seatsLeft: capacity === null ? null : Math.max(0, capacity - enrolled),
      fill: capacity === null ? null : percent(enrolled, capacity),
    };
  });
  const limited = batches.filter((b) => b.capacity !== null);
  const seats = limited.reduce((s, b) => s + (b.capacity ?? 0), 0);
  const seated = limited.reduce((s, b) => s + Math.min(b.enrolled, b.capacity ?? 0), 0);
  const totals = {
    batches: batches.length,
    enrolled: batches.reduce((s, b) => s + b.enrolled, 0),
    seats,
    utilisation: percent(seated, seats),
    full: limited.filter((b) => b.enrolled >= (b.capacity ?? 0)).length,
    underHalf: limited.filter((b) => b.enrolled * 2 < (b.capacity ?? 0)).length,
    unlimited: batches.length - limited.length,
  };

  const c = new SqlFilter({
    from: scope.from,
    to: scope.to,
    inst: scope.instituteId,
  })
    .where('cr.institute_id = ?', scope.instituteId)
    .where('cr.is_virtual = 0')
    .where(`cr.status = 'active'`)
    .in('cr.branch_id', scope.branchIds);
  const sessionJoin = c.nested().eq('cs.batch_id', scope.batchId).in('cs.batch_id', scope.batchIds);
  if (scope.courseId)
    sessionJoin.where('cs.batch_id IN (SELECT id FROM batches WHERE course_id = ?)', scope.courseId);
  const days = Math.max(1, Math.round((Date.parse(scope.to) - Date.parse(scope.from)) / 86_400_000) + 1);
  const classrooms = (
    await reportQuery<Record<string, unknown>>(
      `SELECT cr.id, cr.name, cr.capacity, br.name branch, COUNT(cs.id) sessions,
         SUM(${PLANNED_MINUTES}) minutes,
         AVG(CASE WHEN cr.capacity > 0 THEN LEAST(COALESCE(enr.n, 0) / cr.capacity, 1) * 100 END) occupancy
       FROM classrooms cr
       LEFT JOIN branches br ON br.id = cr.branch_id
       LEFT JOIN class_sessions cs ON cs.classroom_id = cr.id AND cs.status <> 'cancelled'
         AND cs.date BETWEEN :from AND :to AND ${sessionJoin.sql}
       LEFT JOIN (SELECT batch_id, COUNT(*) n FROM batch_students WHERE institute_id = :inst AND status = 'active'
         GROUP BY batch_id) enr ON enr.batch_id = cs.batch_id
       WHERE ${c.sql} GROUP BY cr.id, cr.name, cr.capacity, br.name ORDER BY br.name, cr.name`,
      c.params,
    )
  ).map((r) => {
    const hours = round(num(r.minutes) / 60, 1);
    return {
      classroom: String(r.name ?? ''),
      branch: (r.branch as string | null) ?? null,
      capacity: numOrNull(r.capacity),
      sessions: num(r.sessions),
      hours,
      hoursPerDay: round(hours / days, 1),
      occupancy: r.occupancy === null || r.occupancy === undefined ? null : round(num(r.occupancy), 1),
    };
  });
  return {
    totals: {
      ...totals,
      classrooms: classrooms.length,
      classroomSessions: classrooms.reduce((s, r) => s + r.sessions, 0),
      classroomHours: round(
        classrooms.reduce((s, r) => s + r.hours, 0),
        1,
      ),
    },
    batches: scope.limit ? batches.slice(0, scope.limit) : [],
    totalRows: batches.length,
    classrooms,
  };
}

/** Class sessions in the period per teacher (delivery, cancellations, substitutions, hours). */
export async function teachingReport(scope: ReportScope) {
  const f = new SqlFilter()
    .where('cs.institute_id = ?', scope.instituteId)
    .dateBetween('cs.date', scope.from, scope.to)
    .in('cs.branch_id', scope.branchIds)
    .eq('cs.batch_id', scope.batchId)
    .in('cs.batch_id', scope.batchIds)
    .eq('b.course_id', scope.courseId)
    .eq('cs.teacher_user_id', scope.teacherUserId);
  const teachers = (
    await reportQuery<Record<string, unknown>>(
      `SELECT cs.teacher_user_id, u.name, COUNT(*) total, SUM(cs.status = 'completed') completed,
         SUM(cs.status = 'cancelled') cancelled, SUM(cs.status = 'scheduled') pending,
         SUM(cs.original_teacher_user_id IS NOT NULL AND cs.original_teacher_user_id <> cs.teacher_user_id) substitutions,
         SUM(CASE WHEN cs.status = 'completed' THEN COALESCE(cs.actual_duration_minutes, ${PLANNED_MINUTES}) ELSE 0 END) minutes
       FROM class_sessions cs JOIN batches b ON b.id = cs.batch_id LEFT JOIN users u ON u.id = cs.teacher_user_id
       WHERE ${f.sql} GROUP BY cs.teacher_user_id, u.name ORDER BY u.name`,
      f.params,
    )
  ).map((r) => {
    const total = num(r.total);
    const cancelled = num(r.cancelled);
    return {
      teacherUserId: numOrNull(r.teacher_user_id),
      teacher: (r.name as string | null) ?? null,
      classes: total,
      completed: num(r.completed),
      cancelled,
      pending: num(r.pending),
      substitutions: num(r.substitutions),
      hours: round(num(r.minutes) / 60, 1),
      completion: percent(num(r.completed), total - cancelled),
    };
  });
  const sum = (k: 'classes' | 'completed' | 'cancelled' | 'pending' | 'substitutions') =>
    teachers.reduce((s, t) => s + t[k], 0);
  return {
    totals: {
      teachers: teachers.filter((t) => t.teacherUserId !== null).length,
      classes: sum('classes'),
      completed: sum('completed'),
      cancelled: sum('cancelled'),
      pending: sum('pending'),
      substitutions: sum('substitutions'),
      hours: round(
        teachers.reduce((s, t) => s + t.hours, 0),
        1,
      ),
      completion: percent(sum('completed'), sum('classes') - sum('cancelled')),
    },
    teachers,
  };
}
