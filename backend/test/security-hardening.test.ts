import crypto from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { getBiometricAdapter } from '../src/infrastructure/biometric';
import { AuditEvent } from '../src/shared/audit/audit-event.model';
import { runWithContext } from '../src/shared/context';
import { Branch } from '../src/modules/branches/branch.model';
import { Plan } from '../src/modules/subscriptions/models';
import { getApp, purgeRows } from './helpers';
import {
  type Actor,
  type Tenant,
  createInstitute,
  createStaff,
  createSuperAdmin,
  ok,
  purgeInstitutes,
  send,
} from './security/harness';

/** Fixes from docs/security.md (audit and guardian branch scope, plans, device pushes). Mobiles 9500…. */
const PREFIX = '9500';
let n = 0;
const mobile = () => `${PREFIX}${String(n++).padStart(6, '0')}`;

let superAdmin: Actor;
let tenant: Tenant;
let branch2Id: number;
/** audit.view, guardians.view and students.view on the main branch only. */
let restricted: Actor;
const planIds: number[] = [];

beforeAll(async () => {
  superAdmin = await createSuperAdmin(mobile());
  const tag = `hard${crypto.randomBytes(3).toString('hex')}`;
  tenant = await createInstitute(superAdmin, {
    slug: tag,
    name: `Hardening ${tag}`,
    adminMobile: mobile(),
    label: 'admin',
  });
  branch2Id = (await ok(tenant.admin, 'POST', '/api/branches', { name: 'Second branch', code: 'HB2' })).id;
  restricted = await createStaff(tenant.admin, {
    label: 'restricted',
    mobile: mobile(),
    permissions: ['audit.view', 'guardians.view', 'students.view'],
    branchId: tenant.mainBranchId,
  });
}, 120_000);

afterAll(async () => {
  await purgeInstitutes([tenant?.id], PREFIX);
  await purgeRows('plans', planIds);
}, 120_000);

describe('audit log branch scope', () => {
  it('shows branch-restricted users only their branches, and institute-wide entries to the rest', async () => {
    const action = `hardening.${crypto.randomBytes(3).toString('hex')}`;
    const row = (branchId: number | null) => ({
      instituteId: tenant.id,
      branchId,
      actorUserId: null,
      impersonatorUserId: null,
      action,
      entityType: 'test',
      entityId: String(branchId),
      metadata: null,
      ip: null,
      userAgent: null,
    });
    await AuditEvent.bulkCreate([row(tenant.mainBranchId), row(branch2Id), row(null)]);
    const branches = async (who: Actor, headers: Record<string, string> = {}) => {
      const res = await send(who, 'GET', `/api/audit-events?action=${action}`, undefined, headers);
      expect(res.status).toBe(200);
      return (res.body.items as { branchId: number | null }[]).map((e) => e.branchId).sort();
    };

    expect(await branches(restricted)).toEqual([tenant.mainBranchId]);
    expect(await branches(tenant.admin)).toEqual([tenant.mainBranchId, branch2Id, null].sort());
    expect(await branches(tenant.admin, { 'X-Branch-Id': String(branch2Id) })).toEqual(
      [branch2Id, null].sort(),
    );
  });

  it('files changes to a branch record under that branch', async () => {
    const created = await ok(tenant.admin, 'POST', '/api/students', {
      name: 'Audit Branch Student',
      mobile: mobile(),
      branchId: branch2Id,
    });
    const [event] = await AuditEvent.findAll({
      where: { instituteId: tenant.id, entityId: String(created.id) },
      order: [['id', 'DESC']],
      limit: 1,
    });
    expect(event?.branchId).toBe(branch2Id);
  });
});

describe('guardian children', () => {
  it('lists only the children in branches the user can see', async () => {
    const s1 = await ok(tenant.admin, 'POST', '/api/students', {
      name: 'Main Branch Child',
      mobile: mobile(),
      branchId: tenant.mainBranchId,
    });
    const s2 = await ok(tenant.admin, 'POST', '/api/students', {
      name: 'Other Branch Child',
      mobile: mobile(),
      branchId: branch2Id,
    });
    const guardianMobile = mobile();
    await ok(tenant.admin, 'POST', `/api/students/${s1.id}/guardians`, {
      name: 'Two Branch Parent',
      mobile: guardianMobile,
      relation: 'mother',
    });
    await ok(tenant.admin, 'POST', `/api/students/${s2.id}/guardians`, {
      name: 'Two Branch Parent',
      mobile: guardianMobile,
      relation: 'mother',
    });
    const names = (g: { children: { name: string }[] }) => g.children.map((c) => c.name).sort();

    const all = await ok(tenant.admin, 'GET', '/api/guardians');
    const guardian = all.items.find((g: { mobile: string }) => g.mobile === guardianMobile);
    expect(names(guardian)).toEqual(['Main Branch Child', 'Other Branch Child']);

    const scoped = await ok(restricted, 'GET', '/api/guardians');
    const mine = scoped.items.find((g: { mobile: string }) => g.mobile === guardianMobile);
    expect(names(mine)).toEqual(['Main Branch Child']);
    expect(JSON.stringify(scoped)).not.toContain('Other Branch Child');
    expect(names(await ok(restricted, 'GET', `/api/guardians/${guardian.id}`))).toEqual([
      'Main Branch Child',
    ]);
  });
});

describe('institute plans', () => {
  it('rejects creating an institute on an inactive plan', async () => {
    const tag = `hardplan${crypto.randomBytes(3).toString('hex')}`;
    const plan = await ok(superAdmin, 'POST', '/api/admin/plans', {
      code: tag,
      name: `Retired ${tag}`,
      priceMonthlyPaise: 0,
      priceYearlyPaise: 0,
      limits: {
        maxStudents: null,
        maxBranches: null,
        maxTeachers: null,
        storageMb: null,
        aiTokensMonthly: null,
        enabledModules: [],
      },
    });
    planIds.push(plan.id);
    await Plan.update({ isActive: false }, { where: { id: plan.id } });
    const res = await send(superAdmin, 'POST', '/api/admin/institutes', {
      name: `Retired plan ${tag}`,
      slug: tag,
      planId: plan.id,
      admin: { name: 'Nobody', mobile: mobile(), password: 'Hardening@12345' },
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('PLAN_INACTIVE');
  });
});

describe('tenant write guard', () => {
  it("rejects writes for another institute in an institute's context", async () => {
    const other = tenant.id + 100_000;
    const inTenant = <T>(fn: () => Promise<T>) =>
      runWithContext({ system: true, instituteId: tenant.id, allowedBranchIds: null }, fn);
    const guard = /Tenant guard: Branch\.\w+ for another institute/;

    await expect(
      inTenant(() => Branch.create({ instituteId: other, name: 'X', code: 'X1' })),
    ).rejects.toThrow(guard);
    await expect(
      inTenant(() =>
        Branch.bulkCreate([
          { instituteId: tenant.id, name: 'Y', code: 'Y1' },
          { instituteId: other, name: 'X', code: 'X1' },
        ]),
      ),
    ).rejects.toThrow(guard);
    await expect(
      inTenant(() => Branch.update({ name: 'X' }, { where: { instituteId: other } })),
    ).rejects.toThrow(guard);
    await expect(
      inTenant(() => Branch.destroy({ where: { instituteId: [tenant.id, other] } })),
    ).rejects.toThrow(guard);
    await expect(
      inTenant(() =>
        Branch.update({ instituteId: other }, { where: { instituteId: tenant.id, id: branch2Id } }),
      ),
    ).rejects.toThrow(guard);
    const branch = await Branch.findOne({ where: { instituteId: tenant.id, id: branch2Id } });
    branch!.instituteId = other;
    await expect(inTenant(() => branch!.save())).rejects.toThrow(guard);

    // The context's own institute, platform code (tenantBypass) and context-free code still write.
    await inTenant(() =>
      Branch.update({ city: 'Pune' }, { where: { instituteId: tenant.id, id: branch2Id } }),
    );
    await Branch.update({ city: 'Agra' }, { where: { instituteId: tenant.id, id: branch2Id } });
    await inTenant(() =>
      Branch.update({ city: 'Kota' }, {
        where: { instituteId: tenant.id, id: branch2Id },
        tenantBypass: true,
      } as never),
    );
    expect((await Branch.findOne({ where: { instituteId: tenant.id, id: branch2Id } }))!.city).toBe('Kota');
  });
});

describe('biometric device push', () => {
  const push = async (headers: Record<string, string>, body: string) =>
    request(await getApp())
      .post('/api/attendance/public/device-events')
      .set({ 'Content-Type': 'application/json', ...headers })
      .send(body);

  it('authenticates the device, then caps the body size and punch count before parsing', async () => {
    const serial = `HARD-${crypto.randomBytes(3).toString('hex')}`;
    const device = await ok(tenant.admin, 'POST', '/api/attendance/devices', {
      name: 'Hardening gate',
      serial,
      branchId: tenant.mainBranchId,
    });
    const auth = { 'X-Device-Serial': serial, 'X-Device-Key': device.apiKey };
    const punch = { deviceSerial: serial, enrolmentId: 'E-1', punchedAt: '2026-01-05T09:00:00Z' };
    const parse = vi.spyOn(getBiometricAdapter(), 'parsePush');
    try {
      const huge = JSON.stringify({ punches: [{ ...punch, enrolmentId: 'x'.repeat(300 * 1024) }] });
      const unknown = await push({ ...auth, 'X-Device-Key': 'wrong' }, huge);
      expect(unknown.status).toBe(401);
      const tooBig = await push(auth, huge);
      expect(tooBig.status).toBe(413);
      expect(tooBig.body.error.code).toBe('PAYLOAD_TOO_LARGE');

      const tooMany = await push(auth, JSON.stringify(Array.from({ length: 1001 }, () => punch)));
      expect(tooMany.status).toBe(400);
      expect(tooMany.body.error.message).toContain('At most 1000 punches');
      expect(parse).not.toHaveBeenCalled();

      const fine = await push(auth, JSON.stringify({ punches: [punch] }));
      expect(fine.status).toBe(200);
      expect(fine.body).toMatchObject({ received: 1, unmatched: 1 });
      expect(parse).toHaveBeenCalledTimes(1);
    } finally {
      parse.mockRestore();
    }
  });
});
