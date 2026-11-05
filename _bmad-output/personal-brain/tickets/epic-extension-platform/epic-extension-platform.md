---
type: epic
title: "옛 core Garmin 경로 정리와 확장 지점 보강: 확장 명령·사용자 키·cron 예약·확장 플러그인"
parent: personal-brain
covers: [R1, R2, R3, R4, R10, R14, R15, R17, R18]
sources: [_bmad-output/personal-brain/architecture-brain-v1-slice-1/architecture-brain-v1-slice-1.md]
companions: [_bmad-output/personal-brain/architecture-brain-v1-slice-1/garmin-extension-redesign-disposition.md, _bmad-output/personal-brain/research-garmin-extension-redesign-2026-11-05/research-garmin-extension-redesign-2026-11-05.md]
after: []
refined: true
risk: high
---

# 확장 지점 보강: 확장 명령·사용자 키·cron 예약·확장 플러그인

## Description

먼저 core가 Garmin을 흡수해 만들던 옛 경로(core 건강 계약·core 분석·epic 16 확장 코드)를 지운다. 그 위에서 core가 확장의 내용을 모른 채 확장을 "의족처럼" 붙일 수 있게 core의 범용 확장 지점을 보강한다(2026-11-05 사용자, spine 확장 원칙). 확장이 manifest로 읽기 명령을 선언하면 core가 CLI·MCP로 노출하고, 예약은 cron식과 한 번 실행을 받으며, 확장은 같은 marketplace의 별도 플러그인으로 설치된다. 새로 만들거나 바꾸는 표에는 사용자 키를 미리 둔다. 특정 확장(Garmin)의 의미는 이 에픽에 들어가지 않는다.

## Outcome

다른 확장이 core 수정 없이 자기 명령·예약·설정을 선언해 붙고, 사용자는 요일·월 단위 예약과 확장별 플러그인 설치를 쓴다.

## Requirements

- E20-5 (R1, R3, R18; AD-30·32·35): 옛 core Garmin 경로 정리 — core 건강 계약(건강 표·catalog·권위·판정 view·`health_aggregate_v1`·`readHealth`·core 반입 검증), core 분석(18.1 `health_analysis`·`$garmin-daily-analysis`, 18.2 snapshot reader·`analysis_snapshots`·`analyses` 확장), `garmin.raw_records`·`garmin.*` 읽기 view, epic 16 확장 코드와 그 시험이 없다. 표·함수·권한은 새 forward migration으로 drop하고 공용 부분(`file_requests`, 채널 원문 보존·legacy 채널 이력, 확장 설치·스케줄러)과 대화 수집 데이터는 그대로다(2026-11-05 epic 21의 옛 E21-1에서 옮김).
- E20-1 (R2, R14, R15; AD-37): manifest `commands[]`로 선언한 읽기 전용 명령이 설치·활성 때 `brain ext <name> <command>`와 MCP 도구 `ext_<name>_<command>`로 생기고 비활성·제거 때 없어진다. 실행은 큐 없는 짧은 자식 프로세스(그룹 정리·reap), stdin 봉투 `{abi,user_id,settings,input}`, 출력 schema 검증 → 출력 코덱 가리기 → 재검증이며, 재검증 실패는 `EXTENSION_COMMAND_OUTPUT_REDACTED`다. 쓰기 명령 선언은 설치가 거부한다.
- E20-2 (R3, R4, R10; AD-18, AD-40): 설정은 `UNIQUE NULLS NOT DISTINCT (user_id, key)`, 키별 scope(user|global), 사용자 → 공통 → 기본값 읽기, manifest 기본값은 부재 시에만 삽입. 채널 대화는 `user_id`를 갖는다. Runtime이 유일한 `is_self`를 해석해 설정·예약·일감·명령 봉투에 넣고 없으면 `USER_MISSING`. 이행은 nullable 추가 → self 보장 → backfill → 기본값 → NOT NULL 순서.
- E20-3 (R10; AD-39): 예약 trigger는 `cron`(5필드 + IANA 시간대) 또는 `once`(run_at)다. 다음 발화는 Runtime adapter(croner 11, 5-part)가 계산한다(core 외부 의존 0). 회차 표 `schedule_occurrences`가 회계 원본이고, attempt 시작 때 붙은 회차만 성공 확정한다. 놓친 회차(유예 5분)는 일감별 `latest`(기본)·`coalesce`·`skip`. 기존 daily 예약과 `schedule_successes`는 cron·회차로 옮긴다. 확장 예약 멱등 키는 `(extension, schedule_key, user_id)`이고 설치는 없는 키만 만들며 사용자 변경·삭제를 보존한다.
- E20-4 (R2, R17; AD-38): core 설치기가 패키지 공급원(`--package <경로>`, manifest 파일 목록 내용 digest, 호환 core 버전, symlink·경로 탈출 검사)을 받고 registry에 패키지 신원을 남긴다. core bootstrap과 확장 설치가 같은 설치 잠금 안에서 재확인 → quiesce → migration → 복사 → registry 전환 → 재개하고 downgrade하지 않는다. 같은 marketplace에 확장 플러그인 항목을 둘 수 있는 틀(얇은 진입점, `package/`·digest 동기화 시험, 플러그인별 ref·version 규칙)이 있다.

## Constraints

- core에 특정 확장의 이름·지표·표·프롬프트를 넣지 않는다(spine 확장 원칙).
- 이미 적용된 migration 파일은 고치지 않고 새 번호로만 바꾼다(AD-31). 대화 수집 데이터는 건드리지 않는다.
- 시험은 testext·합성 fixture로 한다. 다중 사용자 인증·RLS는 범위 밖이다(AD-40 Deferred).

## Done when

0. 저장소 실행 소스에 옛 core Garmin 경로가 없고, 업그레이드 뒤 대화 수집·파일·채널 데이터가 그대로다.
1. testext가 선언한 읽기 명령이 CLI·MCP·`guide schema`에 같은 주소·입력으로 나타나고 가려진 출력을 돌려준다.
2. 매주 금요일 cron 예약과 한 번 실행 예약이 회차 단위로 정확히 한 번씩 성공 기록되고, 놓친 회차 정책이 표대로 동작한다.
3. 설정·예약·채널 대화 행이 "나" 사용자 키를 갖고, self가 없으면 명확히 멈춘다.
4. testext 패키지를 패키지 공급원으로 설치·갱신하고, core 갱신과 겹쳐도 한쪽이 기다린다.

## Boundaries

- Garmin 명령·예약·플러그인 내용은 epic-garmin-extension이다. 이 Mac 설치본 확인은 21.7이 함께 한다.
- 다중 사용자 격리(인증 principal, RLS, 사용자별 채널 credential)는 별도 에픽이다.

## References

- parent — _bmad-output/personal-brain/initiative-personal-brain.md, Requirements R1~R4, R10, R14, R15, R17, R18
- architecture — _bmad-output/personal-brain/architecture-brain-v1-slice-1/architecture-brain-v1-slice-1.md, 확장 원칙, AD-18, AD-19, AD-31, AD-37, AD-38, AD-39, AD-40
- companion — _bmad-output/personal-brain/architecture-brain-v1-slice-1/garmin-extension-redesign-disposition.md, 새로 만드는 것·이행 순서
- research — _bmad-output/personal-brain/research-garmin-extension-redesign-2026-11-05/research-garmin-extension-redesign-2026-11-05.md, Q1·Q2·Q4

## Notes

- Decision(2026-11-05, 사용자): Garmin 확장 재설계(core는 확장을 모른다)에 필요한 core 범용 확장 지점을 완료된 epic 12·13을 다시 열지 않고 새 에픽으로 둔다.
- Decision(2026-11-05, 사용자): 11개 안(이후 정리 티켓 추가로 12개)으로 티켓 수를 줄인다. 패키지 공급원 설치와 확장 플러그인 틀은 한 티켓(20.4)이고, 이 Mac 설치본 확인은 21.7에 합친다.
- Decision(2026-11-05, 사용자): 이 에픽은 Refactor sweep(20.5)을 둔다(뗄 이유 없음).
- Decision(2026-11-05): tracer는 20.1(확장 명령)이다. manifest·설치기·CLI·MCP·출력 코덱을 모두 지나는 가장 얇은 경로다.
- Decision(2026-11-05, 사용자): 예약은 cron식 + 한 번 실행으로 간다. 규모가 커지면 cron을 별도 티켓으로 뗀다.
- Decision(2026-11-05, 티켓 검증 F3): 6(정리)·1·2·3·4는 Runtime 명령 봉투·설정 snapshot, manifest decoder, 설치기, core migration·`extension-provision.ts`를 함께 고치므로 한 레인으로 6 → 1 → 2 → 3 → 4 순서다. 6은 원래 21.1이었고 epic 21과의 상호 대기를 피하려고 이 에픽으로 옮겼다(epic 21의 id 1은 비운다).
- Decision(2026-11-05, 티켓 검증 F10): 정리(6)는 tracer(1)보다 먼저다. 지우는 작업만 tracer 앞에 두는 예외다(사용자 결정: 옛 코드를 먼저 지운다).
- Decision(2026-11-05, 티켓 검증 F8): 각 plan은 단일 대상 시험 명령, 사전 조건, 기대 관찰값, 정리 절차를 적는다. 반복은 `pnpm test:changed`, 마무리 전체 회귀는 AGENTS.md대로다.
- Risk(2026-11-05): 6 high — 잘못 지우면 대화 기억·파일·채널 기록을 잃는다(추가 확인: 업그레이드 DB의 대화·파일·채널 표 건수·해시를 drop 전후로 따로 비교). 1 medium — 명령 출력이 가려지지 않으면 비밀이 에이전트에 나간다. 2 high — 사용자 키 이행이 틀리면 설정이 사라지거나 섞인다(추가 확인: 업그레이드 전후 모든 설정 값 대조). 3 high — 회차 회계가 틀리면 예약이 두 번 돌거나 빠진다(추가 확인: 기존 daily 예약 이전 뒤 가짜 clock으로 한 달 발화 수를 손으로 센 값과 대조). 4 medium — 패키지 검증이 틀리면 다른 바이트가 설치된다. 5 low — 정리다.

- Decision(2026-11-05, 사용자; Garmin 시험 범위): epic20·21 티켓은 직접 시험 + pnpm test:changed + 독립 리뷰·필요 후속 리뷰로 built·commit·push·main 병합한다. 티켓별 전체 회귀는 생략한다(기존 verify의 전체 회귀 시점 요구보다 우선). 전체 pnpm test → pnpm test:python은21.6 완료 뒤21.7 시작 전에 순차 각1회, 그 실패만 수정·재검증한다. 다른 에픽 규칙은 유지한다. 진행 중20.6은 남은 마무리 회귀3회차를 끝내도 되며 추가 전체 반복은 요구하지 않는다. 중앙이 통합 회귀 gate 증거를 보존하고 미해결 실패가 있으면21.7을 시작하지 않는다.
