판정: 수정 후 재검증 — fix 4 / suggest 2 / ask 0

검토일: 2026-10-28. 대상은 epic 12의 미커밋 에픽과 12개 entry다. Ticket·Set·Dependencies 및 `ticket.md`의 “Rules the template cannot carry”를 적용했다. 메인 checkout의 렌더된 검사 규칙 두 파일을 읽었으며, 이 worktree의 코드·선행 계획·소비 에픽을 정적으로 대조했다. 테스트·빌드·Docker·네트워크·설치는 실행하지 않았다. 이 보고서만 새로 썼다.

## fix

### F1 — 키 보장에서 core 일감을 일괄 제외하는 문장이 에픽보다 범위를 좁힌다

- 근거: `_bmad-output/personal-brain/tickets/epic-jobs-and-scheduler/tickets/tickets.toml:80`은 “core 일감은 키·용량과 무관하다”고 한다. `_bmad-output/personal-brain/tickets/epic-jobs-and-scheduler/epic-jobs-and-scheduler.md:42`의 E12-8은 일감의 선택 직렬화 키와 DB 보장을 정하고, `:91`의 Decision은 **core drain**이 감독자 용량과 무관하다고 정한다. `_bmad-output/personal-brain/tickets/epic-health-analysis/epic-health-analysis.md:15`는 모델 분석도 core 소유 일감이라고 한다.
- 문제: 소유 주체인 core와 실행 분류 `core | supervised`를 혼용하면 core 소유 모델 일감까지 키·용량 보장에서 제외할 수 있다. 용량에서 core drain을 분리하는 결정은 있으나 키가 있는 일감을 소유 주체만으로 제외하는 결정은 없다. entry 1의 “core 일감 종류 `process_probe`”도 이 해석을 어렵게 한다(`tickets/tickets.toml:8`).
- 변경: 7의 문장을 “짧은 core drain은 감독자 용량을 쓰지 않는다. supervised로 등록한 일감은 core 소유라도 감독자 용량과 지정한 키 보장을 따른다”로 명확히 한다. 키의 적용 범위는 E12-8과 맞춘다. 1에는 `process_probe`가 core가 제공하는 **supervised 실행 분류**임을 명시하고, 7의 검증에 그 probe가 용량·키를 소비하는 사례를 넣는다. 새 정책을 묻는 항목이 아니라 기존 실행 분류 결정의 용어 정리다.

### F2 — OS 시작 신원 조회의 알려진 불확실성이 착수 게이트에 없다

- 근거: `_bmad-output/personal-brain/tickets/epic-jobs-and-scheduler/tickets/tickets.toml:20`은 macOS 시작 신원을 얻는 방법을 plan에서 정한다고 하지만 2에는 `unknown`이 없다. `_bmad-output/personal-brain/tickets/epic-jobs-and-scheduler/epic-jobs-and-scheduler-research-code.md:62`는 현재 신원 조회가 없고 `started_at`이 잠금 획득 시각일 뿐이라고 확인한다. 에픽의 `_bmad-output/personal-brain/tickets/epic-jobs-and-scheduler/epic-jobs-and-scheduler.md:37`은 이 신원으로 재사용 PID를 구별해야 한다.
- 문제: 단순 필드명 선택과 달리 OS 조회 방법·정밀도·조회 실패의 판정은 재시작 때 다른 그룹을 죽이지 않는 계약의 전제다. 가짜 신원만으로 통과하고 실제 macOS 경계를 미루지 않도록, 알려진 기술 불확실성을 board에 드러낼 필요가 있다.
- 변경: 2의 `unknown`에 “macOS에서 PID 재사용을 구별할 시작 신원 조회와 실패 판정 방법, 실제 Node 자식으로 확인할 방법”을 기록하고, 정제/착수 게이트에서 해결 결과를 남긴다. 사용자 정책을 다시 묻거나 이 정적 검토에서 OS 실험을 하라는 뜻은 아니다. OS 신원 조회가 증명되지 않은 경우는 이미 결정된 `unknown` 차단을 따른다.

### F3 — 선행 산출물을 주고받는 양쪽 설명에 인계가 완성되지 않았다

- 근거: `_bmad-output/personal-brain/tickets/epic-jobs-and-scheduler/tickets/tickets.toml:8`은 11.1 runner를 소비한다고 쓰고, `:11`은 11.3·11.9·11.10·11.11을 기다린다. 같은 파일 `:92`·`:95`는 11.6의 시간대를 소비한다. 반면 `_bmad-output/personal-brain/tickets/epic-postgres-primary/tickets/tickets.toml:8`의 runner 인계는 8·9만, `:80`의 설정 인계는 확장 키 자리만 명시한다. `:116`·`:128`·`:140`에도 12.1이 받을 데몬·fixture·마이그레이션 경계를 명명한 인계가 없다. 11.3의 `:44`는 임대 갱신·현지 예약이 12의 범위라고는 적는다.
- 문제: 의존 ID들은 유효하지만 Dependencies의 “양쪽 description이 인계를 말한다”는 조건이 부족하다. 특히 11.1 runner는 비동기 실행만 보장하고 장수 프로세스 핸들은 보장하지 않는다. 조사도 이를 구별한다(`_bmad-output/personal-brain/tickets/epic-jobs-and-scheduler/epic-jobs-and-scheduler-research-code.md:68`).
- 변경: 선행 계획을 담당하는 쪽에 다음 인계 문장을 반영하도록 요청한다. 11.1은 runner를 12.1에도 제공하되 streaming·그룹 감독 확장은 12.1 소유, 11.3은 PG work/schedule 계약 runner를 12.1에 제공, 11.9는 backoff를 유지할 PG 데몬 조립을 제공, 11.10은 고정된 0001과 PG fixture/다음 마이그레이션 경계를 제공, 11.11은 SQLite 제거 뒤 수정할 경계를 제공, 11.6은 설정 port와 `timezone` 읽기 계약을 12.8에 제공한다. 12.1·12.8도 이를 받는다고 각각 명시한다. 실제 경로와 시그니처는 11 완료 HEAD에서 확인한다. 이 보고서는 선행 계획 파일을 수정하지 않았다.

### F4 — 이름공간 보류와 core 분석 보류 사이의 인계가 빠졌다

- 근거: `_bmad-output/personal-brain/tickets/epic-jobs-and-scheduler/tickets/tickets.toml:116`·`:117`의 10은 `<ext>.*` 일감/예약을 보류하며 “core 일감은 영향을 받지 않는다”고 한다. 에픽 `_bmad-output/personal-brain/tickets/epic-jobs-and-scheduler/epic-jobs-and-scheduler.md:86`의 Decision은 그 확장의 데이터를 읽는 core 분석 예약도 멈춘다고 정했다. 소비 측 `_bmad-output/personal-brain/tickets/epic-health-analysis/epic-health-analysis.md:63`은 그 분석의 진행 취소·대기 보류·재개까지 정하고, `_bmad-output/personal-brain/tickets/epic-extensions/epic-extensions.md:57`도 같은 결정을 갖는다.
- 문제: `<ext>.*`만 고르는 계약으로 core 소유 분석을 자동으로 찾을 수는 없다. 분석 대상 연결은 18이 만들 일이지만, 10의 “core는 영향 없음”이 무조건적인 불변식으로 굳으면 소비 측의 확정 결정과 충돌한다. 어느 쪽이 core 분석을 보류 대상에 연결하는지 현재 설명만으로는 알 수 없다.
- 변경: 에픽 Boundaries/Notes에 “12는 공통 보류·취소·재개 수단을 제공하고, 13의 registry와 18이 확장 데이터를 읽는 분석 일감·예약을 그 수단에 연결한다”는 인계를 추가한다. 10은 외부 소비자가 대상 연결을 할 수 있는 계약을 제공한다고 쓰고, 검증의 “core 영향 없음”을 **그 확장에 연결되지 않은 core 일감**으로 한정한다. 13·18의 설명에도 받는 수단과 연결 책임을 적는다. 실제 분석/registry 구현을 12로 당기거나 비활성화 정책을 재결정할 필요는 없다.

## suggest

### S1 — tracer의 최소 산출물과 정상 경로의 마감선을 plan에서 더 엄격히 제한한다

- 근거: `_bmad-output/personal-brain/tickets/epic-jobs-and-scheduler/tickets/tickets.toml:8`·`:9`의 1은 등록부·migration·attempt·WorkStore/fake/PG·ABI·OS process port·감독자·데몬 조립·probe·실제 PG 통합을 관통한다. 조사 `_bmad-output/personal-brain/tickets/epic-jobs-and-scheduler/epic-jobs-and-scheduler-research-code.md:160`은 이 묶음이 가장 넓다고 경고한다. 현재 `apps/cli/src/daemon/run.ts:258`·`:308`은 회차 Store를 열고 닫고, `packages/core/src/queue/drain.ts:258`은 handler를 직렬 await하므로 단순 연결만 하는 작업도 아니다.
- 이유: 층을 빼면 tracer가 깨지므로 현재 정상 경로 분할은 타당하다. 다만 파일 수가 많아 한 에이전트 세션 크기인지는 정적 계획만으로 확신하기 어렵다. “최소 칸”과 후속 2~5 지정은 좋은 제한이다.
- 제안: 1의 plan에서 정상 progress→result 한 종류와 probe 한 건에 필요한 port/DDL/fixture만 열거하고, 오류 행렬·최종 ABI 배포 완성·doctor·list의 소유자는 각각 2~5·9로 고정한다. 실제 모델/확장 실행 등록은 열지 않는다. 실제 11 인계 코드를 읽고도 세션을 넘는다면 비필수 완성을 명명한 후속 story로 분리하되, 1의 PG→감독자→자식→token 결과 확정 및 동시 수집 경로는 유지한다. 이미 결정된 tracer·공유 코드 직렬 순서를 다시 묻지 않는다.

### S2 — 가짜 시간과 새 PG 통합 시험의 실행 진입점을 공통 산출물로 지정한다

- 근거: `_bmad-output/personal-brain/tickets/epic-jobs-and-scheduler/tickets/tickets.toml:9`·`:21`·`:81`은 시험 이름/명령을 plan에 적는다고 한다. `:33`·`:45`·`:57`·`:69`·`:93`·`:105`·`:117`은 접근법은 있으나 같은 재실행 약속이 없다. `packages/core/src/testing/fakes/clock.ts:4`·`:13`은 `now()` 값만 바꾸며 timer를 진행시키지 않는다. `apps/cli/src/daemon/run.ts:70`의 seam에도 가짜 프로세스 port는 아직 없다. `tooling/test-db/src/global-setup.ts:86`은 URL이 없으면 Docker를 사용할 수 있는 setup이다.
- 이유: entry 단계에서 아직 만들지 않은 테스트 파일명을 요구할 필요는 없다. 그래도 700초·15/25분·유예 시간을 비작성자가 실제로 기다리거나 Clock 값만 바꿔 성공시키지 않도록 공통 harness 소유자를 지정하면 검증 접근법이 더 명확해진다.
- 제안: 최초 사용자 1이 제어 가능한 timer/clock·process harness와 PG 격리 setup을 제공하고 2·5·8이 재사용한다고 쓴다. 모든 새 계약 밖 시험은 plan에 실행 명령/selector, fake 또는 실제 Node 자식 구분, PG 사전 조건과 성공 관찰값을 남긴다고 통일한다. OS 그룹 종료는 실제 child/손자 시험, 600초·정체·DST는 제어 시간 시험으로 구분한다. 12의 사람 확인에는 개발/운영 홈과 예약 성공 기록을 초기화하는 재실행 절차도 남기면 좋다.

## ask

없음. 놓친 예약·정체 창·usage 표시·비활성화·용량·ABI 소유권·무인 루프·최종 사람 확인은 기록된 Decision을 따른다. 위 fix는 그 결정의 적용 범위와 인계를 명확히 하는 일이다.

## 확인한 항목

- 메인 checkout의 `~/github/second-brain/_bmad/render/bmad-agent-po/second-brain-bbe56f7ddda0/dcffd73a7f031ef42569/references/validate-checks.md`와 같은 디렉터리의 `ticket.md`를 읽었다. entry는 모두 description·verify·risk를 갖고 placeholder와 estimate는 없다. 아직 leaf가 없고 `refine = true`도 아니므로 full criteria가 없는 사실 자체는 위반이 아니다. risk 이유와 high-risk 추가 점검은 leaf 정제 때 Notes에 남겨야 한다.
- 인용한 에픽·sources·companions·선행 계획·후속 에픽·설계 입력을 열어 대조했다. 코드 근거는 현재 worktree의 정적 코드다. epic 11 계획을 현재 구현으로 간주하지 않았다. 새 마이그레이션은 11의 checksum 고정 뒤 다음 번호이고 0001 수정은 금지다.
- 지정한 `uv run ~/.agents/skills/bmad-agent-po/scripts/tickets.py --project-root "$(git rev-parse --show-toplevel)" status _bmad-output/personal-brain`은 성공했다. 첫 실행은 uv 캐시 쓰기 권한 때문에 실패했고 승인된 재실행으로 확인했다. epic 12는 `refined: true`, `next_id: 13`, 12개 모두 planned이며 `gated_by`는 epic-postgres-primary다. `unpinned_after=[]`, `undeclared_after=[]`, `order_conflict=[]`이고 cycle·drift 오류는 없었다. 검사 명령의 성공은 아래 계약 문제까지 해소됐다는 뜻은 아니다.

### 요구사항 분담

| 요구사항 | 담당 entry와 결과 |
| --- | --- |
| E12-1 | 1: 새 token·attempt 이력·갱신·현재 token 결과 확정. 2·5가 복구/정체 결과를 넓힘 |
| E12-2 | 1: 등록부 분류·감독자·core 동시 수집·기회적 drain 제한. 12: 설치본 관찰 |
| E12-3 | 2: DB 취소·그룹 종료·신원·재시작·unknown. 12: 설치본 취소 |
| E12-4 | 3: 공통 DB 함수·현재 결과 확정·시험 표 INSERT trigger·권한. 실제 계약 표 trigger는 14·15 |
| E12-5 | 1: 정상 progress/result·환경 입력의 최소 경로. 4: 나머지 이벤트·오류/exit·usage·schema/fixture 배포 완성 |
| E12-6 | 5: 일감/attempt 결과·정체 창·재시도·doctor. 2의 취소/사망 복구와 연결 |
| E12-7 | 6: 선행 성공 gate·실패 전파·그래프 enqueue use case |
| E12-8 | 7: 키 DB 보장·두 프로세스·용량·unknown 키 유지. 범위 문구는 F1 |
| E12-9 | 8: DST·설정 시간대·성공 날짜·catch-up·수동 합치기. 12: 설치본 예약 |
| E12-10 | 2: queue cancel의 CLI/SDK. 9: schedules·queue list·guide·doctor usage. 12: 설치본 관찰 |
| E12-11 | 10: 공통 보류·해제·발화/청구 차단·진행 취소·retry/run 우회 방지. 소비 연결은 F4 |

모든 E12 id가 존재하고 적어도 한 entry에 covers로 연결된다. 공유 id인 E12-2·3·9·10은 구현과 설치본 검증, E12-5는 최소 정상 경로와 완성으로 설명이 나뉜다. 11은 cleanup, 12는 배포와 사람 확인이라는 ID 없는 통합 작업도 맡는다. 누락 covers를 추가할 항목은 찾지 못했다.

### 의존·충돌·인계

- 1의 `11.3`은 PG 청구/예약 계약, `11.9`는 감독자를 붙일 PG 데몬/backoff, `11.10`은 PG 조립/fixture와 고정 baseline, `11.11`은 SQLite 삭제 뒤의 수정 경계다(`_bmad-output/personal-brain/tickets/epic-postgres-primary/tickets/tickets.toml:44`, `:116`, `:128`, `:140`). 11.11은 11.10을, 11.10은 11.9 및 11.3으로 이어지는 선행 경로를 이미 기다린다. 중복 직접 간선이지만 실제 소비/충돌 경계이므로 잘못된 after로 판정하지 않는다. 11.1 runner도 그 경로 안에 있어 새 after 누락은 아니다. 양쪽 인계 문장의 부족은 F3다.
- 8의 `11.6`은 DB 시간대와 설정 port라는 실제 입력이다(`_bmad-output/personal-brain/tickets/epic-postgres-primary/tickets/tickets.toml:80`). 12.1의 선행 경로에도 포함되지만 소비 지점을 명시한 직접 간선으로 유지할 수 있다.
- 1~10은 같은 Store port·PG work/마이그레이션·감독자·CLI 조립을 수정한다. 날짜 있는 Decision(`_bmad-output/personal-brain/tickets/epic-jobs-and-scheduler/epic-jobs-and-scheduler.md:98`)과 조사 §8에 따라 직렬화한 간선이다. 기능 의존만 없다는 이유로 제거하지 않는다. sweep 11은 1~10 전부를 기다리고 cleanup만 허용한다. 사람 확인 12를 sweep 뒤에 둔 예외도 같은 Decision에 있다.
- 13이 받을 예약 등록 SDK는 9(`tickets/tickets.toml:104`), ABI schema/fixture 배포는 4(`:44`), probe는 1(`:8`), registry용 보류 use case는 10(`:116`)이다. 13의 소비 설명은 `_bmad-output/personal-brain/tickets/epic-extensions/epic-extensions.md:17`, `:21`, `:55`에 있다. 실제 Python fixture 판정은 13이 완성하므로 12에서 Python 설치를 선행시키지 않는다. 현재 core package가 dist만 싣는 사실(`packages/core/package.json:16`)을 4의 배포 산출물 변경이 해결한다.
- 14·15가 받을 attempt 확인 함수와 trial trigger 예는 3(`tickets/tickets.toml:32`)이 제공한다. 14의 소비는 `_bmad-output/personal-brain/tickets/epic-garmin-import/epic-garmin-import.md:17`, `:63`, 15의 공통 작업 계약 소비는 `_bmad-output/personal-brain/tickets/epic-channels/epic-channels.md:20`, `:52`에 있다. 채널의 실제 표·trigger는 에픽 12의 Boundaries대로 15가 만든다.
- 18의 그래프 enqueue use case는 6(`tickets/tickets.toml:68`), 모델 분류의 25분 창은 5(`:56`), usage 운반/표시는 4·9다. 실제 adapter의 토큰 채움은 18(`_bmad-output/personal-brain/tickets/epic-health-analysis/epic-health-analysis.md:61`) 소유다. 의존 use case와 일감 성공 결과가 있으므로 18이 기존 완료 시각만 보고 성공을 추정할 이유는 없다.

### Done when과 검증 수준

| Done when | 결과를 제공하는 story | 검증 접근법 |
| --- | --- | --- |
| 1: 600초 초과 갱신과 동시 수집 | 1, 설치본 12 | 제어 시간 700초·경쟁 청구·동시 session_ingest, 실제 짧은 Node/PG 경로, 설치본 긴 probe |
| 2: 사망·취소·정체·오류·unknown | 2·4·5, 설치본 12 | 실제 그룹/손자 종료·재시작, 가짜 신원 오류, ABI 오류 행렬, 제어 시간 정체와 doctor |
| 3: 의존 성공과 같은 계정 직렬 | 6·7 | fake/PG 계약·여러 선행·실패 전파·두 프로세스 키 경합·unknown 키 유지 |
| 4: 현지 예약·놓침·수동 | 8·9, 설치본 12 | DST·시간대 변경·성공 날짜·빠진 범위·CLI 중복 합치기·설치본 발화 |
| 5: 플러그인 배포와 이 Mac 확인 | 12 | 앞선 commit app-ref와 같은 변경의 version 증가, 사람이 실제 명령/doctor 증거 기록 |

verify는 초안 entry에 맞는 접근법 수준이며 plan에서 새 시험 진입점을 확정할 수 있다. 1·2·7은 이미 그 약속을 명시했다. 나머지에도 통일하자는 것은 S2다. fake process만으로 OS 종료를 증명하지 않고 실제 Node 통합을 둔 점은 타당하다. 12의 사람 단계는 description·verify·hitl에 모두 있다. 1의 setup은 기존 11의 개발 PG 기반과 자동 시험을 소비하므로, 새로 수행할 사람 단계가 없는 현재 계획에서 hitl=false 자체는 위반이 아니다.

Constraints의 외부 대기 중 DB 쓰기 트랜잭션 금지·쓰기 쪽 값 생성·모델/실계정 금지는 계속 모든 story의 기준이다. 개별 entry에 복사하지 않은 것을 누락으로 세지 않았다. 구현 증거와 실제 Mac 동작을 검증한 보고서는 아니며, 위 fix를 반영한 고위험 계약을 재검증해야 한다.

## 재검증 (2026-10-28)

판정: 수정 후 재검증 — 잔여 fix 1(F3 부분 해소) / suggest 0 / ask 0. F1·F2·F4·S1·S2는 해소됐고, 수정으로 생긴 새 지적(F5 이상)은 없다.

아래 근거는 현재 파일의 행 번호다. 메인 checkout의 `validate-checks.md` Set·Dependencies를 다시 대조했으며, 기록된 Decision의 정책은 재논의하지 않았다. 정적 계획 검토로 한정하고 테스트·빌드·Docker·네트워크·설치·커밋은 실행하지 않았다.

- **F1 — 해소.** `_bmad-output/personal-brain/tickets/epic-jobs-and-scheduler/epic-jobs-and-scheduler.md:42`·`:92`가 소유 주체와 실행 분류를 분리하고 모든 청구 경로의 키 보장을 유지한다. `_bmad-output/personal-brain/tickets/epic-jobs-and-scheduler/tickets/tickets.toml:8`은 core 제공 probe를 `supervised`로 명명하고, `:80`·`:81`은 core 소유 supervised의 용량·키 소비와 probe 검증을 포함한다. 짧은 core drain의 제외는 감독자 용량에 한정된다.
- **F2 — 해소.** `_bmad-output/personal-brain/tickets/epic-jobs-and-scheduler/epic-jobs-and-scheduler.md:101`은 이 Mac에서 확인한 조회 명령, 부팅 시각·PID·1초 단위 시작 시각, detached Node 리더·손자의 PGID, 없는 PID와 그룹 정리 뒤의 조회 결과를 기록한다. `_bmad-output/personal-brain/tickets/epic-jobs-and-scheduler/tickets/tickets.toml:20`·`:21`은 그 방법과 없음/확인 불가의 구분을 소비하고, 실제 자식·손자 종료/재시작 시험 및 가짜 PID 재사용·조회 실패 시험을 남긴다. 따라서 방법을 plan에서 처음 정해야 했던 알려진 불확실성은 해결되어 entry의 착수 차단용 `unknown`을 생략할 근거가 충분하다. 실행 중 확인 불가를 뜻하는 attempt 결과 `unknown`과 재청구 금지는 그대로이며, 이 재검증이 OS 실험을 재수행하거나 구현 안전성을 인증한 것은 아니다.
- **F3 — 부분 해소.** `_bmad-output/personal-brain/tickets/epic-jobs-and-scheduler/tickets/tickets.toml:8`·`:92`에 받는 산출물, runner의 그룹/streaming 확장 소유자, epic 11 완료 HEAD에서 경로·시그니처를 확인할 책임이 명시됐다. 그러나 `_bmad-output/personal-brain/tickets/epic-postgres-primary/tickets/tickets.toml:8`·`:80`·`:116`·`:128`·`:140`에는 12로 주는 인계 설명이 여전히 없고, `:44`도 일부 범위 분담만 말한다. `_bmad-output/personal-brain/tickets/epic-jobs-and-scheduler/epic-jobs-and-scheduler.md:102`의 Decision은 선행 설명을 고치지 않을 이유와 대안을 기록했지만 Dependencies의 “both descriptions say so”를 충족하지는 않는다. epic 11을 고치지 않는 결정은 유지하되, 이 인계에 대해 양쪽 설명 조건의 예외를 수용한다는 문장을 받는 에픽 Notes에 명시해야 잔여 항목을 닫을 수 있다.
- **F4 — 해소.** `_bmad-output/personal-brain/tickets/epic-jobs-and-scheduler/epic-jobs-and-scheduler.md:45`·`:71`·`:103`과 `_bmad-output/personal-brain/tickets/epic-jobs-and-scheduler/tickets/tickets.toml:116`·`:117`은 보류 그룹 계약, 자동 이름공간 연결, core 분석을 넣는 쪽의 연결 책임과 그룹 없는 core의 비영향 범위를 맞췄다. 소비 측 `_bmad-output/personal-brain/tickets/epic-extensions/epic-extensions.md:59`는 registry의 12.10 호출을, `_bmad-output/personal-brain/tickets/epic-health-analysis/epic-health-analysis.md:66`은 분석 일감·예약의 `extension:garmin` 연결을 받는다. 양쪽 인계와 검증 접근법이 사용자 비활성화 결정을 보존한다.
- **S1 — 해소.** `_bmad-output/personal-brain/tickets/epic-jobs-and-scheduler/tickets/tickets.toml:8`은 progress→result 한 종류·probe 한 건의 port/DDL/fixture로 plan을 제한하고 오류 행렬·ABI 완성/배포·doctor/list를 후속 소유자에게 배정한다. 모델·확장 등록 제외와 세션 초과 시 비필수 완성의 후속 분리도 명시하며, `_bmad-output/personal-brain/tickets/epic-jobs-and-scheduler/epic-jobs-and-scheduler.md:104`가 그 계획 의무를 고정한다. 실제 분량 판정은 11 완료 코드를 읽는 1의 plan에서 한다.
- **S2 — 해소.** `_bmad-output/personal-brain/tickets/epic-jobs-and-scheduler/tickets/tickets.toml:8`·`:57`·`:93`은 1이 timer/clock·가짜 프로세스·격리 PG 기반을 만들고 2·5·8이 재사용하도록 한다. `:21`의 OS 시험은 실제 Node 자식이고 `:33`·`:45`·`:69`·`:105`·`:117`에도 plan의 실행 진입점 약속이 추가됐다. `_bmad-output/personal-brain/tickets/epic-jobs-and-scheduler/epic-jobs-and-scheduler.md:104`가 새 시험의 명령·fake/실제 자식 구분·PG 사전 조건·관찰값을 공통 의무로 정하고, `tickets/tickets.toml:139`는 확인용 예약·probe·성공 기록의 재실행 정리를 요구한다.

F3의 남은 조치는 선행 계획을 다시 수정하라는 요구가 아니라 검사 규칙 예외의 명시다. 이니셔티브에도 Dependencies의 다른 조건에 대해 명시적 예외를 기록한 선례가 있다(`_bmad-output/personal-brain/initiative-personal-brain.md:184`). 현재 Decision의 실행 방침과 인계 내용은 유지할 수 있다.

수정 문구를 이니셔티브 R8·R9·R10·R16 및 같은 날 결정 묶음(`_bmad-output/personal-brain/initiative-personal-brain.md:34`·`:164`), spine AD-21·29·33(`_bmad-output/personal-brain/architecture-brain-v1-slice-1/architecture-brain-v1-slice-1.md:350`·`:451`·`:496`)과 대조했다. 실행 분류는 모델 일감의 감독자 전용 청구를 지키고, 보류 그룹은 registry의 활성 상태 소유권을 옮기지 않으며, OS 조회 실패 시 재청구 금지도 유지한다. 새 충돌은 발견하지 못했다.

보드 정적 조회는 `UV_OFFLINE=1`을 붙인 지정 `uv run … tickets.py … status _bmad-output/personal-brain`으로 성공했다. 최초 실행은 uv 캐시 잠금 권한 때문에 실패하여 승인된 재실행을 썼다. epic 12는 `refined: true`, `next_id: 13`, 12개 entry 모두 `planned`, 선행 gate는 `epic-postgres-primary`다. `unpinned_after=[]`, `undeclared_after=[]`, `order_conflict=[]`이며 cycle·drift 오류는 없었다. 이 구조 검사는 F3의 서술 조건을 대신하지 않는다.
