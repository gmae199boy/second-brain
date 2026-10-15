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

Claude Code transcript parser, `sessions.ensure`, 턴마다 증분 수집(세션 잠금), 프로젝트·워크트리 식별(git remote 정규화)과 `sessions assign-workspace`, Claude Code connector와 hook 등록(`setup connect`), drain(실패 재시도·transcript 폴더 스캔), spool(스키마 불일치 포함), `sessions failures`·`sessions retry`, 저장 전 비밀 마스킹과 `messages redact`를 만든다.

2026-10-14 변경으로 더한 것: SQLite `SessionStore`(ensure·ingest·readSession)와 계약 사례, 쓰기는 `withWrite`, `seq`는 원본 Store가 배정(AD-4·8), 시작 hook은 읽기 전용이고 세션 행은 첫 수집이 만듦(AD-6), 일감 대기열 `work_items`(미완료 `(kind, target_kind, target_id)` 하나, 짧은 쓰기 트랜잭션 청구, 종류별 청구 기간·지수 재시도 Core 상수, 10회 실패 시 `failures`, AD-21)와 모든 명령의 기회적 drain, `FileStore` port와 계약 테스트(`brain` 소유이면서 루트 안인 위치만 쓰고 지움) 및 로컬 구현, 첨부 원본 저장과 메시지 연결, 문서 텍스트 추출 일감(세대·상태, `files reindex`), 고아 블롭 정리, 가리기 연쇄와 `files redact`(AD-11·23·24).

2026-10-15 변경(추가안 B, `../change-surface-plugin-daemon/`)으로 더한 것:
- **Claude Code 플러그인 뼈대** — hook의 출처는 플러그인 하나(AD-19). `plugin/`에 `.claude-plugin/plugin.json`(매니페스트는 여기만), `hooks/hooks.json`(SessionStart 동기 `context show` + SessionStart 비동기 bootstrap, Stop·SessionEnd 수집; 명령은 전부 `|| exit 0`으로 감쌈), 의존성 없는 `bootstrap.js` 복사본(테스트로 원본과 동기화), `app-ref`(40자 sha 한 줄). `package.json`·lockfile 없음. 루트 `.claude-plugin/marketplace.json`이 `./plugin`을 가리킨다. 비동기 hook은 `<home>/installed.json`이 없거나 그 `commit`이 `app-ref`의 조상일 때(플러그인이 앞설 때)만 `bootstrap.js --yes --ref <sha> --plugin-root …`를 돌리고, 뒤처지면 아무것도 하지 않고 doctor `warn`(`PLUGIN_BEHIND`). bootstrap: 설치 잠금(`<home>/install.lock/` 디렉터리, pid·시작 시각, 30분 stale), 진입점에서 24.16 하한(회고 F7), ref로만 ff, `--frozen-lockfile`(`--ignore-scripts` 가능 여부는 인셉션 검증), 완료 검증(`bin.js admin schema --json` exit 0) 뒤 `installed.json`(`{commit, schema_version, installed_at, node, plugin_root}`)을 마지막에 원자적으로 쓴다. 빌드는 `dist/build.json`에 빌드 신원 `{commit, schema_version}`을 박는다. stdout에는 완료·실패의 `systemMessage` 한 줄만(비동기 hook 출력은 다음 턴 모델로 간다). shim은 node 실제 바이너리(`realpath`)를 고정하고, 없으면 nvm → Homebrew → `/usr/local/bin` 순으로 찾아 재고정한다(volta 같은 버전 관리자 shim은 고정하지 않음). `setup connect claude-code`는 `installed.json.plugin_root`로 판정해 없으면 `PLUGIN_NOT_INSTALLED` 경고(`ok: true`)를 내고 설치기가 예전에 쓴 표식 hook을 지운다. 플러그인 `version`은 `app-ref`와 함께 올린다. 플러그인 설명에 첫 세션의 자동 clone·install·build를 명시한다. 첫 세션은 설치가 끝날 때까지 시작 맥락·라이브 수집이 없고, 끝나면 폴더 스캔이 줍는다.
- **CLI 규약 보강**(스토리 하나, 앞쪽): `brain admin schema [ns verb]`·`admin exit-codes`·`admin guide`(명령 메타 `used_for`·`required`·`examples`·`output`·`risk`·`hook`·`dryRun` 한 곳에서 생성, 누락은 테스트 실패), 엔벨로프 `error{code, message, exit_code, retryable?, hint?, retry{ns, verb, args}}`와 `meta{hint, count, has_more, omitted, next}`(코덱은 Core), 확인 게이트는 SDK `confirm: true`(CLI `--yes` → `confirm`), 종료 코드 3 `CONFIRMATION_REQUIRED`(CLI는 `retry_argv`를 덧붙임, hook 경로는 0), doctor `warn`·선행 실패 `skip`(`detail`)·`summary`, 경고·오류 코드 목록은 Core 상수, 빈 위치 인자·제어문자 거부, README 종료 코드 표와 코드의 양방향 대조 테스트.
- **마이그레이션 0003**: `document_chunks.chunk_locator`(JSON, Core 정규형, `type ∈ {pdf, docx, text, time, sheet}`; `page`는 읽기 전용 사본), `redactions.pattern_version`과 `files.redact` 자리(deferred), `document_extractions.attempt`(Store가 `max+1` 배정, `(file_id, attempt)` UNIQUE, 파일당 진행 중 세대 하나)·`failed_stage`, `files.source_unreachable_at`.
- 기존 스토리의 완료 조건으로: 비밀 패턴 목록(한국어판, PEM 블록 전체, 버전 있음)과 과잉 가림 회귀 테스트(git SHA·UUIDv7·sha256·이메일·사설 IP·경로), 셸 `NAME=value` 마스킹, 값은 구두점에서 멈춤, drain 순서 `fail_count ASC, id ASC`, failures payload 보존·UTF-8 경계 자르기, hook이 정한 UUIDv7 + 같은 seq·다른 harness id는 경고, 기회적 drain의 예외(동기 hook·hook 경로·데몬 켜짐·읽기 선확인, AD-7). 원천: `inputs/weknora-patterns.md` §1.1, §1.5.

## Outcome

Claude Code 세션이 손대지 않아도 비밀이 가려진 채 빠짐없이 쌓인다.

## Requirements

인셉션 때 채운다. spec의 CAP-1, CAP-2, CAP-14(첨부·추출 부분)와 CAP-10·CAP-11의 플러그인 진입점·CLI 규약 부분, 그것들이 인용하는 PRD FR·spine AD가 원천이다.

## Done when

1. 이 기계의 Claude Code 세션 수와 Brain 세션 수가 같다(SM-5).
2. 같은 transcript를 두 번 수집해도 모든 테이블의 건수가 같고, 같은 세션의 Stop hook이 겹쳐도 seq 충돌이 없다.
3. 세션 도중 프로세스를 죽여도 마지막 턴까지 남고, DB에 쓸 수 없는 동안(잠금 시간 초과·스키마 불일치)의 수집이 spool에 남았다가 쓸 수 있게 되면 drain으로 채워진다. 시작 hook만 돈 세션은 세션 행을 만들지 않고 첫 수집이 만든다.
4. 알려진 비밀 패턴이 든 세션의 저장 본문에 그 값이 없고, `brain messages redact`로 가린 부분은 DB 어디에도 남지 않는다.
5. 같은 레포의 두 워크트리 세션이 한 프로젝트(git remote 정체성)로 묶이고, 프로젝트 없는 세션을 워크스페이스에 넣을 수 있다.
6. 플러그인을 켜고 세션을 열면 hook 하나로 수집되고, 설치기가 쓴 hook과 플러그인 hook이 동시에 살아 있지 않다. 세션 두 개가 동시에 첫 시작해도 bootstrap은 한 번만 돌고 다른 쪽은 아무것도 하지 않는다. `claude plugin update`로 `app-ref`가 앞서면 첫 세션에서 ff+build가 한 번 돌고 세션 시작은 막히지 않으며, 뒤처지면 아무것도 하지 않고 doctor가 `PLUGIN_BEHIND`를 보인다. doctor가 미수집 세션·실패 수집·spool 건수·마지막 hook 수신 시각·`installed.json`의 `commit`과 `app-ref`·빌드 신원의 관계를 보인다.
7. 첨부가 있는 세션에서 원본이 저장소에 한 번만 남고 메시지에서 위치를 받을 수 있으며, 텍스트 문서는 추출 세대가 생기고 추출 실패는 표시된다. 가린 첨부의 내용은 조각·검색 어디에도 남지 않는다.
8. compact 뒤 다시 수집해도 기존 메시지의 `seq`와 본문이 그대로다. 겹친 drain 두 개가 같은 일감을 두 번 처리하지 않고, 10번 실패한 일감은 `failures`에 남고 멈춘다. 청구를 놓친 것은 시도 횟수를 올리지 않는다.
9. `brain admin schema`가 모든 명령을 내고, 명령 메타가 빠진 명령은 테스트가 잡는다. 비TTY에서 `--yes` 없이 `messages redact`를 부르면 exit 3과 `error.retry`(`confirm: true`)·`error.retry_argv`가 온다. doctor의 `writable` 검사 불가는 `warn`이다.
10. 문서 조각마다 `chunk_locator`가 있고(텍스트 문서는 글자 범위, PDF는 쪽) `page`가 그 사본과 같으며, 추출 실패는 `failed_stage`로 어디서 실패했는지 보인다. 같은 파일을 다시 추출해도 `attempt`가 하나씩 오르고 옛 시도가 포인터를 덮지 않는다.

## Boundaries

AD-4·5·6·7·8·9·11·12·13·18·19·21·23·24, Table Contract(projects, worktrees, workspaces, sessions, messages, tool_notes, redactions, failures, transcript_files, work_items, files, file_locations, message_attachments, document_extractions, document_chunks), Conventions(엔벨로프·종료 코드·명령 메타·설치·런타임 기록). 경고 코드 `SPOOLED`·`CURSOR_RESET`·`DB_UNAVAILABLE`·`ATTACHMENT_NOT_REDACTED`·`PLUGIN_NOT_INSTALLED`·`PLUGIN_BEHIND`·`PLUGIN_DUPLICATE`와 오류 코드 `CONFIRMATION_REQUIRED`(정의와 `messages redact`·`files redact`의 게이트)를 맡는다. `SEARCH_FAILED`는 epic-recall-and-mirror, 데몬·MCP 코드는 epic-daemon. CAP-10·CAP-11은 플러그인 진입점·hook 출처·CLI 규약 보강 부분만 맡는다(설치 기본은 epic-foundation-and-install, 운영은 epic-operations, 데몬·MCP는 epic-daemon). 문서 검색은 epic-recall-and-mirror, Drive 저장소 구현은 epic-drive. 작업 로그는 만들지 않는다(epic-log-and-context). 미러는 epic-recall-and-mirror.

## References

- parent — _bmad-output/personal-brain/initiative-personal-brain.md
- spec — _bmad-output/personal-brain/spec-brain-v1-slice-1/spec-brain-v1-slice-1.md, Capabilities CAP-1, CAP-2, CAP-10, CAP-11, CAP-14
- architecture — _bmad-output/personal-brain/architecture-brain-v1-slice-1/architecture-brain-v1-slice-1.md
- prd — _bmad-output/personal-brain/prd-brain-v1-slice-1/prd-brain-v1-slice-1.md
- inputs — _bmad-output/personal-brain/inputs/weknora-patterns.md, §1.1 (A1~A10), §1.5 (E1~E11)
- change — _bmad-output/personal-brain/change-surface-plugin-daemon/change-surface-plugin-daemon.md, §4.1, §6

## Notes

- Decision(2026-10-14): 원본 SQLite 전환과 추가안 A(첨부·추출)로 범위가 늘었다. 인셉션 때 다시 나눈다. 꼬리표 권위 출처와 `failures.fingerprint` 정의는 인셉션에서 정한다(spine Deferred).
- Decision(2026-10-15, 추가안 B): Claude Code 설치·hook 진입점은 플러그인이고 `setup connect claude-code`는 확인·안내로 바뀐다. 당분간 Claude Code만(Codex 제외). Node 24 이상 유지. 확인 필요 종료 코드 3. CLI 규약 보강은 이 에픽 앞쪽의 스토리 하나. 조각 위치는 `chunk_locator`만(`page`는 사본), 추출 시도는 `attempt`+`failed_stage`+포인터 가드로 단순화(사용자). 인셉션에서 검증할 것: hook 환경의 PATH 실측, `pnpm --ignore-scripts` 가능 여부, 비동기 hook 완료 알림(`systemMessage` vs `asyncRewake`).
- Carry(2026-10-15, epic 1 closure): 인셉션 때 넣을 것 — `packages/second_brain/test/import-side-effects.test.ts`가 `second_brain` import 시 SQLite DB 파일을 열지 않음도 단정하게(지금은 Postgres 연결 없음만 본다, Done when 5). 설치기 설정 보존 버그 2건(`deferred-work.md` story 13 항목). SQLite `SessionStore`(ensure·ingest·readSession) 계약 통과.
