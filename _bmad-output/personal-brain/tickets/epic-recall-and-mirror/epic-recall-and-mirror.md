---
type: epic
title: "조회와 미러"
parent: personal-brain
covers: [CAP-4, CAP-5, CAP-6, CAP-7, CAP-13, CAP-14]
sources: [_bmad-output/personal-brain/initiative-personal-brain.md, _bmad-output/personal-brain/spec-brain-v1-slice-1/spec-brain-v1-slice-1.md, _bmad-output/personal-brain/architecture-brain-v1-slice-1/architecture-brain-v1-slice-1.md]
companions: [_bmad-output/personal-brain/architecture-brain-v1-slice-1/architecture-brain-v1-slice-1.md, _bmad-output/personal-brain/prd-brain-v1-slice-1/addendum.md, _bmad-output/personal-brain/tickets/epic-recall-and-mirror/epic-recall-and-mirror-research-code.md]
after: ["epic-capture", "epic-attachments", "epic-log-and-context", "epic-drive", "epic-search-and-health-query"]
assignee: ""
refined: true
risk: medium
---

# 조회와 미러

## Description

(→ 2026-10-28: 대화 조각 생성·키워드 검색·결과 계약·`recall chunks/tools/expand`·`sessions read`는 epic-search-and-health-query로 옮겼다. 아래 Notes 2026-10-28) 조각 생성(drain), 키워드 검색(FTS5 trigram, 질의는 Core 함수 하나가 구절로 감쌈), EXIF 촬영 일시 필터(문서 조각·파일 이름·경로 검색과 `recall docs`·`files show`·`files url`은 epic-drive의 E8-6이 먼저 만든다, 2026-10-26), 종류별 결과 계약, `brain recall time/logs/chunks/tools/expand`, `brain sessions list/read`, 결과 계약(출처·근접 정렬·8,000자), 세션별 Markdown 미러와 `mirror rebuild`, 조각 색인을 다시 만드는 `index rebuild`(키워드 구성), `recall` 직전 증분 수집(epic-capture의 세션 토큰 수집을 부른다. `log append`의 선수집은 epic-log-and-context)을 만든다.

2026-10-15 epic-capture 인셉션으로 정한 것:
- 근접 정렬은 같은 워크트리 → 프로젝트 → 전체다. 워크스페이스는 slice 1에서 쓰지 않는다.
- `messages redact` 연쇄 중 가린 메시지의 조각·미러 재생성 일감은 이 에픽이 붙인다. epic-capture는 행 삭제까지 한다(AD-11).
- 문서 추출 세대·조각과 `file_names`는 epic-attachments가 만들고, 문서 검색 경로는 epic-drive(E8-6)가 만든다. 이 에픽은 그것을 쓰고 넓힌다(2026-10-26).

2026-10-15 변경(추가안 B, `../../change-surface-plugin-daemon/`)으로 더한 것: 결과 계약 보강 — 잘림은 낮은 순위 행부터 통째로, 1위는 남기고 `meta.omitted{count, reason}`·`meta.next{ns, verb, args}`를 붙인다(AD-15). 검색을 수행하지 못한 것(오류 `SEARCH_FAILED`)과 0건(`ok`, `data: []`, `meta.hint`에 다음 행동)과 미설치(exit 2)를 구분한다. `has_more`는 limit+1로 판정하고 0건도 `count`를 낸다. 문서 결과의 위치는 `chunk_locator`다. 3자 미만 LIKE 폴백에 `ESCAPE` 명시, `EXPLAIN QUERY PLAN` 인덱스 회귀 테스트, 미러 파일명의 `<project>` 정리(제어문자·`<>:"/\|?*`→`_`, 대소문자 충돌은 ` (2)`). 원천: `inputs/weknora-patterns.md` §1.3.

2026-10-20 변경(`../../change-discipline-and-metrics/`)으로 더한 것: `recall chunks|logs|docs --count`(같은 필터로 집계만 `data`로 — `chunks`·`logs`는 `{sessions, rows, by_month}`, `docs`는 `{files, rows, by_month}`, `by_month`는 기간 안의 달만이고 날짜 인자는 AD-13의 구간 함수(날짜 + 설정 시간대 → 반열린 UTC)를 거쳐 `meta`에 되울린다. `meta.count`는 1, `has_more`는 false, `RESULT_TRUNCATED` 없음, 8,000자 상한 밖, spine AD-15)와 **검색 회귀 러너** `tooling/eval`(SDK 읽기 전용, 문항 파일은 `~/.second_brain/eval/questions.toml`, 결과는 `~/.second_brain/eval/results/`에 식별자·질의·점수만, 저장소에는 러너와 중립 fixture만). 러너가 재는 것은 고정 질의의 적중률(hit@k)이고 SM-3이 아니다.

## Outcome

"지난주에 뭐 했지", "그거 왜 그렇게 했지"에 날짜와 근거 대화가 붙은 답이 나온다(SM-2, SM-3).

## Requirements

인셉션 때 채운다. spec의 CAP-4, CAP-5, CAP-6, CAP-7, CAP-13, CAP-14(촬영 일시 필터 부분. 문서 검색은 epic-drive E8-6, 2026-10-26)와 그것이 인용하는 PRD FR·spine AD가 원천이다.

- E4-1 (CAP-14, 촬영 일시 부분): 이미지 EXIF와 촬영 일시 세 칸(`captured_at_local`, 시간대를 알 때만 `captured_at`, `captured_at_source`), 그리고 그것으로 거르는 촬영 일시 필터(Done when 7). epic 10의 E10-5에서 옮겨 왔다(티켓 1, 옛 10.9, 2026-10-26). 2026-10-28 정제: 이미지는 메타데이터만 있는 추출 성공으로 저장하고(빈 조각), 메타데이터 저장·세대 완료·가림 재검사를 같은 확정 트랜잭션에 둔다. 시간대가 없는 촬영 시각을 추정하지 않는다(GPS·기계·DB 시간대로 채우지 않음). 이미 `unsupported`로 닫힌 이미지는 epic 8의 Carry 방식(바이트 형식 판정, 추출기 버전마다 한 번)으로 다시 넣는다. 필터는 epic 8의 `recall docs`에 더하고, 현지 촬영 날짜 필터는 `captured_at_local`, 절대 구간 필터는 `captured_at`이 있는 것만 대상이다. (FR-28, AD-13·24)
- E4-2 (CAP-5): 시간 조회 — `brain recall time --from --to`(또는 날짜 하나)가 그 기간의 작업 로그와 세션을 프로젝트를 가리지 않고 시간순으로 낸다(워크트리·프로젝트로 좁히는 옵션). 날짜는 AD-13의 구간 함수 하나(날짜 + DB `timezone` → 반열린 UTC, `meta`에 되울림)를 쓰고, 자연어 날짜 해석은 에이전트 몫이다. 로그가 없는 세션은 `occurred_at`이 가장 이른 user 메시지의 첫 요청 문장을 읽을 때 꺼내 보이고 저장하지 않는다(D7). 기록이 없는 기간은 `ok`의 빈 배열이다. `brain sessions list`가 기간·꼬리표로 세션 목록을 쪽 단위로 낸다. 시간 조회도 epic 17의 공통 결과 계약을 쓴다: 시간순을 유지한 채 가린 뒤 8,000자 budget(뒤쪽 시간부터 통째로 빠짐, `RESULT_TRUNCATED`·`meta.next`로 이어 읽어도 중복·누락 없음)·limit+1·0건과 `SEARCH_FAILED` 구분. `recall.*`의 선수집(spine AD-6: connector가 transcript를 찾으면 그 세션을 먼저 증분 수집)을 새 `recall time`·`recall logs`에도 적용하고, 앞 에픽이 만든 연결을 재사용한다. (AD-6·13·14·15, FR-9)
- E4-3 (CAP-6 로그 부분, CAP-7): 작업 로그 대분류 검색 — `brain recall logs`가 epic 17의 질의 함수로 `log_entries.text`를 종류·기간·꼬리표와 함께 찾고, 결과는 `log` 출처(`log_entry_id`, session, harness, 꼬리표, 날짜, `from_at` = `to_at` = 로그 시각)를 붙여 epic 17의 결과 계약(근접 정렬, 가린 뒤 8,000자, 0건·`SEARCH_FAILED`)을 따른다. 출처로 epic 17의 `recall expand`·`sessions read`가 그 시각 앞뒤 원문으로 내려간다. 로그 쓰기·관리는 epic 3이다. (AD-14·15)
- E4-4 (CAP-6·7): `--count` — `recall chunks|logs|docs --count`가 같은 질의·꼬리표·기간 필터로 limit 이전 모집단을 센다. `chunks`·`logs`는 `{sessions, rows, by_month}`, `docs`는 `{files, rows, by_month}`(이름 전용 결과는 `source_file_id`로 따로 셈, file_id를 지어내지 않음)이고, `by_month`는 명시한 기간 안의 모든 달(0 포함)이며 기간이 없으면 자료가 있는 달만이다. `meta.count`는 1, `has_more`는 false, `RESULT_TRUNCATED`는 붙지 않고 8,000자 상한 밖이다. (AD-13·15)
- E4-5 (CAP-6): 범용 검색 회귀 러너 — `tooling/eval`이 `~/.second_brain/eval/questions.toml`의 문항(`[[question]]`: 안정 id·verb `chunks|logs|docs`·query·expect 식별자 목록·k·선택 필터)을 SDK 읽기 전용으로 돌려 hit@k(기대 중 하나라도 상위 k 안이면 1, 평균)를 재고, 날짜별 결과를 `~/.second_brain/eval/results/`에 식별자·질의·점수만 남긴다(본문·발췌 없음). 검색 실패는 적중 0과 다른 실행 실패다. 같은 문항으로 랭킹·조각 규칙·`index rebuild` 전후를 비교한다. 사람의 SM-3 채점(addendum §8)을 대신하지 않는다. (PRD §8-5)
- E4-6 (CAP-13): Markdown 미러 — 세션마다 `<mirror.path>/YYYY-MM-DD_<harness>_<project>_<토큰 뒤 12자>.md`(project의 제어문자와 `<>:"/\|?*`는 `_`)를 DB 상태와 비밀 패턴 버전의 순수 함수로 렌더링한다(frontmatter에 패턴 버전, `sessionForOutput` 뒤 본문 가리기, 미러 렌더러를 출력 코덱 등록부에 넣음). 대소문자를 접은 같은 경로는 세션의 안정 정체성(시작 시각, id) 순으로 첫째가 기본 이름, 다음이 ` (2)`·` (3)`이라 다시 만들어도 같다. 더 이른 충돌 세션이 뒤늦게 들어와 번호가 바뀌면 영향받은 충돌 그룹의 미러를 함께 조정하고 옛 경로를 남기지 않는다(그룹 단위 직렬화로 서로 다른 세션 일감이 같은 경로를 덮지 않음). 읽기 snapshot으로 렌더링하고 DB 잠금 밖에서 임시 파일 → rename으로 쓴다. 세션 미러 일감은 epic 12의 같은 키 직렬화로 한 번에 하나이고, snapshot 뒤 들어온 수집·가리기는 세대 확인으로 다시 돈다. `mirror rebuild`는 같은 함수다. 미러를 고쳐도 DB는 변하지 않는다(역수집 없음). 패턴 버전이 오르면 모든 세션의 재생성 일감을 멱등하게 넣는다. (AD-11·16)
- E4-7 (CAP-13, AD-11): 가리기와 미러 — `messages.redact`의 트랜잭션이 그 세션의 미러 재생성 일감을 함께 넣고, 확정 직후 redact가 그 세션의 미러 파일을 지운다(파일 I/O는 트랜잭션 밖, 충돌 재배정으로 옛 경로가 남아 있으면 그것도). 지우지 못하면 경고를 내고 재생성이 끝날 때까지 doctor가 `warn`이다. 가린 값은 어떤 미러에도 남지 않는다. (AD-11·16)
- E4-8 (CAP-4): `index rebuild` — epic 17의 chunker·writer를 새 `index_config_id`로 모든 세션에 다시 적용한다(같은 규칙이면 find-or-create와 멱등). 새 설정 세대를 다 만든 뒤 활성 포인터를 바꾸므로 두 설정이 섞인 검색이 없고, 중간에 멈추면 이어 간다. 메시지·로그·출처는 바뀌지 않는다. 조각이 아직 없는 세션은 `UNINDEXED`다. doctor가 활성·요청 설정, 불일치, 미색인 세션, 실패 색인을 보인다. 조회 지연(SM-7)은 내부와 프로세스 시작 포함을 따로 중앙값으로 잰다. 문서 추출 세대·`document_chunks`는 건드리지 않는다. (AD-15·24)

## Done when

1. "어제·지난주·특정 날짜" 시간 조회가 프로젝트를 가리지 않고 시간순으로 나오고, 기록이 없는 기간은 빈 결과다.
2. SM-3 채점표(addendum §8)는 사람이 채점해 `~/.second_brain/eval/`에 기록하고, 회귀 러너가 같은 폴더의 문항 파일로 고정 질의의 적중률(hit@k)을 재어 날짜별 결과를 남기며, 랭킹·조각 규칙·`index rebuild`를 바꾼 뒤 같은 문항으로 다시 재면 떨어진 문항이 보인다(2026-10-20).
3. (→ 2026-10-28 epic-search-and-health-query) 모든 결과의 출처만으로 `recall expand`·`sessions read`가 원문까지 내려간다.
4. (→ 2026-10-28 epic-search-and-health-query의 결과 계약. 이 에픽의 조회도 같은 계약을 쓴다) 한 번의 결과가 8,000자를 넘으면 낮은 순위 행부터 통째로 빠지고 1위는 남으며, `RESULT_TRUNCATED`와 함께 `meta.omitted.count`와 다음에 실행할 `meta.next`가 붙는다. 검색이 실패한 것(`SEARCH_FAILED`)과 0건이 응답에서 구분된다.
5. 미러를 지우고 `mirror rebuild`로 다시 만들면 같은 내용이고, 미러를 고쳐도 DB는 변하지 않으며, 가린 세션의 미러에는 가린 값이 없다.
6. `index rebuild`로 조각을 비우고 다시 만들어도 원문·로그·출처가 변하지 않고, 미색인 세션은 `UNINDEXED`로 표시된다. 조회 지연(SM-7)을 실측해 기록하고, doctor가 색인 설정과 실패 색인을 보인다.
7. (2026-10-26: 문서 본문·폴더 이름·파일 이름 검색과 원본 URL·미색인 표시·질의 처리는 epic 8의 E8-6으로 옮겼다. 이 에픽은 그 위에 촬영 일시 필터를 더한다(EXIF, 이 에픽의 1 — 옛 10.9).) 문서 본문의 단어, 폴더 이름, 촬영 일시로 문서·사진이 찾히고, 결과에 원본 URL이 붙으며, 미색인 파일은 표시된다. 공백 든 질의와 `a-b`·`AND`·`"` 같은 질의가 오류나 조용한 0건 없이 처리된다.
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
- research — _bmad-output/personal-brain/tickets/epic-recall-and-mirror/epic-recall-and-mirror-research-code.md (2026-10-28 PostgreSQL·앞 에픽 위 정적 조사)

## Notes

- Waits on epic-attachments because: 문서 추출 세대·조각과 `file_names`가 문서 검색의 대상이다(2026-10-15 epic-capture에서 나뉨).
- Note(2026-10-16, `../../change-users-and-review-gaps/`, 인셉션 입력, 원문은 `../../inputs/external-review-2026-10-16.md`):
  - T4: 문서 조각의 앞뒤를 읽는 길이 없다(`recall expand`가 `document_chunk`도 받거나 `files`의 동사).
  - D7: 로그 없는 세션의 첫 요청 문장은 `occurred_at`이 가장 이른 user 메시지에서 꺼낸다. 저장하지 않는다(spine AD-14).
  - T9: 미러 파일명 정제(C9)는 spine AD-16에 들어갔다. " (2)" 충돌 접미사가 AD-16의 "순수 함수"와 어울리게 정한다.
- Note(2026-10-19, `../../change-masking-b-and-review-fixes/`, 인셉션 입력): 마스킹 B. 조회 결과·넓히기·세션 읽기는 엔벨로프 코덱이 가린다(D1). 조각·FTS는 원문 위이고, 비밀 값으로 찾으면 행은 나오되 값은 가려진다(D2). 미러 렌더러는 출력 코덱으로 등록한다. 미러는 (DB 상태, 패턴 버전)의 순수 함수이고 frontmatter에 버전을 적으며, 버전이 오르면 모든 세션의 미러 재생성 일감을 만든다(D3, spine AD-16).
- Note(2026-10-20, `../../change-discipline-and-metrics/`, 인셉션 입력): D5·D6. 러너의 문항 파일 형식(verb·query·expect·k)은 인셉션에서 정한다. 대분류 먼저(PRD §8-5)와 조각 직접 검색의 비교도 같은 러너로 잰다.
- Note(2026-10-20, spine 리뷰): `--count`는 `chunks`·`logs`가 `{sessions, rows, by_month}`, `docs`가 `{files, rows, by_month}`, `by_month`는 기간 안의 달만이고 AD-13의 구간 함수(날짜+설정 시간대 → 반열린 UTC)를 쓰며 `meta`에 구간을 되울린다. 회귀 러너 결과 파일은 식별자·질의·점수만(본문 없음).
- Carry(2026-10-22, epic 2 회고, 인셉션 입력):
  - 0006은 옛 chunk의 seq 범위를 시각 범위로 바꾸므로, 같은 시각에 걸친 서로 다른 chunk 둘이 있으면 UNIQUE에 걸린다(회고 C5, `packages/sqlite/migrations/0006_drop_message_seq.sql:140-151`). 지금은 chunk를 쓰는 코드가 없어 문제가 없다. chunk writer를 만들 때 같은 시각 범위의 규칙을 정한다.
  - 세션·메시지를 읽어 내보내는 새 읽기는 `sessionForOutput`을 거친다(I95) — 도구 메모 대상 전용 가리기 규칙은 일반 엔벨로프 가리기만으로는 걸리지 않는다.
- Carry(2026-10-22, epic-attachments 인셉션, 사용자 결정): 추출한 문서 텍스트(`document_chunks.body`)와 파일 이름을 내보내는 출력 경로(문서 검색 결과·발췌, `files show`)는 이 에픽이 만들고, 출력 코덱으로 가린다(마스킹 B). epic-attachments는 원문 저장까지만 하고 문서 본문 출력 경로를 만들지 않는다. 출력 코덱 계약 테스트의 probe에 문서 조각을 더한다(`packages/core/src/output/codecs.ts`). 원본에 닿을 수 없는 파일(`source_unreachable_at`)과 포인터가 없는 실패·미지원 파일을 결과에서 어떻게 보일지도 여기서 정한다. → 2026-10-26: 이 출력 경로와 probe는 epic-drive(E8-6)가 만든다. → 2026-10-28: epic 17이 분석 리포트 파일로 먼저 만들고, E8-6이 첨부·Drive 대상으로 넓힌다.
- Decision(2026-10-26, `../../change-v1-capture-and-drive/`, 사용자): V1 뒤(backlog). 문서 검색 부분(Done when 7의 대부분)은 epic 8(E8-6)로 옮겼고, 이 에픽은 epic 8을 기다린다.
- Decision(2026-10-28, `../../prep-garmin-absorption/`, 사용자): 대화 검색(CAP-6·7의 대화 조각·도구 메모 내용 검색과 넓히기, 결과 계약, `recall expand`·`sessions read`)은 epic-search-and-health-query(17)가 PostgreSQL 위에서 먼저 만든다. 이 에픽에 남는 것은 그 경로 위의 다음 일들이다.
  - 시간 조회(CAP-5)와 작업 로그 대분류 검색(CAP-6의 로그 부분)
  - 미러(CAP-13), EXIF(CAP-14), `--count`, 회귀 러너, `index rebuild`
  - 위 Description의 FTS5 trigram·`EXPLAIN QUERY PLAN`·LIKE 폴백은 SQLite 전제이므로 인셉션 때 PostgreSQL 기준으로 다시 쓴다.
  - CAP-6·7을 17과 나눠 가지며, 정확한 경계는 인셉션 때 정한다.
- Waits on epic-search-and-health-query because: 공통 텍스트 검색과 대화 조각·도구 메모 검색·넓히기, 결과 계약 위에 이 에픽의 조회를 얹는다.
- Carry(2026-10-28, epic-attachments 닫기): 이미지는 지금 `unsupported`로 닫혀, 추출기 버전이 올라가도 다시 읽히지 않는다. 4.1(EXIF)이 이미 닫힌 이미지를 다시 넣는 경로를 함께 만든다.
- Decision(2026-10-28, 정제, 추천으로 정함, 사용자 위임: V1 뒤 에픽도 같은 방식): Description의 SQLite 전제(FTS5 trigram, 3자 미만 LIKE 폴백, `EXPLAIN QUERY PLAN` 회귀)는 epic 17의 Core 질의 함수(`lower(col) LIKE lower(pattern)`, 모든 길이에 같은 escape)와 `EXPLAIN (ANALYZE, BUFFERS)` 기록(실행계획을 강제하지 않음)으로 대신한다. 조각·결과 계약·넓히기·`sessions read`·`files show`는 17이 만든 것을 쓰고 다시 만들지 않는다. 이 에픽에 남는 것은 E4-1~8이다.
- Decision(2026-10-28, 정제, 추천으로 정함): 미러 이름 충돌의 ` (2)`는 DB에서 결정한다(대소문자를 접은 같은 경로를 세션의 시작 시각·id 순으로 번호). 디렉터리 열거 순서나 DB 밖 파일을 진실로 삼지 않는다. 미러 위치는 기계 값 `[mirror] path`(기본 `~/.second_brain/mirror/`)이고, 동기화 폴더인지 Brain은 모른다(설정 안내에 적음).
- Decision(2026-10-28, 정제, 추천으로 정함): 가리기 즉시성(AD-11 U1)을 위해 redact는 확정 직후 그 세션의 미러 파일을 지우고 재생성 일감을 같은 트랜잭션에 넣는다. 파일을 지우지 못하면 경고와 doctor `warn`이다.
- Decision(2026-10-28, 정제, 추천으로 정함): `index rebuild`는 새 설정 세대를 다 만든 뒤 활성 포인터를 바꾼다(일괄 비우기 대신). 그동안 검색은 옛 설정을 쓰므로 섞이지 않고, 멈추면 이어 간다.
- Decision(2026-10-28, 정제, 추천으로 정함): `--count`의 `by_month`는 기간을 주면 그 안의 모든 달(0 포함), 없으면 자료가 있는 달만이다. `docs`의 `files`는 file_id와 이름 전용 결과의 `source_file_id`를 따로 세어 더하고, `rows`는 합쳐진 결과 행 수다.
- Decision(2026-10-28, 정제, 추천으로 정함): 회귀 러너 문항은 TOML `[[question]]`(id·verb·query·expect·k·선택 필터)이고 점수는 any-hit hit@k다. 저장소에는 러너와 중립 fixture만 두고 실제 문항·결과는 `~/.second_brain/eval/`에 둔다. SM-3 답변 채점은 사람 몫이다.
- Decision(2026-10-28, 정제, 추천으로 정함): EXIF 라이브러리는 exifr(여러 이미지 컨테이너, 태그 선택, `reviveValues: false`로 날짜·offset 원문 유지를 1에서 원문 fixture로 확인)다. exif-reader 2.0.3은 날짜를 Date로 바꾸고 원문 보존 옵션이 없으므로(재검증 F7·spine u7 R1), 원래 태그 문자열을 얻는 별도 경로·태그 매핑(DateTimeDigitized ↔ CreateDate)·컨테이너 지원을 입증한 경우에만 대안이다. Date를 다시 포맷한 값을 원문이라고 하지 않는다. runtime adapter에서 import해 Core에 주입한다(epic 8과 같은 방식). 태그 우선순위는 DateTimeOriginal → CreateDate, offset은 OffsetTimeOriginal → OffsetTime이고 `captured_at_source`는 쓴 태그 이름이다.
- Decision(2026-10-28, 스토리 계획): 기존 entry 1(EXIF)의 id와 뜻을 유지하고 표의 위치만 옮긴다. 새 id 2~10을 둔다. tracer는 2(시간 조회: 서로 다른 프로젝트의 로그 한 줄과 로그 없는 세션이 같은 날짜로 시간순에 나오고, 출처로 17의 원문 읽기로 내려감)다. 다음은 가장 덜 확실한 6·7(미러 결정성과 가리기 경쟁)보다 먼저 같은 조회 레인을 마치는 순서안 A를 따른다: 2 → 3(logs) → 4(count) → 5(러너) → 6(미러) → 7(미러 수명·가리기) → 8(index rebuild) → 1(EXIF) → 9(Refactor sweep) → 10(이 Mac). 러너를 rebuild 앞에 두어 전후 비교가 된다.
- Decision(2026-10-28, 스토리 계획): Store port·PG adapter·`brain.ts`·명령 등록부·출력 코덱·queue를 모든 스토리가 함께 고친다(조사 9절). 그래서 한 줄이다. 2는 epic 3의 마지막 코드 스토리(3.17)를 기다린다(앞 에픽 선례). 미러 일감이 epic 12의 같은 키 직렬화를 쓰므로 epic 12를 이 에픽의 `after`에 더했다. epic 3·8·10·12·17 쪽 entry에는 인계 문장을 더하지 않고 받는 쪽이 적는다(같은 명시적 예외).
- Decision(2026-10-28, 추천으로 정함): 모든 entry가 `hitl = false`다. 10의 이 Mac 확인은 에이전트가 하고, SM-3 채점은 사람 몫 목록에 있다.
- Decision(2026-10-28, 추천으로 정함): risk와 그 이유. 2 medium(조회 경로 처음 관통, 앞 에픽 바탕이 있음), 3 low, 4 medium(모집단이 목록과 갈리면 숫자가 틀림), 5 low, 6 high(이름·내용이 다시 만들 때 달라지면 미러가 흔들림), 7 high(가린 값이 미러에 남을 수 있음), 8 high(두 설정이 섞이거나 중간에 검색이 빔), 1 medium, 9 low, 10 medium.
- Decision(2026-10-28, 추천으로 정함): high entry의 추가 확인. 6: 대소문자만 다른 project 두 개와 토큰 뒤 12자가 같은 세션 둘을 대소문자 비구분 폴더에서 다시 만들어 이름이 같은지 따로 본다. 7: redact와 미러 일감 실행을 동시에 돌려 가린 값이 파일에 다시 써지지 않는지 따로 본다. 8: rebuild 중간에 프로세스를 죽이고 검색 결과가 옛 설정 하나로만 나오는지 따로 본다.
- Decision(2026-10-28, 스토리 계획): 9(Refactor sweep)는 코드 스토리의 정리를 닫고, 10의 배포·설치본 확인은 그 뒤 따로 둔다(앞 에픽들과 같은 예외). 10에서 찾은 기능 문제는 버그 스토리로 고친다.
- Waits on epic-jobs-and-scheduler because: 세션 미러 일감이 같은 키 직렬화와 일감 계약을 쓴다(2026-10-28 정제).
- Decision(2026-10-28, 세트 검증 F1·F2): 시간 조회와 로그 검색에도 `recall.*`의 선수집(spine AD-6)을 적용하고(앞 에픽의 연결 재사용, 새 수집기 없음), 시간 조회는 시간순을 유지한 채 epic 17의 공통 결과 계약을 쓴다(뒤쪽 시간부터 빠짐, `meta.next`로 이어 읽어도 중복·누락 없음).
- Decision(2026-10-28, 세트 검증 F3): 미러 충돌 번호가 바뀌면 영향받은 그룹을 함께 조정하고 옛 경로를 남기지 않는다. 그룹 단위로 직렬화해 서로 다른 세션 일감이 같은 경로를 덮지 않는다. redact는 옛 경로가 남아 있으면 그것도 지운다.
- Decision(2026-10-28, 세트 검증 F4): 키워드 조각 rebuild의 활성·요청 설정과 원자 전환, 증분·가리기 재생성과의 공존, 동시 rebuild를 spine AD-15와 Table Contract `index_configs`에 같은 날 반영했다. 문서 추출 라이브러리 표에 exifr 우선·exif-reader 대안을 적었다.
- Decision(2026-10-28, 세트 검증 F5): CAP의 성공 기준. 8은 같은 뜻의 설정으로 rebuild할 때 중립 회귀 fixture 점수가 떨어지지 않아야 하고, 규칙을 바꿔 점수가 떨어지면 실패 분류와 후속 버그를 남기고 미달로 표시한다. 10은 SM-2(시간 조회 90%)를 실행 전 private 기록에 고정한 실제 날짜 질문·기대 기간으로 따로 판정한다(공개 plan에는 중립 id·성공 여부·점수). SM-3 채점(기존 10문항 7건, 추가 8문항 4건)은 사람 몫이고, 에픽을 닫을 때 그것이 남았음을 확인한다.
- Decision(2026-10-28, 세트 검증 F6): 8의 high 추가 확인은 서로 다른 설정의 rebuild 두 개를 동시에 요청해 활성 설정이 완성된 한 세대만 가리키고 오래된 완료가 되돌리지 못하는지 따로 본다(crash 검증은 verify에 그대로).
- Decision(2026-10-28, 세트 검증 S1 채택): 2의 공용 setup 책임에 PG URL·schema·격리 홈 설정과 정리, 가짜 clock·임대 만료 제어, worker의 snapshot·rename·전환 직전 barrier, kill 뒤 종료 확인을 plan 필수 칸으로 둔다. 6은 대소문자 비구분 볼륨의 확인 방법과 임시 폴더 정리를, 8의 SM-7은 warm/cold·샘플 수·질의·자료 수를 함께 남긴다.
- Decision(2026-10-28, 재검증 F7·spine u7 R1): EXIF 대안 경로를 조였다. exifr는 `reviveValues: false`로 원문을 유지하는지 1에서 원문·offset fixture로 확인한다. exif-reader는 원문 획득 경로를 입증하기 전에는 단순 대체가 아니다.
