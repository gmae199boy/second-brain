---
type: epic
title: "세션 수집과 비밀 가리기"
parent: personal-brain
covers: [CAP-1, CAP-2, CAP-10, CAP-11, CAP-14]
after: ["epic-foundation-and-install"]
assignee: ""
risk: high
---

# 세션 수집과 비밀 가리기

## Description

Claude Code transcript parser, `sessions.ensure`, 턴마다 증분 수집(세션 잠금), 프로젝트·워크트리 식별(git remote 정규화), Claude Code connector와 hook 등록(`setup connect`), drain(실패 재시도·transcript 폴더 스캔), spool(스키마 불일치 포함), `failures list`·`failures retry`, 비밀 가리기(저장은 원문, 나갈 때 가림 — 마스킹 B, 2026-10-18)와 저장본에서 지우는 `messages redact`를 만든다.

2026-10-14 변경으로 더한 것: SQLite `SessionStore`(ensure·ingest·readSession)와 계약 사례, 쓰기는 `withWrite`, 메시지에는 번호가 없고 대화 순서는 `occurred_at`(AD-8, 24, 2026-10-20), 시작 hook은 읽기 전용이고 세션 행은 첫 수집이 만듦(AD-6), 일감 대기열 `work_items`(미완료 `(kind, target_kind, target_id)` 하나, 짧은 쓰기 트랜잭션 청구, 종류별 청구 기간·지수 재시도 Core 상수, 10회 실패 시 `failures`, AD-21)와 모든 명령의 기회적 drain. 같은 변경으로 들어온 `FileStore`·첨부 원본 저장·문서 텍스트 추출·고아 블롭 정리·`files redact`(AD-23·24)는 2026-10-15 인셉션에서 epic-attachments로 옮겼다.

2026-10-15 변경(추가안 B, `../change-surface-plugin-daemon/`)으로 더한 것:
- **Claude Code 플러그인 뼈대** — hook의 출처는 플러그인 하나(AD-19). `plugin/`에 `.claude-plugin/plugin.json`(매니페스트는 여기만), `hooks/hooks.json`(SessionStart 비동기 bootstrap·drain, Stop·SessionEnd 수집. 명령은 전부 PATH에 기대지 않고 node를 찾는 sh 런처를 거쳐 `|| exit 0`으로 감싼다. SessionStart 동기 `context show` 줄은 epic-log-and-context가 `context show`와 함께 더한다), 의존성 없는 `bootstrap.js` 복사본(테스트로 원본과 동기화), `app-ref`(40자 sha 한 줄). `package.json`·lockfile 없음. 루트 `.claude-plugin/marketplace.json`이 `./plugin`을 가리킨다. 비동기 hook은 `<home>/installed.json`이 없거나 그 `commit`이 `app-ref`의 조상일 때(플러그인이 앞설 때)만 `bootstrap.js --yes --ref <sha> --plugin-root …`를 돌리고, 뒤처지면 아무것도 하지 않고 doctor `warn`(`PLUGIN_BEHIND`). bootstrap: 설치 잠금(`<home>/install.lock/` 디렉터리, pid·시작 시각, 30분 stale), 진입점에서 24.16 하한(회고 F7), ref로만 ff, `--frozen-lockfile --ignore-scripts`(2026-10-15 검증: 설치 스크립트를 가진 의존성이 없다), 완료 검증(`bin.js guide schema --json` exit 0) 뒤 `installed.json`(`{commit, schema_version, installed_at, node, plugin_root}`)을 마지막에 원자적으로 쓴다. 빌드는 `dist/build.json`에 빌드 신원 `{commit, schema_version}`을 박는다. stdout에는 완료·실패의 `systemMessage` 한 줄만(비동기 hook 출력은 다음 턴 모델로 간다). shim은 node 실제 바이너리(`realpath`)를 고정하고, 없으면 nvm → Homebrew → `/usr/local/bin` 순으로 찾아 재고정한다(volta 같은 버전 관리자 shim은 고정하지 않음). `setup connect claude-code`는 `installed.json.plugin_root`로 판정해 없으면 `PLUGIN_NOT_INSTALLED` 경고(`ok: true`)를 내고 설치기가 예전에 쓴 표식 hook을 지운다. 플러그인 `version`은 `app-ref`와 함께 올린다. 플러그인 설명에 첫 세션의 자동 clone·install·build를 명시한다. 첫 세션은 설치가 끝날 때까지 시작 맥락·라이브 수집이 없고, 끝나면 폴더 스캔이 줍는다.
- **CLI 규약 보강**(스토리 1·3으로 나눔, 2026-10-16 인셉션): `brain guide schema [ns verb]`·`guide exit-codes`·`guide show`(명령 메타 `used_for`·`required`·`examples`·`output`·`risk`·`hook`·`dryRun` 한 곳에서 생성, 누락은 테스트 실패), 엔벨로프 `error{code, message, exit_code, retryable?, hint?, retry{ns, verb, args}}`와 `meta{hint, count, has_more, omitted, next}`(코덱은 Core), 확인 게이트는 SDK `confirm: true`(CLI `--yes` → `confirm`), 종료 코드 3 `CONFIRMATION_REQUIRED`(CLI는 `retry_argv`를 덧붙임, hook 경로는 0), doctor `warn`·선행 실패 `skip`(`detail`)·`summary`, 경고·오류 코드 목록은 Core 상수, 빈 위치 인자·제어문자 거부, README 종료 코드 표와 코드의 양방향 대조 테스트.
- **마이그레이션 0004**(0003은 2.2의 `users`, 2026-10-16): `document_chunks.chunk_locator`(JSON, Core 정규형, `type ∈ {pdf, docx, text, time, sheet}`; `page`는 읽기 전용 사본), `redactions.pattern_version`과 `files.redact` 자리(deferred)와 `redactions` 변경 거부 trigger, `document_extractions.attempt`(Store가 `max+1` 배정, `(file_id, attempt)` UNIQUE, 파일당 진행 중 세대 하나)·`failed_stage`·`index_config_id`, `files.source_unreachable_at`, 서브에이전트 최종 보고를 표시하는 메시지 칸.
- 기존 스토리의 완료 조건으로: 비밀 패턴 목록(한국어판, PEM 블록 전체, 버전 있음)과 과잉 가림 회귀 테스트(git SHA·UUIDv7·sha256·이메일·사설 IP·경로), 셸 `NAME=value` 마스킹, 값은 구두점에서 멈춤, drain 순서는 실패가 적은 것부터(`attempts ASC, id ASC`), failures 오류 문자열의 UTF-8 경계 자르기(payload는 두지 않고 다시 하기는 대상을 다시 읽는다 — 2026-10-15 인셉션), 메시지 ID는 처음 만든 프로세스가 정한 UUIDv7(2026-10-15 인셉션), 기회적 drain의 예외(동기 hook·hook 경로·읽기 선확인, AD-7; 데몬 켜짐 예외는 epic-daemon). 원천: `inputs/weknora-patterns.md` §1.1, §1.5.

2026-10-15 인셉션에서 정한 것은 Notes의 Decision에 있다.
- 첨부와 추출은 epic-attachments로 나눴다.
- 꼬리표는 cwd가 있는 첫 메시지의 cwd로 정하는 프로젝트·워크트리뿐이다. 워크스페이스는 slice 1에서 쓰지 않는다.
- 서브에이전트는 최종 보고만 넣는다. → 2026-10-21에 바뀌었다: 서브에이전트 보고는 넣지 않는다(Notes).
- 폴더 스캔은 내역(`transcript_files`) 기반이다. 설치 직후 첫 스캔이 디스크에 남은 transcript를 가져온다.
- `failures.fingerprint`도 정했다.

실측 사실은 `epic-capture-research.md`에 있다.

## Outcome

Claude Code 세션이 손대지 않아도 원문 그대로 빠짐없이 쌓이고, Brain 밖으로 나가는 것에서는 비밀이 가려진다.

## Requirements

- E2-1 (CAP-10): CLI 규약 — 모든 명령의 메타 7칸과 그것에서 만드는 `guide schema`·`--help`, `guide exit-codes`, `guide show`(CLI 사용 규약 절), Core 엔벨로프 코덱과 경고·오류 코드 상수, SDK 확인 게이트와 종료 코드 3, doctor `warn`·`skip`·`summary`, 빈 위치 인자·제어문자 거부, README 종료 코드 표와 코드의 양방향 대조, 사람이 읽는 출력(오류 message·hint, `--help`, doctor 줄)의 한국어와 그 회귀 검사(2026-10-16). (spine AD-5, Conventions '출력 언어'; inputs §1.5 E1~E11)
- E2-2 (CAP-11): 설치기 — 흐름 결과와 실패 계약, 재실행 때 설정 보존(부분 읽기, 모르는 키), store 준비 뒤 config 쓰기, DB 확인 뒤 권한 변경, TTY 동의와 비대화형 동의 게이트, 설치기 질문·진행 줄의 한국어(2026-10-16). (AD-18·19, Conventions '출력 언어'; 회고 F1~F6·F10·F11)
- E2-3 (CAP-11): 플러그인 진입점 — `plugin/`(매니페스트, hooks, node를 찾는 런처, bootstrap 복사본, `app-ref`)과 marketplace, bootstrap(설치 잠금, Node 24.16 하한, ref로만 ff, `--frozen-lockfile --ignore-scripts`, 앞설 때만 갱신, 완료 검증, `installed.json`, 빌드 신원), shim의 node 고정과 폴백, `setup connect claude-code`의 확인·안내·옛 hook 제거, doctor의 플러그인·마지막 hook 항목. hook의 출처는 플러그인 하나. (AD-2·19·20; 회고 F7·F8·F9)
- E2-4 (CAP-1): Claude Code transcript parser와 hook 입출력 — 메인 대화의 본문(서브에이전트 보고는 넣지 않는다, 23, 2026-10-21; 19·22가 만든 보고 읽기는 23이 걷어 낸다. 도구 메모 호출 키는 23), 도구 메모 한 줄, 추적 정보, 커서와 증분 읽기, 앞부분이 바뀐 transcript의 다시 읽기와 `CURSOR_RESET`, `parser_version`, 끝이 아닌 깨진 줄 건너뛰기와 `TRANSCRIPT_LINES_SKIPPED`·시각 검증·이유별 버린 줄 수(23, 2026-10-20). (FR-1~3, AD-4·6)
- E2-5 (CAP-1): 수집 — `sessions.ingest`와 SQLite `SessionStore`, `users`('나' 한 행, `setup run`이 만듦, 2026-10-16), 세션 행은 수집만 만들고, 멱등 삽입, 같은 세션의 겹친 수집, `ingest_source`(live·import), 대화 순서 읽기는 `occurred_at`(메시지 번호 없음, 24, 2026-10-20). (FR-1·5·6, AD-7·8·12)
- E2-6 (CAP-1): 프로젝트·워크트리 정체성 — git remote 정규화(없으면 공통 디렉터리), cwd가 있는 첫 메시지의 cwd가 유일한 근거(handback 메시지는 cwd가 없다, 22, 2026-10-20), 꼬리표는 한 번 정해 불변, 워크트리 행, 대소문자를 구분하지 않는 호스트의 비교 키, git 조회가 잠깐 실패한 세션의 꼬리표 다시 채우기(20, 2026-10-19). 워크스페이스는 slice 1에서 쓰지 않는다. (FR-4, AD-12)
- E2-7 (CAP-1): 빠짐없이 — spool, `work_items` 대기열과 `queue drain`, 기회적 drain, 실패 기록 함수와 fingerprint, 내역(`transcript_files`) 기반 폴더 스캔(설치 직후 첫 스캔이 디스크에 남은 transcript를 모두 가져온다; 스캔이 처음 만든 세션은 `import`, hook이 만든 세션은 `live`), 세션 토큰만으로 하는 증분 수집(epic 3·4가 부름), `failures list`·`failures retry`, doctor의 미수집·실패·spool 항목. (FR-5·6, AD-6·7·9·21)
- E2-8 (CAP-2): 비밀 가리기 — 버전 있는 Core 패턴 목록과 출력 가리기 함수(저장은 원문, Core 출력 코덱이 가림, 출력 코덱 등록부와 계약 테스트), 저장본에서 지우는 `messages redact` 연쇄(`detected` 포함)와 확인 게이트. (FR-26, AD-11)
- E2-9 (CAP-14 스키마 자리, CAP-2, CAP-1): 마이그레이션 0004(0003은 2.2의 `users`) — `chunk_locator`, `redactions.pattern_version`·파일 가리기 자리·변경 거부 trigger, `document_extractions`의 `attempt`·`failed_stage`·`index_config_id`, `files.source_unreachable_at`, 서브에이전트 표시 칸, `messages.git_branch`, drain 청구 인덱스, `failures` 대상 키. 파일 쪽 동작은 epic-attachments. (AD-11·23·24, Table Contract)
- E2-10 (CAP-2, CAP-1, CAP-14 스키마 자리): 마이그레이션 0005 — `redactions.tool_note_id`, `document_extractions`의 `failed_stage` 강제 trigger, `projects.identity_key`, `failures`의 `first_occurred_at`·`occurrences`(2026-10-19), `tool_notes.call_id`(2026-10-20). 동작은 13·20·23과 epic-attachments. (AD-11·12·24, Table Contract)
- E2-11 (CAP-1, CAP-3·CAP-4 스키마 자리): 마이그레이션 0006 — `messages.seq` 삭제, `log_entries.anchor_seq`·`joined_upto_seq` 삭제, `chunks` 범위를 `from_at`·`to_at`으로(24, 2026-10-20). Postgres는 epic 7. (AD-8·14·15, Table Contract)

## Done when

1. 이 기계의 Claude Code 세션 수와 Brain 세션 수가 같다(SM-5). 설치 때 디스크에 남은 transcript도 들어간다.
2. 같은 transcript를 두 번 수집해도 모든 테이블의 건수가 같고, 같은 세션의 Stop hook이 겹쳐도 메시지가 겹치거나 빠지지 않는다.
3. 세션 도중 프로세스를 죽여도 마지막 턴까지 남고, DB에 쓸 수 없는 동안(잠금 시간 초과·스키마 불일치)의 수집이 spool에 남았다가 쓸 수 있게 되면 drain으로 채워진다. 시작 hook만 돈 세션은 세션 행을 만들지 않고 첫 수집이 만든다.
4. 알려진 비밀 패턴이 든 세션을 수집하면 저장 본문은 원문 그대로이고, Core 출력 코덱(엔벨로프·hook 출력)을 지난 결과 어디에도 그 값이 없다. `brain messages redact`로 가린 부분은 DB 어디에도 남지 않는다(2026-10-19).
5. 같은 레포의 두 워크트리 세션이 한 프로젝트(git remote 정체성)로 묶이고, 레포 밖에서 연 세션은 프로젝트 없이 수집된다. 대소문자만 다른 GitHub·Bitbucket remote의 세션이 한 프로젝트로 묶이고, git 조회가 잠깐 실패한 세션의 꼬리표는 뒤따르는 일감이 채운다(2026-10-19).
6. 플러그인을 켜고 세션을 열면 hook 하나로 수집되고, 설치기가 쓴 hook과 플러그인 hook이 동시에 살아 있지 않다. 세션 두 개가 동시에 첫 시작해도 bootstrap은 한 번만 돌고 다른 쪽은 아무것도 하지 않는다. `claude plugin update`로 `app-ref`가 앞서면 첫 세션에서 ff+build가 한 번 돌고 세션 시작은 막히지 않으며, 뒤처지면 아무것도 하지 않고 doctor가 `PLUGIN_BEHIND`를 보인다. doctor가 미수집 세션·실패 수집·spool 건수·마지막 hook 수신 시각·`installed.json`의 `commit`과 `app-ref`·빌드 신원의 관계를 보인다.
7. compact 뒤 다시 수집해도 기존 메시지의 본문과 건수가 그대로다. 겹친 drain 두 개가 같은 일감을 두 번 처리하지 않고, 다시 할 수 있는 오류로 10번 실패했거나 영구 오류로 한 번 실패한 일감은 `failures`에 남고 닫히며, 다시 하기는 새 일감이다(2026-10-16). 청구를 놓친 것은 시도 횟수를 올리지 않는다.
8. `brain guide schema`가 모든 명령을 내고, 명령 메타가 빠진 명령은 테스트가 잡는다. 비TTY에서 `--yes` 없이 `messages redact`를 부르면 exit 3과 `error.retry`(`confirm: true`)·`error.retry_argv`가 온다. doctor의 `writable` 검사 불가는 `warn`이다. 설치기 줄·doctor 줄·오류 message와 hint·`--help`가 한국어이고, 사람이 읽는 출력에 영어 문장을 새로 넣으면 출력 언어 검사가 잡는다(2026-10-16).

## Boundaries

AD-4·5·6·7·8·9·11·12·13·18·19·21, Table Contract(projects, worktrees, sessions, messages, tool_notes, redactions, failures, transcript_files, work_items)와 0003의 `users`(2.2)·0004의 스키마(2.6, 파일·추출 칸 포함, 그 동작은 epic-attachments)·0005(18)·0006(24), Conventions(엔벨로프·종료 코드·명령 메타·설치·런타임 기록). 출력 가리기 함수와 엔벨로프·hook 출력 코덱의 적용은 이 에픽(17)이 한다. 미러·내보내기·복제·임베딩 요청은 그것을 만드는 에픽이 같은 함수를 부르고 등록부에 넣는다. AD-11 중 가린 메시지의 조각·미러 재생성 일감은 epic-recall-and-mirror가, 내보내기는 epic-operations가 붙인다. 경고 코드 `SPOOLED`·`CURSOR_RESET`·`DB_UNAVAILABLE`·`PLUGIN_NOT_INSTALLED`·`PLUGIN_BEHIND`·`PLUGIN_DUPLICATE`·`UPDATE_AVAILABLE`·`TRANSCRIPT_LINES_SKIPPED`(23)와 오류 코드 `CONFIRMATION_REQUIRED`(정의와 `messages redact`의 게이트)를 맡는다. 첨부·`FileStore`·문서 추출·`files reindex`·`files redact`·`ATTACHMENT_NOT_REDACTED`는 epic-attachments. 워크스페이스(`workspaces`, `sessions assign-workspace`)는 slice 1에서 쓰지 않는다(칸은 예약). 플러그인의 `skills/`와 SessionStart 동기 `context show` hook 줄은 epic-log-and-context가 더한다. `SEARCH_FAILED`는 epic-recall-and-mirror, 데몬·MCP 코드는 epic-daemon. CAP-10·CAP-11은 플러그인 진입점·hook 출처·CLI 규약 보강 부분만 맡는다(설치 기본은 epic-foundation-and-install, 운영은 epic-operations, 데몬·MCP는 epic-daemon). 문서 검색은 epic-recall-and-mirror, Drive 저장소 구현은 epic-drive. 작업 로그는 만들지 않는다(epic-log-and-context). 미러와 세션 목록·읽기는 epic-recall-and-mirror.

## References

- parent — _bmad-output/personal-brain/initiative-personal-brain.md
- spec — _bmad-output/personal-brain/spec-brain-v1-slice-1/spec-brain-v1-slice-1.md, Capabilities CAP-1, CAP-2, CAP-10, CAP-11, CAP-14
- architecture — _bmad-output/personal-brain/architecture-brain-v1-slice-1/architecture-brain-v1-slice-1.md
- prd — _bmad-output/personal-brain/prd-brain-v1-slice-1/prd-brain-v1-slice-1.md
- inputs — _bmad-output/personal-brain/inputs/weknora-patterns.md, §1.1 (A1~A10), §1.5 (E1~E11)
- change — _bmad-output/personal-brain/change-surface-plugin-daemon/change-surface-plugin-daemon.md, §4.1, §6
- research — _bmad-output/personal-brain/epic-capture/epic-capture-research.md
- retrospective — _bmad-output/personal-brain/epic-foundation-and-install/epic-foundation-and-install-retrospective.md, Findings, Action items

## Notes

- Decision(2026-10-14): 원본 SQLite 전환과 추가안 A(첨부·추출)로 범위가 늘었다. 인셉션 때 다시 나눈다. 꼬리표 권위 출처와 `failures.fingerprint` 정의는 인셉션에서 정한다(spine Deferred).
- Decision(2026-10-15, 추가안 B): Claude Code 설치·hook 진입점은 플러그인이고 `setup connect claude-code`는 확인·안내로 바뀐다. 당분간 Claude Code만(Codex 제외). Node 24 이상 유지. 확인 필요 종료 코드 3. CLI 규약 보강은 이 에픽 앞쪽의 스토리 하나. 조각 위치는 `chunk_locator`만(`page`는 사본), 추출 시도는 `attempt`+`failed_stage`+포인터 가드로 단순화(사용자). 인셉션에서 검증할 것: hook 환경의 PATH 실측, `pnpm --ignore-scripts` 가능 여부, 비동기 hook 완료 알림(`systemMessage` vs `asyncRewake`).
- Carry(2026-10-15, epic 1 closure): 인셉션 때 넣을 것 — `packages/second_brain/test/import-side-effects.test.ts`가 `second_brain` import 시 SQLite DB 파일을 열지 않음도 단정하게(지금은 Postgres 연결 없음만 본다, Done when 5). 설치기 설정 보존 버그 2건(`deferred-work.md` story 13 항목). SQLite `SessionStore`(ensure·ingest·readSession) 계약 통과.
- Decision(2026-10-15, 인셉션): epic 2를 둘로 나눈다. 첨부 원본과 문서 추출(CAP-14, Done when 7·10)은 새 epic 10으로 옮기고, 순서는 epic 2 바로 뒤다. epic 10은 지금 envelope만 만들고, 인셉션은 차례가 올 때 한다(사용자).
- Decision(2026-10-15, 인셉션): `failures.fingerprint`는 Core 함수 하나가 (stage, 안정된 입력 식별자, 오류 분류 코드)로 만든다. 오류 문장·시각·경로·스택은 넣지 않고 `last_error`에 둔다. 같은 원인은 몇 번이 나도 한 행이고, 분류가 다르면 다른 행이다. 재시도 횟수는 `work_items`가 센다. 세션 없는 실패의 키 칸은 drain 스토리가 정한다(spine Deferred, 리뷰 H-8 해소)(사용자).
- Decision(2026-10-15, 인셉션): 서브에이전트(Task·Agent 도구)는 최종 보고(마지막 답) 하나만 그 세션의 메시지로 넣는다. 서브에이전트임을 표시하는 칸은 0003에 둔다(2026-10-16 재조정 뒤 0004, 2.6). 나머지 서브에이전트 대화는 넣지 않고, 서브에이전트를 부른 일은 도구 메모 한 줄로 남긴다. FR-1의 "도구 출력 제외"에 예외가 하나 생긴다. 최종 보고를 어디서 읽을지(메인 대화의 Agent 도구 결과인지, 서브에이전트 파일의 마지막 답인지)는 parser 스토리가 fixture로 정한다(사용자).
- Decision(2026-10-15, 인셉션): 폴더 스캔은 "설치 때 한 번 + 내역" 방식이다. 설치 직후 디스크에 남은 Claude Code transcript(기본 최대 30일)를 한 번 가져온다(`ingest_source=import`, 설치를 막지 않게 drain이 나눠서 처리). 그 뒤로는 내역(`transcript_files`: 파일별 크기·fingerprint·어디까지 읽었는지)과 비교해, 새로 생기거나 커진 파일만 읽어서 hook이 놓친 세션과 턴을 줍는다. SM-5는 이 기계의 Claude Code 세션 전부로 센다. spec Non-goals와 PRD §6.2의 "과거 세션 가져오기" 중 "설치 때 디스크에 남은 transcript"는 범위 안으로 들어오므로 두 문서의 문구를 고친다. 디스크에 없는 과거 세션과 다른 Harness의 세션은 그대로 범위 밖이다(사용자).
- Decision(2026-10-15, 인셉션): 꼬리표는 프로젝트와 워크트리만 둔다. 근거는 그 세션 첫 메시지의 transcript cwd 하나뿐이다. 세션 행은 수집(`sessions.ingest`)할 때만 만들고, 그때 꼬리표를 한 번 정한 뒤 바꾸지 않는다. transcript를 찾지 못한 쓰기는 세션 행을 만들지 않고 spool로 간다. LLM은 세션 꼬리표를 정하지 않는다(spine Deferred, 리뷰 H-2 해소). 워크스페이스는 slice 1에서 쓰지 않으므로 `sessions assign-workspace`를 만들지 않는다. 스키마에 있는 칸(`workspaces`, `sessions.workspace_id`, `projects.workspace_id`)은 비운 채 예약으로 남긴다. 회사/개인 경계는 내보내기·지우기·팀 공유를 경계 단위로 하게 될 때 함께 정한다. 이에 따라 Done when 5의 워크스페이스 절을 고치고, PRD FR-4·FR-24, spec CAP-1, spine AD-5·AD-15·Table Contract의 문구도 고친다(사용자).
- Decision(2026-10-16, 인셉션): 인셉션에서 검증하기로 한 세 가지의 결과다. 근거는 `epic-capture-research.md`에 있다.
  - hook 환경의 PATH는 Claude Code를 띄운 방식에 따라 다르다. 그래서 실측 대신 설계로 푼다. 플러그인 hook은 PATH에 기대지 않는 sh 런처가 node를 찾는다(shim과 같은 순서).
  - 설치는 `pnpm install --frozen-lockfile --ignore-scripts`로 한다. 설치 스크립트를 가진 의존성이 없다.
  - 완료 알림은 `async` hook의 `systemMessage` 한 줄로 한다. `asyncRewake`는 timeout을 강제하므로 쓰지 않는다.
  - (사용자가 "계속해"로 권고를 받아들임)
- Decision(2026-10-16, 인셉션): 스토리 순서와 각 자리의 이유.
  - 여는 스토리는 1(엔벨로프·종료 코드·확인 게이트)이다. CLI 규약 보강은 1과 3(명령 메타·admin 명령)으로 나눈다. 추가안 B의 "스토리 하나"를 바꾸는 결정이다. 두 검증이 모두 한 세션에 끝내기에는 큰 크기로 봤다.
  - tracer는 2다. Stop hook → parser → Core → SQLite `SessionStore` → `sessions ingest`를 개발용 Stop hook과 임시 home으로 잇는다. 플러그인 hook을 쓰지 않는 것은 실제 플러그인 설치에 수집 hook이 먼저 실리지 않게 하려는 것이다.
  - 가장 불확실한 것은 플러그인 설치 경로(5)다. 선행인 3·4 바로 뒤에 둔다. 회고 Action 5에 따라 흐름 결과와 실패 계약(4)을 먼저 만든다.
  - 실제 수집은 14에서 켠다. 정체성(8), 마스킹(9), 수집 일감(12), `messages redact`(13)가 모두 끝난 뒤다. 메시지와 꼬리표는 저장한 뒤 바뀌지 않기 때문이다.
  - 여러 스토리가 같은 핫스팟을 고친다. 디스패처, doctor 등록부, sqlite store, 수집 경로, 설치 흐름 테스트다. 그래서 선행 관계는 1~15 한 줄이다.
  - 8←7과 10←9는 수집 경로가 겹쳐서, 6←4·5는 설치 흐름 테스트에 박힌 스키마 버전 때문에, 13←12는 명령 등록부와 sqlite store가 겹쳐서 둔 충돌 회피 선행이다.
  - (사용자가 "계속해"로 권고를 받아들임)
- Decision(2026-10-16, 인셉션): 닫는 e2e 스위트는 두지 않는다. sweep(15)의 verify가 Done when을 다시 돈다.
  - `failures`에는 payload를 두지 않는다. 다시 하기는 대상(transcript·파일)을 다시 읽는다. 추가안 B 완료 조건의 "payload 보존"을 바꾸는 결정이다.
  - 세션이 없는 실패의 키 칸은 11이 정한다.
  - (사용자가 "계속해"로 권고를 받아들임)
- Decision(2026-10-16, 인셉션): 그 밖에 받아들인 권고.
  - SessionStart 동기 `context show` hook 줄과 `plugin/skills/`는 epic-log-and-context가 더한다.
  - 0003(2026-10-16 재조정 뒤 0004, 2.6)에 `redactions` 변경 거부 trigger와 `document_extractions.index_config_id`를 넣는다. `index_config_id`는 epic 4에서 앞당긴 것이다.
  - 회고 F9: shim은 `SECOND_BRAIN_HOME`을 따른다. shim에 박힌 home과 실제 home이 다르면 doctor `warn`을 낸다.
  - 회고 F10: `[files] path`는 묻지 않고 README를 맞춘다.
  - 회고 F11: TTY에서 동의를 받는 단계를 더한다. AD-19는 그대로다.
  - 스캔이 처음 만든 세션은 `import`, hook이 만든 세션은 `live`다.
  - seq는 Store가 배정하므로 같은 seq·다른 harness id는 생기지 않는다(inputs A7).
  - 세션 토큰 수집은 12가 만들고 epic 3·4가 부른다. 아직 수집되지 않은 세션의 `log append`는 먼저 그 세션을 수집한다. transcript를 찾지 못하면 spool로 간다.
  - 마지막 hook 수신 시각은 `<home>/run/` 아래 Harness별 파일의 mtime이다.
  - parser fixture는 실제 transcript 구조에 중립 내용을 넣어 커밋한다.
  - `messages redact`(13)는 실제 수집(14) 앞에 둔다.
  - (사용자가 "계속해"로 권고를 받아들임)
- 검증(2026-10-15~16):
  - 14개 초안은 Set·Ticket·Dependencies 검증과 Tree·Dependencies 검증을 서브에이전트로 돌렸고, 결과를 반영했다.
  - 15개로 바꾼 뒤의 재검증은 서브에이전트가 사용량 한도로 멈추고 사용자가 중단해서, 직접 했다. 선행 관계가 1~15 한 줄이라 겹치는 쌍이 없다. E2-1~9와 Done when 1~8은 모두 특정 스토리에 걸려 있다. 4→5 넘겨받기는 양쪽에 적었다.
  - 가장 큰 스토리는 5와 12다. 빌드 플랜에서 한 세션에 넘치면 나눈다. 17도 크다(2026-10-19). 넘치면 패턴 버전 2를 뒤 조각으로 나눈다.
- Decision(2026-10-16, `../change-users-and-review-gaps/`): 재조정. 이유는 story 2.2 계획 중의 `users` 테이블 결정(D0)과 외부 리뷰 대조(`../inputs/external-review-2026-10-16.md`)다.
  - 2.2가 마이그레이션 0003(`users`, `sessions.user_id` FK)을 가져가므로 2.6은 0004·버전 4가 된다. 2.6은 `messages.git_branch`(D1)와 drain 청구 인덱스(S8)도 더한다.
  - 보강: 2.5(node를 못 찾을 때 `systemMessage`, 잠금 stale 판정), 2.7(메시지마다 브랜치, 서브에이전트 파일과 스캔 범위), 2.10(`.claiming` 회수), 2.11(10번 실패한 행 닫기), 2.12(스캔 범위, spool 레코드 10번 실패 보존).
  - change 문서 §4.1과 다르게 둔 곳: spool 레코드의 10번 실패 규칙은 2.10이 아니라 2.12에(실패 기록 함수는 11, 재주입은 12), 청구 인덱스는 2.11이 아니라 2.6의 0004에(스키마 변경은 마이그레이션 스토리 몫) 두었다. 2.6의 `after`에 2를 더했다(0003 뒤에 0004).
  - (사용자가 change 승인으로 받아들임)
- Note(2026-10-16): 2.11이 세션 없는 실패의 키를 nullable로 고르면 `failures`를 다시 재생성해야 한다(0004가 2.11보다 앞선다). 고정 키(예: `harness`=대상 종류, `harness_session_id`=대상 id)는 스키마 변경이 없다.
- Decision(2026-10-16, 사용자): 재시도는 오류 분류로 다르게 한다. 큐는 `work_items` 하나다. DB에 쓸 수 없음은 실패가 아니고 spool로 가며, 영구 오류는 첫 실패에서 기록하고 닫는다. 외부 일시 오류는 `Retry-After` 또는 긴 간격을 따르고, 모르는 오류만 기본 간격으로 10번 한다(spine AD-21, 2.11, Done when 7).
- Decision(2026-10-16, 사용자): 이름공간은 명령이 다루는 대상이다. `admin`을 없애고 `queue drain`, `doctor run`, `backup export·import`, `index rebuild`, `mirror rebuild`, `guide show·schema·exit-codes`로 나눈다. 실패는 `failures list`·`failures retry`로 묶는다(`sessions failures`·`sessions retry` 대신). 이미 있는 `admin doctor`는 2.3이 옮긴다(spine AD-5).
- Decision(2026-10-16, 사용자): `failures` 키는 `work_items`와 같은 대상 키 `(target_kind, target_id, stage, fingerprint)`다. 2.6의 0004가 재생성한다(행 없음). 세션 수집 실패는 `session`/세션 토큰이라 세션 행이 없어도 기록된다. 위의 Note(nullable·고정 키)와 "세션이 없는 실패의 키 칸은 11이 정한다"는 이것으로 닫는다.
- Decision(2026-10-16, 사용자): 자동 업데이트는 설정 `[update] auto`(기본 true)다. 켜져 있으면 플러그인 `app-ref`가 앞설 때 bootstrap(데몬이 있으면 데몬)이 갱신하고, 꺼져 있으면 doctor `UPDATE_AVAILABLE`과 CLI 직접 갱신이다(2.5, spine AD-18·19·27).
- Decision(2026-10-16, 사용자): 사람이 읽는 출력은 한국어로 쓴다(설치기 질문·진행 줄, doctor 줄, 텍스트 모드 오류 줄과 hint, `--help`, 개발용 스크립트 안내, README). 에이전트만 읽는 것은 한국어가 아니어도 되고, 코드·JSON 키·점검 id·명령과 옵션 이름·설정 키는 영어다. 기존 영어 문구는 16이 2.2 바로 뒤에서 바꾸고, 이후 스토리가 새로 쓰는 문구도 이 규칙을 따른다(spine Conventions '출력 언어'). 16은 3과 같은 파일(코드 표 hint, `--help`, README, doctor 등록부)을 고치므로 3이 16 뒤에 오고, 선행 관계는 1·2·16·3~15 한 줄이 된다.
- Decision(2026-10-18, 사용자 — 2026-10-16 Assumption을 대체): 비동기 hook의 `systemMessage`는 다음 턴에 모델만 받고 사용자 화면에는 보이지 않는다(2.5 사람 확인 4, 실측). 그래서 세 경우(설치 완료, 설치 실패, node 못 찾음)는 그대로 두되 "이것을 사용자에게 한 줄로 전해 주세요"처럼 모델이 전하도록 쓴 한국어 문장으로 바꾼다. 사람용 결과는 doctor로 옮긴다: bootstrap이 `<home>/run/plugin.json`에 마지막 결과(시각, `installed` 또는 실패 단계, 로그 위치)를 남기고 doctor `plugin` 점검이 보인다(실패면 `warn`). node 못 찾음은 bootstrap이 돌지 않으므로 기록 없이 hook 줄만 남는다(2.5·2.14).
- Decision(2026-10-16, 사용자): 16은 출력 언어 회귀 검사를 남기고, E2-1·E2-2 본문과 Done when 8에 출력 언어를 넣는다. 그래서 3~14가 새로 쓰는 영어 문구도 sweep(15)의 Done when 재실행에서 잡힌다.
- Decision(2026-10-19, `../change-masking-b-and-review-fixes/`): 마스킹 B. 비밀은 저장할 때가 아니라 Core 출력 코덱에서 가린다. 9의 수집 경로 가리기는 17이 빼고, 미룬 패턴 문제 셋도 17이 고친다(패턴 버전 2). 결정 검토 수정으로 19(parser peer handback), 18(0005), 20(비교 키·꼬리표 다시 채우기)을 더했다. 13은 저장본 가리기로 남고 `detected`와 도구 메모 기록을 갖는다. 순서는 10→11→12→19→17→18→20→13→14→15다. 13·14의 `unknown`은 이 승인으로 닫았다(사용자 change 승인으로 받아들임).
- Decision(2026-10-19, 순서의 이유, change-masking-b-and-review-fixes D11):
  - 10~12는 마스킹 B와 무관해 먼저 간다.
  - 19는 parser만 고치므로 독립적이고, 2.7 follow-up 리뷰를 일찍 닫는다.
  - 17이 출력 코덱 규칙을 세운 뒤 18이 0005 스키마를 놓는다.
  - 20은 11의 실패 기록 함수, 12의 세션 토큰 수집, 18의 `identity_key`가 필요하다.
  - 13은 17(저장본 가리기와 출력 가리기의 경계)과 18(`tool_note_id`) 뒤다. 20 뒤에 둔 것은 핫스팟 때문에 한 줄을 지키려는 것이다.
  - 14는 13·19·20이 끝난 뒤 실제 수집을 켠다. 저장한 메시지와 꼬리표는 바뀌지 않기 때문이다.
  - (검증 서브에이전트 권고, 사용자 change 승인으로 받아들임)
- Decision(2026-10-19, 사용자, change-masking-b-and-review-fixes 검증 뒤): (1) 대소문자만 다른 이름은 같은 프로젝트다. 0005 전에 이미 갈라진 프로젝트가 있으면 setup이 이미 있다고 보이고, 합칠지 묻고(확인 게이트), 동의하면 먼저 만든 프로젝트로 합친다. 거절하면 DB를 바꾸지 않는다(18). (2) 셸 `NAME=value` 규칙은 도구 메모를 돌려주는 읽기 결과가 그 칸에만 먼저 걸고, 코덱은 모든 문자열에 본문 규칙을 건다(17).
- Decision(2026-10-19, 사용자, 2.11 확인): 같은 실패 원인(일감 종류·대상·오류 코드)은 한 행으로 둔다. 다시 나면 그 행을 다시 열고 `occurred_at`(마지막으로 난 때)·`message`를 방금 것으로 바꾼다(11). 처음 난 때 `first_occurred_at`과 횟수 `occurrences`는 18의 0005가 칸으로 더하고 실패 기록 함수가 채운다. 다른 안이었던 "칸 없이 최신으로만"과 "실패한 일감마다 한 행"은 고르지 않았다. 11의 나머지 결정(청구 때 시도 횟수, 기회적 drain 유지, handler 없는 종류는 그대로 둠, 오류 문장은 저장 전에 가림)은 그대로 받아들였다.
- Decision(2026-10-20, 사용자, 2.7 follow-up 리뷰): deferred-work의 "2.7 follow-up 리뷰"를 돌렸다(`story-transcript-parser-follow-up-review.md`, 지적 21건). 고칠 것은 기존 티켓이 맡지 않으므로 새 스토리 셋과 기존 스토리 보강으로 나눈다(검증 서브에이전트 권고, 사용자가 "권장으로 진행"으로 받아들임).
  - 18(0005)은 도구 메모를 호출 자체로 알아보는 `tool_notes.call_id` 칸을 더한다.
  - 21(수집 경로 보강)은 커서 경고, 대화 순서 읽기, `start_source`, 큰 transcript를 맡는다.
  - 22(보고 판정·출처)는 안내 문장·handback 출처·user 줄 허용 목록을 맡고, deferred-work의 옛 handback 본문 항목을 합친다. parser 버전은 올리지 않는다.
  - 23(parser v4)은 도구 메모 호출 키·줄 읽기·버린 줄 집계를 맡고, parser 버전을 한 번 올린다.
  - 잘린 도구 메모 대상 끝의 비밀 조각은 17의 출력 가리기가 맡는다.
  - 순서는 17→18→21→22→23→20→13→14→15다. 21이 parser 버전 업보다 먼저다. 저장 쪽을 고치기 전에 버전을 올리면 그 버전 업이 메모 중복과 순서 어긋남을 만든다. 20은 22가 바꾼 꼬리표 근거를 쓰므로 그 뒤다.
- Decision(2026-10-20, 사용자): 버전 업으로 대화 중간에 더해진 메시지의 `seq`는 지금처럼 맨 뒤에 붙는다. 메시지를 대화 순서로 돌려주는 읽기가 `occurred_at` 순서로, 같으면 `seq` 순서로 정렬한다. 칸은 더하지 않는다(21). 다른 안이었던 "앞뒤 사이 값 칸"과 "그대로 둠"은 고르지 않았다.
- Decision(2026-10-20, 사용자): `start_source`는 이 세션이 처음 어떻게 시작했나다. 이미 값이 있으면 바꾸지 않는다(21). 실측으로 211개 중 37개 세션이 값이 둘 이상이고, 34개가 startup 뒤 resume이다.
- Decision(2026-10-20, 사용자): handback 메시지는 cwd·branch가 없으므로, 세션 꼬리표의 근거는 cwd가 있는 첫 메시지의 cwd다. 8의 규칙을 22가 바꾸고, 20의 다시 채우기도 같은 근거를 쓴다.
- Decision(2026-10-20, 사용자, `../change-drop-message-seq/`): 메시지 번호 `seq`를 지운다. 대화 순서는 `occurred_at` 하나이고 같은 시각의 순서는 정하지 않는다. 대신할 칸·키는 만들지 않는다. 같은 날의 '읽기는 `occurred_at`, 같으면 `seq`' 결정을 대체한다. 근거: parser가 남기는 메시지 6,818쌍에서 시각 역전 0, 같은 밀리초 0(연구 문서의 524개 중 521개는 버리는 줄까지 센 수). 24가 0006과 Store를 맡고 21 앞에 선다. 21은 #10(읽기 정렬)을 24에 넘긴다.
- Decision(2026-10-20, 사용자, change-drop-message-seq 검증 뒤): 첫 메시지 앞의 도구 호출(2.7 follow-up 리뷰 #8)은 23이 바로 다음 메시지에 붙인다. `tool_notes.harness_message_id`를 비울 수 있게 하는 0006 변경(`tool_notes` 재생성, FTS 위험)은 고르지 않았다.
- 검증(2026-10-20, change-drop-message-seq): 24 추가·21 축소·15 선행의 재조정을 Ticket·Set·Dependencies 검증 서브에이전트로 돌렸다. 기계적 수정 4건(15 `covers`에 E2-11, 21·24의 #10 참조, epic 3 `needs` 문구)과 제안 5건(24가 가짜 store·계약 사례를 맡음, 빈 `chunks`·`log_entries`, 13의 시각 범위 조건, 이 기록, 21의 이전 plan 참조)을 반영했다. 요구 E2-1~11과 Done when 1~8은 모두 특정 스토리에 걸려 있고, 선행 관계는 한 줄이다.
- Decision(2026-10-21, 사용자, 22 결과 검토 뒤): 서브에이전트 보고는 저장하지 않는다. 2026-10-15의 "서브에이전트는 최종 보고만 넣는다"를 대체한다. 이유: 메인 에이전트가 보고의 결론을 사용자에게 다시 말하고 그 답은 저장되므로 결론은 남는다. 보고는 길고(동기 보고 중앙값 약 6,300자) 글 양이 대화와 맞먹어 검색을 차지하며, 에이전트가 쓴 글이라 "내 뇌"에 맞지 않는다. 동기 handback 보고가 `toolUseResult.handbackReport.text`에만 있는 구멍(실측 105건)과 "has not reported yet" 안내 문장 판정 문제도 함께 없어진다. 요약해서 저장하는 안은 LLM이 만든 글을 원문처럼 영구 저장하게 되어(AD-11) 고르지 않았다. 23이 parser 버전 4에서 보고 읽기(동기 결과·task-notification·peer handback)를 걷어 내고, 그 줄들은 허용 목록(22)대로 메시지가 아니다. 서브에이전트를 부른 일은 도구 메모 한 줄로 남는다. `messages.is_subagent_report` 칸은 스키마에 남고 늘 0이다(마이그레이션 없음). 실제 수집은 14부터라 저장된 보고는 없다.
- Decision(2026-10-21, 사용자): orca가 터미널에 친 고정 머리말 줄(`You are working inside Orca`, `Please carry out this task from my Orca coordinator`, `You have <숫자> orchestration message`)은 23이 메시지에서 뺀다. transcript가 그 줄을 출처 `human`으로 적어 hook이든 parser든 구분할 정보가 없으므로 고정 문구로 거른다(실측 31줄). orca 워커 세션의 나머지 코디네이터 지시를 세션 단위로 표시하는 안은 deferred-work의 후보로 남긴다.
