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
- **런타임**: 단일 인스턴스 잠금 `<home>/run/daemon.pid`(설치 잠금과 같은 규칙), SIGTERM 정상 종료, 로그 `<home>/log/daemon.log`(크기 회전 1MB×5), heartbeat `<home>/run/heartbeat`(mtime, 30초).
- **하는 일**: drain 반복(AD-21; Drive 동기화 `source_sync`도 이 일감), 로컬 파일 감시(transcript 폴더, Brain이 맡은 파일 위치; hook 없는 수집 보완), 시각이 된 일감을 `work_items`에 넣는 예약 틱(사용자 스케줄러가 다음 조각에 이 위에 붙는다). DB에 못 쓰면 같은 spool 형식을 구간마다 닫으며 쓴다(AD-9).
- **폴백과 운영**: 데몬이 살아 있으면(heartbeat 기준) 명령의 기회적 drain은 돌지 않고, 멈추면 기회적 drain과 SessionStart hook의 drain이 받친다(AD-7). `daemon stop`은 임시 정지(doctor `warn`), `daemon start`는 Label을 다시 올린다. `setup upgrade`가 데몬을 재시작한다. doctor는 데몬 생존과 마지막 heartbeat를 보이고 죽어 있으면 `warn`이다.
- **V1 뒤**(2026-10-26): `brain mcp serve`(AD-28), UNIX 소켓·handshake·`VERSION_MISMATCH`와 hook 클라이언트의 소켓 경로(AD-26), 데몬 스스로의 자동 업데이트(그동안은 SessionStart bootstrap이 `[update] auto`로 갱신), NDJSON 스트리밍, 세션 안 짧은 핸들.

## Outcome

Mac에 로그인하면 Brain이 늘 떠 있어, 수집·Drive 동기화·(다음 조각의) 예약 작업이 세션을 열지 않아도 돈다. 데몬이 멈춰도 수집은 계속된다.

## Requirements

인셉션 때 채운다. 원천: spine AD-25·AD-27(2026-10-26 판)과 AD-7·9·20·21의 데몬 조항. AD-26·28은 V1 뒤.

## Done when

1. 데몬을 멈춰도 모든 명령·hook이 동작하고, 밀린 일은 기회적 drain이 처리한다(epic 2·10·5·8의 테스트가 데몬 없이도 통과).
2. 데몬이 떠 있으면 Stop hook 없이 저장된 transcript가 N초(인셉션에서 정함) 안에 수집된다.
3. `setup upgrade` 뒤 데몬이 새 빌드로 다시 뜨고, 데몬 프로세스를 죽이면 launchd가 다시 띄운다.
4. 설치 뒤 데몬 Label 하나만 있고 `setup run`을 반복해도 하나다. doctor가 데몬 생존·heartbeat를 보이고 죽어 있으면 `warn`이다. `daemon stop` 뒤에는 기회적 drain이 돌고 `daemon start`가 데몬을 다시 올린다. `setup uninstall` 뒤 Label·pid·heartbeat·로그가 남지 않는다.
5. 데몬 안의 예약 틱이 시각이 된 일감 하나를 `work_items`에 넣고 drain이 처리한다(테스트용 일감으로 검증). 데몬이 꺼져 있던 동안 지난 시각의 일감은 다음 기동 때 한 번만 들어간다.

## Boundaries

AD-5·6·7·9·20·21·25·27. Core는 그대로다(FR-23: Core는 서버·프로세스를 소유하지 않는다 — 데몬은 Runtime). 사용자 스케줄러의 등록·목록·삭제, Telegram·원격 기계 수집·승인 대기는 이 에픽 밖(다음 조각). MCP(AD-28)와 소켓(AD-26, `DAEMON_UNAVAILABLE`·`SESSION_REQUIRED`·`VERSION_MISMATCH`)은 V1 뒤. watcher 지연 목표는 인셉션에서 정한다(spine Deferred).

## References

- parent — _bmad-output/personal-brain/initiative-personal-brain.md
- spec — _bmad-output/personal-brain/spec-brain-v1-slice-1/spec-brain-v1-slice-1.md, Capabilities CAP-10, CAP-11
- architecture — _bmad-output/personal-brain/architecture-brain-v1-slice-1/architecture-brain-v1-slice-1.md, AD-5, AD-25, AD-26, AD-27, AD-28, Conventions(설치·런타임 기록), Deferred
- inputs — _bmad-output/personal-brain/inputs/weknora-patterns.md, §2
- change — _bmad-output/personal-brain/change-surface-plugin-daemon/change-surface-plugin-daemon.md, §4.1, §6

## Notes

- Decision(2026-10-15): 데몬을 Deferred에서 에픽으로. 순서는 epic 5 다음, 7 앞(사용자). MCP는 데몬 없이 stdio로 먼저. 데몬은 `brain daemon run` 하위 명령(같은 빌드·shim). 데몬 없이도 전부 동작하는 것이 기준.
- Waits on epic-capture because: 명령 메타(`brain guide schema`), 설치 흐름(`setup run`·`setup upgrade`), doctor 틀, 플러그인 뼈대.
- Unknown(인셉션에서): 소켓 프레이밍, watcher 지연 목표 N초, hook 클라이언트 소켓 경로의 실측 이득(SM-7), 세션 안 짧은 핸들의 필요성.
- Note(2026-10-16, `../../change-users-and-review-gaps/`, 인셉션 입력, 원문은 `../../inputs/external-review-2026-10-16.md`):
  - D3: "데몬이 켜져 있다"는 살아 있는 소켓(handshake 응답)으로 판단한다. 설정 `[daemon] enabled`가 기준이 아니다. `daemon start`가 데몬 Label을 다시 올린다(spine AD-5·7·25·27).
  - D4: handshake 버전이 다르면 데몬은 `VERSION_MISMATCH`로 답하고, 자기 빌드가 `installed.json`의 `commit`과 다를 때만 종료한다(spine AD-26).
- Note(2026-10-16, 사용자): 자동 업데이트는 `[update] auto`(기본 true)를 따른다. true면 데몬이 `app-ref`가 앞선 것을 보고 설치 잠금 안에서 스스로 업그레이드하고 종료해 KeepAlive가 새 빌드로 띄운다(spine AD-27). false면 doctor `UPDATE_AVAILABLE`과 CLI 직접 갱신이다. D4(낡은 데몬만 종료)는 손으로 빌드한 경우 등을 막는 보조로 남는다.
- Note(2026-10-19, `../../change-masking-b-and-review-fixes/`, 인셉션 입력): 마스킹 B. 소켓·MCP 응답은 같은 엔벨로프 코덱을 쓰므로 따로 가리지 않는다(spine AD-11).
- Decision(2026-10-26, `../../change-v1-capture-and-drive/`, 사용자): 데몬은 V1의 기본 상주 런타임이고 Drive(epic 8)보다 먼저다. 사용자가 등록한 배치·예약 작업을 그 시각에 실행하고, Drive 주기 수집과 로컬 파일 감시를 맡는다. launchd는 데몬을 띄우고 다시 띄우는 데만 쓴다. 주기 LaunchAgent·두 Label 전환·`[daemon] enabled`는 없앴다. 데몬은 CLI가 아니라 Core를 직접 부른다. MCP·소켓·데몬 자동 업데이트는 V1 뒤. 아래 2026-10-16의 D3·D4와 자동 업데이트 Note는 소켓 경로와 함께 다음 조각에서 다시 본다.
- Note(2026-10-26, 트리 검증 제안, 인셉션 입력): `setup upgrade`의 공용 흐름은 epic 1·2가 만든 설치 흐름이고, 이 에픽은 데몬 재시작 단계만 더한다. epic 5는 그 흐름에 마이그레이션·백업을 보강한다. 이 에픽과 epic 10·5 사이에는 선행 경로가 없지만 Core 조립(`createBrain`), scan·drain, doctor, `setup upgrade`를 함께 건드리므로, 인셉션에서 공용 연결부의 첫 소유자를 정하고 필요하면 leaf `after`를 둔다. 표 순서대로 직렬로 만들면 충돌은 생기지 않는다.
