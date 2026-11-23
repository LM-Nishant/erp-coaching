import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { QueryTypes } from 'sequelize';
import { getApp, idWatermarks, purgeCreatedSince } from './helpers';
import { getSequelize } from '../src/infrastructure/database/sequelize';
import { OUTBOUND_SUPPRESSED_REASON, seedRichDemo } from '../src/infrastructure/database/demo/seed';

const q = <T extends object>(sql: string, replacements: unknown[] = []) =>
  getSequelize().query<T>(sql, { replacements, type: QueryTypes.SELECT });

/** Every table with a numeric id, so the suite can count and later purge what the seed added. */
async function idTables(): Promise<string[]> {
  const rows = await q<{ t: string }>(
    `SELECT table_name AS t FROM information_schema.columns
      WHERE table_schema = DATABASE() AND column_name = 'id' AND data_type IN ('int', 'bigint')
      ORDER BY table_name`,
  );
  return rows.map((r) => r.t);
}

async function rowCounts(tables: string[]) {
  const counts: Record<string, number> = {};
  for (const t of tables)
    counts[t] = Number((await q<{ n: number }>(`SELECT COUNT(*) AS n FROM \`${t}\``))[0].n);
  return counts;
}

const count = async (sql: string, replacements: unknown[] = []) =>
  Number((await q<{ n: number }>(sql, replacements))[0].n);

describe('rich demo data seed', () => {
  let app: Express;
  let tables: string[];
  let marks: Record<string, number>;
  let apexId: number;

  beforeAll(async () => {
    app = await getApp();
    tables = await idTables();
    marks = await idWatermarks(tables);
    apexId = (await q<{ id: number }>("SELECT id FROM institutes WHERE slug = 'apex'"))[0].id;
  });

  afterAll(async () => {
    if (marks) await purgeCreatedSince(marks);
  }, 300_000);

  it('fills every module and re-running it changes nothing', async () => {
    const summary = await seedRichDemo({ app, log: () => {} });
    expect(summary.institutes.map((i) => i.slug)).toEqual(['apex', 'zenith']);
    const after1 = await rowCounts(tables);

    const inApex = (table: string, where = '1 = 1') =>
      count(`SELECT COUNT(*) AS n FROM \`${table}\` WHERE institute_id = ? AND id > ? AND ${where}`, [
        apexId,
        marks[table],
      ]);

    expect(await inApex('students')).toBeGreaterThanOrEqual(40);
    expect(await inApex('batches')).toBe(4);
    expect(await inApex('class_schedules')).toBe(24);
    expect(await inApex('attendance_records')).toBeGreaterThan(500);
    expect(await inApex('exams', 'results_published_at IS NOT NULL')).toBe(2);
    expect(await inApex('exam_attempts', "status <> 'in_progress'")).toBeGreaterThan(10);
    expect(await inApex('fee_receipts')).toBeGreaterThan(20);
    expect(await inApex('finance_entries')).toBeGreaterThan(20);
    expect(await inApex('enquiries')).toBe(8);
    expect(await inApex('lms_resources', "status = 'published'")).toBeGreaterThan(5);
    expect(await inApex('lms_submissions')).toBeGreaterThan(10);
    expect(await inApex('live_sessions')).toBe(4);
    expect(await inApex('payroll_runs', "status = 'locked'")).toBe(1);
    expect(await inApex('notification_campaigns')).toBe(3);
    expect(await inApex('grievance_tickets')).toBe(2);
    expect(await inApex('appointments')).toBe(1);

    // Paid, part-paid and overdue fee accounts.
    const balances = await q<{ paid: number; balance: number; overdue: number }>(
      `SELECT a.paid, (a.gross - a.discount + a.charges + a.late_fee - a.paid) AS balance,
              (SELECT COUNT(*) FROM fee_instalments i WHERE i.account_id = a.id AND i.due_date < CURDATE()
                 AND i.amount > i.paid) AS overdue
         FROM fee_accounts a WHERE a.institute_id = ? AND a.id > ?`,
      [apexId, marks.fee_accounts],
    );
    expect(balances.some((b) => Number(b.balance) === 0)).toBe(true);
    expect(balances.some((b) => Number(b.paid) > 0 && Number(b.overdue) > 0)).toBe(true);
    expect(balances.some((b) => Number(b.paid) === 0 && Number(b.overdue) > 0)).toBe(true);

    // The demo student login is now a real student with the demo parent as guardian…
    const demo = await q<{ guardian: string }>(
      `SELECT gu.mobile AS guardian FROM students s JOIN users u ON u.id = s.user_id
         JOIN student_guardians sg ON sg.student_id = s.id JOIN guardians g ON g.id = sg.guardian_id
         JOIN users gu ON gu.id = g.user_id
        WHERE u.mobile = '9100000005' AND s.institute_id = ?`,
      [apexId],
    );
    expect(demo.map((d) => d.guardian)).toEqual(['9100000006']);
    // …siblings sign in on one mobile, and no seed device is left behind (logins stay OTP-free).
    expect(
      await count("SELECT COUNT(*) AS n FROM users WHERE shared_mobile LIKE '962%'"),
    ).toBeGreaterThanOrEqual(2);
    expect(await count("SELECT COUNT(*) AS n FROM devices WHERE device_uid LIKE 'demo-seed-%'")).toBe(0);

    // Nothing reached a real person: external notifications were recorded as skipped, no provider
    // was called, and no job is left for another worker except ones scheduled for later.
    const external = await q<{ status: string; lastError: string; n: number }>(
      `SELECT status, last_error AS lastError, COUNT(*) AS n FROM notification_messages
        WHERE id > ? AND channel <> 'in_app' GROUP BY status, last_error`,
      [marks.notification_messages],
    );
    expect(external.some((e) => e.lastError === OUTBOUND_SUPPRESSED_REASON && e.n > 0)).toBe(true);
    expect(external.every((e) => e.status === 'skipped')).toBe(true);
    expect(await inApex('notification_messages', "channel = 'in_app'")).toBeGreaterThan(50);
    expect(
      await count('SELECT COUNT(*) AS n FROM notification_delivery_attempts WHERE id > ?', [
        marks.notification_delivery_attempts,
      ]),
    ).toBe(0);
    expect(
      await count(
        "SELECT COUNT(*) AS n FROM jobs WHERE id > ? AND status = 'pending' AND run_at <= UTC_TIMESTAMP()",
        [marks.jobs],
      ),
    ).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM jobs WHERE run_at >= '2999-01-01'")).toBe(0);

    await seedRichDemo({ app, log: () => {} });
    expect(await rowCounts(tables)).toEqual(after1);
  }, 900_000);
});
