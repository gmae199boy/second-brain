# 22.6 Refactor sweep 착수 감사

기준은 `e8a80b18451b43a14157cf673f40c28531b7dbb9`다. 선행 22.1~22.5의 계획·리뷰에서 남은 작은 정리 후보를 현재 코드와 대조한 결과, **제품·측정기·fixture의 추가 코드 정리 대상은 0건**이다. 채택된 정리는 이 감사 문서다. 이미 해결된 항목을 다시 고치거나, 별도 소유권·제품 계약이 필요한 개선을 이 sweep에 넣을 근거는 확인하지 못했다.

이 감사는 정적 조사와 범위 결정의 근거다. 최종 독립 리뷰, 현재 기준의 전체 회귀와 자원 정리, 브랜치 제출은 [22.6 계획](story-refactor-sweep-plan.md)의 별도 미완료 조건이다. 이 문서가 시험이나 성능을 새로 통과했다는 뜻은 아니다.

## 검토 범위

[22.1 반입 정리 계획](story-tracer-10-plan.md), [22.2 snapshot 계획](story-snapshot-10-stale-plan.md), [22.3 검색 계획](story-10-plan.md), [22.4 첨부 반입 계획](story-1-sql-plan.md), [22.5 위치 조회 계획](story-uuid-uuid-plan.md)을 전문으로 읽고, 각 계획의 `deferred`, Review Triage Log, 검증 이력과 최종 처분을 대조했다. 다섯 계획의 `deferred`는 모두 빈 목록이다. [에픽](../epic-query-performance.md)과 [entry 6](tickets.toml)도 범위를 고정하는 원문으로 읽었다.

중앙 보관소의 실제 리뷰 원문 85개를 읽었다. 22.1은 4개 렌즈 2회와 T6·schema39 후속 10개, 22.2는 4개 렌즈 2회와 T7·T17 후속 10개, 22.3은 4개 렌즈 5회와 표적·통합·최종 후속 46개, 22.4는 4개 렌즈 2회와 수정·통합 후속 13개, 22.5는 4개 렌즈와 후속 2회의 6개다. 22.3 R5 edge 원문은 빈 배열이다. 검토한 렌즈와 필요한 후속 중 확인된 부재는 없다. 원문은 로컬 실행 보관소에 있고 공개 저장소의 자료는 아니다. 이 문서는 그 요약만으로 원문을 읽었다고 주장하지 않으며, 아래의 공개 계획·현재 코드·Git 객체를 독립적으로 확인할 수 있는 근거로 함께 제시한다. 중앙 [후속 항목 모음](../../../automation/follow-ups.md)의 해당 에픽 수락 항목도 대조했다.

최초 정적 조사 Task는 합본 출력 잘림으로 미완료 처리됐고, 후속 조사에서 문서와 원문을 작은 구간으로 나누어 읽었다. 최초 실패 이력은 그대로 남는다.

## 후보별 처분

| 후보와 공개 근거 | 현재 코드 확인 | 처분과 남은 위험 |
|---|---|---|
| 22.1 candidate 중복, 누락 조건·중앙값, shared 차단, rewritten 및 unhanded 측정. [계획의 두 리뷰와 T6 확인](story-tracer-10-plan.md#review-triage-log) 참조. | `tooling/query-perf/src/import-cleanup.mjs:51–64,66–82`는 후보 충돌을 거부하고 원문 직접 비교, unhanded 및 shared 결과를 기록한다. 계획의 T6 표는 채택 14행의 해결 범위를 기록한다. | **이미 해결.** 비교기는 올바른 baseline과 동일 서버·부하를 독자적으로 인증하지 않는다. 더 넓은 출처 자동 인증은 비교 계약 확장으로 제외하고 실제 실험 배정과 지문을 사람이 대조한다. |
| 22.1 긴 locator 인덱스 한도, 강제 종료 시 DB 정리, 취소 시험 고정 300ms. [계획의 기각 및 회귀 기록](story-tracer-10-plan.md#verification) 참조. | `packages/postgres/migrations/0039_import_cleanup_indexes.sql`의 인덱스와 `tooling/query-perf/src/import-cleanup.mjs:43–46,85`의 확정 생성 뒤 정리 경로가 유지된다. `apps/cli/test/ext-install-resume.test.ts:312–313,349`는 300ms 뒤 신호를 보낸다. | **범위외.** 인덱스 변경과 신호 복구는 SQL·자원 소유 의미를 바꾸고, readiness 기반 시험 안정화는 별도 판단이다. 최초 취소 실패의 정확한 원인은 계측되지 않았으며 부하 민감 가능성을 유지한다. |
| 22.2 snapshot 표본의 전체 객체 참조 누적과 stale oracle. [계획의 T7·T17 처분](story-snapshot-10-stale-plan.md#review-triage-log) 참조. | `tooling/query-perf/src/session-snapshot.mjs:111–121`은 표본에 시간·span을 반환하고, `:150–159`는 새 메시지 뒤 독립 stale 지문과 결과를 확인한다. | **이미 해결.** 공통 준비 객체의 생애와 GC 시점까지 사라졌다는 뜻은 아니다. 별도 직렬화/hash 진단은 실제 transaction 내부의 직접 분해가 아니다. |
| 22.2·22.3·22.5의 CREATE DATABASE 응답 유실. 각 계획의 기각·잔여 위험을 참조한다. | `session-snapshot.mjs:81,88,161–164`, `file-locations.mjs:25,42,127`은 성공 응답 뒤 `created`를 확정한다. 위치 러너는 생성 시도와 정확한 이름도 기록한다. | **범위외.** 서버가 생성한 뒤 응답을 잃으면 표식만으로 부재를 보장할 수 없다. 자동 재접속·삭제는 자원 소유와 오류 계약을 바꾸므로 기존처럼 전용 cluster의 정확 ID 제거·부재 증거로 위험을 제한한다. |
| 22.3 locale·준비·fixture 참조·Unicode 경계·종료 gate. [검색 계획의 R1~R5와 T39/T52/T73 기록](story-10-plan.md#review-triage-log) 참조. | `tooling/query-perf/src/common-search-protocol.mjs:7,28,63–73`은 준비 설정·GIN·행수를, `common-search-compare.mjs:46–57,80–90`은 환경·시각·준비를 확인한다. 계획은 fixture 참조 격리, 256/257 Unicode 회귀 및 app client 종료 gate의 독립 후속과 실제 관련 재검증을 구분해 기록한다. | **이미 해결.** 식 통계 재도입, 후보 제한, 시각 허용오차나 초기 복구 API는 새 기능 또는 측정 의미 변경이므로 제외한다. 손편집 원시의 모든 모순이나 운영 분포 전체를 자동 인증했다고 주장하지 않는다. |
| 22.4 1000개 existing/missing의 임계 초과, UUID 슬롯·ownership·청크. [계획의 r2와 T5 후속](story-1-sql-plan.md#review-triage-log) 참조. | `tooling/query-perf/test/attachments.test.ts:64–68`은 new/existing/missing 각각의 시간·SQL 초과와 다른 조건 보존을 단언한다. `packages/postgres/src/attachments.ts:26,38–60`은 UUID 슬롯 키와 singleton/batch 경로를 사용한다. | **이미 해결.** 기존 후속은 같은 청크 ownership과 201개 고유 파일 경계도 확인했다. 이 정적 확인 자체를 새 시험 통과로 쓰지 않는다. |
| 22.4 동일 cluster·순차 실행 자동 인증과 준비 API의 잠금 대기. [계획의 r2 기각과 잔여 위험](story-1-sql-plan.md#review-triage-log) 참조. | `tooling/query-perf/src/attachments.mjs:44–55,103–105`는 전용 DB 준비와 확정 생성 DB의 정리·오류를 기록하지만 공용 준비 API에 새 취소 기한을 더하지 않는다. | **범위외.** 자동 인증은 측정 계약을, 취소는 공용 PG·lock 경계를 바꾼다. 과거 T6의 1/existing 1.1720배와 T8의 1.50575배 실패는 보존하며 원인은 확정하지 않는다. |
| 22.5 정상 UUID Bitmap 계획과 완성형 실패 raw의 수락. [계획의 두 독립 후속](story-uuid-uuid-plan.md#review-triage-log) 참조. | `tooling/query-perf/src/file-location-compare.mjs:7–19,28,55`는 대상 relation·UUID 조건의 Bitmap을 수용하고 `failed === false`와 빈 오류를 요구한다. `packages/postgres/src/attachments.ts:153,241,251,266–267`은 canonical UUID와 기존 text fallback을 구분한다. | **이미 해결.** 비정규 입력의 기존 스캔 비용은 입력·오류 의미를 보존하는 결과로 남는다. |
| 공통 `run.mjs`, `tooling/test-changed/rules.mjs`, Store/export와 릴리스. | 공통 runner 등록·실패 출력과 선정 규칙은 여러 시나리오가 사용하고, core 지문 export와 PG는 공유 계약이다. | **범위외.** 19.5는 test-db/Python 설정/slot/hooklane/측정 driver, 8.4는 추출기·Carry·Store·PG/lock을 소유한다. 충돌할 구체 diff가 생기면 소유자와 조율한다. 운영 배포는 별도 릴리스다. |

## 성능 증거 전승과 지문

아래는 해당 선행 수락 ref와 이번 기준 commit의 **명시 파일 Git blob ID**를 읽기 전용 `git rev-parse <ref>:<경로>`로 대조한 결과다. 같은 ID는 그 파일의 Git 바이트가 같다는 뜻이다. 당시 실행한 모든 빌드 산출물, 설치 의존성, 공통 runner 전체, 서버 상태까지 동일하다는 자동 인증은 아니다. 각 선행 계획에는 실제 당시 runner·fixture·artifact 지문과 원시 측정·실패 처분이 기록돼 있다.

| 선행 ref | 기준과 같은 파일 및 Git blob ID |
|---|---|
| 22.1 `fa97231659820c58f71df16021d908256f6a1251` | `packages/postgres/src/imports.ts` `17c6738c3e8a2959126f654773862ac357d7c821`; `packages/postgres/migrations/0039_import_cleanup_indexes.sql` `ec316195d2ad2ff59b23f110876bfc6c7c1dc43b`; `tooling/query-perf/src/import-cleanup.mjs` `4988fa437124d9b3d67bc1ae0ef68772d9355daf` |
| 22.2 `a39224888a1ca2413df5758dbd9f6f5871e6e3fb` | `packages/core/src/recall/conversation-fingerprint.ts` `9e5c078b7846e0c85daf4bf5f118935f3e5f16b2`; `packages/postgres/src/conversation-index.ts` `ea203beb286c996275f41af97ec9d85590f520d8`; `tooling/query-perf/src/session-snapshot.mjs` `09054caccfef8122e0509f1a900644e8c2e28375` |
| 22.3 `7edfc9a110e95d405fe5a5986eeb3e64976809b7` | `packages/postgres/src/recall.ts` `5d1eba0b70a2572326dac43d026cc0ee38353b8c`; `packages/core/src/recall/search.ts` `3ccab71c9fb3be3100b2bff619132c86d04d631e`; `tooling/query-perf/src/common-search.mjs` `56577842e8c9718071d9ebcb519a7ee5d9c927ab`; `common-search-protocol.mjs` `3af6a7c61244632613f2824ae7fb290ccdc83a13`; `common-search-compare.mjs` `8599a1f43c9dff2e02905f541c12a1ce69684e5e`; `common-search-schema.mjs` `f0fc9bc1802947c484ef5b02d66376573e1e0698`. 마지막 세 경로의 접두사는 `tooling/query-perf/src/`다. |
| 22.4 `98ed8f890aef636d58706f1f03e23aeb71937579` | `tooling/query-perf/src/attachments.mjs` `5b460f5e34846eff5d512e4f39e254162fd4e7b6`; `attachment-fixture.mjs` `2908db689b73baae603265ba790fb26b9547f368`은 같다. `packages/postgres/src/attachments.ts`는 `f8a4da053c42e4db05f1440cadba07f02fbf31a1`에서 `adda86678a2e6541ac3a61029cd23687c4a548da`로 달라졌다. 두 ref의 diff는 22.5의 위치 predicate helper와 read/list/mark 네 호출에 한정되며 `writeAttachments`와 batch 본문은 불변이다. |
| 22.5 `0efce079cd4c94a42d9475e86fa15f3460ee9e1b` | `packages/postgres/src/attachments.ts` `adda86678a2e6541ac3a61029cd23687c4a548da`; `tooling/query-perf/src/file-locations.mjs` `1777a72f6be8c1f3e3fddf8af9d2d4d1f50f7a39`; `file-location-compare.mjs` `45dfdfd1e509a36c5b6634d1b9b1a0849e908681`; `file-location-fixture.mjs` `4fb7e6359b2c71ce99bd4c3d45f220c5a2b263f6`. 마지막 두 경로의 접두사는 `tooling/query-perf/src/`다. |

이 파일과 동작 범위가 최종 diff에서도 유지되고 독립 영향 검토가 이를 확인하면 22.1·22.2·22.4·22.5의 기존 수락 수치를 각각 **당시 동일 fixture·환경·측정 경계**의 역사 근거로 전승할 수 있다. 22.4 수치는 함수 내부의 12조건이며 전체 반입 지연이나 모든 혼합 입력의 보장이 아니다. 이후 timed 경로·SQL·fixture·임계의 실질 변경이 발견되면 지문만으로 전승하지 않고 영향과 필요한 비교를 다시 판단한다.

22.3 T57은 당시 schema39 baseline 대 실제 schema41 current의 여섯 조건 결과다. 이후 schema42 provenance와 app client 종료 gate로 전체 runner 지문이 달라졌다. [검색 계획의 T65~T81 기록](story-10-plan.md)은 검색 SQL·fixture/oracle·timed 표본 의미 보존 범위에서 당시 수치를 전승하고, 새 cleanup gate나 schema42의 새 timed 통과로 소급하지 않는다. CLI 초기화 지연, 모든 데이터 분포, 호스트 간섭 부재를 보장하지도 않는다.

## 다섯 시나리오의 러너 수락 근거 연결

entry 6의 “시험과 측정 러너가 그대로 통과”에 대해 독립 지휘 명세는 제품·timed 의미가 불변인 경우 **과거 수락 실측의 전승과 실제 영향 범위의 관련 러너 시험을 구별해 결합**하도록 정한다. 아래는 그 승인된 해석과 필요한 증거의 연결이다. 과거 실측은 규모·임계 달성 증거이고 이번 관련 시험은 현재 코드의 기능·비교·정리 경로를 확인한다. 축소 fixture나 합성 비교 시험을 새 10만 행 성능 통과로 보지 않는다.

| 시나리오 | 과거 수락 실행과 공개 기록 | 현재 전승 범위 | 이번 전체 회귀에서 확인할 러너 시험과 역할 |
|---|---|---|---|
| 22.1 import-cleanup | [계획의 확정 슬롯 측정·Verification](story-tracer-10-plan.md#design-notes): 9조건 baseline/change/compare exit 0, 10만 pending 0.045344배·idle 한도·공유 차단·hash 일치. 최초 idle 실패와 역순 제외는 별도 보존. | imports/0039/시나리오 blob과 아래 공통 helper·원래 판정 본문이 유지된다. 출처 수집 범위와 CLI 시작은 뒤에 바뀌므로 전체 runner 동일은 아니다. | `tooling/query-perf/test/core.test.ts`의 합성 9조건·경계·출처 및 `packages/postgres/test/import-cleanup-indexes.test.ts`, `import-safety.test.ts`의 실제 계약 선정·통과를 확인한다. 이 시험은 `import-cleanup.mjs`의 대형 runner 재실행을 뜻하지 않는다. |
| 22.2 session-snapshot | [계획의 최종 성능 감사](story-snapshot-10-stale-plan.md#최종-성능실행-감사): T16 baseline/current/compare exit 0, read/commit/lock 각각 0.191501/0.270441/0.270255배와 독립 지문·stale 일치. | 제품 지문·PG 경로·시나리오 blob, median/hash 및 snapshot 비교기 본문이 유지된다. 이후 신규 dispatch/import에 따른 시작·runner 지문 변화는 아래와 같다. | `session-snapshot.test.ts`의 판정·측정 구간/오류 시험과 `session-snapshot-db.test.ts`의 40행 실제 runner·정리·오류 시험, 제품 fingerprint/경쟁 시험의 실제 선정·통과를 확인한다. 40행은 10만 행 수락 실측이 아니다. |
| 22.3 common-search | [계획의 T57](story-10-plan.md): 당시 schema39→41의 6조건과 보조 oracle, baseline/current/compare exit 0, common 두 비율 0.45314079/0.44164241. | 당시 T57 runner와 수락 후 schema42·cleanup gate는 다른 지문이다. 검색 SQL·fixture/oracle·timed 의미를 대상으로 한 T67/T73/T82 독립 확인을 그대로 이어 받고 당시41을42 실측으로 바꾸지 않는다. | `common-search.test.ts`, `common-search-db.test.ts` 및 postgres 검색 계약·core/CLI 관련 시험의 실제 선정·통과로 현재 비교·준비·정리와 결과 경로를 확인한다. 소형 DB·합성 비교는 T57 10만 행을 대체하지 않는다. |
| 22.4 write-attachments | [계획의 개발 후 실제 검증](story-1-sql-plan.md#개발-후-실제-검증-결과): 승인된 T10의 12조건 행 동등·재반입 불변과 각 한도 통과; T6/T8 실패도 보존. | runner/fixture 및 아래 `compareAttachments` 본문이 같고, attachments.ts의 후속 diff는 22.5 위치 API 부분이다. 함수 내부 12조건 범위에 한정한다. | `attachments.test.ts`의 합성 비교·1/10 실제 DB runner와 `attachment-extraction.test.ts`의 행·경쟁·원문 계약을 확인한다. 소형 runner와 전체 ingest 시간은 T10 1000개 timed 증거가 아니다. |
| 22.5 file-locations | [계획의 확정 성능](story-uuid-uuid-plan.md#확정-성능과-채택-근거): 승인창 baseline/current/compare exit 0, 10만 행 read 0.045720배·mark 0.147840배와 matrix·실제 index 계획. | 위치 제품·runner/fixture/compare 파일이 수락 ref와 같고 공통 변경의 영향은 아래에 기록한다. 비정규 text fallback의 스캔은 유지된다. | `file-locations.test.ts`의 10000행 실제 store/EXPLAIN·rollback과 합성 비교·실패 raw 시험, `file-location-uuid.test.ts`의 입력·오류 matrix를 확인한다. 축소 실행은 10만 행 timed 수락을 대신하지 않는다. |

22.6에서 제품·측정/fixture 코드를 편집하지 않고 위 의존 차이의 의미 보존이 독립 확인되며, 마지막 문서 수정 후 전체 `VITEST_MAX_WORKERS=2 pnpm test` → `pnpm test:python`에서 실제 해당 시험 선정·통과와 실패 처분이 확인될 때만 이 조합을 entry 6의 러너 요구 충족 근거로 제시한다. **현재 전체 회귀는 미실행**이며 이 표는 완료 판정이 아니다. 시험 누락·실패나 timed/판정 의미 변경이 드러나면 이 조합만으로 닫지 않고 지휘자가 영향 검증 또는 중앙과 새 측정창을 조율한다.

## 선행 수락 이후 공통 의존성의 실제 차이

읽기 전용 `git diff <각 수락 ref> e8a80b18451b43a14157cf673f40c28531b7dbb9 -- tooling/query-perf/run.mjs tooling/query-perf/src`로 공통 파일과 모든 시나리오 fixture/compare의 차이를 대조했다. 각 수락 ref의 전체 commit은 22.1 `fa97231659820c58f71df16021d908256f6a1251`, 22.2 `a39224888a1ca2413df5758dbd9f6f5871e6e3fb`, 22.3 `7edfc9a110e95d405fe5a5986eeb3e64976809b7`, 22.4 `98ed8f890aef636d58706f1f03e23aeb71937579`, 22.5 `0efce079cd4c94a42d9475e86fa15f3460ee9e1b`이다. diff 원문은 로컬 실행 증거로 보존한다. 아래는 각 관련 변경을 timed·판정·출처·dispatch로 나눈 정적 판단이며 새 실행 결과는 아니다.

- **공통 계산 본문:** 각 ref의 `core.mjs`에서 export 함수 본문을 직접 추출해 바이트 SHA-256을 비교했다. `median`은 모든 ref와 기준에서 `8b2f5df0848be627b991cdfab95d96c36bfb5bdbd05358ef7ebd71ad27c49eba`, `hash`는 `5e657d09d442cb4c394bde248fb3a89e86f50d91c5cb52d680180b0bae612d04`로 각각 같다. `candidateConflict`도 모두 `c2d97aab074643c8e456a278fe573d503104ea212872dbc601db75493f2b9d00`으로 같다. `compareSnapshot`은 22.2 이후 모두 `67e381637db36507c02c87e28f57e7b9a527eaf9c6187d87c0c04a227576e6f3`, `compareAttachments`는 22.4 이후 모두 `340610228e0375b3b963af9417f6bd5d02c3cfb3ca841305e420edba1341e357`로 같다. 22.1 import-cleanup 비교 본문은 새 scenario별 선행 dispatch 분기 다음에 원래 입력 검증·비율·결과 본문이 그대로 남은 것을 diff로 확인했다. `compare` 함수 전체 바이트는 새 dispatch 때문에 다르므로 전체가 동일하다고 말하지 않는다.
- **22.1 → 기준:** `import-cleanup.mjs`의 내장 fixture, 실행·계측은 동일하다. `core.mjs`의 median/hash/candidate 및 import-cleanup 판정 본문은 유지되고 다른 시나리오 판정 분기만 앞에 추가됐다. `run.mjs`는 다른 시나리오 import/dispatch와 공통 오류 정제를 추가한다. 기존 명령의 실제 import-cleanup 호출·compare 분기는 보존되지만 모듈 로딩·오류 출력은 달라졌다. `revision.mjs`는 미추적 `packages/core/src`를 diff 지문에 추가해 **출처 기록 범위**가 달라졌으며 timed 구간의 쿼리·임계 변경은 아니다. runnerFingerprint는 전체 `.mjs` 집합을 해시하므로 새 시나리오 추가로 값이 바뀔 수 있다. 과거 결과에 새 지문을 소급하지 않는다.
- **22.2 → 기준:** `session-snapshot.mjs` 내부 fixture/oracle·timed 수집은 동일하고 `revision.mjs`도 동일하다. `core.mjs`에 위치·첨부·검색 import와 분기가 추가됐지만 snapshot 비교기 및 median/hash 본문은 동일하다. `run.mjs`의 신규 import/dispatch와 검색·위치 실패 출력은 시작·다른 시나리오 출력 경계의 변화이며 snapshot 명령과 유효한 snapshot 비교의 분기·임계는 유지된다. 모듈 로딩 및 전체 runner 지문이 같다는 뜻은 아니다.
- **22.4 → 기준:** `attachments.mjs`와 `attachment-fixture.mjs`는 동일하며 첨부 비교기 본문과 median/hash도 동일하다. `core.mjs`의 위치·검색 분기, `run.mjs`의 두 시나리오 dispatch/오류 출력이 추가됐고 `revision.mjs`는 동일하다. 유효한 첨부 결과의 비교·함수 내부 timed 경로를 바꾸는 diff는 없지만 전체 runner 지문과 시작 비용의 바이트 동일성은 주장하지 않는다.
- **22.5 → 기준:** 위치 runner·fixture·compare와 `revision.mjs`는 동일하다. `core.mjs`에 common-search import/분기, `run.mjs`에 검색 dispatch/실패 원시 출력이 추가됐고 compare 출력의 `opts.command==='file-locations'` 조건 제거는 compare 명령의 command가 `compare`라 원래 실행되지 않던 분기를 제거한다. 유효 위치 시나리오의 정제·판정 본문과 median/hash는 유지되지만 전체 모듈 로딩 및 runner 지문은 달라진다.
- **22.3 수락 source → 기준:** 공통 `run.mjs`/`core.mjs`/`revision.mjs`와 common-search runner·protocol·schema·compare의 Git diff는 없다. 다만 당시 T57 실측은 위 수락 source보다 앞선 schema41·다른 runner에서 수행됐으므로 수락 source와 기준의 동일성을 당시 T57 전체 바이트 동일로 확장하지 않는다. schema42 통합과 측정 뒤 종료 gate의 의미는 T67/T73/T82 및 앞 절에 한정한다.

위 대조에서 유효한 기존 시나리오의 timed/판정 본문을 바꾼 새 차이는 확인하지 못했다. 정적 diff는 새 import의 실제 시작 시간·환경 간섭 부재나 모든 실패 조합의 실행을 증명하지 않는다. 원래 의미가 다른 mixed-scenario 입력의 dispatch 및 새 시나리오 failure 출력은 변경된 경계이며, 현재 관련 시험과 독립 영향 확인은 별도로 필요하다.

## 보존할 실패·역사와 제외 후속

- 22.4 T6 최초 baseline은 측정창 승인 전에 실행됐다. 이후 승인된 T10 비교와 구별하며 T6을 소급 승인된 측정으로 해석하지 않는다. T6/T8의 실패와 원인 미확정도 그대로 보존한다.
- 22.1의 최초 idle 실패와 부하가 겹친 역순 비교 제외, 22.2의 최초 전체 회귀 실패와 과거 Compose ID 유실, 22.4의 두 최초 성능 실패와 최초 전체 회귀 실패, 22.5의 최초 전체 TS 실패와 이후 관련 재검증은 각 계획의 원문대로 유지한다. 이후 관련 시험의 통과를 최초 전체 명령의 성공으로 바꾸지 않는다.
- 22.3의 T49/T53/T55 미달, T58 최초 전체 TS·Python 각 exit 1, T71 changed exit 1과 Python 미도달, T74 관련 재검증은 별개 이력이다. T10/T12/T17/T20/T29/T34의 옛 raw 여섯 경로는 손실됐고 원인은 미확정이다. 생존 보고와 새 raw·새 baseline은 그 원시 표본의 복구나 대체가 아니다.
- 미출하 식 통계 `0040`은 철회됐다. 현재 `0040_drive_uploads.sql`은 Drive, `0041_sources.sql`은 sources, `0042_drive_connection.sql`은 connection에 관한 별도 수락 migration이다. 현재 `CORE_SCHEMA_VERSION`은 42이며 migration 1~42는 수정하지 않는다.
- 22.3의 상태 디렉터리 링크 교체는 자동 승인 거절로 실행·재시도되지 않았다. 이후 실제 `orb status` 한 인자만 위임한 환경은 모든 자식의 사용자 HOME 접근 부재를 증명하지 않는다. 과거 artifacts 실패 원인도 미확정이다.
- plugin version `0.1.23`과 app-ref `598497c`는 그대로다. 22.3~22.5 제품 개선이 현재 설치 ref에 들어갔다고 해석하지 않는다. 실제 배포가 필요하면 별도 릴리스에서 이전 구현 commit을 참조하고 같은 commit에서 version을 올린다.

마지막 구현·독립 후속 뒤에는 전용 합성 환경에서 `VITEST_MAX_WORKERS=2 pnpm test` 다음 `pnpm test:python`을 순차로 각 한 번 실행하고 query-perf와 관련 제품 시험의 실제 선정·결과, 최초 실패와 필요한 관련 재검증을 기록한다. 두 명령은 모두 build하므로 동시에 실행하지 않는다. 이 문서 작성 시에는 build·typecheck·시험·DB 접근·성능 측정을 실행하지 않았다.
