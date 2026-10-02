# Personal Brain — Final Architecture

## 1. 문서 목적

이 문서는 내가 만들고자 하는 **Personal Brain**의 최종 아키텍처와 구현 방향을 정의한다.

이 시스템의 목적은 단순한 장기 기억형 챗봇이 아니다.

내가 원하는 것은:

> **어떤 AI 모델을 쓰든, 어떤 agent/harness를 쓰든, 어떤 클라이언트에서 접근하든 동일한 기억·상태·작업 맥락을 유지하는 개인용 Brain 시스템**

이다.

현재는 Claude Code, Codex, Orca, Paseo 등을 사용하지만, 이들은 영구적인 전제가 아니다.

중요한 것은 도구가 바뀌어도 아래 정보가 유지되는 것이다.

- 내가 누구인지
- 내가 무엇을 선호하는지
- 어떤 결정을 했는지
- 어떤 작업을 진행 중인지
- 어떤 자료를 봤는지
- 어떤 프로젝트를 다루고 있는지
- 어떤 task가 남아 있는지
- 이전 agent와 어떤 맥락에서 작업했는지
- 어떤 결과물과 artifact가 만들어졌는지

핵심 원칙:

> **AI와 Harness는 교체 가능하지만, Brain은 지속된다.**

---

# 2. 가장 중요한 설계 원칙

## 2.1 Brain은 특정 AI의 기능이 아니다

다음은 canonical memory가 아니다.

```text
Claude memory
Codex memory
Gemini memory
Orca session memory
Paseo session memory
```

canonical memory와 state는 Brain이 소유한다.

```text
Claude ─┐
Codex  ─┼──► same Brain
Gemini ─┤
Future ─┘
```

AI는 Brain을 사용하는 worker다.

---

## 2.2 Brain Core는 passive하다

Brain Core는 daemon도 아니고 scheduler도 아니다.

Core 자체는:

- timer를 돌리지 않는다.
- process를 spawn하지 않는다.
- HTTP server를 열지 않는다.
- background loop를 소유하지 않는다.

Core는 단지 기능을 제공한다.

```ts
brain.memory.recall(...)
brain.context.build(...)
brain.tasks.create(...)
brain.sessions.append(...)
brain.decisions.record(...)
```

언제 호출할지는 Runtime이 결정한다.

핵심 원칙:

> **Brain Core is passive. Runtime is active.**

---

## 2.3 Workspace는 Memory Boundary가 아니다

Workspace는 내가 보기 좋게 작업과 자료를 묶기 위한 organizational concept다.

예:

```text
Acme
SideShop
Personal Brain
Keyboard
Travel
Fitness
Personal Admin
```

Workspace마다 별도 memory를 갖지 않는다.

```text
Workspace A
Workspace B
Terminal Agent
Desktop App
Mobile App

        ↓

same global Brain memory
```

Workspace는 Context Engine에서 relevance hint로 사용할 수 있다.

예:

```text
현재 Workspace = Acme

→ Acme 관련 session/resource/project knowledge에 가중치
```

하지만 다른 workspace의 기억을 차단하지 않는다.

---

# 3. 전체 시스템 구조

```text
┌────────────────────────────────────────────────────────────┐
│                       Brain Clients                        │
│                                                            │
│  Desktop App     Mobile App      CLI      MCP Clients      │
│  Paseo-like UI                  Tools    Claude/Codex etc. │
└────────────────────────────┬───────────────────────────────┘
                             │
                       RPC / WS / SDK
                             │
┌────────────────────────────▼───────────────────────────────┐
│                       Brain Runtime                        │
│                  Composition / Execution                   │
│                                                            │
│  - Core 초기화                                             │
│  - Agent execution                                         │
│  - Context injection                                       │
│  - Session lifecycle                                       │
│  - Worktree / terminal                                     │
│  - External integrations                                   │
└───────────────┬───────────────────────┬────────────────────┘
                │                       │
                ▼                       ▼
┌──────────────────────────┐   ┌─────────────────────────────┐
│        Brain Core        │   │       Infrastructure        │
│                          │   │                             │
│ Memory                   │◄──│ Supermemory adapter         │
│ Context Engine           │◄──│ Graphify adapter            │
│ Workspace                │◄──│ PostgreSQL repositories     │
│ Sessions                 │◄──│ Claude/Codex workers        │
│ Tasks                    │   │ Jira/Linear integrations    │
│ Decisions                │   │ Confluence/Drive adapters   │
│ Resources                │   │ Local filesystem            │
│ Executions               │   │                             │
│ Ports / Contracts        │   │                             │
└──────────────────────────┘   └─────────────────────────────┘
```

---

# 4. 레이어 정의

## 4.1 Brain Core

Brain Core는 제품에 독립적인 domain/application logic이다.

Core가 알아야 하는 것:

```text
Memory
Workspace
Session
Task
Goal
Decision
OpenLoop
Resource
Artifact
Execution
Context
```

Core가 몰라야 하는 것:

```text
Supermemory
Graphify
PostgreSQL
Claude
Codex
Jira
Linear
Confluence
Electron
Paseo
Orca
MCP
```

---

## 4.2 Infrastructure

Infrastructure는 실제 외부 시스템과 연결하는 코드다.

V1 예:

```text
Memory
└ SupermemoryMemoryProvider

Knowledge
└ GraphifyKnowledgeProvider

Database
├ PostgresTaskRepository
├ PostgresSessionRepository
├ PostgresDecisionRepository
├ PostgresWorkspaceRepository
└ ...

Workers
├ ClaudeCodeWorker
└ CodexWorker
```

---

## 4.3 Brain Runtime

Runtime은 Core와 Infrastructure를 조립한다.

예:

```ts
const repositories = createPostgresRepositories(config.database);

const memory = new SupermemoryMemoryProvider(
  config.memory,
);

const knowledge = new GraphifyKnowledgeProvider(
  config.knowledge,
);

const workers = {
  claude: new ClaudeCodeWorker(config.workers.claude),
  codex: new CodexWorker(config.workers.codex),
};

const brain = createBrain({
  repositories,
  memory,
  knowledge,
  workers,
});
```

이 composition은 의도적인 것이다.

V1에서는 모든 provider를 동적으로 추가하는 plugin system을 만들지 않는다.

---

# 5. SDK 중심 설계

Brain의 핵심 public API는 SDK다.

```ts
const brain = await createBrain(config);

await brain.memory.recall(...);
await brain.context.build(...);
await brain.tasks.create(...);
await brain.sessions.create(...);
await brain.decisions.record(...);

await brain.close();
```

SDK를 사용하는 host는 자유롭다.

```text
Brain Runtime
CLI
Test Runner
Future Server
MCP Adapter
Desktop backend
```

MCP나 Desktop App은 Brain 자체가 아니다.

그들은 SDK/Core를 사용하는 interface다.

---

# 6. Provider 전략

## 6.1 V1에서는 동적 plugin system을 만들지 않는다

현재 목표:

```text
Provider abstraction         ✅
Explicit composition         ✅
Dynamic plugin marketplace   ❌
GitHub auto-install          ❌
Agent-generated provider     ❌
```

처음부터 모든 memory/knowledge 제품을 지원하려고 하지 않는다.

V1에서는 내가 실제로 사용할 것만 구현한다.

```text
Storage       PostgreSQL
Memory        Supermemory
Knowledge     Graphify
Workers       Claude Code / Codex
```

---

## 6.2 Provider abstraction은 유지한다

동적 plugin system을 만들지 않아도 abstraction은 필요하다.

이유:

1. Core가 외부 제품 API에 종속되지 않게 한다.
2. 나중에 실제로 교체할 필요가 생겼을 때 Core를 수정하지 않게 한다.

Memory 예:

```ts
interface MemoryProvider {
  remember(input: RememberInput): Promise<MemoryRecord>;
  recall(input: RecallInput): Promise<MemoryResult[]>;
  forget(input: ForgetInput): Promise<void>;
}
```

Knowledge 예:

```ts
interface KnowledgeProvider {
  search(input: KnowledgeQuery): Promise<KnowledgeResult[]>;
}
```

Worker 예:

```ts
interface Worker {
  run(input: WorkerRequest): Promise<WorkerResult>;
}
```

---

## 6.3 새 Provider는 필요할 때 추가한다

예:

```text
현재 Memory = Supermemory

나중:
"Hindsight를 실제로 써보고 싶다."

→ HindsightMemoryProvider 구현
→ MemoryProvider contract 구현
→ Runtime composition/config 변경
```

이 정도 Runtime 변경은 허용한다.

목표는:

> Brain 전체를 외부 제품 변경 때문에 다시 설계하지 않는 것

이지:

> Runtime source도 영원히 한 줄도 변경하지 않는 것

이 아니다.

---

# 7. PostgreSQL의 위치

PostgreSQL은 일반 Provider보다는 domain repository implementation으로 보는 것이 자연스럽다.

Core:

```ts
interface WorkspaceRepository {}
interface SessionRepository {}
interface TaskRepository {}
interface DecisionRepository {}
interface ExecutionRepository {}
interface ResourceRepository {}
```

Infrastructure:

```text
PostgresWorkspaceRepository
PostgresSessionRepository
PostgresTaskRepository
PostgresDecisionRepository
PostgresExecutionRepository
PostgresResourceRepository
```

PostgreSQL은 canonical structured state를 저장한다.

---

# 8. Long-term Memory

V1 memory backend는 Supermemory를 사용한다.

역할:

```text
durable preference
historical fact
important episode
personal context
recurring preference
long-term relationship/context
```

예:

```text
"나는 로우피치 키보드를 선호한다."
"U4T 정도 키압은 부담되지만 허용 가능하다."
"코드 리뷰 후 바로 수정하지 말고 계획부터 세우는 방식을 선호한다."
```

Memory는 Task DB의 대체재가 아니다.

---

# 9. Structured State

정확성이 필요한 정보는 PostgreSQL에 저장한다.

예:

```text
Task
Goal
Schedule
Session
Execution
Decision
OpenLoop
Workspace
Artifact
Resource metadata
```

예를 들어:

```text
"다음 주 금요일까지 문서를 제출해야 한다."
```

는 단순 semantic memory가 아니라 Task/Schedule로 관리해야 한다.

---

# 10. Decision

Decision은 별도 domain entity로 둔다.

예:

```text
subject:
Personal Brain architecture

decision:
Brain Core / Runtime 분리

reason:
AI/harness/runtime 독립성 확보

status:
ACTIVE

supersedes:
previousDecisionId
```

Memory에 문장 하나로 넣는 것보다 명시적인 Decision record가 필요하다.

---

# 11. OpenLoop

OpenLoop는 아직 task로 확정되지 않은 unresolved thought다.

예:

```text
Graphify와 CodeGraph를 둘 다 쓸 가치가 있는가?
Personal Brain mobile auth는 어떻게 할 것인가?
Supermemory를 장기적으로 유지할 것인가?
```

모든 미해결 생각을 Task로 바꾸지는 않는다.

---

# 12. Workspace

Workspace는 organization 단위다.

예:

```ts
type Workspace = {
  id: string;
  name: string;
  type?: string;
  parentId?: string;
  status: 'active' | 'archived';
  metadata?: Record<string, unknown>;
};
```

Workspace와 연결 가능한 entity:

```text
Session
Task
Resource
Artifact
Execution
Goal
OpenLoop
Repository
Worktree
External Resource Link
```

Memory 자체는 global이다.

---

# 13. 개발 Workspace와 Worktree

Software workspace는 repository/worktree를 가질 수 있다.

```text
Acme
├ acme-api
│  ├ main
│  ├ ACME-123 worktree
│  └ ACME-456 worktree
├ acme-member
└ acme-auth
```

Worktree는 Brain의 universal concept일 필요는 없다.

Software workspace의 execution environment 중 하나로 다룬다.

---

# 14. Session

Session은 특정 AI의 소유물이 아니다.

```text
Workspace: Personal Brain

Session A
  worker: Claude

Session B
  worker: Codex

Session C
  worker: FutureAgent
```

Brain이 session state/history를 소유한다.

따라서:

```text
Claude로 조사
→ Codex로 리뷰
→ Claude로 수정
```

해도 하나의 작업 맥락을 이어갈 수 있어야 한다.

---

# 15. Raw Event / Transcript 보존

Memory engine만 믿지 않는다.

Raw session/event history를 append-only 형태로 보존한다.

```text
Session
  ↓
Raw Events / Transcript
  ↓
Memory extraction
Decision extraction
Task extraction
Artifact registration
```

이유:

- memory backend 교체
- memory 재생성
- 디버깅
- 감사
- 과거 맥락 재구성

에 필요하기 때문이다.

---

# 16. Context Engine

Context Engine은 이 프로젝트에서 가장 중요한 핵심 기능 중 하나다.

목표:

> 어떤 AI를 사용하더라도 현재 작업에 필요한 동일한 Brain context를 제공한다.

기본 흐름:

```text
User Input
    ↓
Context Planner
    ↓
┌──────────────────────────┐
│ Structured Brain State   │
│ Long-term Memory         │
│ Recent Sessions          │
│ Decisions                │
│ Tasks / OpenLoops        │
│ Resources                │
│ Project Knowledge        │
└──────────────────────────┘
    ↓
Normalize
    ↓
Deduplicate
    ↓
Rank
    ↓
Token Budget
    ↓
BrainContext
```

예상 타입:

```ts
type BrainContext = {
  memories: MemoryRecord[];
  decisions: Decision[];
  tasks: Task[];
  openLoops: OpenLoop[];
  resources: Resource[];
  sessions: SessionSummary[];
  projectKnowledge: KnowledgeResult[];
};
```

---

# 17. Workspace와 Context Engine

Workspace는 memory filter가 아니다.

Context ranking hint다.

예:

```text
현재 Workspace = Acme
현재 Task = ACME-123
현재 Repository = acme-auth
```

이면:

```text
Global memory
+
Acme 관련 decisions
+
ACME-123 recent sessions
+
acme-auth Graphify knowledge
+
관련 Confluence/Jira resource
```

가 우선될 수 있다.

---

# 18. Graphify의 역할

Graphify는 Memory가 아니다.

역할:

> **Project / Repository Knowledge Provider**

입력:

```text
Code
Repository structure
Architecture docs
Specs
Schema
Config
Relationships
```

출력:

```text
symbols
relationships
dependencies
project knowledge
```

Context Engine은 필요할 때만 Graphify를 호출한다.

예:

```text
"전에 어떤 키보드를 좋아한다고 했지?"
→ Graphify 불필요

"passkey recovery가 현재 어떤 모듈에 연결돼 있지?"
→ Graphify 유용
```

---

# 19. Resource Layer

Brain은 다양한 외부 자료를 동일한 Resource 개념으로 다룬다.

예:

```text
Local File
Google Drive
Confluence
Notion
Git repository
Web page
Email
PDF
Issue
Pull Request
```

Core:

```ts
interface ResourceProvider {
  search(...): Promise<ResourceSearchResult[]>;
  read(...): Promise<ResourceContent>;
}
```

다만 V1에서는 필요한 provider부터 순차 구현한다.

---

# 20. External Integration Layer

Jira, Linear, Confluence 같은 서비스는 단순 MCP integration으로 만들지 않는다.

핵심 원칙:

> **Integration Service가 원본이고, Frontend와 MCP가 동일 integration을 사용한다.**

구조:

```text
                    Brain Runtime
                         │
                 Integration Layer
                         │
        ┌────────────────┼────────────────┐
        ▼                ▼                ▼
      Jira             Linear         Confluence
        │                │                │
        └────────────────┼────────────────┘
                         │
                normalized domain
                         │
            ┌────────────┴────────────┐
            ▼                         ▼
        Frontend                     MCP
```

이렇게 해야:

- 내가 UI에서 Jira를 본다.
- Claude가 Jira를 읽는다.
- Codex가 Jira를 수정한다.
- Brain Context Engine이 Jira issue를 참고한다.

를 한 번의 integration 구현으로 해결할 수 있다.

---

# 21. Work Item Integration

Jira / Linear / GitHub Issues 등은 공통 WorkItem abstraction을 둘 수 있다.

```ts
interface WorkItemProvider {
  list(input: ListWorkItemsInput): Promise<WorkItem[]>;
  get(id: string): Promise<WorkItem>;
  search(query: string): Promise<WorkItem[]>;
  update(input: UpdateWorkItemInput): Promise<void>;
  comment(input: CommentInput): Promise<void>;
}
```

구현:

```text
JiraWorkItemProvider
LinearWorkItemProvider
GitHubIssueProvider
```

---

# 22. Document Integration

Confluence, Google Drive, Notion 등은 Document/Resource abstraction을 사용한다.

```ts
interface DocumentProvider {
  search(...): Promise<DocumentResult[]>;
  get(...): Promise<Document>;
  listChildren(...): Promise<Document[]>;
  create(...): Promise<Document>;
  update(...): Promise<Document>;
}
```

구현 예:

```text
ConfluenceDocumentProvider
GoogleDriveDocumentProvider
NotionDocumentProvider
```

---

# 23. External Resource Link

Workspace는 Jira/Confluence 등과 연결될 수 있다.

```ts
type ExternalResourceLink = {
  workspaceId: string;
  provider: string;
  externalId: string;
  type:
    | 'issue'
    | 'document'
    | 'pull-request'
    | 'project'
    | 'repository';
};
```

외부 서비스가 Workspace의 정체성을 결정하지는 않는다.

---

# 24. Worker / Agent Execution

Core는 Claude나 Codex를 직접 알지 않는다.

```ts
interface Worker {
  run(input: WorkerRequest): Promise<WorkerResult>;
}
```

V1:

```text
ClaudeCodeWorker
CodexWorker
```

실제 구현은:

- process spawn
- PTY
- stdin/stdout
- lifecycle
- cancellation
- result capture

등을 처리한다.

---

# 25. Brain App의 역할

Brain App은 first-party client/harness다.

Brain 자체는 아니다.

Brain App이 agent execution을 소유하면 다음을 자동화할 수 있다.

```text
어떤 context를 넣을지
어떤 worker를 실행할지
어떤 cwd/worktree에서 실행할지
어떤 integration을 제공할지
session을 어떻게 기록할지
결과를 어디에 저장할지
```

---

# 26. Turn Lifecycle

Brain App에서 agent 실행은 다음 lifecycle을 따른다.

## Before Turn

```text
User Input
  ↓
Brain Context Engine
  ↓
Relevant Context
  ↓
Agent Prompt
```

이 부분은 agent가 MCP 호출 여부를 판단하게 두지 않는다.

앱이 deterministic하게 수행한다.

---

## During Turn

작업 중 agent가 추가 정보나 action이 필요하면 Brain MCP 또는 tool interface를 사용할 수 있다.

예:

```text
resource_search
task_create
schedule_create
memory_remember
work_item_get
document_search
```

---

## After Turn

```text
Agent Result
  ↓
Session/Event append
  ↓
Artifact registration
  ↓
Decision/Task candidates
  ↓
Memory consolidation
```

---

# 27. MCP의 위치

MCP는 Brain의 중심이 아니다.

MCP는:

> **Brain App 밖의 agent가 Brain에 접근하기 위한 adapter**

다.

```text
Claude Code
Codex CLI
Future Agent
      │
      │ MCP
      ▼
Brain Runtime
      │
      ▼
Brain SDK/Core
```

따라서 SDK/Core가 안정화된 뒤 얇게 추가할 수 있다.

---

# 28. 왜 MCP-only로 만들지 않는가

MCP만 제공하면 agent가 매번:

```text
Brain을 조회해야 하나?
어떤 tool을 호출해야 하나?
```

를 판단해야 한다.

문제:

- recall 누락
- 불필요한 호출
- 모델별 query 품질 차이
- agent마다 다른 behavior

First-party Brain App에서는 자동 Context Injection을 기본으로 한다.

MCP는 on-demand access 용도다.

---

# 29. Desktop App 전략

Desktop App은 완전히 새 UX를 처음부터 발명하기보다:

> **Paseo의 chat/client UX + Orca의 실행 기능**

을 조합하는 방향으로 간다.

단, 두 코드베이스를 무작정 합치지 않는다.

Brain의 domain과 Runtime은 별도로 유지한다.

---

# 30. Paseo에서 가져올 방향

Paseo 쪽에서 참고/재사용할 영역:

```text
Chat UX
Workspace navigation
Sidebar
Session presentation
Desktop ↔ Runtime communication pattern
Responsive layout
Desktop/Mobile 공통 client 구조
Settings UX
```

Paseo는 Brain App의 **제품 shell / client UX reference** 역할을 한다.

---

# 31. Orca에서 가져올 방향

Orca 쪽에서 참고/재사용할 영역:

```text
Git worktree lifecycle
Terminal / PTY
Terminal split / persistence
Agent process lifecycle
Claude / Codex launcher
Git state
Diff / review UI
Remote execution / SSH
Multi-repo execution patterns
Agent handoff / orchestration patterns
```

Orca는 Brain App의 **execution capability donor/reference** 역할을 한다.

Orca의 domain model 자체를 Brain의 canonical model로 가져오지는 않는다.

---

# 32. 최종 Desktop 구조

```text
┌────────────────────────────────────────────┐
│                Brain Client                │
│                                            │
│       Paseo-like Chat / Workspace UX       │
└─────────────────────┬──────────────────────┘
                      │
                   RPC / WS
                      │
┌─────────────────────▼──────────────────────┐
│                Brain Runtime               │
│                                            │
│  Brain Core                                │
│  ├ Memory                                  │
│  ├ Context                                 │
│  ├ Workspace                               │
│  ├ Tasks                                   │
│  ├ Sessions                                │
│  └ Decisions                               │
│                                            │
│  Execution Capabilities                    │
│  ├ Worktree       ← Orca patterns/code     │
│  ├ Terminal       ← Orca patterns/code     │
│  ├ Git            ← Orca patterns/code     │
│  ├ Claude                                  │
│  ├ Codex                                   │
│  └ Remote                                  │
│                                            │
│  Integrations                              │
│  ├ Jira                                    │
│  ├ Linear                                  │
│  ├ Confluence                              │
│  ├ GitHub                                  │
│  └ Bitbucket                               │
└─────────────────────┬──────────────────────┘
                      │
        ┌─────────────┼─────────────┐
        ▼             ▼             ▼
   PostgreSQL     Supermemory    Graphify
```

---

# 33. Desktop과 Mobile

Desktop과 Mobile은 별개의 Brain을 갖지 않는다.

```text
Canonical Brain Runtime
        │
   ┌────┴────┐
   ▼         ▼
Desktop    Mobile
```

공유 가능한 것:

```text
client protocol
state model
session model
workspace model
UI logic
API client
```

Desktop-specific:

```text
PTY
filesystem
worktree
multi-window
keyboard shortcut
local agent process
```

Mobile-specific:

```text
push
camera
voice
compact navigation
remote control
```

Mobile은 Claude/Codex CLI를 직접 실행하는 장치가 아니라 중앙 Brain Runtime의 client가 된다.

---

# 34. 외부 Dependency 설치 정책

V1에서는 Brain이 외부 dependency를 자동 설치하지 않는다.

내가 직접 준비한다.

```text
PostgreSQL
Supermemory
Graphify
Claude Code
Codex
```

Brain은 설치자가 아니라 연결/검증자다.

---

# 35. brain init

대화형 setup은 SDK가 아니라 CLI/App setup layer에서 담당한다.

```text
brain init
```

예:

```text
Database
PostgreSQL URL:
> postgres://...

Memory
Supermemory endpoint:
> http://localhost:...

Knowledge
Graphify command/path:
> ...

Workers
✓ Claude detected
✓ Codex detected
```

결과:

```yaml
database:
  url: postgres://...

memory:
  provider: supermemory
  endpoint: http://localhost:...

knowledge:
  provider: graphify
  command: /path/to/graphify

workers:
  claude:
    command: claude
  codex:
    command: codex
```

Runtime은 이 config를 사용해 명시적으로 조립한다.

---

# 36. 예상 Repository 구조

초기에는 과도하게 패키지를 분리하지 않는다.

```text
personal-brain/
├ packages/
│  ├ core/
│  │  ├ memory/
│  │  ├ context/
│  │  ├ workspace/
│  │  ├ sessions/
│  │  ├ tasks/
│  │  ├ decisions/
│  │  ├ resources/
│  │  ├ executions/
│  │  └ ports/
│  │
│  ├ sdk/
│  │  ├ createBrain.ts
│  │  └ config.ts
│  │
│  ├ runtime/
│  │  ├ composition/
│  │  ├ agent/
│  │  ├ terminal/
│  │  ├ worktree/
│  │  ├ git/
│  │  └ protocol/
│  │
│  └ infrastructure/
│     ├ database/
│     │  └ postgres/
│     ├ memory/
│     │  └ supermemory/
│     ├ knowledge/
│     │  └ graphify/
│     ├ workers/
│     │  ├ claude/
│     │  └ codex/
│     └ integrations/
│        ├ jira/
│        ├ linear/
│        ├ confluence/
│        ├ github/
│        └ bitbucket/
│
├ apps/
│  ├ desktop/
│  ├ mobile/
│  └ cli/
│
└ docs/
```

MCP는 필요해지는 시점에 추가한다.

```text
packages/mcp/
```

---

# 37. 핵심 Domain Entity

V1에서 고려할 핵심 entity:

```text
Workspace
Session
Task
Goal
Decision
OpenLoop
Execution
Resource
Artifact
Repository
Worktree
ExternalResourceLink
Schedule
```

Memory 자체의 실제 storage는 Supermemory가 담당하지만 Brain은 필요한 metadata/reference를 가질 수 있다.

---

# 38. Execution

Execution은 agent/process 실행 기록이다.

예:

```ts
type Execution = {
  id: string;
  sessionId?: string;
  taskId?: string;
  workspaceId?: string;

  worker: string;

  status:
    | 'queued'
    | 'running'
    | 'completed'
    | 'failed'
    | 'cancelled';

  startedAt?: Date;
  finishedAt?: Date;

  input?: unknown;
  result?: unknown;
  error?: unknown;
};
```

---

# 39. Task와 Goal

Task:

> 실제로 수행할 actionable unit

Goal:

> 더 장기적인 desired state

예:

```text
Goal
Personal Brain V1을 실사용 가능하게 만든다.

Tasks
- Core domain 정의
- Supermemory adapter 구현
- Graphify adapter 구현
- Desktop chat shell 구현
```

---

# 40. Schedule

Schedule은 structured state로 저장한다.

하지만 Core가 시간 루프를 돌리지는 않는다.

```text
Schedule Entity
     ↓
Runtime
     ↓
timer / cron / queue / scheduler
```

어떤 scheduler implementation을 사용할지는 나중에 결정할 수 있다.

---

# 41. Search

검색은 하나의 backend에 모두 맡기지 않는다.

질문에 따라 source가 달라진다.

```text
개인 기억
→ Supermemory

정확한 task/decision/session
→ PostgreSQL

코드 관계
→ Graphify

문서/외부 자료
→ Resource/Integration Providers

raw session
→ Event/Transcript store
```

Context Engine이 결과를 합친다.

---

# 42. Embedding

Embedding 모델은 Brain domain의 일부가 아니다.

필요한 infrastructure component다.

초기에는 Supermemory/Graphify 내부 구현을 그대로 사용할 수 있다.

Brain 자체 검색에 embedding이 필요해지면 별도 abstraction을 추가한다.

미리 과도하게 추상화하지 않는다.

---

# 43. 구현 시 지켜야 할 원칙

## Do

```text
Core contract를 작게 유지
실제 필요가 생길 때 interface 확장
외부 product API를 Infrastructure에 격리
raw event를 보존
Runtime을 composition root로 사용
Frontend와 MCP가 integration service를 공유
```

## Don't

```text
Supermemory API를 MemoryProvider contract로 그대로 복사
Graphify를 모든 질문에 호출
Workspace별 memory silo 생성
MCP 호출을 사용자가 매번 직접 지시하게 만들기
처음부터 provider marketplace 구현
처음부터 daemon/scheduler 중심으로 설계
Orca domain을 Brain canonical domain으로 사용
Paseo/Orca 내부 state를 Brain source of truth로 사용
```

---

# 44. 내가 이 시스템을 사용하는 시나리오

## 44.1 개발 프로젝트

나는 여러 프로젝트를 동시에 작업한다.

예:

```text
Acme
SideShop
Personal Brain
기타 서비스
```

Brain App에서 Workspace로 구분한다.

```text
Workspace: Acme

├ Sessions
├ Tasks
├ Worktrees
├ Resources
├ Artifacts
├ Decisions
└ Executions
```

Memory는 다른 workspace와 동일한 global memory다.

---

## 44.2 Worktree 단위 작업

```text
Acme
├ ACME-123
└ ACME-456
```

ACME-123을 Claude로 구현하다가 Codex에게 리뷰를 맡긴다.

```text
Claude Session
   ↓
Brain Session/Decision/Task 기록
   ↓
Codex 실행
   ↓
동일 Context 재구성
```

Codex에게 처음부터 다시 설명하지 않는다.

---

## 44.3 Agent handoff

내가:

```text
"이거 Codex한테 리뷰시켜."
```

라고 하면 Runtime은:

```text
현재 task/workspace/worktree 확인
        ↓
관련 session summary
관련 decisions
global memory
Graphify project knowledge
관련 Jira/Confluence resource
        ↓
Codex context 생성
        ↓
Codex 실행
```

한다.

---

## 44.4 개인적인 용무

Workspace는 개발 프로젝트에만 한정하지 않는다.

```text
Keyboard
Travel
Fitness
Personal Admin
Purchase Research
```

예:

```text
Workspace: Keyboard

├ 이전 대화
├ 후보 스위치
├ 관련 영상/링크
├ 구매 후보
└ OpenLoop
```

하지만:

```text
"나는 로우피치 키보드를 좋아한다."
```

는 Keyboard 전용 memory가 아니라 global memory다.

---

## 44.5 전에 하던 조사 이어가기

내가:

```text
"전에 알아보던 키보드 다시 보자."
```

라고만 말한다.

앱이 자동으로:

```text
global memory
keyboard-related sessions
relevant decisions
products/resources
open tasks
```

를 찾아 agent에게 넣는다.

나는:

```text
"Supermemory 검색해."
"brain_context 불러와."
```

라고 말하지 않는다.

---

## 44.6 Project Knowledge + Memory

내가:

```text
"passkey recovery를 왜 이렇게 구현했지?"
```

라고 물으면:

```text
과거 이유
→ Memory / Decision

현재 코드 구조
→ Graphify

정책 문서
→ Confluence / Resource

관련 작업
→ Jira / Task
```

를 Context Engine이 결합한다.

---

## 44.7 Jira / Confluence / Linear

나는 Brain App 화면에서도 Jira issue와 Confluence 문서를 보고 싶다.

동시에 agent도 같은 데이터에 접근해야 한다.

그래서:

```text
JiraIntegration
       │
 ┌─────┴─────┐
 ▼           ▼
UI          Agent/MCP
```

형태로 구현한다.

Frontend용 API와 Agent용 API를 따로 중복 구현하지 않는다.

---

## 44.8 Terminal 직접 사용

Brain App을 사용하지 않고 터미널에서:

```text
claude
codex
```

를 직접 실행할 수도 있다.

향후 MCP를 붙이면 이 agent들도 동일 Brain을 사용한다.

---

## 44.9 두 대의 Mac + Mobile

Canonical Brain Runtime 하나를 기준으로:

```text
Second Mac
Home Mac
Mobile
```

에서 같은 Brain state를 본다.

Mobile은 remote client다.

---

## 44.10 AI 교체

오늘:

```text
Claude
```

내일:

```text
Codex
```

미래:

```text
새로운 Agent
```

를 쓰더라도:

```text
Memory
Decisions
Tasks
Sessions
Resources
Workspace organization
Project knowledge
```

는 그대로다.

---

# 45. V1 목표

V1은 범용 플랫폼 완성이 목적이 아니다.

**내가 실제로 매일 사용할 수 있는 Personal Brain의 첫 번째 형태**가 목적이다.

필수:

```text
Brain Core
Brain SDK
PostgreSQL structured state
Supermemory integration
Graphify integration
Workspace
Session
Task
Decision
Context Engine
Claude/Codex worker
Basic worktree
Basic terminal
Basic Desktop chat
Session recording
Automatic context injection
```

우선순위가 낮은 것:

```text
Dynamic provider plugins
Provider marketplace
Automatic provider generation
Full SaaS
Distributed workers
Advanced scheduler
Complex multi-tenant auth
All external integrations
```

---

# 46. 구현 단계

## Phase 1 — Core Foundation

```text
Domain entities
Repository ports
MemoryProvider
KnowledgeProvider
Worker
createBrain()
PostgreSQL repositories
```

---

## Phase 2 — Context

```text
Supermemory adapter
Graphify adapter
Session/Event history
Context Planner
Context ranking
Token budgeting
```

---

## Phase 3 — Agent Runtime

```text
Claude worker
Codex worker
PTY
Execution
Cancellation
Session lifecycle
```

---

## Phase 4 — Workspace / Git

```text
Repository registration
Worktree create/remove
Workspace UI model
Git state
Diff
```

Orca 코드를 적극 참고/재사용한다.

---

## Phase 5 — Desktop

Paseo UX를 reference로:

```text
Chat
Workspace sidebar
Session list
Agent selection
Terminal
Task view
Resource view
```

를 만든다.

---

## Phase 6 — Integrations

우선순위에 따라:

```text
Jira
Confluence
Linear
GitHub
Bitbucket
Google Drive
```

를 추가한다.

각 integration은 UI와 Agent/MCP가 공유한다.

---

## Phase 7 — MCP

Brain Core/Runtime이 안정된 후:

```text
brain_context
brain_memory
brain_task
brain_resource
brain_work_item
brain_document
```

등의 thin MCP adapter를 제공한다.

---

## Phase 8 — Mobile / Remote

```text
Brain Protocol
Pairing/Auth
Mobile Client
Remote Session
Notifications
```

---

# 47. 제품 전략

Desktop App은 다음 전략을 사용한다.

```text
Paseo
→ UI / Chat / Client UX reference

Orca
→ Worktree / PTY / Git / Agent Execution reference

Personal Brain
→ Canonical Domain / Runtime / Context / Memory
```

중요:

```text
Paseo를 Brain으로 만들지 않는다.
Orca를 Brain으로 만들지 않는다.

둘은 Brain을 구현하는 데 활용하는 client/execution reference다.
```

---

# 48. 최종 Architecture Decision

현재 기준 최종 선택:

```text
Brain
└ Core + SDK가 중심

Runtime
└ Core와 Infrastructure를 명시적으로 조립

Memory
└ Supermemory

Structured State
└ PostgreSQL

Project Knowledge
└ Graphify

Agent Workers
├ Claude Code
└ Codex

Desktop UX
└ Paseo 스타일

Execution Features
└ Orca 구현/패턴 선택적 활용

Workspace
└ grouping only

Memory
└ global shared

Integrations
└ Runtime service
   ├ Frontend
   └ MCP/Agent가 공동 사용

MCP
└ 후순위 thin adapter

Dynamic Provider Plugin
└ V1에서 하지 않음
```

---

# 49. 한 문장으로 표현한 최종 목표

> **내 모든 AI와 작업 도구가 같은 기억, 같은 상태, 같은 프로젝트 맥락을 공유하고, 나는 어떤 AI를 쓰는지 신경 쓰지 않고 이전 작업을 그대로 이어갈 수 있는 개인용 Brain Runtime과 Client를 만든다.**
