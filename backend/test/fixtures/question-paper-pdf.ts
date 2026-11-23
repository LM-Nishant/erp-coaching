/**
 * Builds small question-paper PDFs for tests: Helvetica text lines and optional embedded images
 * (diagrams, or a full-page "scan"). Coordinates are PDF points from the top-left of an A4 page.
 */

export interface FixturePage {
  lines?: string[];
  /** Images drawn on the page: `{ x, y, w, h }` from the top-left, in points. */
  images?: { x: number; y: number; w: number; h: number }[];
  /** Insert an image right after the line at this index (0-based), shifting following lines down. */
  figureAfterLine?: number;
}

const PAGE_W = 595;
const PAGE_H = 842;
const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

export function buildQuestionPaperPdf(pages: FixturePage[]): Buffer {
  const objects: string[] = [];
  const add = (body: string) => objects.push(body);
  add('<< /Type /Catalog /Pages 2 0 R >>');
  add('PAGES');
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  // A tiny 4x4 grey-and-black RGB image, reused for every picture.
  const px = Buffer.alloc(4 * 4 * 3, 0x80);
  for (let i = 0; i < px.length; i += 9) px[i] = 0;
  const imageId = add(
    `<< /Type /XObject /Subtype /Image /Width 4 /Height 4 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length ${px.length} >>\nstream\n${px.toString('latin1')}\nendstream`,
  );
  const kids: number[] = [];
  for (const page of pages) {
    const ops: string[] = [];
    let y = 60;
    const images = [...(page.images ?? [])];
    (page.lines ?? []).forEach((line, i) => {
      y += 18;
      ops.push(`BT /F1 11 Tf 48 ${(PAGE_H - y).toFixed(1)} Td (${esc(line)}) Tj ET`);
      if (page.figureAfterLine === i) {
        images.push({ x: 60, y: y + 8, w: 180, h: 120 });
        y += 132;
      }
    });
    for (const im of images) {
      ops.push(`q ${im.w} 0 0 ${im.h} ${im.x} ${PAGE_H - im.y - im.h} cm /Im1 Do Q`);
    }
    const stream = ops.join('\n');
    const contentId = add(
      `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`,
    );
    kids.push(
      add(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 3 0 R >> /XObject << /Im1 ${imageId} 0 R >> >> /Contents ${contentId} 0 R >>`,
      ),
    );
  }
  objects[1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

/** A two-page sample paper with an answer key on the last page and a diagram on question 3. */
export function samplePaperPdf(): Buffer {
  return buildQuestionPaperPdf([
    {
      lines: [
        'Physics Unit Test - Class 11',
        '1. What is the SI unit of force?',
        '(A) Newton (B) Joule (C) Watt (D) Pascal',
        '2. Which of these are vector quantities?',
        '(A) Velocity (B) Mass (C) Force (D) Time',
        '3. In the circuit shown, find the current through the 4 ohm resistor (in A).',
      ],
      figureAfterLine: 5,
    },
    {
      lines: [
        '4. True or false: Light travels faster in water than in air.',
        "5. State Newton's second law of motion.",
        'Answer Key',
        '1-A 2-A,C 3-2.5 4-False',
      ],
    },
  ]);
}
