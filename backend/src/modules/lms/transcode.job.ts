import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { getStorage } from '../../infrastructure/storage';
import { logger } from '../../infrastructure/logger';
import { requireTenantContext } from '../../shared/context';
import { FileObject } from '../files/file.model';
import { LmsResource } from './models';
import { getVideoTranscoder } from './transcoder';

export const TRANSCODE_JOB = 'lms.transcode';

/** Name of the index written next to the segments, so a later run can delete the old rendition. */
const MANIFEST = 'manifest.json';

export async function removeRendition(prefix: string | null) {
  if (!prefix) return;
  const storage = getStorage();
  try {
    const chunks: Buffer[] = [];
    for await (const c of await storage.getStream(`${prefix}/${MANIFEST}`)) chunks.push(c as Buffer);
    const names = JSON.parse(Buffer.concat(chunks).toString()) as string[];
    for (const n of [...names, MANIFEST]) await storage.delete(`${prefix}/${n}`);
  } catch {
    /* already gone */
  }
}

/**
 * Converts an uploaded lecture to HLS. When ffmpeg is unavailable the resource keeps streaming as
 * progressive MP4 (`transcodeStatus = unavailable`); failures are recorded, never retried endlessly.
 */
export async function runTranscode(payload: { resourceId: number }) {
  const { instituteId } = requireTenantContext();
  const r = await LmsResource.findOne({ where: { instituteId, id: payload.resourceId } });
  if (!r || r.type !== 'video' || !r.fileId) return;
  const file = await FileObject.findOne({ where: { instituteId, id: r.fileId } });
  if (!file) return;
  const transcoder = getVideoTranscoder();
  if (!(await transcoder.available())) {
    await r.update({ transcodeStatus: 'unavailable', transcodeError: null });
    return;
  }
  await r.update({ transcodeStatus: 'processing', transcodeError: null });
  const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'lms-hls-'));
  const prefix = `institutes/${instituteId}/lms/hls/${r.id}-${crypto.randomBytes(6).toString('hex')}`;
  const storage = getStorage();
  try {
    const input = path.join(work, 'source');
    await pipeline(await storage.getStream(file.storageKey), fs.createWriteStream(input));
    const outDir = path.join(work, 'out');
    const names = await transcoder.toHls(input, outDir);
    if (!names.includes('index.m3u8')) throw new Error('Transcoder produced no playlist');
    for (const n of names)
      await storage.putFile(
        `${prefix}/${n}`,
        path.join(outDir, n),
        n.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t',
      );
    await storage.putBuffer(`${prefix}/${MANIFEST}`, Buffer.from(JSON.stringify(names)), 'application/json');
    // the file may have been replaced while we worked
    const current = await LmsResource.findOne({ where: { instituteId, id: r.id } });
    if (!current || current.fileId !== file.id) {
      await removeRendition(prefix);
      return;
    }
    const previous = current.hlsPrefix;
    await current.update({ transcodeStatus: 'ready', hlsPrefix: prefix, transcodeError: null });
    if (previous && previous !== prefix) await removeRendition(previous);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ resourceId: r.id }, `LMS transcode failed: ${message}`);
    await removeRendition(prefix);
    await r.update({ transcodeStatus: 'failed', transcodeError: message.slice(0, 1000) });
  } finally {
    await fsp.rm(work, { recursive: true, force: true });
  }
}

/** Serves one HLS file of a resource (playlist or segment). Names are validated by the caller. */
export async function openHlsFile(instituteId: number, resourceId: number, name: string) {
  const r = await LmsResource.findOne({ where: { instituteId, id: resourceId } });
  if (!r?.hlsPrefix || r.transcodeStatus !== 'ready') return null;
  const key = `${r.hlsPrefix}/${name}`;
  const stat = await getStorage().stat(key);
  if (!stat) return null;
  return { stream: await getStorage().getStream(key), size: stat.size };
}
