- 발견사항 하한 계산: diff 129,648 bytes ÷ 1,000 = 129.648 kB, N = min(floor(√129.648 + 1), 10) = min(12, 10) = 10. 아래는 정적 소스·시험 코드로 확인한 수정·보완 항목 10개다. 빌드·typecheck·시험·fixture 생성기·checker·실모델·운영 호출은 수행하지 않았다. 시험 실행은 **21.8로 이관, 미실행**이며 승인된 유예 자체는 발견사항에 포함하지 않았다.

- 모델 미설정을 실행 준비 단계에서 거르지 않는다. `extensions/garmin/manifest.json`의 두 report 작업은 timezone만 필수이고 `garmin.analysis_model`에는 기본값도 없다. `src/report_runtime.py:80`은 이를 `None`으로 만들지만 `src/garmin_pipeline/report.py:322`는 반드시 모델을 요구한다. 따라서 manifest 기준으로 준비된 신규 설정이 실제로는 네 범위 모두 실패하며, entry에서는 재시도 가능한 `REPORT_FAILED`로 귀결된다. 모델을 필수 설정으로 선언하거나 명시적인 기본값을 정하고, 설정 누락이 반복 실행 실패로 변하지 않는 경계를 시험해야 한다.

- 계정 시간대와 하루 분석 스킬의 시각 지시가 충돌한다. `extensions/garmin/src/report_runtime.py:70`은 임의의 유효한 계정 timezone을 받아 입력 manifest도 그 시간대를 기록하지만, `skills/garmin-daily-analysis/SKILL.md:59`와 `:228`은 GMT를 무조건 UTC+9로 바꾸고 한국 시각으로 출력하라고 한다. 예를 들어 UTC 계정에서 일자와 운동 창은 UTC인데 서술 시각만 9시간 이동한다. 스킬이 manifest timezone을 따르도록 하고 UTC·DST 시간대의 정적 계약 사례를 추가해야 한다.

- 한 범위의 모델 시간 초과 뒤 손자 프로세스가 다음 범위와 겹쳐 살아 있을 수 있다. `extensions/garmin/src/garmin_pipeline/report.py:220`의 `_end_child`는 직접 자식만 종료하며, `:1134` 이후는 실패해도 나머지 범위 모델을 계속 실행한다. 감독자의 공유 그룹 정리는 전체 report 프로세스가 끝난 뒤이므로, 종료된 day 모델의 살아 있는 도구 프로세스가 7d·30d·all 동안 같은 attempt 환경과 계정 파일을 계속 사용할 수 있다. `apps/cli/python-test/garmin-report.test.ts:140`도 전체 작업 실패 뒤에만 손자 종료를 확인한다. 다음 범위를 hold한 상태에서 이전 범위의 자손이 이미 사라졌는지 검증하고, 범위 단위 정리 또는 안전한 중단 정책을 마련해야 한다.

- intake 성공을 모델의 자기 보고만으로 확정한다. `extensions/garmin/src/garmin_pipeline/report.py:1118`은 `status == 'ok'`만 확인하고 최초 pending 입력이 실제 처리·거부됐는지 다시 확인하지 않는다. 모델이 명령을 생략하고 스키마에 맞는 성공 JSON만 반환해도 네 평가가 저장되며, 다음 일반 실행은 `:1105`에서 noop이 되어 남은 입력을 다시 보지 않는다. 최초 pending 집합의 잔존 여부를 호스트가 확인하고, 아무 파일 작업 없이 성공만 반환하는 writer 사례를 추가해야 한다.

- 실제 Codex sandbox 안에서 body 명령이 DB에 접근하는 경계가 시험에서 빠져 있다. 제품 `codex_argv`는 `workspace-write`를 지정하고, 새 body 스킬은 그 sandbox 안에서 확장 venv·`body_runtime.py`를 실행하도록 한다. 이 명령은 `body_runtime.execute`에서 PostgreSQL 연결과 attempt fencing을 요구한다. 그러나 `tests/report-fixture/codex:33`은 sandbox 없이 호스트 subprocess로 명령을 실행한다. 따라서 현재 시험 코드는 sandbox의 확장 경로 읽기·환경 전달·DB 접속 허용 여부를 검증하지 못한다. 실제 모델 호출 없이 재현 가능한 sandbox 실행 계약 검증을 21.8에 명시해야 하며, 이 리뷰만으로 그 경계가 동작한다고 판정할 수 없다.

- 두 계정의 분석 입력 격리 검증이 비어 있는 원본 데이터에 의존한다. `apps/cli/python-test/garmin-report.test.ts:32`는 계정 연결만 만들고, `:77`의 격리 시험은 각 계정 revision 개수와 대기 상태만 비교한다. fake 모델도 입력 파일을 읽지 않고 항상 동일한 synthetic 본문을 반환한다. 원본 조회에서 connection 조건이 빠져 다른 계정의 건강 데이터가 프롬프트에 섞여도 이 시험은 잡지 못한다. 계정별로 구별되는 raw·정규화 값·과거 평가·body를 넣고 실제 모델 입력 폴더의 상호 배제를 확인해야 한다.

- 기존 평가가 있는 재생성 실패를 실제 감독·PG 경계에서 검증하지 않는다. `apps/cli/python-test/garmin-report.test.ts`는 성공 재생성과 최초 실행의 7d 실패를 각각 다루지만 둘을 결합하지 않는다. `tests/test_report_supervised.py`의 실패 재생성 사례는 `_save_evaluation`을 메모리 딕셔너리로 대체한다. 기존 revision이 있는 상태에서 재생성의 일부 범위가 실패할 때 PG의 과거 revision과 latest view가 보존되는지, 성공 범위만 append되는지 실제 감독 시험을 추가해야 한다.

- body 취소 보존 시험이 파일 공개 뒤의 중단 구간을 덮지 않는다. `extensions/garmin/tests/test_body_runtime.py:106`은 `_atomic_write` 자체가 시작부터 예외를 내도록 하고, 감독 시험의 intake 취소도 body 명령 전 hold에서 발생한다. 실제 `body._write`는 sidecar를 교체한 다음 source들을 차례로 이동하므로 교체 직후나 여러 source 중 첫 이동 뒤 취소될 수 있다. DB transaction은 이 파일 변경을 되돌리지 않는다. 해당 중단점을 주입하고 다음 실행의 pending·기존 값 병합·source 이동이 어떤 상태로 복구되는지 확인해야 한다.

- fake Codex가 설치된 스킬을 사용하지 않아 스킬 배포 회귀를 놓친다. `extensions/garmin/tests/report-fixture/codex:14`는 prompt 접두어만 보고 작업 종류를 정하고, 알 수 없는 prompt도 `day`로 처리한다. `.agents/skills`의 존재·내용·선택된 계정 workspace를 읽지 않으므로 daily 스킬 누락이나 잘못된 호출 이름이 감독 통합 시험에서 성공할 수 있다. fake가 요청한 스킬 파일과 실행 cwd, 필수 명령 계약을 확인하고 알 수 없는 호출에는 실패하도록 보완해야 한다.

- 모델이 유효한 JSON으로 `status: 'failed'`를 반환하는 감독 사례가 없다. `apps/cli/python-test/garmin-report.test.ts`의 마지막 `it.each(['fail','invalid'])`는 비정상 종료와 JSON 문법 오류를 다루며, `tests/report-fixture/codex:43`의 분석 결과는 항상 `status: 'ok'`다. Python 순서 시험의 실패 writer도 예외만 던진다. 스키마는 failed 상태도 허용하므로, 정상 종료·유효 스키마·failed 상태가 revision을 남기지 않고 다음 범위는 계속하며 재실행은 해당 범위만 처리하는지 별도로 확인해야 한다.
