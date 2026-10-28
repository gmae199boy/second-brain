---
type: epic
title: "core 건강 분석"
parent: personal-brain
covers: [R2, R10, R11, R12]
after: []
refined: false
risk: high
---

# core 건강 분석

## Description

건강 평가를 core 일감으로 만든다(AD-35). 예약된 core 일감이 분석 에이전트(모델 CLI, 이 Mac의 Codex 로그인)를 띄우고, 에이전트는 core 데이터만 읽는다(건강 계약 표, 필요할 때 `<ext>.raw_records`). 범위는 다음과 같다.
- 입력 snapshot: Garmin `report_input`의 snapshot·cutoff·scrub 의미를 core 계약 표 위로 옮긴다. 입력 snapshot·cutoff, 건강 revision, 소스 권위, 시간대를 고정해 분석 그래프 안에서 공유한다.
- 평가: day → 7d → 30d → all을 일감 의존으로 표현한다. 각 scope는 출력 schema 검증을 거친 뒤 바로 `analyses`와 리포트 파일(FileStore, AD-23)로 확정되고, 선행 analysis ID를 남긴다. 재시작은 저장된 성공부터 잇는다.
- `analyses`: epic-garmin-import가 만든 최소 계약·DDL을 호환 확장한다. 이전된 기존 분석을 덮거나 재분석으로 대체하지 않는다(R7).
- 결과 묶음: 평가와 epic-garmin-runtime이 만든 그래프 파일을 묶어 채널 발신 요청으로 보낸다. 후속 평가·그래프·발신 실패가 성공한 평가를 되돌리지 않는다.
- 모델 실행 adapter는 Runtime이 Core 실행 port에 조립한다. 모델 CLI와 하위 프로세스는 취소·실패 때 그룹 정리·reap한다(AD-33). 모델 입력·도구 응답은 출력 코덱으로 가린다(AD-11).

Garmin의 `report`·JSON schemas·skills와 report-codex 테스트가 출발점이다(2026-10-28, 이니셔티브 R2·R10·R11·R12, 옛 epic 16에서 분할).

## Outcome

Garmin 사용자가 예약된 시각에 day·7d·30d·all 평가를 받고, 성공한 평가는 발신 결과와 상관없이 남는다(이니셔티브 Done when 8의 분석 부분).

## Done when

1. 같은 합성 fixture에서 입력 snapshot(입력 필터·report-input)이 기존 구현과 같다.
2. day → 7d → 30d → all이 순서대로 돌고 각 성공이 바로 보존된다. 중간에 죽이거나 취소한 뒤 다시 돌리면 저장된 성공부터 잇고, 이전된 기존 분석은 그대로다.
3. 긴 평가 중에도 대화 수집이 진행되고, 모델 CLI가 멈추거나 취소되면 프로세스 그룹이 정리된다(fake 모델 CLI).
4. 발신 실패는 평가를 지우지 않고, 같은 결과 묶음은 한 번만 나간다.
5. 공통 스케줄러 예약으로 수집 뒤 평가가 돈다. 실계정 평가 한 번과 모델 품질은 사람이 확인한다(fake 모델 E2E만으로 품질을 주장하지 않는다, E6).
6. 기능 묶음이 플러그인 배포로 이 Mac의 설치본에 들어가 동작한다.

## Boundaries

다음은 이 에픽 밖이다.
- 인증·수집·정규화·digest·그래프는 epic-garmin-runtime이다.
- `analyses` 최소 계약과 건강 계약 표는 epic-garmin-import, 채널 계약과 Telegram adapter는 epic-channels다.
- 분석 검색과 건강 수치 조회는 epic-search-and-health-query다.
- Must not change: 모델은 일감 안에서만 부르고 hook·동기 명령 경로에서는 부르지 않는다(AD-33). 외부 호출 동안 DB 쓰기 트랜잭션을 잡지 않는다. 이전된 기존 분석을 덮지 않는다(R7).

## References

- parent — _bmad-output/personal-brain/initiative-personal-brain.md, Requirements R2, R10, R11, R12, Constraints C4, C5
- architecture — _bmad-output/personal-brain/architecture-brain-v1-slice-1/architecture-brain-v1-slice-1.md, AD-11, AD-23, AD-32, AD-33, AD-35, Table Contract(`analyses`, 채널 발신 요청·이력)
- design — _bmad-output/personal-brain/prep-garmin-absorption/integration-boundaries.md, "가져갈 코드와 교체할 경계"(report_input·report 행), "작업 그래프와 병렬성"
- inputs — _bmad-output/personal-brain/prep-garmin-absorption/inputs/research/garmin-runtime.md, "분석·중단·전송"
- source — _bmad-output/personal-brain/prep-garmin-absorption/accepted-intent.md, S5·S11·S12·E6

## Notes

- Waits on epic-jobs-and-scheduler because: 일감 의존, 모델을 부르는 일감의 감독(자식 프로세스 그룹·취소·reap), 긴 평가의 임대 갱신, 현지 시각 예약을 쓴다.
- Waits on epic-garmin-import because: `analyses` 최소 계약·DDL을 호환 확장하고, 이전된 기존 분석이 선행 analysis와 재시작 지점이며, 건강 계약 표의 "현재" view를 읽는다.
- Waits on epic-channels because: 결과 묶음을 채널 발신 요청(의미 키 UNIQUE, 최초 시도 gate)으로 보낸다.
- Waits on epic-garmin-runtime because: 새 수집이 넣는 정제 행(digest)과 그래프 파일 등록 요청이 새 날짜의 분석 입력과 결과 묶음의 그래프다.
- Decision(2026-10-28, 사용자): 옛 epic 16(Garmin 수집·분석)에서 나눈 에픽이다. spine AD-35(분석은 core 일감)를 따른다. R11 중 입력 필터(report-input)를 맡는다.
- Decision(2026-10-28): 분석 에이전트의 프롬프트와 출력 schema는 옛 Garmin `report`의 프롬프트·JSON schema를 v1로 그대로 쓴다(S11 재사용). 바꾸는 일은 실사용 뒤 새 revision으로 한다. 이전의 Open question과 spine Deferred "분석 에이전트의 프롬프트와 출력 schema"를 대신한다.
- Decision(2026-10-28, 사용자): 분석 에이전트와 모델은 사용자가 바꿀 수 있다. 사용자 설정(DB, AD-18)에 에이전트(모델 CLI adapter 이름), 모델, effort를 둔다. 기본값은 옛 Garmin과 같다(Codex, 모델은 CLI 기본, effort high, 호출 timeout 20분). 이 에픽은 Codex adapter와 Claude Code adapter를 만들고, 둘 다 같은 출력 schema 검증과 그룹 정리·reap을 지난다. adapter는 토큰 사용량을 프로세스 ABI v1의 `usage` 칸에 채운다(epic-jobs-and-scheduler Notes 같은 날).
- Source conflict(2026-10-28): spine AD-35의 "모델 실행 adapter는 이 Mac의 Codex 로그인 환경을 사용"은 위 결정과 다르다. 설정에서 고른 모델 CLI의 로그인 환경으로 넓힌다. 이 에픽 정제 전에 `bmad-architecture`로 고친다.
- Decision(2026-10-28, 사용자): Garmin 확장을 끄면 Garmin 데이터를 읽는 분석 예약도 멈추고, 진행 중인 평가는 감독자 취소로 끊으며, 대기 일감은 보류했다가 다시 켜면 이어서 돈다. 이미 저장한 평가와 이전된 분석은 남고 검색된다(epic-jobs-and-scheduler Notes 같은 날). 이전의 Open question을 대신한다.
- Decision(2026-10-28): 기본 분석 예약은 옛 Garmin 값인 11:30이다. 리포트 실패 알림(옛 `REPORT_FAILED`)도 채널 발신 요청으로 옮긴다.
- Assumption(2026-10-28): 여러 날을 놓친 뒤 깨어나면 수집이 끝난 최신 날짜만 평가하고, 빠진 날의 day 평가를 소급해 만들지 않는다(옛 report의 동작으로 짐작). 정제 때 옛 코드로 확인한다.
- Handoff(2026-10-28, epic 12 세트 검증 F4): Garmin을 끄면 분석도 멈추게 연결하는 일은 이 에픽의 몫이다. 분석 일감과 예약을 넣을 때 epic 12의 보류 그룹 `extension:garmin`을 붙인다(12.10). 평가 순서는 12.6의 의존 use case로, 모델 일감의 정체 창 25분은 12.5로, 토큰은 12.4의 `usage` 칸으로 운반한다. 옛 Garmin `report.py`의 `_usage`는 `codex exec --json`의 `turn.completed`에서 토큰을 읽는다(epic 12 코드 조사 6절). adapter는 그 방식을 이어받는다.
