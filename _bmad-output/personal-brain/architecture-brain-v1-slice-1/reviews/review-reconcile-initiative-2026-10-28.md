판정: 수정 필요 — PostgreSQL·프로세스·schema 결정은 반영됐지만, Garmin 이전 승인·검증, 설치 안내의 정직한 완료 보고, 비활성화와 건강 질의 계약 등 핵심 요구가 본문 규칙으로 착지하지 않았다.

## Critical

- 없음: 구현 결함의 확정 판정이 아니라 driving ticket 대비 설계 계약의 누락을 검토했다.

## High

- H1 — **AD-30·32, Deferred / R5~R7·C6·Done 7**: 출처별 불변 행만 있고, 기준 소스·겹치는 자연키 처리에 대한 사용자 결정 **전 실제 반입 금지**가 없다. schema10/15 원형 보관, 모든 실제 DB·파일 출처 목록, 후보별 충돌 보존, batch 멱등·실패 재개, 값·본문·해시·관계 동등성 보고도 없다. **수정:** importer 공통 규칙과 완료 gate를 추가하고 기준 소스/충돌 선택은 epic 14 전 사용자 결정으로 Deferred에 명시한다. **disposition: autofix**(정책 복원; 실제 선택은 discuss).
- H2 — **AD-5·19·29, Structural Seed / R2·R10·R17·Done 8**: manifest의 로그인 단계는 있지만 기본 포함 공통 install 스킬과 확장 상태 CLI 계약이 없고, 미설치에서 시작→설치→사용자 로그인→공통 예약의 재실행·실패·미준비 구별과 **성공한 단계만 완료로 보고**가 없다. **수정:** epic 13 소유 스킬·CLI 상태 및 단계 결과 계약, 스케줄러 준비 전 예약 완료 표시 금지를 명시한다. **disposition: autofix**.
- H3 — **AD-29·30·32 / R16·Done 8**: R16을 Binds에 열거하지만 비활성화의 효과를 정하지 않았다. 불변 데이터만으로 예약 중지·진행 작업 상태·검색 가능 여부의 명시를 보장하지 못한다. **수정:** 데이터/분석 보존, 예약·새 청구 중단, 진행 작업의 중단 상태 보고, core에 남은 기록의 검색 정책을 규칙으로 추가한다. **disposition: autofix**(진행 작업 종료 방식은 epic 12·13에서 defer).
- H4 — **AD-29·30, Conventions 테스트 / R11**: 파이프라인 분리와 raw text는 있으나 기존 token/session/MFA·계정 차단·호출 간격, raw/정규화/수치/입력 필터의 **보존 및 fixture·실패 경계 검증**이 없다. **수정:** Python 자산 재사용과 함께 해당 보존 목록·검증 gate를 epic 16의 불변식으로 연결한다. **disposition: autofix**.
- H5 — **AD-13·32, AD-5·Capability map / R15·Done 8**: 현지 날짜 타입과 최신 view는 있으나 기간·지표·운동·집계 조건의 수치 조회 port/표면, 합계·평균·단위·NULL 규칙과 독립 계산 대조가 없다. **수정:** epic 17 소유의 구조화 수치 조회 계약과 코드 검증 기준을 추가하고 구체 schema만 미룬다. **disposition: autofix**.
- H6 — **AD-7·21·33, Deferred / R8~R10**: SKIP LOCKED는 청구 충돌만 막는다. 독립 작업 병렬 실행과 **동일 계정 수집 직렬성**, 예약·수동 실행의 같은 대상 합치기, 사망·오류·정체·취소의 구별은 규칙에 없다(키별 직렬화는 전부 epic 12에 위임). **수정:** 이 불변식과 복구/종료 구별을 지금 적고, 실행 수·키 구성·정체 임계값·놓친 예약 세부만 Deferred에 남긴다. 임대 경과만으로 재실행 금지는 AD-21·33에 제대로 있다. **disposition: autofix**.
- H7 — **AD-35·Table Contract 채널 / R12·R13**: day→7d→30d→all과 발신 실패의 평가 삭제 방지는 있으나 성공 결과의 단계별 보존과 계산·평가/전송 성공의 별도 기록이 명시되지 않았다. identity 모양은 Deferred에 있으나 같은 대화로 연결할 사용자·스레드·선제 메시지의 identity·provenance 경계 자체도 없다. **수정:** 평가/발신 독립 상태 및 단계별 결과 보존, 채널 연결에 필요한 출처·외부 식별자 경계만 확정하고 필드 모양은 epic 15에 둔다. **disposition: autofix**.

## Medium

- M1 — **AD-15·Capability map·AD-5 / R14·Done 3·Notes 151~153**: 한국어 두 글자 테스트는 있으나 표현 바꾸기 회귀 문항은 없다. 회귀 러너는 여전히 epic 4 소유이고 `sessions read`, `recall chunks/tools/expand`는 V1 뒤로 분류되어 epic 17의 대화 검색·실제 근거 읽기와 충돌한다. **수정:** epic 17로 옮긴 표면/회귀 기준을 명시하고 Drive·epic 4의 후속 확장만 남긴다. **disposition: autofix**.
- M2 — **AD-34·Conventions 테스트 / R3·Done 6**: named volume·Store 계약 테스트는 있지만 컨테이너 재생성/재시작 뒤 기억·설정 유지와 Garmin 유무 양쪽의 같은 설치 흐름 검증이 없다. **수정:** epic 11·13의 영속성/설치 검증 gate를 짧게 추가한다. **disposition: autofix**.
- M3 — **frontmatter scope·AD-5·AD-23·Deferred / Done 4·Boundaries**: scope와 V1 명령 목록은 로컬 백업을 계속 V1에 넣고, 파일 이전은 해시 확인 뒤 삭제만 요구한다. 10월 27일 결정은 백업을 V1 뒤로 미루고 Drive 이전 원본의 **보관 기간 후 삭제**를 대신 요구한다. **수정:** V1 백업 표기를 제거하고 AD-23에 DB 설정 `drive.keep_local_days`에 따른 삭제 gate를 연결한다. Deferred의 Telegram 전체 후속 조각 표기도 초기 발신(V1, epic 15)과 양방향 출시(범위 밖)를 나눈다. **disposition: autofix**.
- M4 — **Deferred / Notes 165·memlog 마지막 question**: 모델 호출 횟수·비용의 제한/표시 여부(epic 12)와 `chunk_locator` text/jsonb 결정(epic 11)이 빠졌다. **수정:** 담당·재검토 시점을 그대로 추가한다. 이미 정한 실행 포트·schema·버전 표는 다시 질문하지 않는다. **disposition: defer**.

## Low

- L1 — **AD-10 / Notes 142~144**: 빈 DB·transcript 재수집·SQLite 제거는 있으나 transcript로 복원 불가능한 첨부 손실을 사용자가 수용했다는 전환 한계가 빠졌다. **수정:** 해당 수용 범위와 `move-store` 불필요를 한 줄로 보존한다. **disposition: autofix**.

## 입력별 대조

표의 ‘부분’은 일부를 떨어뜨린 상태이며 위 finding을 함께 참조한다. ‘비설계’는 티켓 관리/작업 방식 사실로, spine 미기재를 제품 계약 결함으로 세지 않았다. Binds나 map의 번호 열거만으로 반영 판정하지 않았다. 입력은 initiative 전체와 spine 전체, memlog의 `update 시작(2026-10-28)` 이후이며 외부 자료의 최신성은 범위 밖이다.

| Requirements / Constraints | 판정 및 spine 근거 |
| --- | --- |
| R1 | 반영: AD-29 미설치 시 Python·uv 불요, AD-10·25·27 기본 경로 |
| R2 | 부분: AD-25·29·33 공통 runtime, 설치·로그인·예약 연결 누락(H2) |
| R3 | 부분: AD-10·18·34 단일 DB/볼륨, 재생성 검증 누락(M2) |
| R4 | 반영: AD-18·Table Contract settings; 재시작 보존 검증은 M2 |
| R5 | 부분: AD-23·30·32 원본/출처/해시, 전체 목록·동등성 gate 누락(H1) |
| R6 | 부분: AD-32 출처별 행, schema10/15 원형 보관·충돌 보존 누락(H1) |
| R7 | 부분: AD-8·32 불변/멱등 기반, importer batch·재개·재분석 대체 금지 누락(H1) |
| R8 | 부분: AD-7·21·33 작업 분리/의존, 계정 직렬·독립 병렬 불변식 누락(H6) |
| R9 | 부분: AD-21·33 임대 갱신·시간만으로 중복 금지·취소, 사망/오류/정체 구별 누락(H6) |
| R10 | 부분: AD-13·21·33·35와 Deferred 현지 예약, 수동/예약 합치기·미준비 완료 금지 누락(H2·H6) |
| R11 | 부분: AD-29·30 파이프라인, 기존 보호·필터·fixture gate 누락(H4) |
| R12 | 부분: AD-35 순서/삭제 방지, 성공 단계 개별 보존·전송 별도 기록 누락(H7) |
| R13 | 부분: AD-30·35 공통 발신, Deferred identity 모양; provenance 경계 누락(H7) |
| R14 | 부분/오반영: AD-15·23 검색/원문·두 글자, 대화 읽기 V1 뒤 및 회귀 공백(M1) |
| R15 | 부분: AD-13·32 타입/버전, 수치 질의·집계 검증 누락(H5) |
| R16 | 누락: AD-29·30·32의 Binds 외 비활성화 규칙 없음(H3) |
| R17 | 누락: map은 epic 13만 연결, 기본 install 스킬·CLI/보고 규칙 없음(H2) |
| R18 | 반영: AD-7~11·23~27·34와 Conventions 테스트/항상 exit 0; PG 공통 Store·배치 건수·원문·출력 마스킹 |
| C1 | 반영: AD-10·34, Design Paradigm·Stack·Seed에서 SQLite/복제 제거 |
| C2 | 반영: AD-15 pgvector 불필수·기본 꺼짐; Drive 후속 순서 자체는 미기재 |
| C3 | 의도적 부재: initiative Notes 140이 준비 단계 전용이라 제외했다고 명시 |
| C4 | 반영: Design Paradigm·AD-29·Stack Python; 보호 자산 검증은 H4 |
| C5 | 반영: AD-32 명시적 null/flag·추정 금지, AD-23 원문 보존 |
| C6 | 부분: AD-32 출처별 보존, 사용자 결정 전 반입 금지 누락(H1) |

| Done when | 판정 및 spine 근거 |
| --- | --- |
| 1 | 반영: AD-19 설치/OrbStack 선행·AD-25 KeepAlive·AD-4·6·9 수집 |
| 2 | 반영: AD-15·23·24, Deferred Drive API 다운로드/추출/삭제·이름/원본 URL |
| 3 | 부분: AD-15 질의 바꾸기 안내; 실제 10건 중 7건 성공 gate 미기재(M1) |
| 4 | 오반영: AD-20 백업 epic 5지만 scope·AD-5는 V1 포함, 보관 기간 삭제 gate 누락(M3) |
| 5 | 반영: AD-9·21·25·27 및 Conventions 오류/doctor; AD-33·35 LLM 허용 |
| 6 | 부분: AD-10·18·34·Conventions 계약 테스트; 양쪽 설치·재생성 검증 누락(M2) |
| 7 | 부분: AD-23·32 보존 기반; importer 보고/재개 gate 없음(H1) |
| 8 | 부분: AD-7·21·33·35 기반; 설치 보고·병렬·수치 검증·비활성화 공백(H2~H7) |

| Boundaries(initiative 줄) | 판정 및 spine 근거 |
| --- | --- |
| 67 에픽·비목표·V1 뒤·복제 drop·새 순서 | 부분: AD-10·14·16·17·26·28, Deferred 팀/다른 Harness/임베딩; 11→12~17→8 순서 없음, 표면 충돌 M1·M3 |
| 69 범위 자동 확대 금지 | 부분: Deferred 공개 marketplace·다른 Harness; 초기/완전 양방향 구별은 M3 |
| 70 Slack/Telegram 양방향 출시 제외·초기 발신 포함 | 부분/오반영: map 채널 Telegram epic 15와 Deferred ‘Telegram 그 뒤’ 충돌(M3) |
| 71 임베딩·Drive는 Garmin 선행 아님 | 부분: AD-15 임베딩 선택, map Drive/확장 분리; 선행 금지 명문 없음 |
| 72 공개 marketplace·임의 외부 코드 제외 | 반영: Deferred 마지막 부분의 명시적 범위 밖 행 |
| 74 tracer(11→13→14→17)·Drive 후속 | 누락: map 구성 요소만 있고 tracer/순서 없음; 티켓의 통합 검증 경로로 연결 필요(M2) |
| 76 플러그인·설치/hook·첫 install 스킬 | 부분: AD-19·28, Seed plugin; install 스킬 소유/기본 포함 누락(H2) |
| 77 LaunchAgent·소켓 V1 뒤 | 반영: AD-25·26·27 |
| 78 PG18·볼륨·SQLite 제거·복제 drop | 반영: AD-10·31·34·Stack |
| 79 uv·Python≥3.12·잠금 파일 | 반영: AD-29·Stack·Seed |
| 80 Garmin Connect·garminconnect/curl-cffi | 반영: AD-29·Stack·Seed 연결; 호출 보호 계약은 H4 |
| 81 로그인한 Codex CLI 모델 호출 | 부분: AD-35·Seed 모델 CLI(Codex 등); 이 Mac 로그인 재사용 경계 없음(H2) |
| 82 Telegram Bot API 초기 발신 | 반영: map 채널 adapter(Telegram) epic 15; Deferred 충돌 M3 |
| 83 private capture LATEST·DB 5/파일 349·manifest·읽기 전용 | 누락: AD-32 legacy 출처만 명시, 실제 이전 입력/읽기 전용 inventory 없음(H1) |
| 84 Drive API | 반영: AD-23·Deferred Drive |
| 85 Model Studio 선택·V1 뒤 | 반영: AD-15·Stack·Deferred |
| 86 추출 라이브러리별 소유·EXIF 뒤 | 반영: AD-23·24·Stack(세부 에픽 소유는 티켓에 유지) |

| 2026-10-28 Notes(initiative 줄) | 판정 및 spine 근거 |
| --- | --- |
| 140 준비 패키지 채택·같은 initiative·C3 제외 | 반영: sources·scope epic 11~17; C3/초안 번호 관리는 비설계 |
| 141 11→12~17→8→5/3/4/6·Drive 비선행 | 부분: map·Deferred 소유만; 순서/비선행 명시 및 M1·M3 정정 필요 |
| 142 기존 brain.db 이전 안 함 | 반영: AD-10 |
| 143 빈 DB·transcript 재수집·첨부 손실 수용 | 부분: AD-10, 손실 수용 누락(L1) |
| 144 SQLite adapter/node:sqlite 삭제·move-store 불필요 | 부분: AD-10·Seed 삭제, move-store 불필요 미기재(L1) |
| 145 Garmin 데이터·분석은 이전/보존 | 부분: AD-23·30·32, 반입 gate 누락(H1) |
| 146 epic 7 drop | 반영: AD-10 단일 Store·Seed에 복제 경로 없음 |
| 147 LLM 0 제약 삭제 | 반영: AD-33·35·map 모델 호출 |
| 148 spec·Done 5 수정 사실 | 반영: 위 계약에 반영; 타 문서 편집 사실 자체는 비설계 |
| 149 PRD Vision/NFR-5/SM-8 대체 | 반영: map 모델 호출에 NFR-5 대체 명시 |
| 150 Core TS·Garmin Python | 반영: Design Paradigm·AD-29·Stack |
| 151 공통 텍스트/원문 읽기 epic 17 | 부분: map은 17, AD-5 V1 뒤 표면과 충돌(M1) |
| 152 대화 조각/도구/넓히기 4→17 | 오반영: AD-5 V1 뒤·Seed eval epic 4(M1) |
| 153 Drive 문서 추가·epic 4 시간/로그/미러/EXIF | 부분: AD-16·24·Deferred; 17 기본 경로와 후속 소유 구분 미완(M1) |
| 154 채널 15는 Garmin runtime 16 앞 | 부분: map epic 15/16, 선행 관계 미기재 |
| 155 DB 설정/config get/set 8→11 | 반영: AD-5·18·Table Contract settings |
| 156~157 spine의 PG/C4 충돌·수정 대상 열거 | 반영: AD-7·10·18·20·22·Stack·Paradigm·Seed·Table Contract 모두 PG 전환 |
| 158 schema·단일 migrator·검색·잠금·TS↔Python | 반영: AD-7·15·29~33 |
| 159 독립 에픽 마이그레이션 id 충돌 방지 | 반영: AD-31 소유자별 번호/중복 거부 |
| 160 Markdown/facts/PNG 배치 결정 | 반영: AD-23 core FileStore·추출·검색 |
| 161 AD-19 설정 충돌 | 반영: AD-18·19 사용자 DB/기계 config/비밀 env |
| 162 PRD SQLite/LLM 충돌·initiative/spec 우선 | 반영: AD-10·33·35·map NFR-5 대체; PRD 수정 자체는 범위 밖 |
| 163 실행/저장 포트·schema/표명·버전 추적 질문 | 해소/유예: AD-30·31·33 확정, Deferred 건강 표 정확한 모양 epic 14 |
| 164 놓친 현지 예약·단계별 정체 기준 질문 | 반영: Deferred ‘임대 갱신 세부, 정체 판정, 놓친 예약 처리’ epic 12 |
| 165 모델 호출 횟수/비용 제한·표시 질문 | 누락: Deferred에 epic 12 결정 항목 필요(M4) |
| 166 기준 Garmin DB·자연키 충돌 사용자 결정 | 누락: Deferred·AD-32에 승인 gate 없음(H1) |
| 167 covers/S·E id 관리 | 비설계: spine binds R1~R18로 추적; 티켓 메타 규칙의 복제 불필요 |
| 168 timezone DB·예약/현지 질의가 사용 | 반영: AD-13·18·Deferred 사용자 스케줄러 |
| 169 legacy 알림 core 채널·15→14·최종 순서 | 부분: AD-30·Table Contract legacy 표시/재발신 금지, 최종 build 순서 미기재 |
| 170 OrbStack 사용자가 선설치·없거나 꺼지면 안내/중지 | 반영: AD-19·34 |
| 171 prep 소스 archive까지 커밋 | 비설계: 저장소 산출물 관리 지시; spine 제품 계약의 누락 아님 |

memlog 대조: 10월 28일 채택된 schema/잠금/검색/파일/버전 행/시각/컨테이너/감독자/DB role/PG baseline/VACUUM/청구 범위/stop_remind 예외는 해당 AD에 반영됐다. 초기 ‘Python은 raw만’ 방향은 뒤의 채택 결정(확장 정규화·digest·그래프)로 대체되므로 결함으로 세지 않았다. 마지막 `chunk_locator` 질문만 Deferred에서 떨어졌다(M4).
