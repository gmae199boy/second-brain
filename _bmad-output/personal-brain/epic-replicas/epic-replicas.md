---
type: epic
title: "복제 대상과 원본 이전"
parent: personal-brain
covers: [CAP-11, CAP-12]
after: ["epic-operations", "epic-daemon"]
assignee: ""
risk: medium
---

# 복제 대상과 원본 이전

## Description

로컬 SQLite 원본을 그대로 두고, 사용자가 고른 복제 대상(Postgres, Drive의 기계별 append-only 파일)이 원본을 따라오게 한다. 남겨 둔 `packages/postgres`와 설치기의 Docker 흐름을 다시 쓴다. 사용자가 원하면 `brain setup move-store --to postgres`로 원본을 검증된 방식으로 옮긴다. 나중에 `/brain:migration` 스킬이 이 명령을 감싼다.

2026-10-15 변경(추가안 B, `../change-surface-plugin-daemon/`)으로 더한 것: SQLite↔Postgres 스키마 동등성 테스트(한쪽이 더한 테이블·컬럼을 다른 쪽에서 `pragma_table_info`·`information_schema`로 확인), SQLite 마이그레이션 헤더의 `-- Mirrors postgres NNNN`, 번호 중복 감지 테스트. 첫 대상은 0003의 `users`·`sessions.user_id` FK와 0004의 `chunk_locator`·`pattern_version`·`attempt`·`failed_stage`·`source_unreachable_at`·`messages.git_branch`·drain 청구 인덱스와(2026-10-16 번호 변경) 기존 deferred(`index_configs` 갈라짐, `tool_notes` 가리기 trigger). 원천: `inputs/weknora-patterns.md` §1.6.

## Outcome

Postgres나 Drive를 붙여도 원본은 하나로 남고, 복제 대상이 늦어지거나 실패해도 기억을 잃지 않는다.

## Requirements

- E7-1 (CAP-11): `setup run`의 선택 단계로 복제 대상 추가. 설정은 `[[replicas]]`(Postgres URL은 환경 변수 이름). (AD-10·18·19)
- E7-2 (CAP-12): 커서로 따라잡는 복제. 원본 쓰기를 막지 않고, 복제는 값을 만들지 않는다. (AD-10·22)
- E7-3 (CAP-11): `brain setup move-store --to postgres`: 쓰기 정지 → 복사 → 건수·해시 검증 → 원본 전환 → 옛 파일은 읽기 전용 백업. (AD-10)
- E7-4 (CAP-11): doctor가 대상별 지연과 실패를 보인다.

## Done when

1. 꺼졌다 켜진 복제 대상이 빠짐없이 따라잡고, 원본과 같은 값(ID·시각)으로 되읽힌다.
2. 복제 대상의 실패가 원본 쓰기를 막지 않는다.
3. `move-store` 뒤 테이블별 건수·해시가 같고, 옛 `brain.db`는 읽기 전용으로 남는다.
4. doctor가 대상별 지연을 보인다.
5. 데몬이 켜진 상태와 꺼진 상태 둘 다에서 1~4가 통과한다(AD-27. 복제 커서 따라잡기는 drain의 일감이라 launchd든 데몬이든 같은 경로다).

## Boundaries

AD-10·11·22. 원본은 로컬 SQLite이고, 복제 대상의 읽기·검색은 하지 않는다. Drive 파일 저장소(첨부 원본)는 epic-drive이고, 이 에픽의 Drive 대상은 기록의 복제 사본이다.

## References

- parent — _bmad-output/personal-brain/initiative-personal-brain.md
- spec — _bmad-output/personal-brain/spec-brain-v1-slice-1/spec-brain-v1-slice-1.md, Capabilities CAP-11, CAP-12
- architecture — _bmad-output/personal-brain/architecture-brain-v1-slice-1/architecture-brain-v1-slice-1.md, AD-10, AD-22, Deferred
- change — _bmad-output/personal-brain/change-local-sqlite-primary/change-local-sqlite-primary.md, §4, §7
- inputs — _bmad-output/personal-brain/inputs/weknora-patterns.md, §1.6 (F1·F2)
- change — _bmad-output/personal-brain/change-surface-plugin-daemon/change-surface-plugin-daemon.md, §4.1

## Notes

- Decision(2026-10-14): V1(epic 1·2·10·3·4·5) 다음에 한다. 원본 이전은 CLI가 하고 스킬은 그 위에 얹는다(사용자).
- Waits on epic-operations because: 내보내기 형식과 운영 명령이 복제·이전의 검증 기준이다.
- Waits on epic-daemon because: Done when의 데몬 켜짐·꺼짐 두 상태 검증, `setup run`·doctor·설정 코덱의 선택 단계(2026-10-16, `../change-users-and-review-gaps/` D2).
- Note(2026-10-16, `../change-users-and-review-gaps/`, 인셉션 입력): D5 가리기는 복제 대상에도 전파한다. Postgres는 같은 가리기 함수로 하고, `tool_notes` trigger deferred 항목과 함께 정한다. Drive의 기록 복제 파일은 평소 append-only이고, 가리기 때만 그 메시지가 든 파일을 다시 쓰고 옛 파일을 지운다. 끝날 때까지 doctor `warn`(spine AD-10·11·22).
- Note(2026-10-16, 인셉션 입력): 복제 대상 오류에 분류 코드를 붙인다. Postgres 연결 실패·Drive 429·5xx는 일시 오류이고, 인증 거부·권한 없음은 영구 오류다. 복제 실패는 원본 쓰기를 막지 않는다(spine AD-10·21).
- Note(2026-10-16): 복제 일감 실패의 다시 하기는 `failures retry`에 대상 종류를 더해서 한다(2.12가 명령을 만든다, spine AD-5).
- Note(2026-10-19, `../change-masking-b-and-review-fixes/`, 인셉션 입력): 마스킹 B. 복제 payload는 출력 코덱이다. 가린 텍스트를 보내고 패턴 버전을 적으며, 버전이 오르면 D5(`../change-users-and-review-gaps/`)의 복제 가리기 일감과 같은 경로로 다시 가린다. `setup move-store`는 복제본이 아니라 원본에서 복사해 원문을 잃지 않는다. Postgres는 0005(`redactions.tool_note_id`, `failed_stage` trigger, `projects.identity_key`)만큼 더 갈라진다(deferred Triage).
