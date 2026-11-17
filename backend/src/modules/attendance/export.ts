/** CSV and Excel (SpreadsheetML 2003, opens in Excel/LibreOffice) exports without extra dependencies. */

export type Cell = string | number | null | undefined;

const csvCell = (v: Cell) => {
  if (v == null) return '';
  let s = String(v);
  // Neutralise spreadsheet formula injection.
  if (/^[=+\-@\t\r]/.test(s) && typeof v === 'string') s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function toCsv(headers: string[], rows: Cell[][]): string {
  return [headers, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

const xml = (s: string) =>
  s.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]!);

export function toSpreadsheetXml(sheet: string, headers: string[], rows: Cell[][]): string {
  const cell = (v: Cell, style?: string) =>
    v == null
      ? '<Cell/>'
      : typeof v === 'number'
        ? `<Cell${style ? ` ss:StyleID="${style}"` : ''}><Data ss:Type="Number">${v}</Data></Cell>`
        : `<Cell${style ? ` ss:StyleID="${style}"` : ''}><Data ss:Type="String">${xml(v)}</Data></Cell>`;
  return [
    '<?xml version="1.0"?>',
    '<?mso-application progid="Excel.Sheet"?>',
    '<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">',
    '<Styles><Style ss:ID="h"><Font ss:Bold="1"/></Style></Styles>',
    `<Worksheet ss:Name="${xml(sheet.slice(0, 31))}"><Table>`,
    `<Row>${headers.map((h) => cell(h, 'h')).join('')}</Row>`,
    ...rows.map((r) => `<Row>${r.map((v) => cell(v)).join('')}</Row>`),
    '</Table></Worksheet></Workbook>',
  ].join('\n');
}
