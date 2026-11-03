# 16.4 후속 독립 의도 정합성 검사

검사 완료. 입력 `/tmp/brain-16-4-final-review.diff`와 현재 관련 제품·시험 코드를 읽기 전용으로 추적했다. 빌드·시험·생성 스크립트 실행, 외부 계정·운영 데이터·비밀 접근, 추가 워커 시작은 하지 않았다. 이 보고서만 작성했으며 다른 리뷰어·이전 리뷰 보고서와 지휘자 체크포인트는 읽거나 수정하지 않았다. 따라서 아래 시험 근거는 시험 코드가 무엇을 관찰하도록 작성됐는지에 관한 것이며 실행 통과 판정은 아니다.

전체 baseline diff의 별도 자동화·다른 에픽 변경은 16.4 결함으로 계산하지 않았다. 이번 후속 변경의 날짜 후보 제한, dirty generation, snapshot 예약, watermark, 0008→0009 복구 및 발행 계약 시험을 현재 실행 경로와 함께 검토했다.

## 1. 방어 가능한 의도 해석

1. **계산 의미 보존 해석.** 옛 SQLite 표 전체를 새 DB에 그대로 복제하는 요구가 아니라 daily/activity 파서 및 `digest.day_values`의 수치·NULL·샘플·세트·날짜 의미를 유지하고, 계산 결과를 기존 catalog를 통해 건강 관찰 행으로 투영한다. 고정 fixture 동등성의 직접 비교 대상은 옛 표 모양의 계산 결과다.
2. **제품 경로 전체의 동등성 해석.** 문제와 I/O 표를 함께 읽으면 실제 `collect`/`garmin.normalize` 실행으로 생성되는 건강 행과 `health_current_v1`도 그 계산 의미를 보존해야 한다. 같은 키, 권위, 재발행, 실패 격리와 중단 복구는 순수 함수의 반환값만으로 성립하지 않는다.
3. **입력 dataset의 엄격한 경계 해석.** “이전 dataset의 raw는 다시 정규화하지 않는다. 대상은 수집 dataset뿐”은 계산 입력의 출처도 `collect-…`로 제한한다. imported raw를 읽어 새 collect 건강 행을 계산하는 것 역시 재정규화다.
4. **발행 대상의 경계 해석.** 같은 문장을 대상 항목·날짜와 출력 dataset의 경계로 읽으면, 수집한 날짜를 집계할 때 계정 전체의 기존 raw를 보조 입력으로 쓸 수 있다. 기존 imported dataset을 변경하거나 imported-only 날짜를 새로 발행하지 않는 것이 핵심이다. 단, 이는 3번보다 금지 문구를 좁게 읽는 해석이다.
5. **NULL의 범위 해석.** “성공한 항목의 소유 열을 모두 발행하고 NULL도 행으로 낸다”를 모든 성공 응답에 적용하면 최초 raw `null`도 소유 열의 NULL 행을 낸다. 반면 “옛 원본 그대로”를 우선하면 옛 정규화에서 대상 행을 만들지 않는 최초 NoData는 제외하고, 생성된 행의 NULL 열을 빠짐없이 발행한다.

1·2는 서로 보완적이고, 3·4 및 5의 두 경우는 경계가 다른 해석이다.

## 2. diff가 실제 구현한 해석

계산은 1번, 발행과 복구는 2번을 지향하되, 입력 경계는 4번이고 최초 NoData는 5번의 옛 행 생성 의미를 따른다.

- archive의 `normalize/daily.py`와 현재 `normalize_daily.py`, archive의 `digest.py`와 현재 `digest.py`는 소스 텍스트가 같다. activity 파서의 차이는 import 경로이며 `utc_text_ms` 계산도 유지됐다. archive 코드는 읽고 비교했으며 실행하지 않았다.
- `normalize_store.py:56`의 `observations`는 PK를 `canonical([encoded(...)])`로 만들고, metric·단위·값은 catalog와 `health.convert`를 사용한다. 문자열 PK에는 SQLiteText 인코딩을 적용하며 시각 샘플은 UTC `observed_at`, 나머지는 날짜를 사용한다. `_insert`는 같은 키를 `sub_identity`에도 기록한다. 이는 기존 `batch_import.py:219` 및 `health.py:130`의 반입 표면과 연결된다.
- `normalize_store.py:86`은 v1 provenance를 읽어 collect를 앞에 둔 v2 규칙만 INSERT한다. 건강 행도 INSERT하고, 가변 상태는 garmin ledger에 기록한다. `_write`의 1900ms transaction timeout과 attempt 확인, 500행 chunk 및 마지막 chunk의 성공 기록은 제품 경로에 있다.
- `normalize_store.py:147`의 항목 재처리는 collect dataset으로 제한된다. 반면 `normalize_runtime.py:77`의 날짜 집계는 account-wide snapshot을 입력으로 사용한다. `rebuild`의 신규 날짜 후보 제한은 collect raw가 있는 날짜/활동 날짜를 고른다(`:145`~`:153`).
- 신규 snapshot 예약과 watermark는 날짜 집계 revision이 같은 최대 fetched 시각을 공유할 때의 선택 순서를 다루고, 0009는 옛 행을 변경하지 않고 예약 이력을 보강한다. 해당 시험은 `garmin-normalize.test.ts:213` 이후와 `garmin-upgrade.test.ts:17` 이후에 작성돼 있다.

## 3. 의도의 기대 표면과 구현·시험 표면의 차이

### A. 입력 출처 금지는 날짜 후보 제한과 다른 표면에 있다

**확인된 경계 차이이며 해석 3에서는 불일치다.** `collect_store.py:66`의 `raw_snapshot`은 dataset 제한 없이 확인된 동일 계정의 raw를 endpoint별로 고르고, 결과에 원래 dataset도 남기지 않는다. `normalize_runtime.py:91`은 그 snapshot에서 날짜/활동으로만 선택한 뒤 `:112`~`:115`에서 `digest.day_values`를 호출한다. 따라서 수집 dataset에 어느 날짜의 raw가 하나 있고 같은 날짜의 다른 endpoint raw가 imported dataset에만 있으면, 그 imported raw가 날짜 요약·운동 집계 계산에 들어가 collect dataset의 관찰 행으로 발행될 수 있다. 예를 들어 수집한 user_summary와 imported-only daily_weigh_ins가 같은 날짜에 존재하면 후자의 체중도 날짜 집계 입력이 된다. 기존 imported 행을 UPDATE하지 않는다는 사실과 입력 raw를 재계산하지 않는다는 조건은 별개다.

현재 시험 `garmin-normalize.test.ts:142`~`:144`은 imported-only 날짜에 collect 집계가 생기지 않고 기존 current가 보존됨을 검사한다. 이는 신규 날짜 후보 제한을 관찰하지만, **수집과 반입 raw가 같은 날짜에 섞인 경우의 입력 출처**를 검사하지 않는다. 해석 4에는 맞지만 엄격한 금지 문구의 해석 3까지 입증하지 않는다.

### B. 고정 기대값 동등성은 실제 발행 경로와 분리돼 있다

**검증 범위 차이이며 계산 오류의 확정 주장은 아니다.** `check_normalize_equivalence.py:13`은 고정 입력을 `normalize_tables.normalize_all`에 넣고 옛 표 모양 전체를 expected.json과 비교한다. 실제 collect와 normalize 제품 경로는 `normalize_all`을 호출하지 않고 `normalize_runtime.prepare`·`retry_items`·`publish_days`를 거친다. 공통 파서와 day_values를 공유하므로 이 시험은 계산 의미에 강한 근거지만, runtime의 입력 선택·날짜 보완·NoData 상태 처리·발행 투영까지 동일하다고 직접 관찰하지는 않는다.

신규 `publisher_contract_fixture.py:29`~`:42`는 미리 만든 activity/exercise_set/hr_sample/day_summary/exercise_log 행을 `publish_item`/`publish_day`에 직접 전달한다. `garmin-normalize.test.ts:244` 이후는 실제 catalog, extension 역할, DB 발행, 문자열·JSON·NULL 날짜·UTC 시각·단위를 관찰하므로 단순 mock 검사가 아니다. 다만 이 fixture의 `synthetic-activity-9`는 실제 `normalize_item`의 숫자 activity 키 검사를 통과하는 입력이 아니며, 파서를 호출하지도 않는다. 따라서 이 시험의 성공 기대는 **발행기가 받은 행을 저장하는 계약**이지 **같은 rich raw를 실제 제품 정규화 경로로 처리한 결과가 고정 expected와 연결됨**을 뜻하지 않는다.

반면 steps의 반입/수집 키 일치와 current, A→B→A, raw-only 항목, 파서 실패 보존, 501개 샘플 중단·재개, 새 normalization version은 실제 작업·DB 경로를 거치는 별도 시험에 작성돼 있다(`garmin-normalize.test.ts:69`~`:180`). 전체 제품 시험 부재라는 판단은 아니다.

### C. 최초 raw null의 성공 상태와 건강 NULL 행은 같은 뜻이 아니다

**의도 내부의 해석 차이가 드러나는 지점이다.** `normalize_tables.py:123`~`:130`은 raw `null`을 성공으로 처리하면서 기본 대상 행을 만들지 않는다. runtime은 같은 scope/key의 기존 성공 대상 행이 있을 때만 소유 열의 NULL 행을 보완한다(`normalize_runtime.py:31`~`:53`). 따라서 새 날짜에 최초 `rhr_day='null'`만 있으면 항목 상태는 성공이지만 `daily_metric.resting_hr` NULL 행은 없다.

고정 fixture는 옛 SQLite 행 생성 의미를 비교하며 `check_normalize_store.py:18`은 이미 존재하는 입력 행의 `steps=None`이 관찰 행으로 변환되는 것을 검사한다. 후자는 **행 안의 NULL 값 보존**을 검사하며 **최초 NoData에서 행을 생성함**을 검사하지 않는다. 옛 의미 우선 해석에는 맞고, 모든 성공 항목에 소유 열 발행을 무조건 요구하는 해석에는 차이가 있다.

### D. 회수된 attempt의 데이터 거부와 오류 코드 계약은 다르다

**문자 그대로의 I/O 표와 불일치다.** 의도는 취소 후 쓰기의 오류를 `COLLECT_STOPPED`로 명시한다. 현재 `_write`는 attempt가 무효이면 `COLLECT_INVALID_ATTEMPT`를 던진다(`collect_store.py:28`~`:30`). 시험도 실제 첫 chunk 뒤 attempt를 취소한 다음 `COLLECT_INVALID_ATTEMPT`를 기대하고, 이미 기록된 500행 보존과 후속 쓰기 거부를 검사한다(`garmin-normalize.test.ts:127`~`:130`). 종료된 attempt로 새 발행을 시도할 때 추가 행 0건도 같은 코드를 기대한다(`:256`~`:258`).

따라서 쓰기 차단 의미는 시험 표면에 포함되지만 명세의 정확한 오류 코드는 구현되지 않았다. 별도 `COLLECT_STOPPED` 시험은 fixture가 raw commit 직후 또는 날짜 chunk 경계에서 그 예외를 직접 발생시키는 경로다(`collect_fixture.py:109`~`:124`, `garmin-normalize.test.ts:182`~`:209`). 이는 DB에서 attempt 회수가 감지되는 표면과 다르다.

## 검사 판정

정적 독립 검사는 완료했고 검사 수행 실패나 접근 차단은 없었다. 제품 동작의 실행 통과 여부는 시험 실행 금지에 따라 미확인이다. 확인된 주요 차이는 날짜 집계의 입력 출처 경계와 회수 attempt의 오류 코드이며, 계산 동등성/발행 계약 시험의 연결 범위 및 최초 NoData 의미는 위와 같이 각각 검증 공백과 해석 차이로 기술했다. 이 보고서는 수정·추가 작업을 제안하지 않는다.
