import zlib from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { renderReport, type ReportDocument } from './index';

const doc: ReportDocument = {
  key: 'fee-collections',
  title: 'Fee collections',
  description: 'Payments received in the period',
  generatedAt: '2026-11-18T06:30:00.000Z',
  period: {
    preset: 'custom',
    from: '2026-11-01',
    to: '2026-11-18',
    timezone: 'Asia/Kolkata',
    label: 'Custom range (1 Nov 2026 – 18 Nov 2026)',
  },
  filters: {
    branchId: 1,
    branchName: 'Main',
    courseId: null,
    courseName: null,
    batchId: null,
    batchName: null,
  },
  scope: { audience: 'management', label: 'Branch: Main' },
  summary: [
    { key: 'net', label: 'Net collected', value: 123_450, type: 'money' },
    { key: 'share', label: 'Share', value: 85.5, type: 'percent' },
  ],
  tables: [
    {
      key: 'payments',
      title: 'Payments',
      columns: [
        { key: 'paidAt', label: 'Paid at', type: 'datetime' },
        { key: 'student', label: 'Student', type: 'text' },
        { key: 'amount', label: 'Amount', type: 'money' },
        { key: 'share', label: 'Share', type: 'percent' },
        { key: 'due', label: 'Due', type: 'date' },
      ],
      rows: [
        {
          paidAt: '2026-11-17T20:00:00.000Z',
          student: '=HYPERLINK("http://x")',
          amount: 123_450,
          share: 85.5,
          due: '2026-11-18',
        },
        { paidAt: null, student: 'Shah, "Ravi"', amount: -500, share: null, due: null },
      ],
      totalRows: 2,
    },
  ],
  notes: ['Refunds are deducted from the net amount.'],
};

const meta = { instituteName: 'Apex Coaching Classes' };

/** Reads every entry of a ZIP (local headers), checking each CRC. */
function unzip(buf: Buffer): Map<string, string> {
  const out = new Map<string, string>();
  let off = 0;
  while (buf.readUInt32LE(off) === 0x04034b50) {
    const method = buf.readUInt16LE(off + 8);
    const crc = buf.readUInt32LE(off + 14);
    const size = buf.readUInt32LE(off + 18);
    const nameLen = buf.readUInt16LE(off + 26);
    const extraLen = buf.readUInt16LE(off + 28);
    const name = buf.toString('utf8', off + 30, off + 30 + nameLen);
    const start = off + 30 + nameLen + extraLen;
    const raw = buf.subarray(start, start + size);
    const data = method === 8 ? zlib.inflateRawSync(raw) : raw;
    expect(zlib.crc32(data) >>> 0, name).toBe(crc);
    out.set(name, data.toString('utf8'));
    off = start + size;
  }
  return out;
}

describe('report renderers', () => {
  it('writes the main table as CSV with a BOM, units, rupees, local times and a formula guard', () => {
    const out = renderReport(doc, 'csv', meta);
    expect(out.mimeType).toBe('text/csv');
    expect(out.fileName).toBe('fee-collections-2026-11-01-to-2026-11-18.csv');
    expect([...out.buffer.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(out.buffer.toString('utf8').slice(1).split('\r\n')).toEqual([
      'Paid at,Student,Amount (Rs.),Share (%),Due',
      // 20:00 UTC is 01:30 the next day in IST; the text that looks like a formula is neutralised.
      `2026-11-18 01:30,"'=HYPERLINK(""http://x"")",1234.50,85.5,2026-11-18`,
      ',"Shah, ""Ravi""",-5.00,,',
      '',
    ]);
  });

  it('writes a valid XLSX package with typed cells', () => {
    const out = renderReport(doc, 'xlsx', meta);
    expect(out.fileName.endsWith('.xlsx')).toBe(true);
    const parts = unzip(out.buffer);
    expect([...parts.keys()]).toEqual(
      expect.arrayContaining([
        '[Content_Types].xml',
        '_rels/.rels',
        'xl/workbook.xml',
        'xl/_rels/workbook.xml.rels',
        'xl/styles.xml',
        'xl/worksheets/sheet1.xml',
        'xl/worksheets/sheet2.xml',
      ]),
    );
    expect(parts.get('xl/workbook.xml')).toMatch(/<sheet name="Summary"[^>]*\/><sheet name="Payments"/);

    const summary = parts.get('xl/worksheets/sheet1.xml')!;
    expect(summary).toContain('Apex Coaching Classes');
    expect(summary).toContain('Branch: Main');

    const sheet = parts.get('xl/worksheets/sheet2.xml')!;
    expect(sheet).toContain('<v>1234.5</v>'); // rupees, not paise
    expect(sheet).toContain('<v>0.855</v>'); // percent as a fraction
    expect(sheet).toContain('<v>-5</v>');
    const serial = (Date.UTC(2026, 10, 18) - Date.UTC(1899, 11, 30)) / 86_400_000;
    expect(sheet).toContain(`<v>${serial}</v>`);
    // Formula-like text stays an inline string; the workbook never contains formulas.
    expect(sheet).toContain('<t>=HYPERLINK(&quot;http://x&quot;)</t>');
    expect(sheet).not.toContain('<f>');
    expect(sheet).toContain('<autoFilter ref="A1:E3"/>');
  });

  it('writes a PDF with a valid cross-reference table', () => {
    const out = renderReport(doc, 'pdf', meta);
    expect(out.mimeType).toBe('application/pdf');
    const text = out.buffer.toString('latin1');
    expect(text.startsWith('%PDF-1.4')).toBe(true);
    expect(text.endsWith('%%EOF\n')).toBe(true);
    const startxref = Number(/startxref\n(\d+)\n%%EOF\n$/.exec(text)![1]);
    expect(text.slice(startxref, startxref + 4)).toBe('xref');

    const content = [...text.matchAll(/stream\n([\s\S]*?)\nendstream/g)]
      .map((m) => zlib.inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1'))
      .join('\n');
    expect(content).toContain('Fee collections');
    expect(content).toContain('1,234.50');
  });
});
