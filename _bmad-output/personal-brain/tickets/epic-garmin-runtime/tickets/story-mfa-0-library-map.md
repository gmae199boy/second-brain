# 16.2 g3 D5 고정 라이브러리 구현 지도

작성일: 2026-11-01. 읽기 전용 정적 조사이며 실행·시험 통과 보고가 아니다. 계획 `_bmad-output/personal-brain/tickets/epic-garmin-runtime/tickets/story-mfa-0-plan.md`의 D5 및 감독자 결정을 기준으로 했다. import, 빌드, 시험, fake/실제 HTTP, 운영 tokenstore/DB/.env, 건강값, 실계정, 관리자 설치를 실행하거나 열지 않았다. 변경 산출물은 이 보고서 하나다. 외부 문서는 사용하지 않았다.

## 1. 근거와 결론

모든 아래 라이브러리 경로는 `S = extensions/garmin/.venv/lib/python3.14/site-packages/` 아래다. 예를 들어 `G/client/tokens.py:35`는 `S/garminconnect/client/tokens.py:35`를 뜻한다. `G=garminconnect`, `R=requests`, `C=curl_cffi/requests`, `U=urllib3`. 이 약어는 실제 파일의 줄 번호를 보존한다.

| 고정 대상 | lock 근거 | 설치 텍스트 근거 |
|---|---|---|
| garminconnect 0.3.20 | `extensions/garmin/uv.lock:169` | `S/garminconnect-0.3.20.dist-info/METADATA:3` |
| curl-cffi 0.17.0 | `extensions/garmin/uv.lock:129` | `S/curl_cffi-0.17.0.dist-info/METADATA:3` |
| requests 2.34.2 | `extensions/garmin/uv.lock:237` | `S/requests-2.34.2.dist-info/METADATA:3` |
| urllib3 2.8.0 | `extensions/garmin/uv.lock:270` | `S/urllib3-2.8.0.dist-info/METADATA:3` |

설치 metadata와 lock 버전 일치를 텍스트로 확인했다. wheel 해시 무결성이나 실행 중 버전까지 검증한 것은 아니다. 계획 뒤쪽의 과거 문장 ‘현재 garminconnect가 lock에 없다’는 현 lock에는 해당하지 않는다. 이 버전은 garth 기반이 아니라 자체 `Client`와 DI OAuth/JWT_WEB fallback이다(`G/client/__init__.py:155`). 옛 garth 방식 monkeypatch를 그대로 사용하면 요청을 놓친다.

**핵심:** `Garmin.login`/`connectapi` wrapper 하나는 충분하지 않다. 라이브러리가 생성하는 모든 requests/cffi session, module-level token POST, redirect hop을 broker 경계로 모아야 한다. 429·403 결과를 라이브러리가 전략 전환으로 삼키기 전에 broker가 durable 보호 상태를 반영하고 이후 전송을 거부해야 한다. worker에서 socket을 직접 열 수 없다는 OS 증거는 별도 D5 수락 조건이며 wrapper 계측 성공으로 대체할 수 없다.

## 2. login, resume, dump, identity 계약

| 진입점 | 실제 동작과 구현 영향 |
|---|---|
| `Garmin.login(tokenstore)` | `G/api/base.py:435` 시작. 명시 인자가 falsy이면 `GARMINTOKENS`를 읽음(:444). inline JSON은 `client.loads`, 경로는 `Path(...).expanduser()` 후 `client.load`(:455–473). 자동 선행 refresh(:479–485), 실패를 잡고 credentials login으로 fallback(:487–531), profile 실패 뒤 credentials 재로그인(:541–568)이 있다. 보호된 경로는 항상 검증된 명시 경로를 공급하고 ambient env/inline JSON이 제품 경로 설정을 대체하지 못하게 해야 한다. |
| MFA early return | `return_on_mfa=True`이며 tokens를 못 읽은 분기는 `client.login` 뒤 **MFA가 없어도 곧바로 return**(:517–524). profile/settings, `_tokenstore_path` 설정, wrapper dump, password clear를 건너뛴다. `(None,None)`만 보고 최종 auth 성공 처리하면 안 된다. 이 분기의 성공도 명시적 profile 완성과 dump/권한 검증이 필요하다. |
| 같은 client MFA | `G/client/sso.py:181`에서 pending session을 붙잡고 `needs_mfa` 반환. `:260–282`의 resume은 pending이면 전달 state 대신 기존 session을 사용한다. 오답/차단 exception은 pending을 유지한다. token 확인 실패는 clear, 성공은 MFA state clear. wrapper resume(`G/api/base.py:689–706`)은 이어서 profile/settings를 읽으나 dump·password clear를 하지 않는다. 같은 객체를 보존하고 외부 승인 세대·최대 시도·종료를 adapter가 관리해야 한다. |
| state 비밀성 | `G/client/sso.py:284–315`의 state에는 SSO cookies, login params, headers, CSRF가 들어간다. JSON 직렬화 가능하다는 이유로 snapshot/DB/로그/파일에 보내면 안 된다. 다른 객체로 복원하는 기능(:317–384)은 이 티켓의 동일 client 계약을 대신하지 않는다. |
| dump | `G/client/tokens.py:117–124`는 DI access/refresh/client ID만 serialize한다. JWT_WEB/csrf/cookies/profile identity는 저장하지 않는다. JWT_WEB-only 성공은 지속 가능한 재개 성공과 다르므로 library dump 후 다음 load 가능한 형식인지 별도 검증해야 한다. wrapper 자동 dump(:533–535, :565–567) 및 refresh persist(`G/client/session.py:281–285`)는 실패를 suppress하므로 최종 성공 전 명시적 `client.dump`와 권한 검사를 반드시 수행해야 한다. |
| identity | `G/api/base.py:626–662`: socialProfile의 `profileId`를 `isinstance(..., int)`일 때만 `profile_id`에 넣는다. displayName/fullName/username을 canonical ID로 쓰지 않는다. bool도 Python int 판정을 통과하므로 adapter는 bool 제외·정상 ID 형태를 검증해야 한다. None/불명/기존 binding 불일치는 닫힘이다. JWT payload는 서명 검증 없이 읽음(`G/client/tokens.py:62–82`); claim/client ID는 profile identity 증거가 아니다. |
| profile 부수 요청 | socialProfile 최대 3회(`G/api/base.py:638`), settings 최대 3회(:672), 각각 `client.connectapi`. `verify_login=True`도 socialProfile 한 번(`G/client/session.py:101`)을 먼저 수행한다. `_verify_token`은 401/403 외 transient/예외를 inconclusive 성공으로 간주(:95–122)하므로 이것만으로 identity·auth 성공 확정 금지. |

auth 성공은 동일 client 로그인 완료 + profile ID 검증 + library dump + 파일 권한/경로 검증 + 현재 attempt/binding generation DB 성공 commit 뒤에만 기록한다. dump 후 DB 실패면 파일 존재와 무관하게 auth latch를 유지한다. 인증 성공으로 rate/manual/uncertain latch를 지우지 않는다.

## 3. MFA 오답·만료·차단 분류의 실제 한계

`G/client/sso.py:905–1015`는 portal/ios에서 주 endpoint와 반대 endpoint를 순서대로 시도한다. 단 한 번의 `resume_login`에 코드가 두 번 전송될 수 있다(:961–969). HTTP blocked(427/429)와 JSON error `status-code == "429"`는 failures에 쌓고 다른 endpoint로 간다(:974–989). 모두 rate-limited일 때만 TooManyRequestsError(:1011), 나머지는 AuthenticationError(:1015)다. 일부 rate + 오답 조합은 최종 auth error로 보인다. **최종 exception 종류만으로 첫 429를 놓치지 말 것.**

widget은 `G/client/sso.py:749` POST 한 번 뒤 title이 `Success`가 아니면 AuthenticationError(:763–765), ticket 누락도 같은 클래스(:767–769)다. portal/ios는 JSON `responseStatus.type`/error status를 원문 failures 문자열에 합친다(:1005–1015). 이 소스에는 오답 전용·만료 전용 typed exception이나 확정적인 expired status allowlist가 없다. 원문 문자열을 저장하거나 추측한 substring으로 만료를 확정하지 않는다.

권장 adapter 분류는 (a) broker가 확인한 427/429 및 JSON 429 → 즉시 영속 rate 보호, (b) 확인된 잘못된 코드의 검증 응답 → 같은 client의 남은 승인 시도 안에서만 재입력, (c) 명확한 세션 상실/만료 또는 알 수 없는 응답 → auth-required/세션 폐기, (d) 전송 결과 불명 → uncertain이다. (b)/(c)를 세분할 공식 응답 계약이 없으면 ‘오답 또는 만료/인증 필요’ 고정 허용 코드로 보수적으로 합치고, 만료를 오답이라고 재시도하지 않는다. 시도 3회는 UI 입력 횟수와 실제 verify POST 횟수를 따로 검증해야 한다. 내부 alternate endpoint까지 허용하면 입력 3회가 POST 6회가 될 수 있으므로 그대로 수락하지 않는다. broad catch가 많은 라이브러리 안에서 거부 exception이 삼켜져도 broker의 sticky deny와 예산이 이후 전송을 계속 막아야 한다.

## 4. tokenstore 경로: resolve와 실제 재열기

**실제 `.resolve()` 호출은 이 경로에 없다.** `G/api/base.py:459–468`은 symlink 검사를 우회하지 않도록 resolve를 명시적으로 피한다. `G/client/tokens.py:35`도 expanduser만 한다. ‘resolve’는 문자열의 절대 canonicalization과 OS open 때 경로 해석을 구분해야 한다.

| 단계 | file:line | 보안/경로 의미 |
|---|---|---|
| wrapper load 경로 | `G/api/base.py:468–473` | expanduser 후 문자열 전달. 상대 경로는 상대인 채로 남는다. |
| 파일 선택 | `G/client/tokens.py:21–55` | `~username` 거부, 자신/부모 symlink 검사. POSIX root 소유 symlink는 예외 허용(:43–48). 디렉터리 또는 suffix가 `.json`이 아니면 `/garmin_tokens.json` 추가; 기존 디렉터리 이름이 `.json`이어도 디렉터리로 취급. 검사 자체가 is_dir/lstat 등에 의한 경로 재조회다. |
| 실제 읽기 | `G/client/tokens.py:178–185` | `_tokenstore_path=path` 저장 → token_file_path → `os.open(p,O_RDONLY|O_NOFOLLOW)` → fdopen/read → library loads. 마지막 component만 O_NOFOLLOW. 부모 directory FD를 고정하는 openat 방식은 아니다. |
| 실제 쓰기 | `G/client/tokens.py:137–165` | token_file_path 재호출, 부모 mkdir(0700), chmod 실패 suppress, 랜덤 sibling tmp를 O_EXCL/O_NOFOLLOW 0600으로 open, write/close, chmod 실패 suppress, tmp.replace(target). 파일 교체 원자성은 있으나 fsync 또는 directory fsync는 보이지 않는다. 전체 경로 재해석·부모 교체 경쟁은 남는다. |
| refresh 재열기 | `G/client/session.py:281–285` | 저장된 `_tokenstore_path`로 dump를 다시 호출한다. 최초 검사 뒤의 부모 경로 alias/교체·cwd 변경이 다시 영향을 준다. |
| 기타 경로 접근 | `G/api/_common.py:430–436` | load 실패 뒤 옛 garth 파일 이름 존재 여부를 조회한다. 본문 변환은 하지 않는다. |
| logout 삭제 | `G/api/base.py:980–985` | 명시/env 경로로 token_file_path 재호출 후 unlink. raw 경로를 다시 해석한다. |

라이브러리는 지정 directory/file 문자열을 지원하므로 **pin된 cwd 상대 경로는 문법상 사용 가능**하다. 예: 보호 런처가 검증·고정한 target directory를 프로세스 cwd로 설정하고 `garmin_tokens.json`을 명시적으로 공급하면 load/dump/refresh가 그 위치를 쓴다. 다만 cwd가 안전하다는 사실은 이 소스가 증명하지 않는다. `os.chdir` 금지, cwd/부모의 신뢰된 owner와 교체 불가성, 상대 경로의 `..` 이탈 금지, 최종 inode/권한, refresh 중 재열기, tmp/rename 대상을 별도 검증해야 한다. `dump("garmin_tokens.json")`는 parent `.`에 chmod를 시도하므로 cwd를 일반 공유 폴더로 두면 안 된다. 라이브러리의 chmod suppress를 성공 증거로 쓰지 않는다.

**제품 계약은 기본 `~/.garmin-pipeline/tokens`와 사용자가 고른 `garmin.tokenstore` 경로 모두 보존**한다. 상대 pin은 내부 접근 표현의 후보일 뿐 default-only, 특정 설치 고정 폴더-only, JSON 파일-only 계약으로 축소하는 근거가 아니다. 공개 선택 경로를 검증된 target/binding에 대응시키고, 그 선택의 의미를 유지한 보호 배치/접근 방식이 필요하다. 다른 principal의 HOME으로 `~`를 조용히 재해석해 다른 저장소를 쓰지 말아야 한다. 지원되지 않는 선택 경로는 명확하게 실패 닫힘으로 보고하고 임의 다른 저장소로 우회하지 않는다. owner·부모 교체 방어·같은 UID 위협·하드링크/alias 관리는 library의 symlink 확인과 0700/0600만으로 충족되지 않는다.

## 5. 내부 HTTP 요청 그래프

화살표 한 항목도 redirect 또는 하위 retry 때문에 복수 실제 HTTP가 될 수 있다.

- 새 로그인: `Garmin.login` → `Client.login`의 5전략(`G/client/sso.py:154–163`) → mobile+cffi(3 fingerprints, `G/client/constants.py:54`), mobile+requests, widget+cffi, portal+cffi(5 fingerprints, :55–61), portal+requests. 429/transport/일부 API rejection은 다음 fingerprint/전략으로 진행(`G/client/sso.py:201–241`, :409–426).
- mobile: `GET sso/mobile/sso/en_US/sign-in`(:556) → 대기 → `POST sso/mobile/api/login`(:577 → :451) → MFA 또는 ticket.
- portal: `GET sso/portal/sso/en-US/sign-in`(:845) → 대기 → `POST sso/portal/api/login`(:875 → :451) → MFA 또는 ticket.
- widget: `GET sso/sso/embed`(:631) → `GET sso/sso/signin`(:637) → `POST signin`(:654) → 조건부 email/SMS code 발송 POST `sso/sso/verifyMFA/mfaCode`(:777–818) → verify POST(:749) 또는 ticket. codeSentTo 있거나 email/sms 외에는 발송 생략(:785–791).
- MFA portal/ios: verifyCode POST 주 endpoint → 실패 시 반대 endpoint(`G/client/sso.py:934–998`) → ticket.
- ticket: `_establish_session`(`G/client/session.py:128`) → `_exchange_service_ticket` → DI client ID 최대 4개(:205, `G/client/constants.py:73–78`)의 `POST diauth/di-oauth2-service/oauth/token` → 모두 실패/예외면 JWT_WEB fallback GET service URL + ticket, redirect 허용(:134–153). 여기 broad `except Exception`은 rate 오류도 fallback으로 넘길 수 있다.
- token 확인: 전략 성공 → socialProfile(`G/client/session.py:87–122`) → wrapper profile 최대 3 HTTP + settings 최대 3 HTTP(`G/api/base.py:626–687`). verify_login=False는 별도 token 검사를 생략할 뿐 wrapper profile/retry를 없애지 않는다.
- saved token login: library load → 만료 임박이면 DI refresh → profile/settings; 실패하면 조건부 credentials login(`G/api/base.py:479–568`). 따라서 `login(tokenstore)`는 오프라인 load가 아니다.
- 모든 API: `connectapi`/request/post/put/delete/download → `_run_request`(`G/client/transport.py:149–177`, :210) → 만료 임박 refresh(:211–213) → `_api_session.request`(:229) → 401이면 refresh + body rewind 가능 시 재전송(:231–237). body가 없어도 빈 position list라 재전송 가능하다.
- refresh: DI POST(`G/client/session.py:255`) + best-effort dump; 오류를 suppress하고 return(:287–298). JWT_WEB는 SSO GET redirect(:304), cookie 못 얻으면 connect refresh POST(:321); 역시 실패 suppress. `tokens.py:95–115`는 unverified exp에서 900초 이내를 임박으로 본다. exp 불명은 False라서 ‘False=유효’는 성립하지 않는다.
- API decorator: `G/api/_common.py:501–602`가 wrapper connectapi/webproxy/download를 감싼다. 기본 retry_attempts=3이면 최대 4회 논리 시도(각 시도 안에 refresh/401 재전송 가능). 설정 0으로 꺼도 profile 루프·SSO rotation·MFA alternate·401 refresh는 남는다.

## 6. broker transport로 모을 정확한 seam

### 라이브러리 수준 커버리지

현재 constructor(`G/client/__init__.py:188–208`)는 `cs`와 `_api_session` 두 requests session을 만든다. 하지만 이 둘만 교체하면 충분하지 않다. SSO 내부의 새 `requests.Session`(:`G/client/sso.py:352`, :541, :837), 새 cffi Session(:357, :412, :613), module-level `_http_post`(`G/client/session.py:162–171`)도 모두 broker 전송으로 바꿔야 한다. module-level cffi.post는 또 임시 Session을 생성한다(`C/__init__.py:145–146`, :157–158). package 변수 HAS_CFFI=False만 설정하는 것은 인증 동작을 바꾸며 requests 직접 egress도 남긴다.

후속 구현 후보는 (1) 봉인 worker의 library adapter가 위 모든 session factory/module POST를 동일 broker-backed facade로 주입하고, (2) broker가 requests 및 cffi 각 의미를 유지한 실제 transport를 소유하는 방식이다. 공개 transport injection 생성자 인자는 현재 없다. library 소스를 바꾸지 않으려면 private seam/factory 교체 범위와 고정 버전별 커버리지를 명시해야 한다. 개별 `client.cs`/`_api_session` 대입만으로 ‘전부 통과’했다고 보고하지 않는다. 환경 proxy는 HTTP broker의 대체물이 아니다(HTTPS CONNECT 안에 요청 수/refresh가 숨는다).

### 실제 HTTP 경계

- requests: `R/sessions.py:651` → send → `adapter.send`(:784). redirect는 `resolve_redirects`의 `self.send(...allow_redirects=False)`(:292–299)로 hop별 반복된다. `HTTPAdapter.send`의 `conn.urlopen`(`R/adapters.py:696–707`) 아래 urllib3 retry가 있으므로 기본 `Retry(0,read=False)`(:205–211)를 명시 유지/검증하고 변경을 거부한다. broker-owned adapter의 send가 각 hop에 admission/pacing을 적용하기 좋은 지점이다. 표준 Session을 쓰면 HTTP와 HTTPS 양쪽 mount 및 새 session 모두 커버해야 한다.
- cffi: `C/session.py:1113` retry loop → `_request_once`(:1117) → `set_curl_options`(:919) → `c.perform`(:1043). 기본 retry=0(:242)이지만 명시 검증해야 한다. `C/utils.py:836–845`의 FOLLOWLOCATION/MAXREDIRS 때문에 **perform 한 번도 redirect 여러 HTTP가 된다**. perform wrapper나 request wrapper 한 번 계수는 불충분하다. broker 내부에서 auto-follow를 끄고 각 hop을 별도로 admission/pacing/allowlist한 뒤 필요한 redirect 의미를 재현하거나, hop-level 중개가 검증될 때까지 차단한다. probe에서는 redirect를 전부 끈다.
- 양쪽 trust_env 기본 True(`R/sessions.py:492`, `C/session.py:239`); proxy/netrc/CA 환경 영향과 cffi curl_options·DNS·DoH·interface 등 우회면을 broker의 봉인 정책에서 제어한다. worker가 임의 URL/headers/proxy를 승인 요청으로 제출할 수 있는 범용 공개 프록시가 되어서는 안 된다. API `_resolve_url`의 Garmin 하위 도메인 허용(`G/client/transport.py:179–208`)은 제한된 broker endpoint allowlist와 동일하지 않으며 redirect destination 검사도 대신하지 않는다.

라이브러리의 broad except는 broker 거부를 catch하고 다른 전략을 시도할 수 있다. denial은 broker의 attempt/binding 세대에 붙은 sticky 상태로 남기고 재전송 시도마다 거부해야 한다. UI 취소 뒤 exception 한번 던지는 것만으로 후속 egress 차단을 입증하지 않는다.

## 7. response/cookie 호환 최소 요구

SSO·DI·API에서 사용하는 response 필드는 status_code, ok, json(), text, url, content다(`G/client/sso.py:464–483`, :633–657; `G/client/session.py:220–230`; `G/client/transport.py:229–281`). API 오류는 `.response`에 response를 부착하고, 204는 library가 자체 empty JSON response로 바꾼다(:243–244). facade는 status·JSON decode 실패·bytes/text encoding·최종 URL·중복 headers/Set-Cookie·redirect history를 보존해야 한다. 서버 문자열/예외 원문을 제품 허용 오류로 그대로 노출하지 않는다.

requests adapter에 접합할 때 단순 dict response를 반환하면 Session redirect/cookie 처리가 깨진다. `R/adapters.py:375–399`의 Response 구조, raw/request/connection/headers/reason/content 소비가 필요하다. `R/sessions.py:793–815`는 raw로 jar 추출하고 redirect를 처리한다. `R/cookies.py:135–150`는 raw._original_response.msg가 없으면 쿠키 추출을 조용히 생략한다. 따라서 raw 호환 response를 만들거나 facade가 쿠키/redirect를 명시 책임지고 그 동작을 따로 검증해야 한다.

cffi는 단순 requests cookie dict가 아니다. `C/session.py:404–426`은 최종 Set-Cookie response cookies와 전체 transfer의 session cookie changes를 분리하며 중간 redirect cookie 변경도 반영한다. `.cookies.jar`는 CookieJar고 requests는 jar 자체다(`G/client/session.py:28–37`). `_mfa_client_state`/복원은 domain, path, secure, expires, domain_specified 및 jar.set_cookie를 사용(`G/client/sso.py:290–315`, :358–371). host-only·__Host-·expiry 삭제·동일 이름 다중 domain/path를 dict로 평탄화하면 안 된다. `cs.cookies.clear()`(`G/client/session.py:60`)도 지원해야 한다. API session은 모든 cookie를 거부하는 정책(`G/client/__init__.py:205–207`)으로 auth-cookie와 explicit API Cookie header 충돌을 막는다. 이를 facade에서 유지한다.

cffi TLS impersonation(`C/session.py:947`, `G/client/sso.py:412`)을 broker에서 plain requests로 임의 치환하면 현재 로그인 동작을 보존했다는 근거가 없다. fingerprint 옵션을 봉인 allowlist로 전달하거나 지원 안 될 때 닫는다. worker로 보내는 response의 민감 헤더/본문은 전용 보호 IPC 내부에서만 존재하며 로그·일반 orchestration output으로 흘리지 않는다.

## 8. 다음 날 probe: 실제 HTTP 1건을 검증할 지점

probe에 `Garmin.login`/resume/profile loader를 쓰지 않는다. 이들은 위 그래프 때문에 최소 한 번 이상의 부수 요청·자동 refresh 가능성이 있다. library의 **오프라인 `client.load`** 자체는 HTTP가 없으므로 저장 세션 복원 후보지만 identity를 재증명하지 않는다. 기존 canonical binding과 tokenstore 세대가 검증되고 auth/uncertain/manual latch가 없고 유효 세션 전제가 확인될 때만 이미 승인된 endpoint 한 건의 후보를 구성한다. 만료·불명이라 refresh가 필요하면 probe를 보내지 않는다.

`retry_attempts=0`만으로는 부족하다. probe 모드에서 `_refresh_session`의 진입 자체를 거부하고, `_run_request`의 임박 refresh(:213) 및 401 refresh(:233) 둘 다 차단한다. 더욱 명확한 후보는 library `get_api_headers`와 URL 검증을 사용하되 broker에 한 번의 승인된 전송만 맡기는 전용 단일 요청 경로다. 이 후보도 ‘library login/dump만 세션 파일을 읽고 쓴다’ 계약과 분리해서 세션 본문을 직접 읽지 않는다.

broker에서 일자/현재 rate generation의 durable reservation을 한 번 소비한 다음, 최종 wire send budget=1을 걸고 retry=0, redirect=False, refresh endpoint 금지를 강제한다. 첫 응답 401/403/429/427/5xx/redirect/NoData/불명은 명세에 맞는 실패이며 두 번째 HTTP로 보정하지 않는다. 200이라도 endpoint의 승인된 성공 의미와 현재 generation CAS commit이 확인되기 전 rate를 해제하지 않는다. 이미 전송한 뒤 DB 결과 commit 실패면 uncertain/pending이 남는다. restart·동시 probe·날짜 재변경이 두 번째 전송을 얻지 못해야 한다.

## 9. D5 후속 검증 지도 — 이번 조사에서 실행하지 않음

| 연결 지점 | 후속 격리 검증과 관찰 |
|---|---|
| 모든 session 생성/POST | requests/cffi 전략·MFA 복원·module POST를 각각 도달시키고 broker intent ID와 transport의 실제 send 수를 대조. constructor/bootstrap 전 0, 미등록 transport 시도는 OS 경계에서도 거부되는지 별도 증거 필요(T18). |
| 429/427/403 보호 | mobile 첫 GET, credential POST, DI exchange, JSON 429, MFA 첫 endpoint, profile/settings에서 주입. library fallback이 실행되더라도 보호 commit 뒤 **wire send 0**. 세 번째 데이터 403은 counter, 로그인/검증 403은 문맥별 정책으로 구분(T20/T23/T27). |
| MFA 최대 3회 | 같은 Client와 session 식별, 잘못된 코드/만료/HTML/세션 소실/혼합 rate 응답, 4번째 입력·대체 endpoint 전송 금지. UI 입력 횟수와 실제 verify POST 수를 별도 세고 canary가 예외/로그에 없는지 확인(T07/T09). |
| tokenstore | default와 선택 directory/JSON file/상대 선택·tilde 의미, root-owned symlink 예외, 부모 교체/rename, cwd 고정, symlink/hardlink/alias, dump 실패 suppress, 권한 실패, refresh 재쓰기, JWT_WEB-only dump 재개 실패, MFA 없는 early return의 profile 미완성 분기(T03/T25/T26). |
| profile identity | profileId 누락/문자열/bool/기존 binding mismatch, displayName 누락 재시도, settings 실패, 두 alias의 canonical 합집합·세대 fencing. token claim/사용자 이름으로 대체 금지(T13–T16/T26). |
| pacing | broker 최종 전송 직전 persistent next_allowed_at과 monotonic 대기, 모든 auth/refresh/redirect/fallback까지 최소 1초 및 날짜 사이 5초. 서로 다른 work의 경계·clock 역행·crash를 포함. library의 2–5/3–8/10–20초 anti-WAF delay는 전체 pacing 보장이 아니고 없애야 할 상한도 아니다(`G/client/constants.py:42–51`). endpoint별 first-call 3건의 slot은 실제 승인 전송에 연결하고 재시작으로 재충전하지 않음(T28). |
| probe | valid cache/임박/exp 불명/401/302/timeout/5xx, library가 세 요청을 시도하는 fixture에서 wire<=1; 불명 세션은 0. 일자 동시 reservation·crash·result commit 유실·이튿날 재차단 후 manual-required 유지(T19/T21/T23/T24/T27). |
| response/cookies | duplicate Set-Cookie, redirect 중간 cookie, host-only/__Host-/secure/domain/path/expiry 삭제, API cookie 거부, raw 누락의 조용한 추출 생략, JSON decode 실패·204·401 예외 response. 실제 cffi/requests facade 양쪽을 대조. |
| 비밀/네트워크 경계 | `G/client/session.py:265–268`은 refresh 실패 body 일부를 debug 로그에 싣고, transport(:250–267)는 server message를 예외에 싣는다. wrapper masking에 기대지 말고 library 출력 차단/허용 코드 투영·canary 검사. OS direct socket/DNS/자식 프로세스 우회 차단은 별도 격리/배포 검증 대상. |

선행 admission과 매 실제 HTTP 전 intent commit, 결과의 latch/uncertain 저장은 broker의 현재 attempt·cancel/hold·binding/gate 확인에 연결한다. 쓰기 transaction은 외부 HTTP나 UI 대기 중 열지 않고 2초 이하로 끝낸다. **HTTP와 PostgreSQL은 원자적이지 않다.** commit 이후 send 전 crash 및 전송 후 결과 불명은 pending/uncertain으로 남고, kill/cancel이 이미 전송된 요청을 회수했다고 주장하지 않는다. wrapper 계측은 요청 그래프 제어의 증거일 뿐 **OS egress 격리 증거가 아니다.** 실제 배포·실계정·운영 tokenstore·예약 전환은 16.9에 남는다.

## 10. 구현자에게 남기는 결정점

1. 고정 버전 private seam을 봉인 adapter에서 어떻게 모두 주입할지, requests와 cffi의 cookie/redirect/TLS fingerprint 동작을 broker가 어떻게 보존할지 구체화한다. 위 seam 하나라도 미커버면 입력·HTTP를 열지 않는다.
2. 공개 default/선택 tokenstore 계약을 유지하며 내부 cwd pin과 보호 principal 경계를 구현한다. 상대 문자열 지원과 parent/cwd 교체 방어의 입증을 구분한다.
3. MFA 오답과 만료를 typed library error로 구분할 수 없다는 한계를 보존하고, 실제 verify 전송 최대 3회 및 mixed rate의 즉시 보호를 broker에서 검증한다.
4. probe는 오프라인 세션 복원 + 기존 binding + 단일 최종 전송 예산으로 구성하며, login/refresh/redirect가 필요한 경우 무호출로 닫는다.

이 문서는 구현 위치와 후속 검증 의무를 제공한다. D5 구현 완료, OS 격리, 전체 T01–T28 통과를 선언하지 않는다.
