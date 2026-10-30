# bmad-build-auto의 Orca 워커 실행 규칙

bmad-loop가 띄운 현재 에이전트가 계속 지휘자다. 구현·리뷰·깊은 조사만 `$orchestration`으로 Orca에 배정한다. 직접 `codex exec`나 기존 별도 CLI 실행 스크립트로 워커를 띄우지 않는다. 아래 절차는 기본 스킬의 subagent 실행 방식을 대체하며, 계획·검증·리뷰·HALT와 엔진의 커밋·done 판정은 유지한다.

## 연결과 Run 소유권

1. `$orchestration`을 읽고 해당 스킬이 정한 실행 파일로 `skills get orchestration --json`을 실행한다. 아래 `orca`는 그때 고른 실행 파일로 치환한다. 참조가 필요한 상황에는 해당 버전의 참조를 읽는다.
2. **현재 task/generation의 체크포인트가 있으면 새 Run을 만들기 전에 그 안의 제어 셸에서 `restore`부터 실행한다.** 아래 생성 절차는 최초 실행에만 적용한다. `orca status --json`과 현재 호출자의 `orchestration run-current --json`으로 신원을 확인한다. 다른 에이전트의 세션 ID, tmux가 상속한 오래된 터미널 핸들, 다른 저장소의 핸들을 빌려 쓰지 않는다. 작업 배치는 항상 `--worktree path:<현재 checkout>`처럼 명시한다. 프롬프트에 넣는 파일 경로는 저장소 상대 경로 또는 `<repo>/…`로 쓴다.
3. 현재 지휘자가 살아 있는 Orca 호출자로 확인되면 그 신원에서 전용 Run을 만들거나 자신의 기존 Run을 재사용한다. bmad-loop Run ID와 Orca Run ID는 서로 다르다. 둘의 대응은 아래 도구로 현재 bmad-loop task 디렉터리의 `orca-coordination.json`에 기록한다. 파일을 손으로 덮어쓰지 않는다. bmad-loop 밖의 수동 실행이면 버전 관리하지 않는 임시 파일을 쓴다.
4. bmad-loop의 tmux 세션처럼 유효한 Orca 호출자가 없으면 **지휘자 전용 Orca 제어 터미널**을 `terminal create --worktree path:<현재 checkout> --title <현재 run/task의 제어 터미널> --command <Run 생성 명령> --json`으로 만든다. 시작 명령은 그 터미널 안에서 `orca orchestration run-create --objective <현재 티켓의 워커 조정> --json`을 실행하고 결과를 고유한 임시 JSON 파일에 저장한다. 생성 영수증의 실제 핸들과 결과의 coordinator_handle이 같아야 한다. 이 제어 터미널은 명령·inbox를 위한 셸이며 새 지휘자 에이전트를 실행하지 않는다.
5. 이후 coordinator 명령은 **그 제어 터미널 안에서** `terminal send`로 실행하고, 각 명령의 JSON 출력·종료 코드를 별도의 고유한 임시 파일로 받아 읽는다. `check --wait`도 그 터미널에서 실행한다. 명령을 보내기 전 이전 명령이 끝났는지 확인하고, 전송 영수증만으로 실행 완료라고 판단하지 않는다. 외부 tmux나 다른 채팅에서 `--from`을 바꿔 다른 호출자인 척하거나 `consumer_fenced`를 우회하지 않는다. 제어 터미널 연결을 잃으면 기존 Run과 워커를 먼저 조사하고 중복 Run·워커를 만들지 않는다.
6. 동일 티켓·generation을 재개하거나 컨텍스트가 압축되면 가장 먼저 아래 `restore`를 실행해 생존과 소유권을 확인하고 같은 Run에 연결한다. 엔진 재시작이나 제어 터미널 종료는 워커 종료의 증거가 아니다. 런타임 접근 거부는 지침대로 권한을 해결하며 Orca를 재시작하지 않는다. 연결 불가를 직접 CLI 실행으로 우회하지 않는다.

## 체크포인트와 명령 도구

Python 3.11+의 `_bmad/custom/bmad-orca-control.py`를 사용한다. 아래 `python3`는 먼저 버전을 확인한 실행 파일이며, `orca`, 상태 경로, Run·호출자 값은 실제 영수증으로 치환한다. **모든 명령은 위에서 확인한 실제 coordinator 안에서 실행한다.** tmux 지휘자는 자기 제어 셸에 명령을 보내고 파일에 저장한 결과·종료 코드를 읽는다.

```sh
# 최초 한 번: 현재 task/generation의 버전 관리 밖 경로를 사용한다.
python3 _bmad/custom/bmad-orca-control.py --state <task-dir>/orca-coordination.json --orca <선택한-Orca> init --plan <계획-상대경로> --baseline <계획의-baseline-SHA> --run <Orca-Run> --caller <실제-session-ID-또는-제어-shell-handle>
# 재개·컴팩션 뒤, 또는 결과가 모호할 때: 새 Run/워커보다 먼저 실행한다.
python3 _bmad/custom/bmad-orca-control.py --state <task-dir>/orca-coordination.json --orca <선택한-Orca> restore
```

- `start --role implementer --args '<JSON 배열>'`로 배정한다. 배열은 `worker-start`의 `--spec`, `--task-title`(선택), `--worktree path:<현재 checkout>`, `--agent codex`, `--model <역할 모델>`, `--effort medium`의 flag/value 쌍이다. 리뷰·조사는 `review-quick`, `review-edge-case`, `research-context`처럼 역할을 구분한다. 같은 역할의 재호출은 저장된 같은 요청의 영수증을 복원한다. 새로운 시도나 새 역할로 불명확한 요청을 우회하지 않는다.
- `check --timeout-ms 45000`을 같은 턴에서 반복한다. 이 명령이 inbox 대기와 **워커 capacity 1분 관측**을 함께 수행한다. native runtime 오류 mail을 받으면 즉시 추가 조사한다. 빈 결과·일반 heartbeat는 짧게 요약한다. 원본은 상태 파일 옆 `.events/`의 0600 파일에 남으므로 transcript·전체 CLI JSON을 컨텍스트에 반복해서 붙이지 않는다.
- `checkpoint --revision <직전 출력 revision> --data '<JSON 객체>'`로 `stage`, `next_action`, `reports`, `verification`, `decisions`를 저장한다. 구현 배정 전, implementation-ready 수락, Verify 완료, 리뷰 배정·triage, 수정 요청, 최종 검증·finalize, HALT·정리 직전에 반드시 저장한다. 검증은 명령·성공/실패·로그 경로, 판단은 미해결 이유·다음 행동을 작게 남긴다. 계획과 계약·필요한 diff는 원본에서 읽는다.
- `message --role implementer --key <수정묶음의-고유키> --subject <fixes|finalize> --body '<지시>'`로 같은 활성 Dispatch에 전달한다. 응답을 잃으면 **같은 key·payload**만 다시 쓴다. `ack --delivery <pending deliveryId>`는 질문에 답하고 전체 보고를 읽고 소유권·정리 결정을 한 뒤 실행한다. ack 응답에 다음 Delivery가 있으면 그것도 처리한다. 질문 reply와 정식 완료 후 release는 같은 제어 셸에서 스킬의 원래 명령을 사용하고 결과를 checkpoint한다.
- 상태에는 plan/baseline·단계/다음 행동·Run/caller/incarnation·역할별 Task/Dispatch/handle·보고·검증·판단·미처리 Delivery·요청 ID/영수증·오류별 복구 상태를 보존한다. 원자 기록·파일 잠금·revision 검사가 갱신 충돌을 막는다. 손상·stale·소유권 불명은 파일을 초기화하거나 새 구현자를 띄울 근거가 아니다.
- `restore` 요약으로 현재 단계와 pending Delivery를 복원하고 실제 워커를 대조한다. 불명확한 start/send는 저장된 request ID를 request-show로 확인하고 같은 payload/ID만 재사용한다. receipt absent는 미실행 증거가 아니므로 새 UUID를 만들지 않는다. 활성 또는 불명 워커가 있으면 두 번째 구현자 시작을 거부한다.
- 이 도구는 지휘자의 rolling check 안에서 동작한다. 지휘자 자체가 멈춘 동안 별도 daemon처럼 돌지는 않는다. 기존 감독자의 1분 지휘자 capacity 감시가 지휘자를 재개하면 같은 checkpoint에서 워커 관측도 이어진다. 현재 실행의 immutable 프롬프트 스냅샷을 바꾸지 않으며 새 workflow invocation부터 이 지침을 적용한다.

## 과업 배정과 결과 수집

- 구현은 Codex `gpt-6.1-terra / medium`, 리뷰·읽기 전용 조사는 Codex `gpt-6.1-sol / medium`이다. 위 도구의 `start`에 `--spec <자기 완결적인 과업> --worktree path:<현재 checkout> --agent codex --model <역할 모델> --effort medium` 배열을 전달한다. 모델은 이 프로젝트가 지정한 값이며 capacity 때문에 바꾸지 않는다. 영수증의 requested/effective를 확인한다.
- 구현 spec의 기능 범위와 수락 조건은 계획 파일이 유일한 출처다. 편집 가능 범위, 커밋·티켓 완료 금지, 한국어 전체 보고 파일, 검증 근거, 미완료 시 실패 보고를 명시한다. 리뷰는 **검사만 하는 과업**으로 지시하고 소스 수정·빌드·시험·별도 하위 워커 실행을 금지한다. CLI의 sandbox 보장이 확인되지 않았는데 리뷰가 OS 수준에서 읽기 전용이라고 주장하지 않는다.
- 모든 워커에게 live injected preamble을 따르게 한다. 정확한 Task/Dispatch/handle과 heartbeat·ask·inbox 확인·ack·worker_done 의무를 보존한다. 업무상 build/review 스킬 호출 금지는 Orca 생명주기 보고를 금지한다는 뜻이 아니다. 최종 worker_done은 정확히 한 번 보내고 outcome succeeded/failed와 실제 report-path를 사용한다. 구현자는 최초 구현 뒤 type status / subject implementation-ready로 중간 보고하고 최종 검증까지 Dispatch를 유지한다. 리뷰·조사처럼 후속 편집이 없는 과업은 완료 즉시 worker_done을 보낸다. 전체 결과는 파일에서 읽는다.
- 독립적인 리뷰 렌즈는 전부 시작한 뒤 수집한다. 같은 checkout의 소스 편집 워커는 하나만 활성 편집자로 둔다. 결과 대기는 지휘자의 같은 턴에서 위 도구의 `check --timeout-ms 45000`을 반복한다. 빈 결과·시간 초과·heartbeat·TUI idle은 완료나 실패가 아니다. 턴을 끝내서 결과를 기다리지 않는다.
- 각 Delivery의 질문에 reply하고, 예상한 활성 Dispatch의 결과인지 검증하며, 보고 파일과 근거를 읽고, 워커의 다음 소유권을 결정한 뒤 deliveryId를 ack한다. 세 번 연속 빈 대기면 해당 Run의 worker-list와 worker-show/read로 조사하고 nextAction을 따른다. unverifiable은 종료 증거가 아니므로 중복 편집자 실행·stop·abandon·release의 근거로 삼지 않는다.

## 큰 작업과 실패 후 자동 재계획

- 전체 계획의 요구는 유지하고 실행만 작은 검증 단위로 나눈다. 첫 배정은 첫 단계의 파일·변경·관찰만 구체적으로 지시한다. 구현자는 각 단계 구현·시험 뒤 `phase-ready` status와 보고 경로를 보내고 같은 활성 Dispatch에서 기다린다. 지휘자는 diff·근거를 확인·checkpoint하고 `message --subject next-phase`로 다음 단계를 보낸다. 전체 항목이 충족돼야 `implementation-ready`로 Verify·리뷰를 진행한다.
- 부분 구현이나 큰 계획 자체는 수행 불가 증거가 아니다. 실제 계속할 수 없는 사유가 있을 때만 failed를 보고한다. 정식 실패를 수락한 Dispatch는 다시 깨우지 않는다. 두 번의 실제 실패로 해당 지휘자가 HALT해도 감독자는 사람 판단으로 넘기지 않고 실패 근거·부분 작업·검증 기록을 보존하고 실행 분할·계획 보완 후 새 generation에서 자동 재추진한다. 동일 미변경 명령만 반복하거나 활성/불명 워커를 중복 실행하지 않는다.

## 같은 구현자에게 후속 수정

현재 Orca의 structured chat 워커는 완료 후 `worker-start --terminal <structured handle>`로 다시 배정하면 terminal_unsupported_for_agent_session으로 거부된다. 따라서 구현 Task의 범위를 최초 구현부터 검증·리뷰 반영까지로 정한다. 구현자는 첫 구현을 끝냈을 때 `type status / subject implementation-ready`와 Task/Dispatch·실제 report-path로 **중간 보고**만 하고, 자신의 Dispatch를 완료하지 않는다. 그 뒤 live preamble의 정확한 inbox를 check --wait하며 다음 지시를 받는다. Task가 아직 진행 중이므로 worker_done 이후 idle 의무와 충돌하지 않는다.

지휘자는 해당 중간 보고를 받아 전체 파일·diff·Verify를 직접 확인한 뒤 리뷰 워커를 띄운다. 수정 요청은 기존 **활성 Dispatch**에 위 도구의 `message`로 전달한다. 같은 구현자가 코드를 수정하고 수정 보고도 status로 보낸다. 리뷰와 최종 검증이 끝나면 명시적으로 finalize를 보내고 정식 worker_done·최종 보고를 받은 뒤 release한다. 구현자가 실제로 수행 불가하면 finalize를 기다리지 말고 outcome failed로 정식 보고하게 한다.

이미 정식 완료된 Dispatch에 메시지를 보내 다시 깨어날 것으로 기대하거나, structured handle을 terminal로 바꿔 끼우지 않는다. 지휘자가 직접 소스·시험을 수정하지 않는다. 이 절차가 기본 스킬의 '같은 구현 subagent 재호출'을 대체한다.

## 실패·capacity·정리

- 지휘자·감독자·워커의 capacity/server_overloaded는 모델을 바꾸지 않고 같은 모델·세션에서 계속 재개한다. 도구는 최신 활성 Dispatch의 실제 error 블록/구조화된 server_overloaded 또는 정확히 귀속된 native 오류 escalation을 최신 transcript와 대조한다. 일반 본문·사용자·도구 출력의 인용, 과거 오류, 완료·소유권/호스트 불명은 입력 대상이 아니다. 오류별 durable request ID로 같은 Dispatch에 한 번 enqueue하고 새 provider 진행으로만 recovered를 확인한다. enqueued/unconfirmed/unknown은 성공과 구분한다. 지원하지 않는 오류 형식은 unknown으로 보존하고 실제 원본을 조사한다. capacity 횟수만으로 포기하거나 새 Run/Task를 만들어 회로 차단을 우회하지 않는다.
- 실제 사용량 한도는 capacity와 구분해 resets와 증거를 보고한다. 지휘자의 HALT는 기존 `usage limit:` 사유 형식을 유지한다. 두 번의 실제 구현 실패도 기존 blocked 형식으로 기록한다. 결과가 모호하거나 워커가 사라졌다면 recovery-and-cleanup 참조에 따라 먼저 조사한다. Orca의 circuit breaker는 우회하지 않는다.
- 리뷰 결과를 받으면 release한다. 구현자는 같은 활성 Dispatch에서 최종 확인 지시를 기다리며, 정식 완료 결과까지 받은 후 release한다. 사용자 요청 없이 무기한 retain하지 않는다. worker-list의 해당 Run에서 reclaimable이 남지 않았는지 확인한다. terminal close나 PID kill로 워커를 대신 정리하지 않는다.
- HALT 또는 새 bmad-loop run 이전에는 자기 Run의 워커 상태를 기록하고 정리한다. 명시적인 과업 취소가 필요하면 recovery 절차로 해당 Dispatch만 취소한다. 단순 무응답을 취소 근거로 삼지 않는다. 모든 워커가 정리되고 미처리 mail이 없는 전용 제어 셸만 마지막에 닫는다.
- 지휘자는 기존 plan/result의 blocked·escalation·awaiting-operator 형식과 엔진의 최종 완료 판정을 유지한다. 워커의 worker_done으로 티켓 done을 대신하지 않는다. bmad-loop TUI·감독자의 기존 지휘자 감시 대상은 바뀌지 않는다.
