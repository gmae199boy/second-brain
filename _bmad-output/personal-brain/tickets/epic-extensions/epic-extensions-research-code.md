# Epic 13 코드 조사 — 확장 설치와 install 스킬

조사일 2026-10-28, 브랜치 `plan/epics-12-on`, HEAD `295bdd6`. 정적 조사만 했다. 테스트·빌드·Docker·네트워크·설치·패키지 추가·Garmin 실행·커밋은 하지 않았다. 아래 시험은 소스에서 확인한 기반과 **앞으로 추가할 검증 제안**이며 통과 실측이 아니다.

인용 약칭(`약칭:행`은 다음 실제 파일의 행 번호):

- **에픽13**: `_bmad-output/personal-brain/tickets/epic-extensions/epic-extensions.md`
- **이니셔티브**: `_bmad-output/personal-brain/initiative-personal-brain.md`
- **spine**: `_bmad-output/personal-brain/architecture-brain-v1-slice-1/architecture-brain-v1-slice-1.md`
- **경계**: `_bmad-output/personal-brain/prep-garmin-absorption/integration-boundaries.md`
- **PG에픽 / PG계획**: `_bmad-output/personal-brain/tickets/epic-postgres-primary/epic-postgres-primary.md` / 같은 폴더 `tickets/tickets.toml`
- **작업에픽 / 작업계획 / 작업조사 / 작업검증**: `_bmad-output/personal-brain/tickets/epic-jobs-and-scheduler/` 아래 각각 `epic-jobs-and-scheduler.md`, `tickets/tickets.toml`, `epic-jobs-and-scheduler-research-code.md`, `epic-jobs-and-scheduler-validate-set.md`
- **Garmin/**: `_bmad-output/personal-brain/prep-garmin-absorption/inputs/garmin-source.tar.gz` 내부 `garmin-source/`. 저장소 밖 새 빈 임시 디렉터리로 풀어 읽었다. `Garmin/파일:행`은 archive 내부 파일의 행이고 새 제품 코드가 아니다(소스 기준: 경계:7, :9).

판단 기준은 Python 없는 기본 Brain(R1), 데이터 보존과 중단 상태(R16), 기본 포함 install 스킬과 실제 단계 보고(R17), TS core·Python 확장 분리(C4)다(이니셔티브:27, :42, :43, :50). 확장 위치·진행 취소/대기 보류·`ext` 이름공간·epic 12 인계는 이미 정한 사항이며 재결정하지 않는다(에픽13:56, :57, :58, :59). 아래 새 경로·DDL 이름·분할은 모두 후보다.

## 1. 플러그인과 CLI 메타

현재 추적되는 플러그인 구성은 manifest, `app-ref`, bootstrap 복사본, hooks, 두 sh 런처다. manifest는 `plugin/.claude-plugin/plugin.json:1`에 있고 버전은 `0.1.8`이다(:3). 루트 marketplace의 상대 `source`는 `./plugin`이다(`.claude-plugin/marketplace.json:9`). `plugin/skills/`는 비어 있는 디렉터리가 아니라 **현재 존재하지 않는다**(정적 디렉터리 열거). 계획은 그 자리에 빌드 생성·커밋하는 스킬을 두며 공통 install은 미설치 Garmin 사용자에게도 제공한다(spine:333, :337).

SessionStart는 비동기 `plugin/bin/session-start.sh`를 부르고 Stop·SessionEnd는 shim 경유 `sessions ingest`를 부른다(`plugin/hooks/hooks.json:3`, :8, :19, :30). bootstrap은 Node built-in만 쓰며 clone→build→설치기에 넘긴다. 원본은 `tooling/bootstrap/src/`이고 커밋된 JS와 플러그인 복사본 parity가 요구된다(`plugin/bootstrap.mjs:16`, :22; `tooling/bootstrap/test/plugin.test.ts:130`). 따라서 install 스킬에 Python/uv bootstrap을 넣기보다 CLI의 확장 설치 기능을 호출하게 하는 것이 기존 책임 분리와 맞는다(경계:36, :44; spine:458).

`<home>`은 `SECOND_BRAIN_HOME` 또는 `~/.second_brain`이고 앱 clone은 `<home>/app`이다(`apps/cli/src/config/paths.ts:9`, :12, :98; `plugin/bootstrap.mjs:65`, :87). 버전별 Claude 캐시와 별도다. 완료 기록 `installed.json.plugin_root`는 마지막 설치 출처이고, `run/plugin.json`은 마지막 SessionStart의 현재 출처를 보존하여 doctor가 우선한다(`plugin/bootstrap.mjs:41`, :46; `apps/cli/src/doctor/checks.ts:407`). 확장 환경은 `<home>/extensions/<name>/`에 남겨야 한다(spine:519). 캐시의 SKILL.md는 절차이고 영속 환경의 원본이 아니다(경계:48).

갱신은 app-ref와 installed commit 비교, auto 설정, 조상 관계, 잠금에 따라 무작업/갱신으로 갈린다. 동일 ref이면 spawn 없이 반환하고 auto=false면 설치하지 않는다(`plugin/bootstrap.mjs:244`, :247, :251; spine:327). `app-ref`는 그 변경보다 앞선 커밋이어야 하고 version도 함께 올려야 한다. 원격 캐시는 version이 키이며 로컬 상대 marketplace는 제자리에서 읽어 version 누락을 숨길 수 있다(`README.md:955`, :959, :962, :968). 최종 배포 후보는 기능 커밋→앞선 기능 커밋을 ref로 지정한 별도 배포 변경 순서다(같은 근거).

install 스킬은 먼저 `brain guide schema --json` 또는 `brain guide schema ext --json`을 읽고 envelope의 `data.commands`에서 지원 verb·인자·옵션을 확인할 수 있다. schema는 standalone이므로 미설정 DB 때문에 막히지 않고, 없는 namespace/verb는 `USAGE` exit 2다(`apps/cli/src/commands/guide-schema.ts:37`, :57, :65, :72, :83, :109, :112). 현재 등록부에는 `ext`·`config`·`schedules`가 없다(`apps/cli/src/commands/index.ts:36`). 새 명령은 이 등록부와 SDK 1:1·Core 출력 코덱에 연결해야 한다(spine:111, :113). **어긋남:** Description의 `brain install <확장>`(에픽13:20)과 경계:36의 예시는 Notes의 최신 `brain ext install|status|enable|disable <name>` 안(에픽13:58)보다 오래됐다. 구현 대상으로 옛 단일 verb를 복구하지 않는다.

## 2. 설치 흐름·멱등·실패 보고

현재 `setup run`은 standalone으로 동일 설치 flow를 호출한다. JSON 모드에는 질문/진행 줄을 내지 않고 구조화된 성공 report 또는 failure를 반환한다(`apps/cli/src/commands/setup-run.ts:6`, :31, :85, :91, :98). flow 의존성은 질문·쓰기까지 주입 가능하다(`apps/cli/src/install/flow.ts:35`). 현재 단계는 설정 읽기·경로/업데이트 질문·동의→SQLite 마이그레이션→owner→files root→config/.env→shim→harness→doctor→shim 외부 검증→데몬 등록/재시작→완료 기록이다(`apps/cli/src/install/flow.ts:393`, :485, :519, :539, :552, :555, :561, :584, :595, :635).

성공 보고는 store의 applied 목록, owner/files created, shim/harness changed, daemon restarted, checks/summary, installed를 가진다. 재실행은 현재 값 기본값과 마이그레이션 적용 목록·changed 결과로 멱등을 설명하며, 단계별 영속 journal은 없다(`apps/cli/src/install/flow.ts:64`, :72, :79, :92, :389; `apps/cli/test/install-flow.test.ts:823`). bootstrap의 별도 멱등 표식은 `<home>/install.lock/`과 `installed.json`이며, 완료 기록은 shim 외부 검증 뒤 마지막에 쓴다(spine:330, :331; `apps/cli/src/install/flow.ts:630`).

| 상태 | 현재 구분과 확장에 필요한 차이 |
| --- | --- |
| 동의 미제공 | `CONFIRMATION_REQUIRED`, retry 입력. exit 3. 설치 전 반환(`apps/cli/src/install/flow.ts:378`) |
| 명시적 취소 | `Cancelled`만 `SETUP_CANCELLED`로 변환, exit 1. 기타 예외는 다시 throw(`apps/cli/src/install.ts:124`) |
| 실제 실패 | `InstallResult` failure+warnings. 성공 report만 가지며 실패 때 이미 끝난 단계의 구조화 보고는 없음(`apps/cli/src/install/flow.ts:105`, :349) |
| 부분 설정 | 기존 설정·자원 다시 읽기로 복구. doctor fail은 `SETUP_INCOMPLETE` 경로, shim 검증 실패도 완료 기록을 쓰지 않음(`apps/cli/src/install/flow.ts:565`, :584, :630) |
| 로그인·예약 미준비 | 현재 core 설치 report에 해당 상태 없음. 설치/활성/인증/자동실행 분리 요구는 확장 계약에서 새로 충족해야 함(경계:45, :49, :50) |

**어긋남/한계:** 지금 취소는 코드로 구분되지만 실패 결과에 성공 단계 목록이 없으므로 이를 그대로 확장 설치 결과로 재사용하면 Done when 3의 “성공 단계 보존·보고”를 입증하지 못한다(에픽13:34; `apps/cli/src/install/flow.ts:105`). 확장 설치에 `step`, 실제 결과, 재개 위치를 포함하는 SDK 결과와 registry의 지속 사실을 추가하고 재조회로 보고를 확인하는 선택지가 있다. 단순 exit 0은 bootstrap의 무작업·잠금 중도 포함하므로 설치 완료 증거가 아니다(spine:331).

doctor의 단계 결과는 `checks[{id,status,detail?,code?}]`와 passed/warned/failed/skipped summary다. 상태는 `ok|warn|fail|skip`이고 skip은 이유를 설명한다. CLI는 `ok:true` 데이터 안에서도 fail 항목이 있으면 실패 종료를 표시하므로 envelope의 ok만으로 건강 판정을 하면 안 된다(`packages/core/src/doctor/doctor.ts:18`, :28, :43; `apps/cli/src/commands/doctor-run.ts:60`, :69). 현재 runtime에는 config→shim→node-path→node-version→plugin→last-hook→spool→daemon 점검이 있으며 확장 상태 source를 추가할 seam이 있다(`apps/cli/src/doctor/checks.ts:134`; `packages/core/src/doctor/doctor.ts:72`).

epic 11 완료 후 기준 흐름은 OrbStack 확인→compose→role/schema→소유자별 마이그레이션→사용자/설정→연결·데몬→doctor/완료다. `setup run`/bootstrap 모두 설치된 확장 마이그레이션을 처리할 자리가 있고, 선택 확장 최초 설치는 별도 `ext.install` SDK가 그 실행기를 호출하는 후보가 자연스럽다(spine:328, :344; PG계획:8, :104). 확장 설치를 기본 설치의 무조건 Python 단계로 추가하면 R1과 어긋난다(이니셔티브:27; spine:459).

현재 uninstall은 데몬 내리기와 plist/pid/heartbeat/회전 로그 삭제만 수행하며 `unloaded`, `plist_removed`, `removed`를 보고한다(`apps/cli/src/commands/setup-uninstall.ts:6`; `apps/cli/src/daemon/control.ts:74`). **어긋남:** spine:348의 shim·hook·완료 기록·run/log 전체와 compose down까지 구현된 것이 아니다. epic 11.8이 PG 제거와 볼륨 보존을 만든다(PG계획:104). 확장 파일·schema·데이터는 비활성화로 지우지 않으며 Brain 제거에서도 별도 확인 없이 지우면 안 된다(spine:348, :460).

## 3. 설정 코덱과 manifest snapshot

현재 `config.toml` 코덱은 timezone·로컬 세 경로·auto update를 읽고 모르는 키는 경고한다. `.env`는 현재 읽을 비밀 참조가 없어 읽지 않으며 쓰기 때 기존 변수를 보존하고 mode 0600으로 조인다(`apps/cli/src/config/codec.ts:29`, :83, :126, :190, :515, :554, :609, :710). 현재 `timezone`은 파일 값이다(:190). **어긋남:** AD-18의 DB 사용자 설정·`[store] url_env`는 아직 이 checkout 구현이 아니다(spine:316, :317).

11.6은 Core settings port·메모리 fake·계약, PG `brain.settings`, 키 정의와 `config get/set`, `<ext>.*` 자리를 만든다. setup에서 timezone을 DB로 옮기고 그 뒤 파일 값은 doctor warn이다(PG계획:80, :81). 이 기반을 받아 manifest의 선언 키를 같은 코덱에 등록해야 한다. `<ext>.` 접두사만 맞으면 임의 키/타입을 허용하는 구현은 “모르는 키 거부” 계약과 맞지 않는다(PG계획:81; spine:456).

snapshot 생성 후보 위치는 **Runtime 코덱→감독자의 실행 입력 조립 직전**이다. manifest 버전·호환 core/ABI·설정 키 타입/기본값/비밀 참조를 검사하고, DB 설정+기계 값+환경 비밀을 한 실행의 불변 값으로 만든 뒤 인증/연결 확인/일감에 동일하게 전달한다. Core에는 값과 port만 넘기고 Python이 Brain 파일이나 settings를 재탐색하지 않게 한다(spine:68, :320, :508). 정확한 snapshot 운반 필드/크기와 ABI 연결은 12 완료 schema를 읽고 정해야 하며, 비밀은 argv·로그·stdout 금지다(spine:508). 일반 status view에는 비밀 snapshot 전체를 싣지 않고 설정 충족 여부만 보여 주는 후보가 이 제약을 만족한다(같은 근거).

옛 Garmin `config.load`는 `--config`→`GARMIN_PIPELINE_CONFIG`→cwd TOML을 읽고 unknown key를 거부하며 tokenstore도 자체 관리한다(`Garmin/src/garmin_pipeline/config.py:1`, :33, :116, :181). `cli.login`도 그 loader로 들어간다(`Garmin/src/garmin_pipeline/cli.py:294`, :302). 이 탐색을 새 확장의 런타임 설정 경로로 그대로 남기는 것은 AD-33과 **어긋남**이다. default/검증 의미를 snapshot adapter로 옮기는 것은 후보이고 Garmin 인증 자체 이식은 epic 16 범위다(경계:23; 에픽13:41).

## 4. DB role·schema·마이그레이션

현재 PG 실행기는 단일 정수 버전, `public.schema_version` 조회, SQL 적용 뒤 `now()`를 쓰는 모델이다. 파일별 transaction/advisory lock은 이미 있다(`packages/postgres/src/migrate.ts:114`, :123, :180). **어긋남:** 소유자·checksum·Brain role 모델을 이미 갖춘 것으로 보면 안 된다. epic 11.1은 `brain.schema_migrations(owner, version, name, checksum, applied_at)`와 소유자별 연속 번호·checksum·잠금/트랜잭션 실행기, 마이그레이션 owner·`brain_app`·`brain` schema를 만든다(PG계획:8; PG에픽:19).

확장 최초 설치는 같은 실행기에 자기 패키지 `migrations/`와 owner를 제공하는 지점이다. core 번호와 확장 번호는 독립이며 확장 0001이 core의 다음 번호를 점유하지 않는다(spine:480, :481, :483). registry/core 공개 view DDL은 **core의 다음 번호**, fixture 확장 DDL은 **그 확장의 0001** 후보다. 11.10이 baseline checksum을 고정하고 epic 12도 새 번호를 더하므로 현재 0001을 고치는 계획은 금지다(PG계획:128; 작업에픽:52). 실제 번호는 두 선행 에픽 완료 HEAD에서 정한다.

| 권한 주체 | 확장 설치에서 이어 붙일 계약 |
| --- | --- |
| setup 마이그레이션 owner | 확장 schema/role 생성·DDL 실행. 앱 역할에 DDL owner를 섞지 않음(spine:472, :480) |
| `brain_app` | TS 런타임. registry 작성과 공개 조회 API의 DB 권한을 이 역할에 맞춤(spine:472; 에픽13:18) |
| `brain_ext_<name>` | non-superuser·NOBYPASSRLS, 계약 표 owner와 분리. 자기 schema 쓰기, core 공개 view SELECT·계약 표 INSERT만. 출처 검증은 변경 가능한 GUC가 아닌 role에 결합(spine:469, :471, :472) |

확장→core FK는 허용하고 역방향 FK는 금지다. 건강/채널/파일 계약 표의 RLS trigger·실제 GRANT는 그 표를 만드는 14·15 소유이므로 13이 미리 빈 건강 표를 만들 이유는 없다(spine:468; 에픽13:42). role 생성과 출처 결합 표현/권한 API를 먼저 고정하고 테스트용 계약 표로 금지 권한을 검증하는 후보가 있다(작업계획:32).

12.3은 `(work id, attempt token)` 현재성 확인 DB 함수와 시험 INSERT trigger를 제공하고 `brain_app`과 이후 확장 role의 EXECUTE를 정한다(작업계획:32; 작업에픽:96). 13은 **설치 시 새로 만든 role에도** 함수 호출 권한이 이어지는지 확인해야 한다. 함수가 만들어질 때 존재한 role만 GRANT하는 것으로는 부족하며, 함수 이름/schema·EXECUTE·schema USAGE와 stale token 거부를 확장 role로 직접 검증하는 후보가 필요하다(같은 근거; spine:507). extension role에 work_items 청구·갱신 권한을 주는 우회는 금지다(spine:501).

## 5. 실행 환경·잠금·Python 없는 Brain

현재 제품 빌드/시험 진입점은 pnpm→tsc/Node/Vitest이며 CLI 의존성에도 Python/uv는 없다(`package.json:12`, :16, :22; `apps/cli/package.json:12`, :15). `rg`로 apps/packages/tooling의 Python/uv 호출을 읽었을 때 개발 자동화의 티켓 조회에는 `uv run`·`python3`가 있다(`tooling/dev/auto-build.sh:59`, :70). 따라서 “저장소 어디에도 Python이 없다”는 주장은 틀리고, **제품 기본 설치·수집·doctor 경로가 요구하지 않는다**를 검증해야 한다(이니셔티브:27).

제안 시험은 Node/git/pnpm/Docker fake runner만 허용한 격리 PATH에서 Python·uv 탐색/실행을 실패시키고, 확장 미설치 registry로 setup/bootstrap→session ingest→doctor를 통과시키는 것이다. 실제 머신에 Python이 있어도 명시 경로 실행까지 spy/runner로 막아 거짓 양성을 피하고, `<home>/extensions/`와 Python env가 생성/조회되지 않았음을 확인할 수 있다. 기존 설치 flow의 주입 seam과 bootstrap fake를 활용하고 epic 11 PG fake runner 시험으로 옮긴다(`apps/cli/src/install/flow.ts:35`; `tooling/bootstrap/test/bootstrap.test.ts:272`; PG계획:105). 현재 시험 통과만으로 R1을 입증했다는 뜻은 아니다.

이 Mac에서 허용된 `command -v`만 확인했다: uv는 `~/.local/bin/uv`, python3는 `/usr/bin/python3`, python은 찾지 못했다. 버전·arm64 여부·import·DB 접속·다운로드 가능성은 확인하지 않았다. Python 3.14.8 사용 가능하다는 결론도 내리지 않는다. 이 부분은 로컬 명령 관찰이며 아래 archive의 버전 선언과 별개의 증거다.

옛 환경의 원본과 SHA-256(파일 전체를 읽어 계산):

| archive 경로 | SHA-256 | 선언 근거 |
| --- | --- | --- |
| `Garmin/pyproject.toml` | `3feb04967c411d9a1a43b9f8af15d50f2ce3912ba63a8a16fff5a7422dea55b0` | Python >=3.12, curl-cffi·garminconnect·jsonschema·matplotlib·requests, uv >=0.13.1(`Garmin/pyproject.toml:6`, :7, :29) |
| `Garmin/uv.lock` | `f6086359c28526ef50bfdc4a890fc3d752642792a82a21ff96c210001f1fb3ca` | lock v1와 >=3.12(`Garmin/uv.lock:1`, :3) |
| `Garmin/.python-version` | `5abd4dc1efa09469b88916c8e4e027a8c266a9b6d06f43ac9da3e30cd00b4ab5` | `3.14.8`(`Garmin/.python-version:1`) |

`deploy.sh`는 runtime/.venv에 `uv sync --frozen --no-editable --no-dev`를 하고 실제 patch가 3.14.8인지 확인한다. 없는 config만 복사하고 스킬을 staging 후 교체, normalize 성공 뒤 별도 install-schedule을 실행한다(`Garmin/scripts/deploy.sh:27`, :35, :37, :43, :49, :89). archive의 스킬 폴더 이름은 `skills/`가 아니라 **`skill/`**이고, daily-analysis 등 분석 절차이지 공통 install 스킬이 아니다(`Garmin/scripts/deploy.sh:56`; `Garmin/skill/garmin-daily-analysis/SKILL.md:2`, :21). 스킬 배포의 staging 방식과 frozen/patch 확인은 참고할 수 있지만 독립 config·normalize·LaunchAgent를 Brain 확장 설치 완료 조건으로 그대로 쓰면 범위를 벗어난다(경계:23, :50).

macOS arm64 wheel URL/해시는 lock에 일부 보인다(cffi cp314 `Garmin/uv.lock:61`, curl-cffi abi3 :348, matplotlib cp314 :779). **이는 설치 재현성 증명이 아니다.** 고정 Python binary 공급/해시, uv 버전, 전체 전이 wheel 호환성·최소 macOS, sdist fallback/도구체인, Python PG driver와 DB 접속은 실제 검증이 남는다. 옛 pyproject에는 PG driver가 없고 새 PG adapter에 필요한 의존성 추가는 lock 변경을 수반할 수 있다(`Garmin/pyproject.toml:7`; spine:787). >=3.12 선언과 patch pin을 혼동하지 않고 위 원본 해시와 새 잠금 차이를 기록하는 후보가 필요하다(spine Deferred:787; 경계:28).

## 6. Registry와 공개 상태 view·선행 API

현재 명령 등록부와 조립은 확장 상태 소비를 갖지 않고 외부 workHandlers도 실제 호출에는 비어 있다는 계약이다(`apps/cli/src/commands/index.ts:36`; `apps/cli/src/assembly.ts:54`, :95). 새 registry의 표 이름은 아직 정하지 않았다. 후보는 core schema의 설치 사실(이름/manifest·패키지 버전/설치 단계/owner schema 버전)과 활성 사실, 마지막 실패/연결 상태의 분리이며, 단일 enum “설치됨”으로 로그인/예약 성공까지 대체하면 안 된다(에픽13:18; 경계:45, :49).

설치·활성 상태 작성자는 registry 하나다. CLI가 직접 별도 TOML 플래그를 쓰거나 doctor/스킬이 상태를 만들어 내지 않는다. 공개 상태는 registry가 제공하고 doctor·install 스킬·epic 17 검색이 읽는다. 검색에서 꺼진 데이터의 표시/검색 가능 여부를 구현하는 일은 epic 17이며, 13은 데이터를 보존하고 상태를 제공한다(spine:460; 에픽13:35). 공개 view가 SQL view인지 SDK projection인지 구체적 모양은 후보지만 확장 role의 core 공개 view SELECT와 소비자 일관성을 함께 설계해야 한다(spine:472).

| 선행 산출물 | epic 13 연결 위치·확인점 |
| --- | --- |
| 12.1 감독자·`process_probe` | manifest 명령→supervised 등록, 연결 확인 자식 실행. probe는 core 제공 Node 자식이고 testext worker 기반이지 Garmin 호출 아님(작업계획:8; 작업에픽:94; 에픽13:59) |
| 12.4 ABI v1 schema/fixture | manifest에 지원 ABI 버전을 묶고 TS/Python 판정 일치. core 배포 산출물의 파일을 Python jsonschema가 읽음(작업계획:44; 작업에픽:93) |
| 12.9 예약 SDK | install 스킬이 `schedules add/list/remove/run`과 동일 SDK로 등록·재조회. 자체 LaunchAgent 우회 금지(작업계획:104; 경계:50) |
| 12.10 보류 그룹 | registry disable→`extension:<ext>` 보류, enable→해제. `<ext>.*`는 자동 연결, core 분석 그룹은 epic 18이 붙임. 실행 중 취소·대기 `extension_disabled`·예약 발화/새 청구 차단·retry/run 우회 방지(작업계획:116, :117; 에픽13:57, :59) |

registry 변경과 보류 호출 사이 crash가 나도 “disabled인데 청구됨”이 생기지 않는 일관성 검증이 필요하다. 같은 DB transaction에 활성 변경과 보류 상태를 확정하거나 재조정 use case를 두는 선택지가 있으며, 실제 12.10 port가 어떤 transaction 경계를 주는지 선행 완료 후 확인한다(작업계획:116; spine:460). 새로운 큐/취소 엔진을 13에 하나 더 만드는 선택지는 인계와 맞지 않는다(에픽13:59).

작업 세트 검증 F4의 최신 재검증은 그룹 소비 인계를 해소했고, F3도 작업에픽 Notes의 명시적 예외로 정리됐다. 옛 검증 본문의 “미해소”를 현재 미결 질문으로 재도입하지 않는다(작업검증:104, :105; 작업에픽:102). 선행 경로/시그니처를 완료 HEAD에서 확인할 책임은 여전히 있다(작업계획:8).

## 7. 실제 Garmin 없는 fixture와 스킬 시험

테스트 확장 후보 `testext`는 manifest(이름/버전/core·ABI 호환/명령/설정/예약/마이그레이션/로그인 단계), owner별 최소 DDL, `process_probe`를 감싼 Node worker, 합성 연결 상태를 갖는다. 정상 progress/result는 12.1에서 받고, 로그인/연결 확인은 같은 ABI·snapshot을 쓰게 한다. 기본 정상 tracer에 Garmin package·실계정·모델을 넣을 필요가 없다(에픽13:59; spine:456, :508; 작업에픽:94). Python 코덱 시험은 이 Node 정상 경로와 별도 확장 시험 레인에서 **같은 12.4 배포 fixture**로 돌려야 한다(작업에픽:93).

가짜 로그인은 시험 전용 입력/상태 파일 또는 fake 인증 port가 `login_required`→`connected`로 바뀌게 하고, 사용자 입력 완료를 흉내 내는 제어는 시험 harness만 가진다. 실제 비밀번호/MFA를 요구하거나 SKILL.md에 저장하지 않는다. 연결 확인 전에는 예약 성공을 내지 않고, 실패하면 성공한 설치 사실만 남겨 재진입하도록 하는 시나리오가 필요하다(경계:45, :46, :49, :52). 실제 Garmin 인증 구현·토큰 복사는 16의 일이며 fixture 플래그를 제품 Garmin 인증 우회로 노출하지 않는다(에픽13:41; 이니셔티브:191, :192).

| 경로 | 관찰할 사실(제안) |
| --- | --- |
| 미설치→설치→로그인→연결→예약 | metadata 확인, ext 상태 변경, fake login 완료 뒤 연결 probe 성공, 예약 SDK 등록 및 list 재조회, 단계별 최종 보고(에픽13:21, :33) |
| 이미 설치/부분 설정 재실행 | package/role/migration 재적용 없음, 로그인/예약만 재개, 같은 예약 중복 없음(에픽13:34; 경계:45) |
| 설치 실패/취소 | installer runner 실패·중간 취소 후 마지막 실제 성공 단계 보존, 완료 표식 없음, 다음 실행 재개(경계:49, :52) |
| 로그인 미완료/연결 실패 | 각각 설치 성공과 별도 보고, 후속 예약 완료를 주장하지 않음(경계:45, :46, :49) |
| 예약 미준비/감독자 미실행 | schema에서 명령 부재 또는 SDK 미준비를 구분하고 예약 대기·수동 가능 여부만 보고(경계:44, :50; 작업에픽:49) |
| disable/enable | 진행 probe 취소, 대기/예약 보류, 데이터 보존, 재활성화 재개, 다른 그룹 비영향(작업계획:117; 에픽13:35) |

SKILL.md 자체 시험은 두 층이 필요하다. (a) 정적 검사: frontmatter/기본 배포 포함, `tested_against`·생성물 parity(생성 방식을 택하면), 명령·flag가 실제 CommandSpec에 존재, 비밀번호/MFA·임의 설치·별도 LaunchAgent 지시 없음. 기존 명령 meta/guide 검사와 AD-17의 스킬 parity 선례를 확장할 수 있다(`apps/cli/test/command-meta.test.ts:45`; `apps/cli/test/guide.test.ts:93`; spine:304). 공통 install 절차 원본을 Core 상수로 만들지 별도 템플릿으로 둘지는 후보이며 현재 생성기가 있다고 주장하지 않는다.

(b) 에이전트 행동 시험: 실제 SKILL.md를 읽힌 세션에 “연결해 줘”를 주고 fake CLI transcript의 호출 순서·금지 호출·최종 보고를 검사한다. 스크립트가 같은 CLI를 순서대로 부른 E2E만으로는 **에이전트가 스킬을 읽고 실패/재개 지시를 따른다**를 증명하지 못한다. case별 실제 명령 결과와 최종 보고를 대조하고 거짓 완료·무지원 명령 우회를 실패로 세는 평가 harness 후보가 필요하다(경계:44, :49, :52; 에픽13:33, :34). 현재 지정한 Brain 시험 소스에는 이 스킬 행동 harness가 없으므로 새 진입점·offline fake/실제 에이전트 실행 구분을 plan에 명시해야 한다(`apps/cli/src/commands/index.ts:36`; 작업에픽:104의 시험 명시 선례).

## 8. 공유 파일 레인과 한 세션 위험

아래 경로는 현재 파일 또는 **새 파일 후보**다. 11·12 완료 후 정확한 새 모듈명을 확인해야 한다(작업계획:8; PG에픽:19). 기능별로 나누더라도 같은 조립/등록부를 동시에 쓰므로 “파일이 없으니 독립”으로 취급하지 않는 편이 안전하다(작업에픽:99의 선례).

| 함께 수정할 자리 | 겹치는 스토리 후보 | 레인 근거 |
| --- | --- | --- |
| `packages/core/src/ports/store.ts`, `brain.ts`, `index.ts`, `testing/` | registry·설치·활성/보류·상태 | 공개 SDK와 Store/계약 하나로 수렴(에픽13:18; spine:111) |
| `packages/postgres/src/migrate.ts`, 새 registry adapter·core migrations, 테스트 | 설치·registry·role | owner 번호·DDL/권한·transaction 충돌(spine:480, :481) |
| `apps/cli/src/config/codec.ts`, 새 manifest/snapshot 모듈 | manifest·설정·로그인·감독자 | 키 정의/비밀 해석 원본 하나(spine:320, :508) |
| `apps/cli/src/assembly.ts`, `daemon/run.ts`, 12의 감독자 등록부 | 실행 연결·보류·snapshot | 일감 분류와 자식 수명 연결(작업계획:8, :116) |
| `apps/cli/src/commands/index.ts`, 새 ext commands, `packages/second_brain/src/index.ts`, Core 출력 코덱/코드 표 | 모든 CLI·status/doctor | CommandSpec/SDK 1:1, meta/출력 중앙화(spine:111, :113) |
| `apps/cli/src/install/flow.ts`, `install.ts`, doctor checks | 설치·재개·갱신·상태 | 완료 표식/실패 보고 공유(`apps/cli/src/install/flow.ts:105`, :635) |
| 새 fixture 확장·Python fixture runner·package 배포 목록 | tracer·ABI·설치 재현성 | 12.4 배포 fixture가 공동 입력(작업계획:44) |
| 새 `plugin/skills/install/SKILL.md`, 생성/검사 도구, manifest/app-ref, README | 스킬·배포 | 캐시 version/생성물 parity(`README.md:959`; spine:304) |

한 세션 위험이 큰 묶음은 “manifest 전체+Python 재현성+role/RLS+registry+로그인+스킬+실제 Mac” 전부를 tracer에 넣는 경우다. 서로 다른 OS/DB/에이전트 경계라 실패 원인이 섞인다(에픽13:17, :19, :21, :36). 정상 fixture 경로의 최소 manifest·설치·조회·연결 probe를 먼저 관통시키고, 권한/중간 실패/언어 교차/스킬 행동 검증을 후속으로 넓히는 선택지가 있다(작업에픽:98, :104의 얇은 tracer 선례). 동일 core migration·코덱·조립을 쓰는 변경은 순서 레인 후보, 스킬 문안/fake 대화 case는 API 모양이 고정된 뒤 제한적으로 병렬화할 후보다(위 공유 표 근거).

## 9. Done when 1~5의 시험 기반과 빠진 것·이 Mac 확인

| Done when | 현재 읽은 기반 | 아직 추가/인계 확인할 것 |
| --- | --- | --- |
| 1: Python 없는 기본 Brain | 설치 fake flow·재실행, bootstrap fake, 수집/doctor 시험(`apps/cli/test/install-flow.test.ts:511`, :823; `tooling/bootstrap/test/bootstrap.test.ts:272`; `apps/cli/test/doctor-checks.test.ts:85`) | PG 기반으로 전환된 동일 경로 + Python/uv 부재 강제 시험. Node-only deps만으로 불요구를 입증할 수 없음(이니셔티브:27; PG계획:104) |
| 2: 스킬 정상 경로 | guide schema/명령 meta 시험, 12가 줄 probe·ABI·예약 SDK(`apps/cli/test/guide.test.ts:93`; 작업계획:8, :44, :104) | manifest/registry fixture 설치 E2E와 SKILL.md를 읽은 에이전트 행동 시험, fake 로그인 제어(경계:52) |
| 3: 재개·단계별 실패 | setup 취소 테스트와 구조화 결과·재실행 시험(`apps/cli/test/install.test.ts:313`; `apps/cli/src/install/flow.ts:105`; `apps/cli/test/install-flow.test.ts:823`) | 실패 결과의 성공 단계·재개 위치, 중간 crash/취소/로그인 필요/예약 미준비와 중복 방지 행렬(에픽13:34) |
| 4: 비활성 데이터 보존 | 12.10 보류/취소/재개 시험 계획, doctor check source 확장 seam(작업계획:116, :117; `packages/core/src/doctor/doctor.ts:72`) | registry 활성 변경과 그룹 연결, 공개 view/doctor 상태·확장 데이터 해시 유지. 검색 응답 표시는 17 소유(에픽13:35) |
| 5: 갱신 후 환경 보존·이 Mac | 실제 hook 설치/갱신 통합 시험과 version/cache 문서(`tooling/bootstrap/test/hook.test.ts:163`, :237; `README.md:962`) | 확장 환경/설정/DDL 유지한 플러그인 root 변경 시험과 설치본 fixture 확인. 운영과 별도 홈/DB/Label/확장으로 격리(spine:520) |

기존 Vitest는 apps/packages/tooling의 `test/`를 프로젝트로 발견하고 `global-setup.ts`가 있으면 선택한 프로젝트에서만 실행한다. Python fixture suite는 자동 발견되지 않으므로 선택 확장 전용 명시 진입점을 만들어 기본 시험에 Python을 강제하지 않는 후보가 적절하다(`vitest.config.ts:10`, :12, :17, :27; `package.json:19`; spine:459). 12.4 산출물은 현재 `packages/core/package.json:16`의 dist-only 배포 규칙까지 바꿀 예정이므로 source tree fixture만 통과하고 설치본에서 파일이 없는 경우도 검증해야 한다(작업계획:44; 작업검증:78).

이 Mac의 마지막 확인은 에이전트가 할 수 있도록 이미 위임됐다. 로컬 플러그인 배포·설치/명령/doctor 결과를 plan에 남기고 `hitl=false`, 원격 push 필수 단계는 실행하지 않고 `operator_actions`에 남긴다(이니셔티브:188, :189). README는 **로컬 marketplace 등록 방법**을 제공하지만 이 Mac의 실제 등록 출처를 증명하지는 않는다(`README.md:14`, :17, :968). 이번 조사에서는 marketplace 설정이나 인증 토큰을 읽거나 CLI를 실행하지 않았다. 후속 Mac 스토리는 먼저 실제 source가 로컬인지 원격 캐시인지 확인하고, 로컬이면 앞선 기능 ref+version으로 배포한 뒤 새 세션에서 스킬 발견→testext 정상/재개→doctor→업데이트 후 확장 보존 증거를 남기는 후보가 있다(에픽13:36; 이니셔티브:189; spine:333).

원격 캐시라 새 ref를 받는 데 push가 필요하면 로컬 설치본 검증과 원격 배포 미완료를 분리해 기록한다(`README.md:962`; 이니셔티브:189). Garmin MFA처럼 사람만 가능한 단계는 `awaiting-operator` 목록에 남기되 fixture 기반 epic 13 확인을 실제 Garmin 로그인으로 바꾸지 않는다(이니셔티브:192; 에픽13:41, :59). 이 정적 보고서는 이 Mac Done 판정을 내리지 않는다.

## 스토리 후보

아래는 결정이 아닌 tracer·순서·파일 변경 **선택지**다. 실제 11·12 완료 HEAD에서 signature와 migration 다음 번호를 확인하고 세션 분량을 판정해야 한다(에픽13:54, :55; 작업계획:8).

| 후보 | 관통 경로/검증 | 고칠 파일 후보 |
| --- | --- | --- |
| T1 tracer A: 테스트 확장 설치→상태→연결 probe | 최소 manifest+registry+확장 설치 root+role/최소 migration→12.1 감독자로 testext probe 한 건→공개 상태/CLI. 실제 Garmin·Python·스킬 행동 오류 행렬은 후속. 얇은 수직 경로를 우선하는 안(에픽13:17, :19, :59) | 새 `packages/core/src/extensions/`·registry port/fake/계약, `brain.ts`·exports, PG registry migration/adapter와 실행기 연결, CLI `ext-install.ts`·`ext-status.ts`/등록부/assembly, 새 testext fixture |
| T1 대안 B: 스킬 정상 경로까지 한 tracer | 같은 fixture에 fake 로그인과 예약 SDK를 먼저 묶어 미설치→예약 완료를 관통. 사용자 결과가 빨리 드러나지만 설치·인증·예약·스킬의 네 경계가 한 세션을 넘길 위험(에픽13:21, :33; 작업에픽:104) | A 파일 + `plugin/skills/install/SKILL.md`, 새 스킬 harness, 12.9 예약 SDK 연결 |
| T2 manifest·snapshot·두 언어 계약 완성 | ABI v1 버전 결합·타입/default/secret 참조·호환성 거부·TS/Python 동일 fixture 판정(작업에픽:93; spine:508) | 새 manifest schema/fixtures/codec, `apps/cli/src/config/codec.ts`·snapshot adapter, 감독자 실행 입력, Python fixture runner/선택 확장 pyproject·lock, core 배포 검증 |
| T3 설치 재현성·권한·중간 실패와 재개 | frozen 환경/patch pin·owner별 migration·확장 role 출처 결합과 12.3 EXECUTE·오래된 token 거부·중간 실패 후 재개. 위험이 크면 Python 환경과 DB 권한을 두 스토리로 분리하는 선택지(spine:471, :481, :787; 에픽13:34) | extension installer/runner, `packages/postgres/src/migrate.ts` 연결·role provisioning/시험, CLI 설치 결과 코덱, config secret 참조, Python 배포 메타/lock |
| T4 활성/비활성·공개 상태 | registry→12.10 보류/해제, 취소·데이터 유지·doctor/list 노출·retry 우회 금지. 건강/검색 로직은 넣지 않음(에픽13:35, :57, :59) | registry use case/PG transaction·migration/계약, `ext-enable.ts`·`ext-disable.ts`, 공개 상태 view, doctor checks/출력 코덱, 보류 소비 통합 시험 |
| T5 install 스킬과 단계 보고 | 실제 CLI 메타→중복 설치 회피→fake 로그인→연결 확인→12.9 예약→재조회·최종 결과, 실패/취소/미준비 행동 평가(경계:44, :52) | `plugin/skills/install/SKILL.md`, 문안 원본/생성기(선택), command-meta/guide·스킬 정적 검사, 에이전트 fake CLI harness와 cases, README |
| T6 기본 Brain 불요구·갱신 통합 | Python/uv 없이 setup/수집/doctor, bootstrap 갱신 시 기존 확장 환경·설정·schema 보존(에픽13:32, :36) | `apps/cli/test/install-flow.test.ts`·doctor/수집 통합, `tooling/bootstrap/test/hook.test.ts`·환경 fake, 설치 상태 재검증 |
| T7 정리와 이 Mac 설치본 확인 | 구현 중 미룬 정리 후 앞선 커밋 ref/version 배포, 로컬 marketplace/캐시 경로 확인, fixture로 스킬 정상/재개와 갱신 보존 관찰. 원격 push/실계정은 operator 목록(이니셔티브:189, :192) | 필요한 정리 파일, `plugin/app-ref`·`plugin/.claude-plugin/plugin.json`, 새 Mac 확인 plan·operator_actions |

순서 후보는 **A→T2→T3→T4→T5→T6→T7** 또는 **B→T2/T3→T4→스킬 실패 행렬→T6→T7**이다. T3의 권한과 환경을 분리하면 DB 레인과 선택 Python fixture 작성은 계약 고정 후 나란히 준비할 여지가 있다. 다만 번호·registry/설치·코덱·감독자 조립은 위 8절의 공유 파일이므로 합치는 순서를 두고, 모든 후보를 실제 ticket으로 확정하는 일은 이 보고서 밖이다(작업에픽:99의 공유 레인 선례; 에픽13:17, :19, :21).
