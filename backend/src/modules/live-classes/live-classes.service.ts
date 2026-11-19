import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Op, UniqueConstraintError, type WhereOptions } from 'sequelize';
import type {
  CreateLiveSessionInput,
  LiveChatMessageDto,
  LiveJoinInfo,
  LiveParticipantDto,
  LivePollDto,
  LiveQuestionDto,
  LiveRecordingDto,
  LiveRole,
  LiveSessionDto,
  LiveSessionStatus,
  UpdateLiveSessionInput,
} from '@erp/shared';
import { LIVE_SOCKET_NAMESPACE, LIVE_SOCKET_PATH } from '@erp/shared';
import {
  getStreamingProvider,
  type JoinTokenClaims,
  type StreamingRole,
} from '../../infrastructure/streaming';
import { logger } from '../../infrastructure/logger';
import { getContext, hasPermission, requireTenantContext } from '../../shared/context';
import { audit } from '../../shared/audit/audit.service';
import { BadRequest, Conflict, Forbidden, NotFound } from '../../shared/errors';
import { isDeviceSignedIn } from '../../shared/middleware/authenticate';
import { TenantRepository } from '../../shared/tenancy/tenant-repository';
import { User } from '../users/user.model';
import { FileObject } from '../files/file.model';
import { saveUploadedFile, signedUrlFor } from '../files/files.service';
import { Batch, BatchStudent, BatchTeacher, ClassSession, getBatchMemberUserIds } from '../academics/api';
import { batchMembersOf, guardiansOfStudentUsers, notify } from '../notifications/api';
import {
  LiveChatMessage,
  LiveParticipant,
  LivePoll,
  LivePollResponse,
  LiveQuestionVote,
  LiveRecording,
  LiveSession,
} from './models';
import { emitLiveEvent, LIVE_EVENTS } from './live-events';
import { realtime } from './realtime-bridge';
import { canJoinLive } from './entitlements';

export const MODULE = 'live-classes';
export const IMPORT_RECORDING_JOB = 'live-classes.import-recording';
const JOIN_TOKEN_MIN_SECONDS = 15 * 60;
const JOIN_TOKEN_MAX_SECONDS = 4 * 3600;
/** A join token outlives the scheduled end by this much, so a class that overruns a little is not cut short. */
const JOIN_TOKEN_GRACE_SECONDS = 30 * 60;
const HISTORY_LIMIT = 200;

export const repos = {
  sessions: new TenantRepository(LiveSession, { entity: 'Live class', branchScoped: true }),
  participants: new TenantRepository(LiveParticipant, { entity: 'Participant' }),
  messages: new TenantRepository(LiveChatMessage, { entity: 'Message' }),
  votes: new TenantRepository(LiveQuestionVote, { entity: 'Vote' }),
  polls: new TenantRepository(LivePoll, { entity: 'Poll' }),
  responses: new TenantRepository(LivePollResponse, { entity: 'Poll response' }),
  recordings: new TenantRepository(LiveRecording, { entity: 'Recording', branchScoped: true }),
};

/* ------------------------------------------------------------------ access */

/** Managers (branch/institute admins) can see, schedule and moderate every live class in their branches. */
export const canManage = () => hasPermission(`${MODULE}.configure`);
const me = () => {
  const { userId } = getContext();
  if (!userId) throw Forbidden();
  return userId;
};

async function isBatchTeacher(batchId: number, userId: number) {
  const { instituteId } = requireTenantContext();
  return (await BatchTeacher.count({ where: { instituteId, batchId, teacherUserId: userId } })) > 0;
}

async function isActiveStudent(batchId: number, userId: number) {
  const { instituteId } = requireTenantContext();
  return (
    (await BatchStudent.count({ where: { instituteId, batchId, studentUserId: userId, status: 'active' } })) >
    0
  );
}

/** The current user's role in a live class, or null when they may not take part. */
export async function roleFor(session: LiveSession): Promise<LiveRole | null> {
  const userId = me();
  if (session.teacherUserId === userId) return 'host';
  if (await isBatchTeacher(session.batchId, userId)) return 'moderator';
  if (canManage()) return 'moderator';
  if (await isActiveStudent(session.batchId, userId)) return 'student';
  return null;
}

/** Batches whose live classes the current (non-manager) user can see. */
async function myBatchIds(): Promise<number[]> {
  const { instituteId } = requireTenantContext();
  const userId = me();
  const [taught, studying] = await Promise.all([
    BatchTeacher.findAll({ where: { instituteId, teacherUserId: userId }, attributes: ['batchId'] }),
    BatchStudent.findAll({
      where: { instituteId, studentUserId: userId, status: 'active' },
      attributes: ['batchId'],
    }),
  ]);
  return [...new Set([...taught, ...studying].map((r) => r.batchId))];
}

const sessionInclude = [
  { model: User, as: 'teacher', attributes: ['id', 'name'] },
  { model: Batch, as: 'batch', attributes: ['id', 'name'] },
];

/** Loads a live class the current user may access (404 otherwise, also for other tenants). */
export async function loadSession(id: number): Promise<{ session: LiveSession; role: LiveRole }> {
  const session = await repos.sessions.findById(id, { include: sessionInclude });
  const role = await roleFor(session);
  if (!role) throw NotFound('Live class');
  return { session, role };
}

const assertModerator = (role: LiveRole) => {
  if (role === 'student') throw Forbidden('Only the teacher can do this', 'NOT_CLASS_TEACHER');
};
const assertHost = (role: LiveRole) => {
  if (role !== 'host') throw Forbidden('Only the class teacher can do this', 'NOT_CLASS_TEACHER');
};

/* ------------------------------------------------------------------ DTOs */

const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);

export function toSessionDto(s: LiveSession, myRole: LiveRole | null): LiveSessionDto {
  return {
    id: s.id,
    branchId: s.branchId,
    batchId: s.batchId,
    batchName: s.batch?.name ?? null,
    courseId: s.courseId,
    subjectId: s.subjectId,
    classSessionId: s.classSessionId,
    teacher: { id: s.teacherUserId, name: s.teacher?.name ?? '' },
    title: s.title,
    description: s.description,
    scheduledStartAt: iso(s.scheduledStartAt)!,
    scheduledEndAt: iso(s.scheduledEndAt)!,
    status: s.status,
    startedAt: iso(s.startedAt),
    endedAt: iso(s.endedAt),
    recordingEnabled: s.recordingEnabled,
    provider: s.provider,
    myRole,
  };
}

const userRef = (u: User | undefined, id: number) => ({ id, name: u?.name ?? `User ${id}` });

function toMessageDto(m: LiveChatMessage): LiveChatMessageDto {
  return { id: m.id, user: userRef(m.user, m.userId), body: m.body, createdAt: iso(m.createdAt)! };
}

function toQuestionDto(m: LiveChatMessage, myVotes: Set<number>): LiveQuestionDto {
  return {
    ...toMessageDto(m),
    upvotes: m.upvotes,
    upvotedByMe: myVotes.has(m.id),
    isAnswered: m.isAnswered,
  };
}

function toParticipantDto(p: LiveParticipant): LiveParticipantDto {
  const open = p.isOnline && p.lastJoinedAt ? Math.floor((Date.now() - +p.lastJoinedAt) / 1000) : 0;
  return {
    userId: p.userId,
    name: p.user?.name ?? `User ${p.userId}`,
    role: p.role,
    firstJoinedAt: iso(p.firstJoinedAt),
    lastJoinedAt: iso(p.lastJoinedAt),
    lastLeftAt: iso(p.lastLeftAt),
    totalSeconds: p.totalSeconds + Math.max(0, open),
    joinCount: p.joinCount,
    online: p.isOnline,
  };
}

/* ------------------------------------------------------------------ sessions */

export interface ListQuery {
  page: number;
  pageSize: number;
  status?: LiveSessionStatus[];
  batchId?: number;
  from?: Date;
  to?: Date;
  upcoming?: boolean;
}

export async function listSessions(q: ListQuery) {
  const where: Record<string | symbol, unknown> = {};
  if (q.status?.length) where.status = { [Op.in]: q.status };
  if (q.upcoming) where.status = { [Op.in]: ['scheduled', 'live'] };
  if (q.batchId) where.batchId = q.batchId;
  if (q.from || q.to)
    where.scheduledStartAt = {
      ...(q.from ? { [Op.gte]: q.from } : {}),
      ...(q.to ? { [Op.lte]: q.to } : {}),
    };
  const managing = canManage();
  if (!managing) {
    const batchIds = await myBatchIds();
    where[Op.or] = [{ teacherUserId: me() }, { batchId: { [Op.in]: batchIds.length ? batchIds : [0] } }];
  }
  const { rows, count } = await repos.sessions.findAndCountAll({
    where: where as WhereOptions<LiveSession>,
    include: sessionInclude,
    order: [['scheduledStartAt', q.upcoming ? 'ASC' : 'DESC']],
    limit: q.pageSize,
    offset: (q.page - 1) * q.pageSize,
  });
  const items = await Promise.all(rows.map(async (s) => toSessionDto(s, await roleFor(s))));
  return { items, total: count, page: q.page, pageSize: q.pageSize };
}

export async function getSessionDto(id: number) {
  const { session, role } = await loadSession(id);
  const dto = toSessionDto(session, role);
  dto.recordingCount = await repos.recordings.count({ liveSessionId: id });
  return dto;
}

function parseStart(input: CreateLiveSessionInput, cs?: ClassSession | null): { start: Date; end: Date } {
  if (input.scheduledStartAt) {
    const start = new Date(input.scheduledStartAt);
    if (Number.isNaN(+start)) throw BadRequest('Invalid scheduledStartAt');
    let minutes = input.durationMinutes;
    if (!minutes && cs) {
      const [sh, sm] = cs.startTime.split(':').map(Number);
      const [eh, em] = cs.endTime.split(':').map(Number);
      minutes = eh * 60 + em - (sh * 60 + sm);
    }
    return { start, end: new Date(+start + (minutes || 60) * 60000) };
  }
  if (!cs) throw BadRequest('scheduledStartAt is required');
  // No client-computed instant: the class session's date/time is read in the server's time zone.
  const start = new Date(`${cs.date}T${cs.startTime}:00`);
  const end = new Date(`${cs.date}T${cs.endTime}:00`);
  return { start, end };
}

export async function createSession(input: CreateLiveSessionInput) {
  const { instituteId } = requireTenantContext();
  const userId = me();
  const managing = canManage();

  let cs: ClassSession | null = null;
  if (input.classSessionId) {
    cs = await ClassSession.findOne({ where: { instituteId, id: input.classSessionId } });
    if (!cs) throw NotFound('Class session');
    repos.sessions.assertBranchAllowed(cs.branchId);
    if (cs.status === 'cancelled') throw Conflict('The class session is cancelled', 'INVALID_STATE');
    const existing = await repos.sessions.count({
      classSessionId: cs.id,
      status: { [Op.in]: ['scheduled', 'live'] },
    });
    if (existing) throw Conflict('This class already has a live session', 'LIVE_SESSION_EXISTS');
  }

  const batchId = cs?.batchId ?? input.batchId;
  if (!batchId) throw BadRequest('batchId or classSessionId is required');
  const batch = await Batch.findOne({ where: { instituteId, id: batchId } });
  if (!batch) throw NotFound('Batch');
  repos.sessions.assertBranchAllowed(batch.branchId);
  if (batch.status === 'cancelled' || batch.status === 'completed')
    throw BadRequest(`Batch is ${batch.status}`);

  const teacherUserId = cs?.teacherUserId ?? input.teacherUserId ?? userId;
  if (!managing && teacherUserId !== userId)
    throw Forbidden('Teachers can only schedule their own live classes', 'NOT_CLASS_TEACHER');
  const assigned =
    (cs && cs.teacherUserId === teacherUserId) || (await isBatchTeacher(batchId, teacherUserId));
  if (!assigned) throw BadRequest('The teacher is not assigned to this batch');

  const { start, end } = parseStart(input, cs);
  if (end <= start) throw BadRequest('The class must end after it starts');

  const session = await repos.sessions.create({
    branchId: batch.branchId,
    batchId,
    courseId: batch.courseId,
    subjectId: cs?.subjectId ?? input.subjectId ?? null,
    classSessionId: cs?.id ?? null,
    teacherUserId,
    title: input.title?.trim() || `${batch.name} live class`,
    description: input.description ?? null,
    scheduledStartAt: start,
    scheduledEndAt: end,
    recordingEnabled: input.recordingEnabled ?? true,
    provider: getStreamingProvider().name,
  });
  await audit({
    action: 'live_session.created',
    entityType: 'LiveSession',
    entityId: session.id,
    metadata: { after: session.toJSON() },
  });
  await safeNotify(async () => {
    const students = await getBatchMemberUserIds(batchId, { teachers: false });
    await notify({
      event: 'live-classes.scheduled',
      recipients: [batchMembersOf(batchId), guardiansOfStudentUsers(students)],
      data: { title: session.title, startsAt: start.toISOString(), liveSessionId: session.id },
      branchId: session.branchId,
    });
  });
  return getSessionDto(session.id);
}

export async function updateSession(id: number, input: UpdateLiveSessionInput) {
  const { session, role } = await loadSession(id);
  assertModerator(role);
  if (session.status !== 'scheduled') throw Conflict('Only scheduled classes can be edited', 'INVALID_STATE');
  const before = session.toJSON();
  const patch: Partial<LiveSession> = {};
  if (input.title !== undefined) patch.title = input.title.trim();
  if (input.description !== undefined) patch.description = input.description;
  if (input.recordingEnabled !== undefined) patch.recordingEnabled = input.recordingEnabled;
  if (input.scheduledStartAt !== undefined || input.durationMinutes !== undefined) {
    const start = input.scheduledStartAt ? new Date(input.scheduledStartAt) : session.scheduledStartAt;
    if (Number.isNaN(+start)) throw BadRequest('Invalid scheduledStartAt');
    const minutes =
      input.durationMinutes ?? Math.round((+session.scheduledEndAt - +session.scheduledStartAt) / 60000);
    patch.scheduledStartAt = start;
    patch.scheduledEndAt = new Date(+start + minutes * 60000);
  }
  await session.update(patch);
  await audit({
    action: 'live_session.updated',
    entityType: 'LiveSession',
    entityId: id,
    metadata: { before, after: session.toJSON() },
  });
  return getSessionDto(id);
}

export async function cancelSession(id: number) {
  const { session, role } = await loadSession(id);
  assertModerator(role);
  if (session.status !== 'scheduled')
    throw Conflict('Only scheduled classes can be cancelled', 'INVALID_STATE');
  await session.update({ status: 'cancelled' });
  await audit({ action: 'live_session.cancelled', entityType: 'LiveSession', entityId: id });
  return getSessionDto(id);
}

export async function deleteSession(id: number) {
  const { session, role } = await loadSession(id);
  assertModerator(role);
  if (session.status === 'live' || session.status === 'ended')
    throw Conflict(
      'Live or finished classes cannot be deleted; cancel a scheduled class instead',
      'INVALID_STATE',
    );
  const before = session.toJSON();
  await session.destroy();
  await audit({
    action: 'live_session.deleted',
    entityType: 'LiveSession',
    entityId: id,
    metadata: { before },
  });
}

export async function startSession(id: number) {
  const { session, role } = await loadSession(id);
  assertHost(role);
  if (session.status === 'live') return getSessionDto(id);
  if (session.status !== 'scheduled') throw Conflict(`The class is ${session.status}`, 'INVALID_STATE');
  const provider = getStreamingProvider();
  const room = await provider.createRoom({ sessionId: String(session.id), title: session.title });
  if (session.recordingEnabled) await provider.startRecording(room.roomId);
  const startedAt = new Date();
  await session.update({ status: 'live', startedAt, roomId: room.roomId, provider: provider.name });
  await audit({ action: 'live_session.started', entityType: 'LiveSession', entityId: id });
  await safeNotify(() =>
    notify({
      event: 'live-classes.starting',
      recipients: [batchMembersOf(session.batchId)],
      data: { title: session.title, joinUrl: `/live-classes/${id}/room`, liveSessionId: id },
      branchId: session.branchId,
    }),
  );
  await emitLiveEvent(LIVE_EVENTS.sessionStarted, {
    liveSessionId: id,
    classSessionId: session.classSessionId,
    branchId: session.branchId,
    batchId: session.batchId,
    teacherUserId: session.teacherUserId,
    startedAt: startedAt.toISOString(),
  });
  return getSessionDto(id);
}

export async function endSession(id: number) {
  const { session, role } = await loadSession(id);
  assertModerator(role);
  if (session.status !== 'live') throw Conflict('The class is not live', 'INVALID_STATE');
  const endedAt = new Date();
  await session.update({ status: 'ended', endedAt });
  const { instituteId } = requireTenantContext();
  realtime().sessionEnded(instituteId, id);

  const online = await repos.participants.findAll({ where: { liveSessionId: id, isOnline: true } });
  for (const p of online) await closeInterval(p, endedAt);

  let providerRecordings: Awaited<
    ReturnType<ReturnType<typeof getStreamingProvider>['endRoom']>
  >['recordings'] = [];
  try {
    providerRecordings = (await getStreamingProvider().endRoom(session.roomId ?? `live-${id}`)).recordings;
  } catch (err) {
    logger.warn({ err, liveSessionId: id }, 'Streaming provider failed to close the room');
  }
  const { enqueueJob } = await import('../../infrastructure/jobs/queue');
  for (const r of providerRecordings)
    await enqueueJob(IMPORT_RECORDING_JOB, { liveSessionId: id, ...r } as unknown as Record<string, unknown>);

  await audit({ action: 'live_session.ended', entityType: 'LiveSession', entityId: id });

  const participants = await repos.participants.findAll({ where: { liveSessionId: id } });
  const students = await getBatchMemberUserIds(session.batchId, { teachers: false });
  const joined = new Set(participants.map((p) => p.userId));
  await emitLiveEvent(LIVE_EVENTS.sessionEnded, {
    liveSessionId: id,
    classSessionId: session.classSessionId,
    branchId: session.branchId,
    batchId: session.batchId,
    subjectId: session.subjectId,
    teacherUserId: session.teacherUserId,
    scheduledStartAt: session.scheduledStartAt.toISOString(),
    scheduledEndAt: session.scheduledEndAt.toISOString(),
    startedAt: iso(session.startedAt) ?? endedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    participants: participants.map((p) => ({
      userId: p.userId,
      role: p.role,
      firstJoinedAt: iso(p.firstJoinedAt),
      lastLeftAt: iso(p.lastLeftAt),
      totalSeconds: p.totalSeconds,
      joinCount: p.joinCount,
    })),
    absentStudentUserIds: students.filter((s) => !joined.has(s)),
  });
  return getSessionDto(id);
}

/**
 * Seconds a join token lasts: until 30 minutes after the scheduled end, at least 15 minutes and at most 4 hours.
 * A client renews it with `POST /:id/join` before `expiresAt`; a vendor checks it when a participant connects.
 */
export function joinTokenTtlSeconds(scheduledEndAt: Date, now = Date.now()): number {
  const untilEnd = Math.ceil((scheduledEndAt.getTime() - now) / 1000) + JOIN_TOKEN_GRACE_SECONDS;
  return Math.min(JOIN_TOKEN_MAX_SECONDS, Math.max(JOIN_TOKEN_MIN_SECONDS, untilEnd));
}

/**
 * Provider media credentials, only for the class teacher, batch teachers/managers and enrolled students. The
 * token is bound to the requesting device (see `verifyJoinCredentials`).
 */
export async function joinInfo(id: number): Promise<LiveJoinInfo> {
  const { session, role } = await loadSession(id);
  if (session.status !== 'live') throw Conflict('The class is not live', 'NOT_LIVE');
  if (role === 'student' && !(await canJoinLive(session, me())))
    throw Forbidden('Pay the course fee to join this live class', 'LIVE_NOT_ENTITLED');
  const provider = getStreamingProvider();
  const user = await User.findByPk(me(), { attributes: ['id', 'name'] });
  const streamingRole: StreamingRole =
    role === 'host' ? 'host' : role === 'moderator' ? 'moderator' : 'viewer';
  const { deviceId } = getContext();
  if (!deviceId) throw Forbidden();
  const creds = await provider.issueJoinToken({
    roomId: session.roomId ?? `live-${id}`,
    userId: me(),
    deviceId,
    displayName: user?.name ?? '',
    role: streamingRole,
    ttlSeconds: joinTokenTtlSeconds(session.scheduledEndAt),
  });
  return {
    sessionId: id,
    role,
    provider: provider.name,
    transport: provider.transport,
    roomId: session.roomId ?? `live-${id}`,
    token: creds.token,
    url: creds.url,
    iceServers: provider.iceServers(),
    socketPath: LIVE_SOCKET_PATH,
    socketNamespace: LIVE_SOCKET_NAMESPACE,
    expiresAt: creds.expiresAt.toISOString(),
  };
}

/**
 * Verifies a join token for a media relay or webhook: the adapter's signature and expiry, then that the device it
 * was issued to is still signed in (null otherwise). Needs an adapter with `verifyJoinToken`.
 */
export async function verifyJoinCredentials(token: string): Promise<JoinTokenClaims | null> {
  const claims = getStreamingProvider().verifyJoinToken?.(token) ?? null;
  if (!claims) return null;
  return (await isDeviceSignedIn(claims.deviceId)) ? claims : null;
}

async function safeNotify(fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (err) {
    logger.warn({ err }, 'Live class notification failed');
  }
}

/* ------------------------------------------------------------------ participation */

async function closeInterval(p: LiveParticipant, at = new Date()) {
  if (!p.isOnline) return;
  const seconds = p.lastJoinedAt ? Math.max(0, Math.floor((+at - +p.lastJoinedAt) / 1000)) : 0;
  await p.update({ isOnline: false, lastLeftAt: at, totalSeconds: p.totalSeconds + seconds });
}

export async function markJoined(liveSessionId: number, userId: number, role: LiveRole) {
  const now = new Date();
  const existing = await repos.participants.findOne({ where: { liveSessionId, userId } });
  if (!existing) {
    await repos.participants
      .create({
        liveSessionId,
        userId,
        role,
        firstJoinedAt: now,
        lastJoinedAt: now,
        lastLeftAt: null,
        joinCount: 1,
        isOnline: true,
      })
      .catch((err: unknown) => {
        // The user's first socket on another API instance joined at the same moment and created it.
        if (!(err instanceof UniqueConstraintError)) throw err;
      });
  } else if (!existing.isOnline) {
    await existing.update({ isOnline: true, lastJoinedAt: now, joinCount: existing.joinCount + 1, role });
  }
}

export async function markLeft(liveSessionId: number, userId: number) {
  const p = await repos.participants.findOne({ where: { liveSessionId, userId } });
  if (p) await closeInterval(p);
}

export async function listParticipants(liveSessionId: number) {
  const rows = await repos.participants.findAll({
    where: { liveSessionId },
    include: [{ model: User, as: 'user', attributes: ['id', 'name'] }],
    order: [['firstJoinedAt', 'ASC']],
  });
  return rows.map(toParticipantDto);
}

/** Attendance-style report: every active batch student, joined or not (moderators only). */
export async function participationReport(id: number) {
  const { session, role } = await loadSession(id);
  assertModerator(role);
  const participants = await listParticipants(id);
  const studentIds = await getBatchMemberUserIds(session.batchId, { teachers: false });
  const joined = new Set(participants.map((p) => p.userId));
  const absentees = studentIds.filter((s) => !joined.has(s));
  const absentUsers = absentees.length
    ? await User.findAll({ where: { id: { [Op.in]: absentees } }, attributes: ['id', 'name'] })
    : [];
  return {
    participants,
    absent: absentUsers.map((u) => ({ id: u.id, name: u.name })),
    enrolledStudents: studentIds.length,
    joinedStudents: participants.filter((p) => p.role === 'student').length,
  };
}

/* ------------------------------------------------------------------ chat & Q&A */

const withUser = { include: [{ model: User, as: 'user', attributes: ['id', 'name'] }] };

async function assertLive(liveSessionId: number) {
  const s = await repos.sessions.findById(liveSessionId);
  if (s.status !== 'live') throw Conflict('The class is not live', 'NOT_LIVE');
}

export async function postMessage(liveSessionId: number, kind: 'chat' | 'question', body: string) {
  const text = body.trim().slice(0, 1000);
  if (!text) throw BadRequest('Message is empty');
  await assertLive(liveSessionId);
  const m = await repos.messages.create({ liveSessionId, userId: me(), kind, body: text });
  const full = await repos.messages.findById(m.id, withUser);
  return kind === 'chat' ? toMessageDto(full) : toQuestionDto(full, new Set());
}

export async function listChat(liveSessionId: number) {
  const rows = await repos.messages.findAll({
    where: { liveSessionId, kind: 'chat' },
    ...withUser,
    order: [['id', 'DESC']],
    limit: HISTORY_LIMIT,
  });
  return rows.reverse().map(toMessageDto);
}

export async function listQuestions(liveSessionId: number) {
  const rows = await repos.messages.findAll({
    where: { liveSessionId, kind: 'question' },
    ...withUser,
    order: [['id', 'ASC']],
  });
  const votes = rows.length
    ? await repos.votes.findAll({
        where: { userId: me(), messageId: { [Op.in]: rows.map((r) => r.id) } },
        attributes: ['messageId'],
      })
    : [];
  const mine = new Set(votes.map((v) => v.messageId));
  return rows.map((r) => toQuestionDto(r, mine));
}

async function findQuestion(liveSessionId: number, id: number) {
  const q = await repos.messages.findOne({ where: { id, liveSessionId, kind: 'question' }, ...withUser });
  if (!q) throw NotFound('Question');
  return q;
}

/** Toggles the current user's upvote. */
export async function toggleUpvote(liveSessionId: number, questionId: number) {
  await assertLive(liveSessionId);
  const q = await findQuestion(liveSessionId, questionId);
  const userId = me();
  const existing = await repos.votes.findOne({ where: { messageId: q.id, userId } });
  if (existing) await existing.destroy();
  else await repos.votes.create({ messageId: q.id, userId });
  const upvotes = await repos.votes.count({ messageId: q.id });
  await q.update({ upvotes });
  return toQuestionDto(q, new Set(existing ? [] : [q.id]));
}

export async function markAnswered(liveSessionId: number, questionId: number, answered: boolean) {
  const q = await findQuestion(liveSessionId, questionId);
  await q.update({ isAnswered: answered, answeredAt: answered ? new Date() : null });
  return toQuestionDto(q, new Set());
}

/* ------------------------------------------------------------------ polls */

async function pollDto(poll: LivePoll, userId?: number): Promise<LivePollDto> {
  const responses = await repos.responses.findAll({
    where: { pollId: poll.id },
    attributes: ['userId', 'optionIndex'],
  });
  const counts = poll.options.map(() => 0);
  let myVote: number | null = null;
  for (const r of responses) {
    if (counts[r.optionIndex] !== undefined) counts[r.optionIndex]++;
    if (userId && r.userId === userId) myVote = r.optionIndex;
  }
  return {
    id: poll.id,
    question: poll.question,
    options: poll.options,
    status: poll.status,
    counts,
    totalVotes: responses.length,
    myVote,
    createdAt: iso(poll.createdAt)!,
  };
}

export async function createPoll(liveSessionId: number, question: string, options: string[]) {
  await assertLive(liveSessionId);
  const opts = options.map((o) => o.trim()).filter(Boolean);
  if (!question.trim() || opts.length < 2 || opts.length > 6)
    throw BadRequest('A poll needs a question and 2–6 options');
  const poll = await repos.polls.create({
    liveSessionId,
    createdByUserId: me(),
    question: question.trim().slice(0, 300),
    options: opts.map((o) => o.slice(0, 120)),
  });
  return pollDto(poll);
}

export async function votePoll(liveSessionId: number, pollId: number, optionIndex: number) {
  const poll = await repos.polls.findOne({ where: { id: pollId, liveSessionId } });
  if (!poll) throw NotFound('Poll');
  if (poll.status !== 'open') throw Conflict('The poll is closed', 'POLL_CLOSED');
  if (!Number.isInteger(optionIndex) || optionIndex < 0 || optionIndex >= poll.options.length)
    throw BadRequest('Invalid option');
  const userId = me();
  if (await repos.responses.count({ pollId, userId }))
    throw Conflict('You have already voted', 'ALREADY_VOTED');
  await repos.responses.create({ pollId, userId, optionIndex });
  return pollDto(poll, userId);
}

export async function closePoll(liveSessionId: number, pollId: number) {
  const poll = await repos.polls.findOne({ where: { id: pollId, liveSessionId } });
  if (!poll) throw NotFound('Poll');
  if (poll.status === 'open') await poll.update({ status: 'closed', closedAt: new Date() });
  return pollDto(poll);
}

export async function listPolls(liveSessionId: number) {
  const polls = await repos.polls.findAll({ where: { liveSessionId }, order: [['id', 'ASC']] });
  const userId = getContext().userId;
  return Promise.all(polls.map((p) => pollDto(p, userId)));
}

/* ------------------------------------------------------------------ recordings */

function toRecordingDto(r: LiveRecording): LiveRecordingDto {
  return {
    id: r.id,
    liveSessionId: r.liveSessionId,
    batchId: r.batchId,
    courseId: r.courseId,
    title: r.title,
    fileId: r.fileId,
    mimeType: r.file?.mimeType ?? '',
    sizeBytes: r.file?.sizeBytes ?? 0,
    durationSeconds: r.durationSeconds,
    source: r.source,
    createdAt: iso(r.createdAt)!,
  };
}

const RECORDING_MIME = /^(video|audio)\//;

/** Stores a recording file for a live class and links it to the class's batch/course. */
async function attachRecording(
  session: LiveSession,
  upload: { tempPath: string; originalName: string; mimeType: string; sizeBytes: number },
  meta: { durationSeconds: number | null; source: 'provider' | 'client-upload'; providerRef?: string | null },
) {
  upload = { ...upload, mimeType: upload.mimeType.split(';')[0].trim().toLowerCase() };
  if (!RECORDING_MIME.test(upload.mimeType)) {
    await fs.promises.rm(upload.tempPath, { force: true });
    throw BadRequest('Recordings must be video or audio files');
  }
  const file = await saveUploadedFile({ ...upload, module: MODULE, branchId: session.branchId });
  const count = await repos.recordings.count({ liveSessionId: session.id });
  const rec = await repos.recordings.create({
    branchId: session.branchId,
    liveSessionId: session.id,
    batchId: session.batchId,
    courseId: session.courseId,
    fileId: file.id,
    title: count ? `${session.title} (part ${count + 1})` : session.title,
    durationSeconds: meta.durationSeconds,
    source: meta.source,
    providerRef: meta.providerRef ?? null,
  });
  await audit({
    action: 'live_recording.created',
    entityType: 'LiveRecording',
    entityId: rec.id,
    metadata: { liveSessionId: session.id, fileId: file.id, source: meta.source },
  });
  await emitLiveEvent(LIVE_EVENTS.recordingReady, {
    recordingId: rec.id,
    liveSessionId: session.id,
    classSessionId: session.classSessionId,
    branchId: session.branchId,
    batchId: session.batchId,
    courseId: session.courseId,
    subjectId: session.subjectId,
    teacherUserId: session.teacherUserId,
    fileId: file.id,
    title: rec.title,
    mimeType: file.mimeType,
    sizeBytes: file.sizeBytes,
    durationSeconds: rec.durationSeconds,
    source: meta.source,
    recordedAt: iso(session.startedAt) ?? new Date().toISOString(),
  });
  await safeNotify(() =>
    notify({
      event: 'live-classes.recording-ready',
      recipients: [batchMembersOf(session.batchId)],
      data: { title: session.title, liveSessionId: session.id },
      branchId: session.branchId,
    }),
  );
  rec.file = file;
  return toRecordingDto(rec);
}

export async function uploadRecording(
  id: number,
  upload: { tempPath: string; originalName: string; mimeType: string; sizeBytes: number },
  durationSeconds: number | null,
) {
  let session: LiveSession;
  try {
    const loaded = await loadSession(id);
    assertHost(loaded.role);
    session = loaded.session;
    if (session.status !== 'live' && session.status !== 'ended')
      throw Conflict('Recordings can only be added to started classes', 'INVALID_STATE');
    if (!session.recordingEnabled)
      throw Conflict('Recording is disabled for this class', 'RECORDING_DISABLED');
  } catch (err) {
    await fs.promises.rm(upload.tempPath, { force: true });
    throw err;
  }
  return attachRecording(session, upload, { durationSeconds, source: 'client-upload' });
}

/** Job: imports a provider-side recording (vendor adapters) into the storage service. Idempotent. */
export async function importProviderRecording(payload: Record<string, unknown>) {
  const { liveSessionId, ref, downloadUrl, mimeType, durationSeconds } = payload as {
    liveSessionId: number;
    ref: string;
    downloadUrl: string;
    mimeType: string;
    durationSeconds: number | null;
  };
  if (await repos.recordings.count({ liveSessionId, providerRef: ref })) return;
  const session = await repos.sessions.findById(liveSessionId);
  const res = await fetch(downloadUrl);
  if (!res.ok || !res.body) throw new Error(`Recording download failed: ${res.status}`);
  const tempPath = path.join(os.tmpdir(), `live-rec-${crypto.randomUUID()}`);
  await fs.promises.writeFile(tempPath, Buffer.from(await res.arrayBuffer()));
  const { size } = await fs.promises.stat(tempPath);
  await attachRecording(
    session,
    { tempPath, originalName: `${ref}.${mimeType.split('/')[1] ?? 'mp4'}`, mimeType, sizeBytes: size },
    { durationSeconds, source: 'provider', providerRef: ref },
  );
}

export async function listRecordings(q: { liveSessionId?: number; batchId?: number }) {
  const where: Record<string | symbol, unknown> = {};
  if (q.liveSessionId) {
    await loadSession(q.liveSessionId);
    where.liveSessionId = q.liveSessionId;
  } else if (!canManage()) {
    const batchIds = await myBatchIds();
    where.batchId = { [Op.in]: batchIds.length ? batchIds : [0] };
  }
  if (q.batchId) where[Op.and] = [{ batchId: q.batchId }];
  const rows = await repos.recordings.findAll({
    where: where as WhereOptions<LiveRecording>,
    include: [{ model: FileObject, as: 'file', attributes: ['id', 'mimeType', 'sizeBytes'] }],
    order: [['createdAt', 'DESC']],
    limit: 200,
  });
  return rows.map(toRecordingDto);
}

export async function recordingUrl(id: number) {
  const rec = await repos.recordings.findById(id, { include: [{ model: FileObject, as: 'file' }] });
  const session = await repos.sessions.findById(rec.liveSessionId);
  if (!(await roleFor(session))) throw NotFound('Recording');
  return signedUrlFor(rec.file!);
}

/* ------------------------------------------------------------------ public helpers (api.ts) */

/** Recordings of a batch for other modules (e.g. LMS), newest first. Runs in the caller's tenant context. */
export async function listBatchRecordings(batchId: number) {
  const { instituteId } = requireTenantContext();
  const rows = await LiveRecording.findAll({
    where: { instituteId, batchId },
    include: [{ model: FileObject, as: 'file', attributes: ['id', 'mimeType', 'sizeBytes'] }],
    order: [['createdAt', 'DESC']],
  });
  return rows.map(toRecordingDto);
}

export async function getRecording(id: number) {
  const { instituteId } = requireTenantContext();
  const rec = await LiveRecording.findOne({
    where: { instituteId, id },
    include: [{ model: FileObject, as: 'file', attributes: ['id', 'mimeType', 'sizeBytes'] }],
  });
  return rec ? toRecordingDto(rec) : null;
}
