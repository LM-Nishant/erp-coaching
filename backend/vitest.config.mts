import path from 'node:path';
import dotenv from 'dotenv';
import { defineConfig } from 'vitest/config';
import { BaseSequencer, type TestSpecification } from 'vitest/node';

// Files share one database, and some (academics) assume they run before others create rows, so keep a stable order.
class AlphabeticalSequencer extends BaseSequencer {
  async sort(files: TestSpecification[]) {
    return [...files].sort((a, b) => a.moduleId.localeCompare(b.moduleId));
  }
}

// Read backend/.env so TEST_DB_NAME (and DB credentials) can be set per checkout; the shell still wins.
const fileEnv =
  dotenv.config({ path: path.resolve(__dirname, '.env'), quiet: true, processEnv: {} }).parsed ?? {};

// Tests run against a real MySQL database (dropped & recreated on every run).
const testEnv = {
  NODE_ENV: 'test',
  DB_NAME: process.env.TEST_DB_NAME ?? fileEnv.TEST_DB_NAME ?? 'erp_coaching_test',
  RATE_LIMIT_ENABLED: 'false',
  JOBS_WORKER_ENABLED: 'false',
  STORAGE_LOCAL_ROOT: './tmp/test-storage',
  AI_API_KEY: '',
};
Object.assign(process.env, testEnv);

export default defineConfig({
  test: {
    environment: 'node',
    env: testEnv,
    globalSetup: ['./test/global-setup.ts'],
    setupFiles: ['./test/setup.ts'],
    fileParallelism: false,
    sequence: { sequencer: AlphabeticalSequencer },
    testTimeout: 20000,
    hookTimeout: 60000,
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
  },
});
