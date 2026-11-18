/**
 * Standard Helvetica / Helvetica-Bold advance widths for the dependency-free PDF writers (fees,
 * payroll, exams, SaaS invoices), so right-aligned and truncated text fits its column exactly.
 */

/** Advance widths (1/1000 em) of printable ASCII 0x20–0x7e. */
const METRICS = {
  regular: [
    278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556,
    556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278,
    500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469,
    556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500,
    278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
  ],
  bold: [
    278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556,
    556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278,
    556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584,
    556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556,
    333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
  ],
} as const;

/** Width used for glyphs outside printable ASCII (Latin-1 letters are close to this). */
const FALLBACK_WIDTH = 556;

/** Maps text to WinAnsi-safe ASCII (₹ → `Rs.`, dashes → `-`, anything else → `?`). */
export const pdfAscii = (s: string) =>
  s
    .replace(/₹/g, 'Rs.')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/[^\x20-\x7e]/g, '?');

/** Width in points of `text` set in Helvetica (or Helvetica-Bold) at `size`. */
export function helveticaWidth(text: string, size: number, bold = false): number {
  const table = bold ? METRICS.bold : METRICS.regular;
  let units = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    units += code >= 0x20 && code <= 0x7e ? table[code - 0x20] : FALLBACK_WIDTH;
  }
  return (units * size) / 1000;
}

/** Truncates `text` to `max` points, ending with `marker` when shortened. */
export function fitHelvetica(text: string, max: number, size: number, bold = false, marker = '~'): string {
  if (helveticaWidth(text, size, bold) <= max) return text;
  const budget = max - helveticaWidth(marker, size, bold);
  let out = '';
  for (const ch of text) {
    if (helveticaWidth(out + ch, size, bold) > budget) break;
    out += ch;
  }
  return out + marker;
}

/** Word-wraps `text` (keeping its line breaks) to lines at most `max` points wide. */
export function wrapHelvetica(text: string, max: number, size: number, bold = false): string[] {
  const fits = (s: string) => helveticaWidth(s, size, bold) <= max;
  const out: string[] = [];
  for (const para of text.split(/\r?\n/)) {
    let line = '';
    for (const word of para.split(/\s+/)) {
      if (!word) continue;
      const candidate = line ? `${line} ${word}` : word;
      if (fits(candidate)) {
        line = candidate;
        continue;
      }
      if (line) out.push(line);
      // A word wider than the line is broken across lines.
      let rest = word;
      while (!fits(rest)) {
        let n = 1;
        while (n < rest.length && fits(rest.slice(0, n + 1))) n++;
        out.push(rest.slice(0, n));
        rest = rest.slice(n);
      }
      line = rest;
    }
    out.push(line);
  }
  return out;
}
