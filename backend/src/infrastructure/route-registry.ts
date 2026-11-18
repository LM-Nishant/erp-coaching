import { Router } from 'express';
import { buildApiRouter } from '../app';
import type { ModuleDefinition } from '../shared/module';
import { authenticate } from '../shared/middleware/authenticate';
import { routeGuardOf } from '../shared/middleware/authorize';
import { rateLimiterName } from '../shared/middleware/security';

/**
 * Route registry: every HTTP route under `/api` with the guards in front of it, read from the same
 * router the app serves. The authorization/tenant-isolation suite (test/security/) is driven by it,
 * so routes added by any module are checked without editing the tests.
 */
export interface RouteInfo {
  method: string;
  /** Full path, e.g. `/api/students/:id`. */
  path: string;
  /** Module that registered the route (`platform` for /api/health and /api/ready). */
  module: string;
  authenticated: boolean;
  superAdmin: boolean;
  tenant: boolean;
  /** `requirePermission` keys, e.g. `students.view`. */
  permissions: string[];
  /** `requireModule` names (plan gating). */
  planModules: string[];
  rateLimits: string[];
  /** Any other middleware and the handler, by function name (diagnostics). */
  handlers: string[];
}

type Handle = ((...args: unknown[]) => unknown) & { stack?: Layer[] };
interface Layer {
  handle: Handle;
  method?: string;
  route?: { path: string | string[]; methods: Record<string, boolean>; stack: Layer[] };
}
type RouterProto = Record<'use' | 'route', (this: { stack: Layer[] }, ...args: unknown[]) => unknown>;

const proto = (Router as unknown as { prototype: RouterProto }).prototype;

export function describeRoutes(modules: ModuleDefinition[]): RouteInfo[] {
  // Express 5 routers keep only compiled matchers, so mount paths are recorded while building.
  const mountPath = new WeakMap<Layer, string>();
  const owner = new WeakMap<Layer, string>();
  let current = 'platform';
  const { use, route } = proto;
  proto.use = function (...args) {
    const before = this.stack.length;
    const result = use.apply(this, args);
    const path =
      typeof args[0] === 'string' ? args[0] : typeof args[0] === 'function' ? '/' : String(args[0]);
    for (const layer of this.stack.slice(before)) {
      mountPath.set(layer, path);
      owner.set(layer, current);
    }
    return result;
  };
  proto.route = function (...args) {
    const before = this.stack.length;
    const result = route.apply(this, args);
    for (const layer of this.stack.slice(before)) owner.set(layer, current);
    return result;
  };
  let api: Router;
  try {
    api = buildApiRouter(modules, (name) => (current = name));
  } finally {
    proto.use = use;
    proto.route = route;
  }

  const out: RouteInfo[] = [];
  const walk = (stack: Layer[], prefix: string, inherited: Mount[], module?: string) => {
    const mounted = [...inherited];
    for (const layer of stack) {
      const mod = module ?? owner.get(layer) ?? 'unknown';
      if (layer.route) {
        const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
        for (const p of paths) {
          const full = join(prefix, p);
          const applicable = mounted.filter((m) => full === m.under || full.startsWith(`${m.under}/`));
          for (const method of Object.keys(layer.route.methods)) {
            const own = layer.route.stack.filter((l) => !l.method || l.method === method);
            out.push(
              describe(method === '_all' ? 'ALL' : method.toUpperCase(), full, mod, [
                ...applicable.map((m) => m.handle),
                ...own.map((l) => l.handle),
              ]),
            );
          }
        }
        continue;
      }
      const under = join(prefix, mountPath.get(layer) ?? '/');
      if (Array.isArray(layer.handle.stack)) walk(layer.handle.stack, under, mounted, mod);
      else mounted.push({ handle: layer.handle, under });
    }
  };
  walk((api as unknown as { stack: Layer[] }).stack, '/api', []);
  return out;
}

interface Mount {
  handle: Handle;
  under: string;
}

function join(prefix: string, path: string): string {
  if (!path || path === '/') return prefix;
  return `${prefix.replace(/\/$/, '')}/${path.replace(/^\//, '')}`;
}

function describe(method: string, path: string, module: string, chain: Handle[]): RouteInfo {
  const info: RouteInfo = {
    method,
    path,
    module,
    authenticated: false,
    superAdmin: false,
    tenant: false,
    permissions: [],
    planModules: [],
    rateLimits: [],
    handlers: [],
  };
  for (const fn of chain) {
    if (fn === (authenticate as unknown)) {
      info.authenticated = true;
      continue;
    }
    const guard = routeGuardOf(fn);
    if (guard?.type === 'permission') info.permissions.push(guard.key);
    else if (guard?.type === 'module') info.planModules.push(guard.module);
    else if (guard?.type === 'superAdmin') info.superAdmin = true;
    else if (guard?.type === 'tenant') info.tenant = true;
    else {
      const limiter = rateLimiterName(fn);
      if (limiter) info.rateLimits.push(limiter);
      else info.handlers.push(fn.name || '<anonymous>');
    }
  }
  return info;
}

/** `:id`, `:studentId`, `*file` → names. */
export function routeParams(path: string): string[] {
  return [...path.matchAll(/[:*]([A-Za-z_$][\w$]*)/g)].map((m) => m[1]);
}
