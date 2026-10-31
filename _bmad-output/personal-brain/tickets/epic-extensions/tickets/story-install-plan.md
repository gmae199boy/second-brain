---
title: 'install 스킬과 실제 상태 기반 안내 시험'
type: 'feature'
ticket: '7'
created: '2026-10-31'
status: done
baseline_revision: 'b7fab4cfb4b1457c2e765f3d5a0162137897978c'
route: 'full'
route_source: 'pinned'
risk: 'medium'
review: 'quick'
review_source: 'pinned'
lenses_ran: [quick]
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: [oversized]
deferred: []
---

<intent-contract>

## Intent

기본 플러그인에 확장 설치 안내가 없어 사용자가 실제 설치·로그인·연결·예약 상태를 알기 어렵다. 실제 CommandSpec과 공개 상태 계약을 사용하는 `plugin/skills/install/SKILL.md`와 정적 검사·별도 에이전트 행동 평가를 제공한다.

## Boundaries & Constraints

- 먼저 `brain guide schema ext --json`으로 지원을 확인하고 `ext status`를 조회한다. 지원이 없으면 미구현이라고 보고하고 중단한다. 이미 모든 단계가 완료되었다면 중복 설치하지 않는다. 부분 상태는 `ext install`로 재개한다.
- `ext install`은 이미 로그인·연결 확인·공통 예약 등록을 소유한다. 스킬에서 별도 예약을 중복 생성하거나 존재하지 않는 로그인 명령을 만들지 않는다. `login_required`는 사용자가 직접 인증을 완료하도록 안내하고 확인 뒤 같은 설치 명령으로 이어 간다. 사람 응답이 없으면 미완료를 보고하고 끝낸다.
- 비밀번호·MFA·토큰을 대화·스킬·보고서로 수집하거나 저장하지 않는다. 임의 패키지 설치·별도 LaunchAgent·실계정·실제 Garmin 호출은 금지한다. 최종 결과는 성공과 실패 모두 마지막 `ext status` 재조회에 근거하며 완료되지 않은 단계와 다음 행동을 명시한다.
- 행동 평가는 실제 SKILL.md를 입력으로 받은 에이전트와 fake CLI를 사용한다. 명령 호출·최종 보고를 검증하며 고정 시나리오를 스크립트로 재생하는 시험만으로 에이전트 행동 통과라고 주장하지 않는다. 기본 suite에는 모델/Python 의존을 추가하지 않는다.
- 편집 범위는 스킬, 관련 정적/행동 시험·평가 도구, package 진입점과 사용 설명이다. 기존 확장 설치/공개 상태 구현은 변경하지 않는다. app-ref 배포 변경과 실제 설치본 확인은 13.10 소관이다. 스킬 캐시 갱신을 위해 plugin version만 올릴 수 있다.
- 워커는 소스·시험·설명만 편집하고 계획에는 Implementation Notes만 추가한다. 티켓·tickets.toml·계획 상태·커밋·push·tickets.py mark는 실행하지 않는다. 모든 작성 설명·보고는 한국어로 한다.

## I/O & Edge-Case Matrix

| 상황 | 입력·상태 | 기대 행동·보고 | 실패 처리 |
|---|---|---|---|
| 정상 | 미설치, 설치 성공 | schema → status → install → status, 연결·예약의 실제 완료 | 재조회 실패는 미확인 |
| 이미 설치됨 | 연결·예약까지 완료 | schema → status → status, 중복 install 없음 | 완료 사실만 보고 |
| 설치 실패·취소 | install 실패·취소 | 마지막 status로 성공 단계·실패 코드·미완료 보고 | 거짓 완료 금지 |
| 로그인 미완료·재개 | login_required | 사용자 직접 인증 안내, 미완료 시 중단, 인증 완료 응답 뒤 install·status | 비밀번호·MFA 수집 금지 |
| 스케줄러 미준비 | scheduler_unavailable | 설치·연결과 예약 미완료 구분 | 별도 예약 수단 금지 |
| 명령 없음 | schema에 ext 없음 | 지원 미구현 보고, 추가 설치 명령 없음 | 우회 설치 금지 |
| 연결 실패 | connection_failed | 연결·예약 미완료 보고 | 성공 단계 보존 |
| 비밀 없음 | 모든 공개 fixture | 명령·최종 보고에 비밀 canary 없음 | 누출·거짓 완료 0건 |

</intent-contract>

## Code Map

- `apps/cli/src/commands/index.ts`, `dispatch.ts`, `envelope.ts`, `guide-schema.ts`: 실제 CommandSpec 등록부와 공통 옵션·JSON envelope를 정적 검사의 원본으로 사용한다. guide schema는 DB 없이 동작한다.
- `apps/cli/src/commands/ext-install.ts`, `ext-status.ts`: 설치가 공개 상태를 재조회하며 `install.stages`, `login`, `connection`, `schedule`, 고정 실패 코드를 낸다. `packages/core/src/extensions/install-progress.ts`의 8단계와 결과 enum을 재사용한다.
- `packages/core/src/extensions/install.ts`, `status.ts`: 설치가 로그인·연결·예약 SDK를 이미 호출한다. 별도 스킬 예약 명령을 추가하지 않는다.
- `tooling/bootstrap/test/plugin.test.ts`, `.claude-plugin/marketplace.json`: marketplace는 `./plugin` 전체를 배포한다. 새 skills 디렉터리의 실제 배포 포함을 검증한다. plugin은 package.json 없이 유지한다.
- `vitest.config.ts`: 각 workspace의 test/만 기본 발견한다. 행동 평가 도구는 별도 디렉터리/진입점에 두며 기본 시험에서는 harness 판정 자체만 오프라인으로 검증한다.
- 선행 13.6 계획의 공통 projection·doctor 계약·검증을 확인했다. 최상위 research-* 폴더는 없으며 참조 연구 §1·7의 옛 명령 부재는 현재 코드에서 해소됨을 확인했다.

## Tasks & Acceptance

**실행:**
- [x] 1단계: `plugin/skills/install/SKILL.md`에 위 절차와 상태 해석·인증 안전·재개/중단·실패 보고를 작성한다. `tooling/bootstrap/test/` 또는 `apps/cli/test/`에 모든 사용 명령·옵션의 CommandSpec 일치, 금지 지시, 배포 포함 정적 검사를 추가한다. 필요한 plugin version만 올리고 단계 보고한다.
- [x] 2단계: `tooling/`에 fake CLI·행동 평가와 명령 기록/최종 보고 검증·명시 진입점, `package.json`과 `README.md`에 실행 방법을 추가한다. 정상·이미 설치·설치 실패·로그인 미완료·스케줄러 미준비·명령 없음 6건 및 connection_failed·비밀 없음·인증 후 재개·취소를 검증한다. 실제 에이전트가 직접 fake CLI를 호출할 수 있는 준비/판정 진입점도 제공하고 전체 implementation-ready를 보고한다.

**인수 조건:**
- Given 실제 배포 폴더와 CommandSpec, when 기본 정적 시험을 실행하면, then 스킬의 모든 명령·옵션이 존재하고 금지 지시가 없으며 marketplace 배포에 스킬이 포함된다.
- Given 실제 SKILL.md와 격리 fake CLI, when 별도 행동 평가에서 에이전트가 각 case를 수행하면, then 최소 6건과 추가 matrix의 호출 순서·최종 단계 보고가 일치하고 거짓 완료·우회 설치·비밀 누출이 0건이다.
- Given 로그인 미완료와 완료 후 재개 fixture, when 스킬이 안내하면, then 인증은 사용자에게 맡기고 미완료/재개를 구분하며 실제 status로만 완료를 보고한다.

## Implementation Notes

- 설치 스킬은 schema와 두 status 조회를 통해 공개 상태에 근거해 안내하며, 완료 단계의 `skipped`를 구분한다. 플러그인 캐시 갱신을 위해 버전을 0.1.11로 올렸다.
- `pnpm eval:install prepare <사례> <새 디렉터리>`와 `pnpm eval:install verify <디렉터리>`는 실제 에이전트 평가의 격리 CLI와 판정 파일을 제공한다. 10개 사례를 제공하며 기본 시험의 판정기 자기시험은 실제 에이전트 평가가 아니다. 자동 판정 후 기록의 의미를 별도로 검토한다.
- 빌드와 타입 검사는 성공했고 독립 Vitest 설정에서 플러그인·정적·판정기 검사 34건이 통과했다. 기본 Vitest는 이 실행 환경에서 Docker 소켓 접근 권한 거부로 시작하지 못했다.

## Plan Change Log

## Review Triage Log

### 2026-10-31 — 리뷰 1회

- 판정: 2건 — high 0, medium 2, low 0, false 0, maybe-false 0.
- `[medium]` `[patch]` 실패 보고에 단독 `설치 완료`를 추가해도 합격한다. 기존 failure 원본 사본에 이 문장만 추가해 passed=true를 재현했다. 기존 전체 결과 문구 검사에 명사형 완료 거절 조건과 반례를 추가했다. 실제 부분 성공·전체 미완료 보고는 유지한다.
- `[medium]` `[patch]` 인증 안내·완료 응답을 제거한 resume도 합격한다. 원본 사본의 transcript를 `평가 대화`로 바꾸어 passed=true를 재현했다. 기존 대화 검사에 첫 설치 → 인증 안내 → 주어진 사용자 응답 → 재개 순서를 비교하는 조건 및 생략·역순·미완료 뒤 재개 반례를 추가했다. 실행 지시와 README에도 필요한 기록 형식을 명시한다.
- 두 수정은 기존 판정 조건만 보정하며 새 공개 CLI·설정·보안 상태를 추가하지 않는다. 실제 에이전트의 원본 행동과 보고는 변경하지 않는다. 기각·보류한 발견은 없다.

## Verification

- `pnpm build`, `pnpm typecheck`, `git diff --check`: 성공해야 한다.
- `pnpm exec vitest run --project bootstrap tooling/bootstrap/test/install-skill.test.ts tooling/bootstrap/test/install-eval.test.ts tooling/bootstrap/test/plugin.test.ts --reporter verbose`: 3파일 34건 통과. 로그는 `/tmp/brain137-verify-matrix.log`다.
- `pnpm eval:install prepare <사례> /tmp/brain137-live/<사례>` 후 실제 에이전트가 각 `prompt.md`와 `SKILL.md`를 읽고 fake CLI를 직접 호출하며, `pnpm eval:install verify /tmp/brain137-live/<사례>`로 판정한다. 에이전트 평가 워커는 실제 스킬과 준비된 fake CLI만 사용하며 case별 transcript·최종 보고·판정 파일을 남긴다. 운영 홈/DB·실계정은 사용하지 않는다. 임시 디렉터리는 평가 종료 뒤 정리한다.
- `pnpm test`: 기본 Node/PG 회귀를 검증한다.

### 지휘자 독립 검증

- `pnpm test`: 선행 빌드·타입 검사 성공, 145파일 3706건 통과·기존 선택 시험 1건 건너뜀(`/tmp/brain137-verify-full.log`). 워커에서 관찰한 Docker 접근 오류는 지휘자 환경에서는 발생하지 않았다.
- `git diff --check`: 통과. staged 전체 diff를 `/tmp/brain137-review.diff`에서 직접 읽었다.

### 실제 에이전트 행동 평가와 matrix audit

- 읽기 전용 평가 워커가 실제 스킬을 읽고 10개 case에서 37회 fake CLI를 호출했다. 정상·이미 설치·실패·로그인 미완료·예약 미준비·명령 부재·연결 실패·비밀 없는 공개 상태·인증 후 재개·취소의 모든 명령 순서와 마지막 공개 상태가 일치했다. 전체 보고는 `/tmp/brain137-behavior.md`, 판정은 `/tmp/brain137-verify-behavior.json`이다.
- 최초 자동 판정에서 정확한 보고 8건을 언어 표현 차이로 거절했다. 같은 구현자가 기록 부재·영문 enum·미완료 부정을 처리하고 반례 시험을 추가했다. 원본 호출·응답·대화·최종 보고 50파일의 SHA-256이 모두 동일한 상태에서 재판정 10/10 통과했다. 보고를 정답 문구로 바꾸지 않았다.
- matrix의 정상/중복은 normal/already, 실패·취소는 failure/cancel, 인증 대기·재개는 login/resume, 예약은 scheduler, 명령 부재는 unsupported, 연결 실패는 connection, 비밀 없음은 secret 및 전체 canary 검사로 대응한다. 판정기 기본 시험의 10개 case도 모두 실행되어 통과했다. 거짓 완료·우회·누출은 0건이며 로그인 안내·사용자 fixture 응답 순서와 후속 조치를 직접 검토했다.
- 비밀 case는 fake projection의 사설 진단 canary가 공개 CLI·보고에 나오지 않음을 확인한다. 기존 실제 확장 비밀 차단 구현 자체의 새 통합 시험으로 주장하지 않는다. 실제 모델 평가 산출물은 기본 suite 밖에 있고 실제 계정·Garmin·운영 DB는 쓰지 않았다.

- 판정기 수정 뒤 전체 회귀는 144파일 3705건 통과·기존 work-store.releaseWork 1건 30초 timeout·기존 skip 1건이었다(`/tmp/brain137-verify-final.log`). 실패 파일만 독립 재실행해 159건 전부 통과했다(`/tmp/brain137-verify-work-store-retry.log`). 변경한 스킬·판정기 시험은 수정 후 전체 실행에서도 모두 통과했다. 기존 PG 시험의 일시 timeout을 기록하고 해당 제품 코드는 수정하지 않았다.

### 리뷰 수정 뒤 최종 검증

- 최종 `pnpm test`: 빌드·타입 검사 성공, 145파일 3706건 통과·기존 선택 시험 1건 건너뜀(`/tmp/brain137-verify-post-review.log`). 앞선 기존 PG timeout은 이 전체 실행에서 재현되지 않았다.
- 실제 행동 평가 원본 10건을 재판정하여 모두 통과했고 리뷰의 거짓 명사형 완료·인증 대화 생략 반례는 모두 거절했다. 원본 50파일 해시가 동일함을 다시 확인했다. 최종 diff를 다시 생성하여 직접 검토했고 `git diff --check`가 통과했다.

## Auto Run Result

Status: built

기본 플러그인에 실제 지원·단계 상태를 확인하는 install 스킬과 CommandSpec·금지 지시·배포 정적 검사, 별도 fake CLI 행동 평가 진입점을 추가했다. 이미 완료된 설치는 반복하지 않으며 인증·연결·예약 미완료와 실패를 재조회한 상태로 구분한다. 플러그인 버전은 `0.1.11`이다.

변경 파일:

- `plugin/skills/install/SKILL.md`: 지원 확인부터 사용자 인증 안내·설치 재개·마지막 상태 보고까지의 절차.
- `plugin/.claude-plugin/plugin.json`: 스킬 캐시 갱신을 위한 버전 증가.
- `tooling/bootstrap/test/install-skill.test.ts`: 명령·옵션의 CommandSpec 일치, 금지 실행 지시와 배포 포함 검사.
- `tooling/bootstrap/test/install-eval.test.ts`: 10개 fake CLI 사례와 거짓 완료·잘못된 코드·상태·우회·누출·인증 순서 반례 검사.
- `tooling/install-eval/eval.mjs`: 실제 SKILL 입력·격리 CLI 준비·명령/응답 기록·최종 상태와 보고 판정.
- `package.json`: `pnpm eval:install` 별도 진입점.
- `README.md`: 실제 에이전트 평가 방법·인증 기록 형식·자동 판정 한계 설명.
- 이 계획: 구현·인수·독립 검증·리뷰 triage·결과 및 오케스트레이션 인계 기록.

검증은 최종 전체 3706건 통과·기존 skip 1건, 정적/판정기 34건 통과, 실제 에이전트 행동 10/10 통과다. 행동 평가의 37회 실제 호출과 마지막 공개 상태, 인증 안내/fixture 응답 순서를 직접 검토했다. 관찰한 거짓 완료·우회 설치·비밀 노출은 0건이다. 실제 계정이나 운영 홈·DB는 사용하지 않았다.

리뷰는 2건 모두 medium/patch로 반영했으며 high/low patch·deferred·기각은 각각 0건이다. 후속 리뷰 권고는 `true`다. 두 medium patch가 있었고, 자연어의 추가 부정·부분성공 표현과 인증 기록 형식 변형에 대한 판정 범위는 아직 전부 검증하지 않았다. 자동 판정은 의미 검토를 완전히 대체하지 않는다. fake 비밀 fixture는 기존 제품의 비밀 차단 자체를 새로 통합 검증한 증거가 아니다.

외부에서 HUMAN만 수행해야 하는 잔여 작업은 없다. 티켓의 done 표시와 최종 완료 검증은 오케스트레이터가 수행한다. `tickets.py mark`와 push는 실행하지 않았다.


Orca 정리와 인계:

- `run_7131ba85a128`의 구현·행동 평가·Quick 리뷰 워커 3개는 정식 succeeded 보고를 수락하고 모두 release했다. 전체 fleet에서 completed/released를 확인했으며 pending mail·reclaimable·미확인 워커·미확인 요청은 없다. 별도 취소나 강제 종료는 하지 않았다.
- 행동 평가 산출물은 `/tmp/brain137-behavior-artifacts.tar.gz`에 보존하고 실행용 `/tmp/brain137-live` 디렉터리를 정리했다. 이후 원본을 보려면 이 archive를 풀어 확인한다. 최종 판정 요약·hash 목록·구현/행동/리뷰 전문과 시험 로그는 위 임시 경로에 보존했다.
- 체크포인트는 현재 task의 `orca-coordination.json`에 보존한다. 최종 커밋·clean 검증을 기록한 뒤 워커·mail이 없는 전용 제어 셸만 닫는다. 티켓 done은 변경하지 않는다.
