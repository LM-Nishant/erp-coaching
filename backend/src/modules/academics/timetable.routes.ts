import { Router } from 'express';
import { Op, type WhereOptions } from 'sequelize';
import { z } from 'zod';
import { parse } from '../../shared/utilities/validation';
import { idParam, paginated, toLimitOffset } from '../../shared/utilities/pagination';
import { requirePermission } from '../../shared/middleware/authorize';
import { audit } from '../../shared/audit/audit.service';
import { BadRequest, Conflict, Forbidden, NotFound } from '../../shared/errors';
import { getContext, hasPermission, requireTenantContext } from '../../shared/context';
import { getSequelize } from '../../infrastructure/database/sequelize';
import { User } from '../users/user.model';
import { FileObject } from '../files/file.model';
import { fileRepo, signedUrlFor } from '../files/files.service';
import { applyClassCompletion } from './class-completion';
import {
  Batch,
  ClassNote,
  ClassNoteAttachment,
  ClassNoteComment,
  ClassSession,
  Classroom,
  Subject,
  userRef,
} from './models';
import {
  assertCanAccessClassSession,
  assertNoScheduleConflict,
  assertNoSessionConflict,
  assertRoomFitsBatch,
  assertTeacherOrStaff,
  assertTeachers,
  assertTimeRange,
  generateSessions,
  notifyClassChanged,
  repos,
  today,
  withSchedulingLock,
} from './academics.service';
import {
  cancelBody,
  classSessionBody,
  classSessionQuery,
  commentBody,
  completeBody,
  dateStr,
  generateBody,
  idNum,
  noteBody,
  notePatch,
  rescheduleBody,
  scheduleBody,
  substituteBody,
} from './academics.schemas';

const can = (action: 'view' | 'create' | 'edit' | 'delete') => requirePermission('academics', action);
const notes = (action: 'view' | 'create' | 'edit' | 'delete') => requirePermission('class-notes', action);

const sessionIncludes = [
  { model: Batch, as: 'batch', attributes: ['id', 'name', 'courseId'] },
  { model: Subject, as: 'subject', attributes: ['id', 'name'] },
  { model: User, as: 'teacher', ...userRef },
  { model: Classroom, as: 'classroom', attributes: ['id', 'name'] },
];

async function assertSubject(subjectId: number | null | undefined) {
  if (subjectId) await repos.subjects.findById(subjectId);
}

async function defaultRange(from?: string, to?: string) {
  const start = from ?? (await today());
  const end = to ?? new Date(Date.parse(`${start}T00:00:00Z`) + 6 * 86400000).toISOString().slice(0, 10);
  if (end < start) throw BadRequest('"to" must be on or after "from"');
  return { from: start, to: end };
}

async function serializeNote(note: ClassNote) {
  const json = note.toJSON() as ClassNote & { attachments?: ClassNoteAttachment[] };
  return {
    ...json,
    attachments: (note.attachments ?? [])
      .filter((a) => a.file)
      .map((a) => ({
        fileId: a.fileId,
        name: a.file!.originalName,
        mimeType: a.file!.mimeType,
        url: signedUrlFor(a.file!).url,
      })),
  };
}

const noteIncludes = [
  { model: ClassNoteAttachment, as: 'attachments', include: [{ model: FileObject, as: 'file' }] },
  {
    model: ClassNoteComment,
    as: 'comments',
    include: [{ model: User, as: 'user', ...userRef }],
  },
];

async function attachFiles(noteId: number, fileIds: number[]) {
  const { instituteId } = requireTenantContext();
  for (const fileId of [...new Set(fileIds)]) {
    // Institute-wide uploads have no branch, which fileRepo's branch scope would hide from branch users.
    const file = await FileObject.findOne({ where: { instituteId, id: fileId } });
    if (!file) throw NotFound('File');
    fileRepo.assertBranchAllowed(file.branchId);
    await repos.noteAttachments.create({ classNoteId: noteId, fileId });
  }
}

async function loadNoteWithSession(noteId: number) {
  const note = await repos.notes.findById(noteId);
  const session = await repos.classSessions.findOne({ where: { id: note.classSessionId } });
  if (!session) throw NotFound('Class note');
  return { note, session };
}

/** Recurring timetable, class sessions, teacher notes/homework and student comments. */
export function timetableRoutes(r: Router) {
  /* ---------------- recurring schedules ---------------- */
  r.get('/schedules', can('view'), async (req, res) => {
    const q = parse(
      z.object({
        batchId: idNum.optional(),
        teacherUserId: idNum.optional(),
        classroomId: idNum.optional(),
        branchId: idNum.optional(),
        activeOn: dateStr.optional(),
      }),
      req.query,
    );
    const where: Record<string | symbol, unknown> = {};
    for (const k of ['batchId', 'teacherUserId', 'classroomId', 'branchId'] as const)
      if (q[k]) where[k] = q[k];
    if (q.activeOn) {
      where.effectiveFrom = { [Op.lte]: q.activeOn };
      where[Op.or] = [{ effectiveTo: null }, { effectiveTo: { [Op.gte]: q.activeOn } }];
    }
    res.json(
      await repos.schedules.findAll({
        where,
        order: [
          ['dayOfWeek', 'ASC'],
          ['startTime', 'ASC'],
        ],
      }),
    );
  });

  r.post('/schedules', can('create'), async (req, res) => {
    const body = parse(scheduleBody, req.body);
    assertTimeRange(body.startTime, body.endTime);
    if (body.effectiveTo && body.effectiveTo < body.effectiveFrom)
      throw BadRequest('effectiveTo must be after effectiveFrom');
    const batch = await repos.batches.findById(body.batchId);
    await assertTeachers([body.teacherUserId]);
    await assertSubject(body.subjectId);
    const row = await withSchedulingLock(async (t) => {
      await assertRoomFitsBatch(body.classroomId ?? null, batch, t);
      const slot = { ...body, classroomId: body.classroomId ?? null, effectiveTo: body.effectiveTo ?? null };
      await assertNoScheduleConflict(slot, undefined, t);
      return repos.schedules.create(
        { ...slot, branchId: batch.branchId, subjectId: body.subjectId ?? null },
        { transaction: t },
      );
    });
    await audit({
      action: 'schedule.created',
      entityType: 'ClassSchedule',
      entityId: row.id,
      metadata: { after: row.toJSON() },
    });
    res.status(201).json(row);
  });

  r.patch('/schedules/:id', can('edit'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    const body = parse(scheduleBody.partial(), req.body);
    const current = await repos.schedules.findById(id);
    const before = current.toJSON();
    const merged = {
      batchId: body.batchId ?? current.batchId,
      subjectId: body.subjectId !== undefined ? body.subjectId : current.subjectId,
      teacherUserId: body.teacherUserId ?? current.teacherUserId,
      classroomId: body.classroomId !== undefined ? body.classroomId : current.classroomId,
      dayOfWeek: body.dayOfWeek ?? current.dayOfWeek,
      startTime: body.startTime ?? current.startTime,
      endTime: body.endTime ?? current.endTime,
      effectiveFrom: body.effectiveFrom ?? current.effectiveFrom,
      effectiveTo: body.effectiveTo !== undefined ? body.effectiveTo : current.effectiveTo,
    };
    assertTimeRange(merged.startTime, merged.endTime);
    if (merged.effectiveTo && merged.effectiveTo < merged.effectiveFrom)
      throw BadRequest('effectiveTo must be after effectiveFrom');
    const batch = await repos.batches.findById(merged.batchId);
    if (body.teacherUserId) await assertTeachers([body.teacherUserId]);
    await assertSubject(body.subjectId);
    const row = await withSchedulingLock(async (t) => {
      await assertRoomFitsBatch(merged.classroomId ?? null, batch, t);
      await assertNoScheduleConflict({ ...merged, classroomId: merged.classroomId ?? null }, id, t);
      return repos.schedules.update(id, { ...merged, branchId: batch.branchId }, { transaction: t });
    });
    await audit({
      action: 'schedule.updated',
      entityType: 'ClassSchedule',
      entityId: id,
      metadata: { before, after: row.toJSON() },
    });
    res.json(row);
  });

  /** Removes the recurring slot and its future, not-yet-held occurrences. Past sessions are kept. */
  r.delete('/schedules/:id', can('delete'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    const row = await repos.schedules.findById(id);
    const { instituteId } = requireTenantContext();
    const day = await today();
    await getSequelize().transaction(async (transaction) => {
      await ClassSession.destroy({
        where: { instituteId, scheduleId: id, status: 'scheduled', date: { [Op.gte]: day } },
        transaction,
      });
      await row.destroy({ transaction });
    });
    await audit({
      action: 'schedule.deleted',
      entityType: 'ClassSchedule',
      entityId: id,
      metadata: { before: row.toJSON() },
    });
    res.status(204).end();
  });

  r.post('/schedules/generate', can('create'), async (req, res) => {
    const body = parse(generateBody, req.body);
    if (body.batchId) await repos.batches.findById(body.batchId);
    const result = await generateSessions(body);
    await audit({
      action: 'class_sessions.generated',
      entityType: 'ClassSession',
      metadata: { ...body, ...result },
    });
    res.json(result);
  });

  /* ---------------- class sessions ---------------- */
  r.get('/class-sessions', can('view'), async (req, res) => {
    const q = parse(classSessionQuery, req.query);
    const { from, to } = await defaultRange(q.from, q.to);
    const where: Record<string | symbol, unknown> = { date: { [Op.between]: [from, to] } };
    for (const k of ['batchId', 'teacherUserId', 'classroomId', 'status'] as const) if (q[k]) where[k] = q[k];
    const { rows, count } = await repos.classSessions.findAndCountAll({
      where,
      include: sessionIncludes,
      order: [
        ['date', 'ASC'],
        ['startTime', 'ASC'],
      ],
      ...toLimitOffset(q),
    });
    res.json(paginated(rows, count, q));
  });

  /** Classes for the signed-in user: as teacher (incl. substitutions) and as an enrolled student. */
  r.get('/my-timetable', can('view'), async (req, res) => {
    const q = parse(z.object({ from: dateStr.optional(), to: dateStr.optional() }), req.query);
    const { from, to } = await defaultRange(q.from, q.to);
    const { userId, instituteId } = requireTenantContext();
    const enrolled = await repos.batchStudents.findAll({
      where: { studentUserId: userId!, status: 'active' },
      attributes: ['batchId'],
    });
    const or: WhereOptions[] = [{ teacherUserId: userId }];
    if (enrolled.length) or.push({ batchId: { [Op.in]: enrolled.map((e) => e.batchId) } });
    // Not branch-scoped: a teacher may teach at several branches and a student's batch defines access.
    const rows = await ClassSession.findAll({
      where: { instituteId, date: { [Op.between]: [from, to] }, [Op.or]: or } as WhereOptions<ClassSession>,
      include: sessionIncludes,
      order: [
        ['date', 'ASC'],
        ['startTime', 'ASC'],
      ],
      limit: 1000,
    });
    res.json({ from, to, items: rows });
  });

  r.get('/class-sessions/:id', can('view'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    const { instituteId } = requireTenantContext();
    const row = await ClassSession.findOne({ where: { instituteId, id }, include: sessionIncludes });
    if (!row) throw NotFound('Class session');
    await assertCanAccessClassSession(row);
    res.json(row);
  });

  /** Ad-hoc / extra class outside the recurring timetable. */
  r.post('/class-sessions', can('create'), async (req, res) => {
    const body = parse(classSessionBody, req.body);
    assertTimeRange(body.startTime, body.endTime);
    const batch = await repos.batches.findById(body.batchId);
    await assertTeachers([body.teacherUserId]);
    await assertSubject(body.subjectId);
    const row = await withSchedulingLock(async (t) => {
      await assertRoomFitsBatch(body.classroomId ?? null, batch, t);
      const slot = { ...body, classroomId: body.classroomId ?? null };
      await assertNoSessionConflict(slot, undefined, t);
      return repos.classSessions.create(
        { ...slot, branchId: batch.branchId, subjectId: body.subjectId ?? null, scheduleId: null },
        { transaction: t },
      );
    });
    await audit({
      action: 'class_session.created',
      entityType: 'ClassSession',
      entityId: row.id,
      metadata: { after: row.toJSON() },
    });
    res.status(201).json(row);
  });

  r.post('/class-sessions/:id/reschedule', can('edit'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    const body = parse(rescheduleBody, req.body);
    assertTimeRange(body.startTime, body.endTime);
    const session = await repos.classSessions.findById(id);
    if (session.status !== 'scheduled')
      throw Conflict(`Cannot reschedule a ${session.status} class`, 'INVALID_STATE');
    const before = session.toJSON();
    const batch = await repos.batches.findById(session.batchId);
    const classroomId = body.classroomId !== undefined ? body.classroomId : session.classroomId;
    await withSchedulingLock(async (t) => {
      await assertRoomFitsBatch(classroomId, batch, t);
      await assertNoSessionConflict(
        {
          date: body.date,
          startTime: body.startTime,
          endTime: body.endTime,
          teacherUserId: session.teacherUserId,
          classroomId,
          batchId: session.batchId,
        },
        id,
        t,
      );
      await session.update(
        {
          date: body.date,
          startTime: body.startTime,
          endTime: body.endTime,
          classroomId,
          rescheduledFrom: session.rescheduledFrom ?? `${before.date} ${before.startTime}-${before.endTime}`,
          cancelReason: body.reason ?? null,
        },
        { transaction: t },
      );
    });
    await audit({
      action: 'class_session.rescheduled',
      entityType: 'ClassSession',
      entityId: id,
      metadata: { before, after: session.toJSON() },
    });
    await notifyClassChanged({ classSessionId: id, change: 'rescheduled' });
    res.json(session);
  });

  r.post('/class-sessions/:id/cancel', can('edit'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    const body = parse(cancelBody, req.body);
    const session = await repos.classSessions.findById(id);
    if (session.status !== 'scheduled')
      throw Conflict(`Cannot cancel a ${session.status} class`, 'INVALID_STATE');
    const before = session.toJSON();
    await session.update({ status: 'cancelled', cancelReason: body.reason });
    await audit({
      action: 'class_session.cancelled',
      entityType: 'ClassSession',
      entityId: id,
      metadata: { before, after: session.toJSON() },
    });
    await notifyClassChanged({ classSessionId: id, change: 'cancelled' });
    res.json(session);
  });

  r.post('/class-sessions/:id/substitute', can('edit'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    const body = parse(substituteBody, req.body);
    const session = await repos.classSessions.findById(id);
    if (session.status !== 'scheduled')
      throw Conflict(`Cannot substitute on a ${session.status} class`, 'INVALID_STATE');
    if (session.teacherUserId === body.teacherUserId)
      throw BadRequest('Substitute must be a different teacher');
    await assertTeachers([body.teacherUserId]);
    const before = session.toJSON();
    await withSchedulingLock(async (t) => {
      await assertNoSessionConflict(
        {
          date: session.date,
          startTime: session.startTime,
          endTime: session.endTime,
          teacherUserId: body.teacherUserId,
          classroomId: session.classroomId,
          batchId: session.batchId,
        },
        id,
        t,
      );
      await session.update(
        {
          teacherUserId: body.teacherUserId,
          originalTeacherUserId: session.originalTeacherUserId ?? session.teacherUserId,
        },
        { transaction: t },
      );
    });
    await audit({
      action: 'class_session.substituted',
      entityType: 'ClassSession',
      entityId: id,
      metadata: { before, after: session.toJSON() },
    });
    await notifyClassChanged({ classSessionId: id, change: 'substituted' });
    res.json(session);
  });

  /** Record actual duration / completion. The class teacher or staff with academics.edit. */
  r.post('/class-sessions/:id/complete', can('view'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    const body = parse(completeBody, req.body);
    const session = await repos.classSessions.findById(id);
    assertTeacherOrStaff(session);
    res.json(await applyClassCompletion(session, body));
  });

  r.delete('/class-sessions/:id', can('delete'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    const session = await repos.classSessions.findById(id);
    if (session.status !== 'scheduled')
      throw Conflict('Only scheduled classes can be deleted; cancel instead', 'INVALID_STATE');
    if ((await repos.notes.count({ classSessionId: id })) > 0)
      throw Conflict('Class has notes; cancel it instead', 'CLASS_IN_USE');
    await session.destroy();
    await audit({
      action: 'class_session.deleted',
      entityType: 'ClassSession',
      entityId: id,
      metadata: { before: session.toJSON() },
    });
    res.status(204).end();
  });

  /* ---------------- notes / homework / comments ---------------- */
  r.get('/class-sessions/:id/notes', notes('view'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    const { instituteId } = requireTenantContext();
    const session = await ClassSession.findOne({ where: { instituteId, id } });
    if (!session) throw NotFound('Class session');
    await assertCanAccessClassSession(session);
    const rows = await repos.notes.findAll({
      where: { classSessionId: id },
      include: noteIncludes,
      order: [
        ['id', 'ASC'],
        [{ model: ClassNoteComment, as: 'comments' }, 'id', 'ASC'],
      ],
    });
    res.json(await Promise.all(rows.map(serializeNote)));
  });

  r.post('/class-sessions/:id/notes', notes('create'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    const body = parse(noteBody, req.body);
    const session = await repos.classSessions.findById(id);
    assertTeacherOrStaff(session);
    const note = await repos.notes.create({
      classSessionId: id,
      authorUserId: getContext().userId!,
      kind: body.kind,
      title: body.title,
      body: body.body ?? null,
      dueDate: body.dueDate ?? null,
    });
    if (body.fileIds?.length) await attachFiles(note.id, body.fileIds);
    await audit({
      action: 'class_note.created',
      entityType: 'ClassNote',
      entityId: note.id,
      metadata: { after: note.toJSON(), fileIds: body.fileIds },
    });
    res.status(201).json(await serializeNote(await repos.notes.findById(note.id, { include: noteIncludes })));
  });

  r.patch('/class-notes/:id', notes('edit'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    const body = parse(notePatch, req.body);
    const { note } = await loadNoteWithSession(id);
    if (note.authorUserId !== getContext().userId && !hasPermission('academics.edit'))
      throw Forbidden('Only the author can edit this note', 'NOT_AUTHOR');
    if (body.dueDate && note.kind !== 'homework') throw BadRequest('Only homework can have a due date');
    const before = note.toJSON();
    const { fileIds, ...fields } = body;
    await note.update(fields);
    if (fileIds) {
      const { instituteId } = requireTenantContext();
      await ClassNoteAttachment.destroy({ where: { instituteId, classNoteId: id } });
      await attachFiles(id, fileIds);
    }
    await audit({
      action: 'class_note.updated',
      entityType: 'ClassNote',
      entityId: id,
      metadata: { before, after: note.toJSON(), fileIds },
    });
    res.json(await serializeNote(await repos.notes.findById(id, { include: noteIncludes })));
  });

  r.delete('/class-notes/:id', notes('delete'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    const { note } = await loadNoteWithSession(id);
    if (note.authorUserId !== getContext().userId && !hasPermission('academics.edit'))
      throw Forbidden('Only the author can delete this note', 'NOT_AUTHOR');
    await note.destroy();
    await audit({
      action: 'class_note.deleted',
      entityType: 'ClassNote',
      entityId: id,
      metadata: { before: note.toJSON() },
    });
    res.status(204).end();
  });

  r.post('/class-notes/:id/comments', notes('view'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    const body = parse(commentBody, req.body);
    const { session } = await loadNoteWithSession(id);
    await assertCanAccessClassSession(session);
    const row = await repos.noteComments.create({
      classNoteId: id,
      userId: getContext().userId!,
      body: body.body,
    });
    await audit({
      action: 'class_note.commented',
      entityType: 'ClassNoteComment',
      entityId: row.id,
      metadata: { classNoteId: id },
    });
    res.status(201).json(row);
  });

  r.delete('/class-note-comments/:id', notes('view'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    const row = await repos.noteComments.findById(id);
    if (row.userId !== getContext().userId && !hasPermission('class-notes.delete'))
      throw Forbidden('Only the author can delete this comment', 'NOT_AUTHOR');
    await row.destroy();
    await audit({
      action: 'class_note_comment.deleted',
      entityType: 'ClassNoteComment',
      entityId: id,
      metadata: { before: row.toJSON() },
    });
    res.status(204).end();
  });
}
