do not close — 대조 13항목: met 10 / partly 3 / not met 0; 열린 항목 8건(종료 전 확인·결정 3건, 후속 관리 5건); 구현 배포 누락 0/12커밋.

# 에픽 10 종료 점검 (2026-10-28)

대상 HEAD `c77f502`. 에픽의 기능 구현은 대체로 갖춰졌지만 **10.2에 명시된 마지막 사람 확인을 완료했다고 볼 증거가 없다**. 또한 미지원 형식의 실패 기록 정책과 취소한 sweep의 통합 검증 인계를 명시적으로 정리해야 한다. 자식 `done`만으로 에픽을 닫지 않는다는 Closure 기준(`_bmad/render/bmad-agent-po/second-brain-bbe56f7ddda0/dcffd73a7f031ef42569/references/validate-checks.md:51`)을 적용했다. 이 보고서는 종료 권고이며 사용자 수용 결정을 대신하지 않는다.

에픽·tickets.toml·13개 계획(5줄짜리 dropped 계획 포함), 두 조사·두 세트 검증, 상위 CAP·관련 spine·수신 에픽과 현재 코드·시험·커밋을 대조했다. 이번에는 테스트·빌드·Docker·네트워크·실제 사용자 DB 조회를 실행하지 않았다. 시험 경로는 현재 단언의 근거이고 통과 여부는 기존 계획의 실행 기록이다. 마지막 10.12 기록은 build·typecheck와 non-Postgres 85파일/2,570시험 통과(`tickets/story-untitled-12-plan.md:222`), 뒤의 배포된 데몬 sweep은 전체 회귀 실행 기록도 남긴다(`../epic-daemon/tickets/story-refactor-sweep-plan.md`, Auto Run Result). 이 회귀 기록을 사람의 실제 붙여 넣기 확인으로 대체하지 않았다.

아래 `P`는 `_bmad-output/personal-brain/tickets/epic-attachments/tickets/`, `E`는 `_bmad-output/personal-brain/tickets/`다. `met`은 이 에픽의 합의된 범위에서 충족, `partly`는 구현 근거는 있지만 검증 또는 상위 계약 정합성에 잔여가 있다는 뜻이다.

## 완료 조건과 요구사항

| 항목 | 판정 | 구현·시험·실증 근거와 한계 |
|---|---|---|
| Done when 1 — 한 원본·메시지 위치·추출/실패·가린 조각/검색 제거 | partly | `packages/sqlite/src/attachments.ts:24`의 내용·위치·첨부 멱등 쓰기, `packages/core/src/sessions/ingest.ts:456`의 FileStore 넣기, `packages/core/src/files/extract-work.ts:289`의 세대 생성. `apps/cli/test/files-redact.test.ts:256`은 FTS·이름·블롭 삭제와 external 보존, `:333`은 새 메시지 재수집 후 부활 방지를 확인한다. `packages/sqlite/test/file-redact.test.ts:145`는 metadata와 디스크 잔존도 본다. 실제 이미지 세션의 전체 tracer 사람 확인은 미완료(O1). 검색은 FTS 준비까지이며 사용자 검색/URL 명령은 E8-6/epic 17 소유다. |
| Done when 2 — locator/page·failed_stage·attempt·늦은 포인터 방어 | met | `packages/core/src/domain/chunk-locator.ts`, `packages/core/test/chunk-locator.test.ts:198`·`:204`의 pdf/page·undefined≠null. `packages/sqlite/src/extractions.ts:219`의 트랜잭션 내 max+1, `:354`의 더 큰 attempt 가드, `:371`의 원자적 교체/정리. `packages/core/src/testing/contracts/extraction-store.ts`의 만료·늦은 완료 사례가 fake/SQLite에 공통 실행되고, `packages/sqlite/test/extraction-store.test.ts:169`·`:262`가 FTS 정리·정규형을 확인한다. 실패 단계는 `packages/core/src/files/extract-work.ts:328`에 기록된다. |
| Done when 3 — brain/루트 경계·사용자 원본 보존 | met | `apps/cli/src/runtime/file-store.ts:14`·`:23`의 소유/문법/realpath 검사, `:42`·`:50`·`:51`의 0700/0600·임시 파일→rename. `apps/cli/test/file-store.test.ts:19`·`:47`·`:66`·`:76`이 권한·파일/폴더 링크·남은 임시 파일을 검증한다. `packages/core/src/domain/file.ts:43`의 홈 상대 external 코덱과 `apps/cli/test/files-redact.test.ts:256`의 원본 바이트·mtime 보존. 검사와 I/O 사이 링크 교체 경쟁은 기존 계획이 수용한 한계다. |
| Done when 4 — 멱등 블롭 삭제·external/루트 밖 보존 | met | `packages/core/src/files/blob-delete-work.ts:136`의 이미 삭제된 위치 처리, `:141`의 local/brain 제한, `:150`의 트랜잭션 밖 삭제. `packages/core/test/blob-delete.test.ts:325`·`:344`·`:366`·`:437` 및 CLI 수집 시험의 실제 로컬 블롭 삭제·루트 밖 거부 사례가 있다. 삭제 뒤 표시 실패는 재시도하며 먼저 표시하지 않는다. 고아 자동 순회는 합의된 범위 밖이다. |
| Done when 5 — 같은 크기 닫힌 세션 재읽기·이 기계의 기존 첨부 채우기 | met | `packages/core/src/capture/scan.ts:153`·`:159`, `packages/core/src/sessions/ingest.ts:385`·`:678`. `apps/cli/test/capture-scan.test.ts:299`·`:327`·`:347`은 버전/축소/이미지·@파일 backfill과 재실행 멱등성을 본다. `P/story-untitled-5-plan.md:47`의 DB 사본 실측: 총 330세션 중 310 재읽음(에픽 전 291), transcript 없음 20(에픽 전 19), 남은 실제 이미지 4건은 v5가 이미 저장, v6 추가 0건. 실제 @파일 0건은 compact 복원 파일을 제외한 결과이므로 합성 @파일 시험과 구분한다. 사라진 transcript의 첨부 복구는 요구 범위가 아니다. |
| E10-1 — FileStore port·계약·로컬 보안·내용 주소 | met | `packages/core/src/ports/file-store.ts`, `packages/core/src/testing/contracts/file-store.ts`가 fake/로컬에 공통 적용. `packages/core/src/domain/file.ts:9`는 `sha256:` 해시, `:13`은 `<hh>/<hh>/<hex><ext>` locator다. E10-1의 괄호는 해시와 locator를 혼용하지만 spine AD-23의 실제 주소 규칙과 구현은 일치한다. `P/story-filestore-plan.md:128`의 계약/권한 검증 이력. |
| E10-2 — 이미지·@파일·missing·이름·바이트 없는 spool | partly | `packages/claude-code/src/parser.ts`의 v6 사용자 이미지/attachment 사슬 파싱, `packages/sqlite/src/attachments.ts:24`의 stored/missing 연결, `packages/core/src/sessions/spool-ingest.ts:98`의 연결 메타데이터만 보존하는 spool. `P/story-untitled-4-plan.md:122`는 중복 자리 재읽기 고아 방지 패치 뒤 2,338시험 통과를 기록한다. 실제 이미지 hitl(O1)이 남고, 스캔으로 이번 drain에서 들어온 이름은 다음 drain에 채워진다(DW-1/O4). |
| E10-3 — parser 버전·hook 실패 해소·축소·backfill | met | `packages/core/src/capture/scan.ts:153`, `packages/core/src/brain.ts`의 `sessions.ingest` 성공 후 session_ingest 실패 해소, `packages/sqlite/src/transcript-files.ts`의 읽기 시작 시각 비교. `P/story-untitled-plan.md` Auto Run Result의 전체 2,342시험과 위 Done 5 실측. I104/C2·C4·P19는 기능 근거가 있어 과거 Carry를 미구현으로 다시 세지 않는다. |
| E10-4 — 세대·코덱·청구 회수·FTS 배치·분류·file retry | partly | Done 2의 Store/계약에 더해 `packages/sqlite/test/extraction-store.test.ts:372`가 2,000자×200조각의 2초 배치를 확인(계획 실측 24~37ms). `packages/core/test/document-extract.test.ts:349`·`:395`·`:447`은 일시 읽기/원본 불가·옛 조각 보존/손상 분류. 원문 저장·DB 밖 FileStore I/O도 구현됐다. 다만 `unsupported`/`too_large`를 성공 반환으로 닫고 failures를 해소하는 정책은 AD-21의 영구 오류 첫 기록 규칙과 차이가 있다(O6). |
| E10-5 — txt·md·실패 retry·버전 상승 재추출 | met | `packages/core/src/files/text-extractor.ts`의 엄격 UTF-8·코드 포인트 조각, `extractors.ts`의 `doc/1` 등록부. `packages/core/test/document-extract.test.ts:242`·`:298`·`:613`·`:654`·`:691`은 추출·두 번째 drain 무변화·옛 버전 한 번 재추출·실패 반복 방지·원본 불가 건너뛰기. `packages/sqlite/test/document-extract.test.ts:271`은 새 FTS·옛 세대 제거. `files reindex`를 만들지 않은 것은 명시적 사용자 결정이다. DW-2는 retry의 종류 필터 결함이며 파일 retry 자체 부재와 구분한다. |
| E10-6 — 한 Brain 위치 블롭 삭제 일감 | met | Done 4와 같은 handler·계약. `packages/core/test/blob-delete.test.ts:492`는 `failures retry`의 file_location/blob_delete 재주입도 확인한다. 가리기에서 실제 일감 생산은 `packages/sqlite/src/attachments.ts:305`. 10.11 계획의 “넣는 경로가 아직 없다”는 당시 기록은 10.12로 해소됐다. |
| E10-7 — 파일 가리기 연쇄·확인·생성 차단·첨부 경고 | met | `packages/core/src/files/redact.ts`의 공유 수 읽기 뒤 확인 게이트, `packages/sqlite/src/attachments.ts:222`·`:253`·`:268`·`:279`·`:305`의 한 트랜잭션 연쇄. 진행 중 세대는 조각만 지우고 worker가 redacted로 닫는다(`packages/sqlite/test/file-redact.test.ts:206`). CLI exit 3/무변경은 `apps/cli/test/files-redact.test.ts:215`, 첨부 경고는 `:367`. 메타데이터 생성자는 epic 4.1이 차단 책임을 받는다. 표시 이름·출처/원본 위치 기록까지 지운다고 주장하지 않는다(O7). |
| E10-8 — 0008 변경 규칙 trigger | met | `packages/sqlite/migrations/0008_attachment_rules.sql:7`·`:21`·`:27`·`:45`·`:58`·`:65`·`:72`·`:79`의 8 trigger. `packages/sqlite/test/schema-0008.test.ts:85`·`:104`·`:117`·`:139`의 전이·조각 삭제·가린 이름/metadata 차단·첨부 멱등 회귀와 0007 데이터 보존 시험. spine Table Contract `:567`~`:573`과 일치한다. PostgreSQL 이식은 E11-3/4/6 소유다. |

## 열린 항목과 종료 조치

| ID / 성격 | 빠진 것·근거 | 닫을 사람 | 권장 조치 |
|---|---|---|---|
| O1 / 종료 전 필수 | 10.2 `hitl=true`의 실제 pasted-image 확인 4단계가 여전히 “사람 확인 필요”다(`P/story-tracer-plan.md:145`, `:167`). 자동 CLI 시험·기존 이미지 4건 실측만으로 실제 hook·중복·잠금 spool·도구 이미지 제외의 전체 절차 완료를 증명하지 못한다. | 사람 | 현재 배포 설치본의 임시 Brain 홈에서 계획의 4단계를 실행하고 결과를 기록하거나, 동일 실증을 epic 11의 사람 확인으로 넘긴다는 명시적 범위 수용 결정을 남긴다. 이 결정 없이 단순 close는 권하지 않는다. |
| O2 / 사람 검증 후속 | @파일 실제 세션의 개발용 Stop hook→external·이름 확인이 미실행(`P/story-untitled-4-plan.md:150`). hook 없는 `claude -p` 형식 실측·자동 fixture는 있지만 이 수동 경로 결과는 없다. | 사람 | O1에 실제 홈 아래 @파일 한 건을 함께 넣고 바이트·mtime·external·다음 drain 이름을 기록한다. 필수 hitl로 새로 승격하지는 않는다. |
| O3 / 후속 리뷰 권고 | 10.2 high 패치 뒤 `followup_review_recommended: true`가 남음(`P/story-tracer-plan.md:15`, `:165`). 후속 기능 리뷰들이 이 base64 위험을 닫았다는 기록은 없다. 현재 `packages/claude-code/test/parser.test.ts:1720`·`:1738`은 AQID처럼 패딩 없는 완전 quartet도 다루지만 2/3자 끝·줄바꿈 허용 범위 전체 검증을 뜻하지 않는다. | 에이전트 | 공유 base64 검사와 실제 Harness 표본의 패딩/끝 경계를 집중 재검토하고, 필요한 회귀 시험 또는 지원 입력 규칙을 남긴 뒤 권고를 해소한다. 이번에는 실행하지 않았다. |
| O4 / DW-1 open, medium | 이름 단계가 queue 앞(`packages/core/src/brain.ts:475` 대 `:489`)이라 hook 없는 수집의 이름 FTS가 한 drain 늦다. 원장 `deferred-work.md:176`와 10.5 실측/시험에 명시됨. | 에이전트 | 이름 단계를 queue 뒤 또는 양쪽에 배치하는 후속 티켓, 혹은 반복 drain에서의 지연을 수용한다는 PO 결정을 기록한다. 데이터 유실은 아니며 첫 drain에 검색 가능하다는 약속으로 읽지 않는다. |
| O5 / DW-2 open, medium | `failures list/retry --target-kind`가 camelCase 옵션을 읽지 않아 필터가 무시됨(`apps/cli/src/commands/failures-list.ts:71`, `failures-retry.ts:56`, 원장 `deferred-work.md:184`). 파일만 retry하려다 세션 실패까지 대상으로 삼을 수 있다. | 에이전트 | 키를 `targetKind`로 맞추고 file/session 혼합 fixture로 list/retry를 검증한다. 10.10 이전 결함이므로 에픽 기능 전체를 미구현으로 세지 않지만 실제 열린 결함이다. |
| O6 / 종료 전 정책 결정 | `P/story-txtmd-plan.md:130`은 **에이전트가** unsupported/too_large를 failures에 쓰지 않기로 고른다. 코드 `packages/core/src/files/extract-work.ts:316`·`:337`·`:394` 및 `packages/core/test/document-extract.test.ts:312`가 이를 고정한다. spine AD-21 `:361`의 영구 오류 첫 failures 기록과 상충하며, 현재 사용자 승인 근거는 발견하지 못했다. | 사람(정책), 에이전트(반영) | “추출 상태만 남김” 예외를 사용자에게 수용받아 spine/에픽에 기록하거나 일반 영구 오류 기록으로 맞춘다. 상태 행이 있으므로 무기록 유실은 아니지만 doctor/failures 가시성은 달라진다. |
| O7 / 잔여 위험 수용·PG 인계 | 10.12 가린 해시 조회 실패 시 put 진행/조회와 put 사이 경합은 삭제된 locator에 블롭을 되살릴 수 있다(`packages/core/src/sessions/ingest.ts:435`, `:456`; `P/story-untitled-12-plan.md:223`). 추출/이름은 가드로 막혀도 원본 디스크 소거 절대 보장은 아니다. 진행 중 영구 추출 실패가 가리기 직후 기록되면 unresolved 실패도 남을 수 있다. | 사람(수용), 에이전트(후속) | 기존 reject/잔여 위험을 수용 목록으로 보존하고 PG 이식 때 fail-closed 또는 재정리 경로를 검토한다. 첨부 표시 이름/source_ref와 external 자리 기록은 의도적으로 남는다. 고아 순회가 위치 행의 deleted_at까지 보고 이 부활을 잡는지는 아직 구현 증거가 없으므로 “자동 정리가 해결한다”고 확정하지 않는다. |
| O8 / 종료 전 인계 확인 | 10.13을 drop하며 “마지막 통합 확인은 epic 8 실계정 확인”으로 넘겼다(에픽 `:100`). 수신 `E/epic-drive/epic-drive.md:39`~`:44`에는 Drive·검색·로컬 보관 검증은 있으나 **에픽 10 Done 1~5 전체와 hook 지연/의존 경계 확인을 승계한다는 명시적 Carry는 없다**. | 사람(범위), 에이전트(기록) | epic 8 또는 전환을 먼저 수행할 epic 11에 필요한 통합/사람 확인 책임을 명시하고 원래 sweep의 무엇을 폐기했는지 구분한다. dropped sweep을 몰래 복구하지 말고, O1과 합쳐 최소 실증 범위를 합의한다. |

O1·O6·O8의 결과/수용 결정을 남기고 나머지 후속을 추적 가능하게 수용하면 `close with open items`로 바꿀 수 있다. 현 시점에서는 그 수용이 이미 있었다고 추정하지 않았다. 10.1의 실제 DB 미실행 위험은 10.5 사본 실측으로 일부 보강됐으며, 전체 기능이 현재 실사용 설치본에서 확인됐다는 뜻은 아니다. 10.2·10.4 외 계획에 별도 미실행 hitl을 새로 발견하지는 못했다.

## 이관·제외·상위 계약 정합성

| 범위 | 확인 결과 |
|---|---|
| 10.13 Refactor sweep dropped | 에픽 `:99`·`:100`의 2026-10-26 사용자 결정과 `P/story-refactor-sweep-plan.md:4`에 일치. 남아 있는 tickets.toml의 13번 verify는 실행 책임이 살아 있다는 증거가 아니다. 전면 sweep을 필수 기능으로 되살리지 않는다. 다만 받는 epic 8 파일에서 전체 검증 인계는 명시 확인되지 않아 O8이다. |
| 옛 10.9 EXIF→4.1 | 수신 `E/epic-recall-and-mirror/epic-recall-and-mirror.md:34`의 E4-1·`:44` 및 해당 `tickets/tickets.toml`의 1번에 이미지 EXIF·촬영 일시 세 값이 들어 있다. 이동은 확인, 구현 완료는 아님. 이미 unsupported로 닫힌 이미지는 현 버전 상승 재추출 질의의 성공 파일 대상에 들지 않으므로 EXIF 스토리가 재예약 경로를 정해야 한다(`P/story-untitled-10-plan.md`, Design Notes). |
| PDF·docx→epic 8 | `E/epic-drive/epic-drive.md:32` E8-5·`:72`의 수신 결정에 추출 틀·locator/page·extractor_version 소비가 명시됐다. 확인. 현재 미구현이 에픽 10 누락은 아니다. |
| 문서 본문/이름 검색·files show/url·마스킹 probe | `E/epic-recall-and-mirror/epic-recall-and-mirror.md:74`의 Carry가 원래 인계를 받고 최신 2026-10-28 결정으로 epic 17 선행→epic 8 확장을 명시. `E/epic-drive/epic-drive.md:33`·`:81`·`:82`가 검색·본문 출력 마스킹·files show/probe 수신을 확인한다. epic 10 Boundaries `:52`의 옛 epic 4 표기는 최신 수신 결정으로 해석해야 한다. |
| Drive FileStore·원본 이전·drive 사본 삭제 | `E/epic-drive/epic-drive.md:28`·`:65`의 공통 FileStore 계약/블롭 일감 소비 확인. 10.12가 현재 local/brain만 일감에 넣는 것은 이 분할과 맞는다. Drive 위치의 가리기 삭제 구현은 epic 8이 보완해야 한다. |
| 내보내기·복구 | `E/epic-operations/epic-operations.md`의 범위와 `spine:638`의 문서 세대·조각 포함 계약에 귀속. 에픽 10에 export/import 명령을 요구하지 않는다. WAL 잔존 Carry는 operations `:66`에 있고 `:71`에서 SQLite 삭제 후 대상 소멸/PG 재정의를 명시한다. |
| 고아 자동 순회·doctor 건수/바이트 | 에픽 `:38`·`:99`, spine AD-23 `:386`의 V1 뒤 명시적 제외. 이 작업은 특정 수신 에픽 파일에 새 소유자가 정해져 있다고 확인하지 못했다. 후속 backlog의 소유자를 정하면 좋지만 합의된 제외 자체를 종료 차단 기능 누락으로 세지 않는다. |
| SQLite→PostgreSQL | 에픽 `:103`과 수신 `E/epic-postgres-primary/epic-postgres-primary.md:18`·`:20`·`:24`·`:36`·`:37`·`:39`·`:43`·`:55`에 계약·규칙·가리기·adapter 삭제가 명시됨. **확인, epic 10 결함 아님.** 수신 Notes `:83`의 “10.1 등 리뷰 중”은 HEAD c77f502에서 낡은 상태 문구다. |

spec CAP-1의 자동 수집 중 버전 재읽기/실패 해소, CAP-2의 파일 저장본 가리기, CAP-14의 원본 저장·추출 준비만 이 에픽 몫이다(`spec-brain-v1-slice-1.md:22`, `:25`, `:61`; initiative `:118`~`:123`). 사용자 검색·PDF·EXIF·출력 가리기 전체를 이 에픽에서 모두 끝냈다고 판정하지 않는다. 조사·세트 검증 두 쌍은 인셉션 당시 증거다. 그때의 파일 없음, 미정 PDF·docx, 고아 정리, reindex, EXIF 필수 문구를 이후 사용자 축소 결정보다 우선하지 않았다. 초기 source conflict(조각 실패 정리/열린 세대 종료/파일 경로 색인)는 0008·현재 Table Contract·file_names로 해소됐고, ATTACHMENT_NOT_REDACTED 설명도 10.12에서 마스킹 B에 맞춰졌다.

추가 문서 차이: 10.14 Design Notes에는 media_type으로 `extract` 단계를 추정한다는 옛 문장이 있지만 Implementation Notes의 리뷰 패치와 현재 코드는 “조각 있음 index/없음 read”다. AD-24의 “마지막 단계”는 현재 정확한 단계 추적이 아니라 추정이라는 한계를 가진다. 2초 배치 실측은 현재 1,200자 조각/200개 설정의 증거이고 모든 미래 추출기의 무제한 크기를 보증하지 않는다. txt/md를 모두 text/plain으로 판정하고 8 MiB를 추출 상한으로 둔 결정, @파일 fallback의 크기/줄 수 일치가 내용 동일성을 보증하지 않는 한계, UTF-8로 재현한 CRLF/BOM 차이는 각 계획의 명시적 절충으로 남긴다.

## 릴리스 포함 여부

`plugin/app-ref:1`은 `65b3292a2df852248730a9f64b3ce56b4c1a69e7`, `plugin/.claude-plugin/plugin.json:3`은 `0.1.8`이다. 각 구현 커밋에 대해 `git merge-base --is-ancestor <commit> 65b3292…`를 실행했고 아래 **12개 모두 exit 0**이었다.

| 스토리 | 구현 커밋 | 현재 ref 포함 |
|---|---|---|
| 10.1 | `80a44e3` | 예 |
| 10.2 | `a87386b` | 예 |
| 10.6 | `e0a52d0` | 예 |
| 10.3 | `2626a93` | 예 |
| 10.4 | `b8e7d22` | 예 |
| 10.5 | `5567c9d` | 예 |
| 10.7 | `214c253` | 예 |
| 10.14 | `6b7648d` | 예 |
| 10.8 | `0ab62b1` | 예 |
| 10.10 | `8961c59` | 예 |
| 10.11 | `fb827aa` | 예 |
| 10.12 | `4228a73` | 예 |

`175583e`는 app-ref `e0a52d0`+version `0.1.7`로 10.1/2/6을, `5753961`은 app-ref `65b3292`+version `0.1.8`로 나머지 에픽 10 구현까지 포함해 배포했다. 두 ref 모두 ref를 바꾸는 커밋보다 앞선 커밋이다. 따라서 “에픽 10은 아직 app-ref 배포 안 됨”은 현재 사실이 아니다. `c77f502`의 done 문서와 2026-10-28 계획 개편은 ref 뒤지만 런타임 기능 미배포와 구별한다. 실제 설치본의 개별 자동 갱신 성공·첨부 기능 실증은 저장소 ref 조상성만으로 보증하지 않는다(O1/O2).

## 에픽 11이 보존할 증거

에픽 11은 SQLite adapter·전용 FTS 시험을 지우지만 다음 **동작 계약과 그에 대응하는 시험**은 보존해야 한다. 새 PostgreSQL 요구를 에픽 10의 미구현으로 소급하지 않는다.

- `fileStoreContract`, `attachmentStoreContract`, `fileRedactionContract`, `extractionStoreContract`와 session/transcript 계약: 같은 내용·자리의 멱등, missing 확정, external 보존, parser 재읽기·축소 정착·hook 실패 해소.
- locator의 Core 정규형 바이트와 code point 범위, pdf/page 복사 및 undefined/null 거부, 원문 저장. PG의 text 선택은 수신 E11-3과 `:94`에 이미 명시됐다.
- 파일당 한 열린 세대, 트랜잭션 내 단조 attempt, 만료 회수, 늦은 완료 방어, 성공 교체 원자성, 실패/교체 세대의 검색 제외, source_unreachable의 기존 조각 유지·재예약 금지, 버전 상승 한 번 재추출·file retry.
- 0008의 첨부 자리/출처 불변·한 번 채움·닫힌 세대 불변·가린 이름/metadata 재생성 금지를 PG 직접 SQL 시험으로 유지. SQLite FTS 블록을 검사하는 방법은 PG의 lower/GIN 검색·가리기 검증으로 바꾸되 검색에서 사라지는 결과를 보존.
- 가리기 확인 전 무변경·공유 수 distinct, 한 트랜잭션 파생물 정리/실패 rollback, 진행 중 세대 처리, ATTACHMENT_NOT_REDACTED, 삭제 일감 멱등·부분 실패 복구와 새 첨부의 블롭 부활 방지. 물리 정리의 PG 전용 VACUUM FULL/CHECKPOINT·doctor는 E11-6이 새로 구현한다.
- DB 불가 시 바이트 없는 첨부 spool 및 replay 멱등, 실제 CLI/설치/hook 통합 확인. 빈 PG+transcript 재수집으로 복원 불가능한 과거 첨부를 잃을 수 있다는 것은 이미 사용자 수용된 전환 정책(`E/epic-postgres-primary/epic-postgres-primary.md:26`, `:84`)이며 에픽 10 종료 결함으로 재분류하지 않는다.

종료 후에도 O3~O5·O7과 O2의 소유·검증 결과가 사라지지 않게 해야 한다. 특히 SQLite 시험 삭제가 기존 검증 공백까지 해소했다는 증거가 되지는 않는다.
