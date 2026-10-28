수정 필요 — 지적 2건(critical 0 / high 1 / medium 1 / low 0)

# Reviewer Gate — 2026-10-28 세 번째 update

검토 범위는 미커밋 spine의 AD-18 tokenstore 예외와 Table Contract `chunks` 행 두 변경이다. 기록된 Decision은 유지하며, 구현 단위가 갈라질 여지만 검토했다. 테스트·빌드·Docker·설치·커밋은 실행하지 않았고 운영 tokenstore는 열지 않았다.

아래 `S`는 `_bmad-output/personal-brain/architecture-brain-v1-slice-1/architecture-brain-v1-slice-1.md`, `T`는 `_bmad-output/personal-brain/tickets/`다. `A`는 `_bmad-output/personal-brain/prep-garmin-absorption/inputs/garmin-source.tar.gz` 안의 `garmin-source/`다. archive의 소스·설정·lock·테스트 텍스트만 저장소 밖 임시 디렉터리에 풀어 읽었으며, `A/파일:행`은 그 archive 구성원의 행 번호다.

## 1. rubric

Decision 전사는 맞다. `S:320`은 `T/epic-garmin-runtime/epic-garmin-runtime.md:97` 및 같은 spine 폴더 `.memlog.md:193`을 반영한다. `S:563`은 `T/epic-search-and-health-query/epic-search-and-health-query.md:90` 및 `.memlog.md:194`를 반영한다. epic 4의 이월 문제(`T/epic-recall-and-mirror/epic-recall-and-mirror.md:72`)도 정확히 겨냥한다. 다만 다음 두 정의를 보완해야 같은 구현을 강제할 수 있다.

### R1 — high: 같은 시각 묶음의 분할 금지가 긴 메시지 분할까지 금지한다

- **근거:** `S:563`은 같은 `occurred_at` 묶음을 조각 경계에서 쪼개지 말라고 예외 없이 쓰지만, 같은 행과 AD-15(`S:277`)은 2,400자를 넘는 메시지를 분할하라고 한다. E17-1(`T/epic-search-and-health-query/epic-search-and-health-query.md:43`)도 두 규칙을 그대로 병기한다.
- **조건·결과:** 같은 시각에 5,000자 메시지 A와 짧은 메시지 B가 있으면 A를 나누는 순간 그 시각 묶음은 여러 조각에 걸친다. 묶음 우선 구현은 A를 나누지 않고, 길이 우선 구현은 묶음을 나눈다. 둘 중 어떤 예외가 맞는지 계약으로 판정할 수 없다. `part` 컬럼만 추가해도 이 경계 충돌은 사라지지 않는다.
- **바꿀 문장 제안:** `S:563`의 마지막 문장을 다음으로 구체화한다. “같은 `occurred_at` 메시지 묶음은 일반 메시지 경계 분할에서 하나의 단위로 취급한다. 단, 2,400자를 넘는 메시지의 내부 분할은 이 금지의 예외이며, 이로 생긴 모든 조각은 실제 메시지 시각을 유지하고 아래 `part` 규칙으로 구별한다.” 이는 이미 채택한 긴 메시지 분할과 시각 보존을 함께 구현하기 위한 우선순위 명시다.

### R2 — medium: ‘결정적 번호’만으로는 번호의 범위와 재생성 호환성이 정해지지 않는다

- **근거:** `S:563`은 비분할 0만 정하고, 분할 번호의 시작·유일 범위·동일 시각 복수 메시지의 매핑은 정하지 않는다. 자연 키를 UNIQUE로 강제한다는 AD-8(`S:182`)과 같은 원문의 같은 경계를 요구하는 E17-1(`T/epic-search-and-health-query/epic-search-and-health-query.md:43`)을 만족하려면 입력과 키의 대응이 하나여야 한다. 같은 시각의 대화 순서는 정하지 않는다는 `S:184`도 고려해야 한다.
- **조건·결과:** chunker는 메시지마다 1부터 번호를 매기고, redact 재생성은 시각 범위마다 1부터 번호를 매길 수 있다. 각각 결정적이지만 같은 시각의 긴 메시지 둘을 나누면 전자는 `(from_at, to_at, part)`를 재사용한다. 한 메시지만 있어도 0부터 시작하는 구현과 1부터 시작하는 구현 모두 현재 문장을 만족해 같은 조각의 키가 달라진다.
- **바꿀 문장 제안:** `S:563`에 덧붙인다. “`part`는 같은 `(session_id, index_config_id, from_at, to_at)` 안에서 유일한 비음수 정수다. 분할 없는 단일 조각은 0, 분할 조각들은 1부터 연속 배정하며 메시지마다 초기화하지 않는다. 같은 시각 입력의 조각 생성용 정규 나열과 코드 포인트 분할·번호 배정은 Core chunker 하나가 정의하고 증분 생성·redact 재생성이 공유한다. 이는 같은 시각 메시지의 대화상 선후관계를 부여하지 않는다. 규칙과 버전은 `index_configs.chunk_params`에 기록한다.”

그 밖의 대조 결과:

| 계약 | 판단 |
| --- | --- |
| AD-8·Table Contract | `part`는 조각의 자연 키 구성 요소이며 메시지에 순번을 되살리는 변경은 아니다. UUIDv7 `id`와 별개다. R2를 보완하면 UNIQUE로 강제할 수 있다. |
| AD-11 | `S:229`의 redact 삭제 조건은 시각 범위로 모든 조각을 잡으므로 `part`별 누락을 요구하지 않는다. 현 SQLite `packages/sqlite/src/sessions.ts:164`도 같은 범위 삭제다. 번호를 하나 골라 삭제하는 구현은 기존 계약 위반이다. |
| AD-15·Conventions | 원문 색인·머리말 없음·코드 포인트 위치(`S:277`, `S:280`, `S:631`)와 충돌하지 않는다. R1·R2의 경계·번호 정의가 필요하다. |
| AD-24 | `document_chunks`는 `(extraction_id, ordinal)`과 locator 계약(`S:400`, `S:574`)을 유지한다. 대화 `chunks.part`를 문서 조각에 적용할 근거는 없다. |
| AD-29·30·33 | tokenstore는 확장 인증의 파일 접근 예외이고 core의 확장 raw view 읽기 제한(`S:472`)을 바꾸지 않는다. 설정 코덱·snapshot 소유권(`S:510`)도 유지된다. 예외는 Garmin 세션 내용에 한정되어 다른 비밀의 `.env` 복제를 허용하지 않는다. |

**지금 코드와의 차이:** `packages/core/src/domain/chunk.ts:8`은 네 요소 키를 설명하고 `:19` 뒤에도 `part`가 없다. `packages/sqlite/migrations/0006_drop_message_seq.sql:106`은 네 요소 UNIQUE다. 현 PG baseline도 `packages/postgres/migrations/0001_initial.sql:141`에서 아직 `seq_from/seq_to`를 사용한다. 따라서 문서 갱신만으로 작동하는 기능은 아니다. 다만 0006 자체가 아직 chunk writer가 없음을 명시(`:117`)하고 epic 17이 writer와 새 키를 소유하므로, 이를 이번 문서 변경의 별도 결함으로 세지 않는다. 기존 0006을 고치지 말고, 실제 구현 HEAD에서 필요한 다음 PG 마이그레이션과 Core 타입을 함께 맞춰야 한다(Conventions `S:642`).

## 2. adversary

### 대조 A — chunker와 redact 재생성

두 단위가 같은 5,000자 메시지의 본문 경계를 동일하게 만들되, 최초 chunker는 분할 번호를 `0,1,2`, 재생성 함수는 `1,2,3`으로 정한다고 가정했다. 둘 다 “결정적 분할 번호, 비분할 0”를 지킨다. 비분할인 경우에만 0을 쓰라는 금지는 현재 없다. 같은 입력의 키가 달라지고 별도 upsert 경로에서 중복이 생길 수 있다. AD-11대로 전량 삭제하면 그 경우의 잔존 중복은 막지만 두 구현의 키 불일치는 남는다.

막을 문장은 R2의 시작 번호·범위·공유 chunker 규칙이다. 같은 시각 긴 메시지 둘에는 R1의 예외와 R2의 범위 내 연속 번호를 함께 적용해야 한다. 독립 구현이 각자 결정적이라는 성질만으로는 단위 간 동일성을 보장하지 못한다. 이 대조는 R1·R2의 재현이며 지적 수에 중복 가산하지 않는다.

### 대조 B — epic 16 인증과 epic 13 설정 snapshot

epic 16은 전달받은 `garmin.tokenstore` 경로를 `login(path)`에 넘기고, epic 13은 모든 비밀을 `.env`로 해석하여 세션 바이트를 환경 변수로 복사하는 구현을 시도했다. 후자는 `S:320`의 “snapshot에는 경로만, 내용은 라이브러리만”을 어겨 탈락한다. 경로 대신 토큰을 inline snapshot에 싣거나 인증 프로세스가 `.env`를 직접 읽는 경우도 각각 `S:320`·`S:510`이 막는다. 두 변경을 글자 그대로 지키면서 이 불일치를 만드는 반례는 성립하지 않았다.

epic 13의 일반 snapshot 설명(`T/epic-extensions/epic-extensions.md:36`)은 `.env` 비밀 참조를 설명하지만 모든 경로 설정을 비밀 참조로 강제하지 않는다. 그러므로 모순으로 세지 않는다. 소비자에게 예외를 드러낼 인계 문장으로는 “manifest의 `garmin.tokenstore`는 비밀 참조가 아닌 경로 설정이며, Runtime은 경로만 snapshot에 전달하고 Garmin 인증 adapter가 그 위치의 세션 내용을 라이브러리로 연다”를 제안한다. 이는 방어적 명료화이며 추가 지적은 아니다.

## 3. currency

외부 최신 버전을 추정하지 않고, 이전 대상 archive의 고정 코드와 lock을 기준으로 확인했다. 라이브러리를 설치·import·실행하지 않았다.

| 검증 문장 | archive 근거와 판단 |
| --- | --- |
| 기본 위치는 `~/.garmin-pipeline/tokens` | `A/src/garmin_pipeline/config.py:35`와 일치한다. `garmin.tokenstore`는 Brain의 새 이름공간이며 옛 설정 키는 `tokenstore`다. |
| 폴더 0700 | `A/src/garmin_pipeline/auth.py:314`의 `_prepare_tokenstore`가 없는 경로를 생성하고 `:331`·`:336`에서 chmod한다. 라이브러리 자동 보장으로 기술하면 틀리지만 현재 문장은 필요한 권한을 적고 있어 맞다. 무인 smoke는 권한을 바꾸지 않는다는 `A/src/garmin_pipeline/auth.py:19`도 함께 읽어야 한다. |
| 세션 파일 0600 | `A/src/garmin_pipeline/garmin/__init__.py:545`가 0600을 명시하고 `:546`은 `client.client.dump(path)`에 위임한다. `A/tests/test_auth.py:176`도 그 권한을 기대하지만 이 테스트는 `login_stubs`를 사용(`:166`)한다. 따라서 archive가 약속한 권한과 위임은 확인했으나, 이 자료만으로 외부 라이브러리의 모든 저장 경로나 기존 파일 권한 교정을 실증한 것은 아니다. |
| 내용은 login/dump에 위임 | 무인 경로는 `A/src/garmin_pipeline/garmin/__init__.py:477`의 `client.login(path)`다. 대화형은 `:495`의 내부 client login, MFA 시 `:517`의 `resume_login`, 끝에는 `:546`의 dump다. “login/dump”는 이 인증 계열 호출을 요약한 말로 맞으며 MFA 재개까지 금지한다고 읽을 이유는 없다. mtime만 보는 `:388`은 내용 읽기가 아니므로 예외와 충돌하지 않는다. |
| 현재 전제의 의존 버전 | `A/uv.lock:472`부터 잠긴 garminconnect는 0.3.17이다. 예전 garth 형식을 Brain이 직접 재구현할 근거가 없으며, AD-18의 라이브러리 위임은 이 archive 호출 모양에 부합한다. |

currency의 독립 지적은 0건이다. 구현 인계 시 권한의 작성자를 분명히 하려면 “인증 진입점은 기존 tokenstore 폴더를 0700으로 준비하고, 세션 저장은 라이브러리에 위임하되 파일 0600 계약을 검증한다. 내용은 직접 파싱하거나 복제하지 않는다”로 명시할 수 있다. 이는 새 보관 방식을 제안하는 것이 아니라 현재 0700/0600 규칙의 집행 위치를 설명하는 문장이다.

리뷰가 요구하는 수정은 R1·R2 두 건이다. tokenstore 예외나 `part` 도입 Decision 자체를 재논의할 새 증거는 발견하지 못했다.
