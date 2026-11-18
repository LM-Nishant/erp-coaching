/**
 * Builds the data the scenarios run against through the public API: a fresh institute per run
 * ("Load <id>", created by the super admin) with an admin, a teacher, LOAD_STUDENTS students who
 * each have a parent, one active batch, a published LMS document served through signed URLs, a
 * live class in progress and a small question bank. Runs therefore never depend on, or disturb,
 * other data. Generated users get mobiles in the 9458… range and one fixed device each, so logins
 * skip the new-device OTP.
 */
import { call, passwordLogin, type Device } from './client';
import { settings } from './env';

export const PASSWORD = 'Password@123';
/** Re-login before a scenario when a token is older than this (access tokens last 15 min by default). */
const TOKEN_MAX_AGE_MS = 10 * 60_000;

export interface Persona {
  label: string;
  userId: number;
  mobile: string;
  password: string;
  device: Device;
  token: string;
  tokenIssuedAt: number;
}

export interface Student extends Persona {
  studentId: number;
  parent: Persona;
}

export interface World {
  instituteId: number;
  slug: string;
  branchId: number;
  superAdmin: Persona;
  admin: Persona;
  teacher: Persona;
  students: Student[];
  courseId: number;
  batchId: number;
  lmsResourceId: number;
  liveClassId: number;
  questionIds: number[];
}

export interface Attempt {
  student: Student;
  attemptId: number;
  examQuestionIds: number[];
}

let lastMobile = 0;
/** 9458 + a 6-digit counter seeded from the clock in tenths of a second (unique across runs). */
function uniqueMobile(): string {
  lastMobile = Math.max(lastMobile + 1, Math.floor(Date.now() / 100));
  return `9458${String(lastMobile % 1_000_000).padStart(6, '0')}`;
}

let lastStamp = 0;
function uniqueId(): string {
  lastStamp = Math.max(lastStamp + 1, Date.now());
  return lastStamp.toString(36);
}

function deviceFor(mobile: string): Device {
  return { uid: `load-${mobile}`, name: 'Load test runner', platform: 'web' };
}

/** Runs `fn` over `items` with at most `limit` in flight; results keep the input order. */
async function pool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function signIn(label: string, userId: number, mobile: string, password: string): Promise<Persona> {
  const device = deviceFor(mobile);
  const token = await passwordLogin(mobile, password, device);
  return { label, userId, mobile, password, device, token, tokenIssuedAt: Date.now() };
}

/** Logs in again (same device, so no OTP) when a token may expire during the next scenario. */
export async function refreshStaleTokens(personas: Persona[]): Promise<void> {
  const stale = personas.filter((p) => p.password && Date.now() - p.tokenIssuedAt > TOKEN_MAX_AGE_MS);
  await pool(stale, 5, async (p) => {
    p.token = await passwordLogin(p.mobile, p.password, p.device);
    p.tokenIssuedAt = Date.now();
  });
}

export function allPersonas(world: World): Persona[] {
  return [world.superAdmin, world.admin, world.teacher, ...world.students.flatMap((s) => [s, s.parent])];
}

async function superAdminPersona(): Promise<Persona> {
  const { mobile, password } = settings.superAdmin;
  if (settings.superAdminToken)
    return {
      label: 'super admin',
      userId: 0,
      mobile,
      password: '',
      device: deviceFor(mobile),
      token: settings.superAdminToken,
      tokenIssuedAt: Date.now(),
    };
  // A stable device id: after the first run (or OTP) this runner is a known device of the super admin.
  const device: Device = { uid: 'load-test-runner', name: 'Load test runner', platform: 'web' };
  const token = await passwordLogin(mobile, password, device);
  return { label: 'super admin', userId: 0, mobile, password, device, token, tokenIssuedAt: Date.now() };
}

function isoDate(offsetDays: number): string {
  return new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

/** A ~1 MiB PDF-typed file, enough for several Range requests. */
function sampleDocument(): Blob {
  const header = Buffer.from('%PDF-1.4\n% load-test sample\n');
  const body = Buffer.alloc(1024 * 1024 - header.length, 0x20);
  return new Blob([Buffer.concat([header, body])], { type: 'application/pdf' });
}

export async function buildWorld(log: (message: string) => void): Promise<World> {
  const superAdmin = await superAdminPersona();
  const id = uniqueId();
  const plans = await call<
    { id: number; isActive?: boolean; limits?: { maxStudents?: number | null } | null }[]
  >('GET', '/admin/plans', { token: superAdmin.token });
  // The plan that allows the most students (no limit counts as unlimited).
  const capacity = (p: (typeof plans)[number]) => p.limits?.maxStudents ?? Number.MAX_SAFE_INTEGER;
  const plan = plans.filter((p) => p.isActive !== false).sort((a, b) => capacity(b) - capacity(a))[0];
  if (!plan) throw new Error('No active subscription plan to create the load-test institute with');
  const adminCredentials = { name: `Load admin ${id}`, mobile: uniqueMobile(), password: PASSWORD };
  const slug = `load-${id}`;
  const institute = await call<{ id: number }>('POST', '/admin/institutes', {
    token: superAdmin.token,
    body: { name: `Load ${id}`, slug, planId: plan.id, admin: adminCredentials },
  });
  const adminLogin = await signIn('admin', 0, adminCredentials.mobile, PASSWORD);
  const me = await call<{ user: { id: number } }>('GET', '/auth/me', { token: adminLogin.token });
  const admin: Persona = { ...adminLogin, userId: me.user.id };
  const as = { token: admin.token };

  const [branches, roles] = await Promise.all([
    call<{ id: number }[]>('GET', '/branches', as),
    call<{ id: number; slug: string }[]>('GET', '/roles', as),
  ]);
  const branchId = branches[0].id;
  const roleId = (slug: string) => {
    const role = roles.find((r) => r.slug === slug);
    if (!role) throw new Error(`Role ${slug} not found`);
    return role.id;
  };

  const addMember = async (label: string, role: string, branchScoped: boolean) => {
    const mobile = uniqueMobile();
    const user = await call<{ id: number }>('POST', '/users', {
      ...as,
      body: {
        name: `${label} ${id}`,
        mobile,
        password: PASSWORD,
        roles: [{ roleId: roleId(role), branchId: branchScoped ? branchId : null }],
        branchIds: [branchId],
      },
    });
    return { userId: user.id, mobile };
  };

  const teacherUser = await addMember('Load teacher', 'teacher', false);
  log(`institute ${slug} (#${institute.id}); creating ${settings.students} students with parents`);
  const students = await pool(
    Array.from({ length: settings.students }, (_, i) => i + 1),
    5,
    async (n) => {
      const mobile = uniqueMobile();
      const student = await call<{ id: number; userId: number }>('POST', '/students', {
        ...as,
        body: { name: `Load student ${n} ${id}`, mobile, password: PASSWORD, branchId },
      });
      // A parent account with a password (so it can sign in without an OTP), then the guardian link.
      const parentUser = await addMember(`Load parent ${n}`, 'parent', true);
      await call('POST', `/students/${student.id}/guardians`, {
        ...as,
        body: {
          name: `Load parent ${n} ${id}`,
          mobile: parentUser.mobile,
          relation: 'mother',
          isPrimary: true,
        },
      });
      return { n, mobile, studentId: student.id, userId: student.userId, parentUser };
    },
  );

  const code = id.toUpperCase();
  const session = await call<{ id: number }>('POST', '/academics/sessions', {
    ...as,
    body: { name: `Load session ${code}`, startDate: isoDate(-60), endDate: isoDate(300), status: 'active' },
  });
  const course = await call<{ id: number }>('POST', '/academics/courses', {
    ...as,
    body: { name: `Load course ${code}`, code: `LC-${code}`, branchIds: [branchId] },
  });
  const batch = await call<{ id: number }>('POST', '/academics/batches', {
    ...as,
    body: {
      branchId,
      courseId: course.id,
      academicSessionId: session.id,
      name: `Load batch ${code}`,
      code: `LB-${code}`,
      capacity: Math.max(50, settings.students),
      startDate: isoDate(-30),
      status: 'active',
      teachers: [{ teacherUserId: teacherUser.userId }],
    },
  });
  await call('POST', `/academics/batches/${batch.id}/students`, {
    ...as,
    body: { studentUserIds: students.map((s) => s.userId) },
  });

  const form = new FormData();
  form.append('file', sampleDocument(), 'load-notes.pdf');
  const file = await call<{ id: number }>('POST', '/lms/files', { ...as, body: form });
  const resource = await call<{ id: number }>('POST', '/lms/resources', {
    ...as,
    body: {
      courseId: course.id,
      title: `Load notes ${code}`,
      type: 'document',
      fileId: file.id,
      access: 'free',
    },
  });
  await call('POST', `/lms/resources/${resource.id}/publish`, as);

  const bank = await call<{ id: number }>('POST', '/question-bank/banks', {
    ...as,
    body: { name: `Load bank ${code}` },
  });
  const questionIds: number[] = [];
  for (let q = 1; q <= 5; q++) {
    const question = await call<{ id: number }>('POST', `/question-bank/banks/${bank.id}/questions`, {
      ...as,
      body: {
        type: 'single',
        text: `Load question ${q}: which option is correct?`,
        options: ['A', 'B', 'C', 'D'].map((key) => ({ key, text: `Option ${key}` })),
        answerKey: { options: ['A'] },
        status: 'active',
      },
    });
    questionIds.push(question.id);
  }

  log(`signing in ${students.length * 2 + 1} more users`);
  const teacher = await signIn('teacher', teacherUser.userId, teacherUser.mobile, PASSWORD);
  const live = await call<{ id: number }>('POST', '/live-classes', {
    ...as,
    body: {
      batchId: batch.id,
      teacherUserId: teacher.userId,
      title: `Load live class ${code}`,
      scheduledStartAt: new Date().toISOString(),
      durationMinutes: 180,
    },
  });
  await call('POST', `/live-classes/${live.id}/start`, { token: teacher.token });

  const signedIn = await pool(students, 5, async (s) => {
    const student = await signIn(`student ${s.n}`, s.userId, s.mobile, PASSWORD);
    const parent = await signIn(`parent ${s.n}`, s.parentUser.userId, s.parentUser.mobile, PASSWORD);
    return { ...student, studentId: s.studentId, parent };
  });

  return {
    instituteId: institute.id,
    slug,
    branchId,
    superAdmin,
    admin,
    teacher,
    students: signedIn,
    courseId: course.id,
    batchId: batch.id,
    lmsResourceId: resource.id,
    liveClassId: live.id,
    questionIds,
  };
}

/** A new exam for the batch, open now, with every student's attempt started. */
export async function startExamAttempts(world: World, label: string): Promise<Attempt[]> {
  const as = { token: world.admin.token };
  const now = Date.now();
  const exam = await call<{ id: number; sections: { id: number }[] }>('POST', '/exams', {
    ...as,
    body: {
      title: `Load ${label} ${uniqueId()}`,
      batchId: world.batchId,
      startAt: new Date(now - 5 * 60_000).toISOString(),
      endAt: new Date(now + 3 * 3_600_000).toISOString(),
      durationMinutes: 120,
      defaultMarks: 1,
    },
  });
  await call('POST', `/exams/${exam.id}/questions`, {
    ...as,
    body: { sectionId: exam.sections[0].id, questionIds: world.questionIds },
  });
  await call('POST', `/exams/${exam.id}/schedule`, as);
  return pool(world.students, 5, async (student) => {
    const attempt = await call<{ attemptId: number; questions: { examQuestionId: number }[] }>(
      'POST',
      `/exams/my/${exam.id}/start`,
      { token: student.token },
    );
    return {
      student,
      attemptId: attempt.attemptId,
      examQuestionIds: attempt.questions.map((q) => q.examQuestionId),
    };
  });
}

/** Signed playback URLs (path + query, relative to the API origin) for every student. */
export async function signedMediaPaths(world: World): Promise<string[]> {
  return pool(world.students, 5, async (student) => {
    const playback = await call<{ url: string }>('POST', `/lms/resources/${world.lmsResourceId}/play`, {
      token: student.token,
    });
    const url = new URL(playback.url);
    return `${url.pathname}${url.search}`;
  });
}
