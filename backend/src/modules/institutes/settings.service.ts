import { InstituteSetting } from './institute-setting.model';
import { requireTenantContext } from '../../shared/context';

/** Read an institute setting for the current tenant. */
export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const { instituteId } = requireTenantContext();
  const row = await InstituteSetting.findOne({ where: { instituteId, key } });
  return row ? (row.value as T) : fallback;
}

export async function setSetting(key: string, value: unknown): Promise<void> {
  const { instituteId } = requireTenantContext();
  const row = await InstituteSetting.findOne({ where: { instituteId, key } });
  if (row) await row.update({ value });
  else await InstituteSetting.create({ instituteId, key, value });
}

export async function getAllSettings(): Promise<Record<string, unknown>> {
  const { instituteId } = requireTenantContext();
  const rows = await InstituteSetting.findAll({ where: { instituteId } });
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}
