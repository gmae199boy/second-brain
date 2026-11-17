# 수동 시험 자원

수동으로 disposable 시험 컨테이너를 만들 때는 실행마다 고유한 `brain.test-run`과 파일별 `brain.test-file` label을 붙이고, 해당 실행의 소유자 PID·프로세스 시작 시각과 자원 ID를 시험 장부 또는 별도 manifest에 기록한다. 데이터베이스 데이터는 tmpfs에 둔다. `docker run --rm`을 사용하거나, create/start를 사용하는 경우 소유권과 종료를 확인한 정확한 ID에만 `docker rm -fv <id>`를 실행한다.

회수 전에 기록과 label 및 소유자 종료를 대조하고, 일치 여부나 프로세스 종료가 불명확하면 남겨 두고 보고한다. 운영 `second-brain-postgres-1` / `second-brain-pg` 및 `sjtech` / `sjtech-db`는 대상에서 제외하며 전역 prune이나 이름 접두사·나이만을 근거로 한 삭제는 사용하지 않는다. Compose의 named volume과 network는 소유권을 따로 확인한 뒤 각각 정리한다.

## 장부 진단과 명시 복구

일반 TypeScript 및 Python 시험 시작은 기존 장부를 읽기 전용으로 진단한다. 다른 실행의 오래된 장부를 자동 복구하거나 자원을 정리하지 않으며, 미확인 실행이나 보존된 공유 자원이 있으면 경고하고 공유 DB 정리 fence를 유지한다. 자기 실행 종료 시에는 자기 장부의 소유권과 자식 종료를 확인하여 정리한다.

중단된 실행은 내부 도구 `node tooling/test-db/dist/python-slots.js --recover --run-id ID`로 정확한 대상 하나를 지정해 복구한다. 대상 ID는 필수이며 존재하지 않거나 완료된 장부, 살아 있거나 종료가 확인되지 않은 소유자, 복구 실패는 성공으로 처리하지 않는다. PID 시작 시각, 자식 종료 및 컨테이너 ID와 라벨 확인과 quarantine 규칙은 그대로 적용된다. `--release-quarantine --run-id ID`는 별도 명시적 fence 해제이며 자원을 보존한다. 시험 전용 내부 도구이므로 공개 Brain CLI 명령이나 배포 스킬이 아니다.
