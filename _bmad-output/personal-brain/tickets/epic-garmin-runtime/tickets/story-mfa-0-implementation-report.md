# 16.2 구현 워커 최종 보고 — 실패 / 보안 결정 공백

## 결과와 중단 이유

전체 계획은 미완료다. 감독자의 2026-11-01 finalize 지시에 따라 기능 확장을 중단하고 현재 변경을 검증·보존했다. 같은 UID의 미승인 프로세스까지 포함하는 위협 범위와, 사용자 소유 `.env`에 있는 DB admin/`brain_app` 자격 및 사용자가 관리하는 OrbStack 사이의 신뢰 경계가 결정되지 않았다. 보호된 DB·daemon principal, 인증 UI/broker/worker와 tokenstore의 권한 분리, 기존 CLI의 직접 DB 접속을 어떻게 바꿀지는 명세에 없는 보안 배치 결정이다. 인증서 하나를 제공하거나 일반 사용자 파일 권한을 조정하는 것만으로 해결된다고 판단하지 않는다.

현재 정상 Garmin 인증·수집 및 실제 HTTP 경로는 열지 않았다. `brain ext auth <name>`과 Garmin auth worker는 검증된 capability가 없을 때 입력 전에 `AUTH_PEER_UNVERIFIED`로 실패하고, 기존 수집 기본 client는 `UnavailableClient`다. 이는 실패 닫힘이며 정상 인증 수락 기준을 만족했다는 뜻이 아니다. 사용자 판단이 필요한 보안 배치 결정과 별개로 아래에 명시한 코드·통합·검증도 여전히 미완료다.

## 구현한 부분

- `extensions/garmin/migrations/0007_account_protection.sql`, `extensions/garmin/src/protection.py`: 독립 auth/rate/manual/uncertain 보호, pending intent, 날짜별 probe 예약, first-call 예산, 계정 binding과 tokenstore identity, supervisor admission, 인증 성공 evidence 및 수동 해제 감사 기록을 추가했다. pending은 날짜·TTL·종료만으로 해소하지 않는다. `start_external_call`/`finish_external_call`은 현재 admission·attempt·세대 및 supervisor가 저장한 시간대를 다시 검사하고 DB clock을 사용한다. 확장 역할의 보호 테이블 직접 변경은 revoke했다.
- `extensions/garmin/src/tokenstore_check.py`: 디렉터리 FD와 `O_NOFOLLOW`로 경로 조상 및 0700/0600, 소유자, device/inode를 관찰한다. `register_target_identity`는 같은 identity의 alias 보호를 보존하고 inode 교체를 거부한다. `bind_admitted_profile`은 auth holder·세대를 검증하고 canonical 보호·identity·intent·alias·holder를 한 transaction에서 합친다. 이 관찰과 binding 등록은 아직 실제 supervisor 예약 경로에 연결되지 않았다.
- `extensions/garmin/src/http_guard.py`, `http_intercept.py`: 합성 요청에서 intent commit 후 전송, 결과 실패 시 pending 유지, requests/curl 동기 지점 실험 계측 및 내부 retry·curl 자동 redirect 거부, 단조 clock 간격을 구현했다. 의미 검증 없는 2xx는 성공이 아니라 `other`다. 모든 네트워크 경로를 OS 차원에서 봉쇄하거나 이 경계를 배송 worker에 연결하지 않았다.
- `extensions/garmin/src/auth_flow.py`, `auth_wire.py`, `apps/cli/src/runtime/auth-wire.ts`: 합성 동일 객체 MFA 최대 3회, 고정 오류·Python 출력 폐기, 길이/방향/HMAC/순서/prompt 및 재전송을 검사하는 Node/Python frame codec을 구현했다. 실제 비밀 FD·bootstrap·승인 UI와 연결되지 않았고 Python 출력 폐기만으로 native/raw FD 누출을 막을 수 없다. 실제 library의 MFA 오답을 안전하게 분류하는 adapter도 없다.
- `packages/core/src/extensions/manifest.ts`, `packages/core/src/queue/supervisor.ts`, `packages/core/src/ports/store.ts`, `packages/postgres/src/work.ts`, `apps/cli/src/daemon/supervisor.ts`: 확장별 opaque admission을 spawn 전에 기록하도록 연결하고 busy 충돌은 attempt 횟수를 되돌린 채 30초 뒤 대기한다. 성공 결과와 process group 종료가 확인되고 pending이 없을 때만 정상 경로에서 holder 정리를 시도한다. 실패·unknown은 보수적으로 남는다. canonical profile의 기존 alias를 선택해 snapshot의 tokenstore 경로를 바꿀 수 있지만 현재 실제 경로/inode 재검증을 거치지 않는다.
- `packages/postgres/src/extension-provision.ts`: 재provision이 확장 schema 객체에 일괄 GRANT하여 migration의 개별 REVOKE를 무효화하는 결함을 수정했다. 역할 삭제 후 재생성 시 기존에 허용되던 객체 권한까지 자동 복원하지 않으므로 명시 복구 계약이 필요하다.
- `extensions/garmin/src/release_block.py`, manifest, `packages/postgres/src/extensions.ts`, `packages/core/src/doctor/doctor.ts`, `apps/cli/src/commands/ext-status.ts`: 수동 대상 지정 release-block은 현재 attempt·대상·취소/hold·비예약을 확인한 후 rate/manual만 해제하고 감사를 기록한다. 익명 boolean projection으로 상태와 doctor의 조치 필요를 노출한다. `apps/cli/src/commands/ext-auth.ts`, `packages/core/src/brain.ts`, `packages/core/src/codes.ts`, `README.md`는 아직 닫힌 명시적 auth 진입점과 고정 오류를 제공한다.
- `extensions/garmin/pyproject.toml`, `extensions/garmin/uv.lock`: `garminconnect==0.3.20`, `curl-cffi==0.17.0`을 직접 고정했다.

## 실제 검증과 한계

- `pnpm build`, `pnpm typecheck` 성공. `PYTHONDONTWRITEBYTECODE=1 UV_CACHE_DIR=/tmp/brain-uv-cache uv sync --project extensions/garmin --frozen` 성공. Python 3.14.10 arm64에서 psycopg, garminconnect, curl_cffi import를 확인했다.
- `extensions/garmin/tests/check_auth_flow.py`, `check_auth_wire.py`, `check_http_guard.py`, `check_tokenstore.py`, `check_tokenstore_race.py`, `check_collect.py` 각각 성공. 합성 library MFA fallback 및 refresh gate, probe 한 HTTP 실험, 미검증 200 거부, 동일 객체 MFA 상한과 frame 상호운용을 확인했다. 실제 library 전체 요청 그래프를 안전하게 계측했다는 증거는 아니다.
- 임시 PostgreSQL 18 컨테이너에서 `PYTHONDONTWRITEBYTECODE=1 UV_CACHE_DIR=/tmp/brain-uv-cache uv run --project extensions/garmin --frozen python extensions/garmin/tests/check_protection.py <격리 포트>` 성공. 가짜 clock, 독립 latch, canonical alias, probe 예약, first-call, commit 응답 유실과 pending 보존을 검사했다. 현재 시험은 안전을 위해 격리 포트 인자가 필수이므로 계획에 적힌 인자 없는 명령은 그대로 성공하지 않는다.
- `pnpm exec vitest run packages/core/test/extensions.test.ts packages/core/test/supervisor.test.ts packages/postgres/test/work-store.test.ts packages/postgres/test/extension-permissions.test.ts apps/cli/test/ext-install-resume.test.ts`: 5개 파일 290개 통과. 실제 `provisionExtension → Garmin runMigrations → 재provision` 및 실제 core attempt/확장 DB 역할, 직접 보호 UPDATE 거부, 시간대 불일치 거부, auth evidence 및 같은 계정의 합성 child 직렬화를 검사했다. `packages/postgres/test/unavailable.test.ts`와 권한 시험 별도 실행은 17개 통과했다.
- `pnpm exec vitest run --config apps/cli/python-test/vitest.config.ts apps/cli/python-test/garmin-protection.test.ts apps/cli/python-test/garmin-collect.test.ts apps/cli/python-test/garmin-tracer.test.ts apps/cli/python-test/garmin-admission.test.ts apps/cli/python-test/garmin-release.test.ts apps/cli/python-test/garmin-auth-wire.test.ts`: 최종 묶음에서 5개 파일 14개가 통과하고 합성 collect fixture의 동반 clock 선언 누락으로 한 파일이 실패했다. 누락을 고친 뒤 `garmin-collect.test.ts` 단독 재실행은 통과했다. 그 수정 뒤 전체 묶음은 반복하지 않았다. 이전에 같은 tracer 파일 6개, protection 파일 5개, admission/release 각각이 통과했다. 수집·반입 fixture는 격리 DB의 auth 성공을 합성 정산하므로 실제 인증 성공 증거가 아니다.
- 실제 감독자 Python worker PID를 DB attempt PID와 대조한 뒤 intent commit 직후 및 합성 429 commit 직후 SIGKILL하고 daemon을 재시작했다. 추가로 worker의 선행 DB 함수 EXECUTE 및 결과 DB 함수 EXECUTE를 각각 거부했다. 네 사례에서 holder/pending 및 합성 호출 누계가 보존됐고 재시작 후 추가 호출이 없었다. 앞선 순수 PG 시험은 INSERT/UPDATE trigger 거부 및 commit 응답 유실도 주입했다.
- `extensions/garmin/tests/native/check-native.sh`는 샌드박스 밖 macOS에서 합성 자식 audit token의 PID 및 고정 cdhash 허용/다른 코드 거부, 동일 프로세스 익명 XPC 양쪽 code-signing 요구 일치/불일치를 확인했다. 서로 다른 프로세스의 XPC 인증·승인 UI·보호 배포 증거는 아니다. 샌드박스 안 익명 XPC는 연결 중단이었다.
- 실제 library를 임시 합성 tokenstore에 사용한 `check_tokenstore_race.py`에서 identity 확인 뒤 디렉터리를 교체하면 library `dump`가 교체된 디렉터리에 썼다. 현재 macOS에서 열린 디렉터리의 `/dev/fd/<n>/child` 경로로 자식 파일 쓰기도 실패했다. 이 반례 때문에 검사 뒤 재검사만으로 token 노출을 방지한다고 주장하지 않는다.
- CLI `brain doctor run`은 격리 fixture의 컨테이너 선행 점검 실패로 extensions 검사를 skip했다. 대신 동일 실제 PG store를 직접 사용하는 core `runDoctor`가 수동 조치 필요 경고를 냈고, 격리 daemon의 release 후 auth/uncertain 보존과 rate/manual 해제를 확인했다.

## 명시적 미완료 및 검토 필요

1. 같은 UID 위협에 맞는 DB/daemon principal, 관리자·app 자격 보호, 승인 UI/broker/worker 코드와 tokenstore storage 배치, CLI 직접 접속 계약의 보안 결정과 그 구현이 없다. `brain_app`이 쓸 수 있는 `auth_success_evidence`나 admission을 현재 같은 UID 공격자에게서 보호된 증거로 취급하면 안 된다. native spike는 제품 보안 경계가 아니다.
2. 실제 operator UI, 양방향 OS peer 검증, spawn identity 기록 후 bootstrap ACK, 전용 FD 전달·timeout·취소·session 폐기, 실제 Garmin login/dump와 동일 client MFA adapter가 없다. `auth_flow.py`의 합성 `MfaRejected`는 실제 library 오류 분류가 아니다. 비밀 누출 T01–T10 전체와 실제 raw/native FD 출력 차단은 미검증이다.
3. 모든 내부 HTTP, retry/refresh/redirect, 실제 probe 한 건 및 pacing/endpoint 의미 검증은 배송 worker에 연결되지 않았다. `http_intercept.py`는 동기 requests/curl의 실험 seam이고 우회 불가능한 OS 네트워크 broker가 아니다. 인증 성공 evidence의 실제 신뢰된 생성도 없다.
4. supervisor의 실제 예약에서 tokenstore path/device/inode를 재검증하지 않으며 최초 binding 등록도 연결하지 않았다. `register_target_identity`, `create_target`, 이전 `bind_profile`의 직접 쓰기 경로는 이제 확장 role에 revoke되어 실제 worker에서 사용할 수 없고, 신뢰된 supervisor/broker 경로로 이관해야 한다. 경로 교체 TOCTOU, protected storage 및 실제 사용 중 identity 변경을 해결해야 한다.
5. auth/collect/예약/수동/force의 모든 생성 경로에 epic 12 canonical serialization key와 binding generation을 공급하는 resolver는 없다. 명시 키가 있는 새 확장 enqueue가 기존 null/다른 키 행과 병합되는 경우는 거절하지만 현재 모든 경로가 명시 키를 공급하는 것은 아니다. 기존 null-key work 복구 계약도 남았다.
6. 성공한 worker의 정상 종료 후 holder를 정리하지만 실패·미확정 holder의 재시작 후 검증된 종료 및 복구 정책은 미구현이다. 임의 TTL·날짜로 해제해서는 안 된다. first-call 403을 수동 보호로 처리한 것은 보수적 구현 선택으로 제품 정책 확인이 필요하다.
7. T01–T28 전체, 실운영 전제 OS peer spoof·동일 UID 공격·secret canary의 모든 저장/출력 경로·실제 HTTP 계측, 예약/force 전체 행렬, 전체 코드 리뷰와 그 수정은 끝나지 않았다. 독립 코드 리뷰를 실행했다고 주장하지 않는다.

## 변경 파일과 작업 소유권

변경은 `README.md`, `apps/cli/src/commands/ext-auth.ts`, `ext-status.ts`, `apps/cli/src/commands/index.ts`, `apps/cli/src/daemon/supervisor.ts`, `apps/cli/src/runtime/auth-wire.ts`, `apps/cli/test/auth-wire.test.ts`, `apps/cli/python-test/garmin-{admission,auth-wire,collect,protection,release,tracer}.test.ts`, `extensions/garmin/manifest.json`, `pyproject.toml`, `uv.lock`, `migrations/0007_account_protection.sql`, `src/{auth,auth_flow,auth_wire,http_guard,http_intercept,protection,release_block,tokenstore_check}.py`, `tests/{auth_wire_peer,check_auth_flow,check_auth_wire,check_http_guard,check_protection,check_tokenstore,check_tokenstore_race,protection_fixture}.py`, `tests/native/`, `packages/core/src/{brain,codes}.ts`, `extensions/{install,manifest}.ts`, `doctor/doctor.ts`, `ports/store.ts`, `queue/supervisor.ts`, `testing/fakes/store.ts`, `packages/core/test/{codes,supervisor}.test.ts`, `packages/postgres/src/{extension-provision,extensions,work}.ts`, `packages/postgres/test/{extension-permissions,unavailable}.test.ts`, `_bmad-output/personal-brain/tickets/epic-garmin-runtime/tickets/story-mfa-0-phase1-report.md`에 있다. 중간 보고는 `/tmp/brain-mfa-phase2-report.md`, `/tmp/brain-mfa-phase3-report.md`다.

시작 시 이미 변경돼 있던 `story-mfa-0-plan.md`는 수정하지 않았다. 계획·티켓 상태 변경, `tickets.py mark`, commit, push, 실제 Garmin 계정·운영 tokenstore·Garmin 네트워크 사용, 추가 워커 사용은 하지 않았다. 임시 PostgreSQL 컨테이너와 합성 fixture를 정리했다.

## 지휘자의 최종 추가 검증

마지막 합성 collect fixture 수정 뒤 지휘자가 위 Garmin 여섯 파일 묶음을 다시 실행해 6개 파일 15개 시험 모두 통과를 확인했다. 로그는 `/tmp/brain16-g2-final-cli-tests.log`다. 지휘자의 최종 build·typecheck와 frozen install/import도 성공했다. 이 추가 검증은 정상 인증 및 전체 보안 수락의 미완료 판정을 바꾸지 않는다.
