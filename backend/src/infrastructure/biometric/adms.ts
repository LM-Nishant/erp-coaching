import { gunzipSync } from 'node:zlib';
import { zonedDateTimeToUtc } from '../../shared/timezone';
import type { BiometricAdapter, BiometricParseOptions, BiometricPunch } from './index';

/**
 * ZKTeco / eSSL "ADMS" push protocol (PUSH SDK, `/iclock/*` endpoints). Devices push attendance and
 * operation logs as tab-separated text and poll the server for commands. This file only parses and
 * formats protocol text; the attendance module authenticates devices and stores the results.
 */

export const ADMS_PROTOCOL_VERSION = '2.2.14';
/** Device user id (PIN): printable ASCII without spaces. */
export const ADMS_PIN = /^[\x21-\x7e]{1,50}$/;
/** Device serial number (`SN`): printable ASCII without spaces. */
export const ADMS_SERIAL = /^[\x21-\x7e]{1,100}$/;
/** Upload pointer (`Stamp`) the device sends with each upload and gets back at handshake. */
export const ADMS_STAMP = /^[0-9A-Za-z]{1,20}$/;

export interface AdmsWallTime {
  /** Device wall-clock date `YYYY-MM-DD`. */
  date: string;
  /** Device wall-clock time `HH:mm:ss`. */
  time: string;
}

export interface AdmsAttRecord extends AdmsWallTime {
  pin: string;
  /** Punch state: 0 check-in, 1 check-out, 2 break-out, 3 break-in, 4 overtime-in, 5 overtime-out. */
  status: number | null;
  verify: number | null;
}

export interface AdmsUserRecord {
  pin: string;
  name: string | null;
  privilege: number | null;
}

export interface AdmsOperlog {
  users: AdmsUserRecord[];
  /** PINs deleted on the device (operation code 9). */
  deletedPins: string[];
  /** Other records (operation logs, templates, photos): accepted and ignored. */
  ignored: number;
  invalid: number;
}

export interface AdmsDeviceInfo {
  deviceName?: string;
  firmware?: string;
  platform?: string;
  vendor?: string;
  users?: number;
  fingerprints?: number;
  faces?: number;
  attLogs?: number;
  ip?: string;
  mac?: string;
  /** Push protocol version the firmware speaks (`pushver` at handshake). */
  pushVersion?: string;
}

export interface AdmsCommandReply {
  id: string;
  returnCode: number | null;
  cmd: string;
  /** Device details from the `Key=Value` lines that follow an INFO reply (allowlisted keys only). */
  info: AdmsDeviceInfo;
}

/** Non-empty lines of an ADMS body (LF or CRLF separated). */
export function admsLines(body: string): string[] {
  return body
    .split('\n')
    .map((l) => l.replace(/\r$/, ''))
    .filter((l) => l.trim() !== '');
}

/**
 * Non-empty lines in a raw body, counted without decoding it. Stops once `max` is exceeded so an
 * oversized upload is rejected before any parsing.
 */
export function countAdmsRecords(body: Buffer, max: number): number {
  let count = 0;
  let content = false;
  for (const b of body) {
    if (b === 0x0a) {
      if (content && ++count > max) return count;
      content = false;
    } else if (b !== 0x0d && b !== 0x20 && b !== 0x09) content = true;
  }
  return content ? count + 1 : count;
}

/**
 * Data packet (`ContentType=tgz`, push protocol 2.2.14+): a gzip-compressed tar of record files, or
 * gzip-compressed records on some firmware. Returns the records; throws when the packet is corrupt
 * or unpacks to more than `maxBytes` (`ERR_BUFFER_TOO_LARGE`).
 */
export function unpackAdmsPacket(packet: Buffer, maxBytes: number): Buffer {
  const data = gunzipSync(packet, { maxOutputLength: maxBytes });
  if (data.length < 512 || data.toString('latin1', 257, 262) !== 'ustar') return data;
  const files: Buffer[] = [];
  for (let off = 0; off + 512 <= data.length;) {
    const header = data.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break;
    const size = parseInt(header.toString('latin1', 124, 136).replace(/\0/g, '').trim() || '0', 8);
    off += 512;
    if (!Number.isSafeInteger(size) || size < 0 || off + size > data.length)
      throw new Error('Corrupt data packet');
    // Regular files only: skips directories and pax/long-name headers.
    if (header[156] === 0 || header[156] === 0x30)
      files.push(data.subarray(off, off + size), Buffer.from('\n'));
    off += Math.ceil(size / 512) * 512;
  }
  return Buffer.concat(files);
}

const int = (v: string | undefined): number | null => {
  const s = v?.trim();
  return s && /^-?\d{1,10}$/.test(s) ? Number(s) : null;
};

const TIME = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:\s+|T)(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?$/;

/** `YYYY-MM-DD HH:mm:ss` in device wall-clock time (some firmware pads separators with spaces). */
export function parseAdmsTime(value: string): AdmsWallTime | null {
  const m = TIME.exec(value.trim().replace(/\s*([:-])\s*/g, '$1'));
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1).map((x) => Number(x ?? 0));
  if (y < 1990 || y > 2100 || h > 23 || mi > 59 || s > 59) return null;
  const day = new Date(Date.UTC(y, mo - 1, d));
  if (day.getUTCMonth() !== mo - 1 || day.getUTCDate() !== d) return null;
  const p = (n: number) => String(n).padStart(2, '0');
  return { date: `${y}-${p(mo)}-${p(d)}`, time: `${p(h)}:${p(mi)}:${p(s)}` };
}

/** `YYYY-MM-DD HH:mm:ss`, the time format of ADMS commands. */
export const formatAdmsTime = (t: AdmsWallTime) => `${t.date} ${t.time}`;

/**
 * ATTLOG upload: one punch per line, tab-separated
 * `PIN, time, status, verify, workcode, reserved…`. Malformed lines are counted, not thrown, so one
 * bad record doesn't make the device resend the whole batch forever.
 */
export function parseAttlog(body: string): { records: AdmsAttRecord[]; invalid: number } {
  const records: AdmsAttRecord[] = [];
  let invalid = 0;
  for (const line of admsLines(body)) {
    let fields = line.split('\t');
    if (fields.length < 2) {
      // Some firmware separates fields with spaces: `PIN DATE TIME STATUS VERIFY ...`.
      const parts = line.trim().split(/\s+/);
      fields = parts.length >= 3 ? [parts[0], `${parts[1]} ${parts[2]}`, ...parts.slice(3)] : parts;
    }
    const pin = fields[0].trim();
    const at = parseAdmsTime(fields[1] ?? '');
    if (!ADMS_PIN.test(pin) || !at) {
      invalid++;
      continue;
    }
    records.push({ pin, ...at, status: int(fields[2]), verify: int(fields[3]) });
  }
  return { records, invalid };
}

/** Check-in, break-in and overtime-in count as arrivals; the "out" states as departures. */
export function admsDirection(status: number | null): 'in' | 'out' | undefined {
  if (status === 0 || status === 3 || status === 4) return 'in';
  if (status === 1 || status === 2 || status === 5) return 'out';
  return undefined;
}

/** `Key=Value` pairs separated by tabs (or, on some firmware, spaces). Keys are lower-cased. */
function keyValues(text: string): Record<string, string> {
  const parts = text.includes('\t') ? text.split('\t') : text.split(/\s+(?=[A-Za-z~][\w~]*=)/);
  const out: Record<string, string> = {};
  for (const part of parts) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim().toLowerCase()] = part.slice(i + 1);
  }
  return out;
}

const clean = (v: string | undefined, max: number) =>
  (v ?? '')
    .replace(/\p{Cc}/gu, '')
    .trim()
    .slice(0, max);

/**
 * OPERLOG upload: operation logs (`OPLOG <code>\t<who>\t<time>\t<v1>...`), user records
 * (`USER PIN=..\tName=..\tPri=..`) and biometric templates/photos. Only PIN, name and privilege of
 * users are kept; passwords, card numbers and templates are never read. Records apply in order, so
 * a user deleted and enrolled again in one upload ends up enrolled.
 */
export function parseOperlog(body: string): AdmsOperlog {
  const result: AdmsOperlog = { users: [], deletedPins: [], ignored: 0, invalid: 0 };
  const latest = new Map<string, AdmsUserRecord | null>();
  for (const line of admsLines(body)) {
    const sp = line.search(/\s/);
    // USERINFO uploads on some firmware omit the `USER` prefix.
    const bare = /^PIN=/i.test(line);
    const kind = bare ? 'USER' : (sp < 0 ? line : line.slice(0, sp)).toUpperCase();
    const rest = bare ? line : sp < 0 ? '' : line.slice(sp + 1);
    if (kind === 'USER') {
      const kv = keyValues(rest);
      const pin = kv.pin?.trim() ?? '';
      if (!ADMS_PIN.test(pin)) result.invalid++;
      else latest.set(pin, { pin, name: clean(kv.name, 100) || null, privilege: int(kv.pri) });
    } else if (kind === 'OPLOG') {
      // Operation 9 is "delete user"; its first value is the user's PIN.
      const f = rest.split('\t');
      const pin = f[3]?.trim() ?? '';
      if (int(f[0]) === 9 && ADMS_PIN.test(pin)) latest.set(pin, null);
      else result.ignored++;
    } else result.ignored++;
  }
  for (const [pin, user] of latest)
    if (user) result.users.push(user);
    else result.deletedPins.push(pin);
  return result;
}

type InfoField = keyof AdmsDeviceInfo;
const NUMERIC_INFO = new Set<InfoField>(['users', 'fingerprints', 'faces', 'attLogs']);
const INFO_KEYS = new Map<string, InfoField>([
  ['~devicename', 'deviceName'],
  ['devicename', 'deviceName'],
  ['fwversion', 'firmware'],
  ['firmver', 'firmware'],
  ['~platform', 'platform'],
  ['~oemvendor', 'vendor'],
  ['usercount', 'users'],
  ['fpcount', 'fingerprints'],
  ['facecount', 'faces'],
  ['transactioncount', 'attLogs'],
  ['ipaddress', 'ip'],
  ['mac', 'mac'],
]);

function setInfo(info: AdmsDeviceInfo, field: InfoField, raw: string | undefined) {
  if (NUMERIC_INFO.has(field)) {
    const n = int(raw);
    if (n !== null && n >= 0) (info as Record<string, number>)[field] = n;
    return;
  }
  const v = clean(field === 'firmware' ? raw?.replace(/^\s*Ver\s*/i, '') : raw, field === 'ip' ? 45 : 60);
  if (v && (field !== 'ip' || /^[0-9a-fA-F.:]+$/.test(v))) (info as Record<string, string>)[field] = v;
}

/**
 * Command results (`POST /iclock/devicecmd`): `ID=..&Return=..&CMD=..` per command (file commands
 * put each field on its own line instead). An INFO reply is followed by `Key=Value` lines
 * describing the device; only an allowlist of those is kept.
 */
export function parseCommandReplies(body: string): AdmsCommandReply[] {
  const replies: AdmsCommandReply[] = [];
  for (const line of admsLines(body)) {
    const fields: Record<string, string> = {};
    for (const part of line.split('&')) {
      const i = part.indexOf('=');
      if (i > 0) fields[part.slice(0, i).trim().toLowerCase()] = part.slice(i + 1).trim();
    }
    if (fields.id !== undefined) {
      replies.push({ id: fields.id, returnCode: int(fields.return), cmd: clean(fields.cmd, 40), info: {} });
      continue;
    }
    const last = replies.at(-1);
    const i = line.indexOf('=');
    if (!last || i <= 0) continue;
    const key = line.slice(0, i).trim().toLowerCase();
    const value = line.slice(i + 1);
    if (key === 'return' && last.returnCode === null) last.returnCode = int(value);
    else if (key === 'cmd' && !last.cmd) last.cmd = clean(value, 40);
    else {
      const field = INFO_KEYS.get(key);
      if (field) setInfo(last.info, field, value);
    }
  }
  return replies;
}

/** `POST /iclock/cdata?table=options`: the device's settings as `key=value,key=value…`. */
export function parseOptionsUpload(body: string): AdmsDeviceInfo {
  const info: AdmsDeviceInfo = {};
  for (const pair of body.slice(0, 20_000).split(/[,\n]/)) {
    const i = pair.indexOf('=');
    const field = i > 0 ? INFO_KEYS.get(pair.slice(0, i).trim().toLowerCase()) : undefined;
    if (field) setInfo(info, field, pair.slice(i + 1));
  }
  return info;
}

/**
 * `INFO` query parameter of `GET /iclock/getrequest`:
 * `firmware,users,fingerprints,attLogs,ip,fpAlg,faceAlg,facesRequired,faces,functions`.
 */
export function parseGetrequestInfo(value: unknown): AdmsDeviceInfo | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const f = value.slice(0, 300).split(',');
  const info: AdmsDeviceInfo = {};
  setInfo(info, 'firmware', f[0]);
  setInfo(info, 'users', f[1]);
  setInfo(info, 'fingerprints', f[2]);
  setInfo(info, 'attLogs', f[3]);
  setInfo(info, 'ip', f[4]);
  setInfo(info, 'faces', f[8]);
  return info;
}

/**
 * Handshake `TimeZone`: whole hours when the offset is a whole hour under 12, otherwise minutes
 * (e.g. 330 for UTC+05:30).
 */
export function admsTimeZone(offsetMinutes: number): number {
  return offsetMinutes % 60 === 0 && Math.abs(offsetMinutes) < 720 ? offsetMinutes / 60 : offsetMinutes;
}

/**
 * Handshake reply (`GET /iclock/cdata?options=all`). Asks for attendance logs, operation logs and
 * user records only: never photos, fingerprint images or biometric templates.
 */
export function admsHandshake(o: {
  serial: string;
  attlogStamp?: string | null;
  operlogStamp?: string | null;
  utcOffsetMinutes: number;
}): string {
  return [
    `GET OPTION FROM: ${o.serial}`,
    `ATTLOGStamp=${o.attlogStamp ?? 'None'}`,
    `OPERLOGStamp=${o.operlogStamp ?? '9999'}`,
    'ATTPHOTOStamp=None',
    'ErrorDelay=60',
    'Delay=30',
    'TransTimes=00:00;14:05',
    'TransInterval=1',
    'TransFlag=TransData AttLog\tOpLog\tEnrollUser\tChgUser',
    `TimeZone=${admsTimeZone(o.utcOffsetMinutes)}`,
    'Realtime=1',
    'Encrypt=None',
    `ServerVer=${ADMS_PROTOCOL_VERSION}`,
    `PushProtVer=${ADMS_PROTOCOL_VERSION}`,
    'SupportPing=1',
  ].join('\n');
}

export type AdmsCommand =
  | { kind: 'sync_clock' }
  | { kind: 'device_info' }
  | { kind: 'fetch_users' }
  | { kind: 'fetch_user'; pin: string }
  | { kind: 'fetch_logs'; from: string; to: string };

/**
 * Command text for `C:<id>:<command>`. `fetch_logs` dates are device wall-clock `YYYY-MM-DD`.
 * Clock sync reloads options: the device re-handshakes and takes the time from the `Date` header.
 */
export function buildAdmsCommand(cmd: AdmsCommand): string {
  switch (cmd.kind) {
    case 'sync_clock':
      return 'RELOAD OPTIONS';
    case 'device_info':
      return 'INFO';
    case 'fetch_users':
      return 'CHECK';
    case 'fetch_user':
      if (!ADMS_PIN.test(cmd.pin)) throw new Error('Invalid PIN');
      return `DATA QUERY USERINFO PIN=${cmd.pin}`;
    case 'fetch_logs': {
      const from = parseAdmsTime(`${cmd.from} 00:00:00`);
      const to = parseAdmsTime(`${cmd.to} 23:59:59`);
      if (!from || !to) throw new Error('Invalid date range');
      return `DATA QUERY ATTLOG StartTime=${formatAdmsTime(from)}\tEndTime=${formatAdmsTime(to)}`;
    }
  }
}

/** `C:<id>:<command>` lines for `GET /iclock/getrequest`, or `OK` when nothing is queued. */
export function formatAdmsCommands(commands: { cmdId: string; command: string }[]): string {
  return commands.length ? commands.map((c) => `C:${c.cmdId}:${c.command}`).join('\n') : 'OK';
}

/** Punch instant: device wall-clock time read in the device's time zone. */
export function admsPunchTime(record: AdmsWallTime, timeZone: string): Date {
  return zonedDateTimeToUtc(record.date, record.time, timeZone);
}

export interface AdmsPushPayload {
  serial: string;
  /** ATTLOG body. */
  body: string;
}

/** ADMS as a `BiometricAdapter`: turns an ATTLOG body into punches (malformed lines are skipped). */
export class AdmsBiometricAdapter implements BiometricAdapter {
  readonly name = 'adms';
  async parsePush(payload: unknown, opts: BiometricParseOptions = {}): Promise<BiometricPunch[]> {
    const { serial, body } = (payload ?? {}) as Partial<AdmsPushPayload>;
    if (typeof serial !== 'string' || typeof body !== 'string') return [];
    return parseAttlog(body).records.map((r) => ({
      deviceSerial: serial,
      enrolmentId: r.pin,
      punchedAt: admsPunchTime(r, opts.timeZone ?? 'UTC'),
      direction: admsDirection(r.status),
    }));
  }
}

export const admsAdapter = new AdmsBiometricAdapter();
