import {
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
  readHookInput: HookInputReader;
  /**
   * This harness's transcript folder for one environment. A function because
   * where the folder is comes out of the environment — Claude Code reads
   * `CLAUDE_CONFIG_DIR` — and reading environments is the Runtime's job (AD-1).
   */
  transcriptFolder(env: NodeJS.ProcessEnv): TranscriptFolder;
}

/**
 * The ingest registry: every harness `brain sessions ingest <harness>` accepts,
 * and the parsers `createBrain` is handed.
 *
 * It is deliberately a second list beside `connectors/index.ts` rather than a
 * field on `Connector`. Registering a connector changes what the installer
 * offers and what `brain setup connect` writes, and the Claude Code side of
 * that — the plugin, its hook entry, the settings file — is story 2.14's. Until
 * then ingesting has to work without claiming the harness is connected, and two
 * lists is what says so. 2.14 folds this one into the connector, where
 * `readHookInput` belongs.
 */
export const harnesses: readonly Harness[] = [
  {
    parser: claudeCodeParser(),
    readHookInput: readClaudeCodeHookInput,
    transcriptFolder: (env) => claudeCodeTranscriptFolder({ configDir: claudeConfigDir(env) }),
  },
];

/** The parsers of the registry, as `createBrain` wants them (AD-4). */
export function harnessParsers(registry: readonly Harness[] = harnesses): readonly Parser[] {
  return registry.map((harness) => harness.parser);
}

/**
 * The switch that lets this build read a harness's transcript folder at all.
 *
 * It exists because reading the folders means collecting whatever is on the disk
 * *now*, under *this* build's parser and masking rules — and the stories that
 * settle both are not finished (epic decision: real collection is turned on in
 * 2.14). A stored message is never rewritten (AD-11), so a session imported
 * early would keep the old reading for good. So the folders are off unless
 * somebody asks for them, and story 2.14 removes this switch and turns them on
 * by default (Decision 1, 2026-10-19).
 *
 * The hook path does not depend on it: a hook reports a transcript path, and
 * collecting what a hook named has never needed a folder.
 */
export const CAPTURE_ENV = 'SECOND_BRAIN_CAPTURE';

/** The value of that switch that means on. Exactly `1`, and nothing else. */
const CAPTURE_ON = '1';

/** Where Claude Code keeps its configuration, when the environment says. */
const CLAUDE_CONFIG_DIR_ENV = 'CLAUDE_CONFIG_DIR';

/**
 * The transcript folders this invocation may look in: every harness's, or none.
 *
 * None is the ordinary answer, and it turns off three things at once — the
 * drain's folder scan, finding a transcript from a session token alone, and
 * doctor's `transcripts` check (`BrainDependencies.transcriptFolders`).
 */
export function transcriptFolders(
  env: NodeJS.ProcessEnv,
  registry: readonly Harness[] = harnesses,
): readonly TranscriptFolder[] {
  if (env[CAPTURE_ENV] !== CAPTURE_ON) return [];
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
