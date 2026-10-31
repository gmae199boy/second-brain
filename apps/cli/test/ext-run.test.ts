import { expect, it } from 'vitest';
import { runExtension, errorEnvelope, type ExtensionRuntime } from 'second_brain';
import { fixedClock, memoryStore, sequenceIdGen } from '../../../packages/core/src/testing/index.js';
import { extRunCommand } from '../src/commands/ext-run.js';
import type { CommandContext, DatabaseCommandSpec } from '../src/dispatch.js';

it('설치 잠금 실패를 경로가 없는 명령 오류 envelope로 출력한다', async () => {
  const clock = fixedClock(new Date('2026-01-01T00:00:00Z'));
  const runtime = { installedManifest: async () => '{}', withInstallLock: async () => { throw new Error('private-path-canary'); } } as unknown as ExtensionRuntime;
  const run = () => runExtension({ store: memoryStore(), clock, idGen: sequenceIdGen({timestampMs: clock.now().getTime()}), extensions: runtime }, {name: 'testext', job: 'report'});
  const context = { args: ['testext', 'report'], options: {}, brain: { ext: { run } } } as unknown as CommandContext;
  const result = await (extRunCommand as DatabaseCommandSpec).run(context);
  expect(result).toMatchObject({ ok: false, code: 'DB_UNAVAILABLE' });
  if (result.ok) throw new Error('실패 결과가 필요하다');
  const envelope = errorEnvelope(clock, result);
  expect(envelope.error?.code).toBe('DB_UNAVAILABLE');
  expect(JSON.stringify(envelope)).not.toContain('private-path-canary');
});
