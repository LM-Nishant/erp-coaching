/**
 * Minimal single-font PDF writer (no dependencies). Enough for text-only documents such as
 * salary slips; uses the built-in Helvetica fonts and WinAnsi-safe ASCII text.
 */
import { helveticaWidth, pdfAscii } from '../../shared/pdf-metrics';

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

const esc = (s: string) => pdfAscii(s).replace(/[\\()]/g, (c) => `\\${c}`);

export function renderPdf(
  texts: PdfText[],
  lines: PdfLine[] = [],
  page = { width: 595, height: 842 },
): Buffer {
  const ops: string[] = ['0.6 w'];
  for (const l of lines) ops.push(`${l.x1} ${page.height - l.y1} m ${l.x2} ${page.height - l.y2} l S`);
  for (const t of texts) {
    const size = t.size ?? 10;
    const x = t.align === 'right' ? t.x - helveticaWidth(pdfAscii(t.text), size, t.bold) : t.x;
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
