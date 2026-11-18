import { QueryTypes } from 'sequelize';
import type { Migration } from '../../../infrastructure/database/migration-helpers';

/**
 * Plan module keys introduced after plans could already carry an explicit `enabledModules` list.
 * A plan (or subscription override) that lists its modules predates these keys, so it gets them
 * appended; `null` lists (all modules) are left alone. Append future keys in a new migration.
 */
export const ADDED_MODULE_KEYS = ['reports'] as const;

type Row = { id: number; value: unknown };

const parse = (value: unknown): Record<string, unknown> | null => {
  const v = typeof value === 'string' ? (JSON.parse(value) as unknown) : value;
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
};

/** `limits` with the added keys appended to an explicit `enabledModules` list, or null when unchanged. */
export function withAddedModuleKeys(value: unknown): Record<string, unknown> | null {
  const limits = parse(value);
  const list = limits?.enabledModules;
  if (!limits || !Array.isArray(list)) return null;
  const missing = ADDED_MODULE_KEYS.filter((k) => !list.includes(k));
  return missing.length ? { ...limits, enabledModules: [...list, ...missing] } : null;
}

export const up: Migration = async ({ context: { queryInterface: q } }) => {
  for (const [table, column] of [
    ['plans', 'limits'],
    ['subscriptions', 'limit_overrides'],
  ] as const) {
    const rows = await q.sequelize.query<Row>(
      `SELECT id, ${column} AS value FROM ${table} WHERE ${column} IS NOT NULL`,
      { type: QueryTypes.SELECT },
    );
    for (const row of rows) {
      const next = withAddedModuleKeys(row.value);
      if (next)
        await q.sequelize.query(`UPDATE ${table} SET ${column} = :value WHERE id = :id`, {
          replacements: { value: JSON.stringify(next), id: row.id },
        });
    }
  }
};

/** The appended keys are indistinguishable from ones an admin chose, so they stay. */
export const down: Migration = async () => {};
