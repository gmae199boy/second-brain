---
type: epic
status: built
title: "Codex 대화 수집: Codex 세션도 Claude Code처럼 빠짐없이 쌓이고 찾아 읽힌다"
parent: personal-brain
covers: []
sources: []
companions: []
after: []
refined: false
risk: medium
---

# Codex 대화 수집: Codex 세션도 Claude Code처럼 빠짐없이 쌓이고 찾아 읽힌다

## Description

지금 Brain이 수집하는 대화는 Claude Code뿐이다. 대화 parser는 harness `claude-code` 하나다. Codex는 `~/.agents/skills/brain-*` 스킬로 Brain을 읽고 쓸 수 있지만, Codex 세션 자체는 Brain에 쌓이지 않는다. 이 에픽은 Codex 세션 기록을 읽는 parser와 수집 트리거(hook 또는 폴더 스캔)를 더한다. 그래서 Codex 대화도 기존 수집 계약(원문 저장, 멱등, 증분, 프로젝트·워크트리 꼬리표, 나갈 때 비밀 가리기)을 따라 쌓이고, `recall`·`sessions read`로 찾고 읽힌다. 수집 경로의 공통 부분(세션 Store, 일감 대기열, drain, spool, 마스킹)은 epic-capture가 이미 만들었고, 이 에픽은 그 위에 Codex용 입력을 더한다.

## Outcome

Codex로 일한 대화도 Claude Code 대화와 같은 기억이 되어, 어느 에이전트에서 일했든 Brain에서 찾아 근거를 읽을 수 있다.

## Done when

1. 이 기계의 Codex 세션 수와 Brain에 harness Codex로 들어간 세션 수가 같다. 설치·연결 때 디스크에 남아 있던 Codex 세션 기록도 들어간다.
2. 같은 Codex 세션 기록을 두 번 수집해도 모든 테이블의 건수가 같고, 진행 중인 세션은 증분으로 이어서 쌓인다.
3. Codex 세션이 시작된 폴더 기준으로 Claude Code 세션과 같은 프로젝트·워크트리 꼬리표를 얻는다.
4. Codex 대화가 `recall`·`sessions read`로 찾고 읽히며, 나갈 때 비밀이 가려진다.
5. `setup connect`와 doctor가 Codex 수집 상태(연결, 미수집, 실패, 마지막 수집 시각)를 보인다.
6. 운영 설치본에 반영되어 이 Mac의 실제 Codex 세션으로 확인된다.

## Boundaries

- 공통 수집 계약(세션 Store, `work_items`·drain·spool, 실패 기록, 출력 가리기, 꼬리표 규칙)은 바꾸지 않고 쓴다. 바꿔야 하면 epic-capture의 결정을 고치는 별도 결정으로 남긴다.
- Codex 쪽 시작 맥락 주입은 이 에픽 밖이다(epic-log-and-context가 harness별로 다룬다).
- Codex 이외의 다른 harness는 범위 밖이다.
- Touch point: 대화 parser 등록부·수집 경로 — Codex parser를 더한다; owner: epic-capture
- Touch point: 조각·검색 — Codex 세션도 같은 조각·검색 경로를 탄다; owner: epic-search-and-health-query
- Must not change: Claude Code 수집의 저장 결과(본문·건수·꼬리표)

## References

- parent — _bmad-output/personal-brain/initiative-personal-brain.md, Requirements
- spec — _bmad-output/personal-brain/spec-brain-v1-slice-1/spec-brain-v1-slice-1.md, Capabilities CAP-1
- epic — _bmad-output/personal-brain/tickets/epic-capture/epic-capture.md, Requirements E2-4~E2-7, Notes Decision(2026-10-15)

## Notes

- Decision(2026-11-17, 사용자): epic-capture의 2026-10-15 결정 "당분간 Claude Code만(Codex 제외)", "다른 Harness의 세션은 범위 밖"을 이 에픽으로 바꾼다. Codex 수집을 새 에픽으로 두고, 끝난 epic-capture는 다시 열지 않는다.
- Decision(2026-11-17, 사용자): 남은 에픽 중 이 에픽을 가장 먼저 개발한다. 빌드 순서에서 미완료 항목이 남은 첫 에픽(epic-extensions) 앞에 두어 `tickets.py next`의 첫 시작 후보가 이 에픽의 첫 항목이 되게 한다.
- Decision(2026-11-17): 첫 항목은 spike(Codex 세션 기록 실측)다. 가장 불확실한 것이 Codex 쪽 사실(기록 형식·트리거)이라서다. tracer는 그다음 항목 2(fixture 세션 하나 → parser → 수집 → `sessions read`)다. 3(증분·스캔)과 4(꼬리표)는 2 뒤에 나란히 갈 수 있다. 3~6의 상세 범위는 spike 결과에 따른 아래 결정으로 확정한다.
- Decision(2026-11-17): 항목이 셋보다 많아 Refactor sweep(7)으로 닫는다. 닫는 e2e 스위트는 두지 않고, 6(이 Mac 실사용 확인)이 완료 조건을 실제 세션으로 확인한다.
- Decision(2026-11-17, 사용자): 스토리는 leaf 파일로 쓰지 않고 이 에픽의 `tickets/tickets.toml` 항목으로만 계획한다. 파일은 항목을 시작할 때 만든다.
- Decision(2026-11-17, spike 23.1): [실측 연구](epic-codex-capture-research.md)를 근거로 기존 2~7 분할과 의존성을 유지한다. 2는 파일별 `payload.id`를 세션 키 후보로 검증하며 부모·자식의 별도 수집과 호출·출력 대응을 다룬다. 부모 관계 저장에 공통 계약 변경이 필요하면 별도 결정으로 다룬다.
- Decision(2026-11-17, spike 23.1): 3은 활성·보관 양쪽 스캔, 이동·중복, 미완성 줄과 재작성 복구를 맡고 4는 최초 cwd 기준 정체성을 맡아 2 뒤에 병렬 가능하다. 5는 3 뒤 연결·진단과 기존 notify 공존, 6은 3·4·5 뒤 실제 기록 대조, 7은 기존 sweep 범위를 맡는다. 3의 스캔은 hook·notify 적용 여부와 관계없이 복구 경로다.
- 실측 한계: 한 파일의 append와 이 기계의 표본에서 ID 관계를 확인했을 뿐 형식 안정성·항상 append를 보장하지 않는다. hooks는 로컬 기능 표시와 공식 문서로 지원을 확인했지만 실제 hook·notify 실행과 신뢰·설정 공존은 검증하지 않았다. 각 후속 항목은 이 한계를 fixture와 실제 환경 검증으로 다룬다.
- Open question: initiative Requirements에 Codex 수집을 다루는 줄이 없어 `covers`가 비어 있다. 이 에픽을 정제할 때 initiative에 줄을 더할지(SPEC), 이 에픽 Requirements가 spec CAP-1을 직접 인용할지 정한다.
