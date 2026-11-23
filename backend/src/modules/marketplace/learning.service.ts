import {
  MKT_COMPLETE_AT_PERCENT,
  type MktEnrolmentDto,
  type MktLectureContentDto,
  type MktPlayerDto,
  type MktProgressDto,
  type MktProgressInput,
} from '@erp/shared';
import { getContext } from '../../shared/context';
import { BadRequest, NotFound } from '../../shared/errors';
import { MktCourse, MktEnrolment, MktLecture, MktLectureProgress, MktMedia } from './models';
import { downloadUrl, streamFor } from './media.service';
import { cardInclude, curriculum, toCard } from './courses.service';
import { certificateCodes, issueCertificate } from './certificates.service';
import { iso } from './util';

const me = () => getContext().userId!;

export async function myLearning(): Promise<MktEnrolmentDto[]> {
  const rows = await MktEnrolment.findAll({
    where: { userId: me() },
    include: [{ model: MktCourse, as: 'course', include: cardInclude }],
    order: [
      ['lastAccessedAt', 'DESC'],
      ['id', 'DESC'],
    ],
  });
  const codes = await certificateCodes(
    me(),
    rows.map((e) => e.courseId),
  );
  return rows.map((e) => ({
    course: toCard(e.course!),
    progressPercent: e.progressPercent,
    completedLectures: e.completedLectures,
    lastLectureId: e.lastLectureId,
    lastAccessedAt: iso(e.lastAccessedAt),
    completedAt: iso(e.completedAt),
    enrolledAt: iso(e.createdAt)!,
    certificateCode: codes.get(e.courseId) ?? null,
  }));
}

/** Enrolled learners keep access even after the course is unpublished. */
async function myEnrolment(courseId: number) {
  const e = await MktEnrolment.findOne({ where: { userId: me(), courseId } });
  if (!e) throw NotFound('Course');
  return e;
}

export async function player(courseId: number): Promise<MktPlayerDto> {
  const e = await myEnrolment(courseId);
  const course = (await MktCourse.findByPk(courseId, { include: cardInclude }))!;
  const [outline, progress, codes] = await Promise.all([
    curriculum(courseId),
    MktLectureProgress.findAll({ where: { userId: me(), courseId } }),
    certificateCodes(me(), [courseId]),
  ]);
  return {
    course: toCard(course),
    sections: outline.map(({ section, lectures }) => ({
      id: section.id,
      title: section.title,
      lectures: lectures.map((l) => {
        const p = progress.find((x) => x.lectureId === l.id);
        return {
          id: l.id,
          title: l.title,
          type: l.type,
          durationSeconds: l.durationSeconds,
          preview: l.preview,
          completed: !!p?.completedAt,
          positionSeconds: p?.positionSeconds ?? 0,
        };
      }),
    })),
    progressPercent: e.progressPercent,
    lastLectureId: e.lastLectureId,
    certificateCode: codes.get(courseId) ?? null,
  };
}

/** Content of one lecture with signed media links bound to `userId`. */
export function lectureContent(
  l: MktLecture,
  userId: number,
  p?: MktLectureProgress | null,
): MktLectureContentDto {
  const media = l.media ?? null;
  return {
    id: l.id,
    title: l.title,
    type: l.type,
    description: l.description,
    articleBody: l.type === 'article' ? l.articleBody : null,
    stream: l.type === 'video' && media ? streamFor(media, userId) : null,
    download:
      l.type === 'resource' && media && media.status === 'ready'
        ? { url: downloadUrl(media, userId), name: media.originalName, sizeBytes: media.sizeBytes }
        : null,
    positionSeconds: p?.positionSeconds ?? 0,
    completed: !!p?.completedAt,
  };
}

export async function lecture(courseId: number, lectureId: number): Promise<MktLectureContentDto> {
  const e = await myEnrolment(courseId);
  const l = await MktLecture.findOne({
    where: { id: lectureId, courseId },
    include: [{ model: MktMedia, as: 'media' }],
  });
  if (!l) throw NotFound('Lecture');
  const p = await MktLectureProgress.findOne({ where: { userId: me(), lectureId } });
  await e.update({ lastLectureId: l.id, lastAccessedAt: new Date() });
  return lectureContent(l, me(), p);
}

/** Saves the resume position and/or completion, then recomputes the course progress. */
export async function saveProgress(
  courseId: number,
  lectureId: number,
  input: MktProgressInput,
): Promise<MktProgressDto> {
  const userId = me();
  const e = await myEnrolment(courseId);
  const l = await MktLecture.findOne({ where: { id: lectureId, courseId } });
  if (!l) throw NotFound('Lecture');
  if (l.type === 'quiz' && input.completed !== undefined)
    throw BadRequest('A quiz is completed by passing it', { code: 'QUIZ_COMPLETION' });
  const [p] = await MktLectureProgress.findOrCreate({
    where: { userId, lectureId },
    defaults: { userId, courseId, lectureId },
  });
  const position =
    input.positionSeconds !== undefined ? Math.max(0, Math.floor(input.positionSeconds)) : p.positionSeconds;
  const watchedEnough =
    l.type === 'video' &&
    l.durationSeconds > 0 &&
    position >= (l.durationSeconds * MKT_COMPLETE_AT_PERCENT) / 100;
  let completedAt = p.completedAt;
  if (input.completed === true || (watchedEnough && !completedAt)) completedAt = completedAt ?? new Date();
  if (input.completed === false) completedAt = null;
  await p.update({ positionSeconds: position, completedAt });
  const course = await recomputeProgress(e, lectureId);
  return { lectureId, completed: !!completedAt, positionSeconds: position, ...course };
}

/**
 * Recomputes the enrolment's progress (optionally completing `lectureId` first, e.g. a passed quiz).
 * Reaching 100% sets `completed_at` and issues the completion certificate.
 */
export async function recomputeProgress(
  e: MktEnrolment,
  lectureId: number,
  mark: { completed?: true } = {},
): Promise<{ progressPercent: number; certificateCode: string | null }> {
  const { userId, courseId } = e;
  if (mark.completed) {
    const [p] = await MktLectureProgress.findOrCreate({
      where: { userId, lectureId },
      defaults: { userId, courseId, lectureId },
    });
    if (!p.completedAt) await p.update({ completedAt: new Date() });
  }
  const [lectureIds, rows] = await Promise.all([
    MktLecture.findAll({ where: { courseId }, attributes: ['id'] }),
    MktLectureProgress.findAll({ where: { userId, courseId }, attributes: ['lectureId', 'completedAt'] }),
  ]);
  const ids = new Set(lectureIds.map((x) => x.id));
  const total = ids.size;
  const done = rows.filter((r) => r.completedAt && ids.has(r.lectureId)).length;
  const finished = total > 0 && done >= total;
  // Rounding must not show 100% (or issue a certificate) before every lecture is done.
  const percent = finished ? 100 : total ? Math.min(99, Math.round((done / total) * 100)) : 0;
  await e.update({
    progressPercent: percent,
    completedLectures: done,
    lastLectureId: lectureId,
    lastAccessedAt: new Date(),
    completedAt: finished ? (e.completedAt ?? new Date()) : null,
  });
  const certificate = finished ? await issueCertificate(e) : null;
  return { progressPercent: percent, certificateCode: certificate?.code ?? null };
}
