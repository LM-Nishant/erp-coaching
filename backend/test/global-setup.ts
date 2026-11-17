import fs from 'node:fs';
import path from 'node:path';
import mysql from 'mysql2/promise';

/** Recreates the test database, then runs every migration and seeder once per test run. */
export default async function setup() {
  const dotenv = await import('dotenv');
  dotenv.config({ path: path.resolve(__dirname, '../.env'), quiet: true });
  const { config } = await import('../src/infrastructure/config');
  if (!/test/i.test(config.DB_NAME)) throw new Error(`Refusing to reset non-test database "${config.DB_NAME}"`);
  const conn = await mysql.createConnection({ host: config.DB_HOST, port: config.DB_PORT, user: config.DB_USER, password: config.DB_PASSWORD });
  await conn.query(`DROP DATABASE IF EXISTS \`${config.DB_NAME}\``);
  await conn.query(`CREATE DATABASE \`${config.DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await conn.end();
  fs.rmSync(config.storageLocalRoot, { recursive: true, force: true });

  const { getSequelize, closeSequelize } = await import('../src/infrastructure/database/sequelize');
  const { createMigrator, createSeeder } = await import('../src/infrastructure/database/migrator');
  const { initModels } = await import('../src/bootstrap');
  const sequelize = getSequelize();
  await createMigrator(sequelize).up();
  await initModels();
  await createSeeder(sequelize).up();
  await closeSequelize();
}
