import { holdJobs, releaseHeldJobs } from '../../jobs/queue';
import { resumeOutbound, suppressOutbound } from '../../outbound';
import type { Express } from 'express';
import { QueryTypes } from 'sequelize';
import { getSequelize } from '../sequelize';
import { DemoApi, type Caller } from './client';
import {
  BOY_NAMES,
  DEMO_INSTITUTES,
  ENQUIRIES,
  EXPENSE_CATEGORIES,
  FATHER_NAMES,
  GIRL_NAMES,
  QUESTIONS,
  RESOURCES,
  SUBJECTS,
  SURNAMES,
  rng,
  type InstituteDemo,
  type Rng,
} from './data';

/**
 * Rich demo data for the Apex and Zenith demo institutes: academics, timetable, students with
 * guardians, admissions, attendance, exams, LMS, live classes, fees, expenses, HR/payroll,
 * notifications, website, grievances and appointments.
 *
 * Everything is created through the HTTP API (as the institute admin, teachers, students and
 * parents), so balances, ledgers, receipts and enrolments follow the same rules as in the app.
 * Re-running is safe: structural records are looked up by their natural key before being created,
 * and one-off activity (attendance, payments, exam attempts…) is recorded as a finished step in
 * the `demo_seed.steps` institute setting. Requires the base demo seed (`npm run db:seed`).
 */

type Row = Record<string, unknown>;

export interface DemoSeedSummary {
  institutes: { slug: string; steps: string[] }[];
}

export interface DemoSeedOptions {
  app: Express;
  /** Institute slugs to seed (default: every demo institute that exists). */
  only?: string[];
  log?: (msg: string) => void;
}

const STEP_KEY = 'demo_seed.steps';
/** Surnames of the scripted sibling families stay theirs alone. */
const OTHER_SURNAMES = SURNAMES.filter((s) => !['Kulkarni', 'Patil', 'Sharma'].includes(s));
const DAY = 86_400_000;

async function rows<T extends object = Row>(sql: string, replacements: unknown[] = []): Promise<T[]> {
  return getSequelize().query<T>(sql, { replacements, type: QueryTypes.SELECT });
}
async function one<T extends object = Row>(
  sql: string,
  replacements: unknown[] = [],
): Promise<T | undefined> {
  return (await rows<T>(sql, replacements))[0];
}

/** Calendar date (YYYY-MM-DD, Asia/Kolkata) `offset` days from today. */
export function istDate(offset = 0): string {
  return new Date(Date.now() + offset * DAY).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}
/** ISO instant for an IST wall-clock time on `date`. */
function istAt(date: string, time: string): string {
  return new Date(`${date}T${time}:00+05:30`).toISOString();
}
/** 'YYYY-MM-DD HH:MM:SS' in UTC, for raw SQL (see CONTRIBUTING: sequelize.query and dates). */
function utcSql(d: Date): string {
  return d.toISOString().slice(0, 19).replace('T', ' ');
}
function dayOfWeek(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

interface Person {
  name: string;
  gender: 'male' | 'female';
  dateOfBirth: string;
}

interface StudentPlan extends Person {
  key: string;
  batch: string;
  mobile: string;
  allowDuplicate?: boolean;
  /** Existing login whose account the student record should use (demo student). */
  demo?: boolean;
  guardians: {
    name: string;
    mobile: string;
    relation: 'father' | 'mother' | 'guardian';
    occupation: string;
    isPrimary: boolean;
  }[];
  /** 0 up to date, 1 fully paid, 2 part-paid, 3 nothing paid (overdue). */
  feeProfile: number;
  /** Attendance tendency, 0..1 chance of being absent. */
  absence: number;
  discount?: number;
}

class InstituteSeeder {
  private r: Rng;
  private steps = new Set<string>();
  private admin!: Caller;
  instituteId!: number;
  branches: number[] = [];
  private roleIds = new Map<string, number>();
  private subjects = new Map<string, number>();
  private courses = new Map<string, number>();
  private batches = new Map<string, Row>();
  private classrooms = new Map<string, number>();
  private teacherIds = new Map<string, number>();
  private sessionId!: number;
  private studentPlans: StudentPlan[] = [];
  /** student plan key -> { id, userId } */
  private students = new Map<string, { id: number; userId: number }>();
  private mobileSeq: Record<number, number> = {};

  constructor(
    private readonly api: DemoApi,
    private readonly d: InstituteDemo,
    private readonly log: (msg: string) => void,
  ) {
    this.r = rng(d.seed);
  }

  private mobile(kind: number) {
    this.mobileSeq[kind] = (this.mobileSeq[kind] ?? 0) + 1;
    return `962${this.d.digit}${kind}${String(this.mobileSeq[kind]).padStart(5, '0')}`;
  }
  private loginMobile(n: number) {
    return `${this.d.loginPrefix}0000000${n}`;
  }

  async init(): Promise<boolean> {
    const inst = await one<{ id: number }>('SELECT id FROM institutes WHERE slug = ?', [this.d.slug]);
    if (!inst) return false;
    this.instituteId = inst.id;
    const names = this.d.branchNames;
    const branchRows = await rows<{ id: number; name: string }>(
      'SELECT id, name FROM branches WHERE institute_id = ? ORDER BY id',
      [inst.id],
    );
    this.branches = names.map((n, i) => (branchRows.find((b) => b.name === n) ?? branchRows[i])?.id);
    if (this.branches.some((b) => !b))
      throw new Error(`${this.d.slug}: expected branches ${names.join(', ')}`);
    const adminUser = await this.userByMobile(this.loginMobile(1));
    if (!adminUser)
      throw new Error(
        `${this.d.slug}: demo admin ${this.loginMobile(1)} is missing; run npm run db:seed first`,
      );
    this.admin = await this.api.as(adminUser.id, this.instituteId);
    const stored = await one<{ value: unknown }>(
      'SELECT value FROM institute_settings WHERE institute_id = ? AND `key` = ?',
      [this.instituteId, STEP_KEY],
    );
    const value = typeof stored?.value === 'string' ? JSON.parse(stored.value) : stored?.value;
    for (const s of (Array.isArray(value) ? value : []) as string[]) this.steps.add(s);
    return true;
  }

  private async step(name: string, fn: () => Promise<void>) {
    if (this.steps.has(name)) return;
    this.log(`  ${this.d.slug}: ${name}`);
    await fn();
    this.steps.add(name);
    await getSequelize().query(
      'INSERT INTO institute_settings (institute_id, `key`, value, created_at, updated_at) VALUES (?, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP()) ON DUPLICATE KEY UPDATE value = VALUES(value), updated_at = UTC_TIMESTAMP()',
      { replacements: [this.instituteId, STEP_KEY, JSON.stringify([...this.steps])] },
    );
  }

  get doneSteps() {
    return [...this.steps];
  }

  private userByMobile(mobile: string) {
    return one<{ id: number; name: string }>('SELECT id, name FROM users WHERE mobile = ?', [mobile]);
  }

  private async as(userId: number) {
    return this.api.as(userId, this.instituteId);
  }

  async run() {
    this.plan();
    const sections: [string, () => Promise<void>][] = [
      ['structure', () => this.structure()],
      ['staff', () => this.staff()],
      ['students', () => this.studentsAndGuardians()],
      ['admissions', () => this.admissions()],
      ['timetable', () => this.timetable()],
      ['exams', () => this.exams()],
      ['lms', () => this.lms()],
      ['live', () => this.liveClasses()],
      ['fees', () => this.fees()],
      ['hr', () => this.hr()],
      ['communication', () => this.communication()],
      ['website', () => this.website()],
      ['helpdesk', () => this.helpdesk()],
    ];
    for (const [name, fn] of sections) {
      const started = Date.now();
      await fn();
      if (process.env.DEMO_SEED_TIMINGS) this.log(`    ${name}: ${Date.now() - started} ms`);
    }
  }

  /** Decides every random value up front, so the output doesn't depend on what already exists. */
  private plan() {
    const r = this.r;
    const birth = (age: number) => {
      const y = Number(istDate().slice(0, 4)) - age;
      return `${y}-${String(r.int(1, 12)).padStart(2, '0')}-${String(r.int(1, 28)).padStart(2, '0')}`;
    };
    const person = (age: number, surname?: string): Person => {
      const gender = r.next() < 0.55 ? 'male' : 'female';
      const first = r.pick(gender === 'male' ? BOY_NAMES : GIRL_NAMES);
      return { name: `${first} ${surname ?? r.pick(OTHER_SURNAMES)}`, gender, dateOfBirth: birth(age) };
    };
    const used = new Set<string>();
    let n = 0;
    for (const b of this.d.batches) {
      const course = this.d.courses.find((c) => c.code === b.course)!;
      const age = course.code.startsWith('FND') ? 15 : 17;
      for (let i = 0; i < b.students; i++) {
        let p = person(age);
        while (used.has(p.name)) p = person(age);
        used.add(p.name);
        const surname = p.name.split(' ')[1];
        const father = `${r.pick(FATHER_NAMES)} ${surname}`;
        const plan: StudentPlan = {
          ...p,
          key: `s${++n}`,
          batch: b.code,
          mobile: this.mobile(2),
          guardians: [
            {
              name: father,
              mobile: this.mobile(3),
              relation: 'father',
              occupation: r.pick([
                'Engineer',
                'Business',
                'Teacher',
                'Doctor',
                'Government service',
                'Farmer',
                'Accountant',
              ]),
              isPrimary: true,
            },
          ],
          feeProfile: n % 4,
          absence: r.next() < 0.15 ? 0.35 : 0.06,
        };
        this.studentPlans.push(plan);
      }
    }
    // The existing demo student and parent logins become a real student (first batch) and guardian.
    const first = this.d.batches[0];
    this.studentPlans.unshift({
      ...person(17, ''),
      name: '',
      key: 'demo',
      batch: first.code,
      mobile: this.loginMobile(5),
      demo: true,
      guardians: [
        {
          name: '',
          mobile: this.loginMobile(6),
          relation: 'father',
          occupation: 'Business',
          isPrimary: true,
        },
      ],
      feeProfile: 0,
      absence: 0.05,
    });
    // Siblings signing in on their father's mobile: the elder's account owns the number and the
    // younger one is reached on it ("Who's signing in?"). Their mother is the guardian of both.
    const sibMobile = this.mobile(3);
    const sibSurname = this.d.slug === 'apex' ? 'Kulkarni' : 'Sharma';
    const sibMother = {
      name: `${this.d.slug === 'apex' ? 'Swati' : 'Rekha'} ${sibSurname}`,
      mobile: this.mobile(3),
      relation: 'mother' as const,
      occupation: 'Chartered Accountant',
      isPrimary: true,
    };
    const elderBatch = this.d.batches[0].code;
    const youngerBatch = this.d.batches[this.d.batches.length - 1].code;
    this.studentPlans.push(
      {
        name: `Aditya ${sibSurname}`,
        gender: 'male',
        dateOfBirth: birth(17),
        key: 'sib1',
        batch: elderBatch,
        mobile: sibMobile,
        guardians: [sibMother],
        feeProfile: 0,
        absence: 0.04,
      },
      {
        name: `Isha ${sibSurname}`,
        gender: 'female',
        dateOfBirth: birth(15),
        key: 'sib2',
        batch: youngerBatch,
        mobile: sibMobile,
        allowDuplicate: true,
        guardians: [sibMother],
        feeProfile: 0,
        absence: 0.04,
        discount: 10,
      },
    );
    if (this.d.slug === 'apex') {
      // Siblings with their own mobiles and the same mother as guardian.
      const mother = {
        name: 'Meera Patil',
        mobile: this.mobile(3),
        relation: 'mother' as const,
        occupation: 'Doctor',
        isPrimary: true,
      };
      this.studentPlans.push(
        {
          name: 'Rohan Patil',
          gender: 'male',
          dateOfBirth: birth(17),
          key: 'pat1',
          batch: 'NEET27-KE',
          mobile: this.mobile(2),
          guardians: [mother],
          feeProfile: 2,
          absence: 0.08,
        },
        {
          name: 'Riya Patil',
          gender: 'female',
          dateOfBirth: birth(17),
          key: 'pat2',
          batch: 'JEE27-BE',
          mobile: this.mobile(2),
          guardians: [mother],
          feeProfile: 1,
          absence: 0.03,
          discount: 5,
        },
      );
    }
  }

  private async roleId(slug: string) {
    if (!this.roleIds.size) {
      const list = await this.admin.get<
        { id: number; slug: string }[] | { items: { id: number; slug: string }[] }
      >('/roles');
      for (const role of Array.isArray(list) ? list : list.items) this.roleIds.set(role.slug, role.id);
    }
    const id = this.roleIds.get(slug);
    if (!id) throw new Error(`${this.d.slug}: role ${slug} not found`);
    return id;
  }

  // ---------------------------------------------------------------- academics

  private async structure() {
    const iid = this.instituteId;
    const year = Number(istDate().slice(0, 4)) - (Number(istDate().slice(5, 7)) < 4 ? 1 : 0);
    const sessionName = `${year}-${String((year + 1) % 100).padStart(2, '0')}`;
    let session = await one<{ id: number }>(
      'SELECT id FROM academic_sessions WHERE institute_id = ? AND name = ?',
      [iid, sessionName],
    );
    if (!session) {
      session = await this.admin.post('/academics/sessions', {
        name: sessionName,
        startDate: `${year}-04-01`,
        endDate: `${year + 1}-03-31`,
      });
      const current = await one(
        'SELECT id FROM academic_sessions WHERE institute_id = ? AND is_current = 1',
        [iid],
      );
      if (!current) await this.admin.post(`/academics/sessions/${session!.id}/make-current`);
    }
    this.sessionId = session!.id;

    const wanted = new Set(this.d.courses.flatMap((c) => c.subjects));
    for (const s of SUBJECTS.filter((x) => wanted.has(x.code))) {
      let row = await one<{ id: number }>(
        'SELECT id FROM subjects WHERE institute_id = ? AND (code = ? OR name = ?)',
        [iid, s.code, s.name],
      );
      if (!row) row = await this.admin.post('/academics/subjects', { name: s.name, code: s.code });
      this.subjects.set(s.code, row!.id);
    }

    for (const c of this.d.courses) {
      let row = await one<{ id: number }>('SELECT id FROM courses WHERE institute_id = ? AND code = ?', [
        iid,
        c.code,
      ]);
      if (!row)
        row = await this.admin.post('/academics/courses', {
          name: c.name,
          code: c.code,
          description: c.description,
          mode: 'offline',
          durationValue: c.years,
          durationUnit: 'years',
          branchIds: c.branches.map((b) => this.branches[b]),
          subjectIds: c.subjects.map((s) => this.subjects.get(s)),
        });
      this.courses.set(c.code, row!.id);
    }

    for (const room of this.d.classrooms) {
      const branchId = this.branches[room.branch];
      let row = await one<{ id: number }>(
        'SELECT id FROM classrooms WHERE institute_id = ? AND branch_id = ? AND name = ?',
        [iid, branchId, room.name],
      );
      if (!row)
        row = await this.admin.post('/academics/classrooms', {
          branchId,
          name: room.name,
          capacity: room.capacity,
        });
      this.classrooms.set(room.name, row!.id);
    }
  }

  // ---------------------------------------------------------------- staff and roles

  private async staff() {
    const teacherRole = await this.roleId('teacher');
    for (const t of this.d.teachers) {
      if (t.key === 'demo') {
        const u = await this.userByMobile(this.loginMobile(4));
        this.teacherIds.set('demo', u!.id);
        continue;
      }
      const mobile = this.mobile(1);
      let u = await this.userByMobile(mobile);
      if (!u)
        u = await this.admin.post('/users', {
          name: t.name,
          mobile,
          email: `${t.name.split(' ')[0].toLowerCase()}.${this.d.slug}@demo.erp.test`,
          roles: [{ roleId: teacherRole, branchId: null }],
        });
      this.teacherIds.set(t.key, u!.id);
    }

    // Example custom roles (see Roles & permissions).
    const catalog = await this.admin.get<Record<string, { key: string }[]>>('/permissions');
    const known = new Set(
      Object.values(catalog)
        .flat()
        .map((p) => p.key),
    );
    const pick = (keys: string[]) => keys.filter((k) => known.has(k));
    const customRoles = [
      {
        slug: 'custom-front-desk',
        name: 'Front Desk',
        description: 'Reception: enquiries, admissions, student records and fee collection.',
        permissions: pick([
          'dashboard.view',
          'admissions.view',
          'admissions.create',
          'admissions.edit',
          'students.view',
          'students.create',
          'students.edit',
          'guardians.view',
          'guardians.create',
          'academics.view',
          'attendance.view',
          'fees.view',
          'fees.create',
          'notifications.view',
          'appointments.view',
          'appointments.create',
          'grievances.view',
          'grievances.create',
        ]),
        user: 'Kiran Gaikwad',
      },
      {
        slug: 'custom-auditor',
        name: 'Auditor',
        description: 'Read-only access to fees, finance, payroll and the audit log.',
        permissions: pick([
          'dashboard.view',
          'fees.view',
          'fees.export',
          'finance.view',
          'finance.export',
          'accounting.view',
          'accounting.export',
          'payroll.view',
          'reports.view',
          'reports.export',
          'audit.view',
          'students.view',
        ]),
        user: 'CA Nandini Mehta',
      },
    ];
    for (const role of customRoles) {
      let id = (
        await one<{ id: number }>('SELECT id FROM roles WHERE institute_id = ? AND (slug = ? OR name = ?)', [
          this.instituteId,
          role.slug,
          role.name,
        ])
      )?.id;
      if (!id)
        id = (
          await this.admin.post<{ id: number }>('/roles', {
            name: role.name,
            description: role.description,
            permissions: role.permissions,
          })
        ).id;
      const mobile = this.mobile(1);
      if (!(await this.userByMobile(mobile)))
        await this.admin.post('/users', { name: role.user, mobile, roles: [{ roleId: id, branchId: null }] });
    }
  }

  // ---------------------------------------------------------------- students and guardians

  private async studentsAndGuardians() {
    const iid = this.instituteId;
    for (const p of this.studentPlans) {
      const batch = this.d.batches.find((b) => b.code === p.batch)!;
      const branchId = this.branches[batch.branch];
      if (p.demo) {
        p.name = (await this.userByMobile(p.mobile))!.name;
        p.guardians[0].name = (await this.userByMobile(p.guardians[0].mobile))!.name;
      }
      let student = await one<{ id: number; userId: number }>(
        'SELECT id, user_id AS userId FROM students WHERE institute_id = ? AND mobile = ? AND name = ?',
        [iid, p.mobile, p.name],
      );
      if (!student) {
        const created = await this.admin.post<{ id: number; userId: number }>('/students', {
          name: p.name,
          mobile: p.mobile,
          branchId,
          gender: p.gender,
          dateOfBirth: p.dateOfBirth,
          city: this.d.city,
          allowDuplicate: p.allowDuplicate ?? false,
        });
        student = { id: created.id, userId: created.userId };
      }
      this.students.set(p.key, student);
      for (const g of p.guardians) {
        const linked = await one(
          `SELECT sg.id FROM student_guardians sg JOIN guardians g ON g.id = sg.guardian_id
           WHERE sg.institute_id = ? AND sg.student_id = ? AND g.mobile = ?`,
          [iid, student.id, g.mobile],
        );
        if (!linked) await this.admin.post(`/students/${student.id}/guardians`, g);
      }
    }
  }

  private async batch(code: string) {
    const cached = this.batches.get(code);
    if (cached) return cached;
    const b = this.d.batches.find((x) => x.code === code)!;
    let row = await one(
      'SELECT id, branch_id AS branchId, course_id AS courseId FROM batches WHERE institute_id = ? AND code = ?',
      [this.instituteId, code],
    );
    if (!row) {
      const course = this.d.courses.find((c) => c.code === b.course)!;
      row = await this.admin.post('/academics/batches', {
        branchId: this.branches[b.branch],
        courseId: this.courses.get(b.course),
        academicSessionId: this.sessionId,
        name: b.name,
        code: b.code,
        capacity: b.capacity,
        startDate: istDate(-70),
        teachers: course.subjects.map((s) => ({
          teacherUserId: this.teacherIds.get(b.teachers[s]),
          subjectId: this.subjects.get(s),
        })),
      });
      row = { id: row!.id, branchId: this.branches[b.branch], courseId: this.courses.get(b.course) };
    }
    this.batches.set(code, row!);
    return row!;
  }

  private batchStudents(code: string) {
    return this.studentPlans.filter((p) => p.batch === code);
  }

  private async enrol() {
    for (const b of this.d.batches) {
      const batch = await this.batch(b.code);
      const inBatch = new Set(
        (
          await rows<{ userId: number }>(
            'SELECT student_user_id AS userId FROM batch_students WHERE batch_id = ?',
            [batch.id],
          )
        ).map((x) => x.userId),
      );
      const missing = this.batchStudents(b.code)
        .map((p) => this.students.get(p.key)!.userId)
        .filter((id) => !inBatch.has(id));
      if (missing.length)
        await this.admin.post(`/academics/batches/${batch.id}/students`, {
          studentUserIds: missing,
          joinedOn: istDate(-70),
        });
    }
  }

  // ---------------------------------------------------------------- admissions

  private async admissions() {
    await this.enrol();
    const iid = this.instituteId;
    const courseCodes = this.d.courses.map((c) => c.code);
    const enquiries = this.d.slug === 'apex' ? ENQUIRIES : ENQUIRIES.slice(0, 5);
    const r = rng(this.d.seed + 7);
    for (const [i, e] of enquiries.entries()) {
      const mobile = this.mobile(4);
      const p = { gender: r.next() < 0.5, first: '', last: r.pick(SURNAMES) };
      const name = `${p.gender ? r.pick(BOY_NAMES) : r.pick(GIRL_NAMES)} ${p.last}`;
      if (await one('SELECT id FROM enquiries WHERE institute_id = ? AND mobile = ?', [iid, mobile]))
        continue;
      const courseCode = courseCodes[e.course % courseCodes.length];
      const course = this.d.courses.find((c) => c.code === courseCode)!;
      const created = await this.admin.post<{ id: number }>('/admissions/enquiries', {
        name,
        mobile,
        branchId: this.branches[course.branches[i % course.branches.length]],
        source: e.source,
        courseInterest: course.name,
        courseId: this.courses.get(courseCode),
        notes: e.note,
      });
      if (e.status !== 'new') {
        await this.admin.post(`/admissions/enquiries/${created.id}/follow-ups`, {
          note: e.note,
          outcome: e.status === 'lost' || e.status === 'not_interested' ? 'Closed' : 'Spoke to parent',
          completed: true,
        });
        await this.admin.patch(`/admissions/enquiries/${created.id}`, { status: e.status });
      }
    }

    await this.step('admissions', async () => {
      const b = this.d.batches[0];
      const batch = await this.batch(b.code);
      const applicants =
        this.d.slug === 'apex'
          ? ['Tejas Bhosale', 'Shreya Chavan', 'Omkar Shinde']
          : ['Lakshya Jain', 'Nisha Verma'];
      for (const [i, name] of applicants.entries()) {
        const app = await this.admin.post<{ id: number }>('/admissions/applications', {
          name,
          mobile: this.mobile(2),
          branchId: batch.branchId,
          courseId: batch.courseId,
          batchId: batch.id,
        });
        if (i < applicants.length - 1)
          await this.admin.post(`/admissions/applications/${app.id}/admit`, {
            batchId: batch.id,
            allowDuplicate: true,
          });
      }
    });
  }

  // ---------------------------------------------------------------- timetable and attendance

  private async timetable() {
    const iid = this.instituteId;
    for (const b of this.d.batches) {
      const batch = await this.batch(b.code);
      const course = this.d.courses.find((c) => c.code === b.course)!;
      for (let day = 1; day <= 6; day++) {
        const subject = course.subjects[(day - 1) % course.subjects.length];
        if (
          await one('SELECT id FROM class_schedules WHERE batch_id = ? AND day_of_week = ?', [batch.id, day])
        )
          continue;
        await this.admin.post('/academics/schedules', {
          batchId: batch.id,
          teacherUserId: this.teacherIds.get(b.teachers[subject]),
          subjectId: this.subjects.get(subject),
          classroomId: this.classrooms.get(b.classroom),
          dayOfWeek: day,
          startTime: b.start,
          endTime: b.end,
          effectiveFrom: istDate(-70),
        });
      }
    }
    await this.step('class-sessions', async () => {
      await this.admin.post('/academics/schedules/generate', { from: istDate(-28), to: istDate(21) });
    });

    await this.step('attendance', async () => {
      const today = istDate();
      // Batches in parallel, each with its own random sequence (deterministic either way).
      await Promise.all(
        this.d.batches.map(async (b, bi) => {
          const r = rng(this.d.seed + 11 + bi);
          const batch = await this.batch(b.code);
          const sessions = await rows<{ id: number; date: string; status: string }>(
            `SELECT id, DATE_FORMAT(date, '%Y-%m-%d') AS date, status FROM class_sessions
           WHERE institute_id = ? AND batch_id = ? AND date >= ? AND date < ? ORDER BY date`,
            [iid, batch.id, istDate(-28), today],
          );
          const roster = this.batchStudents(b.code);
          for (const s of sessions) {
            const att = await this.admin.post<{
              session: { id: number };
              roster: { studentUserId: number }[];
            }>('/attendance/sessions', {
              classSessionId: s.id,
            });
            const attendanceId = att.session.id;
            const planned = new Map(roster.map((p) => [this.students.get(p.key)!.userId, p.absence]));
            const records = att.roster.map(({ studentUserId: userId }) => {
              const x = r.next();
              const absence = planned.get(userId) ?? 0.06;
              return {
                studentUserId: userId,
                status: x < absence ? 'absent' : x < absence + 0.05 ? 'late' : 'present',
              };
            });
            await this.admin.put(`/attendance/sessions/${attendanceId}/records`, { records });
            await this.admin.post(`/attendance/sessions/${attendanceId}/close`);
            if (s.status !== 'completed')
              await this.admin.post(`/academics/class-sessions/${s.id}/complete`, {
                actualDurationMinutes: 90,
                completionNotes: 'Lecture completed as planned; DPP shared on the app.',
              });
          }
        }),
      );
    });
  }

  // ---------------------------------------------------------------- exams

  private async exams() {
    const iid = this.instituteId;
    const banks = new Map<string, number[]>();
    for (const [code, subjectId] of this.subjects) {
      const subject = SUBJECTS.find((s) => s.code === code)!;
      const name = `${subject.name} practice bank`;
      let bank = await one<{ id: number }>(
        'SELECT id FROM question_banks WHERE institute_id = ? AND name = ?',
        [iid, name],
      );
      if (!bank)
        bank = await this.admin.post('/question-bank/banks', { name, subjectId, visibility: 'shared' });
      const ids: number[] = [];
      for (const q of QUESTIONS.filter((x) => x.subject === code)) {
        let row = await one<{ id: number }>('SELECT id FROM questions WHERE bank_id = ? AND text = ?', [
          bank!.id,
          q.text,
        ]);
        if (!row)
          row = await this.admin.post(`/question-bank/banks/${bank!.id}/questions`, {
            type: 'single',
            text: q.text,
            options: q.options.map((text, k) => ({ key: 'abcd'[k], text })),
            answerKey: { options: ['abcd'[q.answer]] },
            difficulty: q.difficulty,
            subjectId,
            tags: ['demo'],
          });
        ids.push(row!.id);
      }
      banks.set(code, ids);
    }

    await this.step('exams', async () => {
      const r = rng(this.d.seed + 23);
      for (const b of this.d.batches.slice(0, 2)) {
        const batch = await this.batch(b.code);
        const course = this.d.courses.find((c) => c.code === b.course)!;
        const questionIds = course.subjects.flatMap((s) => banks.get(s) ?? []);
        // A finished, published test with results...
        const now = Date.now();
        const exam = await this.admin.post<{ id: number; sections: { id: number }[] }>('/exams', {
          title: `Unit Test 1: ${course.subjects.map((s) => SUBJECTS.find((x) => x.code === s)!.name).join(', ')}`,
          batchId: batch.id,
          startAt: new Date(now - 60_000).toISOString(),
          endAt: new Date(now + 3_600_000).toISOString(),
          durationMinutes: 45,
          defaultMarks: 4,
          defaultNegativeMarks: 1,
          passMarks: 12,
        });
        const added = await this.admin.post<{ questions: { id: number; questionId: number }[] }>(
          `/exams/${exam.id}/questions`,
          {
            sectionId: exam.sections[0].id,
            questionIds,
          },
        );
        await this.admin.post(`/exams/${exam.id}/schedule`);
        const answerOf = new Map(
          await Promise.all(
            added.questions.map(async (q) => {
              const row = await one<{ text: string }>('SELECT text FROM questions WHERE id = ?', [
                q.questionId,
              ]);
              const def = QUESTIONS.find((x) => x.text === row!.text)!;
              return [q.id, def] as const;
            }),
          ),
        );
        const sittings = this.batchStudents(b.code).flatMap((p) => {
          if (r.next() < 0.1) return []; // missed the test
          const skill = p.key === 'demo' ? 0.8 : 0.35 + r.next() * 0.6;
          const answers: [number, string][] = [];
          for (const [eqId, def] of answerOf) {
            const x = r.next();
            if (x > 0.92) continue; // left blank
            const choice = x < skill ? def.answer : (def.answer + 1 + r.int(0, 2)) % 4;
            answers.push([eqId, 'ABCD'[choice]]);
          }
          return [{ userId: this.students.get(p.key)!.userId, answers }];
        });
        await Promise.all(
          sittings.map(async ({ userId, answers }) => {
            const student = await this.as(userId);
            const attempt = await student.post<{ attemptId?: number; id?: number; attempt?: { id: number } }>(
              `/exams/my/${exam.id}/start`,
            );
            const attemptId = attempt.attemptId ?? attempt.attempt?.id ?? attempt.id;
            for (const [eqId, option] of answers)
              await student.put(`/exams/my/attempts/${attemptId}/answers/${eqId}`, {
                response: { options: [option] },
              });
            await student.post(`/exams/my/attempts/${attemptId}/submit`);
          }),
        );
        // ...held ten days ago.
        const shift = 10 * DAY;
        await getSequelize().query(
          'UPDATE exams SET start_at = DATE_SUB(start_at, INTERVAL 240 HOUR), end_at = ? WHERE id = ?',
          { replacements: [utcSql(new Date(now - shift + 3_600_000 - 4 * 3_600_000)), exam.id] },
        );
        for (const table of ['exam_attempts']) {
          const cols = (
            await rows<{ c: string }>(
              `SELECT column_name AS c FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND data_type IN ('datetime', 'timestamp') AND column_name NOT IN ('created_at', 'updated_at')`,
              [table],
            )
          ).map((x) => x.c);
          if (cols.length)
            await getSequelize().query(
              `UPDATE ${table} SET ${cols.map((c) => `${c} = DATE_SUB(${c}, INTERVAL 240 HOUR)`).join(', ')} WHERE exam_id = ?`,
              { replacements: [exam.id] },
            );
        }
        await this.admin.post(`/exams/${exam.id}/publish`);

        // An upcoming test.
        const next = await this.admin.post<{ id: number; sections: { id: number }[] }>('/exams', {
          title: 'Unit Test 2: full syllabus so far',
          batchId: batch.id,
          startAt: istAt(istDate(7), '10:00'),
          endAt: istAt(istDate(7), '13:00'),
          durationMinutes: 60,
          defaultMarks: 4,
          defaultNegativeMarks: 1,
          passMarks: 15,
        });
        await this.admin.post(`/exams/${next.id}/questions`, { sectionId: next.sections[0].id, questionIds });
        await this.admin.post(`/exams/${next.id}/schedule`);
      }
    });
  }

  // ---------------------------------------------------------------- LMS (the app's Library)

  private async lms() {
    const iid = this.instituteId;
    for (const c of this.d.courses) {
      const courseId = this.courses.get(c.code)!;
      for (const s of c.subjects) {
        for (const res of RESOURCES[s] ?? []) {
          const existing = await one<{ id: number; status: string }>(
            'SELECT id, status FROM lms_resources WHERE institute_id = ? AND course_id = ? AND title = ?',
            [iid, courseId, res.title],
          );
          if (existing) {
            if (existing.status === 'draft') await this.admin.post(`/lms/resources/${existing.id}/publish`);
            continue;
          }
          const created = await this.admin.post<{ id: number }>('/lms/resources', {
            courseId,
            subjectId: this.subjects.get(s),
            title: res.title,
            type: 'link',
            externalUrl: res.url,
            description: `${SUBJECTS.find((x) => x.code === s)!.name} reference for ${c.name}.`,
          });
          await this.admin.post(`/lms/resources/${created.id}/publish`);
        }
      }
    }

    await this.step('homework', async () => {
      const r = rng(this.d.seed + 31);
      for (const b of this.d.batches) {
        const batch = await this.batch(b.code);
        const course = this.d.courses.find((c) => c.code === b.course)!;
        const [s1, s2] = course.subjects;
        const items = [
          {
            subject: s1,
            title: `${SUBJECTS.find((x) => x.code === s1)!.name} DPP 1`,
            dueAt: istAt(istDate(-5), '21:00'),
            graded: true,
          },
          {
            subject: s2,
            title: `${SUBJECTS.find((x) => x.code === s2)!.name} worksheet: chapter 2`,
            dueAt: istAt(istDate(4), '21:00'),
            graded: false,
          },
        ];
        for (const item of items) {
          const due = new Date(item.dueAt).getTime();
          // Created with a future due date, submitted, then moved back to the real (past) due date.
          const a = await this.admin.post<{ id: number }>('/lms/assignments', {
            batchId: batch.id,
            subjectId: this.subjects.get(item.subject),
            title: item.title,
            instructions: 'Solve all questions in your notebook and upload a photo or type your answers.',
            dueAt: due > Date.now() ? item.dueAt : new Date(Date.now() + DAY).toISOString(),
            maxMarks: 20,
            allowLate: true,
          });
          await this.admin.post(`/lms/assignments/${a.id}/publish`);
          for (const p of this.batchStudents(b.code)) {
            if (r.next() < (item.graded ? 0.2 : 0.6)) continue;
            const student = await this.as(this.students.get(p.key)!.userId);
            const sub = await student.put<{ id: number }>(`/lms/assignments/${a.id}/submission`, {
              text: 'Answers attached: Q1 (b), Q2 (d), Q3 worked solution in notebook.',
            });
            if (item.graded)
              await this.admin.post(`/lms/submissions/${sub.id}/grade`, {
                marks: r.int(9, 20),
                feedback: r.pick([
                  'Good work.',
                  'Show units in the final answer.',
                  'Revise the concept and retry Q3.',
                  'Excellent!',
                ]),
              });
          }
          if (due <= Date.now())
            await getSequelize().query('UPDATE lms_assignments SET due_at = ? WHERE id = ?', {
              replacements: [utcSql(new Date(due)), a.id],
            });
        }
      }
    });
  }

  // ---------------------------------------------------------------- live classes

  private async liveClasses() {
    await this.step('live-classes', async () => {
      for (const b of this.d.batches.slice(0, 2)) {
        const batch = await this.batch(b.code);
        const course = this.d.courses.find((c) => c.code === b.course)!;
        for (const [i, s] of course.subjects.slice(0, 2).entries()) {
          const date = istDate(i + 2);
          await this.admin.post('/live-classes', {
            batchId: batch.id,
            teacherUserId: this.teacherIds.get(b.teachers[s]),
            subjectId: this.subjects.get(s),
            scheduledStartAt: istAt(date, '19:00'),
            durationMinutes: 60,
            title: `Doubt-clearing session: ${SUBJECTS.find((x) => x.code === s)!.name}`,
          });
        }
      }
    });
  }

  // ---------------------------------------------------------------- fees and finance

  private async fees() {
    const iid = this.instituteId;
    await this.step('fee-settings', async () => {
      await this.admin.put('/fees/settings', { offlineApprovalRequired: false });
    });
    const heads = new Map<string, number>();
    for (const [name, code] of [
      ['Tuition fee', 'TUI'],
      ['Study material', 'MAT'],
      ['Test series', 'TST'],
    ]) {
      let row = await one<{ id: number }>('SELECT id FROM fee_heads WHERE institute_id = ? AND code = ?', [
        iid,
        code,
      ]);
      if (!row) row = await this.admin.post('/fees/heads', { name, code });
      heads.set(name, row!.id);
    }
    const structures = new Map<string, { id: number; total: number }>();
    for (const c of this.d.courses) {
      const courseId = this.courses.get(c.code)!;
      let row = await one<{ id: number }>(
        "SELECT id FROM fee_structures WHERE institute_id = ? AND course_id = ? AND academic_session_id = ? AND status = 'active'",
        [iid, courseId, this.sessionId],
      );
      if (!row)
        row = await this.admin.post('/fees/structures', {
          name: `${c.name} fee ${istDate().slice(0, 4)}`,
          courseId,
          academicSessionId: this.sessionId,
          kind: 'course',
          status: 'active',
          components: c.fee.components.map((x) => ({
            name: x.name,
            amount: x.amount,
            feeHeadId: heads.get(x.name),
            taxable: false,
          })),
          instalmentPlan: { type: c.fee.plan, count: c.fee.count, firstDueDate: istDate(-75) },
        });
      structures.set(c.code, { id: row!.id, total: c.fee.components.reduce((n, x) => n + x.amount, 0) });
    }

    await this.step('fee-accounts', async () => {
      const modes = ['upi', 'cash', 'bank_transfer', 'cheque', 'upi'] as const;
      let receiptNo = 0;
      for (const p of this.studentPlans) {
        const b = this.d.batches.find((x) => x.code === p.batch)!;
        const batch = await this.batch(b.code);
        const st = this.students.get(p.key)!;
        const account = await this.admin.post<{
          id: number;
          instalments: { amount?: number; net?: number; balance: number; dueDate: string }[];
        }>('/fees/accounts', {
          studentId: st.id,
          structureId: structures.get(b.course)!.id,
          batchId: batch.id,
          firstDueDate: istDate(-75),
        });
        if (p.discount)
          await this.admin.post(`/fees/accounts/${account.id}/adjustments`, {
            type: 'discount',
            mode: 'percent',
            value: p.discount,
            reason:
              p.key.startsWith('sib') || p.key.startsWith('pat') ? 'Sibling discount' : 'Merit scholarship',
          });
        const fresh = await this.admin.get<{
          balance: number;
          instalments: { balance: number; dueDate: string }[];
        }>(`/fees/accounts/${account.id}`);
        const today = istDate();
        const due = fresh.instalments.filter((i) => i.dueDate <= today).reduce((n, i) => n + i.balance, 0);
        const amounts =
          p.feeProfile === 0
            ? [due]
            : p.feeProfile === 1
              ? [Math.round(fresh.balance / 2), fresh.balance - Math.round(fresh.balance / 2)]
              : p.feeProfile === 2
                ? [Math.round(fresh.instalments[0].balance / 2)]
                : [];
        for (const [k, amount] of amounts.entries()) {
          if (amount <= 0) continue;
          const mode = modes[receiptNo++ % modes.length];
          await this.admin.post('/fees/payments/offline', {
            accountId: account.id,
            amount,
            mode,
            paidOn: istDate(-70 + k * 30 + (receiptNo % 5)),
            ...(mode === 'cheque'
              ? { chequeNumber: String(400100 + receiptNo), bankName: 'State Bank of India' }
              : {}),
            ...(mode === 'upi' || mode === 'bank_transfer'
              ? { referenceNo: `DEMO${String(830000 + receiptNo)}` }
              : {}),
          });
        }
      }
      // Admitted applicants: accounts generated by the admission hook (or now), left unpaid.
      const admitted = await rows<{ id: number }>(
        "SELECT s.id FROM students s WHERE s.institute_id = ? AND s.source = 'admission' AND NOT EXISTS (SELECT 1 FROM fee_accounts a WHERE a.student_id = s.id)",
        [iid],
      );
      const first = await this.batch(this.d.batches[0].code);
      for (const s of admitted)
        await this.admin.post('/fees/accounts', {
          studentId: s.id,
          structureId: structures.get(this.d.batches[0].course)!.id,
          batchId: first.id,
          firstDueDate: istDate(-75),
        });
    });

    const cats = new Map<string, number>();
    for (const name of EXPENSE_CATEGORIES) {
      let row = await one<{ id: number }>(
        "SELECT id FROM finance_categories WHERE institute_id = ? AND kind = 'expense' AND name = ?",
        [iid, name],
      );
      if (!row) row = await this.admin.post('/fees/finance/categories', { kind: 'expense', name });
      cats.set(name, row!.id);
    }
    await this.step('expenses', async () => {
      const r = rng(this.d.seed + 41);
      for (const [bi, branchId] of this.branches.entries()) {
        for (let m = 2; m >= 0; m--) {
          const date = (day: number) => {
            const d = new Date(`${istDate()}T00:00:00Z`);
            d.setUTCDate(1);
            d.setUTCMonth(d.getUTCMonth() - m);
            d.setUTCDate(day);
            const s = d.toISOString().slice(0, 10);
            return s > istDate() ? istDate() : s;
          };
          const items: [string, number, string, string][] = [
            ['Rent', (bi ? 95000 : 120000) * 100, 'bank_transfer', 'Shree Properties'],
            ['Electricity', r.int(14000, 22000) * 100, 'upi', 'MSEDCL'],
            ['Internet & phone', 3499 * 100, 'upi', 'Airtel Business'],
            ['Housekeeping', 12000 * 100, 'cash', 'CleanPro Services'],
            ['Stationery & printing', r.int(6000, 15000) * 100, 'cash', 'Navneet Stationers'],
          ];
          if (m === 1) items.push(['Marketing', 45000 * 100, 'bank_transfer', 'Local newspaper ad']);
          for (const [k, [cat, amount, mode, party]] of items.entries())
            await this.admin.post('/fees/finance/entries', {
              kind: 'expense',
              categoryId: cats.get(cat),
              amount,
              mode,
              date: date(Math.min(5 + k * 3, 28)),
              party: this.d.slug === 'zenith' && party === 'MSEDCL' ? 'JVVNL' : party,
              branchId,
              notes: `${cat} for ${date(1).slice(0, 7)}`,
            });
        }
      }
    });
  }

  // ---------------------------------------------------------------- HR and payroll

  private async hr() {
    const iid = this.instituteId;
    const employees: { id: number; basic: number }[] = [];
    const people = [
      ...this.d.teachers.map((t) => ({
        userId: this.teacherIds.get(t.key)!,
        name: t.name,
        designation: t.designation,
        department: 'Academics',
        basic: t.basic,
      })),
      ...this.d.staff.map((s) => ({ userId: undefined as number | undefined, ...s })),
    ];
    for (const [i, p] of people.entries()) {
      let row = p.userId
        ? await one<{ id: number }>('SELECT id FROM employees WHERE institute_id = ? AND user_id = ?', [
            iid,
            p.userId,
          ])
        : await one<{ id: number }>('SELECT id FROM employees WHERE institute_id = ? AND name = ?', [
            iid,
            p.name,
          ]);
      if (!row)
        row = await this.admin.post('/hr/employees', {
          ...(p.userId ? { userId: p.userId } : { name: p.name, mobile: this.mobile(1) }),
          dateOfJoining: istDate(-400 - i * 90),
          designation: p.designation,
          department: p.department,
          employmentType: 'full_time',
          branchId: this.branches[i % this.branches.length],
        });
      employees.push({ id: row!.id, basic: p.basic });
      if (!(await one('SELECT id FROM salary_structures WHERE employee_id = ?', [row!.id])))
        await this.admin.post('/payroll/structures', {
          employeeId: row!.id,
          payType: 'fixed_monthly',
          monthlyBasic: p.basic,
          allowances: [
            { name: 'HRA', amount: Math.round(p.basic * 0.2) },
            { name: 'Conveyance', amount: 160000 },
          ],
          deductions: [],
          effectiveFrom: istDate(-400 - i * 90),
        });
    }

    await this.step('staff-attendance', async () => {
      const r = rng(this.d.seed + 53);
      const entries: { employeeId: number; date: string; status: string }[] = [];
      for (let off = -21; off < 0; off++) {
        const date = istDate(off);
        if (dayOfWeek(date) === 0) continue;
        for (const e of employees) {
          const x = r.next();
          entries.push({
            employeeId: e.id,
            date,
            status: x < 0.04 ? 'absent' : x < 0.1 ? 'late' : x < 0.13 ? 'half_day' : 'present',
          });
        }
      }
      await this.admin.put('/hr/attendance', { entries });
      const types = await this.admin.get<
        { id: number; code: string }[] | { items: { id: number; code: string }[] }
      >('/hr/leave-types');
      const list = Array.isArray(types) ? types : types.items;
      if (list.length) {
        const leave = await this.admin.post<{ id: number }>('/hr/leaves', {
          employeeId: employees[1].id,
          leaveTypeId: list[0].id,
          fromDate: istDate(5),
          toDate: istDate(6),
          reason: 'Family function in hometown',
        });
        if (employees.length > 2) {
          const pending = await this.admin.post<{ id: number }>('/hr/leaves', {
            employeeId: employees[2].id,
            leaveTypeId: list[0].id,
            fromDate: istDate(12),
            toDate: istDate(12),
            reason: 'Medical appointment',
          });
          void pending;
        }
        await this.admin.post(`/hr/leaves/${leave.id}/decision`, {
          approve: true,
          note: 'Approved; substitute arranged.',
        });
      }
    });

    await this.step('payroll', async () => {
      const d = new Date(`${istDate()}T00:00:00Z`);
      d.setUTCDate(1);
      d.setUTCMonth(d.getUTCMonth() - 1);
      const periodYear = d.getUTCFullYear();
      const periodMonth = d.getUTCMonth() + 1;
      let run = await one<{ id: number; status: string }>(
        'SELECT id, status FROM payroll_runs WHERE institute_id = ? AND period_year = ? AND period_month = ? AND branch_id IS NULL',
        [iid, periodYear, periodMonth],
      );
      if (!run) run = await this.admin.post('/payroll/runs', { periodYear, periodMonth });
      if (run!.status === 'locked') return;
      await this.admin.post(`/payroll/runs/${run!.id}/generate`);
      await this.admin.post(`/payroll/runs/${run!.id}/approve`);
      await this.admin.post(`/payroll/runs/${run!.id}/lock`);
    });
  }

  // ---------------------------------------------------------------- notifications

  private async communication() {
    const iid = this.instituteId;
    const firstBatch = await this.batch(this.d.batches[0].code);
    const campaigns = [
      {
        title: 'Diwali holidays',
        body: 'Classes remain closed for Diwali from 30 Oct to 3 Nov. Regular lectures resume on 4 Nov. Happy Diwali!',
        audience: { roles: ['student', 'parent'] },
      },
      {
        title: 'Parent-teacher meeting',
        body: 'PTM for all batches this Sunday, 10:00 to 13:00. Please bring the progress report card.',
        audience: { roles: ['parent'] },
      },
      {
        title: 'Unit Test 2 next week',
        body: 'Unit Test 2 (full syllabus so far) is scheduled next week. Revise your DPPs and formula sheets.',
        audience: { batchIds: [firstBatch.id] },
      },
    ];
    for (const c of campaigns) {
      if (
        await one('SELECT id FROM notification_campaigns WHERE institute_id = ? AND title = ?', [
          iid,
          c.title,
        ])
      )
        continue;
      await this.admin.post('/notifications/campaigns', {
        title: c.title,
        channels: ['in_app', 'sms'],
        body: c.body,
        audience: c.audience,
      });
    }
  }

  // ---------------------------------------------------------------- website

  private async website() {
    await this.step('website', async () => {
      const pages = await this.admin.get<
        | { id: number; slug: string; isHome?: boolean }[]
        | { items: { id: number; slug: string; isHome?: boolean }[] }
      >('/website/pages');
      const list = Array.isArray(pages) ? pages : pages.items;
      const home = list.find((p) => p.isHome) ?? list[0];
      const inst = await one<{ name: string }>('SELECT name FROM institutes WHERE id = ?', [
        this.instituteId,
      ]);
      const courseIds = [...this.courses.values()];
      const faculty = this.d.teachers
        .filter((t) => t.key !== 'demo')
        .map((t) => ({
          name: t.name,
          subject: SUBJECTS.find((s) => s.code === t.subject)!.name,
          bio: `${t.designation}, 10+ years of JEE/NEET coaching.`,
        }));
      const blocks = [
        {
          id: 'hero',
          type: 'hero',
          settings: {
            heading: `${inst!.name}, ${this.d.city}`,
            subheading:
              'Classroom coaching for JEE, NEET and Foundation with small batches, weekly tests and parent updates.',
            ctaLabel: 'Book a free demo class',
            ctaHref: '#enquiry',
          },
        },
        { id: 'courses', type: 'courses', settings: { heading: 'Our programmes', courseIds } },
        { id: 'faculty', type: 'faculty', settings: { heading: 'Meet the faculty', members: faculty } },
        {
          id: 'results',
          type: 'testimonials',
          settings: {
            heading: 'What our students say',
            items: [
              {
                name: 'Saurabh Deshpande',
                role: 'JEE Advanced AIR 1,284',
                quote: 'Weekly tests and doubt sessions made all the difference.',
              },
              {
                name: 'Neha Kulkarni',
                role: 'NEET 2026, 655/720',
                quote: 'The NCERT-first approach and daily DPPs kept me on track.',
              },
            ],
          },
        },
        { id: 'enquiry', type: 'enquiry_form', settings: { heading: 'Request a call back' } },
        {
          id: 'contact',
          type: 'contact',
          settings: {
            address: `${this.d.city}, ${this.d.state}`,
            phone: `+91 ${this.loginMobile(1)}`,
            email: `info@${this.d.slug}.demo.erp.test`,
            mapQuery: `${inst!.name} ${this.d.city}`,
          },
        },
      ];
      await this.admin.patch(`/website/pages/${home.id}`, { blocks });
      await this.admin.post(`/website/pages/${home.id}/publish`);
      if (!list.some((p) => p.slug === 'results')) {
        const page = await this.admin.post<{ id: number }>('/website/pages', {
          slug: 'results',
          title: 'Results',
          showInNav: true,
          blocks: [
            {
              id: 'intro',
              type: 'text',
              settings: {
                heading: 'Our results',
                body: 'Every year our students secure top ranks in JEE Main, JEE Advanced and NEET UG.',
              },
            },
            {
              id: 'cta',
              type: 'cta',
              settings: {
                heading: 'Join the next batch',
                text: 'Admissions open for 2027 batches.',
                buttonLabel: 'Enquire now',
                buttonHref: 'enquiry',
              },
            },
          ],
        });
        await this.admin.post(`/website/pages/${page.id}/publish`);
      }
    });
  }

  // ---------------------------------------------------------------- grievances and appointments

  private async helpdesk() {
    const iid = this.instituteId;
    const cats = new Map<string, number>();
    await this.admin.get('/grievances/categories'); // creates the default categories
    for (const [name, slaHours] of [
      ['Academics', 72],
      ['Facilities & infrastructure', 96],
    ] as const) {
      let row = await one<{ id: number }>(
        'SELECT id FROM grievance_categories WHERE institute_id = ? AND name = ?',
        [iid, name],
      );
      if (!row) row = await this.admin.post('/grievances/categories', { name, slaHours });
      cats.set(name, row!.id);
    }
    const demoTeacher = this.teacherIds.get('demo')!;
    if (
      !(await one('SELECT id FROM appointment_slots WHERE institute_id = ? AND teacher_user_id = ?', [
        iid,
        demoTeacher,
      ]))
    )
      for (const day of [2, 4])
        await this.admin.post('/appointments/slots', {
          branchId: this.branches[0],
          teacherUserId: demoTeacher,
          kind: 'recurring',
          dayOfWeek: day,
          startTime: '16:00',
          endTime: '17:00',
          mode: 'both',
          location: 'Faculty room',
        });

    await this.step('helpdesk', async () => {
      const parentUser = (await this.userByMobile(this.loginMobile(6)))!;
      const parent = await this.as(parentUser.id);
      await parent.post('/grievances', {
        categoryId: cats.get('Facilities & infrastructure'),
        subject: 'AC not working in the classroom',
        description: 'The air conditioner in the morning batch classroom has not been working since Monday.',
        priority: 'medium',
      });
      const studentUser = this.students.get('demo')!;
      const student = await this.as(studentUser.userId);
      await student.post('/grievances', {
        categoryId: cats.get('Academics'),
        subject: 'Need extra doubt session for Rotational Motion',
        description:
          'Many of us found the rotational motion chapter difficult. Can we have an extra doubt-clearing session?',
        priority: 'low',
      });
      // First free time in the teacher's Tue/Thu 16:00 office hours (other meetings may be booked).
      const free = await parent.get<{ date: string; startTime: string; modes: string[] }[]>(
        `/appointments/teachers/${demoTeacher}/availability?studentId=${studentUser.id}&from=${istDate(1)}&to=${istDate(21)}`,
      );
      const slot = free.find((c) => c.modes.includes('offline'));
      if (slot)
        await parent.post('/appointments', {
          studentId: studentUser.id,
          teacherUserId: demoTeacher,
          date: slot.date,
          startTime: slot.startTime,
          mode: 'offline',
          agenda: 'Discuss Unit Test 1 performance and study plan.',
        });
    });
  }
}

/** Active non-console messaging providers (institute or platform level) that queued notifications would use. */
export async function configuredRealProviders(): Promise<string[]> {
  const found = await rows<{ what: string }>(
    `SELECT CONCAT('institute ', i.slug, ' ', p.channel, '=', p.provider) AS what
       FROM notification_providers p JOIN institutes i ON i.id = p.institute_id
      WHERE p.is_active = 1 AND p.provider <> 'console' AND i.slug IN (?)
     UNION ALL
     SELECT CONCAT('platform ', slot, '=', provider) FROM platform_integrations
      WHERE kind = 'messaging' AND enabled = 1 AND provider <> 'console'`,
    [DEMO_INSTITUTES.map((d) => d.slug)],
  );
  return found.map((f) => f.what);
}

export const OUTBOUND_SUPPRESSED_REASON = 'Demo data seed: outbound delivery suppressed';

/** Seeds the rich demo data into the demo institutes created by the base demo seed. */
export async function seedRichDemo(opts: DemoSeedOptions): Promise<DemoSeedSummary> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const api = new DemoApi(opts.app);
  await api.start();
  const summary: DemoSeedSummary = { institutes: [] };
  // Nothing the seed triggers may reach a real person: external notifications are recorded as
  // skipped, and jobs it enqueues are held so a running server's worker can't pick them up. If
  // seeding fails, the held jobs stay parked (run_at in 2999) and never run.
  suppressOutbound(OUTBOUND_SUPPRESSED_REASON);
  holdJobs();
  try {
    for (const d of DEMO_INSTITUTES) {
      if (opts.only && !opts.only.includes(d.slug)) continue;
      const seeder = new InstituteSeeder(api, d, log);
      if (!(await seeder.init())) {
        log(`Institute ${d.slug} not found; skipped (run npm run db:seed with SEED_DEMO_DATA=true first).`);
        continue;
      }
      log(`Seeding demo data for ${d.slug}…`);
      await seeder.run();
      summary.institutes.push({ slug: d.slug, steps: seeder.doneSteps });
    }
    const jobs = await releaseHeldJobs();
    log(`Background jobs: ${jobs.ran} run now (outbound suppressed), ${jobs.scheduled} scheduled for later.`);
  } finally {
    resumeOutbound();
    await api.close();
  }
  return summary;
}
