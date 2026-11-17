import { Op } from 'sequelize';
import type { ParentChildDto, ParentPortalSectionDto } from '@erp/shared';
import { requireTenantContext } from '../../shared/context';
import { registerParentPortalProvider } from '../parent-portal/api';
import { activeBatchIds } from './entitlements';
import { LmsAssignment, LmsSubmission } from './models';

const KEY = 'lms';
const LABEL = 'Homework';
const DUE_SOON_MS = 3 * 24 * 3600_000;

/** Published homework of the child's active batches, with the child's submission (if any). */
async function homework(studentUserId: number, dueAt: Record<symbol, unknown>) {
  const { instituteId } = requireTenantContext();
  const batchIds = await activeBatchIds(instituteId, studentUserId);
  if (!batchIds.length) return [];
  const rows = await LmsAssignment.findAll({
    where: {
      instituteId,
      batchId: { [Op.in]: batchIds },
      status: { [Op.in]: ['published', 'closed'] },
      dueAt,
    },
    attributes: ['id', 'title', 'dueAt', 'status', 'allowLate'],
    order: [['dueAt', 'ASC']],
    limit: 200,
  });
  const subs = rows.length
    ? await LmsSubmission.findAll({
        where: { instituteId, studentUserId, assignmentId: { [Op.in]: rows.map((r) => r.id) } },
        attributes: ['assignmentId', 'status'],
      })
    : [];
  const sub = new Map(subs.map((s) => [s.assignmentId, s.status]));
  return rows.map((a) => ({ a, submission: sub.get(a.id) ?? null }));
}

const isPending = (s: string | null) => s === null || s === 'returned';
const item = (a: LmsAssignment, subtitle: string) => ({
  title: a.title,
  subtitle,
  date: a.dueAt.toISOString().slice(0, 16).replace('T', ' '),
  link: `/lms/homework/${a.id}`,
});

/** Registers the homework provider for the parent home and monthly report (called from `onReady`). */
export function registerLmsParentPortal(): void {
  registerParentPortalProvider({
    key: KEY,
    label: LABEL,
    order: 50,
    async summary(child: ParentChildDto): Promise<ParentPortalSectionDto | null> {
      if (!child.studentUserId) return null;
      const now = Date.now();
      // Open homework: not yet due, or overdue in the last two weeks (older is history).
      const rows = (
        await homework(child.studentUserId, { [Op.gte]: new Date(now - 14 * 24 * 3600_000) })
      ).filter((r) => r.a.status === 'published' && isPending(r.submission));
      if (!rows.length) return null;
      const overdue = rows.filter((r) => r.a.dueAt.getTime() < now);
      const soon = rows.filter((r) => r.a.dueAt.getTime() >= now && r.a.dueAt.getTime() - now <= DUE_SOON_MS);
      return {
        key: KEY,
        label: LABEL,
        metrics: [
          { label: 'Pending', value: rows.length, tone: 'warning' },
          { label: 'Due in 3 days', value: soon.length },
          { label: 'Overdue', value: overdue.length, tone: overdue.length ? 'danger' : 'default' },
        ],
        items: rows
          .slice(0, 5)
          .map((r) =>
            item(
              r.a,
              r.a.dueAt.getTime() < now ? 'Overdue' : r.submission ? 'Returned for changes' : 'Not submitted',
            ),
          ),
      };
    },
    async monthlyReport(child, { from, to }) {
      if (!child.studentUserId) return null;
      const range = { [Op.between]: [new Date(`${from}T00:00:00`), new Date(`${to}T23:59:59.999`)] };
      const rows = await homework(child.studentUserId, range);
      if (!rows.length) return null;
      const missed = rows.filter((r) => isPending(r.submission));
      return {
        key: KEY,
        label: LABEL,
        metrics: [
          { label: 'Assigned', value: rows.length },
          { label: 'Submitted', value: rows.length - missed.length, tone: 'success' },
          { label: 'Not submitted', value: missed.length, tone: missed.length ? 'warning' : 'default' },
        ],
        items: missed.map((r) => item(r.a, 'Not submitted')),
      };
    },
  });
}
