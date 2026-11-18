/**
 * SaaS billing and the institute data lifecycle (final wave #16): subscribe → mock payment → paid
 * invoice PDF; data export → download; deletion request → super admin approval → purge, with the
 * SaaS invoice and payment kept for the operator, detached from the deleted institute.
 *
 * Setup (API): a new institute on the Growth plan (trial). Browser: the institute admin subscribes
 * on "Subscription & billing", pays the invoice through the mock gateway and downloads its PDF;
 * prepares a data export on "Data export & deletion" and downloads the zip; requests deletion by
 * typing the institute code. The super admin approves it on "Data deletion requests" with a grace
 * period of 0 days. The purge runs in the jobs worker; the invoice is then still readable by the
 * super admin, with no institute.
 */
import { expect, test } from '../support/fixtures';
import { ApiError } from '../support/api';
import { createInstitute } from '../support/data';
import { fetchDownload, openedUrl, trapWindowOpen } from '../support/downloads';
import { activePage, alertDialog, confirmAlert, expectToast, modal } from '../support/ui';

interface Invoice {
  id: number;
  number: string;
  instituteId: number | null;
  status: string;
}
interface DeletionRequest {
  id: number;
  instituteSlug: string;
  status: string;
}

test('SaaS subscribe → mock payment → invoice; data export and deletion keep the invoice', async ({
  http,
  superAdmin,
  openAs,
}) => {
  const institute = await createInstitute(http, superAdmin, 'saas');

  const invoice = await test.step('admin subscribes and pays the invoice with the mock gateway', async () => {
    const page = await openAs(institute.admin, '/subscription');
    const content = activePage(page);
    await content.getByRole('button', { name: /^(Subscribe now|Renew)$/ }).click();
    const checkout = modal(page);
    await expect(checkout.locator('ion-title')).toHaveText('Pay invoice');
    const number = (await checkout.locator('strong').first().textContent())!.trim();
    await checkout.getByRole('button', { name: /^Proceed to pay ₹/ }).click();
    await expect(checkout).toContainText('Test gateway. No real money moves.');
    await checkout.getByRole('button', { name: 'Pay now', exact: true }).click();
    await expectToast(page, 'Payment successful. Thank you!');
    await expect(checkout).toBeHidden();

    const row = content.locator('ion-item').filter({ hasText: number });
    await expect(row.locator('ion-badge')).toHaveText('paid');
    await row.click();
    const detail = modal(page);
    await expect(detail.locator('ion-title')).toHaveText(number);
    await expect(detail.locator('ion-badge').first()).toHaveText('paid');
    await expect(detail.locator('ion-item').filter({ hasText: 'mock' })).toContainText('success');

    await trapWindowOpen(page);
    await detail.getByRole('button', { name: 'PDF' }).click();
    const pdf = await fetchDownload(http, await openedUrl(page));
    expect(pdf.headers()['content-type']).toContain('application/pdf');
    expect((await pdf.body()).subarray(0, 5).toString()).toBe('%PDF-');
    await detail.getByRole('button', { name: 'Close' }).click();

    const invoices = await institute.admin.api.get<{ items: Invoice[] }>('/subscription/invoices');
    return invoices.items.find((i) => i.number === number)!;
  });
  expect(invoice).toMatchObject({ instituteId: institute.id, status: 'paid' });

  const page = await openAs(institute.admin, '/data');
  const content = activePage(page);

  await test.step('admin prepares a data export and downloads it', async () => {
    const exports = content.locator('ion-card').filter({ hasText: 'Data export' });
    await exports.getByRole('button', { name: 'Prepare export' }).click();
    await expectToast(page, 'Export queued. It appears here when ready.');
    const row = exports.locator('ion-item').first();
    // Prepared by the jobs worker; the card polls until it is ready.
    await expect(row.locator('ion-badge')).toHaveText('Ready', { timeout: 60_000 });

    await trapWindowOpen(page);
    await row.getByRole('button', { name: 'Download' }).click();
    const zip = await fetchDownload(http, await openedUrl(page));
    expect(zip.headers()['content-type']).toContain('application/zip');
    expect((await zip.body()).subarray(0, 2).toString()).toBe('PK');
  });

  await test.step('admin requests deletion by typing the institute code', async () => {
    const card = content.locator('ion-card').filter({ hasText: 'Delete institute' });
    await card.getByRole('button', { name: 'Request deletion…' }).click();
    const submit = card.getByRole('button', { name: 'Request deletion', exact: true });
    await expect(submit).toBeDisabled();
    await card.getByLabel(`Type the institute code ${institute.slug} to confirm`).fill(institute.slug);
    await card.getByLabel('Reason (optional)').fill('Closing the centre (E2E)');
    await submit.click();
    await expect(card.locator('ion-badge')).toHaveText('Awaiting approval');
    await expect(card).toContainText('The platform team will review the request.');
  });

  await test.step('super admin approves with no grace period; the institute is purged', async () => {
    const admin = await openAs(superAdmin, '/admin/data/deletion-requests');
    const list = activePage(admin);
    await list.getByPlaceholder('Search institute name or code').fill(institute.slug);
    const row = list.locator('ion-item').filter({ hasText: `(${institute.slug})` });
    await expect(row).toContainText('Reason: Closing the centre (E2E)');
    await row.getByRole('button', { name: 'Approve', exact: true }).click();
    await expect(alertDialog(admin)).toContainText(`Approve deleting ${institute.name}?`);
    await alertDialog(admin).getByLabel('Grace period in days').fill('0');
    // A second alert replaces the first one, so confirmAlert (which waits for it to close) can't be used.
    await alertDialog(admin).getByRole('button', { name: 'Approve', exact: true }).click();
    await expect(alertDialog(admin)).toContainText('Delete permanently now?');
    await confirmAlert(admin, 'Delete now');
    await expectToast(admin, 'Deletion started');

    await expect
      .poll(
        async () => {
          const res = await superAdmin.api.get<{ items: DeletionRequest[] }>(
            `/admin/tenant-data/deletion-requests?search=${institute.slug}`,
          );
          return res.items.find((r) => r.instituteSlug === institute.slug)?.status;
        },
        { timeout: 90_000 },
      )
      .toBe('completed');
    await admin.reload();
    await expect(row).toContainText('Deleted');
    await expect(row).toContainText('Kept for the operator');
  });

  await test.step('the SaaS invoice and payment are kept, with no institute', async () => {
    const kept = await superAdmin.api.get<{ invoice: Invoice; payments: { status: string }[] }>(
      `/admin/billing/invoices/${invoice.id}`,
    );
    expect(kept.invoice).toMatchObject({ number: invoice.number, status: 'paid', instituteId: null });
    expect(kept.payments.map((p) => p.status)).toEqual(['success']);
    // The deleted institute's admin can no longer use the API at all.
    const gone = await institute.admin.api.get('/subscription/invoices').catch((e: unknown) => e);
    expect(gone).toBeInstanceOf(ApiError);
    expect((gone as ApiError).status).toBe(401);
  });
});
