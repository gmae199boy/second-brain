# 16.2 native 보안 경계: 구현을 재개하기 위한 전문 자문

작성일: 2026-11-01. 읽기 전용 조사이며 소스·계획·티켓 변경, 빌드·시험·실계정 호출·운영 tokenstore 열람·배포·추가 워커 실행을 하지 않았다. 유일한 작성 산출물은 이 보고서다. 아래 파일 중 ‘신규 제안’은 아직 존재하거나 구현되었다는 뜻이 아니다. 기존 시험 결과는 `/tmp/brain-mfa-phase2-report.md`, `/tmp/brain-mfa-phase3-report.md`의 보고된 결과이며 이번 조사에서 재실행하지 않았다.

## 1. 결론과 바로 진행할 작업

최소 경로는 **명시 승인용 native UI + 보호된 기존 supervisor + 검증 가능한 고정 native worker launcher + 별도 OS principal의 library/tokenstore + 요청마다 선행 intent를 확정하는 실제 전송 broker**다. 기존 epic 13의 work/attempt 감독과 Garmin 보호 모델을 재사용한다. UI가 Garmin worker를 독립 실행하거나 두 번째 supervisor를 만드는 방식은 택하지 않는다.

인증서나 관리자 승인 부재는 이 코드 전부를 쓰지 못하는 이유가 아니다. 먼저 실행 가능한 UI/broker/launcher, 설치 staging renderer, 고정 package manifest 검증, 서로 다른 프로세스 IPC, fake library·HTTP·PG 연결을 작성할 수 있다. 그 뒤에만 사람이 실제 서명 신원 제공, 서비스 계정·보호 경로·DB 관리 경계 설치, OS 승인, 운영 이전을 수행한다. 이 마지막 작업은 계획대로 16.9에 둔다. 사용자 자격의 0700 파일과 ad-hoc 서명 실험을 보호 배포 완료로 계산하지 않는다.

가장 먼저 구현할 것은 password 화면보다 **권한 배치 manifest와 DB 접근 경계**다. 같은 UID가 `.env`나 Docker API를 통해 DB 관리자 권한을 획득할 수 있다면 signed UI와 tokenstore 격리를 추가해도 보호 상태·admission·인증 성공 evidence를 신뢰할 수 없다. 현재 OrbStack 배치에서 이 경계를 유지할 수 있는지 검증하고, 불가능하면 protected DB 배치 선택을 지휘자가 명시해야 한다. 그 결정과 무관하게 아래 native 실행물·fake 경로는 만들 수 있다.

## 2. 확인한 근거와 재사용할 것

전체 명세 `_bmad-output/personal-brain/tickets/epic-garmin-runtime/tickets/story-mfa-0-plan.md` 1–333행을 읽었다. 감독자 결정 1–6(53–58행)이 뒤의 과거 독립 조사에 남은 ‘미결정’ 문장보다 최신 결정이다. 과거 조사에 있는 ‘가정하면 안 된다’를 새로운 재승인 요구로 반복해서는 안 된다.

| 근거 | 이번에 확인한 코드 사실 | 다음 구현에서 재사용/보완 |
|---|---|---|
| `extensions/garmin/tests/native/peer-parent.c`, `peer-child.c`, `check-native.sh` | 상속 socketpair의 `LOCAL_PEERTOKEN`, audit token으로 `SecCodeCopyGuestWithAttributes(kSecGuestAttributeAudit)`, `SecRequirementCreateWithString`, `SecCodeCheckValidity`를 사용한다. 다른 LABEL 실행물의 cdhash 거부를 검사한다. | 이 조합을 실제 child 신원 등록과 연결한다. 단순 signing information 조회와 validity 통과를 구분한다. PID 일치도 스크립트 assertion에 추가한다. |
| `extensions/garmin/tests/native/xpc-spike.c` 및 `README.md:5` | 익명 listener와 client가 **동일 프로세스**다. 양쪽 connection에 requirement를 설정하고 응답 여부를 검사한다. | 세 개 이상 실제 실행물의 UI↔broker, launcher↔broker 검증으로 확장한다. API 설정 0과 승인 세션 증명을 구분한다. |
| `extensions/garmin/src/auth.py` | client 생성 없이 `AUTH_PEER_UNVERIFIED`와 종료 1. | provision/peer/bootstrap 증명이 없는 경우 이 분기를 유지한다. 구현 준비 뒤 일반 성공으로 바꾸지 않는다. |
| `extensions/garmin/src/auth_flow.py` | 같은 client의 login/resume/dump와 MFA 최대 3회, 고정 오류; Python stdout/stderr/logging 억제. | native fd 격리와 실제 library adapter를 결합한다. `os.write(1, ...)`, C 출력·후손 출력까지 현재 `_quiet_library`로 막았다고 하지 않는다. |
| `apps/cli/src/runtime/auth-wire.ts`, `extensions/garmin/src/auth_wire.py` | 상한 16 KiB, payload 4096, version/session/prompt/방향 HMAC/seq 및 response 재사용 검증 codec. | bootstrap·stream reassembly·partial read·FD 수명·실제 tuple 검증이 필요하다. 현재 방향은 `ui`/`worker` 두 개뿐이므로 broker bootstrap/HTTP RPC에 같은 key와 namespace를 재사용하지 않는다. |
| `packages/core/src/ports/process.ts`, `apps/cli/src/runtime/process-group.ts` | `ProcessSpec`은 command/args/env, 실제 spawn은 stdin ignore와 stdout/stderr pipe. auth FD port는 없다. | typed capability 및 native launcher adapter를 추가한다. 임의 숫자 FD/임의 executable 실행 RPC로 만들지 않는다. |
| `apps/cli/src/daemon/supervisor.ts:48–58,93–98` | spawn 전 admission callback을 사용하고, 사용자 extension 디렉터리의 `.venv` Python+entry를 실행하며 extension DB URL을 env로 준다. | admission 흐름은 유지하되 Garmin auth/collect의 privileged package resolution과 launcher만 교체한다. 현재 사용자 수정 가능한 manifest/venv를 privileged 허용 목록으로 쓰면 안 된다. |
| `extensions/garmin/src/tokenstore_check.py` | 각 경로 성분을 `O_DIRECTORY|O_NOFOLLOW`로 열고 최종 디렉터리/직접 파일 owner=현재 UID, 0700/0600 검사. 내용은 읽지 않는다. 검사 후 FD를 닫는다. | worker principal에서 검사해야 한다. FD 보유부터 library 사용 완료까지 동일 inode를 고정해야 한다. 지금 코드에 체크만 추가하면 TOCTOU가 남는다. |
| `extensions/garmin/src/http_guard.py`, `http_intercept.py` | per-send begin→transmit→finish seam. requests adapter와 curl-cffi 동기 request 후크, retry 거부. 원래 Python/C 전송 함수를 호출한다. | 원래 send를 호출하는 후크를 broker RPC 전송으로 교체하고 직접 egress를 막는다. endpoint 의미 검증 없는 200은 현재 `other`다. |
| `extensions/garmin/migrations/0007_account_protection.sql:246–274` | evidence는 extension role에 비공개지만 `brain_app`에는 SELECT/INSERT/DELETE. 완료 함수는 current admission, profile/generation, 성공 intent, pending 부재를 검사한다. | evidence를 만드는 OS 주체와 그 DB 자격을 격리해야 한다. SQL 제약 자체는 재사용하되 보호된 broker 전용 권한으로 좁힌다. |

이전 보고의 실제 supervisor 선행 admission, crash/저장 실패 후 무호출, canonical gate 동시성, binding 원자 이전과 latch 보존은 유용한 기반이다. 이를 native 경계 때문에 전부 재작성할 필요는 없다. 다만 실제 실행물·실제 전송·보호된 DB 자격과 연결한 합성 통합 증거가 추가되어야 한다.

## 3. 권장 권한 배치와 실행물

### 3.1 최소 역할

1. **operator UI**는 로그인 사용자 GUI 세션에서 실행하는 고정 native 앱이다. password/MFA 모두 `NSSecureTextField`, extension/package/대상 work/세대의 비밀 없는 요약, 사용자의 세션 선택과 승인 버튼을 제공한다. URL 열기나 CLI 호출만으로 승인하거나 입력을 요청하지 않는다. 일반 터미널·agent chat·환경변수 입력 fallback은 없다.
2. **broker와 기존 supervisor**는 전용 비로그인 서비스 계정(예: `_brain_runtime`)에서 동작한다. 프로그램 설치물은 root 소유·사용자 쓰기 불가다. 기존 `runSupervisor`가 claim/admission/spawn/정산/종료를 계속 소유한다. native broker는 검증·채널·전송 capability를 제공할 뿐 일감을 claim하지 않는다. 가장 적은 변경은 기존 supervisor를 이 보호 서비스 배치 안에서 한 번만 실행하는 것이다.
3. **library worker**도 로그인 사용자와 다른 보호 principal에서 실행한다. 고정 native launcher 안에 CPython을 embed하고 검증된 package만 로드하는 형태가 가장 명료하다. `/usr/bin/python` 또는 일반 Python/Node의 서명만으로 package 코드를 승인하지 않는다. helper는 고정 entry와 정해진 auth/collect operation만 허용한다.
4. **DB 관리자·owner 자격**은 설치/이전 전용 별도 권한으로 둔다. runtime broker도 superuser가 될 필요가 없다. broker의 auth evidence/intent 권한, supervisor의 admission 권한, worker의 최소 publish 권한을 구분한다. protected supervisor까지 침해된 상황을 보장한다고 쓰지는 않되, 로그인 사용자 프로세스가 그 자격을 읽거나 쓸 수 없어야 한다.

서비스 계정 하나와 root 소유 설치물은 로그인 UID 공격을 막는 최소 분리다. broker와 worker 사이에서도 악성 확장 코드를 방어하려면 별도 worker UID가 추가로 필요하다. 최소안에서는 고정·검증된 Garmin package와 의존 전체를 신뢰 코드로 한정하며 다른 임의 확장을 같은 credential-rich principal에서 실행하지 않는다. 공용 확장 실행을 모두 privileged로 올리는 것은 허용되지 않는다. protected supervisor의 다른 extension launcher는 원래 비특권 principal로 내리거나 별도 제한 principal을 사용한다.

### 3.2 설치 manifest에 반드시 들어갈 산출물

다음은 구현자가 작성할 **신규 제안 파일**이다. 디렉터리명은 변경 가능하지만 내용과 책임은 생략하면 안 된다.

| 신규 파일/산출물 | 구체적 내용 |
|---|---|
| `apps/native-auth/Package.swift`, `Sources/AuthUI/` | AppKit 승인 UI, secure fields, 요청 선택, peer 검증 후 채널 생성, 취소/timeout. SwiftUI보다 필요한 AppKit 제어부터 구현 가능. |
| `apps/native-auth/Sources/AuthBroker/` | native peer policy, bootstrap state machine, verified tuple registry, TTL/취소, FD 전달, 고정 메시지 allowlist. 임의 파일 읽기·명령 실행 메서드 금지. |
| `apps/native-auth/Sources/WorkerHost/` | 고정 CPython embedding, isolated `PyConfig`, manifest 검증, FD whitelist, ACK 대기, constructor/import I/O 차단, 제한된 작업 실행. |
| `apps/native-auth/Sources/PeerIdentity/` | audit token→SecCode 검증, 기대 UID/로그인 session 및 실제 child identity 일치, requirement parse/error 시 deny. |
| `apps/native-auth/Sources/HTTPBroker/` | 실제 HTTP 단일 전송, intent/결과 commit 순서, monotonic pacing, 자동 redirect/retry/refresh 차단, endpoint/host/method allowlist. |
| `apps/native-auth/Resources/*.entitlements`, `CodeRequirements.plist` | target별 최소 entitlement와 UI/broker/worker 별도 signing identifier. 허용 package digest·policy generation. `get-task-allow`, DYLD injection 허용, 불필요한 library-validation 예외 금지. |
| `scripts/native-auth/package-runtime.*` | Python stdlib·site-packages·native `.so`/`.dylib`·CA 등 의존을 고정 manifest로 봉인; 의존→helper→앱 순 서명; stage 산출물 검사. 실행 중 uv/pip 또는 사용자 PATH로 설치하지 않는다. |
| `scripts/native-auth/render-install.*`, `install.*`, `uninstall.*` | staging prefix 지원, uid/gid 충돌 거부, root-owned 실행 경로, 서비스-owned state 경로, launchd plist, credential 전달, rollback/진단. uninstall은 tokenstore/미확정 보호를 자동 삭제하지 않는다. |
| `apps/native-auth/Resources/LaunchDaemons/*.plist` | label, 고정 ProgramArguments, UserName/GroupName, WorkingDirectory, MachServices, Umask(077), 비밀 없는 로그 경로. shell·사용자 node shim·임의 env 해석 금지. |
| `apps/cli/src/runtime/native-auth-launcher.ts`, `packages/core/src/ports/auth-channel.ts` | typed auth capability, native launch receipt, child PID/PGID/start/boot identity와 async exit, cancel/close 기능. |
| `extensions/garmin/src/native_transport.py`, `library_adapter.py` | 실제 locked library와 native broker RPC의 연결. `auth_flow.py`를 승인된 채널에서만 호출. |
| `extensions/garmin/migrations/0008_native_principals.sql`(번호는 작업 시 확인) | 보호 테이블 직접 변경 권한 축소, broker/supervisor 함수 권한, 고정 search_path/owner, 신규 객체 기본 권한 보완. 적용된 0007을 고쳐 운영 migration을 우회하지 않는다. |
| `extensions/garmin/tests/native/check-boundary.*`, `apps/cli/python-test/garmin-native-auth.test.ts` | 아래 합성 검증 runner, fake UI/worker/HTTP/PG, timeout와 정리, 실패 이유의 고정 출력. |

실제 배포 위치는 예를 들어 root 소유 `/Library/PrivilegedHelperTools/`와 `/Library/LaunchDaemons/`, 서비스 전용 state `/Library/Application Support/SecondBrain/`다. 앱은 관리자만 교체 가능한 설치 위치와 owner/부모 경로를 확인한다. 사용자가 수정 가능한 repo checkout·venv·shim·사용자 LaunchAgents를 그대로 privileged 서비스에 참조시키지 않는다. root는 설치에만 필요하고 네트워크·Garmin library를 root로 실행하지 않는다.

설치 코드는 기본 dry-run/stage에서 소유자·mode·plist·서명 policy·필수 권한을 검사하고, 실제 적용 모드에서는 root가 아니면 고정 `PROVISIONING_REQUIRED`로 종료하도록 만든다. fake mode가 production listener에 켜지는 환경변수 스위치는 만들지 않는다. fake 실행물은 별도 build target/별도 label/별도 DB다.

## 4. OS API와 채널을 실제로 연결하는 방법

### 4.1 IPC와 신원

Mach service 이름은 discovery이지 capability가 아니다. `xpc_connection_create_mach_service`와 활성화 이전 `xpc_connection_set_peer_code_signing_requirement`를 사용하고, UI와 broker 모두 상대 역할별 requirement를 적용한다. local SDK의 `usr/include/xpc/connection.h`는 이 API의 macOS 12+ availability, 문자열 parse 실패, 수신 메시지별 검사 및 reply의 peer requirement 오류를 설명한다. 이 서비스의 macOS 최소 버전은 installer/preflight에서 강제한다.

UI/broker는 서로 다른 identifier를 요구한다. 제품 배포 정책은 정확한 identifier+승인된 인증서/Team ID+추가 package generation을 사용하며 ‘우리 Team이면 전부 허용’으로 만들지 않는다. development는 root 소유 policy에 정확한 cdhash를 pin할 수 있다. 이때도 사용자 쓰기 가능한 allowlist에 자기 해시를 등록하게 해서는 안 된다. ad-hoc pin은 코드 구분용 fixture 또는 명시된 로컬 배포 정책이며 인증서/업데이트 신뢰와 동등하지 않다. 구버전의 유효한 서명도 session package digest가 다르면 거부한다.

worker 상속 socketpair는 기존 spike의 `LOCAL_PEERTOKEN`→audit token→`SecCodeCheckValidity`를 재사용할 수 있다. audit token의 UID/PID만 저장하지 말고 kernel이 제공한 신원 전체와 관찰된 start/boot/PGID를 launch receipt에 묶는다. child가 쓴 PID나 실행 경로 문자열은 신원 증거가 아니다. fork 이전 peer cache 등의 애매함을 제거하기 위해 실제 exec 완료 후 HELLO를 받은 지점에서 token과 child를 대조하는 별도 프로세스 시험을 필수로 둔다.

`posix_spawn` file actions 또는 고정 native host의 exec 준비에서 허용 FD만 남긴다. `socketpair`, `fcntl(FD_CLOEXEC)`와 명시 dup/close를 사용하고 PGID·exit 상태는 core process port로 돌려준다. control session을 취소할 때 capability를 폐기하고 FD를 닫으며, child와 후손 그룹 종료를 확인한 뒤에만 다음 attempt를 허용한다. EOF는 그룹 종료 증거가 아니다.

### 4.2 ‘비밀은 전용 상속 FD’ 계약 보존

XPC dictionary payload에 password/MFA를 넣지 않는 것이 현재 문구에 가장 충실하다. XPC는 peer 인증·비밀 없는 tuple·제한된 FD 전달에만 사용한다. 실제 비밀은 미리 마련한 socketpair/pipe로 보낸다. XPC FD transfer는 OS가 fd를 복제하므로 엄밀히 ‘fork 상속’과는 다르다. UI가 native secure-entry child를 spawn하여 **자신의 상속 FD**로 입력을 쓰게 하는 것만으로는 broker 쪽 XPC FD 복제가 상속으로 바뀌지 않는다. 따라서 그 helper 추가만으로 문구를 모두 충족했다고 하면 안 된다. 엄밀한 fork/exec 상속만 허용한다면 보호된 공통 launcher가 broker와 operator GUI helper 양쪽에 채널을 물려주고, UID drop 및 GUI bootstrap session 진입까지 구현·검증해야 한다. 현재 native spike는 이 GUI 배치를 증명하지 않았다.

더 단순한 대안은 인증된 XPC로 설치·전달한 dedicated FD도 허용되는지를 명세에 명시하는 것이다. 이는 비밀의 XPC 본문 전송이나 파일 저장 허용이 아니라 FD 생성 방식의 명확화다. 권고는 XPC는 metadata/FD 전달만, 비밀 본문은 dedicated FD만이라는 정책을 명시하고 구현하는 것이다. 이 해석이 승인되지 않으면 broker↔worker의 상속 경로와 UI/IPC 실행물 코드는 먼저 완성하되 실제 secret 입력은 닫고, 엄밀한 공통 launcher의 GUI 배치를 다음 합성 spike로 다룬다. 이 작은 문구 결정이 모든 native 코드 작성의 선행 blocker는 아니다.

bootstrap은 다음 순서로 고정한다.

1. protected supervisor가 current attempt와 durable admission을 확정하고 고정 launcher를 spawn한다.
2. launcher/worker는 최소 native HELLO 외 모든 import·client 생성·prompt·HTTP를 정지한 상태로 대기한다.
3. supervisor가 OS child identity를 기록한다. broker가 work/attempt/run generation/incarnation/package digest/binding generation/home instance/session epoch와 실제 OS identity를 대조한다.
4. UI와 broker의 양방향 peer 검증 후 실제 사용자가 정확한 세션을 승인한다. key는 `SecRandomCopyBytes` 등 OS 난수로 만들고 전용 FD를 통해서만 전달한다.
5. 방향/용도별 별도 key, challenge, transcript tuple 검증과 양측 ACK를 마친 뒤 auth prompt를 허용한다. HMAC codec에 session UUID가 있다는 사실만으로 전체 tuple binding이 생기지는 않는다.
6. attach/idle/total monotonic timeout, 두 UI attach, cancel/hold/disable, incarnation 변경, old prompt/seq, truncated frame은 terminal revoke로 처리한다. 재연결로 MFA 횟수를 초기화하지 않는다.

GUI는 `NSSecureTextField`와 secure event input을 실제 포커스 동안만 사용하고 pasteboard·복원 state·analytics·crash attachment를 사용하지 않는다. 자동화/접근성 권한을 이미 가진 공격 프로세스까지 고려할 때 code signing만으로 사람의 승인 의도를 증명할 수 없다. 승인 버튼 클릭 자체를 OS 강한 사용자 인증으로 요구한다면 LocalAuthentication/Authorization Services의 별도 user-presence 정책과 해당 실패 행렬이 필요하다. 현재 계획의 ‘명시 선택’과 ‘보안 UI’ 이상의 보장을 이미 제공한다고 쓰지 않는다.

## 5. tokenstore 경로 선택을 보존하는 구체적 방법

같은 UID의 임의 코드는 로그인 사용자 소유 0700 디렉터리/0600 파일을 읽는다. worker만 sandbox에 넣는 것은 sandbox 밖 공격자를 제한하지 않는다. 따라서 **최종 tokenstore directory와 파일 owner를 보호 worker principal로 바꾸는 설치 계약**이 최소다. UI/broker는 토큰 본문을 복사·파싱·DB 저장하지 않는다. library만 load/login/dump한다.

설정의 일반 문자열 `garmin.tokenstore`와 기본 `~/.garmin-pipeline/tokens`를 유지하고 `~`는 operator 등록 시의 home 기준으로 해석한 비밀 없는 path identity로 고정한다. 서비스 계정의 home로 슬쩍 바꿔 다른 위치에 저장하는 것은 경로 선택 보존이라고 할 수 없다. 선택 경로가 전용 principal에 안전하게 위임될 수 없으면 그 경로는 실패 닫힘이다. 처음부터 서비스 전용 보호 경로를 명시 선택할 수도 있지만 이것을 기본 경로 변경으로 몰래 적용하지 않는다.

선택 경로가 사용자 home 아래면 조상 rename도 위협이다. 최종 폴더만 chown하고 검사 후 pathname으로 다시 열면 충분하지 않다. 보호 helper가 `openat`/`O_NOFOLLOW|O_DIRECTORY`, `fstat`로 디렉터리 identity를 확인하고 FD를 worker 종료까지 보유한다. library의 pathname 재열기 문제는 **독립 worker의 `fchdir(pinned_dir_fd)` 후 `login('.')`/`dump('.')`를 쓰는 adapter**로 먼저 합성 검증한다. snapshot/등록에는 원래 선택 경로와 dev/inode/binding을 보존하고 내부 library path만 고정 CWD로 둔다. 병렬 thread에서 `chdir`하지 않는다. 잠긴 library가 상대 경로·자동 `_tokenstore_path`·rename을 실제로 어떻게 다루는지 검사하고, 이 방식이 실패하면 protected 경로만 허용하는 정책이 필요하다. `/dev/fd/N/...`가 macOS 모든 라이브러리 호출에서 된다고 가정하지 않는다.

공격자가 조상을 rename해 가짜 폴더를 원래 경로에 놓아도 이미 고정한 FD에서 토큰이 공격자 폴더에 쓰이면 안 된다. 다음 admission은 원래 path/dev/inode/binding 불일치로 거부해야 한다. 권한이 없는 공격자의 rename/unlink로 서비스 가용성이 깨지는 것과 비밀이 새 폴더로 쓰이는 것은 구분한다. hardlink, ACL, final file symlink, 파일이 아닌 항목, token directory 안 하위 디렉터리도 고정 정책으로 거부한다.

installer의 최초 생성/위임에는 root 권한이 필요하다. 설치 단계가 기존 token 본문을 열어 이사할 필요는 없다. 기존 운영 tokenstore 이전은 16.9에서 사용자가 선택한 별도 절차로 처리하며 이 조사에서는 읽지 않았다. worker principal 변경 후 `tokenstore_check.py`의 owner=현재 UID 조건은 자연스럽게 새 principal을 검사하지만, 사용자 CLI에서 같은 검사를 실행해 성공시키려는 방안은 맞지 않는다.

## 6. 실제 전송 매개와 library 연결

Python 메서드 두 개를 monkeypatch한 현재 구현은 협조적인 라이브러리 seam이지 OS egress 경계가 아니다. 다음은 구현 가능한 최소 연결이다.

- `native_transport.py`가 requests `PreparedRequest`/curl-cffi 요청을 typed broker RPC로 변환하고 응답 status/header/body를 원래 라이브러리용 response 객체로 돌려준다. request/response의 토큰·cookie·password는 로그/DB가 아니라 전용 채널 메모리로만 흐른다. `http_intercept.py`의 원래 `old_send`/`old_request`로 내려가지 않는다.
- TLS·cookie·압축·encoding·redirect·MFA endpoint 그래프를 locked `garminconnect==0.3.20`에 맞춰 fixture로 고정한다. 현재 library의 login은 load→선제 refresh→profile HTTP까지 할 수 있고 session refresh 실패 로그에 body가 들어가는 경로가 있다. import/constructor 전부터 adapter를 설치하고 raw fd stdout/stderr를 native host에서 폐기한다. ABI JSONL은 별도 신뢰 출력 핸들에서 고정 사건만 만든다.
- HTTP broker가 URL host/scheme/port/method/endpoint를 검증한다. worker가 임의 URL을 보내는 범용 proxy가 되어서는 안 된다. libcurl 또는 URLSession을 쓸 수 있지만 curl-cffi의 TLS 지문 동작을 바꾸는 것은 별도 호환성 위험이다. URLSession이면 redirect delegate에서 거부하고 cache·cookie 자동 상태·credential 재시도·오프라인 재개 등을 명시 통제한다. libcurl이면 auto follow/retry를 끄고 고정 옵션과 제한된 응답 크기를 사용한다. transport 교체가 Garmin 호환성을 입증했다는 주장은 실계정 검증 전에는 하지 않는다.
- broker만 `begin intent commit → 실제 전송 하나 → finish commit`을 수행한다. DB 응답 불명은 전송하지 않고, 전송/결과 불명은 pending을 남긴다. 추가 HTTP마다 새 intent와 pacing을 요구한다. HTTP 라이브러리 내부의 자동 재전송까지 금지/관찰할 수 있어야 하므로 논리 RPC 한 번을 실제 HTTP 한 번이라고 세지 않는다.
- per-account monotonic pacing과 DB의 durable last-finished/budget을 연결한다. broker 재시작/boot 변경 때 monotonic 기준을 모르면 DB 시간만 신뢰해 조기 허용하지 않는다. 보수적 대기 또는 중단 정책과 실제 가짜 clock fixture가 필요하다. probe는 refresh/login 없이 검증된 endpoint 요청 하나만 허용하며 유효 session이 없으면 0건이다. 2xx라도 endpoint 의미 검증 없이는 rate latch를 해제하지 않는다.

OS 수준 직접 egress 차단의 우선 후보는 **App Sandbox native WorkerHost에 outgoing/incoming network entitlement를 주지 않는 것**이다. embedded Python은 같은 프로세스이므로 이 제한을 받는다. 파일 접근은 sandbox container와 선택 경로에 대한 정식 file-access 권한을 별도 구성해야 한다. ‘경로 FD 하나를 전달하면 sandbox 권한도 자동으로 모두 생긴다’고 가정하지 않는다. arbitrary tokenstore path를 정식 sandbox 권한으로 열 수 있는지 첫 integration fixture에서 확인한다. 필요한 static path exception은 설치/서명 산출물에 명시하고 광역 home 읽기 권한은 주지 않는다.

이것이 배포 제약과 맞지 않으면 helper의 egress 제한 방식은 실제 남은 설계 게이트다. `sandbox-exec`/임의 SBPL을 제품용 공개 지원 API처럼 추천하지 않는다. local SDK의 `sandbox.h`는 `sandbox_init`을 **“No longer supported”**, macOS 10.8부터 deprecated로 선언하고 flags는 `SANDBOX_NAMED`만 문서화한다. 이 도구로 fake negative 실험을 만들 수는 있지만 지원되는 장기 제품 경계를 입증하지는 않는다. OS 차단 없이 전송 wrapper만 연결한 중간 결과도 구현 가능하나 그 단계에서는 auth 입력/외부 전송을 열지 않는 것이 계획 53·58행과 일치한다.

## 7. DB/daemon도 같은 UID에서 보호해야 한다

### 7.1 소스로 확인한 자격 노출 조건

- `apps/cli/src/config/codec.ts:734–774`: `resolveStoreUrl`은 env 우선, 이후 사용자 home의 `.env`를 읽는다. `postgresSecrets`는 `BRAIN_POSTGRES_PASSWORD`, `BRAIN_APP_PASSWORD`, brain_app URL을 같은 파일에 저장한다. `writeEnv`의 mode는 0600이다.
- 같은 파일 `780–816`: 확장 admin URL은 그 관리자 비밀번호를 쓰고 확장별 password도 같은 `.env`에서 읽는다.
- `apps/cli/src/daemon/supervisor.ts:93–98`: extension DB URL을 worker env로 넘기고 사용자 extension entry/venv를 실행한다. argv/env/프로세스 introspection의 구체적 허용 범위가 OS마다 달라도 같은 UID의 `.env` 읽기만으로 이미 우회 경로가 성립한다.
- `apps/cli/src/daemon/launchd.ts`: `~/Library/LaunchAgents`와 `gui/<uid>` 도메인, 전달된 shim 실행이다. 이 launchd 배치는 root-owned system service 배치가 아니다.
- `packages/postgres/src/setup.ts:46–52`: brain_app에 core schema의 기본 table SELECT/INSERT/UPDATE/DELETE를 준다. `0007_account_protection.sql:255`는 brain_app에 evidence INSERT를 준다. evidence 행이 존재한다는 사실만으로 OS 검증 broker가 썼다는 증명이 되지 않는다.
- `packages/postgres/src/extension-provision.ts:63–69`는 extension schema USAGE/CREATE와 신규 table의 ALL 기본 권한을 준다. 이미 특정 객체에 한 REVOKE 보존 개선은 타당하지만, 일반 확장 자격을 미승인 프로세스가 얻으면 보호 테이블의 허용된 직접 DML까지 사용할 수 있다. broker 함수만 강화해도 직접 DML이 열려 있으면 우회된다.

이 파일의 비밀번호 값이나 운영 `.env`를 읽지 않고 코드 경로만 확인했다. 실제 tokenstore 또한 읽지 않았다.

### 7.2 최소 보완

protected 서비스만 admission/evidence/보호 DML 자격을 갖는다. operator CLI에는 비밀 없는 승인 요청/상태 조회용 좁은 IPC만 제공하고 brain_app/extension/admin URL을 돌려주지 않는다. bootstrap child에 DB 자격을 전달해야 한다면 전용 FD 또는 보호 서비스 내부 자격 주입을 사용하고 사용자 env override를 신뢰하지 않는다. privileged 프로세스가 사용자 `.env`, 사용자 extension manifest, cwd/site-packages, shell startup 파일을 읽지 않게 한다.

새 migration은 broker 전용 role의 evidence 생성 함수, supervisor 전용 admission 함수, worker publish 함수 등의 권한을 명확히 한다. SECURITY DEFINER는 고정 owner/search_path와 current attempt/세대 검증을 유지한다. 기존 `session_user='brain_app'` 검사도 새 role 정책에 맞춰 바꿔야 한다. role 이름만 새로 만들고 기존 brain_app/extension 직접 DML을 남기지 않는다. `extension-provision.ts`의 blanket default ALL/CREATE 정책과 이 protected schema의 특수 권한 계약도 조정한다. 재provision, role 삭제·재생성, migration 재개로 권한이 다시 넓어지지 않는 시험을 한다.

### 7.3 OrbStack/Docker 관리 경계

`apps/cli/src/install/postgres.ts:17–28`은 POSTGRES_PASSWORD를 컨테이너 environment로 주고 host loopback port를 공개한다. `apps/cli/src/runtime/orbstack.ts`는 현재 사용자 CLI에서 `orb status`, `docker context show`, `docker version`, `docker volume inspect`를 호출하는 배치다. **해당 사용자 UID의 임의 프로세스도 그 엔진 관리 API를 사용할 수 있다면**, Docker inspect의 environment·exec·volume 접근/컨테이너 교체를 통해 DB 관리 경계가 무너진다. localhost port 자체가 취약점이라는 뜻은 아니고, 엔진 관리 권한과 자격 보관이 핵심이다. 실제 엔진/pg_hba/컨테이너를 조사하지 않았으므로 현 세션의 접근 성공이나 trust 설정을 관측했다고 쓰지 않는다.

해법은 DB 비밀번호만 다른 폴더로 옮기는 것이 아니라 **DB 프로세스·volume·엔진 API까지 로그인 UID로부터 분리**하는 것이다. 가능한 선택은 (a) 실제로 분리 가능한 보호 principal 소유의 VM/컨테이너 엔진과 관리 소켓, (b) 별도 principal의 로컬 PostgreSQL 서비스다. 현재 사용자의 OrbStack API를 그대로 쓸 경우 이 보장을 제공하지 못할 수 있다. 이를 ‘OS 관리자는 범위 밖’이라며 제외하면 안 된다. 관리자 승격 없는 평범한 사용자 Docker API 권한도 이번 같은 UID 공격 범위에 들어간다.

main DB가 공격자 관리하에 있는데 작은 별도 보호 ledger만 안전하게 두는 대안은 현재 attempt/hold/account binding 사실까지 그대로 main DB를 신뢰하면 성립하지 않는다. 그 대안을 택하려면 독립 보호 ledger가 검증하는 서명된 승인·취소·generation 계약과 조작된 main DB를 거부하는 모델까지 새로 설계해야 하므로 현재 계획의 최소 경로가 아니다. 우선 전체 관련 권위 DB의 관리 경계를 보호하는 쪽을 권고한다. 기존 원본 행·권위 v1을 덮어쓰는 재구축은 금지하고, 실제 이전은 별도 승인된 16.9 절차다.

## 8. 구현자가 지금 수행할 순서와 합성 증거

아래는 이후 구현 Dispatch의 순서다. 이번 읽기 전용 조사에서 실행한 시험 목록이 아니다.

| 순서 | 코드 작업 | 합성 검증/남길 증거 | 단계 완료의 한계 |
|---|---|---|---|
| 1 | native 권한/설치 manifest와 renderer, runtime package 봉인, preflight | 임시 staging root의 plist·mode·owner 기대값·고정 digest·누락 시 deny; 서로 다른 signing ID/cdhash fixture | 실제 root 소유/다른 UID 효과는 fake fs만으로 증명하지 못함 |
| 2 | PeerIdentity와 실제 별도 프로세스 UI/broker/WorkerHost 실행물 | 같은 UID 다른 binary, 잘못된 역할의 정상 signed binary, fake broker, 자기 PID 주장, 옛 package, requirement parse 실패 모두 prompt 0/frame 0/HTTP 0; 정상 쌍만 ACK | 실제 배포 신원/보호 경로를 대신하지 않음 |
| 3 | typed core auth capability와 system native launcher; 기존 supervisor 연결 | 실제 supervisor가 admission commit 후 child spawn, OS 신원 저장 지연/실패 동안 import·constructor·HTTP 0; current tuple ACK 뒤만 fake prompt. 취소/후손 FD/PID reuse/boot mismatch 때 종료 증거 없으면 새 attempt 0 | 합성 library만 사용 |
| 4 | native UI와 wire reader·bootstrap·세션 선택, `auth_flow` 연결 | 합성 password/MFA canary, echo/두 operator/old prompt/길이·partial frame·seq·방향·bad HMAC·timeout. MFA 같은 client 최대 3회, raw fd/C output 누출 시도, env/argv/DB/로그/임시 파일 canary 0 | 실제 사용자 계정 입력은 하지 않음 |
| 5 | tokenstore owner/FD pin/library 상대 경로 adapter | 합성 빈 tokenstore에서 library load/dump만 내용 접근; symlink 조상·rename+replace·hardlink·wrong ACL/mode·inode 교체 중에도 공격자 폴더에 token 0; 다음 admission mismatch 거부 | 별도 UID 실제 read 거부 시험은 provision된 격리 fixture에서 추가 |
| 6 | broker RPC requests/curl adapter + OS egress 제한 + fake HTTP | worker의 socket/ssl/curl-cffi/native curl/subprocess 직접 연결은 fake server 수신 0, broker 승인만 수신 1; import/constructor/refresh/fallback/redirect/재시도 중 모든 송신 수 계측; second probe 0; response loss→pending | monkeypatch 호출 수 대신 fake server의 실제 요청 수 사용 |
| 7 | broker DB role/권한 migration + 보호 supervisor + auth 성공 CAS | 실제 격리 PG 역할로 evidence 위조·direct latch UPDATE·holder 삭제 거부, brain_app 기존 허용 권한도 점검, 재provision 후 거부 유지. 실패/응답 유실/SIGKILL+재시작 무호출, latch 합집합·다른 계정 병렬·null-key 충돌 | fake SQL mock만으로 DB 권한 완료를 주장하지 않음 |
| 8 | 통합 fixture와 installer apply/uninstall 경로 완성 | T01–T28을 실제 supervisor/격리 PG/fake HTTP/native child에 매핑한 증거표, PID/PGID/start/boot·package digest·고정 오류·호출 수·test exit. finally에서 child reap→daemon stop→DB/fixture cleanup | production install/실계정은 여전히 16.9 |

주요 검사 파일은 기존 `extensions/garmin/tests/native/check-native.sh`를 버리지 않고 새 `check-boundary` runner를 옆에 추가한다. 기존 간단 spike와 새 통합 gate를 별도 target으로 유지하여 spike 성공이 전체 보안 검증처럼 출력되지 않게 한다. `apps/cli/python-test/garmin-protection.test.ts`, `garmin-admission.test.ts`, `packages/core/test/supervisor.test.ts`, `packages/postgres/test/extension-permissions.test.ts`는 실제 연결의 회귀 지점이다.

fake installer runner는 Directory Services/launchctl/owner 변경/서명을 주입 가능한 포트로 만들고 stage 산출물을 생성해야 한다. 단순 설치 명령 문자열 스냅샷보다, symlink 설치 대상·existing wrong owner·부분 실패 rollback·계정 UID 충돌·이미 다른 버전 실행 중·기존 미확정 admission·서명 policy 누락에서 apply 거부를 검사한다. 실제 principal 시험이 없는 것을 ‘사람이 필요해서 코드도 못 만들었다’고 처리하지 않는다.

OS entitlement/서명·sandbox·로더 검증이 통과하지 않는 기계에서는 fixture 결과를 `unsupported`/실패로 남기고 live auth를 닫는다. 외부 provision 전에도 위 구현·fake 검증은 독립된 reviewable checkpoint가 되지만 16.2 전체 수락은 아니다.

## 9. 에이전트가 할 일과 진짜 사람이 해야 할 마지막 단계

**에이전트가 먼저 완성할 수 있는 것:** 위 native source/빌드 정의/고정 dependency loader, peer requirements, 승인 UI, typed capability, per-send transport RPC, DB migration, installation renderer와 실행 가능한 apply/uninstall/preflight, fake GUI/worker·HTTP·PG runner, local ad-hoc fixture, source package와 서명용 산출물·정확한 운영 runbook이다. 서명 비밀이나 root 권한이 없더라도 실패 닫힌 실행물과 staging 설치 트리를 만들 수 있다. certificate가 없다는 이유로 requirement 검증을 env boolean으로 바꾸지 않는다.

**사람/외부 환경이 마지막에 제공해야 할 것:**

1. 실제 승인된 signing identity와 키 사용 권한 또는 명시된 로컬 root pin 정책, 필요하면 Developer ID/notarization에 필요한 외부 자격. 기존 보고는 당시 유효 signing identity 0개였다고 하므로 현재 확보를 가정하지 않는다. 인증서 취득/Apple 계정/OS 비밀번호를 에이전트가 대신 만들거나 채팅으로 받을 일이 아니다.
2. review된 installer를 관리자 권한으로 실제 적용하여 비로그인 계정·root 소유 설치물·서비스 전용 state/DB 관리 소켓을 생성하고 launchd/서비스를 승인한다. `SMAppService.daemon(...).register()`를 택하면 admin 승인 전 LaunchDaemon이 bootstrap되지 않는 OS 절차가 있다. 직접 패키지/launchctl 배포와 SMAppService 경로를 혼합해 승인 완료라고 하지 않는다.
3. 운영 DB와 OrbStack 관리 경계의 실제 이전/접근 제한, 기존 자격 회전 및 사용자 `.env` 잔존 자격 제거·기존 연결 폐기, snapshot/backup/volume 권한 검증. daemon과 worker의 실제 owner·서명·sandbox·DB 권한 증거가 확보되어야 한다.
4. 16.9에서만 실제 사용자가 approved UI에 계정/MFA를 직접 입력하고 운영 tokenstore 이전·실계정 검증·예약 전환을 승인/수행한다.

관리자 실행이 필요하다는 것은 지금 임의 sudo를 요청하라는 뜻이 아니다. 실행 가능한 설치 산출물과 fake 검증이 먼저다. 실제 적용 권한이 이미 명시 승인된 이후의 구현 세션에서는 반복 허가를 요구할 필요도 없지만, 현재 조사 task에는 설치 실행 권한이 없다.

## 10. 명세 충돌과 배치상 양립 불가를 구분

### A. 이미 감독자 결정이 해소한 과거 문구

같은 파일 42행의 정확한 구절은 **“재인증 성공 전까지 호출 0”**, 55행은 **“인증 latch에는 기존 binding의 명시적 인증 단계 재인증만, rate latch에는 다음 현지 날짜의 예약된 실제 HTTP 요청 하나만 예외로 허용한다.”** 전자를 auth 절차에도 절대 적용하면 재인증을 할 수 없지만, 후자의 명시 결정이 좁은 예외를 제공했다. 현재 활성 요구의 미해결 모순으로 다시 HALT할 이유가 아니다. rate/auth/uncertain 교집합은 모두 만족해야 하므로 rate 당일 차단이 있으면 재인증을 빌미로 HTTP를 보내지 않는다.

53행의 **“OS가 검증하는 실행물·상대 신원과 보호된 UI/broker/worker 및 tokenstore 격리를 구현·검증한다.”**와 58행의 **“실계정 MFA·배포는 16.9에 남긴다.”**도 모순이 아니다. 16.2는 설치 코드·패키지·격리 합성 환경에서 경계를 구현/검증할 수 있고 운영 적용만 뒤로 남긴다. 이 구분으로 실제 코드를 작성하면 된다.

### B. 조건을 추가하면 발생하는 진짜 양립 불가

31행의 **“기본값은 `~/.garmin-pipeline/tokens`다. 라이브러리만 세션을 읽고 쓰며 폴더 0700·파일 0600을 보장한다.”**와 53행의 **“위협 범위는 다른 UID와 같은 UID의 미승인 프로세스를 포함한다.”**는 그 자체로 모순이 아니다. 그러나 ‘그 경로와 파일을 계속 로그인 UID가 소유하고 읽을 수 있어야 한다’는 추가 조건을 붙이면 동시에 달성할 수 없다. 소유자 read 권한은 같은 UID 공격자에게도 적용된다. 그런 추가 조건은 현재 계획에 없으므로 service ownership/FD pin으로 해결을 진행할 수 있다. arbitrary pathname을 매번 다시 열어야 한다는 조건도 명세에 없으므로 pinned directory adapter 검증을 먼저 할 수 있다.

AGENTS의 **“source of truth is PostgreSQL in an OrbStack Docker container”**와 계획 53행의 **“위협 범위는 다른 UID와 같은 UID의 미승인 프로세스를 포함한다.”**는 **로그인 UID가 해당 OrbStack 엔진의 무제한 관리 API를 계속 가져야 한다**는 배치 조건 아래에서는 권위 DB 무결성과 양립하지 않는다. 소스는 사용자 Docker API 사용과 컨테이너 환경의 관리자 비밀번호를 보여 주지만, 이 조사에서는 실제 엔진 권한을 관측하지 않았으므로 ‘현재 호스트에서 공격 성공’이라고 단정하지 않는다. 이 조건이 확인되면 protected engine 배치로 같은 PostgreSQL/OrbStack 계약을 유지할 수 있는지 조사하거나, 기존 OrbStack 배치 요구의 변경을 지휘자가 기록해야 한다. application-level DB 관리자 권한을 OS root와 동일하게 범위 밖으로 재분류하는 것은 요구 축소다.

### C. 상속 FD의 엄밀성

54행의 **“비밀은 전용 상속 FD로만 흘리고”**와 설계 3.1의 **“비밀 흐름은 `신뢰된 operator UI → 로컬 인증 broker → 해당 auth worker의 익명 FD`다.”**는 양립 가능하다. 단, GUI↔broker를 XPC dictionary 비밀 payload로 구현하면 첫 구절을 위반한다. 위 4.2의 공통 launcher에서 실제 양쪽 상속과 GUI session을 입증하거나, 인증된 dedicated FD transfer의 허용 의미를 명시해야 한다. UI가 자기 helper만 spawn하는 것으로 broker 쪽 상속까지 충족했다고 주장하지 않는다. 이것은 코드 작성을 멈출 모순이 아니라 구현 선택을 정확히 해야 할 지점이다.

## 11. OS 근거와 증거의 한계

- [Apple XPC requirement API](https://developer.apple.com/documentation/xpc/xpc_connection_set_peer_code_signing_requirement(_:_:)) 및 현재 local SDK `usr/include/xpc/connection.h:772–803`: connection requirement의 실제 의미·availability는 SDK 주석을 직접 확인했다. 웹 검색 발췌 일부는 Apple platform identity API 설명과 혼동되어 있어 일반 code requirement의 의미는 SDK 및 현재 spike source를 우선했다.
- [Apple Hardened Runtime](https://developer.apple.com/documentation/xcode/configuring-the-hardened-runtime), [Library Validation](https://developer.apple.com/documentation/BundleResources/Entitlements/com.apple.security.cs.disable-library-validation): runtime 예외를 남발하지 않고 의존 native library까지 서명/검증해야 하는 근거다. 서명된 일반 interpreter만으로 Python/JS 내용이 검증된다는 뜻이 아니다.
- [App Sandbox entitlement reference](https://developer.apple.com/library/archive/documentation/Miscellaneous/Reference/EntitlementKeyReference/Chapters/EnablingAppSandbox.html), [file access](https://developer.apple.com/documentation/security/accessing-files-from-the-macos-app-sandbox): network 권한과 child inheritance/file access의 제약 근거다. 현재 배치에서 필요한 entitlement가 승인되었다는 뜻이 아니다.
- [SMAppService](https://developer.apple.com/documentation/servicemanagement/smappservice), [register 승인](https://developer.apple.com/documentation/servicemanagement/smappservice/register()): OS 등록과 사람의 admin 승인 경계다.
- [NSSecureTextField](https://developer.apple.com/documentation/appkit/nssecuretextfield), [TN2150 Secure Event Input](https://developer.apple.com/library/archive/technotes/tn2150/_index.html): 승인 UI 입력 구현 근거다. arbitrary same UID process의 모든 OS 접근성 특권까지 signing만으로 해결한다는 근거로 쓰지 않는다.

이번 보고는 설계·구현 경로와 소스 근거를 제공했다. 설치 실행물·native integration·OS 격리·실제 broker 전송이 없는 현재 상태를 완료로 승격하지 않으며, 동시에 외부 provision 전 작성 가능한 구현을 사람 작업으로 미루지도 않는다.
