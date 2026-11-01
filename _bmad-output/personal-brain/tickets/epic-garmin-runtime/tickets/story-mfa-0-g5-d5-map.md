# 16.2 g5 D5 구현 준비 조사

작성일: 2026-11-01. 조사 성공은 구현 성공이 아니다. 빌드·시험·라이브러리 import·HTTP·설치·배포를 실행하지 않았으며 운영 DB·설정·tokenstore·계정·건강값에 접근하지 않았다. 유일한 작성물은 `/tmp/brain162g5-d5-map.md`다.

## 기준과 판정

시작 및 조사 중 재조회한 full canonical HEAD는 `8e396997c7b25c8750a2cbec1f8b550de2817138`다. **구현자가 수정 중인 checkout**이며 계획, native, TS, migration에 tracked 수정 및 untracked 파일이 있다. 순차적으로 읽은 working tree이지 HEAD 고정 tree나 원자 snapshot이 아니다. 원래 전체 검증 기준 `885ad522e5a30b820c12f984959c03c98ca28bc1`을 이 SHA로 대체하지 않는다. 종료 시점 재조회·일부 해시는 끝에 기록한다.

기능·수락의 유일한 출처는 `_bmad-output/personal-brain/tickets/epic-garmin-runtime/tickets/story-mfa-0-plan.md` 전체다. 같은 디렉터리의 `story-mfa-0-library-map.md`, `story-mfa-0-g4-matrix-map.md`, `story-mfa-0-g5-implementation.md`도 전체 확인했으나 새 요구나 실행 성공의 권위로 삼지 않았다. 아래 명령은 **향후 허가된 구현 단계용 제안**이며 이번 조사에서는 실행하지 않았다.

D5는 진행 가능한 구체적 구현 작업이 남아 있다. 현재 정상 auth/collect/probe가 pinned library와 HTTP broker로 이어지지 않는다. 이미 있는 admission·독립 latch·intent SQL·native 제출 gate는 재사용할 수 있지만, 합성 interceptor를 활성화하거나 `auth.py`의 고정 거부만 제거하는 것으로 완료되지 않는다. 보호된 OrbStack 권위·단일 supervisor·같은 UID 위협·봉인 실행물·FD 비밀·제출별 생체 승인·실제 HTTP 한 건 probe를 모두 유지해야 한다. 실제 배치가 미검증이어도 격리 fixture 구현은 계속할 수 있고 운영 auth/HTTP는 닫혀 있어야 한다.

## 현재 연결 상태와 정확한 변경 지점

| 위치 | 직접 확인한 현재 상태 | 남은 연결 |
|---|---|---|
| `extensions/garmin/src/auth.py:main` | 입력/client 생성 없이 `AUTH_PEER_UNVERIFIED`, 종료 1 | native ACK·metadata·제출 capability 확인 뒤만 봉인 adapter 진입. 평범한 Python/env 진입으로 열지 않음 |
| `src/auth_flow.py:32` | 동일 주입 객체 login/resume 최대 3회, dump 전후 verifier; 모든 일반 예외를 `AUTH_FAILED`로 투영 | pinned wrapper의 early return/profile/dump 차이를 처리하는 adapter, 제출별 native gate, protected broker evidence·완료 commit 필요. 단순 verifier의 profile 재조회는 HTTP를 추가하므로 오프라인 권한 검사와 구분 |
| `src/collect_client.py`, `src/collect.py:70` | 기본 UnavailableClient; `user_summary` 전 `attempt_valid`만 조회, legacy extension DB URL을 env에서 받음 | 비입력 보호 bootstrap·metadata, 정상 library client·보호 broker admission 연결. 기존 coverage/prepare/publish·v1 authority·attempt fence 보존. worker에 broker DB 자격을 주어 기존 함수들을 그대로 호출하는 방식은 금지 |
| `src/http_guard.py:8,50` | 선행 begin→transmit→finish, 불명은 pending; `ProtectionAdmission`은 직접 SQL 호출 | 보호 배치에서는 이 port를 broker 내부에서 실행. native `broker-store.c`에는 현재 admission 조회만 있고 start/finish·wire transport는 없음 |
| `src/http_intercept.py:10` | 전역 HTTPAdapter.send·cffi Session.request monkeypatch; stage/endpoint를 context 상수로 전달 | 요청별 봉인 분류, 모든 factory/POST·redirect hop·refresh 관찰, broker-backed facade, OS 직접 전송 차단. 현재 interceptor는 정상 운영 transport가 아님 |
| `src/tokenstore_check.py:20` | 절대 directory 경로, 자기 UID/0700, 직접 파일 자기 UID/0600, root부터 nofollow 순회 후 FD 닫음 | ACL·상위 부모 교체 권한·hardlink·파일 선택·빈 초기 경로·공개 tilde 주체·보호 principal 의미와 library 재열기까지 연결. 검사 후 닫힌 FD의 inode는 실제 dump 목적지를 고정하지 못함 |
| `native/worker-host.c:spawn_worker` | 고정 native 경로/root 부모·ACL·서명 검사, stdin null, stdout/stderr pipe, FD3 ACK/4 control/5 secret, 고정 env | 실제 Python/runtime/library 패키지 봉인 및 진입점 없음. 현재 함수에는 sandbox/egress 정책 적용도 없음. 임의 venv/스크립트 exec로 대체하지 않음 |
| `native/child-bootstrap.c:brain_child_bootstrap/read_metadata` | peer 확인 후 ACK, ACK 뒤 1회 metadata; FD3/4 CLOEXEC | pinned library import 전 차단/출력 경계 설치, FD5 수락 확인과 native→Python ABI 연결. metadata에는 비밀 불가 |
| `native/auth-channel.c:brain_channel_receive_submission` | verifier→frame read→confirm 뒤 payload 노출; FD CLOEXEC/shutdown·버퍼 지움 | Python AuthFD의 일반 receive를 바로 쓰면 이 native 제출 capability 전후 확인을 대신하지 못함. 동일 prompt/응답세대로 연결한 native binding 또는 동등 검증 필요 |
| `apps/cli/src/daemon/protected-supervisor.ts:runProtectedSupervisor` | 기존 단일 runSupervisor 사용; 보호 kind auth/collect 예약하나 launches는 auth만 | collect 비입력 경로부터 연결. 별도 queue/claim supervisor를 새로 만들지 않음 |
| `apps/cli/src/daemon/sealed-native-bridge.ts:108` | kind는 auth만, 설정 필드·target·세대 검사; frame에 zone/tokenstore/대상 | collect kind/range·canonical target/세대 검증 확장과 실제 고정 worker dispatch 필요. 현재 metadata에 collect 날짜 range 없음 |
| `apps/cli/src/daemon/sealed-garmin.ts` | 봉인 후보 path와 제한 errorCodes | D5의 허용 오류를 manifest/registry/ABI와 일치시킴. raw 라이브러리 예외를 일반 진단으로 내지 않음 |
| `tooling/protected-deployment/policy.mjs`, `preflight.py`, `README.md` | authInput/externalHttp false, 엔진·서비스·서명 미검증으로 항상 거부 | 실제 배치·egress·라이브러리 봉인 증거는 부품 밖에서 입증해야 함. 사용자 입력 ready/digest를 긍정 증거로 승격하지 않음 |

이 표의 `src/`·`native/`는 `extensions/garmin/` 아래다. `installer.py:SERVICE_POLICY`의 fixture 경로는 `/usr/libexec/second-brain/…`, 런처 후보는 `/Library/Application Support/SecondBrain/libexec/…`로 다르다. 보안 정책 모순으로 단정할 사안은 아니나 D1 패키지 registry를 기준으로 하나의 실제 경로/hash/entitlement/의존 manifest를 연결하기 전 설치 완료로 볼 수 없다.

## 고정 라이브러리 재대조

설치 공개 소스는 `S = extensions/garmin/.venv/lib/python3.14/site-packages/`, `G = S/garminconnect`, `R = S/requests`, `C = S/curl_cffi/requests`로 표기한다. lock과 각 dist-info/METADATA의 Version 텍스트는 garminconnect **0.3.20**, curl-cffi **0.17.0**, requests **2.34.2**, urllib3 **2.8.0**으로 일치한다. lock 근거는 `extensions/garmin/uv.lock:129,169,237,270`, Python은 `pyproject.toml`의 `==3.14.10`이다. 설치 파일 텍스트 일치이며 wheel 무결성·실행 중 로드 파일의 봉인을 입증하지 않는다.

1. `G/api/base.py:435–568`: `login(tokenstore)`는 오프라인 load가 아니다. 명시값이 없으면 환경 GARMINTOKENS, inline JSON, 자동 refresh, 실패 뒤 credentials fallback이 있다. 경로는 expanduser만 하고 resolve하지 않는다. return_on_mfa 분기(:517–524)는 MFA가 없어도 profile/settings·자동 dump 전에 반환한다. `(None,None)`만으로 auth 성공을 기록하면 안 된다.
2. `G/api/base.py:626–706`: socialProfile 최대 3회, settings 최대 3회가 추가된다. profileId만 사용하며 wrapper의 `isinstance(int)`가 bool을 받아도 adapter는 bool을 거부해야 한다. resume도 profile/settings를 읽지만 명시 dump는 하지 않는다. displayName/username/JWT claim을 identity로 대체하지 않는다.
3. `G/client/sso.py:352,357,412,541,613,837`의 새 requests/cffi Session, `G/client/__init__.py:188–208`의 cs/API Session, `G/client/session.py:162–171`의 module POST가 모두 별도 진입이다. cs/API 두 객체 교체만으로 전부 중개되지 않는다. cffi module post도 임시 Session을 만든다.
4. `G/client/sso.py:905–1015`: 한 MFA resume이 portal/mobile 두 verify POST를 시도한다. 첫 HTTP 427/429·JSON status-code 429도 다음 endpoint로 넘어가며 혼합 오류는 최종 AuthenticationError일 수 있다. typed 오답/만료 구분은 이 소스에 없다. broad catch가 deny를 삼켜도 broker의 sticky deny가 모든 후속 wire를 막아야 한다.
5. `G/client/session.py:128–153,205–241`: DI ticket exchange의 여러 client 후보 후 JWT_WEB GET/redirect fallback. `:255–338` refresh는 DI POST 또는 SSO GET/추가 POST이며 실패·persist 실패를 suppress한다. `G/client/transport.py:210–237`은 임박 refresh·401 refresh·재전송을 한다. API decorator retry=0만으로 모두 없어지지 않는다.
6. `G/client/tokens.py:117–185`: dumps는 DI access/refresh/client ID만, JWT_WEB/cookie/profile을 저장하지 않는다. library dump는 랜덤 sibling tmp O_EXCL/0600 후 rename, 부모 chmod 실패 suppress, load는 최종 O_NOFOLLOW다. fsync가 없고 부모 경로를 재해석한다. JWT_WEB-only login 성공은 durable 재개 성공과 다르다.
7. `G/client/tokens.py:95–115`의 exp 불명은 False다. 이를 유효 토큰으로 해석하지 않는다. offline load는 profile identity의 재증명이 아니다.

## per-wire HTTP broker 구현 단위

현 HTTP guard의 두 중요한 결손은 다음과 같다. `GuardedTransport._send`는 HTTP 429/403만 결과로 분류하고 427·JSON 429·401/auth-required는 기본 other다. classify도 2xx에서만 실행하고 반환을 success/other로 제한하므로 classify 인자만 추가해 JSON 429를 보존할 수 없다. 또한 interceptor의 stage/endpoint 상수는 로그인 안의 SSO·DI·profile·settings를 같은 endpoint로 기록하므로 endpoint별 budget·실제 요청 allowlist와 동등하지 않다.

다음 연결은 기존 계약의 구체화 제안이며 새 범용 프록시 권한을 허용하는 제안이 아니다.

- 보호 broker가 현재 OS peer·launch lease·connection epoch·work/attempt/run/package/binding·현재 취소/hold를 검증하고 고정 operation 목록으로 요청을 만든다. worker가 임의 URL·헤더·proxy·인증서·curl 옵션을 지정할 수 있는 공개 forwarding API를 만들지 않는다. path/query/date와 method를 봉인된 요청 그래프로 검증하고 redirect 목적지도 같은 경계에서 검사한다.
- HTTP payload에는 credentials·MFA·Authorization·Cookie·token 응답이 있으므로 이를 XPC dictionary 본문이나 TS metadata 제어 프레임에 직렬화하면 계획의 FD 비밀 계약을 위반한다. 검증된 FD endpoint로만 민감 request/response를 전달하고 일반 제어 IPC에는 비밀 없는 operation/tuple/ordinal만 둔다. 기존 UI→worker FD5를 일반 HTTP 채널로 암묵 재사용하지 않는다. endpoint 소유권·방향·버전·제출 capability와 HTTP operation의 결합을 명시한다.
- broker 내부의 제한 transport가 begin intent commit 성공을 확인한 뒤 실제 전송한다. 승인 결과를 worker에 주고 worker가 socket을 여는 구조는 OS egress 목적에 맞지 않는다. 결과 보호 commit 전에 response를 library에 반환하지 않아 fallback이 latch 저장보다 앞서 나가지 못하게 한다.
- 쓰기 tx는 begin·결과 각각 2초 이하이며 body 수신/HTTP/입력/sleep 동안 닫힌다. intent commit 응답 유실이면 send 0, 전송/결과 불명이면 pending 유지·새 wire 0이다. 이미 전송된 in-flight를 취소가 회수했다고 쓰지 않는다.
- `requests.HTTPAdapter.send`는 `R/adapters.py:696–707`에서 redirect=False/preload_content=False로 urllib3에 보낸다. `R/sessions.py:793–815`의 cookie/redirect와 이후 body 소비가 바깥에 있다. adapter 반환 시 단순 finish는 본문 JSON rate 판정 이전이다. broker가 제한된 응답을 수신·분류하고 쿠키/응답을 보존해 반환하는 경계를 별도 구현한다. 큰/불완전 body를 성공으로 처리하지 않는다.
- requests redirect는 Session의 hop별 send이므로 모든 mount/신규 session을 broker에 연결해야 한다. urllib3 retry는 고정 0을 확인한다. cffi `C/session.py:1066–1118` retry loop, `_request_once`의 perform 아래 auto-follow는 별개다. `C/utils.py:838–845` FOLLOWLOCATION 뒤 **:1067–1069의 curl_options가 setopt를 다시 덮는다**. 현재 interceptor의 allow_redirects=False만으로 임의 curl_options FOLLOWLOCATION 우회를 막지 못한다. 허용 옵션을 broker가 고정하고 직접 Curl/AsyncSession/새 자식/socket 경로는 OS가 차단해야 한다.
- 일반 로그인에 필요한 redirect는 broker가 hop별 새 intent·pacing·allowlist·쿠키 규칙을 적용해 재현한다. probe는 redirect·refresh·retry를 전부 금지한다. proxy/netrc/CA·trust_env·DoH/DNS/interface/CONNECT·사용자 hook으로 다른 transport가 열리지 않게 봉인한다. HTTPS CONNECT는 내부 HTTP 수를 세는 broker가 아니다.
- HTTP 상태·JSON의 rate/auth 판정을 raw 예외가 만들어지기 전에 broker에서 고정 코드로 처리한다. 427/JSON429의 기존 조사 추천을 새 정책으로 확정하지 말고 아래 결정 범위와 구분한다. 오류가 원문 문자열로 DB/log에 들어가지 않게 한다.

응답 호환은 별도 작은 단계다. status_code/ok/json/text/content/url, 예외의 response, 204, encoding, redirect history, 중복 Set-Cookie 및 중간 hop cookie를 보존해야 한다. `R/cookies.py:144–150`은 raw._original_response.msg가 없으면 조용히 cookie 추출을 생략한다. cffi의 cookies.jar와 requests jar를 dict로 평탄화하지 않는다. domain/path/secure/expires/host-only 및 삭제, 같은 이름 다중 cookie와 API session의 cookie 거부 정책(`G/client/__init__.py:205–207`)을 검증한다. cffi fingerprint를 plain requests로 치환해 동일 로그인 동작을 보존했다고 주장하지 않는다.

## 보호 migration과 현재 권한 연결

`0007_account_protection.sql`은 모델·기존 시험용 출발점이며 protected 배치의 최종 권한이 아니다. `protected-migrations/0008`은 brain_app/extension 권한을 회수하고, `0009`는 supervisor의 reserve/release와 broker의 admission/bind/start/finish/complete를 분리한다. `0010`은 supervisor 조회·입력 폐기, `0011`은 auth account target 예약 경로를 보완한다. 기존 적용 migration을 고치지 않고 필요한 변경은 새 migration으로 추가한다.

- `0009:157–201 start_external_call`: 현재 attempt·kind·zone·admission·binding 검증, pending/uncertain 차단, 기존 binding auth 예외, rate 다음날 probe만 허용, source discovery 차단, 영속 간격·work/endpoint 3 slot·day reservation이 있다.
- `0009:203–231 finish_external_call`: 현재 세대·pending 검증 후 독립 auth/rate/manual·403 counter·완료시각 갱신. probe success만 rate를 내린다. HTTP와 원자적이지 않으므로 실패 시 pending이 권위다.
- `0009:139–154 complete_verified_auth`: broker evidence 및 auth success intent·pending 없음 확인 뒤 auth만 해제한다. worker가 'profile/dump OK'라 말한 것만으로 evidence를 쓰지 않게 봉인 adapter 실행 인스턴스와 성공 과정의 provenance를 연결해야 한다. 현재 native broker-store에는 이 경로가 없다.
- `src/protection.py`의 create/bind/register/begin/finish는 테이블을 직접 쓰는 함수가 많다. worker는 protected 역할에서 권한이 없으므로 그대로 production 경로에 붙이면 안 된다. `ProtectionAdmission`의 SQL 함수 port를 broker 내부에 배치하고 identity 등록·초기 binding 생성의 제한 권한 port도 보완한다. 브로커 테이블 전권 부여로 해결하지 않는다.
- bind_admitted_profile은 generation을 바꾸며 alias·latch 합집합과 holder를 옮긴다. 이후 broker session binding·native verifier·worker 요청이 새 generation으로 일관되게 전환되어야 한다. old generation을 잠깐 허용하는 우회 없이, 응답 유실이면 닫고 기존 holder/pending을 보존한다.
- 실제 endpoint/first-call/raw snapshot 분류는 현재 SQL의 단순 text regex가 결정해 주지 않는다. 신뢰된 broker가 고정 endpoint ID와 실제 시도에 slot을 붙이고, 재시작으로 work budget을 충전하지 않는다. 요청 전 wall/monotonic 대기 뒤 admission을 다시 검사해 오래된 허가를 쓰지 않는다.

## tokenstore와 정상 auth/collect/probe 연결 순서

**저장 경계:** 공개 기본 `~/.garmin-pipeline/tokens`와 선택 `garmin.tokenstore` 의미를 유지한다. 다른 principal의 HOME으로 `~`를 재해석하거나 새 고정 폴더로 조용히 대체하지 않는다. 경로 선택을 protected target identity와 결합하고, 미지원 선택은 고정 오류로 닫는다. library만 본문 load/dump한다. FD 경로의 본문을 직접 파싱해 identity를 얻지 않는다.

현재 checker는 directory 전용인데 library는 directory/JSON file/상대 경로를 지원한다. 입력 지원 범위를 계획보다 좁혔다고 수락하지 말고 공개 경로와 내부 표현을 분리한다. 보호 principal이 쓸 수 있고 로그인 UID가 읽거나 교체할 수 없는 경계, 상위 부모·ACL·link·alias 검증이 필요하다. fchdir로 열린 안전 directory를 cwd로 고정하고 고정 상대 파일명을 library에 전달하는 방식은 private 구현 후보다. cwd/chdir/부모 rename/refresh 재열기·dump 임시파일·권한을 확인해야 하며 '/dev/fd로 파일명 열기'가 동작한다고 가정하지 않는다. 일반 홈 부모를 같은 UID가 교체할 수 있는 배치에서는 단순 선행 검사만으로 해결되지 않는다.

**정상 auth:** import 전 OS egress·raw 출력 차단 → native peer/ACK/metadata → 제출별 승인 확인 후 credentials FD 수락 → 동일 Garmin/Client 객체와 broker-backed transport → MFA 최대 3 제출 → 명시 profile 완성·bool 제외 profileId 확인 → canonical bind/CAS 및 합집합·세대 전환 → library dump와 경로/권한 후검사 → broker evidence+complete_verified_auth 성공 commit → ABI 성공·exit·실제 그룹 종료 정산. rate/manual/uncertain은 그대로다. Python immutable string과 library 내부 사본의 완전 zeroization은 주장하지 않는다.

**정상 collect:** 단일 Core의 canonical account/shared discovery admission → 비입력 sealed bootstrap → 안전한 library load 및 보호 상태 확인 → 허용된 준비 HTTP도 모두 per-wire intent 경유 → `get_user_summary(day)`를 CollectClient.user_summary에 adapter 연결 → 기존 normalize/prepare/publish. `G/api/health.py:36`의 메서드에 필요한 display/profile 상태를 확인하며 collect가 UI prompt나 credentials fallback을 열지 못하게 한다. collector의 기존 직접 DB publisher 계약을 보호 principal의 좁은 권한과 대조하되 v1/반입 행을 덮지 않는다.

**probe:** library offline load + 이미 확인된 binding/tokenstore generation + auth/manual/uncertain 없음 + 유효 세션 전제를 확인한 경우만, 기존 승인 endpoint 한 건을 broker가 보낸다. `Garmin.login`, profile/settings loader, `_run_request`의 자동 refresh를 쓰지 않는다. 세션 만료·exp 불명·준비 요청 필요면 0건으로 닫는다. durable day/rate-generation reservation과 wire budget=1을 함께 검사하고 redirect/retry/refresh를 금지한다. 401/302/timeout/5xx/불완전 데이터 뒤 보정 요청 0, 검증된 endpoint 성공 및 현재 rate-generation 결과 commit 전 해제 0. 동시 실행·restart·날짜 재변경에도 두 번째 wire 0이다. OneProbe 메모리 flag는 durable reservation의 대체물이 아니다.

## raw FD 출력과 OS egress를 각각 입증할 단계

`auth_flow._quiet_library`는 Python 객체 교체와 logging disable뿐이다. `os.write(1/2)`, C stderr, 자식 출력은 막지 못한다. `worker-host.c`는 현재 fd1/2를 pipe로 연결하고 `supervisor-bridge.c`는 이를 상위로 중계한다. Core가 나중에 진단을 버리는 것은 그 앞의 pipe·bridge·journal 비노출 증거가 아니다.

봉인 진입점에서 library import 전 fd1/2를 안전한 sink로 전환하고 ABI 출력 전용 FD를 분리·제한하는 후보를 구현한다. library에 노출된 프로세스의 임의 FD 출력은 완전 신뢰 경계가 아니므로 ABI는 고정 enum/제한 결과를 검증해 보내야 한다. 비밀 요청/응답을 ABI FD로 쓰거나 라이브러리 예외 traceback을 전달하지 않는다. 자식·손자 상속 FD를 닫고 raw canary와 crash를 실제 격리 attempt에서 검색한다. 이 작업은 UI 스크롤백·로그·DB/failures·temp·환경/argv 검증과 함께 T07로 남는다.

OS 선택을 이미 결정됐다고 쓰지 않는다. Apple 공식 자료에서 App Sandbox는 outgoing client entitlement로 연결 개시 권한을 제어하며 기존 연결의 데이터 흐름까지 per-request 권한으로 나누지 않는다. 자식 sandbox 상속에도 별도 조건이 있다. 따라서 'worker network.client 없음 + broker FD만 상속'은 조사·실증할 후보이고 'entitlement 하나면 전체 완료'가 아니다. [Apple outgoing network entitlement](https://developer.apple.com/documentation/BundleResources/Entitlements/com.apple.security.network.client), [Apple sandbox 및 자식 상속](https://developer.apple.com/library/archive/documentation/Miscellaneous/Reference/EntitlementKeyReference/Chapters/EnablingAppSandbox.html).

후속 격리 실증은 worker의 IPv4/IPv6 TCP·UDP/DNS·loopback·직접 libc/cffi Curl·requests·AsyncSession·exec 자식/손자·상속된 이미 연결된 network FD를 시도하고 **독립 수신자에서 수신 0**을 관찰한다. broker의 제한된 합성 endpoint만 허용되고 worker가 broker를 임의 proxy로 쓸 수 없는지도 검증한다. 허용 IPC/FD/tokenstore 접근과 Python/native 의존 로딩이 동시에 작동해야 한다. 지원 여부·서명·실제 principal·주입 방지·재부팅/업데이트 경계를 입증하기 전 production은 계속 false다. 방화벽 UID 규칙·proxy 환경·monkeypatch 하나를 같은 UID 방어로 인정하지 않는다. 보호 OrbStack의 관리 API/VM/context/volume/backup/inspect/exec/create 전부 거부 실증은 별도 D1/D7 의무로 유지한다.

## 오래된 근거와 실제 결정 공백 구분

| 분류 | 정확한 구절/근거 | 현재 해석 |
|---|---|---|
| 명시 결정으로 해소된 과거 공백 | 계획 §5.4 '어느 쪽이 요구인지 결정되기 전' 대 초기 감독자 결정 3 '예약된 실제 HTTP 요청 하나' | 논리 login 한 번 probe 선택지는 폐기된 과거 논의다. 현재는 실제 HTTP 1건이며 재질문하거나 완화할 필요 없음 |
| 명시 결정으로 해소된 과거 공백 | 계획 '새 사람 승인 보안 결정 공백' 대 마지막 결정 1 'credentials 최초 제출 1회 및 동일 client의 각 MFA 제출(최대 3회)에 각각 소비' | 제출별 fresh 생체 전용·callback-only assertion은 확정. 세션 attach 1회 승인이나 암호 fallback을 다시 후보로 제안하지 않음 |
| 명시 결정으로 해소된 과거 공백 | '보호된 OrbStack 엔진을 유지할지 별도 local PostgreSQL…답하지 않는다' 대 보호 배치 결정 1 '단일 권위 PostgreSQL 및 OrbStack Docker 계약을 유지' | 현재 선택은 보호 OrbStack 우선, 불명 시 닫음. 별도 PG로 암묵 전환 불가. 격리 미증명은 구현/실증 의무이며 기존 정책 재선택 요청이 아님 |
| 코드 진전으로 오래된 사실 | 계획 §5.4 '현재 garminconnect가 lock에 없으므로', 옛 Code Map의 auth 선언 없음/전송 의도 없음 | 현재 lock·manifest·0007–0011·보호 Core/native 부품 존재. 그렇다고 정상 library/egress 연결까지 존재하는 것은 아님 |
| g4 이후 진전 | matrix 지도에 native main만 있다는 한계와 말미 CORE 추기; g5 보고의 제품 runProtectedSupervisor·metadata·다중 세션 | 현재 제품 조립 port와 CORE fixture가 있다. 합성 worker/동일 UID/생체 대체·HTTP 없음은 그대로. g5 일부 보고보다 working tree가 더 진전했을 수 있음 |
| 미확정 추천 | library-map §3 'broker가 확인한 427/429 및 JSON 429 → 즉시 영속 rate 보호' 대 계획 수락 '429'·'데이터 403 세 번' 및 SQL outcome enum | HTTP 429·세 번째 데이터403의 의무는 확정. 427/JSON429를 HTTP429와 동일 latch로 볼 정확한 허용 응답 계약은 계획에 명시되지 않았다. 조사 추천을 새 수락 정책으로 확정하지 않음. raw 응답/예외를 내지 않는 typed 분류 fixture는 만들 수 있고, 운영 해제/재시도 권한은 자동 확장하지 않음 |
| 제출과 wire 결합의 구체화 필요 | 계획의 '각 MFA 제출…각각 소비'·'같은 client…최대 3회' 대 pinned sso.py:934–998의 하나 입력/두 verify POST | 계획은 입력 승인 단위와 3회 상한을 정했지만 library의 동일 코드 alternate 재송신을 별도 제출로 볼지 직접 정하지 않는다. library-map의 실제 verify POST≤3 제안은 독립 정책 권위가 아님. 가장 먼저 합성 fixture에서 두 번째 verify가 있음을 계수하고, 봉인 adapter는 새 승인 없는 비밀 재송신을 닫은 상태로 개발한다. alternate 허용이 필요하면 위 정확한 문구와 전송 그래프를 지휘자에게 제시해 결합 범위를 확인해야 함. 3회 입력=6회 wire를 조용히 수락하지 않음 |
| 성공 분류의 구체화 필요 | 계획 §5.3 'NoData/부분 성공을 임의 성공 처리' 금지 대 guard의 선택 classify·SQL probe outcome success | probe endpoint와 완전 성공 판정의 제품 구현이 없다. 기존 수집 endpoint 스키마와 검증기를 재사용할 후보를 구체화하되 단순 200으로 해제하지 않음. 기존 명세로 판정 불가능한 응답은 닫고 명확한 계약만 질문 |
| 불명 복구의 권한 공백 유지 | 계획 §5.3 uncertain은 '확정된 결과의 증거 또는 별도 명시 복구 계약', TTL/종료만 해제 금지 | 자동 복구를 이번 D5에 발명하지 않음. pending 유지·호출0 검증은 계속 가능. 신규 운영 복구 권한을 요구할 때만 별도 결정 필요 |

이 공백들은 전체 작업을 막연히 HALT하고 중단할 이유가 아니다. 정상 합성 요청·내구 intent·경로 고정·응답 호환·FD·OS 거부 검증 부품은 기존 결정 아래 계속 작성 가능하다. 운영 허용이나 새 예외를 여는 선택만 임의 확정하지 않는다.

## 작은 구현 단계와 후속 검증 명령·관찰

아래는 실행 지시가 아니라 지휘자가 checkpoint별로 배정할 수 있는 순서다. 새 runner 이름을 이미 존재하는 명령처럼 제시하지 않았다. 새 관찰은 표에 명시한 기존 runner에 추가하거나 별도 runner를 만든 뒤 이름을 기록한다. 모든 DB·홈·token은 일회용 합성 fixture만 사용한다.

| 단계 | 최소 변경/후속 명령 | 관찰과 다음 단계 조건 |
|---|---|---|
| D5-A 전송 계약 | `src/http_guard.py`, `http_intercept.py` 및 `tests/check_http_guard.py`; `PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=extensions/garmin/src extensions/garmin/.venv/bin/python extensions/garmin/tests/check_http_guard.py` | 요청별 stage/endpoint, sticky deny, JSON429·427 미확정 분류의 명시 구분, body 완료/전송불명, cffi curl_options 우회·redirect/401/alternate 각각 계수. 현재 메서드 fake 수를 실제 wire로 부르지 않음(T18/T27/T28) |
| D5-B broker DB port | `native/broker-store.*`와 제한 HTTP operation port·새 migration 필요 여부; `pnpm exec vitest run packages/postgres/test/garmin-quarantine.test.ts` 및 `BRAIN_FIXTURE_AUTHORITY=1 BRAIN_FIXTURE_NATIVE_STORE=1 BRAIN_FIXTURE_CORE=1 sh extensions/garmin/native/tests/check-composed-auth.sh` 확장 | 독립 PG 연결이 intent commit을 본 뒤만 sender 진입. worker/app는 start/finish/evidence 거부, before/after commit 유실 각각 wire0/pending. 현재 정상 native fixture에 wire 전송이 없으므로 새 관찰 추가가 필요(T19/T21/T25) |
| D5-C 저장소 pin | `tokenstore_check.py`·봉인 target resolver·library adapter; `PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=extensions/garmin/src extensions/garmin/.venv/bin/python extensions/garmin/tests/check_tokenstore.py` 및 같은 prefix로 `check_tokenstore_race.py` | 기존 race 시험은 경로 교체 취약점 재현 성공이다. 보호 구현에서는 원래 고정 target만 library read/write, replacement에는 토큰0; default/선택/tilde·권한·ACL·하드링크·refresh dump·DB실패 관찰을 추가(T03/T25/T26) |
| D5-D library facade | 모든 requests/cffi 생성 및 module POST에 동일 broker facade, cookie/redirect/fingerprint fixture; 기존 check_http_guard runner 확장 | 실제 pinned code를 import하되 합성 전송, 두 factory·module POST·cookie jar·중복 Set-Cookie·MFA state·204/JSON 실패 전부 도달. 허용되지 않은 transport는 실패 닫힘. OS 차단 증거와 구분 |
| D5-E auth 종단 | native 수락→봉인 Python bridge→auth_flow adapter→profile/dump/evidence. `sh extensions/garmin/native/tests/check-peer.sh`, 위 CORE composed 명령 및 `check_auth_flow.py` runner 확장 | ACK 전 import/constructor·입력·wire0; 동일 client·제출 승인 소비와 실제 verify POST 수 별도; dump 후 권한/DB실패면 auth 유지; raw FD/C/자식 canary0. 실제 생체/AX는 합성 callback과 별도(T07–T11/T25) |
| D5-F collect 비입력 | protected-supervisor/bridge metadata/worker dispatch, CollectClient adapter; `pnpm exec vitest run apps/cli/test/sealed-garmin.test.ts apps/cli/test/sealed-native-bridge.test.ts`와 `pnpm exec vitest run --config apps/cli/python-test/vitest.config.ts apps/cli/python-test/garmin-collect.test.ts` 확장 | auth FD·prompt 없는 collect, canonical target/range 검증, 정상 합성 summary publisher, 같은 계정 비중첩·확인된 다른 계정 병렬. env DB 자격 우회0(T12–T16/T26) |
| D5-G 단일 probe | 기존 broker DB stage probe와 전용 single-send 경로; `check_http_guard.py`, 격리 `check_protection.py` 및 `garmin-protection.test.ts`에 새 wire 관찰 추가 | valid cache=1, 만료/불명=0, 302/401/429/5xx 뒤 추가0, 동시/재시작/commit유실에서 예약 유지. 첫 성공 commit 뒤 rate만 해제(T19/T21/T23/T24/T27) |
| D5-H 실제 OS 경계 | D1 봉인 패키지·principal·network 정책 연결. 기존 `node --test tooling/protected-deployment/stage.test.mjs`와 `PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tooling/protected-deployment -p 'test_*.py' -v`는 부품 회귀용 | 새 실기 runner가 직접 socket/자식/상속 FD 거부를 독립 listener로 측정해야 함. root/별도 UID fixture skip은 통과 아님. 별도 principal·OrbStack·생체/AX·실제 OS egress가 미검증이면 production false 유지 |

`check_protection.py`는 새 일회용 격리 fixture의 실제 숫자 포트가 필수이고 현재 0007 중심 권한 시험이다. 운영 URL이나 추측 포트를 넣지 않는다. protected migrations가 적용된 broker 역할 종단은 별도 실행한다. TS cross-package는 dist 참조이므로 후속 구현자가 checkpoint에서 허가받은 `pnpm build`·`pnpm typecheck`를 먼저 수행하고 정확한 commit/diff·명령·종료코드를 묶어야 한다. 이번에는 이 명령들도 실행하지 않았다.

T19/T20은 intent commit→wire 직전 및 429/3번째403 결과 보호 commit 직후의 각각 다른 barrier가 필요하다. 실제 worker PID·boot/start/PGID를 DB identity와 대조한 뒤 SIGKILL/reap, broker의 별도 전송 누계와 pending/latch를 재시작 후 재조회한다. 파일 call marker를 실제 HTTP라고 부르지 않는다. source discovery/canonical alias 경합·revoke-all·leaderless 그룹 복구는 D4/D6와 함께 유지한다. 정리는 barrier 해제→해당 합성 자식/그룹 종료·reap→daemon abort/await→store.close→fixture cleanup이며 권한 주입은 복원한다. unknown을 정리 성공으로 간주하지 않는다.

D5 합성 종단이 갖춰져도 D6 전체 T01–T28·추가 보안 반례·독립 리뷰 및 D7을 생략하지 않는다. 실계정·운영 tokenstore·설치/이전·예약 전환은 16.9에 남는다.

## 종료 시점 기록

UTC 기록 시각: 2026-11-01T05:08:06.613826+00:00。 종료 재조회 HEAD: `8e396997c7b25c8750a2cbec1f8b550de2817138`. 각 해시는 계산 순간 바이트이며 앞선 읽기를 원자 snapshot으로 소급 고정하지 않는다.

| 저장소 상대 파일 | SHA-256 |
|---|---|
| `_bmad-output/personal-brain/tickets/epic-garmin-runtime/tickets/story-mfa-0-plan.md` | `b7f3f414b96443d8b33520578796ef4bf34e2acd5a03367a77d06e27b09bf7cd` |
| `_bmad-output/personal-brain/tickets/epic-garmin-runtime/tickets/story-mfa-0-g5-implementation.md` | `6071f14922705a7bbbad1ad085dba222fb47cef5399079f9883464fe3efc6ecb` |
| `extensions/garmin/src/http_guard.py` | `e189f8e6c0ca3196a3f8de749ebb0775eab6a52dffda363b57eda64b4ae64f64` |
| `extensions/garmin/src/http_intercept.py` | `f3dc1169c1dd4a5a94053464b7f2f774370b6e21fd37b37482f748a6d31b8ac4` |
| `extensions/garmin/native/broker-store.c` | `53fe8d0b517ad2e94b9ca8682ca24264fa591f75a43c903ee49e7ef6fc30fa50` |
| `extensions/garmin/native/worker-host.c` | `d3d2b1aa27191f67c10b9183149caf8c24f85ce7e10141ec236c7715ebe019ea` |
| `apps/cli/src/daemon/protected-supervisor.ts` | `a9b47b1be79da86f446e6ddf30b334498f7b8b9fb41e6177663e0fa56ec9e4d5` |
| `extensions/garmin/protected-migrations/0009_protected_roles.sql` | `6f78c12905aef6fbda5fb23daf2807963084b2e2962335faa9956288259589f0` |
| `extensions/garmin/uv.lock` | `b57817090f0394ad1158f64a0b8b60b7901e2f01518f2a4d4d17d91396b12f44` |
