---
type: epic
title: "core 건강 분석"
parent: personal-brain
covers: [R2, R10, R11, R12]
sources: [_bmad-output/personal-brain/initiative-personal-brain.md, _bmad-output/personal-brain/architecture-brain-v1-slice-1/architecture-brain-v1-slice-1.md]
companions: [_bmad-output/personal-brain/architecture-brain-v1-slice-1/architecture-brain-v1-slice-1.md, _bmad-output/personal-brain/prep-garmin-absorption/integration-boundaries.md, _bmad-output/personal-brain/tickets/epic-health-analysis/epic-health-analysis-research-code.md]
after: []
refined: true
risk: high
---

# core 건강 분석

## Description

건강 평가를 core 일감으로 만든다(AD-35). 예약된 core 일감이 분석 에이전트(사용자 설정의 모델 CLI, 기본은 이 Mac의 Codex 로그인)를 띄우고, 에이전트는 core 데이터만 읽는다(건강 계약 표, 필요할 때 `<ext>.raw_records`). 범위는 다음과 같다.
- 입력 snapshot: Garmin `report_input`의 snapshot·cutoff·scrub 의미를 core 계약 표 위로 옮긴다. 입력 snapshot·cutoff, 건강 revision, 소스 권위, 시간대를 고정해 분석 그래프 안에서 공유한다.
- 평가: day → 7d → 30d → all을 일감 의존으로 표현한다. 각 scope는 출력 schema 검증을 거친 뒤 바로 `analyses`와 리포트 파일(FileStore, AD-23)로 확정되고, 선행 analysis ID를 남긴다. 재시작은 저장된 성공부터 잇는다.
- `analyses`: epic-garmin-import가 만든 최소 계약·DDL을 호환 확장한다. 이전된 기존 분석을 덮거나 재분석으로 대체하지 않는다(R7).
- 결과 묶음: 평가와 epic-garmin-runtime이 만든 그래프 파일을 묶어 채널 발신 요청으로 보낸다. 후속 평가·그래프·발신 실패가 성공한 평가를 되돌리지 않는다.
- 모델 실행 adapter는 Runtime이 Core 실행 port에 조립한다. 모델 CLI와 하위 프로세스는 취소·실패 때 그룹 정리·reap한다(AD-33). 모델 입력·도구 응답은 출력 코덱으로 가린다(AD-11).

Garmin의 `report`·JSON schemas·skills와 report-codex 테스트가 출발점이다(2026-10-28, 이니셔티브 R2·R10·R11·R12, 옛 epic 16에서 분할).

코드 조사(2026-10-28, `epic-health-analysis-research-code.md`)가 찾은 것은 다음과 같다.
- 옛 일반 실행은 오늘 day 평가가 있으면 전체를 건너뛴다. day 성공 뒤 죽으면 7d 이후를 복구하지 않는다. 저장은 `(report_date, scope)` UPSERT라 재생성이 원래 성공을 덮는다. 둘 다 새 계약(scope별 재개, 재생성은 새 행)과 다르다.
- 옛 day와 각 기간은 서로 다른 DB read snapshot이고, raw 표는 최신본이라 과거 값을 복구할 수 없다. 네 scope가 같은 입력을 보려면 snapshot을 따로 남겨야 한다.
- 옛 report는 한 scope가 실패해도 다음 scope를 돌린다. 수집 대기는 시각 polling(최대 30분)이고, 대기 만료·차단에도 평가를 진행한다.
- 옛 Writer는 model이 비어 있으면 실행을 거부하고 항상 `-m`을 넣는다. "모델은 CLI 기본"은 새 결정의 동작이다(`-m` 생략).
- 체성분 사진 → 측정 JSON(body intake)도 옛 report 안의 Codex 호출(이미지 입력)이다. 모델 호출이므로 core 일감이다.
- 옛 결과 묶음에는 중복 방지 gate가 없다. 그래프는 파일 이름 앞 두 자리로 두 앨범을 가른다.
- 이 Mac에는 `codex` CLI와 로그인 파일이 있다(존재만 확인, 유효성은 아님).

## Outcome

Garmin 사용자가 예약된 시각에 day·7d·30d·all 평가를 받고, 성공한 평가는 발신 결과와 상관없이 남는다(이니셔티브 Done when 8의 분석 부분).

## Requirements

- E18-1 (R11, R12): 입력 snapshot — 분석 그래프 하나는 snapshot 하나를 만들어 네 scope와 결과 묶음이 함께 읽는다. snapshot에는 현지 날짜와 IANA 시간대, 수집 결과가 나른 UTC cutoff, 운동 창, 수집·artifacts 결과 id, catalog·정규화 버전, 건강 행 revision 목록("현재" view, ambiguity 제외), 권위 규칙 버전, raw export(`garmin.raw_records`를 cutoff·endpoint 필터와 식별자 scrub으로 내보낸 바이트), epic 16의 digest JSON·그래프 파일 참조, body·profile·종목 labels 참조, 선행 분석 목록이 고정된다. 선행 선택은 옛 규칙과 같다(day는 정확히 어제의 day·7d와 어제 본문, 7d는 창 안의 모든 day, 30d는 끝 날짜 이하 최근 7d 다섯, all은 월별 마지막 30d, 각 기간의 previous는 같은 scope의 앞선 최신 하나). 긴 DB 트랜잭션을 열어 두지 않고 snapshot 바이트를 남긴다. 같은 합성 fixture에서 옛 SQLite reader와 파일 목록·JSON 값·배열 순서·notes·NULL·선행 선택이 같다. (AD-13·30·32·35)
- E18-2 (R12; AD-35): 평가 그래프 — day → 7d → 30d → all은 epic 12의 일감 의존이다. 각 scope는 출력 schema 검증을 통과하면 바로 `analyses`와 리포트 파일로 확정되고, 그 확정 트랜잭션이 다음 scope를 푼다. scope가 실패하면 뒤 scope는 `dependency_failed`로 닫히고 실패 알림이 나간다. 재시작은 저장된 성공 scope부터 잇고 모델을 다시 부르지 않는다. 오래된 attempt의 확정은 거부된다. 명시적 재생성은 새 revision의 새 행이다. 모델 호출과 FileStore I/O는 트랜잭션 밖이다.
- E18-3 (R12, R7; C5): `analyses` 호환 확장 — epic 14의 최소형에 묶음 id·현지 날짜·시간대·scope, 평가·프롬프트·출력 schema revision, 입력 snapshot id, 선행 분석 관계(별도 관계 표), agent·요청 모델·알려진 실제 모델·effort, 일감·attempt·usage·걸린 시간, 출력 JSON을 더한다. 행은 불변이고 file_id를 UPDATE하지 않는다. 실패 attempt는 `analyses` 행이 되지 않는다. 이전된 분석은 바뀌지 않고 선행 분석으로 읽힌다. 알 수 없는 값은 NULL이고 추정하지 않는다. (AD-32·35)
- E18-4 (R10, R12): 모델 adapter와 설정 — 사용자 설정 `analysis.agent`(`codex` | `claude-code`, 기본 `codex`), `analysis.model`(NULL이면 CLI 기본, 인자를 생략), `analysis.effort`(기본 `high`, CLI가 지원하지 않는 값은 오류), `analysis.timeout_minutes`(기본 20)를 설정 코덱이 실행 시작 snapshot으로 넘긴다. Codex adapter(`codex exec … --json`, usage는 `turn.completed`)와 Claude Code adapter(`claude -p … --output-format json`, usage는 결과의 `usage`)는 Core 실행 port 구현이고 Runtime이 설정에 맞는 것을 조립한다. 두 adapter는 같은 출력 schema 검증, 그룹 정리·reap(AD-33), ABI v1 `usage`(세 값이 모두 비음수 정수일 때만, 없으면 unknown)를 지난다. 20분은 호출 timeout, 25분은 진행 없는 정체 창(12.5)이다. 설정한 CLI가 없거나 로그인되지 않았으면 다시 하지 않는 오류로 `failures`에 남고 doctor가 보인다. 모델 프로세스에는 DB 비밀을 넘기지 않는다. (AD-18·33·35)
- E18-5 (R12; AD-11): 프롬프트·schema v1과 가리기 — 옛 `garmin-daily-analysis`·`garmin-period-review` skill, 출력 schema 둘, 프롬프트 template을 v1으로 그대로 저장소 리소스에 두고 빌드 산출물에 포함한다. Claude Code에는 같은 원문을 읽히는 wrapper를 둔다. 모델이 읽는 입력 폴더 export와 도구 응답은 출력 코덱을 거친다(prompt 문자열만이 아니다). 모델에게는 export와 scratch만 보이고 DB URL·보존 원문·다른 홈 파일은 보이지 않는다.
- E18-6 (R12; AD-23): 리포트 파일 — scope별 Markdown 본문은 core 분석 일감이 FileStore에 직접 넣고 core 등록 use case로 파일·위치·추출 일감을 만든 뒤, `analyses`와의 파일 관계 행을 더한다(`file_requests`는 확장용이라 쓰지 않는다). 파일 준비와 DB 확정 사이에 죽어도 같은 scope 결과로 수렴하고 모델을 다시 부르지 않는다. 문서 추출을 타서 epic 17의 검색 대상이 된다.
- E18-7 (R12; R13은 epic 15 경유): 결과 묶음과 실패 알림 — 묶음은 요약(day+7d+30d+all, UTF-16 4000 넘으면 뒤 기간 줄부터 버리고 마지막에 day를 자름) → 앨범(epic 16 그래프 `file_requests`의 결과 file_id, 그래프 역할 metadata로 두 묶음, 10장씩) → 전문(Markdown 파일)이다. 의미 키는 `(분석 묶음 id, Garmin 봇·채팅 conversation, health-report, 묶음 revision)`이다. `REPORT_FAILED`는 `(계정+현지 날짜의 안정 실패 사건 id, conversation, report-failed, 템플릿 revision)`으로 날짜당 한 번이다. 발신 실패·불명은 평가를 지우거나 모델을 다시 부르지 않는다. 확정된 파일만 묶음에 넣는다.
- E18-8 (R10, R16): 예약과 끄기 — 기본 예약은 현지 11:30(core `timezone`)이고 오늘 날짜의 분석 그래프를 넣는다. 그래프는 같은 날짜의 epic 16 `collect`·`artifacts` 성공 결과를 선행 의존으로 기다린다(시각 polling 없음). 수집이 실패하면 `dependency_failed`와 실패 알림이다. 여러 날을 놓친 뒤 깨어나면 수집이 끝난 가장 최근 날짜 하나만 평가하고 빠진 날의 day를 소급하지 않는다. 수동 실행은 같은 일감 계약으로 합쳐진다. 분석 예약과 그 일감은 보류 그룹 `extension:garmin`을 붙인다(12.10): 끄면 예약·청구가 멈추고 진행은 취소되며, 켜면 대기부터 잇는다. 저장된 평가와 이전된 분석은 남는다.
- E18-9 (R2, R11): 체성분 intake — inbox의 체성분 사진 중 측정 JSON이 없는 것에 core `body_intake` 모델 일감이 같은 adapter로 옛 body-intake skill·schema v1을 돌려, 검증한 측정 JSON을 epic 16이 읽는 inbox 자리에 원자적으로 쓴다. 검증 실패·모델 실패는 그 사진을 pending으로 남기고 다시 시도한다. 체성분 병합과 원본 파일 등록은 epic 16 몫이다.
- E18-10 (R2; Done when 5·6): 전환과 이 Mac — 플러그인 배포 뒤 설치본에서 분석 설정 기본값과 11:30 예약을 등록하고, 옛 `local.garmin-pipeline.report` LaunchAgent가 아직 있으면 내린다(plist는 복구용으로 남김). 옛 평가와 새 평가가 같은 날을 함께 만들지 않는다. 에이전트가 실계정 평가 한 번을 돌려 형식·순서·저장·파일·usage·발신 상태를 확인한다. 모델 품질 판단은 사람 몫이다.

## Constraints

- 모델은 일감 안에서만 부르고, hook·동기 명령 경로에서는 부르지 않는다(AD-33).
- 외부 호출(모델·발신) 동안 DB 쓰기 트랜잭션을 잡지 않는다.
- 이전된 분석과 저장된 평가를 덮거나 지우지 않는다(R7). 다시 만들기는 새 행이다.
- 시험은 fake 모델 CLI(두 adapter 모양)와 합성 fixture로 한다. 실모델은 마지막 이 Mac 스토리에서 한 번이고, fake E2E로 품질을 주장하지 않는다(E6).
- 공개 plan에는 실제 건강값·분석 본문·계정 식별자를 쓰지 않는다.

## Done when

1. 같은 합성 fixture에서 입력 snapshot(입력 필터·report-input)이 기존 구현과 같다.
2. day → 7d → 30d → all이 순서대로 돌고 각 성공이 바로 보존된다. 중간에 죽이거나 취소한 뒤 다시 돌리면 저장된 성공부터 잇고, 이전된 기존 분석은 그대로다.
3. 긴 평가 중에도 대화 수집이 진행되고, 모델 CLI가 멈추거나 취소되면 프로세스 그룹이 정리된다(fake 모델 CLI).
4. 발신 실패는 평가를 지우지 않고, 같은 결과 묶음은 한 번만 나간다.
5. 공통 스케줄러 예약으로 수집 뒤 평가가 돈다. 실계정 평가 한 번은 에이전트가 형식·순서·저장으로 확인하고(2026-10-28 위임), 모델 품질은 사람이 판단한다(fake 모델 E2E만으로 품질을 주장하지 않는다, E6).
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
- research — _bmad-output/personal-brain/tickets/epic-health-analysis/epic-health-analysis-research-code.md (2026-10-28 정적 코드 조사)
- evidence — _bmad-output/personal-brain/tickets/epic-health-analysis/epic-health-analysis-health-query-performance-evidence.md, 사용자 결정·측정 근거·유지할 계약(18.10)

## Notes

- Waits on epic-test-time because: 18.3이 시험 시간 개선 19.5·19.6·19.1·19.2·19.3·19.7·19.10을 기다린다(2026-11-04 사용자 결정 A, 순서 결정). epic-test-time은 19.5에서 18.10을 실제 선행으로 기다리므로 `tickets.py status`의 `order_conflict` 중 `{epic: epic-test-time, after: epic-health-analysis}` 1건은 2026-11-04 사용자 승인 예외다. 티켓 선택을 막지 않으며, 순서를 바꾸거나 에픽을 합치지 않는다. 근거는 epic-test-time Notes.
- Waits on epic-jobs-and-scheduler because: 일감 의존, 모델을 부르는 일감의 감독(자식 프로세스 그룹·취소·reap), 긴 평가의 임대 갱신, 현지 시각 예약을 쓴다.
- Waits on epic-garmin-import because: `analyses` 최소 계약·DDL을 호환 확장하고, 이전된 기존 분석이 선행 analysis와 재시작 지점이며, 건강 계약 표의 "현재" view를 읽는다.
- Waits on epic-channels because: 결과 묶음을 채널 발신 요청(의미 키 UNIQUE, 최초 시도 gate)으로 보낸다.
- Waits on epic-garmin-runtime because: 새 수집이 넣는 정제 행(digest)과 그래프 파일 등록 요청이 새 날짜의 분석 입력과 결과 묶음의 그래프다.
- Decision(2026-10-28, 사용자): 옛 epic 16(Garmin 수집·분석)에서 나눈 에픽이다. spine AD-35(분석은 core 일감)를 따른다. R11 중 입력 필터(report-input)를 맡는다.
- Decision(2026-10-28): 분석 에이전트의 프롬프트와 출력 schema는 옛 Garmin `report`의 프롬프트·JSON schema를 v1로 그대로 쓴다(S11 재사용). 바꾸는 일은 실사용 뒤 새 revision으로 한다. 이전의 Open question과 spine Deferred "분석 에이전트의 프롬프트와 출력 schema"를 대신한다.
- Decision(2026-10-28, 사용자): 분석 에이전트와 모델은 사용자가 바꿀 수 있다. 사용자 설정(DB, AD-18)에 에이전트(모델 CLI adapter 이름), 모델, effort를 둔다. 기본값은 옛 Garmin과 같다(Codex, 모델은 CLI 기본, effort high, 호출 timeout 20분). 이 에픽은 Codex adapter와 Claude Code adapter를 만들고, 둘 다 같은 출력 schema 검증과 그룹 정리·reap을 지난다. adapter는 토큰 사용량을 프로세스 ABI v1의 `usage` 칸에 채운다(epic-jobs-and-scheduler Notes 같은 날).
- Source conflict(2026-10-28): spine AD-35의 "모델 실행 adapter는 이 Mac의 Codex 로그인 환경을 사용"은 위 결정과 다르다. 설정에서 고른 모델 CLI의 로그인 환경으로 넓힌다. 이 에픽 정제 전에 `bmad-architecture`로 고친다. → 2026-10-28 spine AD-35 갱신으로 해소했다(6dd6a55).
- Decision(2026-10-28, 사용자): Garmin 확장을 끄면 Garmin 데이터를 읽는 분석 예약도 멈추고, 진행 중인 평가는 감독자 취소로 끊으며, 대기 일감은 보류했다가 다시 켜면 이어서 돈다. 이미 저장한 평가와 이전된 분석은 남고 검색된다(epic-jobs-and-scheduler Notes 같은 날). 이전의 Open question을 대신한다.
- Decision(2026-10-28): 기본 분석 예약은 옛 Garmin 값인 11:30이다. 리포트 실패 알림(옛 `REPORT_FAILED`)도 채널 발신 요청으로 옮긴다.
- Assumption(2026-10-28): 여러 날을 놓친 뒤 깨어나면 수집이 끝난 최신 날짜만 평가하고, 빠진 날의 day 평가를 소급해 만들지 않는다(옛 report의 동작으로 짐작). 정제 때 옛 코드로 확인한다. → 2026-10-28 코드 조사 7절: 소급하지 않는 것은 확인됐다. "수집이 끝난 최신 날짜"를 고르는 로직은 옛 코드에 없어 E18-8로 새로 정했다(아래 Decision).
- Handoff(2026-10-28, epic 12 세트 검증 F4): Garmin을 끄면 분석도 멈추게 연결하는 일은 이 에픽의 몫이다. 분석 일감과 예약을 넣을 때 epic 12의 보류 그룹 `extension:garmin`을 붙인다(12.10). 평가 순서는 12.6의 의존 use case로, 모델 일감의 정체 창 25분은 12.5로, 토큰은 12.4의 `usage` 칸으로 운반한다. 옛 Garmin `report.py`의 `_usage`는 `codex exec --json`의 `turn.completed`에서 토큰을 읽는다(epic 12 코드 조사 6절). adapter는 그 방식을 이어받는다.
- Handoff(2026-10-28, epic 14 세트 검증 F2): epic 14에서 받는 것. 입력 snapshot은 14.2의 계약 문서·공유 fixture와 "현재" view를 읽고 ambiguity를 입력에서 뺀다. `analyses`는 14.1·14.5가 만든 최소형(legacy 키·dataset·batch·nullable 모델/시각과 누락 flag·파일 요청 관계·core가 확정하는 파일 관계)을 호환 확장하고, 이전된 분석 행을 바꾸지 않는다. 리포트 파일은 같은 파일 관계로 잇는다. 쪼갤 때 이 entry들로 교차 `after`를 고정한다.
- Decision(2026-10-28, 정제, 추천으로 정함): 입력 snapshot은 분석 그래프마다 하나이고 바이트로 남긴다. cutoff는 그래프가 기다린 수집 결과가 나른 값이다(옛 report는 시작 시각을 썼지만, 데이터는 수집된 것뿐이라 결과가 같고 네 scope가 같은 입력을 본다). digest는 이 에픽이 다시 계산하지 않는다. epic 16의 `artifacts`가 같은 수집 결과로 만든 digest JSON 파일과 일 값 건강 행을 읽는다(epic 16 Handoff로 적었다).
- Decision(2026-10-28, 정제, 추천으로 정함): 평가 순서는 엄격한 의존이다. 옛 report는 한 scope가 실패해도 다음을 돌렸지만, 그러면 7d가 오늘 day 없이 요약된다. 실패한 scope는 AD-21의 재시도를 받고, 끝내 실패하면 뒤 scope는 `dependency_failed`로 닫히며 `REPORT_FAILED`가 나간다.
- Decision(2026-10-28, 정제, 추천으로 정함): 설정 키는 `analysis.agent`·`analysis.model`·`analysis.effort`·`analysis.timeout_minutes`다. 기본값은 사용자 Decision 그대로(Codex, CLI 기본 모델, high, 20분). profile은 사용자 파일로 `analysis.profile_path`(홈 기준 `~/` 경로, 기본 없음)이고 snapshot을 만들 때 core 파일로 복사해 고정한다. 이 Mac에서는 18.9가 옛 profile을 찾으면 설정한다.
- Decision(2026-10-28, 정제, 추천으로 정함): 리포트 파일은 core 분석 일감이 FileStore에 직접 넣는다(코드 조사 5절 선택지 A). core가 생산자라 확장용 `file_requests`를 거칠 근거가 없다. `analyses` 행은 불변이고 파일 관계는 별도 행이다.
- Decision(2026-10-28, 정제, 추천으로 정함): 체성분 intake(사진 → 측정 JSON)는 이 에픽의 core 모델 일감이다. 모델 호출은 core 일감이라는 AD-33·35를 따른다. 결과 JSON은 epic 16이 읽는 inbox 자리에 사용자 입력과 같은 계약으로 쓴다. 병합·원본 등록은 epic 16 몫이다(epic 16 Handoff로 적었다).
- Decision(2026-10-28, 정제, 추천으로 정함): Claude Code adapter 인자는 `claude -p <prompt> --model <model> --effort <effort> --output-format json`이고 usage는 결과의 `usage`다(spine currency 리뷰 2026-10-28이 공식 문서로 확인). 공급자의 structured output 기능에 기대지 않고 두 adapter 모두 core가 같은 schema로 다시 검증한다. 설치 버전의 실제 출력 fixture는 18.4가 만든다.
- Decision(2026-10-28, 정제, 추천으로 정함): 결과 묶음의 앨범은 파일 이름 숫자가 아니라 epic 16 그래프 요청의 역할 metadata로 가른다. 의미 키의 생산 결과 식별자는 분석 묶음 id이고, 같은 묶음을 다시 조립하면 같은 키, 명시적 재생성은 새 묶음 revision이다.
- Decision(2026-10-28, 정제, 추천으로 정함): 옛 report LaunchAgent는 18.9가 새 11:30 예약을 켜기 전에 내린다(epic 16이 이미 내렸으면 확인만). plist는 남기고, 옛·새 평가를 동시에 켜지 않는다. → 2026-10-28 세트 검증 F1로 순서를 고정했다(아래).
- Decision(2026-10-28, 스토리 계획): tracer는 1이다. 고정 합성 snapshot(day 하나)이 감독되는 core 일감에서 fake 모델 CLI(Codex 모양)를 거쳐 schema 검증을 지나 `analyses` 행과 리포트 파일로 확정되고 되읽힌다. 다음은 가장 덜 확실한 2(입력 snapshot의 옛 구현 동등성)다. 그다음 3(네 scope 의존·재개·revision), 4(두 adapter·장애 행렬), 5(체성분 intake), 6(결과 묶음·실패 알림), 7(예약·끄기), 8(Refactor sweep), 9(이 Mac 전환·실평가)다. 코드 조사의 순서안 A를 따르되 T7을 sweep과 이 Mac 확인으로 나누고 intake를 더했다.
- Decision(2026-10-28, 스토리 계획): core 분석 코드·PG 마이그레이션·Store·조립(`apps/cli/src/assembly.ts`)·출력 코덱 등록부를 모든 스토리가 함께 고친다(코드 조사 8절). 그래서 1~9는 한 줄이다. 1은 epic 16의 마지막 코드 스토리(16.8)를 기다린다(앞 에픽 선례). epic 12~16 쪽 entry에는 인계 문장을 더하지 않고, 받는 쪽이 적는다(같은 명시적 예외).
- Decision(2026-10-28, 추천으로 정함): 모든 entry가 `hitl = false`다. 9의 실평가는 에이전트가 형식·순서·저장으로 확인한다. 로그인 갱신이 필요하면 그 단계만 `awaiting-operator`이고, 모델 품질 판단은 사람 몫 목록에 있다.
- Decision(2026-10-28, 추천으로 정함): risk와 그 이유.
  - 1 high: core가 처음 모델을 부르고 결과를 저장하는 길이다.
  - 2 high: 입력이 틀리면 평가가 틀린 데이터를 근거로 삼는다.
  - 3 high: 재개가 틀리면 성공한 평가를 덮거나 모델을 두 번 부른다.
  - 4 high: 프로세스 정리가 틀리면 모델 CLI가 남아 돌거나 토큰이 샌다.
  - 5 medium: intake가 틀리면 체성분 입력이 빠진다. 사진은 남는다.
  - 6 medium: 묶음이 틀리면 리포트가 빠지거나 두 번 간다. 평가는 남는다.
  - 7 medium: 예약이 틀리면 평가가 안 돌거나 수집 전에 돈다.
  - 8 low: 정리다.
  - 9 high: 옛·새 평가가 겹치거나 실모델에서만 드러나는 실패를 놓친다.
- Handoff(2026-10-28, epic 16 세트 검증 F3): epic 16에서 받는 것. 16.5의 digest 일 값 건강 요약 행과 전체 digest JSON 파일(요청 metadata: 수집 결과 id·UTC cutoff·시간대·현지 날짜·revision), 16.6의 그래프 파일(현지 날짜·이름·역할·수집 결과 id·revision), collect ABI 결과 요약의 cutoff(core 일감 결과). 분석 의존(collect·artifacts 성공 대기)은 18.7이 만든다. 옛 report 전환은 16.9가 남긴 상태를 받아 18.9가 한다. `body_intake`의 측정 JSON은 16.5가 읽는 계약으로 쓴다.
- Decision(2026-10-28, 세트 검증 F1, epic 16 재검증 F6): 전환 순서. 새 분석 예약·청구를 보류한 상태로 설정한다 → 16.9의 전환 상태를 읽고 옛 report의 등록 부재와 진행 평가 프로세스 종료를 확인한다 → 그 뒤에만 11:30 예약을 등록하고 보류를 푼다. 종료가 불명이면 전환을 멈추고 실평가 성공으로 세지 않는다. 복구는 새 예약 보류·제거 → 새 평가 종료 확인 → 옛 plist 복원 순이다.
- Decision(2026-10-28, 세트 검증 F2): 모델 접근과 진단의 보호 분담. 1은 export 가리기의 최소형, 4는 두 adapter의 실행 port 접근 제한(cwd=scratch, CLI sandbox·도구 허용 목록, CLI 로그인 자료 외 홈 파일 미전달, env 허용 목록), 도구 응답 가리기, 진단 정책(원 stdout·stderr·이벤트·출력 JSON은 private scratch에 두고 검증 뒤 삭제, `failures`·로그·plan에는 허용 목록의 코드·단계·상태만)을 끝낸다. 4는 격리 홈에 심은 합성 표식의 부재로 검증하고, 9는 실제 모델이 scratch 밖 표식 파일을 읽지 못하는지 한 번 확인한다. 일반 비밀 패턴이 건강값을 다 가리지 못하므로 공개 출력은 허용 칸만 투영한다.
- Decision(2026-10-28, 세트 검증 F3·F4): Done when 3의 "긴 평가 중 대화 수집 진행"은 4가 검증한다(fake 모델이 기다리는 동안 수집·drain이 새 메시지를 확정). 20분 timeout과 25분 정체는 설정을 나눠 시험한다(기본 20분 timeout 사례, `analysis.timeout_minutes` > 25인 무진행 사례). 시간은 12.1의 가짜 clock, 프로세스 정리는 실제 OS 자식·손자로 확인한다.
- Decision(2026-10-28, 세트 검증 F5): high entry의 추가 확인(verify와 별도, leaf를 만들 때 이어받는다).
  - 1: 빌드·배포 산출물에서 v1 리소스(skill·schema)가 발견되는지 따로 확인한다.
  - 2: cutoff·선행 선택 기대값을 reader 작성자와 따로 손으로 계산해 대조한다.
  - 3: 이전된 analysis 행과 파일 관계가 재생성 뒤에도 바이트까지 그대로인지 따로 점검한다.
  - 4: 정상 리더 종료 뒤 남은 자손의 처리 경계를 따로 검토해 plan에 적는다.
  - 9: 공개 plan·로그에 분석 본문·건강값·계정 id가 없는지 따로 검사한다.
- Decision(2026-10-28, 세트 검증 F6): 8(Refactor sweep)은 코드 스토리 1~7의 정리를 닫는다. 9의 배포·전환·실평가는 그 뒤 따로 둔다(앞 에픽들과 같은 예외). 9에서 찾은 기능 문제는 버그 스토리로 고치고 8로 밀어 넣지 않는다. 로그인 문제·미실행·모델 실패는 실평가 성공으로 세지 않고, 9가 끝날 때까지 Done when 5·6 완료를 주장하지 않는다.
- Decision(2026-10-28, 세트 검증 S1, 추천으로 정함): `body_intake`는 자기 현지 예약(기본 10:45, 수집 11:00 전)과 수동 실행으로 들어간다. 그날의 artifacts(수집 뒤)가 새 측정 JSON을 그대로 읽으므로 artifacts → 분석 → intake → artifacts의 순환이 생기지 않는다. 그보다 늦게 넣은 사진은 다음 날 처리되고, 바로 원하면 수동 실행이다. 수집·정제에 모델을 넣지 않는다.
- Decision(2026-10-28, 세트 검증 S2 채택): 각 plan은 crash hook을 경계별로 적는다(검증 출력의 durable checkpoint, FileStore 넣기 뒤, 파일·analysis 관계 확정 직전·직후, 다음 scope 해제 직전·직후). checkpoint 뒤 중단에서만 모델 호출 수 불변을 주장한다. 2의 SQLite 비교 runner, 4의 두 fake CLI와 실제 OS fixture, 6의 가짜 Telegram 서버도 명령·사전 조건·관찰·정리를 남긴다.
- Decision(2026-10-28, 재검증 F2 잔여): 읽기 거부의 검증을 둘로 나눈다. 18.4의 fake 시험은 두 adapter가 sandbox·도구 허용 인자를 정해진 값으로 넘기는지와, adapter가 도구 호출을 중개하는 경로에서 scratch 밖 요청을 거부하는지까지 보장한다. CLI 자체의 sandbox가 실제로 읽기를 막는지는 18.9가 설치본에서 로그인된 CLI마다 scratch 밖 합성 표식 파일 읽기를 시도해 확인한다(없는 CLI는 미확인으로 기록하고 성공으로 세지 않는다).
- Decision(2026-10-28, 재검증 F7, 추천으로 정함): `body_intake`가 그날 artifacts의 읽기 경계보다 늦게 끝나면 그 JSON은 inbox에 남고 다음 artifacts 실행(다음 날 예약 또는 `brain ext run garmin artifacts` 수동 실행)에서 병합된다. 16.5는 날짜가 아니라 아직 병합하지 않은 측정을 읽으므로 한 번만 들어간다. intake가 artifacts를 다시 넣지 않아 순환이 없다. 10:45 시각은 순서를 보장하지 않는 기본값일 뿐이다.
- Decision(2026-10-30, 사용자): 에픽마다 두던 Refactor sweep(18.8)을 뺐다(`dropped`). 리뷰가 미룬 기존 결함은 `deferred-work.md` 장부에 남고, 사용자가 원할 때 `bmad-loop sweep`으로 직접 처리한다. 이 Mac 확인(18.9)은 sweep 대신 sweep이 기다리던 스토리들을 기다린다.
- Decision(2026-10-30, 추천으로 정함): 18.1의 16.8 레인 대기를 없앤다. 고정 합성 snapshot·fake 모델 tracer는 analyses·파일 관계(14.5)와 ABI(12.4)로 검증한다. 실제 digest·그래프 소비는 18.2·18.5의 16.5, 18.6의 16.6 의존으로 남는다. 예전 16 완료 HEAD·번호 가정 대신 착수 시점 main HEAD에서 확인한다.

- Decision(2026-11-04, 사용자, 건강 조회 성능): 18.2의 입력 snapshot 뒤에 18.10(건강 현재값 조회 성능)을 두고 18.3이 18.10을 기다리게 한다. 18.2는 그대로 완료하며 진행 중인 plan과 Dispatch를 수정·중단하지 않는다. E18-1의 입력·현재값·ambiguity 계약은 바꾸지 않고 조회 방법과 비용을 개선한다. 18.2는 입력 snapshot 동등성, 18.10은 그 경로와 공통 건강 조회의 성능·기존 판정 보존을 맡는다. 완료된 epic 14의 계약은 호환 유지하고 새 사용자 건강 조회 기능(epic 17)은 추가하지 않는다. 이는 현재값 뷰의 성능 개선을 위한 명시적 경계 예외이며, 공통 판정을 프로그램으로 옮길 때도 공개 DB·Store 계약은 유지하고 필요한 호환 마이그레이션·소비자 변경을 함께 검증한다. 구현 방안은 SQL 최적화와 일괄 조회 후 판정을 비교해 정한다. 근거와 측정 한계는 `epic-health-analysis-health-query-performance-evidence.md`에 남긴다.
