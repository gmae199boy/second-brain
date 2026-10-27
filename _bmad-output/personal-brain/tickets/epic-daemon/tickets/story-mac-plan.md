---
title: "이 Mac에서 확인: 플러그인 배포로 데몬이 로그인 때 뜬다"
ticket: 8
status: done
---

# 이 Mac에서 확인 결과 (2026-10-27, 사람 확인)

배포: `5753961`(plugin `app-ref` → `65b3292`, `version` 0.1.8)을 push하고 SessionStart bootstrap(`plugin/bin/session-start.sh`)을 실행해 설치본을 `65b3292`·스키마 9로 올렸다. 설치기 마지막 줄 "데몬을 launchd에 등록했습니다", `installed.json`의 commit `65b3292`.

| 확인 | 결과 | 근거 |
|---|---|---|
| 설치 뒤 데몬이 떠 있고 heartbeat 갱신 | 통과 | `launchctl print`: `state = running`, `properties = keepalive \| runatload`; heartbeat mtime 16:38:07 → 16:38:37; `daemon status`: 빌드 65b3292, 살아 있음 |
| `setup run` 반복 | 통과 | 다시 돌려도 `daemon.status = loaded`, `plist_changed = false`, `restarted = false`; plist 1개, `launchctl list` 1개, pid 그대로(46083) |
| 데몬 프로세스를 죽이면 launchd가 다시 띄움 | 통과 | `kill -9 46083` 1초 뒤 pid 55520(`runs = 2`), 새 데몬이 죽은 pid의 잠금을 넘겨받아 살아 있음 |
| `daemon stop` / `daemon start` | 통과 | stop: `{ unloaded: true, alive: false, owner_pid: null }`, Label 내려감, 15초 동안 프로세스 없음, plist 유지, 상태 "살아 있지 않습니다". start: `started`, pid 55985로 복귀 |
| 최소 `setup uninstall` | 통과 | Label·plist·pid·heartbeat·`daemon.log`·프로세스 없음, 대화 9,502건·`files/` 3개·`installed.json`·shim 그대로, 두 번째 실행도 ok. 이어서 `setup run`으로 다시 등록(`registered`, pid 56541) |
| 로그인 때 자동 실행 | 통과 | Mac 재시작(부팅 16:58:06) 뒤 `state = running`, `runs = 1`, pid 3568, heartbeat 17:01:10 |
| Stop hook 없이 저장된 transcript 수집 | 일부 | 이 세션의 진행 중 턴 메시지(16:37:21)가 턴이 끝나기 전(Stop hook 전)에 DB에 들어옴. "10초 안" 지연은 이 Mac에서 재지 않았다(9.4 자동 시험이 임시 폴더로 검증) |
| 플러그인 갱신 뒤 새 빌드로 재시작 | 미확인 | 이번 배포는 데몬 첫 설치라 재시작 경로를 타지 않는다. 다음 플러그인 배포 때 `daemon status`의 빌드가 새 commit으로 바뀌는지 본다 |

doctor의 `daemon` 항목은 데몬이 없을 때 `warn 데몬이 살아 있지 않습니다`를 냈다(설치 중 등록 직전 점검).
