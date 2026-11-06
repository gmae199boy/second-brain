# 쿼리 성능 측정

전용 PostgreSQL 관리자 URL과 빌드된 checkout이 필요하다. 조건별 DB는 생성 후 삭제한다. `prepareDatabase`가 클러스터 role 암호를 바꾸므로 공유 서버는 사용하지 않는다.

기준 export를 준비한다(예시 SHA를 실제 40자 기준 커밋으로 변경).

```sh
mkdir -p /tmp/query-perf-base
git archive <sha> | tar -x -C /tmp/query-perf-base
printf '%s\n' '<40자-sha>' > /tmp/query-perf-base/.query-perf-revision
(cd /tmp/query-perf-base && pnpm install --offline --frozen-lockfile && pnpm --filter @second-brain/postgres... build)
pnpm build
```

기준과 변경 checkout을 동일한 전용 서버에서 순차 측정하고 비교한다.

```sh
node tooling/query-perf/run.mjs import-cleanup --checkout /tmp/query-perf-base --database-url postgres://postgres:postgres@127.0.0.1:54221/postgres --out base.json --candidate none
node tooling/query-perf/run.mjs import-cleanup --checkout . --database-url postgres://postgres:postgres@127.0.0.1:54221/postgres --out change.json --candidate none
node tooling/query-perf/run.mjs compare base.json change.json
```

후보 탐색은 migration 0039 이전 기준 export에서 따로 한다.

```sh
node tooling/query-perf/run.mjs import-cleanup --checkout /tmp/query-perf-base --database-url postgres://postgres:postgres@127.0.0.1:54221/postgres --out candidate.json --candidate both --query-variant rewritten
```

`--candidate`는 none, locator, open, both이고 `--query-variant`는 original, rewritten이다. none은 checkout의 migration 상태를 그대로 사용한다. 각 크기 1천·1만·10만과 idle·pending100·shared100의 9개 조건이 양쪽에 정확히 있어야 비교가 통과한다. 결과 hash가 같고 10만 pending 중앙값이 기준의 50% 이하, 각 idle 중앙값이 110% 이하여야 한다. unhanded hash 일치도 필수이고 시간 비율은 참고값이다.

조회와 공유 cleanup은 warm-up 뒤 세 번 측정한다. original의 판정용 `medianMs`는 실제 store 목록 호출이고 rewritten에서는 직접 Client로 실행한 재작성 목록 SQL의 중앙값이다. rewritten 결과에는 같은 Client로 잰 원문 목록 `originalDirect`와 pending SQL `cleanupOriginalDirect`, 재작성 pending `cleanupRewritten`도 기록해 공정하게 비교할 수 있다. 공유 cleanup은 삭제 차단을 확인하며 전체 EXPLAIN, unhanded, 쓰기 배치 및 인덱스 정의도 기록한다.

자체 Git 루트는 HEAD, dirty 및 tracked diff와 postgres src/migrations의 untracked 내용을 포함하는 지문을 기록한다. export는 `.query-perf-revision` SHA를 쓰며 dirty와 diff 지문은 null이다. postgres 및 core dist, migration, lockfile과 실행 중인 러너의 파일 지문이 기록된다. 출력에는 연결 URL이나 checkout 경로를 넣지 않는다.

후속 2~5 시나리오는 `src/`에 모듈을 추가하고 `run.mjs` 명령 분기에 연결한다. `src/core.mjs`의 중앙값과 해시를 재사용하고 시나리오별 fixture와 판정 기준을 정의한다.

## 큰 세션 snapshot

이 시나리오는 별도 PostgreSQL **클러스터**를 요구한다. `prepareDatabase`가 클러스터 role 암호를 바꾸므로 운영 서버, 공용 시험 DB 또는 다른 작업의 클러스터를 절대 사용하지 않는다. 아래는 개발과 리뷰 수정을 모두 마친 뒤 사용할 예시다. 성능 측정 전에 호스트 부하와 병렬 프로세스, 시간, Node/PG 버전을 기록하고 다른 무거운 작업이 있으면 측정 시점을 조율한다. 컨테이너 이름·포트가 이미 사용 중이면 기존 자원을 건드리지 말고 새 고유 이름과 포트를 정한다.

```sh
# 소유 이름·포트가 비어 있는지 확인하고 컨테이너 ID를 기록한다.
docker ps -a --filter name=^/brain-222-perf$ --format '{{.ID}} {{.Names}}'
docker run -d --name brain-222-perf -e POSTGRES_PASSWORD=query-perf-only -p 127.0.0.1:54222:5432 postgres:18
# docker inspect로 정확한 ID/이미지, 포트와 ready 상태를 확인한다.
docker inspect brain-222-perf
```

실행자가 소유한 새 임시 경로에 기준 commit의 독립 빌드를 준비하고, 변경 checkout도 빌드한다. 기존 임시 디렉터리를 덮어쓰거나 다른 작업의 산출물을 삭제하지 않는다. `pnpm install`은 lockfile을 고정하며 환경에 필요한 패키지가 준비돼 있어야 한다.

```sh
perf_root=$(mktemp -d "${TMPDIR:-/tmp}/brain-222-perf.XXXXXXXX")
mkdir "$perf_root/base"
git archive b581a90abc6956364d394e5b19aac8e90cb32609 | tar -x -C "$perf_root/base"
printf '%s\n' b581a90abc6956364d394e5b19aac8e90cb32609 > "$perf_root/base/.query-perf-revision"
(cd "$perf_root/base" && pnpm install --offline --frozen-lockfile && pnpm --filter @second-brain/postgres... build)
pnpm build
node tooling/query-perf/run.mjs session-snapshot --checkout "$perf_root/base" --database-url postgres://postgres:query-perf-only@127.0.0.1:54222/postgres --out "$perf_root/base-result.json"
node tooling/query-perf/run.mjs session-snapshot --checkout . --database-url postgres://postgres:query-perf-only@127.0.0.1:54222/postgres --out "$perf_root/change-result.json"
node tooling/query-perf/run.mjs compare "$perf_root/base-result.json" "$perf_root/change-result.json"
```

두 실행은 같은 현재 러너·전용 클러스터·fixture로 순차 실행한다. 명령, 종료 코드, 결과 JSON, 호스트 부하와 병렬 프로세스 증거, 이미지 ID 및 정리 영수증을 작업별 로컬 기록으로 보존한다. 러너는 임의 이름의 독립 database를 만들고 `finally`에 해당 database만 제거한다. 실패 시 오류에 남은 database 이름과 실제 소유권을 확인하고 다른 DB를 삭제하지 않는다. 측정이 완전히 끝나면 기록한 **정확한 ID**가 위에서 생성한 컨테이너와 일치함을 확인한 뒤 `docker rm -f <확인한-컨테이너-ID>`를 실행하고 `docker inspect <확인한-컨테이너-ID>`의 부재를 기록한다. 기준 경로와 결과 파일은 소유권 및 필요한 증거 보존 여부를 확인한 후에만 정리한다.

fixture는 1024 ASCII 바이트 × 10만 메시지와 20행 동시각 그룹, 5천 조각이다. 실제 checkout의 `readConversationSnapshot`과 `commitConversationChunks`를 호출해 초기 조각 생성, warm-up 1회, 각 3회 측정 및 변경 후 stale 거부를 확인한다. 독립으로 구성한 원문/설정의 전체 JSON SHA와 행·조각 hash에 대조한다. 결과의 `measurements.readTransaction`, `commitTransaction`, `lockHeld`는 query 추적의 BEGIN 완료~COMMIT 완료 또는 advisory 획득 완료~COMMIT 완료이며 비교기의 세 0.5 기준이다. 별도 연결의 advisory 대기는 `advisoryWait`, API 벽시계는 `readWall`/`commitWall`, 메시지 재읽기와 다른 SQL 시간은 `readQueries`/`commitQueries`, 실제 조회의 계획은 `explain`이다. `diagnostic`의 전체 JSON 직렬화·Node hash·core fingerprint 시간은 별도 함수 실행으로, transaction 내부에서 직접 분해한 시간이 아니다. CPU는 측정 반복 전체 구간의 프로세스 사용량이고 최대 RSS는 프로세스 생애의 high-water 값이다. fixture 구성·초기 조각 쓰기·독립 기대값 검사·EXPLAIN과 stale 검사는 해당 transaction 표본에 포함하지 않는다. 결과에는 synthetic 데이터의 지문과 행수만 기록하며 연결 URL과 checkout 경로는 기록하지 않는다.

비교기는 동일 fixture/러너/Node/PG/플랫폼과 결과 지문·stale 판정을 요구하고 세 transaction/잠금 중앙값이 각각 기준의 절반 이하인 경우에만 성공한다. 세 표본과 중앙값의 불일치, 누락·잘못된 provenance 또는 fixture는 오류로 거부한다. 부하·병렬 프로세스·원시 로그를 별도로 검토해야 하며 자동 비교 성공만으로 측정 환경의 동등성이 증명되지는 않는다. 이 시나리오는 동시 반입과 redaction의 전체 계약 시험이나 실제 운영 데이터 성능을 대체하지 않는다.

초기 조각 생성과 기존 조각 하나의 본문 교체도 별도 조건으로 준비를 제외하고 warm-up 1회와 3회 transaction 표본을 수집한다. 각각 `initialWrite`와 `changedWrite`에 남고 독립 생성한 결과 hash를 매 반복 검사한다. 비교기의 `writeRatios`는 전후 쓰기 비율을 보고하며 기존 unchanged의 세 0.5 기준과 섞지 않는다. `measurements.probe`의 PID와 `pg_locks`에서 확인한 대기 횟수는 별도 연결이 실제 같은 advisory lock을 기다렸다는 증거다. 대기를 관측하지 못하면 측정은 실패한다. `resources`는 생성한 database 이름과 생성·삭제 상태를 보존하며 삭제 실패 시 오류에도 남는다.

`tooling/query-perf/test/session-snapshot.test.ts`는 결정적 시계의 transaction/잠금 경계와 비교기 provenance를, `session-snapshot-db.test.ts`는 독립 임시 PostgreSQL에서 40행 경로의 warm-up 제외·oracle·실제 대기·성공과 주입 실패 뒤 정리를 검증한다. 이 소형 시험 결과는 10만 행 성능 비교기로 수락되지 않는다. 시험은 개발과 리뷰 수정이 모두 끝난 후 프로젝트 전체 회귀에서 실행한다.

판정용 read/commit/lock 표본은 관측 장벽 없이 warmup 1회와 측정 3회를 수집한다. 동일 advisory key의 실제 대기는 별도의 warmup 1회와 진단 3회에서 `pg_locks`, probe PID, 대기 시간 및 진단 전체 경과 시간과 시작·종료 시각을 기록한다. 비교기의 0.5 기준은 무간섭 판정 표본에만 적용하며 진단 대기 표본의 개수와 중앙값도 검증한다. 관리·fixture·probe 연결의 raw SQL에는 120초 query timeout을 적용하고, 제품 API 표본은 제품 store의 timeout을 비활성화하여 별도로 측정한다.

오래된 snapshot 검증은 불변 메시지를 수정하지 않고 새 합성 메시지를 추가한다. 추가 후 실제 snapshot 지문과 메시지를 독립 기대값에 대조하고 이전 지문과 다름을 확인한 뒤 오래된 commit 거부 및 기존 조각 불변을 확인한다. 결과의 `staleFingerprint`도 비교한다.

## 대량 첨부 반입

개발과 리뷰 수정을 마친 뒤에만 실행한다. 위 snapshot 절과 동일하게 **작업 전용 PostgreSQL 클러스터**를 새로 마련한다. `prepareDatabase`는 클러스터 role을 변경하므로 다른 작업의 DB나 운영 클러스터를 사용하지 않는다. Node와 PostgreSQL 버전·CPU·부하·동시 프로세스를 기록하고 기준과 변경을 같은 클러스터에서 순차 실행한다. 아래 포트와 이름은 예시이며 충돌 시 소유한 새 이름과 포트를 사용한다. 컨테이너 정확 ID, 이미지 ID, 종료 코드, 로그와 결과를 보존한다.

```sh
perf_root=$(mktemp -d "${TMPDIR:-/tmp}/brain-224-perf.XXXXXXXX")
mkdir "$perf_root/base"
git archive 9a9c8d60bc8052851220b9869a737b11aa257f1b | tar -x -C "$perf_root/base"
printf '%s\n' 9a9c8d60bc8052851220b9869a737b11aa257f1b > "$perf_root/base/.query-perf-revision"
(cd "$perf_root/base" && pnpm install --offline --frozen-lockfile && pnpm --filter @second-brain/postgres... build)
pnpm build
node tooling/query-perf/run.mjs write-attachments --checkout "$perf_root/base" --database-url postgres://postgres:query-perf-only@127.0.0.1:54224/postgres --out "$perf_root/base-result.json"
node tooling/query-perf/run.mjs write-attachments --checkout . --database-url postgres://postgres:query-perf-only@127.0.0.1:54224/postgres --out "$perf_root/change-result.json"
node tooling/query-perf/run.mjs compare "$perf_root/base-result.json" "$perf_root/change-result.json"
```

러너는 각 checkout의 실제 `packages/postgres/dist/attachments.js`에서 기존에도 export된 `writeAttachments`를 불러온다. 독립 database에 합성 세션과 메시지를 준비하고 세션 advisory lock을 가진 transaction에서 호출한다. 1·10·100·1000개 각각에 새 파일과 brain/external 두 위치, 기존 첨부, 파일 없음의 12조건을 실행한다. 조건별 warmup 1회 후 3회의 함수 벽시계 시간과 함수 내부 SQL 횟수를 기록한다. 설정·잠금 획득·commit·재반입은 시간과 SQL 수에 포함하지 않는다. 표본마다 전체 파일·위치·첨부 행을 보존하고 재반입 전후 전체 행의 불변성을 검사한다. 각 조건의 첫 실제 SELECT는 시간 표본 밖의 별도 반복에서 측정 전과 같은 빈 슬롯 또는 기존 첨부 seed 상태를 복원한 뒤 `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)`으로 실행한다. 사전 단계와 세 테이블 행수를 함께 기록한다. 초기화에만 fixture 연결을 replica로 전환하고 finally에서 origin으로 복원하며, 관리·fixture 연결은 관리자 자격을 유지하고 측정 연결은 준비된 `brain_app` 자격과 origin을 확인해 기록한다. 양쪽 측정 Pool에는 10초 연결 제한과 서버 `statement_timeout` 120초와 클라이언트 `query_timeout` 121초를 동일하게 적용한다. fixture 연결에도 10초 연결 제한을 적용한다. 이 제한은 정상 호출의 측정값에 별도 계측을 삽입하지 않는다. 서버 기한 초과 시 명령을 취소하고, 응답이 사라진 경우 클라이언트 기한으로 실패·정리하며 해당 표본을 채택하지 않는다.

비교기는 12조건, fixture와 입력 지문, 실제 빌드·함수·러너 지문과 기준 SHA, 환경, 정리, 행 전체와 해시, 재반입, 세 표본·중앙값·SQL 수를 검증한다. 1000개는 시간과 SQL 수 모두 기준의 50% 이하, 1·10개는 시간 110% 이하여야 한다. SQL 비교는 세 변경 표본의 최대값과 기준 표본의 최소값을 사용한다. 결과 JSON에는 합성 행 전체가 들어가지만 연결 URL은 들어가지 않는다. 시스템 부하와 동시 프로세스는 별도 기록도 확인한다. 러너는 자신이 만든 임의 이름 DB만 삭제하고 실패 시 DB 이름과 삭제 여부를 오류로 보고한다. 컨테이너는 실행자가 확인한 정확한 ID만 제거하고 부재를 기록한다. 실패한 측정과 원시 로그를 지우지 않는다.

## 파일 위치 UUID 조회

개발·리뷰 수정 뒤 중앙에서 승인한 성능 측정 창에만 실행한다. 작업 전용 PostgreSQL 클러스터가 필요하다. `prepareDatabase`가 클러스터 role 암호를 변경하므로 다른 작업이나 운영 서버를 사용하지 않는다. 독립 baseline archive를 만들고 같은 러너와 전용 서버에서 순차 실행한다.

```sh
perf_root=$(mktemp -d "${TMPDIR:-/tmp}/brain-225-perf.XXXXXXXX")
mkdir "$perf_root/base"
git archive eaff4ccd4de4932f8a899dd9c8d69277380f44f7 | tar -x -C "$perf_root/base"
printf '%s\n' eaff4ccd4de4932f8a899dd9c8d69277380f44f7 > "$perf_root/base/.query-perf-revision"
(cd "$perf_root/base" && pnpm install --offline --frozen-lockfile && pnpm --filter @second-brain/postgres... build)
pnpm build
node tooling/query-perf/run.mjs file-locations --checkout "$perf_root/base" --database-url postgres://postgres:query-perf-only@127.0.0.1:54225/postgres --out "$perf_root/base.json"
node tooling/query-perf/run.mjs file-locations --checkout . --database-url postgres://postgres:query-perf-only@127.0.0.1:54225/postgres --out "$perf_root/change.json"
node tooling/query-perf/run.mjs compare "$perf_root/base.json" "$perf_root/change.json"
```

러너는 소유한 임의 이름 DB에 합성 파일·위치 각 10만 행을 만든다. 실제 store의 read/list/mark마다 warmup 1회와 표본 3회를 실행하고, mark는 서로 다른 미삭제 행을 사용한다. 각 호출의 반환, 호출 전후 행, 전체 변경 행과 SQL 수를 독립 fixture oracle에 대조한다. 별도 트랜잭션에서 수집한 EXPLAIN은 rollback한다. 비교기는 기준 SHA, fixture, 빌드·migration·lockfile·러너 지문, 환경 및 정리, 세 표본과 oracle을 확인하고 변경 실행 계획의 UUID 인덱스 조회와 read/mark 중앙값 50% 이하를 요구한다. 결과 JSON과 실패 로그, 종료 코드, 서버·컨테이너 소유권과 정리 증거를 보존한다.

각 측정 대상 파일에는 brain/external 소유권과 서로 다른 경로를 가진 세 위치가 있으며 반환 순서와 개수를 독립 oracle로 확인한다. 시간 표본 밖에서 canonical·부재·대소문자·괄호·무하이픈·공백·비UUID·빈 문자열·null·undefined의 read/list/첫·반복 mark 및 잘못된 시각 결과를 검증한다. 전체 files와 위치 행의 개수 및 `deleted_at`을 제외한 내용 지문을 호출 전후와 양쪽 checkout 사이에 비교하고, 허용된 삭제 시각 변경 행은 별도로 대조한다. migration 파일별 SHA-256 manifest와 실제 적용 checksum도 양쪽에서 대조한다. 각 호출의 SQL trace는 read/list 각 1문, mark BEGIN·UPDATE·SELECT·COMMIT 4문을 요구한다. read/list 및 mark 두 문의 EXPLAIN은 동일한 brain_app/origin 세션 설정의 별도 rollback 트랜잭션에서 수행한다.
