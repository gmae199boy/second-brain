import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
// Vitest's changed graph skips external bare imports and node_modules links.
// Real source aliases let it follow workspace package edges without changing Node.
export const sourceAliases = ['packages','apps','tooling'].flatMap(group =>
  readdirSync(resolve(root,group), {withFileTypes:true}).filter(entry => entry.isDirectory()).flatMap(entry => {
    const directory = join(group,entry.name), manifest = resolve(root,directory,'package.json');
    if (!existsSync(manifest)) return [];
    const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
    if (!pkg.exports || typeof pkg.exports !== 'object') return [];
    return Object.entries(pkg.exports).flatMap(([key, target]) => {
      if (!target || typeof target !== 'object' || typeof target.source !== 'string') return [];
      const name = pkg.name + (key === '.' ? '' : key.slice(1));
      return [{find:new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`), replacement:resolve(root,directory,target.source)}];
    });
  })
);
