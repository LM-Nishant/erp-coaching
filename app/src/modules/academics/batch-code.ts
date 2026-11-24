/**
 * A short unique batch code from the course code and start month, e.g. JEE-2607, then JEE-2607B, JEE-2607C…
 * Staff can still edit it; this only saves them inventing one.
 */
export function suggestBatchCode(courseCode: string, startDate: string, taken: readonly string[]): string {
  const prefix =
    courseCode
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, '')
      .slice(0, 8) || 'B';
  const m = /^\d{2}(\d{2})-(\d{2})/.exec(startDate);
  const base = m ? `${prefix}-${m[1]}${m[2]}` : prefix;
  const used = new Set(taken.map((c) => c.toUpperCase()));
  if (!used.has(base)) return base;
  for (let i = 1; i < 26; i++) {
    const code = `${base}${String.fromCharCode(65 + i)}`;
    if (!used.has(code)) return code;
  }
  return `${base}-${used.size + 1}`;
}
