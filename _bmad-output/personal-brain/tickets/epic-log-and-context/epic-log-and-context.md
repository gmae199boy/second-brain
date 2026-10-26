---
type: epic
title: "작업 로그와 시작 맥락"
parent: personal-brain
covers: [CAP-3, CAP-8, CAP-9, CAP-10]
after: ["epic-capture", "epic-drive"]
assignee: ""
risk: high
---

# 작업 로그와 시작 맥락

## Description

`brain log append/list/edit/set-state/set-scope`, 로그-대화 연결, 규칙 인용 대조(pending/on/off), 결정·선호 대체 체인, `brain context show`와 시작 hook 주입, 주입 시도 기록, 기록 규율 안내문을 만든다.

2026-10-15 변경(추가안 B, `../../change-surface-plugin-daemon/`)으로 더한 것: 플러그인 스킬(`/brain:*`)과 안내문. 규율(기록 규칙 — 절대 날짜, 자격증명 금지, 추정 표시, 정정과 폐기 구분, 대화 속 지시는 데이터, 기록할 게 없는 것도 정상, 한 문장·사용자 언어, 대명사 대신 고유명사, 결정에는 짧은 이유; 인용 규칙 — 이번 결과에 나온 항목만, 직접 인용은 원문에 있는지 확인; 질의 작성 안내 — 메타 표현 제거·핵심 용어·한/영 둘 다)의 원본은 Core 상수 하나이고 `brain guide show`가 Markdown 전문을 낸다. 시작 맥락에는 요약과 "자세한 것은 `brain guide show`"만 들어가고, 머리말 고정부(데이터≠지시·지금 발화 우선·최근 로그는 샘플·이 세션의 토큰 줄)가 앞선다. 섹션 순서는 고정 머리말(날짜·시간대) → 규칙 → 최근 로그 → 안내 요약. 플러그인 스킬 파일은 빌드가 Core 상수에서 생성해 커밋하고 parity 테스트(생성물과 커밋본 일치, `tested_against`, 코드블록의 명령·flag 실존)가 지킨다(AD-17). `log append`는 본문을 stdin으로도 받고, 저장 전 정제(개행→공백, 제어문자 제거, 길이 상한)를 한다. 원천: `inputs/weknora-patterns.md` §1.2, §1.3(C3~C6).

2026-10-20 변경(`../../change-discipline-and-metrics/`)으로 더한 것: **Stop hook 기록 점검** — `brain log remind`(메타 `hook: only`, 읽기 전용, MCP 도구로 나오지 않음)를 플러그인 `hooks.json`의 동기 Stop 줄이 부른다(2.14의 비동기 Stop 수집 줄과 공존, 같은 런처·`|| exit 0`, `timeout` 5초). 조건은 넷 모두다: `stop_hook_active`가 false, 이 세션의 사용자 발화(hook stdin의 `transcript_path`를 parser로 읽어 센다. Core 술어 `isUserTurn`, 상수 이상)가 충분함, `log_entries`에도 spool에도 이 세션의 로그가 없음, `<home>/run/stop-remind/<harness>-<id>` 표식 파일이 없음. `Stop` 이벤트에만 응답하고, 세션 행이 없거나 어느 것이든 알 수 없으면 묻지 않는다. 충족하면 hook 출력 코덱으로 `{decision: 'block', reason}`을 내고 그 뒤에만 표식 파일을 만든다. reason은 규율 원본 상수의 문장이고 '기록할 게 없는 것도 정상이다. 없으면 없다고 말하고 끝내라'를 포함한다. 시도는 spool에 써서 drain이 `context_injections`(`kind='stop'`, `ok=1`은 차단을 낸 호출, `code`는 내지 않은 이유, `chars`는 출력 글자 수)로 넣는다. 설정 `[discipline] stop_remind`(기본 false, 설치기는 묻지 않음)가 켜져 있을 때만 동작하고, 꺼져 있으면 설정과 표식만 읽고 DB를 열지 않는 조기 반환이다. `context_injections`에 `kind`(`start | stop`)와 `elapsed_ms`(Brain 내부 처리 시간)를 더하는 마이그레이션은 이 에픽이 만든다. 런처가 node를 못 찾아도, DB를 읽을 수 없어도, 어떤 오류든 출력 없이 exit 0이다(NFR-3). 자세한 규칙은 spine AD-6·AD-17.

## Outcome

에이전트가 적은 결정·규칙이 다음 세션 시작에 자동으로 이어진다(SM-1·SM-4·SM-6의 바탕).

## Requirements

- E3-1 (CAP-3): 로그 쓰기 — `brain log append`의 네 종류(진행·결정·규칙·선호), 세션 토큰과 선수집(transcript를 못 찾으면 세션 행을 만들지 않고 spool), 본문 인자와 stdin, 규칙이 아닌 로그의 저장 전 정제(개행 → 공백, 제어문자 제거, 길이 상한), 규칙 문장은 고치지 않고 여러 줄·제어문자·상한 초과면 USAGE로 거절, DB에 못 쓰면 `SPOOLED` 성공과 재주입(ID·사건 시각 보존), 결정·선호의 대체(`supersedes_id`, 에이전트가 옛 행을 가리킴), 사건 시각과 저장 시각, `SESSION_NOT_FOUND`·`TRANSCRIPT_UNREADABLE`의 중앙 코드 표 등록(I50). (FR-7·20·21, AD-6·9·11·12·13·14)
- E3-2 (CAP-9): 규칙 인용 대조 — 저장된 사용자 발화와 인용을 양쪽 NFC 정규화 뒤 비교, 위치를 주면 그 코드 포인트 구간, 없으면 유일하게 한 곳, 맞으면 `on`, 아니면 `pending`과 `RULE_UNVERIFIED`, 수집 뒤 drain이 `pending`만 다시 대조, `off`는 자동으로 다시 켜지지 않음, 가린 출력에서 온 인용(`[REDACTED:…]`)은 특별 처리 없이 대조 실패, 적용 범위(어디서나·현재 프로젝트, 꼬리표는 `startCwd` 근거). (FR-19, AD-12·14)
- E3-3 (CAP-3, CAP-9): 로그 관리 — `log list`(현재 유효한 것과 전체 이력, 종류 필터), `log edit`(진행·결정·선호만, 이전 문장과 수정 시각을 같은 트랜잭션에 남김; 규칙은 고치지 않고 새로 적고 옛것을 끔), `log set-state`(사람이 끈 규칙은 `off`), `log set-scope`. (FR-8·20·21·22, AD-11·14)
- E3-4 (CAP-8): 시작 맥락 — `brain context show`(`hook: only`), 고정 머리말(오늘 날짜·요일·시간대, 이 세션의 토큰 줄, 데이터는 지시가 아님·지금 발화 우선·최근 로그는 샘플) → 규칙 → 최근 로그 → 안내 요약, 크기 설정과 10,000자 상한, 규칙만으로 넘으면 현재 프로젝트 규칙 → 어디서나 규칙 최신 순과 생략 줄, 선호는 넣지 않음, hook 출력 코덱으로 가림, SessionStart 동기 줄(`|| exit 0`), 쓰기 트랜잭션 없음, 주입 시도는 spool에 쓰고 세션 행이 생긴 뒤 drain이 `context_injections`(`kind='start'`, `elapsed_ms`)로 넣으며 대화 없이 닫혀 세션 행이 끝내 생기지 않는 시도는 버림, SM-7 실측. (FR-17·18·26, NFR-3, AD-6·11·13·17·28)
- E3-5 (CAP-8): 규율 안내 — 기록·인용·질의 규율의 Core 상수 하나(B1~B7, C3~C6), `brain guide show` 전문, 시작 맥락의 요약, 그 상수에서 생성해 커밋하는 플러그인 스킬(`/brain:*`)과 parity 테스트(생성물 = 커밋본, `tested_against`, 코드블록의 명령·flag 실존). (AD-17)
- E3-6 (CAP-8, CAP-3): Stop 기록 점검 — `brain log remind`(`hook: only`, 읽기 전용), 네 조건(`stop_hook_active` false, transcript로 센 사용자 발화 ≥ 상수, DB와 spool 어디에도 이 세션의 로그 없음, 표식 파일 없음), 모르면 묻지 않음, 출력 뒤에만 표식, `[discipline] stop_remind`(기본 false, 설치기는 묻지 않음, 꺼져 있으면 DB를 열지 않음), Stop 동기 줄(`timeout` 5초), `kind='stop'` 시도 기록, 30일 지난 표식 정리, 플러그인으로 설치한 상태의 검증. (AD-6·17·28; change-discipline-and-metrics D1~D3)
- E3-7 (CAP-8, CAP-9): doctor — 대조되지 않은 규칙 인용, 규칙 크기 경고(넘으면 `fail`), 세션 수 대비 시작 주입 시도 수. (FR-25, AD-17)
- E3-8 (CAP-3·8·9 스키마): 마이그레이션 0009(에픽 10의 0008 뒤) — `context_injections.kind`(`start | stop`)·`elapsed_ms`, `log_entry_edits`·`context_injections` 행 불변과 `log_entries`의 불변 칸(`kind`·`session_id`·`occurred_at`·`author_model`) trigger(I60). Postgres는 epic 7. (Table Contract, AD-17; deferred-work I60)
- E3-9 (CAP-10 경계): 패키지 경계 시험이 package.json만이 아니라 실제 소스 import·상대 경로 우회·Core의 Node API까지 본다(회고 A2). harness 등록부를 Core 조립에 주입한다(I155).

## Done when

1. 세션에서 내가 한 문장을 에이전트가 규칙으로 적으면, 다음 세션의 시작 맥락에 그 문장 그대로 들어온다. 한 글자라도 다르면(양쪽 NFC 정규화 뒤, AD-14) 들어오지 않고 점검에 보인다.
2. 내가 끈 규칙은 drain을 돌려도 다시 켜지지 않는다.
3. 결정을 바꾸면 새 결정이 옛 결정을 대체하고, 둘 다 자기 시각(`occurred_at`)으로 대화 속 자리를 가진다(메시지 연결은 저장하지 않는다, 2026-10-20). 원문 읽기는 epic-recall-and-mirror가 맡는다.
4. DB에 쓸 수 없는 동안 적은 로그가 `SPOOLED`로 성공하고, 연결 후 빠짐없이 들어간다.
5. 시작 맥락이 오늘 날짜·시간대를 포함하고, 크기 설정(글자 수)과 10,000자 상한을 지키며, 주입 시도가 성공·실패 모두 기록된다. 시작 맥락 지연(SM-7)을 실측해 기록한다.
6. doctor가 대조되지 않은 규칙 인용, 규칙 크기 경고, 세션 수 대비 주입 시도 수를 보인다. 규칙만으로 hook 상한을 넘으면 시작 맥락에 생략 줄이 들어가고 doctor는 `fail`이다(2026-10-16).
7. 시작 hook 경로가 쓰기 트랜잭션을 열지 않고(테스트가 확인), 주입 시도는 spool에 남아 drain이 `context_injections`로 넣는다(AD-6·17).
8. 플러그인 스킬의 코드블록에 적힌 모든 명령·flag가 `brain guide schema`에 있고, 스킬 파일이 빌드 생성물과 같다. 안내문 전문과 시작 맥락 요약이 같은 상수에서 나오며, 시작 맥락 머리말에 이 세션의 토큰 줄이 있다.
9. 플러그인으로 설치한 상태에서 `[discipline] stop_remind`를 켜고 사용자 발화가 상수 이상인 세션에서 로그 없이 멈추면 모델이 한 번 더 일하며 그 이유 문장이 hook 출력에 있고, 로그가 한 줄이라도 있거나(spool에 남은 것 포함) `stop_hook_active`가 true이거나 표식 파일이 있거나 세션 행이 없으면 아무것도 내지 않으며, DB 파일을 막아 둔 채 멈춰도 세션 종료가 막히지 않고(hook `timeout` 5초), drain 뒤 `context_injections`에 `kind='stop'` 행이 남는다. 토글이 꺼져 있으면 Stop hook이 DB를 열지 않는다(2026-10-20).

## Boundaries

AD-6·9·11·12·13·14·17, Table Contract(log_entries, log_entry_edits, context_injections). 검색은 epic-recall-and-mirror. 플러그인 뼈대(hooks·bootstrap)는 epic-capture가 만든다. 이 에픽은 `plugin/skills/`, SessionStart 동기 `context show` hook 줄, `guide show`의 본문(Core 상수·스킬 생성)을 만든다. `guide show` 명령 자체와 그 메타는 epic-capture의 CLI 규약 보강. 경고 코드 `RULE_UNVERIFIED`를 맡는다(`SPOOLED`는 epic-capture가 정의하고 이 에픽의 `log append`가 쓴다). AD-6의 동기 경로 규칙은 Stop 점검에도 적용된다(읽기 + spool + 표식 파일). 설정 키 `[discipline] stop_remind`와 `context_injections.kind`·`elapsed_ms`는 이 에픽이다(2026-10-20).

## References

- parent — _bmad-output/personal-brain/initiative-personal-brain.md
- spec — _bmad-output/personal-brain/spec-brain-v1-slice-1/spec-brain-v1-slice-1.md, Capabilities CAP-3, CAP-8, CAP-9
- architecture — _bmad-output/personal-brain/architecture-brain-v1-slice-1/architecture-brain-v1-slice-1.md
- prd — _bmad-output/personal-brain/prd-brain-v1-slice-1/prd-brain-v1-slice-1.md
- inputs — _bmad-output/personal-brain/inputs/weknora-patterns.md, §1.2 (B1~B7), §1.3 (C3~C6)
- research — _bmad-output/personal-brain/tickets/epic-log-and-context/epic-log-and-context-research-sources.md (원천 조사, 2026-10-23)
- research — _bmad-output/personal-brain/tickets/epic-log-and-context/epic-log-and-context-research-code.md (현행 코드와 에픽 10 충돌 지도, 2026-10-23)
- change — _bmad-output/personal-brain/change-discipline-and-metrics/change-discipline-and-metrics.md
- change — _bmad-output/personal-brain/change-surface-plugin-daemon/change-surface-plugin-daemon.md, §4.1, §4.2(AD-17)

## Notes

- Decision 참조(2026-10-15, epic-capture Notes):
  - 플러그인 `hooks/hooks.json`의 SessionStart 동기 `context show` 줄은 이 에픽이 `context show`와 함께 더한다. 이 줄도 epic-capture의 node 런처를 거치고 `|| exit 0`으로 감싼다.
  - `log append`는 epic-capture의 세션 토큰 수집으로 그 세션을 먼저 수집한다. transcript를 찾지 못하면 세션 행을 만들지 않고 spool로 간다. 꼬리표는 첫 메시지의 cwd로만 정한다.
- Decision 참조(2026-10-15, 사용자): slice 1은 회사/개인 경계를 두지 않는다. 워크스페이스는 쓰지 않고, 로그 한 줄 단위의 범위도 두지 않는다. 규칙의 적용 범위(어디서나 / 이 프로젝트)만 쓴다.
- Note(2026-10-16, `../../change-users-and-review-gaps/`, 인셉션 입력, 원문은 `../../inputs/external-review-2026-10-16.md`):
  - D6: 시작 맥락은 고정 머리말(세션 토큰 포함) → 규칙 → 최근 로그 → 안내 요약 순서로 채운다. 규칙만으로 hook 상한(10,000자)을 넘으면 현재 프로젝트 규칙 → 어디서나 규칙, 각각 최신 순으로 넣고 "규칙 N개 생략" 한 줄과 doctor `fail`(spine AD-17, PRD FR-17).
  - S2: 대조 대기(`pending`) 규칙이 출처 메시지를 지정받았다면 그것을 기록할 자리를 정한다.
- Note(2026-10-19, `../../change-masking-b-and-review-fixes/`, 인셉션 입력): 마스킹 B. 시작 맥락은 hook 출력 코덱이 가린다(spine AD-11). 작업 로그·규칙 문장은 원문으로 저장한다. 규칙 인용 대조는 저장된 원문과 하므로, 에이전트가 가린 출력에서 인용해 `[REDACTED:…]`가 든 인용은 대조가 실패한다. 양쪽을 가린 뒤 비교할지 인셉션에서 정한다.
- Note(2026-10-20, `../../change-discipline-and-metrics/`, 인셉션 입력): Stop hook 기록 점검(D1·D2·D3). 2주 실사용의 첫 주는 토글을 끄고 둘째 주에 켜서 `stats show`로 SM-4a(전체·적격 두 모집단)를 비교한 뒤 기본값을 정한다. PRD §8-3의 수단 후보 중 하나를 채택한 것이고 안내문(원본 하나, AD-17)을 대체하지 않는다.
- Note(2026-10-20, spine 리뷰): Stop 점검의 조건은 넷(spine AD-17 — `stop_hook_active` false, transcript로 센 사용자 발화 ≥ 상수, `log_entries`와 spool 어디에도 로그 없음, 표식 파일 없음), `Stop` 이벤트만, 표식은 차단 뒤에만, 모르면 묻지 않는다. `hooks.json`의 Stop 줄은 둘(2.14 비동기 수집 + 이 에픽의 동기 점검, `timeout` 5초)이고 Done when은 **플러그인으로 설치한 상태**에서 검증한다(플러그인 hook의 `decision: block`이 settings hook과 같다는 명시 서술이 문서에 없다). 인셉션에서 실측할 것: `hookSpecificOutput.additionalContext`만으로도 모델이 이어 가는지(되면 오류 대신 피드백으로 보이므로 그쪽), 발화 수 상수 3 vs 4(transcript 비동기 기록으로 하나 적게 셀 수 있다). 메타 `hook: only`라 MCP 도구로 나오지 않는다(AD-28). 표식 파일은 drain이 30일 지난 것을 지운다.
- Carry(2026-10-22, epic 2 회고, 인셉션 입력):
  - 위 Decision 참조의 "꼬리표는 첫 메시지의 cwd로만 정한다"는 2026-10-22에 바뀌었다: 근거는 세션이 시작된 폴더(`startCwd`), 없으면 첫 메시지의 cwd이고, 폴더가 지워졌으면 추정(`tag_source`)한다(epic-capture 25). 프로젝트 범위 규칙은 이 꼬리표를 따른다.
  - `log_entry_edits`·`context_injections`의 불변 trigger를 정한다(I60).
  - `TRANSCRIPT_UNREADABLE`·`SESSION_NOT_FOUND`를 중앙 코드 표에 넣을지 정한다(I50, 회고 A16) — 지금은 exit 1·hint 없음으로 나간다.
  - 잘린 도구 메모 대상의 잘림 정보를 다음 마이그레이션에 둘지 정한다(I94).
  - harness 등록부를 Core 조립에 주입하는 자리(I155), 실제 소스 import·core의 Node API까지 보는 경계 시험(회고 A2).
  - orca 워커 세션의 코디네이터 지시를 사람 발화와 구분할지(`deferred-work.md` I105, B안). Stop 점검의 발화 수에 영향이 있다.
- Decision(2026-10-23, 인셉션, 사용자가 추천을 맡김): 규칙 문장은 저장 전 정제로 고치지 않는다. 사용자 발화와 글자 그대로 대조해 켜는 구조이기 때문이다. 여러 줄·제어문자·길이 상한 초과면 USAGE로 거절한다. 진행·결정·선호는 다음 세션 시작 맥락에 한 줄씩 들어가므로 정제한다(B6).
- Decision(2026-10-23, 인셉션, 사용자가 추천을 맡김): 가린 출력에서 인용한 규칙(`[REDACTED:…]` 포함)은 특별히 다루지 않는다. 대조에 실패해 `pending`으로 남고 doctor에 보인다. 양쪽을 가린 뒤 비교하면 서로 다른 원문을 같다고 볼 수 있다.
- Decision(2026-10-23, 인셉션, 사용자가 추천을 맡김): 결정에 주제·이유·상태 칸을 더하지 않는다. 이유는 문장 안에 쓰고(B3), 대체는 에이전트가 옛 행을 `supersedes_id`로 가리키며, 상태는 대체 여부로 계산한다. 주제 이름은 에이전트마다 흔들려 묶음 기준이 되지 못한다.
- Decision(2026-10-23, 인셉션, 사용자): 시작 주입 시도는 spool에 두었다가 첫 대화가 수집되어 세션 행이 생긴 뒤 drain이 넣는다. 대화 없이 닫혀 세션 행이 끝내 생기지 않는 시도는 버린다(사용자: "첫 대화가 시작되면 쌓는다고 하면 FK는 상관없는거 아니야?").
- Decision(2026-10-23, 인셉션, 사용자가 추천을 맡김): Stop 점검의 두 실측(`additionalContext`만으로 모델이 이어 가는지, 발화 수 상수 3 vs 4)은 Stop 스토리 앞의 spike(사람)로 한다. 결과가 Stop 스토리의 구현 방식을 정한다.
- Decision(2026-10-23, 인셉션, 사용자가 추천을 맡김): Carry 가운데 I50(코드 표)은 `log append` 스토리, A2(경계 시험)는 여는 스토리, I155(harness 등록부 주입)는 tracer에서 한다. I94(잘린 도구 메모 칸)와 I105(워커 세션 표시)는 미룬다 — parser를 고쳐야 해 에픽 10의 parser 버전 업과 엉키고, Stop 점검은 기본 꺼짐이며 parser v4가 Orca 머리말을 이미 거른다.
- Decision(2026-10-23, 인셉션, 사용자가 추천을 맡김): 규칙은 `log edit`로 고치지 않는다. 고치려면 새 규칙을 적고 옛 규칙을 끈다.
- Decision(2026-10-23, 인셉션, 사용자): 에픽 10과 병렬로 만든다. 마이그레이션은 10.6(0008) 뒤 0009, Store·handler·spool record·CLI registry·doctor 목록에 붙이는 방식은 10.2가 먼저 정하고 에픽 3의 tracer가 그 뒤에 붙으며, `log append`의 선수집은 10.1 뒤다. 그 밖의 공용 목록(`brain.ts` handler 맵, Store 합성, spool 종류, registry, doctor 목록, `codes.ts`)은 순서로 막지 않고 병합으로 푼다. plugin `app-ref`·version 올리기는 배포 스토리(15) 한 곳에서 한다. tracer가 첫 항목이 아닌 것은 1~3이 공용 파일을 건드리지 않아 10.1·10.2를 기다리는 동안 할 수 있기 때문이다.
- Source conflict: PRD FR-20 — "결정은 주제, 내용, 이유, 상태를 가진다" vs 이 에픽 — 주제·이유·상태 칸 없음(위 Decision). 내용·이유는 한 문장, 상태는 `supersedes_id`로 계산한다. PRD에 그 해석을 적는다.
- Source conflict: 에픽 Done when 1·PRD FR-19 — 글자 단위로 같아야 함 vs spine AD-14 — 양쪽 NFC 정규화 뒤 비교. spine을 따르고 Done when 1에 적었다.
- Note(2026-10-23, 인셉션): 빌드 계획에서 정할 것(원천 조사 §5) — 로그 길이 상한, 10,000자의 단위(코드 포인트로 셀지, 가리기 전후, 생략 줄과 머리말 자리를 언제 남길지), 최근 로그 채우기(가까운 범위가 비었을 때만 넘어갈지, 남은 예산을 채울지), 대체된 결정·꺼진 규칙의 최근 로그 포함, `set-state`의 상태 입력, 겹친 Stop 호출에서 표식 한 번 보장, spool에서 로그 유무를 판정할 상태, 기존 `context_injections` 행의 `kind`·`elapsed_ms` 채우기(미측정을 0으로 쓰지 않음), 스킬 이름·분할과 아직 없는 에픽 4 명령을 스킬에 언제 넣을지, SM-7 측정 환경. 각 스토리가 자기 계획에서 정하고 사용자에게 묻는다.
- Decision(2026-10-23, 인셉션 집합 점검, 사용자): Stop 점검의 사용자 발화 수에는 이미지·@파일만 붙인 사람 메시지도 한 번으로 센다(에픽 10의 10.2·10.4가 이런 메시지를 살린다). spike(3)는 지금 parser로 재고 그 버전을 기록하며, Stop 스토리(12)는 10.4 뒤의 최종 parser로 다시 확인한다.
- Decision(2026-10-23, 인셉션 집합 점검, 사용자): 시작 맥락 스토리를 9(맥락 만들기와 크기 설정)와 14(주입 시도 기록 경로)로, Stop 스토리를 12(Stop 점검 동작)와 15(플러그인 배포와 설치 상태 확인, 사람)로 나눈다. tracer(4)와 `log append`(6)는 나누지 않는다 — 4는 얇게 관통하는 것이 목적이고 6은 한 명령의 완성이다.
- Note(2026-10-23, 인셉션 집합 점검): 각 스토리의 계획은 verify를 다시 돌릴 수 있게 실행 명령·픽스처 준비·판정 위치를 남긴다.
- Decision(2026-10-26, `../../change-v1-capture-and-drive/`, 사용자): V1 뒤(backlog, 삭제 아님). 15개 티켓은 그대로 두고 3.13 Refactor sweep만 drop. epic 10과의 병렬 엮음 넷(2026-10-23)은 착수 때 다시 본다. 마이그레이션 0009 번호는 epic 8의 외부 source 메타 마이그레이션이 먼저 쓸 수 있으므로 착수 때 다음 번호를 쓴다.
- Dropped(2026-10-26, `../../change-v1-capture-and-drive/`, 사용자): 13 Refactor sweep. 에픽 재개 때 확인된 결함만 기능 스토리에 흡수한다.
