# 이 Mac의 채널 확인

이 도구는 설치된 `~/.second_brain/app` 모듈과 설정을 사용한다. 운영자가 `~/.second_brain/.env`에 `BRAIN_TELEGRAM_BOT_TOKEN`, `BRAIN_TELEGRAM_CHAT_ID`를 안전하게 넣고 파일 권한을 0600으로 유지한 뒤 저장소 루트에서 실행한다. 값이나 DB URL을 명령 인자·보고서에 넣지 않는다.

키를 입력한 후 영수증이나 요청을 만들기 전에 기존 데몬을 중지하고 다시 시작해 새 설정을 적용한다. 다음 명령이 성공하고 status에서 데몬이 살아 있는 것을 확인한 후에만 probe를 실행한다. 이미 진행 중인 다른 일감은 중지 전에 상태를 확인한다.

```sh
~/.second_brain/bin/brain daemon stop
~/.second_brain/bin/brain daemon start
~/.second_brain/bin/brain daemon status --json
node tooling/channels-mac/probe.mjs
```

두 키가 없으면 요청을 만들지 않는다. 첫 실행은 고정 메시지 한 건의 소유 ID를 `~/.second_brain/run/channels-mac-probe.json`에 먼저 기록하고 채널 요청을 저장·인계한다. 데몬이 발신을 처리한다. 같은 명령을 다시 실행하면 기록된 요청만 조회하며 `sent`이면 실제 message ID를 표시한다. 요청 ID, 실제 일감 ID, 채널 ID와 결과를 기록하되 대화 참조와 비밀은 기록하지 않는다. 상태가 대기 중이면 기다렸다가 같은 명령을 재실행한다. 실패·불확실 상태를 임의 재발신하지 않는다.

영수증 생성 후 중단됐거나 요청이 없으면 도구가 재생성하지 않고 중단한다. 영수증을 지우지 말고 DB와 데몬 상태를 조사한다. 영수증을 지우거나 교체하면 중복 발신 방지가 사라진다. 실행 환경에 동일 영수증이 없을 때 이 도구를 별도로 실행하지 않는다.

확인용 자료를 꼭 지워야 한다면 결과를 먼저 보존하고 일감이 완료됐는지 확인한 뒤 다음 명시 명령을 실행한다. 이 명령은 설치 `.env`의 PostgreSQL 관리자 자격을 사용하며 영수증의 소유 정보, 활성 일감, 다른 채널 참조를 검사한다. 다른 참조나 제약이 있으면 트랜잭션을 롤백한다. 정리 후에도 영수증을 보존하여 재발신을 막는다. 기존 운영 자료는 지우지 않는다.

```sh
node tooling/channels-mac/cleanup.mjs --delete-owned-probe
```

격리 재현은 아래 명령이다. 임시 DB와 홈, 로컬 가짜 서버만 사용하며 실제 Telegram에 접속하지 않는다. Docker 접근이 필요하며 `BRAIN_TEST_DATABASE_URL`을 지정한 환경에서는 시작하지 않는다. 시험이 시작한 DB 컨테이너만 종료하고 임시 DB와 홈을 제거한다.

```sh
node tooling/channels-mac/verify.mjs
```
