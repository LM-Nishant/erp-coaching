import { SqlFilter, dateOnly, limitSql, num, reportQuery, type ReportScope } from '../../shared/reporting';

/** Read-only fee report queries for the reports module (spec §4.17). Money is in paise. */

const COLLECTED = ['successful', 'partially_refunded', 'refunded'];
const MODE_LABEL = `CASE WHEN p.gateway IS NULL OR p.gateway = '' THEN p.mode ELSE CONCAT('online (', p.gateway, ')') END`;

function paymentFilter(scope: ReportScope) {
  return new SqlFilter()
    .where('p.institute_id = ?', scope.instituteId)
    .in('p.status', COLLECTED)
    .dateBetween('p.paid_on', scope.from, scope.to)
    .in('p.branch_id', scope.branchIds)
    .eq('a.course_id', scope.courseId)
    .eq('a.batch_id', scope.batchId)
    .in('a.batch_id', scope.batchIds)
    .in('p.student_id', scope.studentIds);
}

/** Successful collections (by `paid_on`) in the period, net of refunds. */
export async function feeCollectionReport(scope: ReportScope) {
  const f = paymentFilter(scope);
  const from = `FROM fee_payments p JOIN fee_accounts a ON a.id = p.account_id`;
  const [t] = await reportQuery<Record<string, unknown>>(
    `SELECT COUNT(*) payments, COUNT(DISTINCT p.student_id) students, SUM(p.amount) amount,
       SUM(p.refunded) refunded, SUM(p.gateway_charge) charges
     ${from} WHERE ${f.sql}`,
    f.params,
  );
  const totals = {
    payments: num(t?.payments),
    students: num(t?.students),
    amount: num(t?.amount),
    refunded: num(t?.refunded),
    gatewayCharges: num(t?.charges),
    net: num(t?.amount) - num(t?.refunded),
  };
  const byMode = (
    await reportQuery<Record<string, unknown>>(
      `SELECT ${MODE_LABEL} mode_label, COUNT(*) payments, SUM(p.amount - p.refunded) net
       ${from} WHERE ${f.sql} GROUP BY mode_label ORDER BY net DESC`,
      f.params,
    )
  ).map((r) => ({ mode: String(r.mode_label), payments: num(r.payments), net: num(r.net) }));
  const byBranch = (
    await reportQuery<Record<string, unknown>>(
      `SELECT p.branch_id, br.name branch, COUNT(*) payments, SUM(p.amount) amount,
         SUM(p.refunded) refunded, SUM(p.amount - p.refunded) net
       ${from} LEFT JOIN branches br ON br.id = p.branch_id
       WHERE ${f.sql} GROUP BY p.branch_id, br.name ORDER BY br.name`,
      f.params,
    )
  ).map((r) => ({
    branchId: num(r.branch_id),
    branch: String(r.branch ?? ''),
    payments: num(r.payments),
    amount: num(r.amount),
    refunded: num(r.refunded),
    net: num(r.net),
  }));
  const rows = scope.limit
    ? (
        await reportQuery<Record<string, unknown>>(
          `SELECT p.id, p.paid_on, r.number receipt_no, s.name student, s.admission_number,
             br.name branch, a.title account, ${MODE_LABEL} mode_label,
             COALESCE(p.gateway_payment_id, p.reference_no, p.cheque_number) reference,
             p.amount, p.refunded, p.gateway_charge
           ${from}
           LEFT JOIN fee_receipts r ON r.id = p.receipt_id
           LEFT JOIN students s ON s.id = p.student_id
           LEFT JOIN branches br ON br.id = p.branch_id
           WHERE ${f.sql} ORDER BY p.paid_on DESC, p.id DESC ${limitSql(scope.limit)}`,
          f.params,
        )
      ).map((r) => ({
        date: dateOnly(r.paid_on),
        receiptNo: (r.receipt_no as string | null) ?? null,
        student: (r.student as string | null) ?? null,
        admissionNumber: (r.admission_number as string | null) ?? null,
        branch: (r.branch as string | null) ?? null,
        account: (r.account as string | null) ?? null,
        mode: String(r.mode_label),
        reference: (r.reference as string | null) ?? null,
        amount: num(r.amount),
        refunded: num(r.refunded),
        gatewayCharge: num(r.gateway_charge),
        net: num(r.amount) - num(r.refunded),
      }))
    : [];
  return { totals, byMode, byBranch, rows, totalRows: totals.payments };
}

const NET = '(a.gross - a.discount + a.charges + a.late_fee)';

/**
 * Active fee accounts with a balance, as of `scope.to`. Overdue = instalment balances due on or
 * before that date, aged by days past due.
 */
export async function outstandingDuesReport(scope: ReportScope) {
  const f = new SqlFilter({ asOf: scope.to, inst: scope.instituteId })
    .where('a.institute_id = ?', scope.instituteId)
    .where(`a.status = 'active'`)
    .where(`${NET} - a.paid > 0`)
    .in('a.branch_id', scope.branchIds)
    .eq('a.course_id', scope.courseId)
    .eq('a.batch_id', scope.batchId)
    .in('a.batch_id', scope.batchIds)
    .in('a.student_id', scope.studentIds);
  const from = `FROM fee_accounts a
    LEFT JOIN (
      SELECT i.account_id,
        SUM(i.amount + i.late_fee - i.paid) overdue,
        MIN(i.due_date) oldest_due,
        SUM(CASE WHEN DATEDIFF(:asOf, i.due_date) <= 30 THEN i.amount + i.late_fee - i.paid ELSE 0 END) d30,
        SUM(CASE WHEN DATEDIFF(:asOf, i.due_date) BETWEEN 31 AND 60 THEN i.amount + i.late_fee - i.paid ELSE 0 END) d60,
        SUM(CASE WHEN DATEDIFF(:asOf, i.due_date) BETWEEN 61 AND 90 THEN i.amount + i.late_fee - i.paid ELSE 0 END) d90,
        SUM(CASE WHEN DATEDIFF(:asOf, i.due_date) > 90 THEN i.amount + i.late_fee - i.paid ELSE 0 END) d90p
      FROM fee_instalments i
      WHERE i.institute_id = :inst AND i.status IN ('pending', 'partial') AND i.due_date <= :asOf
        AND i.amount + i.late_fee - i.paid > 0
      GROUP BY i.account_id
    ) d ON d.account_id = a.id`;
  const [t] = await reportQuery<Record<string, unknown>>(
    `SELECT COUNT(*) accounts, COUNT(DISTINCT a.student_id) students, SUM(${NET} - a.paid) balance,
       SUM(COALESCE(d.overdue, 0)) overdue, SUM(COALESCE(d.d30, 0)) d30, SUM(COALESCE(d.d60, 0)) d60,
       SUM(COALESCE(d.d90, 0)) d90, SUM(COALESCE(d.d90p, 0)) d90p,
       SUM(CASE WHEN d.overdue > 0 THEN 1 ELSE 0 END) overdue_accounts
     ${from} WHERE ${f.sql}`,
    f.params,
  );
  const balance = num(t?.balance);
  const overdue = num(t?.overdue);
  const totals = {
    accounts: num(t?.accounts),
    students: num(t?.students),
    overdueAccounts: num(t?.overdue_accounts),
    balance,
    overdue,
    notYetDue: balance - overdue,
  };
  const aging = [
    { bucket: 'Not yet due', amount: Math.max(0, balance - overdue) },
    { bucket: '0–30 days overdue', amount: num(t?.d30) },
    { bucket: '31–60 days overdue', amount: num(t?.d60) },
    { bucket: '61–90 days overdue', amount: num(t?.d90) },
    { bucket: 'Over 90 days overdue', amount: num(t?.d90p) },
  ];
  const byBranch = (
    await reportQuery<Record<string, unknown>>(
      `SELECT a.branch_id, br.name branch, COUNT(*) accounts, SUM(${NET} - a.paid) balance,
         SUM(COALESCE(d.overdue, 0)) overdue
       ${from} LEFT JOIN branches br ON br.id = a.branch_id
       WHERE ${f.sql} GROUP BY a.branch_id, br.name ORDER BY br.name`,
      f.params,
    )
  ).map((r) => ({
    branchId: num(r.branch_id),
    branch: String(r.branch ?? ''),
    accounts: num(r.accounts),
    balance: num(r.balance),
    overdue: num(r.overdue),
  }));
  const rows = scope.limit
    ? (
        await reportQuery<Record<string, unknown>>(
          `SELECT a.id, a.title, br.name branch, s.name student, s.admission_number, s.mobile,
             ${NET} net, a.paid, ${NET} - a.paid balance, COALESCE(d.overdue, 0) overdue, d.oldest_due,
             DATEDIFF(:asOf, d.oldest_due) days_overdue
           ${from}
           LEFT JOIN students s ON s.id = a.student_id
           LEFT JOIN branches br ON br.id = a.branch_id
           WHERE ${f.sql} ORDER BY overdue DESC, balance DESC, a.id ${limitSql(scope.limit)}`,
          f.params,
        )
      ).map((r) => ({
        student: (r.student as string | null) ?? null,
        admissionNumber: (r.admission_number as string | null) ?? null,
        mobile: (r.mobile as string | null) ?? null,
        branch: (r.branch as string | null) ?? null,
        account: String(r.title ?? ''),
        net: num(r.net),
        paid: num(r.paid),
        balance: num(r.balance),
        overdue: num(r.overdue),
        oldestDueDate: dateOnly(r.oldest_due),
        daysOverdue: r.oldest_due ? num(r.days_overdue) : null,
      }))
    : [];
  return { asOf: scope.to, totals, aging, byBranch, rows, totalRows: totals.accounts };
}
