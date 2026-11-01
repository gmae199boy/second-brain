# 16.2 g3 보호 OrbStack 배치: 읽기 전용 조사

조사일: 2026-11-01 (KST). 조사 대상 checkout HEAD: `9008fd8d31e17b0335186b9b28ef367606088c7d` (작업 중 파일은 다른 워커가 바꿀 수 있으므로 HEAD는 전체 작업 트리 신원 증명이 아니다). Task `task_dba47e5c32de`, Dispatch `ctx_83e0bdbab150`.

## 판정

**로그인 UID에서 모든 관리 경로를 격리하면서 OrbStack Docker의 단일 PostgreSQL SOT를 유지하는 공식 지원 배치를 이번 조사로 확인하지 못했다. 보호 배포는 미검증/미완료이며 auth 입력과 외부 HTTP를 열 근거가 없다.** 이는 OrbStack에서 어떤 배치도 기술적으로 불가능하다는 판정이 아니다. 확인된 공식 기능은 사용자 수준 Docker/GUI/CLI, headless CLI, 멀티유저 사용이며, 그것이 적대적인 로그인 UID에 대한 별도 서비스 principal의 완전한 관리 경계라는 보장은 확인되지 않았다.

특히 로그인 UID 소유 OrbStack에 DB를 그대로 두고 broker만 별도 UID로 옮기는 방법, 소켓 이름/권한만 바꾸는 방법, context 변경, isolated machine은 요구 충족 근거가 아니다. 현재 문서의 기본 기능은 Mac 사용자가 컨테이너와 volume을 직접 관리·읽기·수정하는 방향이다. 별도 비관리자 principal의 독립 사용자 세션에서 OrbStack 전체를 소유하게 하는 후보는 남지만, 공식 지원 범위·cold start·공유 helper·재부팅·업데이트·GUI·backup을 포함한 격리는 미확인이다.

## 범위와 수행 제한

계획 `_bmad-output/personal-brain/tickets/epic-garmin-runtime/tickets/story-mfa-0-plan.md`의 ‘보호 배치 재추진’ 결정을 읽었다. 단일 PostgreSQL/OrbStack 계약 유지, API·VM·context·volume·backup·inspect/exec/create의 동등 관리 우회 차단, 실패/불명 시 auth/HTTP 실패 닫힘, 운영 이전은 16.9라는 조건으로 평가했다. OS 관리자/OS 침해는 위협 범위 밖이며 로그인 UID의 미승인 코드가 범위 안이다. 로그인 사용자가 관리자 계정이더라도 승인 없는 일반 UID 실행과 명시적으로 승격된 관리자 행위를 구분해야 한다.

수행한 것은 저장소 텍스트 읽기, 공식 웹 문서 및 공식 이슈 트래커 읽기, 설치된 공개 CLI의 `--help`, 앱 번들의 버전 plist 읽기뿐이다. 개인 홈 상태·운영 DB·개인 `.env`·tokenstore·건강정보를 읽지 않았다. Docker daemon에 연결하는 status/list/info/version/inspect 등을 실행하지 않았고, VM 접속·생성·변경·volume export·GUI 조작·관리자 설치·소스 수정·빌드·시험·추가 워커도 수행하지 않았다. 아래 검증 절차는 **앞으로 별도 승인 범위의 폐기 가능한 합성 환경에서 수행할 설계**이며 실행/통과 증거가 아니다.

## 공식 근거: 지원/미지원/미확인을 분리

| 항목 | 확인된 사실과 URL | 요구에 대한 판단 |
|---|---|---|
| 사용자 CLI/headless | [Command line & CI](https://docs.orbstack.dev/headless)는 GUI 없이 CLI 사용, `orb start`, Docker 사용을 문서화한다. GUI 없는 auto-update는 미지원이라고 명시한다. | headless 사용 지원은 확인. 로그인 전 system service나 적대 UID 격리 지원으로 확대 해석할 수 없다. |
| root/system 시작 | [#1444](https://github.com/orbstack/orbstack/issues/1444)의 유지보수자 답변(2024-09-26)은 launchd agent 방향을 말하고 daemon/root 실행 지원 계획이 없다고 한다. 원문의 plist에는 비root `UserName`이 있으며 후속 댓글도 daemon=항상 root라는 설명을 정정한다. [#1767](https://github.com/orbstack/orbstack/issues/1767)의 유지보수자 답변(2025-02-11)은 로그인 없이 시작하는 요구에 미지원이라고 답하고 #1444를 연결한다. | root OrbStack 및 로그인 전 LaunchDaemon을 공식 지원 해법으로 제시할 수 없다. 비root LaunchDaemon이 OS에서 불가능하다는 뜻은 아니며, 사용자 세션 방식의 최신 예외 지원 여부는 별도 확인해야 한다. |
| 멀티유저 | [#244](https://github.com/orbstack/orbstack/issues/244)는 유지보수자가 멀티유저 지원을 v0.17.2에 출시했다고 확인한다. | 다른 macOS 사용자 사용 자체를 일괄 미지원이라 하면 틀린다. 다만 상호 비신뢰 UID 사이의 보안 보장·service 계정 세션·모든 관리 경로 격리의 보증은 이 이슈에 없다. |
| 별도 비관리자 서비스 계정 | [#2580](https://github.com/orbstack/orbstack/issues/2580)은 2026-07-05 사용자 신고로, 별도 계정 첫 GUI 기동 후 cold start 시 data-storage/TCC 오류를 보고하며 해당 배치의 지원 여부를 질문한다. 열람 시 Open이고 유지보수자 답변이 표시되지 않는다. | 공식 지원 약속이 아닌 미해결 사용자 보고다. 현 설치 재현이나 전체 버전의 확정 결함으로 주장하지 않는다. ‘사용자가 권한 한 번 승인하면 끝’으로 단정할 수도 없다. |
| VM/engine 구조 | [Architecture](https://docs.orbstack.dev/architecture)는 단일 Linux VM의 공유 kernel, Docker engine의 macOS 소켓 forwarding, Mac과 guest의 통합을 설명한다. 내부 서비스 방화벽은 컨테이너 내 비신뢰 코드로부터의 보호라고 설명한다. | guest 안 공격자 보호를 macOS 로그인 UID 관리 차단으로 혼동하지 않는다. 별도 Linux 사용자만으로 Mac 관리 소유자를 격리하지 못한다. |
| isolated machine | [Isolated machines](https://docs.orbstack.dev/machines/isolated)는 Mac 파일/통합 차단을 제공하지만 Mac에서 SSH·orb 접근 및 앱 표시가 유지된다고 명시한다. 공유 kernel이며 완전한 보안 경계도 아니라고 한다. 설정은 app/CLI로 변경 가능하다. | 이 기능은 guest→host 위험 감소용이다. host 로그인 UID→DB 관리 차단의 해법으로는 부적합하다. 여기에 별도 Docker/PG를 만드는 것으로 현재 단일 OrbStack engine 계약을 조용히 대체해서도 안 된다. |
| API/context/GUI | [Docker containers](https://docs.orbstack.dev/docker/)는 `orbstack` context 자동 선택, 선택적인 `/var/run/docker.sock` symlink, Docker engine config 변경, container/volume GUI를 문서화한다. | context는 endpoint 선택이지 신원 경계가 아니다. GUI/engine config 변경 권한이 남으면 소켓 하나만 바꾸어 전체 차단을 증명할 수 없다. |
| 직접 파일 접근 | [Native files](https://docs.orbstack.dev/features/native-files)는 Mac 앱/터미널에서 container·volume 파일을 읽고 수정·추가·삭제하는 기능을 문서화한다. 위치 예: `~/OrbStack/docker/volumes/<name>`. | Docker HTTP만 차단해도 별도 파일 경로가 남을 수 있다. 실제 보호 principal 배치에서 로그인 UID의 접근 거부를 별도로 입증해야 한다. |
| volume 복제/백업 | [Volumes & mounts](https://docs.orbstack.dev/docker/file-sharing)는 `orb docker volume clone`, `export`, `import`를 지원한다. | 원본 volume의 직접 접속 외에 복제본/아카이브 반출·복구로 권위를 변조할 수 있는 경로도 닫아야 한다. PostgreSQL role만으로 storage 관리자에 대응했다고 볼 수 없다. |
| 숨김/설정 | [Settings](https://docs.orbstack.dev/settings)는 설정을 CLI와 앱에서 바꿀 수 있다고 한다. `mount_hide_shared`는 Finder/Desktop에서 숨길 뿐 `~/OrbStack` 경로 접근은 유지한다고 명시한다. | 숨김은 접근 통제가 아니다. `network_bridge`는 Mac의 container/machine IP 직접 접속 기능이며, 설정 소유권과 변경 통제도 검증 대상이다. |
| 실제 data image/백업 | [FAQ](https://docs.orbstack.dev/faq)는 `~/OrbStack`이 실제 저장소가 아닌 view이고 실제 기본 저장소는 `~/Library/Group Containers/HUAQ24HBR6.dev.orbstack/data`라고 설명한다. Time Machine이 sparse file을 지원하며 data 디렉터리 backup 제외 방법도 문서화한다. 관리자 권한은 선택 사항이라고 명시한다. | symlink 제거/관리자 요청 거부만으로 engine 사용이 차단되지는 않는다. 원본 data image, 이동된 storage, backup 및 restore 권한은 별도 통제 필요. 실제 개인 위치/백업을 읽지는 않았다. |
| SSH 관리 | [SSH access](https://docs.orbstack.dev/machines/ssh)는 built-in SSH server와 사용자별 private key 위치 `~/.orbstack/ssh/id_ed25519`, machine/user 선택 및 localhost 접근을 문서화한다. | localhost는 macOS UID 인증 경계가 아니다. 보호 principal의 key/authorized_keys 및 서버가 로그인 UID에 제공하는 권한까지 검증해야 한다. key 본문은 읽지 않았다. |
| debug/exec 대체 | [Debug Shell](https://docs.orbstack.dev/features/debug)은 shell이 없는/read-only container도 GUI 또는 `orb debug`로 debug하고 Docker context로 remote debug하는 기능을 문서화한다. | DB image에서 shell 제거·read-only rootfs만으로 관리자 exec 경계를 대체할 수 없다. |
| 직접 네트워크 | [Container networking](https://docs.orbstack.dev/docker/network)은 port forwarding 외에 container IP 직접 접속과 host networking을 문서화한다. | 포트 publish를 지우는 것만으로 SQL 접근이 없어졌다고 판단하지 않는다. 좁은 서비스 API와 별도로 SQL 및 engine TCP/SSH 경로를 검증해야 한다. |
| 최신 버전 변화 | [Release notes](https://docs.orbstack.dev/release-notes)는 v2.2.5(2026-10-23) 보안 수정, v2.2.4의 logout 시 VM 강제 종료 수정 등을 적고 있다. | 과거 이슈는 현재 배치 실패의 재현 증거가 아니다. 이번에 확인한 최신 문서/릴리스에도 완전한 보호 서비스 배치 계약은 발견하지 못했다. |

## Docker 일반 보안 기능이 해결하는 범위

[Docker daemon security](https://docs.docker.com/engine/security/)는 daemon 제어를 신뢰된 사용자에게만 허용해야 하며 관리자 API로 임의 mount 등 강한 동작이 가능함을 설명한다. [Protect access](https://docs.docker.com/engine/security/protect-access/)의 SSH/mTLS는 daemon 접속 신원을 제한하는 수단이다. client key가 로그인 UID가 읽는 곳에 있으면 그 UID의 미승인 프로세스와 승인 client를 구분하지 못한다. TLS는 파일 view·OrbStack 자체 IPC·VM/backup 관리까지 통제하는 기능으로 문서화되어 있지 않다.

[Docker AuthZ](https://docs.docker.com/engine/extend/plugins_authorization/)는 기본 권한이 all-or-nothing임을 명시하고 plugin으로 HTTP API 요청을 허용/거부할 수 있게 한다. 같은 문서는 gRPC가 AuthZ 대상이 아니며 exec upgrade 이후 stream도 추가 심사하지 않는다고 명시한다. 따라서 plugin 또는 socket proxy 하나만으로 전체 OrbStack 관리 경계를 구현했다고 주장하면 안 된다. OrbStack에서 plugin 배치·신뢰된 config·소유자 UI 우회 차단이 공식 지원되는지도 이번에는 미확인이다. 일반 Docker 기능 문서를 OrbStack의 통합 경계 보증으로 대신하지 않는다.

## 설치물의 공개 help/메타데이터 관찰

아래는 모두 exit 0이며 daemon 상태/개인 설정을 요청하지 않은 공개 help 또는 번들 메타데이터다. 실제 API에 대한 허용/거부 관찰은 전혀 없다.

- `/Applications/OrbStack.app/Contents/Info.plist`: `CFBundleShortVersionString=2.2.5`, `CFBundleVersion=21124` (PlistBuddy로 두 key만 읽음).
- `command -v orb orbctl docker`: `/usr/local/bin/orb`, `/usr/local/bin/orbctl`, `/usr/local/bin/docker`. 실행 파일 symlink target나 개인 설치/설정 내용은 검사하지 않음.
- `orb --help`, `orbctl --help`: Mac에서 machine/engine 관리, `run`, `create`, `export`, `reset`, `config`, `debug` 등 공개 명령을 확인.
- `orbctl run --help`: `-m/--machine`, `-u/--user`; 공개 `orb --help`에는 Linux root 사용자 선택 예시가 있다. Linux 사용자 선택을 macOS의 보호 principal 분리와 혼동하지 않는다.
- `orbctl create --help`: `--isolated`, `--isolate-network`, `--mount`, `--user` 지원. `--user`는 생성되는 Linux 기본 사용자다.
- `orbctl config --help`: `get/show/set/reset/docker` 관리 명령. 값을 읽거나 설정하지 않음.
- `orbctl start --help`, `orbctl export --help`: start/export 구문만 확인. export는 기존 machine을 pause한다는 설명이 있으므로 운영 read-only 검사로 실행하면 안 됨.
- `orbctl docker --help`: engine context가 `orbstack`이며 `docker.set_context false`는 자동 선택을 멈추는 설정이라고 설명. endpoint 권한을 바꾸는 기능이라는 설명은 없다.
- `orbctl docker volume --help`, `orbctl docker volume export --help`: clone/export/import 및 아카이브 구문 확인. volume 이름을 인자로 넘기지 않음.
- `orbctl debug --help`: Pro debug, `--context`, `--fallback`(docker exec) 지원. 라이선스 상태는 조회하지 않음.
- `docker --help`, `docker context --help`: `--host`, `--context`, `--config`, TLS 관련 flag와 context create/export/import 등 확인. help의 기본 홈 경로는 이 보고에 복사하지 않음.
- `docker container inspect --help`, `docker container exec --help`, `docker container create --help`: inspect, exec `--user/--privileged`, create `--mount/--volume/--privileged` 구문 확인. 대상 container/image를 지정하거나 실제 명령을 실행하지 않음.

공개 help에서 macOS principal별 engine ACL, 관리 금지 UID, 봉인된 system service 설치 또는 app/CLI/volume/backup을 함께 제한하는 모드는 확인되지 않았다. help에 없는 것만으로 내부적으로 불가능하다고 결론 내리지 않는다. closed-source 제품이므로 비공개 구현을 추측하거나 reverse engineering하지 않았다.

## 저장소의 현재 경계 (소스 읽기만)

| 경로 | 읽은 계약/동작 | 보호 배치에서 필요한 변화 |
|---|---|---|
| `README.md:3`, `:1150` 부근; architecture AD-10/34 | SOT는 OrbStack Docker PostgreSQL 하나, 로그인 UID의 context 선택과 engine 선행 조건 | 현재 단일 SOT 유지. 단순 local PG/다른 engine 전환은 정책 변경이다. |
| `apps/cli/src/runtime/orbstack.ts:6` | `orb status`, context show, Docker server version, Compose를 현재 env로 검사한다. container 상태와 volume inspect도 직접 호출한다. | 보호 engine에 로그인 UID가 닿지 않는 배치에서는 이 직접 probe를 성공 조건으로 쓸 수 없다. 서비스의 제한된 readiness attestation이 필요하며 실제 engine 신원과 연결해야 한다. |
| `apps/cli/src/install/postgres.ts:14` | `postgres:18`, named volume, localhost publish, `POSTGRES_PASSWORD` env, unless-stopped. setup이 volume 검사·compose up·관리 role/schema/migration을 직접 수행한다. | login UID에서 compose/API/inspect/env/volume을 읽을 수 있으면 DB role보다 높은 권한이 남는다. setup/migration 관리 권한을 보호 서비스 설치 영역으로 옮기는 설계 필요. |
| `apps/cli/src/runtime/command-runner.ts:17`, `:28` | Compose에 사용자 home의 `.env`/compose 경로를 넘기며 caller PATH를 우선한다. | 보호 principal은 사용자 변경 PATH·compose·env를 신뢰하면 안 된다. 고정 검증된 실행물/인자/소유 config 필요. 이 코드는 실행하지 않았다. |
| `apps/cli/src/config/codec.ts:741`, `:747`, `:781` | `resolveStoreUrl`, `postgresSecrets`, `extensionAdminUrl`이 home의 `.env`/환경에서 app·관리 자격을 사용한다. | 현재 0600은 동일 UID 미승인 코드를 차단하지 못한다. 일반 CLI/hook은 좁은 API, 보호 서비스는 DB role·관리 자격으로 분리해야 한다. 실제 `.env`는 읽지 않았다. |
| `apps/cli/src/daemon/launchd.ts:13`, `:56` | 사용자 LaunchAgents와 `gui/<uid>` 도메인, shim 기반 daemon 실행 | 이 사용자 daemon의 KeepAlive는 보호된 engine 서비스 배치를 증명하지 않는다. 봉인 supervisor와 단일 소유권, 사용자 shim을 통한 승격 금지가 필요. |

이 표는 전체 g3 구현의 리뷰/완료 판정이 아니다. 계획상의 fake/staging 진전은 실제 OS/engine 격리와 분리하여 보고해야 한다.

## 배치 후보별 결정

1. **로그인 UID의 기존 OrbStack + 별도 broker/worker UID:** 요구 충족 근거 없음. login UID가 engine 소유자라면 DB 관리·원본 storage 제어가 남는다. broker의 코드 서명이나 PostgreSQL role은 이 우회를 제거하지 않는다.
2. **동일 engine에서 socket proxy/mTLS/AuthZ/context 교체만 수행:** 일부 API 통제 구성 요소는 공식 지원되지만 전체 요구를 충족하는 배치로는 미확인. OrbStack GUI·config·native file view·volume export·SSH·storage·engine 재시작을 함께 봉쇄해야 한다. proxy 우회와 key 노출을 별도 검증해야 한다.
3. **isolated Linux machine/Linux 별도 UID:** 공식 기능 지원은 확인했으나 host 관리자로부터 보호하는 방향이 아니므로 단독 해법으로 채택하지 않는다.
4. **별도 비관리자 macOS principal의 OrbStack 사용자 세션 + 보호 supervisor/broker:** 탐색 가치가 있는 미검증 후보. 멀티유저 출시가 근거 일부이나 서비스 계정/세션 수명·권한·모든 관리 우회의 공식 보증은 없다. login UID의 OrbStack과 engine/data를 공유하지 않는지, shared helper가 UID를 검증하는지, 접근 가능한 default socket이 어느 engine인지까지 확인 필요. UID/소켓 명명만으로 성공 선언 금지.
5. **root OrbStack/로그인 전 LaunchDaemon:** 현재 찾은 유지보수자 답변은 미지원이다. sudo 설치만 남았다고 분류하면 안 된다. 최신 공급사 확인 전 공식 배치로 제시하지 않는다.

추천은 후보 4의 지원 확인 및 폐기 가능한 별도 macOS 시험 환경에서의 증거 수집을 D1의 잔여 게이트로 남기는 것이다. 공식 지원이 없거나 실제 우회가 남으면 보호 배포 미완료/실패 닫힘을 유지하고, 별도 정책 결정 없이 local PG로 바꾸지 않는다.

## 실행 가능한 후속 검증 접근 (이번에는 미실행)

### 사전 조건

운영 Mac/DB에서 아래 명령을 돌리지 않는다. 사용자가 준비한 폐기 가능한 Mac/독립 시험 환경에서만 수행한다. 설치된 공식 OrbStack 버전, OS 버전, architecture, 공급사 지원 배치, 로그인 공격자 UID(L), engine owner(E), supervisor/broker 및 worker principal을 기록한다. 관리자/계정 생성/권한 승인/재부팅/업데이트는 사용자 수행이다. 실제 건강정보 대신 임의 canary를 넣은 PostgreSQL 하나와 시험용 volume/machine만 사용한다. 별도 환경의 fixture는 운영 SOT를 대체하거나 운영 두 번째 권위를 만들지 않는다.

공급사 문서/답변에서 endpoint와 data 경로를 먼저 얻는다. private storage를 무작정 탐색하거나 숨은 IPC를 추측하지 않는다. 각 검증은 E의 정상 대조군과 L의 비승격 거부 대조군을 짝지어 기록한다. timeout/engine 미기동/이름 오입력을 보안 거부로 세지 않는다. 거부 근거는 OS 권한/peer 신원 검증이어야 하며, E는 같은 순간 같은 시험 자원에 정상 접근할 수 있어야 한다.

| ID | 폐기 환경에서 실행할 동작 | 통과 관찰 |
|---|---|---|
| V01 API 전 경로 | E가 확인한 시험 endpoint마다 L에서 `docker --host "$TEST_ENGINE_SOCKET" ps`, 버전 포함 raw API 연결을 시도한다. `/var/run/docker.sock`, 문서상 per-user socket, TCP/TLS/SSH 및 context 경로 각각 확인. | L이 보호 engine의 관리 응답을 얻지 못하고 E는 성공. 단순 context 미선택은 통과가 아니다. |
| V02 context 우회 | L의 별도 임시 client config에서 `--context`, `--host`, `DOCKER_HOST`, 새 context/import/export를 조합한다. | client 설정 변경으로 E의 권한이 생기지 않음. E의 private key나 config를 L에게 복사하지 않는다. |
| V03 inspect/exec/create | 합성 DB container 대상으로 L의 inspect, `exec --user 0`, 같은 합성 volume을 mount하는 create/start 및 privileged/volumes-from 시도를 평가한다. 동작이 허용되면 즉시 실패로 기록하고 해당 fixture만 정리한다. | 어떤 경로도 DB env·canary·role 비밀을 얻거나 volume/DB를 변조할 수 없음. exec 차단만으로 create 경로를 생략하지 않는다. |
| V04 orb/GUI/IPC | L의 `orb`·`orbctl`에서 E의 시험 machine 선택/run·pull·push·clone·export·restart/config/debug 경로, L 세션 GUI의 container/volume/debug/settings 동작을 평가한다. | L이 E의 자원 관리/파일/설정 권한을 얻지 못함. L 자신의 별도 engine을 기동하는 성공은 E 접근과 구분한다. |
| V05 VM/SSH | 시험 machine의 `orb -m "$TEST_MACHINE" -u root id`, SSH machine/user 선택, shared helper/VM 관리 경로를 공급사 지원 절차로 평가한다. | Linux root 선택/SSH/helper를 통해 보호 engine/storage로 진입 불가. key/authorized_keys가 L에서 읽기·교체 불가. |
| V06 volume/native view | 공식 native view의 합성 container/volume/machine 경로에서 L의 read/write/open, `orb docker volume clone/export/import`를 시험한다. | canary 반출/변조/복제/새 mount 불가. Finder 숨김은 통과 근거가 아니다. |
| V07 원본/backup/restore | E가 문서에 따라 준비한 시험 data image와 외부 storage, 시험 archive·Time Machine 복원본에 대해 L의 열람/교체/restore 영향 평가. | 원본뿐 아니라 복제본·backup에서 canary·관리 자격 유출 불가, 구세대 복원으로 admission/latch를 되감아 보호 성공을 위조하지 못함. |
| V08 SQL/API | L의 localhost·container IP·domain/host-network에서 합성 SQL 접속을 시험하고, 공개 API의 임의 SQL/exec/credential 반환/role 선택 요청을 거부하는지 평가한다. | 좁은 API만 허용, DB 관리/app/broker credential을 L이 직접 얻지 못함. 네트워크 도달 불가만으로 storage 격리를 대신하지 않음. |
| V09 생명주기 | E/L logout/login·fast user switching·engine/app restart·cold reboot·정식 업데이트 후 V01–V08 재실행. 서비스 세션 부재/권한 취소/engine 불명 주입. | 항상 같은 단일 권위로 연결되거나 실패 닫힘. L 소유 engine/사용자 config로 fallback 없음, 승인 세탁·서비스 재생성으로 우회 없음. |
| V10 봉인 실행물 | L에서 shim·PATH·manifest·venv·compose·URL·env 교체, 잘못된 OS peer/패키지/세대·도움 프로세스 요청을 합성 fixture로 평가한다. | 관리자 권한/DB 자격/admission/latch 위조 불가. 보호 service 불명 시 auth prompt·실제 외부 HTTP 0. |

위 명령의 `$TEST_*`는 운영 이름에서 얻지 않고 시험 fixture 생성 시 기록하는 값이다. destructive 성격의 create/export/restart/config 시험은 read-only 조사 후속의 별도 설치/검증 범위에서만 한다. 실패 fixture 종료/제거도 식별된 시험 자원만 대상으로 한다. 검증 로그에는 home 절대 경로·비밀·raw inspect/env를 싣지 않고 고정 canary 판정과 endpoint 종류/UID 관계·오류 분류만 남긴다.

### 공급사에 사용자가 확인해야 할 질문

이번 조사에서는 외부 메시지를 보내지 않았다. 사용자가 공식 support에 다음을 구체적으로 확인할 수 있다.

- v2.2.5 이상에서 별도 비관리자 macOS 계정과 사용자 세션으로 engine 전체를 소유하고 주 로그인 UID의 적대 코드를 차단하는 배치가 지원되는가? 로그인 전/SSH-only/GUI session 유지 조건은 무엇인가?
- 해당 배치의 공식 service 설치·기동·재부팅·업데이트·TCC/권한 재승인 절차와 #1444/#1767/#2580의 현재 적용 범위는 무엇인가?
- shared helper, CLI/GUI IPC, Docker forwarding, `/var/run` symlink, SSH, VM/machine, native file view, volume export/clone, data image/backup/restore까지 principal별 접근을 어떻게 보장하는가? full management disable/ACL 공식 기능이 있는가?
- 사용자 editable engine config나 다른 세션의 app 실행으로 경계를 되돌릴 수 없는가? 보안 계약이 없다면 해당 사용 사례를 지원한다고 명시할 수 있는가?

## 사용자만 할 수 있는 것 / repo에서 구현할 수 있는 것

| 주체 | 가능한 후속 작업 | 그것만으로 해결되지 않는 것 |
|---|---|---|
| 사용자/운영자 | 공식 지원 답변 확보, 별도 시험 Mac/principal 준비, 관리자 설치·코드 서명 신뢰·OS 권한 승인, 로그인/재부팅/업데이트/backup 정책 검증, 16.9의 명시적 운영 이전 | 문서에 없는 engine 격리가 사용자 승인만으로 생기지는 않는다. 지원/격리 실패를 인증서나 클릭 대기 문제로 축소하지 않는다. |
| repo 구현 에이전트 (별도 구현 배정 시) | D1 staging/설치 manifest·권한 검사·미지원 사유, 봉인 경로/실행물 검증, 좁은 IPC/data API·DB role, 보호 supervisor 연결, fake attestation/합성 fixture, 기존 CLI/hook spool 의미 보존, 실패 닫힌 auth/HTTP | OrbStack 폐쇄 구현의 IPC/VM/GUI 권한을 repo 코드만으로 보증할 수 없다. 합성 성공·peer UID 일치·소켓 이름·code signing 하나를 실제 engine 격리 성공으로 승격할 수 없다. |
| 지휘자/정책 소유자 | D1 증거 기준 확인, phase checkpoint와 실제 배포 승인, 공식 지원 부재 시 요구와 정책의 재결정 | 이 조사 워커는 계획 상태 변경·다른 DB 배치 채택·운영 이전을 하지 않는다. |

조사 작업은 완료했다. 전체 관리 경로가 차단되는 공식 배치의 긍정 증거와 실제 OS 검증은 남아 있으며, 티켓 16.2 또는 D1 보호 배포 완료를 뜻하지 않는다.
