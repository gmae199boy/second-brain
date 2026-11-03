# 티켓 자동화 후속 항목 모음

중앙 감독자가 최종 결과를 수락하거나 기존 built 증거를 감사할 때 갱신한다. 아래는 이번 자동화에서 확인한 14.8·16.2·16.3·16.4의 항목이다. 과거 전체 티켓 전수 수집본은 아니다. 원문과 판단 근거는 링크한 계획의 `deferred`, `Review Triage Log`, `Auto Run Result`에 보존한다. 아래 ‘판단 대기’는 원문에 남은 항목이며 현재 코드에서 미해결임을 다시 검증했다는 뜻은 아니다. 해결 여부를 판단할 때 실제 코드·검증을 대조한다.

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
