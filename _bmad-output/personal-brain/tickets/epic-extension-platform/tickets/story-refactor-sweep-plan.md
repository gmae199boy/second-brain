---
title: '확장 플랫폼 정리: core snapshot 취득 중복 통합'
type: 'refactor'
ticket: '5'
created: '2026-11-05'
status: 'built'
baseline_revision: 'b4817644602dfa479236e02d450c30c9becccecc'
route: 'full'
route_source: 'pinned'
risk: 'low'
review: 'thorough'
review_source: 'pinned'
lenses_ran: ['blind-hunter', 'edge-case-hunter', 'verification-gap', 'intent-alignment']
review_loop_iteration: 0
followup_review_recommended: false
context: ['{project-root}/AGENTS.md']
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** 20.1~20.4를 거치며 core 연결 확인과 읽기 명령에 같은 설정/snapshot 취득 단계가 중복됐다. 같은 self·scope·비밀 처리 계약의 유지 지점이 둘이다.

**Approach:** 두 core 소비자의 설정 조회·비밀 읽기·snapshot 생성을 공통 함수로 묶는다. 외부 결과, 실행 순서와 설치 진행 기록은 보존한다.

## Boundaries & Constraints

**Always:** 기존 self 해석 뒤 동일 userId를 사용한다. nonempty declarations에서 getSettings/readSecrets capability를 모두 요구하는 기존 조건, empty declarations의 IO 생략, 필요한 경우에만 비밀 읽기, DB 실패 전달, connect stage required와 command requiredKeys=[] 차이를 보존한다. 설치 실패 기록/오류 메시지와 명령 결과 코드를 유지한다. 합성 시험 코드를 작성하되 시험 실행은21.8로 이관, 미실행. build/typecheck·독립 리뷰 및 필요한 후속 리뷰만 실행한다.

**Never:** 과거 migration·운영 DB/설치/예약·공용 follow-ups·중앙 state 수정, main 병합/push, 새 기능/보안/감독 정책, attempts 예산 변경, 20.4 A1 잠금/quiesce/offline 승인 계약 완화, fixture checker/시험 실행. Runtime auth/daemon의 서로 다른 IO·오류 경계까지 무리하게 통합하지 않는다.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| 설정 없음 | 빈 declarations, capability 없음 | settings/secrets IO 없이 같은 user_id의 snapshot | 기존 snapshot 검증 유지 |
| scope·비밀·machine | user/global/default·secret 참조·machine 값 | 기존 값·타입·self·stage 동일, secret read 1회 | 비밀 읽기 throw는 EXTENSION_CONFIG_INVALID |
| capability/DB 실패 | 선언 있음 + capability 없음 또는 getSettings 실패 | 자식 실행 없음 | capability는 config invalid, DB code는 보존; 설치는 기존 stage 기록/메시지 |
| 필수 값 | connect·work 양 stage에서 required인 설정 누락 | command는 requiredKeys=[]로 허용, connect는 거부 | 설치 configuration 실패 기록 |

</intent-contract>

## Code Map

- `packages/core/src/extensions/snapshot.ts`: 순수 createExtensionSnapshot과 선언 타입. 여기에 비동기 취득 helper를 추가하고 순수 함수는 유지한다.
- `packages/core/src/settings/index.ts`: readScopedSettings의 user/global 조회·fallback을 재사용한다. 새 transaction/일관성 정책은 넣지 않는다.
- `packages/core/src/extensions/install.ts:394`: defaults 부재 삽입 후 connect snapshot 취득 중복. DB 실패 때 mark(configuration,failed,code)와 별도 메시지, configFailure 기록을 보존한다.
- `packages/core/src/extensions/commands.ts:47`: self 해석 뒤 snapshot 취득 중복. work requiredKeys=[]와 프로세스/출력/잠금 로직을 유지한다.
- `packages/core/test/extension-snapshot.test.ts`, `extensions.test.ts`: helper matrix와 연결/명령 소비 지점 회귀 코드. CLI `ext-install`, `extension-commands`, `ext-install-resume`는21.8 실행 대상이다.
- `packages/core/src/index.ts`는 snapshot 전체 export 중이므로 별도 수정 불필요. 새 Python/SQL/자식 경로가 없어 test-changed 규칙 추가 불필요.

## Tasks & Acceptance

**Execution:**
1. [x] `packages/core/src/extensions/{snapshot,install,commands}.ts` — snapshot 취득 helper를 만들고 두 core 소비자로 연결한다. caller별 오류 처리·stage·side effect 순서를 보존한다.
2. [x] `packages/core/test/{extension-snapshot,extensions}.test.ts` — matrix 모든 행과 실제 두 소비자의 오류/필수키 차이를 검증하는 합성 시험 코드를 작성한다. 기존 단언은 보존한다.

**Acceptance Criteria:**
- Given 같은 manifest/settings/self, when 연결 확인과 읽기 명령을 실행하면, then 기존 snapshot 바이트·실행 입력과 외부 성공/실패 코드·설치 실패 기록이 유지된다(시험 코드·정적 리뷰, 실행21.8).
- Given 두 core 소비자, when 설정 취득 경로를 살펴보면, then scope 조회/secret read/snapshot 생성 단계가 공통 helper 한 곳에 있고 소비자에는 오류 처리와 stage 선택만 남는다.
- Given 구현 완료, when build/typecheck와 독립 thorough 리뷰를 마치면, then 컴파일 종료0이고 미해결 필수 결함이 없다. 시험은 실행하지 않고21.8에 인계한다.

## Implementation Notes

- R1 시험 보완 완료: command 성공 전체 반환·snapshot 실패 전체 객체/미실행, capability 제공한 빈 선언 IO0회, 설치 DB오류 전용 메시지 단언. R2 독립 verification-gap은 실제 fake 출력/종료 모델까지 추적해 공백0·다른 결함0으로 확인했다.

- Execution1~2 완료: acquireExtensionSnapshot이 IO 순서/실패 종류를 보존하며 두 core 소비자에서 취득 중복을 제거했다. 순수 createExtensionSnapshot 및 Runtime auth/daemon은 유지한다. 합성 matrix/소비자 단언을 작성했다. 구현 워커 build/typecheck/diff-check 종료0 보고, 시험 미실행.

## Plan Change Log

## Review Triage Log

### 2026-11-05 — Review pass R1
- verdicts: 10 findings/관찰 — high 0, medium 2, low 4, false 4, maybe-false 0. blind의 산술/검사한계 문장은 finding 수에서 제외, intent의 출처1개·시험표5행은 각각 기록한다. edge는0건.
- 원문: 로컬 `.brain-automation/review/r1-{blind-hunter,edge-case-hunter,verification-gap,intent-alignment}.md`.
- `[low]` `[patch]` B1 command 성공 반환 미단언 — stdin만 보는 새 시험에 ok/data 전체 단언을 추가한다.
- `[medium]` `[patch]` B2 command snapshot 실패 응답 미단언 — 실제 helper snapshot 실패를 거쳐 code/message/retryable 전체와 자식 미실행을 단언한다. V1과 같은 원인·수정 묶음.
- `[low]` `[patch]` B3 빈 선언에 capability 제공 시 IO 생략 미단언 — 두 callback 제공 후0회·성공을 확인하는 직접 보완.
- `[medium]` `[patch]` V1 snapshot 오류 전달 검증 공백 — B2와 같은 원인. config와 snapshot 메시지 차이·retryable을 소비자에서 단언한다.
- `[false]` `[reject]` I1 명시적 선행 deferred만 허용하는 좁은 출처 해석 — 최신 독립 명세는 선행 계획/실제 코드를 대조해 원문 에픽의 구조/중복/일관성 정리 목록을 자율 확정하라고 지정한다. 현재 중복은20.1/20.2가 만든 계약 내부이며 새 기능/정책이 아니다. 해결된 보류/정책 항목을 완료로 숨기지 않고 제외 근거를 기록했으므로 범위 위반 없음.
- `[low]` `[patch]` I2 빈 선언 IO 표면의 한계 — B3와 같은 빈 선언 capability 사례로 보완. machine은 종전에도 호출하므로 생략 요구를 만들지 않는다.
- `[false]` `[reject]` I3 비어 있지 않은 snapshot 바이트 비교 없음 — 순수 생성기는 그대로이고 helper의 값/순서 단언과 기존 직렬화 경로로 byte 계약 유지. 문서에 기술된 관측 한계이며 변화된 바이트 결함은 없다.
- `[low]` `[patch]` I4 설치 DB 실패 메시지 직접 단언 없음 — 기존 DB_LOCKED 소비자 사례에 설치 전용 메시지 단언을 추가하는 직접 보완.
- `[false]` `[reject]` I5 새 소비자 성공 시험이 빈 settings만 확인 — 기존 core 연결 snapshot 시험과 CLI extension-commands/ext-install의 scoped 성공 입력 단언은 유지된다. 새 시험의 관측 폭 설명이며 기존 성공 경로가 미검증이라는 결함은 아님.
- `[false]` `[reject]` I6 선행 시험 무수정은 실행 통과와 다름 — 계획은21.8 미실행을 명시하고 통과로 주장하지 않음. 승인된 유예와 일치한다.
- 고유 수정 묶음: medium1(오류 응답), low3(성공 반환·빈 선언 IO·설치 메시지). 시험 코드만 직접 보완하며 제품 코드 수정 요구 없음. 후속 verification 리뷰로 단언 자체를 확인한다.

### 2026-11-05 — Review pass R2 (독립 후속 verification-gap)
- verdicts: 0 findings — high 0, medium 0, low 0, false 0, maybe-false 0.
- 원문 `.brain-automation/review/r2-verification-gap.md`, Dispatch `ctx_53ccb2810432`. 최종 baseline 전체 diff와 R1 원문을 읽고 네 보완점·fake 실행 모델을 정적으로 확인했다. 미확정 관찰 없음. 추가 수정/리뷰 권고 false.

## Design Notes

착수 정리/제외 목록(선행 계획의 deferred·Review Triage Log·Auto Run Result 및 공용 automation/follow-ups.md와 실제 코드 대조):
- 20.6 옛 manifest 예약 보류: install.ts의 disableMissingSchedules 및20.3 시험 코드에 반영됨. 새 수정 불필요, 실제 설치는21.7.
- 20.1 deferred 없음. command의 scope/snapshot 취득 중복을 이번 구조 정리로 채택. 잠금 대기/출력/ABI 정책 유지.
- 20.2 frontmatter의 core 자식 self deferred는 마지막 수락 보완에서 해결됨. supervisor의 BRAIN_USER_ID 최종 spec 검증을 유지. user/global 두 statement 혼합·기본값 취소/직접 SQL 상태는 별도 정책/가드이므로 제외. 계획 과거 서술은 이력으로 보존.
- 20.3 attempts 누적은 work.ts 성공 정산에서 여전한 기존 동작. 재시도 예산 정책이라 제외. 대량 회차 절단은 수락 보완으로 이미 해결. 회차/ABI·DST 정책 유지.
- 20.4 deferred 없음. A1 불명 설치 잠금·legacy schema 거부·기존 확장 migration quiesce·cross-commit offline 운영자 확인/자동 제한은 승인된 계약으로 유지. 실제 전환21.7.
- 20.6 옛 importer checkpoint·verify 축소와 공용 기록 보존 판단은21.2/21.7 경계. Garmin 기능/새 운영 정책은 새 스토리이며 이번에 추가하지 않는다.

## Verification

- `pnpm build` — 종료0.
- `pnpm typecheck` — 종료0.
- `git diff --check` — 종료0.

**시험 실행은21.8로 이관, 미실행.**21.8은21.6 뒤21.7 전에 전용 소유 PG·합성 자료·격리 home/withoutHarnessFolders에서 `pnpm test` → `pnpm test:python` 순차 실행한다. 이번 영향 시험: core extension-snapshot/extensions/settings/supervisor/process-abi, CLI ext-install/ext-install-resume/extension-commands/ext-login/daemon-supervisor. 선행20.6 cleanup·공용기억/파일/채널 보존,20.1 CLI/MCP/guide/출력 가림/프로세스 정리/schema,20.2 user-keys/migrate/settings/self/자식ID,20.3 schedule-cron/schedule-migration-tick/schedule-occurrences/work-store/store공통계약/daemon,20.4 ext-package/extension-transition/install-lock/bootstrap/extension-plugin/quiesce 및 TS/Python manifest/ABI·digest/ref/version을 포함한다. fixture가 만든 소유 DB/home만 정리하며 공유 role/타인 컨테이너를 삭제하지 않는다. 기준SHA·환경/소유자원·명령·종료코드·로그·실패처분·재검증을 기록한다. 미실행/미해결이면21.8 built 및21.7 시작 금지.

## Auto Run Result

- 상태: built(인수 전). baseline `b4817644602dfa479236e02d450c30c9becccecc`에서 공식 bmad-build-auto full/thorough로 진행했다. 범위 선정/제외 근거는 Design Notes, 처분은 Review Triage Log에 보존했다.
- 구현: `snapshot.ts`에 acquireExtensionSnapshot을 추가해 설정·비밀·snapshot 취득 중복을 통합했다. `commands.ts`와 `install.ts`는 동일 self·stage/requiredKeys 및 caller별 오류 메시지/설치 실패 기록을 유지한다. 순수 생성기·설정 scope·공용기억·예약/회차·ABI·패키지/잠금/quiesce 계약을 바꾸지 않았다.
- 시험 코드: `extension-snapshot.test.ts`에 빈 선언/capability·scope/default/secret/machine 순서·DB/설정 실패를 추가했다. `extensions.test.ts`에 설치 configuration 기록/실행 차단·command 성공 입력/반환·DB/capability/snapshot 오류 응답 보존을 단언했다. 기존 시험은 유지했다.
- 리뷰: 독립 Sol/medium R1 thorough4렌즈, R2 verification-gap 후속1렌즈. R1 10행 관찰(high0/medium2/low4/false4), 고유 patch medium1·low3, deferred0. 기각4행의 근거는 triage(I1 최신 명세의 구조정리 허용, I3 순수 직렬화 유지, I5 기존 소비자 성공 단언 유지, I6 승인된 시험 이관). R2 발견0·추가 수정0. 후속 리뷰 권고 false: R1 고유 medium1로 자동 권고 임계 미만이지만 단언 보완 확인을 자율 수행했고 R2 미검증 위험 없음.
- 검증: 최종 지휘자 `pnpm build` 종료0, `pnpm typecheck` 종료0, `git diff --check` 종료0. 로그는 로컬 `.brain-automation/build-final.log`, `typecheck-final.log`. Matrix 각 행에 해당하는 시험 코드/소비 경로를 지휘자와 독립 리뷰가 정적으로 대조했다.
- **모든 시험 실행은21.8로 이관, 미실행.** 직접 시험·fixture checker·test:changed·전체 시험을 실행하지 않았다. 정적 리뷰/컴파일 결과를 시험 통과라고 주장하지 않는다. 선행20.6·20.1~20.4와 이번 영향 시험은 Verification 인계 목록을 따른다.
- 채택 가정: Runtime auth/daemon은 다른 IO/오류 경계이므로 기존 순수 생성기를 유지한다. 빈 선언에서도 machine callback은 기존처럼 평가한다. 기존 capability 조건과 두 statement scope 조회를 변경하지 않는다.
- 운영 조치: 이번 티켓의 신규 운영 조치 없음. 운영 설치/DB/계정/예약 변경 없음.20.4의 A1 불명 잠금 보존·legacy 안전거부·cross-commit offline 확인/자동 제한은 유지하며 실제 전환은21.7이다.20.3 attempts 누적 정책 판단은 별도 소유로 남긴다.
- 잔여 위험: 시험 미실행에 따른 runtime/fixture 결함 가능성을21.8에서 확인한다. 알려진 미해결 필수 기능결함0, deferred0.21.8의 새·기존 순차 시험 및 실패별 수정/재검증이 빠지면21.7을 시작하지 않는다. main 병합/push·에픽 전이는 중앙 소관, 자기 티켓 브랜치만 push한다.
