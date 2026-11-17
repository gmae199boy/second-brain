# Codex 기록 실측 — 23.1

기준 코드 `436c750b98a1bc1d26641852d28098435a185247`, 조사일 2026-11-17, 설치 CLI `codex-cli 0.167.0`. 이 문서는 조사 결과와 후속 구현을 위한 결론을 기록한다. 실제 세션 원문과 식별자는 싣지 않았다.

## 관측과 한계

`~/.codex/sessions`에 JSONL 2,576개(상대 깊이 4), `~/.codex/archived_sessions`에 3개(깊이 1)가 있었다. 전자는 열거 순서 앞 100개, 후자는 3개를 각각 파일당 최대 2,000줄까지 읽었다. 표본의 JSON 파싱·읽기 오류는 0이다. 파일 수는 조사 시점의 값이며 세션 수와 같다는 증거는 아니다. 날짜별 하위 디렉터리와 보관 위치를 모두 스캔해야 한다. 별도 CODEX_HOME, 중복·이동·심볼릭 링크 및 비영구 세션은 조사하지 않았다.

각 표본은 `session_meta`를 포함하고, 활성 100개 및 보관 3개에서 `payload.id`가 파일명에 포함됐다. 활성 표본 모두 `cwd`, `git` 키가 있었으며 `git` 객체에서 `branch`, `commit_hash`, `repository_url` 키가 관측됐다. 보관 3개는 `cwd`가 있었지만 `git` 키는 없었다. 따라서 브랜치는 선택적 증거이며 시작 cwd와 현재 턴 cwd를 구분해야 한다. 활성 표본 44개에 `parent_thread_id` 키, `source` 객체에 `subagent` 키가 관측됐다. 이 키의 존재만으로 모든 부모-자식 관계나 값의 의미를 확정하지 않는다. `id`와 `session_id`는 항상 같은 값이라는 보장이 없다: 활성 표본에서는 파일명에 각각 100개, 56개가 포함됐다.

중립화한 구조 예시(값은 합성, 특정 실제 줄을 복사하지 않음):

```jsonl
{"type":"session_meta","payload":{"id":"<thread>","cwd":"<cwd>","git":{"branch":"<branch>"},"parent_thread_id":"<parent>"}}
{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<text>"}]}}
{"type":"response_item","payload":{"type":"function_call","call_id":"<call>","name":"<tool>","arguments":"<arguments>"}}
{"type":"response_item","payload":{"type":"function_call_output","call_id":"<call>","output":"<output>"}}
```

활성 표본에는 `response_item`의 `message`, `function_call`, `function_call_output`, `custom_tool_call`, `custom_tool_call_output`과 `event_msg`, `turn_context`, `compacted` 등이 있었다. 메시지에서 user·assistant·developer 역할과 `input_text`·`output_text`가 관측됐다. 도구 입력·출력은 별도 항목과 `call_id` 키로 나타나지만 모든 호출에 대응 출력이 있다는 뜻은 아니다. 이벤트에도 메시지 관련 정보가 존재하므로 중복 없이 원문을 고르는 규칙은 fixture로 검증해야 한다.

추가로 활성 폴더에서 수정 시각이 최근인 100개를 골라 같은 파일을 20초 간격으로 두 번 바이너리 읽었다. 100개 중 1개가 커졌고 두 번째 내용의 앞부분은 첫 번째 내용 전체와 같았으며 양 시점 모두 마지막 줄이 개행으로 끝났다. 나머지 99개는 내용이 같았고 읽기 오류는 없었다. 이는 이 관찰에서 append가 발생해 증분 읽기가 가능했음을 보이지만 항상 append만 한다는 보장은 아니다. 부분 마지막 줄, 축소·재작성, 안정적인 메시지 커서 키는 관측하지 못했다. 후속 구현은 불완전 줄을 다음 읽기까지 보류하고 앞부분 변경·축소의 재읽기와 중복 방지를 합성 fixture로 검증해야 한다. 파일 크기만으로 안전한 증분을 보장할 수 없다.

### 세션 및 자식 식별

활성 2,576개 파일의 첫 JSON 줄을 모두 읽은 추가 집계에서 모두 `session_meta.payload.id`가 문자열이었고, `session_id`는 2,567개에서 문자열이었다. 둘이 같은 것은 1,782개였다. `parent_thread_id`가 문자열인 785개는 모두 `source.subagent` 객체를 가지고 서로 다른 자기 `id`와 함께 존재했으며 그 부모 값은 모두 활성 파일 중 다른 `id`와 일치했다. 그중 784개에서 `session_id`가 부모 값과 같았다. 이는 관측된 자식이 별도 파일과 고유 `id`를 가지며 `session_id`를 자신의 고유 키로 취급하면 부모와 충돌할 수 있다는 직접 근거다. 단 하나의 다른 경우와 누락 값 및 보관 파일, 다른 버전에서의 의미는 일반화하지 않는다.

후속 수집은 관측된 파일별 `payload.id`를 세션 단위의 후보로 삼고 부모 ID와 관계를 별도 보존해야 한다. 파일명만 믿지 말고 메타데이터와 불일치·누락·동일 ID의 이동/중복에 대한 정책 및 fixture를 정해야 한다. 상위 대화에 자식 원문을 합쳐 저장하거나 `session_id`만을 키로 쓰면 서로 다른 파일을 잃을 위험이 있다. 현행 Store가 관계 표현을 지원하는지는 별도 확인해야 하며 공통 계약 변경을 이 조사에서 결정하지 않는다.

## 트리거

로컬 `codex --help`에는 hook 신뢰 관련 옵션이 있고 `codex features list`에서 `hooks`는 stable/true로 나타났다. [OpenAI Hooks 문서](https://learn.chatgpt.com/docs/hooks)는 `Stop`, `SessionEnd`, `SubagentStop` 등의 이벤트와 공통 `session_id`, nullable `transcript_path`, `cwd`를 설명한다. 서브에이전트 hook의 `session_id`는 부모 기준이며 transcript 형식은 안정 인터페이스가 아니라고 명시한다. 문서상 지원과 이 설치에서 hook을 실제 실행해 확인한 사실은 다르다. `SubagentStop`에는 별도의 `agent_id`와 nullable `agent_transcript_path`도 문서화돼 있다. 이 조사에서는 hook을 설치·실행하지 않아 실제 전달과 신뢰 설정은 검증하지 않았다.

[OpenAI 설정 레퍼런스](https://learn.chatgpt.com/docs/config-file/config-reference)는 `notify`를 JSON 페이로드를 받는 명령의 문자열 배열로 정의하며 프로젝트 설정의 `notify`는 무시하고 사용자 수준에서 설정하도록 명시한다. 로컬 사용자 설정 파일에 최상위 `notify` 항목이 존재하는 것도 읽기 전용으로 확인했다. 설정값·명령과 실제 호출 결과는 조사하거나 공개하지 않았으므로 이 기계에서 성공적으로 호출되는지와 페이로드의 이벤트 종류·파일 경로 제공 여부는 미확인이다. 설정 항목의 존재는 설치 버전의 실행 지원 검증을 대신하지 않는다. 기존 사용자 notify를 덮어쓰는 연결은 피하고, 트리거를 쓰더라도 누락·실패·과거 기록을 회복하는 스캔을 유지해야 한다.

## 재현 절차

1. `codex --version`과 `codex --help`를 읽고, 공식 Hooks 문서의 이벤트·입력·제한을 확인한다. 설정이나 hook을 바꾸지 않는다.
2. `~/.codex/sessions`와 `~/.codex/archived_sessions`에서 `*.jsonl`을 재귀 열거한다. 파일 경로나 식별자를 출력하지 않고 파일 수와 루트 기준 깊이별 수만 집계한다.
3. 각 루트의 처음 100개 파일(보관은 전부), 파일당 처음 2,000줄을 바이너리 읽기 전용으로 JSON 파싱한다. 최상위 `type`, `payload.type`, 키 이름, `message`의 role·content type, `session_meta`의 `git` 및 `source` 하위 키만 집계하고 오류 수를 센다. 파일명과 `payload.id` 및 `payload.session_id`의 포함 여부는 불리언 합계만 낸다. 디렉터리 열거 순서는 고정 표본이 아니므로 숫자는 달라질 수 있다.
4. 전체 활성 파일의 첫 줄만 읽어 `id`, `session_id`, `parent_thread_id`, `source.subagent`의 타입·동등 여부를 집계한다. 파일별 `id` 집합에 부모 ID가 포함되는지 비교하되 실제 값은 출력하지 않는다.
5. 최근 수정된 활성 파일 100개를 고르고 내용을 읽기 전용으로 메모리에 보관한다. 20초 뒤 같은 파일을 다시 읽어 크기, 전체 바이트의 접두 일치, 마지막 개행, 같은 크기의 내용 변경 및 오류 수만 집계한다. 원문·경로·지문·ID는 출력하지 않는다. 관찰은 그 시점의 표본에 한정한다.
6. `codex features list`에서 hooks 상태를 확인하고 사용자 설정의 최상위 `notify` 키 존재 여부만 검사한다. 설정값을 출력하거나 명령을 실행하지 않는다.

## 후속 결정에 필요한 사항

2는 역할·도구 대응 및 안정적 합성 식별자와 원문 중복 제거를 fixture로 검증해야 한다. 3은 두 루트, 보관 이동 중 중복, 미완성 줄, 재작성·재스캔과 hook 실패 복구를 다뤄야 한다. 4는 `session_meta.cwd`의 최초 증거와 선택적 git 정보를 분리한다. 관측된 자식은 별도 파일과 ID이므로 파일별 세션을 기본으로 하되 부모 관계의 Store 표현 가능성 및 hook/notify의 실제 실행·기존 설정 공존을 후속 작업에서 검증한다. 이 조사만으로 형식 안정성이나 모든 실행 환경의 지원을 단정하지 않는다.
