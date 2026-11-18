/**
 * Report export download (final wave #18): an admin exports a report as CSV from the report page,
 * then downloads it again from "Report exports".
 *
 * Setup (API): a new institute with one batch. Browser: the admin opens "Capacity and utilisation",
 * exports it as CSV (small, so it is prepared at once and opened as a signed download link), then
 * finds the export on "Report exports" with its row count and downloads it again. Both downloads
 * are fetched over HTTP and are the same CSV, listing the batch.
 */
import { expect, test } from '../support/fixtures';
import { createBatch, createInstitute } from '../support/data';
import { fetchDownload, openedUrl, trapWindowOpen } from '../support/downloads';
import { actionSheet, activePage } from '../support/ui';

test('report export → download from the report and from "Report exports"', async ({
  http,
  superAdmin,
  openAs,
}) => {
  const institute = await createInstitute(http, superAdmin, 'reports');
  const batch = await createBatch(institute, { label: 'Maths' });

  const csv = await test.step('admin exports the capacity report as CSV', async () => {
    const page = await openAs(institute.admin, '/reports/capacity');
    const content = activePage(page);
    await expect(content.getByText('Batch seat utilisation and classroom occupancy.')).toBeVisible();
    await trapWindowOpen(page);
    await page.getByRole('button', { name: 'Export', exact: true }).click();
    const sheet = actionSheet(page);
    await expect(sheet).toContainText('Export Capacity and utilisation');
    await sheet.getByRole('button', { name: 'CSV', exact: true }).click();
    await expect(sheet).toBeHidden();

    const file = await fetchDownload(http, await openedUrl(page));
    // Stored text files are served as sandboxed plain text (file-response policy), named .csv.
    expect(file.headers()['content-type']).toBe('text/plain; charset=utf-8');
    expect(file.headers()['content-disposition']).toMatch(/filename=".*\.csv"/);
    const text = await file.text();
    expect(text).toContain(batch.batchName);
    return text;
  });

  await test.step('the export is listed on "Report exports" and downloads again', async () => {
    const page = await openAs(institute.admin, '/reports/exports');
    const content = activePage(page);
    const row = content.locator('ion-item').filter({ hasText: 'Capacity and utilisation' });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText('CSV');
    await expect(row.locator('ion-badge')).toHaveText('Ready');

    await trapWindowOpen(page);
    await row.getByRole('button', { name: 'Download' }).click();
    const again = await fetchDownload(http, await openedUrl(page));
    expect(await again.text()).toBe(csv);
  });
});
