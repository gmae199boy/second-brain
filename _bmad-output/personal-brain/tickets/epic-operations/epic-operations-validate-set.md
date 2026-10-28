수정 후 재검증 — fix 6 / suggest 2 / ask 0

# epic 5 스토리 세트 검증

2026-10-28. refined=true 에픽과 leaf가 아직 없는 entry 9개를 Ticket·Set·Dependencies 및 ticket.md의 “Rules the template cannot carry”로 정적 검토했다. 테스트·빌드·Docker·네트워크·설치·운영 DB 접근·Garmin 계정/tokenstore 열람·커밋은 하지 않았다. 보드 조회만 실행했으며 아래는 구현 통과 증거가 아니다.

아래 `약칭:행`은 표의 저장소 상대 파일과 행이다. 같은 worktree에서 다른 계획이 편집 중이므로 인용은 검토 시점의 내용이다.

| 약칭 | 파일 |
| --- | --- |
| 에픽 | `_bmad-output/personal-brain/tickets/epic-operations/epic-operations.md` |
| 세트 | `_bmad-output/personal-brain/tickets/epic-operations/tickets/tickets.toml` |
| 조사 | `_bmad-output/personal-brain/tickets/epic-operations/epic-operations-research-code.md` |
| spine | `_bmad-output/personal-brain/architecture-brain-v1-slice-1/architecture-brain-v1-slice-1.md` |
| spec | `_bmad-output/personal-brain/spec-brain-v1-slice-1/spec-brain-v1-slice-1.md` |
| 이니셔티브 | `_bmad-output/personal-brain/initiative-personal-brain.md` |
| 보드 | `_bmad-output/personal-brain/tickets/tickets.toml` |
| 결정장부 | `_bmad-output/personal-brain/decisions-by-recommendation.md` |
| PG계획 | `_bmad-output/personal-brain/tickets/epic-postgres-primary/tickets/tickets.toml` |
| 데몬계획 | `_bmad-output/personal-brain/tickets/epic-daemon/tickets/tickets.toml` |
| 확장계획 | `_bmad-output/personal-brain/tickets/epic-extensions/tickets/tickets.toml` |
| Drive계획 | `_bmad-output/personal-brain/tickets/epic-drive/tickets/tickets.toml` |
| 로그에픽 | `_bmad-output/personal-brain/tickets/epic-log-and-context/epic-log-and-context.md` |
| 조회에픽 | `_bmad-output/personal-brain/tickets/epic-recall-and-mirror/epic-recall-and-mirror.md` |

## fix

### F1 — 확정한 운영 계약을 spine의 공통 계약에도 반영한다

- 근거: `에픽:36`, `에픽:94`, `에픽:96`, `에픽:97`; `spine:128`, `spine:346`, `spine:349`, `spine:350`, `spine:644`.
- 문제: 에픽은 명령·백업 범위·새 홈 복구·JSONL import 유보를 결정했으나 spine 명령 표는 아직 `backup export/import`다. AD-20의 마이그레이션 허용 경로에는 직접 upgrade와 복구의 공통 실행기가 없고, 백업 형식은 여전히 ASSUMPTION이다. Conventions는 가린 JSONL 복구를 현재 계약처럼 서술한다. 서로 다른 에픽이 서로 다른 실행 계약을 읽게 된다.
- 바꿀 내용: 기존 Decision을 그대로 AD-20과 명령 표·Conventions·Deferred에 반영한다. `backup create|list|verify|restore`와 별도 `export`, compose 내부 client·비밀번호 없는 globals·설정/비밀 포함·로컬 Brain 블롭 한정·0700/0600·새 홈 복구를 명시한다. migration 허용 경로에 직접 upgrade와 새 홈 복구를 공통 실행기 호출로 넣는다. JSONL 복구/S5 및 D0 합치기는 후속 입력으로 남기고 현재 제공 기능과 구분한다. `uninstall --all [--delete-data]`와 백업 묶음 삭제 확인 범위도 맞춘다. 형식·명령을 다시 선택할 필요는 없다.

### F2 — 복구한 홈의 접속·경로와 자동 실행을 운영에서 분리한다

- 근거: `에픽:34`, `에픽:36`, `에픽:55`, `에픽:96`; `세트:8`, `세트:32`, `세트:103`; `조사:56`; `spine:522`, `spine:536`.
- 문제: 새 compose 자원은 명시됐지만 함께 복원하는 `.env`·`config.toml`의 운영 DB URL·파일/미러 경로를 대상 홈으로 바꾸는 계약이 없다. 전체 dump에는 예약·대기 일감·발신 요청도 있다. 복구한 확장을 다시 설치하고 doctor/명령을 실행할 때 운영 경로를 쓰거나 실제 Drive 변경·Telegram 발신 등을 재개하면, 별도 volume만으로는 9의 비파괴 확인을 보장하지 못한다. 이는 일어났다는 보고가 아니라 현재 절차가 허용하는 경로다.
- 바꿀 내용: E5-3에 대상 홈의 접속 URL·compose 자원·로컬 소유 경로를 대상 값으로 다시 바인딩하고, 운영 홈과 동일한 실경로/자원을 가리키면 쓰기 전에 거절하는 조건을 넣는다. 원문 설정 사본 보존과 복원 후 실행 설정을 구분한다. 복구 검증 중에는 운영 hook/Label 등록, 예약·일감 drain·외부 변경/발신이 자동 재개되지 않도록 하고 실제 외부 호출은 fake로 확인한다. 1·3·9의 검증에 운영 URL·절대 파일 경로·발신 대기 행을 가진 합성 fixture를 넣어 대상만 쓰이며 외부 호출이 0임을 확인한다. dump 행 보존과 실행 억제를 혼동해 대기 행을 삭제하지 않는다.

### F3 — E5-3의 전체 복구 확인을 3의 완성 범위로 배정한다

- 근거: `spec:57`; `에픽:36`, `에픽:44`; `세트:9`, `세트:32`, `세트:33`, `세트:104`; `조사:82`.
- 문제: 1은 메시지·첨부·files·locations 최소형을 확인하고 3은 role·RLS·owner 버전·확장 설치에 집중한다. 9의 “건수·해시”도 대상이 생략돼 있다. E5-3이 요구하는 작업 로그·file_metadata·추출 세대/조각·세대 포인터·brain_app 접속을 누가 독립적으로 확인하는지 명시되지 않았다. 모든 표를 dump한다는 사실만으로 복구 후 계약까지 검증되지는 않는다.
- 바꿀 내용: 에픽의 분담 설명에 1은 최소 왕복, 3은 E5-3의 나머지 전체 복구 확인, 9는 설치본 재확인이라고 적는다. 3의 description/verify에서 E5-3의 전체 대상 표와 세대/위치 포인터, brain_app 접속, 실제 원본 열기, external 및 remote_only의 검색 경고를 인용한다. 합성 작업 로그·메타데이터·서로 다른 추출 attempt/현재 포인터를 포함한 fixture로 건수·해시·관계·검색을 확인한다. 9는 그 공통 확인기를 재사용해 공개 판정만 남긴다. 새 covers id는 필요 없다.

### F4 — 논리 내보내기의 snapshot·manifest 계약을 E5-6에 옮긴다

- 근거: `spine:644`; `에픽:39`; `세트:68`, `세트:69`.
- 문제: Conventions의 테이블별 JSONL은 한 snapshot이며 manifest에 schema 버전·시각도 있다. E5-6과 6의 description에는 패턴 버전·블롭 범위만 구체화돼 있다. 현재 verify의 “건수가 DB와 같다”는 동시 수집 중 어느 시점의 DB인지 정의하지 않아, 각 표를 서로 다른 시점에 읽는 구현도 배제하지 못한다.
- 바꿀 내용: E5-6에 한 읽기 snapshot에서 모든 표와 manifest 건수를 얻는 조건 및 schema 버전·내보내기 시각을 명시한다. 6은 동시 쓰기 fixture로 snapshot 기준 건수와 관계가 맞는지 확인한다. 원문 dump와 JSONL의 writer는 별개로 유지하고 JSONL import를 되살리지 않는다.

### F5 — Done when의 SQLite·이전 산출물 표현을 현재 결과로 맞춘다

- 근거: `에픽:34`, `에픽:38`, `에픽:40`, `에픽:44`, `에픽:45`, `에픽:47`, `에픽:90`; `PG계획:104`; `조회에픽:42`, `조회에픽:43`.
- 문제: Done when 1은 여전히 “새 DB 파일”과 파생물 재생성을, 2는 마지막 “내보내기” 경고를, 4는 `brain.db`·wal·shm 삭제를 요구한다. 실제 계획은 PG dump 복구·성공한 원문 백업 기준 경고·PG volume의 확인 후 삭제다. 특히 기존 SQLite DB는 PG계획상 남겨야 한다. dump 보존과 미러/색인 재생성도 같은 결과가 아니다.
- 바꿀 내용: 1을 새 홈/PG DB·표/블롭 보존과 source_unreachable 검색으로, 2를 마지막 성공 백업 기준으로, 4를 E5-7의 PG volume 및 확인 대상/보존 대상 목록으로 맞춘다. 파생 테이블은 dump에서 보존되는 것과 epic 4의 미러/색인 재생성으로 구분하고, 이 에픽에서 추가 재생성을 요구한다면 담당 스토리를 명시한다. 삭제된 5와 epic 3으로 이동한 6의 이력은 남긴다. 이미 정한 결정을 문장에 반영하는 작업이다.

### F6 — sweep 뒤 설치본 확인을 두는 예외를 기록한다

- 근거: `에픽:99`; `세트:92`, `세트:95`, `세트:103`, `세트:106`.
- 문제: Set 규칙은 3개 초과 세트가 다른 모든 entry(마지막 end-to-end suite 제외)를 기다리는 Refactor sweep으로 닫히도록 한다. 8은 1~7만 기다리고 9는 배포·운영 설치본 확인으로, 단순 closing suite보다 넓다. 순서 자체는 합리적이나 현재 Notes에는 그 예외와 9에서 발견한 기능 수정의 처리 원칙이 없다.
- 바꿀 내용: 날짜 있는 Decision에 8은 코드 스토리 1~7의 cleanup 마감, 9는 그 뒤 배포·비파괴 확인이며 여기서 발견한 기능 문제는 버그 스토리로 처리한다고 적는다. 8에 밀린 기능을 넣지 않고 9가 성공하기 전에는 Done when 7을 충족한 것으로 세지 않는다. 기존 순서를 뒤집거나 이미 정한 hitl을 재논의할 필요는 없다.

## suggest

### S1 — tracer의 기반 작업 상한을 정제 plan에서 지킨다

- 근거: `세트:8`, `세트:9`; `에픽:99`; `조사:137`.
- 문제: 메시지 하나·블롭 하나·확장 없음이라는 상한은 적절하다. 다만 새 CLI 네 verb, PG 관리 접속, manifest, globals/설정, 두 compose 시험 기반을 처음 묶으므로 한 세션 크기라는 판단에는 여전히 위험이 있다.
- 제안: 1에서는 단일 합성 core 왕복과 최소 list/verify만 만들고, snapshot/삭제 경합은 2, 확장·owner·전체 복구 행렬은 3, 사용자 출력 다듬기와 비필수 옵션은 별도 후속으로 둔다. 사전 조건은 이미 설치된 OrbStack/PG 기반을 사용한다고 적고, 새 수동 설치 단계를 추가해야 한다면 그때 사람 단계를 명시한다. 현재 위임된 에이전트 실행과 hitl=false는 유지한다.

### S2 — 경합·장애·비밀 검증을 비작성자가 재현하도록 plan에 고정한다

- 근거: `세트:8`, `세트:21`, `세트:45`, `세트:57`, `세트:69`, `세트:81`, `세트:103`; `에픽:56`, `에픽:103`, `에픽:104`, `에픽:105`; `조사:57`.
- 문제: entry 수준의 verify 접근은 충분하고, 시험 이름/명령을 후속 plan에 적도록 이미 요구한다. 다만 “정한 한도”, 프로세스 중단 시점, pin 정리의 생존 판정, 정규형 해시는 현재 재현값이 없다. 0700/0600과 공개 출력 비밀 배제도 실제 확인이 필요하다. high-risk 1~3은 이유가 있으나 ticket.md가 요구하는 criteria 밖 추가 확인은 leaf 정제 때 구체화해야 한다.
- 제안: 정제 plan에 두 PG project/volume/port, 합성 fixture, fake launchctl·clock 주입, 실행/정리 명령과 예상값을 적는다. 2는 pin 등록과 snapshot 고정 사이, 삭제 직전, 복사 중 kill을 동기화하고 살아 있는 다른 백업의 pin을 지우지 않는 경우도 확인한다. 수집 지연 한도는 AD-6·7과 연결한 수치로 정한다. 1·3은 PK 정렬·NULL·bytea·시각의 해시 정규형을 고정한다. 비밀은 합성 fixture만 쓰고 정상/실패의 stdout·stderr·doctor·dump 도구 로그와 임시/발행 묶음 권한을 검사한다. 9의 공개 plan에는 본문·비밀·파일 이름·개별 경로를 복사하지 않고 집계/일치 여부만 남긴다. high-risk 추가 확인은 예컨대 별도 복구 실행자가 묶음만 받아 재현하는 절차로 Notes에 정한다. 아직 leaf가 없는 entry에 실행 증거나 완성 criteria를 요구하는 지적은 아니다.

## 확인한 coverage와 결과

| Requirements | 담당과 판정 |
| --- | --- |
| E5-1 | 1 기본 묶음/manifest, 3 확장 범위 완성, 9 설치본 확인. 공유 id의 부분은 구분된다 |
| E5-2 | 2 동일 snapshot·pin·중단 정리·hook 비차단. 재현 세부는 S2 |
| E5-3 | 1 최소 복구, 3 role/RLS/owner/확장 완성, 9 실 설치본 확인. 전체 표/관계 확인과 안전 조건은 F2·F3 |
| E5-4 | 4 공통 upgrade·guard·실패 재시도, 9 설치본 확인 |
| E5-5 | 5 catalog·성공 시각·redact 전 백업 경고. 새 백업만 떠도 옛 묶음 경고가 남는 verify가 적절하다 |
| E5-6 | 6 가린 JSONL·writer 등록·원문 archive 불변·블롭 바이트 보존. snapshot은 F4 |
| E5-7 | 7 최소 제거 조합·별도 데이터 확인·다른 홈 보존, 9는 격리 홈 삭제만 |

존재하지 않는 covers나 E5-1~7의 담당 누락은 없다. 8의 covers=[]는 cleanup 전용이므로 타당하다. Constraints의 원문 백업 U2·Brain 밖 전송 금지, AD-11의 가리기 전 백업 안내, AD-23의 Brain 소유 로컬 블롭/Drive 원본 구분, AD-30·31의 owner/role/RLS, AD-34의 volume 보존은 entry에 옮겨졌다. F2·F3·S2를 통해 그 관찰 경계를 강화한다. AD-6·7 비차단은 2가 맡고 DB 장애는 기존 spool을 재사용한다.

Done when 1은 1~3·9(F2·F3·F5 반영 필요), 2는 5(F5), 3은 4, 4는 7(F5), 5는 삭제 이력, 6은 epic 3 이관, 7은 9가 맡는다. CAP-11 전체 설치를 다시 구현하는 세트가 아니라 앞 에픽의 설치·점검 기반을 소비한다. CAP-12의 Brain 없이 읽는 가린 JSONL은 6이며, 그것에서 되살리는 기능은 에픽 Decision에 따라 명시적으로 backlog다. 사용자 결정 없이 누락시킨 것으로 세지 않는다.

## Dependencies와 보드

- 기본 보드 명령은 uv cache 임시 파일 권한 오류로 끝났다. `UV_CACHE_DIR=/tmp/epic5-validate-uv UV_OFFLINE=1 uv run ~/.agents/skills/bmad-agent-po/scripts/tickets.py --project-root "$(git rev-parse --show-toplevel)" status _bmad-output/personal-brain`으로 재조회해 성공했다. 네트워크나 설치는 하지 않았다. epic 5는 refined=true, next_id=10, gated_by=[epic-attachments, epic-drive, epic-postgres-primary]이고 entry 9개는 planned·file=null이다. `unpinned_after=[]`, `undeclared_after=[]`, `order_conflict=[]`이며 cycle·drift 진단은 없었다. 보드가 비어 있다는 사실만으로 의미적 선행 검사를 대체하지 않았다.
- `5.1 → 11.8`: PG 설치/관리·compose 충돌·doctor·컨테이너 중지 계약을 소비한다(`PG계획:104`). `5.1 → 8.7`은 V1 Drive의 마지막 코드 기준점을 받는 명시적 순서 결정이다(`에픽:100`, `Drive계획:80`). 8.7 자체의 cleanup 기능이 backup에 필요하다는 뜻은 아니지만, 1~6 전부를 기다리는 통합 기준점이므로 주어진 선례/결정을 유지한다. 운영 확인 8.8을 entry after로 잘못 기다리지는 않는다. V1 뒤 에픽 전체 gate는 별도 사용자 결정상 유지된다(`이니셔티브:187`).
- `5.3 → 13.9`: 확장 설치·registry·role 기반의 코드 마감점을 받는다. 13.9는 1~8을 모두 기다리는 sweep이다(`확장계획:104`, `확장계획:107`). cleanup 그 자체의 데이터 의존이라기보다 최종 통합 코드 기준점이며, 앞 에픽 마지막 코드 인계 예외(`에픽:100`)로 해석할 수 있다.
- `5.4 → 9.6`: bootstrap의 재시작 단계를 공통 갱신 함수에서 호출한다. 주는 쪽에도 epic-operations가 같은 단계를 쓴다고 적혀 있어 양쪽 인계가 있다(`데몬계획:65`). `5.7 → 9.10`은 최소 uninstall 재사용이며 주는 쪽도 전체 제거를 epic-operations로 넘긴다(`데몬계획:87`). `5.7 → 11.8`은 compose down/volume 보존 기능을 소비한다. 전이 선행과 겹치지만 소비하는 계약을 직접 가리키므로 잘못된 순서 의존은 아니다.
- 이니셔티브 epic 5 after에 13·9를 더한 것은 위 실제 소비를 선언하므로 타당하다(`보드:107`, `에픽:112`, `에픽:113`). 에픽 frontmatter의 전체 gate까지 둘을 추가해야 한다고 요구하지 않는다. 교차 entry pin이 순서를 지키고 보드 진단도 없다.
- 1~9의 순차 경로는 backup/manifest/PG port·등록부/설정/doctor·설치/bootstrap을 공유하므로 충돌 방지 근거가 있다(`에픽:100`, `조사:130`). 공통 시험 기반은 가장 먼저 필요한 1이 소유하고 2~9가 이어받는다(`세트:8`). 2가 가장 덜 확실한 snapshot/블롭 경합이라는 다음 순서도 명시돼 있다(`에픽:99`).

## 이관·실 설치본·결정 확인

- 검토 중 epic 3이 갱신돼 `로그에픽:37`에 E3-10(stats show)이 실제로 추가된 것을 확인했다. 따라서 “epic 3에 아직 미반영”은 현재 지적하지 않는다. epic 5의 이동 Decision과 일치한다(`에픽:93`, `결정장부:72`). epic 3 최종 세트에서 stats entry/SQL 대조/Done when을 확인하는 것은 epic 3 검증의 인계다. 이 보고서는 epic 3의 세트 승인까지 주장하지 않는다.
- 9는 운영 홈에서 백업 한 번·verify, 격리 홈 복구·격리 홈 삭제로 한정되고 운영 DB/volume 삭제를 금지한다(`세트:103`). 공개 증거 범위와 push를 operator_actions로 남기는 조건도 있다. 에픽의 명시적 위임 Decision(`에픽:101`)을 적용하므로 이니셔티브 위임의 V1 목록만 보고 hitl 승인을 다시 요청하지 않는다. F2의 격리 조건을 보완한 뒤 이 범위 안에서 진행한다.
- 가리기 전 백업·원문 U2·형식·블롭 범위·새 홈 복구·명령/설정·갱신 순서·스토리 순서·hitl은 재질문하지 않았다. ask는 0이다. 결정장부 72~78과 에픽 Notes의 추천 결정이 대응한다.

## 재검증 때 확인할 것

F1~F6의 문서 변경을 대조하고 같은 보드 명령을 다시 실행한다. F2의 운영 접속/외부 실행 차단과 F3·F4의 담당이 실제로 에픽/entry에 들어갔는지 확인한다. 이 정적 단계에서는 구현 시험을 실행하지 않으며, S1·S2는 후속 plan에서 추적한다.

## 재검증 (2026-10-28)

수정 후 재검증 — 기존 fix 6 해소, suggest 1 해소·1 부분 해소 / 새 fix 2(F7·F8).

같은 날 미커밋 수정과 spine AD-20을 Set·Dependencies 규칙으로 대조했다. 아래 약칭은 앞의 파일 표와 같다. leaf가 없는 entry의 설계 판정이며 구현 통과 판정은 아니다. 테스트·빌드·Docker·설치·커밋은 하지 않았고 PostgreSQL 18·Docker 공식 문서만 네트워크로 읽었다.

| 지적 | 판정 | 근거와 남은 범위 |
| --- | --- | --- |
| F1 | 해소 | `spine:128`, `spine:346`, `spine:348`, `spine:349`, `spine:350`, `spine:644`, `spine:782`에 명령·공통 migration 경로·확정 묶음·새 홈 복구·제거 확인·JSONL 복구 유보를 반영했다. `에픽:114`와 일치한다. AD-6 변경은 제외했다. |
| F2 | 해소 | `에픽:36`, `에픽:115`에 실행 설정 재바인딩, 동일 실경로/자원 쓰기 전 거부, hook·Label·예약·drain·외부 변경/발신 자동 재개 금지와 대기 행 보존이 있다. `세트:9`, `세트:32`, `세트:33`, `세트:103`에 합성 운영 URL/경로·대기 행 및 외부 호출 0 확인을 배정했다. 원문 설정은 묶음에 보존한다. |
| F3 | 해소 | `에픽:116`, `세트:32`, `세트:33`에서 3이 작업 로그·메타데이터·서로 다른 추출 attempt와 현재/위치 포인터·brain_app 접속·원본 열기·external/remote_only 검색 경고의 공통 확인기를 소유한다. `세트:103`에서 9가 재사용한다. |
| F4 | 해소 | `에픽:39`, `에픽:117`, `세트:68`, `세트:69`에 모든 표의 단일 읽기 snapshot·schema 버전·내보내기 시각·manifest 건수와 동시 쓰기 관계 검증이 들어갔다. 원문 archive와 JSONL writer도 분리한다. F7은 snapshot과 별개인 짝 칸 가리기의 새 지적이다. |
| F5 | 해소 | `에픽:44`, `에픽:45`, `에픽:47`, `에픽:118`이 새 홈 PG 복구·성공 백업 경고·PG volume 확인 삭제/옛 brain.db 보존으로 바뀌었다. 44행의 옛 문장은 명시적 이력이며 현재 요구는 앞의 교정 문장이다. 5 삭제·6 이관 이력도 남았다(`에픽:48`, `에픽:49`). |
| F6 | 해소 | `에픽:119`가 8의 코드 정리 뒤 9의 배포·비파괴 확인 예외, 9의 기능 문제는 별도 버그 스토리, 9 성공 전 Done when 7 미충족을 기록했다. `세트:92`, `세트:95`, `세트:103`, `세트:106`과 맞는다. |
| S1 | 해소 | `에픽:120`이 1의 단일 core 왕복·최소 list/verify, 경합 2·전체 복구 3, 출력 다듬기/비필수 옵션 후속, 이미 설치된 OrbStack/PG 재사용을 명시했다. `세트:8`의 메시지 하나·블롭 하나·확장 없음 상한과 맞는다. leaf plan에서 이 상한을 지키는지 확인한다. |
| S2 | 부분 해소 | `에픽:120`에 두 PG 자원·fake·명령/예상값·동기화된 kill·다른 살아 있는 백업 pin·지연 수치·PK/NULL/bytea/시각 정규형·합성 비밀과 권한 검사·high 추가 확인이 있다. `세트:103`은 공개 plan의 비밀/파일 이름 제외를 유지한다. 단, 3의 추가 확인을 복구 전체의 superuser 금지로 쓴 문장은 F8처럼 관리 복구와 RLS 검증을 구분해야 한다. 수치와 명령은 후속 leaf plan의 범위다. |

### F7 — 가린 JSONL에서 U+0000 원문 짝 칸이 비밀을 우회하지 못하게 한다

- 근거: `spine:222`, `spine:223`, `spine:644`; `에픽:39`; `세트:68`, `세트:69`. 상세는 `_bmad-output/personal-brain/architecture-brain-v1-slice-1/reviews/review-gate-2026-10-28-u6.md` R1.
- 새 모순: 전체 표를 JSONL로 내며 “텍스트 칸”만 가리면, U+0000 원문을 보존하는 bytea 짝 칸이 hex/base64로 직렬화돼 비밀의 가역 사본을 내보낼 수 있다. 문자열 패턴 가리기와 “비밀 문자열 없음” 검사만으로는 인코딩 사본을 잡지 못한다. AD-11의 논리 원문 읽기와 모든 출력 가리기를 연결해야 한다.
- 바꿀 내용: 논리 텍스트를 복원해 가린 뒤 내보내고, 저장 표현의 raw 짝 칸을 원문 그대로 직렬화하지 않는 계약을 E5-6/Conventions와 6에 적는다. U+0000과 합성 비밀이 함께 있는 fixture로 JSONL을 역직렬화·짝 칸 디코딩해도 비밀을 복원할 수 없는지 확인한다. 원문 backup과 Brain 소유 파일 바이트 보존 결정은 바꾸지 않는다.

### F8 — RLS 추가 확인과 관리 복구의 접속 권한을 구분한다

- 근거: `에픽:120`; `세트:32`, `세트:33`; `spine:349`, `spine:473`, `spine:474`; `조사:63`, `조사:76`.
- 새 모순: S2 추가 확인은 “RLS를 우회하는 superuser 연결 없이 복구가 끝나는지”다. 같은 세트는 globals의 setup·app·확장 role과 소유권/ACL을 복원한다. PostgreSQL 18은 globals SQL 실행의 관리 권한 필요성을 명시하며 전체 globals에는 superuser role도 포함될 수 있다. 복구 전체에서 그 연결을 금지하는지, 복구 후 확장 RLS 판정에서 금지하는지 두 해석이 갈린다. [PG18 pg_dumpall Description](https://www.postgresql.org/docs/18/app-pg-dumpall.html)
- 바꿀 내용: 제한된 setup 관리 경로의 role/owner/ACL 복원을 유지하고, 복구 후 검증은 실제 brain_app·non-superuser/NOBYPASSRLS 확장 자격으로 수행하며 superuser 성공으로 대신하지 않는다고 120행을 한정한다. 3의 verify는 이미 이 분리를 뒷받침한다. 기존 Decision 재선택이 아니라 새 검증 문장의 적용 범위 교정이다.

### 보드·Dependencies 재확인

`UV_CACHE_DIR=/tmp/epic5-revalidate-uv UV_OFFLINE=1 uv run ~/.agents/skills/bmad-agent-po/scripts/tickets.py --project-root "$(git rev-parse --show-toplevel)" status _bmad-output/personal-brain`이 exit 0이었다. `unpinned_after=[]`, `undeclared_after=[]`, `order_conflict=[]`; cycle·drift 진단도 없었다. epic 5는 refined=true, next_id=10, 9개 entry 모두 planned·file=null이다.

1의 `8.7`·`11.8`, 3의 `13.9`, 4의 `9.6`, 7의 `9.10`·`11.8` pin과 한 레인의 공유 setup/수정면은 유지됐다. 받는 쪽 인계만 적는 예외는 `에픽:100`, sweep 예외는 `에픽:119`에 있다. F2~F4는 해당 entry가 자체 구현·검증하므로 새 선행 누락을 만들지 않는다. E5-1~7의 담당도 유지된다. F7·F8을 고친 뒤 문서만 재검증하며 실행 증거는 이후 leaf와 9에서 확인한다.

## 재검증 2 (2026-10-28)

통과 — F7·F8 해소, S2의 남은 문장 문제 해소 / 새 지적 0.

직전 재검증의 잔여 F7·F8과 S2 부분 해소 사유를 미커밋 수정에 대조했다. 앞 절의 F1~F6·S1 해소 판정은 유지한다. 아래 약칭은 앞의 파일 표와 같다. 메인 checkout의 `validate-checks.md` Set·Dependencies와 `ticket.md`를 적용한 정적 문서 판정이며 leaf plan·복구 실행·배포 완료 판정은 아니다.

| 지적 | 판정 | 근거와 후속 확인 |
| --- | --- | --- |
| F7 | 해소 | `에픽:39`, `세트:68`, `spine:644` 모두 U+0000 짝 칸에서 논리 원문 복원→출력 가리기 후 내보내고 원문 bytea 짝 칸은 직렬화하지 않는다고 명시했다. `세트:69`는 U+0000+합성 비밀 fixture의 JSONL 역직렬화와 hex/base64 디코딩 뒤에도 비밀이 복원되지 않는 검증을 요구한다. 원문 backup과 Brain 소유 파일 바이트 보존은 그대로다. |
| F8 | 해소 | `에픽:120`이 제한된 setup 관리 경로의 globals·owner·ACL 복원과 복구 뒤 실제 brain_app/non-superuser·NOBYPASSRLS 확장 role의 RLS·권한 판정을 분리했다. superuser 연결 성공으로 후자를 대신하지 못한다. `세트:32`, `세트:33`의 owner·ACL 복원과 실제 확장 자격 검증을 동시에 만족하며 복구 전체의 관리 연결을 금지하는 해석이 사라졌다. |
| S2 | 해소 | `에픽:120`의 두 PG 자원·fake·명령/예상값·동기화 kill·다른 생존 백업 pin·수집 지연 수치·해시 정규형·합성 비밀/권한 검사·high 추가 확인 의무는 유지되고, 부분 해소의 유일한 잔여 사유인 3의 권한 문장은 F8처럼 한정됐다. 수치·명령·동기화 절차의 실제 고정은 후속 leaf plan 책임이다. 아직 file=null인 entry에 실행 증거나 완성 criteria를 요구하지 않는다. |
| spine u6 R1 | 해소 | `_bmad-output/personal-brain/architecture-brain-v1-slice-1/reviews/review-gate-2026-10-28-u6.md:14`의 교정을 `spine:644`, `에픽:39`, `세트:68`, `세트:69`가 함께 반영했다. F7과 같은 사안이므로 새 지적으로 중복 계산하지 않는다. |

보드는 `UV_CACHE_DIR=/tmp/epic35-revalidate-uv UV_OFFLINE=1 uv run ~/.agents/skills/bmad-agent-po/scripts/tickets.py --project-root "$(git rev-parse --show-toplevel)" status _bmad-output/personal-brain`으로 조회해 exit 0이었다. `unpinned_after=[]`, `undeclared_after=[]`, `order_conflict=[]`이고 cycle·drift 진단은 없었다. epic 5는 refined=true·next_id=10이다. 이번 보완은 기존 6의 내보내기와 3의 검증 계약 안에 들어가므로 새 setup 소유자나 교차 선행을 만들지 않는다(`세트:35`, `세트:71`).

테스트·빌드·Docker·네트워크·설치·커밋은 하지 않았고 기존 리뷰에 기록된 사실만 대조했다. 새 모순은 발견하지 않았다. 실제 비밀 비복원·권한 분리와 S2 절차의 실행 증거는 1~3·6 및 설치본 확인 9에서 확보해야 한다.
