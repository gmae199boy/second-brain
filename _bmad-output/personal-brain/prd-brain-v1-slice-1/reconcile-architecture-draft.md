# 입력 조정 — 아키텍처 초안 대비 PRD slice 1

초안 `inputs/personal-brain-final-architecture.md`(49절, 시험 전 작성)를 slice 1의 목표 문서(`prd-brain-v1-slice-1.md`, `addendum.md`, `.memlog.md`)와 맞춰 본 결과다.

범위 규칙: 초안의 데스크톱 앱, 스케줄러, 외부 integration, MCP, 모바일, Task/Goal/OpenLoop/Schedule, Graphify, 에이전트를 돌리는 Worker는 **의도된 제외**이므로 누락으로 보지 않았다. 메모리 백엔드(Supermemory → Postgres 원문 + pgvector 조각 + 에이전트 작업 로그), 추출 엔진 제거, Brain의 LLM 호출 0, 세션 시작만 주입은 **초안 이후의 확정 결정**이므로 모순으로 보지 않았다.

집계: 높음 2건, 중간 10건, 낮음 6건 (총 18건).

| # | 분류 | 초안 위치 | 요지 | 심각도 |
|---|---|---|---|---|
| F1 | ② 데이터 모델 | §2.3 L91-131, §12 L553-566, §44.4 L1612-1642 | 프로젝트 없는 세션에 워크스페이스를 붙일 경로가 없다 | 높음 |
| F2 | ① 원칙 | §1 L19-24, §8 L437-460, §44.4 L1636-1642 | 지속적 선호·나에 관한 사실의 자리가 없다 | 높음 |
| F3 | ② 데이터 모델 | §14 L592-619, §38 L1382-1411, §7 L419 | Session과 Execution이 한 테이블에 섞여 있다 | 중간 |
| F4 | ② 데이터 모델 | §44.2 L1560-1580, §44.3 L1584-1608 | 여러 세션·여러 harness를 묶는 작업 맥락 식별자가 없다 | 중간 |
| F5 | ① 원칙 | §6.1 L316-338, §43 L1508,L1519 | "명시적 조립, 동적 플러그인 없음"이 PRD에 없다 | 중간 |
| F6 | ① 원칙 | §2.2 L62-88, §43 L1508 | Runtime(능동 쪽)의 책임이 정의되지 않았다 | 중간 |
| F7 | ① 원칙 | §2.1 L37-58 | 규칙이 CLAUDE.md/AGENTS.md로 새면 canonical 소유가 깨진다 | 중간 |
| F8 | ③ 미기록 모순 | §44.9 L1744-1756 | "여러 기계 배제"가 brief의 Tailscale 밀어넣기 결정을 뒤집었는데 기록이 없다 | 중간 |
| F9 | ②+④ | §19 L779-808, §1 L24, §44.6 L1679-1703 | "그 문서가 어디 있었는지"를 받치는 FR이 없다 | 중간 |
| F10 | ② 데이터 모델 | §37 L1358-1376, §7 L407-431 | Execution·Resource·ExternalResourceLink가 제외 목록에도 없다 | 중간 |
| F11 | ② 데이터 모델 | §42 L1485-1495, §4.1 L199-214 | `vector(1024)` 고정이 색인 설정 교체를 막는다 | 중간 |
| F12 | ② 데이터 모델 | §2.3 L121-131, §17 L704-732 | `log_entries.project_id`가 꼬리표의 두 번째 진실이 된다 | 중간 |
| F13 | ④ 질적 의도 | §49 L2038, §44.10 L1760-1792 | harness 중립성을 확인하는 수단이 없다 | 중간 |
| F14 | ④ 질적 의도 | §44.2 L1568-1580, §44.3 L1584-1608 | "다른 에이전트가 이어받는다"가 UJ·SM에서 빠졌다 | 중간 |
| F15 | ④ 질적 의도 | §44.5 L1668-1676, §28 L1051-1072 | "내가 도구 이름을 말하지 않는다"가 지표에 없다 | 낮음 |
| F16 | ① 원칙 | §10 L493-516 | Decision이 Core의 독립 엔티티라는 말이 없다 | 낮음 |
| F17 | ① 원칙 | §34 L1224-1238, §35 L1242-1291 | `brain init`이 CLI/setup 층이라는 경계가 없다 | 낮음 |
| F18 | ① 원칙 | §15 L623-648, §16 L679-683 | append-only 강제와 시작 맥락 중복 제거가 요구로 적히지 않았다 | 낮음 |

---

## ① slice 1이 이미 지켜야 하는데 PRD가 말하지 않거나 어긋나는 원칙

### F2. 지속적 선호·"나에 관한 사실"의 자리가 없다 — 높음

- **초안**: §1 L19-24("내가 누구인지", "내가 무엇을 선호하는지"는 도구가 바뀌어도 유지되어야 하는 첫 두 항목), §8 L443-458(장기 기억의 역할 = durable preference, historical fact, personal context. 예시 셋 중 둘이 키보드 선호), §44.4 L1636-1642("나는 로우피치 키보드를 좋아한다"는 Keyboard 전용이 아니라 global memory).
- **무엇**: PRD의 영속 기록 종류는 진행·결정·규칙 셋뿐이다. Glossary(§3 L66)는 규칙을 "작업 규칙이나 선호"로 정의하면서 동시에 "켜져 있는 동안 시작 맥락에 들어간다"고 묶었다. 그래서 초안이 가장 먼저 꼽은 두 항목(나는 누구이고 무엇을 선호하는가)은 둘 중 하나로만 갈 수 있다. (a) 규칙으로 적어 매 세션 주입 → SM-C1(500토큰)을 선호 문장이 잡아먹고, 반대지표의 취지에 어긋난다. (b) 아무것도 적지 않고 대화 원문 조각 검색에만 의존 → UJ-6이 그렇게 되어 있다. 즉 "한 번만 말하면 된다"는 약속(§2.1 L32-35 JTBD)이 작업 규칙에만 적용되고 사람에 관한 사실에는 적용되지 않는다. 초안은 이 둘을 구분했다(주입 대상 = Decision/Rule, 보유 대상 = long-term memory).
- **제안**: 규칙의 정의를 둘로 쪼갠다. `log_entries.kind`에 `preference`(또는 `fact`)를 더하거나, 규칙에 **주입 여부 플래그**(`inject: always | on-demand`)를 둔다. 기본값은 작업 규칙 = always, 나에 관한 사실·선호 = on-demand(대분류 검색으로만 올라옴). Glossary §3의 규칙 항목에서 "선호"를 떼고 새 종류로 옮기고, FR-19에 "주입되는 규칙과 보유만 하는 선호는 구분된다"를 추가, addendum §2 스케치의 `rule_state`를 `inject_mode`로 확장. 이것을 하지 않겠다면 §6.1 Non-Goals에 "slice 1에서 나에 관한 사실·선호는 구조화하지 않고 대화 원문 검색으로만 찾는다"를 명시해 의도된 제외로 만든다.

### F5. "명시적 조립, 동적 플러그인 없음"이 PRD에 없다 — 중간

- **초안**: §6.1 L320-337(Provider abstraction ✅ / Explicit composition ✅ / Dynamic plugin marketplace ❌ / GitHub auto-install ❌ / Agent-generated provider ❌), §4.3 L275-278("이 composition은 의도적인 것이다. V1에서는 모든 provider를 동적으로 추가하는 plugin system을 만들지 않는다"), §43 Don't L1519.
- **무엇**: PRD FR-22는 "교체 가능한 연결 지점 뒤에 있다"까지만 말한다. 연결 지점을 **어떻게** 꽂는지가 비어 있어, 설정 문자열로 provider를 동적 로드하는 구현도 FR-22를 만족한다. 초안은 그것을 명시적으로 금지했다.
- **제안**: FR-22 Consequences에 한 줄 — "provider 구현은 host의 명시적 조립(composition root)으로만 주입된다. 설정 값으로 모듈을 동적으로 불러오거나 설치하는 경로는 없다." §6.1 Non-Goals에 "동적 provider 플러그인·마켓플레이스"를 추가(FR-24의 "Brain은 외부 의존성을 설치하지 않는다"와 짝).

### F6. Runtime(능동 쪽)의 책임이 정의되지 않았다 — 중간

- **초안**: §2.2 L62-88 — "Brain Core is passive. Runtime is active." Core는 timer·process·server·background loop를 소유하지 않고, **언제 호출할지는 Runtime이 결정한다**. §43 Do L1508("Runtime을 composition root로 사용").
- **무엇**: PRD는 수동 쪽(FR-22 "Core는 타이머, 서버, 프로세스를 소유하지 않는다")만 적었다. 능동 쪽의 주체가 없다. Glossary §3 L52가 Runtime을 한 번 부르지만 FR이 없다. 그런데 slice 1에는 능동적 결정이 이미 여럿 있다 — 언제 수집하는가(PRD §8-7, addendum §5 L94), 색인을 어느 시점에 돌리는가, 실패한 세션을 누가 다시 수집하는가(FR-5), 시작 맥락을 누가 만들어 넘기는가(FR-17). addendum §5는 그것을 전부 Claude Code hook에 얹었는데, 그러면 harness가 Runtime이 되고 "다른 harness를 붙일 때 다시 만들지 않는다"(FR-23)가 수집·재시도 경로에서는 지켜지지 않는다.
- **제안**: §4.7에 FR 하나 추가 — "Brain의 능동적 동작(수집 시점, 색인 시점, 재시도, 점검)은 Core 밖의 Runtime/host 층이 결정하고, 그 층은 harness adapter와 분리된다. harness adapter는 '이 세션의 전사를 넘긴다/시작 맥락을 받는다'만 안다." addendum §5에 hook → (harness adapter) → Runtime → SDK의 호출 방향을 한 줄로 그린다.

### F7. 규칙이 CLAUDE.md/AGENTS.md로 새면 canonical 소유가 깨진다 — 중간

- **초안**: §2.1 L39-56 — Claude memory, Codex memory는 canonical memory가 **아니다**. canonical memory와 state는 Brain이 소유한다. AI는 Brain을 쓰는 worker다.
- **무엇**: PRD는 이 원칙을 어디에도 적지 않았고, addendum §4 L76은 기록을 유도하는 수단 후보로 "AGENTS.md / CLAUDE.md에 같은 내용"을 올려 두었다("약점: 파일 관리가 Brain 밖"). 수단이 거기로 가면 "적어라"라는 **지시**만 가야 하는데, 실제로 가장 쉬운 유혹은 규칙 자체를 CLAUDE.md에 적는 것이다(사용자의 현재 글로벌 CLAUDE.md가 이미 그런 파일이다). 그러면 규칙이 harness-local 파일과 Brain에 이중으로 존재하고, FR-19·FR-21(끄기, 적용 범위 변경, 수정 이력)이 반만 동작한다.
- **제안**: §5 Cross-Cutting에 NFR 추가 — "NFR-9 단일 원천. 규칙·결정·작업 로그의 원천은 Brain뿐이다. harness의 지시 파일이나 harness 자체 기억에는 'Brain에 적어라/조회하라'라는 절차만 둘 수 있고 규칙 내용은 두지 않는다." addendum §4의 AGENTS.md 행 비고에 같은 제한을 적는다.

### F16. Decision이 Core의 독립 엔티티라는 말이 없다 — 낮음

- **초안**: §10 L495-516 — "Decision은 별도 domain entity로 둔다", "Memory에 문장 하나로 넣는 것보다 명시적인 Decision record가 필요하다". 필드는 subject / decision / reason / status / supersedes.
- **무엇**: 필드는 PRD(Glossary §3 L65, FR-20 L264-266)와 addendum 스케치에 **전부 들어 있다**(subject, text, reason, status, supersedes_id). 어긴 것은 없다. 다만 저장이 `log_entries` 한 테이블이고, PRD가 결정을 "작업 로그의 한 종류"로만 말하기 때문에, Core API에서도 결정이 로그의 부분집합으로 노출될 여지가 있다. 초안의 취지는 "결정은 1급 레코드"이고, 나중에 결정이 세션 없이(앱에서 직접, 또는 가져오기로) 생길 때 `session_id`·`message_seq` 필수 가정이 걸린다.
- **제안**: FR-20에 "결정은 Core에서 독립된 엔티티로 조회·기록된다(저장이 작업 로그와 한 테이블이어도 API는 분리)"와 "결정의 출처 세션은 선택이다(없는 결정도 기록할 수 있다)"를 추가. addendum 스케치에서 `session_id`를 nullable로 표시.

### F17. `brain init`이 CLI/setup 층이라는 경계가 없다 — 낮음

- **초안**: §35 L1244 — "대화형 setup은 SDK가 아니라 CLI/App setup layer에서 담당한다", 예시 출력에 연결 검증(`✓ Claude detected`)까지. §34 L1238 — "Brain은 설치자가 아니라 연결/검증자다".
- **무엇**: PRD FR-24는 설정 파일·점검 명령·"설치하지 않는다"를 담아 §34는 지켜졌다. 빠진 것은 §35의 층 경계다. 대화형 setup이 SDK에 들어가면 FR-22("Core는 프로세스를 소유하지 않는다")와 충돌한다.
- **제안**: FR-24 Consequences에 "대화형 초기 설정은 CLI/setup 층의 기능이고 SDK는 완성된 설정만 읽는다"를 추가.

### F18. append-only 강제와 시작 맥락 중복 제거가 요구로 적히지 않았다 — 낮음

- **초안**: §15 L627 — raw session/event history를 **append-only 형태로** 보존. §16 L677-683 — Context 조립은 Normalize → Deduplicate → Rank → Token Budget.
- **무엇**: (a) NFR-1은 "수정되지 않는다 / 고쳐 쓰거나 지우지 않는다"로 의도를 적었지만, 그것을 **구조로 보장**하라는 요구는 없다(SDK에 messages update 경로를 두지 않는다, DB 권한·트리거로 막는다 등). 사전 시험의 교훈(NFR-2)처럼 의도만으로는 새어 나간다. (b) FR-17은 크기 상한과 오래된 로그부터 빼기(Token Budget)는 담았지만 중복 제거가 없다. 같은 규칙을 두 번 말해 두 줄이 적히면 시작 맥락에 둘 다 들어간다.
- **제안**: NFR-1에 "원문 테이블에는 수정·삭제 경로를 만들지 않는다(쓰기 API는 추가뿐)"를 한 줄 추가. FR-17 Consequences에 "같은 내용의 규칙·로그가 여러 줄이어도 시작 맥락에는 한 번만 들어간다"를 추가.

---

## ② 뒤 조각에서 재설계를 강요하지 않도록 slice 1 데이터 모델이 자리를 남겨야 하는 것

(addendum §2 "저장 구조 스케치"가 실제로 막거나 억지로 끼워 넣게 되는 곳만 적었다.)

### F1. 프로젝트 없는 세션에 워크스페이스를 붙일 경로가 없다 — 높음

- **초안**: §2.3 L97-106(워크스페이스 예시에 Acme과 나란히 Keyboard, Travel, Fitness, Personal Admin), §12 L553-566(워크스페이스에 연결 가능한 엔티티 첫 줄이 **Session**), §44.4 L1612-1633(Keyboard 워크스페이스 안에 이전 대화·후보 스위치·링크·OpenLoop).
- **무엇**: addendum §2 스케치의 연결은 `workspaces ← projects.workspace_id ← worktrees ← sessions.project_id`뿐이다. 세션에서 워크스페이스로 가는 길이 **프로젝트를 반드시 지난다**. 그런데 PRD Glossary §3 L57은 "코드가 없는 묶음(Keyboard)도 된다"고 하고, UJ-6(L48)은 코드 저장소가 아닌 곳의 키보드 조사 세션이다. 그 세션은 `project_id`가 없으므로 `workspace_id`도 없고 목록에서 "기타"가 된다(FR-4 L107). 결과: PRD가 스스로 정의한 코드 없는 워크스페이스에 아무 기록도 담길 수 없고, FR-13의 "워크스페이스로 좁히기"가 Keyboard에서는 성립하지 않는다. FR-17의 "현재 프로젝트에 기록이 없으면 나 전체로 채운다"도 키보드 세션에서는 전부 코딩 로그를 넣는다(§44.5 "전에 알아보던 키보드 다시 보자"가 받쳐지지 않는다).
- **제안**: `sessions`에 `workspace_id?`를 둔다(프로젝트가 있으면 프로젝트에서 물려받고, 없으면 직접 붙는다). 어떤 수준의 꼬리표도 **독립적으로 비어 있을 수 있다**는 것을 스케치에 명시(현재 L49-50의 "전부 선택"을 join 경로까지 선택으로 만든다). 붙이는 방법은 slice 1에서 수동 한 줄이어도 된다(예: 폴더 → 워크스페이스 매핑, 또는 `brain tag`). PRD는 FR-4에 Consequence 추가 — "프로젝트가 없는 세션도 워크스페이스에 넣을 수 있고, 그 워크스페이스로 좁혀 조회된다."

### F3. Session과 Execution이 한 테이블에 섞여 있다 — 중간

- **초안**: §14 L594-619(Session은 특정 AI의 소유물이 아니다. 한 workspace 안에서 Session A=Claude, B=Codex, C=FutureAgent), §38 L1388-1410(Execution = agent/process 실행 기록. sessionId?, worker, status queued/running/completed/failed/cancelled, startedAt/finishedAt, input/result/error), §7 L419(ExecutionRepository).
- **무엇**: addendum 스케치의 `sessions`는 대화 단위와 실행 단위를 한 행에 합쳤다 — `harness`, `machine`, `started_at`, `ended_at`, `harness_session_id`는 Execution의 속성이고, `project_id`, `worktree_id`, `first_prompt`, 메시지들은 Session의 속성이다. slice 1에서는 1:1이므로 문제가 없지만, 초안이 요구하는 "한 작업 맥락에 harness가 둘"(§14, §44.2)이 오면 ① sessions를 쪼개거나 ② 같은 대화에 두 행을 만들고 messages를 갈라야 한다. 둘 다 재설계다. 더 작은 문제로, 멱등 열쇠가 `harness_session_id unique per harness`인데 Brain이 직접 띄운 실행에는 그 값이 없고(향후 Worker), 다른 기계에서 올라온 같은 harness 세션과도 구분되지 않는다(F8).
- **제안**: 테이블을 쪼개지 않아도 좋으니 **컬럼을 Execution 묶음으로 이름 짓고**(예: `exec_harness`, `exec_machine`, `exec_started_at`, `exec_ended_at`, `exec_status`) 스케치에 "이 묶음은 나중에 `executions`로 떨어져 나갈 자리"라고 적는다. `harness_session_id`를 nullable로, 멱등 열쇠를 `(harness, machine, harness_session_id)`로. `messages.session_id`는 Session 쪽에 남겨 분리 때 건드리지 않게 한다. 초안 §38의 `status`(failed/cancelled)에 해당하는 값이 slice 1에는 없는데, `ingest_status`와 혼동되지 않게 구분해 둔다.

### F4. 여러 세션·여러 harness를 묶는 작업 맥락 식별자가 없다 — 중간

- **초안**: §44.2 L1568-1580(ACME-123을 Claude로 구현하다 Codex에게 리뷰 → "동일 Context 재구성", 처음부터 다시 설명하지 않는다), §44.3 L1584-1608(핸드오프 때 Runtime이 현재 task/workspace/worktree로 context를 만든다).
- **무엇**: 스케치에서 세션을 잇는 유일한 선은 `continued_from_session_id`(단일 부모)다. PRD FR-3은 그 자리만 두고 자동으로 채우지 않는다고 했는데(§10 Assumptions), 그 선의 **의미**가 정해지지 않았다. 같은 harness의 resume인가(FR-5는 resume을 같은 세션에 메시지 추가로 처리하므로 resume은 이 선을 쓰지 않는다), 다른 에이전트로의 핸드오프인가, 아니면 그냥 "앞 세션"인가. 의미를 정하지 않고 채우기 시작하면 뒤에 셋이 섞인다. 또 `log_entries`는 `session_id`와 `project_id`만 가리키므로, "ACME-123에서 내린 결정들"은 워크트리 꼬리표로만 묶이고 워크트리가 없는 작업(개인 용무, 문서 작업)은 묶일 곳이 없다.
- **제안**: (a) `continued_from_session_id`에 `continuation_kind`(`resume | handoff | manual`)를 짝으로 두거나, 세션 간 관계를 `session_links(from, to, kind)` 작은 테이블로 뺀다. (b) `sessions`와 `log_entries`에 nullable `work_context_id`를 예약하고 스케치에 "뒤 조각의 Task가 이 자리를 채운다"고 적는다. slice 1에서는 비워 둔다. PRD는 FR-3의 [ASSUMPTION]을 "자리를 두고 의미(resume/handoff)를 구분해 둔다"로 고친다.

### F10. Execution·Resource·ExternalResourceLink가 제외 목록에도 없다 — 중간

- **초안**: §37 L1362-1376(핵심 엔티티 13종: Workspace, Session, Task, Goal, Decision, OpenLoop, Execution, Resource, Artifact, Repository, Worktree, ExternalResourceLink, Schedule), §7 L414-420(ExecutionRepository, ResourceRepository), §23 L898-916(ExternalResourceLink).
- **무엇**: PRD §6.2 제외 목록은 "Task, Goal, OpenLoop, Schedule, Artifact"만 적었다. **Execution, Resource, ExternalResourceLink**는 PRD에 등장하지도, 제외되지도 않았다. Repository는 PRD의 "프로젝트"로 흡수되었으니 괜찮다. 침묵은 뒤 단계(architecture, spec)에서 "없어도 되는 것"으로 읽히고, F3·F9의 자리도 함께 사라진다.
- **제안**: §6.2 표에 세 줄 추가 — "Execution(실행 기록) — 이후 조각. slice 1은 세션 1개 = 실행 1개로 보고, 스케치의 실행 속성 묶음이 자리(F3)", "Resource/Artifact 링크 — 이후 조각(F9)", "External Resource Link(Jira·Confluence 연결) — 이후 조각". 제외임을 적는 것만으로 충분하다.

### F11. `vector(1024)` 고정이 색인 설정 교체를 막는다 — 중간

- **초안**: §42 L1487-1495 — 임베딩은 domain이 아니라 infrastructure component이고, 미리 과도하게 추상화하지 않되 **필요해지면 별도 abstraction을 추가한다**. §4.1 L199-214 — Core는 제품 이름을 모른다.
- **무엇**: addendum 스케치는 `log_entries.embedding vector(1024)`와 `chunks.embedding vector(1024)`로 차원을 열 타입에 박았다. 동시에 `index_configs`가 `dimensions`를 데이터로 들고 있고, FR-11은 "설정이 바뀌면 옛 것을 가려낼 수 있다"를 요구한다. 차원이 다른 설정 두 개가 공존할 수 없으므로 FR-11의 "가려낸다"가 차원 변경에는 적용되지 않는다. brief 단계에서 2560 → 1024로 한 번 바꾼 전례가 있고(brief memlog), 재순위·임베딩 제공자 교체도 열린 항목이다.
- **제안**: 임베딩을 본문 테이블에서 떼어 `chunk_embeddings(chunk_id, index_config_id, embedding vector(N))` / `log_entry_embeddings(...)`로 두고, 설정이 바뀌면 새 테이블·새 인덱스를 나란히 만들고 전환한다. 또는 스케치에 "차원 변경은 재색인 + 컬럼 교체 마이그레이션"이라고 명시하고 FR-11 Consequences에 "임베딩 차원이 바뀌는 경우도 재색인으로 처리할 수 있다"를 추가한다.

### F12. `log_entries.project_id`가 꼬리표의 두 번째 진실이 된다 — 중간

- **초안**: §2.3 L121-131·§17 L706-732 — 범위는 차단이 아니라 ranking hint이고, 꼬리표는 현재 맥락(workspace/task/repository)에서 **파생**된다.
- **무엇**: PRD FR-4 L112는 "세션에서 나온 작업 로그와 조각은 그 세션의 꼬리표를 자동으로 물려받는다"고 했는데, 스케치는 `log_entries.project_id`만 복사하고 `worktree_id`·`workspace_id`는 복사하지 않았으며 `chunks`는 아무 꼬리표도 갖지 않는다. 결과가 셋이다. (a) 꼬리표 조회가 로그는 복사본, 조각은 join으로 서로 다른 경로를 탄다. (b) 프로젝트를 워크스페이스로 묶거나 저장소 정체성을 고치면 `sessions.project_id`와 `log_entries.project_id`가 어긋날 수 있다. (c) FR-13의 "워크트리 안에서 → 프로젝트 → 워크스페이스 → 나 전체로 넓어진다"를 로그에 적용할 때 워크트리 단계가 복사본에 없다.
- **제안**: 하나로 고른다. 권장은 **파생 금지** — 꼬리표는 항상 `session_id` join으로만 얻고 `log_entries.project_id`는 지운다(로그가 세션 없이 생길 수 있게 하려면 F16과 함께 nullable 복사본을 쓰되 "출처가 있으면 세션이 진실"이라고 못박는다). 조각도 같은 규칙. addendum §2 L50-51에 그 규칙을 한 줄로 적는다.

### F8·F9는 아래 ③·④에 함께 적었다(모순/의도 누락이 주된 성격).

---

## ③ 기록된 결정 없이 초안과 어긋나는 곳

### F8. "여러 기계 배제"가 brief의 결정을 뒤집었는데 기록이 없다 — 중간

- **초안**: §44.9 L1744-1756 — canonical Brain Runtime 하나를 기준으로 Second Mac / Home Mac / Mobile에서 같은 state를 본다.
- **무엇**: brief 단계의 기록은 "실행 환경 집 Mac mini 단일 머신, **두 번째 Mac은 Tailscale로 밀어 넣기**"였다(`../brief-personal-brain/.memlog.md` L14). PRD §9는 "실행 환경은 내 Mac 한 대(운영은 집 Mac mini). 여러 기계는 다루지 않는다"로, §6.2는 "다중 사용자, 인증, **여러 기계 동기화** — 배제"로 적었다. 두 번째 Mac에서 한 Claude Code 세션을 밀어 넣는 부분이 사라졌는데 slice 1 memlog에는 그 철회가 없다. 한편 addendum 스케치는 `sessions.machine`을 들고 있어 모델은 이미 두 기계를 전제한다. 실사용에 영향도 있다 — 두 번째 Mac 세션이 수집되지 않으면 SM-5(수집 누락 0)와 SM-1(이어가기)의 모집단이 조용히 달라진다.
- **제안**: 둘 중 하나를 기록으로 남긴다. (a) 유지: §9에 "slice 1의 수집은 한 대에서만. 두 번째 Mac의 세션은 slice 1에서 수집하지 않으며 SM-5의 분모에서 제외한다"를 적고 §6.2의 "여러 기계 동기화"를 "여러 Runtime 동기화"로 좁혀 `machine` 컬럼과의 모순을 없앤다. (b) 되살림: "두 번째 Mac → (Tailscale) → 집 Postgres로 수집만 보낸다"를 §6.2에서 빼고, 멱등 열쇠에 machine을 넣는다(F3). 어느 쪽이든 `.memlog.md`에 한 줄.

### 그 밖에 확인한 모순은 모두 기록이 있었다

- 메모리 백엔드 Supermemory → Postgres+pgvector, 추출·통합 엔진 제외, Brain의 LLM 호출 0: brief memlog L26·L29, slice-1 memlog L13.
- 워크트리를 universal concept으로 올린 것(초안 §13 L586은 "universal일 필요 없다"): slice-1 memlog L19("수준 확정(사용자)")에 기록됨.
- 결정·규칙을 작업 로그의 종류로 합친 것(초안 §10 "별도 domain entity"): slice-1 memlog L13 override에 기록됨(잔여 사항은 F16).
- 세션 요약·추출 후보 확인 흐름 제거: slice-1 memlog L11·L13, addendum §7.
- 매 프롬프트 주입 → 세션 시작만: slice-1 memlog L7, addendum §7.
- harness 원본 파일·도구 출력 미보관(초안 §15의 raw event 범위 축소): brief memlog L30.

---

## ④ §44 사용 시나리오와 §49 최종 목표의 질적 의도 중 UJ·SM이 놓친 것

### F13. harness 중립성을 확인하는 수단이 없다 — 중간

- **초안**: §49 L2038("나는 어떤 AI를 쓰는지 신경 쓰지 않고"), §44.10 L1760-1792(Claude → Codex → 미래 Agent로 바뀌어도 Memory·Decisions·Sessions·Resources는 그대로), §2.1 L31.
- **무엇**: PRD Vision L18이 "어떤 에이전트를 쓰는지는 상관없다"를 선언하고 FR-23 L297이 "도구는 특정 Harness에 묶이지 않는 형태로 제공된다. 다른 Harness를 붙일 때 도구를 다시 만들지 않는다"를 요구하지만, **확인 가능한 결과가 없다**. 수집 경로가 Claude Code 하나이므로 2주 실사용으로는 검증되지 않고, SM에도 없다. 초안의 핵심 약속이 slice 1에서 측정 없이 지나간다. 특히 addendum §5의 변환 규칙·세션 ID 전달·hook 구조가 전부 Claude Code 어휘라, 중립성이 실제로 어디까지인지 아무도 확인하지 않는다.
- **제안**: 비용이 들지 않는 검수 한 건을 SM 또는 수용 기준에 넣는다 — "slice 1 종료 시, Codex(또는 OpenCode) adapter를 추가한다고 가정하고 스키마·도구 서명 중 바꿔야 하는 것을 목록으로 적는다. 목록이 adapter 코드 밖으로 나가면(스키마 변경, 도구 재작성) FR-23 미달로 본다." FR-23 Consequences에 "Claude Code 고유 값은 `harness`, `harness_session_id`, metadata jsonb 안에만 있다"를 테스트 가능한 형태로 추가.

### F14. "다른 에이전트가 이어받는다"가 UJ·SM에서 빠졌다 — 중간

- **초안**: §44.2 L1568-1580("Codex에게 처음부터 다시 설명하지 않는다"), §44.3 L1584-1608(핸드오프), §14 L611-619(Claude로 조사 → Codex로 리뷰 → Claude로 수정이 하나의 작업 맥락).
- **무엇**: 핸드오프 기능은 제외가 맞다. 하지만 그 시나리오의 **질적 요구** — 기록이 "그 세션의 나"가 아니라 **아무것도 모르는 다른 읽는 이**에게 충분해야 한다 — 는 slice 1의 작업 로그 품질에 바로 걸린다. PRD의 UJ-1과 SM-1은 "다음 날 같은 폴더에서 같은 harness로"만 본다. SM-4는 로그가 적혔는지와 결정이 빠졌는지만 센다. 로그 한 줄이 제3자에게 복원 가능한가는 아무 지표도 보지 않는다. 그런데 이것이 뒤 조각 전체의 전제다.
- **제안**: SM-4에 질적 항목 한 줄 추가(비용 0) — "주 1회 세션 3개를 뽑을 때, 그 세션의 작업 로그 + 시작 맥락만 보고 '내가 아닌 다른 에이전트가 이어서 일할 수 있는가'를 함께 채점한다. 목표를 두지 않고 기록만 한다." UJ에도 한 줄 — UJ-1 Edge에 "같은 작업을 다음 세션에서 다른 모델로 열어도 같은 시작 맥락을 받는다"를 넣으면 FR-17의 harness 비의존이 UJ 수준에서 드러난다.

### F9. "그 문서가 어디 있었는지"를 받치는 FR이 없다 — 중간

- **초안**: §19 L781-796(Local File, Drive, Confluence, Notion, Git repo, Web page, Email, PDF, Issue, PR을 같은 Resource 개념으로), §1 L24("어떤 자료를 봤는지"), §44.4 L1629-1633(Keyboard 워크스페이스의 "관련 영상/링크", "구매 후보"), §44.6 L1696-1701(정책 문서는 Confluence/Resource에서).
- **무엇**: PRD JTBD §2.1 L33은 "예전에 왜 그렇게 결정했는지, **그 문서가 어디 있었는지** 찾고 싶다"를 그대로 적어 두었는데, 이를 받치는 FR이 없다. 실제로 가능한 것은 (a) 도구 메모의 파일 경로(FR-2, 로컬 파일만), (b) 대화 원문에 URL이 적혀 있었다면 조각 검색으로 걸리는 것뿐이다. UJ-6의 키보드 링크·영상도 같다. Resource가 제외 목록에도 없어서(F10) 이 JTBD는 받쳐지지도, 제외되지도 않은 상태다.
- **제안**: 둘 중 하나. (a) JTBD를 slice 1 수준으로 낮춘다 — "그 문서가 어디 있었는지(대화에 적혀 있었던 경로·링크를 원문에서 되찾는 정도)". 그리고 FR-15(넓히기) 또는 FR-14에 Consequence 한 줄 — "대화에 등장한 경로·URL은 원문 검색으로 되찾을 수 있다." (b) 최소 자리만 둔다 — `log_entries`에 `refs text[]`(경로·URL 목록)를 두어 에이전트가 로그를 적을 때 근거 문서를 함께 적게 하고, 뒤 조각의 Resource가 그 자리를 채우게 한다. 어느 쪽이든 §6.2에 "Resource/Artifact 링크 — 이후 조각"을 적는다.

### F15. "내가 도구 이름을 말하지 않는다"가 지표에 없다 — 낮음

- **초안**: §44.5 L1668-1676 — 나는 "Supermemory 검색해", "brain_context 불러와"라고 **말하지 않는다**. §28 L1051-1072 — MCP만 두면 recall 누락, 불필요한 호출, 모델별 query 품질 차이, agent마다 다른 behavior가 생긴다.
- **무엇**: PRD는 세션 시작 주입만 결정적으로 하고 그 뒤는 에이전트의 판단에 맡겼다(FR-18, §8-8). 그 자체는 기록된 결정이다. 다만 초안이 꼽은 실패 양상과 "내가 도구를 지목하지 않는다"는 요구가 지표에 없다. SM-1은 "이어서 일했는지"만 보므로, 내가 매번 "brain에서 찾아봐"라고 말해서 성공한 경우와 에이전트가 알아서 조회한 경우가 구분되지 않는다. §8-8의 판단 근거가 그만큼 약해진다.
- **제안**: 반대지표 한 줄 추가 — "SM-C4 명시 지목 횟수. 내가 Brain·도구 이름을 직접 말해야 조회가 일어난 횟수. SM-1을 올리려고 이 수를 늘리지 않는다." SM-1 기록 양식에 "자발 / 내가 지목" 구분 한 칸을 둔다. §8-8의 결론을 이 수로 내린다.

### 그 밖에 §44·§49에서 확인한 것

- §44.1(여러 프로젝트 동시 작업, memory는 global): PRD FR-4·FR-12·NFR-8이 받친다.
- §44.4(개발 아닌 워크스페이스), §44.5(전에 하던 조사 이어가기): 의도는 UJ-6에 들어왔지만 저장 구조가 막는다 → F1.
- §44.6(결정의 이유 조회): UJ-3이 받친다. Graphify·Confluence 부분은 의도된 제외.
- §44.7·§44.8(UI와 agent의 integration 공유, 터미널 직접 사용): 제외 범위. §44.8의 "터미널에서 직접 claude를 실행해도 같은 Brain"은 slice 1이 오히려 기본 경로로 삼았다.
- §44.9: F8.
- §45 V1 필수 목록 중 slice 1에 해당하는 "Session recording", "Automatic context injection"은 FR-1·FR-17로 들어왔다.
