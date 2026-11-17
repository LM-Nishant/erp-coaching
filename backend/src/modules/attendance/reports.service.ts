import { Op, col, fn } from 'sequelize';
import type {
  AttendanceSettingsDto,
  AttendanceStatus,
  AttendanceTotals,
  GroupAttendanceReportRow,
  StudentAttendanceReportRow,
  StudentAttendanceSummaryDto,
} from '@erp/shared';
import { requireTenantContext } from '../../shared/context';
import { User } from '../users/user.model';
import { Branch } from '../branches/branch.model';
import { Batch, ClassSession, Subject } from '../academics/api';
import { AttendanceRecord, AttendanceSession } from './models';
import { getAttendanceSettings } from './settings';
import { recordRepo } from './sessions.service';

type Counts = Partial<Record<AttendanceStatus, number>>;

/** Percentage = (present + late + half day × weight) / (sessions − leave when excluded). */
export function computeTotals(
  c: Counts,
  s: Pick<AttendanceSettingsDto, 'excludeLeaveFromTotal' | 'halfDayWeight'>,
): AttendanceTotals {
  const present = c.present ?? 0;
  const absent = c.absent ?? 0;
  const late = c.late ?? 0;
  const leave = c.leave ?? 0;
  const half = c.half_day ?? 0;
  const total = present + absent + late + half + (s.excludeLeaveFromTotal ? 0 : leave);
  const attended = present + late + half * s.halfDayWeight;
  return {
    present,
    absent,
    late,
    leave,
    half_day: half,
    total,
    percentage: total ? Math.round((attended / total) * 1000) / 10 : null,
  };
}

export interface ReportFilter {
  from: string;
  to: string;
  batchId?: number;
  branchId?: number;
  studentUserId?: number;
}

function filterWhere(f: ReportFilter) {
  recordRepo.assertBranchAllowed(f.branchId);
  const where: Record<string, unknown> = { date: { [Op.between]: [f.from, f.to] } };
  if (f.batchId) where.batchId = f.batchId;
  if (f.branchId) where.branchId = f.branchId;
  if (f.studentUserId) where.studentUserId = f.studentUserId;
  return where;
}

async function grouped(key: 'studentUserId' | 'batchId' | 'branchId', f: ReportFilter) {
  const rows = (await recordRepo.findAll({
    where: filterWhere(f),
    attributes: [key, 'status', [fn('COUNT', col('id')), 'n']],
    group: [key, 'status'],
    raw: true,
  })) as unknown as Record<string, number | string>[];
  const out = new Map<number, Counts>();
  for (const r of rows) {
    const id = Number(r[key]);
    const c = out.get(id) ?? {};
    c[r.status as AttendanceStatus] = Number(r.n);
    out.set(id, c);
  }
  return out;
}

export async function studentReport(f: ReportFilter): Promise<StudentAttendanceReportRow[]> {
  const settings = await getAttendanceSettings();
  const counts = await grouped('studentUserId', f);
  const ids = [...counts.keys()];
  const users = ids.length ? await User.findAll({ where: { id: ids }, attributes: ['id', 'name'] }) : [];
  const names = new Map(users.map((u) => [u.id, u.name]));
  return ids
    .map((id) => {
      const t = computeTotals(counts.get(id)!, settings);
      return {
        studentUserId: id,
        name: names.get(id) ?? `#${id}`,
        ...t,
        belowThreshold: t.percentage !== null && t.percentage < settings.minPercentage,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function groupReport(
  by: 'batch' | 'branch',
  f: ReportFilter,
): Promise<GroupAttendanceReportRow[]> {
  const { instituteId } = requireTenantContext();
  const settings = await getAttendanceSettings();
  const key = by === 'batch' ? 'batchId' : 'branchId';
  const counts = await grouped(key, f);
  const studentRows = (await recordRepo.findAll({
    where: filterWhere(f),
    attributes: [key, [fn('COUNT', fn('DISTINCT', col('student_user_id'))), 'students']],
    group: [key],
    raw: true,
  })) as unknown as Record<string, number>[];
  const students = new Map(studentRows.map((r) => [Number(r[key]), Number(r.students)]));
  const ids = [...counts.keys()];
  const named = ids.length
    ? by === 'batch'
      ? await Batch.findAll({ where: { instituteId, id: ids }, attributes: ['id', 'name'] })
      : await Branch.findAll({ where: { instituteId, id: ids }, attributes: ['id', 'name'] })
    : [];
  const names = new Map(named.map((n) => [n.id, n.name]));
  return ids
    .map((id) => ({
      id,
      name: names.get(id) ?? `#${id}`,
      students: students.get(id) ?? 0,
      ...computeTotals(counts.get(id)!, settings),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Monthly and annual attendance of one student (caller has already checked access). */
export async function studentSummary(
  studentUserId: number,
  year: number,
): Promise<StudentAttendanceSummaryDto> {
  const { instituteId } = requireTenantContext();
  const settings = await getAttendanceSettings();
  const records = await AttendanceRecord.findAll({
    where: { instituteId, studentUserId, date: { [Op.between]: [`${year}-01-01`, `${year}-12-31`] } },
    include: [
      {
        model: AttendanceSession,
        as: 'session',
        attributes: ['id', 'startTime', 'classSessionId'],
        include: [
          { model: Batch, as: 'batch', attributes: ['name'] },
          {
            model: ClassSession,
            as: 'classSession',
            attributes: ['id'],
            include: [{ model: Subject, as: 'subject', attributes: ['name'] }],
          },
        ],
      },
    ],
    order: [['date', 'DESC']],
  });
  const user = await User.findByPk(studentUserId, { attributes: ['id', 'name'] });
  const overall: Counts = {};
  const byMonth = new Map<string, Counts>();
  for (const r of records) {
    const m = r.date.slice(0, 7);
    const c = byMonth.get(m) ?? {};
    c[r.status] = (c[r.status] ?? 0) + 1;
    byMonth.set(m, c);
    overall[r.status] = (overall[r.status] ?? 0) + 1;
  }
  const months = [...byMonth.keys()]
    .sort()
    .map((month) => ({ month, ...computeTotals(byMonth.get(month)!, settings) }));
  return {
    studentUserId,
    name: user?.name ?? '',
    year,
    overall: computeTotals(overall, settings),
    months,
    records: records.map((r) => ({
      date: r.date,
      batchName: r.session?.batch?.name ?? '',
      subjectName: r.session?.classSession?.subject?.name ?? null,
      startTime: r.session?.startTime ?? null,
      status: r.status,
      source: r.source,
      attendanceSessionId: r.attendanceSessionId,
    })),
  };
}
