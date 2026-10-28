#!/usr/bin/env bash
# Runs one codex CLI session in place of a bmad-build-auto subagent.
# Reads the prompt from stdin and starts codex detached under nohup, so a run
# longer than the host's per-call Bash limit survives. The call then waits up
# to BMAD_CODEX_WAIT_S (480) seconds and prints either `codex-thread: <id>` and
# codex's last message, or `codex-pending: <job>` — then call `wait <job>`.
#
#   impl                 new implementation session (no sandbox, may edit files)
#   review               new reviewer session (read-only sandbox)
#   resume <thread-id>   send the prompt to an earlier implementation session
#   wait <job>           keep waiting on a job that printed `codex-pending:`
#
# When a turn stops because the model is at capacity or a usage limit hit, the
# job pauses and tells the same session to continue (a reviewer starts over),
# up to BMAD_CODEX_RETRIES (6) times; exit status 75 means it gave up. A job
# nobody has waited on for BMAD_CODEX_ORPHAN_S (900) seconds stops its codex.
# Model and effort default to gpt-6.1-sol / medium; BMAD_CODEX_MODEL and
# BMAD_CODEX_EFFORT override them.
set -euo pipefail

self="${BASH_SOURCE[0]}"
model="${BMAD_CODEX_MODEL:-gpt-6.1-sol}"
effort="${BMAD_CODEX_EFFORT:-medium}"
wait_s="${BMAD_CODEX_WAIT_S:-480}"
retries="${BMAD_CODEX_RETRIES:-6}"
pause_s="${BMAD_CODEX_PAUSE_S:-30}"
orphan_s="${BMAD_CODEX_ORPHAN_S:-900}"
transient='at capacity|usage limit|rate limit|too many requests|overloaded|temporarily unavailable|try again later'

mtime() { stat -c %Y "$1" 2>/dev/null || stat -f %m "$1"; }
orphaned() { [ $(($(date +%s) - $(mtime "$1/heartbeat"))) -gt "$orphan_s" ]; }
thread_of() { sed -n 's/.*"type": *"thread.started".*"thread_id": *"\([^"]*\)".*/\1/p' "$1" | tail -n 1; }

# Sleeps $2 seconds, failing early once nobody waits on job $1 any more.
nap() {
  local until=$(($(date +%s) + $2))
  while [ "$(date +%s)" -lt "$until" ]; do
    orphaned "$1" && return 1
    sleep 5
  done
}

# The detached half: runs codex for job $1, retrying transient model failures,
# and writes the final exit status to $1/exit.
run_job() {
  local job="$1" mode thread="" prompt="$1/prompt.md" attempt=0 pid status id
  mode="$(cat "$job/mode")"
  [ -f "$job/thread" ] && thread="$(cat "$job/thread")"
  while :; do
    local common=(-m "$model" -c "model_reasoning_effort=\"$effort\"" --json -o "$job/last.md")
    case "$mode" in
      impl) cmd=(codex exec "${common[@]}" --dangerously-bypass-approvals-and-sandbox -) ;;
      review) cmd=(codex exec "${common[@]}" -s read-only -) ;;
      resume) cmd=(codex exec resume "${common[@]}" --dangerously-bypass-approvals-and-sandbox "$thread" -) ;;
    esac
    "${cmd[@]}" <"$prompt" >"$job/events.$attempt.jsonl" 2>"$job/stderr.$attempt.log" &
    pid=$!
    while kill -0 "$pid" 2>/dev/null; do
      if orphaned "$job"; then
        kill "$pid" 2>/dev/null || true
        echo "nobody waited on this job for ${orphan_s}s; stopped codex" >>"$job/stderr.$attempt.log"
        echo 124 >"$job/exit"
        return
      fi
      if [ ! -s "$job/thread" ]; then
        id="$(thread_of "$job/events.$attempt.jsonl")"
        [ -z "$id" ] || echo "$id" >"$job/thread"
      fi
      sleep 5
    done
    status=0
    wait "$pid" || status=$?

    id="$(thread_of "$job/events.$attempt.jsonl")"
    if [ -n "$id" ]; then
      thread="$id"
      echo "$thread" >"$job/thread"
    fi
    if [ "$status" -eq 0 ]; then
      echo 0 >"$job/exit"
      return
    fi
    if ! tail -n 5 "$job/events.$attempt.jsonl" "$job/stderr.$attempt.log" | grep -iE "$transient" >/dev/null; then
      echo "$status" >"$job/exit"
      return
    fi
    if [ "$attempt" -ge "$retries" ]; then
      echo "model still unavailable after $retries retries" >>"$job/stderr.$attempt.log"
      echo 75 >"$job/exit"
      return
    fi
    attempt=$((attempt + 1))
    if ! nap "$job" $((pause_s * attempt)); then
      echo 124 >"$job/exit"
      return
    fi
    if [ "$mode" != review ] && [ -n "$thread" ]; then
      mode=resume
      prompt="$job/continue.md"
      cat >"$prompt" <<'EOF'
Your previous turn stopped because the model was temporarily unavailable (capacity or usage limit), not because of anything you did. The working tree still holds everything you changed so far. Continue the same task from where you stopped, then give the final report the original request asked for.
EOF
    fi
  done
}

wait_job() {
  local job="$1" deadline status
  [ -f "$job/mode" ] || { echo "no codex job at $job" >&2; exit 2; }
  deadline=$(($(date +%s) + wait_s))
  until [ -f "$job/exit" ]; do
    touch "$job/heartbeat"
    if [ "$(date +%s)" -ge "$deadline" ]; then
      echo "codex-thread: $(cat "$job/thread" 2>/dev/null || echo pending)"
      echo "codex-pending: $job"
      echo "codex is still working; run \`bash $self wait $job\` again to keep waiting."
      exit 0
    fi
    sleep 5
  done
  status="$(cat "$job/exit")"
  echo "codex-thread: $(cat "$job/thread" 2>/dev/null || echo unknown)"
  echo "codex-log: $job"
  if [ "$status" -ne 0 ]; then
    echo "codex exited with status $status; error events and stderr tail:" >&2
    grep -hE '"type": *"(error|turn.failed)"' "$(ls -t "$job"/events.*.jsonl | head -n 1)" | tail -n 3 >&2 || true
    tail -n 20 "$(ls -t "$job"/stderr.*.log | head -n 1)" >&2
    exit "$status"
  fi
  cat "$job/last.md"
}

# Braced so bash parses all of it before running: a job may outlive edits to
# this file.
{
mode="${1:-}"
case "$mode" in
  impl | review | resume)
    [ "$mode" = resume ] && : "${2:?resume needs a thread id}"
    job="$(mktemp -d "${TMPDIR:-/tmp}/bmad-codex.XXXXXX")"
    cat >"$job/prompt.md"
    echo "$mode" >"$job/mode"
    [ "$mode" = resume ] && echo "$2" >"$job/thread"
    touch "$job/heartbeat"
    # A bmad-loop session exports its run and task ids; the nested codex would
    # otherwise relay its own hook events into that session's event stream.
    env -u BMAD_LOOP_RUN_DIR -u BMAD_LOOP_TASK_ID -u BMAD_LOOP_EVENTS_DIR \
      nohup bash "$self" __run "$job" </dev/null >"$job/supervisor.log" 2>&1 &
    wait_job "$job"
    ;;
  wait) wait_job "${2:?wait needs a job directory}" ;;
  __run) run_job "$2" ;;
  *) echo "usage: $0 impl|review|resume <thread-id>|wait <job>  (prompt on stdin)" >&2; exit 2 ;;
esac
exit
}
