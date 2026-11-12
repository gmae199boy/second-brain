# Garmin v2 report repair

Date: 2026-11-12. Base `origin/main` / `a1c32a47`; branch `fix/garmin-report-v2`; implementation SHA `44410646`. Only the assigned branch is delivered. No production DB writes, report storage, sending, deployment, main merge or main push occurred.

## Confirmed failure cause

The v2 generation schema accepted arbitrary `limitations.scope` and `affected_judgment` strings, while reference validation required the report scope and a single existing judgment/indexed row. The model interpreted scope as an exercise/activity and sometimes targeted a whole findings array. Valid schema output then failed `_read_output` reference validation.

| Isolated reproduction | Model exit | Seconds | Event bytes | Output bytes | Result |
| --- | --- | ---: | ---: | ---: | --- |
| Repository synthetic mixed day; gpt-6.1-sol/high, one call | 0 | 137.088 | 27,746 | 16,011 | Base JSON/schema accepted; reference validation rejected limitation targets/scopes |
| Operational day copy; same model/effort, one call | 0 | 280.932 | 1,332,485 | 28,238 | Base JSON/schema accepted; reference validation `LIMITATION_SCOPE`, 13 mismatching rows |

The operational check used the **base schema** again after the model returned, so the conclusion does not depend on schema edits made during the call. The six earlier deleted production attempts cannot be individually reconstructed; the operational isolated reproduction confirms the same defect as the synthetic call.

Automatic approval initially rejected sending operational health data to external Codex. The copy was deleted, and the coordinator obtained and supplied explicit user permission for that same destination and isolated purpose. The approved operational reproduction then ran without DB access or delivery. Temporary operational inputs/model outputs were deleted after extracting only the metadata above; no health values or report bodies are committed.

## Changes

- Generation schema restricts limitation scope to report scopes and target shape to a judgment or indexed row; each actual request further fixes top-level/limitation scope to its own scope. Skills explain scope copying, single-row targets and original evidence pointers. Validation distinguishes `LIMITATION_SCOPE` from `LIMITATION_TARGET`.
- New fenced diagnostics reserve budget and insert start metadata in the **same transaction**, then record end, elapsed milliseconds, fixed code, terminal decision and input/output/event bytes. No model text or health values enter the table. A resumed valid owner reconciles abandoned starts and preserves the latest actionable feedback. Interrupted calls consume budget and do not erase the actionable error streak. Known terminal classification survives partial/failed notification independently of delivery state.
- Retry budget is three total reservations, with previous fixed validation code in the next Codex/Claude prompt. Repeating the same class stops after two calls; unsupported provider/capability/login and output-limit errors stop immediately, and timeout stops after one call. Three allows an initial response plus two distinct repairs, instead of six blind restarts. This deliberately bounds cost/latency; it does not claim an empirically optimized recovery probability. Counters and terminal decisions survive supervisor retries.
- Model-only compact view preserves every C1 session, set, strength summary, current/comparison window, coverage, recovery context and missing value. Only dense HR arrays become computed min/max/mean/count/time summaries, explicitly retaining unknown quality and forbidding sample-count-to-zone-time inference. Original C1 remains unchanged and validates all canonical pointers; a reference index covers each session/set/HR array. Model folders contain the compact view, profile and same-scope prior hypotheses instead of raw exports/repeated projections.
- Two scope tasks run concurrently, each with inherited account context and independent short fenced write sessions. The outer report advisory lock remains held. A model slot is retained until **all active sibling trees are quiescent and the supervisor group is verified empty**; decoding, workspace deletion and repair never race live descendants. Spawn/cancellation share a gate, cancellation sweeps before joining and verifies again afterward, and first fatal exceptions are preserved. This conservative batch barrier can hold a fast sibling until the slower model ends.
- Known deterministic failures persist and emit an idempotent per-work/per-scope failure event before waiting on slow siblings. Output-limited direct children are terminated/reaped before notification can block on DB/account locks. Other failures emit when that scope's repair budget ends, without waiting for all four periods. Success publishing still requires all four saved results.

Primary source files: `extensions/garmin/src/garmin_pipeline/{report,analysis_agent,analysis_output,analysis_diagnostics,compact_measurements}.py`, `src/report_channel.py`, `src/garmin_pipeline/schemas/training_analysis_output_v2.schema.json`, the daily/period internal analysis skills, and native store schema version. Tests update `test_report_supervised.py`, `test_report_process.py`, `test_compact_measurements.py`, `test_store_contract_integration.py`, report fake Codex/Claude executables and `apps/cli/python-test/garmin-report.test.ts`. Product copies, manifest inventory and digest were regenerated under `plugins/garmin/package/`.

## Migration and versions

New append-only migration: `0022_analysis_attempt_diagnostics.sql`, creating `garmin.analysis_attempt_diagnostics`. Existing 0021 is untouched. Native schema 21 → 22; Garmin manifest 1.2.9 → 1.2.10; Garmin plugin 0.1.16 → 0.1.17. No public CLI command or setting was added. Plugin app-ref is unchanged; release ref publication belongs to the coordinator after integration.

## Independent review

Requested reviewer: Codex gpt-6.1-sol/medium, same worktree, its own Run. Review chain: `ctx_cd23f36e1b84`, `ctx_64ca811e980a`, `ctx_80d74d15ed79`, `ctx_846a6dcd1141`, `ctx_be0bfacebe57`. All findings were accepted and fixed: migration numbering, stable output/descendant ownership, cancellation spawn gate, restart feedback, reservation atomicity, early notification, classification versus delivery, and termination before blocking notification. Final follow-up cleared the verification-discovered first-fatal preservation fix at `44410646`. Full value-free review history is `.brain-automation/report-v2-review.md`. Reviewer ran no tests; the owner ran validation below.

## Validation evidence

Only directly related files/cases were run after implementation and review; no full suite or test:changed was run. Test DBs and fake-model processes were owned disposable synthetic fixtures.

| Command / scope | Exit | Evidence |
| --- | ---: | --- |
| `pnpm build` | 0 | Final product build and bundled extension copy refreshed; log `/tmp/brain-report-build.log` |
| `pnpm typecheck` | 0 | `/tmp/brain-report-typecheck.log` |
| `git diff --check` | 0 | Checked after final changes |
| `pnpm exec vitest run tooling/bootstrap/test/garmin-plugin.test.ts` | 0 | 3 package identity/payload/digest tests; `/tmp/brain-report-package-test.log` |
| Selected `garmin-unit.test.ts` via Python slots, ten named Python files | 1 then repaired subset 0 | 128 tests: 123 initially passed; four exposed primary fatal exception masking and one fixture assumed a non-NULL comparison. The corrected two files re-ran as 32 tests, all passing, both directly and through the same owned-DB harness. The other 96 tests passed initially, including real PG rollback/restart/fencing and real process cleanup/early-notification checks. Reports `/tmp/brain-report-targeted-pg.json`, `/tmp/brain-report-final-unit.json`; direct log `/tmp/brain-report-unit-recheck.log` |
| Report integration file via Python slots | 1 then failed cases 0 | All 18 cases covered: 16 initial passes, one install preflight overlapped build replacement and passed alone after build settled, one revocation test needed both first models held to remove launch-order assumptions and passed after fixture correction (an intermediate assertion-only recheck also failed before adding those explicit holds). Reports `/tmp/brain-report-integration.json`; rechecks `/tmp/brain-report-invalid-recheck.log`, `/tmp/brain-report-revoked-recheck.log` |

Python file selection: `test_report_supervised.py,test_report_process.py,test_analysis_output_v2.py,test_compact_measurements.py,test_analysis_agent.py,test_report_channel.py,test_report_runtime.py,test_report_store_pg.py,test_store_contract_integration.py,test_native_store.py` using `GARMIN_UNIT_TEST_FILES` and `node tooling/test-db/dist/python-slots.js --files apps/cli/python-test/garmin-unit.test.ts --slots 1`. Recheck used only `test_report_supervised.py,test_compact_measurements.py`. Integration used `--files apps/cli/python-test/garmin-report.test.ts --slots 1`; failed-case rechecks used the same file with exact Vitest `-t` names. No skipped case is counted as a pass: 17 cases shown as skipped in each single-case recheck were already covered by the original file run.

Initial harness setup failures are recorded as failures, not successes: sandbox Docker access required escalation; an earlier stale build copy still contained duplicate 0021 and was refreshed before actual Python execution. An unsupported system Python compile attempt was replaced with the project's Python 3.14 runtime. Registry DNS/build and Docker socket restrictions were retried with approved escalation.

## Post-fix real-model measurement

Same operational snapshot in an isolated temporary workspace, same gpt-6.1-sol/high, no operational storage/DB/sending. Each period uses one model call and full schema/reference validation. Temporary folders delete their inputs and outputs after the call; only fixed classifications/counts remain.

| Scope | Result | Seconds | Model input bytes | Output bytes | Event bytes |
| --- | --- | ---: | ---: | ---: | ---: |
| day | SUCCESS, first call | 242.731 | 308,821 | 26,788 | 568,812 |
| 7d | SUCCESS, first call | 299.254 | 90,666 | 34,695 | 227,393 |

Both calls passed the generated scope-specific schema and original-C1 reference validation. Both temporary workspaces and their inputs/model outputs were deleted; the metadata-only log is `/tmp/brain-report-final-check.log`.

The raw day C1 alone was 2,003,887 bytes; its compact view was 305,610 bytes (84.7% smaller), plus profile/hypothesis input. Day events fell from 1,332,485 to 568,812 bytes. The fixed successful day call took 38.201 seconds less than the isolated failing base call (13.6%), but one failing/successful sample does not establish a stable latency distribution. A four-period real run was intentionally not invoked; total parallel report duration is not measured.

## Deployment checks for coordinator

1. Run the required central integration full regression once before main delivery; this worker did not substitute targeted checks for that gate.
2. Install/upgrade the regenerated Garmin package and confirm migration 22/native schema 22 and version 1.2.10. Publish the earlier-commit plugin app-ref with its required release version bump separately.
3. Observe the next approved work's diagnostics: four scopes, maximum two live model tasks, bounded attempt reservations, no unfinished rows after completion, stable fixed codes and byte counts, and fenced results. Durations include preparation/cleanup/barrier waits.
4. Confirm all four results share the sealed snapshot and pass provenance checks before report publication. Verify early failure events remain idempotent and completed report delivery only follows four successful saved periods.
5. Existing exhausted work counters remain exhausted; do not treat installation as permission to rerun, send, or overwrite production work. No production cleanup/cancel/retry was performed by this worker.

Final delivery commit also contains only the deterministic revocation fixture correction and this value-free report/review history; the worker_done receipt supplies its exact branch head SHA.
