# 수동 시험 자원

수동으로 disposable 시험 컨테이너를 만들 때는 실행마다 고유한 `brain.test-run`과 파일별 `brain.test-file` label을 붙이고, 해당 실행의 소유자 PID·프로세스 시작 시각과 자원 ID를 시험 장부 또는 별도 manifest에 기록한다. 데이터베이스 데이터는 tmpfs에 둔다. `docker run --rm`을 사용하거나, create/start를 사용하는 경우 소유권과 종료를 확인한 정확한 ID에만 `docker rm -fv <id>`를 실행한다.

회수 전에 기록과 label 및 소유자 종료를 대조하고, 일치 여부나 프로세스 종료가 불명확하면 남겨 두고 보고한다. 운영 `second-brain-postgres-1` / `second-brain-pg` 및 `sjtech` / `sjtech-db`는 대상에서 제외하며 전역 prune이나 이름 접두사·나이만을 근거로 한 삭제는 사용하지 않는다. Compose의 named volume과 network는 소유권을 따로 확인한 뒤 각각 정리한다.
