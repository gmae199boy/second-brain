import { connectors } from '../connectors/index.js';
import type { CommandSpec } from '../dispatch.js';
import { harnesses } from '../harnesses.js';
import { doctorRun } from './doctor-run.js';
import { guideExitCodes } from './guide-exit-codes.js';
import { guideSchemaCommand } from './guide-schema.js';
import { guideShowCommand } from './guide-show.js';
import { sessionsIngestCommand } from './sessions-ingest.js';
import { setupConnectCommand } from './setup-connect.js';
import { setupRun } from './setup-run.js';

/**
 * The command registry. The order here is the order `--help` lists them in,
 * and the order `brain guide schema` answers in. A new command is one entry:
 * the dispatcher supplies the configuration, the envelope, the exit code, the
 * write guard and the hook wrapping (AD-5), and the mandatory meta of the spec
 * supplies `--help` and the schema.
 *
 * ```ts
 * export const logAppend: CommandSpec = { ns: 'log', verb: 'append', writes: true, … };
 * ```
 *
 * A namespace is the thing its commands are about, never the kind of person
 * who runs them, so there is no `admin` (AD-5, Decision 2026-10-16).
 */
export const commands: readonly CommandSpec[] = [
  doctorRun,
  // A function, not the list: `guide schema` describes the registry it is in,
  // and a value would have to be defined before itself.
  guideSchemaCommand(() => commands),
  guideExitCodes,
  guideShowCommand,
  sessionsIngestCommand(harnesses),
  setupRun,
  setupConnectCommand(connectors),
];
