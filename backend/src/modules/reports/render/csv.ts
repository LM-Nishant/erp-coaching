import { headerWithUnit, plainValue } from './format';
import type { ReportDocument } from './meta';

/** Quotes a CSV cell; text that a spreadsheet would run as a formula is prefixed with `'`. */
export function csvCell(value: string, isText: boolean): string {
  const s = isText && /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * The report's main (first) table as UTF-8 CSV with a BOM so Excel detects the encoding. Money is in
 * rupees and times are in the institute timezone; units are in the headers.
 */
export function renderCsv(result: ReportDocument): Buffer {
  const timezone = result.period.timezone;
  const main = result.tables[0];
  const lines: string[] = [];
  if (main) {
    lines.push(main.columns.map((c) => csvCell(headerWithUnit(c), true)).join(','));
    for (const row of main.rows) {
      lines.push(
        main.columns
          .map((c) => {
            const raw = row[c.key] ?? null;
            const isText = typeof raw === 'string' && c.type !== 'date' && c.type !== 'datetime';
            return csvCell(plainValue(raw, c.type, timezone), isText);
          })
          .join(','),
      );
    }
  }
  return Buffer.from(`\uFEFF${lines.join('\r\n')}\r\n`, 'utf8');
}
