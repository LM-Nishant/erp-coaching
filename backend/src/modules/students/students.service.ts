import bcrypt from 'bcryptjs';
import { Op, type Transaction, type WhereOptions } from 'sequelize';
import { z } from 'zod';
import type {
  AcademicRecordDto,
  DuplicateMatch,
  StudentDocumentDto,
  StudentDto,
  StudentHistoryDto,
  StudentProfileDto,
  StudentSource,
  StudentStatus,
} from '@erp/shared';
import { GUARDIAN_RELATIONS, STUDENT_STATUSES } from '@erp/shared';
import { getSequelize } from '../../infrastructure/database/sequelize';
import { requireTenantContext } from '../../shared/context';
import { BadRequest, Conflict, NotFound } from '../../shared/errors';
import { TenantRepository } from '../../shared/tenancy/tenant-repository';
import { audit } from '../../shared/audit/audit.service';
import { assertWithinLimit } from '../subscriptions/subscription.service';
import { Branch } from '../branches/branch.model';
import { User } from '../users/user.model';
import { FileObject } from '../files/file.model';
import { signedUrlFor } from '../files/files.service';
import { Guardian, StudentGuardian } from '../guardians/models';
import { syncParentRoles, syncParentRolesForStudent } from '../guardians/guardian-access';
import { Enquiry, AdmissionApplication } from '../admissions/models';
import { Student, StudentAcademicRecord, StudentDocument, StudentHistory } from './models';
import { getStudentSettings } from './settings';
import { allocateNumber, ensureSequence, resolveNumberTarget, withLockRetry } from './numbering.service';
import { syncBranchRoles } from './membership';

export const studentRepo = new TenantRepository(Student, { entity: 'Student', branchScoped: true });

// ---------------------------------------------------------------- validation

export const mobileSchema = z
  .string()
  .trim()
  .regex(/^\+?\d{10,15}$/, 'Enter a valid mobile number');
const optStr = (max: number) => z.string().trim().max(max).nullable().optional();

export const academicInfoSchema = z
  .object({
    schoolName: optStr(150),
    classGrade: optStr(40),
    board: optStr(60),
    previousPercentage: z.number().min(0).max(100).nullable().optional(),
    targetExam: optStr(100),
  })
  .strict();

export const customFieldsSchema = z
  .record(
    z.string().regex(/^[a-z0-9_]{1,40}$/),
    z.union([z.string().max(2000), z.number(), z.boolean(), z.null()]),
  )
  .refine((v) => Object.keys(v).length <= 50, 'Too many custom fields');

export const studentFieldsSchema = z.object({
  name: z.string().trim().min(2).max(150),
  mobile: mobileSchema,
  email: z.string().trim().toLowerCase().email().max(150).nullable().optional(),
  branchId: z.number().int().positive().optional(),
  dateOfBirth: z.string().date().nullable().optional(),
  gender: z.enum(['male', 'female', 'other']).nullable().optional(),
  address: optStr(1000),
  city: optStr(80),
  state: optStr(80),
  pincode: optStr(12),
  idType: optStr(40),
  idNumber: optStr(60),
  academicInfo: academicInfoSchema.nullable().optional(),
  customFields: customFieldsSchema.nullable().optional(),
});
export type StudentFields = z.infer<typeof studentFieldsSchema>;

export const guardianRelationSchema = z.enum(GUARDIAN_RELATIONS);
export const statusSchema = z.enum(STUDENT_STATUSES);

// ---------------------------------------------------------------- DTOs

const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);

export function toStudentDto(s: Student): StudentDto {
  return {
    id: s.id,
    branchId: s.branchId,
    userId: s.userId,
    admissionNumber: s.admissionNumber,
    rollNumber: s.rollNumber ?? null,
    name: s.name,
    mobile: s.mobile,
    email: s.email ?? null,
    dateOfBirth: s.dateOfBirth ?? null,
    gender: s.gender ?? null,
    address: s.address ?? null,
    city: s.city ?? null,
    state: s.state ?? null,
    pincode: s.pincode ?? null,
    idType: s.idType ?? null,
    idNumber: s.idNumber ?? null,
    academicInfo: s.academicInfo ?? null,
    customFields: s.customFields ?? null,
    status: s.status,
    statusReason: s.statusReason ?? null,
    source: s.source,
    admittedAt: iso(s.admittedAt)!,
    createdAt: iso(s.createdAt)!,
  };
}

function toHistoryDto(h: StudentHistory): StudentHistoryDto {
  return {
    id: h.id,
    eventType: h.eventType,
    fromValue: h.fromValue,
    toValue: h.toValue,
    details: h.details,
    actorUserId: h.actorUserId,
    createdAt: iso(h.createdAt)!,
  };
}

export function toRecordDto(r: StudentAcademicRecord): AcademicRecordDto {
  return {
    id: r.id,
    academicYear: r.academicYear,
    institution: r.institution,
    classGrade: r.classGrade,
    board: r.board,
    result: r.result,
    percentage: r.percentage,
    remarks: r.remarks,
  };
}

export function toDocumentDto(d: StudentDocument): StudentDocumentDto {
  return {
    id: d.id,
    docType: d.docType,
    title: d.title,
    fileId: d.fileId,
    originalName: d.file?.originalName ?? '',
    mimeType: d.file?.mimeType ?? 'application/octet-stream',
    url: d.file ? signedUrlFor(d.file).url : '',
    createdAt: iso(d.createdAt)!,
  };
}

// ---------------------------------------------------------------- history

export async function recordHistory(
  studentId: number,
  eventType: string,
  values: { from?: string | null; to?: string | null; details?: Record<string, unknown> | null } = {},
  transaction?: Transaction,
) {
  const { instituteId, userId } = requireTenantContext();
  await StudentHistory.create(
    {
      instituteId,
      studentId,
      eventType,
      fromValue: values.from?.slice(0, 150) ?? null,
      toValue: values.to?.slice(0, 150) ?? null,
      details: values.details ?? null,
      actorUserId: userId ?? null,
    },
    { transaction },
  );
}

// ---------------------------------------------------------------- duplicates

export interface DuplicateQuery {
  mobile?: string | null;
  email?: string | null;
  idNumber?: string | null;
}

/**
 * Finds existing students, open enquiries and open applications that share a mobile, email or
 * identifier. Institute-wide on purpose: the same person enquiring at two branches is a duplicate.
 */
export async function findDuplicates(
  q: DuplicateQuery,
  opts: { excludeStudentId?: number; kinds?: DuplicateMatch['kind'][] } = {},
): Promise<DuplicateMatch[]> {
  const { instituteId } = requireTenantContext();
  const kinds = opts.kinds ?? ['student', 'enquiry', 'application'];
  const email = q.email?.trim().toLowerCase() || null;
  const idNumber = q.idNumber?.trim() || null;
  const mobile = q.mobile?.trim() || null;
  const matchedOn = (row: { mobile: string; email: string | null; idNumber?: string | null }) => {
    const on: DuplicateMatch['matchedOn'] = [];
    if (mobile && row.mobile === mobile) on.push('mobile');
    if (email && row.email?.toLowerCase() === email) on.push('email');
    if (idNumber && row.idNumber === idNumber) on.push('idNumber');
    return on;
  };
  const contact: WhereOptions[] = [];
  if (mobile) contact.push({ mobile });
  if (email) contact.push({ email });
  const matches: DuplicateMatch[] = [];

  if (kinds.includes('student') && (contact.length || idNumber)) {
    const students = await Student.findAll({
      where: {
        instituteId,
        [Op.or]: [...contact, ...(idNumber ? [{ idNumber }] : [])],
        ...(opts.excludeStudentId ? { id: { [Op.ne]: opts.excludeStudentId } } : {}),
      },
      limit: 20,
    });
    for (const s of students)
      matches.push({
        kind: 'student',
        id: s.id,
        name: s.name,
        mobile: s.mobile,
        reference: s.admissionNumber,
        matchedOn: matchedOn(s),
      });
  }
  if (kinds.includes('enquiry') && contact.length) {
    const enquiries = await Enquiry.findAll({
      where: {
        instituteId,
        [Op.or]: contact,
        status: { [Op.notIn]: ['converted', 'lost', 'not_interested'] },
      },
      limit: 20,
    });
    for (const e of enquiries)
      matches.push({
        kind: 'enquiry',
        id: e.id,
        name: e.name,
        mobile: e.mobile,
        reference: null,
        matchedOn: matchedOn(e),
      });
  }
  if (kinds.includes('application') && contact.length) {
    const apps = await AdmissionApplication.findAll({
      where: { instituteId, [Op.or]: contact, status: { [Op.in]: ['pending', 'waitlisted', 'approved'] } },
      limit: 20,
    });
    for (const a of apps)
      matches.push({
        kind: 'application',
        id: a.id,
        name: a.name,
        mobile: a.mobile,
        reference: null,
        matchedOn: matchedOn(a),
      });
  }
  return matches;
}

// ---------------------------------------------------------------- branches

/** Resolves the branch for a new student and checks it is active and accessible. */
export async function resolveBranch(requested?: number | null): Promise<Branch> {
  const { instituteId, activeBranchId } = requireTenantContext();
  const settings = await getStudentSettings();
  const candidate = requested ?? activeBranchId ?? settings.defaultBranchId ?? null;
  const branch = candidate
    ? await Branch.findOne({ where: { instituteId, id: candidate, status: 'active' } })
    : await Branch.findOne({ where: { instituteId, status: 'active' }, order: [['id', 'ASC']] });
  if (!branch) throw BadRequest('Select a valid, active branch');
  studentRepo.assertBranchAllowed(branch.id);
  return branch;
}

// ---------------------------------------------------------------- user accounts

/**
 * Finds the global user for a mobile or creates one. The email is only stored on a new account
 * when no other account already uses it (emails are globally unique).
 */
export async function findOrCreateUser(
  input: { name: string; mobile: string; email?: string | null; password?: string | null },
  transaction?: Transaction,
): Promise<{ user: User; created: boolean }> {
  const existing = await User.findOne({ where: { mobile: input.mobile }, transaction });
  if (existing) return { user: existing, created: false };
  const emailTaken = input.email ? await User.count({ where: { email: input.email }, transaction }) : 0;
  const user = await User.create(
    {
      name: input.name,
      mobile: input.mobile,
      email: input.email && !emailTaken ? input.email : null,
      passwordHash: input.password ? await bcrypt.hash(input.password, 10) : null,
      lastLoginAt: null,
    },
    { transaction },
  );
  return { user, created: true };
}

// ---------------------------------------------------------------- create

export interface CreateStudentOptions {
  source: StudentSource;
  /** Skip the duplicate block (siblings sharing a phone). Duplicates get no login account. */
  allowDuplicate?: boolean;
  /** Password for a newly created login account. */
  password?: string | null;
  /** Use this user as the login account (self-registration after verifying the password). */
  userId?: number | null;
  /** Extra writes in the same transaction (e.g. mark the enquiry converted). */
  afterCreate?: (student: Student, transaction: Transaction) => Promise<void>;
}

export async function activeStudentCount(): Promise<number> {
  const { instituteId } = requireTenantContext();
  return Student.count({ where: { instituteId, status: { [Op.in]: ['active', 'suspended'] } } });
}

/**
 * Admits a student: duplicate check, plan limit, concurrency-safe admission/roll numbers,
 * a Student-role login (branch-scoped), history and audit. The student is active immediately.
 */
export async function createStudent(input: StudentFields, opts: CreateStudentOptions): Promise<Student> {
  const { instituteId } = requireTenantContext();
  const branch = await resolveBranch(input.branchId);
  const settings = await getStudentSettings();

  const dupes = await findDuplicates(input, { kinds: ['student'] });
  if (dupes.length && !opts.allowDuplicate)
    throw Conflict('A student with the same mobile, email or ID already exists', 'DUPLICATE_STUDENT', {
      matches: dupes,
    });
  await assertWithinLimit(instituteId, 'maxStudents', await activeStudentCount());

  const now = new Date();
  const admission = await resolveNumberTarget('admission', settings.admissionNumberFormat, branch.id, now);
  const roll = settings.autoRollNumber
    ? await resolveNumberTarget('roll', settings.rollNumberFormat, branch.id, now)
    : null;
  await ensureSequence(admission);
  if (roll) await ensureSequence(roll);

  const student = await withLockRetry(() =>
    getSequelize().transaction(async (transaction) => {
      let userId: number | null = opts.userId ?? null;
      // A mobile already used by a student here (a sibling) can't be the login of a second one.
      const mobileHasStudent = dupes.some((d) => d.matchedOn.includes('mobile'));
      if (userId === null && !mobileHasStudent) {
        const { user } = await findOrCreateUser(
          { name: input.name, mobile: input.mobile, email: input.email, password: opts.password },
          transaction,
        );
        const taken = await Student.count({ where: { instituteId, userId: user.id }, transaction });
        userId = taken ? null : user.id;
      }
      const s = await Student.create(
        {
          instituteId,
          branchId: branch.id,
          userId,
          admissionNumber: await allocateNumber(admission, transaction),
          rollNumber: roll ? await allocateNumber(roll, transaction) : null,
          name: input.name,
          mobile: input.mobile,
          email: input.email ?? null,
          dateOfBirth: input.dateOfBirth ?? null,
          gender: input.gender ?? null,
          address: input.address ?? null,
          city: input.city ?? null,
          state: input.state ?? null,
          pincode: input.pincode ?? null,
          idType: input.idType ?? null,
          idNumber: input.idNumber ?? null,
          academicInfo: input.academicInfo ?? null,
          customFields: input.customFields ?? null,
          status: 'active',
          source: opts.source,
          admittedAt: now,
        },
        { transaction },
      );
      if (userId) await syncBranchRoles(userId, 'student', [branch.id], transaction);
      await recordHistory(
        s.id,
        'admitted',
        { to: s.admissionNumber, details: { source: opts.source } },
        transaction,
      );
      if (opts.afterCreate) await opts.afterCreate(s, transaction);
      return s;
    }),
  );
  await audit({
    action: 'student.admitted',
    entityType: 'student',
    entityId: student.id,
    metadata: { admissionNumber: student.admissionNumber, source: opts.source, branchId: branch.id },
  });
  return student;
}

// ---------------------------------------------------------------- update / lifecycle

export async function updateStudent(id: number, patch: Partial<StudentFields>): Promise<Student> {
  const student = await studentRepo.findById(id);
  if (patch.branchId !== undefined && patch.branchId !== student.branchId)
    throw BadRequest('Use the transfer action to change branch');
  const { branchId: _ignored, ...values } = patch;
  if (values.mobile || values.email || values.idNumber) {
    const dupes = await findDuplicates(
      { mobile: values.mobile, email: values.email, idNumber: values.idNumber },
      { excludeStudentId: id, kinds: ['student'] },
    );
    if (dupes.length)
      throw Conflict('Another student uses the same mobile, email or ID', 'DUPLICATE_STUDENT', {
        matches: dupes,
      });
  }
  const changed = Object.keys(values).filter(
    (k) => JSON.stringify(values[k as keyof typeof values]) !== JSON.stringify(student.get(k)),
  );
  await student.update(values);
  if (changed.length) {
    await recordHistory(id, 'profile_updated', { details: { fields: changed } });
    await audit({
      action: 'student.updated',
      entityType: 'student',
      entityId: id,
      branchId: student.branchId,
      metadata: { fields: changed },
    });
  }
  return student;
}

export async function changeStatus(
  id: number,
  status: StudentStatus,
  reason: string | null,
): Promise<Student> {
  const student = await studentRepo.findById(id);
  if (student.status === status) return student;
  const { instituteId } = requireTenantContext();
  if (status === 'active' || status === 'suspended') {
    // Re-activating counts against the plan again.
    if (student.status === 'inactive' || student.status === 'discontinued')
      await assertWithinLimit(instituteId, 'maxStudents', await activeStudentCount());
  }
  const from = student.status;
  await student.update({ status, statusReason: reason });
  await recordHistory(id, 'status_changed', { from, to: status, details: reason ? { reason } : null });
  await audit({
    action: 'student.status_changed',
    entityType: 'student',
    entityId: id,
    branchId: student.branchId,
    metadata: { from, to: status, reason },
  });
  return student;
}

export async function transferStudent(
  id: number,
  input: { branchId: number; reason?: string | null; regenerateRollNumber?: boolean },
): Promise<Student> {
  const student = await studentRepo.findById(id);
  if (student.branchId === input.branchId) throw BadRequest('Student is already in this branch');
  const { instituteId } = requireTenantContext();
  const to = await Branch.findOne({ where: { instituteId, id: input.branchId, status: 'active' } });
  if (!to) throw BadRequest('Select a valid, active branch');
  studentRepo.assertBranchAllowed(to.id);
  const settings = await getStudentSettings();
  const regenerate = input.regenerateRollNumber ?? settings.rollNumberFormat.includes('{BRANCH}');
  const roll = regenerate ? await resolveNumberTarget('roll', settings.rollNumberFormat, to.id) : null;
  if (roll) await ensureSequence(roll);
  const fromBranchId = student.branchId;
  const fromRoll = student.rollNumber;

  await withLockRetry(() =>
    getSequelize().transaction(async (transaction) => {
      await student.update(
        { branchId: to.id, ...(roll ? { rollNumber: await allocateNumber(roll, transaction) } : {}) },
        { transaction },
      );
      if (student.userId) await syncBranchRoles(student.userId, 'student', [to.id], transaction);
      await syncParentRolesForStudent(id, transaction);
      await recordHistory(
        id,
        'branch_transferred',
        {
          from: String(fromBranchId),
          to: String(to.id),
          details: { reason: input.reason ?? null, fromRoll, toRoll: student.rollNumber },
        },
        transaction,
      );
    }),
  );
  await audit({
    action: 'student.transferred',
    entityType: 'student',
    entityId: id,
    branchId: to.id,
    metadata: { fromBranchId, toBranchId: to.id, reason: input.reason ?? null },
  });
  return student;
}

export async function deleteStudent(id: number): Promise<void> {
  const student = await studentRepo.findById(id);
  const { instituteId } = requireTenantContext();
  await getSequelize().transaction(async (transaction) => {
    const links = await StudentGuardian.findAll({ where: { instituteId, studentId: id }, transaction });
    await StudentGuardian.destroy({ where: { instituteId, studentId: id }, transaction });
    for (const guardianId of new Set(links.map((l) => l.guardianId)))
      await syncParentRoles(guardianId, transaction);
    for (const m of [StudentDocument, StudentHistory, StudentAcademicRecord] as const)
      await (m as typeof StudentHistory).destroy({ where: { instituteId, studentId: id }, transaction });
    await Enquiry.update({ studentId: null }, { where: { instituteId, studentId: id }, transaction });
    await AdmissionApplication.update(
      { studentId: null },
      { where: { instituteId, studentId: id }, transaction },
    );
    if (student.userId) await syncBranchRoles(student.userId, 'student', [], transaction);
    await student.destroy({ transaction });
  });
  await audit({
    action: 'student.deleted',
    entityType: 'student',
    entityId: id,
    branchId: student.branchId,
    metadata: { admissionNumber: student.admissionNumber, name: student.name },
  });
}

// ---------------------------------------------------------------- profile

export async function guardiansOf(studentId: number) {
  const { instituteId } = requireTenantContext();
  const links = await StudentGuardian.findAll({
    where: { instituteId, studentId },
    include: [{ model: Guardian, as: 'guardian' }],
    order: [
      ['isPrimary', 'DESC'],
      ['id', 'ASC'],
    ],
  });
  return links.map((l) => ({
    linkId: l.id,
    guardianId: l.guardianId,
    userId: l.guardian!.userId,
    name: l.guardian!.name,
    mobile: l.guardian!.mobile,
    email: l.guardian!.email ?? null,
    relation: l.relation,
    isPrimary: l.isPrimary,
    status: l.status,
  }));
}

export async function documentsOf(studentId: number) {
  const { instituteId } = requireTenantContext();
  const docs = await StudentDocument.findAll({
    where: { instituteId, studentId },
    include: [{ model: FileObject, as: 'file' }],
    order: [['id', 'DESC']],
  });
  return docs.map(toDocumentDto);
}

/** Full profile. Callers must have already checked access to `student`. */
export async function buildProfile(student: Student): Promise<StudentProfileDto> {
  const { instituteId } = requireTenantContext();
  const where = { instituteId, studentId: student.id };
  const [guardians, documents, records, history] = await Promise.all([
    guardiansOf(student.id),
    documentsOf(student.id),
    StudentAcademicRecord.findAll({ where, order: [['id', 'DESC']] }),
    StudentHistory.findAll({ where, order: [['id', 'DESC']], limit: 100 }),
  ]);
  return {
    ...toStudentDto(student),
    guardians,
    documents,
    academicRecords: records.map(toRecordDto),
    history: history.map(toHistoryDto),
  };
}

export async function addDocument(
  studentId: number,
  file: FileObject,
  input: { docType: string; title?: string | null },
): Promise<StudentDocumentDto> {
  const { instituteId, userId } = requireTenantContext();
  const doc = await StudentDocument.create({
    instituteId,
    studentId,
    fileId: file.id,
    docType: input.docType,
    title: input.title ?? null,
    uploadedByUserId: userId ?? null,
  });
  doc.file = file;
  await recordHistory(studentId, 'document_added', { to: input.docType, details: { fileId: file.id } });
  return toDocumentDto(doc);
}

export async function findDocument(studentId: number, docId: number) {
  const { instituteId } = requireTenantContext();
  const doc = await StudentDocument.findOne({ where: { instituteId, studentId, id: docId } });
  if (!doc) throw NotFound('Document');
  return doc;
}
