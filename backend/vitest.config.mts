import path from 'node:path';
import dotenv from 'dotenv';
import { defineConfig } from 'vitest/config';
import { BaseSequencer, type TestSpecification } from 'vitest/node';

// Files share one database and must pass in any order. Default to a stable alphabetical order; set
// TEST_FILE_ORDER=reverse or TEST_FILE_ORDER=shuffle (optionally TEST_FILE_SEED=<n>) to check isolation.
class FileOrderSequencer extends BaseSequencer {
  async sort(files: TestSpecification[]) {
    const sorted = [...files].sort((a, b) => a.moduleId.localeCompare(b.moduleId));
    const order = process.env.TEST_FILE_ORDER;
    if (order === 'reverse') sorted.reverse();
    if (order === 'shuffle') {
      let seed = Number(process.env.TEST_FILE_SEED ?? Date.now()) >>> 0;
      console.log(`Shuffling test files with TEST_FILE_SEED=${seed}`);
      const rand = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
      for (let i = sorted.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [sorted[i], sorted[j]] = [sorted[j], sorted[i]];
      }
    }
    if (order) console.log(`File order: ${sorted.map((f) => path.basename(f.moduleId)).join(', ')}`);
    return sorted;
  }
}

// Read backend/.env so TEST_DB_NAME (and DB credentials) can be set per checkout; the shell still wins.
const fileEnv =
  dotenv.config({ path: path.resolve(__dirname, '.env'), quiet: true, processEnv: {} }).parsed ?? {};

// Tests run against a real MySQL database (dropped & recreated on every run). Storage is per
// database too, so runs against different TEST_DB_NAMEs never wipe each other's files.
const dbName = process.env.TEST_DB_NAME ?? fileEnv.TEST_DB_NAME ?? 'erp_coaching_test';
const testEnv = {
  NODE_ENV: 'test',
  DB_NAME: dbName,
  RATE_LIMIT_ENABLED: 'false',
  JOBS_WORKER_ENABLED: 'false',
  // Suites rely on sessions not expiring; mobile-security.test.ts sets institute timeouts itself.
  SESSION_IDLE_TIMEOUT_MINUTES: '0',
  STORAGE_LOCAL_ROOT: `./tmp/test-storage/${dbName}`,
  AI_API_KEY: '',
  // OTPs are required as in production; tests of the local-development bypass turn it on themselves.
  AUTH_DEV_SKIP_OTP: 'false',
  // Cheap password hashes; production defaults to 15 (see config).
  PASSWORD_HASH_COST: '10',
};
Object.assign(process.env, testEnv);

export default defineConfig({
  test: {
    environment: 'node',
    env: testEnv,
    globalSetup: ['./test/global-setup.ts'],
    setupFiles: ['./test/setup.ts'],
    fileParallelism: false,
    sequence: { sequencer: FileOrderSequencer },
    testTimeout: 20000,
    hookTimeout: 60000,
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
  },
});
