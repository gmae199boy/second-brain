통과 — 지적 수: critical 0 / high 0 / medium 0 / low 0

## 범위와 판정 기준

2026-10-28 두 번째 미커밋 update의 AD-11·30·32·35·36, Table Contract `messages` 행, Deferred 여섯 줄을 정적으로 검토했다. 테스트·빌드·Docker·설치·커밋은 실행하지 않았다. 실제 private capture나 건강값은 열지 않았다.

아래 경로 별칭은 모두 저장소 상대 경로다. `별칭:행`은 해당 파일의 현재 행을 뜻한다.

| 별칭 | 파일 |
| --- | --- |
| spine | `_bmad-output/personal-brain/architecture-brain-v1-slice-1/architecture-brain-v1-slice-1.md` |
| memlog | `_bmad-output/personal-brain/architecture-brain-v1-slice-1/.memlog.md` |
| 추천결정 | `_bmad-output/personal-brain/decisions-by-recommendation.md` |
| 이전에픽 | `_bmad-output/personal-brain/tickets/epic-garmin-import/epic-garmin-import.md` |
| 이전검증 | `_bmad-output/personal-brain/tickets/epic-garmin-import/epic-garmin-import-validate-set.md` |
| 이전세트 | `_bmad-output/personal-brain/tickets/epic-garmin-import/tickets/tickets.toml` |
| 분석에픽 | `_bmad-output/personal-brain/tickets/epic-health-analysis/epic-health-analysis.md` |
| 채널에픽 | `_bmad-output/personal-brain/tickets/epic-channels/epic-channels.md` |
| 이니셔티브 | `_bmad-output/personal-brain/initiative-personal-brain.md` |

판정 대상은 “계약을 모두 지키면서도 서로 맞지 않는 두 구현”이다. 명시된 계약 하나를 어기는 구현, 이미 소유자가 정해진 컬럼명·키 이름의 구현 선택, 후속 코드가 아직 없다는 사실은 지적으로 세지 않았다. 사용자·추천 Decision을 다시 열지 않았다. 아래 값과 상황은 모두 합성 반례다.

## 공격한 구현 쌍

### 1. epic 11 메시지 writer ↔ 도구 메모 writer ↔ epic 17 읽기

- **시도:** 메시지는 `body_raw`에 전체 UTF-8을, 도구 메모는 다른 이름의 짝 칸에 U+0000 위치만 저장한다. 조회는 `body_raw`만 복원하거나 짝 칸 없는 것으로 보고 U+FFFD를 원문처럼 돌려준다.
- **막히는 근거:** `spine:222`는 모든 transcript 유래 `text` 칸에 Store 쓰기 코덱 하나를 적용하고, 짝 칸의 내용도 **원래 문자열 전체의 UTF-8 바이트**로 정한다. 읽기는 짝 칸 우선이며 Core에는 원문을 돌려줘야 한다. `spine:558`은 `tool_notes`를 명시적으로 포함한다. `memlog:182`, `추천결정:25`도 같은 결정이다. 이 worktree의 epic 11 Notes에 후속 결정이 없는 것은 지정된 대체 근거로 보완했다.
- **결론:** 위치 목록을 저장하거나 복원을 생략하면 계약 위반이다. 짝 칸 이름이 다르다는 것만으로는 Store 경계의 불일치가 성립하지 않는다. `body_raw`는 예시이며, 모든 칼럼을 같은 이름으로 강제할 필요도 없다.
- **추가 공격:** 검색·색인에 복원한 U+0000을 보내 PG가 거부하게 만드는 구현은 `검색·색인·표시는 이 값을 쓴다`라는 대체 text 사용 규칙에 막힌다. 저장본 가리기 후 원래 bytea를 남기는 구현은 `spine:225`의 지운 내용 비보존 규칙에 막힌다. 새 AD 문장 제안 없음.

### 2. epic 14 publisher ↔ epic 17 현재 값 조회

- **시도:** 앞순위 D2에 값 A, 뒤순위 D4에 값 B를 넣는다. publisher는 A를 현재로 내고 조회는 B가 존재하므로 전체를 ambiguity로 제외한다.
- **막히는 근거:** `spine:493`은 dataset 순서 → 관측 revision → 지원 정규화 버전 순으로 고르고, 미선택 후보는 보관만 하며 ambiguity가 아니라고 구분한다. `이전검증:32`의 문제를 직접 해소했다. `이전에픽:56`, `이전에픽:111`은 정확한 D2 → D1 → D4 → D5 → D3 순서를 고정한다. `이전세트:20`은 공개 계약 문서와 TS/Python 공유 fixture를, `이전세트:21`은 바로 이 앞·뒤 dataset 반례의 기대값을 요구한다.
- **추가 공격:** 같은 dataset·같은 수신 시각에 서로 다른 원문 해시를 넣되 정제 값은 같게 한다. 정제 값만 먼저 합쳐 정상 현재로 만드는 구현은 `spine:493`의 명시적인 `같은 시각·다른 해시` ambiguity 규칙을 어긴다. “같은 값의 동률은 하나”를 그 앞 단계의 revision 충돌까지 무시하는 허가로 읽을 수는 없다. revision 단계가 정해진 뒤 정규화 버전의 정수 비교도 생략할 수 없다.
- **결론:** 두 구현이 각각 다른 현재 값을 고르려면 결정 순서나 ambiguity 조건을 어겨야 한다. 새 AD 문장 제안 없음.

### 3. epic 14 raw importer ↔ epic 16 새 raw 수집

- **시도:** importer는 `day/x`, 수집은 scope 없는 `x`를 쓰거나, activity에도 `day/x`를 써 두 원본을 합친다.
- **막히는 근거:** `spine:471`은 Garmin key를 `<scope>/<원래 key>`로 고정하고 `(source, account, key, endpoint)`가 하나의 원본을 가리키도록 한다. `이전에픽:109`는 day/activity 예시와 epic 16의 동일 정규형 사용을 명시한다. `이전에픽:129`는 뒤 에픽의 수신 계약도 연결했다. `memlog:186`의 scope 충돌 방지 목적과 일치한다.
- **결론:** 원래 key 앞에 올바른 scope를 붙이지 않는 쪽이 계약 위반이다. 단지 두 구현이 정규형 함수를 별도로 가진다는 사실은 서로 다른 정규형을 허용하지 않는다. 새 AD 문장 제안 없음.

### 4. epic 18 Codex adapter ↔ Claude Code adapter

- **시도:** 두 adapter가 DB에서 서로 다른 설정 키를 직접 읽고, 한쪽은 사용자 effort를 무시한 기본값으로 실행하거나 별도 출력 검증을 쓴다.
- **막히는 근거:** `spine:533`은 Runtime이 설정에 맞는 Core 실행 port 구현을 조립하고 두 adapter에 같은 schema 검증·정리·reap·ABI usage를 요구한다. `spine:318`, `spine:321`은 설정 키 정의와 읽기·쓰기를 Runtime 설정 코덱 하나에 모으고 Core에는 값으로 넘긴다. 따라서 adapter마다 별도 DB 키를 읽는 출발점부터 계약 위반이다. `분석에픽:61`, `분석에픽:62`, `memlog:183`의 사용자 설정 및 Source conflict 해소와 일치한다.
- **결론:** 구체적인 설정 키 철자는 후속 구현에서 코덱에 한 번 정의할 사항이다. adapter 둘이 자기 키를 정해도 된다는 공백으로 보지 않는다. 설정한 CLI가 없을 때 다른 CLI로 조용히 대체하는 공격도 `spine:533`의 재시도하지 않는 failures·doctor 경로에 막힌다. 새 AD 문장 제안 없음.

### 5. preflight ↔ 실제 반입·재개·검증

- **시도:** preflight는 옛 LATEST를 보고 실제 반입은 새 capture를 쓰며, 옛 capture에서 시작한 batch의 checkpoint를 새 capture에 그대로 적용한다.
- **막히는 근거:** `spine:543`은 실제 반입의 기준을 반입 직전 새 capture로 바꾸고 옛 LATEST는 차이 보고의 대상으로 둔다. `이전세트:91`은 새 capture 생성 → 차이 기록 → preflight → 규칙·계정 확인 → import → verify 순서를 명시한다. `이전에픽:54`는 preflight가 capture 식별·목록 fingerprint를 보고하게 하고, `이전에픽:55` 및 `이전세트:44`는 source fingerprint·버전 변경 시 checkpoint 재사용을 거부한다. `이전세트:92`는 반입 전후 새 capture 해시 동등성도 확인한다.
- **결론:** 옛 capture의 사전 점검만으로 새 capture를 반입하거나 서로 다른 입력의 checkpoint를 섞는 구현은 위 계약을 동시에 만족하지 못한다. 실제 반입에서 관찰된 값·관계가 capture와 다르면 `spine:544`, `이전에픽:59`의 전수 비교 완료 gate를 통과할 수 없다. 새 AD 문장 제안 없음.
- **경계 확인:** 옛 writer를 계속 돌리므로 모든 DB·파일이 전역 한 순간의 상태라고 단정하지 않았다. DB backup과 파일 해시 확인 후에도 capture 내부의 분석·파일 관계 불일치가 남으면 전수 비교 실패이며 완료가 아니다. capture 뒤의 추가 변경을 이번 반입의 누락으로 재분류해 writer 정지를 요구하지 않았다. 그 변경과 예약 전환은 이미 epic 16 몫이다.

### 6. epic 15 최초 시도 gate ↔ 불명 결과 retry worker

- **시도:** gate가 이미 있으므로 unknown을 영원히 막는 worker와, unknown마다 새 요청 UUID를 만들어 다시 보내는 worker를 조합한다.
- **막히는 근거:** `spine:534`는 최초 gate와 의미 키 UNIQUE를 유지하면서 **같은 요청의 새 attempt**로 unknown을 지수 간격 재시도하게 한다. `spine:788`은 10번 실패 뒤 failures·doctor 및 resend를 명시한다. `채널에픽:83`, `채널에픽:91`, `채널에픽:92`는 unknown과 확실한 실패·sent를 구분한다.
- **결론:** gate를 영구 차단으로 읽거나 새 요청으로 우회하는 양쪽 모두 계약 위반이다. 중복 발신 가능성은 사용자 수용 Decision이므로 결함으로 세지 않는다. 새 AD 문장 제안 없음.

## 근거 정합성과 남은 범위

`memlog:182`~`memlog:187`의 여섯 변경 근거가 spine의 대응 문장에 반영되어 있다. `이니셔티브:31`~`이니셔티브:33`의 보존·재개, `이니셔티브:38`의 분석과 발신 분리, `이니셔티브:51`의 metadata 비추정, `이니셔티브:190`의 C6 위임을 뒤집는 변경은 찾지 못했다. `spine:776`~`spine:792`의 Deferred 변경도 계약 결정과 후속 DDL·설치 확인의 소유를 구분한다.

이번 판정은 정적 계약 검토 결과다. 구체적인 짝 칸 DDL, 설정 키 철자, 현재 view SQL, capture 식별 전달이 실제 코드에서 이 규칙대로 구현됐다는 판정은 아니다. 그 구현을 맡은 스토리의 검증은 그대로 남는다. 검토 과정에서 원본 문서·memlog·티켓은 수정하지 않았다.
