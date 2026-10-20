# 2.7 follow-up 리뷰 (2026-10-20)

deferred-work의 "2.7 follow-up 리뷰"(2026-10-18) 항목을 닫는 리뷰다. 대상은 parser v3(`9aa07e5`)의 Claude Code parser·도구 대상 규칙과 Core ingest·SQLite store의 커서 경로다. 렌즈는 adversarial·edge-case-hunter·verification-gap 셋이고, 미뤄 둔 "has not reported yet" 문장은 다시 세지 않았다. 처분 칸은 이 리뷰를 받은 티켓이다.

실측은 이 Mac의 메인 transcript(약 210개)에서 구조와 건수만 셌다.

## 처분 요약

- 21(수집 경로 보강): 커서 경고·대화 순서 읽기(`occurred_at`, 같으면 `seq`)·`start_source`(처음 값을 지킴)·예외·큰 transcript 비용.
- 22(보고 판정·출처): 안내 문장·handback 출처와 cwd·user 줄 허용 목록·도구 출력 표시, 꼬리표 근거(cwd가 있는 첫 메시지), deferred의 옛 handback 본문.
- 23(parser v4): 도구 메모 호출 키·ok 판정·대상 규칙·깨진 줄·시각 검증·버린 줄 집계. parser 버전을 여기서 한 번 올린다.
- 18(0005): 도구 메모를 호출 자체로 식별하는 칸 `call_id`.
- 17(마스킹 B): 잘린 도구 대상 끝에 걸친 비밀 조각.

## 지적

| # | 렌즈 | 자리 | 지적 | 처분 |
|---|---|---|---|---|
| 1 | adv·edge | parser `HANDBACK_NOTICE` | 안내 문장을 문장 전체로 맞춘다. 문구가 바뀌거나 이름에 따옴표가 있으면 안내 문장이 보고로 저장된다. 실측: "Read it there" 177건, "has not reported yet" 4건, 실제 동기·비동기 보고 약 14건 | 22: 같은 에이전트의 handback 줄이 있으면 그 결과는 보고가 아니라는 구조 규칙, 문장은 보조 |
| 2 | adv·edge | parser `readHandback` | handback의 출처를 확인하지 않는다. 이 세션이 시작하지 않은 에이전트의 보고도 저장된다 | 22 |
| 3 | edge | parser 추적 정보 | handback 줄은 보낸 서브에이전트의 cwd·branch를 가진다. 첫 메시지면 세션 꼬리표가 서브에이전트 워크트리가 된다 | 22 |
| 4 | edge | parser task-notification | `<status>`를 느슨하게 읽고, `<result>`가 둘이면 합친다 | 22 |
| 5 | adv | parser user 줄 출처 | 사람이 아닌 출처를 제외 목록(task-notification·peer)으로 거른다. 새 종류는 사용자 발화로 저장된다 | 22: 허용 목록 |
| 6 | edge | parser 도구 출력 표시 | `<local-command-stderr>`·`<user-prompt-submit-hook>`로 시작하는 줄이 사용자 발화로 저장된다 | 22 |
| 7 | edge | parser 도구 결과 | 대화가 아닌 줄의 `tool_result`가 메모의 ok를 정하고, 끝나지 않은 Agent 호출이 ok false로 굳는다 | 23 |
| 8 | edge | parser 도구 메모 | 첫 메시지 앞의 호출은 메모가 남지 않는다 | 23 |
| 9 | adv·vg | parser·store 도구 메모 키 | 메모는 (세션, 바로 앞에 남은 메시지, 순번)으로 식별된다. 버전 업으로 남는 줄이 바뀌면 같은 호출에 메모가 둘 저장된다(`peer-handback.jsonl`로 재현). CLI 테스트는 v2 상태를 v3로 만들어 이것을 보지 못한다 | 18(칸)·23(쓰기) |
| 10 | edge | store `seq` | 버전 업으로 대화 중간의 보고가 더해지면 `max(seq)+1`을 받아 대화 끝 뒤에 놓인다 | 21: 읽기 정렬(2026-10-20 사용자) |
| 11 | adv·edge | parser 줄 읽기 | 끝이 아닌 줄 하나가 JSON이 아니면 파일 전체를 거부한다. 그 세션은 끝내 수집되지 않는다 | 23 |
| 12 | adv | parser 시각 | timestamp를 `new Date()`만으로 믿는다. 시간대 없는 값은 기계 시간대로 읽히고, 범위 밖 연도는 store에서 예외가 된다 | 23 |
| 13 | adv | 도구 대상 | 대상이 비는 호출이 약 400건이다(AskUserQuestion 106, SendMessage 95, MCP 문서 도구 등) | 23 |
| 14 | edge | 도구 대상 | 도구 이름이 `toString` 같은 기본 객체 키면 대상이 비고 fallback도 건너뛴다. 500자 자르기가 surrogate pair를 쪼갤 수 있다 | 23 |
| 15 | adv | parser 전체 | 무엇을 왜 버렸는지 세지 않는다. 보고 96.3% 누락이 두 스토리를 지나간 이유다 | 23 |
| 16 | adv·edge·vg | ingest 이른 반환 | reset 읽기가 메시지를 찾지 못하면 `warnings: []`로 끝나 `CURSOR_RESET`이 사라지고, 낡은 커서가 남아 매번 처음부터 읽는다 | 21 |
| 17 | edge | store 커서 | reset 읽기 둘이 겹치면 커서가 뒤로 갈 수 있다 | 21 |
| 18 | adv·vg | parser·store `start_source` | 마지막 `SessionStart` 값이 덮어쓴다(실측 37/211 세션이 둘 이상, 34개가 startup→resume). resume·clear·fork는 테스트가 없다 | 21: 처음 값을 지킴(2026-10-20 사용자) |
| 19 | edge | store·ingest 예외 | `toSession`·`recordTranscriptFile`의 예외를 받지 않아 코드 있는 실패 대신 예외가 난다 | 21 |
| 20 | adv | parser 비용 | 커서와 상관없이 파일 전체를 여러 번 훑는다(해시 둘, 정규식, 알림마다 앞부분 검색). 이 Mac의 transcript는 30.7 MB까지 있다 | 21 |
| 21 | adv | 도구 대상 마스킹 | 500자로 자른 뒤에 가리므로 잘린 자리에 걸친 키는 패턴에 맞지 않는다 | 17 |
