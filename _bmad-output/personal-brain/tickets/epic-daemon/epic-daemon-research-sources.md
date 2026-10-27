<!-- 2026-10-27 epic-daemon 다듬기 사전 조사(문서). codex 워커가 읽기 전용으로 작성. L은 각 문서의 행 번호. -->

# epic-daemon 문서 조사

- 2026-10-26 결정 우선. 약칭은 요청된 문서 순서의 `epic`, `spine`, `change-v1`, `spec`, `change-surface`, `patterns`; L은 행 번호. OPEN은 권고다.

## 1. SETTLED — V1

- **프로세스:** `brain daemon run`, 같은 빌드·shim에서 `createBrain`, scan, drain 직접 호출; CLI 재실행 없음, Core의 프로세스 소유 금지. hook·명령은 단명·데몬 독립. `daemon run`은 stdout 엔벨로프를 내지 않는다. `daemon run|start|status|stop` 표면, SDK·명령 메타 재사용이다(spine AD-5 L107–132, AD-27 L412–419; epic L41; spec CAP-10 L49–51).
- **launchd:** 고정 `Label`은 `<reverse-dns>.second-brain.daemon`, `RunAtLoad`·`KeepAlive`, 실행은 shim 경유 `brain daemon run`. `setup run`과 bootstrap 공용 설치 함수가 하나만 등록하며 같은 Label 재등록 금지. epic 9가 등록·제거를 소유한다. `…drain`·두 Label 전환·`last-drain` 폐기(spine AD-25 L390–394; epic L17).
- **상태·종료:** `<home>/run/daemon.pid` 단일 인스턴스 잠금: 원자적 생성·pid 생존·상한 시간. 설치 잠금 선례: `<home>/install.lock/` mkdir, pid·시작시각, `kill -0` 실패/30분 초과 회수. SIGTERM 정상 종료. `<home>/log/daemon.log` 기본 1MB×5 회전; `<home>/run/heartbeat` mtime 기본 30초(spine AD-19 L319, AD-27 L413).
- **루프:** `queue.drain()` 반복, transcript 폴더·Brain 소유 파일 위치 감시, Drive `source_sync`, 시각이 된 일감을 `work_items`에 넣는 예약 틱. 테스트 일감 처리·재기동시 지난 일감 한 번 발행이 완료 조건. 사용자 스케줄러 등록·목록·삭제는 다음 조각(epic L19, L37, L41; spine AD-25 L391, AD-27 L414–415).
- **큐·DB:** 미완료 `(kind, target_kind, target_id)` 유일; 짧은 트랜잭션으로 청구 후 밖에서 처리, 멱등. `withWrite`/`BEGIN IMMEDIATE`, 쓰기 중 I/O 금지·2초 상한, drain `busy_timeout` 10초. 종류별 lease·지수 재시도 1초~1시간, 10회 후 `failures`; 영구 오류 즉시 종료·`Retry-After` 존중. DB 불가에는 횟수 증가 없이 spool(spine AD-7 L162–167, AD-21 L342–350).
- **spool:** `<home>/spool/` 프로세스별 JSON Lines, 매 줄 `schema_version`, `*.jsonl.open`→`*.jsonl`; 데몬은 기본 60초 또는 1,000줄마다 닫는다. pid 포함 `*.claiming`, pid 사망 또는 10분 경과 시 회수; 성공 삭제·부분 실패 재작성·10회 실패 `spool/failed/` 보존. ID·`occurred_at` 유지(spine AD-9 L187–194).
- **폴백:** heartbeat 기준 살아 있으면 모든 명령의 기회적 drain 생략; 죽으면 사람 명령 끝의 짧은 예산 drain과 SessionStart async drain. 동기 hook·hook 경로 명령은 기회적 drain 제외, 할 일이 있는지 읽은 뒤 쓰기 잠금. epic 2·10·5·8 테스트는 데몬 없이 통과(spine AD-7 L166–167, AD-25 L392, AD-27 L417).
- **운영:** `daemon stop`은 KeepAlive부터 내려 임시 정지, `daemon start`는 Label 재적재. `setup upgrade`: 코드→빌드→마이그레이션→shim→Label 일치→데몬 재시작→doctor→완료 기록. V1 제거 최소치는 `setup uninstall` 뒤 Label·pid·heartbeat·로그 없음. 전체 제거의 DB·데이터 삭제는 명시적 확인 계약이다(epic L35–36; spine AD-20 L331–335, AD-27 L418).
- **doctor·오류:** 생존·마지막 heartbeat, 죽음/정지 `warn`, heartbeat 간격 3배 초과(기본 90초) 경고; spool 건수·최고령·실패 보존 건수, store·스키마·shim/node·마지막 hook·plugin 점검. `ok|warn|fail|skip`, summary `passed|warned|failed|skipped`, warn exit 0. `SPOOLED`, `DB_UNAVAILABLE`, `SCHEMA_MISMATCH`, `CONFIG_MISSING`, `CONFIG_UNKNOWN_KEY`, `UPDATE_AVAILABLE` 등 기존 코드 사용; `DAEMON_UNAVAILABLE`, `SESSION_REQUIRED`, `VERSION_MISMATCH`는 소켓/MCP와 V1 뒤(spine AD-9 L189–194, AD-19 L322, AD-25 L393, Conventions L507–511; epic L41).
- **설정·경로:** `<home>` 기본 `~/.second_brain`; `config.toml`의 `schema_version`, `[store] path`(기본 `<home>/brain.db`), `[files] path`(기본 `<home>/files/`), `.env`. `[update] auto` 기본 true는 SessionStart bootstrap 갱신에 적용. 데몬 enable 키 없음. `<home>/app`, `bin/brain`, `installed.json`, `run/plugin.json`, `run/last-hook-<harness>` 재사용; 런타임 상태는 설정 코덱 밖(spine AD-10 L202–208, AD-18 L307–308, AD-19 L318–324, AD-23 L367, Conventions L512).

## 2. OPEN — 스토리 간 합의 필요

- **N초·빈도:** N은 인셉션 결정, drain·scan·tick 간격/예산 미정 → 실측 가능한 N과 상수, idle 대기·오류 후 재시도·겹침 방지 합의(epic L34; spine Deferred L605).
- **공용부 소유자:** `createBrain`, scan/drain, doctor, `setup upgrade`를 epic 10·5와 공유 → epic 9가 런타임 조립·재시작 연결을 먼저 소유하고 필요 leaf `after`; epic 5는 기존 설치 흐름에 백업·마이그레이션 보강(epic L62).
- **예약 저장·형식:** 틱과 재기동 한 번만 확정, 저장 테이블·due 표현·멱등 키 미정 → 영속 due/발행 체크포인트와 큐 삽입의 원자성, 발생 회차 키를 정한다. 미완료 큐 유일성만으로 완료 후 중복은 막지 못한다. 사용자 cron UI는 미룬다(epic L37; spine AD-21 L342, AD-27 L415).
- **alive 상세:** heartbeat 기준은 확정; AD-7의 “간격 안”과 doctor 3배가 다름 → 공용 freshness 함수·누락/미래 mtime·정지 직후 무효화·pid 보조 판정 합의. 90초 공통 기준이 자연스럽지만 문구 조정 필요(spine AD-7 L167, AD-25 L393).
- **감시:** roots·재귀·설정 변경·rename/delete·symlink·debounce 미정 → connector transcript 탐색·`[files] path`의 `brain` 위치, 이벤트는 scan/ingest·`work_items` 재사용. 초기/복구 scan과 bounded debounce로 유실 방지; external 파일 변경을 붙인 시점의 첨부 내용으로 덮어쓰지 않는다(spine AD-23 L364–369, AD-27 L414).
- **잠금·종료:** 상한을 설치의 30분으로 그대로 복사하면 정상 상주 pid도 회수될 수 있음 → 살아 있는 소유자를 나이만으로 빼앗지 않는 lease 갱신 계약을 명시. SIGINT·종료 제한시간·진행 일감·열린 spool의 flush·heartbeat/pid 삭제 순서도 미정(spine AD-19 L319, AD-27 L413).
- **launchd·진단 검증:** reverse-DNS·plist 위치/나머지 키·launchctl 도메인·status JSON·실패 코드 미정 → 공용 adapter와 fake 계약 검증 + 이 Mac의 격리 Label로 재기동·멱등·제거 실증. 마이그레이션 중 구데몬 처리도 합의(epic L35–36; change-v1 §4.1 L137).

## 3. STALE / CONTRADICTIONS

- change-surface §4.1 L182–247의 MCP·소켓 우선·`--daemon`·별도 주기 실행·epic 5 선행, §6 L362–363의 `[daemon] enabled`/두 Label·Drive 비의존은 역사 기록. 10/26 결정으로 대체; NDJSON·짧은 핸들 후보(patterns §2 L121–122)도 V1 의무가 아니다(epic L21, L61).
- spine AD-5 L130는 `setup uninstall` 전체를 V1 뒤라 하지만 epic L36은 데몬 정리를 요구한다. change-v1 §4.6 L327–335대로 데몬 정리만 V1 최소 경로로 분리해야 한다. change-v1 §4.4 L225의 “기회적 drain은 짧게 끝난다”는 실제 drain 생략으로 해석(spine AD-7 L167).
- spine Deferred L603의 MCP “해소: epic 9”와 L605의 짧은 핸들 “인셉션”은 V1 범위로 오독 가능; AD-26·28의 V1 뒤 표식이 우선. epic Notes L53–59의 이전 순서·handshake·자체 업데이트도 L61이 명시적으로 유예한다.

## 4. 기능 묶음 배포의 Done when

- 여섯 문서에 해당 완료 문장 그대로는 없다. 근거: 기능 묶음마다 `app-ref`·`version` 배포 및 마지막 실계정 확인 유지(change-v1 §4.1 L137), push만으로 설치본이 갱신되지 않는 규칙(spine AD-19 L321)이다.
- 제안 완료 증거: `plugin/app-ref` 고정·`plugin/.claude-plugin/plugin.json`의 `version` 동반 상승 → `claude plugin update` → SessionStart bootstrap → `installed.json`/build commit 확인 → 새 데몬·heartbeat·무hook 수집·upgrade/restart 실증. `app-ref`는 변경 커밋 이전 커밋을 가리킨다(저장소 AGENTS.md Policy). docs-only 변경은 배포 제외(change-v1 §5 L370). 배포는 수행하지 않았다.
