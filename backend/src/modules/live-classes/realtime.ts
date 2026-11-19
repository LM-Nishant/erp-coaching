import type { Server as HttpServer } from 'node:http';
import { Server, type Namespace, type Socket } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  LIVE_CLIENT_EVENTS as C,
  LIVE_SERVER_EVENTS as S,
  LIVE_SOCKET_NAMESPACE,
  LIVE_SOCKET_PATH,
  type LiveRole,
  type LiveRoomState,
  type LiveUserRef,
  type WhiteboardStroke,
} from '@erp/shared';
import { config } from '../../infrastructure/config';
import { logger } from '../../infrastructure/logger';
import { newRedisConnection, type RedisClient } from '../../infrastructure/redis';
import { runWithContext, hasPermission, type RequestContext } from '../../shared/context';
import { authenticate, recheckSession } from '../../shared/middleware/authenticate';
import { AppError, Conflict, Forbidden, TooManyRequests } from '../../shared/errors';
import { parse } from '../../shared/utilities/validation';
import { isModuleEnabled } from '../subscriptions/subscription.service';
import { User } from '../users/user.model';
import * as svc from './live-classes.service';
import { setRealtimeBridge } from './realtime-bridge';
import { createRoomStore, type RoomExtras, type RoomStore } from './room-store';

/**
 * Socket.IO signalling + classroom interaction for live classes.
 *
 * - Auth: the handshake carries the normal access token (`auth.token`) and optional `auth.branchId`;
 *   it goes through the same `authenticate` checks as REST (revoked / idle device → 401 first, membership,
 *   branch, then the tenant request guards: a suspended subscription → 402, a read-only one may join since the
 *   handshake counts as a read), plus the `live-classes.view` permission and the plan's module switch.
 * - Open sockets are re-checked with `recheckSession` every minute and when an institute's subscription or status
 *   changes (`recheckLiveSockets`): a revoked or idle device, an inactive user or institute and a suspended
 *   subscription drop them. A revoked device's sockets are dropped at once (`disconnectDeviceSockets`).
 * - Every event handler runs inside the socket's request context, so tenant-scoped repositories work.
 * - Several API instances: with REDIS_URL set, the Socket.IO Redis adapter carries broadcasts and the room's
 *   hands, speakers, screen share and whiteboard live in Redis (`room-store.ts`). Who is in a room is read from
 *   its sockets (`fetchSockets`), so nothing goes stale when an instance stops. The long-polling fallback needs
 *   sticky sessions (docs/deployment.md).
 */

interface SocketData {
  ctx: RequestContext;
  user: LiveUserRef;
  liveSessionId?: number;
  role?: LiveRole;
  /** The joined class's teacher. */
  hostUserId?: number;
  chatBudget: { tokens: number; at: number };
}
type LiveSocket = Socket<Record<string, never>, Record<string, never>, Record<string, never>, SocketData>;
/** A socket on this or another instance, as returned by `fetchSockets`. */
interface PeerSocket {
  id: string;
  data: Partial<SocketData>;
  disconnect(close?: boolean): unknown;
}

const MAX_POINTS = 4000;
const CHAT_BURST = 5;
const CHAT_REFILL_MS = 1000;
export const RECHECK_INTERVAL_MS = 60_000;
const EMPTY_EXTRAS: RoomExtras = {
  hands: [],
  speakers: [],
  screenSharing: false,
  whiteboard: { visible: false, strokes: [] },
};

const roomName = (inst: number, id: number) => `room:${inst}:${id}`;
const userRoom = (inst: number, id: number, userId: number) => `user:${inst}:${id}:${userId}`;
const deviceRoom = (deviceId: number) => `device:${deviceId}`;
const instituteRoom = (inst: number) => `inst:${inst}`;

const PEERS_TIMEOUT_MS = 2000;
const warnedAt = new Map<string, number>();
/** Logs at most one warning a minute per kind (Redis outages repeat on every event). */
function warnOnce(kind: string, err: unknown, msg: string) {
  if (Date.now() - (warnedAt.get(kind) ?? 0) < 60_000) return;
  warnedAt.set(kind, Date.now());
  logger.warn({ err }, msg);
}

/**
 * The sockets in a room on every instance. When the other instances don't answer in time (Redis is
 * unreachable), this instance's: each instance keeps its classes going until Redis is back.
 */
async function socketsIn(nsp: Namespace, room: string): Promise<PeerSocket[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('no answer from the other API instances')), PEERS_TIMEOUT_MS);
  });
  try {
    return (await Promise.race([nsp.in(room).fetchSockets(), timeout])) as unknown as PeerSocket[];
  } catch (err) {
    warnOnce('peers', err, 'Live sockets: other API instances unreachable; using this instance only');
    return (await nsp.in(room).local.fetchSockets()) as unknown as PeerSocket[];
  } finally {
    clearTimeout(timer);
  }
}

/** The adapter doesn't handle a failed publish (Redis down): log it instead of an unhandled rejection. */
function quietPublish(pub: RedisClient): RedisClient {
  const publish = pub.publish.bind(pub);
  (pub as unknown as { publish: (channel: string, message: string) => Promise<number> }).publish = (
    channel,
    message,
  ) =>
    publish(channel, message).catch((err: unknown) => {
      warnOnce('publish', err, 'Live sockets: Redis publish failed; other instances miss this event');
      return 0;
    });
  return pub;
}

/**
 * Runs the joins and leaves of one user in one class on this instance one after another, so the
 * first socket in and the last socket out are counted once.
 */
const queues = new Map<string, Promise<void>>();
function serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const run = (queues.get(key) ?? Promise.resolve()).then(fn);
  const done = run.then(
    () => undefined,
    () => undefined,
  );
  queues.set(key, done);
  void done.then(() => {
    if (queues.get(key) === done) queues.delete(key);
  });
  return run;
}

/* ------------------------------------------------------------------ payload schemas */

const sid = z.object({ sessionId: z.number().int().positive() });
const chatSchema = z.object({ body: z.string().trim().min(1).max(1000) });
const idSchema = z.object({ id: z.number().int().positive() });
const answerSchema = idSchema.extend({ answered: z.boolean().default(true) });
const pollSchema = z.object({
  question: z.string().trim().min(1).max(300),
  options: z.array(z.string().trim().min(1).max(120)).min(2).max(6),
});
const voteSchema = idSchema.extend({ optionIndex: z.number().int().min(0).max(5) });
const userSchema = z.object({ userId: z.number().int().positive() });
const signalSchema = z.object({
  to: z.number().int().positive(),
  description: z
    .object({
      type: z.enum(['offer', 'answer', 'pranswer', 'rollback']),
      sdp: z.string().max(200_000).optional(),
    })
    .optional(),
  candidate: z.unknown().optional(),
});
const screenSchema = z.object({ sharing: z.boolean() });
const strokeSchema = z.object({
  id: z.string().min(1).max(64),
  tool: z.enum(['pen', 'eraser']),
  color: z.string().regex(/^#[0-9a-fA-F]{3,8}$/),
  width: z.number().min(0.5).max(80),
  points: z
    .array(z.number().min(-0.1).max(1.1))
    .min(2)
    .max(MAX_POINTS)
    .refine((p) => p.length % 2 === 0),
});
const visibleSchema = z.object({ visible: z.boolean() });

/* ------------------------------------------------------------------ server */

let io: Server | null = null;
let recheckTimer: ReturnType<typeof setInterval> | null = null;
let rechecking = false;

export function getLiveNamespace(): Namespace | null {
  return io?.of(LIVE_SOCKET_NAMESPACE) ?? null;
}

export function attachLiveSockets(server: HttpServer): Server {
  const pub = newRedisConnection('live-pub');
  const sub = newRedisConnection('live-sub');
  io = new Server(server, {
    path: LIVE_SOCKET_PATH,
    cors: { origin: config.corsOrigins, credentials: true },
    maxHttpBufferSize: 1e6,
    ...(pub && sub ? { adapter: createAdapter(quietPublish(pub), sub) } : {}),
  });
  const rooms = createRoomStore();
  const nsp = io.of(LIVE_SOCKET_NAMESPACE);

  nsp.use((socket, next) => {
    void authenticateSocket(socket as unknown as LiveSocket).then(
      () => next(),
      (err: unknown) => {
        const e =
          err instanceof AppError ? err : new AppError(401, 'UNAUTHENTICATED', 'Authentication failed');
        const out = new Error(e.message) as Error & { data?: unknown };
        out.data = { code: e.code, status: e.status };
        next(out);
      },
    );
  });

  nsp.on('connection', (raw) => {
    const socket = raw as unknown as LiveSocket;
    const { deviceId, instituteId } = socket.data.ctx;
    void socket.join([deviceRoom(deviceId!), instituteRoom(instituteId!)]);
    registerHandlers(nsp, socket, rooms);
  });

  setRealtimeBridge({
    sessionEnded: (inst, id) => {
      // Sockets that were in the room find out on their next event (`current`), on every instance.
      nsp.to(roomName(inst, id)).emit(S.sessionEnded, { sessionId: id });
      nsp.in(roomName(inst, id)).socketsLeave(roomName(inst, id));
      rooms.drop(roomName(inst, id)).catch((err) => logger.warn({ err }, 'live room state not dropped'));
    },
  });

  if (recheckTimer) clearInterval(recheckTimer);
  recheckTimer = setInterval(() => {
    if (rechecking) return;
    rechecking = true;
    recheckLiveSockets()
      .catch((err) => logger.error({ err }, 'live socket re-check failed'))
      .finally(() => (rechecking = false));
  }, RECHECK_INTERVAL_MS);
  recheckTimer.unref();
  return io;
}

/** Disconnects the live-class sockets opened from a device (it was revoked), on every instance. */
export function disconnectDeviceSockets(deviceId: number): void {
  getLiveNamespace()?.in(deviceRoom(deviceId)).disconnectSockets(true);
}

/**
 * Re-checks open sockets with `recheckSession` and drops those it refuses: this instance's sockets
 * (every minute), or an institute's sockets on every instance (when its subscription or status
 * changed). Returns how many were dropped. A database error keeps the socket.
 */
export async function recheckLiveSockets(instituteId?: number): Promise<number> {
  const nsp = getLiveNamespace();
  if (!nsp) return 0;
  const sockets: PeerSocket[] =
    instituteId === undefined ? [...nsp.sockets.values()] : await socketsIn(nsp, instituteRoom(instituteId));
  const verdicts = new Map<string, Promise<boolean>>();
  let dropped = 0;
  for (const socket of sockets) {
    const ctx = socket.data.ctx;
    if (!ctx) continue;
    const key = `${ctx.deviceId}:${ctx.instituteId}:${ctx.activeBranchId ?? ''}:${ctx.impersonationSessionId ?? ''}`;
    let allowed = verdicts.get(key);
    if (!allowed) {
      // A socket on another instance carries a serialised copy (no Set); the access is recomputed anyway.
      const scope: RequestContext = { ...ctx, permissions: new Set() };
      allowed = runWithContext(scope, () => stillAllowed(scope));
      verdicts.set(key, allowed);
    }
    if (await allowed) continue;
    socket.disconnect(true);
    dropped++;
  }
  return dropped;
}

/** The handshake's checks again (see `recheckSession`); a database error keeps the socket. */
async function stillAllowed(ctx: RequestContext): Promise<boolean> {
  try {
    const access = await recheckSession(ctx);
    if (!access || !ctx.instituteId) return false;
    if (!(ctx.isSuperAdmin && !ctx.impersonatorId) && !access.permissions.has(`${svc.MODULE}.view`))
      return false;
    return await isModuleEnabled(ctx.instituteId, svc.MODULE);
  } catch (err) {
    if (err instanceof AppError) return false;
    logger.warn({ err }, 'live socket re-check skipped');
    return true;
  }
}

/** Closes the Socket.IO server (tests / graceful shutdown). */
export async function closeLiveSockets() {
  const s = io;
  io = null;
  if (recheckTimer) clearInterval(recheckTimer);
  recheckTimer = null;
  if (s) await new Promise<void>((resolve) => s.close(() => resolve()));
}

async function authenticateSocket(socket: LiveSocket) {
  const { token, branchId } = (socket.handshake.auth ?? {}) as { token?: unknown; branchId?: unknown };
  const ctx: RequestContext = {
    requestId: `ws-${socket.id}`,
    ip: socket.handshake.address,
    userAgent: socket.handshake.headers['user-agent'],
  };
  const headers: Record<string, string | undefined> = {
    authorization: typeof token === 'string' ? `Bearer ${token}` : undefined,
    'x-branch-id': branchId != null && branchId !== '' ? String(branchId) : undefined,
  };
  const fakeReq = { ctx, header: (n: string) => headers[n.toLowerCase()] } as unknown as Request;
  await runWithContext(ctx, () => authenticate(fakeReq, {} as Response, () => {}));
  await runWithContext(ctx, async () => {
    if (!ctx.instituteId) throw Forbidden('Select an institute first', 'INSTITUTE_REQUIRED');
    if (!hasPermission(`${svc.MODULE}.view`)) throw Forbidden();
    if (!(await isModuleEnabled(ctx.instituteId, svc.MODULE)))
      throw Forbidden('Live classes are not part of your plan', 'MODULE_DISABLED');
  });
  const user = await User.findByPk(ctx.userId, { attributes: ['id', 'name'] });
  socket.data = {
    ctx,
    user: { id: ctx.userId!, name: user?.name ?? '' },
    chatBudget: { tokens: CHAT_BURST, at: Date.now() },
  };
  // Not needed any more; `fetchSockets` would otherwise copy it to other instances.
  delete (socket.handshake.auth as { token?: unknown }).token;
}

/* ------------------------------------------------------------------ handlers */

type Ack = (res: unknown) => void;

function registerHandlers(nsp: Namespace, socket: LiveSocket, rooms: RoomStore) {
  const inst = socket.data.ctx.instituteId!;
  const userId = socket.data.user.id;

  /** Wraps a handler: tenant context, validation errors → `{ok:false}` ack, never throws. */
  const on = (event: string, fn: (payload: unknown) => Promise<unknown>) => {
    (socket as unknown as Socket).on(event, (payload: unknown, ack?: Ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      runWithContext({ ...socket.data.ctx }, () => fn(payload ?? {})).then(
        (data) => reply({ ok: true, data }),
        (err: unknown) => {
          if (!(err instanceof AppError)) logger.error({ err, event }, 'Live socket handler failed');
          const e = err instanceof AppError ? err : new AppError(500, 'INTERNAL', 'Something went wrong');
          reply({ ok: false, error: { code: e.code, message: e.message } });
        },
      );
    });
  };

  /**
   * The class this socket is in, or null. An ended class empties its room on every instance, so a
   * socket that is no longer in the room has left it whatever its data says.
   */
  const joined = () => {
    const id = socket.data.liveSessionId;
    const role = socket.data.role;
    if (id && role && socket.rooms.has(roomName(inst, id))) return { id, role, name: roomName(inst, id) };
    if (id) {
      socket.data.liveSessionId = undefined;
      socket.data.role = undefined;
      void socket.leave(userRoom(inst, id, userId));
    }
    return null;
  };
  /** The class this socket joined (throws when it has not joined one). */
  const current = () => {
    const j = joined();
    if (!j) throw Conflict('Join a live class first', 'NOT_JOINED');
    return j;
  };
  const requireModerator = (role: LiveRole) => {
    if (role === 'student') throw Forbidden('Only the teacher can do this', 'NOT_CLASS_TEACHER');
  };
  const requireHost = (role: LiveRole) => {
    if (role !== 'host') throw Forbidden('Only the class teacher can do this', 'NOT_CLASS_TEACHER');
  };
  const broadcastHands = (name: string, hands: LiveUserRef[]) => nsp.to(name).emit(S.handsUpdate, hands);
  const broadcastSpeakers = (name: string, speakers: LiveUserRef[]) =>
    nsp.to(name).emit(S.speakersUpdate, speakers);

  /**
   * Leaves the current class. The first part runs at once, while a disconnecting socket is still in
   * its rooms; the user counts as left when no socket of theirs is in the class on any instance.
   */
  function leaveCurrent(): Promise<void> {
    const j = joined();
    if (!j) return Promise.resolve();
    const { id, role, name } = j;
    socket.data.liveSessionId = undefined;
    socket.data.role = undefined;
    void socket.leave(name);
    void socket.leave(userRoom(inst, id, userId));
    return serial(`${inst}:${id}:${userId}`, async () => {
      const others = await socketsIn(nsp, userRoom(inst, id, userId));
      if (others.some((s) => s.id !== socket.id)) return;
      await svc.markLeft(id, userId).catch((err) => logger.warn({ err }, 'live markLeft failed'));
      nsp.to(name).emit(S.participantLeft, { userId, role });
      if (role === 'host') {
        // The class has one host: the session's teacher.
        nsp.to(name).emit(S.hostState, { online: false });
        nsp.to(name).emit(S.screenState, { sharing: false });
        await rooms.setScreenSharing(name, false);
      }
      const hands = await rooms.lowerHand(name, userId);
      if (hands.removed) broadcastHands(name, hands.hands);
      const speakers = await rooms.revokeMic(name, userId);
      if (speakers.removed) broadcastSpeakers(name, speakers.speakers);
      if (!(await socketsIn(nsp, name)).length && !(await rooms.hasStrokes(name))) await rooms.drop(name);
    });
  }

  on(C.join, async (payload) => {
    const { sessionId } = parse(sid, payload);
    const { session, role } = await svc.loadSession(sessionId);
    if (session.status !== 'live') throw Conflict(`The class is ${session.status}`, 'NOT_LIVE');
    if (socket.data.liveSessionId && socket.data.liveSessionId !== sessionId) await leaveCurrent();

    const name = roomName(inst, sessionId);
    const mine = userRoom(inst, sessionId, userId);
    const firstSocket = await serial(`${inst}:${sessionId}:${userId}`, async () => {
      const first = !(await socketsIn(nsp, mine)).length;
      socket.data.liveSessionId = sessionId;
      socket.data.role = role;
      socket.data.hostUserId = session.teacherUserId;
      await socket.join([name, mine]);
      return first;
    });

    if (firstSocket) {
      await svc.markJoined(sessionId, userId, role);
      socket.to(name).emit(S.participantJoined, { ...socket.data.user, role });
      if (role === 'host') socket.to(name).emit(S.hostState, { online: true });
    }

    const [participants, chat, questions, polls, online, extras] = await Promise.all([
      svc.listParticipants(sessionId),
      svc.listChat(sessionId),
      svc.listQuestions(sessionId),
      svc.listPolls(sessionId),
      socketsIn(nsp, name),
      // Without the room state (Redis unreachable), the class still has presence, chat, questions and polls.
      rooms.get(name).catch(() => EMPTY_EXTRAS),
    ]);
    const onlineIds = new Set(online.map((s) => s.data.user?.id));
    const state: LiveRoomState = {
      session: svc.toSessionDto(session, role),
      me: { ...socket.data.user, role },
      hostOnline: online.some((s) => s.data.role === 'host'),
      participants: participants.map((p) => ({ ...p, online: onlineIds.has(p.userId) })),
      chat,
      questions,
      polls,
      raisedHands: extras.hands,
      speakers: extras.speakers,
      screenSharing: extras.screenSharing,
      whiteboard: extras.whiteboard,
    };
    return state;
  });

  on(C.leave, async () => {
    await leaveCurrent();
  });

  // `disconnecting`, not `disconnect`: the socket is still in its rooms.
  socket.on('disconnecting', () => {
    void runWithContext({ ...socket.data.ctx }, () => leaveCurrent()).catch((err) =>
      logger.warn({ err }, 'live socket leave failed'),
    );
  });

  /* chat & Q&A */

  on(C.chatSend, async (payload) => {
    const { id, name } = current();
    const b = socket.data.chatBudget;
    const now = Date.now();
    b.tokens = Math.min(CHAT_BURST, b.tokens + (now - b.at) / CHAT_REFILL_MS);
    b.at = now;
    if (b.tokens < 1) throw TooManyRequests('You are sending messages too fast');
    b.tokens -= 1;
    const msg = await svc.postMessage(id, 'chat', parse(chatSchema, payload).body);
    nsp.to(name).emit(S.chatMessage, msg);
    return msg;
  });

  on(C.qaAsk, async (payload) => {
    const { id, name } = current();
    const q = await svc.postMessage(id, 'question', parse(chatSchema, payload).body);
    nsp.to(name).emit(S.qaUpdate, q);
    return q;
  });

  on(C.qaUpvote, async (payload) => {
    const { id, name } = current();
    const q = await svc.toggleUpvote(id, parse(idSchema, payload).id);
    // `upvotedByMe` is per user: broadcast neutral counts, return the caller's own state in the ack.
    socket.to(name).emit(S.qaUpdate, { ...q, upvotedByMe: undefined });
    return q;
  });

  on(C.qaAnswer, async (payload) => {
    const { id, role, name } = current();
    requireModerator(role);
    const { id: qid, answered } = parse(answerSchema, payload);
    const q = await svc.markAnswered(id, qid, answered);
    nsp.to(name).emit(S.qaUpdate, { ...q, upvotedByMe: undefined });
    return q;
  });

  /* polls */

  on(C.pollCreate, async (payload) => {
    const { id, role, name } = current();
    requireModerator(role);
    const { question, options } = parse(pollSchema, payload);
    const poll = await svc.createPoll(id, question, options);
    nsp.to(name).emit(S.pollUpdate, poll);
    return poll;
  });

  on(C.pollVote, async (payload) => {
    const { id, name } = current();
    const { id: pollId, optionIndex } = parse(voteSchema, payload);
    const poll = await svc.votePoll(id, pollId, optionIndex);
    socket.to(name).emit(S.pollUpdate, { ...poll, myVote: undefined });
    return poll;
  });

  on(C.pollClose, async (payload) => {
    const { id, role, name } = current();
    requireModerator(role);
    const poll = await svc.closePoll(id, parse(idSchema, payload).id);
    nsp.to(name).emit(S.pollUpdate, { ...poll, myVote: undefined });
    return poll;
  });

  /* raise hand & microphone */

  on(C.handRaise, async () => {
    const { role, name } = current();
    if (role !== 'student') throw Forbidden('Only students raise hands');
    broadcastHands(name, await rooms.raiseHand(name, socket.data.user));
  });

  on(C.handLower, async (payload) => {
    const { role, name } = current();
    const target = (payload as { userId?: number })?.userId ?? userId;
    if (target !== userId) requireModerator(role);
    broadcastHands(name, (await rooms.lowerHand(name, target)).hands);
  });

  on(C.micGrant, async (payload) => {
    const { id, role, name } = current();
    requireModerator(role);
    const { userId: target } = parse(userSchema, payload);
    const [peer] = await socketsIn(nsp, userRoom(inst, id, target));
    if (!peer?.data.user || peer.data.role !== 'student')
      throw Conflict('That student is not in the class', 'NOT_ONLINE');
    // One student speaks at a time: the teacher's client relays the speaker's audio to the class.
    const { hands, speakers } = await rooms.grantMic(name, peer.data.user);
    broadcastSpeakers(name, speakers);
    broadcastHands(name, hands);
  });

  on(C.micRevoke, async (payload) => {
    const { role, name } = current();
    const { userId: target } = parse(userSchema, payload);
    if (target !== userId) requireModerator(role);
    broadcastSpeakers(name, (await rooms.revokeMic(name, target)).speakers);
  });

  /* WebRTC signalling: only teacher ↔ participant (one-way class stream + granted student mic) */

  on(C.rtcSignal, async (payload) => {
    const { id, role } = current();
    const signal = parse(signalSchema, payload);
    if (role !== 'host' && signal.to !== socket.data.hostUserId)
      throw Forbidden('Media is only exchanged with the teacher');
    // Reaches the target's sockets in this class only (none when they're offline).
    nsp.to(userRoom(inst, id, signal.to)).emit(S.rtcSignal, { ...signal, from: userId });
  });

  on(C.screenState, async (payload) => {
    const { role, name } = current();
    requireHost(role);
    const { sharing } = parse(screenSchema, payload);
    await rooms.setScreenSharing(name, sharing);
    socket.to(name).emit(S.screenState, { sharing });
  });

  /* whiteboard: teacher draws, everyone views */

  on(C.wbStroke, async (payload) => {
    const { role, name } = current();
    requireModerator(role);
    const stroke = parse(strokeSchema, payload) as WhiteboardStroke;
    await rooms.addStroke(name, stroke);
    socket.to(name).emit(S.wbStroke, stroke);
  });

  on(C.wbUndo, async (payload) => {
    const { role, name } = current();
    requireModerator(role);
    const removed = await rooms.undoStroke(name, (payload as { id?: string })?.id);
    if (removed) socket.to(name).emit(S.wbUndo, { id: removed });
  });

  on(C.wbClear, async () => {
    const { role, name } = current();
    requireModerator(role);
    await rooms.clearStrokes(name);
    socket.to(name).emit(S.wbClear, {});
  });

  on(C.wbVisible, async (payload) => {
    const { role, name } = current();
    requireModerator(role);
    const { visible } = parse(visibleSchema, payload);
    await rooms.setWhiteboardVisible(name, visible);
    socket.to(name).emit(S.wbVisible, { visible });
  });
}
