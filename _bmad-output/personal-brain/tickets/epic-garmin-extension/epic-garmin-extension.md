---
type: epic
title: "Garmin 확장: 옛 프로그램을 거의 그대로 PG 위에서 돌리고 전환한다"
parent: personal-brain
covers: [R2, R5, R6, R7, R8, R11, R12, R13, R15, R16]
sources: [_bmad-output/personal-brain/architecture-brain-v1-slice-1/architecture-brain-v1-slice-1.md]
companions: [_bmad-output/personal-brain/architecture-brain-v1-slice-1/garmin-extension-redesign-disposition.md, _bmad-output/personal-brain/research-garmin-extension-redesign-2026-11-05/research-garmin-extension-redesign-2026-11-05.md]
after: []
refined: true
risk: high
---

# Garmin 확장: 옛 프로그램을 거의 그대로 PG 위에서 돌리고 전환한다

## Description

옛 Garmin 프로그램(`~/github/garmin` `7fb33dd`)을 `extensions/garmin`으로 가져와 거의 그대로 확장으로 쓴다(2026-11-05 사용자). 바꾸는 것은 SQLite→PostgreSQL의 SQL·드라이버·읽기 snapshot과, 예약·발송·설정·파일·조회를 core 확장 지점(epic 20)에 잇는 부분뿐이다. 옛 core Garmin 경로는 먼저 20.6이 지운다. 마지막에 이 Mac에서 옛 데이터를 확정 반입하고 옛 예약을 새 예약으로 바꾼다.

## Outcome

Garmin 사용자가 Brain의 공통 예약으로 수집·day→7d→30d→all 평가를 받고, 평가와 그래프가 core 채널로 나가며, 에이전트가 `brain ext garmin …` 명령으로 수치·평가를 조회한다. 옛 데이터와 평가는 빠짐없이 옮겨진다.

## Requirements

- E21-1: 2026-11-05 epic 20의 E20-5(20.6)로 옮겼다. id는 다시 쓰지 않는다.
- E21-2 (R3, R5, R6, R7, R14; AD-29, AD-36, AD-40): 옛 SQLite DDL이 같은 모양의 `garmin` native 표가 되고(예외: `user_id`·계정 연결 `garmin.account_connections`, 평가 이력 + 최신 view), 옛 store 계층이 psycopg·REPEATABLE READ로 바뀌며, 원본 SQLite 표를 같은 모양 표로 복사 반입하고, 옛 리포트·그래프 파일은 `file_requests`로 core 파일이 되며 중립 metadata(kind report|graph, report_date, scope)와 평가 ↔ file_id 관계를 남긴다(새 리포트도 21.5가 같은 metadata를 쓴다. 17.1이 이를 소비한다). raw는 불변, 파생 투영 표는 재계산, 평가는 revision 이력이다.
- E21-3 (R8, R9, R11; AD-29): 옛 수집(인증·호출 보호·계획·raw)과 정규화가 PG 위에서 옛 fixture와 같은 결과를 낸다.
- E21-4 (R8, R9, R12; AD-29, AD-35): 옛 report(day→7d→30d→all, 체성분 intake 포함)가 확장 일감으로 돌고, 평가는 덮어쓰지 않으며, 모델 프로세스는 감독자가 정리한다.
- E21-5 (R2, R4, R10, R12, R13, R15, R16; AD-18, AD-35, AD-37, AD-38, AD-39): manifest가 수집·분석 일감과 cron 예약·의존(수집 성공 → 분석), 설정 `garmin.*`, 필요 기능 `channel.send`, 읽기 명령을 선언한다: `daily-values`(현지 날짜 범위+시간대·지표·운동 조건 → 행별 값·단위), `period-summary`(같은 조건 + 집계 sum|mean, 허용 집계만 → 값·단위·관측 수·NULL 수·적용 기간, 0건·전부 NULL은 값 null·개수 0, NULL은 0이 아님), `recent-evaluations`. 이 조회 계약의 producer는 이 에픽이고 17.4가 소비·독립 검증한다(R15). 비활성화하면 예약·새 청구·명령이 멈추고 native 데이터·평가·리포트 파일은 남으며 다시 켜면 이어 돈다(R16). 발송은 core 채널 요청, 리포트·그래프는 `file_requests`다. 옛 launchd 예약·Telegram 발송기·설정 파일은 없다. `second-brain-garmin` 플러그인으로 설치된다.
- E21-6 (R2, R5, R6, R7; AD-36): 이 Mac에서 예비 반입(online capture) → 전환(옛 예약 중지 → writer 종료 확인 → 최종 capture·차분 확정 반입·전수 비교 → 새 예약 활성화)을 하고, 실패하면 옛 예약을 되살린다. 계정은 raw profile id로 확인하고 확인할 수 없으면 반입하지 않는다.

## Constraints

- 옛 계산·프롬프트·출력 schema·report_input 의미는 바꾸지 않는다. 바꾸는 일은 실사용 뒤 새 revision이다.
- core에 Garmin 이름·지표·표·프롬프트를 두지 않는다(spine 확장 원칙). core는 Garmin schema를 읽지 않는다.
- 모델 호출 동안 DB 트랜잭션을 열어 두지 않는다. 시험은 fake 모델 CLI·합성 fixture이고 실계정은 21.7 한 번이다.
- 공개 plan·로그에 실제 건강값·평가 본문·계정 식별자를 쓰지 않는다.

## Done when

1. 저장소에 옛 core Garmin 경로가 없고, 대화 수집 등 기존 시험이 통과한다.
2. 같은 합성 fixture에서 PG 위 옛 프로그램의 수집·정규화·report_input·평가 결과가 SQLite 위 옛 프로그램과 같다.
3. 공통 예약으로 수집 뒤 평가가 돌고, 중간에 죽여도 저장된 scope부터 이어지며, 발신 실패가 평가를 지우지 않는다.
4. 이 Mac에서 확정 반입의 전수 비교가 일치하고, 옛 예약이 내려간 뒤 새 예약으로 실수집·실평가 한 번이 돌며, epic 20의 확장 명령·cron 예약·플러그인 설치가 설치본에서 동작한다(모델 품질은 사람 몫).

## Boundaries

- core 범용 확장 지점(명령·사용자 키·cron·패키지 설치)은 epic-extension-platform이다.
- 채널 계약과 Telegram adapter는 epic-channels(완료)다. Slack adapter는 범위 밖이다.
- 건강 수치를 쓰는 recall 스킬·검색 회귀는 epic-search-and-health-query(17.4·17.5·17.7)가 이 에픽의 명령을 소비한다.

## References

- parent — _bmad-output/personal-brain/initiative-personal-brain.md, Requirements R2~R16
- architecture — _bmad-output/personal-brain/architecture-brain-v1-slice-1/architecture-brain-v1-slice-1.md, 확장 원칙, AD-29, AD-30, AD-32, AD-35, AD-36, AD-37, AD-38, AD-39, AD-40
- companion — _bmad-output/personal-brain/architecture-brain-v1-slice-1/garmin-extension-redesign-disposition.md, 처분표·이행 순서
- research — _bmad-output/personal-brain/research-garmin-extension-redesign-2026-11-05/research-garmin-extension-redesign-2026-11-05.md, Q3·Q5
- legacy — `~/github/garmin` `7fb33dd`(옛 프로그램, 이식 원본), _bmad-output/personal-brain/prep-garmin-absorption/

## Notes

- Decision(2026-11-05, 사용자): Garmin은 옛 프로그램을 거의 그대로 확장으로 쓴다. core가 Garmin 기능을 흡수해 다시 만들던 epic 14(건강 계약)·16(정규화의 core 쓰기)·18(core 분석)의 방향을 대신한다. 근거는 spine 2026-11-05 update와 연구 문서.
- Decision(2026-11-05, 사용자): `~/github/garmin`의 src를 `extensions/garmin`으로 가져와 현재 epic 16 코드를 대체한다.
- Decision(2026-11-05, 사용자): 옛 경로는 동결하지 않고 정리 티켓(20.6, 처음엔 21.1)에서 지운다. 운영 DB에 실제 Garmin 데이터가 없고(14.8·16.9 blocked), 대화 수집 데이터는 무관하며, 옛 코드가 남으면 헷갈린다. 커밋 revert·rebase는 Garmin 커밋 약 51개가 남길 작업(12·13·15, `file_requests`, 채널 원문 보존, 시험 도구)과 섞여 더 느리고 위험해 택하지 않았다.
- Decision(2026-11-05, 사용자): 데이터 반입은 원본 SQLite 표를 같은 모양 `garmin` 표로 복사한다. core 표로 변환하지 않는다.
- Decision(2026-11-05, 사용자): 티켓을 줄인다 — 조회 명령·Garmin 플러그인을 core 연결(21.5)에, 예비 반입·확정 전환·epic 20 설치본 확인을 21.7에 합친다. Refactor sweep(21.6)은 둔다.
- Decision(2026-11-05): tracer는 21.2(옛 프로그램 도입 → native 표 → 합성 SQLite 복사 반입 → PG 위 report_input이 SQLite와 같은 폴더)다. 가장 덜 확실한 것은 store 계층 드라이버 교체와 읽기 snapshot 의미 보존이다.
- Decision(2026-11-05, 티켓 검증 F10): Refactor sweep(6)은 코드 티켓 2~5 뒤, 운영 인수(7) 앞이다. 7은 closing 운영 인수이고 거기서 찾은 기능 결함은 새 버그 스토리로 고친다(앞 에픽들과 같은 예외).
- Decision(2026-11-05, 티켓 검증 F8): 각 plan은 단일 대상 시험 명령, 사전 조건, 기대 관찰값, 정리 절차를 적는다. 공통 fixture(합성 SQLite·fake Garmin 응답·fake Codex·가짜 Telegram 서버·격리 PG와 Brain 홈)는 2가 만들고 3~5가 다시 쓴다. 7은 private runbook 한 번 실행과 공개 건수·상태 보고다.
- Risk(2026-11-05): 2 high — 복사 반입이 틀리면 과거 기록·평가를 잃는다(추가 확인: 반입 전후 원본 SQLite 표별 건수·자연키 해시를 독립 스크립트로 대조). 3 high — 수집 보호가 틀리면 계정이 차단된다(추가 확인: MFA·차단 fixture에서 외부 호출 0을 네트워크 가짜 서버 로그로 확인). 4 high — 평가 재개가 틀리면 성공 평가를 덮거나 모델을 두 번 부른다(추가 확인: fake Codex 호출 수를 scope별로 센다). 5 high — 예약·발신 연결이 틀리면 평가가 안 돌거나 두 번 나간다(추가 확인: 가짜 Telegram 서버의 수신 건수). 6 low. 7 high — 전환이 틀리면 옛·새 평가가 겹치거나 데이터가 빠진다(추가 확인: 공개 plan·로그에 계정·건강값·평가 본문이 없는지 따로 검사).

- Decision(2026-11-05, 사용자; 최신 Garmin 시험 범위):20.1~20.5·21.2~21.6은 시험 코드를 작성하되 실행하지 않는다(직접·test:changed·전체 모두 유예). build·typecheck·독립 리뷰·필요 후속 리뷰 후 built·commit·push·main 병합 가능하며 미실행을 통과로 보고하지 않는다. 직전 직접 시험+test:changed 규칙을 대체한다.21.6 뒤21.8 통합 시험 실행·수정이 새·기존 시험을 전용 DB에서 pnpm test → pnpm test:python 순차 실행하고 실패별 수정·관련 재검증을 맡는다.21.8 미해결 실패 또는 미실행이 있으면21.7 금지. 진행 중20.1은round4 직접 시험 뒤 추가 시험 없이 마무리. 다른 에픽은 기존 규칙 유지.

- Decision(2026-11-06, 중앙 명세 판단):21.7에서 core27·등록확장이 정지표 부재로 무조건 거부되어 지원 갱신 경로가 없음을 확인했다. closing 운영 인수 중 제품 결함은 별도 bug21.9로 분리한다.21.8→21.9→21.7 순서이며 기존 sweep21.6은 다시 열지 않는다.21.9는 비활성/보류·진행work/attempt0·이전daemon/직접명령/쓰기자식종료·새진입차단·기존offline운영자확인의 모든 전제 아래에만 지원 전환을 제공하고, 그 외 기존안전거부를 유지한다. 구체적 설계는 기존 migration/self/backfill·공용기억·owner복구 계약을 보존한다. 운영 이행은21.7이 맡는다.

- Decision(2026-11-06, 중앙 무인 구현):21.7 재진단의 옛 manifest 차단을 별도21.10으로 분리한다.21.9→21.10→21.7 순서이며21.10은 옛 패키지의 실행 금지와 검증된 새 패키지 교체까지 지원하고 실제 운영/계정 gate는21.7이 유지한다. 기존 sweep 완료 이력은 바꾸지 않는다.
