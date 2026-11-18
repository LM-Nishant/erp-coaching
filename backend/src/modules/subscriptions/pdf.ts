/**
 * Minimal single-font PDF writer (no dependencies). Enough for text-only documents such as
 * SaaS invoices; uses the built-in Helvetica fonts and WinAnsi-safe ASCII text.
 */

export interface PdfText {
  x: number;
  y: number;
  text: string;
  size?: number;
  bold?: boolean;
  /** Right-align at x. */
  align?: 'left' | 'right';
}

export interface PdfLine {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

const ascii = (s: string) =>
  s
    .replace(/₹/g, 'Rs.')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/[^\x20-\x7e]/g, '?');
const esc = (s: string) => ascii(s).replace(/[\\()]/g, (c) => `\\${c}`);
/**
 * Advance widths (1/1000 em) of printable ASCII 0x20–0x7e in the standard Helvetica and
 * Helvetica-Bold metrics, so right-aligned amounts end exactly at their anchor.
 */
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
};
const width = (s: string, size: number, bold = false) => {
  const table = bold ? METRICS.bold : METRICS.regular;
  let units = 0;
  for (const ch of ascii(s)) units += table[ch.charCodeAt(0) - 0x20] ?? 556;
  return (units * size) / 1000;
};

export function renderPdf(
  texts: PdfText[],
  lines: PdfLine[] = [],
  page = { width: 595, height: 842 },
): Buffer {
  const ops: string[] = ['0.6 w'];
  for (const l of lines) ops.push(`${l.x1} ${page.height - l.y1} m ${l.x2} ${page.height - l.y2} l S`);
  for (const t of texts) {
    const size = t.size ?? 10;
    const x = t.align === 'right' ? t.x - width(t.text, size, t.bold) : t.x;
    ops.push(
      `BT /${t.bold ? 'F2' : 'F1'} ${size} Tf ${x.toFixed(1)} ${(page.height - t.y).toFixed(1)} Td (${esc(t.text)}) Tj ET`,
    );
  }
  const content = ops.join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${page.width} ${page.height}] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
