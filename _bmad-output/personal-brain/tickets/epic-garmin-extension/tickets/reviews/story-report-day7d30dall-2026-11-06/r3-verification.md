# 21.4 R3 독립 표적 후속 확인

정적 검토 완료. 작성된 감독 통합 시험에서 미해결 오류 3건을 확인했다. 제품 기능이 실행에서 실패했다고 주장하는 보고가 아니라, 현재 시험 코드가 기존 감독·저장소 계약과 충돌하는 지점을 보고한다. 검사 자체의 접근 차단은 없었다.

AGENTS.md, 자동화 runbook, `.brain-automation/independent-spec.md`의 원문·제약, R1 네 보고서와 R2 세 보고서 전문, `/private/tmp/brain-214-review-r3.diff` 전체를 읽었다. 관련 manifest·entry·runtime·writer·body IPC·원본 body 파일 처리·PG store/fence·감독 정산·CLI enqueue·시험 harness·discovery·경로 분류를 연결해 검사했다. 구현자·다른 리뷰어와 대화하지 않았고 추가 워커를 사용하지 않았다. 이 보고서 외 코드·계획은 수정하지 않았다.

**시험 실행은 21.8로 이관, 미실행**이다. build/typecheck, 시험, fixture 생성, checker, 산술 재현, 실모델·실계정·운영 호출은 수행하지 않았다. 승인된 실행 유예는 결함에 포함하지 않았다.

## 미해결 사항

### R3-V1 — 재시도 가능한 attempt 실패를 일감의 최종 실패로 기다려 후속 검증에 도달하지 못한다

- **위치:** `apps/cli/python-test/garmin-report.test.ts:46`, `:67`, `:150`, `:175`, `:251`, `:293`, `:305`.
- **원인:** 공통 `outcome()`은 `brain.work_items.outcome`을 읽는데, 각 호출은 첫 attempt의 모델 오류·timeout·lock busy·SIGKILL 직후 `failed`를 기대한다. 새 report entry는 `REPORT_FAILED`와 `REPORT_LOCKED`를 `retryable: true`로 내보낸다(`extensions/garmin/src/report.py:18`~`:21`). SIGKILL도 감독자가 재시도 가능한 `died`로 분류한다(`packages/core/src/queue/supervisor.ts:403`~`:412`).
- **도달 가능한 실패와 증거:** 첫 시도는 최대 시도 횟수에 도달하지 않았으므로 감독자는 terminal failure 없이 `nextAttemptAt`을 전달한다. `packages/postgres/src/work.ts:465`~`:472`는 이 경우 일감의 `completed_at`과 `outcome`을 NULL로 유지하고, 실패 결과는 attempt에 기록한다. 기본 재시도 지연은 `900_000`ms이며 Garmin 별도 정책은 없다(`packages/core/src/domain/work-item.ts:120`~`:141`). 시험 helper의 대기는 `90_000`ms다. 따라서 정상적인 감독 동작에서도 이 대기는 `failed`를 보지 못하고 만료된다. 실패 재생성의 최신 view 검사, body pending·재시도 검사, scope 실패 후 재개 검사 등이 그 뒤에 있어 실행되지 않는다.
- **보완 범위:** 기존 시험에서 관찰하려는 attempt의 실패·종료를 정확히 기다리고, 이어서 기존 재시도/수동 요청 계약에 맞춰 진행해야 한다. 이를 맞추려고 제품의 재시도 정책을 terminal failure로 바꿀 근거는 없다.

### R3-V2 — 토큰을 직접 비운 뒤 정산 대상에서 제외된 attempt의 finished_at을 기다린다

- **위치:** `apps/cli/python-test/garmin-report.test.ts:205`~`:207`, `:233`~`:235`.
- **원인:** 두 회수 시험은 `current_attempt_token=null`만 직접 기록한 뒤 같은 attempt의 `finished_at`이 자동으로 채워지기를 기대한다. 그러나 회수된 토큰의 정산 쓰기를 거부하는 것이 기존 저장소 계약이다.
- **도달 가능한 실패와 증거:** 감독자가 stale 응답 또는 토큰 상실을 처리해 `finishSupervisedWork`/`settleSupervisedAttempt`를 호출해도, `lockOpenSupervisedWork`는 현재 토큰이 같은 일감만 허용한다(`packages/postgres/src/work.ts:765`~`:771`). 그 일감이 없으면 정산은 attempt 갱신 전에 반환한다(`:334`~`:338`, `:460`~`:461`), 결과는 `lost`다(`:790`). 복구 목록도 `w.current_attempt_token=a.token`으로 join하므로 직접 비운 이전 attempt를 후속 복구에서 찾지 않는다(`:324`~`:326`). 시험은 회수 시 attempt 종료를 직접 기록하지도 않는다. 따라서 파일 게시·평가 append가 올바르게 거부되더라도 `finished_at`은 NULL로 남고 45초 대기가 실패해 뒤의 pending·sidecar 부재·추가 scope 미호출 assertion에 도달하지 못한다.
- **보완 범위:** 회수 fixture의 상태 전이와 종료 관찰을 일치시켜야 한다. 이미 fence를 잃은 제품 프로세스가 이전 attempt의 종료 행을 쓰도록 바꾸라는 요구가 아니다.

### R3-V3 — 감독자 복구의 자동 재개를 새 일감 실행으로 취급해 호출 목록을 잘못 비교한다

- **위치:** `apps/cli/python-test/garmin-report.test.ts:270`~`:276`; 호출 기록의 식별자는 `extensions/garmin/tests/report-fixture/codex:62`~`:65`.
- **원인:** 새 감독자는 이전 작업을 정산한 뒤 같은 열린 일감을 자동 재청구한다. 시험은 이전 attempt의 `finished_at`만 기다린 뒤 `enqueue()`가 재개 전용 새 id를 돌려준다고 가정하고, 그 id의 전체 호출 목록이 `['30d','all']`이라고 단언한다. fake 기록에는 work id만 있고 attempt token 구분이 없다.
- **도달 가능한 실패와 증거:** `packages/core/src/queue/supervisor.ts:156`~`:170`의 복구는 첫 사망을 `settleSupervisedAttempt`로 넘긴다. `packages/postgres/src/work.ts:340`~`:345`는 일감을 완료하지 않고 토큰·claim을 해제하며 `next_attempt_at`을 현재로 돌린다. 이후 claim 경로는 같은 행을 다시 실행한다(`:354`~`:384`). 수동 enqueue의 find-or-create도 같은 kind/target의 열린 행을 반환한다(`:118`~`:140`). 그러므로 기존 일이 열린 동안 `resumed===work`이면 `:276`의 work 기준 목록에는 사망 전 `day,7d,30d` 호출까지 포함되어 기대값과 다르다. 반대로 자동 재개가 먼저 완료된 뒤 수동 요청이 새 일감을 만들면 저장 성공을 모두 건너뛰어 새 id의 호출 목록은 빈 목록이다. 어느 경로도 현재의 새 실행 목록 가정을 보장하지 않는다.
- **보완 범위:** 이미 작성한 7d 확정→실제 daemon SIGKILL→새 감독자→30d/all 관찰에서 복구 전후 attempt 또는 호출 경계를 구분하고 자동 재개된 일감을 추적해야 한다. 별도 기능이나 새로운 시험 시나리오를 추가하라는 요구가 아니다.

## R1/R2 보완 대응과 검사한 범위

아래는 작성된 코드의 관찰 경계를 확인한 것이며 실행 통과 판정이 아니다.

| 이전 지적·표적 | 현재 대응 및 정적 판정 |
| --- | --- |
| 실제 감독자 7d 저장 후 kill/restart/resume | TS `daemon SIGKILL after 7d commit`이 실제 daemon을 죽이고 새 감독자를 시작한다. 재개 호출 식별은 R3-V3 미해결이다. 작업 그룹만 죽이는 앞 시험은 R3-V1의 대기 오류도 있다. |
| 실제 계정별 입력·기간 경로·프로필·digest | fake가 전달된 입력 폴더의 manifest/raw/body/이전 평가/digest 및 기간 scope/day_values/profile을 연다. TS가 두 계정의 알려진 steps·weight·표식과 저장 결과를 비교한다. `test_report_input_pg.py`와 독립 SQLite child도 이제 계산 digest를 실제 파일에 써서 비교한다. 이 표적에서 추가 발견 없음. |
| 최신 view·실패 재생성·기존 revision 보존 | TS가 실패 scope의 이전 행과 성공 scope의 새 본문, view의 행 수·최대 revision·본문까지 비교한다. 해당 assertion 앞의 대기는 R3-V1 미해결이다. |
| 모델 설정·argv·사진 첨부 | 두 report 종류의 model 필수 선언/누락 거부 시험이 있다. 감독 통합 시험이 다른 model/effort 설정과 실제 fake argv, pending 사진 정렬·`-i` 인자·프롬프트 목록을 비교한다. 해당 재생성 경로 앞의 사망 대기는 R3-V1 미해결이다. |
| 배포 skill 선택·명령 계약 | fake가 runtime cwd/`-C`, 선택된 `.agents/skills` 이름, body pending/write/reject 명령 및 종료 설명을 검사한다. 알 수 없는 skill 호출은 별도 subprocess 시험에서 exit 18을 기대한다. 이 표적에서 추가 발견 없음. |
| 호스트 IPC·실 PG fence | CLI 자식에서 DB URL을 제거하고 IPC 요청을 호스트 handler가 처리한다. 단위 시험이 실제 CLI subprocess와 요청·응답을 통과한다. 실제 PG 시험은 원자적 게시 뒤 barrier 동안 token 회수가 row lock에 막힘을 검사하고, 중단 뒤 stale 거부와 새 token 재시도를 관찰한다. 감독 회수 시험의 종료 대기는 R3-V2 미해결이다. |
| 모델 종료·deadline 뒤 대기 요청 처리 금지 | service가 각 요청 전과 파싱 후 active를 재확인한다. `test_host_rechecks_model_and_deadline_before_each_queued_body_request`는 첫 요청 중 모델 종료/시간 초과 뒤 두 번째 handler 미호출을 관찰한다. 추가 발견 없음. |
| TERM 무시 손자·다음 scope 전 종료 | fake 손자가 SIGTERM을 무시하고 ready를 출력한 뒤 pid를 게시한다. TS가 다음 scope hold 중 생존 여부를 확인한다. timeout 뒤 전체 작업 실패 대기는 R3-V1 미해결이다. 정리 확인 실패는 Python 단위 시험에서 오류 전파를 관찰한다. |
| 파일 공개 뒤 취소·재시도 | body 단위 시험이 실제 `_atomic_write` 뒤, 실제 첫 `_move` 뒤 KeyboardInterrupt를 주입한다. 공개 sidecar·남은 pending·이동된 source·mtime 병합·재시도 결과를 확인한다. 별도 실제 PG 게시/fence 시험도 연결돼 있다. 이 표적에서 추가 발견 없음. |
| intake의 거짓 성공·pending/기간 입력 파일 오류 | `test_report_supervised.py`가 원래 pending 잔존, 일부 잔존, 새 도착 분리, 최초/재조회 OSError, scope 입력 파일 오류 후 다음 scope 지속, store/cancel 전파를 관찰한다. 추가 발견 없음. |
| 유효 JSON의 failed 상태 | fake의 `status-failed` 분기와 TS 매개변수 시험이 추가됐다. attempt 실패 뒤의 일감 종료 대기는 R3-V1 미해결이다. |
| 기본 progress 연결·대기 중 열린 DB transaction 부재 | 기본 `CodexWriter().write()`에서 ABI stdout을 잡는 시험과, 실제 모델 hold 중 별도 PG 연결의 transaction 관찰자가 있다. 추가 발견 없음. |
| harness 등록·실행 선택 | Python `unittest discover -p test_*.py`가 새 모듈을 찾고, Vitest Python 설정이 새 TS 통합 시험을 포함한다. `rules.mjs`의 extensions 전체 규칙과 observer exact 규칙, 분류 assertion을 확인했다. 미등록은 발견하지 않았지만 실행 가능성을 막는 구체 오류는 위 3건이다. |

R1의 계정 timezone과 한국어 서술 시각 지시 충돌, 판독 불가 reject 해석, 재생성 세대 해석은 앞선 원문과 현재 코드를 대조했으나 이번 요청의 시험 코드 오류·미등록·검증 우회 표적 밖의 의도/제품 판단이므로 새 결함으로 재등록하지 않는다. fake 모델을 쓰는 시험에서 실제 이미지 판독 품질이나 실제 Codex sandbox 작동을 입증했다고 주장하지 않는다. 고정 원본의 추가 조회는 필요하지 않아 `~/github/garmin`은 접근하지 않았다.

## 남은 일과 차단 구분

검사 수행 차단은 없다. R3-V1~V3는 현재 작성 시험의 미해결 사항이며, 수정은 이 리뷰 작업의 허용 범위 밖이다. 새 임의 시험 요구는 추가하지 않았다. 기존 시나리오의 상태 관찰을 수정한 뒤 필요한 정적 후속 확인과 21.8의 실제 시험 실행·실패별 수정이 남는다. 이번 리뷰 완료를 제품 시험 통과 또는 티켓 전체 완료로 취급하지 않는다.
