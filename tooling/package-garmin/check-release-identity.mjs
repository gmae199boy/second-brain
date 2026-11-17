// Compare the candidate package with an explicitly chosen published Git release.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const manifestPath = 'plugins/garmin/package/manifest.json';
const digestPath = 'plugins/garmin/package/digest';
const semver = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
function identity(manifestText, digestText) {
  const manifest = JSON.parse(manifestText);
  const digest = digestText.trim();
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) || manifest.name !== 'garmin' || typeof manifest.version !== 'string' || !semver.test(manifest.version) || !/^[a-f0-9]{64}$/.test(digest)) throw new Error('invalid Garmin package identity');
  return { version: manifest.version, digest };
}
try {
  if (process.argv.length !== 3 || !process.argv[2]) throw new Error('usage: node tooling/package-garmin/check-release-identity.mjs <last-published-ref>');
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const commit = git('rev-parse', '--verify', '--end-of-options', `${process.argv[2]}^{commit}`).trim();
  const previous = identity(git('show', `${commit}:${manifestPath}`), git('show', `${commit}:${digestPath}`));
  const candidate = identity(readFileSync(manifestPath, 'utf8'), readFileSync(digestPath, 'utf8'));
  if (previous.version === candidate.version && previous.digest !== candidate.digest) throw new Error(`Garmin package ${candidate.version} has a different digest than the published baseline; bump the package version`);
  console.log(`Garmin package identity OK: ${previous.version} -> ${candidate.version}`);
} catch (error) {
  console.error(`Garmin release identity check failed: ${error.message}`);
  process.exitCode = 1;
}
