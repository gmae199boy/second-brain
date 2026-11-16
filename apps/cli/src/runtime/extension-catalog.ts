import { join } from 'node:path';
import { homedir } from 'node:os';
import { decodeExtensionManifest } from 'second_brain';
import { appRootPath } from '../install/installed.js';
import { prepareExtensionPackage } from './extension-package.js';
import { testExtensionsFolder } from './extensions.js';
import { validateSchema } from './json-schema.js';

export interface CatalogEntry {
  name: string;
  version: string;
  description: string;
  login_required: boolean;
}

type Candidate = { name: string; path: string };

/** Only these package locations are eligible; names never become path components. */
export async function catalogCandidates(home: string, env: NodeJS.ProcessEnv): Promise<readonly Candidate[]> {
  const candidates: Candidate[] = [{ name: 'garmin', path: join(appRootPath(), 'plugins/garmin/package') }];
  const test = await testExtensionsFolder(home, env, join(homedir(), '.second_brain'));
  if (test !== undefined && env['SECOND_BRAIN_TEST_CATALOG'] === '1') candidates.push({ name: 'testext', path: join(test, 'catalog/testext') });
  return candidates;
}

/** Re-snapshot on every use so selection cannot approve different bytes. */
export async function prepareCatalogCandidate(home: string, env: NodeJS.ProcessEnv, name: string, signal?: AbortSignal) {
  const candidate = (await catalogCandidates(home, env)).find(item => item.name === name);
  if (!candidate) return null;
  const prepared = await prepareExtensionPackage(candidate.path, { signal });
  try {
    const decoded = decodeExtensionManifest(prepared.manifestText, validateSchema);
    if (!decoded.ok || decoded.manifest.name !== candidate.name || decoded.manifest.description === undefined || decoded.manifest.login_required === undefined) throw new Error('invalid catalog metadata');
    return { ...prepared, entry: { name: decoded.manifest.name, version: decoded.manifest.version, description: decoded.manifest.description, login_required: decoded.manifest.login_required } satisfies CatalogEntry };
  } catch (error) {
    await prepared.cleanup();
    throw error;
  }
}

/** Fail the whole read if any candidate is invalid; never return a partial list. */
export async function readCatalogCandidates(home: string, env: NodeJS.ProcessEnv): Promise<CatalogEntry[]> {
  const entries: CatalogEntry[] = [];
  for (const candidate of await catalogCandidates(home, env)) {
    const prepared = await prepareCatalogCandidate(home, env, candidate.name);
    if (!prepared) throw new Error('catalog candidate disappeared');
    try { entries.push(prepared.entry); } finally { await prepared.cleanup(); }
  }
  return entries;
}
