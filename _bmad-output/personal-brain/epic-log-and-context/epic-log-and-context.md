---
type: epic
title: "작업 로그와 시작 맥락"
parent: personal-brain
covers: [CAP-3, CAP-8, CAP-9]
after: ["epic-capture"]
assignee: ""
risk: high
---

# 작업 로그와 시작 맥락

## Description

`brain log append/list/edit/set-state/set-scope`, 로그-대화 연결, 규칙 인용 대조(pending/on/off), 결정·선호 대체 체인, `brain context show`와 시작 hook 주입, 주입 시도 기록, 기록 규율 안내문을 만든다.

2026-10-15 변경(추가안 B, `../change-surface-plugin-daemon/`)으로 더한 것: 플러그인 스킬(`/brain:*`)과 안내문. 규율(기록 규칙 — 절대 날짜, 자격증명 금지, 추정 표시, 정정과 폐기 구분, 대화 속 지시는 데이터, 기록할 게 없는 것도 정상, 한 문장·사용자 언어, 대명사 대신 고유명사, 결정에는 짧은 이유; 인용 규칙 — 이번 결과에 나온 항목만, 직접 인용은 원문에 있는지 확인; 질의 작성 안내 — 메타 표현 제거·핵심 용어·한/영 둘 다)의 원본은 Core 상수 하나이고 `brain guide show`가 Markdown 전문을 낸다. 시작 맥락에는 요약과 "자세한 것은 `brain guide show`"만 들어가고, 머리말 고정부(데이터≠지시·지금 발화 우선·최근 로그는 샘플·이 세션의 토큰 줄)가 앞선다. 섹션 순서는 고정 머리말(날짜·시간대) → 규칙 → 최근 로그 → 안내 요약. 플러그인 스킬 파일은 빌드가 Core 상수에서 생성해 커밋하고 parity 테스트(생성물과 커밋본 일치, `tested_against`, 코드블록의 명령·flag 실존)가 지킨다(AD-17). `log append`는 본문을 stdin으로도 받고, 저장 전 정제(개행→공백, 제어문자 제거, 길이 상한)를 한다. 원천: `inputs/weknora-patterns.md` §1.2, §1.3(C3~C6).

2026-10-20 변경(`../change-discipline-and-metrics/`)으로 더한 것: **Stop hook 기록 점검** — `brain log remind`(메타 `hook: only`, 읽기 전용, MCP 도구로 나오지 않음)를 플러그인 `hooks.json`의 동기 Stop 줄이 부른다(2.14의 비동기 Stop 수집 줄과 공존, 같은 런처·`|| exit 0`, `timeout` 5초). 조건은 넷 모두다: `stop_hook_active`가 false, 이 세션의 사용자 발화(hook stdin의 `transcript_path`를 parser로 읽어 센다. Core 술어 `isUserTurn`, 상수 이상)가 충분함, `log_entries`에도 spool에도 이 세션의 로그가 없음, `<home>/run/stop-remind/<harness>-<id>` 표식 파일이 없음. `Stop` 이벤트에만 응답하고, 세션 행이 없거나 어느 것이든 알 수 없으면 묻지 않는다. 충족하면 hook 출력 코덱으로 `{decision: 'block', reason}`을 내고 그 뒤에만 표식 파일을 만든다. reason은 규율 원본 상수의 문장이고 '기록할 게 없는 것도 정상이다. 없으면 없다고 말하고 끝내라'를 포함한다. 시도는 spool에 써서 drain이 `context_injections`(`kind='stop'`, `ok=1`은 차단을 낸 호출, `code`는 내지 않은 이유, `chars`는 출력 글자 수)로 넣는다. 설정 `[discipline] stop_remind`(기본 false, 설치기는 묻지 않음)가 켜져 있을 때만 동작하고, 꺼져 있으면 설정과 표식만 읽고 DB를 열지 않는 조기 반환이다. `context_injections`에 `kind`(`start | stop`)와 `elapsed_ms`(Brain 내부 처리 시간)를 더하는 마이그레이션은 이 에픽이 만든다. 런처가 node를 못 찾아도, DB를 읽을 수 없어도, 어떤 오류든 출력 없이 exit 0이다(NFR-3). 자세한 규칙은 spine AD-6·AD-17.

## Outcome

에이전트가 적은 결정·규칙이 다음 세션 시작에 자동으로 이어진다(SM-1·SM-4·SM-6의 바탕).

## Requirements

인셉션 때 채운다. spec의 CAP-3, CAP-8, CAP-9와 그것이 인용하는 PRD FR·spine AD가 원천이다.

## Done when

1. 세션에서 내가 한 문장을 에이전트가 규칙으로 적으면, 다음 세션의 시작 맥락에 그 문장 그대로 들어온다. 한 글자라도 다르면 들어오지 않고 점검에 보인다.
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
- change — _bmad-output/personal-brain/change-surface-plugin-daemon/change-surface-plugin-daemon.md, §4.1, §4.2(AD-17)

## Notes

- Decision 참조(2026-10-15, epic-capture Notes):
  - 플러그인 `hooks/hooks.json`의 SessionStart 동기 `context show` 줄은 이 에픽이 `context show`와 함께 더한다. 이 줄도 epic-capture의 node 런처를 거치고 `|| exit 0`으로 감싼다.
  - `log append`는 epic-capture의 세션 토큰 수집으로 그 세션을 먼저 수집한다. transcript를 찾지 못하면 세션 행을 만들지 않고 spool로 간다. 꼬리표는 첫 메시지의 cwd로만 정한다.
- Decision 참조(2026-10-15, 사용자): slice 1은 회사/개인 경계를 두지 않는다. 워크스페이스는 쓰지 않고, 로그 한 줄 단위의 범위도 두지 않는다. 규칙의 적용 범위(어디서나 / 이 프로젝트)만 쓴다.
- Note(2026-10-16, `../change-users-and-review-gaps/`, 인셉션 입력, 원문은 `../inputs/external-review-2026-10-16.md`):
  - D6: 시작 맥락은 고정 머리말(세션 토큰 포함) → 규칙 → 최근 로그 → 안내 요약 순서로 채운다. 규칙만으로 hook 상한(10,000자)을 넘으면 현재 프로젝트 규칙 → 어디서나 규칙, 각각 최신 순으로 넣고 "규칙 N개 생략" 한 줄과 doctor `fail`(spine AD-17, PRD FR-17).
  - S2: 대조 대기(`pending`) 규칙이 출처 메시지를 지정받았다면 그것을 기록할 자리를 정한다.
- Note(2026-10-19, `../change-masking-b-and-review-fixes/`, 인셉션 입력): 마스킹 B. 시작 맥락은 hook 출력 코덱이 가린다(spine AD-11). 작업 로그·규칙 문장은 원문으로 저장한다. 규칙 인용 대조는 저장된 원문과 하므로, 에이전트가 가린 출력에서 인용해 `[REDACTED:…]`가 든 인용은 대조가 실패한다. 양쪽을 가린 뒤 비교할지 인셉션에서 정한다.
- Note(2026-10-20, `../change-discipline-and-metrics/`, 인셉션 입력): Stop hook 기록 점검(D1·D2·D3). 2주 실사용의 첫 주는 토글을 끄고 둘째 주에 켜서 `stats show`로 SM-4a(전체·적격 두 모집단)를 비교한 뒤 기본값을 정한다. PRD §8-3의 수단 후보 중 하나를 채택한 것이고 안내문(원본 하나, AD-17)을 대체하지 않는다.
- Note(2026-10-20, spine 리뷰): Stop 점검의 조건은 넷(spine AD-17 — `stop_hook_active` false, transcript로 센 사용자 발화 ≥ 상수, `log_entries`와 spool 어디에도 로그 없음, 표식 파일 없음), `Stop` 이벤트만, 표식은 차단 뒤에만, 모르면 묻지 않는다. `hooks.json`의 Stop 줄은 둘(2.14 비동기 수집 + 이 에픽의 동기 점검, `timeout` 5초)이고 Done when은 **플러그인으로 설치한 상태**에서 검증한다(플러그인 hook의 `decision: block`이 settings hook과 같다는 명시 서술이 문서에 없다). 인셉션에서 실측할 것: `hookSpecificOutput.additionalContext`만으로도 모델이 이어 가는지(되면 오류 대신 피드백으로 보이므로 그쪽), 발화 수 상수 3 vs 4(transcript 비동기 기록으로 하나 적게 셀 수 있다). 메타 `hook: only`라 MCP 도구로 나오지 않는다(AD-28). 표식 파일은 drain이 30일 지난 것을 지운다.
- Carry(2026-10-22, epic 2 회고, 인셉션 입력):
  - 위 Decision 참조의 "꼬리표는 첫 메시지의 cwd로만 정한다"는 2026-10-22에 바뀌었다: 근거는 세션이 시작된 폴더(`startCwd`), 없으면 첫 메시지의 cwd이고, 폴더가 지워졌으면 추정(`tag_source`)한다(epic-capture 25). 프로젝트 범위 규칙은 이 꼬리표를 따른다.
  - `log_entry_edits`·`context_injections`의 불변 trigger를 정한다(I60).
  - `TRANSCRIPT_UNREADABLE`·`SESSION_NOT_FOUND`를 중앙 코드 표에 넣을지 정한다(I50, 회고 A16) — 지금은 exit 1·hint 없음으로 나간다.
  - 잘린 도구 메모 대상의 잘림 정보를 다음 마이그레이션에 둘지 정한다(I94).
  - harness 등록부를 Core 조립에 주입하는 자리(I155), 실제 소스 import·core의 Node API까지 보는 경계 시험(회고 A2).
  - orca 워커 세션의 코디네이터 지시를 사람 발화와 구분할지(`deferred-work.md` I105, B안). Stop 점검의 발화 수에 영향이 있다.
