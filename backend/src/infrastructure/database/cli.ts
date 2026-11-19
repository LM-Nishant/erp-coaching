/*
 * Database CLI: create | migrate | migrate:undo | migrate:status | seed | seed:undo | reset
 * | make:migration <module> <name> | secrets:reencrypt [--dry-run]
 */
import fs from 'node:fs';
import path from 'node:path';
import mysql from 'mysql2/promise';
import { config } from '../config';
import { closeSequelize, getSequelize } from './sequelize';
import { createMigrator, createSeeder } from './migrator';
import { initModels } from '../../bootstrap';
import { reencryptStoredSecrets } from './encrypted-columns';

async function createDatabase(name = config.DB_NAME) {
  const conn = await mysql.createConnection({
    host: config.DB_HOST,
    port: config.DB_PORT,
    user: config.DB_USER,
    password: config.DB_PASSWORD,
  });
  await conn.query(
    `CREATE DATABASE IF NOT EXISTS \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
  );
  await conn.end();
  console.log(`Database ${name} ready`);
}

function makeMigration(moduleName?: string, name?: string) {
  if (!moduleName || !name) throw new Error('Usage: make:migration <module|core> <name>');
  const ts = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
  const dir =
    moduleName === 'core'
      ? path.join(__dirname, 'migrations')
      : path.resolve(__dirname, '../../modules', moduleName, 'migrations');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${ts}-${name}.ts`);
  const helpers =
    moduleName === 'core' ? '../migration-helpers' : '../../../infrastructure/database/migration-helpers';
  fs.writeFileSync(
    file,
    `import { DataTypes } from 'sequelize';
import { id, timestamps, tenantColumns, type Migration } from '${helpers}';

export const up: Migration = async ({ context: { queryInterface } }) => {
  await queryInterface.createTable('TABLE_NAME', {
    id: id(),
    ...tenantColumns(),
    name: { type: DataTypes.STRING(150), allowNull: false },
    ...timestamps(),
  });
};

export const down: Migration = async ({ context: { queryInterface } }) => {
  await queryInterface.dropTable('TABLE_NAME');
};
`,
  );
  console.log(`Created ${path.relative(process.cwd(), file)}`);
}

/** Moves stored secrets to the current ENCRYPTION_KEY. Returns false when some value can't be decrypted. */
async function reencryptSecrets(dryRun: boolean): Promise<boolean> {
  const reports = await reencryptStoredSecrets({ dryRun });
  console.table(
    reports.map((r) => ({
      column: `${r.table}.${r.column}`,
      values: r.total,
      'on current key': r.current,
      [dryRun ? 'to re-encrypt' : 're-encrypted']: r.reencrypted,
      ...(dryRun ? {} : { 'changed meanwhile': r.changedMeanwhile }),
      'cannot decrypt': r.failedIds.length,
    })),
  );
  const failed = reports.filter((r) => r.failedIds.length);
  for (const r of failed)
    console.error(`${r.table}.${r.column}: no configured key decrypts ids ${r.failedIds.join(', ')}`);
  const left = reports.reduce((n, r) => n + (dryRun ? r.reencrypted : r.changedMeanwhile), 0);
  if (failed.length)
    console.error(
      'Add the missing keys to ENCRYPTION_PREVIOUS_KEYS and run again, or re-enter those secrets.',
    );
  else if (left)
    console.log(`${left} values are on a previous key${dryRun ? '' : ': run the command again'}.`);
  else console.log('Every stored secret uses the current key: ENCRYPTION_PREVIOUS_KEYS can be emptied.');
  return !failed.length;
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === 'create') return createDatabase();
  if (cmd === 'make:migration') return makeMigration(args[0], args[1]);

  const sequelize = getSequelize();
  const migrator = createMigrator(sequelize);
  const seeder = createSeeder(sequelize);
  switch (cmd) {
    case 'migrate':
      await migrator.up();
      break;
    case 'migrate:undo':
      await migrator.down(args[0] === '--all' ? { to: 0 } : undefined);
      // Undoing every migration drops the seeded tables, so forget the seed runs too.
      if (args[0] === '--all') await sequelize.getQueryInterface().dropTable('SequelizeData');
      break;
    case 'migrate:status': {
      console.log(
        'executed:',
        (await migrator.executed()).map((m) => m.name),
      );
      console.log(
        'pending:',
        (await migrator.pending()).map((m) => m.name),
      );
      break;
    }
    case 'seed':
      await initModels();
      await seeder.up();
      break;
    case 'seed:undo':
      await initModels();
      await seeder.down({ to: 0 });
      break;
    case 'reset': {
      if (config.isProd) throw new Error('reset is disabled in production');
      const tables = (await sequelize.getQueryInterface().showAllTables()) as string[];
      // One transaction pins a single pooled connection so FOREIGN_KEY_CHECKS applies to every DROP.
      await sequelize.transaction(async (transaction) => {
        await sequelize.query('SET FOREIGN_KEY_CHECKS = 0', { transaction });
        for (const t of tables) await sequelize.query(`DROP TABLE IF EXISTS \`${t}\``, { transaction });
        await sequelize.query('SET FOREIGN_KEY_CHECKS = 1', { transaction });
      });
      await migrator.up();
      await initModels();
      await seeder.up();
      break;
    }
    case 'secrets:reencrypt':
      await initModels();
      if (!(await reencryptSecrets(args.includes('--dry-run')))) process.exitCode = 1;
      break;
    default:
      throw new Error(`Unknown command: ${cmd}`);
  }
  await closeSequelize();
}

main().catch(async (err) => {
  console.error(err);
  await closeSequelize();
  process.exit(1);
});
