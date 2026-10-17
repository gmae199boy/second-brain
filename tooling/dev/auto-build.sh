#!/bin/sh
# Build the ticket tree unattended: one fresh `claude -p` session per ticket,
# each running `/bmad-build-auto`, until nothing is ready or a run does not end
# at `built`.
#
# A fresh session per ticket is the point. One long session would compact in
# the middle of a ticket and lose what it was doing; here every ticket starts
# from an empty context and everything it needs is on disk -- the ticket tree,
# the plan and its status, and git.
#
# The person is not there, so the invocation hands the agent the choices a
# person would make: it picks the most conservative option, records it in the
# plan as a decision it made on the user's behalf, and lists it under
# `## Auto Run Result` for the morning. Nothing is pushed.
#
# Run it inside tmux so closing the terminal does not stop it:
#   tmux new -s brain-auto 'caffeinate -i sh tooling/dev/auto-build.sh'
#
# Environment:
#   MAX_TICKETS   how many tickets at most (default 20)
#   LOG_DIR       where logs and the morning report go
#                 (default ~/Library/Logs/brain-auto-build)

set -u

repo_root=$(cd "$(dirname "$0")/../.." && pwd)
cd "$repo_root" || exit 1

max_tickets=${MAX_TICKETS:-20}
log_dir=${LOG_DIR:-"$HOME/Library/Logs/brain-auto-build"}
mkdir -p "$log_dir"
report="$log_dir/report.md"

# The Postgres integration tests run when this is set; the container is the
# one `compose.test.yaml` starts (README, 테스트 데이터베이스).
if docker ps --format '{{.Names}}' 2>/dev/null | grep -q '^brain-postgres-1$'; then
  export BRAIN_TEST_DATABASE_URL=postgres://postgres:postgres@localhost:54329/postgres
fi

say() {
  line="$(date '+%Y-%m-%d %H:%M:%S') $*"
  echo "$line"
  echo "- $line" >> "$report"
}

notify() {
  osascript -e "display notification \"$1\" with title \"brain auto-build\"" >/dev/null 2>&1 || true
}

stop() {
  say "멈춤: $1"
  notify "$1"
  exit "${2:-1}"
}

# The next ticket: one a run already started and did not finish comes first,
# so a run cut short is picked up again, then the first one ready to start.
next_ticket() {
  uv run --quiet _bmad/method/scripts/tickets.py --project-root . next | python3 -c '
import json, sys
d = json.load(sys.stdin)
started = [r for r in d.get("in_progress", [])
           if r.get("status") in ("draft", "ready-for-dev", "in-progress", "in-review")]
rows = started or d.get("ready_to_start", [])
print(rows[0]["ref"] if rows else "")
'
}

plan_status() {
  plan=$(uv run --quiet _bmad/method/scripts/tickets.py --project-root . find "$1" \
    | python3 -c 'import json,sys; print(json.load(sys.stdin).get("plan") or "")')
  if [ -z "$plan" ] || [ ! -f "$plan" ]; then
    echo "missing"
    return
  fi
  sed -n "s/^status: '\{0,1\}\([a-z-]*\)'\{0,1\}$/\1/p" "$plan" | head -n 1
}

delegation='사용자 위임(2026-10-17): 사용자는 자리에 없고 아침에 결과를 검토한다.
- 사람이 정해야 할 선택(Open Questions, intent gap)을 만나도 멈추지 마라. 가장 보수적이고 되돌리기 쉬운 안을 골라 plan의 frozen 블록에 "Decision(날짜, 사용자 위임으로 에이전트가 고름): 고른 것 — 이유. 다른 안: …"으로 기록하고 진행하라. 그렇게 고른 결정은 모두 `## Auto Run Result`의 "에이전트가 대신 내린 결정" 목록에도 적어라.
- 사람이 직접 해야 하는 확인(hitl, 실제 Claude Code 플러그인 설치나 실제 hook 동작 등)은 자동으로 할 수 있는 검증까지만 하고, 남은 것을 `## Auto Run Result`의 "사람 확인 필요" 목록에 적어라.
- 사용자의 실제 `~/.claude` 설정·플러그인과 실제 `~/.second_brain`은 바꾸지 마라. 시험은 임시 home에서 한다.
- push하지 마라. 원격은 공개 저장소이므로 회사 이름·내용·계정을 넣지 마라.'

say "시작: 최대 ${max_tickets}개, 저장소 $repo_root"

previous=""
count=0
while [ "$count" -lt "$max_tickets" ]; do
  if [ -n "$(git status --porcelain)" ]; then
    stop "작업 트리가 깨끗하지 않습니다. git status를 보세요"
  fi

  ref=$(next_ticket)
  if [ -z "$ref" ]; then
    say "끝: 시작할 수 있는 티켓이 더 없습니다"
    notify "시작할 수 있는 티켓이 더 없습니다"
    exit 0
  fi
  if [ "$ref" = "$previous" ]; then
    stop "티켓 $ref 가 두 번 연속 골라졌습니다. 진행이 없습니다"
  fi

  count=$((count + 1))
  log="$log_dir/ticket-$ref-$(date '+%Y%m%d-%H%M%S').log"
  say "티켓 $ref 시작 (로그 $log)"

  claude -p --permission-mode auto "/bmad-build-auto ticket $ref

$delegation" < /dev/null > "$log" 2>&1
  code=$?

  status=$(plan_status "$ref")
  head_commit=$(git rev-parse --short HEAD)
  say "티켓 $ref 끝: claude exit $code, plan status $status, HEAD $head_commit"

  if [ "$status" != "built" ] && [ "$status" != "done" ]; then
    stop "티켓 $ref 가 built로 끝나지 않았습니다(status $status). 로그: $log"
  fi
  previous=$ref
done

say "끝: 최대 개수 ${max_tickets}개에 닿았습니다"
notify "최대 개수에 닿아 멈췄습니다"
