---
type: epic
title: "회귀 시험 시간: 계약을 지키며 10분 넘는 회귀를 대폭 줄인다"
parent: personal-brain
covers: []
sources: [_bmad-output/personal-brain/research-performance-2026-11-04/research-performance-2026-11-04.md]
companions: [_bmad-output/personal-brain/research-performance-2026-11-04/tests/report.md, _bmad-output/personal-brain/research-performance-2026-11-04/sql/report.md, _bmad-output/personal-brain/research-performance-2026-11-04/garmin/report.md]
after: []
refined: true
risk: medium
---

# 회귀 시험 시간: 계약을 지키며 10분 넘는 회귀를 대폭 줄인다

## Description

`pnpm test`와 `pnpm test:python` 회귀가 10분 넘게 걸려 개발이 늦어진다. 이 에픽의 목표는 그 시간을 대폭 줄이는 것이다. 성공한 16.6 회귀 기록에서 Vitest 구간 약 665초 중 약 583초(88%)가 Python 통합 시험 suite였고, 이 suite는 공유 확장 role 때문에 파일을 하나씩 직렬로 돌린다(source "확정 결과 5"). 그래서 가장 큰 수단은 이 suite의 병렬화이고, 그다음이 2026-11-04 성능 조사가 실측으로 확인한 시험 병목(건강 현재값 판정 18.10 제외)이다: 두 suite가 같은 bootstrap hook 시험을 두 번 도는 중복, 시험마다 새 DB에 전체 migration을 반복하는 비용(4파일 362개 DB, 준비·정리가 명령 시간의 약 58.6%), 새 home마다 matplotlib 폰트 캐시를 만드는 비용(약 10.6초), 파일 등록 확인의 고정 1초 대기(신규 그래프 3장 중 약 3초)이다. (2026-11-05: import-verify 안정화는 검증 경로 자체가 20.6에서 사라져 은퇴했고, 이 에픽은 18.3의 선행이 아닌 독립 에픽이다.) 그 뒤 반복 검증(`pnpm test:changed`)의 실행 기록과 단독 시험 선택 좁히기를 이어 간다(source "확정 결과 6"). 두 번째 build(약 1초)는 이득이 작아 넣지 않는다. 제품 조회 성능(반입 정리·큰 세션·검색·로그 scanner)은 이 에픽의 목표가 아니다.

## Outcome

이 Mac의 개발자(사용자와 티켓 워커)가 돌리는 회귀 시험이 같은 조건의 전후 비교에서 크게 빨라지고, 어느 개선도 기존 계약·시험 assertion을 줄이지 않는다(source "현재 결론", "TODO").

## Requirements

- E19-1 (source "확정 결과 2"): 시험 DB 준비 — 각 시험은 지금처럼 다른 시험과 상태를 공유하지 않는 DB·role·권한을 받는다. 조사에서 잰 네 시험 파일(redaction·store·work-store·sessions-ingest)의 DB 준비·정리 합계는 같은 조건 전후 비교에서 기준의 절반 이하가 되고, case 수와 통과 결과는 같다. migration 자체·파괴적 DDL·role/권한을 검증하는 시험은 새 DB에서 migration을 적용하는 경로를 그대로 검증한다.
- E19-2 (source "확정 결과 3"): 폰트 캐시 — 새 home을 만드는 시험이 matplotlib 폰트 목록 생성을 home마다 반복하지 않는다. 각 home의 캐시 디렉터리는 private(0700)이고, 한글 라벨 그래프는 같은 폰트 family를 고르고 glyph 누락이 없으며, 손상되거나 버전이 다른 캐시는 다시 만들어진다.
- E19-5 (source "확정 결과 5"): Python 통합 시험 병렬화 — `pnpm test:python`의 파일들이 서로 role·DB·container를 공유하지 않는 여러 slot에서 동시에 돌아, 같은 조건의 중앙값이 1 slot 기준의 절반 이하가 된다. case 수·통과 결과는 같고, 한 파일이 실패·timeout해도 다른 파일과 다음 실행이 영향받지 않으며, 실행 뒤 남는 role·DB·container·포트가 없다. 생산 확장 role 계약은 바꾸지 않는다.
- E19-6 (source "확정 결과 5", tests report "bootstrap 구성 비용과 중복 범위"): hook 시험 중복 — 두 suite를 합쳐 bootstrap hook 시험의 각 case가 한 번만 돌고, 두 suite의 hook case 합집합과 Python 전용 보존 case는 그대로다.
- E19-7 (은퇴 2026-11-05: 대상 core import-verify 경로가 20.6에서 사라진다. 새 반입 검증의 안정성은 21.2·21.7) — 옛 내용: `garmin-import-verify` 시험과 그 검증 단계를 쓰는 `garmin-batch-import`의 인코딩별 검증 case가 같은 커밋·독립 환경에서 연속 20회 모두 같은 결과를 내고, 실패하면 가려진 출력에 원래 예외·work_id가 남는다. 가림 규칙과 반입 검증 판정 의미는 그대로다.
- E19-10 (source "확정 결과 7"): normalize 취소·fence 순서 — 감독자 취소가 먼저 오는 경우와 attempt fence가 먼저 오는 경우가 각각 강제돼 매번 같은 결과로 검증되고, 두 경우 모두 받은 행 보존·오래된 attempt 쓰기 0·재개 지점이 같다. 제품의 취소·fence 의미는 그대로다.
- E19-8 (source "확정 결과 6"): test:changed 실행 기록 — 매 실행이 단계별 시간·종료 코드·중단 사유·선택 목록과 그 이유를 로컬 구조화 기록으로 남기고, 기록 실패가 시험 결과를 바꾸지 않는다.
- E19-9 (source "확정 결과 6"): 단독 시험 선택 — 런타임에 쓰이지 않는 단독 시험 파일만 바뀐 경우 반복 검증이 Python 전체를 돌지 않고, 그 밖의 경우 선택은 그대로다.
- E19-3 (source "확정 결과 3"): 등록 확인 대기 — 그래프와 digest 파일 등록 확인에 요청마다 고정 대기 시간이 붙지 않는다: 실제 core 등록 경로에서 신규 그래프 3장과 digest의 대기 합계가 각각 기준의 절반 이하이고, 확인 조회 횟수는 상한 안에 있다. 그래프별 실패 격리, 취소·중지·attempt 무효 전파, 중단 뒤 재개, 완료 캐시 재사용의 결과는 기존과 같다.

## Constraints

- 개선마다 같은 환경·fixture·기준 커밋에서 warm-up 뒤 3회 중앙값으로 전후를 비교하고, 결과 동등성(행·순서·오류 분류)을 함께 보인다. 조사 수치를 보장 절감량으로 쓰지 않는다(source "측정·범위의 남은 공백").
- 시험 assertion 축소, 시험 생략, 전역 timeout 증가, 결과 캐시, mock 대체로 성능 개선을 대신하지 않는다.
- 무조건 인덱스 일괄 추가, Python 전체 이식, 광범위 재작성은 하지 않는다. 인덱스는 특정 분포에서 악화할 수 있다(source "확정 결과 4" 채널 최신 결과 인덱스).
- 측정은 전용 독립 DB·home에서 직렬 잠금 아래 한다. 공용 시험 DB(54329)·운영 계정·실제 transcript·건강값을 쓰지 않으며 공개 plan에 개인 값이나 홈 절대 경로를 쓰지 않는다.
- 구현 반복은 `pnpm test:changed`, 커밋 직전 `pnpm test`와 `pnpm test:python`을 순차로 한 번씩(AGENTS.md). 성능 비교의 warm-up·3회 반복은 대상 시험 파일·조회에만 하고, 전체 suite 시간은 커밋 직전 필수 1회 실행에서 기록한다. 전체 suite를 반복 측정하지 않는다.

## Done when

- E19-5·E19-6·E19-1~E19-3·E19-10이 각각 동일 조건 전후 수치와 계약 동등성 검증을 갖고 main에 병합돼 있다(기준은 20.6 정리·21.3 이식 뒤의 시험 집합에서 새로 잡는다).
- 마지막 스토리의 커밋 직전 전체 `pnpm test`·`pnpm test:python` 시간이 16.6 회귀 기록(Vitest 구간 약 665초)과 나란히 plan에 기록돼 있다.
- 각 스토리의 커밋 직전 전체 `pnpm test`·`pnpm test:python`이 통과하고, 그 전체 시간이 plan에 기록돼 있다.
- E19-8·E19-9가 병합돼 있고, 반복 검증의 선택 범위와 시간을 기록으로 셀 수 있다.

## Boundaries

- 건강 현재값·판정 view와 18.10은 2026-11-05 없어졌다(20.6 정리). 이 에픽은 그 성능을 다루지 않는다.
- 제품 조회·반입 성능(반입 정리 anti-join, 큰 세션, 흔한 검색어 점수, 로그 scanner)은 시험 시간 목표 밖이라 이 에픽에 없다. 조사 문서 TODO에 남는다.
- 두 번째 `pnpm build` 제거(약 1초), 실제 ref upgrade E2E 측정, typecheck 단독 시간은 이 에픽에 없다. 이득이 작거나 증거가 없다(source "확정 결과 5").
- 기능 의미(반입·정리·그래프·비밀 판정)는 바꾸지 않는다. 바꿔야만 빨라지는 개선은 별도 결정으로 올린다.
- batch-import 첫 case의 120초 timeout과 redaction 행 수 불일치(원인 미확정, 재현 방법은 source "확정 결과 7"), 기본 changed와 Postgres 전체·tracer 추가 실행의 중복(양 미측정), 넓은 규칙의 일괄 축소(의존 누락 위험)는 이 에픽에 없다. 조사 문서 TODO에 남는다(source "확정 결과 6").
- 생산 daemon 기본 polling 주기, 시험용 25ms polling, no-op migration 왕복(약 22ms), 패키지 digest·uv 준비는 근거가 약해 범위 밖이다(source "확정 결과 2·3").
- Touch point: Garmin 그래프·digest 발행(이식된 옛 프로그램의 차트·파일 발행 경로, 21.3·21.5) — 대기·캐시 방식만 바꾼다; owner: epic-garmin-extension (2026-11-05. 옛 owner epic-garmin-runtime)

## References

- research — _bmad-output/personal-brain/research-performance-2026-11-04/research-performance-2026-11-04.md, "확정 결과 2~7", "TODO"
- research — _bmad-output/personal-brain/research-performance-2026-11-04/tests/report.md, "4개 파일의 실제 구간", "영향·18.10·티켓 판단"
- research — _bmad-output/personal-brain/research-performance-2026-11-04/garmin/report.md, "후보별 판정", 2·3절
- parent — _bmad-output/personal-brain/initiative-personal-brain.md, Constraints C4
- sibling — _bmad-output/personal-brain/tickets/epic-health-analysis/tickets/tickets.toml, entry 10 (18.10), entry 3 (18.3)

## Notes

- Decision(2026-11-04, 사용자): 성능 조사 결과·TODO를 BMad 티켓으로 만든다. 기존 18.10은 다시 만들지 않는다. 티켓 작성까지만 하고 구현을 시작하지 않는다.
- Decision(2026-11-04, 사용자 확인): 새 에픽으로 둔다. 대상 코드가 epic 2·10·11·16·17에 흩어져 있고 그 일부는 done이라, 거기에 더하면 끝난 에픽을 다시 연다.
- Decision(2026-11-04, 사용자 A): 시험이 10분 넘게 걸려 개발이 늦어지므로 18.10 → 19.1 시험 DB → 19.2 폰트 캐시 → 19.3 등록 대기 → 18.3 순서로 한다. lane 안의 `after`는 실제 공유 때문이다: 19.1은 18.10 회귀 시험이 쓰는 fixture를 바꾸고, 19.2는 19.1과 시험 home 준비(`apps/cli/test/ext-fixture.ts`의 extHome → `pg-home.ts`의 pgHome)를, 19.3은 19.2와 `extensions/garmin/tests/check_charts.py` 검증을 함께 쓴다. 18.3이 셋을 기다리는 것은 순서 결정이다.
- Decision(2026-11-04, 사용자 A): epic 19를 epic 18 앞에 둔다. entry 단위로 서로 기다려(18.10 → 19.1~19.3 → 18.3) `tickets.py status`에 order_conflict 1건이 남으며, 승인된 예외다. entry 사이 순환은 없다. 없애려면 19.5의 실제 선행(18.10)을 지우거나 epic 19를 epic 18에 합쳐야 하는데, 앞의 것은 위 충돌을 만들고 뒤의 것은 번호·요구사항 이전이 필요해 택하지 않았다(2026-11-04 사용자 확인). 이 예외는 런북 티켓 선택 절과 epic-health-analysis Notes에도 적혀 있다.
- Decision(2026-11-04, 사용자 추천안 채택): 조사가 미완료인 항목(전체 시험 재측정, 큰 세션·검색·로그 scanner spike)은 티켓에서 빼고 조사 문서 TODO로 둔다. 근거가 확인된 스토리만 남긴다(당시 네 개, 이후 runner 조사로 19.5·19.6 추가, 반입 정리 은퇴).
- Decision(2026-11-04, 사용자 채택): tracer는 19.5다. 이 에픽은 기능 경로가 아니라 독립 개선의 묶음이라 "모든 layer를 지나는 가장 얇은 경로"가 없다. 예상 절감이 가장 크고(수분) 격리 위험도 가장 큰 스토리를 먼저 둔다.
- Decision(2026-11-04, 사용자 채택): 닫는 Refactor sweep 스토리는 두지 않는다. 스토리들이 runner 설정·시험 fixture·charts.py·runtime_artifacts.py를 각각 건드리는 개선이라 모아서 치울 공통 정리가 생기기 어렵다. 리뷰가 미룬 정리가 쌓이면 그때 스토리로 더한다.
- Parked: 위치 UUID 조건(대문자·비UUID 계약 차이), 채널 목록 최신 결과 인덱스(분포에 따라 악화), 첨부 대량 반입, Garmin 원문 재해시, Garmin unpublished/retry_items 무변경 전수 읽기·이력 성장(82MB·20만 행에서 약 457ms) — 실제 빈도·규모 근거가 생기면 판단한다(source "TODO" 낮은 우선순위 후보).
- Decision(2026-11-04, 사용자): 개발 속도·품질 추가 조사(확정 결과 6)로 19.7 import-verify 안정화(19.5 뒤, 18.3 전), 19.8 test:changed 실행 기록(19.6 뒤), 19.9 단독 시험 선택 좁히기(19.8 뒤)를 더한다. 19.7은 19.1이 바꾸는 시험 DB 준비를 쓰므로 19.1 뒤다(Set 재검증 반영). 19.8·19.9는 18.3을 막지 않는다. 19.8·19.9는 19.6과 같은 run.mjs·rules.mjs와 그 시험을 바꾼다.
- Decision(2026-11-04, 사용자): 불안정 시험 정적 조사(확정 결과 7)로 normalize 취소·fence 순서 경합을 19.10으로 더한다(19.1 뒤, 18.3 전). batch-import UTF-16 실패는 import-verify 검증 단계와 같은 실패라 19.7에 합친다. batch-import timeout과 redaction은 재현 실측이 먼저라 조사 TODO에 둔다.
- Waits on epic-health-analysis because: 19.5는 18.10이 같이 바꾸는 시험 선택 규칙(`tooling/test-changed/rules.mjs`와 그 시험)과, `BRAIN_TEST_DATABASE_URL`로 시험 DB를 받는 18.10의 측정 도구(`tooling/health-perf`)를 이어받아 slot 구성으로 바꾼다. slot 수도 18.10 뒤 정규화 시험 시간으로 정해진다(2026-11-04 18.10 checkout 읽기 전용 확인).
- Decision(2026-11-04, runner 조사 반영, 사용자 확정): 시험 시간 lane을 예상 절감 큰 순으로 18.10 → 19.5 Python 병렬화 → 19.6 hook 중복 제거 → 19.1 시험 DB → 19.2 폰트 캐시 → 19.3 등록 대기 → 18.3으로 한다. 이 화살표는 실행 우선순위이고, 실제 의존은 19.5 → 19.6, 19.5 → 19.1 → 19.2 → 19.3으로 갈라진다. 19.6은 19.5와 같은 Python config를, 19.1은 19.5가 바꾸는 시험 DB helper(pg-home·tooling/test-db)를 건드려 19.5 뒤다. 18.3은 다섯 스토리를 모두 기다린다(순서 결정, 당시 기록; 이후 19.7·19.10이 더해져 지금은 일곱). E19-4는 은퇴했고 id를 다시 쓰지 않는다.
- Decision(2026-11-04, 사용자): 이 에픽의 목표는 10분 넘는 회귀 시험 시간을 대폭 줄이는 것이다. 그래서 제품 성능인 반입 정리 조회(옛 19.4)는 빼서 조사 문서 TODO로 돌린다. 기존 조사가 보지 않은 runner 구성(`apps/cli/python-test/vitest.config.ts`의 `fileParallelism: false`로 Python 통합 시험 18파일+hook 시험이 직렬, 두 명령의 build 중복, typecheck)을 조사해 결과로 스토리를 더한다.
- Decision(2026-11-05, 사용자, Garmin 확장 재설계): 이 에픽은 18.3의 선행이 아니라 독립 개발 생산성 에픽이다. 19.5는 18.10 대신 20.6(정리 뒤 Python 시험 집합)을, 19.10은 21.3(옛 normalize 이식)을 기다린다. 측정 기준은 새 시험 집합에서 다시 잡는다. 승인 예외였던 order_conflict는 원인이 사라져 끝났다.
- Dropped(2026-11-05): 19.7 — 불안정했던 core import-verify 검증 경로 자체가 20.6에서 사라진다. 새 반입 검증의 안정성은 21.2·21.7이 맡는다.
- Decision(2026-11-05, 티켓 검증 F1): 19.5·19.1·19.2·19.3·19.10은 `refine = true`다. 18.10 산출물(health-perf) 인계, 옛 epic 16의 charts·runtime_artifacts·collect_fixture·normalize_store 경로, core import-verify를 전제한 옛 수락조건은 무효이고, 착수 전에 20.6·21.3 뒤의 실제 시험 집합과 fixture로 다시 refine한다. 측정 기준도 그때 새로 잡는다.
