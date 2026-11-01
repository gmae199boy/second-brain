# 16.2 g3 D1 구현 보고

## 구현

`tooling/protected-deployment/stage.mjs`는 새 0700 임시 디렉터리에 0600 평가와 안내를 생성한다. 엔진 관리 API·VM·컨텍스트·볼륨·백업·inspect/exec/create·재부팅·업데이트를 각각 미검증으로 기록하고 인증 입력과 외부 HTTP를 false로 표시한다. 인자를 거부하며 운영 엔진·DB·토큰·네트워크에 접속하거나 설치하지 않는다. 이 결과는 OS 접근 제어도 런타임 허용 신호도 아니다.

## 검증

`node --test tooling/protected-deployment/stage.test.mjs`에서 격리 fixture 두 건이 통과했다. 별도 프로세스의 임의 검증 주장도 거부했다. `git diff --check`는 기존에 변경되어 있던 계획 파일의 마지막 빈 줄을 지적했다. 계획 파일은 수정하지 않았다.

## 한계와 남은 일

현재 평가는 미검증을 정확히 보존하는 기초 staging이며 보호 엔진의 실제 가능성이나 모든 동등 관리 경로의 거부를 검사하지 않는다. root 소유 패키지·정책 manifest, renderer/preflight/rollback, 별도 principal 접근 거부 fixture 및 재부팅·업데이트 실증은 미완료다. 기존 독립 보고의 소스 대조는 사용자 Docker 관리 경로가 권위 DB를 우회할 수 있음을 지적하며 실제 OrbStack 보호 배치를 증명하지 않았다. 인증 입력과 외부 HTTP를 열 근거는 없다. D1 전체 완료로 간주하지 말고 이 미완료 항목을 포함해 검토해 달라.

## 후속 보강

고정 역할·경로 정책 renderer와 digest manifest, root 소유·쓰기 권한 및 정책 변조 검사, 미검증 엔진·서비스 신원·서명을 거부하는 별도 프로세스 preflight, 낯선 파일이나 증거를 보존하는 staging 전용 rollback을 추가했다. `node --test tooling/protected-deployment/stage.test.mjs` 5건이 통과했다. 첫 실행에서 빈 디렉터리 삭제 오류를 발견해 수정하고 전체를 다시 실행했다.

여전히 실배치 가능한 root 소유 package 설치기, 보호 서비스 권한 정책과 상위 경로·ACL·경쟁 방어, 별도 UID 공격 fixture 및 엔진 동등 관리 경로 검사 구현이 없으므로 D1 완료가 아니다. 정책 digest는 서명이나 보호 권한의 증거가 아니며 preflight는 엔진 확인이 없어 항상 거부한다. 후속 구현이 필요하다.

## 경로 고정 단위

`path_guard.py`에 열린 기준 디렉터리부터 `openat`과 `O_NOFOLLOW`로 각 디렉터리 FD를 고정하고 소유자·쓰기 권한을 검사하는 부품을 추가했다. 고정 FD에서 일반 파일의 소유자·모드·하드링크 수·크기·SHA-256을 검사하는 부품도 추가했다. Python unittest 3건은 디렉터리 교체 후 기존 FD 유지, symlink·상위 이동·쓰기 가능 경로·내용 교체 거부 및 별도 프로세스 검사를 확인했다. 합성 UID를 사용한 fixture이며 실제 다른 principal이나 ACL, root 설치·서명·엔진 격리의 증거가 아니다. 이 부품은 아직 설치기에 연결되지 않았다.

## D1 추가 진행

새 fixture 디렉터리에만 검증된 원본을 복사하고 고정 역할·경로·환경 정책을 렌더링하는 설치 부품과 생성 중 오류 복구를 연결했다. macOS `acl_get_fd_np`로 열린 inode에 ACL이 없다는 사실을 확인하고 미지원·오류·ACL 존재는 거부한다. 임시 ACL을 실제 생성한 반례, 원본 변조, 부분 생성 실패, 고정 FD 및 별도 프로세스 반례를 포함한 Python unittest 7건과 Node 시험 5건이 통과했다. root에서부터 경로 소유권·ACL을 확인하고 principal 존재와 분리를 점검하는 사전 검사도 엔진과 서명 미검증이면 실패한다.

이는 fixture와 검사 부품이며 운영 설치기가 아니다. 실제 보호 실행물의 서명·패키지 봉인, 서비스별 소유 및 권한, 런처 연결, 별도 UID의 실제 거부와 운영 복구 구현은 남았다. 관리자 설치와 별도 principal 생성은 수행하지 않았다.

추가 fixture는 쓰기 가능한 상위 디렉터리와 hardlink 원본을 거부하며 부분 생성 복구 시 inode가 바뀌면 삭제를 중단한다. 별도 UID의 읽기·쓰기 거부 시험은 root와 미리 생성된 fixture UID가 없는 현재 환경에서 skip됐다. 현재 실행 결과는 Python 8건 통과·1건 skip, Node 5건 통과다. inode 확인 뒤 이름 기반 삭제 사이의 경쟁은 fixture 한계이며 보호된 부모 소유권 없이 운영 복구에 사용하지 않는다.

## D1 checkpoint와 후속 의존

독립 엔진 조사에서 공식 multiuser/headless는 확인했지만 로그인 UID의 모든 관리 경로가 거부되는 지원 배치는 확인되지 않았다. signer·보호 엔진·root 설치 및 실제 별도 principal 실증 없이 이 결과를 격리 성공으로 승격하지 않는다. 운영 설치·DB·tokenstore·외부 HTTP는 사용하지 않았다.

저장소에서 여전히 작성해야 할 항목은 root 전용 실제 설치 진입점과 봉인 서명·고정 실행물 검증, 서비스별 소유·ACL·socket/config/backup 정책 적용, 안전한 운영 rollback, 고정 환경의 실제 launcher와 공격 fixture다. 현재 Python renderer는 fixture 전용이며 위 항목을 충족하지 않는다. supervisor·broker·worker 실행물과 peer 검증은 D3/D4에 의존하므로 해당 단계에서 설치 코드에 연결하고 다시 검증해야 한다. 엔진 관리 API·VM·컨텍스트·volume·백업 및 재부팅·업데이트의 실제 격리, 서명·별도 UID 실증은 별도의 승인된 환경에서만 수행한다.

## D2 진행 중

후속 Garmin migration은 기존 사용자·확장 자격의 보호 테이블 쓰기와 보호 함수 실행을 철회하고 schema CREATE와 기본 권한을 제한한다. 역할의 예상 밖 membership이나 관리자 속성은 migration을 실패시킨다. 공통 재provision은 특정 제품명이나 버전 대신 해당 확장의 migration 이력에 따라 기존 정책을 다시 덮어쓰지 않는다. 보호 supervisor·broker·worker의 NOLOGIN 역할 생성기는 재실행과 충돌을 검사하지만 아직 운영 경로에 연결되지 않았다.

격리 PostgreSQL에서 기존에 열린 app/worker 세션의 위조 거부, 새 객체 권한, 재provision, membership 충돌 뒤 migration 재개를 검증했다. 실행한 일회용 컨테이너는 제거했다. 기존 역할 충돌로 첫 재실행이 실패한 뒤 격리 컨테이너를 새로 만들고 fixture가 자기 역할을 정리하도록 수정했으며 반복 실행이 통과했다.

현재 이 migration은 보호 경로를 닫을 뿐 정상 서비스가 아니다. 공통 work 상태는 기존 app 자격이 여전히 변경할 수 있고, 역할 자격·제한 API·CLI/hook 연결과 보호 admission/intent 정상 처리는 미구현이다. brain_owner의 전역 함수 기본 ACL 변경은 다른 확장의 미래 migration에 영향을 줄 수 있으므로 호환성 해결 전 D2 완료로 볼 수 없다. 별도 OS 경계와 엔진 격리도 미검증이다.

기존 `extension-permissions.test.ts`와 새 격리 시험을 함께 실행한 결과 전체 8건 중 6건 통과, 2건 실패했다. 두 실패는 기존 `brain_app`의 `reserve_work_admission` 호출이 0008에서 거부되어 기존 감독자의 admission 및 병렬 실행이 시작되지 않은 것이다. 보호 supervisor/API로 정상 경로를 이관하기 전에는 기존 회귀가 해결되지 않는다. 이 실패를 숨기거나 성공으로 간주하지 않는다.

추가 격리 PostgreSQL 시험에서 기존 확장 역할 삭제·재생성 후에도 schema CREATE와 보호 함수 권한이 되살아나지 않고, 삭제 전 연결한 세션도 결과 함수를 실행하지 못함을 확인했다. 사용한 컨테이너는 제거했다. 이는 운영 자격 회전이나 OS principal 격리의 증거가 아니다.

D2 후속: 설치 준비는 세 보호 역할을 NOLOGIN·무권한으로 만들고 충돌 및 membership을 거부한다. 0009는 supervisor admission과 broker의 identity·intent·결과 함수를 분리하고 일반 app·기존 worker·보호 worker에는 그 실행을 주지 않는다. 격리 DB에서 supervisor의 admission 성공, broker의 합성 intent 시작·종료, supervisor/broker/worker 교차 호출 거부, 기존 세션·역할 재생성 거부를 확인했다. 실제 보호 역할 로그인이나 HTTP는 사용하지 않았다. 상태 조회만 허용하는 요청 검증 부품은 알 수 없는 작업·SQL·URL·경로·코드 필드를 거부하며 단위 시험 두 건이 통과했지만 서비스 transport나 CLI에는 아직 연결되지 않았다.

공통 work·hold 상태는 여전히 app 자격으로 수정할 수 있으므로 위 함수 시험을 실제 권위 보호로 볼 수 없다. 기존 supervisor는 여전히 app으로 접속해 두 회귀 시험이 실패하며 제한 data API·spool 이관도 남았다. 전역 기본 ACL의 호환성 우려도 미해결이다.

## D2 일반 설치 분리와 권위 guard

보호 0008·0009는 `extensions/garmin/protected-migrations/`로 옮겨 일반 설치에서 자동 적용하지 않는다. 이전에 관찰한 기존 supervisor 시험 2건 실패는 이 staging 분리 뒤 같은 격리 DB에서 7건 전부 통과해 해소됐다. 보호 fixture는 별도 임시 migration 묶음으로 실행하며 정상 보호 admission·broker 의도/결과와 기존 자격의 위조 거부를 확인했다.

공통 migration 0028은 제품명 없는 보호 work 종류 registry와 guard를 추가한다. 보호 등록된 work·attempt·hold·schedule·의존성·확장 registry·설치 진행의 app 직접 쓰기 거부를 격리 DB에서 확인했으며 등록되지 않은 일반 설치의 기존 확장 회귀도 통과했다. 안전한 활성화·기존 열린 work의 이관, 인증된 transport, user CLI/hook의 서비스 연결 및 전체 공통 권위 표면 검증은 남았다. 상태와 제한된 queue 조회만 다루는 typed API 부품은 미연결이며 임의 SQL·URL·추가 필드를 거부하고 결과에서 token을 내보내지 않는 시험 두 건이 통과했다. 실제 OS/엔진 격리나 운영 설치를 증명하지 않는다.

정정: 공통 0028 역시 `packages/postgres/protected-migrations/`로 이동했으므로 일반 core schema에는 자동 적용되지 않으며 버전은 27로 유지한다. 보호 fixture에서만 core 0028과 Garmin 0008·0009를 임시 migration 묶음으로 명시 적용한다. 보호 fixture 통과 후 일반 확장 권한과 core migration 시험 28건도 격리 DB에서 통과했고 컨테이너는 정리했다. 앞선 0028 일반 적용이라는 문구는 이 정정으로 대체한다.

## D2A checkpoint: 명령과 결과

- `pnpm --filter @second-brain/postgres build`, `pnpm --filter @second-brain/core build`: 각각 성공.
- `pnpm exec vitest run packages/core/test/protected-api.test.ts`: 4건 통과. 상태와 제한 queue 조회만 허용하며 SQL·URL·추가 필드 거부, Core queue 호출과 token 비노출, 서비스 부재 시 fallback 없음을 검사했다. 이 queue 응답은 기존 CLI의 전체 필터·출력 계약을 아직 보존하지 않는다.
- `BRAIN_TEST_DATABASE_URL=postgres://postgres:fixture-only@127.0.0.1:<격리포트>/postgres pnpm exec vitest run packages/postgres/test/garmin-quarantine.test.ts`: 역할 잠금 수정 후 격리 PostgreSQL 18에서 1건 통과. 테스트 내부에서 기존 app/worker의 admission·evidence·intent 위조, work·attempt·hold·schedule·의존성·registry·설치 진행 변경을 거부하고, NOLOGIN 역할의 합성 session authorization으로 supervisor admission 성공·broker intent 정산과 역할 간 교차 호출 거부를 확인했다. 역할 membership 충돌 시 migration 실패 및 재개, 재provision·역할 재생성·기존 세션 권한을 확인했다.
- 같은 격리 DB에서 `pnpm exec vitest run packages/postgres/test/extension-permissions.test.ts packages/postgres/test/migrate.test.ts`: 28건 통과. 보호 migration을 staging으로 옮기기 전에는 기존 Garmin supervisor 시험 2건이 실패했으며 옮긴 뒤 정상 설치 회귀가 통과했다.
- 출력은 이 세션의 명령 결과로 확인했고 별도 로그 파일은 생성하지 않았다. 마지막 격리 컨테이너는 제거했다. DB URL의 암호는 오직 합성 fixture 값이다.

보호 migration은 자동 배포되지 않고 테스트가 임시 migration 묶음으로 명시 적용했다. 실제 보호 엔진·OS peer·역할 로그인·credential 회전, 권위 데이터/기존 열린 work 이전, 전체 work/설정·schedule 주변 상태의 위조 가능성, 고정 registry·서명 실행물은 미검증이다. 보호 API는 인증된 IPC·실제 사용자 명령·CLI/hook/spool에 미연결이며 D2B에서 기존 CLI 인자·출력·일반 spool 및 workItemId 제거를 보존해야 한다. supervisor/broker의 실제 실행물은 D3/D4 의존이며 D1 실제 설치기와 D7 복구도 미완료다. 사용자 인증 입력과 외부 HTTP는 열지 않았다.

## D3 진행 중

기존 `runSupervisor`의 보호 서비스 모드는 별도 registry만 사용하며 사용자 manifest loader와 일반 launcher를 조회하거나 청구하지 않는다. 보호 launch는 admission과 bootstrap pipe/인증 callback이 없으면 거부하고, admission 결과가 실행물·인자·환경을 교체하면 spawn하지 않는다. broker 전용 ABI는 DB URL을 거부하며 기존 ABI 경로는 유지한다. Garmin 후보 registry는 고정 시스템 경로와 고정 인자·최소 환경을 생성하고 설치 verifier가 실패하면 닫는다. 이 verifier와 snapshot·broker port는 아직 주입 seam이며 실제 서명 검증이나 보호 서비스 배포가 아니다. 후보 경로는 [ASSUMPTION]이며 D1 설치와 일치하도록 확인해야 한다.

실제 supervisor/자식 fixture에서 admission 뒤 spawn, OS 신원 기록, 현재 attempt·cancel·hold 재검사 뒤에만 비밀 없는 단회 ACK를 보내도록 검사했다. 기록 실패·신원/그룹 불명·취소·hold·기록 대기 중 종료는 ACK 전 차단했고 종료 불명은 unknown으로 보존했다. pipe 중복 ACK·닫힌 peer 쓰기·자손 FD 잔류와 부모 폐기의 EOF도 실제 프로세스로 확인했다. ACK pipe는 OS 상대 인증이 아니며 D4가 필요하다. [ASSUMPTION] bootstrap 10초 상한은 중단된 세션의 장기 점유를 줄이기 위한 보수적 임시 값으로 D4에서 검증해야 한다.

`BRAIN_TEST_DATABASE_URL=postgres://fixture:fixture@127.0.0.1:1/fixture pnpm exec vitest run packages/core/test/supervisor.test.ts apps/cli/test/process-group.test.ts apps/cli/test/sealed-garmin.test.ts`는 OS 프로세스 조회 권한이 있는 격리 실행에서 61건 통과했다. 샌드박스 내 첫 실행은 `ps` 접근 거부로 기존 테스트를 포함해 실패했고 재실행에서 프로세스 조회 권한을 부여해 통과했다. 더 최근의 hold·환경 변경 시험은 추가로 통과했으며 최종 묶음을 다시 실행해야 한다. `pnpm --filter @second-brain/core build`, `pnpm --filter @second-brain/cli build` 성공. 별도 UID 전환 launcher와 실제 native signature/peer 검증, 보호 서비스 연결은 미완료다.

## D3A checkpoint

기존 단일 supervisor에 봉인 registry와 별도 비특권 WorkerHost port를 연결했다. 봉인 서비스는 사용자 manifest loader와 기존 일반 launcher를 직접 사용하지 않고, 서버가 허용한 일반 kind만 WorkerHost로 전달하며 보호 확장 namespace와 별도 예약 kind는 제외한다. WorkerHost는 요청의 명명된 work 필드만 전달하고 UID·PID·시작 식별자·세션을 검증 port에 묶는다. 이 port의 합성 verifier와 세션 문자열은 실제 OS peer 증거가 아니다.

고정 Garmin 후보 registry와 launcher는 명령 경로·인자·환경을 고정하고 임의 PATH·URL·cwd·다른 확장 kind를 거부하며 broker ABI에 DB 자격을 넣지 않는다. 실제 설치 verifier 또는 native backend가 없으면 실행을 거부한다. 보호 admission이 실행물·인자·환경을 바꾸려는 반례도 차단했다. 별도 principal 전환과 실제 실행물 검증은 D3B/D4에서 연결해야 하며 후보 시스템 경로는 D1 설치와 맞춰야 하는 [ASSUMPTION]이다.

실제 자식 fixture는 합성 backend를 통해 같은 supervisor가 보호·일반 자식을 감독하는 경로와 admission→spawn→OS 신원 기록→현재 시도 확인→ACK 순서를 관찰했다. 기록 실패, cancel, hold, 승인 중 늦은 ACK, 신원·그룹 불명, 기록 대기 중 종료를 검사했다. ACK는 단회이며 실패·종료·취소 시 pipe를 닫고 자손 FD 보유에도 EOF를 확인했다. 인증되지 않은 pipe만으로 OS peer나 별도 UID 격리를 증명하지 않는다. bootstrap의 10초 상한은 [ASSUMPTION]이며 D4에서 검증한다.

최종 명령: `pnpm --filter @second-brain/core build`, `pnpm --filter @second-brain/cli build` 성공. `BRAIN_TEST_DATABASE_URL=postgres://fixture:fixture@127.0.0.1:1/fixture pnpm exec vitest run packages/core/test/supervisor.test.ts apps/cli/test/process-group.test.ts apps/cli/test/sealed-garmin.test.ts apps/cli/test/sealed-launcher.test.ts apps/cli/test/ordinary-worker-host.test.ts`는 OS 프로세스 조회가 허용된 실행에서 5파일 67건 통과했다. 해당 URL은 global setup 우회용 합성 값이며 DB 연결을 하지 않았다. 별도 로그는 생성하지 않았다.

D3B/D4 실제 서명·양방향 peer·별도 UID launcher·FD 승인 및 취소, D2B 실제 사용자 API/CLI·hook·자격 이전, D1 운영 설치기·D7 복구, 전체 T01–T28은 남았다. 실계정·운영 DB/토큰·관리자 설치는 사용하지 않았고 인증 입력과 외부 HTTP는 닫혀 있다.

## D3B·D4 진행 중 추가 증거

- `extensions/garmin/native/`에 OS peer 코드 서명·UID/PID 검사, XPC 익명 FD 전달, 세션 상태, worker host 및 별도 프로세스 bootstrap, 인증 frame 송수신을 구현했다. worker service는 고정 정책과 실제 자식 PID를 검사하되 운영 배포와 DB 연동은 아직 하지 않았다.
- `check-peer.sh`는 실제 별도 서명 프로세스의 peer 검증·bootstrap과 C/Python 인증 frame 왕복을 합성 비밀로 검증했다. 잘못된 코드 서명 거부와 출력에 합성 비밀이 남지 않는 조건을 확인했다.
- 서명 challenge는 대상 식별자·세대·UID/PID·코드 해시와 nonce를 묶고 단회 사용을 검사한다. 임시 소프트웨어 키 fixture 성공은 Secure Enclave, 생체 인증, 키 접근 제어 또는 실제 사용자 존재의 증거가 아니다.
- AppKit 보안 입력 부품은 별도로 컴파일되지만 승인된 broker에 연결되어 있지 않고 실제 사람 입력 시험도 하지 않았다. 보호 엔진 및 OS 사용자 승인 증거가 없어 운영 승인, 비밀 입력 및 외부 HTTP는 계속 닫혀 있다.
- Python 인증 FD는 동시 송수신 중 close가 FD 번호를 재사용하지 못하도록 수명 참조를 유지하고, 종료 뒤 decode 결과를 내보내지 않도록 직렬화했다. 격리 단위 시험 7개가 통과했다.
- 남은 일: 보호 supervisor의 내구성 기록과 broker 서비스·worker/UI 연결, OS 사용자 존재 및 principal 분리 실증, 나머지 D2B·D5~D7 전체 구현과 검증이다. 별도 프로세스 합성 성공은 운영 설치나 OrbStack 권위 DB·관리 API 분리의 증거가 아니다.

### 추가 broker·입력 부품 검증

- `broker-service.c`는 supervisor·worker·UI의 별도 XPC 서비스와 고정 서명 정책을 사용하며 등록된 PID, 세대, 패키지와 내구 기록 신호를 확인한다. 등록이 먼저 이뤄져도 UI 준비 전 대기하며, 선택 메시지는 현재 무조건 세션을 닫는다.
- `check-broker-service.sh`의 일회용 사용자 launchd fixture에서 등록 성공과 supervisor 역할의 UI 선택 시도 거부를 확인했다. 동일 사용자 합성 시험이므로 서로 다른 UID 격리나 완전한 worker/UI 왕복을 입증하지 않는다.
- `secure-prompt.m`과 `presence-ui.m`은 각각 보안 입력과 Secure Enclave 서명 호출을 준비했지만 운영 UI 흐름에 연결하지 않았으며, 키 정책과 접근성 자동화 차단 실증 전까지 사용하지 않는다. UI가 준비되지 않은 세션을 재시도하는 연결과 실제 broker 승인·전용 FD 전달의 통합은 남아 있다.
- 합성 challenge 서명 시험은 재사용, 다른 nonce, 메시지 변조의 거부를 확인했으며 서명 키의 접근 제어에 관한 주장을 하지 않는다.
- 이후 동일 UID 합성 fixture를 확장해 세 XPC endpoint의 등록·worker attach·내구 기록 신호·UI 대상 선택을 실제 임시 launchd 프로세스에서 검증했다. 별도 fixture 전용 컴파일에서만 합성 승인 후 양쪽 익명 FD와 HMAC frame을 전달했으며, 일반 컴파일은 같은 선택에서 닫힌다.
- UI가 세션 준비 전 연결되면 제한 시간 안에서 재조회하도록 구현했다. 대기 주기 250ms와 상한 15초는 `[ASSUMPTION]`이며 실제 UI·중단 시험이 필요하다.
- 현재 supervisor의 TypeScript launcher port와 실제 native worker host client, 내구 DB 기록을 잇는 운영 adapter가 아직 없어 전체 D3B/D4 완료로 보고하지 않는다.
- native host client 부품이 서비스 코드 서명 확인, 고정 요청, 소유 FD와 내구 기록 뒤 ACK 요청을 구현한다. 합성 host가 peer 미확인 자식을 거부하는 사례를 이 client로 검증했으며 정상 종료 관찰, 유한 대기, supervisor adapter가 미구현이므로 운영 연결하지 않는다.
- 앞 항목의 유한 대기 누락은 이후 수정했다. native host 응답은 `[ASSUMPTION]` 15초 상한 뒤 닫히며 취소 후 늦은 callback의 소유권도 유지한다. 종료 관찰과 supervisor adapter는 여전히 남았다.
- 이후 native host client에 코드 서명·PID를 재확인하는 종료 관찰을 추가했다. 확인 실패와 연결 단절은 `unknown`으로 보수 처리하며 정상 종료 이벤트의 실제 서비스 성공 경로는 아직 fixture가 없어 추가 검증이 필요하다.
- 종료 관찰은 별도 서명된 합성 XPC host의 정상 event와 잘못된 PID event를 각각 확인했다. 이는 실제 자식 실행·프로세스 그룹 정리의 성공 증거가 아니며 native host와 supervisor 연결은 계속 미완성이다.

### FD 상속 계약 교정

- 앞서 기록한 broker의 worker 측 XPC FD 전달은 계획의 worker spawn 상속 요구와 다르므로 제거했다. 해당 합성 전달 성공은 요구 충족 증거가 아니며, 현재 broker 전달은 상속 통합 전까지 실패 닫힘이다.
- broker가 spawn 전에 익명 socket 쌍과 일회성 키를 준비하도록 분리했다. 별도 자식 프로세스에 `posix_spawn`의 FD 5 상속으로 한쪽을 건네고 나머지 쪽과 합성 데이터를 교환하는 fixture가 통과했다.
- 보호 host의 spawn 부품에 검증된 socket을 FD 5로 상속하는 경로를 추가했다. 실제 broker-to-host의 OS 인증 FD 전달, host spawn, 내구 기록과 UI FD 전달을 하나로 연결하고 검증하는 작업은 남아 있다.
- 보호 host의 `spawn_worker_with_channel`은 socket만 받아 고정 FD 5로 복제한다. `/usr/bin/true` 합성 자식으로 socket 수용 및 일반 FD 거부가 통과했으며, 자식이 FD 내용을 읽는 별도 `posix_spawn` fixture와 구분한다.

### 사람 승인 보수 정책 반영

- `/tmp/brain162g3-presence-map.md` 전체를 읽고, 운영 경로의 목표를 현재 GUI 사용자·매 credentials/MFA 제출마다 새 생체 인증으로 정했다. 암호·Watch fallback은 허용하지 않으며 생체 사용 불가 시 실패한다.
- 봉인 UI 경로 후보는 매번 새 `LAContext`, 재사용 0, 생체 전용 policy, 취소 시 invalidate, sleep·세션 이탈·잠금 취소, 세대와 단조 만료 확인을 구현했다. callback은 UI 내부에만 있으며 broker의 wire boolean 승인으로 사용하지 않는다.
- challenge는 전체 세션 식별, 난수, 비밀번호/MFA operation, prompt와 단조 만료를 함께 묶는다. 합성 상태 시험에서 자동 선택만으로 승인 불가, 각 제출의 재승인, 취소 뒤 늦은 승인, 만료, 세대 변경 거부를 확인했다.
- 합성 상태 시험은 실제 AX 자동 입력·읽기·쓰기·overlay 공격, 생체 prompt, 현재 GUI session, 서명 UI 봉인 및 실제 기기의 보장을 입증하지 않는다. OS callback과 broker의 신뢰 연결, 부정 접근 차단 실증 전까지 비밀 입력은 닫혀 있다.
- 기존 SEP 서명 부품은 검토용 미연결 코드이며 Secure Enclave 속성만으로 ACL·등록·접근 그룹을 입증하지 않는다. 실제 SEP 경로를 선택하려면 보호 등록·생체 ACL·고정 공개키와 각 제출별 fresh context를 추가 검증해야 한다.
- native worker service와 client에 lease·PID·시작 시각을 확인하는 원격 검사와 SIGTERM/SIGKILL 허용 목록을 추가했다. 별도 합성 host에서 요청·응답과 잘못된 종료 PID 거부를 검증했으며, 실제 worker 그룹에 대한 성공·종료 회수 통합 시험은 아직 없다.
- 비밀번호/MFA 입력 부품은 생체 callback과 broker 재검증이 연결되기 전 운영 빌드에서 직접 호출해도 입력창을 열지 않도록 막았다. 합성 상태 시험은 실제 AX 공격이나 사용자 생체 인증을 대체하지 않는다.

## 최종 보존 보고 — 보안 결정 보류

지휘자의 `finalize`와 security decision gap HALT에 따라 신규 구현을 중단하고 현재 diff를 미완료 상태로 보존했다. 앞 절의 “정했다”, “정책 반영”이라는 표현은 확정된 결정을 뜻하지 않으며 생체 전용·현재 GUI 사용자·제출마다 승인·sealed UI callback은 검토용 제안과 합성 구현이다. 계획의 일회성 승인이 세션 채널 개시인지 각 secret 제출인지, 허용할 OS 승인 정책, broker가 어떤 증거와 신뢰 경계를 받아들일지는 결정되지 않았다; 결정 전 합성 state machine과 미연결 UI 코드를 확정 계약이나 구현 완료로 취급하면 안 된다.

### 현재 diff 범위

- D1: `tooling/protected-deployment/`의 설치 staging과 보호 엔진 가능성 검사 및 합성 fixture. 실제 OrbStack의 동등 관리·DB 접근 경로, 재부팅·업데이트 뒤 UID 분리는 미증명이다.
- D2A: `packages/postgres/protected-migrations/`, `extensions/garmin/protected-migrations/`, `packages/postgres/src/protected-roles.ts`, `extension-provision.ts`, `setup.ts`, `packages/core/src/protected-api.ts` 및 fixture. 실제 사용자 명령·CLI/hook·spool·권한 이관과 단일 보호 서비스 연결인 D2B는 미완료다.
- D3: `packages/core/src/queue/supervisor.ts`, 프로세스 port/ABI, `apps/cli/src/runtime/process-group.ts`, `apps/cli/src/daemon/{ordinary-worker-host,sealed-garmin,sealed-launcher}.ts`와 시험. `extensions/garmin/native/`에는 서명 peer·spawn·host service/client·제한된 원격 검사/신호/종료 관찰 부품이 있으나 TypeScript supervisor adapter, 실제 내구 DB ACK 연결, 재시작 후 원격 reaper와 완전한 그룹 종료 증거는 미완료다.
- D4: `extensions/garmin/native/`의 broker·XPC·FD 상속 fixture·challenge·검토용 생체 UI, `extensions/garmin/src/auth_fd.py`와 시험. broker의 worker FD XPC 전달은 잘못된 구현으로 제거했으며, broker 생성 FD의 보호 host 전달→spawn 상속→내구 기록→UI 전달과 callback 출처 검증은 미연결이다. 운영 승인과 입력은 닫혀 있고 실기 AX/자동화·사용자 존재·코드 봉인 검증은 하지 않았다.
- D5: tokenstore 및 OS egress·HTTP broker의 전체 연결과 검증은 미완료다. D6: 원래 기준 전체 diff의 T01–T28 및 독립 리뷰는 미완료다. D7: 보호 배치의 이전·복구 준비와 실증은 미완료다.
- 현재 checkout의 계획 파일과 조사 지도 등 다른 변경도 `git status`에 보인다. 본 작업자는 계획/티켓 상태 변경, tickets.py mark, commit, push, 운영 설치, 운영 DB·토큰 접근 또는 실계정 호출을 하지 않았다.

### 최근 검증과 정확한 한계

- `sh extensions/garmin/native/tests/check-worker-success.sh`: 임시 사용자 launchd와 서명된 합성 자식에서 ACK 전 출력 차단, 원격 검사, 기록 신호 뒤 ACK, 종료 관찰 통과. 합성 자식은 host 신원을 검증하지 않으며 임시 경로 예외는 fixture 전용이므로 운영 설치·상호 인증·실제 DB 기록 증거가 아니다.
- `sh extensions/garmin/native/tests/check-worker-service.sh`: 서명된 `/usr/bin/true`의 peer/bootstrap 미확인 거부 통과. `sh extensions/garmin/native/tests/check-host-observer.sh valid`와 `wrong-pid`: 별도 합성 XPC host의 종료 event와 PID 불일치 거부 통과.
- `sh extensions/garmin/native/tests/check-broker-service.sh`: 합성 세 역할 연결 뒤 선택만으로 승인되지 않는 차단 통과. 이전의 worker XPC FD 전달 시험은 계획과 충돌하여 삭제했고 성공 증거로 사용하지 않는다.
- `sh extensions/garmin/native/tests/check-peer.sh`: 별도 프로세스 peer·spawn FD 상속·C/Python 인증 frame·합성 서명 변조/재사용·생체/보안 입력 부품 컴파일 통과. 생체 state의 합성 승인 규칙은 결정 대기 중인 후보이며 실제 생체 성공을 시험하지 않았다.
- `PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=extensions/garmin/src extensions/garmin/.venv/bin/python -m unittest discover -s extensions/garmin/tests -p 'test_auth_fd.py' -v`: 7개 통과. `git diff --check`: 통과. 앞서 D3A 관련 5개 시험 파일 67개, D2A의 기존 28개 시험과 격리 DB fixture가 통과했으나 최종 전체 회귀나 T01–T28을 뜻하지 않는다.

결과는 부분 작업 보존이며 전체 구현, 보안 배포, implementation-ready 또는 사람의 운영 작업만 남은 상태가 아니다. 재개에는 승인 단위와 허용 policy, UI/OS 증거 provenance 및 설치·생체/AX 실증에 관한 명시적 결정이 필요하다.

## 지휘자의 종료 직전 추가 확인

구현자의 정식 종료 직후 `pnpm typecheck`를 실행해 실패를 확인했다. `apps/cli/test/sealed-garmin.test.ts:8`의 `path` implicit any와 `:15`의 `admit` 반환값 `ok` boolean widening 오류다. 로그는 `/tmp/brain162g3-halt-typecheck.log`다. 같은 Dispatch에 수정 메시지를 시도했으나 이미 정식 종료되어 `Dispatch is not active`로 거부됐다. 재사용·추가 편집자를 띄우거나 지휘자가 직접 소스를 수정하지 않았으며 재개 시 수정 대상으로 보존한다. 따라서 부분 컴파일 통과 보고를 전체 TypeScript 검증 통과로 확장할 수 없다.
