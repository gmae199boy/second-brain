# 추천으로 정한 결정

2026-10-28 사용자 지시("사람 개입이 없어야 해"): 남은 V1 에픽을 쪼갤 때와 만들 때 사람이 정할 일은 추천안으로 정하고, 무엇을 어디서 정했는지만 남긴다. 한 줄에 하나씩, 나중에 한 번에 검토한다. 바꾸고 싶은 줄이 있으면 그 티켓의 Decision을 고치고 이 줄에 `→ 바뀜`을 단다.

| 날짜 | 어디 | 무엇을 정했나 | 근거 |
|---|---|---|---|
| 2026-10-28 | epic 12 · 12.12 | 이 Mac 확인을 에이전트가 로컬 설치본으로 하고 증거를 plan에 남긴다(`hitl = false`). 원격 push가 있어야 하면 `operator_actions`로 남긴다 | 이니셔티브 Notes 2026-10-28 위임 |
| 2026-10-28 | epic 14 · C6 | 기준 소스와 충돌 처리는 epic 14를 쪼갤 때 preflight 증거로 추천 규칙을 정하고, 반입은 에이전트 스토리로 한다 | 사용자 위임, AD-36 |
| 2026-10-28 | epic 15 · Telegram | 옛 Garmin 봇 token·chat id가 이 Mac에 있으면 Brain `.env`로 옮겨 쓴다. 없으면 그 스토리만 `awaiting-operator` | 사용자 위임 |
| 2026-10-28 | epic 16 · Garmin 로그인 | 옛 Garmin tokenstore(기본 `~/.garmin-pipeline/tokens`)가 유효하면 그것으로 로그인한다. MFA가 필요하면 그 스토리만 `awaiting-operator` | 사용자 위임 |
| 2026-10-28 | 루프 설정 | `gates.mode = "none"`: 에픽 경계에서 멈추지 않는다 | 사람 개입 없이 끝까지 |
| 2026-10-28 | epic 13 · 명령 | `brain ext install|list|status|enable|disable <name>`. 설치 대상은 앱에 함께 오는 `extensions/<name>/`만, 사용자용 `--from <경로>` 없음 | spine 패키지 표, 서드파티 코드 범위 밖 |
| 2026-10-28 | epic 13 · fixture | Node `testext`(tracer·설치·스킬·켜기/끄기)와 Python `pyfixture`(uv frozen·patch 확인·Python fixture 판정). 옛 Garmin 잠금 재현성은 epic 14 | 코드 조사 5·7절 |
| 2026-10-28 | epic 13 · 단계 보고 | 단계별 결과를 registry 행에 남기고 응답은 그것을 다시 읽은 값 | 지금 setup 실패 결과에 성공 단계가 없음(조사 2절) |
| 2026-10-28 | epic 13 · 끄기 일관성 | 활성 변경과 12.10 보류를 한 트랜잭션에. 안 되면 registry 재조정 use case | 꺼졌는데 청구되는 상태 방지 |
| 2026-10-28 | epic 13 · 스킬 시험 | 정적 검사 + 가짜 CLI 행동 시험(기본 suite 밖). 실제 에이전트 실행은 13.10에서 한 번 | 조사 7절 |
| 2026-10-28 | epic 13 · 순서 | 1~8 한 줄, 13.1은 12.11(epic 12 sweep)을 기다림 | 같은 파일을 고침(조사 8절), 11→12 선례 |
| 2026-10-28 | epic 13 · 설치본 확인 | testext·가짜 로그인은 격리된 Brain 홈에서만 켜지는 시험용 resolver·harness로. 13.10은 격리 홈에서 확인하고, 운영 설치본은 버전·스킬 발견만 확인 | 세트 검증 F1 |
| 2026-10-28 | epic 13 · risk | 스토리별 risk와 이유 표를 에픽 Notes에 | 세트 검증 F5 |
| 2026-10-28 | epic 15 · 실행 분류 | `channel_send`는 `supervised`(core Node worker, ABI v1). hook·기회적 drain은 발신하지 않음 | hook이 Harness를 막지 않게 |
| 2026-10-28 | epic 15 · 비밀 키 | `.env`의 `BRAIN_TELEGRAM_BOT_TOKEN`·`BRAIN_TELEGRAM_CHAT_ID`. 옛 `telegram.json`을 찾으면 옮김. 기본 tokenstore에는 없었음 | 코드 조사 7절 |
| 2026-10-28 | epic 15 · 결과 분류 | `sent`·`definite_failed`(요청 전 실패)·`unknown`(요청 뒤 응답 유실) | 옛 `network` 합침을 나눔 |
| 2026-10-28 | epic 15 · 묶음 | 재시작 때 `sent` 항목은 건너뜀, 4096 넘는 텍스트는 나누지 않고 `too_large` | 옛 동작 |
| 2026-10-28 | epic 15 · 순서 | 1~5 한 줄, 15.1은 13.9를 기다림. epic 11~13 쪽에 인계 문장을 더하지 않음(명시적 예외) | 같은 파일, 선례 |
| 2026-10-28 | epic 11 · 11.1 escalation(U+0000) | transcript 텍스트의 U+0000: `text` 칸에는 U+FFFD로 바꾼 값(검색·표시), nullable `bytea` 짝 칸에 원래 UTF-8 바이트(있을 때만). 읽기는 원문을 돌려준다. 입력은 거부하지 않는다. main의 epic 11 Notes와 11.1 plan에 기록, `resolve --no-interactive`로 재개 | AD-11 원문 보존, SM-5 = 0 |
| 2026-10-28 | epic 14 · C6 기준 소스 | 선택지 A: 운영(D2) 기준, 없는 키는 D1 → D4 → D5 → D3 순으로 보완, 미선택 값은 모두 보관, 정수 id 이력은 dataset별 | D1·D2는 겹치는 키가 모두 같고, 충돌은 보관본 D4·D5와만 있음(조사 3절) |
| 2026-10-28 | epic 6 · 임베딩 | (사용자 결정) 나중에 확장으로 만든다. 무인 파이프라인에서 뺀다 | 사용자 |
| 2026-10-28 | epic 14 · Python 의존 | PG driver `psycopg[binary]` 3(sync)만 더하고 pin 3.14.10(spine Stack의 새 배포 pin) 위에서 다시 잠근다. 옛 의존(garminconnect 등)과 그 arm64 설치 확인은 epic 16 | importer는 표준 `sqlite3`와 driver만 쓴다(조사 7절) |
| 2026-10-28 | epic 14 · raw view key | `garmin.raw_records.key` = `<scope>/<원래 key>`. epic 16도 같은 정규형 | view에 scope가 없는데 key가 day·activity 양쪽에 있음(조사 4절) |
| 2026-10-28 | epic 14 · 계정 identity | raw 본문의 Garmin 사용자 profile id로 dataset마다 확인, 안 모이면 계정 미확인·ambiguity | raw에 계정 칸 없음, 폴더 추정 금지(조사 4절) |
| 2026-10-28 | epic 14 · 권위 기록 | 규칙 v1 = D2 → D1 → D4 → D5 → D3, 역할은 private manifest의 source 분류. epic 16이 새 수집을 맨 앞에 둔 새 규칙 버전을 쓴다 | C6 선택지 A, AD-32 |
| 2026-10-28 | epic 14 · 파일 분류 | 리포트·facts → `analyses`+파일, PNG·입력 JSON → 파일 관계, 로그는 비밀 검사 통과분만, 설정 TOML은 제외(사유 기록) | 비밀·기계 설정 분류(migration-contract) |
| 2026-10-28 | epic 14 · 수동 실행 | 공용 `brain ext run <name> <job> [--target …]`. Garmin은 `import-preflight`·`import`·`import-verify` | 확장마다 core 명령을 더하지 않음(AD-29) |
| 2026-10-28 | epic 14 · 보고서 위치 | private 상세는 Brain 홈 확장 데이터 아래, 공개 집계만 출력·plan에(해시·원문·계정·개인 날짜 없음) | 공개 저장소 |
| 2026-10-28 | epic 14 · 실제 반입 | 옛 writer를 멈추지 않고, 반입 직전 에이전트가 새 일관 capture(backup API, 해시 비교)를 Brain 홈에 만든다. 14.8은 `hitl = false` | 조사 9절 전제, 위임 |
| 2026-10-28 | epic 14 · 순서 | 1~8 한 줄, 14.1은 15.6을 기다림. tracer 1 → 건강 의미 2 → preflight 3 → 반입 4 → 파일 5 → 검증 6 → sweep 7 → 실제 반입 8 | 같은 파일(조사 8절), 15.1 선례 |

## 사람 몫

사람만 할 수 있는 일이다. 어느 것도 run을 막지 않는다. 해당 스토리는 그 단계만 `awaiting-operator`로 두고 `operator_actions`에 재개 절차를 남긴다. 끝나면 `bmad-loop confirm`으로 알린다.

| 에픽 · 스토리 | 할 일 | 언제 |
|---|---|---|
| 전체 | 원격 push(`plan/epics-12-on` 병합분과 플러그인 배포 커밋). 원격 마켓플레이스가 새 `version`을 받는다 | 원할 때. 로컬 설치본 확인은 에이전트가 이미 함 |
| epic 15 · 15.7 | 이 Mac에서 옛 봇 token·chat id를 찾지 못했을 때만 `.env`에 `BRAIN_TELEGRAM_BOT_TOKEN`·`BRAIN_TELEGRAM_CHAT_ID`를 넣는다 | 15.7이 `awaiting-operator`일 때 |
| epic 16 | 옛 Garmin tokenstore가 만료돼 MFA가 필요할 때만 로그인한다 | 16의 실계정 스토리가 `awaiting-operator`일 때 |
| epic 18 | 분석 결과의 품질을 판단한다(에이전트는 형식·저장·순서만 검증) | 18 완료 뒤 |
| epic 8 | Google Drive OAuth 동의 | epic 8의 실계정 스토리가 `awaiting-operator`일 때 |
