# 제품 조회 성능 에픽 종료 검증 — 2026-11-08

판정: **built**, 사용자 인수 done이 아니다. 중앙은22.1~22.6의 개별 수락·원격 main 조상과 요구사항별 결과를 대조했고, 별도 fresh-context PO Closure 검사에서도 필수 fix0/ask0으로 종료 가능 판정을 받았다. 상태 집계만으로 종료하지 않았다. 최종 수락 기준 main은535d4f1이며 아래 여섯 source가 모두 그 조상이다. 이번 종료는 문서만 바꾸며 새 시험·성능·PG 실행은 없다.

## 요구사항별 근거

| 요구 | 실제 결과와 판단 | 원문 계획 |
|---|---|---|
| E22-1 반입 정리 | 10만/pending100 17.177916→0.778916ms(.045344배). 9조건 결과·순서·공유 차단 동일, idle 전부 개선. 채택 두 인덱스8,757,248B/16,384B와동일 INSERT3배치 전후 비용, locator만/open만/SQL재작성 미채택 근거가 기록돼 있다. | [22.1](tickets/story-tracer-10-plan.md) |
| E22-2 큰 세션 | 10만 메시지/100MB read .191501배, commit .270441배, lock .270255배. 독립 전체 지문·stale·redaction·동시성 matrix와별도직렬화/hash진단의한계를기록했다. | [22.2](tickets/story-snapshot-10-stale-plan.md) |
| E22-3 흔한 검색 | T57 chunks common/a/missing .45314079/.46319883/.88510474, tools .44164241/.46677553/.81751429. 모든임계와순서·가림·잘림/metadata동등성통과. 원시base/current/compare/commands4개SHA를독립대조했다. | [22.3](tickets/story-10-plan.md) |
| E22-4 대량 첨부 | 1000/new 1018.094625→78.390667ms, SQL9000→35. existing/missing도절반이하,1/10개6조건모두개선,12조건행동등/재반입불변. 조사9002와현재9000은transaction경계제외차이로구별했다. | [22.4](tickets/story-1-sql-plan.md) |
| E22-5 위치 UUID | read5.257542→0.240375ms,mark10.493333→1.551333ms와UUID인덱스계획.12종입력·오류·순서·행변화동등,canonical소문자만UUID조건이고나머지기존text조건을유지한다. | [22.5](tickets/story-uuid-uuid-plan.md) |
| 정리 sweep | 실제리뷰85개와5계획의후보별이미해결/범위외처분,작은코드정리0건.공개2문서204줄만추가했다.공통의존/시나리오별성과전승을대조하고query-perf7개·지정제품시험선정통과를확인했다. | [22.6 계획](tickets/story-refactor-sweep-plan.md), [감사](tickets/story-refactor-sweep-audit.md) |

수락 source는22.1 fee152a6e9c98ce413452a3592e449fde0e0db14,22.2 a39224888a1ca2413df5758dbd9f6f5871e6e3fb,22.3 7edfc9a110e95d405fe5a5986eeb3e64976809b7,22.4 98ed8f890aef636d58706f1f03e23aeb71937579,22.5 0efce079cd4c94a42d9475e86fa15f3460ee9e1b,22.6 4b758e7014c4d8d217f97770458c1dd4ec8b3909다. 원격main 조상 대조와6개계획built·차단필드없음·의존문제없음을별도로확인했다.

## 제약과 실행 증거

동일 시나리오·fixture·환경의 warmup+3표본 중앙값과 전수 결과 oracle·EXPLAIN·별도쓰기/인덱스크기를 각 수락 경계에서 확인했다. 전용 합성 DB를 사용했고 적용 migration을 바꾸지 않았다. 결과 캐시·단언 축소로 성능을 대신하지 않았다. 이후 코드/공통runner 변경의 실제 영향과 바이트를 확인해 전승 가능한 범위를 구별한다. 선행수락 상태만으로 모든현재환경의성능을보장하지않는다.

각 최초 전체 회귀의 실패와 관련 수정/재검증은 해당 계획에 그대로 남는다. 마지막22.6은 전체TS4851pass/7fail/1skip→Python65pass/8fail을순차각1회실행했고,제한PATH의로컬status wrapper문제교정뒤관련TS7pass1skip→Python8pass였다. 전체명령이통과했다고소급하지않으며제품/runner변경없이해당실패를관련실행으로처분했다. sweep감사의‘현재전체회귀미실행’과검색계획의제출pending문구는그시점역사이고각최신Auto Run Result·중앙수락/원격조상증거가현재결과다.

독립 Closure 검사는공개계획/scope감사·선택한성능/최종독립원문·실제raw·Git조상을대조했다. 모든리뷰85개를새로재전수검토하거나새시험/빌드/측정을한것은아니다. 원시·리뷰·영수증/실패/소유정리는중앙gitignored보관소와보존워크트리에있다.

## 보존하는 한계와 운영 후속

- 22.3 T10/T12/T17/T20/T29/T34 raw6경로손실·원인미확정은복구되지않았다. T57은당시schema41실측이며현재42/새cleanup의timed통과가아니다.검색SQL·fixture/oracle·측정의미불변범위에서만전승한다.
- 22.1최초idle실패·부하겹침제외,22.4승인전T6실행과T6/T8실패·원인미확정,각최초회귀exit1은후속통과로바꾸지않는다.
- 긴locator·CREATE응답유실·취소readiness·합성3표본일반화·status한정위임의격리한계·과거artifacts원인미확정은 [후속 모음](../../automation/follow-ups.md)과sweep감사에보존한다. 기존에기각/범위외로처분한새계약을작은정리로재해석하지않는다.
- plugin0.1.23/app-ref598497c에는일부제품개선이아직없다. 부모Done when은main병합및인덱스근거를요구하며실운영배포를요구하지않으므로별도릴리스후속은built종료차단이아니다.실배포시이전구현commit을ref로지정하고같은releasecommit에서version을올린다.
- 미수락8.4schema43후보는이번schema42종료결과에끼워넣지않는다.향후수락시query-perf엄격manifest호환과실제영향은그티켓의독립확인/관련재검증으로평가한다.

사용자 인수와 운영 배포는 별도다. 에픽의 수락조건은 위 범위의 증거로 충족됐다.
