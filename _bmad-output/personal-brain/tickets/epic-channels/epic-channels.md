---
type: epic
title: "공통 채널과 Telegram 발신"
parent: personal-brain
covers: [R13]
sources: [_bmad-output/personal-brain/initiative-personal-brain.md, _bmad-output/personal-brain/architecture-brain-v1-slice-1/architecture-brain-v1-slice-1.md]
companions: [_bmad-output/personal-brain/architecture-brain-v1-slice-1/architecture-brain-v1-slice-1.md, _bmad-output/personal-brain/prep-garmin-absorption/migration-contract.md, _bmad-output/personal-brain/tickets/epic-channels/epic-channels-research-code.md]
after: []
refined: true
risk: medium
---

# 공통 채널과 Telegram 발신

## Description

core가 소유하는 채널 계약과 Telegram 발신 adapter를 만든다.
- 채널 계약: channel·conversation·thread identity, 발신 이력, 결과 bundle, 사건 분류, provenance.
- 채널 발신 요청·이력 표: 이 에픽이 처음 쓰므로 만든다(2026-10-28, 사용자). 확장은 요청과 legacy 이력을 INSERT만 한다(RLS, AD-30). 요청→`work_items` 인계와 crash 복구는 core가 맡고, legacy 이력은 인계하지 않는다.
- 중복 억제: 생산 결과의 안정된 식별자+채널 대화 식별자+목적/개정의 의미 키를 UNIQUE로 둔다. 원자적인 최초 시도 gate를 발신 전에 저장하고, 실제 결과와 불명 상태를 나눈다(AD-35).
- 기존 Garmin `ports`·`telegram`의 의미(최초 시도 gate, 전송 이력)를 공통 경로로 옮긴다.
- 발신은 작업 계약 위의 일감으로 재시도한다.
- 이전된 옛 Garmin 알림·전송 이력을 출처(legacy source)와 함께 받는 자리를 둔다. 받은 이력은 다시 보내지 않는다(2026-10-28, 사용자: core 채널 이력으로).
- 이후 사용자 답변·스레드·에이전트 선제 메시지를 같은 대화에 이을 수 있게 식별자를 정한다(2026-10-28, 이니셔티브 R13, 사용자: 별도 에픽).

코드 조사(2026-10-28, `epic-channels-research-code.md`)가 찾은 것은 다음과 같다.
- 옛 Garmin은 최초 시도 gate를 남긴 뒤 실패해도 영원히 다시 보내지 않는다. 이 에픽의 재시도 결정과 다르므로 그 구조를 그대로 옮기지 않는다.
- 옛 adapter는 연결 전 오류와 접수 뒤 응답 유실을 같은 `network`로 합친다.
- 옛 adapter는 `message_id`를 읽지 않는다.
- 옛 adapter는 Telegram 설정을 tokenstore의 `telegram.json`(`bot_token`, `chat_id`)에서 읽는다. 이 Mac의 기본 tokenstore에는 그 파일이 없었다.
- Telegram API에 중복 방지 키나 보낸 메시지 조회가 있는지는 옛 코드로 확인되지 않았다(네트워크 없이 조사).

## Outcome

Brain의 어떤 기능이든 같은 채널 계약으로 메시지를 보내고, 보낸 것과 실패한 것이 기록된다.

## Requirements

- E15-1 (R13): 채널 identity — channel(adapter 종류, 비밀 아닌 봇 참조), conversation(외부 대화 참조), 선택 thread, provenance를 core가 소유한다. 외부 message id는 응답에 있을 때만 남기고 지어내지 않는다. 옛 Garmin 봇·채팅은 하나의 conversation이고, 이전된 옛 이력과 새 발신이 그 대화에 함께 속한다. 수신 처리는 만들지 않지만, 이후 답장·스레드·선제 메시지를 이을 식별자는 지금 남긴다. (AD-35)
- E15-2 (R13): 발신 요청 — 요청 표의 의미 키 `(생산 결과 식별자, conversation, 목적, 개정)`이 UNIQUE다(NULL로 우회되지 않는 정규형, 요청 UUID와 별도). 생산자 출처와 생산 결과 참조를 남긴다. core가 미인계 요청을 다시 찾아 요청 id 대상 일감 생성과 인계 표식을 한 트랜잭션에 확정하므로, 요청 INSERT 뒤 crash해도 복구된다. 최초 시도 gate는 첫 발신 직전 짧은 트랜잭션에서 한 번 저장한다. 재시도는 같은 요청의 attempt이고 gate를 다시 만들지 않는다. (AD-30·35)
- E15-3 (R13): 실행 분류 — 발신 일감 `channel_send`는 실행 분류 `supervised`이고, core가 내보내는 Node worker가 프로세스 ABI v1(epic 12)로 돈다. hook과 기회적 drain은 발신하지 않는다. 외부 호출 동안 DB 쓰기 트랜잭션을 잡지 않는다. (AD-7·33)
- E15-4 (R13): Telegram adapter — Core 채널 port의 구현이고 Runtime이 조립한다. sendMessage·sendPhoto·sendMediaGroup·sendDocument를 쓴다. 비밀은 `.env`의 `BRAIN_TELEGRAM_BOT_TOKEN`·`BRAIN_TELEGRAM_CHAT_ID`를 설정 코덱이 읽는다. 나가는 텍스트·캡션은 출력 코덱으로 가린다(DB 원문은 그대로). 크기 상한(텍스트 UTF-16 4096, 사진 10MiB, 문서 50MiB, 앨범 2~10장)을 넘으면 영구 오류 `too_large`다. (AD-11·18)
- E15-5 (R13): 결과와 재시도 — attempt 결과는 `sent` | `definite_failed`(이유 코드) | `unknown`이다. 확실한 일시 실패(요청 전 네트워크 오류, 429, 5xx)와 `unknown`은 지수 간격(AD-21)으로 다시 보낸다. 429는 `retry_after` 이상 기다린다. 10번 실패하면 `failures`에 남기고 doctor에 보인다. 영구 오류(429가 아닌 4xx, `too_large`, 설정 없음)는 첫 실패에서 `failures`로 간다. 발신 실패는 생산자의 결과를 지우거나 되돌리지 않는다. (AD-21·35, 사용자 결정 2026-10-28)
- E15-6 (R13; R12의 발신 부분): 결과 묶음 — 요약 → 앨범 → 전문 순서의 항목과 항목별 결과를 둔다. 다시 시작하면 `sent`가 확인된 항목은 다시 보내지 않고, `unknown`·실패 항목만 보낸다(중복 가능성은 받아들인 결정). 묶음을 만드는 일은 epic 18이다.
- E15-7 (R13, R7): legacy 이력과 확장 쓰기 — 옛 Garmin `notification`(최초 시도 gate)과 `delivery`(전송 결과)를 각자의 legacy 표에 출처(dataset, 원래 표, 원래 키, import batch)와 함께 받는다. 이 행들은 인계되지 않고, 보내지지 않으며, resend가 거부한다. 확장 role(13.4)은 요청 표와 legacy 표에 INSERT만 한다: 출처를 role에 결합한 RLS, UPDATE·DELETE 없음, 12.3의 attempt 확인 trigger. 넣는 일은 epic 14다. (AD-30·36)
- E15-8 (R13): 명령과 스킬 — `brain channels list|status|resend <request-id>`가 CommandSpec·명령 메타·SDK 1:1이다. resend는 `definite_failed`·`unknown`·`failures`로 닫힌 요청만 같은 요청의 새 attempt로 다시 연다. `sent`·legacy·진행 중 요청은 거부한다. 플러그인 스킬 `plugin/skills/channels/SKILL.md`가 상태 보기와 resend를 감싸고, epic 13.7의 정적·행동 시험 방식으로 검증한다. 임의 메시지를 보내는 명령은 없다.

## Constraints

- bot token은 `.env`에 두고(AD-18), 나가는 텍스트는 Core 출력 코덱으로 가린다(AD-11).
- 새 core 마이그레이션은 epic 11~13 뒤의 다음 번호다(AD-31).
- 시험은 로컬 가짜 Telegram 서버와 fake adapter로 한다. 실계정 발신은 마지막 이 Mac 확인에서 한 번만 한다.
- 양방향 대화·수신 처리는 범위 밖이다(이니셔티브 Boundaries).

## Done when

1. 테스트 생산자의 메시지가 공통 계약으로 Telegram에 한 번 나가고 이력이 남는다. 실계정 확인은 에이전트가 이 Mac에 있는 옛 봇 설정으로 한다. 설정이 없으면 그 단계만 사람 몫으로 남는다(2026-10-28 위임).
2. 전송 실패는 재시도되고, 생산자 쪽 결과를 지우거나 되돌리지 않는다.
3. 같은 결과를 두 번 보내지 않고, 이전된 옛 발신 이력을 넣어도 메시지가 나가지 않는다.
4. 기능 묶음이 플러그인 배포로 이 Mac의 설치본에 들어가 동작한다.

## Boundaries

다음은 이 에픽 밖이다.
- Slack·Telegram 양방향 에이전트 대화와 수신 처리.
- Garmin 결과 bundle을 만드는 일은 epic-health-analysis다.
- Must not change: bot token은 `.env`에 두고(AD-18), 나가는 텍스트는 Core 출력 코덱으로 가린다(AD-11).

## References

- parent — _bmad-output/personal-brain/initiative-personal-brain.md, Requirements R13
- design — _bmad-output/personal-brain/prep-garmin-absorption/integration-boundaries.md, "가져갈 코드와 교체할 경계"(ports, telegram 행)
- source — _bmad-output/personal-brain/prep-garmin-absorption/accepted-intent.md, S7
- architecture — _bmad-output/personal-brain/architecture-brain-v1-slice-1/architecture-brain-v1-slice-1.md, AD-7, AD-11, AD-18, AD-21, AD-30, AD-33, AD-35, AD-36, Table Contract(채널 발신 요청·이력)
- migration — _bmad-output/personal-brain/prep-garmin-absorption/migration-contract.md (옛 알림·전송 이력)
- research — _bmad-output/personal-brain/tickets/epic-channels/epic-channels-research-code.md (2026-10-28 정적 코드 조사)

## Notes

- Waits on epic-postgres-primary because: 채널·대화·발신 이력 테이블이 들어갈 공통 스키마와 비밀 저장 계약이 필요하다.
- Waits on epic-jobs-and-scheduler because: 발신 일감의 재시도와 중복 방지를 작업 계약 위에 만든다.
- Waits on epic-extensions because: 확장 role(`brain_ext_<name>`)과 출처 결합 규칙이 있어야 확장이 발신 요청·legacy 이력을 INSERT만 하는 RLS 정책을 둔다.
- Decision(2026-10-28, 사용자): 불명 발신(요청은 나갔는데 결과를 모름)도 지수 간격(AD-21)으로 다시 보낸다. 10번 실패하면 `failures`에 남기고 doctor에 보이며, 사람이 resend 명령으로 다시 보낸다. 같은 메시지가 두 번 갈 수 있다는 점을 받아들였다. 확실한 실패(요청이 나가지 않은 네트워크 오류, 429, 5xx)도 같은 경로다. 의미 키 UNIQUE와 최초 시도 gate는 그대로라, 새 요청이 같은 결과를 다시 보내지는 않는다. 정제 때 Telegram Bot API에 중복 방지 키와 보낸 메시지 조회가 정말 없는지 다시 확인한다. 이전의 Open question과 spine Deferred "불명 발신 재시도 정책"(owner 이 에픽)을 대신한다.
- Decision(2026-10-28, 사용자): 발신 상태 보기와 resend를 Brain 플러그인의 스킬로도 낸다. 사용자가 에이전트에게 "못 간 알림 다시 보내 줘"라고 하면 에이전트가 이 스킬로 CLI를 불러 보낸다. 임의 메시지를 보내는 명령은 이 결정에 들어 있지 않다(양방향·선제 메시지는 범위 밖, 이니셔티브 Boundaries).
- Decision(2026-10-28): Telegram은 옛 Garmin 봇과 채팅을 그대로 쓴다. 이전된 옛 이력과 새 발신이 같은 대화가 된다. bot token과 chat id를 `.env`에 넣는 것은 사람이 한다(hitl). → 2026-10-28 바뀜: 이 Mac에 있으면 에이전트가 옮긴다(아래 위임 Decision).
- Decision(2026-10-28, 사용자): 채널은 Garmin 런타임 안이 아니라 별도 에픽으로 그 앞에 둔다.
- Decision(2026-10-28, 사용자): 이전한 Garmin 알림·전송 이력은 Garmin 스키마가 아니라 core 채널 이력에 둔다. 그래서 이 에픽을 epic-garmin-import 앞으로 옮겼다.
- Decision(2026-10-28, 추천으로 정함, 사용자 위임): 옛 Garmin 봇 token과 chat id가 이 Mac에 있으면 에이전트가 Brain `.env`로 옮겨 쓰고 실계정 발신 한 번을 확인한다. 없으면 그 스토리만 `awaiting-operator`로 두고 run은 계속한다.
- Decision(2026-10-28, 정제, 추천으로 정함): 발신 일감은 실행 분류 `supervised`다. core가 내보내는 Node worker가 ABI v1로 돈다. 발신 한 번에 수십 초가 걸릴 수 있다. core drain은 hook의 기회적 drain에서도 돌므로, 거기서 발신하면 Harness를 막는다. 감독자 경로를 쓰면 임대·attempt token·취소를 그대로 얻는다.
- Decision(2026-10-28, 정제, 추천으로 정함): 비밀 키 이름은 `BRAIN_TELEGRAM_BOT_TOKEN`·`BRAIN_TELEGRAM_CHAT_ID`(`.env`)다. 옛 Garmin의 `<tokenstore>/telegram.json`(`bot_token`, `chat_id`)을 찾으면 그 값을 옮긴다. 이 Mac의 기본 tokenstore에는 없었다(코드 조사 7절). 7의 실계정 단계는 다른 옛 설정 위치를 한 번 더 찾고, 없으면 그 단계만 `awaiting-operator`로 둔다.
- Decision(2026-10-28, 정제, 추천으로 정함): 결과는 `sent`·`definite_failed`·`unknown` 셋이다. 요청을 보내기 전의 연결 실패는 `definite_failed`(network_before_send)다. 요청을 보낸 뒤 응답을 받지 못했거나 응답이 깨졌으면 `unknown`이다. 옛 adapter는 둘을 `network` 하나로 합쳤으므로 나눈다(코드 조사 1절).
- Decision(2026-10-28, 정제, 추천으로 정함): 묶음 재시작 때 `sent`가 확인된 항목은 다시 보내지 않는다. `unknown`·실패 항목만 다시 보낸다. 텍스트가 4096(UTF-16)을 넘으면 나누지 않고 `too_large` 영구 오류로 둔다(옛 동작). 긴 내용은 생산자가 전문 문서로 보낸다.
- Decision(2026-10-28, 정제, 추천으로 정함): Telegram API의 중복 방지 키와 보낸 메시지 조회는 확인되지 않았다(네트워크 없이 조사). 재시도 결정은 그것과 무관하게 선다. 응답의 `message_id`는 있으면 남기고, 없으면 비워 둔다.
- Decision(2026-10-28, 스토리 계획): tracer는 1이다. 테스트 생산자의 요청 한 건이 core 인계를 거쳐 gate를 저장하고, 감독자가 띄운 `channel_send` worker가 로컬 가짜 Telegram 서버에 sendMessage를 보내고, 결과가 `sent`로 남는다. 같은 의미 키의 요청을 두 번 넣어도 POST는 하나다. 다음은 가장 덜 확실한 2(불명·재시도)다. 그다음 epic 14가 쓸 3(legacy와 확장 쓰기 경계), 4(묶음), 5(명령·스킬) 순이다.
- Decision(2026-10-28, 스토리 계획): 채널 Store·core 마이그레이션·조립·출력 코덱·CLI 등록부를 모든 스토리가 함께 고친다(코드 조사 8절). 그래서 1~5는 한 줄로 만든다. 1은 epic 13의 마지막 코드 스토리(13.9)를 기다린다(13.1이 12.11을 기다린 선례). epic 11~13 쪽 entry에는 인계 문장을 더하지 않는다. 받는 쪽(1·3·5)이 무엇을 받는지 적고, 실제 시그니처는 그 HEAD에서 확인한다. Dependencies의 "양쪽 description" 조건의 명시적 예외다(epic 12 F3과 같은 방식).
- Decision(2026-10-28, 추천으로 정함): risk와 그 이유.
  - 1 high: 발신 계약이 틀리면 14·16·18이 모두 그 위에 선다.
  - 2 high: 불명 처리가 틀리면 알림을 놓치거나 끝없이 보낸다.
  - 3 high: RLS가 틀리면 확장이 남의 발신을 만들거나, legacy가 다시 나간다.
  - 4 medium: 묶음이 틀리면 리포트 일부가 빠지거나 중복된다. 평가는 남는다.
  - 5 medium: 명령이 틀리면 resend가 엉뚱한 요청을 연다. 입력 검증으로 막는다.
  - 6 low: 정리다.
  - 7 medium: 실계정에서만 드러나는 설정 누락을 놓친다.
- Decision(2026-10-28, 세트 검증 F1): E15-1의 분담. 1이 새 발신의 identity·provenance를 끝낸다(봇 참조, 대화 참조, 선택 thread, 생산자 출처, 응답의 message id). 3이 legacy 이력과 새 발신을 같은 conversation으로 잇는다. 7은 설치본에서 관찰만 한다. 수신 처리는 만들지 않는다.
- Decision(2026-10-28, 세트 검증 F2): 실계정 설정이 없으면 7은 `awaiting-operator`다. `operator_actions`를 남겼다는 사실을 실발신 성공으로 기록하지 않는다. run은 계속한다.
- Decision(2026-10-28, 세트 검증 F3): 6(Refactor sweep)이 코드 스토리 1~5의 정리를 끝내고, 7의 로컬 배포와 설치본·실계정 확인은 그 뒤에 따로 둔다(epic 11~13 선례). 7에서 찾은 기능 문제는 버그 스토리로 고친다.
- Decision(2026-10-28, 세트 검증 S1~S3 채택): 1의 plan 크기를 제한하고, 넘치면 비필수 완성을 이름 붙인 다음 스토리로 뺀다. 고위험 1~3에 추가 확인을 고정했다(동시 gate 경쟁, 접수 뒤 worker 종료, dataset 충돌, 인계 중간 종료). 3은 legacy를 resend 적격성에서 빼는 표식을 남기고, CLI 거부는 5가 완성한다.
- Decision(2026-10-30, 사용자): 에픽마다 두던 Refactor sweep(15.6)을 뺐다(`dropped`). 리뷰가 미룬 기존 결함은 `deferred-work.md` 장부에 남고, 사용자가 원할 때 `bmad-loop sweep`으로 직접 처리한다. 이 Mac 확인(15.7)은 sweep 대신 sweep이 기다리던 스토리들을 기다린다.
- Decision(2026-10-30, 추천으로 정함): 15.1의 13.9 레인 대기를 없앤다. PG 설정(11.6)·감독자(12.1)로 core 발신 tracer를 만들 수 있고, 확장 role·RLS는 소비자인 15.3이 13.4·12.3을 직접 기다린다. 예전 스토리 계획의 에픽 전체 조립·마지막 번호 가정은 이 결정으로 대체하고, 번호·시그니처는 착수 시점 main HEAD에서 확인한다.

- Decision(2026-10-31, 추천으로 정함): 사람 개입 없이 진행한다. 15.1은 선행 11.6·12.1 완료를 확인해 오래된 run 선택 불가 차단만 해제한다. 기존 after와 요구는 유지한다.

- Decision(2026-10-31, 추천으로 정함, 15.2 escalation 해소): 정식 실패와 정리된 기존 Dispatch를 보존하고 DNS 회복을 확인한 뒤 엔진의 새 generation에서 3단계 계획을 재추진한다. 재귀 워크플로와 Orca 회로 차단 우회는 금지하며 재시도 제어 제한이 지속되면 별도 복구 과업으로 분할한다.

- Decision(2026-10-31, 추천으로 정함, 15.2 escalation 해소): 별도 테스트 정리 훅 시간 초과 뒤 현재 HEAD 전체 검증이 통과했으므로 기존 구현과 계약을 보존해 엔진 검증을 재추진한다. 재발하면 원인을 조사하며 검증을 생략하지 않는다.
