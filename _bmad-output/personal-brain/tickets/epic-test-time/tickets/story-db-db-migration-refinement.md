# 19.1 문서 정제와 구현 검증 인계

2026-11-09. 원본 baseline `cb8391173aead346abb5177d87212d999ce30bd8`/schema43. 중앙 정제 명세 사본·원본 파일 hash는 자기 checkout `.brain-automation/tickets/19.1/`에 보존한다. 구현 계획/status는 만들지 않는다. 이 정제에서 build/typecheck/test/test:changed/vitest/list/eval/재현/측정/PG 생성은 전부 **미실행**이다.

## 정적 source 대조

| 읽은 경로 | 현행 사실과 판단 기준 |
|---|---|
| `packages/postgres/test/fixture.ts` | `database(migrate=true, createDatabase=createTestDatabase)`는 생성 → prepareDatabase → 선택적 runMigrations, 실패 시 drop이다. `database(false)`도 prepare는 수행하므로 완전 빈 DB와 같다고 취급하지 않는다. `subject`는 app role store와 close/drop을 소유한다. 최적화는 이 주입 seam 및 명시 opt-out을 보존해야 한다. |
| `packages/postgres/test/{redaction,store,work-store}.test.ts` | store는 DB 배열 drop, work-store는 역순 cleanup, redaction은 역순 정리를 끝까지 시도하고 오류를 모은다. 본문·대기·cleanup 단언을 줄이지 않는다. redaction의 isolated factory 주입을 기본 factory로 덮지 않는다. |
| `apps/cli/test/sessions-ingest.test.ts`, `pg-home.ts` | sessions의 임시 home/DB 경로는 pgHome의 실제 prepare/migrate를 소비한다. pgHome은 DB 준비 뒤 선택적 self user, shim/config/.env를 작성한다. home별 Map 캐시는 DB 준비 최적화와 별개이며 store close·drop 책임을 유지한다. migration seed에는 self user/home별 상태를 넣지 않는다. |
| `apps/cli/test/ext-fixture.ts` | extHome → pgHome에 acquireTestDatabase를 주입한다. 별도로 DB owner를 brain_owner로 맞추고 설치 identity를 쓴다. cleanup은 marker가 현재 DB인 확장 role만 drop owned/drop role하고 DB/home 정리를 재시도한다. 원래 fixtureContainerRemoved/fixtureDatabaseDropped 의미를 보존한다. |
| `tooling/test-db/src/index.ts` | createTestDatabase는 명시 환경 cluster에 임의 DB만 생성한다. acquireTestDatabase는 lease 또는 isolated fallback, createIsolatedTestDatabase는 전용 container·동적 port·전체 ID·label·실제 TCP 인증과 부분 생성 복구를 소유한다. 알려진 정적 경로만으로 cluster 재사용 가능성을 보장하지 않는다. |
| `tooling/test-db/src/slots/lease.ts` | lease는 run/slot/file·전체 ID·label·loopback port를 검사한다. process-local occupied와 boundary 검사 때문에 동시 두 번째 fixture/더러운 cluster는 isolated로 간다. 잘못된 lease는 실패이며 공유 URL로 조용히 fallback하지 않는다. |
| `tooling/test-db/src/slots/cluster.ts`, `python-slots.ts` | runner는 slot cluster를 파일/job 사이 재사용하지만 경계는 기본 3 DB 외 사용자 DB 0·확장 marker role 0·다른 client 0을 요구한다. 실패/불명은 폐기·격리하고 다음 세대로 간다. 따라서 지속 template을 단순 추가하면 boundary가 실패한다. template의 정확 소유 식별·경계 의미·회수 설계를 입증하거나 경계 전에 제거하는 비용을 포함해야 한다. 임의 이름 접두사 허용은 불가다. |
| `apps/cli/python-test/global-setup.ts`, `tooling/test-db/src/global-setup.ts` | Python 직접 실행은 lease 검증, 명시 외부 URL 보존, 또는 direct 전용 cluster/장부/lease teardown이다. 기본 PG setup은 명시 URL을 보존하고 없으면 compose를 쓴다. 구현 검증은 전용 URL을 먼저 주어 공용 54329에 가지 않는다. 이 두 수명을 혼동하지 않는다. |
| `packages/postgres/src/setup.ts` | core role은 cluster 전역이며 postgres DB의 advisory lock 4919270912로 준비를 직렬화한다. 대상 schema/ledger/default privilege 준비는 별도다. DB 복제는 role·password·membership 복제가 아니므로 role 준비를 생략할 근거가 없다. |
| 19.14 leaf와 현행 redaction | 41 case 중 권한 전용 cluster의 container ID/port/SQL system identifier 대조·세 대상 실패 집합·물리 heap/TOAST bytes·snapshot 음성/해제·복구·새 세대 보호를 보존한다. cluster 시작·인증/매핑·제거와 물리 검증 비용을 과거 39 case 비용으로 대체하지 않는다. |

19.5의 수락 source `5b2fff1`은 baseline에 포함돼 있다. 해당 refinement는 설계 당시 schema41/옛 factory를 담은 역사 인계이며 현재 factory와 schema43이 우선이다. 옛 18.10·health-perf·은퇴 core import-verify 경로를 요구하거나 부활시키지 않는다. 현재 native 이식 시험은 현행 경로 그대로 보호한다.

## 선택 시 작성할 결정표

구현자가 두 후보에 대해 적용 가능한 호출자·제외 대상·초기 비용·반복 비용·최종 회수 비용·동시성·실패복구·권한 동등성·E19-1 예상 한계를 비교한 뒤 실제 증거로 하나를 택한다. 숫자는 이 정제에서 추정하지 않는다.

- Template: key는 cluster 실제 신원/세대와 정렬된 migration 파일명+내용 hash, seed에 영향을 주는 준비 계약이다. schema version 숫자만 같아도 SQL 내용이 달라지면 무효화한다. 정상/동시 생성의 단일 소유, 실패 seed 비공개, 완성 후 연결 해제, clone 소유/grant 동등성, 오래된 seed 회수를 정한다. 짧은 isolated cluster마다 새 seed를 만들 경우 이득이 없을 수 있으므로 비용을 포함해 판단한다.
- 초기화 재사용: 동시 fixture는 서로 다른 DB를 받는다. 이전 연결·transaction·행·sequence·DDL·role/권한·marker·ledger 오염을 초기화하고 새 migration DB와 비교한다. 완전 복원이 불명인 DB는 폐기한다. 파괴적 DDL/권한/빈DB/migration 시험은 명시 opt-out이며 자동 상태 추측으로 제외 여부를 정하지 않는다.
- 수명/회수: fixture DB/초기화 pool·seed의 소유자와 run/slot cluster 소유자를 구별한다. 정상 teardown, setup 중 실패, drop 실패, timeout, process 사망 뒤 기존 장부 복구를 연결한다. 신원 불명은 성공 정리로 세지 않는다. 직접 Vitest·changed·기본 PG·Python runner에서 동일 의미를 유지한다.
- 공유 경계: 현재 19.6은 hook/Python config/test-changed, 8.5는 Drive/0044를 소유한다. 이번에는 편집하지 않는다. 구현 시작 전에 최신 main/소유권/마이그레이션을 다시 고정하고 필요한 공통 runner/config/rules 변경은 중앙 배정으로 조율한다. after를 임의 추가하거나 삭제하지 않는다.

## 기준과 검증 절차 — 별도 구현 배정 후에만

1. 기준은 정제 baseline이 아니라 구현 배정 시 최신 수락 main의 정확 SHA다. 후보와 기준의 migration·네 파일·case 전체·fixture·runner/config 바이트를 hash/manifest로 고정한다. 19.6·0044 등 중간 변경이 있으면 양쪽에 같은 기반을 적용하고 diff를 공개한다. 정제 baseline은 역사로 남긴다.
2. 대상은 `packages/postgres/test/redaction.test.ts`, `store.test.ts`, `work-store.test.ts`, `apps/cli/test/sessions-ingest.test.ts` 전체 case다. 현재 정적 redaction 41 case를 기준으로 하되 착수 시 실제 목록/결과를 동결한다. 기존 353 case/362 DB/75.512초(51018bbb, 39 redaction)는 역사 표본이며 새 분모나 보장 절감량이 아니다. 권한 전용 cluster·snapshot·복구도 양쪽 같은 case/비용에 포함한다.
3. 동일 host·Node/pnpm/Vitest/Python pin·lock hash·PG image ID·Docker CPU/RAM·동시성·cache/사전 준비 정책·합성 입력·timeout·계측 코드·phase 경계를 기록한다. 전용 PG/HOME/TMP와 공통 직렬 성능 잠금을 사용하고 다른 부하/잠금대기·무효 이유를 남긴다. 공용 시험 DB·운영 계정·실데이터를 쓰지 않는다.
4. 기준과 후보 각각 warm-up1+독립3회를 좁은 네 파일에만 수행한다. 각 표본은 새 소유 자원에서 같은 시작 상태를 만든다. createDB/prepareRole/migrate/drop과 새 template/초기화/무효화/잠금/회수 비용의 측정 귀속을 사전에 동결한다. DB 준비·정리 합계에는 최적화가 추가한 준비·회수를 포함하며 별도 cluster 시작/인증/종료는 양쪽 같은 경계로 별도 열에도 기록한다. warm-up에서 만든 seed를 timed run에 공짜로 넘기지 않는다. cluster 수명 내 실제 공유 이득만 그 수명의 비용과 함께 센다. 파일별 중앙값을 더하지 말고 표본별 네 파일 합계를 구한 뒤 중앙값·비율을 계산한다. 파일 wall·명령 wall·잔여 본문과 물리 cleanup 시간도 구별해 기록한다.
5. 각 표본의 case 이름/pass/fail/skip·행/순서/오류 분류·종료 코드·자원 정리를 대조한다. 실패/timeout 원문을 보존하며 같은 case 집합 통과·정리 완료인 유효3개가 필요하다. 느리다는 이유로 표본을 버리지 않는다. 후보/기준 합계 중앙값 ≤0.5가 아니면 미충족이다.
6. 격리·opt-out·hash 변경/동시 생성·실패복구·직접 실행·동시 extHome·19.14 물리 안전 계약의 시험 코드를 작성한다. 개발·리뷰 수정 중 실행하지 않고 마지막 수정 뒤 관련 검증/측정을 한다. 마지막 필수 전체 회귀는 `pnpm test` → `pnpm test:python` 순차 각1회다. 기준 전체 각1회와 나란히 기록하며 전체 suite warm-up+3 반복은 금지한다. 실패 수정 후 관련 시험/`test:changed -- <기준 SHA>`로 재검증한다. 21.8 유예 대상이 아니다.

## 정제 절차와 승인 경계

공식 bmad-agent-po render를 1회 수행하고 REFINE·template·Ticket/Dependencies 검증 지침과 repo write 절차를 읽었다. method scripts 버전 경고가 있었으나 setup/update는 금지라 수행하지 않았다. 런북 지정 프로젝트 tickets.py의 find→pull을 사용한다. entry1의 description/verify/references만 갱신하고 after5·refine true·번호·다른 entry·부모 after는 보존한다. 부모 Notes의 정확19.1 보완은 역사 비용/현행 seam의 해석을 명시한다.

독립 fresh-context Sol medium Ticket/Dependencies 확인과 필요한 수정·후속 확인 뒤 refined 상태를 기록한다. 구현/built/done 승인이 아니며 중앙 수락과 별도 구현 배정이 다음 단계다. 실행 결과는 전부 미실행으로 남긴다.


### 독립 검증 수락 — 2026-11-09

- fresh-context Sol `gpt-6.1-sol / medium`, 자기 Run `run_1a4b4905653e`, Task `task_0c45f635d8c2`, Dispatch `ctx_b554933e6575`. 최초 ready와 depth1 영수증을 로컬에 보존했다.
- 보고 `.brain-automation/tickets/19.1/independent-ticket-dependencies.md`: Ticket/Dependencies 모두 문서 범위 통과, fix0/suggest0/ask0. 보고 전문을 지휘자가 재독하고 수락했다. 수정 요청이 없어 실질적 변경/후속 검토는 필요하지 않았다.
- 중앙 정제 명세와 사용자 승인 범위에 따라 leaf를 refined=true로 전이한다. 이 변경과 본 검증 기록 외 검토 후 요구·의존 변경은 없다. entry after5/refine true를 유지하며 구현/built/done 상태는 만들지 않는다.
- 실제 status/next/find와 identity/diff/hash 대조 결과는 로컬 최종 보고에 보존한다. 개발·리뷰 중 시험 금지 및 구현 종료 뒤 필수 전체 순차 회귀는 향후 구현 의무다. 이번 정제의 컴파일/시험/목록/PG/측정은 모두 미실행이다.
