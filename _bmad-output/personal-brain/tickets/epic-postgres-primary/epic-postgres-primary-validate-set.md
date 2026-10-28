판정: 수정 후 재검증 — fix 3 / suggest 3 / ask 0

검토일: 2026-10-28. 범위: epic 11의 미커밋 에픽·13개 entry와 Ticket / Set / Dependencies 검사. 구현 검증이 아닌 정적 검토다. Docker·네트워크·설치·테스트 suite는 실행하지 않았다. 이 보고서 외 파일은 변경하지 않았다.

## fix

### F1 — 트레이서 baseline의 FK 선행 테이블을 2로 미뤘다

- 근거: `_bmad-output/personal-brain/tickets/epic-postgres-primary/tickets/tickets.toml:8`은 1의 baseline에 `projects`·`sessions`를 포함하지만 `workspaces`는 포함하지 않는다. 같은 파일 `:20`은 `workspaces`를 2가 만드는 나머지 표로 지정한다. `packages/postgres/migrations/0001_initial.sql:23`, `:45`와 `packages/sqlite/migrations/0001_initial.sql:51`, `:76`에서 두 표는 `workspaces`를 참조한다. 아키텍처의 관계도도 같다: `_bmad-output/personal-brain/architecture-brain-v1-slice-1/architecture-brain-v1-slice-1.md:585`.
- 문제: workspace 값을 아직 쓰지 않아도 FK 대상 표는 DDL 적용 시 존재해야 한다. 현재 분담대로라면 1의 빈 DB에 baseline을 적용할 수 없다. FK를 2까지 생략하면 기존 키를 지키는 baseline이라는 설명과 다른 임시 계약이 된다.
- 변경: `workspaces`의 최소 DDL을 1의 목록으로 옮기고 2의 “나머지 표” 목록에서 뺀다. 1의 verify는 workspace 값이 null인 정상 세션을 포함해 FK를 갖춘 baseline 적용을 확인하게 한다. workspace 기능 자체를 앞당길 필요는 없다.

### F2 — SQLite 삭제의 검색 범위가 보존할 문서까지 포함한다

- 근거: `_bmad-output/personal-brain/tickets/epic-postgres-primary/tickets/tickets.toml:129`는 저장소에서 `node:sqlite`·`@second-brain/sqlite`·`pgvector`를 찾으면 결과가 없어야 한다고 한다. 같은 파일 `:128`의 실제 삭제 범위는 adapter·런타임·테스트·배포 의존성과 현재 README 설명이다. 보존할 에픽 자체가 이 문자열들을 포함한다: `_bmad-output/personal-brain/tickets/epic-postgres-primary/epic-postgres-primary.md:17`, `:42`. 연구 문서의 부록 A도 의도적으로 과거 의존 지점을 기록한다.
- 문제: 문구 그대로의 저장소 전체 검색은 구현이 올바르게 끝나도 실패한다. 비작성자가 실행하면 계획·리뷰·조사 기록을 지워야 한다고 오해할 수 있다.
- 변경: verify를 실행 소스·테스트·패키지/lockfile·Compose·현재 사용자 안내로 한정한 검색 명령으로 바꾼다. 역사적 계획·조사·리뷰 기록은 검사 대상에서 명시적으로 제외하고, import/export/dependency와 이미지·확장 설치 의존이 없음을 판정한다. README의 “pgvector를 요구하지 않는다” 같은 부재 설명까지 제거해야 하는 문자열 검사 대신 실제 의존을 검사한다.

### F3 — 이미 알려진 OrbStack 판별 불확실성이 unknown에 없다

- 근거: `_bmad-output/personal-brain/tickets/epic-postgres-primary/tickets/tickets.toml:92`는 판별 방법을 “착수 때 이 Mac에서 실측”한다고 하지만 8의 entry에는 `unknown`이 없다. `_bmad-output/personal-brain/tickets/epic-postgres-primary/epic-postgres-primary-research-code.md:154`는 Docker Desktop·다른 context와의 구분 방법을 아직 검증하지 않았다고 명시한다. 규칙은 `_bmad/render/bmad-agent-po/second-brain-bbe56f7ddda0/dcffd73a7f031ef42569/references/validate-checks.md:9`과 같은 디렉터리의 `ticket.md` “Rules the template cannot carry”에 있다.
- 문제: 알려진 unknown이 설명에만 묻혀 있어 board의 착수 게이트로 드러나지 않는다. OrbStack을 선행 조건으로 삼는 사용자 결정은 이미 확정됐지만, 그 조건을 무엇으로 증명할지는 별개다.
- 변경: 8에 `unknown`으로 “OrbStack 설치·실행·선택 Docker context 판별 probe와 이 Mac에서의 확인 결과”를 기록한다. 정제 시 이를 먼저 해결하거나, 필요하면 답을 남길 스파이크를 선언하고 8이 기다리게 한다. OrbStack 설치 여부 자체를 다시 사용자에게 결정받자는 뜻은 아니다.

## suggest

### S1 — 실제 hook 관통은 유지하되 1의 비필수 Store 완성을 별도 story로 빼는 편이 안전하다

- 근거: `_bmad-output/personal-brain/tickets/epic-postgres-primary/tickets/tickets.toml:8`은 제품 자원·Compose·role·schema·새 실행기·수집 baseline·Store·계약·CLI capability 조립·테스트 DB 교체를 한 번에 묶는다. 조사 문서 `epic-postgres-primary-research-code.md:162`, `:174`는 기존 세션 구현만 866줄이며 T1이 가장 넓은 변경이라고 기록한다. 실제 Core·CLI의 전역 교집합은 `packages/core/src/brain.ts:67`, `apps/cli/src/assembly.ts:51`, `apps/cli/src/dispatch.ts:345`에 남아 있다. 수집 의존성도 `packages/core/src/sessions/ingest.ts:133`에서 여전히 전체 `SessionStore`를 요구한다. 계약 subject는 `packages/core/src/testing/contracts/session-store.ts:37`의 WorkStore 읽기 능력까지 필요하다.
- 이유: 좁힌 타입을 쓰겠다는 방향은 옳지만, CLI 타입 하나만 바꾸는 작업이 아니다. “가리기 제외 SessionStore 전부와 suite 전체”를 첫 관통에 묶으면 수집의 최소 구현과 capability 분리, 약 30개 세션 계약 case 완성이 동시에 필요하다. 한 agent session에 맞는 크기라는 근거가 약하다.
- 제안: 1은 실제 `setup run → sessions ingest → 재생성 뒤 readback`과 그 경로에 필요한 구체 능력·안전 규칙을 유지한다. 그 경로에서 쓰지 않는 세션 목록·정체성 후보·통계 능력과 나머지 세션 계약의 완성은 이름 있는 후속 story로 분리한다. 명령별 조립과 Core 수집 의존성의 capability 축소는 1이 소유한다고 명시한다. 전체 Store cast나 미구현 placeholder를 허용하지 말고, 새 story가 끝내는 verb·계약 case를 양쪽 entry와 epic Notes에서 구분한다. 13개라는 개수나 같은 에픽을 유지한다는 결정 자체는 재논의하지 않는다.

### S2 — 9의 PG 데몬 실행에 필요한 조립을 10보다 먼저 누구에게서 받는지 명시한다

- 근거: `_bmad-output/personal-brain/tickets/epic-postgres-primary/tickets/tickets.toml:104`·`:105`의 9는 멈춘 PG와 실행 데몬으로 복구·schema 확인·spool drain을 검증한다. 그러나 `:116`은 daemon Store와 기대 버전 전환을 10에 둔다. 10은 `:119`에서 9를 기다린다. 1의 opt-in PG 조립은 `:8`에서 수집 명령으로 한정된다. 현재 `apps/cli/src/daemon/run.ts:174`, `:264`, `:268`은 SQLite factory·파일 옵션·SQLite 기대 버전을 사용하고 `apps/cli/src/assembly.ts:79`도 SQLite 버전이다.
- 이유: 전체 기본값 전환을 10에 두는 결정과 별개로, 9의 검증 시점에는 PG 데몬을 구성할 수 있어야 한다. 가짜 compose runner만 주입해서는 이 선행 조건이 해결되지 않는다. 지금은 builder가 10의 일부를 당겨 오거나 SQLite 데몬으로 복구 시험을 통과시키는 해석이 가능하다. 후자는 E11-9 증거가 아니다.
- 제안: 7이 PG opt-in daemon factory·소유자별 버전 조립과 재사용 가능한 PG fixture를 제공하고 9가 소비한다고 양쪽 설명에 적는다. 또는 9가 이 opt-in 연결을 직접 소유하되 8과 공유할 조립 파일을 7에서 먼저 완성한다고 정한다. 10은 PG를 모든 경로의 기본값으로 만들고 SQLite 선택을 없애는 마감으로 구분한다. 9의 verify에는 PG Store를 사용한 데몬이라는 관찰 근거를 넣는다. 9가 10을 기다리게 하는 순환 의존성은 추가하지 않는다.

### S3 — 계약 밖 검증과 가짜 runner 검증에 재실행할 진입점을 지정한다

- 근거: `_bmad-output/personal-brain/tickets/epic-postgres-primary/epic-postgres-primary.md:37`은 같은 세션 동시 수집의 adapter 전용 시험을 요구한다. entry 3·4·5의 verify(`tickets/tickets.toml:33`, `:45`, `:57`)는 청구·추출·가리기 경쟁을 적지만 이 동시 수집 시험의 소유자는 명시하지 않는다. 8·9의 verify(`:93`, `:105`)는 “가짜 runner로 …”라고만 해 비작성자가 실행할 CLI나 harness를 알 수 없다. 조사 문서 `epic-postgres-primary-research-code.md:176`은 연결 종료 직후 commit 결과 불명도 별도 실패 시나리오라고 경고한다.
- 이유: entry 단계라 완성된 acceptance criteria는 필요 없지만, “suite가 통과한다”만으로는 계약 밖 동시성·장애 시험의 범위와 비작성자 실행 방법을 재현하기 어렵다. 같은 세션 동시 수집은 공통 계약 전체 통과로 자동 증명되지 않는다.
- 제안: 같은 세션 동시 수집·세션 advisory lock 시험은 1 또는 명명한 후속 세션 story에, 연결 종료와 멱등 재시도 시험은 7에 할당한다. 각 entry의 verify에 제공할 통합 시험 명령/selector와 성공 관찰값을 적고, 8·9는 runner 주입을 직접 요구하지 않는 실행 가능한 테스트 harness를 산출물로 지정한다. 실제 명령·파일명은 story 정제 때 확정해도 된다. 이 검토에서 시험을 실행하자는 제안은 아니다.

## ask

없음. 저장 형식·역할 경계·자원 격리·시간대·기존 DB 미이전·SQLite 기본값 유지 시점은 기록된 결정으로 충분하다. 위 항목은 분담과 검증의 구체화로 처리할 수 있다.

## confirmed

- 두 기준 파일은 전체를 읽었다. 13개 모두 draft entry이며 leaf 파일은 없다. 이 단계에 full criteria가 없는 사실 자체는 위반이 아니다. 모든 entry에 description·verify·risk가 있고 unfilled placeholder는 없다. companion·entry가 인용하는 연구 절과 관련 상위 문서를 열어 대조했다.
- `uv run ~/.agents/skills/bmad-agent-po/scripts/tickets.py --project-root "$PWD" status _bmad-output/personal-brain`과 `status _bmad-output/personal-brain/tickets/epic-postgres-primary`가 성공했다. 후자는 13 planned, next_id 14이며 `unpinned_after=[]`, `undeclared_after=[]`, `order_conflict=[]`다. 두 출력에 cycle/drift 오류는 없었다. `status <initiative> epic-postgres-primary` 형식은 지원하지 않아 폴더 형식으로 확인했다. 첫 sandbox 실행은 uv 캐시 권한 때문에 실패했고 권한을 부여한 재실행만 사용했다.
- 요구사항의 책임 분담은 아래와 같다. F1의 첫 실행 문제와 S2의 중간 검증 경계를 고치면 최종 누락 없이 이어진다.

| 요구사항 | 담당 entry와 분담 |
| --- | --- |
| E11-1 | 1 제품 자원·영속 Compose·테스트 Compose, 8 충돌·설치 수명 완성, 13 설치본 영속성 |
| E11-2 | 1 역할·실행기·ledger, 7 런타임 오류/기대 버전 |
| E11-3 | 1 수집 baseline, 2 나머지 표·규칙·GIN, 4 locator/이름의 실제 쓰기 |
| E11-4 | 1 세션·사용자·transcript/수집 능력, 3 work/schedules, 4 첨부/추출, 5 redact, 10 전체 suite 통합 |
| E11-5 | 3 잠금 초과, 7 연결·schema 오류/spool, 13 설치본 장애 복구 |
| E11-6 | 5 가리기·정리·권한·doctor pending |
| E11-7 | 6 port·DB·코덱·SDK/CLI·setup/doctor, 13 설치본 영속성 |
| E11-8 | 1 최소 설치, 8 전체 setup/bootstrap·doctor·제거, 13 설치본 확인 |
| E11-9 | 9 backoff·재접속·drain, 13 설치본 확인 |
| E11-10 | 10 전환/fixture, 11 삭제 |

- Done when 1–6은 각각 1/8/10/13, 1/4/6/13, 2–5/10/11, 7–9/13, 6/13, 13으로 도달한다. 배포처럼 Requirements ID 없는 통합 작업도 13이 소유한다. 새 GUI는 없으며 기존 CLI·대화형 설치 흐름을 확장한다.
- tracer의 날짜 있는 Decision은 `epic-postgres-primary.md:95`, `:96`에 있고 1의 사람 단계와 실행 결과가 명시돼 있다. “다음은 가장 덜 확실한 동시성·가리기”에 앞선 baseline 2는 실제 스키마 선행 조건이다. 1의 부분 baseline은 2, OrbStack 안내 완성은 8, SQLite 기본값 종료는 10으로 각각 이름 있는 story에 연결돼 있다. checksum 고정 전 개발 DB 재생성도 `:97`에 명시돼 있으므로 이를 은밀한 migration 변경으로 재지적하지 않는다.
- Refactor sweep 12는 1–11 모두를 기다리고 cleanup만 허용한다. 13의 배포·사람 확인을 마지막으로 두는 예외는 `epic-postgres-primary.md:98`에 기록돼 있다. 이미 결정한 순서를 다시 문제 삼지 않았다.
- cross-epic `9.2`는 설치/launchd, `9.10`은 제거, `9.1`은 데몬 루프의 실제 선행 산출물이다. `10.1–10.4`, `10.6`은 최종 수집·첨부·계약·trigger의 입력이며, 이들의 선행 경로를 통해 나머지 필수 기반도 이어진다. 전체 epic gate도 daemon·attachments를 유지한다. 검토한 범위에서 새 cross-epic 누락은 찾지 못했다.
- 6→5는 PG Store 조립과 CLI assembly/doctor, 7→6은 PG factory·전 verb 오류 처리·CLI 조립을 공유하므로 collision edge로 정당하다(`epic-postgres-primary.md:97`, 연구 §7, 실제 `apps/cli/src/assembly.ts:64`). 서로 다른 기능이라는 이유만으로 제거할 간선이 아니다.
- 8의 본체는 install/doctor/setup-uninstall, 9의 본체는 daemon/run이고 공용 비동기 runner는 1이 제공한다. 설치·doctor와 daemon을 반드시 직렬화하라는 연구 §7 T6의 큰 후보는 이번 세분화로 나눌 수 있다. 다만 runner 외 PG factory·기대 버전 조립의 선행 소유권은 S2대로 닫아야 “8·9가 병렬로 시작 가능”하다는 결론을 확정할 수 있다. 단순히 둘 다 CLI라는 이유로 새 간선을 권하지 않는다.
- text locator 정규형, role 분리, pg_trgm expression GIN 5개, DB 값 생성 금지, redaction rollback/spool 금지·GUC 정리·제한된 maintenance·doctor warn, 자원 이름 격리, plugin app-ref의 앞선 commit/version 동시 변경은 entry에 반영돼 있다. Drive·임베딩·확장 role 구현을 선행 조건으로 끌어오지 않았다. 옛 연구의 locator 질문과 spine의 과거 Deferred 표기는 더 최근의 `epic-postgres-primary.md:94` 결정으로 해석했으며 재질문하지 않았다.
