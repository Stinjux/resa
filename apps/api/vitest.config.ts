import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Integration tests share one database: run files sequentially.
    fileParallelism: false,
    globalSetup: ['./test/global-setup.ts'],
    testTimeout: 20000,
    env: { LOGIN_RATE_LIMIT: '1000' },
  },
});
