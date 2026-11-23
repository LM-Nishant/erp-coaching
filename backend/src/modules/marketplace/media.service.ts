import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import {
  MKT_MAX_IMAGE_BYTES,
  MKT_MAX_RESOURCE_BYTES,
  MKT_MAX_VIDEO_BYTES,
  MKT_UPLOAD_CHUNK_BYTES,
  type MktMediaDto,
  type MktMediaKind,
  type MktStreamDto,
} from '@erp/shared';
import { config } from '../../infrastructure/config';
import { hmac, safeEqual } from '../../infrastructure/crypto';
import { getSequelize } from '../../infrastructure/database/sequelize';
import { enqueueJob } from '../../infrastructure/jobs/queue';
import { logger } from '../../infrastructure/logger';
import { getStorage } from '../../infrastructure/storage';
import { getContext } from '../../shared/context';
import { BadRequest, Conflict, NotFound } from '../../shared/errors';
import { isBlockedUploadType } from '../../shared/utilities/file-response';
import { getVideoTranscoder, removeRendition } from '../lms/api';
import { MktMedia } from './models';

export const MKT_TRANSCODE_JOB = 'marketplace.transcode';
export const TMP_DIR = path.resolve(__dirname, '../../../tmp/marketplace-uploads');
export const HLS_NAME = /^(index\.m3u8|seg_\d{1,6}\.ts)$/;
const MANIFEST = 'manifest.json';

const IMAGE_TYPES = /^image\/(png|jpe?g|webp|gif)$/;
const LIMITS: Record<MktMediaKind, number> = {
  video: MKT_MAX_VIDEO_BYTES,
  image: MKT_MAX_IMAGE_BYTES,
  file: MKT_MAX_RESOURCE_BYTES,
};

// ---------------------------------------------------------------- signed media links

/** Claims of a marketplace media link: media id, user id (0 = anyone), expiry (unix seconds). */
interface MediaClaims {
  m: number;
  u: number;
  e: number;
}

const secret = () => `${config.FILE_URL_SECRET}:mkt-media`;

export function signMediaToken(mediaId: number, userId: number, expiresAtSec: number) {
  const body = Buffer.from(JSON.stringify({ m: mediaId, u: userId, e: expiresAtSec })).toString('base64url');
  return `${body}.${hmac(body, secret())}`;
}

export function verifyMediaToken(token: string): MediaClaims | null {
  const [body, sig] = token.split('.');
  if (!body || !sig || !safeEqual(sig, hmac(body, secret()))) return null;
  try {
    const c = JSON.parse(Buffer.from(body, 'base64url').toString()) as MediaClaims;
    if (typeof c.m !== 'number' || typeof c.e !== 'number' || c.e < Date.now() / 1000) return null;
    return c;
  } catch {
    return null;
  }
}

const api = (p: string) => `${config.API_PUBLIC_URL}/api/marketplace/public/${p}`;

/**
 * Public link to an image (thumbnail, avatar). The expiry is rounded to a week boundary so the URL
 * stays stable for days and browsers/CDNs can cache it.
 */
export function imageUrl(m: MktMedia): string | null {
  if (m.kind !== 'image' || m.status !== 'ready') return null;
  const week = 7 * 86400;
  const e = (Math.floor(Date.now() / 1000 / week) + 2) * week;
  return api(`media/${signMediaToken(m.id, 0, e)}`);
}

/** Short-lived playback link for a video, bound to the viewer (0 for anonymous previews). */
export function streamFor(m: MktMedia, userId: number): MktStreamDto | null {
  if (m.kind !== 'video' || m.status !== 'ready') return null;
  const base = config.SIGNED_URL_TTL_SECONDS;
  const ttl = Math.min(Math.max(base, (m.durationSeconds ?? 3600) + 900), 6 * 3600);
  const e = Math.floor(Date.now() / 1000) + ttl;
  const token = signMediaToken(m.id, userId, e);
  return {
    hlsUrl: m.hlsPrefix ? api(`hls/${token}/index.m3u8`) : null,
    fileUrl: api(`media/${token}`),
    expiresAt: new Date(e * 1000).toISOString(),
  };
}

/** Short-lived download link for a resource file. */
export function downloadUrl(m: MktMedia, userId: number): string {
  return api(
    `media/${signMediaToken(m.id, userId, Math.floor(Date.now() / 1000) + config.SIGNED_URL_TTL_SECONDS)}`,
  );
}

export function toMediaDto(m: MktMedia): MktMediaDto {
  return {
    id: m.id,
    kind: m.kind,
    originalName: m.originalName,
    mimeType: m.mimeType,
    sizeBytes: m.sizeBytes,
    status: m.status,
    error: m.error,
    durationSeconds: m.durationSeconds,
    receivedBytes: m.receivedBytes,
    url: m.kind === 'image' ? imageUrl(m) : null,
  };
}

// ---------------------------------------------------------------- resumable uploads

const partPath = (id: number) => path.join(TMP_DIR, `${id}.part`);

export async function startMediaUpload(
  sellerId: number,
  input: {
    kind: MktMediaKind;
    name: string;
    mimeType: string;
    sizeBytes: number;
    durationSeconds?: number | null;
  },
): Promise<MktMediaDto> {
  const mime = input.mimeType.toLowerCase();
  if (isBlockedUploadType(mime)) throw BadRequest('This file type is not allowed');
  if (input.kind === 'image' && !IMAGE_TYPES.test(mime))
    throw BadRequest('Upload a PNG, JPEG, WebP or GIF image');
  if (input.kind === 'video' && !mime.startsWith('video/')) throw BadRequest('Upload a video file');
  if (input.sizeBytes > LIMITS[input.kind]) throw BadRequest('File is too large');
  await fsp.mkdir(TMP_DIR, { recursive: true });
  const m = await MktMedia.create({
    sellerId,
    uploadedByUserId: getContext().userId ?? null,
    kind: input.kind,
    originalName: input.name.slice(0, 255),
    mimeType: mime,
    sizeBytes: input.sizeBytes,
    storageKey: `marketplace/sellers/${sellerId}/media/${crypto.randomBytes(12).toString('hex')}`,
    durationSeconds: input.durationSeconds ?? null,
  });
  await fsp.writeFile(partPath(m.id), Buffer.alloc(0));
  return toMediaDto(m);
}

export async function sellerMedia(sellerId: number, id: number): Promise<MktMedia> {
  const m = await MktMedia.findOne({ where: { id, sellerId } });
  if (!m) throw NotFound('Media');
  return m;
}

/**
 * Appends one chunk at `offset` (must equal the bytes received so far; 409 `OFFSET_MISMATCH`
 * tells the client where to resume). The last chunk finishes the upload.
 */
export async function appendMediaChunk(sellerId: number, id: number, offset: number, chunk: Buffer) {
  await sellerMedia(sellerId, id);
  if (!chunk.length) throw BadRequest('Empty chunk');
  if (chunk.length > MKT_UPLOAD_CHUNK_BYTES) throw BadRequest('Chunk is too large');
  const done = await getSequelize().transaction(async (transaction) => {
    const m = (await MktMedia.findOne({
      where: { id, sellerId },
      lock: transaction.LOCK.UPDATE,
      transaction,
    }))!;
    if (m.status !== 'uploading') throw Conflict('Upload is no longer active', 'UPLOAD_CLOSED');
    if (offset !== m.receivedBytes)
      throw Conflict('Chunk offset does not match the received bytes', 'OFFSET_MISMATCH', {
        receivedBytes: m.receivedBytes,
      });
    if (m.receivedBytes + chunk.length > m.sizeBytes) throw BadRequest('Chunk exceeds the declared size');
    if (!fs.existsSync(partPath(id))) throw Conflict('Upload data is missing; start again', 'UPLOAD_LOST');
    const fd = await fsp.open(partPath(id), 'r+');
    try {
      await fd.write(chunk, 0, chunk.length, offset);
      await fd.truncate(offset + chunk.length);
    } finally {
      await fd.close();
    }
    await m.update({ receivedBytes: offset + chunk.length }, { transaction });
    return m.receivedBytes === m.sizeBytes;
  });
  if (done) await finishUpload(id);
  return toMediaDto((await MktMedia.findByPk(id))!);
}

async function finishUpload(id: number) {
  const m = (await MktMedia.findByPk(id))!;
  await getStorage().putFile(m.storageKey, partPath(id), m.mimeType);
  await fsp.rm(partPath(id), { force: true });
  if (m.kind === 'video') {
    await m.update({ status: 'processing' });
    await enqueueJob(MKT_TRANSCODE_JOB, { mediaId: m.id }, { instituteId: null });
  } else {
    await m.update({ status: 'ready' });
  }
}

/** Stores a buffer directly as a ready media item (demo seed, tests). */
export async function saveMediaBuffer(
  sellerId: number,
  input: {
    kind: MktMediaKind;
    name: string;
    mimeType: string;
    data: Buffer;
    durationSeconds?: number | null;
  },
): Promise<MktMedia> {
  const storageKey = `marketplace/sellers/${sellerId}/media/${crypto.randomBytes(12).toString('hex')}`;
  await getStorage().putBuffer(storageKey, input.data, input.mimeType);
  return MktMedia.create({
    sellerId,
    uploadedByUserId: getContext().userId ?? null,
    kind: input.kind,
    originalName: input.name,
    mimeType: input.mimeType,
    sizeBytes: input.data.length,
    receivedBytes: input.data.length,
    storageKey,
    status: 'ready',
    durationSeconds: input.durationSeconds ?? null,
  });
}

/**
 * Converts an uploaded video to HLS. Without ffmpeg the video stays playable as progressive MP4
 * with Range requests, so it is marked ready either way; only a failed conversion is an error.
 */
export async function runMarketplaceTranscode(payload: { mediaId: number }) {
  const m = await MktMedia.findByPk(payload.mediaId);
  if (!m || m.kind !== 'video' || m.status !== 'processing') return;
  const transcoder = getVideoTranscoder();
  if (!(await transcoder.available())) {
    await m.update({ status: 'ready', error: null });
    return;
  }
  const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'mkt-hls-'));
  const prefix = `marketplace/sellers/${m.sellerId}/hls/${m.id}-${crypto.randomBytes(6).toString('hex')}`;
  const storage = getStorage();
  try {
    const input = path.join(work, 'source');
    await pipeline(await storage.getStream(m.storageKey), fs.createWriteStream(input));
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
    const previous = m.hlsPrefix;
    await m.update({ status: 'ready', hlsPrefix: prefix, error: null });
    if (previous && previous !== prefix) await removeRendition(previous);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ mediaId: m.id }, `Marketplace transcode failed: ${message}`);
    await removeRendition(prefix);
    // The original still plays as MP4; keep the media usable and record the problem.
    await m.update({ status: 'ready', error: `HLS conversion failed: ${message}`.slice(0, 1000) });
  } finally {
    await fsp.rm(work, { recursive: true, force: true });
  }
}

/** Media a token unlocks; null when the token is invalid or the media is gone. */
export async function mediaForToken(token: string) {
  const claims = verifyMediaToken(token);
  if (!claims) return null;
  const m = await MktMedia.findByPk(claims.m);
  return m && m.status === 'ready' ? m : null;
}
