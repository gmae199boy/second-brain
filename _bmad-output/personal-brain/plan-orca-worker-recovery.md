---
title: 'Orca 워커 자동 복구와 지휘자 체크포인트'
type: feature
ticket: ''
created: '2026-10-30'
status: built
baseline_revision: 520ed113226821afc48b7e7f5fb6f6308e24724f
route: full
route_source: auto
risk: high
review: quick
review_source: pinned
lenses_ran: [quick]
review_loop_iteration: 0
context: ['_bmad/custom/bmad-orca-workers.md', '_bmad/custom/bmad-build-auto.toml']
---

<frozen-after-approval reason="사용자가 앞선 개선안 두 가지를 반영하도록 승인">

## Intent

프롬프트에만 의존하던 Orca 워커 복구·컨텍스트 복원을 작은 실행 도구로 고정한다. 기존 bmad-loop 지휘자는 유지하며 워커를 중복 생성하지 않고 같은 Dispatch·모델·세션에서 capacity 재개를 요청하고 실제 진행을 확인한다. 지휘자 메모리가 줄어도 디스크와 실제 Orca 상태로 이어 간다.

## Boundaries & Constraints

- 기존 프로그램·스킬 원본·애플리케이션 코드와 진행 중인 티켓을 수정하지 않는다. 허용 파일은 아래 Code Map과 Tasks의 새 도구·시험·운영 지침이다. 커밋·push·엔진 재시작·프로세스 kill은 하지 않는다.
- Python 3.11+ 표준 라이브러리. 외부 API는 선택한 Orca CLI만 사용한다. coordinator 명령은 실제 소유한 Orca 호출자/제어 셸 안에서 실행한다. consumer_fenced나 런타임 권한 검사를 우회하지 않는다.
- 체크포인트는 버전 관리하지 않는 현재 bmad-loop task의 orca-coordination.json에 원자적으로 저장한다. 버전·revision·계획 상대경로·baseline·현재 단계·다음 행동·Run/호출자·워커 역할/Task/Dispatch/handle·보고경로·검증결과·미해결 판단·pending Delivery·명령 request ID/결과·capacity 관측을 담는다. 동시 쓰기 잠금과 revision 검증으로 갱신 손실을 막고 잘못된 파일은 초기화하지 않는다.
- 시작·복원 시 실제 Run/호출자/워커와 대조한다. 존재가 불명확하거나 이미 활성 구현자가 있으면 새 구현자를 띄우지 않는다. 시작 요청은 전송 전에 UUID와 payload를 기록하고 응답 손실 후 request-show/동일 request ID로만 복구한다. 새 UUID로 blind retry하지 않는다.
- 각 결과·단계·메시지를 자동 체크포인트한다. 원본 JSON은 파일에 보관하고 빈 대기/상태 출력은 작게 요약한다. 필요한 계약·diff·검증은 생략하지 않는다.
- check는 45초 이내 rolling wait이며 worker capacity 관측을 최소 1분 간격으로 함께 수행한다. 최신 활성 Dispatch의 provider transcript에서 구조화된 server_overloaded 또는 실제 error 블록의 정확한 capacity 문구만 인정한다. 사용자/도구출력/인용 속 문구, 오래된 오류, 새 턴 시작 뒤 오류, 완료·원격 불명·다른 Run/Task는 재개하지 않는다.
- capacity는 같은 Dispatch에 orchestration send로 재개를 요청하고 입력 직전 다시 확인한다. 오류별 request ID를 저장해 중복 입력을 막는다. enqueue와 실제 재개를 구분하고 새 provider 턴/진행으로만 회복을 확정한다. 같은 모델 유지, 누적 capacity 상한 없음. 사용량 한도·실제 구현 실패는 별도다. 알 수 없는 형식/권한/전송 실패는 명확한 unconfirmed/unknown으로 남기며 새 워커·모델 변경·종료로 우회하지 않는다.
- 구현자는 implementation-ready status 뒤 같은 활성 Dispatch에서 후속 수정을 기다리고 finalize 뒤 worker_done한다. 리뷰는 검사 과업이며 OS sandbox가 확인되지 않으면 읽기 전용 강제를 주장하지 않는다.

## I/O & Edge-Case Matrix

| 상태 | 기대 |
|---|---|
| 정상 초기화·저장·복원 | revision 증가, 원자 기록, 실제 Run/Dispatch 대조, 필요한 요약만 출력 |
| 손상·stale revision·동시 변경 | 원본 보존, 오류, 새 워커/중복 요청 없음 |
| 활성/불명 구현자 존재 | 두 번째 구현자 시작 거부 |
| 시작 응답 손실·재시작 | 저장된 request ID/receipt부터 확인, 새 요청 금지 |
| 같은 오류 재관측 | 같은 오류에 재개 요청 한 번, 결과 불명은 불명으로 보존 |
| 최신 provider capacity | 같은 Dispatch·모델에 재개 요청, 후속 새 턴만 recovered |
| 옛 오류·인용·새 작업·settled·잘못된 소유권 | 재개하지 않음 |
| 빈 대기·질문·중간/최종 보고 | Delivery 저장, ack는 지휘자 처리 뒤, 단계·보고 자동 반영 |
| cursor/source 변경·잘린/모호한 출력 | 보수적으로 재조회/unknown, 회복으로 오판하지 않음 |

</frozen-after-approval>

## Code Map

- `_bmad/custom/bmad-orca-control.py`: 새 실행 도구. --state, --orca를 명시하고 init/start/check/checkpoint/restore/recover/message/ack의 최소 명령 제공. 상태 모듈 분리는 필요하면 같은 폴더에 한 파일까지 허용한다.
- `_bmad/custom/test_bmad_orca_control.py`: 새 표준 unittest. fake CLI로 위 경계와 실제 worker-read JSON 형식 검증. 실제 애플리케이션/원격 상태를 시험에서 변경하지 않는다.
- `_bmad/custom/bmad-orca-workers.md`, `_bmad/custom/bmad-build-auto.toml`: 부모가 최종 도구 명령·단계별 저장·복원과 압축 출력 지침에 연결한다.
- `~/.local/share/second-brain-loop/runbook.md`: 부모가 감독자 복구·도구 사용을 맞춘다. bmad-loop 본체/기존 지휘자 capacity helper는 유지한다.
- 실제 worker-read는 result.source/sourceIdentity/cursor/transcript.messages[] 형식이고 messages에는 role/blocks/id/timestamp가 있다. tool-result나 user의 문구를 오류로 인정하지 않는다. worker-show는 result.dispatch/runId/taskId/status와 worker/projection/observation을 제공한다.
- Orca orchestration send는 durable mailbox와 structured idle 세션의 pointer send를 지원한다. 메시지 수신과 턴 시작은 별도로 검증한다. terminal send는 structured worker를 대상으로 하지 않는다.

## Tasks & Acceptance

- [x] 새 도구 및 표준 unittest 구현, 메타데이터/요청 복구/최신 오류/동시성 경계를 실제 행동으로 검증한다.
- [x] 부모가 커스터마이징·런북을 연결하고 resolve/render를 검증한다.
- [x] 가짜 최신 capacity 이벤트의 재개·중복 방지와 실제 Orca idle 워커의 메시지 wake/새 턴/완료·release를 검증한다. 실제 provider capacity를 강제하지 않았으면 검증 한계를 분명히 기록한다.
- [x] 리뷰 후 확인된 결함을 수정하고 검증 자원을 정리한다.

## Implementation Notes

- 초기 구현 워커의 미완료 보고를 수락·release한 뒤 지휘자가 도구를 완성했다. 실제 CLI 형태의 fake subprocess 시험으로 체크포인트 잠금·request replay·오류 분류·최신 Dispatch·Delivery 경계를 검증한다.
- 실제 Orca 제어 셸에서 init/소유권/incarnation 검증에 성공했다. 실제 idle 워커도 같은 Dispatch·세션의 두 번째 턴에서 coordinator 메시지를 수신·ack하고 완료했다(`/tmp/sb-orca-wake-proof.md`). 실제 provider capacity를 강제로 발생시키지는 않았다.
- 병행 엔진의 stash에 들어간 이번 작업 파일만 경로별로 복원했고 다른 스토리의 미완료 파일·stash는 건드리지 않았다. 완료 시점의 이번 파일 사본은 `/tmp/sb-orca-*-latest.*`에 보존한다.

## Plan Change Log

## Review Triage Log

독립 Quick 검사 워커가 6건을 보고했으며 전문은 `/tmp/sb-orca-hardening-review-findings.md`에 있다. 해당 워커는 정식 성공 보고 후 release하고 Delivery를 ack했다. 모두 기존 계약의 직접 구현 결함으로 확인해 기존 명령·상태의 좁은 수정(patch)으로 반영했으며 미룬 항목은 없다.

| 발견 | 판정·검증 근거 | 반영 |
|---|---|---|
| 오래된 native capacity가 새 quota/인증 오류를 덮음 | high. 더 최신 transcript/native 오류로 후보가 무효화되지 않던 분기를 확인 | 최신 오류 우선·non-capacity native 무효화, inbox를 scan 전에 수신 |
| 실제 provider tool-call 진행 누락 | medium. 실제 `orca:codex-item%3A…` assistant 도구 호출을 확인 | tool-call과 text/thinking 진행을 구분하고 tool-result만으로 회복 판정 금지; 기존 레코드의 최초 시각 보존 |
| transcript와 native가 같은 오류를 두 번 재개 | high. 두 관측 경로가 서로 다른 request key를 만들던 것을 확인 | 같은 실패의 관측 alias와 native request를 연결; source 갱신은 같은 오류의 새 요청 근거가 아님 |
| 시작 응답 손실 뒤 restore가 워커를 누락 | high. unknown start가 workers 없이 남는 상태 확인 | restore가 저장 request-show/같은 UUID replay로 영수증·워커를 복원하고 불명확하면 verified 거부 |
| 잘린/미지원 오류를 정상으로 표시 | medium. clipping 시험의 잘못된 기대값 확인 | unknown과 이유를 반환·저장, 원본 조사 경로 유지 |
| cached ack 재시작 시 원본 링크 손상 | medium. cached result와 last_receipt가 다른 명령으로 바뀌는 경로 확인 | request 결과와 원본 receipt 경로를 함께 저장·복원 |

## Verification

- 격리 CLI 시험 43개: 원자 저장·동시 revision·손상 보존, 시작/send 응답 손실, 실제 API clipping EOF, 소유권·최신 Dispatch·quota/인용/잘림 구분, 두 오류 관측 중복 방지, 반복 capacity, provider 도구 호출 진행, cached ack 원문 복원.
- 실제 `run_cced983adcdf` 제어 셸에서 init → start → 같은 start replay → restore → checkpoint → check → 정식 보고 → release → ack를 검증했다. Task `task_6be435d89285`와 Dispatch `ctx_13ab012c8603`가 재호출 뒤 동일했고 추가 워커는 없었다.
- 검증용 체크포인트 사본에서 시작 결과/워커 연결만 지운 뒤, 실제 저장된 동일 request ID의 completed 영수증을 replay해 restore가 같은 완료 Task/Dispatch를 복원했다(`/tmp/sb-orca-lost-restore.json`). 실제 provider 오류나 production 상태를 조작하지 않았다.
- 실제 idle wake는 같은 Dispatch·provider 세션이 새 턴에서 메시지를 수신·ack하고 완료한 별도 증거가 있다. 실제 provider capacity 자체를 강제한 검증은 하지 않았다.
- 커스터마이징 resolve/render 성공: route full, review quick, quick 1개/thorough 4개 렌즈 유지. 로컬 감독자 런북은 백업 후 연결 지침을 반영했다.
- 두 검증 Run의 reclaimable 워커와 root inbox는 0건, 제어 셸 inbox도 모두 처리했다. 지휘자·진행 중인 엔진·모델 설정은 바꾸지 않았다.

재현 명령:

- `python3 -m unittest discover -s _bmad/custom -p 'test_bmad_orca_control.py' -v`
- `uv run _bmad/scripts/resolve_customization.py --skill ~/.agents/skills/bmad-build-auto --project-root . --key workflow`
- `uv run _bmad/scripts/render_skill.py --project-root . --skill ~/.agents/skills/bmad-build-auto`
- 실제 Orca 검증은 저장소를 편집하지 않는 전용 Run/워커를 사용하고 모든 작업·mail·터미널을 정리한다.

### 조사 추가 근거

- 실제 worker-read JSON은 `/tmp/sb-orca-worker-read-shape.json`, worker-show JSON은 `/tmp/sb-orca-worker-show-shape.json`에 읽기 전용 검증 자료로 있다. 구현에는 실제 API 모양을 쓰되 경로/개인정보를 fixture에 복사하지 않는다.
- 설치된 Orca의 structured mailbox pointer delivery는 활성 Dispatch에 도착한 메시지를 idle 세션에 host.send로 전달한다. 이것이 같은 세션 깨우기의 지원 경로다. 전송 영수증만으로 턴 시작을 단정하지 않는다.
- native chat worker error escalation도 있다. 요청 실패 시 활성 Dispatch의 Run에 type escalation, subject `Agent hit an error: ...`를 생성하며 payload에 taskId, dispatchId, handle, sessionId, agent, turnOutcome, requestId, failureKind(있을 때), error, detail(있을 때)를 넣는다. 이 실제 런타임 오류 이벤트를 활성 소유권·최신 transcript와 대조하면 worker-read가 오류를 잘라 낸 경우에도 구조화된 capacity 근거로 쓸 수 있다. 일반 워커의 본문에 있는 capacity 인용을 근거로 삼지는 않는다. check에서 이 native 이벤트도 저장·분류하되 Delivery는 처리 전 자동 ack하지 않는다.

### 실제 제어 셸 경계

- 전용 Orca 제어 셸에서 실행한 `orca status`의 result.caller는 null이다(`/tmp/sb-orca-shell-status-proof.json`). 구조화된 채팅의 caller.orcaSessionId만 검사하면 bmad-loop의 실제 제어 셸 경로가 항상 실패한다. 셸에서는 ORCA_TERMINAL_HANDLE와 bound run-current의 coordinator_handle을 대조하고 그 핸들이 실제 live인지를 확인한다. 다른 핸들로 신원을 바꾸지 않는다. native 채팅은 status의 live session과 bound Run을 검증한다.
- 실제 worker-read는 앞부분의 긴 injected preamble/도구 출력이 잘렸다는 warnings를 자주 낸다. 이 경고가 있다고 최신의 완전한 provider 오류 블록과 새 턴을 모두 무조건 거부하면 감지가 작동하지 않는다. 오류/새 턴을 담은 해당 레코드 자체가 완전하고 source/순서가 검증됐는지로 판단해야 한다. 잘린 오류 레코드는 여전히 unknown이다.
- worker-show의 projection에 missing_status/capability_unsupported가 있어도 exactWorker/addressable 실행 호스트 관측을 별도로 제공할 수 있다. host_unavailable이나 소유권 불명은 그대로 unknown이며, 단순 표시 공백을 capacity 재개·새 워커 실행의 근거로 삼지 않는다.
