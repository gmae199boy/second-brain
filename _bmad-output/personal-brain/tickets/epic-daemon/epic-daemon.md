---
type: epic
title: "데몬(상주 런타임)"
parent: personal-brain
covers: [CAP-10, CAP-11]
after: ["epic-capture"]
assignee: ""
risk: medium
---

# 데몬(상주 런타임)

## Description

V1의 상주 런타임 하나를 더한다(2026-10-26, `../../change-v1-capture-and-drive/`, spine AD-25·27). 같은 빌드의 `brain daemon run`이고, CLI를 다시 띄우지 않고 프로세스 안에서 Core(`createBrain`, scan, drain)를 직접 부른다. hook과 명령은 지금처럼 단명 프로세스이고, 데몬이 멈춰도 모두 동작한다.

- **실행과 재시작**: 설치기(`setup run`, 플러그인 bootstrap이 부르는 같은 함수)가 LaunchAgent 하나(`<reverse-dns>.second-brain.daemon`, `RunAtLoad`·`KeepAlive`)를 등록해 로그인 때 띄우고 죽으면 다시 띄운다. 같은 Label이면 다시 등록하지 않고, `setup uninstall`이 지운다. epic 5를 기다리지 않고 이 에픽이 LaunchAgent 등록·제거를 직접 만든다. 주기 실행용 LaunchAgent는 두지 않는다.
- **런타임**: 단일 인스턴스 잠금 `<home>/run/daemon.pid`(원자적 생성, 살아 있는 pid는 나이와 상관없이 유지하고 죽은 pid만 회수), SIGTERM 정상 종료, 로그 `<home>/log/daemon.log`(크기 회전 1MB×5), heartbeat `<home>/run/heartbeat`(mtime, 30초).
- **하는 일**: drain 반복(AD-21; Drive 동기화 `source_sync`도 이 일감), 로컬 파일 감시(transcript 폴더, Brain이 맡은 파일 위치; hook 없는 수집 보완), 시각이 된 일감을 `work_items`에 넣는 예약 틱(사용자 스케줄러가 다음 조각에 이 위에 붙는다). DB에 못 쓰면 같은 spool 형식을 구간마다 닫으며 쓴다(AD-9).
- **폴백과 운영**: 데몬이 살아 있으면(heartbeat 기준) 명령의 기회적 drain은 돌지 않고, 멈추면 기회적 drain과 SessionStart hook의 drain이 받친다(AD-7). `daemon stop`은 임시 정지(doctor `warn`), `daemon start`는 Label을 다시 올린다. `setup upgrade`가 데몬을 재시작한다. doctor는 데몬 생존과 마지막 heartbeat를 보이고 죽어 있으면 `warn`이다.
- **V1 뒤**(2026-10-26): `brain mcp serve`(AD-28), UNIX 소켓·handshake·`VERSION_MISMATCH`와 hook 클라이언트의 소켓 경로(AD-26), 데몬 스스로의 자동 업데이트(그동안은 SessionStart bootstrap이 `[update] auto`로 갱신), NDJSON 스트리밍, 세션 안 짧은 핸들.

## Outcome

Mac에 로그인하면 Brain이 늘 떠 있어, 수집·Drive 동기화·(다음 조각의) 예약 작업이 세션을 열지 않아도 돈다. 데몬이 멈춰도 수집은 계속된다.

## Requirements

- E9-1 (CAP-10·11): 상주 프로세스 — `brain daemon run`이 같은 빌드에서 Core(`createBrain`, scan, drain)를 직접 부르고 stdout 엔벨로프를 내지 않는다. `<home>/run/daemon.pid`로 한 번에 하나만 뜨며, 살아 있는 pid의 잠금은 나이와 상관없이 빼앗지 않고 죽은 pid의 잠금만 회수한다. SIGTERM에 정상 종료하고 끝나면 pid를 지운다. 로그는 `<home>/log/daemon.log`(1MB×5 회전), heartbeat는 `<home>/run/heartbeat` mtime 30초. (AD-5·19·27)
- E9-2 (CAP-11): 생존 판단과 폴백 — heartbeat mtime이 90초(간격의 3배) 안이면 살아 있다는 판단 함수 하나를 기회적 drain 생략과 doctor가 함께 쓴다. 살아 있으면 명령의 기회적 drain을 건너뛰고, 죽었거나 멈췄으면 기회적 drain과 SessionStart drain이 받친다. 데몬이 없어도 모든 명령·hook이 동작한다. (AD-7·25)
- E9-3 (CAP-11): drain과 파일 감시 — 데몬이 drain을 반복하고, Claude transcript 폴더(connector가 찾는 폴더, 기본 `~/.claude/projects`)를 감시해 변경을 2초 모은 뒤 기존 scan 경로로 넘긴다. 기동할 때 scan을 한 번 돌려 꺼져 있던 동안의 변경을 메운다. Stop hook 없이 저장된 transcript는 10초 안에 수집된다. DB에 못 쓴 transcript 수집은 기존 spool로 남긴다(새 spool 종류는 없다). (AD-9·21·23·27)
- E9-4 (CAP-11): 예약 틱 — 마이그레이션 0009가 예약 테이블(일감 종류·대상·반복 간격(초, 없으면 한 번)·다음 시각·마지막 실행 시각)을 만든다. 틱은 시각이 된 예약의 일감을 `work_items`에 넣고 마지막 실행 시각과 다음 시각(실행 시점 + 간격, 한 번짜리는 끝남)을 같은 트랜잭션에서 갱신한다. 놓친 회차는 하나로 합쳐 데몬이 꺼져 있던 동안 지난 예약도 다음 기동 때 한 번만 들어간다. DB에 못 쓰면 트랜잭션이 되돌려져 예약이 시각 지남으로 남고, DB가 돌아오면 한 번 들어간다. 사용자가 예약을 등록·조회·삭제하는 명령은 만들지 않는다(다음 조각). (AD-21·27, Table Contract)
- E9-5 (CAP-11): launchd 등록 — 공용 설치 함수(`setup run`, 플러그인 bootstrap)가 Label `io.github.gmae199boy.second-brain.daemon`의 plist(`~/Library/LaunchAgents/`, `RunAtLoad`·`KeepAlive`, shim으로 `brain daemon run`)를 `launchctl bootstrap gui/<uid>`로 하나만 등록하고, 다시 실행해도 하나다. launchctl 호출은 감싼 adapter를 거쳐 테스트에서 가짜로 바꾼다. (AD-25)
- E9-6 (CAP-11): 운영 — `daemon stop`(KeepAlive부터 내려 임시 정지)·`daemon start`(Label 다시 적재)·`daemon status`(생존·pid·마지막 heartbeat). 플러그인 bootstrap 갱신이 끝날 때 데몬을 새 빌드로 다시 띄우는 재시작 단계를 만든다(`setup upgrade` 명령은 epic-operations가 만들고 같은 단계를 부른다). 최소 `setup uninstall`이 데몬 흔적(Label·plist·pid·heartbeat·로그)만 지운다. doctor가 생존과 마지막 heartbeat를 보이고, 죽었거나 멈췄으면 `warn`이다. (AD-5·20·27)

## Done when

1. 데몬을 멈춰도 모든 명령·hook이 동작하고, 밀린 일은 기회적 drain이 처리한다(이 에픽이 끝날 때 있는 epic 1·2·10의 테스트가 데몬 없이도 통과. epic 5·8은 다듬을 때 같은 확인을 Done when에 이어받는다, 2026-10-27).
2. 데몬이 떠 있으면 Stop hook 없이 저장된 transcript가 10초 안에 수집된다(2026-10-27).
3. 플러그인 bootstrap 갱신 뒤 데몬이 새 빌드로 다시 뜨고, 데몬 프로세스를 죽이면 launchd가 다시 띄운다.
4. 설치 뒤 데몬 Label 하나만 있고 `setup run`을 반복해도 하나다. doctor가 데몬 생존·heartbeat를 보이고 죽어 있으면 `warn`이다. `daemon stop` 뒤에는 기회적 drain이 돌고 `daemon start`가 데몬을 다시 올린다. `setup uninstall` 뒤 Label·pid·heartbeat·로그가 남지 않는다.
5. 데몬 안의 예약 틱이 시각이 된 일감 하나를 `work_items`에 넣고 drain이 처리한다(테스트용 일감으로 검증). 데몬이 꺼져 있던 동안 지난 시각의 일감은 다음 기동 때 한 번만 들어간다.
6. 이 에픽의 기능 묶음이 플러그인 배포(`plugin/app-ref`·`version`)로 이 Mac의 설치본에 들어가, 로그인 뒤 데몬이 떠 있고 heartbeat가 갱신되며 Stop hook 없이 저장된 transcript가 수집된다(2026-10-27).

## Boundaries

AD-5·6·7·9·20·21·25·27. Core는 그대로다(FR-23: Core는 서버·프로세스를 소유하지 않는다 — 데몬은 Runtime). 사용자 스케줄러의 등록·목록·삭제, Telegram·원격 기계 수집·승인 대기는 이 에픽 밖(다음 조각). MCP(AD-28)와 소켓(AD-26, `DAEMON_UNAVAILABLE`·`SESSION_REQUIRED`·`VERSION_MISMATCH`)은 V1 뒤. 전체 `setup uninstall`(hook·shim·`installed.json` 정리, 데이터 삭제 확인)은 V1 뒤 epic-operations이고, 이 에픽은 데몬 흔적만 지운다(2026-10-27). `setup upgrade` 명령과 그 백업·마이그레이션 단계는 epic-operations가 만들고, 이 에픽의 재시작 단계를 부른다(2026-10-27). `[files] path` 감시는 V1에서 하지 않는다(필요해지면 epic-drive가 더한다, 2026-10-27).

## References

- parent — _bmad-output/personal-brain/initiative-personal-brain.md
- spec — _bmad-output/personal-brain/spec-brain-v1-slice-1/spec-brain-v1-slice-1.md, Capabilities CAP-10, CAP-11
- architecture — _bmad-output/personal-brain/architecture-brain-v1-slice-1/architecture-brain-v1-slice-1.md, AD-5, AD-25, AD-26, AD-27, AD-28, Conventions(설치·런타임 기록), Deferred
- inputs — _bmad-output/personal-brain/inputs/weknora-patterns.md, §2
- change — _bmad-output/personal-brain/change-surface-plugin-daemon/change-surface-plugin-daemon.md, §4.1, §6
- change — _bmad-output/personal-brain/change-v1-capture-and-drive/change-v1-capture-and-drive.md, §4.1, §4.6
- research — _bmad-output/personal-brain/tickets/epic-daemon/epic-daemon-research-sources.md
- research — _bmad-output/personal-brain/tickets/epic-daemon/epic-daemon-research-code.md

## Notes

- Decision(2026-10-15): 데몬을 Deferred에서 에픽으로. 순서는 epic 5 다음, 7 앞(사용자). MCP는 데몬 없이 stdio로 먼저. 데몬은 `brain daemon run` 하위 명령(같은 빌드·shim). 데몬 없이도 전부 동작하는 것이 기준.
- Waits on epic-capture because: 명령 메타(`brain guide schema`), 설치 흐름(`setup run`·`setup upgrade`), doctor 틀, 플러그인 뼈대.
- Unknown(V1 뒤로): 소켓 프레이밍, hook 클라이언트 소켓 경로의 실측 이득(SM-7), 세션 안 짧은 핸들의 필요성. watcher 지연 N초는 2026-10-27에 정했다.
- Note(2026-10-16, `../../change-users-and-review-gaps/`, 인셉션 입력, 원문은 `../../inputs/external-review-2026-10-16.md`):
  - D3: "데몬이 켜져 있다"는 살아 있는 소켓(handshake 응답)으로 판단한다. 설정 `[daemon] enabled`가 기준이 아니다. `daemon start`가 데몬 Label을 다시 올린다(spine AD-5·7·25·27).
  - D4: handshake 버전이 다르면 데몬은 `VERSION_MISMATCH`로 답하고, 자기 빌드가 `installed.json`의 `commit`과 다를 때만 종료한다(spine AD-26).
- Note(2026-10-16, 사용자): 자동 업데이트는 `[update] auto`(기본 true)를 따른다. true면 데몬이 `app-ref`가 앞선 것을 보고 설치 잠금 안에서 스스로 업그레이드하고 종료해 KeepAlive가 새 빌드로 띄운다(spine AD-27). false면 doctor `UPDATE_AVAILABLE`과 CLI 직접 갱신이다. D4(낡은 데몬만 종료)는 손으로 빌드한 경우 등을 막는 보조로 남는다.
- Note(2026-10-19, `../../change-masking-b-and-review-fixes/`, 인셉션 입력): 마스킹 B. 소켓·MCP 응답은 같은 엔벨로프 코덱을 쓰므로 따로 가리지 않는다(spine AD-11).
- Decision(2026-10-26, `../../change-v1-capture-and-drive/`, 사용자): 데몬은 V1의 기본 상주 런타임이고 Drive(epic 8)보다 먼저다. 사용자가 등록한 배치·예약 작업을 그 시각에 실행하고, Drive 주기 수집과 로컬 파일 감시를 맡는다. launchd는 데몬을 띄우고 다시 띄우는 데만 쓴다. 주기 LaunchAgent·두 Label 전환·`[daemon] enabled`는 없앴다. 데몬은 CLI가 아니라 Core를 직접 부른다. MCP·소켓·데몬 자동 업데이트는 V1 뒤. 아래 2026-10-16의 D3·D4와 자동 업데이트 Note는 소켓 경로와 함께 다음 조각에서 다시 본다.
- Note(2026-10-26, 트리 검증 제안, 인셉션 입력): `setup upgrade`의 공용 흐름은 epic 1·2가 만든 설치 흐름이고, 이 에픽은 데몬 재시작 단계만 더한다. epic 5는 그 흐름에 마이그레이션·백업을 보강한다. 이 에픽과 epic 10·5 사이에는 선행 경로가 없지만 Core 조립(`createBrain`), scan·drain, doctor, `setup upgrade`를 함께 건드리므로, 인셉션에서 공용 연결부의 첫 소유자를 정하고 필요하면 leaf `after`를 둔다. 표 순서대로 직렬로 만들면 충돌은 생기지 않는다.
- Decision(2026-10-27, 다듬기, 사용자): 열린 항목 아홉을 추천대로 정했다.
  - 감시 지연 N = 10초. 변경을 2초 모아 기존 scan 경로로 넘기고, 기동할 때 scan을 한 번 돌린다.
  - 감시 대상은 Claude transcript 폴더와 `[files] path` 둘. 감시 이벤트는 직접 수집하지 않고 scan으로 넘긴다.
  - 예약은 새 테이블 하나(마이그레이션 0009)에 두고, 일감 넣기와 마지막 실행 갱신을 한 트랜잭션으로 묶는다. epic 9가 epic 8보다 먼저라 0009를 쓰고, epic 8의 source 메타 마이그레이션은 그다음 번호다. epic 3은 착수 때 번호를 다시 정한다(epic-log-and-context Notes 2026-10-26).
  - 생존은 heartbeat 90초(간격의 3배) 안. 판단 함수 하나를 drain 생략과 doctor가 함께 쓴다.
  - pid 잠금은 죽은 pid만 회수한다. 설치 잠금의 30분 회수 규칙은 가져오지 않는다(정상 상주 데몬의 잠금을 빼앗아 둘이 뜨기 때문).
  - Label `io.github.gmae199boy.second-brain.daemon`, plist는 `~/Library/LaunchAgents/`, `launchctl bootstrap gui/<uid>`. 자동 테스트는 launchctl adapter의 가짜로, 이 Mac의 재기동·멱등·제거 실증은 hitl 스토리 하나로 한다.
  - V1 `setup uninstall`은 데몬 흔적만 지운다. 전체 제거는 V1 뒤.
  - 공용 연결부(Core 조립, 설치·갱신 흐름의 재시작 단계)의 첫 소유자는 이 에픽이다. 표 순서대로 직렬로 만들므로 epic 10·5와 leaf `after`는 두지 않는다.
  - Done when 6(플러그인 배포로 이 Mac 설치본에서 동작)을 더했다(이니셔티브 Note 2026-10-26).
  - drain·틱 간격, 종료 순서, 잠금 파일 형식 같은 상수는 각 스토리가 정한다.
- Source conflict: spine AD-7(L167)은 데몬 생존을 "heartbeat 간격 안"으로, AD-25(L393)의 doctor는 "간격 3배 초과"로 다르게 적는다 — 이 에픽은 90초 하나로 맞춘다(2026-10-27).
- Source conflict: spine AD-5(L130)는 `setup uninstall` 전체를 V1 뒤로 두지만 이 에픽 Done when 4는 데몬 정리를 요구한다 — change-v1 §4.6(L327–335)대로 데몬 흔적만 V1 최소 경로로 둔다(2026-10-27).
- Source conflict: change-v1 L346은 마이그레이션 0009를 epic 8이 먼저 쓴다고 적는다 — epic 9가 0009를 쓰고 epic 8은 다음 번호(2026-10-27).
- Source conflict: spine Deferred(L603)의 MCP "해소: epic 9"와 L605의 짧은 핸들 "인셉션"은 2026-10-26의 V1 뒤 결정이 우선한다.
- Note(2026-10-27, 코드 조사): launchd·plist·파일 감시·heartbeat·로그 회전 코드는 아직 없다. spool은 append마다 파일을 닫으므로(`apps/cli/src/runtime/spool.ts`) spine AD-9의 "데몬은 60초 또는 1,000줄마다 닫는다"는 이미 지켜진다. `work_items`의 시각 칸은 `next_attempt_at`이고 `source_sync` 종류는 없다(epic-drive가 더한다).
- Note(2026-10-27, 분담): E9-1은 9.1과 9.9(로그 회전)로, E9-3은 9.1의 반복 drain·spool과 9.4의 감시·scan 연결로, E9-6은 9.3의 status·doctor, 9.6의 stop·start·재시작, 9.10의 최소 `setup uninstall`로 나눈다. 9.8은 E9-3·5·6의 설치본 실증을 맡고 9.7은 기능 추가 없이 정리만 한다.
- Decision(2026-10-27, 스토리 쪼개기, 사용자): tracer는 9.1(`brain daemon run`이 떠서 밀린 일감을 처리한다)이다. 에픽의 모든 층을 지나는 규칙의 예외로 launchd 층을 빼고 런타임만 지난다. launchd를 넣으면 첫 스토리가 사람 확인이 되어 무인 loop가 시작하자마자 멈추고, 실제 launchd 확인은 9.8이 맡기 때문이다. 다음은 덜 확실한 launchd 등록(9.2)이다.
- Decision(2026-10-27, 세트 점검 뒤, 사용자): (1) 데몬 재시작은 플러그인 bootstrap 갱신 경로에만 붙이고 `setup upgrade` 명령은 epic-operations가 만들어 같은 단계를 부른다 — 코드에 `setup upgrade`가 없어 어제의 "기존 흐름에 재시작만 더한다" 전제가 성립하지 않았다. (2) Done when 1은 지금 있는 epic 1·2·10 테스트만 책임지고 epic 5·8이 이어받는다. (3) `[files] path` 감시는 뺀다 — scan은 transcript만 다루고 그 폴더 변경에 할 일이 정해져 있지 않다(어제 결정의 일부를 되돌림). (4) 예약은 한 번 또는 N초 반복, 놓친 회차는 하나로 합치고 다음 시각은 실행 시점 + N. (5) DB에 못 쓰면 transcript 수집만 기존 spool을 쓰고, 예약 틱은 트랜잭션 되돌림으로 다시 시도한다. (6) 로그 회전(9.9)과 최소 `setup uninstall`(9.10)을 떼어 냈다. (7) `plan_checkpoint`는 9.2와 9.5에만 건다. `done_checkpoint`는 두지 않는다.
