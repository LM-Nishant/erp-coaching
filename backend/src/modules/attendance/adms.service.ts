import { Op } from 'sequelize';
import type { DeviceCommandDto, DeviceInfoDto } from '@erp/shared';
import {
  ADMS_SERIAL,
  ADMS_STAMP,
  admsDirection,
  admsHandshake,
  admsLines,
  admsPunchTime,
  buildAdmsCommand,
  countAdmsRecords,
  formatAdmsCommands,
  parseAttlog,
  parseCommandReplies,
  parseGetrequestInfo,
  parseOperlog,
  parseOptionsUpload,
  unpackAdmsPacket,
  type AdmsCommand,
  type AdmsDeviceInfo,
  type BiometricPunch,
} from '../../infrastructure/biometric';
import { config } from '../../infrastructure/config';
import { logger } from '../../infrastructure/logger';
import { getContext, runWithContext } from '../../shared/context';
import { AppError, BadRequest, Conflict, Forbidden, TooManyRequests } from '../../shared/errors';
import { audit } from '../../shared/audit/audit.service';
import { TenantRepository } from '../../shared/tenancy/tenant-repository';
import { getInstituteTimezone, isValidTimeZone, todayIn, utcOffsetMinutes } from '../../shared/timezone';
import { isModuleEnabled } from '../subscriptions/api';
import { ADMS_ADAPTER, deviceRepo, ingestPunches } from './devices.service';
import { ipAllowed, normalizeIp } from './ip-allowlist';
import { AttendanceDevice, AttendanceDeviceCommand, AttendanceDeviceUser } from './models';

/**
 * ZKTeco/eSSL ADMS push (`/iclock/*`). Devices are identified by their registered serial number and
 * the per-device rules (IP allowlist, HTTPS unless plain HTTP is allowed); punches go through the
 * same ingest as the generic punch API. Problems a device causes are shown with the device in the
 * app (`lastError`) because nobody reads the device's own error display.
 */

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
/** Queued commands that are not delivered and answered within this time expire. */
const COMMAND_TTL_MS = DAY;
const MAX_OPEN_COMMANDS = 20;
const COMMANDS_PER_POLL = 10;
/** Punches up to this far ahead of the server clock are accepted (device clock drift). */
const CLOCK_SKEW_MS = 10 * MINUTE;
/** Requests from one device waiting for each other; more are refused (429). */
const MAX_WAITING_PER_DEVICE = 8;

export const deviceCommandRepo = new TenantRepository(AttendanceDeviceCommand, { entity: 'Device command' });
export const deviceUserRepo = new TenantRepository(AttendanceDeviceUser, { entity: 'Device user' });

const chunks = <T>(list: T[], size: number) =>
  Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, (i + 1) * size));

/** The device clock's zone: its own setting, else the institute's. */
export async function deviceTimeZone(d: AttendanceDevice): Promise<string> {
  return d.timeZone && isValidTimeZone(d.timeZone) ? d.timeZone : getInstituteTimezone(d.instituteId);
}

/* ------------------------------------------------------------------ admission */

export interface AdmsCaller {
  /** `SN` query parameter. */
  serial: string;
  ip?: string;
  /** Arrived over HTTPS (directly or through the trusted proxy). */
  secure: boolean;
}

const DEVICE_REFUSED = 'Unknown or disabled device';
const unknownLogged = new Map<string, number>();

/** Warns about unregistered serials at most every 10 minutes per serial. */
function logUnknownDevice({ serial, ip }: AdmsCaller) {
  const valid = ADMS_SERIAL.test(serial);
  const key = valid ? serial.toUpperCase() : '';
  const now = Date.now();
  if (now - (unknownLogged.get(key) ?? 0) < 10 * MINUTE) return;
  if (unknownLogged.size >= 1000) unknownLogged.clear();
  unknownLogged.set(key, now);
  logger.warn(
    { serial: valid ? serial : undefined, ip },
    'ADMS request from an unregistered or disabled device',
  );
}

/** Shows a problem with the device in the app; the same message is written at most once a minute. */
export async function noteDeviceError(d: AttendanceDevice, message: string): Promise<void> {
  const text = message.slice(0, 255);
  if (d.lastError === text && d.lastErrorAt && Date.now() - d.lastErrorAt.getTime() < MINUTE) return;
  try {
    await d.update({ lastError: text, lastErrorAt: new Date() });
  } catch (err) {
    logger.warn({ err, deviceId: d.id }, 'Could not record an ADMS device error');
  }
}

/**
 * Identifies the device by serial number and applies its rules. Runs before the request body is
 * read. Every refusal gets the same 403, so the response doesn't reveal whether a serial is
 * registered; the reason is shown with the device instead.
 */
export async function admitAdmsDevice(caller: AdmsCaller): Promise<AttendanceDevice> {
  const d = ADMS_SERIAL.test(caller.serial)
    ? await AttendanceDevice.findOne({ where: { serial: caller.serial }, tenantBypass: true } as object)
    : null;
  if (!d || d.adapter !== ADMS_ADAPTER || !d.active) {
    logUnknownDevice(caller);
    throw Forbidden(DEVICE_REFUSED, 'DEVICE_FORBIDDEN');
  }
  const ip = caller.ip ? normalizeIp(caller.ip) : undefined;
  const refused = !ipAllowed(d.ipAllowlist, ip)
    ? `Refused a request from ${ip ?? 'an unknown address'}: not in the device's IP allowlist`
    : !caller.secure && !d.allowHttp
      ? 'Refused a plain-HTTP request: use HTTPS on the device, or allow plain HTTP for it'
      : !(await isModuleEnabled(d.instituteId, 'attendance'))
        ? 'Refused a request: attendance is not enabled for this institute'
        : null;
  if (refused) {
    await noteDeviceError(d, refused);
    throw Forbidden(DEVICE_REFUSED, 'DEVICE_FORBIDDEN');
  }
  return d;
}

/* ----------------------------------------------------------------- device lane */

const lanes = new Map<number, { tail: Promise<void>; size: number }>();

/**
 * Runs one device's requests one at a time, in arrival order, with a fresh copy of the device
 * (upload pointers, info). A batch the device resends after a timeout waits for the first attempt
 * and is then acknowledged as duplicates.
 */
export function admsSession<T>(
  admitted: AttendanceDevice,
  fn: (d: AttendanceDevice) => Promise<T>,
): Promise<T> {
  const ctx = {
    ...getContext(),
    system: true,
    instituteId: admitted.instituteId,
    allowedBranchIds: null,
    activeBranchId: undefined,
  };
  return runWithContext(ctx, () => {
    const lane = lanes.get(admitted.id) ?? { tail: Promise.resolve(), size: 0 };
    if (lane.size >= MAX_WAITING_PER_DEVICE)
      return Promise.reject(TooManyRequests('Too many requests from this device at once'));
    lane.size++;
    lanes.set(admitted.id, lane);
    const run = lane.tail.then(async () => {
      const d = await AttendanceDevice.findOne({
        where: { id: admitted.id, instituteId: admitted.instituteId },
      });
      if (!d || !d.active) throw Forbidden(DEVICE_REFUSED, 'DEVICE_FORBIDDEN');
      return fn(d);
    });
    lane.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run.finally(() => {
      if (--lane.size === 0 && lanes.get(admitted.id) === lane) lanes.delete(admitted.id);
    });
  });
}

type DeviceChanges = Partial<
  Pick<AttendanceDevice, 'lastSeenAt' | 'lastIp' | 'info' | 'pushStamps' | 'lastError' | 'lastErrorAt'>
>;

/** Records that the device was seen (at most once a minute), its address and what it reported. */
async function touchDevice(
  d: AttendanceDevice,
  caller: AdmsCaller,
  info?: AdmsDeviceInfo | null,
  changes: DeviceChanges = {},
) {
  const now = new Date();
  if (!d.lastSeenAt || now.getTime() - d.lastSeenAt.getTime() >= MINUTE) changes.lastSeenAt = now;
  const ip = caller.ip ? normalizeIp(caller.ip).slice(0, 45) : null;
  if (ip && ip !== d.lastIp) changes.lastIp = ip;
  if (info) {
    const merged: DeviceInfoDto = { ...(d.info ?? {}) };
    let changed = false;
    for (const [k, v] of Object.entries(info) as [keyof DeviceInfoDto, string | number | undefined][])
      if (v !== undefined && merged[k] !== v) {
        (merged as Record<string, unknown>)[k] = v;
        changed = true;
      }
    if (changed) changes.info = merged;
  }
  if (Object.keys(changes).length) await d.update(changes);
}

/* ------------------------------------------------------------------ protocol */

/**
 * `GET /iclock/cdata`: handshake. Replies with the upload pointers and the clock offset. A `0`
 * pointer (set when re-reading the user list was requested) asks for a full upload once.
 */
export async function admsHandshakeReply(
  d: AttendanceDevice,
  caller: AdmsCaller,
  pushVersion?: string,
): Promise<string> {
  const stamps = d.pushStamps ?? {};
  const reply = admsHandshake({
    serial: caller.serial,
    attlogStamp: stamps.ATTLOG,
    operlogStamp: stamps.OPERLOG,
    utcOffsetMinutes: utcOffsetMinutes(await deviceTimeZone(d)),
  });
  const changes: DeviceChanges = {};
  if (Object.values(stamps).includes('0')) {
    const kept = Object.fromEntries(Object.entries(stamps).filter(([, v]) => v !== '0'));
    changes.pushStamps = Object.keys(kept).length ? kept : null;
  }
  const version = pushVersion && /^[\d.]{1,20}$/.test(pushVersion) ? { pushVersion } : null;
  await touchDevice(d, caller, version, changes);
  return reply;
}

export interface AdmsUpload {
  /** `table` query parameter (`ATTLOG`, `OPERLOG`, `options`…). */
  table: string;
  /** Upload pointer the device sent with the batch. */
  stamp?: string;
  /** `ContentType` query parameter (`tgz` for data packets). */
  contentType?: string;
  body: Buffer;
}

/** Data packets are unpacked; the record cap applies to what is inside, before parsing. */
async function uploadRecords(d: AttendanceDevice, upload: AdmsUpload): Promise<string> {
  let body = upload.body;
  const tooLarge = async (what: string) => {
    await noteDeviceError(d, `Refused an upload with ${what}`);
    return new AppError(413, 'PAYLOAD_TOO_LARGE', 'Upload too large');
  };
  if (/^tgz$/i.test(upload.contentType ?? '') || (body[0] === 0x1f && body[1] === 0x8b)) {
    try {
      body = unpackAdmsPacket(body, config.ADMS_MAX_BODY_KB * 1024);
    } catch (err) {
      if ((err as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE')
        throw await tooLarge(`more than ${config.ADMS_MAX_BODY_KB} KB of records`);
      await noteDeviceError(d, 'Refused a corrupt data packet');
      throw BadRequest('Corrupt data packet');
    }
  }
  if (countAdmsRecords(body, config.ADMS_MAX_RECORDS) > config.ADMS_MAX_RECORDS)
    throw await tooLarge(`more than ${config.ADMS_MAX_RECORDS} records`);
  return body.toString('utf8');
}

/**
 * `POST /iclock/cdata?table=…`: uploads. Attendance logs become punches; user records feed PIN
 * mapping; settings update the device info. Other tables (photos, templates) are acknowledged and
 * dropped. Every record is acknowledged, unreadable ones included, so the device doesn't resend them.
 */
export async function admsUpload(
  d: AttendanceDevice,
  caller: AdmsCaller,
  upload: AdmsUpload,
): Promise<string> {
  const table = upload.table.trim().toUpperCase();
  if (table !== 'ATTLOG' && table !== 'OPERLOG' && table !== 'USERINFO' && table !== 'OPTIONS') {
    await touchDevice(d, caller);
    return 'OK';
  }
  const text = await uploadRecords(d, upload);
  if (table === 'OPTIONS') {
    await touchDevice(d, caller, parseOptionsUpload(text));
    return 'OK';
  }
  const reply = table === 'ATTLOG' ? await uploadAttlog(d, text) : await uploadUsers(d, text);
  const changes: DeviceChanges = {};
  const stampTable = table === 'ATTLOG' ? 'ATTLOG' : 'OPERLOG';
  const stored = d.pushStamps?.[stampTable];
  // A pending `0` (full re-upload requested) is kept until the next handshake has sent it.
  if (upload.stamp && ADMS_STAMP.test(upload.stamp) && stored !== '0' && stored !== upload.stamp)
    changes.pushStamps = { ...(d.pushStamps ?? {}), [stampTable]: upload.stamp };
  await touchDevice(d, caller, null, changes);
  return reply;
}

async function uploadAttlog(d: AttendanceDevice, text: string): Promise<string> {
  const { records, invalid } = parseAttlog(text);
  const tz = await deviceTimeZone(d);
  const now = Date.now();
  const oldest = now - config.ADMS_BACKFILL_DAYS * DAY;
  const punches: BiometricPunch[] = [];
  let stale = 0;
  for (const r of records) {
    const punchedAt = admsPunchTime(r, tz);
    if (punchedAt.getTime() < oldest) stale++;
    else
      punches.push({
        deviceSerial: d.serial,
        enrolmentId: r.pin,
        punchedAt,
        direction: admsDirection(r.status),
      });
  }
  if (punches.length) await ingestPunches(d, punches, { notAfter: new Date(now + CLOCK_SKEW_MS) });
  const skipped = [
    invalid ? `${invalid} unreadable` : '',
    stale ? `${stale} older than ${config.ADMS_BACKFILL_DAYS} days` : '',
  ].filter(Boolean);
  if (skipped.length) await noteDeviceError(d, `Skipped attendance records: ${skipped.join(', ')}`);
  return `OK: ${records.length + invalid}`;
}

/** User records (PIN, name, privilege) for PIN mapping; deleted users are removed. */
async function uploadUsers(d: AttendanceDevice, text: string): Promise<string> {
  const { users, deletedPins, invalid } = parseOperlog(text);
  const lastSeenAt = new Date();
  for (const list of chunks(users, 500))
    await AttendanceDeviceUser.bulkCreate(
      list.map((u) => ({
        instituteId: d.instituteId,
        deviceId: d.id,
        pin: u.pin,
        name: u.name,
        privilege: u.privilege,
        lastSeenAt,
      })),
      { updateOnDuplicate: ['name', 'privilege', 'lastSeenAt', 'updatedAt'] },
    );
  for (const list of chunks(deletedPins, 500))
    await AttendanceDeviceUser.destroy({
      where: { instituteId: d.instituteId, deviceId: d.id, pin: { [Op.in]: list } },
    });
  if (invalid) await noteDeviceError(d, `Skipped ${invalid} unreadable user records`);
  return `OK: ${admsLines(text).length}`;
}

/** `GET /iclock/getrequest`: delivers queued commands (oldest first) and expires stale ones. */
export async function admsPoll(d: AttendanceDevice, caller: AdmsCaller, info: unknown): Promise<string> {
  await touchDevice(d, caller, parseGetrequestInfo(info));
  const now = new Date();
  const scope = { instituteId: d.instituteId, deviceId: d.id };
  await AttendanceDeviceCommand.update(
    { status: 'expired', completedAt: now },
    {
      where: {
        ...scope,
        status: { [Op.in]: ['pending', 'sent'] },
        createdAt: { [Op.lt]: new Date(now.getTime() - COMMAND_TTL_MS) },
      },
    },
  );
  const pending = await AttendanceDeviceCommand.findAll({
    where: { ...scope, status: 'pending' },
    order: [['id', 'ASC']],
    limit: COMMANDS_PER_POLL,
  });
  const out: { cmdId: string; command: string }[] = [];
  for (const c of pending) {
    // Conditional, so another API instance polling for the same device can't send it twice.
    const [sent] = await AttendanceDeviceCommand.update(
      { status: 'sent', sentAt: now },
      { where: { instituteId: d.instituteId, id: c.id, status: 'pending' } },
    );
    if (sent) out.push({ cmdId: String(c.id), command: c.command });
  }
  return formatAdmsCommands(out);
}

/** `POST /iclock/devicecmd`: command results. Unknown or already answered ids are ignored. */
export async function admsCommandResults(
  d: AttendanceDevice,
  caller: AdmsCaller,
  body: string,
): Promise<string> {
  const replies = parseCommandReplies(body)
    .filter((r) => /^\d{1,10}$/.test(r.id))
    .slice(0, 100);
  const info: AdmsDeviceInfo = {};
  const completedAt = new Date();
  for (const r of replies) {
    const c = await AttendanceDeviceCommand.findOne({
      where: { instituteId: d.instituteId, deviceId: d.id, id: Number(r.id) },
    });
    if (!c || c.status === 'done' || c.status === 'failed') continue;
    Object.assign(info, r.info);
    await c.update({
      // Negative return codes are errors; queries return the number of records (≥ 0).
      status: r.returnCode === null || r.returnCode >= 0 ? 'done' : 'failed',
      returnCode: r.returnCode,
      completedAt,
      result: { cmd: r.cmd, ...(Object.keys(r.info).length ? { info: r.info } : {}) },
    });
  }
  await touchDevice(d, caller, Object.keys(info).length ? info : null);
  return 'OK';
}

/** `GET /iclock/ping`: keep-alive while the device uploads a large batch. */
export async function admsPing(d: AttendanceDevice, caller: AdmsCaller): Promise<string> {
  await touchDevice(d, caller);
  return 'OK';
}

/* -------------------------------------------------------------------- commands */

export const toCommandDto = (c: AttendanceDeviceCommand): DeviceCommandDto => {
  const open = c.status === 'pending' || c.status === 'sent';
  return {
    id: c.id,
    deviceId: c.deviceId,
    kind: c.kind,
    command: c.command,
    // Not expired in the database until the device polls again.
    status: open && Date.now() - c.createdAt.getTime() > COMMAND_TTL_MS ? 'expired' : c.status,
    returnCode: c.returnCode ?? null,
    createdAt: c.createdAt.toISOString(),
    sentAt: c.sentAt ? c.sentAt.toISOString() : null,
    completedAt: c.completedAt ? c.completedAt.toISOString() : null,
  };
};

async function admsDevice(deviceId: number) {
  const d = await deviceRepo.findById(deviceId);
  if (d.adapter !== ADMS_ADAPTER) throw BadRequest('Commands can only be sent to ADMS devices');
  return d;
}

export async function listDeviceCommands(deviceId: number): Promise<DeviceCommandDto[]> {
  const d = await deviceRepo.findById(deviceId);
  const rows = await deviceCommandRepo.findAll({
    where: { deviceId: d.id },
    order: [['id', 'DESC']],
    limit: 50,
  });
  return rows.map(toCommandDto);
}

/** Queues a command for the device's next poll (every 30 seconds while it is online). */
export async function queueDeviceCommand(deviceId: number, cmd: AdmsCommand): Promise<DeviceCommandDto> {
  const d = await admsDevice(deviceId);
  deviceRepo.assertRowWritable(d);
  if (cmd.kind === 'fetch_logs') {
    if (cmd.from > cmd.to) throw BadRequest('The start date must be on or before the end date');
    const earliest = todayIn(await deviceTimeZone(d), new Date(Date.now() - config.ADMS_BACKFILL_DAYS * DAY));
    if (cmd.from < earliest)
      throw BadRequest(
        `Punches older than ${config.ADMS_BACKFILL_DAYS} days are not applied; start on ${earliest} or later`,
      );
  }
  let command: string;
  try {
    command = buildAdmsCommand(cmd);
  } catch (err) {
    throw BadRequest((err as Error).message);
  }
  const open = await deviceCommandRepo.count({
    deviceId: d.id,
    status: { [Op.in]: ['pending', 'sent'] },
    createdAt: { [Op.gte]: new Date(Date.now() - COMMAND_TTL_MS) },
  });
  if (open >= MAX_OPEN_COMMANDS)
    throw Conflict(
      'Too many commands are waiting for this device; try again once it is online',
      'TOO_MANY_COMMANDS',
    );
  const row = await deviceCommandRepo.create({
    deviceId: d.id,
    kind: cmd.kind,
    command,
    createdByUserId: getContext().userId ?? null,
  });
  // Re-reading the user list: the next handshake asks for a full user upload.
  if (cmd.kind === 'fetch_users') await d.update({ pushStamps: { ...(d.pushStamps ?? {}), OPERLOG: '0' } });
  await audit({
    action: 'attendance.device.command-queued',
    entityType: 'AttendanceDevice',
    entityId: d.id,
    metadata: { commandId: row.id, kind: cmd.kind, command },
  });
  return toCommandDto(row);
}
