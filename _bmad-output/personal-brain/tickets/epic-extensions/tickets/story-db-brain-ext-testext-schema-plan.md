---
title: '확장 DB role과 출처 경계'
type: 'feature'
ticket: '4'
created: '2026-10-30'
status: done
baseline_revision: b55cfb8de182608fc0a34c2a1a4b050537a5333e
route: 'full'
route_source: 'pinned'
risk: 'high'
review: 'quick'
review_source: 'pinned'
lenses_ran: [quick]
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: []
deferred: []
---

<intent-contract>

## Intent

확장 프로세스가 core 런타임 자격 증명으로 실행되는 현재 경계를 분리한다. 설치가 setup 관리 연결로 확장 schema와 `brain_ext_<name>` role을 준비하고, 연결 확인·work·auth에는 확장 전용 DB URL을 환경 변수로만 전달한다.

## Boundaries & Constraints

- role은 non-superuser·NOBYPASSRLS이며 core 계약 표 owner와 분리한다. 출처 정책은 변경 가능한 GUC가 아니라 role 신원에 결합한다.
- 자기 schema 전부, core 공개 view SELECT, `brain.attempt_is_current(uuid, uuid)` EXECUTE가 허용 범위다. `work_items` 청구·갱신과 그 밖의 core 표 쓰기는 금지한다.
- 비밀번호는 `.env` 0600에 보관한다. argv·로그·stdout·공개 상태에 비밀을 노출하지 않는다. 13.2 snapshot·진단 보호와 13.3 Python 선택 실행·패키지 및 tokenstore 복원을 보존한다.
- 실제 건강·채널 계약 표와 RLS는 epic 14·15 소유다. 시험 계약 표만 사용한다. 실제 Garmin·실계정·원격 push·티켓 done 처리는 하지 않는다.
- 실제 core SQL view `brain.extension_status_public_v1`을 새 core migration에서 `brain_owner` 소유로 만든다. 컬럼은 `name text`, `enabled boolean`, `connection_status text nullable` 세 개만이며 확장 role은 자기 이름의 registry 행만 읽는다. `brain_app`은 모든 행을 읽는다. 진단·설정·비밀·경로·계정·일감·원시 데이터는 노출하지 않는다. 행 부재는 registry 기록 부재만 뜻하고 enabled는 설정 의도이지 취소 완료 증명이 아니다.
- view는 security barrier와 owner 권한으로 기반 표를 읽되 호출자의 CURRENT_USER로 행을 제한하고, 명시적 SELECT만 허용한다. PUBLIC·확장 role에 기반 표 권한을 주지 않는다. 기존 default ACL의 view 쓰기 권한도 회수한다. 확장 role은 LOGIN, NOSUPERUSER, NOBYPASSRLS, NOCREATEDB, NOCREATEROLE, NOREPLICATION이고 다른 role로 SET ROLE할 수 없어야 한다. 기존 role 충돌·유효 권한을 검증하고 불명 충돌은 거부한다.
- core가 승인한 view 목록만 명시적으로 부여한다. 기존 role에 새 승인 view를 주는 migration과 신규 role provisioning 양쪽을 검증하며 전체 schema 또는 default SELECT 부여는 금지한다. 13.6은 이 v1 열·행 범위와 권한을 유지하고 더 풍부한 상태는 별도 검토된 계약으로 완성한다.
- 같은 OS 사용자로 실행되는 확장은 `.env`를 읽을 수 있으므로 이 DB 자격 증명 경계는 악의적 로컬 코드 격리가 아니다. 현재 attempt 함수는 token의 유효성만 확인하며 확장 소유 일치를 증명하지 않는다. 취소 요청만으로 token이 즉시 회수되지는 않는다. 이를 과장하지 않고 후속 계약 표의 출처 RLS와 별도로 검증한다.

## I/O & Edge-Case Matrix

| 상황 | 입력·상태 | 기대 관찰값 | 오류 처리 |
|---|---|---|---|
| 자기 schema | 실제 확장 role 로그인 | 자기 schema 생성·삽입 성공 | 없음 |
| core 읽기 | 실제 공개 v1 view, 확장 두 개 | 자기 행과 지정된 세 열만 SELECT; 다른 확장 행·기반 표는 거부 | 권한 오류 또는 행 없음 |
| 권한 우회 | SET ROLE, GUC, search_path, leaky predicate, view UPDATE·DELETE | 위조·행 누출·쓰기 거부 | 권한 오류 또는 행 없음 |
| 설치 순서 | role 생성 전후 view migration 및 재설치 | 승인된 view만 읽고 유효 ACL 유지 | 충돌 시 fail closed |
| 금지 쓰기 | work_items UPDATE·다른 core 표 INSERT | 권한 거부 | PostgreSQL 권한 오류 |
| 출처 위조 | 시험 계약 표에 다른 출처 INSERT | role 결합 RLS 거부 | PostgreSQL 정책 오류 |
| 유효 attempt | 현재 token으로 계약 INSERT | 성공 | 없음 |
| 회수 attempt | 회수 token으로 계약 INSERT | trigger 거부 | BRS01 |

</intent-contract>

## Code Map

- `packages/core/src/extensions/install.ts` — 패키지 배치→Python 준비→migration→registry→연결 확인 순서와 `ExtensionRuntime.databaseUrl()` 경계다.
- `apps/cli/src/runtime/extensions.ts` — 관리 URL로 공통 migration 실행기를 호출하고 패키지·tokenstore 복원을 처리한다. 현재 자식 DB URL은 core store URL이다.
- `apps/cli/src/daemon/supervisor.ts` — work·auth의 보호된 launch 준비와 snapshot을 재사용한다. 현재 확장에도 core store URL을 전달한다.
- `apps/cli/src/config/codec.ts` — 기존 `.env` 보존·원자적 0600 쓰기와 관리 URL 해석을 재사용할 수 있다.
- `packages/postgres/src/setup.ts` — cluster 전역 role 변경을 advisory lock으로 직렬화하며 `brain_owner`를 준비한다.
- `packages/postgres/src/migrate.ts` — `brain_owner` 실행, owner별 연속 번호·checksum·파일별 트랜잭션을 보존한다. 2026-10-30 재확인 시 core 마지막 번호는 0014이며 구현 착수 때 다시 확인한다.
- `packages/postgres/migrations/0004_attempt_fence.sql` — 현재 PUBLIC EXECUTE인 attempt 확인 함수와 PUBLIC EXECUTE가 회수된 trigger 함수가 있다. 기존 적용 SQL을 바꾸지 않는다.
- `apps/cli/test/ext-fixture.ts` — 격리 home·PG·실제 CLI·정리 harness다. fixture migration의 schema 생성과 새 provisioning 순서를 조정해야 한다.

## Tasks & Acceptance

**실행:**
- [x] 위 공개 view 계약을 구현한다. 정확한 열·타입·자기 행 제한·비밀 sentinel·기반 표 읽기와 view 쓰기 거부, role 전환·설치 순서·유효 ACL을 실제 PG 연결로 시험한다. 기존 PUBLIC 함수 EXECUTE 등 유효 권한을 감사하고 필요한 명시 권한을 빠뜨리지 않는다. 확장 자격 증명이 없으면 core URL로 대체하지 않는다.
- [x] `packages/postgres/src/`의 확장 provisioning과 새 migration에서 role·schema·함수 권한을 준비한다. 기존 role의 속성·멤버십 및 cluster 전역 이름 충돌을 검증한다.
- [x] `apps/cli/src/config/codec.ts`, `runtime/extensions.ts`, `daemon/supervisor.ts`, `packages/core/src/extensions/install.ts`에서 비밀 저장·재설치·실패 일관성과 확장별 URL 전달을 연결한다.
- [x] `packages/postgres/test/extension-permissions.test.ts`와 CLI 설치·감독자 시험에서 실제 role 접속, matrix, 비밀 비노출을 검증한다.

**인수 조건:**
- Given 격리 PostgreSQL과 설치된 testext, when 실제 `brain_ext_testext`로 접속하면, then 자기 schema 쓰기와 지정된 core 공개 view SELECT가 성공하고 role은 non-superuser·NOBYPASSRLS이다.
- Given 같은 접속, when work_items UPDATE와 다른 core 표 INSERT를 시도하면, then 권한 오류로 거부된다.
- Given 별도 owner·role 결합 RLS·12.3 trigger가 붙은 시험 계약 표, when 다른 출처 또는 회수 token을 넣으면, then 각각 RLS와 BRS01로 거부되고 자기 출처의 현재 token은 성공한다.
- Given 실제 CLI 설치와 감독자 실행, when check·work·auth를 시작하면, then 확장 role URL이 child env로만 전달되고 `.env`는 0600이며 출력·로그·argv에 비밀이 없다.

## Implementation Notes

- 확장 provisioning은 `postgres` DB의 cluster 공통 advisory lock 아래 비밀번호 생성과 role/schema 준비를 직렬화한다. `.env`의 기존 값과 0600을 보존·복구하고, 기존 role 신원·속성·멤버십·유효 ACL·실제 비밀번호 접속을 검증한다.
- core migration `0015_extension_status_public.sql`은 공개 v1 view와 명시 SELECT를 추가하고 기존 PUBLIC 함수 실행 권한을 정리한다. core schema 버전은 15다. 설치·check·work·auth는 확장별 URL을 사용하고 자격 증명 부재 시 거부한다.
- 기존 migration 파일은 수정하지 않았다. 시험 fixture의 미적용 확장 DDL만 provisioning 선행 순서에 맞췄다. 실제 계약 표·Garmin·실계정·원격 push는 범위 밖으로 유지했다.
- 최초 구현 워커 `ctx_62611924b28b`는 소스 변경 없이 실패 보고했다. 같은 Task의 재시도 `ctx_4de78969d595`가 구현하고 지휘자 보완 지시를 반영했다. 모델은 모두 `gpt-6.1-terra / medium`이다.

- 시작 시 작업 트리가 깨끗했고 `git add --refresh -- .`가 성공했다. 현재 브랜치에서 진행하며 원격 push는 하지 않는다.
- 조사 세션 `01a18b69-e2f9-7262-9163-1e064d5d8eb8`는 읽기 전용으로 조사했다. 구현·시험·커밋은 수행하지 않았다.
- 선행 13.3 계획의 Code Map·Tasks & Acceptance·Implementation Notes·Plan Change Log를 읽고 Python 환경·snapshot·복원 연속성을 확인했다. 최상위 research-* 폴더는 없다.

## Plan Change Log

- 2026-10-30: intent-contract는 유지했다. 구현 확인으로 파일별 작업을 완료 표시하고 실제 시험·권한 감사·동시성 보완 근거를 기록했다.

## Review Triage Log

### 2026-10-30 — Review pass

- 판정 합계: 3건 — high 2, medium 1, low 0, false 0, maybe-false 0.
- `[high]` `[patch]` 확장 URL의 쿼리 자격 증명이 core 신원을 보존한다 — `pg-connection-string`은 query `user/password`를 authority보다 우선한다. 설정 URL은 그대로 전달되므로 실제 도달 가능한 core 신원 유출이며, 관리·확장·검증 URL에서 query user/password를 제거하고 실제 current_user를 검증했다. 실제 연결 시험으로 재현과 수정을 확인했다.
- `[high]` `[patch]` 기존 role의 view migration은 자기 schema 밖 CREATE를 감사하지 않는다 — core 갱신은 provisioning을 다시 부르지 않고, migration의 schema 검사도 brain/public을 제외하므로 CREATE 권한이 그대로 남는다. 기존 schema 감사에 CREATE 검사를 추가했다. brain/public CREATE를 각각 부여한 실제 PG migration 거부 시험이 통과했다.
- `[medium]` `[patch]` MAINTAIN이 core table ACL 감사에서 빠졌다 — PostgreSQL 18을 사용하고 기존 core migration이 MAINTAIN을 부여하므로 실제 지원 권한이며 유지보수 실행·잠금 부담을 허용한다. 두 유효 권한 목록에 MAINTAIN을 추가했고 provisioning과 migration의 실제 PG 거부 시험이 통과했다.
- 세 건은 기존 계약이 정한 권한 경계에서 누락된 항목을 직접 정정하는 수정이다. 공개 표면 추가나 미확인 상태의 새 방어 분기는 필요하지 않으므로 patch로 분류했다. 보류·기각은 없다.

## Verification

- 구현 후 예정 명령: `pnpm build`, `pnpm typecheck`, `pnpm exec vitest run packages/postgres/test/extension-permissions.test.ts packages/postgres/test/attempt-fence.test.ts apps/cli/test/ext-install.test.ts apps/cli/test/daemon-supervisor.test.ts`, `pnpm test`.
- PostgreSQL 사전 조건은 기존 시험 global setup이 사용할 Docker 또는 관리 권한의 `BRAIN_TEST_DATABASE_URL`이다. 격리 DB 및 cluster role을 생성·정리해야 한다.
- 2026-10-30 구현 워커의 최종 실행: 표적 네 파일 41개 통과, 전체 140개 파일 3606개 통과·1개 skip. 지휘자도 고정 diff에서 `pnpm build`, `pnpm typecheck`, 표적 41개와 전체 3606개 통과·1개 skip을 확인했다.
- matrix 매핑: 자기 schema·공개 v1 view·SET ROLE/GUC/search_path/누출 predicate·금지 쓰기·출처 RLS·현재/회수 token은 `packages/postgres/test/extension-permissions.test.ts`의 실제 연결 시험이 관찰한다. role 선행 view migration과 재설치·유효 ACL은 같은 파일의 두 번째 시험이 관찰한다. 실제 CLI check/work/auth·argv·출력·0600 및 별도 프로세스 동시 비밀번호 보존은 `apps/cli/test/ext-install.test.ts`가 관찰한다. 표적 실행에서 해당 시험은 skip 없이 모두 실행된다.
- 지휘자의 첫 전체 실행은 후속 편집과 겹쳐 core/15 checksum 불일치 한 건이 났다. 수정 완료 후 소스를 고정한 전체 실행과 리뷰 수정 후 전체 재실행이 모두 통과했다.

## 해소된 보안 계약

2026-10-30 감독자 추천: 위 intent-contract가 아래 공백을 대체한다. 독립 읽기 전용 Codex가 실제 registry·migration·자격 증명 경로와 반례를 대조했다. DB 동작은 구현 시 실제 PG 시험으로 검증한다. 근거: `packages/postgres/migrations/0011_extension_registry.sql:1`, `packages/postgres/src/setup.ts:52`, `packages/postgres/migrations/0004_attempt_fence.sql:9`, 에픽 Notes의 13.6 분담.

### 원래 escalation

- 티켓 13.4와 에픽 E13-5, architecture AD-30은 core 공개 view SELECT를 요구하지만 SQL 객체·노출 컬럼·허용 데이터 범위를 지정하지 않는다.
- `packages/postgres/migrations/` 전체에서 CREATE VIEW 정의를 찾지 못했다. 기존에 승인된 공개 SQL view를 재사용할 근거가 없다.
- `epic-extensions-research-code.md`의 §6은 “공개 view가 SQL view인지 SDK projection인지 구체적 모양은 후보”라고 명시한다. 에픽 Notes는 최종 공개 상태 view 생산자를 후속 13.6으로 지정한다.
- 확정할 질문: 13.4에서 확장 role이 SELECT할 core SQL view는 무엇이며 어떤 컬럼·행을 공개하는가? 후속 13.6의 상태 view를 기다리는 권한 등록 계약과 시험 전용 view만 만드는 것이 이번 인수 조건을 충족하는가, 아니면 이번에 실제 공개 view를 신설해야 하는가?
- 어느 선택이든 공개 데이터 범위 또는 관찰 가능한 인수 결과를 바꾼다. 보안·비밀 관련 gap은 가정으로 메울 수 없다는 build-auto 지침에 따라 구현 전에 HALT한다. 외부 사람 전용 작업이 아니라 저장소 내 보안 계약 미결정이므로 awaiting-operator 대상이 아니다.


## Auto Run Result

Status: built

- 확장 DB 신원을 core에서 분리하고 출처·attempt fence와 제한된 공개 view를 실제 PostgreSQL에서 검증했다. 사람이 저장소 밖에서 수행해야 할 작업은 없다.
- 변경 파일:
  - `packages/postgres/src/extension-provision.ts`, `src/index.ts`: cluster 잠금·role/schema·유효 ACL·실제 접속 신원 검증과 export.
  - `packages/postgres/migrations/0015_extension_status_public.sql`, `src/migrate.ts`: 공개 v1 view, 명시 SELECT, 함수 EXECUTE·CREATE·MAINTAIN 감사와 core 버전 15.
  - `apps/cli/src/config/codec.ts`, `runtime/extensions.ts`, `daemon/supervisor.ts`: 0600 비밀 보존·동시 생성 직렬화·query 신원 override 제거·확장별 child env.
  - `packages/core/src/extensions/install.ts`: 확장 이름으로 전용 DB URL을 요청.
  - `packages/postgres/test/extension-permissions.test.ts`, `apps/cli/test/ext-install.test.ts`: role·공개 view·RLS·fence·ACL·동시 설치·신원·비밀 재현 시험.
  - `apps/cli/test/ext-fixture.ts`, fixture check·DDL: 확장 schema 선행 준비, 연결 확인 신원·argv 단언, cluster role 정리.
  - CLI `install.test.ts`·`setup.test.ts`, postgres `cli.test.ts`·`migrate.test.ts`·`store.test.ts`·`work-store.test.ts`: core 버전 15 기대값.
  - 이 계획: 실행·검증·리뷰 판정·결과를 기록.
- 독립 quick 리뷰 3건을 모두 수정했다: high 2, medium 1. 보류 0, 기각 0. 상세 근거와 조치는 Review Triage Log에 있다.
- `followup_review_recommended: true`: high 수정이 있어 후속 독립 리뷰를 권고한다. URL query 정규화와 migration/provisioning 유효 ACL 감사의 동등성이 재검토 대상이다. 세 재현 시험과 전체 회귀는 통과했으나 수정 후 독립 렌즈 재실행은 하지 않았다.
- 지휘자 최종 검증: `pnpm build` 통과, `pnpm typecheck` 통과, 계획의 표적 네 파일 41개 통과, `pnpm test` 140개 파일 3606개 통과·1개 skip. matrix 시험은 skip 없이 실행·통과했다. `git diff --check` 통과.
- 같은 OS 사용자는 `.env`를 읽을 수 있고 attempt predicate는 확장 소유 일치나 취소 요청 즉시 회수를 보장하지 않는다. 실제 계약 표 RLS는 epic 14·15가 소유한다.
- 티켓을 done으로 표시하지 않았고 `tickets.py mark`를 실행하지 않았다. 최종 티켓 완료는 오케스트레이터의 자체 검증이 결정한다. 원격 push는 하지 않는다.
- Orca 정리: 자기 Run `run_3a59a2e19e36`의 실패 구현·최종 구현·quick 리뷰 세 Dispatch를 모두 release했다. worker-list의 reclaimable은 0이고 inbox는 비었다. 전용 제어 셸만 마지막에 닫는다. 미확인 워커나 남은 과업은 없다.
