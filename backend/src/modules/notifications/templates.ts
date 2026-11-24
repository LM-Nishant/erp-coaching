import { formatVariable } from './format';

const PLACEHOLDER = /\{\{\s*([\w.-]+)\s*\}\}/g;

function lookup(path: string, vars: Record<string, unknown>, timeZone?: string): string {
  let value: unknown = vars;
  for (const part of path.split('.')) {
    if (value === null || typeof value !== 'object') return '';
    value = (value as Record<string, unknown>)[part];
  }
  if (value === null || value === undefined) return '';
  return formatVariable(value, timeZone);
}

/**
 * `{{ path.to.value }}` substitution; unknown variables render as empty strings. Dates and times read in
 * Indian style (see `formatVariable`), instants in `timeZone` (the institute's).
 */
export function renderTemplate(template: string, vars: Record<string, unknown>, timeZone?: string): string {
  return template.replace(PLACEHOLDER, (_m, path: string) => lookup(path, vars, timeZone));
}

/**
 * Values of the distinct placeholders in order of first appearance: the n-th one fills the vendor
 * template's n-th variable (WhatsApp `{{n}}`, MSG91 `##varn##`, Twilio Content `{{n}}`).
 */
export function templateParams(
  template: string,
  vars: Record<string, unknown>,
  timeZone?: string,
): { name: string; value: string }[] {
  const names = [...new Set([...template.matchAll(PLACEHOLDER)].map((m) => m[1]))];
  return names.map((name) => ({ name, value: lookup(name, vars, timeZone) }));
}

/** Sample values for previews: `[variable]`. */
export function sampleVars(variables: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {
    recipient: { name: 'Asha Sharma' },
    institute: { name: 'Your Institute' },
  };
  for (const v of variables) {
    const parts = v.split('.');
    let node = out;
    parts.forEach((p, i) => {
      if (i === parts.length - 1) node[p] = `[${v}]`;
      else node = (node[p] ??= {}) as Record<string, unknown>;
    });
  }
  return out;
}
