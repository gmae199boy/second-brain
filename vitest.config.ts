import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';

// One vitest project per workspace package that actually has a `test/` folder.
// Packages are built before tests run (`pnpm test` = `pnpm build && vitest run`)
// because cross-package imports resolve through `exports` -> `dist`.
// Paths are resolved against this file, not the working directory, so the
// config works no matter where vitest is launched from.
const roots = ['packages', 'apps', 'tooling'].map((root) => join(import.meta.dirname, root));

const projects = roots.flatMap((root) =>
  readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(root, entry.name, 'test')))
    .map((entry) => ({
      test: {
        name: entry.name,
        root: join(root, entry.name),
        include: ['test/**/*.test.ts'],
        testTimeout: 30_000,
        hookTimeout: 60_000,
      },
    })),
);

export default defineConfig({ test: { projects } });
