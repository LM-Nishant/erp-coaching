import { Op } from 'sequelize';
import type {
  AttemptSummaryDto,
  ChildResultListItem,
  ExamAnalyticsDto,
  QuestionResultDto,
  ResultCorrectionInput,
  ResultDto,
  TopicStat,
} from '@erp/shared';
import { BadRequest, Conflict, NotFound } from '../../shared/errors';
import { audit } from '../../shared/audit/audit.service';
import { logger } from '../../infrastructure/logger';
import { FileObject } from '../files/file.model';
import { User } from '../users/user.model';
import { getLinkedStudentUsers } from '../guardians/guardian-access';
import { guardiansOfStudentUsers, notify } from '../notifications/api';
import { toCsv } from '../question-bank/spreadsheet';
import { ExamAnswer, ExamAnswerPage, ExamAttempt, ExamEvaluation, ExamQuestion, Exam } from './models';
import {
  attemptRepo,
  eligibleStudentUserIds,
  examDto,
  examQuestionRepo,
  examRepo,
  examTenantRepo,
  loadExamForDto,
  me,
  sectionRepo,
} from './exams.service';
import {
  answerRepo,
  closeOverdueAttempts,
  correctionRepo,
  effectiveMarks,
  finalizeAttempt,
  instituteFiles,
  pageDto,
  recomputeAttempt,
} from './attempts.service';
import { signedUrlFor } from '../files/files.service';
import { rankScores, round2 } from './scoring';
import { SimplePdf } from './pdf';
import { correctionDto, recordRevision, recordRevisions } from './revisions';

// ---------------------------------------------------------------- DTOs

function summaryDto(a: ExamAttempt): AttemptSummaryDto {
  return {
    id: a.id,
    examId: a.examId,
    studentUserId: a.studentUserId,
    studentName: a.student?.name ?? null,
    status: a.status,
    startedAt: a.startedAt.toISOString(),
    submittedAt: a.submittedAt?.toISOString() ?? null,
    objectiveScore: a.objectiveScore,
    descriptiveScore: a.descriptiveScore,
    totalScore: a.totalScore,
    maxScore: a.maxScore,
    pendingEvaluations: a.pendingEvaluations,
    rank: a.rank,
    percentile: a.percentile,
  };
}

const studentInclude = { model: User, as: 'student', attributes: ['id', 'name'] };

function topicKey(chapterName: string | null, topicName: string | null) {
  return `${chapterName ?? 'Uncategorised'}|${topicName ?? ''}`;
}

function addStat(
  map: Map<string, TopicStat>,
  chapterName: string | null,
  topicName: string | null,
  score: number,
  max: number,
) {
  const key = topicKey(chapterName, topicName);
  const s = map.get(key) ?? { key, chapterName, topicName, score: 0, maxScore: 0, accuracy: 0 };
  s.score += score;
  s.maxScore += max;
  map.set(key, s);
}

function finishStats(map: Map<string, TopicStat>): TopicStat[] {
  return [...map.values()]
    .map((s) => ({
      ...s,
      score: round2(s.score),
      maxScore: round2(s.maxScore),
      accuracy: s.maxScore > 0 ? round2((Math.max(s.score, 0) / s.maxScore) * 100) : 0,
    }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

// ---------------------------------------------------------------- detailed result

async function buildResult(
  attempt: ExamAttempt,
  exam: Exam,
  opts: { revealKey: boolean },
): Promise<ResultDto> {
  const eqs = await examQuestionRepo.findAll({ where: { examId: exam.id } });
  const sections = await sectionRepo.findAll({
    where: { examId: exam.id },
    order: [
      ['sortOrder', 'ASC'],
      ['id', 'ASC'],
    ],
  });
  const answers = await answerRepo.findAll({
    where: { attemptId: attempt.id },
    include: [
      { model: ExamEvaluation, as: 'evaluation' },
      { model: ExamAnswerPage, as: 'pages', include: [{ model: FileObject, as: 'file' }] },
    ],
  });
  const byEq = new Map(answers.map((a) => [a.examQuestionId, a]));
  const marks = await effectiveMarks(answers.map((a) => a.id));
  const corrections = answers.length
    ? await correctionRepo.findAll({
        where: { answerId: answers.map((a) => a.id) },
        include: [{ model: User, as: 'correctedBy', attributes: ['id', 'name'] }],
        order: [['id', 'ASC']],
      })
    : [];
  const eqById = new Map(eqs.map((q) => [q.id, q]));
  const optionFiles = new Map(
    (
      await instituteFiles([
        ...new Set(
          eqs.flatMap((q) => q.snapshot.options.map((o) => o.imageFileId).filter((x): x is number => !!x)),
        ),
      ])
    ).map((f) => [f.id, signedUrlFor(f).url]),
  );
  const order = attempt.questionOrder.filter((id) => eqById.has(id));
  for (const q of eqs) if (!order.includes(q.id)) order.push(q.id);

  const sectionScores = new Map(
    sections.map((s) => [s.id, { id: s.id, title: s.title, score: 0, maxScore: 0 }]),
  );
  const topics = new Map<string, TopicStat>();
  const questions: QuestionResultDto[] = order.map((id) => {
    const eq = eqById.get(id)!;
    const snap = eq.snapshot;
    const ans = byEq.get(id);
    const m = ans ? (marks.get(ans.id) ?? null) : 0;
    const sec = sectionScores.get(eq.sectionId);
    if (sec) {
      sec.score += m ?? 0;
      sec.maxScore += eq.marks;
    }
    addStat(topics, snap.chapterName, snap.topicName, m ?? 0, eq.marks);
    const ev = ans?.evaluation;
    const feedback = ev ? (ev.finalMarks != null ? (ev.teacherFeedback ?? ev.aiFeedback) : null) : null;
    return {
      examQuestionId: id,
      answerId: ans?.id ?? null,
      sectionId: eq.sectionId,
      type: snap.type,
      text: snap.text,
      options: snap.options.map((o) => ({
        ...o,
        imageUrl: o.imageFileId ? (optionFiles.get(o.imageFileId) ?? null) : null,
      })),
      response: ans?.response ?? null,
      pages: [...(ans?.pages ?? [])].sort((a, b) => a.pageNo - b.pageNo).map(pageDto),
      correct: opts.revealKey ? snap.answerKey : null,
      explanation: opts.revealKey ? snap.explanation : null,
      isCorrect: ans?.isCorrect ?? (snap.type === 'descriptive' ? null : false),
      marks: m,
      maxMarks: eq.marks,
      feedback,
      chapterName: snap.chapterName,
      topicName: snap.topicName,
    };
  });
  return {
    attempt: summaryDto(attempt),
    exam: examDto(exam),
    passed:
      exam.passMarks != null && attempt.pendingEvaluations === 0
        ? attempt.totalScore >= exam.passMarks
        : null,
    sections: [...sectionScores.values()].map((s) => ({
      ...s,
      score: round2(s.score),
      maxScore: round2(s.maxScore),
    })),
    chapters: finishStats(topics),
    questions,
    corrections: corrections.map(correctionDto),
  };
}

// ---------------------------------------------------------------- staff views

export async function listAttempts(examId: number): Promise<AttemptSummaryDto[]> {
  const exam = await examRepo.findById(examId);
  await closeOverdueAttempts(exam);
  const rows = await attemptRepo.findAll({
    where: { examId },
    include: [studentInclude],
    order: [
      ['totalScore', 'DESC'],
      ['id', 'ASC'],
    ],
  });
  return rows.map(summaryDto);
}

export async function staffResult(examId: number, attemptId: number): Promise<ResultDto> {
  const exam = await loadExamForDto(examId);
  const attempt = await attemptRepo.findOne({ where: { id: attemptId, examId }, include: [studentInclude] });
  if (!attempt) throw NotFound('Attempt');
  return buildResult(attempt, exam, { revealKey: true });
}

export async function resultsCsv(examId: number): Promise<{ filename: string; csv: string }> {
  const exam = await examRepo.findById(examId);
  const rows = await listAttempts(examId);
  const csv = toCsv([
    [
      'Rank',
      'Student',
      'Status',
      'Objective',
      'Descriptive',
      'Total',
      'Max',
      'Percentile',
      'Pending evaluations',
      'Submitted at',
    ],
    ...rows.map((r) =>
      [
        r.rank ?? '',
        r.studentName ?? `#${r.studentUserId}`,
        r.status,
        r.objectiveScore,
        r.descriptiveScore,
        r.totalScore,
        r.maxScore,
        r.percentile ?? '',
        r.pendingEvaluations,
        r.submittedAt ?? '',
      ].map(String),
    ),
  ]);
  return { filename: `${exam.title.replace(/[^\w-]+/g, '_').slice(0, 60)}-results.csv`, csv };
}

export async function analytics(examId: number): Promise<ExamAnalyticsDto> {
  const exam = await examRepo.findById(examId);
  await closeOverdueAttempts(exam);
  const attempts = await attemptRepo.findAll({ where: { examId } });
  const closed = attempts.filter((a) => a.status !== 'in_progress');
  const eqs = await examQuestionRepo.findAll({
    where: { examId },
    order: [
      ['sortOrder', 'ASC'],
      ['id', 'ASC'],
    ],
  });
  const answers = closed.length
    ? await answerRepo.findAll({ where: { attemptId: closed.map((a) => a.id) } })
    : [];
  const marks = await effectiveMarks(answers.map((a) => a.id));
  const byEq = new Map<number, ExamAnswer[]>();
  for (const a of answers) byEq.set(a.examQuestionId, [...(byEq.get(a.examQuestionId) ?? []), a]);

  const topics = new Map<string, TopicStat>();
  const questions = eqs.map((eq) => {
    const list = byEq.get(eq.id) ?? [];
    const total = list.reduce((s, a) => s + (marks.get(a.id) ?? 0), 0);
    addStat(topics, eq.snapshot.chapterName, eq.snapshot.topicName, total, eq.marks * closed.length);
    return {
      examQuestionId: eq.id,
      text: eq.snapshot.text.slice(0, 200),
      type: eq.snapshot.type,
      attempted: list.filter((a) => a.response != null).length,
      correct: list.filter((a) => a.isCorrect === true).length,
      averageMarks: closed.length ? round2(total / closed.length) : 0,
      maxMarks: eq.marks,
    };
  });

  const scores = closed.map((a) => a.totalScore).sort((a, b) => a - b);
  const maxScore = round2(eqs.reduce((s, q) => s + q.marks, 0));
  const median = scores.length
    ? scores.length % 2
      ? scores[(scores.length - 1) / 2]
      : (scores[scores.length / 2 - 1] + scores[scores.length / 2]) / 2
    : 0;
  const distribution = Array.from({ length: 10 }, (_, i) => ({
    range: `${i * 10}-${i === 9 ? 100 : i * 10 + 9}%`,
    count: 0,
  }));
  for (const s of scores) {
    const pct = maxScore > 0 ? Math.max(0, s / maxScore) * 100 : 0;
    distribution[Math.min(9, Math.floor(pct / 10))].count++;
  }
  return {
    examId,
    attempts: attempts.length,
    submitted: closed.length,
    eligible: (await eligibleStudentUserIds(exam)).length,
    average: scores.length ? round2(scores.reduce((s, x) => s + x, 0) / scores.length) : 0,
    highest: scores.length ? scores[scores.length - 1] : 0,
    lowest: scores.length ? scores[0] : 0,
    median: round2(median),
    passCount: exam.passMarks != null ? scores.filter((s) => s >= exam.passMarks!).length : null,
    distribution,
    topics: finishStats(topics),
    questions,
  };
}

// ---------------------------------------------------------------- publishing & ranking

async function rankExam(exam: Exam) {
  const attempts = await attemptRepo.findAll({
    where: { examId: exam.id, status: { [Op.ne]: 'in_progress' } },
  });
  const ranks = rankScores(attempts.map((a) => ({ id: a.id, score: a.totalScore })));
  for (const a of attempts) {
    const r = ranks.get(a.id)!;
    if (a.rank !== r.rank || a.percentile !== r.percentile)
      await a.update({ rank: r.rank, percentile: r.percentile });
  }
  return attempts;
}

/** Attempt-level snapshot of the marks students see (or stop seeing), kept in the marks trail. */
async function snapshotPublishedMarks(
  exam: Exam,
  attempts: ExamAttempt[],
  kind: 'published' | 'unpublished',
) {
  const answers = attempts.length
    ? await answerRepo.findAll({
        where: { attemptId: attempts.map((a) => a.id) },
        attributes: ['id', 'attemptId'],
      })
    : [];
  const marks = await effectiveMarks(answers.map((a) => a.id));
  await recordRevisions(
    attempts.map((a) => ({
      examId: exam.id,
      attemptId: a.id,
      answerId: null,
      kind,
      source: 'system' as const,
      marks: a.totalScore,
      metadata: {
        maxScore: a.maxScore,
        objectiveScore: a.objectiveScore,
        descriptiveScore: a.descriptiveScore,
        rank: a.rank,
        percentile: a.percentile,
        answers: Object.fromEntries(
          answers.filter((x) => x.attemptId === a.id).map((x) => [String(x.id), marks.get(x.id) ?? null]),
        ),
      },
    })),
  );
}

export async function publishResults(examId: number) {
  const exam = await examRepo.findById(examId);
  if (exam.status !== 'scheduled')
    throw Conflict('Only scheduled exams can be published', 'EXAM_NOT_SCHEDULED');
  if (exam.resultsPublishedAt) throw Conflict('Results are already published', 'RESULTS_PUBLISHED');
  if (Date.now() < exam.endAt.getTime())
    throw Conflict('The exam window has not closed yet', 'EXAM_NOT_CLOSED');
  const open = await attemptRepo.findAll({ where: { examId, status: 'in_progress' } });
  for (const a of open) await finalizeAttempt(a, exam, 'auto_submitted');
  const pending = await attemptRepo.count({ examId, pendingEvaluations: { [Op.gt]: 0 } });
  if (pending)
    throw Conflict(`${pending} submission(s) still have answers awaiting evaluation`, 'EVALUATION_PENDING', {
      pending,
    });
  const attempts = await rankExam(exam);
  await exam.update({ resultsPublishedAt: new Date(), resultsPublishedBy: me() });
  await snapshotPublishedMarks(exam, attempts, 'published');
  await audit({
    action: 'exam.results_published',
    entityType: 'exam',
    entityId: examId,
    metadata: { attempts: attempts.length },
  });

  const students = await User.findAll({
    where: { id: attempts.map((a) => a.studentUserId) },
    attributes: ['id', 'name'],
  });
  const names = new Map(students.map((u) => [u.id, u.name]));
  for (const a of attempts) {
    await notify({
      event: 'results.published',
      recipients: [
        { userIds: [a.studentUserId], type: 'student' },
        guardiansOfStudentUsers([a.studentUserId]),
      ],
      data: {
        student: { name: names.get(a.studentUserId) ?? 'Student' },
        exam: exam.title,
        score: `${a.totalScore}/${a.maxScore}${a.rank ? ` (rank ${a.rank})` : ''}`,
      },
      branchId: exam.branchId,
    }).catch((err) => logger.warn({ err, attemptId: a.id }, 'Result notification failed'));
  }
  return examDto(await loadExamForDto(examId));
}

export async function unpublishResults(examId: number) {
  const exam = await examRepo.findById(examId);
  if (!exam.resultsPublishedAt) throw Conflict('Results are not published', 'RESULTS_NOT_PUBLISHED');
  await exam.update({ resultsPublishedAt: null, resultsPublishedBy: null });
  const attempts = await attemptRepo.findAll({ where: { examId, status: { [Op.ne]: 'in_progress' } } });
  await snapshotPublishedMarks(exam, attempts, 'unpublished');
  await audit({ action: 'exam.results_unpublished', entityType: 'exam', entityId: examId });
  return examDto(await loadExamForDto(examId));
}

/** Authorised correction of one answer's marks. The original evaluation is kept; corrections stack. */
export async function correctResult(examId: number, input: ResultCorrectionInput): Promise<ResultDto> {
  const exam = await loadExamForDto(examId);
  const answer = await answerRepo.findOne({
    where: { id: input.answerId },
    include: [
      { model: ExamAttempt, as: 'attempt' },
      { model: ExamQuestion, as: 'examQuestion' },
    ],
  });
  if (!answer || answer.attempt!.examId !== examId) throw NotFound('Answer');
  if (answer.attempt!.status === 'in_progress')
    throw Conflict('The attempt is still in progress', 'ATTEMPT_OPEN');
  const eq = answer.examQuestion!;
  const min = eq.snapshot.type === 'descriptive' ? 0 : -eq.negativeMarks;
  if (input.marks < min || input.marks > eq.marks)
    throw BadRequest(`Marks must be between ${min} and ${eq.marks}`);
  const before = (await effectiveMarks([answer.id])).get(answer.id) ?? null;
  const c = await correctionRepo.create({
    attemptId: answer.attemptId,
    answerId: answer.id,
    beforeMarks: before,
    afterMarks: round2(input.marks),
    reason: input.reason,
    correctedByUserId: me(),
  });
  await recordRevision({
    examId,
    attemptId: answer.attemptId,
    answerId: answer.id,
    kind: 'correction',
    source: 'teacher',
    marks: c.afterMarks,
    previousMarks: before,
    correctionId: c.id,
    metadata: { reason: input.reason, afterPublish: !!exam.resultsPublishedAt },
  });
  await recomputeAttempt(answer.attemptId);
  if (exam.resultsPublishedAt) await rankExam(exam);
  await audit({
    action: 'exam.result_corrected',
    entityType: 'exam_answer',
    entityId: answer.id,
    metadata: {
      examId,
      attemptId: answer.attemptId,
      correctionId: c.id,
      before,
      after: input.marks,
      reason: input.reason,
    },
  });
  const attempt = await attemptRepo.findOne({ where: { id: answer.attemptId }, include: [studentInclude] });
  return buildResult(attempt!, exam, { revealKey: true });
}

// ---------------------------------------------------------------- student & parent views

async function publishedAttemptsOf(studentUserIds: number[]) {
  if (!studentUserIds.length) return [];
  return attemptRepo.findAll({
    where: { studentUserId: studentUserIds, status: { [Op.ne]: 'in_progress' } },
    include: [
      studentInclude,
      {
        model: Exam,
        as: 'exam',
        required: true,
        where: { resultsPublishedAt: { [Op.ne]: null }, status: 'scheduled' },
      },
    ],
    order: [['submittedAt', 'DESC']],
  });
}

async function listItems(
  studentUserIds: number[],
  names?: Map<number, string>,
): Promise<ChildResultListItem[]> {
  const attempts = await publishedAttemptsOf(studentUserIds);
  const items: ChildResultListItem[] = [];
  for (const a of attempts) {
    items.push({
      studentUserId: a.studentUserId,
      studentName: names?.get(a.studentUserId) ?? a.student?.name ?? '',
      attemptId: a.id,
      exam: examDto(await loadExamForDto(a.examId, examTenantRepo)),
      totalScore: a.totalScore,
      maxScore: a.maxScore,
      rank: a.rank,
      percentile: a.percentile,
    });
  }
  return items;
}

export async function myResults(): Promise<ChildResultListItem[]> {
  return listItems([me()]);
}

export async function childrenResults(): Promise<ChildResultListItem[]> {
  const kids = await getLinkedStudentUsers(me());
  return listItems(
    kids.map((k) => k.id),
    new Map(kids.map((k) => [k.id, k.name])),
  );
}

/** Loads a published attempt the caller may see as the student or as a linked guardian. */
async function viewerAttempt(
  attemptId: number,
  as: 'student' | 'parent',
): Promise<{ attempt: ExamAttempt; exam: Exam }> {
  const allowed = as === 'student' ? [me()] : (await getLinkedStudentUsers(me())).map((k) => k.id);
  const attempt = await attemptRepo.findOne({ where: { id: attemptId }, include: [studentInclude] });
  if (!attempt || !allowed.includes(attempt.studentUserId)) throw NotFound('Result');
  const exam = await loadExamForDto(attempt.examId, examTenantRepo);
  if (!exam.resultsPublishedAt || exam.status !== 'scheduled') throw NotFound('Result');
  return { attempt, exam };
}

export async function viewerResult(attemptId: number, as: 'student' | 'parent'): Promise<ResultDto> {
  const { attempt, exam } = await viewerAttempt(attemptId, as);
  return buildResult(attempt, exam, { revealKey: true });
}

// ---------------------------------------------------------------- PDF scorecard

function fmt(n: number | null) {
  return n == null ? '-' : String(round2(n));
}

function renderScorecard(r: ResultDto): Buffer {
  const pdf = new SimplePdf();
  pdf.text('SCORECARD', { size: 18, bold: true, gap: 4 });
  pdf.text(r.exam.title, { size: 13, bold: true });
  pdf.text(
    [r.exam.courseName, r.exam.batchName, new Date(r.exam.startAt).toUTCString().slice(0, 16)]
      .filter(Boolean)
      .join('  |  '),
    { size: 10, gap: 6 },
  );
  pdf.rule();
  pdf.text(`Student: ${r.attempt.studentName ?? `#${r.attempt.studentUserId}`}`, { size: 11, bold: true });
  pdf.text(
    `Score: ${fmt(r.attempt.totalScore)} / ${fmt(r.attempt.maxScore)}    Rank: ${r.attempt.rank ?? '-'}    Percentile: ${fmt(r.attempt.percentile)}` +
      (r.passed == null ? '' : `    Result: ${r.passed ? 'PASS' : 'FAIL'}`),
    { size: 11 },
  );
  pdf.text(`Objective: ${fmt(r.attempt.objectiveScore)}    Descriptive: ${fmt(r.attempt.descriptiveScore)}`, {
    size: 10,
    gap: 4,
  });

  pdf.heading('Sections');
  pdf.table(
    ['Section', 'Score', 'Max'],
    r.sections.map((s) => [s.title, fmt(s.score), fmt(s.maxScore)]),
    [0.6, 0.2, 0.2],
  );
  if (r.chapters.length) {
    pdf.heading('Chapter / topic performance');
    pdf.table(
      ['Chapter', 'Topic', 'Score', 'Max', 'Accuracy'],
      r.chapters.map((c) => [
        c.chapterName ?? 'Uncategorised',
        c.topicName ?? '',
        fmt(c.score),
        fmt(c.maxScore),
        `${c.accuracy}%`,
      ]),
      [0.32, 0.32, 0.12, 0.12, 0.12],
    );
  }
  pdf.heading('Questions');
  pdf.table(
    ['#', 'Question', 'Type', 'Marks', 'Max'],
    r.questions.map((q, i) => [
      String(i + 1),
      q.text.replace(/\s+/g, ' '),
      q.type,
      fmt(q.marks),
      fmt(q.maxMarks),
    ]),
    [0.06, 0.6, 0.14, 0.1, 0.1],
  );
  if (r.corrections.length) {
    pdf.heading('Result corrections');
    for (const c of r.corrections)
      pdf.text(`${c.createdAt.slice(0, 10)}: ${fmt(c.beforeMarks)} -> ${fmt(c.afterMarks)} (${c.reason})`, {
        size: 9,
      });
  }
  pdf.text(`Generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`, { size: 8, gap: 0 });
  return pdf.toBuffer();
}

export async function staffScorecard(examId: number, attemptId: number) {
  const r = await staffResult(examId, attemptId);
  return { filename: `scorecard-${attemptId}.pdf`, pdf: renderScorecard(r) };
}

export async function viewerScorecard(attemptId: number, as: 'student' | 'parent') {
  const r = await viewerResult(attemptId, as);
  return { filename: `scorecard-${attemptId}.pdf`, pdf: renderScorecard(r) };
}
