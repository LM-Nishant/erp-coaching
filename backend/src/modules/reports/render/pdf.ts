import zlib from 'node:zlib';
import type { ReportTableDto } from '@erp/shared';
import { displayDateTime, displayValue, headerWithUnit, isNumericType } from './format';
import { filterSummary, type RenderMeta, type ReportDocument } from './meta';

/**
 * Multi-page report PDF (A4 landscape) without dependencies: built-in Helvetica fonts with WinAnsi
 * encoding, AFM glyph widths for layout, repeated table headers and page footers. Characters outside
 * WinAnsi (e.g. Devanagari) print as `?`; Excel and CSV exports keep the full text.
 */

/** Rows printed per table; larger tables are cut with a note pointing to Excel/CSV. */
export const PDF_ROW_LIMIT = 5000;

const PAGE_W = 842;
const PAGE_H = 595;
const MARGIN = 36;
const FOOTER_H = 22;
const CONTENT_W = PAGE_W - 2 * MARGIN;
const BOTTOM = PAGE_H - MARGIN - FOOTER_H;
const CELL_PAD = 4;
const FONT_SIZE = 7.5;
const ROW_H = 13;

// Helvetica and Helvetica-Bold advance widths (1/1000 em) for codes 32–126.
// prettier-ignore
const REGULAR = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584];
// prettier-ignore
const BOLD = [278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584];

/** WinAnsi codes for common punctuation outside Latin-1. */
const WIN_ANSI: Record<string, number> = {
  '€': 0x80,
  '…': 0x85,
  '‘': 0x91,
  '’': 0x92,
  '“': 0x93,
  '”': 0x94,
  '•': 0x95,
  '–': 0x96,
  '—': 0x97,
};

/** Text as WinAnsi bytes (one char per byte); unsupported characters become `?`. */
export function winAnsi(s: string): string {
  let out = '';
  for (const ch of s.replace(/₹/g, 'Rs.').replace(/[\t\r\n\u2007\u2009\u202f]/g, ' ')) {
    const code = ch.codePointAt(0)!;
    if ((code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff)) out += ch;
    else if (WIN_ANSI[ch]) out += String.fromCharCode(WIN_ANSI[ch]);
    else out += '?';
  }
  return out;
}

function glyphWidth(code: number, bold: boolean): number {
  if (code >= 32 && code <= 126) return (bold ? BOLD : REGULAR)[code - 32];
  switch (code) {
    case 0x85:
    case 0x97:
    case 0x80:
      return code === 0x80 ? 556 : 1000;
    case 0x96:
      return 556;
    case 0x95:
      return 350;
    case 0x91:
    case 0x92:
      return bold ? 278 : 222;
    case 0x93:
    case 0x94:
      return bold ? 500 : 333;
    case 0xa0:
      return 278;
  }
  return code >= 0xc0 && code <= 0xde ? 722 : 556;
}

/** Width in points of WinAnsi text. */
export function textWidth(encoded: string, size: number, bold = false): number {
  let w = 0;
  for (let i = 0; i < encoded.length; i++) w += glyphWidth(encoded.charCodeAt(i), bold);
  return (w * size) / 1000;
}

/** Truncates WinAnsi text to a width, ending with `...`. */
function fit(encoded: string, max: number, size: number, bold = false): string {
  if (textWidth(encoded, size, bold) <= max) return encoded;
  const ellipsis = textWidth('...', size, bold);
  let w = 0;
  let i = 0;
  for (; i < encoded.length; i++) {
    const cw = (glyphWidth(encoded.charCodeAt(i), bold) * size) / 1000;
    if (w + cw + ellipsis > max) break;
    w += cw;
  }
  return `${encoded.slice(0, i).trimEnd()}...`;
}

/** Word-wraps WinAnsi text into lines no wider than `max` (long words are truncated). */
function wrap(encoded: string, max: number, size: number, bold = false): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of encoded.split(' ').filter(Boolean)) {
    const candidate = line ? `${line} ${word}` : word;
    if (textWidth(candidate, size, bold) <= max) line = candidate;
    else {
      if (line) lines.push(line);
      line = fit(word, max, size, bold);
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}

const pdfString = (encoded: string) => `(${encoded.replace(/[\\()]/g, (c) => `\\${c}`)})`;
const n2 = (v: number) => (Math.round(v * 100) / 100).toString();

class Page {
  readonly ops: string[] = [];

  text(x: number, top: number, encoded: string, size: number, opts: { bold?: boolean; gray?: number } = {}) {
    const color = opts.gray !== undefined ? `${n2(opts.gray)} g ` : '';
    this.ops.push(
      `${color}BT /${opts.bold ? 'F2' : 'F1'} ${n2(size)} Tf ${n2(x)} ${n2(PAGE_H - top)} Td ${pdfString(encoded)} Tj ET${color ? ' 0 g' : ''}`,
    );
  }

  /** Text right-aligned at `right`. */
  textRight(
    right: number,
    top: number,
    encoded: string,
    size: number,
    opts: { bold?: boolean; gray?: number } = {},
  ) {
    this.text(right - textWidth(encoded, size, opts.bold), top, encoded, size, opts);
  }

  rect(x: number, top: number, w: number, h: number, gray: number) {
    this.ops.push(`${n2(gray)} g ${n2(x)} ${n2(PAGE_H - top - h)} ${n2(w)} ${n2(h)} re f 0 g`);
  }

  line(x1: number, top: number, x2: number, gray: number, width = 0.5) {
    this.ops.push(
      `${n2(width)} w ${n2(gray)} G ${n2(x1)} ${n2(PAGE_H - top)} m ${n2(x2)} ${n2(PAGE_H - top)} l S 0 G`,
    );
  }
}

class Layout {
  readonly pages: Page[] = [];
  page!: Page;
  y = MARGIN;

  constructor() {
    this.newPage();
  }

  newPage() {
    this.page = new Page();
    this.pages.push(this.page);
    this.y = MARGIN;
  }

  /** Starts a new page unless `height` still fits. */
  ensure(height: number): boolean {
    if (this.y + height <= BOTTOM) return false;
    this.newPage();
    return true;
  }
}

/** Column widths that fill the content width; wide columns are capped ("water-filling"). */
function columnWidths(natural: number[], available: number): number[] {
  const total = natural.reduce((a, b) => a + b, 0);
  if (total <= available) return natural.map((w) => (w * available) / total);
  const sorted = [...natural].sort((a, b) => a - b);
  let remaining = available;
  let cap = available / natural.length;
  for (let i = 0; i < sorted.length; i++) {
    const share = remaining / (sorted.length - i);
    if (sorted[i] > share) {
      cap = share;
      break;
    }
    remaining -= sorted[i];
  }
  return natural.map((w) => Math.min(w, cap));
}

function drawTable(layout: Layout, table: ReportTableDto, timezone: string, notes: string[]) {
  const rows = table.rows.slice(0, PDF_ROW_LIMIT);
  if (table.rows.length > PDF_ROW_LIMIT) {
    notes.push(
      `${table.title}: the PDF lists the first ${PDF_ROW_LIMIT.toLocaleString('en-IN')} of ${table.rows.length.toLocaleString('en-IN')} rows. Download Excel or CSV for every row.`,
    );
  }
  const numeric = table.columns.map((c) => isNumericType(c.type));
  // Money cells print without a currency prefix, so the unit goes in the header.
  const headers = table.columns.map((c) => winAnsi(c.type === 'money' ? headerWithUnit(c) : c.label));
  const cells = rows.map((r) =>
    table.columns.map((c) => winAnsi(displayValue(r[c.key] ?? null, c.type, timezone))),
  );
  const sample = cells.slice(0, 400);
  const natural = table.columns.map((_c, i) => {
    const longestWord = Math.max(...headers[i].split(' ').map((w) => textWidth(w, FONT_SIZE, true)));
    const header = Math.max(longestWord, textWidth(headers[i], FONT_SIZE, true) / 2);
    const body = Math.max(0, ...sample.map((r) => textWidth(r[i], FONT_SIZE)));
    return Math.max(header, body, 18) + 2 * CELL_PAD;
  });
  const widths = columnWidths(natural, CONTENT_W);
  const xs = widths.reduce<number[]>((acc, _w, i) => [...acc, i ? acc[i - 1] + widths[i - 1] : MARGIN], []);
  const headerLines = headers.map((h, i) => wrap(h, widths[i] - 2 * CELL_PAD, FONT_SIZE, true).slice(0, 2));
  const headerH = Math.max(...headerLines.map((l) => l.length)) * 9 + 6;

  const drawTitle = (continued: boolean) => {
    const title = winAnsi(`${table.title}${continued ? ' (continued)' : ''}`);
    layout.page.text(MARGIN, layout.y + 11, title, 11, { bold: true });
    if (!continued && table.totalRows > rows.length) {
      const shown = winAnsi(
        `${rows.length.toLocaleString('en-IN')} of ${table.totalRows.toLocaleString('en-IN')} rows`,
      );
      layout.page.textRight(MARGIN + CONTENT_W, layout.y + 11, shown, 7.5, { gray: 0.4 });
    }
    layout.y += 18;
  };
  const drawHeader = () => {
    layout.page.rect(MARGIN, layout.y, CONTENT_W, headerH, 0.9);
    headerLines.forEach((lines, i) => {
      lines.forEach((line, li) => {
        const top = layout.y + 3 + (li + 1) * 9 - 1.5;
        if (numeric[i])
          layout.page.textRight(xs[i] + widths[i] - CELL_PAD, top, line, FONT_SIZE, { bold: true });
        else layout.page.text(xs[i] + CELL_PAD, top, line, FONT_SIZE, { bold: true });
      });
    });
    layout.y += headerH;
  };

  layout.ensure(18 + headerH + ROW_H * Math.min(3, Math.max(1, rows.length)));
  drawTitle(false);
  drawHeader();
  if (!rows.length) {
    layout.page.text(
      MARGIN + CELL_PAD,
      layout.y + 10,
      winAnsi('No data for the selected filters.'),
      FONT_SIZE,
      {
        gray: 0.4,
      },
    );
    layout.y += ROW_H + 12;
    return;
  }
  cells.forEach((row, r) => {
    if (layout.ensure(ROW_H)) {
      drawTitle(true);
      drawHeader();
    }
    if (r % 2 === 1) layout.page.rect(MARGIN, layout.y, CONTENT_W, ROW_H, 0.965);
    const baseline = layout.y + ROW_H / 2 + FONT_SIZE * 0.35;
    row.forEach((value, i) => {
      const text = fit(value, widths[i] - 2 * CELL_PAD, FONT_SIZE);
      if (numeric[i]) layout.page.textRight(xs[i] + widths[i] - CELL_PAD, baseline, text, FONT_SIZE);
      else layout.page.text(xs[i] + CELL_PAD, baseline, text, FONT_SIZE);
    });
    layout.y += ROW_H;
  });
  layout.page.line(MARGIN, layout.y, MARGIN + CONTENT_W, 0.75);
  layout.y += 16;
}

function drawSummary(layout: Layout, result: ReportDocument, timezone: string) {
  const perRow = 4;
  const gap = 6;
  const boxW = (CONTENT_W - gap * (perRow - 1)) / perRow;
  const boxH = 30;
  result.summary.forEach((m, i) => {
    const col = i % perRow;
    if (col === 0) {
      if (i > 0) layout.y += boxH + gap;
      layout.ensure(boxH);
    }
    const x = MARGIN + col * (boxW + gap);
    layout.page.rect(x, layout.y, boxW, boxH, 0.95);
    layout.page.text(x + 6, layout.y + 10, fit(winAnsi(m.label), boxW - 12, 7.5), 7.5, { gray: 0.35 });
    const value = winAnsi(displayValue(m.value, m.type, timezone, { currency: true }));
    layout.page.text(x + 6, layout.y + 24, fit(value, boxW - 12, 12, true), 12, { bold: true });
  });
  if (result.summary.length) layout.y += boxH + 14;
}

function drawNotes(layout: Layout, notes: string[]) {
  for (const note of notes) {
    const lines = wrap(winAnsi(note), CONTENT_W - 10, 8);
    layout.ensure(lines.length * 10 + 2);
    lines.forEach((line, i) => {
      if (i === 0) layout.page.text(MARGIN, layout.y + 8, '\x95', 8, { gray: 0.35 });
      layout.page.text(MARGIN + 10, layout.y + 8, line, 8, { gray: 0.35 });
      layout.y += 10;
    });
    layout.y += 2;
  }
  if (notes.length) layout.y += 8;
}

function pdfDate(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `D:${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

/** Literal string for the (uncompressed) document info dictionary: ASCII with octal escapes. */
const infoString = (s: string) =>
  `(${winAnsi(s).replace(/[\\()]|[^\x20-\x7e]/g, (c) =>
    /[\\()]/.test(c) ? `\\${c}` : `\\${c.charCodeAt(0).toString(8).padStart(3, '0')}`,
  )})`;

export function renderPdf(result: ReportDocument, meta: RenderMeta): Buffer {
  const tz = result.period.timezone;
  const layout = new Layout();
  const page = layout.page;
  page.text(MARGIN, MARGIN + 14, fit(winAnsi(result.title), CONTENT_W * 0.6, 16, true), 16, { bold: true });
  page.textRight(
    MARGIN + CONTENT_W,
    MARGIN + 10,
    fit(winAnsi(meta.instituteName), CONTENT_W * 0.38, 9, true),
    9,
    {
      bold: true,
    },
  );
  layout.y = MARGIN + 24;
  const lines = [
    result.description,
    `Period: ${result.period.label} · ${tz}`,
    `Scope: ${result.scope.label}`,
    `Filters: ${filterSummary(result)}`,
    `Generated: ${displayDateTime(result.generatedAt, tz)}`,
  ];
  for (const l of lines) {
    for (const w of wrap(winAnsi(l), CONTENT_W, 8.5)) {
      page.text(MARGIN, layout.y + 9, w, 8.5, { gray: 0.3 });
      layout.y += 11;
    }
  }
  layout.y += 10;
  drawSummary(layout, result, tz);

  const notes = [...result.notes];
  const tableNotes: string[] = [];
  drawNotes(layout, notes);
  for (const t of result.tables) drawTable(layout, t, tz, tableNotes);
  drawNotes(layout, tableNotes);

  const total = layout.pages.length;
  const footerLeft = fit(winAnsi(`${meta.instituteName} · ${result.title}`), CONTENT_W * 0.45, 7.5);
  const generated = winAnsi(`Generated ${displayDateTime(result.generatedAt, tz)}`);
  layout.pages.forEach((p, i) => {
    const top = PAGE_H - MARGIN + 4;
    p.line(MARGIN, top - 10, MARGIN + CONTENT_W, 0.8);
    p.text(MARGIN, top, footerLeft, 7.5, { gray: 0.4 });
    p.text(MARGIN + CONTENT_W / 2 - textWidth(generated, 7.5) / 2, top, generated, 7.5, { gray: 0.4 });
    p.textRight(MARGIN + CONTENT_W, top, `Page ${i + 1} of ${total}`, 7.5, { gray: 0.4 });
  });

  // Objects: 1 catalog, 2 pages, 3–4 fonts, 5 info, then a page and its content stream per page.
  const objects: Buffer[] = [];
  const pageIds = layout.pages.map((_p, i) => 6 + i * 2);
  objects.push(Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'));
  objects.push(
    Buffer.from(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${total} >>`),
  );
  objects.push(
    Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'),
  );
  objects.push(
    Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>'),
  );
  objects.push(
    Buffer.from(
      `<< /Title ${infoString(result.title)} /Author ${infoString(meta.instituteName)} /Producer (Coaching ERP) /CreationDate (${pdfDate(result.generatedAt)}) >>`,
    ),
  );
  for (const p of layout.pages) {
    const id = objects.length + 1;
    objects.push(
      Buffer.from(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${id + 1} 0 R >>`,
      ),
    );
    const stream = zlib.deflateSync(Buffer.from(p.ops.join('\n'), 'latin1'));
    objects.push(
      Buffer.concat([
        Buffer.from(`<< /Length ${stream.length} /Filter /FlateDecode >>\nstream\n`),
        stream,
        Buffer.from('\nendstream'),
      ]),
    );
  }

  const chunks: Buffer[] = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  let length = chunks[0].length;
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(length);
    const chunk = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), body, Buffer.from('\nendobj\n')]);
    chunks.push(chunk);
    length += chunk.length;
  });
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) xref += `${String(off).padStart(10, '0')} 00000 n \n`;
  xref += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${length}\n%%EOF\n`;
  chunks.push(Buffer.from(xref));
  return Buffer.concat(chunks);
}
