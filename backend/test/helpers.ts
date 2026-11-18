import crypto from 'node:crypto';
import request from 'supertest';
import type { Express } from 'express';
import { bootstrap } from '../src/bootstrap';
import { createApp } from '../src/app';
import { consoleOutbox } from '../src/infrastructure/messaging/console.provider';
import { getSequelize } from '../src/infrastructure/database/sequelize';

let app: Express | null = null;

export async function getApp(): Promise<Express> {
  if (!app) app = createApp(await bootstrap()) as Express;
  return app;
}

export const DEMO_PASSWORD = 'Password@123';
/** Seeded users: 91… = Apex, 92… = Zenith; suffix 1 admin, 2 branch admin, 3 accountant, 4 teacher, 5 student, 6 parent. */
export const USERS = {
  superAdmin: { mobile: '9000000000', password: 'Admin@12345' },
  apexAdmin: { mobile: '9100000001', password: DEMO_PASSWORD },
  apexBranchAdmin: { mobile: '9100000002', password: DEMO_PASSWORD },
  apexTeacher: { mobile: '9100000004', password: DEMO_PASSWORD },
  zenithAdmin: { mobile: '9200000001', password: DEMO_PASSWORD },
};

/** Same device per user across the run, so only the very first login registers a device. */
export type TestDevice = { uid: string; platform: 'web' | 'android' | 'ios' };
export const stableDevice = (mobile: string): TestDevice => ({
  uid: `test-device-${mobile}`,
  platform: 'web',
});
export const newDevice = (platform: 'web' | 'android' | 'ios' = 'web') => ({
  uid: `test-${crypto.randomUUID()}`,
  platform,
});

export function lastOtpFor(mobile: string): string {
  const msg = [...consoleOutbox].reverse().find((m) => m.to === mobile && m.data?.otp);
  if (!msg) throw new Error(`No OTP sent to ${mobile}`);
  return String(msg.data!.otp);
}

/** Logs in with password, completing the new-device OTP step if required. */
export async function login(
  user: { mobile: string; password: string },
  device: TestDevice = stableDevice(user.mobile),
) {
  const a = await getApp();
  let res = await request(a)
    .post('/api/auth/login')
    .send({ identifier: user.mobile, password: user.password, device });
  if (res.body.status === 'otp_required') {
    res = await request(a)
      .post('/api/auth/otp/verify')
      .send({ challengeId: res.body.challengeId, code: lastOtpFor(user.mobile), device });
  }
  if (res.body.status !== 'authenticated') throw new Error(`Login failed: ${JSON.stringify(res.body)}`);
  return {
    accessToken: res.body.accessToken as string,
    refreshToken: res.body.refreshToken as string,
    device,
  };
}

export const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

type FkRef = { table: string; column: string; nullable: boolean; hasId: boolean };
let fkCache: Map<string, FkRef[]> | null = null;

/** Foreign keys pointing at each table's `id` (read once from information_schema). */
async function referencesTo(table: string): Promise<FkRef[]> {
  if (!fkCache) {
    const sequelize = getSequelize();
    const [rows] = await sequelize.query(
      `SELECT k.REFERENCED_TABLE_NAME AS target, k.TABLE_NAME AS tbl, k.COLUMN_NAME AS col,
              c.IS_NULLABLE AS nullable,
              EXISTS (SELECT 1 FROM information_schema.COLUMNS i
                      WHERE i.TABLE_SCHEMA = k.TABLE_SCHEMA AND i.TABLE_NAME = k.TABLE_NAME
                        AND i.COLUMN_NAME = 'id') AS hasId
         FROM information_schema.KEY_COLUMN_USAGE k
         JOIN information_schema.COLUMNS c
           ON c.TABLE_SCHEMA = k.TABLE_SCHEMA AND c.TABLE_NAME = k.TABLE_NAME AND c.COLUMN_NAME = k.COLUMN_NAME
        WHERE k.TABLE_SCHEMA = DATABASE() AND k.REFERENCED_COLUMN_NAME = 'id'`,
    );
    fkCache = new Map();
    for (const r of rows as { target: string; tbl: string; col: string; nullable: string; hasId: number }[]) {
      const list = fkCache.get(r.target) ?? [];
      list.push({ table: r.tbl, column: r.col, nullable: r.nullable === 'YES', hasId: Boolean(r.hasId) });
      fkCache.set(r.target, list);
    }
  }
  return fkCache.get(table) ?? [];
}

/**
 * Deletes test fixture rows and everything that depends on them: nullable references are cleared,
 * non-nullable ones are deleted recursively. Use in `afterAll` so suites leave no shared state behind
 * (e.g. other suites assume institute 1 has no academic sessions of theirs).
 */
export async function purgeRows(table: string, ids: (number | null | undefined)[], depth = 0): Promise<void> {
  const list = [...new Set(ids.filter((id): id is number => typeof id === 'number'))];
  if (!list.length) return;
  if (depth > 12) throw new Error(`purgeRows: reference chain too deep at ${table}`);
  const sequelize = getSequelize();
  for (const ref of await referencesTo(table)) {
    if (ref.table === table && ref.nullable) {
      await sequelize.query(
        `UPDATE \`${table}\` SET \`${ref.column}\` = NULL WHERE \`${ref.column}\` IN (?)`,
        {
          replacements: [list],
        },
      );
    } else if (ref.nullable) {
      await sequelize.query(
        `UPDATE \`${ref.table}\` SET \`${ref.column}\` = NULL WHERE \`${ref.column}\` IN (?)`,
        { replacements: [list] },
      );
    } else if (ref.hasId) {
      const [rows] = await sequelize.query(`SELECT id FROM \`${ref.table}\` WHERE \`${ref.column}\` IN (?)`, {
        replacements: [list],
      });
      await purgeRows(
        ref.table,
        (rows as { id: number }[]).map((r) => r.id),
        depth + 1,
      );
    } else {
      await sequelize.query(`DELETE FROM \`${ref.table}\` WHERE \`${ref.column}\` IN (?)`, {
        replacements: [list],
      });
    }
  }
  await sequelize.query(`DELETE FROM \`${table}\` WHERE id IN (?)`, { replacements: [list] });
}

/** Removes academic fixtures (batches → courses → sessions) and their dependants. */
export async function purgeAcademicFixtures(f: {
  batchIds?: (number | undefined)[];
  courseIds?: (number | undefined)[];
  sessionIds?: (number | undefined)[];
}) {
  await purgeRows('batches', f.batchIds ?? []);
  await purgeRows('courses', f.courseIds ?? []);
  await purgeRows('academic_sessions', f.sessionIds ?? []);
}

/** The highest id in each table now; `purgeCreatedSince` later removes the rows a suite added. */
export async function idWatermarks(tables: readonly string[]): Promise<Record<string, number>> {
  const marks: Record<string, number> = {};
  for (const table of tables) {
    const [rows] = await getSequelize().query(`SELECT COALESCE(MAX(id), 0) AS id FROM \`${table}\``);
    marks[table] = Number((rows as { id: number }[])[0].id);
  }
  return marks;
}

/**
 * Purges (with dependants, see `purgeRows`) every row created after `idWatermarks`, table by table in
 * the order given there. Test files run one at a time, so these are exactly the suite's own rows.
 */
export async function purgeCreatedSince(marks: Record<string, number>): Promise<void> {
  for (const [table, mark] of Object.entries(marks)) {
    const [rows] = await getSequelize().query(`SELECT id FROM \`${table}\` WHERE id > ?`, {
      replacements: [mark],
    });
    await purgeRows(
      table,
      (rows as { id: number }[]).map((r) => r.id),
    );
  }
}

/** Saves the matching rows; the returned function writes every column back (rows deleted since stay deleted). */
export async function snapshotRows(table: string, where: string, replacements: unknown[] = []) {
  const sequelize = getSequelize();
  const [rows] = await sequelize.query(`SELECT * FROM \`${table}\` WHERE ${where}`, { replacements });
  return async () => {
    for (const row of rows as Record<string, unknown>[]) {
      const cols = Object.keys(row).filter((c) => c !== 'id');
      const values = cols.map((c) => {
        const v = row[c];
        return v !== null && typeof v === 'object' && !(v instanceof Date) && !Buffer.isBuffer(v)
          ? JSON.stringify(v)
          : v;
      });
      await sequelize.query(
        `UPDATE \`${table}\` SET ${cols.map((c) => `\`${c}\` = ?`).join(', ')} WHERE id = ?`,
        { replacements: [...values, row.id] },
      );
    }
  };
}
