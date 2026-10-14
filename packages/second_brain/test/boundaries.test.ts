import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

interface PackageManifest {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
}

function manifest(relativePath: string): PackageManifest {
  return JSON.parse(readFileSync(join(repoRoot, relativePath), 'utf8')) as PackageManifest;
}

function workspaceDependencies(pkg: PackageManifest): string[] {
  return Object.entries(pkg.dependencies ?? {})
    .filter(([, range]) => range.startsWith('workspace:'))
    .map(([name]) => name);
}

describe('package boundaries (AD-1)', () => {
  it('core declares no runtime dependencies', () => {
    const core = manifest('packages/core/package.json');
    expect(core.dependencies).toBeUndefined();
  });

  it('the workspace root declares no dependencies and no prepare script', () => {
    const root = manifest('package.json');
    expect(root.dependencies).toBeUndefined();
    expect(root.scripts?.prepare).toBeUndefined();
  });

  it.each(['postgres', 'sqlite', 'claude-code', 'modelstudio'])(
    'the %s adapter depends on core alone among workspace packages',
    (adapter) => {
      const pkg = manifest(`packages/${adapter}/package.json`);
      expect(workspaceDependencies(pkg)).toEqual(['@second-brain/core']);
    },
  );

  it('the bundle depends on core and every adapter', () => {
    const bundle = manifest('packages/second_brain/package.json');
    expect(workspaceDependencies(bundle).sort()).toEqual([
      '@second-brain/claude-code',
      '@second-brain/core',
      '@second-brain/modelstudio',
      '@second-brain/postgres',
      '@second-brain/sqlite',
    ]);
  });

  it('the cli depends on the bundle alone among workspace packages', () => {
    const cli = manifest('apps/cli/package.json');
    expect(workspaceDependencies(cli)).toEqual(['second_brain']);
  });
});
