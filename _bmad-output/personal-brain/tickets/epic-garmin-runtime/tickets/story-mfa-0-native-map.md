# 16.2 g3 D3/D4 macOS native 연결 조사

작성일: 2026-11-01. 읽기 전용 조사이며 보고서만 작성했다. 소스 수정, 컴파일, 빌드, 시험, 추가 워커, 관리자 설치, 운영 DB·설정 비밀·tokenstore·실계정 접근은 하지 않았다. 아래 파일 위치는 읽은 당시의 상태이며 구현 워커가 동시에 변경할 수 있다. SDK 선언의 존재, 기존 합성 실험의 범위, 실제 배포의 검증 여부를 별도로 표시한다.

## 판단

공개 API로 구성 가능한 최소 경로는 **기존 단일 supervisor → 인증된 XPC → 별도 Garmin principal의 native WorkerHost/launcher → 봉인된 일감 자식**이다. 승인 UI ↔ broker도 각각 상대 코드 requirement를 확인한다. launchd가 실행 principal을 정하고, WorkerHost가 그 principal 그대로 고정 자식을 생성한다. root 런타임에 Python·Garmin 라이브러리·HTTP를 넣거나, 로그인 UID 또는 서명된 범용 인터프리터라는 이유만으로 임의 스크립트를 신뢰하는 경로는 해법이 아니다. 이것은 API와 소스에 근거한 구현 제안이지 실제 principal 격리·배포 성공 판정이 아니다.

D3의 핵심은 DB 청구자/갱신자/확정자를 늘리지 않는 것이다. Garmin host와 일반 host는 executor이며 `runSupervisor`를 각각 실행하지 않는다. 일반 확장도 같은 supervisor가 청구하고, 검증된 비특권 ordinary WorkerHost로 실행만 위임한다. 설치·보호 엔진·D2B·D5 egress가 미검증이면 입력 및 외부 HTTP를 계속 닫는다. peer 검증은 DB·Docker 권위 격리나 네트워크 차단을 대신하지 않는다.

## 1. 현재 코드에서 확인한 것

| 위치 | 현재 존재 | D3/D4 연결 공백 |
|---|---|---|
| `apps/cli/src/daemon/sealed-launcher.ts` | `SealedNativeLauncher.startGarmin(spec)` port, 고정 command·무 args·무 cwd·env 키 목록·bootstrap 필수·Garmin 두 kind 확인, freeze | native 구현 없음. freeze는 OS 인증이나 child의 실행 이미지 검증이 아님 |
| `apps/cli/src/daemon/sealed-garmin.ts` | 고정 설치 후보 `/Library/Application Support/SecondBrain/libexec/garmin-worker`, `verifyInstalledWorker`, snapshot/admit/release/bootstrap 주입 | 실제 서명·봉인 검사 및 보호된 snapshot/registry 공급 필요 |
| `apps/cli/src/daemon/ordinary-worker-host.ts` | kinds 필터, protected extension 제외, peer UID/PID/session 검증 hook, reconnect 거부 | `Peer`의 숫자·문자열 자체는 증거가 아님. 같은 native 연결과 그 OS 증거에 verifier를 묶어야 함 |
| `packages/core/src/queue/supervisor.ts` | `sealedService`, ordinary kind만 claim, 보호 admission → spawn → boot/start identity 저장 → 현재 attempt 확인 → bootstrap authorize → 출력 소비; 승인 10초 상한; group cleanup 뒤 성공 admission release | native composition root와 remote handle/inspector 연결 필요. 단일 supervisor 유지 |
| `packages/core/src/ports/process.ts` | `pid`, `exited`, `leaderExited`, stdout/stderr, `sendBootstrapAck`, `closeBootstrap`, `signalGroup` | `pid`는 일감 자식 그룹 리더여야 함. WorkerHost/XPC 서비스 PID를 돌려주면 안 됨. auth 비밀 채널은 현재 port에 없음 |
| `apps/cli/src/runtime/process-group.ts` | Node detached spawn, FD 3에 1바이트 ACK, one-shot boolean, closeOutput, exit와 EOF 분리 | UID 전환·OS peer 인증 없음. FD 3 ACK는 비밀 채널이 아니며 코드 신원을 증명하지 않음 |
| `apps/cli/src/daemon/supervisor.ts` | 기존 daemon에서 `loadProtectedLaunches`와 `systemProcessLauncher`를 조합 | 읽은 상태에서는 sealed composition 미연결. 사용자 home manifest/venv/.env를 읽는 기존 경로를 보호 principal의 실행 권한으로 승격하면 안 됨 |
| `packages/core/src/queue/process-cleanup.ts` | boot/start 신원 확인, TERM→KILL, leader reap와 그룹 비움 구별, unknown 유지 | 다른 principal의 자식을 supervisor가 직접 waitpid할 수 없음. host가 reaper, native inspector가 증거 공급 |
| `extensions/garmin/src/auth_wire.py` | 길이·버전·session·방향 HMAC·seq·prompt·응답 중복 검사 codec | OS peer, key provisioning, transport, TTL, binding/attempt 권한은 별도. key/session이 argv/env에서 오면 이 경계가 무너짐 |
| `extensions/garmin/src/auth.py` | 안전한 bootstrap/HTTP admission 전 fail closed | 실제 transport와 library 연결 미완료 |
| `tooling/protected-deployment/policy.mjs` | staging 정책, root owner/변조 검사 | `ENGINE_ISOLATION_UNVERIFIED`, `SERVICE_IDENTITY_UNVERIFIED`, `SIGNATURE_UNVERIFIED`를 남김. 서비스 설치·서명 완료로 취급 불가 |

`extensions/garmin/tests/native/peer-parent.c`는 socketpair/fork/exec 이후 `LOCAL_PEERTOKEN`→Security requirement를 검사하고, `check-native.sh`는 peer PID==child PID와 승인/비승인을 assert한다. `xpc-spike.c`는 **같은 프로세스의 익명 XPC listener/client** 양쪽에 requirement를 설정한다. 기존 계획의 실행 성공 기록은 그 합성 범위의 과거 증거이며 이번 조사에서는 재실행하지 않았다. 다른 서비스 principal 간 XPC, UI 승인, FD 폐기, 보호된 설치, tokenstore, HTTP 차단은 이 fixture가 입증하지 않는다. socketpair를 생성했다는 사실만으로 exec 이후 상대 신원이 보장된다고 일반화하지 말고, 실제 서비스 메시지와 각 FD의 생성/상속 경로를 다시 검증해야 한다.

## 2. 공식 근거와 버전

로컬 Apple Command Line Tools의 `MacOSX.sdk/SDKSettings.json`은 macOS 27.0 SDK다. 아래 `SDK/...`는 `/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk/...`를 뜻한다. 해당 SDK 헤더의 API availability는 배포 하한 확인 근거이며 현재 호스트/최소 지원 OS에서의 실행 성공 증거는 아니다.

- `SDK/usr/include/xpc/connection.h`: connection 생성·활성화·peer requirement·오류·수명. code-signing requirement는 macOS 12.0+, team/entitlement requirement는 14.4+.
- `SDK/usr/include/xpc/xpc.h`: FD boxing/dup과 dictionary FD API.
- `SDK/System/Library/Frameworks/Security.framework/Headers/{SecCode,SecRequirement,SecStaticCode}.h`: 수신 XPC 메시지의 audit token을 이용한 코드 조회, runtime/static validity, 봉인 검사 flags.
- `SDK/System/Library/Frameworks/Foundation.framework/Headers/NSXPCConnection.h`: macOS 13.0+ 양쪽 코드 requirement setter.
- `SDK/usr/include/{spawn.h,sys/spawn.h,sys/un.h,sys/socket.h,unistd.h,signal.h,sys/wait.h,sys/fcntl.h,libproc.h,sys/proc_info.h}` 및 `SDK/usr/share/man/man5/launchd.plist.5`: spawn, FD, process group, principal 배치.

공식 웹 문서:

1. [XPC code signing requirement](https://developer.apple.com/documentation/xpc/xpc_connection_set_peer_code_signing_requirement(_:_:)) — 상세 동작은 위 SDK 주석과 대조했다. 검색 페이지 요약에 platform-identity 설명이 섞여 있었으므로 그 요약을 일반 requirement의 의미로 사용하지 않았다.
2. [SecCodeCopyGuestWithAttributes](https://developer.apple.com/documentation/security/seccodecopyguestwithattributes(_:_:_:_:)) — kernel host를 통한 동적 코드 조회.
3. [TN3127 requirements](https://developer.apple.com/documentation/technotes/tn3127-inside-code-signing-requirements) 및 [Requirement Language](https://developer.apple.com/library/archive/documentation/Security/Conceptual/CodeSigningGuide/RequirementLang/RequirementLang.html) — anchor, identifier, OU, cdhash의 의미.
4. [TN2206](https://developer.apple.com/library/archive/technotes/tn2206/) 및 [Understanding the Code Signature](https://developer.apple.com/library/archive/documentation/Security/Conceptual/CodeSigningGuide/AboutCS/AboutCS.html) — nested code와 resource seal. 코드 서명은 모든 외부 실행 입력을 자동으로 봉인하지 않는다.
5. [Creating Launch Daemons and Agents](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html) — system daemon과 user agent 구분, launchd 관리.
6. [posix_spawn](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/posix_spawn.2.html) — FD 상속·spawnp PATH 탐색. 최신 확장은 로컬 SDK로 확인.
7. [XPC cancel](https://developer.apple.com/documentation/xpc/xpc_connection_cancel(_:)) 및 [interrupted](https://developer.apple.com/documentation/xpc/xpc_error_connection_interrupted-swift.var) — 비동기 취소와 서비스 재연결 동작.
8. [XPC dictionary FD](https://developer.apple.com/documentation/xpc/xpc_dictionary_set_fd(_:_:_:)) — 전용 descriptor 전달 API.

## 3. 실제 공개 API 시그니처

다음은 C/Objective-C 헤더의 타입·인자 순서를 보존한 선언이다(가독성을 위해 nullability/availability/restrict/ownership 매크로 일부 생략). 구현자가 이 목록의 함수를 전부 쓸 필요는 없다. 최소 권고는 C XPC + Security이며 Swift에서는 해당 C API를 import한 native wrapper를 둘 수 있다.

```c
// xpc/connection.h
xpc_connection_t xpc_connection_create_mach_service(
    const char *name, dispatch_queue_t targetq, uint64_t flags);
xpc_connection_t xpc_connection_create_from_endpoint(xpc_endpoint_t endpoint);
void xpc_connection_set_event_handler(xpc_connection_t connection, xpc_handler_t handler);
void xpc_connection_activate(xpc_connection_t connection);
int xpc_connection_set_peer_code_signing_requirement(
    xpc_connection_t connection, const char *requirement);
int xpc_connection_set_peer_team_identity_requirement(
    xpc_connection_t connection, const char *signing_identifier);
int xpc_connection_set_peer_entitlement_exists_requirement(
    xpc_connection_t connection, const char *entitlement);
int xpc_connection_set_peer_entitlement_matches_value_requirement(
    xpc_connection_t connection, const char *entitlement, xpc_object_t value);
uid_t xpc_connection_get_euid(xpc_connection_t connection);
pid_t xpc_connection_get_pid(xpc_connection_t connection);
void xpc_connection_send_message(xpc_connection_t connection, xpc_object_t message);
void xpc_connection_send_message_with_reply(xpc_connection_t connection,
    xpc_object_t message, dispatch_queue_t replyq, xpc_handler_t handler);
void xpc_connection_cancel(xpc_connection_t connection);

// Security/SecCode.h, SecRequirement.h, SecStaticCode.h
OSStatus SecCodeCreateWithXPCMessage(xpc_object_t message,
    SecCSFlags flags, SecCodeRef *target);
OSStatus SecCodeCopyGuestWithAttributes(SecCodeRef host,
    CFDictionaryRef attributes, SecCSFlags flags, SecCodeRef *guest);
OSStatus SecRequirementCreateWithString(CFStringRef text,
    SecCSFlags flags, SecRequirementRef *requirement);
OSStatus SecCodeCheckValidity(SecCodeRef code,
    SecCSFlags flags, SecRequirementRef requirement);
OSStatus SecCodeCopyStaticCode(SecCodeRef code,
    SecCSFlags flags, SecStaticCodeRef *staticCode);
OSStatus SecStaticCodeCreateWithPath(CFURLRef path,
    SecCSFlags flags, SecStaticCodeRef *staticCode);
OSStatus SecStaticCodeCheckValidityWithErrors(SecStaticCodeRef staticCode,
    SecCSFlags flags, SecRequirementRef requirement, CFErrorRef *errors);

// xpc/xpc.h: explicit dup ownership path
xpc_object_t xpc_fd_create(int fd);
int xpc_fd_dup(xpc_object_t xfd);
void xpc_dictionary_set_fd(xpc_object_t xdict, const char *key, int fd);
int xpc_dictionary_dup_fd(xpc_object_t xdict, const char *key);

// sys/socket.h, sys/un.h, unistd.h, sys/fcntl.h
int socketpair(int domain, int type, int protocol, int *sv);
int getsockopt(int socket, int level, int option_name,
    void *option_value, socklen_t *option_len);
int pipe(int fildes[2]);
int fcntl(int fd, int cmd, ...);
int close(int fd);
int setpgid(pid_t pid, pid_t pgid);
int kill(pid_t pid, int sig);
pid_t waitpid(pid_t pid, int *status, int options);

// spawn.h
int posix_spawn(pid_t *pid, const char *path,
    const posix_spawn_file_actions_t *file_actions,
    const posix_spawnattr_t *attrp, char *const argv[], char *const envp[]);
int posix_spawnattr_init(posix_spawnattr_t *attr);
int posix_spawnattr_destroy(posix_spawnattr_t *attr);
int posix_spawnattr_setflags(posix_spawnattr_t *attr, short flags);
int posix_spawnattr_setpgroup(posix_spawnattr_t *attr, pid_t pgroup);
int posix_spawn_file_actions_init(posix_spawn_file_actions_t *actions);
int posix_spawn_file_actions_destroy(posix_spawn_file_actions_t *actions);
int posix_spawn_file_actions_adddup2(posix_spawn_file_actions_t *actions, int fd, int newfd);
int posix_spawn_file_actions_addclose(posix_spawn_file_actions_t *actions, int fd);
int posix_spawn_file_actions_addinherit_np(posix_spawn_file_actions_t *actions, int fd);

// libproc.h: native inspector candidate (not executed)
int proc_listpids(uint32_t type, uint32_t typeinfo, void *buffer, int buffersize);
int proc_pidinfo(int pid, int flavor, uint64_t arg, void *buffer, int buffersize);
```

`xpc_connection_get_audit_token`은 확인한 공개 `xpc/*.h`에 선언돼 있지 않다. 비공개 symbol 선언을 직접 추가하지 않는다. **실제로 받은 XPC dictionary**에 `SecCodeCreateWithXPCMessage(message, kSecCSDefaultFlags, &code)`를 쓰면 그 메시지의 audit token으로 송신 실행 주체를 조회하는 공개 경로가 된다. 임의로 새로 만든 dictionary, payload의 token/PID, forwarded payload를 원 송신자 증거로 사용하지 않는다. Unix socket의 대안은 `getsockopt(fd, SOL_LOCAL, LOCAL_PEERTOKEN, &token, &length)` 후 정확한 길이 확인, `CFData`로 token 전체를 포장해 `{kSecGuestAttributeAudit: data}`를 `SecCodeCopyGuestWithAttributes(NULL, attrs, ..., &code)`에 넘기는 기존 경로다. UID/PID 기반 재조회로 token을 대체하지 않는다. `xpc_connection_get_pid`의 SDK 주석도 PID 재사용과 disconnect 통지 지연을 명시한다. `xpc_connection_get_euid`는 연결 당시 EUID이므로 서비스 principal이 연결 후 변경되는 설계를 피한다.

Objective-C를 택하면 Foundation 공개 선언은 다음과 같다. macOS 13.0+이고, 잘못된 requirement는 예외를 낸다. public NSXPCConnection 헤더에서 auditToken 속성을 찾지 못했으므로 private KVC로 읽는 방식을 권고하지 않는다.

```objc
// NSXPCConnection
- (instancetype)initWithMachServiceName:(NSString *)name
                               options:(NSXPCConnectionOptions)options;
- (void)setCodeSigningRequirement:(NSString *)requirement;
// NSXPCListener
- (instancetype)initWithMachServiceName:(NSString *)name;
- (void)setConnectionCodeSigningRequirement:(NSString *)requirement;
// NSXPCListenerDelegate
- (BOOL)listener:(NSXPCListener *)listener
    shouldAcceptNewConnection:(NSXPCConnection *)newConnection;
```

client의 `setCodeSigningRequirement:`와 listener의 `setConnectionCodeSigningRequirement:`를 각각 resume 전에 설정해야 양방향이다. 후자는 anonymous/mach-service listener만 지원한다. FD 전달을 Objective-C 객체 직렬화에 암묵 의존하기보다 C XPC FD 경로로 일관되게 구성하는 편이 현 fixture와 가깝다.

## 4. peer requirement와 봉인 검사

1. 각 역할마다 고정된 signing identifier를 할당하고, 배포자가 통제하는 requirement를 보호된 registry에 저장한다. 형식 예시는 `anchor apple generic and identifier "<role-signing-id>" and certificate leaf[subject.OU] = "<team-id>"`이다. 실제 발급 서명·배포 정책으로 더 좁혀야 하며 이 문자열 자체가 완성된 릴리스 정책은 아니다. `anchor apple generic` 단독이나 Team ID 단독은 다른 앱도 허용한다. 사용자 요청/manifest가 requirement를 선택하게 하지 않는다. 릴리스 generation/CDHash allowlist는 보호된 정책으로 승인된 업데이트만 반영한다.
2. `xpc_connection_set_peer_code_signing_requirement`를 연결마다 한 번, 메시지 허용 전에 설정한다. listener requirement는 미충족 요청을 drop하며 reply 요구 연결은 `XPC_ERROR_PEER_CODE_SIGNING_REQUIREMENT`를 받을 수 있다. 반환 0은 문자열 설정 성공이지 peer 인증 완료가 아니다. 정상 왕복 메시지와 Security 검사, 역할/작업 바인딩까지 확인한 뒤 capability를 연다. 다른 peer requirement family setter를 같은 연결에 누적 호출하지 말고 단일 복합 requirement로 표현한다.
3. UI client는 broker requirement, broker listener는 UI requirement, supervisor client는 Garmin host requirement, Garmin host listener는 supervisor requirement를 각각 설정한다. ordinary host도 supervisor/host 양쪽 검사한다. expected UID는 역할 배치의 추가 조건이며 서명을 대신하지 않는다. 동일 UID의 임의 프로세스는 거부돼야 한다. approved UI 앱을 실행했다는 사실만으로 특정 work 입력 권한이 생기지 않도록 session/attempt/세대와 일회 승인까지 묶는다.
4. 받은 메시지마다 Security dynamic code validity와 고정 requirement를 검사해 payload의 peer 주장과 분리한다. PID는 audit evidence와 실제 spawn PID 일치 여부를 보조 확인할 때만 쓴다. requirement가 같더라도 다른 승인 인스턴스일 수 있으므로 연결·launch ticket·child PID·generation을 결합한다. 재연결은 새 연결 신원으로 간주하고 이전 approval/FD를 재사용하지 않는다.
5. `verifyInstalledWorker`는 고정 경로의 parent chain owner/mode/ACL/symlink 및 서명·봉인을 함께 확인한다. `SecStaticCodeCreateWithPath` → `SecStaticCodeCheckValidityWithErrors`에 all-architectures/nested-code/strict flags를 적용할 후보가 있다. `kSecCSCheckAllArchitectures | kSecCSCheckNestedCode | kSecCSStrictValidate`를 사용하고 executable/resources 검사 생략 flags는 쓰지 않는다. `kSecCSAllowNetworkAccess`를 켜지 않는다. OSStatus/CFError 원문은 고정 코드로 정리한다. CF Create/Copy 결과와 error는 해제한다.
6. static 경로 검사와 실행 사이 교체는 static API만으로 해결되지 않는다. 사용자에게 쓰기 불가능한 설치 tree·ACL·업데이트 잠금/세대 전환과 **실제로 실행된 child의 메시지 기반 검증**이 모두 필요하다. native wrapper만 서명하고 사용자 venv·스크립트·import path·동적 라이브러리를 읽으면 봉인으로 볼 수 없다. 외부 Python resources/라이브러리도 보호된 설치와 서명 resource/별도 package digest 정책에 포함하고, 임의 module/plugin 및 `PYTHONPATH`/`DYLD_*` 같은 주입 입력을 제거한다. Hardened Runtime/library validation도 interpreter의 임의 script 신뢰를 자동 해결하지 않는다.

## 5. 최소 API 및 상태 전이 순서

### A. 설치 시 정의할 구조 (이번에 수행하지 않음)

- 보호 supervisor, broker, Garmin WorkerHost를 각 정해진 서비스 principal로 launchd system domain에 배치한다. `launchd.plist(5)`의 `UserName`/`GroupName`은 privileged system domain에서 적용된다. UserName 생략으로 root 실행하는 구성을 금지한다. root는 설치 소유권을 만들 수 있어도 library/HTTP 런타임 principal이 아니다.
- Garmin WorkerHost는 Garmin 자식을 자신의 전용 UID로 spawn한다. supervisor가 다른 UID로 직접 spawn하려고 상시 root 권한을 갖지 않게 한다. 공개 POSIX spawn의 `RESETIDS`는 임의 principal 지정 API가 아니다.
- 일반 host는 로그인 사용자 또는 별도의 비특권 실행 principal이다. 사용자 principal host를 쓸 경우 같은 UID의 방해 가능성과 host 자체 실행물 무결성·추가 sandbox 제약을 별도로 검증해야 한다. 보호 자격·tokenstore·Docker 권위는 그 UID에 주지 않는다.
- launchd MachServices 이름은 discovery 수단이고 권한 증거가 아니다. system namespace client에는 `XPC_CONNECTION_MACH_SERVICE_PRIVILEGED`, server에는 `XPC_CONNECTION_MACH_SERVICE_LISTENER`를 사용한다. privileged flag는 root 실행이나 peer 신뢰를 부여하는 flag가 아니다.

### B. supervisor ↔ host 시작과 bootstrap

1. 새 연결 생성 → 고정 requirement 설정 성공 확인 → handler 설정 → activate → 검증된 hello/reply를 받는다. 수신 dictionary의 Security code 조회·validity와 역할 UID를 확인한다. 연결 epoch를 native 객체 안에 보관한다. 실패 시 kind 광고/claim 전에 닫는다.
2. supervisor가 기존 DB claim/attempt fence와 durable admission을 완료한다. native `startGarmin`에는 고정 operation과 허용된 데이터만 준다. command/path/args/DB URL/임의 FD 번호를 외부 요청의 권한으로 받지 않는다. XPC 요청은 item/token/generation을 의미하지만 OS 인증은 request payload 바깥의 연결 증거다.
3. host는 fixed package 검사 후 전용 bootstrap pipe와 필요한 stdio pipe를 만든다. 모든 FD를 기본 CLOEXEC로 관리하고 정확한 file actions만 열어 둔다. `posix_spawnattr_setpgroup(&attr, 0)`와 `POSIX_SPAWN_SETPGROUP | POSIX_SPAWN_CLOEXEC_DEFAULT`로 일감 자식을 새 그룹 leader로 생성한다. 고정 path의 `posix_spawn`을 쓰고 spawnp/PATH 탐색을 피한다. 반환값은 error number이므로 errno만 읽지 않는다.
4. child는 native bootstrap stub까지만 실행한다. library import/constructor/login·HTTP 전에 대기한다. child가 검증된 host의 **child 전용 별도 listener**로 hello를 보내고, host는 이 수신 메시지의 child code requirement 및 보유한 spawn PID/시작 신원/generation을 확인한다. 이 listener는 supervisor 전용 control listener와 API·requirement를 분리하고 고정 MachServices 이름 또는 인증된 경로에서 받은 endpoint를 사용한다. child가 supervisor 전용 API를 호출할 수 있게 requirement를 넓히지 않는다. child도 host의 requirement를 확인한다. FD를 상속했다는 사실만으로 임의 peer를 신뢰하지 않는다.
5. host가 child pid/pgid, 시작 identity 및 opaque launch lease를 supervisor에 반환한다. `ProcessHandle.pid`는 이 child leader PID다. supervisor의 기존 `recordSupervisedProcess` 성공 및 boot/start identity 확인이 선행한다. 서비스 PID나 가짜 로컬 proxy PID를 기록하지 않는다.
6. `bootstrap.authorize(handle, identity, item, token, signal)`가 동일 연결/launch lease/정확한 일감과 세대, 취소/hold 상태, package generation을 재검증한다. host의 one-shot state를 pending→approved로 원자 전이하고 전용 pipe에 기존 ACK byte 1을 정확히 한 번 쓰고 write end를 닫는다. supervisor의 ACK 성공과 child의 실제 수신/준비 응답은 구분한다. 중복 전송·timeout 뒤 늦은 reply·reconnect는 승인으로 처리하지 않는다. bootstrap ACK는 DB 저장 완료를 소급 증명하지 않는다.
7. child는 ACK를 읽고 FD를 닫은 후에만 다음 단계로 간다. collect에는 auth 입력 FD가 없다. D5 egress/HTTP gate와 보호 설치가 미검증이면 ACK 이후에도 library/HTTP를 열지 않는다. 현재 10초는 계획의 가정이며 operator attach/idle/total TTL과 별개다.

### C. UI ↔ broker ↔ Garmin child 인증 채널

1. broker는 검증된 supervisor 요청과 현재 attempt/admission에서만 auth session을 생성한다. UI↔broker 양방향 requirement와 message identity 확인을 끝내기 전에 입력 UI를 열지 않는다. 사용자 전달 session id는 검색용이며 그 자체가 capability가 아니다.
2. `(extension, work, attempt, run-generation, package-generation, binding-generation, child launch lease, connection epoch, session, expiry)`를 broker의 비밀 없는 상태에 묶고, one-shot 승인 권한을 서버에서 소모한다. auth-required 재인증 예외와 rate/uncertain 제한은 별도 guard로 유지한다.
3. broker/worker 간 인증된 control connection에서만 새 secret-channel FD를 제공한다. 예를 들어 broker가 socketpair 두 endpoint를 각각 인증된 UI와 worker 측에 XPC로 전송할 수 있다. 이때 broker는 승인/수명 제어자이며 raw secret logging/재직렬화를 하지 않는다. key가 필요한 기존 `FrameCodec`의 session/key도 인증된 전용 bootstrap 경로로만 공급한다. 현재 1바이트 bootstrap ACK pipe에 비밀을 섞지 말고 별도 typed capability/FD를 만든다.
4. UI와 worker가 실제 session/prompt/seq를 확인하고 credentials/MFA만 전송한다. frame length를 먼저 제한하고 partial read/write를 처리한다. worker의 하나의 client에서 MFA 3회 상한을 유지하며 입력을 stdout/stderr/JSONL에 내보내지 않는다. UI의 paste/스크롤백·진단 및 메모리 복사 문제도 남는다. Python bytearray key 초기화는 다른 immutable bytes 복사본까지 소거했다는 보장이 아니다.
5. FD를 넘겨준 뒤 broker가 자기 복제본만 close하는 것으로 **이미 전달한 descriptor를 회수할 수는 없다**. UI↔worker direct socketpair라면 broker는 취소 control message와 child/group 종료로 강제 무력화해야 한다. broker가 모든 비밀 stream을 중계하는 대안은 endpoint shutdown 통제를 얻지만 비밀 처리 신뢰 범위를 늘린다. 어느 방식을 택해도 각 endpoint가 TTL/취소 상태를 검사하고 native reaper 종료 증거 전 새 auth 승인을 막아야 한다.

## 6. FD 복제·상속과 취소 함정

- `xpc_fd_create(fd)`는 dup에 해당하므로 성공 후 원본을 close할 수 있다. XPC object와 수신 `xpc_fd_dup`/`xpc_dictionary_dup_fd`가 가진 복제본은 별도 수명이다. 수신 dup는 -1을 확인하고 성공 FD를 정확히 close한다. 같은 메시지에서 두 번 dup하면 두 권한이 생긴다. FD 번호 비교나 `xpc_equal`로 같은 권한/일회성을 증명하지 않는다.
- `xpc_dictionary_set_fd`는 편의 API다. 명확한 ownership audit를 위해 `xpc_fd_create` + dictionary value 삽입 경로도 후보로 삼을 수 있다. send 호출 완료는 수신 ACK가 아니다. message/boxed FD를 retain한 채 두면 원본 close 뒤에도 pipe EOF가 오지 않는다.
- FD 3/4 같은 숫자는 bootstrap ABI의 고정 슬롯으로만 쓴다. parent 쪽 FD가 그 숫자와 충돌하거나 source==target일 때 adddup2/addclose 순서를 검토해야 한다. 미리 안전한 번호로 복제하는 방법도 필요하다. parent write end/child read end의 반대편, stdout/stderr ends, 모든 실패 경로를 닫는다.
- `FD_CLOEXEC`는 descriptor별 flag다. dup 및 XPC 수신 FD의 CLOEXEC를 추정하지 말고 확인/설정한다. multithreaded 프로세스에서 pipe 후 fcntl 사이 다른 spawn이 끼는 race도 native spawn 직렬화 또는 플랫폼에서 지원을 확인한 원자 생성 전략으로 막아야 한다. child에 의도적으로 상속한 bootstrap FD는 즉시 소비 후 닫고 손자에 재상속하지 않는다.
- `xpc_connection_cancel`은 비동기·비선점이다. 실행 중 handler는 끝날 수 있으므로 session의 revoked 상태를 먼저 같은 serial state queue에서 확정하고 모든 후속 reply/send/ACK가 이를 재확인해야 한다. 마지막 invalid callback과 각 FD close를 idempotent하게 처리한다.
- `XPC_ERROR_CONNECTION_INTERRUPTED`는 named service가 종료됐음을 뜻하며 연결은 다시 service를 시작할 수 있다. 이전 일회 승인/FD를 자동 재전송하지 않는다. named connection이 살아 있다는 사실이 이전 child 생존/종료 증거는 아니다. anonymous endpoint는 listener 종료 시 invalid가 된다.
- cancellation 순서는 입력 UI 차단/echo 복원 → session revoke/더 이상 frame 허용 안 함 → auth/bootstrap endpoints close 또는 shutdown → 해당 launch lease에 대한 TERM → grace → 신원 재확인 후 KILL → child waitpid/reap → 그룹이 비었는지 관찰 → supervisor 정산이다. 이미 in-flight HTTP는 취소 성공으로 되돌릴 수 없어 uncertain이다.

## 7. 프로세스 그룹 수명과 원격 handle

Garmin host가 child의 parent이므로 `waitpid(child, ...)`는 host가 수행하고, supervisor에는 인증된 종료 사건을 전달해 `ProcessHandle.exited`를 resolve한다. `closeOutput()`은 출력 소비 종료일 뿐 leader 종료가 아니다. `signalGroup`은 host 서비스 그룹이 아니라 그 launch의 child group만 대상으로 한다. supervisor 자체 UID에서 다른 principal의 group에 signal 권한이 없을 수 있으므로 remote handle/inspector로 위임한다. 요청을 보내고 응답받았다는 사실과 실제 비어 있음은 구별한다.

현재 `cleanProcessGroup`는 `ProcessInspector.signalGroup`를 쓰므로 **handle의 signalGroup만 remote로 바꾸면 충분하지 않다**. `bootTime/startedAt/groupMembers/signalGroup` 전체에 맞는 native adapter 또는 보호된 inspector composition이 필요하다. 네이티브 후보는 `proc_listpids(PROC_PGRP_ONLY, pgid, ...)`와 `proc_pidinfo(pid, PROC_PIDTBSDINFO, ...)`의 `proc_bsdinfo` 시작 시각/pgid 조회다. buffer 크기/잘림/부분 반환/권한 실패는 unknown이다. 빈 성공과 조회 실패를 구분하고 재열거 race를 고려한다. 현재 TS inspector는 ps/sysctl 기반이며 초 단위 start 비교이므로 audit-token의 프로세스 인스턴스와 정확한 고해상도 identity를 보존하는 개선은 별도 구현·검증 대상이다.

host는 supervisor 단절 때 미승인 bootstrap/secret FD를 즉시 폐기하고 자신의 active child를 정리한다. host 재시작 시 메모리 launch map 유실은 종료 증거가 아니다. DB의 기존 boot/start/group identity와 독립 OS 관찰로 복구하고 unknown이면 admission을 유지한다. ordinary host의 결과 보고도 같은 규칙을 따른다.

`launchd.plist(5)`는 job 종료 시 동일 process group의 잔여 프로세스를 정리하고 `AbandonProcessGroup=true`가 이를 끈다고 명시한다. 그러나 일감 child를 새 그룹으로 분리하면 host와 다른 PGID이므로 이 자동 정리만 기대할 수 없다. explicit reaper/복구가 필요하다. 자식이 `setsid/setpgid`로 그룹을 탈출할 수 있는 실행 모델에서는 group empty가 모든 후손 종료를 증명하지 못한다. 봉인 child의 탈출 금지/지원 sandbox 제약·추적을 검증해야 하며, 악의적인 일반 extension까지 process group 하나로 완전 containment한다고 주장하지 않는다.

## 8. 파일별 최소 구현 지도 (제안, 이번에 작성하지 않음)

| 파일/새 모듈 후보 | 구현 책임 | 유지할 경계 |
|---|---|---|
| `tooling/protected-deployment/` | launchd UserName/GroupName/MachServices staging, fixed package·role requirements·설치 세대·ACL 체크 | 실제 설치/서명/엔진 실증 전 capabilities=false |
| 새 native `PeerVerifier` | 고정 role requirement parse, XPC 수신 Security dynamic code 검사, expected UID/connection epoch, CF cleanup | payload PID/session을 OS evidence로 받지 않음; private audit-token API 금지 |
| 새 native `GarminWorkerHost` | 고정 child spawn, dedicated FDs, child hello verification, one-shot bootstrap, launch lease map, reaper | DB claim/lease/finish와 Garmin library/HTTP를 host/root에서 실행하지 않음 |
| 새 native `OrdinaryWorkerHost` | 자신의 비특권 principal에서 일반 확장의 로컬 manifest/launcher 실행, kinds 광고, bounded output·exit·cancel | 보호 registry/kind·자격·tokenstore 접근 없음; 임의 command를 privileged 서비스에 전달하지 않음 |
| 새 native `Broker`/UI client | 양쪽 requirement, session 승인·TTL·prompt/seq·disconnect/취소, auth FD/key provisioning | 비밀 stdout/stderr·argv/env/설정/진단 금지 |
| `apps/cli/src/daemon/sealed-launcher.ts` | 검증된 동일 native connection 객체로 `startGarmin`; 고정 명세 재검증 | TS freeze만으로 검증 완료 처리하지 않음 |
| `apps/cli/src/daemon/sealed-garmin.ts` | static installed verifier, 보호 snapshot/admission, handle lease와 identity에 묶인 authorize 구현 연결 | 일반 manifest가 prepare/bootstrap를 선택하지 않음 |
| `apps/cli/src/daemon/ordinary-worker-host.ts` | native connection 내부에서 peer 검증; 숫자 Peer는 진단용; kinds/start를 같은 epoch에 고정 | restart/session mismatch 즉시 광고 철회, protected kind 제외를 core에서도 재확인 |
| `apps/cli/src/daemon/supervisor.ts` 또는 보호 서비스 전용 composition root | 기존 `runSupervisor` 한 개에 sealedService registry·launcher·ordinary host·native inspector 주입 | 사용자 home shim/venv/manifest를 보호 경계에서 실행하지 않음 |
| `packages/core/src/ports/process.ts` | remote child handle identity/exit 의미를 명확히 하고 auth input은 별도 typed capability로 추가할지 결정 | 호스트 PID와 child PID 혼동 금지; ACK와 비밀 FD 분리 |
| `packages/core/src/queue/supervisor.ts` | 기존 admission→identity durable record→authorize 순서 보존, cancel/late reply fence | 두 번째 supervisor/새 work claimant 만들지 않음 |
| `apps/cli/src/runtime/process-inspector.ts` 및 새 native adapter | cross-principal child/group 관찰·signal; 정확한 process-instance evidence | 오류/권한부족/단절을 none으로 변환하지 않음 |
| `extensions/garmin/src/auth_wire.py`, `auth.py`, auth flow | 승인된 전용 FD만 소비, 한 client/MFA 3회, 프레임 strict decode | OS 인증 대신 HMAC만 믿지 않음. D5 전 library import/HTTP 금지 |
| `extensions/garmin/tests/native/` | 후속 구현자가 별도 principal 양방향·wrong same-UID executable·FD 잔존·reconnect·late ACK·host crash·group cleanup fixture 확장 | 이번에는 실행하지 않음. 기존 익명 self-XPC 성공과 구별 |

## 9. 구현자에게 넘길 수락 증거와 남은 불확실성

공식 SDK로 **지원 확인**한 것은 macOS C XPC peer requirement, Security의 메시지 audit-token 기반 코드 조회, static seal validation, XPC FD duplication, POSIX spawn/group/FD 제어, launchd system-domain principal 지정이다. Foundation 대안은 macOS 13.0+, C requirement는 12.0+이며 지원하지 않는 OS에서는 기능을 광고하지 않는다.

**현재 제품에 미연결/실행 미검증**인 것은 별도 principal XPC 배포, 실제 UI 서명/사용자 승인 권한, child package 전체 봉인, native backend와 TS port 연결, auth FD/key 교환, 일회 승인과 late reply race, host 재시작 복구, 일반 host의 무권한 실행, tokenstore와 OS egress, 보호 엔진 권위 격리다. 공개 API를 찾았다는 이유로 이 항목을 통과 처리하면 안 된다.

D3/D4 후속 fixture에는 최소 (a) 승인 host/UI 정상 왕복과 wrong-role/같은 UID 비승인 코드의 양방향 거부, (b) 기록 전 ACK 0, (c) 취소/hold/timeout/reconnect 뒤 늦은 ACK·secret frame 0, (d) 다른 attempt·generation·package·binding의 ticket 재사용 거부, (e) FD 중복·손자 상속·host crash에도 group unknown 보수 유지, (f) ordinary kind가 같은 supervisor에서 비특권 host로만 가고 protected kind가 광고로 끼어들지 못함을 넣는다. 이 목록은 시험 설계이며 통과 결과가 아니다. D1/D2B/D5와 전체 T01–T28은 그대로 남는다.
