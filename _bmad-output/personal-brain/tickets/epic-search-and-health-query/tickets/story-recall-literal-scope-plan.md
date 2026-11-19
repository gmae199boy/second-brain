---
title: '17.8 대화 recall 리터럴 검색과 명시 범위 안내'
type: feature
ticket: '8'
created: '2026-11-19'
status: built
baseline_revision: '7d83963c473a5979c50d6e2d8bf8beddc0ca2bc7'
route: full
route_source: pinned
risk: low
review: thorough
review_source: pinned
lenses_ran: [blind-hunter, edge-case-hunter, verification-gap, intent-alignment]
review_loop_iteration: 1
followup_review_recommended: false
context: []
warnings: []
deferred: []
---

<intent-contract>

## Intent

### 문제

17.7의 기존 대화 질문은 넓은 리터럴과 기본 순위에서 기대 출처를 반환하지 못했다. 사전에 근접 범위를 알 수 있는 기존 문항은 0/6이었다.

### 접근

스킬에서 질문의 문장과 실제 연속 리터럴을 구별한다. 질문에 드러나거나 독립 확인된 범위에 기존 근접 옵션을 적용한다. 반환 결과와 원문을 확인하고 검색 오류·빈 응답·추가 후보·크기 제한 생략을 따로 설명한다.

## Boundaries & Constraints

17.7의 두 회차와 7/10 기준을 보존한다. 실제 자료로 안내를 맞추지 않는다. 대화 경로만 다루며 CLI/SQL 검색·응답 계약, 도구·문서·건강 경로를 보존한다. 운영 자료·설치·릴리스 및 17.7 새 회차는 이 티켓 범위 밖이다.

</intent-contract>

## Code Map

- `plugin/skills/brain-recall/SKILL.md`의 기억 검색 절에 대화 전용 안내를 추가한다.
- `apps/cli/src/commands/recall-chunks.ts`의 `--project`, `--worktree`는 제한 필터가 아닌 근접 순위 옵션이다.
- `packages/core/src/recall/search.ts`와 `results.ts`의 `has_more`, `meta.omitted`, `meta.next` 의미를 확인한다. `meta.next`는 원문 읽기 출처다.
- `tooling/bootstrap/test/recall-skill.test.ts`는 스킬의 실제 CommandSpec 사용을, `apps/cli/test/recall.test.ts`는 격리 PG와 실제 CLI를 검증한다.

## Tasks & Acceptance

**Execution**

1. `plugin/skills/brain-recall/SKILL.md`의 대화 전용 지침을 작성한다. 기존 도구 메모·리포트·건강 안내와 scaffold를 보존한다.
2. `tooling/bootstrap/test/recall-skill.test.ts` 및 필요한 경우 `apps/cli/test/recall.test.ts`로 실제 지원 옵션과 별개 합성 질문의 연속 구절·범위 유무·원문 확인을 검증한다. 기존 실제 CLI의 추가·생략·오류 검증을 재사용한다. 테스트 fixture에 개인정보나 기존 17.7 질문·합성 예시를 넣지 않는다.

**Acceptance Criteria**

- 자연어 대화 질문이 주어지면 스킬 지침에서 예상할 수 있는 짧은 연속 구절 한 개를 만든다. 원래 질문의 전체 문자열이나 떨어져 있는 단어를 결합한 문자열로 의미 검색을 가정하지 않는다.
- 적격 범위가 있으면 실제 지원 schema를 확인해 `--project` 또는 `--worktree`를 사용한다. 범위가 불명확하면 옵션 없이 검색한다. 근접도를 범위 필터라고 안내하지 않는다.
- 검색 오류와 0건을 구별한다. 정상 응답에서 추가·생략 메타와 원문 근거 부족을 구별하고 미리 정한 허용 재질의를 적용한다. 반환 출처의 원문을 읽기 전에는 결론을 내리지 않는다. 기록 부재를 검색 결과만으로 단정하지 않는다.
- 독립 합성 검증에서 스킬 지침과 실제 CLI 지원 경로를 확인한다. 공개 계획에 다음 17.7 수락 회차의 독립 맹검을 남긴다.

## 독립 운영 수락 회차 절차

1. 중앙이 질문·기대 출처 작성자와 검색 실행자를 서로 다른 역할로 지정한다. 작성자는 기존 실패 6문항, 기존 10문항, 이 티켓의 합성 예시를 제외한 별도 표본에서 대화 6건·리포트 2건·건강 2건을 한 번 선정한다.
2. 작성자는 실행 전에 질문, 본래 사용자 메시지에 제공된 범위, 독립 oracle의 실제 출처 또는 값, 문항별 성공 조건, 도구별 최대 조회와 허용 재질의 횟수·조건을 보호 폴더에 잠그고 시각과 해시를 기록한다. 새 표본을 보고 검색 설정을 조정하거나 실패 항목을 교체하지 않는다.
3. 실행자는 질문과 본래 제공된 범위만 받는다. 기대 값, 세션·문서 식별자, 조회 결과나 작성자 힌트는 판정 전까지 받지 않는다. 설치본의 지원 명령으로 사전 고정 한도 안에서 한 회차를 실행한다.
4. 독립 판정자는 반환된 상위 5건에 기대 출처가 포함되고 그 출처로 원문 확인에 성공했는지, 건강 집계가 고정 oracle과 일치하는지 대조한다. 10건 중 최소 7건과 17.7 필수 운영 명령을 함께 확인한다.
5. 공개 기록은 문항 불투명 ID·유형·판정·값 없는 실패 범주·집계로 제한한다. 최초 2/10, 보정 4/10과 새 회차를 별도로 남긴다. 17.8 완료는 이 새 회차의 수락 결과를 대신하지 않는다.

## Implementation Notes

- Terra가 대화 스킬의 연속 구절, 근접도, 재질의 및 원문 경로와 공개 CLI 합성 시험을 작성했다.
- 독립 리뷰 반영으로 같은 세션에 들어가던 합성 시험을 독립 fixture로 이동했다. 검색 건수 제한과 응답 크기 제한, 첫 본문과 원문 확장의 부분 응답을 구별했고, 공백이 있는 구절을 한 인자로 전달하는 예시를 넣었다.

## Plan Change Log

## Review Triage Log

### 2026-11-19 독립 리뷰

발견 15건. 높은 영향 4건, 중간 영향 10건, 낮은 영향 1건. 같은 원인의 중복 지적을 아래에 각각 기록했다.

- Blind Hunter 1, 높음. 공유 세션의 기존 페이지 건수 회귀는 새 fixture로 격리했다.
- Blind Hunter 2, 중간. 첫 행만 잘릴 때의 생략 0과 동일 출처 안내를 보완했다.
- Blind Hunter 3, 중간. 원문 확장 부분 응답을 허용 조회 한도 안에서 이어 읽도록 설명했다.
- Blind Hunter 4, 중간. 스킬 예시와 다른 합성 질문에서 무옵션·단일 프로젝트·단일 워크트리 조회를 다뤘다.
- Blind Hunter 5, 낮음. 공백이 있는 검색어의 셸 인용과 명령 예시 파싱을 보완했다.
- Edge Case Hunter 1, 높음. 합성 데이터가 기존 세션에 섞이지 않도록 했다.
- Edge Case Hunter 2, 중간. `RESULT_TRUNCATED`와 생략 행 수의 차이를 명시했다.
- Edge Case Hunter 3, 중간. 확장이 부분적이면 이어 읽고 남은 제한을 보고하게 했다.
- Edge Case Hunter 4, 중간. 앞뒤 문맥 0으로 실제 반환 범위의 기대 원문·시각·ID를 대조했다.
- Edge Case Hunter 5, 중간. 범위 플래그 단독 실행과 범위 밖 결과를 비교하도록 했다.
- Verification Gap 1, 높음. 기존 페이지 단언은 보존하고 데이터 격리를 수정했다.
- Verification Gap 2, 중간. 생략 0이어도 반환된 행이 잘릴 수 있음을 설명했다.
- Intent Alignment 1, 높음. 합성 검색 검증을 기존 페이지 시험과 별도 fixture로 분리했다.
- Intent Alignment 2, 중간. 순위 추가 후보, 행 생략, 첫 본문 잘림과 원문 안내를 구별했다.
- Intent Alignment 3, 중간. 정적 문구 검증과 실제 CLI 검증에 독립 합성 스킬 행동 확인을 더했다.

## Verification

- 편집 및 리뷰 수정 중 `pnpm build`, `pnpm typecheck`, `git diff --check`만 사용한다.
- 최종 수정 및 독립 리뷰 뒤 `pnpm exec vitest run tooling/bootstrap/test/recall-skill.test.ts tooling/bootstrap/test/cli-skill-coverage.test.ts apps/cli/test/recall.test.ts`를 파일 단위로 실행한다. 전용 시험 DB와 공유 잠금을 사용한다. 실제 운영 표본과 전체 회귀는 중앙 범위다.

## Auto Run Result

대화 recall 스킬에서 연속 리터럴 선택, 사전에 확인된 근접 옵션, 정상 검색 후 근거 부족 시 허용 재질의, 검색과 원문 응답의 제한 및 출처 확인을 안내한다. 파일 변경은 배포 스킬, 스킬 예제의 CommandSpec 검증, 별개 합성 질문을 쓰는 실제 CLI 시험, 티켓 등록과 이 계획이다.

- 네 가지 Sol 독립 리뷰의 지적을 반영했다. 수정 뒤 별도 Sol 확인에서 세 합성 시나리오의 스킬 행동과 리뷰 반영을 점검했다. 명시 프로젝트에서 검색 2회와 출처 기반 읽기 4회, 무범위에서 0건 뒤 허용 재질의, 검색 오류 때 재질의 없이 중단을 호출 로그와 대조했다. 이 행동 확인은 합성 응답 어댑터를 사용했다. Orca가 추가 리뷰의 완료 영수증을 `worker_identity_changed`로 거부했다. 독립 리뷰 원문과 호출 로그는 지휘자가 직접 검증했다.
- `pnpm build`, `pnpm typecheck`, `git diff --check`가 통과했다. 마지막 소스·시험 수정 뒤 위 세 Vitest 파일에서 17개 시험이 통과했다. 별도 PostgreSQL에서 실제 CLI와 배포 스킬 커버리지를 확인했고 DB·컨테이너와 공유 잠금의 정리를 확인했다.
- 17.7의 최초 2/10, 보정 4/10 및 수락선 7/10을 유지했다. 이 작업에서 별도 운영 표본·운영 설치·릴리스·전체 회귀는 실행하지 않았다. 제품 검색·SQL 및 건강 절의 변경이 없다.
