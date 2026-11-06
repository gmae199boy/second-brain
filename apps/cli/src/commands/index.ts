import { sourcesSyncCommand } from './sources-sync.js';
import { recallDocsCommand } from './recall-docs.js';
import { filesShowCommand } from './files-show.js';
import { mcpServeCommand } from './mcp-serve.js';
import { channelsListCommand, channelsStatusCommand, channelsResendCommand } from './channels-status.js';
import { extEnableCommand, extDisableCommand } from './ext-activation.js';
import { recallChunksCommand } from './recall-chunks.js';
import { recallToolsCommand } from './recall-tools.js';
import { recallExpandCommand } from './recall-expand.js';
import { sessionsReadCommand } from './sessions-read.js';
import { extLoginCommand } from './ext-login.js';
import { extRunCommand } from './ext-run.js';
import { extInstallCommand } from './ext-install.js';
import { extListCommand } from './ext-list.js';
import { extStatusCommand } from './ext-status.js';
import { queueListCommand } from './queue-list.js';
import { schedulesAddCommand } from './schedules-add.js';
import { schedulesListCommand } from './schedules-list.js';
import { schedulesRemoveCommand } from './schedules-remove.js';
import { schedulesUpdateCommand } from './schedules-update.js';
import { schedulesRunCommand } from './schedules-run.js';
import { configGetCommand } from './config-get.js';
import { configSetCommand } from './config-set.js';
import { filesRedactCommand } from './files-redact.js';
import { messagesRedactCommand } from './messages-redact.js';
import { connectors } from '../connectors/index.js';
import type { CommandSpec } from '../dispatch.js';
import { harnesses } from '../harnesses.js';
import { daemonStopCommand } from './daemon-stop.js';
import { daemonStartCommand } from './daemon-start.js';
import { daemonStatusCommand } from './daemon-status.js';
import { daemonRunCommand } from './daemon-run.js';
import { doctorRun } from './doctor-run.js';
import { failuresListCommand } from './failures-list.js';
import { failuresRetryCommand } from './failures-retry.js';
import { guideExitCodes } from './guide-exit-codes.js';
import { guideSchemaCommand } from './guide-schema.js';
import { guideShowCommand } from './guide-show.js';
import { queueCancelCommand } from './queue-cancel.js';
import { queueDrainCommand } from './queue-drain.js';
import { sessionsIngestCommand } from './sessions-ingest.js';
import { setupConnectCommand } from './setup-connect.js';
import { setupUninstallCommand } from './setup-uninstall.js';
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
  mcpServeCommand,
  channelsListCommand, channelsStatusCommand, channelsResendCommand,
  recallChunksCommand, recallToolsCommand, recallDocsCommand, recallExpandCommand, sessionsReadCommand,
  extInstallCommand,
  extRunCommand,
  extLoginCommand,
  extListCommand,
  extStatusCommand,
  extEnableCommand,
  extDisableCommand,
  doctorRun,
  configGetCommand,
  configSetCommand,
  messagesRedactCommand,
  filesRedactCommand, filesShowCommand, sourcesSyncCommand,
  failuresListCommand,
  failuresRetryCommand,
  // A function, not the list: `guide schema` describes the registry it is in,
  // and a value would have to be defined before itself.
  guideSchemaCommand(() => commands),
  guideExitCodes,
  guideShowCommand,
  daemonRunCommand,
  daemonStatusCommand,
  daemonStopCommand,
  daemonStartCommand,
  queueDrainCommand,
  queueCancelCommand,
  queueListCommand,
  schedulesAddCommand,
  schedulesListCommand,
  schedulesRemoveCommand,
  schedulesRunCommand,
  schedulesUpdateCommand,
  sessionsIngestCommand(harnesses),
  setupRun,
  setupUninstallCommand,
  setupConnectCommand(connectors),
];
