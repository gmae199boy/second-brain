# Fatal-error preservation follow-up at `44410646`

**Disposition: no actionable findings in the small diff since `285ffa96`.** Previous cleared dispositions remain unchanged.

`evaluate_scope` stores the first escaping `BaseException` while holding `fatal_lock` before setting the shared cancellation event. Therefore a queued scope awakened by cancellation cannot replace that recorded primary with its secondary cancellation error. The host reads the same protected slot when `future.result()` raises and re-raises the original exception object, preserving its exception class and traceback. The existing outer finally still records that primary, closes the model gate, joins threads, verifies group cleanup and attaches cleanup notes without replacing the primary. The lock protects only the shared error slot; it is not held during model execution, database calls or shutdown.

The compact coverage test now provides a copied synthetic comparison window before capturing its immutability baseline, so its assertions exercise preservation and canonical pointers for both windows rather than dereferencing a NULL fixture. The separate dense-sample test still uses the original fixture, including its NULL comparison; production compact behavior is unchanged.

No tests were executed by this reviewer. The coordinator reports the targeted run and the subsequent 32-test recheck passed as described in the dispatch; those results are external evidence, not an independently rerun result. This review ran `git diff --check`, parsed the changed Python files with Python 3.12, and verified matching source/package payload bytes and canonical digest; all succeeded. Other integration/model verification remains with the implementation owner/coordinator.

---

# Earlier review history

# Final boundary follow-up at `285ffa96`

**Disposition: findings 7 and 8 cleared by inspection; no remaining actionable findings in this follow-up scope.** Prior findings 1–6 retain the dispositions recorded below. This is a code review result, not a test-pass claim.

| Finding | Verified fix |
| --- | --- |
| 7. Partial notification erases terminal classification | `WriterFailed` now records fixed classification and its own in-memory `terminal` flag without calling external code. Notification tracks attempted and delivered separately. `_evaluate_with_retries` preserves a known terminal classification on callback exceptions regardless of delivery success, and its final diagnostic update retains `terminal=true`. Resume uses the persisted terminal result to avoid another model reservation. |
| 8. Notification blocks direct-child termination | `_run` catches `WriterFailed`, calls `_end_child` to terminate and reap the direct process, then invokes notification. Its finally still enforces ModelBatch quiescence before returning, decoding or retrying. Errors discovered after `_run` notify from the outer retry path when no direct child is active. |

Read the new callback-failure/resume test and direct-child-before-notification test. The former checks the finalized code/terminal state and no further reservation on resume; the latter injects notification failure after asserting direct-child termination was requested and checks that the known code/terminal survives. The implementation's `_end_child` also waits for direct-child exit before notification. The existing synthetic process test continues to exercise notification before the slow sibling returns and group quiescence before final return.

No tests, model invocations, operational reads or helper agents were used, and no code was edited. `git diff --check` passed; Python 3.12 parsed all declared packaged Python payloads; source/package bytes and canonical digest match. The implementation owner should now execute the directly related test files required by the repository's final-validation policy.

---

# Earlier review history

# Second follow-up at `a6477af0`

Reviewed the early terminal notification changes and current clean source/package worktree without tests, model invocations, operational access, code edits or helper agents. Findings 1–5 remain cleared. Finding 6's original output-limit timing issue is addressed on the successful callback path: `WriterFailed` invokes the callback before entering the batch barrier, and complete oversized event streams retain the `OUTPUT_LIMIT` classification. Two actionable failure-boundary issues remain in that callback path.

## Remaining actionable findings

### 7. Medium — a partially successful notification loses its durable terminal classification

**Location:** `extensions/garmin/src/garmin_pipeline/report.py:143-146`, `report.py:1429-1438`, `report.py:1469-1478` (same packaged code).

**Failure scenario:** `_notify_terminal_scope` commits `OUTPUT_LIMIT` with `terminal=true`, then `report_channel.failure` fails transiently or execution is interrupted before the callback returns. `diagnostic.notified` is still false because it is assigned only after the entire callback. If the valid worker can subsequently finalize its diagnostic, `_evaluate_with_retries` changes the code to `INTERRUPTED` and writes `terminal=false`, overwriting the already committed actionable terminal state. A resumed owner then treats the deterministic failure as repairable and can invoke the model again. Revoked fencing prevents the overwrite when the worker is stale, but it does not protect a still-valid worker after a transient event-write failure or ordinary SIGTERM.

**Minimal fix:** Record “terminal classification known” independently of “notification fully completed” before invoking the callback, and preserve that known code/terminal through callback exceptions and finalization. Keep event emission idempotent and separately retryable; do not use delivery completion as the condition for retaining the classification. Add a callback-boundary case that commits the diagnostic then raises before returning, verifies finalization retains `OUTPUT_LIMIT/true`, and verifies resume does not reserve another model attempt.

### 8. Medium — synchronous notification delays terminating an output-limited child

**Location:** `extensions/garmin/src/garmin_pipeline/report.py:636-637`, `report.py:143-145`, `report.py:656-664`.

**Failure scenario:** A still-running model exceeds the output byte cap. Constructing `WriterFailed` immediately performs two synchronous fenced write sessions through the callback before `_run` reaches `_end_child`. If collection or another writer holds the account lock, these sessions can each wait up to the configured lock timeout while the rejected child keeps running and writing the file. The one-second limit polling cannot enforce prompt termination during that wait, and a runaway child can continue consuming CPU/disk after the host already detected the limit. The new real-process test uses an immediate in-memory callback and a child that prints once then sleeps, so it does not expose this ordering.

**Minimal fix:** Keep exception construction free of blocking notification I/O. On a detected terminal stream limit, terminate/reap the direct child first, then notify before `ModelBatch.complete` waits for siblings; retain the existing group cleanup barrier before decoding, retrying or deleting the workspace. Add an ordering test with a deliberately blocked callback that asserts direct-child termination has already happened while notification remains blocked.

## Verification

No tests ran. `git diff --check` passed; Python 3.12 parsed every declared packaged Python payload; source/package payload bytes and the canonical digest match. The new synthetic process test was read and does cover notification before the slow sibling returns on the normal callback path, but it does not exercise callback partial success, callback exceptions, or account-lock contention.

The implementation owner should resolve findings 7–8 and then execute the directly related files after final edits.

---

# Previous review history

# Follow-up disposition at `bdceff68`

Reviewed HEAD and the clean source/package worktree against the five initial findings. No tests, model invocations, operational reads or code edits were performed. The original review is retained below as history; its five defects are now cleared by inspection, with one remaining behavioral issue introduced by the batch barrier.

## Remaining actionable finding

### 6. Medium — terminal failure notification waits for the slow sibling

**Location:** `extensions/garmin/src/garmin_pipeline/report.py:354-368`, `report.py:629-660`, `report.py:1549-1558` (same packaged code).

**Failure scenario:** A day model exceeds the event/output byte limit while its 7d sibling is still running. This is a deterministic `OUTPUT_LIMIT` failure and requires no repair. `_run` has already detected it and terminated its direct child, but its finally blocks inside `batch.complete()` until the sibling ends. Consequently the scope diagnostic cannot finish, its future cannot complete, and the host cannot emit the early failure event until that slow sibling exits or reaches its model deadline. The batch barrier restores safe output/retry ordering but removes the promised early failure behavior for actual model processes; the fake-writer concurrency acceptance test bypasses `ModelBatch` and still passes conceptually.

**Minimal fix:** Separate observation of an already known terminal failure from releasing its process slot. Have `_run` report a fixed-code terminal outcome to the host when detected, allow the host to emit its idempotent failure event while waiting for batch quiescence, and retain the cleanup barrier before output decoding, retries, workspace deletion and final completion. Alternatively introduce verifiable per-attempt descendant cleanup so a failed scope can finish independently. Add a deterministic real-process case with one output-limited child and one held sibling, asserting the failure event appears before releasing the sibling; keep the existing no-descendant-before-retry assertions.

## Cleared findings and evidence

| Initial finding | Disposition | Evidence |
| --- | --- | --- |
| 1. Duplicate migration 0021 | Cleared | Diagnostics migration is now 0022; the existing 0021 remains; source and packaged store require schema 22. Package migration sequence is contiguous 0001–0022. |
| 2. Descendants overlap decoding/retry | Cleared | Every successful spawn increments `ModelBatch.active`; each `_run` reaps its direct child and waits in `complete`; the final active sibling performs verified group cleanup under the condition before any waiter returns to decode or retry. |
| 3. Late spawn after cancellation sweep | Cleared | `spawn` and `cancel` share the condition; cancellation closes the gate before the host cleanup; host joins workers and verifies the group again afterward. Cleanup failures preserve the primary fatal exception and add a note. |
| 4. Restart loses actionable feedback | Cleared | A valid owner reconciles unfinished rows to `INTERRUPTED`, then retrieves the latest completed code excluding lifecycle/success markers. Interruptions explicitly preserve the actionable-error streak. |
| 5. Counter and diagnostic commit separately | Cleared | `_reserve_scope_attempt` increments the budget and inserts the initial row in the same write session and fenced transaction. |

Read the new real leaked-descendant test, delayed-spawn gate test, PostgreSQL reservation rollback test, restart reconciliation/fenced completion test, compact fake CLI changes and integration expectation updates. These now exercise the missing process and persistence boundaries in their code; no claim is made that they passed because this reviewer did not run them.

## Follow-up verification

`pnpm typecheck` and `git diff --check` passed. Python 3.12 parsed all declared packaged Python payloads successfully. The initial attempt to parse the full payload with system Python 3.9 encountered pre-existing Python 3.12 generic syntax; rerunning with the supported interpreter succeeded. Read-only comparison found no source/package payload mismatches, the canonical package digest matches, and migration numbering is contiguous through 22. Extension manifest remains `1.2.10`; plugin and packaged plugin version remain `0.1.17`.

The implementation owner still needs to resolve finding 6 or explicitly change the early-failure requirement, then run directly related test files after final edits.

---

# Initial review history

# Garmin v2 report repair independent review

Reviewed branch `fix/garmin-report-v2` against `a1c32a47`, through HEAD `804f8a67`, including current unstaged source, acceptance tests, untracked compact tests and generated package bytes. Review only: no code edits, tests, model invocations, operational data access, commit or push. Adversarial, edge-case and verification-gap passes were performed directly without helper agents; findings below are consolidated to avoid repeating the same defect.

## Findings

### 1. High — new migration reuses the already occupied number 0021

**Location:** `extensions/garmin/migrations/0021_analysis_attempt_diagnostics.sql:1`; `plugins/garmin/package/manifest.json:1196`.

**Failure scenario:** The base already contains `0021_fetch_error_message.sql`, and the package now declares both 0021 files. `packages/core/src/extensions/migration-names.ts:7` rejects this sequence with `missing or duplicate migration number`, so fresh installation and upgrade cannot load the repaired package. On an existing installation, 0021 is also already applied history and cannot be repurposed.

**Minimal fix:** Rename the diagnostics migration to `0022_analysis_attempt_diagnostics.sql`, advance `store.NATIVE_SCHEMA_VERSION` from 21 to 22, and regenerate the package manifest/digest and copied store bytes. Preserve the existing 0021 file unchanged. The current extension/plugin versions are mutually consistent, but their matching bytes do not make the migration sequence valid.

### 2. High — deferred group cleanup permits overlapping attempts and live writers after validation

**Location:** `extensions/garmin/src/garmin_pipeline/report.py:597-601`, `report.py:1375-1393`, `report.py:1503-1506` (same code in packaged copy).

**Failure scenario:** A model CLI starts a tool descendant and then exits or fails while that descendant remains alive. In parallel mode `_run` only reaps the direct child; it no longer proves that the attempt's descendants stopped. Output decoding, validation, retry and the next queued scope proceed while the old descendant can still write the attempt output/events or mutate its workspace. Retrying a failed scope can therefore exceed the intended two concurrent active model trees, and a result can be validated/saved while a previous writer remains active. Final cleanup eventually stopping it does not undo these overlaps or establish stable output bytes.

**Minimal fix:** Do not decode, delete an attempt workspace, retry, or release its slot until that attempt's descendant termination is confirmed. The smallest conservative repair is to keep scopes serial with the existing group cleanup until safe parallel ownership is implemented. To retain parallel execution within the supervisor group, introduce verifiable per-attempt descendant ownership/cleanup; alternatively quiesce the whole batch and clean its group before starting any repairs, discarding/retrying a sibling if necessary. A blanket group cleanup inside an individual parallel `_run` would kill its sibling and is unsafe.

**Coverage:** Existing real-descendant tests in `test_analysis_agent.py` and process tests exercise standalone `_run`, where `_parallel_analysis` is false; the new concurrency test uses a Python fake writer and never starts descendants.

### 3. High — cancellation performs its only group sweep before all spawning threads have stopped

**Location:** `extensions/garmin/src/garmin_pipeline/report.py:549-573`, `report.py:1494-1506`.

**Failure scenario:** A worker passes the retry-loop cancellation check, then pauses during compact preparation, Claude preflight or immediately before `Popen`. Another future raises a fatal error or the host receives SIGTERM. The host sets cancellation and sweeps the group; it can observe no children and return. The delayed worker then starts a process because `_run` checks cancellation only after `Popen`. Its local finally reaps only the direct child, leaving any descendant it spawned outside the already completed host sweep. `pool.shutdown(wait=True)` is followed by no second cleanup, so report shutdown can leave a live descendant or hand cleanup responsibility to an outer cancellation mechanism after local cleanup was already claimed complete.

**Minimal fix:** Share a spawn gate with cancellation: under the same lock, reject new spawns once cancelled; close the gate before the host sweep. Always sweep/verify the supervisor group again after joining all worker threads, including when the initial sweep raises, while preserving the primary fatal exception. Keep both sweeps outside individual parallel workers.

**Coverage:** Add a deterministic barrier immediately before actual spawn, cancel while the worker is parked, then release it and assert no late spawn/live group member remains. Existing tests do not cover the parallel shutdown path.

### 4. Medium — unfinished diagnostic rows hide the last actionable feedback after restart

**Location:** `extensions/garmin/src/garmin_pipeline/report.py:1332-1338`, `report.py:1357-1371`.

**Failure scenario:** Attempt 1 durably ends with a validation code. Attempt 2 inserts its default `IN_PROGRESS` row and the process is killed or loses its fence before the completion update commits. On restart `_scope_retry_state` takes the latest row regardless of `ended_at`, so attempt 3 receives `IN_PROGRESS` instead of the last validation code. The durable repair feedback is lost, and comparison with that unfinished marker cannot enforce the repeated-error policy. An interrupted row is never reconciled, so the diagnostic history also retains an apparently running attempt indefinitely.

**Minimal fix:** Distinguish attempt lifecycle from repair feedback. Under the report/account ownership boundary, reconcile unfinished rows to a fixed interrupted classification, and recover feedback from the latest completed actionable validation failure rather than blindly from the latest attempt. Define whether an interrupted attempt breaks the repeated-error streak, and encode that explicitly. Do not permit a revoked worker to bypass fencing to finalize its row; reconciliation belongs to the next valid owner or trusted supervisor.

### 5. Medium — reserving the durable budget and inserting its diagnostic are separate commits

**Location:** `extensions/garmin/src/garmin_pipeline/report.py:1320-1329`, `report.py:1365-1369`.

**Failure scenario:** The counter increment commits, then the process crashes or the diagnostic insertion fails before its own commit. The scope has consumed an attempt with no diagnostic row at all, even though no model ran. Repeated restarts in this interval can exhaust the three-attempt budget with missing diagnostics and no corresponding execution evidence. The recovery query cannot distinguish these lost reservations from a normal attempt history.

**Minimal fix:** Reserve the attempt number and insert its initial diagnostic in one fenced transaction using one write session. Keep the model call outside that transaction. Combine with explicit interrupted-attempt recovery for a committed reservation that never finishes.

## Verification and reviewed boundaries

No tests were executed, as instructed. `git diff --check` passed. A read-only byte comparison found no source/package mismatches among declared payload files, and the canonical package digest matches; manifest version is `1.2.10` and plugin/package plugin version is `0.1.17`. These checks do not validate migration numbering; finding 1 remains an installation blocker.

Context propagation copies the selected account and report-lock marker into a separate Context per task. Each task opens its own write connection; the outer report lock stays owned by the host, and evaluation/diagnostic writes still use the existing attempt fences and account write lock. No new unfenced evaluation-write path was found.

The compact builder deep-copies the original, preserves non-heart-rate session fields, strength summaries, both windows, recovery and coverage, and constructs canonical original C1 pointers rather than pointers into the compact wrapper. The scope-specific schema now constrains both output and limitation scopes, and the target regex mirrors the validator's accepted target forms; existing index bounds remain validated after generation. The critical compact-related concern is the process lifetime around generation and decoding, described above.

The acceptance test named `test_validation_code_feedback_repeated_error_stops_and_is_durable` (`extensions/garmin/tests/test_report_supervised.py:296`) preserves an in-memory dictionary between calls and patches away all diagnostics SQL. It verifies logical resume after a completed failure, but cannot establish migration installation, transaction atomicity, restart recovery, or fenced completion behavior. Add a dedicated synthetic PostgreSQL restart/crash-boundary test for findings 4–5 after implementation is finalized; the implementation owner should execute only the directly related files at that stage.
