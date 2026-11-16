import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: {
  root: fileURLToPath(new URL('../../../../../', import.meta.url)),
  include: ['tooling/test-db/test/fixtures/diagnostic-lifecycle/diagnostic.case.ts'],
  globalSetup: ['tooling/test-db/test/typescript-global-setup.ts'],
  setupFiles: ['tooling/test-db/test/typescript-file-setup.ts'],
  testTimeout: 1200, hookTimeout: 90000,
} });
