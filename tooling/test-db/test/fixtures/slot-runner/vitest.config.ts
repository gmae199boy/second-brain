import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
export default defineConfig({ resolve: { conditions: ['source'], alias: [{ find: '@second-brain/test-db', replacement: fileURLToPath(new URL('../../../src/index.ts', import.meta.url)) }] }, test: { root: fileURLToPath(new URL('../../../../../', import.meta.url)), include: ['tooling/test-db/test/fixtures/slot-runner/*.fixture.ts'], globalSetup: 'apps/cli/python-test/global-setup.ts', fileParallelism: false, testTimeout: 180_000, hookTimeout: 60_000 } });
