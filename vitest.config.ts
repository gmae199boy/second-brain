import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';

// One vitest project per workspace package that actually has a `test/` folder.
// Packages are built before tests run (`pnpm test` = `pnpm build && vitest run`)
// because cross-package imports resolve through `exports` -> `dist`.
// Paths are resolved against this file, not the working directory, so the
// config works no matter where vitest is launched from.
const roots = ['packages', 'apps', 'tooling'].map((root) => join(import.meta.dirname, root));

// A package whose tests need something started first puts it in
// `test/global-setup.ts`: that file runs once before the project's tests and
// not at all when the project is not selected, so `--project sqlite` never
// reaches for Docker. The name is looked for rather than listed here, so a
// second such package needs no change to this file.
const projects = roots.flatMap((root) =>
  readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(root, entry.name, 'test')))
    .map((entry) => {
      const packageRoot = join(root, entry.name);
      const globalSetup = join(packageRoot, 'test', 'global-setup.ts');
      return {
        test: {
          name: entry.name,
          root: packageRoot,
          include: ['test/**/*.test.ts'],
          testTimeout: 30_000,
          hookTimeout: 60_000,
          ...(existsSync(globalSetup) ? { globalSetup } : {}),
        },
      };
    }),
);

export default defineConfig({ test: { projects } });
