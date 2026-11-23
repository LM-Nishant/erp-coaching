/**
 * Course marketplace (wave 2): instructor revenue, refunds and monthly payouts.
 *
 * Setup (API): an independent instructor publishes a ₹499 course and two learners buy it with the mock gateway.
 * The platform admin sets the payout hold to 0 days so today's sales are due (restored at the end).
 * Browser: one learner asks for a refund on their order and the admin approves it; the instructor sees their
 * earnings and adds bank payout details; the admin creates the payout run and marks the instructor's payout paid
 * with a UTR; the instructor sees the paid payout and its statement, including the reversed sale.
 */
import { expect, test } from '../support/fixtures';
import { Api, loginWithPassword, newDevice, type Session } from '../support/api';
import { API_URL } from '../support/env';
import { PASSWORD, uniqueId } from '../support/data';
import { activePage, alertDialog, confirmAlert, expectToast } from '../support/ui';

let lastMobile = 0;
/** Test mobiles in the 967… range used by the payout spec. */
function payoutMobile(): string {
  lastMobile = Math.max(lastMobile + 1, Math.floor(Date.now() / 100));
  return `967${String(lastMobile % 10_000_000).padStart(7, '0')}`;
}

async function signUp(
  http: Parameters<typeof loginWithPassword>[0],
  name: string,
  label: string,
): Promise<Session> {
  const mobile = payoutMobile();
  await new Api(http).post('/marketplace/public/signup', { name, mobile, password: PASSWORD });
  return loginWithPassword(http, { mobile, password: PASSWORD }, newDevice(label));
}

interface Settings {
  minPayoutPaise: number;
  holdDays: number;
  refundWindowDays: number;
}

test('refund → payout details → monthly payout run marked paid → statement', async ({
  http,
  superAdmin,
  openAs,
}) => {
  const tag = uniqueId();
  const sellerName = `Arun Sitar ${tag}`;
  const utr = `UTR${tag.replace(/[^A-Za-z0-9]/g, '').toUpperCase()}`.slice(0, 30);
  const base = '/marketplace/instructor';

  const instructor = await signUp(http, 'Arun Sitar', 'payout-instructor');
  const { courseId } = await test.step('an instructor publishes a paid course', async () => {
    const { api } = instructor;
    await api.put('/marketplace/instructor-profile', { displayName: sellerName, headline: 'Sitar player' });
    const categories = await superAdmin.api.post<{ id: number; name: string }[]>(
      '/admin/marketplace/categories',
      {
        name: `Music ${tag}`,
      },
    );
    const category = categories.find((c) => c.name === `Music ${tag}`)!;
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
      'base64',
    );
    const media = await api.post<{ id: number }>(`${base}/media`, {
      kind: 'image',
      name: 'cover.png',
      mimeType: 'image/png',
      sizeBytes: png.length,
    });
    const put = await http.fetch(`${API_URL}/api${base}/media/${media.id}/content?offset=0`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${instructor.accessToken}`,
        'Content-Type': 'application/octet-stream',
      },
      data: png,
    });
    expect(put.ok(), await put.text()).toBe(true);
    await expect
      .poll(async () => (await api.get<{ status: string }>(`${base}/media/${media.id}`)).status)
      .toBe('ready');
    const course = await api.post<{ id: number }>(`${base}/courses`, {
      title: `Sitar for beginners ${tag}`,
      subtitle: 'Your first ragas',
      description: 'Hold the sitar, play clean notes and learn two simple ragas in short daily lessons.',
      categoryId: category.id,
      pricePaise: 49_900,
      outcomes: ['Play clean notes', 'Play two ragas'],
      thumbnailMediaId: media.id,
    });
    const withSection = await api.post<{ sections: { id: number }[] }>(
      `${base}/courses/${course.id}/sections`,
      {
        title: 'Start here',
      },
    );
    await api.post(`${base}/courses/${course.id}/sections/${withSection.sections.at(-1)!.id}/lectures`, {
      title: 'Holding the sitar',
      type: 'article',
      articleBody: 'Sit cross-legged and rest the gourd on your left foot.',
      preview: true,
    });
    await api.post(`${base}/courses/${course.id}/submit`);
    await superAdmin.api.post(`/admin/marketplace/courses/${course.id}/approve`, {});
    return { courseId: course.id };
  });

  const buy = async (learner: Session) => {
    const checkout = await learner.api.post<{ orderId: number }>('/marketplace/checkout', {
      courseIds: [courseId],
    });
    await learner.api.post(`/marketplace/orders/${checkout.orderId}/mock-complete`, { outcome: 'success' });
    return learner.api.get<{ id: number; number: string; status: string }>(
      `/marketplace/orders/${checkout.orderId}`,
    );
  };
  const keeper = await signUp(http, 'Nisha Learner', 'payout-learner-1');
  const refunder = await signUp(http, 'Vikram Learner', 'payout-learner-2');
  await buy(keeper);
  const refundOrder = await buy(refunder);
  expect(refundOrder.status).toBe('paid');

  const saved = await superAdmin.api.get<Settings>('/admin/marketplace/payout-settings');
  await superAdmin.api.put('/admin/marketplace/payout-settings', {
    ...saved,
    holdDays: 0,
    minPayoutPaise: 100,
  });
  try {
    await test.step('a learner asks for a refund and the admin approves it', async () => {
      const learnerPage = await openAs(refunder, `/market/orders/${refundOrder.id}`);
      const order = activePage(learnerPage);
      await order.getByTestId('request-refund').click();
      await learnerPage.getByTestId('refund-reason').locator('textarea').fill('Bought it by mistake');
      await learnerPage.getByTestId('refund-submit').click();
      await expect(order.getByText('Requested')).toBeVisible();

      const admin = await openAs(superAdmin, '/admin/marketplace/refunds');
      const card = activePage(admin).locator('ion-card').filter({ hasText: refundOrder.number });
      await card.getByRole('button', { name: /Approve/ }).click();
      await confirmAlert(admin, 'Refund');
      await expectToast(admin, 'Refunded');
      await learnerPage.reload();
      await expect(activePage(learnerPage).getByText('Refunded').first()).toBeVisible();
    });

    const instructorPage = await openAs(instructor, '/market/studio/instructor/revenue');
    await test.step('the instructor sees their earnings and adds payout details', async () => {
      const revenue = activePage(instructorPage);
      await expect(revenue.getByTestId('revenue-net')).not.toContainText('₹0.00');
      await revenue.getByTestId('add-payout-account').click();
      await expect(instructorPage).toHaveURL(/\/payout-account$/);
      const form = activePage(instructorPage);
      await form.getByTestId('payout-holder').locator('input').fill('Arun Sitar');
      await form.getByTestId('payout-account-number').locator('input').fill('123456789012');
      await form.getByTestId('payout-account-confirm').locator('input').fill('123456789012');
      await form.getByTestId('payout-ifsc').locator('input').fill('SBIN0001234');
      await form.getByTestId('payout-save').click();
      await expectToast(instructorPage, 'Payout details saved');
      await expect(form.getByTestId('payout-account-current')).toContainText('XXXX9012');
    });

    await test.step('the admin creates the payout run and marks the payout paid', async () => {
      const admin = await openAs(superAdmin, '/admin/marketplace/payouts');
      const runs = activePage(admin);
      // Pay everything sold up to today (IST), not just last month.
      const today = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
      await runs.getByTestId('period-end').locator('input').fill(today);
      await runs.getByTestId('period-end').locator('input').press('Tab');
      const row = runs.getByTestId('payout-preview').locator('tr').filter({ hasText: sellerName });
      await expect(row).toContainText('₹349.30');
      await expect(row).not.toContainText('Carried forward');
      await runs.getByTestId('create-run').click();
      await confirmAlert(admin, 'Create');
      await expect(admin).toHaveURL(/\/admin\/marketplace\/payouts\/\d+$/);
      const card = activePage(admin).locator('ion-card').filter({ hasText: sellerName });
      await expect(card).toContainText('To pay');
      await card.getByRole('button', { name: 'Mark paid' }).click();
      await alertDialog(admin).locator('input').fill(utr);
      await confirmAlert(admin, 'Mark paid');
      await expectToast(admin, 'Marked paid');
      await expect(card).toContainText(utr);
    });

    await test.step('the instructor sees the paid payout and its statement', async () => {
      await instructorPage.goto('/market/studio/instructor/payouts');
      const list = activePage(instructorPage);
      await expect(list.locator('ion-item').first()).toContainText('Paid');
      await list.locator('ion-item').first().click();
      const statement = activePage(instructorPage);
      await expect(statement.getByTestId('payout-paid-line')).toContainText(utr);
      await expect(statement.locator('tbody tr')).toHaveCount(3);
      await expect(statement.locator('tr.refund')).toContainText(refundOrder.number);
    });
  } finally {
    await superAdmin.api.put('/admin/marketplace/payout-settings', saved);
  }
});
