---
title: '닫힌 세션 다시 읽기와 수집 실패 해소'
type: 'feature'
ticket: '1'
created: '2026-10-23'
status: 'built'
baseline_revision: '397c1d64d84ce0c31abc54548e411dc5ff4c5462'
route: 'full'
route_source: 'auto'
risk: 'high'
review: 'quick'
review_source: 'pinned'
lenses_ran: [quick]
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: [oversized]
deferred: []
---

<intent-contract>

## Intent

**Problem:** 드레인의 폴더 스캔은 `transcript_files`의 크기만 비교해서(`packages/core/src/capture/scan.ts` `transcriptChanges`), parser 버전이 올라도 크기가 같은 닫힌 세션은 다시 읽히지 않는다(회고 C2, I104). 그러면 새 parser가 살리는 메시지·도구 메모·첨부가 transcript 보관 기간(30일) 뒤 영영 빠진다. 또 hook 경로 `brain.sessions.ingest`의 성공은 그 세션의 미해결 `session_ingest` 실패를 해소하지 않고(C4, `packages/core/src/brain.ts` `sessions.ingest`), 커서가 그대로인 채 줄어든 transcript는 내역이 작은 크기를 받지 않아 스캔마다 다시 대기열에 들어간다(P19).

**Approach:** 스캔이 하네스마다 "저장된 `parser_version`이 현재 parser 버전과 다른 세션"을 잠금 없이 읽어, 디스크에 transcript가 있는 것은 크기와 상관없이 `session_ingest`로 넣고 없는 것은 세어 drain 보고에 남긴다. 다시 읽기 자체는 이미 있는 경로(`cursorFor`가 버전이 다르면 처음부터 읽음)를 쓴다. hook 경로 성공도 미해결 실패를 해소한다. 내역의 "크기는 앞으로만" 규칙은 "더 늦게 시작한 읽기의 작은 크기는 받는다"로 바꿔 P19를 닫는다. 마이그레이션은 없다.

## Boundaries & Constraints

**Always:**
- **다시 읽을 세션 읽기.** `SessionStore`에 잠금 없는 읽기 `listStaleSessions({ harness, parserVersion })` → `{ ok: true; sessions: readonly { harnessSessionId: string }[] } | { ok: false; code: 'DB_UNAVAILABLE'; message }`를 더한다. 그 하네스의 세션 가운데 `parser_version`이 null이거나 주어진 값과 다른 것(SQLite `parser_version is not ?`). 있는 칸만 쓴다.
- **스캔(`capture/scan.ts`).** 의존성에 `parsers: readonly Pick<Parser, 'harness' | 'version'>[]`를 더한다. 폴더마다 목록 → 내역 → 다시 읽을 세션(그 하네스에 parser가 있을 때만), 모두 잠금 없는 읽기. 바뀐 파일 = 크기 변화(`transcriptChanges`, 그대로 둠) ∪ 목록에서 `harnessSessionId`가 다시 읽을 세션인 파일(경로로 중복 제거). 다시 읽을 세션 중 목록에 파일이 없는 것의 수를 `ScanTranscriptsReport.rereadMissing`에 둔다(일감은 만들지 않음). 다시 읽을 세션 읽기가 실패하면 그 문장을 `stopped`에 두고 크기 변화만으로 계속한다. 열린 일감·미해결 실패가 있는 세션을 건너뛰는 규칙, 오래된 순서, 마감, 조용한 기계에서 `addWork`를 부르지 않는 것은 그대로다.
- **drain 보고.** `BrainDrainReport.rereadMissing`, `brain queue drain` 데이터 `reread_missing`(정수), 텍스트 절 `다시 못 읽음 N건`, 명령의 `output` 설명과 README의 drain 설명을 같이 고친다. 쓸 수 없어 멈춘 경우는 0.
- **빈 다시 읽기도 버전을 남긴다(`sessions/ingest.ts`).** 저장된 세션이 있고 그 `parserVersion`이 현재와 다르면, 다시 읽은 결과에 메시지·도구 메모가 없어도 `nothingToStore` 지름길을 타지 않고 빈 batch를 `store.ingest`로 보내 `parser_version`이 새 값이 되게 한다. 그래야 그 세션이 drain마다 다시 들어가지 않는다.
- **C4(`brain.ts` `sessions.ingest`).** `ingestSession`이 `ok: true`이고 `spooled: false`이면, `listFailures({ targetKind: 'session', stage: SESSION_INGEST_KIND })`(잠금 없는 읽기)에서 이 세션 토큰의 행이 있을 때만 `resolveFailures({ targetKind: 'session', targetId: input.session, stage: SESSION_INGEST_KIND, now: clock.now() })`를 부른다. 평소 턴에는 쓰기가 늘지 않는다. 두 호출의 실패는 버리고 수집 결과를 그대로 돌려준다(work handler와 같은 이유).
- **P19(내역 규칙).** `recordTranscriptFile`의 `scannedAt`은 이제 "그 읽기가 시작된 시각"이다: ingest가 `transcripts.read` 직전에 `clock.now()`를 한 번 읽어 쓴다. 작은 크기는 `reset`이거나 `input.scannedAt > 저장된 scanned_at`(엄밀히 더 늦게 시작한 읽기)일 때 받고, 아니면 버린다(늦게 끝난 옛 읽기). SQLite adapter, 가짜 store, 포트 주석, 계약 사례를 같이 고친다.
- 새 문구는 한국어이고 출력 언어 검사·README 코드 대조가 통과해야 한다. CLI 테스트는 빈 임시 `CLAUDE_CONFIG_DIR`을 쓴다.

**Never:**
- 마이그레이션, 새 오류·경고 코드, parser 버전 올림, parser 변경을 하지 않는다. 첨부 채우기는 5의 일이다.
- doctor `transcripts` 점검과 `transcriptChanges`의 의미는 바꾸지 않는다.
- 다시 읽을 세션을 위한 새 일감 종류나 완료 표식을 만들지 않는다. Postgres는 손대지 않는다(이 포트를 구현하지 않음).
- 이미 저장된 메시지를 고치거나 지우지 않는다(AD-11). 다시 읽기는 idempotent한 기존 ingest다.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| 버전 차이, 크기 같음 | 닫힌 세션, 저장 버전 ≠ 현재, 파일 크기 = 내역 | 첫 drain `enqueued` 1, 다시 읽혀 `parser_version` = 현재; 둘째 drain `enqueued` 0 | 없음 |
| 버전 차이, 파일 없음 | 저장 버전 ≠ 현재, 목록에 파일 없음 | 일감 없음, `reread_missing` 1 | 없음 |
| 버전 차이, 다시 읽어도 메시지 0 | 새 parser가 아무것도 남기지 않음 | 빈 batch로 `parser_version` 갱신, 둘째 drain `enqueued` 0 | 없음 |
| 버전 차이, 미해결 실패 | 같은 세션에 미해결 `session_ingest` 실패 | 건너뜀(`skipped`) | `failures retry`가 다시 넣음 |
| hook 성공이 실패 해소 | 미해결 실패가 있는 세션을 `brain sessions ingest`로 수집 | `failures list`에서 사라짐 | 해소 실패는 버리고 수집 성공 유지 |
| hook이 spool로 감 | DB 잠김으로 `SPOOLED` | 해소하지 않음 | 없음 |
| 줄어든 transcript | 커서가 남은 채 꼬리가 잘린 파일 | 첫 drain `enqueued` 1, 내역이 작은 크기로; 둘째 drain `enqueued` 0 | 없음 |
| 늦게 끝난 옛 읽기 | 더 일찍 시작한 읽기가 작은 크기를 나중에 기록 | 버림, 행은 그대로 | 없음 |
| 다시 읽을 세션 읽기 실패 | `listStaleSessions`가 `DB_UNAVAILABLE` | 크기 변화만으로 스캔, `stopped`에 문장 | 다음 drain이 다시 시도 |

</intent-contract>

## Code Map

- `packages/core/src/capture/scan.ts` -- `scanTranscripts`(읽기 순서·`leaveAlone`·마감), `transcriptChanges`(그대로, doctor와 공유), `ScanTranscriptsReport`에 `rereadMissing`.
- `packages/core/src/brain.ts` -- `createBrain`의 `sessions.ingest`(C4, 지금은 `ingestSession`을 바로 돌려줌), `drain()`이 `scanTranscripts`에 `parsers`를 넘기고 `BrainDrainReport`(~150행)에 `rereadMissing`. spool handler(~225–250행)의 `resolveFailures` 패턴을 참고.
- `packages/core/src/capture/session-ingest-work.ts` -- `SESSION_INGEST_KIND`, 성공 뒤 `resolveFailures` 패턴(바꾸지 않음).
- `packages/core/src/sessions/ingest.ts` -- `cursorFor`(버전이 다르면 null 커서, 이미 있음), `nothingToStore` 지름길(~325행), `recordHistory`의 `scannedAt`(~310행)를 읽기 시작 시각으로.
- `packages/core/src/ports/store.ts` -- `SessionStore`(~237행)에 `listStaleSessions`, `TranscriptFileStore.recordTranscriptFile` 주석(~696–710행), `RecordTranscriptFileInput.scannedAt`(~666행) 의미.
- `packages/core/src/ports/parser.ts` -- `Parser.harness`·`version`.
- `packages/sqlite/src/sessions.ts` -- `listIdentityCandidates`(~295행)를 본뜬 잠금 없는 읽기로 `listStaleSessions`.
- `packages/sqlite/src/transcript-files.ts` -- 작은 크기 버림 조건(~100행)에 `scannedAt` 비교 추가.
- `packages/core/src/testing/fakes/store.ts` -- `recordTranscriptFile`(~700행) 같은 규칙, `listStaleSessions` 구현.
- `packages/core/src/testing/contracts/transcript-file-store.ts` -- "a smaller size is dropped unless it is a reset" 사례를 새 규칙으로(더 이른·같은 시각의 작은 크기는 버림, 더 늦은 시각은 받음, reset은 받음).
- `packages/core/src/testing/contracts/session-store.ts` -- `listStaleSessions` 계약 사례(null 버전 포함, 다른 하네스 제외).
- `apps/cli/src/doctor/store.ts` -- 진단용 store 껍데기(~51행): 새 메서드를 `unavailable`로.
- `apps/cli/src/commands/queue-drain.ts` -- `QueueDrainData.reread_missing`, `counts()` 절, `output` 설명.
- `README.md` -- `brain queue drain` 설명(~377행 근처)에 칸과 다시 읽기 동작.
- `packages/claude-code/src/parser.ts` -- `CLAUDE_CODE_PARSER_VERSION = '4'`(읽기만).
- 시험: `packages/core/test/capture-scan.test.ts`, `packages/core/test/sessions-ingest.test.ts`, brain 조립 시험(있는 곳), `packages/sqlite/test/transcript-file-store.test.ts`·`session-store.test.ts`, `apps/cli/test/capture-scan.test.ts`(`rows`·`rowCounts`·`transcript` 도우미), `apps/cli/test/sessions-ingest.test.ts`, `apps/cli/test/queue-drain.test.ts`.

## Tasks & Acceptance

**Execution:**
- [ ] `packages/core/src/ports/store.ts` -- `listStaleSessions` 타입·주석, `recordTranscriptFile` 규칙 주석과 `scannedAt` 의미 -- 포트가 규칙의 원본.
- [ ] `packages/sqlite/src/sessions.ts`, `packages/core/src/testing/fakes/store.ts`, `apps/cli/src/doctor/store.ts`, `packages/core/src/testing/contracts/session-store.ts` -- `listStaleSessions` 구현과 계약 -- 스캔이 쓸 읽기.
- [ ] `packages/sqlite/src/transcript-files.ts`, 가짜 store, `packages/core/src/testing/contracts/transcript-file-store.ts` -- 시작 시각 비교 규칙과 계약 -- P19.
- [ ] `packages/core/src/sessions/ingest.ts` -- 읽기 시작 시각을 `scannedAt`으로, 버전이 다른 빈 다시 읽기의 빈 batch -- 다시 읽기가 한 번으로 끝나게.
- [ ] `packages/core/src/capture/scan.ts`, `packages/core/src/brain.ts` -- 다시 읽을 세션 합치기·`rereadMissing`·`parsers` 전달·C4 -- 이야기의 본체.
- [ ] `apps/cli/src/commands/queue-drain.ts`, `README.md` -- `reread_missing` 칸·절·설명 -- 공개 표면.
- [ ] 시험 -- I/O 표의 모든 줄을 Core(가짜 store·가짜 parser 버전 바꾸기)로, 아래 AC를 CLI로.

**Acceptance Criteria:**
- Given `brain queue drain`으로 수집한 닫힌 세션의 DB `sessions.parser_version`을 옛 값으로 바꾸고 transcript는 그대로 둔 설치, when `brain queue drain --json`을 두 번 돌리면, then 첫 번째는 `enqueued` 1이고 그 세션의 `parser_version`이 현재 값이 되며 메시지 수는 늘거나 같고, 두 번째는 `enqueued` 0이다.
- Given 같은 설치에서 그 세션의 transcript 파일을 지운 상태, when `brain queue drain --json`, then `enqueued` 0, `reread_missing` 1이다.
- Given transcript를 읽을 수 없게 해 drain이 그 세션의 `session_ingest` 실패를 기록한 뒤 다시 읽을 수 있게 한 상태, when hook 입력으로 `brain sessions ingest`를 돌리면, then `brain failures list --json`에 그 세션이 없다.
- Given 수집한 transcript의 끝 줄 몇 개를 잘라 낸 상태, when `brain queue drain --json`을 두 번, then 첫 번째 `enqueued` 1, 두 번째 `enqueued` 0이다.
- Given 바뀐 것이 없는 설치, when `brain queue drain --json`, then `enqueued` 0이고 `transcript_files`·`work_items` 행이 바뀌지 않는다.

## Implementation Notes

- 구현은 codex 워커(Orca run `run_852483f55120`)가 했다. 워커가 처음에 `bmad-build` 스킬을 부르려다 renderer가 죽어 물었고, 코디네이터가 "계획을 바로 구현"으로 답했다.
- 바뀐 곳: Core 스캔(`listStaleSessions`로 다시 읽을 세션 합치기, `rereadMissing`), `brain.ts`(C4 해소, drain 보고), `sessions/ingest.ts`(읽기 시작 시각을 `scannedAt`으로, 버전이 다른 빈 다시 읽기의 빈 batch), 포트·가짜 store·SQLite adapter·계약 두 곳, CLI `queue drain`의 `reread_missing`, README, 시험(Core·CLI).
- 코디네이터 보정: 워커가 포트·계약·adapter의 "왜"를 설명하던 영어 주석을 짧은 한국어 한 줄로 바꿔 이유(늦게 끝난 옛 읽기, compact)가 사라졌다. 영어 주석으로 이유를 되살렸다(동작 변경 없음).

## Plan Change Log

## Review Triage Log

### 2026-10-23 — Review pass
- verdicts: 1 findings — high 0, medium 0, low 1, false 0, maybe-false 0
- findings:
  - `[low]` `[reject]` 같은 크기의 더 이른 읽기가 `scannedAt`을 뒤로 돌려, t1<t2<t3에 200·100·200바이트를 읽고 t3→t1→t2 순으로 끝나면 100바이트가 남아 다음 스캔이 그 파일을 한 번 더 넣는다(`packages/sqlite/src/transcript-files.ts`, 가짜 store) — 코드로는 맞다. 하지만 덧붙이기만 하는 transcript에서는 더 늦게 시작한 읽기가 더 작은 크기를 볼 수 없어(t2의 100바이트는 줄었다 다시 자란 파일에서만 생김) 일상에서 만나기 어렵고, 대가는 idempotent한 다시 읽기 한 번이며, 고치려면 갈래를 하나 더해야 한다.

## Design Notes

- Decision(2026-10-23, 무인 실행에서 에이전트가 고름) P19 정책: "작은 크기는 더 늦게 시작한 읽기면 받는다". 원래 "앞으로만" 규칙의 이유는 늦게 끝난 옛 읽기 하나였고, 읽기 시작 시각으로 그 경우만 가려낼 수 있다. 잘못 받아도 대가는 한 번 더 읽는 것뿐이다(ingest는 idempotent, 세션 커서는 `transcript_files`가 아니라 `sessions`가 지킴). 다른 안: 스캔이 커진 파일만 넣음(줄어든 파일을 한 번도 읽지 않음), 그대로 둠(회고가 정하라고 넘김).
- Decision(같은 날) 디스크에서 사라진 다시 읽을 세션은 일감 없이 drain 보고 `reread_missing`으로만 센다. 다른 안: 실패 행 기록(되살릴 수 없는 일을 `failures retry` 대상에 남김).
- Decision(같은 날) C4는 미해결 실패가 있을 때만 쓴다. hook 경로 중앙값(약 93ms)에 평소 쓰기를 더하지 않기 위해서다.

## Verification

**Commands:**
- `pnpm test` -- expected: build → typecheck → vitest 모두 통과(Postgres 포함, Docker 필요; 없으면 `pnpm exec vitest run --project core --project sqlite --project second_brain --project cli --project bootstrap --project claude-code`로 나머지 전부 통과).
- `git diff --check` -- expected: 통과, 더한 줄에 절대 홈 경로 없음.

## Auto Run Result

Status: built

- 요약: 드레인 스캔이 하네스마다 저장된 `parser_version`이 현재와 다른 세션을 잠금 없이 읽어, 디스크에 transcript가 있으면 크기가 같아도 `session_ingest`로 다시 읽고 없으면 `reread_missing`으로 센다. 다시 읽은 결과가 비어도 빈 batch로 버전을 남겨 한 번으로 끝난다. hook 경로 `brain.sessions.ingest`의 성공은 미해결 `session_ingest` 실패가 있을 때만 그것을 해소한다(C4). 내역은 "더 늦게 시작한 읽기의 작은 크기는 받는다"로 바뀌어 줄어든 transcript가 스캔마다 다시 들어가지 않는다(P19). 마이그레이션 없음.
- 바뀐 파일:
  - `packages/core/src/capture/scan.ts` — 다시 읽을 세션 합치기, `rereadMissing`.
  - `packages/core/src/brain.ts` — C4 해소, drain에 `parsers` 전달, `BrainDrainReport.rereadMissing`.
  - `packages/core/src/sessions/ingest.ts` — 읽기 시작 시각을 내역에, 버전이 다른 빈 다시 읽기의 빈 batch.
  - `packages/core/src/ports/store.ts` — `listStaleSessions`, 내역 규칙과 `scannedAt` 의미.
  - `packages/sqlite/src/sessions.ts`, `packages/sqlite/src/transcript-files.ts` — 새 읽기와 새 규칙.
  - `packages/core/src/testing/fakes/store.ts`, `packages/core/src/testing/contracts/{session-store,transcript-file-store}.ts` — 가짜와 계약.
  - `apps/cli/src/commands/queue-drain.ts`, `apps/cli/src/doctor/store.ts`, `README.md` — `reread_missing` 칸·절·설명, 진단 store 껍데기.
  - 시험: `packages/core/test/{brain-drain,capture-scan,sessions-ingest,contracts}.test.ts`, `apps/cli/test/{capture-scan,queue-drain,dispatch}.test.ts`.
- 리뷰: Quick 렌즈(codex 워커) 지적 1건 — low 1건 반려(위 Triage). 패치 0건, 미룸 0건.
- 후속 리뷰 권장: false(패치한 항목 없음; high 0, medium 0).
- 검증: `pnpm test` — build → typecheck → vitest 74개 파일·2,342개 통과(Postgres 포함, 주석 보정 뒤 다시 돌림). `git diff --check` 통과, 더한 줄에 절대 홈 경로 없음. I/O 표의 아홉 줄 모두 시험이 있다(Core `brain-drain`·`capture-scan`·`sessions-ingest`, 계약, CLI `capture-scan`).
- 남은 위험: 이 기계의 실제 DB에서는 아직 돌려 보지 않았다(설치된 플러그인이 이 커밋을 받은 뒤 첫 drain에서 버전이 다른 세션이 있으면 다시 읽힌다). 반려한 겹친 읽기 순서는 한 번 더 읽는 것으로 끝난다. doctor `transcripts`는 다시 읽을 세션을 세지 않는다(계획의 Never).

