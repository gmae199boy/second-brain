---
title: 'FileStore 완성과 계약 테스트'
type: 'feature'
ticket: '3'
created: '2026-10-26'
status: 'built'
baseline_revision: '1cb1b9a65417b87bd61df45c308fd8f53833dff1'
route: 'full'
route_source: 'auto'
risk: 'medium'
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

**Problem:** 10.2가 `FileStore` port·fake·계약·로컬 구현을 얇게 만들었지만, 계약이 루트 탈출 경로 몇 개만 보고, 로컬 구현의 심볼릭 링크 거부는 하위 폴더 링크의 `get`·`delete`만 시험되며, 쓰다 죽어 남은 임시 파일과 사용자 원본(`external`) 위치의 locator 표현이 정해지지 않았다. 10.4(@파일 첨부)가 `external` 위치 행을 쓰려면 그 표현이 먼저 있어야 한다.

**Approach:** 코드 동작은 거의 그대로 두고 경계를 시험으로 고정한다. Core 도메인에 `external` 로컬 위치의 locator 코덱(홈 기준 `~/` 상대 경로, 절대 경로 저장 금지)을 더하고, 계약에 그 위치와 멱등·URL 사례를 더하며, 로컬 구현 시험에 파일 링크·폴더 링크를 통한 쓰기·삭제 거부, 남은 임시 파일, 권한을 더한다. 시험이 드러낸 결함만 고친다.

## Boundaries & Constraints

**Always:**
- **external locator 코덱(`packages/core/src/domain/file.ts`).** 순수 문자열 함수, `node:` import 없음, POSIX `/`만. `externalLocator(path, home): string | null` — 둘 다 `/`로 시작해야 하고, 경로를 정규화(빈·`.` 마디 버림, `..`은 한 마디 올림, 루트 위로 가면 null)한 뒤 `home`(끝 `/` 무시)의 **엄밀한** 하위일 때만 `~/` + 나머지 마디를 `/`로 이은 값. 홈 자체, 홈 밖(`/tmp/x`, `/Volumes/…`), 제어 문자(U+0000–U+001F, U+007F)가 든 경로는 null(호출자는 external 위치를 남기지 않는다). 유니코드 정규화는 하지 않는다. `isExternalLocator(locator): boolean` — `~/`로 시작하고 마디가 하나 이상, 빈·`.`·`..` 마디와 제어 문자가 없음. `externalPath(locator, home): string | null` — 문법이 맞으면 `home` + `/` + 나머지, 아니면 null. 왕복: `externalPath(externalLocator(p, h), h)`는 정규화된 `p`.
- 공개 export는 `domain/file.ts`의 `export *`로 이미 나간다(`domain/index.ts:94`). 새 이름이 `second_brain`에서 보이는지 시험으로 확인한다.
- **FileStore port 규칙은 그대로.** `get`·`exists`·`url`·`delete`는 `local`·`brain`·`isBrainLocator`이고 실제 경로(심볼릭 링크를 푼 경로)가 루트 안일 때만 받고 나머지는 `LOCATION_REFUSED`; `put`은 그런 위치를 못 만들면 `FILES_UNAVAILABLE`(`PutFileResult` 모양 그대로)이고 루트 밖에 아무것도 쓰지 않는다. `external` 위치는 이 port가 읽지도 쓰지도 지우지도 않는다(사용자 원본 읽기는 10.4가 정한다).
- **계약(`testing/contracts/file-store.ts`)에 더할 사례**(fake와 로컬이 함께 통과): `externalLocator`로 만든 `{ storeKind: 'local', ownership: 'external', locator: '~/…' }`와 같은 locator의 `brain` 소유 위치, `~/…`·절대 경로 locator가 모든 연산에서 `LOCATION_REFUSED`이고 먼저 넣은 블롭은 그대로; 같은 바이트를 세 번 넣어도 위치·해시·크기가 같고 `get` 바이트가 같음; `url`이 같은 위치에 두 번 같은 값.
- **로컬 시험(`apps/cli/test/file-store.test.ts`)에 더할 사례**: (1) 블롭 경로 자체가 루트 밖 파일을 가리키는 심볼릭 링크면 `get`·`exists`·`url`·`delete`는 `LOCATION_REFUSED`, 같은 바이트 `put`은 `FILES_UNAVAILABLE`이고 바깥 파일의 바이트·존재가 그대로; (2) 하위 폴더 링크가 밖을 가리킬 때 새 바이트 `put`이 `FILES_UNAVAILABLE`이고 바깥 폴더에 파일이 생기지 않음; (3) 블롭 폴더에 쓰다 남은 `.<uuid>.tmp`가 있어도 같은 바이트·다른 바이트 `put`·`get`이 정상이고, 그 임시 파일 이름을 locator로 준 위치는 `LOCATION_REFUSED`, `delete`가 그 파일을 건드리지 않음; (4) 이미 있는 루트(0700)·새 하위 폴더 0700·파일 0600(기존 시험 유지). 시험용 바이트는 중립 값.
- 결함을 고치면 `apps/cli/src/runtime/file-store.ts`의 기존 구조(생성자 I/O 없음, 임시 파일 `wx`·0600 → rename, `realpath` 조상 검사)를 유지한다.
- **문서.** 아키텍처 Table Contract의 `file_locations` 줄(`architecture-brain-v1-slice-1.md:453`)과 AD-23 둘째 항목에 "`external` 로컬 위치의 locator는 홈 기준 `~/` 상대 경로, 홈 밖 파일은 external 위치를 남기지 않는다"를 한 문장으로 더한다. 새 문구는 한국어.

**Never:**
- 마이그레이션, 새 오류·경고 코드, port 메서드·결과 모양 변경, 블롭 목록·크기 읽기·고아 정리(V1 뒤), 삭제 일감(10.11), @파일 parser·수집(10.4)을 하지 않는다.
- external 위치를 FileStore로 읽거나 지우게 하지 않는다. DB·문서·시험에 절대 홈 경로를 쓰지 않는다(시험의 `home`은 `/home/someone` 같은 가짜 값이나 임시 폴더).
- Postgres는 손대지 않는다(공용 Store 계약을 바꾸지 않으므로 Postgres 시험 불필요).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| 홈 아래 파일 | `('/h/u/a/b.md', '/h/u')` | `'~/a/b.md'`, 되돌리면 `/h/u/a/b.md` | 없음 |
| 정규화 | `('/h/u/a/./c/../b.md', '/h/u/')`, `('/h/u//a', '/h/u')` | `'~/a/b.md'`, `'~/a'` | 없음 |
| 홈 밖·홈 자체 | `/tmp/x`, `/h/u`, `/h/user2/x`, `/h/u/../v/x` | null | 호출자는 external 위치 없음 |
| 상대·제어 문자 | `'a/b'`, 줄바꿈이 든 경로 | null | 없음 |
| 문법 밖 locator | `'~/'`, `'~/../x'`, `'~/a//b'`, `'/abs'`, `'a/b'` | `isExternalLocator` 거짓, `externalPath` null | 없음 |
| external 위치 연산 | `ownership: 'external'`, locator `~/a.md` | 네 연산 모두 `LOCATION_REFUSED` | 대상 그대로 |
| 블롭 파일 링크 | locator 경로가 루트 밖 파일 링크 | 읽기·삭제 `LOCATION_REFUSED`, `put` `FILES_UNAVAILABLE` | 바깥 파일 그대로 |
| 폴더 링크로 쓰기 | 하위 폴더가 루트 밖 링크, 새 바이트 `put` | `FILES_UNAVAILABLE` | 바깥에 파일 없음 |
| 남은 임시 파일 | 블롭 폴더에 `.x.tmp` | `put`·`get` 정상, 임시 파일 위치 거부·안 지움 | 없음 |

</intent-contract>

## Code Map

- `packages/core/src/domain/file.ts` -- `FileLocation`, `contentHashOfBytes`, `brainLocator`, `isBrainLocator`(:22). 새 코덱 세 함수를 여기에.
- `packages/core/src/ports/file-store.ts` -- port(10줄). 바꾸지 않는다.
- `packages/core/src/testing/fakes/file-store.ts` -- `memoryFileStore`; `accepts`(:6)가 거부 규칙.
- `packages/core/src/testing/contracts/file-store.ts` -- `fileStoreContract()` 두 사례(:7, :39). `contractCase`·`withSubject`(`testing/contract.ts`), `assertEqual`·`assertOk`·`assertTrue`(`testing/assert.js`).
- `packages/core/test/contracts.test.ts:1403` -- fake로 계약을 돈다. 코덱 단위 시험은 `packages/core/test/`의 새 `file-locator.test.ts`(또는 기존 도메인 시험 옆).
- `apps/cli/src/runtime/file-store.ts` -- `localFileStore`; `pathOf`(:13–33)가 루트·링크 검사, `put`(:35–57).
- `apps/cli/test/file-store.test.ts` -- 계약 실행(:13), 권한(:14), 루트가 파일(:29), 폴더 링크 읽기·삭제(:33). `scratch()` 임시 폴더 도우미.
- `packages/sqlite/migrations/0002_files_and_work.sql:140` -- `locator`는 상대 경로라는 주석(읽기만; 마이그레이션은 고치지 않는다).
- `_bmad-output/personal-brain/architecture-brain-v1-slice-1/architecture-brain-v1-slice-1.md` -- AD-23(:360~), Table Contract `file_locations`(:453).

## Tasks & Acceptance

**Execution:**
- [x] `packages/core/src/domain/file.ts` -- `externalLocator`·`isExternalLocator`·`externalPath` -- 10.4가 쓸 표현.
- [x] `packages/core/test/file-locator.test.ts` -- I/O 표의 코덱 다섯 줄과 왕복, `second_brain` 공개 export 확인.
- [x] `packages/core/src/testing/contracts/file-store.ts` -- 위 계약 사례 -- fake·로컬이 함께 통과.
- [x] `apps/cli/test/file-store.test.ts` (필요하면 `apps/cli/src/runtime/file-store.ts`) -- 로컬 사례 (1)–(4).
- [x] 아키텍처 문서 -- AD-23·Table Contract 한 문장.

**Acceptance Criteria:**
- Given fake와 로컬 FileStore, when `fileStoreContract()`의 모든 사례를 돌리면, then 둘 다 통과한다.
- Given 로컬 FileStore 루트와 루트 밖 파일·폴더, when 링크·`external` 위치·루트 밖 locator로 쓰거나 지우려 하면, then 거부되고 바깥 파일의 바이트와 존재가 그대로이며 바깥 폴더에 새 파일이 없다.
- Given 새 바이트를 넣은 로컬 FileStore, when 권한을 보면, then 루트·블롭 폴더는 0700, 블롭 파일은 0600이다.

## Implementation Notes

- 2026-10-26: Core에 순수 문자열 `externalLocator`·`isExternalLocator`·`externalPath`를 추가했다. 절대 경로 정규화·엄밀한 홈 하위 경계·제어 문자 거부·유니코드 보존·왕복을 단위 시험으로 고정했다.
- 공용 FileStore 계약에 external 위치·홈 기준 및 절대 locator 거부, 세 번 넣기의 위치·해시·크기·바이트 동일성, URL 반복 호출 동일성, 거부 후 원본 바이트 보존을 추가했다.
- 로컬 시험에 바깥 파일 링크의 모든 연산과 같은 바이트 넣기 거부, 바깥 폴더 링크로 새 파일 쓰기 거부, 남은 임시 파일 무시·접근 거부·보존, 이미 있는 0700 루트 아래 권한을 추가했다. 기존 런타임 구현이 모두 통과하여 런타임 수정은 없었다.
- `second_brain` 공개 export 검증은 해당 패키지에 의존하는 CLI 시험에 두었다(Core에 역방향 의존성을 추가하지 않음). AD-23 둘째 항목과 Table Contract에 external locator 규칙을 한국어로 추가했다.
- 검증: `pnpm build`, `pnpm typecheck` 통과. `pnpm exec vitest run --project core --project cli`: 47개 파일, 1,682개 시험 통과. 코덱·FileStore 대상 실행도 2개 파일, 38개 시험 통과. `git diff --check` 통과 및 변경 코드·시험에 절대 홈 경로가 없음을 확인했다. 커밋하지 않았다.

## Plan Change Log

## Review Triage Log

### 2026-10-26 — Review pass
- verdicts: 0 findings — high 0, medium 0, low 0, false 0, maybe-false 0
- findings: 없음. Quick 렌즈(codex 워커, Orca run `run_94f812102bfc`)가 계획·저장소 규칙·diff·주변 구현을 읽고 지적 없이 끝냈다(코덱·로컬 시험 38개와 fake 계약 두 사례를 다시 돌려 통과).

## Design Notes

- Decision(2026-10-26, 무인 실행에서 에이전트가 고름) `external` 로컬 위치의 locator는 홈 기준 `~/` 상대 경로다. 실측(2026-10-26, 이 기계)에서 Claude Code `attachment`(`type: file`) 항목은 `filename`·`content.file.filePath`에 절대 경로, `displayPath`에 cwd 기준 상대 경로를 준다. 절대 경로는 OS 사용자 이름을 담고 다른 Mac에서 맞지 않으며(AD-23 "절대 경로를 저장하지 않는다", 0002 주석 "locator는 상대"), cwd 기준은 세션마다 기준이 달라 같은 파일이 다른 locator가 된다. 홈 기준이면 같은 파일이 늘 같은 locator이고 새 Mac에서도 그 홈으로 풀린다. 홈 밖 파일은 드물어 external 위치를 남기지 않고(내용은 Brain 사본으로 남는다) 10.4가 그 경우를 다룬다.
- `~/` 접두는 기준을 locator 안에 적어 두어 나중에 다른 기준(예: 외장 볼륨)을 더할 자리를 남긴다. brain locator(`hh/hh/<hex>…`)와 겹치지 않는다.

## Verification

**Commands:**
- `pnpm build && pnpm typecheck` -- expected: 통과.
- `pnpm exec vitest run --project core --project cli` -- expected: 모두 통과(새 사례 포함).
- `git diff --check` -- expected: 통과, 더한 줄에 절대 홈 경로 없음.

## Auto Run Result

Status: built

- 요약: 로컬 FileStore를 AD-23 계약대로 마쳤다. Core 도메인에 사용자 원본(`external`) 로컬 위치의 locator 코덱(`externalLocator`·`isExternalLocator`·`externalPath`)을 두었다 — 홈 기준 `~/` 상대 경로이고, 경로를 정규화해 홈의 엄밀한 하위일 때만 만들며, 홈 밖·홈 자체·제어 문자가 든 경로는 null(10.4는 external 위치를 남기지 않는다)이다. 공용 계약에 external·`~/`·절대 경로 locator 거부, 세 번 넣기의 같은 위치·해시·크기·바이트, 같은 위치의 같은 URL, 거부 뒤 원본 보존을 더했고, 로컬 시험에 블롭 파일 링크의 모든 연산 거부, 하위 폴더 링크로 새 바이트를 쓰지 않음, 남은 임시 파일 무시·거부·보존, 이미 있는 0700 루트 아래 권한을 더했다. 기존 로컬 구현이 새 사례를 모두 통과해 런타임 코드는 바꾸지 않았다. 마이그레이션 없음.
- 바뀐 파일:
  - `packages/core/src/domain/file.ts` — external locator 코덱 세 함수.
  - `packages/core/test/file-locator.test.ts`(새) — 코덱 정규화·거부·왕복·제어 문자 시험.
  - `packages/core/src/testing/contracts/file-store.ts` — fake·로컬이 함께 도는 계약 사례 추가.
  - `apps/cli/test/file-store.test.ts` — `second_brain` 공개 export 확인과 로컬 링크·임시 파일·권한 사례.
  - `_bmad-output/personal-brain/architecture-brain-v1-slice-1/architecture-brain-v1-slice-1.md` — AD-23과 Table Contract `file_locations`에 external locator 규칙 한 문장.
- 리뷰: Quick 렌즈(codex 워커) 지적 0건. 패치 0, 미룸 0, 반려 0.
- 후속 리뷰 권장: false(패치한 항목 없음).
- 검증(코디네이터가 다시 돌림): `pnpm build`·`pnpm typecheck` 통과, `pnpm exec vitest run --project core --project cli` 47개 파일·1,682개 통과, `git diff --check` 통과, 더한 줄에 절대 홈 경로 없음. I/O 표 아홉 줄 모두 시험이 있다(코덱 다섯 줄은 `file-locator.test.ts`, external 위치 연산은 계약, 링크·임시 파일은 로컬 시험). Postgres 시험은 공용 Store 계약을 바꾸지 않아 돌리지 않았다.
- 구현: codex 워커(Orca run `run_94f812102bfc`)가 계획대로 구현했고, 코디네이터가 diff 전체를 읽었다.
- 남은 위험:
  - 홈 밖 파일(`/tmp`, 외장 볼륨)은 external 위치를 남기지 않는다. 10.4가 그 경우 첨부를 Brain 사본만으로 남길지 정해야 한다.
  - 코덱은 유니코드 정규화를 하지 않는다. 같은 파일이 NFC·NFD 두 표기로 오면 locator 둘이 된다(macOS 파일 시스템은 둘을 같은 파일로 본다). 실제로 하네스가 두 표기를 섞는지는 10.4 실측에서 본다.
  - 로컬 구현의 링크 검사와 실제 쓰기 사이의 경합(검사 뒤 링크를 바꾸는 경우)은 막지 않는다. 루트는 0700이라 같은 사용자만 바꿀 수 있다.
