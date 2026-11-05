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
