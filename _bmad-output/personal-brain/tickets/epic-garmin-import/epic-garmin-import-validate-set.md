수정 후 재검증 — fix 5 / suggest 2 / ask 0

# epic 14 스토리 세트 검증

2026-10-28. 대상은 refined=true 에픽과 leaf가 아직 없는 8개 entry다. Ticket·Set·Dependencies와 ticket.md의 “Rules the template cannot carry”를 적용했다. 초안의 책임 배정·실행 가능성을 검토한 결과이며 구현 완료 판정은 아니다. 테스트·빌드·Docker·네트워크·설치·private capture 열람·커밋은 하지 않았다.

근거 경로 약칭은 다음과 같다. 아래 `약칭:행`은 이 표의 저장소 상대 파일과 행을 가리킨다.

| 약칭 | 파일 |
| --- | --- |
| 에픽 | `_bmad-output/personal-brain/tickets/epic-garmin-import/epic-garmin-import.md` |
| 세트 | `_bmad-output/personal-brain/tickets/epic-garmin-import/tickets/tickets.toml` |
| 조사 | `_bmad-output/personal-brain/tickets/epic-garmin-import/epic-garmin-import-research-code.md` |
| spine | `_bmad-output/personal-brain/architecture-brain-v1-slice-1/architecture-brain-v1-slice-1.md` |
| 이니셔티브 | `_bmad-output/personal-brain/initiative-personal-brain.md` |
| 이전계약 | `_bmad-output/personal-brain/prep-garmin-absorption/migration-contract.md` |
| PG계획 | `_bmad-output/personal-brain/tickets/epic-postgres-primary/tickets/tickets.toml` |
| 작업계획 | `_bmad-output/personal-brain/tickets/epic-jobs-and-scheduler/tickets/tickets.toml` |
| 확장계획 | `_bmad-output/personal-brain/tickets/epic-extensions/tickets/tickets.toml` |
| 채널계획 | `_bmad-output/personal-brain/tickets/epic-channels/tickets/tickets.toml` |
| 수집에픽 | `_bmad-output/personal-brain/tickets/epic-garmin-runtime/epic-garmin-runtime.md` |
| 조회에픽 | `_bmad-output/personal-brain/tickets/epic-search-and-health-query/epic-search-and-health-query.md` |
| 분석에픽 | `_bmad-output/personal-brain/tickets/epic-health-analysis/epic-health-analysis.md` |

검사 규칙은 메인 checkout의 `~/github/second-brain/_bmad/render/bmad-agent-po/second-brain-bbe56f7ddda0/dcffd73a7f031ef42569/references/validate-checks.md`와 같은 폴더의 `ticket.md`를 읽었다. 앞선 형식은 `_bmad-output/personal-brain/tickets/epic-channels/epic-channels-validate-set.md`의 최초 검증과 재검증을 참고했다.

## fix

### F1 — 확정한 추천 결정을 spine의 공통 계약과 Deferred에 반영한다

- 근거: `에픽:51`, `에픽:106`, `에픽:108`, `에픽:110`, `에픽:115`; `이니셔티브:188`, `이니셔티브:190`; `spine:492`, `spine:541`, `spine:542`, `spine:774`, `spine:787`, `spine:788`.
- 문제: 에픽은 규칙 A와 계정 identity, 관측 revision·정규화 비교를 확정했으나 spine에는 여전히 사용자 선택 전 금지와 실제 반입 직전 사용자 선택이 남아 있다. AD-32의 “미선택 충돌은 ambiguity”는 규칙 A로 선택된 dataset 값과 보존되는 비선택 후보도 모두 ambiguity로 만들 수 있는 문장이다. 에픽은 규칙으로 선택할 수 없는 동률·계정 미확인만 현재 값에서 제외한다. Deferred도 건강 계약의 확정 부분, driver 재현성의 14/16 분담, C6 해소를 반영하지 않았다. AD-36의 옛 LATEST 확인·writer 정책은 새 capture를 만들고 이후 변경은 16에서 전환한다는 결정과 연결되어 있지 않다.
- 바꿀 내용: spine에 날짜 있는 Decision과 에픽 결정 참조를 넣는다. AD-32는 규칙 A의 dataset 순서와 선택 불가능한 충돌의 ambiguity를 구별하고, AD-36은 위임으로 C6가 충족됐음과 새 일관 capture 기준 검증·16 전환 경계를 명시한다. Deferred 세 줄은 확정 부분과 남은 구현 검증을 분리한다. 건강 표의 전체 컬럼 DDL까지 지금 정하라는 뜻은 아니다. driver arm64 확인은 14.1, 옛 수집 의존의 설치 확인은 16으로 표시한다. 이미 정한 선택지 A·driver·계정 정책을 다시 묻지 않는다.

### F2 — 뒤 에픽에 raw key·계정 identity·권위 규칙의 수신 문장을 남긴다

- 근거: `에픽:109`, `에픽:110`, `에픽:111`; `세트:20`, `세트:56`; `수집에픽:17`, `수집에픽:19`, `수집에픽:56`; `조회에픽:20`, `조회에픽:58`; `분석에픽:15`, `분석에픽:56`; `에픽:117`.
- 문제: 14의 생산자는 소비자를 명시하지만, 특히 16의 수신 문장은 뼈대·건강 표·file_requests라는 포괄적 인계에 그친다. 새 raw도 `<scope>/<원래 key>`를 쓰고 로그인 profile의 같은 id를 사용하며 새 수집을 맨 앞에 둔 권위 규칙 새 버전을 쓴다는 계약은 14 Notes에만 있다. “16 정제 때 받는 쪽에 적는다”는 아직 인계 완료가 아니다. Dependencies의 양쪽 description 예외는 앞 에픽 11~15에만 기록돼 있다.
- 바꿀 내용: 16의 Description/Notes에 14.1의 raw view 정규형, 14.2의 catalog·현재 view·계정 의미·권위 기록, 14.5의 파일 요청 결과 view 수신과 새 수집 규칙 버전 책임을 참조로 적는다. 17·18에는 14.2의 계약 문서/공유 fixture와 ambiguity 의미를 수신한다고 연결하고, 18은 14.5의 analyses 최소형·파일 관계를 호환 확장한다고 연결한다. 정의는 복제하지 않고 14의 해당 Decision과 산출물을 참조한다. 뒤 에픽을 쪼갤 때 이 생산 entry로 교차 after를 고정한다.

### F3 — 실제 반입 plan에 원시 명령 출력을 붙이지 못하게 한다

- 근거: `세트:91`, `세트:92`; `에픽:68`, `에픽:114`; `이니셔티브:189`.
- 문제: 8의 description은 공개 집계만 plan에 두지만 verify는 “명령 출력 … doctor 출력”을 plan에 남기라고 포괄적으로 요구한다. 같은 verify가 raw_records와 현재 view의 읽기까지 요구하므로 실제 계정·날짜·건강 값·해시가 든 조회 결과나 오류를 증거로 붙일 길이 있다. 일반 비밀 패턴 가리기만으로 건강값과 개인 날짜가 제거되는 것은 아니다.
- 바꿀 내용: 8의 verify와 에픽 Notes에 plan 증거는 허용된 건수·충돌/제외 사유 수·성공/실패 상태만으로 투영한 공개 출력이라고 명시한다. doctor와 조회의 원시 출력·오류 상세·capture 경로 및 private 보고서는 Brain 홈에만 둔다. 공개 plan에는 값 없이 읽기 성공 여부만 쓴다. 합성 시험에 개인 날짜·계정·건강값 표식을 넣어 공개 출력과 plan용 결과에서 제거됨을 6의 검증에 포함한다. 실데이터를 시험 fixture로 옮기지 않는다.

### F4 — high-risk entry의 기준 외 추가 확인을 Notes에 배정한다

- 근거: `에픽:119`~`에픽:127`; `세트:8`, `세트:21`, `세트:45`, `세트:57`, `세트:92`; 검사 규칙 `ticket.md`, “Rules the template cannot carry”의 high-risk 추가 확인.
- 문제: Notes에는 high를 고른 이유만 있다. 1은 description에 arm64 추가 확인이 있지만, 2·4·5·8에는 verify와 별도로 수행할 추가 확인을 Notes에 지정하지 않았다. high-risk 티켓의 추가 확인 주인이 없다.
- 바꿀 내용: 에픽 Notes에 high entry별 추가 확인 한 가지를 배정하고 leaf를 만들 때 이어받게 한다. 예를 들어 1은 이미 적힌 arm64 driver 왕복, 2는 publisher와 독립된 기대값 계산 검토, 4는 두 importer의 동일 batch 동시 시작 후 충돌·중복 확인, 5는 파일 결과 확인 전 staging을 잃지 않는 보존 확인, 8은 private 전수 대조 요약과 공개 plan의 개인 데이터 부재를 별도 점검한다. 실제 수치·해시를 Notes에 적지 않는다.

### F5 — sweep 뒤 실제 반입을 두는 예외와 실패 환류를 명시한다

- 근거: `세트:80`, `세트:83`, `세트:91`, `세트:94`; `에픽:116`; 검사 규칙 `validate-checks.md`, Set의 Refactor sweep.
- 문제: 7은 1~6만 기다리고 8은 배포·새 capture 생성·실제 반입을 한다. 규칙이 자동 허용한 “마지막 end-to-end suite”보다 범위가 넓다. Notes는 순서를 정했지만 sweep이 코드 스토리만 마감한다는 예외와 8의 발견 사항 처리 경계를 명시하지 않았다. 실패는 버그로 고친다는 8의 설명은 있으므로 순서를 뒤집을 필요는 없다.
- 바꿀 내용: 에픽 Notes에 날짜 있는 Decision으로 7은 코드 1~6의 cleanup을 닫고 8의 배포·운영 반입은 그 뒤 별도이며, 8에서 찾은 기능 수정은 버그 스토리로 처리한다고 명시한다. 7로 밀린 기능을 넣지 않고 8이 성공 기준을 통과할 때까지 실제 반입 완료로 세지 않는다. epic 15의 같은 예외와 일치시킨다.

## suggest

### S1 — tracer의 한 세션 상한을 plan 첫머리에 고정한다

- 근거: `세트:8`, `세트:9`; `에픽:116`; `조사:269`, `조사:299`.
- 문제: 수직 경로는 맞지만 Python 패키지·garmin DDL·세 core 계약·RLS·attempt·파일 인계·추출·시험 기반을 처음 묶으므로 여전히 큰 스토리다. 현재 “넘으면 비필수 완성을 다음 스토리로”라는 안전장치는 적절하지만 분리 대상을 더 구체화하면 계획이 커지는 것을 막을 수 있다.
- 제안: plan 상한을 schema 15 raw 한 건·일 지표 하나·Markdown 하나·정상 파일 인계 하나로 둔다. 전체 catalog/현재 선택은 2, schema별 전수 reader와 수동 CLI는 3, 전체 보존 mapping/재개는 4, 파일 실패 행렬/전수 분석은 5에 남긴다. 이 구분으로도 초과하면 설치 상태 표시 다듬기 등 비필수 작업만 이름 붙인 새 스토리로 분리하고 core 읽기·RLS·현재 attempt·원문 보존·비발신은 1에 유지한다.

### S2 — verify 정제 때 crash 지점과 독립 실행 진입점을 고정한다

- 근거: `세트:8`, `세트:9`, `세트:45`, `세트:57`, `세트:69`, `세트:81`.
- 문제: draft 수준의 검증 접근은 있다. 다만 “프로세스를 죽임”만으로는 확장/감독자/core 파일 handler 중 무엇을 언제 죽이는지 비작성자가 재현하기 어렵다. Python suite를 기본 suite와 별도로 부르는 선행 설치 계약도 유지해야 한다(`확장계획:32`, `확장계획:33`).
- 제안: 정제 plan에 실제 PG·실제 Python·데몬 실행을 구성하는 명령, 공유 fixture 경로, kill 지점 동기화, 종료 확인, 재시작·정리 명령을 고정한다. 5는 요청 INSERT 후/인계 commit 전/FileStore 저장 후 결과 commit 전을 구분한다. 7도 TS 기본 suite와 Python 별도 suite의 실행 명령을 각각 남긴다. 아직 leaf가 없는 entry에 지금 시험 이름이나 이미 통과한 증거를 요구하지 않는다.

## 확인한 coverage와 분담

| Requirements | 담당 결과 |
| --- | --- |
| E14-1 | 1 패키지·설치·driver, 8 설치본 실제 확인 |
| E14-2 | 1 raw·importer 상태 최소형, 4 옛 표/키/상태 전수 보존 |
| E14-3 | 1 고정 raw view·key 정규형·원문 읽기 |
| E14-4 | 1 일 값 한 지표/현재 view 최소형, 2 catalog·키·선택/ambiguity·TS/Python fixture 완성 |
| E14-5 | 1 analyses·Markdown 경로 최소형, 5 전체 파일 기반 분석/evaluation·누락 metadata·불변 파일 관계 완성 |
| E14-6 | 1 정상 요청→core 인계→FileStore→결과, 5 crash/해시 실패·상태/재개·staging 보존/정리 완성 |
| E14-7 | 3 보존 reader·preflight |
| E14-8 | 4 batch 멱등·checkpoint·충돌·dataset-local mapping |
| E14-9 | 3 소스 역할/계정 확인·preflight, 4 규칙 A와 권위 기록의 실제 반입, 8 실 capture 확인. 2는 현재 view의 선택 의미 구현 |
| E14-10 | 4 채널 15.3 legacy 표·같은 conversation·비발신 |
| E14-11 | 5 파일 분류·로그 비밀 검사·body/profile/inbox provenance |
| E14-12 | 6 전수 대조·실패 결과, 8 실제 capture의 대조 실행 |
| E14-13 | 3 공용 ext run·manifest 허용·작업 계약·보류 준수 |

E14-1~13의 covers 누락·존재하지 않는 id는 없다. 같은 id를 맡는 최소 경로/완성/실제 실행의 차이는 entry description으로 구별된다(`세트:8`, `세트:20`, `세트:32`, `세트:44`, `세트:56`, `세트:68`, `세트:91`). 7은 cleanup 전용이고 covers=[]가 타당하다. leaf가 없어 full criteria·refined=true를 entry마다 요구하지 않는다. 명시된 unknown은 없으며 선행 구현의 실제 시그니처는 정한 HEAD에서 확인한다.

## Dependencies와 보드

- 보드 명령은 기본 uv cache의 임시 파일 권한 오류 뒤, `UV_CACHE_DIR=/tmp/epic14-validate-uv UV_OFFLINE=1 uv run ~/.agents/skills/bmad-agent-po/scripts/tickets.py --project-root "$(git rev-parse --show-toplevel)" status _bmad-output/personal-brain`으로 성공했다. 네트워크·설치는 하지 않았다. epic 14는 refined=true, gated_by=[], next_id=9이며 8개 모두 planned·file=null이다. `unpinned_after=[]`, `undeclared_after=[]`, `order_conflict=[]`이고 cycle·drift 오류는 없었다. 이는 구현 완료 증거가 아니다.
- 1→15.6은 core 번호열·Store·조립을 마감한 HEAD를 받는 조건이다(`에픽:117`, `채널계획:68`, `채널계획:71`). 단순한 표시 순서가 아니다. 11.4는 PG Attachment/Extraction 계약(`PG계획:56`), 12.3은 현재 attempt 함수/trigger 예(`작업계획:32`), 13.3은 frozen Python 설치(`확장계획:32`), 13.4는 role·출처 결합/함수 EXECUTE 권한(`확장계획:44`)을 준다. 전이 경로와 중복돼도 실제 소비 산출물을 가리킨다.
- 13.3→13.2→13.1 경로로 manifest v1·설정 snapshot·설치 기반이 선행한다(`확장계획:23`, `확장계획:35`). 12.3→12.2→12.1로 감독자를 받으며, ABI 완성 12.4도 13.2가 기다린다. 15.6→15.1→13.9→13.1→12.11→12.10→12.9 경로로 queue/schedules·보류·감독자 기반이 충분히 선행한다. 질문에 적힌 12.11은 현재 세트에서 sweep이고 보류 기능 자체는 12.10이다(`작업계획:116`, `작업계획:128`). 둘 모두 경로에 포함된다.
- 4→15.3은 legacy 표·합성 입력·RLS·attempt trigger·같은 conversation 연결을 받는 실제 선행이다(`채널계획:32`, `세트:44`). 1이 이미 15.6을 기다리지만 4의 직접 명시는 소비 책임을 드러낸다.
- 1~8 한 레인은 공유 코드 충돌과 setup 소유를 설명하는 날짜 있는 Decision이다(`에픽:117`). 앞 에픽 description을 고치지 않는 예외도 그 줄에 있으므로 다시 fix로 만들지 않는다. 현 코드의 `apps/cli/src/assembly.ts:76`, `packages/postgres/src/migrate.ts:213`, `packages/core/src/output/codecs.ts:12`도 각각 파일 조립·마이그레이션 번호 중복 검사·출력 등록부라는 공유 지점을 확인시킨다. 향후 PG/감독자 구현이 이미 있다고 가정하지 않았다.
- 시험 setup의 최초 소유는 1이다(`세트:8`). 2~8이 이를 경로상 기다리므로 setup 선행 누락은 없다. F2의 구체 인계를 제외하면 뒤 에픽의 현재 view·analyses·파일 요청 소비와 기존 after/needs의 방향은 맞다.

## spine·Done when·개인 데이터

AD-30의 자기 출처 INSERT/RLS, core 단독 요청 인계, 생산자 바이트 보존은 1·5가 맡는다(`세트:8`, `세트:56`; `spine:469`, `spine:473`). core→확장 FK 금지와 DB 값 생성 금지는 에픽 Constraints에 있다(`에픽:65`, `에픽:66`). AD-31의 core 다음 번호/garmin 0001, AD-32의 보관 키·NULL 안전 UNIQUE, AD-33의 실제 attempt 검사, AD-35의 analyses 최소형은 각각 1·2·1·5에 배정됐다. Table Contract 네 행(`spine:578`~`spine:581`)의 생산자 소유와 일치한다. AD-36의 전수 비교는 6·8이며 F1대로 정책 문장을 갱신해야 한다.

| Done when | 결과와 제한 |
| --- | --- |
| 1 합성 fixture·재실행·재개·비발신 | 1 setup/실제 Python 경로, 3 reader, 4 DB crash/재개, 5 파일 crash, 6 대조. 구체 실행법은 정제 plan에 남김 |
| 2 capture와 실제 반입 | 8 새 capture·규칙 A·실제 반입. 실패·미선택 충돌·파일 대기를 성공으로 세지 않음(`세트:91`) |
| 3 출처별 비교 보고서 | 6 전수 비교·차이 시 실패, 8 실 capture 검증 |
| 4 원본 보존·비공개 데이터 보호 | 3 read-only/원본 해시, 6 원본 재확인·공개 집계, 8 source read-only·capture 무변경·git diff 확인. F3의 plan 증거 제한 보완 필요 |
| 5 플러그인 설치본 | 8 app-ref 앞선 commit/version 동반 갱신·설치본 실행. 원격 push 필요 단계는 operator_actions이며 실제 설치·검증 성공과 별개 |

8의 hitl=false는 `이니셔티브:188`~`이니셔티브:192`의 명시적 위임과 맞다. 추천 정책·원본 읽기·실제 반입을 새 ask로 열 사유는 없다. 계정 미확인·불일치는 원인을 기록하고 버그로 고쳐 같은 batch로 재개하며, pending/실패를 성공으로 적지 않는 경계가 있다. F3 보완 시 실패 원인도 공개 plan에는 개인 값을 제거한 분류만 남겨야 한다.

합성 fixture 원칙(`에픽:68`), 공개 집계/private 상세 분리(`에픽:114`, `세트:68`), 설정·비밀 로그의 반입 제외(`세트:56`)는 타당하다. 이 검토는 private capture를 열지 않았고 개인 건강값·계정·원문·해시 값을 옮기지 않았다. 확인되지 않은 옛 데이터나 revision·evaluation을 만들었다고 주장하지 않는 경계도 있다(`세트:68`). 보고서 하나만 새로 작성했으며 원래 수정 중인 에픽과 tickets.toml은 고치지 않았다.

## 재검증 (2026-10-28)

통과 — F1~F5·S1·S2 모두 해소. 새 지적 없음.

앞의 약칭을 그대로 쓴다. 지정한 수정문과 spine의 미커밋 diff를 Set·Dependencies 및 `ticket.md`의 “Rules the template cannot carry”에 맞춰 정적으로 대조했다. 판정은 스토리 세트의 책임·계약·검증 계획에 대한 것이며, leaf 정제나 구현·실제 반입의 완료 판정은 아니다.

| 지적 | 판정 | 근거와 확인 결과 |
| --- | --- | --- |
| F1 | 해소 | `에픽:128`, `spine:471`, `spine:493`, `spine:543`, `spine:544`, `spine:776`, `spine:789`, `spine:790`. raw key 정규형, dataset 순서→관측 revision→정규화 버전, 규칙으로 선택된 값과 선택 불가능한 ambiguity의 구분이 공통 계약에 반영됐다. C6는 위임으로 충족됐고 새 capture 기준 검증과 capture 이후 변경의 epic 16 전환이 연결됐다. Deferred 세 항목은 확정한 정책과 남은 DDL·catalog·설치 검증을 구분한다. `spine:533`의 analyses 최초 소유/호환 확장도 유지된다. |
| F2 | 해소 | `에픽:129`, `세트:20`, `세트:56`, `수집에픽:64`, `조회에픽:62`, `분석에픽:67`. 받는 쪽에서 14.1의 raw key, 14.2의 catalog·현재 view·계정/권위 의미, 14.5의 파일 요청 결과/analyses 관계를 참조한다. 수집은 새 수집 우선 규칙 버전과 capture 뒤 전환을 맡고, 조회·분석은 ambiguity 제외와 계약 문서·공유 fixture 소비를 명시한다. 뒤 에픽 세트가 아직 없으므로 교차 after를 쪼갤 때 고정한다는 경계가 적절하다. |
| F3 | 해소 | `에픽:130`, `세트:68`, `세트:69`, `세트:92`, `spine:544`. 6이 허용 칸만 공개하는 투영을 소유하고 합성 개인 날짜·계정·건강값·해시·원문 표식의 부재를 검사한다. 8의 plan 증거는 이 투영과 값 없는 성공 여부로 제한됐다. doctor·조회 원시 출력, 오류 상세, capture 경로와 private 보고서는 Brain 홈에만 남긴다. `세트:91`의 실패 원인 기록도 `에픽:130`에 따라 개인 값을 제거한 분류로 한정된다. |
| F4 | 해소 | `에픽:131`, `에픽:132`, `에픽:133`, `에픽:134`, `에픽:135`, `에픽:136`. high인 1·2·4·5·8 각각에 verify와 별도로 수행하고 leaf에 이어받을 추가 확인을 배정했다. arm64 driver 왕복, 독립 기대값 계산, 동일 batch 동시 시작, 결과 확정 전 staging 보존, private 대조/공개 plan 별도 점검으로 주인이 분명하다. |
| F5 | 해소 | `에픽:137`, `세트:80`, `세트:83`, `세트:91`, `세트:94`. 7은 코드 1~6의 cleanup을 닫고 8의 배포·새 capture·실제 반입은 뒤에 별도로 둔다는 날짜 있는 예외가 생겼다. 8의 기능 문제는 버그로 환류하고 7에 기능을 밀어 넣지 않으며, 8의 verify 전에는 반입 완료로 세지 않는다. 채널 에픽의 같은 예외(`_bmad-output/personal-brain/tickets/epic-channels/epic-channels.md:106`)와 일치한다. |
| S1 | 해소 | `에픽:138`, `세트:8`, `세트:9`. tracer 상한은 schema 15 raw 한 건·일 지표 하나·Markdown 하나·정상 파일 인계 하나다. 전체 catalog/선택은 2, 전수 reader/수동 CLI는 3, mapping/재개는 4, 파일 실패 행렬/전수 분석은 5에 남겼다. 초과 시 비필수 작업을 새 스토리로 나누되 core 읽기·RLS·현재 attempt·원문 보존·비발신은 1에 유지한다. |
| S2 | 해소 | `에픽:138`, `세트:57`, `세트:81`. 각 plan에 실제 PG·Python·데몬 구성 명령, fixture 경로, kill 동기화·종료 확인, 재시작·정리를 요구한다. 파일 crash는 요청 INSERT 뒤/인계 commit 전/FileStore 저장 뒤 결과 commit 전으로 구분하고 TS 기본 suite와 Python 별도 suite 명령을 각각 남긴다. 아직 leaf가 없는 초안에 실행된 시험 증거를 요구하지 않고, 정제 시 채울 구체 항목을 고정한 것으로 해소한다. |

새 모순도 확인했다. `이니셔티브:188`, `이니셔티브:189`, `이니셔티브:190`의 추천 결정·로컬 배포·C6 위임과 `에픽:106`, `에픽:108`, `에픽:110`, `에픽:111`, `에픽:115`의 규칙 A·driver/옛 의존 분담·계정 identity·새 capture 결정이 spine과 인계문에 일치한다. `에픽:20`과 `조회에픽:20`의 짧은 “미선택 충돌” 표현은 새 Decision 및 AD-32의 명시적인 구분에 따라 규칙으로 선택할 수 없는 충돌을 뜻한다. 규칙으로 선택된 현재 값을 다시 ambiguity로 처리하라는 새 요구는 아니다. 기록된 정책을 다시 열 근거는 발견하지 않았다.

앞 에픽의 계약도 바꾸지 않는다. `PG계획:56`의 FileStore·추출, `작업계획:32`의 현재 attempt 검사, `확장계획:32`, `확장계획:33`의 frozen Python 설치·별도 시험 진입점, `확장계획:44`의 role/EXECUTE, `채널계획:32`의 legacy 이력은 여전히 14.1·14.4가 받는다(`세트:8`, `세트:44`). 앞 에픽 entry에 인계문을 더하지 않는 예외는 `에픽:117`에 그대로 있고, 뒤 에픽은 F2의 Handoff로 수신을 명시했다. 공유 setup의 최초 소유는 여전히 1이고 2~8은 그 의존 경로 안에 있다.

보드는 `UV_CACHE_DIR=/tmp/epic14-revalidate-uv UV_OFFLINE=1 uv run ~/.agents/skills/bmad-agent-po/scripts/tickets.py --project-root "$(git rev-parse --show-toplevel)" status _bmad-output/personal-brain`으로 읽었다. exit 0, `unpinned_after=[]`, `undeclared_after=[]`, `order_conflict=[]`이며 cycle·drift 오류는 없었다. epic 14는 refined=true, gated_by=[], next_id=9이고 8개 entry 모두 planned·file=null이다. 기존 after와 covers는 유지됐으며, F5의 순서 예외와 F2의 향후 교차 after 고정은 현재 보드와 충돌하지 않는다.

이 절만 보고서 끝에 추가했다. 테스트·빌드·Docker·네트워크·설치·커밋 및 private capture 열람은 하지 않았다. 기존 본문 보존과 보고서의 절대 홈 경로 부재를 확인했다. 이 작업의 저장소 쓰기는 보고서 하나뿐이다. 작성 전후 파일 내용 비교에서는 다른 워커 소유의 분석·조회 코드 조사 보고서 두 개가 병행 변경됐으며, 이 작업이 검토한 에픽·세트·spine 및 나머지 기존 파일은 그대로였다. 다른 워커 보고서는 수정하지 않았다.
