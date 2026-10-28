import { homeResources } from '../src/config/resources.js';
import { expect, it } from 'vitest';
import { probeOrbStack, containerState } from '../src/runtime/orbstack.js';
import { fakeCommandRunner, type CommandResult } from '../src/runtime/command-runner.js';
import { assertKoreanLine } from './language.js';
const ok = (stdout = ''): CommandResult => ({ ok: true, stdout, stderr: '' });
const bad: CommandResult = { ok: false, stdout: '', stderr: '', message: 'failed' };
const missing: CommandResult = { ...bad, code: 'ENOENT' };
it.each([
  ['not-installed', [missing], false, {}],
  ['cli-missing', [missing], true, {}],
  ['stopped', [ok('Stopped')], true, {}],
  ['context', [ok('Running'), ok('desktop-linux')], true, {}],
  ['context', [ok('Running'), ok('orbstack')], true, { DOCKER_HOST: 'unix://other' }],
  ['engine', [ok('Running'), ok('orbstack'), bad], true, {}],
  ['compose', [ok('Running'), ok('orbstack'), ok('29'), bad], true, {}],
  ['running', [ok('Running'), ok('orbstack'), ok('29'), ok('2')], true, {}],
] as const)('classifies OrbStack %s and uses bounded read commands', async (reason, results, exists, env) => {
  const fake = fakeCommandRunner(results);
  const result = await probeOrbStack({ runner: fake.runner, env: { PATH: '/custom', HOME: '/tmp/user', ...env }, appExists: async () => exists });
  if (reason === 'running') expect(result.ok).toBe(true);
  else { expect(result).toMatchObject({ ok: false, reason }); if (!result.ok) { assertKoreanLine(result.message); assertKoreanLine(result.hint); } }
  for (const call of fake.calls) {
    expect(call.timeoutMs).toBe(5000);
    expect(call.env.PATH).toBe('/custom:/usr/local/bin:/opt/homebrew/bin:/tmp/user/.orbstack/bin');
    expect(call.args).not.toContain('start'); expect(call.args).not.toContain('up');
  }
});
it.each(['', JSON.stringify({ Labels: 'com.docker.compose.service=postgres', State: 'exited', Status: 'Exited' }), JSON.stringify({ Labels: 'com.docker.compose.service=postgres', State: 'running', Status: 'Up (unhealthy)' })])('rejects absent and unhealthy postgres containers: %s', async stdout => {
  const fake = fakeCommandRunner([ok(stdout)]);
  expect((await containerState({ home: '/tmp/brain', env: {}, runner: fake.runner })).ok).toBe(false);
});
it('accepts only a healthy postgres service in the home project', async () => {
  const fake = fakeCommandRunner([ok(JSON.stringify({ Labels: 'com.docker.compose.service=postgres', State: 'running', Status: 'Up 1 second (healthy)' }))]);
  expect((await containerState({ home: '/tmp/brain', env: {}, runner: fake.runner })).ok).toBe(true);
  expect(fake.calls[0]?.args).toContain(`label=com.docker.compose.project=${homeResources('/tmp/brain').project}`);
});
