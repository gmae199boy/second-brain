# 16.2 보안 escalation 독립 읽기 전용 검증

작성: 2026-11-01. 기준 HEAD `c7e91126e48327619ac99ea7a407eeab7df96aa7`와 현재 읽은 작업 트리. 코드·설계 정적 대조만 수행했다. 보고서 외 파일 수정, 빌드, 시험, 하위 워커, 운영 DB 접속, Docker 관리 호출, 운영 `.env`·tokenstore 열람을 수행하지 않았다. 아래 공격은 소스에서 도출한 구체적 반례이며 이 세션에서 실공격 성공을 관측했다는 뜻이 아니다. 기존 보고의 시험 성공은 독립 재실행 증거로 사용하지 않았다.

편의상 P=`_bmad-output/personal-brain/tickets/epic-garmin-runtime/tickets/story-mfa-0-plan.md`, R=같은 디렉터리의 `story-mfa-0-security-boundary-report.md`, A=`_bmad-output/personal-brain/architecture-brain-v1-slice-1/architecture-brain-v1-slice-1.md`다. 그 외 경로는 repo 상대 경로다.

## 판단

같은 UID 미승인 프로세스를 포함하는 P:53–58의 요구를 유지하면 현재 사용자 `.env`·사용자 OrbStack 관리권·사용자 LaunchAgent를 그대로 권위 경계로 사용할 수 없다. R:11,125–147 및 P:343–356의 HALT 판단은 타당하다. 이는 UI 서명이나 관리자 설치만 남은 상태가 아니다. 권위 DB 전체의 관리권과 그에 접근하는 supervisor·broker를 로그인 UID에서 분리하고, 기존 CLI/hook의 직접 app/admin DB 접속 계약을 바꿔야 한다.

구체적 추천은 **서비스 계정의 로컬 PostgreSQL + 보호된 단일 기존 supervisor + 독립 broker/worker principal + CLI/hook의 제한된 로컬 서비스 API**다. 이는 현재 AGENTS 및 AD-10/34의 OrbStack SOT 요구를 변경하는 제안이므로 지휘자의 명시적인 architecture 변경 결정 없이는 적용하지 않는다. 보호된 OrbStack 엔진 대안은 아래 증명이 먼저 필요하며, 현재 사용자 엔진을 단순 chown하거나 비밀번호만 이동하는 대안은 채택하지 않는다. 구현용 stage/native source/fake fixture를 준비할 수 있다는 판단과 운영 보안 배치가 확정됐다는 판단은 별개다.

## 1. 권위와 현재 코드의 구체적 반례

| 반례 | file:line 근거 | 공격 및 영향 | 정적 판정/한계 |
|---|---|---|---|
| 같은 UID가 app/admin/extension 자격 획득 | `apps/cli/src/config/codec.ts:747–763,781–787,795–817` | `.env`에는 postgres·brain_app·확장 비밀번호가 함께 있고 0600 owner는 같은 UID다. 미승인 코드가 app으로 admission/evidence를 변경하거나 postgres로 제약을 삭제할 수 있다. | OS UID DAC는 같은 UID 코드를 구분하지 않는다. 실제 파일 내용은 읽지 않았다. |
| evidence가 OS peer 인증을 증명하지 못함 | `extensions/garmin/migrations/0007_account_protection.sql:246–276` | brain_app은 evidence SELECT/INSERT/DELETE를 가진다. 기존 자격을 획득한 공격자가 current work/token/generation에 맞는 evidence를 위조할 수 있다. 해당 행만으로 auth 해제는 안 되며 admission/profile/성공 intent/pending 부재도 필요하다. | 다른 검사를 생략한 단일 INSERT로 해제된다고 과장하지 않는다. admin 자격이면 그 검사 자체를 우회할 수 있다. |
| app 자격이 감독 사실까지 변경 | `packages/postgres/src/setup.ts:46–52`; `0007_account_protection.sql:77,84,128,156` | brain_app의 core 기본 CRUD와 holder DML, `session_user='brain_app'` 허용이 있어 임의 app 사용자를 검증된 supervisor와 구별하지 못한다. | role 이름은 OS 실행물 신원이 아니다. owner NOLOGIN(`setup.ts:23`)만으로 admin 자격 노출은 해소되지 않는다. |
| Docker 관리권으로 DB 경계 우회 | `apps/cli/src/install/postgres.ts:18–24,44–60`; `apps/cli/src/runtime/orbstack.ts:10–21,35–39` | 사용자 API 권한이 있다면 container inspect로 POSTGRES_PASSWORD를 얻거나 exec/volume mount/DB 교체로 권위 상태를 변경한다. 다른 컨테이너 안 broker여도 같은 엔진 관리자가 접근하면 실패한다. | API가 실제 무제한인지, exec 가능한 OS/PG 사용자와 pg_hba는 이번 조사에서 확인하지 않았다. 소스는 사용자 CLI 관리 경로와 env 주입을 입증한다. |
| privileged supervisor가 사용자 코드를 실행 | `apps/cli/src/daemon/supervisor.ts:35–43,72–98` | manifest 버전만 맞춘 사용자 수정 entry/venv가 보호 principal에서 실행되어 자격을 탈취한다. symlink 검사만으로 내용·owner·서명이 봉인되지 않는다. | 현재 코드는 보호 principal 배포가 아니다. 그대로 서비스 계정으로 올리는 전환안을 반박하는 반례다. |
| CLI 설정으로 권위 endpoint 교체 | `apps/cli/src/config/codec.ts:741–745`; `apps/cli/src/runtime/brain-store.ts:16–23` | env 우선 URL/config로 공격자 DB를 실제 권위 DB인 것처럼 보호 서비스가 사용하면 세대·hold·binding을 위조할 수 있다. | 사용자 CLI의 개인 DB 선택과 protected runtime의 endpoint 선택은 별도 신뢰 계약이어야 한다. |
| 사용자 shim/launchd가 서비스 코드 교체점 | `apps/cli/src/daemon/launchd.ts:13–18,25–35,56–73`; A:434–440 | gui UID의 plist와 shim을 변경하거나 종료 후 다른 daemon을 띄워 supervisor 권한을 가장한다. | root 설치 LaunchDaemon·보호 lock/registry가 필요하다. 같은 사용자 daemon readiness 파일을 새 권위 증거로 쓰지 않는다(`supervisor.ts:106–113`). |
| extension default grant가 향후 우회 생성 | `packages/postgres/src/extension-provision.ts:63–71` | schema CREATE와 owner 신규 객체 default ALL/EXECUTE가 새 보호 테이블/함수에 권한을 자동 부여한다. 재provision이 기존 객체에 blanket GRANT하지 않는 개선은 유지되어 있다. | 이미 0007에서 revoke한 객체가 재설치만으로 즉시 다시 열린다고 주장하지 않는다. 신규 객체/role 재생성/migration 재개를 별도로 검증해야 한다. |
| tokenstore 경로 교체/동일 UID 읽기 | `extensions/garmin/src/tokenstore_check.py:29–55` | 최종 owner=현재 UID 검사 후 FD를 닫고 library가 pathname으로 재열면 교체 틈이 있다. 로그인 UID 소유 tokenstore는 같은 UID가 읽는다. | 현재 함수의 문서도 이 한계를 명시한다(:21–25). live auth 허용 증거가 아니다. |
| HTTP 후크 우회 | `extensions/garmin/src/http_intercept.py:13–15,23–34` | 원래 send/request를 호출하는 monkeypatch 외의 socket/native lib/subprocess 경로는 직접 전송할 수 있다. | 협조적 library seam이지 OS egress 격리가 아니다. |

A:209는 단일 PostgreSQL/사용자 `.env`/OrbStack named volume, A:321은 모든 비밀의 사용자 홈 저장, A:434–440은 같은 shim의 사용자 daemon와 daemon 부재 시 직접 명령·hook 동작, A:518–523은 사용자 compose·OrbStack·확장 홈 배치를 정한다. 각각의 호환 조건을 명시하지 않고 '보호 broker만 추가'하면 위 반례가 남는다. localhost 제한은 원격 도달성을 줄일 뿐 같은 UID나 엔진 관리자에 대한 권위 무결성을 주지 않는다.

## 2. 보호 배치 추천안과 역할

다음은 신규 설계이며 구현/OS 적용/시험 완료 사실이 아니다.

| 주체 | OS/설치 배치 | 허용 | 금지 |
|---|---|---|---|
| PostgreSQL | 전용 비로그인 `_brain_db`, 보호된 data/WAL/socket/config/backup 부모, root 관리 설치물과 LaunchDaemon | DB 실행과 한 개 권위 DB | 로그인 UID의 data 접근·엔진 API·설정 교체, runtime의 DB 파일 직접 접근 |
| 기존 supervisor | `_brain_runtime`, root 소유 봉인 Node/runtime와 모듈, 단일 system service | 기존 `runSupervisor` claim/admission/spawn/정산/종료 | 사용자 shim/repo/venv/env/config를 코드·자격으로 신뢰, 임의 extension 코드를 이 UID에서 실행 |
| broker | 별도 `_brain_broker`, root 소유 native code/policy | peer 검증, 세션 승인, per-send intent·HTTP·결과, auth evidence | work claim/두 번째 supervisor, 임의 SQL·URL·command RPC |
| Garmin WorkerHost | `_brain_garmin`, 봉인 embedded Python/의존 | library login/dump, sandbox 내 tokenstore·최소 publish | app/admin/evidence 자격, 다른 extension 코드, 직접 인터넷 |
| operator UI/CLI/hook | 로그인 UID | UI secure input, 요청·조회·비권위 spool | DB admin/app/broker URL, 스스로 evidence/승인 capability 생성 |
| installer/migrator | 명시 승인된 설치 권한, 런타임과 분리 | role/DDL/설치/회전/검증 | 일반 CLI에서 임의 SQL·migration 경로 지정 실행 |

root는 설치·서비스 관리 권한이고 library/HTTP 실행 UID로 쓰지 않는다. broker와 runtime을 한 UID로 합치는 R:37–41의 최소안은 로그인 UID 공격에는 후보지만, worker까지 같은 UID에 두면 worker가 broker/runtime 자격을 읽을 수 있다. 본 추천은 worker UID를 분리하여 이 의존을 줄인다. 보호 supervisor 자체가 침해된 경우까지 완전 방어했다고 주장하지 않는다.

PostgreSQL은 TCP 비노출 및 보호된 Unix socket 디렉터리로 시작하는 배치를 권한다. OS peer→정확한 서비스 role 매핑이 이 macOS/PG 빌드에서 동작하는지 미검증이며, 지원 불명 시 서비스별 보호 credential file/FD와 명시 pg_hba를 쓰고 trust 인증은 금지한다. runtime은 SUPERUSER/CREATEROLE/owner/SET ROLE 가능 멤버십을 가지지 않는다. DB 프로세스 UID의 관리자 경로와 installer 권한도 로그인 UID에는 없다. 보호 서비스가 사용자 URL을 받아 접속하는 기능은 금지하고 DB instance identity/config generation을 root 정책으로 고정한다.

새 migration에서 admission은 supervisor role, evidence 및 start/finish HTTP는 broker role, worker는 attempt-fenced publish에 한정한다. `complete_verified_auth`도 broker가 검증한 완료 절차 안으로 이동하거나 worker 호출을 남길 경우 세대별 일회성 evidence 소비만 허용한다. `session_user='brain_app'` 비교와 EXECUTE grants를 함께 갱신하고 보호 테이블·함수 PUBLIC 및 구 app/extension 권한, owner/default ACL/role membership/schema CREATE까지 확인한다. worker가 임의로 finish='success'를 보고할 수 있으면 broker의 실제 HTTP 관측 권위를 얻을 수 없다(`0007:331–361`). 기존 migration을 고치지 않고 후속 migration으로 이전한다.

### OrbStack 유지 대안의 승인 조건

로그인 사용자의 기존 OrbStack instance/socket/context/VM/volume은 계속 개발용으로 사용할 수 있어도 권위 DB의 관리 대상이어서는 안 된다. 별도 보호 principal의 엔진을 유지하려면 (1) API socket뿐 아니라 orb CLI·GUI·다른 socket/context·VM 진입·volume export·백업·컨테이너 inspect/exec/create의 모든 동등 권한이 로그인 UID에서 거부되고, (2) 서비스가 사용자 HOME/PATH/DOCKER_HOST/context/compose를 읽지 않으며, (3) 재로그인·재부팅·업데이트에도 제한이 유지되는 실제 격리 증거가 필요하다. 소켓 한 개 chown은 이 세 조건의 증거가 아니다. 현재 OrbStack이 이런 서비스 배치를 지원한다는 근거를 확인하지 못했으며 '다른 계정으로 orb start하면 된다'는 실행안을 확정하지 않는다.

따라서 먼저 architecture 선택을 기록한다: '검증 가능한 보호 OrbStack 엔진' 또는 '단일 로컬 PostgreSQL 서비스로 AD-10/34와 AGENTS 수정'. 둘 다 불가능하면 auth/HTTP는 닫힌 상태를 유지한다. 별도 작은 ledger만 안전하게 두고 공격자가 바꾸는 본 DB의 attempt/hold/binding을 신뢰하는 대안도 현재 요구를 만족하지 않는다(R:147).

## 3. CLI/hook·setup·업데이트의 구체적 계약

보호 서비스 API는 데이터 작업 verb만 노출한다. 검색/읽기/일반 기록·enqueue·cancel/hold 요청과 상태 projection은 필요 권한별로 제한하고, raw SQL·실행 경로·FD 번호·DB URL·임의 파일 read·migration body는 받지 않는다. CLI 서명을 확인해도 공격자가 정상 CLI를 실행할 수 있으므로 '정상 CLI 실행=사람의 auth 승인'으로 취급하지 않는다. auth/release-block/보호 경로 변경 등은 별도의 승인 UI가 정확한 세션·operation·세대를 보여 주고 발급하는 일회성 capability를 필요로 한다. 일반 enqueue/설정 입력으로 binding/protection/allowlist/credential을 덮어쓰지 못하게 한다.

hook은 짧은 timeout의 서비스 제출만 하고, 실패 시 사용자 spool에 비권위 입력을 쌓는다. 서비스가 spool을 읽을 때 크기·symlink·source 경로·schema를 검증하며 파일 내용은 사용자 제공 데이터다. daemon 부재 시 로컬 Core로 privileged SQL 실행을 되살리는 fallback은 금지한다. `doctor`는 비밀 없는 서비스 상태로 unavailable/provisioning-required를 표시하고 URL을 내보내지 않는다. 명령 문법은 가능한 보존하되 protected daemon 부재 시 읽기/실행이 계속 완료된다는 A:440의 가용성 계약은 변경해야 한다. 사용자 spool 존재를 DB commit 성공으로 표시하지 않는다.

`daemon start/stop`은 보호 서비스의 제한된 관리 요청과 사용자 hook collector 제어를 구분한다. 시스템 supervisor는 하나만 존재하고 사용자 daemon이 같은 DB의 확장 작업을 claim하지 않는다. 기존 Core 구현을 보호 서비스 안에서 재사용하며 사용자 file watcher/drain 일부를 분리하더라도 두 번째 work supervisor를 만들지 않는다. system lock/DB lease/boot-start identity를 보호 경로에서 관리한다.

`setup run/upgrade/ext install`은 stage 산출물 작성→보호 installer의 봉인 package/승인된 migration 검증→적용으로 바꾼다. 사용자 checkout의 migration이나 extension manifest를 admin으로 그대로 실행하면 arbitrary SQL/code 설치 통로다. 기존 `commandEnv`는 사용자 PATH를 먼저 둔다(`apps/cli/src/runtime/command-runner.ts:27–29`); protected 경로는 고정 executable·환경 allowlist를 사용하고 `composeArgs`의 사용자 env-file/compose(:16–17)를 쓰지 않는다. 사용자 bootstrap은 보호 설치물을 스스로 갱신하지 못하고 stage/update 요청만 한다. 구 자격 회전·기존 PG 세션 종료·역할 권한 제거·백업 보호까지 포함해야 제거 전 `.env` 복사본이 무력화된다.

## 4. 전용 FD의 정확한 추천과 우회 방지

현재 ProcessSpec에는 auth FD가 없고(`packages/core/src/ports/process.ts:1–15`), Node launcher는 stdin ignore·stdout/stderr pipe뿐이다(`apps/cli/src/runtime/process-group.ts:7`). 현재 auth 진입은 `AUTH_PEER_UNVERIFIED`로 종료한다(`extensions/garmin/src/auth.py:5–10`). 이 닫힘을 유지하면서 typed AuthLaunchCapability를 추가한다. `--fd 7` 같은 숫자는 신원이나 승인 증거가 아니다.

### 추천하는 전송 계약 결정

운영상 더 단순한 선택은 **인증된 XPC에는 비밀 없는 metadata와 dedicated FD만 전달하고 password/MFA/key 본문은 해당 FD만 사용하는 방식**이다. broker가 익명 socketpair를 만들고 worker endpoint는 고정 launcher에서 spawn 상속, UI endpoint는 역할별 peer 검증 후 XPC descriptor transfer한다. 세션별 별도 channel이며 CLI/Node에는 endpoint나 key를 주지 않는다. FD 복제는 fork/exec 상속과 다르므로 P:54 '전용 상속 FD'를 'broker가 만든 익명 전용 FD, worker에는 spawn 상속, UI에는 검증된 OS IPC FD 전달'로 명시하는 결정을 받아야 한다. 이는 권한 검증을 생략하거나 XPC dictionary secret payload를 허용하는 변경이 아니다. 결정 전에는 문구를 충족했다고 판정하지 않는다.

문구를 엄밀한 상속으로 유지한다면 보호된 native 공통 launcher가 broker/worker와 operator UID의 GUI helper를 실제 spawn해 양 끝을 상속시켜야 한다. GUI bootstrap/audit session 진입, UID/GID drop, UI의 양방향 신원 검증, 로그인 사용자 선택·동시 세션을 실제로 입증해야 한다. 서비스에서 로그인 GUI를 임의 exec하면 된다는 전제나 UI가 자기 helper를 spawn한 것만으로 broker endpoint도 상속됐다는 주장은 성립하지 않는다(R:79–83). 이 topology는 현재 코드에서 미검증이다.

### 구현 순서와 닫힘 조건

1. 보호 supervisor가 현재 attempt·binding·gate의 durable admission을 commit한다. 기존 `packages/core/src/queue/supervisor.ts:182–208`의 admission-before-launch 순서를 유지한다. worker는 native 최소 HELLO 외 Python import/constructor/network를 정지한다. 현재 코드는 spawn 후 `:233–239`에서 OS 신원을 기록하므로 별도 ACK barrier 없이는 import-before-record를 막지 못한다.
2. launcher가 OS child/audit identity·PID/PGID/start/boot·package digest를 supervisor receipt와 대조한다. broker registry가 home instance/work/attempt/run/binding/policy generation/session epoch를 결합한다. PID만 또는 client가 쓴 tuple만 신뢰하지 않는다.
3. UI↔broker, launcher/worker↔broker는 역할별 정확한 signing identity/requirement와 UID/session을 검증한다. Team ID 전체 허용, 일반 Python 서명, 사용자 쓰기 가능한 cdhash allowlist는 금지한다. signed binary가 arbitrary script/plugin/env를 로드하면 peer 승인만으로 코드가 봉인되지 않는다.
4. 사용자 승인 후 FD를 한 세션에 한 번 붙이고 양방향 challenge/용도·방향 분리 key 및 transcript ACK를 완료한다. 가능하면 비밀 데이터 채널은 UI↔worker 직결, broker는 수명과 승인만 관리한다. HTTP token/body도 별도 전용 채널로 broker에 보내며 로그·DB에 원문을 저장하지 않는다.
5. launcher는 모든 비허용 FD를 close하고 FD_CLOEXEC 및 명시 dup whitelist를 적용한다. listener/DB/admin/다른 세션 FD가 worker/후손에 남지 않게 한다. XPC는 FD를 복제하므로 transfer 후 송신측 중복 endpoint를 닫고 원본이 남아 EOF/cancel을 방해하지 않게 한다. 코드 서명만으로 FD 보유자를 검증했다고 하지 않는다.
6. frame reader는 길이 header를 제한된 buffer로 읽고 partial read/write·EINTR·EOF·timeout을 처리한다. codec의 16KiB/4096/seq/session/HMAC 검사는 활용하되 work/attempt/package tuple을 handshake에 별도 bind한다(`apps/cli/src/runtime/auth-wire.ts:4–39`, `extensions/garmin/src/auth_wire.py:15–58`). 현 codec의 방향 domain 분리는 있으나 broker bootstrap/HTTP용 key 분리나 stream reader는 없다.
7. 취소/hold/EOF/만료/신원 불명은 channel·capability를 폐기하고 더 이상 prompt/send하지 않는다. 후손이 FD를 보유하면 EOF가 늦을 수 있고 EOF는 그룹 종료 증거도 아니다. 실제 group 종료·reap 전 새 attempt를 허용하지 않는다. 비밀 메모리 zeroization은 Python/Swift 불변 문자열 복사까지 완전 보장했다고 주장하지 않으며 crash/core/log/swap 잔존 정책을 검증 범위로 둔다.

## 5. tokenstore·HTTP·UI에서 남는 불가능한 전제

- 로그인 UID가 계속 읽을 수 있는 tokenstore와 같은 UID 비밀 격리는 동시에 충족할 수 없다. 기본 경로 문자열은 보존할 수 있으나 최종 owner는 worker principal로 위임해야 한다. `~`는 operator home로 한 번 해석하고 서비스 HOME로 바꾸지 않는다. 사용자 조상이 교체 가능하면 열린 디렉터리 FD를 수명 내내 pin하고 library의 상대 CWD 경로를 검증한다. pathname 재열기·절대경로 변환·파일 symlink/hardlink/ACL·native dependency 경로가 우회점이다. FD pin만으로 sandbox file permission도 생긴다는 전제는 미검증이다(R:96–110).
- worker의 직접 socket/native lib/후손 egress는 OS 제한으로 막고 broker만 실제 HTTP를 보낸다. App Sandbox+embedded runtime은 후보이지 이 배치에서 검증된 해답이 아니다. arbitrary path tokenstore 권한과 sandbox, native Python dependencies/library validation의 조합이 실패하면 지원 불명으로 닫는다. per-send intent commit→전송→결과 commit을 원자적이라고 표현하지 않는다. 전송/commit 불명은 pending으로 남긴다.
- 승인 UI의 secure field·상대 서명은 사람의 의도 자체를 보증하지 않는다. 접근성/자동화/화면 접근 특권 보유 same UID 공격자를 포함할지 명시해야 한다. 그러한 권한을 이미 가진 공격자까지 포함한 강한 user-presence가 필요하면 별도 OS 사용자 인증/승인 정책과 실패 검증이 필요하다. 이번 조사는 UI/spoof 저항을 입증하지 않았다(R:94).
- 보호된 코드가 사용자 manifest·site-packages·DYLD/PYTHONPATH·shell 환경을 로드하면 서비스 계정 분리가 무효화된다. 라이브러리/stdlib/native dylib/CA/정책까지 root 봉인 package와 고정 loader로 제한한다.
- 재인증과 probe의 좁은 예외는 P:55에서 이미 결정됐다. 이를 다시 미결정 모순으로 취급하지 않는다. 당일 rate latch나 uncertain이 함께 있으면 auth 예외가 나머지를 지우지 않는다. 한 실제 HTTP probe를 증명하지 못하면 0건이 맞다.

## 6. 후속 실행 단계와 검증 게이트 — 이번에는 실행하지 않음

| 단계 | 리뷰 가능한 산출물 | 실제 검증 및 실패 조건 |
|---|---|---|
| D0 | architecture 결정: protected OrbStack 또는 local PG, AD-10/18/27/34·AGENTS·CLI availability·FD 의미 변경 목록 | 로그인 UID 관리권을 유지하면서 DB만 안전하다고 하는 전제를 제거. 결정 전 live auth 닫힘 |
| D1 | root-owned install/package/policy manifest, renderer/preflight/rollback, service UID·소유·ACL·socket·backup 경로 | stage는 구조만 검증. 실제 별도 UID fixture에서 data/config/key read·replace·signal·DB connect·관리 API deny, reboot/update 후 유지까지 별도 증거 |
| D2 | PG roles 후속 migration·typed service API·사용자 credential 제거 설계 | 격리 PG에서 구 app/extension/public/role membership으로 evidence 위조·holder 삭제·직접 latch 변경·함수 호출·schema CREATE 거부. 재provision/새 migration/role 재생성 뒤 동일. 기존 연결·구 비밀번호 차단 |
| D3 | 기존 supervisor의 단일 보호 서비스 배치와 고정 Garmin launcher, 다른 확장의 privilege drop | 실제 supervisor admission commit 후 spawn. OS 신원 기록 실패/지연 중 constructor/import/network 0. 사용자 manifest/venv/Node shim/URL/PATH 교체 거부. 이중 supervisor claim 0 |
| D4 | 실제 별도 UI/broker/worker, peer policy, dedicated FD와 stream/ACK 구현 | 동일 UID 다른 binary·옛 signed package·역할 다른 approved binary·fake broker·정상 CLI를 통한 승인 세탁·자기 PID 주장·두 UI attach·FD steal/잔류·partial frame·재전송·취소에서 prompt/secret/HTTP 0 |
| D5 | protected tokenstore adapter·library loader·egress restriction·broker transport | 합성 tokenstore rename/replace/symlink/ACL/hardlink, worker direct socket/ssl/native curl/subprocess 시도 수신 0. broker 승인 1건만 fake server가 관측. canary가 argv/env/stdout/stderr/DB/log/temp/crash report에 0 |
| D6 | 전체 T01–T28 native+PG+fake HTTP 통합 증거표 | intent commit 직후 SIGKILL, 결과 commit 실패/응답 유실, reboot identity mismatch, cancel/hold race, probe 2번째, pacing·binding latch 보존·다른 계정 병렬. 실제 group reap 확인 후에만 재시작 |
| D7 | 검증된 installer/update/회전/backup/restore 및 운영 이전 runbook | 기존 원본/authority v1 보존, 복사본 자격 무효화, 미확정 intent 유지, uninstall이 토큰·DB를 자동 삭제하지 않음. 실계정·운영 이전·배포·예약 전환은 16.9 |

각 단계는 fake/mock 성공과 실제 OS principal 검증을 별도로 표시한다. 서비스 계정·서명·sandbox를 사용할 수 없는 환경에서 unsupported/미검증을 통과로 바꾸지 않는다. 이 작업은 설치를 실행하거나 새 승인 절차를 사용자에게 요청하는 task가 아니므로 여기서는 설계 추천만 남긴다.

## 7. 기존 보고와 대조한 수정 및 남은 미검증

R:19는 native check에 PID 일치 assertion을 추가하라고 했지만 현재 `extensions/garmin/tests/native/check-native.sh:20–25`에는 두 경우 모두 peer PID=child PID assertion이 이미 있다. `peer-parent.c:15–21`은 audit token을 Security lookup/requirement validity 검사에 실제 사용한다. 따라서 이 구체적 TODO는 현재 소스에서 해소됐다. 스크립트 실행은 하지 않았으므로 통과를 재확인한 것은 아니다.

`extensions/garmin/tests/native/xpc-spike.c:9–26`은 listener와 client가 동일 main 프로세스다. requirement deny/accept fixture로는 유용하지만 별도 GUI UID/서비스 broker/worker의 XPC 배치·FD 전달·토큰 격리·사람 승인·OS egress·관리권 격리를 입증하지 않는다. `check-native.sh:8–18`도 합성 fixture 생성과 요구 문자열 검사다. 이 작은 개선을 전체 경계 완료로 승격하지 않는다.

미검증: 실제 OrbStack API ACL/동등 관리 경로, pg_hba와 접속 신원, local PG 배포 가능성·peer auth, 유효 서명/entitlement/GUI bootstrap/session policy, runtime 봉인·worker sandbox/경로 권한, library 실제 login/dump와 transport 호환성, FD 통합/그룹 수명, 서비스 API 권한/CLI 회귀, 운영 자격 잔존 및 이전. 기존 보고와 계획의 핵심 HALT는 유지하되 구현 가능한 staging/native/후속 migration 준비를 막는 근거로 확대하지 않는다.
