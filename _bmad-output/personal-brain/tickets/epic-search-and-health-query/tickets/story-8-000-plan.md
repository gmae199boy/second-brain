---
title: '17.3 대화·도구 검색과 출처 기반 원문 읽기'
type: 'feature'
ticket: '3'
created: '2026-10-30'
status: done
baseline_revision: '8d7bd2d6474fe80eb0ed4808e6b53da3a095f0ad'
route: 'full'
route_source: 'pinned'
risk: 'medium'
review: 'quick'
review_source: 'pinned'
lenses_ran: [quick]
review_loop_iteration: 3
followup_review_recommended: true
context: []
warnings: [oversized]
deferred:
  - summary: '검토 필요: [ASSUMPTION] 고아 메모가 나중에 새 메시지에 연결돼 기존 출력 여부를 고정 크기 경계로 판별할 수 없으면 그 메시지의 현재 메모를 재출력하고 hint로 알린다. 누락을 피하며 정적 페이지는 무중복이다.'
  - summary: '검토 필요: [ASSUMPTION] 관련도는 literal 일치 횟수 내림차순·동점은 시각/id이며 근접 입력은 명시적 worktree/project 식별자다.'
  - summary: '검토 필요: [ASSUMPTION] budget은 가린 data JSON 코드 포인트 길이로 보수적으로 세고 검색 next는 생략·절단 출처의 sessions read다.'
  - summary: '검토 필요: [ASSUMPTION] 공개 use case는 전체 봉투/next 공간으로 1,000자를 예약해 data를 7,000자로 제한한다.'
  - summary: '검토 필요: [ASSUMPTION] expand 기본 앞뒤 2개·최대 100개, sessions read 기본 메시지 50개·최대 200개와 안정 커서를 쓴다.'
  - summary: >-
      검토 필요: [ASSUMPTION] 페이지 사이 고아 메모 구성원이 바뀌면 현재 고아 목록을 처음부터 재표시하고 hint로 알린다. 메시지 진행은 보존하며 정적 페이지는 무중복이다.
---

<intent-contract>

## Intent

**Problem:** 17.2의 조각 생성·최소 LIKE port만으로는 공개 검색과 출처 기반 원문 조회가 불가능하다.

**Approach:** Core 공통 질의와 출력 코덱을 재사용해 chunks/tools 검색, 공통 budget, expand와 sessions read를 SDK·CLI 1:1로 제공한다.

## Boundaries & Constraints

**Always:** 결과는 conversation 출처(session 토큰·harness·날짜·꼬리표·from_at/to_at·실제 chunk_id)를 가진다. 도구 결과에는 실제 tool_note_id/연결 메시지를 쓰고 chunk_id를 지어내지 않는다. 같은 worktree→같은 project→전체 다음 관련도·안정 동점 순이다. 기본 5건과 limit+1 has_more다. 원문으로 검색하고 도구 target 전용 가리기→일반 가리기→budget 순서다. 총 8,000자 이내이며 하위 행부터 통째로 제거하되 1위를 남기고 마지막에만 그 본문을 자른다. 잘리면 RESULT_TRUNCATED·meta.omitted·유효한 meta.next를 낸다. 0건은 data: []·count:0·hint다. 질의 오류·잠금 초과는 SEARCH_FAILED로, 미설정/연결 불가와 구별한다. expand는 session과 양끝 포함 시각으로 실제 메시지를 읽어 (occurred_at, 안정 id) 정렬·중복 제거하며 조각 재생성 후에도 같은 구간을 읽는다. 세션 원문·도구 메모는 페이지로 가려 읽는다.

**Never:** 문서/files show·건강·확장 상태·스킬·count·로그·rebuild·임베딩은 구현하지 않는다. 기존 migration/색인/조각 경계·경합 보호를 바꾸지 않는다. 운영 자료/홈을 쓰지 않는다. 구현자는 커밋·계획 상태·티켓 완료를 변경하지 않는다. push·tickets.py mark·done 표시는 하지 않는다.

## I/O & Edge-Case Matrix

| 상황 | 입력 / 상태 | 기대 동작 | 오류 처리 |
|---|---|---|---|
| 검색·정렬 | 한국어 두 글자, 세 근접 단계, 관련도·동점 | 손으로 정한 순서·완전한 출처 | %, _, 역슬래시·NUL도 공통 literal 질의 |
| 기본 페이지 | 0, 5, 6개 이상 적중 | 빈 배열+hint, 5개+false, 5개+true와 count | 실패와 0건 구별 |
| 상한 | 8,000 경계, 하위 행 초과, 1위 단독 초과, 이모지·가림 후 증가 | 가린 결과 상한·하위 행 우선 제거·1위 보존·최후 본문 절단·omitted/next | 출처·가림 표식 보존 |
| 도구 검색 | Bash NAME=value, 긴 target, NUL | 전용 가리기 후 출력·원문 저장 보존 | 고아 메모도 세션 읽기에서 보존 |
| 확장 | 겹치는 구간·동시각·앞뒤 N, 재조각 | 실제 메시지 안정 정렬·id 중복 제거·재생성 전후 같은 구간 | 잘못된 시각/범위/개수 INVALID_ARGUMENT |
| 세션 페이지 | 다페이지 메시지·메모·동시각·긴 본문 | next로 누락/중복 없이 진행·가림 유지 | 없는 세션 SESSION_NOT_FOUND |
| DB 실패 | 질의 오류·chunks/tool_notes ACCESS EXCLUSIVE 잠금 | SEARCH_FAILED, 성공 빈 배열과 구별 | 연결 자체 실패 DB_UNAVAILABLE 유지 |

</intent-contract>

## Code Map

- `packages/core/src/recall/text-query.ts` literalLikePattern은 NUL→U+FFFD·escape를 제공한다. 모든 텍스트 검색이 공유한다.
- `packages/core/src/ports/conversation-index-store.ts`, `packages/postgres/src/conversation-index.ts`: 기존 snapshot/commit/minimal search는 17.2다. 공개 메타·정렬·도구 검색은 recall capability로 더하고 기존 처리를 보존한다.
- 신규 `packages/core/src/ports/recall-store.ts`, `ports/store.ts`, `testing/fakes/store.ts`, `packages/postgres/src/store.ts`: capability·fake·adapter 구성 지점이다.
- `packages/core/src/ports/store.ts` SessionContents/readSession, `packages/postgres/src/sessions.ts:518`: 기존 전체 읽기는 동시각 미정이다. 새 읽기 경로는 안정 id와 일관 snapshot을 보장하고 수집은 보존한다.
- `packages/core/src/domain/session-token.ts` formatSessionToken/parseSessionToken과 `domain/session.ts` 태그를 쓴다. 내부 UUID로 외부 session을 대체하지 않는다.
- `packages/core/src/output/mask.ts` toolNoteForOutput/sessionForOutput 후 maskOutputValue, `envelope.ts` count/has_more/omitted/next/hint, `codes.ts` RESULT_TRUNCATED/SEARCH_FAILED를 재사용한다.
- 신규 `packages/core/src/recall/results.ts`, `search.ts`, `expand.ts`, `packages/core/src/sessions/read.ts`: 공통 budget과 use case 위치다. `brain.ts`, `index.ts`, `packages/second_brain/src/index.ts`에 recall.chunks/tools/expand와 sessions.read를 노출한다.
- `packages/postgres/src/text.ts` pgText/originalText로 검색 투영·원문을 보존한다. 도구 join은 harness_message_id_raw도 비교한다. 현재 0014 대화 config를 검색하고 미래 활성 전환은 rebuild에 맡긴다.
- `apps/cli/src/commands/index.ts`, 신규 `recall-chunks.ts`, `recall-tools.ts`, `recall-expand.ts`, `sessions-read.ts`: CommandSpec 메타/입력/예제와 SDK 호출만 둔다. dispatch finish의 최종 봉투·텍스트 codec을 유지한다.
- `packages/postgres/test/conversation-fixture.ts`, `apps/cli/test/pg-home.ts`, `temp-home.ts`: 합성 격리 DB/home 재사용. conversation-index.test의 실제 잠금 대기 관측, CLI command-meta/guide/output-codecs 회귀를 보존한다.

## Tasks & Acceptance

**Execution:**

- [x] `packages/core/src/ports/recall-store.ts`, `recall/results.ts`, `recall/search.ts`, `recall/expand.ts`, `sessions/read.ts`에 공개 읽기·공통 budget을 구현하고 Store/fake를 맞춘다.
- [x] `packages/postgres/src/recall.ts`, `store.ts`에 출처·정렬·limit+1·안정 원문 읽기를 연결한다.
- [x] `packages/core/src/brain.ts`, 공개 exports와 CLI 네 CommandSpec·등록부를 맞춘다.
- [x] `packages/core/test/recall-budget.test.ts`, `packages/postgres/test/recall.test.ts`, `apps/cli/test/recall.test.ts`에 행렬·CLI 시험을 추가하고 전체 검증한다.

**Acceptance Criteria:**

- Given 합성 다세션과 한국어 두 글자, When 실제 CLI recall chunks를 실행하면, Then 근접/관련도 순서와 출처가 수작업 기대와 같고 6건 이상 중 기본 5건+has_more를 반환한다.
- Given 긴 결과, When CLI JSON/text를 출력하면, Then 가림 뒤 결과가 8,000자 이하이며 하위 생략·1위 최후 절단·경고/omitted/next를 확인하고 next가 원문을 읽는다.
- Given 빈 DB와 질의/잠금 실패 장치, When CLI/SDK 검색하면, Then 빈 배열+hint와 SEARCH_FAILED가 구별된다.
- Given 검색 출처와 겹치는 시각 구간, When CLI expand를 실행하고 재조각 뒤 다시 실행하면, Then 같은 메시지 집합·안정 순서·중복 없음을 확인한다.
- Given 다페이지 동시각 메시지·도구 메모, When sessions read의 next를 끝까지 호출하면, Then 누락/중복 없이 읽히고 NAME=value·긴 target 비밀이 JSON/text에 남지 않는다.
- Given 네 명령, When guide schema와 SDK/CLI를 호출하면, Then 입력·출력·오류·읽기 메타가 1:1이다.

## Implementation Notes

- 최종 패치 검증: 지휘자가 pnpm build·pnpm typecheck, Core/PG/CLI 127파일·3,284개 성공, 기본 결정적 검증 139파일·3,603개 성공·기존 skip 1개를 확인했다. 텍스트 출처의 실제 expand·고아 --note 읽기와 긴 보류/형제/별도 고아 조합을 포함하며 신규 회귀는 전부 실행됐다. 최종 diff와 git diff --cached --check를 확인했고 intent-contract는 최초 복원본과 동일하다.

- 재도출 결정적 검증: 지휘자가 bash _bmad/custom/bmad-loop-verify.sh를 기본 설정으로 실행해 종료 코드 0, 빌드·타입 검사와 139파일·3,603개 성공·기존 skip 1개를 확인했다. 신규 38개 recall 회귀를 포함한 행렬에는 skip이 없고 yaml 파싱에서 기존 이월 5개와 새 구성원 변화 가정 1개가 한 deferred 목록에 보존됨을 확인했다.

- 재개 리뷰 수정 검증: 연결 메모 시작 경계·고아 구성원 지문·연결 보류와 실제 고아 스캔 경계 분리를 구현했다. 지휘자가 추가 diff를 직접 읽고 pnpm build·pnpm typecheck 및 Core/PG/CLI 127파일·3,284개 성공을 확인했다. 이전 준비 timeout은 무관 코드 변경 없이 재실행에서 발생하지 않았다.

- 재도출 조합 검증: 127파일 실행에서 새 회귀는 통과했으나 기존 PG store.test.ts의 beforeAll 준비가 60초 timeout으로 실패했다(3,282개 성공, 실패 1개). timeout/무관 코드는 바꾸지 않는다. 별도 직접 호출은 O20이 연결되는 동시에 O10이 새로 추가되고 긴 O20이 여러 페이지로 나뉘면 M2/O20만 반환하고 종료해 O10 누락을 재현했다. 같은 설계의 연결 보류 위치와 현재 고아 스캔 경계를 분리하는 보완을 구현자에게 맡긴다.

- 재개 결정적 검증: bash _bmad/custom/bmad-loop-verify.sh가 종료 코드 0으로 빌드·타입 검사와 139파일·3,597개 성공·기존 skip 1개를 기록했다. 신규 행렬·세 리뷰 패치 회귀에는 skip이 없으며 가린 뒤 출력 길이·실제 CLI 다음 호출·PG 잠금·재조각 복원·세션 페이지 시험을 모두 포함한다.

- 재개 지휘자 검증: pnpm build·pnpm typecheck 및 기본 Core/PG/CLI 127파일·3,278개가 모두 통과했다. 복원한 소스 diff와 실제 행렬 시험을 직접 읽었고 전체 결정적 검증을 이어 실행한다.

- 재개: 이전 활성 구현 Dispatch와 검토된 전체 patch를 확인했다. 기준 리비전과 동결된 intent-contract를 보존하고 최신 소스·회귀를 복원한 뒤 지휘자가 diff·전체 검증·독립 리뷰를 다시 확인한다. 이전 임시 로그만으로 완료를 판정하지 않는다.

- 두 번째 재도출 최종 검증: 지휘자가 pnpm build·pnpm typecheck, 기본 Core/PG/CLI 127파일·3,273개, 기본 결정적 전체 139파일·3,592개 성공·기존 skip 1개를 확인했다. 신규 행렬/리뷰 회귀에는 skip이 없다. git diff --cached --check도 통과했다.
- 최종 CLI는 설정 경고 병합 뒤 JSON/text와 stderr 길이를 확인하며 초과 성공 대신 짧은 INVALID_ARGUMENT와 중복 제거한 경고 코드를 반환한다. 임시 홈 변수는 SECOND_BRAIN_HOME으로 고쳐 실제 격리 설정을 사용했다. 초기 잘못된 변수로 기본 설정을 읽었을 가능성은 있으나 DB는 계속 격리 fixture였고 네 명령은 drain:false였다. 운영 자료 변경 증거는 없다.
- 커서는 메시지 경계와 고아 메모 경계/부분 본문 위치를 고정 크기로 보존한다. PG에서 고아 1/2개 앞 append·긴 연결 본문/부분 고아 재개·동적 연결·작은 id 새 메모·220개 고아의 무중복/누락 없음과 커서 1,200자 미만을 시험했다. CLI에서도 next로 새 메시지/메모와 남은 고아를 확인했다.

- 두 번째 재도출의 결정 공백: 동적 고아→연결 전환에서 이전 고아와 새 연결 메모의 id 순서는 도착 순서가 아니므로 고정 크기 경계만으로 전부 구별할 수 없다. 별도 영속 이력/새 스키마나 id 시간순 가정을 만들지 않는다. [ASSUMPTION] 판별이 모호한 새 메시지의 현재 메모는 누락을 피하기 위해 재출력하고 hint로 알린다. 메시지/메모가 변하지 않은 페이지에는 여전히 중복이 없고, 뒤쪽 메시지·고아로 진행한다. 무한 id 누적은 금지한다.

- 재도출 최종 지휘자 검증: 기본 명령 bash _bmad/custom/bmad-loop-verify.sh가 종료 코드 0으로 139파일·3,587개 성공·기존 skip 1개를 기록했다. Core/PG/CLI 독립 실행은 127파일·3,268개 성공이다. 낮은 동시 실행 수에서도 이전 fixture 연결 timeout이 관찰됐고 특정 동시 실행 수가 근본 해결이라고 단정하지 않는다. 최종 기본 전체 실행은 소스 변경 없이 통과했다. 행렬의 신규/보강 시험은 모두 실행됐고 해당 시험에는 skip이 없다.

- 리뷰 재도출: 구현자가 소스/시험을 임시 patch에 저장하고 baseline으로 되돌린 뒤 KEEP를 복원해 네 지적을 수정했다. 고정 7,000자/1,000자 예약과 원시 출처 256자 제한은 폐기했고, 가린 전체 봉투·텍스트·next를 반복 계수한다. 이전 deferred의 예약 가정은 이 변경으로 대체됐으며 이력 보존 때문에 원래 항목은 유지한다.
- 원문 커서는 세션과 가린 본문 SHA-256 지문을 포함한다. 페이지 사이 본문 변경은 같은 행의 현재 안전한 본문 처음부터 다시 읽고 hint로 알린다. 변경 없는 경우의 무손실 진행, 고아 메모, 실제 PG manual redact와 뒤 메시지 진행을 회귀로 확인했다.
- 텍스트에서도 has_more/omitted/next를 출력하고 기존 retryArgv·quoting으로 다음 읽기를 실행한다. 가림으로 달라지는 출처나 next는 실행 불가능한 식별자를 출력하는 대신 INVALID_ARGUMENT다. 실제 설치된 pg의 code 없는 연결 timeout/비정상 소켓 종료는 DB_UNAVAILABLE로 검증했다.
- 재도출 검증: 구현자는 Core/PG/CLI 3,268개 및 전체 3,587개 성공·기존 skip 1개를 보고했다. 지휘자는 빌드/타입을 통과하고 기본 병렬 실행에서 기존 PG fixture의 연결 timeout 한 건을 관찰했다. 같은 세 프로젝트를 VITEST_MAX_WORKERS=2로 독립 재실행해 127파일 3,268개를 모두 통과했다. 전체 검증에서도 기존 dispatcher fixture의 연결 timeout 한 건이 있어 단일 워커로 동일 전체 명령을 재확인한다. 시험/timeout/무관 코드는 바꾸지 않았다.

- 구현: Core 공개 검색·결과 budget·expand·sessions read, PG literal 검색·출처/정렬·limit+1, 네 CLI/SDK와 메타·오류 코드·fake를 연결했다. 전체 결과 봉투의 공간을 남기기 위해 공개 use case는 가린 data에 7,000자 보수적 예산을 쓰고 공통 함수 기본 상한은 8,000자다. 세션 출처 입력 길이를 제한하며 저장 원문은 보존한다.
- 지휘자 검증: pnpm build 및 pnpm typecheck 성공, Core/PG/CLI 127파일 3,264개 성공, 결정적 검증 139파일 3,583개 성공·기존 무관 skip 1개. 뒤의 변경은 가정 주석과 CLI 시험 보완이며 해당 CLI 3개를 지휘자가 재실행해 통과했다. git diff --cached --check도 성공했다.
- 행렬 감사: 검색/정렬·literal/NUL은 PG recall 8개 및 CLI 순서 시험, 0/5/6건은 CLI 빈 검색·정확히 다섯 건·여섯 건 시험, 상한/이모지/가림 증가는 Core budget 5개 및 CLI 긴 JSON/text, 도구 가림·고아 메모는 Core read 3개/PG 페이지/CLI 페이지, 확장·동시각·재조각은 PG 구간/CLI expand, DB 실패는 PG chunks/tools 실제 잠금 대기·질의 오류와 unavailable 계약이다. 해당 시험은 모두 실행됐고 skip이 없다.
- 잠금 시험: 별도 pg.Client가 ACCESS EXCLUSIVE를 보유하고 검색 reader는 lockTimeoutMs 100·queryTimeoutMs 2000을 사용했다. pg_stat_activity에서 Lock 대기를 관찰했고 SEARCH_FAILED를 확인했다. finally에서 rollback/end·reader.close·격리 fixture.close를 수행했다.
- 전체 검증의 구현자 실행에서 기존 서로 다른 시험의 시간 초과/종료 코드 불일치가 관찰됐으나 무관 코드·timeout은 바꾸지 않았다. 지휘자의 독립 전체 검증은 기본 명령 그대로 성공했다.

- 첫 구현 시도는 budget 초안과 4개 시험·Core 빌드만 완료하고 공개 경로 통합 전에 미완료 실패를 정식 보고했다. 같은 Task·모델로 재시도한다. 기존 초안을 확인하고 작은 구현·시험을 쌓아 전체 범위를 완수한다. 임의 시간 한도나 단순 미검증을 수행 불가로 취급하지 말고 구체적인 설계 질문은 활성 Dispatch의 ask로 보고한다.

## Plan Change Log

### 2026-10-30 — 고아 구성원 변화와 메모 시작 경계

독립 재개 리뷰의 두 재현을 확인했다. 고아 id 경계만으로 뒤늦은 작은 id를 찾을 수 없으므로 고아 목록의 구성원 변화를 식별하고 보수적으로 재탐색하도록 Design Notes를 보강했다. 연결 메모부터 시작할 때 미소비 소유 메시지를 소비한 것으로 표시하지 않는다. 동결된 intent-contract는 보존한다.

KEEP: 앞선 KEEP 전부, 마지막 세 패치(연결 메모 형제 진행·상위 limit 출처 검사·DNS/네트워크 DB_UNAVAILABLE), 가림 후 최종 봉투/텍스트 상한, 설정 경고 제한, 고정 크기 커서, 본문 fingerprint 재시작, 정적 페이지 무누락/무중복, 동적 연결 안내, 순서/출처/실제 잠금/재조각 복원과 기존 3,597개 성공 근거를 보존한다. 현재 티켓 소스·시험만 임시 patch에 보관하고 baseline 복원 뒤 KEEP를 재적용해 재도출한다. 계획·티켓·다른 작업과 staging은 보존한다.


### 2026-10-30 — 설정 경고 병합과 고아 메모 앞의 새 메시지

두 번째 리뷰에서 Core 이후 병합되는 설정 경고와 고아 메모 커서 재배치가 빠졌음을 확인했다. CLI 최종 출력 경계에서 추가 경고를 포함해 확인하고, 메시지 high-water와 고아 메모 재개 위치를 별도로 보존하는 설계를 아래에 더했다. 고정 소스 diff를 임시 patch에 저장·baseline 복원 후 KEEP를 재적용해 재도출한다.

KEEP: 앞선 변경 로그의 KEEP 전부와 동적 전체 봉투 계수·가림으로 바뀐 다음 호출 거부·텍스트 next/메타·세션/가린 본문 fingerprint 커서·manual redact 재시작·연결 오류 분류를 보존한다. 새 회귀를 포함한 3,587개 성공 근거를 잃지 않는다. 이전 지적을 다시 만들지 않는다.

### 2026-10-30 — 최종 출력 계수와 변경된 본문 커서

독립 리뷰의 최종 봉투 길이 초과와 페이지 사이 redact 중단을 확인했다. 고정 7,000자 data 예산만으로 최종 출력 상한을 보장하던 설계를 최종 가림 메타/렌더링을 포함한 계수로 바꾸고, 커서의 본문 세대 감지와 보수적인 재시작 규칙을 아래에 명시했다. 텍스트 메타 누락과 연결 실패 오분류도 함께 고친다.

KEEP: 기존 literalLikePattern·현재 config 검색·세 근접 단계/관련도·원문 저장과 target 전용 가리기 순서·limit+1 has_more·실제 출처·안정 메시지 정렬/겹침 제거·repeatable read snapshot·고아 메모 보존·재조각 복원·공통 하위 행 생략/1위 최후 절단·모든 기존 3,583개 시험과 CLI 확장/페이지/메타 보완 시험을 보존한다. 기존 migration·조각 생성·수집 경합 보호는 변경하지 않는다. 현재 티켓 소스 변경만 임시 patch에 저장하고 baseline으로 되돌린 후 수정된 설계로 재도출하며 계획/다른 작업은 보존한다.

## Review Triage Log

### 2026-10-30 — 재도출 독립 리뷰의 최소 수정

- verdicts: 2 findings — high 0, medium 2, low 0, false 0, maybe-false 0
- findings:
  - `[medium]` `[patch]` 연결 보류 뒤 형제 메모와 고아 조합의 중단 — 지휘자가 M1/O20 뒤 M2·긴 형제 N·고아 O10을 추가해 4번째 호출의 INVALID_ARGUMENT를 직접 재현했다. 기존 linkedResume 플래그가 다음 메모와 high의 소유자 일치를 반영하도록 한 줄 수정하고 PG 조합 회귀를 보강했다.
  - `[medium]` `[patch]` 텍스트 검색의 완전한 출처 누락 — 두 CommandSpec의 renderer가 session/from_at/body만 쓰고 to_at·실제 id·태그 등을 버림을 확인했다. 기존 결과의 모든 출처를 보존하는 공통 텍스트 renderer로 CLI와 budget 계수를 맞췄고 text 출처만으로 실제 expand·고아 note 읽기 회귀를 추가했다.


### 2026-10-30 — 재개 독립 리뷰

- verdicts: 2 findings — high 0, medium 2, low 0, false 0, maybe-false 0
- findings:
  - `[medium]` `[patch]` 연결 메모부터 읽은 다음 커서 중단 — 지휘자가 정적 세션의 긴 연결 메모 N과 고아 O로 직접 호출해 첫 페이지 성공·다음 INVALID_ARGUMENT를 재현했다. 시작 메모의 아직 소비하지 않은 소유 메시지를 high 경계에 넣지 않는 수정과 긴 단일/형제 메모 회귀를 재도출에 포함한다.
  - `[medium]` `[bad_plan]` 작은 id로 추가된 고아 메모 누락 — 지휘자가 M/O20 첫 페이지 뒤 O10을 추가하자 다음이 O20만 반환하고 has_more:false임을 재현했다. id 도착 순서 가정 없이 고아 구성원 변화 시 재탐색·안내하는 설계를 보강한다.


### 2026-10-30 — 이전 세 번째 리뷰 판정 복원

- verdicts: 3 findings — high 0, medium 3, low 0, false 0, maybe-false 0
- findings:
  - `[medium]` `[patch]` 고아에서 연결된 메모 뒤 형제 메모 누락 — 이전 검토 diff의 read.ts가 메시지 high를 올리고 보류 메모만 예외 처리했다. 최종 복원본은 linkedResume으로 같은 소유자의 나머지 메모를 통과시키며 PG의 긴 연결 본문·보류 메모·형제 메모 회귀를 포함한다.
  - `[medium]` `[patch]` limit+1 확인용 여섯 번째 출처가 정상 다섯 건을 막음 — 이전 search.ts는 found.rows 전체를 검사했다. 복원본은 selected 상위 limit에만 출처 가림 검사를 적용하며 가려지는 여섯 번째 토큰의 Core 회귀를 포함한다.
  - `[medium]` `[patch]` DNS·네트워크 연결 실패 오분류 — EAI_AGAIN·ENETUNREACH·EHOSTUNREACH가 이전 분류에 없었다. 복원본은 DB_UNAVAILABLE 목록에 세 코드를 추가하고 각각의 결정적 회귀를 포함한다.


### 2026-10-30 — Review pass 2

- verdicts: 2 findings — high 0, medium 2, low 0, false 0, maybe-false 0
- findings:
  - `[medium]` `[bad_plan]` 설정 경고가 최종 상한 계수 뒤에 합쳐짐 — finish가 config warnings를 추가함을 확인했고 독립 호출로 CONFIG_UNKNOWN_KEY 한 개를 합친 봉투 8,021자를 재현했다. CLI의 실제 경고 병합 뒤 출력 경계까지 보장하도록 설계를 보강했다.
  - `[medium]` `[bad_plan]` 고아 메모 커서 앞에 append된 메시지가 누락됨 — M1/O 첫 페이지 뒤 M2 append를 넣은 독립 호출에서 두 번째 페이지가 O만 내고 has_more:false임을 재현했다. 고아 메모 진행과 메시지 진행을 별도로 추적해 새 메시지를 먼저 읽는 규칙을 보강했다.

### 2026-10-30 — Review pass 1

- verdicts: 4 findings — high 0, medium 4, low 0, false 0, maybe-false 0
- findings:
  - `[medium]` `[patch]` 텍스트 출력의 next/has_more/omitted 누락 — dispatch의 text 경로는 명령 text만 출력하고 메타를 보충하지 않음을 확인했다. 일반 페이지의 커서를 사람이 받을 수 없다. 재도출에 텍스트 메타 렌더링과 실제 호출 회귀를 포함한다.
  - `[medium]` `[patch]` 코드 없는 연결 오류 오분류 — 설치된 pg-pool의 연결/풀 timeout 및 pg client 비정상 종료가 code 없는 Error를 만들고 현재 catch가 SEARCH_FAILED로 분류함을 확인했다. 연결 실패를 DB_UNAVAILABLE로 유지하는 작은 분류 수정을 재도출에 포함한다.
  - `[medium]` `[bad_plan]` 페이지 사이 redact가 오래된 문자 offset을 무효화함 — read.ts는 offset이 현재 본문 길이를 넘으면 실패하고 기존 redact는 본문을 짧은 표식으로 치환한다. 현재 페이지 상태의 변화 식별과 안전한 진행 규칙을 Design Notes에 보강했다.
  - `[medium]` `[bad_plan]` 고정 1,000자 예약이 가림 후 meta 증가를 담지 못함 — demo:와 token=a; 31개 출처로 직접 호출해 data 7,000자·최종 봉투 8,072자를 관찰했다. 최종 가린 메타·텍스트까지 계수하는 설계로 바꾸며 고정 예약만으로 상한을 주장하지 않는다.

## Design Notes

경로는 pinned full이다. 공개 CLI·SDK, Core 출력 계약과 PG 읽기가 함께 바뀌므로 한 계획에서 관찰 가능한 수락 기준과 통합 회귀를 검증한다.

[ASSUMPTION] 관련도는 대소문자 무시 literal 일치 횟수 내림차순·동점은 시각/id다. SDK와 CLI는 선택 worktree/project 식별자를 명시적으로 받으며 생략 시 전체 검색이다. cwd나 자연어를 추측하지 않는다.

[ASSUMPTION] budget은 가린 data 배열 JSON 직렬화의 코드 포인트 길이로 보수적으로 센다(출처·키·이스케이프 포함). JSON/text 실제 결과도 상한을 검증한다. 절단은 가림 표식을 쪼개거나 원문으로 돌아가지 않는다. next에 검색 비밀 질의를 재삽입하지 않고 첫 생략/절단 출처의 sessions read를 안내한다. 출처 자체가 극단적으로 큰 입력도 상한 위반 성공을 반환하지 않도록 유효성 한계/명시적 실패를 둔다.

[ASSUMPTION] expand는 기본 앞뒤 2개·각 최대 100개다. 단일 session/from_at/to_at 또는 같은 세션의 여러 구간을 받아 각 문맥을 합쳐 id로 중복 제거한다. chunk_id는 필수가 아니다. 세션 페이지는 기본 메시지 50개·최대 200개, 불투명 안정 커서를 검사한다. 메모는 연결 메시지와 함께 반환하고 고아 메모도 보존한다. 원문 페이지 역시 budget을 적용하고 긴 본문의 next에 문자 위치를 포함해 진행한다. 메시지/메모를 같은 snapshot에서 읽는다. append는 뒤쪽 페이지에 보이고 redact는 현재 가린 값으로 보인다.

검색 전용 PG 경계에서 질의 오류·잠금/statement timeout 원인을 보존해 SEARCH_FAILED로 만들되 연결 실패는 DB_UNAVAILABLE로 남긴다. 읽기 명령은 drain:false다. 기존 전체 읽기를 재사용해도 안정 정렬·일관 snapshot을 증명한다. 작은 결정 가정은 코드 주석에도 남긴다.

### 리뷰 반영 설계

- 고정 data 7,000자와 원시 token 256자 제한은 최종 상한의 증명이 아니다. 가린 data뿐 아니라 가린 meta.next·omitted·warnings·now 등 전체 봉투와 최종 텍스트 행/메타/개행까지 고려해 총 8,000자를 보장한다. 실제 출력 직전 경계에서 확인하거나 증명 가능한 보수적 계수 함수를 공유한다. 실제 다음 호출을 만들어 측정하며 본문 감축/하위 생략 후 메타를 다시 만들어도 상한을 유지한다. 가림 후 커지는 세션 토큰 회귀를 SDK 봉투와 실제 CLI JSON/text에 추가한다. 출처/next가 변형돼 실행 불가능하면 명시적으로 실패하며 가린 토큰을 새 식별자로 실행하지 않는다.
- 텍스트 모드도 has_more·omitted·next의 실제 명령/커서를 출력한다. 기존 CLI의 VerbCall→argv와 quoting 경계를 재사용하고 출력 코덱으로 가린 뒤 크기에 포함한다. JSON과 text에서 next를 따라 동일한 다음 페이지가 읽혀야 한다.
- 원문 커서는 현재 행의 가린 본문 fingerprint/세대까지 식별한다. 커서 발급 뒤 본문이 바뀌면 이전 문자 offset을 새 문자열에 적용하지 않는다. 같은 메시지의 현재 안전하게 가린 본문을 처음부터 다시 읽고 변경 사실을 알리는 보수적 정책으로 뒤 메시지까지 진행한다. 이 경우 해당 행 재표시는 허용되며 변경 없는 경우는 여전히 누락/중복이 없어야 한다. 커서 없는 첫 읽기와 고아 메모, 실제 manual redact·가림 확장/축소·다음 메시지 진행을 시험한다. 새 커서 값의 입력 유효성/다른 세션 사용도 검사한다.
- 연결/풀 연결 timeout·소켓 비정상 종료 등 code 없는 연결 실패는 DB_UNAVAILABLE이며 서버 SQL/잠금/statement 오류만 SEARCH_FAILED로 분류한다. 단순 메시지 패턴에 의존할 경우 설치된 드라이버의 실제 경로와 짝지어 시험하고, ECONNRESET/EPIPE 등도 보존한다. SQL 오류/잠금 실패 시험은 유지한다.

### 두 번째 리뷰 반영 설계

[ASSUMPTION] id 순서를 도착 순서로 가정하지 않는다. 고정 크기 고아 진행 경계와 메시지 진행 경계를 쓰며, 새 메시지에 연결된 메모가 예전 고아였는지 새로 들어온 메모인지 구별할 수 없는 경우 현재 메시지의 메모를 재출력하고 hint로 알린다. 이 동적 전환에서만 메모 재표시를 허용한다. 변경 없는 페이지·고아 상태 그대로인 메모는 무중복이고 누락은 허용하지 않는다. 별도 영속 이력이나 새 스키마는 만들지 않는다.

- Core는 CLI 설정 경고를 알 수 없으므로 실제 CLI의 경고 병합과 최종 코덱 뒤에 네 읽기 명령의 최종 상한을 다시 보장한다. 상한을 넘는 성공은 출력하지 않는다. 추가 경고 때문에 본문/메타를 안전하게 유지할 수 없으면 고정 길이 INVALID_ARGUMENT 실패로 명시하고 설정 경고를 정리해 다시 실행하도록 안내한다. 기존 경고 종류는 중복 제거한 코드로 보존하고 원시 키/경로를 포함한 무제한 경고 문장을 실패 출력에 그대로 복제하지 않는다. 이 예외 결과도 JSON/text와 stderr 합계가 8,000자를 넘지 않는다. 최종 오류를 만드는 과정의 경고 중복/추가 길이도 검사한다. 설정의 알 수 없는 키 1개 및 다수·긴 키 fixture로 네 명령의 실제 출력/exit를 검증한다. 모든 다른 명령의 기존 출력은 보존한다.
- 메시지와 연결 메모가 고아 메모보다 앞에 배치되는 순서는 유지한다. 커서는 메시지 진행 경계(마지막으로 소비한 안정 메시지 키)와 고아 메모의 재개 위치를 별도로 보존한다. 고아 메모를 가리키는 커서가 있고 그 경계 뒤에 새 메시지가 append되면 아직 읽지 않은 메시지/연결 메모를 먼저 내고 이전 고아 메모 위치를 이어 읽는다. 고아 상태 그대로인 이미 읽은 메모는 반복하지 않는다. 고아가 새 메시지에 연결돼 이전 출력 여부가 모호한 전환은 현재 메시지의 메모를 다시 보여 주고 hint로 알리는 보수적 예외다. 첫 메시지 뒤 단일 고아 메모, 여러 고아 메모 중간, 연결 메모와 긴 본문이 있는 append를 실제 PG/SDK 및 CLI next에서 시험한다. 기존 본문 fingerprint 재시작·다른 세션 거부·무변경 페이지의 누락/중복 없음은 유지한다.

### 재개 리뷰 반영 설계

- `--note`는 연결 메모와 고아 메모 모두 허용한다. 연결 메모부터 시작하면 그 소유 메시지의 본문은 의도적으로 건너뛰되 아직 소비하지 않은 메모를 메시지 진행 경계로 제외하지 않는다. 별도 고아가 있는 긴 단일 연결 메모와 같은 소유자의 여러 메모 합계가 budget을 넘는 경우 모두 next를 끝까지 따라 모든 선택 메모와 고아를 읽어야 한다.
- [ASSUMPTION] 페이지 사이 고아 메모 구성원이 바뀌면 id 도착 순서를 추정하지 않고 현재 고아 목록을 처음부터 보수적으로 재표시하고 hint로 알린다. 별도 영속 이력이나 무한 id 누적 없이 고정 크기 구성원 지문을 사용할 수 있다. 변경 없는 페이지는 무중복이며 메시지의 기존 진행과 연결 메모·부분 본문 재개는 보존한다. 구성원 변경으로 부분 고아를 처음부터 재표시할 때도 안내한다. O20 대기 앞 O10 삽입, O10을 이미 소비한 뒤 더 작은 새 고아 추가, 부분 고아 재개와 새 고아 추가, 새 메시지 append/연결 전환의 기존 회귀를 함께 검증한다.

연결 전환과 구성원 추가가 같은 페이지 사이에 일어나는 조합도 보장한다. 긴 O20을 보류한 상태에서 새 메시지가 O20을 연결하고 더 작은 새 고아 O10이 추가되면, 메시지/연결 메모의 부분 위치와 실제 고아 스캔 시작점을 따로 보존해 O10까지 읽는다. 연결된 보류 메모 id를 현재 고아의 하한으로 재사용하지 않는다.

## Verification

- `pnpm build && pnpm typecheck` — 전체 빌드·타입 검사 성공.
- `pnpm exec vitest run --project core --project postgres --project cli` — 행렬 신규 시험과 기존 회귀 성공.
- `bash _bmad/custom/bmad-loop-verify.sh` — 전체 결정적 검증 성공.

합성 자료·격리 DB/home만 쓴다. 잠금 시험 A는 검색 adapter, B는 별도 pg.Client로 BEGIN 및 chunks/tool_notes ACCESS EXCLUSIVE 잠금을 보유한다. A는 lockTimeoutMs 100·queryTimeoutMs 2000, 시험 한도 30초이며 실제 잠금 초과를 관찰한다. finally에서 B ROLLBACK/end, A 완료/store.close, 격리 DB/home 삭제를 수행한다. vitest global setup이 시작한 compose.test.yaml PG만 종료하며 수동 시작분은 `docker compose -f compose.test.yaml down`으로 정리한다. 실제 시험명·실행 건수·행렬 대응은 구현 메모에 남긴다.

## Auto Run Result

- status: built
- 구현: `recall chunks|tools|expand`와 `sessions read`를 SDK·CLI 1:1로 제공한다. 원문 literal 검색, 근접 단계·관련도 정렬, 실제 conversation 출처, 기본 5건과 limit+1, 가림 뒤 공통 8,000자·하위 행 생략·1위 최후 절단·omitted/next, 빈 결과 안내와 검색 실패 구분을 구현했다.
- 변경 파일: `packages/core/src/recall/{search,results,expand,time}.ts`는 검색·가림 후 예산·텍스트 출처·구간 확장을, `sessions/read.ts`는 안정 페이지·본문/고아 구성원 변화 재개를 맡는다. `ports/recall-store.ts`·Store/fake·brain·공개 exports는 capability와 SDK를 연결한다. `packages/postgres/src/recall.ts`·sessions·store는 정렬/출처/실패 분류와 일관 원문 snapshot을 제공한다. `apps/cli/src/commands/recall-*.ts`·sessions-read·등록부·dispatch·doctor 대체 store는 명령·실제 텍스트 출처·최종 출력 상한을 연결한다. Core/PG/CLI recall 시험과 기존 코드표·dispatch·unavailable 시험, README, 이 계획은 회귀와 계약·근거를 기록한다.
- 리뷰: 이전 세 차례 리뷰의 medium 9개 판정·수정 이력을 보존했다. 이번 재개 첫 리뷰 medium 2개는 메모 시작 경계 수정과 고아 구성원 변화 설계 재도출로 처리했고 연결 전환/작은 고아 동시 추가도 보완했다. 마지막 독립 리뷰는 medium 2개를 최소 수정했다. 이번 마지막 pass patch 집계 high 0·medium 2·low 0, 추가 결함 이월 0, 기각 0이다. 기존 가정 5개와 새 동적 고아 구성원 재표시 가정 1개를 단일 deferred 목록으로 보존했다.
- followup_review_recommended: true
- 후속 리뷰 대상: 마지막 독립 리뷰 이후 수정한 연결 메모·형제·별도 고아의 커서 플래그 및 텍스트 출처와 공통 길이 계수의 일치 여부를 독립적으로 다시 확인하는 것을 권고한다. 해당 조합과 실제 CLI 출처 호출 회귀·전체 검증은 통과했으며 알려진 미수정 findings는 없다.
- 검증: 지휘자가 `pnpm build && pnpm typecheck` 성공, `pnpm exec vitest run --project core --project postgres --project cli` 127파일·3,284개 성공, `bash _bmad/custom/bmad-loop-verify.sh` 종료 코드 0·139파일·3,603개 성공·기존 skip 1개를 확인했다. 마지막 시험 보강은 긴 형제 메모 조각의 합계가 원문과 같음을 검증하며 최종 결정적 실행에 포함됐다. 모든 신규 recall 행렬 시험은 실행됐고 skip이 없다. staged diff 공백 검사와 YAML 파싱도 성공했다.
- 행렬: 한국어/literal/NUL·세 근접 단계/관련도·0/5/6건은 PG와 실제 CLI 검색, 상한/가림 증가/이모지/1위 절단/next는 Core budget과 CLI JSON/text, 도구 전용 가림과 고아는 Core/PG/CLI 원문 페이지, 겹치는 구간·동시각·재조각은 PG/CLI expand, 질의/실제 chunks·tool_notes 잠금 실패는 PG SEARCH_FAILED 시험으로 확인했다.
- 한계: 동적 본문 변경·고아 구성원 변경·뒤늦은 연결은 안전한 재표시와 hint를 낼 수 있으며 정적 페이지는 무중복이다. 이전 실행의 일반 본문 결합·관련도 등 가정과 폐기된 예산 예약 이력을 삭제하지 않았다. 이번 재검증 도중 기존 PG 준비 timeout 1건이 있었고 코드·timeout 변경 없이 최종 재실행이 성공했다. 운영 자료·홈은 사용하지 않았다.
- 저장소 밖 HUMAN 전용 수락 작업은 없다. operator_actions는 필요하지 않다.
- 티켓 done 표시·tickets.py mark·push는 실행하지 않았다. 오케스트레이터가 자체 검증 후 티켓 완료를 판정한다.

- Orca 정리: 재개한 자기 Run `run_b766f55085da`는 이전 워커를 포함해 released 8개, 별도 조사 Run `run_97de905236a2`는 released 1개다. 두 Run 모두 active/reclaimable 0이며 coordinator mail 0을 확인했다. 구현·리뷰 전문과 정확한 Dispatch의 정식 완료를 수락한 뒤 release했으며 남은 과업·미확인 워커는 없다. 전용 제어 셸만 마지막에 닫는다.
