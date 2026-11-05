---
title: '패키지 설치와 확장 플러그인 틀'
type: 'feature'
ticket: 4
created: '2026-11-05'
status: 'built'
baseline_revision: '7e86cd723d85010d584e408c84ab32ea4085547d'
route: 'full'
route_source: 'pinned'
risk: 'high'
review: 'thorough'
review_source: 'pinned'
lenses_ran: [blind-hunter, edge-case-hunter, verification-gap, intent-alignment]
review_loop_iteration: 3
followup_review_recommended: false
context: []
warnings: [oversized]
deferred: []
---

<intent-contract>

## Intent

**Problem:** 현재 확장 설치는 앱에 동봉된 이름만 해석하고 패키지 신원과 core 호환성을 검증하지 않는다. core 갱신과 확장 갱신은 공통 파일 잠금과 quiesce 순서로 직렬화되지 않는다.

**Approach:** 외부 패키지를 검증한 뒤 같은 설치 잠금 안에서 안전하게 이행·전환하고, 독립 플러그인의 얇은 testext fixture로 배포 계약을 입증한다.

## Boundaries & Constraints

**Always:** AD-19·31·38과 기존 확장 ABI·self·설정·예약·회차 계약을 지킨다. `<home>/install.lock/` 안에서 core 신원과 호환성을 다시 확인하고 해당 확장 발화·청구·실행 중 일감·명령을 quiesce한 다음 migration → 원자적 복사 → registry 전환 → 재개한다. 기존 사용자 설정, 예약 변경·삭제 표식, 회차, 활성 상태, 자격증명, reports·staging·tokenstore 및 공용 기억을 보존한다. migration은 공통 실행기와 owner별 이력을 사용하며 적용된 SQL을 바꾸지 않는다. 검증 실패와 downgrade는 변경 전에 끝낸다.

**Never:** 운영 DB·계정·설치·예약을 건드리거나 Garmin 기능을 구현하지 않는다. 플러그인이 core를 자동 설치하거나 core bootstrap을 복제하지 않는다. 사용자 지정 hold를 풀거나 성공한 forward migration을 롤백했다고 주장하지 않는다. 시험은 작성하되 21.8 전에는 실행하지 않는다.

## I/O & Edge-Case Matrix

| 상황 | 입력 / 상태 | 기대 동작 | 오류 및 보존 |
|---|---|---|---|
| 설치·갱신 | `brain ext install --package <dir>`, 유효 testext | 선언 파일 내용 digest와 호환 core를 검사하고 registry에 name/version/digest/plugin version 기록 | 이전 이름 기반 개발 설치도 호환 |
| 무결성 | digest 불일치, 누락·중복·추가 파일, 비일반 파일, symlink, 절대·`..`·경로 탈출 | 거부 | migration·복사·registry 무변경; 검사와 복사 사이 변경도 검출 |
| 호환 | core 미설치·신원 변화·호환 불일치 | 잠금 안 재확인 후 거부 | 설치 전 상태 유지, 명확한 오류 |
| 순서·경합 | bootstrap과 package 설치 동시 | 한쪽이 기다리고 잠금 획득 후 재확인; quiesce→migration→복사→registry→재개 순서 | 잠금 취소·stale·실패 시 소유권을 지켜 해제; bootstrap의 hook 종료 코드 계약(성공·무작업 0)도 보존 |
| downgrade | 설치 version이 패키지보다 높음 | 설치·DB·예약·파일 무변경; doctor가 플러그인 뒤처짐 진단 | 버전 비교 불가능한 기존 값은 임의 순서로 내리지 않고 진단 |
| 같은 version | 같은 digest 재진입 또는 다른 digest | 동일 패키지는 멱등 재개; 다른 바이트는 조용히 동일 취급하지 않고 명시적 실패 | 기존 성공 단계·신원 보존 |
| quiesce | 활성 명령·진행 중 일감·발화/청구 경합 | 새 발화·청구와 명령 차단, 기존 실행 종료 확인 후 진행, 다른 확장 정상 | 잠금 순서 교착 방지; 기존 사용자 hold/disabled 상태 유지 |
| 실패·중단 | migration, 복사/rename, registry, 재개 및 프로세스 중단 주입 | 기존 활성 바이트/registry의 일관성을 복구하거나 명시적 복구 가능 상태로 중단; 재실행으로 이어감 | 적용 완료 migration은 forward 이력으로 남김; 불일치 상태에서 실행 금지, hold 소유권 및 모든 잠금 정리 |
| 기존 데이터 | 재설치 및 실패 후 복구 | reports·staging·tokenstore, 설정·예약·회차·공용 대화/파일/채널 내용 보존 | 사용자 삭제/비활성/변경을 초기화하지 않음 |
| 플러그인 | core 미설치, 이후 설치된 core | 안내만 출력; core가 있으면 동봉 package 경로로 설치 | 네트워크·bootstrap·setup 자동 실행 없음 |
| release | package 변경 또는 plugin ref 변경 | package/digest 동기화, 각 플러그인 ref 변경 시 같은 커밋 version 증가·이전 커밋 ref | 불일치 시험 실패; core plugin 규칙 유지 |

</intent-contract>

## Code Map

- `apps/cli/src/commands/ext-install.ts`, `dispatch.ts`, `packages/core/src/brain.ts` — 현재 `<name>` 필수; `--package`를 외부 CLI에서 끝까지 전달하고 기존 경로·출력과 취소를 유지한다.
- `packages/core/src/extensions/manifest.ts`, `packages/core/schemas/extensions/v1/manifest.schema.json`, `packages/core/fixtures/extensions/v1/` — 현재 `core: 1`, `abi: 1`, 자유 텍스트 version, `additionalProperties: false`; decoder·공유 schema·Python fixture를 함께 갱신한다. 20.1 명령 schema/출력 가림과 20.2 설정 scope, 20.3 예약 선언을 보존한다.
- `apps/cli/src/runtime/extensions.ts` — 현재 이름 resolver, 전체 트리 digest, symlink 검사, staged rename·rollback과 reports/staging/tokenstore 복사. 기존 digest는 선언 목록 해시가 아니므로 패키지 계약을 별도 명확히 적용한다. 소스 변경 경합과 임시 폴더 정리를 다룬다.
- `packages/core/src/extensions/install.ts`, `install-progress.ts` — 현재 패키지 배치→환경→role→migration→registry→login/config/connection/schedule; checkpoint·수정 migration 재개·취소를 보존하면서 요구 순서로 재구성한다.
- `tooling/bootstrap/src/bootstrap.ts`, `tooling/bootstrap/bin/second-brain.js`, `plugin/bootstrap.mjs` — mkdir/pid/stale 설치 잠금과 bootstrap 복사본 동기화. 기존 bootstrap은 잠금 보유 시 exit 0이므로 확장 쪽 대기 및 재검증을 설계하고 bootstrap hook 계약을 깨지 않는다.
- `packages/postgres/src/extension-install-lock.ts`, `packages/core/src/extensions/commands.ts`, `status.ts`, `apps/cli/src/runtime/extensions.ts` — DB advisory 확장 잠금은 설치·disable·명령이 공유; 명령은 실행 내내 잠금을 보유한다. 파일 잠금→확장 잠금 순서를 일관되게 적용한다.
- `packages/postgres/src/work.ts`, `schedules.ts`, `packages/core/src/domain/work-item.ts`, `queue/schedule-tick.ts` — hold group은 발화 CAS와 청구를 막지만 실행 중 자식을 자동 종료하지 않는다. 소유한 hold만 해제하고 기존 명시 hold·다른 그룹·회차를 보존해야 한다. 명시 hold group이 기본 그룹과 다른 경로까지 확인한다.
- `packages/postgres/src/extensions.ts`, `extension-provision.ts`, `migrate.ts`, `migrations/` 및 `packages/core/src/ports/store.ts` — registry는 현재 name/version만 저장; 새 forward migration과 port/fake/권한을 추가하고 공통 migration ledger·역할 계약을 유지한다.
- `apps/cli/src/doctor/{checks,store}.ts`, `commands/doctor-run.ts`, `plugin/`, `.claude-plugin/marketplace.json` — 뒤처진 플러그인 진단과 기존 ref/version·bootstrap 동기화; testext fixture는 별도 plugin identity와 package를 갖는다.
- `apps/cli/test/{ext-install,ext-install-resume,extension-commands,ext-fixture,pg-home}.ts`, `packages/postgres/test/{extension-atomic,extension-permissions,extensions}.test.ts`, `tooling/bootstrap/test/`, `tooling/test-changed/rules.mjs` — 격리 홈·전용 DB·자식 프로세스 시험과 선택 규칙. 신규 Python/SQL/자식 전용 경로도 분류한다.

## Tasks & Acceptance

**Execution:**

1. [x] `manifest.ts`, schema/fixture, `runtime/extensions.ts`, CLI/brain ports — 패키지 목록·digest·호환성 검사와 `--package`를 구현하고 정상·경계 입력의 시험 코드를 작성한다. 이름 resolver와 기존 manifest 호환성을 유지한다.
2. [x] `packages/postgres/src/extensions.ts`, `packages/core/src/ports/store.ts`, fake·registry migration·doctor — 패키지 신원 저장과 버전 비교·downgrade 무변경·doctor 진단 계약 및 DB upgrade/권한 시험 코드를 구현한다.
3. [x] `install.ts`, `runtime/extensions.ts`, bootstrap 잠금, PG hold/claim — 파일 잠금 안 재확인부터 quiesce·migration·복사·registry·재개 순서와 실패 복구를 구현하고 충돌·재시작·보존의 실제 외부 프로세스 및 DB 시험 코드를 작성한다.
   - 3c1. [x] `apps/cli/src/runtime/extensions.ts`, 새 패키지 전환 journal 모듈, `packages/core/src/extensions/install.ts`의 package port: 메모리 pending 배치 상태를 영속 journal과 stage/backup으로 복원 가능하게 만든다. 전환 준비/복사/확정/복구 API 및 재시작/rename 실패/영속 파일 보존 시험 코드를 작성한다. 설치 순서 연결은3c2다.
   - 3c2. [x] `packages/core/src/extensions/install.ts`, `install-progress.ts`, `apps/cli/src/install/postgres.ts` 및 대응 시험: 지속 owner로 quiesce하고3c1 API로 migration/복사/registry/재개를 실제 설치에 연결한다. registry와 바이트 일치 뒤 auth/login 청구를 재개하며 중단 재진입/실패/보존/설치된 확장 migration 호출 일관성 시험 코드를 작성한다.
4. [x] `plugins/testext/`, marketplace fixture 및 `tooling/bootstrap/test/` — 얇은 진입점, package/digest와 플러그인별 ref/version 계약 시험 코드를 작성하고 새 비TS 경로의 `tooling/test-changed/rules.mjs` 분류 및 분류 시험을 갱신한다. 실제 Garmin 플러그인을 배포하지 않는다.

5. [x] `apps/cli/src/install/postgres.ts`, bootstrap/설치 호출부 및 대응 시험: 중앙 해석2의 core 갱신 대상 확장 호환 재확인과 안전 quiesce/drain/migration/소유 재개를 구현한다. 옛 schema의 기존 실행 경로도 안전 정지를 입증하거나 변경 전에 복구 안내와 함께 거부한다. 실제 installPostgres의 잔존 journal/gate·호환 실패·진행중 확장·사용자 hold·중단/재개·공용기억 보존 시험 코드를 작성한다.

**Acceptance Criteria:**

- Given 격리 홈과 호환 core 및 testext 패키지, when `brain ext install --package <path>`로 설치·상위 버전 갱신하면, then CLI와 registry에서 이름·version·digest·plugin version이 일치한다.
- Given 잘못된 digest·symlink·경로 탈출·호환 불일치, when 같은 CLI를 실행하면, then 거부하고 기존 설치와 데이터는 보존된다.
- Given core bootstrap과 패키지 설치가 동시에 시작되면, when 두 프로세스가 끝나면, then 한쪽이 기다리고 재확인한 후 일관된 core·확장 신원을 남긴다.
- Given 앞선 설치본과 낮은 version 패키지, when 설치 명령과 doctor를 실행하면, then 설치본은 바뀌지 않고 doctor가 뒤처짐을 알린다.
- Given core가 없는 격리 홈, when testext 플러그인 진입점을 실행하면, then core 설치 안내만 하고 설치하지 않는다. Given core가 있으면, when 진입점을 실행하면, then 동봉 package로 CLI 설치를 호출한다.
- Given 설치 전 사용자 설정·예약·회차·공용 기억과 진행 중 명령/일감, when 갱신 또는 주입된 실패 후 재개하면, then 보존 계약과 matrix의 순서·복구 결과를 관찰한다.
- Given package 및 플러그인 release 변경, when 동기화·ref/version 시험을 실행하면, then 패키지 바이트/digest와 각 플러그인의 ref·version 규칙이 검증된다.

## Implementation Notes

- R1수정6까지 반영: 실제PG claim/fire↔gate 양방향 barrier, supervisor에 연결된 자식/후손과 실제DB정산 후 설치전환, 실제bootstrap과실제package설치의종료0/최종신원일관성, 실제CLI거부표면 시험코드를 추가했다. bootstrap은target호환검사·지속owner·offline진입차단·cross-commit운영자확인(자동/yes/JSON/hook은대체불가)·자기정지재개를 수행한다. 운영자확인은기계종료증명이아니며 재시도마다새진입잠금구간에서입력한다. legacy/불명/다른owner는변경전거부한다.

- 중앙 msg_9f0b2366e951은 미추적 직접명령 자식이 남을 수 있는 cross-commit 경계에 명시적 offline 복구 확인 입력을 승인했다. 새진입을 차단한 상태에서 운영자가 이전daemon/명령/자식 쓰기 전부 종료를 확인하며, 기계종료증명과 구별한다. 확인을home·이전/목표core신원·해당전환에 결합하고 진입재개/전제변경 뒤 재사용하지 않는다. 영구force금지·A1잠금유지·일반확장설치로확대금지. 자동갱신 제약/복구절차와 미확인/대상오류/오래된확인/경합/실패보존 시험코드 및 독립후속리뷰가 필요하다. 구체 설계는 자율처리한다. 명세판단은 해결됐고 실제 구현은 진행 중이다.

- 수정5 부분구현은 모든 cross-commit갱신 거부 때문에 미완료다.5a에서 실제 실행기 진입의 singleton/명령잠금 근거를 확인해 안전하게 허용되는 갱신 성공경로를 구현하고 불명환경 사전거부를 유지한다. 소유권/공용기억/사용자hold 보존 계약은 유지한다.

- 중앙 msg_fe2784f361f9에서 R1 intentB를 해석2로 확정했다. core 갱신이 기존 확장 migration을 수행할 때도 실제 영향 확장의 갱신 대상 core 신원 기준 호환 검사→새 명령/발화/청구 차단→진행 작업 drain→migration→자기 정지 재개가 필요하다. 패키지 교체가 없으면 복사/registry version 전환은 추가하지 않는다. 옛 gate 표 부재를 작업 부재로 취급하지 않으며 기존 실행 경로를 막고 drain할 수 없으면 관련 변경 전에 복구 안내와 함께 거부한다. 사용자 hold/다른 gate/실패중단 소유권을 보존한다. 명세 판단은 해결됐고 실제 구현·시험코드·후속 독립 리뷰는 미완료다.

- 구현 완료 대조: Execution1/2/3a/3b/3c1/3c2/4 보고와 실제 diff를 대조했다. registry 신원0034, 지속 gate0035, Runtime 전환 journal, 이름/외부 설치 순서, A1잠금, doctor, testext 플러그인을 연결했다. 지휘자 `pnpm build`·`pnpm typecheck`·`git diff --check` 종료0. 모든 시험 및 fixture checker는21.8 이관·미실행.
- Matrix 코드 대조(실행은21.8): 설치/갱신·동일버전·downgrade·호환·무결성은 `apps/cli/test/ext-package.test.ts`, 잠금순서/경합/A1은 `install-lock.test.ts`와 `tooling/bootstrap/test/bootstrap.test.ts`, quiesce는 공통 `extension-quiesce` 계약·PG전용시험·CLI extension-commands, 실패/중단은 core extensions 실패주입·CLI ext-install-resume/ext-package·extension-transition, 영속파일/설정/예약/회차는 해당 재설치/공통계약/이행시험, 플러그인/release는 `tooling/bootstrap/test/extension-plugin.test.ts`가 담당한다. DB 공용 기억 내용 보존 등 증거의 충분성은 독립 verification-gap 리뷰로 추가 확인한다.

- 2026-11-05 중앙 A1 승인(msg_a2333274de11, 잔여 질문 msg_2f08905dd1c3): 부모 PID 사망만으로 자식의 공유 상태 쓰기 종료를 입증하지 못한다. 기존/새 잠금의 모든 쓰기 종료를 안전하게 입증할 수 없으면 자동 회수하지 않고 보존하며 명시적 복구를 요구한다. owner 누락/손상·기록 전 초기창도 회수 근거가 아니다. 나이·부모 PID·사후 자식 목록으로 안전을 주장하지 않는다. 양 설치기에 원인·대기/취소·복구 안내를 동일 적용한다. 복구 절차는 새 설치 진입 차단 → 이전 설치의 공유 상태 쓰기 프로세스 전부 종료 확인 → 해당 잔존 잠금만 제거 → 재시도다. PID 사망만 확인한 무조건 제거·나이 기반 강제 해제는 안내하지 않는다. A2의 OS 잠금 의존성·프로세스 감독과 B 강제 종료는 추가하지 않는다. 중단 후 자동 재개가 제한되는 가용성 tradeoff는 승인됐으며 명세 판단은 해결됐다. 실제 구현·시험 코드·독립 리뷰는 별도로 완료해야 한다. AD-19 현재 명세에 반영했다.

- 2026-11-05 중앙 승인(msg_37f4ec2d6db1, 질문 msg_3390cbce8207): AD-38/E20-4 설치 직렬화를 우선해 AD-19 live PID의 30분 강제 회수를 정정한다. 살아 있거나 생존 불명인 소유자는 나이만으로 회수하지 않는다. 죽음/소유자 부재 확인 뒤 회수도 owner 기록 전 초기창·동시 회수·검사 후 소유권 교체·이전 소유자의 해제 경합을 안전하게 처리한다. 권한 오류·PID 재사용은 부재 증거가 아니며 대기/취소 가능해야 한다. 부모가 죽은 뒤 설치 자식이 계속 공유 상태를 변경할 가능성도 확인한다. 강제 종료 fencing 정책은 추가하지 않는다. 양 설치기와 장시간/정지재개·회수/해제 경합 시험 코드를 독립 리뷰한다. 현재 spine AD-19를 승인 내용과 일치시켰다.

- 2026-11-05 Execution 2 판단(msg_3a683fc4d146): downgrade의 무변경은 설치된 패키지 바이트·registry·migration·예약·설정·회차를 가리킨다. 별도 doctor 프로세스가 마지막 플러그인 제안을 알아야 하므로 AD-19의 `run/plugin.json` 관측 기록에 준해 `<home>/run/` 아래 확장 플러그인 관측 신원만 원자적으로 기록할 수 있다. 이는 설치 전환·성공 기록이 아니며 진단 전용이다. 관측 기록에는 이름·제안 version·plugin version·digest 등 필요한 신원만 담고 내용/비밀은 담지 않는다. 후속 정상 설치 시 낡은 behind 진단이 남지 않도록 갱신한다.

- 계획 준비 gate: 설치 잠금 경합에서는 AD-38의 대기가 AD-19의 과거 즉시 무작업 동작보다 우선한다. hook stdout/종료코드는 유지한다. core 호환 release 출처와 범위 비교를 위 Design Notes로 확정했다.

## Plan Change Log

- R3: stage설치기지원확인과최종app신원검증으로이전target의성공오판을막고, 완료backup정리중단을멱등재개한다. 실제app승격후실패/동일대상재시도의marker·backup·최종shim/installed정리시험코드를추가한다. KEEP: 안전검사전활성app보존·중앙offline계약·모호잔존상태거부.

- R2: bootstrap의호환/offline실패전실제app바이트보존을확보하고 home/nonce결합입력으로확인재사용을막는다. snapshot취소/FIFO/.venv사전검사와미정산attempt의명시복구/취소, 실제TTY/다중확장/변경중manifest/기존시험mock·sink를보완한다. KEEP: 중앙A1·해석2·전환한정operator확인·기존owner/hold/데이터보존. 임의패키지quota는추가하지않는다. 기존부분작업보존지시로관련경계만재구현한다.

- 중앙 해석2로 intentB 해결: AD-38을 현재 계약에 맞춰 정정했다. Execution5에서 core bootstrap의 호환 검사/안전 정지/옛 schema 거부/소유 재개와 소비 지점 시험을 구현한다. KEEP: 기존 확장 package 신원·사용자 hold·다른 gate·공용 기억·회차를 보존하고 패키지 미교체 시 불필요한 전환을 넣지 않는다.

- R1 준비/검증 보완: 외부 패키지의 migration 번호/영속 경로 충돌/Python 정적 입력은 quiesce 전 거부한다. 실제 실행 core 신원을 대기 전 고정하고 잠금 안 재검증한다. 디렉터리 교체 경계와 TS/Python Unicode 정렬을 일치시킨다. prepared rollback 삭제의 지속 의도를 기록해 재진입한다. 공개 gate/동일버전 신원충돌 진단과 실제 경합·supervisor·core설치 소비 지점 시험 코드를 보완한다. KEEP: A1잠금·패키지 digest·owner journal·예약/회차/사용자 hold 보존을 유지한다. 기존 부분 작업 보존 지시를 따라 전체 코드를 되돌리지 않고 관련 계약 경계만 재구현한다. bootstrap quiesce 범위는 중앙 질문으로 분리했다.

## Review Triage Log

### 2026-11-05 — Review pass r4 (app승격 증분후속)
- verdicts: 1 finding — high 0, medium 1, low 0, false 0, maybe-false 0
- edge-case-hunter: `[]`(이증분범위의발견사항없음). verification-gap1: `[medium]` `[patch]` npx자식성공뒤installed.commit불일치의실패/backup보존분기시험공백. 코드guard는있으므로해당조건회귀를잡는시험코드를추가한다.
- 원문: 로컬 `.brain-automation/review/r4-{edge-case-hunter,verification-gap}.md`.

- R3처리결과: edge1/2·verification1·intentD2는수정1의target승격지원신호/최종app검증/완료정리멱등/실제hook승격후실패재시도시험코드로보완했다. 고유수정묶음high1·medium2라후속edge/verification검사가필요하다. intentD1/D3/D4기각유지. 보고로컬 `.brain-automation/r3-fix1-report.md`. 시험21.8이관·미실행.

### 2026-11-05 — Review pass r3 (증분후속)
- verdicts: 7 findings — high 1, medium 3, low 0, false 3, maybe-false 0
- 원문: 로컬 `.brain-automation/review/r3-{edge-case-hunter,verification-gap,intent-alignment}.md`. blind는R1/R2전문검사후증분pass에서생략.
- findings:
  - `[high]` `[bad_plan]` edge1: 현재core plugin의이전app-ref는staging미지원설치기일수있고marker없음을성공으로취급하면shim이삭제stage를가리킴. target지원협상과최종app신원검증을추가한다.
  - `[medium]` `[patch]` edge2: backup삭제후marker삭제전중단은완료신원검증으로멱등정리가능하나hadPrevious불일치로막힘. 모호상태보존을유지하며명백한완료정리를재개한다.
  - `[medium]` `[patch]` verification1: 실제app승격후실패/동일target재시도의marker·원본backup보존시험없음. 실제hook통합실패주입시험코드를추가한다.
  - `[false]` `[reject]` intentD1: TTY와bootstrap의표면분리는현재수락조건각표면시험으로연결되며새확정의도위반없음. 승격재시도공백은verification1로처리한다.
  - `[medium]` `[patch]` intentD2: 완료backup정리중단은edge2와같은원인. 기타모호한next/marker상태의보존거부는A1계약과일치한다.
  - `[false]` `[reject]` intentD3: Pythonforward이행과gate재개·합성uv시험의표면은승인계약과일치하며실제실행은21.8소관이다.
  - `[false]` `[reject]` intentD4: downgrade관측은중앙이승인한진단기록이며기존판정유지.

- R2처리결과: blind2/intentD1은수정1(격리target/검증후승격), blind3/8/9/10·vgap3·intentD2는수정2(home/nonce·미정산안전거부·실제TTY·두확장재개), blind4/5/7·edge1은수정3(snapshot취소/FIFO/.venv), blind1·vgap1/2/other는수정4(Python실패복구·mock·stage harness·sink)로보완했다. blind6/intentD3/D4기각유지. 고유수정묶음 high2·medium10·low1. 후속pass에서high수정이있어추가독립리뷰가필요하다. 원문보고는로컬 `.brain-automation/r2-fix{1,2,3,4}-report.md`. 시험은21.8이관·미실행.

### 2026-11-05 — Review pass r2 (후속)
- verdicts: 19 findings — high 3, medium 12, low 2, false 2, maybe-false 0
- 원문: 로컬 `.brain-automation/review/r2-*.md`. 모든4렌즈수신뒤판정.
- findings:
  - `[medium]` `[patch]` blind1: Python uv/python/sync/version 시험은 기존manifest복원/무journal을 기대하지만 현재는gate/journal보존; 실패후같은owner복구까지 수정.
  - `[high]` `[bad_plan]` blind2: bootstrap prepareAppAt/installAndBuild가 target호환/offline검사 전에 실제app을바꿈; 거부전실행앱보존 필요.
  - `[high]` `[patch]` blind3: challenge는commit쌍뿐이라다른home/동일쌍재시도응답재사용가능; canonicalhome/시도nonce결합.
  - `[medium]` `[patch]` blind4: prepareExternal에signal없어CLI취소가snapshot자식에전달되지않음; 종료/정리후취소결과.
  - `[medium]` `[patch]` blind5: lstat일반파일뒤FIFO교체시blockingopen; nonblocking+fstat와동기화시험.
  - `[low]` `[reject]` blind6: 크기/파일수/깊이상한의새정책은원문에없고사용자가임의보안정책추가금지; 현재취소/비일반파일거부수정으로범위유지.
  - `[medium]` `[patch]` blind7: Python생성.venv와선언파일충돌미검사; migration전거부.
  - `[medium]` `[bad_plan]` blind8: offline daemon fence로새정산자진입차단뒤미정산attempt가영구양수; 취소/명시복구안내로안전거부하고owner보존.
  - `[medium]` `[bad_plan]` blind9: crosscommit확인callback시험만으로TTY소비/JSON/입력중단미검증; 실제CLI시험코드.
  - `[medium]` `[bad_plan]` blind10: 다중확장migration실패/부분gate해제재개검증누락; 두확장시험코드.
  - `[medium]` `[patch]` vgap1: postgres-setup모의모듈에inspectExtensionFence/withExtensionInstallLock없어성공경로시험실패; 현재APImock보완.
  - `[medium]` `[patch]` vgap2: 복구시험이옛.env/볼륨삭제문구를요구; 현재안내/원오류/무migration단언유지.
  - `[medium]` `[patch]` vgap3: 확인callback중manifest변경무효화시험없음; ledger/gate/registry/DDL무변경단언추가.
  - `[low]` `[patch]` vgap-other: install-lock stderr writer가output-codecs SINKS미등록; 고정문구sink사유등록.
  - `[medium]` `[patch]` edge1: blind5와같은FIFO blocking open경계.
  - `[high]` `[bad_plan]` intentD1: blind2와같은실제app교체가거부보다앞선표면차이; 관련변경전검사계약보완.
  - `[medium]` `[bad_plan]` intentD2: blind9와같은함수callback대TTY실제소비표면공백.
  - `[false]` `[reject]` intentD3: 진단관측은중앙승인된설치무변경해석이며기존판단유지.
  - `[false]` `[reject]` intentD4: gate/journal의논리적원자전환은계약과일치하며기존판단유지.

- R1 처리 결과: blind1/3/4·edge3·vgap1은수정1, blind5/6·edge1/2·vgap2는수정2, blind2·edge4는수정3, blind7/8·intentC는수정4, intentB는중앙해석2/수정5·5a, vgap3은수정5, blind9/10·intentA/D는수정6으로 보완했다. intentE/F는기각 근거 유지. 수정 보고 전문은 로컬 `.brain-automation/r1-fix{1,2,3,4,5,5a,6}-report.md`. high4·medium17 항목의 계약 변경을 적용해 실행신원·상위경로·bootstrap offline/owner재개·실제경합 검증을 후속4렌즈로 재검토한다. 시험실행은21.8 이관·미실행이며 코드검사/build/typecheck 성공과 구별한다.

### 2026-11-05 — Review pass r1
- verdicts: 23 findings — high 4, medium 17, low 0, false 2, maybe-false 0
- 원문: 로컬 `.brain-automation/review/r1-{blind-hunter,edge-case-hunter,verification-gap,intent-alignment}.md`. 전체 결과 수신 뒤 각 항목을 판정했다.
- findings:
  - `[medium]` `[bad_plan]` blind1: migration 번호연속/중복 검사가 quiesce 뒤 실행기에만 있어 잘못된 패키지로 gate가 남음; 사전검사 보완.
  - `[medium]` `[bad_plan]` blind2: prepared rollback의 stage 삭제 후 journal 삭제 중단시 sameBase ENOENT; 지속 삭제상태/재진입 보완.
  - `[medium]` `[bad_plan]` blind3: reports/staging/tokenstore가 선언 목록에 허용되나 prepare가 덮어써 digest 실패; 사전 충돌 거부.
  - `[medium]` `[bad_plan]` blind4: Python 정적 의존입력 누락이 migration/activate 후 검출됨; 사전 검사 보완.
  - `[medium]` `[patch]` blind5: TS UTF16와 Python 코드포인트 정렬이 다름; 보충평면 공통 fixture와 정렬 일치.
  - `[high]` `[bad_plan]` blind6: 부모 경로 lstat와 open 사이 디렉터리 교체로 O_NOFOLLOW 우회 가능; 디렉터리 신원 경계 보완.
  - `[medium]` `[patch]` blind7: 같은 version 다른 digest의 거부 관측을 doctor가 version만 비교해 정상 보고; 신원충돌 진단.
  - `[medium]` `[patch]` blind8: gate는 명령/예약을 막지만 공개 상태와 doctor에 없음; owner 비공개 정지/복구필요 진단.
  - `[medium]` `[bad_plan]` blind9: 직접 SHARE 잠금 시험은 실제 fire/claim 선후경합을 덮지 못함; 실제 API 경쟁 시험 코드.
  - `[medium]` `[bad_plan]` blind10: 별도 타이머 자식은 supervisor attempt와 연결되지 않음; 실제 supervisor/후손 종료 및 전환대기 통합 시험.
  - `[high]` `[bad_plan]` edge1: checkInstalledCore/checkPackageCore가 변경 가능한 build.json을 잠금 뒤 읽어 구버전 메모리 실행을 신원으로 식별 못함; 실행 신원 고정.
  - `[high]` `[bad_plan]` edge2: blind6과 동일 원인; 상위경로 교체 경계.
  - `[medium]` `[bad_plan]` edge3: blind4와 동일 원인; Python 정적검사 선행.
  - `[medium]` `[bad_plan]` edge4: blind2와 동일 원인; prepared 삭제 중단 복구.
  - `[medium]` `[patch]` vgap1: 정상64자리 hex를 유지한 내용 변경 거부 시험 없음; ext-package에 실제 거부/무변경 단언 추가.
  - `[medium]` `[bad_plan]` vgap2: 잠금대기 중 core 신원 변경 뒤 거부/무변경의 실제 CLI 시험 없음; edge1 보완과 함께 작성.
  - `[medium]` `[bad_plan]` vgap3: helper만 검사하고 installPostgres 소비 지점 차단을 미검증; 실제 PG설치 ledger/부작용 무변경 시험.
  - `[medium]` `[bad_plan]` intentA: lock callback 대기와 bootstrap 비0종료 허용만 있어 실제 두 설치 완료/신원 일관성 verify 부족; 외부 두 설치 통합 시험.
  - `[high]` `[intent_gap]` intentB: bootstrap은 기존 확장에 quiesce/호환 재확인하지 않음; 중앙 msg_fe2784f361f9가 해석2로 확정해 bad_plan 보완(Execution5)으로 진행.
  - `[medium]` `[patch]` intentC: 진단관측 허용은 중앙 판단과 일치; 실제 downgrade→doctor 및 낮은비호환 우선순위의 단일 CLI 시험 보완.
  - `[medium]` `[bad_plan]` intentD: 거부조건 다수가 helper 표면뿐임; 대표 digest/symlink/탈출의 CLI envelope/무변경 시험 보완.
  - `[false]` `[reject]` intentE: 원자성은 gate와 journal로 협력 실행 표면에서 보장하는 계약; 단일 FS/DB 트랜잭션은 원문이 요구하지 않음.
  - `[false]` `[reject]` intentF: testext fixture와 동봉 package 위임 및 ref/version 시험은 원문 틀 범위에 일치; 운영 marketplace 배포는 요구하지 않음.

## Design Notes

- 기존 `core: 1`은 core ABI 세대이지 현재 앱 semver 범위가 아니다. 기존 v1 manifest를 깨지 않고 package 설치용 선택 필드로 `files`(정규화된 상대 일반 파일 경로의 중복 없는 정렬 목록), `core_compat`(core release semver의 `{min, max_exclusive}` 범위), `plugin_version`을 추가한다. core release는 `apps/cli/package.json`의 version을 build.json의 `version`에 함께 기록한다(현재 0.0.0). 잠금 안에서 running build의 commit/schema_version과 installed.json의 commit/schema_version이 같은지 확인하고 build version을 범위와 비교한다. core 미설치·신원 불일치는 설치 전에 거부한다. semver 비교는 min 이상·max_exclusive 미만이고 세 숫자 release 형식으로 제한한다. 개발 시험은 격리 홈에 같은 합성 core 신원을 준비한다. 기존 이름 기반 설치에는 기존 v1 호환을 유지한다.
- `package/digest`는 digest 자신을 제외한 `manifest.json`을 포함하는 선언 목록의 경로와 파일 바이트를 길이 구분해 정렬 순서로 SHA-256 해시한 값이다. manifest가 자기 자신을 `files`에 명시하고 모든 실행·migration 파일을 포함한다. 누락·중복·미선언 배포 파일과 링크/탈출을 거부하고 동일 알고리즘을 fixture 생성과 설치 검증에 쓴다. 검사한 바이트를 격리 staging으로 고정해 재검증하고 그 staging에서 migration·전환한다.
- 패키지 version은 비교 가능한 semver로 정하고 기존 자유 형식 registry 값은 비교 불가 시 무변경·진단한다. plugin version은 패키지와 별개 신원이며 실제 fixture의 ref/version과 연결한다. 같은 version의 다른 digest는 무결성 충돌이다.
- DB migration은 파일별 commit이므로 이후 복사·registry 실패 때 SQL을 역행시키지 않는다. 기존 실행과 새 schema가 안전하게 공존하지 않으면 quiesce를 유지하는 복구 상태와 재시도 경로를 마련한다. 재시작 중 잠금·hold 소유권과 registry/파일 전환 경계를 시험한다.

## Verification

구현 단계에서 `pnpm build`, `pnpm typecheck`, `git diff --check`를 순서대로 실행해 종료 0을 확인한다. **모든 시험 실행은 21.8로 이관, 미실행**이다. 시험 코드는 빠짐없이 작성하고 독립 리뷰 및 필요한 후속 리뷰를 수행한다.

21.8 인계: 전용 합성 DB와 격리 홈(`withoutHarnessFolders`)에서 새·기존 Garmin 시험 포함 `pnpm test` → `pnpm test:python`을 순차 실행한다. 별도 대상 재검증은 해당 실패 원인 수정 뒤 관련 Vitest 파일을 지정해 수행한다. DB 업그레이드(이전 registry→새 schema, 소유자 migration checksum/실패 복구), role/schema 권한과 실행 차단, 대화·파일·채널 공용 기억의 업그레이드 전후 행 수·내용 해시, 사용자 설정·예약·회차와 패키지 영속 파일 보존, 동시 bootstrap/install·hold·실행 중 자식 및 모든 matrix 오류를 확인한다. 기준 SHA, 각 명령·종료 코드·로그, 소유 자원, 실패별 처분과 재검증을 남긴다.

준비: 별도 이름·사용 가능한 포트의 **이번 실행 소유** 임시 PostgreSQL 컨테이너를 만들고 `BRAIN_TEST_DATABASE_URL`을 그 관리자 URL로 지정한다. 예: `docker run -d --name brain-218-test -e POSTGRES_PASSWORD=synthetic -p 127.0.0.1:55432:5432 --tmpfs /var/lib/postgresql postgres:18`, `export BRAIN_TEST_DATABASE_URL=postgres://postgres:synthetic@127.0.0.1:55432/postgres`, `docker exec brain-218-test pg_isready -U postgres`. 이름·포트가 이미 사용 중이면 다른 소유 자원을 건드리지 않고 새 이름·포트를 정한다. 합성 자료만 생성하고 준비 완료 후 `pnpm test`, 이어서 `pnpm test:python`을 실행한다. 정리: 소유 컨테이너 ID를 대조한 뒤 `docker rm -f brain-218-test`, `unset BRAIN_TEST_DATABASE_URL`; 시험이 만든 격리 임시 홈만 제거한다. 실패·미실행이 남으면 21.8 built 및 21.7 시작을 막는다.

## Auto Run Result

**상태:** built. 사용자 인수 전이며 done으로 올리지 않았다. 모든 시험 실행은 **21.8로 이관, 미실행**이다. 시험 통과를 주장하지 않는다.

**구현:** `brain ext install --package <path>`가 선언 파일의 내용 digest·core release 호환성·symlink/경로 경계·migration 번호·Python 정적 입력을 확인한다. registry는 이름/version/digest/plugin version을 저장한다. 공통 home 설치 잠금 안에서 실행 core 신원을 재검사하고 해당 확장을 지속 owner로 정지한 뒤 migration·활성 파일 전환·registry·재개를 수행한다. snapshot 취소/자식 정리, stage/backup journal의 실패·중단 재진입, 기존 설정·예약·회차·영속 파일·활성 상태 보존을 연결했다. 낮은 version은 설치 상태를 바꾸지 않고 doctor 관측으로 진단한다.

core bootstrap은 격리 target에서 준비하고 안전 검사 뒤에만 공유 app을 승격한다. target의 승격 지원과 최종 app/build/shim/installed 신원을 확인한다. 기존 확장 migration에도 대상 core 호환 검사와 정지·안전 정산 확인·자기 owner 재개를 적용한다. 미정산 attempt·옛 schema·불명 실행기 또는 타 owner 상태는 관련 변경 전에 안내와 함께 거부하며 임의 회수하지 않는다. testext marketplace fixture의 진입점은 core 부재 시 안내만 하고 core가 있으면 동봉 package를 위임한다. package/digest 동기화·플러그인별 ref/version 규칙 시험 코드를 작성했다.

**주요 파일:** `apps/cli/src/runtime/extension-package{,-worker}.ts`, `extension-transition.ts`, `install-lock.ts`(검증·snapshot·전환); `packages/core/src/extensions/{install,manifest,quiesce,install-progress,migration-names}.ts`(프로토콜·이행); `packages/postgres/migrations/0034_extension_package_identity.sql`, `0035_extension_quiesce.sql`, PG store/work/schedules(신원·gate·회계); `apps/cli/src/install/{postgres,promotion-protocol}.ts`, daemon lock, bootstrap 원본/생성물(안전 core 갱신); 공개 상태/doctor·공통 fake/계약; `plugins/testext/`·marketplace·shared manifest fixtures·test-changed 규칙; 관련 CLI/PG/core/bootstrap 시험 코드.

**리뷰와 처분:** R1 thorough 4렌즈(23행: high4/medium17/false2), R2 thorough 4렌즈(19행: high3/medium12/low2/false2), R3 증분 3렌즈(7행: high1/medium3/false3), R4 app 승격 증분 2렌즈(1행: medium1)를 수행했다. 모두 독립 Codex Sol/medium이다. 실제 결함/시험 코드 공백은 지정 수정 Task로 처리했고 각 행의 기각·중앙 판단 근거는 Review Triage Log에 보존했다. `deferred`는 빈 단일 목록이다. R4 edge는 `[]`, verification의 npx installed 불일치 분기 공백은 소스 guard를 유지한 시험 코드 추가로 보완했다. R4 고유 patch는 medium1/high0이며 후속 pass의 high 수정이 없어 추가 리뷰 권고는 false다. 이 좁은 결론은 전체 런타임 시험 통과를 뜻하지 않는다. 원문과 수정 보고는 로컬 `.brain-automation/review/` 및 `.brain-automation/*-report.md`에 보존했다.

**검증:** 최종 지휘자 `pnpm build` 종료0, `pnpm typecheck` 종료0, `git diff --check` 및 cached check 종료0. 로그는 로컬 `.brain-automation/build-final.log`, `typecheck-final.log`다. 마지막 단일 시험 코드의 guard/단언을 정적으로 대조했다. 모든 직접 시험·fixture checker·`pnpm test:changed`·`pnpm test`·`pnpm test:python`은 실행하지 않았다.

**21.8 인계:** 전용 소유 시험 PG와 합성 자료·격리 home/withoutHarnessFolders에서 새·기존 Garmin을 포함한 `pnpm test` → `pnpm test:python`을 순차 실행한다. 이 티켓의 실제 CLI package 설치/갱신/거부/downgrade/doctor, 실행 core 대기 중 변경, 취소/FIFO/Unicode/정적 Python 입력, 지속 전환 실패·프로세스 중단·owner 재개, 실제 PG claim/fire↔gate 경쟁, supervisor 자식/후손과 DB 정산, bootstrap/package 동시 성공, app 승격 지원/실패/정리 재진입, 실제 TTY 및 JSON/비대화형 offline 확인, 다중 확장 실패/부분 gate 해제, 33→34→35 업그레이드·role 권한·설정/예약/회차/공용 대화·파일·채널 기억 보존, shared TS/Python manifest·ABI, fixture release/ref/digest, 기존 mock/출력 sink guard를 실행한다. 실패는 원인별 최소 수정 후 관련 시험을 재검증하며 기준 SHA·환경/소유 자원·명령·종료코드·로그·실패별 처분·재검증을 남긴다. 위 Verification의 소유 컨테이너 준비/정리 예시를 사용하되 자원 ID를 대조한다. 미실행/미해결이 있으면21.8 built 및21.7 시작 금지다.

**운영 조치·제약:** 이번 작업은 운영 DB/계정/예약/실데이터를 변경하지 않았다. 잔존 설치 잠금은 자동 회수하지 않는다. 새 설치 진입을 막고 이전 설치와 모든 쓰기 자식 종료를 확인한 뒤 해당 잔존 잠금만 수동 복구하고 같은 패키지/target으로 재시도한다. DB gate/전환 journal을 임의 삭제하지 않는다. 과거 미추적 직접 명령 자식이 남을 수 있는 cross-commit 갱신은 잠금 아래 운영자가 home·이전/목표 신원·시도 nonce에 결합된 offline 종료 확인을 입력해야 한다. 운영자 확인은 기계적 종료 증명이 아니며 매 시도 다시 필요하다. hook/JSON/비대화형·`--yes`는 이를 대체하지 못하므로 해당 자동 갱신은 거부된다. 일반 확장 설치에는 이 확인을 확대하지 않았다. 새 OS 감독·강제종료·영구 force 우회는 없다. 실제 이 Mac 전환은21.7 소관이다.

**잔여 위험:** 시험 실행을 유예했으므로 런타임 결함과 시험 harness 실패 가능성은21.8에서 확인해야 한다. 불명/legacy 상태의 안전 거부와 수동 복구 요구는 중앙이 승인한 가용성 제약이다. core 플러그인의 release ref는 구현 commit을 먼저 남긴 뒤 이를 가리키는 별도 ref/version 갱신 commit으로 정합화한다. main 병합/push와 중앙 state 수정은 수행하지 않는다.
