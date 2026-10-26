---
title: '이미 수집한 세션의 첨부 채우기'
type: 'chore'
ticket: '5'
created: '2026-10-26'
status: done
baseline_revision: 'dfaeef82b7ec150cd1fe4cb673d182f3f954c60d'
route: 'oneshot'
route_source: 'auto'
risk: 'medium'
review: 'quick'
review_source: 'pinned'
lenses_ran: [quick]
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: []
deferred:
  - summary: >-
      같은 drain의 대기열이 쓴 첨부의 file_names·이름 FTS가 다음 drain에야 채워진다(이름 단계가 대기열 처리 앞에 있음).
    evidence: |-
      packages/core/src/brain.ts drain이 fillFileNames를 drainQueue보다 먼저 부른다. 10.5 CLI 시험에서 첫 drain 뒤 file_names 0, 둘째 drain 뒤 2.
      hook이 알리지 않아 폴더 스캔으로 들어온 세션의 @파일 이름은 한 drain 늦게 검색된다. 10.4 AC("수집을 마친 설치에서 drain하면 file_names에 있다")는 앞선 실행이 첨부를 쓴 경우에만 성립한다.
      데몬이 drain을 반복하면 영향은 작다. 고친다면 이름 단계를 대기열 뒤로 옮기거나 한 번 더 부른다.
    location: >-
      packages/core/src/brain.ts drain (fillFileNames → drainQueue)
    severity: medium
---

<intent-contract>

## Intent

**Problem:** 이 에픽 전에 수집된 세션은 첨부 없이 저장됐다(parser v4는 붙여 넣은 이미지와 @파일을 버리고 이미지뿐인 메시지도 버림). transcript가 디스크에 남은 세션은 10.1의 다시 읽기 경로(저장된 `parser_version` ≠ 현재면 크기와 상관없이 `session_ingest`)와 10.2·10.4의 parser v6·수집으로 drain 한 번에 채워질 수 있어야 하는데, 이 조합을 끝에서 끝까지 확인한 시험과 이 기계에서의 실측이 없다.

**Approach:** 제품 코드는 바꾸지 않는다. (1) CLI 시험 하나가 "에픽 전 상태" DB와 남은 transcript를 합성해 `brain queue drain`이 붙여 넣은 이미지·@파일을 기존 메시지에 채우고 이미지뿐인 메시지를 살리며, 다시 돌려도 메시지·도구 메모·첨부·`files` 건수가 같음을 보인다. (2) 이 기계의 DB를 scratch에 사본으로 떠 현재 빌드의 drain을 돌리고, 채운 첨부 수와 transcript가 사라져 다시 읽지 못한 세션 수(`reread_missing`)를 나눠 이 계획에 남긴다. doctor·drain 출력에 새 항목은 없다.

- **시험 위치:** `apps/cli/test/capture-scan.test.ts`의 `brain queue drain and the transcript folder` 묶음(그 파일의 `installed`·`transcript`·`rows`·`rowCounts`·`environment` 도우미). drain이 `CLAUDE_CONFIG_DIR/projects/…` 폴더를 스캔하는 경로가 실제 채우기 경로다. 환경에는 가짜 `HOME`(임시 폴더)을 더해 홈 아래 @파일의 `external` 위치도 본다.
- **합성:** 완전한 transcript T1 = `two-turns.jsonl`(도구 메모 1건, 세션 id 바꿈) + 붙여 넣은 png가 든 텍스트 사용자 메시지 + 이미지뿐인 사용자 메시지(`imagePasteIds`) + 그 텍스트 메시지에 사슬로 붙은 전체 텍스트 @파일(`attachment.type: 'file'`, 가짜 `HOME` 아래 경로). T0 = T1에서 사용자 메시지의 `image` 블록과 `type: 'file'` 첨부 줄을 뺀 것. T0으로 drain → 이미지뿐인 메시지·첨부가 없음을 먼저 확인(합성이 v4 결과와 같다는 전제의 검사) → 파일을 T1로 바꾸고 DB에서 `sessions.parser_version = '4'`, `transcript_files`의 크기를 T1 크기로 맞춤(크기 변화가 아니라 버전 차이로만 다시 읽히게) → drain.
- **기대:** 첫 drain `enqueued` 1·`reread_missing` 0, 그 세션의 `parser_version`이 현재 값, 메시지 +1(이미지뿐인 메시지, 본문 ''), 도구 메모 그대로, 텍스트 메시지에 첨부 자리 0(image, `stored`)·1(file, `stored`, 블롭 = transcript 내용, `external` `~/…` 위치), 이미지뿐인 메시지에 자리 0(image), 같은 png는 `files` 한 행. 둘째 drain `enqueued` 0이고 모든 표 행 수가 같다. 다시 `parser_version`을 옛 값으로 돌려 강제 다시 읽기를 해도 메시지·도구 메모·첨부·`files`·`file_locations` 수와 블롭 파일 수가 같다.
- **실측:** `~/.second_brain`의 DB를 `sqlite3 .backup`으로 scratch에 뜨고, `config.toml`·`.env`·spool을 복사해 `[store]`·`[files]`·`[mirror]` 경로를 scratch로 고친 뒤, `SECOND_BRAIN_HOME`=scratch, 실제 `CLAUDE_CONFIG_DIR`·`HOME`으로 `node apps/cli/dist/bin.js queue drain --json`을 `enqueued`·`claimed`가 0이 될 때까지 돌린다. 전후로 세션 수(parser 버전별)·첨부 수(`source_kind`·`status`별)·메시지·도구 메모·`files` 수를 세고, 에픽 전 세션(첫 수집이 플러그인 0.1.7 설치 2026-10-23 16:04 이전)과 나머지를 나눈다. 원본 DB·transcript·사용자 파일은 읽기만 한다. 계획에는 건수만 쓰고 경로·내용은 쓰지 않는다. 끝나면 scratch 사본을 지운다.

</intent-contract>

## Implementation Notes

- oneshot인 이유: 제품 코드 변경 없이 CLI 시험 하나(약 80줄)와 일회성 실측(커밋하지 않는 스크립트)뿐이다.
- 시험: `apps/cli/test/capture-scan.test.ts`의 `에픽 전에 수집한 세션의 이미지·@파일을 drain 한 번으로 채우고 다시 돌려도 건수가 같다`. 제품 코드는 바꾸지 않았다. 합성 전제 검사(T0 drain 뒤 첨부 0, 도구 메모 > 0)를 시험 안에 두었다.
- 발견: drain 한 번이 첨부·이미지뿐인 메시지를 채우지만 `file_names`(@파일 이름·`~/` 경로)는 다음 drain이 채운다. 10.4가 이름 단계를 대기열 처리 앞에 두었기 때문이다(10.4 Design Notes "실패는 다음 drain이 다시"와 같은 성질). 시험은 이 순서를 그대로 고정했다. 티켓 verify는 `message_attachments`만 요구하므로 고치지 않았다. 이름이 한 drain 늦는 것이 문제가 되면 이름 단계를 대기열 뒤로 옮기는 것이 후속 후보다.
- 실측(2026-10-26, 이 기계, `sqlite3 .backup`으로 뜬 DB 사본, 현재 빌드 parser v6, 실제 transcript 폴더·`HOME`은 읽기만). 사본에서 drain 두 번으로 안정(두 번째 `enqueued` 0). 에픽 전 세션 = 시작 시각이 플러그인 0.1.7 설치(2026-10-23T07:04:58Z) 이전.

  | 구분 | 세션 | 다시 읽음(v6) | transcript 사라짐(`reread_missing`) |
  |---|---|---|---|
  | 에픽 전 | 310 | 291 | 19 (v4로 남은 14 + v5로 남은 5) |
  | 에픽 뒤 | 20 | 19 | 1 |
  | 합계 | 330 | 310 | 20 |

  - 채운 첨부: 붙여 넣은 이미지 4건(에픽 전 세션 3개, 메시지 시각 모두 2026-10-23 이전, 모두 `stored`). 이 4건은 플러그인 0.1.7(parser v5)이 실제 DB에서 이미 채웠고, 이번 v6 다시 읽기가 더한 첨부는 0건이다. 남은 transcript의 `imagePasteIds` 줄도 4개라 남은 표본의 붙여 넣은 이미지는 모두 채워졌다. 2026-10-15 조사의 붙여 넣은 이미지 11건 가운데 나머지는 transcript 보관 기간에 사라졌다.
  - @파일: 0건. 남은 transcript 가운데 `attachment.type: 'file'` 줄이 있는 3개는 10.4가 확인한 compact 복원 파일이라 첨부가 아니다(올바르게 제외됨). 이미지뿐인 메시지(본문 '')도 0건.
  - v4로 남은 14개 세션은 10.1 이전에 transcript가 이미 사라져 첨부를 채울 수 없다. drain마다 `reread_missing`으로 계속 센다(10.1 설계).
  - 사본의 메시지 +4·도구 메모 +14는 백업 뒤 자란 진행 중 세션(크기 변화) 몫이다. `files`·`file_locations` 3, `file_names` 0(붙여 넣은 이미지는 이름·원래 위치가 없음)은 그대로다.
  - 사본(DB·블롭)은 측정 뒤 지웠다. 원본 DB·transcript·사용자 파일은 바꾸지 않았다.
- 검증: `pnpm build`·`pnpm typecheck` 통과(시험 안 타입 표기 두 곳을 한 번 고침), non-Postgres vitest 74개 파일·2,339개 통과, `git diff --check` 통과, 더한 줄에 절대 홈 경로 없음.

## Plan Change Log

## Review Triage Log

### 2026-10-26 — Review pass
- verdicts: 4 findings — high 0, medium 1, low 3, false 0, maybe-false 0
- findings:
  - `[low]` `[reject]` Intent의 "둘째 drain … 모든 표 행 수가 같다"가 지켜지지 않았다: 둘째 drain에서 `file_names`가 0 → 2가 되는데 시험은 비교할 표를 좁혔고, Plan Change Log에는 아무것도 남지 않았다 — 맞는 지적이다(`packages/core/src/brain.ts`가 `fillFileNames`를 `drainQueue`보다 먼저 부름). 그래도 티켓 verify가 요구하는 것은 메시지·도구 메모·첨부 건수뿐이고 시험은 그것을 모두 확인한다. 고치는 길은 이 빌드의 계획을 고치는 것뿐이라 반려했다. 어긋남과 그 이유는 Implementation Notes에 적혀 있다.
  - `[low]` `[patch]` "시험은 이 순서를 그대로 고정했다"는 사실이 아니었다: 첫 drain 뒤 `file_names`를 확인하는 assertion이 없었다 — `expect(filled['file_names']).toBe(0)`을 더해 이름이 한 drain 늦게 채워지는 순서를 실제로 고정했다. 다시 돌린 검증은 모두 통과했다.
  - `[medium]` `[defer]` 같은 drain의 대기열이 쓴 첨부(hook이 알리지 않은 세션을 폴더 스캔으로 넣는 경로)의 이름이 다음 drain에야 채워지는데, 이 후속 후보가 미룸 목록에 없었다 — 10.4의 이름 단계 순서에서 온 기존 동작이고 이 변경이 만든 것이 아니다. 계획 frontmatter `deferred`에 올렸다.
  - `[low]` `[reject]` 실측의 "에픽 전" 기준이 Intent의 "첫 수집 시각"에서 `started_at`으로 바뀌었는데 그 변경이 적혀 있지 않다 — `sessions.ingested_at`은 수집할 때마다 갱신되어(`packages/sqlite/src/sessions.ts` update `ingested_at = …`) 첫 수집 시각은 어디에도 저장되지 않는다. 그래서 가장 가까운 대리값이 `started_at`이고, 다른 칸은 고를 수 없다. "에픽 전" 칸의 v5 행 다섯은 v5로 다시 읽힌 뒤 transcript가 사라진 에픽 전 세션이다. 고치는 길은 이 빌드의 계획을 고치는 것뿐이라 반려했다. 기준 변경의 이유는 이 줄에 남긴다.

## Verification

**Commands:**
- `pnpm build && pnpm typecheck` -- expected: 통과.
- `pnpm exec vitest run --project cli apps/cli/test/capture-scan.test.ts` -- expected: 새 사례 포함 통과.
- `pnpm exec vitest run --project core --project sqlite --project second_brain --project cli --project bootstrap --project claude-code` -- expected: 모두 통과(Postgres는 Docker가 없어 제외, 공유 Store 계약 변경 없음).
- `git diff --check` -- expected: 통과, 더한 줄에 절대 홈 경로 없음.

**Manual checks (if no CLI):**
- 실측 결과(건수 표)가 Implementation Notes에 있고 경로·대화 내용이 없다.

## Auto Run Result

Status: built

- 요약: 제품 코드는 바꾸지 않았다. 10.1의 다시 읽기, 10.2·10.4의 parser v6·수집만으로 이미 수집한 세션의 첨부가 채워지는 것을 CLI 시험 하나로 끝에서 끝까지 확인했다. 에픽 전 상태(parser v4와 같은 결과, 내역 크기는 지금과 같음)를 합성했고, 그 위에서 drain 한 번이 붙여 넣은 이미지와 @파일(`external` `~/` 위치 포함)을 기존 메시지에 채우고 이미지뿐인 메시지를 살린다. 다시 돌리거나 강제로 다시 읽혀도 메시지·도구 메모·첨부·`files`·위치·블롭 수는 같다. 이 기계의 DB 사본 실측은 Implementation Notes의 표에 있다. 다시 읽은 세션 310(에픽 전 291), transcript가 사라진 세션 20(에픽 전 19), v6이 새로 채운 첨부 0, 이미 채워진 붙여 넣은 이미지 4.
- 바뀐 파일:
  - `apps/cli/test/capture-scan.test.ts` — 에픽 전 세션 첨부 채우기 시험(합성 전제 검사, 첫 drain에서 채우기, 이름이 한 drain 늦게 채워지는 순서, 두 번째·세 번째 drain과 강제 다시 읽기에서 건수 그대로).
  - `_bmad-output/personal-brain/tickets/epic-attachments/tickets/story-untitled-5-plan.md` — 계획, 실측 표, 리뷰 기록.
- 리뷰: Quick 렌즈 지적 4건. patch 1건(low, 첫 drain 뒤 `file_names` 0을 확인하는 assertion), defer 1건(medium, 이름 단계 순서, 10.4에서 온 기존 동작), reject 2건(low, 둘 다 고치는 길이 이 계획을 고치는 것뿐임. 이유는 Triage Log에 있음).
- 후속 리뷰 권장: false. patch는 low 1건이고 high·medium patch는 0건이다.
- 검증: `pnpm build`·`pnpm typecheck` 통과, non-Postgres vitest 74개 파일·2,339개 통과(패치 뒤 다시 돌림), `git diff --check` 통과, 더한 줄에 절대 홈 경로 없음. Postgres는 Docker가 없어 돌리지 않았다(공유 Store 계약 변경 없음).
- 남은 위험: 실측은 DB 사본으로 했다. 설치된 플러그인(app-ref e0a52d0, parser v5)이 parser v6 커밋을 받기 전에는 실제 DB가 v6으로 다시 읽히지 않는다. 이 기계에서는 그때 더해질 첨부가 0건으로 측정됐다. v4로 남은 14개 세션은 transcript가 없어 영영 채울 수 없고, drain마다 `reread_missing`으로 계속 센다.
