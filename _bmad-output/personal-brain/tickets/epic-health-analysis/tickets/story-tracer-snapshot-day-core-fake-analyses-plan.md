---
title: 'Tracer: 고정 합성 snapshot의 day 평가가 감독되는 core 일감에서 fake 모델을 거쳐 analyses와 리포트 파일로 확정된다'
type: 'feature'
ticket: '1'
created: '2026-11-04'
status: 'built'
baseline_revision: '763550ba8dd8f1c29aab10a8390a860bc5e409db'
route: 'full'
route_source: 'pinned'
risk: 'high'
review: 'thorough'
review_source: 'pinned'
lenses_ran: ['blind-hunter', 'edge-case-hunter', 'verification-gap', 'intent-alignment']
review_loop_iteration: 0
followup_review_recommended: false
context: ['{project-root}/AGENTS.md']
warnings: ['oversized']
deferred:
  - summary: >-
      Python 시험 garmin-import-verify의 "합성 capture를 반입하고 공개 검증 뒤 변조를 실패로 감지한다"가 기준 커밋에서도 매번 다른 줄에서 실패한다(result.body undefined).
    evidence: |-
      기준 763550ba8dd8f1c29aab10a8390a860bc5e409db 임시 worktree에서 깨끗한 전용 PG로 2회 실행해 :201, :170에서 같은 TypeError로 실패했고, 이 브랜치에서는 :128, :145에서 실패했다. 이번 변경이 만든 결함이 아니다.
    location: >-
      apps/cli/python-test/garmin-import-verify.test.ts
    severity: medium
  - summary: >-
      Python 확장 시험이 중간에 실패하면 클러스터 전역 role brain_ext_garmin이 다른 DB marker로 남아, 같은 PG 클러스터의 다음 실행 전부가 "확장 역할 충돌"(DB_UNAVAILABLE, role 단계)로 실패한다.
    evidence: |-
      전용 PG에서 중단된 실행 뒤 provisionExtension을 직접 호출해 "확장 역할 충돌"을 재현했고, 기준 커밋의 garmin-auth 시험도 같은 클러스터에서 DB_UNAVAILABLE로 실패했다. 새 클러스터에서는 해당 실패가 사라졌다. 공유 PG 54329의 전역 Garmin role 충돌 보고와 같은 원인으로 보인다.
    location: >-
      packages/postgres/src/extension-provision.ts, apps/cli/python-test
    severity: medium
  - summary: >-
      추적되는 extensions/garmin/tests/__pycache__/fixtures.cpython-314.pyc가 Python 시험 실행으로 바뀐다.
    evidence: |-
      pnpm test:python 뒤 git status에 이 파일이 수정으로 나타났다. 커밋 전에 되돌렸다.
    location: >-
      extensions/garmin/tests/__pycache__/fixtures.cpython-314.pyc
    severity: low
---

<intent-contract>

## Intent

**Problem:** core에는 모델을 부르는 일감이 없다. `analyses`는 확장 가져오기 전용(출처=확장 work kind, `file_request_id` 필수)이라 core가 만든 평가를 담을 수 없고, 리포트 파일을 core 파일로 잇는 관계도 없다.

**Approach:** scope `day` 하나·정상 경로 하나만 관통한다. 합성 snapshot 행 → supervised core 일감 `health_analysis` → 감독자가 띄운 worker가 출력 코덱으로 가린 export를 scratch에 쓰고 Codex adapter(최소형)로 모델 CLI를 같은 프로세스 그룹에서 실행 → daily schema v1 검증 → FileStore에 Markdown을 넣고 짧은 트랜잭션 하나로 `analyses` 행·파일·위치·분석-파일 관계를 확정한다. 시험은 Codex 모양 fake CLI와 격리 PG·Brain 홈만 쓴다.

## Boundaries & Constraints

**Always:**
- 모델 호출·FileStore I/O·export 쓰기는 DB 트랜잭션 밖. 확정은 attempt fence(`brain.attempt_is_current`)를 통과한 짧은 쓰기 하나.
- 확정 키 `(snapshot_id, scope, revision)` UNIQUE. 이미 행이 있으면 모델을 부르지 않고 성공으로 끝낸다.
- 이전된(legacy) analyses 행의 의미·제약·트리거 동작은 그대로다(R7). 기존 확장 경로 시험이 계속 녹색이어야 한다.
- 모델 CLI 프로세스 env에서 `BRAIN_`으로 시작하는 변수 전부와 `OPENAI_API_KEY`·`CODEX_API_KEY`를 뺀다. cwd는 scratch.
- `analysis.model`이 없으므로 `-m`을 넘기지 않는다(CLI 기본). effort는 고정 `high`, 호출 timeout은 고정 20분.
- v1 리소스(옛 daily `SKILL.md`, `daily_analysis_output.schema.json`)는 바이트 그대로 둔다. sha256: SKILL `98a0b852fef27b21c5ab8422eb5423c2488e12e6896441b29bdfb38fbf0880c8`, schema `85e22c6c5d2909309c926bd0326a07ff084c341fa89aecb3f2bbbbc4a32b7532`.
- 시험 데이터는 합성값만. 개인 홈 절대 경로를 문서·코드·커밋에 쓰지 않는다.

**Never:**
- 7d/30d/all·의존 그래프·재개·재생성 revision(18.3), Claude Code adapter·장애 행렬·env 허용 목록 정책·진단 정책(18.4), 실제 snapshot 생성·옛 reader 동등성(18.2), 결과 묶음·발신(18.6), 예약·`extension:garmin` 보류(18.7), 실모델·이 Mac 전환(18.9), `analysis.model/effort/timeout_minutes` 설정 키, 새 CLI 명령.
- `file_requests` 경유 등록, `analyses.file_id` 같은 UPDATE, 실제 `codex` 실행, 실계정·실건강데이터, `plugin/app-ref` 변경.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| 정상 | 합성 snapshot(시험 비밀 문자열 포함) + `health_analysis` 일감, fake CLI가 schema 맞는 출력 | attempt `succeeded`, `analyses` 1행, 리포트 파일·관계 1행, drain 뒤 추출 세대 1개 | 없음 |
| 출력 schema 불일치 | fake CLI가 필수 필드 누락 JSON | attempt `failed`·`ANALYSIS_OUTPUT_INVALID`(retryable false), analyses·관계·파일 행 0 | 다시 하지 않음 |
| 같은 일감 재실행 | 성공 뒤 같은 snapshot으로 일감 다시 투입 | analyses 1행 유지, fake CLI 호출 횟수 1 그대로 | 없음 |
| 모르는 agent | `brain config set analysis.agent foo` | `CONFIG_INVALID` | 설정 거부 |

</intent-contract>

## Code Map

- `packages/postgres/migrations/0022_import_contracts.sql`, `0025_original_text.sql`, `0027_analysis_artifacts.sql` -- 현 analyses 최소형: `import_batch/original_table/original_key/file_request_id` NOT NULL, `guard_import_attempt`(확장 work kind 요구), `guard_analysis_dataset`(file_request 일치 요구), `reconcile_import_target`(brain_ext 세션만), `reject_import_mutation`(불변). 읽기만, 새 migration에서 함수 교체.
- `packages/postgres/src/migrate.ts:7` -- `CORE_SCHEMA_VERSION = 28` → 29. 이 숫자를 고정한 시험(`packages/postgres/test/{migrate,store,work-store}.test.ts`, `apps/cli/test/{install,setup}.test.ts`)도 갱신.
- `packages/postgres/src/imports.ts:65` `readAnalyses` -- 모든 analyses를 읽는 확장 검증 경로. core 행(`source='core'`)을 제외하거나 영향 없음을 확인.
- `packages/postgres/src/imports.ts:142` `finishImport` -- files/file_locations/home_location 삽입 패턴(재사용 모범).
- `packages/postgres/src/extractions.ts:484` `listFilesAwaitingExtraction` -- home location 있는 파일은 drain이 `document_extract`로 발견. 리포트 파일은 자동으로 추출 대상.
- `packages/core/src/domain/work-item.ts:162` `WORK_KINDS` -- `health_analysis: { executionClass:'supervised', callsModel:true }` 추가(정체 창 25분 자동 적용).
- `packages/core/src/queue/supervisor.ts`, `apps/cli/src/daemon/supervisor.ts` -- `launches` 표에 `health_analysis` spec 추가(channel_send와 같은 ABI env + `BRAIN_ANALYSIS_FILES_PATH`). 감독자는 이미 새 그룹으로 띄우고 정리·reap한다(`apps/cli/src/runtime/process-group.ts`).
- `apps/cli/src/workers/channel-send.ts` -- supervised core worker 모범(ABI env 검사, postgresStore, ABI `result`/`error` 한 줄).
- `packages/core/src/process-abi/codec.ts` -- `result.usage`(세 비음수 정수) 형식.
- `packages/core/src/output/codecs.ts:73` `OUTPUT_CODECS`, `mask.ts` -- 모델 입력 export 코덱 등록 자리. `apps/cli/test/output-codecs.test.ts`가 등록 누락을 잡는다.
- `packages/core/src/settings/index.ts:20` `CORE_SETTING_DEFINITIONS` -- `analysis.agent`(기본 `codex`, 이번에는 `codex`만 허용) 추가.
- `packages/core/src/codes.ts` + guide -- 새 오류 코드 표.
- `packages/core/package.json` `files` -- `resources` 추가해 배포 산출물에 v1 리소스 포함.
- `apps/cli/test/{channel-fixture,supervisor-fixture,pg-home,temp-home}.ts` -- 격리 PG·Brain 홈·`runDaemon` 기동·정리 모범.
- `tooling/test-changed/rules.mjs`, `run.mjs` -- Python 규칙만 있다. 자식 프로세스로만 쓰이는 worker·fake CLI를 tracer 시험에 잇는 규칙이 필요.
- 원본 v1 자산: `_bmad-output/personal-brain/prep-garmin-absorption/inputs/garmin-source.tar.gz`의 `garmin-source/skill/garmin-daily-analysis/SKILL.md`, `garmin-source/src/garmin_pipeline/schemas/daily_analysis_output.schema.json`(새 빈 임시 폴더에 풀어 복사). 옛 prompt는 `"$garmin-daily-analysis\n\n입력 폴더(운영 루트 기준 경로):\n<상대 경로들>"`, argv는 `codex exec -C <dir> -s workspace-write --skip-git-repo-check --ephemeral --json -c project_root_markers=[] -c model_reasoning_effort=<effort> [-m <model>] --output-schema <schema> -o <output> <prompt>`(로컬 `codex exec --help` 0.166.0에서 flag 존재 확인), usage는 `--json` 이벤트 `turn.completed.usage`의 `input_tokens/cached_input_tokens/output_tokens`가 모두 비음수 정수일 때만.

## Tasks & Acceptance

**Execution:**
- [ ] `packages/postgres/migrations/0029_core_analyses.sql` -- `brain.analysis_snapshots`(id uuid pk, bundle_id uuid, local_date date, time_zone text, content bytea, content_sha256, created_at; 불변·brain_app select/insert), analyses에 `bundle_id, snapshot_id(fk), agent, output_json jsonb` 추가, 네 legacy 열 NOT NULL 해제 + `source='core'`이면 core 칸 필수·legacy 칸 NULL, 아니면 legacy 칸 필수인 check, core 행 partial UNIQUE `(snapshot_id, scope, revision)`, `guard_import_attempt`·`guard_analysis_dataset`을 core 행이면 `attempt_is_current`+work kind `health_analysis`로 판정하도록 교체, `brain.analysis_files(analysis_id fk, file_id fk, role 'report', unique(analysis_id,role))` 불변·RLS·brain_app 권한 -- 호환 확장.
- [ ] `packages/postgres/src/migrate.ts` 및 버전 고정 시험 -- 29.
- [ ] `packages/core/src/ports/analysis.ts`(+`ports/index.ts`) -- `AnalysisStore`(`createAnalysisSnapshot`, `readAnalysisSnapshot`, `findCoreAnalysis`, `commitCoreAnalysis`, `readCoreAnalysis`: 행+관계 파일 id), `ModelRunner` port(`run({cwd, prompt, schemaPath, outputPath, effort, model|null, timeoutMs})` → `{ok, output text, usage|null}` | 실패 코드) -- 별도 port라 기존 Store fake를 늘리지 않는다.
- [ ] `packages/core/src/analysis/{day.ts,output-schema.ts,export.ts,index.ts}` -- `enqueueDayAnalysis`(snapshot 생성+일감 투입), `runDayAnalysis`(기존 행 확인→export 코덱 적용 쓰기→ModelRunner→손으로 쓴 daily v1 검증기(필드·타입·enum·additionalProperties)→FileStore.put→`commitCoreAnalysis`), core `index.ts`·`second_brain` 재수출.
- [ ] `packages/core/resources/health-analysis/v1/{skills/garmin-daily-analysis/SKILL.md,schemas/daily_analysis_output.schema.json}`, `packages/core/package.json` -- v1 바이트 그대로, `files`에 `resources`.
- [ ] `packages/core/src/output/codecs.ts` -- 모델 입력 export 코덱 등록(모든 문자열을 mask).
- [ ] `packages/core/src/settings/index.ts` -- `analysis.agent`.
- [ ] `packages/core/src/domain/work-item.ts`, `packages/core/src/codes.ts`+guide -- `health_analysis`, `ANALYSIS_OUTPUT_INVALID`(비재시도)·`ANALYSIS_MODEL_FAILED`(재시도)·`ANALYSIS_SNAPSHOT_MISSING`(비재시도).
- [ ] `packages/postgres/src/analyses.ts`(+store 조립) -- `AnalysisStore` 구현. `commitCoreAnalysis`는 `withWrite` 한 번에 files(on conflict content_hash)·location·home_location·analyses(on conflict do nothing 후 기존 id 반환)·analysis_files.
- [ ] `apps/cli/src/runtime/model-codex.ts` -- Codex adapter 최소형: PATH의 `codex`, 위 argv, `detached` 없이 spawn(감독 그룹 상속), env 제거 규칙, stdout `--json` 이벤트에서 usage, timeout 시 kill.
- [ ] `apps/cli/src/workers/health-analysis.ts`, `apps/cli/src/daemon/supervisor.ts` -- worker 조립(설정 읽기 `analysis.agent`→adapter 선택, scratch 생성·정리, ABI 출력) 및 launch spec.
- [ ] `apps/cli/test/fixtures/fake-codex.mjs`, `apps/cli/test/health-analysis-fixture.ts` -- fake CLI(argv·env·pid·pgid·export 내용을 기록 파일에 append, 모드 env로 정상/불일치 출력, `-o`에 JSON, stdout에 `turn.completed` 이벤트), 합성 snapshot 생성기, 격리 PG·홈·PATH 준비·정리.
- [ ] `apps/cli/test/health-analysis-tracer.test.ts`, `packages/core/test/health-analysis.test.ts` -- 아래 AC와 I/O 행렬. core 시험은 검증기와 use case(fake store/runner)의 정상·불일치·기존 행.
- [ ] `tooling/test-changed/rules.mjs`(+run.mjs와 기존 rules 시험) -- `apps/cli/src/workers/health-analysis.ts`, `apps/cli/src/runtime/model-codex.ts`, `apps/cli/test/fixtures/fake-codex.mjs`, `packages/core/resources/` 변경이 tracer 시험을 실행하게 한다.

**Acceptance Criteria:**
- Given 격리 PG·Brain 홈과 PATH 앞의 fake `codex`, when 합성 snapshot으로 day 일감을 넣고 `runDaemon`을 띄우면, then fake 기록의 pgid가 그 attempt의 `work_attempts.pgid`와 같고 argv에 `exec --json --output-schema … -o …`가 있으며 `-m`은 없다.
- Given 정상 실행 후, when `brain.analyses`를 읽으면, then `source='core'` 행 하나가 bundle id·report_date·scope `day`·snapshot id·revision 1·agent `codex`·output JSON을 갖고, 감독 attempt에 usage 세 값이 기록된다.
- Given 정상 실행 후, when `readCoreAnalysis`와 `brain queue drain`을 거치면, then 관계로 되읽은 파일 바이트가 출력의 `report_md`와 같고 그 파일의 `document_extractions` 세대가 하나 생긴다.
- Given snapshot에 심은 시험 비밀 문자열, when fake가 기록한 export 내용을 보면, then 그 문자열이 없고 가림 표식이 있으며 기록된 env에 DB URL·`BRAIN_` 변수가 없다.
- Given fake가 받은 `--output-schema` 경로, when 그 파일을 읽으면, then 빌드된 core 패키지의 `resources/health-analysis/v1/` 아래에 있고 sha256이 위 값과 같다.

## Implementation Notes

- 원본 v1 리소스 두 파일을 빈 임시 폴더에서 복사하고 계획의 SHA-256과 일치함을 확인했다.
- core snapshot·관계는 0029에서 불변으로 추가하고 기존 확장 분석을 별도 분기로 보존했다. 모델 호출과 파일 쓰기 후 fence가 있는 짧은 트랜잭션에서 분석과 파일 관계를 확정한다.
- 합성 snapshot 내용은 JSON 바이트로 가정하고 문자열 키와 값 모두 export 시 가린다. worker는 임시 scratch에서 Codex adapter를 호출하며 CLI 기본 모델, high effort, 20분 제한을 쓴다.
- sandbox에서 Docker 접근이 차단되어 PostgreSQL 마이그레이션과 tracer는 실행하지 못했다. 로컬 빌드와 core·경로 규칙 단위 시험은 통과했으며 지휘자의 권한 확장 검증이 필요하다.

## Plan Change Log

## Review Triage Log

### 2026-11-04 — Review pass
- verdicts: 23 findings — high 1, medium 11, low 9, false 2, maybe-false 0 (+ 지휘자 확인 1건은 리뷰 전 수정: 모델 출력 `status: failed` 확정 → fix-3에서 비재시도 실패로 고침)
- findings:
  - `[high]` `[patch]` (blind) 새 오류 코드 3개가 `packages/core/test/codes.test.ts` 기대값·Conventions/README 표에 없다 — test:changed 1회차에서 실제 실패 확인. fix-3에서 표·시험 갱신.
  - `[medium]` `[patch]` (blind) 사용자 지정 `store.url_env`(기본 `BRAIN_DATABASE_URL`만 `BRAIN_` 접두로 걸림)면 DB URL이 모델 CLI env로 샌다 — `apps/cli/src/daemon/supervisor.ts`가 `options.env` 전체를 worker에 넘기고 adapter는 `BRAIN_*`만 뺀다. worker env에서 설정된 store URL 변수를 빼고 시험으로 확인.
  - `[medium]` `[patch]` (blind) snapshot 저장 뒤 `addWork` 실패 시 같은 입력 재호출이 PK 충돌로 끝나 일감을 복구 못한다 — `createAnalysisSnapshot`을 동일 내용이면 성공(멱등), 다르면 거부로.
  - `[low]` `[patch]` (blind) `readAnalysisSnapshot.createdAt`이 PG parser 때문에 ISO 문자열인데 port는 `Date` — 읽을 때 `new Date` 변환(직접 수정).
  - `[low]` `[patch]` (blind) `content_sha256`이 content 바이트와 대조되지 않는다 — migration check `content_sha256 = encode(sha256(content),'hex')`(직접 수정).
  - `[medium]` `[patch]` (blind) core analyses DB guard가 일감 대상 snapshot 일치를 보지 않는다 — Store SQL은 확인하나 DB 불변식에 없음. trigger에 `target_kind='analysis_snapshot' and target_id=new.snapshot_id::text` 추가.
  - `[low]` `[reject]` (blind) `analysis_files`에 brain_app이 attempt 없이 INSERT 가능 — brain_app은 core 신뢰 쓰기 role이고(기존 `analysis_artifacts`도 brain_app 무제한), 확장 role에는 grant가 없다. 일상 사용에서 만날 경로가 없고 수정은 새 guard 추가.
  - `[medium]` `[patch]` (blind·intent 공통) 재실행 시험이 호출 수만 본다 — 두 번째 일감 outcome `succeeded`, core analyses·관계·files 행 수 1, id 유지 assert 추가.
  - `[medium]` `[patch]` (blind) v28 legacy 분석·artifact를 채운 뒤 v29로 올려 보존·트리거 동작을 대조하는 시험이 없다(R7, 공용 trigger 교체) — migration 업그레이드 회귀 시험 추가.
  - `[low]` `[patch]` (blind) fixture가 초기화 실패·close 중간 실패 시 DB·홈을 정리하지 않는다 — 티켓의 "정리 도구" 범위. try/finally로 보장.
  - `[medium]` `[patch]` (gap) 다른 snapshot을 대상으로 한 attempt로 확정 거부 시험 없음 — 위 guard 수정과 함께 PG adapter 시험 추가.
  - `[medium]` `[patch]` (gap) 확정 후반 실패 시 DB 롤백 시험 없음 — `analysis_files` 거부 trigger로 롤백 확인 시험 추가.
  - `[medium]` `[patch]` (gap) core·legacy 공존 시 `imports.readAnalyses`가 core를 빼는지 시험 없음 — 혼재 조회 시험 추가.
  - `[medium]` `[patch]` (edge) timeout에서 SIGKILL 뒤 `close`가 자손이 쥔 파이프 EOF를 기다려 반환되지 않을 수 있다 — `apps/cli/src/runtime/model-codex.ts` timeout 시 stdout 정리 후 즉시 실패 확정.
  - `[low]` `[patch]` (edge) stdout 전체를 메모리에 누적 — 줄 단위 파싱으로 usage만 보관(직접 수정, 상한 포함).
  - `[medium]` `[patch]` (edge) toolNotes 배열에 무효 항목이 섞이면 모든 tool note 가림을 건너뛴다 — `packages/core/src/analysis/export.ts` 각 문자열 target에 규칙 적용.
  - `[medium]` `[patch]` (edge) snapshot·일감 비원자 투입 — blind의 같은 지적과 같은 원인, 같은 수정.
  - `[low]` `[reject]` (edge) 새 리포트 바이트가 이미 가린 파일 hash와 같으면 put이 바이트를 되살린 뒤 DB만 rollback — 모델이 만든 리포트가 사용자가 가린 파일과 바이트까지 같을 가능성이 일상에서 사실상 없고, 수정은 put 전 가림 조회 분기 추가.
  - `[low]` `[reject]` (intent) 복사한 skill을 이번 실행이 모델에 전달한다는 증거 없음 — 티켓은 "v1 리소스로 넣는다"이며 리소스 포함은 충족. 실제 Codex의 skill 발견은 계획 Design Notes 가정대로 18.4/18.9 몫(Auto Run Result 잔여 위험에 기록).
  - `[false]` `[reject]` (intent) day 입력 의미·skill 입력 계약 불일치 — 에픽이 실제 snapshot과 옛 reader 동등성을 18.2(E18-1)로 배정했고 이 티켓은 "고정 합성 snapshot"만 요구한다.
  - `[false]` `[reject]` (intent) 설정 코덱 위치(TOML vs 사용자 설정) — 에픽 Notes "사용자 설정(DB, AD-18)에 에이전트… 를 둔다"가 DB 설정을 지정한다.
  - `[low]` `[patch]` (intent) 합성 snapshot 생성기가 fixture 안에 고정돼 2~9가 다시 쓸 수 없다 — 티켓이 "합성 snapshot 생성기"를 시험 기반으로 요구. 생성기 함수를 분리해 내용·날짜를 인자로 받게.
  - `[low]` `[patch]` (intent) `config get analysis.agent` 기본값과 `codex` 저장 왕복을 관찰하지 않는다 — tracer에 assert 2개 추가(직접 수정).

### 2026-11-04 — Review pass (후속 2회차)
- verdicts: 12 findings — high 0, medium 4, low 6, false 1, maybe-false 0 (+ reject 1은 ABI 근거)
- findings:
  - `[low]` `[reject]` (blind) 비 JSON snapshot 바이트가 재시도 가능한 `ANALYSIS_MODEL_FAILED`로 반복된다 — snapshot은 18.2 전까지 시험이 넣는 합성 JSON뿐이고 재시도는 `MAX_WORK_ATTEMPTS`로 유한하다. 새 오류 경로 추가가 필요해 이번에 고치지 않는다(18.2가 실제 snapshot 형식을 고정할 때 재검토).
  - `[false]` `[reject]` (blind) 확정 시 bundle/report_date를 호출자 객체에서 받아 저장 snapshot과 어긋날 수 있다 — 유일한 호출자 `runDayAnalysis`가 넘기는 값은 같은 실행에서 `readAnalysisSnapshot`으로 DB에서 읽은 행이다(`packages/core/src/analysis/day.ts`).
  - `[medium]` `[patch]` (blind·edge 같은 원인) 모델 출력 문자열의 NUL·단독 surrogate가 v1 검증을 통과한 뒤 jsonb 저장에서 실패해 재시도 가능한 DB 실패가 되고 리포트 blob만 남는다 — 검증 단계에서 비재시도 `ANALYSIS_OUTPUT_INVALID`로 거부.
  - `[low]` `[reject]` (blind) 최종 출력 파일을 크기 제한 없이 읽는다 — Codex `-o`는 마지막 메시지 하나이고 일상에서 메모리를 소진할 크기가 나올 경로가 없다. 새 상한 분기는 18.4 장애 행렬에서 다룬다.
  - `[medium]` `[reject]` (blind) 모델 호출 뒤 검증·확정 실패에서 usage가 사라진다 — ABI v1의 `error` 이벤트에는 usage 칸이 없다(`packages/core/src/process-abi/codec.ts:5`·`:128`, 12.4 계약). 실패 attempt usage는 ABI 변경이 필요하고 티켓 범위는 정상 경로 하나다. 18.4 장애 행렬에서 다룬다(Auto Run Result 잔여 위험).
  - `[low]` `[patch]` (blind) 같은 snapshot의 오래된 attempt token 확정 거부 시험 없음 — PG 시험 추가.
  - `[medium]` `[patch]` (blind) `ON CONFLICT`로 기존 id를 돌려주는 확정 분기가 시험되지 않는다 — 같은 snapshot 확정 반복/경쟁 시 id 수렴과 행 수 1을 PG 시험으로 확인.
  - `[low]` `[patch]` (blind) SKILL.md sha256은 시험이 대조하지 않는다 — 패키지 리소스에서 읽어 계획 값과 대조.
  - `[low]` `[patch]` (blind) `CODEX_API_KEY` 제거를 시험이 보지 않는다 — fixture에 합성 값 주입, fake env에서 부재 assert.
  - `[low]` `[patch]` (blind) adapter의 spawn 오류·비정상 종료·출력 파일 누락 분기 시험 없음 — fake 기반 시험 3개.
  - `[medium]` `[patch]` (gap) 서로 다른 snapshot이 같은 리포트 바이트를 내면 기존 파일을 재사용하는 확정 경로가 시험되지 않는다 — PG 시험: analyses 2·analysis_files 2·files 1·file_locations 1, 두 분석이 같은 fileId.
  - `[medium]` `[patch]` (edge) NUL 출력 — 위 blind 항목과 같은 원인·같은 수정.

### 2026-11-04 — 1회차 patch 반영 확인
- 구현 워커가 patch 15건을 반영(`.brain-automation/impl-report.md` "리뷰 수정 후속"). 지휘자 재검증: `pnpm test:changed` 기본 --changed 177파일 중 176 통과, 1 실패(`apps/cli/test/sessions-ingest.test.ts` pgHome의 `Connection terminated due to connection timeout` — 공유 시험 PG 연결 timeout, 코드 무관). 같은 파일 단독 재실행 72 통과. 중단된 Postgres 전체 단계 `pnpm exec vitest run --project postgres` 35파일·535 통과.
- 1회차가 high를 patch했으므로 후속 리뷰를 수행한다(blind-hunter, edge-case-hunter, verification-gap; diff `.brain-automation/review-diff-2.patch`). intent-alignment는 의도·범위 변화가 없어 생략.

## Design Notes

- worker가 Runtime 조립 지점이다: 감독자 launch → worker(core use case + Codex adapter) → 모델 CLI. 모델 CLI는 worker와 같은 그룹이라 감독자의 기존 그룹 정리·reap이 모델까지 덮는다(새 session 금지).
- 채택 가정(근거: 티켓 "가장 얇은 길", 에픽 E18-4는 18.4 소관): `analysis.agent`는 이번에 `codex`만 허용하고 18.4가 `claude-code`를 더한다. effort·timeout은 옛 기본값 상수. skill을 실제 Codex가 찾는 설치 방식은 18.4/18.9에서 정한다(fake는 prompt 첫 줄만 기록).
- snapshot은 18.2 전까지 시험이 넣는 합성 바이트다. bundle id는 snapshot 행에 둔다(에픽: 그래프 하나 = snapshot 하나).

## Verification

**Commands:**
- `pnpm test:changed` -- 반복 중에만. expected: 선택된 시험 녹색(migration 변경으로 Postgres 전체 포함).
- `pnpm build && pnpm exec vitest run apps/cli/test/health-analysis-tracer.test.ts packages/core/test/health-analysis.test.ts apps/cli/test/output-codecs.test.ts` -- 실행: 사전 조건 OrbStack 시험 PG 가동(`compose.test.yaml`, global-setup), 관찰: AC 전부, 정리: fixture가 시험 DB·임시 홈 drop/rm. expected: 통과.
- `pnpm test` 후 `pnpm test:python` -- 마무리 직전 순차 1회. expected: 전부 통과.
- `git diff --check` -- expected: 출력 없음.

**Manual checks:**
- 공개 diff에 개인 홈 절대 경로·실데이터 없음(`git diff origin/main | grep -n '/Users/'` 빈 결과).
  - (지휘자, 검증 중 발견) `[high]` `[patch]` tracer fixture env가 `withoutHarnessFolders`를 쓰지 않아, in-process 데몬·drain이 실행 머신의 실제 하네스 transcript를 격리 시험 DB로 수집했다(세션 ingest 수백 건·첨부 이미지). 이로 인해 부하 시 `document_extract`가 30초 안에 청구되지 못해 test:changed가 실패했다. 지휘자가 fixture env를 `withoutHarnessFolders(process.env)` 기반으로 고쳤고 tracer 단독 실행이 34초→2초로 통과. 수집된 내용은 각 시험이 만든 격리 DB(종료 시 drop)와 임시 홈(종료 시 삭제)에만 있었고 저장소·보고서에는 들어가지 않았다.

## Auto Run Result

상태: built (2026-11-04). 사용자 인수 전이므로 done이 아니다.

**구현 요약:** 합성 day snapshot → supervised core 일감 `health_analysis` → 감독자가 띄운 worker(`apps/cli/src/workers/health-analysis.ts`)가 출력 코덱으로 가린 export를 scratch에 쓰고 Codex adapter 최소형(`apps/cli/src/runtime/model-codex.ts`, 같은 프로세스 그룹, `-m` 생략, effort high, 20분 timeout)으로 모델 CLI 실행 → daily schema v1 검증(NUL·짝 없는 surrogate·`status: failed` 거부) → FileStore put → fence가 걸린 짧은 트랜잭션 하나로 core `analyses` 행·파일·위치·`analysis_files` 관계 확정. 같은 snapshot 재실행은 모델을 부르지 않고 같은 행으로 수렴한다. migration 0029가 analyses를 호환 확장(legacy 행 보존, core/legacy 모양 check, 공용 trigger 분기)하고 `analysis_snapshots`(내용 sha256 check)·`analysis_files`를 더한다.

**변경 파일:**
- `packages/postgres/migrations/0029_core_analyses.sql` — analyses 호환 확장, snapshot·관계 표, 공용 guard 분기.
- `packages/postgres/src/{analyses,imports,migrate,store}.ts` — AnalysisStore 구현, legacy 조회에서 core 제외, schema 29.
- `packages/core/src/analysis/{day,export,output-schema,index}.ts`, `packages/core/src/ports/analysis.ts` — use case·export 가리기·v1 검증기·port.
- `packages/core/src/{codes,index}.ts`, `domain/work-item.ts`, `settings/index.ts`, `output/codecs.ts`, `ports/index.ts`, `README.md` — 오류 코드 3개, 일감 종류, `analysis.agent`, export 코덱 등록.
- `packages/core/resources/health-analysis/v1/**`, `packages/core/package.json` — v1 SKILL·schema 바이트 그대로, 배포 목록.
- `apps/cli/src/daemon/supervisor.ts`, `apps/cli/src/runtime/model-codex.ts`, `apps/cli/src/workers/health-analysis.ts` — launch(store URL 변수 제거), adapter, worker.
- `apps/cli/test/{health-analysis-tracer,health-analysis-fixture,model-codex}.test.ts|.ts`, `apps/cli/test/fixtures/fake-codex.mjs`, `packages/core/test/health-analysis.test.ts`, `packages/postgres/test/analyses.test.ts` — tracer·fake CLI·합성 snapshot 생성기·격리 PG/홈·정리, 단위·PG 시험.
- 버전·목록 고정 시험 갱신: `packages/postgres/test/{migrate,store,work-store,schema,unavailable,import-contracts}.test.ts`, `apps/cli/test/{install,setup,output-codecs}.test.ts`, `packages/core/test/{codes,output-codecs}.test.ts`.
- `tooling/test-changed/{rules.mjs,rules.d.mts,run.mjs}`, `tooling/test-db/test/test-changed.test.ts` — 자식 프로세스 전용 경로(worker·adapter·fake·리소스)를 tracer 시험에 연결.

**리뷰 결과:** 1회차(4 lens) 23건 + 지휘자 발견 2건 — patch 18(+2), reject 5(low 3, false 2). 2회차 후속(3 lens) 12건 — patch 7, reject 5(low 3, medium 1은 ABI v1 error에 usage 칸이 없어 18.4 몫, false 1). 거절 사유는 Review Triage Log 각 행. defer: 기존 결함 3건(frontmatter `deferred`).

**후속 리뷰 권고:** false. 1회차에서 high 2건을 patch해 후속 리뷰를 실제로 수행했고, 후속 2회차는 high 0건(medium patch 3: NUL 출력, ON CONFLICT 수렴 시험, 동일 리포트 공유 시험)으로 수렴했다.

**검증(지휘자 실행, 권한 확장):**
- 반복 중 `pnpm test:changed`: 마지막 실행 176/177 파일 통과, 1건은 공유 PG 연결 timeout(단독 재실행 72 통과). Postgres 전체 35파일·535 통과.
- 마무리 `pnpm test`(전용 PG `BRAIN_TEST_DATABASE_URL`=localhost:54381, 새 tmpfs 클러스터): build·typecheck 통과, 177파일 중 176 통과·1 실패(`packages/postgres/test/work-store.test.ts`의 `Connection terminated due to connection timeout`). 같은 파일 단독 재실행 159 통과. tracer·core·PG analyses·model-codex 시험 포함 통과.
- 마무리 `pnpm test:python`(같은 전용 PG): 18파일 중 16 통과, 9건 실패. 8건은 `extensions/garmin/.venv` 부재(worktree 사전 조건, `uv sync --frozen` 후 단독 재실행 통과), 1건은 위 deferred의 기존 import-verify 결함(기준 커밋에서도 재현).
- I/O 행렬 4행: tracer 시험 두 개(정상·재실행·모르는 agent, schema 불일치)가 마무리 실행에서 통과.
- `git diff --check` 통과, 공개 diff에 개인 홈 절대 경로 없음.

**잔여 위험:**
- 실제 Codex가 `$garmin-daily-analysis` skill을 찾는 설치 방식은 정하지 않았다(18.4/18.9). fake는 prompt를 해석하지 않는다.
- 모델 호출 뒤 실패 attempt의 usage는 ABI v1 error 이벤트에 칸이 없어 기록되지 않는다(18.4 장애 행렬).
- `analysis.agent`는 `codex`만 허용(18.4가 `claude-code` 추가). env 허용 목록·진단 정책은 18.4 몫이며, 이번에는 `BRAIN_*`·설정된 store URL 변수·두 API 키만 제거한다.
- 시험 기반의 기존 불안정(전역 role 잔존, import-verify 변조 시험, 공유 PG 연결 timeout)은 deferred에 기록했다.

**운영 조치:** 없음. 실계정·실모델·예약 변경을 하지 않았다.
