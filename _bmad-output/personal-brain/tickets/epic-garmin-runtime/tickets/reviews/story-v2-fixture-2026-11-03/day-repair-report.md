# 16.4 날짜 발행 복구

## 변경

- raw 저장과 같은 트랜잭션에서 수집 날짜와 활동의 이전·현재 영향 날짜에 dirty generation을 남긴다. 마지막 날짜 chunk 성공 시 해당 세대만 완료 처리하므로 중간 raw commit 이후 중단이나 뒤따르는 raw 변경을 놓치지 않는다. collect no-op도 dirty 날짜를 찾는다.
- `normalize_day_revisions`에 입력 source max와 발행 watermark를 버전 공통으로 예약하고, 첫 chunk 전에 기존 `normalize_days`에 pending을 예약한다. 기존 성공 행은 덮어쓰지 않으며 같은 revision은 기존 watermark를 재사용한다. 실패 이력 때문에 기존 성공이 다시 선택될 때만 성공의 retry 순서 정보를 갱신한다.
- 입력의 원래 최대 시각은 밀리초, 파생 관측의 watermark는 그 밀리초 안의 마이크로초 슬롯으로 보존한다. 동일 source max의 새 입력 조합은 다음 슬롯을 사용하고 다른 source max는 자연 시간 순서를 유지한다. 같은 source millisecond에 1,000개 슬롯이 모두 사용되면 명시적으로 실패해 다른 source 시각의 순서를 훼손하지 않는다.
- 예약 트랜잭션은 raw 테이블의 짧은 공유 잠금 아래 계정 전체 coverage raw를 재조회해 계산한 snapshot과 비교한다. stale snapshot은 예약하지 않고 현재 입력을 재계산한다. 활동 수집은 이전 활동 날짜를 결정하는 raw를 쓰기 잠금 아래 검증한다.
- 합성 PG 시험에서 raw commit 직후 및 첫 날짜 chunk 직전 중단을 주입해 중간 상태와 no-op 복구를 확인한다. 동일 입력 멱등성·버전별 watermark 재사용·최대 시각이 유지된 입력 변경·labels 변경·동률 및 더 오래된 stale snapshot 거부를 `health_current_v1`과 resolution에서 확인한다. no-op 경로를 재현하기 위해 시험의 기존 성공 실행을 최신 coverage 실행으로 설정한다.

## 검증 기록

- `PYTHONDONTWRITEBYTECODE=1`을 사용했다. Python 3.14의 `check_normalize_store.py`, `check_raw_transitions.py`, `check_collect.py` 및 `git diff --check`는 통과했다.
- 대상 PG 시험 초기 실행은 이전에 중단된 격리 시험의 `brain_ext_garmin` 역할 때문에 설치가 실패했다. 해당 역할의 시험 데이터베이스 표식과 실행 중인 시험 부재를 확인하고 그 임시 시험 역할·DB만 정리했다.
- 이후 한 번은 오래된 시험용 확장 번들에 새 migration이 없어 실패했고, 번들을 갱신했다. 또 다른 실행은 합성 입력의 freshness를 명시하지 않아 예상 대상 대신 다른 날짜가 수집됐고, 다음 실행은 다른 날짜에서 중단 주입이 먼저 발생했다. 각각 합성 fixture를 바로잡았다.
- 수정 후 정규화 PG 파일 1개/시험 1개, 수집 PG 파일 2개/시험 2개가 통과했다. 최종 소스 변경 후 동일 세 파일을 순차 재실행한 결과는 아래에 기록한다.
- 최종 `node apps/cli/scripts/write-build-info.mjs`로 시험 번들을 갱신한 뒤 `PYTHONDONTWRITEBYTECODE=1 pnpm exec vitest run --config apps/cli/python-test/vitest.config.ts apps/cli/python-test/garmin-normalize.test.ts apps/cli/python-test/garmin-collect.test.ts apps/cli/python-test/garmin-collect-resume.test.ts`: 3파일, 3시험 통과(144.83초), 파일 순차 실행. 앞선 성공 후 활동 수집 계획 날짜도 dirty 후보에 추가하여 이 최종 실행으로 재확인했다.
- 전체 `pnpm test:python` 및 `pnpm test`는 지시대로 실행하지 않았다. 이번 두 항목 외 기존 repair-spec 검증은 다음 단계에 남아 있다.
