---
type: epic
title: "운영: 내보내기·복구, 업그레이드, 제거"
parent: personal-brain
covers: [CAP-12, CAP-11]
after: ["epic-recall-and-mirror"]
assignee: ""
risk: medium
---

# 운영: 내보내기·복구, 업그레이드, 제거

## Description

`admin export/import`(스냅샷, manifest), 백업 경고, `setup upgrade`(코드 갱신·마이그레이션·hook 재등록), `setup uninstall`을 만든다. 내보내기·복구가 먼저다.

2026-10-14 변경으로 더한 것: `setup run` 흐름에 LaunchAgent 등록 단계 추가(고정 Label, 5분 간격 `brain admin drain`, 60초 예산, doctor의 마지막 주기 실행 경고, AD-25). 내보내기는 문서 추출 세대·조각과 파일 메타데이터를 포함하고 `manifest.json`에 파일 본체 범위를 적는다.

2026-10-15 변경(추가안 B, `../change-surface-plugin-daemon/`)으로 더한 것: manifest에 테이블별 sha256, 내보내기 파일은 임시 파일→rename, 직전 버전 DB 업그레이드 테스트(확인용 행 + 불변 trigger 생존), launchd 실행 겹침 잠금과 일감 청구 만료 회수, drain 시작 시 남은 `running` 정리. 주기 실행의 주인은 설정 `[daemon] enabled`이고 `setup run`·`setup upgrade`는 두 LaunchAgent Label(주기·데몬)의 적재 상태를 설정과 일치시킨다(이 에픽은 `enabled=false`의 주기 Label과 그 일치 함수를 만들고, 데몬 Label은 epic-daemon이 더한다). `setup upgrade` 순서는 코드 갱신 → 빌드 → 마이그레이션 → shim 재작성 → LaunchAgent 일치 → (데몬 재시작) → doctor → 완료 기록(`installed.json`)이고, 플러그인 hook이 시작하는 ff+build와 같은 함수다. `setup uninstall`은 표식 hook·shim·두 Label·`<home>/run/`·`<home>/log/`·`installed.json`을 지우고, 플러그인은 안내만 한다. drain은 마지막 실행 시각을 `<home>/run/last-drain`(mtime)에 남긴다. 원천: `inputs/weknora-patterns.md` §1.4.

## Outcome

기억을 잃지 않고 Brain을 올리고 내릴 수 있다(NFR-9).

## Requirements

인셉션 때 채운다. spec의 CAP-12, CAP-11와 그것이 인용하는 PRD FR·spine AD가 원천이다.

## Done when

1. 내보낸 뒤 새 DB 파일에 복구하면 메시지·작업 로그·문서 추출 세대 수가 같고, 같은 DB 안에 원본이 있는 파생 테이블은 다시 만들어지며, 원본 파일이 없는 문서는 `source_unreachable`로 계속 검색된다(`FILE_SOURCE_UNREACHABLE`).
2. 마지막 내보내기가 설정한 기간보다 오래되면 doctor가 경고한다.
3. 스키마가 다른 코드로 런타임 명령을 실행하면 DB에 쓰지 않고 `SCHEMA_MISMATCH`와 spool로 간다. `setup upgrade` 후 정상이 된다.
4. `setup uninstall` 후 Brain 표식이 붙은 hook, shim, LaunchAgent(두 Label), `<home>/run/`, `<home>/log/`, `installed.json`이 없고, 데이터는 별도 확인 없이는 남는다. 데이터 삭제 확인 대상은 `brain.db`(`-wal`·`-shm` 포함), `files/`, spool, 미러다.
5. 설치 뒤 `[daemon] enabled=false`면 주기 LaunchAgent 하나만 등록되어 drain을 돌리고, `setup run`을 반복해도 하나이며, `<home>/run/last-drain`이 간격의 3배보다 오래되면 doctor가 경고한다. 겹친 주기 실행 두 개가 같은 일감을 두 번 처리하지 않는다.

## Boundaries

AD-8·18·19·20·24·25, Conventions(내보내기, 설치·런타임 기록). 설치·재설정의 기본은 epic-foundation-and-install. 데몬 Label·재시작은 epic-daemon.

## References

- parent — _bmad-output/personal-brain/initiative-personal-brain.md
- spec — _bmad-output/personal-brain/spec-brain-v1-slice-1/spec-brain-v1-slice-1.md, Capabilities CAP-12, CAP-11
- architecture — _bmad-output/personal-brain/architecture-brain-v1-slice-1/architecture-brain-v1-slice-1.md
- prd — _bmad-output/personal-brain/prd-brain-v1-slice-1/prd-brain-v1-slice-1.md
- inputs — _bmad-output/personal-brain/inputs/weknora-patterns.md, §1.4 (D1~D4)
- change — _bmad-output/personal-brain/change-surface-plugin-daemon/change-surface-plugin-daemon.md, §4.1, §4.2(AD-20·AD-25)

## Notes

- Decision(2026-10-14): launchd 주기 실행은 epic 5에서 붙인다. 그 전에는 hook과 명령마다의 기회적 drain으로 충분하다(사용자).
