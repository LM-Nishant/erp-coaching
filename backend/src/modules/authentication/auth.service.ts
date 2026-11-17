import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { Op } from 'sequelize';
import type { AuthTokens, LoginResult, MeDto } from '@erp/shared';
import { config } from '../../infrastructure/config';
import { randomDigits, randomToken, sha256, safeEqual } from '../../infrastructure/crypto';
import { getMessagingProvider } from '../../infrastructure/messaging';
import { logger } from '../../infrastructure/logger';
import { AppError, BadRequest, Forbidden, Unauthorized, NotFound } from '../../shared/errors';
import { getContext } from '../../shared/context';
import { audit } from '../../shared/audit/audit.service';
import { User } from '../users/user.model';
import { Institute } from '../institutes/institute.model';
import { Branch } from '../branches/branch.model';
import { loadAssignments, computeAccess, membershipInstituteIds } from '../permissions/access.service';
import { Role, UserRole } from '../permissions/models';
import { getPlanLimits } from '../subscriptions/subscription.service';
import { Device, ImpersonationSession, OtpChallenge, RefreshToken } from './models';
import { signAccessToken } from './token.service';

export interface DeviceInput {
  uid: string;
  name?: string;
  platform?: string;
}

const INVALID_CREDENTIALS = () => new AppError(401, 'INVALID_CREDENTIALS', 'Invalid mobile/email or password');

export function maskMobile(mobile: string) {
  return mobile.length > 4 ? `${'•'.repeat(mobile.length - 4)}${mobile.slice(-4)}` : mobile;
}

// ---------------------------------------------------------------- tokens

async function issueTokens(user: User, device: Device, instituteId?: number | null): Promise<AuthTokens> {
  let inst = instituteId ?? undefined;
  if (inst === undefined && !user.isSuperAdmin) {
    const ids = await membershipInstituteIds(user.id);
    if (ids.length === 1) inst = ids[0];
  }
  const refreshToken = randomToken();
  await RefreshToken.create({
    userId: user.id,
    deviceId: device.id,
    instituteId: inst ?? null,
    tokenHash: sha256(refreshToken),
    expiresAt: new Date(Date.now() + config.REFRESH_TOKEN_TTL_DAYS * 86400_000),
    revokedAt: null,
  });
  await user.update({ lastLoginAt: new Date() });
  return {
    accessToken: signAccessToken({ sub: user.id, did: device.id, inst }),
    refreshToken,
    expiresIn: config.ACCESS_TOKEN_TTL_SECONDS,
  };
}

// ---------------------------------------------------------------- devices

type DeviceCheck = { device: Device } | { otpRequired: true } | { limitReached: true };

/**
 * Enforces the device policy: max MAX_ACTIVE_DEVICES active devices per user and OTP for any
 * new device (the very first device of a user is exempt for password logins).
 */
async function checkDevice(user: User, input: DeviceInput, otpVerified: boolean): Promise<DeviceCheck> {
  const ctx = getContext();
  const existing = await Device.findOne({ where: { userId: user.id, deviceUid: input.uid } });
  if (existing?.status === 'active') {
    await existing.update({ lastSeenAt: new Date(), lastIp: ctx.ip ?? null });
    return { device: existing };
  }
  const activeCount = await Device.count({ where: { userId: user.id, status: 'active' } });
  if (activeCount >= config.MAX_ACTIVE_DEVICES) return { limitReached: true };
  if (!otpVerified) {
    const everHadDevice = existing || (await Device.count({ where: { userId: user.id } })) > 0;
    if (everHadDevice) return { otpRequired: true };
  }
  const values = {
    status: 'active' as const,
    name: input.name ?? null,
    platform: input.platform ?? null,
    lastSeenAt: new Date(),
    lastIp: ctx.ip ?? null,
    revokedAt: null,
    revokedBy: null,
  };
  const device = existing
    ? await existing.update(values)
    : await Device.create({ userId: user.id, deviceUid: input.uid, ...values });
  await audit({ action: 'device.registered', entityType: 'device', entityId: device.id, instituteId: null, metadata: { userId: user.id, platform: input.platform } });
  return { device };
}

export async function revokeDevice(deviceId: number, userId: number, revokedBy: number) {
  const device = await Device.findOne({ where: { id: deviceId, userId } });
  if (!device) throw NotFound('Device');
  await device.update({ status: 'revoked', revokedAt: new Date(), revokedBy });
  await RefreshToken.update({ revokedAt: new Date() }, { where: { deviceId: device.id, revokedAt: null } });
  await audit({ action: 'device.revoked', entityType: 'device', entityId: device.id, metadata: { userId } });
}

// ---------------------------------------------------------------- OTP

async function createChallenge(user: User | null, mobile: string, purpose: OtpChallenge['purpose'], deviceUid: string) {
  const recent = await OtpChallenge.count({
    where: { mobile, createdAt: { [Op.gt]: new Date(Date.now() - 10 * 60_000) } },
  });
  if (recent >= 5) throw new AppError(429, 'OTP_RATE_LIMITED', 'Too many OTP requests. Try again later.');
  const code = randomDigits(6);
  const challenge = await OtpChallenge.create({
    id: crypto.randomUUID(),
    userId: user?.id ?? null,
    mobile,
    purpose,
    codeHash: sha256(`${code}:${mobile}`),
    deviceUid,
    expiresAt: new Date(Date.now() + config.OTP_TTL_SECONDS * 1000),
    consumedAt: null,
  });
  if (user) {
    await getMessagingProvider('sms').send({
      to: mobile,
      body: `${code} is your verification code. It expires in ${Math.round(config.OTP_TTL_SECONDS / 60)} minutes.`,
      data: { otp: code, purpose },
    });
    if (!config.isProd) logger.info(`[DEV] OTP for ${mobile} (${purpose}): ${code}`);
  }
  return challenge;
}

// ---------------------------------------------------------------- public API

export async function loginWithPassword(identifier: string, password: string, device: DeviceInput): Promise<LoginResult> {
  const user = await User.findOne({ where: identifier.includes('@') ? { email: identifier } : { mobile: identifier } });
  // Constant-ish time: always run bcrypt.
  const ok = await bcrypt.compare(password, user?.passwordHash ?? '$2b$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinv');
  if (!user || !ok) throw INVALID_CREDENTIALS();
  if (user.status !== 'active') throw Forbidden('Account is not active', 'ACCOUNT_INACTIVE');

  const check = await checkDevice(user, device, false);
  if ('limitReached' in check) return { status: 'device_limit_reached', maxDevices: config.MAX_ACTIVE_DEVICES };
  if ('otpRequired' in check) {
    const ch = await createChallenge(user, user.mobile, 'new_device', device.uid);
    return { status: 'otp_required', challengeId: ch.id, reason: 'new_device', maskedMobile: maskMobile(user.mobile) };
  }
  await audit({ action: 'auth.login', entityType: 'user', entityId: user.id, instituteId: null, metadata: { method: 'password' } });
  return { status: 'authenticated', ...(await issueTokens(user, check.device)) };
}

/** Always returns a challenge to avoid revealing whether the mobile is registered. */
export async function requestLoginOtp(mobile: string, device: DeviceInput): Promise<LoginResult> {
  const user = await User.findOne({ where: { mobile, status: 'active' } });
  const ch = await createChallenge(user, mobile, 'login', device.uid);
  return { status: 'otp_required', challengeId: ch.id, reason: 'otp_login', maskedMobile: maskMobile(mobile) };
}

export async function verifyOtp(challengeId: string, code: string, device: DeviceInput): Promise<LoginResult> {
  const ch = await OtpChallenge.findByPk(challengeId);
  const invalid = () => new AppError(401, 'OTP_INVALID', 'Invalid or expired code');
  if (!ch || ch.consumedAt || ch.expiresAt < new Date() || !ch.userId) throw invalid();
  if (ch.deviceUid && ch.deviceUid !== device.uid) throw invalid();
  if (ch.attempts >= config.OTP_MAX_ATTEMPTS) throw new AppError(429, 'OTP_ATTEMPTS_EXCEEDED', 'Too many attempts; request a new code');
  if (!safeEqual(ch.codeHash, sha256(`${code}:${ch.mobile}`))) {
    await ch.increment('attempts');
    throw invalid();
  }
  await ch.update({ consumedAt: new Date() });
  const user = await User.findByPk(ch.userId);
  if (!user || user.status !== 'active') throw invalid();

  const check = await checkDevice(user, device, true);
  if ('limitReached' in check) return { status: 'device_limit_reached', maxDevices: config.MAX_ACTIVE_DEVICES };
  if ('otpRequired' in check) throw invalid();
  await audit({ action: 'auth.login', entityType: 'user', entityId: user.id, instituteId: null, metadata: { method: 'otp', purpose: ch.purpose } });
  return { status: 'authenticated', ...(await issueTokens(user, check.device)) };
}

/** Rotates the refresh token. Reuse of a revoked token revokes all tokens of that device. */
export async function refreshTokens(token: string): Promise<AuthTokens> {
  const row = await RefreshToken.findOne({ where: { tokenHash: sha256(token) } });
  if (!row) throw Unauthorized('Invalid refresh token', 'INVALID_REFRESH_TOKEN');
  if (row.revokedAt) {
    await RefreshToken.update({ revokedAt: new Date() }, { where: { deviceId: row.deviceId, revokedAt: null } });
    throw Unauthorized('Refresh token reuse detected', 'INVALID_REFRESH_TOKEN');
  }
  if (row.expiresAt < new Date()) throw Unauthorized('Refresh token expired', 'INVALID_REFRESH_TOKEN');
  const [user, device] = await Promise.all([User.findByPk(row.userId), Device.findByPk(row.deviceId)]);
  if (!user || user.status !== 'active' || !device || device.status !== 'active') {
    throw Unauthorized('Session is no longer valid', 'SESSION_REVOKED');
  }
  if (row.instituteId) await assertInstituteActive(row.instituteId);
  await row.update({ revokedAt: new Date() });
  return issueTokens(user, device, row.instituteId);
}

export async function logout(token: string) {
  await RefreshToken.update({ revokedAt: new Date() }, { where: { tokenHash: sha256(token), revokedAt: null } });
}

async function assertInstituteActive(instituteId: number) {
  const inst = await Institute.findByPk(instituteId);
  if (!inst) throw NotFound('Institute');
  if (inst.status !== 'active') throw Forbidden(`Institute is ${inst.status}`, 'INSTITUTE_NOT_ACTIVE');
  return inst;
}

export async function selectInstitute(userId: number, deviceId: number, instituteId: number): Promise<AuthTokens> {
  const ids = await membershipInstituteIds(userId);
  if (!ids.includes(instituteId)) throw Forbidden('You are not a member of this institute', 'NOT_A_MEMBER');
  await assertInstituteActive(instituteId);
  const [user, device] = await Promise.all([User.findByPk(userId), Device.findByPk(deviceId)]);
  if (!user || !device) throw Unauthorized();
  await RefreshToken.update({ revokedAt: new Date() }, { where: { deviceId, revokedAt: null } });
  return issueTokens(user, device, instituteId);
}

// ---------------------------------------------------------------- impersonation

export async function startImpersonation(superAdminId: number, instituteId: number, targetUserId: number | undefined, reason: string | undefined) {
  const institute = await Institute.findByPk(instituteId);
  if (!institute) throw NotFound('Institute');
  let target: User | null = null;
  if (targetUserId) {
    target = await User.findByPk(targetUserId);
  } else {
    const ur = await UserRole.findOne({
      where: { instituteId, branchId: null },
      include: [{ model: Role, as: 'role', where: { slug: 'institute-admin' } }],
      order: [['id', 'ASC']],
    });
    target = ur ? await User.findByPk(ur.userId) : null;
  }
  if (!target) throw NotFound('Institute admin user');
  if (target.isSuperAdmin) throw BadRequest('Cannot impersonate a super admin');
  if (!(await membershipInstituteIds(target.id)).includes(instituteId)) throw BadRequest('User is not a member of this institute');

  const ctx = getContext();
  const session = await ImpersonationSession.create({
    superAdminId,
    targetUserId: target.id,
    instituteId,
    reason: reason ?? null,
    ip: ctx.ip ?? null,
    expiresAt: new Date(Date.now() + config.IMPERSONATION_TTL_SECONDS * 1000),
    endedAt: null,
  });
  await audit({
    action: 'impersonation.started',
    entityType: 'user',
    entityId: target.id,
    instituteId,
    metadata: { sessionId: session.id, reason },
  });
  return {
    accessToken: signAccessToken(
      { sub: target.id, did: ctx.deviceId!, inst: instituteId, imp: superAdminId, isid: session.id },
      config.IMPERSONATION_TTL_SECONDS,
    ),
    expiresIn: config.IMPERSONATION_TTL_SECONDS,
    sessionId: session.id,
    targetUser: target.toPublic(),
  };
}

export async function stopImpersonation(sessionId: number) {
  const session = await ImpersonationSession.findByPk(sessionId);
  if (!session || session.endedAt) return;
  await session.update({ endedAt: new Date() });
  await audit({ action: 'impersonation.ended', entityType: 'user', entityId: session.targetUserId, instituteId: session.instituteId, metadata: { sessionId } });
}

// ---------------------------------------------------------------- me

export async function buildMe(): Promise<MeDto> {
  const ctx = getContext();
  const user = await User.findByPk(ctx.userId!);
  if (!user) throw Unauthorized();
  const memberIds = await membershipInstituteIds(user.id);
  const memberInstitutes = memberIds.length ? await Institute.findAll({ where: { id: memberIds } }) : [];
  const memberships = await Promise.all(
    memberInstitutes.map(async (inst) => {
      const { assignments } = await loadAssignments(user.id, inst.id);
      return { ...inst.toBranding(), roles: [...new Set(assignments.map((a) => a.roleSlug))] };
    }),
  );

  let institute = null;
  let branches: { id: number; name: string }[] = [];
  let enabledModules: string[] | null = null;
  if (ctx.instituteId) {
    const inst = await Institute.findByPk(ctx.instituteId);
    institute = inst?.toBranding() ?? null;
    const all = await Branch.findAll({ where: { instituteId: ctx.instituteId, status: 'active' }, order: [['name', 'ASC']] });
    branches = all
      .filter((b) => ctx.allowedBranchIds == null || ctx.allowedBranchIds.includes(b.id))
      .map((b) => ({ id: b.id, name: b.name }));
    enabledModules = await getPlanLimits(ctx.instituteId).then((l) => l.enabledModules).catch(() => []);
  }
  let impersonatedBy = null;
  if (ctx.impersonatorId) {
    const sa = await User.findByPk(ctx.impersonatorId);
    impersonatedBy = sa ? { id: sa.id, name: sa.name } : null;
  }
  const isPlatformAdmin = user.isSuperAdmin && !ctx.impersonatorId;
  return {
    user: { id: user.id, name: user.name, mobile: user.mobile, email: user.email, isSuperAdmin: user.isSuperAdmin },
    institute,
    branches,
    allowedBranchIds: ctx.allowedBranchIds ?? null,
    roles: isPlatformAdmin ? ['super-admin', ...(ctx.roles ?? [])] : (ctx.roles ?? []),
    permissions: isPlatformAdmin ? ['*'] : ([...(ctx.permissions ?? [])] as MeDto['permissions']),
    memberships,
    impersonatedBy,
    enabledModules,
  };
}

export { computeAccess };
