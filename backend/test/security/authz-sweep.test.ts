import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { discoverModules } from '../../src/infrastructure/module-loader';
import { describeRoutes, type RouteInfo } from '../../src/infrastructure/route-registry';
import { Plan } from '../../src/modules/subscriptions/models';
import { purgeRows } from '../helpers';
import { isWrite, routeKey, sampleUrl } from './crawler';
import {
  type Actor,
  type Tenant,
  createInstitute,
  createStaff,
  createSuperAdmin,
  marker,
  mobileFactory,
  ok,
  purgeInstitutes,
  send,
} from './harness';

/**
 * Authorization sweep over every route in the registry: anonymous requests get 401, users without
 * the route's permission get 403 PERMISSION_DENIED, institute users get 403 SUPER_ADMIN_ONLY on
 * platform routes and 403 MODULE_DISABLED on modules outside their plan. Routes added by any
 * module are swept automatically.
 */
const PREFIX = '9452';
const mobile = mobileFactory('2');

let routes: RouteInfo[];
let superAdmin: Actor;
let tenant: Tenant;
let gated: Tenant;
let nobody: Actor;
let planId: number | undefined;

const describeFailure = (r: RouteInfo, res: { status: number; body: { error?: { code?: string } } }) =>
  `${routeKey(r)} → ${res.status} ${res.body?.error?.code ?? ''}`.trim();

beforeAll(async () => {
  routes = describeRoutes(await discoverModules());
  superAdmin = await createSuperAdmin(mobile());
  const tag = marker('authz');
  tenant = await createInstitute(superAdmin, {
    slug: `${tag}-a`,
    name: `Authz ${tag}`,
    adminMobile: mobile(),
    label: 'institute admin',
  });
  nobody = await createStaff(tenant.admin, {
    label: 'no permissions',
    mobile: mobile(),
    permissions: [],
    branchId: null,
  });
  const plan = await ok(superAdmin, 'POST', '/api/admin/plans', {
    code: tag,
    name: `Authz no modules ${tag}`,
    priceMonthlyPaise: 0,
    priceYearlyPaise: 0,
    limits: {
      maxStudents: null,
      maxBranches: null,
      maxTeachers: null,
      storageMb: null,
      aiTokensMonthly: null,
      enabledModules: [],
    },
  });
  planId = plan.id;
  gated = await createInstitute(superAdmin, {
    slug: `${tag}-g`,
    name: `Authz gated ${tag}`,
    adminMobile: mobile(),
    label: 'gated institute admin',
    planId,
  });
  // Institutes can only be created on an active plan; hide this one from plan pickers afterwards.
  await Plan.update({ isActive: false }, { where: { id: planId } });
}, 120_000);

afterAll(async () => {
  await purgeInstitutes([tenant?.id, gated?.id], PREFIX);
  if (planId) await purgeRows('plans', [planId]);
}, 120_000);

/** Each sweep sends one request per route; allow for slow CI runners. */
const SWEEP_TIMEOUT = 120_000;

describe('authorization sweep', () => {
  it(
    'every authenticated route rejects anonymous requests with 401',
    async () => {
      const failures: string[] = [];
      for (const r of routes.filter((x) => x.authenticated)) {
        const res = await send(null, r.method, sampleUrl(r), isWrite(r) ? {} : undefined);
        if (res.status !== 401) failures.push(describeFailure(r, res));
      }
      expect(failures).toEqual([]);
    },
    SWEEP_TIMEOUT,
  );

  it(
    'every permission-guarded route returns 403 PERMISSION_DENIED without the permission',
    async () => {
      const failures: string[] = [];
      for (const r of routes.filter((x) => x.authenticated && !x.superAdmin && x.permissions.length)) {
        const res = await send(nobody, r.method, sampleUrl(r), isWrite(r) ? {} : undefined);
        if (res.status !== 403 || res.body?.error?.code !== 'PERMISSION_DENIED') {
          failures.push(describeFailure(r, res));
        }
      }
      expect(failures).toEqual([]);
    },
    SWEEP_TIMEOUT,
  );

  it(
    'self-service routes need only a signed-in user; uploads still check LMS permissions',
    async () => {
      expect((await send(nobody, 'GET', '/api/auth/me')).status).toBe(200);
      expect((await send(nobody, 'GET', '/api/auth/devices')).status).toBe(200);
      expect((await send(nobody, 'POST', '/api/lms/uploads', {})).status).toBe(403);
      expect((await send(nobody, 'POST', '/api/lms/files', {})).status).toBe(403);
    },
    SWEEP_TIMEOUT,
  );

  it(
    'platform routes return 403 SUPER_ADMIN_ONLY to institute users',
    async () => {
      const failures: string[] = [];
      for (const r of routes.filter((x) => x.superAdmin)) {
        const res = await send(tenant.admin, r.method, sampleUrl(r), isWrite(r) ? {} : undefined);
        if (res.status !== 403 || res.body?.error?.code !== 'SUPER_ADMIN_ONLY') {
          failures.push(describeFailure(r, res));
        }
      }
      expect(failures).toEqual([]);
    },
    SWEEP_TIMEOUT,
  );

  it(
    'routes of modules outside the plan return 403 MODULE_DISABLED',
    async () => {
      const failures: string[] = [];
      const gatedRoutes = routes.filter((x) => x.authenticated && !x.superAdmin && x.planModules.length);
      expect(gatedRoutes.length).toBeGreaterThan(100);
      for (const r of gatedRoutes) {
        const res = await send(gated.admin, r.method, sampleUrl(r), isWrite(r) ? {} : undefined);
        if (res.status !== 403 || res.body?.error?.code !== 'MODULE_DISABLED') {
          failures.push(describeFailure(r, res));
        }
      }
      expect(failures).toEqual([]);
    },
    SWEEP_TIMEOUT,
  );
});
