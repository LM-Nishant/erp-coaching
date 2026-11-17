import fs from 'node:fs';
import { Router } from 'express';
import { parse } from '../../shared/utilities/validation';
import { authenticate } from '../../shared/middleware/authenticate';
import { requirePermission, requireTenant } from '../../shared/middleware/authorize';
import { requireTenantContext } from '../../shared/context';
import { Forbidden, NotFound } from '../../shared/errors';
import { uploadMiddleware } from '../files/files.routes';
import { Student } from './models';
import {
  buildProfile,
  documentsOf,
  studentFieldsSchema,
  toStudentDto,
  updateStudent,
} from './students.service';
import { uploadStudentDocument } from './students.routes';

/** The signed-in user's own student record in the current institute. */
export async function myStudent(): Promise<Student> {
  const { instituteId, userId } = requireTenantContext();
  const student = userId ? await Student.findOne({ where: { instituteId, userId } }) : null;
  if (!student) throw NotFound('Student profile');
  return student;
}

/** Suspended / inactive students keep read access but cannot change anything. */
function assertCanEdit(student: Student) {
  if (student.status === 'suspended' || student.status === 'inactive')
    throw Forbidden(`Your account is ${student.status}`, 'STUDENT_NOT_ACTIVE');
}

const selfEditable = studentFieldsSchema
  .pick({
    email: true,
    dateOfBirth: true,
    gender: true,
    address: true,
    city: true,
    state: true,
    pincode: true,
    academicInfo: true,
  })
  .strict();

export function studentPortalRoutes(api: Router) {
  const r = Router();
  r.use(authenticate, requireTenant);

  r.get('/me', requirePermission('student-portal', 'view'), async (_req, res) => {
    const profile = await buildProfile(await myStudent());
    // Internal audit trail stays staff-only.
    res.json({ ...profile, history: [] });
  });

  r.patch('/me', requirePermission('student-portal', 'edit'), async (req, res) => {
    const student = await myStudent();
    assertCanEdit(student);
    const body = parse(selfEditable, req.body);
    res.json(toStudentDto(await updateStudent(student.id, body)));
  });

  r.get('/me/documents', requirePermission('student-portal', 'view'), async (_req, res) => {
    res.json(await documentsOf((await myStudent()).id));
  });

  r.post('/me/documents', requirePermission('student-portal', 'edit'), uploadMiddleware, async (req, res) => {
    let student: Student;
    try {
      student = await myStudent();
      assertCanEdit(student);
    } catch (err) {
      if (req.file) await fs.promises.rm(req.file.path, { force: true });
      throw err;
    }
    res.status(201).json(await uploadStudentDocument(req, student));
  });

  api.use('/student-portal', r);
}
