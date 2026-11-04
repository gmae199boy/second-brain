import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { sourceAliases } from '../../../tooling/test-changed/vitest.config.aliases.mjs';
export default defineConfig({ resolve: { conditions: ['source'], alias: sourceAliases }, test: { root: fileURLToPath(new URL('../../../', import.meta.url)), include: ['apps/cli/python-test/**/*.test.ts', 'tooling/bootstrap/test/hook.test.ts'], fileParallelism: false, globalSetup: 'apps/cli/test/global-setup.ts', env: { BRAIN_PYTHON_UPDATE_TEST: '1' }, testTimeout: 120_000, hookTimeout: 60_000 } });
