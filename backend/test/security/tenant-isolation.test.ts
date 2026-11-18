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
import {
  BRANCH_SHARED,
  KNOWN_FINDINGS,
  KNOWN_UNCOVERED,
  OWNER_STATUS,
  PARAM_SQL,
  PORTAL_SHARED,
  ROUTE_QUERY,
  UNIFORM_RESPONSE,
} from './coverage';
import {
  type Actor,
  installTenantProbe,
  lastServerError,
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
 * - cross-tenant: another institute's admin (and, for self-service routes, its student, guardian or
 *   employee) gets 404 for every record of the victim institute, no victim row is even loaded while
 *   serving it, and nothing of the victim changes;
 * - branch: a user restricted to branch 1 gets 403/404 for branch 2 records;
 * - portals: student 1, guardian 1 and employee 1 get 403/404 for the records of student 2,
 *   student 2's children views and employee 2;
 * - public website: one institute's site never serves another institute's pages, media or courses;
 * - lists: list endpoints never include another institute's (or branch's) records, even when asked
 *   for them by id in the query string.
 *
 * Every probe has a positive control: the record's owner gets 2xx/3xx for the same URL, so a 404
 * always means "denied", never "the URL was wrong". Routes the crawls cannot probe fail the coverage
 * test; open findings are listed in KNOWN_FINDINGS (coverage.ts) until fixed.
 */
const PREFIX = '9453';
const mobile = mobileFactory('3');
const LONG = 900_000;

let routes: RouteInfo[];
let world: World;
let synthesize: Synthesize;
/** `<crawl> <METHOD> <path>` → why the crawl could not probe it. */
const uncovered = new Map<string, string>();
/** Crawls that ran, and the KNOWN_FINDINGS entries that did fail in them (others are stale). */
const crawlsRun = new Set<string>();
const findingsSeen = new Set<string>();
const ANONYMOUS: Actor = { label: 'anonymous', token: '', userId: 0, mobile: '' };

interface Probe {
  route: RouteInfo;
  target: Target;
}

type Res = Awaited<ReturnType<typeof send>>;
const code = (res: Res) => (res.body as { error?: { code?: string } } | undefined)?.error?.code ?? '';
const bodyText = (res: Res) =>
  res.text ?? (Buffer.isBuffer(res.body) ? res.body.toString('latin1') : JSON.stringify(res.body ?? ''));
/** Why a 5xx happened (the logged error and where), for failure messages. */
const crash = (res: Res) => (res.status >= 500 && lastServerError() ? ` [${lastServerError()}]` : '');
const line = (probe: Probe, res: Res, who = '', url = probe.target.url) =>
  `${routeKey(probe.route)}${who ? ` as ${who}` : ''} → ${res.status} ${code(res)} (${url})${crash(res)}`;

/** Records `failure` of `key` in `crawl`, unless it is a KNOWN_FINDINGS entry (then marks it seen). */
function fail(failures: string[], crawl: string, key: string, failure: string) {
  const finding = `${crawl} ${key}`;
  if (KNOWN_FINDINGS[finding]) findingsSeen.add(finding);
  else failures.push(failure);
}

const studentScope = (w: World): Scope => {
  const s2 = w.students.s2;
  return {
    instituteId: w.victim.id,
    ownerColumns: { student_user_id: s2.userId, student_id: s2.studentId, user_id: s2.userId },
    ownerRows: { students: s2.studentId, users: s2.userId },
  };
};

/**
 * Self-service route families: the owner of the probed records, another user of the same family in
 * the victim institute (portal crawl) and one in the attacker institute (cross-tenant crawl).
 */
const PORTALS: {
  family: Family;
  owner: (w: World) => Actor;
  attacker: (w: World) => Actor;
  outsider: (w: World) => Actor;
  scope: (w: World) => Scope;
}[] = [
  {
    family: 'student',
    owner: (w) => w.students.s2.actor,
    attacker: (w) => w.students.s1.actor,
    outsider: (w) => w.attackerPersonas.student,
    scope: studentScope,
  },
  {
    family: 'guardian',
    owner: (w) => w.guardians.g2.actor,
    attacker: (w) => w.guardians.g1.actor,
    outsider: (w) => w.attackerPersonas.guardian,
    scope: studentScope,
  },
  {
    family: 'employee',
    owner: (w) => w.employees.e2.actor,
    attacker: (w) => w.employees.e1.actor,
    outsider: (w) => w.attackerPersonas.employee,
    scope: (w) => ({
      instituteId: w.victim.id,
      ownerColumns: { employee_id: w.employees.e2.employeeId, user_id: w.employees.e2.userId },
      ownerRows: { employees: w.employees.e2.employeeId, users: w.employees.e2.userId },
    }),
  },
];

const recordRoutes = () =>
  routes.filter((r) => r.authenticated && !r.superAdmin && idParamsOf(r.path).length > 0);

async function resolveAll(list: RouteInfo[], scope: Scope, crawl: string): Promise<Probe[]> {
  crawlsRun.add(crawl);
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
 * writes (sent with an empty body) any 4xx, UNIFORM_RESPONSE routes anything below 500; 5xx always
 * fails; `forbidden` must not appear in a body. KNOWN_FINDINGS of `crawl` are tolerated.
 */
async function attack(
  crawl: string,
  probes: Probe[],
  attacker: Actor,
  opts: { denied: number[]; forbidden?: string; onRequest?: (label: string) => void },
): Promise<string[]> {
  const failures: string[] = [];
  for (const probe of probes) {
    const { route, target } = probe;
    const key = routeKey(route);
    opts.onRequest?.(`${key} (${target.url})`);
    const res = await send(attacker, route.method, target.url, isWrite(route) ? {} : undefined);
    opts.onRequest?.('');
    const allowed = OWNER_STATUS[key]?.status ?? [];
    const okStatus = UNIFORM_RESPONSE[key]
      ? res.status < 500
      : isWrite(route)
        ? res.status >= 400 && res.status < 500
        : opts.denied.includes(res.status) || allowed.includes(res.status);
    if (!okStatus) fail(failures, crawl, key, line(probe, res, attacker.label));
    else if (opts.forbidden && bodyText(res).includes(opts.forbidden)) {
      fail(failures, crawl, key, `${line(probe, res, attacker.label)} leaked ${opts.forbidden}`);
    }
  }
  return failures;
}

/** Positive control: the owner reads every probed record (GET) with 2xx/3xx, or an `OWNER_STATUS`. */
async function control(probes: Probe[], owner: Actor, urlFor = (p: Probe) => p.target.url) {
  const failures: string[] = [];
  for (const probe of probes.filter((p) => !isWrite(p.route))) {
    const url = urlFor(probe);
    const res = await send(owner, 'GET', url);
    const allowed = OWNER_STATUS[routeKey(probe.route)]?.status ?? [];
    if ((res.status < 200 || res.status >= 400) && !allowed.includes(res.status)) {
      failures.push(`positive control: ${line(probe, res, owner.label, url)} ${bodyText(res).slice(0, 160)}`);
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
      // Self-service routes are probed on records of their owner, also by the outsider of that family.
      const groups = [
        {
          probes: await resolveAll(
            recordRoutes().filter((r) => !selfFamily(r.path)),
            { instituteId: v },
            'cross-tenant',
          ),
          owner: world.victim.admin,
          attackers: [world.attacker.admin],
        },
      ];
      for (const portal of PORTALS) {
        groups.push({
          probes: await resolveAll(
            recordRoutes().filter((r) => selfFamily(r.path) === portal.family),
            portal.scope(world),
            'cross-tenant',
          ),
          owner: portal.owner(world),
          attackers: [world.attacker.admin, portal.outsider(world)],
        });
      }
      expect(groups.reduce((n, g) => n + g.probes.length, 0)).toBeGreaterThan(250);
      const before = await snapshotInstitute(v);
      const probe = installTenantProbe();
      const failures: string[] = [];
      try {
        for (const group of groups) {
          for (const attacker of group.attackers) {
            failures.push(
              ...(await attack('cross-tenant', group.probes, attacker, {
                denied: [404],
                forbidden: world.marker,
                onRequest: probe.setLabel,
              })),
            );
          }
        }
      } finally {
        probe.remove();
      }
      const changed = snapshotChanges(before, await snapshotInstitute(v));
      for (const group of groups) failures.push(...(await control(group.probes, group.owner)));
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
      const failures = await attack('branch', probes, world.restricted, {
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

  for (const portal of PORTALS) {
    it(
      `${portal.family} portal: a ${portal.family} cannot reach another ${portal.family}'s records`,
      async () => {
        const list = recordRoutes().filter(
          (r) => selfFamily(r.path) === portal.family && !PORTAL_SHARED[routeKey(r)],
        );
        const probes = await resolveAll(list, portal.scope(world), portal.family);
        expect(probes.length).toBeGreaterThan(0);
        const before = await snapshotInstitute(world.victim.id);
        const failures = await attack(portal.family, probes, portal.attacker(world), {
          denied: [403, 404],
        });
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
        failures = await attack('public', probes, ANONYMOUS, {
          denied: [404],
          forbidden: world.marker,
          onRequest: probe.setLabel,
        });
      } finally {
        probe.remove();
      }
      const own = (p: Probe) => p.target.url.replace(`/sites/${attacker.slug}/`, `/sites/${victim.slug}/`);
      failures.push(...(await control(probes, ANONYMOUS, own)));
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
      crawlsRun.add('tenant-lists').add('branch-lists');
      for (const r of lists) {
        const key = routeKey(r);
        const extra = ROUTE_QUERY[key] ? new URLSearchParams(ROUTE_QUERY[key]).toString() : '';
        const path = extra ? `${r.path}?${extra}` : r.path;
        const poisoned = `${path}${extra ? '&' : '?'}${poison}`;
        const checks: [string, Actor, string, string][] = [
          ['tenant-lists', attacker.admin, world.marker, path],
          ['tenant-lists', attacker.admin, world.marker, poisoned],
          ['branch-lists', restricted, world.branchMarker, path],
          ['branch-lists', restricted, world.branchMarker, poisoned],
        ];
        for (const [crawl, who, forbidden, url] of checks) {
          const res = await send(who, 'GET', url);
          if (res.status >= 500) {
            fail(
              failures,
              crawl,
              key,
              `${key} as ${who.label} → ${res.status} ${code(res)} (${url})${crash(res)}`,
            );
          } else if (bodyText(res).includes(forbidden)) {
            fail(failures, crawl, key, `${key} as ${who.label} leaked ${forbidden} (${url})`);
          }
        }
        for (const [crawl, who, branchId] of [
          ['tenant-lists', attacker.admin, victim.mainBranchId],
          ['branch-lists', restricted, world.branch2Id],
        ] as const) {
          const res = await send(who, 'GET', path, undefined, { 'X-Branch-Id': String(branchId) });
          if (res.status !== 403 || code(res) !== 'BRANCH_FORBIDDEN') {
            fail(
              failures,
              crawl,
              key,
              `${key} as ${who.label} with X-Branch-Id ${branchId} → ${res.status} ${code(res)}`,
            );
          }
        }
        const own = await send(victim.admin, 'GET', path);
        if (own.status >= 500)
          failures.push(`${key} as victim admin → ${own.status} ${code(own)}${crash(own)}`);
        if (bodyText(own).includes(world.marker)) victimSeesOwnData++;
      }
      expectClean({ failures });
      // The checks above mean something only if the victim's lists do contain the marker.
      expect(victimSeesOwnData).toBeGreaterThan(30);
    },
    LONG,
  );

  it('coverage: every record route is probed by the crawls it belongs to', () => {
    const crawlOf = (k: string) => k.slice(0, k.indexOf(' '));
    const missing = [...uncovered]
      .filter(([k]) => !KNOWN_UNCOVERED[k])
      .map(([k, reason]) => `${k}: ${reason}`);
    const staleUncovered = Object.keys(KNOWN_UNCOVERED).filter(
      (k) => crawlsRun.has(crawlOf(k)) && !uncovered.has(k),
    );
    const staleFindings = Object.keys(KNOWN_FINDINGS).filter(
      (k) => crawlsRun.has(crawlOf(k)) && !findingsSeen.has(k),
    );
    const keys = new Set(routes.map(routeKey));
    const unknownRoutes = [
      ...Object.keys(OWNER_STATUS),
      ...Object.keys(PORTAL_SHARED),
      ...Object.keys(BRANCH_SHARED),
      ...Object.keys(UNIFORM_RESPONSE),
      ...Object.keys(ROUTE_QUERY),
      ...Object.keys(PARAM_SQL).filter((k) => /^[A-Z]+ \//.test(k)),
      ...[...Object.keys(KNOWN_UNCOVERED), ...Object.keys(KNOWN_FINDINGS)].map((k) =>
        k.slice(k.indexOf(' ') + 1),
      ),
    ].filter((k) => !keys.has(k));
    expectClean({
      missing,
      staleKnownUncovered: staleUncovered,
      fixedKnownFindings: staleFindings,
      entriesForUnknownRoutes: unknownRoutes,
    });
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
