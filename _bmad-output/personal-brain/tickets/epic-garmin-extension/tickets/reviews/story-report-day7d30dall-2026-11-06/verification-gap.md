# 21.4 thorough verification-gap 리뷰

지정된 `verification-gap.md` 지시와 `/private/tmp/brain-214-review-r1.diff` 전체를 읽고 변경된 실행 경계와 시험 코드를 정적으로 대조했다. 문서·skill 본문·설정 및 타입만의 변경은 지시의 screen 규칙에 따라 시험 공백 대상으로 삼지 않았다. 소스·계획 수정, build, typecheck, 시험, fixture 생성, checker, 실모델·운영 호출 및 추가 워커 실행은 하지 않았다. 시험 실행은 **21.8로 이관, 미실행**이며 승인된 유예 자체를 발견사항으로 삼지 않았다.

### 기간 분석에 전달되는 실제 입력 폴더와 프로필을 검증하지 않는다

- **Changed surface:** 새 `run_supervised`가 기간 입력을 만들고 계정 runtime 기준 상대 경로와 프로필 경로를 모델에 전달한다. `extensions/garmin/src/garmin_pipeline/report.py:1130`.
- **Impacted consumer or site:** `_evaluate` → `CodexWriter.period` → `codex_prompt`가 이 경로를 기간 모델의 읽기 대상으로 사용한다. `extensions/garmin/src/garmin_pipeline/report.py:1004`, `extensions/garmin/src/garmin_pipeline/report.py:307`.
- **Existing test evidence:** `extensions/garmin/tests/test_report_supervised.py:33`의 writer는 `inputs`를 사용하지 않고 scope만 기록한다. 같은 파일 `:48`은 입력 builder와 JSON 쓰기를 대체한다. 실제 감독 통합 시험의 fake 모델도 `extensions/garmin/tests/report-fixture/codex:14`에서 skill 접두사로 scope만 판별하고, `:43`에서 입력을 읽지 않은 합성 결과를 반환한다. `apps/cli/python-test/garmin-report.test.ts:42` 이후 assertion은 scope 호출·평가행·재개를 확인하며 기록된 argv의 입력 경로와 파일 내용은 확인하지 않는다. 독립 oracle 시험 `extensions/garmin/tests/test_report_input_pg.py:197`은 builder를 직접 호출하고 `:210`은 하드코딩한 경로로 프롬프트를 비교하므로 `run_supervised`의 연결은 거치지 않는다. 저장 시험 `extensions/garmin/tests/test_report_store_pg.py:74`도 inputs를 관찰하지 않는다. 저장소에서 `run_supervised`, `CodexWriter`, `report-input`, `profile.md`, `inputs`, `prompt`의 시험 참조를 검색하고 위 Python 시험 및 Garmin TS 통합 시험까지 확인했다.
- **Missing verification:** 실제 감독 실행에서 각 기간 모델에 전달된 첫 경로가 해당 scope의 `scope.json`·`day_values.json`·`evaluations.json`을 가진 폴더인지, 두 번째 경로가 선택 계정의 내보낸 프로필인지 확인하는 assertion이 없다.
- **Demonstration:** 기간 inputs를 만드는 부분이 실수로 `folder` 대신 `exported.path`를 전달하면 7d·30d·all 프롬프트는 기간 폴더 대신 하루 입력 루트를 가리킨다. 현재 fake는 접두사의 scope만 읽으므로 네 scope 성공·재개·revision assertion은 그대로 만족하고, 독립 builder/oracle 비교도 영향을 받지 않는다.
- **Consequence:** 기간 모델이 요청한 기간 파일을 찾지 못하거나 다른 범위 데이터를 읽는 연결 오류가 시험에 잡히지 않는다.
- **Disposition:** `apps/cli/python-test/garmin-report.test.ts`에 감독 입력 전달 시험 한 건을 추가한다. 선택 계정의 구별 가능한 합성 프로필·데이터를 준비하고 fake가 실제 prompt 경로를 runtime cwd에서 열어 scope와 프로필 표식을 결과에 반영하게 한 뒤, 각 scope의 저장 결과가 해당 입력 표식을 갖는지 확인한다. helper의 프롬프트 문자열 비교만으로 대신하지 않는다.

### 기본 CodexWriter의 ABI progress 자동 연결을 검증하지 않는다

- **Changed surface:** ABI 환경에서는 기본 생성자가 `_abi_progress`를 선택하고 `_execute`가 이를 `_run`에 전달하여 모델 대기 중 progress를 출력한다. `extensions/garmin/src/garmin_pipeline/report.py:298`, `extensions/garmin/src/garmin_pipeline/report.py:364`.
- **Impacted consumer or site:** 실제 감독 실행은 `extensions/garmin/src/report_runtime.py:120`에서 콜백 없이 `CodexWriter()`를 생성한다. 감독자는 progress를 작업 진행으로 관찰하며, 무진행 시간이 stall window에 도달하면 작업을 중단한다. `packages/core/src/domain/work-item.ts:169`, `packages/core/src/queue/supervisor.ts`.
- **Existing test evidence:** `extensions/garmin/tests/test_report_process.py:35`는 `_run` 정적 메서드에 `progress=Mock()`을 직접 넣으며, `:46`은 `_abi_progress`를 별도로 호출한다. 따라서 생성자의 자동 선택과 `_execute` 전달을 둘 다 우회한다. 실제 Garmin 통합 시험의 명시적 timeout은 `apps/cli/python-test/garmin-report.test.ts:135`의 1분이고, 성공 시험들도 stall window를 넘는 모델 대기 및 progress 출력을 확인하지 않는다. `packages/core/test/supervisor-stall.test.ts:43`은 fake child에 progress 문자열을 직접 넣어 감독자만 검증한다. 저장소 전체에서 `CodexWriter`, `_abi_progress`, `run_supervised` 참조를 검색한 뒤 이 시험들을 재확인했다.
- **Missing verification:** `BRAIN_ABI_VERSION=1`인 환경에서 기본 `CodexWriter().write` 또는 `period`를 호출했을 때 대기 간격 뒤 실제 stdout에 ABI progress가 나오는 assertion이 없다.
- **Demonstration:** 기본 생성자의 콜백 선택이 `None`으로 바뀌거나 `_execute`가 `progress=self.progress` 전달을 빠뜨리면 실제 report는 긴 모델 대기 중 progress를 내지 않는다. 직접 콜백을 전달하는 단위 시험과 helper 출력 시험은 여전히 통과하고, 짧은 통합 실행도 이 누락을 드러내지 않는다.
- **Consequence:** 정상적인 장시간 분석이 감독자의 무진행 판정으로 중단될 수 있다.
- **Disposition:** `extensions/garmin/tests/test_report_process.py`에 기본 writer의 공개 메서드를 통과하는 시험 한 건을 추가한다. ABI 환경과 합성 runtime을 준비하고 Popen 대기·시계를 제어하여 대기 간격을 넘긴 뒤, 캡처한 실제 stdout의 JSON 이벤트가 progress이며 모델 stream 내용은 포함하지 않는지 확인한다. 콜백 호출 횟수만 확인하는 시험으로 대신하지 않는다.

추가로 확정하여 보고할 비공백 결함은 없다. 위 내용은 정적 검토 결과이며 시험 실행 성공을 주장하지 않는다.
