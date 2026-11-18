import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PLAN_MODULE_KEYS } from '@erp/shared';
import { getSequelize } from '../src/infrastructure/database/sequelize';
import { discoverModules } from '../src/infrastructure/module-loader';
import { describeRoutes } from '../src/infrastructure/route-registry';
import { REPORT_DEFINITIONS } from '../src/modules/reports/definitions';
import { Plan } from '../src/modules/subscriptions/models';
import {
  ADDED_MODULE_KEYS,
  up as addModuleKeys,
  withAddedModuleKeys,
} from '../src/modules/subscriptions/migrations/20261118120000-add-plan-module-keys';
import { USERS, bearer, getApp, login } from './helpers';

/** Keys that existed when plans first got `enabledModules`; explicit lists already chose them. */
const BASELINE_KEYS = [
  'academics',
  'admissions',
  'ai',
  'appointments',
  'attendance',
  'exams',
  'fees',
  'grievances',
  'hr',
  'live-classes',
  'lms',
  'parent-portal',
  'payroll',
  'question-bank',
  'students',
  'website',
];
/** Newer keys deliberately not appended to existing explicit lists (none so far). */
const INTENTIONALLY_EXCLUDED: string[] = [];

const KNOWN = new Set<string>(PLAN_MODULE_KEYS);
const RUN = Date.now().toString(36);

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name !== 'node_modules' && name !== 'dist') sourceFiles(path, out);
    } else if (/\.(ts|vue)$/.test(name) && !/\.test\.ts$/.test(name)) out.push(path);
  }
  return out;
}

/** Literal module keys passed to `isModuleEnabled` / `includes` checks / menu `planModule`. */
function literalKeys(dirs: string[]): Map<string, string> {
  const found = new Map<string, string>();
  const patterns = [
    /isModuleEnabled\([^,()]+,\s*'([a-z-]+)'/g,
    /enabledModules\.includes\('([a-z-]+)'\)/g,
    /planModule:\s*'([a-z-]+)'/g,
    /requireModule\('([a-z-]+)'\)/g,
  ];
  for (const file of dirs.flatMap((d) => sourceFiles(d))) {
    const text = readFileSync(file, 'utf8');
    for (const re of patterns) for (const m of text.matchAll(re)) found.set(m[1], file);
  }
  return found;
}

describe('plan module keys', () => {
  let planId: number | undefined;

  beforeAll(async () => {
    await getApp();
  });

  afterAll(async () => {
    if (planId) await Plan.destroy({ where: { id: planId } });
  });

  it('every module key the code checks is a known plan module key', async () => {
    const used = new Map<string, string>();
    for (const r of describeRoutes(await discoverModules()))
      for (const m of r.planModules) used.set(m, `${r.method} ${r.path}`);
    for (const def of REPORT_DEFINITIONS.values()) {
      used.set(def.planModule, `report ${def.key}`);
      for (const s of def.sources ?? []) used.set(s.planModule, `report ${def.key} source ${s.key}`);
    }
    for (const [key, where] of literalKeys([join(__dirname, '../src'), join(__dirname, '../../app/src')]))
      used.set(key, where);
    const unknown = [...used].filter(([key]) => !KNOWN.has(key));
    expect(unknown, 'add these to PLAN_MODULE_KEYS (and a plan migration)').toEqual([]);
  });

  it('every newer module key is appended to existing plans or intentionally excluded', () => {
    const newer = PLAN_MODULE_KEYS.filter((k) => !BASELINE_KEYS.includes(k));
    const handled = new Set<string>([...ADDED_MODULE_KEYS, ...INTENTIONALLY_EXCLUDED]);
    expect(newer.filter((k) => !handled.has(k))).toEqual([]);
    expect(ADDED_MODULE_KEYS).toContain('reports');
  });

  it('appends added keys to explicit enabledModules lists and leaves "all modules" alone', async () => {
    expect(withAddedModuleKeys({ enabledModules: null })).toBeNull();
    expect(withAddedModuleKeys('{"enabledModules":["fees","reports"]}')).toBeNull();
    expect(withAddedModuleKeys({ maxStudents: 5, enabledModules: ['fees'] })).toEqual({
      maxStudents: 5,
      enabledModules: ['fees', ...ADDED_MODULE_KEYS],
    });

    const plan = await Plan.create({
      code: `pm-${RUN}`,
      name: 'Plan modules guard',
      priceMonthlyPaise: 0,
      priceYearlyPaise: 0,
      limits: {
        maxStudents: null,
        maxBranches: null,
        maxTeachers: null,
        storageMb: null,
        aiTokensMonthly: null,
        enabledModules: ['attendance'],
      },
    });
    planId = plan.id;
    await addModuleKeys({ context: { queryInterface: getSequelize().getQueryInterface() } });
    await plan.reload();
    expect(plan.limits.enabledModules).toEqual(['attendance', ...ADDED_MODULE_KEYS]);
    // Seeded plans (and anything else with a null list) still enable every module.
    for (const seeded of await Plan.findAll({ where: { code: ['starter', 'growth'] } }))
      expect(seeded.limits.enabledModules).toBeNull();
  });

  it('rejects unknown module keys on plans', async () => {
    const sa = (await login(USERS.superAdmin)).accessToken;
    const res = await request(await getApp())
      .post('/api/admin/plans')
      .set(bearer(sa))
      .send({
        code: `pm-bad-${RUN}`,
        name: 'Bad modules',
        priceMonthlyPaise: 0,
        priceYearlyPaise: 0,
        limits: {
          maxStudents: null,
          maxBranches: null,
          maxTeachers: null,
          storageMb: null,
          aiTokensMonthly: null,
          enabledModules: ['fees', 'files'],
        },
      });
    expect(res.status).toBe(422);
  });
});
