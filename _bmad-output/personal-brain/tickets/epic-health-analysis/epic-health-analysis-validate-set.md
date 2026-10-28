수정 후 재검증 — fix 6 / suggest 2 / ask 0

# epic 18 스토리 세트 검증

2026-10-28. Ticket · Set · Dependencies와 `ticket.md`의 “Rules the template cannot carry”를 적용한 정적 검토다. leaf 없는 entry 9개의 책임·인계·검증 계획을 판정하며 구현 완료나 실모델 품질을 판정하지 않는다. 테스트·빌드·Docker·네트워크·설치·모델 실행은 하지 않았고 Garmin 계정·tokenstore 내용은 열지 않았다. 보드 조회는 오프라인으로 실행했다.

## 근거 약칭

아래 `약칭:행`은 이 표의 저장소 상대 파일과 실제 행을 뜻한다.

| 약칭 | 파일 |
| --- | --- |
| 에픽 | `_bmad-output/personal-brain/tickets/epic-health-analysis/epic-health-analysis.md` |
| 세트 | `_bmad-output/personal-brain/tickets/epic-health-analysis/tickets/tickets.toml` |
| 조사 | `_bmad-output/personal-brain/tickets/epic-health-analysis/epic-health-analysis-research-code.md` |
| spine | `_bmad-output/personal-brain/architecture-brain-v1-slice-1/architecture-brain-v1-slice-1.md` |
| 이니셔티브 | `_bmad-output/personal-brain/initiative-personal-brain.md` |
| 경계 | `_bmad-output/personal-brain/prep-garmin-absorption/integration-boundaries.md` |
| 작업계획 | `_bmad-output/personal-brain/tickets/epic-jobs-and-scheduler/tickets/tickets.toml` |
| 확장계획 | `_bmad-output/personal-brain/tickets/epic-extensions/tickets/tickets.toml` |
| 이전계획 | `_bmad-output/personal-brain/tickets/epic-garmin-import/tickets/tickets.toml` |
| 채널계획 | `_bmad-output/personal-brain/tickets/epic-channels/tickets/tickets.toml` |
| 수집에픽 | `_bmad-output/personal-brain/tickets/epic-garmin-runtime/epic-garmin-runtime.md` |
| 수집계획 | `_bmad-output/personal-brain/tickets/epic-garmin-runtime/tickets/tickets.toml` |
| 조회에픽 | `_bmad-output/personal-brain/tickets/epic-search-and-health-query/epic-search-and-health-query.md` |
| 장부 | `_bmad-output/personal-brain/decisions-by-recommendation.md` |

검사 규칙은 메인 checkout의 `~/github/second-brain/_bmad/render/bmad-agent-po/second-brain-bbe56f7ddda0/dcffd73a7f031ef42569/references/validate-checks.md`와 같은 폴더 `ticket.md`를 읽었다. gitignore된 렌더 파일은 수정하지 않았다. 직전 형식은 `_bmad-output/personal-brain/tickets/epic-garmin-import/epic-garmin-import-validate-set.md`의 재검증 절까지 참고했다.

## fix

### F1 — 옛 평가 종료 확인 뒤 새 예약을 활성화한다

- 근거: `세트:103`, `세트:104`; `에픽:50`, `에픽:108`; `수집에픽:119`; `수집계획:103`.
- 문제: 9의 현재 순서는 새 11:30 예약 등록 → 옛 LaunchAgent bootout → 수동 평가다. 예약 시각을 넘기면 옛 report가 살아 있는 동안 새 평가가 청구될 수 있다. label 부재만으로 이미 떠 있는 옛 평가 프로세스 종료를 입증할 수도 없다. 수집 쪽 최신 Handoff는 18.9가 중지·진행 평가 종료를 확인한 뒤 새 예약을 켠다고 명시해 두 쪽 인계도 다르다.
- 바꿀 내용: 9에 새 분석 예약·청구를 보류한 상태에서 설치·설정을 하고, 16.9의 전환 상태를 읽어 옛 report label 부재와 진행 평가 프로세스 종료를 확인한 뒤 새 예약을 활성화한다고 적는다. 종료 불명은 전환 중단이고 실평가 성공으로 세지 않는다. verify에는 보류 중 예약 시각을 넘어도 새 모델 호출 0, 옛 종료 확인 후 활성화, 복구 시 새 진행 평가 종료 확인 후 옛 plist load를 추가한다. 기존 “동시에 켜지 않음” 결정을 실행 가능하게 하는 보완이며 전환 정책을 다시 묻는 일이 아니다.

### F2 — 모델 입력·도구·파일 접근과 진단 출력의 보호를 검증에 배정한다

- 근거: `에픽:44`, `에픽:45`, `에픽:58`; `세트:8`, `세트:9`, `세트:44`, `세트:45`; `조사:73`, `조사:77`, `조사:79`; `spine:221`, `spine:510`, `spine:536`.
- 문제: E18-5는 모델에게 export와 scratch만 보이고 보존 원문·다른 홈 파일은 보이지 않는다고 요구한다. 현재 1은 export 문자열 가리기, 4는 env의 DB URL·API 키 부재만 검사한다. cwd를 scratch로 바꾸거나 env를 제거해도 도구가 홈의 `.env`·보존 파일을 읽는 길을 막았다는 증거가 되지 않는다. 도구 응답 코덱, 로그·stderr·실패 진단에 분석 본문/건강값/계정이 남지 않는 검증 주인도 없다. 일반 비밀 패턴은 개인 건강값을 모두 가리지 않는다.
- 바꿀 내용: 에픽 Notes에 1의 최소 export 가리기와 4의 두 adapter 실행 port 접근 제한·도구 응답 가리기·진단 정책 완성의 분담을 적고 해당 verify에 연결한다. 격리 홈에 합성 DB 비밀·계정·건강값·보존 본문 표식을 심어 정상 및 실패 CLI가 env/파일/도구를 통해 접근을 시도하도록 하고, 허용된 export·scratch 외 읽기가 거부되는지 확인한다. 모델에 필요한 CLI 인증 접근은 런타임 경계에서 구분하되 DB 비밀·다른 홈 자료를 노출하지 않는 수단을 plan에 적는다. 프로세스 raw stdout/stderr·출력 JSON은 공개 로그/plan에 복사하지 않고 허용 칸의 상태 투영만 남기는 계약과 합성 표식 부재 검증도 배정한다. 로그인 방식·가리기 정책을 재결정하라는 뜻은 아니다.

### F3 — 긴 평가 중 대화 수집 진행을 완료 조건으로 검증한다

- 근거: `에픽:64`; `세트:33`, `세트:45`, `세트:81`; `조사:165`; `작업계획:80`; `spine:503`.
- 문제: Done when 3의 절반인 “긴 평가 중에도 대화 수집이 진행”은 어느 verify에도 없다. 프로세스 그룹 정리나 순서 시험만 통과해도 모델 대기가 데몬의 수집/drain을 막는 잘못된 구현이 남을 수 있다.
- 바꿀 내용: 4의 verify에 실제 감독자가 fake 모델을 동기화 지점에서 대기시키는 동안 별도 합성 세션 수집/spool drain을 실행해 새 메시지 확정이 모델 해제 전에 관찰되는 시험을 추가한다. 대기·수집 완료·모델 해제의 관찰 순서와 정리 방법을 plan에 적는다. 12.7의 일반 용량 시험을 다시 만드는 대신 실제 Core 모델 port·adapter 조립에서 병행이 유지되는지를 확인한다.

### F4 — 20분 timeout과 25분 정체 시험의 설정을 분리한다

- 근거: `세트:44`, `세트:45`; `에픽:44`; `작업계획:56`, `작업계획:57`; `조사:88`, `조사:99`.
- 문제: 기본 호출 timeout 20분인 같은 모델 호출은 진행 없이 25분에 도달하기 전에 timeout으로 끝난다. 현 verify의 “20분 넘으면 timeout, 진행 없이 25분이면 정체”만으로는 비작성자가 두 기대 결과를 재현할 수 없다. 단순 가짜 프로세스 시험만으로 실제 OS 자식·손자 reap까지 입증했다고 혼동할 여지도 있다.
- 바꿀 내용: 기본 20분 timeout 사례와 `analysis.timeout_minutes`를 25분보다 크게 둔 무진행 사례를 분리한다. 후자는 heartbeat만 보내도 25분에 `stalled`가 되고, 진행 이벤트는 정체 창을 갱신한다고 명시한다. 12.1 timer/가짜 clock으로 시간을 전진시키되 실제 자식·손자 생성·TERM 무시·그룹 종료·reap는 OS 프로세스로 확인하도록 plan 입력과 관찰값을 적는다. 20분/25분 상수나 사용자 기본값을 바꾸는 제안은 아니다.

### F5 — high-risk entry마다 기준 외 추가 확인을 Notes에 둔다

- 근거: `세트:13`, `세트:25`, `세트:37`, `세트:49`, `세트:108`; `에픽:112`, `에픽:113`, `에픽:114`, `에픽:115`, `에픽:116`, `에픽:121`; 검사 규칙 `ticket.md`, “Rules the template cannot carry”.
- 문제: high인 1·2·3·4·9의 위험 이유는 있지만 Notes에 verify 외 추가 확인을 지정하지 않았다. 기준 외 확인이 필요한 high-risk 규칙을 충족하지 않는다.
- 바꿀 내용: 에픽 Notes에 각 번호의 추가 확인 하나와 leaf로 이어받을 책임을 기록한다. 예: 1은 배포 산출물의 v1 리소스 발견, 2는 reader 작성자와 독립된 cutoff/선행 선택 기대값 대조, 3은 장부의 이전 analysis·파일 관계 불변 별도 점검, 4는 정상 리더 종료 뒤 남은 자손 처리 경계 별도 검토, 9는 공개 plan·로그에 개인 데이터 부재 별도 점검이다. 기존 verify를 그대로 반복한 항목을 추가 확인으로 세지 않는다.

### F6 — sweep 뒤 배포·전환의 예외와 실패 환류를 명시한다

- 근거: `세트:92`, `세트:95`, `세트:103`, `세트:106`; `에픽:109`; `수집에픽:126`; 검사 규칙 `validate-checks.md`, Set의 Refactor sweep.
- 문제: 8은 1~7만 기다리고 9는 운영 설치·예약 전환까지 수행하므로 규칙이 자동 허용한 마지막 end-to-end suite보다 넓다. 순서 Decision은 있으나 sweep이 코드 정리만 닫고 그 뒤 운영 전환을 둔다는 예외와 9 실패의 버그 환류가 명시되지 않았다.
- 바꿀 내용: 앞 에픽과 같은 날짜 있는 Decision으로 8은 코드 1~7 cleanup만 닫고, 9의 배포·전환·실평가는 뒤에 별도로 둔다고 적는다. 9의 기능 문제는 버그 스토리로 고치고 8로 밀어 넣지 않는다. 로그인·미실행·모델 실패를 실평가 성공으로 세지 않고 9의 확인이 끝날 때까지 에픽 Done when 5·6 완료를 주장하지 않는다고 명시한다. 이미 정한 8→9 순서는 유지한다.

## suggest

### S1 — body_intake를 실제로 만드는 진입점과 artifacts의 재처리 순서를 고정한다

- 근거: `세트:56`, `세트:57`, `세트:80`; `에픽:49`, `에픽:105`; `수집계획:56`; `수집에픽:118`.
- 문제: 5는 body_intake 일감을 “돌리면” JSON이 생긴다고 하고 7은 보류 그룹만 붙인다. 사진 도착을 누가 발견해 일감을 넣는지, 16.5 artifacts가 이미 끝난 뒤 JSON이 도착하면 어느 실행에서 병합하는지는 구체화되지 않았다. job handler만 만들어 자동 사용 흐름에서 한 번도 실행되지 않는 위험이 있다.
- 제안: 5의 정제 Notes/plan에서 최초 enqueue 소유와 재시도·동일 사진 합침을 정하고 7이 소비한다고 적는다. 추천은 core가 사진을 발견해 body_intake를 enqueue하고 검증 JSON 확정 뒤 16.5의 동일 입력 재처리 경로로 인계하는 것이다. 수집/정제에 모델을 넣거나 artifacts→분석→intake→artifacts의 순환 의존을 만들지 않는다. 선택한 흐름은 에픽 Notes와 추천 장부에 남기고 JSON 실패/pending이 다른 사진과 수집을 막지 않는지 검증한다. 이미 정한 core intake 소유·JSON 자리·병합 소유는 그대로다.

### S2 — crash hook과 durable 모델 결과의 경계를 정제 plan에 명시한다

- 근거: `세트:8`, `세트:32`, `세트:33`; `에픽:46`; `조사:117`, `조사:164`.
- 문제: 3 description은 확정 직전·직후·파일 등록 중 crash에서도 재호출하지 않는다고 하지만 verify의 kill은 7d 확정 직후 하나뿐이다. 검증한 모델 출력이 DB 확정 전에 어디에 남는지와 어떤 프로세스를 어느 경계에서 죽이는지에 따라 “모델을 다시 부르지 않음”의 실제 범위가 달라진다.
- 제안: 검증 출력의 durable checkpoint, FileStore put 뒤, 파일/analysis 관계 확정 직전·직후, 다음 scope 해제 직전·직후를 동기화한 hook과 재시작 관찰값으로 plan에 고정한다. checkpoint 이전 중단과 검증 결과 보존 이후 중단을 구분하고 후자에서만 호출 수 불변을 주장한다. 2의 SQLite 비교 runner, 4의 두 fake CLI/실제 OS fixture, 6의 가짜 Telegram 서버도 공통으로 명령·사전 조건·관찰·정리를 남긴다는 1의 약속을 이어받는다. 아직 leaf 없는 초안에 시험 이름이나 실행 완료 증거를 요구하지 않는다.

## coverage · tracer · Done when

| Requirement | 스토리 분담 |
| --- | --- |
| E18-1 | 2: snapshot manifest/바이트, 현재 view pivot·raw scrub·선행 선택·옛 SQLite 대조 완성 |
| E18-2 | 1: 단일 day 정상 확정. 3: 네 scope 의존·실패·재개·오래된 attempt 거부·새 revision |
| E18-3 | 1: analyses 최소 호환 확장. 3: 나머지 확장/선행 관계·불변·재생성 완성 |
| E18-4 | 1: Core port와 Codex 최소형/agent 기본. 4: 두 adapter·전체 설정·usage·오류·정리. 9: 설치본 설정·실행 확인 |
| E18-5 | 1: daily v1 리소스·export 가리기 최소형. 3: period 리소스. 4: Claude wrapper. 실행 경계·도구·로그 검증은 F2 보완 |
| E18-6 | 1: core FileStore 등록·관계·추출. 3: 파일 crash 수렴 완성(S2의 경계 구체화 권고) |
| E18-7 | 6: 요약·앨범·전문·의미 키·실패 알림·발신 실패 격리 |
| E18-8 | 7: 공통 예약·수집 성공 의존·놓친 날·수동 합침·끄기/재개. 9: 운영 예약 등록/전환 |
| E18-9 | 5: core 모델 사진→측정 JSON·원자적 쓰기·pending 재시도 |
| E18-10 | 9: 플러그인 설치본·옛 예약 중단·실평가 형식 검증. F1 보완 필요 |

E18-1~10의 covers 누락과 잘못된 id는 없다(`세트:10`, `세트:22`, `세트:34`, `세트:46`, `세트:58`, `세트:70`, `세트:82`, `세트:105`). E18-5·6의 3 담당은 description에도 있고 covers 유무만으로 빠졌다고 판단하지 않았다. 공유 id의 최소형/완성/설치본 확인이 구별된다. `analyses` 전체 metadata는 E18-3이 권위이며 3의 “끝낸다”를 최소 칸만 남기는 허용으로 읽지 않는다. leaf 없음·refine=false인 entry에 지금 full criteria를 강제하지 않는다. 명시된 unknown은 없고 이미 해소된 Source conflict는 다시 gate로 만들지 않는다.

1은 합성 snapshot 하나·day 하나·정상 경로 하나로 제한한다(`세트:8`; `에픽:109`; `조사:155`). 입력 생성, 기간 평가, 두 adapter 완성, intake, 채널, 예약을 뒤로 뺐으므로 수직 경로의 범위는 타당하다. 감독·Core port·schema·PG·파일·추출을 처음 잇는 한 세션 위험은 남지만 이미 scope 상한과 시험 기반의 최초 소유가 있다. setup은 에이전트가 하므로 hitl=false가 위임과 맞고 사용자 starter를 추가할 근거가 없다. 다음 2가 가장 덜 확실한 입력 동등성인 것도 적절하다. 8은 covers=[] cleanup 전용이다.

| Done when | 배정과 제한 |
| --- | --- |
| 1 | 2의 동일 fixture/clock/cutoff·옛 SQLite reader 대조. ambiguity/복수 dataset은 별도 새 계약 시험 |
| 2 | 1·3의 즉시 확정·재개·revision·이전 분석 불변. S2의 crash 경계를 정제 때 고정 |
| 3 | 4의 그룹 취소·손자/reap. F3의 대화 수집 병행, F4의 시간 설정 보완 필요 |
| 4 | 6과 15.4의 항목별 재개·의미 키 gate·평가 보존. 외부 응답 유실의 exactly-once 보장을 뜻하지 않음 |
| 5 | 7의 예약/수집 의존, 9의 실계정 형식·순서·저장 확인. 로그인 미완료는 awaiting-operator |
| 6 | 9의 앞선 app-ref commit/version 동반 갱신·설치본 확인. F1의 안전한 활성화와 F6의 완료 경계 필요 |

## Dependencies · 보드 · 인계

보드는 다음 명령을 오프라인 실행해 exit 0으로 읽었다. uv 의존성 설치나 네트워크 접근은 없었다.

```sh
UV_CACHE_DIR=/tmp/epic18-validate-uv UV_OFFLINE=1 uv run ~/.agents/skills/bmad-agent-po/scripts/tickets.py --project-root "$(git rev-parse --show-toplevel)" status _bmad-output/personal-brain
```

`unpinned_after=[]`, `undeclared_after=[]`, `order_conflict=[]`이고 cycle·drift 오류는 없었다. epic 18은 refined=true, gated_by=[], next_id=10이며 9개 entry 모두 planned·file=null이다. 보드의 통과는 내용상 누락 F1~F6을 대신하지 않는다.

| after | 실제 받는 산출물과 판단 |
| --- | --- |
| 1 → 16.8 | 16의 마지막 코드/sweep 뒤 core 마이그레이션 번호·Store·조립 확정 HEAD. 같은 파일 충돌을 피하는 명시적 결정(`에픽:110`; `세트:8`) |
| 1 → 14.5 | analyses 최소형·legacy/파일 관계·core 파일 등록/추출 계약(`이전계획:56`, `이전계획:57`). 단순 순서 아님 |
| 1 → 12.4 | 감독자/현재 attempt는 12.1~3, ABI usage는 12.4(`작업계획:44`). 실제 port/감독 조립의 선행 |
| 2 → 16.5 | digest 건강 요약·전체 JSON·수집 결과/cutoff metadata(`수집계획:56`). 16.8을 통한 전이 선행과 중복되지만 소비 산출물을 정확히 가리킴 |
| 3 → 12.6 | 그래프 일괄 enqueue·선행 성공/실패 전파 use case(`작업계획:68`) |
| 4 → 12.5 | 모델 25분 무진행 창·stalled/died/failures/doctor(`작업계획:56`) |
| 5 → 16.5 | 측정 JSON 소비·필드 mtime 병합·원본 등록(`수집계획:56`). 양쪽 Notes와 entry가 같은 계약을 가리킴 |
| 6 → 15.4 · 16.6 | 항목별 묶음 요청/가짜 서버·확정 그래프 file_id/역할 metadata(`채널계획:44`, `채널계획:45`; `수집계획:68`) |
| 7 → 12.8 · 12.10 | 현지 예약·놓친 날 규칙·보류 그룹. 7의 description/verify가 실제 소비(`세트:80`, `세트:81`, `에픽:99`) |

1~9의 한 줄은 공유 코드·PG migration·조립·코덱 등록부 충돌을 설명하는 날짜 있는 Decision이다(`에픽:110`; `세트:2`). 공유 시험 setup 최초 소유가 1이고 후속 모두 1을 기다린다. 14.5→14.4→14.3→14.2→14.1 경로로 catalog/현재 view와 11.4 FileStore도 선행한다. 14.1이 15.6·13.3·13.4·12.3을 기다리고 13.1이 12.11을 기다리므로 앞 기반을 없는 것으로 가정하지 않았다(`이전계획:11`; `확장계획:11`). 이미 전이 선행인 after를 단순 중복이라는 이유로 제거할 필요는 없다.

Dependencies의 양쪽 description 규칙에 대해 앞 에픽 12~16 entry를 더 고치지 않고 받는 쪽에 적는 예외는 `에픽:110`에 있다. 새 후속 인계는 `에픽:122`와 `수집에픽:118`, `수집에픽:119`를 대조했다. digest 전체 JSON·UTC cutoff·현지 날짜/시간대·수집 결과 id·revision, 그래프 역할·file_id, body_intake JSON은 맞는다. 옛 report 전환은 F1대로 18 entry를 맞춰야 한다. 17은 14.5 파일 관계와 현재 추출 세대를 질의하므로 18이 core 등록한 새 파일도 검색한다(`조회에픽:19`, `조회에픽:44`, `조회에픽:89`; `세트:9`). 18→17 데이터 의존을 새로 만들 이유는 없으며 공유 migration/코덱 충돌의 예외도 이니셔티브에 있다(`이니셔티브:184`).

## spine · 위임 · 개인 데이터

AD-7의 짧은 트랜잭션/외부 I/O 분리, AD-23의 core 직접 FileStore, AD-32의 analyses 불변·재생성 새 행, AD-35의 core 평가·일감 의존·발신 분리는 에픽과 1·3·6에 반영됐다(`에픽:42`, `에픽:43`, `에픽:46`, `에픽:55`; `spine:496`, `spine:530`, `spine:534`, `spine:582`, `spine:584`). 확장용 file_requests를 새 core 리포트에 강제하지 않는 결정은 정합하다. AD-33의 감독자 전용 청구·현재 attempt·취소/reap는 1·3·4가 받되 F4의 시험 설정을 보완한다. AD-11은 F2대로 입력 export 외 도구/진단 경계까지 검증해야 한다.

AD-18 설정은 analysis.agent/model/effort/timeout_minutes와 profile_path Decision을 따른다(`에픽:103`; `장부:46`). AD-29·30의 확장 digest/그래프 소유와 core 계약 소비도 유지한다. Table Contract의 analyses core writer와 확장 file_requests 구분은 `spine:582`, `spine:584`에 맞는다. Deferred의 prompt/schema는 이미 v1 재사용으로 해소됐다(`spine:778`). 코드 조사의 Claude 인자/usage “후보” 표현은 과거 조사 결과이며 뒤의 에픽 Decision과 4의 설치 버전 fixture 확보 약속이 현재 계약이다(`조사:93`, `조사:95`; `에픽:106`; `세트:44`). 재질문할 새 증거는 없다.

9의 hitl=false는 명시적 위임에 맞다(`이니셔티브:188`, `이니셔티브:189`, `이니셔티브:192`; `에픽:111`). Codex 로그인 파일 존재를 실호출 성공으로 세지 않고, 로그인 문제는 operator_actions/awaiting-operator로 남긴다(`세트:104`; `조사:170`). 실평가 성공을 조건문으로 보고할 수는 있어도 미실행/실패를 Done when 충족으로 세면 안 된다(F6). 모델 품질 판단은 사람 몫으로 남아 있고 공개 plan에는 scope별 상태·건수·usage 유무·발신 상태만 허용한다(`세트:103`; `장부:71`, `장부:73`). 실데이터를 합성 fixture로 옮길 근거도 없다. F2를 보완하면 모델 env 외 파일/도구와 실패 로그 경로의 개인 데이터 보호까지 입증할 수 있다.

입력 snapshot·평가 순서·설정 키·파일 직접 등록·intake 소유·Claude 인자·앨범/의미 키·전환·순서·hitl의 기록된 Decision을 재개하지 않았다. ask는 0이다. 이 작업의 저장소 쓰기는 이 보고서 하나이며 에픽·세트·spine·추천 장부·다른 워커 보고서는 고치지 않았다. 커밋하지 않았다.


## 재검증 (2026-10-28)

수정 후 재검증 — F1·F3~F6 및 epic 16 재검증 F6 해소, F2·S1 부분 해소, S2 해소; 새 fix F7 1건.

수정된 Notes와 entry 3·4·5·9, spine AD-18·Table Contract의 diff, 추천 장부를 Set·Dependencies와 high-risk 추가 확인 규칙으로 다시 대조했다. 근거는 위 약칭 표의 `파일:행`을 따른다. 아래 판정은 계획의 정적 재검증이며, 구현이나 실모델 동작의 통과 증거가 아니다.

| 지적 | 판정 | 근거와 확인 결과 |
| --- | --- | --- |
| F1 | 해소 | `에픽:123`, `세트:103`, `세트:104`. 새 예약·청구 보류 → 16.9 상태 수신 → 옛 report 등록 부재와 진행 평가 종료 확인 → 예약 활성화로 맞췄다. 종료 불명은 중단이며 보류 중 시각을 넘겨도 호출 0을 확인한다. 복구도 새 평가 종료 확인 후 옛 plist 복원이다. |
| F2 | 부분 해소 | `에픽:124`, `세트:44`, `세트:45`, `세트:103`, `세트:104`. 1/4의 분담, 두 adapter 접근 제한, 도구 응답 코덱, private 원 출력과 허용 목록 진단 정책은 배정됐다. 다만 4의 verify는 fake CLI에 **넘긴** argv·env·파일 및 출력의 표식 부재를 확인할 뿐, 정상/실패 CLI가 허용 밖 파일·도구 읽기를 실제 시도해 거부되는 관찰은 없다. 9의 실제 모델 표식 시험도 설치본의 선택된 agent 한 번이라 두 adapter의 거부 행렬을 대신하지 못한다. 남은 보완은 아래에 적는다. |
| F3 | 해소 | `에픽:125`, `세트:45`. 실제 감독자의 fake 모델을 동기화 지점에서 대기시키고, 별도 합성 세션 수집·spool drain의 메시지 확정이 모델 해제보다 먼저 관찰되도록 했다. 일반 용량 시험과 구별되는 조립 검증이다. |
| F4 | 해소 | `에픽:125`, `세트:45`. 기본 20분 timeout과 timeout >25분인 무진행 사례를 나눴다. heartbeat만 있으면 stalled, 진행 이벤트는 창 갱신이며, 가짜 clock과 실제 OS 자식·손자의 TERM 무시·그룹 종료·reap를 구별한다. |
| F5 | 해소 | `에픽:126`, `에픽:127`, `에픽:128`, `에픽:129`, `에픽:130`, `에픽:131`. high 1·2·3·4·9마다 별도 확인과 leaf 승계를 지정했다. 배포 리소스, 독립 cutoff 계산, 이전 analysis·파일 관계 보존 별도 점검, 정상 리더 종료 뒤 자손 경계, 공개 증거의 개인 데이터 부재를 담당한다. |
| F6 | 해소 | `에픽:132`, `세트:92`, `세트:95`, `세트:106`. 8은 코드 1~7 cleanup만 마감하고 운영 전환·실평가 9는 뒤에 두는 명시적 예외다. 기능 문제는 버그로 환류하고 로그인·미실행·모델 실패를 성공으로 세지 않으며 9 이전 Done when 5·6 완료를 주장하지 않는다. |
| S1 | 부분 해소 | `에픽:133`, `세트:56`, `세트:57`, `장부:61`. 최초 진입은 core의 10:45 현지 예약/수동 실행, 발견은 JSON 없는 사진 스캔으로 정했다. 사진별 pending·재시도·중복 방지와 다른 사진/수집 진행도 명시했다. artifacts 이후 들어온 사진을 다음 날 처리하는 결정은 존중한다. 다만 먼저 시작한 intake의 JSON 확정이 그날 artifacts보다 늦는 경우는 정해지지 않았고, 시각만으로 당일 병합을 보장하는 새 문장은 F7과 충돌한다. |
| S2 | 해소 | `에픽:134`, `세트:33`. durable checkpoint 전 중단은 재호출 가능, 이후 중단만 호출 수 불변으로 한정했다. checkpoint·FileStore·관계 확정·다음 scope 해제의 hook과 재시작 관찰을 plan에 배정하고, SQLite runner·두 fake CLI/OS fixture·가짜 Telegram의 명령·사전 조건·관찰·정리도 이어받는다. `세트:32`의 포괄적 재호출 금지는 이 최신 Decision과 구체 verify의 범위로 읽는다. |
| epic 16 재검증 F6 | 해소 | `수집에픽:119`, `에픽:123`, `세트:103`, `세트:104`. 생산자의 중지·진행 평가 종료 확인 뒤 활성화 약속과 소비 18.9의 순서·검증·복구가 일치한다. 16.9 전체를 새 코드 gate로 추가하지 않고 실제 전환 상태를 받는 기존 운영 경계를 유지한다. |

### F2 잔여 — 전달 자료의 표식 부재와 읽기 거부를 구별한다

- 근거: `에픽:45`, `에픽:124`; `세트:44`, `세트:45`, `세트:104`.
- 정상/실패 실행에서 env·전달 파일·진단의 표식이 없다는 사실만으로, 프로세스가 알려진 외부 경로를 직접 읽거나 도구로 우회할 수 없음을 확인할 수는 없다. fake CLI에 sandbox/권한 인자가 전달되는지도 현재 verify의 명시적 관찰이 아니다. 특정 CLI 옵션의 보장 범위를 여기서 추측하거나 네트워크로 조사하지 않았다.
- 4의 정제 plan/verify에 두 adapter별로 격리 홈의 허용 밖 표식 파일을 읽으려는 실행·도구 시도와 거부 결과를 배정하고, fake CLI의 인자 검증이 보장하는 범위와 실제 제한 경계 검증을 구별한다. CLI 로그인은 허용하되 DB 비밀·보존 원문은 차단한다는 기존 결정을 유지하며, 구현 전인 지금 시험 통과 증거를 요구하지 않는다. 9의 선택된 실모델 한 번 확인은 그 위의 설치본 점검으로 남긴다.

### F7 — 10:45 발화만으로 당일 artifacts보다 JSON 확정이 빠르다고 보장하지 않는다

- 근거: `에픽:44`, `에픽:133`; `세트:56`, `세트:57`; `수집계획:32`, `수집계획:56`; `장부:61`.
- 새 문장은 10:45 intake → 11:00 수집 → artifacts이므로 그날 새 JSON을 읽는다고 설명하고, 5의 verify도 artifacts 전에 돈다고 기대한다. 그러나 모델 한 호출의 기본 timeout은 20분이고 사진은 여러 장일 수 있다. 10:45에 시작해도 11:00 수집과 artifacts가 먼저 끝날 수 있다. 16.5의 runtime 선행은 collect이며 intake 완료가 아니다. 원자적 rename은 부분 JSON을 막지만 이 실행 순서를 보장하지 않는다.
- 예약·수동 실행이라는 기록된 선택은 유지한다. intake가 artifacts의 읽기 경계를 넘겨 완료됐을 때 JSON/원본을 다음 실행까지 어떻게 남겨 병합하는지, 또는 완료된 JSON에 대한 별도 재처리를 누가 넣는지 정제 입력에 명시하고 양쪽 인계·verify를 맞춘다. 이미 선택한 다음 날 처리 정책을 이 경우까지 명확히 적용하는 것으로 해결할 수 있다. 합성 모델을 읽기 경계 뒤까지 대기시켜 당일 snapshot 처리와 후속 병합·중복 방지를 관찰하도록 한다. 수집 전체를 모델에 종속시키거나 artifacts → 분석 → intake → artifacts 순환을 추가하라는 요구가 아니다.

### 공통 계약·의존·보드 재확인

- `spine:320`, `수집에픽:97`, `장부:38`은 tokenstore 예외를 함께 반영했다. AD-18의 경로만 snapshot·login/dump만 내용 접근이라는 기존 결정을 확대하지 않는다. `spine:563`의 part 키 갱신은 조회에픽 소유이며 분석 파일의 호환 관계와 충돌하지 않는다.
- `수집에픽:118`, `수집에픽:119`, `에픽:122`, `수집계획:56`, `수집계획:68`의 digest JSON·cutoff·수집 결과 id·그래프 역할과 18.2/18.6의 소비가 맞는다. 18.7의 collect/artifacts 의존 생성 책임도 유지된다. `작업계획:116`, `작업계획:117`의 보류·새 청구 차단을 18.9가 소비한다. F7 외 새 spine·앞 에픽 인계 모순은 발견하지 않았다.
- `이니셔티브:184`, `이니셔티브:187`, `이니셔티브:189`의 17/18 공유 파일 예외·sweep 뒤 운영 확인·에이전트 위임을 다시 열지 않았다. 장부의 전환 요약(`장부:51`)은 상세 순서를 정한 최신 `에픽:123`으로 구체화된다.
- 지정 보드를 `UV_CACHE_DIR=/tmp/epic1718-revalidate-uv UV_OFFLINE=1`로 읽어 exit 0을 확인했다(설치·네트워크 없음). 18의 9개 entry와 17의 7개 entry 모두 state=planned·file=null·hitl=false이며 `unpinned_after=[]`, `undeclared_after=[]`, `order_conflict=[]`; cycle 오류·drift 표시는 없다. 이 보드는 F2/F7의 검증 의미와 런타임 인계 순서를 대신 판정하지 않는다.
- 이 재검증 작업은 지정된 두 보고서에 절만 덧붙였다. 테스트·빌드·Docker·네트워크·설치·커밋은 하지 않았다. 절대 홈 경로 검사에서 두 보고서 모두 일치가 없었다.

## 재검증 2 (2026-10-28)

통과 — F2 잔여·S1·F7 해소. 이번 범위에서 새 지적 없음.

메인 checkout의 `validate-checks.md` Set·Dependencies와 `ticket.md`를 읽고, 최신 에픽 Decision, entry 4·5·9, epic 16 수신 Handoff를 정적으로 대조했다. 근거의 `약칭:행`은 위 「근거 약칭」 표의 저장소 상대 파일을 가리킨다. 판정은 구현자가 검증 계획을 작성할 수 있도록 책임·관찰·인계가 배정됐다는 뜻이며, 구현이나 실제 CLI 격리의 동작 통과를 뜻하지 않는다.

| 지적 | 판정 | 근거와 확인 결과 |
| --- | --- | --- |
| F2 잔여 | 해소 | `에픽:135`, `세트:44`, `세트:45`, `세트:103`, `세트:104`. 18.4는 두 adapter의 sandbox·도구 허용 인자 전달과 adapter가 중개하는 도구의 scratch 밖 읽기 요청 거부를 확인한다. fake 시험의 보장은 인자 전달까지라고 명시해 CLI 자체 격리의 입증과 구별했다. 실제 CLI의 읽기 거부는 18.9가 설치본의 로그인된 CLI마다 외부 합성 표식 파일 읽기를 시도해 확인하며, 없는 CLI는 미확인으로 남기고 성공으로 세지 않는다. 정상·실패 fixture의 표식 비노출·진단 확인도 유지된다. 최신 Decision으로 시험 책임이 명확해졌고, 지금 실제 시험 결과를 요구하거나 CLI 옵션의 보장 범위를 추정하지 않는다. |
| S1 | 해소 | `에픽:133`, `에픽:136`, `세트:56`, `세트:57`. 최초 진입은 10:45 현지 예약 또는 수동 실행이고, 측정 JSON이 없는 사진을 찾아 처리한다. 실패는 사진별 pending·재시도이고, 기존 JSON의 중복 생성과 다른 사진·수집 차단을 막는 검증이 있다. 늦게 넣은 사진의 다음 날 처리 결정에 더해, 먼저 시작했으나 늦게 끝난 intake도 다음 artifacts 실행에서 병합하도록 최신 Decision이 구체화했다. 10:45를 완료 순서 보장으로 읽지 않는다. |
| F7 | 해소 | `에픽:136`, `세트:57`, `수집에픽:128`, `수집계획:56`, `수집계획:57`. 읽기 경계 뒤 확정된 JSON은 inbox에 남기고 다음 날 예약 또는 수동 artifacts 실행에서 처리한다. 수신 16.5도 날짜 대신 미병합 측정을 읽어 한 번만 병합한다고 명시했다. 18.5 verify는 fake 모델을 당일 artifacts 읽기 경계 뒤까지 대기시켜 당일 snapshot의 해당 측정 부재와 다음 실행의 단일 병합을 관찰한다. 기존 16.5의 공통 JSON 소비·재실행 중복 방지와 맞으며, intake가 artifacts를 다시 넣거나 수집이 모델 완료를 기다리는 의존은 추가하지 않는다. |

`에픽:133`과 장부의 앞선 “그날 artifacts가 새 JSON을 읽음” 요약은 `에픽:136`의 읽기 경계·다음 실행 규칙으로 구체화된다. 새 증거 없이 기존 예약·수동 실행·다음 날 처리·adapter 분담 Decision을 재논의하지 않았다. 18.4 → 18.5 → 18.9의 기존 선행 경로와 18.5의 16.5 소비 관계는 유지되며, 수신 쪽 entry를 추가 수정하지 않는 기존 예외(`에픽:110`)와 수신 Handoff를 함께 적용했다. 이번 변경에서 새 선행 누락·충돌·인계 모순은 발견하지 않았다. 보드 명령은 재실행하지 않았으며 앞 재검증의 보드 관찰을 새 실행 결과로 주장하지 않는다.

이번 작업은 이 보고서 끝에 이 절만 덧붙였다. 테스트·빌드·Docker·네트워크·설치·커밋은 하지 않았다. 보고서 전체의 절대 홈 경로 검사에서 일치가 없음을 확인했다.
