# 21.4 R2 검증 공백 후속 리뷰

지정된 리뷰 지시와 `/private/tmp/brain-214-review-r2.diff`의 변경을 읽고, 현재 감독 entry → runtime → 분석 writer 및 body IPC 경계와 관련 시험을 정적으로 대조했다. 문서·skill 본문 등 정적 텍스트 자체는 검증 공백 대상에서 제외했다. 코드·계획 수정, 시험·fixture 생성·checker·build·typecheck·실모델·운영 호출 및 추가 워커 실행은 하지 않았다. 시험 실행은 **21.8로 이관, 미실행**이며 승인된 미실행 자체를 결함으로 세지 않았다. 검사 수행을 막은 차단은 없었으며, 아래는 실행 성공 증거가 아닌 정적 검사 결과다.

이전 검증 공백 두 건은 다음 시험 코드로 보완됐다. 기간 입력 전달은 `apps/cli/python-test/garmin-report.test.ts:93`의 계정별 입력 시험과 `extensions/garmin/tests/report-fixture/codex:42`의 실제 기간 폴더·프로필 읽기가 해당 scope 확인 및 저장 결과까지 관찰한다. 기본 progress 연결은 `extensions/garmin/tests/test_report_process.py:88`에서 ABI 환경의 `CodexWriter().write()`를 통과하며, 기다림 뒤 실제 stdout의 progress JSON과 모델 stream 비노출을 확인한다. 따라서 이전 두 건을 그대로 재등록하지 않는다.

### 감독 분석이 계산한 digest를 모델 입력 파일로 전달하는 연결을 검증하지 않는다

- **Changed surface:** 새 `run_supervised`는 내보낸 계정 입력에서 digest를 계산하고, 하루 모델에 전달할 폴더의 `digest.json`에 기록한다. `extensions/garmin/src/garmin_pipeline/report.py:1205`와 `:1208`.
- **Impacted consumer or site:** 같은 함수 `:1213`의 하루 입력 폴더가 `_evaluate` → `CodexWriter.write`를 통해 모델에 전달된다. 패키지의 하루 분석 계약은 이 폴더의 digest를 우선 읽고 리포트 숫자를 가져오도록 한다(`extensions/garmin/skills/garmin-daily-analysis/SKILL.md:26`, `:39`). 여기서 검사하는 것은 LLM 출력이나 skill 문구가 아니라 코드가 계산 결과를 소비 경로에 게시하는 연결이다.
- **Existing test evidence:** `extensions/garmin/tests/test_report_supervised.py:54`와 `:55`는 JSON 쓰기와 digest 계산을 각각 mock 처리하며 파일 내용을 확인하지 않는다. 실제 감독 통합 fake의 하루 분기 `extensions/garmin/tests/report-fixture/codex:34`는 manifest·raw·body·이전 평가만 읽고 digest는 열지 않는다. `apps/cli/python-test/garmin-report.test.ts:115`와 `:126`은 이 `observed` 및 저장 결과를 비교하므로 digest 게시 결과는 관찰 대상에 없다. 독립 oracle 시험 `extensions/garmin/tests/test_report_input_pg.py:198`은 digest 파일을 fixture 문자열로 직접 쓰고, `:215`는 `digest.build`의 반환값을 별도로 비교한다. 따라서 이 시험도 감독 경로의 계산 → 파일 게시 연결을 통과하지 않는다. 저장소 전체에서 `CodexWriter`, `run_supervised`, `digest.json`을 검색하고 Garmin Python 시험·oracle child 및 CLI Python 통합 시험의 관련 참조를 확인했다.
- **Missing verification:** 실제 감독 실행에서 하루 모델이 전달받은 폴더의 `digest.json`을 열어, 선택 계정의 구별 가능한 합성 측정값이 계산되어 들어 있음을 확인하는 assertion이 없다.
- **Demonstration:** 감독 경로가 계산 결과 대신 빈 객체를 `digest.json`에 기록하는 회귀가 생기면, 하루 모델은 필수 측정값이 없는 입력을 받는다. 현재 fake는 해당 파일을 읽지 않으므로 호출 순서·raw/body 계정 격리·저장 결과 assertion은 그대로 만족한다. 독립 oracle 비교는 감독 경로를 호출하지 않고 fixture digest와 계산 반환값을 각각 확인하므로 이 회귀에 영향받지 않는다.
- **Consequence:** digest 계산 함수와 입력 builder가 각각 올바르더라도, 감독 하루 분석에는 측정값이 누락된 파일이 전달되는 변경이 시험에 잡히지 않는다.
- **Disposition:** `apps/cli/python-test/garmin-report.test.ts`의 계정별 실제 입력 시험 한 건을 확장한다. fake가 하루 입력의 `digest.json`을 읽어 결과에 반영하게 하고, 저장된 하루 결과에 각 계정의 알려진 body 측정값 등 구별 가능한 digest 값이 들어 있음을 단언한다. 기대값을 같은 실행의 제품 digest 출력에서 다시 만들지 않는다.

추가로 확정하여 보고할 비공백 결함은 없다. 위 검증 공백의 시험 보완과 실제 시험 실행은 지휘자가 triage하며, 실행은 승인된 21.8 범위를 따른다.
