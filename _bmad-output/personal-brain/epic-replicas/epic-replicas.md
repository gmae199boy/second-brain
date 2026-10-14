---
type: epic
title: "복제 대상과 원본 이전"
parent: personal-brain
covers: [CAP-11, CAP-12]
after: ["epic-operations"]
assignee: ""
risk: medium
---

# 복제 대상과 원본 이전

## Description

로컬 SQLite 원본을 그대로 두고, 사용자가 고른 복제 대상(Postgres, Drive의 기계별 append-only 파일)이 원본을 따라오게 한다. 남겨 둔 `packages/postgres`와 설치기의 Docker 흐름을 다시 쓴다. 사용자가 원하면 `brain setup move-store --to postgres`로 원본을 검증된 방식으로 옮긴다. 나중에 `/brain:migration` 스킬이 이 명령을 감싼다.

## Outcome

Postgres나 Drive를 붙여도 원본은 하나로 남고, 복제 대상이 늦어지거나 실패해도 기억을 잃지 않는다.

## Requirements

- E7-1 (CAP-11): `setup run`의 선택 단계로 복제 대상 추가. 설정은 `[[replicas]]`(Postgres URL은 환경 변수 이름). (AD-10·18·19)
- E7-2 (CAP-12): 커서로 따라잡는 복제. 원본 쓰기를 막지 않고, 복제는 값을 만들지 않는다. (AD-10·22)
- E7-3 (CAP-11): `brain setup move-store --to postgres`: 쓰기 정지 → 복사 → 건수·해시 검증 → 원본 전환 → 옛 파일은 읽기 전용 백업. (AD-10)
- E7-4 (CAP-11): doctor가 대상별 지연과 실패를 보인다.

## Done when

1. 꺼졌다 켜진 복제 대상이 빠짐없이 따라잡고, 원본과 같은 값(ID·`seq`·시각)으로 되읽힌다.
2. 복제 대상의 실패가 원본 쓰기를 막지 않는다.
3. `move-store` 뒤 테이블별 건수·해시가 같고, 옛 `brain.db`는 읽기 전용으로 남는다.
4. doctor가 대상별 지연을 보인다.

## Boundaries

AD-10·22. 원본은 로컬 SQLite이고, 복제 대상의 읽기·검색은 하지 않는다. Drive 파일 저장소(첨부 원본)는 epic-drive이고, 이 에픽의 Drive 대상은 기록의 복제 사본이다.

## References

- parent — _bmad-output/personal-brain/initiative-personal-brain.md
- spec — _bmad-output/personal-brain/spec-brain-v1-slice-1/spec-brain-v1-slice-1.md, Capabilities CAP-11, CAP-12
- architecture — _bmad-output/personal-brain/architecture-brain-v1-slice-1/architecture-brain-v1-slice-1.md, AD-10, AD-22, Deferred
- change — _bmad-output/personal-brain/change-local-sqlite-primary/change-local-sqlite-primary.md, §4, §7

## Notes

- Decision(2026-10-14): V1(epic 1~5) 다음에 한다. 원본 이전은 CLI가 하고 스킬은 그 위에 얹는다(사용자).
- Waits on epic-operations because: 내보내기 형식과 운영 명령이 복제·이전의 검증 기준이다.
