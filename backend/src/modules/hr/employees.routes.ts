import { Router } from 'express';
import { Op, type Model, type ModelStatic } from 'sequelize';
import { z } from 'zod';
import { EMPLOYEE_STATUSES, EMPLOYMENT_TYPES } from '@erp/shared';
import { parse } from '../../shared/utilities/validation';
import { idParam, paginated, paginationSchema, toLimitOffset } from '../../shared/utilities/pagination';
import { requirePermission } from '../../shared/middleware/authorize';
import { requireTenantContext } from '../../shared/context';
import { BadRequest, Conflict } from '../../shared/errors';
import { audit } from '../../shared/audit/audit.service';
import { TenantRepository } from '../../shared/tenancy/tenant-repository';
import { getSequelize } from '../../infrastructure/database/sequelize';
import { User } from '../users/user.model';
import { Role, UserRole } from '../permissions/models';
import { memberVisibilityWhere } from '../permissions/access.service';
import { uploadMiddleware } from '../files/files.routes';
import { deleteFile, saveUploadedFile, signedUrlFor } from '../files/files.service';
import { FileObject } from '../files/file.model';
import {
  Employee,
  EmployeeAssignment,
  EmployeeDocument,
  EmployeeExperience,
  EmployeeQualification,
  EmploymentContract,
  Shift,
} from './models';
import {
  assertBranchInInstitute,
  assertTeacherSeat,
  employeeRepo,
  nextEmployeeCode,
  shiftRepo,
} from './hr.service';
import { isoDate } from './dates';

const date = z.string().regex(isoDate, 'Use YYYY-MM-DD');
const optStr = (max: number) => z.string().trim().max(max).nullable().optional();

const employeeBody = z.object({
  branchId: z.number().int().positive().nullable().optional(),
  userId: z.number().int().positive().nullable().optional(),
  employeeCode: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9-/]{2,30}$/)
    .optional(),
  name: z.string().trim().min(2).max(150).optional(),
  email: z.string().email().nullable().optional(),
  mobile: optStr(20),
  designation: optStr(100),
  department: optStr(100),
  employmentType: z.enum(EMPLOYMENT_TYPES).optional(),
  isTeacher: z.boolean().optional(),
  dateOfJoining: date,
  dateOfBirth: date.nullable().optional(),
  gender: optStr(20),
  address: optStr(1000),
  pan: optStr(20),
  uan: optStr(20),
  esiNumber: optStr(30),
  bankAccountName: optStr(150),
  bankAccountNumber: optStr(40),
  bankIfsc: optStr(20),
  shiftId: z.number().int().positive().nullable().optional(),
  biometricEnrolmentId: optStr(50),
  status: z.enum(EMPLOYEE_STATUSES).optional(),
  notes: optStr(2000),
});
type EmployeeBody = Partial<z.infer<typeof employeeBody>>;

async function validateEmployeeRefs(body: EmployeeBody, selfId?: number) {
  const { instituteId } = requireTenantContext();
  await assertBranchInInstitute(body.branchId);
  if (body.shiftId) await shiftRepo.findById(body.shiftId);
  if (body.userId) {
    if (!(await UserRole.count({ where: { instituteId, userId: body.userId } })))
      throw BadRequest('User is not a member of this institute');
    const linked = await Employee.findOne({ where: { instituteId, userId: body.userId } });
    if (linked && linked.id !== selfId) throw Conflict('User is already linked to another employee');
  }
  if (body.employeeCode) {
    const dup = await Employee.findOne({ where: { instituteId, employeeCode: body.employeeCode } });
    if (dup && dup.id !== selfId) throw Conflict('Employee code already in use', 'DUPLICATE_CODE');
  }
  if (body.biometricEnrolmentId) {
    const dup = await Employee.findOne({
      where: { instituteId, biometricEnrolmentId: body.biometricEnrolmentId },
    });
    if (dup && dup.id !== selfId) throw Conflict('Biometric enrolment id already in use');
  }
}

/**
 * Registers list/create/update/delete routes for a per-employee child table under
 * `/employees/:id/<path>`. The employee is loaded through the branch-scoped repository first.
 */
function childRoutes<M extends Model>(
  r: Router,
  path: string,
  model: ModelStatic<M>,
  entity: string,
  schema: z.ZodObject,
  hooks: { validate?: (b: Record<string, unknown>) => Promise<void> } = {},
) {
  const repo = new TenantRepository(model, { entity });
  const childParams = z.object({
    id: z.coerce.number().int().positive(),
    childId: z.coerce.number().int().positive(),
  });
  const action = `hr.${path}`;

  r.get(`/employees/:id/${path}`, requirePermission('hr', 'view'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    await employeeRepo.findById(id);
    res.json(await repo.findAll({ where: { employeeId: id } as never, order: [['id', 'ASC']] }));
  });

  r.post(`/employees/:id/${path}`, requirePermission('hr', 'edit'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    await employeeRepo.findById(id);
    const body = parse(schema, req.body) as Record<string, unknown>;
    await hooks.validate?.(body);
    const row = await repo.create({ ...body, employeeId: id } as never);
    await audit({
      action: `${action}.created`,
      entityType: entity,
      entityId: row.get('id') as number,
      metadata: { after: row.toJSON() },
    });
    res.status(201).json(row);
  });

  r.patch(`/employees/:id/${path}/:childId`, requirePermission('hr', 'edit'), async (req, res) => {
    const { id, childId } = parse(childParams, req.params);
    await employeeRepo.findById(id);
    const body = parse(schema.partial(), req.body) as Record<string, unknown>;
    await hooks.validate?.(body);
    const row = await repo.findById(childId, { where: { employeeId: id } as never });
    const before = row.toJSON();
    await row.update(body as never);
    await audit({
      action: `${action}.updated`,
      entityType: entity,
      entityId: childId,
      metadata: { before, after: row.toJSON() },
    });
    res.json(row);
  });

  r.delete(`/employees/:id/${path}/:childId`, requirePermission('hr', 'edit'), async (req, res) => {
    const { id, childId } = parse(childParams, req.params);
    await employeeRepo.findById(id);
    const row = await repo.findById(childId, { where: { employeeId: id } as never });
    const before = row.toJSON();
    await row.destroy();
    await audit({ action: `${action}.deleted`, entityType: entity, entityId: childId, metadata: { before } });
    res.status(204).end();
  });
}

export function employeeRoutes(r: Router) {
  r.get('/employees', requirePermission('hr', 'view'), async (req, res) => {
    const q = parse(
      paginationSchema.extend({
        status: z.enum(EMPLOYEE_STATUSES).optional(),
        branchId: z.coerce.number().int().positive().optional(),
        isTeacher: z.enum(['true', 'false']).optional(),
      }),
      req.query,
    );
    const where: Record<string | symbol, unknown> = {};
    if (q.status) where.status = q.status;
    if (q.branchId) where.branchId = q.branchId;
    if (q.isTeacher) where.isTeacher = q.isTeacher === 'true';
    if (q.search)
      where[Op.or] = ['name', 'employeeCode', 'mobile', 'designation'].map((f) => ({
        [f]: { [Op.like]: `%${q.search}%` },
      }));
    const { rows, count } = await employeeRepo.findAndCountAll({
      where,
      order: [['name', 'ASC']],
      ...toLimitOffset(q),
    });
    res.json(paginated(rows, count, q));
  });

  /** Institute members not yet linked to an employee (teachers are employees). */
  r.get('/employees/candidates', requirePermission('hr', 'create'), async (req, res) => {
    const q = parse(z.object({ search: z.string().trim().max(100).optional() }), req.query);
    const { instituteId } = requireTenantContext();
    const search = q.search
      ? { [Op.or]: [{ name: { [Op.like]: `%${q.search}%` } }, { mobile: { [Op.like]: `%${q.search}%` } }] }
      : undefined;
    const visible = memberVisibilityWhere();
    const linked = (
      await Employee.findAll({ where: { instituteId, userId: { [Op.ne]: null } }, attributes: ['userId'] })
    ).map((e) => e.userId!);
    const memberships = await UserRole.findAll({
      where: { instituteId, ...(linked.length ? { userId: { [Op.notIn]: linked } } : {}) },
      include: [
        {
          model: User,
          as: 'user',
          where: search && visible ? { [Op.and]: [search, visible] } : (search ?? visible),
        },
        { model: Role, as: 'role' },
      ],
      limit: 200,
    });
    const byUser = new Map<
      number,
      { id: number; name: string; mobile: string; email: string | null; roles: string[] }
    >();
    for (const m of memberships) {
      if (!m.user || m.role?.slug === 'student' || m.role?.slug === 'parent') continue;
      const u = byUser.get(m.userId) ?? {
        id: m.userId,
        name: m.user.name,
        mobile: m.user.mobile,
        email: m.user.email,
        roles: [],
      };
      if (m.role) u.roles.push(m.role.slug);
      byUser.set(m.userId, u);
    }
    res.json([...byUser.values()]);
  });

  r.get('/employees/:id', requirePermission('hr', 'view'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    res.json(await employeeRepo.findById(id, { include: [{ model: Shift, as: 'shift' }] }));
  });

  r.post('/employees', requirePermission('hr', 'create'), async (req, res) => {
    const body = parse(employeeBody, req.body);
    await validateEmployeeRefs(body);
    let { name, mobile, email, isTeacher } = body;
    if (body.userId) {
      const user = (await User.findByPk(body.userId))!;
      name ??= user.name;
      mobile ??= user.mobile;
      email ??= user.email;
      if (isTeacher === undefined) {
        const { instituteId } = requireTenantContext();
        const roles = await UserRole.findAll({
          where: { instituteId, userId: body.userId },
          include: [{ model: Role, as: 'role' }],
        });
        isTeacher = roles.some((r) => r.role?.slug === 'teacher');
      }
    }
    if (!name) throw BadRequest('name is required');
    if (isTeacher && (body.status ?? 'active') !== 'exited') await assertTeacherSeat();
    const emp = await employeeRepo.create({
      ...body,
      branchId: body.branchId ?? null,
      userId: body.userId ?? null,
      employeeCode: body.employeeCode ?? (await nextEmployeeCode()),
      name,
      mobile: mobile ?? null,
      email: email ?? null,
      isTeacher: isTeacher ?? false,
      designation: body.designation ?? null,
      department: body.department ?? null,
      dateOfBirth: body.dateOfBirth ?? null,
      dateOfExit: null,
      gender: body.gender ?? null,
      address: body.address ?? null,
      pan: body.pan ?? null,
      uan: body.uan ?? null,
      esiNumber: body.esiNumber ?? null,
      bankAccountName: body.bankAccountName ?? null,
      bankAccountNumber: body.bankAccountNumber ?? null,
      bankIfsc: body.bankIfsc ?? null,
      shiftId: body.shiftId ?? null,
      biometricEnrolmentId: body.biometricEnrolmentId ?? null,
      notes: body.notes ?? null,
    });
    await audit({
      action: 'hr.employee.created',
      entityType: 'Employee',
      entityId: emp.id,
      metadata: { after: emp.toJSON() },
    });
    res.status(201).json(emp);
  });

  r.patch('/employees/:id', requirePermission('hr', 'edit'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    const body = parse(employeeBody.partial(), req.body);
    await validateEmployeeRefs(body, id);
    const before = (await employeeRepo.findById(id)).toJSON();
    const willTeach = (body.isTeacher ?? before.isTeacher) && (body.status ?? before.status) !== 'exited';
    const taughtBefore = before.isTeacher && before.status !== 'exited';
    if (willTeach && !taughtBefore) await assertTeacherSeat(id);
    const emp = await employeeRepo.update(id, body);
    await audit({
      action: 'hr.employee.updated',
      entityType: 'Employee',
      entityId: id,
      metadata: { before, after: emp.toJSON() },
    });
    res.json(emp);
  });

  r.delete('/employees/:id', requirePermission('hr', 'delete'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    const emp = await employeeRepo.findById(id);
    const before = emp.toJSON();
    const docs = await EmployeeDocument.findAll({ where: { instituteId: emp.instituteId, employeeId: id } });
    try {
      await getSequelize().transaction(async (transaction) => {
        await EmployeeDocument.destroy({
          where: { instituteId: emp.instituteId, employeeId: id },
          transaction,
        });
        await emp.destroy({ transaction });
      });
    } catch (err) {
      if ((err as Error).name === 'SequelizeForeignKeyConstraintError')
        throw Conflict('Employee has payroll history; mark them as exited instead', 'EMPLOYEE_IN_USE');
      throw err;
    }
    for (const d of docs) await deleteFile(d.fileId);
    await audit({
      action: 'hr.employee.deleted',
      entityType: 'Employee',
      entityId: id,
      metadata: { before },
    });
    res.status(204).end();
  });

  childRoutes(
    r,
    'qualifications',
    EmployeeQualification,
    'Qualification',
    z.object({
      degree: z.string().trim().min(1).max(150),
      institution: optStr(200),
      yearOfPassing: z.number().int().min(1950).max(2100).nullable().optional(),
      grade: optStr(30),
    }),
  );
  childRoutes(
    r,
    'experiences',
    EmployeeExperience,
    'Experience',
    z.object({
      organisation: z.string().trim().min(1).max(200),
      role: optStr(150),
      fromDate: date.nullable().optional(),
      toDate: date.nullable().optional(),
      notes: optStr(2000),
    }),
  );
  childRoutes(
    r,
    'assignments',
    EmployeeAssignment,
    'Assignment',
    z.object({
      branchId: z.number().int().positive(),
      role: z.string().trim().min(1).max(100),
      referenceType: optStr(40),
      referenceId: z.number().int().positive().nullable().optional(),
      fromDate: date.nullable().optional(),
      toDate: date.nullable().optional(),
    }),
    { validate: (b) => assertBranchInInstitute(b.branchId as number | undefined) },
  );
  childRoutes(
    r,
    'contracts',
    EmploymentContract,
    'Contract',
    z.object({
      contractType: z.string().trim().min(1).max(30),
      startDate: date,
      endDate: date.nullable().optional(),
      probationMonths: z.number().int().min(0).max(36).nullable().optional(),
      noticePeriodDays: z.number().int().min(0).max(365).optional(),
      terms: optStr(10000),
      status: z.enum(['draft', 'active', 'expired', 'terminated']).optional(),
    }),
  );

  // Documents: multipart upload stored through the platform storage service (local disk today).
  const docRepo = new TenantRepository(EmployeeDocument, { entity: 'Document' });
  r.get('/employees/:id/documents', requirePermission('hr', 'view'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    await employeeRepo.findById(id);
    const docs = await docRepo.findAll({
      where: { employeeId: id },
      include: [{ model: FileObject, as: 'file' }],
      order: [['id', 'DESC']],
    });
    res.json(
      docs.map((d) => ({
        id: d.id,
        employeeId: d.employeeId,
        docType: d.docType,
        title: d.title,
        createdAt: d.createdAt,
        file: d.file ? { ...d.file.toDto(), ...signedUrlFor(d.file) } : null,
      })),
    );
  });

  r.post('/employees/:id/documents', requirePermission('hr', 'edit'), uploadMiddleware, async (req, res) => {
    const { id } = parse(idParam, req.params);
    const emp = await employeeRepo.findById(id);
    if (!req.file) throw BadRequest('Attach a file in the `file` field');
    const body = parse(
      z.object({
        docType: z.string().trim().min(1).max(50).default('other'),
        title: z.string().trim().max(200).optional(),
      }),
      req.body,
    );
    const file = await saveUploadedFile({
      tempPath: req.file.path,
      originalName: req.file.originalname,
      mimeType: req.file.mimetype,
      sizeBytes: req.file.size,
      module: 'hr',
      branchId: emp.branchId,
    });
    const doc = await docRepo.create({
      employeeId: id,
      fileId: file.id,
      docType: body.docType,
      title: body.title || file.originalName,
    });
    await audit({
      action: 'hr.document.created',
      entityType: 'EmployeeDocument',
      entityId: doc.id,
      metadata: { employeeId: id, fileId: file.id },
    });
    res.status(201).json({ ...doc.toJSON(), file: { ...file.toDto(), ...signedUrlFor(file) } });
  });

  r.delete('/employees/:id/documents/:docId', requirePermission('hr', 'edit'), async (req, res) => {
    const { id, docId } = parse(
      z.object({ id: z.coerce.number().int().positive(), docId: z.coerce.number().int().positive() }),
      req.params,
    );
    await employeeRepo.findById(id);
    const doc = await docRepo.findById(docId, { where: { employeeId: id } });
    await doc.destroy();
    await deleteFile(doc.fileId);
    await audit({
      action: 'hr.document.deleted',
      entityType: 'EmployeeDocument',
      entityId: docId,
      metadata: { before: doc.toJSON() },
    });
    res.status(204).end();
  });
}
