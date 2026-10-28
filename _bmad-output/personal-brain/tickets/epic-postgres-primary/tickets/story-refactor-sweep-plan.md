---
title: 'Refactor sweep: epic 11이 미룬 정리'
type: 'refactor'
ticket: '12'
created: '2026-10-29'
status: done
baseline_revision: 'ebe5a843b84cbd0faf2149d5b488477ec3e7307b'
route: 'full'
route_source: 'pinned'
risk: 'medium'
review: 'quick'
review_source: 'pinned'
lenses_ran: [quick]
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: [oversized]
deferred: []
closes_deferred: [DW-6, DW-7, DW-12]
---

<intent-contract>

## Intent

**Problem:** 11.1~11.11·11.14의 plan과 리뷰가 남긴 정리 가운데 기능 추가 없이 닫을 수 있는 것이 넷 있다. (1) DW-6: `.env`를 쓰는 두 곳(`writeConfig`, `postgresSecrets`)이 모두 제자리 truncate 뒤 쓰므로, 쓰는 도중 끊기면 PostgreSQL 볼륨 비밀번호를 잃는다(11.1 deferred). (2) DW-12: Core `drain`이 `scanTranscripts`의 `stopped`(폴더·내역 읽기 실패 이유)를 보고에 싣지 않아, `setup run`이 transcript 폴더를 못 읽어도 "디스크의 transcript를 가져왔습니다"를 보인다(11.8 deferred). (3) DW-7: `brain.redacting` GUC 위장으로 `document_chunks` 삭제 규칙을 건너뛰는 문제는 11.5가 이미 막았다(규칙이 GUC와 함께 표 소유 role 소속을 요구, `redaction.test.ts`의 `refuses brain_app every way around the triggers…`). 원장에서 닫기만 하면 된다. (4) `packages/postgres/test/text.test.ts`의 `world()`가 모든 시험에 `lockTimeoutMs: 40`을 주어 전체 병렬 실행에서 `ensureSelfUser`가 가끔 잠금 예산을 넘는다(11.14 남은 위험).

**Approach:** 넷을 제품 계약 변경 없이 고친다(2는 보고에 선택 필드 하나를 더하고 설치 문구만 바꾼다, 3은 코드 변경 없음). 범위 밖 항목은 Auto Run Result에 새 스토리·다른 에픽 후보로 남긴다.

## Boundaries & Constraints

**Always:**
- 1: `.env`를 쓰는 두 곳이 같은 도우미 하나를 쓴다: 같은 폴더의 임시 파일(`wx`, mode 0600)에 쓰고 `rename`으로 바꿔 넣으며, 실패하면 임시 파일을 지우고 원래 `.env`는 그대로 둔다. 결과 파일은 언제나 0600이고 임시 파일이 남지 않는다. `.env`의 내용·키 순서·주석·오류 코드(`CONFIG_INVALID`)·`postgresSecrets`의 반환값은 지금과 같다. `apps/cli/src/daemon/launchd.ts:106-114`의 임시 파일+rename 모양을 따른다.
- 2: `BrainDrainReport`에 선택 필드 `scanStopped?: string`을 더해, scan이 멈춘 이유가 있고 대기열이 `unwritable`로 멈추지 않았을 때만 그 문장을 싣는다. `setup run`의 가져오기 단계는 `scanStopped`가 있으면 성공 문구 대신 그 이유를 담은 경고 한 줄을 보인다(설치는 계속되고 종료값은 그대로). 다른 필드와 그 값은 지금과 같다.
- 4: `world()`의 Store는 기본 잠금 예산을 쓰고, 짧은 예산이 필요한 `preserves a work INSERT lock SQLSTATE and rolls session creation back` 시험만 `lockTimeoutMs: 40` Store를 따로 만든다. 그 시험의 단언(`DB_LOCKED`, 세션 되돌림)은 그대로다.
- 바꾼 시험은 고치기 전의 결함을 잡는다: 1은 제자리 쓰기로 되돌리면 실패하고, 2는 필드를 빼면 실패한다.
- 테스트는 PG에서 돈다(OrbStack이 켜져 있음).

**Never:**
- DW-8(긴 정리의 청구 갱신 — epic-jobs-and-scheduler), DW-9(공통 큐 권한·완료 경계 재설계), DW-10(VACUUM 메시지 로캘 — 설치가 컨테이너 로캘을 고정하고 해석 불가 때 성공으로 닫지 않음), DW-11(PG 런타임의 정리 handler·정리 role 접속 조립 — 설정 키·`.env` 항목·데몬 등록이 필요한 밀려난 기능)은 만들지 않는다. 새 스토리·다른 에픽 후보로 남긴다.
- `brain queue drain`·데몬의 출력(JSON 필드·문구)을 바꾸지 않는다. `config.toml` 쓰기 방식은 바꾸지 않는다.
- `deferred-work.md`와 티켓 파일(`tickets.toml`, epic 파일)을 고치지 않는다. 닫기는 frontmatter `closes_deferred`로 오케스트레이터가 한다.
- 실제 `~/.config`·실제 Brain 홈·운영 compose 자원을 건드리지 않는다. 기존 리뷰가 기각한 항목을 다시 열지 않는다.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| `.env` 다시 쓰기 | 0644로 있던 `.env`, `postgresSecrets` 또는 `writeConfig` | 같은 내용 규칙의 새 파일이 0600, 폴더에 임시 파일 없음, inode가 바뀜(제자리 쓰기 아님) | 없음 |
| `.env` 쓰기 실패 | 임시 파일 쓰기 또는 rename 실패 | 원래 `.env` 바이트 그대로, 임시 파일 없음 | `writeConfig`는 `CONFIG_INVALID`, `postgresSecrets`는 던짐(지금과 같음) |
| 폴더 읽기 실패 | transcript 폴더 `list`가 실패 | drain 보고에 `scanStopped`(폴더 이유 문장), `setup run`이 경고 한 줄을 보이고 설치 계속 | 값으로 돌려줌 |
| 정상 drain | scan이 멈추지 않음 | `scanStopped` 없음, 설치 성공 문구 그대로 | 없음 |
| 쓸 수 없는 대기열 | 대기열이 `unwritable` | `scanStopped` 없음, 기존 실패 경고 그대로 | 기존 경로 |

</intent-contract>

## Code Map

- `apps/cli/src/config/codec.ts:580-596` -- `writeConfig`의 `.env` 쓰기(`writeFile`+`chmod`). 도우미로 바꿀 자리. `config.toml` 쓰기(`:582`)는 그대로.
- `apps/cli/src/config/codec.ts:751-770` -- `postgresSecrets`; `:767-768`의 `chmod`+`writeFile`을 같은 도우미로. 값 계산·정렬·반환은 그대로.
- `apps/cli/src/daemon/launchd.ts:106-114` -- 따를 임시 파일+rename 관례(`randomUUID` 이름, `flag: 'wx'`, `finally`에서 `unlink` ENOENT 무시).
- `apps/cli/test/config.test.ts:124` -- 기존 `.env` 0600 단언. 같은 파일에 inode 교체·임시 파일 없음·실패 시 원본 보존 시험을 더한다.
- `packages/core/src/brain.ts:169-191,471,505-515` -- `BrainDrainReport`와 `drain`; `scan.stopped`를 `scanStopped`로 싣는 자리(`unwritable` 분기·조기 반환에는 없음).
- `packages/core/src/capture/scan.ts:107-111,136-147` -- `stopped` 문장의 출처. 바꾸지 않는다.
- `packages/core/test/brain-drain.test.ts:37-81` -- `memoryTranscriptFolder` 기반 drain 시험 틀. 읽기 실패 폴더로 `scanStopped`를 단언한다.
- `apps/cli/src/install/flow.ts:460-467` -- 가져오기 단계 문구. `scanStopped` 분기를 더한다.
- `apps/cli/test/install-flow.test.ts:18,78,142` -- `importTranscripts` 대역. `scanStopped`가 있는 보고로 경고 문구를 단언한다.
- `packages/postgres/test/text.test.ts:11-16,149-162` -- `world()`와 짧은 잠금 예산이 필요한 유일한 시험.
- DW-7 근거(읽기 전용): `packages/postgres/migrations/0001_initial.sql:593-600`(`pg_has_role(current_user, 표 소유자, 'MEMBER')`), `packages/postgres/test/redaction.test.ts:199-214`.

## Tasks & Acceptance

**Execution:**
- [x] `apps/cli/src/config/codec.ts` -- `.env` 원자적 쓰기 도우미 하나와 두 호출처 교체 -- DW-6.
- [x] `apps/cli/test/config.test.ts` -- 두 경로의 inode 교체·0600·임시 파일 없음, 실패 때 원본 보존 시험 -- DW-6 회귀 방지.
- [x] `packages/core/src/brain.ts` -- `BrainDrainReport.scanStopped`와 drain의 전달 -- DW-12.
- [x] `packages/core/test/brain-drain.test.ts` -- 읽기 실패 폴더면 `scanStopped`, 정상·unwritable이면 없음 -- DW-12.
- [x] `apps/cli/src/install/flow.ts` -- `scanStopped`면 이유를 담은 경고 -- DW-12.
- [x] `apps/cli/test/install-flow.test.ts` -- 경고 문구와 설치 계속 단언 -- DW-12.
- [x] `packages/postgres/test/text.test.ts` -- `world()` 기본 예산, 잠금 시험만 40ms Store -- 11.14 흔들림.

**Acceptance Criteria:**
- Given 정리 뒤 코드와 0644 `.env`가 있는 임시 홈, when `postgresSecrets`와 `writeConfig`로 다시 쓰면, then `.env`는 0600이고 inode가 바뀌었으며 폴더에 임시 파일이 없다. 도우미를 제자리 `writeFile`로 되돌리면 inode 시험이 실패한다.
- Given 읽을 수 없는 transcript 폴더, when `setup run`의 가져오기 단계가 돌면, then 로그에 그 이유를 담은 경고 한 줄이 있고 "디스크의 transcript를 가져왔습니다"는 없으며 설치는 끝까지 간다.
- Given 정리 뒤 코드, when `pnpm test`(build·typecheck·vitest, PG 포함)를 돌리면, then 모두 통과한다.

## Implementation Notes

- `.env`의 두 쓰기 경로를 `writeEnv`로 통합했다. 같은 폴더의 `wx` 임시 파일에 0600으로 쓴 뒤 `rename`하고 `finally`에서 임시 파일을 지운다.
- `scanStopped`는 scan 중단 이유가 있고 queue가 `unwritable`이 아닐 때만 전달한다. 설치에서는 이유를 경고로 출력한 뒤 끝까지 진행한다.
- PG text 시험은 기본 잠금 예산을 쓰며 잠금 회귀 시험만 별도 40ms Store를 사용한다.
- 매트릭스 시험 감사를 보완해 설치 단에서 정상 drain의 성공 문구·가져오기 경고 없음과 `unwritable`의 기존 실패 경고를 직접 단언했다. `corepack pnpm vitest run --project cli install-flow`로 26개 시험이 통과했다.

## Plan Change Log

## Review Triage Log

- Quick 독립 리뷰: 지적 없음. diff와 주변 코드, 인수 조건을 점검했다.
- 위 행은 구현 세션(codex)이 스스로 돌린 자체 점검 기록이다(계획의 상태·리뷰 칸과 Auto Run Result 초안도 그 세션이 썼고, 상태·리뷰 칸은 오케스트레이터가 되돌렸다). 오케스트레이터의 리뷰 회차가 아니며, 아래 회차가 정식 리뷰다.

### 2026-10-29 — Review pass
- verdicts: 0 findings — high 0, medium 0, low 0, false 0, maybe-false 0
- findings: (없음) Quick 렌즈(새 codex 읽기 전용 리뷰어, 세션 `01a183dc-4c8b-7662-8d93-7d28315b6b23`)가 계획의 수용 기준·`AGENTS.md`·기준 리비전 이후 diff와 주변 코드를 대조해 미충족 수용 기준·규칙 위반·버그를 찾지 못했다.

### 2026-10-29 — 후속 리뷰
- verdicts: 0 findings — high 0, medium 0, low 0, false 0, maybe-false 0
- findings: 지적 없음. 새 읽기 전용 Quick 리뷰 세션 `01a183e1-fefa-7091-86e7-a07caf9a895f`가 기준 리비전 이후 diff·주변 코드·계획 수용 기준·에이전트 규칙을 대조했다. 이번 회차의 patch·defer·reject는 모두 0건이다.

## Design Notes

- 정리 목록을 정한 근거(2026-10-29 착수): 12개 plan의 `deferred`, Review Triage Log의 defer 행, Auto Run Result의 남은 위험과 `deferred-work.md`의 epic 11 항목(DW-6~DW-12)을 모았다. 리뷰 기록에 sweep으로 미룬 다른 지적은 없다. 11.4의 "fixture 연결 시간 초과 한 번"은 재현 근거가 없어 뺐다. 계약·권한·정책을 바꾸거나 설정 항목을 더해야 하는 항목(DW-8~11)은 "정리만" 범위를 넘으므로 후보로 남긴다.
- DW-12를 설치에만 보이는 이유: 결함 기록이 가리킨 증상이 설치의 성공 안내다. `brain queue drain` JSON에 필드를 더하면 명령 출력 계약이 바뀌므로 하지 않는다. 보고 필드는 Core에 있어 나중 소비자가 쓸 수 있다.
- rename은 같은 파일 시스템 안에서 원자적이므로 임시 파일은 `.env`와 같은 폴더에 둔다.

## Verification

**Commands:**
- `pnpm build && pnpm typecheck` -- expected: 오류 없음
- `pnpm vitest run --project cli config install-flow` -- expected: 통과
- `pnpm vitest run --project core brain-drain` -- expected: 통과
- `for i in 1 2 3; do pnpm vitest run --project postgres text; done` -- expected: 세 번 모두 통과
- `pnpm test` -- expected: 전부 통과(PG 포함)
- `git diff --check` -- expected: 출력 없음

## Auto Run Result

Status: built

- 이번 실행은 기존 `built` 계획의 후속 리뷰다. 사용자 지시에 따라 계획 상태는 그대로 유지했으며 `tickets.py mark`는 실행하지 않았다.
- 구현 요약: `.env`를 같은 폴더의 0600 임시 파일로 쓴 뒤 원자적으로 교체한다. transcript 스캔 실패 이유를 drain 보고에 싣고 설치에서는 경고한다. PG text 시험의 공통 Store는 기본 잠금 예산을 쓰고 잠금 회귀 시험만 40ms를 쓴다. 이번 회차의 소스·시험 수정은 없다.
- 변경 파일: `apps/cli/src/config/codec.ts` — 공통 `.env` 원자적 쓰기; `apps/cli/src/install/flow.ts` — 스캔 실패 경고; `packages/core/src/brain.ts` — `scanStopped` 전달; `apps/cli/test/config.test.ts` — inode·권한·실패 시 원본 보존; `apps/cli/test/install-flow.test.ts` — 정상·스캔 실패·대기열 실패 안내; `packages/core/test/brain-drain.test.ts` — 스캔 실패 전달 조건; `packages/postgres/test/text.test.ts` — 잠금 예산 분리. 이 계획에는 후속 리뷰와 검증 결과를 기록했다.
- 리뷰: Quick 지적 0건. patch 0건(high 0, medium 0, low 0), defer 0건, reject 0건. 후속 리뷰 권고는 `false`다. 기존 원장 항목은 수정·재개방·재작성하지 않았다.
- 검증: 임시 PATH shim으로 Corepack의 pnpm을 호출해 `pnpm test`를 실행했다. build·typecheck·PG 포함 전체 테스트가 exit 0으로 통과했다(107개 파일, 2,727개 시험). `.env` 두 쓰기 경로의 inode 교체·0600·임시 파일 정리·실패 시 원본 보존, drain 보고 조건과 설치 안내 회귀 시험도 이 실행에 포함됐다. 기록 후 `git diff --check`도 통과했다.
- 남은 위험: 이번 리뷰에서 새로 확인한 결함이나 사람의 결정이 필요한 항목은 없다. 기존 계획이 제외한 기능과 기존 원장 항목의 처리 여부는 이번 실행에서 재판정하지 않았다.
- 반환: `built`로 HALT한다. 티켓 완료와 기존 `closes_deferred`에 대한 판정·원장 갱신은 오케스트레이터가 맡는다. push는 하지 않는다.
