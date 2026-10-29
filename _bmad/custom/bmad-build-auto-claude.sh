#!/usr/bin/env bash
# Runs one claude CLI session in place of the bmad-build-auto implementation
# subagent (claude sonnet 5.5, medium effort by default).
# The session starts detached (nohup + its own session), so it survives the
# caller's per-call Bash limit. The call then waits up to BMAD_CLAUDE_WAIT_S
# (480) seconds and prints either `claude-session: <id>` and the session's last
# message, or `claude-pending: <log folder>` — then call `wait <log folder>`.
#
#   impl                 new implementation session (may edit files) — prompt on stdin
#   resume <session-id>  send the prompt to an earlier implementation session — prompt on stdin
#   wait <log folder>    keep waiting on a session that printed `claude-pending:`
#
# Usage limit: when the session fails on a usage limit the script prints
# `usage-limit: claude: <line>` and exits 75 (told apart from an ordinary
# failure: the orchestrator HALTs without retrying, and the coordinator resumes
# the run after the reset).
# BMAD_CLAUDE_MODEL and BMAD_CLAUDE_EFFORT override the model and effort.
set -euo pipefail

mode="${1:-}"
model="${BMAD_CLAUDE_MODEL:-claude-sonnet-5-5}"
effort="${BMAD_CLAUDE_EFFORT:-medium}"
wait_s="${BMAD_CLAUDE_WAIT_S:-480}"
LIMIT_RE='usage limit|hit your [a-z ]*limit|out of (usage )?credits|usage_limit|insufficient_quota|quota exceeded'

field() {
  python3 -c 'import json,sys
try:
    d = json.load(open(sys.argv[1]))
except Exception:
    d = {}
v = d.get(sys.argv[2], "")
print(v if isinstance(v, str) else json.dumps(v))' "$work/result.json" "$1"
}

start() {
  work="$(mktemp -d "${TMPDIR:-/tmp}/bmad-claude.XXXXXX")"
  cat >"$work/prompt.md"
  pwd >"$work/cwd"
  echo "claude-log: $work"
  # No Agent tool: the implementer works inside this session itself.
  local cmd=(claude -p --model "$model" --effort "$effort" --permission-mode bypassPermissions
    --output-format json --disallowedTools Agent "$@")
  # Drop the run and task ids the bmad-loop session exported, or this nested
  # session's hooks would write into the outer session's event stream.
  # CLAUDECODE marks a nested run. nohup + setsid keep the session alive when
  # the caller is cut off by HUP or a process-group signal.
  nohup python3 -c 'import os,sys; os.setsid(); os.execvp(sys.argv[1], sys.argv[1:])' \
    bash -c 'w="$1"; shift; "$@" <"$w/prompt.md" >"$w/result.json" 2>"$w/stderr.log"; echo $? >"$w/exit"' \
    _ "$work" env -u BMAD_LOOP_RUN_DIR -u BMAD_LOOP_TASK_ID -u BMAD_LOOP_EVENTS_DIR -u CLAUDECODE "${cmd[@]}" \
    >/dev/null 2>&1 &
  echo $! >"$work/pid"
}

finish() {
  local deadline=$((SECONDS + wait_s))
  while [ ! -f "$work/exit" ]; do
    if ! kill -0 "$(cat "$work/pid" 2>/dev/null || echo 0)" 2>/dev/null && [ ! -f "$work/exit" ]; then
      echo "1" >"$work/exit"
      echo "the session ended without a result" >>"$work/stderr.log"
      break
    fi
    if [ "$SECONDS" -ge "$deadline" ]; then
      echo "claude-pending: $work"
      exit 0
    fi
    sleep 5
  done
  local status session_id
  status="$(cat "$work/exit")"
  session_id="$(field session_id)"
  echo "claude-session: ${session_id:-unknown}"
  if [ "$status" -ne 0 ] || [ "$(field is_error)" = "true" ]; then
    local limit_line
    limit_line="$( { field result; cat "$work/stderr.log" 2>/dev/null; } | grep -i -m1 -E "$LIMIT_RE" || true)"
    if [ -n "$limit_line" ]; then
      echo "usage-limit: claude: ${limit_line:0:300}"
      exit 75
    fi
    echo "claude exited with status $status; stderr tail:" >&2
    tail -n 20 "$work/stderr.log" >&2 || true
    field result >&2
    exit $((status == 0 ? 1 : status))
  fi
  field result
}

case "$mode" in
  impl) start; finish ;;
  resume) start --resume "${2:?resume needs a session id}"; finish ;;
  wait)
    work="${2:?wait needs a log folder}"
    [ -f "$work/pid" ] || { echo "not a log folder: $work" >&2; exit 2; }
    echo "claude-log: $work"
    finish
    ;;
  *) echo "usage: $0 impl | resume <session-id>  (prompt on stdin) | wait <log folder>" >&2; exit 2 ;;
esac
