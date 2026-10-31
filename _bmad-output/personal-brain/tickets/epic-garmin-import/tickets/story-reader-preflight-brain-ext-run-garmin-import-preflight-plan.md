---
title: '보존 reader와 수동 preflight'
type: 'feature'
ticket: '3'
created: '2026-10-31'
status: done
baseline_revision: '15ceb529147d61690ce5668f6d907d3c2dca6608'
route: 'full'
route_source: 'pinned'
risk: 'medium'
review: 'quick'
review_source: 'pinned'
lenses_ran: [quick]
review_loop_iteration: 0
followup_review_recommended: true
context:
  - _bmad-output/personal-brain/tickets/epic-garmin-import/epic-garmin-import-research-code.md
warnings: [oversized]
deferred:
  - summary: '검토 필요: [ASSUMPTION] Q2 범위는 알려진 날짜·시각 열만 요약하고 다른 열은 원문으로 보존한다.'
  - summary: '검토 필요: [ASSUMPTION] 기존 private capture 형식의 코드 명세가 없어 version1 정규화 manifest를 엄격히 받고 알 수 없는 형식은 거부한다. 실제 capture 생성 단계에서 명시 변환한다.'
  - summary: '검토 필요: [ASSUMPTION] 수동 target은 default 또는 최대 64자의 영숫자·밑줄·하이픈으로 제한한다.'
  - summary: '검토 필요: [ASSUMPTION] 수동 report 일감은 최대 30초 기다린 뒤 미완료면 queued 상태를 반환한다. 재개 checkpoint는 현재 미제공으로 보고한다.'
---

<intent-contract>

## Intent

**Problem:** 현재 Garmin tracer는 첫 raw·일 지표만 읽으며 전수 보존 reader·반입 전 충돌 보고·공용 수동 실행 명령이 없다.

**Approach:** schema10/15 snapshot의 모든 표·열·원래 키를 read-only로 읽고 private manifest의 capture·source 분류를 바탕으로 dataset·계정·권위 v1과 preflight를 계산한다. 공용 `brain ext run <name> <job> [--target …]`은 허용된 일감만 기존 감독 큐에 넣고, 실제 감독자가 preflight를 실행해 private 상세와 공개 집계를 만든다.

## Boundaries & Constraints

**Always:** Python 표준 sqlite3 read-only URI, 원문 TEXT와 NULL 및 원래 키, dataset-local 정수 이력, D2→D1→D4→D5→D3 순서를 보존한다. 역할은 private manifest의 source 분류에서만 얻고 계정은 raw 본문의 userProfileId가 dataset마다 단일 값일 때만 확인한다. preflight는 원본과 대상 garmin·core 계약 표에 쓰지 않는다. 큐/attempt 상태 기록과 저장소 밖 private 보고서 생성은 허용한다. 공개 출력에는 허용한 집계·상태만 포함하고 해시·원문·계정·개인 날짜·경로는 제외한다. 합성 fixture·격리 PG/Brain 홈만 사용한다. 파일 경계·최소 권한·attempt 검사를 유지한다.

**Never:** 원본 migration/normalize, 실데이터·운영 홈 접근, 모델/네트워크 수집/발신, 실제 전수 반입·verify 구현, 적용된 migration 수정, core의 Garmin 이름 하드코딩, push·티켓 done 처리를 하지 않는다. 구현자는 소스·시험만 편집하고 커밋·계획 상태를 바꾸지 않는다.

## I/O & Edge-Case Matrix

| 상황 | 입력/상태 | 기대 동작 | 오류 처리 |
|---|---|---|---|
| 보존 | schema10/15, 선택 schema16 표·추가 열·NULL·정수 이력 | 모든 표·열·키·원문을 읽고 없음과 빈 표 구분 | schema9는 고정 오류 |
| 충돌 | 다섯 후보의 겹침·본문/metadata 충돌·한쪽 표·단독 키 | Q1~Q4 공통 비키 열 NULL 안전 비교와 raw 본문 별도 집계, v1 미선택 0 | 미지원 차이·제외 사유 보고 |
| 계정·역할 | profile id 단일/없음/복수, 이름과 다른 manifest 역할 | 단일만 확인, 나머지 미확인, source 분류 순서 사용 | 잘못된 manifest는 고정 오류 |
| 불변·공개 | 실행 전후 snapshot과 PG 계약 표, 원문/계정/날짜 표식 | snapshot 해시·계약 행 수 같음, private 상세 존재, 공개 표식 없음 | 안전한 고정 오류만 공개 |
| 수동 실행 | 허용/미허용 job·같은 target 재요청·꺼진 확장 | 허용만 감독 큐, 열린 행 합치기, 꺼진 확장 거부·보류 유지 | 고정 오류, 발신/즉시 실행 없음 |
| 준비·재개 | migration·manifest/ABI·role/attempt·이전 batch | 준비 상태·예상 INSERT/파일 요청·재개 batch·원본 불변 보고 | 준비 실패를 성공으로 표시하지 않음 |

</intent-contract>

## Code Map

- `packages/core/src/extensions/manifest.ts`, `packages/core/schemas/extensions/v1/{manifest.schema.json,README.md}`, `packages/core/fixtures/extensions/v1/`: 현재 work는 kind/execution/runtime/entry만 허용한다. 선택 수동 job 이름을 호환 추가하고 기존 manifest의 미허용 기본을 유지한다. kind의 기존 underscore 규칙을 보존해 공개 하이픈 job을 연결한다.
- `packages/core/src/{brain.ts,index.ts,codes.ts}`, `src/extensions/`, `src/ports/store.ts`: BrainExt에 공용 run을 넣고 getExtension·manifest decode·WorkStore.addWork·clock/idGen을 재사용한다. 같은 kind/target의 열린 일감과 extension holdGroup·supervised 계약을 유지한다.
- `apps/cli/src/commands/{index.ts,ext-install.ts,schedules-run.ts}`, CLI dispatch·메타·출력 및 `apps/cli/src/runtime/extensions.ts`: CommandSpec/SDK 1:1 등록, 명령 실행은 큐 요청과 결과 관찰 경계를 지킨다.
- `apps/cli/src/daemon/supervisor.ts`, `packages/core/src/extensions/snapshot.ts`: 설치 manifest와 선언 설정의 보호된 launch를 재사용한다. 설정을 raw 출력하지 않는다.
- `extensions/garmin/{manifest.json,src/import.py,src/health.py,migrations/0001_tracer.sql}`: tracer와 health 계약 유지. 별도 부작용 없는 reader/preflight·ABI entry를 추가한다. core23·garmin1과 실제 schema ledger/role/attempt 준비를 읽기만 한다.
- `extensions/garmin/tests/fixtures.py`, `apps/cli/python-test/garmin-tracer.test.ts`, `apps/cli/test/ext-fixture.ts`: 고정 SQL archive의 합성 schema 생성·frozen Python3.14.10·extHome·실제 감독자·cleanup 재사용. private capture 접근 금지.

## Tasks & Acceptance

**Execution:**
- [x] 단계 1 — `packages/core/src/extensions/run.ts`, manifest/schema/공유 fixture·관련 core/PG/CLI 시험 및 일반 report·설치 manifest runtime port, `brain.ts`·exports·codes·명령 메타·`apps/cli/src/commands/ext-run.ts` — 수동 job 허용과 큐 진입·중복 합치기·비활성 거부 및 SDK/CLI 등록을 완성한다.
- [x] 단계 2 — `extensions/garmin/src/{reader,preflight,import_preflight}.py`, `manifest.json`, `tests/{fixtures,check_preflight}.py` — 전수 reader·다섯 후보 기대값·dataset/계정/v1·Q1~Q4·preflight 항목·private/public 보고·준비 확인을 만든다. 기존 import는 유지하고 import-verify는 후속 진입점으로 선언하되 미구현 고정 오류로 거부한다.
- [x] 단계 3 — `apps/cli/python-test/garmin-preflight.test.ts`와 필요한 회귀 시험 — 공개 report/ABI 입력·work별 필수 설정·reports 재설치 보존 및 실제 설치·공용 명령·감독자를 관통해 기대 집계/오류·불변·비노출을 관찰하고 전체 suite를 확인한다.

**Acceptance Criteria:**
- Given 합성 다섯 후보와 독립 기대표가 있을 때, When `brain ext run garmin import-preflight`의 일감을 실제 감독자로 실행하면, Then 표별 건수·겹침·본문/metadata 충돌·단독 키가 기대와 같고 v1 미선택 수는 0이며 계정이 단일하지 않은 dataset은 미확인이다.
- Given schema10/15와 schema16 표·추가 열·NULL·빈/없는 표가 있을 때, When reader/preflight를 실행하면, Then 원래 표/열/키/원문이 전수 보존되어 보고되고 schema9는 고정 오류로 거부된다.
- Given snapshot 해시와 대상 garmin·core 계약 표 행 수를 기록했을 때, When preflight를 실행하면, Then 모두 같고 private 상세만 Brain 홈 확장 데이터 아래에 생기며 공개 출력·attempt 진단에는 해시 값·합성 원문·계정·개인 날짜·경로가 없다.
- Given 허용되지 않은 job 또는 꺼진 확장이 있을 때, When 공용 명령을 실행하면, Then 고정 오류이며 새로운 실행/보류 우회가 없고 같은 target 열린 일감 요청은 같은 work id로 합쳐진다.
- Given 준비되지 않은 migration/ABI/role/attempt 또는 이전 batch가 있을 때, When preflight를 실행하면, Then 정확한 준비 실패와 재개 여부·예상 INSERT/파일 요청·단위/NULL 위험·제외 사유가 private 상세와 안전 집계로 보고된다.

## Implementation Notes

- 독립 Verify: 계획의 build/typecheck·합성 preflight·기본/Python 전체 명령을 실행했다. 기본 최초 실행은 변경하지 않은 PG CLI fixture 준비 중 연결 timeout 1건으로 실패했고, 무변경 단독15개·전체3896개(기존1skip) 재실행과 Python15개가 성공했다. 최초 로그를 보존하며 timeout 근본 원인은 미확정이다. 표별 독립 기대17개·readiness 실패6개·재개 미제공도 별도 대조했다. 행렬 모든 행은 실행된 공유/순수/PG/실제 설치 감독자 시험으로 확인했다. 임의 INSERT 상한은 제거하고 후보 수와 미확정 boolean으로 구분했다.

- 단계 2·3 구현 보고: 전수 reader·Q1~Q4·권위 provenance·계정·정규화 manifest·안전 보고서·일감별 필수설정과 일반 ABI readiness 및 실제 설치 감독자 관통을 구현했다. 최초 집계 누락을 보완했다. 지휘자 순수 합성 시험은 성공했다. 구현자 기본3896개·Python15개 성공 보고 뒤 전체 독립 검증을 준비한다. 근거 없는 행당 세 관계 INSERT 상한은 제거를 요청한다.

- capture 형식 조사: 공개 준비 문서와 archive 및 원본 repo scripts에는 생성 코드·JSON 키 명세가 없었다. private 자료는 열지 않았다. 안전한 정규화 version1 입력을 명시하고 모르는 형식은 거부하여 역할이나 경로를 추측하지 않는다.

- 단계 1: 수동 alias·안전 공개 report 선언, SDK/CommandSpec, 설치 manifest 판독, registry 잠금 아래 활성/버전/일감 확인과 중복 합치기를 구현했다. 공개 text 집계·주입 Clock/Timer를 보완했다. 구현자 build/typecheck·기본 3558개·메타/출력206개 성공 보고와 별도로 지휘자 core/PG 집중82개가 성공했다. 실제 report 보존·최소권한 readiness·필수설정·감독자 관통은 다음 단계에서 검증한다.

## Plan Change Log

## Review Triage Log

### 2026-10-31 — Review pass
- verdicts: 3 findings — high 0, medium 3, low 0, false 0, maybe-false 0
- findings:
  - `[medium]` `[patch]` 필수 INSERT 회수와 과도 권한·membership에도 role_ready가 참이었다 — 기존 provisioning의 열별 권한 계약과 probe 누락을 확인했다. 기존 role_ready 조건을 읽기 전용 권한 점검으로 교정하고 격리 PG에서 필수 열 회수·초과 SELECT·membership의 실제 실패를 확인했다.
  - `[medium]` `[patch]` catalog·attempt 함수 준비 질의가 실패하면 보고서를 쓰기 전에 예외로 끝났다 — 직접 SQL→최상위 PREFLIGHT_INVALID 경로를 확인했다. 존재/권한 점검과 저장점으로 probe 실패를 분리해 준비 실패 상세·공개 집계를 유지했다. catalog SELECT와 attempt EXECUTE 회수의 실제 실패·보고·비노출 시험이 통과했다. stale attempt는 성공으로 처리하지 않는다.
  - `[medium]` `[patch]` 설치 잠금 예외가 SDK 밖으로 전파돼 crash 경로에 로컬 경로를 노출할 수 있었다 — compiled SDK에 lock rejection을 주입해 throw를 재현했다. 기존 설치 명령과 같은 고정 DB_UNAVAILABLE 결과로 catch하고 SDK·명령 envelope 표식 비노출 회귀가 통과했다.
- 세 건 모두 새 공개 API나 상태를 더하지 않고 기존 조건·예외 경로를 직접 교정했다. 별개 근본 원인으로 각각 기록했다. defer/reject는 없다.

## Design Notes

- manifest는 work의 선택 `manual` 문자열을 공개 job alias로 쓴다(생략은 불허). report 일감에는 선택 `public_report`의 고정 count/check label 목록을 선언한다. runtime은 이 선언에 있는 라벨과 비음수 안전정수/boolean만 반환하고 자유 문자열·임의 객체·여분 key를 거부한다. ABI result 자유 summary로 데이터를 운반하지 않는다. 기존 최소 manifest는 계속 유효하다.
- [ASSUMPTION] 일반 run은 enqueue 결과를 반환한다. public_report 선언 일감은 같은 SDK/명령에서 최대 30초 완료를 기다려 해당 work UUID의 검증된 공개 집계를 함께 반환하고, 아직 끝나지 않으면 work_id·queued 상태를 반환한다. SDK의 wait budget을 시험에서 주입할 수 있게 하되 임의 private 경로 입력은 받지 않는다. target 기본은 안정 문자열 default, 명시 target은 경로 아닌 짧은 opaque 식별자이며 SDK에서도 검증한다.
- 설치 manifest/version 검증 후 enabled 확인과 enqueue를 같은 registry 잠금 트랜잭션으로 확정한다. 새 Store port·PG adapter·fake/계약 시험을 함께 구현한다. 동일 target 병렬 요청도 합쳐지고 disable 경합 시 보류를 우회하지 않는다.
- private/public 결과는 `<home>/extensions/<name>/reports/<work UUID>/`의 고정 파일이다. runtime과 Python 모두 symlink·경로 탈출을 거부하고 0700/0600·동일 디렉터리 원자 rename을 쓴다. packageDigest 제외·설치 교체 보존·배송 source에서 데이터 제외를 함께 구현해 report가 설치를 오염시키거나 사라지지 않게 한다.
- prelaunch core runtime이 읽은 schema ledger/설치 manifest와 기대 migration 목록의 비밀 없는 준비 metadata를 일반 선택 ABI 환경 입력으로 전달한다. schema·코덱·fixture를 일치시키고 Garmin 이름 분기를 넣지 않는다. Python에는 brain_app/admin URL을 넘기지 않는다. Python은 자신의 role/catalog/attempt 현재성만 읽기 SQL로 확인하며 core contract SELECT 권한을 넓히지 않는다.
- work별 필수 설정은 호환 선택 required-key 목록으로 선언하여 preflight는 capture manifest만, 기존 import는 기존 다섯 설정을 자식 시작 전에 검사한다. work별 선언 없는 기존 work는 기존 work-stage 필수 검증을 유지한다.
- 기존 capture 생성 코드와 비개인 형식 명세는 저장소·archive·원본 repo의 scripts에 없음을 확인했다. [ASSUMPTION] 새 preflight 입력은 엄격한 version1 정규화 manifest로 받으며 기존 private manifest를 추측해서 파싱하지 않는다. 형식은 version:1, capture_id:비어 있지 않은 문자열, datasets 배열의 각 항목(dataset:안정 문자열, source:분류 문자열, snapshot:manifest 기준 안전 상대 경로), files 배열(source:분류 문자열, snapshot:안전 상대 경로, bytes:비음수 정수)다. source 분류는 development→D1, production→D2, development-before-change→D3, production-pre-epic5→D4, production-before-history-start→D5의 고정 mapping이며 파일명에서 얻지 않는다. 분류 누락/중복·미지원 형식은 고정 오류로 거부한다. 실 manifest는 열지 않는다. capture id와 목록 fingerprint는 private에만 남기고 source 분류의 고정 mapping으로 D1~D5 역할을 정한다. schema user_version은 10/15만 지원하며 그 위에 존재하는 schema16 표는 읽는다. user_version16 자체는 미지원으로 고정 오류다.
- 현재 import_batches/mapping을 읽어 기존 batch와 존재 여부를 보고하되 checkpoint/version/fingerprint 기능은 미제공이고 재개 가능으로 단정하지 않는다. 전체 checkpoint 영속화는 후속 importer 소관이다.

- preflight의 dataset 등록은 계산한 등록 자료를 private 보고서에 남기는 뜻이며 DB 쓰기는 후속 importer가 맡는다. 큐 제어 표는 무변경 요구의 대상 계약 표와 구별한다.
- 미선택 수는 권위 규칙으로 승자를 정하지 못한 키 수다. 선택되지 않은 대안 자료의 보존 수와 별개로 보고한다. 정수 id 이력은 dataset 안에서만 사건 식별자다.
- manifest 입력은 고정 source 분류의 명시 mapping을 따르며 snapshot basename으로 역할을 추정하지 않는다. 보고서 경로는 사용자 입력으로 임의 지정하지 않고 확장 데이터의 안전한 하위에 둔다.

## Verification

**Commands:**
- `pnpm build` — 전체 빌드 성공.
- `pnpm typecheck` — 전체 타입 검사 성공.
- `uv run --project extensions/garmin --frozen --python 3.14.10 python extensions/garmin/tests/check_preflight.py` — 독립 기대표로 reader·Q1~Q4·계정/권위·공개 투영·원본 불변 성공.
- `pnpm test` — 기본 core/PG/CLI와 manifest·명령 메타·SDK/중복/보류 회귀 성공.
- `pnpm test:python` — 실제 frozen 설치·감독자·CLI preflight와 기존 tracer/health 전체 성공, 신규 시험 skip 없음.

격리 DB는 기존 globalSetup·extHome을 쓰고 finally에서 daemon abort/종료·store·DB·자기 marker role·임시 홈을 정리한다. source 쓰기·운영 접근·배포는 없다. 실제 테스트 이름과 명령 결과는 구현 뒤 아래에 기록한다.

## Auto Run Result

Status: built

- 구현: 보존 reader·Q1~Q4·계정·권위 v1과 엄격한 정규화 capture 입력, private 상세와 제한된 공개 집계, 최소권한 readiness를 구현했다. 공용 SDK/CLI 수동 실행은 설치 manifest 허용·활성 상태를 확인하고 같은 target의 열린 감독 일감을 합친다. 원본과 대상 반입 계약 표에는 쓰지 않는다.
- 리뷰: quick 1개, medium 3건을 각각 patch했다. high 0·low 0, 새 review defer 0·reject 0이다. 기존 ASSUMPTION 네 항목은 frontmatter에 유지한다. 기각한 finding은 없다.
- 후속 검토: `followup_review_recommended: true`. 이번 pass의 patch는 high 0·medium 3·low 0이다. 필수 권한 회수·과도 SELECT·membership·catalog/attempt 권한 회수는 시험했으나, 중첩 membership과 실행 도중 권한·DDL이 함께 바뀌는 조합은 독립적으로 검토하지 않았다. 이 권한 조합과 실패 보고 일관성을 후속 검토 대상으로 남긴다.
- 최종 검증: Verification의 다섯 명령을 리뷰 수정 후 지휘자가 모두 실행해 성공했다. build/typecheck·합성 preflight, 기본 165개 파일/3898개 성공(기존 선택 시험 1개 skip), 전체 Python 4개 파일/15개 성공(skip 없음)이다. 명령·상태·로그 인덱스는 `/tmp/brain143-final-results.json`, 로그는 `/tmp/brain143-final-*.log`다.
- 행렬 감사: 독립 합성 기대표의 17개 표 건수, NULL/원문·빈/없는 표·schema16 표·schema9 거부, Q3/Q4·raw 본문/metadata 분리·계정/권위·경로/권한·중복 합치기·비활성 거부·readiness 및 실제 설치 감독자 불변/비노출 시험이 실행돼 성공했다. 추가 6개 readiness 실패 반례와 재개 미제공도 확인했다. 종단 시험은 snapshot 해시와 대상 계약 표의 행 수보다 강한 전체 내용 동등성을 대조한다.
- 검증 중 관측: 최초 독립 기본 suite는 기존 PG CLI fixture 준비 중 연결 timeout 1건이 있었다. 소스 무변경 단독15개·전체3896개 재실행이 통과했고 리뷰 수정 뒤 최종 전체3898개도 통과했다. 최초 로그 `/tmp/brain143-verify-default.log`와 전체 검증 인덱스를 보존한다. timeout 근본 원인은 미확정이다.
- 제한: 기존 private capture는 문서화한 version1 정규화 형식으로 명시 변환해야 한다. 전체 checkpoint·실반입·verify는 후속 범위다. 실제 INSERT 총계는 미확정으로 표시하며 입력에서 계산한 보존·dataset·mapping·파일 요청 후보와 구별한다. 실제 capture·운영 홈은 열지 않았다. 저장소 밖 사람 전용 작업은 없다.
- 티켓 done 표시와 `tickets.py mark`, push는 실행하지 않았다. 오케스트레이터가 별도 검증 후 완료를 결정한다.

변경 파일과 역할:

- `_bmad-output/personal-brain/tickets/epic-garmin-import/tickets/story-reader-preflight-brain-ext-run-garmin-import-preflight-plan.md` — 계획·가정·단계 검증·리뷰 triage·종료 근거를 기록한다.
- `apps/cli/python-test/garmin-preflight.test.ts` — 실제 설치·CLI·감독자·권한 실패·불변·비노출·재설치 보존을 검증한다.
- `apps/cli/python-test/vitest.config.ts` — 공유 확장 role을 사용하는 Python 파일들을 순차 실행한다.
- `apps/cli/src/commands/ext-run.ts` — 공용 수동 실행과 공개 집계의 text/JSON 출력을 제공한다.
- `apps/cli/src/commands/index.ts` — ext run CommandSpec를 등록한다.
- `apps/cli/src/daemon/supervisor.ts` — 일감별 필수 설정과 비밀 없는 ledger·ABI 준비 metadata를 전달한다.
- `apps/cli/src/doctor/store.ts` — 새 Store port의 실패 값을 제공한다.
- `apps/cli/src/runtime/extensions.ts` — 안전한 설치 manifest·공개 보고 판독과 reports 영속 보존을 제공한다.
- `apps/cli/test/dispatch.test.ts` — 새 Store port의 dispatcher 실패 fixture를 맞춘다.
- `apps/cli/test/ext-run.test.ts` — 잠금 실패의 고정 오류 envelope와 비노출을 검증한다.
- `apps/cli/test/fixtures/extensions/pyfixture/judge.py` — 새 readiness 입력의 Python 공유 판정을 구현한다.
- `extensions/garmin/manifest.json` — 세 수동 alias와 preflight 공개 라벨·일감별 필수 설정을 선언한다.
- `extensions/garmin/src/capture_manifest.py` — 정규화 manifest의 source 분류·안전 경로·목록 fingerprint를 읽는다.
- `extensions/garmin/src/contract.py` — schema10/15 및 선택 schema16 표의 지원 열을 정의한다.
- `extensions/garmin/src/import_preflight.py` — 읽기 전용 preflight와 readiness·보고서 ABI 진입점을 제공한다.
- `extensions/garmin/src/import_verify.py` — 후속 verify가 아직 미구현임을 고정 오류로 알린다.
- `extensions/garmin/src/preflight.py` — 계정·Q1~Q4·권위·파일 분류·NULL/단위 위험·후보·공개 투영을 계산한다.
- `extensions/garmin/src/reader.py` — 모든 사용자 표·열·원래 키·값을 read-only sqlite3로 읽는다.
- `extensions/garmin/src/reports.py` — 고정 경로에 제한 권한과 원자 교체로 보고서를 저장한다.
- `extensions/garmin/src/role_probe.py` — 필수·과도 권한과 membership을 읽고 실패한 probe를 분리한다.
- `extensions/garmin/tests/check_preflight.py` — 독립 합성 기대·충돌·manifest·원본 불변·안전 보고를 확인한다.
- `extensions/garmin/tests/fixtures.py` — 합성 다섯 후보와 정규화 capture manifest를 만든다.
- `packages/core/fixtures/extensions/v1/check-manifests.py` — 수동 alias·공개 라벨·필수 설정의 Python 관계 검증을 추가한다.
- `packages/core/fixtures/extensions/v1/manifests.json` — 신규·기존 manifest 호환 판정 사례를 공유한다.
- `packages/core/fixtures/process-abi/v1/env.json` — readiness 환경 입력의 정상/오류 fixture를 공유한다.
- `packages/core/schemas/extensions/v1/README.md` — 호환 선택 manual/public_report/required_settings 계약을 설명한다.
- `packages/core/schemas/extensions/v1/manifest.schema.json` — 신규 선택 선언의 JSON Schema를 배송한다.
- `packages/core/schemas/process-abi/v1/env.schema.json` — 일반 확장 홈·readiness 선택 입력을 선언한다.
- `packages/core/src/brain.ts` — BrainExt.run SDK를 조립한다.
- `packages/core/src/extensions/install.ts` — 설치 manifest·공개 report runtime port를 정의한다.
- `packages/core/src/extensions/manifest.ts` — 수동 alias·공개 label·일감별 설정을 엄격히 검증한다.
- `packages/core/src/extensions/run.ts` — 허용 일감의 원자 큐 진입과 제한된 공개 report·고정 오류를 반환한다.
- `packages/core/src/extensions/snapshot.ts` — 선언된 일감별 필수 설정을 snapshot 생성에 적용한다.
- `packages/core/src/index.ts` — 공용 실행 함수를 export한다.
- `packages/core/src/ports/store.ts` — 원자 확장 enqueue와 migration 버전 목록 조회 port를 정의한다.
- `packages/core/src/process-abi/codec.ts` — 새 선택 환경 입력을 엄격히 판정한다.
- `packages/core/src/testing/contracts/extension-store.ts` — 병렬 중복 요청과 비활성/버전 변경 거부를 계약 시험한다.
- `packages/core/src/testing/fakes/store.ts` — 새 원자 enqueue port를 fake에 제공한다.
- `packages/core/test/extensions.test.ts` — 수동 허용·공개 report·대기 예산·잠금 실패를 검증한다.
- `packages/postgres/src/extensions.ts` — registry 행 잠금 아래 활성·버전·등록 일감을 대조하고 enqueue한다.
- `packages/postgres/src/store.ts` — owner별 적용 migration 버전을 읽기 전용으로 조회한다.
- `packages/postgres/test/unavailable.test.ts` — 새 PG port의 연결 실패 값을 확인한다.

정리 결과: 자기 Orca Run의 조사·구현·quick 리뷰 워커 세 개의 정식 succeeded 보고 전문을 수락하고 모두 release했다. 목록은 completed/released 3개이고 다음 페이지·reclaimable·미처리 Delivery는 없다. 중복 구현자·강제 취소·kill은 없었다. transcript source_changed는 관찰 오류로 보존했으며 실제 실행 실패로 세지 않았다. 제어 셸의 출력 수집 입력 대기는 해당 셸의 EOF로 복구했고 워커를 다시 띄우지 않았다. 전용 제어 셸은 최종 커밋·HALT 체크포인트 뒤 마지막에 닫는다.
