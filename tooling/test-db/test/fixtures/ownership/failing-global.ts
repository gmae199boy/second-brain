import { writeFileSync } from 'node:fs';
import type { TestProject } from 'vitest/node';
export default function setup(project: TestProject): never {
  writeFileSync(process.env.OWNERSHIP_TEST_OUTPUT!, JSON.stringify(project.getProvidedContext()));
  throw new Error('synthetic setup failure');
}
