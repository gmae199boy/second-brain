수정 후 재검증 — 지적 1(R1, rubric); adversary 추가 0 / currency 추가 0.

2026-10-28. 미커밋 spine diff의 명령 표 backup 행, AD-20, Conventions 내보내기, Deferred 백업 묶음 행을 정적으로 리뷰했다. AD-6 변경은 다른 리뷰 소유라 제외했다. 근거 Decision은 같은 폴더 `.memlog.md:202`이며 원문 백업 U2·로컬 블롭 범위·새 홈 복구·JSONL 복구 유보를 다시 선택하지 않았다. 테스트·빌드·Docker·설치·커밋과 운영 DB 접근은 하지 않았다.

약칭 `spine`은 `_bmad-output/personal-brain/architecture-brain-v1-slice-1/architecture-brain-v1-slice-1.md`, `에픽`은 `_bmad-output/personal-brain/tickets/epic-operations/epic-operations.md`, `세트`는 그 에픽의 `tickets/tickets.toml`이다. 행은 검토 시점 기준이다.

## rubric — 강제 가능성과 공통 계약

### R1 — 가린 내보내기에 원문 bytea 짝 칸의 처리 계약이 없다

- 위치: `spine:644`(Conventions 내보내기), `spine:222`·`spine:223`(AD-11); 소비자 `에픽:39`, `세트:68`·`세트:69`.
- 조건: U+0000과 합성 비밀이 함께 든 메시지는 text 투영과 원문 UTF-8 bytea 짝 칸을 함께 갖는다. “테이블당 JSONL”을 저장 행 기준으로 구현하고 텍스트 칸만 가리면, 짝 칸을 hex/base64로 내보내는 구현도 현재 구체 문장을 충족한다. 코덱을 인코딩된 문자열에 적용해도 원래 비밀 패턴이 보이지 않는다.
- 결과: 표시용 body는 가려져도 짝 칸을 디코딩하면 비밀이 복원된다. 6의 JSONL에서 비밀 문자열을 직접 찾는 시험도 통과할 수 있다. 원문 backup은 허용된 비밀 보존이고 이 JSONL은 가린 산출물이므로 둘의 보증이 달라야 한다.
- 교정: 논리 원문을 짝 칸에서 복원한 뒤 출력 코덱을 적용하고, 원문 짝 칸을 그대로 직렬화하지 않는다고 Conventions/E5-6/6에 연결한다. 가린 텍스트의 저장 표현을 함께 낼지 짝 칸을 생략할지는 논리 형식에서 정하되 원문이 복원되면 실패다. U+0000+비밀 fixture로 역직렬화·디코딩까지 확인한다. Brain 소유 파일 본체를 가리지 않는 기존 결정과 원문 dump 보존은 바꾸지 않는다.

그 밖의 대조 결과:

| 계약 | 판정과 근거 |
| --- | --- |
| AD-11 | 원문 backup/가린 export 분리, redaction 기준점과 옛 백업 안내는 `spine:228`, `spine:349`, `에픽:38`, `세트:56`·`세트:57`이 맞는다. 새 백업만 떠도 옛 묶음 경고가 사라지지 않는다. R1만 보완한다. |
| AD-19 | `spine:348`의 upgrade/플러그인 공통 함수·doctor 뒤 마지막 완료 기록은 기존 완료 검증과 일치한다(`spine:332`). 직접 upgrade가 별도 완료 기록 writer를 만드는 뜻으로 읽지 않도록 공통 함수 호출을 유지한다. 실패 시 미전진은 `세트:45`가 맡는다. |
| AD-23 | `spine:349`의 Brain 소유 로컬 블롭만 복사, remote_only/external은 manifest, 새 files 루트 재바인딩이 locator 계산·외부 쓰기 거부(`spine:384`, `spine:385`)와 맞는다. 외부 원본 자동 다운로드나 덮어쓰기를 요구하지 않는다. |
| AD-30 | globals·owner·ACL·확장 role 복원은 `세트:32`·`세트:33`에서 실제 non-superuser/NOBYPASSRLS의 출처 분리를 확인한다. 관리자 복원 성공을 RLS 검증 성공으로 대신하지 않는다. 에픽에 새로 붙인 추가 확인 문장의 권한 범위 문제는 세트 재검증 F8로 기록했다(같은 문제를 spine 지적으로 중복 계산하지 않음). |
| AD-31 | `spine:346`의 restore/upgrade 허용 경로 모두 단일 실행기, 소유자별 버전·체크섬·advisory lock을 소비한다(`spine:482`·`spine:484`). 복원 버전 표를 현재 버전으로 덮어쓰지 않고 필요할 때만 core→확장 적용은 `에픽:36`, `세트:32`에 있다. |
| AD-34 | 새 홈/project/volume/port/Label은 `spine:522`의 epic 11 자원 이름 파생을 소비한다. `spine:517` 기본 자원 이름을 대상에도 재사용하는 뜻이 아니다. `spine:350`은 데이터 삭제에 --delete-data와 별도 확인을 요구한다. |
| Conventions·Deferred | `spine:644`는 JSONL 되살리기를 명시적 backlog로 바꿨고, `spine:782`는 원문 backup 복구의 확정 범위를 가리킨다. 상세 manifest·복원 순서는 `에픽:34`·`에픽:36`, `세트:8`·`세트:32`가 구현할 수 있다. 확정 결정을 Deferred로 다시 열지 않는다. |

## adversary — 계약을 지키면서 갈라질 두 단위

추가 지적 0. 아래 반례는 변경 후 문장과 entry의 결합으로 배제되거나 후속 plan의 명시된 의무다. 실제 동작을 확인했다는 뜻은 아니다.

1. **restore 재바인딩 ↔ doctor/확장 설치:** archive 원문 설정의 URL을 유지한 채 새 volume만 만들고 doctor를 돌리는 구현을 대입했다. `에픽:36`·`에픽:115`는 동일 실경로/자원을 쓰기 전에 거부하고 실행 설정을 재바인딩하며 hook·Label·drain·외부 변경/발신을 검증 중 자동 재개하지 못하게 한다. `세트:9`·`세트:33`의 운영 URL/경로·발신 대기 행 fixture와 외부 호출 0은 이 분기를 구별한다. 원문 사본의 hash는 묶음 검증이고 재바인딩된 실행 설정은 대상 격리 검증이다. doctor의 읽기/연결 확인과 예약·발신 재개를 합치지 않는다.
2. **backup pin ↔ epic 8 로컬 삭제 handler:** pin을 backup 모듈만 읽고 Drive 삭제 handler는 원격 검증 뒤 unlink하는 분기를 대입했다. 이는 `세트:20`이 명시한 가리기·Drive 이전 뒤 로컬 삭제·blob_delete 전부의 보류를 어긴다. epic 8의 기존 원격 사본 재검증(`_bmad-output/personal-brain/tickets/epic-drive/tickets/tickets.toml:8`)은 pin 검사를 대신하지 않는다. 5.2가 기존 handler를 수정하는 소유자이고 이미 8.7 뒤다. `에픽:120`은 pin 등록/snapshot 고정 사이·삭제 직전·복사 중 kill과 다른 살아 있는 백업 pin 보존을 동기화해 확인하도록 한다. 단순 check 후 unlink의 경합을 막을 원자화 방식은 그 plan이 고정할 명시된 범위다.
3. **restore 버전 확인 ↔ 공통 migration 실행기:** 복원 표를 최신으로 덮어쓰고 성공시키는 분기는 `에픽:36`·`세트:32`가 금지한다. post-data trigger·RLS를 복원하지 않고 단순 건수만 비교하는 분기는 `세트:33`의 실제 자격 증명·쓰기 거부·관계 검증에서 탈락한다. 9는 이 공통 확인기를 다시 쓴다(`세트:103`).

## currency — 공식 문서 사실 확인

2026-10-28 읽음. PostgreSQL 명령은 **18 버전** 문서를 사용했다. Compose 동작은 PostgreSQL 문서가 다루지 않으므로 Docker 공식 명령 문서로 따로 확인했다. 아래 명령은 실행 예가 아니라 정적 계약 확인이다.

| 항목 | 확인한 사실과 적용 |
| --- | --- |
| `pg_dump --snapshot` | 지정된 동기 snapshot으로 dump하며 동시 세션과 맞출 수 있다. snapshot id만 적어 두는 것으로 충분하지 않고 다른 reader가 import할 때까지 export한 트랜잭션이 살아 있어야 한다. `세트:20`의 관리 연결·공유 snapshot은 가능한 방식이다. [PG18 pg_dump](https://www.postgresql.org/docs/18/app-pgdump.html), [PG18 Snapshot Synchronization](https://www.postgresql.org/docs/18/functions-admin.html#FUNCTIONS-SNAPSHOT-SYNCHRONIZATION) |
| `pg_dumpall --globals-only --no-role-passwords` | globals는 role만이 아니라 tablespace 등도 담는 SQL이다. 비밀번호 제외 role은 복구 뒤 password가 NULL이라 설정 전 password 인증이 실패한다. 따라서 묶음 .env에서 재설정한다는 계약과 맞는다. 전체 복구의 관리 권한과 복구 후 앱/확장 RLS 검증 권한은 구별해야 한다(세트 F8). [PG18 pg_dumpall](https://www.postgresql.org/docs/18/app-pg-dumpall.html) |
| `pg_restore --section` | pre-data/data/post-data 선택을 지원한다. post-data에는 trigger·index·여러 제약이 있으므로 이를 빼면 복원 완료가 아니다. 오류 즉시 중단에는 기본 동작 대신 `--exit-on-error` 등이 필요하다. `에픽:36`·`세트:8`의 순서·실패 중단 계약은 유효하며 기본 옵션에 맡겨서는 안 된다. [PG18 pg_restore](https://www.postgresql.org/docs/18/app-pgrestore.html) |
| compose exec의 바이너리 stdout | Compose exec는 기본 TTY를 할당하므로 `-T`로 끄는 경로가 필요하다. custom archive stdout은 문자열/출력 가리기 코덱을 거치지 않는 byte stream으로 private 파일에 받고 stderr를 분리하며 종료 실패면 발행하지 않아야 한다. `pg_dump -Fc`는 파일 인자가 없으면 stdout을 쓸 수 있다. 이는 해당 도구 문서에서 도출한 구현 조건이며 실제 바이트 보존 실험은 하지 않았다. 조사 문서의 exec -T 후보와 일치한다. [Docker compose exec](https://docs.docker.com/reference/cli/docker/compose/exec/), [PG18 pg_dump](https://www.postgresql.org/docs/18/app-pgdump.html) |

R1을 보완한 뒤 문서 gate를 다시 확인한다. snapshot/pin·stream·복원 순서의 실제 실행 증거는 5.1~5.3 및 설치본 확인 5.9의 책임이며 이 정적 gate가 대신하지 않는다.
