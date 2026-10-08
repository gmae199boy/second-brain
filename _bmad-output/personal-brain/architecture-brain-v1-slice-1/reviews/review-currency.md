---
name: 'review-currency — Personal Brain V1 slice 1'
lens: 'currency / reality-check (버전·존재·의존 동작의 실측 확인)'
target: ../architecture-brain-v1-slice-1.md
reviewed: '2026-10-08'
method: 'npm registry(npm view·npm pack로 실제 tarball 확인), registry.npmjs.org HTTP, Docker Hub API, GitHub API, nodejs.org/dist·nodejs/Release schedule.json, code.claude.com/docs/en/hooks.md 원문(250,548자) 전량 grep, postgresql.org 공식 문서'
verdict: '전원 최신 확인. 치명 1건(패키지 이름 발행 불가 가능성 높음), 중대 1건(pgvector/kysely의 pnpm 해결 실패), 경고 3건'
---

# Currency Review — Personal Brain V1 slice 1

## 요약

Stack 표의 **15개 항목 전부가 2026-10-08 현재 실제로 존재하고 latest이며**, 명시된 용도에 맞다. 버전 숫자를 상상한 흔적은 없다. memlog의 `(version)` 줄들이 실제 검증 기록과 일치한다.

다만 **문서에 적히지 않은 전제 3개가 틀렸거나 위험하다**:

| # | 항목 | 판정 | 심각도 |
| --- | --- | --- | --- |
| C-1 | npm 이름 `second_brain` 발행 가능성 | **wrong (발행 거부 가능성 높음)** | 치명 — AD-2·AD-19의 설치 경로가 성립하지 않음 |
| C-2 | `pgvector/kysely`를 pnpm workspace에서 import | **wrong (런타임 해결 실패)** | 중대 — Stack 표의 조합이 그대로는 안 돌아감 |
| C-3 | AD-6의 `SessionEnd (async)` 생존 | **unverifiable (문서에 보장 없음)** | 경고 — 마지막 수집·색인이 유실될 수 있음 |
| C-4 | pg_trgm 한국어 1~2음절 검색 | **confirmed as limit (AD-15가 미기술)** | 경고 — "기본 검색은 pg_trgm" 한 줄로는 부족 |
| C-5 | Node 24의 LTS 상태 | **confirmed (단 12일 뒤 Maintenance)** | 경고 — 표의 "24 LTS"가 2026-10-20부터 Active가 아님 |
| C-6 | `additionalContext`·`systemMessage` 10,000자 상한 | **confirmed (새 제약, 미기술)** | 정보 — 시작 맥락 설계에 상한이 있음 |

---

## 1. Stack 표 버전 — 전부 confirmed

2026-10-08 `npm view <pkg> version dist-tags time.modified`로 확인. 모두 `dist-tags.latest`와 일치.

| Stack 표 기재 | 실측 | 판정 | 출처 |
| --- | --- | --- | --- |
| Node.js 24 LTS (24.21.0) | v24.21.0 (2026-09-07), `lts: "Krypton"` | confirmed (C-5 주의) | https://nodejs.org/dist/index.json |
| TypeScript 7.0.2 | latest=7.0.2 (2026-10-07), next=7.1.0-dev | confirmed | https://www.npmjs.com/package/typescript |
| pnpm 12.10.1 | latest=12.10.1 (2026-10-07) | confirmed | https://www.npmjs.com/package/pnpm |
| PostgreSQL 18 | 현재 안정판 메이저 18 (minor 18.6), 19는 Beta 4 | confirmed | https://www.postgresql.org/support/versioning/ |
| pgvector 0.8.7 | 최신 태그 `v0.8.7` (그 다음이 v0.8.6) | confirmed | https://api.github.com/repos/pgvector/pgvector/tags |
| `pgvector/pgvector:pg18` | 태그 존재, amd64+arm64, last_pushed 2026-10-01 | confirmed | https://hub.docker.com/v2/repositories/pgvector/pgvector/tags/pg18 |
| Kysely 0.29.6 | latest=0.29.6 (2026-09-16) | confirmed | https://www.npmjs.com/package/kysely |
| `pg` 8.23.1 | latest=8.23.1 (2026-09-30) | confirmed | https://www.npmjs.com/package/pg |
| pgvector (npm) 0.3.0 | latest=0.3.0 (2026-05-31) | confirmed (C-2 주의) | https://www.npmjs.com/package/pgvector |
| commander 15.0.0 | latest=15.0.0 (2026-09-02) | confirmed | https://www.npmjs.com/package/commander |
| @clack/prompts 1.8.1 | latest=1.8.1 (2026-09-13) | confirmed | https://www.npmjs.com/package/@clack/prompts |
| smol-toml 1.9.0 | latest=1.9.0 (2026-09-22) | confirmed | https://www.npmjs.com/package/smol-toml |
| uuid 14.0.2 | latest=14.0.2 (2026-08-18) | confirmed | https://www.npmjs.com/package/uuid |
| tsdown 0.23.0 | latest=0.23.0 (2026-09-03) | confirmed | https://www.npmjs.com/package/tsdown |
| vitest 5.0.3 | latest=5.0.3 (2026-09-30) | confirmed | https://www.npmjs.com/package/vitest |
| Model Studio `qwen3.7-text-embedding`(1024) / `qwen3-rerank` | 두 모델 모두 실재. 임베딩 출력 차원 2560/2048/1536/**1024(기본)**/768/512/256, `dimensions` 파라미터로 선택. rerank는 OpenAI 호환 인터페이스로 제공 | confirmed | https://help.aliyun.com/zh/model-studio/text-embedding-synchronous-api · https://www.alibabacloud.com/help/en/model-studio/rerank |

보강 사실(표에 적을 가치):

- **tsdown 0.23.0 `engines`: `^22.18.0 || ^24.11.0 || >=26.0.0`** — Node 24 계열은 **24.11.0 이상**만 허용. 24.21.0은 충족하지만, "Node 24"만 적어 두면 24.10 이하에서 설치가 막힌다.
- **vitest 5.0.3 `engines`: `^22.12.0 || ^24.0.0 || >=26.0.0`**, peer `vite ^6.4.0 || ^7 || ^8`. Vite 메이저가 Stack 표에 없다 — vitest가 vite를 끌고 오므로 고정 대상이다.
- **Kysely·pgvector(npm)·pg 모두 `engines.node >= 22`** — Node 24 요구는 tsdown·vitest 쪽에서 온다.

## 2. TypeScript 7.0.2 — 네이티브(Go) 컴파일러인가, 빌드 체인과 맞는가

- **confirmed: 7.0.2는 Go 재작성 컴파일러의 첫 안정 메이저.** 프리뷰 기간의 `tsgo`(`@typescript/native-preview`)가 7.0부터 기본 `tsc`가 됐고, 보통 전체 빌드 8~12배. 구 JS 컴파일러가 필요한 팀용 호환 패키지 `@typescript/typescript6`(현재 6.0.2, `tsc6` 진입점)가 별도로 발행돼 있다 — 실제로 존재함을 npm에서 확인했다.
  - 출처: https://devclass.com/development/2026/07/10/speedier-type-checks-in-typescript-70-as-first-stable-go-release-ships/ · https://www.npmjs.com/package/@typescript/typescript6
- **confirmed: tsdown 0.23 / vitest 5와 알려진 비호환 없음.**
  - tsdown 0.23.0 `peerDependencies.typescript`: **`^5.0.0 || ^6.0.0 || ^7.0.0`** — TS 7 명시 지원.
  - 그 안의 d.ts 생성기 `rolldown-plugin-dts`(0.28.x) `peerDependencies.typescript`: **`^5.0.0 || ^6.0.0 || ~7.0.0`**.
  - vitest 5.0.3은 typescript를 peer로 선언하지 않는다(변환은 vite/rolldown, 타입 체크는 `vitest --typecheck`가 별도 tsc 호출). TS 7 때문에 막힐 지점이 구조적으로 없다.
  - 결정적 교차 증거: **Kysely 0.29.6 자신의 devDependencies가 `typescript: "7.0.2"` + `pg: "8.23.0"`** 이다. Stack 표의 조합이 Kysely CI에서 그대로 돌고 있다는 뜻.
  - 출처: `npm view tsdown@0.23.0 peerDependencies` · `npm view rolldown-plugin-dts peerDependencies` · https://raw.githubusercontent.com/kysely-org/kysely/master/package.json
- **주의 (경고, pnpm 특이)**: `rolldown-plugin-dts`의 범위는 `~7.0.0`(^가 아니다). **TS 7.1이 나오면 이 peer가 깨져** pnpm의 엄격한 peer 경고/`ERR_PNPM_PEER_DEP_ISSUES`를 유발할 수 있다. TS는 `typescript: "7.0.x"`로 묶거나, `pnpm.peerDependencyRules`를 미리 둘 것.
- **주의 (정보)**: TS 7.0에는 **안정 programmatic compiler API가 없다**(Microsoft: "TypeScript 7.1 이후"). slice 1은 tsc/tsdown만 쓰므로 영향 없지만, 나중에 TS API로 코드 분석기를 붙일 계획이 생기면 그때 막힌다.

## 3. Kysely + `pg` 8.x, 그리고 `pgvector/kysely`

### 3-1. Kysely PostgresDialect ↔ `pg` 8.x — confirmed

- `PostgresDialect`는 `PostgresDialectConfig`를 받고, `pool`에 **`pg`의 `new Pool({...})` 인스턴스**(또는 Pool을 돌려주는 async 함수 — 첫 사용까지 연결을 늦출 수 있어 AD-3 "import 부작용 없음"에 유리)를 넘긴다. Kysely는 `pg`를 자기 dependency로 갖지 않는다 → **쓰는 쪽이 `pg`를 직접 설치**해야 한다(AD-1의 "adapter만 자기 제품을 안다"와 정합).
- 버전 적합성: Kysely 0.29.6 devDeps가 `pg 8.23.0` / `@types/pg 8.23.1`. 표의 `8.23.1`과 동일 라인.
- 출처: https://github.com/kysely-org/kysely/blob/master/src/dialect/postgres/postgres-dialect.ts

### 3-2. pgvector npm 0.3.0이 `pgvector/kysely`를 export하는가 — confirmed, 단 **C-2(wrong)**

- `exports` 맵에 `"./kysely": { types: "./types/kysely/index.d.ts", default: "./src/kysely/index.js" }` 존재. tarball을 직접 풀어 `l2Distance`/`cosineDistance`/`maxInnerProduct`/`l1Distance`/`hammingDistance`/`jaccardDistance` + `fromSql`/`toSql` 구현을 확인했다. devDeps는 `kysely: "^0.29.2"`, `pg: "^8.6.0"` — 0.29.6/8.23.1과 맞다.
- **문제**: `src/kysely/index.js`의 첫 줄이 `import { sql } from 'kysely';` 인데, **pgvector 0.3.0의 package.json에는 `dependencies`도 `peerDependencies`도 아예 없다**(키 목록: authors, description, devDependencies, engines, exports, files, homepage, license, name, repository, scripts, type, version).
  - pnpm은 기본적으로 isolated node_modules다. `node_modules/.pnpm/pgvector@0.3.0/node_modules/`에는 pgvector 자신만 있으므로, 그 안에서의 bare `kysely` import는 **해결되지 않는다**(`ERR_MODULE_NOT_FOUND`). npm/yarn의 호이스팅에서는 우연히 동작하므로 "npm에서는 되는데 pnpm에서만 깨지는" 형태로 나타난다. 같은 구조가 `pgvector/pg`, `pgvector/knex` 등 모든 프레임워크 subpath에 동일하게 적용된다.
  - **대응(권고 순)**: (a) 헬퍼 6개가 전부 한 줄짜리 `sql` 템플릿이므로 `packages/postgres` 안에 직접 쓰고 pgvector npm 의존을 **버린다** — 의존 하나가 사라지고 AD-1의 "adapter는 core + 자기 제품 하나"에도 더 맞다. (b) 유지하려면 `.npmrc`에 `public-hoist-pattern[]=kysely` 또는 `pnpm.peerDependencyRules`/`dependenciesMeta` 보정을 명시하고, 그 사실을 Stack 표 각주로 남긴다. (c) 어차피 임베딩은 slice 1 기본 꺼짐(AD-15)이므로 이 의존을 slice 1에서 **빼는 것**도 선택지.
- 출처: `npm pack pgvector@0.3.0` 후 `package/src/kysely/index.js`·`package/package.json` 직접 확인 · https://github.com/pgvector/pgvector-node

## 4. pgvector 0.8.7 / HNSW 한계 / Docker 태그

| 주장 | 판정 | 실측 |
| --- | --- | --- |
| pgvector 0.8.7이 최신 | confirmed | 최신 태그 `v0.8.7`. (GitHub Releases 목록은 비어 있고 태그로만 관리) |
| HNSW `vector` 2,000차원 | confirmed | README: "HNSW … `vector` - up to 2,000 dimensions" |
| HNSW `halfvec` 4,000차원 | confirmed | README: "`halfvec` - up to 4,000 dimensions" |
| (AD-15의 "2,000 초과는 halfvec") | confirmed | IVFFlat도 동일한 2,000/4,000. 타입 자체 상한은 둘 다 16,000차원이라 **인덱스 한계가 진짜 제약**이라는 AD-15의 표현이 정확하다 |
| `pgvector/pgvector:pg18` 이미지 태그 | confirmed | Docker Hub에 존재, linux/amd64·arm64, 2026-10-01 push |
| 쓰려는 차원 1024 | confirmed, 안전 | 1024 < 2000 → 평범한 `vector(1024)` + HNSW로 충분. halfvec는 2560을 쓸 때만 필요(qwen3.7 최대 2560) |

출처: https://github.com/pgvector/pgvector#indexing · https://hub.docker.com/r/pgvector/pgvector/tags

## 5. Claude Code hooks — AD-6·AD-9가 의존하는 동작

`code.claude.com/docs/en/hooks.md` 원문 250,548자를 내려받아 전량 확인했다(WebFetch 요약이 아님).

| 주장 | 판정 | 근거(문서 원문) |
| --- | --- | --- |
| SessionStart `additionalContext` | **confirmed** | SessionStart decision control 표: "`additionalContext` \| String added to Claude's context at the start of the conversation, before the first prompt." plain stdout도 그대로 컨텍스트에 들어가므로 맥락만 넣을 때는 JSON을 만들 필요가 없다 |
| `systemMessage` 출력 필드 | **confirmed (단서 있음)** | JSON output 표: "`systemMessage` \| none \| Warning message shown to the user." 범용 필드이고, **버리는 이벤트는 각 이벤트 절에 명시**된다. SessionStart 절에는 버린다는 문장이 없고, 오히려 resume 비용을 "예를 들어 `systemMessage`로" 알리라고 안내한다 → **AD-9의 "시작 hook이 사용자에게 `systemMessage`로 보인다"는 맞다** |
| `CLAUDE_ENV_FILE` | **confirmed** | "SessionStart hooks have access to the `CLAUDE_ENV_FILE` environment variable, which provides a file path where you can persist environment variables for subsequent Bash commands." `>>`로 `export …` 추가. 접근 가능 이벤트는 SessionStart·Setup·CwdChanged·FileChanged뿐 |
| Stop이 턴마다 | **confirmed** | 수명 주기: "per turn: `UserPromptSubmit`, `Stop`". Stop 절: "Runs when the main Claude Code agent has finished responding." 단서 2개 — **사용자 인터럽트로 멈추면 실행되지 않음**, **API 오류면 Stop 대신 StopFailure** |
| command hook `async: true` | **confirmed** | "Add `"async": true` to a command hook's configuration… This field is only available on `type: "command"` hooks." + "Claude Code doesn't enforce `timeout` on it" |
| SessionEnd 존재 | **confirmed** | "Runs when a Claude Code session ends." matcher: `clear`·`resume`·`logout`·`prompt_input_exit`·`other`(`bypass_permissions_disabled`는 v2.1.234에서 제거). "They can't block session termination" |
| (AD-6 서술의 기본 timeout 600s) | **confirmed, 단 SessionEnd는 예외** | "Defaults: 600 for `command`, `http`, `mcp_tool`… **`SessionEnd` hooks share a 1.5-second budget**; if your settings set a longer per-hook `timeout`, Claude Code raises the budget to match, **up to 60 seconds**." 또는 `CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS` |

### AD-6·AD-9에 영향을 주는, 문서에서 새로 확인된 제약

1. **C-3 (경고) — async SessionEnd가 끝까지 살아남는다는 보장이 문서에 없다.** 문서는 "Claude Code delivers an async hook's results **only while the session runs**"이라 하고, 비차단 종료에 대해서는 `-p` 경우만 명시한다: "In non-interactive mode with the `-p` flag, Claude Code **kills any async hook still running at teardown** and finalizes it with outcome `cancelled`" / "If your hook's work must outlive a `claude -p` session, **start a fully detached process from it**". 대화형 종료 시 async 자식 프로세스의 생존은 **명시되지 않았다**. AD-6은 `SessionEnd (async) → 마지막 수집 + 색인`을 거기에 걸고 있다.
   - 권고: SessionEnd 경로는 (a) 완전 분리된(detached, `setsid`/`disown`급) 프로세스를 띄우거나, (b) 거기서 끝내지 않고 **다음 세션의 drain이 반드시 복구**한다는 점을 AD-7에 못 박거나(현재 AD-7의 "미색인 세션"이 이미 그 역할을 하므로 **AD-6에 '최선 노력(best-effort)'임을 명시하는 것으로 충분**), (c) 동기 SessionEnd로 두고 `timeout`을 올려 짧게 끝낸다. 지금 문서는 (b)가 성립함을 독자가 추론해야 한다.
2. **SessionEnd는 JSON 출력 자체를 버린다.** "Claude Code discards their JSON output fields, such as `systemMessage`." → SessionEnd에서 사용자에게 알리는 설계는 불가능. AD-9가 SessionEnd 알림을 요구하지 않으니 정합하지만("턴 수집 실패는 화면에 띄우지 않는다"), 의도적 결과임을 적어 둘 가치가 있다.
3. **async hook의 `additionalContext`·`systemMessage`는 사용자에게 보이지 않는다.** "After the background process exits, Claude Code delivers the `additionalContext` and `systemMessage` fields… to Claude on the next conversation turn. **Unlike a synchronous hook's `systemMessage`, neither field is shown to you.**" → AD-9의 "사용자에게 보인다"가 성립하는 것은 **동기 SessionStart 한 곳뿐**이다. AD-9를 그대로 읽으면 맞지만, 이 비대칭은 쉽게 잘못 구현된다.
4. **C-6 (정보) — 10,000자 상한.** "A hook's `additionalContext`, `systemMessage`, and `initialUserMessage` strings, and its plain stdout, are capped at 10,000 characters." → **AD-6의 시작 맥락(오늘 날짜+시간대+켜진 규칙+최근 로그)에 하드 상한이 있다.** 켜진 규칙이 늘어날 때 무엇을 잘라낼지는 설계 결정이고 지금 문서에 없다.
5. **async hook은 중복 제거가 없다.** "Each execution creates a separate background process. There is no deduplication across multiple firings of the same async hook." → **AD-7의 "모든 백그라운드 작업은 멱등이고 동시 실행을 전제하며 `FOR UPDATE SKIP LOCKED`로 claim" 이 선택이 아니라 필수임을 문서가 확증한다.** (설계가 옳았음)
6. **Stop에서의 exit 2는 턴을 계속시킨다**("Prevents Claude from stopping, continues the conversation", 연속 8회 상한). → Conventions의 "hook 경로에서 항상 exit 0" 이 단순 위생이 아니라 **오동작 방지 장치**다. 역시 확증.
7. **대화형 실행에서 SessionStart hook은 이미 백그라운드로 돈다**: "When you start an interactive session… SessionStart hooks run in the background. You can type right away… Claude's first response still waits for the hooks to finish." AD-6의 "SessionStart(동기, 짧은 timeout)"은 **"Claude의 첫 응답을 막는다"는 의미에서만 동기**다. 사용자 입력은 막지 않는다 → 1초 목표의 대상이 무엇인지 더 정확히 쓸 수 있다.
8. SessionStart/Setup은 `command`·`mcp_tool`만 지원(`http`·`prompt`·`agent` 불가), SessionEnd는 `command`·`http`·`mcp_tool` 지원 → **AD-19가 등록할 hook 타입(command, 절대 경로)은 양쪽 모두에서 유효**.

출처: https://code.claude.com/docs/en/hooks (원문 `https://code.claude.com/docs/en/hooks.md`)

## 6. npm 패키지 이름 `second_brain` — **C-1 (wrong)**

| 하위 주장 | 판정 | 근거 |
| --- | --- | --- |
| 밑줄이 들어간 이름은 npm에서 유효하다 | **confirmed** | `validate-npm-package-name`을 실제로 실행: `second_brain` → `{validForNewPackages: true, validForOldPackages: true}`. README가 **`under_score`를 유효 예시로 명시**. 금지는 "**시작**이 `.`/`_`"일 때뿐(`_second` → "name cannot start with an underscore") |
| 이름이 비어 있다(선점되지 않았다) | **confirmed** | `GET https://registry.npmjs.org/second_brain` → **404 `{"error":"Not found"}"` |
| 따라서 발행 가능하다 | **wrong (거부 가능성 높음)** | `GET https://registry.npmjs.org/second-brain` → **200, `second-brain@0.0.1` (2022-05-17 발행, 현존)**. npm의 moniker 규칙은 **구두점만 다른 이름을 금지**한다: "publishing a package that differs from an existing one only in punctuation is no longer allowed" — 예시가 정확히 이 형태다. `jsonstream`이 있으면 `json-stream`·`json.stream`·**`json_stream`** 전부 막힌다. `second-brain`이 있으므로 `second_brain`은 같은 규칙에 걸린다 |
| (추가) 로컬 사전 검사로는 안 걸러진다 | 확인 | 이 유사도 검사는 **발행 시 서버 측 PUT에서만** 돈다. `npm view`가 404를 주고 `npm publish --dry-run`이 통과해도 실제 발행이 403 "Package name too similar to existing package …; try renaming your package to '@scope/name'"로 거부된 보고가 있다 |

- **영향**: AD-2("npm에 배포하는 것은 `second_brain` 하나다"), AD-19("설치는 `npx second_brain@latest`"), Structural Seed의 `packages/second_brain/`, AD-9/AD-18의 `~/.second_brain/` 경로가 모두 이 이름에 얹혀 있다. 발행이 막히면 **설치 경로 문장 하나가 아니라 AD-2·AD-19와 사용 예시(`from "second_brain"`)가 같이 흔들린다.**
- **대응**: (a) 발행 전에 **실제 `npm publish`로 이름을 먼저 잡아 본다**(빈 0.0.0 발행 → 사전 검사로는 알 수 없으므로 이것만이 확실한 검증). (b) 막히면 구두점 변형이 아닌 **다른 단어**로 간다(`node-ssg`→`pajama-ssg` 식). (c) 또는 npm이 직접 권하는 우회인 **scope**로 간다(`@<user>/second-brain`, `npx @<user>/second-brain@latest`). 디스크 경로 `~/.second_brain/`과 import 이름은 패키지 이름과 분리해도 되지만, 지금 문서는 셋을 한 단어로 묶어 두었다.
- 출처: https://blog.npmjs.org/post/168978377570/new-package-moniker-rules · https://github.com/npm/validate-npm-package-name#naming-rules · https://registry.npmjs.org/second-brain · https://registry.npmjs.org/second_brain

### "npm scope는 밑줄을 쓸 수 없다" — **unverifiable**

AD-2가 `second_brain`을 unscoped로 가는 이유로 "npm scope 이름 제약"을 든다. 확인 결과:

- `validate-npm-package-name('@second_brain/core')` → **`validForNewPackages: true`** (즉 라이브러리 차원에서는 금지되지 않는다).
- npm 공식 문서 "Creating an organization"에는 **허용 문자 규칙이 전혀 적혀 있지 않다**("Your organization name will also be your organization scope."가 유일한 관련 문장). 조직 이름 문자 규칙에 대한 1차 출처를 찾지 못했다.
- 정황 증거: registry 검색에서 **밑줄이 든 scope를 하나도 찾지 못했다**(`@tensorflow_models/*` 등 임의 probe 모두 404, 검색 API 결과 0건). 관행상 없다는 것까지가 말할 수 있는 한계다.
- **그래서**: 이 전제는 참일 수도 있으나 **문서화된 근거가 없다**. 그리고 **의미가 없다** — 내부 패키지는 workspace 비공개(AD-2)라 발행되지 않으므로 scope 문자 규칙과 무관하고, 반대로 C-1의 유사 이름 차단에 대해 npm이 직접 권하는 해결책이 **scope**다. AD-2의 "Prevents: … npm scope 이름 제약"은 **근거가 뒤집힌 문장**이므로 지우거나 "공개 표면을 하나로 묶는다"만 남길 것을 권한다.
- 출처: https://docs.npmjs.com/creating-an-organization · https://github.com/npm/validate-npm-package-name

## 7. pg_trgm과 한국어 부분문자열 검색 — **C-4**

AD-15의 "기본 검색은 키워드(Postgres `pg_trgm`)다" 한 줄이 한국어에서 무엇을 뜻하는지, 공식 문서로 확인했다.

**confirmed 사실(PostgreSQL 18 공식 문서 원문)**

- "A trigram is a group of three consecutive characters taken from a string." — **3문자 단위**.
- "`pg_trgm` ignores non-word characters (non-alphanumerics) when extracting trigrams… Each word is considered to have two spaces prefixed and one space suffixed… the set of trigrams in the string `cat` is `  c`, ` ca`, `cat`, `at `." — 패딩 덕에 3자 미만 단어도 trigram은 생기지만 **그 수가 극히 적다**.
- GIN/GiST는 `LIKE`·`ILIKE`·`~`·`~*`·`=`와 유사도 연산자를 지원한다. 그리고 결정적으로: "**The index search works by extracting trigrams from the search string and then looking these up in the index. The more trigrams in the search string, the more effective the index search is.**"
- **GIN은 거리(KNN) 정렬을 못 한다**: `<->`/`<<->`/`<<<->`에 대해 "This can be implemented quite efficiently by **GiST** indexes, **but not by GIN** indexes."
- 기본 임계값: `pg_trgm.similarity_threshold` **0.3**(`%`), `word_similarity_threshold` 0.6, `strict_word_similarity_threshold` 0.5.

**한국어에서 뜻하는 것(판정: 한계가 실재함 → AD-15가 이를 말하지 않음)**

1. **1~2음절 질의는 인덱스를 거의 못 쓴다.** 한글은 음절 1자 = 1문자이므로 "회의", "결정" 같은 2음절 검색어의 trigram은 패딩 조각 몇 개뿐이다. CJK에 대한 pgsql-hackers 논의가 같은 지점을 명시한다: 일본어에서 2문자 검색이 흔한데 "since pg_trgm is 3-gram, you basically would not be able to use index for such text search", 그리고 인덱스를 타더라도 "bitmap index scan picks up all rows, so it's too slow". 한국어도 구조가 같다.
2. **`similarity()`/`%`는 짧은 한국어 질의에 특히 둔하다.** 임계 0.3은 "질의 trigram ∩ 문서 trigram" 비율 기준인데, 긴 대화 원문과 2음절 질의의 유사도는 0에 가깝다. 즉 **`%`(유사도)는 "오타 허용 근사 검색"용이고, 우리가 원하는 "원문 안에 그 말이 나왔나"는 `ILIKE '%…%'` + `gin_trgm_ops` 쪽**이다. AD-15는 둘 중 어느 것인지 말하지 않는다 — 이게 가장 실질적인 미기술 지점이다.
3. **"유사도 순 정렬"은 GIN으로 불가능하다.** `ORDER BY col <-> '질의'`를 쓰려면 GiST여야 하고, GIN으로 하면 전체 정렬이 된다. recall 결과 랭킹을 유사도로 매길 계획이면 인덱스 종류 선택이 이미 결정되어 있어야 한다.
4. **형태 정규화가 없다.** pg_trgm은 FTS가 아니다(스테밍·불용어·언어 인식 없음). 한국어 조사·어미가 붙은 형태("결정했다", "결정은")는 정규화되지 않는다. 다만 부분문자열 매칭이라 어간 2~3음절이 들어가면 걸린다 — 오히려 FTS보다 한국어에 유리한 면이다.
5. **PG18 collation 주의**: PostgreSQL 18에서 기본 provider가 libc가 아닌 클러스터는 `LC_CTYPE` 동작이 달라질 수 있고, `pg_upgrade` 후 FTS·pg_trgm 인덱스는 **재색인**해야 한다. 설치기가 Docker 이미지를 새로 띄우는 slice 1에서는 당장 문제 없지만 Conventions의 "마이그레이션은 앞으로만" 과 함께 기억할 사항.

**권고(판단은 작성자 몫)**

- AD-15에 한 줄 추가: **"기본 검색은 `ILIKE` + `gin_trgm_ops` 부분문자열 매칭이고, 2음절 이하 질의는 인덱스가 듣지 않아 순차 탐색으로 떨어진다."** 규모 시험 수치(세션 226개, 540만 자)에서 순차 `ILIKE` 전체 탐색은 로컬 Postgres에서 수십 ms 수준이므로 **개인 1대 규모에서는 이 저하가 수용 가능**하다 — 그렇게 쓰면 "지금은 괜찮고 왜 괜찮은지"가 남는다.
- 대안으로 흔히 거론되는 `pg_bigm`(2-gram)은 실재하고 최신 태그가 `v1.2-20250903`(2025-09)인데, **PG18 지원 여부를 확인하지 못했고** 쓰려면 `pgvector/pgvector:pg18` 공식 이미지를 버리고 커스텀 이미지를 빌드해야 한다(AD-19의 "Docker는 설치하지 않는다"와는 무관하나 설치기 기본값이 깨진다). **slice 1에서는 채택 비권고, Deferred 표에 한 줄로 남길 후보.**
- memlog에는 "키워드 기본(Postgres pg_trgm **+ 미러 grep**)"으로 적혀 있는데 spine의 AD-15에서는 미러 grep이 빠졌다. **한국어 짧은 질의에 대한 실질적 대비책이 바로 그 미러 grep**(AD-16)이므로, AD-15가 AD-16을 검색 경로로 명시적으로 참조하는 편이 낫다.
- 출처: https://www.postgresql.org/docs/18/pgtrgm.html · https://www.postgresql.org/message-id/CAHGQGwHMru9oYhcPSHr39tU_cnggw7%2BkX8BJjh6yT4o4_DB2GQ%40mail.gmail.com · https://github.com/pgbigm/pg_bigm/tags

## 8. Node 24의 LTS 상태 — **C-5 (confirmed, 단 시한부)**

`nodejs/Release`의 `schedule.json` 실측:

```
v24: start 2025-05-06, lts 2025-10-28, maintenance 2026-10-20, end 2028-04-30, codename Krypton
v26: start 2026-05-05, lts 2026-10-28,  maintenance 2027-10-20, end 2029-04-30
```

- **오늘(2026-10-08) 기준 Node 24는 Active LTS(Krypton)이고 최신 릴리스는 24.21.0** — Stack 표가 맞다.
- 그러나 **2026-10-20에 Node 24가 Maintenance LTS로 내려가고, 2026-10-28에 Node 26이 Active LTS가 된다.** 즉 이 문서가 구현에 들어가는 시점에는 "24 LTS"가 **Active가 아닌 Maintenance LTS**다(지원은 2028-04-30까지 계속).
- 권고: 표를 "Node.js 24 (Maintenance LTS, 2028-04 EOL) — 개발 기준선, 26이 LTS가 되면 재검토" 로 쓰거나, 처음부터 **26 LTS(2026-10-28)** 를 겨냥할지 결정할 것. 도구 쪽은 둘 다 받는다(tsdown `>=26.0.0`, vitest `>=26.0.0` 모두 허용).
- 출처: https://github.com/nodejs/Release/blob/main/schedule.json · https://nodejs.org/en/about/previous-releases

## 9. 교차 확인: "상상한 기술"은 없었나

이름이 등장하는 기술 전부를 존재 여부로 훑었고, **실재하지 않거나 용도가 어긋난 것은 없었다**.

- `FOR UPDATE SKIP LOCKED` (AD-7): PostgreSQL 9.5+ 표준 기능, 18에서 유효. 작업 큐 claim의 정석 용법 — 적합.
- `timestamptz` (AD-13), UPDATE/DELETE 거부 **trigger** (AD-11): 둘 다 평범한 Postgres 기능. 단 trigger로 막는 것은 **테이블 소유자/슈퍼유저의 trigger 비활성화를 막지 못한다**(`ALTER TABLE … DISABLE TRIGGER`). "DB가 강제한다"는 표현의 강도는 그 수준임을 알고 쓰는 것이 좋다 — 코드 실수 방지라는 AD-11의 *Prevents*에는 충분하다.
- UUIDv7: `uuid@14.0.2`의 `dist/index.d.ts`에 `export { default as v7 } from './v7.js'` 실재 확인(tarball 직접 확인). Postgres `uuid` 타입에 그대로 들어간다. (참고: PostgreSQL 18에는 내장 `uuidv7()`도 있지만 AD-8이 "생성하는 쪽이 정한다"이므로 쓸 일이 없다 — 정합)
- `~/.second_brain/spool/*.jsonl` append-only(AD-9), Markdown 미러 단일 작성자(AD-16): 외부 의존 없음.
- `smol-toml`로 `config.toml`(AD-18): TOML 파서로 실재·유지보수 중.
- `@clack/prompts`로 대화형 설치기(AD-19): 실재·유지보수 중(1.8.1).

## 10. 조치 목록(우선순위 순)

1. **C-1**: `second_brain` 이름을 **실제 발행으로 먼저 확보**하고, 거부되면 AD-2·AD-19·Structural Seed·사용 예시(`from "second_brain"`)를 함께 고친다. 동시에 AD-2의 "npm scope 이름 제약" *Prevents* 문구를 삭제(근거 역전).
2. **C-2**: `pgvector` npm 의존을 버리고 거리 연산자 헬퍼를 `packages/postgres`에 직접 쓴다(또는 pnpm 호이스팅을 Stack 표 각주로 명시). 임베딩이 slice 1 기본 꺼짐이므로 비용이 거의 없다.
3. **C-3**: AD-6의 `SessionEnd (async)` 를 **최선 노력**으로 명시하고, 복구 책임이 AD-7의 drain에 있음을 한 줄로 연결한다(또는 detached 프로세스를 명시).
4. **C-4**: AD-15에 "`ILIKE` + `gin_trgm_ops`, 2음절 이하는 인덱스 미사용 → 순차 탐색(개인 규모에서 수용)" 과 AD-16 미러 grep 참조를 추가.
5. **C-5**: Stack 표의 Node 행을 "24 (2026-10-20부터 Maintenance LTS)" 로 정확히 하거나 26 LTS 기준선을 선택.
6. **C-6**: 시작 맥락에 10,000자 상한이 있음을 AD-6에 적고, 켜진 규칙이 많아질 때의 절단 규칙을 정한다.
7. (사소) tsdown의 `node ^24.11.0` 하한, vitest가 끌고 오는 Vite 메이저, `typescript` 7.0.x 고정(rolldown-plugin-dts의 `~7.0.0` peer) 를 Stack 표/각주에 반영.
