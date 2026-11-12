# Garmin v2 report repair

Base: `a1c32a47`; branch: `fix/garmin-report-v2`. No production writes or delivery.

## Reproduction

A single actual Codex `gpt-6.1-sol/high` invocation used only the repository synthetic `c1-mixed-day` fixture in an isolated temporary workspace. It exited 0 in 137.088 seconds, with 27,746 event bytes and 16,011 output bytes. `_read_output` accepted JSON and the v2 JSON schema, then reference validation rejected it with `invalid limitation target`. The schema allows arbitrary limitation scope and target strings while the validator requires the report scope and a singular existing judgment or indexed row. The output contained nonmatching limitation scopes and unindexed `aerobic_findings` targets. This proves a reproducible contract gap, but cannot recover the reasons for the six deleted production attempts.

Automatic approval review rejected reproduction with operational health data because sending that snapshot to external Codex was not specifically authorized for that destination. The operational temporary copy was deleted immediately, and the coordinator was notified. No health values or report bodies are retained here.

## Operational confirmation (explicit approval)

After the coordinator supplied explicit user permission to send the operational isolated snapshot to the same OpenAI Codex destination as regular analysis, one day call exited 0 in 280.932 seconds (1,332,485 event bytes; 28,238 output bytes). Validation against the **base** schema passed schema checks and failed reference validation with `LIMITATION_SCOPE`: 13 limitation rows did not use the top-level scope. The updated schema rejects those rows during generation instead. The original measurement file was 2,003,887 bytes; the compact view was 305,610 bytes (84.7% smaller). The isolated operational input and output were deleted immediately after extracting these value-free counts. The six earlier production failures remain unrecoverable individually, but the operational isolated reproduction confirms the same contract defect as the synthetic call.

## Review round 1

Independent requested reviewer: Codex gpt-6.1-sol/medium, Dispatch `ctx_cd23f36e1b84`. All five findings accepted: duplicate 0021 renamed to 0022 plus native schema 22; parallel output validation/retry waits for verified batch quiescence; shared spawn/cancel gate plus cleanup before and after joining; abandoned diagnostics reconciled without erasing actionable feedback (interruptions consume budget but do not break the actionable error streak); reservation and diagnostic start made atomic. Acceptance coverage includes real synthetic descendant cleanup, delayed spawn cancellation, PostgreSQL reservation rollback/restart/fencing, compact references, error feedback and success.
