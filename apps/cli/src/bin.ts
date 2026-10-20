#!/usr/bin/env node
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
  process.exitCode = await dispatch(commands, process.argv.slice(2), { clock: systemClock });
} catch (error) {
  for (const line of crashLines(error)) process.stderr.write(`${line}\n`);
  process.exitCode = 1;
}
