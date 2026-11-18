/**
 * Spec §7 — Website: the institute publishes its website → a visitor submits the enquiry form on
 * the public site → staff see the lead in admissions.
 *
 * Setup (API): a new institute (its website is not live yet). Browser: the institute admin opens
 * the website builder, notes the live-site address and publishes the starter home page. A visitor
 * (no login) opens the public site, fills in the enquiry form and sends it. Staff then find the
 * website enquiry in Admissions → Enquiries with the visitor's details and message.
 */
import { expect, test } from '../support/fixtures';
import { createInstitute, uniqueId, uniqueMobile } from '../support/data';
import { API_URL } from '../support/env';
import { activePage, expectToast, modal } from '../support/ui';

test('website publish → visitor enquiry → staff see the lead', async ({ http, superAdmin, openAs }) => {
  const institute = await createInstitute(http, superAdmin, 'website');
  const publicUrl = `${API_URL}/api/public/sites/${institute.slug}`;
  const visitor = {
    name: `Visitor ${uniqueId()}`,
    mobile: uniqueMobile(),
    email: `visitor-${uniqueId()}@example.com`,
    course: 'JEE Main crash course',
    message: 'Are weekend batches available for class 12?',
  };

  await test.step('admin publishes the starter home page', async () => {
    expect((await http.get(publicUrl)).status(), 'the site is not live before publishing').toBe(404);

    const page = await openAs(institute.admin, '/website');
    const content = activePage(page);
    await expect(content.getByText('Live site:')).toBeVisible();
    await expect(content.getByRole('link', { name: publicUrl, exact: true })).toHaveAttribute(
      'href',
      publicUrl,
    );
    const home = content
      .locator('ion-item')
      .filter({ has: page.getByRole('heading', { name: 'Home', exact: true }) });
    await expect(home.locator('ion-badge')).toHaveText('Draft');
    await home.click();
    await expect(page).toHaveURL(/\/website\/pages\/\d+$/);

    await expect(content.getByText('Not published yet')).toBeVisible();
    await content.getByRole('button', { name: 'Publish', exact: true }).click();
    await expectToast(page, 'Published v1');
    await expect(content.locator('ion-badge').filter({ hasText: 'Published' })).toBeVisible();
    await expect(content.getByText(/Live version v1 · /)).toBeVisible();
  });

  await test.step('visitor opens the public site and sends an enquiry', async () => {
    const page = await openAs(null, publicUrl);
    await expect(page.getByRole('heading', { name: `Welcome to ${institute.name}` })).toBeVisible();
    const form = page.locator('section').filter({
      has: page.getByRole('heading', { name: 'Have a question? Enquire now' }),
    });
    await form.getByLabel('Name *', { exact: true }).fill(visitor.name);
    await form.getByLabel('Mobile *', { exact: true }).fill(visitor.mobile);
    await form.getByLabel('Email', { exact: true }).fill(visitor.email);
    await form.getByLabel('Course of interest', { exact: true }).fill(visitor.course);
    await form.getByLabel('Message', { exact: true }).fill(visitor.message);
    await form.getByRole('button', { name: 'Send enquiry' }).click();

    await expect(page).toHaveURL(/[?&]submitted=/);
    await expect(form.getByRole('status')).toHaveText('Thank you! We will contact you shortly.');
  });

  await test.step('staff see the website enquiry in admissions', async () => {
    const page = await openAs(institute.admin, '/admissions/enquiries');
    const lead = activePage(page).locator('ion-item').filter({ hasText: visitor.name });
    await expect(lead).toContainText(`${visitor.mobile} · Website · ${visitor.course}`);
    await expect(lead.locator('ion-badge')).toHaveText('New');

    await lead.click();
    const detail = modal(page);
    await expect(detail.locator('ion-title')).toHaveText(visitor.name);
    await expect(detail).toContainText(`${visitor.mobile} · ${visitor.email} · Website`);
    await expect(detail).toContainText(`Interested in: ${visitor.course}`);
    await expect(detail).toContainText(visitor.message);
    await expect(detail).toContainText('Submitted on the website (page "home").');
  });
});
