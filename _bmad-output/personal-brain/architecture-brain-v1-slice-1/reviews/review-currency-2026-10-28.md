판정: 조건부 불통과 — 주요 기술과 PostgreSQL 18 선택은 유효하지만, pg_bigm 전환 가정·VACUUM 삭제 보장·오래된 보안 패치 및 PostgreSQL 19 일정은 수정해야 한다.

검토일: 2026-10-28. 대상: spine 전체, 특히 AD-7·10·11·15·29~35, Stack, Deferred 및 `.memlog.md`의 이번 update 기록.
방법: 실제 `npm view <pkg> version engines --json`, PyPI JSON의 `info.version`·`requires_python`·배포 wheel, Docker Hub, 공식 문서 대조. 문서·레지스트리 확인과 실행 검증을 구분했다. 컨테이너 생성·DB 변경·설치·실데이터 반입은 하지 않았다.
`.memlog.md` 115·119행에는 조사 사실이 있으나 원문 URL·응답이 없어 과거 조사 과정을 독립 재현할 수는 없다. 아래는 이번 검토에서 새로 확인한 근거다.

## Critical

없음.

## High

### H1 — AD-15·Deferred: pg_bigm 전환 시 ILIKE 질의를 유지한다는 가정이 틀림

- 문제: pg_bigm 1.2의 `gin_bigm_ops`는 `LIKE`(`~~`)와 유사도 연산자만 등록하며 `ILIKE`(`~~*`)는 없다. 현재 질의를 그대로 두고 이미지·색인만 바꿔도 두 글자 검색이 빨라진다는 결론은 성립하지 않는다. 현재 pg_trgm 선택 자체는 유효하다.
- 근거: [공식 비교표](https://pgbigm.github.io/pg_bigm/pg_bigm_en.html), [현재 확장 SQL의 operator class](https://raw.githubusercontent.com/pgbigm/pg_bigm/master/pg_bigm--1.2.sql).
- 수정: 전환 비용에 검색 adapter의 SQL 변경을 포함한다. 예컨대 동일한 정규화·collation의 `lower(column) LIKE lower(pattern)`와 대응 expression GIN을 검증하거나, 전환 후보를 미정으로 되돌린다. Core 검색 의미 계약은 유지할 수 있다.
- disposition: **discuss**.

### H2 — AD-11·Capability map: VACUUM 완료를 물리 삭제 완료로 취급할 수 없음

- 문제: 보통 VACUUM은 dead tuple 공간을 재사용 가능하게 만들며 비밀 바이트의 덮어쓰기·WAL·기존 백업 소거를 보장하지 않는다. 따라서 VACUUM 일감 완료만으로 doctor 경고를 해제하면 “저장본에서도 지움”의 물리적 보장을 과장한다. 긴 snapshot이 있으면 회수 자체도 지연될 수 있다.
- 근거: [VACUUM의 실제 의미](https://www.postgresql.org/docs/18/sql-vacuum.html), [변경 기록과 과거 상태 복구를 보존하는 WAL](https://www.postgresql.org/docs/18/continuous-archiving.html). 여기서 바이트 소거 보장이 없다는 결론은 문서에서 도출한 판단이다.
- 수정: 논리 가리기와 공간 회수의 완료 상태로 계약을 한정하고, 물리 소거·기존 dump/볼륨 백업 처리 범위는 별도로 명시한다. VACUUM은 트랜잭션 밖에서 실행하며 runtime role의 `MAINTAIN` 등 실행 권한도 정한다.
- disposition: **discuss**.

### H3 — Stack·AD-19: 런타임 기준이 최신 보안 패치를 반영하지 않음

- 문제: Node 24.22.0 설명과 `>=24.16.0` 설치 하한은 10월 21일 보안판 24.22.1 이전 버전도 통과시킨다. Garmin 새 배포를 Python 3.14.8로 고정하면 10월 25일 보안판 3.14.10의 인증서·tarfile 수정도 빠진다. API 호환 하한과 새 설치 권장판을 구분해야 한다.
- 근거: [Node 24.22.1 보안 릴리스](https://nodejs.org/en/blog/release/v24.22.1/), [Python 3.14.10 보안 릴리스](https://www.python.org/downloads/release/python-31410/).
- 수정: 호환 하한은 필요하면 유지하되 신규 설치·doctor의 지원 패치 기준을 Node 24.22.1 이상인 지원 라인과 Python 3.14.10 이상으로 갱신하고, 기존 Garmin 실행 환경을 계속 고정해야 한다면 그 이유·갱신 검증을 남긴다. 기존 데이터 보존과 런타임 패치 갱신은 별개다.
- disposition: **discuss**.

## Medium

### M1 — Stack·Deferred: PostgreSQL 19 GA 예정일이 이미 변경됨

- 문제: “2026-10-29 예정(미확인)”은 10월 15일 공식 RC1 발표보다 오래된 일정이다. 현재 공식 계획은 RC2 11월 12일, GA 11월 19일이다.
- 근거: [PostgreSQL 19 RC1 공식 발표](https://www.postgresql.org/about/news/postgresql-19-rc-1-released-3409/).
- 수정: 두 위치와 후속 결정의 참고 날짜를 11월 19일 예정으로 정정한다. PostgreSQL 18 채택은 그대로 유효하다.
- disposition: **autofix**.

### M2 — AD-15: “3자 이상 색인, 2자 순차”는 실행 계획 보장이 아님

- 문제: `%한국%` 같은 두 글자 부분 일치는 유용한 trigram을 못 뽑지만 반드시 sequential scan이 선택되는 것은 아니다. 공식 문서는 full-index scan 퇴화를 명시한다. `a-b`처럼 세 글자여도 연속된 유효 trigram이 없을 수 있고, 선택도에 따라 긴 질의도 순차 검색이 된다. 한국어·collation·실제 데이터 규모의 실행 측정은 이번에도 미확인이다.
- 근거: [PG18 pg_trgm의 문자 추출·GIN/ILIKE 지원·퇴화 조건](https://www.postgresql.org/docs/18/pgtrgm.html).
- 수정: “추출 가능한 trigram이 있으면 색인 사용 가능, 없으면 전체 검색 비용 허용”으로 쓴다. epic 17에서 공식 이미지의 실제 locale로 한국어 두 글자·세 글자·공백·기호를 `EXPLAIN (ANALYZE, BUFFERS)` 및 R14/SM-7 회귀로 측정한다.
- disposition: **autofix** (문구), **defer** (epic 17 실측).

### M3 — AD-34: PostgreSQL 18의 변경된 볼륨 대상 경로가 계약에 빠짐

- 문제: named volume 이름만 있고 mount target이 없다. PG18 공식 이미지는 `PGDATA=/var/lib/postgresql/18/docker`, VOLUME `/var/lib/postgresql`로 바뀌었다. 예전 `/var/lib/postgresql/data` 예제를 재사용하면 의도한 볼륨과 실제 DB 위치가 어긋날 수 있어 R3의 재생성 보존을 보장하지 못한다. 현재 잘못된 compose가 존재한다는 지적은 아니다.
- 근거: [공식 이미지 PGDATA 변경 안내](https://hub.docker.com/_/postgres#pgdata).
- 수정: 기본 mount를 `second-brain-pg:/var/lib/postgresql`로 명시하고 컨테이너 재생성 후 같은 데이터·설정이 남는 시험을 epic 11에 연결한다.
- disposition: **autofix**.

### M4 — Stack·AD-29 설치: psycopg 패키지만으로 macOS 설치 선행 조건이 닫히지 않음

- 문제: `psycopg` 기본 배포는 pure Python이지만 시스템 libpq가 필요하다. PostgreSQL이 OrbStack 컨테이너에 있다는 사실만으로 호스트 Python에 libpq가 생기지는 않는다. Garmin 확장의 실제 `uv.lock`·`.python-version`은 이 checkout에 없으므로 기존 배포의 정확한 의존성 조합도 아직 대조하지 못했다.
- 근거: [psycopg 공식 설치 방식](https://www.psycopg.org/psycopg3/docs/basic/install.html), [3.3.6 PyPI JSON](https://pypi.org/pypi/psycopg/json), checkout의 파일 목록 확인.
- 수정: 확장 신규 설치를 `psycopg[binary]`로 정하거나 host libpq 설치·검출을 명시한다. epic 13/14에서 실제 legacy lock과 macOS arm64 Python 조합의 import·DB 접속을 확인하고 lock 경로/해시를 기록한다.
- disposition: **discuss** (설치 방식), **defer** (lock·설치 검증).

## Low

### L1 — Stack: 일부 최신 버전 설명이 낡았으며, 고정판과 최신판을 구분할 필요가 있음

- 문제: 실제 조회는 pnpm 12.15.0, vitest 5.0.5다. 기록의 pnpm 12.11.2는 과거 날짜의 값이므로 오류는 아니지만 현재 설치 시 최신과 다르다. vitest 5.0.4와 uuid 설치본 14.0.2도 실재하는 고정판이며 최신이 아니라는 이유만으로 강제 업그레이드할 필요는 없다.
- 근거: `npm view pnpm version engines --json`, `npm view vitest version engines --json`, `npm view uuid version --json`; [pnpm registry](https://registry.npmjs.org/pnpm/latest), [vitest registry](https://registry.npmjs.org/vitest/latest), [uuid registry](https://registry.npmjs.org/uuid/latest).
- 수정: Stack에 “저장소 고정판 / 2026-10-28 조회 최신판”을 나누거나 최신 수식어를 제거한다. pnpm 자동 최신 설치 정책의 호환성 판단은 별도로 유지한다.
- disposition: **autofix**.

## 확인된 사항과 검증 경계

| 위치·대상 | 2026-10-28 확인 결과·근거 |
| --- | --- |
| Stack: TS·CLI·설정·문서 추출 | `npm view` 최신: typescript 7.0.2, commander 15.0.0, smol-toml 1.9.1, @clack/prompts 1.8.1, pdfjs-dist 6.4.299, mammoth 1.13.0, file-type 22.2.0, exif-reader 2.0.3. 모두 실재하며 선언된 Node 24.16 하한과 engines 충돌 없음. [npm 공식 registry](https://registry.npmjs.org/)에서 각각 조회. |
| Stack: uuid·vitest·pnpm | uuid 최신 14.0.3 확인, 저장소 14.0.2 사용 설명과 양립. vitest 5.0.5의 Node 범위는 `^22.12.0 \|\| ^24.0.0 \|\| >=26.0.0`; pnpm 12.15.0은 `>=18`. API/설치 역할은 유효. |
| AD-7·Stack: pg·Kysely | `pg` 8.23.1, Kysely 0.29.7 확인. lock의 Kysely 0.29.6 설명도 일치. [pg 트랜잭션](https://node-postgres.com/features/transactions)은 같은 client 필수; [Kysely sql template](https://kysely-org.github.io/kysely-apidoc/interfaces/Sql.html)은 값 parameterization 지원. `withWrite`와 적합. |
| AD-10·34·Stack: PG18·pg_trgm | [Docker Hub](https://hub.docker.com/_/postgres)에 18·18.6·arm64 태그 계열 확인, [PG 릴리스 목록](https://www.postgresql.org/docs/release/)도 18.6. pg_trgm은 PG18 contrib이며 [공식 Dockerfile](https://raw.githubusercontent.com/docker-library/postgres/master/18/trixie/Dockerfile)의 PostgreSQL 패키지 배포를 통해 제공됨; 실제 image의 `CREATE EXTENSION` 실행은 하지 않음. |
| AD-7·21·31: 잠금·청구 | [transaction advisory lock](https://www.postgresql.org/docs/18/explicit-locking.html)은 트랜잭션 종료 시 해제되므로 세션 수집 직렬화에 적합. 문자열 토큰을 bigint/두 int key로 매핑하는 구체 방식은 구현에서 필요. [SKIP LOCKED](https://www.postgresql.org/docs/18/sql-select.html)는 일반 조회보다 queue 다중 소비자 용도에 적합하다고 공식 명시. |
| AD-11: transaction-local GUC | [set_config의 is_local=true](https://www.postgresql.org/docs/18/functions-admin.html)는 현재 트랜잭션에서만 유효. [custom GUC](https://www.postgresql.org/docs/18/runtime-config-custom.html)는 두 부분 이름 허용. 코드 실수 방지 표식으로 적합하나 SQL 권한 보유자에 대한 인증 수단은 아님. |
| AD-30: 확장 RLS | [PG18 RLS](https://www.postgresql.org/docs/18/ddl-rowsecurity.html)는 INSERT `WITH CHECK`로 출처 제한 가능. 계약 표는 owner와 분리한 non-superuser·NOBYPASSRLS 확장 role, ENABLE RLS와 role별 정책이 전제다. 정책의 출처는 클라이언트가 바꾸는 GUC가 아닌 DB role에 결합해야 하며, 실제 migration·부정 삽입 검증은 아직 없음. |
| AD-34: OrbStack·Compose | [OrbStack](https://docs.orbstack.dev/docker/)은 Docker·Compose·volume 지원. [unless-stopped](https://docs.docker.com/engine/containers/start-containers-automatically/)도 유효하나 수동 중지 컨테이너는 engine 재시작만으로 올라오지 않음. AD-27의 명시적 재기동 경로와 함께 해석해야 함. |
| setup 준비 대기 | [compose up --wait](https://docs.docker.com/reference/cli/docker/compose/up/)는 존재하며 detached를 함의. healthcheck가 없으면 running만 기다리므로 SQL 준비 보장에는 `pg_isready` healthcheck 또는 실제 연결 점검 필요. spine에는 정확한 명령·healthcheck가 아직 고정되지 않음. |
| Stack: Node API·LTS | [crypto.randomUUIDv7](https://nodejs.org/docs/latest-v24.x/api/crypto.html#cryptorandomuuidv7options)의 추가 버전은 24.16.0이 맞음. [공식 schedule](https://raw.githubusercontent.com/nodejs/Release/main/schedule.json)에서 24 Maintenance 10-20, 26 LTS 10-28 확인. |
| Stack: Python·uv | Python 3.14.8 실재, 다만 H3 참조. [uv PyPI](https://pypi.org/pypi/uv/json) 최신 0.13.6. [uv lock/sync 문서](https://docs.astral.sh/uv/concepts/projects/sync/)와 재현 설치 목적 일치; 자동 lock 갱신 방지를 위한 `--locked` 등 정책은 확장 설치 구현에서 확인 필요. |
| Stack: Garmin Python 패키지 | PyPI JSON 직접 파싱: [psycopg](https://pypi.org/pypi/psycopg/json) 3.3.6/Python >=3.10, [garminconnect](https://pypi.org/pypi/garminconnect/json) 0.3.20/>=3.12, [curl-cffi](https://pypi.org/pypi/curl-cffi/json) 0.17.0/>=3.10. Garmin API와 HTTP/TLS 클라이언트 용도 확인. curl-cffi의 macOS arm64 abi3 wheel 있음. 로그인·MFA 실동작은 R11 fixture 및 계정 검증 과제. |
| Stack: 나머지 Python 패키지 | PyPI JSON: [jsonschema](https://pypi.org/pypi/jsonschema/json) 4.26.0/>=3.10, [matplotlib](https://pypi.org/pypi/matplotlib/json) 3.11.2/>=3.11, [requests](https://pypi.org/pypi/requests/json) 2.34.2/>=3.10. schema 검증·PNG 그래프·HTTP 용도와 맞으며 matplotlib cp314 macOS arm64 wheel 확인. 기존 lock의 고정판이라는 검증은 M4처럼 미완료. |
| Stack: 선택 모델 | [Model Studio embedding](https://www.alibabacloud.com/help/en/model-studio/embedding)에 qwen3.7-text-embedding 및 기본 1024차원·한국어 명시, [rerank API](https://help.aliyun.com/en/model-studio/rerank)에 qwen3-rerank 명시. 모델 실재·용도 확인, 계정/region의 실제 호출은 미실행; C2대로 필수 선행 조건 아님. |

결론의 범위: 명명된 주요 라이브러리가 사라졌거나 PostgreSQL 18 채택이 불가능하다는 근거는 없다. 반면 공식 기능의 존재만으로 한국어 검색 지연·RLS 격리·설치 재현성이 실측 검증됐다고 판정하지는 않는다. 개인 코드 구조·언어·작업 순서는 사용자 결정이며 최신 제품 사실과 별도로 평가했다.
