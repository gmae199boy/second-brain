---
title: '8.8 이 Mac Drive 설치본 검증'
type: chore
ticket: 8
created: '2026-11-19'
status: blocked
blocked_reason: 운영 릴리스 승인, OAuth 동의, 실제 계정의 첨부 및 문서 수락 대기
baseline_revision: '79dd6d4e3419f2767c538831b22bd50f61605a12'
route: full
route_source: pinned
risk: medium
review: thorough
review_source: pinned
lenses_ran: [blind-hunter, edge-case-hunter, verification-gap, intent-alignment]
review_loop_iteration: 3
followup_review_recommended: false
context: []
warnings: [oversized]
deferred: []
---

<intent-contract>

## 목표

이 Mac에서 공식 설치 경로와 가짜 Drive로 소스 연결·설정·색인·첨부 이전을 검증한다. 연결된 Drive로 기존 첨부 하나의 최초 이전을 요청하는 공개 CLI와 SDK를 연결한다. 실제 계정에서 연결·원본 이전·검색·재시작을 검증하기 위한 운영자 절차를 남긴다.

## 범위

별도 홈, 신규 전용 PostgreSQL, 루프백 가짜 Drive와 합성 데이터만 사용한다. 운영 설치의 배포 신원과 명령 지원은 공개 메타데이터로 확인한다. 최초 이전 요청은 첨부 ID 한 건으로 한정하며 기존 큐와 handler를 쓴다. 일괄 또는 자동 업로드, 외부 파일 경로, 동기 처리, 새 migration은 범위 밖이다. 별도 승인이 필요한 운영 OAuth, 운영 자원, 실제 문서와 플러그인 배포는 운영자 단계다.

</intent-contract>

## Code Map

- `plugin/bootstrap.mjs`와 `apps/cli/src/install.ts`가 고정 ref 설치·승격·shim을 제공한다. `apps/cli/src/config/resources.ts`가 홈별 Compose 자원을 정한다.
- `apps/cli/src/dispatch.ts`의 `shouldDrain`은 정상 진단 뒤 기회 drain을 허용한다. `doctor run`의 실패는 drain을 막으며 daemon heartbeat가 살아 있으면 기회 drain을 생략한다. `queue drain`은 명시적으로 큐를 처리한다.
- `apps/cli/src/commands/sources-control.ts`, `sources-sync.ts`, `apps/cli/src/runtime/drive-runtime.ts`가 연결·감시·동기화를 제공한다.
- `packages/core/src/files/drive-migrate-work.ts`와 `packages/postgres/src/drive.ts`가 검증, 위치 전환, 만기 삭제를 처리한다. `packages/core/src/brain.ts`는 일감 handler를 등록한다.

## Tasks & Acceptance

### 제품 구현

1. `packages/core/src/brain.ts`, `packages/core/src/files/`, 기존 store port 및 `packages/postgres/src/drive.ts`에서 `BrainFiles.migrateDrive`를 연결한다. 연결된 Drive와 가리지 않은 실제 첨부의 유효한 Brain home을 확인한다. 기존 첨부 provenance, 위치 확인, Source fence, `addWork` 열린 대상 합치기 및 handler/CAS를 재사용한다. 외부 source 전용, 노출된 외부 위치, 무관·가림·없는 파일·다른 루트를 거절한다. 동일 열린 대상과 확인된 기이전 상태는 멱등하게 처리한다. 진입점은 원격 I/O 없이 대기 또는 기이전 상태를 반환한다. 소유권/연결 세대 재확인과 기존 redact 정리/재예약 의도의 동작을 보존한다.
2. `apps/cli/src/commands/`, `plugin/skills/brain-files/SKILL.md`, `README.md`, 직접 관련 커버리지에서 `brain files migrate-drive <file-id> --json`을 공개한다. 파일 ID만 받으며 write guard를 통과할 때 한 건을 enqueue한다. 기회 drain은 끈다. 응답은 안전한 상태와 필요한 작업 ID로 한정한다. 문서에 사용자 요청으로만 전송하고 검증 후 보관 기한에 로컬 사본이 삭제될 수 있음을 포함한다.
3. `apps/cli/test/drive-tracer.test.ts` 또는 직접 관련 기존 파일에 공개 CLI enqueue → 실제 worker → 가짜 서버 bytes·기이전·보관 경계 시험을 작성한다. 열린 작업 합치기, 연결 해제와 미연결, 외부/무관/가림 ID, 글로벌 임의 drain 미실행을 실제 표면에서 검증한다. 기존 reader·doctor 동작과 schema는 보존한다.

Given 연결된 Drive와 유효한 로컬 첨부, when 동일 파일의 이전을 반복 요청, then 열린 작업 한 개가 반환되고 worker가 검증 뒤 home을 전환한다. Given 유효한 작업 완료, when 다시 같은 루트에서 요청, then 기이전 상태를 반환하며 추가 업로드가 없다. Given 파일·연결·위치가 부적격, when 요청, then 안전한 오류와 새 이전 작업 0건이다. Given 만기 전 또는 원격 재확인 실패, when drain, then 로컬 사본이 남는다.

### 지휘자 검증 및 운영자 인계

- [x] 설치본의 ref·schema를 대조하고 shim에서 `sources`, `doctor run`, `config get/set`을 검증한다.
- [x] 가짜 서버 시험에서 8.1 이전·보관, 8.2 동기화, 8.3 OAuth·해제, 8.4 PDF/DOCX·Carry, 8.5 변경·재개, 8.6 문서 통합 검색을 대조한다.
- [x] 공개 최초 이전 진입점과 doctor의 drain을 감사하고, 운영자 입력·실패 시 복구 절차·공개 투영을 기록한다.

격리 홈과 빈 전용 DB에서 공식 설치를 실행했을 때 설치 기록과 빌드 ref가 일치하고 설치된 shim으로 sources와 기간 설정을 호출할 수 있어야 한다. 합성 Drive에서 연결·검색·원본 검증·만기 전 보존·재시작을 확인한다. 승인된 실제 계정, 폴더와 첨부에서 별도 검증이 끝날 때까지 실제 단계의 성공 건수는 미측정으로 둔다.

## Implementation Notes

`brain files migrate-drive <file-id> --json`과 `BrainFiles.migrateDrive`가 가리지 않은 Brain 첨부 한 건의 이전을 예약한다. 접수는 Drive 연결, 계정·루트, 세대, 소유 위치와 첨부 provenance를 확인한다. 기존 일감과 저장소 구현으로 동일 대상을 합치고, 실패 재시도는 확인된 원 작업의 결속을 보존한다. 실제 전송·검증·home 전환·만기 삭제는 기존 worker 경로를 쓴다. 접수와 기이전 조회에는 기회 drain이 없다. 이전을 시작하는 공개 명령은 설치본 변경으로 검증했고, 원격 전송과 생애주기는 루프백 합성 Drive로 검증했다.

운영 설치의 공개 빌드 기록과 Git HEAD는 `cf6e72a3a3c7184bb1bbbbe50bb2f6d40928af0e`, core schema 48이다. 컴파일된 레지스트리에서 Drive sources 6개 명령과 `drive.keep_local_days` 지원을 확인했다. 새 이전 명령은 해당 설치에 등록되지 않았다. 운영 doctor는 호출하지 않았다. `doctor run`은 실패 시 기회 drain을 생략하며 정상 점검과 유효한 설정에서 daemon heartbeat가 없으면 명령 종료 전에 drain을 수행할 수 있다. 이 분기는 스키마를 교체하지 않지만 큐를 처리할 수 있다.

## Plan Change Log

### R1 재도출

접수 시 검증한 Drive 루트·연결 세대를 기존 저장 구조로 대기 일감에 결속하고, 첫 원격 요청 전 확인한다. 이미 진행 중인 내부 이전 복구와 가림 정리를 보존한다. 파일 및 기존 열린 일감을 함께 처리하는 모든 트랜잭션은 양쪽 잠금의 역순 획득을 제거한다. 제품 스키마, 단일 첨부·첨부 provenance·공개 응답·다른 계정 및 루트의 차단·기존 검증/보관 계약은 유지한다.

### R2 재도출

일반 실패 재시도가 승인된 이전의 동일 결속을 유지하도록 실패-원 작업 인계를 정리한다. 서로 다른 결속의 일반 업로드를 거부한다. 같은 계정·루트에서 세대만 바뀐 경우에는 가림된 기존 제출의 정리만 허용한다. 실제 HTTP 전송마다 대상과 청구를 점검하고 확정과 begin에서 DB와 시계를 재확인한다. R1에서 제거한 잠금 역순과 새 수락 시험을 보존한다.

### R3 경합 보완

설정과 claim의 최종 결합 검사를 기존 source→settings→work 순으로 맞춘다. 미전송 begin도 같은 전제조건을 확인한다. 원격 제출 확인과 cleanup 사이 중단은 같은 root의 uploaded 가림 의도를 재개해 처리한다. 실제 원격 호출이 시작된 이후의 처리와 결과 불명 경계는 기존 안전 정책을 유지한다.

## Review Triage Log

### 2026-11-19 — R1

네 Sol 6.2 medium 리뷰 원문은 전용 작업 증거의 `review-r1-*.md`다. 같은 문제가 여러 렌즈에서 보고되어 각각의 판정을 보존했다.

| 렌즈와 발견 | 판정 | 처분과 근거 |
|---|---|---|
| Blind 1 루트·세대 유실 | high | bad_plan — 큐에는 파일 ID만 있고 시작할 때 현재 루트가 정해진다. 예약 결속으로 재도출한다. |
| Blind 2 교착 | medium | bad_plan — 요청은 file→work, 확정은 work→file 순서다. 내부 begin도 포함해 잠금 순서를 바로잡는다. |
| Blind 3 대문자 UUID | medium | patch — UUID 텍스트가 소문자로 투영된다. 공개 경계에서 정규화한다. |
| Blind 4 외부/루트 시험 | medium | bad_plan — DB 불변식을 지키는 외부 위치 대조와 실제 활성 루트 변경 fixture를 둔다. |
| Blind 5 실제 due 대조 | medium | bad_plan — 현재 시각의 무관한 일감과 원격 재검증의 관측을 추가한다. |
| Blind 6 격리 ref/어댑터 | medium | patch — 로컬 Git ref 설치와 네트워크를 주입한 직접 관련 시험 양쪽의 실행 경로를 아래에 기록한다. |
| Blind 7 목록·설정 루트 차이 | medium | patch — 실제 업로드용 설정을 승인된 루트와 대조한다. |
| Edge 1 대문자 UUID | medium | patch — Blind 3과 같은 UUID 비교 경로다. |
| Edge 2 교착 | medium | bad_plan — Blind 2와 같은 잠금 경로다. |
| Edge 3 루트 변경 | high | bad_plan — Blind 1과 같은 예약·실행 경계다. |
| Edge 4 외부 위치 | medium | bad_plan — 외부 home은 DDL이 금지한다. 현실적인 외부 첨부로 거절과 무일감을 검사한다. |
| Edge 5 무관/만기 | medium | bad_plan — Blind 5와 같은 두 관측 공백이다. |
| Edge 6 기이전 루트 | medium | bad_plan — 합성 상태를 현재 설정과 이전 home 루트가 다른 구조로 만든다. |
| Verification 1 불가 home | medium | bad_plan — DB가 허용하는 불가 위치와 외부 위치, 작업 부재를 관찰한다. |
| Verification 2 루트·미검증 | medium | bad_plan — 설정 검사와 저장된 home/intent 검사에 진입하는 입력을 구별한다. |
| Verification 3 부적격 ID | medium | patch — 잘못된 ID와 없는 ID의 공개 오류를 검증한다. |
| Verification 4 오래된 세대 | medium | bad_plan — 재연결 뒤 이전 세대와 새 세대의 결과가 달라야 한다. |
| Verification 5 동시 동작 | medium | bad_plan — 서로 다른 연결이 같은 진행 중인 일감을 공유하는지 확인한다. |
| Verification 6 무관 drain | medium | bad_plan — 대기와 기이전에 실제 실행 가능한 대조를 둔다. |
| Verification 7 기본 런타임 및 schema | medium | patch — 기본 조립과 전용 DB에서 schema guard 경계를 관찰한다. |
| Verification 8 보관 | medium | bad_plan — 공개 예약 경로에서 실제 home, 만기 due, 원격 검증, 0·30일을 검증한다. |
| Verification 기타 1 다른 루트 | high | bad_plan — Blind 1과 같다. |
| Verification 기타 2 대문자 UUID | medium | patch — Blind 3과 같다. |
| Intent 1 루트 변경 | high | bad_plan — 승인 대상과 실제 런타임의 차이를 없앤다. |
| Intent 2 대문자 UUID | medium | patch — SDK와 CLI 동일 계약으로 정규화한다. |
| Intent 설치 표면 | medium | patch — shim 실행, 기본 런타임 접수와 가짜 Drive 전송을 각각 증명한다. |

### 2026-11-19 — R2 후속

- `[high]` `[bad_plan]` 실패 재시도 결속 유실. `failures retry`가 키 없는 일감을 새로 만들어 현재 루트에서 전송할 수 있다.
- `[high]` `[bad_plan]` 세대 변경 후 가림 원격 정리 불가. 같은 계정·루트에서 읽기와 복구만 허용하고 대상 변경 또는 새 업로드는 허용하지 않는다.
- `[medium]` `[bad_plan]` 초기 토큰과 401 갱신 대기 중 실제 fetch 경계 누락 및 확정의 루트 미검사. 전송 직전과 저장소 확정의 전제조건을 명확히 한다.
- `[medium]` `[patch]` begin에서 만료된 청구가 의도를 만들 수 있다. 잠금 획득 이후 시계로 검사한다.
- `[medium]` `[patch]` 경합, 가림 삭제, 미검증 home, HTTP 재전송 시험의 대조군이 일부 다른 분기로도 통과한다. 정밀 회귀에 포함한다.
- `[low]` `[reject]` 독립 외부 source reader의 회귀가 있다는 결론은 확인되지 않았다. 별도 adapter를 쓰며 오래된 첨부 reader의 guard는 기존 연결 안전 경계와 함께 유지한다.

### 2026-11-19 — R3 후속

- `[medium]` `[bad_plan]` 최종 청구 대기 중 설정 변경. 전송 직전 결속과 청구를 한 트랜잭션에서 확인하고 파일 처리 begin에도 적용한다.
- `[medium]` `[patch]` 확인 후 프로세스 중단으로 삭제 재예약 누락. 같은 연결·루트의 가린 uploaded 매핑을 재개한다.
- `[medium]` `[bad_plan]` 설정 변경 뒤 생성된 미전송 의도. begin의 source/설정 검증을 작업·파일 잠금에 앞서 수행한다.
- `[medium]` `[patch]` 신규 가림 복구가 쓰는 DELETE는 token 대기 뒤 청구 취소를 확인한다. 기존 결과 불명 DELETE 정책은 유지한다.
- `[medium]` `[patch]` 실제 전송과 공개 재승인의 최종 상태를 관찰하도록 직접 시험을 보강한다.

### 2026-11-19 — R4 후속

독립 Sol 6.2 medium이 승인·청구 결합, 중단 뒤 가림 정리 재개, DELETE 최종 청구, 과거 결속의 상수 시간 대조를 확인했다. 추가 제품 문제는 0건이다. `[medium]` `[patch]` PostgreSQL 청구 계약의 빈 fixture에 합성 자기 사용자를 삽입해야 설정 대조에 도달한다. 지휘자가 바로잡은 뒤 build·typecheck·diff가 종료 0이었다.

## Verification

`pnpm build`, `pnpm typecheck`, `git diff --check` 후 최종 단계에서 직접 관련 파일을 지정해 한 번 실행한다. 설치와 직접 시험은 공용 시험 잠금을 획득한 뒤 실행한다. 리뷰를 반영한 변경을 임시 로컬 Git 저장소의 검증용 ref에 적용하고 `SECOND_BRAIN_REPO`로 이를 지정한다. 공식 bootstrap에서 고정 ref로 설치한 shim의 sources/doctor/config를 실제 신규 전용 PostgreSQL로 검사한다. 가짜 Drive의 네트워크는 직접 관련 CLI/SDK 시험에서 루프백 어댑터를 주입해 검증한다. 이 증거를 실제 Google OAuth나 실문서 성공으로 계상하지 않는다. 전체 TS·Python 회귀는 중앙이 수행한다.

### 설치 및 직접 검증 증거

- build·typecheck·diff 종료 0. 전체 TS·Python 회귀는 중앙 통합 단계에 남긴다.
- 최초 직접 실행은 15파일 507사례에서 502통과·5실패, 종료 1이었다. fixture의 부수 작업, 잠금 관측, 원 작업이 없는 합성 실패 및 CLI `--target-kind` 필터 결함을 수정했다. 관련 두 파일의 재시험은 78통과·0실패, 종료 0이었다. 동일 파일·시험명으로 최초 실패 5건 모두 통과를 확인했다. 실패 재시도를 직접 다루는 기존 CLI 두 파일도 90통과·0실패, 종료 0이었다. 파일별 최신 결과의 합집합은 17파일 598통과·0실패·0건너뜀이다.
- 가짜 서버에서 OAuth 수락·연결 유지, 첨부 쪽 업로드와 원격 검증, 텍스트·Markdown·Google Docs 및 PDF/DOCX의 소스 동기화와 본문 검색·링크, 0일과 30일 보관·원격 소실 시 로컬 보호, 재시도·가림·세대 경계를 확인했다.
- 공식 bootstrap은 로컬 Git 검증 ref `8e59cac25bca9e4b7b468765c18e6cd6a7a16de7`를 새 홈에 설치했다. 설치 기록과 빌드가 같은 ref 및 schema 48을 기록했다. 오프라인 시도 두 건은 공개 패키지 메타데이터 부재로 종료 1이었다. 공개 npm 메타데이터를 받아 공급망 검사와 고정 잠금 파일을 유지한 재시도는 종료 0이었다.
- 설치된 shim에서 비연결 sources 목록, 보관 기간 기본 30일과 DB 변경 7일의 재조회, 합성 첨부 접수 1건과 HTTP 시도 0건을 확인했다. doctor는 통과 28·경고 3·실패 0·건너뜀 1이었다. launchd 등록을 격리 경계에서 차단했으므로 실제 launchd 설치 상태는 운영 수락에 남는다. 전용 PostgreSQL Compose의 컨테이너·볼륨·네트워크를 제거했다.
- Sol 6.2 medium 독립 리뷰 네 렌즈와 후속 확인을 완료했다. 최종 수정에서 새 제품 문제는 보고되지 않았다. 모의 원 작업 부재 시험은 메모리 저장소에서 검증하고 실제 PostgreSQL의 공개 재시도 성공은 tracer로 검증했다.

## operator_actions

1. **릴리스 승인과 대상 확인.** 현행 저장소 플러그인은 `0.1.38`, app-ref는 `c321bf0275d14dfb3bd0146fad1f59b9d87d3ccc`다. 중앙이 검증된 제품을 main에 통합한 뒤, 최초 이전 CLI가 포함되고 원격에 이미 존재하는 **선행** 커밋 전체 SHA를 대상으로 고른다. `plugin/app-ref`와 `plugin/.claude-plugin/plugin.json`의 버전을 같은 후속 배포 커밋에서 바꾼다. `0.1.39`는 `0.1.38`이 그때도 최신이면 쓸 다음 버전이다. 마켓플레이스를 갱신하고 새 캐시의 ref를 대조한다. 운영자가 업그레이드를 승인한 뒤 README의 `--interactive-ref --ref <대상-SHA> --yes --plugin-root <새-플러그인-폴더>` 방식으로 적용한다. 설치·빌드 기록과 대상 SHA를 비교한다.
2. **OAuth 준비와 동의.** 사용자가 Google Cloud의 대상 프로젝트에서 Google Drive API를 활성화한다. Google Auth Platform의 Branding을 설정하고 Audience에서 허용 대상을 검토한다. 개인 Google 계정의 External 앱을 Testing 상태로 쓸 경우 Test users에 승인 계정을 추가한다. Drive 범위를 사용하는 External Testing의 refresh token은 7일 제한이 있으므로 장기 상시 동기화의 증거로 삼지 않는다. Data Access의 두 범위는 `https://www.googleapis.com/auth/drive.readonly`와 `https://www.googleapis.com/auth/drive.file`이다. Clients에서 Desktop app을 생성한다. 현재 연결을 교체해야 한다면 별도 대상 승인부터 받는다. [Google Drive 시작 안내](https://developers.google.com/workspace/drive/api/quickstart/js) · [OAuth 자격 증명](https://developers.google.com/workspace/guides/create-credentials) · [OAuth 앱 상태](https://developers.google.com/identity/protocols/oauth2/production-readiness/overview).
3. Brain 사용자가 실제 터미널에서 Brain 홈(`${SECOND_BRAIN_HOME:-$HOME/.second_brain}`)의 `.env`를 로컬 편집한다. 기존 줄을 보존하고 모드 0600으로 `BRAIN_DRIVE_CLIENT_ID="<desktop-client-id>"`, `BRAIN_DRIVE_CLIENT_SECRET="<desktop-client-secret>"` 두 항목만 준비한다. Drive refresh token은 제품이 동의 후 저장한다. `brain sources connect drive --json`을 실행하고 로컬 동의 URL을 열어 승인한다. 채팅·로그에는 URL·코드·이메일·키를 남기지 않는다. 사용자나 운영자는 동의 완료 여부만 중앙 Run에 회신한다. 원문의 `bmad-loop confirm` 단계는 현 자동화의 중앙 재개 승인으로 대체한다. [데스크톱 OAuth와 루프백](https://developers.google.com/identity/protocols/oauth2/native-app).
4. **검증 대상 승인.** 기존 연결의 계정이 승인 대상과 일치하는지 사용자가 확인한다. 작은 지원 형식 문서 하나를 담은 검증 전용 폴더 하나, Brain이 가진 손실 허용 가능한 첨부 원본 하나, 로컬 보관 기간을 승인한다. 폴더는 동기화 대상 하위 트리 전체가 승인 범위여야 한다. 구체 ID와 문서 본문은 터미널 안에서만 사용한다.
5. **첨부와 외부 문서.** `brain sources list --json`에서 연결과 저장된 source 루트를 확인한다. `brain config get drive.root_folder_id --json`으로 실제 업로드 대상도 승인된 루트와 대조하고 출처 루트와 다르면 진행을 멈춘다. `brain config get drive.keep_local_days --json`으로 기본 또는 DB 값을 확인하고 변경 승인이 있을 때만 `brain config set drive.keep_local_days <days> --json`을 실행한다. 기본 30일을 권장하며 0은 검증 직후 삭제 일감이 실행 가능해진다. 조건을 확인한 뒤 `brain files migrate-drive <file-id> --json`에서 대기를 확인한다. 일감 ID로 완료를 확인하고 검증된 Drive 원본과 만기 전 로컬 사본을 확인한다. `brain sources add <folder-id> --json` → `brain sources sync <source-id> --json` → `brain recall docs <본문-검색어> --json`으로 문서를 찾는다. 사용자가 반환된 Drive 링크로 원문을 대조한다. 승인된 재시작 뒤 연결·기간·검색이 유지되는지 확인한다. 기한 도달 뒤 Drive 원본의 바이트 재검증이 성공한 경우에만 로컬 사본이 사라진다. 실제 기한을 기다리지 않았다면 만기 삭제 관찰은 미실행으로 기록한다.
6. **실패와 롤백.** 응답 유실이나 원격/로컬 사본이 불분명하면 원격 또는 로컬 파일을 수동 삭제하지 않는다. 대상 이전이 열린 상태이면 제품의 큐 취소와 결과를 확인한다. 추가한 감시 항목만 `brain sources remove <folder-id> --json`으로 제거한다. 새로 만든 연결의 해제는 계정 단위이며 별도로 승인받는다. 해제가 원격 원본 삭제나 이미 완료한 home 이전의 복구를 수행한다고 가정하지 않는다. 이전 후에는 기간을 단축하지 말고 검증된 양쪽 위치와 home 상태를 확인한다. 호환되는 설치/DB 복구 경로 또는 forward fix를 중앙과 검토한다. 공식 설치기가 후방 ref를 거절하므로 이전 app 디렉터리만 바꾸거나 schema를 내리지 않는다.

## 공개 투영

공개 계획에는 단계, 통과·실패·미실행, 종료 코드, 건수 및 필요한 운영자 조치만 남긴다. 실제 계정, ID, 파일명·경로·본문·검색어·URL·OAuth 자격 증명은 운영 터미널 밖으로 옮기지 않는다. 합성 검증의 건수와 실제 운영 수락의 건수를 각각 기록한다. 8.6의 이전 회귀 기록은 실패 환경을 교정한 여러 실행의 합집합이다. 이번 직접 관련 시험으로 전체 회귀를 다시 판정하지 않는다.

## Auto Run Result

제품 보완, 독립 리뷰, 직접 시험, 공식 격리 설치를 완료했다. 실계정 수락 상태는 `awaiting-operator`다. 운영 릴리스, 실제 OAuth 동의, 승인된 첨부와 폴더의 검색·원문 확인·재시작·기간 검증은 위 운영자 조치로 남긴다. 실계정 단계의 성공과 실패 건수는 미측정이다.
