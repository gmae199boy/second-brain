---
type: epic
title: "조회와 미러"
parent: personal-brain
covers: [CAP-4, CAP-5, CAP-6, CAP-7, CAP-13, CAP-14]
after: ["epic-capture", "epic-log-and-context", "epic-attachments"]
assignee: ""
risk: medium
---

# 조회와 미러

## Description

조각 생성(drain), 키워드 검색(FTS5 trigram, 질의는 Core 함수 하나가 구절로 감쌈), 문서 조각·파일 이름·경로·EXIF 촬영 일시 검색(`recall docs`, `files show`·`files url`), 종류별 결과 계약, `brain recall time/logs/chunks/tools/expand`, `brain sessions list/read`, 결과 계약(출처·근접 정렬·8,000자), 세션별 Markdown 미러와 `mirror rebuild`, 조각 색인을 다시 만드는 `index rebuild`(키워드 구성), `recall` 직전 증분 수집(epic-capture의 세션 토큰 수집을 부른다. `log append`의 선수집은 epic-log-and-context)을 만든다.

2026-10-15 epic-capture 인셉션으로 정한 것:
- 근접 정렬은 같은 워크트리 → 프로젝트 → 전체다. 워크스페이스는 slice 1에서 쓰지 않는다.
- `messages redact` 연쇄 중 가린 메시지의 조각·미러 재생성 일감은 이 에픽이 붙인다. epic-capture는 행 삭제까지 한다(AD-11).
- 문서 추출 세대·조각과 `file_names`는 epic-attachments가 만든다. 이 에픽은 그것을 검색한다.

2026-10-15 변경(추가안 B, `../change-surface-plugin-daemon/`)으로 더한 것: 결과 계약 보강 — 잘림은 낮은 순위 행부터 통째로, 1위는 남기고 `meta.omitted{count, reason}`·`meta.next{ns, verb, args}`를 붙인다(AD-15). 검색을 수행하지 못한 것(오류 `SEARCH_FAILED`)과 0건(`ok`, `data: []`, `meta.hint`에 다음 행동)과 미설치(exit 2)를 구분한다. `has_more`는 limit+1로 판정하고 0건도 `count`를 낸다. 문서 결과의 위치는 `chunk_locator`다. 3자 미만 LIKE 폴백에 `ESCAPE` 명시, `EXPLAIN QUERY PLAN` 인덱스 회귀 테스트, 미러 파일명의 `<project>` 정리(제어문자·`<>:"/\|?*`→`_`, 대소문자 충돌은 ` (2)`). 원천: `inputs/weknora-patterns.md` §1.3.

2026-10-20 변경(`../change-discipline-and-metrics/`)으로 더한 것: `recall chunks|logs|docs --count`(같은 필터로 집계만 `data`로 — `chunks`·`logs`는 `{sessions, rows, by_month}`, `docs`는 `{files, rows, by_month}`, `by_month`는 기간 안의 달만이고 날짜 인자는 AD-13의 구간 함수(날짜 + 설정 시간대 → 반열린 UTC)를 거쳐 `meta`에 되울린다. `meta.count`는 1, `has_more`는 false, `RESULT_TRUNCATED` 없음, 8,000자 상한 밖, spine AD-15)와 **검색 회귀 러너** `tooling/eval`(SDK 읽기 전용, 문항 파일은 `~/.second_brain/eval/questions.toml`, 결과는 `~/.second_brain/eval/results/`에 식별자·질의·점수만, 저장소에는 러너와 중립 fixture만). 러너가 재는 것은 고정 질의의 적중률(hit@k)이고 SM-3이 아니다.

## Outcome

"지난주에 뭐 했지", "그거 왜 그렇게 했지"에 날짜와 근거 대화가 붙은 답이 나온다(SM-2, SM-3).

## Requirements

인셉션 때 채운다. spec의 CAP-4, CAP-5, CAP-6, CAP-7, CAP-13, CAP-14(문서 검색 부분)와 그것이 인용하는 PRD FR·spine AD가 원천이다.

## Done when

1. "어제·지난주·특정 날짜" 시간 조회가 프로젝트를 가리지 않고 시간순으로 나오고, 기록이 없는 기간은 빈 결과다.
2. SM-3 채점표(addendum §8)는 사람이 채점해 `~/.second_brain/eval/`에 기록하고, 회귀 러너가 같은 폴더의 문항 파일로 고정 질의의 적중률(hit@k)을 재어 날짜별 결과를 남기며, 랭킹·조각 규칙·`index rebuild`를 바꾼 뒤 같은 문항으로 다시 재면 떨어진 문항이 보인다(2026-10-20).
3. 모든 결과의 출처만으로 `recall expand`·`sessions read`가 원문까지 내려간다.
4. 한 번의 결과가 8,000자를 넘으면 낮은 순위 행부터 통째로 빠지고 1위는 남으며, `RESULT_TRUNCATED`와 함께 `meta.omitted.count`와 다음에 실행할 `meta.next`가 붙는다. 검색이 실패한 것(`SEARCH_FAILED`)과 0건이 응답에서 구분된다.
5. 미러를 지우고 `mirror rebuild`로 다시 만들면 같은 내용이고, 미러를 고쳐도 DB는 변하지 않으며, 가린 세션의 미러에는 가린 값이 없다.
6. `index rebuild`로 조각을 비우고 다시 만들어도 원문·로그·출처가 변하지 않고, 미색인 세션은 `UNINDEXED`로 표시된다. 조회 지연(SM-7)을 실측해 기록하고, doctor가 색인 설정과 실패 색인을 보인다.
7. 문서 본문의 단어, 폴더 이름, 촬영 일시로 문서·사진이 찾히고, 결과에 원본 URL이 붙으며, 미색인 파일은 표시된다. 공백 든 질의와 `a-b`·`AND`·`"` 같은 질의가 오류나 조용한 0건 없이 처리된다.
8. `recall chunks --count`·`logs --count`·`docs --count`가 질의·꼬리표·기간 필터 그대로 세션 수(문서는 파일 수)·행 수·월별 건수를 내고, 0건도 0으로 내며, 응답 `meta`에 쓴 구간이 되울리고, `RESULT_TRUNCATED`가 붙지 않는다(2026-10-20).

## Boundaries

AD-13·14(로그 없는 세션의 첫 요청 문장, FR-9 표시)·15·16·23·24, Table Contract(chunks, index_configs, document_chunks, file_names, file_metadata). 경고 코드 `FILE_SOURCE_UNREACHABLE`·`RESULT_TRUNCATED`·`UNINDEXED`와 오류 코드 `SEARCH_FAILED`. 미러 쓰기는 DB 잠금 밖에서 하고 일감으로 직렬화한다. 임베딩은 epic-embedding-index.

## References

- parent — _bmad-output/personal-brain/initiative-personal-brain.md
- spec — _bmad-output/personal-brain/spec-brain-v1-slice-1/spec-brain-v1-slice-1.md, Capabilities CAP-4, CAP-5, CAP-6, CAP-7, CAP-13, CAP-14
- architecture — _bmad-output/personal-brain/architecture-brain-v1-slice-1/architecture-brain-v1-slice-1.md
- prd — _bmad-output/personal-brain/prd-brain-v1-slice-1/prd-brain-v1-slice-1.md
- prd addendum — _bmad-output/personal-brain/prd-brain-v1-slice-1/addendum.md, §8 (SM-3 확장 채점표)
- inputs — _bmad-output/personal-brain/inputs/weknora-patterns.md, §1.3 (C1~C10)
- change — _bmad-output/personal-brain/change-surface-plugin-daemon/change-surface-plugin-daemon.md, §4.1, §4.2(AD-15)

## Notes

- Waits on epic-attachments because: 문서 추출 세대·조각과 `file_names`가 문서 검색의 대상이다(2026-10-15 epic-capture에서 나뉨).
- Note(2026-10-16, `../change-users-and-review-gaps/`, 인셉션 입력, 원문은 `../inputs/external-review-2026-10-16.md`):
  - T4: 문서 조각의 앞뒤를 읽는 길이 없다(`recall expand`가 `document_chunk`도 받거나 `files`의 동사).
  - D7: 로그 없는 세션의 첫 요청 문장은 `occurred_at`이 가장 이른 user 메시지에서 꺼낸다. 저장하지 않는다(spine AD-14).
  - T9: 미러 파일명 정제(C9)는 spine AD-16에 들어갔다. " (2)" 충돌 접미사가 AD-16의 "순수 함수"와 어울리게 정한다.
- Note(2026-10-19, `../change-masking-b-and-review-fixes/`, 인셉션 입력): 마스킹 B. 조회 결과·넓히기·세션 읽기는 엔벨로프 코덱이 가린다(D1). 조각·FTS는 원문 위이고, 비밀 값으로 찾으면 행은 나오되 값은 가려진다(D2). 미러 렌더러는 출력 코덱으로 등록한다. 미러는 (DB 상태, 패턴 버전)의 순수 함수이고 frontmatter에 버전을 적으며, 버전이 오르면 모든 세션의 미러 재생성 일감을 만든다(D3, spine AD-16).
- Note(2026-10-20, `../change-discipline-and-metrics/`, 인셉션 입력): D5·D6. 러너의 문항 파일 형식(verb·query·expect·k)은 인셉션에서 정한다. 대분류 먼저(PRD §8-5)와 조각 직접 검색의 비교도 같은 러너로 잰다.
- Note(2026-10-20, spine 리뷰): `--count`는 `chunks`·`logs`가 `{sessions, rows, by_month}`, `docs`가 `{files, rows, by_month}`, `by_month`는 기간 안의 달만이고 AD-13의 구간 함수(날짜+설정 시간대 → 반열린 UTC)를 쓰며 `meta`에 구간을 되울린다. 회귀 러너 결과 파일은 식별자·질의·점수만(본문 없음).
- Carry(2026-10-22, epic 2 회고, 인셉션 입력):
  - 0006은 옛 chunk의 seq 범위를 시각 범위로 바꾸므로, 같은 시각에 걸친 서로 다른 chunk 둘이 있으면 UNIQUE에 걸린다(회고 C5, `packages/sqlite/migrations/0006_drop_message_seq.sql:140-151`). 지금은 chunk를 쓰는 코드가 없어 문제가 없다. chunk writer를 만들 때 같은 시각 범위의 규칙을 정한다.
  - 세션·메시지를 읽어 내보내는 새 읽기는 `sessionForOutput`을 거친다(I95) — 도구 메모 대상 전용 가리기 규칙은 일반 엔벨로프 가리기만으로는 걸리지 않는다.
- Carry(2026-10-22, epic-attachments 인셉션, 사용자 결정): 추출한 문서 텍스트(`document_chunks.body`)와 파일 이름을 내보내는 출력 경로(문서 검색 결과·발췌, `files show`)는 이 에픽이 만들고, 출력 코덱으로 가린다(마스킹 B). epic-attachments는 원문 저장까지만 하고 문서 본문 출력 경로를 만들지 않는다. 출력 코덱 계약 테스트의 probe에 문서 조각을 더한다(`packages/core/src/output/codecs.ts`). 원본에 닿을 수 없는 파일(`source_unreachable_at`)과 포인터가 없는 실패·미지원 파일을 결과에서 어떻게 보일지도 여기서 정한다.
