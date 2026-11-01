# 16.2 D4 사람 승인·secure 입력 구현 지도

작성일: 2026-11-01. 조사 전용 Dispatch `ctx_5d88a619888c`, Task `task_780042d5b108`.

## 판단

**공개 API로 작성 가능한 경로가 있다.** root 소유·비가변 설치물로 봉인한 비특권 GUI가 매 승인마다 새 `LAContext`에서 생체 인증을 요구하고, 검증된 broker 연결의 고정 challenge에만 그 결과를 결합하는 경로가 우선 후보다. broker가 UI의 일반 버튼이나 XPC `true`를 신뢰하는 구조가 아니라, 변경·주입이 차단된 특정 UI 코드가 OS callback에서만 발급하는 단회 승인을 신뢰하는 구조다. 그 봉인·코드 실행 무결성·실제 AX 동작이 입증되기 전에는 production 경로를 열지 않는다.

이 조사로 **작성 가능성**과 **실기 보안 검증 완료**를 혼동하면 안 된다. 생체 일치 성공은 기기 등록 사용자의 인증이며, 그 사람이 표시된 Garmin 대상/작업의 의미를 읽고 의도적으로 승인했다는 OS의 transaction attestation은 아니다. `LAContext`는 broker에 제출할 공개 서명 증명서를 반환하지 않는다. AX/Apple Events/키 입력 자동화가 OS 생체 매치를 위조하는 것과, 정상 UI를 열어 다른 이유인 것처럼 사용자의 실제 매치를 유도하는 승인 세탁은 다른 공격이다. 뒤 공격에는 불변 대상 표시·OS reason·단회 challenge·재검증·사용자 확인 검증이 함께 필요하다.

OS 로그인 암호 fallback을 허용하는 정책과 생체 전용 정책은 보안 선택이 다르다. AX 권한이 있는 프로세스가 이미 암호를 아는 경우까지 포함하면 암호 입력의 성공만으로 신선한 물리적 사람 존재를 증명한다고 할 수 없다. 같은 UID를 암묵적으로 신뢰하거나, Touch ID가 없는 기기에서 버튼으로 낮추는 선택은 제안하지 않는다.

## 조사 범위와 현재 소스

읽은 계획: `_bmad-output/personal-brain/tickets/epic-garmin-runtime/tickets/story-mfa-0-plan.md` (특히 감독자 결정 1·3, §3.2·§3.3). 읽은 구현: `extensions/garmin/native/auth-ui.m`, `broker.[ch]`, `session.[ch]`, `xpc-peer.c`.

- `auth-ui.m`: 고정 broker code hash·UID를 요구하고 XPC hello/message를 검증한다. 9필드 target의 UUID/정수/package 길이를 확인하며 일감·run을 NSAlert에 표시한다. 선택 후 tuple을 보내고 종료한다. 이 선택은 승인 증거가 아니라고 명시하며 비밀 입력은 시작하지 않는다.
- `session.c`: session/work/attempt/launch lease/package/run/binding/package generation/connection epoch, worker·UI 신원을 결합한다. worker 검증 → recorded → attach → approve → prompt/response 순서다. production `brain_auth_approve`는 `trusted_presence==1`이어도 revoke한다. fixture만 승인을 허용한다. 이 막힘을 매크로 삭제와 bool 전송으로 해소하면 안 된다.
- `broker.c`: mutex로 전이를 직렬화한다. 승인 뒤 익명 socketpair와 frame key를 만들고 검증한 UI/worker에 FD를 한 번씩 보낸다. 취소는 session revoke와 IPC close를 하고, 이미 복제된 FD는 child/group 종료 증거가 필요함을 기록한다.
- `xpc-peer.c`: macOS 12+ peer signing requirement와 `SecCodeCreateWithXPCMessage`/`SecCodeCheckValidity`를 사용한다. UID·PID·cdhash 검증은 실행 peer의 신원을 위한 조건이다. **사람 승인 증거로 승격하지 않는다.** hash만 같다고 정품 코드의 arbitrary 인스턴스가 승인권을 가져서는 안 된다.
- 현재 target wire는 내부 `brain_auth_binding` 전체를 보내지 않는다. UI가 받은 필드와 broker가 보유한 peer/worker identity 필드를 명확히 조합해야 한다. 새 승인 protocol은 broker 발급 challenge ID/nonce·TTL·동작 범위를 추가해야 한다.

관찰은 동시 구현 중 소스의 읽기 시점 사실이며 해당 경로의 동작 검증이 아니다. 소스 수정·컴파일·빌드·시험·OS 대화상자·생체 요청·관리자 설치·운영 DB·토큰·실계정 접근은 하지 않았다.

## 공식 SDK에서 확인한 API와 OS 하한

SDK root를 `<SDK>`로 표시한다. 로컬 Xcode의 macOS 27.2 SDK 공개 헤더를 읽었다. 새 SDK에서 선언이 보이는 것과 배포 대상에서 지원되는 것은 다르므로 availability와 runtime gate를 지켜야 한다. 아래 LA 하한보다 현재 XPC 구현의 macOS 12 하한이 더 높다.

| 공개 선언·상수 | macOS 지원 | 의미/주의 |
|---|---|---|
| `LAContext` / `- (BOOL)canEvaluatePolicy:(LAPolicy)policy error:(NSError **)error` | 10.10+ | 사전 가능 여부. 성공은 인증·사람 승인 아님 |
| `- (void)evaluatePolicy:(LAPolicy)policy localizedReason:(NSString *)reason reply:(void (^)(BOOL success, NSError *error))reply` | 메서드 10.10+ | 비동기 OS policy 평가. 실제 사용 policy availability가 우선 |
| `LAPolicyDeviceOwnerAuthenticationWithBiometrics` | 10.12.2+ | 생체 필수. 미지원·미등록·lockout은 실패. fallback 버튼은 `LAErrorUserFallback`으로 실패 반환 |
| `LAPolicyDeviceOwnerAuthentication` | 10.11+ | 생체 또는 OS 사용자 암호. 생체 필수 정책과 동급이 아님 |
| `touchIDAuthenticationAllowableReuseDuration` | 10.12+ | 기본 0. lock screen의 이전 생체 잠금 해제 재사용 허용 시간. 앱의 이미 인증한 context 재사용을 단회로 만드는 기능 아님 |
| `localizedFallbackTitle` | 10.10+ | 빈 문자열로 fallback 버튼 숨김. 보안 policy 자체를 바꾸지 않음 |
| `localizedCancelTitle` | 10.12+ | 취소 표시 문자열 |
| `interactionNotAllowed`, `localizedReason` property | 10.13+ | 전자는 UI 금지 시 notInteractive 실패. OS evidence가 없는데 noninteractive 성공을 기대하는 우회 금지 |
| `- (void)invalidate` | 10.11+ | 진행 중 평가 취소(`LAErrorAppCancel`), 이후 context 재사용 불가 |
| `biometryType` | 10.13.2+ | `canEvaluatePolicy` 후 종류 확인. 신원/승인 증거 아님 |
| `evaluatedPolicyDomainState` | 10.11+, 15에서 deprecated | 등록 domain 변경 감지 자료. 성공 영수증·nonce 서명 아님 |
| `domainState` | 15+ | 새 domain 정보. 역시 session 승인 증명으로 쓰지 않음 |
| `...WithWatch` / `...WithBiometricsOrWatch` | 10.15+, 15에서 replacement deprecated | Watch 경로는 별도 승인 정책 필요 |
| `...WithCompanion` / `...WithBiometricsOrCompanion` | 15+ | companion 허용을 생체 전용에 몰래 추가하지 않음 |
| `NSSecureTextField`, `NSSecureTextFieldCell` | AppKit 기본 API(10.0 계열) | 가림·cut/copy 차단·secure field editor. 아래 AX 한계 별도 |
| `OSStatus EnableSecureEventInput(void)` / `DisableSecureEventInput(void)` / `Boolean IsSecureEventInputEnabled(void)` | 10.3+ | custom 입력의 keyboard interception 방어. not-thread-safe, 호출 수 짝맞춤. 마지막 함수는 다른 프로세스의 활성화도 true로 반환 |

출처: `<SDK>/System/Library/Frameworks/LocalAuthentication.framework/Headers/LAContext.h` (policy·서명·availability·재사용 설명), `.../AppKit.framework/Headers/NSSecureTextField.h`, `.../Carbon.framework/Frameworks/HIToolbox.framework/Headers/CarbonEventsCore.h`.

공식 문서: [LAContext](https://developer.apple.com/documentation/localauthentication/lacontext), [재사용 시간](https://developer.apple.com/documentation/localauthentication/lacontext/touchidauthenticationallowablereuseduration), [invalidate](https://developer.apple.com/documentation/localauthentication/lacontext/invalidate()), [Apple 생체 인증 예제](https://developer.apple.com/documentation/localauthentication/logging-a-user-into-your-app-with-face-id-or-touch-id). Apple 예제의 일반 로그인 fallback 권고는 이 티켓의 강한 공격자 범위를 낮추는 근거가 아니다. Touch ID에는 Face ID usage description과 같은 설명 키 요구가 없다는 예제의 플랫폼 구분도 지킨다.

## A. 새 LAContext에 기반한 sealed UI 경로

### 작성할 수 있는 순서

1. supervisor가 spawn한 정확한 worker와 recorded attempt를 확인한다. UI는 로그인한 사용자 GUI session에서 실행하되 실행물·리소스·로딩 정책은 root 봉인한다. root 권한으로 GUI 전체를 실행한다는 뜻이 아니다. broker와 UI를 양방향 OS 신원 검증하고 해당 연결 epoch에 고정한다. hardened runtime, debugging 허용 entitlement 부재, library validation·동적 로딩 제한, 쓰기 가능한 dylib/config/plugin 제거가 실제 봉인 조건이다.
2. broker는 현재 tuple 전체와 crypto-random nonce, 승인 operation(예: 해당 세션 credentials/MFA 입력 채널 개시), monotonic 만료, 승인 generation을 server-owned challenge로 만든다. 연결마다 하나의 pending challenge만 허용한다. UI가 tuple을 임의 생성하거나 UI 재실행이 기존 challenge를 이어받게 하지 않는다.
3. UI는 검증한 불변 target을 보여 준다. 현재 일감 UUID/run만으로는 사용자가 대상 설치물과 인증 단계를 이해하기 어렵다. extension·신뢰된 설치물 버전/식별·package digest의 구분 가능한 표시·작업/attempt·credentials 또는 MFA 목적을 broker 데이터에서 만든다. 공격자 제공 문자열은 length/문자 검증하고 표시 spoofing을 막는다. 표시 후 target 교체는 취소다.
4. 선택 이벤트는 **요청**만 만든다. AXPress/Apple Events/keyboard shortcut으로 요청을 만들 수 있더라도 승인 상태로 전이하지 않는다. 새 `[[LAContext alloc] init]`, reuse=0, fallback title="", 생체 전용 policy를 사용한다. `setCredential`로 OS 암호를 주입하지 않는다. context를 strong reference로 유지하고 `canEvaluatePolicy` → `evaluatePolicy`를 호출한다. OS reason에 Garmin 인증·선택한 target을 짧고 명확하게 넣고 승인 완료가 입력 채널을 연다는 뜻을 보인다.
5. reply는 private queue에서 온다. main thread의 UI와 broker state를 직접 바꾸지 말고 소유 직렬 queue로 이동한다. callback에 캡처한 immutable tuple/nonce/context generation이 현재 pending과 같고 active·not revoked·미소비인지 다시 검증한다. `success==YES && error==nil`의 해당 정책 결과만 허용한다. callback에서 `canEvaluatePolicy`를 다시 호출하면 deadlock 위험이 있으므로 금지한다.
6. 해당 context를 즉시 invalidate하고 폐기한다. UI가 서명된 receipt 또는 아래 설명의 typed assertion을 한 번 보내는 동안에도 broker는 peer·epoch·nonce·tuple·TTL·current attempt/hold/cancel을 다시 검증한다. broker lock 아래 challenge 소비와 approved 전이를 원자적으로 한다. TTL 내 같은 UI의 두 메시지도 재승인하지 않는다.
7. 이때만 FD 전달과 secure 입력 UI를 허용한다. session 전체 승인 1회와 credentials/MFA 각 입력 전 재인증은 다른 정책이다. 계획의 일회성 승인이 세션 채널 개시 1회를 뜻하는지, 각 secret 제출을 뜻하는지는 아래 결정 항목이다. MFA는 원 worker/client에서 최대 3회 유지한다.
8. 취소·timeout·sleep/lock·GUI session 변경·connection loss·attempt/generation 변경·hold·worker 종료 시 먼저 승인 세대를 폐기하고 UI context invalidate, 필드 비우기, FD close, child/group reap을 실행한다. 이미 enqueue된 success callback은 세대 비교로 버린다. invalidate가 완료된 FD 전달이나 서명을 소급 취소하지 않으므로 broker 쪽 검증이 필수다.

### bool과 신뢰 assertion의 차이

`LAContext` success는 OS framework가 **그 프로세스에 전달한 policy 결과**다. raw callback 값이나 직렬화한 bool은 broker가 독립 검증할 OS 토큰이 아니다. 그러나 정확히 봉인된 특정 UI 코드가 오직 OS success 경로에서만, broker 발급 challenge를 소비해 receipt를 만든다는 설계는 작성 가능하다. 신뢰 근거는 `same UID`가 아니라 OS가 보장하는 peer code identity와 그 코드의 실행 무결성·상태기계다. 같은 서명 UI를 공격자가 실행해도 broker가 등록한 GUI 인스턴스/epoch 밖의 승인·다른 작업 요청은 거절해야 한다.

현재 `brain_broker_approve(broker, int)`는 이 provenance를 API 형태로 표현하지 못한다. 구현자는 trusted presence adapter를 broker 내부 전용으로 두고 일반 wire parser에서 호출하지 못하게 해야 한다. 입력 구조는 최소 policy ID, challenge ID/nonce, tuple digest, UI connection epoch/instance, 단회 generation이며 **구조체가 채워졌다는 사실만으로 신뢰하지 않는다**. 일반 요청과 OS callback 출처를 코드 경로로 분리하고 peer/상태 검증을 통과해야 한다. fixture용 증거를 production adapter로 선택할 수 없게 한다.

### 더 강한 전달 증거를 원한다면: 선택적 SEP 보호 키 서명

broker가 UI assertion 이상의 검증 가능한 바이트를 원할 때는 생체 ACL로 제한한 private key로 challenge를 서명하는 확장 후보가 있다. 이는 단순 LA callback보다 큰 설계 변경이며 지금 필요한 최소 경로라고 단정하지 않는다.

공개 API: `SecAccessControlCreateWithFlags(CFAllocatorRef, CFTypeRef protection, SecAccessControlCreateFlags, CFErrorRef *)`(10.10+), `SecKeyCreateRandomKey(CFDictionaryRef, CFErrorRef *)`(10.12+), `SecKeyCreateSignature(SecKeyRef, SecKeyAlgorithm, CFDataRef, CFErrorRef *)` 및 `SecKeyVerifySignature(...)`(10.12+). `kSecAccessControlBiometryCurrentSet`(10.13.4+)와 `kSecAccessControlPrivateKeyUsage`(10.12.1+), `kSecAttrTokenIDSecureEnclave`를 조합한 P-256 키가 후보다. 새 context를 `kSecUseAuthenticationContext`로 key query에 결합하고 서명 동작의 생체 ACL을 실제로 통과시킨다. 단순 unlocked keychain/`userPresence`를 생체 전용과 동일시하지 않는다.

broker가 검증할 메시지는 canonical encoding의 domain separator + protocol/policy version + 모든 tuple 필드 + nonce + operation + expiry다. public key 등록은 보호된 설치/등록 경로에서 key ACL·접근 그룹·사용 UI를 검증해 pin해야 한다. wire에서 임의 public key와 signature를 함께 받아 신뢰하지 않는다. 서명은 해당 키가 해당 bytes에 사용됐다는 증거이며, 임의 새 키의 ACL·하드웨어 출처를 public key만으로 원격 attestation하는 것은 아니다. root 봉인·peer 검증을 여전히 유지한다. 등록 변경·키 삭제·생체 재등록 시 닫히고 명시 재등록한다.

한 context에서 여러 서명/키 사용이 가능할 수 있으므로 OS가 자동으로 한 번만 서명한다고 쓰지 않는다. one-sign/one-consume는 adapter·broker 불변식이다. 하드웨어·Keychain 접근 그룹/entitlement·macOS keychain backend·SEP 부재 동작·별도 사용자 broker와 GUI 사용자의 key 접근은 실제 환경에서 검증할 사항이다. [Apple 키 보호 문서](https://developer.apple.com/documentation/security/protecting-keys-with-the-secure-enclave), [ACL flags](https://developer.apple.com/documentation/security/secaccesscontrolcreateflags), SDK `Security.framework/Headers/{SecKey,SecAccessControl}.h` 참조.

## B. Authorization Services와 증거 전달 대조

### 공개 C API

`Security.framework/Headers/Authorization.h`, `AuthorizationDB.h`에 선언된 전통적 macOS API다(프레임워크 macOS 10.0 계열, App Sandbox에서는 지원하지 않음). 현재 native XPC 경로를 유지하면 전체 제품 최소 macOS 12+다.

```c
OSStatus AuthorizationCreate(const AuthorizationRights *rights,
 const AuthorizationEnvironment *environment, AuthorizationFlags flags,
 AuthorizationRef *authorization);
OSStatus AuthorizationCopyRights(AuthorizationRef authorization,
 const AuthorizationRights *rights, const AuthorizationEnvironment *environment,
 AuthorizationFlags flags, AuthorizationRights **authorizedRights);
OSStatus AuthorizationMakeExternalForm(AuthorizationRef authorization,
 AuthorizationExternalForm *extForm);
OSStatus AuthorizationCreateFromExternalForm(const AuthorizationExternalForm *extForm,
 AuthorizationRef *authorization);
OSStatus AuthorizationFree(AuthorizationRef authorization, AuthorizationFlags flags);
OSStatus AuthorizationFreeItemSet(AuthorizationItemSet *set);
```

`AuthorizationDB.h`에는 `kAuthorizationRuleAuthenticateAsSessionUser` = `"authenticate-session-owner"`(로그인 session owner 인증), `kAuthorizationRuleAuthenticateAsAdmin` = `"authenticate-admin"`, `kAuthorizationRuleIsAdmin` = `"is-admin"`이 있다. 마지막 것은 admin 여부 판단과 실제 재인증을 혼동하기 쉬워 presence right로 대체하지 않는다. session-owner 후보도 위임된 실제 rule 전체의 cache/timeout 동작을 검증해야 한다. `AuthorizationRightGet(const char *, CFDictionaryRef *)`와 `AuthorizationRightSet(AuthorizationRef, const char *, CFTypeRef, CFStringRef, CFBundleRef, CFStringRef)`가 정책 조회/설정 공개 경로다.

`AuthorizationExternalForm`은 SDK의 고정 크기 struct를 그대로 길이 검증한다. 문서 예시 숫자로 별도 ABI를 만들지 않는다. 포인터 `AuthorizationRef` 자체를 XPC로 넘기지 않는다. external form은 online IPC용 권한 capability이며 파일·로그·DB 저장용 인증 영수증이 아니다. byte 전달을 위한 XPC를 선택하더라도 기존 ‘XPC 본문 비밀 금지’와 충돌하지 않도록 **비밀번호/MFA와 별개의 민감한 OS 권한 증거 transport**를 명시 승인해야 한다. 보수적 경로는 검증된 전용 IPC/FD로 제한하며 token을 메시지 dump하지 않는다.

### 가능한 순서와 피해야 할 함정

1. 설치 단계에서 앱 고유 right(예: `org.secondbrain.garmin.auth.open`)의 정확한 정책을 보호 배포한다. 일반 `system.privilege.admin`을 재사용하지 않는다. `AuthorizationRightGet`로 runtime의 예상 rule을 확인하고 unknown·누락·잘못된 allow rule이면 실패한다. fallback generic rule에 맡기지 않는다. 이번 조사에서는 DB를 읽거나 right를 설치하지 않았다.
2. `shared=false`, `timeout=0`은 Apple 문서가 제시하는 재사용 억제 설정이다. 인증해야 하는 사용자 범위(현재 GUI 사용자인지 admin인지)와 mechanism을 별도로 정한다. 이것만으로 생체 필수·물리적 존재·특정 Garmin tuple 승인을 보증하지 않는다. 로그인 UID 검사와 authorizing principal 검증은 서로 다르며 admin 대리 승인을 현재 사용자 승인으로 부르면 안 된다.
3. UI가 새 ref를 만들고 externalize해 정확한 검증 peer에 전달한다. broker는 internalize하고 exact right를 **실행 직전 Security Server에서 실제로 확인**한다. `InteractionAllowed`는 필요한 경우 UI를 허용하는 옵션이지 새 UI가 반드시 나타났다는 증거가 아니다. `ExtendRights`는 필요한 권한 획득용이며 `PartialRights`는 사용하지 않는다. preauthorize 성공만으로 실행하지 않는다.
4. `timeout=0`에서 UI가 먼저 실제 인증하고 broker가 no-interaction으로 재검증하면 권한이 이미 만료되어 실패할 수 있다. 두 번 인증·예상치 못한 prompt를 피하려면 UI의 첫 단계는 ref 전달/선택으로 한정하고, 최종 right 요청을 broker가 전달받은 ref로 수행하도록 설계한다. GUI session/focus에서 이 방식이 작동하는지 실기 확인해야 한다. 대안은 broker no-interaction 검증이 실패하면 닫기이며 이를 성공으로 간주하면 안 된다. timeout을 늘려 성공시키는 것은 신선성 요구 변경이다.
5. 반환 status와 반환 exact rights를 확인한 후 broker의 immutable challenge에 단 한 번 결합한다. external form에는 앱 tuple/nonce가 자동 암호학적으로 들어 있지 않으므로 전달 동시성·교환·재전송 방어는 앱 책임이다. 완료/오류/취소에서 `AuthorizationFree(..., kAuthorizationFlagDestroyRights)`, item set free와 버퍼 폐기를 한다.
6. `AuthorizationFree`가 `LAContext.invalidate`와 같은 in-flight UI cancellation barrier라는 문서 보장은 확인하지 못했다. async 완료가 취소 뒤 돌아오는 경우 세대 검증으로 차단하고, UI가 남는지 실기 확인한다. `AuthorizationCopyRightsAsync`는 공개 async 대안이지만 취소 provenance를 보강하지 않는다.

[Apple Authorization Concepts](https://developer.apple.com/library/archive/documentation/Security/Conceptual/authorization_concepts/02authconcepts/authconcepts.html)는 rule `shared`, `timeout` 및 cache 동작을 설명한다. [external form 문서](https://developer.apple.com/documentation/security/authorizationmakeexternalform(_:_:))는 안전한 프로세스 간 전달을 요구한다. [권한 분리 지침](https://developer.apple.com/library/archive/documentation/Security/Conceptual/SecureCodingGuide/Articles/AccessControl.html)은 앱 고유 right와 helper의 재확인을 요구한다. 이 문서들은 오래된 개념 문서이므로 현재 SDK availability·실기 동작을 병행 확인해야 한다.

| 비교 | LA 새 context·생체 전용 | Authorization Services |
|---|---|---|
| OS 결과 의미 | 선택된 생체 policy 평가 성공 | right의 현재 rule에 따른 권한 결정 |
| broker 독립 OS 조회 | callback 자체는 전달 가능한 OS 토큰 아님 | external ref internalize 후 Security Server에서 right 조회 가능 |
| tuple 결합 | sealed UI callback·challenge; 선택적으로 ACL key signature | 앱의 challenge·연결·단회 소비로 결합; token이 tuple에 자동 결합 안 됨 |
| AX 자동 버튼/암호 입력 | 버튼만으로 생체 일치를 만들 수 없음. 실제 사람 유도는 남음 | rule이 cached/allow/암호 기반이면 무인 성공 가능성을 별도 차단해야 함 |
| 재사용 억제 | fresh context + reuse=0 + invalidate + broker one-use | 새 ref + exact policy + shared=false + timeout=0 + DestroyRights; 실제 요청 순서 검증 필요 |
| 배포 대가 | 생체 하드웨어/등록 필요, no fallback 기기 fail closed | nonsandboxed·보호 right 설치/정책 검증 필요; 생체 필수 아님 |

## C. Garmin password/MFA UI와 AX·automation 경계

OS 사용자 인증 UI와 Garmin secret UI는 다르다. LocalAuthentication/Authorization Services로 Garmin 원격 계정 비밀번호나 MFA를 수집하려 해서는 안 된다. OS 사용자 암호는 앱이 받지 않고 OS UI에 맡긴다. Garmin password/MFA는 승인 후 sealed AppKit UI의 **두 종류 모두 `NSSecureTextField`**에서 받는다. MFA를 일반 text field로 두지 않는다.

공식 [NSSecureTextFieldCell](https://developer.apple.com/documentation/appkit/nssecuretextfieldcell)은 가림 및 cut/copy 불가 동작을 설명한다. [TN2150](https://developer.apple.com/library/archive/technotes/tn2150/_index.html)은 표준 Cocoa secure field가 필요 시 secure event input을 관리한다고 설명한다. custom field를 만들면 `EnableSecureEventInput`/`DisableSecureEventInput`을 focus 수명에 맞춰 짝지어야 한다. 전체 앱 실행 동안 활성화하지 않는다. `IsSecureEventInputEnabled()==true`는 우리 field의 올바른 보호나 사람 입력의 증거가 아니다.

작성할 방어: secure field 값의 접근성 노출을 직접 추가하지 않기, secret 포함 accessibility label/help/value·notification·debug description 금지, pasteboard 쓰기·drag/export·undo/history·자동저장·복원·spellcheck/텍스트 학습 경로 억제, 길이 상한·고정 인코딩·단일 prompt, 취소/비활성화 시 값 비우기, 비밀은 익명 FD의 기존 인증 frame에만 기록. 일반 Apple Events/scripting dictionary로 approve/set-secret/submit 명령을 노출하지 않는다. 붙여넣기 허용 여부는 명시 정책으로 선택한다(아래).

**확정할 수 없는 보장:** standard secure field 문서만으로 모든 AX API의 read/write/press가 모든 macOS에서 차단된다거나, synthetic key/CGEventPost·Apple Events·스크린 녹화·overlay·focus stealing이 전부 막힌다고 할 수 없다. secure input 문서는 주로 keyboard interception 방어를 설명하며 물리 키 출처 증명 API가 아니다. 자체 accessibility setter를 막는 것도 시스템 전체 신뢰 입력 경로를 만드는 것과 다르다. AX trusted 여부를 조회하는 것은 현재 UI 프로세스의 권한 상태이지 공격자가 없다는 증거가 아니다. 이벤트 PID/timestamp·`isTrusted` 추정으로 승인하지 않는다.

사람이 생체 승인한 뒤 AX가 submit을 누르거나 prompt/입력 값을 바꾸는 공격이 남는다. tuple을 lock하고 승인 전에 secret 입력을 막는 것에 더해, 보수적으로 입력을 먼저 보관한 뒤 매 제출 직전 fresh biometry로 그 prompt/response generation을 승인하는 설계도 선택할 수 있다. secret 원문을 OS reason·서명 payload에 넣지 않고 필요하면 protocol 내부의 무작위 salted commitment로 response와 결합한다. 이 선택도 실제 사람이 입력 내용을 작성했다는 증명은 아니다. 더 강한 보장이 필요하면 보호된 외부 authenticator의 명시 동작/거래 확인 경로를 별도 설계해야 하며 이 조사에서 불가능 판정을 내리지 않는다.

## D. Fault matrix — 구현·실기 검증의 구분

아래는 실행한 시험 결과가 아니라 구현자가 작성하고 이후 감독하에 검증할 수락 항목이다.

| 상황 | 작성할 실패 닫힘/순서 | 실제 환경에서 남는 관찰 |
|---|---|---|
| AXPress/Return/Apple Events로 선택 | pending 요청만, LA 성공 없으면 approved=0·FD=0 | 권한 보유 자동화로 실제 무인 개시가 막히는지 |
| Touch ID 미지원/미등록/lockout | typed failure, 새 암호 fallback/버튼 승인 없음 | 지원 Mac·외장 keyboard·관리 profile별 오류 |
| 직전 Touch ID 기기 잠금 해제 | fresh context·reuse=0 | 실제 추가 생체 prompt가 발생하는지 |
| 같은 context 재사용·두 callback | context generation + nonce 1회 소비 | OS/context 재사용 동작과 앱 race |
| user/system/app cancel | 먼저 generation revoke, invalidate, late success 무시 | lock·sleep·Fast User Switching·취소 경합 |
| target/attempt/package/lease/epoch 변경 | 이전 challenge 폐기·FD 금지, 전체 tuple 재검증 | 표시 중 업데이트·재시작 공격 |
| 정품 UI를 공격자가 별도 실행 | supervisor/broker 승인 GUI instance 외 attach 거절 | 동일 cdhash 복제/재실행·GUI session 매칭 |
| UI dylib/config 교체·debug attach | protected install + hardened runtime 조건 불충족 시 닫기 | 같은 UID 코드 주입·loader 환경·debugger 거부 |
| XPC success bool/조작 receipt | wire bool 승인 금지; OS source adapter만 생성 | parser/dispatch 우회가 없는지 |
| peer disconnect·UI 종료 | revoke·context invalidate·FD close·reap 필요 | 복제 FD와 이미 queue된 message race |
| AXValue read/write·keylogger | secure field, export 경로 제거, unsupported/unknown은 닫기 | 실제 AX read/write/CGEvent tap/주입/voice control |
| 입력 후 AX submit·prompt 교체 | prompt ID/generation 고정, 선택에 따라 제출 직전 생체 | 제3자 자동 제출과 사람의 의도 경계 |
| AuthZ default/shared/cached rule | exact app right/policy 검증 실패 시 닫기 | 다른 앱 선행 승인·login cache가 우회 안 하는지 |
| AuthZ timeout=0 double-check | final OS check가 실제 승인 시점, 실패를 success로 승격 금지 | helper UI focus·이중 prompt·만료 타이밍 |
| AuthZ 토큰 재전송/바꿔치기 | 검증 peer·pending nonce·epoch·one-use·DestroyRights | OS evidence가 누구/어느 session 권한인지 |
| SEP key 변경/생체 재등록 | pinned key·policy mismatch/키 무효 시 재등록 전 닫기 | keychain backend·entitlement·무인 키 접근 거부 |
| 승인 뒤 hold/취소·attempt 회수 | 전달/secret write 직전 current state 재확인 | 이미 전달한 FD는 group 종료 없이 회수 불가 |
| TTL·wall clock 조작 | monotonic deadline, heartbeat 연장 금지 | suspend 이후 만료 처리·late callback |

## E. 남은 실제 보안 결정 — 정확한 선택지

1. **승인 정책**: (A, 우선 추천) macOS 12+·사용 가능한 Touch ID에서 fresh 생체 전용, 나머지는 AUTH_PRESENCE_UNAVAILABLE로 닫기. (B) OS 사용자 암호 fallback도 허용하되 이를 생체와 다른 assurance로 명명하고, 알려진 암호·AX 입력 위협을 수락할지 별도 결정. (C) Watch/Companion 물리 확인을 추가 지원하되 명시 policy와 실기 검증 후 활성화. B/C를 A의 숨은 fallback으로 만들지 않는다.
2. **전달 신뢰**: (A, 최소 경로) root 봉인된 특정 UI의 OS-callback-only assertion을 검증 peer/instance/nonce와 함께 신뢰. (B) ACL·SEP 보호 키의 challenge signature를 추가하고 설치 시 public key/policy pinning. (C) broker가 Authorization Services에서 exact right를 직접 재확인하는 경로. C는 사용자 권한 증거가 강하지만 생체 전용·transaction consent의 자동 대체가 아니다.
3. **승인 소비 단위**: (A) 인증 세션 채널 개시 1회로 credentials+최대 3 MFA를 허용하며 각 prompt binding을 강제. (B, AX의 승인 후 submit까지 위협이면 보수적) credentials와 각 MFA 제출마다 fresh OS 인증, prompt/response generation 결합. 현재 계획의 ‘일회성 승인’ 의미를 이 중 하나로 확정해야 한다.
4. **사용자 범위**: 현재 active GUI 로그인 사용자만 허용할지, admin 대리 승인도 허용할지. 기본 추천은 해당 GUI 사용자만이다. UID는 계정 선택·peer 제한에 쓰되 승인 source가 될 수 없다. AuthZ rule/principal이 해당 범위를 증명하지 못하면 닫는다.
5. **secret 붙여넣기**: (A) paste 허용+copy/export 금지로 password manager 사용성 유지, clipboard 노출을 별도 범위로 명시. (B) paste/drag 금지+직접 입력, 접근성/사용성 영향 검토. 어느 쪽도 실제 손 입력 증명이 아니며 생체 승인은 유지한다.
6. **활성화 게이트**: source 작성과 합성 상태 검증은 계속할 수 있다. 실제 OS 승인·AX automation·코드 봉인·GUI session/취소 실기 검증 전에는 production source가 compiled되어 있어도 config 기본 닫힘을 유지한다. 이 보고서는 D4 실기 통과·설치 승인·16.2 완료 결정을 대신하지 않는다.

## 근거와 확인 수준

- **공식 SDK 직접 확인**: `LAContext.h`, `Authorization.h`, `SecAccessControl.h`, `SecKey.h`, `CarbonEventsCore.h`의 공개 선언·주석·availability. 시스템 API를 실행하지 않았다.
- **Apple 공식 웹 확인**: 위 각 절의 직접 링크. LA callback/재사용/취소, AuthZ cache/전달/직전 재검증, secure field 및 secure event input의 명시 범위를 근거로 삼았다. Apple 기술 문서의 명시 범위를 넘어 AX 완전 차단이나 사용자의 의미 이해를 보장한다고 추론하지 않았다.
- **설계 제안/미검증**: native presence adapter·challenge wire·SEP pinning·exact AuthZ policy·각 제출 승인·root 봉인 실기 조건. 공개 API가 있으므로 구현을 막는다고 단정하지 않으며 성공 증거가 생기기 전 fail closed를 보존한다.
