#!/usr/bin/env node
import { dynamicExtensionCommands } from './runtime/extension-commands.js';
import { guideSchemaCommand } from './commands/guide-schema.js';
import { commands } from './commands/index.js';
import { crashLines, dispatch } from './dispatch.js';
import { systemClock } from './runtime/clock.js';

// The whole entry point: the registry, the dispatcher, and the one clock.
//
// The `catch` is the last sink of this app. A non-hook command that throws is a
// bug, and node's own handler would write the message and the stack out
// unmasked — an exception's message being made of whatever the code was holding
// when it broke (AD-11, sink table of `test/output-codecs.test.ts`). So the
// crash goes out through the `text` codec instead, stack and all, and the
// process still ends in 1.
try {
  const argv = process.argv.slice(2);
  let registry = [...commands];
  if (argv[0] === 'ext' || argv[0] === 'guide' && argv[1] === 'schema') {
    const dynamic = await dynamicExtensionCommands(process.env);
    if (!dynamic.ok && argv[0] === 'ext' && argv.length >= 3 && !['install', 'run', 'login', 'list', 'status', 'enable', 'disable'].includes(argv[1] ?? '') && !argv[1]?.startsWith('-') && !argv[2]?.startsWith('-')) {
      const name = argv[1]!, verb = argv[2]!;
      registry.push({ ns: `ext.${name}`, verb, usedFor: '확장 명령 목록을 읽습니다', required: [], examples: [`brain ext ${name} ${verb}`], output: '오류', risk: 'read', hook: false, dryRun: false, standalone: true, options: [{ flags: '--input <json>', description: '입력' }], async run() { return dynamic; } });
    } else if (dynamic.ok) registry = [...commands, ...dynamic.commands];
    registry = registry.map(spec => spec.ns === 'guide' && spec.verb === 'schema' ? guideSchemaCommand(() => registry) : spec);
  }
  const exit = await dispatch(registry, argv, { clock: systemClock });
  if (process.exitCode !== 130 && process.exitCode !== 143) process.exitCode = exit;
} catch (error) {
  for (const line of crashLines(error)) process.stderr.write(`${line}\n`);
  process.exitCode = 1;
}
