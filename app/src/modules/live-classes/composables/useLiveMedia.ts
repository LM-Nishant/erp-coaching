import { ref, shallowRef } from 'vue';
import { LIVE_SERVER_EVENTS, type LiveJoinInfo, type LiveUserRef, type RtcSignal } from '@erp/shared';
import type { LiveSocket } from './useLiveSocket';

/**
 * Dev WebRTC media (provider `dev-webrtc`): a star topology where the teacher's client is the hub.
 *
 * The teacher opens one RTCPeerConnection per participant with three fixed transceivers:
 *   0 video sendonly  – camera, or the screen while sharing (swapped with replaceTrack)
 *   1 audio sendonly  – teacher microphone
 *   2 audio sendrecv  – the "speaker slot": receives the student's mic once the teacher grants it and
 *                       relays the current speaker's audio to everyone else
 * so granting/revoking a mic or sharing the screen never needs renegotiation. Signalling runs over
 * the live socket (`rtc:signal`), which the server only relays between teacher and participants.
 * A participant sends an empty signal ("hello") to ask the teacher for a fresh offer.
 *
 * Suitable for small classes / demos. Vendor adapters (LiveKit, 100ms, Agora…) replace this with an
 * SFU: use `joinInfo.url` + `joinInfo.token` with their SDK instead (see backend README).
 */

const SPEAKER_SLOT = 2;

function rtcConfig(info: LiveJoinInfo): RTCConfiguration {
  return { iceServers: info.iceServers as RTCIceServer[] };
}

async function applySignal(pc: RTCPeerConnection, s: RtcSignal) {
  if (s.description) await pc.setRemoteDescription(s.description as RTCSessionDescriptionInit);
  else if (s.candidate) await pc.addIceCandidate(s.candidate as RTCIceCandidateInit).catch(() => {});
}

/* ------------------------------------------------------------------ teacher */

interface Peer {
  pc: RTCPeerConnection;
  video: RTCRtpTransceiver;
  audio: RTCRtpTransceiver;
  slot: RTCRtpTransceiver;
}

export function useTeacherMedia(live: LiveSocket, info: LiveJoinInfo) {
  const camera = shallowRef<MediaStream | null>(null);
  const screen = shallowRef<MediaStream | null>(null);
  /** What students currently see (camera or screen). */
  const preview = shallowRef<MediaStream | null>(null);
  /** Audio of the student who currently has the mic (played locally + relayed + recorded). */
  const speakerAudio = shallowRef<MediaStream | null>(null);
  const camOn = ref(true);
  const micOn = ref(true);
  const peers = new Map<number, Peer>();
  let speakerId: number | null = null;

  const videoTrack = () => (screen.value ?? camera.value)?.getVideoTracks()[0] ?? null;
  const micTrack = () => camera.value?.getAudioTracks()[0] ?? null;

  async function startCamera() {
    camera.value = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 24 } },
      audio: { echoCancellation: true, noiseSuppression: true },
    });
    preview.value = screen.value ?? camera.value;
    for (const p of peers.values()) {
      await p.video.sender.replaceTrack(videoTrack()).catch(() => {});
      await p.audio.sender.replaceTrack(micTrack()).catch(() => {});
    }
  }

  function closePeer(userId: number) {
    peers.get(userId)?.pc.close();
    peers.delete(userId);
  }

  async function connect(userId: number) {
    closePeer(userId);
    const pc = new RTCPeerConnection(rtcConfig(info));
    const video = pc.addTransceiver(videoTrack() ?? 'video', { direction: 'sendonly' });
    const audio = pc.addTransceiver(micTrack() ?? 'audio', { direction: 'sendonly' });
    const slot = pc.addTransceiver('audio', { direction: 'sendrecv' });
    const peer = { pc, video, audio, slot };
    peers.set(userId, peer);
    if (speakerId && speakerId !== userId) {
      const t = peers.get(speakerId)?.slot.receiver.track;
      if (t) await slot.sender.replaceTrack(t);
    }
    pc.onicecandidate = (e) =>
      e.candidate && void live.signal({ to: userId, candidate: e.candidate.toJSON() });
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') void connect(userId);
    };
    await pc.setLocalDescription(await pc.createOffer());
    await live.signal({ to: userId, description: pc.localDescription!.toJSON() });
  }

  live.onSignal((s) => {
    const peer = peers.get(s.from);
    if (!s.description && !s.candidate) return void connect(s.from).catch(() => closePeer(s.from));
    if (peer) void applySignal(peer.pc, s);
  });
  live.socket.on(LIVE_SERVER_EVENTS.participantLeft, ({ userId }: { userId: number }) => closePeer(userId));
  // Online participants ask for an offer themselves (hello); this covers the teacher reconnecting.
  live.onJoined((state) => {
    for (const p of state.participants) if (p.online && p.userId !== state.me.id) void connect(p.userId);
  });

  /** Routes the granted student's audio to everyone else; called when `speakers` changes. */
  async function setSpeakers(speakers: LiveUserRef[]) {
    speakerId = speakers[0]?.id ?? null;
    const track = speakerId ? (peers.get(speakerId)?.slot.receiver.track ?? null) : null;
    speakerAudio.value = track ? new MediaStream([track]) : null;
    for (const [uid, p] of peers)
      await p.slot.sender.replaceTrack(uid === speakerId ? null : track).catch(() => {});
  }

  async function replaceVideo() {
    const t = videoTrack();
    preview.value = screen.value ?? camera.value;
    for (const p of peers.values()) await p.video.sender.replaceTrack(t).catch(() => {});
  }

  const canShareScreen = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getDisplayMedia;

  async function startScreen() {
    screen.value = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 15 }, audio: false });
    screen.value.getVideoTracks()[0].addEventListener('ended', () => void stopScreen());
    await replaceVideo();
    await live.setScreen(true);
  }
  async function stopScreen() {
    screen.value?.getTracks().forEach((t) => t.stop());
    screen.value = null;
    await replaceVideo();
    await live.setScreen(false).catch(() => {});
  }

  function toggleCam() {
    camOn.value = !camOn.value;
    camera.value?.getVideoTracks().forEach((t) => (t.enabled = camOn.value));
  }
  function toggleMic() {
    micOn.value = !micOn.value;
    camera.value?.getAudioTracks().forEach((t) => (t.enabled = micOn.value));
  }

  function stop() {
    for (const id of [...peers.keys()]) closePeer(id);
    camera.value?.getTracks().forEach((t) => t.stop());
    screen.value?.getTracks().forEach((t) => t.stop());
  }

  return {
    camera,
    screen,
    preview,
    speakerAudio,
    camOn,
    micOn,
    canShareScreen,
    startCamera,
    connect,
    closePeer,
    setSpeakers,
    startScreen,
    stopScreen,
    toggleCam,
    toggleMic,
    stop,
  };
}

/* ------------------------------------------------------------------ student / viewer */

export function useViewerMedia(live: LiveSocket, info: LiveJoinInfo) {
  const video = shallowRef<MediaStream | null>(null);
  const audio = shallowRef<MediaStream | null>(null);
  const micActive = ref(false);
  const state = ref<RTCPeerConnectionState>('new');
  let pc: RTCPeerConnection | null = null;
  let hostId: number | null = null;
  let mic: MediaStream | null = null;

  async function handleOffer(s: RtcSignal & { from: number }) {
    pc?.close();
    hostId = s.from;
    const conn = new RTCPeerConnection(rtcConfig(info));
    pc = conn;
    const v = new MediaStream();
    const a = new MediaStream();
    conn.ontrack = (e) => {
      (e.track.kind === 'video' ? v : a).addTrack(e.track);
      video.value = new MediaStream(v.getTracks());
      audio.value = new MediaStream(a.getTracks());
    };
    conn.onicecandidate = (e) =>
      e.candidate && void live.signal({ to: s.from, candidate: e.candidate.toJSON() });
    conn.onconnectionstatechange = () => {
      state.value = conn.connectionState;
      if (conn.connectionState === 'failed') hello();
    };
    await conn.setRemoteDescription(s.description as RTCSessionDescriptionInit);
    const slot = conn.getTransceivers()[SPEAKER_SLOT];
    if (slot) {
      slot.direction = 'sendrecv';
      if (mic) await slot.sender.replaceTrack(mic.getAudioTracks()[0]);
    }
    await conn.setLocalDescription(await conn.createAnswer());
    await live.signal({ to: s.from, description: conn.localDescription!.toJSON() });
  }

  live.onSignal((s) => {
    if (s.description?.type === 'offer') void handleOffer(s);
    else if (pc && s.from === hostId) void applySignal(pc, s);
  });

  function hello() {
    const host = live.room.participants.find((p) => p.role === 'host' && p.online);
    if (host) void live.signal({ to: host.userId }).catch(() => {});
  }
  live.onJoined((st) => st.hostOnline && hello());
  live.socket.on(LIVE_SERVER_EVENTS.hostState, ({ online }: { online: boolean }) => {
    if (online) setTimeout(hello, 300);
    else {
      pc?.close();
      pc = null;
      video.value = null;
      audio.value = null;
    }
  });

  /** Turns the student's microphone on/off according to the teacher's grant. */
  async function setMicGranted(granted: boolean) {
    const slot = pc?.getTransceivers()[SPEAKER_SLOT];
    if (granted && !mic) {
      mic = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      await slot?.sender.replaceTrack(mic.getAudioTracks()[0]);
      micActive.value = true;
    } else if (!granted && mic) {
      await slot?.sender.replaceTrack(null);
      mic.getTracks().forEach((t) => t.stop());
      mic = null;
      micActive.value = false;
    }
  }

  function stop() {
    pc?.close();
    pc = null;
    mic?.getTracks().forEach((t) => t.stop());
    mic = null;
  }

  return { video, audio, micActive, state, hello, setMicGranted, stop };
}
