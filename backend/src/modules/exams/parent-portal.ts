import { Op } from 'sequelize';
import type { ParentChildDto, ParentPortalSectionDto } from '@erp/shared';
import { requireTenantContext } from '../../shared/context';
import { getInstituteTimezone, nowInZone, zonedDateTimeToUtc } from '../../shared/timezone';
import { registerParentPortalProvider } from '../parent-portal/api';
import { Exam, ExamAttempt } from './models';
import { MODULE } from './exams.service';

const LABEL = 'Exam results';

/** Attempts of published exams only; unpublished (or unpublished-again) results never leak. */
async function publishedAttempts(studentUserId: number, examWhere: Record<string, unknown>, limit?: number) {
  const { instituteId } = requireTenantContext();
  return ExamAttempt.findAll({
    where: { instituteId, studentUserId, status: { [Op.ne]: 'in_progress' } },
    include: [
      {
        model: Exam,
        as: 'exam',
        required: true,
        attributes: ['id', 'title', 'startAt', 'passMarks', 'resultsPublishedAt'],
        where: { instituteId, status: 'scheduled', resultsPublishedAt: { [Op.ne]: null }, ...examWhere },
      },
    ],
    order: [[{ model: Exam, as: 'exam' }, 'resultsPublishedAt', 'DESC']],
    limit,
  });
}

/** Half-open UTC range `[from 00:00, to+1 00:00)` of institute-local dates. */
async function localDayRange(from: string, to: string) {
  const tz = await getInstituteTimezone(requireTenantContext().instituteId);
  const next = new Date(Date.parse(`${to}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  return {
    tz,
    range: {
      [Op.gte]: zonedDateTimeToUtc(from, '00:00', tz),
      [Op.lt]: zonedDateTimeToUtc(next, '00:00', tz),
    },
  };
}

const pct = (a: ExamAttempt) => (a.maxScore > 0 ? Math.round((a.totalScore / a.maxScore) * 1000) / 10 : null);

function section(attempts: ExamAttempt[], countLabel: string, tz: string): ParentPortalSectionDto | null {
  if (!attempts.length) return null;
  const scores = attempts.map(pct).filter((x): x is number => x !== null);
  const avg = scores.length
    ? Math.round((scores.reduce((s, x) => s + x, 0) / scores.length) * 10) / 10
    : null;
  return {
    key: MODULE,
    label: LABEL,
    metrics: [
      { label: countLabel, value: attempts.length },
      ...(avg !== null ? [{ label: 'Average score', value: `${avg}%` }] : []),
    ],
    items: attempts.map((a) => {
      const p = pct(a);
      const parts = [`${a.totalScore}/${a.maxScore}${p !== null ? ` (${p}%)` : ''}`];
      if (a.rank) parts.push(`Rank ${a.rank}`);
      if (a.exam?.passMarks != null) parts.push(a.totalScore >= a.exam.passMarks ? 'Pass' : 'Fail');
      return {
        title: a.exam?.title ?? 'Exam',
        subtitle: parts.join(' · '),
        date: a.exam ? nowInZone(tz, a.exam.startAt).date : undefined,
        link: `/exam-results/${a.id}`,
      };
    }),
  };
}

/** Registers the exams provider for the parent home and monthly report (called from `onReady`). */
export function registerExamsParentPortal(): void {
  registerParentPortalProvider({
    key: MODULE,
    label: LABEL,
    order: 40,
    async summary(child: ParentChildDto) {
      if (!child.studentUserId) return null;
      const tz = await getInstituteTimezone(requireTenantContext().instituteId);
      return section(await publishedAttempts(child.studentUserId, {}, 3), 'Latest results', tz);
    },
    async monthlyReport(child, { from, to }) {
      if (!child.studentUserId) return null;
      const { tz, range } = await localDayRange(from, to);
      return section(await publishedAttempts(child.studentUserId, { startAt: range }), 'Exams taken', tz);
    },
  });
}
