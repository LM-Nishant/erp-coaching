import { QueryTypes, Transaction } from 'sequelize';
import { getSequelize } from '../../infrastructure/database/sequelize';
import { getStorage } from '../../infrastructure/storage';
import {
  chunk,
  exportableColumns,
  foreignKeys,
  ident,
  instituteUserIds,
  tenantTablePlan,
  UNREGISTERED_INSTITUTE_TABLES,
} from './catalog';
import { ZipWriter } from './zip-writer';

type Row = Record<string, unknown>;

const PAGE_SIZE = 1000;
/** Generated files stay well below the 4 GiB zip entry limit; larger tables continue in `.partN` files. */
export const DEFAULT_PART_LIMIT_BYTES = 1024 ** 3;

export interface ArchiveOptions {
  exportId: number;
  includeMedia: boolean;
  partLimitBytes?: number;
}

export interface ArchiveResult {
  sizeBytes: number;
  tableCount: number;
  rowCount: number;
  fileCount: number;
  missingFiles: number[];
}

function plain(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (Buffer.isBuffer(v)) return v.toString('base64');
  if (typeof v === 'bigint') return v.toString();
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  return v;
}

function plainRow(row: Row, columns: string[]): Row {
  const out: Row = {};
  for (const c of columns) out[c] = plain(row[c]);
  return out;
}

const NUMERIC = /^[-+]?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?$/;

/** RFC 4180 cell. Text a spreadsheet would evaluate as a formula is prefixed with `'`. */
export function csvCell(value: unknown): string {
  const v = plain(value);
  if (v === null) return '';
  let s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s) && !NUMERIC.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const UNSAFE_NAME_CHARS = new Set([...'/\\:*?"<>|']);

/** `media/<file id>/<original name>` with characters that are unsafe in paths replaced. */
export function mediaEntryName(fileId: number, originalName: string): string {
  let chars = Array.from(originalName, (ch) => {
    const code = ch.codePointAt(0)!;
    return code < 32 || code === 127 || UNSAFE_NAME_CHARS.has(ch) ? '_' : ch;
  });
  if (chars.length > 150) {
    const dot = chars.lastIndexOf('.');
    const ext = dot > 0 && chars.length - dot <= 16 ? chars.slice(dot) : [];
    chars = [...chars.slice(0, 150 - ext.length), ...ext];
  }
  let name = chars.join('').trim();
  if (!name || name === '.' || name === '..') name = 'file';
  return `media/${fileId}/${name}`;
}

interface TableSource {
  name: string;
  columns: string[];
  rows: () => AsyncGenerator<Row>;
}

interface Format {
  ext: 'json' | 'csv';
  dir: 'data' | 'csv';
  header: (columns: string[]) => string;
  row: (row: Row, columns: string[], first: boolean) => string;
  footer: string;
}

const JSON_FORMAT: Format = {
  ext: 'json',
  dir: 'data',
  header: () => '[',
  row: (row, columns, first) => `${first ? '\n' : ',\n'}${JSON.stringify(plainRow(row, columns))}`,
  footer: '\n]\n',
};

const CSV_FORMAT: Format = {
  ext: 'csv',
  dir: 'csv',
  header: (columns) => `${columns.map(csvCell).join(',')}\r\n`,
  row: (row, columns) => `${columns.map((c) => csvCell(row[c])).join(',')}\r\n`,
  footer: '',
};

/** Streams one table into `<dir>/<name>.<ext>` (plus `.partN` files past the size limit). */
async function writeTable(zip: ZipWriter, source: TableSource, format: Format, partLimit: number) {
  const it = source.rows();
  let next = await it.next();
  let rows = 0;
  const files: string[] = [];
  for (let part = 1; ; part++) {
    const name = `${format.dir}/${source.name}${part > 1 ? `.part${part}` : ''}.${format.ext}`;
    async function* body() {
      yield format.header(source.columns);
      let bytes = 0;
      let first = true;
      while (!next.done && (first || bytes < partLimit)) {
        const text = format.row(next.value, source.columns, first);
        bytes += Buffer.byteLength(text);
        first = false;
        rows++;
        yield text;
        next = await it.next();
      }
      yield format.footer;
    }
    await zip.add(name, body());
    files.push(name);
    if (next.done) return { rows, files };
  }
}

/** Keyset pagination over `id`. */
function keyset(fetch: (afterId: number) => Promise<Row[]>): () => AsyncGenerator<Row> {
  return async function* () {
    let afterId = 0;
    for (;;) {
      const page = await fetch(afterId);
      yield* page;
      if (page.length < PAGE_SIZE) return;
      afterId = Number(page[page.length - 1].id);
    }
  };
}

/**
 * Writes the institute's complete data to a zip at `outPath`: every tenant table as JSON and CSV,
 * the members' user records, uploaded media and a manifest. Secrets are never included.
 * Table data is read in one REPEATABLE READ transaction, so it is a consistent snapshot.
 */
export async function buildExportArchive(
  instituteId: number,
  outPath: string,
  opts: ArchiveOptions,
): Promise<ArchiveResult> {
  const sequelize = getSequelize();
  const partLimit = opts.partLimitBytes ?? DEFAULT_PART_LIMIT_BYTES;
  const plan = await tenantTablePlan();
  const exported = plan.filter((t) => t.export).map((t) => t.table);
  const exportedSet = new Set(exported);
  const fks = await foreignKeys();
  const columns = await exportableColumns([...exported, 'institutes', 'users', 'subscription_invoice_lines']);
  const select = (table: string, alias = '') =>
    columns
      .get(table)!
      .map((c) => `${alias}${ident(c)}`)
      .join(', ');

  const zip = await ZipWriter.create(outPath);
  try {
    const manifestTables: { name: string; rows: number; files: string[] }[] = [];
    let rowCount = 0;
    let institute: Row | undefined;

    await sequelize.transaction(
      { isolationLevel: Transaction.ISOLATION_LEVELS.REPEATABLE_READ },
      async (transaction) => {
        const query = (sql: string, replacements: Record<string, unknown>) =>
          sequelize.query<Row>(sql, { type: QueryTypes.SELECT, replacements, transaction });

        [institute] = await query(`SELECT ${select('institutes')} FROM institutes WHERE id = :instituteId`, {
          instituteId,
        });
        if (!institute) throw new Error('Institute not found');
        await zip.add(
          'institute.json',
          `${JSON.stringify(plainRow(institute, columns.get('institutes')!), null, 2)}\n`,
        );

        const sources: TableSource[] = exported.map((table) => ({
          name: table,
          columns: columns.get(table)!,
          rows: keyset((afterId) =>
            query(
              `SELECT ${select(table)} FROM ${ident(table)}
                WHERE institute_id = :instituteId AND id > :afterId ORDER BY id LIMIT ${PAGE_SIZE}`,
              { instituteId, afterId },
            ),
          ),
        }));

        const userIds = await instituteUserIds(
          instituteId,
          plan.map((t) => t.table),
          fks,
          transaction,
        );
        const userColumns = columns.get('users')!.filter((c) => c !== 'is_super_admin');
        sources.push({
          name: 'users',
          columns: userColumns,
          rows: async function* () {
            for (const ids of chunk(userIds, PAGE_SIZE))
              yield* await query(
                `SELECT ${userColumns.map((c) => ident(c)).join(', ')} FROM users WHERE id IN (:ids) ORDER BY id`,
                { ids },
              );
          },
        });
        if (exportedSet.has('roles')) {
          sources.push({
            name: 'role_permissions',
            columns: ['role_id', 'permission'],
            rows: async function* () {
              yield* await query(
                `SELECT rp.role_id, p.\`key\` AS permission FROM role_permissions rp
                   JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
                  WHERE r.institute_id = :instituteId ORDER BY rp.role_id, p.\`key\``,
                { instituteId },
              );
            },
          });
          sources.push({
            name: 'system_roles',
            columns: ['id', 'slug', 'name', 'description'],
            rows: async function* () {
              yield* await query(
                'SELECT id, slug, name, description FROM roles WHERE institute_id IS NULL ORDER BY id',
                {},
              );
            },
          });
        }
        if (exportedSet.has('subscription_invoices')) {
          sources.push({
            name: 'subscription_invoice_lines',
            columns: columns.get('subscription_invoice_lines')!,
            rows: keyset((afterId) =>
              query(
                `SELECT ${select('subscription_invoice_lines', 'l.')} FROM subscription_invoice_lines l
                   JOIN subscription_invoices i ON i.id = l.invoice_id
                  WHERE i.institute_id = :instituteId AND l.id > :afterId ORDER BY l.id LIMIT ${PAGE_SIZE}`,
                { instituteId, afterId },
              ),
            ),
          });
        }

        for (const source of sources) {
          const json = await writeTable(zip, source, JSON_FORMAT, partLimit);
          const csv = await writeTable(zip, source, CSV_FORMAT, partLimit);
          manifestTables.push({ name: source.name, rows: json.rows, files: [...json.files, ...csv.files] });
          rowCount += json.rows;
        }
      },
    );

    let fileCount = 0;
    let mediaBytes = 0;
    const missingFiles: number[] = [];
    if (opts.includeMedia && exportedSet.has('files')) {
      const storage = getStorage();
      const files = keyset((afterId) =>
        sequelize.query<Row>(
          `SELECT id, storage_key, original_name, created_at FROM files
            WHERE institute_id = :instituteId AND id > :afterId ORDER BY id LIMIT ${PAGE_SIZE}`,
          { type: QueryTypes.SELECT, replacements: { instituteId, afterId } },
        ),
      );
      for await (const f of files()) {
        const id = Number(f.id);
        const key = String(f.storage_key);
        const stat = await storage.stat(key);
        if (!stat) {
          missingFiles.push(id);
          continue;
        }
        const createdAt = f.created_at instanceof Date ? f.created_at : new Date(String(f.created_at));
        await zip.add(mediaEntryName(id, String(f.original_name)), await storage.getStream(key), {
          compress: false,
          size: stat.size,
          mtime: Number.isNaN(createdAt.getTime()) ? undefined : createdAt,
        });
        fileCount++;
        mediaBytes += stat.size;
      }
    }

    const notExported = plan
      .filter((t) => !t.export)
      .map((t) => ({ name: t.table, reason: UNREGISTERED_INSTITUTE_TABLES[t.table]?.reason ?? t.reason }));
    const manifest = {
      format: 'erp-coaching-institute-export',
      version: 1,
      exportId: opts.exportId,
      generatedAt: new Date().toISOString(),
      institute: { id: instituteId, name: institute?.name ?? null, slug: institute?.slug ?? null },
      notes: [
        'data/<table>.json holds each table as a JSON array of rows; csv/<table>.csv holds the same rows as UTF-8 CSV.',
        'Large tables continue in numbered part files (<table>.part2.json, ...).',
        'Passwords, tokens, secrets, hashes and encryption keys are never exported.',
        'media/<file id>/<name> holds uploaded files; data/files.json describes them.',
      ],
      tables: manifestTables,
      notExported,
      media: {
        included: opts.includeMedia,
        files: fileCount,
        bytes: mediaBytes,
        missingFileIds: missingFiles,
      },
    };
    await zip.add('manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);
    const sizeBytes = await zip.finish();
    return { sizeBytes, tableCount: manifestTables.length, rowCount, fileCount, missingFiles };
  } catch (err) {
    await zip.abort();
    throw err;
  }
}
