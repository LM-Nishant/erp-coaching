import { ref, shallowRef, watch, type Ref, type ShallowRef } from 'vue';
import type { LiveJoinInfo } from '@erp/shared';
import type { LocalTrack, RemoteTrackPublication, Room } from 'livekit-client';
import { ApiError, errorMessage } from '@/core/api';
import { toastError } from '@/core/toast';
import { liveApi } from '../api';
import type { LiveSocket } from './useLiveSocket';

/**
 * LiveKit media (`transport: 'vendor-sdk'`). Audio and video go through the LiveKit SFU; chat, Q&A,
 * polls, raised hands, microphone grants and the whiteboard stay on the live socket.
 *
 * The join token decides what each participant may publish: the teacher their camera, microphone
 * and screen; students nothing until the teacher grants their microphone, which the API applies on
 * the LiveKit server (seen here as `ParticipantPermissionsChanged`). While the whiteboard is shown
 * and the screen isn't shared, the teacher also publishes the board as a screen-share track named
 * `whiteboard`, so LiveKit Egress records it; students draw the board from the socket and never
 * subscribe to that track.
 *
 * Video is shown through `srcObject` (adaptive stream is off, so the SFU sends the best layer the
 * connection allows); remote audio plays through LiveKit-managed `<audio>` elements, so
 * `startAudio()` can unlock playback from a tap when the browser blocks autoplay.
 *
 * `livekit-client` is loaded on demand: clients of the dev provider never download it.
 */

type LiveKit = typeof import('livekit-client');

export const WHITEBOARD_TRACK = 'whiteboard';
const BOARD_FPS = 5;
/** `TrackSource.MICROPHONE` in LiveKit's protocol (livekit-client doesn't re-export the enum). */
const MICROPHONE_SOURCE = 2;
const MAX_RETRY_MS = 30_000;
const MIC_PERMISSION_WAIT_MS = 10_000;

let livekit: Promise<LiveKit> | null = null;

/** livekit-client, loaded once on first use (and again after a failed chunk load). */
function loadLiveKit(): Promise<LiveKit> {
  livekit ??= import('livekit-client').catch((e: unknown) => {
    livekit = null;
    throw e;
  });
  return livekit;
}

export interface LiveKitConnection {
  /** Media connected (the live socket has its own state). */
  connected: Ref<boolean>;
  /** The browser blocked autoplay: call `startAudio()` from a tap. */
  audioBlocked: Ref<boolean>;
  error: Ref<string | null>;
  startAudio: () => Promise<void>;
}

interface Hooks {
  /** Tracks were added, removed, muted or unmuted. */
  changed: (room: Room, lk: LiveKit) => void;
  /** Connected (again): publish whatever should be published. `rejoined` after a lost connection. */
  connected?: (room: Room, lk: LiveKit, rejoined: boolean) => Promise<void>;
  /** The server changed this participant's permissions. */
  permissions?: (room: Room, lk: LiveKit) => void;
  /** LiveKit restored a dropped connection by itself (publications were kept). */
  resumed?: () => void;
}

/** Replaces `target` only when its tracks change, so playing video elements aren't reset. */
function setStream(target: ShallowRef<MediaStream | null>, tracks: (MediaStreamTrack | undefined)[]) {
  const next = tracks.filter((t): t is MediaStreamTrack => !!t);
  const current = target.value?.getTracks() ?? [];
  if (current.length === next.length && current.every((t, i) => t === next[i])) return;
  target.value = next.length ? new MediaStream(next) : null;
}

function useLiveKitRoom(info: LiveJoinInfo, hooks: Hooks) {
  const connected = ref(false);
  const audioBlocked = ref(false);
  const error = ref<string | null>(null);
  const audioBox = document.createElement('div');
  audioBox.hidden = true;
  document.body.append(audioBox);
  let lk: LiveKit | null = null;
  /** The latest room (events of older ones are ignored). */
  let room: Room | null = null;
  /** `room` once connected, also while LiveKit restores a dropped connection by itself. */
  let ready: Room | null = null;
  let stopped = false;
  let attempt = 0;
  let retry: ReturnType<typeof setTimeout> | undefined;

  async function connect(join: LiveJoinInfo): Promise<Room | null> {
    if (!join.url) throw new Error('The media server address is not configured');
    lk ??= await loadLiveKit();
    const lib = lk;
    const { RoomEvent, Track, DisconnectReason } = lib;
    const r = new lib.Room({
      adaptiveStream: false,
      dynacast: true,
      disconnectOnPageLeave: true,
      audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      videoCaptureDefaults: { resolution: { width: 1280, height: 720, frameRate: 24 } },
    });
    room = r;
    const changed = () => room === r && hooks.changed(r, lib);
    const subscribe = (pub: RemoteTrackPublication) => {
      if (pub.trackName !== WHITEBOARD_TRACK) pub.setSubscribed(true);
    };
    r.on(RoomEvent.TrackPublished, subscribe)
      .on(RoomEvent.TrackSubscribed, (track) => {
        if (track.kind === Track.Kind.Audio) audioBox.append(track.attach());
        changed();
      })
      .on(RoomEvent.TrackUnsubscribed, (track) => {
        track.detach().forEach((el) => el.remove());
        changed();
      })
      .on(RoomEvent.ParticipantConnected, changed)
      .on(RoomEvent.ParticipantDisconnected, changed)
      .on(RoomEvent.TrackMuted, changed)
      .on(RoomEvent.TrackUnmuted, changed)
      .on(RoomEvent.LocalTrackPublished, changed)
      .on(RoomEvent.LocalTrackUnpublished, changed)
      .on(RoomEvent.AudioPlaybackStatusChanged, () => (audioBlocked.value = !r.canPlaybackAudio))
      .on(RoomEvent.ParticipantPermissionsChanged, (_prev, p) => {
        if (room === r && p === r.localParticipant) hooks.permissions?.(r, lib);
      })
      .on(
        RoomEvent.MediaDevicesError,
        (e) => (error.value = `Camera/microphone unavailable: ${errorMessage(e)}`),
      )
      .on(RoomEvent.Reconnecting, () => (connected.value = false))
      .on(RoomEvent.Reconnected, () => {
        if (room !== r) return;
        connected.value = true;
        hooks.resumed?.();
      })
      .on(RoomEvent.Disconnected, (reason) => {
        if (room !== r) return;
        room = ready = null;
        connected.value = false;
        audioBox.replaceChildren();
        hooks.changed(r, lib);
        if (stopped) return;
        if (reason === DisconnectReason.DUPLICATE_IDENTITY) {
          error.value = 'This class was opened on another device or tab, so it was closed here.';
          return;
        }
        // Ended or removed: the live socket reports that and closes the room.
        if (
          reason === DisconnectReason.CLIENT_INITIATED ||
          reason === DisconnectReason.ROOM_DELETED ||
          reason === DisconnectReason.ROOM_CLOSED ||
          reason === DisconnectReason.PARTICIPANT_REMOVED
        )
          return;
        error.value = 'Lost the connection to the media server. Reconnecting…';
        schedule();
      });
    try {
      await r.connect(join.url, join.token, { autoSubscribe: false });
    } catch (e) {
      if (room === r) room = null;
      throw e;
    }
    if (room !== r || stopped) {
      await r.disconnect();
      return null;
    }
    for (const p of r.remoteParticipants.values())
      for (const pub of p.trackPublications.values()) subscribe(pub);
    ready = r;
    connected.value = true;
    error.value = null;
    audioBlocked.value = !r.canPlaybackAudio;
    changed();
    return r;
  }

  async function start(join: LiveJoinInfo, rejoined: boolean) {
    let r: Room | null;
    try {
      r = await connect(join);
    } catch (e) {
      if (stopped) return;
      error.value = `Couldn't connect to the media server: ${errorMessage(e)}`;
      return schedule();
    }
    attempt = 0;
    if (r && lk) await hooks.connected?.(r, lk, rejoined);
  }

  function schedule() {
    clearTimeout(retry);
    if (stopped) return;
    retry = setTimeout(() => void rejoin(), Math.min(MAX_RETRY_MS, 1000 * 2 ** attempt++));
  }

  /** Reconnects with a fresh token from the API, authorised like the first join. */
  async function rejoin() {
    if (stopped) return;
    let join: LiveJoinInfo;
    try {
      join = await liveApi.join(info.sessionId);
    } catch (e) {
      if (stopped) return;
      error.value = errorMessage(e);
      // The class ended or access was withdrawn: nothing to reconnect to.
      if (e instanceof ApiError && e.status >= 400 && e.status < 500 && e.status !== 429) return;
      return schedule();
    }
    const old = room;
    room = ready = null;
    await old?.disconnect().catch(() => {});
    await start(join, true);
  }

  void start(info, false);

  const media: LiveKitConnection = {
    connected,
    audioBlocked,
    error,
    startAudio: async () => {
      await ready?.startAudio();
      audioBlocked.value = !!ready && !ready.canPlaybackAudio;
    },
  };

  return {
    media,
    /** The connected room (also while LiveKit restores a dropped connection); null otherwise. */
    current: () => ready,
    lib: () => lk,
    stop() {
      stopped = true;
      clearTimeout(retry);
      connected.value = false;
      const r = room;
      room = ready = null;
      void r?.disconnect(true);
      audioBox.remove();
    },
  };
}

/* ------------------------------------------------------------------ teacher */

export function useLiveKitTeacher(
  live: LiveSocket,
  info: LiveJoinInfo,
  board: () => HTMLCanvasElement | null,
) {
  const camera = shallowRef<MediaStream | null>(null);
  const screen = shallowRef<MediaStream | null>(null);
  /** What students see: the screen while shared, else the camera. */
  const preview = shallowRef<MediaStream | null>(null);
  /** Granted students are heard through LiveKit's audio elements, not a relayed stream. */
  const speakerAudio = shallowRef<MediaStream | null>(null);
  const camOn = ref(true);
  const micOn = ref(true);
  const canShareScreen = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getDisplayMedia;
  let screenTracks: LocalTrack[] = [];
  let boardTrack: MediaStreamTrack | null = null;
  let boardTimer: ReturnType<typeof setInterval> | undefined;
  let boardQueue: Promise<void> = Promise.resolve();

  const conn = useLiveKitRoom(info, {
    changed: (room, lk) => {
      const cam = room.localParticipant.getTrackPublication(lk.Track.Source.Camera);
      setStream(camera, [cam && !cam.isMuted ? cam.track?.mediaStreamTrack : undefined]);
      preview.value = screen.value ?? camera.value;
    },
    connected: async (room) => {
      try {
        const lp = room.localParticipant;
        if (camOn.value && micOn.value) await lp.enableCameraAndMicrophone();
        else {
          await lp.setCameraEnabled(camOn.value);
          await lp.setMicrophoneEnabled(micOn.value);
        }
      } catch (e) {
        conn.media.error.value = `Camera/microphone unavailable: ${errorMessage(e)}. Students will only see the whiteboard.`;
      }
      // A lost connection stopped the shared screen and the board stream: sharing the screen
      // again needs the user's gesture; the board is published again below.
      if (screenTracks.length) await stopScreen();
      boardQueue = boardQueue.then(() => {
        clearInterval(boardTimer);
        boardTrack?.stop();
        boardTrack = null;
      });
      await syncBoard();
    },
    resumed: () => void syncBoard(),
  });

  /** Publishes the whiteboard (for the recording) while it's shown and the screen isn't shared. */
  function syncBoard() {
    boardQueue = boardQueue.then(async () => {
      const room = conn.current();
      const lk = conn.lib();
      const canvas = board();
      const wanted = !!room && !!canvas && live.room.whiteboard.visible && !screen.value;
      if (wanted && !boardTrack && room && lk && canvas) {
        // Draw into a copy at a steady rate: a canvas stream only has frames when the canvas is
        // repainted, and late subscribers (Egress) need frames to start from.
        const copy = document.createElement('canvas');
        copy.width = canvas.width;
        copy.height = canvas.height;
        const ctx = copy.getContext('2d');
        const draw = () => {
          const b = board();
          if (ctx && b) ctx.drawImage(b, 0, 0, copy.width, copy.height);
        };
        draw();
        boardTimer = setInterval(draw, 1000 / BOARD_FPS);
        const track = copy.captureStream(BOARD_FPS).getVideoTracks()[0];
        boardTrack = track;
        try {
          await room.localParticipant.publishTrack(track, {
            name: WHITEBOARD_TRACK,
            source: lk.Track.Source.ScreenShare,
            simulcast: false,
          });
        } catch {
          // Not recorded this time; the next board, screen or connection change tries again.
          clearInterval(boardTimer);
          boardTrack = null;
          track.stop();
        }
      } else if (!wanted && boardTrack) {
        clearInterval(boardTimer);
        const track = boardTrack;
        boardTrack = null;
        await room?.localParticipant.unpublishTrack(track, true).catch(() => {});
        track.stop();
      }
    });
    return boardQueue;
  }
  const stopBoardWatch = watch(
    () => live.room.whiteboard.visible,
    () => void syncBoard(),
    { flush: 'post' },
  );

  async function startScreen() {
    const room = conn.current();
    const lk = conn.lib();
    if (!room || !lk) throw new Error('Not connected to the media server yet');
    const tracks = await lk.createLocalScreenTracks({ audio: true });
    const video = tracks.find((t) => t.kind === lk.Track.Kind.Video);
    if (!video) {
      tracks.forEach((t) => t.stop());
      return;
    }
    screenTracks = tracks;
    screen.value = new MediaStream([video.mediaStreamTrack]);
    preview.value = screen.value;
    video.mediaStreamTrack.addEventListener('ended', () => void stopScreen());
    await syncBoard();
    try {
      for (const t of tracks) await room.localParticipant.publishTrack(t);
      await live.setScreen(true);
    } catch (e) {
      await stopScreen();
      throw e;
    }
  }

  async function stopScreen() {
    const tracks = screenTracks;
    screenTracks = [];
    const room = conn.current();
    for (const t of tracks) {
      if (room) await room.localParticipant.unpublishTrack(t, true).catch(() => {});
      t.stop();
    }
    if (!screen.value) return;
    screen.value = null;
    preview.value = camera.value;
    await live.setScreen(false).catch(() => {});
    await syncBoard();
  }

  async function toggleCam() {
    camOn.value = !camOn.value;
    await conn.current()?.localParticipant.setCameraEnabled(camOn.value).catch(toastError);
  }
  async function toggleMic() {
    micOn.value = !micOn.value;
    await conn.current()?.localParticipant.setMicrophoneEnabled(micOn.value).catch(toastError);
  }

  function stop() {
    stopBoardWatch();
    clearInterval(boardTimer);
    boardTrack?.stop();
    screenTracks.forEach((t) => t.stop());
    conn.stop();
  }

  return {
    media: conn.media,
    camera,
    screen,
    preview,
    speakerAudio,
    camOn,
    micOn,
    canShareScreen,
    startScreen,
    stopScreen,
    toggleCam,
    toggleMic,
    stop,
  };
}

/* ------------------------------------------------------------------ student / viewer */

/** The role the API put in the participant's token metadata. */
function roleOf(metadata: string | undefined): string | null {
  try {
    return (JSON.parse(metadata ?? '') as { role?: string }).role ?? null;
  } catch {
    return null;
  }
}

export function useLiveKitViewer(live: LiveSocket, info: LiveJoinInfo) {
  /** The teacher's screen while shared, else their camera. */
  const video = shallowRef<MediaStream | null>(null);
  /** The teacher's camera (for the picture-in-picture over the whiteboard). */
  const camera = shallowRef<MediaStream | null>(null);
  /** The teacher is connected to the media server (so no video means their camera is off). */
  const hostConnected = ref(false);
  /** Remote audio plays through LiveKit's audio elements. */
  const audio = shallowRef<MediaStream | null>(null);
  const micActive = ref(false);
  let wantMic = false;
  let micQueue: Promise<void> = Promise.resolve();

  const micAllowed = (room: Room) => {
    const p = room.localParticipant.permissions;
    return (
      !!p?.canPublish && (!p.canPublishSources.length || p.canPublishSources.includes(MICROPHONE_SOURCE))
    );
  };

  const conn = useLiveKitRoom(info, {
    changed: (room, lk) => {
      let cam: MediaStreamTrack | undefined;
      let shared: MediaStreamTrack | undefined;
      let host = false;
      for (const p of room.remoteParticipants.values()) {
        host ||= roleOf(p.metadata) === 'host';
        for (const pub of p.videoTrackPublications.values()) {
          const track = pub.isMuted ? undefined : pub.track?.mediaStreamTrack;
          if (pub.source === lk.Track.Source.ScreenShare && pub.trackName !== WHITEBOARD_TRACK)
            shared ??= track;
          else if (pub.source === lk.Track.Source.Camera) cam ??= track;
        }
      }
      hostConnected.value = host && room.state === lk.ConnectionState.Connected;
      setStream(video, [shared ?? cam]);
      setStream(camera, [cam]);
      micActive.value = !!room.localParticipant.getTrackPublication(lk.Track.Source.Microphone);
    },
    connected: async (room, _lk, rejoined) => {
      // A new connection starts without the microphone grant: give the turn back instead of
      // showing "your mic is on" with nothing published.
      if (rejoined && wantMic && !micAllowed(room)) {
        wantMic = false;
        const me = live.room.me?.id;
        if (me) await live.revokeMic(me).catch(() => {});
      }
      await syncMic().catch(toastError);
    },
    permissions: () => void syncMic().catch(micFailed),
  });

  function syncMic() {
    micQueue = micQueue
      .catch(() => {})
      .then(async () => {
        const room = conn.current();
        const lk = conn.lib();
        if (!room || !lk) return;
        const lp = room.localParticipant;
        const pub = lp.getTrackPublication(lk.Track.Source.Microphone);
        if (wantMic && micAllowed(room)) {
          if (!pub) await lp.setMicrophoneEnabled(true);
        } else if (pub?.track) await lp.unpublishTrack(pub.track, true);
        micActive.value = !!lp.getTrackPublication(lk.Track.Source.Microphone);
      });
    return micQueue;
  }

  function micFailed(e: unknown) {
    void toastError(e);
    wantMic = false;
    const me = live.room.me?.id;
    if (me) void live.revokeMic(me).catch(() => {});
  }

  /** Turns the microphone on/off as the teacher grants it (the server grants LiveKit permission first). */
  async function setMicGranted(granted: boolean) {
    wantMic = granted;
    if (granted) {
      const deadline = Date.now() + MIC_PERMISSION_WAIT_MS;
      for (;;) {
        const room = conn.current();
        if (room && micAllowed(room)) break;
        if (!wantMic) return;
        if (Date.now() > deadline)
          throw new Error("The media server hasn't allowed your microphone yet. Try again.");
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    await syncMic();
  }

  return {
    media: conn.media,
    video,
    camera,
    audio,
    hostConnected,
    micActive,
    setMicGranted,
    stop: conn.stop,
  };
}
