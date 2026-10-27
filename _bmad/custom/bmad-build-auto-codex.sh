#!/usr/bin/env bash
# Runs one codex CLI session in place of a bmad-build-auto subagent.
# Reads the prompt from stdin, blocks until codex finishes, then prints
# `codex-thread: <id>` and codex's last message.
#
#   impl                 new implementation session (no sandbox, may edit files)
#   review               new reviewer session (read-only sandbox)
#   resume <thread-id>   send the prompt to an earlier implementation session
#
# Model and effort default to gpt-6.1-sol / medium; BMAD_CODEX_MODEL and
# BMAD_CODEX_EFFORT override them.
set -euo pipefail

mode="${1:-}"
model="${BMAD_CODEX_MODEL:-gpt-6.1-sol}"
effort="${BMAD_CODEX_EFFORT:-medium}"
work="$(mktemp -d "${TMPDIR:-/tmp}/bmad-codex.XXXXXX")"
prompt_file="$work/prompt.md"
cat >"$prompt_file"

common=(-m "$model" -c "model_reasoning_effort=\"$effort\"" --json -o "$work/last.md")
case "$mode" in
  impl) cmd=(codex exec "${common[@]}" --dangerously-bypass-approvals-and-sandbox -) ;;
  review) cmd=(codex exec "${common[@]}" -s read-only -) ;;
  resume)
    thread="${2:?resume needs a thread id}"
    cmd=(codex exec resume "${common[@]}" --dangerously-bypass-approvals-and-sandbox "$thread" -)
    ;;
  *) echo "usage: $0 impl|review|resume <thread-id>  (prompt on stdin)" >&2; exit 2 ;;
esac

# A bmad-loop session exports its run and task ids; the nested codex would
# otherwise relay its own hook events into that session's event stream.
status=0
env -u BMAD_LOOP_RUN_DIR -u BMAD_LOOP_TASK_ID -u BMAD_LOOP_EVENTS_DIR \
  "${cmd[@]}" <"$prompt_file" >"$work/events.jsonl" 2>"$work/stderr.log" || status=$?

thread="$(sed -n 's/.*"type": *"thread.started".*"thread_id": *"\([^"]*\)".*/\1/p' "$work/events.jsonl" | head -n 1)"
echo "codex-thread: ${thread:-${2:-unknown}}"
echo "codex-log: $work"
if [ "$status" -ne 0 ]; then
  echo "codex exited with status $status; stderr tail:" >&2
  tail -n 20 "$work/stderr.log" >&2
  exit "$status"
fi
cat "$work/last.md"
