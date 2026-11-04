결론: 독립 PostgreSQL 18 실측에서 18.10과 별개인 **대규모 snapshot 지문 계산·잠금, 반입 정리 anti-join, 흔한 검색어 scoring, 첨부 직렬 왕복**을 우선 후보로 확인했으며, 모든 정적 후보를 큰 병목으로 취급할 근거는 없었다.

## 후보별 판정

| 후보 | 판정 | 실제 비용과 후속 판단 |
|---|---|---|
| 1 누적 메시지·도구 재조회 | 확인 — 장기 세션 누적 비용 | 각각 10만 행, 2 SELECT+Map/Set 84.45ms, 합계 JSON 약 21.47MB. 한 배치가 작아도 이력 전체를 전송한다. 작은 세션은 1.54ms여서 작은 시험의 주범이라는 주장은 기각한다. 세션 성장 작업 후보이며 18.10과 별도다. |
| 2 snapshot 이중 읽기·배열·잠금 | 확인 — 이번 가장 큰 세션 비용 | 실제 core 지문을 포함한 100MB/10만 메시지의 두 transaction workload는 3.65초, 잠금 체류·실제 경쟁 연결 대기는 약 1.86초다. 순수 SHA-256/직렬화가 배열보다 크다. 본문 검증·stale 안전장치를 보존하는 별도 세션 성능 후보다. |
| 3 file_locations UUID::text | 확인 — 국소적 전체 스캔 | 10만 행 단건 5.24ms→UUID 조건 0.31ms, mark 15.24ms→0.60ms. 소규모 차이는 작다. 비 UUID·대문자 계약을 보존하는 조건 변경이 필요하며 국소 후보이지 전체 시험 지연 해답은 아니다. |
| 4 daemon anti-join | 확인 — 미정리 후보 존재 시; 단순 유휴 큰 병목은 기각 | 완료 10만 이력에 미정리 100건이면 1.14초, 인덱스 조합 비교 1.02ms로 동일 결과. 모두 cleaned이면 3.56ms, unhanded 빈 결과는 13.71ms다. 미정리 조회 인덱스를 별도 우선 후보로 본다. |
| 5 채널 집계·최신 sequence | 확인 — 관리 목록 규모 비용; 무조건 최신 인덱스 추가는 기각 | 1만 요청×10시도 248ms→225ms. ×100시도는 855ms→621ms이나 ×1시도는 68ms→90ms로 악화했다. 전체 집계와 반환량이 남으며 사용 빈도 확인 후 관리 조회 후보로 분리한다. |
| 6 흔한/짧은 검색어 scoring | 확인 — 검색 체감 비용 | 10만 chunk common 1.54초, tool common 1.74초. a는 병렬 계획에서 0.55/0.57초다. 긴 불일치 검색어는 약 1ms다. 짧을수록 항상 더 느리다는 일반화는 기각한다. 검색 의미·근접 순위를 보존하는 별도 후보다. |
| 7 첨부별 직렬 SQL | 확인 — 대량 초기 반입 | 첨부 1천 개+파일+위치2개 9,002 SQL, 1.02초. 기존 첨부 1천 개 1,002 SQL, 99ms. 작은 첨부 수는 수 ms이며 대량 반입 범위의 후보로 세션 작업에 묶을 수 있다. |

판정의 ‘확인’은 지정한 합성 규모와 workload에서 실제 비용을 확인했다는 뜻이다. **운영 이력 분포·빈도, 전체 suite 기여도, 전체 API 처리 시간과 안전한 일반 구현 동등성은 미확인**이다. 구현·티켓 생성·소스/시험 변경·commit/push는 하지 않았다.

## 규모별 실측

아래는 warm-up 뒤 3회 wall 중앙값(ms)이다. N은 메시지·도구·조각·파일 위치·반입 이력 각각의 행 수이며 채널 요청만 N/10이다. CPU·반환 바이트·실행 계획·3회 원시 값은 `results.json`, `extra-results.json`, 전체 표는 `measurements.md`, 요약 계획은 `plans-summary.json`에 있다.

| workload | N=1천 | N=1만 | N=10만 |
|---|---:|---:|---:|
| 누적 이력 2 SELECT + Map/Set | 1.536 | 10.223 | 84.451 |
| snapshot 1회 / 본문 전송 | 1.591 | 14.114 | 151.888 |
| 위치 id::text 단건 | 0.265 | 0.627 | 5.240 |
| 위치 UUID 단건 비교 | 0.209 | 0.290 | 0.310 |
| 위치 mark UPDATE+재조회, text | 0.684 | 2.572 | 15.240 |
| 위치 mark UUID 비교 | 0.540 | 0.619 | 0.597 |
| 유휴 unhanded, 반환 0 | 0.386 | 1.367 | 13.708 |
| 모두 cleaned, 반환 0 | 0.419 | 0.599 | 3.561 |
| 미정리 100건 | 7.731 | 70.241 | 1139.648 |
| 미정리 100건, 인덱스 비교 | 0.575 | 0.900 | 1.020 |
| 공유 locator 100건 차단, 반환 0 | 5.737 | 36.589 | 411.690 |
| 채널 전체 목록, 요청 N/10·시도 10 | 1.346 | 18.540 | 248.340 |
| 채널 최신 인덱스 비교 | 1.509 | 16.004 | 225.145 |
| chunk 흔한 common, 출력 6 | 17.192 | 180.334 | 1543.603 |
| chunk 짧은 a, 출력 6 | 16.220 | 157.012 | 547.285 |
| chunk 불일치 긴 검색어 | 5.211 | 1.433 | 0.961 |
| tool 흔한 common, 출력 6 | 17.146 | 192.524 | 1739.658 |
| tool 짧은 a, 출력 6 | 16.963 | 162.097 | 573.780 |

## snapshot의 실제 전체 비용과 잠금

본문은 1,024바이트×10만 메시지=102.4MB다. snapshot SQL 1회의 결과 JSON은 113.70MB이며 정상 경로는 이를 두 번 읽는다. 원본 인덱스로도 `messages_session_occurred_idx` Index Scan+Incremental Sort였고 서버 23.02ms다. 정렬 인덱스 `(session_id,occurred_at,id)` 비교는 24.93ms로 서버 개선을 확인하지 못했다. wire 다운로드·드라이버 복원과 CPU 처리까지는 151.89ms이므로 ‘정렬 인덱스만 추가’하는 우선순위는 낮다.

실제 지문 계산은 고정 SHA의 `conversationFingerprint`와 `domain/sha256.ts`를 타입만 제거해 실행했다. SHA-256 원문 hash는 `extra-results.json`에 보존했다. 1천/1만/10만 메시지의 지문 1회 중앙값은 각각 16.13/164.89/1,609.44ms다. `contentHash`는 순수 TypeScript UTF-8 인코더·SHA-256이고 큰 숫자 배열 및 문자열 직렬화를 만든다. 100MB 지문 실험의 process high-water RSS는 약 3.76GiB였다. 이것은 한 함수의 순수 추가 메모리 측정이나 모든 운영 세션의 메모리 추정치가 아니다.

실제 core 지문을 양쪽 snapshot에 넣은 unchanged-chunk transaction workload의 wall 3회는 3527.01, 3724.29, 3645.73ms, 중앙값 3645.73ms, client CPU 중앙값 3854.85ms다. 첫/둘째 hash 중앙값 1579.25/1600.33ms, 기존 5천 chunk find 구간 95.93ms, advisory+claim 잠금 체류 1865.26ms, 실제 별도 연결의 같은 advisory key 대기 1864.81ms였다. 최대 RSS는 3.98GiB다. 근거는 `snapshot-exact-results.json`이며, 앞선 Node-crypto 진단 675.91ms를 실제 API 시간으로 쓰지 않는다.

`sessions.ingest`도 같은 `harness:session` advisory key를 사용하므로 두 번째 snapshot·검증 CPU는 같은 세션 반입을 직렬화할 수 있다. 첫 snapshot 뒤 core chunkConversation 분할·변경 chunk INSERT/DELETE 및 실제 API의 전체 claim/expiry/stale 경쟁 검증은 포함하지 않았다. 따라서 3.65초는 전체 handler의 상한이나 총 소요 시간이라고 할 수 없다. 검증용 두 번째 읽기를 지우는 것을 개선으로 주장하지 않는다.

DB에서 읽은 chunk 행에 원문의 두 find 조건을 적용한 CPU 비교도 했다. 50/500/5천 unchanged chunk에서 find 0.014/0.759/40.479ms, Map 0.021/0.179/1.616ms였다. 모두 body가 바뀐 동일 범위는 find 0.033/2.267/120.550ms, Map 0.028/0.240/2.350ms다. 모든 규모에서 match/replace ID 분류 결과가 같았다. 이 비교는 range/part가 unique인 합성 행의 비교이며 실제 교체·삭제 쓰기, stale 판정 또는 원형 바이트 계약 전체의 동등성 증명은 아니다. 작은 배열은 Map이 오히려 더 느릴 수 있다.

## SQL 계획으로 확인한 원인

| 구간, 10만 이력 기준 | 실제 계획 근거 | 해석 |
|---|---|---|
| ingest 두 이력 조회 | 각각 10만 행·약 10.49/10.98MB JSON; 2 SQL+Map/Set client CPU 85.99ms 중앙값 | session 선택 인덱스 부재보다 ‘필요하다고 간주하는 이력 전체’가 문제다. 단계별 실제 생명주기 전체를 측정하지 않아 O(T²) 누적 전송은 구조적 모델로만 남긴다. |
| 위치 text 단건 | Seq Scan, 99,999행 제거, 1,334 hit blocks, 서버 4.654ms | UUID 비교 Index Scan은 4 hit blocks, 0.005ms다. 같은 조건 구조의 file_id 목록도 전체 스캔→파일 인덱스 조회로 달라졌다. |
| 정리 100건 | 내부 file_requests Index Scan이 outer 후보 100번 반복되며 매번 99,999행 필터 제거; 총 2,170,238 hit blocks | PK 순회 뒤 source/locator 조건 필터로 이력을 다시 훑는다. `(source,locator)` 및 `request_id WHERE cleaned_at IS NULL` 비교는 1,220 hit blocks, 서버 0.435ms로 줄었다. |
| 모두 인계됨 | request/handoff 각각 10만 Seq Scan+Hash Anti Join | 빈 결과도 전체 이력은 대조한다. 하지만 13.71ms 자체는 10초 유휴 주기에서 큰 지연이라고 보기 어렵고 실제 watcher/round 빈도는 측정하지 않았다. |
| 채널, 시도10 | 요청 1만 번 latest top-N sort+10행 스캔, count도 1만 번 집계; 281,316 hit blocks | 최신 인덱스는 latest만 index-only 1행으로 바꾸고 count는 남겨 전체가 191,798 hits다. 인덱스 하나로 전체 목록 비용이 사라지지 않는다. |
| chunk common | GIN Bitmap Scan 후보 10만+session join+전역 top-N 6 | LIMIT 6이 점수 계산 대상을 6개로 줄이지 않는다. 102.4MB 후보 본문에 lower/replace 계산이 필요하다. |
| tool common | 후보 10만+message Index Scan 10만 loops+session Memoize+top-N | chunk scoring에 메시지 연결 비용도 더해진다. 별도 EXPLAIN은 1,917ms로 wall 중앙값과 다르며 실행 간 I/O 차이를 보인다. |

UUID 비교는 canonical 소문자 UUID hit에서 결과 동등성을 세 규모 모두 확인했다. 비 UUID text 조회는 빈 결과이며, 대문자 UUID는 text 조건 0행/UUID cast 조건 1행이었다. 따라서 무조건 UUID cast는 동등하지 않다. 채널·cleanup·snapshot 인덱스 비교는 원문 SQL을 유지하고 각 규모의 결과 배열/해시 동등성을 확인했으며 인덱스는 transaction ROLLBACK했다.

채널 retry 분포 추가 실험은 요청 1만 건을 유지했다. 시도 1개/10개/100개에서 원형 목록 68.04/248.34/854.67ms, 최신 인덱스 비교 90.01/225.14/621.20ms였다. 시도1/100 추가 실험은 결과 JSON 직렬화도 측정 구간에 넣었으므로 10시도 기본 계측과 완전히 동일한 client 단계는 아니며, 같은 시도 수의 원형/인덱스 쌍 비교가 직접 비교 단위다. 모든 쌍의 출력은 동일했다. legacy 데이터·다수 failure 누적·단건 status는 이 matrix에 포함하지 않았다.

## 첨부 직렬 트랜잭션

| 첨부 수 | 새 파일+위치2개 ms / SQL 수 | 기존 첨부 ms / SQL 수 | 파일 없는 첨부 ms / SQL 수 |
|---:|---:|---:|---:|
| 1 | 1.995 / 11 | 0.614 / 3 | 0.609 / 4 |
| 10 | 13.825 / 92 | 1.438 / 12 | 2.117 / 22 |
| 100 | 107.009 / 902 | 14.708 / 102 | 22.728 / 202 |
| 1000 | 1021.312 / 9002 | 99.028 / 1002 | 211.266 / 2002 |

SQL 수에는 BEGIN/ROLLBACK 2개를 포함한다. 위치1개 ownership=brain, 위치2개 external 조건이며 새 첨부당 source의 9문장을 그대로 직렬 실행했다. 1천 새 첨부에서 client CPU는 163.74ms, wall은 1,021.31ms로 CPU 배열 탐색만으로 설명되지 않는다. localhost TCP와 실제 인덱스/trigger 처리·직렬 대기가 포함된다. RTT만 따로 분리한 값은 아니며 외부 네트워크 배수나 병렬화 절감 보장은 하지 않는다. 멱등성·소유권·source raw bytes·동시 반입 검증을 줄여 개선했다고 주장하지 않는다.

## 범위와 재현성

- 환경: macOS arm64, 호스트 논리 CPU 12개, Node v24.17.0, pg 8.23.1, OrbStack Docker의 PostgreSQL 18.6 Debian aarch64. shared_buffers=128MiB, work_mem=4MiB, JIT=on, parallel workers per gather=2. 컨테이너 자체 CPU/메모리 제한은 0(별도 cap 없음)이며 이미지 digest는 `cleanup.json`에 있다. 기본 PostgreSQL 설정을 사용했다.

- 기준 SHA: `51018bbb7988fb5e367b6488a6d315e7c4959f21`. 고정 Git 객체에서 29개 migration과 SQL 원문을 추출했다. `source-manifest.json`에는 파일별 SHA-256과 바이트 수, `*.source.txt`에는 원문, `callers.json`에는 기준 SHA의 호출자 검색 결과를 저장한다.
- `brain-perf-sql-42ce`, `127.0.0.1:54341`만 사용한다. 공용 54329, 운영 role·계정·실자료, 중앙 state, 티켓, 다른 워커 자원은 접근·변경하지 않는다. Docker socket 접근은 sandbox에서 거부되어 승인된 `require_escalated`로 실행했으며 자동 승인 거부는 없었다.
- PostgreSQL 18 원본 DDL을 사용하고 합성 fixture 주입 동안만 전용 연결의 `session_replication_role=replica`를 사용한다. 읽기·첨부 workload는 `origin`으로 복원해 수행한다. 반입·채널의 과거 attempt fencing을 재연하는 생산 API 시험이 아니다. superuser fixture/조사 연결을 쓰므로 운영 연결·권한·RLS 준비 비용을 포함하지 않는다.
- 메시지·도구·조각·파일·위치·요청 이력 각각 1천/1만/10만 행, 메시지·도구 target·조각 본문 1,024 ASCII 바이트. 메시지·도구는 한 장기 세션, 조각은 20개 세션으로 나누어 기존 조각 50/500/5천 개를 만든다. 요청은 인계·성공·정리 완료 이력을 기본으로 하고 미정리 100건·미인계 100건·공유 locator 차단을 별도 측정한다.
- 채널 요청은 100/1천/1만, 결과는 요청당 10개, work item은 요청당 1개, 미해결 failure는 요청 10개당 1개다. legacy는 0건이다. 채널 전체 목록과 검색 SQL은 원문 템플릿에서 상수·매개변수만 치환한다. 검색은 worktree/project 문맥 NULL, 출력 LIMIT 6, `common`/`a`/불일치 긴 검색어를 사용한다.
- 각 조회는 warm-up 1회 → 실제 결과를 다운로드하는 3회 → 별도 `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` 1회다. `results.json`에 wall, 클라이언트 CPU, 반환 행 수, JSON 직렬화 바이트, plan을 저장한다. JSON 바이트는 wire 바이트와 같지 않다. plan의 서버 실행 시간은 다운로드·드라이버 복원·응답 직렬화 시간을 제외한다. 서버 CPU만의 시간은 미측정이다.
- DB 생성·migration·fixture·계측·비교·정리는 모두 공통 `locked-run.py` 안에서 실행한다. lock 대기는 측정 시간과 별도다. statement timeout 60초, 일반 lock timeout 5초, 명시적 잠금 대기 실험은 60초다. 전체 suite·build·실제 ingest API는 실행하지 않았다.

## 실제 API와 계측 경계

1. 세션: `sessions.ts`의 두 이력 SELECT와 Map/Set 생성을 실제 DB transaction 안에서 실행한다. 새 메시지 INSERT·ensureWork·tracking UPDATE 등 전체 `ingest` 비용은 포함하지 않는다. 소비자는 `core/src/sessions/ingest.ts`의 `store.ingest`다.
2. snapshot: `conversation-index.ts`의 메시지 정렬 SELECT 2회, config·session 조회, advisory/행 잠금, 기존 chunk 읽기, fingerprint/배열 처리 형태를 묶는다. 주 workload의 hash는 Node SHA-256 진단이므로 core hash 비용을 대표하지 않는다. 별도 실험은 기준 소스의 실제 `conversationFingerprint`와 순수 TypeScript SHA-256을 타입만 제거해 실행한다. 기존 chunk 비교는 DB에서 읽은 행에 실제 두 `find` 조건을 적용한다. 실제 chunkConversation 분할·claim expiry·stale/redaction 경쟁 계약의 API 검증을 완료했다고 주장하지 않는다.
3. 파일 위치: `attachments.ts`의 read/list/mark UPDATE+재조회를 원형 조건과 UUID 조건으로 비교한다. UUID 비교는 전용 실험용으로만 쓴다. 비 UUID 외에도 대문자·비정규 UUID 입력은 원문 `id::text`와 의미가 달라질 수 있어 canonical 입력 검증 없이 개선으로 채택할 수 없다.
4. daemon: `imports.ts`의 실제 anti-join 두 개를 실행한다. 유휴 round 빈도와 watcher 깨움은 별도 미측정이며 10초 pause를 쿼리 비용으로 계산하지 않는다.
5. 채널: `channels.ts`의 전체 UNION/lateral/count/exists SQL을 실행한다. 생산 소비자는 수동 `channels-status`다. 채널 발신 daemon의 hot path로 일반화하지 않는다.
6. 검색: `recall.ts`의 chunk/tool 두 실제 SQL과 lower/length/replace 점수 정렬을 실행한다. core 결과 가공·CLI 렌더는 제외한다.
7. 첨부: `writeAttachments`의 직렬 SELECT/INSERT/UPDATE를 실제 DB transaction으로 재현하고 매 반복 ROLLBACK한다. 1/10/100/1천 첨부, 새 파일+소유/외부 위치 2개, 기존 첨부, 파일 없는 첨부를 나눈다. 재반입 준비 INSERT는 시간에서 제외한다. 파일·메시지 UUID는 모두 합성이다. withWrite/멱등성 전체 API 호출이 아니며 기존 검증을 생략해 개선했다고 주장하지 않는다.

## 18.10 및 시험 영향

기존 `.brain-automation/test-profile/summary.json`의 147.96초 특정 정규화 시험에서 fixture DB 읽기 131.03초, 1초 초과 17회 129.49초는 health current/resolution 뷰 비용이다. 이번 7개 후보는 다른 테이블·호출 경로의 별도 비용이며 해당 129.49초를 다시 설명하거나 더하지 않는다. 전체 약 10분 suite를 계측하지 않았으므로 총 시험 시간의 원인 비율·절감폭은 산출할 수 없다. Garmin 원문 재해시는 담당 워커 영역이므로 측정하지 않는다.

실제 빈도·이력 분포가 없는 합성 규모의 비용으로 생산 병목 순위를 확정하지 않는다. 세션·조각·첨부·검색은 제품 경로, 채널은 관리 조회, 반입 anti-join은 daemon 반복 경로다. PG 계약 시험도 같은 함수를 사용하지만 이번 큰 fixture 비용이 기존 작은 시험의 지연 원인이라는 근거는 없다. 별도 티켓은 만들지 않았으며 18.10 범위로 혼합하지 않는다.

## 재현 명령

저장소 루트에서 `sh .brain-automation/performance-deep/sql/reproduce.sh`를 실행한다. 기존 `brain-perf-sql-42ce`가 있으면 Docker가 이름 충돌로 멈추므로 다른 컨테이너를 지우지 않는다. 실행에 필요한 기존 의존성은 `packages/postgres/node_modules/pg`, Node 24, Python 3.14, Docker 및 `postgres:18` 이미지다. 재현 스크립트는 DB 준비 후 `setup.mjs → bench.mjs → extra.mjs → fingerprint-large.mjs → snapshot-exact.mjs`를 각각 공통 lock 아래 실행하고 자기 컨테이너만 제거한다.

## 남은 불확실성과 후속 명령

- 실제 stateful API의 대규모 입력·chunk 생성·새 쓰기·stale/redaction 경쟁은 미측정이다. 이번 Dispatch는 프로젝트 재빌드·소스/시험 계측 수정을 허용하지 않았고, 다른 워커가 바꾼 dist/fixture를 기준 SHA의 API로 가정하지 않았다. 따라서 원문 SQL transaction과 실제 core 순수 함수를 조합한 결과까지로 제한한다. 기준 SHA의 독립 checkout과 빌드 허용이 생기면 먼저 `python3.14 .brain-automation/performance-deep/locked-run.py pnpm build`로 기준 모듈을 마련해야 한다. API 계약 확인 후 대규모 API timing harness를 별도 작성해야 하며 기존 SQL 결과를 전체 API 시간으로 대용할 수 없다.
- 위 후속 checkout에서 격리 DB가 준비되면 `BRAIN_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:54341/postgres python3.14 .brain-automation/performance-deep/locked-run.py pnpm exec vitest run packages/postgres/test/session-concurrency.test.ts packages/postgres/test/conversation-index.test.ts packages/postgres/test/attachment-extraction.test.ts`가 관련 실제 API 계약 확인 명령이다. 이것은 이번에 실행한 시험이나 대규모 성능 측정 명령이 아니다. 공용 54329를 사용하지 않도록 환경값을 반드시 지정한다.
- 운영 분포·실행 빈도·전체 suite 비중은 미확인이다. 운영/계정 접근은 승인 범위 밖이므로 운영 SQL 명령을 실행하지 않았다. 이번 측정을 재검증하는 다음 명령은 저장소 루트의 `sh .brain-automation/performance-deep/sql/reproduce.sh`다. 더 큰 규모·긴 본문·다른 선택도는 진단 파일의 합성 상수를 바꾸는 별도 matrix로 측정할 수 있다.
- cold cache·WAN RTT·운영 RLS/role 준비·daemon 자체 처리/삭제 I/O·legacy 채널 이력·모든 raw-text 입력은 포함하지 않았다. 측정 순서가 동일해 같은 프로세스 JIT/GC와 직전 질의의 cache 영향이 있고, 3회는 정확한 p95 추정치가 아니다. client CPU는 GC 등 프로세스 내 여러 스레드 합계라 wall보다 클 수 있다.
- 공통 lock 대기로 조사 wall 시간은 쿼리 합계보다 길었다. `bench.log`의 약 65.34초, `extra.log`의 약 21.45초, `fingerprint-large.log`의 약 6.92초, `snapshot-exact.log`의 약 14.88초는 각각 lock 획득 후 fixture·warm-up·계측·plan·비교를 모두 포함한 실행 시간이다. 서로 더해 제품 처리 시간으로 주장하지 않는다. 자동 승인 거부나 쿼리 60초 timeout은 없었다.
- 초기 setup에서 상대 import 경로와 schema_migrations 준비 누락, 첫 fixture에서 execution_class 필수값 누락이 있었다. 조사 스크립트만 수정해 회복했고 최종 3단계 모든 query는 오류 없이 완료했다. 원문 SQL·의도적 signature를 편집하지 않았으며 추출 원문·hash·호출자를 보존했다. 이번 추가 결과가 health 18.10의 원래 판정을 뒤집지는 않는다.

## 임시 자원 정리

전용 컨테이너와 그 익명 volume을 2026-11-04 05:06 UTC에 `docker rm -fv brain-perf-sql-42ce`로 제거했고 exit code 0 및 이름 영수증을 확인했다. 실제 제거 영수증과 환경 metadata는 `cleanup.json`에 남겼다. 프로젝트·운영 role·공용 서비스·다른 워커 환경은 수정하지 않았고, 전용 컨테이너 안의 fixture와 일시 인덱스 외에는 DB 자원을 생성하지 않았다. 기존 설치 pg 의존성을 사용했으므로 새 Python venv나 패키지 캐시는 없다. 조사 스크립트·원문·합성 결과·보고서만 이 디렉터리에 보존한다.
