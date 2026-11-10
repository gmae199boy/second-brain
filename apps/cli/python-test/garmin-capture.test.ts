import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const captureMethods = [
  'test_snapshot_permissions_and_comparison', 'test_standalone_snapshot_with_open_wal_writer',
  'test_version_two_metadata_is_preserved', 'test_rejections_and_private_output', 'test_symlink_and_changed_file',
  'test_report_hashes_and_bidirectional_difference', 'test_publish_race_preserves_directory',
  'test_parent_replaced_before_publish', 'test_destination_parent_swap_during_database_backup',
  'test_deep_permissions', 'test_case_collision', 'test_path_replaced_after_inspection',
  'test_keyboard_interrupt_redacted_and_cleaned', 'test_fixed_four_capture_keeps_excluded_database_and_file',
];
function captureOutcomes(output: string): void {
  const matches = [...output.matchAll(/^(test_\w+) \([^\n]+\) \.\.\. (ok|skipped '[^'\n]*')$/gm)];
  const outcomes = new Map<string, string>();
  for (const [, name, outcome] of matches) {
    if (outcomes.has(name!)) throw new Error(`duplicate capture test: ${name}`);
    outcomes.set(name!, outcome!);
  }
  if (outcomes.size !== captureMethods.length || captureMethods.some(name => !outcomes.has(name))) throw new Error('missing or unexpected capture test');
  for (const [name, outcome] of outcomes) if (outcome !== 'ok' && !(name === 'test_case_collision' && outcome === "skipped 'case-sensitive filesystem'")) throw new Error(`unexpected capture skip: ${name}: ${outcome}`);
}
it('capture outcome 검사는 다른 skip과 누락을 거부한다', () => {
  const output = captureMethods.map(name => `${name} (test_capture.CaptureTests.${name}) ... ok`).join('\n');
  expect(() => captureOutcomes(output)).not.toThrow();
  expect(() => captureOutcomes(output.replace('test_case_collision (test_capture.CaptureTests.test_case_collision) ... ok', "test_case_collision (test_capture.CaptureTests.test_case_collision) ... skipped 'case-sensitive filesystem'"))).not.toThrow();
  expect(() => captureOutcomes(output.replace('... ok', "... skipped 'unexpected'"))).toThrow();
  expect(() => captureOutcomes(output.split('\n').slice(1).join('\n'))).toThrow();
});

it('runs the synthetic Garmin capture Python tests', () => {
  const directory = fileURLToPath(new URL('../../../tooling/garmin-import', import.meta.url));
  const pin = readFileSync(new URL('../../../extensions/garmin/.python-version', import.meta.url), 'utf8').trim();
  const found = spawnSync('uv', ['python', 'find', pin, '--no-python-downloads'], { encoding: 'utf8' });
  expect(found.error, found.error?.message).toBeUndefined();
  expect(found.status, found.stderr).toBe(0);
  const result = spawnSync(found.stdout.trim(), ['-m', 'unittest', 'discover', '-s', directory, '-p', 'test_capture.py', '-v'], {
    encoding: 'utf8',
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    timeout: 60000,
  });
  // Preserve the individual outcomes and any declared platform-dependent skip.
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  expect(result.error, result.error?.message).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout + result.stderr).toMatch(/Ran 14 tests in /);
  captureOutcomes(result.stdout + result.stderr);
});
