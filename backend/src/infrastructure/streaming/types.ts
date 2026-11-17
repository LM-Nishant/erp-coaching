/**
 * Live streaming / media provider adapter (spec §4.9). Business code (modules/live-classes) talks
 * only to this interface; vendor SDKs (LiveKit, Agora, 100ms, Jitsi…) live in their own adapter file.
 */

export type StreamingRole = 'host' | 'moderator' | 'viewer' | 'speaker';

export interface LiveRoom {
  roomId: string;
  /** Vendor dashboard / SFU URL when relevant. */
  hostUrl: string | null;
}

export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export interface JoinCredentials {
  token: string;
  /** Vendor SFU/websocket URL the client SDK connects to (null for the dev socket transport). */
  url: string | null;
  expiresAt: Date;
}

export interface StartRecordingResult {
  /**
   * `provider`: the vendor records server-side and returns files from `endRoom`/webhooks.
   * `client-upload`: the teacher's client records (MediaRecorder) and uploads to the API.
   */
  mode: 'provider' | 'client-upload';
  recordingId: string | null;
}

export interface ProviderRecording {
  /** Vendor reference (egress id, file key…), stored for idempotency. */
  ref: string;
  /** Where to fetch the file from (signed vendor URL); imported into the storage service. */
  downloadUrl: string;
  mimeType: string;
  durationSeconds: number | null;
}

export interface StreamingProvider {
  readonly name: string;
  /**
   * `socket-webrtc`: browsers negotiate WebRTC with each other through the live classroom socket
   * (no media server). `vendor-sdk`: clients connect to the vendor with `JoinCredentials`.
   */
  readonly transport: 'socket-webrtc' | 'vendor-sdk';
  createRoom(input: { sessionId: string; title: string }): Promise<LiveRoom>;
  issueJoinToken(input: {
    roomId: string;
    userId: number;
    displayName: string;
    role: StreamingRole;
    ttlSeconds: number;
  }): Promise<JoinCredentials>;
  iceServers(): IceServer[];
  startRecording(roomId: string): Promise<StartRecordingResult>;
  /** Closes the room and returns finished provider-side recordings (empty for client-upload). */
  endRoom(roomId: string): Promise<{ recordings: ProviderRecording[] }>;
}
