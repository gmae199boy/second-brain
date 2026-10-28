판정: 수정 후 재검토 — PostgreSQL·확장 경계의 방향은 타당하지만, 기존 잠금 계약과의 충돌 및 백업·현재값·확장 수명·작업 복구의 단위 간 계약 누락 때문에 하위 에픽의 일관된 구현을 아직 보장하지 못한다.

## Critical

확인된 항목 없음.

## High

### H1. AD-27 — 살아 있는 데몬 잠금을 시간으로 회수하는 규칙이 기존 구현과 충돌한다
- 문제: 단일 인스턴스 잠금을 “설치 잠금과 같은 규칙: … 상한 시간”으로 정했다. AD-19의 30분 회수를 적용하면 정상 장기 실행 데몬의 잠금을 다른 데몬이 가져가 확장 감독자가 둘이 된다.
- 근거: `apps/cli/src/daemon/lock.ts`는 살아 있는 소유자를 절대 회수하지 않으며, 설치 잠금의 시간 회수를 재사용하면 안 된다고 명시한다. 부팅 시각·PID 생존 확인도 이미 구현되어 있다.
- 구체적 수정: 데몬 잠금에는 시간 만료가 없고, 기존 부팅 시각·생존 판정으로 죽은 소유자만 회수한다고 ratify한다. 설치 잠금과 공유하는 것은 원자적 획득 방식뿐이라고 한정한다.
- disposition: autofix

### H2. AD-20 / Conventions «내보내기» / Deferred — 서로 호환되지 않는 백업 계약이 공존한다
- 문제: AD-20은 PostgreSQL dump, Conventions는 출력 가리기를 거친 테이블별 JSONL·manifest·의존 순서 INSERT를 지정한다. dump는 원문 비밀까지 보존하므로 같은 `backup export/import`에 두 규칙을 동시에 적용할 수 없다. 확장 schema·role·파일 본체의 복원 범위도 새 저장 구조와 연결되지 않았다.
- 근거: [공식 SQL Dump 문서](https://www.postgresql.org/docs/18/backup-dump.html)는 DB 상태의 스냅샷 복원과 role의 별도 준비를 설명한다. epic 5의 구현 연기는 사용자 결정이지만, 서로 다른 형식의 공존까지 승인한 것은 아니다.
- 구체적 수정: 가린 논리 내보내기와 원문 운영 백업을 별도 산출물로 둘지 결정하고 명령별 형식·비밀 취급·brain/확장 schema·role 재생성·파일/설정 범위를 고정한다. 구현·보관 주기는 epic 5로 미뤄도, 그 전의 백업 부재와 데이터 손실 허용 범위는 운영 envelope에 명시한다.
- disposition: discuss

### H3. AD-32 / Table Contract «건강 측정·요약» — “현재” 선택과 재관측의 계약이 불충분하다
- 문제: 자연키에 데이터셋·이전 출처를 넣으면서 조회는 “키별 최신 버전”이라고만 했다. 데이터셋까지 묶으면 후보마다 현재값이 생겨 집계가 중복되고, 빼면 충돌 후보 중 하나를 자동 선택하게 된다. 같은 정규화 버전으로 Garmin의 수정된 값을 다시 받으면 AD-8의 DO NOTHING이 새 값을 버릴 수도 있다.
- 근거: R5~R7·R15와 C6는 후보 보존, 재실행 멱등, 정확한 집계, 사용자 충돌 결정이 함께 필요하다. epic 14가 쌓는 행을 epic 16이 추가하고 epic 17이 조회한다.
- 구체적 수정: 관측/원본 revision 키와 논리 측정 키를 구분하고, 같은 입력 재실행과 변경된 입력 재관측을 구별한다. 승인된 데이터셋·출처와 버전의 우선순위를 현재 view가 어떻게 적용하는지 정한다. C6 미결정 후보는 보존하되 정식 현재값/집계로 승격하지 않는 gate를 명시한다.
- disposition: discuss

### H4. AD-29·30·33 / Capability map — 비활성화가 저장·실행·조회에 미치는 계약이 없다
- 문제: map은 R16·R17을 가리키지만, Rules에는 확장 설치/활성 상태의 원천과 비활성화 시 예약·대기 일감·진행 중 프로세스·raw view를 어떻게 처리하는지 없다. epic 13은 예약만 끄고 epic 12/16은 이미 열린 일감을 계속 실행할 수 있으며, epic 17은 상태를 판단할 근거가 없다.
- 구체적 수정: 공통 확장 registry와 상태 전이의 소유자를 정한다. 비활성화 뒤 새 발화/청구 금지, 진행 중 작업의 취소 또는 완료 정책, schema·기존 데이터 보존, 검색 응답의 설치/활성 상태 출처를 고정한다. 로그인·예약 미완료를 활성/설치 완료와 구별한다(R10·R16·R17).
- disposition: discuss

### H5. AD-33 / Deferred «임대 갱신 세부» — 감독자 사망 뒤 살아남은 자식을 다루는 규칙이 없다
- 문제: 자식 프로세스 그룹·heartbeat·reap은 정상 감독자에 대해서만 정의되어 있다. 감독자가 죽고 Python/Codex 자식이 살아 있으면 새 감독자가 만료 일감을 재청구하여 두 프로세스가 같은 계정 수집·분석을 계속할 수 있다. “경과 시간만으로 중복 실행하지 않는다”는 금지문만으로 이 경계를 구현할 수 없다.
- 구체적 수정: epic 12가 복구 소유권과 실행 세대/자식 신원을 정의하고 epic 13의 프로세스 규약이 이를 운반하도록 명시한다. 재청구는 이전 실행의 종료 확인 또는 이전 세대의 쓰기를 거부하는 fencing 뒤에만 허용한다. 감독자 강제 종료·자식 생존·재시작 시나리오를 공통 계약 검증에 포함한다.
- disposition: discuss

### H6. AD-23·30 / Table Contract «file_requests» — 파일 등록의 요청과 결과를 잇는 공통 계약이 비어 있다
- 문제: 확장은 core 파일 행을 읽고 쓰지 못하며 등록 요청만 넣는다. 그런데 요청의 멱등 키와 처리 결과(file_id), 바이트 전달·보관 수명, 실패/재개 규칙은 “처음 쓰는 에픽(11 또는 14)”에 남겼다. epic 14의 legacy 분석과 epic 16의 그래프가 파일 등록 완료 전후에 관계를 다르게 연결할 수 있다.
- 구체적 수정: 소유자를 하나로 지정하고, 출처+안정된 요청 키·해시·바이트 인계 위치·결과를 읽는 공개 view·완료/실패 상태를 최소 계약으로 정한다. core가 해시 검증과 파일 관계 확정을 마칠 때까지 입력 바이트를 삭제하지 않는 규칙을 추가한다.
- disposition: discuss

## Medium

### M1. AD-11·35 / Conventions «텍스트» — 새 모델·채널 발신 경로가 가리기 계약에 연결되지 않았다
- 문제: 출력 코덱 목록은 CLI·hook·미러·내보내기·임베딩을 열거하지만, 새 분석 에이전트의 입력/도구 응답과 Telegram 발신은 명시하지 않는다. AD-35는 core 데이터를 읽는다고만 하여 adapter의 원문이 바로 외부로 갈 수 있다. epic 15는 출력 코덱을 요구하지만 spine의 등록부 계약과 연결이 없다.
- 구체적 수정: 모델 입력과 채널 발신도 Core 가리기 함수/코덱 등록부를 반드시 거치며, 파일 원본 보존과 외부 전송 텍스트를 구분한다고 명시한다. 새 두 경로를 기존 비밀 fixture 계약의 소비자로 추가한다.
- disposition: autofix

### M2. AD-5 / Structural Seed — 새 공통 기능의 공개 표면·조립 위치가 갱신되지 않았다
- 문제: 고정 CLI/SDK 표에는 확장 설치·상태·비활성화, 예약 등록/취소, 건강 수치 질의가 없다. epic 13은 `brain install <확장>`을 제안하지만 AD-5는 `<ns>.<verb>` 1:1 표면을 고정한다. Telegram adapter와 모델 실행 adapter도 현재 seed의 의존 방향에 배치되지 않았다.
- 구체적 수정: 최소 namespace/verb 및 CommandSpec 소유자를 정하고 세부 인자는 해당 에픽에 맡긴다. Telegram·모델 프로세스 실행을 port/adapter/runtime 중 어디에 조립할지 seed에 추가한다. 기존 V1 목록에서 이제 epic 17로 당겨진 대화 검색/원문 읽기와, epic 5로 미뤄진 백업도 맞춘다.
- disposition: discuss

### M3. AD-13·32 / Capability map «건강 데이터·이전» — R15의 수치 의미가 단위 간 계약에 없다
- 문제: 날짜 타입과 버전 행은 정했지만, metric의 단위·NULL·운동 식별자·집계 가능성은 결정도 명시적 위임도 없다. epic 14/16이 저장하는 단위와 epic 17이 합계/평균에 쓰는 단위가 달라도 현재 Rule을 모두 만족할 수 있다.
- 구체적 수정: core 건강 계약의 단위/NULL/운동 identity 및 metric별 허용 집계 정의는 epic 14가 소유하고 epic 16/17이 같은 정의를 소비한다고 고정한다. 질의·계산은 모델이 아니라 코드가 수행하며 독립 계산 fixture로 검증한다고 R15를 map/Rule에 연결한다.
- disposition: discuss

### M4. AD-11 — VACUUM 완료를 물리 삭제 완료처럼 취급한다
- 문제: 일반 VACUUM은 공간 재사용을 위한 작업이며, 옛 비밀의 안전한 바이트 소거를 보증하지 않는다. 장기 스냅샷·WAL·기존 dump도 같은 일감으로 지워지지 않는다. 일감 완료만으로 doctor 경고가 사라지면 실제보다 강한 삭제 보증을 전달한다.
- 근거: [공식 VACUUM 문서](https://www.postgresql.org/docs/18/sql-vacuum.html)는 일반 VACUUM을 공간 회수/재사용으로 정의하고 FULL의 테이블 재작성과 구별한다.
- 구체적 수정: 제품이 보장하는 삭제 범위를 논리 조회 불가와 공간 회수로 정확히 적는다. VACUUM 완료를 비밀의 물리 소거 증거로 쓰지 않으며, WAL·백업의 잔존 범위와 별도 처리 책임을 명시한다.
- disposition: discuss

### M5. AD-34 / Conventions «테스트» — DB만 분리되고 개발/검증의 운영 자원 경계는 미정이다
- 문제: 테스트 DB·포트는 정했지만 compose project/volume, Brain 홈·spool·LaunchAgent Label·확장 설치·외부 계정은 운영 기본값 하나다. 앞으로 설치/확장/예약 통합 검증이 실제 데이터나 실제 Garmin·Telegram 작업을 건드릴지에 대한 envelope가 없다.
- 구체적 수정: 운영은 이 Mac의 기본 홈 하나이며, 개발/통합 검증은 별도 홈·DB·compose project/volume·서비스 Label을 쓴다고 정한다. 외부 서비스는 기본 fixture/fake, 실계정 검증은 명시적 사람 확인 경로라고 정하고 자원 이름 파생 규칙의 소유자를 지정한다. 클라우드/관리형 provider는 현재 범위 밖임을 덧붙인다.
- disposition: discuss

## Low

새 차단 항목 없음. AD-15의 “3자 이상은 색인을 탄다”는 실행계획 보증 대신 “추출 가능한 trigram이 있으면 색인 사용 가능”으로 완화할 수 있다. [공식 pg_trgm 문서](https://www.postgresql.org/docs/18/pgtrgm.html)는 ILIKE 지원과 함께 non-word 문자 제외를 설명한다. disposition: autofix.

## 점검 범위와 유지할 결정

- R1~R18·C1·C2·C4~C6, epic 11→12→13→15→14→16→17→8, 이번 update memlog, `packages/postgres`·`packages/sqlite`·`packages/core`·`apps/cli`를 대조했다. C3는 이니셔티브가 준비 전용으로 제외한 번호이므로 요구 누락이 아니다.
- PostgreSQL 단일 원본, SQLite adapter 폐기/기존 brain.db 미이전, 확장별 schema와 INSERT 계약, core 단일 마이그레이션 실행기, ILIKE 기본 검색은 승인된 brownfield 변경이다. 아직 구현되지 않았다는 이유로 결함으로 세지 않았다.
- R11의 인증/MFA/호출 보호 fixture는 epic 16에, 놓친 예약·정체 시간 기준은 epic 12에 맡겨도 된다. 다만 위의 단위 간 상태·복구·현재값 계약은 그 세부값과 구별하여 먼저 고정해야 한다.
- 버전 확인: 2026-10-28 [PostgreSQL 공식 지원표](https://www.postgresql.org/support/versioning/)와 [공식 이미지](https://hub.docker.com/_/postgres)에서 18.6/`postgres:18`을 재확인했다. pg 8.23.1·Kysely 저장소 0.29.6은 로컬 package.json, 업데이트 목표 0.29.7·psycopg 3.3.6은 이번 memlog의 확인 기록에 근거한다. 나머지 Stack 항목의 최신성은 기존 날짜별 기록을 읽었으며 이번 리뷰에서 각각 재조회하지는 않았다.
