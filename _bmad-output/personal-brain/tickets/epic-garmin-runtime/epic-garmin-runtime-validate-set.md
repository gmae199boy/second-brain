수정 후 재검증 — fix 5 / suggest 3 / ask 0

# epic 16 스토리 세트 검증

2026-10-28. refined=true 에픽과 leaf 파일이 없는 9개 entry에 Ticket·Set·Dependencies 및 ticket.md의 “Rules the template cannot carry”를 적용했다. 정적 계획 검증이며 구현 완료 판정이 아니다. 테스트·빌드·Docker·네트워크·설치·Garmin 계정 호출·tokenstore 내용 열람·커밋은 하지 않았다. 보드 조회만 실행했다.

근거 약칭은 다음 저장소 상대 파일을 뜻한다. 아래 `약칭:행`은 이 파일의 실제 행이다.

| 약칭 | 파일 |
| --- | --- |
| 에픽 | `_bmad-output/personal-brain/tickets/epic-garmin-runtime/epic-garmin-runtime.md` |
| 세트 | `_bmad-output/personal-brain/tickets/epic-garmin-runtime/tickets/tickets.toml` |
| 조사 | `_bmad-output/personal-brain/tickets/epic-garmin-runtime/epic-garmin-runtime-research-code.md` |
| spine | `_bmad-output/personal-brain/architecture-brain-v1-slice-1/architecture-brain-v1-slice-1.md` |
| 이니셔티브 | `_bmad-output/personal-brain/initiative-personal-brain.md` |
| 통합경계 | `_bmad-output/personal-brain/prep-garmin-absorption/integration-boundaries.md` |
| 장부 | `_bmad-output/personal-brain/decisions-by-recommendation.md` |
| 작업계획 | `_bmad-output/personal-brain/tickets/epic-jobs-and-scheduler/tickets/tickets.toml` |
| 확장계획 | `_bmad-output/personal-brain/tickets/epic-extensions/tickets/tickets.toml` |
| 이전계획 | `_bmad-output/personal-brain/tickets/epic-garmin-import/tickets/tickets.toml` |
| 채널계획 | `_bmad-output/personal-brain/tickets/epic-channels/tickets/tickets.toml` |
| 분석에픽 | `_bmad-output/personal-brain/tickets/epic-health-analysis/epic-health-analysis.md` |
| 조회에픽 | `_bmad-output/personal-brain/tickets/epic-search-and-health-query/epic-search-and-health-query.md` |

검사 규칙은 메인 checkout의 `~/github/second-brain/_bmad/render/bmad-agent-po/second-brain-bbe56f7ddda0/dcffd73a7f031ef42569/references/validate-checks.md`와 같은 폴더 `ticket.md`를 읽었다. 보고서 형식은 `_bmad-output/personal-brain/tickets/epic-garmin-import/epic-garmin-import-validate-set.md`의 최초 검증·재검증을 참고했다. 이미 기록된 계정 보호·tokenstore·일감 구성·기대값·digest·전환·폰트·순서·hitl 결정은 다시 묻지 않았다.

## fix

### F1 — 설치가 예약을 켜는 시점까지 전환 순서에 포함한다

- 근거: `세트:103`, `세트:104`; `에픽:48`, `에픽:101`; `확장계획:56`, `확장계획:57`, `확장계획:68`; `작업계획:116`; `조사:173`, `조사:175`, `조사:177`.
- 문제: 9는 확장 갱신을 먼저 하고 이후 옛 collect를 bootout한다. 그런데 소비하는 설치 절차 13.5는 로그인·연결 확인·예약 등록까지 수행한다. 갱신 경로가 예약 등록까지 재개하거나 이미 열린 새 일감이 있으면 명시한 “공통 예약 등록” 단계보다 먼저 외부 호출이 가능하다. label의 등록 부재만으로 수동 실행·남은 프로세스의 종료도 증명되지 않는다. 복구도 새 예약을 끈 다음 진행 중 새 수집의 종료 확인 없이 옛 plist를 load한다. 이는 이미 결정한 무중첩 정책의 실행 공백이다.
- 바꿀 내용: 에픽 Notes와 9의 절차에 새 쪽 보류 그룹으로 예약 발화·수동 실행·청구를 먼저 막고 진행 attempt의 종료를 확인하는 준비 단계를 둔다. 보류 상태에서 패키지·lock·마이그레이션을 준비하고, 설치가 보류를 해제하거나 예약을 발화시키지 않는지 확인한다. 이 조합을 공통 설치 API가 지원하지 않으면 옛 수집 중지·종료 확인을 설치 호출보다 먼저 한다. 옛 collect 및 수집을 부르는 report의 등록 부재와 진행 writer 종료를 확인한 뒤에만 새 쪽을 해제한다. 종료가 불명이면 전환을 멈춘다. 복구도 새 예약 제거/보류 → 진행 새 수집 종료 확인 → 옛 plist 복원 순서다. verify에는 예약 시각과 설치 재개가 겹치는 합성 case와 양방향 복구의 무중첩 확인을 넣고, 공개 plan에는 종료 확인 성공 여부만 남긴다. 기존 tokenstore 재사용·report 유지 조건은 그대로 따른다.

### F2 — manifest·설정·전체 잠금 의존의 완성 담당을 지정한다

- 근거: `에픽:40`, `에픽:47`; `세트:8`, `세트:20`, `세트:56`, `세트:68`, `세트:103`; `확장계획:20`; `조사:118`, `조사:123`, `조사:124`, `조사:125`, `조사:126`, `조사:134`.
- 문제: E16-8의 covers는 있지만 1은 collect 최소 manifest, 2는 인증과 garminconnect·curl-cffi, 5는 artifacts, 6은 matplotlib, 9는 설치·예약 실행만 구체화한다. 옛 `_DEFAULTS` 전체의 connector 설정 선언·검증·snapshot 대응 및 기본 예약 선언을 완성하는 담당이 분명하지 않다. E16-1이 요구한 jsonschema·requests까지 포함한 결합 lock의 최종 책임도 entry에는 명시되지 않는다. 9가 빠진 설정이나 패키징 기능을 처음 구현해야 하는 구성이 될 수 있다.
- 바꿀 내용: 에픽 Notes의 분담에 2는 인증·호출 보호 설정, 3은 수집 설정·기본 collect/retry 예약 및 전체 connector 설정 대응표 완성, 5는 artifacts 선언·collect 의존 연결, 6은 산출 의존을 더한 최종 frozen lock 확인, 9는 이미 만든 선언의 설치본 실행이라고 적는다. jsonschema·requests는 기존 Python ABI 의존/전이 의존으로 이미 충족되는지 확인하고 필요한 직접 의존만 추가하되, E16-1의 전체 목록을 확인하는 담당을 둔다. 분석 설정은 18에 남긴다. 설정 대응표는 옛 키의 새 이름·타입·기본값·제외 사유를 기록하고, verify에는 선언하지 않은 키 거부·잘못된 값 거부·실행 중 설정 변경에도 snapshot 고정·예약 두 개의 멱등 등록을 배정한다. 한 문장 description을 상세 명세로 늘리기보다 에픽에서 소유권을 확정한다.

### F3 — 갱신된 epic 18의 추가 소비 계약과 epic 16의 산출을 맞춘다

- 근거: `에픽:44`, `에픽:45`, `에픽:47`, `에픽:100`, `에픽:101`; `세트:56`, `세트:68`, `세트:103`; `분석에픽:41`, `분석에픽:47`, `분석에픽:48`, `분석에픽:101`, `분석에픽:105`, `분석에픽:107`, `분석에픽:108`; `조회에픽:20`, `조회에픽:59`, `조회에픽:62`.
- 문제: 작업 중 코디네이터가 갱신한 18을 최종 재확인했다. 옛 report 중지 책임은 이제 18 Notes에 있으므로 그 누락은 해소됐다. 대신 새 18은 수집 결과가 나르는 UTC cutoff, 같은 수집 결과의 digest JSON 파일, 그래프의 앨범 역할 metadata, collect/artifacts 성공 결과를 기다리는 분석 의존을 요구한다. 현재 16은 digest 일 값 건강 행과 PNG 날짜·이름·revision을 약속할 뿐, 전체 digest JSON 파일·역할 metadata·cutoff/결과 연결의 공개 계약은 약속하지 않는다. 18의 “epic 16 Handoff로 적었다”도 현재 16 파일에는 해당 수신 문장이 없다. 18이 garmin 내부 표나 Python 계산을 직접 읽어 메우면 AD-30·35 경계를 깨뜨린다.
- 바꿀 내용: 16·18 Notes에 공통 인계 계약 하나를 연결한다. 기존 digest 일 값의 건강 행 결정은 유지한다. 추천안은 16.5가 합성 fixture로 동등성을 검증한 전체 digest JSON도 `file_requests`로 등록하고, 수집 결과 id·UTC cutoff·시간대·현지 날짜·산출 revision과 연결해 공개 완료 결과로 내는 것이다. 16.6은 그래프 이름에서 역할을 안정적으로 판정할 계약을 제공하거나 명시적 역할 metadata를 내고, 18이 그것으로 두 앨범을 고른다. cutoff의 정의·결과 id의 공개 조회 방식·collect/artifacts 의존 생성 주인은 에픽에서 정하고 공통 일감/파일 계약을 재사용한다. 16의 core 직접 청구·임의 core 표 쓰기로 해결하지 않는다. 만약 JSON 파일과 새 metadata를 만들지 않으면 18의 요구를 실제 건강 행·파일 계약으로 낮춰야 한다.
- 제안 Handoff 문장: “Handoff(2026-10-28, epic 16 세트 검증): 18의 입력 snapshot은 16.5가 publish한 digest 일 값 건강 요약 행과 catalog·현재 view를 읽고, 전체 digest JSON은 같은 수집 결과/cutoff에 연결된 core 파일로 받는다. 결과 묶음은 16.6의 현지 날짜·그래프 이름·산출 revision·역할 및 core 등록 완료 결과로 고른다. 16.5·16.6의 공개 계약과 공유 fixture를 양쪽이 따른다. 옛 report 전환은 16.9가 남긴 상태를 받아 18.9가 중지·진행 평가 종료를 확인한 뒤 새 예약을 켠다. 18의 intake 결과는 16.5가 읽는 측정 JSON과 원본 참조 계약으로 쓰며 비밀·건강값을 공개 plan에 기록하지 않는다.” 뒤 에픽을 쪼갤 때 코드 생산 entry로 교차 after를 고정한다. 17은 같은 catalog·현재 view를 읽으므로 16 전체를 기다리게 할 필요가 없고, Python digest 계산을 호출하지 않는다는 수신 문장을 선택적으로 더하면 된다.

### F4 — high-risk 스토리의 기준 외 추가 확인을 Notes에 배정한다

- 근거: `에픽:106`, `에픽:107`, `에픽:108`, `에픽:109`, `에픽:110`, `에픽:115`; `세트:9`, `세트:21`, `세트:33`, `세트:45`, `세트:104`; 검사 규칙 ticket.md의 “A high-risk ticket names in Notes one check beyond its criteria.”
- 문제: high인 1·2·3·4·9의 위험 이유는 있지만 verify 외 추가 확인을 Notes에 지정하지 않았다. 아직 leaf가 없다는 이유로 기존 verify를 추가 확인이라고 중복 배정하면 규칙을 충족하지 못한다.
- 바꿀 내용: 에픽 Notes에 각 high entry의 추가 확인과 leaf로 이어받을 책임을 적는다. 예: 1은 운영과 다른 홈·DB에서만 fake 경로가 열리는지 별도 점검, 2는 보호 상태 DB 쓰기 실패 시 fail closed와 재시작 뒤 무호출, 3은 라이브러리 내부 retry와 wrapper 호출 간격의 보장 범위를 별도 검토, 4는 서로 다른 두 raw revision의 동시 publish가 늦은 값으로 현재를 되돌리지 않는지 확인, 9는 공개 plan의 건강값·계정·토큰 부재를 별도 검사한다. 이미 verify에 있는 사례를 고르면 다른 추가 확인으로 바꾼다. risk 선택을 다시 묻지 않는다.

### F5 — sweep 뒤 운영 전환을 두는 예외와 실패 환류를 명시한다

- 근거: `세트:92`, `세트:95`, `세트:103`, `세트:106`; `에픽:103`, `에픽:104`; `이니셔티브:187`; 검사 규칙 validate-checks.md Set의 Refactor sweep.
- 문제: 8은 1~7만 기다리고 9는 배포·예약 변경·실계정 전환을 한다. 자동 허용된 마지막 end-to-end suite보다 9의 범위가 넓다. 순서 Decision만으로는 8이 코드 cleanup만 닫는 예외와 9의 발견 사항을 처리하는 경계가 분명하지 않다.
- 바꿀 내용: 에픽 Notes에 “8은 코드 1~7의 cleanup을 닫고, 운영 배포·전환 9는 그 뒤 별도다. 9에서 찾은 기능 수정은 버그 스토리로 처리하며 8에 밀어 넣지 않는다. MFA·차단·미실행·실패는 실수집 성공으로 세지 않는다”는 날짜 있는 Decision을 적는다. 기존 순서와 hitl 위임을 유지하는 명시적 예외다.

## suggest

### S1 — crash 주입·가짜 시간의 독립 실행 절차를 정제 plan에 고정한다

- 근거: `세트:8`, `세트:21`, `세트:33`, `세트:57`, `세트:69`, `세트:81`; `작업계획:8`; `채널계획:8`, `채널계획:21`.
- 문제: entry 수준의 verify 접근은 적절하지만 “죽이고 다시 띄움”만으로는 비작성자가 commit 전/후를 재현하기 어렵다. 7의 사건 행 INSERT 직후 crash는 같은 트랜잭션 전체가 rollback되므로, 재실행을 포함해야 요청 한 건 인계를 관찰할 수 있다.
- 바꿀 내용: plan에 시험 진입점·환경 사전 조건·동기화된 crash hook·대상 프로세스·재시작·관찰 SQL의 공개 투영·정리를 적는다. 2는 보호 상태 commit 직후, 3은 날짜 checkpoint commit 전/후, 5는 파일 요청/완료 확인/원본 이동 경계, 7은 사건+요청 commit 전 rollback 및 commit 후 core 재발견을 나눈다. clock은 12.1, 가짜 서버는 15.1의 것을 재사용한다. 아직 없는 leaf에 지금 시험 이름이나 통과 증거를 요구하지 않는다.

### S2 — 조사 문서의 Python pin을 채택된 3.14.10과 맞춘다

- 근거: `조사:134`; `에픽:40`; `통합경계:28`; `장부:28`.
- 문제: 조사 7절은 epic 14가 이미 결정한 pin을 3.14.8이라고 적지만 에픽과 장부의 채택값은 3.14.10이다. 통합경계의 3.14.8은 옛 배포 사실로 읽을 수 있으나 조사 문장은 새 전제처럼 보인다.
- 바꿀 내용: 조사에 옛 archive pin과 새 배포 pin을 구별하는 정정 문장을 넣고 14의 채택값을 참조한다. 새 resolve 결과나 설치 성공을 주장하지 않는다. 새 사용자 결정을 요구할 사안이 아니다.

### S3 — 그래프 라벨 검증이 폰트 이름 확인에 그치지 않게 한다

- 근거: `세트:69`; `에픽:45`, `에픽:102`; `조사:96`.
- 문제: verify의 “tofu 없이(폰트 이름 확인)”에서 폰트 이름만으로는 실제 선택된 폰트의 한국어 glyph 포함을 증명하지 못한다. fallback을 유지하는 결정과 한국어 검증은 별개다.
- 바꿀 내용: Mac 검증에서는 실제 선택된 font face의 대표 한국어 glyph 존재와 missing-glyph 경고 부재를 검사하고, 합성 PNG를 렌더해 라벨을 확인한다. 폰트가 없는 환경은 충족/미충족을 구분한다. PNG 바이트 golden이나 새 폰트 번들은 요구하지 않는다.

## Requirements와 Done when 대조

| 요구 | 담당 결과 |
| --- | --- |
| E16-1 | 1 최소 worker·PG port·collect manifest, 2 외부 client 의존·인증, 6 matplotlib·설치, 7 직접 Telegram 교체, 9 배포·전환. 설정·전체 의존 완성 배정은 F2 |
| E16-2 | 2 tokenstore·대화형 인증 경계·영속 보호·간격·직렬화·비밀 |
| E16-3 | 1 한 응답 raw/coverage, 3 전체 15 endpoint·진입표·raw 전이·coverage·재개 |
| E16-4 | 1 지표 하나 최소 INSERT·멱등·attempt, 4 전수 정규화·revision·rebuild·권위 v2·고정 기대값 |
| E16-5 | 5 body 원본·mtime·digest 일 값·건강 요약 행·catalog |
| E16-6 | 6 PNG·날짜/이름/revision·파일 보존·실패 격리, 공통 labels loader는 5 |
| E16-7 | 7 여섯 사건·안정 사건 id·채널 의미 키·원자적 요청 |
| E16-8 | 1 collect 최소형, 3 전수 결과·진행/취소, 4 normalize, 5 artifacts 의존, 9 실제 예약. 설정·예약 선언 책임은 F2 |
| E16-9 | 9 옛 예약 전환·실수집·MFA 대기. 무중첩 실행 보강은 F1 |

covers의 없는 id·누락 id는 없다. 공유 id의 최소형/전수/설치본 확인은 description에서 구별된다. E16-6의 labels loader가 5에 있는 것은 6이 5를 기다리므로 실행을 막지 않는다. Done when 1은 3·4·5, 2는 2·3, 3은 1·3·4·5·7, 4·5는 9의 결과로 닫는다. F1·F2를 반영해야 운영 예약·전환까지 충족된다. 9의 `hitl = false`는 사용자 위임과 일치하며, 현재도 MFA를 성공으로 기록하지 않는다(`에픽:94`, `에픽:105`; `세트:103`, `세트:104`). 차단으로 기다리는 경우에도 완료로 세지 않아야 한다.

## 의존과 크기

| after | 판정 |
| --- | --- |
| 1 → 14.7·14.2 | 14.7은 공용 Garmin 패키지·manifest·store·worker의 코드 변경 충돌을 막는 명시적 레인이다. 14.2는 실제 소비하는 catalog·보관 키·현재 view다. 전이적으로 중복되어도 가짜 선행은 아니다 |
| 2 → 12.7·13.5 | 계정 직렬화와 인증 단계 결과/재개가 실제 선행이다. 13.5 → 13.4 → 13.3 → 13.2로 manifest·snapshot을 받는다 |
| 5 → 14.5 | body 원본과 PNG 등록의 결과 view·보존·core 인계가 실제 선행이다. 14.7 경유로도 이미 도달한다 |
| 7 → 15.3 | 요청 계약·RLS·attempt trigger와 같은 conversation을 받는다. 15.3 → 15.2 → 15.1로 가짜 Telegram 서버와 발신 재시도를 받는다 |
| 9 → 12.8 | 현지 예약·놓친 날짜 처리의 실제 선행이다. 13.5의 12.9 경유로도 확보돼 있다 |
| 13.2·12.6·12.10 | 16.1 → 14.7 → 14.1 → 15.6 → 15.1 → 13.9의 경로로 모두 확보한다. 13.9는 13.2·13.6을 포함하고, 13.6 → 12.10 → 12.9 → 12.8 → 12.7 → 12.6이다. 별도 after 추가 불필요 |

내부 1~9 한 레인은 공유 manifest·lock·store·worker 충돌을 막는다(`세트:2`; `에픽:104`; `조사:185`, `조사:187`). 앞 생산자 문장을 다시 쓰지 않는 예외는 Notes에 명시돼 있으므로 재지적하지 않았다. 실제 반입 14.8을 1의 gate로 추가할 필요도 없다. 합성 tracer는 14.7까지의 코드 계약이면 된다. 9에서 이전 데이터의 유무와 capture 이후 새 수집 경계를 실제 상태로 확인한다.

tracer 1은 endpoint 하나·지표 하나·정상 경로 하나의 상한이 있고, 실제 Python → 감독자 → PG raw → 건강 행 → 현재 view 및 멱등·오래된 쓰기 거부를 관찰한다(`세트:8`, `세트:9`). 전체 인증·전수 endpoint·동등성·파일·실계정은 뒤로 빠져 있어 가장 얇은 수직 경로로 타당하다. 기존 14의 뼈대와 12·13 시험 기반을 재사용한다는 전제에서 한 세션 범위를 제어한다. setup을 사람이 수행하는 단계가 없으므로 hitl을 올릴 이유는 없다. 2를 가장 불확실한 다음 스토리로 둔 Decision도 있다(`에픽:103`).

## spine·비밀·보드 확인

- AD-7·21·23·29·30: 외부 I/O 밖 짧은 쓰기, 감독자 실행, INSERT만 하는 건강/파일/채널 계약, `<scope>/<원래 key>`, core 파일 인계가 일치한다(`에픽:21`, `에픽:52`, `에픽:53`, `에픽:95`; `세트:8`, `세트:56`, `세트:68`, `세트:80`).
- AD-18: `.env` 한정 문구와 tokenstore 예외는 이미 에픽 Decision과 추천 장부에 기록했다(`spine:320`; `에픽:97`). snapshot에는 경로만 넣고 library login/dump만 내용에 접근하므로 지금 구현을 막는 미결정이 아니다. 다음 spine 갱신의 기록 작업을 새 승인 gate로 만들지 않는다.
- AD-32·33: 불변 건강 행·권위 v1 보존/v2 추가·revision·계정 profile id, 현재 attempt를 같은 쓰기 트랜잭션에서 확인, endpoint/batch 취소, 비밀 허용 목록 오류가 일치한다(`에픽:43`, `에픽:53`; `세트:20`, `세트:32`, `세트:44`). AD-35도 digest·그래프는 확장, snapshot·평가는 core라는 경계와 맞는다. F3은 이 경계를 소비자까지 연결하는 수정이다.
- 비밀·개인 데이터: 합성 fixture만 고정하고 실제 값은 옮기지 않으며, 9의 plan은 단계 상태·건수만 허용한다(`에픽:55`, `에픽:56`, `에픽:99`; `세트:103`). 원시 token/비밀번호/MFA·실계정 id·실제 건강값을 공개 plan에 붙이라는 요구는 없다. 2·7의 시험 비밀 문자열 검증도 있다. F4의 공개 plan 추가 점검은 이 제한을 독립적으로 확인하게 한다. 오류의 library 예외·traceback을 그대로 붙이지 않는 허용 목록 정책을 유지한다.
- 지정 `uv run ~/.agents/skills/bmad-agent-po/scripts/tickets.py --project-root "$(git rev-parse --show-toplevel)" status _bmad-output/personal-brain`를 실행했다. 최초 uv 캐시 잠금 접근은 sandbox에 막혀 읽기 전용 조회를 권한 확장으로 재시도했고 정상 JSON을 받았다. epic 16은 refined=true, next_id=10, entry 9개 모두 planned·file=null·hitl=false다. `unpinned_after=[]`, `undeclared_after=[]`, `order_conflict=[]`이고 cycle 오류는 없었다. leaf가 없어 drift 대상이 없으며 entry에도 drift 표시는 없었다. 보드 검사는 F1 같은 실제 실행 순서의 의미 오류를 검출하지 않는다.

ask는 없다. 위 수정은 기존 결정을 실행 가능한 책임·절차·인계로 연결하는 내용이다. 보고서 외 에픽·세트·장부·소비자 파일은 수정하지 않았다.


## 재검증 (2026-10-28)

수정 후 재검증 — F1~F5·S1~S3 해소, 새 fix F6 1건.

수정된 에픽 Notes·entry 3·5·6·9·조사 정정과 분석에픽의 수신 Handoff를 Set·Dependencies 및 high-risk 추가 확인 규칙으로 다시 대조했다. 아래 근거는 앞의 약칭 표를 그대로 쓰며, `분석세트`는 `_bmad-output/personal-brain/tickets/epic-health-analysis/tickets/tickets.toml`이다. 정적 계획 재검증이며 구현·실계정 동작의 통과를 뜻하지 않는다.

| 지적 | 판정 | 근거와 확인 결과 |
| --- | --- | --- |
| F1 | 해소 | `에픽:116`, `세트:103`, `세트:104`. 새 보류 그룹으로 예약·수동 실행·청구를 막고 진행 attempt가 없음을 확인한 뒤 갱신한다. 갱신이 보류를 해제하거나 예약을 발화시키지 않는지 확인하며, 설치 API가 지원하지 않으면 옛 수집 중지를 먼저 한다. 옛 writer 종료 불명은 중단이고, 복구도 새 수집 종료 확인 뒤 옛 plist 복원이다. 예약 시각을 넘긴 보류 중 청구 0과 무중첩 관찰을 verify에 배정했다. |
| F2 | 해소 | `에픽:117`, `세트:32`, `세트:33`, `세트:56`, `세트:69`. 2·3·5·6·9의 설정·기본 예약·artifacts 선언·전체 lock·설치본 확인 소유권이 정해졌다. 전체 설정 대응표, 미선언 키·잘못된 값 거부, 실행 snapshot 고정, 두 예약의 멱등 등록이 3에 있다. 6은 jsonschema·requests의 직접/전이 의존 판단을 포함해 최종 frozen 확인을 맡는다. 분석 설정은 18에 남는다. |
| F3 | 해소 | `에픽:118`, `에픽:119`, `세트:32`, `세트:56`, `세트:57`, `세트:68`, `세트:69`, `분석에픽:122`. 전체 digest JSON과 건강 일 값을 함께 내고 수집 결과 id·UTC cutoff·시간대·현지 날짜·revision으로 연결한다. 그래프 역할을 명시하고 core 완료 결과로 고른다. cutoff의 정의와 core 일감 결과를 통한 조회, 분석 의존 생성 담당 18.7, intake JSON 수신 계약이 양쪽에 기록됐다. 원래의 산출·소비 계약 누락은 해소됐다. 새 전환 Handoff와 소비 entry의 불일치는 아래 F6으로 분리한다. |
| F4 | 해소 | `에픽:120`, `에픽:121`, `에픽:122`, `에픽:123`, `에픽:124`, `에픽:125`. high인 1·2·3·4·9 각각에 기존 verify와 별도의 확인을 지정하고 leaf에 이어받게 했다. 격리 홈·DB, 보호 상태 저장 실패, 라이브러리 retry 범위, 동시 revision publish, 공개 plan 비밀 검사를 다룬다. |
| F5 | 해소 | `에픽:126`, `세트:92`, `세트:95`, `세트:106`, `이니셔티브:187`. sweep은 코드 1~7의 정리만 닫고 배포·전환 9는 그 뒤에 둔다는 날짜 있는 예외다. 9의 기능 문제는 버그 스토리로 돌리고 MFA·차단·미실행·실패를 성공으로 세지 않는다. 기존 순서·위임을 바꾸지 않는다. |
| S1 | 해소 | `에픽:127`. 각 plan에 시험 진입점·사전 조건·동기화 crash hook·대상 프로세스·재시작·공개 관찰·정리를 쓰도록 했다. 2·3·5의 경계와 7의 commit 전 rollback/commit 후 core 재발견을 구별하며 12.1 clock과 15.1 가짜 서버를 재사용한다. 아직 없는 leaf의 실제 실행 증거를 요구하는 것으로 읽지 않았다. |
| S2 | 해소 | `조사:134`, `조사:136`, `에픽:40`, `에픽:127`, `spine:665`. 옛 문장은 남아 있지만 바로 앞 정정이 3.14.8을 archive 값으로 한정하고 새 배포 pin 3.14.10을 명시적으로 우선한다. 새 resolve·설치 성공을 주장하지 않는다. |
| S3 | 해소 | `세트:68`, `세트:69`, `에픽:102`, `에픽:127`. 실제 선택 font face의 한국어 glyph와 missing-glyph 경고 부재를 확인하고, 합성 값으로 PNG를 그리는 시험과 기존 수치·축·라벨 비교를 함께 따른다. 폰트가 없는 환경은 충족/미충족을 구별하며 폰트 번들·PNG 바이트 golden은 추가하지 않았다. |

### F6 — 새 전환 Handoff의 소비 절차를 epic 18.9에도 맞춘다

- 근거: `에픽:119`; `분석에픽:108`, `분석에픽:122`; `분석세트:103`, `분석세트:104`.
- 문제: 새 Handoff는 18.9가 16.9의 상태를 받아 옛 report를 중지하고 진행 평가 종료를 확인한 **뒤** 새 예약을 켜도록 약속한다. 그러나 소비 entry 18.9는 여전히 “11:30 분석 예약 등록 → 옛 report bootout·등록 부재 확인” 순서이며, 진행 중 옛 평가의 종료 확인도 없다. 예약 시각이 겹치거나 bootout 뒤 옛 평가가 살아 있으면 새 Handoff와 분석에픽의 무중첩 Decision을 만족하지 못한다. 이는 새 Handoff와 기존 소비 초안의 불일치이며, 기록된 무중첩 결정을 다시 논의할 사안은 아니다.
- 바꿀 내용: 18.9의 description·verify·복구 절차를 Handoff에 맞춰 새 예약/실행 보류 → 옛 report 등록 부재와 진행 평가 종료 확인 → 새 예약 해제·수동 평가 순으로 정합시킨다. 종료 불명이면 전환을 멈추고 복구 때도 새 평가 종료를 확인한 뒤 옛 plist를 복원한다. 16.9가 report를 이미 내렸는지 실제 상태로 확인하며, 이니셔티브의 운영 확인 분리 Decision을 바꾸거나 16.9 전체를 새 코드 gate로 추가하라는 요구는 아니다. epic 18 검증 담당이 소비 파일을 고치도록 넘긴다.

### 공통 계약·의존·보드 재확인

- F1의 보류는 `작업계획:116`, `작업계획:117`의 예약 발화·새 청구 차단/진행 취소를 소비한다. `확장계획:56`의 설치 재개·예약 등록과 충돌할 경우 옛 수집을 먼저 멈추는 분기도 있으므로, 앞 에픽에 새 설치 기능을 요구하지 않는다(`에픽:116`).
- F2의 manifest·snapshot은 `확장계획:20`, 파일 인계는 `이전계획:8`, `이전계획:56`의 결과 view·바이트 보존·core 정리를 재사용한다. F3의 추가 metadata는 이 계약의 산출 연결이며, 임의 core 표 쓰기나 확장의 work_items 청구를 허용하지 않는다(`에픽:53`; `spine:471`, `spine:475`). digest·그래프가 확장 산출이고 분석이 core라는 AD-35도 유지한다(`spine:529`, `spine:533`, `spine:534`). 새 무중첩 절차와 버그 환류는 기존 `에픽:101`, `이니셔티브:187`을 구체화한다. 이 대조에서 F6 외 새 Decision·spine·앞 에픽 계획 충돌은 발견하지 않았다.
- 지정 보드 status 조회는 정상 완료했다. 첫 uv 캐시 잠금 접근이 sandbox에 막혀 읽기 전용 조회만 권한 확장으로 재시도했다. epic 16의 9개 entry는 모두 planned·file=null·hitl=false이고, `unpinned_after=[]`, `undeclared_after=[]`, `order_conflict=[]`이며 cycle 오류·drift 표시는 없다. F3 생산물을 받는 18.2·18.5는 16.5, 18.6은 16.6을 기다린다. 실제 런타임 분석 의존 생성은 18.7 소유라는 양쪽 Notes와 맞는다.
- 이 작업은 이 보고서에 본 절만 덧붙였다. 테스트·빌드·Docker·네트워크·설치·커밋은 하지 않았고, 다른 워커 소유 파일을 수정하지 않았다. 절대 홈 경로 검사에서도 일치가 없음을 확인했다.
