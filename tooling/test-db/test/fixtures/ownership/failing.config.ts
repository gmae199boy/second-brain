import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: {
  root: fileURLToPath(new URL('../../../../../', import.meta.url)),
  include: ['tooling/test-db/test/fixtures/ownership/actual.case.ts'],
  globalSetup: ['tooling/test-db/test/typescript-global-setup.ts', 'tooling/test-db/test/fixtures/ownership/failing-global.ts'],
  setupFiles: ['tooling/test-db/test/typescript-file-setup.ts'],
} });
