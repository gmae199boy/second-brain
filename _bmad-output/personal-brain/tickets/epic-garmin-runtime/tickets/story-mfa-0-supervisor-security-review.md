# 16.2 보안 escalation 독립 정적 조사

작성일: 2026-11-01. 수행 범위: 지정 계획·epic·결정 기록·architecture·네 개 구현 지도와 현재 native/Python/TS/SQL 소스를 읽고 계약과 반례를 대조했다. 소스 수정, 빌드, 시험, 하위 워커, OS 인증 호출, 운영 DB·토큰·비밀 읽기, 실제 HTTP·설치·배포는 수행하지 않았다. 이 보고서는 추천 결정과 정적 근거이며 OS 보증이나 실행 시험 통과 판정이 아니다. 모든 소스 위치는 저장소 상대 경로다.

## 1. 판정과 확정해야 할 결정

**추천: 인증 세션 연결을 허용하는 attach와 비밀 제출 권한을 분리하고, credentials 1회 및 각 MFA 제출 최대 3회에 각각 새 생체 전용 OS 승인을 소비한다.** 현재 active GUI 사용자만 허용하고 로그인 암호·Watch·admin 대리·캐시된 권한·버튼·일반 이벤트의 묵시 fallback을 금지한다. broker는 보호 배포된 특정 UI의 OS callback 전용 assertion을 검증된 실행 인스턴스와 현재 challenge에 묶어 신뢰하는 최소 경로를 채택할 수 있다. 이는 OS가 거래 내용과 의도를 직접 증명하는 경로라는 뜻이 아니며 UI 봉인·주입 방지·AX 검증이 활성화 조건이다. SEP 서명은 보호 등록·정확한 ACL·키 pinning까지 입증한 경우에만 추가 증거로 허용한다.

현재의 차단은 유지해야 한다. `extensions/garmin/native/session.c:47`은 production approve를 revoke하고, `secure-prompt.m:9`는 production 비밀 입력을 거부하며, `broker.c:50`은 전달을 거부한다. `broker-service.c:88`도 UI selection 뒤 폐기한다. `extensions/garmin/src/auth.py:5`는 AUTH_PEER_UNVERIFIED만 반환한다. 따라서 발견한 누락을 현재 운영 경로에서 이미 뚫린 취약점으로 표현하지 않는다. 이 막힘을 제거하기 전에 아래 계약·연결·실증이 모두 필요하다.

계획 `story-mfa-0-plan.md:60`–`:65`의 위협·admission 결정과 `:71`–`:74`의 보호 배치·일회성 승인·FD 결정은 유효하다(이하 계획/지도 경로 접두사는 `_bmad-output/personal-brain/tickets/epic-garmin-runtime/`, 지도·계획은 그 아래 `tickets/`). epic `epic-garmin-runtime.md:135` 및 `_bmad-output/personal-brain/decisions-by-recommendation.md:146`·`:148`도 같은 방향이다. 그러나 이들 결정은 세션 한 번인지 각 제출인지, 생체 policy인지, broker가 무슨 provenance를 믿는지 확정하지 않는다. `story-mfa-0-presence-map.md:165`–`:170`은 선택지를 제안하며 확정 결정으로 읽어서는 안 된다. 승인 범위를 좁힌다는 이유만으로 보안 관련 결정을 구현자 가정으로 채택하지 말고 감독자 결정에 명시해야 한다.

## 2. 위협 모델과 보증 한계

공격자는 다른 UID 및 로그인 사용자와 같은 UID의 미승인 프로세스다. 사용자 홈의 설정·shim·manifest·venv·PATH·URL·spool을 조작하고, 같은 signed UI를 재실행하고, 잘못된 work/attempt·old epoch를 보내며, AX·Apple Events·합성 키 입력 권한을 보유할 수 있다고 둔다. 정상 사용자를 생체 prompt로 유도하거나 승인 뒤 값을 교체하는 공격도 포함한다. worker 및 라이브러리의 잘못된 결과·우회 전송·출력 누출, 프로세스 단절·중복 callback·재시작도 검증한다. OS/관리자 침해는 계획대로 범위 밖이며, 사용자가 OS 관리자 권한을 악성 코드에 직접 주는 행위까지 막았다고 주장하지 않는다.

보호할 자산은 Garmin 비밀번호/MFA/토큰, 승인 scope, canonical identity, 보호 latch, admission/HTTP intent, DB 권위와 프로세스 종료 증거다. 생체 일치·OS peer 신원·프레임 HMAC·원격 Garmin 인증 성공은 서로 다른 사실이다. 생체 일치는 UI에 표시된 거래를 사람이 이해했다는 증거도, secure field 내용이 실제 사람 손에서 왔다는 증거도 아니다. 같은 UID의 임의 읽기·주입이 UI 런타임에 허용된다면 callback-only assertion 모델의 전제가 깨진다. 배포 서명만 확인하고 hardened runtime·debug/library injection·전체 패키지 봉인을 생략하면 수락 불가다.

신뢰 사슬은 보호 설치/업데이트 정책 → 역할별 OS 코드·principal/실행 인스턴스 → 단일 supervisor가 기록한 현재 attempt/child → broker challenge → UI의 OS callback → 한 제출 소비 → worker의 해당 응답 수락 → broker가 관찰한 실제 HTTP → profile/dump 검증 및 DB 성공 전이여야 한다. 사용자 설정·worker JSON·mtime·UI 선택·client 메서드 반환을 이 사슬의 다른 사실로 승격하지 않는다.

## 3. 추천하는 구체적 계약

### 3.1 소비 단위와 상태 전이

1. supervisor는 durable admission, 현재 work/attempt/run·binding/package 세대, launch lease, 실제 child의 boot/start/PID/group 신원을 기록한다. bootstrap ACK와 양방향 peer 검증 전에는 prompt·library constructor I/O·HTTP가 없다. UI attach 자체는 승인 소비가 아니다.
2. broker는 현재 prompt와 operation(credentials 또는 mfa), MFA ordinal, response generation, policy ID/version, GUI session/사용자, 승인된 UI instance/connection epoch, worker launch identity에 결합한 무작위 nonce challenge를 발급한다. 기존 tuple(session/work/attempt/lease/package hash 및 각 세대)도 전부 포함한다. canonical identity 미확정 시 해당 tokenstore target/보호 binding을 표시하고 계정을 아는 것처럼 표시하지 않는다.
3. secret은 봉인 UI의 secure field에만 임시 보관한다. 제출 버튼은 OS 인증 요청만 시작한다. 이 설계는 **최종 입력을 고정한 뒤 제출 직전 인증**을 권한다. 생체 평가 동안 target·prompt·입력은 잠그고 편집/전환하면 승인 challenge를 폐기한다. 기존 문서의 ‘승인 후 입력’은 제출 승인 계약과 구분해 결정문에서 순서를 정밀화한다. 사전 채널 attach나 대상 선택의 승인을 제출 승인으로 재사용하지 않는다.
4. 매 제출 fresh LAContext, reuse=0, 명시적 생체 전용 평가를 사용한다. 무지원·미등록·lockout·취소·오류는 실패다. context callback 성공 이후에도 GUI session·deadline·세대·현재 attempt/hold/cancel/package를 다시 검사한다. 이전 성공 callback이 도착해도 새 prompt를 승인하지 못한다.
5. broker는 현재 pending challenge를 원자적으로 단 한 번 소비하고, 해당 prompt/response generation·정확한 worker/connection에만 유효한 일회 제출 capability를 만든다. worker는 비밀 frame을 받았다는 이유만으로 library에 넘기지 않고, broker가 검증한 해당 capability와 현재 상태를 확인하여 소비한다. direct UI↔worker FD에서 broker가 frame을 보지 못하므로 이 승인 control handshake/worker 수락 게이트가 필수다. 비밀 원문을 broker XPC body로 우회시키지 않는다.
6. UI의 동결된 response와 승인 scope의 결합이 필요하다. 봉인 UI에서 고정 버퍼와 response generation을 바꿀 수 없게 하고 broker에 그 세대를 assertion한다. 암호학적 commitment를 추가한다면 무작위 salt와 도메인 분리를 사용하고 민감하게 취급하며 저장·로그하지 않는다. 짧은 MFA의 단순 hash를 공개 증거로 남기지 않는다. broker가 payload를 보지 않는 모델에서 이 결합은 여전히 UI 무결성을 신뢰한다.
7. credentials는 최초 1회, MFA는 동일 client에서 최대 3회 각각 독립 승인한다. UI prompt 수, 승인 소비 수, 실제 verify HTTP 수를 따로 제한한다. library alternate endpoint·retry가 1회 입력을 여러 verify 전송으로 확대할 수 없도록 D5 gate에서 막는다. 틀린 MFA 이후 새 prompt/nonce/response generation/context를 요구한다. 재접속·새 UI 실행으로 MFA 예산이 초기화되지 않는다.
8. consume 후 전송 실패/응답 유실은 이전 권한 재전송으로 복구하지 않는다. pending/uncertain으로 남기고 종료·현재 상태를 확인한 뒤 새로운 명시 승인 세대가 필요하다. HTTP intent는 별도 선행 commit이며 비밀 제출 승인이 모든 후속 HTTP를 포괄하는 범용 권한은 아니다.

추천 challenge 신선성은 세션 총 5분과 구분해 제출당 최대 30초로 명시하고 실기 사용성에서 재검토한다. 이는 조사자의 추천값이며 현재 수락된 상수가 아니다. 총 세션 TTL 5분도 계획의 미검증 가정이다. 모든 deadline은 monotonic 기준으로 처리하고 sleep/wake·lock·GUI 사용자 전환은 만료와 무관하게 revoke한다. restart 시 기존 monotonic 수치/메모리 승인을 복원하지 않고 새 broker boot epoch를 사용한다.

### 3.2 신뢰할 policy와 증거 provenance

**우선 경로: 봉인 UI callback-only assertion.** broker는 보호 설치 registry의 고정 UI code requirement/hash·package generation을 사용하며 요청자가 이를 고르게 하지 않는다. 승인 UI는 supervisor/broker가 발급한 GUI launch ticket과 OS에서 검증한 연결 인스턴스로 제한한다. XPC `approved:true`, `brain_local_presence` struct, 이벤트 PID·timestamp, AX permission, NSSecureTextField 상태는 증거가 아니다. 일반 event handler가 assertion을 만들 수 없고, 오직 fresh 생체 callback의 현재 generation 성공 분기에서 생성해야 한다. wire assertion은 OS 토큰이 아닌 **검증된 UI가 내는 앱 assertion**이라고 이름 붙이고 broker가 독립 OS 생체 검증을 했다고 쓰지 않는다.

`presence-gate.m:33`–`:46`의 정책은 이 추천과 맞는 부분 구현이다. `:51`–`:59`의 generation/만료/현재 console user 재검사도 재사용할 수 있다. 그러나 `presence-gate.h:3`–`:4` 자체가 이 struct는 독립 검증 가능한 OS 증거가 아니라고 명시한다. 현재 callback은 challenge digest·generation뿐이며 broker verifier와 연결된 신뢰 protocol이 아니다. policy version, 승인 GUI session·instance, 응답 세대의 결합을 추가해야 한다. sleep/session/lock notification은 보조 방어이며 공격자가 안 보냈다는 사실을 presence 증거로 사용하지 않는다.

**추가 경로: 보호 등록된 생체 ACL key 서명.** 설치/등록 시 누가 어떤 OS 사용자와 GUI session에서 키를 생성했는지, 정확한 생체 전용 private-key-use ACL(생체 등록 집합 변경 시 무효화 정책 포함), 접근 주체/entitlement, export 금지, 공개키와 policy fingerprint를 보호 broker registry에 pinning한 증거가 필요하다. 키 교체·재등록은 별도 보호 절차이고 사용자 홈의 같은 태그 키로 자동 갱신하지 않는다. broker는 공개키·policy generation을 서버에서 고르고 서명만 검증한다. LA success 뒤 unconstrained SEP key로 서명하는 방식은 생체 ACL 증명이 아니다. ACL 서명이 있더라도 의미 있는 대상 표시와 UI 봉인은 생략할 수 없다.

**Authorization Services 대안**은 exact app right·정확한 보호 rule·재사용/timeout·승인 사용자·실행 직전 broker 검증을 별도 결정하는 경우만 허용한다. 생체 전용 계약의 fallback이 아니다. 지도 `story-mfa-0-presence-map.md:102`–`:113`의 cached right/timeout=0 재검증 및 external form 한계를 수락 문서에 남긴다. 이번 조사는 웹/SDK를 새로 검증하지 않았으며 지도에 기록된 API 가능성을 재확인된 운영 보증으로 승격하지 않았다.

## 4. 실제 코드 기반 반례와 정적 판정

| 반례 | 코드 근거 | 정적 결론 / 필요한 실패 닫힘 |
|---|---|---|
| 세션 첫 생체 한 번 뒤 AX가 MFA 3번을 무인 제출 | `session.c:56`–`:65`는 response 때 approved=0으로 돌린다. 반면 transport `auth-channel.c:53`–`:63`은 HMAC·seq·prompt만 확인한다 | 상태 머신은 제출별 소비 후보이나 transport와 연결되지 않았다. frame 수락 직전 승인 capability가 없으면 입력·HTTP 0. HMAC 통과만으로 approve 금지 |
| credentials prompt를 여러 번 열어 password 전송 반복 | `session.c:58`은 전체 prompt 64·MFA 3만 제한하고 credentials 횟수/credentials→MFA 순서를 제한하지 않는다 | 최초 credentials 1회/명시된 phase 순서 필요. 새 비MFA prompt로 제한 회피하는 반례 추가 |
| 합성 bool/receipt로 사람 승인 위조 | `broker.c:28`, `session.c:47`의 API는 int trusted_presence; `presence-gate.h:3`은 평범한 struct | production 거부가 현재 보호선이다. bool을 wire로 받아 이 매크로 장벽을 제거하면 위조 가능. OS source adapter 전용 경로로 교체 |
| 생체 없는 키로도 유효 서명 | `presence.c:24`–`:29`는 전달된 SecKeyRef의 서명만 검사. `native/tests/presence-signature.c:5`–`:15`는 일반 EC 랜덤 키로 성공하도록 작성됨 | 시험 소스 자체가 ‘서명 유효’와 ‘생체 수행’의 차이를 보여준다. 실행하지 않았다. pinned key/등록/ACL 없으면 승인 불가 |
| 같은 태그의 SEP key가 있다는 이유로 생체 승인 처리 | `presence-ui.m:19`–`:31`은 태그 검색·SEP token 속성만 검사; fresh context는 만들지만 명시 biometry 평가/ACL 검증은 없음 | SEP 소속·fallback title·reuse=0만으로 생체 필수 증명 불가. unconfigured 거부는 유지하고 보호 등록 증거 전 signer 비활성 |
| 승인 뒤 응답 바꿔치기 / 다른 정책으로 받은 승인 | `presence.c:18`–`:21`은 operation/prompt·binding을 넣지만 response generation/commitment·policy ID·GUI session/boot identity 없음 | 현재 message를 범용 ‘생체 승인’ 토큰으로 채택 불가. immutable response와 policy 및 실행 epoch 결합 필요 |
| 정품 signed UI를 공격자가 별도 실행해 먼저 접속 | `xpc-peer.c:24`는 service PID=0, `:40`은 첫 유효 peer PID pin; `broker-service.c:94`–`:99`는 첫 slot 점유; `session.c:43`은 UI uid/hash만 비교 | 코드 신원 검증은 구현됐지만 supervisor가 의도한 UI instance인지는 별개. GUI launch ticket/instance 검증 없으면 거부. 현재는 selection 뒤 revoke하여 실제 승인 없음 |
| UI 선택 자동화로 승인 세탁 | `auth-ui.m:52`–`:65`는 NSAlert 선택을 보내며 표시 정보는 package prefix/work/attempt/run 중심 | 현재 선택은 승인 아님(`:66`). 승인 UI에는 사람이 식별할 Garmin 대상·미확정 tokenstore·제출 종류·MFA 순번을 보호 원천에서 표시해야 함. 실제 생체를 다른 작업인 척 유도하는 공격은 남음 |
| prompt frame을 직접 보내 승인 로직 생략 | `secure-prompt.m:28`–`:33` fixture 경로는 버튼 후 곧바로 kind=3 send. `broker.c:30` response 함수는 독립이며 현재 service dispatcher에 승인/응답 경로 없음(`broker-service.c:77`–`:92`) | production return 0 제거만으로 연결 완료가 아니다. submit→fresh callback→broker consume→worker 수락 순서를 강제해야 함 |
| 서명 replay 또는 verify 실패 뒤 재시도 | `presence.c:25`는 verify 성공 여부와 무관하게 consumed=1; `session.c:59` prompt 중복 거부, `:63` seq 일치 요구 | 메모리 내 단회성 방어는 존재. challenge 발급 API가 구조체를 덮어쓰며 서버 registry/현재 승인 상태를 직접 조회하지 않으므로 호출자 결합이 필수. 재시작·복제 객체 replay까지 방지했다고 주장 불가 |
| 취소 뒤 복제 FD로 전송 지속 | `broker.c:10`–`:15`는 needs_reap 및 XPC close; `:40`–`:45`는 direct socketpair 생성 | 이미 UI/worker에 복제한 FD를 회수하지 못함을 코드도 명시. worker/UI endpoint revoke·shutdown 및 group 종료 확인 전 admission/새 승인 해제 금지 |
| FD 상속 기능이 있으니 운영 경로 연결됐다고 판정 | `worker-host.c:92`–`:100`에 FD5 dup 부품은 있으나 실제 service start `worker-service.c:107`은 채널 없는 brain_spawn_worker 사용 | broker→host→spawn 상속→UI descriptor 전체 연결 미완료. worker에 XPC로 나중에 전달한 fixture는 spawn 상속 증거 아님 |
| recorded 메시지만으로 durable DB 저장을 입증 | `broker-service.c:84`–`:85`는 authenticated supervisor의 recorded 이벤트로 flag 설정; `worker-host.c:135`–`:143`도 recorded 메모리 flag 뒤 ACK | 신뢰된 supervisor의 선행 commit 및 현재 attempt 확인을 연결해야 함. native API가 DB commit을 독립 증명하지 않는다. DB 응답 유실이면 ACK/입력 금지 |
| host 재시작으로 이전 attempt 재실행 | `worker-service.c:36`–`:49` replay ledger는 static memory; `:62`–`:69` 종료를 unknown 처리 | 메모리 ledger는 restart 방어가 아니다. durable admission·boot/start/group 확인과 복구 fence 필요. 연락 단절·TTL·leader exit만으로 새 launch 허용 금지 |
| DB 성공 행을 OS 승인 증거로 오인 | `protected-migrations/0009_protected_roles.sql:139`–`:153`은 auth_success_evidence 존재+auth HTTP 성공을 검사. `:248`은 broker에 evidence 직접 INSERT 허용 | broker role만 쓸 수 있다는 조건은 진짜 provenance 생성 경로를 대체하지 않는다. OS 승인 evidence와 원격 login/dump 성공 evidence를 구별하고 현재 세션/패키지/child 및 제출 승인 이력을 결합해야 함 |
| 기존 daemon 실행을 보호 서비스로 착각 | `apps/cli/src/daemon/supervisor.ts:35`–`:43`, `:72`–`:98`, `:115`는 홈 manifest/.env/venv·직접 DB 기반이며 sealedService composition이 아님 | SealedGarminPorts 후보(`sealed-garmin.ts:11`–`:35`)와 운영 composition은 별개. D2B·보호 principal·DB/엔진 격리 완료 전 native 서명 성공으로 입력/HTTP 열지 않음 |

## 5. 프로세스·DB·HTTP 복구의 실패 닫힘

`worker-host.c:84`의 worker principal/봉인 경로·코드 검사, `:97`–`:101`의 고정 argv/env·CLOEXEC spawn, `child-bootstrap.c:12`–`:23`의 peer/ACK 확인은 재사용할 부품이다. 그러나 interpreter만 signed이고 script/library가 사용자 쓰기 가능하면 봉인이 아니다. tokenstore 선택 경로를 유지하면서 실제 파일 owner·symlink·ACL·교체·권한 및 worker 외 읽기를 막는 배포 증거가 필요하다.

정상 상태의 필수 순서는 admission commit → spawn/OS identity record commit → bootstrap ACK → bound UI/prompt → 제출별 승인 소비 → worker secret 수락 → 각 실제 HTTP intent commit → broker 전송 관찰 → 결과 저장이다. 승인과 DB·HTTP를 원자 처리한다고 쓰지 않는다. 승인 소모 후 전송 실패는 재승인 요구, 전송 후 commit 실패는 pending/uncertain이며 TTL·token mtime·날짜 변경·새 UI로 해제할 수 없다. 취소가 commit된 뒤 다음 전송을 막되 이미 나간 HTTP를 ‘없었다’고 기록하지 않는다.

`protected-migrations/0009_protected_roles.sql:31`–`:42`는 현재 admission/hold/cancel 검사를, `:174`–`:179`는 uncertain/미결 intent와 독립 latch 차단을, `:147`–`:153`는 auth 성공 시 auth latch만 해제하는 후보를 제공한다. `:77`은 pending intent가 있으면 admission release를 거부한다. 이 SQL을 실제 봉인 broker가 유일하게 호출하고 결과를 직접 관찰하도록 연결해야 한다. worker의 임의 `success` body를 broker가 그대로 옮겨 적으면 권한 분리만으로 보호되지 않는다.

`worker-service.c:78`–`:81`은 leader reap 및 group empty를 함께 요구하며, `worker-host.c:164`–`:176`은 관찰 불명을 -1로 둔다. 이 방향을 유지한다. host/broker crash나 연결 재수립은 이전 FD·승인·child 소멸 증거가 아니다. boot/start identity와 그룹 생존을 별도 확인하고 unknown이면 admission·uncertain을 유지한다. ledger/승인 cache 손실을 정리 성공으로 승격하지 않는다. 종료한 leader 뒤 손자가 FD를 유지하거나 다른 그룹으로 이탈하는 경우도 별도 검증하며 단순 close/EOF로 성공 정산하지 않는다.

보호 DB/엔진은 여전히 전체 신뢰 사슬의 전제다. architecture `architecture-brain-v1-slice-1.md:209`, `:319`, `:437`의 기존 사용자 .env/OrbStack 운영과 보호 배치의 이관 경계를 문서화해야 한다(전체 경로 `_bmad-output/personal-brain/architecture-brain-v1-slice-1/`). 로그인 사용자에게 DB 관리자 비밀이나 Docker/VM/volume/backup 경로가 남으면 승인·latch 증거를 우회 SQL로 위조할 수 있다. 현재 quarantine SQL `protected-migrations/0008_protection_quarantine.sql:18`–`:31`은 일반 app/ext 접근을 회수하지만 엔진 관리자 경로를 막았다는 증거는 아니다. `story-mfa-0-api-map.md:7`–`:9`, `story-mfa-0-native-map.md:178`–`:199`, `story-mfa-0-library-map.md:18`·`:38`–`:40`·`:108`의 API/FD/retry 한계를 각각 별도 수락해야 한다.

## 6. 구현 누락과 독립 검증 요구

다음은 실행할 검증 설계이며 이번 조사에서 수행하거나 통과한 결과가 아니다. 기존 T01–T28을 줄이지 않고 추가한다.

| 검증 묶음 | 반드시 관찰할 결과 | 독립성/실증 수준 |
|---|---|---|
| phase/소비/replay | credentials 중복, MFA ordinal 초과, 이전 nonce/response generation/다른 operation·attempt·package·epoch 재사용, 두 동시 성공 callback 모두 주입. 한 정확한 제출만 소비되고 두 번째 입력/HTTP 0 | 상태 머신 fixture와 실제 supervisor/broker/worker end-to-end를 둘 다 확인 |
| policy 신선성 | 직전 잠금 해제·같은 context·Touch ID 미등록/lockout·생체 재등록·암호 fallback·Watch/admin 우회 | 지원하는 실제 Mac/GUI session에서 새 평가·typed failure 확인. mock success로 대체 불가 |
| provenance 위조 | XPC bool, 직접 receipt struct, 일반 EC key 서명, 잘못된 SEP ACL/같은 tag 키, 사용자 선택 public key, stale policy key | 승인 0. signature fixture 성공을 생체 수락 증거에서 제외. 보호 등록·pinning 및 key rotation을 독립 확인 |
| 정품 UI 재실행 | 동일 코드/hash의 다른 인스턴스·다른 GUI session/사용자, 공격자의 선접속/가짜 broker/다른 역할 peer | launch ticket·OS instance/GUI identity로 거부. 잘못된 연결이 있어도 비밀 0. 선점 DoS는 별도 진단 |
| AX 및 승인 세탁 | AXValue read/write/AXPress, CGEvent/Apple Events, overlay/focus, 승인 도중 입력·대상 변경, 승인 뒤 submit | secret 노출 여부와 승인 우회 여부를 나눠 측정. 자동 클릭만으로 승인 불가; 변경 시 승인 폐기. 실제 생체 유도의 잔여 위험과 표시 내용을 기록 |
| 취소 경합 | success callback/consume/write/HTTP 직전 barrier마다 hold/cancel/lock/sleep/Fast User Switching/timeout/disconnect | revoke 뒤 늦은 성공/새 frame/새 HTTP 0. 이미 in-flight는 uncertain으로 구분 |
| FD·프로세스 | 실제 별도 principal에서 broker 생성→host spawn FD5→UI IPC 전달, 중복/손자 상속, broker/host/worker SIGKILL, PID 재사용/boot 변경 | 원래 attempt·세대 결합과 양방향 검증, ACK 전 prompt/HTTP 0, group unknown이면 새 승인·admission release 0 |
| crash·DB provenance | 승인 소비 직후 crash, DB commit 응답 유실, evidence 위조/다른 run 재사용, token dump 뒤 DB 실패 | 과거 승인을 자동 복구하지 않고 pending/uncertain 유지. 실제 DB role 거부와 권위 engine/관리 소켓 접근 거부를 각각 확인 |
| library·출력 | raw FD/native stderr canary, constructor/refresh/redirect/alternate MFA retry, 4번째 verify POST, 직접 socket 우회 | 모든 누출 채널 canary 0·전체 실제 전송 계수. Python `_quiet_library`(`auth_flow.py:11`–`:18`)만으로 raw FD 차단을 주장하지 않음. `authenticate` 같은 계산 함수 호출 수와 wire 전송 수 분리 |

구현 우선순위는 (1) 감독자 결정문에 소비 단위·policy·provenance·입력/승인 순서·GUI 사용자 범위를 확정, (2) phase/credentials 예산·현재 response 결합·승인 control handshake 구현, (3) callback-only 생성과 특정 GUI instance launch·broker 소비·worker gate 연결, (4) 실제 FD spawn 상속 및 supervisor DB ACK composition, (5) D2B 권위 자격/제한 API와 D1 엔진·주입 격리, D5 library/OS egress 연결, (6) 독립 OS·AX·복구 행렬과 전체 T01–T28/D6·D7이다. 각 단계의 source/fake 성공과 실제 OS 성공을 분리해야 한다. 기존 계획이 기록한 타입 오류·전체 Verify 누락도 이 조사로 해결된 것이 아니다.

## 7. 조정자가 사용할 수 있는 결정문 초안

“16.2 인증의 일회성 OS 승인은 세션 채널 개시 권한이 아닌 credentials 최초 제출 1회 및 동일 client의 각 MFA 제출 최대 3회에 각각 소비한다. 현재 active GUI 사용자의 fresh 생체 전용 정책을 사용하며 암호·관리자·캐시·버튼·이벤트 fallback은 허용하지 않는다. 보호 설치된 승인 UI의 OS callback 전용 assertion을 검증된 GUI 실행 인스턴스·broker challenge·현재 prompt/동결 response generation·work/attempt/launch/package/binding/connection 및 policy 세대에 묶어 신뢰하며, 이를 OS의 독립 transaction attestation으로 표현하지 않는다. SEP 서명 경로는 보호 등록·정확한 생체 ACL·broker 공개키/policy pinning을 별도 입증하기 전 비활성화한다. broker가 단회 소비하고 worker의 비밀 frame 수락을 같은 권한에 결합하며 승인·전송·DB 결과 불명은 자동 재사용하지 않는다. 실제 UI 봉인·동일 UID/AX·생체·취소·FD/프로세스 복구·권위 DB와 egress 격리 및 전체 수락 검증이 미완료이면 production auth와 HTTP는 닫는다.”

이 초안은 채택 요청을 위한 구체적 추천이며 조사자가 보안 결정을 확정하거나 스토리 상태를 바꾸지 않았다. 공개 API 부재·구현 불가능으로 판정할 근거는 없고, 현재의 차단을 없애도 된다는 실행 증거 역시 없다. 운영 이전·실계정은 기존대로 16.9에 남는다.
