---
title: '이 Mac에서 전환: 옛 데이터를 확정 반입하고 옛 예약을 새 예약으로 바꿔 실수집·실평가가 한 번 돈다'
type: 'chore'
ticket: 7
created: '2026-11-06'
status: blocked
baseline_revision: 'e36d3aa5ec51ad9fccbc3d6ab4cac9adabd2ecaa'
route: 'full'
route_source: 'pinned'
risk: 'high'
review: ''
review_source: ''
lenses_ran: []
review_loop_iteration: 0
followup_review_recommended: false
context: [AGENTS.md, _bmad-output/personal-brain/automation/runbook.md, extensions/garmin/README.md, .brain-automation/independent-spec.md, .brain-automation/inv-a-report.md, .brain-automation/prep-b-report.md]
warnings: [oversized]
deferred: []
blocked_at: "2026-11-06"
blocked_reason: "설치본 legacy schema(core 27 + 등록 garmin)에서 새 core로 가는 지원 전환 경로 부재(postgres.ts:130). 중앙이 별도 버그로 분리(msg_07ce4c7fb36b). 버그 반영·release 뒤 재개"
---

<intent-contract>

## Intent

**Problem:** epic 21의 Garmin 확장과 epic 20 설치·예약은 합성 환경에서만 검증됐다(21.8). 이 Mac의 옛 Garmin 데이터는 아직 확정 반입되지 않았고, 옛 launchd 예약이 계속 쓴다(E21-6, AD-36).

**Approach:** 설치본에서 예비 capture·profile gate·전수 비교로 경로를 확인한다. 그다음 옛 예약 중지 → writer 종료 확인 → 최종 capture → 차분 확정 반입 → 전수 비교 → 새 예약 활성화 → 실수집·실평가 1회 순서로 전환한다. 어느 단계든 실패하면 새 예약을 켜지 않고 옛 plist를 되살린다.

## Boundaries & Constraints

**Always:** 옛·새 writer가 동시에 쓰지 않게 순서를 지킨다. dataset마다 raw profile id로 계정을 확인하고, 운영→개발→보관 순으로 선택하며, 미선택 후보는 원형으로 보존한다. 원본 plist·SQLite·설정·credential은 보존한다. private 근거는 gitignored 0700 디렉터리에 두고, 공개 문서에는 건수·상태·비식별 형식만 쓴다. 사람 입력은 사람이 직접 하고, 에이전트가 대신 입력하지 않는다.

**Never:** 안전 guard 해제(legacy schema 거부·A1 잠금·offline 확인), SQL로 registry를 우회하는 것, 빈 새 DB 생성, 추정 kill·blanket 삭제, profile 근거 없는 반입, 21.7 안에서 제품 안전 계약을 바꾸는 것, main 병합·push, 중앙 state 수정.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| 설치본이 legacy | core schema 27 + 등록 garmin, 새 core 472caa7 | 설치기가 변경 전에 `DB_LOCKED`로 거부, 활성 app 무변경 | 별도 버그(지원 전환)가 반영될 때까지 21.7 blocked |
| profile 미확인 dataset | raw 행 0 또는 profile 없음 | 반입하지 않고 미확인으로 보존·보고 | 추정 귀속 금지 |
| 전환 중 실패 | 비교 불일치·writer 종료 불명·설치 실패 | 새 예약을 켜지 않음 | 새 writer 종료 확인 뒤 옛 두 plist 복원 |

</intent-contract>

## Code Map

- `apps/cli/src/install/postgres.ts:130`, `packages/postgres/src/migrate.ts:16-26` -- 확장이 등록돼 있고 core 0035가 없으면 무조건 거부한다. 이 검사가 offline 확인보다 앞에 있다. 현재 설치본은 이 조건에 걸린다.
- `tooling/garmin-import/capture.py` -- private descriptor → read-only capture(`--previous` 차분).
- `extensions/garmin/manifest.json` -- `import-preflight`·`import`·`import-verify`·`collect`·`report` 일감과 `garmin.*` 설정.
- `extensions/garmin/src/{preflight,import_verify,collect_runtime}.py` -- profile gate, 전수 비교, binding·token 지문 확인.
- `plugin/`, `plugins/garmin/` -- core 0.1.17, Garmin 0.1.4, app-ref 472caa7, 확장 1.2.1.
- 옛 예약 label: `local.garmin-pipeline.collect`, `local.garmin-pipeline.report`(plist는 `~/Library/LaunchAgents`).

## Tasks & Acceptance

**Execution:**
- [x] 0. 읽기 전용 준비: 운영 상태 조사, 예비 online capture, profile 집계, private runbook(`.brain-automation/private/runbook-21.7.md`).
- [ ] 1. 설치 전에 새 Garmin 예약이 설치 직후 보류(비활성)되는지 확인한다. 보장되지 않으면 설치를 중지한다. 그다음 legacy 지원 전환 버그가 반영된 core로 core 플러그인과 Garmin 플러그인을 설치하고, 새 예약이 실제로 비활성인지 확인한 뒤, 설치본 신원(marketplace 캐시/app/build/shim/registry)을 대조한다.
- [ ] 2. 예비 capture → `import-preflight` → `import` → `import-verify`.
- [ ] 3. 옛 두 예약 중지 → 옛 writer·후손 종료 확인 → 최종 capture(`--previous`) → 차분 import → import-verify·파일 관계 전수 비교.
- [ ] 4. 새 예약 활성화 → 실수집 1회 → 실평가 1회 → 발신 상태 확인, `brain ext garmin` 조회.

**Acceptance Criteria:**
- Given 확정 반입 보고서, when 표별 건수·자연키·해시·평가·파일 관계를 비교하면, then 모두 일치한다.
- Given 전환 뒤, when launchd와 프로세스를 확인하면, then 옛 LaunchAgent는 내려가 있고 새 예약으로 실수집·실평가가 각 1회 형식·순서·저장·발신 상태 기준으로 성공한다.
- Given 공개 plan·로그, when 검사하면, then 계정·건강값·평가 본문이 없다(모델 품질은 사람이 판단).

## Implementation Notes

- 2026-11-06 공식 render full/thorough exit 0(권한 확장). 자기 Run `run_d3e320eb7c91`. 첫 하위 시작은 `ctx_146e07896ac1`/`task_68f6057ed02e`, `ready`·`depth: 1`.
- 설치본: app e33a787, core 27, garmin 8(옛 epic 16 패키지, 비활성, 보류 예약 2건). 데몬은 옛 app으로 동작 중. 플러그인 설치본은 0.1.10. 세션 hook의 자동 갱신(472caa7)이 2026-11-06T00:23Z에 `DB_LOCKED`(옛 schema 안전 거부)로 exit 1. 활성 app은 바뀌지 않았다. 옛 CLI에는 uninstall이 없다.
- 중앙 판단(`msg_f2b9cb1ce2dd` → 답 `msg_07ce4c7fb36b`): A로 확정. legacy core<35 + 등록 확장의 지원 전환은 별도 버그로 분리한다. 21.7은 그 버그가 제품에 반영될 때까지 blocked다. 그동안 설치 재시도·수동 migration·옛 예약 중지·새 writer/예약은 하지 않는다.
- 예비 online capture 1회 exit 0(DB 5개, 기존 목록 파일 367개). 옛 예약 시각과 겹치지 않았다. profile 집계: 운영·개발·보관 2개 dataset은 같은 단일 profile이다. 보관 1개(D3)는 raw 행 0이라 미확인이며 반입 대상에서 뺀다. 겹치는 자연키는 쌍별 합계 118,364건, 미선택 후보 63,660건이다. 계정 승인이나 반입 성공을 뜻하지 않는다.
- 21.3 binding·tokenstore는 Brain 홈 주변에서 발견되지 않았다(위치 미확인). 21.5 설정값은 DB를 읽지 않아 미확인이다.
- 사고: 옛 프로그램 원본 저장소에 `git status`를 1회 실행해 그 저장소의 `.git/index` stat 캐시가 갱신됐을 수 있다. 작업 트리와 데이터는 무변경이다. 이후 원본 저장소에 git 명령을 쓰지 않았다(정확한 위치는 private 기록).

## Review Triage Log

### 2026-11-06 — blocked 계획 문서 quick 리뷰(Sol, `ctx_0039d58cb064`)
- verdicts: 3 findings — high 0, medium 2, low 1, false 0, maybe-false 0
- `[medium]` `[patch]` 공개 계획의 사고 기록에 원본 저장소 위치가 남아 있었다 → 비식별 표현으로 바꾸고 정확한 위치는 private에만 둔다.
- `[medium]` `[patch]` 설치가 새 예약을 만들 수 있는데 설치 전 보류 확인 조건이 없었다 → Execution 1에 설치 전 보류 보장 확인, 보장되지 않으면 중지, 설치 뒤 비활성 확인을 넣었다.
- `[low]` `[patch]` 사람 입력에 모델 실행기 로그인 확인이 빠졌다 → 재개 조건에 넣었다.

## Verification

**Manual checks:**
- 설치본에서 `brain ext run garmin import-verify --json` 전수 일치, `launchctl list`에 옛 label 부재, 새 예약 실행 1회씩의 work·발신 상태, `brain ext garmin` 실값 조회.
- 21.7은 시험 실행 유예 대상이 아니다. 코드 변경이 생기면 `pnpm test:changed`, 마무리 전 `pnpm test` → `pnpm test:python` 순차 각 1회. 현재까지 코드 변경은 0이다.

## Auto Run Result

**상태: blocked** — 설치본 legacy schema(core 27 + 등록 확장)에서 새 core로 가는 지원 경로가 없다. 중앙이 별도 버그로 분리했다.

- 완료: 읽기 전용 준비(Execution 0). 운영 설치·DB·설정·예약·반입은 무변경이다.
- 미완료: Execution 1~4 전부와 모든 수락조건. 운영 검증은 하나도 수행하지 않았다.
- 리뷰: 이 blocked 계획 문서에 독립 Sol quick 리뷰 1회(`ctx_0039d58cb064`) — 발견 3건(공개 경로 비식별화, 설치 전 예약 보류 조건, 모델 실행기 로그인 항목)을 모두 이 문서에 반영했다. 제품 코드 diff는 0이다.
- 재개 조건: 별도 버그(legacy 지원 전환)가 main에 반영되고 core·Garmin 플러그인에 release될 것. 이어서 사람 입력: 설치기의 대화형 offline 확인, D3를 포함한 계정 귀속 확인, 전용 tokenstore 로그인/MFA와 0600 binding, `garmin.*` 설정값(connection·timezone·model·agent·effort·timeout·수신 conversation), 선택한 모델 실행기(Codex 등)의 로그인 상태 확인과 필요하면 사람이 직접 로그인, 최종 capture 전 원본 파일 목록 확인.
- 재개 지점: `.brain-automation/private/runbook-21.7.md` 단계 1.
