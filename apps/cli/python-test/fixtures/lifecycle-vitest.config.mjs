import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
export default defineConfig({test:{root:fileURLToPath(new URL('../../../../',import.meta.url)),include:['apps/cli/python-test/fixtures/lifecycle-timeout.fixture.ts'],hookTimeout:10000}});
