---
title: 'detached 옛 설치본의 안전한 대화형 bootstrap 갱신'
type: 'bugfix'
ticket: 11
created: '2026-11-06'
status: 'built'
baseline_revision: '1570abe3275585ca0a0e968482b8ca3d8dc8157d'
route: 'full'
route_source: 'pinned'
risk: 'high'
review: 'thorough'
review_source: 'pinned'
lenses_ran: [blind-hunter, edge-case-hunter, verification-gap, intent-alignment]
review_loop_iteration: 0
followup_review_recommended: false
context: [AGENTS.md, _bmad-output/personal-brain/automation/runbook.md, _bmad-output/personal-brain/tickets/epic-garmin-extension/tickets/bug-interactive-bootstrap-upgrade.md, _bmad-output/personal-brain/tickets/epic-garmin-extension/tickets/bug-legacy-manifest-transition-plan.md]
warnings: [oversized]
deferred: []
---

<intent-contract>

## Intent

**Problem:** `--ref`가 hook 실행 방식까지 결정해 detached 플러그인 app의 새 ref 준비와 설치기 TTY offline 확인을 함께 쓸 수 없다. ref 없는 npx 경로는 detached app을 거부한다.

**Approach:** 검증된 고정 ref를 준비하되 대화형 스트림을 유지하는 명시 지원 bootstrap 진입점을 제공한다. 기본 hook 및 npx 계약은 유지하고 기존 staged 설치·승격·소유 잠금과 offline 확인을 재사용한다.

## Boundaries & Constraints

**Always:** 검증된 full commit ref, 원래 저장소 신원·clean app·선조 이력·설치 기록 검증, 공유 A1 잠금, stage 지원 확인, installer의 현재 시도 nonce·확인 후 정지 재검사·owner fence·staged 승격을 유지한다. 사용자 비활성·보류와 새 패키지 교체 전 실행 금지를 유지한다. 합성 자료·전용 PG/role/home/venv/산출물만 사용한다. 최종 회귀는 VITEST_MAX_WORKERS=2로 TS→Python 순차 실행한다.

**Never:** 개발/리뷰 수정 중 시험·test:changed·eval 실행(컴파일만), 운영 DB/home/계정/건강값 접근·실제 daemon 중지, 과거 migration 변경, 강제 branch 전환, 일반 hook 검증 완화, offline 자동 확인, 새 CLI 사전 연결 또는 시험 호출자의 내부 staged 환경 변수 주입, main 병합·push, 타 티켓 자원 변경. 17.4 recall 및 22.1 schema39/성능 범위를 침범하지 않는다.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| M1 정상 | core27·Garmin1.0.0 manifest/0001~0008·합성 기억/예약/회계, detached 옛 app, 현재 시도 정지/진입차단 전제, 실제 PTY | 지원 bootstrap이 새 ref 준비→설치기 challenge→동일 DB core 갱신→staged 승격, 영속 자료·신원·적용 이력 접두·disabled/hold 보존, 패키지 교체 전 실행 차단 | 성공 종료 및 외부 상태 검증 |
| M2 확인 거부 | hook·비TTY·JSON·잘못된 응답·EOF·취소 | 명시 확인 자동 수락/승격 없음, hook 무질문/한 줄 출력·로그 유지 | 정확한 진단·실제 종료코드, timeout을 거부로 수락하지 않음 |
| M3 전제 실패 | 기존 writer/미정지 상태·진입차단 불충족 | 기존 installer 안전 gate 유지, DB/app 보존 | 진단 거부 |
| M4 신원/이력 | 불명/변조 ref·다른 저장소·dirty app·분기/불일치 이력·타 owner lock | 기존 검증을 우회하지 않고 변경/동시 writer 없음 | 안전 거부 및 app/DB/owner 보존 |
| M5 중단 복구 | 준비·설치·승격 경계 실패/중단 후 지원 명령 재시도 | 기존 app/DB와 확정 이력 보존, 필요시 새 확인, 같은 owner 복구·정확한 정리, 두 writer 없음 | 실제 bootstrap부터 재개 증명 |
| M6 회귀 | 일반 hook 신규/업데이트·npx·고정 ref 재시도 | 기존 성공/무질문/업데이트 정책과 오류 코드 유지 | 기존 시험 유지 |

</intent-contract>

## Code Map

- `tooling/bootstrap/src/bootstrap.ts` — `parseArgs`/`main`에서 ref 유무가 모드를 결정한다. `npxMode`는 detached를 거부하고 `prepareApp(stage)`를 쓴다. `hookMode`는 `prepareAppAt(app,...,checkOnly=true)`로 기존 clone을 건드리지 않고 검증하며 stage를 준비한다. `prepareAppAt`의 recorded-ref quiet 정책을 대화형에서 성공으로 오인하지 않도록 검토한다. `checkClone`·`isAncestor`·`waitForLock`·`stagedTarget`·`finishAppPromotion`를 재사용한다.
- 같은 파일 `systemDeps`/`childStdio`/`runCommand` — hook log descriptor가 있으면 stdin ignore, 대화형은 inherit한다. installer로 넘기는 잠금/stage 환경 변수는 bootstrap 내부만 설정한다. 새 옵션은 bootstrap에서 소비하고 installer에 전달하지 않는다.
- `tooling/bootstrap/test/bootstrap.test.ts` — args·fake deps·stdio·잠금·이력 단위 시험 기반. `hook.test.ts`/`npx.test.ts` — 임시 Git bare snapshot부터 clone/install/build/installer까지 외부 회귀 기반. 새 bootstrap PTY 통합 파일도 이 test 폴더에 둔다.
- `packages/postgres/test/install-legacy-manifest.test.ts` — 공개 옛 manifest·migration fixture, core27 합성 DB/보존, 제어 터미널 확보 Python PTY, 중단·gate·replacement 검증을 참조한다. 내부 CLI 직접 실행을 새 E2E 진입점으로 복사하지 않는다.
- `packages/core/fixtures/extensions/legacy-garmin-1.0.0-manifest.json`, `packages/postgres/test/fixtures/legacy-garmin-migrations/` — 공개 옛 바이트 재사용. 21.10은 교체 대기 gate/progress를 유지하고 현행 패키지 설치 후에만 해제한다. Garmin 기존0013의 의도된 제거표와 영속자료를 구분하되 접두/원본 보존 단언을 줄이지 않는다.
- `tooling/test-db/src/index.ts` — `createIsolatedTestDatabase`의 fixture 고유 cluster과 cleanup 증거 재사용. 공유 고정 확장 role은 서로 다른 cluster에서 격리한다. 전체 실행에는 별도 21.11 PG admin URL을 지정해 기본 공용 compose를 피한다.
- `tooling/bootstrap/package.json` build가 `bin/second-brain.js`와 `plugin/bootstrap.mjs`를 동기화한다. `README.md` 지원 명령·실패 복구·배포 설명, `plugin/app-ref`와 `plugin/.claude-plugin/plugin.json` 릴리스. 현재 원격main version과 17.4 예약0.1.21을 다시 비교해0.1.22 이상, 이전 구현 commit을 ref로 지정한다.
- `tooling/test-changed/rules.mjs` — 새 Python/SQL/자식 경로를 만들 때 누락 없는 변경 선택 규칙 확인.

## Tasks & Acceptance

**Execution:**
- [x] E1 `tooling/bootstrap/src/bootstrap.ts`, `tooling/bootstrap/test/bootstrap.test.ts` — 명시 대화형 ref 진입/검증/스트림/소유권/재시도 계약과 단위 시험 구현. 배포 bootstrap 동기화.
- [x] E2 `tooling/bootstrap/test/` — 실제 PTY+전용 PG+임시 bare repo+공개 옛 fixture를 구성하고 M1~M6의 정상·거부·중단/재시도와 보존/정리 시험 작성. 기존 hook/npx 시험 보존, 필요한 경로 규칙 연결.
- [x] E3 `README.md`, 배포 bootstrap — 대상 ref 선택·옛 daemon 중지/종료 재확인·대화형 challenge·실패 복구의 실제 지원 명령을 작성하고 소스/배포 일치 확인. 릴리스 ref/version은 지휘자가 최종 검증 뒤 별도 commit에서 갱신한다.

**Acceptance Criteria:**
- Given M1 합성 옛 detached 설치본과 PTY, when 문서의 bootstrap 갱신 명령에 현재 challenge로 응답, then 동일 DB 갱신과 새 ref app 승격·기억/사용자/예약/회계/이력 접두 보존·disabled/hold·교체 전 실행 금지를 외부 경로에서 증명한다(원문 AC1).
- Given M2/M3, when 같은 진입 요청, then 무질문 hook·명시 확인 자동수락 없음·정확한 진단·안전 상태를 증명한다(AC2).
- Given M4/M5, when 요청/재시도, then 기존 검증·owner·정지 fence 유지 및 실패 보존/중단 복구와 writer 중복 없음을 외부 상태로 증명한다(AC3).
- Given 소유 전용 자원과 옛 app, when bootstrap부터 PTY 및 일반 hook/npx 회귀 실행, then CLI 사전 연결/내부 staged env 주입 없이 실제 코드·종료/진단/보존·승격을 단언하고 skip/단언 축소로 실패를 숨기지 않는다(AC4).
- Given 구현/필요후속 리뷰 종료, when 최종 TS→Python 전체 순차 회귀와 배포, then 미해결 실패0·운영 안내·소스/배포 동일·이전 구현 commit app-ref와 동시 version 증가를 확인한다(AC5). AC6 변경불필요 분기는 현 결함 확인으로 사용하지 않는다.

## Implementation Notes

- 최초 회귀 bootstrap 수정: 한국어 진단, 추가 신원검사에 맞춘 installer request/절대 경로 fake, JSON의 실제 USAGE2 거부를 정확히 검사하도록 수정. SIGKILL 설치기의 fence·marker·journal·PID 영수증과 전체 그룹 종료를 입증한 뒤 소유 fence만 수동 복구하고 fresh challenge로 같은 bootstrap 재시도하는 외부 시험/README를 보강했다. offline daemon fence 코드는 완화하지 않았다. `.brain-automation/regression-fix-report.md`, build/typecheck/diff 종료0·직접 시험 미실행.

- R2V1~3: DB 복원 SQL escape를 바로잡고 소유 PGID/PTY 영수증을 부재 확인까지 추적한다. progress 고유 진단/sequence 실행 사실·installed rename kill 영수증·부분 삭제 영수증과 정확한 종료 원인을 시험에 추가했다. `.brain-automation/r2-test-fix-report.md`, build/typecheck/diff 종료0·시험 미실행.

- R2S1 보고는 failed였으나 부분 작업을 보존해 처분했다: 최종 제품 경로는 삭제 전 항목 신원/hash snapshot을 marker에 원자 기록하고 남은 동일 항목만 개별 삭제하므로 그 제품에서 발생하는 부분 중단은 재개 가능하도록 구현됐다. snapshot 없는 이미 부분 삭제된 상태는 사용자 변경과 구별할 증거가 없어 보존/거부한다. baseline에도 이 snapshot/cleanup 프로토콜이 없고 현재 r1/r2 중간 구현은 미커밋·미배포이므로 중간 구현 상태를 자동 삭제하는 의무를 새로 만들지 않는다. 원문 AC3의 신원 불명 안전 거부를 유지한다. 필수 최종 제품 삭제중단 경계의 실제 증명은 후속 리뷰·전체 회귀 전 미확정이다. `.brain-automation/r2-source-fix-report.md`, build/typecheck/diff/cmp 종료0, 시험 미실행.

- r1 시험 보강: 실제 공개 옛 commit app·문서 plugin-root 명령·core 이력 접두·nonce 재사용/확인 중 변경·독립 정지 전제·소유 그룹/cleanup 및 PG/완료 경계 중단 시험을 추가했다. `.brain-automation/r1-test-fix-report.md`, build/typecheck/diff 종료0·시험 미실행.
- 중앙 schema39 통합: 티켓 경로만 지정한 stash `f99eb1b6aa14040939a0891401f41455413c563b`로 보존한 뒤 브랜치를 `b581a90abc6956364d394e5b19aac8e90cb32609`로 fast-forward하고 변경을 복원했다. 충돌0, README의17.4 추가 문구와21.11 안내 모두 유지, 나머지 티켓 파일 hash 동일. 원래 baseline은 유지한다. 과거 schema27 fixture는 그대로이며 새 PTY core 이력 단언은 현재 migration을 연속 검증하므로38 고정 기대가 없다.

- r1 소스 수정: 완료 정리 clone/owner 검증, 실제 이전 HEAD 연결, staged PG journal을 완료 bootstrap 정리까지 보존. `.brain-automation/r1-source-fix-report.md`의 build/typecheck/diff 종료0; 단위·PTY 미실행. 다음 Task에서 실제 외부 경계 시험을 보강하고 후속 독립 리뷰로 재확인한다.

- E3: README 지원 명령·정지/확인·재시도/불명 상태 보존 안내 완료. `.brain-automation/e3-report.md`, build/typecheck/diff 종료0, 배포 bootstrap cmp 일치. 시험 미실행. 최종 release/ref는 검증 뒤 처리한다.

- 승격 중단 복구: 설치기 journal에 promotionOwner를 추가해 marker와 owner를 연결하고 종료된 이전 owner·clean 이전/현재 app·home/commit/선조·빌드 신원을 검증한 뒤 새 설치기 확인으로 재진입한다. 과거 확인을 재사용 승인으로 취급하지 않는다. `.brain-automation/e2-recovery-report.md`, build/typecheck/diff 종료0·시험 미실행. 소유권 연결 없는 옛 journal은 보존/거부한다.

- E2: 실제 bootstrap/PTY 통합 시험 코드 작성, build/typecheck/diff 종료0·시험 미실행. `.brain-automation/e2-report.md`가 M1~M6을 매핑한다. 승격 직후 설치 기록 갱신 전 중단에서 E1이 marker를 무조건 거부하는 정적 결함을 발견하여 같은 구현자의 복구 경계 작업으로 보냈다. E2는 실행/복구 확인 전 미완료로 유지한다.

- E1: `--interactive-ref --ref <full-commit>`를 추가하고 기존 hook/npx 경로는 유지했다. 공유 잠금·신원/clean/선조검증·기존 staged 설치/승격을 사용한다. 보고 `.brain-automation/e1-report.md`; build/typecheck/diff 종료0, 최초 typecheck 오타 수정 후 성공. 시험은 미실행이며 PTY/DB 증거는 E2와 최종 회귀에서 확인한다.
- 중앙 알림:17.4는 main 반영(plugin0.1.21);17.1은 문서검색/원문reader·Store/SDK/출력코덱·합성리포트fixture 소유.21.11 bootstrap 범위 유지, 독립 진행. 최종 release에서 최신 version 재대조.

## Plan Change Log

## Review Triage Log

### 2026-11-06 — signed UID 실제 실패와 r7 집중 후속
- changed-final-r2는 TS199파일 중198통과/1실패,4448통과/6실패/기존skip1(454.36초, 종료1). macOS의 정상 시스템 UID -2를 새 전역 프로세스 파서가 거부해 PTY6건과 보존 guard가 실패했다. Python/Postgres 후속은 선행 실패로 미실행. `.brain-automation/signed-uid-fix-report.md`의 최소2행 수정은 UID만 signed정수 허용하고 대상그룹 owner/EPERM/불명거부와 PID/PGID·기존 단언을 유지한다. build/typecheck/diff 종료0·시험 미실행.
- 보존된 소유 fixture6container/7임시dir는 영수증/정확ID·라벨·프로세스/열린파일 부재를 대조해 해당 항목만 정리, 정확 부재 확인. 주 PG와 운영/타티켓자원 불변. raw created127/removed121 차집합6개도 보고 ID와 일치.
- `.brain-automation/review/r7-signed-uid.md`: 새 findings0·2행 순증과 안전거부 유지 독립 확인, 실제 PTY/영향 회귀는 미확정. followup_review_recommended=false. 중앙의22.2 확정성능 짧은 조율 요청에 heavy없음/즉시준비가능 회신, 명시 구간/만료시각까지 새 heavy 시작만 보류하고 정적 작업 계속. 티켓 의존 대기나 전체회귀 독점이 아니다.

### 2026-11-06 — r6 그룹 관측 후속
- `.brain-automation/review/r6-group-observation.md`: 새 findings0. 좀비를 부재로 바꾸지 않고 목록의 실제 소멸 요구, 살아 있는 대상의 EPERM·다른 UID·형식/관측 오류·리더 식별 불가를 실패/자원보존으로 유지함을 독립 확인.17.1 Store/export·코덱의 설치 연결 정적 충돌 없음. 실제 OS/통합 동작은 새 재검증 전 미확정이며 이번 pass patch0, followup_review_recommended=false.

### 2026-11-06 — r5 및 changed-final 실패 후속
- r5 (`.brain-automation/review/r5-pty.md`) 새 findings0, 단독 PTY6/6와18개 fixture 정리 증거 인정. 이후 원래 baseline 대비 `test:changed`는 TS195파일 중194통과/1실패·4421통과/1실패/기존skip1(490.23초, 종료1); Python/Postgres 추가 단계는 선행 실패로 미실행이다. 단독 통과로 전체 실행의 실패를 숨기지 않는다.
- 남은 M1–M6 interrupt 경로는 Python의 leader wait 뒤 killpg(signal0) EPERM. `.brain-automation/changed-pty-fix-report.md`: 실제 PGID 멤버/UID/state를 관측해 좀비만 남은 그룹을 재관측하고 모든 항목이 사라져야 부재 인정. 살아 있는 대상의 EPERM·소유불명·관측 오류는 실패/보존한다. XNU의 좀비 그룹 EPERM 가능 경로는 근거이나 이번 로그 확정 원인은 아니다. build/typecheck/diff 종료0·시험 미실행, 독립 후속과 실제 재검증 전 미확정.
- 중앙17.1 main `4d0ec474627b9ca3e6b440b6b565757ddd72a9d8`을 scoped stash/fast-forward/apply로 통합,8파일 hash 동일·충돌 없음. 공유 Store/export/출력코덱/문서명령 변경을 대조했고 migration/schema39·설치/승격 프로토콜 불변. bootstrap fixture target은 현재 통합 tree를 사용하므로 최종 영향 회귀에서 연결 확인.

### 2026-11-06 — 관련 재검증 및 PTY 실패 처분
- related-r1:3파일194시험 중193통과/1실패(종료1). bootstrap 단위157·legacy31 통과로 최초 해당 실패를 닫았다. PTY stale 시도 Python EPERM은 EOF 이후 리더 회수와 실제 deadline을 구별하지 않는 harness 경계가 있었으나 로그만으로 단일 원인을 확정하지 않았다.
- `.brain-automation/pty-revalidation-report.md`: EOF/EIO 뒤 원래 deadline 내 최대2초 리더 회수, 조기 EOF 오류·실제 deadline 구별, EPERM/미종료를 부재로 간주하지 않고 실제 그룹 정리 유지. 지정 PTY 파일 재검증1차는 SIGTERM 중단 뒤 남은 자기 installer fence 거부, 소유 영수증·그룹 종료·PID/원문 대조 뒤 정확 fence/install lock 복구를 보강했다. 2차는 실제 progress 고유 DB_UNAVAILABLE가 코드2인데1 기대한 오류, 정확 코드2와 고유진단/sequence 단언을 유지해 수정. 3차는 종료0,6/6시험 통과(129.19초). 각 최초 실패 로그 보존, fixture18개 전부 정확ID 부재 확인. 이 변경의 후속 리뷰 뒤 test:changed로 통합 영향 재검증한다.

### 2026-11-06 — r4 최초 회귀 수정 집중 후속
- `.brain-automation/review/r4-regression.md`: 출력언어 검사·installer 인자/절대 home·JSON USAGE2 거부·SIGKILL fence 소유/전체 그룹 종료 뒤 정확 파일 복구와 fresh challenge 재개를 정적 적절로 판정, 새 findings0. 최초9실패는 보존하며 실제 재검증은 이제 수행한다.

### 2026-11-06 — 최초 최종 전체 회귀 처분
- 마지막 구현/후속 리뷰 뒤 `VITEST_MAX_WORKERS=2 pnpm test` → `pnpm test:python`을 전용 PG에서 순차 실행했다. 로그 `.brain-automation/logs/final-20261106T062603Z/`.
- TS 종료1:195파일 중192통과/3실패,4,413통과/9실패/기존skip1. Python 종료0:16파일/69통합시험 통과, 내부 Python244시험 OK. 최초 실패를 소급 통과로 바꾸지 않는다.
- TS 실패 처분: (1) bootstrap 기존 인자 전달시험이 installer가 마지막 호출이라는 옛 순서 기대, relative-home fake의 절대 경로 응답 불일치; (2) 새 오류문 영어 `commit ref`가 한국어 출력 규칙 위반; (3) bootstrap installer는 JSON 옵션을 사용법 오류2/USAGE로 거부하는데 PTY 시험이 DB_LOCKED1 기대; (4) installer SIGKILL 뒤 소유 offline daemon fence가 남아 안전 거부, 실제 소유/전체 자손 종료 확인과 문서화된 수동 잠금 복구 증거 보강 필요. 모두 source/test/안내 최소 수정 뒤 관련 재검증.
- legacy 4실패는 전용 서버 비밀번호를 compose 시험 계약과 다르게 준비한 환경 원인이다(기존 cliWorld fixture는 postgres 고정, 실제 오류 password authentication failed). 두 전체 실행 뒤 정확한21.11 container 라벨/ID를 대조해 자기 서버만 postgres로 맞췄고 관련 회귀 재검증 전까지 미해결로 둔다. 운영/타티켓 자원 변경 없음.
- fixture 자원183개는 모두 removed 최종 이벤트가 있다. remove-failed5건은 중간 이벤트로 보존하며 정확 ID별 최종 부재를 별도로 확인한다. 전용 전체 회귀 PG는 실패 재검증용으로 유지 중.

### 2026-11-06 — r3 집중 후속 리뷰
- `.brain-automation/review/r3-followup.md`: R2S1·R2V1·R2V2·R2V3 모두 정적 해결, 새 findings0. source snapshot 삭제·사용자 변경 보존·legacy 불명 상태 거부와 fixture SQL/소유 PGID/주입 영수증을 대조했다. 실행 성공 판정과 구별한다.
- followup_review_recommended=false. 이제 마지막 구현/리뷰 수정 뒤 최종 TS→Python 순차 전체 회귀로 실제 경계와 정리 결과를 확인한다. 실패/누락이 있으면 built 금지.

### 2026-11-06 — r2 집중 후속 리뷰
- 보고 `.brain-automation/review/r2-source.md`, `r2-verification.md`. 원래 source BH1/EH2·EH1·EH4와 외부 BH2·BH7~10·IA1 정적 해결. 실행은 아직 미확인.
- verdicts: 4 findings — high 0, medium 4, low 0, false 0, maybe-false 0.
- findings:
  - `[medium]` `[patch]` R2S1 cleanup=true라도 부분 삭제 backup이 존재하면 clone/clean 검사를 다시 해 영구거부 — finishAppPromotion이 rmSync 재귀 삭제 중단 상태를 지원하지 않는다. 삭제 전 신원/변경 보호를 유지하며 이미 검증한 소유 삭제 작업을 부분 중단 뒤 재개하도록 수정·단위/외부 시험 보강.
  - `[medium]` `[patch]` R2V1 DB 복원 SQL 이중 escape — 실제 template literal에 역슬래시가 SQL 식별자 앞에 남는다. 시험 정상 종료를 막는 고립 fixture 결함이며 운영 손실 경로는 없으므로 medium. 불필요 escape 제거 및 cleanup 소유 상태 재검사.
  - `[medium]` `[patch]` R2V2 부모 종료 뒤 자손 그룹 추적 제거 — processRun이 children.delete 후 잔존 probe에 실패하면 정리 대상에서 사라진다. 소유 PGID를 부재 증명까지 보존하고 TERM/KILL 후 실제 부재 확인.
  - `[medium]` `[patch]` R2V3 progress/installed 장애 주입 도달 증거 부족 — 다른 중간 실패도 현재 단언을 만족한다. 고유 trigger 진단·fixture 주입 영수증과 정확한 종료 원인을 단언하고 기존 자료/이력 보존 유지.
- 미해결 필수 항목으로 유지. 소스 삭제 계약→시험/자원 계약으로 분할 수정, 새 Terra/medium 구현자 사용(이전 구현자6개 Task 종료). 후속 독립 확인 뒤 최종 회귀.

### 2026-11-06 — r1 독립 thorough 리뷰
- 보고: `.brain-automation/review/r1-{blind-hunter,edge-case-hunter,verification-gap,intent-alignment}.md`. verification-gap은 발견0. 구현/시험 미실행과 기능 실패를 구별한다.
- verdicts: 24개 검토 항목 — high 2, medium 13, low 0, false 9, maybe-false 0. blind10·edge4·intent 표10행을 각각 보존한다.
- findings:
  - `[high]` `[patch]` BH1 완료 승격 정리가 clone/종료 owner를 검사하지 않고 이전 app을 삭제 — installed==ref 조기 분기가 checkClone을 우회하고 finishAppPromotion은 파일 형식만 검사한다. 완료/불완료 복구 모두 소유·신원을 대조하도록 기존 경계 수정.
  - `[medium]` `[patch]` BH2 문서 명령 plugin-root 귀속 시험 누락 — 실제 PTY args에 plugin-root가 없고 fixture plugin 폴더도 없다. 실제 app-ref와 bootstrap을 둔 플러그인 폴더의 문서 명령/설치 기록을 검사.
  - `[medium]` `[patch]` BH3 progress 실패 뒤 oldRef 단언 — promoteStagedApp이 progress 저장보다 먼저다. target app+old backup+owner 연결 및 확정자료 보존을 검사하고 재시도로 이어감.
  - `[medium]` `[patch]` BH4 fixture 초기화 실패 cleanup 누락 — DB rename/admin/proxy 뒤 반환 전 실패는 caller finally 밖이다. 획득 즉시 정리 책임을 등록.
  - `[medium]` `[patch]` BH5 processRun이 자식 하나만 종료 — 일반 bootstrap의 installer/pnpm 자손과 pipe 잔존 가능. 소유 process group에 유예/강제 종료와 잔존 확인을 적용.
  - `[medium]` `[patch]` BH6 interrupt 뒤 부모만 wait하고 lock 삭제 — 그룹/자손 종료 확인 뒤에만 lock 정리하도록 시험 증거 보강.
  - `[medium]` `[patch]` BH7 이전 시도 challenge 재사용 시험 없음 — 실제 과거 문구를 다음 시도에 제출해 무승격/보존·새 nonce를 검사.
  - `[medium]` `[patch]` BH8 확인 대기 중 상태 변경 시험 없음 — prompt에서 synthetic 상태 변경 후 응답해 확인 후 재검사 연결을 검사.
  - `[medium]` `[patch]` BH9 live daemon 외 독립 정지 전제 시험 없음 — enabled/hold/unheld schedule/work/running/open attempt 각각 bootstrap 표면에서 검사.
  - `[medium]` `[patch]` BH10 core migration 이력 접두 비교 없음 — core27 기존 version/name/checksum/applied_at 접두와 새 이력 정상 추가를 단언.
  - `[high]` `[patch]` EH1 PG 성공 뒤 journal 삭제부터 installed 기록 전 중단은 복구 불가 — postgres.ts journal rm과 flow.ts installed.write 사이 실제 도달 가능. 완료까지 소유 증거 수명 보존, 재시도는 새 확인/기존 gate 유지.
  - `[medium]` `[patch]` EH2 완료 복구가 변경된 backup 삭제 — BH1 동일 원인으로 함께 수정, 별도 판정 행 유지.
  - `[medium]` `[patch]` EH3 progress 실패 HEAD 단언 — BH3와 동일 실제 순서, 별도 판정 행 유지.
  - `[medium]` `[patch]` EH4 최초 installed→HEAD 후손 허용과 복구 정확일치의 불일치 — 복구는 검증된 실제 이전 HEAD/선조 계약과 일치시켜 정상 재시도를 유지.
  - `[medium]` `[patch]` IA1 옛 app이 현재 tree의 빈 commit 둘 — 실제 옛 공개 commit의 app과 서로 다른 target tree로 증거를 보강. 옛 DB/manifest fixture 유지.
  - `[false]` `[reject]` IA2 DB/외부 서비스 대역 표면 차이 — 전용 실제 PG+합성 외부 경계는 원문이 요구한 범위이며 실제 운영은21.7 전용.
  - `[false]` `[reject]` IA3 plugin 캐시/문서 명령 표면 차이 — 기술 사실은 BH2에 같은 원인으로 채택했고 별도 추가 결함은 없음.
  - `[false]` `[reject]` IA4 core ledger 단언 차이 — BH10에 같은 원인으로 채택, 별도 추가 결함 없음.
  - `[false]` `[reject]` IA5 npx 추가시험 부재 — 기존 npx 외부 시험을 유지했고 최종 전체 회귀에서 실행할 예정, 신규 중복시험 의무 없음.
  - `[false]` `[reject]` IA6 취소/비TTY/JSON 표면 — 정확한 코드·보존을 검증하며 비TTY 조기거부는 원문 요구가 아님. 실행은 최종 회귀에서 판정.
  - `[false]` `[reject]` IA7 일부 owner 조합이 단위시험 — 외부 경합/중단 시험과 결합해 사용, 새 자식/그룹 검증은 BH5/6으로 채택. 모든 Cartesian 조합 외부 실행 의무는 없음.
  - `[false]` `[reject]` IA8 release ref/version 미변경 — 최종 검증 뒤 이전 구현 commit을 생성한 다음 별도 release commit에서 처리해야 하므로 현재 단계의 결함 아님, 완료 gate로 유지.
  - `[false]` `[reject]` IA9 최종 회귀 실행 증거 없음 — 사용자 개발 중 실행 금지 정책에 맞춘 미실행. 최종 검증 의무 유지.
  - `[false]` `[reject]` IA10 서술적 결론 — 위 표면 차이의 반복이며 별도 결함 없음.
- root grouping: BH1/EH2, BH3/EH3는 각각 같은 수정으로 처리한다. 현재 공개 표면을 늘리지 않고 이미 도달한 상태·시험 계약을 바로잡으므로 patch로 처리한다. deferred 없음. 완료 판정 전 source 계약→시험 보강 순차 수정 및 후속 독립 리뷰 필수.

## Design Notes

ref 선택과 실행 모드만 명시적으로 분리하고 core 설치기 안전 판단은 기존 경계에 둔다. hook 옵션 기본값은 유지한다. 모든 확인은 현재 시도에 결합된 실제 터미널 응답이며 사람의 운영 확인을 자동화하지 않는다.

## Verification

- signed UID 최소 수정·r7 독립 후속 뒤 `pnpm exec vitest run tooling/bootstrap/test/interactive-ref.test.ts`는 종료0,1파일6/6통과(123.03초). 로그 `.brain-automation/logs/final-20261106T062603Z/pty-signed-uid.log`. 앞선 실패를 소급 통과로 바꾸지 않는다. 원래 baseline 영향 회귀 changed-final-r3는 종료0으로 완료했고 아래 최종 검증표에 기록한다.

- 개발/리뷰 수정: `pnpm build`, `pnpm typecheck`, `git diff --check`만 실행. 시험 코드는 작성하고 실행 증거는 최종 회귀에서 채운다.
- 마지막 구현/리뷰 수정 뒤 전용 PG URL·fixture cleanup 로그·격리 Python venv 환경·`VITEST_MAX_WORKERS=2`를 고정하고 `pnpm test` → `pnpm test:python` 순차 각1회. 최초 실패·종료코드·로그를 보존하고 수정 후 `pnpm test:changed -- 1570abe3275585ca0a0e968482b8ca3d8dc8157d` 및 관련 시험으로 재검증한다.
- 전체 실행에서 bootstrap PTY M1~M6 및 기존 hook/npx·legacy·Python 회귀의 선택/완료를 실제 로그와 매핑한다. 새/기존 실패·필수 누락이 있으면 built 금지.
- 소유 container 정확 ID/라벨·DB·role·home/venv 정리 결과·부재 증거 보존. 타 티켓/운영 자원과 워크트리/세션 보존.

## Auto Run Result

구현·독립 리뷰·실패 수정 후 검증과 소유 자원 정리를 완료했다. 검증한 구현을 이전 커밋으로 기록하고 이 release commit에서 그 SHA를 app-ref로 지정하며 version을 함께 올려 built를 확정한다. 아래 구현/리뷰 중 미확정 문장은 각 시점의 이력이며 이 결과와 최종 검증표가 최종 판정이다.

### 변경 파일과 결과

- `tooling/bootstrap/src/bootstrap.ts`: 명시 대화형 ref 모드, 검증한 staged 갱신과 owner/journal/backup snapshot 복구.
- `apps/cli/src/install/postgres.ts`: 승격 owner/previousHead 연결과 완료까지 journal 보존.
- `tooling/bootstrap/bin/second-brain.js`, `plugin/bootstrap.mjs`: 소스와 일치하는 배포 bootstrap.
- `tooling/bootstrap/test/bootstrap.test.ts`: 인자/스트림/신원/잠금/복구·snapshot 단위 회귀.
- `tooling/bootstrap/test/interactive-ref.test.ts`: 옛 공개 commit부터 새 plugin 명령/실제 PTY/합성 PG·보존·중단복구·소유 자원 정리 경계.
- `README.md`: 대상 ref와 새 플러그인 선택·정지/진입차단·현재 확인·안전 실패 복구 안내.
- 이 계획: 원문 전체 계약, triage/실패/검증/운영 인계와 제약 보존.
- 최종 release에서 `plugin/app-ref`와 `plugin/.claude-plugin/plugin.json`을 같은 commit으로 갱신하며 이전 구현 commit을 참조한다.

### 리뷰 처분

r1의24개 판정(high2/medium13/false9)은 Review Triage Log에 각각 기록했고 채택15개는 중복 원인별 최소 수정했다. 거부9개는 합성 경계 허용·다른 finding에 이미 채택·기존 회귀 유지·아직 해당 단계가 아니었던 release/최종 검증 요구·서술 반복이라는 행별 근거를 유지한다. r2의4medium은 snapshot 부분삭제/SQL/자손추적/장애주입 영수증을 수정했고 r3에서 정적 해결을 확인했다. r4~r7의 새 확정 finding은0개다. 후속 필요 판단에 따라 source·시험·실제실패 수정 후 독립 확인을 계속했으며 최종 pass patch0/high0/medium0, `followup_review_recommended=false`, `deferred=[]`다.

### 수락조건과 증거 연결

| 원문 | 구현/실제 검증 경계 | 완료 판정 방식 |
| --- | --- | --- |
| AC1 | 실제 옛 detached commit + core27/Garmin1.0.0 합성 DB에서 지원 명령/현재 PTY 확인·이력 접두/기억/사용자/예약/회계·disabled/hold·교체 전 실행금지 | PTY M1–M6의 최종 실행 결과 |
| AC2 | wrong/EOF/cancel/JSON/nonTTY/hook·현재nonce/정지 후 재검사·한줄 출력/로그와 일반npx | PTY와 bootstrap 기존회귀 최종 실행 |
| AC3 | ref/dirty/repo/ancestor/owner·빌드/승격/PG/installed/cleanup/부분삭제 중단, 변조backup 보존·fresh 재시도 | bootstrap 단위 및 PTY6건 최종 실행 |
| AC4 | 새 plugin folder/app-ref/문서명령과 옛 app의 실제 build/PTY, 호출자의 내부 staged 환경변수 제거 | PTY 실제 종료/진단/보존/승격·기존hook/npx 회귀 |
| AC5 | README·배포 두 파일 일치·필수 전체TS→Python 순차 및 실패별 재검증·이전구현ref/동시version증가 | 원시 full/related/changed 로그와 release commit/원격SHA |
| AC6 | 지원 경로 부재를 재현해 구현했으므로 변경불필요 분기는 사용하지 않음 | AC1~5를 구현·검증하는 경로 유지 |

### 가정·잔여 제약

snapshot 없는 이미 손상된 unknown backup은 사용자 변경과 구별할 증거가 없으므로 보존/거부한다. baseline에 없는 프로토콜의 미배포 중간 구현을 자동삭제하는 새 의무를 만들지 않으며 현재 최종 제품에서 발생하는 snapshot 부분삭제는 지원 재시도 대상이다. 임의의 신원 불명 항목을 삭제하지 않는 보수적 계약을 유지한다.

macOS EPERM의 최초 순간 PGID/state가 기록되지 않아 정확 원인은 미확정이다. XNU의 좀비 그룹 경로는 가능한 근거로만 사용한다. 새 관측은 좀비도 실제 목록에서 소멸해야 성공하고 살아있는 대상EPERM/다른UID/관측오류는 실패한다. signed UID는 정상 시스템 행 형식을 허용하는 최소수정이다. 이 관측/파싱 수정 뒤 PTY6/6 및 영향 회귀 전체가 실제 통과했지만 최초 EPERM의 단일 원인을 소급 확정하지 않는다.

### operator_actions

실제 Mac의 전환·데몬 중지·운영 DB/home/계정/예약과 현재 시도의 사람 응답·새 확장 패키지 교체는21.7의 운영자 조치다. 이 티켓에서 실행하지 않았다. 운영자는 새 릴리스 플러그인과 full app-ref를 선택하고 README 순서대로 옛 데몬 및 모든 자손의 공유 상태 쓰기 종료·새 진입 차단을 재확인한 뒤 실제 TTY의 현재 challenge에 응답해야 한다. 중단 시 신원/owner/영수증을 대조하고 모든 writer가 끝난 검증된 자기 항목만 복구한다. 불명 lock/fence/backup은 임의 제거하지 않는다. 내부 환경변수나 자동확인으로 이 절차를 대신하지 않는다.

### 최종 검증과 자원 결과

최초 필수 전체 `pnpm test` → `pnpm test:python`은 마지막 구현/후속 리뷰 뒤 전용 PG에서 순차 각1회 실행했다. 최초 TS 종료1의9실패와 Python 종료0(16파일69시험·내부244시험)은 위 triage에 보존했다. 실패 수정 후 아래 관련/영향 재검증으로 미해결 실패0을 확인했다.

| 명령/경계 | 최종 결과 | 원시 로그 (`.brain-automation/logs/final-20261106T062603Z/`) |
| --- | --- | --- |
| 지정 PTY6 | 종료0,1파일6/6,123.03초 | `pty-signed-uid.log` |
| `pnpm test:changed -- 1570abe3275585ca0a0e968482b8ca3d8dc8157d` | 종료0; TS199파일4454통과/기존skip1(491.73초) → Postgres42파일681통과(139.42초) → Python16파일69통과(380.76초), 내부244시험 OK | `changed-final-r3.log`, `changed-final-r3-result.json` |
|22.2 main 정상 통합 뒤 build/typecheck | combined shell 종료0, 전체 package build Done와 typecheck 성공 | `snapshot-integration-build.log`, `snapshot-integration-typecheck.log` |
| 통합 지문 관련2파일 | 종료0,25시험 통과,5.93초 | `snapshot-integration-related.log` 및 result JSON |
| 정적 완료 검사 | diff check·배포 두 파일 cmp·검증한 소스7파일 hash 불변·전체 YAML frontmatter 파싱 통과 | 로컬 체크포인트와 final report |

수락된 최신 main `9a9c8d60bc8052851220b9869a737b11aa257f1b`을 scoped stash/fast-forward/apply로 통합했고 티켓8파일 hash 동일·충돌 없음.22.2의 제품 변경2파일은 동일 JSON 토큰의 native SHA 계산이며 Store/root export가 연결되고 SQL/transaction/잠금/fence·schema39/migration/plugin 불변이다. 진행 중 시험은 중단/기준변경 없이 마쳤으며 통합 뒤 필요한 컴파일·지문 회귀2파일을 추가했다. 성능 실측/다른 티켓의 전체 검증을 중복하지 않았다. 원래 baseline은 그대로다.

AC1~4는 최종 PTY6/6와 bootstrap 포함 TS199파일, 기존hook/npx 및 Python 회귀로 확인했다. AC5의 운영 안내·동기화·순차전체/실패재검증을 완료했고 이전 구현 commit `b80b05309d6a7f14a47c7db05a017c54b5bdd2c6`을 app-ref로 지정하며 같은 release commit에서 version을 `0.1.22`로 증가시켰다. AC6 변경불필요 분기는 미사용이다.

전체 실행에서 만든 fixture671개는 raw removed665개와 보존 guard 뒤 별도 정리6개를 구분해 정확ID별 부재를 확인했다(`.brain-automation/final-fixture-absence.json`). 전용 주 PG `brain-2111-final-d973af5cc708`, ID `a3d7f68603e9e9e587f6ffea6541330381f6362e863999fd60a8ebb11afa55a0`은 ticket/run 라벨과 정확 이름을 대조한 뒤 제거하고 부재 확인했다(`.brain-automation/final-main-cleanup.json`). 보존됐던 home6·공유target/bare1은 별도 소유/프로세스/열린파일 증명 뒤 정리했다. 운영/타티켓 자원·워크트리/세션·원시 로그/리뷰/영수증은 보존했다.

22.2 측정창 조율은 중앙의 조기 해제 통지 뒤 즉시 재개했다. 제품 의존 대기나 시험 유예로 전환하지 않았다. 후속 보류 결함은 없고 실제 Mac 운영 인계만 위 operator_actions에 남긴다.

### 릴리스 완료

`plugin/app-ref`는 이전 구현 commit `b80b05309d6a7f14a47c7db05a017c54b5bdd2c6`을 가리키며 수정 bootstrap/설치연결/실제PTY시험을 포함한다. 같은 release commit의 plugin version은 `0.1.22`다. 릴리스 직전 fetch한 원격 main version `0.1.21`보다 크고 ref의40자리형식·기존구현선조·소스/배포일치·동시메타데이터변경을 확인했다. 티켓은 built(운영 인수 done 아님)다. 원격 브랜치 push·최종SHA 확인과 중앙보고 영수증은 로컬 final report/worker 체크포인트에 보존하며 중앙 main 병합/push는 수행하지 않는다.
