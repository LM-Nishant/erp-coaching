import { enqueueJob } from '../../infrastructure/jobs/queue';
import { logger } from '../../infrastructure/logger';
import { requireTenantContext } from '../../shared/context';

/** Event names other modules subscribe to (see README "Cross-module wiring"). */
export const LIVE_EVENTS = {
  recordingReady: 'live.recording.ready',
  sessionStarted: 'live.session.started',
  sessionEnded: 'live.session.ended',
} as const;
export type LiveEventName = (typeof LIVE_EVENTS)[keyof typeof LIVE_EVENTS];

export const LIVE_EVENT_JOB = 'live-classes.dispatch-event';

/** `live.recording.ready`: a recording was stored and linked to the class's batch/course (LMS). */
export interface LiveRecordingReadyEvent {
  recordingId: number;
  liveSessionId: number;
  classSessionId: number | null;
  branchId: number;
  batchId: number;
  courseId: number | null;
  subjectId: number | null;
  teacherUserId: number;
  fileId: number;
  title: string;
  mimeType: string;
  sizeBytes: number;
  durationSeconds: number | null;
  source: 'provider' | 'client-upload';
  recordedAt: string;
}

export interface LiveSessionStartedEvent {
  liveSessionId: number;
  classSessionId: number | null;
  branchId: number;
  batchId: number;
  teacherUserId: number;
  startedAt: string;
}

/**
 * `live.session.ended`: final participation of every user who joined (attendance). Student
 * participants are identified by **login user id** (same as academics rosters).
 */
export interface LiveSessionEndedEvent extends LiveSessionStartedEvent {
  endedAt: string;
  subjectId: number | null;
  scheduledStartAt: string;
  scheduledEndAt: string;
  participants: {
    userId: number;
    role: 'host' | 'moderator' | 'student';
    firstJoinedAt: string | null;
    lastLeftAt: string | null;
    totalSeconds: number;
    joinCount: number;
  }[];
  /** Active batch students who never joined. */
  absentStudentUserIds: number[];
}

interface EventMap {
  'live.recording.ready': LiveRecordingReadyEvent;
  'live.session.started': LiveSessionStartedEvent;
  'live.session.ended': LiveSessionEndedEvent;
}

type Listener<E extends LiveEventName> = (event: EventMap[E]) => Promise<void>;
const listeners = new Map<LiveEventName, Map<string, Listener<LiveEventName>>>();

/**
 * Subscribe (from your module's `integrations.ts`) to a live classroom event. Listeners run in a
 * background job with the institute's context, never in the teacher's request, and must be
 * idempotent: the job retries when any listener throws.
 */
export function onLiveEvent<E extends LiveEventName>(event: E, name: string, listener: Listener<E>): void {
  if (!listeners.has(event)) listeners.set(event, new Map());
  listeners.get(event)!.set(name, listener as unknown as Listener<LiveEventName>);
}

export const onLiveRecordingReady = (name: string, l: Listener<'live.recording.ready'>) =>
  onLiveEvent(LIVE_EVENTS.recordingReady, name, l);
export const onLiveSessionStarted = (name: string, l: Listener<'live.session.started'>) =>
  onLiveEvent(LIVE_EVENTS.sessionStarted, name, l);
export const onLiveSessionEnded = (name: string, l: Listener<'live.session.ended'>) =>
  onLiveEvent(LIVE_EVENTS.sessionEnded, name, l);

export async function emitLiveEvent<E extends LiveEventName>(event: E, payload: EventMap[E]): Promise<void> {
  if (!listeners.get(event)?.size) return;
  requireTenantContext();
  await enqueueJob(LIVE_EVENT_JOB, { event, payload: payload as unknown as Record<string, unknown> });
}

export async function dispatchLiveEvent(job: Record<string, unknown>): Promise<void> {
  const event = job.event as LiveEventName;
  const failures: string[] = [];
  for (const [name, listener] of listeners.get(event) ?? []) {
    try {
      await listener(job.payload as never);
    } catch (err) {
      logger.warn({ listener: name, event, err }, 'Live classroom event listener failed');
      failures.push(`${name}: ${(err as Error).message}`);
    }
  }
  if (failures.length) throw new Error(failures.join('; '));
}
