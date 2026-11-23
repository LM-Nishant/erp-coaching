import type { Transaction } from 'sequelize';
import {
  MKT_LANGUAGES,
  type MktCourseCardDto,
  type MktCourseInput,
  type MktLectureDto,
  type MktLectureInput,
  type MktReadinessDto,
  type MktSectionDto,
  type MktSectionInput,
  type MktStudioCourseDto,
} from '@erp/shared';
import { getSequelize } from '../../infrastructure/database/sequelize';
import { getContext } from '../../shared/context';
import { BadRequest, Conflict, NotFound } from '../../shared/errors';
import { audit } from '../../shared/audit/audit.service';
import { MktCategory, MktCourse, MktLecture, MktMedia, MktSection, MktSeller } from './models';
import { imageUrl, toMediaDto } from './media.service';
import { sellerRef } from './sellers.service';
import { cleanList, iso, uniqueSlug } from './util';

export const cardInclude = [
  { model: MktSeller, as: 'seller', include: [{ model: MktMedia, as: 'avatar' }] },
  { model: MktMedia, as: 'thumbnail' },
];

export function toCard(c: MktCourse): MktCourseCardDto {
  return {
    id: c.id,
    slug: c.slug,
    title: c.title,
    subtitle: c.subtitle,
    thumbnailUrl: c.thumbnail ? imageUrl(c.thumbnail) : null,
    seller: sellerRef(c.seller!),
    pricePaise: c.pricePaise,
    isFree: c.pricePaise === 0,
    level: c.level,
    language: c.language,
    categoryId: c.categoryId,
    ratingAvg: c.ratingAvg,
    ratingCount: c.ratingCount,
    enrolmentCount: c.enrolmentCount,
    lectureCount: c.lectureCount,
    durationSeconds: c.durationSeconds,
    publishedAt: iso(c.publishedAt),
    updatedAt: iso(c.updatedAt)!,
  };
}

function toLectureDto(l: MktLecture): MktLectureDto {
  return {
    id: l.id,
    sectionId: l.sectionId,
    title: l.title,
    type: l.type,
    durationSeconds: l.durationSeconds,
    preview: l.preview,
    sortOrder: l.sortOrder,
    description: l.description,
    articleBody: l.articleBody,
    media: l.media ? toMediaDto(l.media) : null,
  };
}

export async function curriculum(courseId: number) {
  const [sections, lectures] = await Promise.all([
    MktSection.findAll({
      where: { courseId },
      order: [
        ['sortOrder', 'ASC'],
        ['id', 'ASC'],
      ],
    }),
    MktLecture.findAll({
      where: { courseId },
      include: [{ model: MktMedia, as: 'media' }],
      order: [
        ['sortOrder', 'ASC'],
        ['id', 'ASC'],
      ],
    }),
  ]);
  return sections.map((s) => ({ section: s, lectures: lectures.filter((l) => l.sectionId === s.id) }));
}

export async function toStudioDto(c: MktCourse): Promise<MktStudioCourseDto> {
  const [thumb, promo, outline] = await Promise.all([
    c.thumbnailMediaId ? MktMedia.findByPk(c.thumbnailMediaId) : null,
    c.promoMediaId ? MktMedia.findByPk(c.promoMediaId) : null,
    curriculum(c.id),
  ]);
  const sections: MktSectionDto[] = outline.map(({ section, lectures }) => ({
    id: section.id,
    title: section.title,
    sortOrder: section.sortOrder,
    lectures: lectures.map(toLectureDto),
  }));
  return {
    id: c.id,
    sellerId: c.sellerId,
    slug: c.slug,
    title: c.title,
    subtitle: c.subtitle,
    description: c.description,
    categoryId: c.categoryId,
    subcategoryId: c.subcategoryId,
    level: c.level,
    language: c.language,
    pricePaise: c.pricePaise,
    outcomes: c.outcomes ?? [],
    requirements: c.requirements ?? [],
    audience: c.audience ?? [],
    thumbnail: thumb ? toMediaDto(thumb) : null,
    promo: promo ? toMediaDto(promo) : null,
    status: c.status,
    reviewNote: c.reviewNote,
    submittedAt: iso(c.submittedAt),
    publishedAt: iso(c.publishedAt),
    enrolmentCount: c.enrolmentCount,
    lectureCount: c.lectureCount,
    durationSeconds: c.durationSeconds,
    sections,
    updatedAt: iso(c.updatedAt)!,
    ...(c.seller && { seller: sellerRef(c.seller) }),
  };
}

// ---------------------------------------------------------------- seller-owned lookups

export async function ownCourse(sellerId: number, id: number, transaction?: Transaction): Promise<MktCourse> {
  const c = await MktCourse.findOne({ where: { id, sellerId }, transaction });
  if (!c) throw NotFound('Course');
  return c;
}

async function ownSection(sellerId: number, courseId: number, id: number) {
  await ownCourse(sellerId, courseId);
  const s = await MktSection.findOne({ where: { id, courseId } });
  if (!s) throw NotFound('Section');
  return s;
}

async function ownLecture(sellerId: number, courseId: number, id: number) {
  await ownCourse(sellerId, courseId);
  const l = await MktLecture.findOne({ where: { id, courseId } });
  if (!l) throw NotFound('Lecture');
  return l;
}

async function checkMedia(sellerId: number, id: number | null | undefined, kinds: string[]) {
  if (!id) return null;
  const m = await MktMedia.findOne({ where: { id, sellerId } });
  if (!m || !kinds.includes(m.kind)) throw NotFound('Media');
  return m;
}

async function checkCategories(categoryId?: number | null, subcategoryId?: number | null) {
  if (categoryId) {
    const c = await MktCategory.findByPk(categoryId);
    if (!c || c.parentId) throw BadRequest('Choose a top-level category');
  }
  if (subcategoryId) {
    const s = await MktCategory.findByPk(subcategoryId);
    if (!s || s.parentId !== categoryId) throw BadRequest('The subcategory does not belong to the category');
  }
}

/** Editing a course that was sent back moves it to draft again; edits to published courses stay live. */
async function touched(c: MktCourse) {
  if (c.status === 'rejected') await c.update({ status: 'draft' });
}

/** Lecture count and total length, kept on the course for cards and sorting. */
export async function recomputeTotals(courseId: number) {
  const lectures = await MktLecture.findAll({ where: { courseId }, attributes: ['durationSeconds'] });
  await MktCourse.update(
    {
      lectureCount: lectures.length,
      durationSeconds: lectures.reduce((a, l) => a + Number(l.durationSeconds || 0), 0),
    },
    { where: { id: courseId } },
  );
}

// ---------------------------------------------------------------- courses

export async function listOwnCourses(sellerId: number): Promise<MktStudioCourseDto[]> {
  const rows = await MktCourse.findAll({ where: { sellerId }, order: [['updatedAt', 'DESC']] });
  return Promise.all(rows.map(toStudioDto));
}

export async function getOwnCourse(sellerId: number, id: number) {
  return toStudioDto(await ownCourse(sellerId, id));
}

function courseFields(input: Partial<MktCourseInput>) {
  if (input.language && !(input.language in MKT_LANGUAGES)) throw BadRequest('Unknown language');
  return {
    ...(input.title !== undefined && { title: input.title }),
    ...(input.subtitle !== undefined && { subtitle: input.subtitle || null }),
    ...(input.description !== undefined && { description: input.description || null }),
    ...(input.categoryId !== undefined && { categoryId: input.categoryId }),
    ...(input.subcategoryId !== undefined && { subcategoryId: input.subcategoryId }),
    ...(input.level !== undefined && { level: input.level }),
    ...(input.language !== undefined && { language: input.language }),
    ...(input.pricePaise !== undefined && { pricePaise: input.pricePaise }),
    ...(input.outcomes !== undefined && { outcomes: cleanList(input.outcomes) }),
    ...(input.requirements !== undefined && { requirements: cleanList(input.requirements) }),
    ...(input.audience !== undefined && { audience: cleanList(input.audience) }),
  };
}

const courseSlugTaken = async (slug: string) => !!(await MktCourse.count({ where: { slug } }));

export async function createCourse(sellerId: number, input: MktCourseInput): Promise<MktStudioCourseDto> {
  await checkCategories(input.categoryId, input.subcategoryId);
  await checkMedia(sellerId, input.thumbnailMediaId, ['image']);
  await checkMedia(sellerId, input.promoMediaId, ['video']);
  const c = await MktCourse.create({
    sellerId,
    slug: await uniqueSlug(input.title, courseSlugTaken),
    title: input.title,
    subtitle: null,
    description: null,
    categoryId: null,
    subcategoryId: null,
    outcomes: [],
    requirements: [],
    audience: [],
    thumbnailMediaId: input.thumbnailMediaId ?? null,
    promoMediaId: input.promoMediaId ?? null,
    createdByUserId: getContext().userId ?? null,
    ...courseFields(input),
  });
  await audit({
    action: 'marketplace.course.created',
    entityType: 'mkt_course',
    entityId: c.id,
    instituteId: getContext().instituteId ?? null,
  });
  return toStudioDto(c);
}

export async function updateCourse(sellerId: number, id: number, input: Partial<MktCourseInput>) {
  const c = await ownCourse(sellerId, id);
  const categoryId = input.categoryId !== undefined ? input.categoryId : c.categoryId;
  const subcategoryId = input.subcategoryId !== undefined ? input.subcategoryId : c.subcategoryId;
  await checkCategories(categoryId, subcategoryId);
  if (input.thumbnailMediaId !== undefined) await checkMedia(sellerId, input.thumbnailMediaId, ['image']);
  if (input.promoMediaId !== undefined) await checkMedia(sellerId, input.promoMediaId, ['video']);
  await c.update({
    ...courseFields(input),
    ...(input.thumbnailMediaId !== undefined && { thumbnailMediaId: input.thumbnailMediaId }),
    ...(input.promoMediaId !== undefined && { promoMediaId: input.promoMediaId }),
  });
  await touched(c);
  return toStudioDto(c);
}

export async function deleteCourse(sellerId: number, id: number) {
  const c = await ownCourse(sellerId, id);
  if (c.enrolmentCount > 0 || c.publishedAt)
    throw Conflict(
      'Courses that were published cannot be deleted; unpublish it instead',
      'COURSE_HAS_HISTORY',
    );
  await c.destroy();
  await audit({
    action: 'marketplace.course.deleted',
    entityType: 'mkt_course',
    entityId: id,
    instituteId: getContext().instituteId ?? null,
  });
}

// ---------------------------------------------------------------- curriculum

export async function addSection(sellerId: number, courseId: number, input: MktSectionInput) {
  const c = await ownCourse(sellerId, courseId);
  const max = Number((await MktSection.max('sortOrder', { where: { courseId } })) ?? -1);
  await MktSection.create({ courseId, title: input.title, sortOrder: max + 1 });
  await touched(c);
  return toStudioDto(c);
}

export async function updateSection(sellerId: number, courseId: number, id: number, input: MktSectionInput) {
  const s = await ownSection(sellerId, courseId, id);
  await s.update({ title: input.title });
  return getOwnCourse(sellerId, courseId);
}

export async function deleteSection(sellerId: number, courseId: number, id: number) {
  const s = await ownSection(sellerId, courseId, id);
  await s.destroy();
  await recomputeTotals(courseId);
  return getOwnCourse(sellerId, courseId);
}

async function lectureFields(sellerId: number, input: Partial<MktLectureInput>, type: string) {
  const kinds = type === 'video' ? ['video'] : type === 'resource' ? ['file', 'image', 'video'] : [];
  let media: MktMedia | null = null;
  if (input.mediaId !== undefined && input.mediaId !== null) {
    if (!kinds.length) throw BadRequest('Article lectures have no media');
    media = await checkMedia(sellerId, input.mediaId, kinds);
  }
  return {
    media,
    fields: {
      ...(input.title !== undefined && { title: input.title }),
      ...(input.description !== undefined && { description: input.description || null }),
      ...(input.articleBody !== undefined && { articleBody: input.articleBody || null }),
      ...(input.mediaId !== undefined && { mediaId: input.mediaId }),
      ...(input.preview !== undefined && { preview: input.preview }),
      ...(input.durationSeconds !== undefined && input.durationSeconds !== null
        ? { durationSeconds: input.durationSeconds }
        : media?.durationSeconds
          ? { durationSeconds: media.durationSeconds }
          : {}),
    },
  };
}

export async function addLecture(
  sellerId: number,
  courseId: number,
  sectionId: number,
  input: MktLectureInput,
) {
  const s = await ownSection(sellerId, courseId, sectionId);
  const { fields } = await lectureFields(sellerId, input, input.type);
  const max = Number((await MktLecture.max('sortOrder', { where: { sectionId: s.id } })) ?? -1);
  await MktLecture.create({
    courseId,
    sectionId: s.id,
    title: input.title,
    type: input.type,
    description: null,
    articleBody: null,
    mediaId: null,
    sortOrder: max + 1,
    ...fields,
  });
  await recomputeTotals(courseId);
  await touched(await ownCourse(sellerId, courseId));
  return getOwnCourse(sellerId, courseId);
}

export async function updateLecture(
  sellerId: number,
  courseId: number,
  id: number,
  input: Partial<MktLectureInput>,
) {
  const l = await ownLecture(sellerId, courseId, id);
  if (input.type && input.type !== l.type)
    throw BadRequest('A lecture type cannot change; add a new lecture');
  const { fields } = await lectureFields(sellerId, input, l.type);
  await l.update(fields);
  await recomputeTotals(courseId);
  return getOwnCourse(sellerId, courseId);
}

export async function deleteLecture(sellerId: number, courseId: number, id: number) {
  const l = await ownLecture(sellerId, courseId, id);
  await l.destroy();
  await recomputeTotals(courseId);
  return getOwnCourse(sellerId, courseId);
}

/**
 * Reorders the whole curriculum: `sections` in display order, each with its lectures in order.
 * Lectures may move between sections; every id must belong to the course.
 */
export async function reorderCurriculum(
  sellerId: number,
  courseId: number,
  order: { id: number; lectureIds: number[] }[],
) {
  await ownCourse(sellerId, courseId);
  const [sections, lectures] = await Promise.all([
    MktSection.findAll({ where: { courseId }, attributes: ['id'] }),
    MktLecture.findAll({ where: { courseId }, attributes: ['id'] }),
  ]);
  const sIds = new Set(sections.map((s) => s.id));
  const lIds = new Set(lectures.map((l) => l.id));
  const givenL = order.flatMap((s) => s.lectureIds);
  if (
    order.length !== sIds.size ||
    !order.every((s) => sIds.has(s.id)) ||
    givenL.length !== lIds.size ||
    !givenL.every((id) => lIds.has(id)) ||
    new Set(givenL).size !== givenL.length
  )
    throw BadRequest('The order must list every section and lecture of the course exactly once');
  await getSequelize().transaction(async (transaction) => {
    for (const [i, s] of order.entries()) {
      await MktSection.update({ sortOrder: i }, { where: { id: s.id, courseId }, transaction });
      for (const [j, lid] of s.lectureIds.entries())
        await MktLecture.update(
          { sortOrder: j, sectionId: s.id },
          { where: { id: lid, courseId }, transaction },
        );
    }
  });
  return getOwnCourse(sellerId, courseId);
}

// ---------------------------------------------------------------- review workflow

export async function readiness(c: MktCourse): Promise<MktReadinessDto> {
  const issues: string[] = [];
  if (!c.subtitle) issues.push('Add a subtitle');
  if (!c.description || c.description.length < 50)
    issues.push('Write a description of at least 50 characters');
  if (!c.categoryId) issues.push('Choose a category');
  if (!c.thumbnailMediaId) issues.push('Upload a course image');
  if ((c.outcomes ?? []).length < 2) issues.push('List at least two things learners will learn');
  const outline = await curriculum(c.id);
  const lectures = outline.flatMap((s) => s.lectures);
  if (!lectures.length) issues.push('Add at least one lecture');
  if (outline.some((s) => !s.lectures.length)) issues.push('Every section needs at least one lecture');
  for (const l of lectures) {
    if (l.type === 'video' && (!l.media || l.media.status !== 'ready'))
      issues.push(`Upload the video for "${l.title}"`);
    if (l.type === 'article' && !l.articleBody?.trim()) issues.push(`Write the article "${l.title}"`);
    if (l.type === 'resource' && (!l.media || l.media.status !== 'ready'))
      issues.push(`Attach the file for "${l.title}"`);
  }
  if (c.pricePaise > 0 && !lectures.some((l) => l.preview))
    issues.push('Mark at least one lecture as a free preview');
  return { ready: issues.length === 0, issues };
}

export async function courseReadiness(sellerId: number, id: number) {
  return readiness(await ownCourse(sellerId, id));
}

export async function submitForReview(sellerId: number, id: number) {
  const c = await ownCourse(sellerId, id);
  if (!['draft', 'rejected', 'unpublished'].includes(c.status))
    throw Conflict('Only draft, rejected or unpublished courses can be submitted', 'INVALID_STATUS');
  const r = await readiness(c);
  if (!r.ready) throw BadRequest('The course is not ready for review', { issues: r.issues });
  await c.update({ status: 'in_review', submittedAt: new Date(), reviewNote: null });
  await audit({
    action: 'marketplace.course.submitted',
    entityType: 'mkt_course',
    entityId: id,
    instituteId: getContext().instituteId ?? null,
  });
  return toStudioDto(c);
}

/** The seller takes a published course off the catalog (enrolled learners keep access). */
export async function sellerUnpublish(sellerId: number, id: number) {
  const c = await ownCourse(sellerId, id);
  if (c.status !== 'published' && c.status !== 'in_review')
    throw Conflict('Only published or in-review courses can be withdrawn', 'INVALID_STATUS');
  await c.update({ status: c.status === 'in_review' ? 'draft' : 'unpublished' });
  await audit({
    action: 'marketplace.course.unpublished',
    entityType: 'mkt_course',
    entityId: id,
    instituteId: getContext().instituteId ?? null,
  });
  return toStudioDto(c);
}
