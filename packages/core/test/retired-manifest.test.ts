import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decodeExtensionManifest, decodeRetiredExtensionManifest, validInstallProgress } from '../src/index.js';

// Exact public manifest bytes from git revision 09947d2, extensions/garmin/manifest.json.
const fixture = readFileSync(new URL('../fixtures/extensions/legacy-garmin-1.0.0-manifest.json', import.meta.url), 'utf8');
const oldext = () => JSON.parse(fixture.replaceAll('garmin', 'oldext'));

describe('retired manifest reader', () => {
  it('reads the historical public manifest while the current decoder rejects it', () => {
    expect(decodeExtensionManifest(fixture).ok).toBe(false);
    expect(decodeRetiredExtensionManifest(fixture)).toMatchObject({ ok: true, manifest: { name: 'garmin', version: '1.0.0' }, retiredFieldsUsed: true });
  });
  it('also reads a different extension and reports absence of retired fields', () => {
    const value = oldext();
    expect(decodeExtensionManifest(JSON.stringify(value)).ok).toBe(false);
    expect(decodeRetiredExtensionManifest(JSON.stringify(value))).toMatchObject({ ok: true, manifest: { name: 'oldext' }, retiredFieldsUsed: true });
    for (const work of value.work) delete work.verification_snapshot;
    expect(decodeRetiredExtensionManifest(JSON.stringify(value))).toMatchObject({ ok: true, retiredFieldsUsed: false });
  });
  it('rejects unknown keys, invalid retired values, names and malformed JSON', () => {
    const unknown = oldext(); unknown.work[0].unknown = true;
    const badValue = oldext(); badValue.work[0].verification_snapshot = false;
    const badRuntime = oldext(); badRuntime.work.find((work: { verification_snapshot?: boolean }) => work.verification_snapshot).runtime = 'node';
    const badName = oldext(); badName.name = 'another';
    const badPath = oldext(); badPath.migrations = '../escape';
    for (const value of [unknown, badValue, badRuntime, badName, badPath]) expect(decodeRetiredExtensionManifest(JSON.stringify(value)).ok).toBe(false);
    expect(decodeRetiredExtensionManifest('{').ok).toBe(false);
  });
});

describe('replacement progress', () => {
  const base = { name: 'oldext', packageDigest: 'a'.repeat(64), result: null, failedStage: null, lastFailure: null, stages: {}, authWorkId: null, scheduleIds: [] };
  const replacement = { owner: '12345678-1234-1234-1234-123456789abc', fromVersion: '1.0.0', at: '2026-11-06T00:00:00.000Z' };
  it('accepts old records and valid replacement records', () => {
    expect(validInstallProgress(base)).toBe(true);
    expect(validInstallProgress({ ...base, replacement })).toBe(true);
  });
  it('rejects malformed replacement records', () => {
    for (const value of [{ ...replacement, extra: true }, { ...replacement, owner: 'bad' }, { ...replacement, at: '2026-02-30T00:00:00.000Z' }, { ...replacement, fromVersion: '' }, null, {}]) {
      expect(validInstallProgress({ ...base, replacement: value })).toBe(false);
    }
  });
});
