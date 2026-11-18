import { SqlFilter, num, percent, reportQuery, type ReportScope } from '../../shared/reporting';

/** Read-only admission funnel queries for the reports module (spec §4.17). */

/** Enquiries and applications created in the period, by status, source and branch. */
export async function admissionFunnelReport(scope: ReportScope) {
  const enq = new SqlFilter()
    .where('e.institute_id = ?', scope.instituteId)
    .instantBetween('e.created_at', scope.start, scope.end)
    .in('e.branch_id', scope.branchIds)
    .eq('e.course_id', scope.courseId)
    .in('e.student_id', scope.studentIds);
  const app = new SqlFilter()
    .where('a.institute_id = ?', scope.instituteId)
    .instantBetween('a.created_at', scope.start, scope.end)
    .in('a.branch_id', scope.branchIds)
    .eq('a.course_id', scope.courseId)
    .eq('a.batch_id', scope.batchId)
    .in('a.batch_id', scope.batchIds)
    .in('a.student_id', scope.studentIds);
  // Enquiries carry no batch: a batch filter narrows them to the batch's course.
  if (scope.batchId)
    enq.where('e.course_id = (SELECT b.course_id FROM batches b WHERE b.id = ?)', scope.batchId);

  const enquiriesByStatus = (
    await reportQuery<Record<string, unknown>>(
      `SELECT e.status, COUNT(*) n FROM enquiries e WHERE ${enq.sql} GROUP BY e.status ORDER BY n DESC`,
      enq.params,
    )
  ).map((r) => ({ status: String(r.status), count: num(r.n) }));
  const enquiriesBySource = (
    await reportQuery<Record<string, unknown>>(
      `SELECT e.source, COUNT(*) n, SUM(e.status = 'converted') converted
       FROM enquiries e WHERE ${enq.sql} GROUP BY e.source ORDER BY n DESC`,
      enq.params,
    )
  ).map((r) => ({
    source: String(r.source ?? ''),
    enquiries: num(r.n),
    converted: num(r.converted),
    conversionRate: percent(num(r.converted), num(r.n)),
  }));
  const applicationsByStatus = (
    await reportQuery<Record<string, unknown>>(
      `SELECT a.status, COUNT(*) n FROM admission_applications a WHERE ${app.sql} GROUP BY a.status ORDER BY n DESC`,
      app.params,
    )
  ).map((r) => ({ status: String(r.status), count: num(r.n) }));

  const enquiries = enquiriesByStatus.reduce((s, r) => s + r.count, 0);
  const converted = enquiriesByStatus.find((r) => r.status === 'converted')?.count ?? 0;
  const applications = applicationsByStatus.reduce((s, r) => s + r.count, 0);
  const appCount = (status: string) => applicationsByStatus.find((r) => r.status === status)?.count ?? 0;

  const byBranch = new Map<
    number,
    {
      branchId: number;
      branch: string;
      enquiries: number;
      converted: number;
      applications: number;
      admitted: number;
    }
  >();
  const branchRow = (id: number, name: unknown) => {
    let row = byBranch.get(id);
    if (!row) {
      row = {
        branchId: id,
        branch: String(name ?? ''),
        enquiries: 0,
        converted: 0,
        applications: 0,
        admitted: 0,
      };
      byBranch.set(id, row);
    }
    return row;
  };
  for (const r of await reportQuery<Record<string, unknown>>(
    `SELECT e.branch_id, br.name, COUNT(*) n, SUM(e.status = 'converted') converted
     FROM enquiries e LEFT JOIN branches br ON br.id = e.branch_id WHERE ${enq.sql} GROUP BY e.branch_id, br.name`,
    enq.params,
  )) {
    const row = branchRow(num(r.branch_id), r.name);
    row.enquiries = num(r.n);
    row.converted = num(r.converted);
  }
  for (const r of await reportQuery<Record<string, unknown>>(
    `SELECT a.branch_id, br.name, COUNT(*) n, SUM(a.status = 'admitted') admitted
     FROM admission_applications a LEFT JOIN branches br ON br.id = a.branch_id WHERE ${app.sql}
     GROUP BY a.branch_id, br.name`,
    app.params,
  )) {
    const row = branchRow(num(r.branch_id), r.name);
    row.applications = num(r.n);
    row.admitted = num(r.admitted);
  }

  return {
    totals: {
      enquiries,
      converted,
      conversionRate: percent(converted, enquiries),
      applications,
      approved: appCount('approved'),
      admitted: appCount('admitted'),
      rejected: appCount('rejected'),
      waitlisted: appCount('waitlisted'),
      pending: appCount('pending'),
      withdrawn: appCount('withdrawn'),
    },
    enquiriesByStatus,
    enquiriesBySource,
    applicationsByStatus,
    byBranch: [...byBranch.values()].sort((a, b) => a.branch.localeCompare(b.branch)),
  };
}
