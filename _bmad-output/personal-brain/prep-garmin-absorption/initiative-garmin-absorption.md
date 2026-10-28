---
type: initiative
title: "Brain에서 선택 설치한 Garmin을 운영하고 기존 건강 기억을 이어 쓴다"
parent: none
sources: [_bmad-output/personal-brain/prep-garmin-absorption/accepted-intent.md]
companions: [_bmad-output/personal-brain/prep-garmin-absorption/integration-boundaries.md, _bmad-output/personal-brain/prep-garmin-absorption/migration-contract.md, _bmad-output/personal-brain/prep-garmin-absorption/roadmap.md]
after: []
risk: high
---

# Brain에서 선택 설치한 Garmin을 운영하고 기존 건강 기억을 이어 쓴다

준비용 요구사항 초안이다. 기존 personal-brain 보드에 등록하거나 별도 이니셔티브 생성을 확정하지 않았다. 후속 PO가 기존 이니셔티브 변경/에픽 편입/별도 이니셔티브 중 적합한 위치로 채택한다.

## Description

사용자는 개인 장기기억 제품 Brain 안에서 Garmin을 선택 설치하고 수집·계산·AI 분석 결과를 기존 대화/문서와 함께 사용할 수 있다. Brain이 PostgreSQL 주 저장소와 설정·작업·채널 경계를 소유하고, 기존 Garmin 원본·파생 데이터와 이미 생성한 분석을 보존해 이전한다.

## Outcome

하나의 Brain 설치와 주 DB에서 Garmin 비사용자의 기본 기능이 동작하고, Garmin 사용자는 기존 분석과 새 수집 결과를 출처와 함께 조회한다.

## Requirements

- R1 (S1): Garmin을 설치하지 않은 상태에서 Brain의 기본 설치·데몬·대화 수집이 정상 동작하고 Garmin Python 의존성을 요구하지 않는다.
- R2 (S1, S11): Garmin 확장을 설치/활성화한 사용자가 별도 Garmin 제품 설치·예약 절차 없이 연결·수집·분석을 수행할 수 있다.
- R3 (S2, E1, E5): Brain의 대화·파일 메타데이터·설정·작업·건강 데이터는 OrbStack Docker의 단일 PostgreSQL을 주 저장소로 사용하며, 컨테이너 재생성 후 보존됨을 검증한다.
- R4 (S4): 사용자/확장 설정은 DB에서 읽고 갱신하며 재시작 후 유지된다. 기계별 bootstrap과 비밀 저장 정책은 기존 Brain 계약과 일치한다.
- R5 (S3, S12, E2): 실제 존재하는 모든 이전 대상의 원본·수치·기존 분석/파일을 출처 목록으로 관리하고, 이전 후 값·본문·파일 해시·관계 동등성을 검증한다.
- R6 (S3, E2, E3): schema10/15 등 기존 소스를 먼저 원형 보관하고, legacy 데이터와 서로 다른 후보의 충돌을 자동 폐기하지 않는다.
- R7 (S3, S12): 같은 이전 batch를 재실행해도 중복되지 않고, 실패 후 재개할 수 있으며, 기존 원본과 기존 AI 분석 결과를 덮어쓰거나 재분석으로 대체하지 않는다.
- R8 (S5): 대화/문서 수집과 건강 분석 등 독립 작업이 병렬로 진행되고, 건강 평가의 입력 의존성과 같은 계정의 수집 직렬성이 유지된다.
- R9 (S6): 진행 중인 긴 작업의 소유권이 유지되고, 작업자 사망·오류·정체·사용자 취소가 구분되어 복구 또는 종료된다. 단순 임대 시간 경과로 정상 작업을 중복 실행하지 않는다.
- R10 (S5, S11, S14): 현지 일자/시간대 기준 수집·분석 예약과 수동 실행이 Brain의 같은 작업 계약을 사용하고 동일 대상의 불필요한 중복 실행을 막는다. 자동 예약은 공통 스케줄러를 선행 조건으로 두며, 준비되지 않은 상태를 설정 완료로 표시하지 않는다.
- R11 (S11, E1): 기존 수집의 token/session/MFA·계정 차단·호출 간격과 raw/정규화/수치/입력 필터 계약을 fixture 및 실패 경계 검증으로 보존한다.
- R12 (S11, S12): day/7d/30d/all 평가 순서와 성공 결과의 개별 보존을 유지하고, 계산/평가 성공과 채널 전송 성공을 별도로 기록한다.
- R13 (S7): 초기 Garmin 발신은 Brain의 공통 채널 계약을 사용하며, 후속 사용자 답변·스레드·에이전트 선제 메시지를 같은 대화에 연결할 수 있는 identity/provenance 경계를 제공한다.
- R14 (S8, S9): 에이전트가 텍스트 검색과 원문 조회를 호출해 대화·리포트·분석을 날짜/출처와 함께 찾고 실제 근거를 읽을 수 있다. 한국어 두 글자 검색과 표현 확장의 회귀 문항을 포함한다.
- R15 (S9): 건강 수치는 기간·지표·운동·집계 조건으로 조회하며, 합계/평균과 단위·NULL·현지 날짜 규칙을 코드에서 검증한다.
- R16 (S1, S3, S12): 확장을 비활성화해도 기존 건강 기억과 분석을 보존하고, 검색 가능 여부/작업 중단 상태가 명시적으로 드러난다.
- R17 (S13, S14): Brain 플러그인에 기본 포함한 공통 install 스킬을 Garmin 미설치 상태에서도 사용할 수 있고, 에이전트가 Brain CLI로 설치 상태를 확인해 설치·사용자 로그인·공통 예약 설정을 안내한다. 재실행·실패·스케줄러 미준비 상태를 구분하고 성공한 단계만 완료로 보고한다.

## Constraints

- C1 (S2): PostgreSQL 주 저장소와 OrbStack Docker는 확정이다. 기존 SQLite 주 저장소/Postgres 복제 전제를 그대로 유지하는 완료안은 인정하지 않는다.
- C2 (S8): 임베딩·pgvector·Drive 구현을 Garmin 흡수의 필수 선행 조건으로 만들지 않는다.
- C3 (S10): 이 문서는 준비 초안이다. 현재 작업으로 개인 데이터 반입·원본 migration·외부 발신·배포를 수행하지 않는다.
- C4 (S11): Python 전면 재작성은 필수 조건이 아니며, 재사용 가능한 계산·인증/호출 보호와 테스트 자산을 보존한다.
- C5 (S12, E2): 기존 분석의 모델/생성 시각이 파일에 없으면 원문과 알려진 출처를 보존하고 누락 metadata를 명시한다. 추정값을 실제 기록처럼 생성하지 않는다.

## Done when

1. Garmin 비설치 Brain과 설치된 Brain이 같은 제품 설치 흐름에서 검증되고 PostgreSQL 재생성/재시작 후 설정·기억이 유지된다(R1~R4).
2. 기존 DB/파일의 이전 결과 보고서가 출처별 건수·값/본문·해시·관계·미해결 충돌을 보이고, 재실행·실패 재개 검증을 통과한다(R5~R7).
3. 긴 건강 분석 중 대화 수집이 진행되고, 임대 갱신·작업자 사망·취소·계정 차단/순서 계약의 통합 검증이 통과한다(R8~R12).
4. 기존 분석을 원문으로 찾고 수치 질의의 결과를 독립 계산과 비교하며, 초기 채널 발신 실패가 성공 평가를 지우지 않는다(R12~R15).
5. Garmin을 비활성화해도 기존 데이터가 유지되고 상태/조회 정책이 확인된다(R16).
6. Garmin 미설치부터 시작한 install 스킬 안내로 설치·로그인·예약 상태를 확인하고, 재실행 중복 방지와 실패/취소/스케줄러 미준비 상황의 단계별 보고를 검증한다(R17).

## Boundaries

소스 코드와 기존 데이터의 소유권을 Brain으로 편입한다. 임베딩·Drive 전체 구현·Slack/Telegram 양방향 대화의 완전한 출시는 초기 흡수 범위를 자동으로 확장하지 않으며 채널 계약과 초기 발신 편입을 먼저 다룬다. 새 공개 plugin marketplace와 임의 서드파티 코드 실행 플랫폼도 이번 범위 밖이다.

- Touch point: 기존 Brain SQLite/Store·설치·doctor — PostgreSQL 주 저장소 전환 및 기존 기본 기능 보존.
- Touch point: 기존 Brain settings 계획(E8-7) — 별도 설정 저장 기능을 중복 작성하지 않는다.
- Touch point: Brain 플러그인의 공통 install 스킬 — 설치 전부터 안내를 제공하고 실제 설치는 Brain CLI를 호출한다. Garmin 사용 안내는 확장 설치 후 제공한다.
- Touch point: Garmin adapter/digest/report/body/charts — extension 도메인과 실행/저장 포트 분리.
- Touch point: 채널 대화 identity — core 소유, Garmin은 이벤트·결과 생산자.

## References

- source — _bmad-output/personal-brain/prep-garmin-absorption/accepted-intent.md, S1~S14/E1~E6
- design — _bmad-output/personal-brain/prep-garmin-absorption/integration-boundaries.md
- migration — _bmad-output/personal-brain/prep-garmin-absorption/migration-contract.md
- proposal — _bmad-output/personal-brain/prep-garmin-absorption/roadmap.md

## Notes

- Decision: 2026-10-27 사용자 요청에 따라 흡수 준비물을 작성한다. 기존 보드/active initiative와 완료 상태는 이번에 변경하지 않는다.
- Decision: 2026-10-28 공통 install 스킬을 별도 기능으로 제공한다. `brain install garmin`은 설치 CLI의 제안 사용 형태이며 현재 구현된 명령/스킬로 간주하지 않는다. 정확한 스킬 디렉터리 이름과 CLI 등록 형식은 구현에서 정한다.
- Assumption: core LLM 호출0 보장은 기본 수집/검색 경로에 유지하고, 명시적으로 활성화한 건강 분석/채널 에이전트에 별도 적용 범위를 둔다. 기존 spec과 조정할 때 확인한다.
- Open question: 개발/운영 데이터의 기준 소스와 겹치는 자연키의 충돌 선택은 무엇인가? 원본 보관·전수 목록화는 이 결정 없이 완료했으며, target publish 전에 해결한다.
- Open question: TS↔Python 저장·실행 포트, schema/테이블명, 공통 migration 소유권의 구체적인 형식은 무엇인가? 구현 전 아키텍처가 정한다.
- Open question: 놓친 현지 시각 예약과 진행 정체의 단계별 기준은 무엇인가? 작업 runtime 계약에서 정한다.
