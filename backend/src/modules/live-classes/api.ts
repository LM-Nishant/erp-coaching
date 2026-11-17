/**
 * Public live-classes API for other modules. Import only from this file.
 *
 *   import { onLiveRecordingReady, onLiveSessionEnded } from '../live-classes/api';
 *   onLiveSessionEnded('attendance', async (e) => { ...recordAttendance(e.participants)... });
 *
 * Listeners run in a background job with the institute's system context (retried on failure).
 */
export {
  LIVE_EVENTS,
  onLiveEvent,
  onLiveRecordingReady,
  onLiveSessionStarted,
  onLiveSessionEnded,
  type LiveEventName,
  type LiveRecordingReadyEvent,
  type LiveSessionStartedEvent,
  type LiveSessionEndedEvent,
} from './live-events';
export { listBatchRecordings, getRecording } from './live-classes.service';
export { LiveSession, LiveRecording, LiveParticipant } from './models';
