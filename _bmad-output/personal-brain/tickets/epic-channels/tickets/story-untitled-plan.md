---
title: '결과 묶음의 순서 발신과 항목별 재개'
type: feature
ticket: 4
created: '2026-10-31'
status: done
baseline_revision: 6828b84d4c43fac6cd95f8aabe41a0a75ce53a92
route: full
route_source: pinned
risk: medium
review: 'quick'
review_source: 'pinned'
lenses_ran: [quick]
review_loop_iteration: 0
followup_review_recommended: false
context: [AGENTS.md]
warnings: [oversized]
deferred: []
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
- [x] 1단계: core 채널 계약·발신 use case·fake·공유 suite와 postgres 채널 저장·새 0020 migration·버전·권한 시험을 구현한다. 항목별 성공의 내구성·stale attempt 거부·기존 요청 호환성을 표적 시험한다.
- [x] 2단계: Telegram multipart adapter·worker FileStore 조립·가짜 서버 fixture와 `apps/cli/test/channels-bundle.test.ts`를 구현한다. 아래 전체 HTTP 행렬과 기존 발신·재시도·권한 회귀를 실행한다.

**Acceptance Criteria:**
- Given 실제 PG·감독자·Node worker·가짜 서버와 FileStore의 파일, When 시험 생산자가 묶음을 넣으면, Then 서버가 요약 → 앨범들 → 전문 순서와 실제 파일 바이트·가려진 텍스트/캡션을 받고 DB에서 원문·항목 결과·응답 id를 재조회한다.
- Given 둘째 앨범에서 서버 연결을 끊는 묶음, When 데몬을 멈추고 재시작한 뒤 가짜 clock으로 재시도하면, Then 요약·첫 앨범은 다시 나가지 않고 둘째 앨범부터 전문까지 보내며 최종 sent로 수렴한다.
- Given 행렬의 텍스트·파일·앨범 경계값, When 각각 같은 발신 경로를 실행하면, Then 경계 포함 성공과 초과 too_large 영구 결과·HTTP 없음 및 사진 1장/앨범 메서드를 관찰한다.
- Given 기존 텍스트 요청·확장 role·현재/회수 token과 v19 DB, When 마이그레이션과 저장·발신 계약을 실행하면, Then 기존 데이터·동작·최소 권한과 현재 attempt만 결과를 확정하는 경계가 유지된다.

## Implementation Notes

- 복구 Quick 리뷰의 medium 1건을 반영했다. 항목 실패를 내구성 있게 저장한 뒤 중단돼도 현재 attempt의 영구 오류·429 대기를 복구 정산에 보존한다. DB fence는 현재 work·token과 동일한 항목 결과의 필드 전체를 비교하며 stale token·이전 실패 재사용을 거부한다. 기존 0017~0019 migration은 그대로다.

- 복구 후 지휘자 Verify: `pnpm build`, `pnpm typecheck`, 계획 표적 명령(13개 파일 136개), `bash _bmad/custom/bmad-loop-verify.sh`(154개 파일 3793개 통과·기존 1개 skipped)가 모두 exit 0이다. 원본 로그는 `/tmp/bmad154d2-build.log`, `/tmp/bmad154d2-typecheck.log`, `/tmp/bmad154d2-targeted.log`, `/tmp/bmad154d2-full.log`다. 행렬의 모든 행에 실행·통과한 표적 시험을 대응했고 행렬 담당 skipped 시험은 없다.

- 2026-10-31 검증 복구: `doctor-run.test.ts`의 연결 불가 시험에서 실제로 사용하지 않는 정상 PG·self-user 준비를 제거했다. 격리 홈의 설정·shim과 연결 불가 URL로 동일한 종료 코드·DB_UNAVAILABLE·로컬 DB 파일 미생성을 검증한다. 피드백의 연결 시간 초과는 이 불필요한 준비 경계에서 발생했으며 원래 연결 시간 예산이나 제품 발신 동작은 변경하지 않았다. doctor 13개와 계획 표적 136개 시험, 빌드·타입 검사가 통과했다.

- 1단계: 기존 텍스트 입력을 유지한 `ChannelBundle`·항목 결과 계약, 현재 attempt token으로만 확정하는 PG·fake 저장, `0020_channel_bundle.sql`을 추가했다. 기존 마이그레이션은 수정하지 않았다. 지휘자가 공유 계약·발신·권한·마이그레이션 표적 명령을 직접 실행해 6개 파일 41개 시험 통과를 확인했다. 원본 로그는 `/tmp/bmad154-phase1-tests.log`다.

- 2단계: Telegram multipart와 배열 응답 ID를 추가하고, 감독자가 설정의 `filesPath`를 Node worker의 기존 localFileStore에 연결한다. 실제 PG·감독자·Node worker·가짜 HTTP 서버로 순서·재시작·바이트·가림·포함 경계·초과·위치 거부를 확인했다.
- 지휘자 Verify: `pnpm build`·`pnpm typecheck` 성공, 계획의 표적 명령 13개 파일 131개 통과, `bash _bmad/custom/bmad-loop-verify.sh` 154개 파일 3788개 통과·기존 1개 skipped, 모두 exit 0. 원본 로그는 `/tmp/bmad154-build.log`, `/tmp/bmad154-typecheck.log`, `/tmp/bmad154-targeted.log`, `/tmp/bmad154-full.log`다.
- 행렬 감사: 정상 순서·바이트·가림·원문·ID, 둘째 앨범 단절 후 재시작, UTF-16 4096/4097, 앨범 0/1/2/10/11, 사진 10MiB 및 +1·문서 50MiB 및 +1, 위치 거부는 `apps/cli/test/channels-bundle.test.ts`의 동명 실행 시험으로 전부 통과했다. 저장·권한 행은 공유 channel-store·기존 tracer/retry·extension-permissions·v19 migration 시험으로 통과했다. 행렬을 담당하는 skipped 시험은 없다.

- 리뷰 반영: 일시적 FileStore 장애의 재시도, 전체 sent 뒤 재시작 시 마지막 ID 복원, 마지막 허용 시도에서의 성공 정산을 보완했다. 관련 시험은 `/tmp/channel-review-tests.log`에서 6개 파일 66개 통과했다. 현재 token과 전체 sent 증거를 확인하는 DB fence 및 실제 worker 강제 종료 회귀 시험을 함께 검토했다.

## Plan Change Log

- 2026-10-31 감독자 복구: 실패 Dispatch 정식 종료·release·ack와 소스 미변경을 보존한다. PyPI jinja2 주소 HTTP 200 및 Docker 응답을 확인했다. 새 엔진 generation에서 재귀 build/review workflow를 실행하지 않는 구현 워커에게 1단계만 먼저 배정하고 phase-ready와 표적 검증을 확인한 뒤 2단계를 배정한다. 같은 Task 재시도 제어 제한이 재발하면 정확한 상태를 보존해 별도 복구한다. 전체 계약·검증은 유지한다.

## Review Triage Log

### 2026-10-31 — 복구 Quick 리뷰
- verdicts: 1 findings — high 0, medium 1, low 0, false 0, maybe-false 0
- findings:
  - `[medium]` `[patch]` `packages/postgres/src/channels.ts:175`에서 항목 실패를 저장한 직후 중단되면 영구 오류·429 대기가 일반 INTERRUPTED로 바뀐다 — `send.ts`의 항목 저장과 전체 확정 사이 중단 경계 및 supervisor가 복구 결과로 재시도 시각·종료를 결정하는 경로를 확인했다. 현재 attempt의 실패를 기존 복구 집계에 반영하고 DB fence에서 work·token·결과 필드의 일치를 확인하도록 수정했다. fake·PG 공유 계약과 실제 worker 종료 시험이 영구 종료·429 대기·이전 실패 재사용 거부를 확인한다. 공개 계약과 고정 의도는 변경하지 않았다.

### 2026-10-31 — Review pass
- verdicts: 3 findings — high 0, medium 3, low 0, false 0, maybe-false 0
- findings:
  - `[medium]` `[patch]` `packages/core/src/channels/send.ts:53`의 파일 저장소 일시 장애가 영구 실패로 끝난다 — localFileStore의 `FILES_UNAVAILABLE`와 감독자의 `retryable` 종료 경로를 확인했다. 해당 코드만 재시도 가능으로 바꾸고 위치 거부·파일 부재는 유지했다. 저장소 복구 뒤 요약 중복 없이 나머지를 보내는 시험이 통과했다.
  - `[medium]` `[patch]` `packages/core/src/channels/send.ts:35`의 전체 항목 저장 뒤 중단 경로에서 마지막 응답 ID가 null이 된다 — sent 항목을 건너뛸 때 초기 결과를 유지하던 코드와 PG의 전체 결과 저장을 확인했다. 저장된 항목 결과를 복원하는 직접 수정으로 마지막 ID를 유지하며 추가 HTTP 없는 재시도 시험이 통과했다. 다음 항목과 원인이 같아 하나의 수정 묶음이다.
  - `[medium]` `[patch]` `packages/core/src/channels/send.ts:68` 이후 최종 허용 시도 종료 시 내구성 있는 전체 성공을 정산하지 못한다 — PG recover의 `INTERRUPTED`와 supervisor의 시도 예산 종료 경로를 확인했다. 기존 내부 recover와 fake에서 예상 항목 전체의 sent를 읽어 실제 마지막 ID로 요청·시도를 성공 정산한다. `0020`의 fence는 현재 work/token·unknown 상태·전체 성공 증거·ID 일치를 확인하며 이전 migration은 보존한다. 공유 저장 계약과 실제 마지막 worker 강제 종료 시험이 통과했다.
- 분류 근거: 첫 묶음은 retryable 값의 직접 수정이다. 둘째 묶음은 이미 입증된 전체 sent 상태를 기존 내부 정산에 반영하는 지역 집계·분기이며 공개 계약을 추가하지 않으므로 patch로 처리했다. 계획·의도를 바꿀 필요가 없고 defer·reject는 없다.
- 부가 정리: `packages/postgres/src/channels.ts`의 줄 끝 공백을 구현자가 제거했다.

## Design Notes

요청 전체 attempt와 항목별 외부 결과는 다른 사실이다. 각 HTTP 성공 직후 항목 결과를 현재 token으로 확정하고 다음 항목으로 이동한다. 저장 전 crash는 unknown으로 재시도할 수 있으나 저장된 sent는 유지한다. 작은 비보안 공백만 [ASSUMPTION] 코드 주석·계획·deferred로 명시한다. 보안·마이그레이션 안전성은 추정하지 않는다.

## Verification

- `pnpm build`와 `pnpm typecheck` — 전체 성공.
- `pnpm exec vitest run --project core --project postgres --project cli channel-store channel-send channels-bundle channels-tracer channels-retry extension-permissions attempt-fence migrate schema --reporter verbose` — HTTP 행렬·저장·권한·기존 발신 회귀의 모든 실행 시험 통과. 새 통합 시험은 위 AC와 행렬을 시험 이름에 반영한다.
- `bash _bmad/custom/bmad-loop-verify.sh` — 전체 필수 검증 성공.

Docker/OrbStack의 전용 PG·격리 DB·임시 홈과 가짜 서버만 사용한다. fixture의 close로 데몬·자식·서버·DB 연결 종료를 기다리고 임시 홈·DB·role을 정리한다. 외부 운영자 작업은 없다.

## Auto Run Result

- Status: built
- 티켓 15.4의 순서 발신·항목별 내구성·재개 구현을 유지하고 결정적 검증 실패를 복구했다. doctor의 연결 불가 시험은 정상 PG 준비 없이 동일한 실패·파일 미생성 관찰을 수행한다. 항목 실패 저장 직후 worker가 종료돼도 현재 attempt의 영구 오류·429 대기를 보존한다. 고정 의도 계약과 baseline은 변경하지 않았다.
- 이번 복구 변경: `apps/cli/test/doctor-run.test.ts`는 불필요한 정상 DB 준비를 제거한다. `packages/postgres/src/channels.ts`는 현재 시도 항목 실패를 복구한다. `packages/postgres/migrations/0020_channel_bundle.sql`은 증거와 일치하는 결과에만 복구 정산을 허용한다. `packages/core/src/testing/fakes/store.ts`는 항목 token과 실패 복구를 맞춘다. `packages/core/src/testing/contracts/channel-store.ts`는 실패·지연 보존과 stale token·이전 실패 재사용 거부를 검증한다. `apps/cli/test/channels-retry.test.ts`는 실제 worker 종료 후 영구 실패·429 대기를 검증한다. 이 계획에는 복구·리뷰·검증 근거를 기록한다.
- 이전 구현 보존: `packages/core/src/channels/{store,send}.ts`는 묶음 계약·순차 발신·항목별 결과를 제공하고 `packages/core/test/channel-send.test.ts`가 재개를 검증한다. `apps/cli/src/adapters/telegram.ts`는 multipart와 실제 응답 ID, `apps/cli/src/daemon/supervisor.ts`·`workers/channel-send.ts`는 FileStore 조립, `apps/cli/test/channel-fixture.ts`·`channels-bundle.test.ts`는 가짜 HTTP 행렬을 담당한다. `packages/postgres/src/{extension-provision,migrate}.ts`와 관련 권한·마이그레이션·schema·store 시험은 v20 및 기존 호환성을 검증한다. `doctor/store.ts`·`dispatch.test.ts`·`unavailable.test.ts`는 저장 대역 계약, `install.test.ts`·`setup.test.ts`·`work-store.test.ts`는 새 버전에 맞춘 회귀다.
- 이번 Quick 리뷰: 총 1건 medium을 patch 1건으로 수정했다. high 0·low 0·defer 0·reject 0이며 이전 리뷰 기록은 보존한다. `followup_review_recommended: false`: 이번 pass의 patch는 medium 1건이고 고위험 patch가 없다.
- 최종 검증: `pnpm build`와 `pnpm typecheck` exit 0. 계획 표적 명령은 13개 파일 142개 시험 통과. `bash _bmad/custom/bmad-loop-verify.sh`는 exit 0, 154개 파일 3799개 통과·기존 1개 skipped다. 원본 로그는 `/tmp/bmad154d2-final-build.log`, `/tmp/bmad154d2-final-typecheck.log`, `/tmp/bmad154d2-final-targeted.log`, `/tmp/bmad154d2-final-full.log`다. 행렬 7개 행의 담당 시험이 모두 실제 실행·통과했으며 담당 skipped 시험은 없다.
- 잔여 위험: 원래 계약이 수용한 접수 후 결과 저장 전 중단의 중복 가능성은 남는다. 이번 티켓에는 외부 운영자 작업이 없다. 실계정 발신·배포·push·tickets.py mark·티켓 done 처리는 하지 않았다. 완료 판정은 오케스트레이터의 독립 검증에 맡긴다.
- 정리: 자기 Orca Run `run_c19edb12d119`의 구현·Quick 리뷰 Dispatch는 모두 정식 succeeded를 수락한 뒤 release했다. worker-list는 released 2개·reclaimable 0개이며 inbox는 count 0·pending delivery null이다. 활성·소유권 미확인 워커·취소할 과업과 미해결 판단은 없다. transcript source_changed 관측은 보존했고 이후 정식 완료 및 restore로 종료·소유권을 확인했다. HALT 체크포인트를 남기고 자기 전용 제어 셸을 마지막에 닫는다.
