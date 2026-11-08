---
id: 13
type: bug
title: "Drive 회귀: tracer timeout과 parser 실패 수 불일치"
parent: epic-test-time
covers: []
after: []
assignee: ""
refined: true
hitl: false
risk: medium
severity: P2
---

# Drive 회귀: tracer timeout과 parser 실패 수 불일치

## Description

Drive tracer 기존 사례 9개가 30초 제한을 넘고 source tracer parser 사례 1개는 실패 수 단언이 달라 기본 suite를 실패시킨다. 19.5 변경이 없는 수락 main 사본에서도 같은 실패가 보고됐다. 기존 Drive·가림·취소·파일 보존 계약을 유지하면서 실패 단계와 시험 전제 또는 제품 결함을 구별하고 필요한 최소 교정을 검증한다.

## Reproduction

1. 19.5 source87f7b3e79e74b3da7a1de055259ed0016a989567에서 build 후 기본 Vitest와 직접 Python Vitest를 독립 소유 PG·home으로 병행했다. 기본 suite는 19:20:43~19:26:44 UTC에 14개 실패, Python은 19:37:04 UTC에 16파일76시험 통과였다.
2. 관리자 암호 전제 불일치 4개는 별도 환경 오류로 구별됐고 암호를 맞춘 해당 파일은 통과했다. 이 버그는 나머지 Drive tracer 9개 timeout과 Drive source tracer parser 1개 단언 실패를 다룬다.
3. 지휘자의 단독 관측은 timeout180000으로 늘린 한 사례 소요 관측이며 약31.8초에 통과했다. 이 성공은 원래30초 실패 재현이나 해결 근거가 아니다.  19.5 변경 없는 main2f23d30b7a894a9979567311544c7f28e3f25a5a를 Git archive/install/build한 사본에서도 같은 9개가 30초 timeout으로 실패하고 parser 사례는 34416ms에 failed 기대 1·실제 4 단언 실패였다. 정확 명령·환경·실패명과 source 동일성은 인계 원문을 대조한다. 병행 부하만의 원인으로 단정하지 않는다.

### 정확 명령과 환경

- 독립 전용 postgres:18 tmpfs container, 관리자 암호 postgres, 동적 localhost port의 자기 URL만 BRAIN_TEST_DATABASE_URL로 주입한다. 실제 URL/암호는 공개하지 않는다. 저장소 루트 실행, 그 외 env 변경 없음.
- 19.5 source 단독 관련 실행: `pnpm exec vitest run --project cli test/drive-tracer.test.ts test/drive-source-tracer.test.ts --project postgres test/install-legacy-manifest.test.ts` — 기본 testTimeout30000, 10실패64통과(두 Drive 파일 실패, legacy 통과).
- 소요 관측 전용: `pnpm exec vitest run --project cli test/drive-tracer.test.ts -t "0일 보관" --testTimeout 180000 --reporter=verbose` — 31810ms pass, 다른 case 필터 제외. 원인 조사 이력이며 이 옵션을 해결에 사용하지 않는다.
- main A/B: `git archive 2f23d30b7a894a9979567311544c7f28e3f25a5a` 사본에서 `pnpm install --frozen-lockfile --offline`, `pnpm build` 성공 뒤 `pnpm exec vitest run --project cli test/drive-tracer.test.ts test/drive-source-tracer.test.ts --reporter=verbose` — 기본 testTimeout30000/필터없음,10실패33통과. 원문 main-ab-drive.log의 정확 사례를 대상으로 한다.

## Cause Hypothesis

fixture 준비·실제 Drive 호출·폴링·자식 종료·정리의 어느 단계가 사례 시간을 소비하는지는 아직 미확정이다. timeout은 증상이며 단순 제한 증가가 해결책이라는 뜻이 아니다. 시험 환경 전제와 수락 source의 실제 동작을 먼저 분리한다.

## Acceptance Criteria

1. **입력 격리 결함의 교정과 기존 회귀 계약이 입증된다**
   **Given** 동일하게 고정한 합성 session과 합성 process HOME, 실제 합성 Drive 서버·독립 소유 DB/fixture
   **When** 기존 fixture의 ambient transcript scan/queue 유입과 전용 config를 지정한 교정 fixture의 유입 차단을 실제 조립 경로로 결정적으로 대조한다
   **Then** 입력 격리 교정 효과가 입증되고, 원래 timeout 9개와 parser 실패 집계 대상의 정확한 case 대응표·기존 제한/단언/보존 계약 및 두 파일 45case 통과를 남긴다. 최초 전체 회귀 20개 실패 원형과 환경 관련 재검증 처분·미해결 유무 및 실제 소유 자원 정리를 보존한다. 과거 10개 실패 각 행의 정확한 원인은 원시 root/kind 누락에 따른 미확정 한계로 남기며 built의 필수 조건으로 요구하지 않는다. 대기 중 무기한 정리나 고아 자식은 없다.
2. **Drive 안전 계약을 약화하지 않는다**
   **Given** 원래 정상·실패·취소·가림·보관 삭제·home 변경 사례
   **When** 교정된 실제 호출 경로를 실행한다
   **Then** 기존 단언·사례·생산 timeout/재시도·락·fence를 유지하고, 원인에 대한 결정적 회귀와 영향을 받은 경계를 검증한다. sleep·전역/사례 timeout 증가·skip·모의 대체·성공까지 반복으로 통과시키지 않는다.
3. **실패와 검증·인계가 완결된다**
   **Given** 마지막 수정과 독립 후속 확인이 끝난 source
   **When** 전체 TS→Python 순차각1회와 필요한 관련 재검증을 수행한다
   **Then** 최초 실패·정확 source·명령/exit·실패별 처분·원시·정확 소유 자원 부재를 보존하고 필수 미해결이 없다. 19.5에 시험/fixture/제품/측정 실행 바이트 영향 범위를 인계한다. 과거 성능 표본을 새 source 실행으로 바꾸어 쓰지 않는다.
4. **또는 수정 불필요를 입증한다**
   **Given** 보고된 실패 조건과 원문
   **When** 실제 환경과 source 계약을 대조한다
   **Then** 보고 전제 오류 또는 이미 올바른 동작을 결정적 증거로 설명한다. 단일 재현 실패나 원인 미확정 성공만으로 충족하지 않는다.

## Boundaries

- 19.5 runner·config·slot·hook lane·성능 임계/측정기·동결 묶음과 적용 migration·plugin 릴리스는 수정하지 않는다.
- 시험 전제/가짜 Drive 서버·fixture와 해당 두 tracer 파일을 우선 조사한다. 제품 교정이 필요하면 원인과 최소 diff로 중앙 소유 범위 판단을 요청한다. 소스 경로는 Notes의 조사 단서다.
- 개발·리뷰 수정 중 시험/진단/eval 실행 금지, build/typecheck/diff 확인만. 추가 실행 진단이 필요하면 정확 범위·횟수와 중앙 판단을 거친다.
- 실제 Drive/운영 데이터/credential·공용 PG를 쓰지 않고 자기 자원만 정확 ID로 정리한다.

## References

- parent — _bmad-output/personal-brain/tickets/epic-test-time/epic-test-time.md, Constraints·Done when
- logs — 중앙 .brain-automation/tickets/19.13/evidence/parallel-result.md 및 main-ab-drive.log·drive-probe.log

## Notes

- Decision(2026-11-09, 중앙): 티켓 간 소유·순서·19.5 인계 결정은 부모 Notes의 19.13 분리 결정을 참조한다.
- Risk: medium — 불완전한 안정화는 Drive 삭제/취소/가림 실패를 숨길 수 있다.
- Open question: 정확 단계와 원인, 이전 main 재현 환경의 동등성은 조사에서 확인한다. 착수를 막는 명세 미정이 아니다.
- 조사 위치: apps/cli/test/drive-tracer.test.ts, apps/cli/test/drive-source-tracer.test.ts 및 이들이 쓰는 시험 fixture/가짜 서버. 제품 경로·공통 fixture 수정은 실제 소유 영향으로 먼저 판단한다.

- 정정(2026-11-09, 중앙 승인): 최초 초안은 10개 모두 timeout으로 집계했으나 main 원시 로그는 tracer 9개가 30000ms timeout, parser 1개가 120000ms 제한 내 34416ms에 failed 기대 1·실제 4 단언 실패다. 두 증상의 공통 원인은 미확정이다.
- 기준 전제: 8.4 source `73c44191af88fe8ede445513fb02c84e83badf06`는 baseline `2f23d30b7a894a9979567311544c7f28e3f25a5a`의 조상이며 migration 0001~0043 바이트가 같다. 중앙 수락된 역사적 전제로 새 착수 의존이 아니다.
- 명세 보완(2026-11-09, 중앙 msg_21d84c8bcbbc): 기존 AC1은 역사적 9 timeout/parser failed 4 각각의 원인·공통성·귀속 입증을 요구했다. 당시 root/kind 원시가 없으므로 그 역사적 귀속은 미확정 한계로 보존하고 필수 built 조건에서 제외한다. 대신 동일 고정 합성 session의 실제 ambient 유입/차단 대조, 기존 대상 case별 제한·단언·보존 계약과 45case 통과, 최초 전체 20실패 원형 및 관련 재검증 처분·자원 정리를 필수로 한다. 입력 격리 결함 교정의 수락이며 과거 10개 모두 같은 원인을 해결했다는 선언이 아니다. 다른 AC와 안전 계약은 유지하고 추가 진단·전체·성능 실행은 배정하지 않는다. 부모의 같은 결정과 독립 PO 표적 일치 확인을 따른다.
