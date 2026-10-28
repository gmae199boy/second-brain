수정 후 재검증 — fix 5 / suggest 3 / ask 0

# epic 8 스토리 세트 검증 (2026-10-28)

Ticket · Set · Dependencies와 `ticket.md`의 “Rules the template cannot carry”를 적용한 정적 검토다. 대상은 refined=true인 에픽과 leaf가 없는 8개 entry이며, 구현·시험·설치본 완료 판정은 아니다. 지정된 메인 checkout의 렌더 규칙은 읽기만 했다. 테스트·빌드·Docker·네트워크·설치·커밋은 하지 않았고 Garmin 계정·tokenstore는 열지 않았다.

아래 근거의 약칭은 모두 저장소 상대 경로다. `약칭:행`은 이 표의 파일과 해당 행을 뜻한다.

| 약칭 | 파일 |
| --- | --- |
| 에픽 | `_bmad-output/personal-brain/tickets/epic-drive/epic-drive.md` |
| 세트 | `_bmad-output/personal-brain/tickets/epic-drive/tickets/tickets.toml` |
| 조사 | `_bmad-output/personal-brain/tickets/epic-drive/epic-drive-research-code.md` |
| 이니셔티브 | `_bmad-output/personal-brain/initiative-personal-brain.md` |
| 트리 | `_bmad-output/personal-brain/tickets/tickets.toml` |
| spine | `_bmad-output/personal-brain/architecture-brain-v1-slice-1/architecture-brain-v1-slice-1.md` |
| PG계획 | `_bmad-output/personal-brain/tickets/epic-postgres-primary/tickets/tickets.toml` |
| 작업계획 | `_bmad-output/personal-brain/tickets/epic-jobs-and-scheduler/tickets/tickets.toml` |
| 조회계획 | `_bmad-output/personal-brain/tickets/epic-search-and-health-query/tickets/tickets.toml` |
| 조회에픽 | `_bmad-output/personal-brain/tickets/epic-search-and-health-query/epic-search-and-health-query.md` |
| 첨부에픽 | `_bmad-output/personal-brain/tickets/epic-attachments/epic-attachments.md` |
| 첨부계획 | `_bmad-output/personal-brain/tickets/epic-attachments/tickets/tickets.toml` |
| 데몬계획 | `_bmad-output/personal-brain/tickets/epic-daemon/tickets/tickets.toml` |
| 장부 | `_bmad-output/personal-brain/decisions-by-recommendation.md` |

## fix

### F1 — 먼저 쓰는 설정 키와 sync 진입점을 앞 스토리에 배정한다

- 근거: `세트:8`, `세트:9`, `세트:20`, `세트:21`, `세트:32`, `세트:35`; `PG계획:80`; `조회계획:8`.
- 문제: 1은 `drive.keep_local_days`로 삭제를 예약하지만 키 등록은 3이 맡는다. 11.6은 그 키를 등록하지 않는다고 명시했다. 2의 verify는 `brain sources sync`를 실행하지만 공개 명령 등록은 뒤의 3에 있다. 17이 만드는 명령도 `recall docs`·`files show`라 이 빈칸을 채우지 않는다. 현재 after대로 1·2를 각각 끝내고 검증할 수 없다.
- 바꿀 내용: 에픽 Notes의 분담을 고쳐 1이 보관 기간 키의 기본값·검증·DB 읽기 최소형을 등록하고, 2가 가짜 서버로 실행 가능한 `sources sync`의 CommandSpec·SDK·명령 메타 최소형을 만든다고 명시한다. 3은 OAuth와 나머지 명령·설정·예약을 완성한다. 또는 2의 verify를 그 스토리가 만드는 SDK 호출로 바꾸고 CLI 확인은 3으로 옮긴다. 뒤 스토리를 앞의 after에 넣어 순환을 만들지 않는다.

### F2 — 확정한 외부 소스 결과를 공통 spine 계약에 반영하고 읽기 경로를 닫는다

- 근거: `에픽:106`, `에픽:112`, `에픽:113`; `세트:20`, `세트:68`; `spine:287`, `spine:384`, `spine:387`, `spine:402`, `spine:570`, `spine:571`, `spine:575`, `spine:763`; `조회에픽:93`.
- 문제: AD-15는 모든 문서 결과에 `file_id`·조각 위치가 있고 그 출처가 `files.show` 입력이라고 한다. 확정된 이름 전용 결과는 file_id와 locator가 없으므로 이 계약을 바꾼다. 세트는 nullable 필드를 추가하지만 이름 전용 출처를 `files show`에 줬을 때의 결과가 없다. AD-23의 모든 files.home은 brain 위치라는 문장과 2의 “외부 파일을 brain home으로 만들지 않음”도 적용 범위를 분명히 해야 한다. 새 source·mapping 표의 소유/키는 에픽 Notes에만 있고 Table Contract에는 없다. locator의 공통 예도 로컬 shard 형태만 적혀 있다.
- 바꿀 내용: 새 결정을 묻지 말고 기존 Decision을 spine AD-15·23·24와 Table Contract에 동기화할 책임을 2에 둔다. 문서 본문 결과와 이름 전용 결과의 필수/nullable 출처 필드, 위치가 없을 때의 표시, source 전용 원본 URL, `files show`가 source_file_id를 받거나 명시적 미색인/접근 불가 상태를 돌려주는 경로를 정한다. 가짜 file_id·locator는 만들지 않는다. 외부 source content의 home 예외와 source_unreachable 경고 적용도 적고, source·source_files·Drive 매핑/업로드 상태 표의 키·작성자·가변성을 반영한다. locator는 확정된 backend별 순수 함수 예로 맞춘다. 2·6의 검증에는 이름 전용 결과의 출처만으로 상태/원본 링크를 얻는 경우를 추가한다. 17의 문서 결과·probe는 그대로 확장한다.

### F3 — 보관 기간을 줄일 때 이미 예약된 삭제 일감을 앞당길 주인을 둔다

- 근거: `에픽:108`; `세트:8`, `세트:56`, `세트:57`; `spine:356`.
- 문제: 최초 due는 검증 시각+30일이다. 삭제 handler가 실행 때만 현재 설정으로 재계산하면, 15일째 설정을 10일로 줄여도 handler는 원래 30일까지 청구되지 않는다. 5의 “그 시점에 지워짐” 검증과 확정된 앞당김 결정이 현재 구현 분담만으로 성립하지 않는다.
- 바꿀 내용: 5가 설정 변경 시 해당 이전 삭제 일감의 due를 재계산해 깨우는 경로 또는 같은 효과의 재평가 일감을 맡게 한다. 3의 config 변경 경로가 그 기능을 호출하도록 에픽 Notes에서 인계한다. verify는 원래 due 이전에 일감이 실제로 청구 가능해지는지부터 확인하고, 기간 증가·동시 변경·해제 뒤 취소가 되살아나지 않는지도 포함한다. 삭제 직전 원격 확인과 CAS 경계는 유지한다.

### F4 — high entry의 기준 외 추가 확인을 Notes에 배정한다

- 근거: `에픽:119`, `에픽:120`, `에픽:121`, `에픽:124`; `세트:13`, `세트:25`, `세트:61`; 비교 선례 `조회에픽:108`.
- 문제: 1·2·5에 high의 이유는 있지만 `ticket.md`가 요구하는 verify 기준 밖 추가 확인을 Notes에 배정하지 않았다.
- 바꿀 내용: 날짜 있는 Notes로 각 high entry에 한 가지씩 배정하고 leaf에 이어받는다. 추천은 1: 업로드 뒤 home 확정 전에 files.redact를 끼워 CAS와 삭제 경로를 별도로 검토, 2: 임시 바이트를 만든 뒤 프로세스를 종료하고 재시작 정리에서 자기 소유 외 파일이 보존되는지 확인, 5: disconnect와 만료 삭제의 경합을 별도 확인하는 것이다. 기존 verify의 정상 사례를 추가 확인으로 재명명하지 않는다.

### F5 — sweep 뒤 배포·실계정 확인의 예외와 실패 환류를 명시한다

- 근거: `세트:80`, `세트:83`, `세트:91`, `세트:94`; `에픽:116`, `에픽:118`; 비교 선례 `조회에픽:112`.
- 문제: 7은 1~6만 기다리고 8은 배포·설치·실계정 이전을 수행한다. 이는 Set 규칙이 자동 예외로 두는 마지막 end-to-end suite보다 넓다. 순서 Decision은 있지만 sweep을 코드 정리에 한정하는 예외와 8에서 발견한 기능 문제의 환류가 빠졌다.
- 바꿀 내용: 에픽 Notes에 날짜 있는 Decision으로 7은 코드 1~6 cleanup을 닫고 8의 배포·운영 확인은 뒤에 별도로 둔다고 적는다. 8에서 찾은 기능 문제는 버그 스토리로 고쳐 재검증하고 7에 넣지 않는다. OAuth 동의 전 또는 실제 확인 실패 때 설치본/실계정 완료로 세지 않는 기존 경계도 함께 참조한다. 확정된 순서는 유지한다.

## suggest

### S1 — tracer의 계약 일반화 범위에도 한 세션 상한을 둔다

- 근거: `세트:8`, `세트:9`; `에픽:116`; `조사:33`, `조사:143`, `조사:175`.
- 문제: 작은 txt·단순 업로드·0/30일로 기능 상한은 정했지만 공통 계약 분리, fake HTTP 기반, Drive adapter, 새 매핑 DDL, 이전 트랜잭션, 삭제 handler, files show 조립이 함께 들어간다. 얇은 수직 경로는 맞아도 한 세션 보장은 아직 약하다.
- 바꿀 내용: plan 첫머리에 정상 txt 한 건에 필요한 계약 case·DDL·왕복만 허용하고 OAuth·resumable·전체 오류 행렬·외부 source를 뒤에 남긴다고 적는다. 17 완료 HEAD를 읽고도 초과하면 비필수 계약 정리만 이름 붙인 후속 스토리로 분리한다. 검증→원자적 home 전환→원격 재확인→원문 읽기라는 tracer는 유지한다. 현재 숫자를 근거 없이 더 쪼개라고 요구하지 않는다.

### S2 — 검증 접근을 독립 실행 가능한 fixture·중단 지점으로 구체화한다

- 근거: `세트:8`, `세트:9`, `세트:33`, `세트:45`, `세트:57`, `세트:81`; `조사:87`, `조사:106`.
- 문제: 각 plan의 명령·사전 조건·관찰값·정리 의무는 적절하다. 다만 crash가 cursor commit 앞인지 뒤인지, 가짜 clock과 예약 틱을 어떻게 함께 전진시키는지, ZIP 폭탄을 실제 대량 할당 없이 어떻게 생성하는지는 정제 시 고정해야 한다.
- 바꿀 내용: 1의 공용 fake 시작/종료와 격리 PG·홈 설정, 3의 OAuth callback/clock 제어, 4의 합성 PDF·OOXML·안전한 상한 초과 fixture 생성, 5의 응답 유실/페이지 commit barrier와 kill 대상·재시작 명령을 plan에 명시한다. 표본 기대값은 시험 작성자가 아닌 사람이 확인할 수 있게 둔다. 데몬 없는 handler 시험과 실제 데몬 예약 연결 확인은 각각 진입점을 적는다. leaf 없는 초안에 지금 시험 이름이나 실행 통과 증거를 요구하지 않는다.

### S3 — 업로드 재개 상태의 민감값을 공개 출력에서 제외한다

- 근거: `에픽:52`, `에픽:53`, `에픽:107`, `에픽:109`; `세트:33`, `세트:56`, `세트:91`; `작업계획:104`.
- 문제: 토큰은 env·비출력으로 제한하지만 resumable session URI를 일감 상태에 영속하는 결정과 queue list/오류 진단이 만나는 경계는 명시되지 않았다. 외부 서버의 URL·오류 본문에 실파일 이름이나 인증 정보가 포함될 경우 일반 비밀 패턴만으로 공개 plan용 투영을 대신할 수 없다.
- 바꿀 내용: 기존 영속 결정은 유지하고 session URI·OAuth code/verifier·client secret·외부 오류 원문은 queue/doctor/log/plan에 내보내지 않는다고 Notes에 적는다. 합성 표식을 파일 이름·본문·토큰·URI·오류에 넣어 공개 출력과 plan용 투영의 부재를 확인한다. 8의 공개 증거는 현재 정한 단계 상태·건수만 유지한다.

## coverage와 Done when

| Requirements | 맡은 결과 |
| --- | --- |
| E8-1 | 1 계약·Drive adapter·검증·원자적 이전·삭제 최소형, 3 OAuth·설정·해제, 5 resumable·오류/기간 경계, 8 설치본 실제 확인 |
| E8-2 | 2 외부 source·목록·export/임시 바이트·이름만 있는 결과, 5 changes·재개·변경/접근 상실, 8 실제 폴더 확인 |
| E8-3 | 3 disconnect·늦은 확정 차단·토큰 정리·검색 보존·무삭제 |
| E8-5 | 4 PDF·docx·쪽/블록·상한·unsupported Carry |
| E8-6 | 2 외부 이름/본문 최소형, 6 첨부 포함 통합·중복/특수문자·미색인·마스킹, 8 실제 확인 |

`에픽:38`~`에픽:45`의 현재 요구 id는 모두 유효하다. 공유 id는 최소형/완성/실제 실행으로 분담돼 있다. E8-4는 `에픽:41`, `에픽:92`, `spine:763`대로 V1 뒤라 빠진 것이 맞고, E8-7은 `에픽:45`, `에픽:99`, `PG계획:80`대로 11.6으로 옮겼다. sweep의 covers=[]도 타당하다.

| Done when | 충족할 스토리 결과 |
| --- | --- |
| 1 이전·검증 후 삭제 | 1·5. 원격 checksum/되읽기, CAS·원자성, 삭제 전 원격 확인. F1·F3 보완 필요 |
| 2 txt/md/PDF/docx·사진·링크·임시 삭제 | 2·4·6. F2의 이름 전용 출처 계약 보완 필요 |
| 3 다음 동기화 주기 반영 | 3의 예약 등록 + 5의 changes·다음 주기 검증 |
| 4 해제 후 검색·접근 불가 | 3, source 세대 확인·대기 삭제 취소·Drive delete 0 |
| 5 대화 첨부 본문/이름·원본 | 6, 1의 Drive FileStore 읽기 경로와 17 files show 확장 |
| 6 기간 설정·DB와 함께 이동 | 11.6 설정 port를 받는 1·3·5. 컨테이너 재생성 보존 검증과 F3 필요 |
| 7 설치본 배포 | 8, 앞 commit app-ref와 version 동반 변경. OAuth 미완료는 awaiting-operator |

첨부 Carry는 `첨부에픽:110`, `에픽:105`, `세트:44`·`세트:45`에 일치한다. 새로 지원하는 PDF/docx의 unsupported만 버전마다 한 번 재큐잉하고, 기존 too_large 전수 재개·텍스트 streaming은 backlog, 이미지는 epic 4.1에 남는다. 이름 색인이 drain 한 번 늦는 DW-1은 `첨부에픽:109`, `조사:114`에 남아 있으므로 2·6의 검증은 명시적 drain 완료 뒤 관찰하면 된다. Drive 쪽에서 기존 deferred 전체를 해결했다고 세지 않는다.

## Dependencies·보드·공통 계약

보드는 다음 읽기 명령으로 exit 0이었다. offline과 별도 임시 cache로 네트워크·설치를 하지 않았다.

```sh
UV_CACHE_DIR=/tmp/epic8-validate-uv UV_OFFLINE=1 uv run ~/.agents/skills/bmad-agent-po/scripts/tickets.py --project-root "$(git rev-parse --show-toplevel)" status _bmad-output/personal-brain
```

`unpinned_after=[]`, `undeclared_after=[]`, `order_conflict=[]`이고 cycle·drift 오류는 없었다. epic 8은 refined=true, gated_by=[], next_id=9이고 8개 모두 planned·file=null이다. 이는 F1처럼 문장 속 미선행을 탐지하는 결과가 아니다.

- 1→17.6은 검색·files show·probe를 포함한 마지막 코드 상태를 받는 조건이며 `에픽:117`에 공유 편집 레인 이유가 있다. 17.7의 설치본/사람 대기를 받지 않는다. 11.6은 설정 port를 주고 그 경로에 11.4의 PG 첨부/추출과 11.5 가리기도 포함된다(`PG계획:56`, `PG계획:68`, `PG계획:80`). 직접 중복 표기는 소비 계약을 드러낸다.
- 1→10.13·9.7은 이미 닫힌 원본 FileStore·추출 세대와 데몬 틱/조립 최종 상태를 받는다(`첨부계획:145`, `데몬계획:95`, `에픽:129`). 단순 표시 순서가 아니다. 다만 epic 9가 로컬 파일 감시 전체를 준다고 해석하지 않는다. `조사:75`가 `[files] path` 감시의 기존 범위 차이를 기록했다.
- 3→12.9는 예약 등록 SDK·명령 계약을 주고 앞 경로의 취소·진행·현지 예약을 받는다(`작업계획:20`, `작업계획:92`, `작업계획:104`). 실질 선행이다. 트리에 12를 더한 것도 타당하다(`트리:100`). 그 needs의 보류 그룹은 12.10에서 생기지만 현재 세트의 disconnect는 source 세대/상태로 자체 차단한다. 보류 그룹을 실제 재사용할 때는 12.10을 명시해야 한다. 현재 17→14→13 의존 경로로 12.10·11도 전이상 선행하므로 시작 차단 누락은 없다.
- 1~8의 한 레인은 공유 port·PG 마이그레이션·조립·검색·명령 등록부 충돌을 설명한다(`에픽:117`, `세트:2`). 공유 fake·PG·홈은 1이 최초 소유하고 나머지가 의존 경로로 받는다. 앞 에픽 entry에 양방향 인계문을 더하지 않는 명시적 예외도 `에픽:117`에 있으므로 다시 수정 요구하지 않는다. 뒤 epic 4는 문서 검색을 소비하고 5는 V1 뒤 백업을 맡는 기존 분담과 충돌하지 않는다.

AD-7의 외부 I/O 동안 트랜잭션 금지는 `에픽:51`에, AD-23의 brain 루트/소유 제한과 검증 없는 삭제 금지는 `에픽:49`, `에픽:50`, `세트:8`·`세트:9`에 있다. AD-24의 세대 포인터와 locator/page 사본은 2·4가 재사용한다. AD-18의 세 곳 설정 분리는 3, AD-11의 기존 코덱·probe 확장은 6, AD-27의 공통 예약/데몬 경로는 3·5, 데몬 없는 시험은 7이 맡는다. F2의 계약 동기화를 제외하면 별도 검색/가리기 경로를 만들라는 요구는 없다.

## 위임·개인 데이터·남은 일

`이니셔티브:187`~`이니셔티브:193`, `에픽:118`, `장부:85`대로 모든 entry의 hitl=false는 명시적 위임에 맞다. 사람 몫은 Drive OAuth client 준비·동의 화면·키 입력·실제 동의이며, 에이전트는 suite·설치본·안내·동의 이후 실행을 한다. 동의가 없으면 8을 성공으로 쓰지 않는 `세트:91`·`세트:92`도 맞다. OAuth Testing 상태 refresh token 7일 Assumption은 3 description이 공식 문서 확인과 안내 수정을 명시한다(`에픽:110`, `세트:32`). 이번에는 네트워크 금지에 따라 사실 자체를 재확인하지 않았다.

기존 locator·매핑·checksum·이전 트랜잭션·scope·토큰·명령·외부 표/changes·이름 전용 결과·추출기/상한/Carry·해제·순서·hitl Decision은 다시 묻지 않는다. 추천 결정 장부의 epic 8 행도 이를 반영한다. 사용자만 결정할 새 항목은 발견하지 않아 ask는 0이다.

토큰/secret은 `.env`, fixture는 합성 값, 실계정은 8, 공개 plan은 단계 상태·건수라는 경계가 있다(`에픽:52`, `에픽:53`, `세트:91`). 일반 출력 마스킹이 실제 파일 이름과 본문의 공개 허가를 뜻하지 않으므로 S3의 경계 확인을 권한다. 이 보고서에는 개인 파일 이름·본문·토큰·절대 홈 경로를 옮기지 않았다.

다음 작업은 F1~F5를 에픽·세트·spine에 반영한 뒤 고위험 변경 부분만 재검증하는 것이다. 이 검토가 쓴 저장소 파일은 이 보고서 하나이며, 다른 워커의 epic 18 파일과 기존 미커밋 초안은 수정하지 않았다.

## 재검증 (2026-10-28)

수정 후 재검증 — F1·F4·F5·S1·S2·S3 해소, F2·F3 부분 해소, 새 fix F6 1건.

위 약칭을 그대로 쓴다. 수정된 에픽 Notes·세트·spine·트리를 현재 작업 파일로 읽고, 변경 없는 epic 17의 커밋된 검색 계획 및 이니셔티브 Decision과 대조했다. 지정된 `validate-checks.md`의 Set·Dependencies와 `ticket.md`의 “Rules the template cannot carry”를 적용했다. leaf가 없는 entry의 검증 접근을 확인한 것이며, 실제 시험 통과를 뜻하지 않는다.

### 기존 지적별 판정

| 지적 | 판정 | 반영 근거와 남은 일 |
| --- | --- | --- |
| F1 | 해소 | `에픽:130`, `세트:8`이 1에 `drive.keep_local_days` 기본 30·0 허용·값 검증·DB 읽기를 배정했다. `세트:20`은 2에 가짜 서버로 실행 가능한 `sources sync`의 CommandSpec·SDK·메타를 배정했다. 3의 나머지 명령·설정 완성(`세트:32`) 및 11.6의 키 등록 제외(`PG계획:80`)와 일치한다. |
| F2 | 부분 해소 | AD-15에 이름 전용 결과의 없는 file_id·locator, source_file_id·상태·원본 URL과 `files.show` 경로가 생겼다(`spine:287`). Drive locator·home 예외·source별 접근 상실은 `spine:384`, `spine:387`, 표의 키·작성자·가변성은 `spine:571`~`spine:573`에 반영됐다. 2의 읽기 경로와 사진 출처 검증도 있다(`세트:20`, `세트:21`). 다만 AD-24는 여전히 `files.source_unreachable_at`만 경고 `FILE_SOURCE_UNREACHABLE`의 근거로 적는다(`spine:402`). 새 source별 접근 상실과 이름 전용 결과의 접근 상태를 그 경고·재추출 금지에 연결하는 규칙이 남았다. source 하나만 접근 상실하고 같은 내용의 다른 원본은 정상인 경우도 구분해 적어야 한다. `에픽:131`의 AD-24 반영 완료 문장과 달리 이번 diff의 backend locator 예는 AD-23에 있고 AD-24는 바뀌지 않았다. |
| F3 | 부분 해소 | due를 재계산해 깨우는 담당은 5로 정해졌고, 실행 때 재확인과 해제 뒤 취소 보존도 있다(`에픽:132`, `세트:56`). 원래 due 이전 청구·기간 증가·동시 변경·취소 비부활을 검증한다(`세트:57`). 다만 3이 아직 없는 5의 기능을 호출하도록 배정한 새 선행 역전은 아래 F6으로 남는다(`세트:32`). |
| F4 | 해소 | 날짜 있는 Notes가 verify와 별도임을 명시하고, 1의 home 확정 전 redact, 2의 프로세스 중단 뒤 타인 임시 파일 보존, 5의 disconnect·만료 삭제 경합을 각각 배정했다(`에픽:133`~`에픽:136`). leaf로 이어받을 의무도 명시했다. |
| F5 | 해소 | sweep은 코드 1~6 정리만 닫고, 뒤의 배포·실계정 확인은 별도 예외이며 기능 실패는 버그 스토리로 고쳐 재검증한다(`에픽:137`, `세트:80`, `세트:83`, `세트:94`). 동의 전·실제 확인 실패를 완료로 세지 않는 경계가 있다(`에픽:137`, `세트:91`, `세트:92`). 이니셔티브의 버그 환류·위임·operator 대기와도 일치한다(`이니셔티브:187`~`이니셔티브:192`). |
| S1 | 해소 | 정상 txt 한 건에 필요한 계약 case·DDL·왕복으로 plan 상한을 두고 OAuth·resumable·오류 행렬·외부 source를 뒤로 남긴다(`에픽:138`). 기존 txt·단순 업로드·0/30일 상한과 epic 17 완료 HEAD 확인도 유지된다(`세트:8`). leaf 정제 때 이 상한으로 한 세션 크기를 다시 확인한다. |
| S2 | 해소 | 공용 fake 시작·종료, 격리 PG·홈, OAuth callback·clock 제어, 대량 할당 없는 합성 PDF·OOXML·상한 fixture, 페이지 commit barrier·kill 대상·재시작 명령을 각 plan의 의무로 명시했다(`에픽:138`). 데몬 없는 handler 시험과 실제 예약 연결 확인의 진입점도 구분했다. 현재 단계에서 실행 명령을 확정하거나 시험 증거를 만들 필요는 없다. |
| S3 | 해소 | URI·code·verifier·client secret·외부 오류 원문을 queue·doctor·로그·plan에서 제외한다(`에픽:138`, `세트:56`). 이름·본문·토큰·URI·오류의 합성 표식 부재를 검증하고(`세트:57`), 실계정 공개 증거는 단계 상태·건수로 제한한다(`세트:91`). 업로드 재개 상태 영속 결정은 유지됐다(`에픽:107`). |

### F6 — 설정 변경 연결의 구현 책임을 5로 옮겨 선행 역전을 없앤다

- 근거: `에픽:132`, `세트:32`, `세트:35`, `세트:47`, `세트:56`, `세트:59`.
- 새 문제: 3의 description은 `brain config set` 경로가 **5의 삭제 예약 재계산을 부르게 연결**하는 일까지 3에 배정한다. 하지만 실제 기능은 5가 만들고 5는 4→3 뒤다. 3을 끝내려면 뒤 스토리의 결과가 필요한 문장으로, Dependencies의 “시작·검증에 필요한 것은 자신 또는 after가 만든다”를 만족하지 않는다. 가짜 함수나 비어 있는 연결 지점으로 3을 끝낼 예외도 적혀 있지 않다. F1의 선행 문제를 고치면서 다른 경로에 같은 문제가 생겼다.
- 바꿀 내용: 순서와 보관 기간 재계산 Decision은 유지한다. 3은 설정 변경의 확장 지점·계약까지만 제공하고, 5가 재계산 구현과 실제 `brain config set` 연결을 함께 완성한다고 담당 문장을 맞춘다. 또는 재계산 최소형 자체를 3으로 옮긴다. 3의 after에 5를 넣어 순환을 만들지 않는다. 5의 원래 due 이전 청구 검증은 그대로 둔다.

### 공통 계약·보드·변경 범위 확인

이름 전용 `files show`는 17의 기존 `file_id + chunk_locator` 경로를 없애는 변경이 아니라 source 출처 입력을 더하는 확장이다(`조회에픽:93`, `조회계획:8`, `에픽:100`, `에픽:113`, `세트:20`, `spine:287`). 따라서 커밋된 17의 분석 리포트 tracer·기존 문서 probe와 충돌하지 않는다. 설정 키의 최초 담당도 11.6이 제공하는 settings port 위의 확장이다(`PG계획:80`, `세트:8`). sweep 예외·실계정 위임은 이니셔티브 Decision을 바꾸지 않는다. 앞 에픽 인계문 예외(`에픽:117`)와 기존 locator·scope·checksum·이전·해제 Decision은 재논의하지 않았다.

앞 절과 같은 offline·임시 cache 방식으로 보드 읽기를 다시 실행해 exit 0을 확인했다. `unpinned_after=[]`, `undeclared_after=[]`, `order_conflict=[]`이고 cycle·drift 오류는 없었다. epic 8은 refined=true·gated_by=[]·next_id=9, 8개 entry 모두 planned·file=null이며 트리의 epic 12 needs도 유지된다(`트리:100`). 이는 F6의 description 속 선행 역전까지 탐지하는 검증은 아니다.

남은 수정은 F2의 source별 접근 불가 경고·재추출 계약 연결과 F6의 담당 문장 정합화다. 이번 재검증은 이 보고서 끝에만 덧붙였다. 테스트·빌드·Docker·네트워크·설치·커밋을 하지 않았고, 개인 데이터와 절대 홈 경로를 기록하지 않았다.

## 재검증 2 (2026-10-28)

통과 — F2 잔여·F3·F6 및 spine u4 R1~R3 해소. 새 지적 없음.

현재 미커밋 entry·Notes와 spine의 AD-15·23·24 및 Table Contract를 정적으로 대조했다. 위 약칭을 유지하고, 아래 `u4리뷰`는 `_bmad-output/personal-brain/architecture-brain-v1-slice-1/reviews/review-gate-2026-10-28-u4.md`다. 지정된 메인 checkout의 `validate-checks.md` Set·Dependencies와 `ticket.md`를 읽기만 했다. 판정은 leaf 없는 entry에서 구현·검증 기준을 도출할 수 있는지에 대한 것으로, 구현이나 실제 시험 통과를 뜻하지 않는다.

| 항목 | 판정 | 반영 근거 |
| --- | --- | --- |
| F2 잔여 | 해소 | `spine:402`가 source 항목의 접근 불가 시각을 본문·이름 전용 결과의 `FILE_SOURCE_UNREACHABLE` 및 해당 출처의 재추출 금지에 연결한다. 정상 source·검증된 Brain 위치의 읽기·재추출은 유지하고, 사용 가능한 원본이 전혀 없을 때만 `files.source_unreachable_at`을 쓰며 복귀하면 해제한다. `에픽:131`, `에픽:139`가 이 계약과 2·5의 담당을 명시하고, `세트:21`은 source 하나만 접근 불가일 때 다른 정상 원본의 공통 필드가 비어 있고 경고가 해당 링크에만 붙는 경우를 검증한다. AD-24 반영 완료라는 Notes도 이제 실제 변경과 맞는다. |
| F3 | 해소 | `에픽:132`, `세트:56`이 기간 변경 시 due 재계산·깨우기와 설정 변경 확장 지점 연결을 모두 5에 배정했다. 실행 때 현재 설정 재확인·해제 뒤 취소 보존도 유지한다. `세트:57`은 30일 예약을 15일째 10일로 줄였을 때 원래 due 전에 청구·삭제되는지, 40일 증가·동시 변경 수렴·취소 비부활까지 검증한다. F6의 선행 역전도 아래와 같이 없어졌다. |
| F6 | 해소 | 3은 설정 키 변경 이벤트 계약과 기본 무동작 확장 지점까지만 만든다(`세트:32`). 5가 그 지점에 실제 재계산을 연결해 `brain config set`이 부르게 한다(`세트:56`, `에픽:132`). 기존 3→4→5 순서(`세트:35`, `세트:47`, `세트:59`)로 자신 또는 선행 결과만 소비하므로 역방향 의존이나 순환을 추가하지 않는다. |
| u4 R1 | 해소 | 지적과 제안(`u4리뷰:26`, `u4리뷰:30`)의 source별 경고·정상 원본 보존·공통 필드의 전체 불가 조건·복귀 해제가 `spine:402`에 반영됐다. `spine:387`의 source별 접근 상실 규칙, `spine:570`의 가변 필드 목록과도 양립한다. 담당은 `에픽:139`의 2·5이고, `세트:20`, `세트:21`의 source 상태 경로·격리 검증과 `세트:56`의 변경·삭제·권한 상실 처리가 이를 받는다. |
| u4 R2 | 해소 | `spine:384`가 Drive FileStore의 넣기·가져오기·확인·URL·삭제 전부를 `(root_folder_id, content_hash)`의 같은 `drive_uploads` 매핑에 묶고 이름 검색 대체를 금지한다. 생성·재개·확정의 단일 저장 함수와 동시 put의 확정 remote id 하나로 수렴하는 규칙도 있다. Table Contract 작성자 역시 이전 일감과 Drive put의 공유 함수로 바뀌었다(`spine:573`). `에픽:139`, `세트:8`이 1에 모든 연산의 매핑 조회·저장 함수 공유를 배정하고 `세트:9`가 재이전 원격 파일 하나·이전 뒤 원문 읽기 및 공통 계약 suite를 검증하므로, `u4리뷰:34`, `u4리뷰:39`의 분리된 remote id 조회 경계가 닫혔다. |
| u4 R3 | 해소 | `spine:287`이 `content_id`로 연결된 가린 파일의 이름·경로·URL을 source 이름 검색과 `files.show(source_file_id)`에서 제외하며, 메타데이터 갱신·재연결·재추출의 우회도 금지한다. `content_id` null을 가린 내용으로 추정하지 않는 경계도 명시했다. 기존 내용 단위 가리기(`spine:392`)와 결합되며, `에픽:139`가 2·6에 배정하고 `세트:68`, `세트:69`가 통합 검색·가린 첨부 및 연결된 Drive 항목의 source 검색·files show 제외를 검증한다. `u4리뷰:41`, `u4리뷰:46`의 우회 경로를 막는다. |

F2의 앞서 해소된 부분도 유지된다. 이름 전용 결과는 `source_file_id`·색인/접근 상태·원본 URL을 싣고 가짜 file_id·locator를 만들지 않는다(`spine:287`, `세트:20`, `세트:21`). 외부 source 내용의 Brain home 예외와 backend별 locator는 `spine:384`, `spine:387`에, 세 표의 키·작성자·가변성은 `spine:571`~`spine:573`에 있다. 6은 2가 만든 source 읽기 경로 위에 첨부·Drive 통합을 완성한다(`세트:68`). 기존 17의 본문 결과와 출력 코덱 probe를 확장하는 분담을 유지한다.

보드는 위 107행과 같은 방식으로 별도 임시 cache와 `UV_OFFLINE=1`을 사용해 다시 읽었고 exit 0이었다. `unpinned_after=[]`, `undeclared_after=[]`, `order_conflict=[]`이고 cycle·drift 오류는 없었다. epic 8은 refined=true·gated_by=[]·next_id=9이며 entry 8개 모두 planned·file=null이다. F6의 문장 속 needs와 인계 책임은 보드 결과에 의존하지 않고 위 표에서 따로 확인했다. 기존 순서·공유 편집 레인·앞 에픽 인계문 예외 Decision은 유지한다.

이번 작업은 이 보고서에 이 절만 덧붙였다. 테스트·빌드·Docker·네트워크·설치·커밋을 하지 않았고, 기록된 Decision을 재논의하지 않았다. 절대 홈 경로는 없으며 다른 파일은 수정하지 않았다. 남은 일은 leaf 정제·구현 때 위 공통 계약과 검증 접근을 이어받는 것이다.
