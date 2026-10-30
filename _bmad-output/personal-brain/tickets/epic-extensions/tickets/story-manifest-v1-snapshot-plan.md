---
title: 'manifest v1과 설정 snapshot'
type: 'feature'
ticket: '2'
created: '2026-10-30'
status: blocked
baseline_revision: '3243d52861acf5d62e31e4204446b0d56c584bb8'
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
blocked_reason: "intent gap: 티켓이 따르도록 지정한 12.4 ABI v1 schema에 snapshot 전달 칸이 없으며, 비밀 입력의 운반·검증·오류 정책을 확정할 근거가 없다. 보안·비밀에 닿는 결정 공백은 워크플로 규칙에 따라 임의 가정으로 닫을 수 없다."
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

위 결정과 원래 티켓 요구를 기준으로 구현자가 작업 목록과 AC를 확정하고 검증한다.

## Implementation Notes

- 변경 전 작업 트리는 깨끗했고 git add --refresh가 성공했다.
- 읽기 전용 독립 CLI 조사 세션 `01a18b15-7b13-7250-b60d-106cf16e202c`가 현재 코드와 선행 tracer를 조사했다. 소스·시험 수정과 시험 실행은 없었다.
- 기존 연구의 미구현 설정·registry 주장은 현재 코드에서 이미 해소되어 그대로 계획 근거로 쓰지 않았다.

## Plan Change Log

## Review Triage Log

## Design Notes

### 확정이 필요한 보안 입력 계약

티켓의 문구는 “전달 칸은 12.4의 schema를 따른다”다. 그러나 해당 schema의 properties는 BRAIN_ABI_VERSION·BRAIN_DATABASE_URL·BRAIN_WORK_ID·BRAIN_ATTEMPT_TOKEN·BRAIN_WORK_KIND·BRAIN_TARGET_KIND·BRAIN_TARGET_ID·BRAIN_RUN_GENERATION·BRAIN_ACCOUNT·BRAIN_RANGE_FROM·BRAIN_RANGE_TO뿐이다. snapshot 전달 칸·JSON 형식·크기·실패 규칙은 없다.

에픽 12 Boundaries는 “manifest와 설정 snapshot은 epic-extensions다”라고 하고, spine AD-33도 설정 입력을 에픽 13 소유로 둔다. 이는 구현 소유권을 설명하지만, 티켓이 따르라고 한 선행 전달 칸을 제공하지 않는다. 추가 변수를 허용하는 schema만으로 비밀 입력의 새 운반 계약이 확정되지는 않는다.

확정할 사항은 다음과 같다.
- 티켓의 선행 schema 준수 요구를 ABI v1의 새 선택 입력을 추가하는 것으로 해석해도 되는가? 그렇다면 환경 변수의 이름·직렬화 구조·크기 상한·입력 오류 동작을 어떤 계약으로 고정하는가?
- 비밀 참조가 누락되거나 잘못되면 실행을 거부하는 정책, 비밀 참조만 설정 CLI에 노출하는 정책, 자식 진단이 알려진 비밀값을 포함할 때 폐기 또는 제거하는 정책을 어떤 계약으로 고정하는가?

현재 워크플로의 Persistent Facts는 보안·비밀·마스킹에 닿는 결정 공백을 임의 가정으로 닫지 않고 blocked로 HALT하도록 명시한다. 이 공백은 비밀이 든 snapshot의 프로세스 입력 경계에 해당한다.

## Verification

- 정적 조사만 했다. ABI schema·코덱·프로세스 port·설정 코덱·설치·감독자 조립을 직접 읽고 독립 조사 결과와 대조했다.
- 제품 소스와 시험을 변경하지 않아 빌드·시험은 실행하지 않았다. 기능 동작이나 AC 충족을 주장하지 않는다.

## Auto Run Result

Status: blocked

차단 조건: `intent gap`. 티켓이 따르도록 지정한 12.4 ABI v1 schema에 snapshot 전달 칸이 없으며, 비밀 입력의 운반·검증·오류 정책을 확정할 근거가 없다.

- 현재 코드 직접 조사와 읽기 전용 독립 CLI 조사로 위 공백을 확인했다. 구체적인 파일·재사용점·해결할 질문은 Code Map과 Design Notes에 기록했다.
- 제품 소스·시험은 수정하지 않았고 구현·빌드·시험·커밋·push를 수행하지 않았다. 이 계획 파일만 추가했다.
- build-auto HALT 절차에서만 `tickets.py mark 13.2 blocked`를 실행했다. 티켓이나 계획을 done으로 표시하지 않았다.
- 도메인·DNS·API 키 발급·외부 콘솔 등 저장소 밖 사람의 실행 작업 때문에 멈춘 상황은 아니다. 따라서 awaiting-operator와 operator_actions는 적용하지 않았다.
- 재개에는 비밀 snapshot의 입력 계약과 누락 비밀·진단 처리 정책을 계획에 확정하는 작업이 필요하다.
