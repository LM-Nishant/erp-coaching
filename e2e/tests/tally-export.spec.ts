/**
 * Tally export (accounting integration, spec §8): an accountant exports the month's fee and finance
 * entries as TallyPrime XML and reconciles the export with the app.
 *
 * Setup (API): a new institute with 18% GST, a student whose ₹11,800 course fee is half paid in cash,
 * a rent expense, and an accountant. Browser: in "Tally settings" the accountant imports the ledger
 * list exported from Tally (it has Cash and Fee Income) and sets the company name. On "Tally export"
 * they preview this month and create the export, then download the masters file (only the ledgers
 * Tally lacks) and the vouchers file (balanced vouchers with fixed ids) from the export's page, which
 * shows the export in sync. After the rest of the fee is paid, the export lists that receipt as
 * recorded after the export, and the history shows "2 later".
 */
import { expect, test } from '../support/fixtures';
import { loginWithPassword, newDevice } from '../support/api';
import { addStaff, addStudent, createBatch, createInstitute, isoDate } from '../support/data';
import { savedDownload } from '../support/downloads';
import { activePage, expectToast, selectSegment } from '../support/ui';

const FEE = 1_180_000; // ₹11,800 including 18% GST
const COMPANY = 'Sharma & Sons <Pune>';
const RENT = 'Rent & Electricity';
/** The ledgers the masters file creates: those the app uses that the Tally list lacks. */
const NEW_LEDGERS = ['Output CGST', 'Output SGST', RENT, 'Student Fees Receivable'];
const MASTERS_URL = /\/api\/tally\/exports\/\d+\/masters\.xml$/;
const VOUCHERS_URL = /\/api\/tally\/exports\/\d+\/vouchers\.xml$/;

/** The List of Accounts as Tally exports it (XML): UTF-16 LE with a byte order mark. */
const TALLY_LIST = Buffer.concat([
  Buffer.from([0xff, 0xfe]),
  Buffer.from(
    [
      '<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA><REQUESTDATA>',
      '<TALLYMESSAGE xmlns:UDF="TallyUDF"><LEDGER NAME="Cash" RESERVEDNAME="">',
      '<PARENT>Cash-in-Hand</PARENT></LEDGER></TALLYMESSAGE>',
      '<TALLYMESSAGE xmlns:UDF="TallyUDF"><LEDGER NAME="Fee Income" RESERVEDNAME="">',
      '<PARENT>Direct Incomes</PARENT></LEDGER></TALLYMESSAGE>',
      '<TALLYMESSAGE xmlns:UDF="TallyUDF"><LEDGER NAME="Profit &amp; Loss A/c" RESERVEDNAME="Profit &amp; Loss A/c">',
      '<PARENT>&#4; Primary</PARENT></LEDGER></TALLYMESSAGE>',
      '</REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>',
    ].join('\r\n'),
    'utf16le',
  ),
]);

const escapeXml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The vouchers in a vouchers file, with their line amounts in paise (Tally: debits are negative). */
function vouchersIn(xml: string) {
  return [...xml.matchAll(/<VOUCHER REMOTEID="([^"]+)" VCHTYPE="([^"]+)"[\s\S]*?<\/VOUCHER>/g)].map((m) => ({
    remoteId: m[1],
    type: m[2],
    number: /<VOUCHERNUMBER>([^<]*)<\/VOUCHERNUMBER>/.exec(m[0])?.[1],
    amounts: [...m[0].matchAll(/<AMOUNT>(-?\d+\.\d{2})<\/AMOUNT>/g)].map((a) =>
      Math.round(Number(a[1]) * 100),
    ),
  }));
}

test('Tally export → masters and vouchers files → reconciliation', async ({ http, superAdmin, openAs }) => {
  const institute = await createInstitute(http, superAdmin, 'tally');
  const { api } = institute.admin;
  await api.put('/fees/settings', { gstEnabled: true, gstRatePercent: 18, gstin: '27ABCDE1234F1Z5' });
  const batch = await createBatch(institute, { label: 'JEE' });
  const structure = await api.post<{ id: number }>('/fees/structures', {
    kind: 'course',
    courseId: batch.courseId,
    name: `${batch.courseName} fees`,
    status: 'active',
    components: [{ name: 'Coaching', amount: FEE, taxable: true }],
    instalmentPlan: { type: 'one_time' },
  });
  const student = await addStudent(institute, 'Riya Sharma');
  const account = await api.post<{ id: number }>('/fees/accounts', {
    studentId: student.studentId,
    structureId: structure.id,
  });
  const payHalf = async () => {
    const { id } = await api.post<{ id: number }>('/fees/payments/offline', {
      accountId: account.id,
      amount: FEE / 2,
      mode: 'cash',
      paidOn: isoDate(),
    });
    return api.get<{ id: number; receiptNumber: string }>(`/fees/payments/${id}`);
  };
  const firstPayment = await payHalf();
  const category = await api.post<{ id: number }>('/fees/finance/categories', {
    kind: 'expense',
    name: RENT,
  });
  await api.post('/fees/finance/entries', {
    kind: 'expense',
    categoryId: category.id,
    amount: 250_000,
    mode: 'cash',
    date: isoDate(),
    branchId: institute.branchId,
    party: 'Landlord',
  });
  const accountant = await loginWithPassword(
    http,
    await addStaff(institute, 'accountant', 'Tally Accountant'),
    newDevice('accountant'),
  );
  // The page's default period: this month up to today.
  const to = isoDate();
  const from = `${to.slice(0, 8)}01`;

  const page = await openAs(accountant, '/accounting/tally');
  const content = activePage(page);

  await test.step('accountant imports the ledger list from Tally and names the company', async () => {
    await expect(content.getByText('No exports yet.')).toBeVisible();
    await content.getByRole('link', { name: 'Tally settings and ledger mapping' }).click();
    await selectSegment(content, 'Tally list');
    await expect(content.getByText('No Tally list imported.')).toBeVisible();
    await content.getByLabel(/Import a list/).setInputFiles({
      name: 'List of Accounts.xml',
      mimeType: 'application/xml',
      buffer: TALLY_LIST,
    });
    await expectToast(page, /Imported 3 ledgers and 0 groups\. 2 mapped ledgers are in Tally/);
    await expect(content.getByText('3 ledgers and 0 groups')).toBeVisible();

    await selectSegment(content, 'Company');
    await content.getByLabel('Tally company name').fill(COMPANY);
    await content.getByRole('button', { name: 'Save', exact: true }).click();
    await expectToast(page, 'Tally settings saved');
    await content.getByRole('button', { name: 'back' }).click();
  });

  const exportId = await test.step('accountant previews this month and creates the export', async () => {
    await expect(content.getByLabel('From', { exact: true })).toHaveValue(from);
    await expect(content.getByLabel('To', { exact: true })).toHaveValue(to);
    await content.getByRole('button', { name: 'Preview', exact: true }).click();
    const stat = (label: string) => content.locator('ion-card').filter({ hasText: label });
    // Fee charge and the GST on the receipt (journals), the receipt, and the rent paid.
    await expect(stat('Vouchers')).toContainText('4');
    for (const type of ['Journal 2', 'Receipt 1', 'Payment 1'])
      await expect(stat('Vouchers')).toContainText(type);
    await expect(stat('Total (debits)')).toContainText('₹21,100.00');
    await expect(stat('New ledgers')).toContainText(String(NEW_LEDGERS.length));
    await expect(content.getByText(`Tally company: ${COMPANY}`)).toBeVisible();
    const newLedgers = content.locator('ion-list').filter({ hasText: 'Ledgers the masters file creates' });
    await expect(newLedgers.locator('ion-item')).toHaveCount(NEW_LEDGERS.length);
    for (const name of NEW_LEDGERS) await expect(newLedgers.getByText(name, { exact: true })).toBeVisible();

    await content.getByRole('button', { name: 'Create export' }).click();
    await expectToast(page, 'Export created: 4 vouchers');
    await expect(page).toHaveURL(/\/accounting\/tally\/exports\/\d+$/);
    return Number(/(\d+)$/.exec(page.url())![1]);
  });

  await test.step('accountant downloads the masters and vouchers files', async () => {
    await expect(content.getByText('The app still matches this export.')).toBeVisible();

    const masters = await savedDownload(page, MASTERS_URL, () =>
      content.getByRole('button', { name: 'Masters' }).click(),
    );
    expect(masters.response.headers()['content-type']).toBe('application/xml; charset=utf-8');
    expect(masters.response.headers()['content-disposition']).toBe(
      `attachment; filename="${masters.fileName}"; filename*=UTF-8''${masters.fileName}`,
    );
    expect(masters.fileName).toBe(`tally-${exportId}-${from}-to-${to}-masters.xml`);
    expect(masters.text).toContain(`<SVCURRENTCOMPANY>${escapeXml(COMPANY)}</SVCURRENTCOMPANY>`);
    expect([...masters.text.matchAll(/<LEDGER NAME="([^"]+)" ACTION="Create">/g)].map((m) => m[1])).toEqual(
      NEW_LEDGERS.map(escapeXml),
    );
    await expectToast(page, `Downloaded ${masters.fileName}`);

    const vouchers = await savedDownload(page, VOUCHERS_URL, () =>
      content.getByRole('button', { name: 'Vouchers' }).click(),
    );
    expect(vouchers.fileName).toBe(`tally-${exportId}-${from}-to-${to}-vouchers.xml`);
    expect(vouchers.text).toContain(`<SVCURRENTCOMPANY>${escapeXml(COMPANY)}</SVCURRENTCOMPANY>`);
    const list = vouchersIn(vouchers.text);
    expect(list.map((v) => v.type).sort()).toEqual(['Journal', 'Journal', 'Payment', 'Receipt']);
    for (const v of list) {
      expect(v.remoteId).toMatch(new RegExp(`^erpc-${institute.id}-[0-9a-f]{32}$`));
      expect(
        v.amounts.reduce((sum, a) => sum + a, 0),
        `voucher ${v.number} balances`,
      ).toBe(0);
    }
    const receipt = list.find((v) => v.type === 'Receipt')!;
    expect(receipt.number).toBe(firstPayment.receiptNumber);
    expect(receipt.amounts.sort((a, b) => a - b)).toEqual([-FEE / 2, FEE / 2]);
    await expectToast(page, `Downloaded ${vouchers.fileName}`);
  });

  await test.step('a payment recorded after the export shows up in its reconciliation', async () => {
    const secondPayment = await payHalf();
    await page.reload();
    await expect(content.getByText('The app has changed since this export.')).toBeVisible();
    const later = content.locator('ion-list').filter({ hasText: 'Recorded after the export' });
    await expect(later.locator('ion-list-header ion-badge')).toHaveText('2');
    await expect(
      later.locator('ion-item').filter({ hasText: `Receipt ${secondPayment.receiptNumber}` }),
    ).toContainText('₹5,900.00');

    await content.getByRole('button', { name: 'back' }).click();
    const row = content.locator('ion-item').filter({ hasText: '4 vouchers' });
    await expect(row).toContainText('All branches');
    await expect(row).toContainText('new only');
    await expect(row.locator('ion-badge')).toHaveText('2 later');
  });
});
