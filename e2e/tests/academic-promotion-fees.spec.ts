/**
 * Academic promotion → new-session fees (spec §7): the session closes, the promotion list is
 * reviewed, the students advance into a batch of the next session, and that session's fees are
 * applied to them in the same step. The old enrolment stays as history.
 *
 * Setup (API): a new institute with a Physics batch of three students in the current session, and a
 * Physics batch in the next session that already has two students (one of them also in the source
 * batch). There are two active course fee structures: one for any session and one for the next
 * session (₹24,000 in four quarterly instalments). Browser: the admin opens "Promote" on Academic
 * sessions and picks the two batches. The dialog turns on "Apply new-session fees" with the next
 * session's structure. The admin sets the first due date and promotes. The dialog reports two
 * students promoted and billed, and one not promoted because they were already enrolled.
 *
 * Server side: only the two promoted students have fee accounts in the new batch, starting on the
 * chosen date. Their old enrolments are kept with status "promoted".
 */
import { expect, test } from '../support/fixtures';
import { addStudent, createBatch, createInstitute, isoDate, uniqueId } from '../support/data';
import { activePage, alertDialog, confirmAlert, modal } from '../support/ui';

interface FeeAccount {
  id: number;
  studentName?: string;
  structureId: number | null;
  gross: number;
  source: string;
  instalments?: { dueDate: string; amount: number }[];
}

interface RosterRow {
  studentUserId: number;
  status: string;
}

test('academic promotion → new-session fees for the promoted students only', async ({
  http,
  superAdmin,
  openAs,
}) => {
  const institute = await createInstitute(http, superAdmin, 'promotion');
  const { api } = institute.admin;
  const asha = await addStudent(institute, 'Asha Promoted');
  const ravi = await addStudent(institute, 'Ravi Promoted');
  const kiran = await addStudent(institute, 'Kiran Already Moved');
  const meera = await addStudent(institute, 'Meera New Joiner');
  const from = await createBatch(institute, {
    label: 'Physics',
    studentUserIds: [asha.id, ravi.id, kiran.id],
  });
  const code = uniqueId().toUpperCase();
  const nextSession = await api.post<{ id: number }>('/academics/sessions', {
    name: `Next ${code}`,
    startDate: isoDate(301),
    endDate: isoDate(665),
    status: 'planned',
  });
  const toName = `Physics next batch ${code}`;
  const to = await api.post<{ id: number }>('/academics/batches', {
    branchId: institute.branchId,
    courseId: from.courseId,
    academicSessionId: nextSession.id,
    name: toName,
    code: `N-${code}`,
    capacity: 50,
    startDate: isoDate(301),
    status: 'planned',
  });
  await api.post(`/academics/batches/${to.id}/students`, { studentUserIds: [kiran.id, meera.id] });
  await api.post('/fees/structures', {
    name: `${from.courseName} fee`,
    courseId: from.courseId,
    components: [{ name: 'Tuition', amount: 2_000_000 }],
    instalmentPlan: { type: 'one_time', count: 1 },
  });
  const structureName = `${from.courseName} next session fee`;
  const nextFee = await api.post<{ id: number }>('/fees/structures', {
    name: structureName,
    courseId: from.courseId,
    academicSessionId: nextSession.id,
    components: [{ name: 'Tuition', amount: 2_400_000 }],
    instalmentPlan: { type: 'quarterly', count: 4, firstDueDate: isoDate(310) },
  });
  const firstDueDate = isoDate(320);

  const page = await openAs(institute.admin, '/academics/sessions');
  const dialog = modal(page);

  await test.step('admin reviews the promotion with the next session fees', async () => {
    await activePage(page).getByRole('button', { name: 'Promote', exact: true }).click();
    await expect(dialog.locator('ion-title')).toHaveText('Promote students');
    await dialog.locator('ion-select').filter({ hasText: 'From batch' }).click();
    await alertDialog(page)
      .getByRole('radio', { name: new RegExp(`^${from.batchName} \\(`) })
      .click();
    await confirmAlert(page, 'OK');
    await dialog.locator('ion-select').filter({ hasText: 'To batch' }).click();
    await alertDialog(page)
      .getByRole('radio', { name: new RegExp(`^${toName} \\(`) })
      .click();
    await confirmAlert(page, 'OK');

    const applyFees = dialog.locator('ion-toggle');
    await expect(applyFees).toContainText('Apply new-session fees');
    await expect(applyFees).toBeChecked();
    await expect(dialog.locator('ion-select').filter({ hasText: 'Fee structure' })).toContainText(
      `${structureName} v1 · ₹24,000.00 · quarterly × 4`,
    );
    await expect(dialog).toContainText(`Leave empty for the structure's date, ${isoDate(310)}.`);
    await dialog.getByLabel('First due date').fill(firstDueDate);
  });

  await test.step('admin promotes and sees who was promoted and billed', async () => {
    await dialog.getByRole('button', { name: 'Promote', exact: true }).click();
    await expect(dialog.getByRole('heading', { name: 'Promoted 2 students' })).toBeVisible();
    await expect(dialog).toContainText('Not promoted (1): Already enrolled in target batch');
    await expect(
      dialog.getByRole('heading', { name: `Billed 2 students with ${structureName}` }),
    ).toBeVisible();
    await dialog.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(dialog).toBeHidden();
  });

  await test.step('only the promoted students are billed; the old enrolments are kept', async () => {
    const { items } = await api.get<{ items: FeeAccount[] }>(`/fees/accounts?batchId=${to.id}`);
    expect(items.map((a) => a.studentName).sort()).toEqual([asha.name, ravi.name].sort());
    for (const a of items)
      expect(a).toMatchObject({ structureId: nextFee.id, gross: 2_400_000, source: 'promotion' });
    const account = await api.get<FeeAccount>(`/fees/accounts/${items[0].id}`);
    expect(account.instalments?.map((i) => i.amount)).toEqual([600_000, 600_000, 600_000, 600_000]);
    expect(account.instalments?.[0].dueDate).toBe(firstDueDate);

    const statuses = async (batchId: number) =>
      Object.fromEntries(
        (await api.get<RosterRow[]>(`/academics/batches/${batchId}/students?status=all`)).map((r) => [
          r.studentUserId,
          r.status,
        ]),
      );
    expect(await statuses(from.batchId)).toEqual({
      [asha.id]: 'promoted',
      [ravi.id]: 'promoted',
      [kiran.id]: 'active',
    });
    expect(await statuses(to.id)).toEqual({
      [asha.id]: 'active',
      [ravi.id]: 'active',
      [kiran.id]: 'active',
      [meera.id]: 'active',
    });
  });
});
