# 0008 동률 revision 업그레이드 복구

0009가 seed한 동일 날짜·watermark의 서로 다른 revision을 예약 트랜잭션에서 감지한다. 현재 입력의 base revision이 동률에 포함되면 `digest(base_revision, 'legacy-collision-repair')`를 결정적인 복구 revision으로 쓰고 같은 source millisecond의 다음 watermark를 예약한다. 이 별칭 예약은 기존 ledger에 영속되므로 동일 입력과 다른 정규화 버전에서도 같은 별칭·watermark를 재사용한다. 충돌이 없는 base revision은 그대로 쓰며 기존 관측과 기존 성공 상태는 변경하지 않는다. 행 id·batch·상태에는 예약이 반환한 실제 revision을 사용한다.

격리 PostgreSQL에서 빈 상태의 0009 테이블과 ledger 항목을 제거해 0008 스키마를 재구성하고, 유효한 합성 attempt로 정상 날짜와 같은 fetched 시각의 두 revision이 있는 날짜를 기록했다. 실제 migration runner가 checksum과 ledger를 확인하며 0009를 적용한 뒤 동일 raw 수동 normalize를 실행했다. 충돌 날짜의 `revision_ambiguous`가 정상 current로 바뀌고 정상 날짜 revision은 유지됐으며 기존 관측의 id·batch·revision·값·fetched와 기존 성공 상태는 그대로였다. 두 번째 실행은 멱등이고 지원 목록에 9를 더한 임시 확장으로 다시 실행해 같은 별칭·watermark가 v8과 v9에서 재사용됨을 확인했다.

검증은 합성 데이터와 127.0.0.1 시험 PostgreSQL에서 순차 실행했다. `PYTHONDONTWRITEBYTECODE=1`과 Python 3.14를 사용했고 전체 suite는 실행하지 않았다.

- `node apps/cli/scripts/write-build-info.mjs`로 시험용 확장 번들을 갱신했다.
- `PYTHONDONTWRITEBYTECODE=1 pnpm exec vitest run --config apps/cli/python-test/vitest.config.ts apps/cli/python-test/garmin-upgrade.test.ts`: 1파일 1시험 통과(5.89초).
- `PYTHONDONTWRITEBYTECODE=1 extensions/garmin/.venv/bin/python extensions/garmin/tests/check_normalize_store.py` 및 `check_normalize_equivalence.py`: 각각 통과.
- 위 Python 검사 후 `PYTHONDONTWRITEBYTECODE=1 pnpm exec vitest run --config apps/cli/python-test/vitest.config.ts apps/cli/python-test/garmin-normalize.test.ts apps/cli/python-test/garmin-upgrade.test.ts`: 2파일 2시험 통과(150.64초), 파일 순차 실행.
- `git diff --check`: 통과. 이전 회귀 보고서의 0008 동률 미복구 항목은 이 보고서의 실제 업그레이드 검증으로 해결됐다. 기존 같은 source millisecond의 1,000개 watermark 슬롯 한도는 변하지 않는다.
