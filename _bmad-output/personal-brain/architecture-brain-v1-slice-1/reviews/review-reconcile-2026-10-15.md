---
title: 'Review — 추가안 B(change-surface-plugin-daemon) ↔ architecture spine 대조'
type: review-reconcile
target: ../architecture-brain-v1-slice-1.md
inputs:
  - ../../change-surface-plugin-daemon/change-surface-plugin-daemon.md
  - ../../inputs/weknora-patterns.md
  - ../.memlog.md
date: '2026-10-15'
verdict: '§4.2의 편집 지시 40개 중 빠진 것은 0건이고, 다르게 들어간 9건은 전부 D4·D5·D6이나 A1·AD-24 정합에 따른 의도적 보정(7건)이거나 같은 뜻의 표기 차이(2건)다. 스파인 11개는 모두 착지했고 §4.1 에픽 Done when의 전제도 한 건(doctor `writable`)만 빼고 AD로 뒷받침된다. 남은 것은 한 문장짜리 틈 3건과, change 문서 §2.2가 AD-20을 "그대로"로 적은 오기다'
---

# Review — 추가안 B ↔ spine 대조 (2026-10-15 update)

## 0. 읽는 법

- 대상은 `architecture-brain-v1-slice-1.md`(2026-10-15 update, working tree). 대조 기준은 승인된 Sprint Change Proposal의 **§4.2 Architecture spine** 항목 하나하나다.
- 판정은 셋이다.
  - **그대로** — 지시한 문장·컬럼이 같은 뜻으로 들어갔다. 참조(AD 번호) 추가, 문장 분할, 지시가 없던 정합 보강은 "그대로"로 본다.
  - **다르게** — 지시와 내용이 다르다. 다시 **의도(D4·D5·D6 또는 inputs §1 원문과의 정합에 근거)** 와 **누락**으로 가른다.
  - **빠짐** — 들어가지 않았다.
- "건드려지지 않았는지"는 `git diff`(HEAD ↔ working tree)의 hunk 범위로 기계적으로 확인했다. spine 줄 번호는 현재 파일 기준이다.
- §4.2가 요구하지 않았는데 spine이 더한 것은 §7에 따로 둔다(판정 대상이 아니지만, 다음 리뷰가 "출처 없는 문장"으로 잡지 않게).

## 1. 요약 판정

| 구분 | 건수 | 메모 |
|---|---|---|
| §4.2 지시 항목(세부 단위) | 40 | §2 |
| └ 그대로 | 31 | — |
| └ 다르게 — 의도적 보정 | 7 | 전부 상향(원문 정합·결정 반영). §3.1 |
| └ 다르게 — 표기만 | 2 | 같은 뜻. §3.2 |
| └ 다르게 — 누락 | 0 | — |
| └ 빠짐 | 0 | — |
| §4.1 에픽 Done when·Description의 전제 | 24 | §4. 뒷받침 23, 부분 1 |
| inputs §1 스파인 11개 | 11 | §5. 착지 11, 미착지 0 |
| "그대로"로 둬야 할 AD(1, 3, 4, 6~14, 16, 18, 21~23) | 17 | §6. 전부 미편집 확인 |
| §4.2 미요구 추가 | 9 | §7. 전부 정합 |
| 한 문장짜리 틈(권고) | 3 | §3.3 |
| change 문서 쪽 오기 | 1 | §6.2 (AD-20) |

기계적 점검 하나: 이번 편집이 건드린 구역은 frontmatter, Design Paradigm, AD-2, AD-5, AD-15, AD-17, AD-19, **AD-20**, AD-24, AD-25, AD-26~28(신설), Table Contract 3행, Conventions 1행 수정 + 4행 신설, Stack 1행, Structural Seed, Capability Map 1행, Deferred 4행 수정 + 1행 신설이다. §4.2가 열거한 구역과 정확히 일치하고, 초과는 Design Paradigm과 AD-20 둘뿐이다(둘 다 §6.2에서 필요한 편집으로 판정).

---

## 2. §4.2 항목별 대조표

### 2.1 AD-2 · AD-5

| # | §4.2 지시 | spine 착지 | 판정 | 메모 |
|---|---|---|---|---|
| R-1 | AD-2 문장 추가: 진입점 둘(npx github / 플러그인), 둘 다 같은 bootstrap, 설치 본문은 `setup run` 하나 | 64 | 그대로 | `(AD-19)` 참조만 더했다 |
| R-2 | AD-5 `admin` 행에 `schema`, `exit-codes`, `guide` + "명령 메타·종료 코드·안내문 전문 출력(FR-24, AD-17)" | 108 | 그대로 | FR 번호를 표의 기존 관례(괄호 안 숫자)로 적어 `24`가 들어갔다. 표기 통일 |
| R-3 | AD-5 새 행: `mcp`\|`serve`(AD-28), `daemon`\|`run`,`status`,`stop`(AD-27) | 110~111 | 그대로 | `epic 9` 표시 추가 |
| R-4 | AD-5 Rule에 **표면 중립** 한 줄 | 97 | 그대로 | 문장 그대로 |
| R-5 | "slice 1은 CLI만 내고" → "…(MCP·데몬은 epic 9)" | 96 | 그대로 | — |

### 2.2 AD-15 (두 문구)

| # | §4.2 지시 | spine 착지 | 판정 | 메모 |
|---|---|---|---|---|
| R-6 | 결과 계약의 문서 출처: 조각 위치를 `locator`(`{type, page, block, start, end, start_ms, end_ms, sheet, row_start, row_end}`)로 | 245 | **다르게(의도)** | spine은 `bbox`를 더해 11필드다. §4.2의 AD-24 NEW("pdf 쪽·**영역**")와 inputs A1("pdf `page`+`bbox`")이 bbox를 요구하므로, 빠뜨린 쪽은 §4.2의 AD-15 목록이다. 상향 보정 |
| R-7 | 잘림: 낮은 순위 행부터 통째로, 1위 보존, `RESULT_TRUNCATED` + `meta.omitted{count, reason}`·`meta.next{ns, verb, args}`, 행 안 자르기는 최후 수단 | 247 | 그대로 | 끝에 `has_more`는 limit+1·0건도 `count`(C10)를 더했다 — §4.1 epic 4가 요구한 것이라 정합 |
| R-8 | 검색 실패(`SEARCH_FAILED`)와 0건(`ok`, `data: []`, `meta.hint`) 구분 | 248 | 그대로 | C1의 세 번째 통("미설치·미초기화는 exit 2")까지 적었다. 상향 |

### 2.3 AD-17 (두 문구, D6)

| # | §4.2 지시 | spine 착지 | 판정 | 메모 |
|---|---|---|---|---|
| R-9 | 규율의 원본은 Core 상수 하나, `admin.guide`가 전문, 시작 맥락엔 요약 + "자세한 것은 `brain admin guide`", 스킬 본문은 `guide`·`schema` 출력에서 생성 + parity 테스트, AGENTS.md·CLAUDE.md는 한 줄 이상 금지 | 264 | 그대로 | 끝에 "켜진 규칙은 시작 맥락으로만 나간다"(OLD에서 살린 제약)를 유지했다 — 잃으면 안 되는 문장이라 잘 보존했다 |
| R-10 | 주입 머리말 고정부 3개(데이터≠지시·권한 없음 / 지금 발화 우선 / 최근 로그는 샘플) | 265 | 그대로 | 별 bullet으로 분리 |

### 2.4 AD-19 (요지 7개)

| # | §4.2 지시 | spine 착지 | 판정 | 메모 |
|---|---|---|---|---|
| R-11 | 설치 본문 하나 / 진입점 둘, (a) 플러그인 SessionStart 비동기 hook이 shim 없거나 `app-ref` 다를 때만 `bootstrap.js --yes --ref`, 매 세션은 검사만, (b) 그 밖은 `npx github:…` 대화형 | 283 | 그대로 | "비대화형은 `--yes`가 동의", "파일 둘 읽기"까지 명시 |
| R-12 | **hook의 출처는 하나.** Claude Code는 플러그인 `hooks/hooks.json`. `setup connect claude-code`는 확인·안내 + 표식 hook 제거. 플러그인 체계 없는 Harness만 설치기가 hook을 쓴다 | 285 | 그대로 | 제목을 "Harness마다 하나"로 적어 AD-4의 Harness 중립과 어긋나지 않게 했다 |
| R-13 | bootstrap: 설치 잠금(원자적 mkdir·pid·stale 회수·exit 0), 완료 표식은 shim, 진입점 24.16 하한, 적힌 ref로만 ff, `--frozen-lockfile`(가능하면 `--ignore-scripts`) | 286 | 그대로 | 앱 위치 `~/.second_brain/app`·캐시 빌드 금지를 이 bullet에 합쳤다 |
| R-14 | shim: 설치 시점 node 절대 경로, 없으면 nvm→Homebrew→`/usr/local/bin`→volta→fnm, PATH 메모 | 287 | 그대로 | — |
| R-15 | 플러그인은 작다(`plugin.json`, `hooks/`, `skills/`, `bootstrap.js` 복사본, `app-ref`), 플러그인 버전이 앱 커밋 고정, 설명에 자동 clone·install·build 명시 | 288 | 그대로 | — |
| R-16 | doctor: 기존 + 플러그인 버전·앱 빌드 버전 일치, `ok \| warn \| fail \| skip{reason}`, `summary{passed, warned, failed, skipped}`, `warn`은 exit 0 | 289 | **다르게(표기)** | spine은 `skip`(`skip`에는 `reason`), `summary`(passed·warned·failed·skipped 건수)로 풀어 썼다. 뜻은 같다. §3.2 |
| R-17 | `/plugin uninstall`은 데이터·LaunchAgent를 안 지우므로 `setup uninstall`은 남는다(AD-20) | 288 | 그대로 | — |

### 2.5 AD-24 · AD-25 · AD-26~28

| # | §4.2 지시 | spine 착지 | 판정 | 메모 |
|---|---|---|---|---|
| R-18 | AD-24: 조각마다 `locator`(JSON, 종류별), 파일당 단조 `attempt`, 실패 시 `failed_stage(read\|extract\|chunk\|index)`, 포인터 전환은 `attempt`가 큰 세대만 | 338 | 그대로 | 종류별 필드명을 전부 적었다(pdf `page`·`bbox` / docx `block` / text `start`·`end` / time `start_ms`·`end_ms` / sheet `sheet`·`row_start`·`row_end`). D5의 "단계 트리·`cancelled` 없음"도 지켰다 |
| R-19 | AD-25 교체: 데몬 없으면 LaunchAgent, 데몬 켜면 데몬 drain 루프가 맡고 주기 LaunchAgent는 등록하지 않음, 둘 다 `admin.drain`, 데몬 꺼진 동작은 AD-6·7·9 그대로 | 350 | 그대로 | "(있으면 지운다)"를 더했다 — 업그레이드 경로의 실제 구멍을 막는 보강 |
| R-20 | AD-26 소켓 규약: `<home>/run/brain.sock` 0600, 요청 `{ns, verb, args, session?}`, 응답은 CLI 엔벨로프, 첫 메시지 버전 handshake, 불일치 `VERSION_MISMATCH` + 재시작 신호 | 352~359 | 그대로 | 디렉터리 0700, "verb는 AD-5 표의 것만", 프레이밍은 epic 9 인셉션을 더했다 |
| R-21 | AD-27 데몬 수명: `brain daemon run` 하위 명령, 단일 인스턴스 잠금, SIGTERM, 로그 `<home>/log/`, LaunchAgent KeepAlive 별도 Label, `setup upgrade` 재시작, DB 못 쓰면 같은 spool, hook 클라이언트는 소켓 우선 | 361~369 | 그대로 | Label 이름(`…second-brain.daemon`), drain 루프·watcher, "데몬 꺼져도 전부 동작 + epic 2~5 테스트는 데몬 없이 통과", doctor `warn`까지 적었다 |
| R-22 | AD-28 MCP 표면: `brain mcp serve` stdio, 도구 이름 `<ns>_<verb>`, 스키마는 명령 메타에서 생성, 쓰기 verb는 `session` 필수(`SESSION_REQUIRED`), 읽기는 선택, 세션 토큰은 시작 맥락 | 371~378 | 그대로 | 플러그인 `.mcp.json` 선택 등록(epic 9 Description), `CONFIRMATION_REQUIRED` 동일 처리, 결과는 같은 엔벨로프를 `content`에 — 셋 다 보강 |

### 2.6 Table Contract (3행)

| # | §4.2 지시 | spine 착지 | 판정 | 메모 |
|---|---|---|---|---|
| R-23 | `redactions`: "`messages.redact`, `files.redact`(epic 2), 수집의 저장 전 마스킹(`pattern_version` 기록)" / 불변 | 397 | **다르게(의도)** | spine은 "`messages.redact`, `files.redact`, **수집·추출**의 저장 전 마스킹(`pattern_version` 기록)". AD-23("첨부 텍스트의 저장 전 마스킹은 추출 시점에")과 맞춘 보정이고, `(epic 2)` 주석 생략은 표 관례상 무해 |
| R-24 | `document_extractions`: "`id`. 파일당 `attempt` 단조" / "상태·`failed_stage`만 진행. 내보내기에 포함" | 404 | **다르게(의도)** | spine은 기존 제약 "같은 `extractor_version`의 진행 중 세대는 하나"를 함께 남겼다. §4.2 문구만 그대로 쓰면 그 제약이 삭제돼 보였을 자리다. 보존이 맞다 |
| R-25 | `document_chunks`: "`(extraction_id, ordinal)`. 조각마다 `locator`" / 변경 없음 | 405 | 그대로 | `(JSON)` 표기 추가 |

### 2.7 Conventions (1행 수정 + 4행 신설)

| # | §4.2 지시 | spine 착지 | 판정 | 메모 |
|---|---|---|---|---|
| R-26 | CLI `--json` 응답: `{ ok, now, data, warnings[], error?, meta? }`, `error{code, message, exit_code, retryable?, hint?, retry?{ns,verb,args}}`, `meta{hint?, count?, has_more?, omitted?, next?}`, 기존 경고 목록 유지, `SEARCH_FAILED`(오류 코드) | 441 | **다르게(의도)** | spine은 오류 코드를 넷으로 적었다(`SEARCH_FAILED`, `CONFIRMATION_REQUIRED`, `SESSION_REQUIRED`, `VERSION_MISMATCH`). 신설 AD가 만든 코드라 상향. 다만 AD-15가 쓰는 `CONFIG_MISSING`이 이 목록에 없다 → §3.3 G-2 |
| R-27 | 종료 코드 신설: 0/1/2/**3 확인 필요**(비TTY·`--json`에서 `--yes` 없는 파괴적 명령, `error.retry`에 `--yes`), hook 경로는 항상 0, 에이전트 금지 행동 6개 | 442 | 그대로 | `error.code = CONFIRMATION_REQUIRED`와 "`admin exit-codes`가 이 표를 `{code, meaning, agent_action}`로 낸다"(E3)를 더했다 |
| R-28 | 명령 메타 신설: `used_for`, `required`, `examples`, `output`, `risk(read\|write\|destructive)`, `hookSafe`, `dryRun`. `admin schema`·`--help`·MCP 스키마는 이 메타 하나에서 생성. 누락은 테스트 실패 | 443 | 그대로 | 문장 그대로. AD-5 Rule에도 같은 취지 한 줄(교차 참조) |
| R-29 | hint·retry 문체 신설: 소문자 시작·마침표 없음·백틱, `retry.args`는 바꾼 인자만·비밀값 제외, 진짜 첫 단계, 오타 가능 상황엔 파괴적 hint 금지 | 444 | 그대로 | 문장 그대로 |
| R-30 | doctor 상태: `ok \| warn \| fail \| skip{reason}` | 445 | **다르게(표기)** | spine은 `skip`(`skip`에는 `reason`) + "`fail`만 exit 1" + `summary`에 건수. 뜻은 같고 exit 매핑은 보강. §3.2 |

### 2.8 Stack · Structural Seed · Capability map · Deferred

| # | §4.2 지시 | spine 착지 | 판정 | 메모 |
|---|---|---|---|---|
| R-31 | Stack 변경 없음. Notes에 "2026-10-15 사용자 확인: Node 24 이상 유지. 20은 `node:sqlite` 없음, 22.13+는 `DatabaseSync.timeout` 확인 뒤에만" | 457 | **다르게(표기)** | Stack에 별도 Notes 절이 없어 Node.js 행의 메모 칸에 넣었다. 문구는 그대로. 위치만 다르고 더 맞는 자리다 |
| R-32 | Structural Seed에 `plugin/`(plugin.json, hooks, skills, bootstrap.js 복사본, app-ref) | 486 | 그대로 | — |
| R-33 | `apps/cli`에 `daemon`·`mcp` 하위 명령(epic 9) 메모 | 485 | 그대로 | — |
| R-34 | 배치도에 "플러그인 hook → shim" 화살표 | 492 | 그대로 | 데몬 노드와 "epic 9: 소켓 (있으면)" 화살표도 더했다 |
| R-35 | Capability map 행: "표면: 플러그인·MCP·데몬 (FR-24, FR-25) \| `plugin/`, `apps/cli` `mcp`·`daemon` \| AD-5, AD-17, AD-19, AD-26~28" | 518 | 그대로 | AD-26~28을 풀어 적었다 |
| R-36 | Deferred "MCP 도구" → 해소: epic 9, AD-28(세션 인자 규약) | 530 | 그대로 | — |
| R-37 | Deferred "데몬·파일 watcher" → 해소: epic 9, AD-27 | 531 | 그대로 | AD-26도 함께 참조. "Telegram·원격 수집·승인 대기는 그 뒤 조각"을 남겨 AD-25 OLD의 유보 사유를 잃지 않았다 |
| R-38 | Deferred "Claude Code plugin·skill, BMad memlog 연계, 기록 보강 수단" → 플러그인은 AD-19로 확정(epic 2·3), memlog 연계와 그 이상은 SM-4 뒤 그대로 | 543 | 그대로 | 행 제목에서 plugin·skill을 빼고 "AD-17·19로 확정"으로 적었다. "어떤 수단도 AD-17(원본 하나)을 넘지 않는다"로 D6과 연결 |
| R-39 | Deferred "Codex 등 다른 Harness" → 2026-10-15 메모(당분간 Claude Code만, hook 실험 기능·해시 확인 필요) | 533 | 그대로 | — |
| R-40 | AD-26~28 본문을 이번 갱신에서 쓴다(§4.2 전제, §5 성공 기준 1) | 352~378 | 그대로 | 요지 3개가 전부 Binds·Prevents·Rule을 갖춘 본문이 됐다 |

---

## 3. 다르게 들어간 것 — 판정과 고칠 문장

### 3.1 의도적 보정 7건 (고칠 것 없음)

| # | 무엇이 다른가 | 근거 | 판정 |
|---|---|---|---|
| R-6 | `locator` 필드에 `bbox` 추가 | inputs A1(pdf `page`+`bbox`), §4.2의 AD-24 NEW("pdf 쪽·영역"), memlog `(decision) AD-24 개정(D4·D5)` | 의도. §4.2의 AD-15 필드 목록이 bbox를 빠뜨린 쪽이다 |
| R-7 | `has_more`는 limit+1·0건도 `count` 추가 | C10, §4.1 epic 4 Description | 의도 |
| R-8 | "미설치·미초기화는 exit 2 코드" 추가 | C1의 세 번째 통, §4.1 epic 4 Description | 의도 |
| R-23 | "수집" → "수집·추출"의 마스킹 | AD-23(추출 시점 마스킹), A6 | 의도 |
| R-24 | `document_extractions` 기존 제약 보존 | 기존 Table Contract. §4.2는 "행 수정"이고 삭제 지시가 아니다 | 의도 |
| R-26 | 오류 코드 3개 추가 | AD-26·27·28이 만든 코드 | 의도 |
| R-19 | AD-25에 "(있으면 지운다)" | AD-20 업그레이드 경로 | 의도 |

### 3.2 표기만 다른 것 2건 (고칠 것 없음)

| # | §4.2 | spine | 판정 |
|---|---|---|---|
| R-16·R-30 | `skip{reason}`, `summary{passed, warned, failed, skipped}` | `skip`(`skip`에는 `reason`), `summary`에 passed·warned·failed·skipped 건수 | 같은 뜻. 중괄호 표기를 쓰는 다른 자리(`meta.omitted{count, reason}`)와 통일하고 싶으면 두 곳(289, 445)을 `skip{reason}`·`summary{passed, warned, failed, skipped}`로 바꾸면 된다. 선택 사항 |
| R-31 | Stack **Notes**에 메모 | Node.js **행 메모 칸**에 같은 문구 | 같은 뜻. Stack에 Notes 절이 없어 행 안이 더 맞다 |

### 3.3 남은 틈 3건 — 한 문장씩 (누락이 아니라 §4.2가 요구하지 않았으나 다른 문서가 전제하는 것)

| # | 틈 | 누가 전제하나 | 고칠 문장 |
|---|---|---|---|
| G-1 | AD-19 doctor 검사 목록에 **쓰기 가능 여부(`writable`)** 항목이 없다. 등급(`warn`)만 있다 | §4.1 epic 2 **Done when 9**: "doctor의 `writable` 검사 불가는 `warn`이다". inputs E7 | AD-19 doctor bullet(289)에 추가: "데이터 폴더·원본 파일의 쓰기 가능 여부(확인할 수 없으면 `warn`)" |
| G-2 | Conventions 오류 코드 목록(441)에 **`CONFIG_MISSING`**이 없다. AD-15(248)는 쓰고 있다 | inputs E9(README 종료 코드·코드 목록과 코드의 양방향 대조 테스트)가 목록 완결을 전제한다 | 441행 끝 목록을 "오류 코드에 `SEARCH_FAILED`, `CONFIG_MISSING`, `DB_UNAVAILABLE`, `CONFIRMATION_REQUIRED`, `SESSION_REQUIRED`, `VERSION_MISMATCH`가 있다"로 (DB_UNAVAILABLE은 경고 목록에도 있으니 "경고와 오류 양쪽"임을 한 괄호로) |
| G-3 | Structural Seed(486)에 루트 `.claude-plugin/marketplace.json`과 `plugin/.claude-plugin/plugin.json`의 자리가 없다. 지금은 `plugin/`에 `plugin.json`이 바로 있는 모양이다 | change 문서 **§2.3**: "`plugin/`: `.claude-plugin/plugin.json` … 루트 `.claude-plugin/marketplace.json`이 `./plugin`을 가리킨다" | Structural Seed에 한 줄: "`.claude-plugin/` # marketplace.json(루트) — `./plugin`을 가리킨다", 그리고 `plugin/` 주석을 "`.claude-plugin/plugin.json`, hooks/, skills/, bootstrap.js 복사본, app-ref"로 |

세 건 모두 Low다. G-1만 epic 2 Done when이 직접 걸려 있어 인셉션 전에 넣는 것이 싸다.

### 3.4 확정해 둘 애매함 1건

| # | 무엇 | 왜 애매한가 | 권고 |
|---|---|---|---|
| G-4 | D4의 "`page`는 유지"가 spine에서 **별도 컬럼이 아니라 `locator` 안의 필드**로 착지했다(AD-24, 338) | inputs A1은 "`document_chunks.page` 하나 **대신** 위치 JSON"이라 필드 해석이 맞고, memlog도 "page 유지"를 AD-24 개정에 적었다. 그러나 D4 문장만 보면 "locator 컬럼 추가 + 기존 `page` 컬럼 유지"로도 읽힌다 | 의도로 판정(필드). 0003 설계가 흔들리지 않게 epic 2 인셉션 입력에 한 줄: "`page`는 `locator` JSON의 필드다. 별도 컬럼은 두지 않는다(쪽 기준 조회가 필요해지면 생성 컬럼·인덱스로 더한다)" |

---

## 4. §4.1 에픽 문구의 전제 ↔ spine AD 뒷받침

| 에픽 문구 | 전제하는 것 | spine 뒷받침 | 판정 |
|---|---|---|---|
| **epic 2 DW 6** — 플러그인 hook 하나로 수집, 설치기 hook과 동시 생존 금지 | hook 출처가 하나 | AD-19 (285) | ✓ |
| epic 2 DW 6 — 동시 첫 시작에서 bootstrap은 한 번, 다른 쪽은 "설치 진행 중" | 설치 잠금과 exit 0 | AD-19 (286) | ✓ |
| epic 2 DW 6 — `/plugin update` 뒤 첫 세션에 `app-ref` 차이로 ff+build 한 번, 세션 시작은 막히지 않음 | 비동기 hook·검사만·앱은 캐시 밖 | AD-19 (283, 286), AD-6, NFR-3 | ✓ |
| epic 2 DW 6 — doctor가 플러그인 버전·앱 빌드 버전 일치를 보임 | doctor 항목 | AD-19 (289) | ✓ |
| epic 2 DW 6 — doctor가 spool 건수·마지막 hook 수신 시각 | — | AD-9 (173), AD-19 (289) | ✓ |
| **epic 2 DW 9** — `brain admin schema`가 모든 명령을 내고, 메타 누락은 테스트가 잡음 | 명령 메타 + 생성 + 테스트 | Conventions 명령 메타 (443), AD-5 (98, 108) | ✓ |
| epic 2 DW 9 — 비TTY `--yes` 없는 `messages redact`는 exit 3 + `error.retry` | 종료 코드 3과 retry | Conventions 종료 코드 (442), `--json` 응답 (441) | ✓ |
| epic 2 DW 9 — doctor의 `writable` 검사 불가는 `warn` | **`writable` 검사의 존재** + `warn` 등급 | 등급은 Conventions (445)·AD-19 (289). **검사 자체는 어느 AD에도 없다** | **부분** → §3.3 G-1 |
| **epic 2 DW 10** — 조각마다 `locator`(텍스트는 글자 범위, PDF는 쪽), 실패는 `failed_stage` | locator 종류별 필드 + failed_stage | AD-24 (338), Table Contract (404~405) | ✓ |
| epic 2 Description — 0003에 `redactions.pattern_version`, `files.redact` 자리 | 두 자리 | Table Contract `redactions` (397), AD-23 (330), AD-5 `files` 행 (106) | ✓ |
| epic 2 Description — SessionStart 동기 `context show` / 비동기 bootstrap / Stop·SessionEnd 수집 | 수명 주기 매핑 | AD-6 (117~136) | ✓ |
| epic 2 Description — `app-ref`가 앱 커밋을 고정, bootstrap.js 복사본은 테스트로 동기화 | — | AD-19 (288) | ✓ |
| epic 2 Description — node 탐색 폴백, 진입점 24.16 하한 | — | AD-19 (286~287) | ✓ |
| **epic 3 DW 8** — 스킬 코드블록의 명령·flag가 `admin schema`에 있고(parity), 전문과 요약이 같은 상수 | 원본 하나 + parity | AD-17 (264) | ✓ |
| **epic 4 DW 4** — 8,000자 초과는 낮은 순위부터 통째로, 1위 보존, `RESULT_TRUNCATED` + `meta.omitted.count` + `meta.next`; 검색 실패와 0건 구분 | 결과 계약 + meta | AD-15 (247~248), Conventions (441) | ✓ |
| **epic 5 Description** — `setup upgrade`가 플러그인 `app-ref` 갱신과 같은 함수 | — | AD-20 (298), AD-19 (283) | ✓ |
| epic 5 Description — manifest에 테이블별 sha256 / 내보내기는 임시 파일→rename | Conventions 내보내기 행 | 행(448)은 "스키마 버전, 테이블별 건수, 시각"까지다. sha256·rename은 없다 | ✓(에픽 고도) · 메모: §4.2가 이 행 수정을 요구하지 않았다. epic 5 인셉션에서 spine 행을 함께 늘릴지 정하면 된다 |
| **epic 7 Description** — 스키마 동등성 테스트, `-- Mirrors postgres NNNN` 헤더, 번호 중복 감지 | Conventions 마이그레이션 행 | 행(449)은 "SQL 파일, 순번 접두사, 앞으로만"까지다 | ✓(에픽 고도) · 같은 메모 |
| **epic 9 DW 1** — 데몬 끄고도 모든 명령·hook·launchd 동작, epic 2~5 테스트가 데몬 없이 통과 | — | AD-27 (368) 문장 그대로 | ✓ |
| **epic 9 DW 2** — 데몬 켜면 Stop hook 없이 transcript가 N초 안에 수집 | watcher + 지연 목표의 자리 | AD-27 (367), Deferred "watcher 지연 목표"(532) | ✓ |
| **epic 9 DW 3** — 빌드 갱신 시 데몬이 버전 불일치를 보고 스스로 재시작, 그 사이 hook은 프로세스 안 경로 | handshake + fallback + 재시작 주체 | AD-26 (358), AD-27 (366·368) | ✓ · 메모: spine은 "재시작 신호를 남기며"·"`setup upgrade`가 재시작"·KeepAlive까지만 적고 **"데몬이 스스로 종료해 KeepAlive가 되살린다"**는 쓰지 않았다. epic 9 인셉션에서 재시작 주체를 한 줄로 못 박을 것 |
| **epic 9 DW 4** — `mcp serve`가 읽기 verb 전부·`session` 있는 쓰기 verb를 내고 스키마는 `admin schema`와 같다 | 메타 단일 출처 | AD-28 (376~377), AD-5 (98) | ✓ |
| **epic 9 DW 5** — doctor가 데몬 생존·소켓·버전·heartbeat, 죽어 있으면 `warn` | — | AD-27 (369) | ✓ |
| epic 9 Description — 설치기 `--daemon`, `setup uninstall`(데몬 몫) | 설치·제거 경로 | AD-27(LaunchAgent·Label)·AD-20(uninstall) | ✓(에픽 고도) · 메모: `--daemon` 플래그와 데몬 LaunchAgent 제거는 AD에 이름이 없다. epic 9 인셉션 몫으로 충분하다 |
| epic 9 Boundaries — "AD-5·6·7·9·25·26·27·28", "Core는 서버·프로세스를 소유하지 않는다(FR-23)" | 참조 전부 실존 + Core 불변 | 전부 실존. AD-27 (366) "SDK만 부른다. Core는 그대로다(FR-23)" | ✓ |

---

## 5. inputs §1 스파인 11개 — 착지 매핑

| # | 패턴 | 착지한 AD/Conventions 문장 | 판정 |
|---|---|---|---|
| **A1** | 조각 원본 위치 | AD-24 (338) "조각마다 `locator`(JSON; 종류별 필드: pdf 쪽·영역 `page`·`bbox` / docx 블록 `block` / text 글자 범위 `start`·`end` / time 밀리초 `start_ms`·`end_ms` / sheet `sheet`·`row_start`·`row_end`)" + AD-15 결과 계약 (245) + Table Contract `document_chunks` (405) | 착지 (D4 단순화: `quote`·`source_hash` 없음 ✓) |
| **A6** | 패턴 목록 버전 기록 | Table Contract `redactions` (397) "수집·추출의 저장 전 마스킹(`pattern_version` 기록)" | 착지 · 메모: AD-11(194 "패턴 목록은 Core에 하나만 둔다")에는 버전 문장이 없다. 표 행만으로도 0003은 선다 |
| **A10** | 추출 시도와 단계 | AD-24 (338) "파일당 단조 증가하는 `attempt` … 실패하면 `failed_stage(read \| extract \| chunk \| index)` … 포인터 전환은 현재 세대보다 `attempt`가 큰 세대만" + Table Contract (404) | 착지 (D5 단순화: 단계 트리·`cancelled` 없음 ✓) |
| **C1** | 결과 문구 셋 구분 | AD-15 (248) "검색을 수행하지 못한 것(오류 `SEARCH_FAILED`…)과 0건(`ok`, `data: []`, `meta.hint`에 다음 행동)은 구분한다. 미설치·미초기화는 exit 2 코드(`CONFIG_MISSING`·`DB_UNAVAILABLE`)" + Conventions 오류 코드 (441) | 착지 (세 통 전부) |
| **C2** | 잘림 규칙 | AD-15 (247) "낮은 순위 행부터 통째로 빼되 1위는 남기고 … `meta.omitted{count, reason}`·`meta.next{ns, verb, args}` … 행 안을 자르는 것은 최후 수단" + Conventions `meta` (441) | 착지 |
| **E1** | `admin schema` + CommandSpec 메타 | Conventions 명령 메타 (443) + AD-5 Rule (98) + AD-5 표 `admin` 행 (108) + AD-28 (376, MCP 스키마도 같은 메타) | 착지 |
| **E3** | `admin exit-codes` | Conventions 종료 코드 (442) "`admin exit-codes`가 이 표를 `{code, meaning, agent_action}`로 낸다. hook 경로는 항상 0" + AD-5 표 (108) | 착지 |
| **E4** | 오류 엔벨로프 `exit_code`·`retryable`·기본 `hint` | Conventions CLI `--json` 응답 (441) "`error`는 `{ code, message, exit_code, retryable?, hint?, retry?… }`(`retryable`은 true/false/생략=모름)" | 착지 · 메모: "코드별 **기본** hint를 둔다"는 규칙 문장은 없다(필드와 문체만). 코드 고도로 충분 |
| **E5** | `retry_argv`와 hint 문체 | Conventions hint·retry 문체 (444) 전문 + AD-5 표면 중립 (97) "CLI가 `retry_argv`·종료 코드로" | 착지 |
| **E6** | 확인 필요 코드 분리 + 금지 행동 6개 | Conventions 종료 코드 (442) "3 확인 필요 … 에이전트 금지 행동: `--yes` 자동 부착, `retry`를 그대로 실행, 백오프 루프 재시도, 덜 파괴적 동사로 우회, 이전 승인 재사용, `--json`으로 게이트 우회" + AD-28 (378) | 착지 (D1 = 3) |
| **E7** | doctor `warn`·`skip{reason}`·`summary` | Conventions doctor 상태 (445) + AD-19 doctor (289) "`warn`은 exit 0" | 착지 · 메모: "선행 실패 시 `skip` + `reason: prereq failed: db`"의 **트리거**는 없다(등급과 reason 칸만). 코드 고도로 충분 |

**미착지: 없음.** 11개 전부 AD 또는 Conventions 문장에 착지했다. 괄호 메모 3건(A6의 AD-11 문장, E4의 코드별 기본 hint, E7의 선행 실패 트리거)은 모두 스토리·코드 고도이고 spine 고도의 빈 자리는 아니다.

### 5.1 보조 — inputs §2(조건부) 중 "데몬 결정 시" 2행

데몬 결정이 났으므로 inputs §7("데몬 결정이 나면 §2의 해당 행을 올린다")이 발동한다. 둘 다 epic 9 Description (5)가 흡수했다.

| 조건부 | spine 자리 | 메모 |
|---|---|---|
| NDJSON 스트리밍 | Deferred "소켓 프레이밍 … epic 9 인셉션"(532) + AD-26 (359) | 프레이밍 질문으로 포섭됨. 추가 작업 없음 |
| 세션 안 짧은 핸들(`L12`/`M34`/`D5`) | **없음** | §4.2가 요구하지 않았다. 다만 AD-8 (156) "프로세스 경계를 넘는 세션 토큰은 `harness:harness_session_id` 문자열뿐"과 Conventions ID 행(438)이 경계 식별자를 고정하고 있어, 핸들은 그 규약을 건드린다. epic 9 인셉션 **전** architecture 갱신에서 한 줄(핸들은 세션 범위 표시용이고 저장·멱등 키가 아니다)로 자리를 열어 둘 것 |

### 5.2 보조 — inputs §4(반면교사) 대조

| 반면교사 | spine이 반대로 가 있는가 | 근거 |
|---|---|---|
| "40자 이상 토큰" 가리기 | ✓ 그런 규칙이 없다 | AD-11 (194)은 "알려진 비밀 패턴"만 |
| PEM 헤더만 가림 | ✓ 패턴 내용은 Core 상수(스토리 고도) | AD-11 |
| 마이그레이션 실패 후 기동 계속·dirty 자동 복구 | ✓ 멈춘다 | AD-20 (297) `SCHEMA_MISMATCH`, Conventions 마이그레이션 (449) |
| 스크립트가 비밀값을 echo | △ "비밀값 제외"는 `retry.args`에만 있다(444) | 선택: 공개 저장소 위생 행(451)에 "설치기·스크립트·로그 출력에 비밀값을 넣지 않는다" 한 줄 |
| `request_id`를 멱등 키로 착각 | ✓ | AD-8 (155~157) |
| 쓰기 진입점 우회 | ✓ | AD-14 (227) "쓰기 API는 둘이다" |
| 문서와 코드가 어긋남 | △ 대조 테스트가 Conventions 테스트 행(450)에 없다 | E9는 스파인 11 밖이다. epic 2 인셉션 몫 |
| 언어별 하드코딩 | ✓ 접두어 방식 자체가 없다 | — |

---

## 6. "그대로"라고 한 AD — 편집 여부 확인

### 6.1 건드려지지 않은 것 (17개, diff hunk로 확인)

| AD | 제목 | 편집 |
|---|---|---|
| AD-1 | 패키지 경계 | 없음 |
| AD-3 | import 부작용 없음 | 없음 |
| AD-4 | connector 계약 | 없음 |
| AD-6 | 수명 주기 매핑 | 없음 |
| AD-7 | 동시성·drain | 없음 |
| AD-8 | ID와 멱등 키 | 없음 |
| AD-9 | spool | 없음 |
| AD-10 | 원본은 로컬 SQLite 하나 | 없음 |
| AD-11 | 원문 불변·가리기 | 없음 |
| AD-12 | 세션·꼬리표·정체성 | 없음 |
| AD-13 | 절대 시각 | 없음 |
| AD-14 | 로그 작성자·연결·규칙 상태 | 없음 |
| AD-16 | Markdown 미러 | 없음 |
| AD-18 | 설정과 키 | 없음 |
| AD-21 | `work_items` | 없음 |
| AD-22 | 복제 대상은 값을 만들지 않는다 | 없음 |
| AD-23 | 파일: 내용과 위치 | 없음 |

AD-5·15·17·19·24·25의 `Binds` 줄도 바뀌지 않았다(새 FR이 없으므로 맞다). frontmatter `binds`는 FR-1~28·NFR-1~9 그대로이고, 새 AD 셋은 기존 FR-23·24와 NFR-2·3·7에만 매였다 — 새 FR을 만들지 않았다는 §3("FR은 하나도 바뀌지 않는다")과 일치한다.

### 6.2 "그대로"로 적혔는데 편집된 것 1개 — change 문서 쪽 오기

| 구역 | 무슨 일인가 | 판정 |
|---|---|---|
| **AD-20** | change 문서 §2.2는 "그대로: AD-1, 3, 4, 6~14, 16, 18, **20**~23"으로 적었다. 그런데 §4.2의 AD-19(플러그인 hook)와 AD-27(데몬 재시작)이 `setup upgrade` 순서를 바꾸게 만든다. spine은 AD-20 (298)을 "코드 갱신 → 빌드 → 마이그레이션 → shim 재작성(플러그인 없는 Harness만 hook 재등록) → 데몬이 있으면 재시작(AD-27) → doctor"로 고쳤다 | **필요한 편집.** memlog에 `(decision) AD-20 보강`으로 기록돼 있다. 고칠 것은 spine이 아니라 change 문서 §2.2의 "20~23" → "21~23"이다(이 리뷰의 임무 문구는 이미 21~23으로 교정돼 있다) |
| Design Paradigm | §4.2에 열거되지 않았으나 "상주 프로세스는 없다" → "slice 1에 상주 프로세스는 없다 … 데몬(AD-27, epic 9)은 같은 빌드의 선택 런타임이고, 데몬이 없을 때의 동작이 기준이다"로 고쳤다. 층 표에 `plugin/` 행, 의존 그림에 `plugin → cli` 점선 추가 | **필요한 편집.** 고치지 않으면 paradigm 문장이 AD-25·27과 정면으로 모순된다. frontmatter `paradigm`·`scope`도 같은 이유로 바뀌었다 |

---

## 7. §4.2가 요구하지 않았는데 더해진 것 (전부 정합 — 다음 리뷰용 근거)

| 추가 | 어디 | 출처 |
|---|---|---|
| AD-5 Rule의 "모든 명령은 메타를 선언하고 … 그 메타 하나에서 생성한다(Conventions)" | 98 | Conventions 명령 메타 행의 교차 참조. E1 |
| AD-15의 `has_more`·`CONFIG_MISSING`·exit 2 | 247~248 | C10·C1, §4.1 epic 4 |
| AD-17의 "구성과 순서는 고정 머리말(오늘 날짜·시간대 포함) … 사용 안내 요약" | 266 | inputs B5(섹션 순서), §4.1 epic 3 |
| AD-19의 대화형 흐름 순서 보존 | 284 | OLD 문장. §4.2는 "다시 쓰기(요지)"였으므로 보존이 맞다 |
| AD-26의 "verb는 AD-5 표의 것만", 디렉터리 0700, 프레이밍 유보 | 357·359 | AD-5, Deferred 새 행 |
| AD-27의 Label 이름, drain 루프·watcher, "epic 2~5 테스트는 데몬 없이 통과" | 366~368 | epic 9 Description·DW 1·2, AD-25 |
| AD-28의 `.mcp.json` 선택 등록, `CONFIRMATION_REQUIRED`, 결과 엔벨로프 | 376·378 | epic 9 Description, Conventions 종료 코드 |
| Conventions 종료 코드의 `{code, meaning, agent_action}` | 442 | inputs E3 |
| Deferred 새 행(소켓 프레이밍·watcher 지연 목표·hook PATH 실측·`--ignore-scripts`) | 532 | change 문서 §3 "위험"과 §5 미결, memlog `(question)` |

---

## 8. 결론

- §4.2의 지시는 **빠짐 0, 누락성 변형 0**이다. 다르게 들어간 9건은 전부 상향 보정(7) 또는 같은 뜻의 표기(2)다. 성공 기준 (1) "spine에 AD-26~28이 있고 AD-19·25가 새 문장이다"는 충족했다.
- 손댈 것은 한 문장짜리 3건(§3.3 G-1·G-2·G-3)과 확정 메모 2건(§3.4 G-4, §5.1 짧은 핸들)이다. 그중 **G-1만 epic 2 Done when 9에 직접 걸려 있어** 인셉션 전에 넣는 것이 싸다.
- change 문서 §2.2의 "그대로: … 20~23"은 "21~23"으로 고쳐야 한다(§6.2). spine의 AD-20 편집은 옳다.
- 이 리뷰의 범위 밖(핸드오프 §5의 3~5단계): PRD §4.3, spec §4.4, initiative §4.5, tickets.toml과 에픽 파일 7개·epic 9 신설. 확인한 바로 `epic-daemon/`과 `tickets.toml`의 epic 9는 아직 없다 — 핸드오프 4단계가 남은 정상 상태다. §4.6(inputs §6의 한 줄)은 이미 들어가 있다(`inputs/weknora-patterns.md` §6-8).
- §4에서 확인한 것은 "에픽 문구가 spine 위에 설 수 있는가"뿐이다. 에픽 파일에 그 문구가 실제로 반영됐는지는 4단계 뒤 별도 대조 대상이다.
