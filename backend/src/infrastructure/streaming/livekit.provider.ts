import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import jwt from 'jsonwebtoken';
import { presignS3Url, type S3Location } from './s3-presign';
import {
  WebhookSignatureError,
  type IceServer,
  type JoinCredentials,
  type LiveRoom,
  type ProviderRecording,
  type StartRecordingResult,
  type StreamingProvider,
  type StreamingRole,
  type StreamingWebhookEvent,
} from './types';

export interface LiveKitOptions {
  /** URL clients connect to (`wss://…`). */
  url: string;
  /** Server API base when it differs from `url` (http(s) or ws(s)). */
  apiUrl?: string;
  apiKey: string;
  apiSecret: string;
  roomPrefix: string;
  recording: { output: 'local'; egressDir: string; localDir: string } | ({ output: 's3' } & S3Location);
  /** Injected in tests; defaults to the global fetch. */
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** LiveKit video grant (https://docs.livekit.io/home/get-started/authentication/). */
interface VideoGrant {
  room?: string;
  roomJoin?: boolean;
  roomCreate?: boolean;
  roomList?: boolean;
  roomRecord?: boolean;
  roomAdmin?: boolean;
  canPublish?: boolean;
  canSubscribe?: boolean;
  canPublishData?: boolean;
  canPublishSources?: string[];
  canUpdateOwnMetadata?: boolean;
}

export class LiveKitApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const JOIN_TOKEN_MAX_TTL_SECONDS = 15 * 60;
const IDENTITY = /^user-(\d{1,10})$/;
const LOCAL_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/;
const S3_PREFIX = 'livekit-recordings/';
const OK_EGRESS = new Set(['EGRESS_COMPLETE', 'EGRESS_LIMIT_REACHED']);
const ACTIVE_EGRESS = new Set(['EGRESS_STARTING', 'EGRESS_ACTIVE']);

/** Twirp JSON may use proto (snake_case) or JSON (camelCase) field names. */
type Json = Record<string, unknown>;
const field = (o: unknown, name: string): unknown => {
  if (!o || typeof o !== 'object') return undefined;
  const r = o as Json;
  return r[name] ?? r[name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)];
};
const str = (o: unknown, name: string) => {
  const v = field(o, name);
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';
};
const num = (o: unknown, name: string) => {
  const v = Number(field(o, name));
  return Number.isFinite(v) ? v : 0;
};
/** EgressInfo.status: proto3 JSON omits the zero value (EGRESS_STARTING). */
const egressStatus = (info: unknown) => str(info, 'status') || 'EGRESS_STARTING';

/** Role and device from the metadata our join token gave a participant (participants cannot change it). */
function tokenMetadata(participant: unknown): { role?: string; deviceId?: number } {
  try {
    const m = JSON.parse(str(participant, 'metadata') || '{}') as { role?: unknown; deviceId?: unknown };
    const deviceId =
      Number.isSafeInteger(m.deviceId) && (m.deviceId as number) > 0 ? (m.deviceId as number) : undefined;
    return { role: typeof m.role === 'string' ? m.role : undefined, deviceId };
  } catch {
    return {};
  }
}

const ROLE_GRANTS: Record<StreamingRole, Omit<VideoGrant, 'room' | 'roomJoin'>> = {
  host: {
    canSubscribe: true,
    canPublish: true,
    canPublishSources: ['camera', 'microphone', 'screen_share', 'screen_share_audio'],
    canPublishData: false,
  },
  // A student the teacher allowed to speak (the grant is normally given live with UpdateParticipant).
  speaker: { canSubscribe: true, canPublish: true, canPublishSources: ['microphone'], canPublishData: false },
  moderator: { canSubscribe: true, canPublish: false, canPublishData: false },
  viewer: { canSubscribe: true, canPublish: false, canPublishData: false },
};

/**
 * LiveKit SFU adapter (self-hosted `livekit-server` or LiveKit Cloud: same API).
 *
 * - Rooms are named `<prefix>-<instituteId>-<liveSessionId>`, so signed webhooks map back to the tenant.
 * - Join tokens carry per-role grants: the class teacher publishes camera, microphone and screen; everyone
 *   else only subscribes until the teacher grants a student's microphone (`setParticipantPublish`).
 * - The identity is `user-<id>`; the token's metadata names the role and the device it was issued to, so a
 *   device that signs out or is revoked can be removed from the room (`removeParticipant`).
 * - Recording uses Egress (room composite, MP4). Self-hosted Egress writes to a directory shared with the
 *   API (`local`); LiveKit Cloud uploads to an S3 staging bucket (`s3`). The API imports each finished
 *   file into its own storage, then deletes the staged copy.
 * - Presence and recordings arrive as webhooks (`parseWebhook`), signed with the API key/secret.
 *
 * Talks to the server API (Twirp JSON over HTTP) with `fetch`; no SDK dependency.
 */
export class LiveKitStreamingProvider implements StreamingProvider {
  readonly name = 'livekit';
  readonly transport = 'vendor-sdk' as const;
  readonly reportsPresence = true;
  private readonly apiBase: string;
  private readonly http: typeof fetch;

  constructor(private readonly opts: LiveKitOptions) {
    this.apiBase = (opts.apiUrl || opts.url).replace(/^ws(s?):\/\//, 'http$1://').replace(/\/+$/, '');
    this.http = opts.fetch ?? ((...args) => fetch(...args));
  }

  /* ------------------------------------------------------------ tokens */

  private sign(claims: Json, ttlSeconds: number): string {
    // nbf 0 like the official SDKs: clocks of the API and LiveKit servers may differ slightly.
    return jwt.sign({ ...claims, nbf: 0 }, this.opts.apiSecret, {
      algorithm: 'HS256',
      issuer: this.opts.apiKey,
      expiresIn: ttlSeconds,
    });
  }

  roomName(instituteId: number, sessionId: string) {
    return `${this.opts.roomPrefix}-${instituteId}-${sessionId}`;
  }

  /** Live class of a room this deployment created, or null. */
  parseRoomName(roomId: string): { instituteId: number; liveSessionId: number } | null {
    const m = new RegExp(`^${this.opts.roomPrefix}-(\\d{1,10})-(\\d{1,10})$`).exec(roomId);
    return m ? { instituteId: Number(m[1]), liveSessionId: Number(m[2]) } : null;
  }

  async issueJoinToken(input: {
    roomId: string;
    userId: number;
    deviceId: number;
    displayName: string;
    role: StreamingRole;
    ttlSeconds: number;
  }): Promise<JoinCredentials> {
    // Only the first connection uses this token: LiveKit hands connected clients refreshed tokens
    // for reconnects, so a short lifetime limits a leaked token without cutting long classes.
    const ttlSeconds = Math.min(input.ttlSeconds, JOIN_TOKEN_MAX_TTL_SECONDS);
    const token = this.sign(
      {
        sub: `user-${input.userId}`,
        name: input.displayName,
        metadata: JSON.stringify({ role: input.role, deviceId: input.deviceId }),
        video: {
          room: input.roomId,
          roomJoin: true,
          canUpdateOwnMetadata: false,
          ...ROLE_GRANTS[input.role],
        } satisfies VideoGrant,
      },
      ttlSeconds,
    );
    return { token, url: this.opts.url, expiresAt: new Date(Date.now() + ttlSeconds * 1000) };
  }

  iceServers(): IceServer[] {
    // The LiveKit SDK gets STUN/TURN servers from the LiveKit server itself.
    return [];
  }

  /* ------------------------------------------------------------ server API (Twirp) */

  private async api<T = Json>(
    service: 'RoomService' | 'Egress',
    method: string,
    body: Json,
    grant: VideoGrant,
  ): Promise<T> {
    let res: Response;
    try {
      res = await this.http(`${this.apiBase}/twirp/livekit.${service}/${method}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.sign({ video: grant }, 600)}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 15_000),
      });
    } catch (err) {
      throw new LiveKitApiError(0, 'unreachable', `LiveKit ${method}: ${(err as Error).message}`);
    }
    const text = await res.text();
    if (!res.ok) {
      let code = `http_${res.status}`;
      let msg = text.slice(0, 200);
      try {
        const e = JSON.parse(text) as { code?: string; msg?: string };
        code = e.code ?? code;
        msg = e.msg ?? msg;
      } catch {
        /* not a Twirp error body */
      }
      throw new LiveKitApiError(res.status, code, `LiveKit ${method}: ${msg}`);
    }
    return (text ? JSON.parse(text) : {}) as T;
  }

  async createRoom(input: { sessionId: string; title: string; instituteId: number }): Promise<LiveRoom> {
    const name = this.roomName(input.instituteId, input.sessionId);
    // Teachers may drop off briefly: keep the room (and its recording) for two minutes after the last leaves.
    await this.api(
      'RoomService',
      'CreateRoom',
      { name, emptyTimeout: 600, departureTimeout: 120 },
      {
        roomCreate: true,
      },
    );
    return { roomId: name, hostUrl: null };
  }

  /**
   * A directory (trailing `/`): Egress names the file `<room>-<YYYY-MM-DDTHHMMSS>.mp4` itself, adding
   * `-<n>` when it retries a failed recording (explicit file names can't be retried). No `<egressId>.json`
   * manifest: only the MP4 is imported and deleted, so a manifest would be left behind.
   */
  private egressOutput(): Json {
    const rec = this.opts.recording;
    if (rec.output === 'local')
      return { fileType: 'MP4', filepath: `${rec.egressDir.replace(/\/+$/, '')}/`, disableManifest: true };
    return {
      fileType: 'MP4',
      filepath: S3_PREFIX,
      disableManifest: true,
      s3: {
        accessKey: rec.accessKey,
        secret: rec.secretKey,
        region: rec.region,
        bucket: rec.bucket,
        ...(rec.endpoint ? { endpoint: rec.endpoint } : {}),
        forcePathStyle: !!rec.forcePathStyle,
      },
    };
  }

  private async listEgress(roomId: string, active?: boolean): Promise<unknown[]> {
    const res = await this.api(
      'Egress',
      'ListEgress',
      { roomName: roomId, ...(active ? { active } : {}) },
      {
        roomRecord: true,
      },
    );
    const items = field(res, 'items');
    return Array.isArray(items) ? items : [];
  }

  /** Starts a room composite Egress unless one is already running for the room (safe to call again). */
  async startRecording(roomId: string): Promise<StartRecordingResult> {
    const running = (await this.listEgress(roomId, true)).find((e) => ACTIVE_EGRESS.has(egressStatus(e)));
    if (running) return { mode: 'provider', recordingId: str(running, 'egressId') || null };
    const info = await this.api(
      'Egress',
      'StartRoomCompositeEgress',
      { roomName: roomId, layout: 'speaker', fileOutputs: [this.egressOutput()] },
      { roomRecord: true },
    );
    return { mode: 'provider', recordingId: str(info, 'egressId') || null };
  }

  /**
   * Stops recording and closes the room (disconnecting everyone). Files are finalised asynchronously
   * and arrive with the `egress_ended` webhook (or `listRecordings`), so none are returned here.
   */
  async endRoom(roomId: string): Promise<{ recordings: ProviderRecording[] }> {
    for (const e of await this.listEgress(roomId, true)) {
      const egressId = str(e, 'egressId');
      if (!egressId || !ACTIVE_EGRESS.has(egressStatus(e))) continue;
      await this.api('Egress', 'StopEgress', { egressId }, { roomRecord: true }).catch((err: unknown) => {
        if (!(err instanceof LiveKitApiError) || err.status >= 500 || err.status === 0) throw err;
      });
    }
    try {
      await this.api('RoomService', 'DeleteRoom', { room: roomId }, { roomCreate: true });
    } catch (err) {
      if (!(err instanceof LiveKitApiError) || err.status !== 404) throw err;
    }
    return { recordings: [] };
  }

  async setParticipantPublish(input: { roomId: string; userId: number; microphone: boolean }) {
    await this.api(
      'RoomService',
      'UpdateParticipant',
      {
        room: input.roomId,
        identity: `user-${input.userId}`,
        permission: input.microphone
          ? { canSubscribe: true, canPublish: true, canPublishData: false, canPublishSources: ['MICROPHONE'] }
          : { canSubscribe: true, canPublish: false, canPublishData: false, canPublishSources: [] },
      },
      { roomAdmin: true, room: input.roomId },
    );
  }

  async removeParticipant(input: { roomId: string; userId: number; deviceId?: number }): Promise<boolean> {
    const who = { room: input.roomId, identity: `user-${input.userId}` };
    const grant = { roomAdmin: true, room: input.roomId };
    try {
      if (input.deviceId !== undefined) {
        const participant = await this.api('RoomService', 'GetParticipant', who, grant);
        if (tokenMetadata(participant).deviceId !== input.deviceId) return false;
      }
      await this.api('RoomService', 'RemoveParticipant', who, grant);
      return true;
    } catch (err) {
      // Not (or no longer) in the room, or the room is gone.
      if (err instanceof LiveKitApiError && err.status === 404) return false;
      throw err;
    }
  }

  async listRecordings(roomId: string): Promise<{ recordings: ProviderRecording[]; pending: number }> {
    const all = await this.listEgress(roomId);
    return {
      recordings: all.map((e) => this.recordingOf(e)).filter((r): r is ProviderRecording => !!r),
      pending: all.filter((e) => ACTIVE_EGRESS.has(egressStatus(e)) || egressStatus(e) === 'EGRESS_ENDING')
        .length,
    };
  }

  /** Recording of a finished Egress, or null when it failed / has no file. */
  private recordingOf(info: unknown): ProviderRecording | null {
    if (!OK_EGRESS.has(egressStatus(info))) return null;
    const results = field(info, 'fileResults');
    const file = (Array.isArray(results) ? results[0] : undefined) ?? field(info, 'file');
    const filename = str(file, 'filename');
    const egressId = str(info, 'egressId');
    if (!file || !filename || !egressId) return null;
    const location = this.opts.recording.output === 'local' ? path.posix.basename(filename) : filename;
    const durationNs = num(file, 'duration');
    return {
      ref: egressId,
      location,
      mimeType: 'video/mp4',
      durationSeconds: durationNs > 0 ? Math.round(durationNs / 1e9) : null,
    };
  }

  /* ------------------------------------------------------------ recording files */

  private localPath(location: string | undefined): string {
    const rec = this.opts.recording;
    if (rec.output !== 'local' || !location || !LOCAL_FILE.test(location))
      throw new Error('Unexpected LiveKit recording location');
    return path.join(rec.localDir, location);
  }

  private s3Url(method: 'GET' | 'DELETE', location: string | undefined) {
    const rec = this.opts.recording;
    const key = (location ?? '').replace(/^\/+/, '');
    if (rec.output !== 's3' || !key.startsWith(S3_PREFIX) || key.includes('..'))
      throw new Error('Unexpected LiveKit recording location');
    return presignS3Url(rec, { method, key, expiresInSeconds: 900 });
  }

  async fetchRecording(rec: ProviderRecording, destPath: string): Promise<void> {
    if (this.opts.recording.output === 'local') {
      await fs.promises.copyFile(this.localPath(rec.location), destPath);
      return;
    }
    const res = await this.http(this.s3Url('GET', rec.location));
    if (!res.ok || !res.body) throw new Error(`Recording download failed: HTTP ${res.status}`);
    await pipeline(
      Readable.fromWeb(res.body as unknown as WebReadableStream<Uint8Array>),
      fs.createWriteStream(destPath),
    );
  }

  async discardRecording(rec: ProviderRecording): Promise<void> {
    if (this.opts.recording.output === 'local') {
      await fs.promises.rm(this.localPath(rec.location), { force: true });
      return;
    }
    const res = await this.http(this.s3Url('DELETE', rec.location), { method: 'DELETE' });
    if (!res.ok && res.status !== 404) throw new Error(`Recording delete failed: HTTP ${res.status}`);
  }

  /* ------------------------------------------------------------ webhooks */

  /**
   * Verifies a LiveKit webhook: the `Authorization` header is a JWT signed with the API secret, issued
   * by the API key, whose `sha256` claim is the base64 SHA-256 of the raw body.
   */
  parseWebhook(rawBody: Buffer, authorization: string | undefined): StreamingWebhookEvent {
    const token = (authorization ?? '').replace(/^Bearer\s+/i, '').trim();
    if (!token) throw new WebhookSignatureError('Missing webhook signature');
    let claims: jwt.JwtPayload;
    try {
      claims = jwt.verify(token, this.opts.apiSecret, {
        algorithms: ['HS256'],
        issuer: this.opts.apiKey,
        clockTolerance: 60,
      }) as jwt.JwtPayload;
    } catch {
      throw new WebhookSignatureError('Invalid webhook signature');
    }
    const expected = Buffer.from(crypto.createHash('sha256').update(rawBody).digest('base64'));
    const got = Buffer.from(typeof claims.sha256 === 'string' ? claims.sha256 : '');
    if (
      typeof claims.exp !== 'number' ||
      got.length !== expected.length ||
      !crypto.timingSafeEqual(got, expected)
    )
      throw new WebhookSignatureError('Webhook body does not match its signature');

    let body: Json;
    try {
      body = JSON.parse(rawBody.toString('utf8')) as Json;
    } catch {
      throw new Error('Malformed webhook body');
    }
    const event = str(body, 'event');
    const id = str(body, 'id');
    const created = num(body, 'createdAt');
    const at = created > 0 ? new Date(created * 1000) : new Date();
    const egress = field(body, 'egressInfo');
    const roomId = str(field(body, 'room'), 'name') || str(egress, 'roomName') || null;
    const target = roomId ? this.parseRoomName(roomId) : null;
    const base = {
      id: id || `${event}:${crypto.createHash('sha256').update(rawBody).digest('hex')}`,
      at,
      target,
    };
    if (!roomId || !target) return { ...base, roomId, kind: 'ignored' };

    switch (event) {
      case 'room_started':
        return { ...base, roomId, kind: 'room-started' };
      case 'room_finished':
        return { ...base, roomId, kind: 'room-finished' };
      case 'participant_joined':
      case 'participant_left':
      case 'participant_connection_aborted': {
        const participant = field(body, 'participant');
        const m = IDENTITY.exec(str(participant, 'identity'));
        if (!m) return { ...base, roomId, kind: 'ignored' };
        const { role, deviceId } = tokenMetadata(participant);
        // An aborted connection never got media through: it may close a visit, never add one.
        const joinedMs =
          event === 'participant_connection_aborted'
            ? 0
            : num(participant, 'joinedAtMs') || num(participant, 'joinedAt') * 1000;
        return {
          ...base,
          roomId,
          kind: event === 'participant_joined' ? 'participant-joined' : 'participant-left',
          userId: Number(m[1]),
          role,
          deviceId,
          connectionRef: str(participant, 'sid').slice(0, 64) || undefined,
          joinedAt: joinedMs > 0 ? new Date(joinedMs) : undefined,
        };
      }
      case 'egress_ended': {
        const recording = this.recordingOf(egress);
        if (recording) return { ...base, roomId, kind: 'recording-finished', recording };
        return {
          ...base,
          roomId,
          kind: 'recording-failed',
          ref: str(egress, 'egressId'),
          error: `${egressStatus(egress)} ${str(egress, 'error')}`.trim(),
        };
      }
      default:
        return { ...base, roomId, kind: 'ignored' };
    }
  }

  /* ------------------------------------------------------------ admin */

  async testConnection(): Promise<{ ok: boolean; message: string }> {
    try {
      const res = await this.api('RoomService', 'ListRooms', {}, { roomList: true });
      const rooms = field(res, 'rooms');
      const active = Array.isArray(rooms) ? rooms.length : 0;
      const storage = await this.checkRecordingStorage();
      return {
        ok: storage.ok,
        message: `Connected to LiveKit at ${this.apiBase} (${active} active room${active === 1 ? '' : 's'}). ${storage.message}`,
      };
    } catch (err) {
      const e = err as LiveKitApiError;
      const hint =
        e.status === 401 || e.code === 'unauthenticated'
          ? ' Check LIVEKIT_API_KEY / LIVEKIT_API_SECRET.'
          : e.status === 0
            ? ' Check LIVEKIT_API_URL / LIVEKIT_URL and that the server is running.'
            : '';
      return { ok: false, message: `${e.message}.${hint}` };
    }
  }

  private async checkRecordingStorage(): Promise<{ ok: boolean; message: string }> {
    const rec = this.opts.recording;
    if (rec.output === 'local') {
      try {
        await fs.promises.access(rec.localDir, fs.constants.R_OK | fs.constants.W_OK);
        return { ok: true, message: 'Recordings directory is readable and writable.' };
      } catch {
        return {
          ok: false,
          message: `The API cannot read and write the recordings directory ${rec.localDir} (LIVEKIT_RECORDINGS_DIR).`,
        };
      }
    }
    try {
      const res = await this.http(
        presignS3Url(rec, {
          method: 'GET',
          key: '',
          expiresInSeconds: 60,
          query: { 'list-type': '2', 'max-keys': '1', prefix: S3_PREFIX },
        }),
      );
      await res.body?.cancel();
      return res.ok
        ? { ok: true, message: `S3 bucket ${rec.bucket} is reachable.` }
        : {
            ok: false,
            message: `S3 bucket ${rec.bucket} answered HTTP ${res.status}; check the LIVEKIT_S3_* settings.`,
          };
    } catch (err) {
      return { ok: false, message: `S3 bucket ${rec.bucket} is unreachable: ${(err as Error).message}` };
    }
  }

  /** Non-secret settings for the admin status page. */
  describe() {
    const rec = this.opts.recording;
    return {
      url: this.opts.url,
      apiUrl: this.apiBase,
      apiKey: this.opts.apiKey.length > 4 ? `${this.opts.apiKey.slice(0, 4)}…` : '…',
      roomPrefix: this.opts.roomPrefix,
      recordingOutput: rec.output,
      recordingLocation: rec.output === 'local' ? rec.localDir : `s3://${rec.bucket}/${S3_PREFIX}`,
    };
  }
}
