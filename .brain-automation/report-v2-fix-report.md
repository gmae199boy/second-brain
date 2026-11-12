# Garmin v2 report repair

Base: `a1c32a47`; branch: `fix/garmin-report-v2`. No production writes or delivery.

## Reproduction

A single actual Codex `gpt-6.1-sol/high` invocation used only the repository synthetic `c1-mixed-day` fixture in an isolated temporary workspace. It exited 0 in 137.088 seconds, with 27,746 event bytes and 16,011 output bytes. `_read_output` accepted JSON and the v2 JSON schema, then reference validation rejected it with `invalid limitation target`. The schema allows arbitrary limitation scope and target strings while the validator requires the report scope and a singular existing judgment or indexed row. The output contained nonmatching limitation scopes and unindexed `aerobic_findings` targets. This proves a reproducible contract gap, but cannot recover the reasons for the six deleted production attempts.

Automatic approval review rejected reproduction with operational health data because sending that snapshot to external Codex was not specifically authorized for that destination. The operational temporary copy was deleted immediately, and the coordinator was notified. No health values or report bodies are retained here.
