/**
 * Report export download (final wave #18): an admin exports a report as CSV from the report page,
 * then downloads it again from "Report exports".
 *
 * Setup (API): a new institute with one batch. Browser: the admin opens "Capacity and utilisation",
 * exports it as CSV (small, so it is prepared at once and downloaded straight away), then finds the
 * export on "Report exports" and downloads it again. Both downloads are served as CSV attachments,
 * saved by the browser under the export's name, and are the same CSV, listing the batch.
 */
import { expect, test } from '../support/fixtures';
import { createBatch, createInstitute } from '../support/data';
import { savedDownload } from '../support/downloads';
import { actionSheet, activePage, expectToast } from '../support/ui';

const DOWNLOAD_URL = /\/api\/reports\/exports\/\d+\/download$/;

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
    await page.getByRole('button', { name: 'Export', exact: true }).click();
    const sheet = actionSheet(page);
    await expect(sheet).toContainText('Export Capacity and utilisation');

    const file = await savedDownload(page, DOWNLOAD_URL, () =>
      sheet.getByRole('button', { name: 'CSV', exact: true }).click(),
    );
    expect(file.response.headers()['content-type']).toBe('text/csv; charset=utf-8');
    expect(file.response.headers()['content-disposition']).toBe(
      `attachment; filename="${file.fileName}"; filename*=UTF-8''${file.fileName}`,
    );
    expect(file.fileName).toMatch(/^capacity-\d{4}-\d{2}-\d{2}-to-\d{4}-\d{2}-\d{2}\.csv$/);
    expect(file.text).toContain(batch.batchName);
    await expectToast(page, `Downloaded ${file.fileName}`);
    return file;
  });

  await test.step('the export is listed on "Report exports" and downloads again', async () => {
    const page = await openAs(institute.admin, '/reports/exports');
    const content = activePage(page);
    const row = content.locator('ion-item').filter({ hasText: 'Capacity and utilisation' });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText('CSV');
    await expect(row.locator('.status-chip')).toHaveText('Ready');

    const again = await savedDownload(page, DOWNLOAD_URL, () =>
      row.getByRole('button', { name: 'Download' }).click(),
    );
    expect(again.response.headers()['content-type']).toBe('text/csv; charset=utf-8');
    expect(again.fileName).toBe(csv.fileName);
    expect(again.text).toBe(csv.text);
  });
});
