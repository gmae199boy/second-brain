// The Claude Code connector. Every public name carries the harness in it,
// because the one writing surface re-exports this package beside the others and
// two exports of the same name would be an error there, not a choice.
//
// `setup.connect` — the settings file this harness reads, and the hook entry in
// it — is deliberately absent: it is the plugin's, in story 2.14, and a
// connector registered before then would change the installer's harness step
// twice.
export {
  CLAUDE_CODE_HARNESS,
  CLAUDE_CODE_PARSER_VERSION,
  claudeCodeParser,
} from './parser.js';
export { readClaudeCodeHookInput } from './hook.js';
