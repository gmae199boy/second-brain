---
type: epic
title: "데몬과 MCP 표면"
parent: personal-brain
covers: [CAP-10, CAP-11]
after: ["epic-operations", "epic-capture"]
assignee: ""
risk: medium
---

# 데몬과 MCP 표면

## Description

같은 빌드 안에 두 번째·세 번째 런타임을 더한다. 데몬이 없을 때의 동작(epic 2·10·3·4·5)이 기준이고, 데몬이 꺼져 있어도 모든 명령·hook·launchd 경로가 그대로 동작한다.

- **`brain mcp serve`(stdio)**: AD-5의 명령 메타에서 도구 이름(`<ns>_<verb>`)·입력 스키마·설명을 만든다. 쓰기 verb는 `session` 인자(시작 맥락 머리말의 토큰 줄)가 없으면 `SESSION_REQUIRED`다. 세션 토큰 출처의 우선순위는 명시 인자 > 소켓 요청 필드 > 환경 변수(AD-4). 플러그인 `.mcp.json`은 `${CLAUDE_PLUGIN_ROOT}`의 래퍼를 가리키고 래퍼가 shim을 exec한다. 결과는 CLI와 같은 엔벨로프를 `content`에 담고 `ok: false`면 `isError`다. 데몬이 필요 없다.
- **`brain daemon run`**: UNIX 소켓 `<home>/run/brain.sock`(0600). 요청 `{ns, verb, args, session?}`, 응답은 CLI와 같은 엔벨로프(코덱은 Core). 첫 메시지는 handshake `{build: <commit>, schema_version}`(빌드 신원, AD-19). 다르면 `VERSION_MISMATCH`로 답하고, 자기 빌드가 `installed.json`의 `commit`과 다를 때만 정상 종료해 KeepAlive가 새 빌드로 다시 띄운다(클라이언트가 낡았으면 데몬은 살아 있다, AD-26, 2026-10-16). 단일 인스턴스 잠금 `<home>/run/daemon.pid`(설치 잠금과 같은 규칙), 잠금 뒤 남은 소켓 unlink, SIGTERM 정상 종료, 로그 `<home>/log/daemon.log`(크기 회전 1MB×5), heartbeat `<home>/run/heartbeat`(mtime, 30초). drain 루프(AD-21)와 transcript 폴더 watcher(hook 없는 수집 보완)를 돈다. DB에 못 쓰면 같은 spool 형식을 구간(60초 또는 1,000줄)마다 닫는다(AD-9).
- **hook 클라이언트**(shim → `bin.js`)는 소켓이 있으면 거기로 보내고, 없거나 `VERSION_MISMATCH`면 프로세스 안에서 처리한 뒤 경고 `DAEMON_UNAVAILABLE`을 붙인다. 데몬이 살아 있으면(소켓 handshake가 응답하면) CLI의 기회적 drain은 꺼진다(AD-7).
- **설치기·운영**: 설정 `[daemon] enabled`(AD-18)가 주기 실행의 주인이다. `setup run`·`setup upgrade`가 두 LaunchAgent Label(주기 `…drain`, 데몬 `…daemon` KeepAlive)의 적재 상태를 설정과 일치시킨다(epic 5가 만든 같은 함수에 데몬 Label을 더한다). `daemon stop`은 임시 정지이고 doctor `warn`이다. `daemon start`가 데몬 Label을 다시 올린다(2026-10-16). `setup upgrade`가 데몬을 재시작하고, `setup uninstall`이 두 Label·`run/`·`log/`를 지운다. doctor는 데몬 생존·소켓 응답·버전 일치·마지막 heartbeat를 보인다.
- **조건부 흡수**(`inputs/weknora-patterns.md` §2): NDJSON 스트리밍(긴 작업 진행), 데몬의 세션 안 짧은 핸들(`L12`·`M34` 별칭 — AD-8대로 내부 UUID가 아니라 데몬이 harness 세션별로 매기는 별칭).

## Outcome

LLM이 Brain을 도구로 직접 부르고(MCP), 수집이 hook 없이도 실시간에 가까워지며, Telegram·원격 수집 같은 상주 기능의 자리가 생긴다. 데몬 없이도 전부 동작한다.

## Requirements

인셉션 때 채운다. 원천: spine AD-5·AD-26·AD-27·AD-28과 AD-7·9·18·20·25의 데몬 조항, `inputs/weknora-patterns.md` §2.

## Done when

1. 데몬을 끄고도 모든 명령·hook·launchd 경로가 그대로 동작한다(epic 2·10·3·4·5의 테스트가 데몬 없이 통과).
2. 데몬을 켜면 Stop hook 없이 저장된 transcript가 N초(인셉션에서 SM-7에 맞춰 정함) 안에 수집된다.
3. 빌드를 갱신하면 낡은 데몬만 정상 종료하고 KeepAlive가 새 빌드로 다시 띄우며, 그 사이 hook은 프로세스 안 경로로 처리되고 `DAEMON_UNAVAILABLE` 경고만 남는다. 옛 빌드의 클라이언트(업그레이드 전에 띄운 `mcp serve` 등)가 붙어도 새 데몬은 멈추지 않는다. `[update] auto`가 켜져 있으면 `app-ref`가 앞설 때 데몬이 스스로 업그레이드하고 다시 뜨며, 꺼져 있으면 아무것도 하지 않고 doctor가 `UPDATE_AVAILABLE`을 보인다(2026-10-16).
4. `brain mcp serve`가 모든 읽기 verb와 세션 인자가 있는 쓰기 verb를 도구로 내고, 스키마는 `brain guide schema`와 같다. `session` 없는 쓰기는 `SESSION_REQUIRED`다.
5. `[daemon] enabled`를 바꾸고 `setup run`을 돌리면 두 Label 중 하나만 올라가 있고, doctor가 데몬 생존·소켓·버전·heartbeat를 보이며 죽어 있으면 `warn`이다. `daemon stop` 뒤에는 CLI의 기회적 drain이 돌고, `daemon start`가 데몬을 다시 올린다(2026-10-16). `setup uninstall` 뒤 소켓·pid·로그·Label이 남지 않는다.

## Boundaries

AD-5·6·7·9·18·20·21·25·26·27·28. Core는 그대로다(FR-23: Core는 서버·프로세스를 소유하지 않는다 — 데몬은 Runtime). 경고·오류 코드 `DAEMON_UNAVAILABLE`·`SESSION_REQUIRED`·`VERSION_MISMATCH`를 맡는다. Telegram·원격 기계 수집·승인 대기는 이 에픽 밖(다음 조각). 소켓 프레이밍(연결당 1요청 vs JSON Lines)과 watcher 지연 목표는 인셉션에서 정한다(spine Deferred).

## References

- parent — _bmad-output/personal-brain/initiative-personal-brain.md
- spec — _bmad-output/personal-brain/spec-brain-v1-slice-1/spec-brain-v1-slice-1.md, Capabilities CAP-10, CAP-11
- architecture — _bmad-output/personal-brain/architecture-brain-v1-slice-1/architecture-brain-v1-slice-1.md, AD-5, AD-25, AD-26, AD-27, AD-28, Conventions(설치·런타임 기록), Deferred
- inputs — _bmad-output/personal-brain/inputs/weknora-patterns.md, §2
- change — _bmad-output/personal-brain/change-surface-plugin-daemon/change-surface-plugin-daemon.md, §4.1, §6

## Notes

- Decision(2026-10-15): 데몬을 Deferred에서 에픽으로. 순서는 epic 5 다음, 7 앞(사용자). MCP는 데몬 없이 stdio로 먼저. 데몬은 `brain daemon run` 하위 명령(같은 빌드·shim). 데몬 없이도 전부 동작하는 것이 기준.
- Waits on epic-operations because: LaunchAgent·upgrade·uninstall 흐름과 doctor 틀.
- Waits on epic-capture because: 명령 메타(`brain guide schema`)와 플러그인 뼈대(`.mcp.json` 등록 자리).
- Unknown(인셉션에서): 소켓 프레이밍, watcher 지연 목표 N초, hook 클라이언트 소켓 경로의 실측 이득(SM-7), 세션 안 짧은 핸들의 필요성.
- Note(2026-10-16, `../change-users-and-review-gaps/`, 인셉션 입력, 원문은 `../inputs/external-review-2026-10-16.md`):
  - D3: "데몬이 켜져 있다"는 살아 있는 소켓(handshake 응답)으로 판단한다. 설정 `[daemon] enabled`가 기준이 아니다. `daemon start`가 데몬 Label을 다시 올린다(spine AD-5·7·25·27).
  - D4: handshake 버전이 다르면 데몬은 `VERSION_MISMATCH`로 답하고, 자기 빌드가 `installed.json`의 `commit`과 다를 때만 종료한다(spine AD-26).
- Note(2026-10-16, 사용자): 자동 업데이트는 `[update] auto`(기본 true)를 따른다. true면 데몬이 `app-ref`가 앞선 것을 보고 설치 잠금 안에서 스스로 업그레이드하고 종료해 KeepAlive가 새 빌드로 띄운다(spine AD-27). false면 doctor `UPDATE_AVAILABLE`과 CLI 직접 갱신이다. D4(낡은 데몬만 종료)는 손으로 빌드한 경우 등을 막는 보조로 남는다.
- Note(2026-10-19, `../change-masking-b-and-review-fixes/`, 인셉션 입력): 마스킹 B. 소켓·MCP 응답은 같은 엔벨로프 코덱을 쓰므로 따로 가리지 않는다(spine AD-11).
