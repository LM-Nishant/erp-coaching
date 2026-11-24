import { SYSTEM_ROLES } from '@erp/shared';

const SYSTEM: readonly string[] = Object.values(SYSTEM_ROLES);

/**
 * A role slug as people say it: system roles from `shell.roles.*` (translated), custom roles from their slug
 * (`custom-front-desk` → "Front desk").
 */
export function roleName(slug: string, t: (key: string) => string): string {
  if (SYSTEM.includes(slug)) return t(`shell.roles.${slug}`);
  const words = slug.replace(/^custom-/, '').replace(/-/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Every role of the user, named, without repeats: "Teacher, Parent". */
export const roleNames = (slugs: readonly string[] | undefined, t: (key: string) => string) =>
  [...new Set((slugs ?? []).map((s) => roleName(s, t)))].join(', ');
