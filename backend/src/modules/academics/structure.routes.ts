import { Router } from 'express';
import { Op } from 'sequelize';
import { z } from 'zod';
import { parse } from '../../shared/utilities/validation';
import { idParam, paginated, paginationSchema, toLimitOffset } from '../../shared/utilities/pagination';
import { requirePermission } from '../../shared/middleware/authorize';
import { audit } from '../../shared/audit/audit.service';
import { BadRequest } from '../../shared/errors';
import { getSequelize } from '../../infrastructure/database/sequelize';
import { requireTenantContext } from '../../shared/context';
import { Chapter, Course, CourseBranch, CourseSubject, Subject, Topic, type AcademicSession } from './models';
import { assertBranch, repos } from './academics.service';
import {
  categoryBody,
  chapterBody,
  cloneBody,
  courseBody,
  idNum,
  sessionBody,
  sessionPatch,
  subjectBody,
  topicBody,
} from './academics.schemas';

const can = (action: 'view' | 'create' | 'edit' | 'delete' | 'configure') =>
  requirePermission('academics', action);

export function toCourseDto(c: Course) {
  const { branchLinks, subjectLinks, ...rest } = c.toJSON() as Course & {
    branchLinks?: CourseBranch[];
    subjectLinks?: CourseSubject[];
  };
  return {
    ...rest,
    branchIds: (branchLinks ?? []).map((l) => l.branchId),
    subjectIds: [...(subjectLinks ?? [])].sort((a, b) => a.sortOrder - b.sortOrder).map((l) => l.subjectId),
  };
}

const courseIncludes = [
  { model: CourseBranch, as: 'branchLinks', attributes: ['branchId'] },
  { model: CourseSubject, as: 'subjectLinks', attributes: ['subjectId', 'sortOrder'] },
];

async function loadCourse(id: number) {
  return toCourseDto(await repos.courses.findById(id, { include: courseIncludes }));
}

async function setCourseBranches(courseId: number, branchIds: number[]) {
  const unique = [...new Set(branchIds)];
  for (const b of unique) await assertBranch(b);
  const existing = await repos.courseBranches.findAll({ where: { courseId } });
  for (const link of existing) if (!unique.includes(link.branchId)) await link.destroy();
  const have = new Set(existing.map((l) => l.branchId));
  for (const branchId of unique)
    if (!have.has(branchId)) await repos.courseBranches.create({ courseId, branchId });
}

async function setCourseSubjects(courseId: number, subjectIds: number[]) {
  const unique = [...new Set(subjectIds)];
  const found = await repos.subjects.count({ id: { [Op.in]: unique } });
  if (found !== unique.length) throw BadRequest('Unknown subject id');
  const existing = await repos.courseSubjects.findAll({ where: { courseId } });
  for (const link of existing) if (!unique.includes(link.subjectId)) await link.destroy();
  for (const [sortOrder, subjectId] of unique.entries()) {
    const link = existing.find((l) => l.subjectId === subjectId);
    if (link) await link.update({ sortOrder });
    else await repos.courseSubjects.create({ courseId, subjectId, sortOrder });
  }
}

async function assertCategory(categoryId: number | null | undefined) {
  if (categoryId) await repos.categories.findById(categoryId);
}

/** Academic sessions, course catalogue and syllabus hierarchy. */
export function structureRoutes(r: Router) {
  /* ---------------- academic sessions ---------------- */
  r.get('/sessions', can('view'), async (_req, res) => {
    res.json(await repos.sessions.findAll({ order: [['startDate', 'DESC']] }));
  });

  r.get('/sessions/current', can('view'), async (_req, res) => {
    res.json((await repos.sessions.findOne({ where: { isCurrent: true } })) ?? null);
  });

  r.post('/sessions', can('create'), async (req, res) => {
    const body = parse(sessionBody, req.body);
    const isFirst = (await repos.sessions.count()) === 0;
    const row = await repos.sessions.create({ ...body, isCurrent: isFirst });
    await audit({
      action: 'academic_session.created',
      entityType: 'AcademicSession',
      entityId: row.id,
      metadata: { after: row.toJSON() },
    });
    res.status(201).json(row);
  });

  r.patch('/sessions/:id', can('edit'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    const body = parse(sessionPatch, req.body);
    const before = (await repos.sessions.findById(id)).toJSON() as AcademicSession;
    const start = body.startDate ?? before.startDate;
    const end = body.endDate ?? before.endDate;
    if (end <= start) throw BadRequest('endDate must be after startDate');
    const row = await repos.sessions.update(id, body);
    await audit({
      action: 'academic_session.updated',
      entityType: 'AcademicSession',
      entityId: id,
      metadata: { before, after: row.toJSON() },
    });
    res.json(row);
  });

  r.post('/sessions/:id/make-current', can('configure'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    const { instituteId } = requireTenantContext();
    const target = await repos.sessions.findById(id);
    await getSequelize().transaction(async (transaction) => {
      const sessions = await repos.sessions.findAll({ where: { isCurrent: true }, transaction });
      for (const s of sessions) await s.update({ isCurrent: false }, { transaction });
      await target.update(
        { isCurrent: true, status: target.status === 'planned' ? 'active' : target.status },
        { transaction },
      );
    });
    await audit({
      action: 'academic_session.made_current',
      entityType: 'AcademicSession',
      entityId: id,
      metadata: { instituteId },
    });
    res.json(target);
  });

  r.delete('/sessions/:id', can('delete'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    const row = await repos.sessions.destroy(id);
    await audit({
      action: 'academic_session.deleted',
      entityType: 'AcademicSession',
      entityId: id,
      metadata: { before: row.toJSON() },
    });
    res.status(204).end();
  });

  /* ---------------- course categories ---------------- */
  r.get('/course-categories', can('view'), async (_req, res) => {
    res.json(await repos.categories.findAll({ order: [['name', 'ASC']] }));
  });
  r.post('/course-categories', can('create'), async (req, res) => {
    const body = parse(categoryBody, req.body);
    const row = await repos.categories.create({ name: body.name, description: body.description ?? null });
    await audit({
      action: 'course_category.created',
      entityType: 'CourseCategory',
      entityId: row.id,
      metadata: { after: row.toJSON() },
    });
    res.status(201).json(row);
  });
  r.patch('/course-categories/:id', can('edit'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    const body = parse(categoryBody.partial(), req.body);
    const before = (await repos.categories.findById(id)).toJSON();
    const row = await repos.categories.update(id, body);
    await audit({
      action: 'course_category.updated',
      entityType: 'CourseCategory',
      entityId: id,
      metadata: { before, after: row.toJSON() },
    });
    res.json(row);
  });
  r.delete('/course-categories/:id', can('delete'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    const row = await repos.categories.destroy(id);
    await audit({
      action: 'course_category.deleted',
      entityType: 'CourseCategory',
      entityId: id,
      metadata: { before: row.toJSON() },
    });
    res.status(204).end();
  });

  /* ---------------- courses ---------------- */
  r.get('/courses', can('view'), async (req, res) => {
    const q = parse(
      paginationSchema.extend({
        categoryId: idNum.optional(),
        branchId: idNum.optional(),
        templates: z.enum(['true', 'false']).optional(),
        status: z.enum(['active', 'archived']).optional(),
      }),
      req.query,
    );
    const where: Record<string | symbol, unknown> = {};
    if (q.search)
      where[Op.or] = [{ name: { [Op.like]: `%${q.search}%` } }, { code: { [Op.like]: `%${q.search}%` } }];
    if (q.categoryId) where.categoryId = q.categoryId;
    if (q.templates) where.isTemplate = q.templates === 'true';
    if (q.status) where.status = q.status;
    if (q.branchId) {
      const links = await repos.courseBranches.findAll({
        where: { branchId: q.branchId },
        attributes: ['courseId'],
      });
      where.id = { [Op.in]: links.map((l) => l.courseId) };
    }
    const { rows, count } = await repos.courses.findAndCountAll({
      where,
      include: courseIncludes,
      order: [['name', 'ASC']],
      ...toLimitOffset(q),
    });
    res.json(paginated(rows.map(toCourseDto), count, q));
  });

  r.get('/courses/:id', can('view'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    res.json(await loadCourse(id));
  });

  /** Full syllabus: subjects → chapters → topics. */
  r.get('/courses/:id/syllabus', can('view'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    const course = await loadCourse(id);
    const { instituteId } = requireTenantContext();
    const subjects = course.subjectIds.length
      ? await Subject.findAll({ where: { instituteId, id: { [Op.in]: course.subjectIds } } })
      : [];
    const chapters = course.subjectIds.length
      ? await Chapter.findAll({
          where: { instituteId, subjectId: { [Op.in]: course.subjectIds } },
          order: [
            ['sortOrder', 'ASC'],
            ['id', 'ASC'],
          ],
        })
      : [];
    const topics = chapters.length
      ? await Topic.findAll({
          where: { instituteId, chapterId: { [Op.in]: chapters.map((c) => c.id) } },
          order: [
            ['sortOrder', 'ASC'],
            ['id', 'ASC'],
          ],
        })
      : [];
    res.json({
      course,
      subjects: course.subjectIds
        .map((sid) => subjects.find((s) => s.id === sid))
        .filter((s): s is Subject => !!s)
        .map((s) => ({
          ...s.toJSON(),
          chapters: chapters
            .filter((c) => c.subjectId === s.id)
            .map((c) => ({ ...c.toJSON(), topics: topics.filter((t) => t.chapterId === c.id) })),
        })),
    });
  });

  r.post('/courses', can('create'), async (req, res) => {
    const body = parse(courseBody, req.body);
    await assertCategory(body.categoryId);
    if ((body.durationValue == null) !== (body.durationUnit == null))
      throw BadRequest('durationValue and durationUnit must be set together');
    const course = await repos.courses.create({
      name: body.name,
      code: body.code,
      categoryId: body.categoryId ?? null,
      templateId: null,
      description: body.description ?? null,
      mode: body.mode,
      durationValue: body.durationValue ?? null,
      durationUnit: body.durationUnit ?? null,
      isTemplate: body.isTemplate,
      status: body.status,
    });
    if (body.branchIds) await setCourseBranches(course.id, body.branchIds);
    if (body.subjectIds) await setCourseSubjects(course.id, body.subjectIds);
    const dto = await loadCourse(course.id);
    await audit({
      action: 'course.created',
      entityType: 'Course',
      entityId: course.id,
      metadata: { after: dto },
    });
    res.status(201).json(dto);
  });

  /** Create a course from a template (or any course): copies settings and the subject list. */
  r.post('/courses/:id/clone', can('create'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    const body = parse(cloneBody, req.body);
    const src = await loadCourse(id);
    const course = await repos.courses.create({
      name: body.name,
      code: body.code,
      categoryId: src.categoryId,
      templateId: src.id,
      description: src.description,
      mode: src.mode,
      durationValue: src.durationValue,
      durationUnit: src.durationUnit,
      isTemplate: body.isTemplate ?? false,
    });
    await setCourseSubjects(course.id, src.subjectIds);
    await setCourseBranches(course.id, body.branchIds ?? []);
    const dto = await loadCourse(course.id);
    await audit({
      action: 'course.created',
      entityType: 'Course',
      entityId: course.id,
      metadata: { after: dto, fromCourseId: src.id },
    });
    res.status(201).json(dto);
  });

  r.patch('/courses/:id', can('edit'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    const body = parse(courseBody.partial(), req.body);
    const before = await loadCourse(id);
    await assertCategory(body.categoryId);
    const { branchIds, subjectIds, ...fields } = body;
    const durationValue = fields.durationValue !== undefined ? fields.durationValue : before.durationValue;
    const durationUnit = fields.durationUnit !== undefined ? fields.durationUnit : before.durationUnit;
    if ((durationValue == null) !== (durationUnit == null))
      throw BadRequest('durationValue and durationUnit must be set together');
    await repos.courses.update(id, fields);
    if (branchIds) await setCourseBranches(id, branchIds);
    if (subjectIds) await setCourseSubjects(id, subjectIds);
    const after = await loadCourse(id);
    await audit({
      action: 'course.updated',
      entityType: 'Course',
      entityId: id,
      metadata: { before, after },
    });
    res.json(after);
  });

  r.delete('/courses/:id', can('delete'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    const before = await loadCourse(id);
    await repos.courses.destroy(id);
    await audit({ action: 'course.deleted', entityType: 'Course', entityId: id, metadata: { before } });
    res.status(204).end();
  });

  /* ---------------- subjects / chapters / topics ---------------- */
  r.get('/subjects', can('view'), async (req, res) => {
    const q = parse(z.object({ courseId: idNum.optional() }), req.query);
    if (q.courseId) {
      const course = await loadCourse(q.courseId);
      const rows = await repos.subjects.findAll({ where: { id: { [Op.in]: course.subjectIds } } });
      res.json(course.subjectIds.map((sid) => rows.find((s) => s.id === sid)).filter(Boolean));
      return;
    }
    res.json(await repos.subjects.findAll({ order: [['name', 'ASC']] }));
  });
  r.post('/subjects', can('create'), async (req, res) => {
    const body = parse(subjectBody, req.body);
    const row = await repos.subjects.create({ name: body.name, code: body.code ?? null });
    await audit({
      action: 'subject.created',
      entityType: 'Subject',
      entityId: row.id,
      metadata: { after: row.toJSON() },
    });
    res.status(201).json(row);
  });
  r.patch('/subjects/:id', can('edit'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    const body = parse(subjectBody.partial(), req.body);
    const before = (await repos.subjects.findById(id)).toJSON();
    const row = await repos.subjects.update(id, body);
    await audit({
      action: 'subject.updated',
      entityType: 'Subject',
      entityId: id,
      metadata: { before, after: row.toJSON() },
    });
    res.json(row);
  });
  r.delete('/subjects/:id', can('delete'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    const row = await repos.subjects.destroy(id);
    await audit({
      action: 'subject.deleted',
      entityType: 'Subject',
      entityId: id,
      metadata: { before: row.toJSON() },
    });
    res.status(204).end();
  });

  r.get('/subjects/:id/chapters', can('view'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    await repos.subjects.findById(id);
    const chapters = await repos.chapters.findAll({
      where: { subjectId: id },
      order: [
        ['sortOrder', 'ASC'],
        ['id', 'ASC'],
      ],
    });
    const topics = chapters.length
      ? await repos.topics.findAll({
          where: { chapterId: { [Op.in]: chapters.map((c) => c.id) } },
          order: [
            ['sortOrder', 'ASC'],
            ['id', 'ASC'],
          ],
        })
      : [];
    res.json(chapters.map((c) => ({ ...c.toJSON(), topics: topics.filter((t) => t.chapterId === c.id) })));
  });

  r.post('/chapters', can('create'), async (req, res) => {
    const body = parse(chapterBody, req.body);
    await repos.subjects.findById(body.subjectId);
    const row = await repos.chapters.create(body);
    await audit({
      action: 'chapter.created',
      entityType: 'Chapter',
      entityId: row.id,
      metadata: { after: row.toJSON() },
    });
    res.status(201).json(row);
  });
  r.patch('/chapters/:id', can('edit'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    const body = parse(chapterBody.partial(), req.body);
    if (body.subjectId) await repos.subjects.findById(body.subjectId);
    const before = (await repos.chapters.findById(id)).toJSON();
    const row = await repos.chapters.update(id, body);
    await audit({
      action: 'chapter.updated',
      entityType: 'Chapter',
      entityId: id,
      metadata: { before, after: row.toJSON() },
    });
    res.json(row);
  });
  r.delete('/chapters/:id', can('delete'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    const row = await repos.chapters.destroy(id);
    await audit({
      action: 'chapter.deleted',
      entityType: 'Chapter',
      entityId: id,
      metadata: { before: row.toJSON() },
    });
    res.status(204).end();
  });

  r.post('/topics', can('create'), async (req, res) => {
    const body = parse(topicBody, req.body);
    await repos.chapters.findById(body.chapterId);
    const row = await repos.topics.create({ ...body, durationMinutes: body.durationMinutes ?? null });
    await audit({
      action: 'topic.created',
      entityType: 'Topic',
      entityId: row.id,
      metadata: { after: row.toJSON() },
    });
    res.status(201).json(row);
  });
  r.patch('/topics/:id', can('edit'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    const body = parse(topicBody.partial(), req.body);
    if (body.chapterId) await repos.chapters.findById(body.chapterId);
    const before = (await repos.topics.findById(id)).toJSON();
    const row = await repos.topics.update(id, body);
    await audit({
      action: 'topic.updated',
      entityType: 'Topic',
      entityId: id,
      metadata: { before, after: row.toJSON() },
    });
    res.json(row);
  });
  r.delete('/topics/:id', can('delete'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    const row = await repos.topics.destroy(id);
    await audit({
      action: 'topic.deleted',
      entityType: 'Topic',
      entityId: id,
      metadata: { before: row.toJSON() },
    });
    res.status(204).end();
  });
}
