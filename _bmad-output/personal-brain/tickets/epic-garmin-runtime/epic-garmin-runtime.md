---
type: epic
title: "Garmin connector: 인증·수집·정제"
parent: personal-brain
covers: [R2, R11]
after: []
refined: false
risk: high
---

# Garmin connector: 인증·수집·정제

## Description

Garmin의 Python 코드(소스 기준 `7fb33dd`, `prep-garmin-absorption/inputs/garmin-source.tar.gz`)를 epic-garmin-import가 만든 확장 뼈대에 편입한다. 확장은 자기 파이프라인을 끝까지 돌고(AD-29), core와는 manifest, 프로세스 규약, DB 계약으로만 만난다(AD-30·33). 범위는 다음과 같다.
- 인증: MFA·token·session, 계정 차단, 호출 간격·first-call 보호. 같은 계정의 인증·수집은 epic 12의 출처+계정 직렬화 키를 쓴다.
- 수집·coverage → raw(받은 그대로의 text) → 정규화.
- body, digest, 그래프(차트·한국어 종목 리소스).
- 출력: garmin schema, core 건강 계약 표(INSERT만, AD-30·32), 그래프와 body 원본의 파일 등록 요청(`file_requests`, AD-23).
- manifest에 수집 일감 종류와 실행 명령, 기본 수집 예약, `garmin.*` 설정 키, 인증·로그인 단계를 선언한다.

SQLite 연결과 SQL은 PostgreSQL 저장 포트로 바꾼다. 기존 deploy와 Garmin 전용 LaunchAgent는 core 설치·공통 예약으로 대체한다. 같은 fixture의 수치를 기존 구현과 비교한다(2026-10-28, 이니셔티브 R2·R11, C4). 평가(report_input·report·Codex)는 epic-health-analysis다(2026-10-28 분할).

## Outcome

Garmin 사용자가 별도 Garmin 설치 없이 Brain에서 수집과 정제를 받고, 이전된 기록 위에 새 기록이 이어진다(이니셔티브 Done when 8의 Garmin 부분).

## Done when

1. 같은 합성 fixture에서 raw·정규화·digest·weight-lifestyle 결과가 기존 구현과 같고, core 건강 계약 표에 같은 값이 버전·revision과 함께 들어간다.
2. 계정 차단·MFA 필요·호출 간격 보호가 실패 경계 테스트로 지켜지고, 같은 계정 수집이 직렬로 돈다. MFA·차단 뒤에는 재인증·해제 전까지 외부 호출을 하지 않는다.
3. 같은 입력을 다시 처리해도 중복이 없고, 수정된 관측은 새 행이 되며, 실패한 수집은 이어서 재개된다. 감독자가 취소하면 수집이 멈추고 오래된 attempt의 쓰기는 거부된다.
4. 공통 스케줄러 예약으로 수집·정제가 돈다. 실계정 수집 한 번은 사람이 확인한다.
5. 별도 Garmin LaunchAgent 없이, 기능 묶음이 플러그인 배포로 이 Mac의 설치본에 들어가 동작한다.

## Boundaries

다음은 이 에픽 밖이다.
- 평가·리포트·결과 묶음 발신은 epic-health-analysis다.
- 기존 데이터 이전은 epic-garmin-import, 검색·수치 조회는 epic-search-and-health-query다.
- 건강 계약 표의 모양과 의미 계약은 epic-garmin-import가 만든다. 이 에픽은 그 표에 INSERT만 한다.
- Must not change: 외부 호출 동안 DB 쓰기 트랜잭션을 잡지 않는다. 이전된 기존 기록을 덮지 않는다(R7). 확장은 `work_items`를 청구하지 않는다(AD-33).

## References

- parent — _bmad-output/personal-brain/initiative-personal-brain.md, Requirements R2, R11, Constraints C4
- architecture — _bmad-output/personal-brain/architecture-brain-v1-slice-1/architecture-brain-v1-slice-1.md, AD-21, AD-23, AD-29, AD-30, AD-32, AD-33
- design — _bmad-output/personal-brain/prep-garmin-absorption/integration-boundaries.md, "가져갈 코드와 교체할 경계", "테스트 근거와 이전 완료 기준"
- inputs — _bmad-output/personal-brain/prep-garmin-absorption/inputs/research/garmin-runtime.md
- source — _bmad-output/personal-brain/prep-garmin-absorption/accepted-intent.md, S11·E1

## Notes

- Waits on epic-jobs-and-scheduler because: 계정 키 직렬화, 긴 수집의 임대 갱신과 attempt token, 현지 시각 예약을 쓴다.
- Waits on epic-extensions because: 확장 설치·활성화, manifest와 설정 snapshot, `brain_ext_garmin` role과 확장 마이그레이션 적용을 쓴다.
- Waits on epic-garmin-import because: 그 에픽이 만든 확장 뼈대·스키마, core 건강 계약 표, `file_requests` 위에 수집을 더하고, 이전된 기존 기록 위에서 새 수집이 이어진다.
- Decision(2026-10-28, 사용자): 옛 epic 16(Garmin 수집·분석)을 둘로 나눈다. 이 에픽은 connector(인증·수집·raw·정규화·digest·그래프)이고, 평가는 epic-health-analysis(18)다. spine AD-29(connector)와 AD-35(분석은 core 일감)를 따른다.
- Decision(2026-10-28): R11은 나눠 맡는다. 이 에픽은 인증·계정 보호와 raw·정규화·수치 계약을, epic-health-analysis는 입력 필터(report-input snapshot)를 맡는다.
- Decision(2026-10-28): epic-channels를 기다리지 않는다. 결과 묶음 발신은 epic-health-analysis로 갔다. 수집 쪽 사건 알림(인증 필요·계정 차단)을 채널로 보내게 되면, 쪼갤 때 epic-channels를 `after`에 다시 선언한다. → 2026-10-28 바뀜(아래).
- Decision(2026-10-28): 수집 사건 알림을 옮긴다. 옛 Garmin은 인증 실패·rate limit·403 차단·정규화 실패·반복 부분 수집·오류를 (현지 날짜, 사건)마다 한 번 Telegram으로 보냈다(`errors.NotifyEvent`, `ports.TelegramNotifier` @ 7fb33dd). 같은 사건을 같은 의미 키로 채널 발신 요청에 넣는다. 그래서 epic-channels를 `after`에 다시 선언했다(만드는 순서상 15가 이미 앞이다). 리포트 실패 알림은 epic-health-analysis다.
- Decision(2026-10-28): manifest의 기본 수집 예약은 옛 Garmin 값 그대로다. 수집 11:00, 재시도 11:15, 시간대는 사용자 설정 DB의 값이다(옛 `config.py` `_DEFAULTS` @ 7fb33dd). 놓친 예약은 epic-jobs-and-scheduler의 결정(깨어난 뒤 빠진 날짜가 있을 때만 한 번)을 따른다.
- Waits on epic-channels because: 수집 사건 알림을 채널 발신 요청(의미 키 UNIQUE)으로 보낸다(2026-10-28).
- Decision(2026-10-28, 추천으로 정함, 사용자 위임): 실계정 확인은 옛 Garmin tokenstore(기본 `~/.garmin-pipeline/tokens`)가 유효하면 에이전트가 그것으로 로그인해 수집 한 번을 돌린다. MFA가 필요하면 그 스토리만 `awaiting-operator`로 두고 run은 계속한다. 차단·MFA 뒤에는 외부 호출을 하지 않는다(R11).
- Handoff(2026-10-28, epic 14 세트 검증 F2): epic 14에서 받는 것. 새 raw도 `garmin.raw_records`의 key 정규형 `<scope>/<원래 key>`를 쓴다(14.1). 새 건강 행은 14.2의 지표 catalog·보관 키·"현재" view 규칙을 따르고, 계정 identity는 로그인 profile의 Garmin 사용자 profile id다(epic 14 Notes의 계정 Decision과 같은 값). 새 수집 출처를 맨 앞에 둔 권위 기록 새 규칙 버전을 쓰는 일은 이 에픽 몫이다(14.2의 권위 기록, 규칙 v1은 14.4가 쓴다). 그래프·body 원본은 14.5의 `file_requests`와 결과 view로 보낸다. 옛 writer가 14.8의 capture 뒤에 쓴 것과 옛 Garmin 예약 중지(전환)도 이 에픽 몫이다. 쪼갤 때 이 entry들로 교차 `after`를 고정한다.
