# Independent verification: Garmin

Pinned `7fb33dd`; no execution. Verifier read sources independently.

- Ref11 verified: normalization follows ordinary blocked/skipped returns, not write-lock timeout/unexpected exceptions. sync report follows collection return.
- Ref12 verified: store/WAL/migration version discipline; intended report→write→session ordering, not universal central enforcement. Migration tree ends0016.
- Ref13 disputed then corrected: rate block recording is best effort because _record_block swallows OSError. In-memory block and malformed-file refusal verified.
- Ref14 verified: raw preservation, derived rebuild preserves evaluations, scope-by-scope persistence. Normal skip checks successful day evaluation even when Markdown absent.
- Ref15 verified: new process session/per-invocation timeout/TERM/up-to5s/KILL/reap. SIGTERM registration conditional on signal.signal success; no strict total report bound.
- Ref16 verified: at-most-one logical alert attempt gate, retained on failures; report bundle no such gate and regenerate can resend.
- Ref17 verified: package Python>=3.12, deployed interpreter3.14.8, config preserved, runtime skills, normalize before two LaunchAgents.

New exact anchors for duration: `src/garmin_pipeline/config.py:43-44 (_DEFAULTS) @ 7fb33dd`; `src/garmin_pipeline/report.py:317-321 (_execute) @ 7fb33dd`. Default collection wait30min/Codex per invocation20min; hence report may exceed600s, an inference from allowed code duration, not measured runtime. Additional work prevents treating 4×1200s as a whole-report strict bound.
