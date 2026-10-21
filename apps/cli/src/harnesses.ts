import {
  claudeCodeConnector,
  type Connector,
  claudeCodeParser,
  claudeCodeTranscriptFolder,
  readClaudeCodeHookInput,
  type HookInputReader,
  type Parser,
  type TranscriptFolder,
} from 'second_brain';

/**
 * One harness this build can ingest from: the parser that reads its transcript,
 * the reader that makes sense of its hook payload, and where its transcripts
 * live (AD-4).
 */
export interface Harness {
  parser: Parser;
  connector(env: NodeJS.ProcessEnv): Connector;
  readHookInput: HookInputReader;
  /**
   * This harness's transcript folder for one environment. A function because
   * where the folder is comes out of the environment — Claude Code reads
   * `CLAUDE_CONFIG_DIR` — and reading environments is the Runtime's job (AD-1).
   */
  transcriptFolder(env: NodeJS.ProcessEnv): TranscriptFolder;
}

export const harnesses: readonly Harness[] = [
  {
    parser: claudeCodeParser(),
    connector: (env) => claudeCodeConnector({ configDir: claudeConfigDir(env) }),
    readHookInput: readClaudeCodeHookInput,
    transcriptFolder: (env) => claudeCodeTranscriptFolder({ configDir: claudeConfigDir(env) }),
  },
];

/** The parsers of the registry, as `createBrain` wants them (AD-4). */
export function harnessParsers(registry: readonly Harness[] = harnesses): readonly Parser[] {
  return registry.map((harness) => harness.parser);
}

/** Where Claude Code keeps its configuration, when the environment says. */
const CLAUDE_CONFIG_DIR_ENV = 'CLAUDE_CONFIG_DIR';

/** Every registered transcript folder for this invocation. */
export function transcriptFolders(
  env: NodeJS.ProcessEnv,
  registry: readonly Harness[] = harnesses,
): readonly TranscriptFolder[] {
  return registry.map((harness) => harness.transcriptFolder(env));
}

/**
 * The editor's configuration folder, or `undefined` to let the adapter fall
 * back to `~/.claude`.
 *
 * Empty is not a folder: an exported-but-empty `CLAUDE_CONFIG_DIR` is how a
 * shell says "unset" by accident, and reading transcripts out of the process's
 * current directory because of it would be the one mistake nothing else here
 * could catch.
 */
function claudeConfigDir(env: NodeJS.ProcessEnv): string | undefined {
  const configured = env[CLAUDE_CONFIG_DIR_ENV];
  return configured === undefined || configured === '' ? undefined : configured;
}
