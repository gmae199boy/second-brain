---
title: 'PG setup 관리용 잠금 대기 안정화'
type: 'bugfix'
ticket: ''
created: '2026-10-28'
status: 'built'
baseline_revision: '5ca5da058addd5037cb5006d8198ae6bff409140'
route: 'oneshot'
route_source: 'auto'
risk: 'medium'
review: 'quick'
review_source: 'pinned'
lenses_ran: ['quick']
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="user-owned intent">

## Intent

**Problem:** 전체 테스트에서 병렬 PG 준비가 관리용 advisory lock을 기다리다가 런타임 기본 잠금·질의 예산을 넘으면 `prepareDatabase`가 실패한다. 기존 setup 시험은 `.ok`만 단언해 오류 메시지도 숨긴다.

**Approach:** 실제 잠금 경합으로 원인을 재현한 뒤 setup 관리 연결의 잠금·질의 대기를 런타임 예산에서 분리한다. 연결 시도 시간 제한과 런타임 timeout은 유지한다. 준비 실패 메시지를 단언에 표시하고 전체 `pnpm test`를 최소 3번 연속 통과시킨 뒤 커밋한다. 문서·커밋에 절대 홈 경로를 쓰지 않는다.

</frozen-after-approval>

## Implementation Notes

- oneshot: 수정은 관리용 pool 두 곳과 setup 회귀 시험에 한정된다. `connect.ts`는 이미 `lockTimeoutMs: 0`, `queryTimeoutMs: 0`을 지원하므로 공통 연결 설정을 바꿀 필요가 없다.
- 재현: 수정 전 setup 회귀 시험 3건 중 2건이 실패했다. role advisory lock과 대상 ledger table lock을 각각 6.2초 유지했으며, 두 실패 메시지는 `canceling statement due to lock timeout`이었다. 보고된 과거 실패에는 메시지가 없어 동일 원인이라고 단정할 수 없지만, 의심한 실패 경로가 실제 발생함을 확인했다.
- setup은 모든 DB의 role 변경을 `/postgres`의 `pg_advisory_lock(4919270912)`로 직렬화한다. 수정 전 관리용 pool과 대상 DB pool 모두 기본 lock 5초, statement 6초, client 7초를 사용했다.
- 두 관리용 pool에 `lockTimeoutMs: 0`, `queryTimeoutMs: 0`을 명시했다. 접속 시간 제한과 런타임 연결 설정은 그대로다. setup 단언은 실패 시 `prepared.message`를 표시한다. 수정 후 같은 setup 회귀 시험 3건이 모두 통과했다(13.02초).
- 전체 실행 1차는 105개 파일 / 2,896건 통과(68.22초). 2차는 PG 시험은 통과했으나 기존 CLI `daemon-run.test.ts`의 `reports a config made unreadable mid-run once and stops cleanly`가 설정 오류 로그를 20초 기다리다 실패했다. 이 시험은 SQLite를 사용하고 이번 수정 파일을 거치지 않는다. 해당 코드는 변경하지 않고 연속 통과 횟수를 초기화했다.
- 최종 전체 실행 3·4·5차가 같은 코드에서 3회 연속 통과했다. 각 105개 파일 / 2,896건이며 build·typecheck도 포함한다(68.36초, 68.40초, 68.61초). PG setup 잠금 대기 회귀 2건은 매번 실제 DB에서 실행되었다. `git diff --check` 통과.

## Plan Change Log

## Review Triage Log

- quick 독립 검토: 지적 사항 없음. 이월 항목 없음.

## Verification

- 실제 관리 advisory lock 및 대상 ledger table lock을 기본 runtime 예산보다 오래 잡은 시험: 기존 코드에서 실패, 수정 후 성공.
- `npx --yes pnpm@12 test` — build·typecheck 포함 전체 시험 3회 연속 통과(pnpm이 PATH에 없어 동일 pnpm 12 실행).
- `git diff --check` — 통과.
