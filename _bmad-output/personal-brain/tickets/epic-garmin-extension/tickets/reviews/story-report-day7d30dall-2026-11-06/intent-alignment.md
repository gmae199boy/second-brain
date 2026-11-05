# 21.4 intent-alignment 정적 검토

검사 결과: 완료. 대상은 `/private/tmp/brain-214-review-r1.diff`의 unified diff이며, 연결된 현재 소스·시험 코드는 근거 확인에만 사용했다. 구현 계획과 다른 리뷰 결과는 판단 근거로 사용하지 않았다. 소스·계획 수정, 빌드, typecheck, 시험, fixture 생성, checker, 실제 모델·운영 호출, 추가 워커 실행은 하지 않았다. **시험 실행은 21.8로 이관, 미실행**이며, 미실행 자체는 승인된 유예다. 아래의 시험 설명은 코드가 무엇을 관찰하도록 작성됐는지를 뜻하며 통과 결과가 아니다.

## 1. 원래 의도의 방어 가능한 해석

1. **확장 실행 경계로 분석을 이식한다.** 옛 report 전체 명령을 그대로 노출하는 대신, report_input·body intake·모델 분석·평가 저장을 확장 supervised 일감에서 실행한다. 결과 파일 등록·발송은 명시적으로 21.5에 속한다. 따라서 기존 보고서 조립·발송까지 이번 diff에 있어야 한다는 해석은 원문의 범위 제한과 맞지 않는다.
2. **day→7d→30d→all은 순서 있는 독립 scope다.** 각 scope를 순서대로 시도하고 성공을 즉시 저장하며, 실패한 scope가 있어도 뒤 scope의 성공을 남길 수 있다. 다음 실행은 날짜·계정·scope별 저장 성공을 건너뛴다. 이 해석에서 “오늘 day가 있으면 건너뜀”은 day 재호출 생략이지 전체 일감 생략은 아니다.
3. **day→7d→30d→all은 성공 접두부를 잇는 단계다.** 화살표와 “7d 저장 직후 … 30d·all만”을 단계 의존으로 읽으면, 앞 단계 실패 시 뒤 단계는 아직 진행하지 않고, 재개는 마지막 연속 성공 뒤부터 시작한다. 원문에는 실패한 중간 scope 뒤를 계속할지 명시되어 있지 않아 2와 3을 문구만으로 단정할 수 없다.
4. **재개와 재생성은 별개다.** 일반 실행은 이미 저장된 성공을 재사용하고 명시적 재생성은 새 revision을 추가한다. 더 강하게는 재생성 실행도 하나의 새 세대를 이루어, 그 세대가 중단되면 같은 세대의 저장 성공부터 이어야 한다고 읽을 수 있다. 원문은 재생성의 revision 보존은 명시하지만 세대 식별·부분 재생성 재개는 명시하지 않는다.
5. **체성분 실패의 보존 범위에는 두 해석이 있다.** “실패하면 pending”을 모든 사진→측정 변환 실패에 적용하면 흐린 사진·측정일 누락도 pending에 남아야 한다. 옛 body intake 동작 보존을 함께 읽으면 판독 불가는 명시적으로 reject하고, 모델 실행·명령·JSON 검증 실패만 pending에 남기는 해석도 가능하다.
6. **검증 경계는 실제 감독 실행과 영속 저장이다.** “감독자를 죽이고 다시 띄우면”은 함수 재호출이나 자식 작업 종료보다 넓은 daemon 생명주기를 가리킨다. “사진 → 검증된 측정 JSON”은 모델 출력의 형식 검증과 파일 처리 경계를 포함한다. fake CLI라는 조건상 시각 인식 품질 자체까지 입증한다는 뜻으로 읽을 수는 없다.

## 2. diff가 구현한 해석

diff는 해석 1·2 및 해석 4의 약한 형태를 구현한다. `manifest.json:187`부터 `garmin.report`와 `garmin.report_regenerate`를 supervised Python entry `src/report.py`에 연결한다. `src/report_runtime.py:108`의 `run`은 선택 계정 바인딩·report 세션 잠금 아래 `report.run_supervised`를 부른다. 기존 `report.run`의 그래프·최종 보고서·발송 흐름을 그대로 호출하지 않는다.

`src/garmin_pipeline/report.py:1095`의 새 실행 경로는 일반 실행에서 최신 평가가 있는 scope 집합을 읽고 나머지를 고정 순서로 시도한다. 각 성공 직후 `_save_evaluation`을 호출하고 scope 실패에는 `continue`한다. 모든 scope가 이미 있으면 intake 전에 noop이다. `regenerate=True`면 기존 성공 집합을 읽지 않고 네 scope 전부를 다시 시도한다. 즉 날짜·scope별 성공 집합을 이어가며, 하나의 연속 성공 접두부나 재생성 세대를 추적하지 않는다.

평가 이력 저장은 이번 diff가 SQL을 새로 만드는 방식이 아니다. 기존 `store.append_evaluation`과 기존 `garmin.evaluation` 최신 view를 사용한다(`store/__init__.py:364`, `migrations/0014_native_store.sql:344`). 새 경로의 `_save_evaluation`은 이 기존 append 계약에 연결된다. 모델은 `start_new_session=False`로 감독 작업의 프로세스 그룹을 상속하며, 직접 자식 회수는 Python, 공유 그룹 정리는 기존 감독자가 맡는 구조다(`report.py:376`). `garmin.analysis_*`는 snapshot 검증을 거쳐 Config로 전달된다(`report_runtime.py:21`, `:55`).

body는 PG의 계정·attempt fence로 파일 명령을 보호하고, 검증된 측정은 계정별 JSON sidecar로 쓴다(`body_runtime.py:13`). 따라서 “PG 위에서 돌린다”를 계정·일감·평가의 PG 실행 경계로 읽으면 부합한다. 측정 JSON 자체도 PG 행으로 저장한다는 더 강한 해석은 이 diff의 저장 표면과 다르며, 원문만으로 그런 추가 저장 요구를 확정할 수 없다.

## 3. 의도·구현·시험이 만나는 표면과 갈라지는 지점

### IA-1 — 감독자 재시작 후 scope 재개의 결합 시나리오는 작성된 시험에서 분리되어 있다

원문 기대는 **7d 저장 → 감독자 사망 → 새 감독자 시작 → 30d·all만 실행**이라는 하나의 생명주기 경계다.

`apps/cli/python-test/garmin-report.test.ts:52`는 실제 설치 manifest·CLI enqueue·daemon·fake 모델·PG를 사용한다. 그러나 7d 저장 뒤 30d에서 멈춘 상태에서 죽이는 대상은 `work_attempts.pgid`의 **작업 프로세스 그룹**이다(`:61`). daemon은 계속 살아 있고 새 report 일감을 enqueue한다(`:63`). 이 시험이 직접 관찰하는 것은 기존 감독자 안에서 작업이 죽은 뒤 새 작업이 저장된 scope를 재사용하는 경계다.

같은 파일 `:146`은 실제 daemon을 SIGKILL하고 새 감독자를 시작하지만, day 모델 대기·평가 0행 상태에서 손자까지 정리되는지만 관찰한다(`:152`~`:160`). 7d 저장 후 재시작과 scope 호출 목록을 함께 관찰하지 않는다. 두 시험은 유용한 서로 다른 경계를 다루지만, 두 결과를 합친다고 원문의 결합 시나리오를 실행한 증거가 되지는 않는다. 소스에는 영속 최신 평가를 읽는 재개 경로가 있으므로, 이 차이만으로 복구 기능이 고장났다고 판정하지 않는다.

### IA-2 — “실패하면 pending”의 넓은 해석과 판독 불가 입력 처리 사이에 실제 동작 차이가 있다

JSON 쓰기 거부에는 pending 보존이 구현되어 있다. `tests/test_body_runtime.py:71`은 중복 키·미지 키·NaN 거부 후 pending 유지와 후속 정상 쓰기를 기술한다. 감독 통합 시험 `garmin-report.test.ts:89`도 fake 모델이 NaN payload를 body write에 전달해 원본 파일이 남는 경계를 관찰한다.

반면 새 배포 skill `skills/garmin-body-intake/SKILL.md:75`는 흐리거나 잘린 이미지, 측정일·연도 누락, 측정값 없음 등을 `reject` 대상으로 정한다. `body_runtime.py:35`가 기존 `body.reject`를 호출하면 `unreadable/`로 이동하고, pending은 inbox 바로 아래 일반 파일만 열거한다(`garmin_pipeline/body.py:226`, `:254`). `tests/test_body_runtime.py:91`은 reject된 입력이 pending에서 빠지는 동작을 명시적으로 기대한다.

따라서 “모든 변환 실패의 pending 보존”과는 다르고, “판독 불가의 명시적 reject와 실행·검증 실패의 재시도 보존”에 해당한다. 이는 단순 미실행 공백이 아니라 코드·skill·시험이 함께 선택한 실패 분류다. 판독 불가를 처리 완료로 본 최종 skill 응답은 `ok`일 수도 있다(`SKILL.md:88`).

### IA-3 — 사진 검증의 시험 표면은 시각 내용과 측정값의 대응이 아니라 JSON 명령 경계다

`tests/report-fixture/codex:30`은 이미지 바이트나 배포 skill을 해석하지 않고 pending 파일마다 고정 날짜 `2020-01-02`와 고정 `{weight_kg:70}` 또는 NaN을 `body_runtime.py write`에 전달한다. `garmin-report.test.ts:100`의 기대값도 이 상수다. 실제 Codex argv의 이미지 첨부는 `tests/test_report_process.py:22`에서 별도로 검사한다.

따라서 작성된 시험의 관찰 범위는 첨부 인자, fake CLI의 body 명령 호출, schema 거부, sidecar 게시, processed 이동이다. 사진에 적힌 날짜·값을 정확히 읽는지, 배포 skill의 판독 불가 분류를 따르는지는 관찰하지 않는다. fake CLI를 요구한 원문과 일치하는 한계이며, 실제 OCR·모델 품질 검증이 있다는 주장으로 확장할 수 없다. 고정 SQLite oracle과의 측정 비교도 원본 measurement JSON의 schema 수락 여부이지 사진 인식 비교는 아니다(`tests/test_report_input_pg.py:209`).

### IA-4 — scope의 순서는 호출 순서이며 성공 단계 의존은 아니다

`report.py:1135`의 실패 분기는 다음 scope로 계속한다. `tests/test_report_supervised.py:62`는 30d 실패 뒤 all 저장, 다음 일반 실행에서 30d만 호출하기를 기대한다. `garmin-report.test.ts:182`도 7d 실패 또는 잘못된 JSON 뒤 day·30d·all 저장과 다음 실행의 7d 단독 재시도를 기술한다.

이 동작은 해석 2에 직접 부합하며, 해석 3과는 다르다. 정상 경로의 day→7d→30d→all 시도 순서와 성공 즉시 저장은 존재한다. 다만 실패를 포함한 전체 이력에서 성공 저장 순서가 언제나 day→7d→30d→all인 것은 아니다. 원문에 실패 시 중단 규정이 없어 확정 결함으로 분류하지 않는다.

### IA-5 — 재생성은 새 전체 실행이며, 부분 재생성 전용 재개 상태는 없다

재생성은 `report.py:1104`에서 `completed=set()`으로 시작한다. 예전 네 scope의 revision이 있는 상태에서 새 재생성이 day·7d만 저장하고 중단된 경우, 일반 report는 예전 revision까지 성공으로 보기 때문에 나머지 새 30d·all을 구분하지 못한다. 다시 regenerate하면 day부터 전부 재호출한다. 이는 코드에서 도출되는 상태 모델이며 실행 관찰 결과는 아니다.

작성된 시험은 전체 재생성 후 이전 평가 보존(`garmin-report.test.ts:68`)과 재생성 scope 실패 시 이전 revision 유지(`tests/test_report_supervised.py:79`)를 다룬다. 중단된 재생성의 동일 세대 재개는 관찰하지 않는다. 원문의 “새 revision + 이전 평가 보존”은 구현되어 있고, 해석 4의 강한 세대 재개 기대만 이 표면 밖에 있다.

### IA-6 — 이력 추가는 관찰하지만 최신 view의 값 선택은 새 통합 시험에서 좁게 관찰한다

`garmin-report.test.ts:70`은 revision 행 수가 4→8이고 이전 `(scope,revision,report_md)`가 남는 것을 검사한다. 이어 최신 view 쿼리는 scope별 `count(*)`를 구한 결과의 **배열 길이 4**만 검사한다(`:72`). 각 count가 1인지, 최신 revision 값인지 검사하지 않으며 fake 모델의 같은 scope 재생성 출력도 같은 문자열이다.

따라서 새 통합 시험은 append·이전 행 보존을 직접 관찰하지만 “최신 view가 최신 평가 내용을 선택한다”는 원문 기대를 그 assertion으로 모두 판별하지는 못한다. 기존 view 정의에는 계정·날짜·scope별 `distinct on` 및 revision 내림차순 선택이 존재한다. 이를 현재 SQL 결함이라고 기술하지 않으며, 이번 diff가 새로 추가한 시험 증거의 경계로 기록한다.

## 4. 정렬된 부분과 판정 한계

모델 실행 중 트랜잭션을 유지하지 않는 기대는 단순 mock에만 머물지 않는다. 기존 store는 쓰기 연결을 autocommit으로 열고 report lock을 세션 잠금으로 유지한다. 새 실행 경로는 계정 검증·사전 fence·input read를 모델 호출 밖에서 끝낸다. `garmin-report.test.ts:77`과 `garmin-report-observer.ts:8`은 실제 fake 모델 day 대기 중 extension role의 `xact_start`가 있는 연결 수 0을 관찰하도록 작성됐다. body 명령의 짧은 검증·파일 작업 트랜잭션까지 금지한다는 뜻은 아니며, 장시간 모델 대기와는 다른 경계다.

취소의 손자 정리도 실제 감독 CLI 경계를 다루는 시험이 있다(`garmin-report.test.ts:105`). Python 단위 시험이 직접 자식만 회수하고 그룹에는 신호를 보내지 않는다는 사실만으로 손자 누수를 단정할 수 없다. 이 diff의 소유권은 기존 감독자의 공유 그룹 정리까지 포함한다. timeout·daemon 사망 시험도 별도로 작성되어 있다.

입력 이식은 `test_report_input_pg.py:145`부터 PG와 독립 SQLite subprocess가 같은 고정 합성 입력을 소비하고 파일·JSON·digest·prompt·schema를 비교하도록 작성됐다. 이는 모델이 입력을 해석한 최종 평가 내용의 동등성보다 아래 표면의 비교다. 21.5로 명시된 결과 파일 등록·발송 부재와 승인된 21.8 시험 미실행은 이번 검토의 결함으로 계산하지 않았다. 이번 정적 검토 자체의 실패나 접근 차단은 없었다.
