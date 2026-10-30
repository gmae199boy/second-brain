# bmad-build-auto의 Orca 워커 실행 규칙

bmad-loop가 띄운 현재 에이전트가 계속 지휘자다. 구현·리뷰·깊은 조사만 `$orchestration`으로 Orca에 배정한다. 직접 `codex exec`나 기존 별도 CLI 실행 스크립트로 워커를 띄우지 않는다. 아래 절차는 기본 스킬의 subagent 실행 방식을 대체하며, 계획·검증·리뷰·HALT와 엔진의 커밋·done 판정은 유지한다.

## 연결과 Run 소유권

1. `$orchestration`을 읽고 해당 스킬이 정한 실행 파일로 `skills get orchestration --json`을 실행한다. 아래 `orca`는 그때 고른 실행 파일로 치환한다. 참조가 필요한 상황에는 해당 버전의 참조를 읽는다.
2. `orca status --json`과 현재 호출자의 `orchestration run-current --json`으로 신원을 확인한다. 다른 에이전트의 세션 ID, tmux가 상속한 오래된 터미널 핸들, 다른 저장소의 핸들을 빌려 쓰지 않는다. 작업 배치는 항상 `--worktree path:<현재 checkout>`처럼 명시한다. 프롬프트에 넣는 파일 경로는 저장소 상대 경로 또는 `<repo>/…`로 쓴다.
3. 현재 지휘자가 살아 있는 Orca 호출자로 확인되면 그 신원에서 전용 Run을 만들거나 자신의 기존 Run을 재사용한다. bmad-loop Run ID와 Orca Run ID는 서로 다르다. 둘의 대응과 선택한 실행 파일·제어 핸들·Task·Dispatch·워커 핸들을 현재 bmad-loop task 디렉터리의 `orca-coordination.json`에 기록한다. bmad-loop 밖의 수동 실행이면 버전 관리하지 않는 임시 파일을 쓴다.
4. bmad-loop의 tmux 세션처럼 유효한 Orca 호출자가 없으면 **지휘자 전용 Orca 제어 터미널**을 `terminal create --worktree path:<현재 checkout> --title <현재 run/task의 제어 터미널> --command <Run 생성 명령> --json`으로 만든다. 시작 명령은 그 터미널 안에서 `orca orchestration run-create --objective <현재 티켓의 워커 조정> --json`을 실행하고 결과를 고유한 임시 JSON 파일에 저장한다. 생성 영수증의 실제 핸들과 결과의 coordinator_handle이 같아야 한다. 이 제어 터미널은 명령·inbox를 위한 셸이며 새 지휘자 에이전트를 실행하지 않는다.
5. 이후 coordinator 명령은 **그 제어 터미널 안에서** `terminal send`로 실행하고, 각 명령의 JSON 출력·종료 코드를 별도의 고유한 임시 파일로 받아 읽는다. `check --wait`도 그 터미널에서 실행한다. 명령을 보내기 전 이전 명령이 끝났는지 확인하고, 전송 영수증만으로 실행 완료라고 판단하지 않는다. 외부 tmux나 다른 채팅에서 `--from`을 바꿔 다른 호출자인 척하거나 `consumer_fenced`를 우회하지 않는다. 제어 터미널 연결을 잃으면 기존 Run과 워커를 먼저 조사하고 중복 Run·워커를 만들지 않는다.
6. 동일 티켓·generation을 재개할 때 저장된 대응을 읽고 생존과 소유권을 확인해 같은 Run에 연결한다. 엔진 재시작이나 제어 터미널 종료는 워커 종료의 증거가 아니다. 런타임 접근 거부는 지침대로 권한을 해결하며 Orca를 재시작하지 않는다. 연결 불가를 직접 CLI 실행으로 우회하지 않는다.

## 과업 배정과 결과 수집

- 구현은 Codex `gpt-6.1-terra / medium`, 리뷰·읽기 전용 조사는 Codex `gpt-6.1-sol / medium`이다. `worker-start --spec <자기 완결적인 과업> --worktree path:<현재 checkout> --agent codex --model <역할 모델> --effort medium --json`으로 시작한다. 모델은 이 프로젝트가 지정한 값이며 capacity 때문에 바꾸지 않는다. 영수증의 requested/effective를 확인한다.
- 구현 spec의 기능 범위와 수락 조건은 계획 파일이 유일한 출처다. 편집 가능 범위, 커밋·티켓 완료 금지, 한국어 전체 보고 파일, 검증 근거, 미완료 시 실패 보고를 명시한다. 리뷰는 **검사만 하는 과업**으로 지시하고 소스 수정·빌드·시험·별도 하위 워커 실행을 금지한다. CLI의 sandbox 보장이 확인되지 않았는데 리뷰가 OS 수준에서 읽기 전용이라고 주장하지 않는다.
- 모든 워커에게 live injected preamble을 따르게 한다. 정확한 Task/Dispatch/handle과 heartbeat·ask·inbox 확인·ack·worker_done 의무를 보존한다. 업무상 build/review 스킬 호출 금지는 Orca 생명주기 보고를 금지한다는 뜻이 아니다. 최종 worker_done은 정확히 한 번 보내고 outcome succeeded/failed와 실제 report-path를 사용한다. 구현자는 최초 구현 뒤 type status / subject implementation-ready로 중간 보고하고 최종 검증까지 Dispatch를 유지한다. 리뷰·조사처럼 후속 편집이 없는 과업은 완료 즉시 worker_done을 보낸다. 전체 결과는 파일에서 읽는다.
- 독립적인 리뷰 렌즈는 전부 시작한 뒤 수집한다. 같은 checkout의 소스 편집 워커는 하나만 활성 편집자로 둔다. 결과 대기는 지휘자의 같은 턴에서 `orchestration check --wait --types "status,worker_done,escalation,question" --timeout-ms 45000 --json`을 반복한다. 빈 결과·시간 초과·heartbeat·TUI idle은 완료나 실패가 아니다. 턴을 끝내서 결과를 기다리지 않는다.
- 각 Delivery의 질문에 reply하고, 예상한 활성 Dispatch의 결과인지 검증하며, 보고 파일과 근거를 읽고, 워커의 다음 소유권을 결정한 뒤 deliveryId를 ack한다. 세 번 연속 빈 대기면 해당 Run의 worker-list와 worker-show/read로 조사하고 nextAction을 따른다. unverifiable은 종료 증거가 아니므로 중복 편집자 실행·stop·abandon·release의 근거로 삼지 않는다.

## 같은 구현자에게 후속 수정

현재 Orca의 structured chat 워커는 완료 후 `worker-start --terminal <structured handle>`로 다시 배정하면 terminal_unsupported_for_agent_session으로 거부된다. 따라서 구현 Task의 범위를 최초 구현부터 검증·리뷰 반영까지로 정한다. 구현자는 첫 구현을 끝냈을 때 `type status / subject implementation-ready`와 Task/Dispatch·실제 report-path로 **중간 보고**만 하고, 자신의 Dispatch를 완료하지 않는다. 그 뒤 live preamble의 정확한 inbox를 check --wait하며 다음 지시를 받는다. Task가 아직 진행 중이므로 worker_done 이후 idle 의무와 충돌하지 않는다.

지휘자는 해당 중간 보고를 받아 전체 파일·diff·Verify를 직접 확인한 뒤 리뷰 워커를 띄운다. 수정 요청은 기존 **활성 Dispatch**에 `send --to dispatch:<id>`로 전달한다. 같은 구현자가 코드를 수정하고 수정 보고도 status로 보낸다. 리뷰와 최종 검증이 끝나면 명시적으로 finalize를 보내고 정식 worker_done·최종 보고를 받은 뒤 release한다. 구현자가 실제로 수행 불가하면 finalize를 기다리지 말고 outcome failed로 정식 보고하게 한다.

이미 정식 완료된 Dispatch에 메시지를 보내 다시 깨어날 것으로 기대하거나, structured handle을 terminal로 바꿔 끼우지 않는다. 지휘자가 직접 소스·시험을 수정하지 않는다. 이 절차가 기본 스킬의 '같은 구현 subagent 재호출'을 대체한다.

## 실패·capacity·정리

- 지휘자·감독자·워커의 capacity/server_overloaded는 모델을 바꾸지 않고 같은 모델·세션에서 계속 재개한다. worker-read의 실제 오류와 최신 진행을 확인하고 이미 재개됐으면 중복 입력하지 않는다. 활성 워커에는 스킬의 메시징/복구 절차를 따른다. 메시지 enqueue는 재개 증거가 아니므로 새 턴·진행을 확인한다. capacity 횟수만으로 포기하거나 새 Run/Task를 만들어 회로 차단을 우회하지 않는다.
- 실제 사용량 한도는 capacity와 구분해 resets와 증거를 보고한다. 지휘자의 HALT는 기존 `usage limit:` 사유 형식을 유지한다. 두 번의 실제 구현 실패도 기존 blocked 형식으로 기록한다. 결과가 모호하거나 워커가 사라졌다면 recovery-and-cleanup 참조에 따라 먼저 조사한다. Orca의 circuit breaker는 우회하지 않는다.
- 리뷰 결과를 받으면 release한다. 구현자는 같은 활성 Dispatch에서 최종 확인 지시를 기다리며, 정식 완료 결과까지 받은 후 release한다. 사용자 요청 없이 무기한 retain하지 않는다. worker-list의 해당 Run에서 reclaimable이 남지 않았는지 확인한다. terminal close나 PID kill로 워커를 대신 정리하지 않는다.
- HALT 또는 새 bmad-loop run 이전에는 자기 Run의 워커 상태를 기록하고 정리한다. 명시적인 과업 취소가 필요하면 recovery 절차로 해당 Dispatch만 취소한다. 단순 무응답을 취소 근거로 삼지 않는다. 모든 워커가 정리되고 미처리 mail이 없는 전용 제어 셸만 마지막에 닫는다.
- 지휘자는 기존 plan/result의 blocked·escalation·awaiting-operator 형식과 엔진의 최종 완료 판정을 유지한다. 워커의 worker_done으로 티켓 done을 대신하지 않는다. bmad-loop TUI·감독자의 기존 지휘자 감시 대상은 바뀌지 않는다.
