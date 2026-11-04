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
