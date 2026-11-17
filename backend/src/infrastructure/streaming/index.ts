import crypto from 'node:crypto';

export interface LiveRoom {
  roomId: string;
  hostUrl: string;
}

/** Live streaming / WebRTC provider adapter (spec §4.9). */
export interface StreamingProvider {
  readonly name: string;
  createRoom(input: { sessionId: string; title: string }): Promise<LiveRoom>;
  issueJoinToken(input: {
    roomId: string;
    userId: number;
    role: 'host' | 'viewer' | 'speaker';
    ttlSeconds: number;
  }): Promise<string>;
  endRoom(roomId: string): Promise<{ recordingKeys: string[] }>;
}

export class MockStreamingProvider implements StreamingProvider {
  readonly name = 'mock';
  async createRoom(input: { sessionId: string }) {
    return { roomId: `room_${input.sessionId}`, hostUrl: `https://stream.invalid/host/${input.sessionId}` };
  }
  async issueJoinToken(input: { roomId: string; userId: number; role: string }) {
    return Buffer.from(JSON.stringify({ ...input, n: crypto.randomUUID() })).toString('base64url');
  }
  async endRoom() {
    return { recordingKeys: [] };
  }
}

const provider = new MockStreamingProvider();
export const getStreamingProvider = (): StreamingProvider => provider;
