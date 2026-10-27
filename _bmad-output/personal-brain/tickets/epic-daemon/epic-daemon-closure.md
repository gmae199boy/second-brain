<!-- 2026-10-27 epic-daemon 닫기 점검(codex 워커, 읽기 전용). 사용자 결정은 epic Notes 2026-10-27 닫기 Decision. -->

# epic-daemon 닫기 점검 (2026-10-27)

대상: `58184db`. 에픽·tickets.toml·계획 10개를 전문으로 읽고 현재 구현·시험의 단언·README·9.8 사람 결과를 대조했다. 스토리의 `done` 표시는 충족 근거로 쓰지 않았다. 저장소는 변경하지 않았고 이번 점검에서는 빌드·시험을 재실행하지 않았다. 아래 시험명은 현재 시험 코드의 증거이며, 실행 이력은 9.7 Auto Run Result의 `pnpm test`(빌드·typecheck·Postgres 포함 102파일/2,892시험 통과)다.

`git log --oneline 175583e..HEAD`에서 기능 커밋은 9.1 `136122b`, 9.2 `168ba8e`, 9.3 `7bb83db`, 9.4 `5f65f56`, 9.5 `14fb7bd`, 9.6 `4ff0cc8`·`bcb19af`, 9.9 `d6c34fd`, 9.10 `9c7ae4a`, 9.7 `65b3292`이며, 배포는 `5753961`, Mac 결과 기록은 `58184db`다.

## 1. 완료 조건·요구사항 대조

경로 약어: `D` = `apps/cli/src/daemon/`, `T` = `apps/cli/test/`, `P` = `_bmad-output/personal-brain/tickets/epic-daemon/tickets/`. `Mac`은 `P/story-mac-plan.md`의 확인 표다. `일부`는 구현 결함 확정과 검증 미완료를 구분해 적었다.

| 항목 | 판정 | 구현·시험·실증 근거 |
|---|---|---|
| Done when 1: 데몬 없이 명령·hook 및 밀린 일 처리 | 충족 | `apps/cli/src/dispatch.ts:654`의 생존 부재 시 기회적 drain, `plugin/bin/session-start.sh:160`의 명시적 drain. `T/daemon-status.test.ts:43`의 89초/91초/heartbeat 없음 행이 수집 0/1과 doctor ok/warn을 대조한다. `T/daemon-stop-start.test.ts:29`는 stop 자체의 미수집과 다음 일반 명령의 수집을 단언한다. 9.7 전체 회귀 실행 기록도 있다(향후 epic 5·8은 현재 범위 밖). |
| Done when 2: hook 없이 10초 안 수집 | 일부 | `D/watch.ts:6`의 2초 고정 창과 `D/run.ts:153`·`:198`의 깨움. `T/daemon-run.test.ts:853`의 `collects hook-free writes within ten seconds and catches offline writes on restart`는 9,500ms 안 수집을 단언한다. Mac 「Stop hook 없이 저장된 transcript 수집」은 일부: 실제 수집은 확인했으나 지연 미측정. 긴 drain 아래 절대 10초 상한도 보장하지 않는다(2절). |
| Done when 3: 갱신 후 새 빌드·죽이면 launchd 재기동 | 일부 | `apps/cli/src/install/flow.ts:616`의 실행 중 commit 비교·재시작, `D/control.ts:110`의 신호/재적재 후 기대 commit 생존 관찰. `T/daemon-control.test.ts:137`의 실제 잠금 commit 전환 시험. Mac 「죽이면 다시 띄움」은 PID 46083→55520으로 통과하지만 「플러그인 갱신 뒤 새 빌드」는 첫 설치여서 미확인. bootstrap 분리 시험은 실제 자동 교체 증거가 아니다. |
| Done when 4: Label 하나·doctor·stop/start·제거 | 충족 | `D/launchd.ts:124`의 loaded 확인과 중복 bootstrap 생략, `apps/cli/src/doctor/checks.ts:141`의 공용 판단·warn, `D/control.ts:32`·`:89`·`:75`의 stop/start/제거. `T/daemon-launchd.test.ts:176`, `T/daemon-stop-start.test.ts:29`, `T/setup-uninstall.test.ts:46`의 멱등·삭제·DB/파일 보존 단언. Mac의 반복 setup, stop/start, 최소 uninstall 행 통과(제거 후 재등록). |
| Done when 5: 예약 일감·drain·놓친 회차 하나 | 충족 | `D/run.ts:277`의 tick→drain, `packages/core/src/queue/schedule-tick.ts:12`의 놓친 회차 병합. `T/daemon-run.test.ts:752`의 설치본 프로세스 시험은 185초 지난 60초 예약의 완료 일감 1개와 다음 시각 차이 60초를 단언한다. `packages/core/test/schedule-tick.test.ts:87`의 probe 완료, `T/daemon-run.test.ts:208`의 rollback·복구 시험. |
| Done when 6: 플러그인 배포·로그인·heartbeat·hook 없는 수집 | 충족 | `plugin/app-ref:1` = `65b3292…`, `plugin/.claude-plugin/plugin.json:3` = 0.1.8. Mac 배포 기록의 installed commit·스키마 9, 「로그인 때 자동 실행」의 재부팅 후 running/PID 3568, 「heartbeat 갱신」의 30초 mtime 진행, 「hook 없이 수집」의 턴 종료 전 DB 반영. 이 항목 자체에는 지연 상한이 없다. |
| E9-1: Core 직접 호출·단일 잠금·종료·로그·heartbeat | 충족 | `D/run.ts:274`에서 같은 빌드의 createBrain/tick/drain, `apps/cli/src/commands/daemon-run.ts:53`의 envelope false·신호 연결, `apps/cli/src/dispatch.ts:430`의 무출력 처리. `D/lock.ts:133`·`:218`의 원자적 link 생성/죽은 주인 회수, `T/daemon-lock.test.ts:110`의 오래된 살아 있는 잠금 보존. `D/run.ts:212`의 heartbeat 중단→종료 로그→잠금 해제, `D/heartbeat.ts:47`의 독립 타이머, `D/liveness.ts:7`의 30초. `D/log.ts:6`의 1MiB·5회전본 및 `T/daemon-log.test.ts:152`의 실제 경계 시험. 기존 수용 절충은 2·3절 참조. |
| E9-2: 하나의 생존 판단·기회적 drain·SessionStart 폴백 | 충족 | `D/liveness.ts:19`에서 현재 부팅의 살아 있는 pid와 heartbeat 나이 0~90초를 확인하고, dispatch `:655`·doctor `:142`·status 명령이 공유한다. `T/daemon-liveness.test.ts`, `T/daemon-status.test.ts:43`의 경계·없음·미래·죽은 pid 및 표면 일치 시험. SessionStart `:160`의 명시적 drain은 유지된다. |
| E9-3: 반복 drain·폴더 감시·기동 scan·10초·기존 spool | 일부 | `apps/cli/src/harnesses.ts:37`와 `packages/claude-code/src/transcript-folder.ts:53`이 같은 projects 경로를 쓴다. `D/watch.ts:41`의 고정 창, `D/run.ts:161`의 기동 회차, `packages/core/src/brain.ts:461`의 scan, `apps/cli/src/assembly.ts:75`의 기존 fileSpool 조립. `T/daemon-watch.test.ts:36` 및 앞의 hook-free/재기동 시험. 수집 spool은 공용 조립과 `T/capture-scan.test.ts:618`의 잠금 해제 후 replay 시험을 통한 조합 증거다. 10초 제한은 Done 2와 같은 미완료/조건부 보장이다. |
| E9-4: 0009·원자적 발화·한 번/반복·실패 재시도·사용자 명령 없음 | 충족 | `packages/sqlite/migrations/0009_schedules.sql:3`의 strict schedules·시각/간격·due 인덱스, `packages/sqlite/src/schedules.ts:54`의 발화 CAS와 withWrite 안 ensureWork+시각 갱신. `packages/core/src/queue/schedule-tick.ts:14`의 now 한 번/실행 시점+간격/null 종료. `packages/sqlite/test/schedule-store.test.ts:28`·`:43`·`:68`의 insert/update 거부 rollback, 실제 writer 잠금 복구, 앞 예약 commit 보존. `packages/core/test/schedule-tick.test.ts:20`·`:31`의 누락 회차·한 번짜리. README `:552`와 명령 등록부에는 예약 사용자 명령이 없다. |
| E9-5: 공용 설치기·단일 Label·plist·adapter | 충족 | `apps/cli/src/install.ts:195`→`D/launchd.ts:114`, `apps/cli/src/install/flow.ts:595`. `D/launchd.ts:8`·`:23`의 정확한 Label/ProgramArguments/RunAtLoad/KeepAlive, `:59` 이후 adapter의 gui/uid bootstrap. `T/daemon-launchd.test.ts:82`의 리터럴 Label 및 `:176`의 두 번 설치/한 번 bootstrap. Mac의 반복 setup·로그인·KeepAlive 행 통과. |
| E9-6: stop/start/status·갱신 재시작·최소 제거·doctor | 일부 | stop/start/status·제거·doctor는 Done 4와 동일하게 충족. `D/control.ts:110`의 재시작 후 기대 commit 관찰과 `install/flow.ts:620`의 연결은 구현됐으나 실제 Mac 갱신 전환은 미확인이다. 재시작 실패 복구에 DW-4·DW-5가 남아 있다. |

## 2. 남은 간극과 처리

- **10초 조건: 검증 후속 티켓 필요.** 실제 설치본에서 Stop hook 없이 쓴 파일의 저장 시각과 DB 반영 시각을 기록해 10초 이내인지 확인해야 한다(9.8 결과 보완). 더구나 `D/run.ts:284`는 진행 중 drain을 기다리고, `packages/core/src/queue/drain.ts:258`·`:350`의 handler는 시간 제한 없이 기다린다. 감시 묶음은 다음 회차를 예약할 뿐 중단시키지 않는다. README `:549`도 지연 연장을 인정한다. 따라서 정상 유휴 상태의 자동 시험 통과와 모든 부하에서의 10초 보장은 다르다. 닫으려면 적용 조건을 PO가 명시적으로 한정하고 그 조건을 Mac에서 측정하거나, 엄격한 상한이 필요하면 구현·부하 시험 후속을 해야 한다. 현재 원장의 DW-3/4/5에는 이 간극이 없다.
- **실제 갱신 전환: 검증 후속 티켓 필요.** 다음 플러그인 배포에서 기존 데몬 A가 도는 상태로 B를 설치하고, 설치 경고 여부·실행 PID·`daemon status.commit`·`installed.json.commit`이 B로 일치하는 결과를 남겨야 한다. `tooling/bootstrap/test/hook.test.ts:237`은 가짜 kill 뒤 관찰 timeout 경고를 확인하고, `:268`에서 새 프로세스를 시험이 직접 띄운다. 따라서 현재 자동 시험과 첫 설치 성공을 합쳐 실제 갱신 성공으로 간주할 수 없다.
- **DW-3: 해소, 현 상태 수용.** 원장 `deferred-work.md:192`는 9.7로 done이다. 현재 `D/launchd.ts:57`의 timeout 10,000 + SIGKILL, `T/daemon-launchd.test.ts:155`의 SIGTERM 무시 실행 파일 시험, `T/fixtures/fake-launchctl.sh`의 `trap '' TERM`이 해소 근거다. 9.2 계획의 옛 deferred 표시는 역사 기록이다.
- **DW-4: 열린 deferred-work, 후속 기능 티켓으로 관리.** `tooling/bootstrap/src/bootstrap.ts:390`은 installed commit이 ref와 같으면 설치기 전에 끝나고, `install/flow.ts:625`·`:635`는 재시작 실패 경고에도 새 완료 기록을 쓴다. 같은 ref SessionStart는 자동 복구하지 않는다. README `:622`에 `brain setup run` 수동 재시도가 안내돼 있다. pending restart를 보존해 같은 ref에서도 재시도하고 실패→다음 SessionStart 성공 시험을 더하면 닫힌다. 수동 복구가 있어 PO가 기록하고 수용할 수 있으나 완전 자동 회복은 아니다.
- **DW-5: 열린 deferred-work, 별도 후속 기능 티켓 필요.** `D/launchd.ts:124`가 먼저 디스크 plist를 바꾸고, 다음 등록에서는 변경 없음이 된다. 첫 `D/control.ts:121` bootout 실패 뒤 재설치는 `plistChanged: false`로 SIGTERM만 보내 launchd의 옛 실행 인자를 유지할 수 있다. 로드된 설정과 디스크 차이를 성공할 때까지 보존하거나 명시적으로 확인하고, 변경→bootout 실패→재설치→새 인자 로드 회귀 시험이 필요하다. 경로/실행 인자 변경과 제어 실패가 겹치는 제한된 경우이므로 위험을 기록해 후속 처리할 수 있다.
- **기존 검토에서 수용한 경계: 현 상태 수용 가능.** 9.1의 동시 stale 회수 경쟁·큰 벽시계 보정, 9.9의 단일 초대형 로그 줄/회전 없는 거절 프로세스 쓰기, 9.10의 수동 기동과 제거 경쟁은 계획의 기각/절충으로 남아 있다. 이번 점검에서 새 결함으로 재분류하지 않았으나, 단일 인스턴스·로그 크기를 모든 경쟁과 비정상 입력까지의 절대 보장으로 읽으면 문구를 한정해야 한다.

## 3. 에픽 문구와 구현 사이의 차이

- Description의 `setup upgrade` 재시작 표현은 현재 명령이 있다는 인상을 준다. E9-6·Boundaries·마지막 2026-10-27 결정이 우선하며, 현재는 공용 설치기의 bootstrap 갱신 경로만 구현됐고 명령은 epic-operations 소유다. 누락 기능으로 다시 요구할 사안이 아니라 문구 정합성 수정 대상이다.
- 초기 2026-10-27 결정의 「transcript와 [files] path 둘」과 Description의 「Brain이 맡은 파일 위치」는 마지막 같은 날짜 결정에서 철회됐다. 구현·README `:565`는 transcript만 감시한다. 이전 결정을 대체됨으로 표시하면 된다.
- 9.6 tickets.toml verify의 「명령 끝에 기회적 drain」은 9.6 Plan Change Log의 사람 결정과 다르다. 구현은 stop 자체에서 drain하지 않고 다음 일반 명령 또는 데몬 재기동에서 처리한다(`dispatch.ts:546`, README `:634`). 현재 의도는 구현과 맞으며 티켓 표현만 낡았다.
- Done 2/E9-3의 무조건적인 「10초 안」과 README `:549`·9.4 Residual risks의 「긴 drain이면 더 늦음」은 현재 미해소된 보장 수준 차이다. 단순 문구 정리로 조용히 낮추지 말고 PO 결정이 필요하다.
- 9.8은 `done`이지만 그 결과 표에는 10초 「일부」와 새 빌드 갱신 「미확인」이 남아 있다. 특히 9.6의 사람 결정이 실제 옛→새 전환을 9.8에 배정했으므로 상태 표시가 이 검증 책임을 대신하지 않는다.
- 2026-10-16의 소켓 생존/handshake·데몬 자체 업데이트 Notes는 2026-10-26 결정으로 V1 뒤로 밀린 역사 기록이다. 현재 heartbeat·bootstrap 갱신은 최신 결정과 일치한다. 예약 실패가 spool 대신 예약별 rollback인 것도 마지막 2026-10-27 결정과 일치한다.
- 「Core는 그대로」를 코드 무변경으로 읽으면 9.5의 ScheduleStore/tick/probe 추가와 다르다. FR-23 의미(프로세스·타이머·launchd는 Runtime 소유)로는 구현이 지킨다. 사용자 스케줄러·Drive source_sync·전체 제거·소켓/MCP는 후속 범위다.

## 4. 권고

**do not close — 실제 갱신 전환 증거와 10초 조건의 적용 범위·Mac 측정을 먼저 보완하자; 이를 명시적 후속 티켓/수용 결정으로 이관한다면 DW-4·5와 함께 기록한 뒤 close with recorded follow-ups로 바꿀 수 있다.**
