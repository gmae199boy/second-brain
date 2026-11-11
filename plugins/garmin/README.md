# second-brain-garmin

Personal Brain core가 설치된 뒤 내장 패키지를 기존 core 확장 설치기에 전달한다. core가 없으면 설치 방법만 안내한다. 로그인, 연결, 예약, 기존 설치 복구와 잠금은 core가 담당한다.

저장소에서 Garmin 제품 소스나 migration, skill, 의존성 고정 파일 또는 이 플러그인 버전을 바꾸면 다음 명령으로 패키지와 digest를 다시 만든다.

```sh
node tooling/package-garmin/build.mjs
```

산출물은 `package/`이며 시험·fixture·고정 SQLite oracle과 출처 이력은 포함하지 않는다. `app-ref`는 해당 ref를 기록하는 커밋보다 앞선 커밋이어야 한다. 기능 구현을 커밋한 후 그 커밋을 가리키도록 ref를 바꿀 때는 같은 릴리스 커밋에서 이 플러그인의 버전도 올리고 위 명령으로 `plugin_version`과 digest를 갱신한다.

## 분석과 발신

Garmin 분석은 채널·대화 설정 없이 실행한다. 분석·평가와 core 파일 publish가 끝나면 기존 발신 트랜잭션에서 `brain.extension_channel_send`에 topic `garmin.report`를 넘기며, `send_at`은 null(지금 보내기)이다. 경로가 없으면 core가 `unrouted`로 보관하고 정상 반환하므로 분석은 성공한다. 자동 report는 계정 시간대의 당일 자료만 발신하고, 사람이 요청한 `report_regenerate`는 지정 날짜를 발신한다. 성공 요청 키에는 기존 복합 revision을 포함한다. 동일 revision 재실행은 같은 `(topic,key)`로 한 번만 접수하고, 사람이 재생성해 새 revision이 생기면 새 발신 요청을 만든다. 자동 report는 완료된 당일 평가를 재사용하므로 같은 당일 revision을 중복 발신하지 않는다. 실패 알림의 날짜별 키는 유지한다.

`garmin.channel_conversation_id` 선언은 이전 설치의 설정을 받아들이기 위해 남겨 두지만 입력 검증·분석·발신에는 쓰지 않는다. 채널 경로와 발신 자격 증명은 core가 관리한다. 확장 역할은 새 send 함수의 실행권한을 요구하며 하위 호환으로 남는 기존 publish·대화 검증 실행권한도 허용 목록에 유지한다. 분석에서 해당 함수를 호출하거나 대화 검증 권한을 요구하지 않는다. 권한 부여·회수는 core provisioning 담당이다.

이번 실행 계약 변경으로 확장 manifest 버전을 `1.2.2`에서 `1.2.3`으로 올렸다. Python 배포물의 별도 버전은 그대로이며 `app-ref`와 marketplace 플러그인 버전은 변경하지 않는다.

## 배포 스킬

설치 안내는 `brain-garmin-install`, 수집·이관·리포트·조회는 `brain-garmin-operations` 스킬을 사용한다. 폴더명과 frontmatter name은 동일하다. Codex 연결은 저장소 루트 [CONNECTION.md](../../CONNECTION.md)의 공식 설치본 전체 symlink 절차를 따른다. package 내부 분석 스킬 3개는 감독 runtime 계약의 일부이므로 이름을 유지한다.

Codex 절대 경로 전달 계약과 `ANALYSIS_AGENT_NOT_FOUND` 오류를 추가하면서 확장 manifest 버전을 `1.2.4`로 올렸다. `brain config set agent.codex_path <절대경로>`로 경로를 지정하며 설치 시 비어 있는 설정만 자동 탐지한다. `brain doctor run`으로 경로와 버전을 확인한다.
