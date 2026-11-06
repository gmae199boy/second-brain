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
