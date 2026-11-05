# 21.4 R5 — R4-V1 표적 최종 확인

**R4-V1은 정적 확인상 해결됐다. 추가 발견 없음.** 검사 수행 차단과 이 한 줄 변경에서 입증된 회귀는 없다.

자동화 runbook과 본인의 `r4-verification.md`, 현재 `extensions/garmin/tests/test_report_process.py:80`~`:87` 및 `extensions/garmin/tests/report-fixture/codex:1`~`:29`를 읽고 대조했다. 검사 범위는 unknown-skill fixture에 추가된 합성 `BRAIN_ATTEMPT_TOKEN`과 fake의 조기 거부 전 필수 환경 키로 한정했다.

현재 fixture의 `test_report_process.py:84`는 subprocess 환경에 `'BRAIN_ATTEMPT_TOKEN':'synthetic'`을 제공한다. fake는 조기 거부 전에 extension home·target·work·attempt 네 키를 읽으며(`codex:11`~`:14`), fixture는 이를 모두 제공한다. 이 구간에서 attempt는 문자열 조회만 하며 UUID 검증·DB 접근·장부 기록에 사용되지 않는다. 따라서 합성 문자열로 누락 KeyError의 원인을 제거한다.

호출 인자 `$garmin-unknown`은 허용 scope 목록에 없으므로 제어 흐름은 `codex:20`~`:21`의 `sys.exit(18)`에 도달한다. 이후의 `BRAIN_USER_ID` 조회·workspace 확인·skill 파일 읽기는 실행되지 않으므로 이 조기 거부 시험에 그 환경을 추가할 필요는 없다. 기존 `returncode == 18` assertion은 유지돼 unknown skill 거부를 그대로 관찰하며, 추가 환경 키가 assertion을 우회하지 않는다.

**시험 실행은 21.8로 이관, 미실행**이다. 위 판정은 소스의 환경 전달과 분기 순서에 대한 정적 확인이며 시험 통과 결과가 아니다. 소스·계획 수정, build/typecheck, 모든 시험·fixture 생성·checker, 실모델·운영 호출, 추가 워커 실행은 하지 않았다. 이 보고서만 작성했으며 새 시험 요구는 추가하지 않았다. 이 표적의 미해결 수정 사항은 없고 실제 시험 실행은 21.8에 남는다.
