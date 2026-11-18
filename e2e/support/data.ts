/**
 * Fast API builders for isolated test data: each spec creates its own institute (as the super
 * admin) and the people, batches, … it needs, with unique mobiles (9459…) and slugs, so specs never
 * depend on each other or on the seeded demo institutes, and also work against a reused database.
 */
import type { APIRequestContext } from '@playwright/test';
import { loginWithPassword, newDevice, type Session } from './api';

export const PASSWORD = 'Password@123';
export const TIMEZONE = 'Asia/Kolkata';

let lastStamp = 0;
/** Strictly increasing per process and close to the clock in ms, so values differ across runs too. */
function stamp(): number {
  lastStamp = Math.max(lastStamp + 1, Date.now());
  return lastStamp;
}

let lastMobile = 0;
/**
 * A 10-digit mobile in the 9459… range reserved for generated E2E users. The 6-digit suffix is a
 * per-process counter that starts from the clock in tenths of a second (it wraps after ~28 hours),
 * so it never repeats within a process, and later runs or restarted workers against a reused
 * database start beyond the numbers already used (tests create far fewer than 10 users a second).
 */
export function uniqueMobile(): string {
  lastMobile = Math.max(lastMobile + 1, Math.floor(Date.now() / 100));
  return `9459${String(lastMobile % 1_000_000).padStart(6, '0')}`;
}

/** Short unique lowercase token for slugs, codes and names. */
export function uniqueId(): string {
  return stamp().toString(36);
}

/** YYYY-MM-DD in the institute timezone (the default, Asia/Kolkata), `offsetDays` from now. */
export function isoDate(offsetDays = 0, from = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(from.getTime() + offsetDays * 86_400_000));
}

export interface Person {
  id: number;
  name: string;
  mobile: string;
  password: string;
}

export interface TestInstitute {
  id: number;
  name: string;
  slug: string;
  branchId: number;
  adminUser: Person;
  /** The institute admin, signed in through the API (all permissions). */
  admin: Session;
  roleIds: Record<string, number>;
}

export async function createInstitute(
  http: APIRequestContext,
  superAdmin: Session,
  label: string,
): Promise<TestInstitute> {
  const id = uniqueId();
  const plans = await superAdmin.api.get<{ id: number; code: string }[]>('/admin/plans');
  const plan = plans.find((p) => p.code === 'growth') ?? plans[0];
  const slug = `e2e-${label}-${id}`;
  const name = `E2E ${label} ${id}`;
  const credentials = { name: `Admin ${id}`, mobile: uniqueMobile(), password: PASSWORD };
  const institute = await superAdmin.api.post<{ id: number }>('/admin/institutes', {
    name,
    slug,
    planId: plan.id,
    admin: credentials,
  });
  const admin = await loginWithPassword(http, credentials, newDevice(`${label}-admin`));
  const [branches, roles] = await Promise.all([
    admin.api.get<{ id: number }[]>('/branches'),
    admin.api.get<{ id: number; slug: string }[]>('/roles'),
  ]);
  return {
    id: institute.id,
    name,
    slug,
    branchId: branches[0].id,
    adminUser: { id: admin.user.id, ...credentials },
    admin,
    roleIds: Object.fromEntries(roles.map((r) => [r.slug, r.id])),
  };
}

/** Adds a staff member with a password (e.g. `teacher`, `accountant`, `branch-admin`). */
export async function addStaff(institute: TestInstitute, role: string, name: string): Promise<Person> {
  const roleId = institute.roleIds[role];
  if (!roleId) throw new Error(`Unknown role ${role}`);
  const credentials = { name, mobile: uniqueMobile(), password: PASSWORD };
  const user = await institute.admin.api.post<{ id: number }>('/users', {
    ...credentials,
    roles: [{ roleId, branchId: null }],
    branchIds: [institute.branchId],
  });
  return { id: user.id, ...credentials };
}

export interface TestStudent extends Person {
  /** Student record id (the `id` used by /students/:id); `id` is the user id. */
  studentId: number;
}

/** Adds a student (with a login and password) in the institute's main branch. */
export async function addStudent(institute: TestInstitute, name: string): Promise<TestStudent> {
  const credentials = { name, mobile: uniqueMobile(), password: PASSWORD };
  const student = await institute.admin.api.post<{ id: number; userId: number }>('/students', {
    ...credentials,
    branchId: institute.branchId,
  });
  return { id: student.userId, studentId: student.id, ...credentials };
}

/** Links a new guardian to the student. Guardians have no password: they sign in with a mobile OTP. */
export async function addGuardian(
  institute: TestInstitute,
  student: TestStudent,
  name: string,
  relation = 'mother',
): Promise<Omit<Person, 'password'>> {
  const mobile = uniqueMobile();
  const link = await institute.admin.api.post<{ userId: number }>(`/students/${student.studentId}/guardians`, {
    name,
    mobile,
    relation,
    isPrimary: true,
  });
  return { id: link.userId, name, mobile };
}

export interface TestBatch {
  academicSessionId: number;
  courseId: number;
  courseName: string;
  batchId: number;
  batchName: string;
}

/** Academic session (active, around today) → course → batch with an optional teacher and students. */
export async function createBatch(
  institute: TestInstitute,
  options: { label: string; teacherUserId?: number; studentUserIds?: number[] },
): Promise<TestBatch> {
  const { api } = institute.admin;
  const code = uniqueId().toUpperCase();
  const session = await api.post<{ id: number }>('/academics/sessions', {
    name: `Session ${code}`,
    startDate: isoDate(-60),
    endDate: isoDate(300),
    status: 'active',
  });
  const courseName = `${options.label} course ${code}`;
  const course = await api.post<{ id: number }>('/academics/courses', {
    name: courseName,
    code: `C-${code}`,
    branchIds: [institute.branchId],
  });
  const batchName = `${options.label} batch ${code}`;
  const batch = await api.post<{ id: number }>('/academics/batches', {
    branchId: institute.branchId,
    courseId: course.id,
    academicSessionId: session.id,
    name: batchName,
    code: `B-${code}`,
    capacity: 50,
    startDate: isoDate(-30),
    status: 'active',
    teachers: options.teacherUserId ? [{ teacherUserId: options.teacherUserId }] : [],
  });
  if (options.studentUserIds?.length)
    await api.post(`/academics/batches/${batch.id}/students`, { studentUserIds: options.studentUserIds });
  return { academicSessionId: session.id, courseId: course.id, courseName, batchId: batch.id, batchName };
}
