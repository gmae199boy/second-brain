# epic 8 Google Drive 연동 — 정적 코드 조사

2026-10-28. 현재 worktree의 파일을 읽은 결과이며 시험 통과나 설치본 동작의 증거가 아니다. 테스트·빌드·Docker·설치·패키지 추가·Google API 호출·OAuth 시도는 하지 않았고 비밀 파일을 읽지 않았다. 공식 웹 문서만 조회했다. 편집 범위는 이 보고서 하나다.

근거 약칭(아래 `약칭:행`은 이 저장소 상대 파일의 행을 뜻한다):

| 약칭 | 파일 |
|---|---|
| E8 | `_bmad-output/personal-brain/tickets/epic-drive/epic-drive.md` |
| I | `_bmad-output/personal-brain/initiative-personal-brain.md` |
| S | `_bmad-output/personal-brain/spec-brain-v1-slice-1/spec-brain-v1-slice-1.md` |
| A | `_bmad-output/personal-brain/architecture-brain-v1-slice-1/architecture-brain-v1-slice-1.md` |
| E10 | `_bmad-output/personal-brain/tickets/epic-attachments/epic-attachments.md` |
| E11 | `_bmad-output/personal-brain/tickets/epic-postgres-primary/epic-postgres-primary.md` |
| E12 | `_bmad-output/personal-brain/tickets/epic-jobs-and-scheduler/epic-jobs-and-scheduler.md` |
| E17 | `_bmad-output/personal-brain/tickets/epic-search-and-health-query/epic-search-and-health-query.md` |

## 0. 결정과 현재지

범위는 E8-1~3·5·6이다. API로 원본을 옮기고 선택한 외부 폴더는 문서 본문과 이름을 색인하며, 해제할 때 Drive 사본은 지우지 않는다. DB 스냅샷·새 Mac 복구·캐시 상한은 V1 뒤로 미룬 결정을 유지한다(E8:28, E8:31, E8:64, E8:73). CAP-6/7 공통 검색은 17, CAP-12 전체 복구는 뒤, CAP-14 첨부·Drive 문서가 8의 대상이다(S:37, S:40, S:55, S:61).

현재 코드는 로컬 FileStore·txt/md 추출·로컬 blob 삭제와 SQLite Store가 구체적 기반이다. PostgreSQL 전환은 기록된 결정이며, 이 worktree의 `postgresStore`는 아직 `HealthStore & SchemaStore`만 반환한다. 따라서 SQLite 구현을 새 제품 저장소로 확장하는 계획이 아니라, epic 11이 같은 계약을 PG로 옮긴 뒤 소비할 추가 능력을 찾는다(`packages/postgres/src/store.ts:39`, `packages/postgres/src/store.ts:49`; E10:104; E8:78). 미커밋 epic 17 정제 문서도 읽었으나 구현 완료로 취급하지 않는다(E17:30, E17:97).

이니셔티브 위임은 추천 결정을 티켓 Notes와 장부에 남기고 이 Mac 확인도 에이전트가 수행하되, Drive OAuth 동의만 사람 단계로 남긴다. 이번 보고서는 결정하지 않고 선택지를 제시한다(I:188, I:192; `_bmad-output/personal-brain/decisions-by-recommendation.md:3`).

## 1. FileStore 계약과 Drive adapter의 빈 곳

| 경계 | 실제 상태와 Drive에 필요한 일 |
|---|---|
| port | `put(bytes)`, `get`, `exists`, `url`, `delete`의 비동기 값 반환. 성공 put의 location 타입이 **local·brain으로 고정**되어 있다. Drive 구현 전에 storeKind 반환 타입을 일반화해야 한다(`packages/core/src/ports/file-store.ts:2`). |
| 내용/위치 | SHA-256 내용 id와 local/drive·brain/external 위치는 이미 분리돼 있다. Brain locator는 hash shard+선택 이미지 확장자다(`packages/core/src/domain/file.ts:3`, `packages/core/src/domain/file.ts:9`, `packages/core/src/domain/file.ts:13`). |
| 로컬 안전 | local·brain·정규 locator만 받고 루트 내부 및 실제 심볼릭 링크 조상을 검사한다. put은 0700 디렉터리·0600 임시 파일→rename, 읽기·확인·URL·멱등 삭제를 제공한다(`apps/cli/src/runtime/file-store.ts:13`, `apps/cli/src/runtime/file-store.ts:35`, `apps/cli/src/runtime/file-store.ts:58`). 동일 크기 기존 파일은 재해시하지 않는다(:43). 이동 검증은 put 성공만으로 대체할 수 없다(A:387). |
| 계약 시험 | 왕복·같은 내용 같은 위치·URL 안정성·없는 파일·삭제 멱등성을 검증하지만, local 위치/locator를 직접 단정하고 drive를 거부 입력으로 사용한다. **어긋남:** E8-1의 “같은 계약 테스트 통과”를 현재 그대로 수행할 수 없다. 공통 의미 계약에 backend fixture를 주입하고 로컬 전용 locator·루트 시험을 별도로 유지하는 안이다(`packages/core/src/testing/contracts/file-store.ts:6`, :16, :22, :47, :53; E8:28). |
| Drive 루트 | 원격 id만 알면 삭제할 수 있는 구현은 AD-23 위반이다. Brain 전용 root id·appProperties/등록 mapping·부모 소속을 검사하고 external을 거부해야 한다. URL은 locator에서 생성하며 내용 행에 URL을 굳히지 않는다(A:384, A:385; `packages/core/src/ports/file-store.ts:8`). |

Drive의 이름은 멱등 키로 믿지 않는 adapter가 필요하다. 후보는 순수 hash locator를 유지하고 `(root, content_hash)→remote_id` mapping과 업로드 상태를 별도 영속화하는 안, 또는 locator에 remote id를 쓰도록 AD-23과 계약을 정제하는 안이다. 후자는 locator 순수 함수 결정과 충돌하므로 현재 결정 아래서는 전자가 적합한 후보이며 최종 선택은 여기서 하지 않는다(A:384; `packages/core/src/testing/contracts/file-store.ts:25`).

원격 `md5Checksum`은 바이너리에만, `sha256Checksum`은 제공될 때만 있고 Docs Editors·shortcut에는 없다. SHA-256이 있으면 로컬 hash와 비교하고, MD5만 있으면 같은 로컬 bytes의 MD5와 비교하거나 SHA-256 되읽기 검증을 선택할 수 있다. MD5 문자열을 `content_hash`로 쓰면 안 된다. 둘 다 없으면 되읽기 SHA-256이 안전한 검증 경로다(A:383, A:387; [Drive files 공식 필드](https://developers.google.com/workspace/drive/api/reference/rest/v3/files)). 원본 업로드는 변환하지 않는 바이너리로 유지하고, Google Docs export의 hash와 업로드 원본 hash를 혼동하지 않는다(E8:16; A:391).

중단 가능한 큰 업로드는 resumable session URI·remote id·확인한 offset을 일감 상태에 보존하고 재시도 때 서버 진행 상태를 조회하는 후보가 필요하다. 응답 유실 후 다시 create하면 중복이 생길 수 있으므로 내용 키 mapping·원격 존재 확인을 함께 시험해야 한다. resumable은 큰 파일/중단 가능성에 권장되며 chunk는 마지막 외 256KiB 배수다([업로드 공식 문서](https://developers.google.com/workspace/drive/api/guides/manage-uploads); A:357). 현재 port에는 업로드 재개나 checksum metadata가 없으므로 adapter 내부 능력 또는 별도 이전 port가 필요하다(`packages/core/src/ports/file-store.ts:4`).

## 2. 원본 이전 단계·crash 지점

AD-23은 검증 시각과 home을 **같은 쓰기 트랜잭션**에서 바꾸라고 한다. 현재 AttachmentStore에는 위치 읽기·삭제 표시·첨부 연결·가리기만 있고 이동 확정 use case가 없다. `FileLocationRow`조차 verifiedAt을 내보내지 않는다. SQLite 첨부 연결은 최초 brain 위치를 home으로 채울 뿐이다(A:387; `packages/core/src/ports/store.ts:823`, :975; `packages/sqlite/src/attachments.ts:33`, :41).

| 단계 | 중단 후 재개와 필요한 원자성 |
|---|---|
| 1 로컬 후보/설정 읽기, 업로드 의도 기록 | 대상 location·hash·원격 mapping/업로드 session을 남기고 원격 I/O는 트랜잭션 밖. 이 시점 중단은 로컬 home 유지(A:387; `packages/core/src/files/blob-delete-work.ts:15`). |
| 2 업로드 | 완료 응답 유실은 같은 hash의 원격 파일을 확인하고 이어간다. 실패 때 home·검증 시각·로컬 삭제는 건드리지 않는다(A:387; `packages/core/src/testing/contracts/file-store.ts:25`). |
| 3 hash 검증 | checksum 누락은 되읽기, 불일치는 실패. 검증 후 DB 확정 전 중단이면 다음 시도에서 원격 버전을 확인/재검증한다. 존재 검사나 크기만으로 검증 완료로 쓰지 않는다(A:387). |
| 4 원격 위치 등록+verified_at+home 전환+삭제 예약 | 한 transaction에서 예상 이전 home/가리기 상태도 재확인하는 Store 능력 후보. 삭제 예약까지 같은 transaction에 넣으면 전환 후 예약 전 crash를 막을 수 있다. 분리한다면 미예약 이전을 찾는 복구 scan이 필요하다(A:387; `packages/core/src/ports/store.ts:941`). |
| 5 보관기간 뒤 로컬 삭제 | 기준 시각은 검증 확정 시각으로 잡는 후보. `nextAttemptAt = verifiedAt + days`, 0은 즉시. 현재 `blobDeleteWork`는 createdAt과 nextAttemptAt을 모두 at으로 정하므로 별도 due 입력/호출부 조정이 필요하다(`packages/core/src/files/blob-delete-work.ts:67`; E8:28). |
| 6 삭제 후 표시 | handler는 I/O 후 deleted_at을 채운다. 사이에 죽으면 재삭제의 false를 성공으로 보고 표시를 마친다. 이미 표시된 위치는 새 blob을 지우지 않고 종료한다(`packages/core/src/files/blob-delete-work.ts:92`, :136, :165). |

재사용 가능한 것은 content hash, 위치 목록, WorkStore의 열린 대상 중복 억제, blobDeleteWork/handler와 failures retry다. 빠진 것은 이전 후보 조회·업로드 checkpoint·검증 결과·CAS home 전환·보관기간 예약/변경 정책이다. SQLite DDL은 verified_at 한 번 채움과 같은 파일 brain home만 강제하며 검증 없는 home 전환 자체를 차단하지는 않는다(`packages/sqlite/migrations/0002_files_and_work.sql:351`, :405; `packages/core/src/capture/session-ingest-work.ts:33`; A:357). 30→0 등 설정 변경이 기존 예약에도 적용되는지, 삭제 직전 Drive 접근 불가일 때 보류할지는 아직 선택지이며 마지막 사본 보존 불변식을 시험으로 고정해야 한다(E8:44; A:381).

현재 Core 조립은 documentExtractHandler에 기본 registry를 쓰고 외부 workHandlers를 병합한다. 라이브러리 adapter를 주입하려면 기본 handler의 extractor 주입 경계를 조립까지 연결해야 한다(`packages/core/src/brain.ts:275`, :281).

## 3. 외부 문서 목록·색인·증분

후보 DDL은 `sources`(계정/종류·root·활성·동기화 상태·changes cursor)와 `source_files`(source_id, remote_file_id UNIQUE, name, parent_id/parent_path, mime_type, remote_version, content_id nullable, unreachable_at, index_status)다. 별도 cursor 표를 두면 계정 changes stream 하나를 여러 root가 공유할 수 있다. root별 cursor를 두면 구현은 단순해지나 중복 조회를 감수한다. 이름은 가칭이고 마이그레이션 번호는 epic 11 실행기 다음 번호다(E8:29, E8:79; A:763).

내려받지 않은 사진·큰 파일은 `files`에 가짜 hash를 만들어 넣지 않는다. 현재 file_names는 fileId 필수이고 출처 타입도 attachment_name/location_path 둘뿐이어서, content_id 없는 remote 항목을 이름 검색에 넣을 별도 source_names 또는 source_files 이름 조회 branch가 필요하다. content가 생긴 뒤에는 file_names로 파생할 수 있으나 같은 결과가 두 번 나오지 않게 source 정체성과 내용 정체성을 구분한다(E8:29; `packages/core/src/ports/store.ts:805`; `packages/sqlite/migrations/0002_files_and_work.sql:277`).

목록→선택 root의 하위 경로 구성→문서 MIME/크기 선별→Docs export 또는 일반 파일 임시 다운로드→바이트 형식 판정·해시→추출 세대 확정→임시 삭제 순서 후보다. 기존 handler는 `state.home`을 FileStore.get으로 읽으므로 외부 소스 임시 bytes를 읽는 경계를 따로 주입하거나, 동일 추출 세대 writer를 공유하는 source handler가 필요하다. 외부 파일을 brain home으로 만드는 편법은 쓰지 않는다(E8:17; `packages/core/src/files/extract-work.ts:337`, :345, :355; A:387).

일반 파일은 `files.get alt=media`, Google Workspace 문서는 export가 공식 경로이며 export 결과는 10MB 제한이다. Docs를 text/plain으로 export하면 text locator, PDF로 export하면 PDF locator를 얻는 후보이며 원본 Docs의 쪽과 export PDF의 쪽을 혼동하지 않는다. 사진은 다운로드하지 않고, 크기 미제공 Docs도 bounded stream으로 export 상한 초과를 중단해야 한다([다운로드·export 공식 문서](https://developers.google.com/workspace/drive/api/guides/manage-downloads); E8:29, E8:32). 임시 영역은 0700/0600·finally 정리와 시작 때 자기 잔여 임시 파일 정리 후보가 필요하고 영구 로컬 FileStore에 복사하지 않는다(E8:40; `apps/cli/src/runtime/file-store.ts:42`, :56).

원격 버전이 바뀌면 새 내용 hash로 새 content_id를 연결하고 기존 해시 행을 수정하지 않는다. 임시 bytes와 remote_version이 엇갈리면 재시도하고, 동기화 도중 재시작은 같은 버전의 완료 결과를 재사용하는 후보가 필요하다. 원본 삭제·접근 상실은 source 항목에 unreachable을 남기고 기존 조각을 보존한다. 단, 같은 내용이 여러 source/첨부에 연결될 수 있으므로 한 source의 삭제로 정상 원본이 있는 공통 files 전체를 unreachable로 만들면 안 된다(A:383, A:402, A:570; E8:29).

초기 목록 전에 changes start token을 확보→목록 완료→그 token 이후 증분을 적용하면 목록 중 수정 누락을 줄일 수 있다. 페이지의 변경 적용·다음 cursor를 같은 transaction에 확정하고 마지막 페이지의 newStartPageToken으로 전진하는 후보다. root 밖으로 이동·폴더 이름 변경·삭제·권한 상실도 하위 경로와 이름을 재계산한다(E8:17, E8:29; [changes 공식 안내](https://developers.google.com/workspace/drive/api/guides/manage-changes)).

**토큰 만료 주의:** 현행 v3 `changes.list`는 nextPageToken/newStartPageToken이 만료되지 않는다고 명시한다. “정기 만료→항상 410”을 구현 사실로 쓰지 않는다. 잘못된/거부된 cursor·계정 교체 때는 cursor reset+전체 재조정 경로를 시험하되, 전체 목록 성공 전 기존 항목을 일괄 삭제/접근 불가로 확정하지 않는 후보가 필요하다([changes.list 공식 응답 계약](https://developers.google.com/workspace/drive/api/reference/rest/v3/changes/list); E8:29).

`source_sync`는 같은 source 대상의 미완료 일을 합치고 `brain sources sync`와 데몬 예약이 같은 handler를 호출한다. 현재 tick은 intervalSeconds를 받아 fireSchedule로 enqueue하며 데몬은 tick 뒤 drain한다. 새 종류 handler·등록·retry stage·예약 등록/중지와 주기 선택이 빠져 있다. 긴 목록/추출은 epic 12의 최신 작업 실행 분류·취소·계정 직렬화 계약을 받아야 하고 옛 600초 lease 전제에 새 네트워크 작업을 얹지 않는다(`packages/core/src/queue/schedule-tick.ts:10`; `apps/cli/src/daemon/run.ts:277`; `packages/core/src/capture/session-ingest-work.ts:33`; E12:27; A:367). 주기는 수분 단위 interval 또는 사용자 설정 키 후보이며 여기서 정하지 않는다(E8:41; E12:22). epic 9의 예약 틱·데몬 없는 명령 동작은 재사용하되 `[files] path` 감시는 구현 범위에 없었다. spine AD-27의 파일 위치 감시 문장과 현재 범위의 차이는 **어긋남**으로 남기며, API 동기화 때문에 로컬 감시를 필수로 추가할 근거는 없다(`_bmad-output/personal-brain/tickets/epic-daemon/epic-daemon.md:31`, :33, :48; A:435).

## 4. OAuth·비밀·가짜 서버

데스크톱 OAuth client, 시스템 브라우저, loopback 임시 포트 redirect, PKCE S256 verifier/challenge와 state 검증을 한 흐름으로 구현하는 후보다. callback은 loopback에만 bind하고 일회용·timeout·취소 정리하며 code/verifier/token을 출력하지 않는다. offline refresh token을 저장하고 재연결 때 필요한 scope와 계정을 확인한다. Desktop 앱의 loopback 지원과 PKCE 절차는 [Google Desktop OAuth 공식 문서](https://developers.google.com/identity/protocols/oauth2/native-app)에 있다(E8:28; A:320).

선택 폴더 문서 읽기와 Brain root 쓰기는 서로 다른 권한 요구다. scope는 기존 폴더 전체가 실제로 보이는지와 app-created 파일 쓰기를 함께 검증해 선택해야 한다. drive.file만으로 임의 기존 폴더 전체를 읽는다고 가정하지 않는다. scope 선택은 구현 정제 항목이고 실제 동의는 사람에게 남긴다(E8:29; I:192; [Drive changes.list 허용 scope](https://developers.google.com/workspace/drive/api/reference/rest/v3/changes/list)).

AD-18대로 access/refresh token 등 비밀은 `.env`, 사용자 선택(root·감시 폴더·보관기간 등)은 DB, 기계 값과 비밀 환경 변수 이름은 config 코덱에 둔다. 현 코덱은 `.env`를 읽지 않고 쓰기 때 기존 값을 parseEnv로 보존하며 0600으로 쓴다. Drive 전용 token 읽기·refresh 원자 갱신·동시 refresh 직렬화·비밀 삭제를 이 코덱 경계에 추가해야 한다. 진단은 값이 아닌 로그인 상태/만료/필요 조치만 낸다(A:318, A:320, A:322; `apps/cli/src/config/codec.ts:126`, :548, :603).

refresh의 invalid_grant는 만료/무효화로 재동의가 필요하고, 일시 네트워크·429·5xx와 분리해야 한다. 401은 refresh 한 번 후 계속 실패하면 로그인 필요, 동의 거절은 취소/미연결, 철회는 연결 불가 상태로 기존 검색을 유지하는 후보다. 403·404는 기록된 영구 분류를 따른다. Google의 세부 reason이 rate limit이어도 일시로 풀지 여부는 기존 Decision과 **어긋남**으로 명시해 후속 정제해야지 조사 중 몰래 바꾸지 않는다(E8:69; A:363; [OAuth invalid_grant 공식 설명](https://developers.google.com/identity/protocols/oauth2/native-app#errors)). Retry-After 전달을 누락하지 않는다(A:364).

가짜 서버 후보는 injectable HTTP base URL/transport+Clock을 받아 token endpoint, files list/get/media/export, resumable POST/PUT/상태조회, changes start/list를 모사한다. fixture는 checksum 없음/불일치·응답 유실·308 진행·중복 create·다중 page·rename/move/remove·cursor 거부·401/invalid_grant·403/404·429 Retry-After·5xx·취소·임시 파일 잔여다. 가짜 token은 합성 값만 쓰고 `.env`는 격리 홈에 쓴다. 이는 FileStore 왕복/삭제 계약과 source_sync의 재개 원자성 시험을 함께 관찰하기 위한 설계 후보다(`packages/core/src/testing/contracts/file-store.ts:7`; `packages/core/test/blob-delete.test.ts:33`; E8:39).

에이전트는 이 서버·fixture·CLI/SDK·scope 안내·설치본 확인 절차까지 만들 수 있다. 실제 계정의 OAuth 화면 동의는 사람 몫이며 해당 스토리만 awaiting-operator로 남긴다. 이번 조사에서는 가짜/실제 서버를 띄우거나 OAuth를 시도하지 않았다(I:188, I:192).

## 5. PDF·docx 추출기와 Carry

현재 registry는 content bytes만 보고 detect하는 async extractor 배열이며 text가 마지막 fallback이 되도록 설계됐다. 실제 등록은 text 하나, 버전은 doc/1이다. PDF magic과 docx ZIP 내부 구조 검사를 text 앞에 넣는 후보이며 확장자만으로 읽지 않는다. docx는 ZIP magic만으로 확정하지 말고 OOXML 문서 구조를 확인해야 한다(`packages/core/src/files/extractors.ts:12`, :18, :35, :85, :99`).

| 후보 | Node·라이선스·순수 JS 경계 및 locator |
|---|---|
| pdfjs-dist/PDF.js | spine의 기존 후보(A:659). JS PDF parser/API, Apache-2.0. getTextContent와 페이지 정보로 쪽별 text를 얻는 경로 후보이며 renderer/canvas 의존을 텍스트 경로와 분리한다. 프로젝트 package에 native canvas 개발 의존도 있어 전체 설치가 순수 JS라고 단정하지 않는다. 정확한 배포 버전·Node engine·optional 의존은 구현 시 고정·검증한다([공식 API 소스](https://raw.githubusercontent.com/mozilla/pdf.js/master/src/display/api.js), [공식 package](https://raw.githubusercontent.com/mozilla/pdf.js/master/package.json)). |
| mammoth | spine의 기존 후보(A:659). Node와 browser JS 사용, BSD-2-Clause. extractRawText는 문단 사이 줄바꿈을 제공하지만 block 정체성은 별도로 정의해야 한다. semantic 문단/표 블록 순회 또는 raw text 문단 번호 후보가 있으며 복잡한 문서 변환은 완전하지 않다. native 실행기 없는 JS 경로 후보이나 잠금된 전이 의존까지 검증해야 한다([공식 README·라이선스](https://github.com/mwilliamson/mammoth.js)). |

Core의 플랫폼 API 없는 경계 때문에 라이브러리 import 위치는 runtime adapter에 두고 DocumentExtractor를 주입하는 안과 별도 추출 package를 두는 안이 있다. detector와 결과는 기존 port 모양을 유지한다. 텍스트 추출 소스도 Core에 TextDecoder가 없음을 명시한다(`packages/core/src/files/text-extractor.ts:14`; `packages/core/src/files/extractors.ts:52`).

PDF page와 docx block은 1부터이며 bbox는 좌상단 원점·페이지 비율이다. bbox를 안정적으로 계산 못 하면 생략 가능하므로 텍스트 항목 transform을 잘못 bbox로 저장하지 않는다. PDF chunk는 쪽을 넘겨 합치지 않는 후보, docx chunk는 블록을 넘길 때 locator 의미를 먼저 정하는 후보다. page 사본은 PDF locator.page와 같고 다른 형식은 null이다(`packages/core/src/domain/chunk-locator.ts:18`, :30, :43; `packages/core/src/domain/document.ts:105`; A:400). 이미지 PDF는 OCR 범위 밖이므로 텍스트 없음 상태를 별도 안내할 필요가 있다(E8:52; `packages/core/test/document-extract.test.ts:565`).

라이브러리/추출 규칙 변경 시 사용 버전을 extractor_version에 담아 올리고, 새 세대 성공 전에는 이전 포인터를 유지한다(A:400, A:401). 현재 stale predicate는 **현재 ok 세대가 다른 버전**이고 요청 버전 세대가 전혀 없는 파일만 고른다. unsupported는 실패 행조차 없으므로 failures retry나 단순 버전 bump로 살아나지 않는다. Carry를 처리하려면 새 지원 형식의 과거 unsupported에 한정된 재큐잉 후보 선택·중복 억제 능력을 Store/fake/계약에 더해야 한다. 기존 media_type이 null일 수 있으므로 저장된 MIME만 믿는 필터도 불충분하다(`packages/sqlite/src/extractions.ts:104`, :111; E8:86; E10:110).

현재 상한은 형식 공통 8MiB이고 bytes를 읽기 전에 too_large로 닫는다. PDF/docx용 상한은 아직 결정되지 않았다. 선택지는 입력 byte 상한+PDF page/추출 글자 상한, docx compressed byte+ZIP 해제 byte/entry/출력 글자 상한이다. 하나의 입력 크기만으로 ZIP 팽창이나 PDF CPU를 제한할 수 없으므로 취소/실행 예산과 함께 다룬다. Docs export 10MB API 제한과 자체 추출 상한은 별개다(`packages/core/src/domain/document.ts:37`, :51; `packages/core/src/files/extract-work.ts:337`; E8:86; [공식 export 상한](https://developers.google.com/workspace/drive/api/guides/manage-downloads)). too_large 전체 재개·텍스트 streaming은 Carry의 범위를 넘겨 끌어오지 않는다(E10:110).

## 6. 문서 찾기: epic 17 위에 더할 것

17이 먼저 만드는 것은 Core 질의 함수 하나, analyses 관계 파일의 현재 document_chunks 검색, document 출처와 files show, 문서 출력 probe다. 8은 같은 경로의 대상을 첨부·Drive로 넓히고 이름·원본 URL을 더한다. 현재 Brain.files 공개 표면에는 redact뿐이며 검색이 이미 구현됐다고 볼 수 없다(E8:81, E8:82; E17:44, E17:48, E17:93, E17:97; `packages/core/src/brain.ts:209`).

추가 지점 후보는 (1) docs Store 질의의 analyses 전용 대상 제한 확장, (2) file_names와 content_id 없는 source 이름 branch, (3) 현재 세대+파일/외부 소스 정체성의 결과 dedupe, (4) FileStore.url 또는 external Drive source URL resolver, (5) files show의 source 상태와 미색인 표시다. Drive 외부 문서는 FileStore의 brain 소유 제한을 풀어 URL을 얻지 말고 source 전용 resolver에서 remote id를 안전하게 인코딩해 링크를 만든다(A:287, A:385; `packages/core/src/ports/store.ts:805`; E17:44).

현재 이름 채우기는 첨부 표시 이름과 external local locator만 모으므로 Drive 파일·폴더 이름을 추가할 수 없다. `fillFileNames`는 한 번에 500개씩 쓰는 기존 재생성 경로다. 외부 rename/move 때 옛 파생 이름 제거·재생성과 가린 파일 제외를 함께 설계해야 한다(`packages/sqlite/src/attachments.ts:87`, :93, :97; `packages/core/src/files/file-names.ts:5`; A:403, A:575). E10 닫기에는 이름 색인이 drain 한 번 늦는 DW-1이 남아 있어 목록 직후 이름 검색 성공의 시점을 시험해야 한다(E10:109).

이름만 있는 사진/큰 파일은 미색인 사유(사진·too_large·unsupported·pending·failed)를 결과에 드러내고, 본문이 없다는 이유로 숨기지 않는다. source_unreachable은 미색인과 다른 상태이며 기존 본문 결과에 FILE_SOURCE_UNREACHABLE을 붙인다. content_id null 결과에는 없는 file_id나 chunk_locator를 지어내지 않도록 17의 결과 union을 확장할 후보가 필요하다(E8:29, E8:33; A:287, A:402).

질의는 같은 Core 정규화·LIKE 이스케이프 함수를 쓴다. 공백·a-b·AND·따옴표는 FTS 문법으로 해석하지 않고 `%`·`_`·역슬래시도 문자 그대로다. 문서명·부모 경로·본문 branch 모두 같은 함수로 돌리고 output codec 이후 길이/마스킹·0건·실패 구분을 유지한다(A:278, A:279; E17:44, E17:49). 문서 probe는 17이 소유하므로 8에서 별도 마스킹 함수를 만들지 않고 Drive 이름·URL/사유까지 probe 입력을 넓힌다(E8:82; `packages/core/src/output/codecs.ts:24`).

## 7. 연동 해제·사용자 설정·Source conflict

해제는 동기화 예약 중지·신규 청구 금지·진행 중 작업의 뒤늦은 publish 차단→연결 상태 변경/비밀 정리→원본 접근 불가 표시 후보다. 기존 추출 세대·조각·이름은 보존하고 Drive delete를 부르지 않는다. 특히 아직 안 돈 로컬 보관 만료 삭제를 취소/보류할지 정제해야 한다. source 상태와 예약을 같은 transaction에 바꾸거나 epoch를 확인하는 방식이 후보이며 원격 토큰 폐기 실패도 로컬 해제를 막아서는 안 된다(E8:18, E8:30; A:402; `packages/core/src/files/blob-delete-work.ts:98`).

`drive.keep_local_days`는 기본 30·0 허용으로 정해졌고 DB 사용자 설정을 쓴다. 정수/음수/비정상 큰 값 검사와 기존 예약 재계산 정책을 해당 키 코덱에 넣는 후보다. 나머지 `drive.*`(watch folders, root, sync interval)는 후보이며 계정 토큰을 DB value에 넣는 키는 만들지 않는다(E8:28, E8:35; A:319, A:320). key 목록·기본값·타입·비밀 참조를 epic 11 config registry에 추가하고 brain config get/set을 재사용한다(E11:40). 구체적인 인계 entry는 11.6이고 `drive.keep_local_days` 등록은 8 몫으로 명시돼 있다(`_bmad-output/personal-brain/tickets/epic-postgres-primary/tickets/tickets.toml:77`, :80).

**Source conflict의 상태는 문서상 해소·현재 코드상 미반영이다.** E8 Notes는 AD-19 충돌 메모를 유지하지만 최신 spine AD-18은 DB settings/기계 config/비밀 env를 이미 분리했고 AD-19 설치 단계도 DB 시간대를 참조한다. E11-7은 이것을 구현할 요구다. 반면 이 worktree 코덱 KNOWN_KEYS/BrainConfig에는 timezone·store.path가 있고 DB 설정 읽기는 없다. 따라서 “epic 11에서 구현까지 해소됨”이라고 쓸 수 없다(E8:77, E8:83; A:319, A:330; E11:40; `apps/cli/src/config/codec.ts:29`, :83; `packages/postgres/src/store.ts:49`).

## 8. 공유 파일 레인·epic 17 겹침·세션 위험

아래 새 파일명은 후보이며 앞 에픽 완료 HEAD에서 실제 경로를 다시 확인한다. migration 번호는 고정하지 않는다(E8:79; E17:98).

| 함께 고칠 파일 | 겹치는 작업 | 레인 선택지 |
|---|---|---|
| `packages/core/src/ports/{file-store,store}.ts`, testing contracts/fakes | Drive 반환 타입·이전 확정·외부 source·재큐잉·검색 능력 | 공통 계약 먼저 순차; adapter만 분리 |
| `packages/postgres/migrations/`, Store 조립 | source/cursor/mapping·설정·검색 이름 branch | 11·17 뒤 다음 번호를 한 소유자가 배정 |
| `packages/core/src/brain.ts`, `apps/cli/src/assembly.ts` | FileStore routing·source handler·SDK·검색 합성 | OAuth/이전/색인 모두 편집하므로 통합 레인 |
| `packages/core/src/files/{extractors,extract-work,blob-delete-work}.ts` | PDF/docx·임시 source bytes·보관 due·Carry | shared worker 계약 뒤 형식별 adapter 분리 가능 |
| `apps/cli/src/config/codec.ts`, commands, dispatch/명령 메타 | token·drive.*·sources sync/connect/disconnect | 설정/CLI 한 레인; 11 config 소비 |
| 17의 recall/docs 질의·files show·출력 codec/probe | 대상 확대·이름/null content 결과·URL·미색인 | 17.1 문서 tracer 계약을 받은 뒤 확장(E17:97) |
| daemon/run·schedule 등록·retry stage | sync interval·해제 중지·긴 작업 분류 | 12 최신 runtime 위 한 통합 레인 |
| package manifest·pnpm lock·plugin ref/version | 추출 라이브러리·최종 배포 | lock 편집은 한 세션; ref는 앞 commit·version 함께(A:335) |

가장 큰 한 세션 위험은 OAuth+resumable+검증 원자성+기간 삭제를 한 번에 넣는 것과 목록/changes/Google Docs/사진 이름 검색을 한 번에 넣는 것이다. 앞 에픽도 locator와 세대 Store를 세션 크기 때문에 나눴다(E10:93). tracer는 합성 txt 한 건의 수직 경로로 한정하고 crash 행렬·외부 문서 전수·형식별 한도를 독립 후보로 둔다. PDF/docx는 기존 DocumentExtractor에 주입할 수 있으므로 source DDL과 분리 가능하지만 Carry predicate와 공통 worker 편집은 순서를 정해야 한다(`packages/core/src/files/extractors.ts:35`; `packages/sqlite/src/extractions.ts:111`).

## 9. Done when 1~7: 기존 시험 기반·빠진 것·이 Mac

아래는 시험 소스의 존재와 의도이며 실행 결과가 아니다.

| Done when | 기존 기반 | 빠진 시험/관찰 |
|---|---|---|
| 1 이전·검증 후 삭제 | FileStore 공통 계약, 로컬 symlink 거부, blob 삭제 I/O 행렬(`packages/core/src/testing/contracts/file-store.ts:7`; `apps/cli/test/file-store.test.ts:98`; `packages/core/test/blob-delete.test.ts:33`) | Drive root/외부 거부·checksum 없음/불일치·업로드 응답 유실·검증·home·예약 transaction rollback·가리기 경쟁·기간 전 무삭제 |
| 2 외부 txt/md/PDF/docx·사진 이름·링크 | txt/md 추출·배치·unsupported·크기 검사(`packages/core/test/document-extract.test.ts:242`, :272, :312, :332), locator 코덱(`packages/core/src/domain/chunk-locator.ts:30`) | 가짜 export/임시파일 완전 삭제·PDF page 사본/bbox·docx block·사진/큰 파일 다운로드 0회·content_id null 이름 검색·Drive URL |
| 3 다음 동기화 주기 | tick의 due/CAS enqueue(`packages/core/src/queue/schedule-tick.ts:16`), 기존 schedule suite(`packages/core/test/schedule-tick.test.ts:69`) | source_sync 등록·수동/예약 중복·변경 페이지 중단 재개·rename/move/remove·cursor 거부 재목록·취소/계정 직렬화 |
| 4 해제 후 검색/불가 표시 | 원본 사라짐에도 옛 조각 유지·뒤처진 unreachable 재큐잉 금지(`packages/core/test/document-extract.test.ts:395`, :691) | disconnect와 진행 중 sync 경쟁·Drive delete 0회·토큰 비노출/정리·검색 유지·만료 삭제 보류 정책 |
| 5 첨부 본문/이름/원본 | 기존 이름 파생·txt/md 추출(`packages/core/src/files/file-names.ts:5`; `packages/core/test/document-extract.test.ts:242`), 17 문서 tracer 계획(E17:97) | 첨부/Drive/분석 결과 dedupe·특수문자·미색인 상태·원문 locator·출력 마스킹·redact 뒤 이름/조각 미복원 |
| 6 기간·DB 설정 | Clock 주입 blob handler·due work(`packages/core/src/files/blob-delete-work.ts:67`, :116), 11 settings 계획(E11:40, E11:57) | 0/30일 경계·설정 변경·재시작/컨테이너 재생성 보존·잘못된 값 거부·만기 직전 중단 재개 |
| 7 이 Mac 설치본 | 배포 신원/ref/version 규칙(A:332, A:335), 에이전트 확인 위임(I:188) | 실제 설치본 버전/명령·가짜 격리 홈 수직 확인·동의 후 실제 Drive 문서 이름/본문/링크·원격 push 필요시 operator_actions |

Mac에서 에이전트가 할 수 있는 것은 격리 홈의 가짜 서버·합성 fixture 회귀, 설치본 경로/버전/명령 확인, 동의된 계정 이후 실제 문서 검색·링크·재시작·기간 시뮬레이션 검증과 증거 기록이다. 사람만 하는 OAuth 동의 때문에 전체 에픽을 막지 말고 그 단계만 awaiting-operator로 남긴다. 실제 계정 fixture에는 본문·파일명·token을 공개 plan에 쓰지 않는다(I:188, I:192; A:320; E17:56). 이번에는 이 확인도 실행하지 않았으므로 Done when 충족 판정을 내리지 않는다.

## 스토리 후보

결정이나 새 tickets.toml이 아닌 후보다. 기존 Decision은 유지하며 구현 시점의 11·12·17 entry를 교차 after로 받는다(E8:78, E8:84, E8:85; I:187).

| 후보 | 관찰할 결과·근거 | 고칠 파일 후보 |
|---|---|---|
| T1 Drive 계약 바탕 | backend 중립 FileStore 계약+가짜 Drive 왕복·루트/외부 거부·URL. local 계약 보존(1절) | core ports/file-store·testing contracts/fakes, 새 Drive runtime adapter/HTTP fake, assembly, 관련 tests |
| T2 이전 tracer | 합성 txt 하나 upload→검증→원자적 home 전환→0일 로컬 삭제→17 docs/show로 확인. 진짜 OAuth 없이 수직 경로(2·6절) | core files 이동 use case·Store port, PG 이동/mapping, blob-delete-work due 입력, brain/assembly, 17 docs 대상·tests |
| T3 OAuth·설정·해제 | loopback/PKCE fake·env codec·drive.keep_local_days·동의 필요 상태·Drive 무삭제 disconnect(4·7절) | runtime OAuth/token, config codec/registry, PG source/설정, commands/SDK/meta, schedule 중지·tests |
| T4 외부 txt/md tracer | 선택 root 목록 한 페이지→임시 bytes→동일 추출 세대→삭제→Drive 문서/이름 검색. content_id null 사진도 이름 적중(3·6절) | PG source tables/port/fake, source sync handler·temp reader, file_names/source name branch, recall/docs·files show·codec/probe |
| T5 PDF·docx·Carry | 쪽/블록·상한·라이브러리 version·과거 unsupported 선택 재개(5절) | runtime/추출 package 후보, core extractors/extract-work/domain limits, PG stale query·계약/fakes, manifest/lock·fixture |
| T6 증분·중단·기간 경계 | changes paging/checkpoint·예약·retry·취소·해제 경쟁·보관기간 변경/재개(2·3·7절) | source worker/PG transaction·cursor, scheduler 등록, daemon/handler/retry 조립, retention 정책·failure injection tests |
| T7 통합·설치본 | 특수문자·이름/본문 마스킹·데몬 없이 합성 suite·배포 신원·동의 후 실제 자료 확인(9절) | CLI/SDK/meta/probe 회귀, plugin/app-ref와 plugin.json의 같은 배포 묶음, 해당 plan/검증 기록 |

순서안 A: T1→T2→T3→T4→T5→T6→T7. 원본 이전 불변식을 먼저 관통한다. 순서안 B: T1→T4→T5→T2→T3→T6→T7. 첫 실사용이 Drive 문서라는 근거를 따라 검색/추출을 일찍 확인한다(E10:88). T2가 한 세션을 넘으면 이동 Store 원자성/가짜 서버 기반과 CLI 수직 확인을 분리하는 선택지가 있다. T5는 PDF와 docx를 나눌 수 있으나 extractor_version·Carry 큐잉·공통 상한 편집은 한 소유자가 합친다(5·8절). 실제 OAuth 동의는 T3/최종 실계정 확인에만 사람 단계로 남기고 가짜 경로와 나머지 코드를 먼저 끝내는 선택지가 위임과 맞는다(I:192).

자체 정적 확인: 보고서의 1~9절·스토리 후보와 근거 경로를 대조하고 절대 홈 경로 패턴 검색이 0건임을 확인했다. 작업 전부터 있던 수정 및 동시 작업자의 새 문서는 그대로 두었으며, 이 조사에서 만든 파일은 이 보고서 하나다. 테스트 실행·기능 검증 판정은 포함하지 않는다.
