# `test:changed` 실행 기록 v1

`pnpm test:changed [--base] [ref]`는 기존 선택과 명령을 실행하면서 각 실행의 스냅샷을 `.brain-test-changed/<UUID>.json`에 best-effort로 기록한다. 디렉터리는 Git에서 제외한다. 같은 디렉터리에 임시 파일을 쓴 뒤 rename하므로 JSON 파일은 직전 완전 스냅샷 또는 새 완전 스냅샷이다. 파일이 없거나 임시 파일만 남으면 관측이 없다는 뜻이다. 유효하지 않은 사용법은 기록 생성 전에 종료 코드 2로 끝나므로 기록이 없다. 기록 실패는 보고된 선택·명령·결과를 바꾸지 않으며 별도의 성공 보증이나 성능 캐시가 아니다.

19.9 소비자는 JSON의 `version`이 1인지 확인하고 `id`로 실행을 구분한다. `status`는 `incomplete`(종료 증거 없음), `completed`(runner 정상 종료), `failed`(runner 오류), `interrupted`(관측한 signal)다. `startedAt`, `endedAt`은 UTC ISO 문자열이고 `elapsedMs`는 monotonic 시계의 밀리초다. 시작 UTC와 monotonic 기준은 HEAD 조회 및 첫 스냅샷 전에 인접해서 채취하며 각 단계도 첫 스냅샷 전에 시작한다. 아직 관측하지 못한 값은 null이며, 누락된 단계도 성공을 뜻하지 않는다. SIGKILL 뒤에는 teardown 실행을 추론할 수 없다. `runnerExitCode`는 runner 결과이고 null은 signal 또는 미완료 등으로 코드가 관측되지 않았음을 뜻한다. `interruption`은 관측한 자식 signal의 `source: child`, `signal`, `stage` 또는 일반 실패의 `source: runner`, `stage`, `reason`을 담는다. runner에 직접 전달된 signal은 리스너를 추가하지 않아 기록하지 못할 수 있다. 이때 직전 스냅샷은 `incomplete`이고 signal과 runner 종료 코드는 null 또는 미관측으로 남으며, 자식 정리나 정상 종료를 추정해서는 안 된다.

`comparison`의 `ref`는 허용된 안전 값 또는 `[redacted]`, `baseSha`는 ref 검증 결과, `headSha`는 로컬 Git 메타데이터에서 읽은 HEAD다. SHA를 알 수 없으면 null이다. `inputs`는 중복 제거한 변경 경로이고 `selection`은 `default`, `postgres`, `python` 목록, `pythonMode` (`all`, `files`, `none`), `postgresAll`, `reasons`, 입력별 `inputReasons`, `pythonMissing`을 담는다. 선택 전 또는 목록 실행 전에는 각각 null일 수 있다. 목록은 실행 전 list가 반환한 파일의 관측 결과이며 실제 실행 완료 또는 개별 테스트의 성공 manifest가 아니다. 입력별 이유는 규칙과 migration/direct-file 표시이며, Python 직접 선택에서 존재하지 않는 파일은 `pythonMissing`으로 분리된다. 경로는 저장소 상대 안전 문자열 또는 `[redacted]`이므로 가려진 항목을 원래 이름으로 복원하거나 서로 같다고 추정하면 안 된다. 가림은 GitHub `ghp_`·`github_pat_` 등 알려진 credential 접두 형태와 일부 민감 경로 패턴을 포함하지만 임의의 불투명 문자열을 모두 비밀로 판별하지는 못한다. 환경, 자식 stdout/stderr, 오류 원문은 저장하지 않는다.

`stages`는 실제 진행 순서의 `name`, `status`, `startedAt`, `endedAt`, `elapsedMs`, 자식 `exitCode`, `signal`, `error`를 담는다. 실행 중은 `running`, 정상 종료는 `completed`, 자식 실패는 `failed`, 실행하지 않은 단계는 `skipped`다. 시작 실패의 `error`는 `spawn-error`, 캡처 출력 한도 초과는 `output-limit`, 그 밖의 프로세스 API 오류는 `process-error`이며 상세 메시지는 없다. 오류와 함께 반환된 `signal`은 자식 종료 신호를 원인으로 단정하지 않고 단계 관측값으로만 둔다. `reason`은 생략 사유(`no-selected-files`, `no-migration-change`, `direct-files`, `no-existing-files`, `no-matching-rule`, `prior-failure`)다. list 명령의 성공과 그 결과 JSON 처리 성공은 별개이며 이후 runner 실패를 함께 확인해야 한다. `exitCode`와 `signal`은 자식 관측치이며 runner 종료 코드와 혼동하면 안 된다.

단계 이름은 `build`, `verify-ref`, `git-committed`, `git-staged`, `git-unstaged`, `git-untracked`, `default-list`, `default-run`, `postgres-list`, `postgres-run`, `python-list`, `python-run`이다. Python 직접 파일 경로에서는 list를 실행하지 않는다. `tracer.files`는 기본 목록 중 이름에 tracer가 들어간 파일이고 `tracer.stage`는 `default-run`이다. tracer는 별도 실행이 아니므로 `timing: shared-stage`, `elapsedMs: null`로 표시하며 기본 단계 시간을 독립 tracer 비용으로 해석하지 않는다.

## 독립 시험 파일의 Python 선택 경계

다음 네 정확 경로만 `tooling/test-db/`와 `packages/postgres/`의 넓은 Python 전체 규칙에서 제외한다. 기본 Vitest `--changed`는 그대로이며 파일 존재 여부와 무관하게 분류한다. 다른 변경과 섞이면 각 경로를 따로 판정하므로 runtime이나 fixture가 있으면 Python 전체를 유지한다. 이름이 비슷한 파일이나 새 시험 파일은 자동으로 제외하지 않는다.

- `tooling/test-db/test/test-changed.test.ts`: 시험이 분류 규칙을 가져오고 config를 읽으며 runner와 list 자식을 호출한다. Python 진입점에서 이 시험 본문을 호출하는 역참조는 정적 조사에서 발견하지 못했다.
- `tooling/test-db/test/test-changed-record.test.ts`: 시험 자체가 runner·기록·규칙과 baseline fixture를 복사해 모의 자식을 실행한다. Python 진입점에서 이 시험 본문을 호출하는 역참조는 발견하지 못했다. 옆의 baseline 및 preload fixture는 제외하지 않는다.
- `packages/postgres/test/schedule-occurrences.test.ts`: 시험이 공통 fixture와 제품 소스를 가져오고 migration SQL을 임시 복사한다. Python이 시험 본문을 가져오거나 실행하는 역참조는 발견하지 못했다.
- `packages/postgres/test/user-keys.test.ts`: 시험이 공통 fixture와 제품 소스를 가져오고 과거 migration SQL을 임시 복사한다. Python이 시험 본문을 가져오거나 실행하는 역참조는 발견하지 못했다.

정적 경계는 Python config의 `apps/cli/python-test/**/*.test.ts`와 hook, global setup의 test-db cluster/lease 및 CLI `pg-home.ts`의 제품 postgres·동적 shim 연결을 포함해 확인했다. 기본 `vitest.config.ts`는 각 프로젝트의 시험과 source alias를 등록하며 두 패키지의 build tsconfig는 `src`만 포함한다. 공통 fixture·global setup·source alias·제품·설정·migration·자식 파일은 넓은 규칙을 유지한다. 반면 hook의 `snapshot`은 Git이 보는 tracked 및 비무시 untracked 파일을 포괄 복사하고 clone/install/build하므로 위 시험 파일 바이트도 간접적으로 읽힌다. 여기서 구별한 것은 복사 여부가 아니라 현재 설치·제품 빌드와 Python runtime이 독립 시험 본문을 의미 입력으로 실행하거나 소비하는지다. hook, 빌드 설정 또는 소비자가 바뀌면 이 판단을 다시 확인해야 한다.

기록 v1의 선택 비교는 같은 입력과 같은 모의 list 응답을 기준·후보에 공급해 해석할 수 있다. 후보만 바뀐 경우 Python 전체 선택의 차이와 이유를 확인하고, 인접 파일·혼합 입력은 기존 전체 선택이 유지되는지 살핀다. 모의 list 결과는 실제 실행 완료 목록이나 성능 측정이 아니며 위의 가림·공유 tracer 시간·미완료·기록 실패 제한이 그대로 적용된다.

추적할 코드 위치는 `apps/cli/python-test/vitest.config.ts`와 `apps/cli/python-test/global-setup.ts`, `apps/cli/test/pg-home.ts`, `packages/postgres/tsconfig.json`, `tooling/test-db/tsconfig.json`, `tooling/test-changed/vitest.config.aliases.mjs`다. 포괄 복사 및 snapshot commit은 `tooling/bootstrap/test/hook.test.ts`의 `snapshot`과 setup에 있다. 후보별 시험 본문의 import·파일 읽기·자식 호출 방향과 이 진입점의 역참조를 함께 보아야 하며, 공유 코드와 설정은 계속 전체 선택 대상이다.
