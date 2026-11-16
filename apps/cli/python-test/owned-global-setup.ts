import type { TestProject } from 'vitest/node';
import { prepareOwnership } from '../../../tooling/test-db/test/typescript-global-setup.js';
import setupDatabase from './global-setup.js';

export default async function setup(project: TestProject): Promise<void> {
  const cleanupOwnership = await prepareOwnership(project);
  let cleanupDatabase: (() => Promise<void>) | undefined;
  // Register first: even a later database setup failure leaves cleanup reachable.
  project.vitest.onClose(async () => {
    const errors: unknown[] = [];
    let safe = false;
    try { await cleanupOwnership(); safe = true; } catch (error) { errors.push(error); }
    // The database is shared with the files; an unconfirmed user of it fences removal.
    if (safe) try { await cleanupDatabase?.(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, 'Python test cleanup failed');
  });
  cleanupDatabase = await setupDatabase();
}
