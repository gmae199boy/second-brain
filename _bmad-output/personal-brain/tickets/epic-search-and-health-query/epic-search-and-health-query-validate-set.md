수정 후 재검증 — fix 4 / suggest 3 / ask 0

# epic 17 스토리 세트 검증 (2026-10-28)

Ticket · Set · Dependencies 및 `ticket.md`의 “Rules the template cannot carry”를 적용했다. 검증 대상은 refined=true인 에픽과 leaf가 아직 없는 7개 entry다. 구현 완료나 시험 통과 판정이 아니다. 지정한 메인 checkout의 렌더 결과는 읽기만 했으며, 테스트·빌드·Docker·네트워크·설치·계정/tokenstore 열람·커밋은 하지 않았다. 저장소 쓰기는 이 보고서 하나다.

근거의 `약칭:행`은 다음 저장소 상대 경로의 실제 행이다.

| 약칭 | 파일 |
| --- | --- |
| 에픽 | `_bmad-output/personal-brain/tickets/epic-search-and-health-query/epic-search-and-health-query.md` |
| 세트 | `_bmad-output/personal-brain/tickets/epic-search-and-health-query/tickets/tickets.toml` |
| 조사 | `_bmad-output/personal-brain/tickets/epic-search-and-health-query/epic-search-and-health-query-research-code.md` |
| 이니셔티브 | `_bmad-output/personal-brain/initiative-personal-brain.md` |
| spec | `_bmad-output/personal-brain/spec-brain-v1-slice-1/spec-brain-v1-slice-1.md` |
| spine | `_bmad-output/personal-brain/architecture-brain-v1-slice-1/architecture-brain-v1-slice-1.md` |
| 결정장부 | `_bmad-output/personal-brain/decisions-by-recommendation.md` |
| PG계획 | `_bmad-output/personal-brain/tickets/epic-postgres-primary/tickets/tickets.toml` |
| 작업계획 | `_bmad-output/personal-brain/tickets/epic-jobs-and-scheduler/tickets/tickets.toml` |
| 확장계획 | `_bmad-output/personal-brain/tickets/epic-extensions/tickets/tickets.toml` |
| 이전계획 | `_bmad-output/personal-brain/tickets/epic-garmin-import/tickets/tickets.toml` |
| 채널에픽 | `_bmad-output/personal-brain/tickets/epic-channels/epic-channels.md` |
| 채널보고서 | `_bmad-output/personal-brain/tickets/epic-channels/epic-channels-validate-set.md` |
| 이전보고서 | `_bmad-output/personal-brain/tickets/epic-garmin-import/epic-garmin-import-validate-set.md` |
| 분석에픽 | `_bmad-output/personal-brain/tickets/epic-health-analysis/epic-health-analysis.md` |
| 회상에픽 | `_bmad-output/personal-brain/tickets/epic-recall-and-mirror/epic-recall-and-mirror.md` |
| Drive에픽 | `_bmad-output/personal-brain/tickets/epic-drive/epic-drive.md` |

## fix

### F1 — 확정한 part 키를 공통 spine에도 반영한다

- 근거: `에픽:43`, `에픽:90`, `세트:20`, `spine:563`, `결정장부:53`.
- 문제: E17-1과 2는 `(session_id, index_config_id, from_at, to_at, part)`를 구현하지만 Table Contract는 여전히 네 칸 키다. Notes의 “다음 spine 갱신 때”만으로는 공통 계약을 읽는 builder와 소비자가 서로 다른 키를 받는다. 이미 승인된 결정의 문서 반영 누락이므로 새 ask가 아니다.
- 바꿀 내용: spine Table Contract의 chunks 행에 part를 반영하고 결정적인 분할 번호, 비분할 0, 같은 시각 묶음 보존의 결정 위치를 참조한다. 에픽·장부의 갱신 대기 문장도 반영 완료로 맞춘다. 새 키나 다른 분할 정책을 고르지 않는다.

### F2 — high-risk 2·4의 기준 외 추가 확인을 Notes에 배정한다

- 근거: `세트:21`, `세트:25`, `세트:45`, `세트:49`, `에픽:100`, `에픽:102`, `에픽:104`; 검사 규칙 `ticket.md`, “Rules the template cannot carry”의 high-risk 추가 확인.
- 문제: risk의 이유는 있지만 high인 2·4가 verify 외에 할 추가 확인을 Notes에 지정하지 않았다. 미래 leaf 정제 때 누가 어떤 독립 확인을 이어받을지 빠져 있다.
- 바꿀 내용: 에픽 Notes에 2·4별 추가 확인을 한 가지씩 지정하고 leaf에 이어받게 한다. 추천은 2의 재생성 enqueue 실패를 주입해 redact 본문 치환·조각 삭제까지 모두 롤백되고 spool하지 않는지 확인, 4의 독립 정수/유리수 계산으로 다중 월 버킷·비NULL 분모를 별도 대조하는 것이다. 이미 정한 risk와 평균 정책은 유지한다.

### F3 — 실제 질의를 공개 plan에 그대로 남기는 길을 닫는다

- 근거: `에픽:56`, `에픽:96`, `세트:79`, `세트:80`, `결정장부:59`, `이니셔티브:189`.
- 문제: Notes와 장부는 식별자·성공 여부만 남긴다고 했지만 7은 실제 기억에서 만든 “질의”도 공개 plan에 남긴다. 질의 자체가 대화 본문의 인용이나 특정 날짜의 건강값을 담을 수 있어 본문·건강값 금지와 충돌한다. 비밀 패턴 출력 코덱만으로 개인 기억을 제거할 수 없다.
- 바꿀 내용: 실제 질문 원문·독립 계산 원시 행·실제 명령 출력·오류 상세는 Brain 홈의 private 검증 기록에 두고, 공개 plan에는 문항 id·중립 질문 유형·허용된 불투명 기대 식별자·성공 여부·값 없는 실패 분류만 둔다. 식별자가 개인 경로·제목이면 공개용 id로 치환한다. 합성 회귀의 질의·EXPLAIN만 공개한다. 7의 verify에 합성 본문·건강값 표식을 둔 질의/실패 출력이 공개 증거에 섞이지 않는지 확인을 더한다. 에이전트가 실제 데이터로 확인한다는 위임은 그대로다.

### F4 — sweep 다음 배포의 예외와 실패 환류를 명시한다

- 근거: `세트:68`, `세트:71`, `세트:79`, `세트:82`, `에픽:97`; 검사 규칙 `validate-checks.md`, Set의 Refactor sweep; 선례 `채널에픽:106`, `이전보고서:130`.
- 문제: 6은 1~5를 기다리고 7은 뒤에서 app-ref/version 배포를 한다. 마지막 end-to-end suite만 sweep에서 제외하는 기본 규칙보다 넓다. 순서 Decision은 있지만 cleanup 마감과 배포를 구분하는 예외 문장은 없다. 7의 7건 미만 실패는 버그로 돌리지만 설치·doctor·원문/명령 확인 실패도 같은 환류인지 분명하지 않다.
- 바꿀 내용: Notes에 날짜 있는 Decision으로 6은 코드 1~5의 cleanup을 마감하고 7의 배포·설치본 확인은 뒤의 별도 단계라는 예외를 적는다. 7에서 발견한 모든 기능 문제는 버그로 고치고 재검증하며, 6에 밀린 기능을 넣지 않고 7의 verify 전에는 설치본 완료로 세지 않는다. 정해진 순서를 다시 묻거나 뒤집지 않는다.

## suggest

### S1 — 잠금 초과와 동시 변경 시험의 재현 방법을 정제 plan에 고정한다

- 근거: `세트:8`, `세트:21`, `세트:33`, `세트:45`, `세트:57`, `확장계획:80`, `조사:47`, `조사:160`.
- 문제: entry 수준의 검증 접근은 있으나 “잠금 초과”만으로 비작성자가 어떤 잠금을 잡아 검색을 막아야 하는지 알기 어렵다. 일반 행 잠금은 SELECT 검색을 막지 않을 수 있다. snapshot 뒤 redact의 동기화, 가짜 CLI 행동 시험의 실행 진입점도 정제 때 구체화해야 한다.
- 바꿀 내용: 각 plan에 PG 연결 두 개의 역할, 시험 대상 표를 막는 잠금(예: 격리 시험의 ACCESS EXCLUSIVE), timeout 값, 실패 뒤 잠금 해제·정리 명령을 적는다. 2는 snapshot 읽기 완료 barrier 뒤 새 메시지와 redact를 각각 끼우고, 3은 1위 단독 초과·meta.omitted·sessions read 쪽 이동·가리기 뒤 코드 포인트 길이를, 1은 세대 교체·가린 파일·실패 상태 원문 읽기를 정제 시험 행렬에 포함한다. 5는 기본 suite와 별도 행동 시험 명령 및 기대 명령 순서·최종 안내를 명시한다. 현재 entry에 시험 파일 이름이나 실행 완료 증거를 요구하는 지적은 아니다.

### S2 — tracer의 공통 setup도 한 파일 상한 안에서 시작한다

- 근거: `세트:8`, `세트:9`, `에픽:97`, `조사:149`.
- 문제: tracer의 관찰 가능한 끝은 리포트 한 파일의 검색→출처→원문으로 얇다. 다만 1이 합성 대화·도구 메모·리포트 fixture와 전체 공통 setup을 한 번에 만들면 한 세션 범위를 넘길 여지가 있다.
- 바꿀 내용: 1은 격리 PG/홈·리포트 한 건 생성·정리·문서 probe만 완성하고 대화 fixture 확장은 2, 도구 메모는 3, 건강 fixture는 4가 같은 기반에 더한다고 정제 plan에서 구분한다. setup 최초 소유는 1로 유지한다. 공통 budget 완성은 이미 3이 맡으므로 tracer에서 당겨 만들지 않는다.

### S3 — 실제 10문항과 기대 결과를 실행 전에 함께 고정한다

- 근거: `에픽:96`, `세트:79`, `세트:80`, `결정장부:59`.
- 문제: 판정 기준을 먼저 적는다는 결정은 적절하다. 하지만 기준만 고정한 뒤 적중 결과를 보고 기대 식별자나 재질의 묶음을 바꾸면 7/10이 재현되지 않는다. 건강 2건은 검색 top-5 조건과 독립 계산 조건 중 무엇을 적용하는지도 문항별 기록이 있어야 한다.
- 바꿀 내용: 실행 전 private 기록에 대화 6·리포트 2·건강 2의 문항, 기대 식별자/수치 oracle, 허용 재질의, 문항별 성공 조건을 고정한다. 공개 plan에는 F3의 투영만 둔다. 최초 10건 판정과 버그 수정 후 재실행을 구별한다. 건강 문항은 독립 계산 일치를 필수로, 검색을 포함하는 문항은 top-5와 출처 원문 읽기를 필수로 적어 기준 적용을 명확히 한다. 사용자 재판정이나 사람 개입을 새 필수 단계로 만들지 않는다.

## ask

없음. `이니셔티브:188`의 추천 결정 위임과 `에픽:90`부터 `에픽:99`까지의 part·명령·meta.extensions·expand/files show·평균·recall 스킬·실제 10건·순서·hitl 결정을 다시 열 증거는 없다. 고칠 사항은 이미 정한 정책의 일관된 반영과 검증 경계다.

## Ticket · Set와 Requirements coverage

모든 covers id가 존재하며 E17-1~7의 소유 누락은 없다. 공유 id의 최소형·완성·설치본 확인은 description으로 구분된다. 아직 leaf가 없으므로 각 entry에 full criteria/refined=true를 요구하지 않는다. 알려진 unknown이나 미해소 Source conflict는 없다. 연구 보고서의 후보는 최신 에픽 Decision이 고른 것으로 읽는다.

| Requirement | 담당과 분담 근거 |
| --- | --- |
| E17-1 | 2의 chunker·part 키·증분 drain·동시성·redact 재생성·U+0000 (`에픽:43`, `세트:20`) |
| E17-2 | 1의 문서 최소 검색·공통 함수, 3의 대화/도구 검색·공통 결과 budget 완성 (`세트:8`, `세트:32`) |
| E17-3 | 1의 files show/문서 probe, 3의 expand/sessions read·도구 메모 가리기 (`세트:8`, `세트:32`) |
| E17-4 | 4의 current view/catalog 소비·Core 집계·독립 oracle (`세트:44`) |
| E17-5 | 5의 registry 공개 상태 소비와 meta.extensions (`세트:56`) |
| E17-6 | 1 docs/files show, 3 chunks/tools/expand/sessions read, 4 health query, 5 recall 스킬/메타 확장, 7 설치본 확인 (`세트:8`, `세트:32`, `세트:44`, `세트:56`, `세트:79`) |
| E17-7 | 5 합성 회귀·공식 이미지 실측, 7 실제 질문 10건 (`세트:56`, `세트:79`) |

6은 cleanup만 하므로 covers=[]가 맞다. tracer 1은 PG→Store→Core→SDK/CLI→출력 코덱→원문 읽기의 수직 경로이고, 실행하면 두 글자로 리포트가 검색되고 출처만으로 가려진 원문이 보인다고 적혀 있다. 다음 2는 같은 시각·긴 메시지·redact라는 가장 불확실한 부분이다(`에픽:97`). setup도 에이전트가 수행하므로 hitl=false는 `이니셔티브:189`의 명시적 위임에 맞는다. S2는 크기 보완이며 tracer 재선정 요구가 아니다.

## Dependencies와 보드

보드 명령은 기본 uv cache 임시 파일 권한 오류로 한 번 실패했다. 다음의 오프라인·별도 cache 실행은 exit 0이었다(네트워크·설치 없음).

```sh
UV_CACHE_DIR=/tmp/epic17-validate-uv UV_OFFLINE=1 uv run ~/.agents/skills/bmad-agent-po/scripts/tickets.py --project-root "$(git rev-parse --show-toplevel)" status _bmad-output/personal-brain
```

17은 refined=true, gated_by=[], next_id=8이고 17.1~17.7은 모두 planned, file=null이다. `unpinned_after=[]`, `undeclared_after=[]`, `order_conflict=[]`; cycle·drift 오류는 없었다. 이는 선행 코드가 이미 구현됐다는 증거가 아니다.

| 의존 | 실제 받는 산출물·판정 |
| --- | --- |
| 1 → 14.5, 11.4 | 14.5의 analyses 파일 관계·인계/추출 결과, 11.4의 PG Attachment/ExtractionStore·현재 세대·locator. 실제 기능 선행이다 (`세트:8`, `이전계획:56`, `이전계획:57`, `PG계획:56`) |
| 2 → 1, 11.5 | 1의 공통 setup/조립, 11.5의 PG redact 원자적 연쇄·정리 경로에 재생성 인계를 추가한다 (`세트:20`, `PG계획:68`) |
| 3 → 2 | 생성된 조각과 1에서 이어받은 질의 함수/문서 결과를 소비한다 (`세트:32`) |
| 4 → 3, 14.2 | 공통 명령/출력 기반과 14.2의 catalog·정규 단위·현재 선택·ambiguity 계약/fixture를 소비한다 (`세트:44`, `이전계획:20`) |
| 5 → 4, 13.6, 13.7 | 검색·수치 응답이 있어야 상태를 붙이며 13.6의 공개 상태 view와 13.7의 정적/가짜 CLI 행동 시험 방식을 받는다 (`세트:56`, `확장계획:68`, `확장계획:80`) |
| 6 → 1~5, 7 → 6 | cleanup 후 설치본 확인. 공유 코드 충돌을 피하는 한 레인이고 F4의 명시적 sweep 예외를 보완하면 된다 (`세트:71`, `세트:82`, `에픽:98`) |

14.5→14.4→14.3→14.2→14.1 경로로 건강 최소 계약·catalog와 공유 fixture도 먼저 도착한다(`이전계획:23`, `이전계획:35`, `이전계획:47`, `이전계획:59`). 따라서 4→14.2는 전이적으로도 충족되지만 실제 소비를 드러낸 핀으로 타당하다. 14.1→12.3으로 앞 작업 runtime·attempt 기반이 선행한다(`이전계획:11`, `작업계획:32`). 13.7→13.6이라 5의 두 핀도 중복일 뿐 허위 선행은 아니다. 공유 setup 최초 소유는 1이며 나머지 모두 그 경로에 있다.

앞 에픽 description을 수정하지 않고 받는 쪽이 적는 예외는 `에픽:98`에 명시돼 있다. 13.6과 14.2도 외부 소비자를 직접 명명하므로 인계 의도는 양쪽에서 확인된다(`확장계획:68`, `이전계획:20`). 범용 Dependencies 규칙만 근거로 앞 에픽을 다시 고치게 하지 않는다.

18을 after로 잇지 않는 것은 여전히 타당하다. 18은 14의 analyses/파일 관계를 호환 확장하고 같은 경로로 새 리포트를 쌓는다(`분석에픽:20`, `분석에픽:100`). 17의 검색·집계는 그 실행이나 모델을 부르지 않는다. 공유 migration/등록부/조립 충돌은 `이니셔티브:184`, `이니셔티브:185`, `이니셔티브:186`의 명시적 예외이며, 만드는 순서 18→17에서 1이 HEAD를 다시 읽는 책임도 `에픽:98`에 있다. 새 데이터 의존 증거가 없어 기존 결정을 재논의하지 않는다.

## 검증 접근·spine·경계

각 verify는 합성 입력과 관찰 결과를 담는다. 1은 관계 필터·두 글자 적중·출처 원문·실제 문서 probe, 2는 손으로 정한 경계·part·멱등·증분·redact 끼워 넣기, 3은 근접 정렬·limit+1·8,000자·실패/0건·원문 복원, 4는 손 계산 40/20·중복/ambiguity·NULL·DST·단위·운동 필터, 5는 미설치/비활성 행렬·행동 시험·전수 LIKE 대조·합성 EXPLAIN, 6은 착수 때 정한 cleanup 목록과 회귀, 7은 설치본·사전 기준 실제 10건이다(`세트:9`, `세트:21`, `세트:33`, `세트:45`, `세트:57`, `세트:69`, `세트:80`). 각 plan의 실행 명령·사전 조건·관찰값·정리 명령 요구가 있어 비작성자 검증의 틀은 갖췄다(`세트:8`). F2와 S1을 통해 고위험 독립 확인 및 동시성 재현을 구체화한다.

| spine | 계획과의 정합 |
| --- | --- |
| AD-11 | 원문 색인/출력 가리기, redact 원자적 재생성, U+0000 쓰기 코덱이 1~3에 있다 (`에픽:43`, `에픽:53`, `세트:8`, `세트:20`, `세트:32`; `spine:222`, `spine:229`). F2·S1의 실패/원문 왕복 추가 확인 권장 |
| AD-13 | 현지 date+timezone 유지, 순간형만 반열린 UTC, 23/25시간 날을 4가 검증 (`세트:44`, `세트:45`; `spine:256`, `spine:257`) |
| AD-15 | 단일 LIKE 함수·literal escape·조각 규칙·출처 union·공통 budget·0건/실패·실제 7/10이 1~5·7에 분담 (`에픽:43`, `에픽:44`, `에픽:49`; `spine:277`, `spine:278`, `spine:279`, `spine:287`, `spine:289`) |
| AD-23·24 | core 파일 관계와 현재 추출 세대·chunk_locator로 files show. 세대 교체와 파일 가리기/실패 상태는 에픽 계약에서 정제할 수 있음 (`에픽:45`, `세트:8`; `spine:392`, `spine:400`) |
| AD-29·30 | registry만 읽고 data 배열 유지/meta.extensions, 비활성 보존 결과 제외 금지, 확장 schema를 집계에 쓰지 않음 (`세트:44`, `세트:45`, `세트:56`; `spine:462`, `spine:470`) |
| AD-32 | 14.2 current view/catalog가 고른 행만 집계하고 ambiguity는 제외/별도 반환, 권위를 다시 고르지 않음 (`에픽:54`, `에픽:89`, `세트:44`; `spine:494`, `spine:495`) |
| Table Contract·Deferred | chunks 키만 F1의 확정 결정 미반영. 검색 locale·실행계획 Deferred는 5가 합성 실측으로 담당 (`spine:563`, `spine:785`, `세트:56`) |

CAP-4의 옛 V1 뒤 표기는 `조사:25`가 이미 식별했고, 대화 drain 이동은 최신 에픽 Description/Decision이 명시한다(`에픽:18`, `에픽:87`). CAP-6·7 이동은 spec에도 반영돼 있다(`spec:38`, `spec:41`). 이를 새 Source conflict나 사용자 질문으로 재개하지 않는다.

epic 4는 로그·시간 조회·미러·index rebuild·--count·범용 tooling/eval을 남겨 두고 17의 검색을 소비한다(`회상에픽:76`, `회상에픽:77`, `회상에픽:78`, `회상에픽:81`; `에픽:55`, `에픽:68`). epic 8은 17의 문서 결과·files show·probe에 첨부·Drive·이름/폴더·URL을 추가한다(`Drive에픽:81`, `Drive에픽:82`; `에픽:21`, `에픽:69`). 17이 범용 러너나 Drive를 선행으로 끌어오는 중복은 없다.

## Done when·개인 데이터

| Done when | 충족시키는 결과와 제한 |
| --- | --- |
| 1 대화·기존 분석 검색과 원문 | 1 문서 수직 경로, 2 조각, 3 대화/도구·출처 원문, 5 표현 바꾸기 합성 회귀, 7 설치본 (`세트:8`, `세트:20`, `세트:32`, `세트:56`, `세트:79`) |
| 2 정확한 건강 수치 | 4 current view·catalog 소비와 독립 계산. F2의 추가 확인을 Notes에 배정 (`세트:44`, `세트:45`) |
| 3 실패/0건/상태·잘림·비밀 | 1 문서 probe, 2 redact 재생성, 3 budget/실패, 5 registry/행동 회귀 (`세트:9`, `세트:21`, `세트:33`, `세트:57`) |
| 4 이 Mac 플러그인 | 7 app-ref 앞선 commit/version 동반 갱신·설치본 실행. 원격 push 목록 작성만으로 완료로 세지 않음. F4의 sweep 예외 보완 (`세트:79`, `세트:80`) |

실제 질문을 에이전트가 판정하는 것은 `이니셔티브:188`, `이니셔티브:189`, `에픽:96`, `결정장부:72`와 맞는다. 분석 모델의 품질 판단을 에이전트에게 새로 넘기는 작업이 아니며, 17은 적중/출처 복원/독립 수치 일치를 확인한다. 판정 기준 선고정은 이미 있고 문항·기대 결과까지 함께 고정하는 S3로 재현성을 보완할 수 있다.

합성 fixture와 합성 EXPLAIN은 공개 검증에 적합하다. 실제 본문·건강값을 공개하지 않는 제약도 있다(`에픽:56`). 남은 노출 경로는 F3의 실제 질의와 원시 실패 증거다. F3를 고치면 실제 상세는 private, 공개 증거는 식별자·판정이라는 기존 Decision과 일치한다. 이 검토에서는 실제 개인 데이터나 tokenstore를 읽거나 보고서에 복사하지 않았다.


## 재검증 (2026-10-28)

통과 — F1~F4·S2·S3 해소, S1 부분 해소(권고 시험 행렬 한 항목 잔여), 새 fix 없음.

수정된 에픽 Notes·entry 7, spine Table Contract의 diff, 추천 장부를 Set·Dependencies와 high-risk 추가 확인 규칙으로 대조했다. 근거는 위 약칭 표의 `파일:행`을 따른다. leaf 없는 계획의 정적 재검증이며, 구현 완료·설치본 동작·실제 7/10 달성을 뜻하지 않는다.

| 지적 | 판정 | 근거와 확인 결과 |
| --- | --- | --- |
| F1 | 해소 | `spine:563`, `에픽:90`, `결정장부:53`, `세트:20`. 공통 chunks 키에 part가 반영됐고 결정적 분할 번호·비분할 0·같은 시각 묶음 보존까지 에픽/entry와 일치한다. 에픽의 과거 갱신 예정 문장에는 반영 완료 정정이 있고 장부도 완료로 맞췄다. |
| F2 | 해소 | `에픽:108`, `에픽:109`, `에픽:110`. high 2는 재생성 enqueue 실패 때 redact 본문 치환·조각 삭제의 전체 rollback과 spool 부재, high 4는 독립 정수/유리수로 여러 달·비NULL 분모를 별도 대조하도록 했다. 기존 verify와 별도의 확인이며 leaf 승계를 명시했다. |
| F3 | 해소 | `에픽:96`, `에픽:111`, `세트:79`, `세트:80`, `결정장부:59`. 실제 문항·원시 행·명령 출력·오류 상세는 Brain 홈 private 기록, 공개 plan은 문항 id·중립 유형·불투명 id·판정·값 없는 실패 분류로 한정했다. 개인 경로/제목 id의 치환과 합성 질의/실패 출력 표식의 공개 증거 혼입 검사도 있다. 실제 질문 위임은 유지한다. |
| F4 | 해소 | `에픽:112`, `세트:68`, `세트:71`, `세트:79`, `세트:82`. sweep 6은 코드 1~5 cleanup을 닫고 배포·설치본 7은 뒤에 두는 명시적 예외다. 7의 설치·doctor·원문·명령 확인을 포함한 모든 기능 문제는 버그로 고쳐 재확인하고 sweep에 밀어 넣지 않는다. 7 verify 전 설치본 완료를 주장하지 않는다. |
| S1 | 부분 해소 | `에픽:113`, `세트:8`, `세트:21`, `세트:32`, `세트:33`. 두 PG 연결의 역할·검색을 막는 잠금·timeout·해제/정리, snapshot barrier 뒤 새 메시지/redact 각각의 삽입, 1위 단독 budget 초과·omitted·가린 뒤 코드 포인트 길이, 문서 세대 교체/가리기/실패를 plan 입력으로 지정했다. 5의 별도 행동 시험 명령도 지정했다. 다만 권고했던 sessions read 쪽 이동은 3 description의 쪽 단위 읽기 계약에만 남아 있고 verify와 새 plan 시험 행렬에 명시되지 않았다. 3 정제 때 쪽 이동의 누락·중복 부재 관찰을 더하면 권고 전체가 닫힌다. 기존 기능 계약 자체는 있어 새 fix로 올리지 않는다. |
| S2 | 해소 | `에픽:113`, `에픽:97`, `세트:8`. tracer 1의 공통 setup 완성 범위는 격리 PG·홈·리포트 한 건·정리·문서 probe로 한정됐다. 대화 fixture는 2, 도구 메모는 3, 건강 fixture는 4가 같은 기반에 더한다. 기존 공통 setup 최초 소유 1과 후속 재사용을 유지하면서 한 세션 범위를 좁혔다. |
| S3 | 해소 | `에픽:113`, `세트:79`, `세트:80`, `결정장부:59`. 대화 6·리포트 2·건강 2의 문항·기대 식별자/수치 oracle·허용 재질의·문항별 기준을 private에 실행 전에 함께 고정한다. 검색은 top-5와 출처 원문, 건강은 독립 계산 일치를 명시하며 최초 판정과 수정 후 재실행을 구별한다. 공개 증거는 F3의 투영만 남긴다. |

### 공통 계약·의존·보드 재확인

- `spine:563`의 part 반영은 기존 `에픽:43`, `에픽:90`의 확정 결정을 옮긴 것이다. 같은 시각 묶음·긴 메시지 분할의 새 정책을 다시 고르지 않았다. AD-11·15의 원문 색인/출력 코덱·출처와 원문 조회, AD-32의 current view·catalog 소비에도 새 충돌이 없다. `spine:320`의 tokenstore 예외는 수집 런타임의 세션 저장 경계이고 조회 17이 그 내용을 읽게 만드는 변경이 아니다.
- `이니셔티브:184`, `이니셔티브:185`, `이니셔티브:186`, `에픽:88`, `에픽:98`의 17/18 무의존·공유 파일 충돌 예외와 HEAD 확인 책임은 유지된다. 17은 `이전계획:56`의 analyses 파일 관계·현재 추출 세대, `이전계획:20`의 catalog·현재 view를 소비한다. 18은 같은 core 계약을 호환 확장하며 새 리포트를 넣으므로 18.9 전환이나 모델 실행이 17의 선행이 되지는 않는다(`분석에픽:100`, `분석에픽:104`, `분석에픽:123`). 기존 결정과 새 문장 사이에 새 F5로 기록할 모순은 발견하지 않았다.
- 앞 에픽 description을 다시 쓰지 않는 `에픽:98`의 명시적 예외, `확장계획:68`, `확장계획:80`의 공개 상태/시험 기반 인계도 유지된다. `이니셔티브:187`, `이니셔티브:189`와 sweep·운영 확인 분리 및 에이전트 위임이 맞는다.
- 지정 보드를 `UV_CACHE_DIR=/tmp/epic1718-revalidate-uv UV_OFFLINE=1`로 읽어 exit 0을 확인했다(네트워크·설치 없음). 17의 7개 entry는 모두 state=planned·file=null·hitl=false이며 `unpinned_after=[]`, `undeclared_after=[]`, `order_conflict=[]`; cycle 오류·drift 표시는 없다. after와 covers는 이번 수정에서 바뀌지 않았고, 앞 절의 실제 산출물 의존 판정을 유지한다.
- 이 재검증 작업은 지정된 두 보고서에 절만 덧붙였다. 테스트·빌드·Docker·네트워크·설치·커밋은 하지 않았다. 절대 홈 경로 검사에서 두 보고서 모두 일치가 없었다.
