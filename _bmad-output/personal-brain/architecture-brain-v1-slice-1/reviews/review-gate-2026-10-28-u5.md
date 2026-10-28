통과 — fix 0 / suggest 2 / ask 0

# Reviewer Gate — AD-6 hook PG 읽기 (2026-10-28 u5)

대상은 미커밋 spine diff 중 AD-6의 동기 hook 문장 하나다. 근거는 `_bmad-output/personal-brain/architecture-brain-v1-slice-1/.memlog.md:201`의 PG 문구 정밀화 결정이다. 검토 도중 다른 워커가 AD-20 등과 memlog 202행을 추가했으므로 그것은 이 판정에서 제외했다. 아래 약칭의 `파일:행`은 현재 저장소 상대 경로로 해석한다.

| 약칭 | 파일 |
| --- | --- |
| spine | `_bmad-output/personal-brain/architecture-brain-v1-slice-1/architecture-brain-v1-slice-1.md` |
| PG세트 | `_bmad-output/personal-brain/tickets/epic-postgres-primary/tickets/tickets.toml` |
| E3세트 | `_bmad-output/personal-brain/tickets/epic-log-and-context/tickets/tickets.toml` |
| E3조사 | `_bmad-output/personal-brain/tickets/epic-log-and-context/epic-log-and-context-research-code-pg.md` |

정적 문서 검토다. 코디네이터가 PostgreSQL 공식 문서 열람만 네트워크 금지의 예외로 허용해 PostgreSQL 18 공식 문서 세 개를 확인했다. 설치·테스트·빌드·Docker·DB 실행·개인 계정 호출은 하지 않았다. 아래 제안은 이미 정한 로컬 PG 읽기 허용·무쓰기·Stop 토글·주입 spool 경로를 다시 묻지 않는다.

## rubric — 강제 가능성과 다른 AD의 일치

수정은 `spine:144`에서 “외부 네트워크 없음”과 “로컬 PG 읽기”를 분리하고, 컨테이너 시작·마이그레이션·drain·모델 호출 금지, 여러 SELECT의 READ ONLY를 명시한다. PostgreSQL 전환을 이유로 hook에서 DB를 전혀 못 읽는 해석을 없애며 기존의 세션 생성/주입 기록 쓰기 금지는 유지한다. 선언은 DB 호출·트랜잭션/command spy, 읽기 전용 fixture, 장애/시간 측정으로 관측 가능하다(`E3세트:34`, `E3세트:151`). 이것은 아직 시험 통과 증거가 아니다.

- AD-7(`spine:170`~`spine:174`): 연결 설정은 adapter 연결 함수 한 곳, hook lock_timeout 1초, 모든 트랜잭션의 잠금 보유는 2초 이내다. 새 문장의 READ ONLY도 트랜잭션이므로 이 상한에서 제외되지 않는다. 일반 SELECT도 DDL과 잠금 충돌할 수 있어 읽기 전용이라는 이유로 timeout을 빼서는 안 된다.
- AD-17(`spine:307`, `spine:311`): Stop은 토글 off에서 DB를 열지 않고, 오류·세션 없음·판정 불명은 무출력 exit 0이다. start 실패는 대체 안내와 시도 spool, stop 시도도 spool→drain이다. 읽기 허용이 DB 쓰기 허용으로 번지지 않아 정합하다.
- AD-27(`spine:436`, `spine:439`)·AD-34(`spine:519`): 컨테이너 재기동은 데몬 책임이고 hook은 직접 처리하며 데몬 없이도 동작한다. 새 금지 목록과 모순이 없다.
- epic 11.7(`PG세트:92`·`PG세트:93`): hook 연결 시간 한도와 PG 공통 factory·오류 매핑을 공급한다. statement_timeout의 공급자는 11.3(`PG세트:44`)이며 11.7의 선행 경로 안이다. “epic 11이 정한 접속·쿼리 상한” 참조가 공급자 없는 선언은 아니다. 현재 코드의 기본 5초가 이미 최종 hook 예산으로 승인됐다는 뜻도 아니다(`E3조사:78`).

새 문장 자체에서 기존 AD와 충돌하는 fix는 발견하지 않았다. 구체 timeout 값은 epic 11의 Core 상수로 정하며 spine에 중복 숫자를 만들 필요는 없다. 다음 두 제안은 구현이 같은 의미를 유지하도록 좁히는 보완이다.

### S1 — 개별 접속/쿼리 상한을 전체 hook deadline에 종속시킨다

- 근거: `spine:144`, `spine:171`, `spine:172`, `PG세트:92`, `E3세트:151`, `E3조사:78`.
- 문제: 새 문장은 접속·쿼리 각각의 한도를 참조한다. Stop 전체 Core 상한과 5초 timeout도 이미 있어 전체를 무한정 써도 된다는 허점은 없다. 다만 pool 획득/접속 재시도·여러 SELECT·출력·spool·해제에 개별 한도를 각각 새로 부여하면 외부 5초 kill에 의존하기 쉽고 실패 시도 기록을 남길 여유가 사라진다. 시작 맥락 역시 SM-7 실측과 개별 SQL 시간은 다른 측정이다.
- 제안: “개별 접속·쿼리 시간은 해당 hook의 남은 전체 시간 예산을 넘지 않으며 시간 초과 시 취소·연결 정리 후 기존 실패 경로로 끝낸다”를 참조 문장 또는 4/12 정제 plan에 고정한다. 무한 재시도와 클라이언트 대기를 개별 statement_timeout으로 대체하지 않는다. 이를 강제할 방법은 실제 driver에서 확인하고, PG 서버 설정만으로 달성했다고 간주하지 않는다.

### S2 — READ ONLY를 여러 SELECT의 동일 snapshot과 혼동하지 않게 한다

- 근거: `spine:144`, `spine:309`, `E3세트:33`, `E3세트:92`; 아래 SET TRANSACTION 공식 문서.
- 문제: READ ONLY는 쓰기 접근 모드다. 기본 READ COMMITTED에서 SELECT 둘은 서로 다른 시점의 commit을 볼 수 있다. 새 문장은 snapshot 일관성 수준을 정하지 않았으므로 같은 snapshot을 보장한다고 설명하거나 그 보장에 의존하는 검증을 쓰면 안 된다. 현재 AD는 동일 snapshot 자체를 강제하지 않으므로 fix로 세지 않았다.
- 제안: 4의 plan에서 단일 질의로 합칠지, 짧은 REPEATABLE READ READ ONLY가 필요한지, 서로 다른 snapshot을 허용할지 선택하고 규칙/최근 로그 동시 변경 fixture의 기대값을 적는다. 어느 선택이든 AD-7의 짧은 트랜잭션·S1의 전체 예산을 지킨다. 시작 맥락 전체를 장기 snapshot으로 만들라는 새 요구는 아니다.

## adversary — 문장을 지키면서 갈라지는 두 단위

**단위 A**는 로컬 PG에서 `BEGIN READ ONLY` 뒤 규칙 SELECT와 최근 로그 SELECT를 실행하고 commit한다. **단위 B**는 `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY`에서 같은 SELECT 둘을 실행한다. 둘 다 새 문장의 외부 호출 없음·무쓰기·여러 SELECT READ ONLY·시간 상한을 지킬 수 있다.

첫 SELECT 뒤 다른 세션이 규칙/로그를 바꾸면 A의 두 번째 SELECT는 새 commit을 볼 수 있지만 B는 첫 snapshot을 유지한다. 두 결과의 출력 내용은 달라질 수 있다. 새 문장이 틀렸다는 반례가 아니라 문장이 고정한 것은 쓰기 모드이며 snapshot까지는 아니라는 경계다. S2로 정제할 내용이고 별도 중복 건수로 세지 않는다.

시간도 나눠 확인했다. 각 연결/SELECT가 자체 한도 안에 들어와도 호출 전체가 5초를 넘는 Stop 구현은 기존 `spine:144`의 **전체** 상한을 위반한다. 이를 “새 문장을 지키는 두 번째 합법 구현”으로 제시하지 않았다. 외부 timeout으로만 종료해 시도 spool을 잃는 경계를 S1로 보완한다. READ ONLY 중 차단 잠금을 기다리는 SELECT 역시 금지된 쓰기는 아니지만 AD-7 시간 상한의 적용 대상이다.

## currency — PostgreSQL 18 공식 사실 확인

확인일 2026-10-28. repo의 채택 버전은 PostgreSQL 18(`spine:517`)이라 버전 고정 문서를 사용했다.

| 사실 | 확인한 공식 근거와 이 문장에 미치는 의미 |
| --- | --- |
| READ ONLY는 접근 모드이며 일반 영속 표의 DML·DDL 등을 막는다. 모든 디스크 쓰기를 없애는 보장은 아니다. 격리 수준과는 별개다. READ COMMITTED는 statement 시작 전 commit을 보고 REPEATABLE READ는 첫 query의 snapshot을 유지한다. | [SET TRANSACTION](https://www.postgresql.org/docs/18/sql-set-transaction.html). hook에서 영속 DB 쓰기를 막는 요구와 양립한다. READ ONLY를 동일 snapshot·무잠금 보장으로 확대하지 않는다(S2). |
| statement_timeout은 서버에 command가 도착한 뒤부터 해당 statement 완료까지 잰다. 단위 생략 시 ms이고 0은 비활성이다. 여러 statement에는 각각 적용된다. lock_timeout은 잠금 획득 대기에만 적용되고 transaction_timeout은 트랜잭션 전체의 별도 설정이다. | [Client Connection Defaults](https://www.postgresql.org/docs/18/runtime-config-client.html#GUC-STATEMENT-TIMEOUT). 쿼리 한도만으로 접속·클라이언트 처리·전체 hook 시간을 증명할 수 없다(S1). |
| libpq의 connect_timeout은 초 단위 정수이며 0·음수·생략은 무한 대기다. host/address마다 별도 적용된다. 비동기 PQconnectPoll은 이 값을 따르지 않아 애플리케이션이 시간 경과를 관리한다. | [Database Connection Control Functions](https://www.postgresql.org/docs/18/libpq-connect.html#LIBPQ-CONNECT-CONNECT-TIMEOUT). 이 사실을 Node PG driver의 동일 동작이라고 단정하지 않았다. 실제 driver의 연결/pool/cancel 계약은 구현 때 확인하고 hook 전체 deadline을 적용한다(S1). |

공식 문서 확인 결과, 로컬 TCP 읽기·READ ONLY 트랜잭션·시간 제한을 함께 쓰는 변경 방향은 유효하다. SQL 접근 모드와 시간 상한은 독립된 장치이며 둘 다 필요하다. 별도 버전 업·새 드라이버 설치·실행 검증을 이 검토가 요구하거나 수행한 것은 아니다.
