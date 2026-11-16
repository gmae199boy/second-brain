import type { TestProject } from 'vitest/node';
import { setupTestDatabase } from '../../test-db/src/index.js';
import { registerDatabaseCleanup } from '../../test-db/test/typescript-global-setup.js';
export default function setup(project: TestProject): void {
  const cleanup = setupTestDatabase();
  if (cleanup) registerDatabaseCleanup(project, cleanup);
}
