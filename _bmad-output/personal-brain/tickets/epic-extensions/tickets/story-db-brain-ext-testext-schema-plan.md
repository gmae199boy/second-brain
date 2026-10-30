---
title: '확장 DB role과 출처 경계'
type: 'feature'
ticket: '4'
created: '2026-10-30'
status: blocked
baseline_revision: '4c61ec185460dac9db29d2508f5d1f7bee4ff708'
route: 'full'
route_source: 'pinned'
risk: 'high'
review: ''
review_source: ''
lenses_ran: []
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: []
deferred: []
blocked_at: "2026-10-30"
blocked_reason: "intent gap: core 공개 view의 SQL 객체·노출 컬럼·허용 데이터 범위가 미정이다. 현재 migrations에는 CREATE VIEW가 없고 epic-extensions-research-code.md §5는 SQL view/SDK projection을 미결정으로 남기며 에픽 Notes는 최종 공개 상태 view 생산자를 13.6으로 지정한다. 13.4가 시험용 view와 향후 권한 등록만 검증할지 실제 공개 view를 신설할지 보안 계약 확정이 필요하다."
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
- [ ] 위 공개 view 계약을 구현한다. 정확한 열·타입·자기 행 제한·비밀 sentinel·기반 표 읽기와 view 쓰기 거부, role 전환·설치 순서·유효 ACL을 실제 PG 연결로 시험한다. 기존 PUBLIC 함수 EXECUTE 등 유효 권한을 감사하고 필요한 명시 권한을 빠뜨리지 않는다. 확장 자격 증명이 없으면 core URL로 대체하지 않는다.
- [ ] `packages/postgres/src/`의 확장 provisioning과 새 migration에서 role·schema·함수 권한을 준비한다. 기존 role의 속성·멤버십 및 cluster 전역 이름 충돌을 검증한다.
- [ ] `apps/cli/src/config/codec.ts`, `runtime/extensions.ts`, `daemon/supervisor.ts`, `packages/core/src/extensions/install.ts`에서 비밀 저장·재설치·실패 일관성과 확장별 URL 전달을 연결한다.
- [ ] `packages/postgres/test/extension-permissions.test.ts`와 CLI 설치·감독자 시험에서 실제 role 접속, matrix, 비밀 비노출을 검증한다.

**인수 조건:**
- Given 격리 PostgreSQL과 설치된 testext, when 실제 `brain_ext_testext`로 접속하면, then 자기 schema 쓰기와 지정된 core 공개 view SELECT가 성공하고 role은 non-superuser·NOBYPASSRLS이다.
- Given 같은 접속, when work_items UPDATE와 다른 core 표 INSERT를 시도하면, then 권한 오류로 거부된다.
- Given 별도 owner·role 결합 RLS·12.3 trigger가 붙은 시험 계약 표, when 다른 출처 또는 회수 token을 넣으면, then 각각 RLS와 BRS01로 거부되고 자기 출처의 현재 token은 성공한다.
- Given 실제 CLI 설치와 감독자 실행, when check·work·auth를 시작하면, then 확장 role URL이 child env로만 전달되고 `.env`는 0600이며 출력·로그·argv에 비밀이 없다.

## Implementation Notes

- 시작 시 작업 트리가 깨끗했고 `git add --refresh -- .`가 성공했다. 현재 브랜치에서 진행하며 원격 push는 하지 않는다.
- 조사 세션 `01a18b69-e2f9-7262-9163-1e064d5d8eb8`는 읽기 전용으로 조사했다. 구현·시험·커밋은 수행하지 않았다.
- 선행 13.3 계획의 Code Map·Tasks & Acceptance·Implementation Notes·Plan Change Log를 읽고 Python 환경·snapshot·복원 연속성을 확인했다. 최상위 research-* 폴더는 없다.

## Plan Change Log

## Review Triage Log

## Verification

- 구현 후 예정 명령: `pnpm build`, `pnpm typecheck`, `pnpm exec vitest run packages/postgres/test/extension-permissions.test.ts packages/postgres/test/attempt-fence.test.ts apps/cli/test/ext-install.test.ts apps/cli/test/daemon-supervisor.test.ts`, `pnpm test`.
- PostgreSQL 사전 조건은 기존 시험 global setup이 사용할 Docker 또는 관리 권한의 `BRAIN_TEST_DATABASE_URL`이다. 격리 DB 및 cluster role을 생성·정리해야 한다.
- 이번 실행은 읽기 전용 조사와 계획 작성에서 중단하여 위 검증을 실행하지 않았다.

## 해소된 보안 계약

2026-10-30 감독자 추천: 위 intent-contract가 아래 공백을 대체한다. 독립 읽기 전용 Codex가 실제 registry·migration·자격 증명 경로와 반례를 대조했다. DB 동작은 구현 시 실제 PG 시험으로 검증한다. 근거: `packages/postgres/migrations/0011_extension_registry.sql:1`, `packages/postgres/src/setup.ts:52`, `packages/postgres/migrations/0004_attempt_fence.sql:9`, 에픽 Notes의 13.6 분담.

### 원래 escalation

- 티켓 13.4와 에픽 E13-5, architecture AD-30은 core 공개 view SELECT를 요구하지만 SQL 객체·노출 컬럼·허용 데이터 범위를 지정하지 않는다.
- `packages/postgres/migrations/` 전체에서 CREATE VIEW 정의를 찾지 못했다. 기존에 승인된 공개 SQL view를 재사용할 근거가 없다.
- `epic-extensions-research-code.md`의 §6은 “공개 view가 SQL view인지 SDK projection인지 구체적 모양은 후보”라고 명시한다. 에픽 Notes는 최종 공개 상태 view 생산자를 후속 13.6으로 지정한다.
- 확정할 질문: 13.4에서 확장 role이 SELECT할 core SQL view는 무엇이며 어떤 컬럼·행을 공개하는가? 후속 13.6의 상태 view를 기다리는 권한 등록 계약과 시험 전용 view만 만드는 것이 이번 인수 조건을 충족하는가, 아니면 이번에 실제 공개 view를 신설해야 하는가?
- 어느 선택이든 공개 데이터 범위 또는 관찰 가능한 인수 결과를 바꾼다. 보안·비밀 관련 gap은 가정으로 메울 수 없다는 build-auto 지침에 따라 구현 전에 HALT한다. 외부 사람 전용 작업이 아니라 저장소 내 보안 계약 미결정이므로 awaiting-operator 대상이 아니다.

## Auto Run Result

2026-10-30 감독자 재확인: 아래는 원래 escalation의 이력이다. 위 계약은 커밋 6dc5964에서 해소되었고 독립 Orca Codex 조사로 현재 코드와 권한 반례를 다시 대조했다. 이력의 blocked 표시는 현재 미해결 스펙을 뜻하지 않는다. 실제 PG 권한 검증은 구현 시 수행한다.

Status: blocked (원래 escalation 이력)

- 차단 사유: intent gap — core 공개 view의 SQL 객체·노출 컬럼·허용 데이터 범위가 미결정이다. 근거와 확정할 질문은 위 미해결 보안 계약에 기록했다.
- 완료한 작업: 티켓·에픽·관련 아키텍처·선행 계획 확인, 독립 CLI 세션의 읽기 전용 코드 조사, 현재 코드 재확인과 계획 작성이다.
- 소스·시험 파일 변경, 구현, 시험 실행, 커밋, 원격 push는 하지 않았다. 리뷰 단계에 진입하지 않았다.
- `tickets.py mark`는 build-auto HALT에서 blocked 기록용으로 한 번만 실행했다. 티켓을 done으로 표시하지 않았다.
- 외부에서 사람만 수행 가능한 작업은 발견하지 않았다. 이번 차단은 공개 데이터 보안 계약의 미결정이며 awaiting-operator로 바꾸지 않는다.
