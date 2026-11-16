import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['apps/cli/test/fixtures/process-timeout/timeout.case.ts'], testTimeout: 1500, hookTimeout: 15000 } });
