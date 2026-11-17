import { ref } from 'vue';

/**
 * Dev "automatic recording" (providers whose `startRecording` returns `client-upload`): the teacher's
 * client composites what students see (camera / screen, whiteboard overlay) onto a canvas, mixes the
 * teacher mic with the speaking student, records with MediaRecorder and uploads each part to
 * `POST /live-classes/:id/recordings`. Parts rotate every `segmentMinutes` to bound memory use.
 */
export interface RecorderSources {
  /** Current main video (camera or screen). */
  video: () => HTMLVideoElement | null;
  /** Small camera picture-in-picture while sharing the screen / whiteboard. */
  camera: () => HTMLVideoElement | null;
  /** Whiteboard canvas when it is visible. */
  board: () => HTMLCanvasElement | null;
  audio: () => MediaStream[];
}

const MIME_CANDIDATES = [
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
  'video/mp4',
];

export const recordingSupported = () =>
  typeof MediaRecorder !== 'undefined' &&
  typeof HTMLCanvasElement !== 'undefined' &&
  'captureStream' in HTMLCanvasElement.prototype;

export function useClassRecorder(
  sources: RecorderSources,
  upload: (blob: Blob, seconds: number) => Promise<unknown>,
  segmentMinutes = 30,
) {
  const recording = ref(false);
  const uploading = ref(0);
  const error = ref<string | null>(null);

  const canvas = document.createElement('canvas');
  canvas.width = 1280;
  canvas.height = 720;
  const ctx = canvas.getContext('2d')!;
  let drawTimer: number | undefined;
  let rotateTimer: number | undefined;
  let audioCtx: AudioContext | null = null;
  let dest: MediaStreamAudioDestinationNode | null = null;
  const connected = new Map<string, MediaStreamAudioSourceNode>();
  let recorder: MediaRecorder | null = null;
  let chunks: Blob[] = [];
  let partStartedAt = 0;
  let pending: Promise<unknown> = Promise.resolve();

  function fit(el: CanvasImageSource, w: number, h: number, x: number, y: number, bw: number, bh: number) {
    const scale = Math.min(bw / w, bh / h);
    const dw = w * scale;
    const dh = h * scale;
    ctx.drawImage(el, x + (bw - dw) / 2, y + (bh - dh) / 2, dw, dh);
  }

  function draw() {
    ctx.fillStyle = '#111';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const board = sources.board();
    const video = sources.video();
    if (board) {
      fit(board, board.width, board.height, 0, 0, canvas.width, canvas.height);
      const cam = sources.camera();
      if (cam?.videoWidth)
        fit(cam, cam.videoWidth, cam.videoHeight, canvas.width - 330, canvas.height - 190, 320, 180);
    } else if (video?.videoWidth) {
      fit(video, video.videoWidth, video.videoHeight, 0, 0, canvas.width, canvas.height);
    }
    syncAudio();
  }

  function syncAudio() {
    if (!audioCtx || !dest) return;
    const wanted = new Map<string, MediaStream>();
    for (const s of sources.audio())
      for (const t of s.getAudioTracks()) wanted.set(t.id, new MediaStream([t]));
    for (const [id, node] of connected)
      if (!wanted.has(id)) {
        node.disconnect();
        connected.delete(id);
      }
    for (const [id, stream] of wanted)
      if (!connected.has(id)) {
        const node = audioCtx.createMediaStreamSource(stream);
        node.connect(dest);
        connected.set(id, node);
      }
  }

  function startPart() {
    const mimeType = MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m));
    const stream = new MediaStream([
      ...canvas.captureStream(15).getVideoTracks(),
      ...dest!.stream.getAudioTracks(),
    ]);
    const rec = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 1_200_000 });
    chunks = [];
    partStartedAt = Date.now();
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.onstop = () => {
      const blob = new Blob(chunks, { type: rec.mimeType || 'video/webm' });
      const seconds = (Date.now() - partStartedAt) / 1000;
      if (!blob.size) return;
      uploading.value++;
      pending = pending
        .then(() => upload(blob, seconds))
        .catch((e: Error) => (error.value = e.message))
        .finally(() => uploading.value--);
    };
    rec.start(5000);
    recorder = rec;
  }

  function stopPart() {
    return new Promise<void>((resolve) => {
      if (!recorder || recorder.state === 'inactive') return resolve();
      recorder.addEventListener('stop', () => resolve(), { once: true });
      recorder.stop();
    });
  }

  function start() {
    if (recording.value || !recordingSupported()) return;
    audioCtx = new AudioContext();
    dest = audioCtx.createMediaStreamDestination();
    draw();
    drawTimer = window.setInterval(draw, 1000 / 15);
    startPart();
    rotateTimer = window.setInterval(async () => {
      await stopPart();
      startPart();
    }, segmentMinutes * 60000);
    recording.value = true;
  }

  /** Stops recording and resolves once every part has been uploaded. */
  async function stop() {
    if (!recording.value) return pending;
    recording.value = false;
    clearInterval(rotateTimer);
    await stopPart();
    clearInterval(drawTimer);
    connected.forEach((n) => n.disconnect());
    connected.clear();
    await audioCtx?.close().catch(() => {});
    audioCtx = null;
    return pending;
  }

  return { recording, uploading, error, start, stop };
}
