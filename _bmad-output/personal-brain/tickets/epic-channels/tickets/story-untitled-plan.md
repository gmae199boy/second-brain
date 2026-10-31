---
title: '결과 묶음의 순서 발신과 항목별 재개'
type: feature
ticket: 4
created: '2026-10-31'
status: blocked
baseline_revision: 52555e05f9fbdb5b3c478e2a3b3540c921700b97
route: full
route_source: pinned
risk: medium
review: ''
review_source: ''
lenses_ran: []
review_loop_iteration: 0
followup_review_recommended: false
context: [AGENTS.md]
warnings: [oversized]
deferred: []
blocked_at: "2026-10-31"
blocked_reason: "구현 워커의 bmad-build 초기화가 PyPI jinja2 DNS 조회 실패로 종료했다. 정식 failed Dispatch를 release·ack했으나 필수 bmad-orca-control.py start가 같은 Task 복구에 필요한 --task·--retry-of를 unsupported or duplicate worker-start flag로 거부한다. 새 Task 우회 없이 제어 도구의 동일 Task 재시도 지원 또는 다음 generation의 복구가 필요하다."
---

<intent-contract>

## Intent

**Problem:** 현재 채널은 텍스트 하나만 보내고 요청 전체 결과만 저장하므로 리포트 묶음의 일부 성공을 보존할 수 없다.

**Approach:** 요약·앨범 목록·전문 문서를 공통 요청 계약으로 받고 항목별 결과를 내구성 있게 저장한다. 감독자 Node worker가 순서대로 보내며 재시작 때 확인된 sent 항목을 건너뛴다. 여러 저장·실행 경계를 다루므로 고정 full 경로를 따른다.

## Boundaries & Constraints

**Always:** 요약 → 앨범 순서 → 전문을 지킨다. 사진 한 장은 sendPhoto, 2~10장은 sendMediaGroup, 전문은 multipart sendDocument로 보낸다. 텍스트 UTF-16 4096, 사진 10MiB, 문서 50MiB는 포함 경계이며 초과는 항목별 too_large 영구 실패다. 텍스트와 캡션은 기존 출력 코덱으로 가리고 DB 원문은 유지한다. 파일은 core FileStore에서 읽는다. sent 항목은 다시 보내지 않고 unknown·실패 항목만 재시도한다. 요청 의미 키·단일 gate·현재 attempt token fence·지수 재시도·실패 예산·legacy 비발신·확장 INSERT 최소 권한을 보존한다. HTTP 중 DB 쓰기 트랜잭션을 잡지 않는다. 기존 텍스트 요청 및 v19 데이터와 migration checksum을 유지한다.

**Never:** Garmin 계산·생산자, 수신·양방향 메시지, CLI resend·스킬, 실계정·배포를 구현하지 않는다. 운영 비밀을 읽거나 출력하지 않는다. push·티켓 done·tickets.py mark·구현자 커밋을 하지 않는다. 계획 상태와 완료 판정은 지휘자·오케스트레이터가 맡는다.

## I/O & Edge-Case Matrix

| 시나리오 | 입력·상태 | 관찰 결과 | 실패 처리 |
|---|---|---|---|
| 정상 묶음 | 요약·앨범 둘·전문 | HTTP 메서드와 항목 결과가 순서대로 sent | 실제 응답의 외부 id만 저장 |
| 부분 성공 후 재시작 | 둘째 앨범 접수 뒤 연결 끊김 | 요약·첫 앨범 POST는 한 번, 둘째부터 재전송 | unknown과 현재 attempt로 복구 |
| 텍스트 경계 | 4096·4097 UTF-16 단위 | 전자는 발신, 후자는 HTTP 없이 too_large | 첫 영구 실패로 닫힘 |
| 파일 크기 경계 | 사진 10MiB·+1, 문서 50MiB·+1 | 경계는 multipart 발신, 초과는 too_large | 실패 항목 결과 보존 |
| 앨범 개수 | 1·2·10·11장 | 1은 sendPhoto, 2·10은 sendMediaGroup, 11은 too_large | 잘못된 빈 앨범도 명시적으로 거부 |
| 출력·파일 경계 | 비밀 포함 텍스트·캡션, FileStore 위치 | HTTP에서 비밀 가림, DB 원문 유지, 저장 파일 바이트 전송 | 기존 위치 검증 우회 없음 |
| 저장·권한 회귀 | 기존 요청·v19 데이터·stale token·확장 role | 기존 텍스트 정상, sent 결과 위조 거부 | 기존 RLS·attempt fence 유지 |

</intent-contract>

## Code Map

- `packages/core/src/channels/store.ts`, `send.ts` — 현재 ChannelRequest는 text만 갖고 sendChannelRequest가 gate 뒤 sendMessage하고 finish한다. 요청 호환성을 유지하며 bundle 입력·항목별 결과·현재 token 저장 계약을 추가한다.
- `packages/postgres/src/channels.ts` — create/read의 원문 보존, withWrite·attempt_is_current·recover/finish 패턴을 재사용한다. `0017_channels.sql`~`0019_channel_legacy.sql`은 수정하지 않고 다음 `0020_*.sql`을 추가한다. `src/migrate.ts` 최고 버전은 19다. bundle 입력과 결과 권한을 분리하고 기존 역할에도 최소 권한만 적용한다.
- `packages/core/src/testing/fakes/store.ts`, `testing/contracts/channel-store.ts` — fake·PG 공유 계약을 함께 확장한다. 새 ChannelStore 메서드의 unavailable 대역과 시험 대역도 갱신한다.
- `apps/cli/src/adapters/telegram.ts` — 현재 sendMessage의 오류 분류·429 retry_after·응답 외부 id 처리를 media 전송에도 재사용한다. multipart 파일·앨범 attachment와 배열 응답을 처리한다.
- `apps/cli/src/workers/channel-send.ts`, `src/runtime/file-store.ts`, `src/assembly.ts`, 감독자 worker 환경 조립 — worker에 설정된 filesPath의 localFileStore를 연결한다. 기존 FileStore는 brain 소유 locator와 실제 경로·symlink를 검증한다. 직접 경로 읽기나 별도 파일 체계를 만들지 않는다.
- `apps/cli/test/channel-fixture.ts`, `channels-tracer.test.ts`, `channels-retry.test.ts` — 실제 PG·데몬·Node worker·가짜 HTTP 서버·가짜 clock·정리 패턴이다. multipart를 바이트 그대로 관찰하고 앨범 응답·선택적 연결 끊김을 시험 전용으로 제어한다.
- `packages/postgres/test/migrate.test.ts`, `extension-permissions.test.ts`와 최고 버전 고정 fixture — v19 보존·권한 회귀 및 실제 새 버전에 맞춘 검증이다.

## Tasks & Acceptance

**Execution:**
- [ ] 1단계: core 채널 계약·발신 use case·fake·공유 suite와 postgres 채널 저장·새 0020 migration·버전·권한 시험을 구현한다. 항목별 성공의 내구성·stale attempt 거부·기존 요청 호환성을 표적 시험한다.
- [ ] 2단계: Telegram multipart adapter·worker FileStore 조립·가짜 서버 fixture와 `apps/cli/test/channels-bundle.test.ts`를 구현한다. 아래 전체 HTTP 행렬과 기존 발신·재시도·권한 회귀를 실행한다.

**Acceptance Criteria:**
- Given 실제 PG·감독자·Node worker·가짜 서버와 FileStore의 파일, When 시험 생산자가 묶음을 넣으면, Then 서버가 요약 → 앨범들 → 전문 순서와 실제 파일 바이트·가려진 텍스트/캡션을 받고 DB에서 원문·항목 결과·응답 id를 재조회한다.
- Given 둘째 앨범에서 서버 연결을 끊는 묶음, When 데몬을 멈추고 재시작한 뒤 가짜 clock으로 재시도하면, Then 요약·첫 앨범은 다시 나가지 않고 둘째 앨범부터 전문까지 보내며 최종 sent로 수렴한다.
- Given 행렬의 텍스트·파일·앨범 경계값, When 각각 같은 발신 경로를 실행하면, Then 경계 포함 성공과 초과 too_large 영구 결과·HTTP 없음 및 사진 1장/앨범 메서드를 관찰한다.
- Given 기존 텍스트 요청·확장 role·현재/회수 token과 v19 DB, When 마이그레이션과 저장·발신 계약을 실행하면, Then 기존 데이터·동작·최소 권한과 현재 attempt만 결과를 확정하는 경계가 유지된다.

## Implementation Notes

## Plan Change Log

- 2026-10-31 감독자 복구: 실패 Dispatch 정식 종료·release·ack와 소스 미변경을 보존한다. PyPI jinja2 주소 HTTP 200 및 Docker 응답을 확인했다. 새 엔진 generation에서 재귀 build/review workflow를 실행하지 않는 구현 워커에게 1단계만 먼저 배정하고 phase-ready와 표적 검증을 확인한 뒤 2단계를 배정한다. 같은 Task 재시도 제어 제한이 재발하면 정확한 상태를 보존해 별도 복구한다. 전체 계약·검증은 유지한다.

## Review Triage Log

## Design Notes

요청 전체 attempt와 항목별 외부 결과는 다른 사실이다. 각 HTTP 성공 직후 항목 결과를 현재 token으로 확정하고 다음 항목으로 이동한다. 저장 전 crash는 unknown으로 재시도할 수 있으나 저장된 sent는 유지한다. 작은 비보안 공백만 [ASSUMPTION] 코드 주석·계획·deferred로 명시한다. 보안·마이그레이션 안전성은 추정하지 않는다.

## Verification

- `pnpm build`와 `pnpm typecheck` — 전체 성공.
- `pnpm exec vitest run --project core --project postgres --project cli channel-store channel-send channels-bundle channels-tracer channels-retry extension-permissions attempt-fence migrate schema --reporter verbose` — HTTP 행렬·저장·권한·기존 발신 회귀의 모든 실행 시험 통과. 새 통합 시험은 위 AC와 행렬을 시험 이름에 반영한다.
- `bash _bmad/custom/bmad-loop-verify.sh` — 전체 필수 검증 성공.

Docker/OrbStack의 전용 PG·격리 DB·임시 홈과 가짜 서버만 사용한다. fixture의 close로 데몬·자식·서버·DB 연결 종료를 기다리고 임시 홈·DB·role을 정리한다. 외부 운영자 작업은 없다.

## Auto Run Result

- Status: blocked
- 티켓 15.4의 계약·코드 조사·2단계 구현 계획을 작성했다. 구현 워커는 소스·시험을 변경하기 전에 초기화에 실패했으므로 수락 조건을 충족하지 못했다. 제품 구현·시험·리뷰·커밋은 수행하지 않았다.
- 실패 근거: 구현 `task_ce4bdaa94d10` / `ctx_7af150e448f4`의 정식 outcome failed와 전문 `_bmad-output/personal-brain/reports/story-untitled-worker-failure.md`를 확인했다. 워커가 호출한 bmad-build 초기화는 `Failed to fetch: https://pypi.org/simple/jinja2/`; `dns error: failed to lookup address information: nodename nor servname provided, or not known`로 종료했다. capacity 또는 사용량 한도로 추정하지 않는다.
- 복구 제한: recovery-and-cleanup은 같은 Task의 `worker-start --task … --retry-of …`를 요구한다. 필수 `_bmad/custom/bmad-orca-control.py`의 start는 해당 두 flag를 지원하지 않으며 실제 호출이 `unsupported or duplicate worker-start flag`로 거부됐다. 기존 start 요청은 역할별 고정 요청과 기존 Dispatch 신원을 재사용하므로 새 Task로 우회하지 않았다. 구현 실패 1회이며 `implementer unavailable`이나 2회 연속 실패로 기록하지 않는다.
- 다음 행동: 동일 Task 재시도를 제어 도구가 지원하도록 별도 복구하거나 엔진의 다음 generation에서 기존 실패 근거와 계획을 보존해 재개한다. 새 배정은 구현 워커의 build/review workflow 재귀 실행 금지를 명시해야 한다. 구현·검증 범위는 줄이지 않는다.
- 검증: 착수 시 HEAD `52555e05f9fbdb5b3c478e2a3b3540c921700b97`와 clean tree·git metadata 갱신을 확인했다. Docker 응답을 확인했으나 구현이 없어 계획의 제품 검증 명령은 실행하지 않았다. 행렬 감사와 독립 Quick 리뷰도 미수행이며 통과로 주장하지 않는다.
- 변경 파일: 이 계획 파일과 위 워커 실패 보고서다. 소스·시험·plugin/app-ref는 변경하지 않았다. HALT 절차에서만 `tickets.py mark 15.4 blocked`를 실행했다. 티켓 done·push·커밋은 실행하지 않았다.
- 정리: 자기 Orca Run `run_c10a789f9c2e`의 failed Dispatch를 수락하고 release했으며 완료 mail `delivery_3e3b562c76aa`를 ack했다. restore에서 pending delivery null, worker-list에서 released 1개·reclaimable 0개를 확인했다. 활성·소유권 미확인 워커·취소할 과업은 없다. checkpoint 뒤 자기 전용 제어 셸만 닫는다.
- 이 티켓은 외부 HUMAN 작업 때문에 대기하는 상태가 아니므로 awaiting-operator를 사용하지 않았다. 잔여 위험은 미구현 전체와 워커 초기화·동일 Task 복구 경로다.
