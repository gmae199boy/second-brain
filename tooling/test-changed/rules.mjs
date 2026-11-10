// Python integration uses the daemon, its real store, extension runtime and
// subprocesses; these paths have effects beyond Vitest's TS import graph.
const rules = [
  { prefix:'apps/cli/src/commands/messengers-', reason:'messenger credential CLI used by channel workers' },
  { prefix:'apps/cli/src/workers/channel-send.ts', reason:'channel adapter credential selection child process' },
  { prefix:'apps/cli/src/commands/channels-', reason:'core channel CLI and dispatch integration' },
  // Includes Garmin native SQL, pinned SQLite oracle, Python fixtures and subprocess readers.
  { prefix:'extensions/', reason:'extension runtime, Garmin native SQL, Python oracle and subprocess fixtures' },
  { prefix:'plugins/testext/', reason:'extension plugin package and launcher' },
  { prefix:'plugins/garmin/', reason:'Garmin extension plugin package and launcher' },
  { prefix:'tooling/recall-eval/', reason:'shared recall health integration fixtures' },
  { prefix:'tooling/package-garmin/', reason:'Garmin extension packaging source' },
  { prefix:'tooling/garmin-import/', reason:'Garmin capture Python implementation and tests' },
  { prefix:'packages/postgres/migrations/0042_drive_connection.sql', reason:'Drive connection and local-delete safety migration' },
  { prefix:'packages/postgres/test/fixtures/drive-delete-barrier-child.mjs', reason:'Drive deletion barrier child-process fixture' },
  { prefix:'packages/postgres/', reason:'Python integration uses the real PostgreSQL store' },
  { prefix:'packages/core/src/sources/', reason:'source sync and Drive subprocess integration' },
  { prefix:'packages/core/src/ports/source-', reason:'external source runtime contracts' },
  { prefix:'apps/cli/test/source-runtime.test.ts', reason:'source temporary-file child process fixture' },
  { prefix:'apps/cli/test/drive-source-tracer.test.ts', reason:'source sync and temporary-file child process tracer' },
  { prefix:'packages/core/src/queue/', reason:'daemon work scheduling and supervision' },
  { prefix:'packages/core/src/process-abi/', reason:'supervised extension process protocol' },
  { prefix:'packages/core/src/extensions/', reason:'extension lifecycle' },
  { prefix:'packages/core/src/testing/contracts/extension-quiesce.ts', reason:'quiesce store contract' },
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
  { prefix:'apps/cli/src/runtime/document-parser-child.ts', reason:'document extraction child process' },
  { prefix:'apps/cli/src/runtime/', reason:'extension and file runtime' },
  { prefix:'apps/cli/src/install/', reason:'installed runtime and extension setup' },
  { prefix:'apps/cli/src/config/', reason:'Python tests and daemon use config codec and paths' },
  { prefix:'apps/cli/src/doctor/', reason:'daemon assembly uses runtime checks' },
  { prefix:'apps/cli/src/commands/ext', reason:'extension commands' },
  { prefix:'apps/cli/test/fixtures/extensions/', reason:'extension test fixtures' },
  { prefix:'apps/cli/test/fixtures/drive-refresh-lock-child.mjs', reason:'Drive refresh lock subprocess recovery fixture' },
  { prefix:'apps/cli/test/fixtures/fake-drive.ts', reason:'shared Drive HTTP fixture and child-process integration' },
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
  'apps/cli/src/bin.ts','apps/cli/src/dispatch.ts','apps/cli/src/assembly.ts','apps/cli/scripts/write-build-info.mjs',
  'apps/cli/src/harnesses.ts','apps/cli/src/error-text.ts','apps/cli/src/envelope.ts',
  'apps/cli/src/commands/mcp-serve.ts','apps/cli/src/commands/index.ts','apps/cli/src/commands/daemon-status.ts',
  'apps/cli/test/ext-fixture.ts','apps/cli/test/extension-commands.test.ts','apps/cli/test/install-lock.test.ts','apps/cli/test/ext-package.test.ts','apps/cli/test/ext-install-resume.test.ts','apps/cli/test/global-setup.ts','apps/cli/test/pg-home.ts',
  'apps/cli/test/temp-home.ts','apps/cli/test/environment.ts','.claude-plugin/marketplace.json',
  'apps/cli/python-test/garmin-report-observer.ts',
  'apps/cli/python-test/fixtures/artifacts-lifecycle.ts',
  'apps/cli/python-test/fixtures/lifecycle-timeout.fixture.ts',
  'apps/cli/python-test/fixtures/lifecycle-vitest.config.mjs',
  'apps/cli/python-test/vitest.config.ts','apps/cli/python-test/global-setup.ts','vitest.config.ts','package.json','pnpm-lock.yaml',
];
const hook = 'tooling/bootstrap/test/hook.test.ts';
// These independent Vitest files are not Python runtime inputs. Keep this
// exemption scoped to the two broad rules, not to other matching rules.
const independentTests = new Set([
  'tooling/test-db/test/test-changed.test.ts',
  'tooling/test-db/test/test-changed-record.test.ts',
  'packages/postgres/test/schedule-occurrences.test.ts',
  'packages/postgres/test/user-keys.test.ts',
]);

export function classifyChanges(paths) {
  const matched = rules.filter(rule => paths.some(path => path.startsWith(rule.prefix) &&
    !((rule.prefix === 'tooling/test-db/' || rule.prefix === 'packages/postgres/') && independentTests.has(path))));
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
