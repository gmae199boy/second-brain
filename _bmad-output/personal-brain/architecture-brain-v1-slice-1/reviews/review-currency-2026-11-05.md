# 최신성·실재 검증 리뷰 — 2026-11-05

판정: **수정 필요** — high 1건, medium 1건, low 1건. croner 채택의 버전·런타임 요건·DST 주장은 확인됐으며, 잔존 baseline 교체 지시와 플러그인 제거 설명을 바로잡아야 한다.

대상은 spine의 2026-11-05 update와 `garmin-extension-redesign-disposition.md`다. `git diff -- _bmad-output/personal-brain/architecture-brain-v1-slice-1/`, 연구 문서, 해당 폴더 `.memlog.md`의 마지막 2026-11-05 기록을 대조했다. 소스·spine·티켓·운영 DB는 변경하지 않았다. 기존 Stack과 AD-31의 잔존 문장도 요청한 최신성 검증 범위에 포함했다.

## 발견

### F1 — high: 이미 보존해야 하는 PG baseline을 여전히 교체하라고 지시한다

- **위치:** spine AD-31, 494행(기존 문장 잔존).
- **근거:** “지금의 … `0001_initial.sql`은 초기 설계라 대체한다(운영 PG 데이터 없음)”가 바로 앞 493행의 적용 이력 보존·forward-only 규칙과 충돌한다. 로컬 `packages/postgres/src/migrate.ts:17~19`는 적용된 baseline을 바꾸지 말라고 명시하고, 50~53행은 적용 이력의 파일 이름·checksum이 달라지면 `MIGRATION_FAILED`로 거부한다. 연구 문서 Q2의 migration 절도 old baseline의 운영 PG 부재 진술을 현재 상태 확인 없이 재사용하지 말라고 경고한다. 이번 update의 “Garmin 반입 0건”은 전체 PG 데이터나 migration 적용 이력 부재를 입증하지 않는다.
- **영향:** 이행 구현자가 현재형 교체 지시를 따르면 기존 설치본 업그레이드가 막힌다. 실제 운영 DB가 비어 있다고 이 리뷰에서 확인한 것은 아니다.
- **제안 수정:** 해당 문장을 과거 초기 전환 기록으로 바꾸고, 현재 규칙은 “배포된 PG 0001과 기존 이력은 보존하며 새 번호의 forward migration으로 변경한다”로 통일한다. 새 설치용 baseline 재편은 별도 업그레이드 호환 정책을 결정한 뒤 다룬다.

### F2 — medium: `/plugin uninstall`이 항상 플러그인을 삭제한다는 설명은 scope에 따라 틀린다

- **위치:** spine AD-38, 575행.
- **근거:** 현재 [Claude Code 공식 관리 문서](https://code.claude.com/docs/en/discover-plugins#uninstall-a-plugin-the-project-enables)는 프로젝트가 활성화한 플러그인의 `/plugin uninstall`에서 개인 비활성화와 전체 제거를 구분한다. 개인 선택은 local 설정에 비활성 override를 쓰며 프로젝트 설치를 남긴다. shell의 uninstall도 기본 user scope이며 다른 scope는 명시해야 한다. 따라서 “확장 플러그인만 지운다”는 현재형 설명은 실제 제거 여부와 대상 scope를 생략한다. 이 문서만으로 Brain의 외부 설치 디렉터리나 DB를 지우는 동작이 생긴다는 근거는 없으며, Brain 제거와 호스트 제거를 구분한 방향은 타당하다.
- **영향:** 사용자가 호스트에서 제거했다고 생각해도 다른 scope의 플러그인은 남을 수 있고, 설치·제거 인수 시험이 잘못된 단일 동작을 전제하게 된다.
- **제안 수정:** “호스트의 `/plugin uninstall`은 선택한 scope에서 플러그인을 제거하거나 개인 비활성화한다. Brain 확장 registry·예약·DB 데이터의 수명은 별개이며 `brain ext disable|uninstall`로 관리한다”로 바꾸고, user/project/local scope별 인수를 명시한다.

### F3 — low: Stack이 `uv.lock`에 없는 jsonschema까지 고정된 의존성으로 설명한다

- **위치:** spine Stack, 719행.
- **근거:** `extensions/garmin/pyproject.toml`의 직접 의존성은 curl-cffi·garminconnect·matplotlib·psycopg이고, 현재 `extensions/garmin/uv.lock`에 `jsonschema` 패키지 항목은 없다. requests는 전이 의존성으로 존재한다. `rg -n 'jsonschema' extensions/garmin`도 일치 항목이 없다. 따라서 이 행 전체를 “확장의 uv.lock이 고정한다”라고 설명하는 것은 현재 lock의 사실과 다르다.
- **영향:** 구현자가 이미 Python JSON Schema 검증기가 설치됐다고 오인할 수 있다.
- **제안 수정:** jsonschema를 현재 Stack 목록에서 빼거나 향후 도입 대상으로 명시한다. 실제 채택이 필요하면 구현 티켓에서 의존성·lock·검증 책임을 함께 추가한다.

## 확인된 사실과 경계

| 검증 항목 | 결과와 근거 |
| --- | --- |
| croner 11.0.0 실재·최신성 | npm 공식 레지스트리를 읽기 전용 조회했다. `dist-tags.latest=11.0.0`, 버전 공개 시각 `2026-10-26T17:28:51.533Z`, registry 수정 시각 `2026-11-04T18:33:26.912Z`다. 수정 시각과 버전 공개일은 다르다. [레지스트리](https://registry.npmjs.org/croner) |
| Node 하한·의존성 | 11.0.0의 `engines.node`는 `>=18.0`, 런타임 `dependencies` 항목은 없다. 개발 의존성은 있으므로 “런타임 외부 의존성 없음”이 가장 정확하다. 프로젝트 Node 하한 `>=24.16.0`과 양립한다. [공식 태그 package.json](https://raw.githubusercontent.com/Hexagon/croner/11.0.0/package.json) |
| AD-39의 DST 처리 | 11.0.0 배포 CJS를 메모리에서 읽어 `Cron(...,{timezone,paused:true,mode:'5-part'}).nextRuns()`만 호출했다. Stockholm `30 2 * * *`에서 2026-03-29의 없는 02:30은 `01:00Z`(현지 전환 시각 03:00), 2026-10-25의 겹친 02:30은 `00:30Z`(첫 instant)였다. 첫 instant 이후부터 조회하면 다음 날로 넘어갔다. New York의 없는 02:30도 전환 시각 `07:00Z`를 반환했다. 타이머 작업·DB·프로젝트 시험은 실행하지 않았다. 이는 대표 사례 확인이며 모든 IANA 전환의 전수 증명은 아니다. [배포 코드](https://unpkg.com/croner@11.0.0/dist/croner.cjs) |
| 5필드·IANA 시간대 | 공식 API는 `mode:'5-part'`와 `timezone`을 제공한다. 기본 mode는 auto이므로 구현 때 5필드를 명시적으로 제한해야 AD-39와 맞는다. adapter의 향후 구현 조건이며 현재 구현 결함으로 세지 않았다. [공식 설정 문서](https://croner.56k.guru/usage/configuration/) |
| 같은 레포의 여러 플러그인 | 공식 문서는 marketplace의 `plugins` 배열과 각 항목의 상대 `source`를 지원한다. 로컬 marketplace의 기존 `second-brain → ./plugin`도 일치한다. `second-brain-garmin`은 미래 설계이며 아직 로컬 항목이 없다. 구조 가능성은 확인했지만 실제 두 플러그인의 설치·discovery는 시험하지 않았다. [공식 marketplace 문서](https://code.claude.com/docs/en/plugin-marketplaces) |
| 옛 Garmin 기준·규모 | `~/github/garmin` HEAD는 `7fb33dd1661ad25cd73e14ed63abe0a87151f62e`다. `src/**/*.py` 23개·11,071행, `store/migrations/*.sql` 16개·325행으로 문서의 규모와 맞는다. Python 3.14 AST로 `.execute/.executemany/.executescript` 호출을 세면 10개 파일·100곳이다. “약 106곳”은 대략적인 규모로는 가깝지만 정확한 작업량 근거로 쓸 때는 집계 방법과 100곳을 함께 적는 편이 재현 가능하다. |
| SQLite 이식 범위 | 실제로 `INSERT OR IGNORE`, `?`, PRAGMA table_info/user_version이 존재한다. 그 밖에도 store의 WAL·foreign_keys PRAGMA, URI mode, autocommit, row_factory, sqlite3 예외 처리가 있어 SQL 문구만 치환하는 작업은 아니다. 연구 문서 Q3는 이를 이미 구체적으로 열거한다. 처분 문서의 축약 설명은 그 절을 연결하면 더 정확해진다. |
| 기존 Stack의 주요 기반 | Node 24.22.1 보안판·PostgreSQL 18.6·PG19 예정일·Python 3.14.10은 공식 자료와 일치한다. [Node 보안판](https://nodejs.org/en/blog/release/v24.22.1), [PG 지원표](https://www.postgresql.org/support/versioning/), [PG19 일정](https://wiki.postgresql.org/wiki/PostgreSQL_19_Open_Items), [Python 릴리스](https://www.python.org/downloads/release/python-31410/) |
| npm 기존 Stack의 선택판·최신판 | registry latest는 TypeScript 7.0.2, pnpm 12.16.1, pg 8.23.1, commander 15.0.0, smol-toml 1.9.1, uuid 14.0.3이다. Kysely latest는 0.29.8(11월 1일 공개), Vitest latest는 5.1.0이다. 문서는 pnpm 관찰일·uuid 설치판/최신판·Vitest 선택판을 구분하므로 최신판 미채택 자체를 결함으로 세지 않았다. 로컬 Kysely는 문서대로 0.29.6이며, Vitest는 package.json상 5.0.3, smol-toml은 CLI에서 1.9.0이다. Stack 표를 현재 설치판 목록으로 쓸 경우 이 차이를 표시해야 한다. |

## 직접 확인하지 못한 항목

- 운영 DB의 실제 Garmin 행 0건·합성 데이터만 존재한다는 주장은 운영 조회로 재검증하지 않았다. 로컬 16.9 plan의 `blocked_reason`에는 “운영 DB 반입 기록 0건”이 있고 사용자 결정·메모로그가 같은 전제를 기록한다. 이를 전체 PG 무데이터나 migration 미적용으로 확대 해석해서는 안 된다.
- Model Studio 모델 ID의 현재 제공 상태, OrbStack 설치 상태, Docker 이미지 내부 contrib 구성, 모든 문서 추출 패키지의 최신 버전은 이번 검증에서 직접 확인하지 않았다. 확인하지 않은 항목을 최신성 통과로 판정하지 않는다.
- `commands[]`, 새 패키지 공급원 installer, cron adapter, user_id 이행은 채택된 목표 설계다. 현재 코드에 없다는 사실만으로 미구현 설계를 오류로 판정하지 않았다.

네트워크는 기본 shell의 DNS 제약이 있었으나 승인된 읽기 전용 registry 조회와 웹 도구로 위 공식 자료에 접근했다. 소스 수정과 프로젝트 시험은 수행하지 않았으며, 이 리뷰 파일만 작성했다.
