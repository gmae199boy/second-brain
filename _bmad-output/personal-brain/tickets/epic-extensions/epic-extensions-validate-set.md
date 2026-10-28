판정: 수정 후 재검증 — fix 5 / suggest 2 / ask 0

검토일: 2026-10-28. 대상은 epic 13의 미커밋 에픽과 10개 draft entry다. 메인 checkout의 `~/github/second-brain/_bmad/render/bmad-agent-po/second-brain-bbe56f7ddda0/dcffd73a7f031ef42569/references/validate-checks.md`의 Ticket·Set·Dependencies와 같은 폴더 `ticket.md`의 “Rules the template cannot carry”를 읽어 적용했다. 이 보고서만 작성했으며 테스트·빌드·Docker·네트워크·설치·커밋은 하지 않았다. 아래는 구현 결함 판정이 아니라 계획의 분담·실행 가능성 검토다.

근거 약칭은 다음 실제 저장소 상대 경로를 뜻한다. `약칭:행`의 행 번호는 검토 시점 파일 기준이다.

| 약칭 | 파일 |
| --- | --- |
| 에픽 | `_bmad-output/personal-brain/tickets/epic-extensions/epic-extensions.md` |
| 세트 | `_bmad-output/personal-brain/tickets/epic-extensions/tickets/tickets.toml` |
| 조사 | `_bmad-output/personal-brain/tickets/epic-extensions/epic-extensions-research-code.md` |
| 이니셔티브 | `_bmad-output/personal-brain/initiative-personal-brain.md` |
| spine | `_bmad-output/personal-brain/architecture-brain-v1-slice-1/architecture-brain-v1-slice-1.md` |
| PG계획 | `_bmad-output/personal-brain/tickets/epic-postgres-primary/tickets/tickets.toml` |
| 작업계획 | `_bmad-output/personal-brain/tickets/epic-jobs-and-scheduler/tickets/tickets.toml` |
| 작업에픽 | `_bmad-output/personal-brain/tickets/epic-jobs-and-scheduler/epic-jobs-and-scheduler.md` |

## fix

### F1 — 설치본 확인(10)에 시험 전용 testext를 넣을 경로가 없다

- 근거: `에픽:84`는 fixture를 시험 안의 패키지 경로 주입으로만 설치하고 사용자용 `--from`을 두지 않기로 정했다. `세트:8`도 같은 제한이다. 그런데 `세트:115`는 새 `claude -p` 세션이 설치본에서 testext 설치·시험 로그인·예약을 끝내도록 하고, `세트:116`은 그 목록을 실제로 돌린 기록을 요구한다. 시험용 로그인 상태 변경도 `세트:56`에서 harness만 소유한다.
- 문제: 일반 설치본에는 testext 패키지와 시험용 로그인 제어가 제공된다는 계약이 없다. 시험 프로세스의 내부 주입을 새 CLI·에이전트 프로세스가 그대로 받는다고 볼 수도 없다. 따라서 10의 비작성자는 정해진 정책을 지키면서 정상 경로를 재현할 수 없다. `process_probe`가 출하된다는 결정은 testext 패키지의 출하·주입을 대신하지 않는다.
- 변경: 10이 사용할 설치본 검증 harness를 산출물로 명시한다. 격리된 Brain 홈·DB·Label에 설치본과 동일한 앱/스킬을 쓰되, 시험 전용 패키지 resolver와 가짜 로그인 제어를 새 CLI·데몬·에이전트 세션에 연결하는 방법을 plan에 적게 한다. 1 또는 5가 제공하고 10이 받는다고 양쪽 설명에 쓴다. 새 사용자용 설치 옵션이나 testext의 일반 출하는 추가하지 않는다. 로컬 스킬 발견·실제 설치본 버전 증거와 harness 증거도 구분해 남긴다.

### F2 — 8의 갱신 검증이 기본 suite에 Python을 요구할 수 있다

- 근거: `에픽:50`은 기본 시험 suite가 Python을 요구하지 않고 Python fixture 시험을 별도 진입점으로 두도록 한다. `세트:32`·`:33`도 이를 3의 결과로 약속한다. 그러나 `세트:93`은 8의 일반 “시험”에서 testext와 pyfixture를 설치한 홈의 갱신을 함께 요구하고 별도 진입점 구분이 없다. 현재 `vitest.config.ts:27`은 각 workspace의 `test/**/*.test.ts`를 자동 수집한다.
- 문제: 설명대로 8의 검증을 일반 통합 시험으로 추가하면 pyfixture 설치가 기본 `pnpm test`에 들어갈 수 있다. Python이 없을 때 건너뛰는 것만으로 처리하면 Python 설치·갱신 보존 증거도 불명확해진다.
- 변경: 8의 verify를 두 진입점으로 나눈다. 기본 suite는 Node testext의 갱신 보존과 Python·uv 탐색/실행 0건을 검증한다. pyfixture의 frozen 환경 설치와 갱신 보존은 3이 만든 선택 Python 진입점을 확장해 검증한다. 기본 suite에서 Python을 설치하거나 발견에 따라 묵시적으로 실행하지 않으며, 두 명령과 사전 조건을 plan에 남긴다고 적는다.

### F3 — 공개 상태 view의 생산 담당과 E13-6 분담을 고정해야 한다

- 근거: `에픽:39`는 registry의 공개 상태 view를 doctor·스킬·epic 17이 읽게 한다. `세트:8`의 1은 registry 표·Store를 만들고, `세트:56`의 5는 단계 사실을 완성한다. E13-6 covers는 이 둘에만 있다(`세트:10`, `:58`). 공개 상태 view가 직접 등장하는 6은 “꺼진 상태가 보인다”라고만 하고(`세트:68`), covers에는 E13-1·E13-8만 있다(`세트:70`). 소비 측 `_bmad-output/personal-brain/tickets/epic-search-and-health-query/epic-search-and-health-query.md:57`은 바로 이 view를 받는다.
- 문제: 표·CLI 조회 구현과 다른 소비자가 쓸 공개 projection을 같은 것으로 추정해야 한다. view의 생성·공개 계약·비밀 배제·미설치 표현을 어느 entry가 완성해 epic 17에 주는지가 불명확하다. 공유 id의 부분 책임도 현재 covers와 설명이 어긋난다.
- 변경: 예를 들어 6을 공개 상태 view의 최종 생산자로 명시하고 E13-6 covers를 더한다. 1은 설치·활성·연결 사실의 기반, 5는 로그인·예약·실패 사실, 6은 비밀 없는 공통 조회 계약과 doctor/status 연결이라고 분담한다. 6의 설명에는 epic 17 검색에 넘기는 계약을, verify에는 동일 조회 계약으로 미설치·설치/로그인 미완료·활성·비활성과 중단 수를 읽고 비밀 값이 없음을 넣는다. 구체 SQL view명 또는 SDK projection 모양은 정제 때 정하되 외부 소비자가 CLI 출력을 역해석하지 않게 한다.

### F4 — epic 11에서 받는 인계의 양쪽 설명 조건에 예외가 필요하다

- 근거: `세트:8`은 11.10의 실행기·PG 조립을, `세트:20`은 11.6의 설정 코덱을 받는다고 한다. `PG계획:80`·`:128`에는 13에 주는 설명이 없다. `작업에픽:102`의 기존 Decision은 선행 epic 11을 고치지 않고 **12.1·12.8**에서 인계를 받는 명시적 예외다. `에픽:89`·`:90`에는 13에 대해 이 서술 조건을 면제하는 문장이 없다.
- 문제: 보드의 유효한 교차 after와 실제 산출물은 확인되지만, Dependencies의 “both descriptions say so”는 충족되지 않는다. 기존 예외의 대상으로 13까지 자동 포함할 수는 없다.
- 변경: 진행 중인 epic 11을 다시 고치지 않는 기존 결정은 유지한다. epic 13 Notes에도 11.10·11.6 인계에 양쪽 설명 조건의 예외를 적용하며, 받는 13.1·13.2가 산출물과 완료 HEAD의 경로·시그니처 확인을 책임진다는 날짜 있는 Decision을 적는다. 새로운 제품 결정이나 사용자 재승인을 요구하는 항목은 아니다.

### F5 — risk 값의 사업 영향 이유가 빠져 있다

- 근거: `세트:13`·`:25`·`:37`·`:49`·`:61`·`:73`·`:85`·`:97`·`:109`·`:120`에는 risk 값만 있고 제안 이유가 없다. 기준 `ticket.md`의 “Rules the template cannot carry”는 모든 ticket의 risk에 잘못됐을 때의 business impact를 한 줄 이유로 요구한다. 추천 결정 위임은 `이니셔티브:188`에 있다.
- 문제: 값은 존재하지만 잘못된 확장 설치·권한·상태 보고가 사용자에게 미치는 영향과 등급의 관계가 기록되지 않았다. 에이전트가 추천으로 정할 수 있다는 위임은 이유 기록을 생략하는 결정이 아니다.
- 변경: 각 entry에 등급 제안 이유 한 문장을 넣거나, 에픽 Notes에 id별 risk·이유 표를 두고 entry가 참조하게 한다. 예를 들어 4의 high는 타 출처 데이터 쓰기 허용 위험, 6의 medium은 비활성화 뒤 실행 지속 위험, 9의 low는 기능 변경 없는 정리라는 이유다. 등급 자체를 이번 검토에서 바꾸거나 다시 사용자에게 묻지는 않는다. high-risk leaf를 정제할 때는 기준대로 criteria 외 추가 check도 Notes에 명시한다.

## suggest

### S1 — tracer의 세션 크기를 plan에서 제한할 문장을 둔다

- 근거: `세트:8`은 최소 manifest·패키지 배치·확장 DDL 연결·registry DDL/port/fake/계약·세 CLI/SDK·감독자 연결을 포함한다. `조사:138`의 공유 파일 표와 `조사:148`은 이 경계들의 분량 위험을 설명한다. 현재 `apps/cli/src/assembly.ts:79`는 여전히 SQLite 버전을 조립하므로, 11·12 완료 기반의 실제 재사용 비용은 이 checkout에서 실증할 수 없다. 같은 위험에 대한 선례는 `작업에픽:104`다.
- 이유: 정상 Node 경로로 좁힌 방향은 타당하다. 다만 “최소”라고 쓴 것만으로 Store 계약과 CLI 조립까지 한 agent session에 맞는다고 확정할 수는 없다.
- 제안: 1의 plan을 단일 testext·연결 확인 한 명령·DDL 0001 한 개·정상 ABI 결과 한 건으로 제한한다. 11·12 완료 HEAD에서 분량을 판정하고, 넘치면 비필수 목록/메타 완성 등을 이름 붙인 다음 story로 옮기되 설치 → DDL → registry → 실제 자식 → status의 관통은 1에 남긴다는 문장을 Notes에 둔다. 이미 정한 tracer·Node/Python 분리·1~8 직렬 순서는 유지한다.

### S2 — 각 verify의 공통 재실행 계약을 에픽 Notes에 둔다

- 근거: `세트:9`·`:21`·`:33`·`:45`·`:57`·`:69`·`:81`·`:93`은 시험 명령을 plan에 남기겠다고 한다. 그러나 PG 사전 조건·공유 fixture setup 소유자·fake와 실제 Node의 구분을 공통 의무로 모은 문장은 없다. `세트:80`의 스킬 행동 harness는 새 산출물이고 `조사:134`는 스크립트가 CLI를 순서대로 부르는 시험과 실제 스킬 행동 평가를 구분한다. 선행의 명시적 실행 계약은 `작업에픽:104`다.
- 이유: draft entry에는 완성된 acceptance criteria나 아직 없는 시험 파일명이 필요하지 않다. 현재의 “명령은 plan” 약속은 수용할 수 있지만, builder마다 서로 다른 PG·에이전트 환경을 전제하면 비작성자가 실행할 수 없는 증거가 남을 수 있다.
- 제안: 1이 격리 PG·Node testext 설치 fixture와 정리 도구를 소유하고 뒤 entry가 재사용하게 한다. 각 plan에 실행 명령/selector·사전 조건·관찰값·정리를 남기고, 기본 Node/PG suite·선택 Python suite·선택 스킬 행동 평가를 구분한다고 Notes에 적는다. 7의 행동 진입점은 실제 SKILL.md를 입력으로 받아 case별 CLI transcript와 최종 보고를 판정하며, 10의 실제 에이전트 실행 기록과 구별한다. connection_failed와 공개 상태 비밀 배제도 명명된 case로 두는 편이 좋다.

## ask

없음. 2026-10-28 추천안 위임으로 정할 수 없는 사용자 고유 선택은 찾지 못했다. fixture 분리·비활성화 정책·트랜잭션/재조정 대안·설치 출처 제한·로컬 배포와 원격 push의 구분은 기존 Decision을 그대로 적용했다.

## 확인 결과

### Ticket·Set

- 10개 모두 leaf 파일 없는 draft entry다. description·verify·risk가 있고 refine 지시나 미해결 Source conflict는 없다. 이 단계의 full criteria 부재 자체는 지적하지 않는다. 에픽의 sources·companions 및 세트 references가 가리킨 조사 절·후보를 열어 대조했다. 외부 UI를 새로 만드는 계획은 아니다.
- covers id는 모두 E13-1~10에 존재하고 모든 Requirements 줄에 담당이 있다. 단순 id 열거를 넘어 설명으로 나눈 결과는 아래와 같다. F3은 E13-6의 공개 계약 책임을 명료하게 만드는 조치다.

| 요구사항 | 담당과 분담 |
| --- | --- |
| E13-1 | 1 install/list/status·메타·SDK, 6 enable/disable |
| E13-2 | 2 manifest 전체·TS fixture·배포·호환성, 3 Python 동일 fixture 판정 |
| E13-3 | 2 선언 키 등록·불변 snapshot·비밀 전달 |
| E13-4 | 1 패키지 위치·owner별 DDL 연결, 3 frozen Python/patch 확인 |
| E13-5 | 4 role·schema·출처 결합·권한·현재/옛 token 시험 |
| E13-6 | 1 registry 기반, 5 단계별 사실과 실패; 공개 상태 view 책임은 F3 |
| E13-7 | 5 단계 보고·취소·로그인 필요·예약 미준비·재개·중복 방지 |
| E13-8 | 6 보류 그룹 연결·취소·재개·데이터 보존·doctor |
| E13-9 | 7 배포되는 스킬·정적/행동 시험, 10 설치본의 실제 스킬 발견/실행 |
| E13-10 | 8 Python 불요구·갱신 보존, 10 설치본 확인 |

- Done when 1은 8/10, 2는 5/7/10, 3은 5/7, 4는 6, 5는 8/10으로 이어진다. F1·F2가 특히 2·5의 실행 가능한 증거를 막고 있으므로 현재 통과 판정은 하지 않는다. 기능이 옳다고 인증한 것도 아니다.
- Constraints C4와 프로세스 경계는 1/2/3, core/확장 번호 분리는 1, 권한·비밀은 2/4, fixture 기본 원칙은 1/3/5/7이 맡는다. 실제 Garmin·실계정·모델을 fixture 시험에 끌어오지 않는다. Python 없는 기본 suite는 F2를 고쳐야 명료해진다.
- `에픽:89`에 tracer와 다음 불확실성(2·3), `에픽:90`에 직렬 순서와 sweep/설치본 확인의 날짜 있는 Decision이 있다. tracer는 실제 Python·로그인·스킬을 후속에 남긴 정상 경로이며 보이는 결과가 connected다. 사람이 실행할 starter를 요구하지 않으므로 hitl 단계를 새로 만들 이유가 없다.
- 9는 1~8 모두를 기다리는 cleanup 전용 Refactor sweep이다(`세트:104`, `:107`). 10을 마지막 검증·배포로 두는 순서는 `에픽:90`에서 정했다. 10의 `hitl=false`는 `이니셔티브:188`·`:189`의 더 최근 “사람 개입 없이 끝까지” 위임에 정확히 맞는다. 이전 `이니셔티브:187`의 사람 확인 문장만 근거로 hitl을 되돌리지 않는다. 원격 push 필수 단계는 operator_actions에 남긴다는 10의 설명도 위임과 맞다.

### Dependencies·handoffs

| 간선 | 실제 받는 산출물과 판정 |
| --- | --- |
| 1 ← 12.11 | 공유 감독자·registry 조립 접점·CLI·마이그레이션의 마지막 코드 정리 경계. `에픽:90`의 collision 이유가 있어 단순 표 순서 반복이 아니다. 12.1 감독자/probe·12.4 ABI·12.9 예약·12.10 그룹도 이 경로에 있다. |
| 1 ← 11.10 | baseline checksum·PG 기본 조립/fixture·소유자별 실행기. 실행기 본체는 11.1에서 만들고 11.10이 조립/고정한다(`PG계획:8`, `:128`). 12를 통한 전이 경로가 있어 중복이지만 유효한 실제 필요다. 서술 인계 예외는 F4. |
| 2 ← 12.4, 11.6 | 배포 ABI schema/fixture와 설정 port/코덱·확장 키 자리(`작업계획:44`, `PG계획:80`). 둘 다 실제 선행이다. |
| 4 ← 12.3 | 현재 attempt 확인 DB 함수·시험 INSERT trigger(`작업계획:32`). 이후 생성한 확장 role의 EXECUTE까지 4가 검증한다. |
| 5 ← 12.9 | 공통 schedules SDK와 메타(`작업계획:104`). 설치/예약을 따로 구현하지 않는다. |
| 6 ← 12.10 | 그룹 보류/해제·예약 발화/새 청구 차단·진행 취소(`작업계획:116`). registry 작성자는 13으로 유지된다. |

- 1→2→3→4→5→6→7→8은 `에픽:90`과 `조사:138`의 공유 코드 충돌 근거가 있는 직렬화 결정이다. 단순 기능 독립성만으로 간선을 삭제하라고 제안하지 않았다. 9→10은 정리된 배포 대상과 검증 결과를 필요로 한다.
- epic 12의 Handoff는 `에픽:83`에서 받고 있으며 `작업에픽:93`·`:94`·`:96`·`:103`과 일치한다. 12.10의 `<ext>.*` 자동 그룹과 core 분석 생산자의 명시 그룹 책임도 보존된다. 확장을 끄는 13이 core 분석 namespace를 추측하는 구현은 요구하지 않는다.
- 뒤 에픽 인계는 아래처럼 연결된다. epic 14·15의 아직 없는 RLS를 13이 미리 구현할 필요는 없다.

| 소비자 근거 | 13의 생산 책임 |
| --- | --- |
| `_bmad-output/personal-brain/tickets/epic-channels/epic-channels.md:53` | 4: role·출처 결합·권한. 계약 표 INSERT/RLS는 15가 추가한다. |
| `_bmad-output/personal-brain/tickets/epic-garmin-import/epic-garmin-import.md:16`, `:64` | 1: 확장 패키지/DDL 등록 경로, 3: Python 설치 경로, 4: role. 실제 Garmin lock 재현성은 14 소유라는 `에픽:85` 분담을 유지한다. |
| `_bmad-output/personal-brain/tickets/epic-garmin-runtime/epic-garmin-runtime.md:55` | 1/3/4/5/6: 설치·활성·DDL·role, 2: manifest·snapshot. 실제 Garmin 인증/수집은 16이다. |
| `_bmad-output/personal-brain/tickets/epic-search-and-health-query/epic-search-and-health-query.md:57` | 공개 상태 view는 F3대로 6의 최종 산출물로 고정할 것. 검색 응답 표시는 17이다. |
| `_bmad-output/personal-brain/tickets/epic-health-analysis/epic-health-analysis.md:66` | 13.6이 12.10을 호출해 보류하고, 18이 자기 분석 일감·예약에 `extension:garmin`을 붙인다. 18에 별도의 13 직접 after를 강제할 새 선행은 발견하지 못했다. |

### 보드와 코드 확인의 한계

- 지정 보드 명령은 `UV_CACHE_DIR=/tmp/brain-epic13-uv-cache`와 `--offline`을 붙여 성공했다. 최초 기본 캐시 접근은 sandbox 권한으로 실패했고, 캐시를 임시 위치로 옮겨 네트워크·설치 없이 재실행했다. epic 13은 refined=true, next_id=11, 10개 entry 모두 planned·file=null·hitl=false다. `unpinned_after=[]`, `undeclared_after=[]`, `order_conflict=[]`이고 cycle·drift 오류는 없었다. 보드 정적 조회는 제품 테스트 실행이 아니다.
- 코드에 기대는 조사 주장은 현재 checkout에서 읽어 확인했다. `apps/cli/src/install/flow.ts:105`의 실패 결과에는 성공 report가 없고, `packages/postgres/src/migrate.ts:123`은 아직 단일 schema_version 모델이며, `apps/cli/src/assembly.ts:79`도 SQLite 조립이다. 이를 이미 존재하는 11·12 결과로 오인하지 않았다. 현재 `apps/cli/src/commands/guide-schema.ts:65`의 standalone 메타 조회와 `:74`의 namespace 부재 오류는 스킬의 지원 확인 접근에 맞는다.
- `.claude-plugin/marketplace.json:9`의 로컬 상대 source와 `plugin/.claude-plugin/plugin.json:3`의 version을 읽었다. `세트:115`의 앞선 커밋 app-ref·version 동시 변경은 저장소 정책에 맞다. 실제 이 Mac marketplace 출처·Python 버전·설치 가능성·PG 권한/프로세스 동작은 이번 정적 검토로 실측하지 않았다.

## 재검증 (2026-10-28)

판정: 통과 — F1~F5·S1·S2 모두 해소, 새 지적 없음.

수정된 에픽 Notes와 entry 1·5·6·8·10을 앞선 지적 및 메인 checkout의 동일한 Set·Dependencies·ticket 규칙과 대조했다. 위의 근거 약칭을 그대로 쓴다. 이 판정은 draft 세트의 책임·실행 경로·검증 계획에 대한 정적 판정이며, 구현 완료나 설치본 동작을 인증하지 않는다.

### 지적별 판정

| 지적 | 판정 | 반영 근거와 판단 |
| --- | --- | --- |
| F1 | 해소 | `에픽:92`, `세트:8`, `세트:56`, `세트:115`에 생산자 1의 시험용 resolver와 5의 가짜 로그인 harness, 소비자 10이 모두 명시됐다. 기본 홈이 아닌 홈에서만 환경 변수로 켜지고 새 CLI·데몬·에이전트 프로세스에 같은 홈·환경을 전달한다. 10은 격리 홈·DB·Label에서 설치본과 같은 앱·스킬을 검증하며, 운영 설치본의 버전·스킬 발견 증거를 별도로 남긴다. 사용자용 설치 옵션이나 testext 일반 출하 없이 설치본 정상 경로를 구성할 계약이 생겼다. |
| F2 | 해소 | `세트:93`이 기본 suite의 Node testext 갱신 보존과 선택 Python 진입점의 pyfixture 갱신 보존을 분리한다. 기본 suite에서 Python을 설치하거나 찾지 않으며, 실행 감시로 호출 0건을 확인하고 두 명령·사전 조건을 plan에 남긴다. `세트:32`, `세트:33`, `에픽:50`의 Python 독립 조건과 맞는다. |
| F3 | 해소 | `에픽:93`, `세트:8`, `세트:56`, `세트:68`이 1의 설치·활성·연결 사실, 5의 로그인·예약·실패 사실, 6의 공개 조회 계약으로 분담한다. `세트:70`에 E13-6 covers가 추가됐고, `세트:69`는 같은 계약의 미설치·로그인 미완료·활성·비활성·중단 수 및 비밀 배제를 검증한다. epic 17은 CLI 출력 역해석 없이 이 계약을 받아 검색 응답 표시만 맡는다. |
| F4 | 해소 | `에픽:91`에 11.6·11.10 → 13.2·13.1의 양쪽 description 조건에 대한 날짜 있는 명시적 예외가 있다. 받는 산출물은 `세트:8`, `세트:20`에 있고, 실제 경로·시그니처는 epic 11·12 완료 HEAD에서 확인하도록 했다. `작업에픽:102`의 기존 예외를 자동 확장하지 않고 13의 예외를 따로 기록했다. |
| F5 | 해소 | `에픽:95`부터 `에픽:105`까지 1~10 각각의 risk 값과 잘못됐을 때의 사용자·사업 영향 이유를 기록했다. 값은 세트 각 entry의 risk와 일치한다. 공유 사항을 부모 Notes에 두는 규칙에 맞는 id별 대응이며, 등급을 다시 결정할 이유는 없다. high-risk leaf의 criteria 외 추가 check는 앞선 F5에 적힌 대로 leaf 정제 때 Notes에 구체화할 의무로 남는다. 현재 세트는 모두 leaf 없는 draft다. |
| S1 | 해소 | `에픽:94`, `세트:8`이 단일 testext·연결 확인 하나·확장 DDL 0001 하나·정상 ABI 결과 한 건으로 tracer plan을 제한한다. `세트:8`은 epic 11·12 완료 HEAD에서 세션 크기를 판정하고, 넘치면 비필수 완성을 이름 붙인 후속 story로 나누되 설치 → DDL → registry → 실제 자식 → status 경로를 1에 남긴다. `세트:9`의 list·명령 메타에 대한 최소 검증까지 빼는 결정은 아니다. |
| S2 | 해소 | `에픽:94`, `세트:8`이 1의 격리 PG·Brain 홈·testext 설치 fixture·정리 도구 소유와 후속 재사용을 명시한다. 각 plan에 명령·사전 조건·관찰값·정리를 기록하고 기본 Node/PG·선택 Python·선택 스킬 행동 평가를 나눈다. `세트:9`의 실제 Node 자식과 `세트:80`의 가짜 CLI가 구별된다. `에픽:94`는 실제 SKILL.md 입력과 connection_failed·공개 상태 비밀 배제 case를 더하고, `세트:80`, `세트:81`의 case별 명령 순서·최종 보고 판정에 함께 적용된다. `세트:115`, `세트:116`의 실제 설치본 세션 기록과도 구별된다. |

### 새 모순과 의존성 확인

- 새 지적 F6 이상은 없다. `에픽:92`의 시험용 주입은 `에픽:84`의 시험 전용 경로 주입을 별도 프로세스까지 구체화한 것이며, 앱에 포함된 패키지만 사용자에게 설치시키는 정책을 바꾸지 않는다. 운영과 다른 홈·DB·Label은 `spine:520`(AD-34)의 검증 격리와 맞고, 자원 이름 파생은 여전히 epic 11 소유다(`PG계획:8`). `세트:115`의 운영 버전·스킬 발견과 격리 정상 경로 증거를 합쳐 Done when 5를 검증한다(`에픽:58`).
- `에픽:93`과 `세트:68`의 SQL view/SDK projection 선택은 동일한 공개 조회 계약을 내는 구현 선택이다. registry만 상태를 쓰고 외부 소비자는 읽는다는 AD-29(`spine:460`)와 일치한다. AD-30의 schema·role·출처 경계(`spine:468`, `spine:471`, `spine:472`)나 AD-33의 감독자·manifest/snapshot 소유(`spine:501`, `spine:508`)를 바꾸는 문장은 추가되지 않았다.
- epic 12의 감독자/probe·ABI·예약 SDK·보류 그룹 인계는 유지된다(`작업에픽:93`, `작업에픽:94`, `작업계획:104`, `작업계획:116`). 공개 상태 view의 최종 생산자를 13.6으로 정해도 12.10이 보류 수단을, 13이 registry를, 18이 core 분석의 그룹 부착을 맡는 경계는 그대로다(`작업에픽:103`, `세트:68`). 트랜잭션/재조정 대안은 기존 Decision(`에픽:87`)을 적용하며 다시 논의하지 않았다.
- 스킬 행동 평가의 기존 여섯 case(`세트:80`, `세트:81`)에는 `에픽:94`의 두 case가 추가로 적용된다. 여섯 case만 허용한다고 한정한 문장은 없으므로 충돌로 보지 않는다. 후속 leaf의 criteria·plan은 부모 Notes까지 반영해야 한다. tracer의 비필수 완성 분리는 cleanup 전용 sweep에 기능을 넘기는 허용이 아니며, 기존 `세트:104`의 새 기능 story 분리와 양립한다.
- 사람 개입 없는 추천 결정·로컬 배포·증거 기록은 `이니셔티브:188`, `이니셔티브:189`의 위임을 적용했다. hitl·원격 push·실계정 범위를 바꿀 새 증거는 없으며 기존 Decision을 재논의하지 않았다.
- 지정 보드를 `UV_CACHE_DIR=/tmp/brain-epic13-uv-cache uv run --offline ~/.agents/skills/bmad-agent-po/scripts/tickets.py --project-root "$(git rev-parse --show-toplevel)" status _bmad-output/personal-brain`으로 읽었다. 성공했으며 `unpinned_after=[]`, `undeclared_after=[]`, `order_conflict=[]`이고 cycle·drift 오류는 없었다. epic 13은 refined=true·next_id=11, 10개 entry는 모두 planned·file=null이며 1~8 직렬·9 sweep·10 설치본 확인과 교차 after가 유지된다. 제품 테스트·빌드·Docker·네트워크·설치·커밋은 실행하지 않았다.

이 재검증에서 쓴 저장소 파일은 이 보고서 하나이며, 기존 본문을 유지하고 이 절만 덧붙였다. 다른 수정 대상의 내용은 변경하지 않았고 보고서에 절대 홈 경로는 없다.
