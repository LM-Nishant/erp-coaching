import fsp, { type FileHandle } from 'node:fs/promises';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import zlib from 'node:zlib';

const MAX32 = 0xffffffff;
const MAX16 = 0xffff;
const UTF8_FLAG = 0x0800;

let crcTable: Uint32Array | null = null;

function crc32Js(buf: Buffer, crc: number): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = (crc ^ MAX32) >>> 0;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ MAX32) >>> 0;
}

// zlib.crc32 needs Node >= 22.2; fall back to a table implementation on older runtimes.
const nativeCrc32 = (zlib as { crc32?: (data: Buffer, value?: number) => number }).crc32;

export function crc32(buf: Buffer, crc = 0): number {
  return nativeCrc32 ? nativeCrc32(buf, crc) >>> 0 : crc32Js(buf, crc);
}

function dosDateTime(d: Date) {
  const year = Math.min(Math.max(d.getUTCFullYear(), 1980), 2107);
  return {
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | Math.floor(d.getUTCSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
  };
}

/** Archive paths: forward slashes, no leading slash, no `.`/`..` segments. */
export function normalizeEntryName(name: string): string {
  const parts = name.replace(/\\/g, '/').split('/').filter(Boolean);
  if (!parts.length || parts.some((p) => p === '.' || p === '..'))
    throw new Error(`Invalid zip entry name: ${name}`);
  return parts.join('/');
}

interface CentralEntry {
  name: Buffer;
  method: 0 | 8;
  crc: number;
  size: number;
  compressedSize: number;
  offset: number;
  time: number;
  date: number;
}

export type ZipSource = Buffer | string | AsyncIterable<Buffer | string>;

export interface AddEntryOptions {
  /** Deflate the entry (default). Already-compressed media should be stored. */
  compress?: boolean;
  /** Exact size of a stored entry, when known; required for entries of 4 GiB or more. */
  size?: number;
  mtime?: Date;
}

/**
 * Minimal streaming ZIP writer (APPNOTE 6.3) that writes to a seekable file, so local headers are
 * patched with the CRC and sizes after the data (no data descriptors). ZIP64 is used for large
 * stored entries, offsets beyond 4 GiB and more than 65 535 entries. Deflated entries of unknown
 * size must stay below 4 GiB; callers split large content into parts.
 */
export class ZipWriter {
  private position = 0;
  private readonly entries: CentralEntry[] = [];
  private readonly names = new Set<string>();
  private closed = false;

  private constructor(
    private readonly fh: FileHandle,
    readonly path: string,
  ) {}

  static async create(path: string): Promise<ZipWriter> {
    return new ZipWriter(await fsp.open(path, 'wx'), path);
  }

  get entryCount() {
    return this.entries.length;
  }

  get bytesWritten() {
    return this.position;
  }

  private async writeAt(buf: Buffer, position: number) {
    let done = 0;
    while (done < buf.length) {
      const { bytesWritten } = await this.fh.write(buf, done, buf.length - done, position + done);
      done += bytesWritten;
    }
  }

  private async append(buf: Buffer) {
    await this.writeAt(buf, this.position);
    this.position += buf.length;
  }

  async add(name: string, source: ZipSource, opts: AddEntryOptions = {}): Promise<{ size: number }> {
    if (this.closed) throw new Error('Zip archive already finished');
    const entryName = normalizeEntryName(name);
    if (this.names.has(entryName)) throw new Error(`Duplicate zip entry: ${entryName}`);
    this.names.add(entryName);
    const compress = opts.compress ?? true;
    const zip64Local = !compress && opts.size !== undefined && opts.size >= MAX32;
    const nameBuf = Buffer.from(entryName, 'utf8');
    const { time, date } = dosDateTime(opts.mtime ?? new Date());
    const offset = this.position;

    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(zip64Local ? 45 : 20, 4);
    header.writeUInt16LE(UTF8_FLAG, 6);
    header.writeUInt16LE(compress ? 8 : 0, 8);
    header.writeUInt16LE(time, 10);
    header.writeUInt16LE(date, 12);
    // CRC and sizes (bytes 14–25) are patched once the data has been written.
    header.writeUInt16LE(nameBuf.length, 26);
    header.writeUInt16LE(zip64Local ? 20 : 0, 28);
    await this.append(Buffer.concat([header, nameBuf, Buffer.alloc(zip64Local ? 20 : 0)]));

    let crc = 0;
    let size = 0;
    let compressedSize = 0;
    const iterable: AsyncIterable<Buffer | string> | Iterable<Buffer | string> =
      typeof source === 'string' || Buffer.isBuffer(source) ? [source] : source;
    async function* tap() {
      for await (const chunk of iterable) {
        const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
        if (!buf.length) continue;
        crc = crc32(buf, crc);
        size += buf.length;
        yield buf;
      }
    }
    const sink = new Writable({
      write: (chunk: Buffer, _encoding, callback) => {
        this.append(chunk).then(() => {
          compressedSize += chunk.length;
          callback();
        }, callback);
      },
    });
    const input = Readable.from(tap(), { objectMode: false });
    if (compress) await pipeline(input, zlib.createDeflateRaw({ level: 6 }), sink);
    else await pipeline(input, sink);

    if (opts.size !== undefined && size !== opts.size)
      throw new Error(`Zip entry ${entryName}: expected ${opts.size} bytes, read ${size}`);
    if (!zip64Local && (size >= MAX32 || compressedSize >= MAX32))
      throw new Error(`Zip entry ${entryName} is 4 GiB or larger; split it into parts`);

    const patch = Buffer.alloc(12);
    patch.writeUInt32LE(crc, 0);
    patch.writeUInt32LE(zip64Local ? MAX32 : compressedSize, 4);
    patch.writeUInt32LE(zip64Local ? MAX32 : size, 8);
    await this.writeAt(patch, offset + 14);
    if (zip64Local) {
      const extra = Buffer.alloc(20);
      extra.writeUInt16LE(0x0001, 0);
      extra.writeUInt16LE(16, 2);
      extra.writeBigUInt64LE(BigInt(size), 4);
      extra.writeBigUInt64LE(BigInt(compressedSize), 12);
      await this.writeAt(extra, offset + 30 + nameBuf.length);
    }
    this.entries.push({
      name: nameBuf,
      method: compress ? 8 : 0,
      crc,
      size,
      compressedSize,
      offset,
      time,
      date,
    });
    return { size };
  }

  /** Writes the central directory and closes the file; returns the archive size. */
  async finish(): Promise<number> {
    if (this.closed) throw new Error('Zip archive already finished');
    const cdStart = this.position;
    for (const e of this.entries) {
      const bigSizes = e.size >= MAX32 || e.compressedSize >= MAX32;
      const bigOffset = e.offset >= MAX32;
      const fields: bigint[] = [];
      if (bigSizes) fields.push(BigInt(e.size), BigInt(e.compressedSize));
      if (bigOffset) fields.push(BigInt(e.offset));
      const extra = Buffer.alloc(fields.length ? 4 + fields.length * 8 : 0);
      if (fields.length) {
        extra.writeUInt16LE(0x0001, 0);
        extra.writeUInt16LE(fields.length * 8, 2);
        fields.forEach((v, i) => extra.writeBigUInt64LE(v, 4 + i * 8));
      }
      const version = fields.length ? 45 : 20;
      const h = Buffer.alloc(46);
      h.writeUInt32LE(0x02014b50, 0);
      h.writeUInt16LE((3 << 8) | version, 4); // made by: UNIX
      h.writeUInt16LE(version, 6);
      h.writeUInt16LE(UTF8_FLAG, 8);
      h.writeUInt16LE(e.method, 10);
      h.writeUInt16LE(e.time, 12);
      h.writeUInt16LE(e.date, 14);
      h.writeUInt32LE(e.crc, 16);
      h.writeUInt32LE(bigSizes ? MAX32 : e.compressedSize, 20);
      h.writeUInt32LE(bigSizes ? MAX32 : e.size, 24);
      h.writeUInt16LE(e.name.length, 28);
      h.writeUInt16LE(extra.length, 30);
      // comment length, disk number, internal attributes: 0
      h.writeUInt32LE(0o100644 * 0x10000, 38); // regular file, rw-r--r--
      h.writeUInt32LE(bigOffset ? MAX32 : e.offset, 42);
      await this.append(Buffer.concat([h, e.name, extra]));
    }
    const cdSize = this.position - cdStart;
    const count = this.entries.length;
    if (count >= MAX16 || cdStart >= MAX32 || cdSize >= MAX32) {
      const recordOffset = this.position;
      const record = Buffer.alloc(56);
      record.writeUInt32LE(0x06064b50, 0);
      record.writeBigUInt64LE(44n, 4);
      record.writeUInt16LE((3 << 8) | 45, 12);
      record.writeUInt16LE(45, 14);
      record.writeBigUInt64LE(BigInt(count), 24);
      record.writeBigUInt64LE(BigInt(count), 32);
      record.writeBigUInt64LE(BigInt(cdSize), 40);
      record.writeBigUInt64LE(BigInt(cdStart), 48);
      const locator = Buffer.alloc(20);
      locator.writeUInt32LE(0x07064b50, 0);
      locator.writeBigUInt64LE(BigInt(recordOffset), 8);
      locator.writeUInt32LE(1, 16);
      await this.append(Buffer.concat([record, locator]));
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(Math.min(count, MAX16), 8);
    end.writeUInt16LE(Math.min(count, MAX16), 10);
    end.writeUInt32LE(Math.min(cdSize, MAX32), 12);
    end.writeUInt32LE(Math.min(cdStart, MAX32), 16);
    await this.append(end);
    this.closed = true;
    await this.fh.close();
    return this.position;
  }

  /** Closes and removes a partially written archive. */
  async abort(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      await this.fh.close().catch(() => undefined);
    }
    await fsp.rm(this.path, { force: true });
  }
}
