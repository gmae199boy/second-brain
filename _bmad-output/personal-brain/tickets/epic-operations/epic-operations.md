---
type: epic
title: "운영: 내보내기·복구, 업그레이드, 제거"
parent: personal-brain
covers: [CAP-12, CAP-11]
sources: [_bmad-output/personal-brain/initiative-personal-brain.md, _bmad-output/personal-brain/spec-brain-v1-slice-1/spec-brain-v1-slice-1.md, _bmad-output/personal-brain/architecture-brain-v1-slice-1/architecture-brain-v1-slice-1.md]
companions: [_bmad-output/personal-brain/architecture-brain-v1-slice-1/architecture-brain-v1-slice-1.md, _bmad-output/personal-brain/tickets/epic-operations/epic-operations-research-code.md]
after: ["epic-attachments", "epic-drive", "epic-postgres-primary"]
assignee: ""
refined: true
risk: medium
---

# 운영: 내보내기·복구, 업그레이드, 제거

## Description

`backup export/import`(스냅샷, manifest), 백업 경고, `setup upgrade`(코드 갱신·마이그레이션·hook 재등록), `setup uninstall`을 만든다. 내보내기·복구가 먼저다.

**V1 범위(2026-10-26, `../../change-v1-capture-and-drive/`):** 로컬 백업(DB와 Brain 소유 파일)과 새 DB 파일로의 복구 확인, 스키마 가드·`setup upgrade`만 한다. 전체 내보내기 형식·`import`, 내보내기 경과 경고, `stats show`, 완전 제거는 V1 뒤다. 아래 2026-10-14·10-15의 LaunchAgent 주기 실행·`[daemon] enabled`는 없앴다(launchd는 데몬을 띄우는 데만 쓰고 epic 9가 맡는다).

2026-10-14 변경으로 더한 것: `setup run` 흐름에 LaunchAgent 등록 단계 추가(고정 Label, 5분 간격 `brain queue drain`, 60초 예산, doctor의 마지막 주기 실행 경고, AD-25). 내보내기는 문서 추출 세대·조각과 파일 메타데이터를 포함하고 `manifest.json`에 파일 본체 범위를 적는다.

2026-10-15 변경(추가안 B, `../../change-surface-plugin-daemon/`)으로 더한 것: manifest에 테이블별 sha256, 내보내기 파일은 임시 파일→rename, 직전 버전 DB 업그레이드 테스트(확인용 행 + 불변 trigger 생존), launchd 실행 겹침 잠금과 일감 청구 만료 회수, drain 시작 시 남은 `running` 정리. 주기 실행의 주인은 설정 `[daemon] enabled`이고 `setup run`·`setup upgrade`는 두 LaunchAgent Label(주기·데몬)의 적재 상태를 설정과 일치시킨다(이 에픽이 설정 키 `[daemon] enabled`와 `enabled=false`의 주기 Label, 그 일치 함수를 만들고, 데몬 Label은 epic-daemon이 더한다). `setup upgrade` 순서는 코드 갱신 → 빌드 → 마이그레이션 → shim 재작성 → LaunchAgent 일치 → (데몬 재시작) → doctor → 완료 기록(`installed.json`)이고, 플러그인 hook이 시작하는 ff+build와 같은 함수다. `setup uninstall`은 표식 hook·shim·두 Label·`<home>/run/`·`<home>/log/`·`installed.json`을 지우고, 플러그인은 안내만 한다. drain은 마지막 실행 시각을 `<home>/run/last-drain`(mtime)에 남긴다. 원천: `inputs/weknora-patterns.md` §1.4.

2026-10-20 변경(`../../change-discipline-and-metrics/`)으로 더한 것: `brain stats show`(이름공간의 대상은 지표. doctor는 점검) — 기계가 셀 수 있는 지표만: SM-4a(전체 세션과 적격 세션(사용자 발화 ≥ 상수) 두 모집단), SM-5(doctor와 같은 함수), SM-C1(`context_injections.chars`, `kind='start'`만), SM-C3, SM-7 내부 시간(`context_injections.elapsed_ms`), PRD §8-8 대리 지표(과거형 단서가 든 사용자 발화 뒤 같은 세션의 도구 메모에 `brain recall`·`brain sessions read`가 나온 비율. 단서 목록과 판정 함수는 Core 하나, MCP 도구 이름 포함), Stop 점검 뒤 같은 세션에 로그가 생긴 비율(분모는 `context_injections(kind='stop', ok=1)`). `--from`·`--to`는 AD-13의 구간 함수(날짜 + 설정 시간대 → 반열린 UTC, `meta`에 되울림), 기본은 기간만 거르고 `import` 세션 제외는 옵션 `--exclude-import`, 잴 수 없는 지표는 0이 아니라 null + 경고, `--json`과 텍스트. 사람이 채점하는 SM-1·2·3·4b·6은 넣지 않는다(spine AD-5·AD-17).

## Outcome

기억을 잃지 않고 Brain을 올리고 내릴 수 있다(NFR-9).

## Requirements

- E5-1 (CAP-12): 원문 백업 — `brain backup create`가 Brain DB 전체의 `pg_dump` custom archive(설치된 확장 schema 포함), `pg_dumpall --globals-only --no-role-passwords`(role·멤버십), Brain 소유 로컬 블롭(`[files] path`의 정규 locator), `.env`·`config.toml`, manifest를 한 묶음으로 만든다. 묶음은 `<home>/backups/<backup-id>/`(0700, 파일 0600)에 임시 이름으로 쓰고 검증 뒤 rename으로 발행한다. manifest는 형식 버전, backup id, snapshot 기준, 앱 commit, PG 서버·client 버전, owner별 schema 버전·체크섬, schema·role·확장 목록, 테이블별 건수와 정규형 sha256, 구성 파일별 sha256·크기, 파일 범위와 누락 이유(`remote_only`·`external`), 비밀 포함 여부, `SECRET_PATTERN_VERSION`, 마지막 redaction 기준점을 담는다. `pg_dump`는 compose 서비스 안에서 돌린다(서버와 같은 버전). (AD-11·20·23·34)
- E5-2 (CAP-12): 일관성과 비차단 — DB archive와 건수·해시 reader는 같은 export snapshot을 쓰고, 블롭 목록은 그 snapshot에서 정한다. 백업 동안 블롭 삭제(가리기·Drive 이전 뒤 로컬 삭제·blob_delete)는 백업 pin으로 보류되고 백업이 끝나면 풀린다. 블롭이 없거나 해시가 다르면 그 백업은 완료가 아니다. 백업은 사용자 쓰기 트랜잭션이나 설치 잠금을 잡지 않고, hook 수집은 계속되며 DB 장애 때는 기존 spool을 쓴다. 중간에 죽으면 임시 묶음이 남지 않거나 다음 실행이 정리한다. (AD-7·9·20)
- E5-3 (CAP-12): 새 DB로 복구 — `brain backup restore <backup-id> --target <새 Brain 홈>`은 운영 DB를 덮지 않고, 새 Brain 홈·compose project·volume·port에 globals(role) → `.env`의 비밀번호로 role 설정 → archive의 pre-data → data → post-data 순으로 복원한다(실패하면 즉시 멈추고 완료 표식 없음). 블롭을 새 `[files] path`에 놓고 해시를 검증한다. owner별 버전 표를 코드와 대조하고 덮어쓰지 않으며, 필요할 때만 공통 실행기로 core → 확장 마이그레이션을 적용한다. 확장은 manifest의 패키지·잠금 식별자로 다시 설치한다. 복구 확인은 메시지·작업 로그·`files`·`file_locations`·`file_metadata`·추출 세대·조각의 건수와 해시, 세대 포인터, Brain 소유 원본 열기, `brain_app` 접속, 확장 role의 RLS·owner 분리, 불변 trigger를 본다. 원본이 없는 외부·Drive 전용 문서는 `source_unreachable`로 보이며 기존 조각이 검색된다. Garmin tokenstore는 백업하지 않으므로 새 기계에서는 다시 로그인한다. 복원한 `.env`·`config.toml`의 접속 URL·compose 자원·로컬 소유 경로(`[files] path`·미러 등)는 대상 홈 값으로 다시 바인딩하고(원문 사본은 묶음에 그대로 둠), 운영 홈과 같은 실경로·자원을 가리키면 쓰기 전에 거절한다. 복구 검증 동안 hook·데몬 Label 등록, 예약 발화·일감 drain·외부 변경과 발신(Drive·Telegram 등)을 자동으로 재개하지 않는다(대기 행은 지우지 않고 보존). (AD-12·20·23·24·30·31)
- E5-4 (CAP-11): 갱신과 스키마 가드 — `setup upgrade`와 플러그인 bootstrap 갱신이 같은 갱신 함수를 쓴다: 코드 갱신 → build → core·설치 확장 마이그레이션 → shim 재작성·표식 hook 재등록 → 데몬 Label 일치·재시작 → doctor → `installed.json` 완료 기록(마지막). 어느 단계가 실패하면 완료 기록이 전진하지 않는다. 데몬이 없는 환경에서도 끝난다. 런타임 명령의 스키마 가드는 core와 설치된 확장의 owner별 기대 버전을 비교하고, 다르면 DB에 쓰지 않고 `SCHEMA_MISMATCH`로(수집은 spool로) 간다. 직전 앱 버전의 DB를 올려도 원문·건수·키가 같고 불변 trigger가 산다. PG major 변경(18 → 19)은 하지 않는다. (AD-19·20·31)
- E5-5 (CAP-12): 백업 경고 — doctor가 마지막 성공 백업이 `backup.warn_days`(DB 사용자 설정, 기본 7)보다 오래면 경고한다. 그 백업의 redaction 기준점 뒤에 가리기가 있으면, 가리기 전에 뜬 백업들을 이름으로 알리고 지우거나 새로 뜨라고 안내한다. 그 백업 파일이 지워지면 경고가 풀린다(catalog가 파일 존재를 확인). 실패하거나 임시인 묶음은 경과 계산에 쓰지 않는다. 비밀 값은 출력하지 않는다. (AD-11·20)
- E5-6 (CAP-12): 가린 논리 내보내기 — `brain export`가 한 읽기 snapshot에서 모든 표를 읽어 테이블별 JSONL과 manifest(schema 버전, 내보내기 시각, 테이블별 건수, 패턴 버전, 블롭 범위 `none | brain_owned`)를 쓰고, 텍스트는 출력 코덱으로 가린다(내보내기 writer를 코덱 등록부에 넣는다). U+0000 짝 칸이 있는 칸은 논리 원문으로 복원한 뒤 가려서 내보내고, 저장 표현의 `bytea` 원문 짝 칸은 JSONL에 직렬화하지 않는다(인코딩한 사본으로 비밀이 새지 않게). 원문 백업과 다른 산출물이며 원문 백업 바이트를 코덱으로 바꾸지 않는다. (AD-11·20, Conventions 내보내기)
- E5-7 (CAP-11): 완전 제거 — `setup uninstall --all`이 Brain 표식이 붙은 hook(사용자 hook은 건드리지 않음), shim, `<home>/run/`, `<home>/log/`, `installed.json`, 데몬 Label(9.10 재사용)을 지우고 컨테이너를 멈춘다(11.8). PG volume·`files/`·spool·미러·확장 설치·백업 묶음은 지울 대상을 실제 경로와 크기로 보이고 명시적 확인(`--delete-data`와 대화형 확인, 비대화형에서 확인이 없으면 exit 3) 뒤에만 지운다. 외부 원본·Drive 파일·Garmin tokenstore·`.env`는 지우지 않는다(안내만). 플러그인 제거는 안내한다. (AD-19·20·34)

## Done when

1. (2026-10-28 PostgreSQL 기준으로 고침) 원문 백업을 새 Brain 홈의 새 PG DB로 복구하면 메시지·작업 로그·파일·위치·메타데이터·문서 추출 세대·조각의 건수와 해시가 같고, Brain이 보관한 원본 파일을 다시 열 수 있으며, 백업 중에도 hook 수집은 막히지 않고, 원본이 없는 외부·Drive 전용 문서는 `source_unreachable`로 계속 검색된다(`FILE_SOURCE_UNREACHABLE`). 파생 표는 dump에서 그대로 보존되고, 미러·색인 재생성은 epic 4다. (옛 문장:) 내보낸 뒤 새 DB 파일에 복구하면 메시지·작업 로그·파일·문서 추출 세대 수가 같고 Brain이 보관한 원본 파일을 다시 열 수 있으며(2026-10-16), 같은 DB 안에 원본이 있는 파생 테이블은 다시 만들어지며, 원본 파일이 없는 문서는 `source_unreachable`로 계속 검색된다(`FILE_SOURCE_UNREACHABLE`).
2. 마지막 성공한 원문 백업이 설정한 기간(`backup.warn_days`)보다 오래되면 doctor가 경고하고, 가리기 전에 뜬 백업이 남아 있으면 알린다(2026-10-28 고침).
3. 스키마가 다른 코드로 런타임 명령을 실행하면 DB에 쓰지 않고 `SCHEMA_MISMATCH`와 spool로 간다. `setup upgrade` 후 정상이 된다.
4. (2026-10-28 PostgreSQL 기준으로 고침) `setup uninstall --all` 후 Brain 표식이 붙은 hook, shim, 데몬 LaunchAgent, `<home>/run/`, `<home>/log/`, `installed.json`이 없고 컨테이너가 멈춰 있으며, 데이터는 `--delete-data`와 확인 없이는 남는다. 데이터 삭제 확인 대상은 PG volume, `files/`, spool, 미러, `extensions/`, `backups/`이고, `.env`·외부 원본·Drive 파일·Garmin tokenstore와 옛 `brain.db`는 지우지 않는다.
5. (삭제, 2026-10-26: 주기 LaunchAgent는 두지 않는다. 데몬과 기회적 drain이 겹쳐도 같은 일감을 두 번 처리하지 않는 것은 AD-7·21의 청구 규칙과 epic 9가 지킨다.)
6. → 2026-10-28 epic 3으로 옮겼다(입력인 `context_injections.kind`·`elapsed_ms`를 epic 3이 만든다). (V1 뒤) `stats show --from <날짜> --to <날짜>`가 그 기간의 SM-4a(전체·적격)·SM-5·SM-C1·SM-C3·§8-8 대리 지표를 `--json`과 텍스트로 내고, 로그가 하나도 없는 기간은 0이며, 잴 수 없는 지표는 null과 경고이고, `import` 세션은 기본에 들어오고 `--exclude-import`로 빠지며, 같은 수를 SQL로 직접 세면 같다(2026-10-20).

7. 기능 묶음이 플러그인 배포로 이 Mac의 설치본에 들어가 동작한다. 운영 설치본에서 백업 한 번을 뜨고 그 묶음을 격리된 새 홈에 복구해 확인한다(운영 DB를 덮거나 volume을 지우지 않는다).

## Constraints

- 복구는 새 DB·새 홈으로만 한다. 운영 DB 덮어쓰기와 볼륨 삭제를 시험이나 확인에 쓰지 않는다.
- 원문 백업에는 비밀이 원문으로 있다(U2). 묶음은 0700/0600이고 Brain 밖으로 보내지 않는다. 가린 산출물은 `brain export`뿐이다.
- 백업은 쓰기 트랜잭션이나 설치 잠금을 오래 잡지 않는다. hook은 막히지 않는다(AD-6·7).
- 기존 DB에 합치는 가져오기(D0)는 이 에픽 밖이다(backlog).

## Boundaries

AD-8·12·18·19·20·24·25, Conventions(내보내기, 설치·런타임 기록). 설치·재설정의 기본은 epic-foundation-and-install. 데몬 Label·재시작은 epic-daemon.

## References

- parent — _bmad-output/personal-brain/initiative-personal-brain.md
- spec — _bmad-output/personal-brain/spec-brain-v1-slice-1/spec-brain-v1-slice-1.md, Capabilities CAP-12, CAP-11
- architecture — _bmad-output/personal-brain/architecture-brain-v1-slice-1/architecture-brain-v1-slice-1.md
- prd — _bmad-output/personal-brain/prd-brain-v1-slice-1/prd-brain-v1-slice-1.md
- inputs — _bmad-output/personal-brain/inputs/weknora-patterns.md, §1.4 (D1~D4)
- change — _bmad-output/personal-brain/change-surface-plugin-daemon/change-surface-plugin-daemon.md, §4.1, §4.2(AD-20·AD-25)
- research — _bmad-output/personal-brain/tickets/epic-operations/epic-operations-research-code.md (2026-10-28 정적 코드 조사와 PostgreSQL 공식 문서 확인)

## Notes

- Decision(2026-10-14): launchd 주기 실행은 epic 5에서 붙인다. 그 전에는 hook과 명령마다의 기회적 drain으로 충분하다(사용자).
- Note(2026-10-16, `../../change-users-and-review-gaps/`, 인셉션 입력, 원문은 `../../inputs/external-review-2026-10-16.md`):
  - S5: 복구 순서. `files`를 포인터 없이 넣고, 위치를 넣은 뒤, 포인터를 채운다(BEFORE INSERT trigger 때문에 `defer_foreign_keys`만으로는 안 된다. spine Conventions 내보내기).
  - T10: 복구 확인에 파일·위치·메타데이터 건수와 Brain 원본 파일 열기를 넣는다(PRD NFR-9, spec CAP-12, initiative Done when 4).
  - D0: 내보내기에 `users`를 넣는다(spine AD-12, Table Contract, Conventions 내보내기, Deferred '기계 교체·원본 이전'). 가져오기가 기존 DB에 합치기도 지원하면 들어오는 "나" id를 받는 쪽 "나"로 바꾸고, 파생물을 다시 만들고, 먼저 스키마 버전을 맞추고, `users.name`을 갱신할지 정한다.
- Note(2026-10-16): `setup upgrade`는 `[update] auto = false`일 때의 직접 갱신 경로이고, `UPDATE_AVAILABLE`의 hint가 이 명령을 가리킨다(spine AD-19).
- Note(2026-10-19, `../../change-masking-b-and-review-fixes/`, 인셉션 입력): 마스킹 B. 내보내기 writer는 출력 코덱으로 등록하고 manifest에 비밀 패턴 버전을 적는다. 내보내기에서 되살린 Brain의 비밀은 가린 채 돌아오고, 복구 확인의 건수 비교는 그대로 맞는다(D6).
- Note(2026-10-20, `../../change-discipline-and-metrics/`, 인셉션 입력): D4. 이니셔티브 Done when 2의 2주 실측이 이 명령으로 주 단위 비교가 된다(첫 주 `stop_remind` 꺼짐, 둘째 주 켜짐).
- Note(2026-10-20, spine 리뷰): `stats show`의 SM-4a는 전체 세션과 적격 세션(발화 ≥ 상수) 두 모집단으로 낸다. `import` 세션 제외는 기본이 아니라 옵션(`--exclude-import`) — 폴더 스캔이 처음 만든 세션도 `import`라 기본 제외하면 hook을 놓친 실사용 세션이 빠진다. 잴 수 없는 지표는 0이 아니라 null + 경고(예: transcript 폴더 없음 → SM-5). 'Stop 점검 뒤 로그가 생긴 비율'의 분모는 `context_injections(kind='stop', ok=1)`이고 API 오류로 끝난 턴(`StopFailure`, 점검 없음)은 들어오지 않는다. `brain recall`이 불렸다는 판정은 Core 함수 하나(도구 메모 대상 앞머리, MCP 이름 포함). `context_injections.elapsed_ms`는 Brain 내부 처리 시간이다(SM-7 내부값).
- Carry(2026-10-22, epic 2 회고): `messages redact`는 외부 WAL 읽기가 열려 있으면 checkpoint 실패를 삼키고 성공을 돌려줘 WAL에 옛 바이트가 남는다(`packages/sqlite/src/sessions.ts:170-175`, `deferred-work.md` I91). 읽기가 끝난 뒤 다시 정리하고 doctor가 보이는 경로를 둔다.
- Decision(2026-10-26, `../../change-v1-capture-and-drive/`, 사용자): V1은 로컬 백업·복구 확인과 스키마 가드·`setup upgrade`만(Done when 1의 V1 문장, 3). epic 8이 첨부 원본을 Drive로 옮기기 전에 이 백업이 있어야 하므로 epic 8 앞이다. epic 4를 기다리지 않는다. Done when 2·4·6과 전체 내보내기는 V1 뒤, 5는 삭제. launchd 주기 실행(2026-10-14 Decision)은 없앴다.
- Note(2026-10-27, epic-daemon 쪼개기): V1 `setup upgrade` 명령은 이 에픽이 만들고, epic-daemon 9.6이 플러그인 bootstrap 갱신에 붙인 데몬 재시작 단계를 같은 방식으로 부른다. 인셉션 때 Done when에 "데몬 없이도 이 에픽의 테스트가 통과한다"를 이어받는다(epic-daemon Done when 1).
- Decision(2026-10-27, 사용자): V1 뒤(backlog, 삭제 아님). 로컬 백업·복구 확인, 스키마 가드, `setup upgrade`는 쓰면서 확인하고 버그로 고친다. 자동 업데이트(SessionStart bootstrap)가 `setup upgrade`를 대신하고 스키마 불일치 거부는 epic 1·2가 했다. epic-drive가 이 에픽을 기다리지 않게 하고, 백업이 맡던 안전장치는 epic-drive의 원본 보관 기간이 대신한다. 순서는 epic-drive 뒤, 에픽 전체 대기.
- Waits on epic-drive because: V1 완료 뒤 착수(2026-10-27). epic-daemon이 넘긴 `setup upgrade` 명령·"데몬 없이 테스트 통과" 이어받기(2026-10-27 Note)는 착수 때 그대로 유효하다.
- Note(2026-10-28, `../../prep-garmin-absorption/`, 인셉션 입력): 저장소가 PostgreSQL 하나(OrbStack Docker, 영속 볼륨)로 바뀌었다. 로컬 백업·복구·스키마 가드·`setup upgrade`의 "DB 파일·`-wal`·`-shm`" 전제는 PostgreSQL 백업(덤프 또는 볼륨) 기준으로 다시 정한다. drop된 epic 7의 "Drive에 기록 사본" 아이디어를 백업 대상 후보로 본다. 위 Carry I91(WAL checkpoint)은 SQLite를 지우면 대상이 없어진다.
- Waits on epic-postgres-primary because: 백업·복구 대상이 PostgreSQL 컨테이너·볼륨과 그 스키마다(2026-10-28).
- Note(2026-10-28, 트리 검증, 인셉션 입력): `stats show`(Done when 6)는 epic 3의 `context_injections.kind`·`elapsed_ms`를 읽는데, 이 에픽이 epic 3보다 앞이다. 인셉션 때 그 스토리를 epic 3 뒤로 보내거나 두 에픽의 순서를 바꾼다.
- Decision(2026-10-28, 정제, 추천으로 정함): `stats show`(Done when 6)를 epic 3의 마지막 기능 스토리로 옮긴다(코드 조사 7절 선택지 A). 입력인 `context_injections.kind`·`elapsed_ms`를 epic 3이 만들고, 이 에픽은 그보다 앞이라 순서를 바꾸면 백업·갱신이 기다리게 된다. 계산을 이 에픽에서 복제하지 않는다.
- Decision(2026-10-28, 정제, 추천으로 정함): 백업은 compose 서비스 안의 `pg_dump -Fc`(서버와 같은 PG18 client)와 `pg_dumpall --globals-only --no-role-passwords`다. role 비밀번호는 묶음에 든 `.env`에서 복구 때 다시 설정한다. 원문 백업이라 `.env`를 포함하고(묶음은 0700/0600, 비밀 포함 여부를 manifest에 적음), Garmin tokenstore는 넣지 않는다(새 기계에서 다시 로그인, 라이브러리 세션 파일).
- Decision(2026-10-28, 정제, 추천으로 정함): 블롭 범위는 Brain 소유 로컬 블롭이다. Drive로 옮긴 원본은 내려받지 않고 manifest에 `remote_only`로, external 원본은 `external`로 적는다. 블롭 목록은 DB snapshot에서 정하고, 백업 동안 블롭 삭제는 백업 pin으로 보류한다.
- Decision(2026-10-28, 정제, 추천으로 정함): 복구 대상은 새 Brain 홈(새 compose project·volume·port·Label)뿐이다. `restore`는 운영 홈을 거부한다. 기계를 옮길 때는 새 Mac에 설치한 뒤 그 홈으로 복구한다. 기존 DB에 합치는 가져오기(D0)와 가린 JSONL의 되살리기는 backlog로 남긴다.
- Decision(2026-10-28, 정제, 추천으로 정함): 명령은 `brain backup create|list|verify|restore`, `brain export`, `setup upgrade`, `setup uninstall --all [--delete-data]`다. 백업 위치는 `<home>/backups/`(기계 값 `[backup] dir`로 바꿀 수 있음), 경고 기간은 DB 사용자 설정 `backup.warn_days`(기본 7)다. 자동 예약과 자동 정리는 두지 않는다(원하면 공통 예약 `brain schedules add`로 백업을 걸 수 있다).
- Decision(2026-10-28, 정제, 추천으로 정함): 공통 갱신 함수의 순서는 doctor를 데몬 재시작 뒤에 둔다(지금 설치기는 그 앞에서 한다, 코드 조사 0절 어긋남). 완료 기록은 마지막이고, `installed.json.commit = ref`만 보고 재시작 실패를 넘기던 이월 DW-4·5를 회귀 시험에 넣는다.
- Decision(2026-10-28, 스토리 계획): tracer는 1이다. 합성 메시지 하나와 Brain 블롭 하나가 `brain backup create`로 묶음이 되고, `brain backup restore --target <격리 홈>`으로 새 compose project에 복원돼 건수·해시가 같고 블롭이 열린다. 다음은 가장 덜 확실한 2(snapshot 공유·블롭 pin·hook 비차단)다. 그다음 3(확장·role·설정 복구), 4(공통 갱신과 owner별 스키마 가드), 5(백업 경고), 6(가린 내보내기), 7(완전 제거), 8(Refactor sweep), 9(이 Mac 확인)다. 코드 조사의 순서안 A를 따르고 stats는 epic 3으로 옮겼다.
- Decision(2026-10-28, 스토리 계획): 1~3은 새 backup 모듈·manifest·PG 관리 port를, 4·7은 설치 flow·bootstrap·uninstall을 고치지만 명령 등록부·설정 코덱·doctor를 모두 함께 고친다(코드 조사 8절). 그래서 1~9는 한 줄이다. 1은 epic 8의 마지막 코드 스토리(8.7)를 기다린다(앞 에픽 선례). epic 9·11·13 쪽 entry에는 인계 문장을 더하지 않고 받는 쪽이 적는다(같은 명시적 예외).
- Decision(2026-10-28, 추천으로 정함): 모든 entry가 `hitl = false`다. 9의 운영 설치본 확인은 비파괴(백업 한 번, 격리 홈 복구)이고 에이전트가 한다. 데이터 삭제는 제품이 받는 확인이며 이 Mac 확인에서는 격리 홈에서만 시험한다.
- Decision(2026-10-28, 추천으로 정함): risk와 그 이유.
  - 1 high: 백업이 틀리면 복구할 때까지 모른다.
  - 2 high: snapshot·블롭 경합이 틀리면 백업이 조용히 불완전하다.
  - 3 high: role·RLS가 틀리면 복구한 DB에서 확장이 남의 행을 쓴다.
  - 4 medium: 갱신이 틀리면 설치가 중간에 멈춘다. 완료 기록이 막는다.
  - 5 low: 경고가 틀려도 데이터는 그대로다.
  - 6 medium: 가린 내보내기에 원문이 새면 비밀이 나간다.
  - 7 medium: 제거가 확인 없이 데이터를 지우면 되돌릴 수 없다.
  - 8 low: 정리다.
  - 9 medium: 운영 설치본에서만 드러나는 권한·경로 문제를 놓친다.
- Waits on epic-extensions because: 확장 registry·설치 경로·확장 role이 백업 범위이고 복구 때 확장을 다시 설치한다(2026-10-28 정제).
- Waits on epic-daemon because: 공통 갱신 함수가 9.6의 데몬 재시작과 bootstrap 갱신을, 완전 제거가 9.10의 최소 uninstall을 쓴다(2026-10-28 정제).
- Decision(2026-10-28, 세트 검증 F1): 확정한 운영 계약을 spine에 같은 날 반영했다(명령 표의 `backup create|list|verify|restore`와 별도 `export`, AD-20의 묶음·복구 대상·재바인딩·자동 재개 금지·마이그레이션 허용 경로에 `setup upgrade`와 `backup restore`, `uninstall --all [--delete-data]`, Conventions의 JSONL 되살리기는 backlog, Deferred 해소).
- Decision(2026-10-28, 세트 검증 F2): 복구한 홈은 운영과 분리한다. 복원한 설정의 접속 URL·compose 자원·로컬 경로를 대상 값으로 다시 바인딩하고, 운영 홈과 같은 실경로·자원이면 쓰기 전에 거절한다. 복구 검증 동안 hook·Label 등록, 예약·drain·외부 변경과 발신을 자동으로 재개하지 않는다(대기 행은 보존). 1·3·9의 시험은 운영 URL·절대 경로·발신 대기 행이 든 합성 fixture로 대상만 쓰이고 외부 호출이 0인지 본다.
- Decision(2026-10-28, 세트 검증 F3): E5-3의 분담. 1은 최소 왕복, 3은 나머지 전체 복구 확인(작업 로그·`file_metadata`·서로 다른 추출 attempt와 현재 포인터·위치 포인터·`brain_app` 접속·실제 원본 열기·external과 `remote_only`의 검색 경고)을 공통 확인기로 만들고, 9는 그 확인기를 설치본에서 다시 돌린다.
- Decision(2026-10-28, 세트 검증 F4): `brain export`는 한 읽기 snapshot에서 모든 표와 manifest 건수를 얻는다(schema 버전·내보내기 시각 포함). 6은 동시 쓰기 fixture로 snapshot 기준 건수와 관계를 본다.
- Decision(2026-10-28, 세트 검증 F5): Done when 1·2·4를 PostgreSQL 기준 결과로 고쳤다. 삭제된 5와 epic 3으로 옮긴 6의 이력은 남긴다.
- Decision(2026-10-28, 세트 검증 F6): 8(Refactor sweep)은 코드 스토리 1~7의 정리를 닫는다. 9의 배포·비파괴 확인은 그 뒤 따로 둔다(앞 에픽들과 같은 예외). 9에서 찾은 기능 문제는 버그 스토리로 고치고 8로 밀어 넣지 않는다. 9가 성공하기 전에는 Done when 7을 충족한 것으로 세지 않는다.
- Decision(2026-10-28, 세트 검증 S1·S2 채택): 1은 단일 합성 core 왕복과 최소 list·verify만 만들고, 경합은 2, 전체 복구 행렬은 3, 출력 다듬기와 비필수 옵션은 뒤로 둔다(이미 설치된 OrbStack·PG를 쓰고 새 수동 설치 단계는 없음). 각 plan은 두 PG project·volume·port, 합성 fixture, fake launchctl·clock, 실행·정리 명령과 예상값을 적는다. 2는 pin 등록과 snapshot 고정 사이·삭제 직전·복사 중 kill을 동기화하고 살아 있는 다른 백업의 pin을 지우지 않는지도 본다. 수집 지연 한도는 AD-6·7과 연결한 수치로 정한다. 1·3은 PK 정렬·NULL·bytea·시각의 해시 정규형을 고정한다. 비밀은 합성 fixture만 쓰고 stdout·stderr·doctor·dump 로그와 묶음 권한을 검사한다. high entry의 추가 확인: 1은 묶음만 받은 별도 실행자가 복구를 재현, 2는 살아 있는 다른 백업의 pin 보존, 3은 복구 뒤 RLS·권한 판정을 실제 `brain_app`과 non-superuser·NOBYPASSRLS 확장 role 자격으로만 하고 superuser 연결의 성공으로 대신하지 않는지(globals·owner·ACL 복원 자체는 제한된 setup 관리 경로가 한다, 재검증 F8).
