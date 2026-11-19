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
  downloadUrl?: string;
  /** Provider-specific locator (file name, object key) for `fetchRecording` / `discardRecording`. */
  location?: string;
  mimeType: string;
  durationSeconds: number | null;
}

/** A verified provider webhook, normalised. */
export type StreamingWebhookEvent = {
  /** Provider event id: the idempotency key. */
  id: string;
  at: Date;
  roomId: string | null;
  /** Live class the room belongs to (from its name); null for rooms this deployment did not create. */
  target: { instituteId: number; liveSessionId: number } | null;
} & (
  | {
      kind: 'participant-joined' | 'participant-left';
      userId: number;
      /** Streaming role from the participant's (signed) token metadata. */
      role?: string;
      /** Provider connection id (e.g. LiveKit participant SID), unique per visit. */
      connectionRef?: string;
      /** When that connection joined. */
      joinedAt?: Date;
    }
  | { kind: 'room-started' | 'room-finished' }
  | { kind: 'recording-finished'; recording: ProviderRecording }
  | { kind: 'recording-failed'; ref: string; error: string }
  | { kind: 'ignored' }
);

export interface StreamingProvider {
  readonly name: string;
  /**
   * `socket-webrtc`: browsers negotiate WebRTC with each other through the live classroom socket
   * (no media server). `vendor-sdk`: clients connect to the vendor with `JoinCredentials`.
   */
  readonly transport: 'socket-webrtc' | 'vendor-sdk';
  /**
   * Media-room joins and leaves arrive as provider webhooks (`parseWebhook`), so attendance comes
   * from them rather than from the live classroom socket.
   */
  readonly reportsPresence?: boolean;
  createRoom(input: { sessionId: string; title: string; instituteId: number }): Promise<LiveRoom>;
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
  /** Lets a participant publish their microphone (the teacher's grant), or takes it away. */
  setParticipantPublish?(input: { roomId: string; userId: number; microphone: boolean }): Promise<void>;
  /**
   * Finished provider-side recordings of a room and how many are still being written (catch-up when
   * a webhook was missed).
   */
  listRecordings?(roomId: string): Promise<{ recordings: ProviderRecording[]; pending: number }>;
  /** Writes a recording without a `downloadUrl` to `destPath`. */
  fetchRecording?(rec: ProviderRecording, destPath: string): Promise<void>;
  /** Deletes the provider-side copy once it was imported. */
  discardRecording?(rec: ProviderRecording): Promise<void>;
  /** Verifies a signed provider webhook (throws `WebhookSignatureError`) and normalises it. */
  parseWebhook?(rawBody: Buffer, authorization: string | undefined): StreamingWebhookEvent;
  /** Admin connection check: credentials, API reachability and recording storage. */
  testConnection?(): Promise<{ ok: boolean; message: string }>;
  /** Non-secret settings shown to platform admins. */
  describe?(): Record<string, string | null>;
}

export class WebhookSignatureError extends Error {}
