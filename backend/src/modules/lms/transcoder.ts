import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';

/**
 * Video → HLS transcoding. The default implementation shells out to a local `ffmpeg`
 * (override the binary with `FFMPEG_PATH`); when it is missing, videos are delivered as
 * progressive MP4 with HTTP Range support instead. Tests and future cloud transcoders plug in with
 * `setVideoTranscoder()`.
 */
export interface VideoTranscoder {
  available(): Promise<boolean>;
  /** Writes `index.m3u8` and its segments into `outDir`; returns the produced file names. */
  toHls(inputPath: string, outDir: string): Promise<string[]>;
}

function run(bin: string, args: string[], timeoutMs: number): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    let stderr = '';
    let child;
    try {
      child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (err) {
      resolve({ code: -1, stderr: (err as Error).message });
      return;
    }
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stderr?.on('data', (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-4000);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stderr: err.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stderr });
    });
  });
}

export class FfmpegTranscoder implements VideoTranscoder {
  private detected: boolean | null = null;
  constructor(private readonly bin = process.env.FFMPEG_PATH || 'ffmpeg') {}

  async available(): Promise<boolean> {
    this.detected ??= (await run(this.bin, ['-version'], 10_000)).code === 0;
    return this.detected;
  }

  async toHls(inputPath: string, outDir: string): Promise<string[]> {
    await fsp.mkdir(outDir, { recursive: true });
    const { code, stderr } = await run(
      this.bin,
      [
        '-y',
        '-i',
        inputPath,
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-crf',
        '23',
        '-c:a',
        'aac',
        '-b:a',
        '128k',
        '-f',
        'hls',
        '-hls_time',
        '6',
        '-hls_playlist_type',
        'vod',
        '-hls_segment_filename',
        path.join(outDir, 'seg_%05d.ts'),
        path.join(outDir, 'index.m3u8'),
      ],
      6 * 3600_000,
    );
    if (code !== 0) throw new Error(`ffmpeg failed (${code}): ${stderr.slice(-400)}`);
    return (await fsp.readdir(outDir)).filter((f) => /^(index\.m3u8|seg_\d+\.ts)$/.test(f));
  }
}

let transcoder: VideoTranscoder = new FfmpegTranscoder();

export function getVideoTranscoder(): VideoTranscoder {
  return transcoder;
}

export function setVideoTranscoder(t: VideoTranscoder): void {
  transcoder = t;
}
