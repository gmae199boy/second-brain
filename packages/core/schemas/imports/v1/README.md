# 파일 반입과 분석 계약 v1

확장은 자기 출처의 현재 supervised attempt에서 `file_requests`, `analyses`, `analysis_artifacts`에 지정된 열만 INSERT한다. 기존 ID나 자연키의 재삽입은 생산자 work/token을 제외한 모든 보존 필드가 같을 때에만 허용된다. 분석의 주 요청과 역할 관계는 같은 출처·dataset이어야 하며 행은 불변이다. core 조회는 주 요청 및 역할별 요청을 별도 결과에 결합해 확정 파일과 상태를 나타낸다. evaluation 자유 TEXT는 표시값과 bytea/encoding 쌍으로 원본을 복원하며 제공되지 않은 model/created_at은 NULL과 missing flag를 사용한다.

요청 locator는 `<home>/extensions/<source>/staging/` 아래 상대 경로이고 생산자는 원본과 같은 바이트를 내구 복사한다. 파일 I/O는 DB 트랜잭션 밖에서 이루어진다. core는 요청의 예상 크기와 SHA-256을 확인하고 FileStore에 저장한 뒤 실제 blob을 다시 읽어 해시를 확인한다. 현재 청구의 소유자·청구 시각·유효 기한을 확인한 트랜잭션에서만 결과를 확정하며, 실패는 고정 오류로 기록하고 staging은 보존한다.

완료 결과와 정리 근거는 같은 트랜잭션에서 기록된다. 데몬은 미처 정리하지 못한 결과를 다시 찾아 정리하며 같은 출처·locator의 미완료 요청이 있으면 삭제를 보류한다. 정리와 새 요청은 같은 DB advisory lock으로 직렬화하고 unlink 전에 정리 시작을 영속 기록해 중단 뒤에도 해당 locator의 새 요청을 거부한다. unlink 실패나 프로세스 중단 시 근거는 남아 다음 주기에 재시도된다. 완료한 Markdown은 기존 문서 추출 일감으로 이어지며 가려진 파일을 복원하지 않는다.
