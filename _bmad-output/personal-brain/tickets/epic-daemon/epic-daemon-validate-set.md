<!-- 2026-10-27 epic-daemon 초안 세트 점검(codex 워커). 이 보고 뒤 fix 3건을 반영했고, ask 5건과 크기 제안은 사용자가 추천대로 정했다(epic Notes 2026-10-27 Decision). -->

# epic-daemon 초안 validate-set

2026-10-27. 범위: `validate-checks.md`의 Ticket·Set·Dependencies 및 `ticket.md`의 Rules the template cannot carry. 8개 미pull entry 전체를 검사했다. 구현 검증이 아닌 분해 검증이다. **판정: 아래 fix와 ask를 정리한 뒤 제시 권고.**

## fix

1. **[Ticket: 상위·결정과 일치 / 9.1] 잠금 설명의 오래된 전제.** epic Description은 여전히 “설치 잠금과 같은 규칙”이라고 하지만 E9-1·10/27 결정은 살아 있는 pid를 시간으로 회수하지 않는다. epic Description의 해당 구절을 정확히 다음으로 교체:
   > 단일 인스턴스 잠금 `<home>/run/daemon.pid`(원자적 생성, 살아 있는 pid는 나이와 상관없이 유지하고 죽은 pid만 회수)

2. **[Set: 공유 covers의 분담 / 9.1·9.3·9.4·9.6·9.7·9.8] 실제 제공과 검증을 구분.** 9.1이 E9-3의 반복 drain·spool 부분을 제공하고 9.3이 E9-6의 status·doctor를 제공하지만 covers에는 빠졌다. 정확한 교체:
   - 9.1: `covers = ["E9-1", "E9-3"]`
   - 9.3: `covers = ["E9-2", "E9-6"]`
   - 9.7: `covers = []` (새 요구사항 제공 없이 정리만 한다.)
   epic Notes에 다음 줄 추가:
   > Note(2026-10-27, 분담): E9-3은 9.1의 반복 drain·spool과 9.4의 두 감시 루트·scan 연결로 나누고, E9-6은 9.3의 status·doctor와 9.6의 stop·start·갱신·제거로 나눈다. 9.8은 E9-3·5·6의 설치본 실증을 맡고 9.7은 기능 추가 없이 정리만 한다.

3. **[Dependencies: Handoffs / 9.1→9.3] 제공자 쪽 설명 누락.** 9.1은 3·4·5 확장을 말하지만 9.3이 필요로 하는 pid·heartbeat 입력 계약을 이름 붙이지 않았다. 9.1 description의 “이 상주 루프와 Core 조립 자리가 3·4·5가 확장할 경계다.”를 교체:
   > 이 상주 루프와 Core 조립 자리는 4·5가 확장한다. pid·heartbeat 기록은 3의 공용 생존 판단과 status·doctor가 읽는다.

## suggest

1. **[Ticket: 비구현자가 실행할 verify / 9.1~9.6] 검증 접근과 runnable 기준을 구분.** 현재는 초안 entry이므로 긴 verify 문장 자체나 full criteria 부재는 위반이 아니다. 다만 “미리 넣어 둔 일감”, “가짜 adapter”, “fake clock”은 실행 진입점 없이 비구현자가 재현할 수 없다. 각 entry를 pull할 때 임시 home 준비·실행 명령·관찰 결과를 가진 검증 스크립트 또는 정확한 테스트 명령 하나를 정하고, full criteria는 하나의 자극과 관찰 결과 단위로 나눈다. 특히 9.1의 잠금/종료/회전, 9.5의 원자성/재기동을 한 기준으로 뭉치지 않는다. 초안 단계에서 테스트 파일명을 임의로 만들 필요는 없다.

2. **[Ticket: 전체 잘못된 구현을 가려내는 기준 / Set: Done when / 9.3·9.4·9.5·9.6] 알려진 실패 경로도 검증 목록에 넣기.** 9.3은 미래 heartbeat·죽은 pid·정확히 90초 경계, 9.4는 `[files] path` 이벤트·watch 실패·없는 폴더·지속 이벤트 중 10초 상한, 9.5는 재기동 후 다시 tick해도 추가 중복 없음, 9.6은 bootstrap 갱신과 직접 upgrade 각각의 새 build 신원 확인이 빠져 있다. 9.6의 “재시작 호출 한 번”만으로 새 빌드 실행은 증명되지 않으며 9.8 실증이 그 공백 일부를 메운다.

3. **[Ticket: 한 agent session 크기 / 9.1·9.6] 분해 또는 명시적 경계 권고.** 9.1은 명령 런타임 조립·상주 루프·멀티프로세스 잠금·정상 종료·heartbeat·로그 회전을 모두 신규 구현한다. 9.6은 프로세스 제어·두 갱신 진입점·새 upgrade 표면·제거와 데이터 보존을 함께 다룬다. 세션 초과 위험이 높다. 9.1의 로그 회전을 별도 후속 항목으로, 9.6의 최소 upgrade 생성과 제거를 별도 항목으로 나누는 방안을 권고한다. 크기 확정은 아래 tracer 결정 후 한다.

4. **[Dependencies: Collisions·Shared setup / 9.2·9.3·9.4·9.5·9.6] 계획에 쓰기 경계 고정.** 9.4→9.5는 같은 상주 루프를 고치므로 `after = [1, 4]`가 올바르다. 나머지 독립 쌍의 동일 파일 수정은 초안만으로 확정할 수 없다. 9.2·9.3은 설치 후 doctor 연결, 9.4·9.6은 데몬 조립/종료 연결에서 겹칠 가능성이 있으므로 계획에 소유 모듈을 고정하고 같은 파일이면 실제 소비 관계에 맞춰 after 추가 또는 병합한다. 추정만으로 모든 항목을 직렬화하지 않는다. epic 10·5와의 공유는 10/27에 사용자가 표 순서 직렬·9 첫 소유로 결정했으므로 새로운 cross-epic after를 기계적으로 요구하지 않는다. 그래프만으로 병렬 실행하면 이 결정이 보존되지 않는다는 운영 제약은 남는다.

5. **[Ticket: risk 이유·고위험 추가 검사 / 9.1·9.2·9.5, 위험 재고: 9.6] 이유와 추가 검사 명시.** entry risk는 모두 있으나 한 줄 이유, high의 기준 외 추가 검사 Notes는 없다. 권고 추가 검사는 9.1 동시 기동 경쟁, 9.2 특수문자/공백 shim 경로와 등록 실패 복구, 9.5 기존 v8 데이터 보존이다. 9.6은 제거·기존 설치 변경을 다루므로 단순 medium 연결 작업으로 리뷰를 생략하지 않도록 위험을 사용자와 확정한다. validate-set 전체 재실행은 요구하지 않고 이 고위험 항목만 재확인한다.

## ask

1. **[Set: Tracer bullet·날짜 있는 sequencing Decision / 9.1·9.2·9.4·9.5·9.8] tracer 범위를 정해야 한다.** 첫 entry는 CLI→Runtime→Core→SQLite drain만 통과하며 launchd 설치·감시·예약 층은 남긴다. setup을 사람이 실행하는 hitl 단계도 없고 `hitl = false`다. 이는 규정된 “에픽이 건드리는 모든 층” tracer에 못 미친다. **추천:** 각 층의 최소 연결과 임시 home 실행을 첫 hitl tracer로 재절단하고, 잠금·로그·운영의 강화는 후속으로 둔다. 가벼운 데몬이라는 목적상 현재 얇은 Runtime tracer를 유지하려면 사용자 예외 결정을 받는다. 선택 후 epic Notes에 tracer entry와 선택한 순서 이유를 담은 날짜 있는 `Decision:`을 쓴다. 현재 10/27 Decision은 공용부 소유권을 정했지만 tracer를 이름 붙이지 않는다.

2. **[Dependencies: Needs / Set: epic에서 기준을 작성할 수 있음 / 9.6, Done when 3] `setup upgrade` 첫 구현의 소유자.** 코드 조사 §4와 현재 `apps/cli/src/commands/index.ts:31` 모두 upgrade가 없음을 확인했다. 2.4·2.5는 설치기/플러그인 갱신을 제공할 뿐 명령 upgrade는 만들지 않는다. 따라서 “이미 있는 공용 upgrade 흐름에 재시작만 추가”라는 전제는 성립하지 않는다. **추천:** epic에서 9가 V1 최소 `setup upgrade` 명령과 공용 갱신 진입점을 만든다고 결정하고, 목표 ref·설치 잠금·실패 계약·새 빌드 확인을 epic에 명시한 뒤 별도 entry로 분리한다. epic 5 대기를 추가하면 사용자의 9 선행 결정과 충돌하므로 자동 해결하지 않는다.

3. **[Set: Done when / Dependencies: check의 선행 조건 / 9.3·9.7, Done when 1] 아직 만들지 않은 에픽의 테스트를 언제 증명할지.** Done when 1은 epic 2·10·5·8 테스트 통과를 요구하지만 9는 10·5·8보다 먼저다. 현재 9.3은 2·10만 언급해 5·8의 증거 소유자도 없다. **추천:** epic 9 종료 시점에는 존재하는 2·현재 코드의 무데몬 회귀를 검증하고, 이후 epic 10·5·8이 각자 같은 무데몬 회귀를 이어받도록 epic/initiative에 결정한다. 9.7 전체 테스트 통과만으로 미래 테스트까지 검증됐다고 처리하지 않는다. 역방향 after를 넣으면 구현 순서/사이클 문제가 생긴다.

4. **[Set: epic에서 기준 작성 가능 / Dependencies: Needs / 9.4·9.5] 파일 감시 결과와 예약 주기 계약.** 9.4는 두 루트를 감시하지만 현재 `packages/core/src/capture/scan.ts:128`은 transcript만 다룬다. `[files] path` 변경 시 무엇이 관찰돼야 하는지(기존 파일 재검사·재추출인지, 새 파일 수집인지)와 사용 가능한 scan 경로를 epic에서 정해야 한다. 9.5 테이블은 다음/마지막 시각만 명시하고 verify는 “세 주기”를 가정한다. 틱 호출 간격을 builder가 정할 수 있다는 결정만으로 예약별 반복 규칙은 정해지지 않는다. **추천:** 파일은 기존 관리 파일 재검사로 한정하고, 예약의 반복/일회성·다음 시각 산출 입력·missed 회차 합치기 규칙을 epic에 고정한다. 스키마·다른 소비자 계약을 한 세션이 임의로 추정하지 않게 한다.

5. **[Ticket: 상위 요구사항 일치 / Dependencies: Shared setup / 9.1·9.4·9.5] DB 불가 때 spool의 대상.** 기존 spool은 session_ingest/failure/attachment_link만 지원한다(코드 조사 §7). 임의 예약 enqueue를 보존하는 범용 레코드는 없다. **추천:** transcript 수집 실패는 기존 spool을 쓰고, 예약 tick은 트랜잭션 롤백으로 due 상태를 유지해 DB 회복 후 한 번 발행하는 것으로 epic에 명시한다. E9-3의 “DB에 못 쓰면 spool”을 모든 scan/enqueue 실패까지 뜻한다면 새 spool 계약과 소유 entry가 필요하다. 어느 해석인지 먼저 정한다.

## 확인된 것

- 상태 명령 성공: 8개 모두 planned, file null, next_id 9. cycle·drift 진단 없음, `unpinned_after = []`, `undeclared_after = []`, `order_conflict = []`. 기본 uv 캐시 읽기 제한 후 임시 캐시 경로로 실행했다.
- E9-1~6 모두 실제 기능 description이 있다. 없는 covers id·미완성 placeholder·추가 full criteria를 당장 요구하는 bug/refine entry는 없다.
- 9.1의 2.11·2.12는 drain·scan, 9.2의 2.4·2.5는 공용 설치·bootstrap의 실제 전제다. epic-capture 전체 gate도 있다. 미래 epic 10·5를 9의 선행으로 추가할 근거는 없다.
- 9.7은 cleanup-only이고 1~6 모두를 기다린다. 9.8은 7을 거쳐 전 기능을 기다리며 사람이 할 설치본 실증을 명시한 hitl이다.
- Done when 2~6은 제공 entry가 있다. **Done when 1은 미래 에픽 테스트까지 포함한 문장 전체를 현 시점에 닫을 entry가 없다.**
- 10/27 결정은 90초·죽은 pid만 회수·0009·고정 Label·데몬만 제거·기능 묶음 배포를 정했다. 9.8의 app-ref 이전 커밋 고정과 version 동반 상승은 저장소 정책과 맞는다.
- 저장소 파일은 수정하지 않았다. 실제 launchd·빌드·제품 테스트·배포는 실행하지 않았다. 추가 확정 코드 열람은 upgrade 존재 및 scan 소비 경로 확인으로 한정했다.

## 커버리지

| 상위 항목 | 제공 entry | 판단/남은 확인 |
| --- | --- | --- |
| E9-1 | 9.1 | 프로세스·잠금·종료·로그·heartbeat |
| E9-2 | 9.3, 9.6 | 공용 생존 판단·폴백 / stop 후 폴백 |
| E9-3 | 9.1, 9.4; 실증 9.8 | 반복 drain·spool / 두 루트 감시. files 변경 결과·DB 불가 계약 ask |
| E9-4 | 9.5 | 0009·원자적 enqueue·재기동. 반복 규칙 ask |
| E9-5 | 9.2; 실증 9.8 | 공용 설치·LaunchAgent·멱등 |
| E9-6 | 9.3, 9.6; 실증 9.8 | status·doctor / 제어·갱신·제거. upgrade 생성 소유 ask |
| Done when 1 | 9.3, 9.6, 9.7 | 현재 회귀 일부만. 미래 epic 5·8 등 테스트 인수 필요 |
| Done when 2 | 9.4, 9.8 | 무hook transcript 10초 |
| Done when 3 | 9.2, 9.6, 9.8 | KeepAlive·두 갱신 경로. upgrade 전제 ask |
| Done when 4 | 9.2, 9.3, 9.6, 9.8 | Label 1개·doctor·stop/start·데몬 흔적 제거 |
| Done when 5 | 9.5 | 테스트 일감 drain·재기동 1회 |
| Done when 6 | 9.8 | 플러그인 배포·이 Mac 로그인·heartbeat·무hook 수집 |

9.7은 모든 기능의 정리를 담당하지만 누락된 기능·미래 검증의 대체 제공자로 계산하지 않았다.
