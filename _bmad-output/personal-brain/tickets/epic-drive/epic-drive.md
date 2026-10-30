---
type: epic
title: "Google Drive 연동"
parent: personal-brain
covers: [CAP-14, CAP-6, CAP-7, CAP-12]
sources: [_bmad-output/personal-brain/initiative-personal-brain.md, _bmad-output/personal-brain/spec-brain-v1-slice-1/spec-brain-v1-slice-1.md, _bmad-output/personal-brain/architecture-brain-v1-slice-1/architecture-brain-v1-slice-1.md]
companions: [_bmad-output/personal-brain/architecture-brain-v1-slice-1/architecture-brain-v1-slice-1.md, _bmad-output/personal-brain/tickets/epic-drive/epic-drive-research-code.md]
after: []
assignee: ""
refined: true
risk: high
---

# Google Drive 연동

## Description

Drive API로 Drive를 직접 다룬다. Drive는 5TB이고 Mac은 512GB라서 Mac에 동기화하지 않는다.
- 연동하면 Brain이 맡은 첨부 원본이 Drive로 옮겨 간다. 순서는 업로드 → 해시 검증 → `home` 전환 → 로컬 삭제 일감이다.
- 사용자가 고른 기존 Drive 폴더의 문서는 목록 → export 또는 임시 다운로드 → 추출 → 삭제 순서로 텍스트만 색인한다. 바뀐 것은 changes API로 반영한다. 동기화는 drain의 일감 종류(`source_sync`)이고 데몬이 주기적으로 넣고 돈다(AD-27, 2026-10-26). `brain sources sync`는 그 일감을 지금 만들어 돌리는 명령이다. 사진·큰 파일은 내려받지 않고 메타데이터와 폴더·파일 이름만 남긴다.
- 연동 해제는 Drive에 둔 채 연결만 끊는다.
- DB 스냅샷을 Drive에 보관해 새 기계에서 복구한다. 나중에 `/brain:db-migration` 스킬이 이것을 감싼다. (V1 뒤, 2026-10-26)
- 문서 찾기: 대화 첨부와 Drive 문서·사진을 본문 단어와 폴더·파일 이름으로 찾고 원본 링크를 붙인다(epic 4에서 옮겨 옴, 2026-10-26).

코드 조사(2026-10-28, `epic-drive-research-code.md`)가 찾은 것은 다음과 같다.
- FileStore port의 `put` 반환 위치가 local·brain으로 고정돼 있고, 계약 시험도 local locator를 직접 단정한다. Drive 구현 전에 backend 중립 계약으로 나눠야 한다.
- 이동 확정 use case(검증 시각과 `home` 전환을 한 트랜잭션에)가 없다. blob 삭제 일감은 만든 시각을 due로 써서 보관 기간 예약을 따로 받아야 한다.
- `file_names`는 file_id가 필수라 내려받지 않은 Drive 사진의 이름을 넣을 자리가 없다.
- 지금 추출기는 text 하나이고, `unsupported`로 닫힌 파일은 실패 행도 없어 재시도나 버전 상승으로 살아나지 않는다(Carry).
- Drive v3 changes 토큰은 공식적으로 만료되지 않는다. Google Docs export는 10MB 상한이다. `drive.file` scope로는 기존 폴더 전체를 읽을 수 없다.

## Outcome

로컬 용량과 상관없이 첨부와 Drive 문서·사진이 본문과 이름으로 찾아지고 원본이 열린다. 기계를 바꿔도 되살리는 것(스냅샷)은 V1 뒤다(2026-10-26).

## Requirements

- E8-1 (CAP-14, 원본 이전 부분): OAuth(데스크톱 앱), Drive `FileStore` 구현(epic-attachments의 계약 테스트 통과), 첨부 원본 이전. 옮긴 원본의 Mac 사본은 사용자 설정 보관 기간(`drive.keep_local_days`, 기본 30일, 0이면 검증 직후)이 지난 뒤에 블롭 삭제 일감으로 지운다(2026-10-27). 로컬 캐시 상한은 V1 뒤(2026-10-26). (AD-18·23)
- E8-2 (CAP-14, 외부 문서 색인 부분): 감시 폴더 목록, 외부 소스 테이블(새 마이그레이션: source, remote file id, 이름, 부모 경로, 원격 버전, 연결된 content id(내려받기 전 null), changes 토큰), 문서만 추출, 사진·큰 파일은 메타데이터와 이름만, 원본 삭제 시 `source_unreachable`. 기존 `files`(내용 해시 식별)에 내려받지 않은 파일을 넣지 않는다(2026-10-26). (AD-23·24·27)
- E8-3 (CAP-14): 연동 해제. 검색은 계속되고 원본은 접근 불가로 표시하며, Drive 사본은 지우지 않는다.
- E8-4 (CAP-12, Drive 스냅샷 부분): DB 스냅샷의 Drive 업로드와 새 기계 복구. **V1 뒤(2026-10-26).**
- E8-5 (CAP-14, 형식별 추출 부분): PDF(텍스트 PDF, 조각 locator의 쪽과 `page` 사본)·docx(블록) 추출기. epic-attachments의 추출 일감·형식 판정·`extractor_version` 위에 얹는다(2026-10-22, epic-attachments 인셉션에서 옮겨 옴). (FR-28, AD-24)
- E8-6 (CAP-14·6·7, 문서 찾기 부분, epic-recall-and-mirror에서 옮겨 옴, 2026-10-26): 대화 첨부와 Drive 문서·사진을 문서 본문 단어·폴더 이름·파일 이름으로 찾고, 결과에 원본 링크(로컬 경로 또는 Drive 링크)와 위치(쪽·글자 범위)가 붙으며, 미색인 파일은 표시된다. 공백 든 질의와 `a-b`·`AND`·`"` 같은 질의가 오류나 조용한 0건 없이 처리된다. 출력은 Core 출력 코덱(마스킹)을 거친다. (FR-28, AD-11·15)

- E8-7 (CAP-11, 2026-10-27) → 2026-10-28 epic-postgres-primary로 옮겼다(이 에픽은 그 `settings`·`brain config`를 쓴다): 사용자 설정 — PC를 옮겨도 따라가야 하는 사용자 선택값을 DB의 `settings` 테이블(새 마이그레이션, epic-daemon 0009 다음 번호)에 두고, `brain config get/set`이 키마다 정해진 자리에 읽고 쓴다(마이그레이션 번호는 epic-postgres-primary의 실행기가 정한다, 2026-10-28): 기계마다 다른 값(경로, node, `[update] auto`)은 `config.toml`, 사용자 선택값은 DB, 비밀(Drive 로그인 토큰 등)은 `.env`. 첫 사용자 설정 키는 `drive.keep_local_days`. 플러그인 슬래시 명령은 epic 3의 플러그인 스킬 작업에서 이 명령을 감싼다.

## Constraints

- 사용자의 외부 파일을 옮기거나 지우지 않고, Drive 사본도 Brain이 만든 Brain 루트 폴더 안의 것만 쓰고 지운다(AD-23).
- 검증 없이 마지막 사본을 지우는 경로가 없다. 로컬 사본은 보관 기간이 지나고 원격 사본을 다시 확인한 뒤에만 지운다.
- 외부 I/O(업로드·목록·내려받기·export) 동안 DB 쓰기 트랜잭션을 잡지 않는다(AD-7).
- 토큰·client secret은 `.env`에만 둔다(AD-18). 시험은 가짜 Drive·OAuth 서버로 하고, 실계정은 마지막 이 Mac 스토리에서만 쓴다.
- 공개 plan에 실제 파일 이름·본문·토큰을 쓰지 않는다.

## Done when

1. 연동하면 첨부 원본이 Drive로 옮겨지고, 로컬 사본은 검증 뒤에만 지워진다.
2. 고른 Drive 폴더의 문서(txt·md·텍스트 PDF·docx)가 Mac에 남지 않은 채 본문으로 검색되고, 결과에 Drive 링크가 붙으며, PDF 조각은 쪽을 가진다. 사진은 폴더 이름과 파일 이름으로 찾힌다.
3. Drive에서 바뀐 문서가 데몬의 다음 동기화 주기에서 반영된다.
4. 연동 해제 뒤에도 검색되고, 원본은 접근 불가로 표시된다.
5. 대화에 붙인 파일도 본문·이름으로 찾아지고 원본이 열린다(E8-6).
6. Drive로 옮긴 첨부 원본의 Mac 사본은 설정한 보관 기간이 지난 뒤에만 지워지고, 그 기간은 `brain config set`으로 바꾸면 DB에 남아 DB와 함께 옮겨진다(2026-10-27. 이전의 "옮기기 전에 epic 5의 로컬 백업이 있다"는 epic 5와 함께 V1 뒤).

7. 기능 묶음이 플러그인 배포(app-ref·version)로 이 Mac의 설치본에 들어가 동작한다(2026-10-28, 트리 검증).

(2026-10-26: 이전 Done when 5 "새 Mac에서 Drive 스냅샷으로 복구하면 건수가 같다"는 V1 뒤, 6 "데몬 켜짐·꺼짐 둘 다에서 통과"는 삭제했다.)

## Boundaries

AD-11·15·23·24·27. 사용자의 외부 파일은 옮기거나 지우지 않는다. 기록의 원본(2026-10-28부터 PostgreSQL)은 Drive로 옮기지 않는다. 임베딩은 쓰지 않는다. OCR, HWP, 좌표의 장소 이름 변환은 범위 밖이다.

## References

- parent — _bmad-output/personal-brain/initiative-personal-brain.md
- spec — _bmad-output/personal-brain/spec-brain-v1-slice-1/spec-brain-v1-slice-1.md, Capabilities CAP-12, CAP-14
- architecture — _bmad-output/personal-brain/architecture-brain-v1-slice-1/architecture-brain-v1-slice-1.md, AD-23, AD-24, AD-25, Deferred
- change — _bmad-output/personal-brain/change-local-sqlite-primary/change-local-sqlite-primary.md, §7
- inputs — _bmad-output/personal-brain/inputs/weknora-patterns.md, §2 (조건부: lease 먼저 적기, 저장 보상과 삭제 순서, 참조 수 삭제, 배치 엔벨로프)
- research — _bmad-output/personal-brain/tickets/epic-drive/epic-drive-research-code.md (2026-10-28 정적 코드 조사와 공식 문서 확인)

## Notes

- Decision(2026-10-14): Drive 데스크톱 동기화가 아니라 API를 쓴다(5TB vs 512GB). 연동 해제는 Drive에 둔 채 끊는다(b). 연동하면 첨부의 원본(SoT)이 Drive로 옮겨 간다(사용자).
- Waits on epic-attachments because: `FileStore` port와 로컬 구현, 첨부 저장, 추출 일감(2026-10-15 epic-capture에서 나뉨).
- (삭제 2026-10-27) Waits on epic-operations because: 첨부 원본을 Drive로 옮기기 전의 로컬 백업 — epic-operations를 V1 뒤로 미뤘다.
- Waits on epic-daemon because: 주기 동기화(`source_sync`)와 파일 감시를 데몬이 돈다(2026-10-26. 이전 이유였던 데몬 켜짐·꺼짐 두 상태 검증은 삭제).
- Note(2026-10-16, `../../change-users-and-review-gaps/`, 인셉션 입력): D5 가리기 이전의 DB 스냅샷은 새 스냅샷이 검증된 뒤 지운다(spine AD-11). Drive 기록 복제 파일의 다시 쓰기는 epic-replicas 몫이다(→ 2026-10-28 epic-replicas drop. 기록 사본은 epic-operations 인셉션 입력).
- Note(2026-10-16, 인셉션 입력): Drive API 오류에 분류 코드를 붙인다. 429·5xx·네트워크는 일시 오류이고 `Retry-After`를 따른다. 403·404·삭제됨은 영구 오류다(spine AD-21 재시도 분류).
- Note(2026-10-16): Drive 일감 실패의 다시 하기는 `failures retry`에 대상 종류를 더해서 한다(2.12가 명령을 만든다, spine AD-5).
- Note(2026-10-19, `../../change-masking-b-and-review-fixes/`, 인셉션 입력): 마스킹 B. Drive로 올리는 DB 스냅샷도 나가는 길이다. 가린 사본을 만들어 올리고, 그것으로 되살린 Brain의 비밀은 가린 채 돌아온다(D6). 첨부 원본 바이트는 가리지 않는다(`files.redact`가 그 길).
- Decision(2026-10-22, epic-attachments 인셉션, 사용자): PDF·docx 추출기가 epic-attachments에서 이 에픽으로 왔다(E8-5). 한 달 실측에서 사용자가 대화에 붙인 PDF·문서는 0건이고 첫 실사용은 기존 Drive 문서 색인이다. 추출 틀은 epic-attachments가 만든다.
- Decision(2026-10-26, `../../change-v1-capture-and-drive/`, 사용자): Drive는 V1이다. 순서는 데몬(9) → 첨부·추출(10, 축소) → 로컬 백업(5) → 이 에픽. 문서·폴더명 검색(E8-6)을 epic 4에서 옮겨 왔다. 스냅샷·새 Mac 복구(E8-4)와 로컬 캐시 상한은 V1 뒤. 촬영 일시 검색은 EXIF(epic-recall-and-mirror 1, 옛 10.9)와 함께 V1 뒤.
- Note(2026-10-27, epic-daemon 쪼개기): 인셉션 때 Done when에 "데몬 없이도 이 에픽의 테스트가 통과한다"를 이어받는다(epic-daemon Done when 1). epic-daemon은 `[files] path`를 감시하지 않으므로, Drive 쪽에 감시가 필요하면 이 에픽이 더한다. 마이그레이션은 epic-daemon의 0009 다음 번호를 쓴다.
- Decision(2026-10-27, 사용자): epic-operations(로컬 백업·스키마 가드·`setup upgrade`)를 V1 뒤로 미룬다 — 쓰면서 확인하고 버그로 고칠 일이고, 자동 업데이트가 `setup upgrade`를 대신하며, 스키마 불일치 거부는 epic 1·2가 이미 했다. 백업이 맡던 안전장치는 이 에픽의 원본 보관 기간(E8-1, Done when 6)이 대신한다. 지금 Brain이 보관한 첨부 원본은 3개이고 기록(SQLite)은 Drive로 옮기지 않는다.
- Decision(2026-10-27, 사용자): 사용자 설정은 DB가 원천이다(PC를 바꿔도 DB와 함께 옮겨짐). `config.toml`은 기계마다 다른 값만, 비밀은 `.env`. `brain config get/set`을 이 에픽에 둔다(E8-7). 시간대처럼 이미 `config.toml`에 있는 사용자 선택값을 DB로 옮기는 일은 나중에 정한다(→ 2026-10-28: 시간대는 epic-postgres-primary가 옮긴다).
- Source conflict: spine AD-19 / Conventions(설정은 `config.toml`, 런타임 상태는 설정 코덱 밖) — E8-7은 사용자 설정을 DB `settings` 테이블에 둔다. `bmad-architecture`로 AD-19를 고친다(2026-10-27). → 2026-10-28 문서로는 해소됐다(spine AD-18이 기계 값·DB 사용자 설정·비밀을 나눔). 구현은 epic 11(11.6)이 한다(코드 조사 7절).
- Decision(2026-10-28, `../../prep-garmin-absorption/`, 사용자): 순서를 PostgreSQL(epic 11) → 공통 기반·Garmin(12~17) → 이 에픽으로 바꿨다. Drive는 Garmin의 선행 조건이 아니다(이니셔티브 C2). 이 에픽은 PostgreSQL 위에서 만든다.
  - 외부 소스 테이블(E8-2) 마이그레이션은 epic 11의 마이그레이션 실행기에서 다음 번호를 쓴다. "epic-daemon 0009 다음"은 SQLite 번호였다.
  - E8-7은 epic 11로 옮겼다. Done when 6은 그 명령을 쓴다.
  - E8-6은 epic 17의 공통 텍스트 검색·원문 읽기 경로와 결과 계약에 첨부·Drive 문서 대상을 더한다. 검색 경로를 따로 만들지 않는다.
  - 2026-10-28(재분할 트리 검증 F3): 문서 결과 종류, `files show`, 문서 조각의 출력 코덱 probe는 epic 17이 분석 리포트 파일로 먼저 만든다. E8-6은 거기에 첨부·Drive 문서·파일·폴더 이름 대상과 Drive URL을 더한다.
  - spine AD-19의 설정 충돌은 PostgreSQL 아키텍처 갱신에서 함께 고친다.
- Waits on epic-postgres-primary because: PostgreSQL Store와 마이그레이션 실행기, 사용자 설정 DB와 `brain config`(E8-7)가 필요하다.
- Waits on epic-search-and-health-query because: 공통 텍스트 검색 경로와 결과 계약 위에 문서 대상(E8-6)을 더한다.
- Carry(2026-10-28, epic-attachments 닫기): 지금 붙인 PDF·docx는 추출기가 없어 `unsupported`로 닫힌다. 추출기 버전이 올라가도 `unsupported`·`too_large`는 다시 넣지 않는 규칙이라(`listFilesWithStaleExtraction`), E8-5가 PDF·docx 추출기를 더할 때 새 추출기가 읽을 수 있게 된 형식의 `unsupported` 파일을 다시 넣는 경로를 함께 만든다. 형식별 크기 상한도 E8-5가 정한다(텍스트의 흘려 읽기는 backlog `story-large-attachments-streamed`).
- Decision(2026-10-28, 정제, 추천으로 정함): Drive locator는 지금처럼 내용의 순수 함수(`<hex><확장자>`, Brain 루트 폴더 안의 파일 이름)로 두고, `(루트, content_hash) → remote file id`와 업로드 상태를 별도 표에 영속한다. Drive 이름은 유일하지 않으므로 멱등 키로 믿지 않는다. locator에 remote id를 넣는 안은 AD-23의 순수 함수 결정과 충돌해 쓰지 않는다.
- Decision(2026-10-28, 정제, 추천으로 정함): 업로드 검증은 `sha256Checksum`이 있으면 그것, 없고 `md5Checksum`이 있으면 같은 로컬 바이트의 MD5와 비교, 둘 다 없으면 되읽어 SHA-256으로 비교한다. MD5를 `content_hash`로 쓰지 않는다. 5MiB 넘는 파일은 resumable 업로드이고 session URI·remote id·확인한 offset을 일감 상태에 남긴다.
- Decision(2026-10-28, 정제, 추천으로 정함): 이전 확정은 한 트랜잭션이다: 원격 위치 등록, `verified_at`, `home` 전환, 로컬 삭제 일감 예약(due = 검증 시각 + `drive.keep_local_days`)을, 예상한 이전 `home`과 가리지 않은 상태를 CAS로 다시 확인하며 함께 확정한다. 삭제 handler는 실행 때 현재 설정으로 due를 다시 계산하고(줄이면 앞당겨지고 늘리면 미뤄짐, 설정보다 일찍 지우지 않음), 지우기 직전 원격 사본의 존재와 크기를 다시 확인한다. 원격에 닿지 않으면 지우지 않고 나중에 다시 한다.
- Decision(2026-10-28, 정제, 추천으로 정함): scope는 `drive.readonly`(고른 기존 폴더 읽기)와 `drive.file`(Brain 루트 폴더 쓰기)이다. 토큰은 `.env`의 `BRAIN_DRIVE_CLIENT_ID`·`BRAIN_DRIVE_CLIENT_SECRET`·`BRAIN_DRIVE_REFRESH_TOKEN`이고, access token은 저장하지 않고 실행마다 refresh한다(원자 갱신 문제를 피한다). OAuth는 데스크톱 loopback + PKCE S256 + state다. `invalid_grant`는 재동의 필요(다시 하지 않는 오류, doctor), 401은 refresh 한 번 뒤에도 실패하면 로그인 필요, 429·5xx·네트워크는 일시 오류다.
- Assumption(2026-10-28): Google OAuth 동의 화면이 "Testing" 상태면 restricted scope의 refresh token이 7일 뒤 만료된다고 알려져 있다. 그러면 무인 동기화가 주마다 끊기므로, 동의 화면을 "In production"(미검증 개인 앱)으로 두는 것을 사람 몫 안내에 넣는다. 8.3이 공식 문서로 확인하고 다르면 안내를 고친다.
- Decision(2026-10-28, 정제, 추천으로 정함): 명령은 `brain sources connect drive`(OAuth, 동의 URL 출력), `brain sources add <폴더 URL|id>`, `brain sources list|remove|sync|disconnect`다. Brain 루트 폴더는 connect 때 Brain이 만들고 id를 DB 설정 `drive.root_folder_id`에 둔다. 감시 폴더는 `drive.watch_folders`, 동기화 주기는 `drive.sync_interval_minutes`(기본 30)이고 epic 12의 예약으로 돈다.
- Decision(2026-10-28, 정제, 추천으로 정함): 외부 소스는 `sources`(종류·계정·상태·changes cursor, 계정마다 cursor 하나)와 `source_files`(source, remote file id UNIQUE, 이름, 부모 경로, MIME, 원격 버전, content id nullable, unreachable 시각, 색인 상태)다. 첫 목록 전에 changes start token을 받아 두고, 목록이 끝난 뒤 그 token부터 증분을 적용한다. 페이지마다 변경과 다음 cursor를 한 트랜잭션에 확정한다. cursor가 거부되면 전체 재목록이고, 재목록이 성공하기 전에는 기존 항목을 접근 불가로 바꾸지 않는다.
- Decision(2026-10-28, 정제, 추천으로 정함): 내려받지 않은 사진·큰 파일은 `files`에 넣지 않고 `source_files` 이름으로 검색된다. 결과는 epic 17의 `document` 결과를 넓혀 `file_id` nullable·`source_file_id`·색인 상태(`photo` | `too_large` | `unsupported` | `pending` | `failed`)를 싣고, 없는 locator를 지어내지 않는다. Drive 링크는 source 전용 resolver가 remote id로 만든다(FileStore의 brain 소유 제한을 풀지 않는다).
- Decision(2026-10-28, 정제, 추천으로 정함): Google Docs는 `text/plain`으로 export한다(text locator). PDF는 pdfjs-dist의 텍스트 경로(canvas 없이), docx는 mammoth의 원시 텍스트와 문단 번호를 block locator로 쓴다. 라이브러리는 runtime adapter에서 import하고 Core는 DocumentExtractor로 주입받는다. 상한: PDF 50MiB·2,000쪽·추출 500만 자, docx 압축 50MiB·해제 200MiB·추출 500만 자. 이미지 PDF는 텍스트 없음 상태로 안내한다(OCR은 범위 밖). Carry: 새 추출기가 읽게 된 형식의 과거 `unsupported` 파일은 바이트의 형식 판정으로 다시 골라 추출기 버전마다 한 번 다시 넣는다(저장된 MIME만 믿지 않음).
- Decision(2026-10-28, 정제, 추천으로 정함): 연동 해제는 동기화 예약 중지·새 청구 금지·진행 일감의 늦은 확정 차단(source 세대 확인) → 연결 상태 변경·`.env`의 Drive 토큰 삭제 → 원본 접근 불가 표시 순이다. 아직 돌지 않은 로컬 사본 삭제 일감은 취소한다(Drive에 닿지 못하게 된 뒤 로컬이 유일한 접근 가능 사본이므로). Drive 파일은 지우지 않고, 원격 토큰 폐기 실패가 로컬 해제를 막지 않는다.
- Decision(2026-10-28, 스토리 계획): tracer는 1이다. 가짜 Drive 서버에 합성 txt 첨부 원본 하나가 올라가 검증되고, 한 트랜잭션으로 `home`이 Drive가 되며, 보관 0일이면 로컬 사본이 지워지고, `brain files show`가 Drive 위치에서 원문을 읽는다. 다음은 가장 덜 확실한 2(외부 폴더 문서 색인: 임시 바이트·이름만 있는 사진·이름 검색)다. 그다음 3(OAuth·설정·연동 해제), 4(PDF·docx·Carry), 5(증분 동기화·중단 재개·보관 경계), 6(문서 찾기 통합), 7(Refactor sweep), 8(이 Mac 확인)이다. 코드 조사의 순서안 A·B를 섞어, 원본 이전 불변식을 먼저 관통한 뒤 첫 실사용인 Drive 문서 색인을 일찍 확인한다.
- Decision(2026-10-28, 스토리 계획): FileStore·Store port·PG 마이그레이션·조립·설정 코덱·명령 등록부·epic 17의 검색 경로를 모든 스토리가 함께 고친다(코드 조사 8절). 그래서 1~8은 한 줄이다. 1은 epic 17의 마지막 코드 스토리(17.6)를 기다린다(앞 에픽 선례). 동기화 일감이 epic 12의 작업 runtime·예약·취소를 쓰므로 epic 12를 이 에픽의 `after`에 더했다. epic 11·12·17 쪽 entry에는 인계 문장을 더하지 않고 받는 쪽이 적는다(같은 명시적 예외).
- Decision(2026-10-28, 추천으로 정함): 모든 entry가 `hitl = false`다. 8의 실계정 단계는 OAuth client 만들기·동의 화면 상태·동의를 사람이 하지 않았으면 그 단계만 `awaiting-operator`이고, 에이전트가 나머지(격리 홈 확인, 설치본 명령, 안내)를 먼저 한다.
- Decision(2026-10-28, 추천으로 정함): risk와 그 이유.
  - 1 high: 마지막 사본을 잃을 수 있는 유일한 길이다.
  - 2 high: 외부 색인이 틀리면 Mac에 사본이 남거나 이름 검색이 빠진다.
  - 3 medium: OAuth가 틀리면 연동이 안 된다. 기록은 남는다.
  - 4 medium: 추출이 틀리면 PDF·docx 본문이 빠진다.
  - 5 high: 중단 재개가 틀리면 중복 업로드·누락·이른 삭제가 생긴다.
  - 6 medium: 결과가 섞이면 같은 문서가 두 번 나오거나 미색인이 숨는다.
  - 7 low: 정리다.
  - 8 medium: 실계정에서만 드러나는 scope·토큰 수명 문제를 놓친다.
- Waits on epic-jobs-and-scheduler because: 동기화 주기를 공통 예약으로 등록하고, 긴 sync·업로드가 작업 runtime의 취소·진행 이벤트를 쓴다(2026-10-28 정제).
- Decision(2026-10-28, 스토리 계획): 1은 epic 10의 sweep(10.13)과 epic 9의 sweep(9.7)을 교차 `after`로 고정한다(둘 다 닫힌 에픽이라 실제로는 이미 충족). FileStore·추출 세대와 데몬 예약 틱을 받는다.
- Decision(2026-10-28, 세트 검증 F1): 먼저 쓰는 설정과 진입점의 분담. 1이 `drive.keep_local_days`의 등록·검증·DB 읽기 최소형을, 2가 가짜 서버로 돌릴 수 있는 `brain sources sync`의 CommandSpec·SDK·메타 최소형을 만든다. 3은 OAuth와 나머지 명령·설정·예약을 끝낸다. 뒤 스토리를 앞의 `after`에 넣지 않는다.
- Decision(2026-10-28, 세트 검증 F2): 이름 전용 결과와 외부 소스 표를 spine에 같은 날 반영했다(AD-15 결과 계약의 `file_id` nullable과 `files show`의 source 경로, AD-23 외부 source 내용의 home 예외와 backend별 locator 예, AD-24 source별 접근 불가의 경고·재추출 금지, Table Contract의 `sources`·`source_files`·`drive_uploads`). 가짜 file_id·locator는 만들지 않는다.
- Decision(2026-10-28, 세트 검증 F3): 보관 기간을 줄이면 이미 예약된 삭제 일감의 due를 다시 계산해 깨우는 기능은 5가 만들고, 3이 둔 설정 변경 확장 지점에 5가 직접 연결한다(재검증 F6: 3이 뒤 스토리의 기능을 부르는 선행 역전을 없앰). 삭제 handler의 실행 때 재확인도 그대로 둔다. 연동 해제로 취소된 삭제는 되살리지 않는다.
- Decision(2026-10-28, 세트 검증 F4): high entry의 추가 확인(verify와 별도, leaf를 만들 때 이어받는다).
  - 1: 업로드 뒤 home 확정 전에 `files.redact`를 끼워 CAS와 삭제 경로를 따로 검토한다.
  - 2: 임시 바이트를 만든 뒤 프로세스를 죽이고, 재시작 정리가 자기 소유가 아닌 파일을 보존하는지 확인한다.
  - 5: 연동 해제와 만료 삭제의 경합을 따로 확인한다.
- Decision(2026-10-28, 세트 검증 F5): 7(Refactor sweep)은 코드 스토리 1~6의 정리를 닫는다. 8의 배포·실계정 확인은 그 뒤 따로 둔다(앞 에픽들과 같은 예외). 8에서 찾은 기능 문제는 버그 스토리로 고치고 다시 확인하며 7에 넣지 않는다. OAuth 동의 전이거나 실제 확인이 실패하면 설치본·실계정 완료로 세지 않는다.
- Decision(2026-10-28, 세트 검증 S1·S2·S3 채택): 1의 plan 상한은 정상 txt 한 건에 필요한 계약 case·DDL·왕복이고, OAuth·resumable·오류 행렬·외부 source는 뒤에 남긴다. 각 plan은 공용 가짜 서버 시작·종료, 격리 PG·홈, OAuth callback·clock 제어, 합성 PDF·OOXML·상한 초과 fixture를 대량 할당 없이 만드는 법, 페이지 commit barrier와 kill 대상·재시작 명령을 적고, 데몬 없는 handler 시험과 실제 데몬 예약 연결 확인의 진입점을 따로 적는다. resumable session URI·OAuth code·verifier·client secret·외부 오류 원문은 queue·doctor·로그·plan에 내보내지 않고 합성 표식으로 확인한다.
- Decision(2026-10-28, spine 갱신 u4 Reviewer Gate R1~R3): source 단위 접근 불가는 그 source 출처에만 경고를 붙이고, `files.source_unreachable_at`은 쓸 수 있는 원본이 하나도 없을 때만 쓰고 돌아오면 해제한다(2·5). Drive FileStore의 모든 연산은 `drive_uploads` 매핑 하나로 remote id를 해석하고 이름 검색을 쓰지 않으며, 매핑 저장 함수는 이전 일감과 put이 공유한다(1). 가린 내용에 연결된 Drive 항목의 이름·경로·링크는 source 이름 검색과 `files show`에서 빠진다(2·6).
- Decision(2026-10-30, 사용자): 에픽마다 두던 Refactor sweep(8.7)을 뺐다(`dropped`). 리뷰가 미룬 기존 결함은 `deferred-work.md` 장부에 남고, 사용자가 원할 때 `bmad-loop sweep`으로 직접 처리한다. 이 Mac 확인(8.8)은 sweep 대신 sweep이 기다리던 스토리들을 기다린다.
