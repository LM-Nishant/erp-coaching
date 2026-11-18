import crypto from 'node:crypto';
import { DataTypes, QueryTypes } from 'sequelize';
import { getSequelize } from '../../src/infrastructure/database/sequelize';
import type { Scope } from './crawler';
import { SYNTHESIS_HINTS } from './coverage';
import {
  type Actor,
  type Tenant,
  PASSWORD,
  allPermissionKeys,
  createInstitute,
  createStaff,
  createSuperAdmin,
  marker as newMarker,
  ok,
  query,
  signIn,
  upload,
} from './harness';

/**
 * The world probed by the tenant-isolation suite: an attacker institute, a victim institute with a
 * second branch, and a pair of every self-service persona in the victim (student, guardian,
 * employee) so each can be pointed at the other's records, plus one of each in the attacker
 * institute for the cross-tenant crawl of self-service routes. The people are created through the
 * API; the records the crawlers need (one per table) are synthesized on demand by `synthesizer`.
 */
export interface StudentPersona {
  actor: Actor;
  userId: number;
  studentId: number;
}
export interface GuardianPersona {
  actor: Actor;
  userId: number;
  guardianId: number;
}
export interface EmployeePersona {
  actor: Actor;
  userId: number;
  employeeId: number;
}

export interface World {
  /** In every victim name and synthesized string; must never show up in the attacker's responses. */
  marker: string;
  /** In every branch 2 name and string; must never show up for the branch-restricted user. */
  branchMarker: string;
  superAdmin: Actor;
  attacker: Tenant;
  /** Self-service personas of the attacker institute (attack the victim's self-service routes). */
  attackerPersonas: { student: Actor; guardian: Actor; employee: Actor };
  victim: Tenant;
  branch2Id: number;
  /** Every permission, but only on the victim's main branch. */
  restricted: Actor;
  teacherUserIds: { main: number; branch2: number };
  /** s1, s2: main branch; s3: branch 2. */
  students: { s1: StudentPersona; s2: StudentPersona; s3: StudentPersona };
  /** Guardians of s1 and s2. */
  guardians: { g1: GuardianPersona; g2: GuardianPersona };
  /** e1, e2: institute-wide; e3: branch 2. */
  employees: { e1: EmployeePersona; e2: EmployeePersona; e3: EmployeePersona };
}

const SELF_SERVICE_PERMISSIONS = ['hr-self-service.view', 'hr-self-service.create'];

/** A 1×1 PNG, for the website image the public crawl needs. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

async function systemRoleId(slug: string): Promise<number> {
  const [role] = await query<{ id: number }>('SELECT id FROM roles WHERE slug = ? AND institute_id IS NULL', [
    slug,
  ]);
  return role.id;
}

/** Creates students, guardians and employees in `tenant` through its admin. */
function people(tenant: Tenant, mobile: () => string) {
  const admin = tenant.admin;
  return {
    async student(label: string, name: string, branchId: number): Promise<StudentPersona> {
      const m = mobile();
      const s = await ok(admin, 'POST', '/api/students', { name, mobile: m, branchId });
      const actor = await signIn(label, m);
      return { actor, userId: actor.userId, studentId: s.id };
    },
    async guardian(label: string, name: string, of: StudentPersona): Promise<GuardianPersona> {
      const m = mobile();
      await ok(admin, 'POST', `/api/students/${of.studentId}/guardians`, {
        name,
        mobile: m,
        relation: 'mother',
      });
      const actor = await signIn(label, m);
      const [g] = await query<{ id: number }>(
        'SELECT id FROM guardians WHERE user_id = ? AND institute_id = ?',
        [actor.userId, tenant.id],
      );
      return { actor, userId: actor.userId, guardianId: g.id };
    },
    async employee(label: string, name: string, branchId: number | null): Promise<EmployeePersona> {
      const actor = await createStaff(admin, {
        label,
        mobile: mobile(),
        permissions: SELF_SERVICE_PERMISSIONS,
        branchId,
      });
      const e = await ok(admin, 'POST', '/api/hr/employees', {
        userId: actor.userId,
        name,
        dateOfJoining: '2024-06-01',
        designation: 'Teacher',
        ...(branchId ? { branchId } : {}),
      });
      return { actor, userId: actor.userId, employeeId: e.id };
    },
  };
}

export async function buildWorld(mobile: () => string): Promise<World> {
  const marker = newMarker('isov');
  const branchMarker = `${marker}b2`;
  const superAdmin = await createSuperAdmin(mobile());
  const attackerTag = newMarker('isoa');
  const attacker = await createInstitute(superAdmin, {
    slug: attackerTag,
    name: `Isolation attacker ${attackerTag}`,
    adminMobile: mobile(),
    label: 'attacker admin',
  });
  const victim = await createInstitute(superAdmin, {
    slug: marker,
    name: `Isolation victim ${marker}`,
    adminMobile: mobile(),
    label: 'victim admin',
  });
  const admin = victim.admin;
  const branch2 = await ok(admin, 'POST', '/api/branches', {
    name: `${marker} Branch 2`,
    code: `B2-${marker.slice(-6)}`.toUpperCase(),
  });

  // The public website crawl needs a published page (pages are published through versions) with an
  // image, since the public media route serves only images referenced by published pages.
  const image = await upload(
    admin,
    '/api/files',
    { name: `${marker}.png`, type: 'image/png', data: PNG },
    {
      module: 'website',
    },
  );
  const page = await ok(admin, 'POST', '/api/website/pages', {
    slug: `${marker}-page`,
    title: `${marker} Page`,
    seo: { ogImageFileId: image.id },
  });
  await ok(admin, 'POST', `/api/website/pages/${page.id}/publish`, {});

  const restricted = await createStaff(admin, {
    label: 'branch-restricted user',
    mobile: mobile(),
    permissions: await allPermissionKeys(),
    branchId: victim.mainBranchId,
  });

  const teacherRole = await systemRoleId('teacher');
  const teacher = async (name: string, branchId: number) => {
    const m = mobile();
    await ok(admin, 'POST', '/api/users', {
      name,
      mobile: m,
      password: PASSWORD,
      roles: [{ roleId: teacherRole, branchId }],
      branchIds: [branchId],
    });
    const [u] = await query<{ id: number }>('SELECT id FROM users WHERE mobile = ?', [m]);
    return u.id;
  };
  const teacherUserIds = {
    main: await teacher(`${marker} Teacher 1`, victim.mainBranchId),
    branch2: await teacher(`${branchMarker} Teacher 2`, branch2.id),
  };

  const v = people(victim, mobile);
  const s1 = await v.student('student 1', `${marker} Student 1`, victim.mainBranchId);
  const s2 = await v.student('student 2', `${marker} Student 2`, victim.mainBranchId);
  const s3 = await v.student('student 3', `${branchMarker} Student 3`, branch2.id);
  const g1 = await v.guardian('guardian 1', `${marker} Guardian 1`, s1);
  const g2 = await v.guardian('guardian 2', `${marker} Guardian 2`, s2);
  const e1 = await v.employee('employee 1', `${marker} employee 1`, null);
  const e2 = await v.employee('employee 2', `${marker} employee 2`, null);
  const e3 = await v.employee('employee 3', `${branchMarker} employee 3`, branch2.id);

  const a = people(attacker, mobile);
  const as = await a.student('attacker student', `${attackerTag} Student`, attacker.mainBranchId);
  const ag = await a.guardian('attacker guardian', `${attackerTag} Guardian`, as);
  const ae = await a.employee('attacker employee', `${attackerTag} employee`, null);

  return {
    marker,
    branchMarker,
    superAdmin,
    attacker,
    attackerPersonas: { student: as.actor, guardian: ag.actor, employee: ae.actor },
    victim,
    branch2Id: branch2.id,
    restricted,
    teacherUserIds,
    students: { s1, s2, s3 },
    guardians: { g1, g2 },
    employees: { e1, e2, e3 },
  };
}

// ------------------------------------------------------------------------------------ synthesizer

interface Column {
  name: string;
  dataType: string;
  columnType: string;
  nullable: boolean;
  hasDefault: boolean;
  autoIncrement: boolean;
  generated: boolean;
  maxLength: number | null;
}
interface ForeignKey {
  column: string;
  table: string;
  refColumn: string;
}
interface TableInfo {
  columns: Column[];
  fks: Map<string, ForeignKey>;
  uniques: string[][];
  modelDefaults: Map<string, unknown>;
}

let schemaCache: Map<string, TableInfo> | null = null;

async function schema(): Promise<Map<string, TableInfo>> {
  if (schemaCache) return schemaCache;
  const tables = new Map<string, TableInfo>();
  const info = (t: string) => {
    let v = tables.get(t);
    if (!v) {
      v = { columns: [], fks: new Map(), uniques: [], modelDefaults: new Map() };
      tables.set(t, v);
    }
    return v;
  };
  const cols = await query<{
    t: string;
    c: string;
    dt: string;
    ct: string;
    n: string;
    d: string | null;
    x: string;
    len: number | null;
  }>(
    `SELECT TABLE_NAME t, COLUMN_NAME c, DATA_TYPE dt, COLUMN_TYPE ct, IS_NULLABLE n, COLUMN_DEFAULT d,
            EXTRA x, CHARACTER_MAXIMUM_LENGTH len
       FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME, ORDINAL_POSITION`,
  );
  for (const c of cols) {
    info(c.t).columns.push({
      name: c.c,
      dataType: c.dt.toLowerCase(),
      columnType: c.ct.toLowerCase(),
      nullable: c.n === 'YES',
      hasDefault: c.d !== null || /DEFAULT_GENERATED/i.test(c.x),
      autoIncrement: /auto_increment/i.test(c.x),
      generated: /VIRTUAL GENERATED|STORED GENERATED/i.test(c.x),
      maxLength: c.len === null ? null : Number(c.len),
    });
  }
  const fks = await query<{ t: string; c: string; rt: string; rc: string }>(
    `SELECT TABLE_NAME t, COLUMN_NAME c, REFERENCED_TABLE_NAME rt, REFERENCED_COLUMN_NAME rc
       FROM information_schema.KEY_COLUMN_USAGE
      WHERE TABLE_SCHEMA = DATABASE() AND REFERENCED_TABLE_NAME IS NOT NULL`,
  );
  for (const f of fks) info(f.t).fks.set(f.c, { column: f.c, table: f.rt, refColumn: f.rc });
  const uniques = await query<{ t: string; i: string; c: string }>(
    `SELECT TABLE_NAME t, INDEX_NAME i, COLUMN_NAME c FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE() AND NON_UNIQUE = 0 AND INDEX_NAME <> 'PRIMARY'
      ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`,
  );
  const byIndex = new Map<string, { t: string; cols: string[] }>();
  for (const u of uniques) {
    const key = `${u.t}.${u.i}`;
    const entry = byIndex.get(key) ?? { t: u.t, cols: [] };
    entry.cols.push(u.c);
    byIndex.set(key, entry);
  }
  for (const { t, cols: c } of byIndex.values()) info(t).uniques.push(c);
  for (const model of Object.values(getSequelize().models)) {
    const tableName = model.getTableName();
    const t = info(typeof tableName === 'string' ? tableName : tableName.tableName);
    for (const attr of Object.values(model.getAttributes())) {
      if (attr.defaultValue !== undefined && attr.field) t.modelDefaults.set(attr.field, attr.defaultValue);
    }
  }
  schemaCache = tables;
  return tables;
}

/** Enum values preferred for synthesized rows, so owners can read them (published, active…). */
const PREFERRED_ENUM = [
  'active',
  'published',
  'approved',
  'open',
  'scheduled',
  'issued',
  'submitted',
  'present',
  'completed',
];

// UTC, like the API's database connection (timezone +00:00).
const now = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
const today = () => now().slice(0, 10);

/** Largest signed value per integer type (unsigned doubles it). */
const INT_MAX: Record<string, number> = {
  tinyint: 127,
  smallint: 32_767,
  mediumint: 8_388_607,
  int: 2_147_483_647,
  bigint: Number.MAX_SAFE_INTEGER,
};

let sequence = 0;

function modelDefault(value: unknown): { ok: true; value: unknown } | { ok: false } {
  if (value instanceof DataTypes.NOW || value === DataTypes.NOW) return { ok: true, value: now() };
  if (value instanceof DataTypes.UUIDV4 || value === DataTypes.UUIDV4) {
    return { ok: true, value: crypto.randomUUID() };
  }
  if (typeof value === 'function') return { ok: false };
  if (value !== null && typeof value === 'object') return { ok: true, value: JSON.stringify(value) };
  return { ok: true, value };
}

function textValue(column: Column, tag: string, unique: boolean): string {
  const n = ++sequence;
  const name = column.name;
  const max = column.maxLength ?? 255;
  const id = `${tag}${n}`;
  let value: string;
  if (/email/.test(name)) value = `${id}@isolation.test`;
  else if (/mobile|phone/.test(name)) value = `94539${String(n).padStart(5, '0')}`;
  else if (/currency/.test(name)) value = unique ? id : 'INR';
  else if (/time_?zone/.test(name)) value = 'Asia/Kolkata';
  else if (/mime|content_type/.test(name)) value = 'application/pdf';
  else if (/(^|_)(locale|language|lang)$/.test(name)) value = 'en';
  else if (/colou?r/.test(name)) value = '#336699';
  else if (/(^|_)(url|link|href)$/.test(name)) value = `https://isolation.test/${id}`;
  else if (/(^|_)(path|storage_key|file_key|object_key|key)$/.test(name)) value = `isolation/${id}.pdf`;
  else if (/(^|_)(slug|code|subdomain|handle|number|no)$/.test(name)) value = id.toLowerCase();
  else if (/hash|token|secret|signature|nonce/.test(name)) value = crypto.randomBytes(32).toString('hex');
  else value = `${tag} ${name} ${n}`;
  if (value.length <= max) return value;
  return id.length <= max ? id : crypto.randomBytes(max).toString('hex').slice(0, max);
}

function scalarValue(column: Column, tag: string, unique: boolean): unknown {
  const t = column.dataType;
  if (t === 'enum') {
    const options = [...column.columnType.matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1]);
    return PREFERRED_ENUM.find((p) => options.includes(p)) ?? options[0];
  }
  if (t === 'tinyint' && /tinyint\(1\)/.test(column.columnType)) return 0;
  if (/int|decimal|float|double|numeric/.test(t)) {
    if (/(^|_)year$/.test(column.name)) return new Date().getUTCFullYear();
    if (/(^|_)month$/.test(column.name)) return new Date().getUTCMonth() + 1;
    if (!unique) return 1;
    const precision = /\((\d+),(\d+)\)/.exec(column.columnType);
    const max = INT_MAX[t]
      ? INT_MAX[t] * (/unsigned/.test(column.columnType) ? 2 : 1)
      : precision
        ? 10 ** (Number(precision[1]) - Number(precision[2])) - 1
        : 8_000_000;
    return 1 + crypto.randomInt(Math.max(1, Math.min(max - 1, 8_000_000)));
  }
  if ((t === 'char' || t === 'varchar') && column.maxLength === 36) return crypto.randomUUID();
  if (t === 'date') return today();
  if (t === 'datetime' || t === 'timestamp') return now();
  if (t === 'time') return '10:00:00';
  if (t === 'year') return new Date().getFullYear();
  if (t === 'json') return /s$/.test(column.name) ? '[]' : '{}';
  if (/blob|binary/.test(t)) return Buffer.alloc(0);
  return textValue(column, tag, unique);
}

interface Personas {
  admin: number;
  teacher: number;
  student: StudentPersona;
  guardian: GuardianPersona;
  employee: EmployeePersona;
}

interface State {
  scope: Scope;
  branchId: number;
  tag: string;
  personas: Personas;
  /** Parent rows chosen so far (table → id), so sibling parents agree (one exam, one batch…). */
  chosen: Map<string, unknown>;
}

const USER_COLUMN_HINTS: { pattern: RegExp; persona: (p: Personas) => number }[] = [
  { pattern: /student/, persona: (p) => p.student.userId },
  { pattern: /guardian|parent/, persona: (p) => p.guardian.userId },
  { pattern: /teacher|faculty|instructor|host|trainer|evaluator/, persona: (p) => p.teacher },
  { pattern: /employee|staff/, persona: (p) => p.employee.userId },
];

const MAX_DEPTH = 6;

/**
 * Inserts a plausible row into `table` for the scope's institute (and branch / owner), creating the
 * parents its foreign keys need. Values come from the schema: owner columns from the scope, users
 * by column name (`student_user_id` → a student…), other parents reused when the scope already has
 * one, enums prefer readable states (`published`, `active`…). Raw SQL, so no model hooks run.
 */
async function createRow(table: string, state: State, depth: number, need: Set<string>): Promise<unknown> {
  const tables = await schema();
  const info = tables.get(table);
  if (!info) throw new Error(`synthesizer: unknown table ${table}`);
  if (depth > MAX_DEPTH) throw new Error(`synthesizer: parents of ${table} nest deeper than ${MAX_DEPTH}`);
  const uniqueCols = new Set(info.uniques.flat());
  const values = new Map<string, unknown>();
  for (const column of info.columns) {
    if (column.autoIncrement || column.generated) continue;
    const name = column.name;
    const owner = state.scope.ownerColumns?.[name];
    const fk = info.fks.get(name);
    if (name === 'id') {
      values.set(name, crypto.randomUUID());
    } else if (name === 'institute_id') {
      values.set(name, state.scope.instituteId);
    } else if (name === 'branch_id') {
      values.set(name, state.branchId);
    } else if (owner !== undefined) {
      values.set(name, owner);
    } else if (fk) {
      if (column.nullable && !need.has(name)) continue;
      if (fk.table === table) continue;
      values.set(name, await parentValue(name, fk, state, depth));
    } else if (name === 'status' && column.dataType === 'enum') {
      values.set(name, scalarValue(column, state.tag, false));
    } else if (column.nullable || column.hasDefault || name === 'deleted_at') {
      continue;
    } else if (info.modelDefaults.has(name)) {
      const d = modelDefault(info.modelDefaults.get(name));
      values.set(name, d.ok ? d.value : scalarValue(column, state.tag, uniqueCols.has(name)));
    } else {
      values.set(name, scalarValue(column, state.tag, uniqueCols.has(name)));
    }
  }
  for (const [name, value] of Object.entries(SYNTHESIS_HINTS[table] ?? {})) {
    values.set(name, value !== null && typeof value === 'object' ? JSON.stringify(value) : value);
  }
  // A row that some unique key says already exists (one per student, per day…) is reused.
  for (const cols of info.uniques) {
    if (!cols.every((c) => values.get(c) !== undefined && values.get(c) !== null)) continue;
    const where = cols.map((c) => `\`${c}\` = ?`).join(' AND ');
    const [existing] = await query<{ id: unknown }>(
      `SELECT id FROM \`${table}\` WHERE ${where} LIMIT 1`,
      cols.map((c) => values.get(c)),
    );
    if (existing) return existing.id;
  }
  const names = [...values.keys()];
  const [insertId] = await getSequelize().query(
    `INSERT INTO \`${table}\` (${names.map((n) => `\`${n}\``).join(', ')}) VALUES (${names.map(() => '?').join(', ')})`,
    { replacements: names.map((n) => values.get(n)), type: QueryTypes.INSERT },
  );
  return values.get('id') ?? insertId;
}

async function parentValue(column: string, fk: ForeignKey, state: State, depth: number): Promise<unknown> {
  const { personas, scope } = state;
  if (fk.table === 'institutes') return scope.instituteId;
  if (fk.table === 'branches') return state.branchId;
  if (fk.table === 'users') {
    return USER_COLUMN_HINTS.find((h) => h.pattern.test(column))?.persona(personas) ?? personas.admin;
  }
  if (fk.refColumn === 'id') {
    if (state.chosen.has(fk.table)) return state.chosen.get(fk.table);
    const own = scope.ownerRows?.[fk.table];
    const persona =
      own ??
      (fk.table === 'students'
        ? personas.student.studentId
        : fk.table === 'employees'
          ? personas.employee.employeeId
          : fk.table === 'guardians'
            ? personas.guardian.guardianId
            : undefined);
    if (persona !== undefined) {
      await remember(fk.table, persona, state);
      return persona;
    }
  }
  const existing = await findParent(fk.table, state);
  const id = existing ?? (await createRow(fk.table, state, depth + 1, new Set()));
  if (fk.refColumn === 'id') await remember(fk.table, id, state);
  if (fk.refColumn === 'id') return id;
  const [row] = await query<Record<string, unknown>>(
    `SELECT \`${fk.refColumn}\` AS v FROM \`${fk.table}\` WHERE id = ? LIMIT 1`,
    [id],
  );
  return row?.v;
}

/** An existing row of `table` in the scope that agrees with the parents chosen so far. */
async function findParent(table: string, state: State): Promise<unknown> {
  const tables = await schema();
  const info = tables.get(table);
  if (!info) return undefined;
  const has = (c: string) => info.columns.some((x) => x.name === c);
  const conds: string[] = [];
  const params: unknown[] = [];
  if (has('institute_id')) {
    conds.push('institute_id = ?');
    params.push(state.scope.instituteId);
  } else if (!info.fks.size) {
    return (await query<{ id: unknown }>(`SELECT id FROM \`${table}\` ORDER BY id LIMIT 1`))[0]?.id;
  } else {
    return undefined;
  }
  if (has('branch_id')) {
    conds.push('(branch_id = ? OR branch_id IS NULL)');
    params.push(state.branchId);
  } else if (
    state.scope.branchId &&
    [...info.fks.values()].some(
      (fk) => fk.table !== 'branches' && tables.get(fk.table)?.columns.some((c) => c.name === 'branch_id'),
    )
  ) {
    // Its branch comes from its parents (an answer from its attempt): an existing row may belong
    // to another branch, so the branch crawl creates its own.
    return undefined;
  }
  for (const [column, value] of Object.entries(state.scope.ownerColumns ?? {})) {
    if (has(column)) {
      conds.push(`\`${column}\` = ?`);
      params.push(value);
    }
  }
  for (const fk of info.fks.values()) {
    if (['users', 'institutes', 'branches'].includes(fk.table) || fk.refColumn !== 'id') continue;
    if (state.chosen.has(fk.table)) {
      conds.push(`\`${fk.column}\` = ?`);
      params.push(state.chosen.get(fk.table));
    }
  }
  const order = has('branch_id') ? 'branch_id IS NULL, id' : 'id';
  const [row] = await query<{ id: unknown }>(
    `SELECT id FROM \`${table}\` WHERE ${conds.join(' AND ')} ORDER BY ${order} LIMIT 1`,
    params,
  );
  return row?.id;
}

/** Records a chosen parent and its own parents, so later siblings point at the same records. */
async function remember(table: string, id: unknown, state: State) {
  if (state.chosen.has(table)) return;
  state.chosen.set(table, id);
  const info = (await schema()).get(table);
  if (!info) return;
  const [row] = await query<Record<string, unknown>>(`SELECT * FROM \`${table}\` WHERE id = ? LIMIT 1`, [id]);
  for (const fk of info.fks.values()) {
    if (['users', 'institutes', 'branches'].includes(fk.table) || fk.refColumn !== 'id') continue;
    const value = row?.[fk.column];
    if (value !== null && value !== undefined && !state.chosen.has(fk.table))
      state.chosen.set(fk.table, value);
  }
}

/** Tables the synthesizer must not invent rows for (people and sign-in state come from the API). */
const NEVER_SYNTHESIZE = new Set(['users', 'devices', 'institutes', 'branches', 'roles', 'user_roles']);

export type Synthesize = (table: string, scope: Scope, need: string[]) => Promise<string | null>;

/**
 * Returns the `synthesize` hook for `resolveTarget`: creates one row of `table` in the scope and
 * returns null, or returns why it could not.
 */
export function synthesizer(world: World): Synthesize {
  return async (table, scope, need) => {
    if (NEVER_SYNTHESIZE.has(table)) return `${table} rows come from buildWorld, not the synthesizer`;
    const inBranch2 = scope.branchId === world.branch2Id;
    const ownStudent = Object.values(world.students).find((s) => s.studentId === scope.ownerRows?.students);
    const ownEmployee = Object.values(world.employees).find(
      (e) => e.employeeId === scope.ownerRows?.employees,
    );
    const state: State = {
      scope,
      branchId: scope.branchId ?? world.victim.mainBranchId,
      tag: inBranch2 ? world.branchMarker : world.marker,
      personas: {
        admin: world.victim.admin.userId,
        teacher: inBranch2 ? world.teacherUserIds.branch2 : world.teacherUserIds.main,
        student: ownStudent ?? (inBranch2 ? world.students.s3 : world.students.s2),
        guardian: world.guardians.g2,
        employee: ownEmployee ?? (inBranch2 ? world.employees.e3 : world.employees.e2),
      },
      chosen: new Map(),
    };
    try {
      await createRow(table, state, 0, new Set(need));
      return null;
    } catch (err) {
      return `synthesizer could not create a ${table} row: ${(err as Error).message.split('\n')[0]}`;
    }
  };
}
