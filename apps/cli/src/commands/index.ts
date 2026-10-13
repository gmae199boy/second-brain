import type { CommandSpec } from '../dispatch.js';
import { adminDoctor } from './admin-doctor.js';

/**
 * The command registry. The order here is the order `--help` lists them in.
 * A new command is one entry: the dispatcher supplies the configuration, the
 * envelope, the exit code, the write guard and the hook wrapping (AD-5).
 *
 * ```ts
 * export const logAppend: CommandSpec = { ns: 'log', verb: 'append', writes: true, … };
 * ```
 */
export const commands: readonly CommandSpec[] = [adminDoctor];
