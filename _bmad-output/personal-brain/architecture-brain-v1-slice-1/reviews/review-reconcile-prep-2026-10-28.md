판정: 주요 제품 방향과 최신 사용자 결정은 반영됐지만, 이전·계정 보호·발신·설치의 핵심 보존 계약이 스파인에서 빠져 있어 보완 후 확정해야 한다.

## Critical

없음. 아래 High는 구현 전 계약 보완이 필요하다는 판정이며, 실제 반입이나 데이터 손실을 관찰했다는 뜻은 아니다.

## High

### H1 — importer에도 적용되는 무조건 충돌 무시 규칙
- 위치: AD-8 마지막 삽입 규칙, AD-30·32, Table Contract 건강 계약 표.
- 문제: migration-contract 「importer 계약」 1은 조용한 `ON CONFLICT DO NOTHING` 손실을 금지하지만, AD-8은 멱등 삽입을 이것으로만 한정하고 확장에도 적용한다. 같은 자연키의 다른 본문·값을 동일 데이터로 간주해 누락할 수 있다. AD-32의 데이터셋 키는 서로 다른 후보를 구분하지만 같은 데이터셋 키의 내용 충돌까지 검출하지 않는다. 최신 memlog에 이 금지를 철회한 결정은 없다.
- 수정: 재실행 시 기존 행과 원문 해시·보존 필드를 비교해 동일한 중복만 건너뛰고, 다르면 충돌로 기록해 완료를 막는 importer 예외를 AD-8·32에 명시한다. 덮어쓰기 없이 충돌을 보고하는 fixture를 계약 검증에 연결한다.
- disposition: **autofix** — 기존 보존 조건 복원.

### H2 — 이전 실행·재개·검증 경계 전체가 미착지
- 위치: AD-30~32, Table Contract, Capability map 「건강 데이터·이전」, Deferred.
- 문제: legacy 데이터셋 출처와 불변성만 있고, dataset/table/원래 key→대상 UUID mapping, import batch/version, checkpoint와 동일 batch 재개가 없다. source-local 정수 ID가 다른 DB에서 겹칠 때 run→fetch_error 등의 관계를 어떻게 보존할지도 없다. AD-31의 DDL 버전은 import batch가 아니다. preflight(대상 호환성·소스 지원 버전·예상 변경·충돌), 원본 read-only snapshot, 재캡처와 전환 gate도 빠졌다. epic 14에는 대부분 남아 있으므로 제품 전체에서 삭제된 것은 아니지만 스파인의 계약에는 착지하지 않았다.
- 수정: 이전 계약 절을 추가해 mapping·batch/checkpoint의 영속 소유자를 정하고, 작은 트랜잭션에서 데이터와 진행 기록을 함께 확정하도록 한다. 원본을 업그레이드하지 않고 읽으며, 소스 선택·충돌 처리를 사용자가 정하기 전 실제 반입 금지(C6), 최신 private inventory/해시 확인, 건수·자연키·NULL/단위·FK·본문·파일 관계 검증 후 완료를 고정한다. 구체 DDL은 epic 14로 위임해도 이 불변식은 남긴다.
- disposition: **autofix** — migration-contract와 C6의 기존 조건 복원.

### H3 — 계정 직렬화의 실제 적용 대상과 account block 누락
- 위치: AD-21·29·33, Deferred 「임대 갱신 세부…」.
- 문제: 키별 직렬화의 구현은 epic 12로 위임했지만 계정 키를 명시하지 않았다. AD-7의 세션 잠금이나 동일 kind/target 미완료 키만으로 인증·수집 등 서로 다른 일감의 같은 계정 접근을 막을 수 없다. token/session/MFA 직렬화, account block, pacing·first-call 보호도 스파인에는 없다(입력 integration-boundaries 「가져갈 코드…」「작업 그래프」, R8·R11, epic 16에는 존재).
- 수정: manifest/일감 계약에 출처+계정 단위 직렬화 키를 두고 같은 계정의 인증·수집 경계를 공유하도록 고정한다. 차단 계정은 재인증/해제 전 외부 호출하지 않고 MFA·block을 일반 일시 오류 재시도와 구분하며, 기존 호출 간격·first-call 보호를 재사용한다. 잠금 구현은 epic 12, Garmin 상태 연결은 epic 16으로 위임한다.
- disposition: **autofix** — 잠금 방식 재결정 없이 필수 보호 대상 복원.

### H4 — 공통 채널에서 최초 발신 시도 gate가 사라짐
- 위치: AD-30·35, Table Contract 「채널 발신 요청·이력」, AD-21 오류 재시도.
- 문제: legacy 행의 비발신은 명시됐지만 새 발신 전에 최초 시도를 영속 기록하는 gate와 중복 키는 없다. 입력의 notification/delivery 계약과 memlog의 코드 사실(발신 전 insert gate)은 철회되지 않았다. 일반 일감 재시도를 그대로 적용하면 발신 성공 후 응답/기록 실패에서 중복 전송할 수 있다. epic 15에도 최초 시도 gate와 재시도가 함께 요구되므로 이력 불변만으로는 해소되지 않는다.
- 수정: epic 15가 지킬 발신 전 원자적 gate, 최초 시도와 실제 결과의 분리, 동일 결과의 중복 억제, 결과 불명 상태를 스파인에 고정한다. 불명 시 자동 재발신 허용 여부는 기존 동작을 확인해 명시하고, 일반 retry가 gate를 우회하지 않게 한다.
- disposition: **discuss** — gate 복원은 확정 조건이며, 결과 불명 시 재시도 정책은 별도 명료화 필요.

### H5 — install 스킬의 존재·단계별 사실 보고 계약 미착지
- 위치: AD-19·29·34, AD-5 명령 표, Capability map 「확장」.
- 문제: manifest 인증 단계와 캐시 밖 설치 경로는 있으나, Garmin 미설치 상태에서도 공통 install 스킬을 기본 제공한다는 S13·R17은 본문 규칙에 없다. CLI 지원 확인→설치→사용자 로그인→연결 확인→공통 예약→실제 결과 보고, 부분 성공 보존, 실패/취소/로그인 필요/스케줄러 미준비 구분도 없다. epic 13에는 보존됐지만 스파인의 R17 연결은 구조만 가리킨다.
- 수정: 공통 install 스킬을 `plugin/skills/`의 기본 자산으로 명시하고 CLI 메타 기반 상태 조회·재진입 계약을 AD-19·29에 추가한다. 미지원 명령의 임의 설치 우회 금지, 사용자 인증과 비밀번호/MFA 비기록, 설치/활성화/연결/예약 상태 분리, 성공 단계만 완료 보고, 스케줄러 미준비 시 예약 대기·수동 실행 안내를 고정한다. 명령의 정확한 이름은 epic 13에서 정한다.
- disposition: **autofix** — S13·S14와 integration-boundaries의 확정 조건 복원.

### H6 — 평가 순서는 있으나 각 성공의 즉시 영속화·동일 입력 경계가 없음
- 위치: AD-35, AD-21 일감 의존, Table Contract `analyses`.
- 문제: day→7d→30d→all과 출력 검증은 반영됐지만 각 scope 성공을 즉시 저장한 뒤 다음 scope가 읽는다는 경계가 없다. 「Prevents」의 발신 실패 시 보존만으로는 7d 실패에서 이미 성공한 day가 남는지 보장되지 않는다. integration-boundaries는 정규화 snapshot 혼합 금지도 요구하고, R12·epic 16은 각 성공의 즉시 보존을 요구한다.
- 수정: 입력 snapshot/cutoff와 선행 평가 ID를 일감/분석 provenance로 고정하고, scope별 검증·저장 성공 뒤에만 다음 의존 일감을 풀도록 한다. 후속 평가·그래프·발신 실패가 앞선 평가를 롤백하지 않으며 재시작은 저장된 성공부터 이어가도록 명시한다.
- disposition: **autofix** — 기존 순서·보존 조건의 실행 경계 복원.

## Medium

### M1 — provenance의 최소 보존 필드가 부분적으로만 정의됨
- 위치: AD-13·23·30·32, Table Contract 건강 계약·`analyses`·`file_requests`.
- 문제: source/account, 시각 타입, 정규화 버전, 데이터셋, 원문 바이트/해시, 누락 metadata의 null 처리는 있다. 반면 raw의 scope·library_version, normalize 상태/오류·history_start·원본 연결, 모델·평가 시각·입력 근거, body 필드별 mtime·원본 파일·artifact 관계를 잇는 최소 계약은 없다. 정확한 열 이름을 미루는 것과 이 정보의 보존 자체를 생략하는 것은 다르다.
- 수정: migration-contract 「대상별 보존/검증」을 최소 provenance 계약으로 참조하고, 각 필드가 확장 schema/core 행/파일 메타 중 어디에 남는지 epic 14·16의 필수 산출물로 지정한다. raw view의 공개 필드와 내부 보존 필드는 구분하고, 없는 모델/시각을 추정하지 않는 AD-32는 유지한다.
- disposition: **autofix** — 구체 DDL을 앞당기지 않고 보존 의미 복원.

### M2 — Codex를 포함한 모델 subprocess 정리 범위가 모호함
- 위치: AD-33·35, Structural Seed 모델 CLI 화살표.
- 문제: 확장 일감의 그룹 SIGTERM→유예→SIGKILL·reap은 반영됐다. 그러나 이 규칙의 주어는 확장 일감/자식이고 core 분석 에이전트(Codex 등)에도 그룹 전체 정리가 적용되는지 불명확하다. integration-boundaries와 epic 16이 요구하는 report-codex 정리 계약을 단순 자식 종료로 축소할 수 있다.
- 수정: AD-33의 그룹 감독 규칙을 core 모델 CLI와 그 하위 프로세스에도 적용한다고 명시하고, 취소·호출 실패 시 그룹 정리 및 reap을 확인하도록 한다. 정상 장기 실행은 경과 시간만으로 취소하지 않는 S6를 유지한다.
- disposition: **autofix** — 기존 정리 규칙의 적용 범위 명시.

## Low

별도 발견 없음. 스키마 열 이름·직렬화 구현·정체 판단의 구체 수치를 미룬 사실 자체는 결함으로 세지 않았다.

## 입력별 착지 대조

검토 기준은 세 prep 문서 전문, 스파인, 2026-10-28 시작 이후 memlog, 이니셔티브와 에픽 13~16이다. 아래 **미착지**는 최신 결정에 의한 폐기가 아니라 스파인의 조용한 누락이며, 티켓에만 남은 경우도 구분했다. 권고안·준비 당시 관찰을 새 제품 불변식으로 승격하지 않았다.

| 입력의 핵심 주장 | 판정과 근거 |
| --- | --- |
| S1·S11: 선택 설치, 기존 Python 재사용, 비설치 core에 Python 불필요 | **반영** — AD-29, Stack, Structural Seed. |
| S2·E4·E5: PostgreSQL 하나, 영속 볼륨, 복제 폐기 | **반영** — AD-10·31·34. 테스트 compose와 제품 볼륨도 구분. |
| S3·S12·E2·E3: 모든 후보·기존 분석 보존, 자동 authoritative 선정 금지 | **부분 반영/미착지** — AD-23·32는 파일/출처/불변 보존, source 선택·충돌·완료 gate는 H1·H2. |
| migration: source-local ID mapping, batch/version, checkpoint/resume, preflight | **미착지** — H2. epic 14에는 남아 있으며 AD-31은 대체 계약이 아님. |
| migration: silent conflict loss 금지 | **충돌/미착지** — H1. AD-8의 일반 규칙을 제한할 예외가 없음. |
| integration·migration: raw exact JSON text, 선택적 JSONB 사본 | **반영** — AD-30 `raw_records.body`, Conventions 「DB 타입」. 재직렬화 대체 금지. |
| integration·migration: provenance 전체, NULL/단위/FK·artifact links 검증 | **부분 반영/미착지** — AD-13·23·32, M1·H2. |
| migration: 기존 분석 원문·JSON·파일 보존, 재생성으로 이전 대체 금지 | **반영** — AD-23·30·32의 legacy 분석·불변·null, 파일 bytes/hash. 검증 gate는 H2. |
| S4: DB 사용자 설정 / 기계 config / 비밀 분리 | **반영** — AD-18. `stop_remind`의 config 잔류는 최신 memlog가 조기 반환을 위해 명시한 **의도적 예외**. |
| S5·S6: 독립 작업 병렬, 의존 순서, 장기 실행 보호 | **부분 반영** — AD-7·21·33·35, 갱신·정체 세부는 epic 12로 **명시적 위임**. 같은 계정 적용은 H3, 평가 snapshot·저장은 H6. |
| integration: 계정 직렬화·token/MFA/block·pacing·first-call 보호 | **미착지** — H3. epic 16에는 보존. |
| integration: 평가 순서·개별 즉시 저장·Codex cleanup | **부분 반영/미착지** — 순서는 AD-35, 저장 경계 H6, cleanup 적용 범위 M2. |
| S7: 공통 채널, 향후 양방향·선제 대화 경계 | **반영/명시적 위임** — AD-30·35, Capability map, Deferred의 채널 identity(epic 15); 완전 양방향 출시는 상위 범위 밖. |
| integration·migration: notification 최초 시도 gate, 발신 결과 분리 | **부분 반영/미착지** — legacy 비발신은 Table Contract, 새 발신 gate는 H4. |
| S8·S9: 텍스트 우선, 임베딩 보류, 에이전트 검색·원문·수치 조회 | **반영/위임** — AD-15와 Capability map(epic 17), 벡터는 Deferred. 정확한 API 이름은 입력부터 미정. |
| S10: 준비 때 DB 반입·모델 호출·발신·배포 금지 | **단계 한정** — 준비 작업의 실행 제한이며 최종 제품의 영구 금지가 아님. 이번 리뷰에서도 실행하지 않음. |
| S13·S14: 기본 install 스킬, 실제 단계 보고, 공통 예약 | **부분 반영/미착지** — 공통 데몬·예약과 별도 LaunchAgent 금지는 AD-25·27·29. 스킬/상태·미준비 보고는 H5. |
| integration: 확장 환경은 plugin 버전 캐시 밖 | **반영** — AD-34 `<home>/extensions/<name>/`, AD-19 앱 경로. 위치 자체는 memlog의 ASSUMPTION. |
| integration: Garmin 파생·평가를 확장 DB에 두는 권고 | **후속 결정으로 대체** — AD-29·30·32·35: 정규화/digest/그래프는 확장이 계산, 정제는 core 계약에 DB 직접 INSERT, 새 분석은 core 일감. 초기 memlog의 “Python은 raw만” 방향도 뒤의 ADOPTED 결정이 대체. |
| integration: raw 접근과 단일 migration 소유 | **반영/구체화** — AD-30 읽기 전용 raw view·role/RLS, AD-31 소유자별 버전 및 단일 TS 실행기. |
| migration: Garmin notification/delivery 보존 위치 | **후속 결정으로 구체화** — AD-30·Table Contract의 core legacy 채널 이력, 재발신 없음. |
| 기존 Brain SQLite 및 LLM 호출 0 전제 | **후속 결정으로 대체** — AD-10은 `brain.db` 이전 없이 transcript 재수집, AD-33·35는 일감 안 모델 허용. Garmin 보존 의무까지 삭제한 결정은 아님. |
| E1~E3: 관찰 버전·다섯 DB·349개 파일·없는 evaluation | **관찰 근거 유지** — epic 14의 source inventory에 보존. 스파인이 파일 이전을 허용하므로 평가 테이블만 이전하는 설계는 아님; 전수 검증 연결은 H2·M1. |
| E6·테스트: fake Codex E2E를 실제 모델 품질 증거로 쓰지 않음 | **티켓에 위임** — epic 16 Boundaries·Done when의 사람 확인에 보존. Conventions의 PG 계약 검증과 모델 품질 검증은 별개이며, 스파인이 품질 입증을 주장하지 않아 추가 결함으로 세지 않음. |

권고 조치 순서는 H1·H2(이전 무손실 경계) → H3·H4(외부 계정·발신 안전 경계) → H5·H6·M1·M2다. 제품 방향 재논의 없이 복원할 항목은 autofix로 분류했으며 이 리뷰에서는 원본 문서를 수정하지 않았다.
