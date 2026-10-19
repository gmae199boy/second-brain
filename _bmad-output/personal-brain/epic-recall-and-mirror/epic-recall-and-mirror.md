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

## Outcome

"지난주에 뭐 했지", "그거 왜 그렇게 했지"에 날짜와 근거 대화가 붙은 답이 나온다(SM-2, SM-3).

## Requirements

인셉션 때 채운다. spec의 CAP-4, CAP-5, CAP-6, CAP-7, CAP-13, CAP-14(문서 검색 부분)와 그것이 인용하는 PRD FR·spine AD가 원천이다.

## Done when

1. "어제·지난주·특정 날짜" 시간 조회가 프로젝트를 가리지 않고 시간순으로 나오고, 기록이 없는 기간은 빈 결과다.
2. SM-3 채점표(addendum §8)를 기본 구성으로 잴 수 있고, 결과가 기록된다.
3. 모든 결과의 출처만으로 `recall expand`·`sessions read`가 원문까지 내려간다.
4. 한 번의 결과가 8,000자를 넘으면 낮은 순위 행부터 통째로 빠지고 1위는 남으며, `RESULT_TRUNCATED`와 함께 `meta.omitted.count`와 다음에 실행할 `meta.next`가 붙는다. 검색이 실패한 것(`SEARCH_FAILED`)과 0건이 응답에서 구분된다.
5. 미러를 지우고 `mirror rebuild`로 다시 만들면 같은 내용이고, 미러를 고쳐도 DB는 변하지 않으며, 가린 세션의 미러에는 가린 값이 없다.
6. `index rebuild`로 조각을 비우고 다시 만들어도 원문·로그·출처가 변하지 않고, 미색인 세션은 `UNINDEXED`로 표시된다. 조회 지연(SM-7)을 실측해 기록하고, doctor가 색인 설정과 실패 색인을 보인다.
7. 문서 본문의 단어, 폴더 이름, 촬영 일시로 문서·사진이 찾히고, 결과에 원본 URL이 붙으며, 미색인 파일은 표시된다. 공백 든 질의와 `a-b`·`AND`·`"` 같은 질의가 오류나 조용한 0건 없이 처리된다.

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
  - D7: 로그 없는 세션의 첫 요청 문장은 seq가 가장 낮은 user 메시지에서 꺼낸다. 저장하지 않는다(spine AD-14).
  - T9: 미러 파일명 정제(C9)는 spine AD-16에 들어갔다. " (2)" 충돌 접미사가 AD-16의 "순수 함수"와 어울리게 정한다.
- Note(2026-10-19, `../change-masking-b-and-review-fixes/`, 인셉션 입력): 마스킹 B. 조회 결과·넓히기·세션 읽기는 엔벨로프 코덱이 가린다(D1). 조각·FTS는 원문 위이고, 비밀 값으로 찾으면 행은 나오되 값은 가려진다(D2). 미러 렌더러는 출력 코덱으로 등록한다. 미러는 (DB 상태, 패턴 버전)의 순수 함수이고 frontmatter에 버전을 적으며, 버전이 오르면 모든 세션의 미러 재생성 일감을 만든다(D3, spine AD-16).
