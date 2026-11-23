import { Op, type WhereOptions } from 'sequelize';
import type {
  MktAnswerDto,
  MktPage,
  MktQuestionDto,
  MktQuestionInput,
  MktQuestionQuery,
  MktStudioQuestionDto,
} from '@erp/shared';
import { getSequelize } from '../../infrastructure/database/sequelize';
import { getContext } from '../../shared/context';
import { Forbidden, NotFound } from '../../shared/errors';
import { User } from '../users/user.model';
import { MktAnswer, MktQuestion } from './engagement.models';
import {
  QUESTION_ANSWERED_EVENT,
  QUESTION_ASKED_EVENT,
  notifyMarketplaceUsers,
} from './engagement.notifications';
import { courseRef, isEnrolled, publicName } from './engagement.util';
import { MktCourse, MktLecture, MktSeller } from './models';
import { managesSeller } from './sellers.service';
import { iso } from './util';

const me = () => getContext().userId!;
const withUser = () => ({ model: User, as: 'user', attributes: ['id', 'name'] });
const withLecture = () => ({ model: MktLecture, as: 'lecture', attributes: ['id', 'title'] });
const escapeLike = (s: string) => s.replace(/[%_\\]/g, '\\$&');

function answerDto(a: MktAnswer): MktAnswerDto {
  return {
    id: a.id,
    body: a.body,
    authorName: a.isInstructor ? (a.user?.name ?? 'Instructor') : publicName(a.user?.name),
    isInstructor: a.isInstructor,
    mine: a.userId === getContext().userId,
    createdAt: iso(a.createdAt)!,
  };
}

function questionDto(q: MktQuestion, withAnswers = false): MktQuestionDto {
  return {
    id: q.id,
    courseId: q.courseId,
    lectureId: q.lectureId,
    lectureTitle: q.lecture?.title ?? null,
    title: q.title,
    body: q.body,
    authorName: publicName(q.user?.name),
    mine: q.userId === getContext().userId,
    answered: q.answered,
    answerCount: q.answerCount,
    createdAt: iso(q.createdAt)!,
    ...(withAnswers ? { answers: (q.answers ?? []).map(answerDto) } : {}),
  };
}

/** Q&A is open to the course's enrolled learners and to whoever manages its seller. */
async function access(courseId: number) {
  const course = await MktCourse.findByPk(courseId, {
    include: [{ model: MktSeller, as: 'seller' }],
  });
  if (!course) throw NotFound('Course');
  const isSeller = await managesSeller(course.sellerId);
  if (!isSeller && !(await isEnrolled(me(), courseId)))
    throw Forbidden('Enrol in this course to see and ask questions', 'NOT_ENROLLED');
  return { course, isSeller };
}

async function questionPage(
  where: WhereOptions,
  q: MktQuestionQuery,
  withAnswers = false,
): Promise<MktPage<MktQuestion>> {
  const page = q.page ?? 1;
  const pageSize = q.pageSize ?? 20;
  const { rows, count } = await MktQuestion.findAndCountAll({
    where,
    include: [
      withUser(),
      withLecture(),
      ...(withAnswers ? [{ model: MktAnswer, as: 'answers', include: [withUser()] }] : []),
    ],
    order: [
      ['createdAt', 'DESC'],
      ['id', 'DESC'],
      ...(withAnswers ? ([[{ model: MktAnswer, as: 'answers' }, 'createdAt', 'ASC']] as never[]) : []),
    ],
    limit: pageSize,
    offset: (page - 1) * pageSize,
    distinct: true,
  });
  return { items: rows, total: count, page, pageSize };
}

function filters(q: MktQuestionQuery): Record<string | symbol, unknown> {
  const where: Record<string | symbol, unknown> = {};
  if (q.lectureId) where.lectureId = q.lectureId;
  if (q.filter === 'unanswered') where.answered = false;
  if (q.filter === 'mine') where.userId = me();
  if (q.q) {
    const like = `%${escapeLike(q.q)}%`;
    where[Op.or] = [{ title: { [Op.like]: like } }, { body: { [Op.like]: like } }];
  }
  return where;
}

export async function listQuestions(courseId: number, q: MktQuestionQuery): Promise<MktPage<MktQuestionDto>> {
  await access(courseId);
  const p = await questionPage({ courseId, ...filters(q) }, q);
  return { ...p, items: p.items.map((x) => questionDto(x)) };
}

async function loadQuestion(courseId: number, id: number) {
  const q = await MktQuestion.findOne({
    where: { id, courseId },
    include: [withUser(), withLecture(), { model: MktAnswer, as: 'answers', include: [withUser()] }],
    order: [[{ model: MktAnswer, as: 'answers' }, 'createdAt', 'ASC']],
  });
  if (!q) throw NotFound('Question');
  return q;
}

export async function getQuestion(courseId: number, id: number): Promise<MktQuestionDto> {
  await access(courseId);
  return questionDto(await loadQuestion(courseId, id), true);
}

/** Who hears about a new question: the instructor, or for an institute the course's author. */
function sellerRecipients(course: MktCourse) {
  const s = course.seller!;
  if (s.type === 'instructor') return { userIds: s.userId ? [s.userId] : [], instituteId: null };
  return {
    userIds: course.createdByUserId ? [course.createdByUserId] : [],
    instituteId: s.ownerInstituteId,
  };
}

export async function askQuestion(courseId: number, input: MktQuestionInput): Promise<MktQuestionDto> {
  const { course, isSeller } = await access(courseId);
  if (isSeller && !(await isEnrolled(me(), courseId)))
    throw Forbidden('Instructors answer questions; learners ask them', 'NOT_ENROLLED');
  if (input.lectureId) {
    const l = await MktLecture.count({ where: { id: input.lectureId, courseId } });
    if (!l) throw NotFound('Lecture');
  }
  const q = await MktQuestion.create({
    courseId,
    lectureId: input.lectureId ?? null,
    userId: me(),
    title: input.title.trim(),
    body: input.body?.trim() || null,
  });
  const asker = await User.findByPk(me(), { attributes: ['name'] });
  const to = sellerRecipients(course);
  await notifyMarketplaceUsers({
    event: QUESTION_ASKED_EVENT,
    userIds: to.userIds.filter((id) => id !== me()),
    preferInstituteId: to.instituteId,
    data: {
      course: course.title,
      title: q.title,
      learner: publicName(asker?.name),
      courseId,
      questionId: q.id,
      link: `/market/studio/${course.seller!.type}/engagement?tab=qa&questionId=${q.id}`,
    },
  });
  return questionDto(await loadQuestion(courseId, q.id), true);
}

async function addAnswer(course: MktCourse, questionId: number, body: string, isInstructor: boolean) {
  const q = await MktQuestion.findOne({ where: { id: questionId, courseId: course.id } });
  if (!q) throw NotFound('Question');
  await getSequelize().transaction(async (transaction) => {
    await MktAnswer.create({ questionId, userId: me(), body: body.trim(), isInstructor }, { transaction });
    await MktQuestion.increment('answerCount', { where: { id: questionId }, transaction });
  });
  if (q.userId !== me()) {
    const author = await User.findByPk(me(), { attributes: ['name'] });
    await notifyMarketplaceUsers({
      event: QUESTION_ANSWERED_EVENT,
      userIds: [q.userId],
      data: {
        course: course.title,
        title: q.title,
        author: isInstructor ? (course.seller?.displayName ?? 'The instructor') : publicName(author?.name),
        courseId: course.id,
        questionId,
        link: `/market/learn/${course.id}?tab=qa&questionId=${questionId}`,
      },
    });
  }
  return questionDto(await loadQuestion(course.id, questionId), true);
}

export async function answerQuestion(courseId: number, questionId: number, body: string) {
  const { course, isSeller } = await access(courseId);
  return addAnswer(course, questionId, body, isSeller);
}

/** The asker or the seller marks a question answered (or reopens it). */
export async function setAnswered(courseId: number, id: number, answered: boolean) {
  const { isSeller } = await access(courseId);
  const q = await MktQuestion.findOne({ where: { id, courseId } });
  if (!q) throw NotFound('Question');
  if (!isSeller && q.userId !== me()) throw Forbidden('Only the asker or the instructor can do this');
  await q.update({ answered });
  return questionDto(await loadQuestion(courseId, id), true);
}

export async function deleteQuestion(courseId: number, id: number) {
  const { isSeller } = await access(courseId);
  const q = await MktQuestion.findOne({ where: { id, courseId } });
  if (!q) throw NotFound('Question');
  if (!isSeller && q.userId !== me()) throw Forbidden('Only the asker or the instructor can delete it');
  await getSequelize().transaction(async (transaction) => {
    await MktAnswer.destroy({ where: { questionId: id }, transaction });
    await q.destroy({ transaction });
  });
}

export async function deleteAnswer(courseId: number, questionId: number, id: number) {
  const { isSeller } = await access(courseId);
  const a = await MktAnswer.findOne({ where: { id, questionId } });
  const q = a ? await MktQuestion.findOne({ where: { id: questionId, courseId } }) : null;
  if (!a || !q) throw NotFound('Answer');
  if (!isSeller && a.userId !== me()) throw Forbidden('You can delete only your own answers');
  await getSequelize().transaction(async (transaction) => {
    await a.destroy({ transaction });
    await MktQuestion.decrement('answerCount', {
      where: { id: questionId, answerCount: { [Op.gt]: 0 } },
      transaction,
    });
  });
}

// ---------------------------------------------------------------- studio inbox

export async function sellerQuestions(
  sellerId: number,
  q: MktQuestionQuery & { courseId?: number },
): Promise<MktPage<MktStudioQuestionDto>> {
  const courses = await MktCourse.findAll({ where: { sellerId }, attributes: ['id', 'slug', 'title'] });
  const ids = courses.map((c) => c.id).filter((id) => !q.courseId || id === q.courseId);
  const p = await questionPage(
    { courseId: ids, ...filters({ ...q, filter: q.filter === 'mine' ? 'all' : q.filter }) },
    q,
    true,
  );
  return {
    ...p,
    items: p.items.map((x) => ({
      ...questionDto(x, true),
      course: courseRef(courses.find((c) => c.id === x.courseId)!),
    })),
  };
}

async function sellerCourse(sellerId: number, questionId: number) {
  const q = await MktQuestion.findByPk(questionId, { attributes: ['id', 'courseId'] });
  const course = q
    ? await MktCourse.findOne({
        where: { id: q.courseId, sellerId },
        include: [{ model: MktSeller, as: 'seller' }],
      })
    : null;
  if (!course) throw NotFound('Question');
  return course;
}

export async function sellerAnswer(
  sellerId: number,
  questionId: number,
  body: string,
): Promise<MktStudioQuestionDto> {
  const course = await sellerCourse(sellerId, questionId);
  return { ...(await addAnswer(course, questionId, body, true)), course: courseRef(course) };
}

export async function sellerSetAnswered(
  sellerId: number,
  questionId: number,
  answered: boolean,
): Promise<MktStudioQuestionDto> {
  const course = await sellerCourse(sellerId, questionId);
  await MktQuestion.update({ answered }, { where: { id: questionId } });
  return { ...questionDto(await loadQuestion(course.id, questionId), true), course: courseRef(course) };
}
