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
 * Read-only grievance report queries for the reports module (spec §4.15 response-time reports,
 * §4.17). Same definitions as the module's own report: response/resolution time from creation,
 * SLA compliance = resolved within SLA ÷ resolved.
 */

const RESPONSE_SECS = 'TIMESTAMPDIFF(SECOND, t.created_at, t.first_response_at)';
const RESOLUTION_SECS = 'TIMESTAMPDIFF(SECOND, t.created_at, t.resolved_at)';
const OPEN = `t.status IN ('open', 'in_progress', 'escalated')`;
const hours = (v: unknown) => (v === null || v === undefined ? null : round(num(v) / 3600, 2));

export async function grievanceReport(scope: ReportScope) {
  const f = new SqlFilter()
    .where('t.institute_id = ?', scope.instituteId)
    .instantBetween('t.created_at', scope.start, scope.end)
    .in('t.branch_id', scope.branchIds)
    .eq('t.assignee_user_id', scope.teacherUserId);
  if (scope.studentUserIds) {
    // Students/parents: only tickets they raised themselves, as in the grievances module.
    f.where('t.requester_user_id = ?', scope.viewerUserId ?? 0);
  }
  const from = 'FROM grievance_tickets t';
  const STATS = `COUNT(*) total, SUM(${OPEN}) open_count, SUM(t.resolved_at IS NOT NULL) resolved,
    SUM(t.status = 'escalated') escalated, SUM(${OPEN} AND t.first_response_at IS NULL) awaiting,
    AVG(${RESPONSE_SECS}) response_secs, AVG(${RESOLUTION_SECS}) resolution_secs,
    SUM(t.sla_breached = 1) breached, SUM(t.resolved_at IS NOT NULL AND t.sla_breached = 0) resolved_in_sla,
    SUM(t.reopen_count > 0) reopened, AVG(t.satisfaction_rating) rating`;
  const stats = (r: Record<string, unknown> | undefined) => ({
    tickets: num(r?.total),
    open: num(r?.open_count),
    resolved: num(r?.resolved),
    escalated: num(r?.escalated),
    awaitingResponse: num(r?.awaiting),
    avgFirstResponseHours: hours(r?.response_secs),
    avgResolutionHours: hours(r?.resolution_secs),
    slaBreached: num(r?.breached),
    slaCompliance: percent(num(r?.resolved_in_sla), num(r?.resolved)),
    reopened: num(r?.reopened),
    avgSatisfaction: r?.rating === null || r?.rating === undefined ? null : round(num(r.rating), 2),
  });

  const [t] = await reportQuery<Record<string, unknown>>(`SELECT ${STATS} ${from} WHERE ${f.sql}`, f.params);
  const byCategory = (
    await reportQuery<Record<string, unknown>>(
      `SELECT c.name, ${STATS} ${from} JOIN grievance_categories c ON c.id = t.category_id
       WHERE ${f.sql} GROUP BY c.id, c.name ORDER BY total DESC, c.name`,
      f.params,
    )
  ).map((r) => ({ category: String(r.name ?? ''), ...stats(r) }));
  const byBranch = (
    await reportQuery<Record<string, unknown>>(
      `SELECT t.branch_id, br.name, ${STATS} ${from} LEFT JOIN branches br ON br.id = t.branch_id
       WHERE ${f.sql} GROUP BY t.branch_id, br.name ORDER BY br.name`,
      f.params,
    )
  ).map((r) => ({
    branchId: r.branch_id === null ? null : num(r.branch_id),
    branch: (r.name as string | null) ?? 'Institute-wide',
    ...stats(r),
  }));
  const byAssignee = (
    await reportQuery<Record<string, unknown>>(
      `SELECT t.assignee_user_id, u.name, ${STATS} ${from} LEFT JOIN users u ON u.id = t.assignee_user_id
       WHERE ${f.sql} GROUP BY t.assignee_user_id, u.name ORDER BY u.name`,
      f.params,
    )
  ).map((r) => ({
    assigneeUserId: r.assignee_user_id === null ? null : num(r.assignee_user_id),
    assignee: (r.name as string | null) ?? 'Unassigned',
    ...stats(r),
  }));

  const rows = scope.limit
    ? (
        await reportQuery<Record<string, unknown>>(
          `SELECT t.ticket_number, t.created_at, br.name branch, c.name category, t.subject, t.priority, t.status,
             u.name assignee, ${RESPONSE_SECS} response_secs, ${RESOLUTION_SECS} resolution_secs, t.due_at,
             t.sla_breached, t.reopen_count, t.satisfaction_rating
           ${from}
           JOIN grievance_categories c ON c.id = t.category_id
           LEFT JOIN branches br ON br.id = t.branch_id
           LEFT JOIN users u ON u.id = t.assignee_user_id
           WHERE ${f.sql} ORDER BY t.created_at DESC, t.id DESC ${limitSql(scope.limit)}`,
          f.params,
        )
      ).map((r) => ({
        ticketNumber: String(r.ticket_number ?? ''),
        createdAt: isoInstant(r.created_at),
        branch: (r.branch as string | null) ?? 'Institute-wide',
        category: String(r.category ?? ''),
        subject: String(r.subject ?? ''),
        priority: String(r.priority ?? ''),
        status: String(r.status ?? ''),
        assignee: (r.assignee as string | null) ?? null,
        firstResponseHours: hours(r.response_secs),
        resolutionHours: hours(r.resolution_secs),
        dueAt: isoInstant(r.due_at),
        slaBreached: num(r.sla_breached) ? 'Yes' : 'No',
        reopened: num(r.reopen_count),
        rating: r.satisfaction_rating === null ? null : num(r.satisfaction_rating),
      }))
    : [];
  const totals = stats(t);
  return { totals, byCategory, byBranch, byAssignee, rows, totalRows: totals.tickets };
}
