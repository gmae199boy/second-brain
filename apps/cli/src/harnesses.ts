import {
  claudeCodeParser,
  readClaudeCodeHookInput,
  type HookInputReader,
  type Parser,
} from 'second_brain';

/**
 * One harness this build can ingest from: the parser that reads its transcript
 * and the reader that makes sense of its hook payload (AD-4).
 */
export interface Harness {
  parser: Parser;
  readHookInput: HookInputReader;
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
  { parser: claudeCodeParser(), readHookInput: readClaudeCodeHookInput },
];

/** The parsers of the registry, as `createBrain` wants them (AD-4). */
export function harnessParsers(registry: readonly Harness[] = harnesses): readonly Parser[] {
  return registry.map((harness) => harness.parser);
}
