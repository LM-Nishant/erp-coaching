import {
  REPORT_KEYS,
  type ReportAudience,
  type ReportCatalogItemDto,
  type ReportCategory,
  type ReportCellValue,
  type ReportColumnType,
  type ReportFilterKind,
  type ReportFiltersInput,
  type ReportKey,
  type ReportMetricDto,
  type ReportResultDto,
  type ReportTableDto,
} from '@erp/shared';
import { hasPermission, requireTenantContext } from '../../shared/context';
import { BadRequest, Forbidden, NotFound } from '../../shared/errors';
import type { ReportScope } from '../../shared/reporting';
import { getPlanLimits } from '../subscriptions/subscription.service';
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
import { formatYmd } from './filters';
import { resolveAudience, resolveReportRequest, type ResolvedReportRequest } from './scope';

/** Rows shown on screen per detail table; exports run with their own (higher) limit. */
export const SCREEN_ROW_LIMIT = 500;

export interface ReportBody {
  summary: ReportMetricDto[];
  tables: ReportTableDto[];
  notes: string[];
}

/** Permissions (all required) per audience; a missing audience cannot open the report. */
type Access = Partial<Record<ReportAudience, string[]>>;

/** Extra data merged into a report when the caller may see it and the plan enables it. */
interface OptionalSource {
  key: string;
  planModule: string;
  access: Access;
}

export interface ReportDefinition {
  key: ReportKey;
  title: string;
  description: string;
  category: ReportCategory;
  filters: ReportFilterKind[];
  planModule: string;
  access: Access;
  sources?: OptionalSource[];
  run(req: ResolvedReportRequest): Promise<ReportBody>;
}

// ---------------------------------------------------------------- table / metric builders

type Column<R> = readonly [key: keyof R & string, label: string, type: ReportColumnType];

const cell = (v: unknown): ReportCellValue => {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') return v;
  if (v instanceof Date) return v.toISOString();
  return String(v);
};

/** A table of the given columns (row keys are the column keys). */
export function table<R extends object>(
  key: string,
  title: string,
  columns: readonly Column<NoInfer<R>>[],
  rows: readonly R[],
  totalRows = rows.length,
): ReportTableDto {
  return {
    key,
    title,
    columns: columns.map(([k, label, type]) => ({ key: k, label, type })),
    rows: rows.map((r) =>
      Object.fromEntries(columns.map(([k]) => [k, cell((r as Record<string, unknown>)[k])])),
    ),
    totalRows,
  };
}

export const metric = (
  key: string,
  label: string,
  value: number | null,
  type: ReportColumnType = 'number',
  extra: Pick<ReportMetricDto, 'hint' | 'tone'> = {},
): ReportMetricDto => ({ key, label, value, type, ...extra });

export const isPersonal = (a: ReportAudience) => a === 'student' || a === 'parent';
const when = <T>(condition: boolean, ...items: T[]): T[] => (condition ? items : []);
export const pctTone = (v: number | null, good = 90, fair = 75): ReportMetricDto['tone'] =>
  v === null ? 'medium' : v >= good ? 'success' : v >= fair ? 'warning' : 'danger';

// ---------------------------------------------------------------- definitions

const ALL_FILTERS: ReportFilterKind[] = ['date', 'branch', 'course', 'batch'];
const DATE_BRANCH: ReportFilterKind[] = ['date', 'branch'];

const feeCollections: ReportDefinition = {
  key: 'fee-collections',
  title: 'Fee collections',
  description: 'Payments received in the period by mode and branch, net of refunds.',
  category: 'finance',
  filters: ALL_FILTERS,
  planModule: 'fees',
  access: {
    management: ['fees.view'],
    finance: ['fees.view'],
    student: ['my-fees.view'],
    parent: ['my-fees.view'],
  },
  async run({ scope, audience }) {
    const r = await feeCollectionReport(scope);
    const personal = isPersonal(audience);
    return {
      summary: [
        metric('net', 'Net collected', r.totals.net, 'money', { tone: 'success' }),
        metric('amount', 'Gross collected', r.totals.amount, 'money'),
        metric('refunded', 'Refunded', r.totals.refunded, 'money'),
        metric('payments', 'Payments', r.totals.payments),
        ...when(
          !personal,
          metric('students', 'Paying students', r.totals.students),
          metric('gatewayCharges', 'Gateway charges', r.totals.gatewayCharges, 'money'),
        ),
      ],
      tables: [
        table(
          'payments',
          'Payments',
          [
            ['date', 'Date', 'date'],
            ['receiptNo', 'Receipt', 'text'],
            ['student', 'Student', 'text'],
            ['admissionNumber', 'Admission no.', 'text'],
            ['branch', 'Branch', 'text'],
            ['account', 'Fee account', 'text'],
            ['mode', 'Mode', 'text'],
            ['reference', 'Reference', 'text'],
            ['amount', 'Amount', 'money'],
            ['refunded', 'Refunded', 'money'],
            ['gatewayCharge', 'Gateway charge', 'money'],
            ['net', 'Net', 'money'],
          ],
          r.rows,
          r.totalRows,
        ),
        table(
          'by-mode',
          'By payment mode',
          [
            ['mode', 'Mode', 'text'],
            ['payments', 'Payments', 'number'],
            ['net', 'Net collected', 'money'],
          ],
          r.byMode,
        ),
        ...when(
          !personal,
          table(
            'by-branch',
            'By branch',
            [
              ['branch', 'Branch', 'text'],
              ['payments', 'Payments', 'number'],
              ['amount', 'Gross', 'money'],
              ['refunded', 'Refunded', 'money'],
              ['net', 'Net', 'money'],
            ],
            r.byBranch,
          ),
        ),
      ],
      notes: [
        'Collections are successful payments by payment date, net of refunds; gateway charges are shown separately.',
      ],
    };
  },
};

const outstandingDues: ReportDefinition = {
  key: 'outstanding-dues',
  title: 'Outstanding dues',
  description: 'Unpaid fee balances with overdue amounts and ageing.',
  category: 'finance',
  filters: ALL_FILTERS,
  planModule: 'fees',
  access: feeCollections.access,
  async run({ scope, audience }) {
    const r = await outstandingDuesReport(scope);
    const personal = isPersonal(audience);
    return {
      summary: [
        metric('balance', 'Outstanding', r.totals.balance, 'money', {
          tone: r.totals.balance ? 'warning' : 'success',
        }),
        metric('overdue', 'Overdue', r.totals.overdue, 'money', {
          tone: r.totals.overdue ? 'danger' : 'success',
        }),
        metric('notYetDue', 'Not yet due', r.totals.notYetDue, 'money'),
        metric('accounts', 'Accounts with a balance', r.totals.accounts),
        ...when(
          !personal,
          metric('students', 'Students', r.totals.students),
          metric('overdueAccounts', 'Accounts overdue', r.totals.overdueAccounts),
        ),
      ],
      tables: [
        table(
          'accounts',
          'Fee accounts with a balance',
          [
            ['student', 'Student', 'text'],
            ['admissionNumber', 'Admission no.', 'text'],
            ...when(!personal, ['mobile', 'Mobile', 'text'] as const),
            ['branch', 'Branch', 'text'],
            ['account', 'Fee account', 'text'],
            ['net', 'Net fee', 'money'],
            ['paid', 'Paid', 'money'],
            ['balance', 'Balance', 'money'],
            ['overdue', 'Overdue', 'money'],
            ['oldestDueDate', 'Oldest due date', 'date'],
            ['daysOverdue', 'Days overdue', 'number'],
          ],
          r.rows,
          r.totalRows,
        ),
        table(
          'ageing',
          'Ageing',
          [
            ['bucket', 'Bucket', 'text'],
            ['amount', 'Amount', 'money'],
          ],
          r.aging,
        ),
        ...when(
          !personal,
          table(
            'by-branch',
            'By branch',
            [
              ['branch', 'Branch', 'text'],
              ['accounts', 'Accounts', 'number'],
              ['balance', 'Outstanding', 'money'],
              ['overdue', 'Overdue', 'money'],
            ],
            r.byBranch,
          ),
        ),
      ],
      notes: [`Balances are current; overdue amounts and ageing are as of ${formatYmd(r.asOf)}.`],
    };
  },
};

const admissions: ReportDefinition = {
  key: 'admissions',
  title: 'Admissions and withdrawals',
  description: 'New admissions, withdrawals and the enquiry-to-admission funnel.',
  category: 'academic',
  filters: ALL_FILTERS,
  planModule: 'students',
  access: { management: ['students.view'] },
  sources: [{ key: 'admissions', planModule: 'admissions', access: { management: ['admissions.view'] } }],
  async run({ scope, sources }) {
    const [m, funnel] = await Promise.all([
      studentMovementReport(scope),
      sources.includes('admissions') ? admissionFunnelReport(scope) : null,
    ]);
    const tables: ReportTableDto[] = [
      table(
        'movements',
        'Admissions and withdrawals',
        [
          ['at', 'When', 'datetime'],
          ['event', 'Event', 'text'],
          ['student', 'Student', 'text'],
          ['admissionNumber', 'Admission no.', 'text'],
          ['branch', 'Branch', 'text'],
          ['status', 'Current status', 'text'],
          ['detail', 'Detail', 'text'],
        ],
        m.rows,
        m.totalRows,
      ),
      table(
        'by-branch',
        'Students by branch',
        [
          ['branch', 'Branch', 'text'],
          ['active', 'Active students', 'number'],
          ['admitted', 'Admitted', 'number'],
          ['withdrawn', 'Withdrawn', 'number'],
        ],
        m.byBranch,
      ),
    ];
    const summary = [
      metric('active', 'Active students', m.totals.active),
      metric('admitted', 'Admitted', m.totals.admitted, 'number', { tone: 'success' }),
      metric('withdrawn', 'Withdrawn', m.totals.withdrawn, 'number', {
        tone: m.totals.withdrawn ? 'warning' : 'medium',
      }),
    ];
    if (funnel) {
      summary.push(
        metric('enquiries', 'Enquiries', funnel.totals.enquiries),
        metric('conversionRate', 'Enquiry conversion', funnel.totals.conversionRate, 'percent'),
        metric('applications', 'Applications', funnel.totals.applications),
        metric('applicationsAdmitted', 'Applications admitted', funnel.totals.admitted),
      );
      tables.push(
        table(
          'enquiry-sources',
          'Enquiries by source',
          [
            ['source', 'Source', 'text'],
            ['enquiries', 'Enquiries', 'number'],
            ['converted', 'Converted', 'number'],
            ['conversionRate', 'Conversion', 'percent'],
          ],
          funnel.enquiriesBySource,
        ),
        table(
          'enquiry-status',
          'Enquiries by status',
          [
            ['status', 'Status', 'text'],
            ['count', 'Enquiries', 'number'],
          ],
          funnel.enquiriesByStatus,
        ),
        table(
          'application-status',
          'Applications by status',
          [
            ['status', 'Status', 'text'],
            ['count', 'Applications', 'number'],
          ],
          funnel.applicationsByStatus,
        ),
        table(
          'funnel-by-branch',
          'Admission funnel by branch',
          [
            ['branch', 'Branch', 'text'],
            ['enquiries', 'Enquiries', 'number'],
            ['converted', 'Converted', 'number'],
            ['applications', 'Applications', 'number'],
            ['admitted', 'Admitted', 'number'],
          ],
          funnel.byBranch,
        ),
      );
    }
    return {
      summary,
      tables,
      notes: ['Admissions use the admission date; withdrawals use the date the student was withdrawn.'],
    };
  },
};

const capacity: ReportDefinition = {
  key: 'capacity',
  title: 'Capacity and utilisation',
  description: 'Batch seat utilisation and classroom occupancy.',
  category: 'operations',
  filters: ALL_FILTERS,
  planModule: 'academics',
  access: { management: ['academics.view'] },
  async run({ scope }) {
    const r = await capacityReport(scope);
    return {
      summary: [
        metric('utilisation', 'Seat utilisation', r.totals.utilisation, 'percent', {
          tone: pctTone(r.totals.utilisation, 75, 50),
        }),
        metric('enrolled', 'Enrolled', r.totals.enrolled),
        metric('seats', 'Seats', r.totals.seats),
        metric('batches', 'Batches', r.totals.batches),
        metric('full', 'Full batches', r.totals.full),
        metric('underHalf', 'Batches under half full', r.totals.underHalf, 'number', {
          tone: r.totals.underHalf ? 'warning' : 'medium',
        }),
        metric('classroomHours', 'Classroom hours', r.totals.classroomHours, 'hours'),
      ],
      tables: [
        table(
          'batches',
          'Batches',
          [
            ['batch', 'Batch', 'text'],
            ['code', 'Code', 'text'],
            ['branch', 'Branch', 'text'],
            ['course', 'Course', 'text'],
            ['status', 'Status', 'text'],
            ['capacity', 'Capacity', 'number'],
            ['enrolled', 'Enrolled', 'number'],
            ['seatsLeft', 'Seats left', 'number'],
            ['fill', 'Fill', 'percent'],
          ],
          r.batches,
          r.totalRows,
        ),
        table(
          'classrooms',
          'Classroom occupancy',
          [
            ['classroom', 'Classroom', 'text'],
            ['branch', 'Branch', 'text'],
            ['capacity', 'Seats', 'number'],
            ['sessions', 'Sessions', 'number'],
            ['hours', 'Hours used', 'hours'],
            ['hoursPerDay', 'Hours per day', 'hours'],
            ['occupancy', 'Average occupancy', 'percent'],
          ],
          r.classrooms,
        ),
      ],
      notes: [
        'Batch utilisation is the current enrolment of planned and active batches; batches without a capacity are left out of the seat totals.',
        'Classroom figures use the timetabled class sessions in the period.',
      ],
    };
  },
};

const attendance: ReportDefinition = {
  key: 'attendance',
  title: 'Attendance',
  description: 'Student attendance by student, batch, branch and teacher.',
  category: 'academic',
  filters: ALL_FILTERS,
  planModule: 'attendance',
  access: {
    management: ['attendance.view'],
    teacher: ['attendance.view'],
    student: ['attendance-self.view'],
    parent: ['attendance-self.view'],
  },
  async run({ scope, audience }) {
    const r = await attendanceReport(scope);
    const personal = isPersonal(audience);
    return {
      summary: [
        metric('percentage', 'Attendance', r.totals.percentage, 'percent', {
          tone: pctTone(r.totals.percentage, r.minPercentage + 10, r.minPercentage),
        }),
        metric('present', 'Present', r.totals.present),
        metric('absent', 'Absent', r.totals.absent, 'number', {
          tone: r.totals.absent ? 'warning' : 'medium',
        }),
        metric('late', 'Late', r.totals.late),
        metric('leave', 'On leave', r.totals.leave),
        ...when(
          !personal,
          metric('sessions', 'Sessions marked', r.totals.sessions),
          metric('students', 'Students', r.totals.students),
          metric('belowThreshold', `Below ${r.minPercentage}%`, r.totals.belowThreshold, 'number', {
            tone: r.totals.belowThreshold ? 'danger' : 'success',
          }),
        ),
      ],
      tables: [
        table(
          'students',
          'Attendance by student',
          [
            ['student', 'Student', 'text'],
            ['admissionNumber', 'Admission no.', 'text'],
            ['batch', 'Batch', 'text'],
            ['branch', 'Branch', 'text'],
            ['present', 'Present', 'number'],
            ['absent', 'Absent', 'number'],
            ['late', 'Late', 'number'],
            ['leave', 'Leave', 'number'],
            ['halfDay', 'Half day', 'number'],
            ['total', 'Marked', 'number'],
            ['percentage', 'Attendance', 'percent'],
            ['belowThreshold', `Below ${r.minPercentage}%`, 'text'],
          ],
          r.rows,
          r.totalRows,
        ),
        table(
          'by-batch',
          'By batch',
          [
            ['batch', 'Batch', 'text'],
            ['sessions', 'Sessions', 'number'],
            ['students', 'Students', 'number'],
            ['percentage', 'Attendance', 'percent'],
          ],
          r.byBatch,
        ),
        ...when(
          !personal,
          table(
            'by-branch',
            'By branch',
            [
              ['branch', 'Branch', 'text'],
              ['sessions', 'Sessions', 'number'],
              ['students', 'Students', 'number'],
              ['percentage', 'Attendance', 'percent'],
            ],
            r.byBranch,
          ),
        ),
        ...when(
          audience === 'management' || audience === 'finance',
          table(
            'by-teacher',
            'By teacher',
            [
              ['teacher', 'Teacher', 'text'],
              ['sessions', 'Sessions', 'number'],
              ['students', 'Students', 'number'],
              ['percentage', 'Attendance', 'percent'],
            ],
            r.byTeacher,
          ),
        ),
      ],
      notes: [
        `Late and half-day count as attended. Students below the institute's ${r.minPercentage}% minimum are flagged.`,
      ],
    };
  },
};

const exams: ReportDefinition = {
  key: 'exams',
  title: 'Exam results',
  description: 'Exam participation, scores and pass rates.',
  category: 'academic',
  filters: ALL_FILTERS,
  planModule: 'exams',
  access: {
    management: ['exams.view'],
    teacher: ['exams.view'],
    student: ['exam-portal.view'],
    parent: ['exam-portal.view'],
  },
  async run({ scope, audience }) {
    const r = await examReport(scope);
    const personal = isPersonal(audience);
    const group = (key: string, title: string, label: string, rows: typeof r.byBranch) =>
      table(
        key,
        title,
        [
          ['name', label, 'text'],
          ['exams', 'Exams', 'number'],
          ['attempts', 'Attempts', 'number'],
          ['averagePercent', 'Average', 'percent'],
        ],
        rows.map((x) => ({ ...x, name: x.name ?? (key === 'by-branch' ? 'All branches' : '—') })),
      );
    if (personal) {
      return {
        summary: [
          metric('exams', 'Exams taken', r.totals.exams),
          metric('averagePercent', 'Average score', r.totals.averagePercent, 'percent', {
            tone: pctTone(r.totals.averagePercent, 75, 40),
          }),
          metric('passRate', 'Pass rate', r.totals.passRate, 'percent'),
        ],
        tables: [
          table(
            'results',
            'Results',
            [
              ['student', 'Student', 'text'],
              ['exam', 'Exam', 'text'],
              ['startAt', 'Held on', 'datetime'],
              ['subject', 'Subject', 'text'],
              ['score', 'Score', 'number'],
              ['maxScore', 'Out of', 'number'],
              ['percent', 'Percent', 'percent'],
              ['rank', 'Rank', 'number'],
              ['percentile', 'Percentile', 'number'],
              ['result', 'Result', 'text'],
            ],
            r.results,
            r.totalRows,
          ),
        ],
        notes: ['Only exams with published results are included.'],
      };
    }
    return {
      summary: [
        metric('exams', 'Exams held', r.totals.exams),
        metric('attempts', 'Attempts', r.totals.attempts),
        metric('students', 'Students', r.totals.students),
        metric('averagePercent', 'Average score', r.totals.averagePercent, 'percent'),
        metric('passRate', 'Pass rate', r.totals.passRate, 'percent', {
          tone: pctTone(r.totals.passRate, 80, 60),
        }),
        metric('published', 'Results published', r.totals.published),
        metric('pendingEvaluation', 'Awaiting evaluation', r.totals.pendingEvaluation, 'number', {
          tone: r.totals.pendingEvaluation ? 'warning' : 'medium',
        }),
      ],
      tables: [
        table(
          'exams',
          'Exams',
          [
            ['exam', 'Exam', 'text'],
            ['startAt', 'Held on', 'datetime'],
            ['batch', 'Batch', 'text'],
            ['course', 'Course', 'text'],
            ['subject', 'Subject', 'text'],
            ['branch', 'Branch', 'text'],
            ['attempts', 'Attempts', 'number'],
            ['averagePercent', 'Average', 'percent'],
            ['bestPercent', 'Best', 'percent'],
            ['lowestPercent', 'Lowest', 'percent'],
            ['passRate', 'Pass rate', 'percent'],
            ['pendingEvaluation', 'Awaiting evaluation', 'number'],
            ['published', 'Published', 'text'],
          ],
          r.exams,
          r.totalRows,
        ),
        group('by-branch', 'By branch', 'Branch', r.byBranch),
        ...when(audience === 'management', group('by-creator', 'By exam author', 'Author', r.byCreator)),
      ],
      notes: [
        'Scores use submitted attempts. Pass rate counts exams that have a pass mark.',
        ...when(
          !!scope.branchIds,
          'Institute-wide exams are included; only attempts from the selected branches are counted.',
        ),
      ],
    };
  },
};

/** Per-teacher indicators merged from the teaching, attendance, live-class, exam and appointment data. */
interface TeacherRow {
  teacherUserId: number;
  teacher: string;
  classes: number;
  completed: number;
  cancelled: number;
  substitutions: number;
  hours: number;
  completion: number | null;
  attendanceSessions: number | null;
  attendance: number | null;
  liveSessions: number | null;
  liveHours: number | null;
  liveAttendance: number | null;
  exams: number | null;
  examAverage: number | null;
  appointments: number | null;
  appointmentResponseHours: number | null;
}

const teacherPerformance: ReportDefinition = {
  key: 'teacher-performance',
  title: 'Teacher performance',
  description: 'Classes delivered, attendance, live classes, exams and parent appointments per teacher.',
  category: 'staff',
  filters: ALL_FILTERS,
  planModule: 'academics',
  access: { management: ['academics.view'], teacher: ['academics.view'] },
  sources: [
    {
      key: 'attendance',
      planModule: 'attendance',
      access: { management: ['attendance.view'], teacher: ['attendance.view'] },
    },
    {
      key: 'live-classes',
      planModule: 'live-classes',
      access: { management: ['live-classes.view'], teacher: ['live-classes.view'] },
    },
    { key: 'exams', planModule: 'exams', access: { management: ['exams.view'], teacher: ['exams.view'] } },
    {
      key: 'appointments',
      planModule: 'appointments',
      access: { management: ['appointments.view'], teacher: ['appointments.view'] },
    },
  ],
  async run({ scope, audience, sources }) {
    // Measured per teacher across the branches in scope (not only the teacher's own batches).
    const s: ReportScope = { ...scope, batchIds: null, limit: 0 };
    const withAppointments = sources.includes('appointments') && !s.courseId && !s.batchId;
    const [teaching, att, live, ex, appts] = await Promise.all([
      teachingReport(s),
      sources.includes('attendance') ? attendanceReport(s) : null,
      sources.includes('live-classes') ? liveClassReport(s) : null,
      sources.includes('exams') ? examReport(s) : null,
      withAppointments ? appointmentReport(s) : null,
    ]);
    const rows = new Map<number, TeacherRow>();
    const row = (id: number, name: string): TeacherRow => {
      let r = rows.get(id);
      if (!r) {
        r = {
          teacherUserId: id,
          teacher: name,
          classes: 0,
          completed: 0,
          cancelled: 0,
          substitutions: 0,
          hours: 0,
          completion: null,
          attendanceSessions: att ? 0 : null,
          attendance: null,
          liveSessions: live ? 0 : null,
          liveHours: live ? 0 : null,
          liveAttendance: null,
          exams: ex ? 0 : null,
          examAverage: null,
          appointments: appts ? 0 : null,
          appointmentResponseHours: null,
        };
        rows.set(id, r);
      }
      if (!r.teacher && name) r.teacher = name;
      return r;
    };
    for (const t of teaching.teachers) {
      if (t.teacherUserId === null) continue;
      Object.assign(row(t.teacherUserId, t.teacher ?? ''), {
        classes: t.classes,
        completed: t.completed,
        cancelled: t.cancelled,
        substitutions: t.substitutions,
        hours: t.hours,
        completion: t.completion,
      });
    }
    for (const t of att?.byTeacher ?? []) {
      if (t.teacherUserId === null) continue;
      Object.assign(row(t.teacherUserId, t.teacher ?? ''), {
        attendanceSessions: t.sessions,
        attendance: t.percentage,
      });
    }
    for (const t of live?.byTeacher ?? []) {
      if (!t.teacherUserId) continue;
      Object.assign(row(t.teacherUserId, t.teacher), {
        liveSessions: t.sessions,
        liveHours: t.hoursDelivered,
        liveAttendance: t.attendance,
      });
    }
    for (const t of ex?.byCreator ?? []) {
      if (t.id === null) continue;
      Object.assign(row(t.id, t.name ?? ''), { exams: t.exams, examAverage: t.averagePercent });
    }
    for (const t of appts?.byTeacher ?? []) {
      if (!t.teacherUserId) continue;
      Object.assign(row(t.teacherUserId, t.teacher), {
        appointments: t.appointments,
        appointmentResponseHours: t.avgResponseHours,
      });
    }
    let list = [...rows.values()];
    if (audience === 'teacher') list = list.filter((r) => r.teacherUserId === scope.teacherUserId);
    list.sort((a, b) => a.teacher.localeCompare(b.teacher));

    const sum = (k: 'classes' | 'completed' | 'cancelled' | 'hours') => list.reduce((n, r) => n + r[k], 0);
    const optionalSum = (k: 'liveHours' | 'exams' | 'appointments') =>
      list.reduce((n, r) => n + (r[k] ?? 0), 0);
    const classes = sum('classes');
    const completion =
      classes - sum('cancelled') ? (sum('completed') / (classes - sum('cancelled'))) * 100 : null;
    return {
      summary: [
        ...when(audience !== 'teacher', metric('teachers', 'Teachers', list.length)),
        metric('classes', 'Classes scheduled', classes),
        metric(
          'completion',
          'Classes completed',
          completion === null ? null : Math.round(completion * 10) / 10,
          'percent',
          {
            tone: pctTone(completion, 90, 75),
          },
        ),
        metric('hours', 'Teaching hours', Math.round(sum('hours') * 10) / 10, 'hours'),
        ...when(
          live !== null,
          metric('liveHours', 'Live class hours', Math.round(optionalSum('liveHours') * 10) / 10, 'hours'),
        ),
        ...when(ex !== null, metric('exams', 'Exams authored', optionalSum('exams'))),
        ...when(appts !== null, metric('appointments', 'Parent appointments', optionalSum('appointments'))),
      ],
      tables: [
        table(
          'teachers',
          audience === 'teacher' ? 'Your performance' : 'Teachers',
          [
            ['teacher', 'Teacher', 'text'],
            ['classes', 'Classes', 'number'],
            ['completed', 'Completed', 'number'],
            ['cancelled', 'Cancelled', 'number'],
            ['substitutions', 'Substitutions', 'number'],
            ['hours', 'Hours', 'hours'],
            ['completion', 'Completion', 'percent'],
            ...when(
              att !== null,
              ['attendanceSessions', 'Attendance sessions', 'number'] as const,
              ['attendance', 'Student attendance', 'percent'] as const,
            ),
            ...when(
              live !== null,
              ['liveSessions', 'Live classes', 'number'] as const,
              ['liveHours', 'Live hours', 'hours'] as const,
              ['liveAttendance', 'Live attendance', 'percent'] as const,
            ),
            ...when(
              ex !== null,
              ['exams', 'Exams authored', 'number'] as const,
              ['examAverage', 'Exam average', 'percent'] as const,
            ),
            ...when(
              appts !== null,
              ['appointments', 'Appointments', 'number'] as const,
              ['appointmentResponseHours', 'Appointment response (h)', 'hours'] as const,
            ),
          ],
          list,
        ),
      ],
      notes: [
        'Completion = completed ÷ (scheduled − cancelled) timetabled classes. Student attendance covers the sessions each teacher marked.',
        ...when(
          sources.includes('appointments') && !withAppointments,
          'Appointments are not linked to courses or batches, so they are left out when a course or batch filter is set.',
        ),
      ],
    };
  },
};

const payroll: ReportDefinition = {
  key: 'payroll',
  title: 'Payroll',
  description: 'Payslips, gross and net pay and employer contributions by month and branch.',
  category: 'staff',
  filters: DATE_BRANCH,
  planModule: 'payroll',
  access: { management: ['payroll.view'], finance: ['payroll.view'] },
  async run({ scope }) {
    const r = await payrollReport(scope);
    return {
      summary: [
        metric('net', 'Net pay', r.totals.net, 'money'),
        metric('gross', 'Gross pay', r.totals.gross, 'money'),
        metric('deductions', 'Deductions', r.totals.deductions, 'money'),
        metric('employerContributions', 'Employer contributions', r.totals.employerContributions, 'money'),
        metric('costToCompany', 'Cost to company', r.totals.costToCompany, 'money'),
        metric('employees', 'Employees paid', r.totals.employees),
        metric('lopDays', 'Loss-of-pay days', r.totals.lopDays),
      ],
      tables: [
        table(
          'payslips',
          'Payslips',
          [
            ['period', 'Month', 'text'],
            ['employeeCode', 'Employee code', 'text'],
            ['employee', 'Employee', 'text'],
            ['designation', 'Designation', 'text'],
            ['department', 'Department', 'text'],
            ['branch', 'Branch', 'text'],
            ['payableDays', 'Payable days', 'number'],
            ['lopDays', 'LOP days', 'number'],
            ['gross', 'Gross', 'money'],
            ['deductions', 'Deductions', 'money'],
            ['net', 'Net', 'money'],
            ['employerContributions', 'Employer contributions', 'money'],
            ['runStatus', 'Run status', 'text'],
          ],
          r.rows,
          r.totalRows,
        ),
        table(
          'by-month',
          'By month',
          [
            ['period', 'Month', 'text'],
            ['payslips', 'Payslips', 'number'],
            ['gross', 'Gross', 'money'],
            ['deductions', 'Deductions', 'money'],
            ['net', 'Net', 'money'],
            ['employerContributions', 'Employer contributions', 'money'],
          ],
          r.byMonth,
        ),
        table(
          'by-branch',
          'By branch',
          [
            ['branch', 'Branch', 'text'],
            ['employees', 'Employees', 'number'],
            ['gross', 'Gross', 'money'],
            ['net', 'Net', 'money'],
            ['employerContributions', 'Employer contributions', 'money'],
          ],
          r.byBranch,
        ),
      ],
      notes: [
        'Payroll months overlapping the period are included. Only approved and locked payroll runs are counted.',
        ...when(
          r.totals.draftRuns > 0,
          `${r.totals.draftRuns} payroll run(s) in the period are not yet approved and are excluded.`,
        ),
      ],
    };
  },
};

const grievances: ReportDefinition = {
  key: 'grievances',
  title: 'Grievances and response times',
  description: 'Tickets raised, first-response and resolution times and SLA compliance.',
  category: 'operations',
  filters: DATE_BRANCH,
  planModule: 'grievances',
  // Staff need the ticket queue permission (`grievances.edit`); others see only tickets they raised.
  access: {
    management: ['grievances.view', 'grievances.edit'],
    teacher: ['grievances.view', 'grievances.edit'],
    student: ['grievances.view'],
    parent: ['grievances.view'],
  },
  async run({ scope, audience }) {
    const r = await grievanceReport(scope);
    const personal = isPersonal(audience);
    const statsCols = [
      ['tickets', 'Tickets', 'number'],
      ['open', 'Open', 'number'],
      ['resolved', 'Resolved', 'number'],
      ['avgFirstResponseHours', 'First response (h)', 'hours'],
      ['avgResolutionHours', 'Resolution (h)', 'hours'],
      ['slaCompliance', 'SLA compliance', 'percent'],
      ['slaBreached', 'SLA breached', 'number'],
      ['avgSatisfaction', 'Satisfaction (1–5)', 'number'],
    ] as const;
    return {
      summary: [
        metric('tickets', 'Tickets raised', r.totals.tickets),
        metric('open', 'Open', r.totals.open, 'number', { tone: r.totals.open ? 'warning' : 'success' }),
        metric('resolved', 'Resolved', r.totals.resolved),
        metric('avgFirstResponseHours', 'Avg first response', r.totals.avgFirstResponseHours, 'hours'),
        metric('avgResolutionHours', 'Avg resolution time', r.totals.avgResolutionHours, 'hours'),
        ...when(
          !personal,
          metric('slaCompliance', 'SLA compliance', r.totals.slaCompliance, 'percent', {
            tone: pctTone(r.totals.slaCompliance, 90, 75),
          }),
          metric('slaBreached', 'SLA breached', r.totals.slaBreached, 'number', {
            tone: r.totals.slaBreached ? 'danger' : 'success',
          }),
          metric('escalated', 'Escalated', r.totals.escalated),
          metric('avgSatisfaction', 'Satisfaction (1–5)', r.totals.avgSatisfaction),
        ),
      ],
      tables: [
        table(
          'tickets',
          'Tickets',
          [
            ['ticketNumber', 'Ticket', 'text'],
            ['createdAt', 'Raised', 'datetime'],
            ['branch', 'Branch', 'text'],
            ['category', 'Category', 'text'],
            ['subject', 'Subject', 'text'],
            ['priority', 'Priority', 'text'],
            ['status', 'Status', 'text'],
            ...when(!personal, ['assignee', 'Assignee', 'text'] as const),
            ['firstResponseHours', 'First response (h)', 'hours'],
            ['resolutionHours', 'Resolution (h)', 'hours'],
            ['dueAt', 'Due', 'datetime'],
            ['slaBreached', 'SLA breached', 'text'],
            ['reopened', 'Reopened', 'number'],
            ['rating', 'Rating', 'number'],
          ],
          r.rows,
          r.totalRows,
        ),
        table('by-category', 'By category', [['category', 'Category', 'text'], ...statsCols], r.byCategory),
        ...when(
          !personal,
          table('by-branch', 'By branch', [['branch', 'Branch', 'text'], ...statsCols], r.byBranch),
        ),
        ...when(
          audience === 'management',
          table('by-assignee', 'By assignee', [['assignee', 'Assignee', 'text'], ...statsCols], r.byAssignee),
        ),
      ],
      notes: [
        'Times are measured from when a ticket was raised. SLA compliance = tickets resolved within SLA ÷ tickets resolved.',
        ...when(audience === 'teacher', 'Showing tickets assigned to you.'),
        ...when(personal, 'Showing tickets you raised.'),
      ],
    };
  },
};

const appointments: ReportDefinition = {
  key: 'appointments',
  title: 'Appointments',
  description: 'Parent–teacher appointments, response times and attendance by teacher and branch.',
  category: 'operations',
  filters: DATE_BRANCH,
  planModule: 'appointments',
  access: {
    management: ['appointments.view'],
    teacher: ['appointments.view'],
    parent: ['appointments.view'],
  },
  async run({ scope, audience }) {
    const r = await appointmentReport(scope);
    const statsCols = [
      ['appointments', 'Appointments', 'number'],
      ['confirmed', 'Confirmed', 'number'],
      ['completed', 'Completed', 'number'],
      ['cancelled', 'Cancelled', 'number'],
      ['rejected', 'Rejected', 'number'],
      ['noShow', 'No-show', 'number'],
      ['avgResponseHours', 'Response (h)', 'hours'],
      ['attendanceRate', 'Attendance', 'percent'],
    ] as const;
    return {
      summary: [
        metric('appointments', 'Appointments', r.totals.appointments),
        metric('requested', 'Awaiting response', r.totals.requested, 'number', {
          tone: r.totals.requested ? 'warning' : 'medium',
        }),
        metric('confirmed', 'Confirmed', r.totals.confirmed),
        metric('completed', 'Completed', r.totals.completed, 'number', { tone: 'success' }),
        metric('cancelled', 'Cancelled', r.totals.cancelled),
        metric('noShow', 'No-show', r.totals.noShow),
        metric('avgResponseHours', 'Avg response time', r.totals.avgResponseHours, 'hours'),
        metric('attendanceRate', 'Attendance', r.totals.attendanceRate, 'percent'),
      ],
      tables: [
        table(
          'appointments',
          'Appointments',
          [
            ['date', 'Date', 'date'],
            ['time', 'Time', 'text'],
            ['branch', 'Branch', 'text'],
            ['teacher', 'Teacher', 'text'],
            ['student', 'Student', 'text'],
            ['mode', 'Mode', 'text'],
            ['status', 'Status', 'text'],
            ['responseHours', 'Response (h)', 'hours'],
          ],
          r.rows,
          r.totalRows,
        ),
        ...when(
          audience === 'management',
          table('by-teacher', 'By teacher', [['teacher', 'Teacher', 'text'], ...statsCols], r.byTeacher),
          table('by-branch', 'By branch', [['branch', 'Branch', 'text'], ...statsCols], r.byBranch),
        ),
      ],
      notes: ['Response time is from the request to the teacher confirming or declining it.'],
    };
  },
};

const liveClasses: ReportDefinition = {
  key: 'live-classes',
  title: 'Live classes',
  description: 'Live classes held, hours delivered and student attendance.',
  category: 'operations',
  filters: ALL_FILTERS,
  planModule: 'live-classes',
  access: {
    management: ['live-classes.view'],
    teacher: ['live-classes.view'],
    student: ['live-classes.view'],
    parent: ['parent-portal.view'],
  },
  async run({ scope, audience }) {
    const r = await liveClassReport(scope);
    const statsCols = [
      ['sessions', 'Classes', 'number'],
      ['ended', 'Held', 'number'],
      ['cancelled', 'Cancelled', 'number'],
      ['missed', 'Not started', 'number'],
      ['hoursDelivered', 'Hours delivered', 'hours'],
      ['attendees', 'Attendees', 'number'],
      ['attendance', 'Attendance', 'percent'],
      ['avgMinutesAttended', 'Avg minutes attended', 'number'],
    ] as const;
    if (r.own) {
      return {
        summary: [
          metric('sessions', 'Classes scheduled', r.own.sessions),
          metric('ended', 'Classes held', r.own.ended),
          metric('attended', 'Classes attended', r.own.attended),
          metric('attendance', 'Attendance', r.own.attendance, 'percent', {
            tone: pctTone(r.own.attendance),
          }),
          metric('minutesAttended', 'Minutes attended', r.own.minutesAttended),
          metric('upcoming', 'Upcoming classes', r.totals.upcoming),
        ],
        tables: [
          table(
            'classes',
            'Live classes',
            [
              ['startAt', 'Starts', 'datetime'],
              ['title', 'Class', 'text'],
              ['batch', 'Batch', 'text'],
              ['teacher', 'Teacher', 'text'],
              ['status', 'Status', 'text'],
              ['student', 'Student', 'text'],
              ['attended', 'Attended', 'text'],
              ['minutesAttended', 'Minutes attended', 'number'],
            ],
            r.rows,
            r.totalRows,
          ),
        ],
        notes: ['One row per class per student.'],
      };
    }
    return {
      summary: [
        metric('sessions', 'Classes scheduled', r.totals.sessions),
        metric('ended', 'Classes held', r.totals.ended),
        metric('cancelled', 'Cancelled', r.totals.cancelled),
        metric('missed', 'Not started', r.totals.missed, 'number', {
          tone: r.totals.missed ? 'danger' : 'medium',
        }),
        metric('hoursDelivered', 'Hours delivered', r.totals.hoursDelivered, 'hours'),
        metric('attendance', 'Attendance', r.totals.attendance, 'percent', {
          tone: pctTone(r.totals.attendance),
        }),
        metric('avgMinutesAttended', 'Avg minutes attended', r.totals.avgMinutesAttended),
      ],
      tables: [
        table(
          'classes',
          'Live classes',
          [
            ['startAt', 'Starts', 'datetime'],
            ['title', 'Class', 'text'],
            ['batch', 'Batch', 'text'],
            ['branch', 'Branch', 'text'],
            ['teacher', 'Teacher', 'text'],
            ['status', 'Status', 'text'],
            ['scheduledMinutes', 'Scheduled (min)', 'number'],
            ['deliveredMinutes', 'Delivered (min)', 'number'],
            ['enrolled', 'Enrolled', 'number'],
            ['attendees', 'Attendees', 'number'],
            ['attendance', 'Attendance', 'percent'],
            ['avgMinutesAttended', 'Avg minutes attended', 'number'],
          ],
          r.rows,
          r.totalRows,
        ),
        ...when(
          audience === 'management',
          table('by-teacher', 'By teacher', [['teacher', 'Teacher', 'text'], ...statsCols], r.byTeacher),
        ),
        table('by-branch', 'By branch', [['branch', 'Branch', 'text'], ...statsCols], r.byBranch),
      ],
      notes: [
        "Attendance compares students who joined a class that was held with the batch's current active enrolment.",
        '"Not started" are scheduled classes whose end time passed without the class being started.',
      ],
    };
  },
};

const lmsEngagement: ReportDefinition = {
  key: 'lms-engagement',
  title: 'LMS engagement',
  description: 'Learner activity on study material and assignment submissions.',
  category: 'academic',
  filters: ALL_FILTERS,
  planModule: 'lms',
  access: {
    management: ['lms.view'],
    teacher: ['lms.view'],
    student: ['lms.view'],
    parent: ['lms.view'],
  },
  async run({ scope, audience }) {
    const r = await lmsEngagementReport(scope);
    const personal = isPersonal(audience);
    return {
      summary: [
        ...when(
          !personal,
          metric('learners', 'Learners', r.totals.learners),
          metric('engagement', 'Active learners', r.totals.engagement, 'percent', {
            tone: pctTone(r.totals.engagement, 70, 40),
          }),
        ),
        metric('resourcesViewed', 'Resources viewed', r.totals.resourcesViewed),
        metric('resourcesCompleted', 'Resources completed', r.totals.resourcesCompleted),
        metric('watchHours', 'Watch time', r.totals.watchHours, 'hours'),
        metric('submissions', 'Assignments submitted', r.totals.submissions),
        metric('submissionRate', 'Submission rate', r.totals.submissionRate, 'percent', {
          tone: pctTone(r.totals.submissionRate, 80, 50),
        }),
        metric('averageMarks', 'Average marks', r.totals.averageMarks, 'percent'),
      ],
      tables: [
        table(
          'learners',
          'Learners',
          [
            ['student', 'Student', 'text'],
            ['batch', 'Batch', 'text'],
            ['branch', 'Branch', 'text'],
            ['resourcesViewed', 'Viewed', 'number'],
            ['resourcesCompleted', 'Completed', 'number'],
            ['watchMinutes', 'Watch minutes', 'number'],
            ['assignmentsDue', 'Assignments due', 'number'],
            ['assignmentsSubmitted', 'Submitted', 'number'],
            ['lateSubmissions', 'Late', 'number'],
            ['submissionRate', 'Submission rate', 'percent'],
            ['averageMarks', 'Average marks', 'percent'],
            ['lastActiveAt', 'Last active', 'datetime'],
          ],
          r.rows,
          r.totalRows,
        ),
        table(
          'top-resources',
          'Most viewed resources',
          [
            ['resource', 'Resource', 'text'],
            ['type', 'Type', 'text'],
            ['learners', 'Learners', 'number'],
            ['completed', 'Completed', 'number'],
            ['averageProgress', 'Average progress', 'percent'],
          ],
          r.topResources,
        ),
        ...when(
          !personal,
          table(
            'by-branch',
            'By branch',
            [
              ['branch', 'Branch', 'text'],
              ['learners', 'Learners', 'number'],
              ['activeLearners', 'Active', 'number'],
              ['engagement', 'Engagement', 'percent'],
              ['resourcesViewed', 'Resources viewed', 'number'],
              ['assignmentsSubmitted', 'Submissions', 'number'],
            ],
            r.byBranch,
          ),
        ),
      ],
      notes: [
        "Learners are active batch enrolments. A resource view counts in the period of the learner's most recent access.",
      ],
    };
  },
};

const DEFINITION_LIST: ReportDefinition[] = [
  feeCollections,
  outstandingDues,
  admissions,
  capacity,
  attendance,
  exams,
  teacherPerformance,
  payroll,
  grievances,
  appointments,
  liveClasses,
  lmsEngagement,
];

export const REPORT_DEFINITIONS: ReadonlyMap<ReportKey, ReportDefinition> = new Map(
  DEFINITION_LIST.map((d) => [d.key, d]),
);

if (REPORT_DEFINITIONS.size !== REPORT_KEYS.length) {
  throw new Error('Every report key needs exactly one definition');
}

// ---------------------------------------------------------------- access

/** Plan modules enabled for the institute (null = all). */
export async function enabledModules(instituteId: number): Promise<string[] | null> {
  return (await getPlanLimits(instituteId)).enabledModules;
}

const permitted = (access: Access, audience: ReportAudience) => {
  const required = access[audience];
  return !!required && required.every((p) => hasPermission(p));
};

export const planAllows = (modules: string[] | null, planModule: string) =>
  modules === null || modules.includes(planModule);

/** Optional sources of a report the audience may see with the institute's plan modules. */
export const sourcesFor = (def: ReportDefinition, audience: ReportAudience, modules: string[] | null) =>
  (def.sources ?? [])
    .filter((s) => permitted(s.access, audience) && planAllows(modules, s.planModule))
    .map((s) => s.key);

/** Reports the caller may open: permitted for their role and enabled by the plan. */
export async function availableReports(): Promise<ReportDefinition[]> {
  const ctx = requireTenantContext();
  const audience = resolveAudience(ctx);
  const modules = await enabledModules(ctx.instituteId);
  return DEFINITION_LIST.filter((d) => permitted(d.access, audience) && planAllows(modules, d.planModule));
}

export const catalogItem = (d: ReportDefinition): ReportCatalogItemDto => ({
  key: d.key,
  title: d.title,
  description: d.description,
  category: d.category,
  filters: d.filters,
  planModule: d.planModule,
  exportable: hasPermission('reports.export'),
});

/** Looks up a report the caller may open (404 unknown, 403 not for the role or plan). */
export async function getDefinition(key: string): Promise<ReportDefinition> {
  const def = REPORT_DEFINITIONS.get(key as ReportKey);
  if (!def) throw NotFound('Report');
  const ctx = requireTenantContext();
  if (!permitted(def.access, resolveAudience(ctx))) {
    throw Forbidden('This report is not available for your role', 'REPORT_FORBIDDEN');
  }
  if (!planAllows(await enabledModules(ctx.instituteId), def.planModule)) {
    throw Forbidden(`The ${def.planModule} module is not enabled for this institute`, 'MODULE_DISABLED');
  }
  return def;
}

const FILTER_FIELDS: [keyof ReportFiltersInput, ReportFilterKind][] = [
  ['branchId', 'branch'],
  ['courseId', 'course'],
  ['batchId', 'batch'],
];

/** Checks access and filters and resolves the caller's scope, including the optional sources. */
export async function prepareReport(
  key: string,
  input: ReportFiltersInput,
  limit: number,
): Promise<{ def: ReportDefinition; req: ResolvedReportRequest }> {
  const def = await getDefinition(key);
  for (const [field, kind] of FILTER_FIELDS) {
    if (input[field] && !def.filters.includes(kind)) {
      throw BadRequest(`The ${kind} filter is not available for the ${def.title} report`);
    }
  }
  const req = await resolveReportRequest(input, limit);
  req.sources = sourcesFor(def, req.audience, await enabledModules(req.scope.instituteId));
  return { def, req };
}

const fmtCount = (n: number) => n.toLocaleString('en-IN');

/** Runs a prepared report; `exportLimit` words the truncation notes for exports. */
export async function runReport(
  def: ReportDefinition,
  req: ResolvedReportRequest,
  opts: { exportLimit?: number } = {},
): Promise<ReportResultDto> {
  const body = await def.run(req);
  const notes = [...body.notes];
  for (const t of body.tables) {
    if (t.rows.length >= t.totalRows) continue;
    notes.push(
      opts.exportLimit
        ? `${t.title}: limited to the first ${fmtCount(t.rows.length)} of ${fmtCount(t.totalRows)} rows. Narrow the filters to export the rest.`
        : `${t.title}: showing the first ${fmtCount(t.rows.length)} of ${fmtCount(t.totalRows)} rows. Export the report for the full list.`,
    );
  }
  return {
    key: def.key,
    title: def.title,
    description: def.description,
    generatedAt: new Date().toISOString(),
    period: req.period,
    filters: req.filters,
    scope: { audience: req.audience, label: req.scopeLabel },
    summary: body.summary,
    tables: body.tables,
    notes,
  };
}
