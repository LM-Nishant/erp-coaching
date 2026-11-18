import { SqlFilter, limitSql, num, reportQuery, round, type ReportScope } from '../../shared/reporting';

/**
 * Read-only payroll report queries for the reports module (spec §4.17). Only approved and locked
 * runs count; drafts are reported separately so totals never include unapproved pay.
 */

const MONTH = (d: string) => Number(d.slice(0, 4)) * 100 + Number(d.slice(5, 7));

export async function payrollReport(scope: ReportScope) {
  const f = new SqlFilter()
    .where('ps.institute_id = ?', scope.instituteId)
    .where(`pr.status IN ('approved', 'locked')`)
    .where('(ps.period_year * 100 + ps.period_month) BETWEEN ? AND ?', MONTH(scope.from), MONTH(scope.to))
    .in('ps.branch_id', scope.branchIds);
  const from = 'FROM payslips ps JOIN payroll_runs pr ON pr.id = ps.payroll_run_id';

  const [t] = await reportQuery<Record<string, unknown>>(
    `SELECT COUNT(*) payslips, COUNT(DISTINCT ps.employee_id) employees, COUNT(DISTINCT pr.id) runs,
       SUM(ps.gross) gross, SUM(ps.total_deductions) deductions, SUM(ps.net) net,
       SUM(ps.employer_contributions) employer, SUM(ps.lop_days) lop_days
     ${from} WHERE ${f.sql}`,
    f.params,
  );
  const d = new SqlFilter()
    .where('pr.institute_id = ?', scope.instituteId)
    .where(`pr.status = 'draft'`)
    .where('(pr.period_year * 100 + pr.period_month) BETWEEN ? AND ?', MONTH(scope.from), MONTH(scope.to))
    .in('pr.branch_id', scope.branchIds);
  const [drafts] = await reportQuery<Record<string, unknown>>(
    `SELECT COUNT(*) n FROM payroll_runs pr WHERE ${d.sql}`,
    d.params,
  );
  const totals = {
    payslips: num(t?.payslips),
    employees: num(t?.employees),
    runs: num(t?.runs),
    gross: num(t?.gross),
    deductions: num(t?.deductions),
    net: num(t?.net),
    employerContributions: num(t?.employer),
    costToCompany: num(t?.gross) + num(t?.employer),
    lopDays: round(num(t?.lop_days), 1),
    draftRuns: num(drafts?.n),
  };

  const byMonth = (
    await reportQuery<Record<string, unknown>>(
      `SELECT ps.period_year y, ps.period_month m, COUNT(*) payslips, SUM(ps.gross) gross,
         SUM(ps.total_deductions) deductions, SUM(ps.net) net, SUM(ps.employer_contributions) employer
       ${from} WHERE ${f.sql} GROUP BY ps.period_year, ps.period_month ORDER BY y, m`,
      f.params,
    )
  ).map((r) => ({
    period: `${r.y}-${String(r.m).padStart(2, '0')}`,
    payslips: num(r.payslips),
    gross: num(r.gross),
    deductions: num(r.deductions),
    net: num(r.net),
    employerContributions: num(r.employer),
  }));
  const byBranch = (
    await reportQuery<Record<string, unknown>>(
      `SELECT ps.branch_id, br.name branch, COUNT(DISTINCT ps.employee_id) employees, SUM(ps.gross) gross,
         SUM(ps.net) net, SUM(ps.employer_contributions) employer
       ${from} LEFT JOIN branches br ON br.id = ps.branch_id
       WHERE ${f.sql} GROUP BY ps.branch_id, br.name ORDER BY br.name`,
      f.params,
    )
  ).map((r) => ({
    branchId: r.branch_id === null ? null : num(r.branch_id),
    branch: (r.branch as string | null) ?? 'No branch',
    employees: num(r.employees),
    gross: num(r.gross),
    net: num(r.net),
    employerContributions: num(r.employer),
  }));
  const rows = scope.limit
    ? (
        await reportQuery<Record<string, unknown>>(
          `SELECT ps.period_year y, ps.period_month m, e.employee_code, e.name, e.designation, e.department,
             br.name branch, ps.payable_days, ps.lop_days, ps.gross, ps.total_deductions, ps.net,
             ps.employer_contributions, pr.status
           ${from} JOIN employees e ON e.id = ps.employee_id LEFT JOIN branches br ON br.id = ps.branch_id
           WHERE ${f.sql} ORDER BY y DESC, m DESC, e.name ${limitSql(scope.limit)}`,
          f.params,
        )
      ).map((r) => ({
        period: `${r.y}-${String(r.m).padStart(2, '0')}`,
        employeeCode: (r.employee_code as string | null) ?? null,
        employee: String(r.name ?? ''),
        designation: (r.designation as string | null) ?? null,
        department: (r.department as string | null) ?? null,
        branch: (r.branch as string | null) ?? null,
        payableDays: num(r.payable_days),
        lopDays: num(r.lop_days),
        gross: num(r.gross),
        deductions: num(r.total_deductions),
        net: num(r.net),
        employerContributions: num(r.employer_contributions),
        runStatus: String(r.status),
      }))
    : [];
  return { totals, byMonth, byBranch, rows, totalRows: totals.payslips };
}
