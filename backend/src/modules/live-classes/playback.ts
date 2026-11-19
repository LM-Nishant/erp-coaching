import { logger } from '../../infrastructure/logger';

/**
 * Extension point for the module that streams videos (LMS): a signed HLS stream of a live recording
 * for the current user, or null when it has no HLS rendition yet or the user may not stream it
 * there. Register from the provider's `integrations.ts` in `onReady`:
 *
 *   import { setLiveRecordingPlayback } from '../live-classes/api';
 *   setLiveRecordingPlayback(async (recordingId) => ...{ url, expiresAt } | null);
 *
 * Default (no provider): recordings play from their signed file URL.
 */
export type LiveRecordingPlayback = (
  recordingId: number,
) => Promise<{ url: string; expiresAt: string } | null>;

let playback: LiveRecordingPlayback | null = null;

export function setLiveRecordingPlayback(p: LiveRecordingPlayback | null): void {
  playback = p;
}

/** HLS playback of a recording, or null to fall back to the signed file. */
export async function hlsPlaybackFor(recordingId: number) {
  if (!playback) return null;
  try {
    return await playback(recordingId);
  } catch (err) {
    logger.warn({ err, recordingId }, 'HLS playback lookup failed; serving the recording file');
    return null;
  }
}
