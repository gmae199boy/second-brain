import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { root: fileURLToPath(new URL('../../../', import.meta.url)), include: ['apps/cli/python-test/**/*.test.ts', 'tooling/bootstrap/test/hook.test.ts'], globalSetup: 'apps/cli/test/global-setup.ts', env: { BRAIN_PYTHON_UPDATE_TEST: '1' }, testTimeout: 120_000, hookTimeout: 60_000 } });
