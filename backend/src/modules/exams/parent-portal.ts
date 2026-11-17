import { Op } from 'sequelize';
import type { ParentChildDto, ParentPortalSectionDto } from '@erp/shared';
import { requireTenantContext } from '../../shared/context';
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

const pct = (a: ExamAttempt) => (a.maxScore > 0 ? Math.round((a.totalScore / a.maxScore) * 1000) / 10 : null);

function section(attempts: ExamAttempt[], countLabel: string): ParentPortalSectionDto | null {
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
        date: a.exam?.startAt.toISOString().slice(0, 10),
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
      return section(await publishedAttempts(child.studentUserId, {}, 3), 'Latest results');
    },
    async monthlyReport(child, { from, to }) {
      if (!child.studentUserId) return null;
      const range = {
        startAt: { [Op.between]: [new Date(`${from}T00:00:00`), new Date(`${to}T23:59:59.999`)] },
      };
      return section(await publishedAttempts(child.studentUserId, range), 'Exams taken');
    },
  });
}
