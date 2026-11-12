# Cleanup follow-up disposition

**Cleared: the daemon-crash fixture cleanup finding is addressed; no remaining actionable findings in this patch.** Reviewed only the newly added cleanup and ownership tracking, without tests, helpers or runbook access.

Each original scope call is captured in its own promise callback before the combined wait or following assertions can fail. Both original model identities are retained, their shared process group is asserted, and recovery now explicitly verifies both models and the known tool exited. The resumed model group is captured too.

Nested finally blocks preserve cleanup execution after recovery shutdown or database-read rejection: stop and await the external daemon, collect calls and owned work-attempt groups while available, terminate owned groups using group-specific model guards, check every retained group/model/tool is gone, and then tear down the fixture. Captured ownership remains available even if later discovery fails. This removes reliance on a successful recovery or on fixture directory removal to stop the newly held sibling.

`pnpm typecheck` and `git diff --check` passed. No tests were run or repeated by this reviewer; the coordinator owns the exact-case recheck and remaining related-file checks. Production files remain outside this patch and review.

---

# Initial integration review history

# Garmin v2 integration test repair review

Reviewed the six current unstaged test files against `7d2fdf56`. Production source/package bytes are unchanged. No tests, model invocations, operational data reads, helper agents or automation runbook access occurred; only this review report was written.

## Finding

### Medium — newly held `all` model is not covered by exceptional-path cleanup

**Location:** `apps/cli/python-test/garmin-report.test.ts:324`, `garmin-report.test.ts:343-348`.

**Scenario:** The daemon-crash test now guarantees that both 30d and all are live and held, but destructures only the 30d call and discards the all process/group identity. If the pre-crash revision assertion fails, or recovery cannot start/complete, the finally kills the daemon and at most the recorded 30d model and its tool; it does not explicitly stop the held all child or its report supervisor group. Before line 327 even the 30d identity has not yet been assigned. This can leave test-owned report processes alive during database/home teardown, precisely on the failure paths where the production cleanup being tested cannot be trusted. `setup(false)` has no in-process daemon to abort in `t.close`, and `extHome.cleanup` only removes roles/database/home.

**Concrete fix:** Capture the original report process-group identity immediately when observing its calls, retain both model identities, and guarantee guarded termination/verification of that owned group from a nested finally even if recovery shutdown rejects. Await the external daemon exit on the exceptional cleanup path as well. Assert both original model PIDs are gone after recovery, rather than checking only 30d and its tool; this adds a direct check for the newly held parallel sibling.

## Cleared semantic changes

- Current-package install/upgrade expectations correctly advance to Garmin migration 22 and version `1.2.10`; the historical test that explicitly applies only `0021_fetch_error_message.sql` still expects 21. Existing preservation, ledger-prefix, privilege, registry/digest and quiesce assertions remain.
- Sorting the core lifecycle call list compares the exact four-scope multiset, retaining duplicate/missing-scope detection while removing an invalid concurrent start-order requirement. Revision and event-count assertions remain intact.
- Holding both 30d and all prevents either result from committing before the intentional crash. Waiting for both calls before daemon SIGKILL makes the subsequent exact original-attempt call vector deterministic; the recovery still must resume exactly those two scopes and preserve prior revisions.
- Message retry tests isolate the new persistence collaborators rather than reaching a real database with a null config. Integer reservations match the production interface. The repeated-code test still asserts two evaluations, two diagnostic writes, repair feedback and a terminal final record; the success test asserts immediate stop, same snapshot inputs and a success diagnostic. The old six-attempt assertion is intentionally obsolete under the new three-attempt/repeated-error policy.

## Validation

`pnpm typecheck` and `git diff --check` passed. No regression suite or file-level tests were run by this reviewer; the coordinator owns the already running related-file rechecks. The unrelated PostgreSQL lock-wait failure was not expanded into this task. Address the exceptional cleanup finding, then use only the directly related recheck as needed; do not repeat the whole regression.
