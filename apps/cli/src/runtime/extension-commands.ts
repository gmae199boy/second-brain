import { extensionCommands, encodeTextLine } from 'second_brain';
import type { CommandSpec } from '../dispatch.js';
import { configHome } from '../config/paths.js';
import { readConfig } from '../config/codec.js';
import { openBrainStore } from './brain-store.js';
import { extensionRuntime } from './extensions.js';
import { systemClock } from './clock.js';
import { uuidV7IdGen } from './id-gen.js';

export async function dynamicExtensionCommands(env: NodeJS.ProcessEnv): Promise<{ ok: true; commands: CommandSpec[] } | { ok: false; code: string; message: string }> {
  const home = configHome(env), config = await readConfig(home);
  if (!config.ok) return { ok: false, code: config.code, message: config.message };
  let store: Awaited<ReturnType<typeof openBrainStore>>['store'];
  try { store = (await openBrainStore({ home, env, config, path: 'command' })).store; } catch { return { ok: false, code: 'DB_UNAVAILABLE', message: '확장 명령 목록을 읽을 수 없습니다' }; }
  try {
    const entries = await extensionCommands({ store, extensions: extensionRuntime({ home, env, config, clock: systemClock }), clock: systemClock, idGen: uuidV7IdGen() });
    if (!entries.ok) return entries;
    return { ok: true, commands: entries.commands.map(({ extension, command }): CommandSpec => ({
      ns: `ext.${extension}`, verb: command.name, usedFor: encodeTextLine(command.description), required: [],
      examples: command.examples?.length ? command.examples.map(encodeTextLine) : [`brain ext ${extension} ${command.name} --json`],
      output: `확장이 선언한 출력 schema의 결과; 실행 제한 ${command.timeout_ms}ms, stdout/stderr 각 1MiB, 잠금 대기 30초`, risk: 'read', hook: false, dryRun: false, drain: false,
      inputSchema: command.input_schema, outputSchema: command.output_schema,
      options: [{ flags: '--input <json>', description: '명령 입력 JSON (기본 {})' }],
      async run(context) {
        let input: unknown; try { input = context.rawExtensionInput ? context.rawExtensionInput.value : JSON.parse(String(context.options['input'] ?? '{}')); } catch { return { ok: false, code: 'EXTENSION_COMMAND_INPUT_INVALID', message: '명령 입력 JSON이 올바르지 않습니다' }; }
        const controller = new AbortController();
        let received: 'SIGINT' | 'SIGTERM' | undefined;
        const interrupt = () => { received = 'SIGINT'; controller.abort(); };
        const terminate = () => { received = 'SIGTERM'; controller.abort(); };
        const closed = () => controller.abort();
        context.signal?.addEventListener('abort', closed, { once: true }); if (context.signal?.aborted) closed();
        process.once('SIGINT', interrupt); process.once('SIGTERM', terminate);
        try {
          const result = await context.brain.ext.command({ name: extension, command: command.name, input, signal: controller.signal });
          if (received) { process.exitCode = received === 'SIGINT' ? 130 : 143; process.stdin.destroy(); }
          return result.ok ? { ...result, text: [JSON.stringify(result.data)] } : result;
        } finally { process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', terminate); context.signal?.removeEventListener('abort', closed); }
      },
    })) };
  } catch { return { ok: false, code: 'DB_UNAVAILABLE', message: '확장 명령 목록을 읽을 수 없습니다' }; } finally { await store.close().catch(() => undefined); }
}
