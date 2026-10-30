---
type: epic
title: "Garmin connector: 인증·수집·정제"
parent: personal-brain
covers: [R2, R11]
sources: [_bmad-output/personal-brain/initiative-personal-brain.md, _bmad-output/personal-brain/architecture-brain-v1-slice-1/architecture-brain-v1-slice-1.md]
companions: [_bmad-output/personal-brain/architecture-brain-v1-slice-1/architecture-brain-v1-slice-1.md, _bmad-output/personal-brain/prep-garmin-absorption/integration-boundaries.md, _bmad-output/personal-brain/tickets/epic-garmin-runtime/epic-garmin-runtime-research-code.md]
after: []
refined: true
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

코드 조사(2026-10-28, `epic-garmin-runtime-research-code.md`)가 찾은 것은 다음과 같다.
- garminconnect/curl-cffi를 import하는 곳은 `garmin` 패키지 한 곳이다. 현재 lock의 garminconnect 0.3.17은 garth를 쓰지 않는다. tokenstore는 라이브러리의 login/dump로만 다룬다.
- 429·403 차단은 tokenstore의 `block.json`(당일만 유효)에 남고, 다음 날이면 저절로 풀린다. "해제 전까지 외부 호출 금지"(Done when 2)와 어긋난다. auth_failed는 토큰 mtime으로만 재시도를 판단한다.
- 옛 정규화는 버전 불일치 때 파생 표를 모두 지우고 다시 계산한다. core 건강 표에 그대로 가져가면 AD-32 위반이다.
- 옛 collect는 성공·부분·차단을 모두 종료 코드 0으로 끝낸다. 감독자 결과로 그대로 쓸 수 없다.
- 옛 sync는 collect 뒤 report를 부르고, 그래프는 report 안에서 그린다. connector용 산출 진입점을 따로 둬야 한다.
- 이 Mac에는 옛 tokenstore(`garmin_tokens.json`)와 옛 LaunchAgent 둘(`local.garmin-pipeline.collect`, `local.garmin-pipeline.report`)이 등록돼 있다(메타데이터만 확인).

## Outcome

Garmin 사용자가 별도 Garmin 설치 없이 Brain에서 수집과 정제를 받고, 이전된 기록 위에 새 기록이 이어진다(이니셔티브 Done when 8의 Garmin 부분).

## Requirements

- E16-1 (R2, R11; C4): connector 편입 — 옛 Python 코드(소스 `7fb33dd`)를 epic 14의 확장 뼈대에 편입한다. SQLite store는 garmin schema의 PG store port로, deploy·Garmin LaunchAgent는 core 설치·공통 예약으로, Telegram 직접 발신은 채널 발신 요청으로, config TOML은 설정 snapshot으로 바뀐다. 옛 의존(garminconnect·curl-cffi·jsonschema·matplotlib·requests)을 epic 14의 lock(pin 3.14.10 + `psycopg[binary]`)에 더해 다시 잠그고, macOS arm64에서 frozen 설치·import가 검증된다. 수집 경로는 모델을 부르지 않는다. (AD-29·33, spine Deferred "Garmin lock·설치 재현성"의 epic 16 몫)
- E16-2 (R11): 인증과 계정 보호 — 세션은 라이브러리의 login/dump로 tokenstore(`garmin.tokenstore`, 기본 `~/.garmin-pipeline/tokens`, 폴더 0700·파일 0600)에서 연다. 비밀번호·MFA를 받는 대화형 로그인은 epic 13의 인증 단계로만 하고, 감독자 일감의 JSONL stdout과 섞지 않는다. 호출 간격(호출마다 1~2초, 날짜 사이 5초), 연속 403 세 번이면 차단, first-call 보호(실행당 endpoint마다 3건)를 지킨다. 429·403 차단과 인증 실패·MFA 필요는 외부 호출 전에 garmin schema의 계정 보호 상태로 먼저 저장한다. 인증 실패·MFA 필요는 재인증이 성공할 때까지, 429·403 차단은 다음 현지 날짜에 탐색 호출 하나가 성공할 때까지 예약·수동·force 실행 모두 외부 호출을 하지 않는다. 다음 날에도 다시 차단되면 수동 해제(`brain ext run garmin release-block`)가 있어야 풀리고, doctor가 보인다. 인증·수집은 epic 12의 `(source, account)` 직렬화 키를 쓴다. 비밀은 argv·로그·stdout·오류 문장에 나오지 않고, 오류는 허용 목록의 코드·단계·endpoint만 낸다. (AD-18·33)
- E16-3 (R2, R11): 수집과 coverage — 날짜 endpoint 11개와 활동 endpoint 4개, history_start(이전된 운영 dataset의 값이 있으면 그것, 없으면 첫 실행 today−30), 실행당 최대 10일, 11:15 재시도 진입표, recent_lists, 거부 일수 상한을 옛 의미대로 지킨다. raw는 라이브러리가 decode한 객체를 `json.dumps(ensure_ascii=False)`한 그 문자열이고, NoData·checked_at·fetched_at·library_version 전이도 옛 의미다. 새 raw는 garmin 보존 표에 새 수집 dataset으로 이어 쓰고 이전된 행을 덮지 않는다. coverage는 같은 계정의 모든 dataset(이전된 raw 포함)을 본다. 14.8 capture 뒤의 날짜는 다시 반입하지 않고 새 수집이 받는다. (AD-30·32)
- E16-4 (R2, R11; AD-32): 정규화와 건강 계약 — 정규화 버전 8의 순수 계산을 재사용하고, 결과는 14.2의 보관 키로 새 행만 INSERT한다(DELETE·UPDATE 없음). 같은 raw를 다시 처리하면 멱등이고, 바뀐 raw는 새 관측 revision 행이며, rebuild는 새 정규화 버전 행이다. 항목별 실패는 격리돼 normalize 상태에 남는다. 권위 기록에 새 수집 dataset을 맨 앞에 둔 새 규칙 버전(v2: 새 수집 → D2 → D1 → D4 → D5 → D3)을 쓰고, 규칙 v1은 바꾸지 않는다. 계정 identity는 로그인 profile의 Garmin 사용자 profile id다. 같은 합성 fixture에서 raw·정규화 결과가 옛 구현과 같다. (AD-32)
- E16-5 (R2, R11): body·digest — body는 원본 참조와 검증 JSON으로 필드별 mtime 병합을 지키고(NaN·Infinity·중복 key 거부), 원본 파일은 옮기기 전에 `file_requests`로 보낸다. digest는 순수 계산이고 모델 서술과 분리된다. digest의 일 값(day values)은 core 건강 요약 행이 되며, catalog에 없는 지표는 호환 core 마이그레이션으로 catalog에 더한다. 같은 합성 fixture에서 digest·weight-lifestyle 결과가 옛 구현과 같다.
- E16-6 (R2): 그래프 — 그래프 PNG(Agg, 12×6 inch·150 DPI, Apple SD Gothic Neo → DejaVu Sans, private MPLCONFIGDIR, 파일 0600, 10,000,000 bytes 상한, 그래프별 실패 격리)를 만들고 `file_requests`로 보낸다. 요청에는 현지 날짜·그래프 이름·산출 revision이 있어 epic 18의 결과 묶음이 고를 수 있다. 성공 PNG 바이트는 core 확인까지 보존한다. 한국어 종목 이름 리소스는 확장 패키지로 옮기고 normalize·digest·그래프가 같은 loader를 쓴다.
- E16-7 (R11; R13은 epic 15 경유): 수집 사건 알림 — auth_failed·rate_limited·blocked_403·normalize_failed·repeated_partial·error 여섯 사건을 채널 발신 요청으로 낸다. 의미 키는 `(생산 결과 식별자 = (source, account, timezone, 현지 날짜, 사건)의 안정 사건 행 id, conversation = Garmin 봇·채팅, 목적 = collection-notice:<사건>, 개정 = 사건 템플릿 revision)`이다. 같은 날 같은 사건은 처음 사건 행을 다시 쓴다. 사건 행과 요청은 짧은 트랜잭션 하나에 넣는다. 실제 재시도는 epic 15의 결정을 따르고, 확장은 Telegram을 직접 부르거나 봇 설정을 읽지 않는다. (AD-30·35)
- E16-8 (R2, R10): 일감·예약·manifest — manifest가 `collect`(받은 항목의 증분 정규화와 publish까지), `normalize`(rebuild·미발행 raw 재개), `artifacts`(body·digest·그래프, collect 뒤 의존), `release-block`(수동), 연결 확인을 선언한다. 기본 예약은 collect 11:00·retry 11:15이고 시간대는 core 설정이다. `garmin.*` 설정 키는 옛 `_DEFAULTS`에서 온다(분석 키는 epic 18). 수동 실행은 `brain ext run garmin <job>`이다. 진행 이벤트를 endpoint·날짜·batch마다 내고 그 경계에서 취소에 반응한다. 옛 `_abandon_running`은 감독자가 대신한다. 결과(성공·부분·차단·인증 필요)는 ABI 결과로 명시하고, 종료 코드 0을 성공으로 뭉뚱그리지 않는다. 확장을 끄면 12.10의 보류 그룹이 예약과 청구를 막는다. (AD-33)
- E16-9 (R2; Done when 4·5): 전환과 이 Mac — 플러그인 배포 뒤 설치본에서 공통 예약을 등록하기 전에 옛 `local.garmin-pipeline.collect` LaunchAgent를 내린다(plist는 복구용으로 남김). 옛 report LaunchAgent는 그것이 스스로 수집을 부를 때만 함께 내리고, 아니면 epic 18의 전환까지 둔다. 옛 수집과 새 수집이 같은 계정을 동시에 부르는 때가 없다. 에이전트가 옛 tokenstore로 실수집 한 번을 돌린다. MFA가 필요하면 그 단계만 `awaiting-operator`다.

## Constraints

- 외부 호출 동안 DB 쓰기 트랜잭션을 잡지 않고, 쓰기는 짧은 트랜잭션(2초 안)이다(AD-7).
- 확장은 `work_items`를 청구하지 않고, core 계약 표에는 INSERT만 한다. core 계약 INSERT와 garmin 내부 쓰기는 현재 attempt 확인을 같은 트랜잭션에 둔다(AD-30·33).
- 이전된 legacy 행과 권위 규칙 v1을 바꾸지 않는다(R7).
- 시험은 fake Garmin client·합성 fixture로 한다. 실계정 호출은 마지막 이 Mac 스토리에서 한 번이다.
- 토큰·비밀번호·MFA 코드는 argv·로그·stdout·plan에 나오지 않는다. 실제 건강값과 계정 식별자를 공개 plan에 쓰지 않는다.

## Done when

1. 같은 합성 fixture에서 raw·정규화·digest·weight-lifestyle 결과가 기존 구현과 같고, core 건강 계약 표에 같은 값이 버전·revision과 함께 들어간다.
2. 계정 차단·MFA 필요·호출 간격 보호가 실패 경계 테스트로 지켜지고, 같은 계정 수집이 직렬로 돈다. MFA·차단 뒤에는 재인증·해제 전까지 외부 호출을 하지 않는다.
3. 같은 입력을 다시 처리해도 중복이 없고, 수정된 관측은 새 행이 되며, 실패한 수집은 이어서 재개된다. 감독자가 취소하면 수집이 멈추고 오래된 attempt의 쓰기는 거부된다.
4. 공통 스케줄러 예약으로 수집·정제가 돈다. 실계정 수집 한 번은 옛 tokenstore가 유효하면 에이전트가 확인하고, MFA가 필요할 때만 사람 몫이다(2026-10-28 위임).
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
- research — _bmad-output/personal-brain/tickets/epic-garmin-runtime/epic-garmin-runtime-research-code.md (2026-10-28 정적 코드 조사와 이 Mac 메타데이터 관찰)

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
- Decision(2026-10-28, 정제, 추천으로 정함): 계정 보호. 인증 실패·MFA 필요는 재인증 성공 전까지, 429·403 차단은 다음 현지 날짜의 탐색 호출 하나가 성공할 때까지 외부 호출을 막는다. 다음 날에도 차단되면 수동 해제(`brain ext run garmin release-block`, 에이전트도 부를 수 있다)가 있어야 풀린다. 상태는 tokenstore의 `block.json`이 아니라 garmin schema에 두므로 파일 쓰기 실패에도 재시작 뒤 보호가 남는다. 옛 동작(날짜가 지나면 저절로 해제)은 Done when 2와 어긋나서 바꾼다(코드 조사 2절).
- Decision(2026-10-28, 정제, 추천으로 정함): tokenstore. 라이브러리가 관리하는 세션 파일이라 `.env`에 넣지 않는다. 설정 snapshot에는 경로(`garmin.tokenstore`)만 담고, 내용은 라이브러리의 login/dump만 읽고 쓴다. spine AD-18의 "비밀은 `.env`"에 대한 이 에픽의 예외이고, 옛 tokenstore 재사용 위임 Decision을 따른다. 다음 spine 갱신 때 AD-18에 적는다. → 2026-10-28 AD-18에 적었다.
- Decision(2026-10-28, 정제, 추천으로 정함): 일감은 `collect`(증분 정규화·publish 포함), `normalize`(rebuild·재개), `artifacts`(body·digest·그래프), `release-block`이다. collect 안에서 raw와 그 항목의 건강 행을 같은 짧은 트랜잭션에 넣어, raw만 남고 publish가 빠지는 틈을 줄인다. 미발행 raw는 `normalize`가 다시 찾는다.
- Decision(2026-10-28, 정제, 추천으로 정함): 동등성 기대값. 합성 fixture만 옛 archive 코드에 한 번 넣어 기대 JSON을 만들고(기본 suite 밖의 opt-in 스크립트, 격리된 임시 환경) 저장소에 고정한다. 새 코드는 그 JSON과 비교한다. 새 코드로 기대값을 다시 만드는 순환 검증을 피한다. 실데이터는 fixture로 옮기지 않는다.
- Decision(2026-10-28, 정제, 추천으로 정함): digest의 일 값은 core 건강 요약 행이고, epic 18의 입력 snapshot은 그 행과 "현재" view를 읽는다. catalog에 없는 지표는 이 에픽이 호환 core 마이그레이션으로 더한다(catalog는 core 데이터이고, 지표를 더해도 core 코드는 바뀌지 않는다).
- Decision(2026-10-28, 정제, 추천으로 정함): 전환. 공통 예약을 켜기 전에 옛 collect LaunchAgent를 내리고 plist는 남긴다. 옛 report가 스스로 수집을 부르면 함께 내리고 epic 18 전환까지 평가가 잠시 쉬는 것을 받아들인다. 그렇지 않으면 report는 epic 18이 내린다. 두 수집기가 같은 계정을 동시에 부르면 차단 위험이 있으므로 동시에 켜지 않는다. 14.8 capture 뒤 옛 writer가 쓴 날짜는 다시 반입하지 않고 새 수집이 채운다(coverage가 이전된 raw를 본다).
- Decision(2026-10-28, 정제, 추천으로 정함): 그래프 폰트는 시스템 폰트(Apple SD Gothic Neo, 없으면 DejaVu Sans)이고 폰트 파일을 묶지 않는다. PNG 바이트 동등성은 요구하지 않고 수치·축·라벨·빈 부분·실패 격리·파일 형식을 비교한다.
- Decision(2026-10-28, 스토리 계획): tracer는 1이다. 합성 GarminPort endpoint 한 건이 coverage → raw(새 수집 dataset) → 정규화 v8 건강 행 → "현재" view까지 가고, 같은 일감을 다시 돌려도 늘지 않으며, 회수된 attempt token의 쓰기는 거부된다. 네트워크는 쓰지 않는다. 다음은 가장 덜 확실한 2(인증·계정 보호)다. 그다음 3(전수 수집·재개), 4(전수 정규화·권위 v2·동등성), 5(body·digest), 6(그래프·파일 요청), 7(수집 사건 알림), 8(Refactor sweep), 9(이 Mac 전환·실수집)이다. 코드 조사의 순서안 A를 따르되 S5를 5와 6으로 나눴다(한 세션 크기).
- Decision(2026-10-28, 스토리 계획): `extensions/garmin/`의 manifest·lock·store port·garmin 마이그레이션·worker를 모든 스토리가 함께 고친다(코드 조사 10절). 그래서 1~9는 한 줄이다. 1은 epic 14의 마지막 코드 스토리(14.7)를 기다린다(14.1이 15.6을 기다린 선례). epic 12~15 쪽 entry에는 인계 문장을 더하지 않는다. 받는 쪽이 무엇을 받는지 적고, 실제 시그니처는 그 HEAD에서 확인한다(앞 에픽들과 같은 명시적 예외).
- Decision(2026-10-28, 추천으로 정함): 모든 entry가 `hitl = false`다. 9의 실수집은 위임에 따라 에이전트가 하고, MFA가 필요할 때만 그 단계가 `awaiting-operator`다. 원격 push가 있어야만 하는 단계는 `operator_actions`에 남긴다.
- Decision(2026-10-28, 추천으로 정함): risk와 그 이유.
  - 1 high: connector가 처음 core 계약에 쓰는 길이다. 틀리면 2~9가 다시 만든다.
  - 2 high: 계정 보호가 틀리면 Garmin 계정이 차단되거나 MFA 뒤에도 계속 호출한다.
  - 3 high: 재개가 틀리면 날짜가 빠지거나 같은 날을 계속 다시 받는다.
  - 4 high: 불변 이력·권위 v2가 틀리면 "현재" 값이 이전 값과 섞인다.
  - 5 medium: digest가 틀리면 분석 입력이 틀린다. 동등성 fixture가 막는다.
  - 6 medium: 그래프가 빠지면 결과 묶음이 빈다. 평가는 남는다.
  - 7 medium: 알림이 틀리면 놓치거나 같은 날 여러 번 간다. 의미 키가 막는다.
  - 8 low: 정리다.
  - 9 high: 옛 예약과 새 예약이 겹치면 계정 차단 위험이 있다.
- Decision(2026-10-28, 세트 검증 F1): 전환은 무중첩 순서다. 새 쪽 보류 그룹 `extension:garmin`으로 예약·수동 실행·청구를 먼저 막고 진행 attempt가 없음을 확인한 뒤, 보류 상태에서 확장을 갱신한다. 옛 collect(수집을 부르면 report도)의 등록 부재와 writer 종료를 확인한 뒤에만 보류를 풀고 예약을 등록한다. 종료가 불명이면 전환을 멈춘다. 복구는 새 쪽 보류·예약 제거 → 새 수집 종료 확인 → 옛 plist 복원 순이다. 공통 설치 API가 보류 중 갱신을 지원하지 않으면 옛 수집 중지를 설치보다 먼저 한다.
- Decision(2026-10-28, 세트 검증 F2): 설정·선언·의존의 완성 담당. 2는 인증·호출 보호 설정, 3은 수집 설정·기본 collect/retry 예약 선언·옛 `_DEFAULTS` 전체 대응표(새 이름·타입·기본값·제외 사유), 5는 `artifacts` 선언과 collect 의존, 6은 결합 lock의 최종 frozen 확인(jsonschema·requests는 직접 쓰는 것만 직접 의존으로 두고 나머지는 전이 의존으로 충족됨을 확인), 9는 이미 만든 선언을 설치본에서 실행한다. 분석 설정은 epic 18이다.
- Decision(2026-10-28, 세트 검증 F3, epic 18과의 인계 계약): 16.5는 digest 일 값 건강 요약 행에 더해 전체 digest JSON을 `file_requests`로 등록하고, 요청 metadata에 수집 결과 id·UTC cutoff·시간대·현지 날짜·산출 revision을 담는다. 16.6의 그래프 요청은 현지 날짜·이름·역할(앨범을 가르는 명시적 값)·수집 결과 id·revision을 담는다. cutoff는 collect가 ABI 결과 요약에 싣는 수집 snapshot 시각(UTC ms)이고, core가 일감 결과로 보관해 epic 18이 읽는다. collect·artifacts 성공을 기다리는 분석 의존은 epic 18(18.7)이 만든다. epic 18의 `body_intake`가 쓰는 측정 JSON은 사용자가 넣는 것과 같은 계약으로 16.5가 읽는다.
- Handoff(2026-10-28, epic 16 세트 검증 F3): epic 18에 주는 것. 18의 입력 snapshot은 16.5가 publish한 digest 일 값 건강 요약 행과 catalog·"현재" view를 읽고, 전체 digest JSON은 같은 수집 결과·cutoff에 연결된 core 파일로 받는다. 결과 묶음은 16.6의 현지 날짜·그래프 이름·역할·revision과 core 등록 완료 결과로 고른다. 옛 report 전환은 16.9가 남긴 상태를 받아 18.9가 중지·진행 평가 종료를 확인한 뒤 새 예약을 켠다. 18의 intake 결과는 16.5가 읽는 측정 JSON과 원본 참조 계약으로 쓴다. epic 17은 같은 catalog·"현재" view를 읽고 Python digest를 부르지 않으므로 이 에픽을 기다리지 않는다.
- Decision(2026-10-28, 세트 검증 F4): high entry의 추가 확인(verify와 별도, leaf를 만들 때 이어받는다).
  - 1: fake client 경로가 운영과 다른 Brain 홈·DB에서만 열리는지 따로 점검한다.
  - 2: 보호 상태의 DB 쓰기가 실패하면 fail closed(호출 0)이고 재시작 뒤에도 호출이 없다.
  - 3: 라이브러리 내부 retry와 wrapper 호출 간격의 보장 범위를 따로 검토해 plan에 적는다.
  - 4: 서로 다른 두 raw revision을 동시에 publish해도 늦게 끝난 쪽이 현재를 옛 값으로 되돌리지 않는다.
  - 9: 공개 plan에 건강값·계정 id·토큰이 없는지 따로 검사한다.
- Decision(2026-10-28, 세트 검증 F5): 8(Refactor sweep)은 코드 스토리 1~7의 정리를 닫는다. 9의 배포·전환·실수집은 그 뒤 따로 둔다(앞 에픽들과 같은 예외). 9에서 찾은 기능 문제는 버그 스토리로 고치고 8로 밀어 넣지 않는다. MFA·차단·미실행·실패는 실수집 성공으로 세지 않는다.
- Decision(2026-10-28, 세트 검증 S1·S2·S3 채택): 각 plan은 시험 진입점, 환경 사전 조건, 동기화된 crash hook, 대상 프로세스, 재시작, 관찰의 공개 투영, 정리를 적는다(2는 보호 상태 commit 직후, 3은 날짜 checkpoint commit 전/후, 5는 파일 요청·완료 확인·원본 이동 경계, 7은 사건+요청 commit 전 rollback과 commit 뒤 core 재발견). clock은 12.1, 가짜 Telegram 서버는 15.1의 것을 쓴다. 코드 조사 7절의 pin 3.14.8은 옛 archive 값이고 새 배포 pin은 3.14.10이다(조사 문서에 정정 줄을 더했다). 그래프 라벨은 실제 선택된 font face의 한국어 glyph와 missing-glyph 경고 부재로 확인한다.
- Handoff(2026-10-28, epic 18 재검증 F7): 18의 `body_intake`가 그날 artifacts보다 늦게 끝내 쓴 측정 JSON도 16.5가 다음 artifacts 실행에서 한 번만 병합한다(날짜가 아니라 아직 병합하지 않은 측정을 읽는다).
- Handoff(2026-10-28, spine 갱신 u3 adversary B): manifest의 `garmin.tokenstore`는 비밀 참조가 아니라 경로 설정이다. Runtime은 경로만 snapshot에 넘기고, Garmin 인증 adapter가 그 위치의 세션 내용을 라이브러리로 연다(spine AD-18 예외). epic 13의 snapshot 규칙(13.2)은 이 키를 `.env` 비밀로 해석하지 않는다.
- Decision(2026-10-30, 사용자): 에픽마다 두던 Refactor sweep(16.8)을 뺐다(`dropped`). 리뷰가 미룬 기존 결함은 `deferred-work.md` 장부에 남고, 사용자가 원할 때 `bmad-loop sweep`으로 직접 처리한다. 이 Mac 확인(16.9)은 sweep 대신 sweep이 기다리던 스토리들을 기다린다.
- Decision(2026-10-30, 추천으로 정함): 16.1은 14.7 sweep 대신 확장 뼈대·raw schema(14.1)와 지표 catalog·현재 view(14.2)를 기다린다. 합성 fake client tracer는 전수 반입·검증 보고서와 무관하다. 실제 시그니처·마이그레이션 번호는 착수 시점 main HEAD에서 확인한다(예전 마지막 코드 스토리 대기 결정을 대체).
