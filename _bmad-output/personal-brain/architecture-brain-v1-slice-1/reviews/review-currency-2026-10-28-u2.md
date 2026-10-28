수정 필요 — critical 0 / high 0 / medium 1 / low 0

# currency 리뷰 — 2026-10-28 두 번째 update

확인일: 2026-10-28. 미커밋 spine diff와 `.memlog.md` 마지막 여섯 줄, 지정된 에픽 Notes·세트 검증 F1·이니셔티브 결정을 대조하고 공식 문서·공식 소스·배포 목록을 읽었다. 정적 검토만 했으며 테스트·빌드·Docker·설치·모델 호출·실데이터 capture·커밋은 하지 않았다. 아래 줄 번호는 검토 시점 파일 기준이다.

`spine`은 `_bmad-output/personal-brain/architecture-brain-v1-slice-1/architecture-brain-v1-slice-1.md`를 뜻한다.

## 지적

### M1 — U+0000 처리 범위에 transcript 문자열을 담는 jsonb의 경계가 빠졌다

- 근거: `spine:222`의 새 규칙은 모든 `text` 칸만 대상으로 한다. `spine:558`도 같은 범위다. 반면 `spine:627`은 내부 구조 값은 `jsonb`, 외부 JSON 원문은 `text`이고 거르기용 `jsonb` 사본을 허용한다고 정한다.
- 확인한 기술 사실: PostgreSQL 18의 `jsonb`는 문자열 안의 `\u0000`도 거부한다. JSON 직렬화로 실제 NUL을 여섯 ASCII 문자로 escape해도 `jsonb` 파서가 해석하므로 해결되지 않는다. 예를 들어 transcript에서 유래한 구조 `{"target":"a\u0000b"}`는 JSON 문법상 유효해도 `jsonb`로 저장할 수 없다. [PostgreSQL 18 JSON Types](https://www.postgresql.org/docs/18/datatype-json.html) §8.14, 확인 2026-10-28.
- 영향과 범위: 새 `text`+`bytea` 결정 자체는 타당하다. 다만 내부 구조·거르기용 사본으로 같은 문자열을 전달하면 이 코덱을 우회해 거부될 수 있다. 현재 코드에서 이 입력이 이미 실패한다고 단정하는 지적은 아니다. 모든 transcript 입력을 거부하지 않고 보존한다는 새 공통 계약과 기존 DB 타입 규칙 사이의 누락이다. JSON 구조를 저장할 때도 원문 보존 경로가 필요하며, 모든 JSON 칸에 무조건 짝 칸을 추가할 필요는 없다.
- 바꿀 문장 제안(`spine:222` 끝에 추가, `spine:627`에서 참조): “transcript 문자열을 담는 `jsonb`도 U+0000을 거부하므로 같은 저장 경계에서 처리한다. 원문은 `text`/nullable `bytea` 보존 경로에 두고, `jsonb`는 U+0000을 포함하지 않는 파생 투영으로만 저장한다. 원문 읽기는 파생 `jsonb`로 대체하지 않는다. 각 JSON 칸을 만드는 마이그레이션에서 이 경로를 명시한다.”

## 기술 사실 확인 결과

### PostgreSQL 18 text·bytea·JSON

`text`의 NUL 거부와 `bytea`의 0 바이트 허용은 확인됐다. [Character Types](https://www.postgresql.org/docs/18/datatype-character.html), [Binary Data Types](https://www.postgresql.org/docs/18/datatype-binary.html), 확인 2026-10-28.

SQLSTATE 22021도 서버의 인코딩 검증 경로에서 확인했다. 공식 `REL_18_STABLE`의 `pg_verify_mbstr_len`은 NUL을 `report_invalid_encoding`으로 보내고, 그 함수는 `ERRCODE_CHARACTER_NOT_IN_REPERTOIRE`를 낸다. [공식 mbutils.c](https://raw.githubusercontent.com/postgres/postgres/REL_18_STABLE/src/backend/utils/mb/mbutils.c), [오류 코드 표](https://www.postgresql.org/docs/18/errcodes-appendix.html), 확인 2026-10-28. 드라이버가 먼저 거부하거나 SQL 리터럴·JSON 변환으로 넣을 때까지 모두 같은 오류 코드라는 뜻은 아니다. 새 문장은 PG `text`의 제약을 설명하므로 이 차이를 별도 결함으로 세지 않았다.

`json`은 유효한 escape를 원문으로 보존할 수 있지만 `jsonb`는 해석한 NUL을 거부한다. `json`도 문자 변환을 수행하는 함수에서는 실패할 수 있으므로 단순 타입 교체를 권하지 않는다. 외부 JSON을 직렬화된 원문 `text`로 저장하는 규칙과, 해석된 구조를 `jsonb`로 저장하는 규칙을 구별해야 한다. 출처는 M1의 PostgreSQL 18 JSON Types다.

### Codex CLI

비대화형 실행은 `codex exec`다. 모델은 `--model`/`-m`, effort는 설정 키 `model_reasoning_effort`를 `-c`로 넘길 수 있다. 문서에서 도출한 예시는 `codex exec --model <model> -c 'model_reasoning_effort="high"' --json '<prompt>'`다. 모델을 CLI 기본값으로 둘 때는 모델 인자를 생략한다. 지원 effort는 모델·클라이언트에 따라 달라진다. [CLI reference](https://developers.openai.com/codex/cli/reference), [Configuration reference](https://developers.openai.com/codex/config-reference), 확인 2026-10-28.

`--json` stdout은 JSONL 이벤트이며 `turn.completed.usage`에 `input_tokens`, `cached_input_tokens`, `output_tokens`가 있다. 최종 자연어 메시지 대신 완료 이벤트에서 토큰을 읽는 adapter가 가능하다. [Non-interactive mode](https://developers.openai.com/codex/noninteractive), 확인 2026-10-28. 위 OpenAI URL들은 열람 시 공식 ChatGPT Learn 문서로 리다이렉트됐다. AD-35의 사용자 설정과 usage 수집 방침을 뒷받침한다.

### Claude Code CLI

비대화형 실행은 `claude -p`, 모델은 `--model`, 기계 출력은 `--output-format json` 또는 `stream-json`이다. 현재 공식 CLI는 `--effort high`도 제공한다. 문서에서 도출한 단일 실행 예시는 `claude -p '<prompt>' --model <model> --effort high --output-format json`이다. [Headless](https://code.claude.com/docs/en/headless), [CLI reference](https://code.claude.com/docs/en/cli-reference), 확인 2026-10-28.

결과 JSON의 usage 메타데이터로 토큰을 얻을 수 있다. 완료 result의 `usage`는 `input_tokens`·`output_tokens` 및 캐시 관련 수치를 제공하며, 전체 하위 에이전트 사용량까지 세려면 `modelUsage`를 사용한다. assistant 메시지의 중간 `output_tokens`는 완료값이 아니므로 합산하지 않는다. 이어서 실행한 세션의 누적량과 현재 호출량도 구별해야 한다. [공식 usage 설명](https://code.claude.com/docs/en/agent-sdk/cost-tracking), [공식 SDK 타입](https://raw.githubusercontent.com/anthropics/claude-agent-sdk-python/main/src/claude_agent_sdk/types.py), 확인 2026-10-28.

따라서 두 adapter가 ABI v1 usage를 채우는 것은 가능하다. 다만 공급자별 입력·캐시 수치의 포함 관계, 완료 이벤트 없는 종료 시 미관측 값, CLI 버전별 필드 검증은 epic 18 구현에서 정규화해야 한다. spine은 특정 필드의 일률적 복사를 요구하지 않아 추가 지적으로 세지 않았다. 사용자 설정·기본값 결정은 재논의하지 않는다.

### SQLite 읽기 전용 소스 backup

`sqlite3.connect("file:source.db?mode=ro", uri=True)`로 소스를 열고 `source.backup(destination)`을 호출하는 조합은 가능하다. Python은 읽기 전용 URI와 동시 접근 중 backup을 각각 지원한다. SQLite C API는 소스에 읽기 잠금을, 대상에는 쓰기 트랜잭션을 사용하며 read-only 거부 조건은 대상에 적용된다. 따라서 새 AD-36 문장은 기술적으로 성립한다. 대상 연결은 쓰기 가능해야 한다. [Python 3.14 sqlite3](https://docs.python.org/3.14/library/sqlite3.html#sqlite3.Connection.backup), [SQLite Online Backup API](https://www.sqlite.org/c3ref/backup_finish.html), 확인 2026-10-28.

보장 범위는 DB별 일관 백업이다. 여러 DB와 별도 파일까지 동일 시점으로 원자 capture하는 API는 아니다. 파일 복사 전후 해시·참조 관계 전수 검증은 여전히 필요하다. spine은 별도 파일 검증과 반입 검증, capture 이후 변경의 epic 16 이관을 명시하므로 writer 정지 결정을 다시 요구하지 않는다.

### psycopg[binary] 3 / Python 3.14 / macOS arm64

Python 3.14 지원은 공식 릴리스 노트의 3.2.10에서 확인했다. 현재 PyPI 공식 배포 목록에는 `psycopg_binary-3.3.6-cp314-cp314-macosx_11_0_arm64.whl`이 실제로 있다. `psycopg[binary]`가 자체 libpq 등을 포함해 별도 빌드 도구 없이 설치되는 방식도 공식 설치 문서로 확인했다. [릴리스 노트](https://www.psycopg.org/psycopg3/docs/news.html#psycopg-3-2-10), [배포 파일](https://pypi.org/project/psycopg-binary/3.3.6/#files), [설치 문서](https://www.psycopg.org/psycopg3/docs/basic/install.html), 확인 2026-10-28.

설치 문서에는 arm64 macOS 14.0 이상이라는 경고도 남아 있어 wheel 태그의 최소 버전만으로 런타임 호환성을 단정할 수 없다. `3` 전체 릴리스가 Python 3.14를 지원한다는 뜻도 아니다. Deferred가 14.1의 frozen 설치·arm64 import·DB 접속을 아직 남은 검증으로 적은 것은 정확하다. Python 3.14.8 pin을 바꾸거나 이번 문서 리뷰에서 설치를 요구할 새 증거는 없다.

## 나머지 변경 문장의 근거와 한계

AD-30의 `<scope>/<원래 key>`, AD-32의 권위 순서·revision·ambiguity, AD-36의 C6 위임과 새 capture 경계는 `_bmad-output/personal-brain/tickets/epic-garmin-import/epic-garmin-import.md:106` 이후 Decision들과 같은 폴더 `epic-garmin-import-validate-set.md:26`의 F1에 근거한다. 외부 기술 API에 관한 사실이 아니라 프로젝트가 정한 계약이며, 새 웹 사실로 번복할 이유를 찾지 못했다.

AD-35의 두 모델 adapter는 `_bmad-output/personal-brain/tickets/epic-health-analysis/epic-health-analysis.md:61`의 사용자 Decision과 `:62`의 Source conflict를 반영한다. 불명 발신 재시도는 `_bmad-output/personal-brain/tickets/epic-channels/epic-channels.md:83`의 사용자 Decision이며 외부 API의 정확히 한 번 전송 보장을 주장하지 않는다. 이니셔티브 끝의 위임 Decision과도 맞는다. Deferred 여섯 줄의 담당 분리·해소 표시는 이 결정들의 반영으로 검토했고, 설치 재현성이나 실제 반입 검증이 이미 완료됐다는 증거로 읽지 않았다.
