---
title: '20.1 testext 읽기 명령 tracer'
type: 'feature'
ticket: '20.1'
created: '2026-11-05'
status: 'built'
baseline_revision: '255d34e98cf6a4f6a049c5f2fdc5ae5385603772'
route: 'full'
route_source: 'pinned'
risk: 'medium'
review: 'thorough'
review_source: 'pinned'
lenses_ran: ['blind-hunter', 'edge-case-hunter', 'verification-gap', 'intent-alignment']
review_loop_iteration: 4
followup_review_recommended: false
context:
  - '_bmad-output/personal-brain/tickets/epic-extension-platform/epic-extension-platform.md'
  - '_bmad-output/personal-brain/architecture-brain-v1-slice-1/architecture-brain-v1-slice-1.md'
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** 설치된 확장이 선언한 짧은 읽기 명령을 CLI·MCP·guide에서 발견하고 안전하게 실행할 공통 경로가 없다.

**Approach:** manifest `commands[]`를 공통 메타로 변환하고 testext `echo-stats` 하나를 CLI와 최소 MCP stdio 서버로 관통시킨다. 출력 schema 검증·기존 출력 코덱·재검증을 공통 실행 경로에서 수행한다.

## Boundaries & Constraints

**Always:** AD-37/5/11/28/33을 따른다. 메타는 `ns: ext.<name>`, verb는 kebab-case 명령, 설명·예시, risk read, hook false, dryRun false, 입력/출력 schema를 갖는다. stdin 봉투는 `{abi:1,user_id,settings,input}`이며 input만 입력 schema로 검증한다. user_id는 기존 self 조회다. 큐에 넣지 않고 timeout·출력 바이트 상한·그룹 정리·리더 reap을 지킨다. 설치·활성 상태와 설치 manifest에서 메타를 도출하며 실행 직전도 활성 여부를 확인한다. 실자료 없는 합성 fixture와 임시 Brain 홈·소유한 격리 PG만 시험하며 `withoutHarnessFolders`를 적용한다. 공개 파일·보고에 개인 홈 절대 경로나 비밀을 쓰지 않는다.

**Never:** 20.2 사용자 이행, 20.3 cron, 20.4 패키지 공급원, Garmin 내용, 새 제거 제품 명령, 기존 건강 경로 부활, 새 독자적 보안/보존 정책, main 병합·push, 다른 작업의 PG/role/컨테이너 변경. 구현 워커는 소스·시험만 편집하고 커밋·push·티켓 상태 전이와 추가 워커 실행은 하지 않는다.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| 읽기 명령 | 설치·활성 testext, 유효한 input | CLI/MCP 같은 가려진 결과, guide/MCP 같은 입력 schema, 봉투 self/settings/input 전달, 큐 추가 없음 | 정상 |
| 입력 오류 | input schema 위반 | 자식 실행 없이 거부 | 값 없는 명령 입력 오류 |
| 출력 보호 | 중첩 시험 비밀 문자열 | CLI/MCP/text 모두 기존 코덱으로 가림 | 가린 뒤 enum 위반은 값 없이 `EXTENSION_COMMAND_OUTPUT_REDACTED` |
| 잘못된 출력 | schema 위반·깨진 JSON·비정상 종료·출력 상한 초과 | 성공 결과 없음, 그룹 정리·reap | 안정된 명령 오류 코드, 원본 출력 미노출 |
| timeout | 자손이 pipe를 잡고 종료를 무시 | 제한시간 뒤 TERM/KILL, 자손 그룹 소멸·리더 reap | timeout 오류; 정리 불명은 성공 아님 |
| 선언 거부 | write 선언·중복 이름·잘못된 schema·이름 충돌 | 설치 거부·미등록 | `EXTENSION_INVALID` |
| 수명주기 | disable 또는 등록/manifest 부재 | CLI/help/guide/MCP에서 소멸, 오래된 호출 거부; enable 후 재등장 | 미등록 명령 오류 |

</intent-contract>

## Code Map

- `packages/core/src/extensions/manifest.ts`, `packages/core/schemas/extensions/v1/manifest.schema.json`, `packages/core/fixtures/extensions/v1/` — decoder/공유 schema·Python fixture 일치. 기존 connection_check의 runtime/상대 entry 형태 재사용. commands를 가진 확장 이름과 명령은 underscore 금지로 MCP 충돌 방지; 기존 비명령 확장 이름을 소급 변경하지 않는다.
- `packages/core/src/extensions/install.ts`, `status.ts`, `snapshot.ts` — 설치 전 decoder, 활성 원천, settings 조립 재사용. Python 준비 조건에 Python 명령 포함. `ports/store.ts`의 readSelfUser 사용.
- `apps/cli/src/runtime/extensions.ts`, `assembly.ts`, `config/codec.ts` — 설치 manifest·readSecrets·machineValues·런타임/DB 연결. 설치되지 않았거나 비활성인 확장을 목록에 넣지 않는다.
- `apps/cli/src/dispatch.ts`, `commands/index.ts`, `commands/guide-schema.ts`, `bin.ts` — 정적 메타/선택기를 동적 메타로 확장. `ext.<name>`은 CLI에서 ext/name 노드로 매핑해야 한다. 기존 standalone guide는 미설치·DB 부재에서도 정적 목록을 유지한다.
- `packages/core/src/ports/process.ts`, `apps/cli/src/runtime/process-group.ts`, `runtime/process-inspector.ts`, `packages/core/src/queue/process-cleanup.ts` — 현재 stdin ignore를 선택적 stdin 지원으로 확장하고 detached 그룹 정리 재사용. enqueue 경로인 extensions/run.ts는 재사용하지 않는다.
- `packages/core/src/output/mask.ts`, `output/codecs.ts`, `codes.ts`, `envelope.ts` — 출력 검증 후 maskOutputValue/공통 코덱 및 재검증. 엔벨로프만 가리는 것으로 대체하지 않는다.
- `apps/cli/test/ext-fixture.ts`, `test/fixtures/extensions/testext/`, `tooling/test-changed/rules.mjs` — extHome/pgHome 및 합성 자식으로 바깥 프로세스 검증. 신규 자식·schema·MCP 경로의 선택 규칙 확인.

## Tasks & Acceptance

**Execution:**
- [x] `packages/core/src/extensions/manifest.ts`, 공유 schema/fixture — commands의 이름·runtime/entry·description·선택 examples·input_schema/output_schema·timeout·risk read 계약을 추가하고 설치 시 write/중복/무효 schema를 거부한다. 제품에서 schema validator를 쓰는 패키지의 runtime 의존성도 선언한다.
- [x] `packages/core/src/extensions/commands.ts` (신규), `extensions/install.ts`, exports/ports — 공통 명령 메타와 설정 봉투, 입력/출력 검증·가림·재검증 및 오류 코드를 구현한다. 설정은 기존 snapshot의 values를 settings 객체로 전달하고 기존 self를 사용한다. self 없음은 USER_MISSING이다.
- [x] `ports/process.ts`, `runtime/process-group.ts` — 선택적 stdin 전달과 모든 성공/오류 종료의 AD-33 정리·reap을 구현한다. stdout/stderr를 각각 바이트 한도로 처리하고 원본 진단을 사용자 출력에 섞지 않는다.
- [x] `apps/cli/src/runtime/extension-commands.ts` (신규), `bin.ts`, `dispatch.ts`, `commands/guide-schema.ts` — 활성 명령을 공통 registry로 조립해 CLI `brain ext testext echo-stats --json`과 help/guide를 연결한다. 일반 입력은 `--input <json>`으로 받고 생략 시 `{}`다. 실행 전 활성 상태를 재확인한다.
- [x] `apps/cli/src/mcp/serve.ts` (신규), `commands/mcp-serve.ts` (신규), `commands/index.ts` — `brain mcp serve`의 최소 stdio MCP 초기화/tools/list/tools/call을 구현한다. 도구 이름은 `ext_<name>_<command>`의 hyphen→underscore이며 같은 메타/실행 함수를 쓴다. stdout은 프로토콜 전용이다. 도구 목록은 수명주기 변경을 반영한다.
- [x] `apps/cli/test/fixtures/extensions/testext/manifest.json`, `bin/echo-stats.mjs` (신규), `apps/cli/test/extension-commands.test.ts` (신규), core 직접 시험 — matrix 전 행 및 실제 CLI/MCP/guide 표면을 검증한다. timeout은 실제 PID·자손 종료 증거를 남긴다. schema enum 재검증 실패를 CLI와 MCP 모두에서 검증한다.
- [x] `tooling/test-changed/rules.mjs` 및 분류 시험 — 새 Python/SQL/자식 프로세스 전용 경로를 선택 규칙에 연결한다.

**Acceptance Criteria:**
- Given 설치된 testext, when CLI echo-stats·guide schema·MCP tools/list/call을 외부 프로세스에서 실행하면, then 공통 입력 schema·메타와 동일 결과를 관찰하고 봉투 ABI/self/settings 및 큐 불변을 입증한다.
- Given 합성 비밀과 enum 출력, when CLI/MCP에서 호출하면, then 원문 비밀은 출력되지 않으며 가린 뒤 enum 위반은 `EXTENSION_COMMAND_OUTPUT_REDACTED`이고 결과 값이 없다.
- Given 종료를 무시하는 자손 명령, when timeout이 지나면, then 리더와 자손이 정리되고 리더 reap이 확인되며 실패로 끝난다.
- Given 쓰기 명령 manifest, when 실제 설치를 실행하면, then 거부되고 어떤 표면에도 등록되지 않는다.
- Given 활성 명령, when disable/enable 또는 등록·manifest 부재를 재현하면, then CLI/help/guide/MCP 노출과 호출 가능 여부가 실제 상태를 따른다.


**Review repair requirements (pass 1):**
- `apps/cli/src/mcp/serve.ts` — null/primitive/배열·invalid request가 서버를 종료하지 않게 프로토콜 오류를 보내고 다음 요청을 처리한다. 요청 ID는 원값 유지, 결과와 설명 등 출력 내용은 기존 가림 유지. 정상 initialize→list/call 외부 시험과 잘못된 요청 뒤 정상 요청·ID 일치 시험을 추가한다.
- `runtime/json-schema.ts`, manifest/schema/Python fixture — async validator를 동기 port에 넣지 않고 등록 때 거부한다. 공통 input schema는 MCP 호환 type object이며, 출력 코덱이 바꾸는 입력 schema 계약은 설치 때 거부한다. CLI/guide/MCP input schema가 실행 계약과 동일하도록 한다. 비동기 schema 회귀는 unhandled rejection 없이 설치/호출 거부를 입증한다.
- `extensions/commands.ts`, 런타임/CLI/MCP lifecycle — 설치 잠금 대기를 제한하고 spawn 직후부터 관측 시간까지 실행 기한에 포함한다. 기존 signal/clock/timer 관례로 SIGINT/SIGTERM 취소를 정리/reap에 연결한다. 프로세스 시작 전 취소·잠금 timeout·느린 관측·부모 종료·선종료 리더/잔류 자손을 검증한다. 새 공개 제품 명령은 추가하지 않는다.
- `runtime/extension-commands.ts`, `extensions/commands.ts`, `bin.ts`, MCP — registry DB 실패를 실제 미설치와 구별해 확장 실행/MCP에 전달한다. 미설치·설정 없음·DB 사용 불가 상태에서도 정적 guide 메타는 제공한다. 실패 목록을 성공 빈 목록으로 바꾸지 않는다.
- 직접 시험 — Node connection_check+Python commands만 있는 fixture의 환경 준비 실패/성공과 CLI/MCP 결과·봉투를 검증한다. 정상 JSON stdout과 과다 stderr의 실패 코드/data 없음/원문 미노출, 확보한 메타 뒤 disable의 실행 재확인·자식 미시작, enum 재검증 실패, 가려진 성공 data의 CLI/MCP 동일성, registry/manifest 부재의 MCP 목록/호출 소멸을 추가한다. 기존 시험을 약화하지 않는다.


**Review repair requirements (pass 2):**
- `extensions/commands.ts`, `output/mask.ts`, CLI/MCP renderer — 구조화 가림뿐 아니라 직렬화 문자열에 기존 codec이 적용하는 변형까지 공통 경로에서 완료하고 출력 schema를 최종 재검증한다. `{"password":"hunter2x"}` 같은 구조화 키/값이 CLI JSON에는 새고 MCP/text만 바뀌는 상태를 없앤다. 동일한 가려진 성공 data를 모든 표면에서 반환하며 enum/const가 가림과 양립 못하면 값 없이 OUTPUT_REDACTED. 임의 JSON의 own `__proto__` 키를 잃지 않는다. JSON 1e400/Infinity는 성공 숫자로 승인하지 않는다.
- `runtime/json-schema.ts`, manifest decoder, 공유 Python checker/fixture — Ajv logger를 끄고 유한 숫자를 검증한다. TS/Python의 input schema compatibility 판정을 공유 합성 fixture에서 일치시킨다. 깊은 schema 사전 순회의 예외도 EXTENSION_INVALID로 반환한다. 새 마스킹 규칙을 발명하지 말고 기존 codec 계약을 사용한다.
- MCP — 명시 null 인자를 생략과 구분해 입력 검증에 그대로 전달한다. transport stdin EOF/close를 활성 명령 취소에 연결해 그룹 정리·reap 후 종료한다. 기존 protocol ID/잘못된 요청 복구/registry 실패 계약을 유지한다. 새 입력 프레임 제한 정책은 추가하지 않는다.
- command 설치 잠금의 실제 PostgreSQL adapter 경계에서 질의 및 unlock의 무기한 대기를 없애고 취소 뒤 소유 연결이 남지 않게 한다. 다른 install/migration 동작을 불필요하게 바꾸지 말고 필요하면 command 전용 옵션/port를 사용한다. 실제 adapter 질의 응답 중단 또는 동등한 socket 경계 시험으로 증거를 남긴다. 변경 경로를 test-changed 규칙에 연결한다.
- 부모 신호 시험은 command timeout을 60초처럼 길게 설정하고 별도 짧은 정리 예산 안에 종료·PID 소멸을 검증한다. 느린 초기 관측 시험은 수동 clock/timer로 기한을 먼저 진행시켜 초기 관측이 미완료인 동안 정리·종료되는지 검증한다. 단순 wall-clock 1500ms 시험으로 대체하지 않는다.
- 기존 실행 timeout_ms·stdout/stderr 1MiB·잠금 대기 30초 한도는 공통 메타/help 설명에 기록한다. 관련 수락·회귀 시험과 기존 통과 경로를 유지한다.


**Review repair requirements (pass 3):**
- `runtime/json-schema.ts` — JSON own properties만 검증한다. Ajv가 properties.__proto__ 제약을 무시하는 선언을 승인하지 않는다. 일반 결과 데이터의 own __proto__ 보존은 유지한다. 입력/출력 값의 비유한 숫자는 schema keyword 유무와 관계없이 거부해 직렬화 때 null로 바뀌지 않게 한다. 필요 순수 JSON 검사 helper를 core에 두어 SDK와 CLI/MCP 공통 실행을 보장한다.
- `extensions/commands.ts`, `extensions/status.ts`, 필요한 runtime/adapter — 준비 중 disable과 자식 시작의 동기화 순서를 보장한다. 이미 시작된 명령의 강제 중단 정책은 추가하지 않는다. 완료된 disable보다 뒤에 새로운 명령 프로세스가 시작되지 않음을 합성 지연/소유 잠금 시험 코드로 검증한다. 기존 설치·활성화·수명주기 계약과 bounded command lock을 유지한다.
- 공유 Python manifest checker/fixture — 깊은 순회의 RecursionError는 invalid로 판정하고 unresolved local/external reference는 TS와 동일하게 등록 거부한다. 원격 fetch/새 독자 schema 방언을 도입하지 않는다. 기존 같은 codec 기반 input schema 판정과 core 무의존 경계를 유지한다. 공유 fixture와 배포 경계에서 필요한 검증 코드를 보강한다.
- `mcp/serve.ts` — 비유한 숫자 ID는 Invalid Request, 정상 후속 요청은 계속 처리한다. 기존 문자열/유한 숫자 ID 원값 보존을 유지한다.
- 느린 관측 시험은 첫 bootTime 호출만 미완료, 정리 단계 후속 관측 즉시 응답으로 구성한다. 수동 clock을20ms까지만 진행해 초기250ms fallback 이전 완료 상태·리더 종료를 관찰한다. 임의 추가 시간 진행으로 회귀가 가려지지 않게 한다.
- 최신 시험 지시가 우선한다. 시험 코드는 작성하되 직접 시험·test:changed·전체시험·재현 명령을 실행하지 않는다. build/typecheck만 수행하고 `.brain-automation/implementation-20.1-round5.md`에 미실행/21.8 이관을 명시한다.


**Review repair requirements (pass 4):**
- `runtime/json-schema.ts`, Python checker/공유 fixture — 실제 Ajv가 compile하는 schema 경로에 대해 지원 불가 properties.__proto__ 선언의 누락이 없어야 한다. root absolute self-reference 및 nested $id scope로 도달하는 대상, legacy dependencies 하위 schema를 포함한다. literal const/enum/default/example 데이터의 동명 키를 schema 제약으로 오인하지 않는다. 새로운 원격 fetch·공개 schema 방언·입력 제한 정책은 추가하지 않는다.
- TS/Python은 unused definitions의 unresolved local/external ref도 같은 판정으로 처리한다. 기존 root에서 실제 사용하는 미해결 ref 거부와 정상 해결 가능한 ref 허용을 보존한다. 양쪽에 서로 다른 근사 resolver를 추가해 불일치를 늘리지 말고 기존 validator가 제공하는 해석과 작은 공통 계약을 활용한다.
- 위3개 입증 사례와 허용돼야 하는 인접 사례의 시험 코드를 보완한다. 직접 시험·변경 시험·전체시험·재현 명령은 금지하며 실행은21.8 이관·미실행이다. build/typecheck만 수행하고 `.brain-automation/implementation-20.1-round6.md`에 실제 결과를 남긴다.

## Implementation Notes

- Review pass4 보완: `.brain-automation/implementation-20.1-round6.md`. 별도 근사 ref 탐색 대신 Ajv의 기존 properties/patternProperties compile 규칙에 guard를 적용해 실제 도달 schema만 검사한다. Python fixture도 실제 runtime adapter를 이용하며 ref 판정을 공유한다. build/typecheck 각 종료0; 시험/재현은 미실행·21.8 이관.

- Review pass 3 보완: `.brain-automation/implementation-20.1-round5.md`. own JSON 속성·schema의 지원 불가 proto 제약·비유한 숫자·Python ref/깊이·disable 동기화 및 느린 관측 회귀 시험 코드를 보강했다. 최종 build/typecheck 각 종료0. 추가 시험/재현은 미실행이며21.8로 이관한다.

- Review pass 2 보완: `.brain-automation/implementation-20.1-round4.md`. build/typecheck 성공. round4 직접 시험 564개·변경 시험 TS 3961개(1 skip)/Python 32개는 실행 이력이다. 변경 시험은 14:33 시작, 유예 지시 전달 14:38, Python 단계 14:41 시작, 전체 14:43 종료로 지시 전달 중 실행이 계속됐다. 이후 추가 시험은 실행하지 않고 21.8로 이관한다. 후속 변경에 과거 통과를 소급하지 않는다.

- Review pass 1 수정 완료: `.brain-automation/implementation-20.1-round3.md`. 직접 시험 559개·core 후속 85개·Python install 4개·manifest 24개 통과. 최종 변경 시험 TS 3956개(1 skip)·Python 32개 통과. 지적별 수정은 후속 독립 리뷰에서 확인한다.

- 2차 구현: core port + CLI Ajv adapter로 경계 복구. CLI/guide/MCP·stdin 봉투·그룹 정리·출력 검증/가림/재검증과 수락 시험을 추가했다. 직접 시험 548개, Python fixture 20개, 전용 PG/단일 worker 변경 시험 TS 3945개·Python 32개 통과(기존 1 skip). 보고: `.brain-automation/implementation-20.1-round2.md`.

- 1차 구현은 manifest/stdin만 부분 완료. build 및 core extensions 직접 시험 80개 통과, 변경 시험은 경계 위반·PG timeout으로 실패했다. 전체 tracer 완료가 아니며 수락 기준을 유지한다.

## Plan Change Log

- Review pass 2: 최종 출력 코덱·언어별 선언 판정·실 DB 질의 기한·transport 취소의 실행 경계와 시간 검증을 보완한다. intent-contract 유지. KEEP: pass 1의 모든 구현·수락 시험, protocol ID 원값, core 무의존 port/adapter, 기존 출력 가림 규칙, command/self/settings 및 registry 계약. `.brain-automation/review2-implementation.patch`에 보존한 소스를 재적용해 위 보완을 재도출한다.

- Review pass 1: protocol/validator/command lifecycle 경계와 직접 수락 시험의 구체성이 부족했다. 다음 구현 보완을 적용한다. 현재 구현은 `.brain-automation/review1-implementation.patch`에 보존 후 소스만 기준으로 되돌리고 이를 재사용해 재도출한다. KEEP: core 무의존 port/adapter 경계, 공통 CLI/MCP 실행, 동적 수명주기 registry, 설정/self 봉투, 기존 출력 가림/재검증, 프로세스 그룹 신원 확인, 기존 통과 수락 시험과 README 코드표. intent-contract는 변경하지 않는다.

- 1차 구현의 Ajv core 런타임 의존이 `packages/second_brain/test/boundaries.test.ts`의 core 무의존 경계를 위반했다. schema 라이브러리는 외부 런타임 adapter에 두고 core에는 필요한 port/순수 계약을 유지하도록 구현 지침을 명확히 한다. 설치 거부·CLI/MCP 동일 검증·기존 decoder 호출의 안전한 동작을 유지한다. 경계 시험 삭제·완화는 금지한다. KEEP: manifest의 읽기 전용 선언·이름/상대 경로·중복 검증과 공유 fixture 계약.

- Review pass 3: JSON own-property/비유한 숫자 및 언어별 ref·깊이 판정, 준비 중 활성 전이, 초기 관측의 시간 검증을 보완한다. intent-contract는 유지한다. KEEP: 기존 CLI/MCP/guide 공통 메타·최종 가림/재검증·proto own key 보존·잠금 질의/해제 기한·EOF/신호 정리와 기존 모든 수락 시험 코드. `.brain-automation/review3-implementation.patch`를 보존 후 재적용해 보완한다. 추가 시험은21.8 이관.

- Review pass4: schema 하위·ref 도달 범위와 unused definition 판정을 일치시키도록 보완한다. intent-contract 유지. KEEP: pass3의 ownProperties·finite JSON·disable 직렬화·초기관측 시험, 기존 정상 schema/ref·literal 데이터 허용, 출력/수명주기 수락 코드 전부. `.brain-automation/review4-implementation.patch` 보존 후 재적용하며 추가 시험은21.8 이관한다.

## Review Triage Log

### 2026-11-05 — Review pass 2
- verdicts: 15 findings — high 2, medium 11, low 2, false 0, maybe-false 0
- 의도 정합성 후속 리뷰는 신규 finding 0건이며 이전 IA2/3/4 해소·IA1 철회를 확인했다. 보조 파일 추정 조회 실패는 실제 파일 검색으로 복구됐고 검사 차단은 아니다.
- findings:
  - `[medium]` `[bad_plan]` B1 TS/Python schema 판정 불일치 — TS input schema 가림 불변 검사가 Python check-manifests.py에 없다. 공유 합성 fixture로 같은 선언의 판정과 설치 거부 계약을 일치시킨다.
  - `[medium]` `[patch]` B2 Infinity의 최종 JSON null 변환 — strict:false는 strictNumbers도 끈다. strictNumbers:true와 비유한 숫자 회귀 시험으로 최종 출력 schema 위반을 거부한다.
  - `[high]` `[bad_plan]` B3 직렬화 뒤 추가 마스킹이 최종 계약 변형 — 값별 mask는 password 키와 별도 문자열 값을 연결하지 않으나 MCP content.text/text codec은 연결된 JSON을 다시 가린다. 최종 출력 가림과 schema 재검증을 공통 경로에서 완결해 모든 표면에서 같은 성공 data 또는 OUTPUT_REDACTED를 반환한다.
  - `[medium]` `[patch]` B4 __proto__ own property 유실 — 기존 maskUnknown의 {} 대입이 setter를 호출한다. JSON arbitrary output에 노출된 own key 손실을 안전한 own property 복사로 고친다.
  - `[medium]` `[patch]` B5 MCP null 입력의 {} 치환 — ?? {}가 명시 null과 누락을 합친다. 누락일 때만 기본값을 넣고 null은 공통 입력 검증에 그대로 전달한다.
  - `[medium]` `[bad_plan]` B6 MCP EOF가 진행 중 명령 취소에 미연결 — dispatch를 기다리는 동안 readline EOF가 활성 자식 취소에 연결되지 않는다. transport 종료에서 기존 취소 정리·reap 경로를 사용하고 실제 PID로 검증한다.
  - `[low]` `[reject]` B7 MCP 입력 프레임 상한 제안 — 큰 입력으로 인한 메모리 고갈을 특정 장애의 재현 없이 추정한다. 원문은 자식 출력 상한을 요구하며 입력 프레임 보안 정책을 요구하지 않고 새 보안 정책 추가를 금지한다. 별도 입력 제한·프로토콜 종료 정책을 도입하는 복잡도에 비해 현 tracer의 입증된 결함이 아니다.
  - `[medium]` `[bad_plan]` B8 실제 DB 질의가 잠금 취소를 막음 — 실제 adapter queryTimeoutMs:0과 질의 전후 signal 확인은 진행 중 응답 중단에 효과가 없다. command 잠금 질의와 해제의 유한 기한·연결 정리를 실 adapter 경계에서 보장한다.
  - `[medium]` `[patch]` B9 깊은 schema 순회의 예외 탈출 — maskOutputValue/hasAsyncSchema가 validator try 밖에서 재귀한다. decoder의 선언 검사 전체를 안정된 EXTENSION_INVALID 경계에 포함하고 깊은 합성 선언을 검증한다.
  - `[low]` `[patch]` B10 help에 수치 제한 누락 — 계획에서 help 기록을 약속했으나 usedFor/output/options는 실행 timeout·stream 상한을 보여주지 않는다. 공통 메타/help 설명에 기존 수치를 기록하는 직접 보정으로 해결한다.
  - `[medium]` `[patch]` E1 MCP null 입력 치환 — B5 동일 원인. 누락과 null을 구분하고 CLI/MCP 거부 동일성을 검증한다.
  - `[high]` `[patch]` E2 Ajv 경고의 원문 stderr 노출 — strict:false unknown format은 기본 console.warn에 원문 format 문자열을 전달한다. 두 validator 모두 logger:false로 진단 sink를 닫고 합성 비밀을 포함한 format의 stderr 미노출을 검증한다.
  - `[medium]` `[bad_plan]` E3 잠금 기한이 실제 DB 질의를 중단하지 못함 — B8과 동일 원인. claim의 queryTimeoutMs:0 호출 경로를 확인했다. 실제 adapter의 유한 질의/해제와 연결 정리 검증을 추가한다.
  - `[medium]` `[bad_plan]` V1 부모 신호 시험의 timeout 대체 가능성 — 사전 검증된 gap을 채택한다. 일반 timeout을 충분히 길게 두고 그보다 짧은 정리 예산에서 신호 취소·PID 소멸을 검증한다.
  - `[medium]` `[bad_plan]` V2 느린 관측 시험의 timeout 회귀 비검출 — 사전 검증된 gap을 채택한다. 수동 시간에서 실행 기한이 초기 관측보다 먼저 만료될 때 관측 완료 없이 정리하는지 검증한다.

### 2026-11-05 — Review pass 1
- verdicts: 20 findings — high 2, medium 17, low 0, false 1, maybe-false 0
- 원문: `.brain-automation/review-{blind-hunter,edge-case-hunter,verification-gap,intent-alignment}.md`. 동일 원인 B1/E1/V4 및 B10/V1은 함께 수정하되 개별 판정은 보존한다.
- findings:
  - `[medium]` `[bad_plan]` B1 MCP null 요청 종료 — Object.hasOwn(null) 예외가 bin catch까지 전파된다. 객체/프로토콜 요청 검증 후 다음 요청을 계속 처리하게 한다.
  - `[medium]` `[bad_plan]` B2 응답 ID 가림으로 상관관계 손상 — send의 전체 maskOutputValue가 문자열 id를 변형한다. ID는 프로토콜 식별자로 원값을 유지한다.
  - `[medium]` `[bad_plan]` B3 입력 schema 가림과 실행 계약 불일치 — MCP send와 guide 엔벨로프가 schema const/enum을 가리지만 실행은 원본을 검증한다. 가림으로 변형되는 입력 계약은 등록 경계에서 거부해 동일성을 유지한다.
  - `[medium]` `[bad_plan]` B4 MCP 객체 입력 계약 불충족 — manifest는 scalar schema도 허용한다. 공통 노출 입력 계약을 MCP와 호환되는 type object로 검증한다.
  - `[medium]` `[bad_plan]` B5 무기한 설치 잠금 대기 — withExtensionInstallLock의 반복은 signal이 없으면 끝나지 않는다. 명령 대기도 제한하고 안정된 timeout/취소 실패로 돌린다.
  - `[medium]` `[bad_plan]` B6 관측 중 timeout 미적용 — spawn 후 bootTime/startedAt 조회 뒤 timeout이 시작된다. spawn부터 관측 시간을 포함해 기한을 적용한다.
  - `[high]` `[bad_plan]` B7 부모 종료 신호의 detached 자식 잔류 — 직접 명령에는 SIGINT/SIGTERM 취소 연결이 없다. 해당 부모 종료 경로에서 정리/reap 후 종료하도록 연결하고 실제 PID로 입증한다.
  - `[medium]` `[bad_plan]` B8 registry 장애를 빈 성공 목록으로 변환 — extensionCommands list 실패와 dynamic catch가 실패를 []로 바꾼다. 미설치와 DB 장애를 구분하며 정적 guide fallback은 유지한다.
  - `[medium]` `[bad_plan]` B9 선종료 리더와 pipe 보유 자손 검증 공백 — 현재 실제 timeout 시험은 리더도 살아 있다. 리더가 먼저 종료하는 정리 경로의 자손 소멸을 검증한다.
  - `[medium]` `[bad_plan]` B10 Python commands 전용 환경 검증 공백 — 기존 Python 시험은 connection_check 때문에 준비하므로 신규 commands-only 분기를 잡지 못한다. 전용 fixture의 설치/실행·준비 실패를 검증한다.
  - `[medium]` `[bad_plan]` E1 MCP null 요청 종료 — B1과 같은 결함. 동일 요청 검증 보완으로 수정한다.
  - `[high]` `[bad_plan]` E2 async schema Promise의 검증 우회 — validateValue가 Promise를 Boolean으로 true 처리한다. 동기 계약에서 async schema를 명시 거부하고 unhandled rejection이 없음을 검증한다.
  - `[medium]` `[bad_plan]` V1 Python-only 환경 준비 실패 검증 공백 — 사전 검증된 gap 근거 채택. commands-only Python prepare 실패가 설치 실패·migration 0회가 되는 시험을 추가한다(B10 동일 원인).
  - `[medium]` `[bad_plan]` V2 stderr 상한 검증 공백 — 사전 검증된 gap 근거 채택. 유효 JSON stdout+과다 stderr는 JSON parse 실패와 구별해 오류·data 없음·원문 미노출을 검증한다.
  - `[medium]` `[bad_plan]` V3 registry 확보 뒤 disable 재확인 검증 공백 — 사전 검증된 gap 근거 채택. 새 registry 필터가 아닌 이미 확보한 메타/SDK 직접 실행에서 unavailable·자식 미시작을 검증한다.
  - `[medium]` `[bad_plan]` V4 MCP null 요청 종료 — B1/E1과 동일; JSON.parse 이후 null 형태 검사가 없다는 호출 경로를 확인했다.
  - `[false]` `[reject]` IA1 MCP 이름 정규화 해석 — 원문이 참조한 아키텍처 AD-37은 -→_ 및 이름의 underscore 금지를 명시한다. ext_testext_echo_stats는 요구와 일치한다.
  - `[medium]` `[bad_plan]` IA2 enum 수락 사례가 const로 대체됨 — 실제 시험은 const만 사용한다. 원문 enum 사례를 CLI/MCP로 직접 추가해 증거를 충족한다.
  - `[medium]` `[bad_plan]` IA3 가려진 성공 결과 CLI/MCP 비교 공백 — hello 비교와 CLI 마스킹만 분리돼 있다. 동일 합성 비밀의 성공 data를 두 표면에서 비교한다.
  - `[medium]` `[bad_plan]` IA4 제거 상태 MCP 관측 공백 — 새 제거 제품 기능은 요구하지 않으나 registry/manifest 부재에서 MCP 목록/호출 소멸의 직접 관측이 없다. 상태 재현 시험을 MCP에도 연결한다.


### 2026-11-05 — Review pass 3
- verdicts: 8 findings — high 0, medium 8, low 0, false 0, maybe-false 0
- edge-case-hunter·intent-alignment은 신규 finding 0건. blind-hunter는 산정 N=10 중 근거 있는 7건만 제출했으며 수량을 맞추기 위한 결함 창작을 요구하지 않는다. 보조 조회 실패는 실제 status.ts 확인으로 복구됐다.
- findings:
  - `[medium]` `[patch]` B1 상속 속성으로 required 충족 — Ajv 기본 required/property 조회가 JSON own field와 prototype field를 구분하지 않는다. 두 adapter에 ownProperties:true를 적용하고 누락/실제 own 값을 구분한다.
  - `[medium]` `[patch]` B2 __proto__ properties 제약 무시 — Ajv allSchemaProperties가 __proto__를 제외한다. own key 보존과 별개로 해당 제약은 검증되지 않는다. 지원 불가 schema 선언은 등록 때 거부하거나 실제 검증하며 properties의 own 키와 일반 데이터 키를 혼동하지 않는다.
  - `[medium]` `[patch]` B3 느슨한 schema의 비유한 숫자 변환 — strictNumbers는 number/integer keyword 검사 위치만 보호한다. object만 선언한 input/output도 1e400이 Infinity→null로 변한다. 실제 JSON 입력/출력 전체에서 비유한 숫자를 거부한다.
  - `[medium]` `[bad_plan]` B4 준비 중 disable 완료 후 자식 시작 — 초기 getExtension 이후 self/settings/secret/databaseUrl await가 있고 disable은 같은 동기화에 참여하지 않는다. 준비 중 활성 변경과 새 자식 시작 순서를 정하고 disable 완료 후 새 시작이 발생하지 않게 한다. 이미 시작한 읽기 명령을 강제 중단하는 새 정책은 추가하지 않는다.
  - `[medium]` `[patch]` B5 Python 깊은 schema 예외 탈출 — Python asynchronous 재귀와 check_schema의 RecursionError가 valid 밖으로 나온다. TS의 안정된 invalid 경계와 맞추고 깊은 선언을 공유 경계 사례로 기록한다.
  - `[medium]` `[patch]` B6 Python 미해결 ref 판정 불일치 — check_schema는 ref 문자열 문법만 검사하지만 Ajv compile은 대상을 해석한다. 미해결 local/external ref의 등록 거부를 공유 fixture와 두 판정 경로에서 일치시킨다. 임의 원격 ref를 새로 fetch하지 않는다.
  - `[medium]` `[patch]` B7 MCP 비유한 숫자 ID 변형 — typeof number만 검사하므로 1e400이 Infinity로 파싱돼 정상 요청처럼 처리되고 응답은 null ID가 된다. 유한 ID 검사 후 Invalid Request와 후속 정상 요청 처리를 검증 코드로 보강한다.
  - `[medium]` `[bad_plan]` V1 느린 관측 시험의 잔여 공백 — review2 V2 수정으로 시험 코드가 변경됐지만 20ms 뒤 250ms씩 총5초를 진행하므로 기존 회귀를 여전히 못 구별한다. 첫 bootTime만 미완료, 후속 정리 관측 즉시 응답으로 구성하고 250ms 이전 20ms 기한에서 완료 상태·리더 reap을 결정적으로 검사한다. 코드 보강만 하고 실행은21.8로 이관한다.


### 2026-11-05 — Review pass 4
- verdicts: 3 findings — high 0, medium 3, low 0, false 0, maybe-false 0
- verification-gap·intent-alignment은 신규 finding0건이며 이전 초기 관측 시험 공백 해소를 확인했다. blind-hunter는 산정N10 중 입증된2건만 보고했고 창작을 요구하지 않는다.
- findings:
  - `[medium]` `[bad_plan]` B1 absolute self-reference/scoped ID가 proto 선언 검사를 우회 — 현재 helper는 # fragment를 top-level에서만 해석한다. Ajv는 root ID와 일치하는 absolute ref·nested ID 대상을 실제 compile하므로 등록 거부 대상 제약이 통과한다. 지원하는 참조 의미와 사전 검사를 일치시키고 실제 참조 대상까지 검사한다.
  - `[medium]` `[bad_plan]` B2 unused defs의 ref 판정 불일치 — Python은 모든 $defs의 missing ref를 해석하지만 Ajv root compile은 사용되지 않은 ref를 해석하지 않는다. 미사용 local/external ref의 공유 판정을 일치시키되 필요 없는 원격 fetch는 추가하지 않는다.
  - `[medium]` `[bad_plan]` E1 dependencies 하위 proto 제약 검사 누락 — Ajv가 실제 schema로 compile하는 legacy dependencies 하위가 helper 목록에 없다. 실제 validator가 처리하는 하위 schema 범위를 포함해 입력/출력 제약 누락을 막고 Python 판정·공유 fixture에도 반영한다.


### 2026-11-05 — Review pass 5
- verdicts: 0 findings — high0, medium0, low0, false0, maybe-false0
- 네 독립 Sol/medium 리뷰 모두 추가 결함·수락 시험 코드 공백0건. 앞선46개 지적 중44개는 보완 후 후속 확인했으며2개는 근거로 기각했다. 리뷰별 원문과 정적 검사 한계를 보존한다. 검사에서 추측한 부재 파일 조회는 실제 경로 조사로 해결됐으며 최종 미해결 검사 차단은 없다.
- 원문: `.brain-automation/review5-blind-hunter.md`, `review5-edge-case-hunter.md`, `review5-verification-gap.md`, `review5-verification-gap-evidence.md`, `review5-intent-alignment.md`.
- 후속 권고 계산: 이번 pass patch high0/medium0/low0, 구체적 미확인 정적 위험 없음 → followup_review_recommended:false. 실행 검증은 사용자 지시에 따른21.8 이관이다.

## Design Notes

E20-1과 최신 AD-37이 최소 MCP 표면을 요구하므로 과거 V1 MCP 유예보다 우선한다. 별도 영속 명령 테이블 없이 설치 상태와 manifest에서 registry를 도출한다. 제거 명령은 현재 없으므로 제거 상태의 등록/manifest 부재를 재현한다. 구체적 오류 코드·timeout/출력 상한 수치는 기존 관례에 맞춰 구현하고 시험·help에 기록한다.

## Verification

- 최신 사용자 지시(2026-11-05, `user-directive:garmin-tests-deferred-to-test-ticket`)가 이전 실행 요구를 대체한다. 현재 round4 직접 시험 실행만 끝낸 뒤 추가 직접 시험·`pnpm test:changed`·전체 시험은 실행하지 않는다. 수락조건 시험 코드는 계속 작성한다.
- `pnpm build` 및 `pnpm typecheck` — 컴파일·타입 성공을 확인한다. 독립 리뷰·필요한 수정/후속 리뷰를 마친 후 built·commit·branch push한다. 알려진 결함은 숨기지 않는다.
- **시험 실행은 21.8로 이관, 미실행.** 지시 이전 이미 실행한 round2/3 및 진행 중 round4 직접 시험의 실제 결과는 이력으로 보존한다. 이후 수정·추가한 시험의 실행 여부를 최종 보고에 구분하고 과거 실행 결과를 최종 코드의 통과 증거로 쓰지 않는다.
- 21.8은 21.6 뒤·21.7 전에 전용 시험 DB/합성 데이터에서 `pnpm test` → `pnpm test:python`을 순차 실행하고 실패별 수정/관련 재검증을 담당한다. 미해결 실패·미실행 시험이 있으면 21.8 built 또는 21.7 시작은 금지다. 이 단계는 중앙 소관이다.

## Auto Run Result

- 상태: built(사용자 인수 전). 기준 `255d34e98cf6a4f6a049c5f2fdc5ae5385603772`. main 병합·push는 중앙 소관이다.
- 구현: manifest 읽기 명령을 활성 설치 상태에서 공통 메타로 도출하고 CLI `brain ext <name> <command>`·MCP `ext_<name>_<command>`·guide schema에 연결했다. 큐 없는 stdin 봉투·self/settings·입출력 schema·최종 코덱 가림/재검증·출력 제한·timeout/취소·그룹 정리/reap과 disable 직렬화를 구현했다.
- 변경 파일: core `extensions/manifest.ts`, `install.ts`, `run.ts`, `status.ts`, 신규 `commands.ts`·`json-values.ts`, `brain.ts`·`index.ts`·`codes.ts`·process port는 선언/실행/수명주기 계약을 담당한다. `output/mask.ts`는 own JSON key를 보존한다. CLI `bin.ts`·`dispatch.ts`·guide/index와 신규 MCP serve/runtime registry/schema adapter는 공통 메타와 실행을 노출한다. ext-login·supervisor·runtime/extensions·process-group은 schema adapter와 stdin/잠금을 연결한다. Postgres `extension-install-lock.ts`는 command 전용 유한 질의/취소 정리를 제공한다.
- 시험 코드: 신규 CLI `extension-commands.test.ts`·PG `extension-command-lock.test.ts`, 기존 core extensions/codes·output-codecs·Python install 및 pyfixture judge·testext echo fixture, 공유 schema/manifests/deep recipe는 수락조건·리뷰 사례를 덮는다. test-changed rules/분류 시험은 신규 비TS 호출 경로를 연결한다. CLI package/lockfile은 Ajv runtime 의존을, README는 오류 코드표를 반영한다.
- 리뷰: 독립4렌즈×5pass를 수행했다. 총46지적을 개별 triage했으며44개 보완(중복 원인 포함),2개 기각: IA1은 AD-37이 이름 변환을 명시하므로 false; pass2 B7은 입증된 현 tracer 결함 없이 새 입력 보안정책을 요구하므로 low/reject. deferred없음. 마지막 pass는4렌즈 모두 추가 발견0건.
- 검증: 최종 구현 round6 `pnpm build`·`pnpm typecheck` 각 종료0. `git diff --check` 통과. **최종 코드의 시험 실행은21.8로 이관, 미실행**이며 정적 리뷰를 실행 통과로 표현하지 않는다. round2~4의 직접/변경 시험 이력은 Implementation Notes와 로컬 보고에 보존하되 최종 코드에 소급하지 않는다.
- 수락조건 확인: 실제 외부 CLI/MCP/guide 동일 schema·가려진 결과·enum 실패·쓰기 선언 거부·수명주기 소멸·PID 정리 시험 코드를 작성했고 독립 리뷰가 누락 없음을 확인했다. 실행 검증은21.8이 수행한다.
- 잔여 위험/운영:21.8에서 전용DB·합성자료로 `pnpm test`→`pnpm test:python` 순차 실행 및 실패별 수정/관련 재검증이 필요하다. 미해결 실패/시험 누락이면21.7 시작 금지. 명령 실행이 확장 잠금을 보유하므로 disable은 기존 실행 종료를 기다릴 수 있다. 제거는 기존 registry/manifest 부재 상태로 검증하며 새 uninstall 기능을 추가하지 않았다. Python 공유 fixture 판정은 배포된 runtime schema adapter를 전달받아 사용한다.
- 후속 독립 리뷰 권고:false(마지막 pass patch0, 알려진 미해결 코드 결함0). 시험 이관은 승인된 별도21.8 과업이며 추가 기능 보류를 숨기지 않는다.
