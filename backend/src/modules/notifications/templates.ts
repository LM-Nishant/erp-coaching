/** `{{ path.to.value }}` substitution; unknown variables render as empty strings. */
export function renderTemplate(template: string, vars: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_m, path: string) => {
    let value: unknown = vars;
    for (const part of path.split('.')) {
      if (value === null || typeof value !== 'object') return '';
      value = (value as Record<string, unknown>)[part];
    }
    if (value === null || value === undefined) return '';
    return value instanceof Date ? value.toISOString() : String(value);
  });
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
