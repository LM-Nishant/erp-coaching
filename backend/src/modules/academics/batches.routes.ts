import { Router } from 'express';
import { Op } from 'sequelize';
import { z } from 'zod';
import type { PromotionFeeStudentResult, PromotionResult } from '@erp/shared';
import { parse } from '../../shared/utilities/validation';
import { idParam, paginated, paginationSchema, toLimitOffset } from '../../shared/utilities/pagination';
import { requirePermission } from '../../shared/middleware/authorize';
import { audit } from '../../shared/audit/audit.service';
import { BadRequest, Conflict, Forbidden, NotFound } from '../../shared/errors';
import { getContext, hasPermission, requireTenantContext } from '../../shared/context';
import { getSequelize } from '../../infrastructure/database/sequelize';
import { Batch, BatchStudent, BatchTeacher, ClassSession, userRef } from './models';
import { User } from '../users/user.model';
import { studentRepo } from '../students/students.service';
import {
  assertBranch,
  assertTeachers,
  enrollStudentsInBatch,
  listUsersWithRole,
  repos,
  today,
} from './academics.service';
import {
  batchBody,
  classroomBody,
  enrollBody,
  idNum,
  promotionBody,
  teachersBody,
  dateStr,
} from './academics.schemas';
import {
  preparePromotionFees,
  promotionFeeOptions,
  summarizePromotionFees,
  type PromotionFeeTarget,
} from './promotion-fees';

const can = (action: 'view' | 'create' | 'edit' | 'delete' | 'configure') =>
  requirePermission('academics', action);

const teacherInclude = {
  model: BatchTeacher,
  as: 'teachers',
  attributes: ['teacherUserId', 'subjectId'],
  include: [{ model: User, as: 'teacher', ...userRef }],
};

async function loadBatch(id: number) {
  const batch = await repos.batches.findById(id, { include: [teacherInclude] });
  const enrolledCount = await repos.batchStudents.count({ batchId: id, status: 'active' });
  return { ...(batch.toJSON() as object), enrolledCount } as Batch & { enrolledCount: number };
}

async function assertCourseAtBranch(courseId: number, branchId: number) {
  const course = await repos.courses.findById(courseId);
  if (course.isTemplate) throw BadRequest('Batches cannot be created for a course template');
  const offered = await repos.courseBranches.count({ courseId, branchId });
  if (!offered) throw BadRequest('Course is not offered at this branch');
  return course;
}

async function validateTeachers(teachers: { teacherUserId: number; subjectId?: number | null }[]) {
  await assertTeachers(teachers.map((t) => t.teacherUserId));
  const subjectIds = [...new Set(teachers.map((t) => t.subjectId).filter((s): s is number => !!s))];
  if (
    subjectIds.length &&
    (await repos.subjects.count({ id: { [Op.in]: subjectIds } })) !== subjectIds.length
  )
    throw BadRequest('Unknown subject id');
}

async function replaceTeachers(
  batchId: number,
  teachers: { teacherUserId: number; subjectId?: number | null }[],
) {
  await validateTeachers(teachers);
  const { instituteId } = requireTenantContext();
  await getSequelize().transaction(async (transaction) => {
    await BatchTeacher.destroy({ where: { instituteId, batchId }, transaction });
    const seen = new Set<string>();
    for (const t of teachers) {
      const key = `${t.teacherUserId}:${t.subjectId ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      await repos.batchTeachers.create(
        { batchId, teacherUserId: t.teacherUserId, subjectId: t.subjectId ?? null },
        { transaction },
      );
    }
  });
}

/** Batches, teacher assignment, enrollment, promotion, classrooms and user lookups. */
export function batchRoutes(r: Router) {
  /* ---------------- lookups ---------------- */
  r.get('/teachers', can('view'), async (req, res) => {
    const q = parse(z.object({ search: z.string().trim().max(100).optional() }), req.query);
    res.json(await listUsersWithRole('teacher', q.search));
  });

  r.get('/students', can('edit'), async (req, res) => {
    const q = parse(z.object({ search: z.string().trim().max(100).optional() }), req.query);
    res.json(await listUsersWithRole('student', q.search));
  });

  /* ---------------- batches ---------------- */
  r.get('/batches', can('view'), async (req, res) => {
    const q = parse(
      paginationSchema.extend({
        courseId: idNum.optional(),
        academicSessionId: idNum.optional(),
        branchId: idNum.optional(),
        status: z.enum(['planned', 'active', 'completed', 'cancelled']).optional(),
        teacherUserId: idNum.optional(),
      }),
      req.query,
    );
    const where: Record<string | symbol, unknown> = {};
    if (q.search)
      where[Op.or] = [{ name: { [Op.like]: `%${q.search}%` } }, { code: { [Op.like]: `%${q.search}%` } }];
    for (const k of ['courseId', 'academicSessionId', 'branchId', 'status'] as const)
      if (q[k]) where[k] = q[k];
    if (q.teacherUserId) {
      const links = await repos.batchTeachers.findAll({
        where: { teacherUserId: q.teacherUserId },
        attributes: ['batchId'],
      });
      where.id = { [Op.in]: links.map((l) => l.batchId) };
    }
    const { rows, count } = await repos.batches.findAndCountAll({
      where,
      include: [teacherInclude],
      order: [
        ['startDate', 'DESC'],
        ['name', 'ASC'],
      ],
      ...toLimitOffset(q),
    });
    const counts = rows.length
      ? ((await BatchStudent.findAll({
          where: {
            instituteId: requireTenantContext().instituteId,
            batchId: { [Op.in]: rows.map((b) => b.id) },
            status: 'active',
          },
          attributes: ['batchId', [getSequelize().fn('COUNT', getSequelize().col('id')), 'n']],
          group: ['batchId'],
          raw: true,
        })) as unknown as { batchId: number; n: number }[])
      : [];
    res.json(
      paginated(
        rows.map((b) => ({
          ...(b.toJSON() as object),
          enrolledCount: Number(counts.find((c) => c.batchId === b.id)?.n ?? 0),
        })),
        count,
        q,
      ),
    );
  });

  r.get('/batches/:id', can('view'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    res.json(await loadBatch(id));
  });

  r.post('/batches', can('create'), async (req, res) => {
    const body = parse(batchBody, req.body);
    await assertBranch(body.branchId);
    await repos.sessions.findById(body.academicSessionId);
    const course = await assertCourseAtBranch(body.courseId, body.branchId);
    if (body.endDate && body.endDate < body.startDate) throw BadRequest('endDate must be after startDate');
    if (body.teachers) await validateTeachers(body.teachers);
    const batch = await repos.batches.create({
      branchId: body.branchId,
      courseId: body.courseId,
      academicSessionId: body.academicSessionId,
      name: body.name,
      code: body.code,
      capacity: body.capacity,
      startDate: body.startDate,
      endDate: body.endDate ?? null,
      mode: body.mode ?? course.mode,
      status: body.status,
    });
    if (body.teachers) await replaceTeachers(batch.id, body.teachers);
    const dto = await loadBatch(batch.id);
    await audit({
      action: 'batch.created',
      entityType: 'Batch',
      entityId: batch.id,
      metadata: { after: dto },
    });
    res.status(201).json(dto);
  });

  r.patch('/batches/:id', can('edit'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    const body = parse(batchBody.partial(), req.body);
    const before = await loadBatch(id);
    const branchId = body.branchId ?? before.branchId;
    if (body.branchId) await assertBranch(body.branchId);
    if (body.academicSessionId) await repos.sessions.findById(body.academicSessionId);
    if (body.branchId || body.courseId)
      await assertCourseAtBranch(body.courseId ?? before.courseId, branchId);
    const start = body.startDate ?? before.startDate;
    const end = body.endDate !== undefined ? body.endDate : before.endDate;
    if (end && end < start) throw BadRequest('endDate must be after startDate');
    if (body.capacity !== undefined && body.capacity < before.enrolledCount)
      throw Conflict(
        `Capacity cannot be below the ${before.enrolledCount} enrolled students`,
        'CAPACITY_TOO_LOW',
      );
    const { teachers, ...fields } = body;
    await repos.batches.update(id, fields);
    if (teachers) await replaceTeachers(id, teachers);
    const after = await loadBatch(id);
    await audit({ action: 'batch.updated', entityType: 'Batch', entityId: id, metadata: { before, after } });
    res.json(after);
  });

  r.put('/batches/:id/teachers', can('edit'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    const body = parse(teachersBody, req.body);
    const before = await loadBatch(id);
    await replaceTeachers(id, body.teachers);
    const after = await loadBatch(id);
    await audit({
      action: 'batch.teachers_updated',
      entityType: 'Batch',
      entityId: id,
      metadata: { before: before.teachers, after: after.teachers },
    });
    res.json(after);
  });

  r.delete('/batches/:id', can('delete'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    const before = await loadBatch(id);
    if ((await repos.batchStudents.count({ batchId: id })) > 0)
      throw Conflict('Batch has enrollment history; mark it cancelled or completed instead', 'BATCH_IN_USE');
    const { instituteId } = requireTenantContext();
    if ((await ClassSession.count({ where: { instituteId, batchId: id } })) > 0)
      throw Conflict('Batch has class sessions; mark it cancelled or completed instead', 'BATCH_IN_USE');
    await repos.batches.destroy(id);
    await audit({ action: 'batch.deleted', entityType: 'Batch', entityId: id, metadata: { before } });
    res.status(204).end();
  });

  /* ---------------- enrollment ---------------- */
  r.get('/batches/:id/students', can('view'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    const q = parse(
      z.object({ status: z.enum(['active', 'promoted', 'completed', 'left', 'all']).default('active') }),
      req.query,
    );
    await repos.batches.findById(id);
    if (
      !hasPermission('academics.edit') &&
      !(await repos.batchTeachers.count({ batchId: id, teacherUserId: getContext().userId! }))
    )
      throw Forbidden('Only staff and the batch teachers can view the roster', 'NOT_BATCH_TEACHER');
    res.json(
      await repos.batchStudents.findAll({
        where: { batchId: id, ...(q.status === 'all' ? {} : { status: q.status }) },
        include: [{ model: User, as: 'student', ...userRef }],
        order: [['id', 'ASC']],
      }),
    );
  });

  r.post('/batches/:id/students', can('edit'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    const body = parse(enrollBody, req.body);
    const { enrolled } = await enrollStudentsInBatch(id, body.studentUserIds, { joinedOn: body.joinedOn });
    await audit({
      action: 'batch.students_enrolled',
      entityType: 'Batch',
      entityId: id,
      metadata: { studentUserIds: enrolled },
    });
    res
      .status(201)
      .json({ enrolled: enrolled.length, skipped: body.studentUserIds.length - enrolled.length });
  });

  r.delete('/batches/:id/students/:studentUserId', can('edit'), async (req, res) => {
    const { id, studentUserId } = parse(z.object({ id: idNum, studentUserId: idNum }), req.params);
    await repos.batches.findById(id);
    const row = await repos.batchStudents.findOne({
      where: { batchId: id, studentUserId, status: 'active' },
    });
    if (!row) throw NotFound('Enrollment');
    const before = row.toJSON();
    await row.update({ status: 'left', leftOn: await today() });
    await audit({
      action: 'batch.student_removed',
      entityType: 'BatchStudent',
      entityId: row.id,
      metadata: { before, after: row.toJSON() },
    });
    res.status(204).end();
  });

  /** A student's enrollment history across sessions (staff, or the student themself). */
  r.get('/students/:studentUserId/history', can('view'), async (req, res) => {
    const { studentUserId } = parse(z.object({ studentUserId: idNum }), req.params);
    const self = getContext().userId === studentUserId;
    if (!hasPermission('academics.edit') && !self) throw NotFound('Student');
    // Students of another institute or of a branch the caller cannot see are 404, not an empty history.
    if (!self && !(await studentRepo.findOne({ where: { userId: studentUserId }, attributes: ['id'] })))
      throw NotFound('Student');
    const enrollments = await repos.batchStudents.findAll({
      where: { studentUserId },
      include: [
        {
          model: Batch,
          as: 'batch',
          attributes: ['id', 'name', 'code', 'courseId', 'academicSessionId', 'branchId'],
        },
      ],
      order: [['id', 'ASC']],
    });
    const promotions = await repos.promotions.findAll({ where: { studentUserId }, order: [['id', 'ASC']] });
    res.json({ enrollments, promotions });
  });

  /* ---------------- promotion ---------------- */
  const feeTarget = (b: Batch): PromotionFeeTarget => ({
    batchId: b.id,
    branchId: b.branchId,
    courseId: b.courseId,
    academicSessionId: b.academicSessionId,
  });

  /** Fee structures that can bill students promoted into this batch (needs `fees.create`). */
  r.get('/batches/:id/promotion-fees', can('configure'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    res.json(await promotionFeeOptions(feeTarget(await repos.batches.findById(id))));
  });

  r.post('/promotions', can('configure'), async (req, res) => {
    const body = parse(promotionBody, req.body);
    if (body.fromBatchId === body.toBatchId) throw BadRequest('Source and target batch must differ');
    const from = await repos.batches.findById(body.fromBatchId);
    const to = await repos.batches.findById(body.toBatchId);
    if (to.status === 'cancelled' || to.status === 'completed')
      throw BadRequest(`Target batch is ${to.status}`);
    const fromSession = await repos.sessions.findById(from.academicSessionId);
    const toSession = await repos.sessions.findById(to.academicSessionId);
    if (toSession.id === fromSession.id || toSession.startDate <= fromSession.startDate)
      throw BadRequest('Target batch must belong to a later academic session');
    const fees = body.fees ? await preparePromotionFees(feeTarget(to), body.fees) : null;

    const active = await repos.batchStudents.findAll({ where: { batchId: from.id, status: 'active' } });
    const wanted = body.studentUserIds ? new Set(body.studentUserIds) : null;
    const skipped: { studentUserId: number; reason: string }[] = [];
    if (wanted)
      for (const s of wanted)
        if (!active.some((e) => e.studentUserId === s))
          skipped.push({ studentUserId: s, reason: 'Not active in source batch' });
    const candidates = active.filter((e) => !wanted || wanted.has(e.studentUserId));
    const inTarget = new Set(
      (
        await repos.batchStudents.findAll({
          where: { batchId: to.id, status: 'active' },
          attributes: ['studentUserId'],
        })
      ).map((e) => e.studentUserId),
    );
    const moving = candidates.filter((e) => {
      if (inTarget.has(e.studentUserId)) {
        skipped.push({ studentUserId: e.studentUserId, reason: 'Already enrolled in target batch' });
        return false;
      }
      return true;
    });
    if (inTarget.size + moving.length > to.capacity)
      throw Conflict(`Target batch capacity ${to.capacity} exceeded`, 'BATCH_FULL');

    const { userId } = getContext();
    const day = await today();
    let feeResults: PromotionFeeStudentResult[] = [];
    await getSequelize().transaction(async (transaction) => {
      for (const e of moving) {
        await e.update({ status: 'promoted', leftOn: day }, { transaction });
        await repos.batchStudents.create(
          {
            batchId: to.id,
            studentUserId: e.studentUserId,
            joinedOn: day,
            leftOn: null,
            promotedFromId: e.id,
          },
          { transaction },
        );
        await repos.promotions.create(
          {
            studentUserId: e.studentUserId,
            fromBatchId: from.id,
            toBatchId: to.id,
            fromSessionId: fromSession.id,
            toSessionId: toSession.id,
            promotedByUserId: userId ?? null,
          },
          { transaction },
        );
      }
      // Only the students promoted now are billed, never others already in the target batch.
      if (fees && moving.length)
        feeResults = await fees.apply(
          moving.map((e) => e.studentUserId),
          transaction,
        );
    });
    const feeSummary = fees ? summarizePromotionFees(fees, feeResults) : undefined;
    await audit({
      action: 'academics.students_promoted',
      entityType: 'Batch',
      entityId: from.id,
      metadata: {
        toBatchId: to.id,
        studentUserIds: moving.map((e) => e.studentUserId),
        skipped,
        ...(feeSummary && {
          fees: {
            structureId: feeSummary.structureId,
            created: feeSummary.created,
            skipped: feeSummary.skipped,
          },
        }),
      },
    });
    if (fees && feeSummary && feeResults.length) await fees.afterCommit(feeSummary, from.id);
    const result: PromotionResult = {
      promoted: moving.length,
      skipped,
      ...(feeSummary && { fees: feeSummary }),
    };
    res.json(result);
  });

  r.get('/promotions', can('view'), async (req, res) => {
    const q = parse(
      paginationSchema.extend({
        studentUserId: idNum.optional(),
        fromSessionId: idNum.optional(),
        toSessionId: idNum.optional(),
      }),
      req.query,
    );
    const where: Record<string, unknown> = {};
    for (const k of ['studentUserId', 'fromSessionId', 'toSessionId'] as const) if (q[k]) where[k] = q[k];
    const { rows, count } = await repos.promotions.findAndCountAll({
      where,
      order: [['id', 'DESC']],
      ...toLimitOffset(q),
    });
    res.json(paginated(rows, count, q));
  });

  /* ---------------- classrooms ---------------- */
  r.get('/classrooms', can('view'), async (req, res) => {
    const q = parse(
      z.object({ branchId: idNum.optional(), status: z.enum(['active', 'inactive']).optional() }),
      req.query,
    );
    res.json(
      await repos.classrooms.findAll({
        where: { ...(q.branchId ? { branchId: q.branchId } : {}), ...(q.status ? { status: q.status } : {}) },
        order: [['name', 'ASC']],
      }),
    );
  });

  /** Booked class sessions of a classroom on a given day. */
  r.get('/classrooms/:id/availability', can('view'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    const { date } = parse(z.object({ date: dateStr }), req.query);
    const room = await repos.classrooms.findById(id);
    const booked = await ClassSession.findAll({
      where: { instituteId: room.instituteId, classroomId: id, date, status: { [Op.ne]: 'cancelled' } },
      attributes: ['id', 'batchId', 'teacherUserId', 'startTime', 'endTime', 'status'],
      order: [['startTime', 'ASC']],
    });
    res.json({ classroom: room, date, booked });
  });

  r.post('/classrooms', can('create'), async (req, res) => {
    const body = parse(classroomBody, req.body);
    await assertBranch(body.branchId);
    const row = await repos.classrooms.create(body);
    await audit({
      action: 'classroom.created',
      entityType: 'Classroom',
      entityId: row.id,
      metadata: { after: row.toJSON() },
    });
    res.status(201).json(row);
  });

  r.patch('/classrooms/:id', can('edit'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    const body = parse(classroomBody.partial(), req.body);
    if (body.branchId) await assertBranch(body.branchId);
    const before = (await repos.classrooms.findById(id)).toJSON();
    const row = await repos.classrooms.update(id, body);
    await audit({
      action: 'classroom.updated',
      entityType: 'Classroom',
      entityId: id,
      metadata: { before, after: row.toJSON() },
    });
    res.json(row);
  });

  r.delete('/classrooms/:id', can('delete'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    const row = await repos.classrooms.destroy(id);
    await audit({
      action: 'classroom.deleted',
      entityType: 'Classroom',
      entityId: id,
      metadata: { before: row.toJSON() },
    });
    res.status(204).end();
  });
}
