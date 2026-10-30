# after 정리 — 2026-10-30

지정된 10개 dropped 선행 대기와 초안의 13·17 재배치를 description·verify, 에픽 Requirements·Notes, architecture spine, 현재 packages/apps 코드와 대조했다. 코드 수정·제품 테스트 실행·커밋·main checkout 변경은 하지 않았다. 변경은 티켓 10개, 받는 에픽 10개, initiative 1개(아래 코디네이터 승인 예외), 이 보고서다.

## 바꾼 after

아래 근거의 `T설명/검증`은 해당 받는 티켓 description·verify의 최종 행이며, `E요구`는 에픽 Requirements 시작 행이다. Notes의 2026-10-30 Decision은 같은 판단의 기록이다. 내부 정수는 같은 에픽의 story id다.

| 스토리 | 전 | 후 | 판단 및 근거 파일:행 |
| --- | --- | --- | --- |
| 13.4 | `[3, '12.3']` | `[1, '12.3']` | Node testext 설치·DDL(13.1)과 attempt 함수만 소비. Python 설치는 쓰지 않는다. T설명 `_bmad-output/personal-brain/tickets/epic-extensions/tickets/tickets.toml:44`, T검증 `_bmad-output/personal-brain/tickets/epic-extensions/tickets/tickets.toml:45`, E요구 `_bmad-output/personal-brain/tickets/epic-extensions/epic-extensions.md:32` |
| 13.5 | `[4, '12.9']` | `[3, 4, '12.9']` | 13.4가 Python을 거치지 않으므로 환경 단계 결과·재개를 위해 13.3을 직접 연결. T설명 `_bmad-output/personal-brain/tickets/epic-extensions/tickets/tickets.toml:56`, T검증 `_bmad-output/personal-brain/tickets/epic-extensions/tickets/tickets.toml:57`, E요구 `_bmad-output/personal-brain/tickets/epic-extensions/epic-extensions.md:32` |
| 13.8 | `[7]` | `[3]` | 기본 Python 불요·testext/pyfixture 갱신 보존은 13.3의 설치 기반으로 검증. install 스킬과 무관. T설명 `_bmad-output/personal-brain/tickets/epic-extensions/tickets/tickets.toml:92`, T검증 `_bmad-output/personal-brain/tickets/epic-extensions/tickets/tickets.toml:93`, E요구 `_bmad-output/personal-brain/tickets/epic-extensions/epic-extensions.md:32` |
| 15.1 | `['13.9', '11.6', '12.1']` | `['11.6', '12.1']` | core 발신 요청·Node worker에는 설정과 감독자만 필요. 확장 role은 15.3이 13.4를 소비. T설명 `_bmad-output/personal-brain/tickets/epic-channels/tickets/tickets.toml:8`, T검증 `_bmad-output/personal-brain/tickets/epic-channels/tickets/tickets.toml:9`, E요구 `_bmad-output/personal-brain/tickets/epic-channels/epic-channels.md:37` |
| 14.1 | `['15.6', '11.4', '12.3', '13.3', '13.4']` | `['11.4', '12.3', '13.2', '13.3', '13.4', '15.1']` | manifest·Python·role·FileStore·attempt가 설치/import 기능 선행. 15.1은 verify의 채널 요청 0건 확인을 위한 표 공급자. T설명 `_bmad-output/personal-brain/tickets/epic-garmin-import/tickets/tickets.toml:8`, T검증 `_bmad-output/personal-brain/tickets/epic-garmin-import/tickets/tickets.toml:9`, E요구 `_bmad-output/personal-brain/tickets/epic-garmin-import/epic-garmin-import.md:46` |
| 16.1 | `['14.7', '14.2']` | `['14.1', '14.2']` | 확장 뼈대·raw schema(14.1), catalog·현재 view(14.2)를 사용. sweep·전수 이전 검증과 무관. T설명 `_bmad-output/personal-brain/tickets/epic-garmin-runtime/tickets/tickets.toml:8`, T검증 `_bmad-output/personal-brain/tickets/epic-garmin-runtime/tickets/tickets.toml:9`, E요구 `_bmad-output/personal-brain/tickets/epic-garmin-runtime/epic-garmin-runtime.md:38` |
| 18.1 | `['16.8', '14.5', '12.4']` | `['14.5', '12.4']` | 고정 합성 snapshot·fake 모델이므로 connector 전부와 무관. 실제 digest·그래프 소비자는 18.2·18.5·18.6. T설명 `_bmad-output/personal-brain/tickets/epic-health-analysis/tickets/tickets.toml:8`, T검증 `_bmad-output/personal-brain/tickets/epic-health-analysis/tickets/tickets.toml:9`, E요구 `_bmad-output/personal-brain/tickets/epic-health-analysis/epic-health-analysis.md:39` |
| 17.2 | `[1, '11.5']` | `['11.5']` | 대화 chunker·질의 최소 port는 PG 수집·redact(11.5)로 시작. 리포트 관계와 무관. T설명 `_bmad-output/personal-brain/tickets/epic-search-and-health-query/tickets/tickets.toml:8`, T검증 `_bmad-output/personal-brain/tickets/epic-search-and-health-query/tickets/tickets.toml:9`, E요구 `_bmad-output/personal-brain/tickets/epic-search-and-health-query/epic-search-and-health-query.md:41` |
| 17.1 | `['14.5', '11.4']` | `[3, '14.5', '11.4']` | 대화 검색 기반·공통 결과 budget은 17.2→17.3에서 받고, 문서·파일 관계는 14.5·11.4에서 받는다. T설명 `_bmad-output/personal-brain/tickets/epic-search-and-health-query/tickets/tickets.toml:32`, T검증 `_bmad-output/personal-brain/tickets/epic-search-and-health-query/tickets/tickets.toml:33`, E요구 `_bmad-output/personal-brain/tickets/epic-search-and-health-query/epic-search-and-health-query.md:41` |
| 17.5 | `[4, '13.6', '13.7']` | `[1, 4, '13.6', '13.7']` | 재배치 후 문서 기능이 건강 조회의 선행이 아니므로 전체 회귀가 문서(1)와 건강(4)를 직접 모은다. T설명 `_bmad-output/personal-brain/tickets/epic-search-and-health-query/tickets/tickets.toml:56`, T검증 `_bmad-output/personal-brain/tickets/epic-search-and-health-query/tickets/tickets.toml:57`, E요구 `_bmad-output/personal-brain/tickets/epic-search-and-health-query/epic-search-and-health-query.md:41` |
| 8.1 | `['17.6', '11.6', '10.13', '9.7']` | `['17.1', '11.4', '11.6', '10.3', '9.7']` | 실제 files show(17.1), PG FileStore(11.4), 설정(11.6), 완료된 FileStore 의미 계약(10.3), 데몬 감시(9.7). T설명 `_bmad-output/personal-brain/tickets/epic-drive/tickets/tickets.toml:8`, T검증 `_bmad-output/personal-brain/tickets/epic-drive/tickets/tickets.toml:9`, E요구 `_bmad-output/personal-brain/tickets/epic-drive/epic-drive.md:36` |
| 5.1 | `['8.7', '11.8']` | `['11.8', '10.3']` | 로컬 백업 tracer는 PG 자원·관리 연결(11.8)과 완료된 FileStore 계약(10.3)으로 시작. Drive sweep 불필요. T설명 `_bmad-output/personal-brain/tickets/epic-operations/tickets/tickets.toml:8`, T검증 `_bmad-output/personal-brain/tickets/epic-operations/tickets/tickets.toml:9`, E요구 `_bmad-output/personal-brain/tickets/epic-operations/epic-operations.md:32` |
| 5.2 | `[1]` | `[1, '8.1']` | Drive 이전 뒤 삭제 handler에도 백업 pin을 적용하는 description·verify 때문에 8.1을 직접 연결. T설명 `_bmad-output/personal-brain/tickets/epic-operations/tickets/tickets.toml:20`, T검증 `_bmad-output/personal-brain/tickets/epic-operations/tickets/tickets.toml:21`, E요구 `_bmad-output/personal-brain/tickets/epic-operations/epic-operations.md:32` |
| 5.3 | `[2, '13.9']` | `[2, '13.3', '13.4', '13.6', '8.6']` | Python 재설치·role·registry 공개 상태와 remote_only 검색을 실제 공급자에 연결. garmin schema와 작업 로그는 합성 fixture로 시험. T설명 `_bmad-output/personal-brain/tickets/epic-operations/tickets/tickets.toml:32`, T검증 `_bmad-output/personal-brain/tickets/epic-operations/tickets/tickets.toml:33`, E요구 `_bmad-output/personal-brain/tickets/epic-operations/epic-operations.md:32` |
| 3.2 | `['5.8']` | `['2.3']` | 규율 상수·guide 전문은 기존 완료된 guide 명령(2.3) 위에 구현. 운영 sweep과 무관. T설명 `_bmad-output/personal-brain/tickets/epic-log-and-context/tickets/tickets.toml:21`, T검증 `_bmad-output/personal-brain/tickets/epic-log-and-context/tickets/tickets.toml:22`, E요구 `_bmad-output/personal-brain/tickets/epic-log-and-context/epic-log-and-context.md:26` |
| 3.4 | `[1, 2, '5.8', '11.7', '11.10', '11.11']` | `[1, 2, '11.7', '11.10', '11.11']` | PG hook·runner·전용 조립 및 내부 1·2만 소비. 운영 공유 파일 순서는 기능 의존이 아니다. T설명 `_bmad-output/personal-brain/tickets/epic-log-and-context/tickets/tickets.toml:33`, T검증 `_bmad-output/personal-brain/tickets/epic-log-and-context/tickets/tickets.toml:34`, E요구 `_bmad-output/personal-brain/tickets/epic-log-and-context/epic-log-and-context.md:26` |
| 4.2 | `['3.17', '17.3']` | `['3.4', '17.3']` | 실제 LogStore append·최근 읽기는 3.4가 공급. 기간 읽기 확장은 이 스토리 소유. 17.3의 결과·원문 계약은 유지. T설명 `_bmad-output/personal-brain/tickets/epic-recall-and-mirror/tickets/tickets.toml:9`, T검증 `_bmad-output/personal-brain/tickets/epic-recall-and-mirror/tickets/tickets.toml:10`, E요구 `_bmad-output/personal-brain/tickets/epic-recall-and-mirror/epic-recall-and-mirror.md:33` |

## 초안 채택과 차이

- 13.4·13.5·13.8, 15.1, 16.1, 18.1의 초안 after를 채택했다. 13.4는 Node testext로 role 시험을 하므로 Python 설치를 거칠 필요가 없고, 13.5가 Python 환경 단계를 직접 기다린다. 13.8의 기존 verify는 Python 없는 기본 suite와 선택 pyfixture 갱신 보존을 모두 유지한다.
- **14.1은 초안에 15.1을 더했다.** 초안은 15의 기능을 14.4만 소비한다고 봤지만 14.1 verify가 이미 채널 발신 요청·channel_send 0건을 요구한다. 요청 표가 있는 상태에서 0건을 확인하도록 표 공급자인 15.1은 남기고, legacy·RLS 전체(15.3)는 14.4에서 기다린다. 비발신 검증을 없애거나 표 미존재를 성공으로 보지 않는다.
- 17 재배치 after는 초안을 채택했다. 표 순서를 `2 → 3 → 1 → 4 → 5`로 옮기되 17.4의 after `[3, "14.2"]`를 유지하여 건강 집계가 문서 tracer 완료를 기다리게 만들지 않았다. 17.3 after `[2]`는 원래부터 같아서 위 변경 표에 없다.
- 초안에 없던 Drive·운영·로그·조회는 위 표처럼 실제 기능 공급자로 바꿨다. 특히 5.2→8.1(Drive 삭제 pin)과 5.3→8.6(remote_only 검색)은 늦은 소비자의 요구를 줄이지 않기 위해 명시했다. 5.3의 작업 로그 복구는 기존 PG 표의 합성 행으로 검증하므로 나중 epic 3의 명령 기능을 선행으로 새로 걸지 않았다.

## initiative 예외와 남겨 둔 에픽 전체 gate

최초 지시는 initiative needs를 모두 보존하라는 것이었다. 실제로 3.2·3.4의 5.8을 지우면 `unpinned_after = [{epic: epic-log-and-context, after: epic-operations, needs: 마지막 코드 스토리(5.8) 뒤의 공유 파일…같은 레인의 순서}]` 한 건만 남았다. 기능 요구가 없는 이 레인 선언을 충족할 정당한 entry 기능 의존은 없다.

Orca ask 응답으로 코디네이터가 **initiative의 3→5 needs만 삭제**하도록 승인했다. 이유는 이 needs 자체가 이번에 걷어내는 레인 순서이며 현재 단일 run은 에픽 표 순서 5 → 3을 따른다는 것이다. 새 전체 gate를 만들지 않았고 다른 needs·에픽 표 순서는 그대로다. 같은 이유를 epic 3 Notes에 Decision으로 기록했다.

다음 frontmatter gate는 코디네이터의 별도 확인으로 보존했다. 2026-10-26·27 사용자의 V1 완료 뒤 착수 결정이며, 감독자가 앞 에픽을 닫아(R-2) 푼다. 따라서 이 작업은 entry의 sweep/레인 after를 걷어낸 것이며 모든 에픽 전체 gate까지 없앴다고 주장하지 않는다.

- epic 5: `after: ["epic-attachments", "epic-drive", "epic-postgres-primary"]`
- epic 3: `after: ["epic-capture", "epic-attachments", "epic-drive", "epic-postgres-primary"]`
- epic 4: `after: ["epic-capture", "epic-attachments", "epic-log-and-context", "epic-drive", "epic-search-and-health-query"]`

`unpinned_after` 구현은 entry after와 frontmatter에서 생기는 gated_by를 함께 보므로, 빈 결과는 모든 needs에 직접 교차 entry가 있다는 뜻은 아니다. 기존 epic 3→8 등 전체 대기 선언은 보존된 gate가 덮는다. 근거: `_bmad/method/scripts/tickets.py:674`의 `unpinned_after`와 `:688`의 교차 의존 검사.

## 코드·spine 대조

- spine AD-29·30(454·466행): 확장은 connector이고 별도 role·schema로 계약 표에 INSERT한다. core 채널 tracer와 확장 RLS 소비 시점을 분리해도 계약은 유지된다.
- spine AD-31(478행), `packages/postgres/src/migrate.ts:50`: owner별 버전·checksum을 단일 실행기가 관리한다. 앞 에픽 sweep이나 마지막 번호를 고정 전제로 삼지 않고 착수 시점 main HEAD에서 다음 번호·시그니처를 확인한다.
- spine AD-33(499행): 감독자·attempt fencing은 실제 import·connector·모델 작업의 기능 선행으로 유지한다.
- spine AD-35(530~535행): analyses 최소형은 14, digest·그래프는 connector, 모델 검증·분석 보존은 core다. 합성 snapshot tracer와 실제 digest·그래프 소비를 분리해도 경계는 같다.
- `packages/core/src/ports/file-store.ts:1`의 로컬 전용 PutFileResult와 port, `apps/cli/src/assembly.ts:88`의 로컬 조립을 읽었다. Drive adapter는 8.1이 만들고 files show는 17.1이 공급하므로 sweep 대신 두 기능을 정확히 연결한다.
- `packages/core/src/guide.ts:16`, `apps/cli/src/commands/guide-show.ts:16`: 기존 guide의 기록 규율 절은 epic 3 책임이라고 이미 명시돼 있다. 운영 sweep은 규율 상수 구현에 필요하지 않다.
- `packages/postgres/migrations/0001_initial.sql:251`의 index_configs·chunk_params와 pg_trgm(4행)을 읽었다. 대화 조각 기반은 기존 PG 메시지·색인·redact 경로를 쓰고 Garmin 리포트 관계 없이 구현 가능하다.

## description·verify 변경

17.2가 공통 질의 함수·최소 검색 port·PG adapter와 합성 대화·도구 fixture·격리 PG/홈·정리 도구를 맡는다. 17.1은 그 기반과 17.3의 budget을 받아 문서 검색·files show·문서 probe·리포트 fixture를 추가한다. 17.3은 질의 함수 공급자를 1에서 2로 바꾸고 docs budget 적용을 후속 1의 책임으로 명확히 했다. tracer 제목도 17.2로 옮겼다. 17.1의 리포트 원문·가리기·범위 제한 verify와 17.2의 기존 chunk 경계·redact·재생성 요구는 모두 유지했다.

아래는 변경된 description의 **전체 최종 본문**이다. 단순 HEAD 문구 변경도 빠짐없이 싣는다.

### 13.1

`_bmad-output/personal-brain/tickets/epic-extensions/tickets/tickets.toml:8`

가장 얇은 길로 층을 잇는다. 최소 manifest 코덱(이름·버전·호환 core 버전·ABI 버전·연결 확인 명령·마이그레이션 위치만), `extensions/<name>/`의 패키지를 `<home>/extensions/<name>/`에 두는 설치, core 실행기에 소유자 `<name>`의 확장 마이그레이션을 넘기는 연결(번호는 core와 따로), core의 다음 번호 마이그레이션으로 만드는 registry 표(설치·활성·연결 확인을 다른 사실로)와 Store port·fake·계약, `brain ext install|list|status`(CommandSpec·명령 메타·SDK 1:1). 연결 확인은 12.1의 감독자가 testext의 명령을 자식 프로세스로 돌리고 ABI v1 결과를 registry에 남긴다. 시험 fixture `testext`(Node, 12.1의 `process_probe` 바탕)는 사용자용 옵션이 아니라 시험용 패키지 resolver로만 설치한다. resolver는 기본 홈이 아닌 Brain 홈(epic 11의 자원 이름 파생으로 운영과 격리된 홈)에서만 환경 변수로 켜지고, 새 CLI·데몬·에이전트 세션 프로세스도 같은 홈과 환경 변수로 그것을 쓴다(10이 받는다). 1은 뒤 스토리가 다시 쓰는 시험 기반도 만든다: 격리된 PG와 Brain 홈, testext 설치 fixture, 정리 도구. epic 12에서 받는 것: 12.1의 감독자·`process_probe`·실행 분류 등록부, 12.4의 ABI v1 schema. epic 11에서 받는 것: 11.10이 고정한 소유자별 마이그레이션 실행기와 PG 조립. 실제 경로와 시그니처는 착수 시점 main HEAD에서 확인한다. manifest 전체·snapshot은 2, Python은 3, role 권한은 4, 단계 보고·재개는 5, 켜기/끄기와 공개 상태 view는 6, 스킬은 7이다. plan은 testext 하나, 연결 확인 명령 하나, 확장 DDL 0001 하나, 정상 ABI 결과 한 건에 필요한 것만 적는다. 착수 시점 main HEAD를 읽고도 한 세션을 넘으면 비필수 완성(목록·메타 다듬기 등)을 이름 붙인 다음 스토리로 나누고, 설치 → DDL → registry → 실제 자식 → status 경로는 1에 남긴다.

### 15.1

`_bmad-output/personal-brain/tickets/epic-channels/tickets/tickets.toml:8`

가장 얇은 길로 층을 잇는다. 새 core 마이그레이션(착수 시점 main HEAD의 다음 번호)으로 channel·conversation·발신 요청(의미 키 UNIQUE, NULL 안전 정규형)·인계 표식·gate·attempt 결과 표의 최소 칸을 두고, 채널 Store port·fake·계약 suite를 만든다. core 인계 use case가 미인계 요청을 찾아 일감 생성과 인계 표식을 한 트랜잭션에 확정한다. `channel_send`는 실행 분류 `supervised`이고 core가 내보내는 Node worker가 ABI v1로 돈다(12.1의 감독자). worker는 gate를 짧은 트랜잭션에서 저장한 뒤 트랜잭션 밖에서 Telegram adapter(sendMessage만)를 부르고 결과를 현재 attempt token으로 확정한다. 비밀은 11.6 뒤의 설정 코덱이 `.env`의 `BRAIN_TELEGRAM_BOT_TOKEN`·`BRAIN_TELEGRAM_CHAT_ID`에서 읽고, 나가는 텍스트는 새 출력 코덱 항목으로 가린다. 시험 기반도 1이 만들고 2~5가 다시 쓴다: 격리된 PG와 Brain 홈, 로컬 가짜 Telegram 서버(응답·지연·끊김·429를 제어), 테스트 생산자, 정리 도구. 각 plan은 실행 명령, 사전 조건, 관찰값, 정리 명령을 적고, 기본 suite와 따로 부르는 행동 평가(5의 스킬)를 나눈다. 받는 것: 11.6의 설정 코덱, 12.1의 감독자·실행 분류·ABI v1. 실제 시그니처는 착수 시점 main HEAD에서 확인한다. 새 발신의 identity·provenance는 1이 끝낸다: 비밀 아닌 봇 참조, 외부 대화 참조, 선택 thread, 생산자 출처, 응답에 있으면 외부 message id. 불명·재시도는 2, legacy·같은 conversation 연결·RLS는 3, 묶음은 4, 명령·스킬은 5다. plan은 요청 하나, 일반 conversation 하나, sendMessage 하나, 정상 ABI 결과 하나에 필요한 것만 적는다. 착수 시점 main HEAD를 읽고도 한 세션을 넘으면 비필수 완성을 이름 붙인 다음 스토리로 나누고, PG → 감독자 → Node worker → HTTP → token 결과 확정과 가리기는 1에 남긴다. 추가 확인: 같은 의미 키 요청 둘을 동시에 넣어도 gate 승자가 하나이고, HTTP 호출 동안 DB 트랜잭션을 잡지 않는다.

### 14.1

`_bmad-output/personal-brain/tickets/epic-garmin-import/tickets/tickets.toml:8`

가장 얇은 길로 층을 잇는다. `extensions/garmin/`에 `pyproject.toml`(Python pin 3.14.10, 의존은 `psycopg[binary]` 3뿐)·`uv.lock`·`.python-version`·manifest v1(`import` 일감 `supervised`, 연결 확인, garmin DDL 위치, raw view. 인증·수집 예약은 비움)을 두고, epic 13의 `brain ext install garmin`으로 격리된 Brain 홈에 frozen 설치한다. garmin 마이그레이션 0001(소유자 `garmin`)은 raw 보존 표(받은 그대로의 TEXT, scope·library_version·fetched/checked)와 importer 최소 상태(dataset, batch, mapping)를 두고, `garmin.raw_records` view(`key` = `<scope>/<원래 key>`)를 낸다. 새 core 마이그레이션(착수 시점 main HEAD의 다음 번호)은 세 계약 표의 최소 칸을 둔다: 건강 측정(일 값 한 지표, 논리 키·보관 키 최소형, "현재" view 최소형), `analyses`(legacy 키·dataset·batch·nullable 모델/시각과 누락 flag·파일 요청 관계), `file_requests`(출처+요청 키 UNIQUE, 예상 해시·크기·미디어 타입)와 core 인계(미인계 요청 → 일감 생성·인계 표식을 한 트랜잭션에, FileStore 넣기, 결과 view `request_id → file_id`). 세 표 모두 `brain_ext_garmin`용 RLS(자기 출처 INSERT만, UPDATE·DELETE 없음)와 12.3의 attempt 확인 trigger를 붙인다. importer(Python, 표준 `sqlite3` read-only URI)는 감독자가 ABI v1로 띄우고, 합성 schema 15 snapshot의 raw 한 건과 legacy Markdown 한 건을 넣는다. 처리된 파일은 기존 문서 추출 일감에 들어간다. 시험 기반도 1이 만들고 2~8이 다시 쓴다: 합성 snapshot 생성기(schema 10·15), 합성 legacy 문서, 격리된 PG와 Brain 홈, 정리 도구. 각 plan은 실행 명령, 사전 조건, 관찰값, 정리 명령을 적는다. 받는 것: 11.4의 PG FileStore·추출 세대, 12.1의 감독자·ABI v1, 12.3의 attempt 확인 함수, 13.2의 manifest v1, 13.3의 Python frozen 설치, 13.4의 확장 role, 15.1의 채널 요청 표(비발신 0건 확인). 실제 시그니처는 착수 시점 main HEAD에서 확인한다. plan 상한은 schema 15 raw 한 건, 일 지표 하나, Markdown 하나, 정상 파일 인계 하나다(전체 catalog·현재 선택은 2, schema별 전수 reader와 수동 CLI는 3, 전체 보존 mapping·재개는 4, 파일 실패 행렬·전수 분석은 5). 그래도 한 세션을 넘으면 비필수 완성(설치 상태 표시 다듬기 등)을 이름 붙인 다음 스토리로 나누고, Python 확장 → PG garmin schema → core 계약 표(RLS·attempt) → core 인계 → FileStore → core 읽기와 원문 보존·비발신은 1에 남긴다. 추가 확인: macOS arm64에서 frozen 설치한 driver가 import되고, PG에 접속해 UTF-8·epoch ms·NULL을 왕복한다.

### 16.1

`_bmad-output/personal-brain/tickets/epic-garmin-runtime/tickets/tickets.toml:8`

가장 얇은 길로 connector 층을 잇는다. manifest에 `collect` 일감(`supervised`)을 선언하고, worker가 ABI v1 입력(계정·target·시간 범위·attempt token)과 설정 snapshot을 받아 진행·결과 이벤트를 낸다. 외부 라이브러리 경계(`garmin` 패키지의 client)를 port로 감싸고 시험에서는 fake client를 쓴다. 합성 endpoint 응답 한 건(날짜 endpoint 하나)이 coverage 판단 → raw 저장(garmin 보존 표, 새 수집 dataset, 원문 문자열 그대로) → 정규화 v8의 순수 계산 → 14.2의 보관 키로 건강 행 INSERT → "현재" view까지 간다. raw와 그 항목의 건강 행은 같은 짧은 트랜잭션이고, 현재 attempt 확인을 같은 트랜잭션에 둔다. PG store port(garmin schema reader·writer)의 최소형과 그 시험 기반(fake client, 합성 응답 생성기, 격리된 PG와 Brain 홈, 정리 도구)을 1이 만들고 2~9가 다시 쓴다. 각 plan은 실행 명령, 사전 조건, 관찰값, 정리 명령을 적는다. 받는 것: 14.1의 확장 뼈대·garmin schema·raw view key 정규형, 14.2의 지표 catalog·보관 키·"현재" view, 12.1·12.3의 감독자·ABI v1·attempt 확인, 13.2의 manifest·설정 snapshot. 실제 시그니처는 착수 시점 main HEAD에서 확인한다. plan 상한은 endpoint 하나, 지표 하나, 정상 경로 하나다. 넘치면 비필수 완성을 이름 붙인 다음 스토리로 나누고, worker → store port → 건강 행 → 현재 view와 멱등·오래된 쓰기 거부는 1에 남긴다.

### 18.1

`_bmad-output/personal-brain/tickets/epic-health-analysis/tickets/tickets.toml:8`

가장 얇은 길로 분석 층을 잇는다. Core 분석 use case(입력 snapshot 읽기 → 모델 실행 port → 출력 schema 검증 → 확정)와 Core 모델 실행 port를 만들고, Runtime이 Codex adapter의 최소형을 조립한다. 시험은 Codex 모양의 fake 모델 CLI(argv·env를 기록하고 schema에 맞는 출력과 `--json` 이벤트를 내는 실행 파일)를 쓴다. 모델 일감은 `supervised` core 일감이고 감독자가 프로세스 그룹으로 띄운다. 고정 합성 snapshot(day 하나)의 export는 출력 코덱을 거친다. 옛 daily skill·daily 출력 schema를 v1 리소스로 넣는다. `analyses` 호환 확장 마이그레이션의 최소 칸(묶음 id·현지 날짜·scope·snapshot id·revision·agent·출력 JSON)과 리포트 Markdown의 core FileStore 등록·파일 관계 행을 둔다. 설정 `analysis.agent`(기본 `codex`)를 설정 코덱이 읽는다. 시험 기반도 1이 만들고 2~9가 다시 쓴다: fake 모델 CLI(두 adapter 모양으로 넓힐 자리), 합성 snapshot 생성기, 격리된 PG와 Brain 홈, 정리 도구. 각 plan은 실행 명령, 사전 조건, 관찰값, 정리 명령을 적는다. 받는 것: 14.1·14.5의 `analyses` 최소형과 파일 관계, 12.1·12.4의 감독자·ABI v1(`usage`), 11.4의 FileStore·추출. 실제 시그니처는 착수 시점 main HEAD에서 확인한다. plan 상한은 scope 하나, 정상 경로 하나다.

### 17.2

`_bmad-output/personal-brain/tickets/epic-search-and-health-query/tickets/tickets.toml:8`

대화 쪽 tracer로 검색 기반과 E17-1을 만든다. Core 텍스트 질의 함수 하나(`lower(col) LIKE lower(pattern)`, `%`·`_`·역슬래시 이스케이프)와 검색 Store port·PG adapter의 최소형을 대화 조각 대상으로 만든다. 뒤의 3이 검색 명령·결과 budget을 완성하고 1이 문서 대상을 더한다. 시험 기반(합성 대화·도구 메모 fixture, 격리된 PG와 Brain 홈, 정리 도구)도 2가 만들고 3·1·4~7이 다시 쓴다. 각 plan은 실행 명령, 사전 조건, 관찰값, 정리 명령을 적는다. Core 순수 chunker(목표 1,200자, 메시지 경계, 겹침 1메시지, 2,400자 넘는 메시지 분할, 머리말 없음, `index_configs` 값이 진실)와 drain 일감을 만든다. 같은 `occurred_at` 묶음은 경계에서 쪼개지 않고, 긴 메시지의 분할 조각은 `part`(1..n, 나누지 않은 조각은 0)로 구별한다(필요한 다음 core 마이그레이션으로 `chunks` 키에 `part`를 더한다). 수집은 세션·설정의 열린 조각 일감을 멱등하게 만들고, 재청구는 같은 원문에서 같은 경계를 만든다. 읽은 snapshot 뒤 새 메시지나 redact가 끼면 낡은 조각을 확정하지 않는다(세션 입력 fingerprint 비교). `messages.redact`(11.5의 PG 경로)는 같은 트랜잭션에서 걸린 조각을 지우고 그 세션의 재생성 일감을 넣는다. U+0000이 든 본문은 AD-11의 쓰기 코덱으로 조각에 들어간다. 전체 `index rebuild` 명령은 epic 4다.

### 17.3

`_bmad-output/personal-brain/tickets/epic-search-and-health-query/tickets/tickets.toml:20`

E17-2·E17-3의 대화 쪽과 공통 결과 계약을 끝낸다. `brain recall chunks`·`brain recall tools`가 2의 질의 함수로 조각·도구 메모를 찾고, 결과는 `conversation` 출처(session 토큰·harness·날짜·꼬리표·`from_at`·`to_at`·`chunk_id`)를 붙인다. 근접 단계(같은 워크트리 → 프로젝트 → 전체) 다음 관련도로 정렬한다. 공통 결과 budget: 기본 5건, 출력 코덱으로 가린 뒤 총 8,000자, 낮은 순위부터 통째로 빼고 1위는 남김, 1위 안을 자르는 것은 최후, `RESULT_TRUNCATED`·`meta.omitted`·`meta.next`, limit+1 `has_more`, 0건은 `data: []`와 `meta.hint`, 질의 오류·DB 잠금 초과는 `SEARCH_FAILED`. `brain recall expand`는 출처의 session·시각 구간으로 앞뒤 N개 메시지를 `(occurred_at, 안정 id)` 순으로 읽고 겹침을 지운다. `brain sessions read`는 세션 원문·도구 메모를 쪽 단위로 읽는다. 도구 메모 target은 전용 가리기를 먼저 거친다. 뒤의 1이 만드는 `recall docs`도 같은 budget을 쓴다.

### 17.1

`_bmad-output/personal-brain/tickets/epic-search-and-health-query/tickets/tickets.toml:32`

17.2의 텍스트 질의 함수와 검색 Store port·PG adapter, 17.3의 공통 결과 budget·원문 출처 계약 위에 리포트 검색 층을 잇는다. 문서 대상을 `analyses`와 파일 관계가 있는 core 파일의 현재 추출 세대로 좁힌다(14.5의 관계를 받는다). `document` 결과 종류(file_id·표시 이름·`chunk_locator`·분석 id·날짜·원문 접근 상태)와 `brain recall docs`, 문서 출처로 원문을 읽는 `brain files show`(현재 세대의 위치와 앞뒤)를 CommandSpec·명령 메타·SDK 1:1로 만든다. 출력 코덱 계약의 `OutputProbe`에 문서 조각·표시 이름·locator를 더하고 실제 renderer를 통과시킨다. 2가 만든 시험 기반에 합성 리포트 fixture를 더하고 뒤 스토리가 다시 쓴다. 각 plan은 실행 명령, 사전 조건, 관찰값, 정리 명령을 적는다. 받는 것: 11의 PG 전문 색인(`document_chunks.body`의 expression GIN)·추출 세대, 14.5의 `analyses` 파일 관계. 실제 이름은 착수 시점 main HEAD에서 확인한다. plan 상한은 리포트 한 파일, 질의 하나, 원문 경로 하나다.

### 8.1

`_bmad-output/personal-brain/tickets/epic-drive/tickets/tickets.toml:8`

가장 얇은 길로 원본 이전 층을 잇는다. FileStore 계약을 backend 중립 의미 계약(왕복·같은 내용 같은 위치·URL 안정·없는 파일·삭제 멱등·루트 밖과 external 거부)과 로컬 전용 시험으로 나누고, `put`의 반환 위치 타입을 일반화한다. Drive FileStore adapter(Brain 루트 폴더 안에서만 쓰고 지움, locator는 `<hex><확장자>`)와 `(루트, content_hash) → remote id` 매핑·업로드 상태 표(다음 core 마이그레이션)를 둔다. adapter의 모든 연산은 이 매핑 하나로 remote id를 찾고(이름 검색 금지), 매핑 저장 함수는 이전 일감과 put이 공유한다. 이전 use case: 업로드 → 검증(`sha256Checksum` → `md5Checksum` → 되읽기) → 한 트랜잭션에서 원격 위치 등록·`verified_at`·`home` 전환·로컬 삭제 일감 예약(due = 검증 시각 + `drive.keep_local_days`, 예상 이전 home과 가리지 않음을 CAS로 확인). 삭제 handler는 지우기 직전 원격 사본을 다시 확인한다. 가짜 Drive 서버(주입 가능한 base URL과 Clock: 업로드·조회·내려받기·삭제)와 격리된 PG·Brain 홈을 1이 만들고 2~8이 다시 쓴다. 각 plan은 실행 명령, 사전 조건, 관찰값, 정리 명령을 적는다. 설정 키 `drive.keep_local_days`(기본 30, 0 허용, 음수·정수 아님 거부)의 등록·검증·DB 읽기 최소형은 1이 만든다(나머지 `drive.*`는 3). 받는 것: 11.4의 PG FileStore·첨부·추출 Store, 11.6의 설정 port, 17.1의 `files show`. 실제 시그니처는 착수 시점 main HEAD에서 확인한다. plan 상한은 작은 txt 하나, 단순 업로드, 보관 0일과 30일 두 경우다.

### 5.1

`_bmad-output/personal-brain/tickets/epic-operations/tickets/tickets.toml:8`

가장 얇은 길로 백업·복구를 잇는다. `brain backup create`: compose 서비스 안의 `pg_dump -Fc`(Brain DB 전체)와 `pg_dumpall --globals-only --no-role-passwords`를 private 임시 파일로 받고, Brain 소유 로컬 블롭을 정규 locator로 복사하며, `.env`·`config.toml`을 넣고, manifest(형식 버전, backup id, 앱 commit, PG 버전, owner별 schema 버전, 테이블별 건수·정규형 sha256, 구성 파일 sha256·크기, 파일 범위, 비밀 포함 여부, `SECRET_PATTERN_VERSION`)를 쓴 뒤 검증하고 `<home>/backups/<backup-id>/`로 rename 발행한다. `brain backup restore <id> --target <새 홈>`: 운영 홈이면 거부하고, 새 compose project·volume·port에 role → `.env` 비밀번호 → archive의 pre-data·data·post-data 순으로 복원하며 블롭을 새 `[files] path`에 놓고 해시를 검증한다. `brain backup list|verify`도 최소형을 둔다. 시험 기반도 1이 만들고 2~9가 다시 쓴다: 격리 홈·DB·compose project 두 벌(원본·복구 대상), 합성 fixture, 정리 도구. 각 plan은 실행 명령, 사전 조건, 관찰값, 정리 명령을 적는다. 받는 것: 11.8의 compose 자원 이름 파생·관리 접속, 11의 마이그레이션 버전 표. 실제 이름은 착수 시점 main HEAD에서 확인한다. plan 상한은 메시지 하나, 블롭 하나, 확장 없음이다.

### 3.4

`_bmad-output/personal-brain/tickets/epic-log-and-context/tickets/tickets.toml:33`

가장 얇은 길로 모든 층을 잇는다. LogStore(append·최근 읽기)를 PG adapter·fake·계약 테스트와 함께 두고(epic 11의 Store 조립 방식), `brain log append`(진행 한 종류, 세션 토큰, 본문 인자)와 `brain context show`(고정 머리말의 오늘 날짜·요일·시간대·이 세션의 토큰 줄 + 최근 로그, hook 출력 코덱으로 가림)를 만든다. context show는 PG 로컬 읽기만 하고(epic 11.7의 접속·쿼리 시간 상한, 여러 SELECT는 READ ONLY 트랜잭션) 쓰기 트랜잭션·마이그레이션·세션 생성·drain을 부르지 않는다. 명령 메타의 `hook`을 `only`까지 표현하게 하고(AD-28; `guide schema`·검증·drain 제외 포함), `plugin/hooks/hooks.json`에 기존 비동기 bootstrap·수집 줄과 별도인 SessionStart 동기 `context show` 줄(같은 런처, `|| exit 0`)을 더하며, CLI가 harness 등록부를 Core 조립에 주입한다(I155). 시험 기반도 4가 만들고 뒤 스토리가 다시 쓴다: 격리 PG·Brain 홈, 개발용 hook harness, 정리 도구. 각 plan은 실행 명령, 사전 조건, 관찰값, 정리 명령을 적는다. 받는 것: 11.7의 hook 경로·DB 불가 처리, 11.10의 PG 계약 runner와 격리 홈, 11.11 뒤의 PG 전용 조립. 실제 시그니처는 착수 시점 main HEAD에서 확인한다. plan 상한은 진행 로그 하나, 세션 둘이다.

### 4.2

`_bmad-output/personal-brain/tickets/epic-recall-and-mirror/tickets/tickets.toml:9`

가장 얇은 길로 조회 층을 잇는다(E4-2). Core 날짜 구간 함수(날짜 + DB `timezone` → 반열린 UTC, epic 17·3이 이미 만든 공용 함수가 있으면 그것을 쓰고 없는 능력만 더함)와 기간 읽기 Store 능력(PG·fake·계약)을 두고, `brain recall time --from --to`가 작업 로그와 세션을 프로젝트 무관 시간순으로 낸다. 로그 없는 세션은 가장 이른 user 메시지의 첫 요청 문장을 읽을 때 꺼내고 저장하지 않는다(D7, 같은 시각이면 안정 id 순이되 선후를 주장하지 않음). 출처는 epic 17의 `recall expand`·`sessions read` 입력 모양이다. `brain sessions list`(기간·꼬리표·쪽 나눔)도 만든다. 명령은 CommandSpec·명령 메타·SDK 1:1, 출력 코덱 통과. 시간 조회는 시간순을 유지한 채 epic 17의 공통 결과 budget(가린 뒤 8,000자, 뒤쪽 시간부터 빠짐, `meta.next`, limit+1, 0건·`SEARCH_FAILED`)을 쓰고, `recall.*` 선수집(spine AD-6)을 앞 에픽의 연결로 time·logs에 적용한다. 시험 기반(격리 PG·Brain 홈, 합성 fixture, 정리 도구)을 2가 만들고 3~10이 다시 쓴다. 각 plan은 실행 명령, 사전 조건, 관찰값, 정리 명령을 적는다. 받는 것: epic 17의 결과 계약·원문 읽기, epic 3의 작업 로그 Store. 실제 시그니처는 착수 시점 main HEAD에서 확인한다. plan 상한은 프로젝트 둘, 세션 셋, 날짜 하나다.

## 점검 출력

제품 테스트는 실행하지 않았다. 아래는 보드 상태·TOML 구조·git diff의 문서 점검이다. 기본 uv cache는 sandbox 쓰기 제한으로 실패하여 임시 cache 경로를 환경 변수로 지정했다(그 외 명령·의미 동일).

```sh
UV_CACHE_DIR=/tmp/after-cleanup-uv uv run --no-project python _bmad/method/scripts/tickets.py status
```

전체 JSON 중 진단 필드의 투영:

```json
{
  "unpinned_after": [],
  "undeclared_after": [],
  "order_conflict": [],
  "problems": []
}
```

`problems`는 정상 status 응답에 키 자체가 없으므로 `get("problems", [])`로 빈 배열로 투영했다. 나머지 세 키는 원래 빈 배열이다.

dropped 대기 확인에 사용한 코드(status JSON을 stdin으로 받음):

```python
import json, sys
d = json.load(sys.stdin)
rows = {t["ref"]: t for t in d["tickets"]}
bad = []
for t in d["tickets"]:
    if t["state"] == "dropped":
        continue
    for a in t["after"]:
        ref = a if isinstance(a, str) else t["ref"].split(".")[0] + "." + str(a)
        if ref in rows and rows[ref]["state"] == "dropped":
            bad.append([t["ref"], ref])
print("remaining_dropped_dependencies:", bad)
assert not bad
```

```text
remaining_dropped_dependencies: []
non_dropped_stories_checked: 169
changed_verify_entries: ['17.2']
epic_requirements_unchanged: True
git diff --check: exit 0
```

verify 변경은 17.2 한 곳뿐이며 질의 port의 한국어 두 글자·특수문자 전수 LIKE 판정을 추가했다. 다른 verify와 에픽 Requirements는 HEAD와 문자열 대조해 동일했다. 17.2는 기존 verify에 위 검증을 더했으며 나머지 기존 요구를 삭제하지 않았다.
