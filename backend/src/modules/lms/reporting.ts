import {
  SqlFilter,
  isoInstant,
  limitSql,
  num,
  percent,
  reportQuery,
  round,
  utcSql,
  type ReportScope,
} from '../../shared/reporting';

/**
 * Read-only LMS engagement report queries for the reports module (spec §4.17). Learners are the
 * active batch enrolments in scope; activity is resource views/completions and assignment
 * submissions within the period. Only each learner's latest view of a resource is stored, so a
 * view counts in the period of its most recent access.
 */

export async function lmsEngagementReport(scope: ReportScope) {
  const root = new SqlFilter({
    lmsInst: scope.instituteId,
    lmsStart: utcSql(scope.start),
    lmsEnd: utcSql(scope.end),
  });
  const cohort = root
    .nested()
    .where('bs.institute_id = :lmsInst')
    .where(`bs.status = 'active'`)
    .in('b.branch_id', scope.branchIds)
    .eq('b.course_id', scope.courseId)
    .eq('bs.batch_id', scope.batchId)
    .in('bs.batch_id', scope.batchIds)
    .in('bs.student_user_id', scope.studentUserIds);
  const resources = root.nested().where('r.institute_id = :lmsInst').eq('r.course_id', scope.courseId);
  if (scope.branchIds) {
    resources.where(
      '(r.branch_id IS NULL OR r.branch_id IN (?))',
      scope.branchIds.length ? scope.branchIds : [0],
    );
  }
  const assignments = root
    .nested()
    .where('a.institute_id = :lmsInst')
    .where(`a.status IN ('published', 'closed')`)
    .in('a.branch_id', scope.branchIds)
    .eq('a.batch_id', scope.batchId)
    .in('a.batch_id', scope.batchIds)
    .eq('ab.course_id', scope.courseId);

  const learnersSql = `SELECT bs.student_user_id, GROUP_CONCAT(DISTINCT b.name ORDER BY b.name SEPARATOR ', ') batches,
      GROUP_CONCAT(DISTINCT br.name ORDER BY br.name SEPARATOR ', ') branches,
      GROUP_CONCAT(DISTINCT b.branch_id) branch_ids
    FROM batch_students bs JOIN batches b ON b.id = bs.batch_id LEFT JOIN branches br ON br.id = b.branch_id
    WHERE ${cohort.sql} GROUP BY bs.student_user_id`;
  const learners = await reportQuery<Record<string, unknown>>(
    `SELECT l.*, u.name, v.viewed, v.completed, v.secs, v.last_view, sb.submitted, sb.late, sb.graded, sb.pct_sum,
       sb.last_submit, d.due, d.done
     FROM (${learnersSql}) l
     JOIN users u ON u.id = l.student_user_id
     LEFT JOIN (
       SELECT pr.student_user_id, COUNT(*) viewed,
         SUM(pr.completed_at >= :lmsStart AND pr.completed_at < :lmsEnd) completed,
         SUM(pr.watched_seconds) secs, MAX(pr.last_viewed_at) last_view
       FROM lms_progress pr JOIN lms_resources r ON r.id = pr.resource_id
       WHERE pr.institute_id = :lmsInst AND pr.last_viewed_at >= :lmsStart AND pr.last_viewed_at < :lmsEnd
         AND ${resources.sql}
       GROUP BY pr.student_user_id
     ) v ON v.student_user_id = l.student_user_id
     LEFT JOIN (
       SELECT sub.student_user_id, COUNT(*) submitted, SUM(sub.is_late) late,
         SUM(sub.marks IS NOT NULL AND a.max_marks > 0) graded,
         SUM(CASE WHEN sub.marks IS NOT NULL AND a.max_marks > 0 THEN sub.marks / a.max_marks * 100 END) pct_sum,
         MAX(sub.submitted_at) last_submit
       FROM lms_submissions sub JOIN lms_assignments a ON a.id = sub.assignment_id
       JOIN batches ab ON ab.id = a.batch_id
       WHERE sub.institute_id = :lmsInst AND sub.submitted_at >= :lmsStart AND sub.submitted_at < :lmsEnd
         AND ${assignments.sql}
       GROUP BY sub.student_user_id
     ) sb ON sb.student_user_id = l.student_user_id
     LEFT JOIN (
       SELECT e.student_user_id, COUNT(DISTINCT a.id) due, COUNT(DISTINCT sub.assignment_id) done
       FROM lms_assignments a JOIN batches ab ON ab.id = a.batch_id
       JOIN batch_students e ON e.batch_id = a.batch_id AND e.status = 'active'
       LEFT JOIN lms_submissions sub ON sub.assignment_id = a.id AND sub.student_user_id = e.student_user_id
       WHERE a.due_at >= :lmsStart AND a.due_at < :lmsEnd AND ${assignments.sql}
       GROUP BY e.student_user_id
     ) d ON d.student_user_id = l.student_user_id
     ORDER BY u.name, l.student_user_id`,
    root.params,
  );

  type Branch = { branchId: number; learners: number; active: number; viewed: number; submitted: number };
  const branches = new Map<number, Branch>();
  let active = 0;
  const sums = {
    viewed: 0,
    completed: 0,
    secs: 0,
    submitted: 0,
    late: 0,
    graded: 0,
    pctSum: 0,
    due: 0,
    done: 0,
  };
  const rows = learners.map((r) => {
    const viewed = num(r.viewed);
    const submitted = num(r.submitted);
    const isActive = viewed > 0 || submitted > 0;
    if (isActive) active++;
    sums.viewed += viewed;
    sums.completed += num(r.completed);
    sums.secs += num(r.secs);
    sums.submitted += submitted;
    sums.late += num(r.late);
    sums.graded += num(r.graded);
    sums.pctSum += num(r.pct_sum);
    sums.due += num(r.due);
    sums.done += num(r.done);
    for (const id of String(r.branch_ids ?? '')
      .split(',')
      .filter(Boolean)
      .map(Number)) {
      const b = branches.get(id) ?? { branchId: id, learners: 0, active: 0, viewed: 0, submitted: 0 };
      b.learners++;
      if (isActive) b.active++;
      b.viewed += viewed;
      b.submitted += submitted;
      branches.set(id, b);
    }
    const last = [r.last_view, r.last_submit].filter(Boolean).map((v) => isoInstant(v) ?? '');
    return {
      studentUserId: num(r.student_user_id),
      student: String(r.name ?? ''),
      batch: (r.batches as string | null) ?? null,
      branch: (r.branches as string | null) ?? null,
      resourcesViewed: viewed,
      resourcesCompleted: num(r.completed),
      watchMinutes: round(num(r.secs) / 60, 0),
      assignmentsDue: num(r.due),
      assignmentsSubmitted: submitted,
      lateSubmissions: num(r.late),
      submissionRate: percent(num(r.done), num(r.due)),
      averageMarks: num(r.graded) ? round(num(r.pct_sum) / num(r.graded), 1) : null,
      lastActiveAt: last.length ? last.sort().at(-1)! : null,
    };
  });

  const [assignmentTotals] = await reportQuery<Record<string, unknown>>(
    `SELECT COUNT(*) n FROM lms_assignments a JOIN batches ab ON ab.id = a.batch_id
     WHERE a.due_at >= :lmsStart AND a.due_at < :lmsEnd AND ${assignments.sql}
       AND EXISTS (SELECT 1 FROM (${learnersSql}) l
         JOIN batch_students e ON e.student_user_id = l.student_user_id AND e.batch_id = a.batch_id)`,
    root.params,
  );
  const topResources = (
    await reportQuery<Record<string, unknown>>(
      `SELECT r.id, r.title, r.type, COUNT(*) learners, SUM(pr.completed_at IS NOT NULL) completed,
         AVG(pr.percent) avg_progress
       FROM lms_progress pr JOIN lms_resources r ON r.id = pr.resource_id
       JOIN (${learnersSql}) l ON l.student_user_id = pr.student_user_id
       WHERE pr.institute_id = :lmsInst AND pr.last_viewed_at >= :lmsStart AND pr.last_viewed_at < :lmsEnd
         AND ${resources.sql}
       GROUP BY r.id, r.title, r.type ORDER BY learners DESC, r.title ${limitSql(10)}`,
      root.params,
    )
  ).map((r) => ({
    resource: String(r.title ?? ''),
    type: String(r.type ?? ''),
    learners: num(r.learners),
    completed: num(r.completed),
    averageProgress: r.avg_progress === null ? null : round(num(r.avg_progress), 0),
  }));
  const branchNames = branches.size
    ? await reportQuery<{ id: number; name: string }>('SELECT id, name FROM branches WHERE id IN (:ids)', {
        ids: [...branches.keys()],
      })
    : [];
  const names = new Map(branchNames.map((b) => [b.id, b.name]));
  const byBranch = [...branches.values()]
    .map((b) => ({
      branchId: b.branchId,
      branch: names.get(b.branchId) ?? '',
      learners: b.learners,
      activeLearners: b.active,
      engagement: percent(b.active, b.learners),
      resourcesViewed: b.viewed,
      assignmentsSubmitted: b.submitted,
    }))
    .sort((a, b) => a.branch.localeCompare(b.branch));

  return {
    totals: {
      learners: learners.length,
      activeLearners: active,
      engagement: percent(active, learners.length),
      resourcesViewed: sums.viewed,
      resourcesCompleted: sums.completed,
      watchHours: round(sums.secs / 3600, 1),
      assignmentsDue: num(assignmentTotals?.n),
      submissions: sums.submitted,
      lateSubmissions: sums.late,
      submissionRate: percent(sums.done, sums.due),
      averageMarks: sums.graded ? round(sums.pctSum / sums.graded, 1) : null,
    },
    topResources,
    byBranch,
    rows: scope.limit ? rows.slice(0, scope.limit) : [],
    totalRows: rows.length,
  };
}
