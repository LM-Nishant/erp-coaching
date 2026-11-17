/**
 * Minimal dependency-free PDF writer (A4, Helvetica, WinAnsi text) for scorecards.
 * Supports headings, text lines and simple column tables with automatic page breaks.
 */
const PAGE_W = 595;
const PAGE_H = 842;
const MARGIN = 48;

function esc(s: string): string {
  return s
    .replace(/[^\x20-\x7e\xa0-\xff]/g, '?')
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

/** Rough Helvetica width estimate used for truncation/wrapping. */
const charWidth = (size: number) => size * 0.5;

export class SimplePdf {
  private pages: string[][] = [[]];
  private y = PAGE_H - MARGIN;

  private get ops() {
    return this.pages[this.pages.length - 1];
  }

  private ensure(height: number) {
    if (this.y - height < MARGIN) {
      this.pages.push([]);
      this.y = PAGE_H - MARGIN;
    }
  }

  private textAt(x: number, y: number, s: string, size: number, bold: boolean) {
    this.ops.push(`BT /${bold ? 'F2' : 'F1'} ${size} Tf ${x.toFixed(1)} ${y.toFixed(1)} Td (${esc(s)}) Tj ET`);
  }

  text(s: string, opts: { size?: number; bold?: boolean; gap?: number } = {}) {
    const size = opts.size ?? 10;
    const maxChars = Math.floor((PAGE_W - 2 * MARGIN) / charWidth(size));
    for (const line of wrap(s, maxChars)) {
      this.ensure(size + 4);
      this.y -= size + 4;
      this.textAt(MARGIN, this.y, line, size, !!opts.bold);
    }
    this.y -= opts.gap ?? 0;
  }

  heading(s: string) {
    this.y -= 6;
    this.text(s, { size: 13, bold: true, gap: 4 });
  }

  rule() {
    this.ensure(8);
    this.y -= 4;
    this.ops.push(`0.6 w ${MARGIN} ${this.y.toFixed(1)} m ${PAGE_W - MARGIN} ${this.y.toFixed(1)} l S`);
    this.y -= 4;
  }

  /** `widths` are fractions of the usable width. */
  table(headers: string[], rows: string[][], widths: number[]) {
    const usable = PAGE_W - 2 * MARGIN;
    const size = 9;
    const draw = (cells: string[], bold: boolean) => {
      this.ensure(size + 6);
      this.y -= size + 6;
      let x = MARGIN;
      cells.forEach((c, i) => {
        const w = usable * widths[i];
        const max = Math.max(1, Math.floor((w - 4) / charWidth(size)));
        this.textAt(x, this.y, c.length > max ? `${c.slice(0, max - 1)}~` : c, size, bold);
        x += w;
      });
    };
    draw(headers, true);
    this.rule();
    for (const r of rows) draw(r, false);
    this.y -= 6;
  }

  toBuffer(): Buffer {
    const objects: string[] = [];
    const add = (body: string) => objects.push(body); // returns the 1-based object number
    add('<< /Type /Catalog /Pages 2 0 R >>');
    add('PAGES');
    add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
    const kids: number[] = [];
    this.pages.forEach((ops, i) => {
      const footer = `BT /F1 8 Tf ${MARGIN} 24 Td (${esc(`Page ${i + 1} of ${this.pages.length}`)}) Tj ET`;
      const stream = [...ops, footer].join('\n');
      const contentId = add(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`);
      kids.push(
        add(
          `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentId} 0 R >>`,
        ),
      );
    });
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
}

function wrap(s: string, max: number): string[] {
  const out: string[] = [];
  for (const para of s.split(/\r?\n/)) {
    let line = '';
    for (const word of para.split(/\s+/)) {
      if (!word) continue;
      if ((line ? line.length + 1 : 0) + word.length > max) {
        if (line) out.push(line);
        line = word.length > max ? word.slice(0, max) : word;
      } else line = line ? `${line} ${word}` : word;
    }
    out.push(line);
  }
  return out;
}
