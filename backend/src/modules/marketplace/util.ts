import crypto from 'node:crypto';
import { MktSettings } from './models';

export const MARKETPLACE = 'marketplace';

export const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);

/** URL slug from a title: lowercase ASCII words joined by dashes. */
export function slugify(text: string, max = 80): string {
  const s = text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
  return s || 'item';
}

/** `base`, or `base-<random>` when taken. */
export async function uniqueSlug(base: string, taken: (slug: string) => Promise<boolean>): Promise<string> {
  const root = slugify(base);
  if (!(await taken(root))) return root;
  for (let i = 0; i < 5; i++) {
    const s = `${root.slice(0, 70)}-${crypto.randomBytes(3).toString('hex')}`;
    if (!(await taken(s))) return s;
  }
  return `${root.slice(0, 60)}-${crypto.randomBytes(8).toString('hex')}`;
}

/** The single platform settings row (created by the migration). */
export async function platformSettings(): Promise<MktSettings> {
  const row = await MktSettings.findOne({ order: [['id', 'ASC']] });
  return row ?? MktSettings.create({ commissionPercent: 30, instructorSignupOpen: true });
}

/** Commission on `paid` paise, rounded to the paisa; the seller gets the rest. */
export function splitSale(paid: number, percent: number) {
  const commission = Math.round((paid * percent) / 100);
  return { commission, net: paid - commission };
}

export const cleanList = (v: string[] | null | undefined) =>
  (v ?? []).map((s) => s.trim()).filter((s) => s.length > 0);
