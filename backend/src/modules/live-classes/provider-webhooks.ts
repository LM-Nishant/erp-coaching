import { UniqueConstraintError } from 'sequelize';
import type { LiveRole, LiveStreamingStatusDto, LiveStreamingTestResultDto } from '@erp/shared';
import { config } from '../../infrastructure/config';
import {
  getStreamingProvider,
  WebhookSignatureError,
  type StreamingWebhookEvent,
} from '../../infrastructure/streaming';
import { logger } from '../../infrastructure/logger';
import { getContext, runWithContext } from '../../shared/context';
import { BadRequest, NotFound, Unauthorized } from '../../shared/errors';
import { BatchStudent, BatchTeacher } from '../academics/api';
import { LiveSession, LiveWebhookEvent } from './models';
import {
  closeOnlineParticipants,
  ENSURE_RECORDING_JOB,
  IMPORT_RECORDING_JOB,
  markJoined,
  markLeft,
} from './live-classes.service';

export interface ProviderWebhookResult {
  received: true;
  ignored?: true;
  duplicate?: true;
}

/** Streaming role in the provider token (set by `joinInfo`) → classroom role. */
const ROLE_OF: Record<string, LiveRole> = {
  host: 'host',
  moderator: 'moderator',
  speaker: 'student',
  viewer: 'student',
};

/**
 * `POST /live-classes/public/:provider/webhook`. The signature is verified before anything is
 * trusted; the institute and class come from the room name the API created. Each provider event
 * is applied once (`live_webhook_events`), so redeliveries are harmless.
 */
export async function handleProviderWebhook(
  providerName: string,
  rawBody: Buffer,
  authorization: string | undefined,
): Promise<ProviderWebhookResult> {
  const provider = getStreamingProvider();
  if (provider.name !== providerName || !provider.parseWebhook) throw NotFound('Webhook');
  let event: StreamingWebhookEvent;
  try {
    event = provider.parseWebhook(rawBody, authorization);
  } catch (err) {
    if (err instanceof WebhookSignatureError) throw Unauthorized(err.message, 'INVALID_SIGNATURE');
    throw BadRequest('Unreadable webhook payload');
  }
  if (event.kind === 'ignored' || !event.target) return { received: true, ignored: true };
  const { instituteId, liveSessionId } = event.target;
  const ctx = { ...getContext(), system: true, instituteId, allowedBranchIds: null };
  return runWithContext(ctx, async (): Promise<ProviderWebhookResult> => {
    const session = await LiveSession.findOne({ where: { instituteId, id: liveSessionId } });
    if (!session || session.roomId !== event.roomId || session.provider !== provider.name)
      return { received: true, ignored: true };
    let row: LiveWebhookEvent;
    try {
      row = await LiveWebhookEvent.create({
        instituteId,
        provider: provider.name,
        eventId: event.id.slice(0, 120),
        event: event.kind,
        liveSessionId,
      });
    } catch (err) {
      if (err instanceof UniqueConstraintError) return { received: true, duplicate: true };
      throw err;
    }
    try {
      await apply(session, event);
    } catch (err) {
      // Let the provider's redelivery try again.
      await row.destroy();
      throw err;
    }
    return { received: true };
  });
}

async function apply(session: LiveSession, event: StreamingWebhookEvent) {
  const { enqueueJob } = await import('../../infrastructure/jobs/queue');
  switch (event.kind) {
    case 'participant-joined':
    case 'participant-left': {
      // Before start and after the end, attendance is closed (endSession closes open visits).
      if (session.status !== 'live') return;
      const role = await classroomRole(session, event.userId, event.role);
      const opts = {
        source: 'provider' as const,
        at: event.at,
        connectionRef: event.connectionRef,
        joinedAt: event.joinedAt,
      };
      if (event.kind === 'participant-left') return markLeft(session.id, event.userId, { ...opts, role });
      await markJoined(session.id, event.userId, role, opts);
      // The teacher is in the room: (re)start its recording, e.g. after the provider closed it empty.
      if (role === 'host' && session.recordingEnabled)
        await enqueueJob(ENSURE_RECORDING_JOB, { liveSessionId: session.id }, { maxAttempts: 3 });
      return;
    }
    case 'room-finished':
      if (session.status === 'live') await closeOnlineParticipants(session.id, event.at);
      return;
    case 'recording-finished':
      await enqueueJob(IMPORT_RECORDING_JOB, {
        liveSessionId: session.id,
        ...event.recording,
      } as unknown as Record<string, unknown>);
      return;
    case 'recording-failed':
      logger.warn(
        { liveSessionId: session.id, ref: event.ref, error: event.error },
        'The streaming provider could not finish a live class recording',
      );
      return;
    default:
      return;
  }
}

async function classroomRole(
  session: LiveSession,
  userId: number,
  streamingRole?: string,
): Promise<LiveRole> {
  const fromToken = streamingRole ? ROLE_OF[streamingRole] : undefined;
  if (fromToken) return fromToken;
  if (session.teacherUserId === userId) return 'host';
  const { instituteId, batchId } = session;
  if (await BatchTeacher.count({ where: { instituteId, batchId, teacherUserId: userId } }))
    return 'moderator';
  const student = await BatchStudent.count({
    where: { instituteId, batchId, studentUserId: userId, status: 'active' },
  });
  return student ? 'student' : 'moderator';
}

export const providerWebhookUrl = (providerName: string) =>
  `${config.API_PUBLIC_URL}/api/live-classes/public/${providerName}/webhook`;

/** Platform admins: the configured media provider, the webhook URL to set up there and its last delivery. */
export async function streamingStatus(): Promise<LiveStreamingStatusDto> {
  const provider = getStreamingProvider();
  const last = provider.parseWebhook
    ? await LiveWebhookEvent.findOne({
        order: [['createdAt', 'DESC']],
        attributes: ['createdAt'],
        tenantBypass: true, // platform view across institutes
      } as object)
    : null;
  return {
    provider: provider.name,
    transport: provider.transport,
    webhookUrl: provider.parseWebhook ? providerWebhookUrl(provider.name) : null,
    settings: provider.describe?.() ?? {},
    lastWebhookAt: last?.createdAt.toISOString() ?? null,
    canTest: !!provider.testConnection,
  };
}

export async function testStreamingConnection(): Promise<LiveStreamingTestResultDto> {
  const provider = getStreamingProvider();
  const testedAt = new Date().toISOString();
  if (!provider.testConnection)
    return {
      ok: true,
      message: `The ${provider.name} provider has no media server to check: browsers connect to each other through the classroom socket.`,
      testedAt,
    };
  return { ...(await provider.testConnection()), testedAt };
}
