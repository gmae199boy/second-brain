판정: 수정 후 재검증 — fix 3 / suggest 3 / ask 0

검토일: 2026-10-28. 범위는 epic 15의 미커밋 에픽과 7개 draft entry에 대한 Ticket · Set · Dependencies다. leaf 파일은 없으며, full criteria가 아직 없는 사실 자체는 결함이 아니다. 정적 문서·코드 확인과 보드 status만 수행했다. 테스트·빌드·Docker·네트워크·설치·커밋은 하지 않았다.

인용 약칭은 다음 저장소 상대 경로를 뜻한다. 아래 `약칭:행`은 해당 파일·행 근거다.

- 에픽: `_bmad-output/personal-brain/tickets/epic-channels/epic-channels.md`
- 세트: `_bmad-output/personal-brain/tickets/epic-channels/tickets/tickets.toml`
- 조사: `_bmad-output/personal-brain/tickets/epic-channels/epic-channels-research-code.md`
- 이니셔티브: `_bmad-output/personal-brain/initiative-personal-brain.md`
- spine: `_bmad-output/personal-brain/architecture-brain-v1-slice-1/architecture-brain-v1-slice-1.md`
- PG계획: `_bmad-output/personal-brain/tickets/epic-postgres-primary/tickets/tickets.toml`
- 작업계획: `_bmad-output/personal-brain/tickets/epic-jobs-and-scheduler/tickets/tickets.toml`
- 확장계획: `_bmad-output/personal-brain/tickets/epic-extensions/tickets/tickets.toml`

검사 기준은 메인 checkout의 `~/github/second-brain/_bmad/render/bmad-agent-po/second-brain-bbe56f7ddda0/dcffd73a7f031ef42569/references/validate-checks.md` 중 Ticket · Set · Dependencies와 같은 폴더 `ticket.md`의 “Rules the template cannot carry”다. 두 파일을 읽었으며 수정하지 않았다.

## fix

### F1 — E15-1의 미래 연결용 identity·provenance를 완성하는 스토리가 드러나지 않는다

- 근거: `에픽:39`는 비밀 아닌 봇 참조, 외부 대화 참조, 선택 thread, provenance, 있는 경우의 외부 message id, 옛 이력과 새 발신이 같은 conversation에 속함을 요구한다. `세트:8`은 channel·conversation의 “최소 칸”만 말하고, `세트:32`는 legacy 출처를 만들지만 같은 conversation 연결을 말하지 않는다. `세트:79`는 실계정 message id 확인이며 identity 계약의 나머지를 구현하는 단계가 아니다. E15-1 covers는 1·7에만 있다(`세트:10`, `세트:81`).
- 문제: 발신 성공 tracer만으로는 R13의 후속 답장·스레드 연결 경계를 증명할 수 없다. 최소 칸에서 생략한 선택 thread·봇 참조·생산자 provenance 등을 어느 스토리가 끝내는지 불분명하고, legacy 연결을 만드는 3은 E15-1의 자기 몫도 표시하지 않는다. covers id만으로는 이 부분의 책임 분담이 닫히지 않는다.
- 변경: 에픽 Notes에 E15-1 분담을 명시한다. 추천은 1이 새 발신의 identity·provenance·선택 thread·응답에 있는 외부 message id 보존을 소유하고, 3이 legacy와 새 요청의 같은 conversation 연결을 완성하며 E15-1을 추가로 covers하는 것이다. 7은 설치본에서 그 연결의 관찰만 맡긴다. 1·3의 description과 verify에 각자 맡는 결과의 되읽기를 짧게 명시한다. tracer 크기를 넘으면 정상 발신에 불필요한 완성은 이름 있는 후속 스토리에 배정하되, 수신 구현을 추가하지 않는다.

### F2 — 설정이 없을 때 operator_actions 기록만으로 7을 통과시킬 수 있다

- 근거: `에픽:88`, `에픽:90`은 설정이 없으면 해당 실계정 단계/스토리를 `awaiting-operator`로 남기라고 한다. `이니셔티브:192`도 사람이 할 일의 상태를 명시한다. 반면 `세트:79`는 operator_actions를 남긴다고만 하고, `세트:80`은 “실계정 단계의 성공 또는 operator_actions”를 같은 verify 결과로 받는다.
- 문제: operator_actions 목록을 썼다는 사실과 실발신 확인 완료가 구별되지 않아, 설정이 없어도 7이 done으로 닫힐 수 있다. 위임은 에이전트가 가능한 확인을 하고 run을 계속하라는 결정이며, 미완료 실계정 증거를 성공으로 간주하라는 결정은 아니다.
- 변경: 7의 description·verify에 “로컬 설치·명령·doctor·스킬 발견은 에이전트가 먼저 검증하고, 실계정 설정이 없으면 필요한 두 키와 재개 절차를 operator_actions에 남기며 7은 awaiting-operator; 실발신 성공으로 기록하지 않고 run은 계속”을 적는다. 이미 지시된 `hitl = false`는 유지한다. 원격 push만 필요한 배포 단계도 같은 방식으로 완료와 잔여 작업을 구분한다.

### F3 — sweep 다음에 설치본 확인을 두는 예외가 Notes에 없다

- 근거: `세트:68`, `세트:71`의 6은 1~5의 cleanup만 하고, `세트:79`, `세트:82`의 7은 6 뒤에서 배포와 실계정 확인을 한다. `에픽:94`, `에픽:95`의 순서 Decision은 1~5까지이며 6·7 배치를 설명하지 않는다. Set 규칙은 3개 초과 세트가 closing E2E suite 외의 모든 entry를 기다리는 Refactor sweep으로 닫히도록 한다.
- 문제: 7은 단순 closing 자동 E2E suite가 아니라 app-ref/version 변경·설치·실계정 확인을 포함한다. 현재 순서는 앞 에픽의 운영 확인 분리 방식과 일관되지만, 이 에픽의 명시적 예외 없이 규칙 충족으로 볼 수 없다.
- 변경: 에픽 Notes에 날짜 있는 Decision으로 “6이 코드 스토리 1~5의 cleanup을 마감하고, 7의 로컬 배포·설치본/실계정 확인은 그 뒤 별도로 둔다; 7에서 발견한 기능 수정은 버그 스토리로 돌린다”를 기록한다. 사용자 위임과 앞 에픽 선례를 적용하면 되며 순서를 뒤집거나 재질문할 필요는 없다.

## suggest

### S1 — tracer의 한 세션 범위에 명시적인 축소 기준을 둔다

- 근거: `세트:8`은 새 DDL·Store/fake/계약·인계·worker·HTTP adapter·설정·출력 코덱·재사용 서버까지 묶는다. `작업계획:8`, `확장계획:8`에는 선행 HEAD를 읽고도 한 세션을 넘으면 비필수 완성을 이름 있는 후속 story로 분리하는 기준이 있다. 현 코드의 PG factory는 아직 HealthStore·SchemaStore뿐이다(`packages/postgres/src/store.ts:44`, `:49`).
- 이유: 층을 관통하는 정상 한 건이라는 구성은 옳고, 재시도·RLS·묶음·CLI가 뒤로 빠져 있어 현재로서 명백한 과대 story라고 단정하지 않는다. 다만 실제 epic 11~13 코드가 없는 checkout에서는 접합 비용을 확정할 수 없다. “최소 칸”만으로는 범위 팽창을 막기 어렵다.
- 제안: 1의 plan이 요청 하나·일반 conversation 하나·sendMessage 하나·정상 ABI result 하나에 필요한 능력만 나열하도록 하고, 인계 HEAD 확인 후 한 세션을 넘으면 비필수 완성을 이름 있는 story로 옮긴다고 적는다. 실제 PG → 감독자 → Node worker → HTTP → token 결과 확정과 가리기는 tracer에 남긴다. cleanup story로 기능을 넘기지 않는다. F1의 identity 완성 분담도 이 기준과 함께 정한다.

### S2 — 고위험 계약의 추가 체크와 verify 진입점을 정제 때 고정한다

- 근거: `세트:9`, `세트:21`, `세트:33`, `세트:45`, `세트:57`은 시험 이름·실행 명령을 plan에 남긴다고 명시한다. 이는 draft의 검증 접근으로 적절하다. 다만 `에픽:97`~`:99`의 high risk 1~3에는 기준 외 별도 체크가 아직 없고, `세트:21`의 관찰 목록은 description의 결과 확정 직전 crash(`세트:20`)를 직접 열거하지 않는다. `조사:149`, `조사:150`은 동시 gate·인계 경계·stale token·결과 저장 경계의 실패 주입을 제안한다.
- 이유: entry 단계에서 모든 acceptance criteria를 요구할 수는 없지만, 순차 중복 요청만으로 동시 발신 gate를 증명할 수 없고 접수 뒤 응답 유실만으로 결과 저장 직전 crash를 증명할 수 없다. 실제 Node worker·PG를 쓰는 harness와 clock 전진을 누가 제공하는지도 plan에서 재현 가능해야 한다.
- 제안: 1은 동시 같은 의미 키/gate 경쟁과 HTTP 중 DB 트랜잭션 미보유, 2는 서버 접수 뒤 worker 종료·DB 결과 확정 경계의 재개와 10회/지수 대기, 3은 다른 dataset의 같은 원래 키·같은 키의 원문 충돌·인계 트랜잭션 중간 종료를 추가 체크로 고정한다. 4는 사진·문서·앨범 경계값과 한 장 sendPhoto도 포함한다. 1이 제공하는 격리 PG/홈·실제 Node worker·로컬 서버와 12.1의 가짜 clock을 각 plan 명령이 직접 구성하도록 한다. 별도 행동 평가 진입점과 정리 명령도 함께 기록하면 비작성자가 실행할 수 있다. 이번 검토에서 시험을 실행하자는 뜻은 아니다.

### S3 — 3의 legacy 비발신 계약과 5의 resend 명령 완성을 구분한다

- 근거: `세트:32`는 3에서 “resend가 거부한다”고 하지만 명령 구현과 legacy resend verify는 `세트:56`, `세트:57`의 5다. 3은 2 뒤이며 5를 기다리지 않는다(`세트:35`, `세트:59`).
- 이유: 최종 계약은 일치하고 5가 거부 시험을 소유하므로 새 기능 누락은 아니다. 다만 3을 독립 구현할 때 아직 없는 CLI를 먼저 만들거나 검증에 요구할 여지가 있다.
- 제안: 3은 legacy를 요청/인계 대상에서 구조적으로 제외하고 resend 적격성에서 배제할 정보를 제공하며, CLI 거부의 완성과 관찰은 5가 소비한다고 양쪽 description에 명시한다. 3→5 역방향 의존성은 추가하지 않는다.

## ask

없음. 불명 재시도·중복 가능성 수용·10회 뒤 failures/doctor/resend·resend 스킬·옛 봇 재사용·실계정 에이전트 확인은 이미 결정됐다. 수정과 제안은 그 결정의 책임 배정 및 검증 구체화이며 사용자 판단을 다시 요구하지 않는다.

## 확인한 항목

### Ticket · Set

- 모든 entry에 description·verify·risk가 있고 알려진 placeholder나 임의 estimate는 없다. risk 이유는 `에픽:96`~`:103`에 모아 두었다. high risk의 기준 밖 체크는 S2대로 정제 시 명시하면 된다. References의 조사 절, epic의 부모·spine·통합 경계·accepted intent·migration contract를 열어 대조했다. source 경로 제한은 leaf 작성 때 적용할 사항이며, 조사 문서의 코드 증거 경로를 삭제하라는 뜻으로 해석하지 않았다.
- E15-1~8의 covers id는 전부 존재하며 미지의 id는 없다. 기능/통합 책임은 아래와 같다. F1은 id 누락이 아니라 E15-1 내 실제 결과 분담 누락이다.

| Requirements | 담당과 분담 |
| --- | --- |
| E15-1 | 1 신규 identity 기반, 7 설치본 관찰. thread·provenance·legacy 같은 대화 연결은 F1 보완 필요 |
| E15-2 | 1 의미 키·원자 인계·gate, 3 요청 INSERT/인계 crash 복구와 확장 경계 시험 |
| E15-3 | 1 supervised 분류·실제 Node ABI worker·기회적 drain 비발신·DB 밖 HTTP |
| E15-4 | 1 sendMessage·비밀 코덱·텍스트 가리기, 4 미디어/multipart·상한·캡션 가리기, 7 실계정/설치본 |
| E15-5 | 2 확정 실패/불명·지수/429 대기·10회·failures/doctor·생산 결과 보존 |
| E15-6 | 4 요약→앨범→전문과 항목별 결과·부분 재시작 |
| E15-7 | 3 legacy DDL·출처·RLS·attempt trigger·비인계, 5 resend 거부의 명령 관찰 |
| E15-8 | 5 CLI/SDK/메타·상태·resend·스킬/행동 평가, 7 설치본 스킬 발견 |

- 공유 covers E15-2는 기본 정상 인계와 crash/확장 경계로, E15-4는 텍스트/미디어/설치 관찰로 구분된다. E15-8은 명령 구현과 설치 관찰로 구분된다. 새 GUI는 없으며 기존 CLI·에이전트 스킬을 확장한다. 로컬 가짜 서버 기반 시험과 마지막 실계정 한 번의 분리는 `에픽:52` 및 entry 1·7과 맞는다.
- tracer는 `에픽:94`의 날짜 있는 Decision에서 1로 지정됐고 다음 2는 가장 불확실한 불명/재시도다. 1은 실제 모든 층을 통과하며 완료 시 관찰할 POST와 sent 이력이 있다. 사람이 starter를 실행해야 한다는 전제는 없고, 설정 부재도 7로 분리됐으므로 1의 hitl=false를 다시 true로 바꾸지 않는다.
- `spine:533`, `spine:786`의 Deferred는 `에픽:83`, `에픽:93`의 뒤 결정으로 해소됐다. API 중복 방지·보낸 메시지 조회의 실제 지원은 조사에서 미확인이지만, 정책은 그 결과와 무관하게 확정됐다는 Decision을 따른다. 미확인 사실을 API 부재라고 단정하지 않았으며 새 ask로 만들지 않는다.

### Dependencies와 인계

- `uv run ~/.agents/skills/bmad-agent-po/scripts/tickets.py --project-root "$PWD" status _bmad-output/personal-brain`을 실행했다. 최초 sandbox 실행은 uv cache 임시 파일 권한으로 실패했고, 권한을 부여한 재실행은 성공했다. 출력은 `unpinned_after=[]`, `undeclared_after=[]`, `order_conflict=[]`이며 cycle·drift 오류는 없었다. epic 15는 refined=true·gated_by=[]·next_id=8, 7개 entry 모두 planned·file=null이다. status는 구현 완료 증거가 아니다.
- 1의 `13.9`는 확장의 마지막 코드 sweep과 공용 조립·core 번호열 충돌을 마감하는 실제 선행 조건이다(`확장계획:103`, `:107`; `에픽:95`). `11.6`은 설정 코덱 계약(`PG계획:80`), `12.1`은 supervised 등록부·감독자·정상 ABI와 실제 자식 실행(`작업계획:8`)을 준다. 13.9 경로로 이미 도달하는 의존성을 명시적으로 다시 적은 것이며 잘못된 순서로 판정하지 않는다.
- 3의 `13.4`는 NOBYPASSRLS/출처 결합 role과 계약 표 INSERT의 선행 권한(`확장계획:44`), `12.3`은 실제 표에 부착할 attempt 확인 함수/trigger 예(`작업계획:32`)다. 5의 `13.7`은 스킬 정적·행동 시험 두 층(`확장계획:80`)이다. 이 간선들도 실제 소비 산출물을 가리킨다.
- 1~5의 직렬화는 `에픽:95`가 공유 Store·SQL 번호·조립·코덱·명령 등록부 충돌로 정했다. 현 코드도 Store 조립(`apps/cli/src/assembly.ts:51`, `:66`)과 출력 코덱 등록부(`packages/core/src/output/codecs.ts:6`)를 공유한다. 단순한 표시 순서라며 간선을 제거하지 않는다. 공통 서버·테스트 생산자는 1이 먼저 만들고 2~5가 경로상 기다린다(`세트:8`). 기존 WorkStore 계약 패턴은 `packages/core/src/testing/contracts/work-store.ts:31`에 있다.
- epic 11~13 생산자 description에 새 인계 문장을 요구하지 않는 예외가 `에픽:95`에 명시됐다. 이를 다시 F로 만들지 않는다. 현재 PG·감독자·확장이 전부 구현됐다고 가정하지 않고 인계 HEAD에서 시그니처를 확인하는 entry 문구를 따른다.
- epic 14는 core legacy 표를 받아 합성 fixture·반입·재개·대조를 담당한다(`_bmad-output/personal-brain/tickets/epic-garmin-import/epic-garmin-import.md:30`, `:39`, `:67`, `:69`). 생산자는 3이며 legacy 구분·RLS·attempt trigger를 준다(`세트:32`). migration contract의 dataset+원래 표+키 및 충돌 보존 규칙도 함께 적용된다(`_bmad-output/personal-brain/prep-garmin-absorption/migration-contract.md:42`, `:53`).
- epic 16은 같은 현지 날짜/사건의 의미 키로 수집 사건 요청을 INSERT한다(`_bmad-output/personal-brain/tickets/epic-garmin-runtime/epic-garmin-runtime.md:60`, `:62`). 필요한 정상 요청/의미 키는 1, 확장 INSERT/RLS는 3이 제공한다. core가 Garmin 사건 문구를 생성하는 것은 이 세트의 범위가 아니며, 16이 사건을 채널 요청으로 변환한다. F1 보완 시 생산자 provenance도 이 경계에 포함한다.
- epic 18은 결과 묶음을 생성하고 발신 실패와 분석 성공을 분리한다(`_bmad-output/personal-brain/tickets/epic-health-analysis/epic-health-analysis.md:19`, `:64`). 생산자는 4의 묶음/항목 계약과 1의 의미 키·gate이고, 생산 결과 보존은 2가 검증한다(`세트:20`, `:44`). 뒤 에픽들은 아직 leaf가 없으므로 실제 story cross-after는 쪼갤 때 이 entry에 고정해야 한다. 이번 검토에서 뒤 에픽 파일을 변경하지 않았다.

### Done when 1~4

| Done when | 결과를 제공하는 entry와 한계 |
| --- | --- |
| 1 공통 계약 발신·이력·실계정 | 1의 PG/실제 Node/가짜 서버 정상 경로, 7의 옛 설정 이전·실발신. F1 identity 보완 및 F2 미완료 상태 구분 필요 |
| 2 재시도·생산 결과 보존 | 2의 unknown/확정 실패·429·10회·행/해시 불변, 4의 항목별 재시작 |
| 3 동일 결과 중복 억제·legacy 비발신 | 1의 의미 키·gate, 3의 legacy 비인계·batch 재실행, 5의 legacy resend 거부. unknown 재시도의 외부 중복 가능성 수용은 이미 기록된 예외(`에픽:83`) |
| 4 플러그인 설치본 동작 | 5의 스킬·명령 및 7의 app-ref 앞선 commit/version 동반 갱신·설치본 status/resend/doctor·스킬 발견. F2대로 남은 operator 작업과 성공 증거를 분리 |

보고서 이외의 파일은 수정하지 않았다. 앞 에픽 구현이 없는 상태에서 정적 계획의 일관성을 검토한 결과이며, 실제 빌드·실발신·설치 성공을 주장하지 않는다.

## 재검증 (2026-10-28)

판정: 통과 — F1~F3 해소, S1·S3 해소, S2 부분 해소(정제 때 남길 검증 기반·진입점의 구체화). 새 fix 없음.

수정된 에픽 Notes와 entry 1·2·3·4·5·7을 위 Set·Dependencies 및 “Rules the template cannot carry”에 다시 대조했다. 아래 약칭은 앞 절과 같으며, 행 번호는 이번 재검증 시점의 파일 기준이다. 이 판정은 draft 세트의 책임 배정과 검증 접근에 대한 것이며 구현 완료 판정은 아니다.

### F1 — 해소

`에픽:104`가 E15-1을 1(새 발신 identity·provenance), 3(legacy와 새 발신의 같은 conversation 연결), 7(설치본 관찰)로 나눴다. `세트:8`은 비밀 아닌 봇 참조·외부 대화 참조·선택 thread·생산자 출처·응답에 있는 외부 message id의 완성을 1에 명시하고, `세트:9`는 channel·conversation·출처·message id의 되읽기를 요구한다. `세트:32`와 `세트:33`은 legacy와 새 요청을 같은 conversation으로 연결하고 되읽는 결과를 3에 배정했으며, `세트:34`에 E15-1 covers도 추가됐다. 따라서 “최소 칸” 뒤에 완성 주인이 없던 문제가 해소됐다. 수신 구현을 추가하지 않는 경계도 `에픽:104`에 남았다.

### F2 — 해소

`에픽:105`가 설정 부재 시 7의 상태를 `awaiting-operator`로 고정하고 operator_actions를 실발신 성공으로 세지 못하게 했다. `세트:79`는 로컬 설치·status·resend·doctor·스킬 발견을 먼저 확인한 뒤, 설정이 없으면 필요한 두 키와 재개 절차를 남기며 run을 계속하도록 한다. `세트:80`도 실발신 성공의 `sent`·message id 증거와 설정 부재의 `awaiting-operator`를 구분하므로, 목록 작성만으로 7을 끝내던 경로가 없어졌다. 원격 push가 필요한 배포의 완료·잔여 구분도 `세트:79`에 추가됐고, `hitl = false`는 `세트:83`에 유지된다. 이는 기존 `에픽:88`, `에픽:90` 및 `이니셔티브:189`, `이니셔티브:192`의 위임과 일치한다.

### F3 — 해소

`에픽:106`에 날짜 있는 Decision으로 6이 코드 스토리 1~5의 정리를 마감하고 7의 배포·설치본·실계정 확인은 그 뒤 별도로 둔다는 예외가 기록됐다. 7에서 찾은 기능 문제는 버그 스토리로 돌린다고 명시한다. `세트:68`, `세트:71`의 cleanup 전용 sweep과 `세트:82`의 7→6 의존성이 이 Decision과 맞는다. 이는 `이니셔티브:187`의 운영 확인에서 나온 문제 처리 및 `확장계획:104`, `확장계획:107`, `확장계획:115`, `확장계획:118`의 sweep 뒤 설치본 확인 선례를 적용한 것이므로, 순서를 다시 뒤집을 사유가 없다.

### S1 — 해소

`에픽:107`과 `세트:8`에 요청 하나·일반 conversation 하나·sendMessage 하나·정상 ABI 결과 하나라는 plan 상한이 들어갔다. 선행 HEAD를 읽고도 한 세션을 넘으면 비필수 완성을 이름 있는 다음 스토리로 분리하되, PG→감독자→실제 Node worker→HTTP→현재 token 결과 확정 및 가리기는 1에 남긴다. 기능을 cleanup으로 넘기지 않는 경계는 `세트:68`에 유지된다. 이 축소 기준은 비필수 완성에만 적용되므로, 1의 identity 완성을 요구하는 `에픽:104` 및 `세트:8`을 취소하지 않는다.

### S2 — 부분 해소

- 반영: `에픽:107`이 고위험 1~3의 추가 확인을 Notes에 고정했다. `세트:8`은 동시 gate 경쟁과 HTTP 중 DB 트랜잭션 미보유를, `세트:9`는 같은 의미 키 동시 요청의 POST 하나를 요구한다. `세트:21`은 서버 접수 직후 worker 종료·결과 확정 직전 종료·10회 실패·429 대기와 12.1의 가짜 clock 사용을 명시한다. `세트:33`에는 다른 dataset의 같은 키, 같은 dataset·키의 원문 충돌, 인계 트랜잭션 중간 종료가 추가됐다. `세트:45`는 한 장 sendPhoto와 사진·문서·앨범 경계값을 추가했다.
- 남은 구체화: `세트:8`이 공유 서버·테스트 생산자를 소유하고 `세트:9`가 PG·실제 Node worker를 쓰지만, 이 세트에서 재사용할 격리 PG/Brain 홈·정리 도구의 소유와 각 plan 명령이 이를 직접 구성한다는 약속은 아직 명시되지 않았다. `세트:21`이 소비하는 clock은 `작업계획:8`에 생산자가 있어 의존성 누락은 아니다. 시험 이름·명령을 plan에 적는 문구는 `세트:9`, `세트:21`, `세트:33`, `세트:45`, `세트:57`에 남지만, 기본 통합 시험·별도 스킬 행동 평가의 진입점과 사전 조건·정리 명령을 함께 고정하라는 제안은 전부 반영되지는 않았다. 7의 확인용 요청 정리는 `세트:79`에만 있다.
- 처리: 추가 실패 경계의 책임은 배정됐고 아직 leaf·plan이 없는 draft이므로 새 필수 수정으로 올리지 않는다. 정제 때 위 기반의 생산자·소비자 및 실행/정리 명령을 명시하는 제안으로 남긴다. 지금 시험을 실행하거나 구현 증거가 있다고 주장하는 것은 아니다.

### S3 — 해소

`세트:32`가 3의 책임을 legacy의 구조적 비인계와 resend 부적격 표식 제공으로 한정하고, CLI 거부와 관찰은 5가 완성한다고 명시했다. `세트:56`이 3의 표식을 소비하며 `세트:57`이 legacy resend 거부를 검증한다. `에픽:107`에도 같은 분담이 기록됐다. 3이 아직 없는 CLI를 먼저 구현·검증할 필요가 없어졌고, `세트:35`, `세트:59`의 기존 의존 방향도 유지된다.

### 새 모순 및 의존성 확인

새 지적(F4 이후)은 없다. 수정 문장은 다음 계약을 바꾸지 않는다.

- AD-30: core만 요청 인계를 소유하고, 확장은 role 출처에 결합된 INSERT만 하며 legacy는 인계하지 않는다(`spine:469`, `spine:471`, `spine:473`; `세트:8`, `세트:32`, `세트:33`).
- AD-33 및 epic 12·13: 실행 분류 supervised·실제 Node ABI worker·현재 attempt token을 사용한다(`spine:507`, `spine:508`; `세트:8`). worker 종료 뒤의 재개 시험(`세트:21`)은 종료를 확인할 수 없는 프로세스를 재청구하라는 요구가 아니므로, `작업계획:20`, `작업계획:21`의 종료 확인 경계를 대체하지 않는다. attempt 함수/trigger 예는 `작업계획:32`, 확장 role과 출처 결합은 `확장계획:44`가 생산하며 `세트:32`가 소비한다.
- AD-35: identity·provenance와 의미 키·gate의 소유는 core에 남는다(`spine:533`; `에픽:104`, `세트:8`). unknown 재시도는 이미 `에픽:83`, `이니셔티브:164`가 정한 후속 Decision을 그대로 따르므로 spine의 과거 Deferred를 다시 질문으로 열지 않는다.
- AD-36: dataset·원래 표·키·batch provenance를 보존하며, 새 충돌 시험은 조용한 손실을 금지하는 계약을 강화한다(`spine:540`, `spine:543`; `세트:32`, `세트:33`; `_bmad-output/personal-brain/prep-garmin-absorption/migration-contract.md:42`, `:53`). 실제 반입·기준 소스 선택의 주인을 3으로 옮기지 않는다.

보드 status를 오프라인으로 다시 실행했다: `UV_CACHE_DIR=/tmp/epic15-revalidate-uv UV_OFFLINE=1 uv run ~/.agents/skills/bmad-agent-po/scripts/tickets.py --project-root "$(git rev-parse --show-toplevel)" status _bmad-output/personal-brain`. 기본 uv cache에서는 임시 파일 권한 오류가 났고, 위 임시 cache 지정으로 성공했다. `unpinned_after=[]`, `undeclared_after=[]`, `order_conflict=[]`이고 cycle·drift 오류는 없었다. epic 15는 refined=true·gated_by=[]·next_id=8, 7개 entry 모두 planned·file=null이다. 이 상태 출력은 구현 완료 증거가 아니다.

이번 작업은 이 보고서 끝에 재검증 절만 덧붙였다. 테스트·빌드·Docker·네트워크·설치·커밋은 수행하지 않았다.
