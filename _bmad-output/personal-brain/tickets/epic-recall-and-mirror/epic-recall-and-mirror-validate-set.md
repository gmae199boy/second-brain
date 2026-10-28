수정 후 재검증 — fix 6 / suggest 1 / ask 0

# epic 4 스토리 세트 검증 (2026-10-28)

Ticket·Set·Dependencies와 `ticket.md`의 “Rules the template cannot carry”를 적용한 정적 검토다. 대상은 미커밋 에픽·entry 10개·이니셔티브 epic 4 after이며, leaf 정제나 구현 완료 판정은 아니다. 테스트·빌드·Docker·네트워크·설치·커밋은 하지 않았다. Garmin 계정·tokenstore·개인 자료도 열지 않았다.

아래 약칭은 표의 저장소 상대 파일명을 뜻한다. 따라서 `에픽:38` 같은 근거는 해당 파일의 38행이다.

| 약칭 | 파일 |
| --- | --- |
| 에픽 | `_bmad-output/personal-brain/tickets/epic-recall-and-mirror/epic-recall-and-mirror.md` |
| 세트 | `_bmad-output/personal-brain/tickets/epic-recall-and-mirror/tickets/tickets.toml` |
| 조사 | `_bmad-output/personal-brain/tickets/epic-recall-and-mirror/epic-recall-and-mirror-research-code.md` |
| 이니셔티브 | `_bmad-output/personal-brain/initiative-personal-brain.md` |
| 보드 | `_bmad-output/personal-brain/tickets/tickets.toml` |
| spec | `_bmad-output/personal-brain/spec-brain-v1-slice-1/spec-brain-v1-slice-1.md` |
| spine | `_bmad-output/personal-brain/architecture-brain-v1-slice-1/architecture-brain-v1-slice-1.md` |
| addendum | `_bmad-output/personal-brain/prd-brain-v1-slice-1/addendum.md` |
| 검색계획 | `_bmad-output/personal-brain/tickets/epic-search-and-health-query/tickets/tickets.toml` |
| 로그계획 | `_bmad-output/personal-brain/tickets/epic-log-and-context/tickets/tickets.toml` |
| Drive계획 | `_bmad-output/personal-brain/tickets/epic-drive/tickets/tickets.toml` |
| 첨부계획 | `_bmad-output/personal-brain/tickets/epic-attachments/tickets/tickets.toml` |
| 작업계획 | `_bmad-output/personal-brain/tickets/epic-jobs-and-scheduler/tickets/tickets.toml` |
| 장부 | `_bmad-output/personal-brain/decisions-by-recommendation.md` |

## 지적

### F1 — recall 직전 증분 수집의 담당과 검증이 빠졌다 (fix)

- 근거: `에픽:18`, `에픽:37`~`에픽:44`, `세트:9`, `세트:21`, `검색계획:32`, `검색계획:56`, `spine:146`.
- 문제: Description에는 recall 직전 세션 토큰 증분 수집이 남아 있고 spine은 `recall.*`의 선수집을 요구한다. E4-1~8과 entry에는 구현·검증 책임이 없고, epic 17의 공통 검색·스킬 entry도 선수집을 명시하지 않는다. 검색 코드만 재사용하면 방금 생긴 transcript가 조회에 반영되는 계약이 누락될 수 있다.
- 바꿀 내용: 에픽 Requirements 또는 무번호 통합 책임에 선수집을 명시하고 2가 기존 epic-capture/epic 3의 연결을 재사용해 새 time/logs 경로와 기존 recall 경로에 적용하는 책임을 갖게 한다. 이미 앞 에픽에서 완성됐으면 그 산출물 참조와 소비 검증을 적는다. 아직 DB에 없는 합성 transcript를 둔 뒤 recall을 호출해 증분 수집이 먼저 일어나고, 반복 호출에도 중복이 없으며, connector가 찾지 못하는 경우 기존 수집 오류 계약을 지킨다는 관찰을 plan/verify에 넘긴다. 검색 엔진이나 수집기를 다시 만들라는 지적은 아니다.

### F2 — 시간 조회도 공통 결과 계약을 쓰는 책임이 명시돼야 한다 (fix)

- 근거: `에픽:38`, `에픽:51`, `세트:9`, `세트:10`, `세트:21`, `검색계획:32`, `spine:289`, `spine:290`, `조사:138`.
- 문제: Done when 4는 이 에픽의 조회도 같은 계약을 쓴다고 하지만, 2는 출력 코덱 통과·빈 배열만 적는다. 3은 logs의 budget을 명시한다. epic 17의 공통 budget은 기본적으로 근접 순위 결과를 다루므로, 시간 조회가 이를 어떤 순서로 잘라 다음 페이지로 이어갈지 빠져 있다. 일반 봉투를 통과하는 것만으로 8,000자 상한·누락 수·다음 행동이 충족되지는 않는다.
- 바꿀 내용: E4-2에 시간순을 유지한 채 epic 17의 가린 뒤 budget·limit+1·0건/실패 구분을 소비한다고 적고, 2의 검증에 긴 시간 조회와 다음 페이지를 추가한다. 낮은 순위는 시간순 결과의 뒤쪽이라는 적용 관계, `meta.next`로 이어 읽어도 중복·누락이 없다는 확인을 정제 입력에 둔다. 프로젝트 무관 시간순을 근접 정렬로 바꾸지 않는다.

### F3 — 충돌 그룹이 바뀔 때 옛 미러 경로를 정리하는 계약이 없다 (fix)

- 근거: `에픽:42`, `에픽:43`, `에픽:95`, `세트:57`, `세트:58`, `세트:69`, `조사:61`.
- 문제: 번호를 전체 DB의 시작 시각·id 순으로 매기는 결정은 타당하지만, 증분 수집으로 더 이른 충돌 세션이 뒤늦게 들어오면 기존 세션의 기본 이름이 ` (2)`로 이동한다. 세션별 일감만 갱신하면 다른 세션의 옛 파일을 덮거나 옛 이름에 본문이 남을 수 있다. 현재 검증은 고정된 두 세션을 서로 다른 순서로 rebuild하는 경우이며, 이미 파일이 있는 상태의 재배정·옛 경로 삭제는 다루지 않는다. redact도 현재 계산한 경로 하나만 지우면 옛 파일을 놓칠 수 있다.
- 바꿀 내용: 번호 결정은 그대로 두고 E4-6·7에 경로 재배정 시 영향받은 충돌 그룹의 미러를 함께 조정하고 옛 경로를 남기지 않는 책임을 적는다. 그룹별 직렬화 등 구체 수단은 plan에서 정하되 서로 다른 세션 worker가 같은 경로를 덮지 못하게 한다. 6·7에 기존 기본 이름 생성 → 더 이른 충돌 세션 추가 → 그룹 수렴 → 기존 세션 redact 순서의 합성 시험을 추가한다. 각 세션 파일 하나, 전체 rebuild와 같은 최종 이름·내용, 옛 경로와 재배정 경로 어디에도 가린 값이 없음을 본다. 충돌 번호 결정을 다시 묻는 것이 아니다.

### F4 — 공유 spine에 새 rebuild 계약과 EXIF 선택을 반영해야 한다 (fix)

- 근거: `에픽:44`, `에픽:97`, `에픽:100`, `세트:81`, `spine:284`, `spine:285`, `spine:563`, `spine:565`, `spine:662`, `검색계획:20`.
- 문제: 새 결정은 키워드 조각도 활성 설정 포인터를 전환하는 rebuild인데 spine의 교체 규칙은 선택 임베딩의 새 테이블 교체에 있고, Table Contract는 불변 `index_configs`만 명시한다. 검색·증분 writer·redact 재생성이 어느 설정을 읽거나 유지해야 하는지 공통 계약이 없다. 또한 spine의 채택 문서 추출 라이브러리 표는 exif-reader만 적어 exifr 우선 결정과 다르다.
- 바꿀 내용: AD-15와 Table Contract에 키워드 조각의 활성/요청 설정 상태 소유, 완성 전 옛 설정만 검색, 완성 뒤 원자 전환, 중단 재개를 반영한다. 17의 증분 writer·redact 재생성과 rebuild가 공존할 때 최신 입력/가리기가 새 설정에도 반영된 뒤 전환한다는 계약과 경쟁 검증을 8에 적는다. exact DDL은 구현 plan이 정한다. 라이브러리 표는 exifr 우선·원문 보존 확인 실패 시 exif-reader라는 기존 결정을 표시하고 버전은 구현 때 고정한다. AD-16은 충돌 처리를 epic 4에 위임하므로 번호 정책을 아직 spine에 쓰지 않은 것 자체는 별도 지적하지 않는다.

### F5 — CAP의 성공 기준을 측정·판정할 담당이 부족하다 (fix)

- 근거: `spec:33`, `spec:36`, `spec:39`, `에픽:31`, `에픽:49`, `세트:82`, `세트:116`, `세트:117`, `장부:108`, `addendum:149`, `addendum:158`.
- 문제: CAP-4는 rebuild 뒤 점수가 떨어지지 않아야 하지만 8·10은 전후 비교/기록만 요구해 점수가 내려가도 verify를 통과할 수 있다. CAP-5의 SM-2 90%도 fixture 한 날짜만으로 측정되지 않고, 사람 몫 목록에는 SM-3만 있다. SM-3은 사람이 맡는다는 경계는 맞지만 에이전트의 설치본 확인으로 이 지표들까지 완료했다고 읽히면 안 된다.
- 바꿀 내용: 8의 중립 회귀 fixture에는 동일 의미 설정의 rebuild 전후 비하락 판정을, 규칙 변경의 점수 하락에는 실패 분류·버그/후속 조치와 미달 표시를 둔다. 10의 SM-2는 실행 전 private 기록에 고정한 실제 날짜 질문·기대 기간/활동으로 90% 충족 여부를 따로 남기고, 의미 판정에 사람이 필요한 부분은 사람 몫 목록으로 인계한다. SM-3은 기존 10문항 7건·추가 8문항 4건 기준의 사람 채점이 남았음을 닫기 때 확인하도록 연결한다. 공개 plan에는 중립 id·성공 여부·점수만 남긴다. 지표를 agent hit@k로 대체하거나 새 정책을 묻지 않는다.

### F6 — high인 8의 추가 확인이 기존 verify의 반복이다 (fix)

- 근거: `에픽:105`, `세트:82`, `세트:86`; `ticket.md` “Rules the template cannot carry”의 high-risk 추가 확인 규칙.
- 문제: Notes가 8의 추가 확인으로 지정한 “rebuild 중간에 프로세스를 죽이고 옛 설정 하나로 검색”은 8의 verify에 이미 그대로 있다. 따라서 기준 밖의 확인 하나가 되지 않는다. 6의 실제 대소문자 비구분 폴더 확인과 7의 redact/worker 동시 실행은 각각 추가 범위를 가진다.
- 바꿀 내용: 8에 독립 확인을 하나 배정한다. 추천은 서로 다른 설정의 rebuild 두 개를 동시에 요청해 활성 설정이 완성된 한 세대만 가리키고 오래된 완료가 되돌리지 못하는지 별도 점검하는 것이다. 기존 crash 검증은 유지한다.

### S1 — 시험 plan에 환경·동기화·정리의 구체 항목을 고정한다 (suggest)

- 근거: `세트:9`, `세트:10`, `세트:58`, `세트:70`, `세트:82`, `에픽:105`, `조사:79`.
- 문제: 초안 entry 수준에서 실행 명령을 plan으로 미룬 것은 허용되지만, 격리 PG·홈과 일반적인 사전 조건만으로는 다른 사람이 만료·crash·대소문자 폴더 시험을 같은 조건에서 재현하기 어렵다. 실제 시계나 임의 sleep으로 경쟁을 만들면 통과/실패가 흔들린다.
- 제안: 2의 공용 setup 책임에 PG URL/스키마·격리 홈 설정과 정리, 가짜 Clock/임대 만료 제어, worker의 snapshot/rename/전환 직전 barrier, kill 뒤 실제 종료 확인을 plan 필수 칸으로 적는다. 6의 비구분 폴더는 실제 볼륨 특성 확인 방법과 임시 폴더 정리, 8의 SM-7은 warm/cold·샘플 수·질의/필터·자료 수를 함께 남기게 한다. 지금 시험을 실행하라는 제안은 아니다.

## 범위·커버리지

| 요구 | 담당과 판정 |
| --- | --- |
| E4-1 / CAP-14 촬영 시각 | 1이 metadata 전용 성공·EXIF·가림 경쟁·과거 unsupported 선택 재처리·촬영 필터. 10은 설치본 실제 사진 확인. 문서 검색 자체는 8.6을 소비한다 |
| E4-2 / CAP-5 | 2가 공용 구간·기간 Store·time·D7·sessions list, 10은 설치본 확인. F1·F2·F5 보완 필요 |
| E4-3 / CAP-6 로그·CAP-7 | 3이 로그 검색·log 출처→17 원문 읽기·recall 스킬 안내. 10은 설치본 확인 |
| E4-4 / CAP-6·7 | 4가 chunks/logs/docs 동일 모집단·파일/세션/행·기간 내 0월·meta 계약. 모든 행을 top-k 전에 세는 책임이 명시됨 |
| E4-5 / CAP-6 | 5가 SDK 읽기 전용 runner·문항 검증·any-hit·실행 실패 구분·비하락 문항 비교. 사람 SM-3 별도 |
| E4-6 / CAP-13 | 6은 결정적 renderer·파일명·rebuild·코덱, 7은 수집/가리기/버전 상승의 수명·실패/경쟁, 10은 설치본. 같은 id의 분담은 명확하며 F3 보완 필요 |
| E4-7 / CAP-13 | 7이 redact 원자 enqueue·확정 직후 삭제·실패 경고/doctor. 이미 정한 삭제 실패 정책은 재논의하지 않음 |
| E4-8 / CAP-4 | 8이 전체 rebuild·전환·재개·UNINDEXED·doctor·SM-7, 10은 설치본. 17.2의 chunker/part를 다시 만들지 않으며 F4·F5 필요 |

covers의 없는 id·E4-1~8의 무담당 줄은 없다. 다만 id의 존재와 실제 통합/성공 조건 충족은 별개여서 위 fix가 남는다. 에픽의 Requirements는 모두 기능과 관찰 결과를 포함한다. 정확한 CLI flag·Store signature·fixture 경로를 아직 leaf 없는 entry에 full criteria로 요구하지 않는다. 기존 EXIF의 영구 id 1은 의미를 유지하고 위치만 바꿨고 새 id 2~10을 배정했다(`세트:1`, `세트:2`, `에픽:101`).

2의 tracer는 Core 날짜→Store/PG→SDK/CLI/코덱→17 출처 원문이라는 관통 경로이고 실제 보이는 결과가 title/verify에 있다. 프로젝트 둘·세션 셋·날짜 하나의 상한도 있다(`세트:9`). sessions list의 필터/페이지까지 있어 구현량은 주의해야 하지만, 앞 에픽의 날짜·결과 계약을 재사용하므로 현 초안만으로 한 세션 초과를 단정하지 않는다. setup은 에이전트가 만들고 사용자 starter가 없어 all-false hitl 결정과 충돌하지 않는다. 미러 불확실성을 먼저 두지 않은 순서는 `에픽:101`의 명시적 결정이므로 다시 묻지 않는다.

## Dependencies와 보드

| after | 실질 선행 근거 |
| --- | --- |
| 2 → 3.17·17.3 | `로그계획:162`, `로그계획:174`, `로그계획:177`: 로그·구간·공유 코드 레인 마감 HEAD. `검색계획:32`는 공통 budget과 expand/read. 단순 표시 순서가 아님 |
| 4 → 8.6 | `Drive계획:68`: 본문/이름/source-only를 합친 최종 docs 모집단·중복 제거가 count의 입력 |
| 6 → 12.7 | `작업계획:80`, `작업계획:81`: 두 프로세스에서도 같은 키 청구 금지·attempt 보존. 세션 미러 직렬화의 바탕 |
| 7·8 → 17.2 | `검색계획:20`: redact 트랜잭션·fingerprint·조각 writer/part를 소비. 17.3 경유로 이미 전이 선행하지만 소비 책임을 드러내는 직접 표기는 유효 |
| 1 → 8.4·10.8 | `Drive계획:44`의 추출기·unsupported Carry, `첨부계획:103`의 registry·추출 세대 처리. 촬영 필터는 앞선 4 → 8.6 경로로 docs 통합도 받음 |

이니셔티브 epic 4의 after에 epic 12를 더한 것은 위 12.7 산출물 소비를 선언하는 것으로 타당하다(`보드:121`, `에픽:102`, `에픽:107`). 에픽 frontmatter에는 12 전체 gate가 없어도 entry 6의 pin이 있으므로 추가 gate를 요구하지 않는다. V1 뒤 에픽의 기존 전체 gate는 이니셔티브 결정대로 유지된다(`이니셔티브:187`).

공유 Store·PG adapter·등록부·출력 코덱·queue의 한 레인과 앞 에픽 entry에 인계문을 추가하지 않는 예외는 날짜 있는 Decision이다(`에픽:102`). 2가 시험 setup을 소유하고 3~10은 after 경로로 이를 받는다. 기존 엔진·로그 관리·Drive 검색을 중복 구현하라는 entry는 없다. 9는 cleanup만 하며 1~8 모두를 기다린다. 10을 sweep 뒤 배포/설치 확인으로 두고 발견 기능 문제는 버그로 돌리는 예외도 있다(`에픽:106`).

지정 보드 명령은 기본 uv cache의 권한 오류 뒤 다음 명령으로 성공했다. 오프라인으로 기존 Python만 사용했으며 패키지 설치는 없었다.

```sh
UV_CACHE_DIR=/private/tmp/epic4-validate-uv uv run --offline ~/.agents/skills/bmad-agent-po/scripts/tickets.py --project-root "$(git rev-parse --show-toplevel)" status _bmad-output/personal-brain
```

exit 0, `unpinned_after=[]`, `undeclared_after=[]`, `order_conflict=[]`; cycle·drift 오류 없음. epic 4는 refined=true·next_id=11, 10개 entry 모두 planned·file=null이며 순서는 2→3→4→5→6→7→8→1→9→10이다. 이는 스토리 세트 구조의 검사이며 구현 통과 증거는 아니다.

## Done when·spine·위임·개인 데이터

| Done when | 담당과 제한 |
| --- | --- |
| 1 | 2 합성 시간 조회와 10 설치본. SM-2는 F5 |
| 2 | 5 runner, 8·10 전후 비교, 사람 SM-3은 `장부:108`. F5의 판정 연결 필요 |
| 3 | 17.3의 원문 읽기를 2·3이 소비. 이전 이력 표시가 맞음 |
| 4 | 17.3 공통 계약, logs는 3. time 소비·검증은 F2 |
| 5 | 6 결정성·역수집 없음, 7 가리기·경쟁, 10 실제 재생성. F3 필요 |
| 6 | 8·10. “비우고 다시”는 `에픽:97`의 새 세대 전환 결정이 대체하므로 파괴적 비우기를 요구하지 않음 |
| 7 | 8.6의 문서 검색/원본 링크 + 1의 EXIF. 옛 10.9→4.1 이동과 이전 범위가 명시돼 있음 |
| 8 | 4의 동일 모집단·0건·월·meta, 10 설치본 확인 |

AD-11의 출력 코덱 등록·sessionForOutput·원자 redact 미러 enqueue, AD-13 구간 함수, AD-14 D7, AD-15 logs/count, AD-16 snapshot/rename/역수집 금지, AD-24 metadata·추출 세대 확정은 각각 entry에 배정돼 있다. chunks의 part·불변 index_configs와 document_chunks 비변경도 명시됐다. Structural Seed의 `tooling/eval`은 이미 epic 4이며 새 패키지 책임과 맞는다(`spine:693`). spine 갱신 필요 범위는 F4다.

10의 `hitl=false`와 로컬 배포는 `에픽:94`, `에픽:103`의 V1 뒤 동일 위임 및 `이니셔티브:188`~`이니셔티브:192`의 처리 방식에 따른다. 작업 지시의 위임을 다시 ask로 만들지 않는다. SM-3의 사람 채점, 원격 push의 operator_actions, app-ref의 앞선 커밋/version 동반 변경, sweep 뒤 설치본 확인 예외가 모두 남아 있다. 추천 결정은 `장부:87`~`장부:94`에 모여 있다.

5의 결과 파일은 식별자·질의·점수만, 실제 문항·결과는 Brain 홈, 저장소는 중립 fixture라는 제한이 있다(`세트:45`). 질의가 개인 내용을 가질 수 있으므로 이 결과 파일을 공개 plan으로 복사하면 안 되며 10은 공개 투영만 허용한다(`세트:116`). 본문/발췌/원시 응답/오류 상세를 결과에 쓰지 않는 경계와 합성 본문 부재 검증이 있다(`세트:46`). 실제 개인 경로·사진 정보도 plan에서 제외된다. 미러는 사용자가 정한 폴더에 대화 본문을 두는 본래 기능이고 공개 저장소 산출물이 아니다. F3의 옛 파일 정리까지 보완해야 가린 값이 별도 경로에 남는 길도 닫힌다.

이 작업이 새로 작성한 파일은 이 보고서 하나다. 기존 미커밋 에픽·세트·장부 및 다른 워커 소유 파일은 수정하지 않았다.


## 재검증 (2026-10-28)

수정 후 재검증 — 기존 F1~F6·S1 해소, 새 지적 F7 1건(공식 자료로 확인한 EXIF 대안 경로).

Set·Dependencies와 `ticket.md`의 entry 수준 및 high 추가 확인 규칙으로 재검토했다. 아래 약칭은 앞 표와 같으며 행은 재검증 시점이다. 에픽 Notes의 후속 Decision은 앞선 같은 항목의 구체화를 대신하는 것으로 읽었다. 이미 결정한 번호 정책·한 레인·위임·비파괴 rebuild는 다시 논의하지 않았다. 정적 검토와 읽기 전용 보드 조회만 했고 테스트·빌드·Docker·설치·커밋은 하지 않았다.

| 지적 | 판정 | 근거와 판단 |
| --- | --- | --- |
| F1 | 해소 | `에픽:38`, `에픽:108`, `세트:9`에 기존 연결을 소비하는 time·logs 선수집 책임이 있다. `세트:10`은 미수집 합성 transcript가 time 결과에 먼저 반영되고 재호출에 중복이 없음을 본다. 기존 recall 경로와 connector 부재 처리는 `spine:146`의 조건부 선수집 계약을 그대로 소비하며, leaf plan에서 기존 연결의 오류 계약을 함께 참조해야 한다. 새 수집기를 요구하지 않는다. |
| F2 | 해소 | `에픽:38`, `에픽:108`, `세트:9`는 시간순의 뒤쪽을 잘라 epic 17의 budget·limit+1·0건/실패 구분을 소비한다. `세트:10`은 긴 시간 조회와 `meta.next`의 이어 읽기에서 중복·누락 없음을 검증한다. |
| F3 | 해소 | `에픽:42`, `에픽:43`, `에픽:109`, `세트:57`은 충돌 그룹 단위 직렬화·재배정·옛 경로 정리를 소유한다. `세트:58`은 뒤늦게 더 이른 충돌 세션이 들어온 뒤 세션당 파일 하나 및 rebuild 동등성을, `세트:69`·`세트:70`은 재배정 뒤 redact의 옛/새 경로 소거를 검사한다. |
| F4 | 해소 | `spine:286`은 활성/요청 설정·전환·재개·증분/가리기 공존·오래된 완료의 되돌림 금지를, `spine:566`은 포인터 writer를 명시한다. `세트:81`·`세트:82`와 `에픽:110`이 이를 소비한다. `spine:663`도 `에픽:100`의 exifr 우선·exif-reader 대안으로 맞췄다. 반영 누락은 해소됐지만, 대안 자체의 원문 보존 가능성은 새 공식 근거 F7로 별도 지적한다. |
| F5 | 해소 | `세트:81`·`세트:82`, `에픽:111`은 동일 의미 설정 rebuild의 비하락과 규칙 변경 하락의 실패 분류·후속 버그·미달 표시를 둔다. `세트:116`·`세트:117`은 실행 전 private 날짜 질문/기대 기간을 고정해 SM-2 90% 여부를 별도 판정한다. `에픽:111`은 SM-3의 10문항 7건·8문항 4건 사람 채점 잔여를 닫을 때 확인한다. 의미 채점이 필요한 문항은 기존 사람 몫 경계를 유지하고 공개 plan에는 중립 투영만 남긴다. |
| F6 | 해소 | `에픽:112`가 8의 high 추가 확인을 서로 다른 설정의 동시 rebuild와 오래된 완료의 되돌림 금지로 새로 지정한다. 기존 `에픽:105`의 crash 항목은 `세트:82`의 기본 verify로 유지되므로, 추가 확인은 더 이상 같은 검증의 반복이 아니다. |
| S1 | 해소 | `에픽:113`이 2의 PG URL/schema·격리 홈·정리·가짜 clock·임대·snapshot/rename/전환 barrier·kill 뒤 종료 확인을 plan 필수 칸으로 채택했다. 6의 실제 볼륨 확인/정리와 8의 warm/cold·샘플 수·질의·자료 수도 담당한다. 필터를 사용한 측정은 `세트:81`의 측정 조건과 함께 고정해야 하며 지금 시험을 실행한 것은 아니다. |

### F7 — exif-reader 2.0.3 대안은 날짜 원문 보존을 단독으로 충족하지 못한다 (fix)

- 근거: `spine:663`, `spine:404`, `에픽:100`, `세트:93`·`세트:94`; 공식 [exif-reader README](https://github.com/devongovett/exif-reader#usage), [v2.0.3 구현](https://github.com/devongovett/exif-reader/blob/v2.0.3/index.js#L49-L79). 같은 문제를 spine 리뷰 `reviews/review-gate-2026-10-28-u7.md`의 R1에도 기록했다(하나의 문제).
- 새 증거: 공식 API는 EXIF buffer 하나를 받고 날짜 원문 보존 옵션이 없다. 날짜 세 태그를 무조건 `parseDate`로 넘겨 `Date.UTC`의 Date로 바꾼다. 형식 불일치는 null이다. 반면 공식 [exifr 옵션 문서](https://github.com/MikeKovarik/exifr#optionsrevivevalues)는 `reviveValues: false`로 날짜 문자열을 유지하는 경로를 명시한다.
- 결과: exifr의 원문 보존 확인이 실패할 때 대안을 그대로 교체하면 `captured_at_local` 원문 계약을 충족하지 못한다. Date에서 문자열을 다시 포맷하는 것은 원문 보존 증거가 아니며, 시간대 없는 Date를 UTC 촬영 시각으로 쓰면 `captured_at` 계약도 깨진다.
- 교정: exifr 우선 결정은 유지한다. 4.1 plan의 확인 항목에 `reviveValues: false`와 원문/offset fixture를 구체화하고, exif-reader를 택할 경우 원래 태그 문자열을 얻는 별도 경로와 지원 컨테이너 경계를 먼저 입증해야 한다고 spine 표·에픽의 대안 문장에 연결한다. 입증 전에는 단순 대체 가능한 것으로 표시하지 않는다. 버전 고정과 `extractor_version` 반영은 기존대로 구현 때 한다.

보드는 다음 명령을 기존 Python 환경에서 오프라인으로 조회했다(설치 없음).

```sh
UV_CACHE_DIR=/private/tmp/epic4-recheck-uv uv run --offline ~/.agents/skills/bmad-agent-po/scripts/tickets.py --project-root "$(git rev-parse --show-toplevel)" status _bmad-output/personal-brain
```

exit 0. `unpinned_after=[]`, `undeclared_after=[]`, `order_conflict=[]`이며 cycle·drift 오류 없이 반환됐다. epic 4는 refined=true·next_id=11, entry 순서는 2→3→4→5→6→7→8→1→9→10이며 leaf 파일은 모두 null이다. setup 소유와 after 경로는 그대로이며 새 독립 레인이나 미선언 의존성은 생기지 않았다. 이 판정은 스토리 세트의 정적 재검증이며 구현 통과를 뜻하지 않는다.

## 재검증 2 (2026-10-28)

통과 — F7(=spine u7 R1) 해소. 이번 수정 범위에서 새 모순은 발견하지 않았다.

앞선 재검증의 F7과 `_bmad-output/personal-brain/architecture-brain-v1-slice-1/reviews/review-gate-2026-10-28-u7.md`의 R1을 기준으로 에픽 Notes, 세트 entry 1, spine Stack의 미커밋 변경을 정적으로 대조했다. 아래 약칭은 앞 표와 같고 행은 이번 검토 시점이다. 테스트·빌드·설치·커밋은 하지 않았다.

| 대조 항목 | 판정과 근거 |
| --- | --- |
| exifr 우선 경로 | `에픽:100`·`에픽:114`, `세트:93`, `spine:663`이 모두 `reviveValues: false`와 4.1의 날짜·offset 원문 확인을 연결한다. `세트:94`는 시간대 없는 경우 `captured_at`이 비고 `captured_at_local`이 원문 그대로인지 검증한다. 우선 라이브러리 결정과 원문 보존 계약을 함께 유지했다. |
| exif-reader 대안의 채택 조건 | `에픽:100`, `세트:93`, `spine:663`은 원래 태그 문자열을 얻는 별도 경로·태그 매핑·컨테이너 지원을 입증한 경우에만 대안을 허용한다. `에픽:100`은 DateTimeDigitized ↔ CreateDate 매핑도 명시한다. `에픽:114`는 입증 전 단순 대체가 아님을 재확인하고, `에픽:100`·`세트:93`은 Date를 다시 포맷한 값을 원문이라 부르는 우회를 금지한다. F7/R1이 요구한 조건이 세 문서에 연결돼 해소됐다. |
| 기존 계약과의 정합성 | `spine:404`의 원문·시간대를 알 때만 정규형이라는 계약과 `세트:93`·`세트:94`의 시간대 추정 금지·검증이 양립한다. `spine:402`·`spine:663`, `세트:93`의 라이브러리 버전과 `extractor_version` 연동도 유지된다. 새 지적 없음. |

이 판정은 대안 경로를 무조건 교체 가능한 것으로 읽게 하던 문서 결함의 해소다. 실제 exifr 원문·offset fixture 통과, 채택 버전 고정, 대안을 사용할 경우의 원문 획득·태그 매핑·지원 컨테이너 입증은 4.1 구현 때 남아 있으며 이번 검토에서 실행하거나 입증한 것으로 간주하지 않는다. 이번 작업은 이 보고서 끝에 본 절만 덧붙였다.
