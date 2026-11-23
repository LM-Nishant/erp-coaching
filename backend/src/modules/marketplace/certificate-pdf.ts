/**
 * Course completion certificate as a one-page landscape A4 PDF (no dependencies; built-in Helvetica,
 * WinAnsi text), following the module-local PDF writers in fees/payroll/exams.
 */
import { fitHelvetica, helveticaWidth, pdfAscii } from '../../shared/pdf-metrics';

const W = 842;
const H = 595;

export interface CertificatePdfInput {
  code: string;
  learnerName: string;
  courseTitle: string;
  sellerName: string;
  issuedOn: string;
  verifyUrl: string;
}

const esc = (s: string) => pdfAscii(s).replace(/[\\()]/g, (c) => `\\${c}`);

export function certificatePdf(c: CertificatePdfInput): Buffer {
  const ops: string[] = [];
  /** Centred text at `y` (from the top), shrunk to fit the page width. */
  const centre = (text: string, y: number, size: number, bold = false, rgb = '0.13 0.15 0.2') => {
    const s = fitHelvetica(pdfAscii(text), W - 160, size, bold);
    const x = (W - helveticaWidth(s, size, bold)) / 2;
    ops.push(
      `${rgb} rg BT /${bold ? 'F2' : 'F1'} ${size} Tf ${x.toFixed(1)} ${(H - y).toFixed(1)} Td (${esc(s)}) Tj ET`,
    );
  };
  const rect = (inset: number, width: number, rgb: string) =>
    ops.push(`${rgb} RG ${width} w ${inset} ${inset} ${W - 2 * inset} ${H - 2 * inset} re S`);
  const line = (x1: number, x2: number, y: number) =>
    ops.push(`0.6 0.62 0.68 RG 0.8 w ${x1} ${H - y} m ${x2} ${H - y} l S`);

  rect(24, 4, '0.18 0.33 0.75');
  rect(36, 1, '0.75 0.62 0.25');
  centre('CERTIFICATE OF COMPLETION', 110, 30, true, '0.18 0.33 0.75');
  centre('This certifies that', 165, 14);
  centre(c.learnerName, 215, 32, true);
  line(220, W - 220, 228);
  centre('has successfully completed the course', 265, 14);
  centre(c.courseTitle, 305, 22, true);
  centre(`taught by ${c.sellerName}`, 340, 13, false, '0.35 0.37 0.42');

  const footer = (label: string, value: string, cx: number) => {
    const size = 12;
    const v = fitHelvetica(pdfAscii(value), 260, size, true);
    ops.push(
      `0.13 0.15 0.2 rg BT /F2 ${size} Tf ${(cx - helveticaWidth(v, size, true) / 2).toFixed(1)} ${H - 440} Td (${esc(v)}) Tj ET`,
    );
    line(cx - 120, cx + 120, 450);
    ops.push(
      `0.35 0.37 0.42 rg BT /F1 10 Tf ${(cx - helveticaWidth(label, 10) / 2).toFixed(1)} ${H - 466} Td (${esc(label)}) Tj ET`,
    );
  };
  footer('Date of completion', c.issuedOn, 230);
  footer('Certificate no.', c.code, W - 230);
  centre(`Verify at ${c.verifyUrl}`, 520, 9, false, '0.45 0.47 0.52');

  const content = ops.join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
    `<< /Title (${esc(`Certificate ${c.code}`)}) /Producer (ERP Coaching Marketplace) >>`,
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
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 7 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
