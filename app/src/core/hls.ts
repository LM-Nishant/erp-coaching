import { getCurrentScope, onScopeDispose, watch, type Ref } from 'vue';
import type Hls from 'hls.js';

/** A video to play: `hls` for an HLS playlist (`.m3u8`), else a plain file URL. */
export interface VideoSource {
  url: string;
  hls: boolean;
}

/** The platform plays HLS itself (Safari, iOS, and Android's WebView and Chrome). */
export function nativeHls(): boolean {
  return document.createElement('video').canPlayType('application/vnd.apple.mpegurl') !== '';
}

/** HLS plays here: natively, or through hls.js on Media Source Extensions (desktop Chrome, Firefox, Edge). */
export function hlsPlayable(): boolean {
  if (nativeHls()) return true;
  const w = globalThis as unknown as Record<
    string,
    { isTypeSupported?: (type: string) => boolean } | undefined
  >;
  const mse = w.ManagedMediaSource ?? w.MediaSource;
  return !!mse?.isTypeSupported?.('video/mp4; codecs="avc1.42E01E,mp4a.40.2"');
}

let hlsJs: Promise<typeof Hls> | null = null;

/** hls.js, loaded once on first use (and again after a failed chunk load). */
function loadHlsJs(): Promise<typeof Hls> {
  hlsJs ??= import('hls.js').then(
    (m) => m.default,
    (e: unknown) => {
      hlsJs = null;
      throw e;
    },
  );
  return hlsJs;
}

/**
 * Plays `source` in `video`: files and natively playable HLS through `src`, other HLS through hls.js
 * (loaded on demand). `onFatal` runs when hls.js gives up (e.g. the signed URL expired), so callers
 * can fetch a fresh URL as they do from the element's `error` event.
 */
export function useVideoSource(
  video: Ref<HTMLVideoElement | null | undefined>,
  source: Ref<VideoSource | null | undefined>,
  onFatal?: () => void,
) {
  let hls: Hls | null = null;
  let seq = 0;
  const detach = () => {
    hls?.destroy();
    hls = null;
  };

  async function attach(el: HTMLVideoElement | null | undefined, src: VideoSource | null | undefined) {
    const mine = ++seq;
    detach();
    if (!el) return;
    if (!src) {
      el.removeAttribute('src');
      return;
    }
    if (!src.hls || nativeHls()) {
      el.src = src.url;
      return;
    }
    const HlsJs = await loadHlsJs().catch(() => null);
    if (mine !== seq) return;
    if (!HlsJs?.isSupported()) {
      // Nothing here can play it (or hls.js failed to load): the element reports the error.
      el.src = src.url;
      return;
    }
    el.removeAttribute('src');
    const h = new HlsJs();
    hls = h;
    h.on(HlsJs.Events.ERROR, (_event, data) => {
      if (!data.fatal || hls !== h) return;
      detach();
      onFatal?.();
    });
    h.loadSource(src.url);
    h.attachMedia(el);
  }

  watch([video, source], ([el, src]) => void attach(el, src), { immediate: true, flush: 'post' });
  if (getCurrentScope())
    onScopeDispose(() => {
      seq++;
      detach();
    });
}
