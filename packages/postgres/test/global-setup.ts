// This project's tests need Postgres, so `vitest.config.ts` runs this file once
// before them: it starts the test database when there is none and stops it
// again afterwards. The work itself is dev tooling, not part of this package.
export { setupTestDatabase as default } from '@second-brain/test-db';
