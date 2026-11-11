---
title: '사람 개입 없는 기존 Brain 갱신'
type: feature
ticket: ''
created: '2026-11-11'
status: built
baseline_revision: '7b61fa3b85ea9653d78fd5a3d134ee0ea2b2e5b8'
route: full
route_source: pinned
risk: high
review: quick
review_source: pinned
lenses_ran: [quick]
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**문제:** core commit이 바뀔 때 설치기는 매번 무작위 offline 확인 문구를 요구하여 SessionStart 자동 갱신을 막는다. 기존 홈에서도 최초 설치 질문을 반복한다.

**접근:** 운영자 문구를 자동 정지·검증으로 교체하고 기존 설치의 선택을 보존한다. 비대화형 bootstrap이 migration과 app 승격·완료 기록까지 수행하며 실패 원인을 로그와 doctor에 남긴다.

## Boundaries & Constraints

**항상:** 기존 설치·데몬·확장 fence와 migration 신원 검증을 유지한다. 이전 프로세스와 자식 종료가 증명되지 않으면 안전하게 중단한다. 기존 journal의 operator 기록은 읽되 새 시도에서는 재검증하고 automatic 근거를 남긴다. 새 필수 선택은 기본값을 적용하고 출력한다. 최초 설치의 질문은 유지한다.

**제외:** 운영 Brain·중앙 checkout/state 변경, 전체 티켓 자동화 재개, plugin/app-ref와 plugin version 변경. 개발 중 시험은 실행하지 않고 마지막 구현·독립 리뷰 수정 후에만 전체 회귀를 순차 실행한다. 자기 브랜치만 push한다.

## I/O & Edge-Case Matrix

| 상태 | 입력 | 결과 | 실패 처리 |
|---|---|---|---|
| 기존 설치 | config와 installed 기록, 다른 commit | 기존 선택을 무질문 재사용하고 migration·승격 완료 | 검증 실패 시 완료 기록을 쓰지 않음 |
| 이전 실행 있음 | 데몬 또는 홈 소유 프로세스·자식 | 진입을 막고 종료를 확인 | 불명확한 소유권·종료는 DB_LOCKED와 재시도 안내 |
| 중단된 갱신 | 기존 journal | operator·automatic 읽기 호환, 현재 정지 재검증 | 타 소유자 기록은 보존 |
| 최초 설치 | installed 기록 없음 | 기존 동의·설정 질문 유지 | 기존 입력 검증 유지 |
| 자동 갱신 실패 | SessionStart 비대화형 | 원인을 bootstrap.log와 doctor에 표시 | 세션 진행은 허용 |

## 중앙 승인 추가 수락조건

- Given 다른 Claude/Codex 세션의 수집 hook, when migration이 진행되면, then DB 쓰기 대신 기존 spool로 보류되고 갱신 뒤 drain된다.
- Given 자동 갱신을 시작한 SessionStart, when 자기 hook이 실행되면, then 설치와 교착하지 않는다.
- Given 정지 검증 실패, when 설치가 중단되면, then 이전 app과 완료 기록을 유지하고 기존 daemon을 재개하여 수집이 계속된다.

</frozen-after-approval>

## Code Map

- `apps/cli/src/install/postgres.ts`: 설치 잠금 아래 daemon fence·확장 advisory lock·quiesce·migration·승격 수행. 기존 신원 재검증을 재사용한다.
- `apps/cli/src/daemon/control.ts`, `daemon/lock.ts`: launchd bootout·종료 대기·future-boot fence. 죽은 부모만으로 자식 종료를 추정하지 않는다.
- `apps/cli/src/install/flow.ts`, `install.ts`: 질문·설정 재사용·완료 기록·daemon 등록 경로.
- `plugin/bootstrap.mjs`: SessionStart staged install, 중단 승격 복구, bootstrap 상태 기록.
- `apps/cli/src/doctor/checks.ts`: plugin 갱신 실패 표시.
- `apps/cli/test/install-*.test.ts`, `packages/postgres/test/install-*.test.ts`, `plugin/test/`: 기존 설치·offline·bootstrap 수락 시험.
- `README.md`, `skills/`: 배포 설치·갱신 안내를 실제 무인 동작과 일치시킨다.

## Tasks & Acceptance

**실행:**
- [x] `apps/cli/src/install/postgres.ts`, `daemon/`, `runtime/`: 자동 정지와 프로세스 검증을 기존 fence와 결합하고 automatic 근거를 기록한다.
- [x] `apps/cli/src/install/flow.ts`, `install.ts`: 기존 홈 인식 후 선택 질문을 생략하고 기존 값과 연결을 보존한다.
- [x] `plugin/bootstrap.mjs`, `doctor/checks.ts`: automatic journal 복구와 실패 진단을 연결한다.
- [x] 설치·Postgres·bootstrap 수락 시험: 아래 동작을 회귀 시험으로 남긴다.
- [x] `README.md`, 배포 설치 스킬: 갱신 안내와 공개 동작을 갱신한다.

**수락 기준:**
- Given 기존 설치와 비대화형 자동 갱신, when core commit이 바뀌면, then 질문 없이 migration·승격·완료 기록이 끝나고 automatic 정지 근거가 남는다.
- Given 이전 실행·자식이 남거나 소유권 검증이 실패하면, when 갱신하면, then migration을 시작하지 않고 구체적 재시도 오류를 남긴다.
- Given 기존 mirror·update.auto·timezone·하네스 선택, when TTY에서 갱신하면, then 질문 호출 없이 같은 선택을 보존한다.
- Given 새 필수 선택이 빠진 기존 설치, when 비대화형 갱신하면, then 기본값을 적용하고 출력한다.
- Given 최초 설치, when TTY로 설치하면, then 기존 설치 질문이 유지된다.
- Given hook 갱신 실패, when 세션이 시작하면, then 세션을 차단하지 않고 bootstrap.log·doctor에서 원인을 찾을 수 있다.

## Implementation Notes

- 중앙 추가 승인에 따라 전용 cluster의 소유 runtime 역할만 임시 NOLOGIN으로 전환한다. 원래 login 상태를 변경 전에 기록하고 finally·다음 설치기에서 복구하며 관리자 역할과 다른 DB는 변경하지 않는다.
- 작업 Dispatch가 구현·리뷰·검증·커밋·자기 브랜치 push를 승인하며 구현자는 직접 작업한다. 독립 Codex gpt-6.1-sol/medium 리뷰어 한 명만 배정한다.

## Plan Change Log

## Review Triage Log

### 독립 리뷰 1차 triage

| finding | 판정·경로 | 근거·수정 |
|---|---|---|
| 1 중단 승격 사전 검증 | high / patch | hookMode에도 validateInterruptedPromotion을 연결하고 operator·automatic 복구 및 변조 거부 시험 추가 |
| 2 crash 로그인 복구 차단 | high / patch | journal에 installer PID·target commit·process group 신원을 저장하고 죽은 동일 설치기의 daemon fence만 그룹 종료 검증 후 회수; 실제 설치기 SIGKILL·재실행 시험 추가 |
| 3 고아 자식 종료 증명 | high / patch | 최초 스캔의 process group을 유지하고 durable work_attempts의 리더·boot 신원을 기존 inspectGroup으로 검증; 살아 있거나 관측 불명이면 중단; 실제 고아 그룹 시험 추가 |
| 4 역할 상속·집합 누락 | high / patch | 양방향 membership과 모든 brain_ext 역할 marker·집합을 검증하고 불명확하면 NOLOGIN 전에 거부; DB owner와 전용 cluster도 검증 |
| 5 옛 응답 기대 | medium / patch | 반환 문자열 거부 기대를 자동 검증 예외 주입으로 교체하고 TTY 무질문 계약으로 수정 |
| 6 실제 backend·중단 증거 누락 | high / patch | brain_app·확장 역할의 열린 실제 backend 종료, 실제 설치기 SIGKILL 및 daemon fence 자동 복구를 수락 시험에 추가 |

- 개발 중 시험은 실행하지 않았으며 build·typecheck만 실행했다. 후속 독립 리뷰 뒤 마지막 전체 회귀를 순차 실행한다.

### 독립 리뷰 2차 triage

| finding | 판정·경로 | 근거·수정 |
|---|---|---|
| 직접 확장 명령의 고아 그룹 | high / patch | spawn 전 intent·spawn 뒤 boot/leader/group 신원을 파일로 영속화하는 launcher를 실제 확장 runtime에 연결; 옛 기록 없는 프로세스는 상속 cwd도 조사; 실제 영속 기록·고아 거부 시험 추가 |
| 설치기 자식의 crash 신원 | high / patch | NOLOGIN 이후 승격 git 자식도 같은 trackedExec 경로 사용; 실제 설치기가 자식을 남기고 SIGKILL된 뒤 재시도 거부·그룹 종료 후 복구 시험으로 보강 |
| legacy 공유 cluster fixture | high / patch | legacyWorld와 CLI proxy·관리자 접속을 모두 전용 disposable cluster로 변경 |

### 독립 리뷰 3차 triage

| finding | 판정·경로 | 근거·수정 |
|---|---|---|
| 검사 뒤 직접 명령 진입 경합 | high / patch | 현재 직접 명령을 홈 설치 잠금으로 직렬화하고 NOLOGIN·backend 종료·확장 advisory lock 획득 뒤 process registry와 DB 그룹을 재검증; 설치 잠금 중 직접 명령 진입 거부 시험 추가 |
| trackedExec 출력 실패 정리 | high / patch | finally에서 기존 cleanProcessGroup으로 종료를 요청·확인하고 출력을 닫음; 종료 불명은 기록 보존·명확한 오류; 실제 출력 초과 자식 종료 시험 추가 |

## Verification

- 첫 전체 회귀는 `pnpm test` 5413 통과·14 실패, 이어서 `pnpm test:python` 86 통과·5 실패였다. 두 명령을 순차 한 번씩 실행했으며 실패를 숨기지 않고 원인별로 수정했다.
- DB rename과 역할 marker를 함께 갱신하는 fixture, 실제 정지 가능한 daemon fixture, 옛 offline 기대, Python fixture 호환 범위를 수정했다. installed 기록 재조회와 불필요한 초기 export 접근도 제거했다.
- 관련 재검증은 TypeScript 5개 파일·174건과 실제 hook 8건이 통과했다.
- 첫 `test:changed`에서 ps의 여러 줄 argv 파싱 실패와 Drive 시험 시간 초과를 확인했다. 숫자 신원 표를 별도로 읽고 중복 PID 행은 모호성으로 거부하도록 수정했다. 새 parser·Drive·실제 bootstrap 3개 파일·13건이 병렬도 2에서 통과했으며, 중복 PID 보강 뒤 parser 6건도 통과했다.
- 별도 회귀 리뷰에서 지적한 숫자 continuation 재귀속은 high / patch로 triage했다. 중복 헤더를 안전 중단하고 해당 반례 시험을 추가했다. 캐시·lazy import·fixture·hook 변경에는 추가 지적이 없었다.
- 개발 중: `pnpm build`, `pnpm typecheck`, `git diff --check`만 실행한다.
- 마지막 구현·리뷰 수정 뒤: 격리된 시험 환경에서 `pnpm test` → `pnpm test:python`을 순차 한 번씩 실행한다.
- 실패 수정 뒤: `pnpm test:changed`와 관련 시험으로 재검증한다.
- 운영 홈은 시험·검증에 사용하지 않는다.


- 최종 `pnpm test:changed -- 7b61fa3b85ea9653d78fd5a3d134ee0ea2b2e5b8`은 종료 코드 0: TypeScript 153개 파일·3162건, Python 16개 파일·91건 모두 통과했다. Python run은 `a4e487db11c3f1a2c46f1b28`이다.
- 앞선 SIGKILL 재개 fixture의 그룹 종료를 명시적으로 단언하고 최대 10초 기다리도록 보강했다. 관련 실제 수락 시험 6건과 최종 변경 회귀가 통과했다.
- 마지막 parser 확인 독립 리뷰는 추가 findings 없음이며 최종 typecheck·diff 검사도 통과했다. 미해결 finding·보류 기능·운영자 필수 후속 조치는 없다. 운영 반영과 main 병합은 이번 작업 범위에 포함하지 않는다.
