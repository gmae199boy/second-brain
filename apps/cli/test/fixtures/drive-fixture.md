# 가짜 Drive tracer 시험 자원

이 fixture는 합성 바이트와 loopback HTTP 서버만 사용한다. `apps/cli/test/fixtures/fake-drive.ts`의 `fakeDrive()`가 동적 포트를 열고 요청 목록과 원격 파일 Map을 노출하며, `fakeClock()`은 `set(ISO)`으로 시각을 바꾼다. 파일 이름 검색은 지원하지 않는다. `loseNextUploadResponse`, `checksum`과 `files`로 응답 유실·검증 불일치·원격 소실을 주입하고 `holdNextUpload()`·`holdNextDownload()`의 entered/release 장벽으로 경합을 제어한다.

`apps/cli/test/drive-tracer.test.ts`는 `pgHome(home, true, createIsolatedTestDatabase)`를 사용한다. 시험 전 전용 관리자 PG URL을 `BRAIN_TEST_DATABASE_URL`에 설정해 기본 공유 Compose 자동 선택을 막고, 독립 Docker context·소유한 checkout 밖 TMPDIR·독립 Brain home과 빌드 산출물을 준비한다. 고정 확장 role은 cluster 전역이므로 다른 티켓과 cluster를 공유하지 않는다. 격리 관리자 및 legacy fixture의 암호 전제를 확인하고 실제 계정·운영 DB·사용자 파일·credential은 사용하지 않는다. 테스트의 홈에는 시험 DB URL만 기록한다.

개발과 리뷰 수정 중에는 이 명령도 실행하지 않는다. 최종 구현 및 독립 후속 확인 뒤 지정된 순서대로 실행한다.

```sh
VITEST_MAX_WORKERS=2 pnpm test
pnpm test:python
```

관련 실패를 고친 뒤 선별 재검증할 때의 예(전용 환경에서만):

```sh
pnpm test:changed -- 9004c35b20c1b38b66af795668056ecdcdbaa1a9
pnpm exec vitest run apps/cli/test/drive-tracer.test.ts apps/cli/test/drive-file-store.test.ts packages/postgres/test/drive-migration.test.ts
```

관찰할 것은 각 fake 요청의 `GET ...?alt=media`, 업로드/삭제 수, 단일 root/hash 매핑, home·verified_at·retention due·work 행, 로컬 파일 존재와 클라이언트 출력이다. `fakeClock.set`으로 검증 시각과 30일 직전·만기 시각을 제어하며 실시간 대기는 하지 않는다. 원문은 합성 텍스트뿐이고 secret 문자열도 시험용이다.

각 fixture는 `finally`/`afterEach`에서 자기가 연 HTTP 서버, PG pool·관리 연결, 자신이 만든 DB/컨테이너, 임시 홈만 닫거나 삭제한다. `createIsolatedTestDatabase`는 생성 컨테이너 ID와 동적 포트를 기록하고 정확한 ID를 제거한다. 테스트 종료 후 그 소유 ID와 임시 홈의 부재를 확인하며, 실패로 남은 리소스는 기록된 ID를 확인한 뒤 해당 ID만 정리한다. 다른 티켓의 container·role·home 또는 운영 데이터를 건드리지 않는다.

## 외부 source tracer

`apps/cli/test/drive-source-tracer.test.ts`는 `pgHome(..., createIsolatedTestDatabase)`의 독립 PG/role·임시 홈과 별도 `source-temp`를 생성한다. `sourceSyncFactory`로 합성 loopback 서버, 같은 PG source store, 전용 temp adapter만 SDK와 실제 `dispatch(commands, ...)`에 주입한다. 외부 계정·토큰·운영 DB·사용자 파일은 사용하지 않는다. 기존 source ID를 사용하는 tracer와 별도로 `sources-commands.test.ts`는 합성 OAuth callback으로 실제 연결과 명령 조립을 확인한다.

서버의 files Map은 txt·md·Docs·사진·60 MB metadata·하위 폴더·동일 내용 사본을 가진다. 페이지 크기 2로 root의 세 페이지 이상과 하위를 반환하며 `requests`에서 start token 선행, export와 media, 사진/큰 파일 다운로드 0을 확인한다. 실제 명령은 `sources sync <id> --json`, `recall docs 검색 --json`, `files show <file-id> --source-file-id <id> --chunk-locator <json> --json` 및 `files show --source-file-id <id> --json`이다. 같은 Clock과 ID 생성기를 SDK에도 주입해 재실행 전후 source_files/files/document_chunks 행수, 삭제 뒤 source별 접근 상태·공통 file 상태·기존 chunks, 가리기 뒤 이름/링크 부재를 비교한다. temp와 FileStore 루트의 잔존 파일도 관찰한다.

강제중단 case는 해당 fixture의 source/file/work를 만들고 실제 PG claim·열린 extraction·temp binding을 먼저 기록한다. 자식 Node가 합성 bytes를 쓴 뒤 SIGKILL하고 `cleanupSourceTemps`를 호출해 열린 attempt와 타인 이름 파일이 남는지 확인한다. 그 다음 시험 소유 extraction과 work를 닫고 다시 정리해 자기 bytes만 삭제되는지 확인한다. 모든 자원은 fixture가 연 서버·pool·DB·temp root만 역순으로 닫거나 지우며 실패 후에는 정확한 소유 ID를 확인한다. `fakeClock.set`으로 만기와 재시도를 제어하고 실제 계정 연결이나 임의 sleep은 쓰지 않는다.

최종 전체 회귀와 실패 후 선별 재검증 규칙은 위와 같다. `0041_sources.sql`, source port/handler, runtime 및 자식 프로세스 tracer 경로는 `tooling/test-changed/rules.mjs`에서 선정한다. 이 설명은 시험 실행 결과가 아니다.

R1 실제 중단 시험은 `sync-write`와 `extract-read` 각각 새 Node 자식에서 실제 Brain source sync 및 document extract handler를 실행한다. 합성 temp 쓰기 완료 또는 열린 extraction의 temp 읽기 직전 장벽에서 키를 받고 SIGKILL한 뒤 새 실행에서 소유 상태와 파일을 관찰한다. 살아 있는 claim과 열린 attempt는 보존하며 Clock을 11분 이동한 후 복구·정리와 같은 source의 재동기화를 확인한다. 타인 파일과 FileStore 부재도 비교한다. 이는 해당 경계의 복구 검증이며 8.5의 전체 증분 재시작 완료를 뜻하지 않는다.

R1 matrix 대응: EC1/BH7 요청별 큐·backoff, BH2 lease, BH5 late handoff 및 BH9 인덱스는 source store/PG 시험; EC2/BH4·EC3·BH6·IA4/BH10·IA2·VG2는 source sync/extraction과 runtime/PG 시험; VG1/VG3는 PG claim·rollback 시험; BH3와 VG4는 document recall 및 tracer; IA3은 위 자식 장벽 시험이다. IA1·BH1·BH8은 계획의 기각 또는 8.5 경계를 따른다. 이 목록은 작성 범위이며 실행 증거가 아니다.

R2 fixture 보완: 공유 hash publish/handoff 장벽은 같은 격리 DB의 별도 store/pool과 두 backend PID를 사용한다. 각 pool의 lock 15초·query 20초 예산은 5초 장벽 관찰보다 길며 두 호출이 실제로 막힌 뒤 해제하고 양방향의 출처 지문·current·publication을 확인한다. VG2는 기존 성공 세대가 있는 실제 PG document-extract handler에서 동일 bytes/hash의 ready-temp 및 remote-download 경로 각각에 대해 첫 metadata v1 → 실제 bytes 읽기 → 조각 쓰기 → 최종 metadata v2 순서를 기록하고 재시도 가능 거부와 이전 본문/완료 지문 보존·새 publication 부재를 검사한다. VG3는 기존 성공 세대·조각과 새 열린 세대·조각을 동시에 만든 후 source UPDATE trigger 실패 전후 포인터·양쪽 세대와 조각·지문·publication을 비교한다. 9,000,000바이트 Docs는 앞뒤 UTF-8 표식을 두고 두 글자 검색과 source show, 실제 chunk, 단일 export 및 temp/FileStore 잔존 0을 확인한다. 위 항목은 시험 코드에 작성된 입력과 관찰이며 실행 성공 증거가 아니다.

R3 source 잠금 순서 시험은 기존 timeout·재시도를 유지한다. finish-first에서 scan의 source UPDATE trigger가 source 행을 잠근 상태로 관리자 advisory 장벽에 대기하고 source_file 행은 아직 잠기지 않았음을 독립 probe의 `FOR UPDATE NOWAIT`로 먼저 확인한다. 실제 publisher가 별도 backend에서 scan backend에 의해 차단된 활성 상태일 때 제3 backend가 같은 source_file 행을 NOWAIT로 잠글 수 있어야 하며, probe 종료 후에도 publisher가 여전히 살아서 같은 scan을 기다리는지 확인한다. source_file을 source보다 먼저 잠그는 publisher로 회귀하면 probe가 `55P03`을 받아 이 단언이 실패한다. 이 시험은 작성된 검증이며 아직 실행 결과가 아니다.

## 8.3 연결·해제 시험과 복구

`drive-oauth.test.ts`는 loopback callback·동시 refresh·원자 비밀 저장과 부분 실패를, `drive-http.test.ts`는 재인증·오류 분류·Retry-After의 큐 관찰과 doctor를 다룬다. `sources-commands.test.ts`는 설치된 dispatch와 SDK/daemon tick 조립을, `drive-source-tracer.test.ts`는 HTTP 다운로드 중 해제와 공유 원본·가리기를 다룬다. `source-store.test.ts`는 실제 추출 조각 쓰기 중 해제와 늦은 publish를, `drive-migration.test.ts`와 별도 자식은 삭제 I/O 잠금과 미확정 표식을 다룬다. `migrate.test.ts`는 0040/0041 원본 바이트와 0040·0041에서 0042로의 보존 및 권한 경계를 확인한다.

실행 전 독립 Docker 설정과 context가 전용 시험 cluster를 가리키는지 확인하고, 별도 checkout 밖 임시 디렉터리·Brain home과 전용 관리자 `BRAIN_TEST_DATABASE_URL`을 준비한다. `createIsolatedTestDatabase`와 legacy fixture가 요구하는 관리자 인증 전제를 먼저 확인한다. `BRAIN_TEST_PG_RESOURCE_LOG`를 소유 디렉터리에 두고 동적 container ID와 DB를 기록한다. 전용 cluster도 다른 ticket과 공유하지 않으며 실제 계정·credential·운영 DB에 접근하지 않는다. 시험은 합성 token·loopback endpoint와 주입 Clock을 사용한다. 종료 후 기록된 소유 ID, DB, home, 임시 디렉터리만 확인하고 정리한다. 기존 `tooling/test-changed/rules.mjs`의 PostgreSQL prefix는 0042와 자식을 이미 선정하며 두 경로의 명시 규칙도 있다. 다른 작업의 runner나 설정을 전제로 하지 않는다.

`secrets.lock`, `.drive-connection.lock` 또는 `.drive-refresh.lock`이 남으면 새 writer와 daemon을 멈추고 소유 프로세스와 자식의 종료를 독립적으로 확인한다. owner의 PID와 UUID만으로 PID 재사용이나 다른 boot의 생존 여부가 증명되지는 않는다. 소유자가 더 이상 실행 중이지 않고 다른 writer도 없다고 확정한 경우에만 해당 home의 정확한 잠금 디렉터리 하나를 제거한다. 확인할 수 없으면 잠금과 비밀을 보존하고 운영자가 조사한다. 경과 시간만으로 잠금을 지우지 않는다.

`brain.drive_delete_barriers`의 행은 외부 로컬 삭제 결과가 미확정일 수 있음을 뜻한다. 모든 관련 writer와 자식의 종료 및 진행 중 I/O 부재를 확인하고 소유한 work ID, 파일 위치와 실제 로컬·원격 상태를 대조한다. 세션 advisory lock `hashtextextended('brain:drive-delete-disconnect',0)`을 확보한 동일 DB 세션에서만 해당 정확한 행의 처분을 검토한다. 삭제 결과와 복구할 안전한 사본이 확정된 뒤에만 운영자가 그 행 하나를 제거하고 작업을 재개한다. 결과나 I/O 종료가 불명확하면 행을 보존하며 해제와 추가 삭제를 진행하지 않는다. 표식 일괄 삭제나 시간만으로 판단하는 복구는 금지한다.

E9 추가 관찰은 `sources-commands.test.ts`에서 합성 OAuth callback 뒤 감시·비감시 문서, 실제 공개 sync의 지연 media 응답과 동시 공개 disconnect, 검색/접근 경고·예약·취소된 로컬 삭제 및 토큰 삭제를 함께 확인한다. 같은 계정 재연결의 source ID·cursor·감시 폴더·예약 ID/간격과 재개도 확인하며 다른 계정은 거부한다. `.env`는 유일한 credential 저장 예외이며 모드와 토큰 삭제를 별도 점검한다. 그 밖의 격리 홈 파일, 명령 출력, doctor/search, queue 및 daemon 로그에서 합성 secret·token·code·verifier를 검사한다.

`daemon-run.test.ts`의 실제 `runDaemon`은 자기 전용 PG cluster와 홈, 주입된 fake fetch·Clock을 사용한다. 503/Retry-After의 다음 청구 시각과 이전 시각의 미청구, 다음 회차 성공·동일 auth의 refresh 횟수, 무관 일감과 invalid_grant의 비재시도 실패를 관찰한다. `migrate.test.ts` 재생성 시험은 난수 이름·소유 label의 독립 Docker volume과 두 container ID만 생성하며 첫 container를 제거하고 같은 volume을 두 번째 container에 연결한다. 종료 시 정확한 소유 label을 확인해 container만 제거하고 자기 volume 제거와 부재를 확인한다. 생성 ID와 정리 실패는 시험 출력/원시 로그에 보존하며 불명 소유 자원은 삭제하지 않는다.

삭제 미확정 시험은 자기 자식이 marker 저장 후 I/O 장벽에 도달했을 때만 SIGKILL하거나, 별도 관리자 연결로 그 자식의 특정 장벽 backend만 종료한다. 후자의 worker는 살아 있고 I/O 완료 뒤에도 marker가 남아 disconnect가 차단되는지 확인한다. 타인 파일은 건드리지 않는다. 시험 정리는 worker와 I/O의 종료를 확인한 뒤 동일 advisory lock을 잡고 시험이 만든 정확한 marker 하나만 제거한다. 이는 운영자 복구 절차를 대신하지 않으며 실제 파일 결과가 불명확하면 marker를 보존한다.
