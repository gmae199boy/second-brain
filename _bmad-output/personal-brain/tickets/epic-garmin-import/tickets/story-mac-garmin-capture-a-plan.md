---
title: '이 Mac의 설치본에서 새 Garmin capture를 규칙 A로 반입하고 전수 검증'
type: 'feature'
ticket: 8
created: '2026-11-03'
status: blocked
baseline_revision: 'e33a78718d6fefda38312c98f2ca2428b9bf0b97'
route: 'full'
route_source: 'pinned'
risk: 'high'
review: 'thorough'
review_source: 'pinned'
lenses_ran: [blind-hunter, edge-case-hunter, verification-gap, intent-alignment]
review_loop_iteration: 2
followup_review_recommended: false
context: []
warnings: [oversized]
deferred: []
operator_actions:
  - >-
      티켓 브랜치 push와 중앙 main 병합 후 원격 marketplace에 plugin version 갱신을 반영한다. 로컬 공식 bootstrap 설치본 갱신과 Garmin 설치는 성공했다.
blocked_at: "2026-11-03"
blocked_reason: "사용자 strict gate 유지: raw profile 증거가 없는 보관 후보 1개의 Garmin 계정을 확인할 수 없어 실제 import·전수 verify 미실행"
---

<intent-contract>

## Intent

**Problem:** 14.1~14.6의 구현이 이 Mac의 플러그인 설치본에서 새 일관 capture를 실제 반입하고 전수 대조한 근거는 아직 없다.

**Approach:** 기존 반입 계약을 유지하면서 플러그인을 앞선 원격 commit으로 배포하고 version을 함께 올린다. 설치본의 공용 명령으로 Garmin 설치, read-only 새 capture, 이전 LATEST 차이, preflight, 규칙 A·계정 확인, 작은 batch import, verify를 순서대로 수행한다. 공개 plan에는 공개 집계와 값 없는 성공 여부만 남긴다.

## Boundaries & Constraints

**Always:** 원래 baseline과 첫 실패 기록을 보존한다. 실제 상세·계정·날짜·해시·capture 경로·doctor/조회 출력은 Brain 홈의 private 데이터 아래에만 기록한다. SQLite 원본은 URI mode=ro의 backup API로 복제하고 파일은 복사 전후 hash가 같아야 한다. 옛 writer는 멈추지 않는다. dataset 역할은 명시 분류로만 정하고 v1 순서는 D2→D1→D4→D5→D3이다. 계정은 raw profile id로 확인한다. 같은 capture·dataset·batch로 재개한다. 승인된 운영 반입과 합성 시험을 구분하고 시험은 compose.test.yaml의 127.0.0.1:54329만 사용한다. 필수 확인·독립 리뷰·필요 후속 리뷰 뒤 built로 남기고 티켓 브랜치를 정상 push한다.

**Never:** 원본 normalize/migration/쓰기, 옛 writer 중지, 계정·metadata 추측, 실제 데이터 fixture 반입, 공개 상세 출력, main 병합·push, 에픽 전이, force push·훅 우회, 기존 bmad-loop helper 사용. 미확인 계정·미선택 충돌·파일 요청 대기·verify 불일치를 성공으로 처리하지 않는다. 기능 결함 발견 시 개인 값 없는 원인 분류와 버그 스토리를 남겨 수정하고 같은 batch로 재개한다.

</intent-contract>

## Code Map

- `plugin/app-ref`, `plugin/.claude-plugin/plugin.json`, `plugin/bin/session-start.sh`, `plugin/bootstrap.mjs` — 현재 ref와 설치 commit은 이전 배포다. 앞선 원격 baseline을 ref로 쓰고 version을 함께 올린 다음 플러그인의 bootstrap 설치 경로를 사용한다. hook은 queue drain도 실행하므로 반입에 필요 없는 외부 수집/발신을 열지 않게 실행 경로를 확인한다.
- `extensions/garmin/src/capture_manifest.py` — version1은 datasets(dataset/source/snapshot), files(source/snapshot/bytes), capture_id/version을 엄격 검사한다. version2는 명시 dataset/artifact_key/category·관계·metadata·inventory가 필요하다. 원래 private manifest는 이 형식과 다르므로 추측 변환하지 않고 명시 source descriptor를 작성한다.
- `extensions/garmin/src/{reader,preflight,batch_import,analyses,artifacts,import_verify,verify_compare,reports}.py` — reader의 원문/NULL codec, source fingerprint·dataset/batch checkpoint, 원자 file handoff, 규칙 A·profile 계정, private/public projection을 재사용한다. verify는 source/target 전수·비발신을 검사하고 실패는 종료 코드로 전파한다. 기존 core/garmin migrations와 원형 계약은 변경하지 않는다.
- `apps/cli/src/{commands/ext-run,daemon/supervisor,runtime/import-verification}.ts`, `packages/core/src/extensions/run.ts` — 설치 manifest의 수동 일감 enqueue·30초 결과 관찰·현재 attempt와 출처 전용 private snapshot 경로다. 오래 걸리면 같은 work를 확인하고 새 batch를 만들지 않는다.
- `apps/cli/python-test/garmin-import-verify.test.ts`, `extensions/garmin/tests/fixtures.py`, `tooling/test-db/`, `compose.test.yaml` — 합성 설치·데몬·시험 PG 기반이다. 운영 홈과 혼용하지 않는다.
- 신규 `tooling/garmin-import/capture.py`, `tooling/garmin-import/test_capture.py` — live 원본을 안전하게 복제하고 immutable capture·private manifest/파일 hashes·이전 목록/건수 차이를 만드는 좁은 운영 보조 도구. Python 3.14 표준 라이브러리만 사용하며 외부 수집·모델·발신 경로는 없다.

## Tasks & Acceptance

**Execution:**
- [x] `tooling/garmin-import/capture.py` — 명시 source descriptor와 새 output directory를 입력받아 read-only SQLite backup, 파일의 복사 전후 스트리밍 hash 확인, private 0700/0600 manifest 및 전수 digest/이전 비교 보고를 만든다. DB는 후보마다 일관 snapshot이며 writer 전체가 원자적으로 멈췄다고 주장하지 않는다. 결과는 기존 load_capture가 읽을 수 있는 형식이고, 입력 원본 경로와 digest·상세는 별도 private 보고서에만 둔다. output 기존 데이터 덮어쓰기·출처/목적 경계 탈출·symlink를 거부하고 실패 후 미완료를 재사용 가능한 capture로 공표하지 않는다. source descriptor는 version1/2 정상 manifest에 명시한 snapshot을 실제 원본 경로로 대응시킨 별도 private 설정이며 dataset/source/category/관계를 추측하지 않는다. 이전 capture 비교는 기존 private manifest와 새 capture의 목록·DB 표별 건수로 남긴다. CLI stdout/stderr는 값 없는 성공/오류만 내고 상세 예외는 private에 저장한다.
- [x] `tooling/garmin-import/test_capture.py` — 합성 WAL writer가 열린 상태에서 snapshot 일관성·원본 보존, 파일 변경 감지, 잘못된 경로/기존 output 거부, load_capture 호환·공개 출력의 개인 표식 부재·private 권한·이전 목록/건수 차이를 검증한다. 실데이터에 접근하지 않는다.
- [ ] `plugin/app-ref`, `plugin/.claude-plugin/plugin.json` — 지휘자가 검증된 앞선 원격 commit과 version 증가를 같은 commit에 반영한다. 원격이 필요한 단계는 operator_actions로 기록한다.
- [ ] 이 계획과 Brain 홈의 private 운영 기록 — 지휘자가 설치본에서 `brain ext install garmin`, 새 capture/이전 LATEST 비교, `brain ext run garmin import-preflight`, 계정/규칙 확인, `brain ext run garmin import`, 파일 요청 확정, `brain ext run garmin import-verify`를 수행한다. 같은 batch 재실행과 capture 파일 전수 hash 불변, raw/current view 읽기·비발신 0을 확인한다. 구현자는 소스·시험만 편집하고 실제 운영 실행·계획 전이·commit/push는 지휘자가 수행한다.
- [ ] 이 계획의 공개 검증·리뷰 근거와 `.brain-automation/ticket-14.8-report.md` — 독립 thorough 및 필요한 후속 리뷰를 마치고 공개 집계만 commit한다. 실제 상세 보고 경로는 private 운영 기록에서 찾으며 공개 문서에 넣지 않는다.

**Acceptance Criteria:**
- Given 플러그인 배포로 갱신된 이 Mac 설치본, When 공용 Garmin 설치와 새 capture부터 verify까지 순서대로 한 번 실행하면, Then 모든 단계 상태와 공개 projection이 plan에 있고 verify의 모든 checks가 참이며 미완료 파일 요청·미선택 충돌은 없다.
- Given 계속 실행 가능한 옛 writer와 명시한 원본들, When read-only backup 및 복사 전후 hash 확인으로 capture를 만들고 반입하면, Then 이전 LATEST와의 목록/건수 차이가 private에 남고 반입 전후 새 capture 전체 파일 hash가 같다.
- Given 규칙 v1과 raw profile 계정 증거, When preflight에서 대응을 확인하고 같은 batch import를 재실행하면, Then 계정이 확인되고 기준 A가 적용되며 기존 자료가 덮이거나 중복되지 않는다.
- Given 완료된 실제 반입, When 채널 발신 요청·channel_send 일감과 raw/current view를 조회하면, Then 발신 요청·일감은 0이고 양쪽 view 읽기가 성공하며 plan에는 수치/개인 값 없이 성공 여부만 있다.
- Given 공개 문서·Git index·commit 후보, When private 전수 대조 요약과 별개로 유출 검사를 수행하면, Then capture·private 보고서·계정·개인 날짜·해시·홈 절대 경로가 없고 공개 projection만 있다.


### 독립 리뷰 1차에 따른 보강

- source/descriptor/previous/output 경계를 문자열 검사 이후 다시 열 때 잃지 않도록 fd 기반 no-follow 및 파일·부모 identity 검사를 적용한다. 원본 SQLite는 계속 mode=ro backup이며 live WAL writer를 중지하지 않는다.
- Mac 대소문자 비구분 파일시스템에서도 DB 대상을 배타 생성해 서로 다른 snapshot 경로가 같은 파일로 해석되면 공표하지 않는다.
- 중첩 snapshot 디렉터리는 각 구성요소마다 0700을 보장한다. KeyboardInterrupt는 private 로그와 값 없는 오류 표식/종료 코드로 처리한다.
- 합성 회귀는 검사 이후 symlink/부모 교체, 대소문자 DB 충돌, 깊은 경로+umask 022, Ctrl-C, 게시 직전 생긴 빈 목적지 보존, 비어 있지 않은 added/removed 양방향 목록, 보고서 SHA-256 전체 key 집합·독립 해시 일치를 다룬다.

## Implementation Notes

- 사용자 결정(중앙 전달): raw profile 계정 귀속을 확인할 수 없는 후보는 실제 반입하지 않는다. strict gate를 유지하고 로그인 요청이나 타 후보 기반 추정으로 우회하지 않는다. 실제 import·전수 verify는 미완료이며 티켓 built 조건을 충족하지 않는다. capture 도구의 독립 리뷰 수정·비운영 검증은 계속한다.


- 명시 descriptor 기반 read-only backup·private capture 도구와 합성 시험을 구현했다. 지휘자가 재현한 WAL 보조 파일 문제를 수정해 복제 대상만 standalone journal로 확정한다. 합성 시험 5건 통과.
- 플러그인 ref는 원격에 이미 존재하는 원래 baseline으로 올리고 version을 함께 증가시켰다. 공식 bootstrap으로 설치본 commit 일치와 공용 Garmin 설치 성공을 확인했다. 원격 marketplace에 새 version 배포는 티켓 branch push 및 중앙 병합 이후 단계다.
- 실제 새 capture: DB 5개, 파일 367개. 이전 목록 대비 추가 18개, 제거 0개. WAL 보조 파일 0개. 실제 preflight는 실행됐으나 계정 미확인 1개가 있어 import gate를 보류했다. raw가 없는 보관본의 계정은 추측하지 않는다. 상세는 Brain 홈 private에만 보존했다.

## Plan Change Log


### 리뷰 1차 계획 보강

경로 경계·권한·배타 생성·중단 출력과 보고서 증명의 구체적인 반례가 계획에 빠져 위 보강을 명시했다. KEEP: read-only WAL backup과 복제 대상만 journal 전환, 명시 descriptor v1/v2 의미 보존, private/public 분리, 원자적 no-replace 공표, 기존 합성 시험 전체. 중앙의 최신 지시에 따라 부분 구현을 보존하고 기존 Terra의 후속 Task로 수정하며 코드를 폐기하지 않는다. 실제 import·built는 사용자 계정 gate 답변 전 보류한다.

## Review Triage Log


### 독립 리뷰 1차 — 수정 전 triage
- verdicts: 18 findings — high 3, medium 9, low 0, false 6, maybe-false 0
- findings:
  - `[high]` `[bad_plan]` BH1 검사 후 source 경로 교체 — 문자열 경로를 다시 열어 symlink로 교체한 안정 원본은 세 번의 hash도 통과할 수 있다. no-follow·identity 보강과 회귀를 요구했다.
  - `[medium]` `[bad_plan]` BH2 중간 디렉터리 권한 — umask 022, deep/one/two/file을 지휘자가 실행해 deep가 0700이 아님을 재현했다. 각 구성요소 생성으로 보강한다.
  - `[medium]` `[bad_plan]` BH3 Ctrl-C 출력 — create는 BaseException을 재던지고 main은 Exception만 받아 KeyboardInterrupt의 기본 traceback이 public stderr로 흐른다. 별도 처리·회귀를 추가한다.
  - `[medium]` `[patch]` BH4 added/removed 시험 누락 — 기존 시험은 같은 목록의 added=[]만 확인한다. 서로 다른 양방향 목록의 기대값 검증을 추가한다.
  - `[medium]` `[patch]` BH5 게시 직전 목적지 시험 누락 — 현재 기존 output 시험은 publish 이전에 끝난다. 실제 배타 publish를 거치는 경합 검증을 추가한다.
  - `[medium]` `[patch]` BH6 전수 보고서 digest 시험 누락 — 기존 시험은 보고서 sha256의 key·값을 확인하지 않는다. 독립 hashlib 대조를 추가한다.
  - `[high]` `[bad_plan]` EC1 Mac snapshot 대소문자 충돌 — 현재 볼륨의 대소문자 비구분을 지휘자가 확인했고 sqlite3.connect(target)는 기존 파일을 열므로 DB backup이 앞 대상을 덮을 수 있다. 배타 생성을 보강한다.
  - `[high]` `[bad_plan]` EC2 검사 후 symlink 교체 — BH1과 같은 결함이며 source·부모를 문자열로 다시 여는 지점에 guard가 없다. 같은 수정 묶음으로 해결한다.
  - `[medium]` `[bad_plan]` EC3 깊은 private 권한 — BH2와 같은 재현된 권한 계약 위반이며 같은 구성요소별 생성으로 해결한다.
  - `[medium]` `[patch]` VG1 publish 경합 시험 — 리뷰의 touched-test와 호출 검색 근거를 수락한다. BH5와 같은 시험을 추가한다.
  - `[medium]` `[patch]` VG2 보고서 digest 시험 — 리뷰의 소비자·mutation 근거를 수락한다. BH6와 같은 독립 전수 대조를 추가한다.
  - `[medium]` `[patch]` VG3 추가/삭제 목록 시험 — 리뷰의 added/removed 방향 뒤집기 반례를 수락한다. BH4와 같은 양방향 시험을 추가한다.
  - `[false]` `[reject]` IA1 운영 완료 증거 없음 — 관찰은 맞으나 계획·보고는 in-progress와 계정 gate 보류를 명시해 완료를 주장하지 않는다. 실제 import·verify를 여전히 필수로 유지한다.
  - `[false]` `[reject]` IA2 설치본과 capture 도구 전달 경로 — 기존 install/preflight/import/verify의 설치본 실행과 별도 운영 보조 capture 도구라는 계획의 명시 해석을 따른다. ref의 이전 commit과 version 동시 변경은 정상이다.
  - `[false]` `[reject]` IA3 private 위치는 호출자가 선택 — 범용 합성 도구가 시험 temp root를 허용하는 것은 의도 위반이 아니다. 실제 개인 상세 위치는 지휘자가 Brain 홈 private 하위로 지정했고 저장소 반입을 금지한다.
  - `[false]` `[reject]` IA4 이전 LATEST 자동 식별 없음 — 원문은 에이전트가 이전 LATEST와 비교하라고 요구한다. 명시 --previous와 private 비교 수행으로 충족하며 자동 발견 CLI 요구는 없다.
  - `[false]` `[reject]` IA5 immutable과 권한 의미 — 소유자 쓰기 금지가 원문 조건은 아니다. 전수 hash로 반입 전후 불변을 관찰한다. 실제 반입 후 관찰은 미완료로 남긴다.
  - `[false]` `[reject]` IA6 이력 증거 범위 — 실패 영수증·체크포인트는 gitignored 로컬에 보존했다. 현재 신규 capture 도구 결함은 승인된 티켓 내 수정이며 운영 importer 기능 결함은 아직 관찰하지 않았다. 같은 batch 운영 재개 증명은 아직 남아 있다.

### 독립 후속 리뷰 1차

- 기존 코드·검증 12건 중 10건 해결, BH1/EC2는 부분 해결로 보고됐다. 원래의 지속적 symlink 교체는 거부하지만 표준 SQLite source 연결의 순간 교체/복원은 pinned fd와 동일한 대상을 연다는 무조건 보장이 없다. 신뢰하는 원본 디렉터리·정상 WAL writer를 운영 전제로 하며 이 한계를 없다고 주장하지 않는다.
- `[high]` `[bad_plan]` 목적지 SQLite 절대 경로 연결 — O_EXCL이 pinned 디렉터리에 만든 파일과 sqlite3.connect(target)이 여는 파일은 부모 교체 후 달라질 수 있다. 외부 DB에 쓰고 나서 실패하는 호출 순서가 코드상 성립한다. 목적지는 메모리 backup·직렬화 후 fd 기록으로 바꾸고 연결 시점 부모 교체 회귀를 추가한다. KEEP: 나머지 fd 기반 복사·배타 게시·정리와 합성 12건.

## Verification

- `python3.14 -m unittest discover -s tooling/garmin-import -p 'test_*.py' -v` — 합성 capture 검증 통과.
- `pnpm install --frozen-lockfile` — 필요한 의존성 준비.
- `pnpm build` 및 `pnpm typecheck` — build/type 성공.
- `pnpm exec vitest run --config apps/cli/python-test/vitest.config.ts apps/cli/python-test/garmin-import-verify.test.ts` — 기존 실제 설치·감독자·합성 verifier 회귀 통과. 시험 PG는 지정된 test 전용 인스턴스뿐이다.
- 위 Execution의 설치본 공용 명령과 private 전수 대조 — 실제 수락조건을 관찰한다. 공개 plan에는 projection/건수/성공 여부만 append한다.
- `git diff --check`, staged diff·추적 파일 유출 확인 — 공백·개인 정보·실데이터 없음.

재실행은 private 기록의 같은 capture descriptor·manifest·설정과 batch 식별자를 복원하고, source hashes가 같음을 확인한 뒤 같은 `import`를 실행하고 파일 요청 확정을 기다려 `import-verify`를 다시 실행한다. 입력이 바뀌면 기존 checkpoint 재사용으로 우회하지 않는다. 오류가 있으면 원인 분류·버그 수정과 재검증 전까지 미완료다.

## Auto Run Result

상태: `blocked`. 사용자가 strict 계정 gate를 유지하라고 결정했다. raw profile이 없는 보관 후보 하나의 Garmin 사용자 귀속은 확인할 수 없으며 다른 후보에서 추정하지 않았다. 실제 import와 import-verify를 실행하지 않았으므로 built/done으로 올리지 않았다. 최초 차단 보고 후 중앙의 명시 승인에 따라 검토 완료 소스·시험·계획과 짝인 ref/version 변경을 보존 커밋으로 남겨 티켓 브랜치에 push한다. 이 보존 작업은 티켓 완료를 의미하지 않는다.

### 실제 단계와 공개 집계

| 단계 | 결과 | 공개 근거 |
| --- | --- | --- |
| 공식 plugin bootstrap | 성공 | 요청한 앞선 원격 baseline과 설치본 commit 일치. ref/version 후보 동시 변경 |
| 설치본 Garmin 설치 | 성공 | 공용 ext install 성공 |
| 새 capture | 성공 | DB 5개, 파일 367개, 이전 목록 대비 추가 18개·제거 0개, WAL 보조 파일 0개 |
| 실제 preflight | gate 미충족 | rows 94,911, conflict_keys 237, raw_conflict_keys 18, raw_metadata_conflict_keys 27, unselected_keys 0, excluded_keys 0, unconfirmed_accounts 1, expected_file_requests 365. 명령 exit 0이나 total_insert_known=false이며 반입 승인/성공으로 해석하지 않음 |
| 실제 import·같은 batch 재실행 | 미실행 | 사용자 strict gate에 따라 보류 |
| 파일 요청 확정·실제 import-verify | 미실행 | import 이전 단계에서 보류 |
| 생성 후 capture 전수 digest 대조 | 일치 | 명시 snapshot 및 manifest 373개 항목 일치. 반입 후 대조를 했다는 의미는 아님 |
| 발신 현황 읽기 전용 집계 | 요청·일감 0 | 실제 import 일감 0, verify 일감 0, channel_send 일감 0, outbound 요청 0. 완료된 반입의 비발신 검증을 대신하지 않음 |
| 운영 raw/current view의 반입 결과 읽기 | 미검증 | 실제 반입이 없으므로 수락 근거로 주장하지 않음 |
| 종료 시 Garmin 확장 | 비활성 | 이번 설치의 자동 수집 예약도 보류. 원본 Garmin writer는 중지하지 않음 |
| capture·private 보고서 Git 혼입 | 없음 | 추적/index/변경 후보 검사. 실제 자료는 Brain 홈 private에만 보존 |

### 변경·검증과 리뷰 판정

- `tooling/garmin-import/capture.py`: 명시 descriptor, live SQLite read-only backup, 메모리 snapshot 직렬화 후 fd 쓰기, 파일 전후 hash, private 보고, 배타 게시와 소유 stage 정리.
- `tooling/garmin-import/test_capture.py`: 합성 WAL writer, path 교체, 목적지 경합, Mac 대소문자 충돌, private 권한, Ctrl-C, 양방향 목록 비교와 전수 digest 기대값.
- plugin 두 파일: 앞선 원격 baseline ref와 version 증가 후보. 짝을 같은 보존 commit에 포함한다. 티켓 blocked는 유지한다.
- 지휘자 최종 실행: `python3.14 -B -m unittest discover -s tooling/garmin-import -p 'test_*.py' -v` — 13건 통과. Mac 대소문자 충돌 시험도 실행됐다. `git diff --check` — 통과.
- 최초 구현 워커 증거: `pnpm install --frozen-lockfile`, `pnpm build`, 빌드 후 `pnpm typecheck` 통과, 지정 Garmin 통합 vitest 10건 통과(127.0.0.1:54329 시험 전용 PG). 후속 수정은 capture 도구와 그 합성 시험에 한정됐다.
- 독립 thorough 4개와 후속 독립 리뷰 2회를 수집했다. 초기 코드·검증 지적 12건과 후속 목적 DB 외부 쓰기 1건을 수정·회귀 검증했다. 최종 재리뷰는 지정 운영 전제 아래 추가 실제 결함 없음으로 보고했다. 최초 의도 관찰 6건의 reject 근거는 Review Triage Log에 보존했다. 미충족 운영 gate를 defer하지 않았다.
- BH1/EC2는 신뢰하는 원본 디렉터리와 정상 WAL writer라는 운영 전제에서 해결로 판정한다. 표준 SQLite가 경로를 다시 열기 때문에 권한 있는 주체의 순간 교체·복원까지 무조건 차단한다는 보장은 없다. snapshot 크기에 비례하는 메모리 비용과 Linux 실행 미실증도 남는 한계다. 마지막 독립 리뷰 이후 추가 코드 수정은 없다.

### 재개 조건

계정 근거와 사용자 strict gate를 충족하기 전에는 실제 반입하지 않는다. 로그인 자격이 없다는 문제로 오인하지 않는다. 같은 private capture와 descriptor·dataset 식별자를 보존했으며 아직 import batch는 만들지 않았다. 허용된 재개에서는 보존 capture의 전수 hash와 계정 증거를 다시 확인하고 수집 예약을 별도로 보류한 상태에서 수동 반입 준비를 한다. 최초 반입 후에는 capture·dataset에 의해 결정된 같은 batch로 import를 재실행하고 파일 요청 확정 후 import-verify를 수행한다. legacy 대화 대응도 반입 전에 확인해야 한다. 원격 marketplace 배포와 main 병합·push는 중앙 처리 범위로 남는다.

### 차단 부분 결과 보존

중앙이 최종 차단을 수락한 뒤 검토 완료 공개 부분 결과의 stage·commit·origin 티켓 브랜치 push를 명시 승인했다. 코드 추가 수정 없이 계획의 차단 상태와 근거를 유지하고 소스·시험·짝인 plugin ref/version을 보존한다. 정상 훅을 적용하며 private 자료는 포함하지 않는다. 실제 반입·verify·built/done·main 병합·에픽 전이는 수행하지 않는다. 원격 marketplace version 배포는 중앙의 main 반영 이후 단계다. 보존 commit과 원격 SHA는 로컬 최종 보고서에 기록한다.
