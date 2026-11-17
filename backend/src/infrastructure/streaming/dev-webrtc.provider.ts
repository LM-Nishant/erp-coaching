import jwt from 'jsonwebtoken';
import { config } from '../config';
import type { IceServer, JoinCredentials, LiveRoom, StreamingProvider, StreamingRole } from './types';

const AUDIENCE = 'live-dev-webrtc';

/**
 * Self-contained development provider: no media server and no vendor keys. The teacher's browser
 * sends its camera/screen + audio to each student over peer-to-peer WebRTC; offers, answers and ICE
 * candidates are relayed by the live classroom Socket.IO namespace. Recording is done in the
 * teacher's client (MediaRecorder) and uploaded through the storage service.
 *
 * Fine for demos and small classes (the teacher uploads one stream per student). Production should
 * use an SFU adapter (see modules/live-classes/README.md).
 */
export class DevWebRtcStreamingProvider implements StreamingProvider {
  readonly name = 'dev-webrtc';
  readonly transport = 'socket-webrtc' as const;

  async createRoom(input: { sessionId: string }): Promise<LiveRoom> {
    return { roomId: `live-${input.sessionId}`, hostUrl: null };
  }

  async issueJoinToken(input: {
    roomId: string;
    userId: number;
    displayName: string;
    role: StreamingRole;
    ttlSeconds: number;
  }): Promise<JoinCredentials> {
    const token = jwt.sign(
      { room: input.roomId, role: input.role, name: input.displayName },
      config.JWT_ACCESS_SECRET,
      { subject: String(input.userId), audience: AUDIENCE, expiresIn: input.ttlSeconds },
    );
    return { token, url: null, expiresAt: new Date(Date.now() + input.ttlSeconds * 1000) };
  }

  /** Verifies a token issued above (used by tests and any dev media relay). */
  verifyJoinToken(token: string): { userId: number; room: string; role: StreamingRole } {
    const claims = jwt.verify(token, config.JWT_ACCESS_SECRET, { audience: AUDIENCE }) as jwt.JwtPayload;
    return { userId: Number(claims.sub), room: String(claims.room), role: claims.role as StreamingRole };
  }

  iceServers(): IceServer[] {
    // Public STUN is enough on a LAN / localhost; production adapters return TURN credentials.
    return [{ urls: 'stun:stun.l.google.com:19302' }];
  }

  async startRecording() {
    return { mode: 'client-upload' as const, recordingId: null };
  }

  async endRoom() {
    return { recordings: [] };
  }
}
