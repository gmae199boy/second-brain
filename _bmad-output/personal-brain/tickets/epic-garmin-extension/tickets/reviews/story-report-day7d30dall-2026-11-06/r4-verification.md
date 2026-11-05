# 21.4 R4 독립 검증 후속 확인

정적 확인 완료. R3-V1~V3의 직접 원인은 수정됐으며, Task 13의 fake 장부 변경으로 기존 Python 시험이 실패하는 수정 회귀 1건을 확인했다. 검사 수행 차단은 없다.

AGENTS.md와 자동화 runbook, 본인의 `r3-verification.md`를 다시 읽고 `/private/tmp/brain-214-review-r4.diff`를 R3 diff와 대조했다. 두 diff 사이의 변경은 `apps/cli/python-test/garmin-report.test.ts`와 `extensions/garmin/tests/report-fixture/codex`뿐이었다. 해당 두 파일 전체와 직접 연결된 기존 Python fake 시험, Python discovery harness, 감독자의 실패·복구·프로세스 정리, PG 정산·claim 계약을 정적으로 검사했다. 기존 시나리오의 실행 불가·검증 우회와 이번 수정의 회귀로 범위를 한정했다.

**시험 실행은 21.8로 이관, 미실행**이다. 시험·fixture 생성·checker·build/typecheck·실모델·운영 호출·추가 워커를 실행하지 않았고, 이 보고서 외 소스·계획은 수정하지 않았다. 아래 처분은 코드 대조 결과이며 실행 통과를 뜻하지 않는다.

## 미해결 수정 회귀

### R4-V1 — fake가 attempt token을 먼저 요구해 기존 unknown-skill 시험이 거부 분기에 도달하지 못한다

- **위치:** `extensions/garmin/tests/report-fixture/codex:14`; 호출자는 `extensions/garmin/tests/test_report_process.py:80`~`:86`.
- **원인:** Task 13은 호출 장부에 attempt를 넣기 위해 fake 시작 부분에 `attempt = os.environ['BRAIN_ATTEMPT_TOKEN']`을 추가했다. 이 접근은 알 수 없는 skill을 exit 18로 거부하는 `:20`~`:21`보다 앞에 있다. 기존 `test_fake_codex_rejects_unknown_skill_instead_of_defaulting_to_day`의 subprocess 환경에는 PATH·extension home·target·work만 있고 attempt token은 없다. subprocess에 전달하는 `env`가 명시적 딕셔너리이므로 상위 환경에 token이 있어도 보충되지 않는다.
- **도달 가능한 실패:** 기존 시험이 fake를 `$garmin-unknown`으로 실행하면 `BRAIN_ATTEMPT_TOKEN` 조회에서 처리되지 않은 KeyError로 종료한다. 알 수 없는 skill 거부 분기까지 도달하지 못하고 반환 코드는 기대한 18 대신 1이 된다. 따라서 해당 assertion은 정상 제품 코드에서도 실패한다.
- **증거와 영향:** 기존 시험 `:82`~`:85`의 환경 정의와 fake `:14`의 필수 조회를 직접 대조했다. `apps/cli/python-test/garmin-unit.test.ts`는 `unittest discover -p test_*.py`로 이 시험을 포함하고 subprocess 전체의 성공을 요구하므로 21.8의 Garmin Python 회귀에도 영향을 준다. 실행·재현으로 얻은 결과가 아닌 정적 제어 흐름 판정이다.
- **필요한 처분:** 기존 unknown-skill fixture에 새 필수 환경을 제공하거나, fake의 unknown-skill 조기 거부가 그 환경을 요구하기 전에 수행되도록 맞추면 된다. 새 시험 시나리오 추가 요구가 아니다.

## R3 발견사항 처분

### R3-V1 — 정적 확인상 해결

`garmin-report.test.ts:53`~`:60`의 새 `failedAttempt()`는 `work_attempts`에서 선택한 token의 outcome과 finished_at을 관찰하고, 실패의 retryable 및 일감의 outcome/completed_at/current token이 NULL인 상태를 함께 확인한다. 작업 그룹 SIGKILL은 `died`, 모델·intake·lock 오류는 `failed`로 구분한다. 이전 `outcome(work,'failed')` 호출은 제거됐다.

후속 실행은 `:62`~`:64`의 `retryNow()`로 소유 시험 DB의 해당 열린 일감 `next_attempt_at`만 앞당긴다. 제품 감독·실패·저장 경로를 대체하지 않는다. 새 attempt의 모델 호출은 work+attempt로 구분하고 최종 성공은 기존 일감에서 확인한다. scope 오류는 빠진 scope만, timeout은 빠진 day만, regenerate는 네 scope 전부, 완료된 분석 뒤 intake 오류의 재시도는 모델 무호출 noop이라는 기존 동작에 맞춰 assertion을 유지했다. 관련 위치는 `:83`~`:86`, `:167`~`:189`, `:197`~`:203`, `:275`~`:281`, `:325`~`:331`, `:339`~`:345`다.

이는 `packages/core/src/queue/supervisor.ts:403`~`:423` 및 `packages/postgres/src/work.ts:458` 이후의 attempt 실패/일감 재시도 분리와 일치한다. 첫 실패가 일감의 terminal failure가 되기를 기다리던 원인은 해소됐다.

### R3-V2 — 정적 확인상 해결

회수 시험 `garmin-report.test.ts:222`~`:237`, `:254`~`:265`는 토큰을 직접 비운 뒤 원래 report 그룹 리더와 fake 모델 pid의 종료를 기다린다. 더 이상 lost attempt의 finished_at이 채워지기를 기다리지 않고, 해당 token의 finished_at이 NULL인지를 명시적으로 확인한다. 종료를 확인한 뒤 pending 보존·sidecar 부재·평가 미저장·후속 scope 미호출을 검사한다.

감독 launcher는 report를 detached 그룹 리더로 만들고, fake의 pgid는 그 report pid다. 따라서 여기의 두 pid 관찰은 report와 모델의 실제 생존 경계에 해당한다. `lockOpenSupervisedWork`와 정산 함수가 회수된 token을 갱신하지 않는 기존 계약(`packages/postgres/src/work.ts:332` 이후, `:458` 이후, `:764` 이후)과도 일치한다. 회수 후 정산되지 않는 행의 종료를 기다리던 원인은 해소됐다.

### R3-V3 — 정적 확인상 해결

fake `codex:14`, `:68`~`:70`은 감독 환경의 attempt token을 호출 장부에 기록한다. TS `Call`과 `waitCall()`도 이를 받아 work+attempt 또는 이전 attempt 제외 조건으로 호출을 선택한다(`garmin-report.test.ts:16`, `:48`~`:51`).

실제 daemon 사망 시험 `:285`~`:318`은 7d까지의 revision을 확인한 뒤 daemon을 SIGKILL하고 새 감독자를 시작한다. 사망 전 token의 `died`와 finished_at, 이전 모델·손자의 종료를 확인한 후 **같은 work의 다른 attempt**가 30d에 도달하기를 기다린다. 수동 enqueue는 제거됐다. 사망 전 호출 목록은 day/7d/30d, 자동 재개 attempt의 목록은 30d/all로 나누고 기존 revision 보존까지 검사한다.

이는 `packages/core/src/queue/supervisor.ts:135`~`:174`의 복구와 `packages/postgres/src/work.ts:332`~`:345`의 동일 열린 일감 재청구 계약을 그대로 관찰한다. 복구 전후 호출을 work id 하나로 섞거나, 자동 재개 완료 뒤 새 noop 일감을 비교하던 원인은 해소됐다.

## 남은 범위와 차단

위 R4-V1 외에 이번 수정 범위에서 추가로 입증한 실행 불가·검증 우회·수정 회귀는 없다. R3 세 건의 정적 처분과 별개로 R4-V1 수정이 남아 있으며 이 리뷰 작업에서는 수정하지 않았다. 검사 자체의 차단은 없고, 실제 시험 실행·통과 여부는 승인된 21.8에서 확인해야 한다. 임의 시험 요구나 제품 정책 변경 요구는 추가하지 않았다.
