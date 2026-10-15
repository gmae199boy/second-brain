---
type: review
lens: rubric (good spine)
target: ../architecture-brain-v1-slice-1.md
basis: ../../change-surface-plugin-daemon/change-surface-plugin-daemon.md §3·§4.2 (승인 2026-10-15)
reviewed: '2026-10-15'
delta: 'AD-2·5·15·17·19·20·24·25 수정, AD-26·27·28 신설, Table Contract 3행, Conventions 4행, Structural Seed plugin/, Deferred 4행'
brownfield_read:
  - apps/cli/src/dispatch.ts
  - apps/cli/src/envelope.ts
  - apps/cli/src/doctor/checks.ts
  - apps/cli/src/install/shim.ts
  - apps/cli/src/install/flow.ts
  - apps/cli/src/connectors/index.ts
  - apps/cli/src/runtime/id-gen.ts
  - packages/core/src/admin/doctor.ts
  - packages/core/src/warnings.ts
  - packages/sqlite/migrations/0002_files_and_work.sql
  - tooling/bootstrap/src/bootstrap.ts
---

# 루브릭 검토 — Personal Brain V1 slice 1 spine (2026-10-15 update)

## 판정

**조건부 통과 (CHANGES REQUESTED).** 델타의 골격 — 설치 본문 하나·진입점 둘, hook 출처 하나, 데몬은 선택 런타임이고 없을 때가 기준, MCP는 명령 메타의 생성물 — 은 올바르고 대부분 집행 가능하지만, **설치·버전 정체성 3종(`app-ref` 기록 파일, "앱 빌드 버전", 설치 완료 표식)과 확인 게이트의 소유·`retry.args`의 모양이 고정되지 않아** epic 2(플러그인 뼈대·CLI 규약 보강)와 epic 9(MCP·소켓)가 서로 다른 것을 만들 수 있다. 아래 High 9건을 문장 수준으로 메우면 통과다. Critical(설계를 되돌려야 하는 것)은 없다.

## 체크리스트 판정

| # | 항목 | 판정 | 근거 |
| --- | --- | --- | --- |
| 1 | 한 단계 아래 단위가 갈라질 지점을 다 고정했는가 | **fail** | 플러그인↔설치기 hook 소유(pass), bootstrap 잠금(pass), launchd↔데몬 주기 실행(부분), 소켓↔CLI 엔벨로프(pass), **MCP 세션 인자(fail, H-6)**, locator JSON(부분, H-8·M-6), **attempt·failed_stage(fail, H-9)**, meta/error 필드(부분, **H-1**), **종료 코드 3과 hook exit 0(fail, H-1·M-2)**, guide/스킬 parity(pass). **완료 표식·기록 ref·빌드 버전(fail, H-2·H-3·H-4)** |
| 2 | 모든 Rule이 집행 가능하고 자기 Prevents를 막는가 | **fail** | AD-26의 "소켓 표면이 CLI와 다른 입출력을 갖는 것"은 엔벨로프 동일 + AD-5 verb 제한으로 막힌다(pass). 그러나 AD-26·27의 "**빌드 버전**"은 정의가 없어 handshake 테스트를 쓸 수 없고(H-2), AD-27의 "같은 spool 형식"은 AD-9의 단명 프로세스 가정과 충돌해 자기 Prevents("DB에 쓸 수 없는 동안 로그 유실")를 되살린다(H-5). AD-28은 세션 토큰 공급 경로가 없어 `SESSION_REQUIRED`가 항상 켜질 수 있다(H-6) |
| 3 | Deferred에 둔 것 중 두 단위를 갈라지게 할 것이 있는가 | **pass(경고)** | 소켓 프레이밍·watcher 지연·PATH 실측·`--ignore-scripts`는 모두 한 에픽(9 또는 2) 안에서 결정되고 그 에픽의 첫 검증 항목이라 가름이 없다. `failures.fingerprint`는 UNIQUE 키의 일부이지만 "실패 기록 함수 하나"가 소유하고 epic 2 인셉션이 제일 앞이라 허용. 다만 Deferred 행에 "epic 2 인셉션 전에는 `failures`에 쓰는 코드를 만들지 않는다" 한 줄을 권한다 |
| 4 | 이름 붙은 기술이 현재 버전으로 검증됐는가 | **pass(경고)** | 명백한 모순 1: Node 하한 근거가 `crypto.randomUUIDv7`인데 Stack과 코드는 `uuid` 패키지를 쓴다(L-1). 버전 핀 드리프트 1: Stack `uuid 14.0.3` ↔ `apps/cli/package.json` `14.0.2`(L-1). 나머지는 web 검토자 소관 |
| 5 | brownfield와 모순되지 않는가 | **fail** | "바꾸기로 한 것"은 대부분 올바르게 표시됐다(`ExitCode`에 3, `DoctorCheckStatus`에 `warn`, bootstrap의 major-only → 24.16, `git pull --ff-only` → `--ref`, 0003의 새 컬럼 — change §2.3에 전부 있다). **모르고 모순된 것 3건**: 설치 완료 표식이 shim이라는 규칙이 `install/flow.ts`의 실제 순서(shim은 6단계 중 4번째)와 어긋남(H-4), `writeShim`이 원자적이지 않음(H-4), `document_chunks.page`가 0002에 이미 있는데 `locator.page`와의 권위 관계 미정(H-8). 추가로 `hookSafe`가 brownfield `CommandSpecBase.hook`과 두 이름이 됨(M-2) |
| 6 | spec CAP-1~14를 여전히 덮는가 | **pass(경고)** | CAP-1~9·12~14는 영향 없음. CAP-10·11은 change §4.4가 갱신 예정이나 **§4.4의 문구가 둘 다 부족하다**: CAP-10은 "AD-5 표의 명령이 모두 있고 각각 `--json`과 사람용 출력"이 epic 9 행(`mcp serve`·`daemon run`)까지 요구하게 되고(M-3), CAP-11의 새 문구 "플러그인 설치 뒤 첫 세션으로 수집이 시작된다"는 AD-19의 비동기 설치와 어긋난다(H-7). 둘은 "예정"으로 넘기지 말고 §4.4 문구를 고쳐야 한다 |
| 7 | 운영·환경 봉투가 결정·보류·열린 질문 중 하나로 다 덮였는가 | **fail** | 설치·업그레이드·제거·주기 실행은 덮였다. **통째로 침묵한 차원 4개**: 데몬 로그 보존·회전(M-7), 소켓 파일 잔존 처리(M-7), 제거 시 데몬 LaunchAgent·소켓·로그(H-10), 플러그인 두 벌 설치 경로 충돌(M-8). 플러그인 버전과 app-ref 불일치 시 doctor 외 동작은 부분(H-3) |

---

## Critical

없음.

## High

### H-1 — 확인 게이트의 소유와 `retry.args`의 모양이 둘 다 열려 있다 (AD-5, AD-28, Conventions 종료 코드)

Conventions: "`error`는 `{ code, message, exit_code, retryable?, hint?, retry?{ns, verb, args} }`" 와 "3 확인 필요(…`error.retry`에 **`--yes`를 더한** 재시도)". AD-5: "CLI가 **`retry_argv`**·종료 코드로". AD-28: "확인이 필요한 명령은 MCP에서도 같은 코드(`CONFIRMATION_REQUIRED`)로 멈춘다".

세 문장이 서로 다른 것을 말한다. (a) `retry.args`가 SDK 입력 객체이면 `--yes`를 "더할" 수 없다(`--yes`는 CLI flag다). (b) `retry_argv`는 Conventions의 엔벨로프 필드 목록에 없다 — AD-5만 아는 필드다. (c) MCP·소켓도 같은 코드로 멈춰야 하므로 게이트는 SDK에 있어야 하는데, 동의의 표현(`--yes`)은 CLI에만 있다. epic 2(CLI 규약 보강)와 epic 9(MCP·소켓)가 각자 게이트를 만들면 MCP는 영원히 통과하지 못하거나 영원히 통과한다.

**제안 수정(AD-5 Rule에 한 줄, Conventions 두 행 정정):** "확인 게이트는 SDK가 소유한다. 파괴적 verb는 입력에 `confirm: true`가 없고 호출자가 비대화형이면 `CONFIRMATION_REQUIRED`를 값으로 돌려준다. `retry.args`는 **SDK 입력 객체**이고(`{confirm: true}`를 더한 것), CLI만 그것을 `retry_argv`(사람이 복사할 수 있는 argv 문자열)로 **추가** 변환해 `error.retry_argv`에 담는다. MCP·소켓은 `retry.args`를 그대로 도구 호출로 바꾼다."

### H-2 — "앱 빌드 버전"이 세 AD에서 쓰이는데 한 번도 정의되지 않았다 (AD-19, AD-26, AD-27)

AD-19 doctor: "플러그인 버전과 **앱 빌드 버전**의 일치를 검사한다". AD-26: "연결의 첫 메시지는 **빌드 버전** handshake다. 클라이언트 빌드와 데몬 빌드가 다르면". AD-27: "doctor는 데몬 생존·소켓 응답·**버전 일치**·마지막 heartbeat를 보이고".

커밋 ref인가, `package.json` 버전인가, 플러그인 `plugin.json`의 version인가, 셋의 관계는 무엇인가가 없다. handshake 테스트("옛 빌드의 데몬이 새 빌드의 요청을 조용히 처리하는 것")를 쓸 수 없고, doctor 검사와 소켓 handshake가 서로 다른 값을 비교할 수 있다.

**제안 수정(AD-19에 한 줄, AD-26·27이 이를 참조):** "**빌드 신원은 하나다**: 빌드 시 기록되는 `{commit, schema_version}`이고 `brain admin schema`·소켓 handshake·doctor가 같은 값을 읽는다. 플러그인 `app-ref`는 그 `commit`을 가리키는 값이며, `~/.second_brain/installed.json`(설치가 끝난 뒤 쓰는 표식)이 현재 설치된 `{commit, schema_version, installed_at}`을 담는다."

### H-3 — 플러그인 ref가 설치된 빌드보다 **뒤처질 때** 매 세션 ff 실패가 반복된다 (AD-19, AD-20)

AD-19: "플러그인의 `app-ref`가 `~/.second_brain`에 기록된 ref와 **다를 때만** `bootstrap.js --yes --ref <commit>`를 돌린다" + "플러그인에 적힌 **ref로만 fast-forward**하고". AD-20: "`setup upgrade`는 코드 갱신 → 빌드 → … 플러그인 hook의 `app-ref` 갱신은 같은 함수를 쓴다(AD-19)".

`setup upgrade`(또는 `npx` 경로)로 앱이 플러그인보다 앞서가면 "다르다"가 성립하고, 뒤로 가는 fast-forward는 불가능하므로 bootstrap은 매 세션 실패한다. brownfield `prepareApp`도 비-ff에서 exit 1을 돌려준다(`tooling/bootstrap/src/bootstrap.ts`). 또 "플러그인 hook의 `app-ref` 갱신은 같은 함수를 쓴다"는 문장은 성립하지 않는다 — `app-ref`는 플러그인 버전과 함께 배포되는 **읽기 전용 파일**이고 `setup upgrade`가 바꿀 수 있는 것은 설치 기록 쪽뿐이다.

**제안 수정(AD-19·AD-20):** "비교는 '다름'이 아니라 '**앞섬**'이다. 기록된 commit이 플러그인 `app-ref`의 조상일 때만 bootstrap을 돌린다. 기록이 `app-ref`보다 앞서 있으면(수동 `setup upgrade` 등) 아무것도 하지 않고 doctor가 `warn`으로 '플러그인이 앱보다 오래됨, `/plugin update`'를 보인다. `setup upgrade`는 `app-ref`를 바꾸지 않고 `installed.json`만 갱신한다."

### H-4 — "설치 완료 표식은 shim"이 실제 설치 순서·원자성과 어긋난다 (AD-19 ↔ `apps/cli/src/install/flow.ts`, `install/shim.ts`)

AD-19: "**설치 완료 표식은 shim 파일이고 마지막에 원자적으로 쓴다.**"

brownfield 순서는 설정 → DB·마이그레이션 → 파일 저장소 루트 → **shim** → Harness 연결 → doctor(`flow.ts`: "The shim before the harnesses, because connecting one means registering this exact path with it", "Doctor has the last word")다. shim은 마지막이 아니고, `writeShim`은 `writeFile` 직접 쓰기로 임시 파일·rename이 없다(`install/shim.ts`). 결과: 마이그레이션 뒤·연결 전에 깨진 설치도 "완료"로 굳고, 플러그인 hook은 다시 설치를 시도하지 않는다 — AD-19가 막겠다고 적은 "설정을 건너뛴 반쪽 설치"가 그대로 남는다. change §2.3에도 이 재배치는 없으므로 "모르고 모순된 것"이다.

**제안 수정(AD-19):** "설치 완료 표식은 shim이 아니라 **설치 마지막 단계가 원자적으로(임시 파일 → rename) 쓰는 `installed.json`**이다(H-2). shim은 hook이 부르는 경로일 뿐 완료를 뜻하지 않는다. 플러그인 hook의 검사는 `installed.json`의 부재 또는 commit 뒤처짐이다. doctor는 `installed.json` 없이 shim만 있는 상태를 `fail`로 보인다."

### H-5 — 상주 데몬에 AD-9의 spool 규약(프로세스별 새 파일, 다 쓴 뒤 rename)을 그대로 적용할 수 없다 (AD-27 ↔ AD-9)

AD-9: "spool은 … **프로세스별 새 파일**(JSON Lines…). 쓰는 동안은 `*.jsonl.open` 이름이고, **다 쓴 뒤 `*.jsonl`로 rename해야 drain이 집는다.**" AD-27: "DB에 쓸 수 없으면 **같은 spool 형식**을 쓴다(AD-9)."

단명 프로세스 가정이 들어간 규약이다. 데몬은 몇 주를 산다 → 파일이 영원히 `.jsonl.open`으로 남고 drain(데몬 자신의 루프 포함)이 집지 못하며, AD-9이 막겠다고 적은 "DB에 쓸 수 없는 동안 작업 로그 유실"이 그대로 재현된다. 파일도 무한히 커진다.

**제안 수정(AD-9 또는 AD-27):** "상주 런타임은 spool 구간(segment)을 쓴다: 한 파일은 쓰기 시작 후 N초(기본 10초) 또는 M줄(기본 1,000줄)·S바이트(기본 8MB)에서 닫고 `*.jsonl`로 rename한 뒤 새 `.open`을 연다. 데몬은 자기 `.open` 파일을 claim하지 않는다."

### H-6 — MCP 쓰기 도구의 `session` 인자를 줄 경로가 AD-17 구성에 없다 (AD-28 ↔ AD-17, AD-4)

AD-28: "쓰기 verb는 `session` 인자(`harness:harness_session_id`)가 **필수**이고 없으면 오류 `SESSION_REQUIRED`다. … **세션 토큰은 시작 맥락이 준다(AD-4).**" 그런데 AD-17: "구성과 순서는 고정 머리말(오늘 날짜·시간대 포함), 켜진 규칙(어디서나 + 현재 프로젝트), 최근 작업 로그, 사용 안내 요약이다." — **세션 토큰 줄이 없다.** AD-4의 표는 세션 토큰을 시작 맥락 문장에 넣는 것을 "hook 없는 Harness"의 대체 경로로만 둔다(hook 있는 Claude Code는 환경 변수 `BRAIN_SESSION`).

MCP 서버 프로세스는 Harness가 `.mcp.json`으로 띄우고 SessionStart hook의 환경 변수 주입을 받지 못하는 것이 보통이다. epic 3(시작 맥락)과 epic 9(MCP)가 서로 상대가 할 것이라 가정하면 모든 MCP 쓰기가 `SESSION_REQUIRED`로 끝난다.

**제안 수정(AD-17 구성에 한 줄 + AD-28):** AD-17 — "구성과 순서는 고정 머리말(오늘 날짜·시간대 **및 이 세션의 토큰 `harness:id` 한 줄** 포함), …". AD-28 — "에이전트는 그 줄의 토큰을 쓰기 도구의 `session`으로 넘긴다. `mcp serve`는 환경 변수를 신뢰하지 않는다(서버 프로세스가 hook보다 먼저 떠 있을 수 있다)."

### H-7 — 첫 세션의 수집·시작 맥락 공백이 어디에도 적혀 있지 않다 (AD-19, spec CAP-11 예정 문구)

AD-19: "플러그인(`plugin/`)의 SessionStart **비동기** hook이 shim이 없거나 … bootstrap을 돌린다." 그런데 같은 세션의 **동기** SessionStart(`context show`)와 Stop(`sessions ingest`)도 shim을 부른다 — 첫 세션에는 shim이 없다. 결과: 첫 세션은 시작 맥락이 없고 라이브 수집도 없다(나중에 drain의 transcript 폴더 스캔이 줍는다, AD-4). 이것은 받아들일 결과지만 **적혀 있지 않고**, change §4.4의 예정 문구 "Claude Code 플러그인 설치 뒤 **첫 세션으로 수집이 시작된다**"와 epic 2 Done-when 6 "플러그인을 켜고 세션을 열면 hook 하나로 수집되고"는 그 반대를 테스트하게 만든다.

**제안 수정(AD-19 + change §4.4 문구):** AD-19 — "**첫 세션은 설치가 비동기로 도는 동안 지나간다**: 시작 맥락이 없고 라이브 수집도 없다. 그 세션은 다음 drain의 transcript 폴더 스캔이 수집하며(AD-4), 라이브 수집은 둘째 세션부터다. doctor와 플러그인 설명에 이 한 번의 공백을 적는다." CAP-11 — "…플러그인 설치 뒤 **둘째 세션부터 라이브 수집되고 첫 세션은 폴더 스캔으로 뒤늦게 들어온다**".

### H-8 — `document_chunks.page`와 `locator.page`의 권위가 정해지지 않았다 (AD-24, Table Contract ↔ `0002_files_and_work.sql`)

AD-24: "조각마다 `locator`(JSON; 종류별 필드: pdf 쪽·영역 `page`·`bbox` / …)를 둔다." 0002는 이미 `document_chunks.page integer`를 갖고 있고("`page` is where the piece came from when the format has such a thing"), D4 결정은 "`page`는 유지"다. 즉 같은 사실이 컬럼 하나와 JSON 필드 하나에 동시에 있는데 **누가 권위이고 둘이 어긋나면 어떻게 되는지**가 없다. AD-15의 결과 계약은 `locator`만 돌려준다. epic 2(0003 마이그레이션)와 epic 4(조회)·epic 8(Drive 문서)이 서로 다른 쪽을 읽고 쓸 수 있다.

**제안 수정(AD-24 + Table Contract `document_chunks` 행):** "**권위는 `locator`이고 `page`는 그 사본이다**(정렬·인덱스 전용, 같은 트랜잭션에서 `locator.page`로부터 채운다; 쪽이 없는 형식은 null). 계약 테스트에 '`page`는 항상 `locator.page`와 같다'를 넣는다. 읽는 쪽은 `locator`만 본다."

### H-9 — `attempt`의 배정자와 UNIQUE가 없다 (AD-24, Table Contract `document_extractions`)

AD-24: "파일당 **단조 증가하는 `attempt`**" + "포인터 전환은 현재 세대보다 `attempt`가 큰 세대만 할 수 있다". Table Contract: "`id`. 파일당 `attempt` 단조 증가, 같은 `extractor_version`의 진행 중 세대는 하나".

멱등 키 칸에 적혔지만 UNIQUE가 아니고, **누가 어떻게 배정하는지가 없다.** AD-8은 같은 문제를 `messages.seq`에 대해 "원본 Store가 삽입 트랜잭션 안에서 배정한다"로 못 박았는데 `attempt`에는 그 문장이 없다. 0002의 기존 보호는 `(file_id, extractor_version) where finished_at is null` 하나뿐이어서, 다른 `extractor_version`의 두 시도가 같은 `attempt`를 집어 포인터 전환 규칙("더 큰 attempt만")을 무력화할 수 있다. 또 `unsupported`·`too_large`·`redacted`에서도 `attempt`가 오르는지가 없다.

**제안 수정(AD-24 + Table Contract):** "`attempt`는 **Store가 삽입 트랜잭션 안에서 `max(attempt)+1`로 배정한다**(AD-8의 `seq`와 같은 규칙). `(file_id, attempt)`는 UNIQUE다. 상태와 무관하게 모든 시도가 번호를 받는다."

### H-10 — 제거 시 데몬 자산(LaunchAgent·소켓·로그)의 처리가 없고, 데몬↔launchd 전환의 소유자도 없다 (AD-20, AD-25, AD-27)

AD-20: "`setup uninstall`은 Brain 표식이 붙은 hook과 shim을 지운다." AD-25: 주기 LaunchAgent는 "`setup uninstall`이 지운다" + "데몬을 켜면 … 주기 LaunchAgent는 등록하지 않는다(**있으면 지운다**)". AD-27: LaunchAgent KeepAlive·소켓·`<home>/log/`를 만들지만 **제거는 말하지 않는다.**

빠진 것 둘. (a) 제거: 데몬 LaunchAgent(두 번째 Label), `<home>/run/brain.sock`, `<home>/log/`를 누가 지우는지 없다 → "흔적이 남는 제거"(AD-20 Prevents)가 그대로 생긴다. (b) 전환 소유자: 켤 때 주기 LaunchAgent를 지우는 주체(`setup run --daemon`? `daemon run`?)와 **끌 때 다시 등록하는 주체**가 없다. `daemon stop` 뒤에는 주기 실행이 아무도 없는 상태가 되고, doctor의 "간격 3배" 경고로만 드러난다(AD-25).

**제안 수정(AD-25·AD-27·AD-20):** "주기 실행의 **소유자는 `setup run`(과 `setup upgrade`) 하나다**: 설정의 `[daemon] enabled`를 읽어 켜짐이면 데몬 Label만, 꺼짐이면 drain Label만 등록하고 반대쪽을 지운다. `daemon run`·`daemon stop`은 LaunchAgent를 건드리지 않는다. `setup uninstall`은 두 Label, 소켓 파일, `<home>/log/`를 함께 지운다."

---

## Medium

### M-1 — 소켓·MCP·`meta.next`·`error.retry`의 `args`가 "SDK 입력 객체"라고 어디에도 적혀 있지 않다 (AD-26, AD-28, Conventions)

AD-26: "요청은 `{ns, verb, args, session?}`". Conventions: "`retry?{ns, verb, args}`", "`next?{ns, verb, args}`". brownfield 디스패처는 위치 인자(`args: readonly string[]`)와 flag(`options: Record<string, unknown>`)를 나눠 들고 다닌다(`dispatch.ts`) — 같은 이름 `args`가 두 뜻을 갖는다.
**제안 수정(Conventions 이름 행):** "`{ns, verb, args}`의 `args`는 **SDK 입력 객체**(`Record<string, unknown>`)다. CLI의 위치 인자·flag는 그 객체로 정규화한 뒤 SDK에 넘기고, 되돌릴 때만 argv로 바꾼다(H-1)."

### M-2 — `hookSafe`(새 메타)와 brownfield `CommandSpecBase.hook`이 같은 뜻의 두 이름이다 (Conventions 명령 메타, AD-5 ↔ `dispatch.ts`)

Conventions: "모든 CommandSpec은 … `hookSafe`, `dryRun`을 선언한다." brownfield에는 이미 `hook?: boolean`("This command runs on a hook path … the exit code is 0")이 있고 디스패처가 그것으로 exit 0을 강제한다. 둘의 관계(= 같은 것인가, "hook에 등록됨" vs "hook에서 안전함"인가)와 **게이트**("`hookSafe: false`인 명령을 hook 경로에서 부르면 어떻게 되는가")가 없다. 종료 코드 3과 hook exit 0의 충돌도 여기서 난다: 파괴적 명령이 hook에 걸리면 exit 3이 0으로 삼켜진다.
**제안 수정(Conventions hook 응답 행):** "`hookSafe`는 '이 명령을 hook 경로에서 불러도 되는가'이고 brownfield의 `hook`은 '이 호출이 hook 경로다'다. 디스패처는 `hook` 경로에서 `hookSafe: false`인 명령을 `USAGE`로 거부하고, `risk: destructive`는 `hookSafe: false`여야 한다(테스트로 고정). 그래서 exit 3은 hook 경로에 나타날 수 없다."

### M-3 — spec CAP-10의 "AD-5 표의 명령이 모두 있고"가 epic 9 행까지 요구한다 (AD-5 ↔ spec CAP-10; change §4.4 미반영)

spec: "spine AD-5 표의 명령이 모두 있고, 각각 `--json`과 사람용 출력을 낸다." AD-5 표에 `mcp serve`·`daemon run`·`daemon status`·`daemon stop`이 들어왔다(epic 9 표시가 표 본문 괄호에만 있다). change §4.4는 CAP-10에 schema·exit 3 문장만 더하고 범위를 좁히지 않는다 → slice 1 수락 검사가 epic 9를 요구한다.
**제안 수정(change §4.4에 추가):** CAP-10 — "spine AD-5 표의 **slice 1 명령**(epic 9 표시가 붙은 `mcp`·`daemon` 제외)이 모두 있고…".

### M-4 — `mcp serve`·`daemon run`은 엔벨로프를 낼 수 없는데 AD-5의 출력 규칙에 예외가 없다 (AD-5)

AD-5: "출력은 `--json`(에이전트용)과 텍스트(사람용) 두 가지다" + "모든 명령은 메타(… `output`, `risk`, `hookSafe`, `dryRun`)를 선언하고". 상주·스트림 명령은 둘 다 아니다.
**제안 수정(AD-5):** "`output`에 `envelope | stream` 두 값을 둔다. `stream`인 명령(`mcp serve`, `daemon run`)은 엔벨로프를 내지 않고 `risk: read`·`hookSafe: false`·`dryRun: false`이며, `admin schema`에 그렇게 나온다."

### M-5 — 오류 코드 목록의 소유가 없다 (Conventions `--json` 응답 ↔ `packages/core/src/warnings.ts`, `envelope.ts`)

Conventions는 경고 코드 13개를 열거하고 "오류 코드에 `SEARCH_FAILED`, `CONFIRMATION_REQUIRED`, `SESSION_REQUIRED`, `VERSION_MISMATCH`가 있다"고 덧붙인다. brownfield는 경고만 닫힌 union(`WARNING_CODES`)이고 `EnvelopeError.code`는 `string`이다. 이번 델타가 오류 코드를 네 개 더했으므로, 소유가 없으면 epic 2·9가 각자 문자열을 짓는다(AD-26의 `VERSION_MISMATCH`와 doctor의 코드가 특히 겹친다).
**제안 수정(Conventions):** "오류 코드도 Core의 닫힌 목록(`ERROR_CODES`)이다. `error.code`는 그 union이고, `admin exit-codes`가 코드마다 `{code, exit_code, meaning, agent_action}`을 낸다."

### M-6 — `locator`가 서로 다른 두 뜻으로 쓰이고, `locator.type`의 허용값이 열거되지 않았다 (AD-23, AD-24, AD-15)

AD-23: "위치는 저장소 종류, **locator**, 소유" — 내용 주소 경로(`<h0-2>/<h2-4>/<hex>…`), 0002에서 `file_locations.locator text`. AD-24·AD-15: 문서 조각 안의 위치 JSON. 같은 스키마·같은 AD 묶음에서 한 이름이 두 뜻이다. 또 AD-15는 `{type, page, …}`로 `type`을 넣고 AD-24의 목록에는 `type`이 없으며, 허용값(`pdf | docx | text | time | sheet`)이 어디에도 없다.
**제안 수정:** "`document_chunks`의 것은 `span`(또는 `position`)으로 이름을 바꾸고, `locator`는 저장 위치에만 쓴다. `span.type`의 값은 `pdf | docx | text | time | sheet` 다섯이고 종류마다 필수 필드를 정한다(테스트로 고정)."

### M-7 — 데몬 로그 보존·회전과 소켓 파일 잔존이 통째로 침묵한다 (AD-27, AD-26, AD-25)

AD-27: "로그는 `<home>/log/`". 보존 기간, 회전, 크기 상한, doctor 표시가 없다 — 개인 기계에서 몇 주 사는 프로세스의 로그다. AD-26: "소켓은 `<home>/run/brain.sock`(0600…)". 데몬이 비정상 종료해 남은 소켓 파일을 누가 지우는지(bind 시 `EADDRINUSE`), 살아 있는 데몬의 소켓인지 유령인지 어떻게 구분하는지가 없다. 또 AD-25의 LaunchAgent plist에 `StandardOutPath`·`StandardErrorPath`가 없어 주기 drain의 stderr가 어디로 가는지 모른다.
**제안 수정(AD-26·AD-27):** "데몬은 시작할 때 단일 인스턴스 잠금을 먼저 잡고, 잠금을 얻었으면 남아 있는 소켓 파일을 지우고 bind한다(잠금 없이 소켓만 보고 판단하지 않는다). 로그는 하루 단위 파일에 쓰고 N일(기본 14일)·M바이트(기본 64MB)를 넘는 것은 drain의 일감이 지운다. doctor는 로그 폴더 크기와 가장 오래된 파일을 보인다. LaunchAgent plist는 두 Label 모두 `<home>/log/`로 stdout·stderr를 돌린다."

### M-8 — 플러그인이 두 벌 설치된 경우를 다루지 않는다 (AD-19)

AD-19: "**hook의 출처는 Harness마다 하나다.** Claude Code에서는 플러그인 `hooks/hooks.json`이다." 막은 것은 "설치기 hook + 플러그인 hook"의 이중 등록뿐이다. marketplace 설치와 개발용 로컬 경로 설치가 함께 있으면 플러그인이 두 벌이 되고 SessionStart가 두 번(맥락 주입 두 번, 주입 기록 두 건), bootstrap도 두 번 시도된다(잠금이 하나는 막는다). doctor의 "플러그인 버전과 앱 빌드 버전 일치" 검사는 플러그인이 하나라고 가정한다.
**제안 수정(AD-19 doctor 항목):** "doctor는 **Brain 플러그인이 둘 이상 활성인 상태를 `fail`로 보인다**(각 플러그인의 경로와 `app-ref`를 함께). 시작 맥락 주입은 세션당 한 번이어야 하므로 `context_injections`의 `(session_id)` 중복은 경고로 올린다."

### M-9 — `plugin/` 씨앗이 Claude Code가 요구하는 경로를 빠뜨렸다 (Structural Seed, AD-19 ↔ change §2.3)

Structural Seed: "`plugin/ # Claude Code 플러그인: plugin.json, hooks/, skills/, bootstrap.js 복사본, app-ref (AD-19)". change §2.3은 "`.claude-plugin/plugin.json`" 과 "루트 `.claude-plugin/marketplace.json`이 `./plugin`을 가리킨다"로 적었다. spine만 보고 만들면 `plugin/plugin.json`이 되어 플러그인으로 인식되지 않고, marketplace 항목이 없어 `/plugin install`에 쓸 출처가 없다. AD-28의 `.mcp.json`도 씨앗에 없다.
**제안 수정(Structural Seed):** "`plugin/.claude-plugin/plugin.json`, `plugin/hooks/hooks.json`, `plugin/skills/`, `plugin/bootstrap.js`, `plugin/app-ref`, `plugin/.mcp.json`(epic 9, 선택), 그리고 저장소 루트 `.claude-plugin/marketplace.json`(`./plugin`을 가리킨다)."

### M-10 — 플러그인 hook 경로에서 bootstrap의 종료 코드 계약이 없다 (AD-19 ↔ Conventions "hook 경로는 항상 0", `tooling/bootstrap`)

Conventions: "hook 경로는 항상 exit 0으로 끝낸다." AD-19는 bootstrap에 대해 "잠금이 있으면 '설치 진행 중'으로 **exit 0**"만 정하고, brownfield bootstrap은 모든 거부·실패에 1을 돌려준다(clone 아님, 로컬 변경, 비-ff, pnpm 없음, 설치기 코드 전달). bootstrap은 CLI 명령이 아니므로 디스패처의 삼킴을 받지 못한다.
**제안 수정(AD-19):** "플러그인 hook으로 불린 bootstrap(`--yes --ref`)은 **무엇이 일어나도 exit 0**이고, 실패는 한 줄 stderr와 `<home>/log/install.log`에 남아 doctor가 보인다. 비대화형 사람·CI 경로(`npx`)는 지금의 종료 코드를 유지한다."

### M-11 — shim의 node 재탐색·재고정에 원자성·동시성 규칙이 없다 (AD-19 ↔ `install/shim.ts`)

AD-19: "그 경로가 없으면 nvm 버전 폴더(…) → Homebrew → … 순으로 찾아 쓰고 **다시 고정한다**." shim은 `renderShim`이 만드는 POSIX `sh` 한 장(`exec '<node>' '<bin>' "$@"`)이고, 자기를 다시 쓰는 주체(shim 자신? `brain` 쪽?)·원자성(`writeShim`은 비원자적)·동시에 뜬 두 hook이 함께 다시 쓰는 경우가 없다. shim이 완료 표식까지 겸하면(H-4) 반쯤 쓰인 shim은 설치 미완료로 읽힌다.
**제안 수정(AD-19):** "탐색과 재고정은 shim이 아니라 **shim이 부른 `bin.js`가 한다**(shim은 실패 시 폴백 탐색을 수행하는 10줄짜리 `sh`로 두고, 찾은 node를 `brain setup run --rewrite-shim`에 넘긴다). 모든 shim 쓰기는 임시 파일 → rename이고, 완료 표식은 shim이 아니다."

### M-12 — AD-26의 "재시작 신호"가 구체가 없다 (AD-26 ↔ AD-27, epic 9 Done-when 3)

AD-26: "데몬은 `VERSION_MISMATCH`로 답하고 **재시작 신호를 남기며**". AD-27은 KeepAlive를 두고, epic 9 Done-when 3은 "데몬이 … **스스로 재시작**하고"라 적는다. 셋이 다른 그림이다.
**제안 수정(AD-26):** "데몬은 `VERSION_MISMATCH`로 답한 뒤 열린 요청을 끝내고 **스스로 종료한다**. LaunchAgent KeepAlive가 새 빌드로 다시 띄운다(AD-27). 별도의 신호 파일은 두지 않는다."

---

## Low

### L-1 — Node 하한의 근거와 실제 ID 생성이 어긋나고, `uuid` 핀이 드리프트했다 (Stack)

Stack(이번에 손댄 행): "하한은 `node:sqlite`의 `defensive` 기본값과 **`crypto.randomUUIDv7`** 때문" 인데 같은 표가 "`uuid (v7) 14.0.3"을 싣고 코드는 `apps/cli/src/runtime/id-gen.ts`에서 `import { v7 as uuidV7 } from 'uuid'`를 쓰며 `apps/cli/package.json`은 `14.0.2`다. `IdGen` 구현이 두 갈래로 갈릴 수 있다.
**제안 수정:** "하한 근거에서 `crypto.randomUUIDv7`을 빼거나(`node:sqlite`만 남기고) `uuid` 행을 빼고 `IdGen`을 내장 API 하나로 고정한다. 핀은 `14.0.2`로 맞춘다."

### L-2 — `skip{reason}`이 brownfield의 `skip` + `detail`과 다른 이름이다 (Conventions doctor 상태 ↔ `packages/core/src/admin/doctor.ts`, `apps/cli/src/doctor/checks.ts`)

Conventions: "`ok | warn | fail | skip{reason}`". 코드는 `status: 'skip'`에 이유를 `detail`로 넣는다(`{ id: 'node-path', status: 'skip', detail: 'the shim could not be read' }`). `reason`을 새 필드로 읽으면 같은 사실이 두 칸이 된다.
**제안 수정:** "`skip`의 이유는 기존 `detail`에 담는다(새 필드를 만들지 않는다)". `summary{passed, warned, failed, skipped}`는 `DoctorReport`에 더해야 하는 신규임을 그대로 둔다.

### L-3 — AD-4의 표가 `brain context`라 적어 parity 테스트에 걸린다 (AD-4 ↔ AD-5, AD-17)

AD-4 표: "시작 hook → `brain context`", "지시 파일 한 줄('세션 시작 시 `brain context` 실행')". AD-5의 verb는 `context show`다. AD-17이 새로 요구하는 parity 테스트("코드블록의 명령·flag 실존")가 안내문에 그대로 복사되면 실패한다.
**제안 수정:** 두 곳을 `brain context show`로 고친다.

### L-4 — `redactions.pattern_version`이 Table Contract에만 있고 AD-11 본문에 규칙이 없다 (AD-11 ↔ Table Contract)

Table Contract: "`redactions` | `id` | `messages.redact`, `files.redact`, 수집·추출의 저장 전 마스킹(`pattern_version` 기록)". AD-11의 Rule은 "패턴 목록은 Core에 하나만 둔다"까지만 말하고 버전 기록·그 버전이 무엇의 해시인지·올라갈 때 재마스킹을 하는지가 없다.
**제안 수정(AD-11):** "패턴 목록에는 `pattern_version`이 있고 마스킹한 모든 행이 그것을 기록한다. 목록이 바뀌면 버전이 오르고, **이미 저장된 본문은 다시 마스킹하지 않는다**(원문 불변). doctor가 가장 오래된 `pattern_version`을 보인다."

### L-5 — launchd 겹침 잠금(epic 5 완료 조건)이 어떤 AD에도 없고 AD-7과 어긋나 보인다 (AD-25 ↔ AD-7, change §4.1 epic 5)

change §4.1 epic 5: "launchd 실행 겹침 잠금과 일감 `started_at` 기준 시간 초과 회수". AD-25는 시간 예산 60초만 두고 겹침을 말하지 않으며, AD-7은 "drain은 **동시 실행을 전제**하고"라 적는다. 완료 조건을 다스리는 AD가 없다.
**제안 수정(AD-25):** "주기 실행은 겹치지 않는다: launchd가 부른 drain은 `<home>/run/drain.lock`을 비차단으로 잡고, 못 잡으면 아무 일도 하지 않고 exit 0이다(AD-7의 동시 실행 허용은 서로 다른 호출자 사이의 안전성이고, 같은 주기 실행을 두 번 돌리는 것은 낭비다)."

### L-6 — 하한 상수가 세 곳에 적히는 것을 한 곳으로 모으는 규칙이 없다 (AD-19, Stack ↔ `doctor/checks.ts` `NODE_FLOOR`, `bootstrap.ts` `MIN_NODE_MAJOR`, 루트 `package.json`)

`NODE_FLOOR = '24.16.0'`은 루트 `engines.node`와 테스트로 묶여 있지만, bootstrap은 import할 수 없어 자기 상수를 갖고(현재 `MIN_NODE_MAJOR = 24`, 24.16으로 바뀔 예정) 플러그인 `bootstrap.js` 복사본이 네 번째 철자가 된다.
**제안 수정(AD-19):** "하한의 철자는 루트 `package.json`의 `engines.node` 하나다. `NODE_FLOOR`와 bootstrap의 상수는 그것과 묶는 테스트를 갖고, 플러그인 복사본은 원본 동기화 테스트가 덮는다(이미 있는 규칙을 하한에도 적용한다)."

---

## 델타 밖에서 이번 변경으로 새로 어긋난 것

- **AD-7 ↔ AD-27**: "모든 명령은 끝에 짧은 시간 예산으로 drain을 한 번 기회적으로 돈다"가 데몬이 켜진 상태에서도 유지된다. 일감 청구로 안전하지만, 데몬이 있을 때 이 기회적 drain을 계속할 것인지(지연 비용)가 결정으로 적혀 있지 않다. 한 줄 권고: "데몬이 응답하면 기회적 drain은 생략한다".
- **AD-16 ↔ AD-27**: 미러 쓰기는 "같은 세션의 미러 일감 하나로 직렬화"되는데, 데몬의 drain 루프와 명령의 기회적 drain이 같은 일감을 다른 프로세스에서 집는 경우의 직렬화 근거는 AD-21의 청구뿐이다. 충돌은 아니지만 AD-16에 "직렬화의 근거는 `work_items` 청구다" 한 줄이 있으면 epic 4·9가 갈라지지 않는다.
- **spec Constraints·Non-goals·CAP-10·CAP-11**: change §4.3·4.4가 할 일로 표시됨(**예정**). 단, M-3·H-7은 §4.4의 문구 자체를 고쳐야 하므로 "예정"으로 넘기면 안 된다.
- **PRD FR-25·FR-28·§6.2·§8-3·§8-4**: change §4.3이 할 일(**예정**). 이번 검토 범위에서 추가 불일치 없음.
