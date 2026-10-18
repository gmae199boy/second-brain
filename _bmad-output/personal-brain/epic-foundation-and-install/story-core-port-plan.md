---
title: 'Core port와 도메인 타입'
type: 'feature'
ticket: '2'
created: '2026-10-13'
status: done
baseline_revision: 'ab84bb2f57e6bca80de1418e20fda907e40b17e8'
route: 'full'
route_source: 'auto'
risk: 'low'
review: 'quick'
review_source: 'pinned'
lenses_ran: [quick]
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Core에는 tracer용 `Store { checkHealth, close }`만 있다. 이후 에픽이 붙을 port(Store·Parser·Embedder·Reranker·Clock·IdGen), Table Contract의 도메인 타입, adapter가 통과해야 할 계약 테스트가 없고, Runtime에 시계와 ID 생성기가 없다.

**Approach:** Core에 도메인 타입과 port를 정의하고, port별 계약 테스트를 vitest에 의존하지 않는 "케이스 목록"으로 `@second-brain/core/testing`에 둔다. 메모리 가짜 Store·Parser·Embedder·Reranker가 그 케이스를 통과하고, `apps/cli`의 `systemClock`과 UUIDv7 `IdGen`(uuid 14.0.2)이 Clock·IdGen 케이스를 통과한다.

## Boundaries & Constraints

**Always:**
- AD-1: `core`는 `dependencies` 없음, tsconfig `types: []` 유지. 계약 케이스와 메모리 가짜도 Node API·vitest를 import하지 않는다.
- 기존 `Store.checkHealth`·`close`·`StoreHealth`·`runDoctor`·`createBrain`의 동작과 tracer 테스트 21개는 그대로 통과.
- Store는 capability별 작은 port로 나눈다: 기존 건강 port + 세션 쓰기·읽기 port. `Store`는 그 합성 타입. postgres adapter는 이번에 건강 port만 구현하고(세션 port는 epic 2), `createBrain`은 지금 쓰는 건강 port만 요구한다.
- 예상된 실패는 코드 있는 값(`{ ok:false, code, message }`), 예외는 버그에만(Conventions).
- 시각은 `Date`(절대 시각), ID는 문자열 UUIDv7, 세션 토큰은 `harness:harness_session_id`(AD-8·13). 이름은 TS `camelCase`/`PascalCase`.
- 새 외부 의존은 `apps/cli`의 `uuid` 14.0.2(정확한 버전) 하나.
- 공개 저장소 위생: fixture·예시는 중립 이름.
- Decision(2026-10-13): 플랜 크기(약 2,800 토큰)는 단일 목표이므로 분할하지 않고 전체를 유지한다.

**Never:**
- SQL·마이그레이션(story 3), 설정·봉투·디스패처(4), 실제 parser·임베딩 adapter(epic 2·6), use case(`sessions.ingest` 등) 구현, 비밀 마스킹·프로젝트 정규화 함수.
- postgres adapter에 세션 port 스텁("미구현" 메서드)을 두는 것.
- Core가 `Date.now()`·`new Date()`(인자 없음)·난수를 직접 부르는 것(Clock·IdGen port로만). 메모리 가짜는 호출자가 준 값만 쓴다.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| 세션 find-or-create | 같은 `(harness, harnessSessionId)`로 다른 제안 id를 두 번 `ensureSession` | 두 번째도 첫 행(첫 id) 반환, 세션 1건 | — |
| 배치 멱등 (AD-8) | 같은 `IngestBatch`를 두 번 `ingest` | 메시지·도구 메모 건수 동일, 두 번째 결과의 삽입 수 0 | — |
| 모르는 세션 읽기 | 없는 토큰으로 `readSession` | `{ ok:false, code:'SESSION_NOT_FOUND' }` | 던지지 않음 |
| parser 결정성 | 같은 fixture를 두 번 `parse` | 결과 깊은 동일, `seq` 0부터 1씩 증가, (메시지, ordinal) 유일 | — |
| embedder 형태 | 텍스트 n개 | 벡터 n개, 각 길이 = `dimensions` | 실패는 값 |
| reranker 형태 | 문서 n개 | 0..n-1 범위의 중복 없는 index, 점수 내림차순 | 실패는 `RERANK_FAILED` 값 |
| IdGen | 같은 ms에 1,000번 `next()` | 모두 UUIDv7 형식(버전 7, variant 10), 중복 없음, 생성 순서 = 문자열 정렬 순서 | — |
| 계약 위반 감지 | 일부러 틀린 가짜(배치마다 메시지를 다시 넣는 Store) | 해당 케이스가 실패 | 케이스가 Error를 던짐 |

</frozen-after-approval>

## Code Map

- `packages/core/src/ports/store.ts` -- 기존 `Store`·`StoreHealth`·`StoreVectorHealth`. 건강 port를 이름만 분리(`HealthStore` 등)하고 `Store`를 합성 타입으로 재정의. doc 주석의 "later stories widen" 갱신.
- `packages/core/src/brain.ts` -- `BrainDependencies.store` 타입만 건강 port로 좁힌다. 동작 변경 없음.
- `packages/core/src/index.ts` -- 새 타입·port export 추가.
- `packages/core/package.json` -- `exports`에 `./testing` 추가(`dist/testing/index.*`). `dependencies` 추가 금지.
- `packages/core/test/doctor.test.ts` -- 기존 가짜 Store 패턴. 변경 없음.
- `packages/postgres/src/store.ts` -- `postgresStore` 반환 타입만 건강 port로 바꾼다.
- `packages/second_brain/test/boundaries.test.ts` -- core `dependencies` 없음 검사. 그대로 통과해야 함.
- `apps/cli/package.json` -- `uuid: "14.0.2"` 추가. `apps/cli`는 `second_brain`만 import(AD-1)이므로 Clock·IdGen 타입은 `second_brain`에서 가져온다.
- `vitest.config.ts` -- `test/` 폴더가 있는 패키지만 project. 변경 없음.
- 아키텍처: AD-4(IngestBatch·parser 계약), AD-8, AD-11, AD-12, AD-14, Table Contract — `_bmad-output/personal-brain/architecture-brain-v1-slice-1/architecture-brain-v1-slice-1.md`.

## Tasks & Acceptance

**Execution:**
- [x] `packages/core/src/domain/*.ts` -- Table Contract 테이블마다 타입(Workspace, Project, Worktree, Session, Message, ToolNote, LogEntry(`kind: progress|decision|rule|preference`, `ruleState: pending|on|off`), LogEntryEdit, Chunk, Embedding, IndexConfig, Redaction, ContextInjection, Failure, TranscriptFile, SchemaVersion), `IngestBatch`, `SessionToken`과 `formatSessionToken`/`parseSessionToken`(잘못된 토큰은 값으로 실패). 컬럼은 Table Contract·AD에 이름이 나온 것만 -- 단위 사이의 공통 언어
- [x] `packages/core/src/ports/{store,parser,embedder,reranker,clock,id-gen}.ts` -- 건강 port 분리 + `SessionStore { ensureSession, ingest, readSession }`, `Store = HealthStore & SessionStore`, `Parser { harness, version, parse(content) }`, `Embedder { model, dimensions, embed(texts) }`, `Reranker { model, rerank(query, documents) }`, `Clock { now(): Date }`, `IdGen { next(): string }` -- port
- [x] `packages/core/src/testing/` -- `assert` 헬퍼(깊은 비교 포함, 의존 없음), `ContractCase<F>` 형태, `storeContract`·`sessionStoreContract`·`parserContract`·`embedderContract`·`rerankerContract`·`clockContract`·`idGenContract`, 메모리 가짜(`memoryStore()` 등). `index.ts`로 묶어 `./testing` export -- adapter가 붙일 틀
- [x] `packages/core/test/contracts.test.ts` -- 각 계약을 메모리 가짜로 돌리고, 일부러 틀린 가짜로 실패를 확인(I/O 표 전 행), 세션 토큰 왕복 -- 틀 자체 검증
- [x] `packages/postgres/src/store.ts`, `packages/core/src/brain.ts`, `packages/core/src/index.ts`, `packages/core/package.json` -- 타입 좁히기·export -- 기존 tracer 유지
- [x] `packages/postgres/test/store.test.ts` -- 기존 테스트에 `storeContract`(건강 케이스)를 실제 DB로 돌리는 블록 추가 -- adapter가 틀에 붙는 첫 예
- [x] `apps/cli/src/runtime/{clock,id-gen}.ts`, `apps/cli/test/runtime.test.ts` -- `systemClock`, `uuidV7IdGen()`(uuid의 `v7`), Clock·IdGen 계약 통과 -- Runtime 구현
- [x] 전체 -- `npx -y pnpm@12.10.1 install && npx -y pnpm@12.10.1 test` 통과 -- 마무리

**Acceptance Criteria:**
- Given 깨끗한 빌드, when `pnpm test`, then 기존 21개를 포함해 전 프로젝트가 통과하고 core `package.json`에 `dependencies`가 없다.
- Given 빌드된 core, when `import("@second-brain/core/testing")`, then 계약 케이스와 메모리 가짜가 vitest 없이 로드된다.
- Given `second_brain`, when 타입 검사, then `Clock`·`IdGen`·`Store`·도메인 타입이 재export되어 `apps/cli`가 그것만으로 컴파일된다.

## Implementation Notes

- 도메인 타입의 컬럼은 Table Contract·AD에 이름이 나온 것만 담았고, 그 외에 PRD Glossary가 이름을 준 `ToolNote.tool`·`target`·`ok`(도구 이름·대상·성공 여부)와 addendum의 `messages.body`를 썼다. story 3의 SQL이 컬럼을 더하면 같은 이름으로 맞춘다.
- 건강 port 이름은 `HealthStore`이고 `close`를 포함한다. `createBrain`과 `runDoctor`가 쓰는 것이 probe와 teardown 둘이므로, 그 둘만으로 완결된 port여야 `postgresStore`가 세션 스텁 없이 들어맞는다(AD-10).
- 세션 커서는 AD-4의 (마지막 Harness 메시지 ID, fingerprint)를 `ParserCursor` 한 타입으로 묶어 `Session.cursor`와 `TranscriptFile.cursor`가 같이 쓴다.
- Plan 밖 추가 1: `packages/second_brain/src/testing.ts`와 `second_brain`의 `./testing` export. `apps/cli`는 `second_brain`만 import해야 하므로(AD-1·2) Clock·IdGen 계약 케이스도 그 표면으로 간다. 재export 한 줄뿐이고 `dependencies`는 그대로다.
- Plan 밖 추가 2: `packages/core/test/doctor.test.ts`의 가짜 Store 타입 주석을 `Store`에서 `HealthStore`로 바꿨다(동작·케이스 수는 그대로). `Store`가 세션 port까지 합성한 타입이 되었으므로 주석을 그대로 두면 타입이 틀린다. vitest는 타입 검사를 하지 않아 테스트는 통과하지만, 틀린 주석을 남기지 않았다.
- `vitest.config.ts`는 `test/` 폴더가 있는 패키지만 project로 잡으므로 `apps/cli/test/runtime.test.ts`는 자동으로 들어갔다. 다만 각 패키지의 `tsconfig.json`은 `src`만 include하므로 테스트 파일은 빌드 때 타입 검사되지 않는다. 이번 작업에서는 임시 tsconfig(`include: ["src","test"]`)로 core·postgres·cli의 테스트를 따로 타입 검사해 통과를 확인했다(second_brain의 기존 테스트는 `types: ["node"]`가 없어 원래부터 이 방식으로는 검사되지 않는다 — 기존 상태 그대로 둠).

- 2026-10-13 (오케스트레이터, Matrix 감사) embedder·reranker 행의 "실패는 값" 분기를 돌리는 테스트가 없어 `packages/core/test/contracts.test.ts`에 네 개를 더했다: `EMBED_FAILED`·`RERANK_FAILED` 값은 계약을 통과하고, 다른 코드는 실패한다. 나머지 행은 계약 케이스와 일부러 틀린 가짜로 모두 덮여 있다.

## Plan Change Log

## Review Triage Log

### Pass 1 (2026-10-13, lens: quick) — high 0 / medium 1 / low 5 / false 2 / maybe-false 0 / AC 3개 모두 충족

| # | 발견 | 판정 | 경로 | 증거 |
| --- | --- | --- | --- | --- |
| 1 | `testing/assert.ts` `deepEqual`이 Invalid Date 둘을 다르다고 본다 | low | patch | 코드 확인: Date 분기가 `getTime() === getTime()`(NaN≠NaN). number 분기와 맞추는 한 줄 수정 |
| 2 | `memoryParser`가 해석 안 되는 `occurredAt`·중복 harness id를 `ok:true`로 낸다 | low | 거절 | 사실이나 가짜는 저장소 안 fixture로만 쓰이고 일상에서 만나기 어렵다. 수정은 검증 분기 추가 |
| 3 | 세션 계약의 "immutable columns" 케이스가 두 번째 `ensureSession`을 부르지 않아 불변을 검사하지 않는다 | medium | patch | 리뷰어가 두 번째 호출에서 userId 등을 바꾸는 가짜로 전 케이스 통과를 재현. epic 2의 `ON CONFLICT DO UPDATE` 실수를 못 잡는다. 케이스 안에서 두 번째 호출과 비교만 더한다 |
| 4 | embedder 계약 "same way twice"가 폭만 비교한다(이름이 결정성을 약속) | low | patch | 코드 확인. 원격 임베딩은 비트 단위 결정성을 보장하지 않으므로 검사는 두고 이름만 바꾼다 |
| 5 | `memoryStore.ingest`가 두 UNIQUE 키를 `\|\|`로 합쳐, 같은 seq·다른 harness id 메시지를 삽입 0으로 조용히 버린다 | low | 거절 | 사실. 다만 같은 세션의 seq 충돌 처리(compact 후 재수집 포함)는 epic 2의 설계 몫이고(Done when 2), 수정에 새 실패 코드(공개 표면)가 필요하다. epic 2 인셉션에서 다룰 것으로 사용자에게 알림 |
| 6 | postgres 테스트의 hook을 파일 범위로 올려 닫힌 포트 테스트까지 DB를 요구한다 | low | patch | 리뷰어 재현: 변수 없이 8개 모두 skip. hook을 live-DB 두 블록을 감싸는 describe로 옮기는 단순 재배치 |
| 7 | reranker 계약이 `ranking: []`(문서 누락)을 허용한다 | false | 거절 | port 주석이 "at most once"로 부분집합(top-k)을 명시하고, I/O 표도 "범위 안·중복 없음"만 요구한다. 의도된 계약 |
| 8 | `ChunkParams` 세 필드 이름이 문서에 없고 Implementation Notes에도 빠졌다 | low | 거절 | 사실이나 수정이 이 플랜 편집이다. story 3이 SQL 이름을 정할 때 맞춘다(Design Notes) |
| 9 | core의 `export *`가 second_brain의 다중 `export *`에서 이름 충돌을 조용히 뺀다 | false | 거절 | TypeScript는 `export *` 이름 충돌을 TS2308 오류로 재export 지점에서 보고한다. 조용히 빠지지 않는다 |

경로 요약: intent_gap 0, bad_plan 0, patch 4(1·3·4·6), defer 0, 거절 5(2·5·7·8·9).

패치 4건 적용 후 재검증(2026-10-13): build 정상, `pnpm test` 7개 파일 101개 통과(실제 DB), `@second-brain/core/testing` import exit 0(42 export), `compose down` 뒤 `dist/`·`node_modules/` 없음.

## Design Notes

- 계약을 데이터로 두는 이유: core는 vitest를 의존할 수 없다(AD-1). 각 adapter 테스트가 케이스를 자기 러너에 꽂는다.
  ```ts
  import { sessionStoreContract } from '@second-brain/core/testing';
  for (const c of sessionStoreContract()) it(c.name, () => c.run(makeStore));
  ```
  `makeStore`는 케이스마다 새 subject를 주는 async factory, `run`은 위반 시 Error를 던진다.
- Store를 쪼개는 이유: postgres가 세션 테이블(story 3) 없이 넓은 `Store`를 반환하려면 스텁이 필요하다. 합성 타입이면 epic 2가 `SessionStore`를 구현하는 순간 `Store` 계약 전체를 통과한다(AD-10 "모든 구현은 하나의 공통 계약").
- `ensureSession`은 호출자가 만든 id를 제안으로 받는다(AD-8: ID는 생성하는 쪽이 정함). 이미 있으면 기존 행을 돌려준다. 그래서 Store는 IdGen을 모른다.
- 도메인 타입은 story 3의 SQL과 함께 진화한다. story 3이 컬럼을 더하면 같은 이름을 타입에 맞춘다(Table Contract가 키·작성자·변경 가능성만 고정).

## Verification

**Commands:**
- `npx -y pnpm@12.10.1 install && npx -y pnpm@12.10.1 build` -- expected: TS 오류 없음, `packages/core/dist/testing/index.js` 존재
- `docker compose -f compose.test.yaml up -d --wait && BRAIN_TEST_DATABASE_URL=postgres://postgres:postgres@localhost:54329/postgres npx -y pnpm@12.10.1 test` -- expected: 전 프로젝트 통과. 끝나면 `docker compose -f compose.test.yaml down`
- `node -e "import('@second-brain/core/testing')"`을 `packages/postgres`에서 실행 -- expected: exit 0
- `git status --short` -- expected: `dist/`·`node_modules/` 없음
