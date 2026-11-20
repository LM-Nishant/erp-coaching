import { describe, expect, it } from 'vitest';
import { discoverModules } from '../../src/infrastructure/module-loader';
import { describeRoutes, type RouteInfo } from '../../src/infrastructure/route-registry';
import { OWN_LIMITER_PATH } from '../../src/shared/middleware/security';
import {
  DEVICE_AUTHENTICATED_ROUTES,
  KNOWN_UNCOVERED,
  OWNER_STATUS,
  PORTAL_SHARED,
  PUBLIC_OUTSIDE_PUBLIC_PREFIX,
  SELF_SERVICE_ROUTES,
} from './coverage';
import { routeKey } from './crawler';

/**
 * Structural checks on the route registry: every route is guarded the way ARCHITECTURE.md says,
 * so a new route without authentication, a permission or a rate limit fails here before review.
 */
let cache: RouteInfo[] | undefined;
const allRoutes = async () => (cache ??= describeRoutes(await discoverModules()));

const DEVICE_LIMITERS = new Set(['device', 'adms']);
const ANONYMOUS_LIMITERS = new Set(['auth', 'token', 'media', 'webhook', 'public-form', ...DEVICE_LIMITERS]);

describe('route registry', () => {
  it('lists every module route with its guards', async () => {
    const routes = await allRoutes();
    expect(routes.length).toBeGreaterThan(100);
    expect(routes.filter((r) => r.module === 'unknown').map(routeKey)).toEqual([]);
    const keys = routes.map(routeKey);
    expect(keys.filter((k, i) => keys.indexOf(k) !== i)).toEqual([]);
    expect(routes.every((r) => r.path.startsWith('/api/') && r.path !== '/api/')).toBe(true);
  });

  it('public routes live under /api/public unless allow-listed', async () => {
    const routes = await allRoutes();
    const offenders = routes
      .filter((r) => !r.authenticated && !/\/public(\/|$)/.test(r.path))
      .map(routeKey)
      .filter((k) => !PUBLIC_OUTSIDE_PUBLIC_PREFIX[k]);
    expect(offenders, 'public route outside /api/public — move it or add authenticate').toEqual([]);
  });

  it('platform routes require a super admin', async () => {
    const routes = await allRoutes();
    expect(routes.filter((r) => r.path.startsWith('/api/admin/') && !r.superAdmin).map(routeKey)).toEqual([]);
    expect(routes.filter((r) => r.superAdmin && !r.authenticated).map(routeKey)).toEqual([]);
  });

  it('authenticated institute routes require a permission unless self-service', async () => {
    const routes = await allRoutes();
    const offenders = routes
      .filter((r) => r.authenticated && !r.superAdmin && !r.permissions.length)
      .map(routeKey)
      .filter((k) => !SELF_SERVICE_ROUTES[k]);
    expect(offenders, 'add requirePermission(...) or list it in SELF_SERVICE_ROUTES').toEqual([]);
  });

  it('every route is rate limited, and anonymous writes have a dedicated limiter', async () => {
    const routes = await allRoutes();
    expect(routes.filter((r) => !r.rateLimits.includes('api')).map(routeKey)).toEqual([]);
    const offenders = routes
      .filter((r) => !r.authenticated && r.method !== 'GET')
      .filter((r) => !r.rateLimits.some((l) => ANONYMOUS_LIMITERS.has(l)))
      .map(routeKey);
    expect(offenders, 'use publicFormRateLimit (or another dedicated limiter)').toEqual([]);
  });

  it('routes the api limiter skips have their own limiter', async () => {
    const skipped = (await allRoutes()).filter((r) => OWN_LIMITER_PATH.test(r.path.slice('/api'.length)));
    expect(skipped.length).toBeGreaterThan(10);
    expect(skipped.filter((r) => !r.rateLimits.some((l) => l !== 'api')).map(routeKey)).toEqual([]);
    // Signed file and HLS URLs are also limited per token, so a shared link can't be replayed at volume.
    expect(
      skipped.filter((r) => r.path.includes(':token') && !r.rateLimits.includes('media-token')).map(routeKey),
    ).toEqual([]);
    expect(
      skipped
        .filter((r) => r.path.startsWith('/api/public/sites/') && r.method === 'GET')
        .filter((r) => !r.rateLimits.includes('website') && !r.rateLimits.includes('media'))
        .map(routeKey),
      'use websiteRateLimit on public website pages',
    ).toEqual([]);
  });

  it('device-authenticated routes are listed with how the device is identified', async () => {
    const device = (await allRoutes())
      .filter((r) => !r.authenticated && r.rateLimits.some((l) => DEVICE_LIMITERS.has(l)))
      .map(routeKey);
    expect(
      device.filter((k) => !DEVICE_AUTHENTICATED_ROUTES[k]),
      'add it to DEVICE_AUTHENTICATED_ROUTES with how the device is identified',
    ).toEqual([]);
    expect(
      Object.keys(DEVICE_AUTHENTICATED_ROUTES).filter((k) => !device.includes(k)),
      'DEVICE_AUTHENTICATED_ROUTES entry without a public device route behind the device or adms limiter',
    ).toEqual([]);
  });

  it('allow-lists and exceptions only name existing routes', async () => {
    const keys = new Set((await allRoutes()).map(routeKey));
    const lists = {
      DEVICE_AUTHENTICATED_ROUTES,
      SELF_SERVICE_ROUTES,
      PUBLIC_OUTSIDE_PUBLIC_PREFIX,
      PORTAL_SHARED,
      OWNER_STATUS,
      KNOWN_UNCOVERED,
    };
    const stale = Object.entries(lists).flatMap(([name, list]) =>
      Object.keys(list)
        .filter((k) => !keys.has(k))
        .map((k) => `${name}['${k}']`),
    );
    expect(stale, 'remove entries for routes that no longer exist').toEqual([]);
  });
});
