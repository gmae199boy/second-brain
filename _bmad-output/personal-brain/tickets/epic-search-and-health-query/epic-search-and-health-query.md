---
type: epic
title: "텍스트·원문·건강 수치 조회"
parent: personal-brain
covers: [R14, R15, R16, CAP-4, CAP-6, CAP-7]
after: []
refined: false
risk: medium
---

# 텍스트·원문·건강 수치 조회

## Description

에이전트가 부르는 공통 텍스트 검색과 원문 읽기를 PostgreSQL 위에 만든다.
- 대화 조각 생성(drain, CAP-4의 대화 부분)과 그 색인. epic-recall-and-mirror에서 옮겨 왔다. `index rebuild`와 작업 로그 색인은 그 에픽에 남는다.
- 검색 대상: 대화 조각·도구 메모(epic-recall-and-mirror에서 옮겨 온 CAP-6·7의 대화 부분)와 분석 리포트 파일의 문서 조각(`analyses`가 가리키는 core 파일, AD-23). 날짜·출처와 함께 찾고, 결과의 출처로 원문까지 내려간다. 이 에픽이 `document` 결과 종류(AD-15)를 처음 만든다.
- 결과 계약: 출처, 8,000자 상한과 잘림, `SEARCH_FAILED`와 0건의 구분. 출력은 출력 코덱으로 가린다.
- 문서 원문 출력: 리포트 파일의 문서 조각 결과와 원문 읽기(`files show`)를 이 에픽이 처음 만들고, 출력 코덱 계약 테스트의 probe에 문서 조각을 더한다. 옛 계획에서는 epic-drive E8-6이 먼저 만들 일이었다(2026-10-28 트리 검증 F3). epic-drive는 이 경로에 첨부·Drive 대상과 URL을 더해 쓴다.
- 건강 수치 질의: 기간·지표·운동·집계 조건, 합계·평균, 단위·NULL·현지 날짜 규칙. 구조화 수치 조회 port는 이 에픽의 것이다(AD-32). epic-garmin-import가 만든 core 건강 계약 표의 "현재" view를 읽고, 미선택 충돌은 ambiguity로 돌려준다. 확장 schema는 읽지 않는다(AD-30).
- 꺼진 확장의 자료는 검색 응답에 상태로 드러난다(R16의 검색 부분). 상태는 epic-extensions의 registry 공개 view에서 읽는다.
- 질문 해석은 에이전트가, 실제 질의는 코드가 한다.
- 회귀 문항: 한국어 두 글자, 표현 바꾸기, 데이터 없음.
- 임베딩은 쓰지 않는다(C2).

Drive E8-6과 epic-recall-and-mirror는 이 검색 경로를 쓴다(2026-10-28, 이니셔티브 R14·R15, 사용자).

## Outcome

"지난달 수면이 어땠지", "그때 왜 그렇게 했지"에 에이전트가 근거 원문과 정확한 수치로 답한다(이니셔티브 Done when 8의 조회 부분).

## Done when

1. 한국어 두 글자 질의와 표현 바꾸기 회귀 문항이 대화와 기존 분석을 찾고, 결과의 출처만으로 원문을 읽는다.
2. 건강 수치 질의의 합계·평균이 독립 계산과 같고, 단위·NULL·현지 날짜 규칙을 지킨다.
3. 검색 실패·0건·확장 미설치·확장 비활성이 응답에서 구분된다. 결과가 8,000자를 넘으면 규칙대로 잘리고, 비밀은 가려진다.
4. 기능 묶음이 플러그인 배포로 이 Mac의 설치본에 들어가 동작한다.

## Boundaries

다음은 이 에픽 밖이다.
- 시간 조회·작업 로그 검색·미러·EXIF·`--count`·범용 회귀 러너(`tooling/eval`)는 epic-recall-and-mirror다. 이 에픽은 자기 회귀 문항(한국어 두 글자, 표현 바꾸기, 데이터 없음)을 테스트 fixture로 검증한다.
- 첨부·Drive 문서와 파일·폴더 이름을 검색 대상에 더하는 일은 epic-drive E8-6이다. 이 에픽은 리포트 파일의 문서 조각까지만 찾는다.
- 임베딩은 epic-embedding-index다.
- Must not change: 색인은 원문 위에 만들고, 나가는 텍스트는 Core 출력 코덱을 거친다(AD-11·15).

## References

- parent — _bmad-output/personal-brain/initiative-personal-brain.md, Requirements R14, R15, R16(검색 응답 부분)
- spec — _bmad-output/personal-brain/spec-brain-v1-slice-1/spec-brain-v1-slice-1.md, CAP-4, CAP-6, CAP-7(대화 부분)
- architecture — _bmad-output/personal-brain/architecture-brain-v1-slice-1/architecture-brain-v1-slice-1.md, AD-11, AD-15, AD-23, AD-29, AD-30, AD-32
- epic — _bmad-output/personal-brain/tickets/epic-recall-and-mirror/epic-recall-and-mirror.md, Description(결과 계약 보강, 2026-10-15)

## Notes

- Waits on epic-postgres-primary because: 한국어 텍스트 색인과 메시지·도구 메모 스키마가 PostgreSQL에 있어야 한다.
- Waits on epic-extensions because: 검색 응답의 미설치·비활성 상태를 확장 registry의 공개 상태 view에서 읽는다.
- Waits on epic-garmin-import because: core 건강 계약 표의 "현재" view와 의미 계약, `analyses`와 이전된 리포트 파일이 수치 조회와 검색의 대상이다.
- Decision(2026-10-28, 트리 검증): epic-garmin-runtime을 기다리지 않는다. 수치 질의는 이전된 정규화 테이블을 읽고, 새 평가 결과는 같은 스키마에 쌓인다. 어떤 스토리가 그 에픽이 편입한 Python 계산(digest)을 쓰게 되면, 쪼갤 때 그 에픽을 `after`에 다시 선언한다.
- Decision(2026-10-28, 사용자): 대화 검색(CAP-6·7의 대화 조각·도구 메모·넓히기)을 epic-recall-and-mirror에서 가져온다. 검색을 두 번 만들지 않는다.
- Decision(2026-10-28): epic-health-analysis(18)도 기다리지 않는다. 새 평가는 epic 14가 만든 `analyses`와 리포트 파일로 쌓이므로 검색 경로가 같다. 18과는 `after` 경로가 없으니, 나란히 만들면 core 마이그레이션 번호(AD-31 실행기가 중복을 거부한다)와 출력 코덱 등록부·명령 메타에서 뒤에 합치는 쪽이 맞춘다.
