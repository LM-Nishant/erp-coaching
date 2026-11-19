/**
 * Spec §7 — Admission → online fee payment (mock gateway) → LMS access.
 *
 * Setup (API, institute admin): a course and batch, an active ₹12,000 one-time course fee
 * structure, the mock payment gateway, a published paid lecture, and a pending application taken
 * with a misspelt name and no batch.
 * Browser: the admin corrects the application and picks the batch, then admits the applicant into
 * it (the fee account follows from the structure); the new student signs in with a mobile OTP and
 * finds the lecture locked, pays through the mock checkout (a declined attempt first, then a
 * successful one) and can then open the lecture. Replaying the gateway's signed result must not
 * post the payment twice.
 */
import { expect, test } from '../support/fixtures';
import { createBatch, createInstitute, uniqueMobile } from '../support/data';
import { actionSheet, activePage, chooseOption, expectToast, modal, signInWithOtp } from '../support/ui';

const FEE_PAISE = 1_200_000;
const FEE = '₹12,000.00';
const LECTURE = { title: 'Lecture 1: Motion in a straight line', url: 'https://example.com/lectures/motion' };

interface FeeAccount {
  id: number;
  balance: number;
  paid: number;
}
interface FeePayment {
  id: number;
  status: string;
  amount: number;
  receiptNumber: string | null;
}
interface Paged<T> {
  items: T[];
}

test('admission → mock gateway fee payment → paid LMS lecture unlocks', async ({
  http,
  superAdmin,
  openAs,
}) => {
  const institute = await createInstitute(http, superAdmin, 'pay');
  const { api } = institute.admin;
  const batch = await createBatch(institute, { label: 'Physics' });
  await api.post('/fees/structures', {
    kind: 'course',
    courseId: batch.courseId,
    name: `${batch.courseName} fees`,
    status: 'active',
    components: [{ name: 'Tuition', amount: FEE_PAISE }],
    instalmentPlan: { type: 'one_time' },
  });
  await api.put('/fees/gateways/mock', { enabled: true, isDefault: true });
  const lecture = await api.post<{ id: number }>('/lms/resources', {
    courseId: batch.courseId,
    title: LECTURE.title,
    type: 'link',
    access: 'paid',
    externalUrl: LECTURE.url,
  });
  await api.post(`/lms/resources/${lecture.id}/publish`);
  const applicant = { name: 'Aarav Applicant', mobile: uniqueMobile() };
  // Taken at the front desk with a misspelt name and no batch yet.
  const misspelt = 'Aarav Aplicant';
  await api.post('/admissions/applications', { ...applicant, name: misspelt });

  await test.step('admin corrects the name and picks the batch on the application', async () => {
    const page = await openAs(institute.admin, '/admissions/applications');
    const list = activePage(page);
    await list
      .locator('ion-item')
      .filter({ hasText: misspelt })
      .getByRole('button', { name: `Actions for ${misspelt}` })
      .click();
    await actionSheet(page).getByRole('button', { name: 'Edit details' }).click();
    const edit = modal(page);
    await expect(edit.getByText('Edit application')).toBeVisible();
    await edit.getByLabel('Name *', { exact: true }).fill(applicant.name);
    await chooseOption(
      edit.locator('ion-select').filter({ hasText: 'Batch (enrolled on admission)' }),
      `${batch.batchName} (B-`,
    );
    // A batch belongs to one course, so choosing it chooses the course too.
    await expect(edit.locator('ion-select').filter({ hasText: 'Course' })).toContainText(batch.courseName);
    await edit.getByRole('button', { name: 'Save changes' }).click();
    await expectToast(page, 'Application updated');
    await expect(list.locator('ion-item').filter({ hasText: applicant.name })).toContainText(
      `${batch.courseName} · ${batch.batchName}`,
    );
  });
  const studentId = await test.step('admin admits the applicant into the chosen batch', async () => {
    const page = await openAs(institute.admin, '/admissions/applications');
    const row = activePage(page).locator('ion-item').filter({ hasText: applicant.name });
    await expect(row.getByText('Pending')).toBeVisible();
    await row.getByRole('button', { name: `Actions for ${applicant.name}` }).click();
    await actionSheet(page).getByRole('button', { name: 'Admit as student' }).click();
    // The application's batch is open with free seats, so it is offered and already chosen.
    const admit = modal(page);
    await expect(
      admit.getByRole('radio', { name: new RegExp(`^${batch.batchName} · from .* · 50 seats left$`) }),
    ).toBeChecked();
    await expect(admit.getByRole('radio', { name: /^No batch/ })).not.toBeChecked();
    await admit.getByRole('button', { name: 'Admit', exact: true }).click();
    await expectToast(page, `Admitted ${applicant.name} (`);
    await expect(page).toHaveURL(/\/students\/\d+$/);
    const roster = await api.get<{ status: string }[]>(`/academics/batches/${batch.batchId}/students`);
    expect(roster).toEqual([expect.objectContaining({ status: 'active' })]);
    return Number(new URL(page.url()).pathname.split('/').pop());
  });

  await test.step('the admission opens a fee account from the course fee structure', async () => {
    // Generated by a background job once the admission commits.
    await expect
      .poll(async () => (await api.get<Paged<FeeAccount>>(`/fees/accounts?studentId=${studentId}`)).items, {
        timeout: 30_000,
      })
      .toEqual([expect.objectContaining({ balance: FEE_PAISE, paid: 0 })]);
  });

  const student = await openAs(null, '/lms');
  const content = activePage(student);
  const courseCard = content.locator('ion-card').filter({ hasText: batch.courseName });

  await test.step('student signs in with a mobile OTP; the paid lecture is locked', async () => {
    await expect(student).toHaveURL(/\/login\?redirect=/);
    await signInWithOtp(student, applicant.mobile);
    await expect(student).toHaveURL(/\/lms$/);
    await expect(courseCard).toContainText('free content only');
    await courseCard.click();
    await expect(content.getByText('paid lectures are locked until you are enrolled')).toBeVisible();
    const locked = content.locator('ion-item').filter({ hasText: LECTURE.title });
    await expect(locked).toContainText('enrol to unlock');
    await expect(locked).toHaveAttribute('aria-disabled', 'true');
  });

  const payments = content.locator('ion-item').filter({ hasText: `${FEE} · ` });

  await test.step('student pays online through the mock gateway checkout', async () => {
    await student.goto('/my-fees');
    await expect(content.getByText(`${FEE} due`)).toBeVisible();

    await content.getByRole('button', { name: 'Pay online' }).click();
    const checkout = modal(student);
    await expect(checkout.getByText('Pay fees')).toBeVisible();
    await checkout.getByRole('button', { name: `Proceed to pay ${FEE}` }).click();
    await expect(checkout.getByText('Test gateway. No real money moves.')).toBeVisible();
    await checkout.getByRole('button', { name: 'Simulate failure' }).click();
    await expectToast(student, 'Payment failed. You can try again.');

    await checkout.getByRole('button', { name: `Proceed to pay ${FEE}` }).click();
    await checkout.getByRole('button', { name: 'Pay now' }).click();
    await expectToast(student, /Payment successful\. Receipt \S+/);
    await expect(checkout).toBeHidden();
    await expect(content.getByText('All fees paid')).toBeVisible();
    await expect(payments.filter({ hasText: 'failed' })).toHaveCount(1);
    await expect(payments.filter({ hasText: 'successful' })).toHaveCount(1);
  });

  await test.step('the payment is posted once, with a receipt, even if the gateway result is replayed', async () => {
    const { items } = await api.get<Paged<FeePayment>>(`/fees/payments?studentId=${studentId}`);
    const paid = items.filter((p) => p.status === 'successful');
    expect(paid).toEqual([expect.objectContaining({ amount: FEE_PAISE, receiptNumber: expect.any(String) })]);
    await expect(payments.filter({ hasText: 'successful' })).toContainText(paid[0].receiptNumber!);

    const replay = await api.post<{ outcome: string }>(`/fees/payments/${paid[0].id}/mock-complete`, {
      outcome: 'success',
    });
    expect(['duplicate', 'already_processed']).toContain(replay.outcome);
    const accounts = await api.get<Paged<FeeAccount>>(`/fees/accounts?studentId=${studentId}`);
    expect(accounts.items).toEqual([expect.objectContaining({ balance: 0, paid: FEE_PAISE })]);
    const after = await api.get<Paged<FeePayment>>(`/fees/payments?studentId=${studentId}`);
    expect(after.items.filter((p) => p.status === 'successful')).toHaveLength(1);
  });

  await test.step('student now opens the paid lecture', async () => {
    await student.goto('/lms');
    await expect(courseCard).toBeVisible();
    await expect(courseCard).not.toContainText('free content only');
    await courseCard.click();
    await expect(content.getByText('paid lectures are locked until you are enrolled')).toBeHidden();
    await content.locator('ion-item').filter({ hasText: LECTURE.title }).click();
    await expect(student).toHaveURL(new RegExp(`/lms/resources/${lecture.id}$`));
    await expect(content.getByRole('link', { name: 'Open link' })).toHaveAttribute('href', LECTURE.url);
    await content.getByRole('button', { name: 'Mark as completed' }).click();
    await expect(content.getByText('Completed', { exact: true })).toBeVisible();
  });
});
