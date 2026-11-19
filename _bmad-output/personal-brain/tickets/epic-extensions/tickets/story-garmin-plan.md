---
title: Garmin 새 설치의 공식 로그인 경로
type: bugfix
ticket: 12
created: '2026-11-19'
status: built
baseline_revision: '7d83963c473a5979c50d6e2d8bf8beddc0ca2bc7'
route: full
route_source: pinned
risk: high
review: thorough
review_source: pinned
lenses_ran: [blind-hunter, edge-case-hunter, verification-gap, intent-alignment]
review_loop_iteration: 1
followup_review_recommended: false
context: ['AGENTS.md']
warnings: [oversized]
deferred: []
---

<intent-contract>

## Intent

**Problem:** 새 Garmin 설치에는 공식 인증 진입점이 없다. PostgreSQL 연결 성공만으로는 Garmin 인증 상태를 알 수 없다.

**Approach:** manifest에 공식 인증 어댑터를 선언하고, 사용자 터미널 로그인과 기존 설치 재개 경로에서 각각 실제 인증·연결·예약 결과를 확인한다.

## Boundaries & Constraints

**Always:** Garmin의 기존 자격 증명 처리와 core의 인증·스냅샷·설치 잠금·재개 계약을 재사용한다. 비밀번호·MFA·토큰은 숨김 입력 또는 비공개 저장소로만 다루고 합성 fixture로 검증한다.

**Never:** 운영 홈·DB·계정·토큰·예약 실행·발신·릴리스·marketplace를 변경하지 않는다. 수집용 계정 설정과 예약 등록은 서로 다른 상태로 취급한다.

## I/O & Edge-Case Matrix

| 상황 | 입력과 상태 | 기대 결과 |
|---|---|---|
| 신규 로그인 | 비어 있는 격리 홈, 합성 자격 증명과 MFA | 이름 설치는 인증을 기다린다. 터미널 로그인 뒤 같은 명령을 재개하면 인증·연결·예약 상태를 각각 확인한다. |
| 인증 실패 또는 취소 | 합성 인증 오류, EOF 또는 Ctrl-C | 로그인 실패 또는 취소가 드러나고 재개 시 완료나 예약 성공을 잘못 보고하지 않는다. |
| 기존 사용자의 갱신·재개 | 유효 토큰과 기존 connected 상태 | 프롬프트 없이 토큰을 이용하고 연결 및 기존 예약 상태를 보존한다. 카탈로그의 로그인 필요 표시는 그대로 유지한다. |
| 비밀과 비대화형 실행 | 합성 비밀과 실패 출력, 파이프 실행 | 비밀이 argv·터미널 에코·로그·공개 상태에 나오지 않는다. 비대화형 로그인은 거부한다. |

</intent-contract>

## Code Map

- `extensions/garmin/src/garmin_pipeline/garmin/__init__.py`의 `interactive_login`과 `GarminAdapter.open_session`을 사용한다. `auth.py`의 입력 검증과 기존 감독 로그인 기록 경로를 살핀다. 기존 서비스가 토큰을 식별하는 계정 결합 규칙을 훼손하지 않는다.
- `extensions/garmin/manifest.json`은 원본이다. `tooling/package-garmin/build.mjs`가 배포본·digest를 생성한다. 패키지 내용 변경에 맞춰 확장 버전을 올린다.
- `apps/cli/src/commands/ext-login.ts`는 제어 터미널과 확장 설치 잠금으로 `--terminal` 진입점을 실행한다. `packages/core/src/extensions/install.ts`는 인증 일감·연결 확인·예약과 재개 기록을 책임진다. `extensions/garmin/src/check.py`는 DB 역할을 확인한다.

## Tasks & Acceptance

**Execution**

- [x] 1. Garmin 원본 manifest·`extensions/garmin/src`·`extensions/garmin/tests`에 인증 진입점과 합성 시험을 작성하고 배포 패키지를 생성한다. `--terminal`은 실사용자 입력 전용이다. 기존 감독 인증 호출은 토큰으로만 인증하고, 토큰이 없거나 유효하지 않으면 공개 `LOGIN_REQUIRED`를 돌려준다. 토큰 확인과 PostgreSQL 연결 확인을 각각 수행한다. 입력·라이브러리 오류·취소 경로에 비밀이 남지 않게 한다.
- [x] 2. `apps/cli/src/commands/ext-login.ts`·`packages/core/src/extensions/install.ts`와 직접 관련 시험에 이름 설치·재개 계약을 연결한다. 인증 결과를 실제 상태에 반영하고 기존 인증 일감·연결·예약 계약과 유효 토큰을 보존한다. 합성 터미널 로그인과 이름 재개로 성공·실패·취소·유효 토큰 상태를 검증한다. 새 공개 계약이 필요하면 공유 schema·fixture·guide를 함께 갱신한다.
- [x] 3. `plugin/skills/brain-login/SKILL.md`와 `plugins/garmin/skills/brain-garmin-install/SKILL.md`의 안내를 실제 CLI 계약에 맞추고 해당 coverage·스킬 계약 시험을 갱신한다. 카탈로그 인증 요구와 현재 로그인·연결·예약 상태를 구별한다.

**Acceptance Criteria**

- Given 토큰 없는 격리 Brain, When 공식 CLI로 합성 Garmin 인증을 마치고 이름 설치를 재개하면, Then 실제 인증과 연결 및 등록 상태를 단계별로 조회할 수 있고 합성 비밀은 공개 표면에 나오지 않는다.
- Given 연결 확인 또는 스케줄러가 실패할 수 있는 격리 환경, When 인증 성공·실패·취소 뒤 이름으로 재개하면, Then 서로 다른 실패 및 완료 상태를 관찰할 수 있다.
- Given 유효한 기존 토큰·연결·예약, When 설치·상태·카탈로그를 확인하면, Then 재인증이나 중복 등록 없이 현재 상태와 패키지 메타데이터가 각각 보인다.

## Implementation Notes

- Task 1 `task_077bdd8e29fb`가 Garmin 터미널·감독 인증 진입점, 합성 pytest, 확장 버전 1.2.16의 생성 배포본을 제출했다. build·typecheck·diff 검사 종료 0, 시험 실행은 마지막 수정 뒤로 보류했다. 상세 보고 `.brain-automation/tickets/13.12/task-1-result.md`.
- 터미널 인증은 Garmin 토큰을 얻고 기존 PostgreSQL 역할 확인과 등록된 예약은 별도 확인한다. 신설 수집 계정 결합과 실제 수집 실행에는 별도 절차가 필요하다. 기존 결합 증거·토큰 파일을 인증 확인이 갱신하거나 덮어쓰지 않도록 한다.

- Task 2 `task_141b856dae2a`가 선택 manifest 계약 `auth.probe_on_install`, 설치 전 무인 토큰 확인, 터미널 실패·취소 상태 기록, 합성 PTY·실제 패키지 설치 통합 시험을 제출했다. 기존 토큰은 비공개 사본으로 검사한다. 배포 패키지 생성·build·typecheck·diff 검사 종료 0, 시험 미실행. 상세 보고 `.brain-automation/tickets/13.12/task-2-result.md`.

- Task 3 `task_b104d631bfb6`이 core 로그인·설치, Garmin 설치의 세 배포 스킬과 관련 시험을 갱신했다. typecheck·diff 검사 종료 0, 시험 미실행. 상세 보고 `.brain-automation/tickets/13.12/task-3-result.md`.

- 수정 Task 4 `task_225c2bb9b54f`가 opt-in 무인 확인의 큐 분리, 메모리 토큰 검증 및 차단 보존, 공개 결과·스킬, unittest 전환을 제출했다. build·typecheck·diff 검사 종료 0, 시험 미실행. 상세 보고 `.brain-automation/tickets/13.12/fix-1-result.md`.

- 수정 Task 5 `task_4368ca9809ad`가 실제 이름 설치·PTY·구버전 package 전환과 격리 회귀 fixture를 보강했다. typecheck·diff 검사 종료 0, 시험 미실행. 상세 보고 `.brain-automation/tickets/13.12/fix-2-result.md`.

- 수정 Task 6 `task_fa878af18bd0`이 원격 refresh 없는 인증 확인, 원자적 터미널 저장, 기존 상태 보존, PID SIGINT와 격리 실패 폐쇄·자원 정리를 제출했다. build·typecheck·diff 검사 종료 0, 시험 미실행. 상세 보고 `.brain-automation/tickets/13.12/fix-3-result.md`.

- 수정 Task 7 `task_713533af7fea`이 DI 저장 검증, 디렉터리 핸들 기반 잠금 및 발행, 게시 전후 취소 분리, 결합 보호 뒤 재검사와 PTY 초기화 증명을 제출했다. build·typecheck·diff 검사 종료 0, 시험 미실행. 상세 보고 `.brain-automation/tickets/13.12/fix-4-result.md`.

- 수정 Task 8 `task_8945b81f0e53`이 CLI 신호 수명과 일반 자식 종료, 고정 핸들의 차단 상태 및 PTY 그룹 회수를 수정했다. build·typecheck·diff 검사 종료 0, 시험 미실행. 상세 보고 `.brain-automation/tickets/13.12/fix-5-result.md`.

- 수정 Task 9 `task_0f5201abd3a6`이 설치 잠금 대기를 취소할 수 있게 하고 일반 인증 helper의 stderr와 PTY EOF를 정리했다. build·typecheck·diff 검사 종료 0. 상세 보고 `.brain-automation/tickets/13.12/fix-6-result.md`.

- 수정 Task 10 `task_6470bc8522d0`이 실행 전 취소의 이전 저널 보존과 첫 검증 실패의 원인을 수정했다. Node 설정 대기의 이벤트 루프, 스킬의 비밀 보호 문장, 마지막 PTY 데이터 회수, macOS archive 경로를 보강했다. build·typecheck·diff 검사 종료 0. 상세 보고 `.brain-automation/tickets/13.12/fix-7-result.md`.

- 수정 Task 11 `task_06821e8742e5`이 설치 스킬에서 기존 결합 보존과 지원 요청의 두 문장을 분리했다. 금지 정규식을 유지했다. diff 검사 종료 0. 상세 보고 `.brain-automation/tickets/13.12/fix-8-result.md`.

- 수정 Task 12 `task_06487015716b`가 기존 core 통합의 합성 DI 토큰·결합 fingerprint와 기존 Python 차단 mock을 새 계약에 맞췄다. 제품 및 배포본 파일은 변경하지 않았다. typecheck·diff 검사 종료 0. 전문 `.brain-automation/tickets/13.12/fix-9-result.md`.

## Plan Change Log

- 리뷰 1차에서 무인 검사와 기존 감독 인증 일감을 한 확장의 같은 단계에서 중복 실행할 때 결과가 섞이는 문제를 확인했다. opt-in 분기를 동기 무인 확인으로 분리하고 미선언 확장은 기존 큐 동작을 유지한다. 터미널 입력 보호, package 전환·토큰 보존, 연결·예약의 분리 및 전체 이름 경로는 유지한다.

## Review Triage Log

### 2026-11-19 — 독립 리뷰 1차

- 판정 33건. 높음 4, 중간 28, 낮음 1. 네 전문은 `.brain-automation/tickets/13.12/review-1-*-result.md`에 있다. 같은 원인에 대한 지적도 개별 기록했다.
- BH-1 중간, 수정. 무인 실패가 다음 설치의 사전 차단 조건과 일치한다. 무인 오류는 재시도하고 터미널 오류와 구별한다.
- BH-2 높음, 수정. 토큰 검사가 현재 인증을 거부해도 과거 일감 성공의 분기에 들어간다. 명시적 opt-in은 현재 검사 결과만 승인 근거로 삼는다.
- BH-3 중간, 수정. Garmin 내부 차단 파일의 경로가 사본이다. 원본의 세션 락 아래 검증된 차단 상태를 보존한다.
- BH-4 중간, 수정. 결합 파일이 있으면 터미널 진입점이 거절한다. 결합 보호를 유지하고 별도 공개 코드로 복구 필요를 알린다.
- BH-5 높음, 수정. 프로세스 강제 종료에서 Python 정리가 실행되지 않는다. 사본 없는 검사 또는 부모가 수명과 회수를 책임지는 검사로 바꾼다.
- BH-6 중간, 수정. 외부 패키지는 이름 resolver의 원본을 보장하지 않는다. Garmin 공식 이름 경로와 일반 임의 경로 안내를 구분한다.
- BH-7 중간, 수정. Python 스크립트 디렉터리의 `pty.py`가 표준 모듈을 가린다. 파일명과 fixture 단언을 고친다.
- BH-8 중간, 수정. 동일 digest 재개를 다룬다. 이전 버전에서 이름 설치로 전환하는 시험을 추가한다.
- EC-1 중간, 수정. BH-7과 같은 Python 모듈 검색 규칙이다.
- EC-2 중간, 수정. BH-1과 같은 `prior.status` 선행 차단을 확인했다.
- EC-3 중간, 수정. BH-3과 같이 기존 어댑터의 403·429 기록이 사본 정리 대상이다.
- EC-4 높음, 수정. BH-5와 같이 감독자가 자식을 종료할 수 있다.
- EC-5 중간, 수정. 일감 미발견도 150회 검사한다. opt-in에서 일감 생성·취소 중복 경로를 제거한다.
- EC-6 높음, 수정. 성공 분기의 취소에는 기존 kind·target 검사가 없다. opt-in의 일감 취소를 제거한다.
- EC-7 중간, 수정. BH-2와 같이 이전 성공이 최신 무인 결과를 덮는다.
- EC-8 중간, 수정. spawn 실패와 SIGINT가 고정 코드로 구별되지 않는 조건을 확인했다. 선언된 오류 계약과 신호를 기준으로 처리한다.
- EC-9 중간, 수정. Garmin 스킬의 일반 설치 완료·오류 경로에 최종 상태 재조회가 명시되어 있지 않다. 실제 공개 결과 재확인을 명시한다.
- EC-10 중간, 수정. BH-8과 같이 package identity 교체를 거치지 않는다.
- EC-11 중간, 수정. 크기 상한이나 형식 검증 오류가 일반 장애로 흡수된다. 교체 가능한 미결합 무효 토큰과 결합 계정의 복구 필요를 구별한다.
- IA-1 중간, 수정. 로그인 직후와 재개 시 결과가 어긋날 수 있다. 공개 단계에서 터미널 성공 뒤 검증 대기 및 취소를 각각 관찰하도록 한다.
- IA-2 중간, 수정. BH-8과 같은 전환 검증 공백이다.
- IA-3 중간, 수정. 카탈로그가 배포본 1.2.16을 반환하지만 기존 단언은 1.2.15다. 공개 metadata와 실제 상태를 같은 시험에서 확인한다.
- IA-4 중간, 수정. 대기 감독자 실패는 시험하지만 DB 역할 검사 실패의 격리 단언은 없다. 인증 성공 상태와 미등록 예약을 확인하도록 한다.
- IA-5 중간, 수정. 실패 비밀 및 공개 응답·로그·argv의 노출 검사가 빠졌다. 실제 합성 입력과 표면을 보강한다.
- IA-6 중간, 수정. 명령 힌트가 일반 감독 인증 확장까지 적용된다. opt-in 및 입력 경로에 맞춘 문구를 사용한다.
- VG-1 중간, 수정. IA-3과 같은 카탈로그 기대값 회귀를 확인했다.
- VG-2 중간, 수정. Python 기본 실행기가 unittest이고 pytest 비의존이다. 기존 테스트 러너가 수집할 수 있게 전환한다.
- VG-3 중간, 수정. 첫 설치의 대기 일감이 남는지 확인하지 않는다. opt-in은 일감 없이 동기 검사를 수행하므로 인증 일감이 남지 않는 직접 단언으로 검증한다.
- VG-4 중간, 수정. PTY exit 및 단계 코드만으로 취소의 최상위 공개 결과를 확인할 수 없다. CLI JSON·공개 저널을 각각 검사한다.
- VG-5 중간, 수정. BH-8과 같은 증거 공백에 실제 package 전환을 추가한다.
- VG-6 중간, 수정. IA-4와 같은 연결 실패와 인증 성공의 분리 검증을 추가한다.
- VG-7 낮음, 수정. 실패 비밀번호가 기존 검색 정규식 바깥이다. 동일한 합성 비밀 표식을 사용한다.
- VG-8 중간, 수정. BH-2와 같은 최신 결과 우선 계약을 확인했다.

### 2026-11-19 — 독립 후속 리뷰

- 1차 33건 중 해결 24, 부분 해결 9. 전문 `.brain-automation/tickets/13.12/followup-1-result.md`.
- F-1 높음, 수정. 고정 Garmin 라이브러리가 인라인 토큰으로도 원격 refresh를 수행해 저장 토큰을 무효화할 수 있다. 설치 probe의 갱신 호출을 막는다.
- F-2 중간, 수정. 내부 refresh 장애가 삼켜져 공개 오류·차단 분류를 우회한다. 같은 무갱신 probe에서 실제 응답만 분류한다.
- F-3 높음, 수정. 결합 보호 거부와 spawn 오류가 정상 저널을 고정 실패로 갱신한다. 기존 증거 보존과 터미널 장애 재시도를 검증한다.
- F-4 중간, 수정. 부모 PID만 받는 SIGINT가 자식의 종료를 유도하지 않는다. 자식에게 전달하고 종료 후 반환한다.
- F-5 높음, 수정. 기존 라이브러리의 토큰 저장 예외 처리에서 KeyboardInterrupt는 빠진다. 원자적 저장과 취소 정리를 보강한다.
- F-6 중간, 수정. 공통 스킬이 외부 경로의 이름 재개를 지시한다. 원본 인자를 유지한다.
- F-7 높음, 수정. 일반 sitecustomize 초기화 예외를 CPython이 삼켜 테스트에서 실제 호출이 가능하다. 전송 전에 실패 폐쇄한다.
- F-8 중간, 수정. 감독자 준비 실패 또는 stop 실패가 fixture 정리를 우회한다. 소유 자원 해제를 각각 보장한다.
- F-9 중간, 수정. 공통 fixture의 Garmin profile/query 직접 호출처를 파일 지정 검증에 더한다.

### 2026-11-19 — 두 번째 독립 후속 리뷰

- F-2, F-4, F-6, F-8, F-9 해결, F-1은 시험 보강, F-3·F-5·F-7은 부분 해결. 전문 `.brain-automation/tickets/13.12/followup-2-result.md`.
- F2-1 높음, 수정. JWT_WEB 대체 로그인에서 DI가 비어도 파일 교체 후 성공을 반환한다. 교체 전에 저장 가능성을 확인한다.
- F2-2 높음, 수정. 공식 저장이 논리 경로만 확인해 링크 대상에 토큰을 쓸 수 있다. tokenstore 검증·잠금·발행 단위를 일치시킨다.
- F2-3 높음, 수정. 취소가 게시된 토큰과 미완료 저널을 엇갈리게 한다. 게시 경계를 확정하고 임시 비밀을 정리한다.
- F2-4 중간, 수정. 결합 보호 거부가 아직 연결 확인을 못 한 설치의 다음 토큰 검사를 차단한다. 실제 복구 뒤 검사한다.
- F2-5 높음, 수정. 시험의 부모 Python 경로가 합성 sitecustomize를 가릴 수 있다. 초기화 격리를 입력 전에 확인한다.
- F2-6 중간, 수정. 별도 PID 취소 시험은 준비 실패에서 프로세스가 남을 수 있다. 조기 종료 및 실패의 소유 정리를 보강한다.
- F2-7 중간, 수정. 선제 갱신 억제를 확인하는 기존 JWT 헤더가 유효하지 않다. 유효한 만료 토큰으로 분기 진입을 명시한다.

### 2026-11-19 — 세 번째 독립 후속 리뷰

- F2-1·4·5·6·7 해결, F2-2·3 부분 해결. 전문 `.brain-automation/tickets/13.12/followup-3-result.md`.
- F3-1 높음, 수정. 자식 close에서 부모 SIGINT 구독을 해제하고 그 뒤 저널 연결 작업이 남는다. 공식 인증 단계가 완료될 때까지 구독 수명을 늘린다.
- F3-2 중간, 수정. 디렉터리 이동 중 lock과 차단 파일의 대상이 분리되고 fsync 후 원본을 확인하지 않는다. 열린 디렉터리 기준의 차단과 게시 검증을 적용한다.
- F3-3 중간, 수정. 일반 인증 진입점의 SIGINT 무응답에서 CLI가 설치 잠금을 놓지 못한다. 일반 경로의 제한된 종료 동작을 복원한다.
- F3-4 중간, 수정. PTY guard 오류·timeout에는 waitpid 및 그룹 단위 회수 확인이 없다. 시험 소유 프로세스와 파일 정리를 맞춘다.

### 2026-11-19 — 네 번째 독립 후속 리뷰

- F3-1~F3-4의 원래 재현 조건은 모두 해결. 전문 `.brain-automation/tickets/13.12/followup-4-result.md`.
- F4-1 중간, 수정. 부모 신호를 잠금 대기부터 무조건 잡으면 취소한 사용자의 프롬프트가 다시 시작한다. 시점별 취소를 구분한다.
- F4-2 중간, 수정. 일반 엔트리의 하위 실행자가 stderr를 보유하면 직계 자식 종료 뒤에도 close가 대기한다. 일반 경로의 강제 종료 한도에서 pipe 수명을 정리한다.
- F4-3 중간, 수정. 우회 SIGINT 리스너 자체가 시험의 기본 종료를 방지한다. 게시 이후 저널 보호를 제품 핸들러만으로 검증한다.
- F4-4 중간, 수정. PTY EOF 직후 단 한 번의 wait 상태 확인은 정상 종료와 경합한다. 동일 deadline 내 reap을 기다린다.

### 2026-11-19 — 다섯 번째 독립 후속 리뷰

- F4-1~F4-4의 원래 재현 조건은 모두 해결. 전문 `.brain-automation/tickets/13.12/followup-5-result.md`.
- F5-1 중간, 수정. 첫 로그인 성공 후 토큰 검증 대기에서 두 번째 명령의 시작 전 취소가 기존 저널을 덮는다. 자식 시작 전 반환은 실행 결과의 저널 갱신을 건너뛴다.

### 마지막 수정 독립 재확인

- F5-1 해결. 자식 실행 전 취소는 기존 토큰 검증 대기의 저널 및 revision을 보존한다. 실제 CLI 취소 시험을 추가했다.
- 이전 시험 실패에 대응한 SIGINT 준비 타이머, PTY 마지막 출력, 구버전 archive의 실제 경로를 정적 검토했다. 해당 범위에서 새 차단은 없었다. 전문 `.brain-automation/tickets/13.12/followup-6-result.md`.
- 이후 수정은 core 설치 스킬의 두 문장에 한정했다. 변경 내용을 대조하고 보호 계약을 검사하는 스킬 시험을 재실행했다.

- 마지막 두 합성 시험 수정의 독립 확인은 토큰·fingerprint, 예약·리포트 보존 및 403·429 차단 단언을 유지한 것을 확인했다. 전문 `.brain-automation/tickets/13.12/followup-7-result.md`.

## Verification

- 구현 및 리뷰 반영 동안 `pnpm build`, `pnpm typecheck`, `git diff --check`만 실행한다.
- 마지막 리뷰 반영 뒤 변경하거나 직접 영향 받는 Vitest·pytest 파일만 지정한다. 명령과 종료 코드를 기록한다. 전용 시험 DB·합성 홈·가짜 launchctl과 `~/.brain-operations/test-lock`을 사용하고 소유 자원을 정리한다. 전체 회귀는 중앙 통합에서 실행한다.

### 첫 파일 지정 검증

- TypeScript 관련 14파일에서 12파일 통과, 2파일 실패. 총 628 통과, 2 실패, 종료 1. 상태 대기 SIGINT fixture가 이벤트 루프 유지 없이 종료 13을 냈고, 지원 요청과 토큰 보존이 한 문장이어서 비밀 보호 판정과 충돌했다.
- 공식 로그인 통합 시험 6 통과, 2 실패, 종료 1. PTY envelope와 macOS 구버전 archive 검사에 실패했다.
- Garmin `test_official_auth` unittest 16 통과, 래퍼 Vitest 1파일·1시험 통과 및 종료 0. Source 인증 코드는 Task 10에서 변경되지 않았다.
- 실행 명령은 `.brain-automation/tickets/13.12/final-*.command`, 첫 실패 로그 보존본은 `verify-first-ts.log`, `verify-first-official.log`다.


### 파일 지정 재시험

- `retry-ts`에서 CLI 재시험 12통과 및 관련 스킬까지 31통과, core 설치 스킬 문구 1실패로 종료 1. 실패한 문구는 Task 11에서 보완했다.
- `retry-official`에서 실제 배포 패키지 합성 TTY·토큰 보존·구버전 digest 전환·실패와 재개·연결 및 예약 구분 9통과, 종료 0.
- `final-skills`에서 설치 스킬·Garmin 배포 스킬·CLI coverage 3파일·20시험 통과, 종료 0.
- 기존 직접 Garmin 회귀 10파일의 최초 실행은 파일 7통과·3실패, 시험 38통과·8실패로 종료 1. 6건은 기존 합성 bound token이 DI 형식과 달랐고 1건은 차단 mock이 새 선택 인자를 받지 못했다. Task 12에서 두 시험 입력을 보완했다.
- 같은 실행에서 모델 자식 종료 판정 1건이 실패했다. 제품·시험 변경 없이 `garmin-report.test.ts`에서 해당 케이스만 선택한 재실행은 1통과, 17선택 제외, 종료 0이다. 첫 실패 원인은 단정할 수 없다.
- `retry-python-regression`은 core와 백필 2파일·7시험 및 내부 Python unittest 87시험이 통과했고 종료 0이다. 기존 직접 파일의 실패 8건 모두 해당 재실행에서 통과했다.
- 격리 PostgreSQL·임시 홈·가짜 launchctl과 공용 시험 잠금을 사용했다. 시험 장부 20개 완료, 남은 lease 0, 기록된 직접 컨테이너 6개 및 각 run label의 남은 컨테이너 0, 잠금 해제를 확인했다.
- 시작 명령, 로그 및 종료 코드는 `.brain-automation/tickets/13.12/`의 `*.command`, `*.log`, `*.exit`에 기록했다. `final-cleanup.json`에 자원 확인을 남겼다.

## Auto Run Result

상태는 built다. 공식 Garmin 터미널 인증과 이름 설치 재개를 구현했다. 최초 공식 설치는 Garmin 자격 증명을 기다리고, 터미널에서 성공하면 저장 토큰 확인 대기가 된다. 같은 이름의 설치에서 Garmin 인증, PostgreSQL 연결, 예약 등록을 각각 확인한다. 실패와 취소는 공개 결과로 구별되며 카탈로그의 인증 필요 표시는 패키지 메타데이터다.

- `apps/cli/src/commands/`과 core 확장 설치·manifest·공개 오류 계약을 갱신했다. 명시적으로 선언한 패키지만 현재 토큰을 무인 확인하며 기존 확장의 감독 일감은 기존 계약대로 실행된다.
- `extensions/garmin/src/auth.py`와 배포본은 보호된 터미널 입력, 비밀 파일 게시와 안전한 취소, 원격 토큰 갱신 없이 기존 토큰 확인을 구현한다. 선택 manifest·공유 schema fixture·배포 스킬과 직접 시험을 맞췄다. 패키지 버전은 1.2.16이고 digest는 `70cda187e12e6ebf4013d21b5cb7c3c70b406cc5ce582d9bf9748d86ee76a514`다.
- 독립 4렌즈에서 발견한 33건과 후속 지적을 수정했다. 후속 리뷰 및 실제 재시험으로 해당 수락 경계를 확인했다. 별도 후속 리뷰 권고는 없다.
- `pnpm build`, `pnpm typecheck`, `git diff --check` 종료 0. 파일 지정 시험과 실패 재검증, 자원 정리를 위에 기록했다. 전체 `pnpm test`, `pnpm test:python`, `pnpm test:changed`는 중앙 통합 소관이다.
- 결합된 계정의 액세스 토큰을 확인하지 못하면 고정 상태를 보고하고 비공개 토큰·결합을 그대로 보존한다. 신규 수집 계정 결합과 실제 예약 발화는 포함되지 않는다. 리포트 자식 종료 단일 실패는 격리 재실행에서 통과했으며 최초 실패 원인은 확인하지 못했다.
