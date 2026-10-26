# Currency / Reality check — spine 2026-10-20 델타

- 대상: `_bmad-output/personal-brain/architecture-brain-v1-slice-1/architecture-brain-v1-slice-1.md`의 2026-10-20 델타(`change-discipline-and-metrics/change-discipline-and-metrics.md` §4.3 적용분)
- 검토: 2026-10-20. 외부 사실만 본다(문서 품질·일관성은 다른 렌즈)
- 조회한 출처
  - `https://code.claude.com/docs/en/hooks.md` — 273,449자. offset 0 / 100,000 / 200,000 세 번 읽었다. Stop 이벤트의 입력·출력 스키마와 decision control은 **offset 100,000 구간**에 있고, `Configuration`의 병렬 실행·timeout 기본값은 0~100,000 구간, `StopFailure`·`TeammateIdle`과 async 제약은 200,000 이후 구간에 있다.
  - `https://code.claude.com/docs/en/plugins-reference.md` — 플러그인 `hooks`/`hooks/hooks.json` 병합 규칙
  - `https://raw.githubusercontent.com/openai/codex/main/codex-rs/history/src/lib.rs` (`enum RolloutItem`), 같은 리포 `codex-rs/history/src/rollout_payload.rs` (`RolloutItemWire`, `#[serde(tag = "type", rename_all = "snake_case")]`)
  - 리포 내부: `_bmad-output/personal-brain/tickets/epic-capture/epic-capture-research.md` §1 (2026-10-15 실측), `plugin/hooks/hooks.json`
  - 이 기계 실측: `claude --version` → **2.1.304**, `codex-cli 0.163.0`, `~/.codex/sessions`의 `.jsonl` 252개 `type` 집계

---

## 1. 사실별 판정

### 사실 1 — 동기 `Stop` hook이 `{"decision":"block","reason":"…"}`를 내면 Claude가 그 reason을 받아 계속 일한다

**확인(confirmed).** hooks.md Stop 절(offset 100,000 구간):

> `decision` | `"block"` prevents Claude from stopping. Omit to allow Claude to stop
> `reason` | Required when `decision` is `"block"`. Tells Claude why it should continue

출력 예시도 `{"decision": "block", "reason": "Must be provided when Claude is blocked from stopping"}` 그대로다. exit 2도 "routes the same way as `reason`"이다(연구 노트 §1의 "exit 2는 멈춤을 막는다"와 일치). spine AD-17의 "한 번만 `decision: block`과 규율 문장을 돌려준다"는 문서와 맞다.

**다만 pin하지 않은 사실 둘**(§2 F1·F2):
- 문서는 같은 절에서 **8연속 continuation 상한**을 말한다: "Claude Code applies an 8-consecutive-continuation cap: after stop hooks have continued the turn eight times in a row, Claude Code overrides the next block and ends the turn. The count of consecutive continuations resets each time Claude calls a tool. To raise the cap, set `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`." — 세션당 한 번만 막는 설계라 걸릴 일은 없지만, Brain의 hook이 **다른 Stop hook과 합산**되는 수라는 점은 기록해 둘 가치가 있다.
- `decision: "block"`은 transcript에 **hook error**로 보이고, 같은 절이 대안으로 `hookSpecificOutput.additionalContext`를 든다: "unlike `decision: "block"` it is shown in the transcript as hook feedback rather than a hook error." Brain의 점검은 오류가 아니라 넛지이므로 표현 수단 선택이 설계 결정이다.

### 사실 2 — Stop hook stdin에 `stop_hook_active`와 `transcript_path`가 있다

**확인(confirmed).** Stop 입력 예시에 `session_id`, `transcript_path`, `cwd`, `permission_mode`, `hook_event_name`, `stop_hook_active`, `last_assistant_message`, `background_tasks`, `session_crons`가 모두 있다. 의미도 문서에 있다:

> The `stop_hook_active` field is `true` when Claude Code is already continuing as a result of a stop hook. Check this value or process the transcript to avoid blocking on a condition that will never resolve.

연구 노트 §1("stdin에 `stop_hook_active`와 `last_assistant_message` 등이 있다")과 일치한다. spine의 조건 셋 중 `stop_hook_active == false`는 문서가 권하는 쓰임 그대로다.

**확인 못 함 — "턴마다 다시 false가 된다".** 제안서 D2가 선택지 (c)를 버린 이유("`stop_hook_active`만 보면 턴마다 다시 false가 되어 턴당 한 번이 된다")는 **문서에 없다**. 문서가 말하는 리셋은 8연속 상한의 카운트가 "resets each time Claude calls a tool"라는 것뿐이고, `stop_hook_active`의 수명(사용자 턴 경계에서 false로 돌아가는지)은 서술이 없다. 결론(표식 파일로 세션당 한 번을 보장)은 어느 쪽이어도 옳지만, **근거 문장은 추정이다**. spine 본문은 이 추정에 의존하지 않으므로 수정은 필요 없고, 인셉션에서 실측으로 확인할 항목이다.

**추가 사실(주의).** 같은 문서의 공통 입력 절은 transcript가 지연된다고 말하며 "Hooks that need the final assistant text of the current turn should use `last_assistant_message` on Stop and SubagentStop instead of reading the transcript"라고 한다. spine·epic 3이 **사용자 발화 수를 `transcript_path`를 parser로 읽어 센다**는 설계는 "마지막 assistant 텍스트"가 아니라 사용자 줄을 세므로 직접 금지에 걸리지는 않지만, 마지막 사용자 줄이 아직 기록되지 않았을 가능성은 남는다(한 개 적게 셀 수 있다). 임계값이 "N 이상"이라 치명적이지 않다 — 다만 경계(정확히 3번째 턴)에서 한 턴 늦게 뜰 수 있다는 것은 Done when에 적어 둘 사실이다.

### 사실 3 — 플러그인 `hooks/hooks.json`에 같은 이벤트에 처리기 둘(비동기 수집 + 동기 점검)을 등록하면 둘 다 돈다

**확인(confirmed), 단 한 칸은 미확인.** hooks.md `Configuration`:

> When an event fires, its matching hooks run in parallel. If more than 12 of them are prompt or agent hooks, 12 of those run at once and the rest start as running ones finish.

> If you define the same handler in more than one settings file, it runs once. A plugin's or skill's copy of the same handler stays separate.

플러그인 쪽: "When a plugin is enabled, its hooks merge with your user and project hooks." plugins-reference도 `hooks`가 "an inline hooks object in the same shape as `hooks` in `settings.json`"이고 "Claude Code merges whatever you declare with `hooks/hooks.json`"라고 한다. 연구 노트 §1("설정 파일의 hook과 플러그인 hook은 합쳐져 모두 돈다")과 일치한다. 즉 같은 `Stop`에 매처 둘(또는 한 매처 안에 hook 둘)은 모두 돌고, 하나가 비동기면 그것만 백그라운드로 간다(async 절: "Async hooks can't block or control Claude's behavior: response fields like `decision`, `permissionDecision`, and `continue` have no effect" — 연구 노트의 "비동기 hook은 아무것도 막지 못한다"와 일치).

**확인 못 함 — 플러그인 hook의 `decision: block`이 settings hook과 동일하게 다뤄지는지.** 문서는 차이를 **말하지 않는다**(= 반증도 없다). 모양이 같고 병합된다는 서술에서 같을 것으로 보는 게 합리적이지만, 문서에는 플러그인 hook을 다르게 취급하는 사례가 적어도 하나 있다 — SessionEnd 예산 절: "Timeouts set on plugin-provided hooks don't raise the budget." 그러므로 "플러그인에서 낸 `decision: block`도 같다"는 **명시 근거 없음**이고, epic 3의 첫 스토리에서 실제 플러그인으로 한 번 찍어 봐야 한다.

**확인 못 함 — 여러 Stop hook의 decision 결합 규칙.** 문서는 `PreModelSwitch`에 대해서만 "precedence is `deny` > `ask` > `allow`"를 적고, **Stop에는 결합 규칙이 없다**. Brain은 한 처리기만 block을 내므로 지금은 문제가 아니다.

### 사실 4 — exit 0에 stdout이 비면 아무 효과가 없다

**확인(confirmed).** 종료 코드 절: exit 0은 "Success. The action goes ahead unless JSON output blocks it"이고, 예제 설명은 "Exit code 0 with no output means the hook has no decision to report, so the tool call continues through the normal permission flow"다. 대부분 이벤트의 stdout은 디버그 로그로만 가고, 맥락에 들어가는 예외는 `UserPromptSubmit`·`UserPromptExpansion`·`SessionStart`·`PostModelSwitch`다(Stop은 아니다 — Stop은 JSON의 `reason`/`additionalContext`로만 말한다). spine의 "어떤 오류든 출력 없이 exit 0이다(NFR-3)"는 정확하다.

### 사실 5 — `UserPromptSubmit` `additionalContext` 상한은 10,000자 (제안서에만, Deferred)

**확인(confirmed), 단 상한은 이벤트별이 아니라 일반 규칙이다.** hooks.md:

> A hook's `additionalContext`, `systemMessage`, and `initialUserMessage` strings, and its plain stdout, are capped at 10,000 characters.

문자열마다 따로 재고, 넘으면 파일로 빼서 경로 + 앞 2,000자 미리보기를 준다. 연구 노트 §1의 SessionStart 서술과 같은 규칙이고, spine AD-17의 "전체는 hook 상한 10,000자 안이다"와도 일치한다. PRD §8-8 괄호 주석(`UserPromptSubmit additionalContext` 검토)은 사실 관계에서 문제 없다.

### 사실 6 (Deferred 행) — `~/.codex/sessions` JSONL 레코드의 `type`은 `session_meta`·`event_msg`·`response_item`

**모순/구식(contradicted — 불완전).** 두 경로에서 같은 결과다.

1. 원본 코드(openai/codex, `main`). `codex-rs/history/src/lib.rs`의 `pub enum RolloutItem`은 **12 variant**이고, `codex-rs/history/src/rollout_payload.rs`의 와이어 표현이 `#[serde(tag = "type", rename_all = "snake_case")]`이므로 `type` 값은 다음 12개다: `session_meta`, `response_item`, `inter_agent_communication`, `inter_agent_communication_metadata`, `compacted`, `turn_context`, `token_usage_record`, `world_state`, `retained_context`, `security_risk_score`, `event_msg`, `realtime_item`. 각 줄은 `type` + `payload` 꼴이다.
2. 이 기계 실측(2026-10-20, `.jsonl` 252개, 내용은 보지 않고 `type`만 셈): `response_item` 20,069 / `event_msg` 14,589 / `token_usage_record` 1,510 / `turn_context` 731 / `world_state` 333 / `session_meta` 282 / `inter_agent_communication_metadata` 94 / `compacted` 18. 파싱 실패 줄 0.

즉 spine이 적은 셋은 **틀리지 않았지만 레코드 집합이 아니다**(실측에 8종, 스키마에 12종). "두 번째 parser는 기술적으로 작다"는 판단에 바로 영향을 주는 사실이다: 이어받기·compact·멀티에이전트 줄(`compacted`, `turn_context`, `inter_agent_communication*`)을 어떻게 다룰지가 parser의 실제 일이다. 설치된 `codex-cli`는 0.163.0이다. (덧붙여: 제안서 §1 근거 줄은 `session_meta`·`event_msg` 둘만 적어 spine 본문보다 더 좁다.)

세션 **파일 수**는 지금 252개로, "규모 시험이 125개를 읽었다"(2026-10-08)는 당시 사실이므로 모순은 아니다 — 다만 2주 만에 두 배가 된 수라 "작게"의 근거로 재사용할 때 다시 세는 게 맞다.

### 사실 7 (대조만) — 연구 노트 §1과 spine 델타의 일치

**일치.** 연구 노트 §1의 Stop 관련 세 문장(비동기 hook은 제어 못 함 → 점검은 동기, stdin에 `stop_hook_active`, hook 경로에서 exit 2는 쓰지 않음)은 모두 2026-10-20 문서에서 그대로 유효하다. 노트가 적은 CLI는 2.1.300, 지금 설치본은 **2.1.304**다(델타의 어떤 사실도 바뀌지 않았다).

---

## 2. Spine이 pin해야 할 수치·규칙

| # | 항목 | 지금 문서 | 사실 | 권고 |
| --- | --- | --- | --- | --- |
| F1 | **동기 Stop hook의 timeout** | epic 3 Description에 "짧은 timeout"(값 없음). spine 본문에는 값이 없다 | `command` hook의 기본 timeout은 **600초**다. 문서가 기본값을 낮추는 이벤트는 `UserPromptSubmit`·`PreModelSwitch`·`PostModelSwitch`(30초)와 `MessageDisplay`(10초)뿐이고 **Stop은 목록에 없다** → Stop의 동기 command hook은 기본 600초. 문서에 "Stop은 600초"라는 문장은 없다(목록에서의 추론) | 숫자를 명시한다. 동기 점검은 DB 읽기 + transcript 파싱이므로 `"timeout": 5`(또는 3) 급으로 `hooks.json`에 **반드시** 적고, spine AD-6 또는 AD-19에 "동기 Stop 점검은 timeout을 명시한다(기본 600초를 쓰지 않는다)"를 한 줄 넣는다. 지금 상태로는 느린 디스크에서 세션 종료가 길게 멈출 수 있는데, 이는 NFR-3의 의도와 반대다 |
| F2 | **점검을 `decision: block`으로 낼지 `additionalContext`로 낼지** | AD-17: "`decision: block`과 규율 문장(원본 상수)을 돌려준다" | 둘 다 대화를 이어 가지만, `decision: "block"`은 transcript에 **hook error**로, `hookSpecificOutput.additionalContext`는 **hook feedback**으로 보인다. Stop·SubagentStop은 둘 다 받는다 | AD-17에 선택 이유를 한 구절로 적는다. 넛지를 오류로 보이게 할 이유가 없다면 `additionalContext`가 맞고, "모델이 반드시 한 번 더 일하게" 하려면 `block`이다. 지금은 선택만 있고 근거가 없어, 나중에 바꿀 때 근거를 다시 찾아야 한다 |
| F3 | **8연속 continuation 상한** | 없음 | "after stop hooks have continued the turn eight times in a row, Claude Code overrides the next block and ends the turn. The count … resets each time Claude calls a tool." 환경 변수 `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`로 올린다 | 세션당 한 번이라 걸리지 않는다. Boundaries에 한 줄(다른 Stop hook과 합산되는 수이고 Brain은 세션당 1회라 상한에 기여하지 않는다)로 남겨 두면 뒤에 "매 턴 점검"을 꺼낼 때 바로 보인다 |
| F4 | **플러그인 hook의 decision 동등성** | 전제됨(명시 없음) | 문서에 차이 서술 없음 = 명시 근거도 없음. 반례 성격의 서술 하나: SessionEnd 예산을 "플러그인 hook의 timeout은 올리지 않는다" | epic 3 Done when 9가 **플러그인으로 설치한 상태**에서 확인하도록 못박는다(settings.json에 손으로 넣은 hook으로 통과시키면 안 된다). 지금 문장은 어느 쪽인지 열려 있다 |
| F5 | **`stop_hook_active`의 수명** | 제안서 D2 근거 문장이 "턴마다 다시 false"를 사실처럼 쓴다 | 문서에 서술 없음 | spine 본문은 이 추정에 의존하지 않으므로 그대로 둔다. epic 3 인셉션에서 실측하고, 결과를 연구 노트 §1에 추가한다. 추정을 spine 본문으로 올리지 않는다 |
| F6 | **Codex 레코드 `type` 목록** | Deferred 행: "`session_meta`·`event_msg`·`response_item`" | 스키마 12종, 이 기계 실측 8종(§1 사실 6) | 세 값을 열거하지 말고 "`type` + `payload` 꼴이고 값은 12종(원본 `RolloutItem`), 이 기계에서는 8종이 보인다 — 수집 parser의 실제 일은 `compacted`·`turn_context`·`inter_agent_communication*` 처리다"로 바꾼다. 날짜와 함께 적는다 |
| F7 | **`transcript_path` 지연** | epic 3: 사용자 발화 수를 `transcript_path`로 센다 | transcript는 비동기로 기록된다. 문서는 "현재 턴의 마지막 assistant 텍스트가 필요하면 transcript를 읽지 말고 `last_assistant_message`를 쓰라"고 한다 | 사용자 줄 세기는 금지에 걸리지 않지만 한 줄 적게 셀 수 있다. AD-17 또는 epic 3 Boundaries에 "경계에서 한 턴 늦게 뜰 수 있다(transcript는 비동기 기록)"를 적고, Done when의 "사용자 발화 3개 이상"은 4턴으로 시험하는 게 안전하다 |
| F8 | **Stop이 뜨지 않는 경로** | 없음 | 2.1.x에는 `StopFailure`(API 오류로 턴이 끝날 때. "StopFailure hooks have no decision control")와 `TeammateIdle`(agent team teammate)이 따로 있다 | 지표 해석의 사실이다: rate limit·overload로 끝난 세션에는 점검이 뜨지 않는다. `stats show`의 "Stop 점검 뒤 로그가 생긴 비율" 분모가 "로그 없는 세션 전부"가 아니라는 것을 epic 5 Notes에 한 줄 |

---

## 3. 구식·틀림 판정 요약

| 사실 | 판정 | 출처 |
| --- | --- | --- |
| 1. Stop 동기 hook의 `{"decision":"block","reason"}` → 계속 일함 | **확인** | hooks.md (offset ~100k, Stop 절) |
| 2. Stop stdin의 `stop_hook_active`·`transcript_path` | **확인** | hooks.md Stop 입력 예시 + 연구 노트 §1 |
| 2b. `stop_hook_active`가 턴마다 리셋 | **확인 못 함**(문서에 없음. 제안서 D2 근거에만) | hooks.md |
| 3. 플러그인 `hooks.json`에 같은 이벤트 처리기 둘 → 둘 다 돈다 | **확인** | hooks.md Configuration, plugins-reference `hooks` |
| 3b. 플러그인의 `decision: block`이 settings와 동일 | **확인 못 함**(차이 서술 없음 = 보증도 없음) | hooks.md, plugins-reference |
| 4. exit 0 + 빈 stdout → 효과 없음 | **확인** | hooks.md 종료 코드 절 |
| 5. `additionalContext` 상한 10,000자 | **확인**(이벤트별이 아니라 hook 출력 일반 규칙) | hooks.md |
| 6. Codex `type`이 `session_meta`·`event_msg`·`response_item` | **모순(불완전)** — 스키마 12종, 실측 8종 | openai/codex `codex-rs/history/src/{lib,rollout_payload}.rs`; 이 기계 `~/.codex/sessions` 집계 |
| 7. 연구 노트 §1과의 일치 | **일치**. CLI는 2.1.300 → **2.1.304**(사실 변화 없음) | 리포 노트 + `claude --version` |

구식인 것은 **하나(사실 6)**다. 나머지 네 개의 바인드는 2026-10-20 문서로 그대로 유효하고, 바인드하지 않았지만 설계가 의존하는 수 하나(**Stop command hook의 기본 600초**)가 pin되어 있지 않다 — 이것이 이 검토에서 가장 실질적인 항목이다.

## 4. 적용 제안(최소)

1. **F1** — AD-6의 Stop 점검 문장 끝 또는 AD-19 플러그인 항목에: "동기 Stop 점검의 `timeout`은 `hooks.json`에 명시한다(command hook 기본은 600초다)." epic 3 Description의 "짧은 timeout"에 숫자를 넣는다.
2. **F6** — Deferred의 Codex 행에서 세 `type` 열거를 §2 F6의 문장으로 교체.
3. **F2** — AD-17의 `decision: block`에 선택 이유 한 구절(또는 `additionalContext`로 바꾼다).
4. **F4·F7** — epic 3 Done when 9에 "플러그인으로 설치한 상태"와 "4턴 세션"을 명시(에픽 파일이므로 spine 밖).
5. **F3·F8** — 각각 한 줄씩 Boundaries / epic 5 Notes.

1·2·3은 spine 문장이고, 4·5는 에픽 파일 쪽이다. 어느 것도 AD 구조나 결정을 바꾸지 않는다.
