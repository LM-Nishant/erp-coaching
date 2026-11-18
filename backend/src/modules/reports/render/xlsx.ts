import type { ReportCellValue, ReportColumnType, ReportTableDto } from '@erp/shared';
import { displayDateTime, displayValue, headerWithUnit, isNumericType, zonedParts } from './format';
import { filterSummary, type RenderMeta, type ReportDocument } from './meta';
import { zip } from './zip';

/**
 * Office Open XML workbook: a Summary sheet (period, scope, filters, metrics, notes) and one sheet
 * per table with typed cells (numbers, rupees, percentages, dates), a frozen bold header and filters.
 */

const STYLE = {
  default: 0,
  header: 1,
  money: 2,
  percent: 3,
  date: 4,
  datetime: 5,
  hours: 6,
  title: 7,
  label: 8,
  note: 9,
  headerRight: 10,
} as const;

/** Left-aligned variants of the numeric styles, for the key/value Summary sheet. */
const LEFT_ALIGNED: Partial<Record<number, number>> = {
  [STYLE.default]: 14,
  [STYLE.money]: 11,
  [STYLE.percent]: 12,
  [STYLE.hours]: 13,
};

const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="5"><numFmt numFmtId="164" formatCode="#,##0.00"/><numFmt numFmtId="165" formatCode="0.0%"/><numFmt numFmtId="166" formatCode="dd mmm yyyy"/><numFmt numFmtId="167" formatCode="dd mmm yyyy hh:mm"/><numFmt numFmtId="168" formatCode="0.00"/></numFmts>
<fonts count="4"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="14"/><name val="Calibri"/><family val="2"/></font><font><i/><sz val="10"/><color rgb="FF5F6B7A"/><name val="Calibri"/><family val="2"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE8EEF4"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left/><right/><top/><bottom style="thin"><color rgb="FF9AA5B1"/></bottom><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="15">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="167" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="168" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right"/></xf>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment horizontal="left"/></xf>
<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment horizontal="left"/></xf>
<xf numFmtId="168" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment horizontal="left"/></xf>
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment horizontal="left"/></xf>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

const XML_HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const MAIN_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

/** Characters XML 1.0 forbids, including unpaired surrogates. */
const INVALID_XML =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const MAX_CELL_TEXT = 32767;

const xml = (s: string) =>
  s
    .replace(INVALID_XML, '')
    .replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]!);

export function columnName(index: number): string {
  let n = index + 1;
  let name = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    name = String.fromCharCode(65 + rem) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

type Cell =
  { kind: 'text'; value: string; style?: number } | { kind: 'number'; value: number; style?: number } | null;

const text = (value: string, style?: number): Cell => ({ kind: 'text', value, style });

function cellXml(cell: Cell, ref: string): string {
  if (!cell) return '';
  const s = cell.style ? ` s="${cell.style}"` : '';
  if (cell.kind === 'number') return `<c r="${ref}"${s}><v>${cell.value}</v></c>`;
  const value = xml(cell.value.slice(0, MAX_CELL_TEXT));
  const space = /^\s|\s$/.test(value) ? ' xml:space="preserve"' : '';
  return `<c r="${ref}"${s} t="inlineStr"><is><t${space}>${value}</t></is></c>`;
}

const EXCEL_EPOCH = Date.UTC(1899, 11, 30);
const DAY_MS = 86_400_000;
const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Typed cell for a report value (money in rupees, dates as Excel serials in the institute timezone). */
function valueCell(value: ReportCellValue, type: ReportColumnType, timezone: string): Cell {
  if (value === null || value === '') return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    switch (type) {
      case 'money':
        return { kind: 'number', value: Math.round(value) / 100, style: STYLE.money };
      case 'percent':
        // Excel stores percentages as fractions (0.855 shown as 85.5%).
        return { kind: 'number', value: Math.round(value * 1e4) / 1e6, style: STYLE.percent };
      case 'hours':
        return { kind: 'number', value, style: STYLE.hours };
      default:
        return { kind: 'number', value };
    }
  }
  if (type === 'date') {
    const m = YMD.exec(value);
    if (m) {
      const serial = (Date.UTC(+m[1], +m[2] - 1, +m[3]) - EXCEL_EPOCH) / DAY_MS;
      return { kind: 'number', value: serial, style: STYLE.date };
    }
  }
  if (type === 'datetime') {
    const p = zonedParts(value, timezone);
    if (p) {
      const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
      const serial = Math.round(((wall - EXCEL_EPOCH) / DAY_MS) * 1e8) / 1e8;
      return { kind: 'number', value: serial, style: STYLE.datetime };
    }
  }
  return text(value);
}

/** Display width (characters) of a value, for column sizing. */
function widthOf(value: ReportCellValue, type: ReportColumnType, timezone: string): number {
  if (value === null) return 0;
  return displayValue(value, type, timezone).length;
}

interface Sheet {
  name: string;
  xml: string;
  /** `$A$1:$D$10` when the sheet has an auto-filter. */
  filterRange: string | null;
}

function sheetXml(opts: { rows: Cell[][]; widths: number[]; frozenHeader: boolean; selected: boolean }): {
  xml: string;
  lastRef: string;
} {
  const lastCol = Math.max(1, opts.widths.length, ...opts.rows.map((r) => r.length));
  const lastRow = Math.max(1, opts.rows.length);
  const lastRef = `${columnName(lastCol - 1)}${lastRow}`;
  const body = opts.rows
    .map((row, r) => {
      const cells = row.map((c, i) => cellXml(c, `${columnName(i)}${r + 1}`)).join('');
      return `<row r="${r + 1}">${cells}</row>`;
    })
    .join('');
  const pane = opts.frozenHeader
    ? '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/>'
    : '';
  const cols = opts.widths
    .map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`)
    .join('');
  return {
    lastRef,
    xml:
      `${XML_HEADER}<worksheet xmlns="${MAIN_NS}" xmlns:r="${REL_NS}">` +
      `<dimension ref="A1:${lastRef}"/>` +
      `<sheetViews><sheetView workbookViewId="0"${opts.selected ? ' tabSelected="1"' : ''}>${pane}</sheetView></sheetViews>` +
      '<sheetFormatPr defaultRowHeight="15"/>' +
      (cols ? `<cols>${cols}</cols>` : '') +
      `<sheetData>${body}</sheetData>` +
      (opts.frozenHeader ? `<autoFilter ref="A1:${lastRef}"/>` : '') +
      '<pageMargins left="0.5" right="0.5" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>' +
      '</worksheet>',
  };
}

const clampWidth = (chars: number) => Math.min(60, Math.max(8, Math.ceil(chars * 1.1) + 2));

function tableSheet(table: ReportTableDto, timezone: string): { rows: Cell[][]; widths: number[] } {
  const header = table.columns.map((c) =>
    text(headerWithUnit(c), isNumericType(c.type) ? STYLE.headerRight : STYLE.header),
  );
  const rows: Cell[][] = [header];
  for (const row of table.rows) {
    rows.push(table.columns.map((c) => valueCell(row[c.key] ?? null, c.type, timezone)));
  }
  const sample = table.rows.slice(0, 300);
  const widths = table.columns.map((c) =>
    clampWidth(
      Math.max(
        headerWithUnit(c).length,
        ...sample.map((r) => widthOf(r[c.key] ?? null, c.type, timezone)),
        c.type === 'datetime' ? 17 : 0,
      ),
    ),
  );
  return { rows, widths };
}

function summarySheet(result: ReportDocument, meta: RenderMeta): { rows: Cell[][]; widths: number[] } {
  const tz = result.period.timezone;
  const rows: Cell[][] = [
    [text(result.title, STYLE.title)],
    [text(result.description, STYLE.note)],
    [],
    [text('Institute', STYLE.label), text(meta.instituteName)],
    [text('Period', STYLE.label), text(result.period.label)],
    [text('Scope', STYLE.label), text(result.scope.label)],
    [text('Filters', STYLE.label), text(filterSummary(result))],
    [text('Timezone', STYLE.label), text(tz)],
    [text('Generated', STYLE.label), text(displayDateTime(result.generatedAt, tz))],
    [],
  ];
  if (result.summary.length) {
    rows.push([text('Metric', STYLE.header), text('Value', STYLE.header)]);
    for (const m of result.summary) {
      const label = m.hint ? `${m.label} (${m.hint})` : m.label;
      const cell = valueCell(m.value, m.type, tz);
      const value: Cell =
        cell?.kind === 'number'
          ? { ...cell, style: LEFT_ALIGNED[cell.style ?? 0] ?? cell.style }
          : (cell ?? text('-'));
      rows.push([text(label), value]);
    }
    rows.push([]);
  }
  if (result.notes.length) {
    rows.push([text('Notes', STYLE.label)]);
    for (const n of result.notes) rows.push([text(n, STYLE.note)]);
  }
  return { rows, widths: [34, 48] };
}

/** Excel sheet name: at most 31 characters, no `[]:*?/\`, unique (case-insensitive) within `used`. */
function sheetName(title: string, used: Set<string>): string {
  const base =
    title
      .replace(/[[\]:*?/\\]/g, ' ')
      .replace(/^'+|'+$/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 31) || 'Sheet';
  let name = base;
  for (let n = 2; used.has(name.toLowerCase()); n++) {
    const suffix = ` (${n})`;
    name = `${base.slice(0, 31 - suffix.length)}${suffix}`;
  }
  used.add(name.toLowerCase());
  return name;
}

export function renderXlsx(result: ReportDocument, meta: RenderMeta): Buffer {
  const tz = result.period.timezone;
  // Excel reserves the sheet name "History".
  const used = new Set<string>(['history']);
  const sheets: Sheet[] = [];
  const summary = summarySheet(result, meta);
  sheets.push({
    name: sheetName('Summary', used),
    xml: sheetXml({ ...summary, frozenHeader: false, selected: true }).xml,
    filterRange: null,
  });
  for (const t of result.tables) {
    const data = tableSheet(t, tz);
    const { xml: body, lastRef } = sheetXml({ ...data, frozenHeader: true, selected: false });
    const [, col, row] = /^([A-Z]+)(\d+)$/.exec(lastRef)!;
    sheets.push({ name: sheetName(t.title, used), xml: body, filterRange: `$A$1:$${col}$${row}` });
  }

  const definedNames = sheets
    .map((s, i) =>
      s.filterRange
        ? `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">${xml(`'${s.name.replace(/'/g, "''")}'!${s.filterRange}`)}</definedName>`
        : '',
    )
    .join('');
  const workbook =
    `${XML_HEADER}<workbook xmlns="${MAIN_NS}" xmlns:r="${REL_NS}">` +
    '<bookViews><workbookView activeTab="0"/></bookViews><sheets>' +
    sheets.map((s, i) => `<sheet name="${xml(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') +
    '</sheets>' +
    (definedNames ? `<definedNames>${definedNames}</definedNames>` : '') +
    '</workbook>';
  const workbookRels =
    `${XML_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    sheets
      .map(
        (_s, i) =>
          `<Relationship Id="rId${i + 1}" Type="${REL_NS}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
      )
      .join('') +
    `<Relationship Id="rId${sheets.length + 1}" Type="${REL_NS}/styles" Target="styles.xml"/>` +
    '</Relationships>';
  const contentTypes =
    `${XML_HEADER}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    sheets
      .map(
        (_s, i) =>
          `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
      )
      .join('') +
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
    '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' +
    '</Types>';
  const rootRels =
    `${XML_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="${REL_NS}/officeDocument" Target="xl/workbook.xml"/>` +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
    `<Relationship Id="rId3" Type="${REL_NS}/extended-properties" Target="docProps/app.xml"/>` +
    '</Relationships>';
  const created = new Date(result.generatedAt).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const core =
    `${XML_HEADER}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">` +
    `<dc:title>${xml(result.title)}</dc:title><dc:creator>${xml(meta.instituteName)}</dc:creator>` +
    `<dcterms:created xsi:type="dcterms:W3CDTF">${created}</dcterms:created>` +
    '</cp:coreProperties>';
  const app =
    `${XML_HEADER}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">` +
    '<Application>Coaching ERP</Application></Properties>';

  return zip([
    { name: '[Content_Types].xml', data: Buffer.from(contentTypes) },
    { name: '_rels/.rels', data: Buffer.from(rootRels) },
    { name: 'docProps/core.xml', data: Buffer.from(core) },
    { name: 'docProps/app.xml', data: Buffer.from(app) },
    { name: 'xl/workbook.xml', data: Buffer.from(workbook) },
    { name: 'xl/_rels/workbook.xml.rels', data: Buffer.from(workbookRels) },
    { name: 'xl/styles.xml', data: Buffer.from(STYLES_XML) },
    ...sheets.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: Buffer.from(s.xml) })),
  ]);
}
