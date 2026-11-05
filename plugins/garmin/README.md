# second-brain-garmin

Personal Brain core가 설치된 뒤 내장 패키지를 기존 core 확장 설치기에 전달한다. core가 없으면 설치 방법만 안내한다. 로그인, 연결, 예약, 기존 설치 복구와 잠금은 core가 담당한다.

저장소에서 Garmin 제품 소스나 migration, skill, 의존성 고정 파일 또는 이 플러그인 버전을 바꾸면 다음 명령으로 패키지와 digest를 다시 만든다.

```sh
node tooling/package-garmin/build.mjs
```

산출물은 `package/`이며 시험·fixture·고정 SQLite oracle과 출처 이력은 포함하지 않는다. `app-ref`는 해당 ref를 기록하는 커밋보다 앞선 커밋이어야 한다. 기능 구현을 커밋한 후 그 커밋을 가리키도록 ref를 바꿀 때는 같은 릴리스 커밋에서 이 플러그인의 버전도 올리고 위 명령으로 `plugin_version`과 digest를 갱신한다.
