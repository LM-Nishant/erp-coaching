import { Op } from 'sequelize';
import type { DeviceDto, PlatformUserDto } from '@erp/shared';
import { enqueueJob } from '../../infrastructure/jobs/queue';
import { getContext } from '../../shared/context';
import { NotFound } from '../../shared/errors';
import { audit } from '../../shared/audit/audit.service';
import { nowInZone, getInstituteTimezone } from '../../shared/timezone';
import { notify } from '../notifications/api';
import { Institute } from '../institutes/institute.model';
import { membershipInstituteIds } from '../permissions/access.service';
import { UserRole } from '../permissions/models';
import { User } from '../users/user.model';
import { emitDeviceRevoked } from './device-events';
import { Device, RefreshToken } from './models';

export const DEVICE_REVOKED_NOTICE_JOB = 'authentication.device-revoked-notice';
export const DEVICE_REVOKED_EVENT = 'auth.device-revoked';

export function toDeviceDto(d: Device, currentDeviceId?: number): DeviceDto {
  return {
    id: d.id,
    name: d.name,
    platform: d.platform,
    status: d.status,
    lastSeenAt: d.lastSeenAt?.toISOString() ?? null,
    createdAt: d.createdAt.toISOString(),
    revokedAt: d.revokedAt?.toISOString() ?? null,
    biometricUnlock: !!d.unlockKeyHash,
    ...(currentDeviceId !== undefined ? { current: d.id === currentDeviceId } : {}),
  };
}

/** A user's sign-in devices, active first. Callers check that the requester may see this user. */
export async function listUserDevices(userId: number, currentDeviceId?: number): Promise<DeviceDto[]> {
  const rows = await Device.findAll({
    where: { userId },
    order: [
      ['status', 'ASC'],
      ['lastSeenAt', 'DESC'],
      ['id', 'DESC'],
    ],
  });
  return rows.map((d) => toDeviceDto(d, currentDeviceId));
}

/**
 * Signs a device out for good: revokes its refresh tokens (access tokens stop working on the next
 * request, `authenticate` checks the device), clears its biometric unlock key and notifies
 * listeners (LMS revokes the device's offline licences, notifications drop its push tokens). When
 * an administrator revokes someone else's device, the user gets a mandatory security notice.
 */
export async function revokeDevice(deviceId: number, userId: number, revokedBy: number): Promise<void> {
  const device = await Device.findOne({ where: { id: deviceId, userId } });
  if (!device) throw NotFound('Device');
  const now = new Date();
  await RefreshToken.update({ revokedAt: now }, { where: { deviceId: device.id, revokedAt: null } });
  if (device.status === 'revoked') return;
  await device.update({
    status: 'revoked',
    revokedAt: now,
    revokedBy,
    unlockKeyHash: null,
    unlockEnrolledAt: null,
  });
  const byAdmin = revokedBy !== userId;
  await audit({
    action: 'device.revoked',
    entityType: 'device',
    entityId: device.id,
    metadata: { userId, revokedBy, byAdmin, name: device.name, platform: device.platform },
  });
  await emitDeviceRevoked({
    deviceId: device.id,
    userId,
    deviceUid: device.deviceUid,
    platform: device.platform,
    revokedBy,
    revokedAt: now.toISOString(),
  });
  if (byAdmin) await enqueueRevocationNotice(device, now);
}

/**
 * The notice is sent from an institute the user belongs to: the administrator's institute, else
 * the one the device was last signed in to, else the first membership. Users without any
 * membership (platform staff) only see the sign-out on the device itself.
 */
async function enqueueRevocationNotice(device: Device, revokedAt: Date) {
  const memberships = await membershipInstituteIds(device.userId);
  if (!memberships.length) return;
  const last = await RefreshToken.findOne({
    where: { deviceId: device.id, instituteId: { [Op.ne]: null } },
    order: [['id', 'DESC']],
  });
  const instituteId = [getContext().instituteId, last?.instituteId, memberships[0]].find(
    (id): id is number => !!id && memberships.includes(id),
  );
  if (!instituteId) return;
  await enqueueJob(
    DEVICE_REVOKED_NOTICE_JOB,
    { userId: device.userId, deviceName: deviceLabel(device), revokedAt: revokedAt.toISOString() },
    { instituteId },
  );
}

function deviceLabel(d: Device) {
  const platform = { android: 'Android', ios: 'iOS', web: 'Web browser' }[d.platform ?? ''] ?? null;
  if (d.name && platform) return `${d.name} (${platform})`;
  return d.name ?? platform ?? 'a device';
}

/** Job (institute context): mandatory in-app/push notice that an administrator revoked a device. */
export async function sendRevocationNotice(payload: Record<string, unknown>): Promise<void> {
  const { userId, deviceName, revokedAt } = payload as {
    userId: number;
    deviceName: string;
    revokedAt: string;
  };
  const tz = await getInstituteTimezone();
  const at = nowInZone(tz, new Date(revokedAt));
  await notify({
    event: DEVICE_REVOKED_EVENT,
    recipients: [{ userIds: [userId] }],
    data: { device: deviceName, revokedAt: `${at.date} ${at.time}` },
    branchId: null,
  });
}

/** Super admin: platform-wide user lookup (name, mobile or email) for device management. */
export async function searchPlatformUsers(search: string): Promise<PlatformUserDto[]> {
  const like = `%${search}%`;
  const users = await User.findAll({
    where: {
      [Op.or]: [{ name: { [Op.like]: like } }, { mobile: { [Op.like]: like } }, { email: { [Op.like]: like } }],
    },
    order: [['name', 'ASC']],
    limit: 20,
  });
  if (!users.length) return [];
  const ids = users.map((u) => u.id);
  const [devices, roles] = await Promise.all([
    Device.findAll({ where: { userId: ids, status: 'active' }, attributes: ['userId'] }),
    UserRole.findAll({
      where: { userId: ids },
      attributes: ['userId', 'instituteId'],
      // Platform admin lookup across tenants; only institute ids/names are returned.
      tenantBypass: true,
    } as object),
  ]);
  const instituteIds = [...new Set(roles.map((r) => r.instituteId))];
  const institutes = instituteIds.length
    ? await Institute.findAll({ where: { id: instituteIds }, attributes: ['id', 'name'] })
    : [];
  const instituteName = new Map(institutes.map((i) => [i.id, i.name]));
  return users.map((u) => ({
    id: u.id,
    name: u.name,
    mobile: u.mobile,
    email: u.email,
    status: u.status,
    isSuperAdmin: u.isSuperAdmin,
    activeDevices: devices.filter((d) => d.userId === u.id).length,
    institutes: [...new Set(roles.filter((r) => r.userId === u.id).map((r) => r.instituteId))].map((id) => ({
      id,
      name: instituteName.get(id) ?? '',
    })),
  }));
}
