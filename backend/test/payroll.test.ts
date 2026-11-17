import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { processDueJobs } from '../src/infrastructure/jobs/queue';
import { User } from '../src/modules/users/user.model';
import { DEFAULT_COMPONENTS, calculatePayslip, slabAmount } from '../src/modules/payroll/calculator';
import { USERS, bearer, getApp, login } from './helpers';

const components = DEFAULT_COMPONENTS.map((c) => ({ ...c, active: true }));
const line = (lines: { code: string; amount: number }[], code: string) =>
  lines.find((l) => l.code === code)?.amount;

describe('payroll calculator', () => {
  const base = {
    monthlyBasic: 0,
    ratePerUnit: 0,
    allowances: null,
    deductions: null,
    pfApplicable: true,
    esiApplicable: true,
    ptApplicable: true,
    tdsApplicable: true,
    tdsPercent: null,
  };

  it('prorates fixed pay by LOP days and applies the configured statutory components', () => {
    const r = calculatePayslip({
      structure: {
        ...base,
        payType: 'fixed_monthly',
        monthlyBasic: 3_000_000,
        allowances: [{ name: 'HRA', amount: 1_000_000 }],
      },
      components,
      daysInMonth: 28,
      employedDays: 28,
      lopDays: 2,
      units: { lecture: 0, class: 0 },
      incentives: 0,
    });
    expect(r.payableDays).toBe(26);
    expect(line(r.lines, 'BASIC')).toBe(2_785_714);
    expect(r.gross).toBe(3_714_285);
    expect(line(r.lines, 'PF')).toBe(180_000); // capped at the ₹15,000 wage ceiling
    expect(line(r.lines, 'PF_ER')).toBe(180_000);
    expect(line(r.lines, 'ESI')).toBeUndefined(); // gross above the eligibility limit
    expect(line(r.lines, 'PT')).toBe(20_000);
    expect(r.net).toBe(3_514_285);
  });

  it('pays per lecture plus incentives and honours applicability flags', () => {
    const input = {
      structure: { ...base, payType: 'per_lecture' as const, ratePerUnit: 50_000 },
      components,
      daysInMonth: 28,
      employedDays: 28,
      lopDays: 0,
      units: { lecture: 10, class: 0 },
      incentives: 100_000,
    };
    const r = calculatePayslip(input);
    expect(r.gross).toBe(600_000);
    expect(line(r.lines, 'PF')).toBe(60_000);
    expect(line(r.lines, 'ESI')).toBe(4_500);
    expect(line(r.lines, 'ESI_ER')).toBe(19_500);
    expect(line(r.lines, 'PT')).toBeUndefined();
    expect(r.net).toBe(535_500);

    const noPf = calculatePayslip({ ...input, structure: { ...input.structure, pfApplicable: false } });
    expect(line(noPf.lines, 'PF')).toBeUndefined();
    expect(noPf.net).toBe(595_500);
  });

  it('resolves slab amounts', () => {
    const slabs = [
      { upTo: 750_000, amount: 0 },
      { upTo: 1_000_000, amount: 17_500 },
      { upTo: null, amount: 20_000 },
    ];
    expect(slabAmount(slabs, 700_000)).toBe(0);
    expect(slabAmount(slabs, 900_000)).toBe(17_500);
    expect(slabAmount(slabs, 5_000_000)).toBe(20_000);
  });
});

describe('payroll module', () => {
  let admin: string;
  let teacher: string;
  let zenith: string;
  let staffUser: string; // branch admin, linked to employee A for self-service
  let empA: number;
  let empB: number;
  let runId: number;
  let slipA: number;
  const api = async () => request(await getApp());

  beforeAll(async () => {
    await getApp();
    admin = (await login(USERS.apexAdmin)).accessToken;
    teacher = (await login(USERS.apexTeacher)).accessToken;
    zenith = (await login(USERS.zenithAdmin)).accessToken;
    staffUser = (await login(USERS.apexBranchAdmin)).accessToken;
    const staffUserId = (await User.findOne({ where: { mobile: USERS.apexBranchAdmin.mobile } }))!.id;

    const a = await (
      await api()
    )
      .post('/api/hr/employees')
      .set(bearer(admin))
      .send({ userId: staffUserId, dateOfJoining: '2022-01-01', designation: 'Centre manager' });
    expect(a.status).toBe(201);
    empA = a.body.id;
    const b = await (
      await api()
    )
      .post('/api/hr/employees')
      .set(bearer(admin))
      .send({ name: 'Guest Lecturer', dateOfJoining: '2022-01-01', isTeacher: true });
    expect(b.status).toBe(201);
    empB = b.body.id;
  });

  it('seeds editable default statutory components', async () => {
    const res = await (await api()).get('/api/payroll/components').set(bearer(admin));
    expect(res.status).toBe(200);
    expect(res.body.map((c: { code: string }) => c.code)).toEqual(
      expect.arrayContaining(['PF', 'ESI', 'PT', 'TDS']),
    );

    const custom = await (
      await api()
    )
      .post('/api/payroll/components')
      .set(bearer(admin))
      .send({
        code: 'lwf',
        name: 'Welfare fund',
        kind: 'deduction',
        calcType: 'fixed',
        fixedAmount: 0,
        effectiveFrom: '2020-01-01',
      });
    expect(custom.status).toBe(201);
    expect(custom.body.code).toBe('LWF');
    const badSlab = await (
      await api()
    )
      .post('/api/payroll/components')
      .set(bearer(admin))
      .send({ code: 'X', name: 'X', kind: 'deduction', calcType: 'slab', effectiveFrom: '2020-01-01' });
    expect(badSlab.status).toBe(422);
    expect(
      (await (await api()).delete(`/api/payroll/components/${custom.body.id}`).set(bearer(admin))).status,
    ).toBe(204);
  });

  it('creates salary structures and records idempotent work units', async () => {
    const sa = await (
      await api()
    )
      .post('/api/payroll/structures')
      .set(bearer(admin))
      .send({
        employeeId: empA,
        payType: 'fixed_monthly',
        monthlyBasic: 3_000_000,
        allowances: [{ name: 'HRA', amount: 1_000_000 }],
        effectiveFrom: '2022-01-01',
      });
    expect(sa.status).toBe(201);
    const sb = await (
      await api()
    )
      .post('/api/payroll/structures')
      .set(bearer(admin))
      .send({
        employeeId: empB,
        payType: 'per_lecture',
        ratePerUnit: 50_000,
        ptApplicable: false,
        effectiveFrom: '2022-01-01',
      });
    expect(sb.status).toBe(201);

    const entries = [
      { employeeId: empB, date: '2023-02-06', unitType: 'lecture', quantity: 6, externalRef: 'tt:1' },
      { employeeId: empB, date: '2023-02-13', unitType: 'lecture', quantity: 4, externalRef: 'tt:2' },
      {
        employeeId: empB,
        date: '2023-02-20',
        unitType: 'incentive',
        amount: 100_000,
        description: 'Results bonus',
      },
    ];
    const first = await (
      await api()
    )
      .post('/api/payroll/work-units/bulk')
      .set(bearer(admin))
      .send({ entries });
    expect(first.status).toBe(200);
    expect(first.body.created).toBe(3);
    const again = await (
      await api()
    )
      .post('/api/payroll/work-units/bulk')
      .set(bearer(admin))
      .send({ entries: entries.slice(0, 2) });
    expect(again.body).toMatchObject({ created: 0, updated: 2 });
    const list = await (await api()).get('/api/payroll/work-units?year=2023&month=2').set(bearer(admin));
    expect(list.body.filter((u: { employeeId: number }) => u.employeeId === empB)).toHaveLength(3);

    const att = await (
      await api()
    )
      .put('/api/hr/attendance')
      .set(bearer(admin))
      .send({
        entries: [
          { employeeId: empA, date: '2023-02-07', status: 'absent' },
          { employeeId: empA, date: '2023-02-08', status: 'absent' },
        ],
      });
    expect(att.status).toBe(200);
  });

  it('runs payroll draft → approve → lock with idempotent payslips', async () => {
    const run = await (
      await api()
    )
      .post('/api/payroll/runs')
      .set(bearer(admin))
      .send({ periodYear: 2023, periodMonth: 2 });
    expect(run.status).toBe(201);
    runId = run.body.id;
    const dup = await (
      await api()
    )
      .post('/api/payroll/runs')
      .set(bearer(admin))
      .send({ periodYear: 2023, periodMonth: 2 });
    expect(dup.status).toBe(409);

    const g1 = await (await api()).post(`/api/payroll/runs/${runId}/generate`).set(bearer(admin));
    expect(g1.status).toBe(200);
    expect(g1.body.generated).toBe(2);
    const g2 = await (await api()).post(`/api/payroll/runs/${runId}/generate`).set(bearer(admin));
    expect(g2.body.generated).toBe(2);

    const detail = await (await api()).get(`/api/payroll/runs/${runId}`).set(bearer(admin));
    expect(detail.body.payslips).toHaveLength(2);
    const a = detail.body.payslips.find((p: { employeeId: number }) => p.employeeId === empA);
    const b = detail.body.payslips.find((p: { employeeId: number }) => p.employeeId === empB);
    expect(a).toMatchObject({ lopDays: 2, gross: 3_714_285, net: 3_514_285 });
    expect(b).toMatchObject({ gross: 600_000, net: 535_500 });
    expect(b.units.lecture).toBe(10);
    expect(detail.body.run.totalNet).toBe(3_514_285 + 535_500);
    slipA = a.id;

    expect((await (await api()).get(`/api/payroll/payslips/${slipA}/pdf`).set(bearer(admin))).status).toBe(
      409,
    );
    expect((await (await api()).post(`/api/payroll/runs/${runId}/lock`).set(bearer(admin))).status).toBe(409);
    expect(
      (await (await api()).post(`/api/payroll/runs/${runId}/approve`).set(bearer(admin))).body.status,
    ).toBe('approved');
    expect((await (await api()).post(`/api/payroll/runs/${runId}/generate`).set(bearer(admin))).status).toBe(
      409,
    );
    expect((await (await api()).post(`/api/payroll/runs/${runId}/lock`).set(bearer(admin))).body.status).toBe(
      'locked',
    );
    expect((await (await api()).delete(`/api/payroll/runs/${runId}`).set(bearer(admin))).status).toBe(409);

    const late = await (
      await api()
    )
      .post('/api/payroll/work-units')
      .set(bearer(admin))
      .send({ employeeId: empB, date: '2023-02-27', unitType: 'lecture', quantity: 1 });
    expect(late.status).toBe(409);
  });

  it('renders PDF salary slips after lock', async () => {
    await processDueJobs();
    const res = await (await api()).get(`/api/payroll/payslips/${slipA}/pdf`).set(bearer(admin));
    expect(res.status).toBe(200);
    const pdf = await (await api()).get(new URL(res.body.url).pathname + new URL(res.body.url).search);
    expect(pdf.status).toBe(200);
    expect(Buffer.from(pdf.body).subarray(0, 4).toString()).toBe('%PDF');
  });

  it('lets employees see only their own locked payslips', async () => {
    const mine = await (await api()).get('/api/payroll/me/payslips').set(bearer(staffUser));
    expect(mine.status).toBe(200);
    expect(mine.body.map((p: { id: number }) => p.id)).toEqual([slipA]);
    const pdf = await (await api()).get(`/api/payroll/me/payslips/${slipA}/pdf`).set(bearer(staffUser));
    expect(pdf.status).toBe(200);
    expect((await (await api()).get(`/api/payroll/me/payslips/${slipA}`).set(bearer(teacher))).status).toBe(
      404,
    );
  });

  it('exports register and statutory reports', async () => {
    const csv = await (
      await api()
    )
      .get(`/api/payroll/reports/register?runId=${runId}&format=csv`)
      .set(bearer(admin));
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.text).toContain('Guest Lecturer');
    const xls = await (
      await api()
    )
      .get(`/api/payroll/reports/register?runId=${runId}&format=xls`)
      .set(bearer(admin));
    expect(xls.headers['content-type']).toContain('application/vnd.ms-excel');
    expect(xls.text).toContain('<Workbook');
    const stat = await (
      await api()
    )
      .get('/api/payroll/reports/statutory?year=2023&month=2')
      .set(bearer(admin));
    expect(stat.status).toBe(200);
    expect(JSON.stringify(stat.body)).toContain('PF');
    const annual = await (await api()).get('/api/payroll/reports/annual?year=2023').set(bearer(admin));
    expect(annual.status).toBe(200);
  });

  it('denies payroll to teachers and isolates tenants', async () => {
    expect((await (await api()).get('/api/payroll/runs').set(bearer(teacher))).status).toBe(403);
    expect(
      (await (await api()).get('/api/payroll/reports/annual?year=2023').set(bearer(teacher))).status,
    ).toBe(403);
    expect((await (await api()).get(`/api/payroll/runs/${runId}`).set(bearer(zenith))).status).toBe(404);
    expect((await (await api()).get(`/api/payroll/payslips/${slipA}`).set(bearer(zenith))).status).toBe(404);
    const zr = await (await api()).get('/api/payroll/runs').set(bearer(zenith));
    expect(zr.body.items).toHaveLength(0);
    const ws = await (
      await api()
    )
      .post('/api/payroll/structures')
      .set(bearer(zenith))
      .send({ employeeId: empA, payType: 'fixed_monthly', monthlyBasic: 1, effectiveFrom: '2023-01-01' });
    expect(ws.status).toBe(404);
  });

  it('computes and settles full-and-final for a resigned employee', async () => {
    const c = await (
      await api()
    )
      .post('/api/hr/employees')
      .set(bearer(admin))
      .send({ name: 'Leaving Staff', dateOfJoining: '2022-01-01' });
    const empC = c.body.id;
    await (
      await api()
    )
      .post('/api/payroll/structures')
      .set(bearer(admin))
      .send({
        employeeId: empC,
        payType: 'fixed_monthly',
        monthlyBasic: 3_000_000,
        effectiveFrom: '2022-01-01',
      });
    const asset = await (
      await api()
    )
      .post('/api/hr/assets')
      .set(bearer(admin))
      .send({
        employeeId: empC,
        name: 'Laptop',
        assetTag: 'LT-9',
        issuedOn: '2022-01-05',
        valuePaise: 500_000,
      });
    expect(asset.status).toBe(201);
    const sep = await (
      await api()
    )
      .post('/api/hr/separations')
      .set(bearer(admin))
      .send({ employeeId: empC, submittedOn: '2023-03-01', noticePeriodDays: 30 });
    expect(sep.status).toBe(201);

    const early = await (
      await api()
    )
      .post('/api/payroll/settlements')
      .set(bearer(admin))
      .send({ separationId: sep.body.id });
    expect(early.status).toBe(409);
    const acc = await (
      await api()
    )
      .post(`/api/hr/separations/${sep.body.id}/accept`)
      .set(bearer(admin))
      .send({ lastWorkingDay: '2023-03-10' });
    expect(acc.status).toBe(200);

    const fnf = await (
      await api()
    )
      .post('/api/payroll/settlements')
      .set(bearer(admin))
      .send({
        separationId: sep.body.id,
        adjustments: [{ name: 'Gratuity', type: 'earning', amount: 10_000 }],
      });
    expect(fnf.status).toBe(200);
    const codes = fnf.body.lines.map((l: { code: string }) => l.code);
    expect(codes).toEqual(expect.arrayContaining(['SALARY', 'ENCASH_EL', 'NOTICE', 'ASSET', 'ADJUSTMENT']));
    expect(line(fnf.body.lines, 'NOTICE')).toBe(21 * 100_000);
    expect(line(fnf.body.lines, 'ASSET')).toBe(500_000);

    expect(
      (await (await api()).post(`/api/payroll/settlements/${fnf.body.id}/pay`).set(bearer(admin))).status,
    ).toBe(409);
    expect(
      (await (await api()).post(`/api/payroll/settlements/${fnf.body.id}/approve`).set(bearer(admin))).body
        .status,
    ).toBe('approved');
    expect(
      (await (await api()).post(`/api/payroll/settlements/${fnf.body.id}/pay`).set(bearer(admin))).body
        .status,
    ).toBe('paid');
    const recompute = await (
      await api()
    )
      .post('/api/payroll/settlements')
      .set(bearer(admin))
      .send({ separationId: sep.body.id });
    expect(recompute.status).toBe(409);
  });
});
