# epic 5 운영 — 정적 코드 조사

2026-10-28, `plan/epics-12-on` worktree 기준. 소스·티켓·공식 PostgreSQL 문서를 읽었으며 시험·빌드·Docker·설치·운영 DB 접근과 비밀 파일 읽기는 하지 않았다. 이 문서는 결정문이 아니라 인셉션의 근거와 선택지다.

아래 `약칭:행`은 표의 저장소 상대 파일의 행이다. 소스 경로는 직접 쓴다.

| 약칭 | 파일 |
|---|---|
| E5 | `_bmad-output/personal-brain/tickets/epic-operations/epic-operations.md` |
| I | `_bmad-output/personal-brain/initiative-personal-brain.md` |
| S | `_bmad-output/personal-brain/spec-brain-v1-slice-1/spec-brain-v1-slice-1.md` |
| A | `_bmad-output/personal-brain/architecture-brain-v1-slice-1/architecture-brain-v1-slice-1.md` |
| D | `_bmad-output/personal-brain/decisions-by-recommendation.md` |
| E11 | `_bmad-output/personal-brain/tickets/epic-postgres-primary/epic-postgres-primary.md` |
| E9 | `_bmad-output/personal-brain/tickets/epic-daemon/epic-daemon.md` |
| E13 | `_bmad-output/personal-brain/tickets/epic-extensions/epic-extensions.md` |
| E10 | `_bmad-output/personal-brain/tickets/epic-attachments/epic-attachments.md` |
| E8 | `_bmad-output/personal-brain/tickets/epic-drive/epic-drive.md` |
| E3 | `_bmad-output/personal-brain/tickets/epic-log-and-context/epic-log-and-context.md` |

근거 행은 조사 종료 시점의 미커밋 문서도 포함한다. 다른 워커가 편집 중이므로 이후 행 이동 시 절 제목·식별자도 함께 확인한다.

## 0. 읽을 때 지킬 결정과 어긋남

- Requirements는 아직 비었고 CAP-11·12와 spine이 원천이다. 최신 결정은 **에픽 전체 V1 뒤, Drive 뒤**다. 10월 26일의 “Drive 전에 백업”과 “V1 일부” 문장은 27일 Decision으로 대체됐다. PG 전환 뒤 파일·WAL 전제를 다시 정해야 한다(E5:29, E5:67–73; I:141; S:52–57).
- 원문 백업은 `pg_dump` custom + globals + 블롭 + manifest, 가린 JSONL 내보내기는 별도다. U2 원문 백업과 U1 이전 백업 안내는 다시 논의할 결정이 아니다. 세부 묶음·복원 순서만 이번 인셉션의 열린 자리다(A:225–230, A:348–350, A:644, A:782, A:795).
- **어긋남:** Done when 1·4의 “새 DB 파일”, `brain.db/-wal/-shm`은 PG 볼륨·새 DB 기준으로 정제해야 한다. Carry I91의 SQLite checkpoint 보완을 PG 기능으로 옮겨 구현하면 안 된다. PG의 정리는 별도 VACUUM FULL·CHECKPOINT 경로와 doctor 상태다(E5:35, E5:38, E5:66, E5:71; A:228–230).
- **어긋남:** AD-20의 목표 순서와 달리 현재 설치기는 doctor·shim 검증을 **데몬 등록/재시작 전**에 한다. 갱신 뒤 새 데몬까지 doctor가 확인하도록 공통 갱신 함수를 정제할 필요가 있다(A:348; `apps/cli/src/install/flow.ts:561`, :584, :595, :621, :635).
- **어긋남:** E8의 옛 “가린 DB 스냅샷” Note를 원문 제품 백업에 적용하지 않는다. Drive 원본 이전·외부 색인은 별개이며 로컬 보관 기간이 V1 안전장치를 맡는다는 최신 결정을 유지한다(E8:20, E8:90; E5:69; A:349, A:387).

## 1. 지금 코드의 운영 경로와 epic 11 경계

| 경로 | 현재 단계·멱등 표식 | 이 에픽과의 경계 |
|---|---|---|
| `setup run` | standalone 명령이 같은 설치 flow를 부른다. 설정 읽기→경로·업데이트 선택→동의→충돌 확인→SQLite 준비/마이그레이션→나→files 루트→설정→shim→선택 harness 연결→doctor→실제 shim 검증→데몬 등록·다른 commit이면 재시작→installed 완료 기록이다(`apps/cli/src/commands/setup-run.ts:6`, :48; `apps/cli/src/install/flow.ts:393`, :451, :485, :518, :526, :539, :552, :561, :584, :595, :635). | epic 11.8이 앞부분을 OrbStack→compose→컨테이너→role/schema→core migration→나/시간대로 바꾼다. 새 `setup upgrade`, 백업·복구는 epic 5다(E11:41). |
| bootstrap | SessionStart가 본 plugin 정보를 먼저 기록하고 installed commit=ref면 반환, 자동 갱신 off면 fetch만 할 수 있다. mkdir 설치 잠금 뒤 완료 기록을 재확인하고 clone/fetch→조상 관계 확인→정확한 ref의 detached checkout→frozen/ignore-scripts 설치→build→설치기→installed commit 재확인이다(`tooling/bootstrap/src/bootstrap.ts:375`, :389, :393, :412, :417, :420, :427, :431, :445, :467, :572–618). | “ff+build”는 기능 명칭이며 실제 git merge가 아니다. 뒤처짐/분기 거부와 ref 고정은 보존한다. plugin 복사본도 존재한다(`plugin/bootstrap.mjs:14`, :31; A:324–339). |
| doctor | machine checks는 config·shim·node·plugin·last-hook·spool·daemon 한 목록이고 설치기와 명령이 공유한다. spool 실패 줄도 숨기지 않는다(`apps/cli/src/doctor/checks.ts:100–148`, :164–180). | epic 11.8은 OrbStack·컨테이너·접속·쓰기·pg_trgm·owner 버전을 더한다. epic 5는 백업 경과·가리기 전 백업 자료/점검을 더한다(E11:41; A:349). |
| 최소 uninstall | DB·config 없이 실행하는 standalone 명령. Label/plist 해제→주인 종료 대기→pid·heartbeat·daemon log와 회전본만 unlink, ENOENT는 성공이다(`apps/cli/src/commands/setup-uninstall.ts:6–19`; `apps/cli/src/daemon/control.ts:74–90`). | 9.10은 데몬 흔적만, 11.8은 컨테이너 중지·볼륨 보존, 5는 hook/shim/전체 run/log/완료 기록과 데이터 확인을 합친다(E9:35, E9:48; E11:41; A:350). |
| schema guard | 실제 dispatcher는 SQLite Store와 상수를 사용하고 writes 명령만 단일 버전을 비교한다. mismatch면 run을 부르지 않으며 spool branch가 있는 수집은 spool, 없는 가리기 등은 거부다(`apps/cli/src/dispatch.ts:435`, :599–635; `packages/core/src/schema.ts:20–45`). | owner별 core+설치 확장 기대 버전 guard는 epic 11 계약을 먼저 받아야 한다. 모든 실패 명령을 spool로 바꾸는 일은 아니다(A:346–347; E11:35). |
| spool | 첫 append에만 0700 폴더, 0600 `.open`을 완성해 `.jsonl` rename. 시각·pid·serial 이름, claim rename으로 한 drain만 획득, 죽은 pid 또는 만료 claim 회수. 반쪽 open은 별도 실패 처리한다(`apps/cli/src/runtime/spool.ts:117–142`, :154–199). | 백업에는 DB에 아직 없는 기록이 있을 수 있다. 미처리 spool 포함/제외 및 snapshot 이후분이라는 manifest 표시는 epic 5 세부 선택지다. 첨부 바이트는 spool에 없으므로 spool만으로 blob 복구를 약속할 수 없다(A:388). |

현재 PG 실행기도 파일별 트랜잭션·advisory lock은 있지만 `public.schema_version` singleton을 갱신한다. **어긋남:** `brain.schema_migrations(owner, version, name, checksum, applied_at)`·연속 번호/체크섬 거부·core baseline 0001은 epic 11이 만드는 계약이지 현 코드의 완료 사실이 아니다(`packages/postgres/src/migrate.ts:111–129`, :178–185; E11:35–36; A:477–486). 현재 docker helper의 고정 이름·pgvector 이미지·Docker Desktop 설치 함수도 OrbStack/공식 postgres compose 계약과 다르므로 백업이 재사용할 확정 자원 이름으로 삼지 않는다(`apps/cli/src/install/docker.ts:37–71`, :111–121; A:512–522).

멱등 기준은 “폴더가 있으니 완료”가 아니다. baseline/owner 버전, 자연 UNIQUE 키, hash locator, installed commit, 실제 shim 검증, 데몬 commit을 각각 확인해야 한다. `installed.json`은 마지막에 temp→rename되며 빌드 commit·schema·node·plugin_root·installed_at을 담는다(A:176–184, A:641; `apps/cli/src/install/installed.ts:24–49`, :233–257; `apps/cli/src/install/flow.ts:630–642`).

## 2. AD-20 백업 묶음 — 범위와 일관성 선택지

아래는 AD-20의 정해진 틀을 구현할 후보이며, 플래그·manifest schema의 최종 선택은 하지 않는다(A:349, A:782).

| 구성 | 조사 결과와 구현 때 고정할 것 |
|---|---|
| DB archive | `pg_dump -Fc` 원문 archive. `brain`과 설치된 모든 확장 schema(`garmin` 포함), 버전 표·설정·registry·core 계약 표가 범위다. schema 필터를 쓰면 cross-schema 의존 누락을 검증해야 하므로 전용 Brain DB 전체 dump와 허용 schema 목록 dump를 비교할 수 있다(A:349, A:582–587; E13:21, E13:37–38). |
| role/globals | `pg_dump`만으로 role은 돌아오지 않는다. AD-20대로 `pg_dumpall --globals-only`를 묶고 setup 소유자·brain_app·설치 확장 role, 멤버십·소유권·ACL 복원을 확인한다. 앱/확장 role만으로 RLS 일부 행을 뜨면 불완전 백업이므로 setup의 제한된 관리 경로를 쓴다(A:349; E11:35; E13:38). |
| 블롭 | `[files] path`는 기본 경로와 다를 수 있다. local·brain 정규 locator의 bytes를 저장하고 hash·크기·포함/없는 이유를 기록한다. 외부 local/Drive 원본은 DB metadata만으로 bytes가 생기지 않는다. Brain 소유 Drive 사본을 추가 다운로드할지, 로컬 블롭 한정임을 명시할지는 열린 세부다(A:384–388; E8:20; `apps/cli/src/runtime/file-store.ts:13–31`, :35–51). |
| 확장 설치 상태 | DB의 설치/활성 상태와 owner 버전, 패키지/manifest·lock·Python patch 식별자가 필요하다. `<home>/extensions/<name>/`는 plugin cache 밖이다. 재현 가능한 환경 재설치와 패키지 사본 보존은 비교 가능하나 `.venv`를 다른 Mac에서 그대로 실행하는 계약으로 만들지 않는다. 확장 없는 백업/복원은 Python·uv를 요구하지 않아야 한다(E13:37, E13:43; A:521–522). |
| config·비밀 | config는 기계 경로·url_env·update 설정, 사용자 설정은 DB, URL·token은 `.env`다. `.env`를 비밀 포함 private backup에 넣고 새 기계에서 연결 값만 다시 쓰는 안, 비밀 제외를 명시하고 복구 때 재발급하는 안을 비교한다. globals의 비밀번호 포함 여부와 함께 고정해야 한다. Garmin tokenstore는 별도 라이브러리 세션 파일이므로 config 경로만 백업해 로그인이 복원됐다고 판정하지 않는다(A:313–322; E13:38; D:38). |
| manifest | format/version, backup id·시작/완료·snapshot 기준, app commit·PG 서버/클라이언트 버전, schema owner별 버전/체크섬, schema/role/확장 목록, 테이블별 건수·sha256, archive/globals/blob/config별 sha256·크기, 파일 범위와 누락, secrets 포함 여부, `SECRET_PATTERN_VERSION`, 최신 redaction 기준점이 후보다. 테이블 hash는 안정된 PK 순서·NULL·bytea·시각 정규형을 정의해야 한다. archive bytes hash와 논리 테이블 hash는 다른 값이다(E5:21, E5:63; A:349, A:633, A:644; `packages/core/src/domain/secret-patterns.ts:35`). |

`pg_dump`는 동시 읽기·쓰기를 막지 않는 일관 snapshot을 만든다. custom은 `pg_restore`로 복원하고 병렬 dump는 directory만 지원한다. `-n` 선택은 의존 schema를 자동 보충하지 않으므로 필터 검증이 필요하다. snapshot 공유에는 `--snapshot`을 쓸 수 있다([PG18 pg_dump 설명·옵션](https://www.postgresql.org/docs/18/app-pgdump.html), Description, `--schema`, `--snapshot`).

실행 경로 후보는 (a) epic 11 compose service 안의 PG18 `pg_dump`를 `docker compose … exec -T`로 실행하고 binary stdout을 private 임시 파일로 흘리는 경로, (b) 호스트 PG18 client를 검사해 접속하는 경로다. 전자는 서버/client 버전을 맞추기 쉽고 호스트 패키지를 요구하지 않는다. 후자는 Docker exec 의존을 줄이지만 별도 client 설치·버전 점검이 필요하다. 둘 다 컨테이너를 임의로 띄우는 hook 경로와 분리한다. 오래된 major client는 새 서버 dump를 거부하므로 버전 기록이 필요하다(A:518–520; [PG18 pg_dump Notes](https://www.postgresql.org/docs/18/app-pgdump.html)).

`--globals-only`는 role·tablespace 등을 포함하는 SQL이며 완전 복원에는 관리 권한이 필요하다. `--no-role-passwords`를 선택하면 복원 role의 비밀번호가 비어 재설정해야 한다. 이 선택을 “마스킹 B”라고 부르면 안 된다. 비밀 제외 여부라는 복구 계약이다([PG18 pg_dumpall](https://www.postgresql.org/docs/18/app-pg-dumpall.html), Description, `--globals-only`, `--no-role-passwords`; A:349).

hook 비차단과 백업 완전성은 별도 검증 대상이다. 후보는 읽기 snapshot을 export한 관리 연결을 유지하고 dump와 count/hash reader가 그 snapshot을 공유하는 방식이다. 사용자 쓰기 트랜잭션/설치 잠금을 백업 내내 잡지 않는다. 이것은 오래 유지되는 **읽기** snapshot이지 짧은 쓰기 트랜잭션 위반을 감추는 방식이 아니다. DDL upgrade와 백업의 겹침만 조정하고 hook 수집은 계속 받으며 DB 장애 시 기존 spool을 쓴다(A:347–349, A:388, A:435; `apps/cli/src/dispatch.ts:611–623`; [PG18 snapshot 옵션](https://www.postgresql.org/docs/18/app-pgdump.html)).

DB snapshot은 파일시스템 snapshot이 아니다. 내용 주소 블롭의 rename 발행은 기반이지만, 백업 도중 `blob_delete`·redact·Drive 이전의 로컬 삭제가 snapshot에 필요한 파일을 없앨 수 있다. 후보는 블롭 삭제 handler에 백업 pin을 두거나 필요한 blob 목록을 먼저 고정해 복사 완료까지 삭제만 보류하는 방식이다. 원본 누락/해시 불일치는 완료 백업으로 표시하지 않는다. epic 10도 블롭 삭제와 첨부 메타데이터 spool을 이미 나눴으므로 그 경계를 이어받는다(E10:35, E10:39). 임시 묶음→검증→manifest 완성→rename 발행 순서가 필요하다(A:387–392; E5:21; `apps/cli/src/runtime/file-store.ts:35–56`).

가린 논리 내보내기는 테이블별 JSONL·manifest·패턴 버전, 출력 코덱 등록, blob 범위 `none | brain_owned` 계약을 따른다. 복원하면 가린 텍스트가 돌아오며 원문 dump와 같은 산출물이 아니다. 백업 bytes를 출력 코덱에 통과시켜 손상시키지 말고, 사용자용 결과/경로/오류만 기존 출력 코덱을 거치는 구조가 필요하다(E5:63; A:221, A:644; `packages/core/src/output/codecs.ts:15–16`, :72; `packages/core/src/output/mask.ts:19–20`).

## 3. 새 DB 복구와 기존 DB 합치기

다음은 시험 가능한 순서 후보다. 운영 volume 위 덮어쓰기·`--clean` 기본 사용은 새 DB 복구의 검증 경계 밖이다(A:522; E5:35, E5:61).

1. manifest 형식·archive/globals/blob hash·schema owner 목록·호환 app/PG 버전을 검사한다. 격리 홈·새 compose project/volume/port/Label을 만들고 runtime/예약 실행은 복구 검증 전까지 시작하지 않는다. 새 DB에 이미 migration을 적용한 뒤 같은 DDL dump를 중복 적용하지 않도록 “빈 복구 대상 생성”을 일반 setup과 구분한다(A:349, A:522; E11:35–41).
2. 관리 연결로 globals의 필요한 role을 먼저 복원한다. 새 cluster 기본 role과의 충돌을 명시적으로 처리하고, `.env` 연결 정보가 새 DB를 가리키게 만든다. core owner와 `brain_ext_garmin`을 혼동하지 않는다(E11:35; E13:38; [PG18 pg_dumpall](https://www.postgresql.org/docs/18/app-pg-dumpall.html)).
3. archive의 pre-data→data→post-data로 복원한다. “schema→data”만 적으면 post-data의 trigger·색인·제약을 놓친다. 실패 즉시 중단하고 완료 표식을 쓰지 않는 경로가 필요하다. `--no-owner`·`--no-acl`로 손쉽게 성공시키면 권한 복구 확인을 우회하므로 원래 owner/ACL/RLS를 확인한다(A:349; E13:38; [PG18 pg_restore `--section`, `--exit-on-error`](https://www.postgresql.org/docs/18/app-pgrestore.html)).
4. dump 전체 복원에서는 trigger·FK가 post-data에 생성되므로 archive의 의존 순서를 따른다. **기존 schema에 논리 INSERT**하는 경로는 S5대로 `files`의 home/current 포인터를 비워 삽입→위치/추출 세대·조각 삽입→포인터 채움이다. FK 지연만으로 BEFORE INSERT 검사를 피할 수 없다. dump와 JSONL import의 구현을 같은 순서라고 단정하지 않는다(E5:59; A:644; `packages/sqlite/migrations/0002_files_and_work.sql:366–373`, :391).
5. 블롭을 새 `[files] path`의 정규 locator로 놓고 hash를 검증한다. 확장 패키지/잠금/설치 상태를 재현한 뒤 `brain.schema_migrations`의 owner/version/checksum을 코드와 대조한다. 복원된 버전 표를 현재 버전으로 덮어쓰지 않는다. 필요할 때만 core→설치 확장 migration을 공통 실행기로 적용한다(A:477–486, A:582; E13:37).
6. `brain_app` 접속·확장 최소 권한·RLS 출처 격리·owner 분리·불변 UPDATE/DELETE/TRUNCATE 거부를 확인한 뒤 doctor와 실제 원본 파일 열기를 검증한다. 확장 role은 non-superuser·NOBYPASSRLS이며 core 계약 표 owner와 달라야 한다(E11:36; E13:38, E13:64).

복원 판정은 메시지·작업 로그뿐 아니라 `files`, `file_locations`, `file_metadata`, `document_extractions`, `document_chunks`의 snapshot 건수·해시, 세대 attempt/현재 포인터·locator의 보존, Brain 소유 원본의 get/open 및 bytes hash를 함께 본다. 추출 세대/조각은 DB 밖 원본이 사라질 수 있어 보존 대상이다. JSONL에서 재생성할 파생물은 chunks/embeddings/file_names/미러이고, 원문 dump 복구에서는 우선 모두 보존한 뒤 호환성에 따라 재생성하는 후보를 구분한다(E5:35, E5:60; A:400–403, A:644).

원본 없는 external/Drive 문서는 `source_unreachable_at`·`FILE_SOURCE_UNREACHABLE`로 보이면서 기존 조각 검색이 살아 있어야 한다. 복구할 수 없는 외부 원본을 “파일 개수 일치”로 숨기지 않는다. 새 기계에서 URL·root 경로 재바인딩과 재인증은 bytes 복원과 다르다(A:384, A:402; `packages/core/src/files/extract-work.ts:350`, :374).

D0의 기존 DB 합치기는 재난 복구와 별도 후보다. 만들면 먼저 양쪽 schema를 맞추고 들어오는 self user id를 받는 DB self id로 치환, 자연키 충돌·참조 매핑을 처리하고 파생물을 다시 만든다. `users.name` 갱신 여부는 아직 결정할 자리다. 원문 dump를 기존 DB에 pg_restore하는 행위는 이 merge import가 아니다. 선택지는 새 DB 복구까지만 먼저 닫고 merge를 후속 스토리로 남기는 안, 별도 가린 JSONL import와 함께 만드는 안이다(E5:61; A:245, A:644, A:765).

## 4. `setup upgrade`와 bootstrap 공유

목표 순서는 코드 갱신→build→core·설치 확장 migration→shim 재작성/필요 hook 재등록→데몬 Label 일치·재시작→doctor→installed 완료 기록이다. 자동 업데이트 off에서도 직접 실행하는 명령이며 owner별 migration 실행기를 다시 만들지 않는다. 현재 명령 등록부에는 upgrade가 없다(E5:21, E5:62, E5:68; A:346–348, A:438, A:477; `apps/cli/src/commands/index.ts:36–56`).

공유 후보는 bootstrap의 ref 검증·설치 잠금·build runner와 설치기의 migration/shim/검증/완료 흐름을 공통 갱신 orchestrator로 노출하는 방식이다. 대상 ref 결정(플러그인 app-ref 대 직접 명령 인자)은 입구 차이로 남길 수 있다. 이전 버전 bootstrap이 새 설치기를 실행한다는 경계와 plugin/bootstrap 복사본 parity를 유지해야 한다. `installed.json.commit=ref`만 보고 재시작 실패를 다시 시도하지 않는 이월 DW-4·5도 회귀 입력이다(`tooling/bootstrap/src/bootstrap.ts:389`, :412–457, :467–483; E9:95).

기존 재시작 함수는 새 commit의 pid가 나타나는지 확인한다. upgrade는 이 단계를 호출하되 데몬 없는 fixture에서도 완료되는 경로를 시험해야 한다. “항상 실제 launchd가 있어야 upgrade가 성공”은 이어받은 조건과 맞지 않는다(`apps/cli/src/daemon/control.ts:109–142`; E5:68; E9:91).

직전 앱 버전 DB 시험 후보는 직전 migration fixture 생성→메시지·작업 로그·첨부·세대·확장 확인 행 삽입→신버전 공통 upgrade 실행→원문/건수/키 불변→일반 UPDATE·DELETE·TRUNCATE 거부와 정식 redact 성공→두 번째 upgrade no-op이다. 파일 하나 적용 뒤 실패·checksum 변경·확장 한 곳 실패·doctor 실패에는 installed가 전진하지 않는지도 필요하다. 기존 PG 시험은 empty DB·재실행·동시 migration·trigger를 확인하지만 직전 **제품 버전 전체 경로**의 시험은 아니다(E5:21; `packages/postgres/test/migrate.test.ts:286–326`, :402–477; E11:35).

PG18→19는 앱 schema upgrade와 다르다. 현재 18 고정이며 19 채택은 별도 Deferred다. `setup upgrade`가 이미지 major를 자동 변경하거나 같은 volume에 새 major 서버를 올리는 범위로 넓어지지 않는다(A:517, A:656, A:783).

## 5. 완전 제거 — Done when 4

| 조치 | 담당·판정 |
|---|---|
| 데몬 Label/plist·pid·heartbeat·회전 로그 | 9.10 기존 함수 재사용. 종료 실패 시 trace 보존하고 오류, 재실행 no-op(`apps/cli/src/daemon/control.ts:74–90`; `apps/cli/test/setup-uninstall.test.ts:67–95`). |
| 컨테이너 중지, volume 기본 보존 | 11.8. compose project/volume 이름은 epic 11 파생 규칙을 사용하며 다른 홈 자원에 손대지 않는다(E11:41, E11:99; A:522). |
| Brain 표식 hook·shim·run 전체·log 전체·installed | epic 5. 사용자 hook을 통째로 덮어쓰지 않고 connector 표식 제거 기능을 확인/추가하는 후보. 현재 최소형 시험은 오히려 installed·shim 보존을 단정하므로 완전형 기대값을 별도 검증해야 한다(A:350; `apps/cli/test/setup-uninstall.test.ts:63–83`). |
| PG volume·files·spool·미러·extensions | 별도 명시적 확인 뒤만 삭제. 비대화형 미확인에는 exit 3 계약을 이어받고 선택 범위·실제 root·소유권을 표시하는 후보. runtime trace 정리와 데이터 삭제 결과를 따로 보고한다(A:350; S:50–51). |
| plugin·설정·외부 원본 | `claude plugin uninstall` 안내만. config/.env를 지울지 보관할지와 backup 묶음까지 삭제할지는 명시 계약이 아직 없다. “홈 폴더째 rm”으로 결정된 삭제 목록을 확대하지 않는다. 외부 Drive 파일·Garmin tokenstore는 Brain 데이터 디렉터리 삭제와 같은 권한이 아니다(A:320, A:350, A:385; E8:20). |

Done when 4의 SQLite 파일 삭제 문구는 PG volume으로 바꾸되 옛 `brain.db`는 epic 11 결정상 남긴다. “더 쓰지 않는 옛 DB”를 발견했다는 이유만으로 완전 제거 기본 삭제에 넣을 수 없다(E5:38, E5:71; E11:41, E11:99).

## 6. doctor 백업 경고와 가리기 전 백업

현재 runtimeChecks에는 백업 점검이 없고 추가 위치를 epic 5 자리로 예고한다. 후보 자료는 `<home>`의 private backup catalog(성공한 backup id·완료 시각·manifest 위치·범위·redaction 기준점)와 DB의 redactions 시각/순번이다. 마지막 성공 백업만 기간 계산에 쓰고 실패·임시 묶음은 갱신하지 않는다. 기본 7일과 위치 설정은 AD-20 입력이며 정확한 설정 키와 catalog 소유는 이번 인셉션의 세부다(`apps/cli/src/doctor/checks.ts:112–148`; A:349, A:566, A:782).

이전 원문 백업은 redact 뒤에도 자동 수정되지 않는다. doctor는 백업 기준점 이후 가리기가 있으면 그 백업을 식별하고 지우기/새로 뜨기를 안내해야 한다. 새 백업 성공이 옛 사본의 소거를 뜻하지 않으므로 “최신 백업이 새것이니 경고 모두 해제”는 불충분하다. 복사되어 추적 밖으로 나간 사본까지 지웠다고 약속하지 않는다(A:225–230, A:795). catalog가 파일 삭제·이동을 확인할지, 사용자가 정리 완료를 기록할지 선택지가 필요하다(A:782, A:795).

Carry I91의 재-checkpoint는 SQLite 전용 이력으로 남기고, PG 테이블 정리 완료·옛 WAL 재활용·원문 백업 경고는 구분한다. 백업 중 read snapshot이 정리와 경합하면 잠금 대기/정리 미완료를 doctor에서 숨기지 않는 검증도 필요하다(E5:66, E5:71; A:228–230).

## 7. `stats show` 입력과 순서

현재 테이블은 있지만 SQLite와 초기 PG 양쪽 모두 `id/session_id/attempted_at/ok/code/chars`뿐이다. `kind`·`elapsed_ms`가 없고 명령 등록부에도 stats가 없다. epic 3이 start/stop 주입 시도 spool·drain 및 두 칸을 만든다. 따라서 “이미 있는 표에 집계 명령만 붙이면 됨”은 사실이 아니다(`packages/sqlite/migrations/0001_initial.sql:247–257`; `packages/postgres/migrations/0001_initial.sql:165–172`; `apps/cli/src/commands/index.ts:36–56`; E3:30–34).

집계 계약은 전체·적격 세션 둘, SM-5의 doctor와 같은 모집단/판정, start의 chars, C3·과거형 단서 뒤 recall/read 도구 메모 대리 지표, Stop 성공 점검 뒤 로그 비율, elapsed_ms다. import 기본 포함·제외 옵션, 반열린 UTC 구간/meta 되울림, 측정 불능 null+경고와 관측 0 구분을 지킨다. 사람 채점 지표는 넣지 않는다(E5:23, E5:40, E5:65; A:258).

선택지 A는 stats 스토리를 epic 3 뒤로 이동(에픽 5 백업/upgrade는 먼저 가능), B는 두 에픽 순서를 바꾸는 것이다. 전자는 자료 생산·소비를 붙일 수 있지만 에픽 소유 재정제가 필요하고, 후자는 epic 5의 독립 운영 기능도 기다리게 한다. E5 Notes가 이미 이 선택을 요구하므로 여기서 결정하지 않는다. 이니셔티브의 최신 V1 뒤 순서는 5→3→4이고 통계 계산을 위해 3 구현을 5에서 복제하지 않는다(E5:73; I:141, I:194).

## 8. 레인·공유 파일과 세션 크기

| 함께 바꿀 후보 | 충돌 파일/계약 | 나눔 후보 |
|---|---|---|
| backup·restore·manifest·doctor | 새 `apps/cli/src/backup/`, `apps/cli/src/config/codec.ts`, `apps/cli/src/doctor/checks.ts`, PG 관리 접속·schema 버전 port | snapshot/manifest 계약 고정 뒤 복구·점검을 순차 연결(A:349; E11:35). |
| upgrade·bootstrap·확장 migration | `tooling/bootstrap/src/bootstrap.ts`, `plugin/bootstrap.mjs`, `apps/cli/src/install/flow.ts`, `installed.ts`, `packages/postgres/src/migrate.ts`, 확장 registry | core 실행기 변경은 epic 11 계약을 소비, entry만 추가한 뒤 공통 함수 추출(E11:35–41; E13:37). |
| uninstall·설치·doctor | `apps/cli/src/commands/setup-uninstall.ts`, `daemon/control.ts`, `connectors/`, install compose 관리, config paths | 9.10과 11.8 결과를 조합, 완전형 기대값은 별도 시험(A:350; E9:48). |
| 논리 export/import·stats | `packages/core/src/ports/store.ts`, `brain.ts`, `output/codecs.ts`, `apps/cli/src/commands/index.ts`, PG migration | stats는 epic 3 이후, export writer 등록과 merge는 백업 tracer와 분리(E3:30–34; A:644). |

DB snapshot·globals·파일 동시성·secret/config·확장 권한·새 DB 복구·실제 Mac까지 한 스토리면 실패 경계가 너무 많다. 최소 tracer는 합성 메시지 하나+Brain blob 하나의 **PG dump→새 격리 DB→동등성 확인** 왕복으로 잡고, 그 다음 snapshot/삭제 경합과 확장 role을 붙이는 후보가 작다. 같은 파일을 여러 lane에서 병렬 편집하기보다 계약과 명령 등록부를 순차 반영하는 안이 근거에 맞는다(A:349, A:522; `apps/cli/src/commands/index.ts:36`; E13:89).

## 9. Done when 1~6의 시험 기반과 빈 곳·이 Mac 확인

이 표는 소스에 정의된 시험 기반이며 이번 조사에서 통과를 확인한 결과가 아니다.

| Done when | 기존 기반 | 추가로 검증해야 할 것 |
|---|---|---|
| 1 복구·수집 비차단 | FileStore 원자 발행·root 거부, spool 계약/동시 청구, PG trigger/멱등 키 시험(`apps/cli/src/runtime/file-store.ts:13–51`; `apps/cli/test/spool.test.ts:56`, :180, :273; `packages/postgres/test/migrate.test.ts:402`, :803). | 원문/가린 산출물 각 왕복, 동일 snapshot count/hash, 메시지·로그·파일·위치·metadata·추출 세대, 실제 blob 열기, 외부 원본 없음, 확장/미설치 양쪽, 백업 중 hook 계속·중단 복구·누락 blob·손상 archive. 명령 자체가 아직 없다(`apps/cli/src/commands/index.ts:36–56`; E5:35, E5:60). |
| 2 경과 경고 | doctor machine 목록/fixture (`apps/cli/test/doctor-checks.test.ts:86–99`). | 성공/실패 backup, 7일 경계·미래/잘못된 시각·catalog 없음, redact 전 backup 식별/정리, 비밀 출력 없음(A:349, A:795). |
| 3 guard·upgrade | writes guard, 실제 수집 spool matrix·연결 복구, 설치 flow 단계 순서·doctor 실패 시험(`apps/cli/src/dispatch.ts:599–635`; `apps/cli/test/sessions-ingest.test.ts:2462`, :2512; `apps/cli/test/install-flow.test.ts:550`, :642). | owner별 mismatch와 확장 실패, 직전 DB 확인 행/trigger 생존, bootstrap/명령 parity, 데몬 없는 경로, 실패 시 installed 불변(E11:35; E5:21, E5:68). |
| 4 제거 | mac fake launchctl로 daemon 제거·반복 no-op·bootout 실패 보존·config 없는 실행(`apps/cli/test/setup-uninstall.test.ts:63–104`). | 표식 hook만 제거, 전체 run/log/shim/installed 제거, PG 중지·volume 보존, 데이터 거절/확인 exit 3, 외부 데이터 불변(A:350; S:51). |
| 5 | 삭제된 요구다. 기존 spool claim 동시성 시험과 epic 9 일감 청구를 회귀로 쓰며 주기 Label을 되살리지 않는다(E5:39; `apps/cli/test/spool.test.ts:273–296`). | 새 주기 LaunchAgent 시험을 만들지 않음(E5:67; A:405). |
| 6 stats | context 표의 골격만 있고 실제 필요한 kind·elapsed_ms 생산은 epic 3(E3:30–34; `packages/sqlite/migrations/0001_initial.sql:247`). | SQL 독립 대조, from/to 시간대 경계, 0/null 구분, import 옵션·적격 상수·도구 이름·Stop 실패 제외, doctor SM-5 공유(E5:23, E5:40, E5:65). |

구현 뒤 에이전트가 할 확인 후보는 격리 홈·DB·project/volume·Label·확장 fixture로 백업/복구/upgrade/uninstall 왕복, hook 동시 수집·원본 열기 증거를 남기는 것이다. 운영 설치본에서는 관리 경로가 완성된 뒤 **백업 한 번과 그 묶음의 격리 복구**를 계획할 수 있다. 운영 DB 덮어쓰기·volume 삭제를 복원 시험으로 쓰지 않는다. 실제 bytes·토큰·개인 메시지는 private 증거에 두고 공개 plan은 건수/판정만 남기는 후보가 적합하다(A:522; I:189–192; D:34).

위임은 설치·명령·doctor의 이 Mac 확인을 에이전트 일로 옮겼지만 명시 목록은 남은 V1 에픽이다. epic 5의 운영 백업 확인을 자동으로 승인된 실행으로 간주하지 말고 인셉션 스토리에 범위·격리 자원·비파괴 절차를 구체화할 필요가 있다. 이번 정적 조사에서는 실행하지 않았다(I:188–192; E5:69). 사람 몫은 Drive OAuth 동의·만료 로그인/MFA·모델 품질 판단·원격 push이며, 제거의 데이터 삭제는 제품이 반드시 받는 별도 확인이다. 기계 분실까지 실제로 재현하거나 운영 volume을 지우는 행위는 이 Mac 확인의 필수 조건이 아니다(I:192; D:75–85; A:350).

## 스토리 후보

아래는 tracer와 순서 선택지이며 번호·범위·최종 순서를 결정하지 않는다(E5:29–31, E5:73; A:782).

| 후보 | 관측 가능한 결과와 선행 경계 | 고칠 파일 후보 |
|---|---|---|
| tracer: 원문 백업 왕복 | PG18 합성 core 한 행+blob을 custom/globals/manifest로 뜨고 새 격리 DB·files에 복원, count/hash/get 일치. epic 11.8 자원 분리 뒤(A:349, A:522; E11:41). | 새 `apps/cli/src/backup/{export,restore,manifest}.ts`, 명령 파일·`commands/index.ts`, PG 관리 port, 새 격리 통합 시험 |
| snapshot·블롭 완전성 | count/hash와 dump 같은 snapshot, blob pin/누락 실패, temp 발행·중단 재개, hook 수집 비차단(A:387–388; E5:21, E5:35). | backup 모듈, `runtime/file-store.ts`, blob-delete handler/port, spool/backup 통합 fixture |
| 확장·권한·설정 복구 | core+garmin owner 버전·role·RLS·registry·설치 잠금·env 포함 정책·새 홈 경로 확인(E13:37–43; A:313–322). | backup 범위 resolver/manifest, 확장 registry reader, `config/codec.ts`, PG 복구 관리 코드·권한 시험 |
| 공통 갱신+직접 upgrade | bootstrap과 명령이 같은 단계, 직전 DB/trigger 확인, 새 데몬/데몬 없음, installed 마지막(E5:21, E5:68; A:348). | `tooling/bootstrap/src/bootstrap.ts`, 생성 `plugin/bootstrap.mjs`, `install/flow.ts`, `install/installed.ts`, 새 setup-upgrade command·회귀 시험 |
| 백업 doctor | 마지막 성공 경과·이전 redact backup 목록과 정리 안내(A:349, A:795). | backup catalog, `doctor/checks.ts`, `config/codec.ts`, doctor fixture |
| 완전 제거 | 9.10·11.8 조합+표식 hook/shim/runtime 제거, 데이터는 확인 전 보존(A:350; E9:48). | `commands/setup-uninstall.ts`, `daemon/control.ts`, `connectors/`, PG compose 관리·paths, uninstall 시험 |
| 가린 논리 export/import | JSONL 출력 코덱·패턴 버전·S5 복원·D0 merge 별도 범위 선택(E5:59–63; A:644). | 새 core export/import use case·Store read port, `output/codecs.ts`, PG adapter, CLI command·masking/복원 시험 |
| stats | epic 3 자료 생산 뒤 SQL 대조 집계. epic 3으로 이동 또는 순서 교체(E5:73). | core stats/기간 판정·Store port, PG aggregate adapter, CLI stats command/registry·fixture |
| 정리·이 Mac 증거 | 공개 집계만 남기고 격리 복원 및 운영 백업 1회 계획의 승인 범위를 명시(I:188–192; A:522). | 해당 구현 시험·plan(이 보고서에서는 편집하지 않음) |

순서 후보 A는 tracer→일관성/확장 복구→upgrade→doctor→완전 제거→가린 export/import→stats(3 뒤)다. 후보 B는 공통 upgrade 추출을 tracer 직후 병행 준비하되 registry/config/PG port 변경은 순차 반영한다. stats를 앞당기려면 먼저 E5:73의 소유/순서를 정제해야 하며, 백업 세부 설계와 merge import를 한 세션에 묶을 이유는 없다(위 §8 파일 충돌 표; E5:61, E5:68, E5:73; A:782).
