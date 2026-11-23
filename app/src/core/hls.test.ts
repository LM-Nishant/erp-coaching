import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, nextTick, ref } from 'vue';
import { hlsPlayable, useVideoSource, type VideoSource } from './hls';

const { FakeHls, players } = vi.hoisted(() => {
  type ErrorHandler = (event: string, data: { fatal: boolean }) => void;
  const players: InstanceType<typeof FakeHls>[] = [];
  class FakeHls {
    static isSupported = () => true;
    static Events = { ERROR: 'hlsError', MANIFEST_PARSED: 'hlsManifestParsed' };
    onError: ErrorHandler | null = null;
    onManifest: (() => void) | null = null;
    levels: { height: number }[] = [];
    nextLevel = -1;
    currentLevel = -1;
    loadSource = vi.fn();
    attachMedia = vi.fn();
    destroy = vi.fn();
    constructor() {
      players.push(this);
    }
    on(event: string, fn: ErrorHandler) {
      if (event === FakeHls.Events.ERROR) this.onError = fn;
      else this.onManifest = fn as () => void;
    }
  }
  return { FakeHls, players };
});
vi.mock('hls.js', () => ({ default: FakeHls }));

let nativeHls: CanPlayTypeResult = '';
beforeEach(() => {
  players.length = 0;
  nativeHls = '';
  vi.spyOn(HTMLMediaElement.prototype, 'canPlayType').mockImplementation((type) =>
    type === 'application/vnd.apple.mpegurl' ? nativeHls : '',
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function play(initial: VideoSource | null) {
  const el = document.createElement('video');
  const source = ref<VideoSource | null>(initial);
  const onFatal = vi.fn();
  const scope = effectScope();
  const controls = scope.run(() => useVideoSource(ref(el), source, onFatal))!;
  return { el, source, onFatal, scope, ...controls };
}

describe('HLS playback', () => {
  it('plays files and natively supported HLS through src, without hls.js', async () => {
    nativeHls = 'maybe';
    const { el, source } = play({ url: 'https://api.test/hls/t/index.m3u8', hls: true });
    expect(el.getAttribute('src')).toBe('https://api.test/hls/t/index.m3u8');

    nativeHls = '';
    source.value = { url: 'https://api.test/files/rec.mp4', hls: false };
    await nextTick();
    expect(el.getAttribute('src')).toBe('https://api.test/files/rec.mp4');
    expect(players).toHaveLength(0);
  });

  it('uses hls.js where HLS is not native, and reports when it gives up', async () => {
    const { el, onFatal } = play({ url: 'https://api.test/hls/t/index.m3u8', hls: true });
    await vi.waitFor(() => expect(players).toHaveLength(1));
    const [player] = players;
    expect(player.loadSource).toHaveBeenCalledWith('https://api.test/hls/t/index.m3u8');
    expect(player.attachMedia).toHaveBeenCalledWith(el);
    expect(el.getAttribute('src')).toBeNull();

    player.onError!('hlsError', { fatal: false });
    expect(onFatal).not.toHaveBeenCalled();
    player.onError!('hlsError', { fatal: true });
    expect(onFatal).toHaveBeenCalledTimes(1);
    expect(player.destroy).toHaveBeenCalled();
  });

  it('lists the stream qualities and switches to the chosen one', async () => {
    const { qualities, quality } = play({ url: 'https://api.test/hls/t/index.m3u8', hls: true });
    await vi.waitFor(() => expect(players).toHaveLength(1));
    const [player] = players;
    player.levels = [{ height: 720 }, { height: 360 }, { height: 720 }];
    player.onManifest!();
    expect(qualities.value).toEqual([360, 720]);

    quality.value = 360;
    await nextTick();
    expect(player.nextLevel).toBe(1);
    quality.value = -1;
    await nextTick();
    expect(player.nextLevel).toBe(-1);
    expect(player.currentLevel).toBe(-1);
  });

  it('replaces the player when the URL changes and destroys it when the source or page goes away', async () => {
    const { source, scope } = play({ url: 'https://api.test/hls/a/index.m3u8', hls: true });
    await vi.waitFor(() => expect(players).toHaveLength(1));

    // Refreshed signed URLs in quick succession: whatever loads first, only the latest one plays.
    source.value = { url: 'https://api.test/hls/b/index.m3u8', hls: true };
    await nextTick();
    source.value = { url: 'https://api.test/hls/c/index.m3u8', hls: true };
    await nextTick();
    const live = () => players.filter((p) => !p.destroy.mock.calls.length);
    await vi.waitFor(() =>
      expect(live()[0]?.loadSource).toHaveBeenCalledWith('https://api.test/hls/c/index.m3u8'),
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(live()).toHaveLength(1);
    expect(players[0].destroy).toHaveBeenCalled();

    scope.stop();
    expect(live()).toHaveLength(0);
  });

  it('knows whether HLS can play here at all', () => {
    expect(hlsPlayable()).toBe(false);
    vi.stubGlobal('MediaSource', { isTypeSupported: () => true });
    expect(hlsPlayable()).toBe(true);
    vi.unstubAllGlobals();
    nativeHls = 'maybe';
    expect(hlsPlayable()).toBe(true);
  });
});
