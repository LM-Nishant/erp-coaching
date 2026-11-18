import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { discoverModules } from '../../src/infrastructure/module-loader';
import { describeRoutes, routeParams, type RouteInfo } from '../../src/infrastructure/route-registry';
import {
  NO_BRANCH,
  type Family,
  type Scope,
  type Target,
  idParamsOf,
  isWrite,
  resolveTarget,
  routeKey,
  selfFamily,
} from './crawler';
import { BRANCH_SHARED, KNOWN_UNCOVERED, OWNER_STATUS, PORTAL_SHARED } from './coverage';
import {
  type Actor,
  installTenantProbe,
  mobileFactory,
  purgeInstitutes,
  query,
  send,
  snapshotChanges,
  snapshotInstitute,
  tableNames,
} from './harness';
import { type Synthesize, type World, buildWorld, synthesizer } from './victim-data';

/**
 * Tenant isolation, branch restriction and self-service ownership, probed over every record route
 * in the route registry (see CONTRIBUTING.md › "Authorization and tenant-isolation suite"):
 *
 * - cross-tenant: another institute's admin gets 404 for every record of the victim institute, no
 *   victim row is even loaded while serving it, and nothing of the victim changes;
 * - branch: a user restricted to branch 1 gets 403/404 for branch 2 records;
 * - portals: student 1, guardian 1 and employee 1 get 403/404 for the records of student 2,
 *   student 2's children views and employee 2;
 * - public website: one institute's site never serves another institute's pages, media or courses;
 * - lists: list endpoints never include another institute's (or branch's) records, even when asked
 *   for them by id in the query string.
 *
 * Every probe has a positive control: the record's owner gets 2xx for the same URL, so a 404 always
 * means "denied", never "the URL was wrong". Routes the crawls cannot probe fail the coverage test.
 */
const PREFIX = '9453';
const mobile = mobileFactory('3');
const LONG = 900_000;

let routes: RouteInfo[];
let world: World;
let synthesize: Synthesize;
/** `<crawl> <METHOD> <path>` → why the crawl could not probe it. */
const uncovered = new Map<string, string>();

interface Probe {
  route: RouteInfo;
  target: Target;
}

type Res = Awaited<ReturnType<typeof send>>;
const code = (res: Res) => (res.body as { error?: { code?: string } } | undefined)?.error?.code ?? '';
const bodyText = (res: Res) =>
  res.text ?? (Buffer.isBuffer(res.body) ? res.body.toString('latin1') : JSON.stringify(res.body ?? ''));
const line = (probe: Probe, res: Res, who = '') =>
  `${routeKey(probe.route)}${who ? ` as ${who}` : ''} → ${res.status} ${code(res)} (${probe.target.url})`;

const recordRoutes = () =>
  routes.filter((r) => r.authenticated && !r.superAdmin && idParamsOf(r.path).length > 0);

async function resolveAll(list: RouteInfo[], scope: Scope, crawl: string): Promise<Probe[]> {
  const probes: Probe[] = [];
  for (const route of list) {
    const res = await resolveTarget(route, scope, { synthesize });
    if (res.target) probes.push({ route, target: res.target });
    else if (!(crawl === 'branch' && res.reason === NO_BRANCH)) {
      uncovered.set(`${crawl} ${routeKey(route)}`, res.reason);
    }
  }
  return probes;
}

/**
 * Sends every probe as `attacker` and returns the failures: GETs must answer one of `denied`,
 * writes (sent with an empty body) any 4xx; 5xx always fails; `forbidden` must not appear in a body.
 */
async function attack(
  probes: Probe[],
  attacker: Actor,
  opts: { denied: number[]; forbidden?: string; onRequest?: (label: string) => void },
): Promise<string[]> {
  const failures: string[] = [];
  for (const probe of probes) {
    const { route, target } = probe;
    opts.onRequest?.(`${routeKey(route)} (${target.url})`);
    const res = await send(attacker, route.method, target.url, isWrite(route) ? {} : undefined);
    opts.onRequest?.('');
    const allowed = OWNER_STATUS[routeKey(route)]?.status ?? [];
    const okStatus = isWrite(route)
      ? res.status >= 400 && res.status < 500
      : opts.denied.includes(res.status) || allowed.includes(res.status);
    if (!okStatus) failures.push(line(probe, res, attacker.label));
    else if (opts.forbidden && bodyText(res).includes(opts.forbidden)) {
      failures.push(`${line(probe, res, attacker.label)} leaked ${opts.forbidden}`);
    }
  }
  return failures;
}

/** Positive control: the owner reads every probed record (GET) with 2xx, or an `OWNER_STATUS`. */
async function control(probes: Probe[], owner: Actor, urlFor = (p: Probe) => p.target.url) {
  const failures: string[] = [];
  for (const probe of probes.filter((p) => !isWrite(p.route))) {
    const res = await send(owner, 'GET', urlFor(probe));
    const allowed = OWNER_STATUS[routeKey(probe.route)]?.status ?? [];
    if ((res.status < 200 || res.status >= 300) && !allowed.includes(res.status)) {
      failures.push(`positive control: ${line(probe, res, owner.label)} ${bodyText(res).slice(0, 160)}`);
    }
  }
  return failures;
}

/** Fails with every finding listed in full (arrays would be truncated in the diff). */
function expectClean(sections: Record<string, string[]>) {
  const report = Object.entries(sections)
    .filter(([, items]) => items.length)
    .map(([title, items]) => `${title} (${items.length}):\n  ${items.join('\n  ')}`)
    .join('\n');
  expect(report).toBe('');
}

beforeAll(async () => {
  routes = describeRoutes(await discoverModules());
  world = await buildWorld(mobile);
  synthesize = synthesizer(world);
}, 300_000);

afterAll(async () => {
  await purgeInstitutes([world?.attacker.id, world?.victim.id], PREFIX);
}, 300_000);

describe('tenant isolation', () => {
  it(
    'cross-tenant: every record route answers 404 to another institute, without loading or changing anything',
    async () => {
      const v = world.victim.id;
      const probes = await resolveAll(recordRoutes(), { instituteId: v }, 'cross-tenant');
      expect(probes.length).toBeGreaterThan(250);
      const before = await snapshotInstitute(v);
      const probe = installTenantProbe();
      let failures: string[];
      try {
        failures = await attack(probes, world.attacker.admin, {
          denied: [404],
          forbidden: world.marker,
          onRequest: probe.setLabel,
        });
      } finally {
        probe.remove();
      }
      const changed = snapshotChanges(before, await snapshotInstitute(v));
      failures.push(...(await control(probes, world.victim.admin)));
      expectClean({ failures, loadedVictimRows: probe.violations, changedVictimTables: changed });
    },
    LONG,
  );

  it(
    'branch: a user restricted to one branch gets 403/404 for records of another branch',
    async () => {
      const v = world.victim.id;
      const list = recordRoutes().filter((r) => !selfFamily(r.path) && !BRANCH_SHARED[routeKey(r)]);
      const probes = await resolveAll(list, { instituteId: v, branchId: world.branch2Id }, 'branch');
      expect(probes.length).toBeGreaterThan(100);
      const before = await snapshotInstitute(v);
      const failures = await attack(probes, world.restricted, {
        denied: [403, 404],
        forbidden: world.branchMarker,
      });
      const changed = snapshotChanges(
        before,
        await snapshotInstitute(v, { since: before, existingOnly: true }),
      );
      failures.push(...(await control(probes, world.victim.admin)));
      expectClean({ failures, changedVictimTables: changed });
    },
    LONG,
  );

  const portals: {
    family: Family;
    attacker: (w: World) => Actor;
    owner: (w: World) => Actor;
    scope: (w: World) => Scope;
  }[] = [
    {
      family: 'student',
      attacker: (w) => w.students.s1.actor,
      owner: (w) => w.students.s2.actor,
      scope: (w) => studentScope(w),
    },
    {
      family: 'guardian',
      attacker: (w) => w.guardians.g1.actor,
      owner: (w) => w.guardians.g2.actor,
      scope: (w) => studentScope(w),
    },
    {
      family: 'employee',
      attacker: (w) => w.employees.e1.actor,
      owner: (w) => w.employees.e2.actor,
      scope: (w) => ({
        instituteId: w.victim.id,
        ownerColumns: { employee_id: w.employees.e2.employeeId, user_id: w.employees.e2.userId },
        ownerRows: { employees: w.employees.e2.employeeId, users: w.employees.e2.userId },
      }),
    },
  ];
  const studentScope = (w: World): Scope => {
    const s2 = w.students.s2;
    return {
      instituteId: w.victim.id,
      ownerColumns: { student_user_id: s2.userId, student_id: s2.studentId, user_id: s2.userId },
      ownerRows: { students: s2.studentId, users: s2.userId },
    };
  };

  for (const portal of portals) {
    it(
      `${portal.family} portal: a ${portal.family} cannot reach another ${portal.family}'s records`,
      async () => {
        const list = recordRoutes().filter(
          (r) => selfFamily(r.path) === portal.family && !PORTAL_SHARED[routeKey(r)],
        );
        const probes = await resolveAll(list, portal.scope(world), portal.family);
        expect(probes.length).toBeGreaterThan(0);
        const before = await snapshotInstitute(world.victim.id);
        const failures = await attack(probes, portal.attacker(world), { denied: [403, 404] });
        const after = await snapshotInstitute(world.victim.id, { since: before, existingOnly: true });
        failures.push(...(await control(probes, portal.owner(world))));
        expectClean({ failures, changedVictimTables: snapshotChanges(before, after) });
      },
      LONG,
    );
  }

  it(
    "public website: one institute's site never serves another institute's records",
    async () => {
      const { attacker, victim } = world;
      const list = routes.filter(
        (r) => !r.authenticated && routeParams(r.path).includes('site') && idParamsOf(r.path).length > 0,
      );
      const probes = await resolveAll(
        list,
        { instituteId: victim.id, values: { site: attacker.slug } },
        'public',
      );
      expect(probes.length).toBeGreaterThan(5);
      const probe = installTenantProbe({ includeSystem: true });
      let failures: string[];
      try {
        failures = await attack(
          probes,
          { label: 'anonymous', token: '', userId: 0, mobile: '' },
          {
            denied: [404],
            forbidden: world.marker,
            onRequest: probe.setLabel,
          },
        );
      } finally {
        probe.remove();
      }
      const own = (p: Probe) => p.target.url.replace(`/sites/${attacker.slug}/`, `/sites/${victim.slug}/`);
      failures.push(
        ...(await control(probes, { label: 'anonymous', token: '', userId: 0, mobile: '' }, own)),
      );
      expectClean({ failures, loadedVictimRows: probe.violations });
    },
    LONG,
  );

  it(
    "lists: never include another institute's or branch's records, even when asked for them",
    async () => {
      const { victim, attacker, restricted } = world;
      const lists = routes.filter(
        (r) => r.method === 'GET' && r.authenticated && !r.superAdmin && routeParams(r.path).length === 0,
      );
      const poison = await poisonQuery(world);
      const failures: string[] = [];
      let victimSeesOwnData = 0;
      for (const r of lists) {
        const key = routeKey(r);
        const checks: [Actor, string, string, Record<string, string>][] = [
          [attacker.admin, world.marker, r.path, {}],
          [attacker.admin, world.marker, `${r.path}?${poison}`, {}],
          [restricted, world.branchMarker, r.path, {}],
          [restricted, world.branchMarker, `${r.path}?${poison}`, {}],
        ];
        for (const [who, forbidden, url, headers] of checks) {
          const res = await send(who, 'GET', url, undefined, headers);
          if (res.status >= 500)
            failures.push(`${key} as ${who.label} → ${res.status} ${code(res)} (${url})`);
          else if (bodyText(res).includes(forbidden)) failures.push(`${key} as ${who.label} leaked (${url})`);
        }
        for (const [who, branchId] of [
          [attacker.admin, victim.mainBranchId],
          [restricted, world.branch2Id],
        ] as const) {
          const res = await send(who, 'GET', r.path, undefined, { 'X-Branch-Id': String(branchId) });
          if (res.status !== 403 || code(res) !== 'BRANCH_FORBIDDEN') {
            failures.push(`${key} as ${who.label} with X-Branch-Id ${branchId} → ${res.status} ${code(res)}`);
          }
        }
        const own = await send(victim.admin, 'GET', r.path);
        if (own.status >= 500) failures.push(`${key} as victim admin → ${own.status} ${code(own)}`);
        if (bodyText(own).includes(world.marker)) victimSeesOwnData++;
      }
      expectClean({ failures });
      // The checks above mean something only if the victim's lists do contain the marker.
      expect(victimSeesOwnData).toBeGreaterThan(30);
    },
    LONG,
  );

  it('coverage: every record route is probed by the crawls it belongs to', () => {
    const missing = [...uncovered]
      .filter(([k]) => !KNOWN_UNCOVERED[k])
      .map(([k, reason]) => `${k}: ${reason}`);
    const stale = Object.keys(KNOWN_UNCOVERED).filter((k) => !uncovered.has(k));
    const keys = new Set(routes.map(routeKey));
    const staleStatus = [
      ...Object.keys(OWNER_STATUS),
      ...Object.keys(PORTAL_SHARED),
      ...Object.keys(BRANCH_SHARED),
    ].filter((k) => !keys.has(k));
    expectClean({ missing, staleKnownUncovered: stale, entriesForUnknownRoutes: staleStatus });
  });
});

/** Query string naming victim records by id under every common filter name. */
async function poisonQuery(w: World): Promise<string> {
  const tables = await tableNames();
  const first = async (table: string) =>
    tables.has(table)
      ? (
          await query<{ id: number }>(
            `SELECT id FROM \`${table}\` WHERE institute_id = ? ORDER BY id LIMIT 1`,
            [w.victim.id],
          )
        )[0]?.id
      : undefined;
  const params: Record<string, number | undefined> = {
    instituteId: w.victim.id,
    branchId: w.branch2Id,
    studentId: w.students.s3.studentId,
    studentUserId: w.students.s3.userId,
    userId: w.students.s3.userId,
    teacherUserId: w.teacherUserIds.branch2,
    employeeId: w.employees.e2.employeeId,
    guardianId: w.guardians.g2.guardianId,
    batchId: await first('batches'),
    courseId: await first('courses'),
    examId: await first('exams'),
    classId: await first('classes'),
  };
  return Object.entries(params)
    .filter(([, value]) => value !== undefined)
    .map(([k, value]) => `${k}=${value}`)
    .join('&');
}
