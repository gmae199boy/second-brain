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
| 2026-10-29 | epic 11 · 11.13 | 이 Mac 확인을 에이전트가 로컬 설치본으로 하고 증거를 plan에 남긴다(`hitl = false`). DB 끄기 단계 뒤 다시 켜고 drain을 마친다. run은 이 hitl에서 멈췄고, 계획 병합과 함께 풀어 재기동 | 2026-10-28 위임, 12.12와 같은 방식 |
| 2026-10-29 | epic 12 · 12.4 escalation(stderr 가림) | ABI v1 stderr는 줄 단위로 가린 다음 자른다. PEM 블록 상태를 줄 사이에 이어 가고(END 없으면 EOF까지), 한 줄 상한 65536바이트, 그 뒤 16 KiB → 4096바이트. plan intent-contract·행렬과 epic 12 Notes에 기록, `resolve --no-interactive`로 재개 | E12-5 비밀 비노출, 리뷰의 합성 PEM 재현 |
| 2026-10-29 | epic 12 · 12.4 두 번째 escalation(stderr 가림) | 위 줄 규칙을 대체: stderr 원문을 1 MiB까지 보관 → `maskSecrets` 전체 한 번 → 끝 4096바이트. 1 MiB 초과면 원문 없이 고정 안내문만. Codex 검증 `12-4-stderr-rule-check.md` | 줄별 가림이 줄로 갈린 비밀을 남김, 잘린 원문 덜어내기에 반례 |
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
| 2026-10-28 | epic 16 · 계정 보호 | 인증 실패·MFA는 재인증 성공까지, 429·403은 다음 현지 날짜의 탐색 호출 성공까지 외부 호출 0. 이틀 연속 차단은 `brain ext run garmin release-block`으로만 해제. 상태는 garmin schema에 | 옛 동작(날짜가 지나면 해제)이 Done when 2와 어긋남(조사 2절) |
| 2026-10-28 | epic 16 · tokenstore | 라이브러리 관리 세션 파일이라 `.env` 밖에 둔다(`garmin.tokenstore` 경로만 snapshot). spine AD-18에 예외로 적음 | 옛 tokenstore 재사용 위임 |
| 2026-10-28 | epic 16 · 일감 | `collect`(증분 정규화·publish 포함)·`normalize`(rebuild·재개)·`artifacts`(body·digest·그래프)·`release-block` | raw만 남고 publish가 빠지는 틈을 줄임 |
| 2026-10-28 | epic 16 · 동등성 | 합성 fixture만 옛 archive 코드에 한 번 넣어 기대 JSON을 고정(opt-in 스크립트), 새 코드는 그 JSON과 비교 | 순환 검증 회피(조사 8절) |
| 2026-10-28 | epic 16 · digest | digest 일 값은 core 건강 요약 행. catalog에 없는 지표는 호환 core 마이그레이션으로 더함 | epic 18 입력이 core 계약만 읽음(AD-35) |
| 2026-10-28 | epic 16 · 전환 | 공통 예약 전에 옛 collect LaunchAgent를 내림(plist 보존). 옛 report는 스스로 수집할 때만 함께 내리고 아니면 epic 18이 내림. capture 뒤 날짜는 새 수집이 채움 | 두 수집기 동시 호출은 차단 위험 |
| 2026-10-28 | epic 16 · 순서 | 1~9 한 줄, 16.1은 14.7을 기다림. tracer → 계정 보호 → 수집 → 정규화·권위 v2 → body·digest → 그래프 → 알림 → sweep → 전환 | 같은 파일(조사 10절), 앞 에픽 선례 |
| 2026-10-28 | epic 18 · 입력 snapshot | 분석 그래프마다 snapshot 하나를 바이트로 남김. cutoff는 기다린 수집 결과의 값. digest는 다시 계산하지 않고 epic 16 `artifacts`의 digest JSON 파일을 읽음 | 옛 기간별 snapshot이 서로 달랐음(조사 2절) |
| 2026-10-28 | epic 18 · 평가 순서 | 엄격한 의존: 실패 scope는 재시도, 끝내 실패하면 뒤 scope는 `dependency_failed`, `REPORT_FAILED` 발신 | 옛 report는 실패 뒤에도 다음 scope를 돌려 7d가 오늘 day 없이 요약됨 |
| 2026-10-28 | epic 18 · 설정 키 | `analysis.agent`·`analysis.model`(NULL=CLI 기본, 인자 생략)·`analysis.effort`·`analysis.timeout_minutes`·`analysis.profile_path` | 사용자 Decision의 기본값 그대로 |
| 2026-10-28 | epic 18 · 리포트 파일 | core 분석 일감이 FileStore에 직접 넣고 파일 관계 행을 더함(`file_requests` 안 씀) | core가 생산자(조사 5절 선택지 A) |
| 2026-10-28 | epic 18 · 체성분 intake | 사진 → 측정 JSON은 이 에픽의 core 모델 일감, 결과 JSON은 epic 16이 읽는 inbox 자리에 씀 | 모델 호출은 core 일감(AD-33·35) |
| 2026-10-28 | epic 18 · Claude Code adapter | `claude -p … --model … --effort … --output-format json`, usage는 결과 `usage`. 두 adapter 모두 core가 같은 schema로 재검증 | spine currency 리뷰가 공식 문서로 확인 |
| 2026-10-28 | epic 18 · 묶음 | 앨범은 그래프 역할 metadata로 가름. 의미 키 생산 결과 = 분석 묶음 id, `REPORT_FAILED`는 날짜당 한 번 | 옛 묶음엔 중복 방지 gate 없음 |
| 2026-10-28 | epic 18 · 전환 | 18.9가 새 11:30 예약을 켤 때 옛 report LaunchAgent를 내림(plist 보존) | 옛·새 평가 동시 실행 방지 |
| 2026-10-28 | epic 18 · 순서 | 1~9 한 줄, 18.1은 16.8을 기다림. tracer → snapshot 동등성 → 네 scope → 두 adapter → intake → 묶음 → 예약·끄기 → sweep → 전환 | 같은 파일(조사 8절) |
| 2026-10-28 | epic 17 · 조각 키 | `chunks` 키에 결정적 분할 번호 `part`를 더함(나누지 않은 조각 0). 같은 시각 메시지 묶음은 경계에서 쪼개지 않음. spine Table Contract에 반영함 | 긴 메시지 분할 조각이 같은 시각 범위라 키 충돌(epic 4 이월 메모) |
| 2026-10-28 | epic 17 · 명령 | `brain recall chunks|tools|docs|expand`, `brain sessions read`, `brain files show`, `brain health query`. 공통 `recall search`는 없음 | AD-5 표, 출처 중립 이름(AD-29) |
| 2026-10-28 | epic 17 · 확장 상태 | `meta.extensions`에 `{source, installed, enabled, searchable, work_state}` | `data`를 감싸면 0건 `data: []` 계약과 어긋남 |
| 2026-10-28 | epic 17 · 넓히기·원문 | `recall expand`는 출처의 session·시각 구간으로 메시지를 읽음, `files show`는 `file_id`+`chunk_locator`로 현재 세대를 읽고 세대 교체를 알림 | 조각 재생성 뒤에도 같은 원문 |
| 2026-10-28 | epic 17 · 평균 | 분모는 비NULL·비ambiguity 유효 숫자 수, 값이 없으면 `value = null`과 개수 0 | 실제 0과 구분 |
| 2026-10-28 | epic 17 · 스킬 | 얇은 `plugin/skills/recall/SKILL.md` | R14의 에이전트 호출 경로 |
| 2026-10-28 | epic 17 · 실제 질문 | 이 Mac 설치본에서 에이전트가 실제 기억으로 질문 10개를 만들고, 문항·기대 결과·기준을 private에 먼저 고정한 뒤 판정(공개 plan엔 문항 id·유형·성공 여부만) | spine AD-15의 10건 중 7건, 위임 |
| 2026-10-28 | epic 17 · 순서 | 1~7 한 줄, epic 18과는 `after`로 잇지 않음(데이터 의존 없음, 만드는 순서상 18이 먼저) | 같은 파일(조사 8절) |
| 2026-10-28 | epic 18 · 체성분 intake 시점 | `body_intake`는 자기 예약(기본 10:45, 수집 전)과 수동 실행. 그날 artifacts가 새 JSON을 읽음 | 순환 의존 없이 사진 → JSON → 병합(세트 검증 S1) |
| 2026-10-28 | epic 18 · 모델 접근 | cwd=scratch, CLI sandbox·도구 허용 목록, 로그인 자료 외 홈 파일 미전달, env 허용 목록, 원 출력은 private scratch에서 검증 뒤 삭제 | 세트 검증 F2 |
| 2026-10-28 | epic 8 · Drive locator | locator는 내용 순수 함수(`<hex><확장자>`), `(루트, content_hash) → remote id`와 업로드 상태는 별도 표 | Drive 이름은 유일하지 않음, AD-23 순수 함수 |
| 2026-10-28 | epic 8 · 검증 | `sha256Checksum` → `md5Checksum`(로컬 MD5와) → 되읽기 SHA-256. 5MiB 넘으면 resumable | 공식 필드가 파일 종류마다 다름(조사 1절) |
| 2026-10-28 | epic 8 · 이전 확정 | 원격 위치·`verified_at`·`home` 전환·삭제 예약을 CAS로 한 트랜잭션. 삭제 handler는 현재 설정으로 due 재계산, 지우기 직전 원격 재확인 | 마지막 사본 보존 |
| 2026-10-28 | epic 8 · OAuth | scope `drive.readonly`+`drive.file`, `.env`에 client id·secret·refresh token, access token은 저장 안 함, loopback+PKCE | `drive.file`로는 기존 폴더 못 읽음 |
| 2026-10-28 | epic 8 · 명령·설정 | `brain sources connect drive|add|list|remove|sync|disconnect`, `drive.root_folder_id`·`drive.watch_folders`·`drive.sync_interval_minutes`(30)·`drive.keep_local_days`(30) | 출처 중립 이름공간 |
| 2026-10-28 | epic 8 · 외부 소스 | `sources`(계정마다 changes cursor)·`source_files`(content id nullable). 사진·큰 파일은 이름만, 결과는 `file_id` nullable·색인 상태 | `files`에 가짜 해시를 넣지 않음 |
| 2026-10-28 | epic 8 · 추출기 | Google Docs는 text export, PDF는 pdfjs-dist 텍스트 경로, docx는 mammoth. 상한 PDF 50MiB·2,000쪽, docx 압축 50MiB·해제 200MiB, 추출 500만 자. Carry는 바이트 판정으로 버전마다 한 번 | 조사 5절 |
| 2026-10-28 | epic 8 · 연동 해제 | 예약 중지·늦은 확정 차단·토큰 삭제·접근 불가 표시, 대기 중 로컬 삭제는 취소, Drive delete 0 | 해제 뒤 로컬이 유일한 접근 가능 사본 |
| 2026-10-28 | epic 8 · 순서 | 1~8 한 줄, 8.1은 17.6을 기다림. tracer(원본 이전) → 외부 폴더 색인 → OAuth·해제 → PDF·docx → 증분·재개 → 문서 찾기 통합 → sweep → 이 Mac | 같은 파일(조사 8절) |
| 2026-10-28 | epic 5 · stats show | epic 3의 마지막 기능 스토리로 옮김 | 입력(`context_injections.kind`·`elapsed_ms`)을 epic 3이 만듦 |
| 2026-10-28 | epic 5 · 백업 형식 | compose 안 `pg_dump -Fc` + `pg_dumpall --globals-only --no-role-passwords` + Brain 소유 로컬 블롭 + `.env`·`config.toml` + manifest, `<home>/backups/<id>/`(0700) | AD-20 원문 백업, 서버와 같은 client |
| 2026-10-28 | epic 5 · 일관성 | export snapshot을 dump와 해시 reader가 공유, 백업 pin으로 블롭 삭제 보류, 빠진 블롭이면 미완료 | DB snapshot은 파일 snapshot이 아님(조사 2절) |
| 2026-10-28 | epic 5 · 복구 | 새 Brain 홈(새 compose project·volume)으로만, role 비밀번호는 `.env`에서, Garmin tokenstore는 백업 안 함(재로그인). D0 합치기·가린 JSONL import는 backlog | 운영 DB 덮어쓰기 위험 |
| 2026-10-28 | epic 5 · 명령·설정 | `brain backup create|list|verify|restore`, `brain export`, `setup upgrade`, `setup uninstall --all [--delete-data]`, `backup.warn_days`(7), 자동 예약·정리 없음 | AD-20 |
| 2026-10-28 | epic 5 · 갱신 순서 | 공통 갱신 함수에서 doctor를 데몬 재시작 뒤로, 완료 기록은 마지막 | 지금 설치기 순서가 AD-20과 어긋남(조사 0절) |
| 2026-10-28 | epic 5 · 순서 | 1~9 한 줄, 5.1은 8.7을 기다림. tracer(백업 왕복) → snapshot·블롭 → 확장·role 복구 → 공통 갱신 → 경고 → 가린 내보내기 → 완전 제거 → sweep → 이 Mac(비파괴) | 같은 파일(조사 8절) |
| 2026-10-28 | epic 3 · 재쪼개기 | 기존 id 유지, SQLite 전제 제거, 13은 dropped 유지, 16 = stats show(epic 5에서), 17 = 새 Refactor sweep, 교차 after를 epic 11·12·13·17 entry로 다시 고정 | V1 뒤 에픽도 같은 방식(사용자) |
| 2026-10-28 | epic 3 · 인용 증거 | 불변 표 `rule_quote_evidence`(원래 바이트 포함), 대조는 messages 짝 칸으로 복원한 원문에서 원래 좌표 → NFC | AD-11 U+0000, AD-14 |
| 2026-10-28 | epic 3 · 재대조 | core 일감 `rule_recheck`(세션 단위, 수집 트랜잭션에서 멱등), `pending`만 CAS로 올림, 대조 실패는 일감 실패 아님 | `off` 자동 부활 금지 |
| 2026-10-28 | epic 3 · 주입 기록 | spool → drain 재생 handler가 `context_injections`에 넣음, 세션 없는 시도는 7일 대기 뒤 버림(10회 실패와 별개) | 두 큐 소유권을 새로 만들지 않음 |
| 2026-10-28 | epic 3 · hook PG | hook은 로컬 PG 읽기만(11.7 시간 상한, READ ONLY), 쓰기·마이그레이션·drain·컨테이너 시작 없음. spine AD-6 문구를 이 뜻으로 | AD-6과 PG 로컬 TCP의 긴장(조사 3절) |
| 2026-10-28 | epic 3 · 시작 맥락 크기 | DB 설정 `context.max_chars`·`timezone`, `stop_remind`만 config.toml. 가린 최종 문자열의 코드 포인트로 셈 | 조사 5절 |
| 2026-10-28 | epic 3 · Spike·체크리스트 | 3(Stop 실측)·4·15를 에이전트가 격리 홈과 `claude -p`로(`hitl = false`). 방해 정도의 체감은 사람 몫 | 위임, 12.12 선례 |
| 2026-10-28 | epic 3 · 순서 | 1·2 → 4 → 5 → 6 → 7 → 8 → 9 → 14 → 10 → 11 → 3 → 12 → 16 → 17 → 15, 4는 5.8을 기다림 | 같은 파일(조사 8절) |
| 2026-10-28 | epic 4 · 범위 | SQLite 전제(FTS5·LIKE 폴백·QUERY PLAN)를 17의 질의 함수와 EXPLAIN 기록으로 대신, 남는 것은 시간 조회·logs·count·러너·미러·가리기와 미러·index rebuild·EXIF | V1 뒤 에픽도 같은 방식(사용자) |
| 2026-10-28 | epic 4 · 미러 이름 | ` (2)` 충돌 번호는 DB에서(대소문자를 접은 경로, 세션 시작 시각·id 순), 위치는 기계 값 `[mirror] path` | 다시 만들어도 같은 이름 |
| 2026-10-28 | epic 4 · 가리기와 미러 | redact 트랜잭션이 미러 일감을 넣고, 확정 직후 미러 파일을 지움(실패면 경고·doctor warn) | AD-11 U1 즉시성 |
| 2026-10-28 | epic 4 · index rebuild | 새 설정 세대를 다 만든 뒤 활성 포인터 전환(섞이지 않음, 이어 가기) | 중간에 검색이 비지 않음 |
| 2026-10-28 | epic 4 · count | 기간을 주면 그 안의 모든 달(0 포함), docs `files`는 file_id와 `source_file_id`를 따로 셈 | 조사 6절 |
| 2026-10-28 | epic 4 · 러너 | TOML `[[question]]`(id·verb·query·expect·k), any-hit hit@k, 결과는 식별자·질의·점수만, 실제 문항은 `~/.second_brain/eval/` | SM-3는 사람 몫 |
| 2026-10-28 | epic 4 · EXIF | exifr(안 되면 exif-reader), 메타데이터만 있는 추출 성공, 시간대 추정 금지, Carry는 epic 8 방식 | 조사 8절 |
| 2026-10-28 | epic 4 · 순서 | entry 1(EXIF) id 유지, 2(시간 조회 tracer) → 3 → 4 → 5 → 6 → 7 → 8 → 1 → 9(sweep) → 10(이 Mac), 2는 3.17을 기다림 | 같은 파일(조사 9절) |

## 사람 몫

사람만 할 수 있는 일이다. 어느 것도 run을 막지 않는다. 해당 스토리는 그 단계만 `awaiting-operator`로 두고 `operator_actions`에 재개 절차를 남긴다. 끝나면 `bmad-loop confirm`으로 알린다.

| 에픽 · 스토리 | 할 일 | 언제 |
|---|---|---|
| 전체 | 원격 push(`plan/epics-12-on` 병합분과 플러그인 배포 커밋). 원격 마켓플레이스가 새 `version`을 받는다 | 원할 때. 로컬 설치본 확인은 에이전트가 이미 함 |
| epic 11 · 11.13 | `git push origin main`으로 플러그인 0.1.9 배포 커밋(`726a651`, `app-ref` = `7c7a086`)까지 올린 뒤 `bmad-loop confirm 11.13`. 이 Mac 확인 목록은 에이전트가 모두 통과시켰다(plan `story-mac-pg-plan.md`) | 원할 때. 11.13만 `awaiting-operator`이고 run은 계속 |
| epic 15 · 15.7 | 이 Mac에서 옛 봇 token·chat id를 찾지 못했을 때만 `.env`에 `BRAIN_TELEGRAM_BOT_TOKEN`·`BRAIN_TELEGRAM_CHAT_ID`를 넣는다 | 15.7이 `awaiting-operator`일 때 |
| epic 16 | 옛 Garmin tokenstore가 만료돼 MFA가 필요할 때만 로그인한다 | 16의 실계정 스토리가 `awaiting-operator`일 때 |
| epic 18 | 분석 결과의 품질을 판단한다(에이전트는 형식·저장·순서만 검증) | 18 완료 뒤 |
| epic 17 | (선택) 17.7의 실제 질문 10건 판정을 다시 본다 | 17 완료 뒤 |
| epic 3 | (선택) Stop 점검이 실사용에서 방해가 되는지 판단하고, 기본값(`stop_remind = false`)을 바꿀지 정한다 | 3 완료 뒤 |
| epic 4 | SM-3 채점표(addendum §8)로 실제 질문의 답변을 채점한다(러너의 hit@k는 이를 대신하지 않음) | 4 완료 뒤 |
| epic 16·18 | Codex·Garmin 로그인이 만료됐을 때만 재로그인한다 | 해당 스토리가 `awaiting-operator`일 때 |
| epic 8 · 8.8 | Google Cloud에서 데스크톱 OAuth client를 만들고(동의 화면은 In production 권장, 8.3이 확인), client id·secret을 `.env`에 넣은 뒤 `brain sources connect drive`로 동의한다 | 8.8이 `awaiting-operator`일 때 |
