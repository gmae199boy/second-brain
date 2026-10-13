#!/usr/bin/env node
import { commands } from './commands/index.js';
import { dispatch } from './dispatch.js';
import { systemClock } from './runtime/clock.js';

// The whole entry point: the registry, the dispatcher, and the one clock.
process.exitCode = await dispatch(commands, process.argv.slice(2), { clock: systemClock });
