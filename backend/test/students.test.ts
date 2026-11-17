import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { Branch } from '../src/modules/branches/branch.model';
import { USERS, bearer, getApp, login } from './helpers';

const year = new Date().getFullYear();
let seq = 0;
/** Unique test mobile numbers (93… range is unused by the seed). */
const mobile = () => `931${String(seq++).padStart(7, '0')}`;

describe('students', () => {
  let apex: string;
  let zenith: string;
  let teacher: string;
  let apexBranches: Branch[];
  let zenithBranchId: number;

  beforeAll(async () => {
    await getApp();
    apex = (await login(USERS.apexAdmin)).accessToken;
    zenith = (await login(USERS.zenithAdmin)).accessToken;
    teacher = (await login(USERS.apexTeacher)).accessToken;
    apexBranches = await Branch.findAll({ where: { instituteId: 1 }, order: [['id', 'ASC']] });
    zenithBranchId = (await Branch.findOne({ where: { instituteId: 2 } }))!.id;
  });

  it('creates, reads, updates and deletes a student with auto numbers', async () => {
    const app = await getApp();
    const created = await request(app)
      .post('/api/students')
      .set(bearer(apex))
      .send({ name: 'Riya Sharma', mobile: mobile(), branchId: apexBranches[0].id, instituteId: 2 });
    expect(created.status).toBe(201);
    expect(created.body.instituteId ?? 1).toBe(1);
    expect(created.body.admissionNumber).toMatch(new RegExp(`^APEX/${year}/\\d{5}$`));
    expect(created.body.rollNumber).toMatch(/^B1-\d{4}$/);
    expect(created.body.status).toBe('active');
    const id = created.body.id;

    const profile = await request(app).get(`/api/students/${id}`).set(bearer(apex));
    expect(profile.status).toBe(200);
    expect(profile.body.history[0].eventType).toBe('admitted');

    const upd = await request(app)
      .patch(`/api/students/${id}`)
      .set(bearer(apex))
      .send({ name: 'Riya S', academicInfo: { schoolName: 'DPS', previousPercentage: 92 } });
    expect(upd.status).toBe(200);
    expect(upd.body.name).toBe('Riya S');
    expect(upd.body.academicInfo.schoolName).toBe('DPS');

    const list = await request(app).get('/api/students?search=Riya').set(bearer(apex));
    expect(list.body.items.some((s: { id: number }) => s.id === id)).toBe(true);

    expect((await request(app).delete(`/api/students/${id}`).set(bearer(apex))).status).toBe(204);
    expect((await request(app).get(`/api/students/${id}`).set(bearer(apex))).status).toBe(404);
  });

  it('forbids roles without the create permission', async () => {
    const res = await request(await getApp())
      .post('/api/students')
      .set(bearer(teacher))
      .send({ name: 'Nope Student', mobile: mobile() });
    expect(res.status).toBe(403);
  });

  it("isolates another institute's students", async () => {
    const app = await getApp();
    const z = await request(app)
      .post('/api/students')
      .set(bearer(zenith))
      .send({ name: 'Zed Student', mobile: mobile() });
    expect(z.status).toBe(201);
    expect(z.body.admissionNumber).toMatch(/^ZENITH\//);
    expect((await request(app).get(`/api/students/${z.body.id}`).set(bearer(apex))).status).toBe(404);
    expect(
      (await request(app).patch(`/api/students/${z.body.id}`).set(bearer(apex)).send({ name: 'Hacked' }))
        .status,
    ).toBe(404);
    expect(
      (
        await request(app)
          .patch(`/api/students/${z.body.id}/status`)
          .set(bearer(apex))
          .send({ status: 'inactive' })
      ).status,
    ).toBe(404);
    expect((await request(app).delete(`/api/students/${z.body.id}`).set(bearer(apex))).status).toBe(404);
    const list = await request(app).get('/api/students?pageSize=200').set(bearer(apex));
    expect(list.body.items.some((s: { id: number }) => s.id === z.body.id)).toBe(false);
    // Apex cannot place a student in a Zenith branch either.
    const cross = await request(app)
      .post('/api/students')
      .set(bearer(apex))
      .send({ name: 'Cross Branch', mobile: mobile(), branchId: zenithBranchId });
    expect([400, 403, 404]).toContain(cross.status);
  });

  it('allocates distinct sequential admission numbers under concurrency', async () => {
    const app = await getApp();
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        request(app)
          .post('/api/students')
          .set(bearer(apex))
          .send({ name: `Parallel ${i}`, mobile: mobile(), branchId: apexBranches[1].id }),
      ),
    );
    expect(results.map((r) => r.status)).toEqual(Array(10).fill(201));
    const nums = results.map((r) => Number(String(r.body.admissionNumber).split('/').pop()));
    expect(new Set(nums).size).toBe(10);
    const sorted = [...nums].sort((a, b) => a - b);
    expect(sorted[9] - sorted[0]).toBe(9);
    const rolls = results.map((r) => r.body.rollNumber as string);
    expect(new Set(rolls).size).toBe(10);
    expect(rolls.every((r) => r.startsWith('B2-'))).toBe(true);
  });

  it('detects duplicates by mobile, email and identifiers', async () => {
    const app = await getApp();
    const m = mobile();
    const first = await request(app)
      .post('/api/students')
      .set(bearer(apex))
      .send({ name: 'Dup One', mobile: m, email: `dup${m}@example.com`, idNumber: `ID${m}` });
    expect(first.status).toBe(201);

    const byMobile = await request(app)
      .post('/api/students')
      .set(bearer(apex))
      .send({ name: 'Dup Two', mobile: m });
    expect(byMobile.status).toBe(409);
    expect(byMobile.body.error.code).toBe('DUPLICATE_STUDENT');
    expect(byMobile.body.error.details.matches[0].matchedOn).toContain('mobile');

    const byId = await request(app)
      .get(`/api/students/duplicates?idNumber=ID${m}&email=DUP${m}@example.com`)
      .set(bearer(apex));
    expect(byId.body[0].matchedOn.sort()).toEqual(['email', 'idNumber']);

    // A sibling sharing the family mobile can be admitted deliberately; it gets no login of its own.
    const sibling = await request(app)
      .post('/api/students')
      .set(bearer(apex))
      .send({ name: 'Dup Sibling', mobile: m, allowDuplicate: true });
    expect(sibling.status).toBe(201);
    expect(sibling.body.userId).toBeNull();
  });

  it('runs the status lifecycle and branch transfer with history', async () => {
    const app = await getApp();
    const s = await request(app)
      .post('/api/students')
      .set(bearer(apex))
      .send({ name: 'Lifecycle Kid', mobile: mobile(), branchId: apexBranches[0].id });
    const id = s.body.id;
    for (const status of ['suspended', 'active', 'discontinued', 'inactive']) {
      const r = await request(app)
        .patch(`/api/students/${id}/status`)
        .set(bearer(apex))
        .send({ status, reason: 'test' });
      expect(r.status).toBe(200);
      expect(r.body.status).toBe(status);
    }
    expect(
      (
        await request(app)
          .patch(`/api/students/${id}`)
          .set(bearer(apex))
          .send({ branchId: apexBranches[1].id })
      ).status,
    ).toBe(400);

    const t = await request(app)
      .post(`/api/students/${id}/transfer`)
      .set(bearer(apex))
      .send({ branchId: apexBranches[1].id, reason: 'Relocated' });
    expect(t.status).toBe(200);
    expect(t.body.branchId).toBe(apexBranches[1].id);
    expect(t.body.rollNumber).toMatch(/^B2-/);
    expect(t.body.admissionNumber).toBe(s.body.admissionNumber);

    const profile = await request(app).get(`/api/students/${id}`).set(bearer(apex));
    const actions = profile.body.history.map((h: { eventType: string }) => h.eventType);
    expect(actions).toContain('branch_transferred');
    expect(actions).toContain('status_changed');
  });

  it('records academic history and documents', async () => {
    const app = await getApp();
    const s = await request(app)
      .post('/api/students')
      .set(bearer(apex))
      .send({ name: 'Docs Kid', mobile: mobile() });
    const id = s.body.id;
    const ar = await request(app)
      .post(`/api/students/${id}/academic-records`)
      .set(bearer(apex))
      .send({ institution: 'Class 10 Boards', academicYear: '2023-24', percentage: 88.5 });
    expect(ar.status).toBe(201);
    const doc = await request(app)
      .post(`/api/students/${id}/documents`)
      .set(bearer(apex))
      .field('docType', 'id_proof')
      .attach('file', Buffer.from('aadhaar'), { filename: 'id.txt', contentType: 'text/plain' });
    expect(doc.status).toBe(201);
    expect(doc.body.url).toContain('/api/files/signed/');

    const profile = await request(app).get(`/api/students/${id}`).set(bearer(apex));
    expect(profile.body.academicRecords[0].institution).toBe('Class 10 Boards');
    expect(profile.body.documents[0].docType).toBe('id_proof');
  });

  it('validates and applies institute number formats', async () => {
    const app = await getApp();
    const bad = await request(app)
      .put('/api/students/settings')
      .set(bearer(zenith))
      .send({ admissionNumberFormat: 'ADM-{FOO}' });
    expect(bad.status).toBe(422);
    const ok = await request(app)
      .put('/api/students/settings')
      .set(bearer(zenith))
      .send({ admissionNumberFormat: 'Z{YY}-{SEQ:3}', autoRollNumber: false });
    expect(ok.status).toBe(200);
    const s = await request(app)
      .post('/api/students')
      .set(bearer(zenith))
      .send({ name: 'Format Kid', mobile: mobile() });
    expect(s.body.admissionNumber).toMatch(new RegExp(`^Z${String(year).slice(2)}-\\d{3}$`));
    expect(s.body.rollNumber).toBeNull();
    // Apex settings are unaffected.
    expect(
      (await request(app).get('/api/students/settings').set(bearer(apex))).body.admissionNumberFormat,
    ).toBe('{INST}/{YYYY}/{SEQ:5}');
  });
});

describe('student self-registration', () => {
  it('registers with only name + mobile and activates immediately', async () => {
    const app = await getApp();
    const info = await request(app).get('/api/public/institutes/apex/registration');
    expect(info.status).toBe(200);
    expect(info.body.enabled).toBe(true);
    expect(info.body.branches.length).toBeGreaterThan(0);

    const m = mobile();
    const reg = await request(app)
      .post('/api/public/institutes/apex/register')
      .send({ name: 'Self Reg', mobile: m, password: 'Secret@123', instituteId: 2 });
    expect(reg.status).toBe(201);
    expect(reg.body.status).toBe('active');
    expect(reg.body.admissionNumber).toMatch(/^APEX\//);
    expect(reg.body.hasPassword).toBe(true);

    const { accessToken } = await login({ mobile: m, password: 'Secret@123' });
    const me = await request(app).get('/api/student-portal/me').set(bearer(accessToken));
    expect(me.status).toBe(200);
    expect(me.body.name).toBe('Self Reg');
    const patched = await request(app)
      .patch('/api/student-portal/me')
      .set(bearer(accessToken))
      .send({ academicInfo: { schoolName: 'KV' } });
    expect(patched.status).toBe(200);
    // Identity fields (name, mobile, branch) are not self-editable.
    expect(
      (await request(app).patch('/api/student-portal/me').set(bearer(accessToken)).send({ name: 'X Y' }))
        .status,
    ).toBe(422);
    expect(patched.body.academicInfo.schoolName).toBe('KV');
    expect(patched.body.name).toBe('Self Reg');
    const doc = await request(app)
      .post('/api/student-portal/me/documents')
      .set(bearer(accessToken))
      .attach('file', Buffer.from('marksheet'), { filename: 'm.txt', contentType: 'text/plain' });
    expect(doc.status).toBe(201);

    // Student cannot reach the admin student API.
    expect((await request(app).get('/api/students').set(bearer(accessToken))).status).toBe(403);
    // Same mobile again in the same institute.
    const again = await request(app)
      .post('/api/public/institutes/apex/register')
      .send({ name: 'Self Reg', mobile: m, password: 'Secret@123' });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('ALREADY_REGISTERED');
  });

  it('creates and links the parent account when parent details are given', async () => {
    const app = await getApp();
    const m = mobile();
    const pm = mobile();
    const reg = await request(app)
      .post('/api/public/institutes/zenith/register')
      .send({
        name: 'Kid With Parent',
        mobile: m,
        parent: { name: 'Parent Person', mobile: pm, relation: 'mother' },
      });
    expect(reg.status).toBe(201);
    expect(reg.body.hasPassword).toBe(false);
    const zenith = (await login(USERS.zenithAdmin)).accessToken;
    const profile = await request(app).get(`/api/students/${reg.body.studentId}`).set(bearer(zenith));
    expect(profile.body.guardians[0]).toMatchObject({ mobile: pm, relation: 'mother', status: 'active' });
  });

  it('counts a website referral signup and never fails on a bad referral', async () => {
    const app = await getApp();
    const apex = (await login(USERS.apexAdmin)).accessToken;
    const code = `SR${Date.now().toString(36)}`.toUpperCase().slice(0, 12);
    const created = await request(app)
      .post('/api/website/referrals')
      .set(bearer(apex))
      .send({ code, name: 'Self-registration referral' });
    expect(created.status).toBe(201);

    // `ref`/`courseId` from the query string (links shared as /register/apex?ref=…&courseId=…).
    const reg = await request(app)
      .post('/api/public/institutes/apex/register')
      .query({ ref: code.toLowerCase(), courseId: '5' })
      .send({ name: 'Referred Kid', mobile: mobile() });
    expect(reg.status).toBe(201);
    const unknown = await request(app)
      .post('/api/public/institutes/apex/register')
      .send({ name: 'Unknown Ref Kid', mobile: mobile(), ref: 'NO-SUCH-CODE' });
    expect(unknown.status).toBe(201);

    const events = await request(app)
      .get(`/api/website/referrals/${created.body.id}/events`)
      .set(bearer(apex));
    expect(events.body.items).toEqual([expect.objectContaining({ kind: 'signup' })]);
    const list = await request(app).get('/api/website/referrals').set(bearer(apex)).query({ search: code });
    expect(list.body.items[0]).toMatchObject({ code, signups: 1 });
  });

  it('requires the password to attach an existing account', async () => {
    const res = await request(await getApp())
      .post('/api/public/institutes/apex/register')
      .send({ name: 'Imposter', mobile: USERS.zenithAdmin.mobile });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ACCOUNT_EXISTS');
  });

  it('rejects unknown institutes and validation errors', async () => {
    const app = await getApp();
    expect((await request(app).get('/api/public/institutes/nope/registration')).status).toBe(404);
    const res = await request(app).post('/api/public/institutes/apex/register').send({ name: 'X' });
    expect(res.status).toBe(422);
  });

  it('honours the self-registration toggle', async () => {
    const app = await getApp();
    const apex = (await login(USERS.apexAdmin)).accessToken;
    await request(app)
      .put('/api/students/settings')
      .set(bearer(apex))
      .send({ selfRegistrationEnabled: false });
    const res = await request(app)
      .post('/api/public/institutes/apex/register')
      .send({ name: 'Late Kid', mobile: mobile() });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('SELF_REGISTRATION_DISABLED');
    await request(app)
      .put('/api/students/settings')
      .set(bearer(apex))
      .send({ selfRegistrationEnabled: true });
  });
});
