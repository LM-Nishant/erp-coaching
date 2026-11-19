import { describe, expect, it } from 'vitest';
import { LEDGER_ACCOUNTS as L, TALLY_DEFAULT_VOUCHER_TYPES } from '@erp/shared';
import { assertBalanced, mastersXml, tallyAmount, tallyDate, voucherXml, vouchersXml, xmlText } from './xml';
import { decodeTallyFile, parseTallyLedgerList } from './ledger-list';
import { partyLedgerName, type KnownList } from './mapping';
import {
  VoucherBuilder,
  groupJournals,
  mastersFor,
  remoteIdOf,
  totalsFor,
  voucherNumber,
  type BuildOptions,
  type BuiltVoucher,
  type LedgerRow,
} from './vouchers';

/** Strict enough for what this module writes: ASCII only, valid references, one root, nested tags. */
function assertWellFormed(xml: string) {
  expect(xml).toMatch(/^[\t\n\r\x20-\x7e]*$/);
  const refs = /&(?:amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);/gi;
  const stack: string[] = [];
  let roots = 0;
  for (const [token] of xml.matchAll(/<[^<>]*>|[^<>]+|[<>]/g)) {
    if (token[0] !== '<' && token[0] !== '>') {
      expect(token.replace(refs, ''), token).not.toMatch(/[&<>]/);
      if (!stack.length) expect(token.trim()).toBe('');
      continue;
    }
    const m = /^<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[A-Za-z_][\w.:-]*="[^"]*")*)\s*(\/?)>$/.exec(token);
    expect(m, token).not.toBeNull();
    const [, close, name, attrs, selfClosing] = m!;
    expect(attrs.replace(refs, '')).not.toMatch(/[&<]/);
    if (close) expect(stack.pop()).toBe(name);
    else if (!selfClosing) {
      if (!stack.length) roots++;
      stack.push(name);
    }
  }
  expect(stack).toEqual([]);
  expect(roots).toBe(1);
}

/** [ledger, ISDEEMEDPOSITIVE, AMOUNT] of every ledger entry, per voucher. */
const entriesOf = (xml: string) =>
  [...xml.matchAll(/<VOUCHER [\s\S]*?<\/VOUCHER>/g)].map(([block]) =>
    [
      ...block.matchAll(
        /<LEDGERNAME>(.*?)<\/LEDGERNAME>\s*<ISDEEMEDPOSITIVE>(Yes|No)<\/ISDEEMEDPOSITIVE>\s*<AMOUNT>(.*?)<\/AMOUNT>/g,
      ),
    ].map((m) => [m[1], m[2], m[3]]),
  );
const paise = (amount: string) => Math.round(Number(amount) * 100);

describe('Tally XML', () => {
  it('escapes text and writes everything outside printable ASCII as character references', () => {
    expect(xmlText(`A&B <"x"> 'y'`)).toBe('A&amp;B &lt;&quot;x&quot;&gt; &apos;y&apos;');
    expect(xmlText('Line 1\r\nLine 2\nTab\there')).toBe('Line 1&#13;&#10;Line 2&#13;&#10;Tab&#9;here');
    expect(xmlText('Fees ₹ – Café 😀')).toBe('Fees &#8377; &#8211; Caf&#233; &#128512;');
    // Characters XML 1.0 does not allow are dropped, not escaped.
    expect(xmlText('a\u0000\u0007\u0085\uffffb\ud800c')).toBe('abc');
    expect(xmlText(null)).toBe('');
  });

  it('formats amounts in rupees and dates as YYYYMMDD', () => {
    expect([0, 5, -5, 100, 123_450, -99_999_999].map(tallyAmount)).toEqual([
      '0.00',
      '0.05',
      '-0.05',
      '1.00',
      '1234.50',
      '-999999.99',
    ]);
    expect(() => tallyAmount(1.5)).toThrow(/Invalid amount/);
    expect(tallyDate('2026-04-01')).toBe('20260401');
    expect(() => tallyDate('2026-4-1')).toThrow(/Invalid date/);
  });

  const receipt = {
    remoteId: 'erpc-1-abc',
    voucherType: 'Receipt',
    date: '2026-04-01',
    voucherNumber: 'RCPT/2026/0001',
    partyLedger: 'Asha & Co',
    narration: 'Fee <cash>',
    lines: [
      { ledger: 'Cash', amount: 150_000 },
      { ledger: 'Asha & Co', amount: -150_000 },
    ],
  };

  it('writes debits as negative deemed-positive amounts and credits as positive amounts', () => {
    const xml = voucherXml(receipt);
    expect(xml).toContain(
      '<VOUCHER REMOTEID="erpc-1-abc" VCHTYPE="Receipt" ACTION="Create" OBJVIEW="Accounting Voucher View">',
    );
    expect(xml).toContain('<DATE>20260401</DATE>');
    expect(xml).toContain('<GUID>erpc-1-abc</GUID>');
    expect(xml).toContain('<VOUCHERNUMBER>RCPT/2026/0001</VOUCHERNUMBER>');
    expect(xml).toContain('<PARTYLEDGERNAME>Asha &amp; Co</PARTYLEDGERNAME>');
    expect(xml).toContain('<NARRATION>Fee &lt;cash&gt;</NARRATION>');
    expect(entriesOf(xml)).toEqual([
      [
        ['Cash', 'Yes', '-1500.00'],
        ['Asha &amp; Co', 'No', '1500.00'],
      ],
    ]);
  });

  it('refuses vouchers that do not balance', () => {
    const lines = (a: number, b: number) => [
      { ledger: 'Cash', amount: a },
      { ledger: 'Fee Income', amount: b },
    ];
    expect(() => voucherXml({ ...receipt, lines: lines(100, -99) })).toThrow(/does not balance/);
    expect(() => assertBalanced({ remoteId: 'x', lines: lines(0, 0) })).toThrow(/invalid amount/);
    expect(() => assertBalanced({ remoteId: 'x', lines: lines(0.5, -0.5) })).toThrow(/invalid amount/);
    expect(() => assertBalanced({ remoteId: 'x', lines: [{ ledger: 'Cash', amount: 1 }] })).toThrow(
      /two lines/,
    );
  });

  it('wraps masters and vouchers in an Import Data envelope for the company', () => {
    const masters = mastersXml('A & B "Classes"', [
      { name: 'Output CGST', parent: 'Duties & Taxes', gstDutyHead: 'Central Tax' },
      { name: 'Asha "Rao" (ADM-1)', parent: 'Sundry Debtors' },
    ]);
    assertWellFormed(masters);
    expect(masters).toContain('<TALLYREQUEST>Import Data</TALLYREQUEST>');
    expect(masters).toContain('<REPORTNAME>All Masters</REPORTNAME>');
    expect(masters).toContain('<SVCURRENTCOMPANY>A &amp; B &quot;Classes&quot;</SVCURRENTCOMPANY>');
    expect(masters).toContain('<LEDGER NAME="Output CGST" ACTION="Create">');
    expect(masters).toContain('<PARENT>Duties &amp; Taxes</PARENT>');
    expect(masters).toContain('<GSTDUTYHEAD>Central Tax</GSTDUTYHEAD>');
    expect(masters).toContain('<LEDGER NAME="Asha &quot;Rao&quot; (ADM-1)" ACTION="Create">');
    expect(masters.match(/<GSTDUTYHEAD>/g)).toHaveLength(1);

    const vouchers = vouchersXml(null, [receipt]);
    assertWellFormed(vouchers);
    expect(vouchers).toContain('<REPORTNAME>Vouchers</REPORTNAME>');
    expect(vouchers).not.toContain('SVCURRENTCOMPANY');
    expect(vouchersXml(null, [])).not.toContain('TALLYMESSAGE');
  });
});

let rowId = 0;
/** One journal's ledger rows; amounts are positive for debits, negative for credits. */
function journal(key: string, lines: [string, number][], extra: Partial<LedgerRow> = {}): LedgerRow[] {
  return lines.map(([account, amount], i) => ({
    id: ++rowId,
    journalKey: key,
    line: i + 1,
    entryDate: '2026-04-05',
    branchId: 1,
    account,
    debit: Math.max(amount, 0),
    credit: Math.max(-amount, 0),
    feeAccountId: 7,
    refType: 'payment',
    refId: 11,
    narration: 'Fee payment (cash)',
    createdAt: new Date('2026-04-05T10:00:00Z'),
    ...extra,
  }));
}

const options = (o: Partial<BuildOptions> = {}): BuildOptions => ({
  instituteId: 1,
  receivableMode: 'control',
  gstLedgers: 'split',
  voucherTypes: { ...TALLY_DEFAULT_VOUCHER_TYPES },
  overrides: new Map(),
  lookups: {
    banks: new Map([[3, { name: 'HDFC Current', branchId: 1 }]]),
    categories: new Map([[5, { kind: 'expense', name: 'Rent' }]]),
  },
  known: null,
  receipts: new Map([
    [11, { number: 'RCPT/2026/0001', invoiceNumber: 'INV/2026/0001', cgst: 90_000, sgst: 90_000, igst: 0 }],
    [12, { number: 'RCPT/2026/0002', invoiceNumber: 'INV/2026/0002', cgst: 0, sgst: 0, igst: 36_000 }],
  ]),
  students: new Map([[7, 'Asha Rao (ADM-001)']]),
  ...o,
});

const build = (rows: LedgerRow[], o?: Partial<BuildOptions>) => {
  const builder = new VoucherBuilder(options(o));
  return groupJournals(rows).map((j) => builder.build(j));
};
const linesOf = (v: BuiltVoucher) => v.lines.map((l) => [l.ledger, l.amount]);

describe('Tally vouchers from fee journals', () => {
  const payment = () =>
    journal('payment:11', [
      [L.CASH, 500_000],
      [L.RECEIVABLE, -450_000],
      [L.ADVANCE, -50_000],
    ]);

  it('exports a cash fee payment as a Receipt numbered like the fee receipt', () => {
    const [v] = build(payment());
    expect(v).toMatchObject({
      typeKey: 'receipt',
      voucherType: 'Receipt',
      voucherNumber: 'RCPT/2026/0001',
      partyLedger: 'Student Fees Receivable',
      amount: 500_000,
      skipReason: null,
      narration: 'Fee payment (cash); Student: Asha Rao (ADM-001) [payment:11]',
    });
    expect(linesOf(v)).toEqual([
      ['Cash', 500_000],
      ['Student Fees Receivable', -450_000],
      ['Student Fee Advances', -50_000],
    ]);
  });

  it('posts dues and advances to the student party ledger in party mode', () => {
    const [v] = build(payment(), { receivableMode: 'party' });
    expect(linesOf(v)).toEqual([
      ['Cash', 500_000],
      ['Asha Rao (ADM-001)', -500_000],
    ]);
    expect(v.partyLedger).toBe('Asha Rao (ADM-001)');
    expect(v.lines[1].group).toBe('Sundry Debtors');
  });

  it('splits output GST into CGST / SGST / IGST like the receipt, numbered like the invoice', () => {
    const gst = journal('payment-gst:11', [
      [L.FEE_INCOME, 180_000],
      [L.GST_PAYABLE, -180_000],
    ]);
    const [split] = build(gst);
    expect(split).toMatchObject({ typeKey: 'journal', voucherType: 'Journal', voucherNumber: 'INV/2026/0001' });
    expect(linesOf(split)).toEqual([
      ['Fee Income', 180_000],
      ['Output CGST', -90_000],
      ['Output SGST', -90_000],
    ]);
    expect(split.lines.map((l) => l.gstDutyHead)).toEqual([null, 'Central Tax', 'State Tax']);
    expect(linesOf(build(gst, { gstLedgers: 'single' })[0])).toEqual([
      ['Fee Income', 180_000],
      ['Output GST', -180_000],
    ]);
    const igst = journal(
      'payment-gst:12',
      [
        [L.FEE_INCOME, 36_000],
        [L.GST_PAYABLE, -36_000],
      ],
      { refId: 12 },
    );
    expect(linesOf(build(igst)[0])).toEqual([
      ['Fee Income', 36_000],
      ['Output IGST', -36_000],
    ]);
  });

  it('reverses GST on a refund in the same proportions, rounding half away from zero', () => {
    const [v] = build(
      journal('refund:4:gst', [
        [L.GST_PAYABLE, 45_001],
        [L.FEE_INCOME, -45_001],
      ]),
    );
    expect(v.voucherNumber).toBe('RFD-4-GST');
    expect(linesOf(v)).toEqual([
      ['Output CGST', 22_501],
      ['Output SGST', 22_500],
      ['Fee Income', -45_001],
    ]);
  });

  it('picks Payment, Contra and fee-charge voucher types from the cash / bank lines', () => {
    const vouchers = build(
      [
        ...journal('refund:4', [
          [L.RECEIVABLE, 150_000],
          [L.CASH, -150_000],
        ]),
        ...journal(
          'finance:9',
          [
            ['expense:5', 300_000],
            ['bank:3', -300_000],
          ],
          { refType: 'finance', refId: 9, feeAccountId: null, narration: 'Expense: Rent' },
        ),
        ...journal(
          'transfer:1',
          [
            ['bank:3', 20_000],
            [L.UNDEPOSITED, -20_000],
          ],
          { refType: 'transfer', refId: 1, feeAccountId: null, narration: 'Deposit' },
        ),
        ...journal(
          'charge:7',
          [
            [L.RECEIVABLE, 1_200_000],
            [L.FEE_INCOME, -1_200_000],
          ],
          { refType: 'account', refId: 7, narration: 'Fees: JEE' },
        ),
      ],
      { voucherTypes: { ...TALLY_DEFAULT_VOUCHER_TYPES, feeCharge: 'Fee Invoice' } },
    );
    expect(vouchers.map((v) => [v.voucherType, v.voucherNumber, v.partyLedger])).toEqual([
      ['Payment', 'RFD-4', 'Student Fees Receivable'],
      ['Payment', 'FIN-9', 'Rent'],
      ['Contra', 'TRANSFER-1', null],
      ['Fee Invoice', 'CHG-7', 'Student Fees Receivable'],
    ]);
    expect(vouchers[1].lines.map((l) => [l.ledger, l.group])).toEqual([
      ['Rent', 'Indirect Expenses'],
      ['HDFC Current', 'Bank Accounts'],
    ]);
  });

  it('treats ledgers under cash / bank groups of the imported Tally list as cash or bank', () => {
    const known: KnownList = {
      branchId: null,
      ledgers: new Map([['petty cash', { name: 'Petty Cash', parent: 'Office Cash' }]]),
      groups: new Map([['office cash', { name: 'Office Cash', parent: 'Cash-in-Hand' }]]),
      importedAt: new Date(),
    };
    const overrides = new Map([[0, new Map([[L.CASH, { name: 'Petty Cash', group: 'Cash-in-Hand' }]])]]);
    const [v] = build(payment(), { known, overrides });
    expect(v.typeKey).toBe('receipt');
    expect(mastersFor([v], known).map((m) => m.name)).toEqual(['Student Fee Advances', 'Student Fees Receivable']);
  });

  it('leaves out journals that net to zero in Tally or do not balance', () => {
    const overrides = new Map([[0, new Map([[L.LATE_FEE_INCOME, { name: 'Fee Income', group: 'Direct Incomes' }]])]]);
    const [zero, unbalanced] = build(
      [
        ...journal('adjustment:3', [
          [L.FEE_INCOME, 500],
          [L.LATE_FEE_INCOME, -500],
        ]),
        ...journal('payment:13', [
          [L.CASH, 500],
          [L.RECEIVABLE, -400],
        ]),
      ],
      { overrides },
    );
    expect(zero).toMatchObject({ skipReason: 'Nets to zero in Tally', lines: [], amount: 0 });
    expect(unbalanced).toMatchObject({ skipReason: 'Journal does not balance', lines: [], amount: 0 });
    expect(mastersFor([zero, unbalanced], null)).toEqual([]);
  });

  it('keeps REMOTEIDs stable and tells entry changes from mapping changes', () => {
    expect(remoteIdOf(1, 'payment:11')).toMatch(/^erpc-1-[0-9a-f]{32}$/);
    expect(remoteIdOf(1, 'payment:11')).toBe(remoteIdOf(1, 'payment:11'));
    expect(remoteIdOf(2, 'payment:11')).not.toBe(remoteIdOf(1, 'payment:11'));

    const [a] = build(payment());
    const [b] = build(payment());
    expect(b.remoteId).toBe(a.remoteId);
    expect([b.fingerprint, b.contentDigest]).toEqual([a.fingerprint, a.contentDigest]);
    const renamed = build(payment(), {
      overrides: new Map([[0, new Map([[L.CASH, { name: 'Cash Box', group: 'Cash-in-Hand' }]])]]),
    })[0];
    expect(renamed.fingerprint).toBe(a.fingerprint);
    expect(renamed.contentDigest).not.toBe(a.contentDigest);
    const edited = payment();
    edited[0].debit = 400_000;
    edited[1].credit = 350_000;
    expect(build(edited)[0].fingerprint).not.toBe(a.fingerprint);
  });

  it('reports one Tally ledger name used under different groups', () => {
    const overrides = new Map([[0, new Map([[L.CASH, { name: 'fee income', group: 'Cash-in-Hand' }]])]]);
    const builder = new VoucherBuilder(options({ overrides }));
    for (const j of groupJournals([
      ...payment(),
      ...journal('charge:7', [
        [L.RECEIVABLE, 100],
        [L.FEE_INCOME, -100],
      ]),
    ]))
      builder.build(j);
    expect(builder.conflicts()).toEqual([
      { tallyName: 'fee income', groups: ['Cash-in-Hand', 'Direct Incomes'], accounts: [L.CASH, L.FEE_INCOME] },
    ]);
  });

  it('caps voucher numbers and party ledger names at Tally-friendly lengths', () => {
    const key = `adjustment:${'9'.repeat(80)}`;
    const number = voucherNumber(key, undefined);
    expect(number).toHaveLength(50);
    expect(number).toMatch(/^ADJ-9+-[0-9a-f]{8}$/);
    expect(voucherNumber(key, undefined)).toBe(number);
    expect(voucherNumber('payment:11', { number: 'R\u0007 1', invoiceNumber: null, cgst: 0, sgst: 0, igst: 0 })).toBe(
      'R 1',
    );

    expect(partyLedgerName({ name: '  Asha \n Rao ', admissionNumber: 'ADM-001' }, 7)).toBe('Asha Rao (ADM-001)');
    expect(partyLedgerName({ name: 'Asha Rao', admissionNumber: null }, 7)).toBe('Asha Rao (ST-7)');
    const long = partyLedgerName({ name: 'N'.repeat(300), admissionNumber: 'ADM-001' }, 7);
    expect(long).toHaveLength(100);
    expect(long.endsWith(' (ADM-001)')).toBe(true);
  });

  it('writes balanced vouchers and per-ledger totals for a whole period', () => {
    const vouchers = build([
      ...payment(),
      ...journal('payment-gst:11', [
        [L.FEE_INCOME, 180_000],
        [L.GST_PAYABLE, -180_000],
      ]),
      ...journal('refund:4', [
        [L.RECEIVABLE, 150_000],
        [L.CASH, -150_000],
      ]),
    ]);
    const xml = vouchersXml(
      'Apex Classes',
      vouchers.map((v) => ({
        remoteId: v.remoteId,
        voucherType: v.voucherType,
        date: v.entryDate,
        voucherNumber: v.voucherNumber,
        partyLedger: v.partyLedger,
        narration: v.narration,
        lines: v.lines.map((l) => ({ ledger: l.ledger, amount: l.amount })),
      })),
    );
    assertWellFormed(xml);
    const entries = entriesOf(xml);
    expect(entries).toHaveLength(3);
    for (const voucher of entries) {
      expect(voucher.reduce((s, [, , amount]) => s + paise(amount), 0)).toBe(0);
      for (const [, deemedPositive, amount] of voucher) expect(deemedPositive === 'Yes').toBe(paise(amount) < 0);
    }
    expect(totalsFor(vouchers, null)).toEqual([
      { ledger: 'Cash', parent: 'Cash-in-Hand', debit: 500_000, credit: 150_000 },
      { ledger: 'Fee Income', parent: 'Direct Incomes', debit: 180_000, credit: 0 },
      { ledger: 'Output CGST', parent: 'Duties & Taxes', debit: 0, credit: 90_000 },
      { ledger: 'Output SGST', parent: 'Duties & Taxes', debit: 0, credit: 90_000 },
      { ledger: 'Student Fee Advances', parent: 'Current Liabilities', debit: 0, credit: 50_000 },
      { ledger: 'Student Fees Receivable', parent: 'Sundry Debtors', debit: 150_000, credit: 450_000 },
    ]);
  });
});

describe('Tally ledger list import', () => {
  const sample = [
    '<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA>',
    '<REQUESTDESC><REPORTNAME>All Masters</REPORTNAME></REQUESTDESC><REQUESTDATA>',
    '<TALLYMESSAGE xmlns:UDF="TallyUDF"><GROUP NAME="Fee Debtors" RESERVEDNAME="">',
    '<PARENT>Sundry Debtors</PARENT></GROUP></TALLYMESSAGE>',
    '<TALLYMESSAGE xmlns:UDF="TallyUDF"><GROUP NAME="Branch Funds" RESERVEDNAME="">',
    '<PARENT>&#4; Primary</PARENT></GROUP></TALLYMESSAGE>',
    '<TALLYMESSAGE xmlns:UDF="TallyUDF"><LEDGER NAME="Smith &amp; Sons &#8377;" RESERVEDNAME="">',
    '<PARENT>Sundry Creditors</PARENT><LANGUAGENAME.LIST><NAME.LIST TYPE="String">',
    '<NAME>Smith &amp; Sons &#8377;</NAME></NAME.LIST></LANGUAGENAME.LIST></LEDGER></TALLYMESSAGE>',
    '<TALLYMESSAGE xmlns:UDF="TallyUDF"><LEDGER><NAME.LIST><NAME>HDFC Bank</NAME></NAME.LIST>',
    '<PARENT>Bank Accounts</PARENT><LEDGERNAME>Not a master</LEDGERNAME></LEDGER></TALLYMESSAGE>',
    '<TALLYMESSAGE xmlns:UDF="TallyUDF"><LEDGER NAME="Cash"/><LEDGER NAME="CASH"><PARENT>Cash-in-Hand</PARENT></LEDGER>',
    '<VOUCHER VCHTYPE="Receipt"><LEDGERNAME>Cash</LEDGERNAME></VOUCHER></TALLYMESSAGE>',
    '</REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>',
  ].join('\r\n');

  it('reads ledgers and groups with their parents and skips duplicates', () => {
    expect(parseTallyLedgerList(sample)).toEqual({
      groups: [
        { kind: 'group', name: 'Fee Debtors', parent: 'Sundry Debtors' },
        { kind: 'group', name: 'Branch Funds', parent: null },
      ],
      ledgers: [
        { kind: 'ledger', name: 'Smith & Sons ₹', parent: 'Sundry Creditors' },
        { kind: 'ledger', name: 'HDFC Bank', parent: 'Bank Accounts' },
        { kind: 'ledger', name: 'Cash', parent: null },
      ],
      ignored: 1,
    });
  });

  it('decodes UTF-8 and UTF-16 files with or without a byte order mark', () => {
    const le = Buffer.from(sample, 'utf16le');
    const be = Buffer.from(le).swap16();
    expect(decodeTallyFile(Buffer.concat([Buffer.from([0xff, 0xfe]), le]))).toBe(sample);
    expect(decodeTallyFile(Buffer.concat([Buffer.from([0xfe, 0xff]), be]))).toBe(sample);
    expect(decodeTallyFile(le)).toBe(sample);
    expect(decodeTallyFile(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(sample)]))).toBe(sample);
    expect(decodeTallyFile(Buffer.from(sample))).toBe(sample);
  });
});
