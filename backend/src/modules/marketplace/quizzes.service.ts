import crypto from 'node:crypto';
import {
  MKT_QUIZ_DEFAULT_PASS_PERCENT,
  mktQuizIsCorrect,
  type MktQuizAttemptInput,
  type MktQuizAttemptSummaryDto,
  type MktQuizDto,
  type MktQuizInput,
  type MktQuizLearnerDto,
  type MktQuizQuestionDto,
  type MktQuizQuestionInput,
  type MktQuizResultDto,
} from '@erp/shared';
import { getSequelize } from '../../infrastructure/database/sequelize';
import { getContext } from '../../shared/context';
import { BadRequest, Conflict, NotFound } from '../../shared/errors';
import { loadReusableQuestions } from '../question-bank/api';
import { MktEnrolment, MktLecture } from './models';
import { MktQuiz, MktQuizAttempt, MktQuizQuestion } from './quiz-models';
import { ownCourse, ownLecture, touched } from './courses.service';
import { recomputeProgress } from './learning.service';
import { iso } from './util';

const me = () => getContext().userId!;

function toQuestionDto(q: MktQuizQuestion): MktQuizQuestionDto {
  return {
    id: q.id,
    kind: q.kind,
    prompt: q.prompt,
    options: q.options,
    correct: q.correct,
    explanation: q.explanation,
  };
}

const toAttemptSummary = (a: MktQuizAttempt): MktQuizAttemptSummaryDto => ({
  id: a.id,
  score: a.score,
  total: a.total,
  percent: a.percent,
  passed: a.passed,
  createdAt: iso(a.createdAt)!,
});

async function questionsOf(lectureId: number) {
  return MktQuizQuestion.findAll({
    where: { lectureId },
    order: [
      ['sortOrder', 'ASC'],
      ['id', 'ASC'],
    ],
  });
}

async function settingsOf(lectureId: number) {
  return (
    (await MktQuiz.findOne({ where: { lectureId } })) ??
    MktQuiz.build({
      lectureId,
      passPercent: MKT_QUIZ_DEFAULT_PASS_PERCENT,
      maxAttempts: null,
      shuffle: false,
    })
  );
}

/** The quiz with its answer key (seller studio, platform review). */
export async function quizFor(lectureId: number): Promise<MktQuizDto> {
  const [s, questions] = await Promise.all([settingsOf(lectureId), questionsOf(lectureId)]);
  return {
    lectureId,
    passPercent: s.passPercent,
    maxAttempts: s.maxAttempts,
    shuffle: s.shuffle,
    questions: questions.map(toQuestionDto),
  };
}

/** Number of questions per quiz lecture of a course (readiness checks). */
export async function questionCounts(courseId: number): Promise<Map<number, number>> {
  const lectures = await MktLecture.findAll({ where: { courseId, type: 'quiz' }, attributes: ['id'] });
  const rows = lectures.length
    ? await MktQuizQuestion.findAll({
        where: { lectureId: lectures.map((l) => l.id) },
        attributes: ['lectureId'],
      })
    : [];
  const counts = new Map(lectures.map((l) => [l.id, 0]));
  for (const r of rows) counts.set(r.lectureId, (counts.get(r.lectureId) ?? 0) + 1);
  return counts;
}

/** Trims a question and checks its option keys and answer key. */
export function cleanQuestion(q: MktQuizQuestionInput): MktQuizQuestionInput {
  const options = q.options.map((o) => ({ key: o.key.trim().toUpperCase(), text: o.text.trim() }));
  const keys = new Set(options.map((o) => o.key));
  if (options.length < 2) throw BadRequest('Every question needs at least two options');
  if (keys.size !== options.length || options.some((o) => !o.key || !o.text))
    throw BadRequest('Every option needs a unique key and some text');
  const correct = [...new Set(q.correct.map((k) => k.trim().toUpperCase()))];
  if (!correct.length || !correct.every((k) => keys.has(k)))
    throw BadRequest(`Choose the correct answer for "${q.prompt.slice(0, 60)}"`);
  if (q.kind === 'single' && correct.length !== 1)
    throw BadRequest('A single-answer question has exactly one correct option');
  return {
    kind: q.kind,
    prompt: q.prompt.trim(),
    options,
    correct: correct.sort(),
    explanation: q.explanation?.trim() || null,
  };
}

async function quizLecture(sellerId: number, courseId: number, lectureId: number) {
  const l = await ownLecture(sellerId, courseId, lectureId);
  if (l.type !== 'quiz') throw BadRequest('This lecture is not a quiz');
  return l;
}

export async function getOwnQuiz(sellerId: number, courseId: number, lectureId: number) {
  await quizLecture(sellerId, courseId, lectureId);
  return quizFor(lectureId);
}

export async function saveQuiz(
  sellerId: number,
  courseId: number,
  lectureId: number,
  input: MktQuizInput,
): Promise<MktQuizDto> {
  await quizLecture(sellerId, courseId, lectureId);
  const questions = input.questions.map(cleanQuestion);
  await getSequelize().transaction(async (transaction) => {
    const [s] = await MktQuiz.findOrCreate({
      where: { lectureId },
      defaults: { lectureId, passPercent: input.passPercent, maxAttempts: null },
      transaction,
    });
    await s.update(
      { passPercent: input.passPercent, maxAttempts: input.maxAttempts ?? null, shuffle: !!input.shuffle },
      { transaction },
    );
    await MktQuizQuestion.destroy({ where: { lectureId }, transaction });
    await MktQuizQuestion.bulkCreate(
      questions.map((q, i) => ({
        lectureId,
        kind: q.kind,
        prompt: q.prompt,
        options: q.options,
        correct: q.correct,
        explanation: q.explanation ?? null,
        sortOrder: i,
      })),
      { transaction },
    );
  });
  await touched(await ownCourse(sellerId, courseId));
  return quizFor(lectureId);
}

/** Platform review: the quiz of a lecture with its answer key. */
export async function reviewQuiz(courseId: number, lectureId: number): Promise<MktQuizDto> {
  const l = await MktLecture.findOne({ where: { id: lectureId, courseId } });
  if (!l || l.type !== 'quiz') throw NotFound('Quiz');
  return quizFor(lectureId);
}

const LETTERS = 'ABCDEFGH';

/**
 * Appends copies of question-bank questions (single/multiple-correct and true/false) to the quiz.
 * Only questions in banks the user can see are accepted (institute scope).
 */
export async function importFromBank(
  sellerId: number,
  courseId: number,
  lectureId: number,
  questionIds: number[],
): Promise<MktQuizDto> {
  await quizLecture(sellerId, courseId, lectureId);
  const rows = await loadReusableQuestions([...new Set(questionIds)]);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const converted = questionIds
    .filter((id, i) => questionIds.indexOf(id) === i)
    .map((id) => byId.get(id)!)
    .map((q): MktQuizQuestionInput => {
      if (q.type === 'true_false')
        return {
          kind: 'single',
          prompt: q.text,
          options: [
            { key: 'A', text: 'True' },
            { key: 'B', text: 'False' },
          ],
          correct: [q.answerKey.value === true ? 'A' : 'B'],
          explanation: q.explanation,
        };
      if (q.type !== 'single' && q.type !== 'multiple')
        throw BadRequest('Only multiple-choice and true/false questions can be added to a quiz');
      const options = (q.options ?? []).slice(0, LETTERS.length);
      const keyMap = new Map(options.map((o, i) => [o.key.toUpperCase(), LETTERS[i]]));
      return {
        kind: q.type === 'single' ? 'single' : 'multi',
        prompt: q.text,
        options: options.map((o, i) => ({ key: LETTERS[i], text: o.text || `Option ${LETTERS[i]}` })),
        correct: (q.answerKey.options ?? [])
          .map((k) => keyMap.get(k.toUpperCase()))
          .filter((k): k is string => !!k),
        explanation: q.explanation,
      };
    })
    .map(cleanQuestion);
  const existing = await quizFor(lectureId);
  return saveQuiz(sellerId, courseId, lectureId, {
    passPercent: existing.passPercent,
    maxAttempts: existing.maxAttempts,
    shuffle: existing.shuffle,
    questions: [...existing.questions, ...converted],
  });
}

// ---------------------------------------------------------------- learner

async function enrolledQuiz(courseId: number, lectureId: number) {
  const e = await MktEnrolment.findOne({ where: { userId: me(), courseId } });
  if (!e) throw NotFound('Course');
  const l = await MktLecture.findOne({ where: { id: lectureId, courseId } });
  if (!l || l.type !== 'quiz') throw NotFound('Quiz');
  return { e, l };
}

/** Stable per-learner shuffle so a reload shows the same order. */
function shuffled<T>(items: T[], seed: string): T[] {
  const rank = (i: number) => crypto.createHash('sha1').update(`${seed}:${i}`).digest().readUInt32BE(0);
  return items
    .map((item, i) => ({ item, r: rank(i) }))
    .sort((a, b) => a.r - b.r)
    .map((x) => x.item);
}

export async function learnerQuiz(courseId: number, lectureId: number): Promise<MktQuizLearnerDto> {
  await enrolledQuiz(courseId, lectureId);
  const userId = me();
  const [s, questions, attempts] = await Promise.all([
    settingsOf(lectureId),
    questionsOf(lectureId),
    MktQuizAttempt.findAll({ where: { userId, lectureId }, order: [['id', 'DESC']] }),
  ]);
  const passed = attempts.some((a) => a.passed);
  const ordered = s.shuffle ? shuffled(questions, `${userId}:${lectureId}:${attempts.length}`) : questions;
  return {
    lectureId,
    passPercent: s.passPercent,
    maxAttempts: s.maxAttempts,
    attemptsUsed: attempts.length,
    canAttempt: s.maxAttempts === null || attempts.length < s.maxAttempts,
    passed,
    bestPercent: attempts.length ? Math.max(...attempts.map((a) => a.percent)) : null,
    questions: ordered.map((q) => ({ id: q.id, kind: q.kind, prompt: q.prompt, options: q.options })),
    attempts: attempts.map(toAttemptSummary),
  };
}

function result(
  a: MktQuizAttempt,
  passPercent: number,
  questions: MktQuizQuestion[],
  progressPercent: number,
  certificateCode: string | null,
): MktQuizResultDto {
  return {
    ...toAttemptSummary(a),
    passPercent,
    progressPercent,
    certificateCode,
    questions: questions.map((q) => {
      const chosen = a.answers[String(q.id)] ?? [];
      return { ...toQuestionDto(q), chosen, isCorrect: mktQuizIsCorrect(q.correct, chosen) };
    }),
  };
}

/** Grades an attempt. A passing attempt completes the lecture and recomputes the course progress. */
export async function submitAttempt(
  courseId: number,
  lectureId: number,
  input: MktQuizAttemptInput,
): Promise<MktQuizResultDto> {
  const { e } = await enrolledQuiz(courseId, lectureId);
  const userId = me();
  const [s, questions] = await Promise.all([settingsOf(lectureId), questionsOf(lectureId)]);
  if (!questions.length) throw Conflict('This quiz has no questions yet', 'QUIZ_EMPTY');
  const used = await MktQuizAttempt.count({ where: { userId, lectureId } });
  if (s.maxAttempts !== null && used >= s.maxAttempts)
    throw Conflict('No attempts left for this quiz', 'QUIZ_NO_ATTEMPTS');

  const answers: Record<string, string[]> = {};
  let score = 0;
  for (const q of questions) {
    const keys = new Set(q.options.map((o) => o.key));
    const chosen = [...new Set(input.answers[String(q.id)] ?? [])].filter((k) => keys.has(k)).sort();
    answers[String(q.id)] = chosen;
    if (mktQuizIsCorrect(q.correct, chosen)) score++;
  }
  const percent = Math.round((score / questions.length) * 100);
  const passed = percent >= s.passPercent;
  const attempt = await MktQuizAttempt.create({
    userId,
    courseId,
    lectureId,
    answers,
    score,
    total: questions.length,
    percent,
    passed,
  });
  const progress = await recomputeProgress(e, lectureId, passed ? { completed: true } : {});
  return result(attempt, s.passPercent, questions, progress.progressPercent, progress.certificateCode);
}

export async function attemptResult(
  courseId: number,
  lectureId: number,
  attemptId: number,
): Promise<MktQuizResultDto> {
  const { e } = await enrolledQuiz(courseId, lectureId);
  const a = await MktQuizAttempt.findOne({ where: { id: attemptId, userId: me(), lectureId } });
  if (!a) throw NotFound('Attempt');
  const [s, questions] = await Promise.all([settingsOf(lectureId), questionsOf(lectureId)]);
  return result(a, s.passPercent, questions, e.progressPercent, null);
}
