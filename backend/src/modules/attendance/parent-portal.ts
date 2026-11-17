import { Op, col, fn } from 'sequelize';
import type { AttendanceStatus, ParentChildDto, ParentPortalSectionDto, ParentMetricTone } from '@erp/shared';
import { requireTenantContext } from '../../shared/context';
import { registerParentPortalProvider } from '../parent-portal/api';
import { AttendanceRecord } from './models';
import { computeTotals } from './reports.service';
import { getAttendanceSettings } from './settings';
import { instituteToday } from '../../shared/timezone';
import { monthBounds } from './time';

const KEY = 'attendance';
const LABEL = 'Attendance';

async function section(
  studentUserId: number,
  from: string,
  to: string,
  percentLabel: string,
): Promise<ParentPortalSectionDto | null> {
  const { instituteId } = requireTenantContext();
  const rows = (await AttendanceRecord.findAll({
    where: { instituteId, studentUserId, date: { [Op.between]: [from, to] } },
    attributes: ['status', [fn('COUNT', col('id')), 'n']],
    group: ['status'],
    raw: true,
  })) as unknown as { status: AttendanceStatus; n: number | string }[];
  if (!rows.length) return null;
  const counts = Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]));
  const settings = await getAttendanceSettings();
  const t = computeTotals(counts, settings);
  const pct = t.percentage;
  const tone: ParentMetricTone =
    pct === null ? 'default' : pct >= settings.minPercentage ? 'success' : 'danger';
  return {
    key: KEY,
    label: LABEL,
    metrics: [
      { label: percentLabel, value: pct === null ? '—' : `${pct}%`, tone },
      { label: 'Present', value: t.present + t.late },
      { label: 'Absent', value: t.absent, tone: t.absent ? 'warning' : 'default' },
      ...(t.leave ? [{ label: 'Leave', value: t.leave }] : []),
    ],
    items: [{ title: 'View attendance', subtitle: `${from} – ${to}`, link: '/attendance/my' }],
  };
}

/** Registers the attendance provider for the parent home and monthly report (called from `onReady`). */
export function registerAttendanceParentPortal(): void {
  registerParentPortalProvider({
    key: KEY,
    label: LABEL,
    order: 20,
    async summary(child: ParentChildDto) {
      if (!child.studentUserId) return null;
      const [y, m] = (await instituteToday(requireTenantContext().instituteId)).split('-').map(Number);
      const { from, to } = monthBounds(y, m);
      return section(child.studentUserId, from, to, 'This month');
    },
    async monthlyReport(child, { from, to }) {
      if (!child.studentUserId) return null;
      return section(child.studentUserId, from, to, 'Attendance');
    },
  });
}
