// Python integration uses the daemon, its real store, extension runtime and
// subprocesses; these paths have effects beyond Vitest's TS import graph.
const rules = [
  { prefix:'extensions/', reason:'extension runtime and payloads' },
  { prefix:'packages/postgres/', reason:'Python integration uses the real PostgreSQL store' },
  { prefix:'packages/core/src/queue/', reason:'daemon work scheduling and supervision' },
  { prefix:'packages/core/src/process-abi/', reason:'supervised extension process protocol' },
  { prefix:'packages/core/src/extensions/', reason:'extension lifecycle' },
  { prefix:'packages/core/src/imports/', reason:'import lifecycle' },
  { prefix:'packages/core/fixtures/extensions/', reason:'shared extension fixtures' },
  { prefix:'packages/core/schemas/', reason:'core schema resources' },
  // daemon/run.ts calls handoffChannelRequests on every drain round.
  { prefix:'packages/core/src/channels/', reason:'daemon channel handoff' },
  // createBrain and the queue use file import handlers, work domain and settings.
  { prefix:'packages/core/src/files/', reason:'core file import and cleanup' },
  { prefix:'packages/core/src/domain/', reason:'queue, ABI and extension work domain' },
  { prefix:'packages/core/src/settings/', reason:'daemon schedule and extension settings' },
  { prefix:'packages/core/src/users/', reason:'extension and daemon self resolution' },
  { prefix:'packages/core/src/spool/', reason:'daemon queue spool replay' },
  { prefix:'apps/cli/src/mcp/', reason:'extension MCP runtime' },
  { prefix:'apps/cli/src/daemon/', reason:'daemon supervisor and drain' },
  { prefix:'apps/cli/src/runtime/', reason:'extension and file runtime' },
  { prefix:'apps/cli/src/install/', reason:'installed runtime and extension setup' },
  { prefix:'apps/cli/src/config/', reason:'Python tests and daemon use config codec and paths' },
  { prefix:'apps/cli/src/doctor/', reason:'daemon assembly uses runtime checks' },
  { prefix:'apps/cli/src/commands/ext', reason:'extension commands' },
  { prefix:'apps/cli/test/fixtures/extensions/', reason:'extension test fixtures' },
  { prefix:'tooling/test-db/', reason:'Python global setup and pg-home use test-db' },
  { prefix:'tooling/test-changed/', reason:'changed-test configuration and rules' },
];
const exact = [
  // runDaemon imports createBrain/checkSchema and core queue uses these helpers.
  'packages/core/src/ports/process.ts','packages/core/src/ports/cron.ts','packages/core/src/brain.ts','packages/core/src/schema.ts','packages/core/src/local-time.ts',
  'packages/core/src/error-text.ts','packages/core/src/codes.ts','packages/core/src/index.ts',
  'packages/core/src/instant.ts','packages/core/src/envelope.ts',
  'packages/second_brain/src/index.ts','packages/second_brain/src/postgres.ts','packages/second_brain/src/testing.ts',
  // pg-home calls sampleSelfUserInput via these testing exports.
  'packages/core/src/testing/index.ts','packages/core/src/testing/fixtures.ts',
  // The fixture spawns the CLI and uses config, database and home helpers.
  'apps/cli/src/bin.ts','apps/cli/src/dispatch.ts','apps/cli/src/assembly.ts',
  'apps/cli/src/harnesses.ts','apps/cli/src/error-text.ts','apps/cli/src/envelope.ts',
  'apps/cli/src/commands/mcp-serve.ts','apps/cli/src/commands/index.ts','apps/cli/src/commands/daemon-status.ts',
  'apps/cli/test/ext-fixture.ts','apps/cli/test/global-setup.ts','apps/cli/test/pg-home.ts',
  'apps/cli/test/temp-home.ts','apps/cli/test/environment.ts',
  'apps/cli/python-test/vitest.config.ts','package.json','pnpm-lock.yaml',
];
const hook = 'tooling/bootstrap/test/hook.test.ts';

export function classifyChanges(paths) {
  const matched = rules.filter(rule => paths.some(path => path.startsWith(rule.prefix)));
  const exactMatches = paths.filter(path => exact.includes(path));
  // The full bootstrap rule takes precedence even when its hook test changed.
  const bootstrapChanged = paths.some(path => path.startsWith('tooling/bootstrap/'));
  const pythonFiles = [...new Set(paths.filter(path => /^apps\/cli\/python-test\/[^/]+\.test\.ts$/.test(path) || path === hook))];
  return {
    pythonAll: matched.length > 0 || exactMatches.length > 0 || bootstrapChanged,
    pythonFiles,
    postgresAll: paths.some(path => path.startsWith('packages/postgres/migrations/')),
    reasons: [
      ...matched.map(({prefix,reason}) => ({prefix,reason})),
      ...exactMatches.map(path => ({prefix:path,reason:'Python integration dependency'})),
      ...(bootstrapChanged ? [{prefix:'tooling/bootstrap/',reason:'bootstrap runtime'}] : []),
    ],
  };
}
