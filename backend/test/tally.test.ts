import { createHash } from 'node:crypto';
import request from 'supertest';
import { Op } from 'sequelize';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEMO_PASSWORD,
  USERS,
  bearer,
  getApp,
  idWatermarks,
  login,
  purgeCreatedSince,
  snapshotRows,
} from './helpers';
import { FeeLedgerEntry, FeeReceipt } from '../src/modules/fees/models';
import { AuditEvent } from '../src/shared/audit/audit-event.model';

let seq = 0;
const run = Date.now().toString(36).slice(-5).toUpperCase();
const mobile = () => `956${String(Date.now() % 10000).padStart(4, '0')}${String(seq++).padStart(3, '0')}`;

/** Purged afterwards in this order (dependants such as receipts, refunds and instalments go with them). */
const CREATED_TABLES = [
  'tally_export_vouchers',
  'tally_exports',
  'tally_known_ledgers',
  'tally_ledger_mappings',
  'tally_settings',
  'fee_ledger_entries',
  'fee_webhook_events',
  'fee_payments',
  'fee_accounts',
  'finance_entries',
  'finance_categories',
  'students',
  'users',
  'fee_structures',
  'courses',
  'fee_settings',
  'notification_messages',
  'jobs',
] as const;
let watermarks: Record<string, number>;
let auditMark: number;
let restoreFeeSettings: () => Promise<void>;

beforeAll(async () => {
  await getApp();
  watermarks = await idWatermarks(CREATED_TABLES);
  auditMark = (await idWatermarks(['audit_events'])).audit_events;
  restoreFeeSettings = await snapshotRows('fee_settings', 'institute_id = 1');
});

afterAll(async () => {
  await purgeCreatedSince(watermarks);
  await restoreFeeSettings();
});

/** The seeded Apex institute. */
const APEX = 1;
// No other suite posts journals in 2032, so the period holds only what this file creates.
const FROM = '2032-02-01';
const TO = '2032-02-29';
const PERIOD = `from=${FROM}&to=${TO}`;

/** A ledger list as Tally exports it (List of Accounts, XML): UTF-16 LE with a byte order mark. */
const TALLY_LIST = [
  '<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA><REQUESTDATA>',
  '<TALLYMESSAGE xmlns:UDF="TallyUDF"><GROUP NAME="Cash-in-Hand" RESERVEDNAME="Cash-in-Hand">',
  '<PARENT>&#4; Primary</PARENT></GROUP></TALLYMESSAGE>',
  '<TALLYMESSAGE xmlns:UDF="TallyUDF"><GROUP NAME="Fee Collections" RESERVEDNAME="">',
  '<PARENT>Direct Incomes</PARENT></GROUP></TALLYMESSAGE>',
  '<TALLYMESSAGE xmlns:UDF="TallyUDF"><LEDGER NAME="Cash Box" RESERVEDNAME="">',
  '<PARENT>Cash-in-Hand</PARENT></LEDGER></TALLYMESSAGE>',
  '<TALLYMESSAGE xmlns:UDF="TallyUDF"><LEDGER NAME="Fee Income" RESERVEDNAME="">',
  '<PARENT>Fee Collections</PARENT></LEDGER></TALLYMESSAGE>',
  '<TALLYMESSAGE xmlns:UDF="TallyUDF"><LEDGER NAME="Profit &amp; Loss A/c" RESERVEDNAME="Profit &amp; Loss A/c">',
  '<PARENT>&#4; Primary</PARENT></LEDGER></TALLYMESSAGE>',
  '</REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>',
].join('\r\n');
const TALLY_LIST_FILE = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(TALLY_LIST, 'utf16le')]);

type MappingItem = {
  account: string;
  tallyName: string;
  parentGroup: string;
  source: string;
  inheritedName: string;
  existsInTally: boolean | null;
  tallyParent: string | null;
  cashOrBank: boolean;
  used: boolean;
};
type Mapping = { branchId: number | null; items: MappingItem[]; knownLedgers: unknown };
type Total = { ledger: string; parent: string; debit: number; credit: number };
type ExportRow = { id: number; branchId: number | null };
type Reconciliation = {
  export: { laterEntries: number };
  counts: Record<string, number>;
  items: { flag: string; journalKey: string; amount: number; reverses: string | null }[];
  totals: (Omit<Total, 'debit' | 'credit'> & Record<string, number>)[];
  exportedTotal: number;
  currentTotal: number;
  inSync: boolean;
};

/** Every VOUCHER element of a Tally import file, by REMOTEID. */
function vouchersOf(xml: string) {
  const out = new Map<string, string>();
  for (const [block] of xml.matchAll(/<VOUCHER [\s\S]*?<\/VOUCHER>/g))
    out.set(/REMOTEID="([^"]+)"/.exec(block)![1], block);
  return out;
}
const tag = (block: string, name: string) =>
  new RegExp(`<${name}>([^<]*)</${name}>`).exec(block)?.[1] ?? null;
/** [ledger, ISDEEMEDPOSITIVE, AMOUNT] of each ledger entry. */
const entriesOf = (block: string) =>
  [
    ...block.matchAll(
      /<LEDGERNAME>(.*?)<\/LEDGERNAME>\s*<ISDEEMEDPOSITIVE>(Yes|No)<\/ISDEEMEDPOSITIVE>\s*<AMOUNT>(.*?)<\/AMOUNT>/g,
    ),
  ].map((m) => [m[1], m[2], m[3]]);
const paiseOf = (block: string) =>
  [...block.matchAll(/<AMOUNT>(-?\d+\.\d{2})<\/AMOUNT>/g)].map((m) => Math.round(Number(m[1]) * 100));

describe('Tally accounting export', () => {
  let app: Awaited<ReturnType<typeof getApp>>;
  let admin: string;
  let branchAdmin: string;
  let teacher: string;
  let zenith: string;
  let accountant: string;
  let K: number;
  let B: number;
  let aK: number;
  let aB: number;
  let pK: number;
  let pB: number;
  let receiptK: { number: string; invoiceNumber: string | null };
  let categoryId: number;
  let expenseId: number;
  let exportId: number;
  const company = `Apex & Sons <Pune> ${run}`;
  const rent = `Rent ${run}`;
  const studentK = `Tally Kothrud ${run}`;

  const remoteId = (journalKey: string) =>
    `erpc-${APEX}-${createHash('sha256').update(journalKey).digest('hex').slice(0, 32)}`;
  const mappingOf = async (token: string, branchId?: number) => {
    const r = await request(app)
      .get(`/api/tally/mappings${branchId ? `?branchId=${branchId}` : ''}`)
      .set(bearer(token));
    expect(r.status).toBe(200);
    return r.body as Mapping;
  };
  const itemOf = (m: Mapping, account: string) => m.items.find((i) => i.account === account)!;
  const putMapping = (body: object, token = accountant) =>
    request(app).put('/api/tally/mappings').set(bearer(token)).send(body);
  const reconcile = async () => {
    const r = await request(app).get(`/api/tally/exports/${exportId}/reconciliation`).set(bearer(accountant));
    expect(r.status).toBe(200);
    return r.body as Reconciliation;
  };
  const flagged = (r: Reconciliation, flag: string) => r.items.filter((i) => i.flag === flag);
  const download = (path: string, token: string) =>
    request(app)
      .get(`/api/tally${path}`)
      .set(bearer(token))
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks).toString('utf8')));
      });
  const pay = async (accountId: number, amount: number, mode: string, paidOn: string, extra = {}) => {
    const r = await request(app)
      .post('/api/fees/payments/offline')
      .set(bearer(admin))
      .send({ accountId, amount, mode, paidOn, ...extra });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body as { id: number; receiptId: number };
  };

  beforeAll(async () => {
    app = await getApp();
    [admin, branchAdmin, teacher, zenith] = await Promise.all(
      [USERS.apexAdmin, USERS.apexBranchAdmin, USERS.apexTeacher, USERS.zenithAdmin].map(
        async (u) => (await login(u)).accessToken,
      ),
    );
    const roles = await request(app).get('/api/roles').set(bearer(admin));
    const role = roles.body.find((r: { slug: string }) => r.slug === 'accountant');
    const acct = { mobile: mobile(), password: DEMO_PASSWORD };
    const user = await request(app)
      .post('/api/users')
      .set(bearer(admin))
      .send({ name: 'Tally Accountant', ...acct, roles: [{ roleId: role.id, branchId: null }] });
    expect(user.status).toBe(201);
    accountant = (await login(acct)).accessToken;
    const branches = (await request(app).get('/api/branches').set(bearer(admin))).body as {
      id: number;
      name: string;
    }[];
    K = branches.find((b) => b.name === 'Kothrud')!.id;
    B = branches.find((b) => b.name === 'Baner')!.id;

    const gst = await request(app)
      .put('/api/fees/settings')
      .set(bearer(admin))
      .send({ gstEnabled: true, gstRatePercent: 18, gstin: '27ABCDE1234F1Z5' });
    expect(gst.status).toBe(200);
    const course = await request(app)
      .post('/api/academics/courses')
      .set(bearer(admin))
      .send({ name: `Tally JEE ${run}`, code: `TJ-${run}` });
    expect(course.status).toBe(201);
    const structure = await request(app)
      .post('/api/fees/structures')
      .set(bearer(admin))
      .send({
        name: `Tally fees ${run}`,
        courseId: course.body.id,
        components: [{ name: 'Coaching', amount: 1_180_000, taxable: true }],
        instalmentPlan: { type: 'one_time' },
      });
    expect(structure.status).toBe(201);
    const enrol = async (name: string, branchId: number) => {
      const s = await request(app)
        .post('/api/students')
        .set(bearer(admin))
        .send({ name, mobile: mobile(), branchId });
      expect(s.status).toBe(201);
      const a = await request(app)
        .post('/api/fees/accounts')
        .set(bearer(admin))
        .send({ studentId: s.body.id, structureId: structure.body.id });
      expect(a.status).toBe(201);
      return a.body.id as number;
    };
    aK = await enrol(studentK, K);
    aB = await enrol(`Tally Baner ${run}`, B);
    // Fee charges post today; move them into the export period.
    await FeeLedgerEntry.update(
      { entryDate: FROM },
      { where: { instituteId: APEX, journalKey: [`charge:${aK}`, `charge:${aB}`] } },
    );

    const paidK = await pay(aK, 1_180_000, 'cash', '2032-02-10');
    pK = paidK.id;
    const rc = (await FeeReceipt.findOne({ where: { instituteId: APEX, id: paidK.receiptId } }))!;
    receiptK = { number: rc.number, invoiceNumber: rc.invoiceNumber };
    pB = (await pay(aB, 590_000, 'upi', '2032-02-12', { referenceNo: `UPI-${run}` })).id;

    const category = await request(app)
      .post('/api/fees/finance/categories')
      .set(bearer(accountant))
      .send({ kind: 'expense', name: rent });
    expect(category.status).toBe(201);
    categoryId = category.body.id;
    const expense = await request(app).post('/api/fees/finance/entries').set(bearer(accountant)).send({
      kind: 'expense',
      categoryId,
      amount: 250_000,
      mode: 'cash',
      date: '2032-02-15',
      branchId: K,
      party: 'Landlord & Co <Pune>',
    });
    expect(expense.status).toBe(201);
    expenseId = expense.body.id;
  });

  it('keeps settings per institute and branch, for accountants and admins', async () => {
    expect((await request(app).get('/api/tally/settings')).status).toBe(401);
    expect((await request(app).get('/api/tally/settings').set(bearer(teacher))).status).toBe(403);
    const own = await request(app).get('/api/tally/settings').set(bearer(branchAdmin));
    expect(own.status).toBe(200);
    expect(own.body.branchId).toBe(K);
    expect((await request(app).get('/api/tally/settings?branchId=all').set(bearer(branchAdmin))).status).toBe(
      403,
    );
    expect(
      (await request(app).put('/api/tally/settings').set(bearer(branchAdmin)).send({ companyName: 'X' }))
        .status,
    ).toBe(403);

    const inst = await request(app)
      .put('/api/tally/settings')
      .set(bearer(accountant))
      .send({ companyName: `  ${company} ` });
    expect(inst.status).toBe(200);
    expect(inst.body).toMatchObject({
      branchId: null,
      values: { companyName: company, receivableMode: null, gstLedgers: null, voucherTypes: null },
      effective: { companyName: company, receivableMode: 'control', gstLedgers: 'split' },
    });

    const baner = await request(app)
      .put('/api/tally/settings')
      .set(bearer(accountant))
      .send({ branchId: B, voucherTypes: { receipt: 'Fee Receipt' } });
    expect(baner.status).toBe(200);
    expect(baner.body).toMatchObject({
      branchId: B,
      values: { companyName: null, voucherTypes: { receipt: 'Fee Receipt' } },
      inherited: { companyName: company, voucherTypes: { receipt: 'Receipt' } },
      effective: { companyName: company, voucherTypes: { receipt: 'Fee Receipt', payment: 'Payment' } },
    });
    expect((await request(app).get(`/api/tally/settings?branchId=${B}`).set(bearer(admin))).body).toEqual(
      baner.body,
    );
    const reset = await request(app).put('/api/tally/settings').set(bearer(accountant)).send({ branchId: B });
    expect(reset.body.values.voucherTypes).toBeNull();
    expect(reset.body.effective.voucherTypes.receipt).toBe('Receipt');

    for (const body of [
      { voucherTypes: { sales: 'Sales' } },
      { voucherTypes: { receipt: 'r'.repeat(51) } },
      { companyName: 'x'.repeat(151) },
      { receivableMode: 'ledger' },
    ]) {
      const bad = await request(app).put('/api/tally/settings').set(bearer(accountant)).send(body);
      expect(bad.status, JSON.stringify(body)).toBe(422);
      expect(bad.body.error.code).toBe('VALIDATION_ERROR');
    }

    const z = await request(app).get('/api/tally/settings').set(bearer(zenith));
    expect(z.status).toBe(200);
    expect(z.body.effective.companyName).not.toBe(company);
    expect(
      (
        await request(app)
          .put('/api/tally/settings')
          .set(bearer(zenith))
          .send({ branchId: K, companyName: 'Z' })
      ).status,
    ).toBe(404);
  });

  it('maps app ledger accounts to Tally ledgers per institute and branch', async () => {
    const defaults = await mappingOf(accountant);
    expect(defaults.branchId).toBeNull();
    expect(itemOf(defaults, 'cash')).toMatchObject({
      tallyName: 'Cash',
      parentGroup: 'Cash-in-Hand',
      source: 'default',
      existsInTally: null,
      cashOrBank: true,
    });
    expect(itemOf(defaults, `expense:${categoryId}`)).toMatchObject({
      tallyName: rent,
      parentGroup: 'Indirect Expenses',
      used: true,
    });
    expect(itemOf(defaults, 'gst_payable:cgst')).toMatchObject({
      tallyName: 'Output CGST',
      parentGroup: 'Duties & Taxes',
    });

    expect((await putMapping({ items: [{ account: 'cash', tallyName: 'X' }] }, branchAdmin)).status).toBe(
      403,
    );
    const inst = await putMapping({ items: [{ account: 'cash', tallyName: 'Cash Box' }] });
    expect(inst.status).toBe(200);
    expect(itemOf(inst.body, 'cash')).toMatchObject({
      tallyName: 'Cash Box',
      parentGroup: 'Cash-in-Hand',
      source: 'institute',
    });

    const baner = await putMapping({
      branchId: B,
      items: [
        { account: 'undeposited_funds', tallyName: 'Baner Cheques in Hand' },
        { account: 'fee_income', tallyName: 'Baner Fees', parentGroup: 'Direct Incomes' },
      ],
    });
    expect(baner.status).toBe(200);
    expect(itemOf(baner.body, 'undeposited_funds')).toMatchObject({
      tallyName: 'Baner Cheques in Hand',
      parentGroup: 'Cash-in-Hand',
      source: 'branch',
      inheritedName: 'Cheques in Hand',
    });
    expect(itemOf(baner.body, 'cash')).toMatchObject({ tallyName: 'Cash Box', source: 'institute' });
    const removed = await putMapping({ branchId: B, items: [{ account: 'fee_income', tallyName: null }] });
    expect(itemOf(removed.body, 'fee_income')).toMatchObject({ tallyName: 'Fee Income', source: 'default' });
    expect(itemOf(await mappingOf(accountant, K), 'undeposited_funds').tallyName).toBe('Cheques in Hand');

    // Tally ledger names are case-insensitive: one name can't sit under two groups.
    const conflict = await putMapping({
      items: [{ account: 'fee_income', tallyName: 'cash box', parentGroup: 'Direct Incomes' }],
    });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe('TALLY_MAPPING_CONFLICT');
    expect(conflict.body.error.details.conflicts[0].accounts).toEqual(
      expect.arrayContaining(['cash', 'fee_income']),
    );
    for (const [items, status] of [
      [[{ account: 'Cash!', tallyName: 'X' }], 400],
      [
        [
          { account: 'cash', tallyName: 'A' },
          { account: 'cash', tallyName: 'B' },
        ],
        400,
      ],
      [[{ account: 'cash', tallyName: '   ' }], 400],
      [[], 422],
    ] as const)
      expect((await putMapping({ items })).status, JSON.stringify(items)).toBe(status);
    expect(itemOf(await mappingOf(accountant), 'fee_income').tallyName).toBe('Fee Income');
    expect(itemOf(await mappingOf(zenith), 'cash')).toMatchObject({ tallyName: 'Cash', source: 'default' });
  });

  it('reads the ledger list exported from Tally', async () => {
    const upload = (token: string, file: Buffer) =>
      request(app)
        .post('/api/tally/known-ledgers')
        .set(bearer(token))
        .attach('file', file, { filename: 'List of Accounts.xml', contentType: 'application/xml' });
    expect((await upload(branchAdmin, TALLY_LIST_FILE)).status).toBe(403);
    const noFile = await request(app).post('/api/tally/known-ledgers').set(bearer(accountant));
    expect(noFile.status).toBe(400);
    expect(noFile.body.error.code).toBe('FILE_REQUIRED');

    const imported = await upload(accountant, TALLY_LIST_FILE);
    expect(imported.status).toBe(201);
    expect(imported.body).toMatchObject({ branchId: null, ledgers: 3, groups: 2, matched: 2 });
    const empty = await upload(accountant, Buffer.from('<ENVELOPE><BODY></BODY></ENVELOPE>'));
    expect(empty.status).toBe(400);
    expect(empty.body.error.code).toBe('TALLY_LIST_EMPTY');

    const search = await request(app).get('/api/tally/known-ledgers?search=CASH').set(bearer(accountant));
    expect(search.body).toMatchObject({ branchId: null, info: { branchId: null, ledgers: 3, groups: 2 } });
    expect(search.body.ledgers).toEqual([{ kind: 'ledger', name: 'Cash Box', parent: 'Cash-in-Hand' }]);
    expect(search.body.groups).toEqual([{ kind: 'group', name: 'Cash-in-Hand', parent: null }]);
    const all = await request(app).get('/api/tally/known-ledgers').set(bearer(accountant));
    expect(all.body.ledgers.map((l: { name: string }) => l.name)).toEqual([
      'Cash Box',
      'Fee Income',
      'Profit & Loss A/c',
    ]);
    // A branch without its own list uses the institute's.
    const branch = await request(app).get(`/api/tally/known-ledgers?branchId=${K}`).set(bearer(accountant));
    expect(branch.body).toMatchObject({ branchId: K, info: { branchId: null, ledgers: 3 } });

    const mapping = await mappingOf(accountant);
    expect(mapping.knownLedgers).toMatchObject({ branchId: null, ledgers: 3, groups: 2 });
    expect(itemOf(mapping, 'cash')).toMatchObject({
      existsInTally: true,
      tallyParent: 'Cash-in-Hand',
      cashOrBank: true,
    });
    expect(itemOf(mapping, 'fee_income')).toMatchObject({
      existsInTally: true,
      tallyParent: 'Fee Collections',
    });
    expect(itemOf(mapping, 'student_receivable').existsInTally).toBe(false);

    const z = await request(app).get('/api/tally/known-ledgers').set(bearer(zenith));
    expect(z.body).toMatchObject({ info: null, ledgers: [], groups: [] });
  });

  it('previews the vouchers and new ledgers of a period', async () => {
    const preview = await request(app).get(`/api/tally/preview?${PERIOD}`).set(bearer(accountant));
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({
      from: FROM,
      to: TO,
      branchId: null,
      onlyNew: false,
      companyName: company,
      receivableMode: 'control',
      counts: { vouchers: 7, alreadyExported: 0, changedSinceExport: 0, skipped: 0 },
      byType: { Journal: 4, Receipt: 2, Payment: 1 },
      totalAmount: 4_650_000,
      conflicts: [],
    });
    const totals = new Map((preview.body.totals as Total[]).map((t) => [t.ledger, t]));
    expect(totals.get('Output CGST')).toEqual({
      ledger: 'Output CGST',
      parent: 'Duties & Taxes',
      debit: 0,
      credit: 135_000,
    });
    expect(totals.get('Output SGST')).toMatchObject({ debit: 0, credit: 135_000 });
    expect(totals.get('Cash Box')).toMatchObject({
      parent: 'Cash-in-Hand',
      debit: 1_180_000,
      credit: 250_000,
    });
    expect(totals.get('Baner Cheques in Hand')).toMatchObject({ debit: 590_000, credit: 0 });
    expect(totals.get('Fee Income')).toMatchObject({
      parent: 'Fee Collections',
      debit: 270_000,
      credit: 2_360_000,
    });
    expect(totals.get(rent)).toMatchObject({ parent: 'Indirect Expenses', debit: 250_000, credit: 0 });
    const sum = (k: 'debit' | 'credit') => (preview.body.totals as Total[]).reduce((s, t) => s + t[k], 0);
    expect([sum('debit'), sum('credit')]).toEqual([4_650_000, 4_650_000]);
    // Ledgers already in Tally (Cash Box, Fee Income) are not created again.
    expect(preview.body.newLedgers).toEqual([
      { name: 'Baner Cheques in Hand', parent: 'Cash-in-Hand' },
      { name: 'Output CGST', parent: 'Duties & Taxes' },
      { name: 'Output SGST', parent: 'Duties & Taxes' },
      { name: rent, parent: 'Indirect Expenses' },
      { name: 'Student Fees Receivable', parent: 'Sundry Debtors' },
    ]);

    const own = await request(app).get(`/api/tally/preview?${PERIOD}`).set(bearer(branchAdmin));
    expect(own.body).toMatchObject({
      branchId: K,
      counts: { vouchers: 4 },
      byType: { Journal: 2, Receipt: 1, Payment: 1 },
    });
    for (const q of ['branchId=all', `branchId=${B}`])
      expect(
        (await request(app).get(`/api/tally/preview?${PERIOD}&${q}`).set(bearer(branchAdmin))).status,
      ).toBe(403);
    expect((await request(app).get(`/api/tally/preview?${PERIOD}`).set(bearer(teacher))).status).toBe(403);
    for (const [q, status] of [
      [`from=${TO}&to=${FROM}`, 400],
      [`from=2031-01-01&to=${TO}`, 400],
      ['from=2032-2-1&to=2032-02-29', 422],
    ] as const)
      expect((await request(app).get(`/api/tally/preview?${q}`).set(bearer(accountant))).status, q).toBe(
        status,
      );
  });

  it('exports masters and vouchers files with stable ids and balanced vouchers', async () => {
    const created = await request(app)
      .post('/api/tally/exports')
      .set(bearer(accountant))
      .send({ from: FROM, to: TO });
    expect(created.status).toBe(201);
    exportId = created.body.id;
    expect(created.body).toMatchObject({
      branchId: null,
      branchName: null,
      from: FROM,
      to: TO,
      onlyNew: false,
      companyName: company,
      receivableMode: 'control',
      voucherCount: 7,
      skippedCount: 0,
      alreadyExportedCount: 0,
      ledgerCount: 5,
      totalAmount: 4_650_000,
      typeCounts: { Journal: 4, Receipt: 2, Payment: 1 },
      createdBy: { name: 'Tally Accountant' },
      laterEntries: 0,
    });
    const detail = await request(app).get(`/api/tally/exports/${exportId}`).set(bearer(admin));
    expect(detail.status).toBe(200);
    expect(detail.body.masters).toHaveLength(5);
    expect(detail.body.skipped).toEqual([]);
    expect(detail.body.totals.find((t: Total) => t.ledger === 'Output CGST')).toMatchObject({
      credit: 135_000,
    });
    const list = await request(app).get('/api/tally/exports').set(bearer(accountant));
    expect(list.body.items[0]).toMatchObject({ id: exportId, voucherCount: 7 });

    const masters = await download(`/exports/${exportId}/masters.xml`, accountant);
    expect(masters.status).toBe(200);
    expect(masters.headers['content-type']).toBe('application/xml; charset=utf-8');
    expect(masters.headers['content-disposition']).toMatch(/^attachment;/);
    expect(masters.headers['content-disposition']).toContain(
      `tally-${exportId}-${FROM}-to-${TO}-masters.xml`,
    );
    expect(masters.headers['cache-control']).toBe('no-store');
    expect(masters.headers['x-content-type-options']).toBe('nosniff');
    const mastersXml = masters.body as string;
    expect(mastersXml).toContain('<REPORTNAME>All Masters</REPORTNAME>');
    expect(mastersXml).toContain(`<SVCURRENTCOMPANY>Apex &amp; Sons &lt;Pune&gt; ${run}</SVCURRENTCOMPANY>`);
    expect([...mastersXml.matchAll(/<LEDGER NAME="([^"]+)"/g)].map((m) => m[1]).sort()).toEqual(
      ['Baner Cheques in Hand', 'Output CGST', 'Output SGST', rent, 'Student Fees Receivable'].sort(),
    );
    expect(mastersXml).toMatch(
      /<LEDGER NAME="Output CGST" ACTION="Create">\s*<PARENT>Duties &amp; Taxes<\/PARENT>[\s\S]*?<GSTDUTYHEAD>Central Tax<\/GSTDUTYHEAD>/,
    );

    const vouchers = await download(`/exports/${exportId}/vouchers.xml`, accountant);
    expect(vouchers.status).toBe(200);
    expect(vouchers.headers['content-disposition']).toContain(
      `tally-${exportId}-${FROM}-to-${TO}-vouchers.xml`,
    );
    const xml = vouchers.body as string;
    expect(xml).toMatch(/^[\t\r\n\x20-\x7e]*$/);
    expect(xml).toContain('<REPORTNAME>Vouchers</REPORTNAME>');
    const byId = vouchersOf(xml);
    const keys = [
      `charge:${aK}`,
      `charge:${aB}`,
      `payment:${pK}`,
      `payment-gst:${pK}`,
      `payment:${pB}`,
      `payment-gst:${pB}`,
      `finance:${expenseId}`,
    ];
    expect([...byId.keys()].sort()).toEqual(keys.map(remoteId).sort());
    for (const [id, block] of byId) {
      expect(tag(block, 'GUID')).toBe(id);
      expect(paiseOf(block).reduce((s, a) => s + a, 0)).toBe(0);
    }
    const receipt = byId.get(remoteId(`payment:${pK}`))!;
    expect(receipt).toContain('VCHTYPE="Receipt"');
    expect(tag(receipt, 'DATE')).toBe('20320210');
    expect(tag(receipt, 'VOUCHERNUMBER')).toBe(receiptK.number);
    expect(tag(receipt, 'PARTYLEDGERNAME')).toBe('Student Fees Receivable');
    expect(tag(receipt, 'NARRATION')).toContain(`Student: ${studentK} (`);
    expect(entriesOf(receipt)).toEqual([
      ['Cash Box', 'Yes', '-11800.00'],
      ['Student Fees Receivable', 'No', '11800.00'],
    ]);
    const tax = byId.get(remoteId(`payment-gst:${pK}`))!;
    expect(tax).toContain('VCHTYPE="Journal"');
    expect(tag(tax, 'VOUCHERNUMBER')).toBe(receiptK.invoiceNumber);
    expect(entriesOf(tax)).toEqual([
      ['Fee Income', 'Yes', '-1800.00'],
      ['Output CGST', 'No', '900.00'],
      ['Output SGST', 'No', '900.00'],
    ]);
    expect(entriesOf(byId.get(remoteId(`payment:${pB}`))!)[0]).toEqual([
      'Baner Cheques in Hand',
      'Yes',
      '-5900.00',
    ]);
    const expense = byId.get(remoteId(`finance:${expenseId}`))!;
    expect(expense).toContain('VCHTYPE="Payment"');
    expect(tag(expense, 'DATE')).toBe('20320215');
    expect(tag(expense, 'VOUCHERNUMBER')).toBe(`FIN-${expenseId}`);
    expect(tag(expense, 'NARRATION')).toBe(
      `${rent} &#8211; Landlord &amp; Co &lt;Pune&gt; [finance:${expenseId}]`,
    );

    expect((await download(`/exports/${exportId}/vouchers.xml`, teacher)).status).toBe(403);
    expect((await download(`/exports/${exportId}/vouchers.xml`, zenith)).status).toBe(404);
    expect((await request(app).get(`/api/tally/exports/${exportId}`).set(bearer(zenith))).status).toBe(404);

    const again = await request(app).get(`/api/tally/preview?${PERIOD}&onlyNew=true`).set(bearer(accountant));
    expect(again.body.counts).toEqual({ vouchers: 0, alreadyExported: 7, changedSinceExport: 0, skipped: 0 });
    const none = await request(app)
      .post('/api/tally/exports')
      .set(bearer(accountant))
      .send({ from: FROM, to: TO, onlyNew: true });
    expect(none.status).toBe(400);
    expect(none.body.error).toMatchObject({
      code: 'TALLY_NOTHING_TO_EXPORT',
      message: 'Everything in this period has already been exported to this Tally company',
    });
  });

  it('flags entries added, reversed, changed or removed after an export', async () => {
    const fresh = await reconcile();
    expect(fresh).toMatchObject({
      inSync: true,
      items: [],
      exportedTotal: 4_650_000,
      currentTotal: 4_650_000,
    });
    expect(fresh.counts).toEqual({ new: 0, changed: 0, removed: 0, reversed: 0, mapping: 0 });
    expect(fresh.totals.every((t) => t.difference === 0)).toBe(true);

    const later = await pay(aB, 118_000, 'cash', '2032-02-20');
    let r = await reconcile();
    expect(r.inSync).toBe(false);
    expect(flagged(r, 'new').map((i) => i.journalKey)).toEqual([
      `payment-gst:${later.id}`,
      `payment:${later.id}`,
    ]);
    expect(r.export.laterEntries).toBe(2);
    expect(r.currentTotal).toBe(4_650_000 + 118_000 + 18_000);

    // Refunds post today, outside the period, but still undo an exported receipt.
    const refund = await request(app)
      .post(`/api/fees/payments/${pK}/refund`)
      .set(bearer(admin))
      .send({ amount: 118_000, reason: 'Batch change' });
    expect(refund.status).toBe(201);
    r = await reconcile();
    expect(flagged(r, 'reversed')).toEqual([
      expect.objectContaining({
        journalKey: expect.stringMatching(/^refund:\d+$/),
        amount: 118_000,
        reverses: receiptK.number,
      }),
      expect.objectContaining({
        journalKey: expect.stringMatching(/^refund:\d+:gst$/),
        amount: 18_000,
        reverses: receiptK.number,
      }),
    ]);
    expect(r.currentTotal).toBe(4_650_000 + 136_000);

    const journal = { journalKey: `finance:${expenseId}` };
    const where = { instituteId: APEX, ...journal };
    await FeeLedgerEntry.update({ debit: 260_000 }, { where: { ...where, debit: { [Op.gt]: 0 } } });
    await FeeLedgerEntry.update({ credit: 260_000 }, { where: { ...where, credit: { [Op.gt]: 0 } } });
    r = await reconcile();
    expect(flagged(r, 'changed')).toEqual([expect.objectContaining({ ...journal, amount: 260_000 })]);
    expect(r.totals.find((t) => t.ledger === rent)).toMatchObject({
      exportedDebit: 250_000,
      currentDebit: 260_000,
      difference: 10_000,
    });

    await FeeLedgerEntry.destroy({ where: { instituteId: APEX, journalKey: `charge:${aB}` } });
    r = await reconcile();
    expect(flagged(r, 'removed')).toEqual([
      expect.objectContaining({ journalKey: `charge:${aB}`, amount: 1_180_000 }),
    ]);

    // Renaming a ledger changes the vouchers Tally holds without changing the journal.
    const renamed = await putMapping({
      items: [{ account: 'gst_payable:cgst', tallyName: 'Output CGST 9%' }],
    });
    expect(renamed.status).toBe(200);
    r = await reconcile();
    expect(
      flagged(r, 'mapping')
        .map((i) => i.journalKey)
        .sort(),
    ).toEqual([`payment-gst:${pB}`, `payment-gst:${pK}`].sort());
    expect(r.counts).toEqual({ new: 2, changed: 1, removed: 1, reversed: 2, mapping: 2 });
    expect((await putMapping({ items: [{ account: 'gst_payable:cgst', tallyName: null }] })).status).toBe(
      200,
    );

    for (const token of [branchAdmin, zenith])
      expect(
        (await request(app).get(`/api/tally/exports/${exportId}/reconciliation`).set(bearer(token))).status,
      ).toBe(404);
  });

  it('keeps branch exports to the branch', async () => {
    const preview = await request(app).get(`/api/tally/preview?${PERIOD}`).set(bearer(branchAdmin));
    expect(preview.body.counts).toEqual({
      vouchers: 4,
      alreadyExported: 3,
      changedSinceExport: 1,
      skipped: 0,
    });
    const onlyNew = await request(app).get(`/api/tally/preview?${PERIOD}&onlyNew=1`).set(bearer(branchAdmin));
    expect(onlyNew.body.counts).toMatchObject({ vouchers: 1, alreadyExported: 3, changedSinceExport: 1 });

    const created = await request(app)
      .post('/api/tally/exports')
      .set(bearer(branchAdmin))
      .send({ from: FROM, to: TO });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      branchId: K,
      branchName: 'Kothrud',
      voucherCount: 4,
      typeCounts: { Journal: 2, Receipt: 1, Payment: 1 },
    });
    const branchExport = created.body.id as number;
    const file = await download(`/exports/${branchExport}/vouchers.xml`, branchAdmin);
    expect(file.status).toBe(200);
    // The same journal keeps its Tally id in every export, so re-importing alters rather than duplicates.
    expect(vouchersOf(file.body as string).has(remoteId(`payment:${pK}`))).toBe(true);

    const ids = async (path: string, token: string, branch?: number) => {
      let req = request(app).get(`/api/tally${path}`).set(bearer(token));
      if (branch) req = req.set('X-Branch-Id', String(branch));
      const res = await req;
      expect(res.status).toBe(200);
      return (res.body.items as ExportRow[]).map((e) => e.id);
    };
    expect(await ids('/exports', branchAdmin)).toEqual(expect.arrayContaining([branchExport]));
    expect(await ids('/exports', branchAdmin)).not.toContain(exportId);
    expect(await ids('/exports', admin, K)).not.toContain(exportId);
    expect(await ids(`/exports?branchId=${K}`, admin)).not.toContain(exportId);
    expect(await ids('/exports?branchId=all', admin)).toEqual(expect.arrayContaining([exportId]));
    expect(await ids('/exports?branchId=all', admin)).not.toContain(branchExport);
    expect((await request(app).get(`/api/tally/exports/${exportId}`).set(bearer(branchAdmin))).status).toBe(
      404,
    );
    const scoped = (id: number) =>
      request(app).get(`/api/tally/exports/${id}`).set(bearer(admin)).set('X-Branch-Id', String(K));
    expect((await scoped(exportId)).status).toBe(404);
    expect((await scoped(branchExport)).status).toBe(200);
  });

  it('keeps institutes apart', async () => {
    const preview = await request(app).get(`/api/tally/preview?${PERIOD}`).set(bearer(zenith));
    expect(preview.status).toBe(200);
    expect(preview.body.counts.vouchers).toBe(0);
    const none = await request(app)
      .post('/api/tally/exports')
      .set(bearer(zenith))
      .send({ from: FROM, to: TO });
    expect(none.status).toBe(400);
    expect(none.body.error.code).toBe('TALLY_NOTHING_TO_EXPORT');
    const list = await request(app).get('/api/tally/exports').set(bearer(zenith));
    expect(list.status).toBe(200);
    expect(list.body.items.some((e: ExportRow) => e.id === exportId)).toBe(false);
    expect(
      (await request(app).get(`/api/tally/preview?${PERIOD}&branchId=${K}`).set(bearer(zenith))).status,
    ).toBe(404);
  });

  it('clears the Tally ledger list and audits every change', async () => {
    expect((await request(app).delete('/api/tally/known-ledgers').set(bearer(branchAdmin))).status).toBe(403);
    expect((await request(app).delete('/api/tally/known-ledgers').set(bearer(accountant))).body).toEqual({
      deleted: 5,
    });
    expect((await request(app).delete('/api/tally/known-ledgers').set(bearer(accountant))).body).toEqual({
      deleted: 0,
    });

    const events = await AuditEvent.findAll({
      where: { id: { [Op.gt]: auditMark }, action: { [Op.like]: 'tally.%' } },
      order: [['id', 'ASC']],
    });
    expect(new Set(events.map((e) => e.action))).toEqual(
      new Set([
        'tally.settings.updated',
        'tally.mapping.updated',
        'tally.ledgers.imported',
        'tally.ledgers.cleared',
        'tally.export.created',
        'tally.export.downloaded',
      ]),
    );
    expect(events.every((e) => e.instituteId === APEX)).toBe(true);
    // Logged against their branch (null: institute-wide), so branch admins see their branch's events.
    expect(events.filter((e) => e.branchId !== (e.metadata?.branchId ?? null))).toEqual([]);
    expect(new Set(events.map((e) => e.branchId))).toEqual(new Set([null, K, B]));
    expect(events.filter((e) => e.action === 'tally.ledgers.cleared')).toHaveLength(1);
    expect(
      events.find((e) => e.action === 'tally.export.created' && e.entityId === String(exportId))?.metadata,
    ).toMatchObject({ branchId: null, from: FROM, to: TO, vouchers: 7, totalAmount: 4_650_000 });
    expect(events.filter((e) => e.action === 'tally.export.downloaded').map((e) => e.metadata?.file)).toEqual(
      expect.arrayContaining(['masters', 'vouchers']),
    );
  });
});
