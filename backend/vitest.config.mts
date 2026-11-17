import { defineConfig } from 'vitest/config';

// Tests run against a real MySQL database (dropped & recreated on every run).
const testEnv = {
  NODE_ENV: 'test',
  DB_NAME: process.env.TEST_DB_NAME ?? 'erp_coaching_test',
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
    testTimeout: 20000,
    hookTimeout: 60000,
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
  },
});
