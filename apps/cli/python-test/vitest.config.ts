import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { root: import.meta.dirname, include: ['**/*.test.ts'], globalSetup: '../test/global-setup.ts', testTimeout: 120_000, hookTimeout: 60_000 } });
