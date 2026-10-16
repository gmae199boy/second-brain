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

Claude Code transcript parser, `sessions.ensure`, 턴마다 증분 수집(세션 잠금), 프로젝트·워크트리 식별(git remote 정규화), Claude Code connector와 hook 등록(`setup connect`), drain(실패 재시도·transcript 폴더 스캔), spool(스키마 불일치 포함), `sessions failures`·`sessions retry`, 저장 전 비밀 마스킹과 `messages redact`를 만든다.

2026-10-14 변경으로 더한 것: SQLite `SessionStore`(ensure·ingest·readSession)와 계약 사례, 쓰기는 `withWrite`, `seq`는 원본 Store가 배정(AD-4·8), 시작 hook은 읽기 전용이고 세션 행은 첫 수집이 만듦(AD-6), 일감 대기열 `work_items`(미완료 `(kind, target_kind, target_id)` 하나, 짧은 쓰기 트랜잭션 청구, 종류별 청구 기간·지수 재시도 Core 상수, 10회 실패 시 `failures`, AD-21)와 모든 명령의 기회적 drain. 같은 변경으로 들어온 `FileStore`·첨부 원본 저장·문서 텍스트 추출·고아 블롭 정리·`files redact`(AD-23·24)는 2026-10-15 인셉션에서 epic-attachments로 옮겼다.

2026-10-15 변경(추가안 B, `../change-surface-plugin-daemon/`)으로 더한 것:
- **Claude Code 플러그인 뼈대** — hook의 출처는 플러그인 하나(AD-19). `plugin/`에 `.claude-plugin/plugin.json`(매니페스트는 여기만), `hooks/hooks.json`(SessionStart 비동기 bootstrap·drain, Stop·SessionEnd 수집. 명령은 전부 PATH에 기대지 않고 node를 찾는 sh 런처를 거쳐 `|| exit 0`으로 감싼다. SessionStart 동기 `context show` 줄은 epic-log-and-context가 `context show`와 함께 더한다), 의존성 없는 `bootstrap.js` 복사본(테스트로 원본과 동기화), `app-ref`(40자 sha 한 줄). `package.json`·lockfile 없음. 루트 `.claude-plugin/marketplace.json`이 `./plugin`을 가리킨다. 비동기 hook은 `<home>/installed.json`이 없거나 그 `commit`이 `app-ref`의 조상일 때(플러그인이 앞설 때)만 `bootstrap.js --yes --ref <sha> --plugin-root …`를 돌리고, 뒤처지면 아무것도 하지 않고 doctor `warn`(`PLUGIN_BEHIND`). bootstrap: 설치 잠금(`<home>/install.lock/` 디렉터리, pid·시작 시각, 30분 stale), 진입점에서 24.16 하한(회고 F7), ref로만 ff, `--frozen-lockfile --ignore-scripts`(2026-10-15 검증: 설치 스크립트를 가진 의존성이 없다), 완료 검증(`bin.js admin schema --json` exit 0) 뒤 `installed.json`(`{commit, schema_version, installed_at, node, plugin_root}`)을 마지막에 원자적으로 쓴다. 빌드는 `dist/build.json`에 빌드 신원 `{commit, schema_version}`을 박는다. stdout에는 완료·실패의 `systemMessage` 한 줄만(비동기 hook 출력은 다음 턴 모델로 간다). shim은 node 실제 바이너리(`realpath`)를 고정하고, 없으면 nvm → Homebrew → `/usr/local/bin` 순으로 찾아 재고정한다(volta 같은 버전 관리자 shim은 고정하지 않음). `setup connect claude-code`는 `installed.json.plugin_root`로 판정해 없으면 `PLUGIN_NOT_INSTALLED` 경고(`ok: true`)를 내고 설치기가 예전에 쓴 표식 hook을 지운다. 플러그인 `version`은 `app-ref`와 함께 올린다. 플러그인 설명에 첫 세션의 자동 clone·install·build를 명시한다. 첫 세션은 설치가 끝날 때까지 시작 맥락·라이브 수집이 없고, 끝나면 폴더 스캔이 줍는다.
- **CLI 규약 보강**(스토리 하나, 앞쪽): `brain admin schema [ns verb]`·`admin exit-codes`·`admin guide`(명령 메타 `used_for`·`required`·`examples`·`output`·`risk`·`hook`·`dryRun` 한 곳에서 생성, 누락은 테스트 실패), 엔벨로프 `error{code, message, exit_code, retryable?, hint?, retry{ns, verb, args}}`와 `meta{hint, count, has_more, omitted, next}`(코덱은 Core), 확인 게이트는 SDK `confirm: true`(CLI `--yes` → `confirm`), 종료 코드 3 `CONFIRMATION_REQUIRED`(CLI는 `retry_argv`를 덧붙임, hook 경로는 0), doctor `warn`·선행 실패 `skip`(`detail`)·`summary`, 경고·오류 코드 목록은 Core 상수, 빈 위치 인자·제어문자 거부, README 종료 코드 표와 코드의 양방향 대조 테스트.
- **마이그레이션 0003**: `document_chunks.chunk_locator`(JSON, Core 정규형, `type ∈ {pdf, docx, text, time, sheet}`; `page`는 읽기 전용 사본), `redactions.pattern_version`과 `files.redact` 자리(deferred)와 `redactions` 변경 거부 trigger, `document_extractions.attempt`(Store가 `max+1` 배정, `(file_id, attempt)` UNIQUE, 파일당 진행 중 세대 하나)·`failed_stage`·`index_config_id`, `files.source_unreachable_at`, 서브에이전트 최종 보고를 표시하는 메시지 칸.
- 기존 스토리의 완료 조건으로: 비밀 패턴 목록(한국어판, PEM 블록 전체, 버전 있음)과 과잉 가림 회귀 테스트(git SHA·UUIDv7·sha256·이메일·사설 IP·경로), 셸 `NAME=value` 마스킹, 값은 구두점에서 멈춤, drain 순서는 실패가 적은 것부터(`attempts ASC, id ASC`), failures 오류 문자열의 UTF-8 경계 자르기(payload는 두지 않고 다시 하기는 대상을 다시 읽는다 — 2026-10-15 인셉션), 메시지 ID는 처음 만든 프로세스가 정한 UUIDv7(같은 seq·다른 harness id는 seq를 Store가 배정하므로 생기지 않는다 — 2026-10-15 인셉션), 기회적 drain의 예외(동기 hook·hook 경로·읽기 선확인, AD-7; 데몬 켜짐 예외는 epic-daemon). 원천: `inputs/weknora-patterns.md` §1.1, §1.5.

2026-10-15 인셉션에서 정한 것은 Notes의 Decision에 있다.
- 첨부와 추출은 epic-attachments로 나눴다.
- 꼬리표는 첫 메시지의 cwd로 정하는 프로젝트·워크트리뿐이다. 워크스페이스는 slice 1에서 쓰지 않는다.
- 서브에이전트는 최종 보고만 넣는다.
- 폴더 스캔은 내역(`transcript_files`) 기반이다. 설치 직후 첫 스캔이 디스크에 남은 transcript를 가져온다.
- `failures.fingerprint`도 정했다.

실측 사실은 `epic-capture-research.md`에 있다.

## Outcome

Claude Code 세션이 손대지 않아도 비밀이 가려진 채 빠짐없이 쌓인다.

## Requirements

- E2-1 (CAP-10): CLI 규약 — 모든 명령의 메타 7칸과 그것에서 만드는 `admin schema`·`--help`, `admin exit-codes`, `admin guide`(CLI 사용 규약 절), Core 엔벨로프 코덱과 경고·오류 코드 상수, SDK 확인 게이트와 종료 코드 3, doctor `warn`·`skip`·`summary`, 빈 위치 인자·제어문자 거부, README 종료 코드 표와 코드의 양방향 대조. (spine AD-5, Conventions; inputs §1.5 E1~E11)
- E2-2 (CAP-11): 설치기 — 흐름 결과와 실패 계약, 재실행 때 설정 보존(부분 읽기, 모르는 키), store 준비 뒤 config 쓰기, DB 확인 뒤 권한 변경, TTY 동의와 비대화형 동의 게이트. (AD-18·19; 회고 F1~F6·F10·F11)
- E2-3 (CAP-11): 플러그인 진입점 — `plugin/`(매니페스트, hooks, node를 찾는 런처, bootstrap 복사본, `app-ref`)과 marketplace, bootstrap(설치 잠금, Node 24.16 하한, ref로만 ff, `--frozen-lockfile --ignore-scripts`, 앞설 때만 갱신, 완료 검증, `installed.json`, 빌드 신원), shim의 node 고정과 폴백, `setup connect claude-code`의 확인·안내·옛 hook 제거, doctor의 플러그인·마지막 hook 항목. hook의 출처는 플러그인 하나. (AD-2·19·20; 회고 F7·F8·F9)
- E2-4 (CAP-1): Claude Code transcript parser와 hook 입출력 — 메인 대화의 본문과 서브에이전트 최종 보고, 도구 메모 한 줄, 추적 정보, 커서와 증분 읽기, 앞부분이 바뀐 transcript의 다시 읽기와 `CURSOR_RESET`, `parser_version`. (FR-1~3, AD-4·6)
- E2-5 (CAP-1): 수집 — `sessions.ingest`와 SQLite `SessionStore`, 세션 행은 수집만 만들고 `seq`는 Store가 배정, 멱등 삽입, 같은 세션의 겹친 수집, `ingest_source`(live·import). (FR-1·5·6, AD-7·8·12)
- E2-6 (CAP-1): 프로젝트·워크트리 정체성 — git remote 정규화(없으면 공통 디렉터리), 첫 메시지 cwd가 유일한 근거, 꼬리표는 한 번 정해 불변, 워크트리 행. 워크스페이스는 slice 1에서 쓰지 않는다. (FR-4, AD-12)
- E2-7 (CAP-1): 빠짐없이 — spool, `work_items` 대기열과 `admin drain`, 기회적 drain, 실패 기록 함수와 fingerprint, 내역(`transcript_files`) 기반 폴더 스캔(설치 직후 첫 스캔이 디스크에 남은 transcript를 모두 가져온다; 스캔이 처음 만든 세션은 `import`, hook이 만든 세션은 `live`), 세션 토큰만으로 하는 증분 수집(epic 3·4가 부름), `sessions failures`·`sessions retry`, doctor의 미수집·실패·spool 항목. (FR-5·6, AD-6·7·9·21)
- E2-8 (CAP-2): 비밀 가리기 — 버전 있는 Core 패턴 목록과 저장 전 마스킹, `messages redact` 연쇄와 확인 게이트. (FR-26, AD-11)
- E2-9 (CAP-14 스키마 자리, CAP-2, CAP-1): 마이그레이션 0003 — `chunk_locator`, `redactions.pattern_version`·파일 가리기 자리·변경 거부 trigger, `document_extractions`의 `attempt`·`failed_stage`·`index_config_id`, `files.source_unreachable_at`, 서브에이전트 표시 칸. 파일 쪽 동작은 epic-attachments. (AD-11·23·24, Table Contract)

## Done when

1. 이 기계의 Claude Code 세션 수와 Brain 세션 수가 같다(SM-5). 설치 때 디스크에 남은 transcript도 들어간다.
2. 같은 transcript를 두 번 수집해도 모든 테이블의 건수가 같고, 같은 세션의 Stop hook이 겹쳐도 seq 충돌이 없다.
3. 세션 도중 프로세스를 죽여도 마지막 턴까지 남고, DB에 쓸 수 없는 동안(잠금 시간 초과·스키마 불일치)의 수집이 spool에 남았다가 쓸 수 있게 되면 drain으로 채워진다. 시작 hook만 돈 세션은 세션 행을 만들지 않고 첫 수집이 만든다.
4. 알려진 비밀 패턴이 든 세션의 저장 본문에 그 값이 없고, `brain messages redact`로 가린 부분은 DB 어디에도 남지 않는다.
5. 같은 레포의 두 워크트리 세션이 한 프로젝트(git remote 정체성)로 묶이고, 레포 밖에서 연 세션은 프로젝트 없이 수집된다.
6. 플러그인을 켜고 세션을 열면 hook 하나로 수집되고, 설치기가 쓴 hook과 플러그인 hook이 동시에 살아 있지 않다. 세션 두 개가 동시에 첫 시작해도 bootstrap은 한 번만 돌고 다른 쪽은 아무것도 하지 않는다. `claude plugin update`로 `app-ref`가 앞서면 첫 세션에서 ff+build가 한 번 돌고 세션 시작은 막히지 않으며, 뒤처지면 아무것도 하지 않고 doctor가 `PLUGIN_BEHIND`를 보인다. doctor가 미수집 세션·실패 수집·spool 건수·마지막 hook 수신 시각·`installed.json`의 `commit`과 `app-ref`·빌드 신원의 관계를 보인다.
7. compact 뒤 다시 수집해도 기존 메시지의 `seq`와 본문이 그대로다. 겹친 drain 두 개가 같은 일감을 두 번 처리하지 않고, 10번 실패한 일감은 `failures`에 남고 멈춘다. 청구를 놓친 것은 시도 횟수를 올리지 않는다.
8. `brain admin schema`가 모든 명령을 내고, 명령 메타가 빠진 명령은 테스트가 잡는다. 비TTY에서 `--yes` 없이 `messages redact`를 부르면 exit 3과 `error.retry`(`confirm: true`)·`error.retry_argv`가 온다. doctor의 `writable` 검사 불가는 `warn`이다.

## Boundaries

AD-4·5·6·7·8·9·11·12·13·18·19·21, Table Contract(projects, worktrees, sessions, messages, tool_notes, redactions, failures, transcript_files, work_items)와 0003의 스키마(파일·추출 칸 포함, 그 동작은 epic-attachments), Conventions(엔벨로프·종료 코드·명령 메타·설치·런타임 기록). AD-11 중 가린 메시지의 조각·미러 재생성 일감은 epic-recall-and-mirror가, 내보내기는 epic-operations가 붙인다. 경고 코드 `SPOOLED`·`CURSOR_RESET`·`DB_UNAVAILABLE`·`PLUGIN_NOT_INSTALLED`·`PLUGIN_BEHIND`·`PLUGIN_DUPLICATE`와 오류 코드 `CONFIRMATION_REQUIRED`(정의와 `messages redact`의 게이트)를 맡는다. 첨부·`FileStore`·문서 추출·`files reindex`·`files redact`·`ATTACHMENT_NOT_REDACTED`는 epic-attachments. 워크스페이스(`workspaces`, `sessions assign-workspace`)는 slice 1에서 쓰지 않는다(칸은 예약). 플러그인의 `skills/`와 SessionStart 동기 `context show` hook 줄은 epic-log-and-context가 더한다. `SEARCH_FAILED`는 epic-recall-and-mirror, 데몬·MCP 코드는 epic-daemon. CAP-10·CAP-11은 플러그인 진입점·hook 출처·CLI 규약 보강 부분만 맡는다(설치 기본은 epic-foundation-and-install, 운영은 epic-operations, 데몬·MCP는 epic-daemon). 문서 검색은 epic-recall-and-mirror, Drive 저장소 구현은 epic-drive. 작업 로그는 만들지 않는다(epic-log-and-context). 미러와 세션 목록·읽기는 epic-recall-and-mirror.

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
- Decision(2026-10-15, 인셉션): 서브에이전트(Task·Agent 도구)는 최종 보고(마지막 답) 하나만 그 세션의 메시지로 넣는다. 서브에이전트임을 표시하는 칸은 0003에 둔다. 나머지 서브에이전트 대화는 넣지 않고, 서브에이전트를 부른 일은 도구 메모 한 줄로 남긴다. FR-1의 "도구 출력 제외"에 예외가 하나 생긴다. 최종 보고를 어디서 읽을지(메인 대화의 Agent 도구 결과인지, 서브에이전트 파일의 마지막 답인지)는 parser 스토리가 fixture로 정한다(사용자).
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
  - 0003에 `redactions` 변경 거부 trigger와 `document_extractions.index_config_id`를 넣는다. `index_config_id`는 epic 4에서 앞당긴 것이다.
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
  - 가장 큰 스토리는 5와 12다. 빌드 플랜에서 한 세션에 넘치면 나눈다.
