# 외부 리뷰 검증: 기획 문서와 스키마 (2026-10-16)

- **출처:** Gemini가 `bmad-review`(adversarial, edge-case-hunter, structure, prose 렌즈)로 기획 문서 전체와 마이그레이션을 검토했다. 그 주장 41개를 읽기 전용 조사 세 갈래로 저장소와 대조했다.
- **용도:** `bmad-correct-course`와 `bmad-ticket`(epic 2 티켓 보강, 이후 에픽 Notes)의 입력이다.
- **판정:**
  - **맞음** — 주장대로의 빈틈이다.
  - **일부** — 실제 문제는 있지만 과장됐거나 다르게 설명됐다. 실제 내용을 적는다.
  - **다룸** — 다른 티켓·문서·결정이 이미 맡고 있다.
  - **틀림** — 저장소가 반대 증거를 갖고 있다.
- **경로:**
  - `ARCH` = `architecture-brain-v1-slice-1/architecture-brain-v1-slice-1.md`
  - `M1` = `packages/sqlite/migrations/0001_initial.sql`
  - `M2` = `packages/sqlite/migrations/0002_files_and_work.sql`
  - `E2T` = `epic-capture/tickets.toml`
  - 나머지는 initiative 폴더 기준 상대 경로다.

## 함께 반영할 결정 (2026-10-16, story 2.2 계획 중 사용자 결정)

- `sessions.user_id`는 요구사항에서 온 칸이 아니다.
  - 2026-10-08에 팀 공유 대비 장치로 넣었다(`architecture-brain-v1-slice-1/.memlog.md` 49·52행).
  - 사용자 테이블이 없고, 값의 출처도 정해지지 않았다.
- 결정: `users` 테이블을 둔다.
  - 칸: `id` UUIDv7 PK, `name` = OS 사용자 이름, `is_self`(1인 행은 하나뿐), `created_at`
  - `sessions.user_id`는 `users.id`를 FK로 가리킨다.
  - "나" 행은 `setup run`이 마이그레이션 직후 찾거나 만든다.
- 마이그레이션 번호: story 2.2가 0003을 쓴다. 그러면 story 2.6의 마이그레이션은 0004, 스키마 버전 4가 된다.
- ID는 UUIDv7을 유지한다(ULID로 바꾸지 않음).
- 정체성은 DB와 함께 옮겨진다. 두 DB 합치기는 epic 5 가져오기 몫이다. 이때 들어오는 "나"를 받는 쪽 "나"로 바꾸고, 파생물은 다시 만들고, 스키마 버전부터 맞춘다. `users.name`을 바꿀 수 있는지도 그때 정한다.
- 고칠 문서:
  - AD-12, Table Contract(`users` 행, `sessions.user_id` FK), ER 다이어그램
  - PRD §6.2의 "세션에 사용자 칸" 문구
  - Conventions 오류 코드 `USER_MISSING`(exit 2)
  - story 2.6 티켓 문구
- 계획: `epic-capture/story-tracer-stop-hook-brain-db-plan.md`(draft)

## 1. 맡은 곳이 없는 빈틈

| ID | 내용 | 판정 | 근거 | 맡을 곳 |
|---|---|---|---|---|
| S1 | 브랜치를 저장할 칸이 없다 | 맞음 | PRD FR-3은 "임의의 메시지에 대해" 브랜치를 답하라고 한다(PRD:65·107). transcript는 줄마다 `gitBranch`를 가진다(research §4). 2.7 parser는 브랜치를 내지만(E2T:78), 0003 목록(E2T:67)과 AD-12에 저장 칸이 없다. | 2.6 또는 2.7. 메시지 칸이 PRD에 맞다. 세션 칸으로 정하면 2.2의 `sessions` 재생성에 넣을 수 있다 |
| T1 | epic 7·8의 `after`에 epic-daemon이 없다 | 맞음 | 9를 7 앞에 두는 것은 initiative `tickets.toml`의 표 순서뿐이다(56·63행). `tickets.py`는 표 순서를 `order_conflict` 보고에만 쓴다. epic 8은 Notes(initiative:64)에서 Drive 동기화가 9를 기다리지 않게 했지만, Done when(initiative:65, epic-drive:39)은 데몬 켜짐·꺼짐 둘 다를 요구한다. 모순이다. | 티켓 정리 |
| T12 | `*.claiming` spool 파일을 다시 집는 규칙이 없다 | 맞음 | ARCH:169와 2.10(E2T:114)은 rename → 재주입 → 성공 시 삭제만 정한다. epic 5의 "청구 만료 회수"는 `work_items` 이야기다. | 2.10 |
| T13 | spool 작업 로그의 유실 | 일부 | `failures`에 payload를 두지 않는 결정은 transcript·파일 대상에만 적용된다(epic-capture:100). spool 파일은 성공할 때만 지워지므로 "영구 유실"은 과장이다. 실제로는 T12 때문에 `.claiming`에 갇힌다. AD-21의 10회 정지도 spool 레코드용 규칙이 없다. | 2.10, 2.12 |
| S9 | 추출 도중 죽은 세대가 재추출을 영원히 막는다 | 맞음 | 0003·Table Contract는 파일당 진행 중 세대를 하나로 둔다(ARCH:406). AD-21은 "진행 중 세대가 있어 건너뛰기는 실패가 아님"이라 한다(ARCH:310). 그래서 조용히 영원히 건너뛴다. WeKnora D4(남은 running 정리)는 `work_items`에만 걸려 있다. | epic 10 |
| S10 | 실패한 세대의 조각·FTS가 남는다 | 일부 | 검색은 `current_extraction_id`만 쓰므로 섞이지 않는다(ARCH:337·340). 하지만 실패한 세대의 부분 조각을 정리하는 규칙이 없고, 그 조각이 내보내기에 들어간다(ARCH:342). | epic 10 |
| S13 | `files.redact`가 `file_names`·`file_metadata`를 지우지 않는다 | 맞음 | AD-23 연쇄(ARCH:332)에 없다. `file_names`는 다시 만들 수 있으므로(ARCH:408), 가린 파일은 재생성에서 빼는 규칙도 필요하다. | epic 10 |
| T14 | Drive append-only 복제본에 가린 비밀이 평문으로 남는다 | 맞음 | AD-10이 Drive 복제본을 기계별 append-only 파일로 정한다(ARCH:183). 가리기 연쇄와 계약 테스트(ARCH:197-198)에 복제본이 없고, AD-22는 값을 복사만 한다. Drive DB 스냅샷(epic-drive:30)도 가리기 전 본문을 담는다. **보안 항목.** | epic 7·8, AD-11·22 |
| T4 | 문서 조각의 앞뒤를 읽는 명령이 없다 | 맞음 | `recall expand`는 대화 조각만 다룬다(ARCH:106·246). 문서는 `files.show`(메타데이터)뿐이다. | epic 4 인셉션 |
| T11 | 데몬이 버전 불일치에 무조건 종료한다 | 맞음 | AD-26(ARCH:360)은 클라이언트가 옛것이어도 종료한다. 오래 떠 있는 옛 클라이언트(업그레이드 전의 `mcp serve` 등)가 있으면 재시작 루프가 된다. 좁은 경우다. | epic 9 |

## 2. 정의 보강이 필요한 것

| ID | 내용 | 판정 | 실제 내용 | 맡을 곳 |
|---|---|---|---|---|
| S11 | 10번 실패한 일감의 행 | 일부 | AD-21은 "failures에 기록하고 멈춘다"(ARCH:310)뿐이다. 행에 `completed_at`을 채우는지 정해지지 않았다. 열린 채 두면 미완료 UNIQUE(M2:78-79)가 같은 대상의 새 일감을 막는다. `sessions retry`(2.12)가 있으므로 "영원히"는 과장이다. | 2.11 |
| S8 | drain 정렬과 인덱스 | 일부 | 2.11은 `attempts ASC, id ASC`(E2T:125)인데 인덱스는 `next_attempt_at`뿐이다(M2:83-84). 그 주석은 "가장 이른 due"라서 순서 정의도 어긋난다. "C8 테스트가 실패한다"는 틀렸다. C8은 epic 4 검색 질의에만 들어왔다. | 2.11 |
| S5 | `files`↔`file_locations` 순환 FK와 복구 | 일부 | 순환은 맞다(M2:107·146). `defer_foreign_keys`만으로는 풀리지 않는다(BEFORE INSERT 포인터 trigger가 즉시 검사, M2:365-398). 포인터를 null로 넣고 나중에 갱신하는 두 단계면 되고 테스트도 그렇게 한다(schema-files.test.ts:175-189). Conventions의 "의존 순서대로 insert"(ARCH:451)에 이 순서가 없다. | epic 5, Conventions |
| T5 | 규칙만으로 10,000자를 넘을 때 | 일부 | AD-17은 블록 전체 상한, 오래된 로그부터 자르기, 규칙 경고선을 정한다(ARCH:268). 규칙만으로 상한을 넘는 경우가 정의돼 있지 않다. 넘으면 Claude Code가 출력을 파일 경로와 2,000자 미리보기로 바꾼다(research §1). | epic 3, AD-17 |
| T7 | `daemon start` 부재와 "데몬 켜짐"의 기준 | 일부 | 동사가 run·status·stop뿐이고(ARCH:112), stop은 주기 Label을 되살리지 않는다(ARCH:352). "모든 백그라운드가 멈춘다"는 과장이다. SessionStart hook의 drain은 남는다(ARCH:131·147). "데몬이 켜져 있으면"이 설정 기준인지 살아 있는 소켓 기준인지는 정해지지 않았다(ARCH:148·369). | epic 9, AD-7·25 |
| T2 | node를 못 찾을 때의 조용한 실패 | 일부 | 런처 순서와 `|| exit 0`(ARCH:288-289), 버전 관리자 Deferred(ARCH:539)는 맞다. 설치 뒤에는 doctor의 node-path와 마지막 hook 시각이 드러낸다. 정말 조용한 경우는 하나뿐이다: 플러그인을 먼저 설치했고 node가 버전 관리자 안에만 있을 때. | 2.5 |
| T3 | 설치 잠금 회수 문구 | 일부 | ARCH:288 "pid가 없거나 시작 시각이 30분을 넘으면 stale"은 모호하다. AD-27은 같은 규칙을 "pid 생존"으로 가리킨다(ARCH:368). 문구만 고치면 된다. | AD-19, 2.5 |
| T15 | 폴더 스캔 범위 | 일부 | research §4는 `subagents/`·`tool-results/` 구조를 적었다. 하지만 2.12(E2T:137)와 Notes(epic-capture:84)는 스캔을 최상위 `<session-id>.jsonl`로 한정하지 않는다. parser가 사이드체인을 버리고 서브에이전트 파일은 부모의 `sessionId`를 쓰므로, 세션을 파일 이름으로 정할 때만 가짜 세션이 생긴다. 2.7이 최종 보고를 읽으러 서브에이전트 파일을 일부러 볼 수도 있다. | 2.12 (2.7과 함께) |
| T10 | 복구의 확인 기준 | 일부 | initiative Done when 4와 spec CAP-12는 메시지·로그 건수만 본다. epic-operations:31은 추출 세대를 더했지만, `files`·`file_locations`·`file_metadata`·Brain 소유 블롭의 복구를 확인하는 Done when은 어디에도 없다. | epic 5, spec·initiative 문구 |
| S3 | `sessions.first_prompt` 칸 | 일부 | 칸은 없다. 하지만 FR-9는 "첫 요청으로 보인다"만 요구하고(PRD:166), seq가 가장 낮은 사용자 메시지에서 꺼낼 수 있다. 저장하면 `messages.redact`가 가려야 할 곳이 하나 더 생기므로, 꺼내 쓰는 편이 낫다. 어느 쪽인지 문서에 적혀 있지 않다. | epic 4 |
| S2 | 규칙 인용 칸(`quote_*`) | 일부 | "AD-14가 깨진다"는 과장이다. 위치는 저장된 본문 위의 대조 입력이고, 고유하면 위치 없이도 맞는다(ARCH:231). 진짜 빈틈은 대조 대기(`pending`) 규칙의 출처 메시지를 적어 둘 자리가 없다는 것이다(review-rubric.md:38에서 지적됐다가 빠짐). | epic 3 인셉션 |
| S12 | 비PDF 조각의 `page` 사본 비교 | 일부 | SQL 설명이 거꾸로다. `=` 비교는 NULL을 통과시켜, 거부가 아니라 불일치를 놓친다. 저장소 관례는 이미 `is`다(M1:320, M2:305). AD-24 규칙은 Store(TypeScript) 규칙이므로, 남는 위험은 null과 "없음"의 비교다. | epic 10 |

## 3. 이미 다루는 것

| ID | 내용 | 맡은 곳 |
|---|---|---|
| S4 | `failures`에 세션 없는 실패의 키 | 2.11(epic-capture:82·101, E2T:125). 주의: 0003이 2.11보다 앞서므로, 2.11이 nullable을 고르면 `failures`를 다시 재생성해야 한다. |
| S6 | 새 메시지 칸이 불변 trigger를 우회 | 2.6 티켓 "불변 trigger가 새 칸도 막음"과 그 verify(E2T:67-68). 일반 UPDATE는 표시가 없어 이미 거부되고, 우회는 가리기 안에서만 가능하다. |
| S7 | `redactions` nullable 전환에 재생성이 필요 | 2.6(E2T:67, deferred). 재생성 방식은 0002 `index_configs`에 본보기가 있다(M2:490-558). |
| T6 | spool의 로그·주입 기록 재주입 | epic 3 Done when 4·7(epic-log-and-context:32·35), ARCH:269. 틀은 2.10. |
| T8 | `second_brain`의 postgres 재export로 생기는 시작 지연 | 회고 G2(+8.7ms)와 Action 9 → 2.15(E2T:173-174). |
| T9 | 미러 파일명 정제(C9) | epic 4(epic-recall-and-mirror:22). spine AD-16(ARCH:256) 문구가 뒤처져 있다. 부수 사항: " (2)" 충돌 접미사는 AD-16의 "순수 함수"와 어울리지 않는다. |
| P1 | README "질문 두 개" 뒤에 임베딩 질문이 나오는 모순 | 2.4(E2T:43). 코드는 세 번째 질문을 한다(install/flow.ts:387). |
| S14 | `redactions` 위치 기준 | story 1.3에서 "가리기 직전 본문 기준"으로 정했다(M1:227-232, core `domain/redaction.ts:12`, epic-foundation-and-install/story-trigger-plan.md:103). AD-11은 다시 적지 않는다. 리뷰의 "모호하다"는 틀렸다. |

## 4. 틀린 것

- **S12의 SQL 부분:** 위 2절 참고.
- **S8의 "C8 테스트 실패":** C8은 drain 청구에 쓰이지 않는다.
- **P2:** spine 239행의 큰따옴표는 코드 스팬 안에 있다.
- **P3·P4:** 사실과 어긋나지 않는다("그 창에서", "It waits for nobody"). 문체 문제다.
- **S14:** 위 3절 참고.

## 5. 문서 구조

| ID | 내용 | 판정 | 실제 내용 |
|---|---|---|---|
| R4 | spine ER 다이어그램이 옛 14개 테이블만 그린다 | 맞음 | Table Contract는 24개다(ARCH:386-411). 빠진 것은 `transcript_files`, 파일 테이블 7개, `work_items`, `schema_version`이다. AD-6 시퀀스는 `participant PG as brain.db (SQLite)`(ARCH:127)다. |
| R9 | PRD FR-24 도구 목록에 파일·문서 명령이 없다 | 맞음 | PRD:317에 없다. AD-5(ARCH:105-107)는 `recall docs`, `files show·url·redact·reindex`, `admin reindex`를 둔다. |
| R11 | change 문서 두 개에 "반영 완료 기록" 안내가 없다 | 맞음 | 둘 다 frontmatter가 `status: approved`뿐이다. 반영 사실은 맨 아래 로그에만 있다. |
| R3 | PRD addendum §2에 옛 Postgres 스케치가 남아 있다 | 일부 | 23-68행: `jsonb`, `only_project_id`, `ingest_failures`, `vector(1024)`. `pg_dump`는 §3(77행)이다. 3행 배너 "spine이 우선한다"는 SQLite 전환 전 날짜다. |
| R1 | 에픽 Description이 날짜별 패치 로그다 | 일부 | 다섯 에픽 모두 날짜 덧붙임이 있다. 모순은 epic-capture에만 있다: Description 21행과 Notes 79행의 "CLI 규약 보강(스토리 하나)"가 Notes 92행의 1·3 분할과 어긋난다. |
| R6 | initiative Notes에 뒤집힌 결정이 표시 없이 남아 있다 | 일부 | 완전히 뒤집힌 것은 없다. 앞선 노트 둘이 나중 결정에 밀렸다: 57행 npx 진입점(63행에서 플러그인으로), 56행 "경계·순서는 초안대로"(epic 10 추가, 9를 7 앞에). |
| R7 | deferred-work 위쪽 항목에 상태 표시가 없다 | 맞음 | 위쪽 항목은 append-only 설계이고(50행), 처분은 Triage 표에 있다. **리뷰가 놓친 것:** 마지막 항목(2.1의 `DB_UNAVAILABLE` exit 1/2)에 Triage 행이 없다. |
| R8 | PRD §8 Open Questions에 해결된 질문이 섞여 있다 | 맞음 | 4·7은 "[해결]", 3은 "[부분 해결]"로 줄 안에 표시돼 있다. 열린 질문은 1·2·5·6·8이다. |
| R10 | weknora-patterns §1.1 제목이 "epic 2"다 | 일부 | 분할 전 문서다. A1·A10 중 스키마 몫은 epic 2(0003)에 남고, 동작은 epic 10으로 갔다(epic-attachments:25·52). |
| R2 | README에 플러그인 설치 경로가 없다 | 문제 아님 | 플러그인은 아직 만들어지지 않았다(2.5에서 만들고 2.14에서 켠다). README는 오늘 빌드된 것을 설명한다. |
| R5 | epic 1·2의 `covers`에 CAP-14가 있다 | 문제 아님 | 의도적이다. "CAP-14 — 스키마 자리만"이고, initiative 66-67행이 CAP-14를 다섯 에픽에 나눈 결정을 적었다. |

## 6. 적용 순서 제안

1. **`bmad-correct-course`:** 위 "함께 반영할 결정"과 아키텍처·PRD·spec 문구를 반영한다.
   - S1 브랜치 칸의 위치
   - T3 잠금 문구
   - T7 데몬 기준과 `daemon start`
   - T14 복제본 가리기
   - S5 복구 순서
   - T5 규칙 상한
   - T11 버전 불일치
   - R4·R9·R3·R11 문서 정리
2. **`bmad-ticket`:**
   - epic 2 티켓 보강: 2.2에 `users`, 2.6을 0004로, S1 브랜치, 2.10에 T12·T13, 2.11에 S11·S8, 2.12에 T15
   - initiative·에픽의 `after`(T1)
   - 이후 에픽 Notes: epic 3에 T5·S2, epic 4에 T4·S3, epic 5에 S5·T10·DB 합치기, epic 7·8에 T14, epic 9에 T7·T11, epic 10에 S9·S10·S13·S12
   - deferred-work Triage에 R7 누락 행
3. **`/bmad-build 2.2`:** draft 계획을 이어서 진행한다.
