import type { Server as HttpServer } from 'node:http';
import { Server, type Namespace, type Socket } from 'socket.io';
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
import { runWithContext, hasPermission, type RequestContext } from '../../shared/context';
import { authenticate } from '../../shared/middleware/authenticate';
import { AppError, Conflict, Forbidden, TooManyRequests } from '../../shared/errors';
import { parse } from '../../shared/utilities/validation';
import { isModuleEnabled } from '../subscriptions/subscription.service';
import { User } from '../users/user.model';
import * as svc from './live-classes.service';
import { setRealtimeBridge } from './realtime-bridge';

/**
 * Socket.IO signalling + classroom interaction for live classes.
 *
 * - Auth: the handshake carries the normal access token (`auth.token`) and optional `auth.branchId`;
 *   it goes through the same `authenticate` checks as REST (revoked / idle device → 401 first, membership,
 *   branch, then the tenant request guards: a suspended subscription → 402, a read-only one may join since the
 *   handshake counts as a read), plus the `live-classes.view` permission and the plan's module switch. Sockets of
 *   a device are dropped when it is revoked (`disconnectDeviceSockets`, from integrations.ts).
 * - Every event handler runs inside the socket's request context, so tenant-scoped repositories work.
 * - Room state that does not need persistence (hands, speakers, whiteboard, screen share) is kept in
 *   memory on this node. Run a single node, or add `@socket.io/redis-adapter` + sticky sessions and
 *   move `rooms` to Redis to scale out (see README).
 */

interface SocketData {
  ctx: RequestContext;
  user: LiveUserRef;
  liveSessionId?: number;
  role?: LiveRole;
  chatBudget: { tokens: number; at: number };
}
type LiveSocket = Socket<Record<string, never>, Record<string, never>, Record<string, never>, SocketData>;

interface RoomState {
  members: Map<number, { user: LiveUserRef; role: LiveRole; sockets: Set<string> }>;
  hands: Map<number, LiveUserRef>;
  speakers: Map<number, LiveUserRef>;
  screenSharing: boolean;
  whiteboard: { visible: boolean; strokes: WhiteboardStroke[] };
}

const MAX_STROKES = 2000;
const MAX_POINTS = 4000;
const CHAT_BURST = 5;
const CHAT_REFILL_MS = 1000;

const rooms = new Map<string, RoomState>();
const key = (inst: number, id: number) => `${inst}:${id}`;
const roomName = (inst: number, id: number) => `room:${inst}:${id}`;
const userRoom = (inst: number, id: number, userId: number) => `user:${inst}:${id}:${userId}`;

function roomState(inst: number, id: number): RoomState {
  let r = rooms.get(key(inst, id));
  if (!r) {
    r = {
      members: new Map(),
      hands: new Map(),
      speakers: new Map(),
      screenSharing: false,
      whiteboard: { visible: false, strokes: [] },
    };
    rooms.set(key(inst, id), r);
  }
  return r;
}

const hostOnline = (r: RoomState) => [...r.members.values()].some((m) => m.role === 'host');

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

export function getLiveNamespace(): Namespace | null {
  return io?.of(LIVE_SOCKET_NAMESPACE) ?? null;
}

export function attachLiveSockets(server: HttpServer): Server {
  io = new Server(server, {
    path: LIVE_SOCKET_PATH,
    cors: { origin: config.corsOrigins, credentials: true },
    maxHttpBufferSize: 1e6,
  });
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
    registerHandlers(nsp, socket);
  });

  setRealtimeBridge({
    sessionEnded: (inst, id) => {
      nsp.to(roomName(inst, id)).emit(S.sessionEnded, { sessionId: id });
      nsp.in(roomName(inst, id)).socketsLeave(roomName(inst, id));
      const r = rooms.get(key(inst, id));
      if (r)
        for (const m of r.members.values())
          for (const sockId of m.sockets) {
            const s = nsp.sockets.get(sockId) as unknown as LiveSocket | undefined;
            if (s) s.data.liveSessionId = undefined;
          }
      rooms.delete(key(inst, id));
    },
    onlineUserIds: (inst, id) => [...(rooms.get(key(inst, id))?.members.keys() ?? [])],
  });
  return io;
}

/** Disconnects this node's live-class sockets opened from a device (it was revoked). Returns how many. */
export function disconnectDeviceSockets(deviceId: number): number {
  const nsp = getLiveNamespace();
  if (!nsp) return 0;
  let count = 0;
  for (const raw of nsp.sockets.values()) {
    const socket = raw as unknown as LiveSocket;
    if (socket.data?.ctx?.deviceId !== deviceId) continue;
    socket.disconnect(true);
    count++;
  }
  return count;
}

/** Closes the Socket.IO server (tests / graceful shutdown). */
export async function closeLiveSockets() {
  const s = io;
  io = null;
  rooms.clear();
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
}

/* ------------------------------------------------------------------ handlers */

type Ack = (res: unknown) => void;

function registerHandlers(nsp: Namespace, socket: LiveSocket) {
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

  /** The live class this socket joined (throws when it has not joined one). */
  const current = () => {
    const id = socket.data.liveSessionId;
    if (!id || !socket.data.role) throw Conflict('Join a live class first', 'NOT_JOINED');
    return { id, role: socket.data.role, room: roomState(inst, id), name: roomName(inst, id) };
  };
  const requireModerator = (role: LiveRole) => {
    if (role === 'student') throw Forbidden('Only the teacher can do this', 'NOT_CLASS_TEACHER');
  };
  const requireHost = (role: LiveRole) => {
    if (role !== 'host') throw Forbidden('Only the class teacher can do this', 'NOT_CLASS_TEACHER');
  };
  const broadcastHands = (id: number, r: RoomState) =>
    nsp.to(roomName(inst, id)).emit(S.handsUpdate, [...r.hands.values()]);
  const broadcastSpeakers = (id: number, r: RoomState) =>
    nsp.to(roomName(inst, id)).emit(S.speakersUpdate, [...r.speakers.values()]);

  async function leaveCurrent() {
    const id = socket.data.liveSessionId;
    const role = socket.data.role;
    if (!id) return;
    socket.data.liveSessionId = undefined;
    socket.data.role = undefined;
    void socket.leave(roomName(inst, id));
    void socket.leave(userRoom(inst, id, userId));
    const r = rooms.get(key(inst, id));
    const member = r?.members.get(userId);
    if (!r || !member) return;
    member.sockets.delete(socket.id);
    if (member.sockets.size) return;
    r.members.delete(userId);
    await svc.markLeft(id, userId).catch((err) => logger.warn({ err }, 'live markLeft failed'));
    nsp.to(roomName(inst, id)).emit(S.participantLeft, { userId, role });
    if (r.hands.delete(userId)) broadcastHands(id, r);
    if (r.speakers.delete(userId)) broadcastSpeakers(id, r);
    if (role === 'host') {
      r.screenSharing = false;
      nsp.to(roomName(inst, id)).emit(S.hostState, { online: hostOnline(r) });
      nsp.to(roomName(inst, id)).emit(S.screenState, { sharing: false });
    }
    if (!r.members.size && !r.whiteboard.strokes.length) rooms.delete(key(inst, id));
  }

  on(C.join, async (payload) => {
    const { sessionId } = parse(sid, payload);
    const { session, role } = await svc.loadSession(sessionId);
    if (session.status !== 'live') throw Conflict(`The class is ${session.status}`, 'NOT_LIVE');
    if (socket.data.liveSessionId && socket.data.liveSessionId !== sessionId) await leaveCurrent();

    const r = roomState(inst, sessionId);
    let member = r.members.get(userId);
    const firstSocket = !member;
    if (!member) {
      member = { user: socket.data.user, role, sockets: new Set() };
      r.members.set(userId, member);
    }
    member.sockets.add(socket.id);
    socket.data.liveSessionId = sessionId;
    socket.data.role = role;
    await socket.join([roomName(inst, sessionId), userRoom(inst, sessionId, userId)]);

    if (firstSocket) {
      await svc.markJoined(sessionId, userId, role);
      socket.to(roomName(inst, sessionId)).emit(S.participantJoined, { ...socket.data.user, role });
      if (role === 'host') socket.to(roomName(inst, sessionId)).emit(S.hostState, { online: true });
    }

    const [participants, chat, questions, polls] = await Promise.all([
      svc.listParticipants(sessionId),
      svc.listChat(sessionId),
      svc.listQuestions(sessionId),
      svc.listPolls(sessionId),
    ]);
    const onlineIds = new Set(r.members.keys());
    const state: LiveRoomState = {
      session: svc.toSessionDto(session, role),
      me: { ...socket.data.user, role },
      hostOnline: hostOnline(r),
      participants: participants.map((p) => ({ ...p, online: onlineIds.has(p.userId) })),
      chat,
      questions,
      polls,
      raisedHands: [...r.hands.values()],
      speakers: [...r.speakers.values()],
      screenSharing: r.screenSharing,
      whiteboard: r.whiteboard,
    };
    return state;
  });

  on(C.leave, async () => {
    await leaveCurrent();
  });

  socket.on('disconnect', () => {
    void runWithContext({ ...socket.data.ctx }, () => leaveCurrent());
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
    const { id, role, room } = current();
    if (role !== 'student') throw Forbidden('Only students raise hands');
    room.hands.set(userId, socket.data.user);
    broadcastHands(id, room);
  });

  on(C.handLower, async (payload) => {
    const { id, role, room } = current();
    const target = (payload as { userId?: number })?.userId ?? userId;
    if (target !== userId) requireModerator(role);
    room.hands.delete(target);
    broadcastHands(id, room);
  });

  on(C.micGrant, async (payload) => {
    const { id, role, room } = current();
    requireModerator(role);
    const { userId: target } = parse(userSchema, payload);
    const member = room.members.get(target);
    if (!member || member.role !== 'student')
      throw Conflict('That student is not in the class', 'NOT_ONLINE');
    // One student speaks at a time: the teacher's client relays the speaker's audio to the class.
    room.speakers.clear();
    room.speakers.set(target, member.user);
    room.hands.delete(target);
    broadcastSpeakers(id, room);
    broadcastHands(id, room);
  });

  on(C.micRevoke, async (payload) => {
    const { id, role, room } = current();
    const { userId: target } = parse(userSchema, payload);
    if (target !== userId) requireModerator(role);
    room.speakers.delete(target);
    broadcastSpeakers(id, room);
  });

  /* WebRTC signalling: only teacher ↔ participant (one-way class stream + granted student mic) */

  on(C.rtcSignal, async (payload) => {
    const { id, role, room } = current();
    const signal = parse(signalSchema, payload);
    const target = room.members.get(signal.to);
    if (!target) throw Conflict('That participant is offline', 'NOT_ONLINE');
    if (role !== 'host' && target.role !== 'host')
      throw Forbidden('Media is only exchanged with the teacher');
    nsp.to(userRoom(inst, id, signal.to)).emit(S.rtcSignal, { ...signal, from: userId });
  });

  on(C.screenState, async (payload) => {
    const { role, room, name } = current();
    requireHost(role);
    room.screenSharing = parse(screenSchema, payload).sharing;
    socket.to(name).emit(S.screenState, { sharing: room.screenSharing });
  });

  /* whiteboard: teacher draws, everyone views */

  on(C.wbStroke, async (payload) => {
    const { role, room, name } = current();
    requireModerator(role);
    const stroke = parse(strokeSchema, payload) as WhiteboardStroke;
    room.whiteboard.strokes.push(stroke);
    if (room.whiteboard.strokes.length > MAX_STROKES) room.whiteboard.strokes.shift();
    socket.to(name).emit(S.wbStroke, stroke);
  });

  on(C.wbUndo, async (payload) => {
    const { role, room, name } = current();
    requireModerator(role);
    const strokeId = (payload as { id?: string })?.id;
    const list = room.whiteboard.strokes;
    const idx = strokeId ? list.findIndex((s) => s.id === strokeId) : list.length - 1;
    if (idx >= 0) {
      const [removed] = list.splice(idx, 1);
      socket.to(name).emit(S.wbUndo, { id: removed.id });
    }
  });

  on(C.wbClear, async () => {
    const { role, room, name } = current();
    requireModerator(role);
    room.whiteboard.strokes = [];
    socket.to(name).emit(S.wbClear, {});
  });

  on(C.wbVisible, async (payload) => {
    const { role, room, name } = current();
    requireModerator(role);
    room.whiteboard.visible = parse(visibleSchema, payload).visible;
    socket.to(name).emit(S.wbVisible, { visible: room.whiteboard.visible });
  });
}
