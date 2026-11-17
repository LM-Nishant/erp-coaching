import fs from 'node:fs';
import path from 'node:path';
import { Umzug, SequelizeStorage } from 'umzug';
import type { Sequelize } from 'sequelize';
import { MODULES_DIR } from '../module-loader';
import { logger } from '../logger';
import type { MigrationContext } from './migration-helpers';

const EXT = __filename.endsWith('.ts') ? '.ts' : '.js';
const CORE_DIR = __dirname;

/** Collect files from core + every module's `<kind>/` folder, ordered globally by file name (timestamp prefix). */
function collect(kind: 'migrations' | 'seeders') {
  const dirs = [path.join(CORE_DIR, kind)];
  for (const d of fs.readdirSync(MODULES_DIR, { withFileTypes: true })) {
    if (d.isDirectory()) dirs.push(path.join(MODULES_DIR, d.name, kind));
  }
  const files: { name: string; path: string }[] = [];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith(EXT) && !f.endsWith('.d.ts') && /^\d{14}-/.test(f)) {
        files.push({ name: f.slice(0, -EXT.length), path: path.join(dir, f) });
      }
    }
  }
  const seen = new Set<string>();
  for (const f of files) {
    if (seen.has(f.name)) throw new Error(`Duplicate ${kind} name: ${f.name}`);
    seen.add(f.name);
  }
  return files.sort((a, b) => a.name.localeCompare(b.name));
}

function build(sequelize: Sequelize, kind: 'migrations' | 'seeders') {
  return new Umzug<MigrationContext>({
    migrations: () =>
      collect(kind).map((f) => ({
        name: f.name,
        path: f.path,
        up: async (params) => (await import(f.path)).up(params),
        down: async (params) => (await import(f.path)).down?.(params),
      })),
    context: { queryInterface: sequelize.getQueryInterface() },
    // Distinct model names: SequelizeStorage reuses an already-defined model of the same name, so
    // without them the seeder would silently record into the migrations table.
    storage: new SequelizeStorage({
      sequelize,
      tableName: kind === 'migrations' ? 'SequelizeMeta' : 'SequelizeData',
      modelName: kind === 'migrations' ? 'SequelizeMeta' : 'SequelizeData',
    }),
    logger: {
      info: (m) => logger.info(m),
      warn: (m) => logger.warn(m),
      error: (m) => logger.error(m),
      debug: (m) => logger.debug(m),
    },
  });
}

export const createMigrator = (sequelize: Sequelize) => build(sequelize, 'migrations');
export const createSeeder = (sequelize: Sequelize) => build(sequelize, 'seeders');
