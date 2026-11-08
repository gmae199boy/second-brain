---
type: epic
status: built
title: "제품 조회 성능: 데이터가 쌓여도 반입 정리·큰 세션·검색·첨부 반입이 느려지지 않는다"
parent: personal-brain
covers: [R3, R14, R18]
sources: [_bmad-output/personal-brain/research-performance-2026-11-04/research-performance-2026-11-04.md]
companions: [_bmad-output/personal-brain/research-performance-2026-11-04/sql/report.md]
after: []
refined: true
risk: medium
---

# 제품 조회 성능: 데이터가 쌓여도 반입 정리·큰 세션·검색·첨부 반입이 느려지지 않는다

## Description

2026-11-04 성능 조사(source "확정 결과 4", sql report)가 독립 PostgreSQL 18 실측으로 확인한 제품 SQL·처리 병목을 고친다. 시험 시간 에픽(19)은 이것을 목표 밖으로 뒀고, 건강 판정 view는 20.6이 지운다. 남은 후보는 데이터가 쌓일수록 그대로 느려지므로 별도 에픽으로 둔다(2026-11-05 사용자). 각 개선은 결과 동등성과 같은 조건 전후 측정으로 채택하고, 인덱스는 쓰기 비용과 함께 판단한다.

## Outcome

대화·파일·첨부가 많아져도 데몬의 반입 정리, 큰 세션의 수집·검증, 흔한 검색어 검색, 대량 첨부 반입이 같은 결과를 더 빠르게 낸다.

## Requirements

- E22-1 (R3, R18; sql report 4): 반입 정리 anti-join — `packages/postgres/src/imports.ts`의 미정리 조회(완료 이력 10만·미정리 100건에서 1.14초)가 같은 결과를 내며 기준의 절반 이하가 된다. 후보 인덱스(`(source, locator)`, `request_id WHERE cleaned_at IS NULL`)는 크기와 같은 쓰기 배치 전후 시간을 함께 기록해 채택하거나 근거를 남긴다. 공유 locator 차단 의미는 그대로다.
- E22-2 (R18; sql report 2): 큰 세션 snapshot — 메시지 10만·본문 100MB 세션의 두 snapshot transaction(약 3.65초, 잠금 체류 약 1.86초, 메모리 약 4GiB)이 같은 지문·stale 판정·redaction·동시 반입 안전성을 지키며 기준의 절반 이하 시간과 잠금 체류가 된다. 순수 TS hash·직렬화와 재읽기 중 실제 비용 구간을 먼저 나눠 잰다.
- E22-3 (R14; sql report 5): 흔한 검색어 — 후보 10만 건에서 흔한 단어(chunk 1.54초, tool 1.74초)가 상위 결과 순서·잘림 계약(AD-15)을 그대로 지키며 기준의 절반 이하가 된다.
- E22-4 (R18; sql report 7): 대량 첨부 반입 — 첨부 1천 개·위치 2개의 9,002 SQL 직렬 왕복(1.02초)이 같은 행·멱등성을 지키며 SQL 수와 시간이 기준의 절반 이하가 된다. 소수 첨부의 시간이 나빠지지 않는다.
- E22-5 (R18; sql report 3): 위치 조회 UUID 조건 — `attachments.ts` 위치 read/mark의 `id::text` 비교 전체 스캔(10만 행 단건 5.24ms)을 인덱스 조회로 바꾸되, 대문자·비정규 UUID·비 UUID 입력의 기존 결과를 그대로 낸다(canonical 입력 검증 포함).

## Constraints

- 같은 환경·fixture·기준 커밋에서 warm-up 뒤 3회 중앙값으로 전후를 비교하고 결과 동등성(행·순서·오류 분류)을 함께 보인다. 조사 수치를 보장 절감량으로 쓰지 않는다.
- 결과 캐시·assertion 축소·시험 전용 우회·의미 변경으로 성능을 대신하지 않는다. 무조건 인덱스 일괄 추가는 하지 않는다(특정 분포에서 악화한 채널 인덱스 사례).
- 측정은 전용 독립 DB에서 합성 데이터로 한다. 운영 DB·실제 대화를 쓰지 않는다. 이미 적용된 migration은 고치지 않는다(AD-31).

## Done when

1. E22-1~E22-5가 각각 같은 조건 전후 수치·실행 계획·결과 동등성 증거와 함께 main에 병합돼 있다.
2. 채택한 인덱스마다 크기와 쓰기 비용이 plan에 있고, 채택하지 않은 후보는 근거가 있다.

## Boundaries

- 시험 실행 시간(DB 준비·병렬화 등)은 epic-test-time이다. 건강 판정 view는 20.6이 지운다.
- 채널 목록 최신 결과 인덱스(분포에 따라 악화), Garmin 원문 재해시, 많은 로그 scanner는 실제 빈도·규모 근거가 생길 때까지 조사 문서 TODO에 둔다.

## References

- parent — _bmad-output/personal-brain/initiative-personal-brain.md, Requirements R3, R14, R18
- research — _bmad-output/personal-brain/research-performance-2026-11-04/research-performance-2026-11-04.md, "확정 결과 4", "TODO"
- research — _bmad-output/personal-brain/research-performance-2026-11-04/sql/report.md, 후보 2·3·4·5·7, 재현 절차

## Notes

- Decision(2026-11-05, 사용자): 성능 조사에서 확인한 제품 SQL 병목은 고치지 않으면 데이터가 쌓일수록 그대로 느리므로 티켓으로 반영한다. 시험 시간 에픽(19)의 "제품 조회 성능은 목표 밖" 결정은 유지하고 별도 에픽으로 둔다.
- Decision(2026-11-05): Garmin 작업(epic 20·21) 뒤에 한다. 기능 선행이 아니라 core migration·Store 편집 충돌을 피하는 순서 결정이다. 다섯 후보는 서로 다른 코드라 병렬로 갈 수 있다.
- Decision(2026-11-05, 사용자 규칙): Refactor sweep(6)을 둔다.
- Decision(2026-11-05): tracer는 1(반입 정리)이다. 측정 러너·fixture·결과 동등성 비교 틀을 처음 만들고 2~5가 다시 쓴다. 각 plan은 측정 명령·준비/측정 구간·실행 계획·행수·정리 절차를 적는다.
- Risk(2026-11-05): 1 medium — 정리 대상 판정이 틀리면 파일 원본을 너무 일찍 지운다. 2 high — 지문·stale 판정이 틀리면 대화 기억이 빠지거나 겹친다(추가 확인: 동시 반입 경쟁 fixture로 행 수·지문을 독립 계산과 대조). 3 medium — 순위가 바뀌면 찾던 근거가 빠진다. 4 medium — 일괄화가 멱등성을 깨면 첨부가 중복된다. 5 low — 입력 형식이 다르면 위치를 못 찾는다. 6 low — 정리다.

- Decision(2026-11-08, 중앙 수락): 22.1~22.6의 원격 main 반영과 요구사항별 성능·동등성·인덱스/쓰기 근거를 대조하고 fresh-context Closure 검사 fix0/ask0으로 built 전이한다. 상세는 [종료 검증](epic-query-performance-closure.md)이며 최초 실패·22.3 옛 raw 손실/성과 전승 한계·운영 배포 후속은 보존한다. 사용자 인수 done은 아니다.
