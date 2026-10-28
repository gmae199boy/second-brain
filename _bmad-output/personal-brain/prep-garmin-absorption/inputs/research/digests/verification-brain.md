# Independent verification: second-brain

Commit `22390f5`; only git show/grep, no execution or writes by verifier.

| Ref | Verdict | Scope/correction |
|---|---|---|
| 1 | disputed → corrected | Serial drain and no handler timeout verified. Ten seconds is daemon default; CLI/opportunistic defaults differ. Deadline checked before due-read/claim, so claim itself can cross deadline. |
| 2 | verified | 600,000ms default, empty override map, expired claims eligible. Owner predicates in completeWork/retryWork/releaseWork; finish translates row count. No renewal found in queue/work sources. |
| 3 | verified | Actual-now interval recurrence; atomicity is in fireSchedule, not listDueSchedules. |
| 4 | verified | Active drain awaited without abort signal; independent heartbeat interval still cannot run through synchronous event-loop blocking. |
| 5 | verified | BEGIN IMMEDIATE held through awaited callback. DatabaseSync operations support blocking busy acquisition. |
| 6 | verified | Caller and per-drain overrides take precedence, contrary to comment. |
| 7 | verified | Public Brain/complete command registry absence; no assertion about absent low-level operations. |
| 8 | verified | Attachment ingestion, schema Drive allowance, only Claude Code/text extractor; no Drive client located in production packages/apps. |
| 9 | verified | FTS schema without recall API; no SESSION chunk writer found. DOCUMENT chunk writer exists and must not be conflated. ModelStudio empty; Postgres health/schema; no runtime replicator located. |
| 10 | verified | Version9, WAL, per-migration transaction/version recheck. |

Corrected anchors: `packages/core/src/queue/drain.ts:217-305 (drainQueue) @ 22390f5`; `packages/sqlite/src/work.ts:254-296 (completeWork) @ 22390f5`; `packages/sqlite/src/schedules.ts:44-69 (fireSchedule) @ 22390f5`; `apps/cli/src/daemon/run.ts:258-284 (drainOnce) @ 22390f5`; `packages/sqlite/src/write.ts:52-92 (withWrite) @ 22390f5`; `packages/sqlite/src/driver.ts:41-64 (adaptDatabase) @ 22390f5`; `packages/sqlite/src/extractions.ts:279-300 (appendExtractionChunks) @ 22390f5`.

Negative findings remain bounded to inspected pinned production sources. Ref1 wording corrected in synthesis rather than silently retaining original.
