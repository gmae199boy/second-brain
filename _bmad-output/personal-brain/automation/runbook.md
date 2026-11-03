# 티켓별 Orca 자동 구현 런북

## 목적과 현재 승인 범위

남아 있는 Personal Brain 티켓을 의존순으로 하나씩 구현한다. 티켓마다 Orca 워크트리에 Codex 지휘자 `gpt-6.1-sol / medium`을 배정하고 `$bmad-build-auto`로 구현·검증·리뷰·필요한 후속 리뷰를 마친다. 워커는 티켓 브랜치를 푸시하고, 중앙 감독자는 main 병합·푸시가 실제 원격에 반영됐는지 확인한 뒤 다음 티켓으로 간다. 사용자의 최종 인수 전에는 티켓과 에픽을 `built`로 남긴다.

초기 준비 상태는 `mode: prepared`, `execution_authorized: false`였다. 2026-11-03 사용자가 실행을 승인해 preflight와 준비 커밋·원격 main push를 수행했다. 현재 실행 여부와 재개 지점은 중앙 체크포인트 및 실제 Git·Orca 상태로 판단한다. 이후 사용자는 티켓 워크트리를 main의 자식이 아닌 저장소의 최상위 워크트리로 만들고 그 안에서 독립 지휘자를 실행하도록 승인했다.

## 소유권과 기준 문서

- 중앙 감독자는 이 채팅이다. 티켓 선택·워크트리 배정·결과 수락·main 병합·푸시·에픽 전이를 맡는다.
- 티켓 지휘자는 전용 최상위 Orca 워크트리의 독립 세션이다. 계획·구현 배정·검증·리뷰·수정·후속 리뷰·티켓 built·커밋·티켓 브랜치 푸시를 맡는다. main을 병합하거나 푸시하지 않는다.
- 구현·리뷰 위임은 현재 설치된 `$orchestration` 절차를 따른다. 지휘자의 하위 구현자는 `gpt-6.1-terra / medium`, 리뷰어는 `gpt-6.1-sol / medium`을 사용한다. 하나의 checkout에서 동시에 소스를 편집하는 구현자는 하나다.
- 티켓의 실제 상태는 계획 파일의 `status`, 에픽 상태는 에픽 문서의 `status`가 원천이다. 실행 JSON은 Git·Orca와 진행 단계를 잇는 체크포인트이며 티켓 상태를 대체하지 않는다.
- 전역 스킬 원본은 수정하지 않는다. 기존 bmad-loop 정책·런북·감독 스크립트·제어 도구는 이번 자동화에서 사용하지 않는다. 과거 완료 증거·미완료 코드는 보존한다.
- 사용자 지시와 `AGENTS.md`가 우선이다. 문서·커밋·프롬프트에 개인 홈 절대 경로를 쓰지 않는다. 경로는 `<repo>/…`, `~/…`, 저장소 상대 경로로 기록한다.

### 중앙 감독자와 티켓 지휘자의 개입 경계

2026-11-03 사용자 정정: 티켓 지휘자가 구현·리뷰·수정·검증·후속 리뷰·브랜치 push 전체를 자율 수행한다. 중앙은 정상 진행 중인 티켓의 단계나 리뷰 여부를 확인하려고 worker-read/worker-list 또는 워커 체크포인트를 반복 조회하지 않는다. 리뷰 findings triage와 수정 지시도 티켓 지휘자 소관이며 중앙이 병행 지휘하지 않는다.

중앙이 개입하는 시점은 최종 결과 보고, 지휘자가 요청한 명세·외부 입력 판단, 지휘자가 자체 복구할 수 없는 실패, 세션·컴팩션 복구 시 소유권 대조다. 최초 실행 방식의 시작 증거 확인은 한 번의 preflight 검증이며 주기적 진행 점검의 근거가 아니다. 중앙은 최종 보고를 받은 뒤 계획·diff·검증·리뷰·브랜치 push 증거를 대조하고 main 병합·push 및 다음 티켓·에픽 전이를 수행한다. 증거에 공백이나 모순이 있을 때만 필요한 보완을 지휘자에게 돌린다.

지휘자는 중앙 Run에 최종 결과(`ticket-result:<ticket>`)를 보고한다. 하위 구현·리뷰 결과는 지휘자 자신의 Run에서 처리한다. 중앙 판단이 필요한 명세·외부 입력 질문과 지휘자가 자체 복구할 수 없는 실패는 중앙에 전달한다.

정상 실행 중 중앙의 다음 행동은 `await-ticket-result`다. 지휘자의 결과를 기다리는 동안 같은 티켓의 작업을 중복 시작하지 않는다.

## 상태와 증거 저장

중앙 checkout의 `.brain-automation/state.json`이 로컬 실행 체크포인트다. 최초 준비 사본은 `state.example.json`과 같은 구조다. `.brain-automation/`은 gitignored이며 원격으로 푸시하지 않는다. 다른 checkout의 동명 파일을 중앙 상태로 착각하지 않는다. 워커 프롬프트에 중앙 checkout과 자신의 체크포인트 위치를 명시한다.

중앙에는 Run/Task/Dispatch/handle, 생성 request ID와 영수증, 현재 티켓·워크트리·기준 SHA·다음 행동·보고서·검증·브랜치 푸시·main 반영 SHA를 남긴다. 티켓별 상세 상태와 보고서는 중앙 `.brain-automation/tickets/<ticket>/`에 둔다. 각 워커도 자신의 checkout `.brain-automation/worker.json`에 단계를 기록하고 중앙에 보고 경로를 전달한다. 비밀 값·토큰·전체 환경 변수는 저장하지 않는다.

상태는 단일 소유자가 같은 디렉터리의 임시 파일에 쓴 뒤 원자적 rename으로 교체한다. 외부 변경 명령을 내리기 전에 의도와 request ID를, 응답을 받은 후 실제 영수증과 다음 행동을 기록한다. 시작·검증·리뷰·수정·built·커밋·브랜치 푸시·병합·main 푸시 경계마다 저장한다. JSON 문법은 `python3.14 -m json.tool .brain-automation/state.json`으로 확인한다. Python은 3.11 이상을 사용한다.

단계 이름은 `preflight → dispatching → building → reviewing → fixing → built → branch-pushed → merging → main-pushed → selecting-next`다. 재리뷰는 `fixing → reviewing`으로 되돌린다. 환경·외부 입력 차단은 `blocked`에 원인·증거·재개 조건을 기록하며 완료로 바꾸지 않는다.

## 매 세션·컴팩션 후 복구

1. `AGENTS.md`, 이 런북, 자기 역할의 상태 JSON과 마지막 보고서를 읽는다. 요약 기억만으로 새 Run·워크트리·워커를 만들지 않는다.
2. `prepared`면 준비 상태를 유지한다. `running`이면 디스크 상태를 실제 Git·티켓·Orca와 대조하고 저장된 다음 행동부터 이어 간다. 사용자 중단 지시가 있으면 유지한다.
3. `git status --short`, 현재 branch/HEAD, 저장된 워크트리·티켓·기준 SHA를 확인한다. fetch 후 원격 티켓 브랜치와 main SHA도 확인한다. 예상하지 못한 변경은 소유권을 조사하며 reset·clean·blanket stash로 지우지 않는다.
4. 설치된 `$orca-cli`, `$orchestration`을 읽고 세션의 Orca 실행 파일을 선택한다. 같은 실행 파일의 `skills get orca-cli`, `skills get orchestration`으로 최신 가이드를 읽는다. 기존 run이 있으면 현재 Run/Dispatch·worker-show/read·처리된 inbox를 조사한다. 다른 호출자 핸들로 소유권을 위조하지 않는다.
5. timeout·무응답·관측 불명은 종료 증거가 아니다. 응답을 잃은 시작은 저장한 request ID/영수증과 해당 버전의 recovery 절차로 복원한다. 같은 티켓에 중복 편집자를 띄우지 않는다.
6. `branch-pushed`면 원격 브랜치 커밋과 보고를 확인해 병합부터 재개한다. `merging`이면 Git의 병합 진행 상태와 부모 커밋을 확인한다. `main-pushed`면 해당 merge SHA가 원격 main의 조상인지 확인한 후 다음 티켓을 고른다.
7. 상태 파일이 없거나 손상됐으면 예제 파일로 덮어써서 재시작하지 않는다. 실제 워크트리·Orca·Git·티켓을 조사하고 소유권과 마지막 확정 단계를 복원한다. 예제의 null은 실제 워커 부재 증거가 아니다.

## 실행 전 preflight

1. 사용자의 실행 지시를 기록하고 단일 중앙 감독자만 실행 중인지 확인한다. 과거 bmad-loop 실행기가 실제로 동작 중인지 확인하고, 살아 있으면 명시적으로 소유권을 이전하기 전 중복 실행하지 않는다. 오래된 state 파일만으로 생존을 판단하지 않는다.
2. 원격 이름·URL·main 기본 브랜치·인증·보호 규칙을 읽기 전용으로 확인한다. remote를 `origin`으로 추측하지 않는다. main은 현재 원격 상태와 맞추되 미커밋 변경을 먼저 보존한다. 필요하면 보호 규칙을 지키는 PR 경로로 병합하며 강제 푸시·규칙 우회는 하지 않는다.
3. 중앙의 미커밋 변경을 확인한다. 준비 변경은 별도 커밋으로 검토 가능하게 남겨 main과 원격에 반영한 뒤 첫 티켓 기준점을 잡는다. unrelated 변경을 함께 stage하지 않는다. 현재 준비 요청만으로 이 커밋·푸시를 실행하지 않는다.
4. `_bmad/custom/bmad-build-auto.toml`은 실행 전 새 프로젝트 override로 교체하고 공식 resolve/render로 검증한다. 이번 실행에서는 준비 커밋과 `6a009a2`에서 교체·검증을 완료했다. 복구 시에는 실제 파일과 해당 증거를 대조하며 옛 설정이라고 추정해 다시 덮어쓰지 않는다. 현재 override는 이 런북의 역할·커밋·푸시·Orca 생명주기·후속 리뷰·한국어 보고 규칙을 따라야 하며, 기존 bmad-orca-workers.md나 제어 helper를 참조하지 않아야 한다. 사용자 override도 확인해 충돌을 제거한다. 대화형 bmad-build 설정은 이번 실행에 사용하지 않는다.
5. `$bmad-build-auto`는 설치 스킬의 공식 렌더 명령을 따른다. 이 호스트에서는 sandbox의 PyPI DNS 제한과 동일 명령의 권한 확장 성공을 14.8·16.4에서 확인했으므로 새 지휘자 명세에도 공식 render 첫 호출의 `require_escalated` 사용을 명시한다. 실패하면 원인과 원문 오류를 기록하고 환경을 해결한다. 워크플로 소스를 직접 실행해 우회하지 않는다. DNS·사용량 제한·권한 오류를 구현 완료로 취급하지 않는다.
6. 아래 회귀 테스트와 실제 트리 `status/next/find`를 확인한다. tickets.py는 프로젝트 패치이므로 실행 중 BMAD setup/update를 하지 않는다. 필요하면 상태를 보존하고 재설치 후 패치와 테스트를 다시 확인한다.
7. 워크트리 setup에 필요한 pnpm·Python·DB·설정·시험 격리를 확인한다. 운영 데이터와 외부 계정을 시험 데이터로 바꾸지 않는다. 비밀 파일을 저장소나 보고서에 복사하지 않는다.

## 티켓 선택과 배정

```sh
python3.14 _bmad/method/scripts/tickets.py status _bmad-output/personal-brain
python3.14 _bmad/method/scripts/tickets.py next _bmad-output/personal-brain
python3.14 _bmad/method/scripts/tickets.py find <ticket-ref>
```

실제 트리를 매번 다시 읽고 `problems`·의존조건·미완료 작업을 확인한다. 선택 가능 0건은 완료가 아니다. 기존 built 티켓도 이전 검증·리뷰·원격 main 반영 증거를 확인한 뒤 종료 대상으로 계산한다. 기존 in-review 티켓은 실제 부분 작업과 원래 baseline부터 이어간다. dropped 티켓을 부활시키지 않는다.

티켓의 일반 `after`는 BMAD 원래 규칙상 리뷰 상태도 충족할 수 있다. 이 자동화에서는 그것만 보고 선행 티켓 병합 전에 다음 티켓을 띄우지 않는다. 선행 티켓의 구현·리뷰 완료와 원격 main 반영을 따로 확인한다.

새 티켓은 방금 확인한 원격 main SHA에서 분기한다. `$orca-cli`의 `worktree create --no-parent --base-branch <확인한 main ref> --agent codex --model gpt-6.1-sol --effort medium --prompt <명세 파일을 읽는 지시>`로 저장소의 최상위 워크트리와 독립 지휘자를 함께 시작한다. `worktree show`의 `parentWorktreeId: null`을 확인해 main과 같은 레벨인지 검증한다. `--no-parent`는 Orca 계층을 정하고 `--base-branch`는 Git 기준을 정하므로 둘을 구별한다. 이 경로에서 지휘자 자체를 `worker-start`로 다시 Dispatch하지 않는다. 구현·리뷰 워커만 독립 지휘자 자신의 Run에서 `worker-start --worktree current`로 시작해 depth 1을 유지한다. 정확한 flag와 반환 receipt는 현재 CLI help를 따른다.

긴 명세는 중앙의 티켓별 로컬 파일에 먼저 만들고 생성 prompt에서 읽을 실제 위치를 명시한다. 첫 세션은 이를 자기 checkout의 `.brain-automation/`에 복사해 복구에 사용한다. `worktree create --agent`가 이미 시작한 지휘자를 중복 launch하지 않는다. 이미 작업 중인 checkout을 복구할 때는 아래 전환 절차를 따른다.

긴 spec은 저장소 상대 경로와 원문 티켓 요구를 담아 파일로 만든다. 독립 지휘자 생성·launch에는 `--prompt`로 그 파일 전체를 읽도록 지시한다. 하위 dispatched 구현·리뷰 워커에는 현재 CLI가 지원하는 `--spec-file`을 사용한다. 런북·티켓 ref·계획·원래 baseline·main 병합 금지·branch push 의무·보고 및 체크포인트 위치를 포함한다. 독립 지휘자에게 중앙 Run ID와 보고 규약을 명시한다. 하위 구현·리뷰 워커는 자신의 Task/Dispatch와 최종 worker_done 의무를 injected preamble에서 읽게 한다. 최초 실제 하위 시작의 ready 영수증과 worker-show depth는 지휘자 로컬에 저장하고 최종 보고에 포함한다. 별도의 시작·depth 보고를 중앙에 보내지 않는다. 실패하면 부분 자원을 보존한 뒤 복구한다.

워커 대기는 최신 Orca 스킬대로 턴을 종료하고 결과 메시지를 받으면 재개한다. 메시지에 제시된 check를 수행한다. 예전 helper의 반복 polling이나 다른 Run의 inbox 소비를 쓰지 않는다. 독립 지휘자는 자신이 소유하는 Run과 하위 Task/Dispatch를 저장하고 중앙 질문·최종 결과 보고 의무를 유지한다. 중앙 소유 Run을 run-use하거나 종료된 이전 지휘자의 --from 핸들을 사용하지 않는다.

## 깊이 제한에서 최상위 독립 지휘자로 전환

2026-11-03 검증: 중앙에서 Dispatch한 지휘자의 하위 시작은 `depth 2, max 1`로 거부됐고 `effectsApplied=false`였다. 기존 Dispatch를 `worker-stop`으로 정리해 `stopped / closed_agent_terminal`을 확인한 뒤 같은 작업 checkout에 `agent launch`로 독립 지휘자를 시작했다. 그 지휘자의 실제 Terra/medium 구현 Dispatch는 `depth: 1`, `ready`, `turnStart observed`였고 live 상태를 확인했다. 이어 `worktree set --worktree <selector> --no-parent` 후 `parentWorktreeId: null`을 읽어 main과 같은 레벨을 확인했다. 이 증거는 시작·계층 검증이며 티켓의 구현·리뷰 완료 증거는 아니다.

복구 순서:

1. 중앙·워커 체크포인트, 계획·baseline·미커밋 변경, 기존 Run/Dispatch·실패 영수증을 보존한다. 모호한 생존 상태를 종료로 추정하지 않는다.
2. 사용자가 승인한 교체 대상 Dispatch만 최신 recovery 절차로 정리한다. `stopped` 등 확정 증거가 없으면 같은 checkout에 새 편집자를 띄우지 않는다. 워크트리나 부분 작업을 삭제하지 않는다.
3. 이미 Orca가 만든 checkout이면 `worktree set --worktree <selector> --no-parent`로 최상위에 두고 `agent launch --worktree <selector> --agent codex --model gpt-6.1-sol --effort medium --prompt <복구 명세>`로 독립 지휘자를 시작한다. 새 티켓은 앞 절의 `worktree create --no-parent` 경로를 사용한다.
4. launch operation ID·정확한 handle·prompt delivery와 부모 없음 확인 결과를 중앙에 저장한다. 독립 지휘자는 종료된 이전 Task/Dispatch를 자기 것으로 재사용하지 않고 새 소유 Run에서 구현·리뷰를 감독한다. 실제 depth 1 시작 성공을 자기 체크포인트에 저장하고 최종 보고에 포함한다.
5. 독립 지휘자는 중앙 Run에 `orchestration send --to run:<중앙 Run ID> --type status --subject ticket-result:<ticket> --report-path <실제 보고 파일> --body <성공/실패와 근거>`로 보고한다. 자신의 parent Dispatch가 없으므로 worker_done을 위조하지 않는다. 하위 dispatched 워커는 정상 worker_done을 보낸다. 질문과 차단도 중앙 Run으로 send하고 중앙은 그 메시지 ID에 reply한다.
6. 중앙은 독립 세션 handle·Run·하위 Dispatch 및 보고 원문·계획·원격 브랜치 SHA를 대조한다. 단순 status 전달 성공으로 완료하지 않는다. 이후 main 병합·push와 에픽 전이 기준은 동일하다.

## 구현·리뷰·built·브랜치 푸시

지휘자는 티켓과 계획의 전체 수락 기준을 유지한 채 `$bmad-build-auto`를 수행한다. 모든 필수 검증과 독립 리뷰를 완료하고 발견사항을 근거와 함께 triage한다. 코드 변경을 반영한 부분은 필요한 시험과 후속 리뷰로 다시 확인한다. 리뷰가 추가 검사를 요구하거나 해결 여부가 불명확하면 필요한 후속 리뷰를 수행한다. 무조건 리뷰 1회·후속 리뷰 0회 규칙은 사용하지 않는다.

범위 밖 지적은 근거를 남겨 후속 작업으로 분리할 수 있지만 현 티켓의 미충족 수락 기준을 defer로 숨기지 않는다. 작은 판단은 근거를 기록해 자율 해결한다. 실제 비밀·로그인·외부 승인처럼 에이전트가 충족할 수 없는 조건은 정확히 기록한다. 사람만 할 수 있다고 추측해 구현 실패를 넘기지 않으며 미완료를 built로 꾸미지 않는다.

모든 필수 조건 충족 후 계획 상태를 `built`로 기록한다. 지휘자는 티켓 범위의 소스·시험·계획만 stage하고 커밋한 뒤 자기 브랜치를 원격에 push한다. app-ref 변경 시 같은 커밋의 플러그인 version 증가와 이전 커밋 참조 규칙을 지킨다. 원격 브랜치가 해당 commit을 포함하는지 확인한다. 강제 푸시는 하지 않는다.

최종 보고는 티켓 ref·기준 SHA·commit SHA·원격 브랜치·검증 명령/결과·리뷰/후속 리뷰 보고 경로·미해결 항목을 포함한다. 실패 시에도 부분 작업과 재개 지점을 보존하고 실제 실패로 보고한다. 전송 성공 영수증만으로 실제 작업 성공을 판단하지 않는다.

### 추천·보류·운영 후속 항목 보존

`$bmad-build-auto`는 무인 실행에서도 수정 가능한 결함을 자동 수정하고, 해석이 갈리는 의도 공백은 blocked로 남긴다. 모든 판단을 추천으로만 넘기는 스킬이 아니다. 공식 step-04는 보류 finding을 계획 frontmatter의 단일 `deferred` 목록에 summary·evidence·선택적 location/severity로 추가하고 기존 항목을 보존하며 YAML 전체를 파싱해 확인하도록 한다. 판단 경위는 `Review Triage Log`, 잔여 위험과 후속 리뷰 권고는 `Auto Run Result`에 남긴다.

지휘자는 구현 중 채택한 가정·권고·운영자 후속 조치를 근거와 함께 계획에 남기고 최종 보고에서 그 위치를 명시한다. 리뷰 보류는 공식 `deferred` 형식을 유지하고, 외부 운영 조치는 `operator_actions` 또는 결과 절의 명시적 운영 조치 목록으로 남긴다. 권고를 실행했는지, 별도 판단이 필요한지 구별한다. 미충족 수락조건·필수 검증·필요한 후속 리뷰를 보류 항목으로 바꿔 built 처리하지 않는다.

중앙은 최종 결과 수락 시에만 계획의 `deferred`, triage의 보류, 미실행 권고·운영 조치·잔여 위험을 대조하여 [후속 항목 모음](follow-ups.md)에 티켓·종류·요약·원문 근거·상태/다음 판단을 모은다. 판단 근거는 원본 계획에 두고 모음은 중앙만 갱신한다. 기존 항목을 지우지 않고 실제 해결 근거가 있으면 처분을 덧붙인다. 모음에 없던 기존 티켓도 종료 증거를 감사할 때 추가하며, 과거 전체 티켓의 전수 수집을 마쳤다고 추정하지 않는다. 미완료 필수 조건은 별도 차단으로 표시하고 완료 집계에서 제외한다. 모음 갱신도 중앙 main 커밋·push에 포함하며 워크트리 정리 전에 원문을 보존한다. 과거 `deferred-work.md`는 역사 자료로 보존하고 기존 bmad-loop sweep·감독 정책은 적용하지 않는다.

## 중앙의 main 병합·푸시

브랜치 push만으로 중앙 작업을 끝내지 않는다. 중앙이 결과를 수락하면 main 병합·push와 원격 반영 확인까지 수행한다. 2026-11-03 사용자 정정에 따라 외부 입력 때문에 티켓이 blocked여도 독립적으로 검증·리뷰가 끝난 공개 부분 작업은 중앙이 main에 병합·push한다. 이때 미완료 수락조건과 blocked 원인·재개 조건을 계획에 그대로 남기고, 병합을 티켓 built나 에픽 완료로 계산하지 않는다. 검증·리뷰 미완료 코드, 해결되지 않은 결함, 비밀·실데이터는 이 규칙으로 병합하지 않는다. 다음 독립 티켓은 이 부분 결과의 main 원격 반영까지 확인한 뒤 시작하며, 차단된 티켓을 요구하는 의존 티켓은 시작하지 않는다.

1. 예상한 독립 지휘자 handle·Run의 결과 보고(또는 복구 중인 기존 Dispatch의 보고)를 수신하고 원문 계획·diff·검증·리뷰를 확인한다. built와 blocked 필드가 모순되지 않는지, 원격 브랜치가 보고한 SHA인지 확인한다.
2. 최신 main을 fetch하고 기준 이후 변경을 조사한다. main이 이동해 충돌·검증 영향이 생겼으면 같은 티켓의 수정 작업으로 돌려 해결·검증·필요한 재리뷰·브랜치 재푸시를 받는다.
3. 중앙에서 티켓 브랜치를 main에 병합한다. 병합 훅과 요구되는 CI/검증을 통과한다. 정상 정책으로 main을 push하고 다시 fetch해 merge SHA가 원격 main에 포함되는지 확인한다. 보호 브랜치면 승인된 PR 경로를 사용한다.
4. 브랜치 push, 로컬 merge, main push를 별도 체크포인트로 기록한다. main push 실패·CI 실패·병합 미완료는 다음 티켓을 시작할 근거가 아니다. 네트워크 응답이 불명확하면 원격 ref부터 확인한다.
5. 에픽 전이를 처리하고 실제 원격 반영까지 확인한 뒤 completed 기록을 저장한다. 아래 병합 후 정리 절차로 Orca 워크트리와 원격 티켓 브랜치를 정리·검증한 후 다음 티켓으로 간다. 증거가 남아 있지 않은 워크트리나 불명확한 살아 있는 워커를 삭제하지 않는다.

## 병합 후 Orca 정리와 원격 브랜치 삭제

2026-11-03 사용자 지시: 중앙은 main 병합·push 확인 뒤 해당 Orca 작업 공간을 정리하고 원격 티켓 브랜치를 삭제한다. 브랜치 보존이나 main 반영만으로 정리를 마쳤다고 하지 않는다.

1. 최신 원격 main과 대상 브랜치를 fetch한다. 보고한 최종 SHA와 실제 브랜치 tip이 같고, 그 tip과 merge SHA가 원격 main에 포함됐는지 확인한다. 예상하지 못한 추가 commit이 있으면 삭제하지 않고 소유권과 반영 여부부터 확인한다.
2. 대상 checkout의 tracked/untracked 변경과 소유 세션·Dispatch를 확인한다. 미보존 변경이나 진행 중인 다른 작업을 버리지 않는다. 최종 보고·리뷰·영수증·재개 체크포인트 등 gitignored 실행 증거는 중앙 `.brain-automation/tickets/<ticket>/worktree-checkpoint-archive/`에 먼저 보관한다. 실제 private 데이터의 보관 위치도 재개 기록에 남기며 공개 Git으로 옮기지 않는다.
3. 사용자 지시로 정리할 정확한 작업 공간만 현재 `$orca-cli`의 `worktree rm --worktree <정확한 selector> --delete-branch --json`으로 제거한다. 이 명령의 영수증과 최신 가이드에 따라 소유 세션을 정리한다. raw git worktree/rm이나 orchestration reset으로 대체하지 않는다. `--force`는 미보존 변경이나 정체 불명 세션을 버리는 수단으로 쓰지 않는다. 로컬 브랜치 삭제는 Orca의 안전 판정에 따르고 실제 ref로 확인한다.
4. 확인한 원격에 `git push <remote> --delete <정확한 티켓 브랜치>`를 실행한다. main·다른 티켓·실행 중인 워크트리의 브랜치는 삭제하지 않는다. 삭제 응답이 불명확하면 같은 삭제를 반복하기 전에 `git ls-remote`로 실제 ref부터 확인한다.
5. Orca worktree list와 Git worktree list에서 대상이 사라지고, 원격 ref가 없으며, 현재 실행 중인 다음 티켓은 유지됐는지 대조한다. 정리 영수증·삭제 결과·원격 main SHA·보관 경로를 중앙 체크포인트에 남긴다. 정리 실패는 완료로 기록하지 않는다.

blocked 티켓의 검토 완료 부분 작업이 main에 반영된 경우도 위 증거·보관 조건을 충족하면 정리한다. 워크트리나 브랜치를 없애도 계획의 blocked 원인과 미완료 수락조건은 유지한다. 향후 재개는 원격 main의 보존 commit과 중앙에 보관한 체크포인트를 기준으로 새 최상위 Orca 워크트리를 만들어 수행한다.

## 에픽 built 전이

`tickets.py`의 프로젝트 패치는 에픽 `status: built`를 허용한다. 에픽의 `after` gate는 선행 티켓·에픽이 `built/done`이고 미해결 blocked 필드가 없을 때 충족된다. in-review·blocked·dropped는 해당 gate를 충족하지 않는다. 일반 티켓 after의 기존 리뷰 허용과 initiative 상태 규칙은 유지한다. `done`으로 재분류하지 않으므로 built 티켓은 CLI 집계에서 계속 review로 나타날 수 있다.

중앙은 에픽의 모든 유효 하위 티켓이 `built/done`인지 확인한다. dropped는 제외하지만 그 티켓을 여전히 요구하는 의존조건은 해결해야 한다. 각 티켓의 요구·검증·리뷰와 원격 main 반영을 확인하고 미해결 blocked·필수 에픽 검증이 없어야 한다. 그 후 실제 에픽 Markdown frontmatter에 `status: built`를 적고 중앙에서 커밋·main push를 완료한다. 기존 done 에픽은 되돌리지 않는다. 실행 JSON의 표시만으로 에픽을 완료했다고 하지 않는다.

에픽 built는 사람이 인수한 done과 다르다. 하위 티켓 built만 보고 자동으로 모든 검증을 충족했다고 추정하지 않는다. 사용자가 인수하기 전 done으로 올리지 않는다. 이 패치는 에픽 전이를 자동 실행하지 않으며 중앙이 위 근거를 확인해 수행한다.

## 차단·오류·완료 판정

실제 live worker는 현재 핸들로 관측한다. capacity/일시 네트워크 오류는 모델을 바꾸거나 새 편집자를 띄우는 근거가 아니다. 최신 복구 절차에 따라 같은 작업의 상태를 확인한다. usage limit은 reset 시각과 증거를 보존한다. 질문은 명세와 사용자 지시에서 답할 수 있으면 감독자가 처리한다.

필수 외부 입력이 없으면 해당 티켓과 영향받는 의존 티켓을 미완료로 남기고 독립 작업을 검토한다. blocked 원인·재개 조건·다음 행동을 기록한다. 전체 완료는 모든 대상이 built/done 또는 적법한 dropped이고, 미해결 차단·트리 오류가 없으며 모든 결과가 원격 main에 반영됐다는 현재 증거로만 선언한다.

## 준비 패치 검증과 업데이트

```sh
python3.14 -B -m unittest discover -s tooling/brain-automation/tests -v
python3.14 _bmad/method/scripts/tickets.py status _bmad-output/personal-brain
python3.14 _bmad/method/scripts/tickets.py next _bmad-output/personal-brain
git diff --check
```

패치 대상은 `_bmad/method/scripts/tickets.py`, 회귀 테스트는 `tooling/brain-automation/tests/test_epic_built.py`다. 전역 스킬에는 영향이 없지만 BMAD setup/update가 프로젝트 복사본을 덮어쓸 수 있다. 패치를 별도 커밋으로 보존하고 재설치 후 diff와 회귀 테스트를 다시 확인한다. 무조건 옛 파일 전체를 덮어쓰지 말고 새 버전과 병합한다.

준비 패치·테스트·런북·AGENTS 연결과 새 override의 공식 resolve/render 검증은 준비 커밋으로 원격 main에 반영했다. 최상위 독립 지휘자의 실제 depth 1 구현 시작도 확인했다. 각 티켓의 구현·리뷰·브랜치 push·main 병합/push 및 에픽 전이는 별도 증거로 판정하며, 준비 검증을 티켓 완료로 대신하지 않는다.
