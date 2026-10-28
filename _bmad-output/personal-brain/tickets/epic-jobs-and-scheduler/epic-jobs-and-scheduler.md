---
type: epic
title: "공통 작업 runtime과 스케줄러"
parent: personal-brain
covers: [R8, R9, R10]
sources: [_bmad-output/personal-brain/initiative-personal-brain.md, _bmad-output/personal-brain/architecture-brain-v1-slice-1/architecture-brain-v1-slice-1.md]
companions: [_bmad-output/personal-brain/architecture-brain-v1-slice-1/architecture-brain-v1-slice-1.md, _bmad-output/personal-brain/tickets/epic-jobs-and-scheduler/epic-jobs-and-scheduler-research-code.md]
after: []
refined: true
risk: high
---

# 공통 작업 runtime과 스케줄러

## Description

Brain의 작업 runtime을 긴 작업과 예약에 맞게 넓힌다. 범위는 다음과 같다.
- 작업 의존성: 앞 작업의 성공을 기다린다.
- 독립 작업의 병렬 실행 용량과 같은 키(계정)의 직렬화.
- 진행 중 작업의 소유권 갱신과 진행 상태.
- 작업자 사망·오류·정체·사용자 취소의 구분과 단계별 시간 한도.
- 공통 스케줄러: 기존 interval `schedules`(0009) 위에 현지 일자·시간대 기준 예약을 더한다. 수동 실행도 같은 작업 계약을 쓰고, 같은 대상의 중복을 막는다.
- 모델을 부르는 분석 작업도 같은 계약으로 예약된다(2026-10-28, 이니셔티브 R10).
- 데몬 감독자(AD-33): 확장 일감과 모델을 부르는 일감은 감독자만 청구하고 자식 프로세스 그룹으로 띄운다. 자식이 진행을 내는 동안 임대를 갱신하고, 취소는 그룹 SIGTERM → 유예 → SIGKILL → reap이다. 청구마다 attempt/lease token을 발급하고 오래된 attempt의 쓰기를 DB가 거부한다. 시작 때 이전 incarnation의 그룹을 정리한 뒤 회수하고, 종료를 확인할 수 없으면 불명 상태로 남긴다.
- 프로세스 ABI v1: 이 에픽이 처음 쓰므로 만든다(2026-10-28). stdout JSON Lines 이벤트(진행·heartbeat, 결과 요약, 다시 할 수 있는지 분류가 붙은 오류)와 종료 코드, 환경 변수 입력(DB URL, 일감 id, attempt token), 비정상 EOF·알 수 없는 버전·stderr 처리를 버전 있는 JSON Schema로 두고, fake worker와 TS fixture로 검증한다. manifest와 설정 snapshot은 epic-extensions가 더한다.

근거: 지금 drain은 handler를 직렬로 await한다. 기본 임대는 600초인데 갱신이 없고, 진행 중 drain에는 취소 신호가 없다(integration-boundaries "작업 그래프와 병렬성"). 코드 조사(2026-10-28, `epic-jobs-and-scheduler-research-code.md`)가 이를 확인했고, 데몬 잠금의 `started_at`이 OS의 프로세스 시작 신원이 아니라는 점, 작업 목록·취소 명령이 없다는 점, `completed_at`이 성공과 영구 실패를 함께 덮는다는 점도 찾았다.

## Outcome

몇 시간짜리 작업이 도는 동안에도 대화 수집이 밀리지 않고, 예약한 시각에 작업이 한 번만 돈다(이니셔티브 Done when 8의 작업 부분).

## Requirements

- E12-1 (R9): attempt와 임대 갱신 — 청구마다 새 attempt token(쓰는 쪽이 만드는 UUIDv7)과 attempt 이력 행을 만들고, 일감 행은 현재 attempt를 가리킨다. 감독자는 자식이 진행 이벤트를 내는 동안 임대를 갱신한다. 살아 있는 attempt의 일감은 경과 시간만으로 다시 청구되지 않는다. 결과 확정은 현재 attempt token이 맞을 때만 된다. (AD-21·22·33)
- E12-2 (R8, R9): 감독자와 실행 분류 — 일감 종류마다 실행 분류(`core` | `supervised`)가 있고, 이름이 아니라 등록부가 정한다. `supervised` 일감(확장 일감, 모델을 부르는 일감)은 데몬 감독자만 청구하고, 데몬 밖 drain과 기회적 drain은 `core` 일감만 청구한다. 감독자는 core drain 회차와 따로 돌고, 일감마다 자식 프로세스 그룹을 띄우며, 환경 변수로 DB URL·일감 id·attempt token을 준다(argv에는 비밀이 없다). 긴 일감이 도는 동안 core 일감(대화 수집)이 처리된다. (AD-7·25·27·33)
- E12-3 (R9): 취소와 종료 확인 — 사용자 취소는 DB에 남는 요청이고, 감독자가 그룹 SIGTERM → 유예 → SIGKILL → reap으로 실행한다. 데몬 종료도 같은 정리를 한다. 감독자는 자식의 PID·PGID·OS 시작 신원을 attempt에 기록하고, 시작 때 이전 incarnation의 그룹을 그 신원으로 대조·정리한 뒤 회수한다. PID가 재사용되었으면 다른 프로세스를 죽이지 않는다. 종료를 확인할 수 없으면 `unknown`으로 남기고 다시 청구하지 않는다. (AD-27·33)
- E12-4 (R9): 오래된 쓰기 거부 — DB 함수 하나가 (일감 id, attempt token)이 현재 살아 있는 attempt인지 확인한다. 결과 확정이 그것을 부르고, core 계약 표의 INSERT trigger(epic 14·15가 표를 만들 때 붙인다)도 그것을 부른다. 오래된 token으로 하는 직접 SQL INSERT도 거부된다. (AD-30·33)
- E12-5 (R9, R10): 프로세스 ABI v1 — 버전 있는 JSON Schema로 정한다. 이벤트는 `progress`·`heartbeat`·`result`·`error`이고, `result`에는 선택 칸 `usage`(입력·캐시·출력 토큰)가, `error`에는 코드와 `retryable`이 있다. 환경 변수 입력, exit code와 최종 이벤트의 우선순위, 잘린 줄·비정상 EOF·모르는 버전·stderr 처리(비밀을 그대로 남기지 않음)도 정한다. schema와 valid/invalid fixture는 core 패키지와 함께 배포되어 epic 13의 Python이 같은 파일을 읽는다. TS 코덱이 fixture 판정을 통과한다. 시험용 fake worker와 함께 내보내는 probe worker가 이 ABI를 말한다. (AD-33)
- E12-6 (R9): 상태 구분 — 일감 결과(`succeeded` | `failed` | `cancelled` | `dependency_failed`)는 `completed_at`과 따로 남는다. attempt 결과는 `succeeded` | `failed` | `stalled` | `died` | `cancelled` | `unknown`이다. 정체는 진행 이벤트가 종류별 창(기본 15분, 모델 일감 25분) 동안 없을 때이고, heartbeat는 진행이 아니다. 정체·사망은 그룹 정리 뒤 일시 오류로 다시 시도하고, 오류는 AD-21 분류를 따른다. doctor가 정체·사망·불명과 마지막 오류를 보인다. (AD-21·33)
- E12-7 (R8): 일감 의존 — 일감은 선행 일감을 여럿 가질 수 있고, 선행이 모두 `succeeded`일 때만 청구된다. 선행이 `failed`·`cancelled`·`dependency_failed`로 닫히면 후행은 `dependency_failed`로 닫힌다. (AD-35)
- E12-8 (R8): 같은 키 직렬화와 병렬 용량 — 일감은 선택 직렬화 키(출처+계정)를 갖는다. 같은 키의 일감은 프로세스가 여럿이어도, 청구 경로가 어디든 한 번에 하나만 청구되고, 이것을 DB가 보장한다. 다른 키는 감독자 용량(Core 상수, 기본 2) 안에서 병렬로 돈다. 실행 분류 `supervised` 일감은 core 소유라도 용량을 쓰고, 실행 분류 `core`의 짧은 drain 일감은 쓰지 않는다. 키는 attempt가 끝났거나 `unknown`이 풀렸을 때만 놓인다. (AD-21)
- E12-9 (R10): 현지 시각 예약 — `schedules`에 현지 매일 예약(`HH:MM`, 시간대는 사용자 설정 DB의 `timezone`)을 더한다. DST로 없는 시각은 그 뒤 첫 유효 시각에, 겹친 시각은 첫 번째에 돈다. 시간대가 바뀌면 다음 발화를 다시 계산하고, 이미 남긴 성공 기록의 날짜를 새 시간대로 다시 해석하지 않는다. 예약마다 현지 날짜별 성공 기록을 남긴다. 놓친 예약은 깨어난 뒤 놓친 날짜 중 성공 기록이 없는 날이 있을 때만 한 번 돌고, 그 일감이 빠진 날짜 범위를 받는다. 수동 실행도 같은 일감 계약을 쓰고, 같은 대상의 열린 일감과 합쳐진다. (AD-13·21·27)
- E12-10 (R10): 예약·작업 명령 — `brain schedules add|list|remove|run`과 `brain queue list|cancel`이 있고, CommandSpec·명령 메타·SDK가 1:1이다. 작업 목록은 상태·attempt·마지막 진행·걸린 시간·토큰 사용량을 보인다. doctor도 모델 일감의 토큰과 걸린 시간을 보인다. 호출 횟수와 상한은 없다. epic 13의 install 스킬은 같은 SDK로 예약을 등록한다. (AD-5)
- E12-11 (R9; R16의 작업 부분): 확장 끄기 계약 — 보류 그룹 단위로 보류·해제하는 Store verb와 Core use case가 있다. `<ext>.*` 종류는 자동으로 그룹 `extension:<ext>`에 속하고, 그 확장의 데이터를 읽는 core 일감·예약은 넣는 쪽이 같은 그룹을 붙인다. 보류하면 그 그룹의 대기 일감은 `extension_disabled`로 멈추고, 예약 발화와 새 청구가 막히며, 진행 중 일감은 감독자 취소로 끊긴다. 해제하면 대기 일감이 이어서 돈다. `failures retry`와 수동 실행은 보류를 우회하지 않는다. 실제 registry는 epic 13이 만들어 이 계약을 부르고, 분석 일감·예약에 그룹을 붙이는 일은 epic 18이 한다. (AD-29·33)

## Constraints

- spec Constraints·AD-27: 데몬이 멈춰도 hook·명령이 동작하고, 밀린 core 일감은 기회적 drain이 처리한다. `supervised` 일감은 데몬이 돌아올 때까지 기다린다(AD-25).
- AD-7: 외부 호출과 자식 프로세스를 기다리는 동안 DB 쓰기 트랜잭션을 잡지 않는다.
- AD-22: DB는 값을 만들지 않는다. token·시각·ID는 쓰는 쪽이 정한다.
- AD-31: 새 core 마이그레이션은 epic 11이 checksum을 고정한 0001 다음 번호다. 0001은 고치지 않는다.
- 이 에픽의 시험과 이 Mac 확인은 fake·probe worker로 한다. 모델과 실계정을 부르지 않는다.

## Done when

1. fake worker의 긴 작업이 600초를 넘겨도 소유권을 갱신하며 중복 실행되지 않고, 그동안 대화 수집 일감이 처리된다.
2. 작업자를 죽이면 그 작업이 회수되어 다시 돈다. 사용자가 취소하면 끝난다. 오류와 정체는 다른 상태로 구분되어 doctor에 보이고, 종료를 확인할 수 없는 일감은 `unknown`으로 남아 다시 돌지 않는다.
3. 의존 작업은 앞 작업이 성공한 뒤에만 시작하고, 같은 계정 키의 작업은 한 번에 하나만 돈다.
4. 현지 시각 예약이 설정 시간대를 따라 한 번 돌고, 놓친 실행(빠진 날짜가 있을 때만 한 번)과 수동 실행이 정한 정책대로 처리된다.
5. 기능 묶음이 플러그인 배포(app-ref·version)로 이 Mac의 설치본에 들어가 동작한다.

## Boundaries

다음은 이 에픽 밖이다.
- Garmin 수집 일감은 epic-garmin-runtime, 분석 일감(평가 단계)과 모델 adapter의 토큰 채우기는 epic-health-analysis다.
- manifest JSON Schema와 설정 snapshot, 확장 registry, 확장의 정체 창 선언은 epic-extensions다.
- install 스킬이 예약을 등록하는 단계는 epic-extensions다.
- 채널 발신 일감은 epic-channels가 이 계약 위에 만든다.
- core 계약 표(건강 측정·`analyses`·`file_requests`·채널 발신)와 그 trigger는 epic 14·15다. 이 에픽은 trigger가 부를 attempt 확인 함수만 만든다.
- 확장 끄기: 이 에픽은 공통 보류·취소·재개 수단(보류 그룹)을 낸다. registry가 그것을 부르는 일은 epic 13, 확장 데이터를 읽는 분석 일감·예약에 그룹을 붙이는 일은 epic 18이다.
- Must not change: 데몬이 멈춰도 hook·명령이 동작하고 밀린 일은 기회적 drain이 처리한다(spec Constraints).

## References

- parent — _bmad-output/personal-brain/initiative-personal-brain.md, Requirements R8, R9, R10
- design — _bmad-output/personal-brain/prep-garmin-absorption/integration-boundaries.md, "작업 그래프와 병렬성"
- architecture — _bmad-output/personal-brain/architecture-brain-v1-slice-1/architecture-brain-v1-slice-1.md, AD-5, AD-7, AD-13, AD-21, AD-22, AD-25, AD-27, AD-29, AD-30, AD-31, AD-33, AD-35
- research — _bmad-output/personal-brain/tickets/epic-jobs-and-scheduler/epic-jobs-and-scheduler-research-code.md (2026-10-28 정적 코드 조사)

## Notes

- Waits on epic-postgres-primary because: PostgreSQL의 `work_items`·`schedules`와 잠금·트랜잭션 규칙, 시간대 설정이 있어야 한다.
- Decision(2026-10-28, 사용자): 놓친 예약. Mac이 잠들었거나 꺼져 있어 예약 시각을 놓쳤으면, 깨어난 뒤 놓친 날짜(하루든 여러 날이든)에 성공한 실행이 없을 때만 돌린다. 여러 날을 놓쳐도 한 번 돌고, 그 한 번이 빠진 날짜를 처리한다(Garmin 수집은 coverage로 빠진 날짜를 채운다). 그날 이미 성공한 실행이 있으면 돌지 않는다. 이전의 Open question(놓친 예약 기준)을 대신한다.
- Decision(2026-10-28): 정체 판정. heartbeat만으로는 진행이 아니다(AD-21·33). 진행 이벤트가 일감 종류별 창(manifest가 선언, 기본 15분. 모델 일감은 호출 timeout 20분 + 5분) 동안 없으면 `stalled`로 기록한다. 감독자가 프로세스 그룹을 정리한 뒤 일시 오류로 다시 시도하고, doctor에 보인다. 이전의 Open question(정체 기준)을 대신한다.
- Decision(2026-10-28, 사용자): 모델 호출 표시. 모델을 부른 일감의 토큰 사용량과 걸린 시간을 doctor와 작업 목록에 보인다. 호출 횟수는 보이지 않고 상한은 두지 않는다. 프로세스 ABI v1의 결과 이벤트에 선택 칸 `usage`(입력·캐시·출력 토큰)를 두고, 일감 행이 그것을 남긴다. 값을 채우는 모델 adapter는 epic-health-analysis다. 이전의 Open question(호출 횟수·비용)과 spine Deferred "모델 호출 횟수·비용 제한/표시"를 대신한다.
- Decision(2026-10-28, 사용자): 확장을 끄면 진행 중인 그 확장의 일감은 감독자 취소(그룹 SIGTERM → 유예 → SIGKILL → reap)로 끊는다. 대기 일감은 `extension_disabled`로 보류하고, 다시 켜면 이어서 돈다. 그 확장의 데이터를 읽는 core 분석 예약도 멈춘다(epic-health-analysis). 데이터와 기존 분석은 남고 검색된다. 이전의 Open question과 spine Deferred "비활성화의 진행 작업 종료 방식"(owner 12·13)을 대신한다.
- Decision(2026-10-28): 새 예약 CLI는 AD-5의 `<ns> <verb>` 모양이다. 안은 `brain schedules add|list|remove`이고, 정제 때 CommandSpec과 SDK를 1:1로 확정한다(spine Deferred "신규 공통 CLI namespace/verb"). → 정제에서 확정(아래).
- Decision(2026-10-28): 프로세스 ABI v1은 감독자를 처음 만드는 이 에픽이 만든다. 13은 이 에픽 뒤라 13 소유면 감독자가 쓸 규약이 없다. manifest JSON Schema와 설정 snapshot은 13에 남는다. spine AD-33도 이렇게 고쳤다(2026-10-28).
- Decision(2026-10-28, 정제): 명령은 `brain schedules add|list|remove|run`(`run`은 수동 실행)과 `brain queue list|cancel`이다. 작업 명령은 새 이름공간을 만들지 않고 기존 `queue`(지금 `queue drain`)를 넓힌다. `queue cancel`은 DB에 취소 요청을 남기기만 하고, 프로세스는 감독자가 끝낸다. CLI가 PID를 직접 죽이는 경로는 없다. spine Deferred "신규 공통 CLI namespace/verb"의 예약 부분을 대신한다.
- Decision(2026-10-28, 정제): 저장 구조는 "일감 행의 최신 상태 + attempt 이력 표"다. 일감 행에는 현재 attempt, 결과, 실행 분류, 직렬화 키, 보류 이유, 취소 요청을 두고, attempt 이력(token, incarnation, PID·PGID·OS 시작 신원, 시작·진행·heartbeat·갱신·종료 시각, 결과, 오류 코드, `usage`, 걸린 시간)은 따로 둔다. 정체 → 다시 시도가 이력을 지우지 않게 하기 위해서다. 선행 관계와 현지 날짜별 성공 기록도 각자의 표다. 표·컬럼 이름은 스토리 plan이 정한다.
- Decision(2026-10-28, 정제): 감독자 용량은 Core 상수(기본 2)다. 설정 키로 만들지 않는다. 실행 분류 `core`의 drain(대화 수집 등)은 지금처럼 짧은 직렬 회차로 남고 감독자 용량과 무관하다. 소유(core·확장)와 실행 분류(`core`·`supervised`)는 다른 축이다. core가 소유한 분석·probe도 실행 분류는 `supervised`다(세트 검증 F1).
- Decision(2026-10-28, 정제): ABI v1 schema와 fixture는 `packages/core` 아래에 두고 패키지와 함께 배포한다(경로는 1의 plan이 정한다). TS는 새 검증기 의존을 더하지 않고, spool 코덱처럼 손으로 쓴 코덱이 같은 fixture의 판정을 통과한다. epic 13의 Python은 같은 schema 파일을 `jsonschema`로 읽는다(옛 Garmin이 이미 쓰는 의존). schema와 TS 코덱이 갈라지지 않게, fixture마다 기대 판정을 적어 두고 두 언어가 같은 판정을 내야 한다.
- Decision(2026-10-28, 정제): 출하용 probe worker(core 일감 종류 `process_probe`, 정한 시간 동안 진행 이벤트를 내고 끝나는 Node 자식)를 둔다. 시험, 이 Mac 확인, epic 13의 테스트 확장이 같은 것을 쓴다. 모델과 실계정을 부르지 않는다.
- Decision(2026-10-28, 정제): DST로 없는 현지 시각은 그 뒤 첫 유효 시각, 두 번 있는 시각은 첫 번째다. 예약의 시간대는 예약 행에 고정하지 않고 사용자 설정 DB의 `timezone`을 따른다. 바뀌면 다음 발화를 다시 계산하고, 성공 기록은 남길 때의 시간대와 함께 둔다.
- Decision(2026-10-28, 정제): 오래된 attempt 쓰기 거부는 DB 함수 하나(일감 id, attempt token)로 한다. 이 에픽은 결과 확정과 시험용 표에 붙여 계약 시험을 하고, epic 14·15는 계약 표를 만들 때 같은 함수를 trigger에 붙인다. 확장 role(epic 13)이 이 함수를 부를 수 있어야 한다.
- Decision(2026-10-28, 사용자): 이 에픽은 루프로 무인 실행한다. epic 11과 같이 `plan_checkpoint`·`done_checkpoint`는 두지 않는다. 루프는 hitl인 12(이 Mac 확인)와 에픽 닫기에서만 멈춘다(2026-10-28 요청: 멈출 곳은 실계정·실데이터·이 Mac 확인과 에픽 닫기만). → 2026-10-28 바뀜: 12도 에이전트가 하고(`hitl = false`), 에픽 닫기는 run을 막지 않는다(이니셔티브 Notes의 위임 Decision).
- Decision(2026-10-28, 스토리 계획): tracer는 1이다. 데몬 감독자가 probe 자식 한 건을 ABI v1의 정상 경로(progress → result)로 돌리며 임대를 갱신하고, 같은 시간에 core drain이 대화 수집 일감을 처리한다. 가짜 시계로 600초를 넘겨도 같은 일감이 다시 청구되지 않고, 결과 확정은 attempt token이 맞을 때만 된다. 1은 정상 경로만 열고 취소·사망·정체·불명은 다음 스토리다. 다음은 가장 덜 확실한 OS 경계인 2(취소·종료 확인·재시작 복구)와 DB 경계인 3(오래된 쓰기 거부)이다.
- Decision(2026-10-28, 스토리 계획): `ports/store.ts`·WorkStore 계약·PG work 모듈·새 core 마이그레이션·감독자·`daemon/run.ts`·CLI 조립을 거의 모든 스토리가 함께 고친다. 그래서 1~10은 한 줄로 만든다(코드 조사 8절). 마이그레이션 번호는 스토리 순서대로 이어 받는다. Refactor sweep(11) 뒤에 이 Mac 확인(12)을 둔다(epic 11 선례).
- Carry(2026-10-28, 코드 조사 1절): `packages/core/src/domain/work-item.ts`의 재시도 대기 주석("8번째가 한 시간")은 실제 수식(8번째 128초)과 다르다. sweep 후보다.
- Decision(2026-10-28, 세트 검증 F2, 이 Mac에서 확인): OS 시작 신원은 (부팅 시각 `sysctl kern.boottime`, PID, `LC_ALL=C ps -o lstart= -p <pid>`의 1초 단위 시작 시각)이다. 그룹 구성원은 `ps -o pid=,pgid=,lstart= -g <pgid>`로 본다. Node `spawn(..., {detached: true})`가 만든 그룹의 리더와 손자가 같은 PGID로 나왔다. 없는 PID는 종료 코드 1과 빈 출력이고, 그룹을 SIGKILL로 정리한 뒤의 조회도 종료 코드 1이다. 그래서 2에 `unknown`(착수 차단)을 두지 않는다. 종료 코드 1과 빈 출력은 '없음', 그 밖의 실패는 '확인 불가'로 보고 `unknown` 규칙을 따른다.
- Decision(2026-10-28, 세트 검증 F3): epic 11 쪽 entry(11.1·11.3·11.6·11.9·11.10·11.11)의 설명에는 인계 문장을 더하지 않는다. 11.1은 루프가 만드는 중이고, 나머지도 이 계획이 main에 합쳐지기 전에 끝난다. 받는 쪽인 12.1·12.8이 무엇을 받는지 적고, 실제 경로와 시그니처는 epic 11이 끝난 HEAD에서 확인한다. 이것은 Dependencies의 "양쪽 description이 인계를 말한다" 조건의 명시적 예외다(이니셔티브의 epic 17·18 예외와 같은 방식). 재검증 F3이 이 예외 문장을 요구했다.
- Decision(2026-10-28, 세트 검증 F4): 확장 끄기의 보류 단위는 이름공간이 아니라 보류 그룹이다. `<ext>.*` 종류는 자동으로 `extension:<ext>` 그룹이고, 확장 데이터를 읽는 core 분석에는 epic 18이 같은 그룹을 붙인다. 그래야 core가 확장 이름을 추측하지 않고도 "그 확장의 데이터를 읽는 core 분석 예약도 멈춘다"는 사용자 결정을 지킨다.
- Decision(2026-10-28, 세트 검증 S1·S2 채택): 1의 plan은 정상 경로에 필요한 것만 적고, 넘치면 비필수 완성을 이름 붙인 다음 스토리로 나눈다(경로는 1에 남긴다). 1이 timer·clock, 가짜 프로세스 port, 격리된 PG 시험 setup을 만들고 2·5·8이 다시 쓴다. 새 시험은 plan에 실행 명령, fake와 실제 Node 자식의 구분, PG 사전 조건, 관찰값을 적는다. 12의 plan은 다시 돌릴 때의 정리 절차를 적는다.
- Decision(2026-10-29, 추천으로 정함, 12.4 escalation 해소): ABI v1 stderr는 가린 다음 자른다. 감독자가 줄 단위로 읽으면서 PEM 개인 키 블록 상태를 줄 사이에 이어 가며 블록 전체를 가림 표식 한 줄로 바꾸고(END 없으면 EOF까지), 그 밖의 줄은 `maskSecrets(line, 'body')`로 가린다. 한 줄 상한은 stdout과 같은 65536바이트이고 넘는 줄은 생략 표식으로 바꾼다. 그 결과의 끝 16 KiB → 끝 4096바이트를 남긴다. 처음 계약(16 KiB로 자른 뒤 가림)은 BEGIN 표식이 잘린 PEM 본문을 남겼다(리뷰 합성 재현). 비밀을 그대로 남기지 않는다는 E12-5가 우선이다. epic 13 Python 작성자가 읽는 ABI README의 stderr 절도 이 순서로 적는다.
- Decision(2026-10-29, 추천으로 정함, 12.4 두 번째 escalation 해소, 위 Decision을 대체): 줄마다 따로 가리면 키와 값이 다른 줄에 있는 비밀(`TOKEN=\n<값>` 등)이 남는다(리뷰 재현). 그래서 stderr 원문을 1 MiB까지 그대로 보관했다가 `maskSecrets(전체, 'body')`를 한 번 부르고 끝 4096바이트(부분 줄 버림)를 남긴다. 1 MiB를 넘으면 원문을 버리고 고정 안내문 `[stderr 생략: 원문 1 MiB 초과]`만 남긴다. 앞이 잘린 원문을 덜어내서 가리는 규칙은 Codex 검증에서 반례가 나왔다(`12-4-stderr-rule-check.md`). 큰 stderr의 진단을 잃는 대신 비밀을 남기지 않는다(E12-5). ABI README의 stderr 절도 이 규칙으로 적는다.
