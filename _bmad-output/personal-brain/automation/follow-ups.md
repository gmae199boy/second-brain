# 티켓 자동화 후속 항목 모음

중앙 감독자가 최종 결과를 수락하거나 기존 built 증거를 감사할 때 갱신한다. 아래는 이번 자동화에서 확인한 14.8·16.2·16.3·16.4·16.5의 항목이다. 과거 전체 티켓 전수 수집본은 아니다. 원문과 판단 근거는 링크한 계획의 `deferred`, `Review Triage Log`, `Auto Run Result`에 보존한다. 아래 ‘판단 대기’는 원문에 남은 항목이며 현재 코드에서 미해결임을 다시 검증했다는 뜻은 아니다. 해결 여부를 판단할 때 실제 코드·검증을 대조한다.

## 14.8 — blocked

근거: [capture 계획](../tickets/epic-garmin-import/tickets/story-mac-garmin-capture-a-plan.md)의 `blocked_reason`, `operator_actions`, 수락 기준과 결과. 검토 완료 부분 작업은 main에 반영됐으나 실제 반입·전수 검증은 완료되지 않았다.

| 종류 | 항목 | 상태 / 다음 판단 |
| --- | --- | --- |
| 필수 외부 조건 | raw profile 증거 없는 후보의 계정 귀속 확인 | **차단 유지**. 미확인 후보 반입 금지. 계정 근거 확보 후 같은 반입 계약으로 재개하며 보류로 완료 처리하지 않음 |
| 운영 조치 | 원격 marketplace에 plugin version 갱신 반영 | 원문 `operator_actions` 기록. 공개 Git push와 marketplace·설치본 갱신은 별도이므로 실제 반영 증거 확인 필요 |

## 16.2 — built

근거: [인증 계획](../tickets/epic-garmin-runtime/tickets/story-mfa-0-plan.md)의 Review Triage Log low/defer 항목. 구형 계획에 frontmatter `deferred`가 없어도 기록을 빠뜨리지 않는다.

| 종류 | 항목 | 상태 / 다음 판단 |
| --- | --- | --- |
| 보류 / low | garminconnect 0.3.20 SSO가 429 후 내부 로그인 전략을 계속하는 동작 | 판단 대기. 에픽 F4의 라이브러리 내부 retry 보장 범위를 별도 검토; 현재 wrapper 이식 범위와 구별 |

## 16.3 — built

근거: [전수 수집 계획](../tickets/epic-garmin-runtime/tickets/story-15-endpoint-raw-plan.md)의 `deferred` 6건. 후속 리뷰 권고는 최종 false다.

| 종류 | 항목 | 상태 / 다음 판단 |
| --- | --- | --- |
| 가정 / medium | 로그인 `profile_id`와 이전 raw `userProfileId`의 문자열 일치 | 16.9 실계정 검증 대상 |
| 가정 / low | 여러 dataset 중 가장 늦은 checked_at과 기존 값 복사 방식 | 판단 대기. 옛 raw 전이 의미와 불변 보관 계약의 조합 근거 보존 |
| 가정 / low | partial은 `COLLECT_PARTIAL`, retryable=false | 판단 대기. 11:15 예약 진입표가 재시도를 소유한다는 결정 |
| 가정 / low | 설정 거부는 core 키 검사와 worker snapshot 검사 조합; 예약 시각은 manifest 소유 | 판단 대기. 예약 변경은 core 예약 명령 사용 |
| 기존 결함 / medium | import verify 시험의 2초 transaction_timeout 간헐 실패 | 판단 대기. baseline·변경본 반복 재현은 원문에 기록; 현재 재현 여부 확인 후 별도 수정 판단 |
| 시험 환경 / low | 중단된 시험의 전역 Garmin role·시험 DB 잔존 | 판단 대기. 시험 harness 정리 경로 점검 후보; 당시 role 정리와 근본 수정은 구별 |

## 16.4 — built

근거: [정규화 계획](../tickets/epic-garmin-runtime/tickets/story-v2-fixture-plan.md)의 `deferred` 7건, 최종 Auto Run Result 및 연결된 리뷰 원문. 필요한 후속 리뷰는 완료했고 최종 권고는 false다. 과거 결과 절의 true를 현재 미완료 권고로 다시 집계하지 않는다.

| 종류 | 항목 | 상태 / 다음 판단 |
| --- | --- | --- |
| 가정 / medium | 새 정규화 버전을 현재로 쓰려면 core 지원 버전 마이그레이션 필요 | 향후 버전 증가 시 판단; 현재 v8 구현 미완료로 보지 않음 |
| 가정 / medium | 새 raw에서 사라지거나 다른 날로 이동한 논리 키의 과거 current 행 잔존 | 판단 대기. 삭제 표식 등 core 계약 변경 후보 |
| 가정 / low | 권위 v2 발행 뒤 늦게 반입된 dataset은 v2에 포함되지 않음 | 판단 대기. 16.9 반입 후 수집 순서 유지; 순서 확장 시 v3 검토 |
| 가정 / low | A→B→A 재등장 revision은 hash와 fetched_ms 조합 | 판단 대기. 불변 원본 보관 키 충돌 회피의 계약 근거 보존 |
| 이전 이력 / medium | 16.3 평문 steps 키와 canonical 키 관측이 함께 남은 설치·시험 이력 | 배포 전 합성 이력 정리와 소비 계약 별도 판단 |
| 별도 도구 / medium | 옛 Orca helper의 from 메시지·지역 ack 검증 공백 | 도구 소유 작업 후보. 현재 자동화에서 helper 실행·수정하지 않음 |
| 설정 전환 / medium | garmin.timezone 변경 전후 관측 재발행·소비 계약 | 판단 대기. 고정 시간대 이식과 별도의 전환 기능 |

원문에 기록된 극단적 날짜 범위의 1000슬롯 한도 등 잔여 위험은 위 계획의 최종 결과를 함께 읽는다. 이 모음은 후속 실행 승인이나 수락조건 변경을 뜻하지 않는다.

## 16.5 — built

근거: [body·digest 계획](../tickets/epic-garmin-runtime/tickets/story-body-digest-digest-plan.md)의 단일 `deferred`, Review Triage Log와 Auto Run Result. 3회 독립 리뷰와 마지막 수정 확인을 마쳤고 후속 리뷰 권고는 false다. 원문 실행 증거는 중앙 로컬 체크포인트에 보관했다.

| 종류 | 항목 | 상태 / 다음 판단 |
| --- | --- | --- |
| 보류 / medium 미검증 | 대형 raw snapshot 25행 batch가 1.9초 제한을 넘을 가능성 | 미재현. 합성 대형 endpoint로 바이트·시간·timeout을 측정한 뒤 배치 예산 필요성 판단 |
| 보류 / medium 미검증 | 토큰 계정·target 전환과 과거 artifacts 재실행 시 공유 body inbox 귀속 | 기본 단일 계정에서 미재현. 격리된 두 계정 fixture로 실제 오귀속 경로와 owner 계약 필요성 판단 |
| 운영 권고 | immutable raw snapshot 중복 저장 비용과 retention | 현재 장애 근거 없음. 실제 저장량·참조 수명 확인 후 별도 정책 판단 |
| 운영 권고 | 부정 sidecar의 건강값 비노출 거절 진단 | 현 입력 격리는 구현됨. 별도 사용자 진단 기능 필요성 판단 |
| 채택 가정 | 이전 현지 날짜 성공 cutoff 부재 시 전일 현지 11:00 사용 | 기존 운동 창 기본값을 유지. 새 시각 정책이 필요하면 별도 판단 |
| 채택 가정 | 고정 collect digest 파일과 날짜별 최신 day_values/current를 구별 | 기존 API 의미 유지. 과거 artifacts 재실행으로 current를 과거 값으로 되돌리지 않음 |
| 시험 불안정 | 미변경 redaction MAINTAIN 시험의 실패 행수 차이 | 최초 전체 1건 실패 후 수정 없이 해당 파일39건·전체3926건 통과. 원인 미재현; 원문 실패·재실행 로그 보관, 반복 시 별도 조사 |

`operator_actions: []`. 위 미검증 가능성과 운영 권고는 필수 수락조건 미완료를 대체하지 않는다.

## 16.6 — built

근거: [그래프 계획](../tickets/epic-garmin-runtime/tickets/story-png-core-plan.md)의 Review Triage Log와 Auto Run Result. deferred 및 operator_actions는 없다.

| 종류 | 항목 | 상태 / 다음 판단 |
| --- | --- | --- |
| 운영 권고 | 그래프 draw 의미 변경 시 RENDERER_VERSION 증가 | 이후 변경 시 revision 정책에 반영 |
| 잔여 위험 | 렌더 중 강제 종료 시 임시 PNG 잔존, core 완료 순차 대기 | 임시 디렉터리 권한과 실행 시간 관찰 후 필요 시 개선 판단 |
| 성능 권고 | Python 통합 시험의 role 격리·normalize 일감 비용·폰트 캐시 | 시험 시간 실측 근거와 함께 별도 개선 검토 |
| 시험 불안정 | tracer 설치 단계 DB_UNAVAILABLE 1건 | 단독 재실행 및 최종 전체 통과, 원인 미재현; 재발 시 조사 |
| 채택 가정 | 같은 날 같은 revision이면 첫 요청과 metadata 재사용 | 계획의 멱등 계약 근거 유지 |

## 16.7 — built

근거: [수집 알림 계획](../tickets/epic-garmin-runtime/tickets/story-telegram-plan.md)의 deferred·Review Triage Log·Auto Run Result. 후속 리뷰 권고 false이며 전체 회귀의 기존 불안정은 아래와 같이 구별한다.

| 종류 | 항목 | 상태 / 다음 판단 |
| --- | --- | --- |
| 보류 / medium | DB 진입·계정 확인 전 종료는 실행 행이 없어 무알림 | 기존16.2/16.3 결손. 계정 미상 귀속과 실행 행 경계 별도 판단 |
| 운영 조치 | garmin.notice_conversation_id 설정 | 기존 Garmin 봇·채팅 conversation UUID를 설정해야 실제 알림 활성화. 실운영 설정 확인은 전환 작업에서 수행 |
| 잔여 위험 | normalize_failed는 kill·알림 실패 뒤 재발견하지 않음 | 이번 실행 실패만 판정하는 계약의 한계 보존 |
| 잔여 위험 | normalize_days 날짜 실패는 endpoint 실패 건수에 포함되지 않음 | 옛 규칙 유지. 별도 사건 종류 필요성 판단 |
| 시험 불안정 | queue-drain·commit-unknown PG timeout, import-verify EXTENSION_INVALID/UUID 가리기 | 단독 통과 또는 기준 커밋6회 중2회 재현. 전체 회귀 성공으로 표현하지 않음; 실행 증거는 중앙 보관 |
| 시험 환경 | 공유 클러스터 전역 Garmin role 충돌 | 이번 검증은 전용 임시 PG54367 사용 후 정리. 격리 개선은 별도 과제 |

## 16.9 — blocked

근거: [Mac 전환 계획](../tickets/epic-garmin-runtime/tickets/story-mac-garmin-plan.md)의 blocked_reason·operator_actions·Auto Run Result. 마지막 문서 patch의 후속 확인은 완료했고 권고 false다. 운영 전환과 실수집은 전혀 실행하지 않았다.

| 종류 | 항목 | 상태 / 다음 판단 |
| --- | --- | --- |
| 필수 차단 | 14.8 반입·verify 완료 뒤 운영 전환 | 반입0건에서 첫 수집 시 권위v2가 기존 dataset 없이 고정된다. 기존 수집 유지, 반입 전 실수집 금지 |
| 운영 조치 | 반입 계정과 tokenstore profile의 private 일치 확인 | 계정 근거 확보 전 재개 금지; 공개문서에 계정값 기록 금지 |
| 운영 조치 | 채널 conversation 등록과 notice_conversation_id 설정 | 현 설치본은 키 미지원·conversation0. 갱신 후 실제 설정 확인 필요 |
| 운영 조치 | 재개 때 app-ref·version 배포 및 원격 반영 | 중앙 main 반영·marketplace 갱신과 설치본 증거 별도 확인 |
| 재개 검증 | 실행 직전 현재코드 기준 전환 절차 독립 확인 | 이번 정적 리뷰 완료와 실제 운영 재개 시 검증을 구별 |
| 시험 환경 | 전역Garmin role 충돌·새checkout venv 준비·기존 통합 불안정 | JS3933통과/1skip, Python전체 일괄통과 기록 없음. 실패3파일 단독통과 증거 보존; 성공으로 집계하지 않음 |

## 18.1 — built

근거: [분석 tracer 계획](../tickets/epic-health-analysis/tickets/story-tracer-snapshot-day-core-fake-analyses-plan.md)의 deferred·Review Triage Log·Auto Run Result. 독립 리뷰 4개와 후속 3개를 마쳤고 후속 리뷰 권고 false다. 전체 회귀 실패를 통과로 집계하지 않는다.

| 종류 | 항목 | 상태 / 다음 판단 |
| --- | --- | --- |
| 보류 / 기존 결함 | import-verify 변조 감지 시험 실패 | 기준 커밋에서도 2회 재현. 별도 원인 조사 필요 |
| 보류 / 시험 격리 | 중단된 확장 시험이 전역 brain_ext_garmin role을 남김 | 전용 임시 PG에서 검증 후 정리. 다른 작업의 role 삭제 금지 |
| 보류 / 저장소 위생 | 추적 pyc가 시험 실행으로 변경됨 | 생성 파일 추적 정책 별도 판단 |
| 채택 가정 | codex만 허용, 기본 모델·effort high·20분 timeout | 최소 tracer 계약. skill 발견·다중 adapter·진단은18.4/18.9에서 판단 |
| 잔여 위험 | 실패 attempt usage를 ABI v1 error에 기록할 칸 없음 |18.4의 모델 실행 계약에서 다룸 |
| 시험 불안정 / 사전 조건 | JS PG 연결 timeout, 새 checkout Garmin venv 부재 | JS 실패 파일159건 단독 통과, venv 설치 뒤 해당 Python 통과. 기존 import-verify 실패는 남아 전체 성공 아님 |
| 검증 데이터 격리 | 초기 fixture가 실제 하네스 transcript를 격리 시험 DB에 수집 | fixture 수정 및 소유 DB·임시 홈 제거 확인. 커밋·보고서에 실내용 없음 |

`operator_actions: []`. snapshot은18.2 전까지 합성 바이트이며 bundle id는 snapshot 행에 보존한다. 원문 로그·리뷰·영수증은 중앙 로컬 체크포인트와 보존한 워크트리에 있다.

## 18.2 — built

근거: [입력 snapshot 계획](../tickets/epic-health-analysis/tickets/story-snapshot-fixture-snapshot-export-report-input-plan.md)의 Design Notes·Review Triage Log·Auto Run Result. 독립 리뷰4개와 후속3개, 후속 권고 false, deferred 없음.

| 종류 | 항목 | 상태 / 다음 판단 |
| --- | --- | --- |
| 채택 가정 / 호환 차이 | all 월별 hrv_avg·spo2_avg·spo2_min·resp_avg는 null | 원문의 허용 집계 조건과0023 catalog를 우선한 명시적 차이. 옛 숫자 평균과 같은 값이라고 주장하지 않으며 인수 시 확인 |
| 채택 가정 | body는 collect target dataset, 선행은 legacy Garmin과 같은 account core 입력 | tracer 제외; 같은 날짜 후보는 core·revision·생성 시각·id 순 |
| 채택 가정 | profile은 snapshot 바이트, 그래프는 manifest 참조 | profile core 파일 등록 없음. digest는 artifacts 원문 사용 |
| 시험 불안정 / 미확정 | 전체 Python75/76, UTF-16 NUL 반입 시험1건 EXTENSION_INVALID | 단독2회 모두5/5 통과. 기준 커밋 재현 미확인이므로 기존 결함 확정 아님. 전체 회귀 성공으로 집계하지 않음 |
| 잔여 위험 / low reject | TEXT 지표의 value_text_raw NUL 원문 미복원 | 표시값의 대체 문자가 옛 원문과 다를 수 있음. 원본 바이트는 보존, 차이와 리뷰 거절 근거 유지 |
| 후속 연결 | 네 scope 실행의 snapshot 소비·sameGraph 전달, 모델 export 가리기 |18.3·18.4 범위.18.1 tracer는 기존 export.json 경로 유지 |
| 시험 환경 | 오라클 jsonschema4.26.0 캐시·Garmin venv·전용 PG | 전역 role 잔존은 소유 PG 재생성으로 해소, 다른 작업 자원 변경 없음 |

전체 JS3985통과·1skip, 입력 단위12·비교/계약15 통과. `operator_actions: []`. 원문·영수증·리뷰는 보존한 워크트리와 중앙 로컬 체크포인트에 보관한다. 다음 실행은 사용자 지정18.10이며18.3보다 앞선다.

## 18.10 — dropped / Garmin 확장 재설계로 대체

2026-11-05 사용자 결정. 근거: [처분표](../architecture-brain-v1-slice-1/garmin-extension-redesign-disposition.md), [재설계 연구](../research-garmin-extension-redesign-2026-11-05/research-garmin-extension-redesign-2026-11-05.md), [18.10 계획](../tickets/epic-health-analysis/tickets/story-snapshot-plan.md). 성능 구현은 미채택 WIP이며 main에 병합하지 않는다. 성능 조건·마무리 전체 회귀·독립 구현 리뷰 완료로 집계하지 않는다.

| 종류 | 항목 | 상태 / 다음 판단 |
| --- | --- | --- |
| 사용자 결정 |18.3~18.10·14.8·16.9·19.7 dropped | 미완료를 built로 바꾼 것이 아니라 새 epic20·21로 대체. 옛 완료·차단 증거는 이력 보존 |
| 후속 이행 |20.6에서 옛 core 건강·분석·epic16 경로 정리 | 새 forward migration만 사용. 대화 수집·FileStore·file_requests·채널 기록·공통 확장/예약 기반 보존 |
| 보존 / 미채택 |18.10 perf-wip와 baseline Orca 워크트리 | 자동 병합·제거 금지. 기존 성능 측정은 진단 증거이며 새 인수 근거 아님 |
| 운영 환경 |brain-1810-perf·brain-1810-test 전용 컨테이너 잔존 보고 | 이번 문서 반영에서는 삭제하지 않음. 후속 시험은 소유가 명확한 별도 자원 사용 |
| 운영 이행 |이 Mac 설치본 schema27 보고 |20.6에서 합성 업그레이드·신규 설치 보존 검증, 실제 운영 전환은21.7의 계정 확인 gate 준수 |
| 명세 보강 |epic19 일부 entry는 refine=true | 폐기 경로 전제는 착수 전 새 생산 경로 기준 재정제. 옛 문구만으로 시작하지 않음 |

이전14.8·16.9 차단 및18.1·18.2 잔여 위험 기록은 과거 계약의 증거다. 새 설계의 수락조건 충족·실계정 gate 해제로 해석하지 않는다.

## 20.6 — built

근거: [옛 core Garmin 정리 계획](../tickets/epic-extension-platform/tickets/story-core-garmin-epic-16-plan.md)의 deferred·Review Triage Log·Auto Run Result. 4렌즈 독립 리뷰와 후속4렌즈 완료, 후속 권고 false. core0031·Garmin0013 forward migration만 추가했으며 과거 migration은 보존했다.

| 종류 | 항목 | 상태 / 다음 판단 |
| --- | --- | --- |
| 보류 / medium 미확인 | manifest에서 빠진 옛 Garmin 예약의 설치 갱신 시 정리 |20.3 예약 재설계와21.7 설치본 전환에서 확인. 운영 예약은 이번 티켓에서 변경하지 않음 |
| 운영 조치 |설치본schema27에서0031·0013 적용·보존 검증 |21.7에서 수행. 합성 v30→31·v12→13 건수/해시·권한 시험은 통과 |
| 채택 판단 |옛 health_analysis work 행은 보존 |미등록 kind는 claim하지 않음. 공용 work 기록 삭제 금지 유지 |
| 채택 판단 |확장 verify는 core FileStore 바이트·legacy 채널 내용까지 대조하지 않음 |core 검증 runtime 제거·확장 권한 경계에 따름. 공용 보존은 core 시험, 새 전체 반입 검증은21.2 |
| 호환 위험 |importer v3가 v2 checkpoint를 거부 |운영 checkpoint 없음 전제,21.2 새 반입 경로에서 확인 |
| 시험 환경 |공유PG에 다른 작업의 brain_ext_garmin role 잔존 |삭제하지 않음. 후속 티켓·통합 gate는 소유가 명확한 격리PG 사용 |
| 시험 결과 |병렬 전체 시험은 매번 다른 연결/시간초과 실패, 단독 통과 |기준 export에서도 재현. 단일worker 전체3897통과/1skip·Python32통과. 병렬 전체 성공으로 표현하지 않음 |
| 통합 검증 |Garmin 전체 회귀 gate |사용자 새 규칙대로21.6 뒤21.7 전 pending. 이번 시험 결과로 gate를 완료 처리하지 않음 |

티켓·baseline Orca 자원과 로컬 실행 증거는 보존한다. 전용 brain-206-test와 /tmp 기준 export는 남아 있다는 보고를 기록하며 자동 제거하지 않는다.

## 20.1 — built / 최종 시험 실행은21.8 이관

근거: [확장 읽기 명령 계획](../tickets/epic-extension-platform/tickets/story-tracer-testext-brain-ext-testext-cmd-mcp-plan.md)의 Implementation Notes·Review Triage Log·Auto Run Result. 독립4렌즈×5회, 마지막 발견0·후속 권고false·deferred없음. 최종 build·typecheck 종료0이며 최종 코드의 시험은 사용자 지시로 미실행이다.

| 종류 | 항목 | 상태 / 다음 판단 |
| --- | --- | --- |
| 필수 실행 인계 |CLI/MCP/guide·출력 가림/재검증·프로세스 정리·PG 취소·schema/ref/deep/time-control 시험 |21.8 전용DB 실행 목록에 포함. 과거 round2~4 실행을 최종 round6 통과로 소급하지 않음 |
| 채택 가정 |명령은 registry·활성 상태·설치manifest에서 동적으로 도출 |별도 명령 영속 테이블 없음. MCP kebab→underscore는AD-37 준수 |
| 운영 경계 |disable은 실행 중 읽기 명령의 확장 잠금 해제를 기다릴 수 있음 |현재 계약 기록. 새 timeout/운영 정책 필요 시 별도 판단 |
| 범위 경계 |제거는 registry/manifest 부재 상태로 판정 |새 uninstall 제품 기능을 추가하지 않음 |
| 시험 의존 |Python 공유 fixture가 배포 runtime schema adapter를 사용 |21.8에서 배포 fixture·정상 인접 schema·거부 사례 실행 확인 |
| 실행 이력 |round4 실행 중 정책 메시지가 턴 종료 후 도착 |당시 실행 종료 사실 보존. 수신 뒤 round5/6은 추가 시험 없음 |

알려진 미해결 기능결함0 보고이며 통합 실행 검증은 아직 미완료다. 공용PG·운영 설치는 변경하지 않았다. 원문 리뷰20개·triage·영수증은 보존 워크트리와 중앙 로컬 archive에 있다.

## 20.2 — built / self 전달 보완 수락, 시험21.8 이관

근거: [사용자 키 계획](../tickets/epic-extension-platform/tickets/story-user-id-runtime-self-plan.md)의 Review Triage Log·Auto Run Result와 수락 보완 기록. 독립4렌즈×3회 및 증분4렌즈 후속 완료. 최종 build·typecheck 종료0, 시험 실행은21.8로 이관·미실행이다.

| 종류 | 항목 | 상태 / 다음 판단 |
| --- | --- | --- |
| 해결 / 필수 범위 |core 감독 자식 실행 입력 self 전달 |중앙이 E20-2·AD-40의 일감 범위로 판정.769fe2b에서 BRAIN_USER_ID 주입 후 최종 spec 검증·보호snapshot 같은self·시험코드 보완. 열린deferred0 |
| 필수 시험 인계 |schema31→32 backfill·값/공용 기억 보존·scope/유일성·self부재·재설치·core자식 ID |21.8에서 실행. 설정 NULL global과 대화user_id NOT NULL을 구별하고 시도별 snapshot/ABI ID 일치 확인 |
| 채택 가정 |ABI env BRAIN_USER_ID는 선택, 있으면 UUID |실제 Runtime은 모든 감독 실행에 self 주입. 기존 저수준 ABI 소비자 호환 유지, 인증/RLS 추가 아님 |
| 잔여 위험 / low reject |user/global 조회 두 statement 사이 동시 갱신으로 값 혼합 |현 단일self 범위에서 보존. 독립 읽기 snapshot 필요성은 별도 판단 |
| 잔여 위험 / low reject |공통 행만 있는 user 키의 default 설치 시 유효 값 변경 |직접 SQL로 만든 상태 전제. 기존 사용자 행은 덮지 않음 |
| 잔여 위험 / low reject |멱등 기본값 삽입 루프의 취소 확인 부재 |현 계약 기록, 취소 정책 확장은 별도 판단 |

설치본·운영DB는 변경하지 않았다. 새키 사용자 해석과 설정·대화 이행은 이 티켓, 예약 user_id·회차 이행은20.3이다. 원문 증거와 v1/v2 보고는 보존 워크트리 및 중앙 archive에 있다.

## 20.3 — built / 대량 회차 보완 수락, 시험21.8 이관

근거: [cron·once 계획](../tickets/epic-extension-platform/tickets/story-crononce-plan.md)의 deferred·Review Triage Log·중앙 수락 보완·Auto Run Result. 독립4렌즈2회와 수락 보완 증분2렌즈 후속, 후속 권고 false. 최종 build·typecheck 종료0. 시험 실행은21.8로 이관·미실행이다.

| 종류 | 항목 | 상태 / 다음 판단 |
| --- | --- | --- |
| 해결 / 필수 범위 |10,000 초과 누락 회차 절단 |a04e5c4에서 제거. 발화1,000개·tick당10배치와 next_run_at CAS 사슬로 이어 기록, 청구1,000개·재개 이어가기·재청구 claimed 초기화.12,006회차 세 정책·상한·연속성 시험 코드는21.8 실행 대상 |
| 보류 / medium 기존 동작 |성공 후 새 회차로 재개한 일감의 attempts 누적 |기준5510d15도 같은 동작. 오래 실행되는 반복 일감의 첫 일시 실패가 재시도 한도에 걸릴 수 있음. 재시도 예산 정책은 별도 판단 |
| 필수 시험 인계 |cron/once·DST·회차 수명·대량 정책·이행/중복·재설치·자식ABI |21.8 전용PG에서 새·기존 시험 실행. schedule-cron·schedule-migration-tick·schedule-occurrences·Store 공통계약(core/supervised)·work-store·ext-install(-resume)·daemon·Python 공유 manifest/ABI 포함 |
| 운영 조치 |설치본0033 적용·manifest에서 빠진 옛 예약 정리 |21.7에서 실제 확인.20.6 후속 처리와 시험코드는 이번 티켓에 반영했으나 운영 예약·설치본 변경 및 시험 실행은 하지 않음 |
| 채택 가정 |영구 실패 회차failed·예약update·기본키·다중예약 청구 |원문 계획에 판단 근거 보존. 비daily 이행키는id접미, 기본 manifest는반복cron/legacy local_time·once는CLI에서 등록 |
| 잔여 위험 / low reject |ABI 날짜 달력 검사·삭제된 예약의 옛 날짜범위·특수 과거DST·키충돌·조회상 회차null |계획 triage의 각 기각 근거 보존. 발생 근거가 생기면 별도 판단;10,000절단 기각은 위 해결 처분으로 대체 |

원문 보고·리뷰·영수증은 보존 워크트리와 중앙 로컬 archive에 있다. 사용자가 인수하기 전 done으로 올리지 않는다.

## 20.4 — built / 패키지 설치·직렬화, 시험21.8 이관

근거: [패키지 설치 계획](../tickets/epic-extension-platform/tickets/story-testext-core-plan.md)의 Review Triage Log·Auto Run Result. 구현 adea434, release 3501560. 독립 R1/R2 thorough4렌즈, R3증분3·R4증분2 후속 및 마지막 시험코드 보완 완료. deferred0, 후속 리뷰 권고 false. build/typecheck 종료0이며 모든 시험 실행은21.8로 이관·미실행이다.

| 종류 | 항목 | 상태 / 다음 판단 |
| --- | --- | --- |
| 채택 명세 / 가용성 제약 | A1: 불명 잔존 설치 잠금 자동 회수 금지 | 나이·부모PID사망만으로 회수하지 않음. 새 설치 진입 차단·모든 이전 쓰기 자식 종료 확인 후 정확한 잔존 잠금만 명시 복구. DB gate/journal 임의 삭제 금지 |
| 채택 명세 | core 갱신의 기존 확장 migration에도 quiesce 적용 | 대상core 호환 재확인·새 진입 차단·안전 정산·자기 정지만 재개. legacy gate부재/불명 상태는 관련 변경 전 거부 |
| 운영 조치 / 자동갱신 제약 | 미추적 과거 자식 가능성이 있는 cross-commit offline 확인 | 잠금 아래 home·이전/목표commit·시도nonce에 결합된 운영자 확인 필요. 기계적 종료증명 아님. hook/JSON/비대화형/yes 대체 불가. 실제 이 Mac 전환21.7에서 준비하며 legacy schema 안전거부 시 지원 가능한 전환 경로부터 확인 |
| 필수 시험 인계 | 실제 CLI·동시bootstrap/package·전환 중단·gate/claim/fire·감독 자식·공용 보존 |21.8에서 새·기존 시험 순차 실행. app승격/재개·TTY·offline 확인 수명·33→34→35·권한·TS/Python ABI·fixture digest/ref/version 포함. 계획 Verification 및 최종 보고에 목록/준비/정리 명령 보존 |
| release 기록 | core plugin0.1.16은 이전 구현adea434를 참조 | release3501560과 분리. 운영 설치·계정·예약 변경 없음. runtime/시험harness 실패 가능성은21.8 확인 |

원문·로그·ready/depth1 영수증은 보존 워크트리와 중앙 로컬 archive에 있다. 사용자 인수 전 done으로 올리지 않는다.

## 20.5 — built / snapshot 취득 중복 정리, 시험21.8 이관

근거: [정리 계획](../tickets/epic-extension-platform/tickets/story-refactor-sweep-plan.md)의 Design Notes·Review Triage Log·Auto Run Result.19cef9d에서 core 연결 확인/읽기 명령의 scope설정·비밀·snapshot 취득을 통합했다. R1 독립4렌즈 및 R2 후속verification0건, 단언4묶음 보완, deferred0·후속권고false. 최종 build/typecheck/diffcheck 종료0.

| 종류 | 항목 | 상태 / 다음 판단 |
| --- | --- | --- |
| 채택 범위 | 두 core 소비자의 snapshot 취득만 통합 | self·stage/requiredKeys·capability·IO순서·오류/설치실패기록 유지. Runtime auth/daemon의 다른 경계는 기존 순수 생성기 유지 |
| 필수 시험 인계 | core snapshot/extensions/settings 및 CLI 설치/명령·감독 경로 | 모든 시험 실행21.8 이관·미실행. 선행20.6·20.1~4 시험도 계획 Verification 목록에 포함 |
| 보존된 정책 |20.3 attempts누적,20.4 A1/quiesce/legacy 안전거부/offline확인 | 이 티켓에서 변경하지 않음. 기존 후속 판단·21.7 운영 절차 유지 |
| 실행 증거 | 최초 보고 파일 누락 후 보완 수신 | stdin 인코딩 오류 뒤 전송만 실행된 원인 기록. 실제 최종 보고·로그·R1/R2·ready/depth1을 중앙 로컬 archive와 워크트리에 보존 |

신규 운영 조치 없음. 시험/harness runtime 위험은21.8 확인이며 운영 자원 변경 없음. 에픽20은 최신 시험 유예 범위의 built로 전환하며 인수/전체 시험 통과로 표현하지 않는다.

## 21.2 — built / Garmin native PG tracer, 시험21.8 이관

근거: [native tracer 계획](../tickets/epic-garmin-extension/tickets/story-tracer-garmin-pg-garmin-sqlite-report-input-sqlite-plan.md)의 Design Notes·Review Triage Log·Auto Run Result. f07d761에 고정원본 src·PG store·0014 native19표·계정연결·평가revision·재개복사/파일관계·합성fixture와독립SQLite oracle을 반영했다. full/thorough4렌즈+source/verification 후속3라운드(10리뷰), 마지막추가발견0·deferred0·후속권고false. build/typecheck/Python정적컴파일 종료0이며 모든 시험 실행은21.8로 이관·미실행이다.

| 종류 | 항목 | 상태 / 다음 판단 |
| --- | --- | --- |
| 필수 시험 인계 | native19표·copy/verify·SQLite↔PG report_input·정규화동등성·파일관계·revision경쟁/trigger·계정한정/RR·중단복구·공용기억보존 |21.8에서 새garmin-native/garmin-unit과 기존Garmin시험을 모두 실행. 계획 Verification 및 extensions/garmin/README.md에격리전제/명령/기대값/정리명령 보존 |
| 실행 위험 | DDL/실권한·wheel설치·PG동시성/시간제한·oracle 결과 미확정 |컴파일/정적리뷰를 실행통과로 해석하지 않음. 미실행/미해결이면21.8 built 및21.7시작금지 |
| 채택 경계 | 고정원본src/store이식과실제운영연결 분리 |수집·분석·예약/채널/플러그인 실제연결은21.3~21.5. 원본계산/프롬프트/schema 의미유지. 과거activity_recovery는원본0012제거표로native대상아니며원형보존 |
| 계정/파일 정책 | profile+self+명시timezone, 불명귀속 금지 |미확인은원형보존후native차단. v1미귀속파일은중립요청/장부로보존하되계정/평가관계추정금지. native새계정tokenstore_ref는NULL이며후속운영연결필요 |
| 기존 회귀 보존 | legacy/TEXT시험의test-only preservation adapter |현재보존primitives로이전계약도검사. 기존시험삭제/skip아님. 새native및보존시험모두21.8실행 |

공용계정락·snapshot별rowid provenance와원자적선택순서게시·durablepending/staging publish·SQLite 정수/REAL 경계는 독립후속리뷰로 보완했다. 운영설치/DB/계정/건강자료/모델/예약·원본checkout변경없음. 원문·로그·ready/depth1은보존워크트리와중앙로컬archive에있다.

## 21.3 — built / 감독 수집·정규화, 시험21.8 이관

근거: [수집·정규화 계획](../tickets/epic-garmin-extension/tickets/story-collectnormalize-pg-garmin-fixture-raw-plan.md)의 Design Notes·Review Triage Log·Auto Run Result.468bf5a에서collect일감/runtime self·settings·connection·attempt,계정/tokenstore락,credential복구,PG raw관찰/current와계산소비를연결했다. full/thorough4렌즈+R2/R3독립2렌즈후속,23행중22수정·1기각,마지막추가결함0·deferred0·후속권고false. build/typecheck/Python정적컴파일 종료0. 모든시험실행은21.8로이관·미실행이다.

| 종류 | 항목 | 상태 / 다음 판단 |
| --- | --- | --- |
| 운영 조치 |21.7 선택self/connection·확인profile·전용tokenstore 귀속증거 |보호0700디렉터리/0600 brain-account-binding.json 준비. 필드/지문계약은 extensions/garmin/README.md. 로컬운영자명시확인이며Garmin서명아님. 임의token수동교체/불명장부는보존·거부. 지금실계정/토큰접근없음 |
| 채택 저장계약 |원형raw_response불변+0015관찰장부/current분리 |원본data→NULL/동일checked·변경data의미를논리현재값으로보존. 기존원형손실/덮어쓰기아님. normalize/report reader가current소비 |
| 필수 시험 인계 |독립SQLite동등성·감독entry·인증보호·누락만재개·fence/락경합·credential각게시/부분삭제중단·요약실정산 |21.8에서새garmin-collect/기존native/unit/upgrade·supervisorABI·분류시험포함전체순차실행. 계획Verification/README의소유PG/role/home·fake요청장부·준비/정리명령준수 |
| 채택 core경계 |고정status/runs/errors의범용안전요약 |정확한키·유한상태·safeinteger필터로result_summary저장. 새Garmin명칭/지표/schema/reader core추가없음 |
| 잔여 위험 |DDL/실권한·수치동등성·동시성/프로세스정리·crash/fsync·harness시간제한 |실행결과는21.8확정. 원본fetched millisecond변경추적한계유지. 다중사용자전체격리완성주장없음 |

운영설치/DB/계정/API/모델/예약변경없음.원문·로그·ready/depth1은보존워크트리와중앙로컬archive에있다. 새·기존시험미실행/미해결이면21.8 built 및21.7시작금지다.

## 21.4 — built / 감독 분석·체성분·scope재개, 시험21.8 이관

근거: [분석 이식 계획](../tickets/epic-garmin-extension/tickets/story-report-day7d30dall-plan.md)의 Design Notes·Review Triage Log·Auto Run Result.329aff7에서report/report-regenerate·analysis설정·계정runtime·scope별revision저장/재개·모델후손정리·호스트bodyIPC를연결했다. R1독립4렌즈·R2~R5후속·34행개별처분(29수정·5기각), 마지막추가발견0·deferred0·후속권고false. build/typecheck/Python정적컴파일/fake구문/diffcheck 종료0. 모든시험실행은21.8로이관·미실행이다.

| 종류 | 항목 | 상태 / 다음 판단 |
| --- | --- | --- |
| 채택 원본 의미 |저장성공scope재개·완성당일skip·명시재생성전체시도 |실패scope뒤에도가능한scope계속. 재생성은새revision이며별도원자세대재개추가없음 |
| 채택 원본 의미 |명시reject는unreadable,실행/검증실패미처리사진은pending |이미성공한측정rollback보장추가없음. 파일공개뒤중단/재시도시험코드포함 |
| 원본 한계 / 운영 검토 |daily skill의KST서술·실모델/OCR품질 |원본프롬프트의미보존으로KST문구유지. 다른timezone서술한계와실모델품질은fake/정적검증으로입증하지않음 |
| 필수 시험 인계 |감독7d확정뒤kill/restart·30d/all만재개·revision/최신view·입력/digest·모델대기transaction0·attemptfence/retry·TERM무시후손·bodyIPC/실PG확정·파일중단 |21.8에서새report/native/unit및기존전체순차실행. 기준SHA·소유PG/role/home·fakeCLI·명령/종료코드/로그/실패별수정/재검증필수 |
| 실행 환경 검증 |설치모델실행경로·workspace sandbox의skill/body파일요청허용 |21.8소유시험환경에서실모델호출없이계약확인. 실제sandbox동작미확인상태를통과로표현하지않음 |
| 후속 연결 |결과file_requests·발송/cron/플러그인21.5,운영전환21.7 |분석model필수설정과21.3credential운영확인준비. 이번티켓실계정/모델/운영변경없음 |

모델후손은감독그룹상속·scope경계정리/불명시중단,DB읽기는짧은RR·확정은짧은fence다. 원문리뷰는계획옆reviews폴더,전체로그/영수증은보존워크트리와중앙로컬archive에있다. 새·기존시험미실행/미해결이면21.8 built 및21.7시작금지다.

## 21.5 — built / 예약·조회·발신·플러그인, 시험21.8 이관

근거: [core 연결 계획](../tickets/epic-garmin-extension/tickets/story-core-cron-core-brain-ext-garmin-second-brain-garmin-plan.md)의 deferred·Review Triage Log·Auto Run Result.구현ca8b174/release7c9e572에서조회3종·11:00/11:30cron/같은날성공의존·파일/채널게시·Garmin plugin을연결했다. R1독립4렌즈·R2~R5후속,24행중23수정·1보류,필수미완료0·후속권고false. build/typecheck/Python정적컴파일/shell구문/diffcheck 종료0. 모든시험실행은21.8이관·미실행이다.

| 종류 | 항목 | 상태 / 다음 판단 |
| --- | --- | --- |
| 보류 / medium 기존 한계 |BH04 Markdown의날짜/그래프상대링크가문서단독소비시해석되지않음 |원본_assemble/TelegramReportSink도같은문서+별도사진전달. file_id관계는추가하되새URL/압축/문서소비UX는별도판단. 원문계획frontmatter location/evidence보존 |
| 필수 시험 인계 |수집성공/정규화완료의존·중단같은work복구·cron회계/재설치·조회NULL40/20/운동/0건·가리기·파일/채널의미키·disable/enable·plugin |21.8전용소유PG/role/home·fakeGarmin/Codex/localhostTelegram로새garmin-core/query와기존전체순차실행. 계획Verification/README의명령·관찰·정리준수 |
| 운영 조치21.7 |self/connection·보호tokenstore/binding·시간대·analysis모델/agent/effort/timeout·자기채널대화 |실marketplace설치·옛예약해제·운영전환은21.7만수행. 사용자예약변경/삭제표식·회계/평가/core파일보존 |
| 채택 연결 |범용target_setting·날짜/user/target 선행성공·채널공개중립SQL |partial/blocked/auth/정규화실패/pending은예약성공아님. 성공run/work날짜근거원자기록·같은work복구·타work도용거부. 현재attempt/출처/self대화/동일target완료파일검증 |
| release 증거 |second-brain-garmin0.1.1/ref ca8b174 |7c9e572의이전구현commit참조·같은release의package.plugin_version/digest동기화. source/SQL변경없음 |
| 잔여 위험 |PG원자성/경쟁·실권한·비동기파일/채널·oracle/전체회귀 |실행결과21.8확정. 다중사용자보안완성주장없음. 미실행/미해결이면21.8 built/21.7시작금지 |

운영/실계정/모델변경없음.원문·로그·ready/depth1은보존워크트리와중앙로컬archive에있다. 성공scope/revision·후손정리/bodyIPC·대기transaction0·20.4잠금/quiesce/legacy안전거부제약을유지한다.

## 21.6 — built / 감독입력 중복정리, 시험21.8 이관

근거: [정리 계획](../tickets/epic-garmin-extension/tickets/story-refactor-sweep-plan.md)의 Design Notes·Review Triage Log·Auto Run Result.4be310a구현/58a64f6release/fc3cdfe문서정정으로collect/report의감독봉투·typed설정검증을공통화했다. 독립thorough4렌즈·BH1~7보완·후속verification해결/추가0,신규deferred0·후속권고false. build/typecheck/Python정적컴파일 종료0. 모든시험실행은21.8이관·미실행이다.

| 종류 | 항목 | 상태 / 다음 판단 |
| --- | --- | --- |
| 채택 정리경계 |소비자별검사순서/중복키비대칭·필수값/Config/공개예외보존 |collect의report_runtime의존제거·순수공통모듈. 10계약시험메서드의관찰목표는입력경계이며전체기능실행증거아님 |
| 필수 시험 인계 |20.6·20.1~20.5·21.2~21.6 새·기존전체회귀 |21.8전용소유PG/role/home·fakeGarmin/Codex/로컬Telegram로 pnpm test→pnpm test:python 순차실행·실패별수정/관련재검증. 미실행/미해결이면21.8 built/21.7시작금지 |
| release 증거 |Garmin plugin0.1.2/ref4be310a·package목록/digest |이전구현commit참조·같은release의version/identity/digest갱신. 제품정리와배포사본동기화 |
| 기존 제약 보존 |21.5 BH04상대링크·credential운영확인·KST/reject/pending·A1/legacy/offline·attempts정책 |새기능/보안/소비UX추가없음. 21.7운영조치그대로유지 |

신규운영조치/실계정/모델/운영변경없음. 원문·로그·ready/depth1은보존워크트리와중앙로컬archive에있다. PG권한/동시성·oracle·crash/fsync·프로세스/sandbox·파일/채널·전체시험실제결과는21.8확정이며인수완료주장없음.

## 21.8 — built / 통합 시험 실행·수정 완료

근거: [통합 시험 계획](../tickets/epic-garmin-extension/tickets/story-garmin-db-plan.md),[공개 실행 증거](../tickets/epic-garmin-extension/tickets/story-garmin-db-evidence.md) 및최종원시/독립runtime감사.최종62f3687의제품·시험바이트에서정확전용환경실행20261105T234612Z-40b825f99136의 pnpm test→pnpm test:python 순차각exit0을중앙이원시로그로대조했다. T186파일/4204통과·기존skip1, P15파일/66통과·skip0. 조건부hook사례는P START/PASS로실행확인.필수runtime공백0·미해결실패0·후속권고false·deferred0.중앙재계산원시/분석해시147개불일치0.

| 종류 | 항목 | 상태 / 다음 판단 |
| --- | --- | --- |
| 해결 / 실행 gate |20.6·20.1~5·21.2~6 새·기존시험실행·실패처분 |최초121실패및이후후보/오인증실패원인·관련재검증·최종전체연결보존.244 unittest호출(240고유)/capture13개각ok,원래185T/15P대비누락0(격리시험T1추가) |
| 증거 사고 / 제한수용 |최초T raw/start·최초collection raw/정확조회시각미복구 |기존85,397byte텍스트/121실패ID·원래행/출처시각/P원시동일사본을역사추적에만수용. 원시동일성복구나소급통과아님.사고/정정색인·중앙사본보존.최종실행증거는고유ID/충돌거부로보호 |
| 환경/자원 |고유PG fixture·실TCP인증·정확ID정리 |최종173fixture생성/제거일치·정확ID모두부재.전용공용PG도정확ID제거/부재확인.기존공유/운영자원변경없음 |
| 잔여 경고 |sourcemap/jsonschema deprecation·mock SQLite Connection ResourceWarning |원시보존.종료0/미처리오류0은경고0의미아님 |
| 제품 수정 |scoped $id/$ref·Python준비순서/재개·relocatable설치·환경격리·정리오류/재시도 |thorough4렌즈2회·필요후속·최종전체회귀확인.적용migration/고정oracle불변.불필요timeout증가/skip/단언축소로통과처리없음 |
| 운영 전제21.7 |credential/profile/self연결·모델설정·실제배포/옛예약전환·A1/legacy/offline 제약 |합성/fake시험통과가실계정귀속/실모델/OCR/운영인수완료는아님.이전운영조치와BH04상대링크한계유지 |

core0.1.17/Garmin0.1.4 ref는이전구현472caa7,확장1.2.1/package85파일정합.실제운영변경없음.상세로그/소유자원/실패장부/독립감사는워크트리와보호된중앙로컬archive에보존한다.21.7 gate는21.8원격main반영을확인한뒤충족한다.

## 21.7 운영 준비 — legacy 설치 전환 결함으로 차단,21.9 분리

근거:21.7 지휘자의 읽기전용 진단과 [21.9 버그](../tickets/epic-garmin-extension/tickets/bug-legacy-extension-core-upgrade.md),에픽Notes의2026-11-06 중앙판단. core27·비활성 등록확장이 새정지표 부재로offline확인 전 무조건DB_LOCKED를 받아 지원 이행이 없다. 활성app·운영DB·옛예약은보존하며새writer없음.

| 종류 | 항목 | 상태 / 다음 판단 |
| --- | --- | --- |
| 필수 차단 / 제품결함 |legacy 등록확장의 지원 오프라인 전환 경로 |21.9에서합성구버전설치로정상/거부/중단복구·공용기억보존·일반회귀를실행검증하고main반영후21.7재개.21.8기존gate는유효하지만새수정검증을대체하지않음 |
| 승인된 범위 |비활성/보류·work/attempt0·이전쓰기실행종료·새진입차단·운영자offline확인 조건부지원 |조건불명은변경전거부. 기존self/backfill/migration순서·A1잠금/owner보호유지. guard삭제/registry SQL삭제/빈DB/강제종료우회금지 |
| 지휘 소유권 |21.7지휘자는안전한준비만지속 |예비capture·계정근거조사·private복구runbook.제품코드중복구현/새writer/새예약활성/옛예약중지금지.부분최종보고뒤중앙이21.9구현배정 |

새버그는구현시험유예대상이아니다. 반복test:changed·마무리pnpm test→pnpm test:python순차와독립리뷰/필요후속필수.운영계정/입력확인과실전환은21.7소관이다.


## 21.9 — legacy 등록 확장 지원 갱신 수락 (2026-11-06)

- 원문: `tickets/epic-garmin-extension/tickets/bug-legacy-extension-core-upgrade-plan.md`의 Review Triage Log r1~r5, deferred 및 Auto Run Result. 최종 `48c073c`, 구현 `118df47`, core plugin release `5e7d5f8`(0.1.18, app-ref는 이전 구현 commit). Garmin 패키지는 무변경이다.
- 수락 증거: final4 전체 `pnpm test` 4282 passed·기존 skip1 → `pnpm test:python` 66 passed, 순차 각 exit0. 중앙이 원문·최종 시험 diff 일치·제품 바이트 동등성·원격 SHA를 확인했다. final3 시험 관측의 전역 role 간섭 실패는 DB 범위 관측으로 수정됐으며 실패 이력은 보존한다.
- 보류 medium: 기존 0033 migration의 DST 변환 규칙을 독립 oracle로 검증하는 시험. 기존 migration 고유 검증 범위로 분리했으며 신규 legacy 제품 결함으로 판정하지 않았다. 향후 migration 시험 보강 시 재검토한다.
- 보류 low: 대화형 offline 확인 중 Ctrl-C 종료 경로 시험. 기존 확인 동작 및 A1 잔존 잠금 명시 복구 계약을 유지하며 향후 대화형 취소 시험 보강 시 재검토한다.
- 운영 인계21.7: 실제 옛 확장 manifest의 대상 core 호환을 확인한다. 비활성·보류, 이전 데몬·직접 명령·모든 쓰기 자식 종료, 새 진입 차단 및 TTY 운영자 확인은 그대로 필요하다. 이 제품 수정의 수락이 운영자 확인이나 계정 귀속 확인을 대신하지 않는다. 21.7의 기존 legacy 경로 부재 차단은 제품 반영으로 해소됐으며 나머지 실제 입력 gate는 재개 시 확인한다.


## 21.7 — 재진단의 옛 manifest 차단과21.10 (2026-11-06)

- 원문 `tickets/epic-garmin-extension/tickets/story-mac-plan.md` 재진단·q2. 부분commit `e5385a7`은 공개 계획뿐이며 운영무변경·새writer0·모든운영AC미완료를 유지한다.
- 21.9의 schema bridge 뒤에도 실제 옛 Garmin1.0.0 manifest가 현재 decoder의 work 키 및 core_compat 요구에 걸리고 지원 선교체 경로도 없다. settings/default_schedules 각각이 독립적인 문법 오류라는 주장은 아니다.
- 별도21.10 `bug-legacy-manifest-transition.md`로 지원 core 갱신→옛 실행 금지→검증된 새 패키지 교체를 분리했다.21.7은21.10 수락·원격main/release 반영 뒤 재개한다. 옛daemon 종료·새TTY확인·계정귀속/tokenstore/MFA·설정 등 기존 gate는 보존한다.


## 21.10 — 옛 manifest 지원 전환 수락 (2026-11-06)

근거: [전환 계획](../tickets/epic-garmin-extension/tickets/bug-legacy-manifest-transition-plan.md)의 Review Triage Log r1~r6 및 Auto Run Result. 구현 `8513bf9`, 릴리스 `048e21c`(core plugin 0.1.20, app-ref는 이전 구현 commit). 중앙은 r5 보존 경계·r6 EOF 후속 원문, 최종 worker2 changed 로그와 원격 SHA를 대조했다.

- 검증: 최초 전체 TS 실패 및 재검증 실패는 이력으로 보존. 최종 제한 worker changed는 TS153파일/3591시험·기존skip1, 경로 규칙 Python전체15파일/66시험(내부244시험) 통과, 전체 exit0. 별도 Python 명령은 같은 전체 config 완료로 중복하지 않았다.
- 보존 해석: core 전환은 기존 확장9표 전체 보존. Garmin 패키지 교체는 영속6표·원본 bytes/hash·기억·사용자·예약·회계·이력 접두 보존과 기존0013 제거3표의 예상 부재를 검사한다. oldext와 migration 확정 전 거부는 전체 보존한다. 과거 migration 변조나 새 손실을 허용한 결정이 아니다.
- 기존 시험 불안정: unrestricted 실행의 auth id/SIGINT/timeout/DB_UNAVAILABLE는 같은 소스·단언의 제한worker 재검증에서 통과했다. 고부하가 정확한 원인이라고 확정하지 않으며, 취소 시험 readiness 안정화는 별도 검토한다.
- 통합 후속: 22.1의 schema39 반영 시 새 legacy 시험의 명시 schema38 기대를 대조해야 한다. 현재 수락 기준에는 schema39가 없으며 후속 통합의 필요 검증으로 남긴다.
- 운영 인계21.7: 지원 core 갱신·검증된 패키지 교체의 제품 차단을 해소했다. 실제 Mac의 옛 writer 종료·새 진입 차단·현재 시도 TTY 확인·계정 귀속/credential·운영 설정은 기존 21.7 소유다. 합성 시험 통과가 운영 전환 인수를 대신하지 않는다.

`deferred: []`, 후속 리뷰 권고 false. 소유 시험 PG와 최종174 fixture는 정확 ID 정리/부재를 확인했으며 로그·리뷰·워크트리는 보존한다.


## 21.7 — 대화형 bootstrap 진입점 부재와21.11 (2026-11-06)

- 원문21.7 계획의 재진단2·quick리뷰3. 부분commit `aa7377f`는 공개 계획뿐이며 blocked와 운영 AC 미완료를 유지한다.
- 옛 manifest 검사는21.10으로 통과했지만 detached app의 ref 없는 npx는 거부되고 ref 지정은 hook 모드로 stdin을 닫아 실제 offline 확인을 전달할 지원 경로가 없다. 기존 새 CLI PTY 시험은 bootstrap 진입을 입증하지 않는다.
- 별도21.11에서 합성 detached 옛 app의 bootstrap부터 실제 PTY·갱신/승격·보존·hook 무질문·실패복구를 검증한다.21.7은21.11 수락·원격main/release 뒤 기존 operator gate를 유지해 재개한다. 운영자 확인·계정귀속/MFA는 대신하지 않는다.
