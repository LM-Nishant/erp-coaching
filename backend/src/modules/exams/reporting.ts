import {
  SqlFilter,
  isoInstant,
  limitSql,
  num,
  numOrNull,
  percent,
  reportQuery,
  round,
  type ReportScope,
} from '../../shared/reporting';

/**
 * Read-only exam report queries for the reports module (spec §4.17). Students and parents only
 * ever see exams whose results are published.
 */

const SUBMITTED = `x.status IN ('submitted', 'auto_submitted')`;
const PCT = 'CASE WHEN x.max_score > 0 THEN x.total_score / x.max_score * 100 END';
const PASSED = 'e.pass_marks IS NOT NULL AND x.total_score >= e.pass_marks';

export async function examReport(scope: ReportScope) {
  const personal = scope.studentUserIds !== null;
  // Exams in scope. Institute-wide exams (no branch) stay visible to branch users, but only
  // attempts from their branches are counted.
  const f = new SqlFilter()
    .where('e.institute_id = ?', scope.instituteId)
    .where(`e.status = 'scheduled'`)
    .instantBetween('e.start_at', scope.start, scope.end)
    .eq('e.batch_id', scope.batchId)
    .eq('COALESCE(e.course_id, b.course_id)', scope.courseId);
  if (scope.branchIds) {
    f.where('(e.branch_id IS NULL OR e.branch_id IN (?))', scope.branchIds.length ? scope.branchIds : [0]);
  }
  if (scope.batchIds) {
    f.where(
      '(e.batch_id IN (?) OR e.created_by_user_id = ?)',
      scope.batchIds.length ? scope.batchIds : [0],
      scope.teacherUserId ?? 0,
    );
  }
  if (personal) {
    // Only published exams the student (or linked child) actually sat.
    f.where('e.results_published_at IS NOT NULL').where(
      `EXISTS (SELECT 1 FROM exam_attempts ox WHERE ox.exam_id = e.id
         AND ox.status IN ('submitted', 'auto_submitted') AND ox.student_user_id IN (?))`,
      scope.studentUserIds?.length ? scope.studentUserIds : [0],
    );
  }
  const att = f.nested().in('x.branch_id', scope.branchIds).in('x.student_user_id', scope.studentUserIds);
  const attempts = `LEFT JOIN exam_attempts x ON x.exam_id = e.id AND ${SUBMITTED} AND ${att.sql}`;
  const from = `FROM exams e LEFT JOIN batches b ON b.id = e.batch_id`;

  const [t] = await reportQuery<Record<string, unknown>>(
    `SELECT COUNT(DISTINCT e.id) exams, COUNT(DISTINCT CASE WHEN e.results_published_at IS NOT NULL THEN e.id END) published,
       COUNT(x.id) attempts, COUNT(DISTINCT x.student_user_id) students, AVG(${PCT}) avg_pct,
       SUM(${PASSED}) passed, SUM(e.pass_marks IS NOT NULL AND x.id IS NOT NULL) with_pass_mark,
       SUM(x.pending_evaluations > 0) pending
     ${from} ${attempts} WHERE ${f.sql}`,
    f.params,
  );
  const totals = {
    exams: num(t?.exams),
    published: num(t?.published),
    attempts: num(t?.attempts),
    students: num(t?.students),
    averagePercent: t?.avg_pct === null || t?.avg_pct === undefined ? null : round(num(t.avg_pct), 1),
    passRate: percent(num(t?.passed), num(t?.with_pass_mark)),
    pendingEvaluation: num(t?.pending),
  };

  const exams = (
    await reportQuery<Record<string, unknown>>(
      `SELECT e.id, e.title, e.start_at, e.pass_marks, e.results_published_at, b.name batch, c.name course,
         sj.name subject, br.name branch, COUNT(x.id) attempts, AVG(${PCT}) avg_pct, MAX(${PCT}) best_pct,
         MIN(${PCT}) worst_pct, SUM(${PASSED}) passed, SUM(x.pending_evaluations > 0) pending
       ${from} ${attempts}
       LEFT JOIN courses c ON c.id = COALESCE(e.course_id, b.course_id)
       LEFT JOIN subjects sj ON sj.id = e.subject_id
       LEFT JOIN branches br ON br.id = e.branch_id
       WHERE ${f.sql}
       GROUP BY e.id, e.title, e.start_at, e.pass_marks, e.results_published_at, b.name, c.name, sj.name, br.name
       ORDER BY e.start_at DESC, e.id DESC ${limitSql(personal ? 0 : scope.limit)}`,
      f.params,
    )
  ).map((r) => {
    const n = num(r.attempts);
    const pct = (v: unknown) => (v === null || v === undefined ? null : round(num(v), 1));
    return {
      examId: num(r.id),
      exam: String(r.title ?? ''),
      startAt: isoInstant(r.start_at),
      batch: (r.batch as string | null) ?? null,
      course: (r.course as string | null) ?? null,
      subject: (r.subject as string | null) ?? null,
      branch: (r.branch as string | null) ?? 'All branches',
      attempts: n,
      averagePercent: pct(r.avg_pct),
      bestPercent: pct(r.best_pct),
      lowestPercent: pct(r.worst_pct),
      passRate: r.pass_marks === null ? null : percent(num(r.passed), n),
      pendingEvaluation: num(r.pending),
      published: r.results_published_at ? 'Yes' : 'No',
    };
  });

  // Students/parents: their own attempts (published results only).
  const results =
    personal && scope.limit
      ? (
          await reportQuery<Record<string, unknown>>(
            `SELECT u.name student, e.title, e.start_at, sj.name subject, x.total_score, x.max_score,
               ${PCT} pct, x.rank, x.percentile, e.pass_marks
             ${from} JOIN exam_attempts x ON x.exam_id = e.id AND ${SUBMITTED} AND ${att.sql}
             LEFT JOIN users u ON u.id = x.student_user_id
             LEFT JOIN subjects sj ON sj.id = e.subject_id
             WHERE ${f.sql} ORDER BY e.start_at DESC, u.name ${limitSql(scope.limit)}`,
            f.params,
          )
        ).map((r) => ({
          student: String(r.student ?? ''),
          exam: String(r.title ?? ''),
          startAt: isoInstant(r.start_at),
          subject: (r.subject as string | null) ?? null,
          score: numOrNull(r.total_score),
          maxScore: numOrNull(r.max_score),
          percent: r.pct === null || r.pct === undefined ? null : round(num(r.pct), 1),
          rank: numOrNull(r.rank),
          percentile: numOrNull(r.percentile),
          result:
            r.pass_marks === null || r.pass_marks === undefined
              ? null
              : num(r.total_score) >= num(r.pass_marks)
                ? 'Pass'
                : 'Fail',
        }))
      : [];

  const grouped = async (key: string, name: string, join: string) =>
    (
      await reportQuery<Record<string, unknown>>(
        `SELECT ${key} id, ${name} name, COUNT(DISTINCT e.id) exams, COUNT(x.id) attempts, AVG(${PCT}) avg_pct
         ${from} ${attempts} ${join} WHERE ${f.sql} GROUP BY ${key}, ${name} ORDER BY ${name}`,
        f.params,
      )
    ).map((r) => ({
      id: numOrNull(r.id),
      name: (r.name as string | null) ?? null,
      exams: num(r.exams),
      attempts: num(r.attempts),
      averagePercent: r.avg_pct === null || r.avg_pct === undefined ? null : round(num(r.avg_pct), 1),
    }));
  const byBranch = personal
    ? []
    : await grouped('e.branch_id', 'br.name', 'LEFT JOIN branches br ON br.id = e.branch_id');
  const byCreator = personal
    ? []
    : await grouped('e.created_by_user_id', 'u.name', 'LEFT JOIN users u ON u.id = e.created_by_user_id');

  return {
    totals,
    exams,
    results,
    byBranch,
    byCreator,
    totalRows: personal ? totals.attempts : totals.exams,
  };
}
