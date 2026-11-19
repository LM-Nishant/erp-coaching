import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reactive } from 'vue';
import type { LiveJoinInfo, LiveRole } from '@erp/shared';
import type { LiveSocket } from './useLiveSocket';
import { useLiveKitTeacher, useLiveKitViewer, type LiveKitConnection } from './useLiveKitMedia';

/** A fake of the parts of livekit-client the composables use (event names and enum values mirror it). */
const h = vi.hoisted(() => {
  type Kind = 'audio' | 'video';
  let ids = 0;

  /** A MediaStreamTrack; `fire('ended')` is the browser ending it (e.g. "Stop sharing"). */
  function mediaTrack(kind: Kind) {
    const listeners: Record<string, () => void> = {};
    return {
      id: `track-${++ids}`,
      kind,
      stop: vi.fn(),
      addEventListener: (event: string, fn: () => void) => void (listeners[event] = fn),
      fire: (event: string) => listeners[event]?.(),
    };
  }
  /** A LiveKit (local or remote) track. */
  function track(kind: Kind) {
    return {
      kind,
      mediaStreamTrack: mediaTrack(kind),
      stop: vi.fn(),
      attach: vi.fn(() => document.createElement(kind)),
      detach: vi.fn((): HTMLElement[] => []),
    };
  }
  type Track = ReturnType<typeof track>;

  class Emitter {
    private handlers: Record<string, ((...args: unknown[]) => void)[]> = {};
    on(event: string, fn: (...args: unknown[]) => void) {
      (this.handlers[event] ??= []).push(fn);
      return this;
    }
    emit(event: string, ...args: unknown[]) {
      for (const fn of this.handlers[event] ?? []) fn(...args);
    }
  }

  class LocalParticipant {
    permissions = { canPublish: false, canPublishSources: [] as number[] };
    /** Camera and microphone, by source. */
    pubs = new Map<string, { track: Track; isMuted: boolean }>();
    /** Tracks published with `publishTrack` (the whiteboard and the screen). */
    published: unknown[] = [];
    constructor(private room: Emitter) {}
    getTrackPublication = (source: string) => this.pubs.get(source);
    private enable(source: string, on: boolean) {
      if (on && !this.pubs.has(source)) {
        this.pubs.set(source, { track: track(source === 'camera' ? 'video' : 'audio'), isMuted: false });
        this.room.emit('localTrackPublished');
      }
      const pub = this.pubs.get(source);
      if (pub) pub.isMuted = !on;
    }
    enableCameraAndMicrophone = vi.fn(async () => {
      this.enable('camera', true);
      this.enable('microphone', true);
    });
    setCameraEnabled = vi.fn(async (on: boolean) => this.enable('camera', on));
    setMicrophoneEnabled = vi.fn(async (on: boolean) => this.enable('microphone', on));
    publishTrack = vi.fn(async (t: unknown, _options?: unknown) => {
      this.published.push(t);
      this.room.emit('localTrackPublished');
    });
    unpublishTrack = vi.fn(async (t: unknown, _stop?: boolean) => {
      this.published = this.published.filter((p) => p !== t);
      for (const [source, pub] of this.pubs) if (pub.track === t) this.pubs.delete(source);
      this.room.emit('localTrackUnpublished');
    });
  }

  class RemotePublication {
    track: Track | undefined;
    isMuted = false;
    setSubscribed = vi.fn();
    constructor(
      public kind: Kind,
      public source: string,
      public trackName: string,
    ) {}
  }

  class RemoteParticipant {
    metadata: string;
    trackPublications = new Map<string, RemotePublication>();
    constructor(
      public identity: string,
      role: LiveRole,
    ) {
      this.metadata = JSON.stringify({ role });
    }
    get videoTrackPublications() {
      return new Map([...this.trackPublications].filter(([, p]) => p.kind === 'video'));
    }
    publish(kind: Kind, source: string, name: string) {
      const pub = new RemotePublication(kind, source, name);
      this.trackPublications.set(name, pub);
      return pub;
    }
  }

  const rooms: FakeRoom[] = [];
  /** Participants already in the room when the next one connects. */
  const present: RemoteParticipant[] = [];
  class FakeRoom extends Emitter {
    state = 'disconnected';
    canPlaybackAudio = true;
    localParticipant = new LocalParticipant(this);
    remoteParticipants = new Map<string, RemoteParticipant>();
    connect = vi.fn(async (_url: string, _token: string, _options?: unknown) => {
      this.state = 'connected';
      for (const p of present) this.remoteParticipants.set(p.identity, p);
    });
    disconnect = vi.fn(async (_stopTracks?: boolean) => void (this.state = 'disconnected'));
    startAudio = vi.fn(async () => void (this.canPlaybackAudio = true));
    constructor(public options: unknown) {
      super();
      rooms.push(this);
    }
  }

  class ApiError extends Error {
    constructor(
      public status: number,
      message: string,
    ) {
      super(message);
    }
  }

  return {
    rooms,
    present,
    boardTracks: [] as ReturnType<typeof mediaTrack>[],
    mediaTrack,
    track,
    FakeRoom,
    RemoteParticipant,
    ApiError,
    createLocalScreenTracks: vi.fn(async (_options?: unknown) => [track('video'), track('audio')]),
    join: vi.fn<(sessionId: number) => Promise<LiveJoinInfo>>(),
    toastError: vi.fn(),
  };
});

vi.mock('livekit-client', () => ({
  Room: h.FakeRoom,
  RoomEvent: {
    TrackPublished: 'trackPublished',
    TrackSubscribed: 'trackSubscribed',
    TrackUnsubscribed: 'trackUnsubscribed',
    ParticipantConnected: 'participantConnected',
    ParticipantDisconnected: 'participantDisconnected',
    TrackMuted: 'trackMuted',
    TrackUnmuted: 'trackUnmuted',
    LocalTrackPublished: 'localTrackPublished',
    LocalTrackUnpublished: 'localTrackUnpublished',
    AudioPlaybackStatusChanged: 'audioPlaybackChanged',
    ParticipantPermissionsChanged: 'participantPermissionsChanged',
    MediaDevicesError: 'mediaDevicesError',
    Reconnecting: 'reconnecting',
    Reconnected: 'reconnected',
    Disconnected: 'disconnected',
  },
  Track: {
    Kind: { Audio: 'audio', Video: 'video' },
    Source: { Camera: 'camera', Microphone: 'microphone', ScreenShare: 'screen_share' },
  },
  DisconnectReason: {
    UNKNOWN_REASON: 0,
    CLIENT_INITIATED: 1,
    DUPLICATE_IDENTITY: 2,
    PARTICIPANT_REMOVED: 4,
    ROOM_DELETED: 5,
    ROOM_CLOSED: 10,
  },
  ConnectionState: { Connected: 'connected' },
  createLocalScreenTracks: h.createLocalScreenTracks,
}));
vi.mock('@/core/api', () => ({
  ApiError: h.ApiError,
  errorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));
vi.mock('@/core/toast', () => ({ toastError: h.toastError }));
vi.mock('../api', () => ({ liveApi: { join: h.join } }));

type FakeRoom = InstanceType<typeof h.FakeRoom>;
const MICROPHONE = 2;

class FakeMediaStream {
  constructor(private tracks: unknown[] = []) {}
  getTracks() {
    return this.tracks;
  }
}

function joinInfo(role: LiveRole, token = 'jwt-1'): LiveJoinInfo {
  return {
    sessionId: 7,
    role,
    provider: 'livekit',
    transport: 'vendor-sdk',
    roomId: 'erp-1-7',
    token,
    url: 'wss://media.test',
    iceServers: [],
    socketPath: '/socket.io',
    socketNamespace: '/live',
    expiresAt: '2030-01-01T00:00:00.000Z',
  };
}

function liveSocket() {
  const live = {
    room: reactive({ whiteboard: { visible: false }, me: { id: 42 } }),
    revokeMic: vi.fn(async (_userId: number) => {}),
    setScreen: vi.fn(async (_sharing: boolean) => {}),
  };
  return { live, socket: live as unknown as LiveSocket };
}

async function connected(media: LiveKitConnection, index = 0): Promise<FakeRoom> {
  await vi.waitFor(() => {
    expect(h.rooms[index]).toBeDefined();
    expect(media.connected.value).toBe(true);
  });
  return h.rooms[index];
}

/** LiveKit delivers a subscribed track. */
function deliver(room: FakeRoom, pub: { kind: 'audio' | 'video'; track?: unknown }) {
  const track = h.track(pub.kind);
  pub.track = track;
  room.emit('trackSubscribed', track, pub);
  return track;
}

beforeEach(() => {
  vi.stubGlobal('MediaStream', FakeMediaStream);
  vi.spyOn(HTMLCanvasElement.prototype, 'captureStream').mockImplementation(() => {
    const track = h.mediaTrack('video');
    h.boardTracks.push(track);
    return { getVideoTracks: () => [track] } as unknown as MediaStream;
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  h.join.mockReset();
  h.createLocalScreenTracks.mockClear();
  h.rooms.length = 0;
  h.present.length = 0;
  h.boardTracks.length = 0;
});

describe('LiveKit student view', () => {
  it("subscribes to the teacher's media but not the whiteboard track, preferring a shared screen", async () => {
    const teacher = new h.RemoteParticipant('user-1', 'host');
    const camera = teacher.publish('video', 'camera', 'camera');
    const board = teacher.publish('video', 'screen_share', 'whiteboard');
    h.present.push(teacher);
    const v = useLiveKitViewer(liveSocket().socket, joinInfo('student'));
    const room = await connected(v.media);

    expect(room.connect).toHaveBeenCalledWith('wss://media.test', 'jwt-1', { autoSubscribe: false });
    expect(camera.setSubscribed).toHaveBeenCalledWith(true);
    expect(board.setSubscribed).not.toHaveBeenCalled();
    expect(v.hostConnected.value).toBe(true);
    expect(v.video.value).toBeNull();

    const cam = deliver(room, camera);
    expect(v.video.value?.getTracks()).toEqual([cam.mediaStreamTrack]);

    const screen = teacher.publish('video', 'screen_share', 'screen');
    room.emit('trackPublished', screen, teacher);
    expect(screen.setSubscribed).toHaveBeenCalledWith(true);
    const shared = deliver(room, screen);
    expect(v.video.value?.getTracks()).toEqual([shared.mediaStreamTrack]);
    expect(v.camera.value?.getTracks()).toEqual([cam.mediaStreamTrack]);

    const voice = deliver(room, teacher.publish('audio', 'microphone', 'microphone'));
    expect(voice.attach).toHaveBeenCalled();

    room.canPlaybackAudio = false;
    room.emit('audioPlaybackChanged');
    expect(v.media.audioBlocked.value).toBe(true);
    await v.media.startAudio();
    expect(room.startAudio).toHaveBeenCalled();
    expect(v.media.audioBlocked.value).toBe(false);

    v.stop();
    expect(room.disconnect).toHaveBeenCalledWith(true);
  });

  it('publishes the microphone only once the server allows it, and unpublishes it when revoked', async () => {
    const v = useLiveKitViewer(liveSocket().socket, joinInfo('student'));
    const room = await connected(v.media);
    const lp = room.localParticipant;

    const granted = v.setMicGranted(true);
    await new Promise((r) => setTimeout(r, 50));
    expect(lp.setMicrophoneEnabled).not.toHaveBeenCalled();
    lp.permissions = { canPublish: true, canPublishSources: [MICROPHONE] };
    room.emit('participantPermissionsChanged', undefined, lp);
    await granted;
    expect(lp.setMicrophoneEnabled).toHaveBeenCalledTimes(1);
    expect(lp.setMicrophoneEnabled).toHaveBeenCalledWith(true);
    expect(v.micActive.value).toBe(true);

    const mic = lp.pubs.get('microphone')!.track;
    lp.permissions = { canPublish: false, canPublishSources: [] };
    room.emit('participantPermissionsChanged', undefined, lp);
    await vi.waitFor(() => expect(v.micActive.value).toBe(false));
    expect(lp.unpublishTrack).toHaveBeenCalledWith(mic, true);
    v.stop();
  });

  it('gives up on a microphone grant the media server never applies', async () => {
    const v = useLiveKitViewer(liveSocket().socket, joinInfo('student'));
    const room = await connected(v.media);
    vi.useFakeTimers();
    const granted = expect(v.setMicGranted(true)).rejects.toThrow(/hasn't allowed your microphone/);
    await vi.advanceTimersByTimeAsync(10_400);
    await granted;
    expect(room.localParticipant.setMicrophoneEnabled).not.toHaveBeenCalled();
    v.stop();
  });

  it('reconnects with a fresh token, backing off, and gives the microphone back if the grant was lost', async () => {
    const { live, socket } = liveSocket();
    const v = useLiveKitViewer(socket, joinInfo('student'));
    const room = await connected(v.media);
    room.localParticipant.permissions = { canPublish: true, canPublishSources: [MICROPHONE] };
    await v.setMicGranted(true);
    expect(v.micActive.value).toBe(true);

    vi.useFakeTimers();
    h.join
      .mockRejectedValueOnce(new h.ApiError(503, 'Service unavailable'))
      .mockResolvedValueOnce(joinInfo('student', 'jwt-2'));
    room.emit('disconnected', 0);
    expect(v.media.connected.value).toBe(false);
    expect(v.media.error.value).toMatch(/Reconnecting/);

    await vi.advanceTimersByTimeAsync(1000);
    expect(h.join).toHaveBeenCalledWith(7);
    expect(v.media.error.value).toBe('Service unavailable');
    await vi.advanceTimersByTimeAsync(1999);
    expect(h.join).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.join).toHaveBeenCalledTimes(2);

    const again = await connected(v.media, 1);
    expect(again.connect).toHaveBeenCalledWith('wss://media.test', 'jwt-2', { autoSubscribe: false });
    await vi.waitFor(() => expect(live.revokeMic).toHaveBeenCalledWith(42));
    expect(again.localParticipant.setMicrophoneEnabled).not.toHaveBeenCalled();
    expect(v.micActive.value).toBe(false);
    expect(v.media.error.value).toBeNull();
    v.stop();
  });

  it('does not reconnect once the class was opened elsewhere', async () => {
    const v = useLiveKitViewer(liveSocket().socket, joinInfo('student'));
    const room = await connected(v.media);
    vi.useFakeTimers();
    room.emit('disconnected', 2);
    expect(v.media.error.value).toMatch(/another device or tab/);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.join).not.toHaveBeenCalled();
    v.stop();
  });

  it('stops reconnecting when the API refuses a new token', async () => {
    const v = useLiveKitViewer(liveSocket().socket, joinInfo('student'));
    const room = await connected(v.media);
    vi.useFakeTimers();
    h.join.mockRejectedValue(new h.ApiError(409, 'This live class has ended'));
    room.emit('disconnected', 0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.join).toHaveBeenCalledTimes(1);
    expect(v.media.error.value).toBe('This live class has ended');
    expect(h.rooms).toHaveLength(1);
    v.stop();
  });
});

describe('LiveKit teacher', () => {
  it('publishes the camera and microphone, and the whiteboard while it is shown', async () => {
    const { live, socket } = liveSocket();
    const canvas = document.createElement('canvas');
    const t = useLiveKitTeacher(socket, joinInfo('host'), () => canvas);
    const room = await connected(t.media);
    const lp = room.localParticipant;
    await vi.waitFor(() => expect(lp.enableCameraAndMicrophone).toHaveBeenCalled());
    expect(t.camera.value?.getTracks()).toEqual([lp.pubs.get('camera')!.track.mediaStreamTrack]);
    expect(t.preview.value).toBe(t.camera.value);
    expect(lp.published).toEqual([]);

    live.room.whiteboard.visible = true;
    await vi.waitFor(() => expect(lp.published).toHaveLength(1));
    const [board] = h.boardTracks;
    expect(lp.publishTrack).toHaveBeenCalledWith(board, {
      name: 'whiteboard',
      source: 'screen_share',
      simulcast: false,
    });

    live.room.whiteboard.visible = false;
    await vi.waitFor(() => expect(lp.published).toHaveLength(0));
    expect(lp.unpublishTrack).toHaveBeenCalledWith(board, true);
    expect(board.stop).toHaveBeenCalled();

    await t.toggleMic();
    expect(t.micOn.value).toBe(false);
    expect(lp.setMicrophoneEnabled).toHaveBeenLastCalledWith(false);

    t.stop();
    expect(room.disconnect).toHaveBeenCalledWith(true);
  });

  it('shares the screen instead of the whiteboard until sharing ends', async () => {
    const { live, socket } = liveSocket();
    live.room.whiteboard.visible = true;
    const canvas = document.createElement('canvas');
    const t = useLiveKitTeacher(socket, joinInfo('host'), () => canvas);
    const room = await connected(t.media);
    const lp = room.localParticipant;
    await vi.waitFor(() => expect(lp.published).toEqual([h.boardTracks[0]]));

    await t.startScreen();
    const [video, audio] = await h.createLocalScreenTracks.mock.results[0].value;
    expect(lp.published).toEqual([video, audio]);
    expect(h.boardTracks[0].stop).toHaveBeenCalled();
    expect(live.setScreen).toHaveBeenCalledWith(true);
    expect(t.preview.value?.getTracks()).toEqual([video.mediaStreamTrack]);

    // Stopped from the browser's own "Stop sharing" control.
    video.mediaStreamTrack.fire('ended');
    await vi.waitFor(() => expect(live.setScreen).toHaveBeenCalledWith(false));
    await vi.waitFor(() => expect(lp.published).toEqual([h.boardTracks[1]]));
    expect(video.stop).toHaveBeenCalled();
    expect(audio.stop).toHaveBeenCalled();
    expect(t.preview.value).toBe(t.camera.value);
    t.stop();
  });
});
