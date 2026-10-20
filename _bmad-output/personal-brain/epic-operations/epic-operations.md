---
type: epic
title: "운영: 내보내기·복구, 업그레이드, 제거"
parent: personal-brain
covers: [CAP-12, CAP-11]
after: ["epic-recall-and-mirror", "epic-attachments"]
assignee: ""
risk: medium
---

# 운영: 내보내기·복구, 업그레이드, 제거

## Description

`backup export/import`(스냅샷, manifest), 백업 경고, `setup upgrade`(코드 갱신·마이그레이션·hook 재등록), `setup uninstall`을 만든다. 내보내기·복구가 먼저다.

2026-10-14 변경으로 더한 것: `setup run` 흐름에 LaunchAgent 등록 단계 추가(고정 Label, 5분 간격 `brain queue drain`, 60초 예산, doctor의 마지막 주기 실행 경고, AD-25). 내보내기는 문서 추출 세대·조각과 파일 메타데이터를 포함하고 `manifest.json`에 파일 본체 범위를 적는다.

2026-10-15 변경(추가안 B, `../change-surface-plugin-daemon/`)으로 더한 것: manifest에 테이블별 sha256, 내보내기 파일은 임시 파일→rename, 직전 버전 DB 업그레이드 테스트(확인용 행 + 불변 trigger 생존), launchd 실행 겹침 잠금과 일감 청구 만료 회수, drain 시작 시 남은 `running` 정리. 주기 실행의 주인은 설정 `[daemon] enabled`이고 `setup run`·`setup upgrade`는 두 LaunchAgent Label(주기·데몬)의 적재 상태를 설정과 일치시킨다(이 에픽이 설정 키 `[daemon] enabled`와 `enabled=false`의 주기 Label, 그 일치 함수를 만들고, 데몬 Label은 epic-daemon이 더한다). `setup upgrade` 순서는 코드 갱신 → 빌드 → 마이그레이션 → shim 재작성 → LaunchAgent 일치 → (데몬 재시작) → doctor → 완료 기록(`installed.json`)이고, 플러그인 hook이 시작하는 ff+build와 같은 함수다. `setup uninstall`은 표식 hook·shim·두 Label·`<home>/run/`·`<home>/log/`·`installed.json`을 지우고, 플러그인은 안내만 한다. drain은 마지막 실행 시각을 `<home>/run/last-drain`(mtime)에 남긴다. 원천: `inputs/weknora-patterns.md` §1.4.

2026-10-20 변경(`../change-discipline-and-metrics/`)으로 더한 것: `brain stats show`(이름공간의 대상은 지표. doctor는 점검) — 기계가 셀 수 있는 지표만: SM-4a(전체 세션과 적격 세션(사용자 발화 ≥ 상수) 두 모집단), SM-5(doctor와 같은 함수), SM-C1(`context_injections.chars`, `kind='start'`만), SM-C3, SM-7 내부 시간(`context_injections.elapsed_ms`), PRD §8-8 대리 지표(과거형 단서가 든 사용자 발화 뒤 같은 세션의 도구 메모에 `brain recall`·`brain sessions read`가 나온 비율. 단서 목록과 판정 함수는 Core 하나, MCP 도구 이름 포함), Stop 점검 뒤 같은 세션에 로그가 생긴 비율(분모는 `context_injections(kind='stop', ok=1)`). `--from`·`--to`는 AD-13의 구간 함수(날짜 + 설정 시간대 → 반열린 UTC, `meta`에 되울림), 기본은 기간만 거르고 `import` 세션 제외는 옵션 `--exclude-import`, 잴 수 없는 지표는 0이 아니라 null + 경고, `--json`과 텍스트. 사람이 채점하는 SM-1·2·3·4b·6은 넣지 않는다(spine AD-5·AD-17).

## Outcome

기억을 잃지 않고 Brain을 올리고 내릴 수 있다(NFR-9).

## Requirements

인셉션 때 채운다. spec의 CAP-12, CAP-11와 그것이 인용하는 PRD FR·spine AD가 원천이다.

## Done when

1. 내보낸 뒤 새 DB 파일에 복구하면 메시지·작업 로그·파일·문서 추출 세대 수가 같고 Brain이 보관한 원본 파일을 다시 열 수 있으며(2026-10-16), 같은 DB 안에 원본이 있는 파생 테이블은 다시 만들어지며, 원본 파일이 없는 문서는 `source_unreachable`로 계속 검색된다(`FILE_SOURCE_UNREACHABLE`).
2. 마지막 내보내기가 설정한 기간보다 오래되면 doctor가 경고한다.
3. 스키마가 다른 코드로 런타임 명령을 실행하면 DB에 쓰지 않고 `SCHEMA_MISMATCH`와 spool로 간다. `setup upgrade` 후 정상이 된다.
4. `setup uninstall` 후 Brain 표식이 붙은 hook, shim, LaunchAgent(두 Label), `<home>/run/`, `<home>/log/`, `installed.json`이 없고, 데이터는 별도 확인 없이는 남는다. 데이터 삭제 확인 대상은 `brain.db`(`-wal`·`-shm` 포함), `files/`, spool, 미러다.
5. 설치 뒤 `[daemon] enabled=false`면 주기 LaunchAgent 하나만 등록되어 drain을 돌리고, `setup run`을 반복해도 하나이며, `<home>/run/last-drain`이 간격의 3배보다 오래되면 doctor가 경고한다. 겹친 주기 실행 두 개가 같은 일감을 두 번 처리하지 않는다.
6. `stats show --from <날짜> --to <날짜>`가 그 기간의 SM-4a(전체·적격)·SM-5·SM-C1·SM-C3·§8-8 대리 지표를 `--json`과 텍스트로 내고, 로그가 하나도 없는 기간은 0이며, 잴 수 없는 지표는 null과 경고이고, `import` 세션은 기본에 들어오고 `--exclude-import`로 빠지며, 같은 수를 SQL로 직접 세면 같다(2026-10-20).

## Boundaries

AD-8·12·18·19·20·24·25, Conventions(내보내기, 설치·런타임 기록). 설치·재설정의 기본은 epic-foundation-and-install. 데몬 Label·재시작은 epic-daemon.

## References

- parent — _bmad-output/personal-brain/initiative-personal-brain.md
- spec — _bmad-output/personal-brain/spec-brain-v1-slice-1/spec-brain-v1-slice-1.md, Capabilities CAP-12, CAP-11
- architecture — _bmad-output/personal-brain/architecture-brain-v1-slice-1/architecture-brain-v1-slice-1.md
- prd — _bmad-output/personal-brain/prd-brain-v1-slice-1/prd-brain-v1-slice-1.md
- inputs — _bmad-output/personal-brain/inputs/weknora-patterns.md, §1.4 (D1~D4)
- change — _bmad-output/personal-brain/change-surface-plugin-daemon/change-surface-plugin-daemon.md, §4.1, §4.2(AD-20·AD-25)

## Notes

- Decision(2026-10-14): launchd 주기 실행은 epic 5에서 붙인다. 그 전에는 hook과 명령마다의 기회적 drain으로 충분하다(사용자).
- Note(2026-10-16, `../change-users-and-review-gaps/`, 인셉션 입력, 원문은 `../inputs/external-review-2026-10-16.md`):
  - S5: 복구 순서. `files`를 포인터 없이 넣고, 위치를 넣은 뒤, 포인터를 채운다(BEFORE INSERT trigger 때문에 `defer_foreign_keys`만으로는 안 된다. spine Conventions 내보내기).
  - T10: 복구 확인에 파일·위치·메타데이터 건수와 Brain 원본 파일 열기를 넣는다(PRD NFR-9, spec CAP-12, initiative Done when 4).
  - D0: 내보내기에 `users`를 넣는다(spine AD-12, Table Contract, Conventions 내보내기, Deferred '기계 교체·원본 이전'). 가져오기가 기존 DB에 합치기도 지원하면 들어오는 "나" id를 받는 쪽 "나"로 바꾸고, 파생물을 다시 만들고, 먼저 스키마 버전을 맞추고, `users.name`을 갱신할지 정한다.
- Note(2026-10-16): `setup upgrade`는 `[update] auto = false`일 때의 직접 갱신 경로이고, `UPDATE_AVAILABLE`의 hint가 이 명령을 가리킨다(spine AD-19).
- Note(2026-10-19, `../change-masking-b-and-review-fixes/`, 인셉션 입력): 마스킹 B. 내보내기 writer는 출력 코덱으로 등록하고 manifest에 비밀 패턴 버전을 적는다. 내보내기에서 되살린 Brain의 비밀은 가린 채 돌아오고, 복구 확인의 건수 비교는 그대로 맞는다(D6).
- Note(2026-10-20, `../change-discipline-and-metrics/`, 인셉션 입력): D4. 이니셔티브 Done when 2의 2주 실측이 이 명령으로 주 단위 비교가 된다(첫 주 `stop_remind` 꺼짐, 둘째 주 켜짐).
- Note(2026-10-20, spine 리뷰): `stats show`의 SM-4a는 전체 세션과 적격 세션(발화 ≥ 상수) 두 모집단으로 낸다. `import` 세션 제외는 기본이 아니라 옵션(`--exclude-import`) — 폴더 스캔이 처음 만든 세션도 `import`라 기본 제외하면 hook을 놓친 실사용 세션이 빠진다. 잴 수 없는 지표는 0이 아니라 null + 경고(예: transcript 폴더 없음 → SM-5). 'Stop 점검 뒤 로그가 생긴 비율'의 분모는 `context_injections(kind='stop', ok=1)`이고 API 오류로 끝난 턴(`StopFailure`, 점검 없음)은 들어오지 않는다. `brain recall`이 불렸다는 판정은 Core 함수 하나(도구 메모 대상 앞머리, MCP 이름 포함). `context_injections.elapsed_ms`는 Brain 내부 처리 시간이다(SM-7 내부값).
