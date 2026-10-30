---
title: 'manifest v1과 설정 snapshot'
type: 'feature'
ticket: '2'
created: '2026-10-30'
status: done
baseline_revision: 6a47782ecbefca27a8e8c5bd840d27e28c774d40
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

manifest v1의 JSON Schema와 공유 판정 fixture를 배포하고, 선언한 확장 설정 키만 받는다. 실행 시작마다 DB 설정·기계 값·비밀 참조로 불변 snapshot을 만들어 자식에게 전달하고, manifest 일감을 supervised로 등록한다.

## Boundaries & Constraints

- 비밀은 argv·로그·stdout·공개 상태에 나오지 않는다. 확장은 settings·config.toml·.env를 직접 읽지 않는다.
- 12.4 ABI v1 schema에 아래 선택 입력을 추가한다. 기존 필수 입력과 기존 비확장 실행 동작은 유지한다.
- Python 실행 환경·확장 role·단계별 재개·공개 상태 view 완성·실제 Garmin 인증은 후속 티켓 범위다.
- 티켓의 완료 판정은 오케스트레이터가 소유한다.

## Decision (2026-10-30, 추천으로 정함, 13.2 escalation 해소)

- ABI v1에 선택 환경 입력 `BRAIN_SETTINGS_SNAPSHOT`을 추가하고 schema·코덱·배포 fixture에 반영한다. snapshot 사용 확장 실행에는 필수다. UTF-8 JSON 객체는 `{"version":1,"extension":"testext","values":{"testext.limit":10,"testext.token":"<resolved-secret>"}}` 형태이며 빈 설정도 명시한다. 선언한 해당 확장 키와 검증된 값만 전달하고 전체 config·환경을 상속하지 않는다. 기존 필수 필드·이벤트는 바꾸지 않는다. env schema의 문자열 검증과 파싱된 객체의 schema 검증을 각각 수행한다.
- 직렬화 UTF-8은 최대 16384바이트다. 초과, JSON·버전·확장명·선언·타입 오류는 잘라서 진행하지 않고 자식 시작 전에 안전한 고정 오류로 거부한다. DB 설정을 일관되게 읽고 기계 값과 `.env`를 실행 준비 때 한 번 해석해 불변 snapshot을 만든다. DB와 파일 간 원자성은 주장하지 않는다. 재시도는 새 snapshot이다. 비동기 준비 중 취소·보류·attempt 소유권 상실도 시작 전에 확인하고 일시 DB 오류와 설정 오류를 구별한다.
- 비밀 설정에는 환경 변수 이름(`^[A-Za-z_][A-Za-z0-9_]*$`)만 저장·CLI 반환한다. Runtime만 `.env`에서 해석하고 값은 trim하지 않는다. 필수 참조 누락·빈 값·해석 실패는 자식 시작 없이 `EXTENSION_CONFIG_INVALID`, `retryable=false`와 값 없는 고정 안내로 처리한다. 선택 비밀은 manifest가 명시했을 때만 누락을 허용하고 키를 생략한다. 로그인 단계에 필요한 입력을 구분해 최초 인증을 막지 않는다. Garmin tokenstore는 비밀 내용이 아닌 경로만 전달한다.
- snapshot 확장 실행의 자식 stdout은 프로토콜로만 소비하고 원문을 로그·저장·공개 출력에 복사하지 않는다. stderr와 progress/result/error 자유 문자열은 고정 안내로 대체한다. worker 오류 코드는 신뢰된 manifest 선언 목록과 대조하고 그 밖은 고정 코드로 투영한다. retryable 분류는 유지한다. 이 확장 전용 공개 동작은 12.4의 미등록 코드 보존과 다름을 명시한다. 예외·파서 오류·환경·snapshot도 출력하지 않는다. 자식 자체도 stdout에 비밀을 출력하지 않도록 구현·실제 자식 시험한다. 기존 비snapshot 실행의 12.4 가림은 유지한다.
- 시험은 기존 ABI fixture 호환, 두 단계 schema·UTF-8 경계, 미등록 키, 누락 필수 비밀의 자식 시작 0회, 선택 비밀·최초 로그인, 준비 중 취소/소유권 상실, 설정 변경과 재시도, 합성 비밀의 일반 문자열·JSON escape·청크 분할 및 유효 오류 코드 반례를 포함한다. 실제 자식의 argv·stdout·데몬 로그·attempt·failures·registry·status 전체를 검사한다. 기존 가림 함수만으로 임의 비밀값 보호를 주장하지 않는다.
- 보호 모드는 자식 입력이 아닌 신뢰된 설치 manifest와 실행 종류로 먼저 선택한다. 설치 연결 확인·인증·일감에 모두 적용하며 snapshot 생성 실패·누락은 기존 모드로 폴백하지 않고 시작을 거부한다. 기존 최소 manifest 연결 확인도 보호한다. 보호 범위는 신뢰된 확장의 우발적 진단 누출이며 악의적 자식의 모든 은닉 채널 방지는 주장하지 않는다.
- manifest의 각 설정 선언에 필요한 실행 단계 목록(`connect`, `auth`, `work`)을 둔다. 해당 단계 목록에 속한 키는 그 단계에서 필수이며 그 밖에서는 값이 없으면 생략한다. 로그인으로 생성할 토큰은 `work`·필요하면 `connect`에만 필수로 선언하고 `auth`에서 요구하지 않는다. 설정된 값은 어느 단계든 검증한다. 실제 인증 구현은 후속 범위다.
- 보호 진단 투영을 공통으로 적용해 정상·unknown·예외 복구, 연결 확인의 registry/status를 포함하여 저장·로그·fingerprint 생성 전에 원문을 제거한다. snapshot 필수 여부 → env 검증 → JSON 객체 검증 → 해당 manifest 키·타입 대조 순으로 시작 전에 검사한다. DB 키들은 단일 SELECT 또는 동일 snapshot 트랜잭션으로 읽고 `.env`는 준비당 한 번 파싱한다. 준비 결과는 설정 오류·일시 DB 오류·취소·보류·소유권 상실을 구분한다. 시작 직전 소유권·취소·보류·종료 신호를 재확인하고 시작 후 소유권을 잃으면 자식을 정리한다.
- 독립 검증은 기존 코덱이 잘못된 snapshot을 허용하고, 알려지지 않은 합성 비밀이 stderr·오류 메시지·코드와 연결 확인 registry로 새는 반례를 확인했다. 위 보호 모드·단계·투영 보완을 구현과 통합 검증의 필수 조건으로 한다. 기존 fixture 통과는 신규 보안 검증의 대체가 아니다.
- 근거: 에픽 요구 `epic-extensions.md:35-36`, spine AD-18·33, `packages/core/schemas/process-abi/v1/env.schema.json`의 추가 입력 허용, `packages/core/src/ports/process.ts`와 `apps/cli/src/runtime/process-group.ts`의 env 전달, `packages/core/src/process-abi/codec.ts` 및 `packages/core/src/domain/failure.ts`의 패턴 가림 한계. 읽기 전용 Codex 검증은 기존 env 21·event 31·run 42 fixture 판정과 일반 합성 비밀 및 오류 코드 유출 반례를 확인했다. 16384는 기존 사실이 아닌 이 결정의 새 상한이다.

</intent-contract>

## Code Map

- `packages/core/src/extensions/manifest.ts` — 최소 여섯 필드만 받는 기존 코덱이다. 이름·상대 경로 검증을 재사용할 수 있다.
- `packages/core/src/extensions/install.ts` — manifest 검증 후 복사·DDL·registry 기록·연결 확인 순서다. 연결 확인 자식 입력은 환경 변수다.
- `packages/core/src/settings/index.ts` — SettingDefinition·정확한 키 등록·기본값 검증이 있고 미등록 키는 거부한다. 확장 선언 등록은 아직 없다.
- `apps/cli/src/commands/config-get.ts`, `config-set.ts`, `dispatch.ts` — 설정 명령의 preflight와 조립도 확장 정의를 받아야 한다.
- `packages/core/schemas/process-abi/v1/env.schema.json` — 실행 신원·DB URL과 선택 계정·시간 범위를 정의한다. snapshot 전용 속성이 없다. 추가 환경 변수는 허용한다.
- `packages/core/src/process-abi/codec.ts` — PROCESS_ABI_ENV·PROCESS_ABI_OPTIONAL_ENV와 decodeAbiEnv에도 snapshot 전달 계약이 없다.
- `packages/core/src/ports/process.ts`, `apps/cli/src/runtime/process-group.ts` — 현재 입력은 spec.env이고 stdin은 ignore다.
- `packages/core/src/queue/supervisor.ts` — launch builder는 동기다. 실행 직전 DB·파일 조회를 붙이려면 준비 경계 변경이 필요하다.
- `packages/core/src/domain/work-item.ts`, `packages/postgres/src/work.ts`, `apps/cli/src/daemon/supervisor.ts` — 실행 분류와 enqueue 저장·감독자 launch 등록을 함께 연결해야 한다.
- `packages/core/package.json`, `packages/core/test/process-abi.test.ts` — schema·fixture 배포 목록과 tarball 검사 전례다.

## Tasks & Acceptance

- [x] `packages/core/src/extensions/manifest.ts`, `packages/core/schemas/extensions/v1/manifest.schema.json`, `packages/core/fixtures/extensions/v1/`: 최소 manifest와 일감·기본 예약·raw view·인증 명령·설정·오류 코드 선언을 검증하고 TS·Python이 공유 fixture를 판정한다. JSON Schema로 표현할 수 없는 선언 간 관계는 각 코덱이 추가 검증한다.
- [x] `packages/core/src/settings/index.ts`, `apps/cli/src/dispatch.ts`: 설치 manifest에 선언된 설정만 수락하며 비밀 설정은 환경 변수 이름만 저장하고 반환한다.
- [x] `packages/core/src/extensions/snapshot.ts`, `packages/core/src/process-abi/codec.ts`, `apps/cli/src/runtime/extensions.ts`: 단일 DB 조회, 준비당 한 번의 `.env` 해석 및 기계 tokenstore 경로로 단계별 snapshot을 만들고 16384 UTF-8 바이트와 키·타입·필수 비밀을 검사한다.
- [x] `packages/postgres/migrations/0012_extension_work_kinds.sql`, `packages/postgres/src/extensions.ts`, `packages/postgres/src/work.ts`, `apps/cli/src/daemon/supervisor.ts`: 설치된 일감·인증 종류만 supervised로 등록하며 실행 중 설치도 발견하고 재시도마다 새 snapshot을 준비한다.
- [x] `packages/core/src/extensions/check.ts`, `packages/core/src/queue/supervisor.ts`: 연결 확인과 supervised 실행에서 자식 시작 전 snapshot과 소유권·취소·보류를 확인하고 공통 진단 투영을 저장·fingerprint 전에 적용한다. 실행 중 소유권 상실 시 자식을 정리한다.
- [x] `packages/core/test/process-abi.test.ts`, `packages/core/test/extension-snapshot.test.ts`, `packages/core/test/supervisor.test.ts`, `apps/cli/test/ext-install.test.ts`, `apps/cli/test/process-group.test.ts`: ABI 호환과 크기 경계, 단계별 비밀, 준비 중 취소·보류·소유권 상실, DB 설정 변경 후 재시도 및 실제 자식 진단 누출을 확인한다.

## Implementation Notes

- 구현 세션 `01a18b21-a740-7392-a4c5-a8ad7bd119db`를 사용했다. 첫 CLI 대기의 실제 프로세스가 종료돼 같은 세션을 재개했으며, 기존 변경을 보존한 채 구현과 검증을 완료했다.
- 독립 읽기 전용 `quick` 리뷰 세션은 `01a18b41-8ce3-75a2-9897-eeb5423773d5`다. 리뷰 수정도 동일 구현 세션에 맡겼다.
- 도메인·DNS·API 키 발급·외부 콘솔 등 사람이 저장소 밖에서 수행해야 하는 AC는 없다. 실제 Garmin 인증은 이 티켓의 후속 범위이므로 `awaiting-operator` 대상이 아니다.

- 변경 전 작업 트리는 깨끗했고 git add --refresh가 성공했다.
- 읽기 전용 독립 CLI 조사 세션 `01a18b15-7b13-7250-b60d-106cf16e202c`가 현재 코드와 선행 tracer를 조사했다. 소스·시험 수정과 시험 실행은 없었다.
- 기존 연구의 미구현 설정·registry 주장은 현재 코드에서 이미 해소되어 그대로 계획 근거로 쓰지 않았다.

## Plan Change Log

## Review Triage Log

### 2026-10-30 — Review pass

- verdicts: 3 findings — high 1, medium 2, low 0, false 0, maybe-false 0
- findings:
  - `[medium]` `[patch]` 예약 날짜 범위 누락 — `scheduledDates`가 PostgreSQL 청구 결과에 있으나 확장 launch 환경에 매핑되지 않는 것을 확인했다. 기존 ABI의 `BRAIN_RANGE_FROM`·`BRAIN_RANGE_TO`를 조건부 전달하고 실제 자식이 범위를 확인하도록 수정했다.
  - `[high]` `[patch]` 재설치 시 tokenstore 삭제 — 기계 경로가 교체되는 패키지 폴더 안에 있고 성공 시 이전 폴더가 삭제됨을 확인했다. 기존 target을 이동하기 전에 tokenstore를 staged 패키지에 복사하며, 정상 재설치와 마이그레이션 실패 후 내용 보존을 시험했다. 공개 경로는 유지했다.
  - `[medium]` `[patch]` 내부 오류 코드 이름으로 manifest 허용 목록 우회 — 작업자 `error` 이벤트의 코드를 내부 생성 코드와 구분하지 않는 것을 확인했다. ABI 판정의 오류 출처를 추적해 작업자 코드는 manifest 선언만 허용하며 `retryable`을 유지한다. 연결 확인과 감독자 양쪽에 `PROCESS_DIED`·`ABI_EXIT_FAILED` 반례를 추가했다.

- 독립 `quick` 리뷰의 세 지적을 모두 개별 검증했다. 원인은 기존 입력 매핑·교체·진단 투영 경계에서 직접 교정할 수 있어 `patch`로 처리했다. 보류·기각한 지적은 없다.
- 별도 자체 점검에서 새 README·코드 주석·Python 설명의 한국어 작성 규칙 위반도 바로잡았다. 이는 독립 리뷰의 세 지적 집계에는 포함하지 않는다.

## Design Notes

### 확정이 필요한 보안 입력 계약

티켓의 문구는 “전달 칸은 12.4의 schema를 따른다”다. 그러나 해당 schema의 properties는 BRAIN_ABI_VERSION·BRAIN_DATABASE_URL·BRAIN_WORK_ID·BRAIN_ATTEMPT_TOKEN·BRAIN_WORK_KIND·BRAIN_TARGET_KIND·BRAIN_TARGET_ID·BRAIN_RUN_GENERATION·BRAIN_ACCOUNT·BRAIN_RANGE_FROM·BRAIN_RANGE_TO뿐이다. snapshot 전달 칸·JSON 형식·크기·실패 규칙은 없다.

에픽 12 Boundaries는 “manifest와 설정 snapshot은 epic-extensions다”라고 하고, spine AD-33도 설정 입력을 에픽 13 소유로 둔다. 이는 구현 소유권을 설명하지만, 티켓이 따르라고 한 선행 전달 칸을 제공하지 않는다. 추가 변수를 허용하는 schema만으로 비밀 입력의 새 운반 계약이 확정되지는 않는다.

확정할 사항은 다음과 같다.
- 티켓의 선행 schema 준수 요구를 ABI v1의 새 선택 입력을 추가하는 것으로 해석해도 되는가? 그렇다면 환경 변수의 이름·직렬화 구조·크기 상한·입력 오류 동작을 어떤 계약으로 고정하는가?
- 비밀 참조가 누락되거나 잘못되면 실행을 거부하는 정책, 비밀 참조만 설정 CLI에 노출하는 정책, 자식 진단이 알려진 비밀값을 포함할 때 폐기 또는 제거하는 정책을 어떤 계약으로 고정하는가?

현재 워크플로의 Persistent Facts는 보안·비밀·마스킹에 닿는 결정 공백을 임의 가정으로 닫지 않고 blocked로 HALT하도록 명시한다. 이 공백은 비밀이 든 snapshot의 프로세스 입력 경계에 해당한다.

## Verification

- `pnpm build`와 `pnpm typecheck`: 통과.
- `pnpm exec vitest run packages/core/test/supervisor.test.ts packages/core/test/extensions.test.ts apps/cli/test/ext-install.test.ts`: 99건 통과. 이후 DB 설정 변경과 실제 재시도를 추가한 `pnpm exec vitest run apps/cli/test/ext-install.test.ts`: 14건 통과.
- `pnpm exec vitest run packages/postgres/test/migrate.test.ts packages/postgres/test/schema.test.ts packages/postgres/test/cli.test.ts packages/postgres/test/work-store.test.ts apps/cli/test/daemon-run.test.ts`: 254건 통과.
- `uv run --no-project --with jsonschema python packages/core/fixtures/extensions/v1/check-manifests.py`: 공유 manifest fixture 10건 통과. 기본 Node 시험은 Python을 요구하지 않는다.
- `pnpm test`: 129개 파일, 3464건 통과. 이후 최초 로그인·기계 경로 확인을 추가한 `pnpm exec vitest run apps/cli/test/ext-install.test.ts`: 14건 통과.
- JSON Schema 단독으로 확장 이름과 선언 키의 일치·중복 키·예약 참조를 표현할 수 없어, 배포 스키마와 언어별 의미 검증을 함께 적용한다. 실제 Garmin 인증, Python 실행 환경과 공개 상태 view 완성은 계약에서 후속 범위다. 악의적 자식의 은닉 채널은 보호 범위가 아니다.

- 오케스트레이터 재검증: `pnpm build`, `pnpm typecheck`, 핵심 시험 99건, PostgreSQL 묶음 254건, Python fixture 10건, 전체 `pnpm test` 129개 파일·3464건이 통과했다. 첫 PostgreSQL 묶음 실행의 잠금 시험 1건은 시간 초과했으나 단독 및 묶음 재실행은 통과했다.

- 리뷰 수정 후 최종 재검증: `pnpm build`, `pnpm typecheck`, 핵심 시험 103건, PostgreSQL 묶음 254건, Python fixture 10건 통과. `pnpm test --retry=1`은 129개 파일·3468건 통과했다.
- 수정 후 기본 병렬 전체 실행에서 기존 PostgreSQL 연결 종료 시험의 잠금 대기 포착 실패·시간 초과가 관찰됐고, 단일 worker 전체 실행에서는 CLI 시험의 DB 준비 연결이 시간 초과됐다. 각 실패 파일의 단독 재실행은 모두 통과했다. 실패 기록을 보존하고 시험 코드의 시간 제한이나 기대값으로 우회하지 않았다.
- 기준 리비전과 현재 계획의 `<intent-contract>`가 같은지 확인했고, 수정 전후 diff를 직접 읽었다. `git diff --check`가 통과했다.

## Auto Run Result

Status: built

- manifest v1 schema·TS 코덱·공유 fixture와 선택 Python 판정 진입점을 배포한다. 선언된 확장 설정만 받고 비밀은 참조만 저장·반환한다.
- 설치된 일감·인증 종류를 supervised로 등록하고 실행마다 DB 설정·기계 경로·비밀 참조를 새 snapshot으로 준비한다. ABI 입력·UTF-8 상한·단계별 필수 설정·시작 전 취소/보류/소유권을 검사하고 진단은 저장 전에 투영한다.
- 독립 `quick` 리뷰 3건을 모두 수정했다: `high` 1건(tokenstore 보존), `medium` 2건(날짜 범위 전달, 작업자 오류 출처 구분). 보류 0건, 기각 0건이다. 새 설명의 한국어 작성 규칙도 별도로 바로잡았다.
- `followup_review_recommended: true`: 첫 리뷰에서 `high` 수정 1건과 `medium` 수정 2건이 있었다. 수정된 tokenstore 교체·복구 예외 경계와 작업자/내부 오류 출처 구분은 통합 시험 후 독립 재검토를 아직 받지 않았다.
- 최종 검증은 빌드·타입 검사, 핵심 103건, PostgreSQL 묶음 254건, Python fixture 10건 및 전체 `pnpm test --retry=1` 3468건 통과다. 기본 전체 실행의 간헐적 DB 연결·대기 실패는 위 Verification에 기록했다.
- 티켓이나 계획을 `done`으로 표시하지 않았고 `tickets.py mark`를 실행하지 않았다. 사람만 수행 가능한 외부 작업은 없다. 실제 Garmin 인증·Python 실행 환경·공개 상태 view 완성은 후속 범위다.
- 검토한 변경과 이 계획을 같은 커밋에 기록하며 원격 push는 하지 않는다.

### 변경 파일

- [_bmad-output/personal-brain/tickets/epic-extensions/tickets/story-manifest-v1-snapshot-plan.md](story-manifest-v1-snapshot-plan.md) — 구현·검증·리뷰 분류와 최종 결과를 기록한다.
- [apps/cli/src/commands/config-get.ts](../../../../../apps/cli/src/commands/config-get.ts) — 확장 키의 선언 검증을 런타임 설정 조립에 위임한다.
- [apps/cli/src/commands/config-set.ts](../../../../../apps/cli/src/commands/config-set.ts) — 확장 키를 설치 manifest 기반으로 검증한다.
- [apps/cli/src/daemon/supervisor.ts](../../../../../apps/cli/src/daemon/supervisor.ts) — 설치된 실행 종류를 갱신하고 snapshot과 날짜 범위를 준비한다.
- [apps/cli/src/dispatch.ts](../../../../../apps/cli/src/dispatch.ts) — 설치 manifest에서 설정 정의를 조립한다.
- [apps/cli/src/doctor/store.ts](../../../../../apps/cli/src/doctor/store.ts) — 일괄 설정 조회의 실패 store 계약을 맞춘다.
- [apps/cli/src/runtime/extensions.ts](../../../../../apps/cli/src/runtime/extensions.ts) — 비밀 참조·기계 경로를 제공하고 재설치 tokenstore를 보존한다.
- [apps/cli/test/daemon-run.test.ts](../../../../../apps/cli/test/daemon-run.test.ts) — 변경된 계약·실행 경로와 기존 동작의 회귀를 검증한다.
- [apps/cli/test/dispatch.test.ts](../../../../../apps/cli/test/dispatch.test.ts) — 변경된 계약·실행 경로와 기존 동작의 회귀를 검증한다.
- [apps/cli/test/ext-install.test.ts](../../../../../apps/cli/test/ext-install.test.ts) — 변경된 계약·실행 경로와 기존 동작의 회귀를 검증한다.
- [apps/cli/test/install.test.ts](../../../../../apps/cli/test/install.test.ts) — 변경된 계약·실행 경로와 기존 동작의 회귀를 검증한다.
- [apps/cli/test/process-group.test.ts](../../../../../apps/cli/test/process-group.test.ts) — 변경된 계약·실행 경로와 기존 동작의 회귀를 검증한다.
- [apps/cli/test/setup.test.ts](../../../../../apps/cli/test/setup.test.ts) — 변경된 계약·실행 경로와 기존 동작의 회귀를 검증한다.
- [package.json](../../../../../package.json) — schema 판정 시험용 Ajv 의존성을 추가한다.
- [packages/core/fixtures/extensions/v1/check-manifests.py](../../../../../packages/core/fixtures/extensions/v1/check-manifests.py) — 배포용 공유 판정 사례와 언어별 검사 진입점을 제공한다.
- [packages/core/fixtures/extensions/v1/manifests.json](../../../../../packages/core/fixtures/extensions/v1/manifests.json) — 배포용 공유 판정 사례와 언어별 검사 진입점을 제공한다.
- [packages/core/fixtures/process-abi/v1/settings-snapshots.json](../../../../../packages/core/fixtures/process-abi/v1/settings-snapshots.json) — 배포용 공유 판정 사례와 언어별 검사 진입점을 제공한다.
- [packages/core/schemas/extensions/v1/README.md](../../../../../packages/core/schemas/extensions/v1/README.md) — 배포 schema와 소비자가 따를 검증 계약을 정의한다.
- [packages/core/schemas/extensions/v1/manifest.schema.json](../../../../../packages/core/schemas/extensions/v1/manifest.schema.json) — 배포 schema와 소비자가 따를 검증 계약을 정의한다.
- [packages/core/schemas/process-abi/v1/README.md](../../../../../packages/core/schemas/process-abi/v1/README.md) — 배포 schema와 소비자가 따를 검증 계약을 정의한다.
- [packages/core/schemas/process-abi/v1/env.schema.json](../../../../../packages/core/schemas/process-abi/v1/env.schema.json) — 배포 schema와 소비자가 따를 검증 계약을 정의한다.
- [packages/core/schemas/process-abi/v1/settings-snapshot.schema.json](../../../../../packages/core/schemas/process-abi/v1/settings-snapshot.schema.json) — 배포 schema와 소비자가 따를 검증 계약을 정의한다.
- [packages/core/src/extensions/check.ts](../../../../../packages/core/src/extensions/check.ts) — 시작 전 snapshot을 검증하고 진단을 안전하게 투영한다.
- [packages/core/src/extensions/install.ts](../../../../../packages/core/src/extensions/install.ts) — 설정 snapshot으로 연결을 확인하고 실행 종류를 등록한다.
- [packages/core/src/extensions/manifest.ts](../../../../../packages/core/src/extensions/manifest.ts) — manifest 선언과 필드 간 관계를 검증한다.
- [packages/core/src/extensions/snapshot.ts](../../../../../packages/core/src/extensions/snapshot.ts) — 단계별 설정·비밀·기계 값을 snapshot으로 만든다.
- [packages/core/src/index.ts](../../../../../packages/core/src/index.ts) — snapshot 계약을 패키지에서 내보낸다.
- [packages/core/src/ports/store.ts](../../../../../packages/core/src/ports/store.ts) — 일괄 설정 조회와 확장 실행 종류 등록 계약을 추가한다.
- [packages/core/src/process-abi/codec.ts](../../../../../packages/core/src/process-abi/codec.ts) — snapshot 입력과 오류 출처를 검증·구분한다.
- [packages/core/src/queue/supervisor.ts](../../../../../packages/core/src/queue/supervisor.ts) — 비동기 준비와 보호된 실행·정리·진단 투영을 연결한다.
- [packages/core/src/settings/index.ts](../../../../../packages/core/src/settings/index.ts) — 기본값 없는 선언 설정을 지원한다.
- [packages/core/src/testing/contracts/settings-store.ts](../../../../../packages/core/src/testing/contracts/settings-store.ts) — 일괄 설정 조회 계약을 검증한다.
- [packages/core/src/testing/fakes/store.ts](../../../../../packages/core/src/testing/fakes/store.ts) — 설정 조회와 확장 실행 등록의 메모리 구현을 맞춘다.
- [packages/core/test/extension-snapshot.test.ts](../../../../../packages/core/test/extension-snapshot.test.ts) — 변경된 계약·실행 경로와 기존 동작의 회귀를 검증한다.
- [packages/core/test/extensions.test.ts](../../../../../packages/core/test/extensions.test.ts) — 변경된 계약·실행 경로와 기존 동작의 회귀를 검증한다.
- [packages/core/test/process-abi.test.ts](../../../../../packages/core/test/process-abi.test.ts) — 변경된 계약·실행 경로와 기존 동작의 회귀를 검증한다.
- [packages/core/test/supervisor.test.ts](../../../../../packages/core/test/supervisor.test.ts) — 변경된 계약·실행 경로와 기존 동작의 회귀를 검증한다.
- [packages/postgres/migrations/0012_extension_work_kinds.sql](../../../../../packages/postgres/migrations/0012_extension_work_kinds.sql) — 확장 실행 종류 등록 표를 만든다.
- [packages/postgres/src/extensions.ts](../../../../../packages/postgres/src/extensions.ts) — 설치와 실행 종류 등록을 같은 트랜잭션에 기록한다.
- [packages/postgres/src/migrate.ts](../../../../../packages/postgres/src/migrate.ts) — core schema 버전을 12로 올린다.
- [packages/postgres/src/settings.ts](../../../../../packages/postgres/src/settings.ts) — 설정 값을 단일 SELECT로 조회한다.
- [packages/postgres/src/work.ts](../../../../../packages/postgres/src/work.ts) — 등록된 확장 일감을 supervised로 저장한다.
- [packages/postgres/test/cli.test.ts](../../../../../packages/postgres/test/cli.test.ts) — 변경된 계약·실행 경로와 기존 동작의 회귀를 검증한다.
- [packages/postgres/test/migrate.test.ts](../../../../../packages/postgres/test/migrate.test.ts) — 변경된 계약·실행 경로와 기존 동작의 회귀를 검증한다.
- [packages/postgres/test/schema.test.ts](../../../../../packages/postgres/test/schema.test.ts) — 변경된 계약·실행 경로와 기존 동작의 회귀를 검증한다.
- [packages/postgres/test/store.test.ts](../../../../../packages/postgres/test/store.test.ts) — 변경된 계약·실행 경로와 기존 동작의 회귀를 검증한다.
- [packages/postgres/test/unavailable.test.ts](../../../../../packages/postgres/test/unavailable.test.ts) — 변경된 계약·실행 경로와 기존 동작의 회귀를 검증한다.
- [packages/postgres/test/work-store.test.ts](../../../../../packages/postgres/test/work-store.test.ts) — 변경된 계약·실행 경로와 기존 동작의 회귀를 검증한다.
- [pnpm-lock.yaml](../../../../../pnpm-lock.yaml) — 추가한 시험 의존성을 잠근다.
