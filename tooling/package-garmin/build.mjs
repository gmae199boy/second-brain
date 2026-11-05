// Construct only the product package. This does not install or execute it.
import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const source = join(root, 'extensions/garmin');
const plugin = join(root, 'plugins/garmin');
const destination = join(plugin, 'package');
const temporary = join(plugin, `.package-${randomUUID()}`);
const backup = join(plugin, `.package-old-${randomUUID()}`);
const compare = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));
const files = new Map();
function add(relative) {
  const path = join(source, relative), info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`invalid product input: ${relative}`);
  files.set(relative, readFileSync(path));
}
function walk(relative, accept) {
  const path = join(source, relative), info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`invalid product directory: ${relative}`);
  for (const item of readdirSync(path, { withFileTypes: true })) {
    const child = `${relative}/${item.name}`;
    if (item.isSymbolicLink()) throw new Error(`invalid product entry: ${child}`);
    if (item.isDirectory()) {
      if (item.name === '__pycache__' || child === 'src/garmin_pipeline/store/migrations') continue;
      walk(child, accept);
    } else if (item.isFile() && accept(child)) add(child);
    else if (!item.isFile()) throw new Error(`invalid product entry: ${child}`);
  }
}
for (const path of ['.python-version', 'pyproject.toml', 'uv.lock', 'MANIFEST.in']) add(path);
walk('migrations', path => /^migrations\/\d{4}_[a-z0-9_]+\.sql$/.test(path));
walk('skills', path => /^skills\/[a-z0-9-]+\/SKILL\.md$/.test(path));
walk('src', path => /\.(?:py|json)$/.test(path) && path !== 'src/garmin_pipeline/capture.py');
const version = JSON.parse(readFileSync(join(plugin, '.claude-plugin/plugin.json'), 'utf8')).version;
if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(version)) throw new Error('invalid plugin version');
const manifest = JSON.parse(readFileSync(join(source, 'manifest.json'), 'utf8'));
if (['files', 'core_compat', 'plugin_version'].some(key => Object.hasOwn(manifest, key))) throw new Error('source manifest already has package identity');
manifest.files = [...files.keys(), 'manifest.json'].sort(compare);
manifest.core_compat = { min: '0.0.0', max_exclusive: '1.0.0' };
manifest.plugin_version = version;
files.set('manifest.json', Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
const digest = createHash('sha256');
for (const path of manifest.files) {
  const name = Buffer.from(path), bytes = files.get(path);
  digest.update(`f${name.length}:`); digest.update(name); digest.update(`:${bytes.length}:`); digest.update(bytes);
}
let hadOld = false;
try {
  mkdirSync(temporary, { mode: 0o700 });
  for (const [path, bytes] of files) {
    const target = join(temporary, path); mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes, { flag: 'wx', mode: 0o600 });
  }
  writeFileSync(join(temporary, 'digest'), `${digest.digest('hex')}\n`, { flag: 'wx', mode: 0o600 });
  try { lstatSync(destination); hadOld = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (hadOld) renameSync(destination, backup);
  try { renameSync(temporary, destination); }
  catch (error) { if (hadOld) renameSync(backup, destination); throw error; }
  if (hadOld) rmSync(backup, { recursive: true });
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
