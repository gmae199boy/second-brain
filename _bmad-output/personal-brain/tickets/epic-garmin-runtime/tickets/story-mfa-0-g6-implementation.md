# g6 구현 중간 보고 — B2-1 구성 요소

## 변경

`extensions/garmin/native/sealed-registry.c`와 헤더에 고정 `queue.registry` 입력 검증 부품을 추가했다. 운영 함수는 owner 0을 강제하고, 열린 registry 디렉터리의 파일 소유자·모드·ACL·하드링크·digest를 기존 FD 검사기로 검증한다. 정렬된 SHA-256 전체 목록에 `bin/node`와 `cli/bin.js`가 있어야 하고 기존 bundle 검사기로 등록되지 않은 파일·디렉터리·링크와 변조를 거부하며, Node 파일의 strict 코드 서명과 registry cdhash를 확인한다. 시험 전용 owner 주입은 컴파일 매크로 뒤에 있고 운영 API에는 없다. registry 디렉터리와 payload 디렉터리 FD의 안전한 출처는 호출자의 미구현 책임이다.

## 검증

- `sh extensions/garmin/native/tests/check-sealed-registry.sh`: 종료 0. 사용자 소유 합성 Node·JS·loader와 ad-hoc 서명으로 정상 및 파일 변조·미등록 파일·registry/디렉터리 쓰기 권한·확장 ACL·하드링크·서명 hash 불일치·목록 누락·중복 형식·registry symlink를 거부했고 일반 사용자 소유 registry가 root 운영 함수에서 거부됨을 확인했다.
- `sh extensions/garmin/native/tests/check-sealed-files.sh`: 종료 0. 기존 소유권·ACL·경로·bundle 부정 시험 통과.
- `git diff --check`: 종료 0. 별도 `sudo -n true`는 환경에서 `operation not permitted`로 실행할 수 없어 root 소유 실기는 수행하지 못했다.
- 실제 CLI package 후보 확보를 위한 `pnpm --filter @second-brain/cli deploy --legacy /tmp/brain-g6-cli-package`는 npm DNS 조회 실패로 중단했다. 운영 DB·tokenstore·Garmin 네트워크·배포는 사용하지 않았다.

## 범위와 남은 일

이것은 **B2-1의 완료 증거가 아니다**. 실제 Node/CLI/loader 및 전체 의존성 closure의 고정 입력 생성·검증과 보호 root 설치, 신뢰 가능한 기준 FD 공급, 이 registry를 spawn에 연결하는 작업은 아직 없다. 합성 목록 전체 검사는 Node가 외부 JS·native module·동적 라이브러리를 로드할 수 없다는 증거가 아니며, 현재 spawn은 Node용 고정 CLI argv도 제공하지 않는다. 실제 서명·별도 principal·OS peer·주입/대리·재연결 검증도 미완료다. 운영 queue/auth/HTTP는 닫힌 상태이며 B2 나머지와 B3–B6, D5–D7, 전체 행렬 및 독립 리뷰를 유지한다. 계획·티켓 상태와 커밋은 변경하지 않았다.

## B2-1 후속: 로컬 CLI 후보와 고정 Node spawn 구성 요소

기존 로컬 `rolldown` 1.2.12와 `apps/cli/dist/bin.js`로 네트워크 없이 단일 JS 후보를 생성하고, 로컬 Node의 합성 서명과 두 파일의 고정 registry를 만드는 시험을 추가했다. `sh extensions/garmin/native/tests/check-local-cli-registry.sh`는 후보를 기존 registry 검사기로 검증하고, 고정 환경의 실제 Node로 CLI 도움말을 실행한 뒤 JS 변조를 거부했다. 이 후보는 임시 시험 산출물이며 배포 패키지나 라이선스 재배포 검토를 완료한 산출물이 아니다. 번들러는 현재 직접 고정된 빌드 의존성이 아니라 기존 개발 의존성의 전이 설치물이므로 재현 가능한 릴리스 도구로 아직 확정하지 않았다.

registry 검사 전후의 고정 Node spawn 부품을 추가했다. 고정 payload 경로의 `bin/node`, `cli/bin.js`, `--sealed-queue-client`, `/` 작업 디렉터리 및 PATH/LANG만 있는 환경을 사용하고 FD 5·6만 추가로 넘기며 자식은 중지 상태로 반환한다. `sh extensions/garmin/native/tests/check-sealed-registry.sh`는 합성 JS로 고정 argv·cwd·환경, 서명 및 변조 거부를 재검증했다. `git diff --check`도 종료 0이다. 이 부품은 기존 운영 launcher에 연결하지 않았으며 실제 OS peer 승인 또는 제품 transport가 아니다.

**아직 B2-1 완료가 아니다.** 실제 CLI 번들에는 선택적 `__require("pg-native")`가 남으며 외부 모듈 로딩 불가능을 입증하지 못했다. 이는 시험이 명시적으로 검출하는 반례다. Node가 다른 파일이나 native 라이브러리를 읽는 범위와 CLI의 런타임 동적 로딩·의존 전체·제3자 라이선스를 분석하고 봉인하는 작업, 실제 `--sealed-queue-client` 제품 진입점과 registry의 신뢰된 root 디렉터리 FD 출처 및 설치는 미완료다. 현재 실제 CLI에서 해당 인자는 지원되지 않으므로 이 spawn 부품을 운영 경로로 연결하거나 peer 신원 증거로 사용할 수 없다. Node 권한 플래그만으로 적대적 JS의 OS 격리를 입증했다고 주장하지 않는다. 합성 시험은 실제 root 설치·principal·서명 정책·운영 폐쇄 로딩의 증거가 아니며 기존 실패 닫힘을 유지한다.

## B2-1 후속: 제한 queue 후보 및 경로 고정

`sealed-queue-client.ts`는 기존 `runQueueList` 렌더러와 `protectedQueueClient` 요청·응답 검증을 재사용하며 Store·환경·DB 자격을 받지 않는다. `sealed-queue-entry.ts`는 이 기능을 내보내지만 검증된 native 연결이 없으므로 현재 입력·FD·네트워크를 읽지 않고 종료 코드 2로 닫힌다. 제품 정상 호출이나 peer 인증 완성은 아니다. `rolldown` 1.2.12를 직접 개발 의존성과 lockfile에 고정했다. 로컬 build의 이 제한 진입점 단일 번들은 약 29 KB이며 현재 확인된 포함 모듈은 저장소의 Core envelope/queue와 CLI queue 코드뿐이고, 앞선 전체 CLI 후보의 `pg-native`를 포함하지 않는다. `check-local-cli-registry.sh`는 현재 후보에 남은 `__require(`·`import(` 문자열을 거부한다. 문자열 검색은 모든 동적 로딩과 주입에 대한 보안 증명이 아니다.

`sealed-registry.c`의 spawn은 열린 payload·Node·CLI의 inode와 실행 경로를 전후 대조한다. 운영 owner 0에서는 `/`부터 registry와 payload 기준 FD까지 root 소유·쓰기 금지·ACL 부재인 디렉터리를 `O_NOFOLLOW`로 재개방해 같은 inode인지 spawn 전후 확인한다. 합성 fixture의 spawn 직전 payload 경로를 이동하고 symlink로 교체하면 중지된 자식을 종료하고 거부한다. 이 검사는 실제 root 설치·launchd principal 및 OS에 의한 JS 로더 격리를 증명하지 않는다.

검증: `pnpm build`, `pnpm typecheck`, `pnpm exec vitest run --config /tmp/brain-g6-vitest.config.mjs`(독립 설정의 새 시험 1건), `sh extensions/garmin/native/tests/check-sealed-registry.sh`, `sh extensions/garmin/native/tests/check-local-cli-registry.sh`, `git diff --check` 종료 0. 새 시험은 동일한 기존 목록 결과·요청 필드와 transport 부재 실패를 확인한다. 기본 Vitest 설정은 Docker 접근 불가로 시작하지 못해 DB를 사용하지 않는 독립 설정을 사용했다. 의존성 고정 뒤 pnpm 동기화가 기존 `node_modules`를 제거하고 DNS 제한으로 중단됐으나, 권한 상승된 `pnpm install --frozen-lockfile --ignore-scripts`로 lockfile 기준 70개 패키지를 로컬 저장소에서 복구한 뒤 위 검사들을 재실행했다.

릴리스에 필요한 Node 및 제3자 라이선스 수집·검토, 빌드 산출물의 완전한 재현성·모든 loader/native 라이브러리 경계, 실제 인증된 native transport를 통한 제한 진입점 정상 동작과 기존 CLI의 인자·envelope 전체 동등성은 미완료다. Node 실행물과 OS 라이브러리는 별도 배포 라이선스와 서명 검토가 필요하며, 단일 bundle 모듈 목록은 소스·빌드 환경의 신뢰성을 보증하지 않는다. root 실제 설치·FD 출처와 상대 인스턴스·주입/대리·재연결, B2 이후 전체 작업도 남는다. 이 단위는 B2-1 전체 완료가 아니고 운영 queue/auth/HTTP는 닫혀 있다.

## B2-2: 고정 Node·native peer 합성 사슬

제한 entry는 고정 인자에서 FD 5에 bootstrap 신호를 보낸 뒤 FD 6의 ACK 전에는 stdin을 읽지 않는다. ACK 뒤 제한된 queue 옵션을 읽고 기존 `sealedQueueList`·`protectedQueueClient`로 일반 frame을 왕복하며 기존 목록 변환 결과를 출력한다. 부재·잘림·불량 입력은 닫히고 Store·사용자 PG fallback 경로는 없다. 이 진입점은 아직 운영 CLI 또는 운영 서비스에 연결하지 않았다.

`node-queue-gateway-fixture.c`는 합성 registry에서 Node를 고정 spawn하고 실제 Node PID·UID·서명을 OS peer로 확인한 뒤 ACK한다. 별도 native 서비스 fixture도 gateway와 양방향 OS PID·UID·서명을 검증하고 제품 handler 프로세스에 frame을 중계한다. `sealed-node-peer.test.ts`는 정상 요청의 옵션·결과, Node 해시와 PID 불일치·ACK 거부, 서비스 해시와 PID 불일치, 살아 있는 Node 연결을 다른 socket으로 교체, 미등록 JS 추가 및 고정 JS 변조의 거부를 확인했다. 부정 사례는 제품 handler 요청 0이다. `BRAIN_G6_PG=1`은 별도 서비스 프로세스의 실제 `requestQueueFrame`·Core·새 격리 PostgreSQL에 연결해 enqueue한 일감이 목록에 나타남을 확인한다.

검증: `BRAIN_G6_PG=1 pnpm exec vitest run apps/cli/test/sealed-node-peer.test.ts apps/cli/test/sealed-queue-client.test.ts` 2개 파일 2건 통과, `sh extensions/garmin/native/tests/check-sealed-registry.sh`, `sh extensions/garmin/native/tests/check-data-peer.sh`, `sh extensions/garmin/native/tests/check-local-cli-registry.sh`, `pnpm build`, `pnpm typecheck`, `git diff --check` 종료 0. native peer 회귀는 살아 있는 상대의 교체 거부 표식을 출력했다. 최초 격리 DB 실행의 정상 합성 경로는 서비스 fixture가 응답 직후 종료해 OS 신원 후검증과 경합하며 종료 9로 실패했다. 서비스가 gateway 연결 폐쇄까지 살아 있도록 수명을 동기화한 뒤 위 최종 재실행은 통과했다. 격리 Docker 접근은 권한 상승으로 수행했으며 운영 DB는 사용하지 않았다.

**B2-2 전체 완료는 아니다.** 합성 gateway와 별도 native 서비스는 같은 사용자 소유의 시험 코드이며 제품 서비스 설치·별도 principal이 아니다. Node entry 자체는 FD 6 ACK가 올바른 보호 launcher에서 왔는지 OS API로 독립 검증하지 않으므로 임의 부모가 가짜 FD와 ACK를 만들 수 있다. fixture는 서비스 측에서 Node의 정확한 PID를 검사하지만 이 사실만으로 실제 사용자에게 가짜 서비스 출력이 불가능하거나 임의 JS의 helper 대리 호출이 거부된다고 증명하지 않는다. JS 제품 서비스와 native 서비스 fixture 사이의 파이프도 운영 인증 transport가 아니며 명시적 재연결 정책·같은 UID 직접 대리 공격의 제품 사슬 시험은 남는다. 기존 CLI dispatch의 envelope·텍스트 전체 동등성과 신뢰된 설치·loader·서명·실제 보호 엔진 및 전체 잔여 작업도 미완료다. 따라서 운영 queue/auth/HTTP는 열지 않았다.

## B2-2 후속: 제품 launcher 부품과 Node의 상대 검사

`queue-peer-addon.c`는 빌드 시 고정된 launcher UID·cdhash와 현재 부모 PID를 사용해 Node의 FD 5·6에 연결된 OS peer를 검사한다. 고정값 기본값은 거부이며 Node 제한 entry는 bootstrap 신호 전과 ACK 직후 양쪽 상대, 각 일반 frame 전후 data peer를 검사한다. 합성 시험에서 같은 UID 임의 부모가 제공한 가짜 FD·ACK는 요청과 출력 전에 거부된다. addon은 `cli/peer.node`의 고정 bundle 목록에 포함해야 한다. 그 파일 자체의 별도 코드 서명 정책 및 실제 설치된 launcher pin은 아직 검증하지 않았다.

제품 소스 `queue-launcher.c`는 신뢰된 내부 조립이 제공한 서비스 UID·PID·해시를 OS peer로 확인하고, root registry의 Node 해시를 읽어 고정 Node를 spawn한 뒤 실제 자식 PID·서명을 검증해서만 bootstrap ACK를 보낸다. 서비스와 Node 사이 하나의 frame 왕복에 기존 `data-peer` 검증을 사용하며 재사용을 허용하지 않는다. 오류는 연결을 닫고 자식을 정리한다. fixture 전용 owner 선택과 합성 서비스는 별도 컴파일 경로이며 운영 함수의 registry owner는 root다. 보호 조립이 실제 서비스 PID·서명·FD를 신뢰된 설치에서 공급하고 생명주기를 소유하는 제품 경로는 아직 연결되지 않았으므로 이 함수의 인자를 사용자 요청에 노출해서는 안 된다.

`BRAIN_G6_PG=1 pnpm exec vitest run apps/cli/test/sealed-node-peer.test.ts apps/cli/test/sealed-queue-client.test.ts` 2개 파일 2건 통과. 별도 native fixture가 제품 launcher 함수를 호출해 고정 Node → 검증 서비스 → 실제 제품 handler → 격리 PG 목록을 왕복했고 가짜 부모 ACK, 서비스 PID·서명 불일치, 이전 합성 사슬의 변조·교체 거부도 확인했다. `pnpm build`, `pnpm typecheck`, `sh extensions/garmin/native/tests/check-sealed-registry.sh`, `sh extensions/garmin/native/tests/check-local-cli-registry.sh`, `sh extensions/garmin/native/tests/check-data-peer.sh`, `git diff --check` 통과했다. 마지막 정리 오류 경로 보강 뒤 제품 launcher는 `xcrun clang -Wall -Wextra -Werror -Wno-deprecated-declarations -c extensions/garmin/native/queue-launcher.c -o /tmp/brain-g6-queue-launcher.o`로 재컴파일했다. 첫 addon 실행은 ACK 송신자가 검증 도중 FD를 먼저 닫아 실패했고 송신 측 수명을 고정한 뒤 통과했다.

이는 root 설치·별도 principal·실제 서비스 프로세스 소유, 서비스 신원과 addon pin의 보호된 출처, addon 코드 서명·전체 loader·라이선스, OS 주입 방지, 실제 운영 transport, 같은 UID helper 대리·재연결 전체 행렬을 입증하지 않는다. 제품 launcher 시험의 서버는 합성 native 자식이며 제품 handler는 그 뒤 별도 파이프의 격리 Node 프로세스다. 검증 전 운영 queue/auth/HTTP는 열지 않으며 B2-2 전체와 이후 B2-3/B3–B6·D5–D7·전체 독립 리뷰는 미완료다.

## B2-2/B2-3 후속: 신원 출처·addon 서명·그룹 정리 부분

registry 형식을 v2로 바꿔 Node와 `cli/peer.node` 각각의 cdhash 및 파일 digest를 고정하고 두 파일 모두 strict 코드 서명을 확인한다. 합성 addon 해시 불일치와 기존 파일 변조를 거부한다. 실제 배포 서명·고정 pin 생성 및 라이선스 검토는 별도다.

`queue-host.c`는 빌드에 고정된 supervisor UID·서명과 실제 부모 PID를 OS peer로 검증한 뒤에만 그 연결에서 서비스 UID·PID·해시와 socket FD를 받아 제품 launcher에 전달한다. 기본 pin은 빈 값이라 제어 입력을 읽지 않고 닫힌다. supervisor 메시지는 일반 사용자 요청에서 신원을 선택하게 하는 API가 아니다. 현재 이 함수는 실제 보호 supervisor·기본 CLI transport에 조립되지 않았고, 정상 인증된 supervisor 및 실제 서비스의 제품 사슬 시험도 아직 없다. 따라서 이 소스를 운영 host 완성이나 보호된 pin 생성으로 취급하지 않는다.

고정 Node는 별도 프로세스 그룹에서 시작한다. `brain_queue_session_close`는 leader와 그룹의 결합을 확인한 경우에만 그룹을 종료하고, leader reap 및 그룹 부재가 확인되지 않으면 `cleanup_unknown`과 0을 반환한다. 종료 대기는 2초로 제한한다. 합성 fixture는 FD를 물고 있는 손자를 포함해 그룹 종료와 EOF를 관찰하고, 이미 reap되어 신원 확인이 불가능한 PID는 불명으로 남고 반복 close도 성공으로 바뀌지 않는 것을 확인한다. 실제 supervisor가 이 불명 상태를 영속 fence에 연결하는 작업과 별도 principal·그룹 이탈 후손 검증은 남는다.

`BRAIN_G6_PG=1 pnpm exec vitest run apps/cli/test/sealed-node-peer.test.ts apps/cli/test/sealed-queue-client.test.ts` 2개 파일 2건 통과. 이 시험은 제품 launcher fixture의 단회 relay 재사용 거부와 미등록 JS 추가를 통한 대리 시도 거부도 확인한다. 이는 root 설치된 launcher의 임의 JS 호출·다른 실행 인스턴스·재연결 전체 공격 행렬의 증거가 아니다. `sh extensions/garmin/native/tests/check-sealed-registry.sh`, `sh extensions/garmin/native/tests/check-local-cli-registry.sh`, `pnpm typecheck`, `git diff --check` 종료 0. `queue-host.c`와 그 기본 pin 거부 fixture를 native 전체 링크로 컴파일하고 실행해 종료 0을 확인했다. 모든 합성 테스트 및 별도 격리 DB 범위 밖의 운영 queue/auth/HTTP는 닫혀 있다.

**이 단위 전체는 미완료다.** 인증된 supervisor의 실제 instance·PID·socket 공급과 제품 서비스 process 소유, `queue-host`의 양성·가짜 supervisor 및 helper 대리 호출 검증, 기본 CLI transport·기존 출력 동등성, 실제 root 설치·pin 신뢰 사슬, 재연결·FD 교체·그룹 정리 불명 상태의 영속 복구가 남는다. B2-3·B3–B6, D5–D7과 전체 검증·독립 리뷰를 줄이지 않는다.

## B2-3 후속: supervisor–host 양성 사슬과 영속 fence

서로 다른 합성 서명 native supervisor·host·service 프로세스를 추가했다. supervisor가 실제로 spawn한 host의 OS PID·UID·서명을 확인해 서비스 PID·서명과 socket을 인증된 FD 전달로 공급하고, host는 고정 supervisor pin과 부모 PID를 검증해 제품 `queue-host` → 제품 `queue-launcher` → 봉인 Node/addon → 검증 서비스 → 제품 `requestQueueFrame`·Core·격리 PostgreSQL로 목록을 왕복했다. 가짜 supervisor와 supervisor가 살아 있는 동안 제어 연결을 끊는 경우를 거부한다. host는 제어 연결을 세션 동안 보존하고 frame 중계 전후 OS 신원과 연결 폐쇄·예상 밖 입력을 확인한다. 제품 launcher fixture에서 다른 service PID/해시, Node FD 교체, 단회 중계 재사용 및 bundle 밖 JS 추가도 거부했다. 이 supervisor와 native service는 시험용 프로세스다. 제품 handler는 별도 Node 프로세스에서 실제 `createProtectedService`를 쓰지만 기존 `runProtectedSupervisor`가 이 native host를 spawn하거나 service socket의 실제 소유자 신원을 공급한 것은 아니다.

`0032_protected_queue_host_fence.sql`은 보호 supervisor만 단일 queue host admission과 종료를 기록하도록 한다. 시작 직후 crash·쓰기 응답 불명은 `running`을 남겨 새 시작을 막고, `cleanup_unknown`은 `unknown`으로 보존하며 확인된 종료만 `running`을 지운다. 일반 `brain_app`은 함수 실행 권한이 없다. `postgresQueueHostFence` adapter와 기존 `createProtectedService`의 내부 `serveQueueHost` 경로는 영속 admission 성공 뒤에만 공급된 보호 runner를 시작하고, runner의 불명·예외 또는 DB 실패에서 실패 닫힘이다. 이 runner는 아직 native host의 실제 종료 증거에 연결되지 않았고 설치된 서비스도 해당 port를 공급하지 않는다. 따라서 native `cleanup_unknown`의 실제 운영 영속 fence 연결이 완성됐다는 뜻이 아니다. 불명 행은 자동 해제하지 않으며 검증된 복구 절차는 미완료다.

`BRAIN_G6_PG=1 pnpm exec vitest run apps/cli/test/protected-queue-host.test.ts apps/cli/test/sealed-node-peer.test.ts apps/cli/test/sealed-queue-client.test.ts packages/postgres/test/protected-queue-host.test.ts` 4개 파일 5건 통과. 별도 격리 PostgreSQL에서 일반 role 거부, 동시 admission 하나, 확인 종료 후 재시작, 불명 후 재시작 거부와 실제 보호 role adapter 연결을 끊었다 다시 여는 경우를 확인했다. `pnpm build`, `pnpm typecheck`, `git diff --check`도 통과했다. host 초기 양성 시험의 실패는 비차단 제어 socket을 동기 EOF처럼 읽고 supervisor가 먼저 닫은 점, 서비스 시작 신호를 frame 앞에서 소비하지 않은 점을 각각 수정한 뒤 통과했다. 병렬 전체 검증 중 별도 합성 Node gateway가 한 번 종료 9였고 당시 내부 단계는 기록되지 않았다. 진단을 추가한 뒤 결합 재실행 및 단독 5회는 통과했으나 최초 원인은 미확인이다.

**B2-3은 아직 미완료다.** 기존 보호 supervisor가 실제 host·서비스를 spawn하고 registry/pin·정확한 instance를 공급하는 제품 설치 조립, 실제 native 종료/그룹 불명과 위 DB fence adapter의 연결, root 소유 신뢰·별도 principal·엔진 격리 및 기본 CLI transport와 텍스트/JSON 동등성은 미검증이다. 합성 supervisor 실행물을 임의 JS가 호출하는 경우와 승인된 실 supervisor의 대리 호출 방지 및 재연결 전체는 별도 검증이 필요하다. 시험 host fixture는 leader를 직접 기다리므로 운영 그룹 종료 확정의 증거가 아니다. 위 부분 구현을 완료나 실제 외부 작업만 남은 상태로 세지 않으며 운영 queue/auth/HTTP는 닫혀 있다.

## B2-3 후속: 기존 보호 서비스의 native host·영속 fence 연결

`queue-supervisor-host.c`는 고정된 보호 supervisor UID·서명과 부모 PID를 FD 3·4의 OS peer로 검증하고, 컴파일에 고정된 registry/payload에서 봉인 Node를 시작한다. 일반 요청으로 경로·서명·상대 PID를 지정하지 않는다. 두 pin과 경로의 기본값은 비어 있어 닫히며 실제 root 설치·보호 principal이 확인되기 전 활성화하지 않는다. `queue-host-runner.ts`는 기존 `createProtectedService`의 제품 handler를 host 서비스 채널에 연결하고 host의 종료 증거를 `serveProtectedQueueHost`와 PostgreSQL fence에 전달한다. 설치용 runner는 고정 host 경로의 root 소유·ACL·서명 pin 확인을 요구한다. 제한 Node는 기존 목록 변환을 실행하며 검증된 서비스 frame도 반환해 기존 CLI 렌더러가 그대로 처리한다.

`apps/cli/test/queue-host-product.test.ts`는 기존 `createProtectedService` 객체가 별도 native host와 봉인 Node/addon을 실제로 시작하고, 제품 handler·Core·격리 PostgreSQL을 거친 결과를 기존 `dispatch`의 JSON envelope 및 텍스트와 대조한다. 실제 `postgresQueueHostFence`와 보호 DB role을 사용해 정상 종료 후 fence 제거, addon 변조 시 거부·사용자 Store 생성 0, host SIGKILL 후 `unknown` 보존, DB adapter 재연결·서비스 객체 재생성 뒤 새 host 시작 0을 확인했다. 이 시험의 설치 경로·pin·UID와 CLI transport 공급은 명시적인 합성 fixture다. `BRAIN_G6_PG=1 pnpm exec vitest run apps/cli/test/queue-host-product.test.ts apps/cli/test/protected-queue-host.test.ts apps/cli/test/protected-queue.test.ts apps/cli/test/sealed-node-peer.test.ts apps/cli/test/sealed-queue-client.test.ts packages/postgres/test/protected-queue-host.test.ts`: 6개 파일 9건 통과. `pnpm build`, `pnpm typecheck`, `sh extensions/garmin/native/tests/check-sealed-registry.sh`, `sh extensions/garmin/native/tests/check-local-cli-registry.sh`, `git diff --check`도 통과했다.

이것은 연결된 제품 구성 요소의 격리 사슬이지만 **B2-3 전체 완료가 아니다**. 기본 사용자 CLI는 아직 인증된 운영 transport를 갖지 않아 계속 서비스 부재로 닫히며 위 시험은 transport를 주입한다. 실제 `runProtectedSupervisor`가 설치된 host runner·DB fence를 받아 상주하고 고정 서비스 socket을 소유하는 운영 조립, root registry와 pin의 생성·설치, 보호 principal/OrbStack 관리 경계, 같은 UID 임의 JS가 정당한 helper를 대리 호출하는 실제 제품 진입점과 재연결 공격은 증명되지 않았다. 정상 시험에서 서비스 객체는 실제 제품 객체이나 동시에 감독 loop를 실행하지 않는다. 별도 principal·root 실기, loader와 라이선스 검증, 나머지 B3–B6·D5–D7 및 전체 행렬·독립 리뷰도 그대로 남는다. 운영 queue/auth/HTTP는 열지 않았다.

## B2-3 후속: 상주 감독자와 queue-only 기본 transport

`createProtectedService.run()`은 기존 `runProtectedSupervisor`와 보호 queue endpoint를 같은 취소 수명으로 소유하며, 감독자 readiness 전·오류·종료 중에는 endpoint 요청을 `SERVICE_UNAVAILABLE`로 닫는다. 한쪽 종료 시 다른 쪽을 취소하고 양쪽 정리를 기다린다. `queue-endpoint.c`는 고정 supervisor UID·서명·실제 부모 PID를 FD 3·4에서 확인하고, root 소유 고정 정책의 client UID·cdhash에 해당하는 native client와 매 연결마다 OS peer를 검사한다. client는 고정 endpoint UID·cdhash를 OS peer로 검증하며 queue frame만 제품 handler에 전달된다. 기본 CLI `queue list`는 고정 root 소유 pin과 고정 서명 native client를 검사해 transport를 구성하고 실패 시 사용자 PG fallback 없이 닫는다. pin·경로·환경은 사용자 명령 인자가 아니다.

감독자의 보충 해석에 따라 정상 CLI와 그 queue 전용 helper는 임의 JS가 실행할 수 있으며 일반 조회 자동화를 금지하지 않는다. 이는 인증 승인으로 취급되지 않는다. endpoint는 `queue.list.v1`만 host runner에 허용하므로 합성 JS에서 정당한 helper로 일반 조회 두 번은 성공했지만 `auth.approve` 프레임은 거부했고 host 시작은 0이었다. 별도로 다른 코드 서명 client, 다른 서버 서명, 가짜 supervisor, 끊긴 supervisor 제어 연결, Node/service PID·서명 불일치, Node FD 교체와 중복 relay를 거부했다. 연결마다 새 helper가 다시 OS peer를 확인한다. root 소유 pin의 쓰기 권한·ACL·잘못된 형식·symlink 거부는 별도 합성 시험으로 확인했다.

기존 `runProtectedSupervisor`를 실제 실행한 `queue-host-product.test.ts`는 감독자 준비 barrier 전 요청 거부·host 시작 0, 준비 후 합성 native endpoint → 고정 client → 기존 보호 서비스 → 봉인 host/Node → 제품 handler·Core·격리 PostgreSQL의 정상 queue JSON 및 텍스트를 대조한다. host SIGKILL 뒤 실제 보호 DB fence `unknown`이 adapter 재연결·서비스 객체 재생성 후에도 재시작을 막는 시험도 유지한다. `BRAIN_G6_PG=1 pnpm exec vitest run apps/cli/test/queue-host-product.test.ts apps/cli/test/protected-queue-host.test.ts apps/cli/test/protected-queue.test.ts apps/cli/test/sealed-node-peer.test.ts apps/cli/test/sealed-queue-client.test.ts packages/postgres/test/protected-queue-host.test.ts`: 6개 파일 10건 통과. `pnpm build`, `pnpm typecheck`, `git diff --check`, `sh extensions/garmin/native/tests/check-queue-policy.sh`, `check-sealed-registry.sh`, `check-local-cli-registry.sh`, `check-data-peer.sh` 통과했다. 경합 진단이 없던 합성 gateway 종료 9는 병렬 실행에서 한 번 재발했고 진단 추가 후 관련 병렬 4회와 최종 결합 실행은 통과했으나 최초 내부 원인은 미확인이다. readiness 시험 최초 실행은 fixture가 실제 core schema 27 대신 1을 기대해 준비되지 않았고, 실제 상수를 사용한 뒤 통과했다.

**B2-3 및 실제 배포는 미완료다.** 상주 시험의 서명·UID·socket·pin은 합성이고 사용자 CLI transport도 fixture 실행물을 주입했다. 실제 root 설치·pin 생성, 별도 principal과 보호 OrbStack 엔진, 서명된 Node interpreter만이 아닌 supervisor의 전체 JS/loader closure 및 정확한 실행 instance는 아직 입증되지 않았다. 이 공백 때문에 `createInstalledProtectedService`는 queue 설치 설정을 명시적으로 거부하며 실제 기본 CLI도 설치 pin이 없으면 실패 닫힘이다. 이 gate를 임의로 제거하지 않는다. 보호된 설치 사슬에서 supervisor를 봉인·기동하고 신원과 fence를 공급해 운영 기본 endpoint에 연결하는 작업, 전체 같은 UID 대리·재연결/실제 OS 공격, B3–B6·D5–D7·T01–T28 및 독립 보안 리뷰가 남는다. 운영 queue/auth/HTTP는 열지 않았다.

## B2-3 후속: supervisor bundle·OS instance·내부 검증 계약

supervisor 전용 root registry profile을 추가했다. 고정 `bin/node`, `supervisor/main.js`, `supervisor/peer.node`, 전체 파일 목록·digest와 Node/addon strict 코드 서명을 검사하고 root에서 기준 디렉터리까지 재검증한 뒤 고정 argv·환경·프로세스 그룹으로 중지 상태 spawn한다. 열린 파일과 pathname을 spawn 전후 대조하며, 미등록 JS·본문 변조·상위 경로 교체는 자식을 재개하기 전에 거부한다. `supervisor-candidate.mjs`는 로컬 고정 Rolldown과 실제 제품 모듈을 포함하는 supervisor bundle·Node·addon·Node 라이선스 사본과 registry 후보를 만든다. 같은 입력의 두 staging manifest 해시가 일치했다. caller가 전달한 launcher pin은 **비권위 staging 입력**이며 root에서 독립 검증하거나 운영 서명·재배포 라이선스를 승인한 것이 아니다. 실제 제품 감독자 DB adapter·자격·모든 런타임 loader 및 native 라이브러리까지 포함한 최종 배포 closure는 아직 아니다.

`sealed-supervisor-launch.c`는 중지된 실제 자식의 PID·UID·부팅 시각·시작 시각·registry digest·Node cdhash를 2초 이내의 별도 자동 commit으로 `0033_sealed_supervisor_instance.sql`에 기록한 뒤 재개한다. OS peer와 동일 인스턴스·registry를 다시 검사하고 DB 확인 commit 뒤에만 bootstrap ACK를 준다. `sealed-supervisor-store.c`는 libpq 비차단 poll과 단조 clock으로 각 DB 호출 전체를 2초로 제한하고 commit 응답이 불명이면 연결을 재사용하지 않는다. crash·기록 또는 확인 응답 유실은 `starting`/`verified` 행을 남겨 다음 시작을 막는다. 그룹 종료가 확인된 경우에만 보호된 내부 release를 호출하며 불명은 남긴다.

supervisor addon은 고정 서명 native launcher와 양쪽 FD의 실제 부모 PID·UID를 확인한 뒤 ACK를 직접 읽어 프로세스 내부 단회 native capability를 만든다. 다른 객체와 중복 소비를 거부한다. supervisor entry는 이 ACK 전 제품 모듈을 평가하지 않는다. 현재 entry는 capability 검증과 `bootstrap-only` 신호까지만 수행하며 실제 `createInstalledProtectedService`를 시작하지 않는다. queue host와 endpoint의 운영 빌드는 `supervisor-authority.c`를 통해 root supervisor registry digest·서명, OS peer PID/UID·부팅/시작 시각 및 보호 DB의 `verified` 행이 모두 일치할 때만 부모를 수락한다. 고정 credential·registry 경로 기본값은 비어 있어 실제 설치 전에는 닫힌다. 합성 fixture 빌드는 별도 owner와 임시 DB를 명시적으로 사용한다.

`apps/cli/test/sealed-supervisor-product.test.ts`는 실제 봉인 Node 프로세스와 제품 native launcher/store를 임시 PostgreSQL에 연결해 추가 JS·본문 및 경로 교체, 가짜 부모, 기록과 확인 commit 응답 유실, 2초 lock 경합, 이미 reap된 leader의 종료 불명, launcher SIGKILL 뒤 verified 행과 재시작 차단을 확인했다. 실제 PID/UID·시작/부팅 시각과 registry digest를 DB와 대조하고, 실행 중 registry 파일 추가 또는 DB state 변경 시 OS peer/DB authority 조회가 거부됨을 확인했다. 시험용 bundle 계측은 확인 응답 유실 시 ACK 전 제품 모듈 평가 canary가 생기지 않고, 정상 ACK 뒤 생성됨과 native capability의 단회 소비·재사용 거부를 확인한다. 이 계측 bundle은 운영 파일이 아니다.

`BRAIN_G6_PG=1 pnpm exec vitest run apps/cli/test/sealed-supervisor-product.test.ts packages/postgres/test/sealed-supervisor-instance.test.ts apps/cli/test/queue-host-product.test.ts apps/cli/test/protected-queue-host.test.ts apps/cli/test/protected-queue.test.ts apps/cli/test/sealed-node-peer.test.ts apps/cli/test/sealed-queue-client.test.ts packages/postgres/test/protected-queue-host.test.ts` 8개 파일 12건 통과. `pnpm build`, `pnpm typecheck`, `node --test tooling/protected-deployment/supervisor-candidate.test.mjs`, `sh extensions/garmin/native/tests/check-sealed-registry.sh`, `check-queue-policy.sh`, `check-supervisor-production-build.sh`, `git diff --check` 통과. 생산 native host/endpoint는 pin이 없는 기본 빌드에서 시작 전에 닫힘을 확인했다. 최초 보호 SQL 독립 시험은 schema usage grant 누락으로 실패했고 grant 보강 뒤 통과했다. 합성 gateway의 이전 간헐 종료 9는 여전히 최초 내부 원인 미확인이다.

**supervisor 봉인 및 B2-3 전체는 아직 완료가 아니다.** 위 PID/DB authority 시험의 서명·UID·registry는 합성이며 실제 root 설치·별도 principal·보호 OrbStack 관리 경로는 입증되지 않았다. supervisor entry는 bootstrap 구성 요소일 뿐 실제 상주 보호 서비스·DB 자격·endpoint를 시작하지 않으며, queue 제품 사슬의 상주 감독자는 별도의 합성 process fixture에서 시험했다. 두 사슬을 실제 봉인 supervisor 실행 인스턴스 하나에 결합하고, 검증된 root 설치가 launcher pin·서명·전체 loader 및 권한을 공급하며 실제 종료 복구를 증명해야 한다. Node addon capability는 향후 factory gate의 한 입력이지만 `createInstalledProtectedService`의 실패 닫힘 gate를 제거할 근거가 아니다. 운영 queue/auth/HTTP를 열지 않았고 B3–B6·D5–D7·T01–T28 및 독립 보안 리뷰는 그대로 남는다.

## 지휘자 병렬 회귀의 합성 gateway 종료 진단 및 수정

지휘자의 독립 8파일 묶음은 `sealed-node-peer.test.ts` 정상 gateway가 종료 7을 반환했다(`/tmp/brain162g6-parent-supervisor-seal.log`). 당시 fixture는 종료 7의 내부 분기를 기록하지 않았다. OS crash 기록 `gateway-2026-11-01-161058.ips`는 같은 시각 gateway 자식의 `SIGSEGV`와 macOS Security 코드 서명 검사 중 SQLite·시스템 로그 초기화 stack을 보였다. 최초 출력에 자식 PID가 없어 이 crash와 종료 7을 숫자로 직접 결합할 수는 없지만 시각·프로세스·경로가 일치한다.

OS peer 기본 검사의 audit token·PID·UID 및 Security 오류와 frame의 poll/read 단계, 양쪽 자식 종료 상태를 `BRAIN_PEER_DIAGNOSTIC` 합성 빌드에만 추가했다. 같은 8파일 병렬 묶음을 진단 빌드로 반복한 `/tmp/brain162g6-peer-trace-2.log`에서 gateway가 서비스 응답 frame의 첫 4바이트를 기다리다 EOF를 받았고 서비스 자식 wait status 11, 즉 `SIGSEGV`였다. 대응 crash 기록 `gateway-2026-11-01-161406.ips`도 같은 Security → SQLite → 시스템 로그 초기화 stack이다. 그 뒤 Node의 `ENOTCONN`은 gateway가 실패 정리로 연결을 닫은 후 발생한 결과다. 이는 서비스 자식이 이미 Security 검사를 수행한 gateway에서 `fork`된 뒤 다시 macOS Security API를 호출하는 fixture 경로의 충돌을 직접 좁힌다. 최초 종료 7의 세부 분기는 여전히 사후 확정하지 않는다.

합성 서비스 자식을 `fork` 후 framework 호출 대신 동일 서명 실행물의 고정 `--service` 진입점을 `posix_spawn`으로 새로 실행하도록 바꿨다. PID·UID·cdhash 양방향 검사, 매 frame 전후 검증, bootstrap ACK와 상대 생존 장벽은 그대로 유지한다. 정상 시험은 별도 실행된 service PID와 부모 PID 진단도 확인한다. 운영 코드의 검사 조건은 완화하지 않았으며 진단 출력은 합성 매크로에만 있다.

동일 8파일 병렬 묶음은 수정 후 `/tmp/brain162g6-peer-exec-1.log`부터 `-8.log`까지 8회 모두 각 8파일 12건 통과했다. 최종 진단 조건 정리 후 같은 묶음 `/tmp/brain162g6-peer-exec-final.log`도 8파일 12건 통과했고, `pnpm build`, `pnpm typecheck`, `sh extensions/garmin/native/tests/check-data-peer.sh`, `check-supervisor-production-build.sh`, `git diff --check` 통과했다. 이 반복은 재현된 fork 경로의 수정 근거이며 모든 OS 환경의 무결함을 보증하지 않는다. supervisor bootstrap과 실제 상주 보호 서비스의 단일 인스턴스 결합, root/principal/엔진 실증과 나머지 전체 요구는 미완료이고 운영 queue/auth/HTTP는 닫혀 있다.

## B2-3 후속: 봉인 인스턴스와 상주 보호 서비스 연결

봉인 launcher는 supervisor 전용 FD 7에만 설정 프레임을 전달한다. addon은 launcher의 실제 PID·UID·서명을 FD 5와 7에서 확인하고, DB 인스턴스 확인 후 받은 ACK와 단회 capability가 있어야 설정을 한 번 읽는다. 제품 모듈의 평가와 DB·서비스 생성은 ACK 및 설정 검증 뒤에 시작한다. `createInstalledProtectedService`는 설치 설정이 없는 경우도 우회하지 않고 native capability를 정확히 한 번 소비해야 한다. 인증되지 않은 객체와 재사용은 거부한다. 현재 실제 배포 addon의 `deploymentReady()`는 항상 false이고 supervisor entry도 실제 배포에서 닫힌다. 양성 연결은 `BRAIN_SUPERVISOR_FIXTURE`와 `BRAIN_REGISTRY_FIXTURE`가 함께 지정된 합성 빌드에서만 허용한다.

합성 조립은 FD 7로 전달된 임시 보호 principal DB 자격과 고정 시험 경로를 사용해 실제 `createInstalledProtectedService` → `runProtectedSupervisor` → PostgreSQL fence → native endpoint 및 queue host → 봉인 Node → 제품 handler를 시작한다. Garmin worker 검증과 admission은 닫혀 있고 HTTP를 시작하지 않는다. endpoint와 host는 합성 전용 FD 8로 전달받은 임시 DB 연결에서 운영 코드와 같은 authority 검증 함수를 사용해 supervisor registry digest·서명과 정확한 OS PID·UID·부팅·시작 시각, DB `verified` 행을 연결마다 대조한다. 이 FD와 owner 선택은 fixture 전용이며 운영 credential 전달 방식의 증거가 아니다.

단일 봉인 supervisor 프로세스의 통합 시험은 기존 launcher의 기록·확인·ACK 뒤 실제 서비스와 endpoint를 시작하고 격리 PostgreSQL의 일감을 native client에서 조회했다. 동일 사슬에서 기존 CLI 텍스트·JSON 출력, auth 승인 frame 거부, DB 행을 `starting`으로 바꿀 때 요청 거부 및 `verified` 복원 후 정상 재연결을 확인했다. 기존 시험의 가짜 부모, registry 추가·변조, commit 응답 유실, launcher 종료와 정리 불명 보존도 유지한다. 별도 상주 서비스 회귀에서 준비 전 차단과 host 정리 불명의 영속 fence를 검증한다. 이 합성 시험은 실제 root 소유 설치나 별도 OS principal을 증명하지 않는다.

supervisor 후보 bundle은 PostgreSQL JS 의존성을 포함하고 선택적 `pg-native` 로더를 제거하며 남은 `require`와 동적 import의 리터럴 대상은 Node 내장 모듈만 허용한다. `peer.node`는 고정 경로 두 곳만 허용한다. Node와 발견된 제3자 라이선스 파일을 후보에 포함하고 별도 파일이 없는 `pg-types`, `pgpass`를 NOTICE에 기록했다. 이는 정적 검사와 라이선스 수집일 뿐 실제 OS loader 봉인·재배포 승인이나 운영 서명 검토가 아니다.

검증: `pnpm build`, `pnpm typecheck`, `node --test tooling/protected-deployment/supervisor-candidate.test.mjs`, `pnpm exec vitest run --project cli sealed-supervisor-product.test.ts queue-host-product.test.ts protected-queue-host.test.ts sealed-node-peer.test.ts`(4파일 6건), `git diff --check` 통과했다. 첫 시험 명령은 기본 설정에서 Docker 접근이 막혔고 권한 상승한 격리 시험 설정으로 재실행했다. 타입 검사의 fixture FD 튜플 오류는 수정 후 통과했다. 모든 DB와 자격은 시험 전용이며 운영 tokenstore·실계정·Garmin 네트워크·운영 배포를 사용하지 않았다.

실제 root 설치와 신뢰된 credential·pin 공급, 별도 principal 및 보호 OrbStack 엔진, 전체 native/동적 로더와 실행환경 격리, 중단·복구 및 같은 UID 공격 전체 행렬, B3–B6·D5–D7·T01–T28과 독립 리뷰는 미완료다. 운영 queue/auth/HTTP는 닫힌 상태이며 이 단계는 전체 완료가 아니다.

## B3 준비: 취소 프레임 구성요소

사용자의 계속 진행 지시 뒤 `queue.cancel.v1`의 서버 측 제한 입력·출력 구성요소를 추가했다. 중복 JSON 키, 추가 필드, 잘못된 operation·UUID는 Core 호출 전에 거부하며 기존 취소 결과 세 상태를 유지하고 내부 필드를 내보내지 않는다. 결과 ID가 입력과 다르거나 호출이 예외를 내면 고정 오류로 닫는다. 공통 프레임 파서를 재사용한다.

검증: `pnpm exec vitest run --project cli protected-queue-cancel.test.ts`는 격리 시험 환경 접근 권한으로 1개 파일 3건 통과했고, `pnpm typecheck`와 `git diff --check`가 통과했다. 기본 샌드박스에서는 Docker 접근이 거부되어 같은 시험을 시작하지 못했으나 권한을 부여한 재실행에서 통과했다.

이 구성요소는 아직 native endpoint·봉인 CLI·`protectedCommandStore`·실제 Core 또는 격리 PostgreSQL에 연결되지 않았다. 취소 권한과 broker revoke ACK·경합·불명 처리의 종단 검증 및 B3 나머지, B4–B6, D5–D7, 전체 행렬과 독립 리뷰가 남는다. 운영 인증과 HTTP는 닫혀 있으며 이 결과는 B3 완료나 배포 준비가 아니다.
