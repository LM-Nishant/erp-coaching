import fs from 'node:fs';
import { Router, type Request } from 'express';
import { Op, type WhereOptions } from 'sequelize';
import { z } from 'zod';
import { STUDENT_STATUSES } from '@erp/shared';
import { parse } from '../../shared/utilities/validation';
import { idParam, paginated, paginationSchema, toLimitOffset } from '../../shared/utilities/pagination';
import { authenticate } from '../../shared/middleware/authenticate';
import { requireModule, requirePermission, requireTenant } from '../../shared/middleware/authorize';
import { requireTenantContext } from '../../shared/context';
import { BadRequest, NotFound } from '../../shared/errors';
import { audit } from '../../shared/audit/audit.service';
import { uploadMiddleware } from '../files/files.routes';
import { deleteFile, saveUploadedFile } from '../files/files.service';
import { Student, StudentAcademicRecord } from './models';
import {
  addDocument,
  buildProfile,
  changeStatus,
  createStudent,
  deleteStudent,
  findDocument,
  findDuplicates,
  recordHistory,
  studentFieldsSchema,
  studentRepo,
  toRecordDto,
  toStudentDto,
  transferStudent,
  updateStudent,
} from './students.service';
import { getStudentSettings, saveStudentSettings, studentSettingsSchema } from './settings';

const listQuery = paginationSchema.extend({
  status: z.enum(STUDENT_STATUSES).optional(),
  branchId: z.coerce.number().int().positive().optional(),
});

const createBody = studentFieldsSchema.extend({
  allowDuplicate: z.boolean().optional(),
  password: z.string().min(8).max(200).optional(),
});

const recordBody = z.object({
  academicYear: z.string().trim().max(20).nullable().optional(),
  institution: z.string().trim().max(150).nullable().optional(),
  classGrade: z.string().trim().max(40).nullable().optional(),
  board: z.string().trim().max(60).nullable().optional(),
  result: z.string().trim().max(60).nullable().optional(),
  percentage: z.number().min(0).max(100).nullable().optional(),
  remarks: z.string().trim().max(255).nullable().optional(),
});

const documentBody = z.object({
  docType: z
    .string()
    .trim()
    .regex(/^[a-z0-9_]{2,40}$/)
    .default('other'),
  title: z.string().trim().max(150).optional(),
});

const subId = (name: string) =>
  z.object({ id: z.coerce.number().int().positive(), [name]: z.coerce.number().int().positive() });

/**
 * Saves the multipart `file` as a document of `student`. Shared by the admin and student-portal
 * routes; the caller has already authorised access to the student.
 */
export async function uploadStudentDocument(req: Request, student: Student) {
  if (!req.file) throw BadRequest('Attach a file in the `file` field (blocked types are rejected)');
  let body: z.infer<typeof documentBody>;
  try {
    body = parse(documentBody, req.body);
  } catch (err) {
    await fs.promises.rm(req.file.path, { force: true });
    throw err;
  }
  const file = await saveUploadedFile({
    tempPath: req.file.path,
    originalName: req.file.originalname,
    mimeType: req.file.mimetype,
    sizeBytes: req.file.size,
    module: 'students',
    branchId: student.branchId,
  });
  const doc = await addDocument(student.id, file, { docType: body.docType, title: body.title ?? null });
  await audit({
    action: 'student.document_added',
    entityType: 'student',
    entityId: student.id,
    branchId: student.branchId,
    metadata: { documentId: doc.id, docType: doc.docType },
  });
  return doc;
}

export function studentRoutes(api: Router) {
  const r = Router();
  r.use(authenticate, requireTenant, requireModule('students'));

  r.get('/settings', requirePermission('students', 'view'), async (_req, res) => {
    res.json(await getStudentSettings());
  });

  r.put('/settings', requirePermission('students', 'configure'), async (req, res) => {
    const body = parse(studentSettingsSchema.partial(), req.body);
    const settings = await saveStudentSettings(body);
    await audit({ action: 'students.settings_changed', metadata: { fields: Object.keys(body) } });
    res.json(settings);
  });

  r.get('/duplicates', requirePermission('students', 'view'), async (req, res) => {
    const q = parse(
      z.object({
        mobile: z.string().trim().max(20).optional(),
        email: z.string().trim().max(150).optional(),
        idNumber: z.string().trim().max(60).optional(),
        excludeStudentId: z.coerce.number().int().positive().optional(),
      }),
      req.query,
    );
    res.json(await findDuplicates(q, { excludeStudentId: q.excludeStudentId }));
  });

  r.get('/', requirePermission('students', 'view'), async (req, res) => {
    const q = parse(listQuery, req.query);
    const where: WhereOptions<Student> = {};
    if (q.status) Object.assign(where, { status: q.status });
    if (q.branchId) Object.assign(where, { branchId: q.branchId });
    if (q.search) {
      const like = `%${q.search}%`;
      Object.assign(where, {
        [Op.or]: [
          { name: { [Op.like]: like } },
          { mobile: { [Op.like]: like } },
          { email: { [Op.like]: like } },
          { admissionNumber: { [Op.like]: like } },
          { rollNumber: { [Op.like]: like } },
        ],
      });
    }
    const { rows, count } = await studentRepo.findAndCountAll({
      where,
      order: [['id', 'DESC']],
      ...toLimitOffset(q),
    });
    res.json(paginated(rows.map(toStudentDto), count, q));
  });

  r.post('/', requirePermission('students', 'create'), async (req, res) => {
    const { allowDuplicate, password, ...fields } = parse(createBody, req.body);
    const student = await createStudent(fields, { source: 'admin', allowDuplicate, password });
    res.status(201).json(toStudentDto(student));
  });

  r.get('/:id', requirePermission('students', 'view'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    res.json(await buildProfile(await studentRepo.findById(id)));
  });

  r.patch('/:id', requirePermission('students', 'edit'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    const body = parse(studentFieldsSchema.partial(), req.body);
    res.json(toStudentDto(await updateStudent(id, body)));
  });

  r.delete('/:id', requirePermission('students', 'delete'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    await deleteStudent(id);
    res.status(204).end();
  });

  r.patch('/:id/status', requirePermission('students', 'edit'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    const body = parse(
      z.object({
        status: z.enum(STUDENT_STATUSES),
        reason: z.string().trim().max(255).nullable().optional(),
      }),
      req.body,
    );
    res.json(toStudentDto(await changeStatus(id, body.status, body.reason ?? null)));
  });

  r.post('/:id/transfer', requirePermission('students', 'edit'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    const body = parse(
      z.object({
        branchId: z.number().int().positive(),
        reason: z.string().trim().max(255).nullable().optional(),
        regenerateRollNumber: z.boolean().optional(),
      }),
      req.body,
    );
    res.json(toStudentDto(await transferStudent(id, body)));
  });

  // ---- academic history (previous schooling / results)
  r.post('/:id/academic-records', requirePermission('students', 'edit'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    const body = parse(recordBody, req.body);
    await studentRepo.findById(id);
    const { instituteId } = requireTenantContext();
    const rec = await StudentAcademicRecord.create({
      instituteId,
      studentId: id,
      academicYear: body.academicYear ?? null,
      institution: body.institution ?? null,
      classGrade: body.classGrade ?? null,
      board: body.board ?? null,
      result: body.result ?? null,
      percentage: body.percentage ?? null,
      remarks: body.remarks ?? null,
    });
    res.status(201).json(toRecordDto(rec));
  });

  r.patch('/:id/academic-records/:recordId', requirePermission('students', 'edit'), async (req, res) => {
    const { id, recordId } = parse(subId('recordId'), req.params);
    const body = parse(recordBody, req.body);
    await studentRepo.findById(id);
    const { instituteId } = requireTenantContext();
    const rec = await StudentAcademicRecord.findOne({ where: { instituteId, studentId: id, id: recordId } });
    if (!rec) throw NotFound('Academic record');
    await rec.update(body);
    res.json(toRecordDto(rec));
  });

  r.delete('/:id/academic-records/:recordId', requirePermission('students', 'edit'), async (req, res) => {
    const { id, recordId } = parse(subId('recordId'), req.params);
    await studentRepo.findById(id);
    const { instituteId } = requireTenantContext();
    const deleted = await StudentAcademicRecord.destroy({
      where: { instituteId, studentId: id, id: recordId },
    });
    if (!deleted) throw NotFound('Academic record');
    res.status(204).end();
  });

  // ---- documents (local-disk / S3 via the files storage adapter)
  r.post('/:id/documents', requirePermission('students', 'edit'), uploadMiddleware, async (req, res) => {
    const { id } = parse(idParam, req.params);
    let student: Student;
    try {
      student = await studentRepo.findById(id);
    } catch (err) {
      if (req.file) await fs.promises.rm(req.file.path, { force: true });
      throw err;
    }
    res.status(201).json(await uploadStudentDocument(req, student));
  });

  r.delete('/:id/documents/:documentId', requirePermission('students', 'edit'), async (req, res) => {
    const { id, documentId } = parse(subId('documentId'), req.params);
    await studentRepo.findById(id);
    const doc = await findDocument(id, documentId);
    await doc.destroy();
    await deleteFile(doc.fileId);
    await recordHistory(id, 'document_removed', { from: doc.docType, details: { fileId: doc.fileId } });
    await audit({
      action: 'student.document_removed',
      entityType: 'student',
      entityId: id,
      metadata: { documentId },
    });
    res.status(204).end();
  });

  api.use('/students', r);
}
