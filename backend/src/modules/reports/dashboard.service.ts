import { Op } from 'sequelize';
import type {
  DashboardGroupDto,
  ReportAudience,
  ReportFiltersInput,
  ReportKey,
  ReportMetricDto,
  ReportTableDto,
  RoleDashboardDto,
} from '@erp/shared';
import { Branch } from '../branches/branch.model';
import { capacityReport, teachingReport } from '../academics/api';
import { admissionFunnelReport } from '../admissions/api';
import { appointmentReport } from '../appointments/api';
import { attendanceReport } from '../attendance/api';
import { examReport } from '../exams/api';
import { feeCollectionReport, outstandingDuesReport } from '../fees/api';
import { grievanceReport } from '../grievances/api';
import { liveClassReport } from '../live-classes/api';
import { lmsEngagementReport } from '../lms/api';
import { payrollReport } from '../payroll/api';
import { studentMovementReport } from '../students/api';
import {
  REPORT_DEFINITIONS,
  availableReports,
  enabledModules,
  isPersonal,
  metric,
  pctTone,
  sourcesFor,
  table,
} from './definitions';
import { resolveReportRequest } from './scope';

type Result<F extends (...args: never[]) => Promise<unknown>> = Awaited<ReturnType<F>>;

interface DashboardData {
  movement: Result<typeof studentMovementReport> | null;
  funnel: Result<typeof admissionFunnelReport> | null;
  fees: Result<typeof feeCollectionReport> | null;
  dues: Result<typeof outstandingDuesReport> | null;
  attendance: Result<typeof attendanceReport> | null;
  teaching: Result<typeof teachingReport> | null;
  capacity: Result<typeof capacityReport> | null;
  exams: Result<typeof examReport> | null;
  live: Result<typeof liveClassReport> | null;
  lms: Result<typeof lmsEngagementReport> | null;
  grievances: Result<typeof grievanceReport> | null;
  appointments: Result<typeof appointmentReport> | null;
  payroll: Result<typeof payrollReport> | null;
}

type GroupKey = keyof DashboardData;

const GROUP_ORDER: Record<ReportAudience, GroupKey[]> = {
  management: [
    'movement',
    'funnel',
    'fees',
    'dues',
    'attendance',
    'teaching',
    'capacity',
    'exams',
    'live',
    'lms',
    'grievances',
    'appointments',
    'payroll',
  ],
  finance: ['fees', 'dues', 'payroll'],
  teacher: ['teaching', 'attendance', 'exams', 'live', 'lms', 'appointments', 'grievances'],
  student: ['attendance', 'fees', 'dues', 'exams', 'live', 'lms', 'grievances'],
  parent: ['attendance', 'fees', 'dues', 'exams', 'live', 'lms', 'appointments', 'grievances'],
};

const TITLES: Record<Exclude<ReportAudience, 'management'>, string> = {
  finance: 'Accounts dashboard',
  teacher: 'Teaching dashboard',
  student: 'My dashboard',
  parent: "Children's dashboard",
};

const warnIfPositive = (v: number): ReportMetricDto['tone'] => (v > 0 ? 'warning' : undefined);
const dangerIfPositive = (v: number): ReportMetricDto['tone'] => (v > 0 ? 'danger' : undefined);

/** Metrics for one data set, worded for the audience; null when the caller cannot see the data. */
function groupFor(key: GroupKey, d: DashboardData, audience: ReportAudience): DashboardGroupDto | null {
  const personal = isPersonal(audience);
  const group = (title: string, metrics: ReportMetricDto[]): DashboardGroupDto => ({ key, title, metrics });
  switch (key) {
    case 'movement': {
      if (!d.movement) return null;
      const t = d.movement.totals;
      return group('Students', [
        metric('activeStudents', 'Active students', t.active),
        metric('admitted', 'Admitted in period', t.admitted),
        metric('withdrawn', 'Withdrawn in period', t.withdrawn, 'number', {
          tone: warnIfPositive(t.withdrawn),
        }),
      ]);
    }
    case 'funnel': {
      if (!d.funnel) return null;
      const t = d.funnel.totals;
      return group('Admissions', [
        metric('enquiries', 'Enquiries', t.enquiries),
        metric('conversionRate', 'Enquiry conversion', t.conversionRate, 'percent'),
        metric('applications', 'Applications', t.applications),
        metric('pendingApplications', 'Applications pending', t.pending),
      ]);
    }
    case 'fees': {
      if (!d.fees) return null;
      const t = d.fees.totals;
      if (personal) return group('Fees paid', [metric('paid', 'Paid in period', t.net, 'money')]);
      return group('Fee collections', [
        metric('collected', 'Collected', t.net, 'money', { hint: 'Net of refunds' }),
        metric('payments', 'Payments', t.payments),
        metric('refunded', 'Refunded', t.refunded, 'money'),
      ]);
    }
    case 'dues': {
      if (!d.dues) return null;
      const t = d.dues.totals;
      if (personal) {
        return group('Fees due', [
          metric('balance', 'Balance due', t.balance, 'money'),
          metric('overdue', 'Overdue', t.overdue, 'money', { tone: dangerIfPositive(t.overdue) }),
        ]);
      }
      return group('Outstanding dues', [
        metric('outstanding', 'Outstanding', t.balance, 'money'),
        metric('overdue', 'Overdue', t.overdue, 'money', { tone: dangerIfPositive(t.overdue) }),
        metric('overdueAccounts', 'Overdue accounts', t.overdueAccounts),
      ]);
    }
    case 'attendance': {
      if (!d.attendance) return null;
      const { totals: t, minPercentage } = d.attendance;
      const pct = metric('attendance', 'Attendance', t.percentage, 'percent', {
        tone: pctTone(t.percentage, 90, minPercentage),
      });
      if (personal) {
        return group('Attendance', [
          pct,
          metric('present', 'Present', t.present),
          metric('absent', 'Absent', t.absent, 'number', { tone: warnIfPositive(t.absent) }),
          metric('late', 'Late', t.late),
        ]);
      }
      return group('Attendance', [
        pct,
        metric('sessions', 'Sessions marked', t.sessions),
        metric('belowThreshold', `Students below ${minPercentage}%`, t.belowThreshold, 'number', {
          tone: warnIfPositive(t.belowThreshold),
        }),
      ]);
    }
    case 'teaching': {
      if (!d.teaching) return null;
      const t = d.teaching.totals;
      return group(audience === 'teacher' ? 'My classes' : 'Classes', [
        metric('classes', 'Scheduled', t.classes),
        metric('completed', 'Completed', t.completed),
        metric('cancelled', 'Cancelled', t.cancelled, 'number', { tone: warnIfPositive(t.cancelled) }),
        metric('completion', 'Completion', t.completion, 'percent', { tone: pctTone(t.completion) }),
        metric('hours', 'Hours taught', t.hours, 'hours'),
      ]);
    }
    case 'capacity': {
      if (!d.capacity) return null;
      const t = d.capacity.totals;
      return group('Capacity', [
        metric('batches', 'Batches', t.batches),
        metric('utilisation', 'Seat utilisation', t.utilisation, 'percent'),
        metric('full', 'Full batches', t.full),
        metric('underHalf', 'Under half full', t.underHalf),
      ]);
    }
    case 'exams': {
      if (!d.exams) return null;
      const t = d.exams.totals;
      if (personal) {
        return group('Exam results', [
          metric('exams', 'Results published', t.exams),
          metric('averagePercent', 'Average score', t.averagePercent, 'percent'),
          metric('passRate', 'Passed', t.passRate, 'percent', { tone: pctTone(t.passRate, 100, 60) }),
        ]);
      }
      return group('Exams', [
        metric('exams', 'Exams', t.exams),
        metric('attempts', 'Attempts', t.attempts),
        metric('averagePercent', 'Average score', t.averagePercent, 'percent'),
        metric('passRate', 'Pass rate', t.passRate, 'percent'),
        metric('pendingEvaluation', 'Awaiting evaluation', t.pendingEvaluation, 'number', {
          tone: warnIfPositive(t.pendingEvaluation),
        }),
      ]);
    }
    case 'live': {
      if (!d.live) return null;
      const own = d.live.own;
      if (personal && own) {
        return group('Live classes', [
          metric('sessions', 'Scheduled', own.sessions),
          metric('attended', 'Attended', own.attended),
          metric('attendance', 'Attendance', own.attendance, 'percent', { tone: pctTone(own.attendance) }),
        ]);
      }
      const t = d.live.totals;
      return group('Live classes', [
        metric('sessions', 'Sessions', t.sessions),
        metric('hoursDelivered', 'Hours delivered', t.hoursDelivered, 'hours'),
        metric('attendance', 'Attendance', t.attendance, 'percent'),
        metric('missed', 'Missed', t.missed, 'number', { tone: warnIfPositive(t.missed) }),
      ]);
    }
    case 'lms': {
      if (!d.lms) return null;
      const t = d.lms.totals;
      if (personal) {
        return group('Learning', [
          metric('resourcesViewed', 'Resources viewed', t.resourcesViewed),
          metric('watchHours', 'Watch time', t.watchHours, 'hours'),
          metric('submissionRate', 'Assignments submitted', t.submissionRate, 'percent'),
        ]);
      }
      return group('Learning (LMS)', [
        metric('activeLearners', 'Active learners', t.activeLearners),
        metric('engagement', 'Engagement', t.engagement, 'percent'),
        metric('watchHours', 'Watch time', t.watchHours, 'hours'),
        metric('submissionRate', 'Submission rate', t.submissionRate, 'percent'),
      ]);
    }
    case 'grievances': {
      if (!d.grievances) return null;
      const t = d.grievances.totals;
      if (personal) {
        return group('My grievances', [
          metric('tickets', 'Raised', t.tickets),
          metric('open', 'Open', t.open),
          metric('resolved', 'Resolved', t.resolved),
        ]);
      }
      return group(audience === 'teacher' ? 'Grievances assigned to me' : 'Grievances', [
        metric('tickets', 'Raised', t.tickets),
        metric('open', 'Open', t.open, 'number', { tone: warnIfPositive(t.open) }),
        metric('avgFirstResponseHours', 'Avg first response', t.avgFirstResponseHours, 'hours'),
        metric('slaCompliance', 'Within SLA', t.slaCompliance, 'percent', { tone: pctTone(t.slaCompliance) }),
      ]);
    }
    case 'appointments': {
      if (!d.appointments) return null;
      const t = d.appointments.totals;
      if (personal) {
        return group('Appointments', [
          metric('appointments', 'Requested', t.appointments),
          metric('confirmed', 'Confirmed', t.confirmed),
          metric('completed', 'Completed', t.completed),
        ]);
      }
      return group('Appointments', [
        metric('appointments', 'Appointments', t.appointments),
        metric('requested', 'Awaiting response', t.requested, 'number', {
          tone: warnIfPositive(t.requested),
        }),
        metric('avgResponseHours', 'Avg response', t.avgResponseHours, 'hours'),
        metric('completed', 'Completed', t.completed),
      ]);
    }
    case 'payroll': {
      if (!d.payroll) return null;
      const t = d.payroll.totals;
      return group('Payroll', [
        metric('net', 'Net pay', t.net, 'money', { hint: 'Approved and locked runs' }),
        metric('employees', 'Employees paid', t.employees),
        metric('costToCompany', 'Cost to company', t.costToCompany, 'money'),
        metric('draftRuns', 'Runs awaiting approval', t.draftRuns, 'number', {
          tone: warnIfPositive(t.draftRuns),
        }),
      ]);
    }
  }
}

interface BranchRow {
  branch: string;
  active: number | null;
  admitted: number | null;
  collected: number | null;
  outstanding: number | null;
  overdue: number | null;
  attendance: number | null;
  openGrievances: number | null;
}

/** Consolidated per-branch figures for institute-wide management and accounts dashboards. */
async function branchTable(
  instituteId: number,
  branchIds: number[] | null,
  d: DashboardData,
  audience: ReportAudience,
): Promise<ReportTableDto | null> {
  if (audience !== 'management' && audience !== 'finance') return null;
  if (branchIds && branchIds.length < 2) return null;
  const branches = await Branch.findAll({
    where: { instituteId, ...(branchIds ? { id: { [Op.in]: branchIds } } : {}) },
    attributes: ['id', 'name'],
    order: [['name', 'ASC']],
  });
  if (branches.length < 2) return null;
  const byId = <T extends { branchId: number | null }>(rows: T[] | undefined) =>
    new Map((rows ?? []).filter((r) => r.branchId !== null).map((r) => [r.branchId as number, r]));
  const movement = byId(d.movement?.byBranch);
  const fees = byId(d.fees?.byBranch);
  const dues = byId(d.dues?.byBranch);
  const attendance = byId(d.attendance?.byBranch);
  const grievances = byId(d.grievances?.byBranch);
  const pick = <T>(enabled: boolean, value: T | undefined, fallback: T) =>
    enabled ? (value ?? fallback) : null;
  const rows: BranchRow[] = branches.map((b) => ({
    branch: b.name,
    active: pick(!!d.movement, movement.get(b.id)?.active, 0),
    admitted: pick(!!d.movement, movement.get(b.id)?.admitted, 0),
    collected: pick(!!d.fees, fees.get(b.id)?.net, 0),
    outstanding: pick(!!d.dues, dues.get(b.id)?.balance, 0),
    overdue: pick(!!d.dues, dues.get(b.id)?.overdue, 0),
    attendance: d.attendance ? (attendance.get(b.id)?.percentage ?? null) : null,
    openGrievances: pick(!!d.grievances, grievances.get(b.id)?.open, 0),
  }));
  type Col = readonly [keyof BranchRow, string, 'text' | 'number' | 'money' | 'percent'];
  const columns: Col[] = [
    ['branch', 'Branch', 'text'],
    ...(audience === 'management' && d.movement
      ? ([
          ['active', 'Active students', 'number'],
          ['admitted', 'Admitted', 'number'],
        ] as const)
      : []),
    ...(d.fees ? ([['collected', 'Collected', 'money']] as const) : []),
    ...(d.dues ? ([['outstanding', 'Outstanding', 'money']] as const) : []),
    ...(audience === 'finance' && d.dues ? ([['overdue', 'Overdue', 'money']] as const) : []),
    ...(audience === 'management' && d.attendance
      ? ([['attendance', 'Attendance', 'percent']] as const)
      : []),
    ...(audience === 'management' && d.grievances
      ? ([['openGrievances', 'Open grievances', 'number']] as const)
      : []),
  ];
  if (columns.length < 2) return null;
  return table<BranchRow>('branches', 'By branch', columns, rows);
}

/**
 * The caller's role dashboard: institute-wide or branch figures for admins, finance for accountants,
 * own batches and classes for teachers, own or children's data for students and parents. Each group
 * appears only when the caller can open the matching report.
 */
export async function roleDashboard(input: ReportFiltersInput): Promise<RoleDashboardDto> {
  const req = await resolveReportRequest(input, 0);
  const { scope, audience } = req;
  const [available, modules] = await Promise.all([availableReports(), enabledModules(scope.instituteId)]);
  const can = new Set<ReportKey>(available.map((d) => d.key));
  const funnelAllowed =
    can.has('admissions') &&
    sourcesFor(REPORT_DEFINITIONS.get('admissions')!, audience, modules).includes('admissions');
  const run = <T>(allowed: boolean, fn: () => Promise<T>) => (allowed ? fn() : Promise.resolve(null));
  const wanted = new Set(GROUP_ORDER[audience]);
  const want = (group: GroupKey, report: ReportKey) => wanted.has(group) && can.has(report);

  const [
    movement,
    funnel,
    fees,
    dues,
    attendance,
    teaching,
    capacity,
    exams,
    live,
    lms,
    grievances,
    appointments,
    payroll,
  ] = await Promise.all([
    run(want('movement', 'admissions'), () => studentMovementReport(scope)),
    run(wanted.has('funnel') && funnelAllowed, () => admissionFunnelReport(scope)),
    run(want('fees', 'fee-collections'), () => feeCollectionReport(scope)),
    run(want('dues', 'outstanding-dues'), () => outstandingDuesReport(scope)),
    run(want('attendance', 'attendance'), () => attendanceReport(scope)),
    run(want('teaching', 'teacher-performance'), () => teachingReport({ ...scope, batchIds: null })),
    run(want('capacity', 'capacity'), () => capacityReport(scope)),
    run(want('exams', 'exams'), () => examReport(scope)),
    run(want('live', 'live-classes'), () => liveClassReport(scope)),
    run(want('lms', 'lms-engagement'), () => lmsEngagementReport(scope)),
    run(want('grievances', 'grievances'), () => grievanceReport(scope)),
    run(want('appointments', 'appointments'), () => appointmentReport(scope)),
    run(want('payroll', 'payroll'), () => payrollReport(scope)),
  ]);
  const data: DashboardData = {
    movement,
    funnel,
    fees,
    dues,
    attendance,
    teaching,
    capacity,
    exams,
    live,
    lms,
    grievances,
    appointments,
    payroll,
  };

  const title =
    audience === 'management'
      ? scope.branchIds === null
        ? 'Institute dashboard'
        : 'Branch dashboard'
      : TITLES[audience];
  return {
    audience,
    title,
    scope: { audience, label: req.scopeLabel },
    period: req.period,
    groups: GROUP_ORDER[audience]
      .map((key) => groupFor(key, data, audience))
      .filter((g): g is DashboardGroupDto => g !== null),
    branches: await branchTable(scope.instituteId, scope.branchIds, data, audience),
    reports: available.map((d) => d.key),
  };
}
