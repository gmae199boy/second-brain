# 21.4 R3 독립 표적 후속 확인

추가발견없음. 지정된 기능 경계에서 입증된 미해결 사항이나 리뷰 진행 차단은 없다. 아래 판정은 정적 확인이며 실행 성공 판정이 아니다.

## 범위와 제약

AGENTS.md, automation/runbook.md, `.brain-automation/independent-spec.md` 원문과 Dispatch를 읽었다. `/private/tmp/brain-214-review-r3.diff` 전체와 연결된 report/input/body/store, 감독 launcher·cleanup, 평가 migration을 검사했다. diff에 포함된 manifest·설정·환경 전달·스킬·시험 코드·oracle child·경로 분류·문서도 정적으로 확인했다. 고정 원본 비교에는 `~/github/garmin`의 `7fb33dd1661ad25cd73e14ed63abe0a87151f62e`에 대한 `git show`만 사용했다. 기존 리뷰 문서는 지정 항목 추적을 위해 읽었으며 구현자·다른 리뷰어와 대화하지 않았다.

코드·계획 수정, build/typecheck, 시험, fixture 생성, checker, 산술 재현, 실모델·실계정·운영 접근과 추가 워커 실행을 하지 않았다. 이 보고서만 작성했다. **시험 실행은 21.8로 이관, 미실행**이며 승인된 유예를 결함으로 세지 않았다.

## 지정 발견사항 추적

| 항목 | 정적 확인과 근거 | 판정 |
| --- | --- | --- |
| R1EC1 / R1BH3 | `garmin_pipeline/report.py:237`의 그룹 소유권 확인은 report가 session/group leader인 경우만 허용한다. 모델은 `start_new_session=False`로 상속하며 `_run`의 finally에서 직접 자식 회수 후 소유 그룹의 후손에 TERM→KILL을 보내고 잔존을 확인한다. `ProcessCleanupError`는 StoreError이므로 intake와 `_daily_analysis`에서 삼키지 않아 다음 scope가 시작되지 않는다. | 지정 결함 해소 확인 |
| R1BH1 | manifest의 두 report 작업 모두 analysis_model을 필수 선언한다. `report_runtime.envelope`도 누락·공백 모델을 report lock/모델 실행 전에 거부한다. collect는 모델 누락을 허용한다. | 지정 결함 해소 확인 |
| R1BH4 | `report.py:1209`는 최초 pending 집합과 intake 후 pending의 교집합을 검사한다. 일부 잔존·재조회 로컬 오류는 실패로 집계하고 가능한 분석 scope를 계속한다. 새 도착 입력은 최초 집합에 포함하지 않는다. | 지정 결함 해소 확인 |
| R1BH5 | body CLI는 요청 파일만 게시하고 호스트가 선택 계정·환경으로 `body_runtime.execute`를 호출한다. 모델 도구가 직접 PG에 접속해야 하는 경계를 제거했다. 호출별 임시 IPC 경로는 모델 정리 뒤 제거되며 이후 scope에서 재사용하지 않는다. | 지정 설계 결함 해소 확인; 실제 sandbox 실행은 미확인 |
| R2BH1 | `body_ipc.service:49`와 handler 직전의 `active()`가 각 요청마다 모델 생존과 deadline을 다시 검사한다. 첫 handler 도중 종료/만료되면 아직 시작하지 않은 두 번째 handler는 실행하지 않는다. `report.py:482`가 현재 모델과 deadline을 closure로 공급한다. | 지정 결함 해소 확인 |
| R2BH2 | `report.py:1190`의 최초 pending 조회와 `:1209`의 재조회 모두 BodyError/OSError를 실패로 집계한다. StoreError·psycopg 오류는 전파하고 BaseException인 취소도 전파한다. | 지정 결함 해소 확인 |
| R2BH3 | `report.py:1229`는 기간 준비의 OSError·UnicodeError·JSONDecodeError를 해당 scope 실패로 집계하고 다음 scope로 진행한다. store/DB 오류는 전파하며 취소도 삼키지 않는다. | 지정 결함 해소 확인 |

## 연결 경계와 새 회귀 확인

- `report_runtime.run`은 선택된 AccountContext와 계정별 report lock을 분석 전체에 유지한다. 최초 계정 timezone 확인, body 작업 및 evaluation append는 각각 짧은 fenced 쓰기 경계를 사용한다. body 파일 게시와 source 이동은 같은 transaction 안에 있어 회수와 직렬화된다. 이미 게시된 파일을 DB rollback이 되돌린다고 간주하지 않았다.
- 기존 store의 읽기 연결은 RR read-only snapshot이고 입력 builder·완료 scope 조회는 모델 호출 전에 닫힌다. 모델 대기 동안 유지되는 report session 연결은 autocommit의 세션 advisory lock이다.
- `run_supervised`는 day→7d→30d→all 순서로 누락 scope만 처리하며 성공 직후 append한다. 명시 재생성은 완료 집합을 비우고 새 revision을 남긴다. 기존 immutable revision과 최고 revision 한 행을 읽는 view를 그대로 사용한다. 저장 시 stale 오류는 다음 모델로 진행하지 않는다.
- `test_report_process.py`의 요청별 종료/deadline 검사, 소유권 거부·정리 불명 오류 및 `test_report_supervised.py`의 pending/기간 로컬 오류와 store/cancel 전파 사례를 읽었다. 실제 감독 fake의 TERM 무시 손자와 다음 scope 전 종료 관찰, timeout·취소·daemon 복구, 계정별 입력, append·latest·재생성, 사진 argv 및 모델 설정 전달, body CLI·취소 후 파일 복구와 실제 fence 경합 코드도 추적했다. 새 코드에서 지정 수정으로 인한 입증된 추가 회귀는 찾지 못했다.

## 미해결·차단과 남은 검증

입증된 미해결 결함: 없음. 정적 검사 차단: 없음. 실제 프로세스·PG·Codex sandbox 동작과 작성된 시험의 통과 여부는 이번 리뷰에서 확인하지 않았으며 21.8 실행 증거가 필요하다. 이는 승인된 미실행 범위이고 본 보고서는 해당 실행을 통과로 표현하지 않는다.
