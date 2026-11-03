# 검증 공백 검사

입력 `/tmp/brain-16-4-followup-review.diff`와 현재 관련 구현·시험을 읽기 전용으로 추적했다. 문서·프롬프트·설정·정적 라벨은 지침의 선별 기준에 따라 제외했고, 변경된 시험은 읽었다. 아래는 현재 결함이라고 단정하는 항목이 아니라, 구체적인 회귀를 잡도록 시험을 추가할 요청이다. 빌드·시험·실제 계정·운영 데이터·비밀 접근은 수행하지 않았다. 정적 검사는 완료했으며, 실행 검증 결과는 없다.

### 큰 항목을 일부 발행한 뒤 재개하는 결과를 확인하는 시험이 없다

- **Changed surface:** `extensions/garmin/src/normalize_store.py:125`는 항목을 500행씩 별도 트랜잭션으로 발행하고 마지막 chunk에서만 완료 상태를 기록한다. `:147`은 미완료 항목을 다시 선택한다.
- **Impacted consumer or site:** `extensions/garmin/src/normalize_runtime.py:118`의 `rebuild`와 `extensions/garmin/src/normalize.py:29`의 수동 정규화 작업. 중단 전 일부 행이 이미 저장된 항목도 재실행으로 완성돼야 한다.
- **Existing test evidence:** `apps/cli/python-test/garmin-normalize.test.ts:92`는 501개 심박 샘플을 넣고 `:100`에서 정상 실행 후 501행을 확인한다. `extensions/garmin/tests/check_normalize_store.py:29`는 목록 분할 크기만 확인한다. `apps/cli/python-test/garmin-collect-resume.test.ts:35`의 중단은 외부 fetch 장벽에서 일어나며 재개 후 raw 보존을 확인한다. 정규화 첫 chunk를 커밋한 뒤 중단한 상태는 만들지 않는다. 저장소의 `publish_item`, `normalize_store`, `normalize_runtime`, `normalize_items`, `CHUNK_SIZE` 참조와 시험을 검색하고 위 파일들을 읽었다.
- **Missing verification:** 첫 500행이 저장되고 항목이 미완료인 상태에서 다음 정규화 작업을 실행했을 때, 기존 행의 id·revision·값은 보존되고 남은 행이 생기며 완료 상태가 마지막에만 참이 되는지 확인하지 않는다.
- **Demonstration:** 완료 상태 갱신이 마지막 chunk 조건 밖으로 이동해 첫 chunk부터 `ok=true`가 되는 회귀를 가정한다. 501개를 끝까지 처리하는 현재 시험은 여전히 501행을 얻는다. 그러나 첫 chunk 뒤 프로세스가 종료되면 `unpublished`가 해당 항목을 완료로 보아 제외하므로 다음 실행에도 마지막 샘플이 복구되지 않는다. 기존 시험은 이 상태를 만들지 않아 실패하지 않는다.
- **Consequence:** 수집된 원문은 남아 있어도 일부 심박 관측이 영구적으로 미발행된 채 정규화 완료로 표시될 수 있다.
- **Disposition:** 기존 임시 PostgreSQL·설치 확장 fixture를 사용하는 통합 시험 하나를 추가한다. 501개 샘플의 첫 chunk 커밋 직후 다음 경계에서 실행을 중단하고, 미완료 상태와 500행을 확인한 뒤 새 작업으로 재개해 501행·기존 500행의 동일성·최종 완료 상태를 검증한다.

### 체중 원문에서 일 요약 값을 계산하는 성공 사례가 검증되지 않는다

- **Changed surface:** `extensions/garmin/src/digest.py:987`의 `weight_for`는 당일 유효 측정 중 가장 늦은 값을 골라 g에서 kg으로 바꿔 반올림한다. `:1297`은 이를 `day_summary.weight_kg`에 넣는다.
- **Impacted consumer or site:** `extensions/garmin/src/normalize_runtime.py:104`가 만든 일 요약을 `:110`에서 발행하고, `extensions/garmin/src/normalize_store.py:162`가 catalog 단위로 관측에 변환한다.
- **Existing test evidence:** 동등성 입력 `extensions/garmin/tests/fixtures/normalize_v8/input.json:64`의 `daily_weigh_ins`는 `null`이고, 기대값 `expected.json:166`과 `:195`도 체중이 모두 `null`이다. `check_normalize_equivalence.py:13`은 이 입력을 정확히 비교한다. `check_health_contract.py:44`는 이미 계산된 2kg을 2000g으로 바꾸는 `convert`만 확인하며 원문 선택·계산을 호출하지 않는다. 통합 시험 `garmin-normalize.test.ts:40`의 기본 fake는 이 endpoint에 `{ok:true}`를 돌려줄 뿐 유효 체중 측정을 제공하지 않는다. `dateWeightList`, `weight_for`를 apps·extensions·packages·tooling·프로젝트 custom 시험에서 검색했으며 다른 체중 원문 계산 시험은 찾지 못했다.
- **Missing verification:** 시간순과 다른 배열에 든 복수 유효 체중 중 최신 측정을 선택하고 g→kg·소수 한 자리 계산 결과를 일 요약에 전달하는 assertion이 없다.
- **Demonstration:** 원문 필드명이 `weight`에서 잘못된 키로 바뀌거나 `max`가 `min`으로 바뀌면 유효 체중이 누락되거나 첫 측정이 선택된다. 기존 동등성 입력에는 유효 체중이 없어 결과는 계속 `null`이고, `convert` 시험은 이 함수를 거치지 않아 통과한다.
- **Consequence:** 실제 체중 기록이 있는 날의 일 요약이 결측 또는 오래된 측정값으로 발행될 수 있다.
- **Disposition:** 동등성 fixture에 같은 날 서로 다른 시각·체중의 합성 측정을 역순으로 넣는 사례 하나를 추가하고, 격리 legacy oracle에서 고정한 최신 체중 기대값을 기존 `check_normalize_equivalence.py`로 비교한다.

### 새 Orca 메시지 형태의 보고 귀속과 지역 ack가 기존 제어 시험에 없다

- **Changed surface:** `_bmad/custom/bmad-orca-control.py:392`는 `runId`·`deliveryId`가 없는 메시지를 지역 delivery로 보존하며, `:421`은 `from`을 발신자 대안으로 사용하고 `:607`은 지역 ack를 처리한다.
- **Impacted consumer or site:** 같은 파일 `:525`의 `Control.check`가 단계·보고서·워커 결과를 저장하고, `:604`의 `ack` 명령이 처리한 지역 delivery를 닫는다.
- **Existing test evidence:** `_bmad/custom/test_bmad_orca_control.py:72`의 메시지 생성기는 `from_handle`만 만든다. `:277`의 단계·보고 보존 시험은 `runId`, 서버 `deliveryId`, `from_handle`을 모두 제공하고 서버 delivery를 ack한다. `:375`의 재시작 시험도 서버 delivery만 사용한다. 해당 시험 전체와 `deliveryId`, `from_handle`, `local:`, `from` 검색 결과를 다시 확인했다. 새 형태를 넣고 저장 상태를 확인하는 사례는 없다.
- **Missing verification:** `runId`·`deliveryId` 없이 `from`만 제공한 `worker_done` 메시지가 등록된 Task·Dispatch·handle에 귀속되고, 보고 경로·outcome·지역 delivery가 보존되며 지역 ack 뒤 pending이 비워지는지 확인하지 않는다.
- **Demonstration:** 발신자 대안 `(m.get('from_handle') or m.get('from'))`이 이전의 `from_handle` 전용 판정으로 돌아가면 새 메시지의 보고·outcome이 저장되지 않는다. 기존 fixture는 모두 `from_handle`을 주므로 계속 통과한다. 지역 delivery를 서버 ack로 보내는 회귀 역시 기존 서버 delivery 시험으로는 구별되지 않는다.
- **Consequence:** 새 Orca에서 도착한 실제 완료 보고를 제어 도구가 워커 결과로 인정하지 못하거나, 이미 소비한 메시지의 지역 확인 처리가 실패할 수 있다.
- **Disposition:** 기존 격리 fake CLI 기반 시험 하나를 추가한다. 새 메시지 형태를 주고 `check` 후 report·reported_outcome·지역 pending 상태를 확인한 다음 지역 ack 후 pending 해제를 확인한다. 서버 ack 호출 금지는 이 결과 검증을 보조하는 assertion으로 둔다.
