import type { TestProject } from 'vitest/node';
import { setupTestDatabase } from '@second-brain/test-db';
import { registerDatabaseCleanup } from '../../../tooling/test-db/test/typescript-global-setup.js';
export default function setup(project: TestProject): void {
  const cleanup = setupTestDatabase();
  if (cleanup) registerDatabaseCleanup(project, cleanup);
}
