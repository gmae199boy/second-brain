# Epic 15 코드 조사 — 공통 채널과 Telegram 발신

조사일 2026-10-28, 브랜치 `plan/epics-12-on`. 정적 조사만 했다. 테스트·빌드·Docker·네트워크·설치·Garmin 실행·커밋은 하지 않았다. 아래 시험 설명은 소스를 읽은 결과이며 실행 통과 증거가 아니다. 작성 범위는 이 보고서 하나다.

인용 약칭은 다음 파일을 뜻한다. `약칭:행`도 파일·행 인용이다.

- **에픽**: `_bmad-output/personal-brain/tickets/epic-channels/epic-channels.md`
- **이니셔티브**: `_bmad-output/personal-brain/initiative-personal-brain.md`
- **spine**: `_bmad-output/personal-brain/architecture-brain-v1-slice-1/architecture-brain-v1-slice-1.md`
- **전체 계획**: `_bmad-output/personal-brain/tickets/tickets.toml`
- **PG 계획**: `_bmad-output/personal-brain/tickets/epic-postgres-primary/tickets/tickets.toml`
- **작업 계획**: `_bmad-output/personal-brain/tickets/epic-jobs-and-scheduler/tickets/tickets.toml`
- **확장 계획**: `_bmad-output/personal-brain/tickets/epic-extensions/tickets/tickets.toml`
- **경계**: `_bmad-output/personal-brain/prep-garmin-absorption/integration-boundaries.md`
- **이전 계약**: `_bmad-output/personal-brain/prep-garmin-absorption/migration-contract.md`
- **Garmin/**: `_bmad-output/personal-brain/prep-garmin-absorption/inputs/garmin-source.tar.gz` 안의 `garmin-source/`. 저장소 밖 새 빈 임시 디렉터리에 풀어 읽었다. 이하 archive 내부 상대 경로를 인용하며 임시 디렉터리 위치는 제품 경로가 아니다.

## 0. 이미 결정된 범위와 선행 계약

core가 채널·대화·스레드 identity, provenance, 요청·이력 표와 Telegram adapter를 소유한다. Garmin ports·telegram은 의미를 옮길 참고 자료이며 그대로 실행할 새 확장이 아니다(에픽:15, :16, :19; 경계:9, :18, :22, :32). R13은 향후 답장·스레드·선제 메시지를 같은 대화로 연결할 경계를 요구하지만 양방향 출시·수신은 이번 범위 밖이다(이니셔티브:39, :70; 에픽:38).

불명 발신도 지수 간격으로 다시 보내고 10번 실패하면 failures·doctor·resend로 잇는다. 중복 전송 가능성을 받아들인 결정이며 새 생산 요청의 의미 키 UNIQUE와 최초 시도 gate는 유지한다. resend 스킬은 기존 실패 발신을 재개하는 용도다(에픽:54, :55; 이니셔티브:164). **어긋남:** spine AD-35는 아직 불명 결과를 무조건 재전송하지 않고 Deferred에서 결정한다고 적지만 에픽 Notes가 이를 대신했다. Deferred를 미결 질문으로 되살리지 않는다(spine:533, :786; 에픽:54).

옛 봇·채팅을 재사용한다. 처음의 사람이 `.env`에 넣는다는 문구는 이 Mac에 이미 있으면 에이전트가 이전·실계정 확인한다는 뒤 위임과 함께 읽어야 한다. 이번 조사는 비밀 이전이나 실발신을 하지 않는다(에픽:56, :59; 이니셔티브:188, :189, :191, :192). legacy 이력은 core에 보존하고 발신하지 않는다. 15가 표를 만들고 14가 넣는다(에픽:17, :21, :58; 이니셔티브:174, :176; spine:580).

11·12·13은 아직 구현 전인 계획이다. 현재 PG factory는 HealthStore·SchemaStore뿐이므로 계획을 현재 구현으로 쓰면 안 된다(`packages/postgres/src/store.ts:44`, :49). 11.3의 PG WorkStore, 11.6 설정, 11.10 PG 조립·baseline 고정, 11.11 SQLite 삭제 뒤를 인계 기준으로 삼는다(PG 계획:43, :79, :127, :139). 12.1 실행 분류·attempt, 12.3 DB 확인 함수, 13.4 role·출처 결합이 채널 RLS 기반이다(작업 계획:8, :32; 확장 계획:44). 에픽 전체 gate를 다시 만들지 말고 스토리 entry 교차 의존으로 고정할 재료다(전체 계획:61; 이니셔티브:187).

## 1. 옛 Garmin 채널의 실제 모양

| 자산 | 관찰한 계약과 근거 |
|---|---|
| Notifier | `notify(local_date,event,detail) -> bool 또는 None`. 현지 날짜·사건마다 최초 detail을 남기며 재호출은 아무 일도 안 한다. `TableNotifier`는 INSERT OR IGNORE 결과 rowcount=1 여부를 반환한다(`Garmin/src/garmin_pipeline/ports.py:27`, :34, :50). |
| notification | `local_date TEXT NOT NULL`, 7종 CHECK인 `event`, `detail TEXT NOT NULL DEFAULT ''`, `at INTEGER NOT NULL`(UTC epoch ms), UNIQUE(local_date,event). 명시적 id PK는 없다(`Garmin/src/garmin_pipeline/store/migrations/0005_notification.sql:1`, :5, :16, :18). |
| ReportBundle / ReportSink | frozen bundle은 report_date·summary_text·albums(tuple of tuple of Path)·document_path·regenerated. `deliver(bundle) -> None`, report가 파일을 쓴 실행에서 호출한다(`Garmin/src/garmin_pipeline/ports.py:60`, :71). |
| delivery | id INTEGER PK, local_date, kind, nullable event, ok(0/1), nullable reason, at(epoch ms). 성공 iff reason null CHECK. UNIQUE 날짜·kind는 없고 항목별 반복 이력을 담는다. 본문·토큰·chat id는 저장하지 않는다(`Garmin/src/garmin_pipeline/store/migrations/0015_delivery.sql:1`, :3, :6, :11; `Garmin/src/garmin_pipeline/ports.py:222`). |
| 결과 분류 | DeliveryKind는 notify·report_text·report_album·report_document. DeliveryReason은 network·rate_limited·http_4xx·http_5xx·invalid_config·too_large. 불명 전용 결과는 없다(`Garmin/src/garmin_pipeline/errors.py:35`, :44). |

사건 7종은 auth_failed(인증), rate_limited(계정 호출 제한), blocked_403(차단), normalize_failed(정규화), repeated_partial(반복 부분 수집), error, report_failed다. 텍스트 선택은 notice_text와 사건 표가 맡는다(`Garmin/src/garmin_pipeline/errors.py:23`; `Garmin/src/garmin_pipeline/ports.py:150`, :184). 앞 6종은 epic 16의 수집 사건 요청으로, report_failed는 epic 18로 옮긴다는 결정이 있다(`_bmad-output/personal-brain/tickets/epic-garmin-runtime/epic-garmin-runtime.md:60`; `_bmad-output/personal-brain/tickets/epic-health-analysis/epic-health-analysis.md:64`).

최초 시도 gate는 notification INSERT가 이겼을 때만 send하는 구조다. 실패나 예산 부족이어도 notification은 남고 다음 notify는 발신을 건너뛴다. 반환 True는 새 gate를 만들었다는 뜻이지 외부 성공이 아니다(`Garmin/src/garmin_pipeline/ports.py:253`, :258, :269, :279). `_notify_failed`는 쓰기 세션에서 gate를 확정한 뒤 연결 밖에서 send하고 새 쓰기 세션에 delivery를 넣는다. 기록 실패는 종료 코드를 바꾸지 않는다(`Garmin/src/garmin_pipeline/report.py:712`, :724, :737, :750). POST 전에 커밋됐는지 시험하는 기반도 있다(`Garmin/tests/test_telegram.py:249`). **어긋남:** 옛 실패 후 영구 억제 구조를 복사하면 Brain의 실패·불명 재시도를 잃는다(에픽:54).

리포트는 `[재생성] ` 선택 접두사의 요약 → 각 앨범을 최대 10장씩(1장이면 sendPhoto, 2~10장이면 sendMediaGroup) → 전문 sendDocument 순서다. 항목 사이 1초, 항목당 timeout 30초이며 실패·결과 기록 예외 뒤에도 다음 항목을 보낸다. bundle 전체 30초 예산이 아니다(`Garmin/src/garmin_pipeline/ports.py:77`, :101, :105, :119, :126, :135, :140). 알림은 남은 예산과 10초 중 작은 timeout을 차감하고 1초 미만이면 보내지 않고 network로 기록한다(`Garmin/src/garmin_pipeline/ports.py:144`, :253). 알림은 429 대기 안 함, 리포트는 wait_rate_limit=True로 최대 1회 즉시 재호출한다(`Garmin/src/garmin_pipeline/ports.py:130`, :217; `Garmin/src/garmin_pipeline/telegram.py:123`, :138).

HTTP는 `/bot<token>/<method>`에 POST, 텍스트는 JSON, 파일은 multipart(data+files), redirects 금지, connect/read timeout 각각 절반이다. 429→rate_limited, 그 밖 4xx→http_4xx, 비2xx→http_5xx, 2xx라도 JSON dict의 ok=True가 아니면 http_5xx, 예외→network다. 로그는 이유·예외 클래스만 남긴다(`Garmin/src/garmin_pipeline/telegram.py:126`, :133, :136, :156, :163, :167). 연결 전 오류와 서버 접수 뒤 응답 유실을 network 하나로 합치므로 Brain에서는 확정 실패·불명을 별도로 모델링할 필요가 있다(같은 파일:163; 에픽:18, :54).

설정 선택은 명시 경로 → `GARMIN_PIPELINE_CONFIG` → 현재 폴더 config.toml, tokenstore 기본은 `~/.garmin-pipeline/tokens`다. config.py에 Telegram token/chat 개별 키는 없으며 adapter가 `<tokenstore>/telegram.json`의 `bot_token`, `chat_id`를 매 요청 읽는다. 파일은 일반 파일 0600, 파일·부모 심링크 거부, token은 비어 있지 않은 문자열, chat은 정수 또는 비어 있지 않은 문자열이다. `GARMINTOKENS`는 읽지 않는다(`Garmin/src/garmin_pipeline/config.py:11`, :28, :35, :181; `Garmin/src/garmin_pipeline/telegram.py:20`, :25, :35). 실제 비밀 값은 읽지 않았다.

## 2. Telegram Bot API — archive 근거로 확인한 범위

이 절은 API의 현재 공식 명세를 검증한 결과가 아니다. 네트워크를 사용하지 않았고 코드·주석·시험이 증명하는 범위만 구분했다.

| 질문 | 관찰 / 미확인 |
|---|---|
| 중복 방지 키 | adapter payload는 chat_id+text 또는 media/files이며 중복 방지 키를 보내지 않는다. API 자체에 그런 키가 **없다는 사실은 미확인**(`Garmin/src/garmin_pipeline/telegram.py:42`, :65, :76, :122). |
| 보낸 메시지 조회 | 이 adapter에는 sendMessage·sendPhoto·sendMediaGroup·sendDocument만 있다. API 전체의 조회 메서드 존재/부재는 **미확인**(`Garmin/src/garmin_pipeline/telegram.py:42`, :54, :65, :76). 따라서 조회로 불명을 해소할 수 있다고 약속하지 않는다. |
| sendMessage·sendDocument 응답 | 성공 판단은 HTTP 2xx+JSON ok=True뿐. `result`·`message_id`를 읽거나 반환·보존하지 않는다. 실제 Message 응답 구조와 message_id 계약은 **미확인**(`Garmin/src/garmin_pipeline/telegram.py:156`; `Garmin/tests/test_telegram.py:33`). |
| sendMediaGroup 응답 | 같은 공통 요청기를 써 ok만 확인한다. 실제 반환 Message 배열과 각 message_id는 **미확인**. 가짜 서버도 기본 응답이 `{ok:true}`뿐이다(같은 파일:86, :156; `Garmin/tests/test_telegram.py:33`). |
| 텍스트 4096자 | 옛 구현은 UTF-16 code unit 수 >4096을 too_large로 막으며 시험도 있다. API의 문자 계산 공식과 일치 여부까지 검증한 것은 아니다(`Garmin/src/garmin_pipeline/telegram.py:51`; `Garmin/tests/test_telegram.py:197`). |
| 캡션 1024자 | 캡션 payload 자체가 없다. 이 근거 집합에서 **1024자 상한은 미확인**(`Garmin/src/garmin_pipeline/telegram.py:58`, :69, :85). |
| 429 retry_after | `parameters.retry_after`를 읽어 int(bool 제외), 0 이상·timeout 이하일 때만 sleep 후 1회 재호출한다. 파일 stream을 rewind한다. 단위는 seconds 인자와 sleep 사용으로 초라고 해석된다. 헤더 Retry-After를 읽는 구현은 없다(`Garmin/src/garmin_pipeline/telegram.py:123`, :140, :146, :149; `Garmin/tests/test_telegram.py:523`, :683). |

사진은 10MiB, 문서는 50MiB, 앨범은 2~10장이라는 로컬 제한도 있다. 이것도 현재 API 상한을 별도로 확인한 결과는 아니다(`Garmin/src/garmin_pipeline/telegram.py:60`, :71, :89, :92; `Garmin/tests/test_telegram.py:562`, :578). API 부재를 단정하지 않아도 확정된 불명 재시도 정책의 구현 조사는 진행할 수 있다(에픽:54).

## 3. Brain 쪽 자리 — 현재 코드와 받을 계획

| 자리 | 현재 근거 / 인계 뒤 할 일 |
|---|---|
| 출력 코덱 | `OUTPUT_CODECS`는 envelope·hook·text이고 encodeTextLine은 maskOutputText를 부른다. Telegram 텍스트 경로를 새 코덱으로 등록하고 실제 adapter 호출 전에 그 함수를 적용할 후보가 있다(`packages/core/src/output/codecs.ts:58`, :68, :72, :119). 출력에 보이는 것만 가리고 DB 원문은 보존하는 AD-11을 따라야 한다(spine:216; 에픽:40). |
| 비밀 fixture와 sink | 모든 등록 코덱의 비밀 제거·일반 문장 보존·DB 원문 유지 시험이 있다. sink 검사는 stdout/stderr 작성자를 대상으로 하므로 HTTP 발신은 자동 탐지된다고 가정하면 안 된다. Telegram 호출 spy로 실제 payload도 검증해야 한다(`apps/cli/test/output-codecs.test.ts:183`, :188, :213, :245, :272, :281). |
| `.env` | 현재 코덱은 `.env`를 쓰고 기존 값을 parseEnv로 보존·0600으로 저장하지만 정상 읽기에는 아직 `.env`를 읽지 않는다고 명시한다. 현재 파일만으로 Telegram 비밀 해결 계약이 있다고 볼 수 없다(`apps/cli/src/config/codec.ts:10`, :126, :548, :556, :601). AD-18의 비밀 참조·단일 Runtime 코덱과 11의 계약을 받아 Telegram 키를 등록할 자리다(spine:311, :318, :320; 에픽:51). Brain 비밀 키 이름은 아직 결정 자료가 없으므로 새 이름을 사실로 쓰지 않는다. |
| handler와 정책 | 현재 handlers 조립은 createBrain의 record merge다. 새 발신 kind는 12.1 실행 분류 등록부에 명시해야 한다. core handler 또는 감독되는 실행 중 선택은 새 인계 구현을 보고 정할 후보이며 이름만으로 분류하지 않는다(`packages/core/src/brain.ts:264`, :281; 작업 계획:8). |
| 재시도 | 현재 최대10, 지수 `min(1000*2^(n-1),3600000)`, 일시 오류 기본900초·retryAfter 우선 분기가 있다. 발신 kind는 에픽의 지수 재시도 결정과 이 기본 분기의 차이를 명시적으로 맞춰야 한다(`packages/core/src/domain/work-item.ts:59`, :95, :111; `packages/core/src/queue/drain.ts:146`, :153; 에픽:54). 429 retry_after를 지수 대기의 최소 대기 시각으로 합치는 안 등은 정책 구현 후보이며 새 결정이 아니다. |
| core migration | 현재 PG 0001을 직접 확장해 고정하지 않는다. 11.10의 baseline checksum 고정 뒤 12·13이 쓴 다음 core 번호를 확인한다. `packages/postgres/migrations/`에 새 SQL, 실행기는 `packages/postgres/src/migrate.ts`, `(owner,version)`은 소유자별 연속이다(PG 계획:128; spine:480, :481, :484, :639). |
| Store / fake / suite | `packages/core/src/ports/store.ts:631` WorkStore와 :1348 ScheduleStore 모양을 따른 capability 추가 후보. `packages/core/src/testing/fakes/store.ts:165` memoryStore, `packages/core/src/testing/contracts/work-store.ts:31`의 ContractCase[] 공유 suite, adapter runner `packages/sqlite/test/work-store.test.ts:68`가 현재 예다. 채널 suite를 fake와 PG에 연결한다. SQLite 파일은 역사적 참조이고 11.11 뒤 수정 대상이 아니다(PG 계획:139). |

## 4. 계약 표 설계 재료 — 모양 선택지, 확정 DDL 아님

아래 칸 이름은 후보다. 채널 요청·이력의 실제 이름과 최소 DDL은 이 에픽이 정할 책임이며, 지금 spine에 확정 컬럼 목록은 없다(spine:580; 에픽:17).

| 개념 | 최소 재료와 선택지 | 근거 |
|---|---|---|
| channel / conversation | 내부 UUID, adapter kind(telegram), 외부 봇/계정의 비밀 아닌 안정된 참조, 외부 conversation id. chat_id는 공개 상태·로그에 그대로 출력하지 않고 비밀 코덱 참조와 정체성 키를 분리할 수 있다. token 자체를 identity로 쓰지 않는다. | R13·같은 봇/대화 재사용(이니셔티브:39; 에픽:56), 비밀 저장 경계(spine:318) |
| thread / message 연결 | nullable 외부 thread id와 부모 메시지 참조, 외부 message id(확인 가능한 경우만), 채널/대화에 속한 내부 ID. 일반 대화는 thread 없음으로 표현하며 가짜 외부 id를 발명하지 않는다. | spine:533, :773; 옛 이력은 message id 없음(`Garmin/src/garmin_pipeline/store/migrations/0015_delivery.sql:3`) |
| 요청 | request UUID와 별도로 `(producer_result_id,conversation_id,purpose,revision)` 의미 키 UNIQUE. 생산자 namespace·source·생산 결과 타입/ID·생성 시각·bundle 참조를 남긴다. NULL revision을 UNIQUE 우회 구멍으로 만들지 않는 정규형이 필요하다. | 에픽:18; spine:533, :624 |
| gate / attempts | 최초 시도 직전 짧은 transaction에서 gate를 한 번 저장·확정한 뒤 외부 호출. 재청구는 새 요청처럼 gate를 만들지 않고 같은 요청의 attempt로 진행. attempt token·시도 번호·시작/종료·결과를 연결하고 결과 확정은 현재 token만 허용한다. | 에픽:18, :54; 작업 계획:8, :32; spine:533 |
| 결과 / 불명 | sent·definite_failed·unknown을 구분한 append-only 결과, reason code, 외부 응답 참조(검증될 때만), 항목 순서·kind. 요청 성공과 개별 bundle 항목 성공을 구별한다. gate 이후 호출 전 crash도 외부 결과를 입증할 수 없으면 성공으로 추정하지 않는다. | 에픽:18, :54; spine:580; 옛 부분 성공 구조(`Garmin/src/garmin_pipeline/ports.py:126`) |
| 인계 | core가 미인계 요청을 재발견하여 request_id 대상 work 생성과 인계 표식을 같은 transaction에 확정한다. 확장 INSERT 뒤 crash, work 생성 경계 crash, 중복 발견 모두 같은 요청으로 수렴시켜야 한다. 외부 HTTP 동안 DB transaction을 열지 않는다. | spine:473; 경계:65 |
| 확장 INSERT | role 결합 source WITH CHECK RLS, NOBYPASSRLS·owner 분리, UPDATE/DELETE 금지, 12.3 확인 함수의 INSERT trigger를 실제 요청·legacy 표에 부착한다. 확장은 work_items를 직접 만들거나 결과를 고치지 않는다. | spine:469, :471, :472, :473; 작업 계획:32; 확장 계획:44 |
| 공개 상태 | 요청 id·결과/불명·attempt·다음 시도·실패 참조·legacy 표시를 비밀 없는 view/SDK projection으로 낼 후보. 확장 설치 상태는 13.6의 공개 계약을 읽고 복제하지 않는다. | 확장 계획:68; spine:460; 에픽:55 |

세부 불변식 선택지는 요청 표와 이력 표 분리, 또는 요청+append-only attempt/result 하위 표다. 인계 표식은 요청의 core 전용 컬럼 또는 별도 core 전용 인계 표에 둘 수 있다. 확장이 INSERT만 하는 요청의 내용을 core가 변경하지 않으려면 후자가 명료하지만 파일·verb 수가 늘어난다. 어느 쪽이든 legacy 전용 입력은 인계 SELECT 대상에서 구조적으로 제외하고 resend에서도 거부해야 한다(spine:473, :580; 에픽:21).

identity/provenance 최소 연결은 `생산 결과 → 요청 → 대화/스레드 → attempt/외부 메시지 참조`, legacy는 `dataset → 원래 표/키 → 이력 → 같은 대화`다. user identity와 Telegram chat identity를 같은 것으로 합치거나 core에서 Garmin schema FK를 거는 안은 피할 재료다. core→확장 FK 금지이고 수신 사용자는 아직 구현 범위 밖이다(spine:468, :533; 에픽:38). 이후 답장 연결에 필요한 ID를 지금 보존하되 수신 처리 자체를 만들지는 않는다(이니셔티브:39, :70).

## 5. 옛 이력 이전 — epic 14에 넘길 모양

notification은 최초 시도 gate, delivery는 실제 전송 결과로 별개 사실이다. notification 행만 있다고 성공으로 채우면 안 되며 delivery와 강제로 1:1 묶을 수 없다. report delivery에는 event도 없을 수 있고 같은 날 여러 앨범·재생성이 가능하다(`Garmin/src/garmin_pipeline/store/migrations/0005_notification.sql:3`; `Garmin/src/garmin_pipeline/store/migrations/0015_delivery.sql:5`, :7; `Garmin/src/garmin_pipeline/ports.py:105`).

| legacy 대상 | 가져올 칸 / 표 계약 재료 |
|---|---|
| 공통 출처 | dataset/snapshot ID, source schema/version, 원래 표 이름·원래 키, import batch/version, legacy 표시, 같은 봇/대화에 대한 연결. 재실행 식별자는 dataset+table+original key이며 dataset이 다른 행은 보존한다(이전 계약:31, :42, :53; 에픽:56). |
| notification | local_date, event, detail, 원래 at(epoch ms), 최초 gate라는 사실. 원래 자연키(local_date,event)를 그대로 보존하며 새 request UUID를 성공 증거로 조작하지 않는다(`Garmin/src/garmin_pipeline/store/migrations/0005_notification.sql:2`, :16, :18; 이전 계약:33). |
| delivery | 원래 id, local_date, kind, nullable event, ok, nullable reason, at. 원래 token/chat/message id/본문이 없다는 사실도 보존한다. 없는 외부 ID는 nullable·누락 이유로 표현할 후보(`Garmin/src/garmin_pipeline/store/migrations/0015_delivery.sql:2`, :3; 이전 계약:38). |
| 재발신 방지 | legacy에는 pending 요청·work 인계 표식을 만들지 않고 원래 gate와 결과만 넣는다. 재반입 시 원문 불일치 충돌을 조용히 버리지 않고 검증에 드러낸다(이전 계약:33, :42, :54; spine:473, :580). |

schema 10·15 관찰 소스는 최신 16 코드와 다르므로 실제 delivery 표가 없는 dataset도 가능하다. 있는 표만 이전하고 “없음”을 “빈 표/전송 성공”으로 바꾸지 않는 fixture가 필요하다(이전 계약:15, :16, :21, :51). epic 14는 합성 fixture·반입·재개·대조를 담당하고 15는 legacy 입력 DDL·권한·조회·재발신 거부 계약을 먼저 제공한다(`_bmad-output/personal-brain/tickets/epic-garmin-import/epic-garmin-import.md:30`, :39, :67, :69).

## 6. resend 스킬과 CLI 자리

`plugin/skills/`의 첫 install 스킬은 13.7 계획이다. resend도 같은 플러그인 소유의 별도 스킬 후보이며 실제 CLI를 호출하고 상태를 다시 읽어 결과를 보고해야 한다. 임의 메시지 본문을 입력받아 보내는 기능은 이번 결정에 포함되지 않는다(확장 계획:79, :80; 에픽:55).

명령 후보는 `brain channels status|list`(read), `brain channels resend <request-id>`(write)와 SDK 대응이다. 정확한 namespace·verb는 아직 없으며 `commands` 등록부, CommandSpec 메타(usedFor·required·examples·output·risk·hook·dryRun), guide schema에 넣을 재료다(`apps/cli/src/commands/index.ts:22`, :36; `apps/cli/src/dispatch.ts:221`, :246; spine:623, :632). status가 실패와 unknown을 구분하고 resend가 같은 요청의 재시도를 여는지 새 작업 세대를 여는지 명시해야 한다. 완료 성공·legacy·아직 진행 중인 요청을 무심코 재발신시키지 않는 입력 검증이 필요하다(에픽:21, :54, :55; spine:358).

기존 failures retry와 실패 해결 동작을 재사용할 후보지만 의미 키 충돌을 피하려고 요청 자체를 새로 만들면 안 된다. resend 뒤 failure resolved 처리 시점도 성공 확정과 맞춰야 한다(`packages/core/src/ports/store.ts:631`; `apps/cli/src/commands/index.ts:11`, :12; spine:565). 스킬은 guide schema로 지원 여부 확인 → status → resend → status/doctor로 실제 결과 보고 순서 후보다. 정적 CommandSpec 대조와 fake CLI 행동 시험을 재사용할 수 있다(확장 계획:80, :81).

## 7. 이 Mac 설정 존재 확인 — 비밀 값 미열람

2026-10-28에 `ls`와 `grep -nEo`(키 이름과 구분자만 출력)로 확인했다. 이 절의 로컬 관찰은 파일 내용 전체를 읽은 증거가 아니며, 비밀 값을 담은 파일은 열지 않았다.

| 확인한 위치 | 관찰한 사실과 한계 |
|---|---|
| `~/github/garmin/config.toml:3` | 파일 존재, `environment` 키 존재. 활성 tokenstore 키는 키 이름 검색에서 나오지 않았다. |
| `~/github/garmin/runtime/config.toml:4`, :11 | 파일 존재, `environment`, `timezone` 키 존재. 활성 tokenstore 키는 키 이름 검색에서 나오지 않았다. |
| `~/.garmin-pipeline/tokens/` | 디렉터리 존재. ls 결과 `.session.lock`, `garmin_tokens.json` 존재, `telegram.json`은 없음. Garmin 토큰 파일 내용은 읽지 않았다. 파일 목록 관찰이라 행 번호는 해당하지 않는다. 기본 위치의 근거는 `Garmin/src/garmin_pipeline/config.py:35`, Telegram 파일명은 `Garmin/src/garmin_pipeline/telegram.py:21`. |
| 별도 후보 | `~/github/garmin/tokens`, `~/github/garmin/runtime/tokens`, `~/github/garmin/.tokens`에서 Telegram 설정을 확인하지 못했다(ls). 임의의 다른 config·환경 변수 경로까지 없다고 단정하지 않는다(`Garmin/src/garmin_pipeline/config.py:181`). |

결론은 **기본 위치에서 옮길 Telegram 설정을 확인하지 못함**이다. 찾았다면 옮길 키는 `bot_token`, `chat_id`이고 대상은 Brain 설정 코덱이 읽는 `.env`다. 이번 증거로 실제 봇 접근 가능·유효 토큰·chat 매칭을 주장할 수 없다. 뒤 실계정 스토리는 이 상태가 계속되면 awaiting-operator로 남기고 run은 계속한다(에픽:59; 이니셔티브:191, :192). Garmin 토큰의 존재를 Telegram 설정 존재와 혼동하지 않는다(`Garmin/src/garmin_pipeline/telegram.py:21`, :35).

## 8. 레인과 한 세션 크기 위험

다음은 수정 후보이며 현재 실제 구현 파일이 있다는 주장이 아니다. 인계 HEAD에서 새 모듈 이름·마이그레이션 번호를 다시 확인한다(PG 계획:128; 작업 계획:8; 확장 계획:8).

| 함께 고칠 자리 | 겹칠 후보 | 이유 / 분할 재료 |
|---|---|---|
| `packages/core/src/ports/store.ts`, `testing/fakes/store.ts`, 새 `testing/contracts/channel-store.ts` | tracer·legacy·retry/resend | 요청·gate·attempt·조회 verb가 이어진다. 정상 최소 계약 후 오류 행렬을 분리할 후보(현재 모양 `packages/core/src/testing/contracts/work-store.ts:31`). |
| `packages/postgres/migrations/`, PG store 조립·새 channel 모듈 | tracer·RLS·legacy·retry | 같은 core 번호열·출처 제약·상태 제약. 한 레인 후보, 실행기가 번호 중복 거부(spine:481, :580). |
| `packages/core/src/brain.ts`, queue 등록부, CLI assembly·daemon 조립 | tracer·인계 복구·retry | 새 kind와 요청 재발견을 함께 조립한다. 12 구현과 충돌 확인 필요(`packages/core/src/brain.ts:264`; 작업 계획:8; spine:473). |
| `packages/core/src/output/codecs.ts`, `apps/cli/test/output-codecs.test.ts` | adapter·CLI | HTTP payload와 사람용 상태 출력 모두 가리기. source sink 검사는 HTTP 자동 보장 아님(같은 시험:272). |
| `apps/cli/src/config/codec.ts`, commands/index.ts·dispatch 메타·doctor | tracer·retry/resend·설치 확인 | 비밀·새 CLI·실패 표시가 공유된다(`apps/cli/src/config/codec.ts:126`; `apps/cli/src/commands/index.ts:36`; 에픽:54). |
| `plugin/skills/`, `plugin/app-ref`, `plugin/.claude-plugin/plugin.json` | resend 스킬·배포 확인 | 스킬/실제 명령 동기화, app-ref는 앞선 commit·version 동반 변경 정책. 이번 보고서는 변경하지 않음(확장 계획:80, :115; `AGENTS.md:11`). |

tracer에 bundle 모든 종류·RLS 전체 행렬·crash 전부·doctor·resend·스킬·실발신을 한 번에 넣으면 층 수가 과하다. 얇은 정상 발신 경로를 남기고 legacy/RLS, 실패·불명·재개, bundle, 운영 표면을 나누는 후보가 있다(에픽:17, :18, :30, :54, :55; 작업 계획:8의 tracer 축소 선례). 특히 부분 성공 bundle 재시도는 이미 성공한 항목을 다시 보내는 범위를 정해야 하므로 독립 검증량이 크다(`Garmin/src/garmin_pipeline/ports.py:126`).

## 9. Done when 1~4 — 기존 시험 기반과 빈 곳

| Done when | 읽어 확인한 기반 | 추가할 검증 재료 |
|---|---|---|
| 1 공통 계약 발신·이력 | 옛 실제 로컬 HTTP 가짜 서버와 multipart/순서 기록, gate 커밋 후 POST 시험. Core Store 공통 suite·memory fake 패턴(`Garmin/tests/test_telegram.py:33`, :249, :398; `packages/core/src/testing/contracts/work-store.ts:31`) | TS fake adapter와 로컬 가짜 Telegram 서버, PG 요청→인계→gate→POST→결과 tracer, 실제 나가는 payload 가리기. 실계정은 별도 설치본 확인이며 이번 조사에서는 실행 안 함(에픽:30, :59). |
| 2 실패 재시도·생산 결과 보존 | 옛 분류·429 rewind·예산·실패 뒤 다음 항목·report 보존 시험(`Garmin/tests/test_telegram.py:96`, :523, :590, :623; `Garmin/tests/test_ports.py:120`, :146) | clock 전진 지수 대기·10회 소진→failures/doctor, 전송 전 실패/접수 뒤 응답 유실, 결과 저장 직전 crash를 분리. 생산 결과 해시·행은 그대로인지 확인. 불명 전용 fake가 필요(에픽:31, :54; spine:532). |
| 3 중복 억제·legacy 비발신 | 옛 최초 detail·autocommit·예산 후 재호출 억제 시험(`Garmin/tests/test_ports.py:88`, :109, :120) | 동시 요청 UNIQUE·동시 gate 승자 하나, 요청 INSERT 후 crash·인계 transaction 경계 crash 복구, stale attempt 직접 SQL 거부, 다른 source RLS 거부, legacy batch 두 번/partial 재개에도 HTTP와 work 생성 0. 동일 의미 요청 중복 억제와 불명 재시도의 중복 허용을 따로 관찰(에픽:32, :54; 작업 계획:33; 이전 계약:54). |
| 4 플러그인 배포·설치본 | 13.7 스킬 메타 대조·fake CLI 행동 시험과 13.10 설치본/스킬 발견 계획은 아직 구현 전이다(확장 계획:80, :115) | resend 스킬의 지원 확인·대상 확인·실패 후 사실 보고, 패키지에 adapter·schema·스킬 포함, 로컬 app-ref/version 갱신 뒤 설치본 status/resend/doctor. 운영 비밀 없으면 해당 실계정 단계만 awaiting-operator(에픽:33, :59; 이니셔티브:189, :192). |

가짜 서버는 외부 접수는 했지만 응답을 끊는 경우, 2xx JSON 손상, message_id가 없는 응답, 429 후 재시도, 한 앨범만 성공하는 경우를 제어할 필요가 있다. 옛 서버는 상태·body·on_request를 바꿀 수 있지만 실제 API의 Message schema를 검증하는 fixture는 아니다(`Garmin/tests/test_telegram.py:33`, :56; `Garmin/src/garmin_pipeline/telegram.py:156`). 네트워크 사용 금지인 이번 조사에서 이 시험을 실행하지 않았다.

## 스토리 후보

아래는 tracer와 순서의 선택지다. 티켓 생성·번호 고정·새 정책 결정은 하지 않았다. 선행 entry는 현재 계획 근거이며 실제 인계 HEAD의 파일·시그니처를 다시 확인해야 한다(이니셔티브:187; 전체 계획:61).

| 후보 | 세로 경로·검증 초점 | 수정 파일 후보와 선행 재료 |
|---|---|---|
| T1 tracer: 테스트 생산자 한 건→Telegram 가짜 서버→이력 | 요청 의미 키, 최소 대화, core 인계, 최초 gate, 텍스트 하나와 성공 기록. 두 번 같은 요청 시 POST 하나. 정상 길을 관통하되 전체 오류 행렬은 미룸. | 새 `packages/core/src/channels/`·채널 port/contract/fake, PG 다음 SQL·channel 모듈·조립, Runtime Telegram adapter·설정 코덱·brain/daemon 조립, 출력 코덱·새 HTTP 시험. 11.3/11.6/11.10, 12.1/12.3, 13.4를 인계 기반으로 고려(PG 계획:43, :79, :128; 작업 계획:8, :32; 확장 계획:44). |
| T2 요청·legacy 공개 계약과 보안 경계 | RLS role/source, attempt trigger, legacy 원래 키·결과 보존·비인계·resend 거부, crash 인계 복구. 14가 사용할 합성 입력 계약 완성. | PG 새 SQL·채널 Store·계약 suite/fake·공개 view, 인계 재발견 use case. 13.4와 T1 기반. 14를 빨리 열려면 T2를 T3보다 앞에 둘 선택지(spine:469, :473, :580; 이전 계약:42). |
| T3 실패·불명 재시도와 resend/doctor | 전송 결과 unknown 분리, 지수/429 대기, 최대10·failures, 새 작업 세대로 같은 요청 재개, 생산 결과 불변. | channel attempts/result use case·handler 정책, PG Store/SQL·contract/fake, `codes.ts`, CLI channels 명령·commands/index.ts·doctor·brain SDK, clock/HTTP 실패 시험. T1 뒤, 12 retry·failure 계약 활용(에픽:54, :55; `packages/core/src/domain/work-item.ts:59`, :95). |
| T4 결과 bundle | 요약→앨범→전문, 항목 결과·부분 성공과 재시작, 길이/파일 제한·가리기. 채널 port는 Garmin 계산에 의존하지 않음. | channel bundle domain·출력 코덱·Telegram multipart adapter·PG 항목 결과·계약/HTTP 시험. T3 앞 또는 뒤 선택: 부분 재시도 정책 구현을 함께 검증하면 T3 뒤가 단순(`Garmin/src/garmin_pipeline/ports.py:61`, :101; spine:532, :533). |
| T5 resend 스킬·배포 마감 | guide schema→status→resend→실제 결과 보고, 없는 CLI 우회 금지, 패키지 배포 포함 확인. | `plugin/skills/resend/SKILL.md`(이름 후보), 스킬 정적/행동 시험, 명령 메타·배포 목록·가이드. T3와 13.7 시험 기반 뒤(에픽:55; 확장 계획:80). |
| T6 이 Mac 설치본·실계정 확인 | 로컬 플러그인 배포와 스킬 발견·doctor·발신 한 번의 증거. 현재 Telegram 설정 미확인 상태는 해당 단계만 awaiting-operator. | 배포 때 app-ref·plugin.json version, 스토리 plan 증거/정리 절차. 이번에는 수정 안 함. ref는 앞선 commit, 원격 push 필요한 단계는 operator_actions(에픽:59; 이니셔티브:189, :192; `AGENTS.md:11`). |

순서 선택지는 T1→T2→T3→T4→T5→T6(14의 legacy 계약 우선) 또는 T1→T3→T2→T4→T5→T6(가장 위험한 불명 재시도 우선)이다. 13.6 공개 확장 상태를 status/doctor에 붙일 때만 그 entry 의존도 더할 수 있다. 어느 순서든 core SQL 번호·Store·코덱·명령 등록부를 함께 고치므로 같은 레인의 순차 구현 후보이며, 앞 에픽 실계정 확인을 에픽 전체 gate로 되돌리지 않는다(확장 계획:68; 이니셔티브:187; spine:481).
