---
title: '16.2 Garmin 인증과 영속 계정 보호'
type: 'feature'
ticket: 2
created: '2026-11-01'
status: in-progress
baseline_revision: 47d280120abbe0d977b1fe61ed9084711d13ad36
route: 'full'
route_source: 'pinned'
risk: 'high'
review: ''
review_source: ''
lenses_ran: []
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: [oversized]
deferred:
  - summary: "검토 필요: [ASSUMPTION] 봉인 bundle의 파일 상한 4096·경로 깊이 64는 실제 배포 package에서 재평가한다."
  - summary: "검토 필요: [ASSUMPTION] 봉인 payload 경로 component 상한 64는 실제 package 구성에서 재평가한다."
  - summary: "검토 필요: [ASSUMPTION] 일반 데이터 frame 1 MiB·JSON 깊이 8·문자열 16384 상한은 실제 부하와 소비자 호환성에서 재평가한다."
  - summary: "검토 필요: [ASSUMPTION] 그룹 응답은 24명, 열거 경합 재조회는 1초, leader 관찰은 10초 상한이며 실제 부하·별도 principal에서 재평가한다."
  - summary: "검토 필요: [ASSUMPTION] broker와 GUI의 동시 세션 상한은 각각 64이며 실제 부하·운영 복구에서 재평가한다."
  - summary: "검토 필요: [ASSUMPTION] 보호 mutation의 claim 경합 재조회는 3회 상한이며 초과 시 실패 닫힘이다."
  - summary: "검토 필요: [ASSUMPTION] 전용 인증 FD의 취소 확인 주기는 50ms이며 실제 UI 연결 검증에서 재평가한다."
  - summary: "검토 필요: [ASSUMPTION] native 인증 세션 전체 TTL 상한은 5분이며 실제 UI·취소 검증에서 재평가한다."
  - summary: "검토 필요: [ASSUMPTION] 보호 bootstrap ACK 대기 상한은 10초로 두며 operator attach/session 제한과 구분한다."
  - summary: "검토 필요: [ASSUMPTION] 봉인 worker 설치 후보는 /Library/Application Support/SecondBrain/libexec/garmin-worker이며 D1 설치·D4 신원 검증 전 활성화하지 않는다."
  - summary: "검토 필요: [ASSUMPTION] UI 준비 재조회는 250ms 주기·15초 상한이며 native host 응답 상한도 15초로 두고 실제 취소·배포에서 재검증한다."
---

<intent-contract>

## Intent

**문제:** 현재 수집기는 합성 client 경로만 제공하며 실제 Garmin 인증과 영속적인 계정 보호가 없다. 잘못된 구현은 MFA·차단 뒤에도 호출하거나 같은 계정의 인증·수집을 겹치게 한다.

**접근:** 라이브러리 login/dump를 사용하는 tokenstore adapter, PostgreSQL 보호 상태, 인증·수집의 공통 계정 직렬화와 허용 목록 오류를 연결한다. 고정된 `full` 경로와 티켓의 `high` 위험도를 유지한다. 대화형 인증 비밀의 전달·권한 경계에 기록된 결정이 없어 구현 준비 게이트를 통과하지 못했다.

## Boundaries & Constraints

**항상:** `garmin.tokenstore` 경로만 snapshot에 담고 기본값은 `~/.garmin-pipeline/tokens`다. 라이브러리만 세션을 읽고 쓰며 폴더 0700·파일 0600을 보장한다. 비밀번호·MFA 입력은 epic 13 인증 단계에서만 받고 같은 client에서 MFA를 최대 3회 시도한다. 최종 identity는 Garmin 로그인 profile의 사용자 profile id이며 최초 확정 전에는 tokenstore 보호 키를 쓴다. 인증·수집은 epic 12 `(source, account)` 직렬화 키를 공유한다. 호출 간 1~2초·날짜 사이 5초와 endpoint별 first-call 실행당 3건을 보존한다. 외부 호출 중 쓰기 트랜잭션을 열지 않고 현재 attempt를 검증하는 쓰기는 2초 이하로 끝낸다.

**금지:** 비밀번호·MFA·토큰·라이브러리 예외 원문을 argv·snapshot·로그·JSONL·failures·계획에 싣지 않는다. 예약·수동·force가 보호를 우회하지 않는다. 날짜 변경·token mtime만으로 해제하지 않는다. 기존 반입 행·권위 v1·core 계약을 덮거나 확장이 일감을 청구하지 않는다. 실계정 호출·운영 tokenstore 읽기·배포·예약 전환은 16.9에 남긴다. 계획 상태·커밋·done은 지휘자/엔진 소유이며 구현 워커는 tickets.py mark를 실행하지 않는다. push하지 않는다.

## I/O & Edge-Case Matrix

| 상황 | 입력·상태 | 기대 관찰 | 오류 처리 |
|---|---|---|---|
| 연속 거부 | 데이터 403 세 번 | 영속 차단 후 남은 호출 0 | 허용 차단 코드·비재시도 |
| 같은 날 재실행 | 429 뒤 예약·수동·force | 로그인 포함 외부 호출 0 | 기존 보호 유지 |
| 다음 날 탐색 | 가짜 현지 날짜 변경 | 탐색 한 번의 성공 확인 후에만 해제 | 다시 차단이면 수동 해제 필요 |
| 인증 보호 | 인증 실패 또는 MFA 필요 | 재인증 성공 전까지 호출 0 | 비재시도 인증 필요 |
| 재시작 | 보호 commit 직후 worker 강제 종료 | 새 attempt에서도 보호와 무호출 유지 | 불확실 상태를 정상으로 간주하지 않음 |
| 저장 실패 | 호출 전 저장 실패 또는 외부 오류 뒤 결과 저장 실패 | 현재 실행·재시작 모두 닫힌 실패 | 선행 영속 호출 의도 없이는 외부 호출 금지 |
| 직렬화 | 같은 계정 인증·collect와 다른 계정 collect | 같은 계정 하나씩, 확인된 다른 계정 병렬 | unknown attempt 키 유지 |
| 비밀·호출 간격 | 합성 비밀·clock/sleeper | 출력·로그·failures 비밀 0, 호출 간 최소 1초 | 원문 진단 제거 |


### 감독자 결정 (2026-11-01, 추천으로 정함; 16.2 escalation 해소)

아래 결정은 전체 요구와 high 위험도를 유지하며 이 스토리에서 공통 인증 경계와 Garmin 보호를 단계적으로 구현한다. 다음의 독립 정적 조사와 28개 반례는 구현이나 시험 통과 증거가 아니다. 각 단계에서 합성 fixture로 검증하고 checkpoint한 뒤 다음 단계로 간다.

1. 위협 범위는 다른 UID와 같은 UID의 미승인 프로세스를 포함한다. OS 관리자/OS 침해는 보장 범위 밖이다. 같은 UID의 임의 코드가 홈·실행물·tokenstore에 접근할 수 있는 기존 배치에서 0700/0600과 UID만으로 안전하다고 주장하지 않는다. OS가 검증하는 실행물·상대 신원과 보호된 UI/broker/worker 및 tokenstore 격리를 구현·검증한다. 지원이나 신원 확인이 불명확하면 비밀 입력과 외부 호출을 실패 닫힘으로 막는다. 현재 라이브러리 login/dump 전용 저장 계약과 경로 선택을 보존한다. macOS XPC/audit-token 등은 구현 가능성을 먼저 검증할 후보이며, 서명된 인터프리터만으로 임의 스크립트를 신뢰하지 않는다.
2. epic 13의 기존 감독 auth만 전용 양방향 인증 채널을 쓴다. 명시적인 operator 진입점과 승인된 UI, broker 및 spawn된 auth worker를 세션·work·attempt·generation·package·OS 신원에 결합한다. spawn 신원 기록과 상호 인증 bootstrap ACK 전에는 prompt·constructor I/O·HTTP가 없다. 비밀은 전용 상속 FD로만 흘리고 argv·env·snapshot·DB·파일·stdout/stderr·로그에 넣지 않는다. 프레임 길이·버전·순서·prompt·재전송을 검증하고 echo 없이 입력한다. 취소·hold·끊김·만료·종료 불명 시 채널 폐기, 그룹 종료 확인 전 새 attempt 금지. 동일 client MFA 최대 3회다.
3. 인증 latch에는 기존 binding의 명시적 인증 단계 재인증만, rate latch에는 다음 현지 날짜의 예약된 실제 HTTP 요청 하나만 예외로 허용한다. 자동 refresh/retry를 차단하고 한 요청을 입증할 수 없으면 probe를 보내지 않는다. 인증 성공이 rate·manual·uncertain latch를 지우지 않으며 release-block은 auth·uncertain을 지우지 않는다. 미확정 호출은 TTL이나 날짜로 해제하지 않는다.
4. 미확인 tokenstore는 source discovery 배타 gate와 target 보호를 갖고, 확인된 계정은 discovery 공유 gate와 canonical account 배타 gate를 갖는다. 기존 보호가 있는 source에서 미확인 target의 discovery 호출은 금지한다. canonical binding은 보호 latch의 합집합과 generation을 원자적으로 보존하고 경로 alias·교체·identity mismatch와 null-key 기존 work를 실패 닫힘으로 다룬다. 서로 다른 확인된 계정의 병렬성은 유지한다. 단일 serializationKey만으로 이 다중 gate를 구현했다고 가정하지 않는다.
5. supervisor가 worker launch 전에 durable admission을 기록하고 각 실제 HTTP 전에 현재 attempt·취소·hold·binding·gate를 검사하여 intent를 commit한다. 저장 실패·결과 불명·crash는 pending/uncertain을 남기고 재시작에서도 호출을 막는다. HTTP와 DB를 원자적이라 주장하지 않고 이미 전송된 in-flight는 격리한다. 쓰기 tx는 외부 호출·입력 대기 중 열지 않고 2초 이내다. 라이브러리 내부 HTTP·retry·refresh도 gate와 pacing으로 계측한다.
6. 아래 조사 보고의 T01–T28을 구현 후 격리 fake HTTP/PG와 실제 supervisor로 검증한다. 보안 peer spoof·동일 UID 공격·secret canary·취소·identity alias·미확정 intent·SIGKILL·probe 실제 HTTP 수를 포함한다. OS 격리 또는 라이브러리 제어를 증명할 수 없으면 성공으로 꾸미지 말고 실패 닫힘을 유지하며 단계별 진단·대안을 기록한다. 실계정 MFA·배포는 16.9에 남긴다.

### 감독자 결정 (2026-11-01, 추천으로 정함; 보호 배치 재추진)

독립 정적 대조는 [독립 보안 검증](story-mfa-0-independent-boundary-review.md)에 보존한다. 소스 반례와 추천안의 검토이며 실제 OS 격리 성공은 아니다. 미검증 부분 구현은 `c7e9112`에 보존했고 원래 기준은 `885ad522e5a30b820c12f984959c03c98ca28bc1`이다. 재무장으로 기준이 전진해도 최종 검증·독립 리뷰는 원래 기준부터 전체 diff와 기존 보고, 아래 미완료 작업을 포함한다. WIP를 완료로 간주하지 않는다.

1. 저장소의 단일 권위 PostgreSQL 및 OrbStack Docker 계약을 유지한다. 로그인 UID에서 관리 API·VM·컨텍스트·volume·백업·inspect/exec/create 등 동등 관리 경로 모두 접근할 수 없는 **보호된 OrbStack 배치**를 우선 구현·조사한다. 별도 principal 또는 소켓 이름만으로 격리가 입증되었다고 간주하지 않는다. 실제 지원·재부팅·업데이트 후 격리 증명이 실패하거나 불명이면 보호 배포 미완료로 남기고 auth 입력과 외부 HTTP를 닫는다. local PostgreSQL 대안은 현재 저장소 정책을 바꾸므로 암묵적으로 전환하지 않는다. 실제 운영 이전은 16.9이며 기존 데이터·원본을 보존한다.
2. 보호된 기존 단일 supervisor와 broker, 별도 Garmin worker principal의 봉인 실행물·자격·DB role을 분리한다. 사용자 수정 shim, manifest, venv, PATH, URL, `.env`, 엔진 API로 보호 권한을 획득하거나 증거·admission·latch를 위조할 수 없어야 한다. CLI/hook은 기존 명령 의미와 spool을 보존하되 보호 서비스의 좁은 데이터 API를 통해 접근하고 비인가 SQL·DB 자격·임의 실행은 노출하지 않는다. 서비스 부재 때 보호 기능은 실패 닫히며 일반 입력은 비권위 spool로 구분한다. 다른 확장을 privileged UID로 실행하지 않는다.
3. 비밀 채널의 문구를 정밀화한다: broker가 만든 익명 전용 FD로만 비밀을 보내고 worker에는 spawn 상속, 검증된 UI에는 인증된 OS IPC의 FD 전달을 허용한다. XPC 본문·argv·env·파일·로그에는 비밀을 넣지 않는다. 역할별 OS 신원, 세션·attempt·generation·package 결합, 일회성 승인, 복제 FD 정리 및 프로세스 그룹 종료를 검증한다. 기존의 ‘전용 상속 FD’는 이 항목으로 대체하며 XPC descriptor 전달과 상속을 동일하다고 주장하지 않는다. 사용자 승인 세탁·접근성/자동화 권한의 실제 위협을 검사하고 증명되지 않으면 열지 않는다.
4. 실행을 D1 설치 staging·보호 엔진 가능성 검사 → D2 DB 역할과 제한 API → D3 단일 supervisor와 launcher → D4 UI/broker/FD → D5 tokenstore와 OS egress·HTTP broker → D6 전체 T01–T28 및 독립 리뷰 → D7 이전 준비로 나눈다. 각 단계에서 같은 구현자가 phase-ready 보고, 지휘자 검증·checkpoint 뒤 다음 단계를 받는다. 실제 보호 엔진이 미검증이어도 stage·fake·별도 프로세스 fixture를 계속 작성한다. fake 성공을 실제 격리 성공으로 승격하지 않고 사용자 요구·계약·전체 검증을 줄이지 않는다. native PID assertion은 현재 소스에 이미 존재한다.

</intent-contract>

## Code Map

- `extensions/garmin/src/collect.py:40` — account target·하루 range·snapshot 검증. 숫자·boolean 설정을 추가하려면 현재 string 전용 판정을 바꿔야 한다. `run`의 취소 경계와 `collect_store.py`의 attempt fencing·원자 raw/건강 publisher는 보존한다.
- `extensions/garmin/src/collect_client.py` — 기본 `UnavailableClient`와 주입 seam. 실제 인증 adapter는 아직 없다.
- `extensions/garmin/migrations/0002_batch_import.sql` — `garmin.attempt_valid` 재사용. 적용된 migration 수정 없이 0007부터 보호·binding·호출 의도 상태를 추가할 수 있다.
- `extensions/garmin/manifest.json`, `pyproject.toml`, `uv.lock` — auth·release-block·보호 설정·오류 선언과 의존 추가 지점. Python 3.14.10·psycopg를 보존한다. 일반 string인 tokenstore 경로를 `machine: tokenstore`로 바꾸면 기존 경로 선택 계약을 잃는다.
- `packages/core/src/extensions/install.ts:176` — manifest.auth supervised 일감과 login_required 재개는 있으나 인증 입력 transport는 없다. 현재 auth enqueue는 extension target이며 serializationKey를 넘기지 않는다.
- `apps/cli/src/runtime/process-group.ts:8`, `packages/core/src/ports/process.ts` — detached worker의 stdin은 ignore이고 stdout/stderr만 수집한다. TTY·입력 broker 계약이 없다. 여기에 옛 TerminalPrompts를 붙이면 동작하지 않는다.
- `packages/core/src/extensions/run.ts:5`, `packages/core/src/queue/schedule-tick.ts`, `packages/postgres/src/work.ts:69` — manual은 extension/default target이고 계정·날짜 resolver가 없다. epic 12 키별 claim 배타성은 있으나 auth/manual/예약의 공통 키 공급과 최초 identity 전환은 연결되지 않았다.
- `extensions/garmin/tests/collect_fixture.py`, `apps/cli/python-test/garmin-collect.test.ts` — 격리 홈·PG·fake·barrier·실제 감독자 기반. 기존 barrier는 fetch 후 publish 전이므로 보호 commit 직후 hook을 따로 만들어야 한다.
- `apps/cli/test/ext-install-resume.test.ts`, `packages/core/test/extensions.test.ts` — 인증 일감 재개와 격리 testext harness는 있지만 실제 비밀번호·MFA 입력 전달 검증은 없다.

## Tasks & Acceptance

**실행 후보:** 아래는 인증 비밀 경계 결정 뒤 준비 게이트를 다시 평가할 작업 순서다. 현재 배정·구현·검증 완료를 뜻하지 않는다.

- [ ] 1단계 — `extensions/garmin/src/`의 새 보호 모듈과 `migrations/0007_account_protection.sql` — 선행 호출 의도·보호 전이·alias 저장과 fake clock 시험을 구현한다. 미기록 외부 결과는 재시작 시 자동 해소하지 않는다.
- [ ] 2단계 — 같은 확장 client/auth 모듈·`manifest.json`·lock 및 결정된 공통 인증 transport 경로 — 라이브러리 로그인·동일 client MFA·권한·오류·pacing·first-call과 인증 단계 연결을 구현한다. 비밀 전달 경로는 아래 공백이 해소되기 전 확정하지 않는다.
- [ ] 3단계 — 공통 extensions install/run·schedule enqueue·store 경계와 Garmin 보호 projection — 인증/수집 identity·직렬화·수동 해제·doctor 관찰을 연결한다. Core에 제품 전용 보호 의미를 하드코딩하지 않는다.
- [ ] 4단계 — `extensions/garmin/tests/check_protection.py`, `apps/cli/python-test/garmin-protection.test.ts` 및 기존 회귀 — 행렬·crash·저장 실패·동시성·비밀 비노출을 관찰한다.

**수락 기준:**

- Given 격리 DB와 합성 client, When 데이터 403 세 번 또는 429를 반환하면, Then 영속 보호가 보이고 그 실행의 남은 호출과 같은 날 모든 실행 경로의 외부 호출이 0이다.
- Given 차단된 계정과 가짜 현지 clock, When 다음 날짜 탐색이 성공하면, Then 그 성공 후에만 풀린다. 다음 날짜에도 차단되면 `brain ext run garmin release-block` 전까지 호출 0이고 doctor가 이를 보인다.
- Given MFA·인증 실패 latch, When 예약·수동·force를 다시 실행하면, Then 호출 0이고 같은 client MFA 최대 3회인 인증 단계의 성공만 인증 latch를 해제한다.
- Given 보호 commit 직후 barrier의 실제 Python worker PID, When SIGKILL 후 종료를 확인하고 새 attempt로 재시작하면, Then 보호 상태와 호출 누계가 유지된다. 호출 전 쓰기 거부와 외부 오류 후 결과 저장 거부도 각각 재시작 무호출로 확인한다.
- Given 같은 계정의 서로 합쳐지지 않는 인증·수집 일감과 다른 확인된 계정, When 실제 감독자에서 동시에 실행하면, Then 같은 계정 외부 호출은 겹치지 않고 다른 계정은 병렬로 진행한다.
- Given 합성 비밀번호·토큰·MFA와 clock/sleeper, When 전체 인증·실패 행렬을 실행하면, Then stdout/stderr·로그·work_attempts·failures·doctor에 합성 비밀이 없고 pacing과 first-call 상한을 지킨다.

## Implementation Notes

### g6 진행

supervisor 전용 registry·고정 spawn·실제 OS instance/DB 등록·단회 native capability의 bootstrap 부품을 구현했다. [g6 보고](story-mfa-0-g6-implementation.md)의 재현된 합성 service 자식 SIGSEGV는 Security 초기화 후 fork 경로를 posix_spawn 독립 실행으로 바꿔 수정했다. 지휘자는 진단 원본의 `service_status=11`과 변경을 대조했고, 최신 8개 파일 12건을 독립 통과했다(`/tmp/brain162g6-parent-peer-exec-fixed.log`). 최초 지휘자 종료 7은 당시 내부 PID 진단이 없어 같은 crash라고 사후 단정하지 않는다. 현재 봉인 entry는 아직 bootstrap 단계이므로, 같은 구현자에게 실제 기존 상주 보호 서비스·DB fence·endpoint를 하나의 봉인 실행 instance에 결합하는 단위를 배정했다. root/principal/엔진·최종 loader·전체 나머지 요구는 미완료다.

상주 `runProtectedSupervisor`와 queue 전용 native endpoint/client를 같은 수명에 연결했고, 제품 host runner의 native 종료 증거를 실제 PostgreSQL fence에 연결했다. 지휘자 독립 제품 서비스 묶음은 6개 파일 9건(`/tmp/brain162g6-parent-product-service.log`), 이어 상주 readiness·인증 승인 세탁 거부를 포함한 최신 묶음은 6개 파일 10건(`/tmp/brain162g6-parent-resident.log`) 통과했다. 기본 CLI transport 코드와 고정 root pin 검증은 작성됐으나 실제 설치 pin·보호 principal/OrbStack·supervisor 전체 Node/JS/loader 및 정확한 실행 instance 신뢰는 미완료다. `createInstalledProtectedService`는 이 경계 미증명 때문에 설치 endpoint를 명시적으로 닫는다. 현재 같은 구현자가 supervisor 봉인 bootstrap을 작성한다. 일반 queue helper 실행을 사람의 auth 승인으로 인정하지 않는 기존 독립 검토 §3의 구분을 유지하며, B2 전체·B3–B6·D5–D7 및 원래 기준 전체 리뷰는 미완료다.

후속으로 Node의 launcher OS peer 검증 addon, Node/addon 서명을 고정한 registry v2, 제품 native launcher/host와 합성 supervisor의 인증된 FD 전달 사슬을 작성했다. 지휘자 독립 `BRAIN_G6_PG=1 pnpm exec vitest run apps/cli/test/protected-queue-host.test.ts apps/cli/test/sealed-node-peer.test.ts apps/cli/test/sealed-queue-client.test.ts packages/postgres/test/protected-queue-host.test.ts`에서 4개 파일 5건 통과(`/tmp/brain162g6-parent-host-fence.log`). 별도 프로세스의 실제 제품 handler/격리 PG와 영속 admission 경합·불명 보존을 확인했으나, 실제 기존 보호 supervisor의 native host/service 소유 및 cleanup 증거→DB fence 연결·기본 CLI transport는 아직 미완료다. 같은 구현자에게 이 제품 연결 전체를 후속 배정했다. 합성 supervisor 성공을 실제 보호 설치·principal·엔진·주입 방지 증거로 취급하지 않는다.

[g6 전체 구현 보고](story-mfa-0-g6-implementation.md)의 root 전용 registry 검증·고정 Node spawn·제한 queue 후보 및 실제 Node/native/Core/격리 PG 합성 사슬을 구성 요소로 확인했다. 지휘자 독립 실행에서 registry·경로 교체·후보 변조 거부와 제한 client 회귀 4건, 실제 PG를 포함한 Node 사슬 2건이 통과했다. Node ACK 출처·실제 제품 서비스 조립·같은 UID 대리 호출·재연결 거부와 root/principal·loader 전체 실증은 미완료다. 같은 활성 구현 Dispatch에서 B2-2 제품 native 조립을 진행한다. B2 전체·B3–B6·D5–D7·T01–T28 및 원래 기준 독립 리뷰는 완료되지 않았으며 운영 queue/auth/HTTP는 닫혀 있다.

### g5 진행

[g5 전체 구현 보고](story-mfa-0-g5-implementation.md)의 D4B 단일 Core 제품 조립·고정 metadata 및 다중 broker/GUI 세션·revoke-all과 기존 보호 명령 연결을 구성 요소 단계로 수락했다. 지휘자는 정상 Core/native, 신원 commit 응답 유실·metadata 누락, 두 native 세션 격리와 실제 두 Core attempt의 commit 유실·두 번째 ACK 실패를 독립 재실행했다. 아래 Verification에 명령과 로그를 남겼다.

leader 종료 관찰/reap·그룹 정리도 구성 요소 단계로 수락했고, quarantine의 전역 LOGIN 변경은 독립 클러스터 fixture로 격리해 동일 병렬 회귀를 통과했다. 별도 principal 실기는 관리자 권한 부재로 미실행이며 자동 fixture와 실행 절차만 준비됐다. D2B B1 façade·wire와 B2의 native peer/framing/고정 spawn 합성 사슬을 구성 요소로 확인했으며, 현재 같은 구현 Dispatch에서 B2의 root registry·전체 Node/JS 로딩 신원·기본 운영 transport 연결을 계속한다. D2B B2–B6 전체, collect 비입력 bootstrap·D5 library/HTTP/egress, D6 전체 행렬·독립 리뷰와 D7은 여전히 미완료다. 실제 보호 설치·생체·AX·OrbStack 관리 경로 격리 성공을 주장하지 않으며 운영 auth/HTTP는 닫힌다.

### g4 재개

D4A의 native 구성요소·libpq supervisor adapter·broker DB guard와 실제 보호 스키마 fixture를 구현했다. revoke ACK 뒤에만 cancel/hold/disable을 commit하는 경로와 이전 epoch 증거 거부를 지휘자도 독립 검증했다. 공통 registry 일반화와 다른 보호 auth·일반 kind 비간섭 시험도 통과했다. DB superuser가 trigger를 우회하는 별도 주입의 이미 전송된 frame은 in-flight로 구분하며 library 전달을 막는다. DB와 FD/HTTP가 원자적이라는 주장은 하지 않는다. 지휘자는 native 변경 diff와 전문을 읽고 보호 자격 파일의 초과 길이 쓰기·연결 옵션 검증을 수정 요청한 뒤 수정 소스와 ASan 시험의 독립 통과를 확인했다. 제품 `runSupervisor` 조립과 D2B·D5–D7은 미완료이며 운영 경로는 닫혀 있다. 이 저장소 구현은 operator 행동만 남은 상태가 아니다.

타입 오류 두 건과 credentials 최초 1회·이후 MFA 최대 3회 예산을 수정했다. 지휘자는 해당 diff·전문 보고를 읽고 `pnpm typecheck`와 native session fixture를 독립 재실행해 통과했다. 제출별 callback·broker 소비·worker gate부터 나머지 단계를 계속한다. 전체 수락이나 실제 OS 격리 성공을 뜻하지 않는다.

g3의 D1 부분 구현은 `tooling/protected-deployment/`에 있다. staging·고정 정책·FD 경로와 macOS ACL 검사·생성 실패 복구를 격리 fixture로 검증 중이다. 실제 설치·서명·서비스별 권한·별도 principal 거부·보호 엔진 실증은 아직 미완료다. [보호 엔진 공식 지원 조사](story-mfa-0-engine-research.md)에서는 headless와 멀티유저는 확인했으나 전체 관리 경로 격리 배치의 긍정 근거를 확인하지 못했다. 이 한계를 입력·HTTP 허용 근거로 바꾸지 않는다.

현재 generation의 부분 구현으로 보호 schema·독립 latch·intent·alias 병합·영속 pacing·작업별 예산, 합성 MFA·전송 seam, 실패 닫힌 auth 진입점, 공통 supervisor의 spawn 전 admission과 재provision 권한 보존을 구현 중이다. 지휘자는 초기 보호 시험을 새 격리 PostgreSQL 18에서 독립 실행해 통과를 확인했다. 이후 확장된 시험과 실제 supervisor·권한·daemon 검증은 워커 보고를 수집했으며 최종 독립 검증과 전체 수락은 아직 남아 있다. native peer API spike는 가능했으나 신뢰된 서명·같은 UID 공격자에 대한 실행물/tokenstore 격리는 미증명이다. 실제 Garmin HTTP·운영 tokenstore는 사용하지 않았다. 전체 T01–T28과 정상 인증·수집·해제 경로는 미완료이며 티켓 완료를 뜻하지 않는다.

이전 generation은 구현하지 않았다. 당시 HEAD의 직접 코드 확인과 읽기 전용 Orca 조사 보고서를 대조했다. 조사 보고서는 `/tmp/brain16-2-research.md`이며 기준 revision은 이 계획의 전체 baseline과 같다. ticket 16.1의 publisher·격리 fixture 연속성을 유지한다. 소스·시험·lock은 바꾸거나 실행하지 않았다.

## Plan Change Log

- g5 D5 준비: [현재 library·HTTP broker 연결 지도](story-mfa-0-g5-d5-map.md)를 전문 확인했다. 정상 auth/collect/probe, per-wire intent·sticky deny, 쿠키·redirect·refresh, tokenstore pin, raw FD 및 OS egress의 현재 결손과 작은 실행 단위를 보존한다. 읽기 전용 조사이며 시험·빌드·실기 격리 성공을 뜻하지 않는다. 조사 Dispatch는 정식 성공 보고를 확인한 뒤 release했다.

- g4 D6 준비: [T01–T28 시험 연결 지도](story-mfa-0-g4-matrix-map.md)를 전문 확인했다. 현재 함수·합성·native·제품 Core runner의 관찰 층과 실제 wire/동시 binding/저장 실패·재시작 및 추가 보안 반례의 미검증을 분리했다. 읽기 전용 조사는 시험 실행이나 전체 행렬 통과가 아니며, 이후 D5/D6 구현·독립 실행에서 각 행의 정확한 runner와 결과를 기록한다.

- g4 D4B 준비: [Core/native 연결 조사](story-mfa-0-g4-core-native-map.md)를 확보했다. Core의 단일 admission·identity commit 소유권, native ACK 분할, 실제 worker PID/leader reaping/그룹 관찰, 미spawn 단계의 취소 및 재시작 fence를 구현·검증 대상으로 보존한다. 보고의 bridge 선택은 제안이며 보안 조건을 완화하거나 새 claim loop를 허용하지 않는다. 기존 감독자의 durable admission·현재 attempt·불명 보존 권한 범위에서 내부 전이를 구체화하며 실제 결정 모순은 원본과 대조한다.

- g4 D4A 수락 범위: [native 구현 전문](story-mfa-0-g4-native-report.md)과 해당 source diff를 읽고 native·격리 PG 검증 및 credential ASan 보완을 확인했다. 이는 구성 요소 단계의 수락이며 실제 운영·전체 수락을 뜻하지 않는다. D4B는 기존 단일 `runSupervisor`의 제품 launcher·저장소·bootstrap·취소 경로에 이 부품을 연결하고 실제 Core/격리 PG/native 통합을 검증한다.

- g4 실행 단위 재정렬: D4A는 native UI·broker·worker·GUI host와 실제 PG adapter 및 revoke 순서를, D4B는 기존 `runSupervisor`와 제품의 저장소·launcher·취소 경로에 해당 부품을 연결하는 단위를 맡는다. D4A의 합성·격리 PG 성공은 D4B나 실제 배포 완료를 뜻하지 않는다. 이후 D2B B1–B6, D5, D6 전체 행렬·독립 리뷰와 D7을 그대로 유지한다.

- g4 D2B 준비: [제한 API 실제 연결 조사](story-mfa-0-g4-api-composition.md)를 확보했다. 축약 queue 응답·오류·Date·drain 손실 및 첨부 spool의 locator 신뢰 반례를 보존한다. 조사 자체는 읽기 전용이며 구현·시험 성공이 아니다. 보고의 선택 후보는 기존 보호 배치 결정의 좁은 데이터 API·사용자 principal 취득·내부 권위 분리 범위에서 구현자가 구체화하며, 실제 보안 계약 모순이 발견되면 별도로 근거를 대조한다. release-block은 epic의 기존 에이전트 수동 실행 위임을 유지하고 credentials/MFA의 생체 정책을 임의 확장하지 않는다.

- g3 D5 준비: [고정 라이브러리 연결 지도](story-mfa-0-library-map.md)에서 실제 lock/설치 소스를 대조했다. MFA early return·대체 verify POST·broad fallback·내부 refresh/redirect·tokenstore 상대 접근 및 cookie 호환 근거를 구현자에게 전달했다. 읽기 전용 조사이며 D5 구현/시험 성공이 아니다.

- g3 D3A/D3B: 고정 registry·단일 supervisor·비특권 WorkerHost·bootstrap 준비 경계를 D3A로 독립 검증(5개 파일 67개 시험)했다. 실제 principal launcher와 양방향 peer/FD는 D3B+D4에서 함께 구현한다. [공식 native API 연결 지도](story-mfa-0-native-map.md)는 SDK/공식 문서 조사이며 실제 배포/시험 증거가 아니다.

- g3 실행 분할: D2A의 DB 권한·API 검증 부품을 독립 확인한 뒤 D3/D4 실행·전송 의존을 먼저 구현한다. D2B의 실제 사용자 operation·CLI/hook·spool·자격 이관은 D4 직후 D5/D6 전에 닫으며, D1 설치·D7 복구와 전체 T01–T28을 줄이지 않는다.
- [ASSUMPTION] bootstrap 상한 10초와 봉인 worker 설치 후보 경로는 보수적인 미활성 준비 상수다. 코드 주석과 frontmatter deferred에 별도 검토 항목으로 보존했다.

- g3 D2: [제한 API 연결 지도](story-mfa-0-api-map.md)를 읽기 전용 조사로 확보했다. 명명된 Core operation과 내부 typed port·비권위 spool 경계를 구현자에게 전달했다. DB 역할 분리의 fixture 성공과 정상 서비스/CLI 연결 미완료를 구분한다.

- g3 재개: 감독자 보호 배치 결정을 따라 D1 staging·보호 엔진 검사를 먼저 배정하고, D2 역할/API → D3 supervisor → D4 UI/FD → D5 전송 → D6 전체 검증·리뷰 → D7 이전 준비 순으로 진행한다. 기존 부분 구현과 원래 전체 diff 기준을 보존한다.

## Review Triage Log

## Design Notes

### 구현 전 해소해야 하는 보안 공백

16.2는 비밀번호·MFA를 epic 13 인증 단계에서만 받으라고 정하지만 epic 13이 제공한 것은 supervised auth와 login_required 상태 관리다. 실제 프로세스는 입력을 받지 못한다. 선행 13.5 계획도 비밀을 기록하지 않는 인증 일감 실행을 정했을 뿐, 별도 operator TTY·권한 있는 broker·사용자 세션 인증 방식의 선택과 상대 신원 검증·수명·취소 경계를 정하지 않았다. archive의 TTY 입력은 이 프로세스 계약에 그대로 적용할 수 없다.

미결정 사항은 비밀번호·MFA를 어떤 인증 단계 전용 통로로 전달하며 누가 접속을 허용하고 상대 신원을 어떻게 검증할지다. 이를 임의 선택하는 것은 비밀 전달과 권한 경계를 새로 결정하는 일이다. persistent facts의 보안·비밀 공백 HALT 규칙에 따라 `[ASSUMPTION]`으로 처리하지 않았다. 최초 tokenstore→profile binding의 보수적 병합, 선행 호출 의도와 probe 연산/내부 HTTP의 구분도 해당 경계와 함께 계획에서 구체화해야 한다. 기존 키별 claim만으로 이 연결이 완성됐다고 주장하지 않는다.

### 재개 시 검증 설계

보호 DB 저장 전에 client 생성의 자동 I/O까지 금지하고, 호출 의도 commit 후 호출하며, 결과 저장 실패 시 의도를 남긴다. 외부 호출 중 SQL 쓰기 트랜잭션은 열지 않는다. library 내부 retry와 token refresh의 HTTP 수를 wrapper 호출 간격 보장과 혼동하지 않는다. 최초 미확인 계정의 안전한 발견·alias 결합은 기존 계정 차단을 초기화해서는 안 된다.

## Verification

### g6 중간 지휘자 검증

- 위 실패와 같은 supervisor 봉인 포함 8파일 묶음을 합성 service의 posix_spawn 수정 뒤 독립 재실행해 8개 파일 12건 통과(`/tmp/brain162g6-parent-peer-exec-fixed.log`). 수정 전 진단 `/tmp/brain162g6-peer-trace-2.log`의 service 자식 `wait status 11`과 원래 Security-after-fork 경로 및 수정 소스를 대조했다. 최초 종료 7의 상세 분기는 사후 확정하지 않고 이전 실패 기록을 보존한다. 현재 통과는 bootstrap 부품 및 queue 합성 사슬 범위다.

- supervisor 봉인 신규 시험을 포함한 `BRAIN_G6_PG=1 pnpm exec vitest run apps/cli/test/sealed-supervisor-product.test.ts packages/postgres/test/sealed-supervisor-instance.test.ts apps/cli/test/queue-host-product.test.ts apps/cli/test/protected-queue-host.test.ts apps/cli/test/protected-queue.test.ts apps/cli/test/sealed-node-peer.test.ts apps/cli/test/sealed-queue-client.test.ts packages/postgres/test/protected-queue-host.test.ts`: 7개 파일 11건 통과·1개 파일 1건 실패(`/tmp/brain162g6-parent-supervisor-seal.log`). `sealed-node-peer.test.ts:45`의 정상 `run('ok')`가 expected 0·received 7로 실패했으며 diagnostic은 비어 있었다. 이전 종료 9와 같은 원인이라고 단정하지 않는다. 같은 구현자에게 정확한 내부 경로 진단·수정과 동일 병렬 묶음 재검증을 요청했으며 단계 전체는 미수락 상태다.

- `sh extensions/garmin/native/tests/check-sealed-registry.sh`: 종료 0. 최종 경로 고정 버전 로그는 `/tmp/brain162g6-parent-registry3.log`다. 합성 registry·고정 Node spawn 및 경로 교체 거부를 확인했으며 실제 root 설치 증거는 아니다.
- `sh extensions/garmin/native/tests/check-local-cli-registry.sh`: 종료 0(`/tmp/brain162g6-parent-local-cli2.log`). 제한 후보의 고정 목록·변조 거부와 닫힌 진입점을 확인했다. 이후 Node entry의 ACK 연결 변경은 다음 사슬 시험으로 확인했다.
- `pnpm exec vitest run apps/cli/test/sealed-queue-client.test.ts apps/cli/test/protected-queue.test.ts`: 2개 파일 4건 통과(`/tmp/brain162g6-parent-limited-tests.log`). 제한 client와 기존 queue 요청·렌더러 및 서비스 부재를 확인했다.
- `BRAIN_G6_PG=1 pnpm exec vitest run apps/cli/test/sealed-node-peer.test.ts apps/cli/test/sealed-queue-client.test.ts`: 2개 파일 2건 통과(`/tmp/brain162g6-parent-node-peer.log`). 실제 Node→합성 native OS peer→제품 handler/Core/격리 PG 왕복과 신원·변조·연결 교체 거부를 확인했다. 시험 gateway와 Node ACK 출처 검증의 한계 때문에 실제 제품 보호 transport나 별도 principal의 증거로 세지 않는다.

### g5 중간 지휘자 검증

- `sh extensions/garmin/native/tests/check-sealed-files.sh` 및 `pnpm exec vitest run apps/cli/test/queue-frame-stream.test.ts apps/cli/test/protected-queue.test.ts`: 각각 종료 0, 2개 파일 6건 통과. 로그는 `/tmp/brain162g5-parent-b2-bundle.log`, `/tmp/brain162g5-parent-b2-bundle-chain.log`다. 고정 전체 목록·파일별 digest/ACL·실행물 strict 코드 서명을 spawn 전후에 검사하고 미등록 JS·서명/파일/상대 신원 변조 거부를 확인했다. 현재 단일 native 합성 bundle이며 실제 Node CLI closure·root registry·기본 운영 transport 완료로 확대하지 않는다.

- `pnpm exec vitest run apps/cli/test/queue-frame-stream.test.ts apps/cli/test/protected-queue.test.ts`: 2개 파일 6건 통과(`/tmp/brain162g5-parent-b2-spawn.log`). 열린 검증 FD·고정 argv/env spawn·bootstrap ACK·OS peer 인스턴스와 CLI/제품 handler/Core/격리 PG 합성 사슬, 변조 digest·양방향 해시·다른 PID 거부·사용자 Store 생성 0을 확인했다. 사용자 소유 단일 native fixture와 시험 신원이므로 root registry·전체 Node/JS 로딩 봉인·실제 기본 운영 transport 완료로 세지 않는다.

- `sh extensions/garmin/native/tests/check-sealed-files.sh`: 종료 0(`/tmp/brain162g5-parent-b2-files.log`). 열린 기준 디렉터리 FD에서 소유권·쓰기 권한·ACL·symlink·하드링크·고정 SHA-256을 검사하는 부품과 변조·실제 확장 ACL 거부를 확인했다. root 기준 FD·목록/digest의 보호된 출처, 전체 의존성과 loader, 실제 spawn/peer 등록·기본 운영 transport 연결은 미완료다.

- `pnpm exec vitest run apps/cli/test/queue-frame-stream.test.ts`: 1개 파일 3건 통과(`/tmp/brain162g5-parent-b2-chain.log`). 합성 native 양방향 OS peer와 CLI dispatch·제품 handler·Core·격리 PG를 하나의 사슬로 연결한 정상 목록·각 방향 해시 거부 및 사용자 Store 생성 0을 확인했다. 신원 공급은 여전히 시험 gateway가 담당하며, 봉인된 CLI 실행/로딩 신원·보호 서비스 instance 출처·기본 운영 transport는 미완료다.

- `pnpm exec vitest run apps/cli/test/queue-frame-stream.test.ts apps/cli/test/protected-queue.test.ts`: 2개 파일 5건 통과(`/tmp/brain162g5-parent-b2-stream.log`). 별도 합성 서비스 프로세스의 제품 queue handler·실제 Core·격리 PG 왕복과 사용자 Store 생성 0, 분할/연속/잘림/초과/불량 UTF-8 framing을 확인했다. native OS 인증과 이 프로세스 사슬은 아직 결합되지 않았으며 기본 운영 transport는 미완료다.

- B2 peer fixture의 완료 ACK·생존 장벽·연결 교체 진단 보완 후 `sh extensions/garmin/native/tests/check-data-peer.sh`: 종료 0(`/tmp/brain162g5-parent-b2-peer-fixed.log`). `REPLACE_LIVE=1 OTHER_ID=1 OLD_ID_REJECTED=1 WRITE_REJECTED=1`을 확인했다. 원래 peer가 살아 있는 상태의 새 상대와 옛 상대 신원 판정·쓰기 거부를 구분했다. 최초 종료 10의 내부 원인은 미확인으로 유지하며, 실제 CLI/보호 서비스 transport 조립은 별도 미완료다.

- B2 하위 `pnpm exec vitest run apps/cli/test/protected-queue.test.ts packages/core/test/protected-api.test.ts packages/core/test/codes.test.ts`: 3개 파일 304건 통과(`/tmp/brain162g5-parent-b2-tests.log`). `sh extensions/garmin/native/tests/check-data-peer.sh` 최초 독립 실행은 종료 10(`/tmp/brain162g5-parent-b2-peer.log`), `sh -x` 재실행은 종료 0(`/tmp/brain162g5-parent-b2-peer-trace.log`)이었다. 간헐 실패 원인은 미확인으로 보존하고 같은 구현자에게 fixture 수명·후검증 경합을 포함한 진단·수정을 요청했다. 후검증을 완화하지 않으며 B2나 실제 운영 transport 완료 증거로 세지 않는다.

- `pnpm exec vitest run apps/cli/test/protected-queue.test.ts packages/core/test/protected-api.test.ts apps/cli/test/protected-mutations.test.ts`: 3개 파일 11건 통과(`/tmp/brain162g5-parent-b1.log`). B1의 실제 Core·격리 PG·제품 서비스 객체 경유 queue 출력과 잘못된 요청/응답·서비스 부재/거부 시 사용자 Store 생성 0을 확인했다. in-process transport 시험이며 기본 CLI의 운영 transport가 없어 queue list가 닫힌 중간 상태는 B2에서 해소해야 한다. OS peer 인증·서비스 배치·오류 구분 완료로 세지 않는다.

- `BRAIN_FIXTURE_AUTHORITY=1 BRAIN_FIXTURE_NATIVE_STORE=1 BRAIN_FIXTURE_CORE=1 BRAIN_FIXTURE_CORE_DESCENDANT=1 sh extensions/garmin/native/tests/check-composed-auth.sh`: 종료 0(`/tmp/brain162g5-parent-core-descendant.log`). 실제 Core/native의 leader 종료 관찰·입력 폐기·손자 그룹 정리·reap 및 정산을 확인했다. `pnpm exec vitest run packages/core/test/protected-api.test.ts packages/core/test/supervisor.test.ts packages/core/test/supervisor-cancel.test.ts packages/postgres/test/garmin-quarantine.test.ts packages/postgres/test/work-store.test.ts apps/cli/test/protected-mutations.test.ts apps/cli/test/sealed-native-bridge.test.ts`: 7개 파일 261건 통과(`/tmp/brain162g5-parent-parallel-regression.log`). 독립 클러스터 fixture로 이전 병렬 role 충돌이 재발하지 않았다. 별도 UID·실제 서비스 배치와 그룹 밖 후손 격리는 미검증으로 유지한다.

- `BRAIN_FIXTURE_AUTHORITY=1 BRAIN_FIXTURE_NATIVE_STORE=1 BRAIN_FIXTURE_CORE=1 BRAIN_FIXTURE_CORE_SIGNAL=1 BRAIN_FIXTURE_CORE_MUTATION=hold BRAIN_FIXTURE_TWO_CORE=1`에 `BRAIN_FIXTURE_CORE_COMMIT_LOST=1` 또는 `BRAIN_FIXTURE_CORE_ACK_FAIL=second`를 각각 추가한 `sh extensions/garmin/native/tests/check-composed-auth.sh`: 모두 종료 0. 로그는 `/tmp/brain162g5-parent-two-core-lost.log`, `/tmp/brain162g5-parent-two-core-ack-fail.log`다. `pnpm exec vitest run packages/core/test/protected-api.test.ts apps/cli/test/protected-mutations.test.ts`: 2개 파일 8건 통과(`/tmp/brain162g5-parent-mutation-api.log`). 두 활성 Core/native의 정확한 폐기 증거·receipt 복구와 ACK 실패 시 mutation 차단을 확인했다. 실제 외부 인증 transport·별도 principal·완전 복구 성공으로 확대하지 않는다.

- `BRAIN_FIXTURE_MULTI_SESSION=1 sh extensions/garmin/native/tests/check-composed-auth.sh`: 종료 0(`/tmp/brain162g5-parent-two-native.log`). 같은 broker·GUI 서비스의 두 native 세션을 ACK 뒤 barrier에 세워 한쪽 폐기와 다른 쪽 독립 완료를 확인했다. 독자 합성 supervisor 시험이며 실제 단일 Core의 두 활성 attempt revoke-all·보호 API 조립은 별도 미완료다.

- `BRAIN_FIXTURE_AUTHORITY=1 BRAIN_FIXTURE_NATIVE_STORE=1 BRAIN_FIXTURE_CORE=1 BRAIN_FIXTURE_CORE_RECORD=lost sh extensions/garmin/native/tests/check-composed-auth.sh` 및 `BRAIN_FIXTURE_METADATA_CASE=5 sh extensions/garmin/native/tests/check-worker-success.sh`: 각각 종료 0. 로그는 `/tmp/brain162g5-parent-core-lost.log`, `/tmp/brain162g5-parent-metadata-missing.log`다. commit 응답 유실에서 ACK·prompt 0과 holder 보존, 필수 metadata 누락 시 ACK 거부를 확인했다. [g5 전체 구현 보고](story-mfa-0-g5-implementation.md)의 Core 거부·metadata 반례·회귀 결과와 소스 diff를 대조했다. 첫 단계 부품 수락이며 전체 티켓·실제 배포 완료가 아니다.

- `pnpm exec vitest run apps/cli/test/sealed-native-bridge.test.ts packages/postgres/test/garmin-quarantine.test.ts`: 2개 파일 2건 통과(`/tmp/brain162g5-parent-phase1-tests.log`). `BRAIN_FIXTURE_AUTHORITY=1 BRAIN_FIXTURE_NATIVE_STORE=1 BRAIN_FIXTURE_CORE=1 sh extensions/garmin/native/tests/check-composed-auth.sh`: 종료 0(`/tmp/brain162g5-parent-core-native.log`). 실제 Core·격리 PG·동일 UID 합성 native 서비스의 ACK 후 metadata와 정상 정산을 확인했으며 신원 기록 실패/응답 유실·변조 반례는 구현자에게 보완 요청했다. 실제 별도 principal·봉인 설치·생체·운영 HTTP 성공으로 확대하지 않는다.

- `node --test tooling/protected-deployment/stage.test.mjs`: 5건 통과. 로그는 `/tmp/brain162g5-parent-stage.log`다.
- `PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tooling/protected-deployment -p 'test_*.py' -v`: 8건 통과·별도 UID/root fixture 1건 skip. 로그는 `/tmp/brain162g5-parent-deployment.log`다. staging·경로 부품의 회귀 확인이며 실제 보호 principal·엔진 격리 성공을 뜻하지 않는다.

### g4 중간 지휘자 검증

- `sh extensions/garmin/native/tests/check-broker-credential.sh` 지휘자 독립 실행 통과(`/tmp/brain162g4-parent-credential.log`). ASan으로 초과 길이·크기 변경·내부 NUL과 연결 옵션·단일 주소 경계를 확인했다. 실제 보호 principal·서버 TLS 성공은 아직 검증하지 않았다.

- `BRAIN_FIXTURE_AUTHORITY=1 BRAIN_FIXTURE_GENERIC=1 sh extensions/garmin/native/tests/check-composed-auth.sh` 지휘자 독립 실행 통과(`/tmp/brain162g4-parent-generic-registry.log`). 다른 보호 auth·확장 간 범위와 일반 kind 비간섭을 확인했다.

- `for fixture_case in 12 13 14; do BRAIN_FIXTURE_AUTHORITY=1 BRAIN_FIXTURE_NATIVE_STORE=1 BRAIN_FIXTURE_CASE="$fixture_case" sh extensions/garmin/native/tests/check-composed-auth.sh; done`의 각 별도 실행 및 `BRAIN_FIXTURE_AUTHORITY=1 BRAIN_FIXTURE_RACE=1` 실행을 지휘자가 독립 수행해 모두 통과했다. 로그는 `/tmp/brain162g4-parent-revoke-12.log`, `-13.log`, `-14.log`, `/tmp/brain162g4-parent-claim-hold-race.log`다. revoke 선행 취소·hold·disable과 claim/hold 및 이전 epoch 증거 거부의 native/DB 구성 요소 검증이며 제품 Core 연결은 아직 별도다.

- libpq 정상 경로 안정화 뒤 지휘자 재실행은 종료 0이었다(`/tmp/brain162g4-parent-native-store-stable.log`). 구현자의 동일 정상 경로 연속 4회·기록 거부 1회 로그도 확인했다. 이전 종료 6의 원인은 수정 중 스냅샷 또는 간헐 실패 중 어느 쪽인지 단정하지 않으며 원래 기록을 보존한다.

- libpq adapter 중간 독립 검증: `BRAIN_FIXTURE_NATIVE_STORE=1 BRAIN_FIXTURE_AUTHORITY=1 sh extensions/garmin/native/tests/check-composed-auth.sh`는 종료 6으로 실패했고, `BRAIN_FIXTURE_DENY_RECORD=1` 추가 경로는 통과했다. 로그는 `/tmp/brain162g4-parent-native-store.log`, `/tmp/brain162g4-parent-native-store-denied.log`다. broker DB guard 수정 중 스냅샷 여부와 원인을 같은 구현자에게 조사·수정 요청했으며 현재 성공 증거로 세지 않는다.

- `BRAIN_FIXTURE_AUTHORITY=1 sh extensions/garmin/native/tests/check-composed-auth.sh` 및 `BRAIN_FIXTURE_AUTHORITY=1 BRAIN_FIXTURE_DENY_RECORD=1 sh extensions/garmin/native/tests/check-composed-auth.sh` 지휘자 독립 실행 통과. 로그는 `/tmp/brain162g4-parent-authority.log`, `/tmp/brain162g4-parent-authority-denied.log`다. 실제 core/Garmin/보호 migration과 supervisor role의 admission·attempt 기록 및 오류 뒤 보존을 확인했다. 시험용 psql adapter·합성 생체·같은 UID 역할 fixture이며 제품 adapter·별도 principal 배포 완료 증거가 아니다.

- `sh extensions/garmin/native/tests/check-composed-auth.sh` 및 `sh extensions/garmin/native/tests/check-gui-service.sh` 지휘자 독립 실행 통과. 로그는 `/tmp/brain162g4-parent-composed-auth.log`, `/tmp/brain162g4-parent-gui-service.log`다. 별도 프로세스의 합성 승인·FD·전용 fixture PostgreSQL 기록/거부를 검증하며 실제 Brain 권위 표·서비스 배포·생체 성공을 뜻하지 않는다.
- `check-broker-service.sh`, `check-gui-host.sh`, `check-worker-success.sh` 지휘자 독립 실행 통과. 로그는 각각 `/tmp/brain162g4-parent-broker-service.log`, `/tmp/brain162g4-parent-gui-host.log`, `/tmp/brain162g4-parent-worker-success.log`다.

- `pnpm typecheck` 통과: `/tmp/brain162g4-phase1-typecheck.log`.
- `sh extensions/garmin/native/tests/check-peer.sh` 통과: `/tmp/brain162g4-parent-peer.log`. 제출별 합성 callback·broker 소비·worker의 권한 확인 전 FD 미읽기와 native 회귀 및 UI 부품 컴파일 범위다. 실제 GUI 생체·AX·서비스 principal·내구 DB 연결이나 전체 수락 성공은 아니다.

### g3 지휘자 재검증

- 새 native 부품: `sh extensions/garmin/native/tests/check-peer.sh` 성공. 로그는 `/tmp/brain162g3-native-peer.log`다. 별도 합성 프로세스 peer·단회 FD와 해당 시점 프레임·XPC fixture 범위이며 이후 추가된 WorkerHost·세션·서비스 전체를 검증했다는 뜻은 아니다.
- D3A 최종 준비 묶음: `pnpm exec vitest run apps/cli/test/process-group.test.ts packages/core/test/supervisor.test.ts apps/cli/test/sealed-garmin.test.ts apps/cli/test/sealed-launcher.test.ts apps/cli/test/ordinary-worker-host.test.ts` — 5개 파일 67개 시험 통과. 로그는 `/tmp/brain162g3-d3a-tests.log`다.

- D2A: `pnpm exec vitest run packages/postgres/test/garmin-quarantine.test.ts packages/core/test/protected-api.test.ts packages/postgres/test/extension-permissions.test.ts packages/postgres/test/migrate.test.ts` — 4개 파일 33개 시험 통과. 로그는 `/tmp/brain162g3-d2a-tests.log`다.
- D3 중간: `pnpm exec vitest run apps/cli/test/process-group.test.ts packages/core/test/supervisor.test.ts` — 2개 파일 56개 시험 통과. 로그는 `/tmp/brain162g3-d3-process.log`다. 이후 고정 launcher·sealed registry 변경은 이 실행 범위 이후이므로 후속 재검증이 필요하다.

- `pnpm build`, `pnpm typecheck` 성공. 로그는 `/tmp/brain162g3-build.log`, `/tmp/brain162g3-typecheck.log`다.
- 공통 회귀 명령 `pnpm exec vitest run packages/core/test/extensions.test.ts packages/core/test/supervisor.test.ts packages/postgres/test/work-store.test.ts packages/postgres/test/extension-permissions.test.ts apps/cli/test/ext-install-resume.test.ts`에서 5개 파일 290개 시험 통과. 로그는 `/tmp/brain162g3-core-tests.log`다.
- 기존 Garmin 여섯 파일 묶음 명령을 위와 동일하게 실행해 6개 파일 15개 시험 통과. 로그는 `/tmp/brain162g3-garmin-tests.log`다.
- `uv sync --project extensions/garmin --frozen` 및 frozen Python의 psycopg·garminconnect·curl_cffi import 성공, Python `3.14.10 arm64` 확인. 로그는 `/tmp/brain162g3-frozen.log`다.
- `sh extensions/garmin/tests/native/check-native.sh` 성공. 로그는 `/tmp/brain162g3-native.log`다. 구성 요소 재검증이며 실제 보호 배치·전체 수락 성공이 아니다.

### 이전 generation 근거

현재 generation의 부분 구현 검증이다. 전체 수락·T01–T28·독립 코드 리뷰를 통과했다는 의미가 아니다. 전문 구현 보고는 [구현 최종 보고](story-mfa-0-implementation-report.md)에 있다.

- 지휘자 실행: `pnpm build`, `pnpm typecheck` 성공. 로그는 `/tmp/brain16-g2-final-build.log`, `/tmp/brain16-g2-final-typecheck.log`다.
- 지휘자 실행: `uv sync --project extensions/garmin --frozen` 성공. frozen Python에서 `platform`, `psycopg`, `garminconnect`, `curl_cffi` import가 성공하고 `3.14.10 arm64`를 확인했다. 설치 로그는 `/tmp/brain16-g2-final-frozen.log`다.
- 지휘자 실행: 초기 보호 모듈은 새 격리 PostgreSQL 18에서 `uv run --project extensions/garmin --frozen python extensions/garmin/tests/check_protection.py <격리 포트>`로 통과했다. 이 시험은 격리 포트 인자가 필수다. 이후 확장된 최종 보호 시험의 성공 근거는 구현자 전문 보고에 있다. 운영 DB를 사용하지 않았다.
- 지휘자 실행: 합성 `check_auth_flow.py`, `check_collect.py`, `check_auth_wire.py`, `check_http_guard.py`, `check_tokenstore.py` 통과를 확인했다. 이후 변경된 버전의 최종 Python 시험 및 tokenstore race 반례는 구현자 보고에서 성공·한계를 확인했다.
- 지휘자 최종 실행: `pnpm exec vitest run --config apps/cli/python-test/vitest.config.ts apps/cli/python-test/garmin-protection.test.ts apps/cli/python-test/garmin-collect.test.ts apps/cli/python-test/garmin-tracer.test.ts apps/cli/python-test/garmin-admission.test.ts apps/cli/python-test/garmin-release.test.ts apps/cli/python-test/garmin-auth-wire.test.ts` — 6개 파일 15개 시험 통과. 마지막 fixture 수정 뒤 묶음 전체를 재실행했으며 로그는 `/tmp/brain16-g2-final-cli-tests.log`다.
- 구현자 최종 실행: `pnpm exec vitest run packages/core/test/extensions.test.ts packages/core/test/supervisor.test.ts packages/postgres/test/work-store.test.ts packages/postgres/test/extension-permissions.test.ts apps/cli/test/ext-install-resume.test.ts` — 5개 파일 290개 통과 보고를 수락했다.
- 지휘자 실행: `sh extensions/garmin/tests/native/check-native.sh` 성공. 승인 cdhash 허용·다른 같은 UID 코드 거부 및 익명 XPC 일치/불일치를 확인했다. 로그는 `/tmp/brain16-g2-native-verify.log`다. 실제 승인 UI·서로 다른 서비스 principal·보호된 배포의 증거로 확장하지 않는다.
- 실제 감독자의 합성 Python worker PID 대조·SIGKILL·daemon 재시작과 선행/결과 저장 거부는 위 15개 시험에 포함된다. 전체 예약·force 행렬, OS peer spoof·모든 비밀 canary 경로, 실제 모든 HTTP 전송 계측은 미완료다. CLI doctor 전체 경로는 fixture의 선행 컨테이너 점검 때문에 skip됐고 core doctor와 공개 상태 경로만 검증됐다.

실계정·운영 tokenstore·Garmin 네트워크·운영 배포를 사용하지 않았다. 구성 요소 성공과 정상 인증/수집의 전체 완료를 구분하며 정상 인증 경로는 실패 닫힘으로 유지했다.

## 독립 보안 조사 근거 (2026-11-01)

# 16.2 보안 escalation 독립 조사

- 조사 기준: HEAD `8d071a83d6d11030f71ae0ae255aa25a891dbfa0`, 2026-11-01.
- 범위: 16.2 계획, epic 13/12 티켓·계획, 현재 구현·기존 시험 소스, 반입한 옛 소스 archive. 보고서 외 파일 변경, 빌드, 시험 실행, 실계정·운영 tokenstore 접근, 하위 워커 실행 없음.
- 아래 `file:line`은 저장소 상대 경로다. `A!경로:line`은 `A = _bmad-output/personal-brain/prep-garmin-absorption/inputs/garmin-source.tar.gz` 안 `tar -xOf`로 읽은 파일의 줄 번호다. 반례는 코드의 제어 흐름으로 확인한 실행 추론이며 이번에 시험으로 재현했다는 뜻이 아니다.

## 1. 판단

**현재 HALT는 타당하다.** epic 13은 인증 작업의 감독·재개를 구현했으며, 인증 비밀 입력과 상대 신원 검증을 구현하지 않았다. stdout JSONL에 프롬프트를 섞거나 snapshot secret 설정을 재사용하면 요구를 위반한다. 구현 가능한 추천은 **epic 13 인증 단계에 공통 operator 인증 채널을 추가하고, 감독자가 생성한 auth worker에만 전용 익명 FD를 연결하며, Garmin adapter가 영속 guard·호출 의도·identity binding을 관리하는 것**이다. 다만 아래 세 가지는 이름만 정해서 해결할 수 없는 전제다.

1. **공격자 범위와 실행물 신뢰:** UID와 0700/0600만으로 같은 UID의 악성 프로세스와 승인된 프로그램을 구분할 수 없다. 코드·tokenstore·홈을 같은 UID가 바꿀 수 있는 현재 배치에서, 임의의 같은 UID 공격자에 대한 비밀 보호까지 충족한다고 주장하면 안 된다. 그 수준을 요구한다면 보호된 설치물·OS 검증 가능한 코드 신원·별도 권한 또는 sandbox 경계를 추가해야 한다. 이 보고서는 요구가 낮은 것으로 가정하지 않는다.
2. **미확인 동일 계정:** 서로 다른 미확인 tokenstore A/B가 같은 Garmin profile이라는 사실은 profile 확인 전에 알 수 없다. A의 차단 상태가 있는데 B로 로그인해서 profile을 알아내는 것 자체가 이미 같은 계정의 외부 호출이다. 경로별 키를 나중에 합치는 것만으로 ‘차단 뒤 모든 경로 호출 0’을 보장할 수 없다.
3. **호출·저장 원자성:** 외부 HTTP와 PostgreSQL commit은 원자적이지 않다. 결과를 모르는 호출을 자동 재시도하며 동시에 중복·차단 우회를 0으로 만드는 일반 해법은 없다. 미해결 호출 의도를 계속 차단 상태로 남기는 안전 우선 정책이 필요하다. 저장을 전혀 할 수 없었던 사실까지 재시작 후 기억하라는 요구는 선행 durable guard 없이는 불가능하다.

16.2를 줄이거나 위험도를 낮출 이유는 없다. 위 전제와 auth 전용 재인증 예외, ‘탐색 하나’의 측정 단위를 계획에 결정한 뒤 준비 게이트를 다시 평가해야 한다.

## 2. 직접 확인한 근거와 실제 반례

| 근거 | 확인 사실 | 잘못 연결했을 때의 반례 |
|---|---|---|
| `_bmad-output/personal-brain/tickets/epic-garmin-runtime/tickets/tickets.toml:20` | 비밀번호·MFA는 epic 13 인증 단계만, 같은 client MFA 최대 3회, tokenstore→profile, 보호·직렬화 모두 필수 | 새 독립 login 스크립트가 supervisor와 guard를 우회하면 기능 성공이어도 수락 실패 |
| `_bmad-output/personal-brain/tickets/epic-extensions/tickets/tickets.toml:56`, `_bmad-output/personal-brain/tickets/epic-extensions/tickets/story-untitled-plan.md:33` | manifest.auth를 기존 daemon에 enqueue; 사용자 조치면 login_required. 비밀 transport 규정 없음 | ‘13.5 완료’만 근거로 stdin 입력이 가능하다고 가정할 수 없음 |
| `packages/core/src/extensions/install.ts:184`, `:195` | auth 기존 대상은 extension/name; enqueue에 serializationKey 없음 | collect에만 account 키를 붙이면 auth와 collect가 동시에 외부 호출 |
| `apps/cli/src/runtime/process-group.ts:7`, `packages/core/src/ports/process.ts:1` | detached, stdin ignore, stdout/stderr pipe; 입력·추가 FD port 없음 | 옛 TerminalPrompts를 붙이면 TTY 검사에서 실패. worker가 `/dev/tty`를 임의로 여는 우회도 감독된 operator 세션 계약이 아님 |
| `A!garmin-source/src/garmin_pipeline/auth.py:55`, `:68`, `:74` | stdin isatty 검사 후 password getpass, MFA input | MFA는 옛 구현에서는 echo된다. 새 인증 UI에서 그대로 복사하면 녹화·스크롤백 노출 가능 |
| `packages/core/src/extensions/snapshot.ts:28`, `:40`, `:42`; `apps/cli/src/daemon/supervisor.ts:54`, `:78` | 일반 secret 선언은 실제 secret 값을 snapshot에 직렬화하여 env로 전달 | password를 secret setting으로 선언하면 argv를 피하더라도 ‘snapshot에 비밀 0’ 위반. 설정 참조만 저장한다는 사실이 runtime snapshot의 비밀 부재를 뜻하지 않음 |
| `apps/cli/test/ext-install-resume.test.ts:81`, `:85`, `:111` | 가짜 auth는 ready 파일을 검사하며 비밀 canary 출력 제거를 검사 | ready 파일 생성 성공은 실제 operator 입력·양방향 인증·MFA client 유지의 증거가 아님 |
| `packages/core/src/extensions/run.ts:20`, `packages/core/src/queue/schedule-tick.ts:60` | 수동 extension/default enqueue, 예약도 공통 계정 키 전달 없음 | Python은 account target을 요구(`extensions/garmin/src/collect.py:35`); 현재 공용 CLI를 그대로 연결하면 수집 입력 자체가 불일치 |
| `packages/postgres/src/work.ts:68`, `:78`, `:123`, `:129` | 동일한 non-null 키에만 claim 배타성, merge 시 기존 행 반환 | 새 키로 enqueue해도 열린 null-key 행을 재사용하면 보호 안 됨. TS resolver 추가만으로 기존 열린 행 문제는 해결 안 됨 |
| `packages/postgres/src/work.ts:331`, `:332` | unknown 정산은 current token을 유지 | lease 만료로 auth 세션을 재개·재사용하거나 key를 해제하면 기존 worker와 중복 |
| `packages/postgres/migrations/0004_attempt_fence.sql:9` | current token·미완료·attempt outcome null 검사; cancel_requested/hold 조건은 없음 | ‘attempt_valid=true’만 확인하면 cancel commit 직후에도 intent write 또는 네트워크 허용 가능. 취소/hold와 generation을 추가 검증해야 함 |
| `extensions/garmin/src/collect.py:73`, `:77`, `:91` | 현재 synthetic client 생성 후 attempt 검사, 외부 호출 직전 보호 의도 저장 없음 | 실제 client constructor가 자동 login/refresh하면 최초 guard 검사보다 먼저 외부 호출 |
| `extensions/garmin/src/collect_store.py:46`, `:49` | publisher의 attempt fence와 account/day/endpoint 단위 짧은 트랜잭션 | publish 중복 방지 잠금은 auth·HTTP 전체 기간의 계정 배타 잠금이 아님 |
| `A!garmin-source/src/garmin_pipeline/garmin/__init__.py:490`, `:511`, `:517` | 같은 client MFA 유지하지만 prompt 동안 session 파일 잠금 해제 | 옛 tokenstore flock만 옮기면 MFA를 기다리는 사이 collect 가능; epic 12 attempt 키는 prompt 동안도 유지해야 함 |
| 같은 archive 파일 `:668`, `:673` | block 날짜가 오늘일 때만 거부 | 자정만 지나면 guard가 사라짐. 다음 날 탐색 성공 전 해제 금지와 불일치 |
| `extensions/garmin/pyproject.toml:5`, `extensions/garmin/src/collect_client.py:9`, `extensions/garmin/manifest.json:207` | 현재 psycopg만 의존, 기본 client unavailable, auth 선언 없음 | 실제 garminconnect 내부 HTTP retry·refresh 횟수까지 현재 코드로 검증했다고 주장할 근거 없음 |

## 3. 추천 transport와 접근 권한 계약

### 3.1 구성과 책임

공통 core에 `AuthSession`/`AuthChannel` port를 추가하되 Garmin 비밀번호·MFA의 의미와 계정 guard는 extension에 둔다. 기존 `manifest.auth`만 채널 사용 권한을 선언할 수 있고 connection_check·collect·release-block에는 입력 FD를 주지 않는다. `ProcessSpec`에 임의 파일·숫자를 받는 범용 통로보다 launcher가 소유하는 typed auth channel capability를 둔다. `ProcessHandle`은 채널 취소·close를 감독자 종료 경로와 함께 수행해야 한다. 기존 port에는 이 계약이 없으므로 필수 공통 코드 변경이다(`packages/core/src/ports/process.ts:1`).

비밀 흐름은 `신뢰된 operator UI → 로컬 인증 broker → 해당 auth worker의 익명 FD`다. worker→broker 요청은 별도 FD로 역방향 전달한다. stdin은 기존 ignore, stdout은 ABI 1 JSONL만 유지한다. 자식용 FD 번호 3/4는 예시이며 비밀이 아니다. 소켓 경로·session id도 인증 비밀로 취급하지 않고, 읽었다는 이유로 접속 권한을 주지 않는다. capability key는 메모리와 전용 FD에만 두며 argv/env/snapshot/DB/파일/Orca 메시지에 싣지 않는다.

기존 daemon이 worker를 직접 생성하고 감독한다. operator가 별도 Garmin worker를 띄우거나 별도 runSupervisor를 시작하지 않는다(13.5 계약). 첫 install은 login_required와 비밀 없는 안내만 반환할 수 있다. 실제 operator 접속은 epic 13 인증 단계용 명시 진입점(예: 제안 `brain ext auth <name>`) 또는 같은 install의 명시 대화형 모드로 등록해야 한다. 이 이름은 현재 명령이라고 주장하는 것이 아니며 CommandSpec/SDK/guide와 설치 스킬을 함께 수정해야 한다. 스킬·채팅은 입력을 대리하지 않는다(`_bmad-output/personal-brain/tickets/epic-extensions/tickets/tickets.toml:80`).

### 3.2 양방향 신원과 권한: 생략할 수 없는 부분

- broker는 OS가 제공하는 peer 자격 증명을 검증한다. 사용자 session·UID 일치는 최소 조건이며 명시된 home/instance, manifest.auth kind, work id, current attempt token, run generation, supervisor incarnation, package digest, spawn으로 얻은 OS process identity를 일치시킨다. worker가 보내는 JSON PID나 DB token만으로 상대 신원을 인정하지 않는다.
- worker는 broker와의 spawn 관계로 물려받은 FD에서만 bootstrap하며, broker key에 대한 challenge 응답을 검사한다. 일반 파일에 bootstrap key를 써서 파일을 읽은 임의 프로세스가 impersonate할 수 있게 만들지 않는다. 자식 외 다른 프로세스의 FD 상속을 막고 worker가 만드는 후손에게도 채널을 넘기지 않는다.
- operator UI도 broker를 검증하고 broker도 operator UI를 검증한다. 세션 ID를 안다는 사실, 같은 UID, 소켓 파일 owner만으로 ‘승인된 UI’라고 부르지 않는다. UI는 operator에게 extension·설치물·인증 단계·대상 세션을 명시하고 실제 사용자가 그 요청을 선택한 뒤에만 입력을 받는다. daemon/agent가 몰래 자동 attach하여 입력을 청구할 수 없어야 한다.
- 서로 다른 OS 사용자를 막는 최소 구현은 owner-only runtime 디렉터리 0700 + socket 0600, kernel peer UID 검사, 안전한 경로 생성·검사다. **이것은 같은 UID 악성 프로세스를 막는 구현이 아니다.** 루프백 TCP+추측 어려운 URL, 0600 nonce 파일, `/proc`/명령행을 통한 자칭 CLI 확인을 동급 대안으로 인정하지 않는다.
- 같은 UID 악성 프로그램까지 위협 범위라면 **추천 강한 구현은 OS가 검증하는 signed native UI/broker IPC와 보호된 실행물·tokenstore 권한 경계**다. macOS는 XPC/audit-token 기반 peer code identity 검증을 구현 후보로 삼을 수 있다. 정확한 API·entitlement·배포 가능성은 별도 구현 spike로 입증해야 하며 현재 Node/Python port에 있다고 가정하지 않는다. 서명된 일반 Node 인터프리터라는 이유만으로 실행한 임의 JS를 신뢰하면 안 된다. 승인된 UI/worker code와 로딩 경로가 사용자 임의 변경으로 바뀌지 않도록 해야 한다.
- 0700/0600 tokenstore가 같은 UID 전체에 읽히는 현재 모델에서 같은 UID 공격자에 대한 토큰 비노출을 동시에 보장할 수는 없다. 강한 위협 범위라면 auth worker/library와 tokenstore를 보호된 OS service principal 또는 검증된 sandbox 안으로 옮기고 라이브러리만 login/dump하게 한다. 이는 신규 설치·권한·프로세스 배치 설계이며 ‘소켓 하나 추가’로 대체되지 않는다. root/OS 침해까지의 보장은 이 구조로도 주장할 수 없다.

따라서 안전한 결정문은 ‘같은 UID는 신뢰한다고 암묵 축소’가 아니라 **요구하는 공격자 범위를 명시하고 그 수준의 peer·실행물·storage 경계가 입증되기 전 입력 채널을 열지 않는다**이다. 신원 API 미지원·검증 결과 unknown은 AUTH_PEER_UNVERIFIED로 실패 닫힘이다. 현재 코드·티켓만으로 이 선택이 이미 승인되었다고 볼 수 없다.

### 3.3 wire·수명·취소

새 인증 전용 protocol은 ABI stdout과 별개다. 길이 prefix frame(상한 예: 16 KiB), version, session epoch, 방향별 단조 seq, prompt id, 허용 enum(credentials/mfa/cancel/ack), 고정 필드 집합을 검증한다. request와 response의 session·prompt·seq를 묶으며 중복·역순·이전 MFA 응답을 재사용하지 않는다. capability key의 인증 태그를 전체 frame에 적용하고 nonce 재사용을 금지한다. 연결이 인증되기 전에 비밀 frame은 전송하지 않는다. framing parser는 잘린 frame·초과 길이·비정상 UTF-8·알 수 없는 필드에서 즉시 닫고 raw frame을 오류에 넣지 않는다.

세션 tuple은 `(homeInstance, extension, packageDigest, workId, attemptToken, runGeneration, incarnation, OS child identity, sessionEpoch)`다. UUID attempt token 자체를 operator attach 권한으로 삼지 않는다. 동시에 operator 하나, prompt 하나만 허용한다. MFA는 동일 worker·동일 client에서 최대 3회이며 reconnect/new client로 카운터를 초기화하지 않는다. broker는 password와 MFA 모두 echo 없는 신뢰된 UI로 받는다. 일반 stdin pipe·환경변수 fallback은 금지한다.

권고 초기 상한은 attach 대기 60초, prompt idle 120초, 인증 세션 전체 5분이다. 이는 선택할 제품 상수이며 현재 티켓의 사실이 아니다. MFA 제공자 만료가 더 짧으면 더 짧은 제한이 우선한다. wall clock 변경으로 연장되지 않도록 monotonic timer를 쓴다. heartbeat만으로 idle을 갱신하지 않는다. 실제 인증 상태 전이만 제한된 횟수의 비밀 없는 progress로 내고 supervisor stall 규칙과 일치시킨다. 현재 heartbeat는 lastProgress를 갱신하지 않는다(`packages/core/src/queue/supervisor.ts:255`).

disconnect·timeout·사용자 취소·disable/hold·attempt 회수·incarnation 변경·worker 종료·protocol 오류마다 먼저 입력 권한을 폐기하고 FD를 닫는다. 민감 버퍼 참조를 즉시 버리고 가능한 mutable buffer는 덮되 Python/JS immutable string·라이브러리 내부 사본의 완전한 zeroization은 보장한다고 쓰지 않는다. broker/key를 재시작 후 복구하지 않는다. 이미 보낸 HTTP를 취소로 되돌릴 수 없으므로 결과 미확정 의도는 남긴다. 그룹 종료가 unknown이면 session은 폐기하되 기존 attempt 키·보호는 유지한다. 종료 증명 전 새 auth attempt의 입력을 열지 않는다(`packages/core/src/queue/supervisor.ts:284`, `packages/core/src/queue/process-cleanup.ts:44`).

현재 spawn 직후 worker가 코드 실행을 시작하고 OS identity 기록은 나중이다(`packages/core/src/queue/supervisor.ts:180`, `:205`, `:209`). 그러므로 auth worker는 시작하자마자 **인증 완료 bootstrap ACK까지 대기**해야 한다. process identity를 저장/검증하기 전에 constructor/login/prompt 요청을 실행하면 안 된다. 성공 정산도 DB auth 성공 commit→ABI result→exit 0→그룹 종료 확인의 순서를 지켜야 하며 result 한 줄만으로 latch를 풀지 않는다.

## 4. 계정 직렬화와 identity 전환 계약

### 4.1 공통 enqueue와 현재 단일 키의 한계

공통 resolver가 인증·수동·예약·retry/force·connection check의 **모든 외부 호출 가능 경로**에 안정적인 `(source, canonicalAccountId)` 키를 공급해야 한다. Garmin 전용 의미는 extension resolver/protection projection에 두고 core는 opaque key와 claim 제약만 처리한다. account 표시는 공개 로그/계획에 내지 않고, 내부 key는 delimiter 충돌 없는 인코딩 또는 내부 UUID 참조를 쓴다. 해시만으로 임의 사용자명 입력을 canonical identity라고 인정하지 않는다.

인증 대상이 아직 extension/name인 13.5의 journal 검증(`install.ts:184`)도 바꿔야 한다. 구현안은 journal에 비밀 없는 stable auth-target ID를 두고 그 target의 tokenstore binding과 canonical key를 resolver가 읽게 하는 것이다. work target을 바꾸면 기존 resume·dedupe 계약을 함께 변경한다. `authWorkId` 재조회 시 kind·stable target·package identity·binding generation을 검증한다. 열린 동일 대상 work가 다른 key/generation이면 merge 성공으로 넘기지 말고 원래 attempt 종료 확인 또는 명시 migration/requeue를 요구한다(`work.ts:129`). 실행 중 key를 덮어쓰지 않는다.

모든 생성 경로가 실제 같은 key를 내는 integration 시험이 필요하다. 같은 collect work 두 개는 open-target UNIQUE로 하나로 합쳐질 수 있으므로, 동시성 시험은 auth vs collect 또는 서로 다른 날짜/안정 대상처럼 **합쳐지지 않는 작업**을 사용해야 한다. 기존 PG 시험은 키 경쟁을 실제 SQL로 검사하지만 Garmin key 공급까지 검사하지 않는다(`packages/postgres/test/work-store.test.ts:763`). 기존 collect 통합 fixture enqueue도 serializationKey가 없다(`apps/cli/python-test/garmin-collect.test.ts:38`).

### 4.2 최초 미확인 계정과 alias 병합

tokenstore는 expanduser 후 안전하게 열린 디렉터리의 canonical path·device/inode·owner/권한 등으로 stable target에 binding한다. 경로 문자열의 `..`/symlink/대소문자 alias만 바꿔 다른 보호 키를 얻을 수 없어야 한다. 삭제·재생성·owner 변경·다른 tokenstore로 설정 변경은 binding 재확인을 요구하며 guard를 초기화하지 않는다. 같은 profile의 서로 다른 정상 tokenstore는 inode만으로 합쳐지지 않으므로 별도 canonical account alias 표가 필요하다. 토큰 JSON을 직접 파싱해 profile을 추정하지 않고 library profile의 사용자 profile id로 확정한다.

추천 절차는 다음과 같다.

1. 미확인 target은 tokenstore 키와 **source discovery 배타 gate**를 보유한다. 확인된 계정 실행은 각 account 키와 discovery의 공유 gate를 보유한다. 이 조합은 발견 중 확인된 계정의 HTTP와 겹치지 않으면서 확인된 서로 다른 계정은 병렬로 허용한다. unknown holder는 임대 만료로 gate를 놓지 않는다.
2. 현재 epic 12의 단일 serializationKey는 이 공유/배타 다중 gate를 표현하지 못한다(`work.ts:70`). core의 generic multi-resource claim 또는 별도 명시된 account admission port가 필요하다. 숨겨진 문자열 키 규칙으로 만족했다고 주장하지 않는다. 구현은 짧은 DB tx에서 gate-holder 행과 attempt/generation을 원자적으로 기록하고 tx를 종료한다. HTTP 동안 쓰기 tx를 잡지 않는다. 프로세스 종료가 unknown이면 holder 행을 유지한다. PG session advisory lock만 쓰면 DB 연결 끊김 뒤 살아 있는 worker의 HTTP와 겹칠 수 있어 durable holder/fence를 대체하지 못한다.
3. **동시성 gate는 차단 우회 문제를 해결하지 않는다.** 미확인 target이 어느 기존 protected account인지 알 수 없으면, 그 source에 미해결 auth/rate/uncertain 보호가 존재하는 동안 discovery 외부 호출을 허용하지 않는 보수적 규칙이 필요하다. 다른 확인된 안전 계정의 실행은 기존 canonical key로 가능하다. 보호가 없는 초기 상태에서만 discovery를 허용하고 profile 확정 뒤 기존 canonical guard를 다시 조회한다.
4. profile을 얻으면 짧은 tx에서 tokenstore guard와 canonical guard를 함께 잠그고, alias를 결합하고, 가장 제한적인 보호 사실을 **합집합**으로 보존한다. 단일 enum 우선순위만 고르면 auth+rate 중 하나가 사라질 수 있으므로 독립 latch를 유지한다. 최초 binding의 인증 성공이 기존 canonical rate/manual-required/uncertain 상태를 지우면 안 된다.
5. 현재 discovery holder를 canonical holder로 원자적으로 이전하고 다른 holder가 없음을 확인한 뒤 공유 discovery gate로 낮추거나, discovery attempt를 완전히 종료하고 canonical key로 새 일감을 enqueue한다. 어느 방식을 택해도 key 교체 사이 무보호 gap과 두 account 키를 반대 순서로 잠그는 deadlock을 막아야 한다. 잠금 순서는 stable ID 정렬 등 하나로 고정한다. canonical 보호 때문에 이어갈 수 없으면 더 이상의 네트워크 없이 중단한다.
6. 이미 binding된 tokenstore의 profile이 달라지면 자동 재지정하지 않고 IDENTITY_MISMATCH로 기존·새 target을 격리한다. 기존 보호·이전 반입 account/authority를 덮지 않는다. binding generation을 올리고 해당 세대의 새 검증 절차를 요구한다.

**남는 불가능 전제:** 새 target의 인증으로 이미 막힌 계정의 latch를 풀어야 하지만 profile은 그 인증 뒤에만 알 수 있고, 그 인증 자체도 ‘해제 전 외부 호출 0’에 포함한다면 논리적으로 진행할 수 없다. 안전을 유지하려면 기존 binding에 대한 전용 재인증만 예외로 허용하거나, 신뢰 가능한 offline binding을 먼저 제공하거나, 미확인 target을 계속 차단해야 한다. ‘새 tokenstore는 새 계정’으로 간주하는 방안은 추천하지 않는다. 현 티켓에는 이 예외/선행 증명 계약이 없어 결정이 필요하다.

추가로 현 `listOpenSupervisedAttempts`는 outcome null과 channel_send의 unknown만 반환한다(`packages/postgres/src/work.ts:319`). Garmin이 unknown으로 정산되면 키는 유지되지만 이 조회를 쓰는 일반 reconcile이 그 unknown을 자동 복구한다고 볼 수 없다. 안전하게 계속 막히는 상태와 종료 확인 후 다시 진행할 수 있는 복구 기능을 구분하고, Garmin unknown 복구가 필요하면 명시 port/증거·권한 계약을 추가해야 한다. token을 수동으로 지우는 것을 제품 복구 절차로 삼지 않는다.

## 5. 영속 latch와 호출 의도: 구현할 상태·전이

### 5.1 최소 데이터 모델

새 migration(적용된 기존 migration 수정 금지)에 다음 논리 구조를 둔다. 이름은 제안이며 token/password/MFA/예외 원문은 어느 칼럼에도 넣지 않는다.

- `account_binding`: stable target, canonical account 내부 ID, binding generation, 검증 근거의 종류·시각. tokenstore→account alias와 발견 전 target guard를 연결한다.
- `account_protection`: account/target별 auth-required, rate-blocked, manual-release-required, uncertain flags; 각 원인 generation/발생일; consecutive403; row version. 각 latch는 독립적이다.
- `external_call_intent`: operation ID, attempt/work/generation, binding generation, 허용 stage/endpoint, started/finished, pending/committed outcome enum, 예약된 probe day. pending이 남으면 uncertain을 유도한다.
- `probe_reservation`: canonical account + 현지 날짜 unique, 대상 rate generation, intent ID, 상태. 재시작/재예약이 동일 날짜의 두 번째 탐색을 만들지 못한다.
- 필요하면 `admission_holder`: account/discovery gate, attempt identity, mode, release 증거. core에 들어가는 부분은 opaque resource/generation으로 유지한다.

`garmin.attempt_valid`는 확장 role와 현재 attempt를 확인하는 재사용 지점이다(`extensions/garmin/migrations/0002_batch_import.sql:9`). 하지만 이것만으로 cancel/hold/binding generation까지 확인한 것은 아니다. 새로운 짧은 owner 검증 함수/port에서 current attempt + auth kind/target + cancel 없음 + hold 없음 + 현재 binding/protection version + admission holder를 함께 검사한다. extension role가 core work를 직접 UPDATE하거나 임의 다른 확장의 입력을 받을 권한을 주지 않는다(13.4 권한 조건: `_bmad-output/personal-brain/tickets/epic-extensions/tickets/tickets.toml:45`).

### 5.2 호출 전후 순서와 저장 실패

`인증 bootstrap 확인 → admission/guard 조회 → 쓰기 가능한 선행 guard·의도 commit → 외부 호출 → 결과/보호 짧은 commit → 다음 호출` 순서다. guard 이전에는 import-time 네트워크, client constructor I/O, session login, token refresh, profile 읽기를 포함한 자동 I/O가 없어야 한다. 실제 라이브러리 생성이 순수하지 않으면 네트워크 primitive를 먼저 봉쇄하고 승인된 transport에서만 열거나 client 생성 자체를 의도 뒤로 옮긴다. 승인하지 않은 내부 자동 요청이 있다면 adapter 수준 gate가 필요하다.

각 intent tx는 2초 이하로 끝내고 HTTP·operator 입력 대기·sleep 동안 열어 두지 않는다. 현재 collect connection의 transaction_timeout/statement_timeout/lock_timeout 패턴(`extensions/garmin/src/collect.py:75`)을 활용할 수 있지만 DB timeout 값 선언만으로 전체 호출 경계가 구현되었다고 주장하지 않는다.

- intent commit 실패/commit 결과 불명: HTTP 0, session 중지. DB가 복구되어 commit 여부를 확인하기 전 새 호출 금지.
- 호출이 끝났지만 result write 실패: pending intent 유지, 다음 호출 0. 재시작은 그 pending을 실패·성공으로 추정하지 않고 uncertain 차단한다.
- intent commit 직후, 실제 전송 전 crash: pending이 남아 보수적으로 차단한다. 호출하지 않았다고 추정해 자동 재시도하면 안 된다.
- 보호 전이 commit 직후 crash: 같은 latch가 재시작에서 남고 모든 경로에 적용된다.
- kill·취소가 이미 전송된 HTTP를 취소했다는 보장은 없다. DB fence는 오래된 결과 쓰기를 막지만, 이미 나간 HTTP를 회수하지 못한다. 취소 commit과 네트워크 send가 다른 시스템이므로 나노초 수준 ‘취소 이후 전송 절대 0’은 현재 port로 원자 보장할 수 없다. cancel을 관찰한 이후 새 요청 금지, in-flight는 미확정으로 격리한다는 경계를 명시해야 한다. 더 강한 요구면 실제 네트워크를 소유하는 broker가 단일 admission/send 순서를 책임져야 한다.

**중요: 최초 저장 거부의 재시작 보장.** 첫 guard 기록도 실패해서 아무 durable 사실이 없고 worker가 종료된 상황에서 다음 실행이 ‘지난번 저장 실패’를 알 방법은 없다. 이 조건까지 재시작 무호출을 요구하려면 auth/collect launch 전에 supervisor가 별도 권한으로 durable pending admission을 생성하고, worker가 이를 정상 종료시켜야만 다음 admission을 허용하는 계약을 둔다. worker의 모든 쓰기를 거부하는 시험에서도 supervisor의 선행 admission은 이미 commit되어 있어야 한다. 그 선행 저장 자체가 실패하면 launch하지 않고 core attempt가 미완료인 채로 남도록 해야 한다. 전체 저장 매체의 파괴까지 기억한다는 주장은 불가능하며 DB 미확인 시에는 기본 거부한다. 불확실한 admission은 일반 재시도로 자동 해소하지 않는다.

### 5.3 독립 latch 전이

| 현재 latch/사건 | 허용하는 것 | 해제 조건 | 금지되는 해제 |
|---|---|---|---|
| auth-required/MFA | 기존 binding에 대해 명시된 epic 13 auth 세션의 재인증 절차만 예외 후보 | 동일 client 로그인+profile identity 검증+library dump+권한 검증+현재 attempt/binding 세대의 DB 성공 commit | collect의 login 성공, 파일 mtime, 다음 날, 수동 release-block |
| rate-blocked 당일 | 로컬 상태 조회만 | 당일에는 없음 | force, 재인증, tokenstore 교체 |
| rate-blocked 다음 현지 날짜 | auth/uncertain/manual latch가 없을 때 예약된 probe 하나만 | probe 성공을 현재 rate generation과 CAS commit | 날짜 경과만, probe 예약만, NoData/부분 성공을 임의 성공 처리 |
| 다음 날도 429/차단 | 외부 호출 중지, manual-required 설정 | 명시 release-block가 rate/manual 사실을 CAS 해제 | 자정 반복 probe, auto retry |
| release-block | 계정 키를 가진 수동 로컬 DB 일감 | current attempt/권한 확인 후 rate/manual만 제거, 감사용 고정 사건 기록 | auth-required/uncertain/binding mismatch 제거, 해제 확인용 자동 HTTP |
| uncertain/pending intent | 상태 조회·운영 복구 판단 | 이미 확정된 결과의 증거 또는 별도 명시 복구 계약 | TTL/lease/날짜/worker 종료만으로 정상 간주 |
| 403 연속 3회 | 앞 두 번은 정책상 허용된 다음 데이터 호출; 세 번째 결과 저장부터 추가 호출 0 | 정해진 rate-block 해제 절차 | first-call 보호 403을 일반 counter로 섞기, 새 attempt로 counter 초기화 |

문구 ‘MFA 후 재인증 성공 전 외부 호출 0’을 auth 절차 자체에도 적용하면 재인증을 할 수 없다. ‘일반 login/refresh/collect는 0이며, 권한 있는 auth 단계의 해당 재인증 호출만 예외’라는 문장을 명시해야 한다. 이는 숨은 우회를 추가하는 것이 아니라 기존 성공 해제 규칙이 실행 가능하려면 필요한 범위를 드러내는 것이다. auth 성공은 rate/uncertain latch까지 해제하지 않는다. 인증 대기 중인 하나의 client의 연속 MFA 3회와, 종료 후 새로 승인된 별개 재인증을 구분하고 비밀 없는 auth generation으로 기록한다.

429/403 등의 결과를 받기 **전에 그 정확한 결과를 저장**할 수는 없다. ‘외부 호출 전에 먼저 저장’은 최초 부정 결과 이전에 pending intent를 durable하게 저장하고, 해당 결과를 받은 뒤에는 다음 HTTP 전에 latch를 durable하게 저장한다는 뜻으로 구체화해야 한다. 이 해석 없이 알려지지 않은 미래 상태를 미리 기록한다는 계약은 불가능하다.

### 5.4 pacing·probe·라이브러리 내부 HTTP

호출 간 최소 1초(선택 지연 1~2초), 날짜 사이 최소 5초는 source/account gate를 통해 auth/collect 경계를 넘어서도 적용한다. 매 실행 로컬 `last_call=0`으로 초기화하면 직렬화된 A 종료 직후 B 시작이 1초 미만일 수 있다. persistent next_allowed_at과 실행 중 monotonic timer를 조합하며 clock 역행은 일찍 허용하지 않는다. client 내부 retry·refresh·profile HTTP는 외부 호출 budget/pacing에서도 관찰해야 한다. endpoint별 first-call 3건은 실행 시작의 동일 계정 raw snapshot으로 결정하고 실제 시도 직전에 slot을 소비한다. 프로세스 재시작을 새 ‘실행’으로 볼지 상위 work/run으로 볼지 고정해 crash로 3건을 다시 얻지 못하게 한다.

‘다음 날 탐색 하나’에는 두 선택이 있다. 하나의 논리 library operation이라면 내부 HTTP 여러 건이 발생할 수 있음을 밝히고 그 전체를 intent로 묶는다. **하나의 실제 HTTP 요청이 요구라면** login/refresh가 여러 HTTP를 필요로 하는 client에서 단순 wrapper로는 충족 불가다. 이미 유효한 session으로 승인 endpoint 한 건만 전송하도록 low-level HTTP gate를 구현하고 자동 retry/refresh를 차단하거나, 그 전제의 client가 없으면 probe를 수행하지 않아야 한다. 어느 쪽이 요구인지 결정되기 전 ‘login 한 번 + 데이터 한 번’을 탐색 하나라고 적으면 보안 수준을 줄이는 결과가 된다. 현재 garminconnect가 lock에 없으므로 정확한 요청 그래프를 확인한 상태가 아니다(`extensions/garmin/pyproject.toml:5`).

## 6. 공격 반례와 실패 닫힘 검증 행렬

아래는 **구현 후 실행할 검증 설계**다. 이번 조사에서 실행하거나 통과했다고 주장하지 않는다. 전부 합성 비밀·fake HTTP·격리 홈/PG·실제 감독자를 사용하며 운영 tokenstore·Garmin 네트워크는 사용하지 않는다. secret canary를 단순 `password=` 형태뿐 아니라 일반 패턴에 안 걸리는 임의 문자열로 두어 masking 정규식 의존을 잡는다.

| ID | 공격/실패 주입 | 반드시 관찰할 결과 |
|---|---|---|
| T01 | stdin 비TTY, pipe 입력, operator 미접속 | password/MFA fallback 없음, 비밀 수집·외부 호출 0, login_required/고정 코드 |
| T02 | socket 경로만 안 타 UID, 같은 UID 미승인 executable, 가짜 broker | 양쪽 peer 검증 실패 전 prompt/비밀 frame 0; 강한 threat model에서는 같은 UID도 거부됨을 OS 증거로 확인 |
| T03 | home alias·socket 선점·symlink 부모·owner 변경·실행물 교체 | 잘못된 endpoint로 연결하지 않음, original path 검증 후 교체하는 TOCTOU도 주입; peer 미확인이면 fail closed |
| T04 | 다른 extension/work/attempt/package/gen의 정상 session id·token 재사용 | 입력 권한 없음, 새 worker로 frame 전달 0, audit는 고정 오류만 |
| T05 | old prompt/seq 재전송, 두 operator 동시 attach, MFA response 역순 | 하나만 유효, 중복 MFA 제출 0, 실패 후 session 재사용 금지 |
| T06 | frame 초과 길이·부분 frame·unknown version/field·잘못된 태그 | 크기 제한 안에서 연결 닫힘, raw payload/exception 없음, 다음 외부 호출 0 |
| T07 | 실제 operator password+MFA 합성 입력; library가 모든 출력 채널에 canary 누출 시도 | argv/env/snapshot·stdout/stderr·로그·work_attempts·failures·doctor·journal·임시 파일·UI 스크롤백에 canary 0. worker 내부 메모리 사용과 tokenstore의 라이브러리 토큰 저장만 명시 예외 |
| T08 | worker spawn 이후 OS identity 저장을 지연/실패 | bootstrap ACK 전 constructor/login/네트워크 0; child와 helper 정리, unknown이면 token/gate 유지 |
| T09 | MFA 오답 3번, reconnect 시도, client 교체 주입 | client identity 하나, 제출 최대 3회, 네 번째 없음, auth latch 유지; 별도 auth 세대 승인 없이 재시작 금지 |
| T10 | attach/idle/total timeout, operator disconnect, GUI 종료, SIGINT | 입력 채널 즉시 폐기·echo 상태 복원·추가 frame 0; 프로세스 그룹 종료 확인 전 새 auth 시작 없음 |
| T11 | hold/disable/cancel commit 후 boundary, stale token/binding gen 제출 | guard 쓰기·다음 HTTP 거부; 이미 in-flight 요청은 uncertain으로 구분, 취소 요청을 종료 확정으로 표시하지 않음 |
| T12 | auth/collect 동시 enqueue, 예약·수동·retry/force 각각 같은 계정 | dedupe로 합쳐지지 않는 작업에서도 외부 호출 구간 비중첩, 실제 serializationKey/gate holder 관찰 |
| T13 | 확인된 계정 A/B 동시 실행, 같은 계정 tokenstore A1/A2 | A/B 병렬 허용, A1/A2 직렬; key hash 또는 경로가 다르다는 이유로 같은 profile 병렬 없음 |
| T14 | 두 미확인 tokenstore가 같은 profile 반환, discovery 중 확인된 collect 실행 | 발견 기간 exclusive gate, binding 전후 무보호 gap 0, canonical latch 합집합 보존 |
| T15 | 차단된 A 후 미확인 B가 실제 A의 credentials 사용 | identity를 알아내겠다며 로그인하지 않고 discovery 거부. offline 증명/명시 auth 예외 없이는 안전하게 진행 불가임을 결과로 인정 |
| T16 | 열린 null-key work에 새 key enqueue, 다른 binding gen work merge | 잘못된 merged work 시작 0; 명시 충돌/복구. 성공 응답의 returned key/gen도 확인 |
| T17 | unknown attempt, lease 만료·daemon 재시작·PID 재사용·boot 변경 | expiry만으로 key/gate 해제 없음, OS identity unknown이면 signal/성공 추정 없음; 실제 종료 증거로만 정상 정산 |
| T18 | constructor/import/login/token refresh 자동 HTTP 주입 | durable admission/intent 이전 네트워크 0. fake adapter 메서드 호출 수와 실제 전송 수를 따로 센다 |
| T19 | intent commit 직후·전송 직전 barrier에서 worker SIGKILL | 재시작 pending/uncertain 보존, 외부 호출 누계 증가 없음, TTL로 해제 안 됨 |
| T20 | HTTP 429/3번째 403 결과 후 보호 commit 직후 SIGKILL | 보호 상태와 누계 유지, 나머지 endpoint 및 재실행 0; 실제 worker PID 확인·reap 뒤 재시작 |
| T21 | worker의 호출 전 write 권한 거부, 결과 write 권한 거부, commit 응답 유실 | supervisor 선행 admission이 남고 재시작 무호출; before/after commit을 구별, DB 미확인 상태를 정상으로 전환하지 않음 |
| T22 | auth-required 상태에서 날짜 변경·mtime 변경·force·release-block | 일반 외부 호출 0, auth latch 유지. 명시 auth 단계만 허용 범위 안에서 재인증 |
| T23 | rate-block 당일 auth 성공·tokenstore 변경, 다음 날 probe 동시 요청·재시작 | auth가 rate latch 지우지 않음, day reservation 하나. 성공 commit 후에만 rate 해제 |
| T24 | 다음 날 probe 재차 차단, 다음다음날 자동 실행 | manual-required 유지, 추가 probe 0. release-block는 rate/manual만 지우고 auth/uncertain 유지 |
| T25 | auth dump 성공 뒤 DB 성공 저장 실패, 권한 잘못된 token 파일 | token 파일이 생겨도 latch 유지, 다음 collect 0, 파일 권한 실패를 auth 성공으로 기록하지 않음 |
| T26 | profile mismatch, 기존 더 강한 canonical guard, 같은 계정 다중 alias 동시 병합 | 기존 account/authority 불변, latch 합집합, 세대 CAS 실패 시 network 0, deadlock timeout은 안전 중단 |
| T27 | 내부 HTTP retry·refresh, probe library op가 HTTP 3건 시도 | 선택한 ‘탐색 하나’ 정의 위반 검출. 실제 HTTP 1건 계약이면 두 번째 전송 gate 거부 |
| T28 | 1초 미만 간격의 연속 work, 날짜 전환, wall clock 역행, first-call 4번째 | 실제 전송 시각 기준 최소 1초·날짜 5초, endpoint 상한 초과 없음; 라이브러리 내 retry도 측정 |

정리 경로는 fixture barrier 해제→해당 합성 자식만 종료/reap→daemon abort/await→store.close→fixture.cleanup이다. 권한 실패 주입은 복원한다. 손자 프로세스가 FD를 상속한 경우도 넣어 EOF만으로 정리를 판단하지 않는지 확인한다. 기존 `packages/core/src/queue/process-cleanup.ts:44`의 빈 그룹 확인을 유지한다. 기존 Garmin collect fixture barrier는 fetch 뒤 publish 전(`apps/cli/python-test/garmin-collect.test.ts:58`)이므로 T19/T20의 의도/보호 commit 직후 barrier는 새로 필요하다.

## 7. 구현 위치와 게이트 재개 조건

공통 부분은 `packages/core/src/ports/process.ts`, `packages/core/src/queue/supervisor.ts`, `packages/core/src/extensions/install.ts`, `packages/core/src/extensions/run.ts`, `packages/core/src/queue/schedule-tick.ts`, `packages/postgres/src/work.ts`, `apps/cli/src/runtime/process-group.ts`, `apps/cli/src/daemon/supervisor.ts`와 새 auth broker/UI adapter다. typed channel·세션 수명·generic admission/key resolver를 구현하고, peer가 검증된 기능만 capability로 광고한다. 지원되지 않는 platform에서 insecure fallback을 하지 않는다.

Garmin 부분은 새 auth/client/protection 모듈, 새 migrations, manifest.auth·tokenstore 설정·허용 오류 코드, pyproject/lock이다. 현재 manifest decoder는 auth에 kind/execution/runtime/entry만 표현하므로 새 채널 권한 선언을 도입하면 manifest schema·가이드·fixture도 함께 갱신해야 한다(`packages/core/src/extensions/manifest.ts:61`). tokenstore는 일반 string 경로 설정으로 기본 `~/.garmin-pipeline/tokens`와 명시 경로 선택을 유지한다. `machine: tokenstore`는 설치 폴더의 고정 위치를 공급하므로 이를 덮어씌우면 안 된다(`apps/cli/src/daemon/supervisor.ts:54`). 파일 본문은 library login/dump만 읽고 쓰게 하되 디렉터리·owner·symlink·파일 권한 검증은 별도 adapter 책임으로 둔다. library가 0600/0700·비원자 쓰기·symlink 방어를 보장한다고 소스 확인 없이 가정하지 않는다.

재개 전에 다음 결정문이 필요하다.

1. 공격자 범위(다른 UID / 같은 UID 악성 프로세스 / 관리자)와 신뢰할 실행물·operator UI·tokenstore 경계를 명시한다. 같은 UID도 포함하면 OS 격리·서명 검증 배포를 scope에 넣고 그 전에는 입력 채널을 닫는다.
2. operator 채널은 auth 전용이며 양쪽 신원 검증, spawn bootstrap ACK, 비밀 전달 FD, prompt/seq/TTL/취소, 출력 금지를 위 계약으로 명시한다. 현재 코드에 없는 승인된 인증 진입점과 소유 epic를 명시한다.
3. auth-required와 rate-block의 일반 외부 호출 금지에 대한 **좁은 재인증/probe 예외**를 명시한다. 서로 독립인 latch와 uncertain의 복구 권한을 정한다. 예외를 정의하지 않으면 진행 불가능한 상태가 있다는 사실을 인정한다.
4. 미확인 tokenstore의 conservative discovery gate·canonical binding 병합·기존 차단 보존 및 기존 null-key work 처리 방식을 명시한다. 단일 키만으로 모든 경우를 해결했다는 가정을 제거한다.
5. 선행 durable admission과 per-call intent, 결과 저장 실패·commit 불명·crash의 차단 규칙, HTTP 호출의 측정 단위를 명시한다. 라이브러리 내부 요청을 관찰/제어할 수 없으면 그 요구를 충족했다고 쓰지 않는다.
6. 위 검증 행렬을 16.2 수락 항목에 연결한 뒤 빌드·시험·frozen lock 검증은 별도 구현 단계에서 수행한다. 실계정·운영 tokenstore·배포·예약 전환은 16.9에 남긴다.

이 보고서는 보안 공백을 ‘사소한 구현 선택’으로 해소했다고 판정하지 않는다. transport를 정하는 것 외에도 같은 UID 신뢰, 발견 전 identity, 재인증/probe 예외, 불확실한 외부 호출의 복구가 결정되어야 안전하게 구현할 수 있다. 현재 소스에서 재사용 가능한 것은 supervised auth lifecycle, OS process-group 정리, opaque key 배타 claim, attempt fence, 보호된 출력 경계이며, 각 연결 계약의 부재는 그대로 남아 있다.


## 감독자 환경 복구 (2026-11-01)

- 이전 구현 Dispatch는 PyPI DNS 오류로 초기화 전 실패하고 정식 종료·release됐다. 호스트에서 pypi.org DNS 조회와 HTTPS 200, 동일 `uv run --no-cache` 렌더 명령 종료 0을 확인했다. 이는 워커 환경의 성공 증거는 아니다. 추천: 지원되는 resolve로 새 generation을 재무장하고 기존 보안 계약과 1단계부터 순서대로 수행한다. 재발하면 워커 환경의 DNS·네트워크 접근을 조사하고 근거를 남긴다. 구현과 검증은 아직 미완료다.

## 새 보안 배치 공백 (현재 generation)

읽기 전용 조사 전문은 [보안 경계 조사 보고](story-mfa-0-security-boundary-report.md)에 보존했다. native peer·전용 FD·storage 격리의 구현 경로를 제시한 보고이며 이번 티켓 전체 구현 완료나 검증 통과를 뜻하지 않는다.

계획의 감독자 결정은 같은 UID의 미승인 프로세스를 공격 범위에 포함한다. 그러나 architecture spine AD-10·18은 DB URL과 비밀을 사용자 홈 `.env`에 두고 같은 설정 접속 정보로 CLI·hook·daemon이 PostgreSQL에 직접 접근하도록 정한다. AD-27·34는 같은 shim의 사용자 daemon과 OrbStack Docker 관리 경로를 유지한다. 현재 `apps/cli/src/config/codec.ts`의 `postgresSecrets`와 `extensionAdminUrl`은 app 및 관리자 자격을 그 파일에서 공급하고, 신규 인증 evidence도 `brain_app` 쓰기 권한을 사용한다. 사용자 UID가 읽는 0600 비밀과 같은 UID의 Docker 관리 API는 그 UID의 미승인 프로세스를 구분하지 못한다. native 코드 서명만 더해 이 DB 권위 경계를 보호했다고 판정할 수 없다. 운영 `.env`나 token 본문을 읽거나 운영 DB 공격을 수행한 것은 아니다. 이 실행의 격리 Docker 생성·제거와 소스의 관리 경로를 근거로 판단했다.

재개하려면 DB·관리 소켓·관리/app/broker 자격·단일 supervisor를 보호된 OS principal로 배치하는 방식과 CLI·hook의 기존 직접 DB 접속 및 setup/업데이트 경로를 어떻게 보존·변경할지 결정해야 한다. 보호된 OrbStack 엔진을 유지할지 별도 local PostgreSQL 배치로 AD-10·34를 변경할지 현재 계약이 답하지 않는다. 이를 임의로 선택하는 것은 비밀·권한 및 운영 데이터 이전 경계를 변경하는 보안 결정이다. persistent facts의 보안 공백 HALT를 적용하며, 인증서 취득이나 관리자 설치만 남은 operator 행동 대기로 분류하지 않는다. 단순 UID 신뢰로 요구를 낮추지 않는다.

현재까지 작성한 보호·admission·공개 해제·frame·합성 시험과 native 재현 산출물은 후속 generation에서 재사용할 부분 구현이다. 실제 인증 transport·정상 library 연결·보호 principal 설치 산출물·전체 T01–T28은 미완료다. 운영 배포와 실계정 전환은 기존대로 16.9에 남는다.

## D4 공식 API 조사와 현재 검증 범위

- [사람 승인 구현 지도](story-mfa-0-presence-map.md)는 Apple 공식 문서와 공개 SDK를 대조했다. 새 생체 인증 문맥과 봉인 UI callback에 결합한 단회 challenge는 작성 가능한 후보이며 실제 OS 승인·AX·봉인·GUI session 검증 결과는 아니다. Secure Enclave 속성만으로 생체 ACL이나 키 등록의 신뢰를 증명하지 않는다.
- 조사에서 제안한 생체 전용·현재 GUI 사용자·제출별 새 승인은 확정된 감독자 결정이 아니다. 이 선택은 승인 소비 단위와 비밀 전달의 보안 경계를 정하므로 사소한 구현 가정으로 채택하지 않는다. 실제 코드·배포·검증 전 운영 경로를 열지 않는다.
- worker FD의 XPC 전달 합성 성공은 spawn 상속 계약을 충족하지 않아 수락 증거에서 제외했다. 별도 자식 FD 5 상속 부품을 작성했으며 broker·host·내구 DB 기록·UI의 전체 연결은 미완료다. D2B 실제 명령/CLI/hook/spool 이관과 D5–D7도 남아 있어 operator만의 외부 작업 대기로 분류하지 않는다.

## 새 사람 승인 보안 결정 공백

계획의 보호 배치 결정 3은 “일회성 승인”과 “사용자 승인 세탁·접근성/자동화 권한의 실제 위협” 검증을 요구하지만 승인 소비 단위를 정하지 않았다. 세션 채널 개시 1회로 credentials와 최대 3 MFA를 허용하는 정책과 각 secret 제출 직전에 새 OS 승인을 요구하는 정책은 승인 후 AX 자동 제출에 대한 경계가 다르다. 생체 전용과 OS 로그인 암호 fallback 또한 같은 보증이 아니다. [공식 API 조사](story-mfa-0-presence-map.md)의 §E.1–3은 이 차이와 가능한 구현을 기록한다. epic의 결정과 architecture spine에도 이 소비 단위와 승인 policy는 명시되어 있지 않다.

현재 `extensions/garmin/native/presence-ui.m`의 SEP 속성 검사는 정확한 생체 ACL·보호 등록·broker key pinning을 증명하지 않으며, `secure-prompt.m`의 전송 부품은 선택 이후 직접 frame을 보낸다. 실제 승인 소스·전달 신뢰는 OS-callback-only 봉인 UI assertion 또는 보호 등록된 ACL key 서명 등으로 작성할 수 있으나 어떤 보증과 소비 범위를 수락할지 명시하지 않고 운영 입력을 열 수 없다. 공개 API가 없거나 구현이 불가능하다는 판단은 아니다.

이 워크플로의 persistent facts는 보안·비밀 관련 결정 공백이면 보수적 가정으로 진행하지 않고 HALT하도록 지시한다. 제출별 생체 승인 제안은 미확정 제안으로 보존한다. 재개 조건은 승인 policy·소비 단위·broker가 신뢰할 증거 출처와 실제 AX/취소 검증 조건을 결정문에 명시하는 것이다. 이외의 D2B·D3B/D4·D5–D7 미완료 코드도 보존하며 완료로 올리지 않는다. 따라서 관리자 설치·생체 동작 같은 외부 행동만 남은 `awaiting-operator` 상황이 아니다.

## 감독자 결정 2026-11-01: 제출별 승인과 재개

<intent-contract>
1. 일회성 승인은 채널 attach가 아니라 credentials 최초 제출 1회 및 동일 client의 각 MFA 제출(최대 3회)에 각각 소비한다. 대상·prompt·응답을 고정한 뒤 제출 직전에 현재 active GUI 사용자의 새 LAContext 생체 전용 평가를 수행한다. 암호·Watch·관리자 대리·캐시·버튼·일반 이벤트 fallback은 없다. 미지원·오류는 실패 닫힘이다.
2. 보호 설치된 UI의 OS callback 성공 경로에서만 생성되는 앱 assertion을 신뢰한다. OS의 독립적 transaction attestation이라 부르지 않는다. 보호된 실행물·주입 방지와 OS peer 및 supervisor가 기록한 GUI 실행 인스턴스가 전제다. broker 생성 무작위 단회 challenge를 policy·GUI session·instance·connection·prompt·동결 response generation·work/attempt/launch/package/binding과 결합하고, broker가 현재 상태·만료·취소를 재검사해 원자 소비한다. worker는 정확한 제출 capability 확인 전 비밀 frame을 수락하지 않는다. 비밀은 전용 FD 밖으로 보내지 않는다.
3. 입력 변경·취소·hold·lock·sleep·사용자 전환·연결 상실·세대 변경은 기존 승인을 폐기한다. 중복 callback·재전송·재시작·불명 결과는 자동 재사용하지 않는다. SEP 서명은 정확한 생체 ACL, 보호 등록 및 broker key/policy pinning 입증 전 비활성이다. 생체 일치가 사용자 의도나 물리 입력을 증명한다고 주장하지 않는다.
4. 기존 T01–T28과 [독립 정적 검증의 반례 및 추가 행렬](story-mfa-0-supervisor-security-review.md)을 모두 보존한다. 실제 봉인·동일 UID/AX·생체·취소·FD/프로세스 복구·권위 DB·egress 격리와 전체 검증이 입증되기 전 운영 auth/HTTP는 닫힌다. 합성 검증은 실기 증거가 아니다.
</intent-contract>

재개: 원래 기준 `885ad522`부터 전체 diff와 기존 리뷰를 유지한다. 부분 구현은 미검증 WIP `72b1fec`에 보존되었으며 타입 검사 오류 두 건도 남았다. 먼저 해당 타입 오류와 phase/credentials 예산을 고치고, 제출별 callback·broker 소비·worker gate, FD 상속/DB ACK, D2B 보호 경계, D5 egress를 각각 구현·검증·checkpoint한다. D6 전체 T01–T28과 위 추가 반례, 독립 리뷰 및 D7을 생략하지 않는다. 단계별 phase-ready로 같은 구현자를 이어가며 capacity 오류는 같은 모델·세션으로 재개한다. 기존 production fail-closed를 검증 전 제거하지 않는다. 이 결정은 완료 증거가 아니다.

## 감독자 재개 2026-11-01: g4 시간 초과 인계

지휘자 90분 시간 초과 후 기존 구현자는 관리상 failed 인계 보고를 제출하고 release·ACK됐다. [전체 보고](story-mfa-0-g4-implementation.md)와 g4 조사 세 문서를 보존한다. 원래 기준은 `885ad522`, 이번 generation 기준은 `1d4fec9`이며 전체 원래 diff 및 기존 보안 계약을 유지한다. 이 인계는 구현 실패 횟수가 아니며 WIP는 완료 증거가 아니다.

재개 순서: (1) D4B 제품 단일 supervisor 조립과 ABI 연결을 작은 단계로 검증, (2) 활성 cancel/hold/disable의 broker 폐기·다중 attempt·복구, (3) leader 종료 후 안전한 그룹 정리와 별도 principal 검증, (4) D2B B1–B6, (5) D5 egress/library, (6) D6 T01–T28·추가 반례·독립 보안 리뷰, (7) D7. 각 단계 phase-ready·checkpoint 후 이어간다. 마지막 Core hook과 DB EXECUTE 검증 추가 뒤 관련 테스트, split denied 및 보호 migration generic/race/revoke 전부 재실행한다. 합성 성공을 실제 봉인·OS 생체·AX·운영 격리 증거로 취급하지 않고 검증 전 운영 auth/HTTP를 닫는다. capacity는 같은 모델·세션으로 재개한다.

### 2026-11-01 g5 시간 초과 후 재개 인계

- 지휘자 90분 시간 초과 후 기존 구현자의 정식 관리상 인계 보고 `story-mfa-0-g5-implementation.md`를 수락하고 Dispatch를 release·ack했다. 이는 기술적 실패가 아니며 구현은 미완료다. 원래 전체 기준 `885ad522`, 직전 엔진 기준 `8e396997`과 전체 diff·이전 보안 계약을 유지한다.
- g5는 D4B와 D2B 합성 경로 및 봉인 bundle 부품을 보존했다. 보고의 합성 테스트·build·typecheck는 실제 root 설치나 Node/JS 실행 신원의 증거가 아니다. 운영 queue/auth/HTTP는 실패 닫힘을 유지한다.
- 다음 실행은 B2를 더 작게 나눈다: (1) root 소유 registry와 전체 Node/CLI/loader closure 및 서명·소유권 검증의 고정 입력과 부정 시험, (2) 정확한 실행 인스턴스의 OS peer 연결과 주입·대리 호출·재연결 거부, (3) 실제 보호 서비스 principal 및 운영 transport 조립과 실패 닫힘 검증. 각 단계마다 phase-ready와 검증 근거를 checkpoint한다. 이후 B3–B6, D5–D7, T01–T28 전체 검증과 원래 기준 전체 diff의 독립 보안 리뷰를 수행한다. 단계 완료를 티켓 완료로 취급하지 않는다.
- 프레임·경로·bundle 크기 상한 가정은 실제 배포 구성에 맞춰 검증하고 계약을 줄이지 않는다. 관리자 권한이 필요한 실기 검증은 합성 결과와 구분해 기록하고 가능한 자동 실행 경로를 먼저 조사한다.
