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
