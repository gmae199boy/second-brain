---
name: brain-garmin-operations
description: Garmin 수동 수집, 이관 사전 점검·이관·검증, 일일 분석·리포트 생성·재생성·저장 평가 다시 보내기 요청, 기간 분석·주간/월간 리뷰 또는 건강 수치·최근 평가 조회 요청에 사용합니다.
---

# Garmin 운영

먼저 `brain guide schema ext --json`으로 `ext status`와 `ext run`을 확인하고 `brain ext status garmin --json`으로 installed와 enabled를 확인한다. 미설치·비활성이면 그 상태를 안내하고 중단한다. 자동 설치·활성화하지 않는다. 조회 요청은 이어 `brain guide schema ext.garmin --json`으로 진입점과 입력 schema를 확인한다. 수동 일감은 core schema의 `ext run`을 사용하며 이름은 이 플러그인 `package/manifest.json`의 work.manual에서 확인한다. 현재 CLI는 manual을 ext.garmin 조회 명령으로 등록하지 않는다. 명령이 없거나 schema 확인이 실패하면 미구현 또는 확인 불가로 보고 중단하며 Python·DB 직접 실행으로 우회하지 않는다.

- `brain ext run garmin import-preflight --json`: 기존 자료 이관의 계정 귀속·선택·충돌 사전 점검이다.
- `brain ext run garmin import --json`: 확인된 capture manifest의 자료를 이관한다. 계정 귀속·범위·충돌·제외를 사전 점검 결과로 설명하고 명시적 사용자 동의 후 실행한다. manifest나 건강값을 추정해 만들지 않는다.
- `brain ext run garmin import-verify --json`: 이관 결과의 검증을 요청한다.
- `brain ext run garmin collect --target <connection-id> --json`: 외부 계정에서 실제 수집한다. 계정·기간·변경 영향을 확인하고 명시적 동의 후 실행한다. 로그인은 사용자가 직접 터미널에서 한다.
- `brain ext run garmin report --target <connection-id> --json`: 일일 분석과 리포트 생성을 요청한다. 결과가 외부로 발신될 수 있으므로 날짜·대상·발신 범위를 설명하고 명시적 동의 후 실행한다.
- `brain ext run garmin report-regenerate --target <connection-id> --json`: 기존 리포트 재생성을 요청한다. 대체 범위와 외부 발신 가능성에 대해 명시적 확인 후 실행한다.
- `brain ext run garmin period-analysis --target <connection-id> --input '{"start_date":"2026-10-01","end_date":"2026-10-31"}' --json`: 지정 기간의 분석·주간/월간 리뷰를 DB에 저장한다. 양끝 날짜를 포함하며 성공적으로 완료되면 결과 이벤트를 기록한다. 실행 전에 기간·대상을 설명한다. 선택 입력 `metric`, `aggregation`, `activity_type`, `exercise`는 period-summary 관례와 허용값을 따른다. metric 없는 aggregation은 쓰지 않는다. `send` 선택 플래그는 없다. 이벤트는 `garmin.period_report.completed`이며 발송은 core 구독 설정에 따른다. 구독·메신저 설정이 없어도 분석은 성공하며 이벤트 기록을 발신 성공으로 보고하지 않는다.
- `brain ext garmin recent-period-evaluations --input '<json>' --json`: `connection_id`, `timezone`, `limit`으로 수동 기간 분석의 시작·종료일, 초점, revision, 본문·근거·다음 확인을 읽는다. 일일 `recent-evaluations`와 구별한다.

- `brain ext run garmin report-send --target <YYYY-MM-DD> --json`: 분석을 실행하지 않고 저장된 평가 revision과 DB 일일 지표로 요약을 렌더링하고 게시된 그래프 앨범·전체 보고서 문서를 담은 결과 이벤트를 다시 기록하는 다시 보내기 요청이다. 미게시 파일은 분석 없이 기존 렌더러로 복원·게시한다. 렌더링 불가 시 메시지에 `보고서·그래프 없음`을 표시하고 결과 JSON의 `attachment_reason`에 사유를 남긴다. 파일 게시 대기·실패는 재시도 가능한 오류로 처리한다. 이 manual의 target은 날짜이며 생략하면 설정된 계정 시간대의 오늘이다. 연결은 `garmin.connection_id` 설정을 사용한다. 네 범위 평가가 없으면 실패하며 같은 서식·첨부 버전·revision·첨부 구성은 이벤트를 한 번만 기록하며 새 revision·첨부·서식 버전은 새 이벤트다. 날짜·계정·외부 발신 범위를 설명하고 명시적 동의 후 실행한다. 결과 JSON의 `event_id`는 기록된 이벤트이며 실제 채널 전달 성공과 구별한다.
- 조회는 `brain ext garmin daily-values --input '<json>' --json`, `brain ext garmin period-summary --input '<json>' --json`, `brain ext garmin recent-evaluations --input '<json>' --json`을 사용한다. 입력 키·허용 지표는 현재 schema에서만 가져오고 연결·시간대는 brain-config 스킬의 일반 키 조회로 확인한다. 건강 기간·NULL/0 구분과 집계는 core brain-recall 스킬을 따른다. 최근 평가는 실제 반환된 근거와 범위만 보고한다.

수집·일일 분석·리포트·재생성·기간 분석의 target은 일반 설정 `garmin.connection_id`에서 읽은 정규형 UUID다. `brain guide schema config --json` 지원 확인 후 `brain config get garmin.connection_id --json`과 `brain config get garmin.timezone --json`으로 연결·시간대를 읽는다. 연결 ID가 없거나 UUID 형식이 잘못되었으면 접수하지 말고 설정 필요를 보고한다. 사용자 제공 값도 설정과 대조하고 다르면 확인한다. 이관 3개 manual은 capture manifest를 쓰므로 같은 target 계약을 임의 적용하지 않는다.

수동 작업에 필요한 `--target` 등 옵션은 core ext schema로 확인하고 값의 의미는 해당 manual의 요구에 따른다. schema만으로 일감 이름이나 target 의미를 알 수 있다고 가정하지 않는다. 이름만 보고 기본 계정·기간을 추정하지 않는다. 비밀번호·MFA·토큰을 요청·출력·저장하지 않고 인증 화면을 읽지 않는다. 공개 상태·집계와 종료 코드·오류 코드만 보고하며 건강 원문·개인 경로·비밀은 로그에 복사하지 않는다. 실패하면 중단하고 접수를 완료·검증 통과·발신 성공으로 말하지 않는다. 작업 후 공개 status를 다시 읽고 확인되지 않은 상태는 미확인으로 보고한다.

기간 분석의 "지난주", "지난달", "최근 7일" 등 상대 날짜는 연결의 `garmin.timezone`을 읽고 시간대 DB로 현재 현지 날짜를 계산해 확정한다. OS 날짜나 UTC 날짜를 그대로 쓰지 않는다. 지난달은 직전 달 1일~말일이며 최근 7일은 오늘 포함 7일이다. 경계가 모호하면 범위를 확인한다. 날짜·target·입력을 설명한 뒤 접수하고, 일감 완료 후 조회에서 실제 결과를 읽어 분석을 전달한다. queued는 분석 완료가 아니다.

분석 프로세스는 수집 완료를 기다리지 않고 시작 시점의 저장 자료를 사용한다. 예약 시각은 사용자가 관리하며 설치 기본 시각을 실행 조건으로 강제하지 않는다.

기본 예약의 수집→분석 순서와 같은 날 수집 성공 조건은 core의 after_schedule이 담당한다. 수동 분석 프로세스 자체에는 수집 상태 대기가 없다. 현재 brain schedules CLI에는 after 의존 설정 옵션이 없으므로 지원한다고 안내하지 않는다.

수동 report/report-regenerate/report-send가 진행 중 수집과 겹치면 기존 계정 쓰기 락에 의해 최대 60초 대기하거나 실패할 수 있다. 수집 상태 polling을 없앤 것이며 쓰기 락 구조는 변경하지 않는다. 수집→분석 순서와 같은 날 수집 성공 조건은 core 예약 의존(after_schedule)이 담당하고 report 코드 자체는 수집 상태를 기다리지 않는다.

일일 report·재생성·report-send는 `garmin.report.completed`, 기간 분석은 `garmin.period_report.completed` 결과 이벤트를 기록한다. 지난 날짜의 예약 따라잡기도 이벤트를 기록하며 당일·과거 판정과 발송은 core 구독 설정이 담당한다. 확장 스크립트는 메신저·채널·발송 시각을 판별하거나 발송을 요청하지 않는다. 구독이 없어도 분석·저장은 성공한다.

기간 분석은 저장된 전체 기간 보고서 문서를 요약 뒤에 첨부한다. 현재 임의 기간용 그래프 렌더러는 없어 기간 분석에 그래프 앨범은 포함되지 않는다.
