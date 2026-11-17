import bcrypt from 'bcryptjs';
import type { PlanLimits, SystemRoleSlug } from '@erp/shared';
import type { Migration } from '../migration-helpers';
import { config } from '../../config';
import { User } from '../../../modules/users/user.model';
import { Institute } from '../../../modules/institutes/institute.model';
import { Branch } from '../../../modules/branches/branch.model';
import { Plan, Subscription } from '../../../modules/subscriptions/models';
import { UserBranch, UserRole } from '../../../modules/permissions/models';
import { getSystemRole } from '../../../modules/permissions/catalog.service';

/**
 * Demo data: super admin, plans, 2 institutes × 2 branches and one user per system role.
 * Mobile numbers: 9000000000 = super admin; 9<inst><role> pattern for demo users (see README).
 */
const PLANS: { code: string; name: string; monthly: number; limits: PlanLimits }[] = [
  {
    code: 'starter',
    name: 'Starter',
    monthly: 199900,
    limits: {
      maxStudents: 200,
      maxBranches: 2,
      maxTeachers: 15,
      storageMb: 5120,
      aiTokensMonthly: 200000,
      enabledModules: null,
    },
  },
  {
    code: 'growth',
    name: 'Growth',
    monthly: 499900,
    limits: {
      maxStudents: 2000,
      maxBranches: 10,
      maxTeachers: 100,
      storageMb: 51200,
      aiTokensMonthly: 2000000,
      enabledModules: null,
    },
  },
];

const INSTITUTES = [
  {
    slug: 'apex',
    name: 'Apex Coaching Classes',
    city: 'Pune',
    primaryColor: '#1E5EFF',
    secondaryColor: '#FFB020',
    plan: 'growth',
    prefix: '91',
    branches: ['Kothrud', 'Baner'],
  },
  {
    slug: 'zenith',
    name: 'Zenith Academy',
    city: 'Jaipur',
    primaryColor: '#0F9D58',
    secondaryColor: '#7B1FA2',
    plan: 'starter',
    prefix: '92',
    branches: ['Malviya Nagar', 'Vaishali Nagar'],
  },
];

const DEMO_ROLES: { role: SystemRoleSlug; label: string; branchIndex: number | null }[] = [
  { role: 'institute-admin', label: 'Admin', branchIndex: null },
  { role: 'branch-admin', label: 'Branch Admin', branchIndex: 0 },
  { role: 'accountant', label: 'Accountant', branchIndex: null },
  { role: 'teacher', label: 'Teacher', branchIndex: 0 },
  { role: 'student', label: 'Student', branchIndex: 0 },
  { role: 'parent', label: 'Parent', branchIndex: 0 },
];

async function upsertUser(mobile: string, name: string, passwordHash: string, isSuperAdmin = false) {
  const [user] = await User.findOrCreate({
    where: { mobile },
    defaults: { mobile, name, passwordHash, isSuperAdmin, email: null, lastLoginAt: null },
  });
  return user;
}

export const up: Migration = async () => {
  await upsertUser(
    config.SEED_SUPERADMIN_MOBILE,
    'Platform Super Admin',
    await bcrypt.hash(config.SEED_SUPERADMIN_PASSWORD, 10),
    true,
  );

  const plans: Record<string, Plan> = {};
  for (const p of PLANS) {
    const [plan] = await Plan.findOrCreate({
      where: { code: p.code },
      defaults: {
        code: p.code,
        name: p.name,
        description: null,
        priceMonthlyPaise: p.monthly,
        priceYearlyPaise: p.monthly * 10,
        limits: p.limits,
      },
    });
    plans[p.code] = plan;
  }

  const demoHash = await bcrypt.hash(config.SEED_DEMO_PASSWORD, 10);
  for (const def of INSTITUTES) {
    if (await Institute.findOne({ where: { slug: def.slug } })) continue;
    const inst = await Institute.create({
      slug: def.slug,
      name: def.name,
      city: def.city,
      primaryColor: def.primaryColor,
      secondaryColor: def.secondaryColor,
      logoFileId: null,
      address: null,
      state: null,
      registrationNumber: null,
      gstin: null,
      contactEmail: `hello@${def.slug}.example.com`,
      contactPhone: null,
      bankDetails: null,
    });
    const branches = await Promise.all(
      def.branches.map((name, i) =>
        Branch.create({
          instituteId: inst.id,
          name,
          code: `B${i + 1}`,
          city: def.city,
          address: null,
          phone: null,
          email: null,
        }),
      ),
    );
    await Subscription.create({
      instituteId: inst.id,
      planId: plans[def.plan].id,
      status: 'active',
      billingCycle: 'monthly',
      startsAt: new Date(Date.now() - 86400000),
      endsAt: null,
      limitOverrides: null,
    });
    for (const [i, r] of DEMO_ROLES.entries()) {
      const user = await upsertUser(
        `${def.prefix}0000000${i + 1}`,
        `${def.name.split(' ')[0]} ${r.label}`,
        demoHash,
      );
      const role = await getSystemRole(r.role);
      const branchId = r.branchIndex === null ? null : branches[r.branchIndex].id;
      await UserRole.create({ userId: user.id, instituteId: inst.id, roleId: role.id, branchId });
      if (branchId) await UserBranch.create({ userId: user.id, instituteId: inst.id, branchId });
    }
  }
};

export const down: Migration = async () => {
  await Institute.destroy({ where: { slug: INSTITUTES.map((i) => i.slug) } });
};
