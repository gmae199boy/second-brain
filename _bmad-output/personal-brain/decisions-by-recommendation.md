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
