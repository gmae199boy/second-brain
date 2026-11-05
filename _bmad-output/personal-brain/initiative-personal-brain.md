---
type: initiative
title: "어떤 에이전트로 일해도 이어지는 나의 작업·건강 기억"
parent: none
covers: [CAP-1, CAP-2, CAP-3, CAP-4, CAP-5, CAP-6, CAP-7, CAP-8, CAP-9, CAP-10, CAP-11, CAP-12, CAP-13, CAP-14]
sources: [_bmad-output/personal-brain/prep-garmin-absorption/accepted-intent.md, _bmad-output/personal-brain/spec-brain-v1-slice-1/spec-brain-v1-slice-1.md]
companions: [_bmad-output/personal-brain/spec-brain-v1-slice-1/spec-brain-v1-slice-1.md, _bmad-output/personal-brain/architecture-brain-v1-slice-1/architecture-brain-v1-slice-1.md, _bmad-output/personal-brain/architecture-brain-v1-slice-1/garmin-extension-redesign-disposition.md, _bmad-output/personal-brain/prd-brain-v1-slice-1/prd-brain-v1-slice-1.md, _bmad-output/personal-brain/prep-garmin-absorption/integration-boundaries.md, _bmad-output/personal-brain/prep-garmin-absorption/migration-contract.md, _bmad-output/personal-brain/decisions-by-recommendation.md]
after: []
assignee: ""
risk: high
---

# 어떤 에이전트로 일해도 이어지는 나의 작업·건강 기억

## Description

Personal Brain V1 slice 1. Claude Code 세션을 자동으로 수집하고, 대화에 준 파일과 고른 Google Drive 폴더의 문서·사진을 수집해 본문과 폴더 이름으로 찾는다. 작업 로그·시작 맥락·규칙은 V1 다음이다(2026-10-26). 기능·제약·비목표는 spec이 갖고, 구현 불변식은 architecture spine(AD-1~28, Table Contract)이 갖는다.

2026-10-28(`prep-garmin-absorption/`): 저장소를 OrbStack Docker의 PostgreSQL 하나로 바꾸고, 그 위에 공통 작업 runtime·스케줄러, 확장 설치(CLI·install 스킬), 공통 채널, 공통 텍스트 검색을 만들어 선택 설치형 Garmin 확장과 기존 Garmin 데이터·분석을 흡수한다. SQLite 원본·Postgres 복제 모델은 없앤다. 이 흡수의 요구사항은 아래 R1~R18이고, V1의 기능 단위는 그대로 spec의 CAP이다.

## Outcome

어떤 대화도, 대화에 준 어떤 파일도, 고른 Drive 폴더의 어떤 문서·사진도 Brain에 남고 다시 찾아 원본을 연다. Garmin을 설치한 사용자는 기존 건강 분석과 새 수집 결과를 같은 Brain에서 출처와 함께 찾는다(2026-10-28). 신호는 spec의 Success signal(SM-5 = 0, 문서 찾기)과 Done when 6~8이다. 이어가기(SM-1)는 epic 3과 함께 다음에 잰다(2026-10-26).

## Requirements

- R1 (S1): Garmin을 설치하지 않은 상태에서 Brain의 기본 설치·데몬·대화 수집이 정상 동작하고 Garmin Python 의존성을 요구하지 않는다.
- R2 (S1, S11): Garmin 확장을 설치·활성화한 사용자가 별도 Garmin 제품 설치·예약 절차 없이 연결·수집·분석을 수행할 수 있다.
- R3 (S2, E1, E5): Brain의 대화·파일 메타데이터·설정·작업·건강 데이터는 OrbStack Docker의 단일 PostgreSQL을 주 저장소로 쓰며, 컨테이너를 다시 만든 뒤에도 보존됨을 검증한다.
- R4 (S4): 사용자·확장 설정은 DB에서 읽고 갱신하며 재시작 뒤에도 유지된다. 기계별 bootstrap은 `config.toml`, 비밀은 `.env`라는 기존 Brain 계약과 일치한다.
- R5 (S3, S12, E2): 실제 존재하는 모든 Garmin 이전 대상의 원본·수치·기존 분석/파일을 출처 목록으로 관리하고, 이전 뒤 값·본문·파일 해시·관계 동등성을 검증한다.
- R6 (S3, E2, E3): schema10/15 등 기존 Garmin 소스를 먼저 원형 보관하고, legacy 데이터와 서로 다른 후보의 충돌을 자동 폐기하지 않는다.
- R7 (S3, S12): 같은 이전 batch를 다시 돌려도 중복되지 않고, 실패 뒤 재개할 수 있으며, 기존 원본과 기존 AI 분석 결과를 덮어쓰거나 재분석으로 대체하지 않는다.
- R8 (S5): 대화·문서 수집과 건강 분석 같은 독립 작업이 병렬로 진행되고, 건강 평가의 입력 의존성과 같은 계정 수집의 직렬성이 유지된다.
- R9 (S6): 진행 중인 긴 작업의 소유권이 유지되고, 작업자 사망·오류·정체·사용자 취소가 구분되어 복구 또는 종료된다. 임대 시간이 지났다는 이유만으로 정상 작업을 중복 실행하지 않는다.
- R10 (S5, S11, S14): 현지 일자·시간대 기준 예약과 수동 실행이 Brain의 같은 작업 계약을 쓰고 같은 대상의 불필요한 중복 실행을 막는다. 모델을 부르는 분석 작업도 같은 계약으로 예약된다. 자동 예약은 공통 스케줄러를 선행 조건으로 두며, 준비되지 않은 상태를 설정 완료로 표시하지 않는다.
- R11 (S11, E1): 기존 수집의 token/session/MFA·계정 차단·호출 간격과 raw/정규화/수치/입력 필터 계약을 fixture와 실패 경계 검증으로 보존한다.
- R12 (S11, S12): day→7d→30d→all 평가 순서와 성공 결과의 개별 보존을 유지하고, 계산·평가 성공과 채널 전송 성공을 따로 기록한다.
- R13 (S7): 초기 Garmin 발신은 Brain의 공통 채널 계약을 쓰며, 이후 사용자 답변·스레드·에이전트 선제 메시지를 같은 대화에 연결할 수 있는 identity·provenance 경계를 제공한다.
- R14 (S8, S9): 에이전트가 텍스트 검색과 원문 조회를 호출해 대화·리포트·분석을 날짜·출처와 함께 찾고 실제 근거를 읽을 수 있다. 한국어 두 글자 검색과 표현 바꾸기 회귀 문항을 포함한다.
- R15 (S9): 건강 수치는 기간·지표·운동·집계 조건으로 조회하며, 합계·평균과 단위·NULL·현지 날짜 규칙을 코드에서 검증한다.
- R16 (S1, S3, S12): 확장을 비활성화해도 기존 건강 기억과 분석이 보존되고, 검색 가능 여부와 작업 중단 상태가 명시적으로 드러난다.
- R17 (S13, S14): Brain 플러그인에 기본 포함한 공통 install 스킬을 Garmin 미설치 상태에서도 쓸 수 있고, 에이전트가 Brain CLI로 설치 상태를 확인해 설치·사용자 로그인·공통 예약 설정을 안내한다. 재실행·실패·스케줄러 미준비 상태를 구분하고 성공한 단계만 완료로 보고한다.
- R18 (S2; spec CAP-1, CAP-2, CAP-11, CAP-14): Garmin이 없는 Brain의 기존 기능(hook 수집, 데몬·drain·spool, 첨부 원본·문서 추출, 비밀 가리기, doctor)이 PostgreSQL에서도 같은 계약을 지킨다. Store 공통 계약 테스트를 통과하고, 같은 배치를 두 번 넣어도 모든 테이블의 건수가 같으며, 원문이 바뀌지 않고, 나갈 때 가려진다. PostgreSQL이 꺼져 있어도 hook은 Harness를 막지 않고 spool에 남긴다.

## Constraints

- C1 (S2): PostgreSQL 단일 주 저장소와 OrbStack Docker(영속 볼륨)는 확정이다. SQLite 원본 + Postgres 복제를 유지하는 완료안은 인정하지 않는다.
- C2 (S8): 임베딩·pgvector·Drive 구현을 Garmin 흡수의 선행 조건으로 만들지 않는다.
- C4 (S11; spec Constraints): Python 전면 재작성은 필수가 아니다. Core·CLI·플러그인은 TypeScript이고, Garmin 확장은 재사용할 수 있는 Python 계산·인증·호출 보호·테스트 자산을 프로세스 경계 너머에서 쓴다.
- C5 (S12, E2): 기존 분석의 모델·생성 시각이 파일에 없으면 원문과 알려진 출처를 보존하고 빠진 metadata를 명시한다. 추정값을 실제 기록처럼 만들지 않는다.
- C6 (S3, E3): Garmin 데이터의 실제 반입은 사용자가 기준 소스와 겹치는 자연키의 충돌 처리를 정한 뒤에만 한다. 그 전에는 모든 후보를 별도 출처로 보존한다.

## Done when

1. 빈 Mac에서 설치기 한 번으로 설치되고(2026-10-28: OrbStack은 사용자가 먼저 설치하는 선행 조건이고, 없으면 설치기가 안내하고 멈춘다), 이후 Claude Code 세션이 손대지 않아도 빠짐없이 수집된다(SM-5 = 0). 설치하면 데몬이 로그인 때 뜨고, 죽으면 다시 뜬다(2026-10-26).
2. 고른 Drive 폴더의 문서(txt·md·텍스트 PDF·docx)와 사진이 Mac에 동기화되지 않은 채 본문 단어와 폴더·파일 이름으로 찾아지고, 결과의 원본 링크가 열린다. 대화에 붙인 파일도 같은 방식으로 찾아지고 원본이 열린다(2026-10-26. 이전의 2주 실사용 지표 SM-1·SM-2·SM-4는 V1 다음).
3. 문서 찾기 문항(사용자가 고른 실제 문서·사진 10건)의 7건 이상이 키워드 검색과 질의 바꾸기로 찾아진다. SM-3 전체 채점표는 epic 4와 함께 다음에 잰다(2026-10-26).
4. 로컬 백업에서 새 DB 파일로 되살리면 메시지·파일·문서 추출 세대 수가 같고, Brain이 보관한 원본 파일을 다시 열 수 있다. 첨부 원본을 Drive로 옮기기 전에 이 백업이 있다(2026-10-26. 전체 내보내기·`import`는 V1 다음). → 2026-10-27: 이 항목 전체가 epic 5와 함께 V1 다음. V1에서는 Drive로 옮긴 원본의 Mac 사본을 보관 기간이 지난 뒤에만 지운다(epic-drive).
5. 실사용 기간 동안 조용한 실패가 없다(점검에 드러나지 않은 실패 0). 데몬이 멈춘 것도 doctor에 보인다(2026-10-26). (2026-10-28: "Brain의 LLM 호출은 0"은 뺐다. 공통 스케줄러가 모델을 부르는 작업을 돌린다.)
6. OrbStack의 PostgreSQL 하나 위에서 Garmin을 설치하지 않은 Brain과 설치한 Brain이 같은 설치 흐름으로 검증되고, 컨테이너를 다시 만들거나 재시작해도 기억·설정이 남는다. 기존 기능은 Store 공통 계약 테스트를 PostgreSQL에서 통과한다(R1~R4, R18).
7. 기존 Garmin DB·파일의 이전 보고서가 출처별 건수·값/본문·해시·관계·미해결 충돌을 보이고, 재실행·실패 재개 검증을 통과한다(R5~R7).
8. Garmin 미설치 상태에서 install 스킬로 설치·로그인·공통 예약까지 단계별 결과가 보고된다. 긴 건강 분석 중에도 대화 수집이 진행된다(임대 갱신·작업자 사망·취소 검증). 기존 분석을 원문으로 찾고, 건강 수치 질의가 독립 계산과 같다. 채널 발신 실패가 성공한 평가를 지우지 않고, 확장을 꺼도 데이터가 남는다(R8~R17).

## Boundaries

spec의 기능 단위로 에픽을 나누고, 바탕 공사는 첫 에픽이 맡는다. spec Non-goals를 따른다(팀 공유, Claude Code 외 Harness 수집 제외. 데몬은 V1의 기본 상주 런타임이고(epic 9, 가볍게), MCP는 V1 뒤다). 첫 시연 경로: 고른 Drive 폴더의 문서를 본문 단어로 찾아 원본 링크를 연다(epic 9 → 10 → 8, 2026-10-27. epic 5는 V1 다음). 작업 로그·시작 맥락(epic 3)·조회·미러(epic 4 나머지)·복제(epic 7)·임베딩(epic 6)은 V1 뒤다 (2026-10-26, `change-v1-capture-and-drive/`). → 2026-10-28: 복제(epic 7)는 drop. 순서는 PostgreSQL(11) → 공통 기반·Garmin(12~18) → Drive(8)다.

Garmin 흡수의 범위 밖(2026-10-28)은 다음과 같다. 이것들은 흡수 범위를 자동으로 넓히지 않는다.
- Slack·Telegram 양방향 에이전트 대화의 완전한 출시. 채널 계약과 초기 발신 편입만 범위 안이다.
- 임베딩과 Drive 전체 구현. 둘 다 흡수의 선행 조건이 아니다.
- 공개 plugin marketplace와 임의 서드파티 확장 코드 실행.

흡수의 tracer 경로: PostgreSQL에 hook 수집 한 건(epic 11) → install 스킬로 테스트 확장 설치(13) → Garmin 확장 뼈대와 기존 분석 한 건 이전(14) → 그 분석을 원문 조회로 찾는다(17). V1의 첫 시연 경로(아래 Drive 문서 찾기)는 그 뒤 epic 8에서 같은 검색 경로 위에 선다.

- Touch point: Claude Code 플러그인 체계(marketplace·`/plugin install`·hook 계약·`.mcp.json`) — hook·설치 진입점; owner: epic-capture(hook·bootstrap·node 런처), epic-log-and-context(skills, SessionStart 동기 `context show` hook 줄), epic-daemon(`.mcp.json`·래퍼, AD-28). `plugin/` 폴더 자체는 에픽이 만드는 코드다. 2026-10-28: 공통 install 스킬(`plugin/skills/`의 첫 스킬)은 epic-extensions
- Touch point: LaunchAgent KeepAlive(데몬 실행·재시작만) — 데몬; owner: epic-daemon. UNIX 소켓은 V1 뒤(2026-10-26)
- Touch point: PostgreSQL 18(OrbStack Docker, 영속 볼륨) — 단일 주 저장소; owner: epic-postgres-primary (2026-10-28. 이전의 SQLite `node:sqlite` 원본 파일(owner epic-foundation-and-install)은 전환 뒤 지우고, Docker·Postgres 복제 대상(epic-replicas)은 drop)
- Touch point: uv·Python ≥3.12(확장 잠금 파일) — 확장 런타임; owner: epic-extensions (2026-10-28)
- Touch point: Garmin Connect(`garminconnect`·`curl-cffi`) — 건강 원본 수집과 사용자 로그인; owner: epic-garmin-extension (2026-11-05. 옛 owner epic-garmin-runtime)
- Touch point: Codex CLI(이 Mac의 로그인) — 건강 평가의 모델 호출(Garmin 확장 분석 일감, AD-35); owner: epic-garmin-extension (2026-11-05. 옛 owner epic-health-analysis)
- Touch point: Telegram Bot API — 첫 채널 발신; owner: epic-channels (2026-10-28)
- Touch point: Garmin 저장소의 private capture(`data/absorption-prep/LATEST`: SQLite DB 5개, 파일 349개, `manifest.private.json`) — 기존 Garmin 데이터 이전의 원천, 읽기 전용; owner: epic-garmin-extension (2026-11-05. 옛 owner epic-garmin-import, 복사 반입 21.2·21.7)
- Touch point: Google Drive API — 첨부 원본 저장소·외부 문서; owner: epic-drive
- Touch point: OpenAI 호환 임베딩 endpoint(Model Studio 호환 모드·Ollama 등 사용자가 설정) — 임베딩 호출(선택, 기본 꺼짐); owner: epic-embedding-index (V1 뒤. 2026-11-02: "Model Studio 임베딩·재순위"에서 바꿈, 재순위는 기본 없음)
- Touch point: 문서 추출 라이브러리(`pdfjs-dist`, `mammoth`, `file-type`, `exif-reader`) — 첨부·문서 텍스트 추출과 EXIF; owner: epic-attachments(`file-type`, txt·md), epic-drive(`pdfjs-dist`·`mammoth`), epic-recall-and-mirror(`exif-reader`, V1 뒤)(2026-10-26)

## References

- spec — _bmad-output/personal-brain/spec-brain-v1-slice-1/spec-brain-v1-slice-1.md
- source — _bmad-output/personal-brain/prep-garmin-absorption/accepted-intent.md, S1~S14(사용자 결정)·E1~E6(관찰)
- design — _bmad-output/personal-brain/prep-garmin-absorption/integration-boundaries.md (재사용·교체할 Garmin 코드, 설치 안내 스킬, 작업 그래프, 단일 DB 경계)
- migration — _bmad-output/personal-brain/prep-garmin-absorption/migration-contract.md (Garmin 데이터 소스, 대상별 보존·검증, importer 계약, 완료 gate)
- architecture — _bmad-output/personal-brain/architecture-brain-v1-slice-1/architecture-brain-v1-slice-1.md, 전체(AD-1~28, Table Contract, Conventions)
- change — _bmad-output/personal-brain/change-local-sqlite-primary/change-local-sqlite-primary.md
- change — _bmad-output/personal-brain/change-surface-plugin-daemon/change-surface-plugin-daemon.md
- change — _bmad-output/personal-brain/change-users-and-review-gaps/change-users-and-review-gaps.md
- change — _bmad-output/personal-brain/change-v1-capture-and-drive/change-v1-capture-and-drive.md (V1 재절단과 데몬 먼저, 2026-10-26)
- inputs — _bmad-output/personal-brain/inputs/weknora-patterns.md (각 에픽 인셉션의 입력)
- inputs — _bmad-output/personal-brain/inputs/external-review-2026-10-16.md (외부 리뷰 검증. 각 에픽 Notes가 항목 ID로 가리킨다)
- inputs — _bmad-output/personal-brain/inputs/rag-oss-patterns.md (2026-11-02. epic 17·8·6의 refine·인셉션 입력, R1~R14·D1~D11. 세 에픽의 companion)
- inputs — _bmad-output/personal-brain/inputs/rag-oss-core-architecture.md (2026-11-02. 네 RAG 앱의 동기화·저장·검색 구조 비교. 세 에픽의 companion)
- prd — _bmad-output/personal-brain/prd-brain-v1-slice-1/prd-brain-v1-slice-1.md, FR별 testable consequences

## Notes

- Decision: 티켓 저장소는 repo 파일(2026-10-08).
- Decision: 임베딩 선택 색인은 맨 뒤 epic 6, SM-3이 기본 구성으로 미달일 때 착수(2026-10-08).
- Decision: 운영 epic 5는 내보내기·복구를 먼저 하고, 업그레이드·제거는 그 뒤 스토리로 둔다(2026-10-08).
- Decision: 경계·순서는 초안대로. 전부 만든 뒤 테스트한다(사용자, 2026-10-08). (순서는 2026-10-15에 바뀜: epic 10 추가, 9를 7 앞에)
- Decision: 설치 진입점은 `npx github:gmae199boy/second-brain`(공개 개인 저장소)(2026-10-08). (2026-10-15 플러그인이 Claude Code 진입점, npx는 대체 경로로 바뀜)
- Decision: doctor는 epic 1이 틀과 기본 항목을 만들고, 각 에픽이 자기 항목을 더한다(2026-10-08).
- Decision: SM-1·SM-4·SM-6의 2주 실사용 측정은 이니셔티브 Done when에서 하고, 에픽은 측정 가능하게 만드는 데까지 책임진다(2026-10-08).
- Decision: spool은 epic 2. epic 1의 스키마 불일치는 쓰기를 거부하고 `SCHEMA_MISMATCH`를 내며, spool로 보내는 경로는 epic 2가 붙인다(2026-10-08).
- Waits on: 각 에픽의 선행 조건은 `tickets.toml`의 `after`에 있다.
- Decision(2026-10-14): 원본은 로컬 SQLite 파일(Docker·서버 없음). Postgres·Drive 기록 복제는 epic 7. 첨부 원본 보관과 문서 본문 검색은 V1(FR-27·28, CAP-14). Drive 연동은 API로 epic 8. 주기 실행은 launchd(epic 5) → 2026-10-26: 데몬이 맡고 launchd는 데몬 실행만. 임베딩은 지금 하지 않고 epic 6은 맨 뒤(사용자). → 2026-10-28: 저장소는 OrbStack Docker의 PostgreSQL 하나이고 epic 7은 drop(아래).
- Decision(2026-10-15, `change-surface-plugin-daemon/`): Claude Code 설치·hook 진입점은 플러그인, npx는 CI·사람·개발·대체 경로. 당분간 Claude Code만(Codex 제외). Node 24 이상 유지. 데몬·MCP는 epic 9(epic 5 다음, 7 앞) → 2026-10-26: 데몬은 V1 첫 에픽(epic 2 다음), MCP는 V1 뒤. 확인 필요 종료 코드 3. WeKnora 흡수 목록(`inputs/weknora-patterns.md`)은 각 에픽 인셉션의 입력(사용자).
- Decision(2026-10-15, 트리 검증): epic 9는 epic 7 앞에 고정한다. 두 에픽이 `setup run`의 선택 단계·doctor 등록부·설정 코덱을 함께 건드리므로 순서를 바꾸면 충돌 비용이 든다. 설정 키 `[daemon] enabled`는 epic 5가 더하고(주기 Label 선택), 데몬 동작은 epic 9. Drive 동기화는 drain의 일감 종류로 돌아 launchd·데몬 어느 쪽이든 같은 경로다. 다만 epic 7·8의 Done when이 데몬 켜짐·꺼짐 둘 다를 요구하므로 둘 다 `after`에 9를 둔다(2026-10-16 정정, `change-users-and-review-gaps/` D2). → 2026-10-26: 양쪽 검증과 `[daemon] enabled`·주기 Label을 없앴고, 데몬이 기본 런타임이다(`change-v1-capture-and-drive/`).
- Decision(2026-10-15, 사용자): CAP-11은 다섯 에픽(1·2·5·7·9)이 각자 Boundaries의 경계 문장으로 나눠 맡는다. spec의 CAP 번호는 쪼개지 않는다. epic 7·8은 데몬 켜짐·꺼짐 둘 다에서 통과해야 한다(Done when에 추가). → 2026-10-26 삭제(`change-v1-capture-and-drive/`).
- Decision(2026-10-15, epic 2 인셉션): 첨부 원본과 문서 추출을 epic-capture에서 나눠 epic 10(`epic-attachments`)으로 만들고, epic 2 바로 뒤에 둔다(2026-10-26: epic 9 다음). CAP-14는 다섯 에픽이 나눠 맡는다.
  - epic 1: 스키마 자리(0001·0002)
  - epic 2: 0004 스키마(2.6. 0003은 2.2의 `users`, 2026-10-16)
  - epic 10: 첨부 저장, 문서 추출, `files redact`
  - epic 4: 문서 검색 → 2026-10-26: 촬영 일시 필터만(문서 검색은 epic 8 E8-6)
  - epic 8: Drive 저장소와 기존 Drive 문서, 그리고 문서·폴더명 검색(2026-10-26)
  - (사용자)
- Decision(2026-10-15, epic 2 인셉션): 수집 범위와 꼬리표.
  - 꼬리표는 프로젝트와 워크트리뿐이고, 근거는 첫 메시지의 transcript cwd다. → 2026-10-22 바뀜: 근거는 세션이 시작된 폴더(`startCwd`: 서브에이전트가 아닌 첫 cwd 줄, 첨부 줄 포함), 없으면 첫 메시지의 cwd다(epic-capture 25, 사용자 결정 B).
  - 워크스페이스는 slice 1에서 쓰지 않는다. 칸은 예약으로 남긴다. 회사/개인 경계는 내보내기·지우기·팀 공유를 경계 단위로 할 때 정한다.
  - 설치 때 디스크에 남은 Claude Code transcript는 한 번 가져온다. 그 밖의 과거 세션 가져오기는 그대로 범위 밖이다.
  - 서브에이전트는 최종 보고만 수집한다. → 2026-10-21 바뀜: 서브에이전트 보고는 저장하지 않는다. 부른 일은 도구 메모 한 줄로 남는다(epic-capture Notes 2026-10-21, 23).
  - spec·PRD·spine 문구는 2026-10-16에 맞췄다.
  - (사용자)
- Decision(2026-10-16, `change-users-and-review-gaps/`): 사용자 정체성은 `users` 테이블이다('나' 한 행, `setup run`이 만듦, `sessions.user_id` FK, UUIDv7 유지, 정체성은 DB와 함께 옮겨짐). 외부 리뷰(`inputs/external-review-2026-10-16.md`)의 빈틈을 D1~D8로 보강했다: 브랜치는 메시지 칸, epic 7·8은 9 뒤, 데몬 판단은 살아 있는 소켓과 `daemon start`, 데몬은 자기가 낡았을 때만 종료, 가리기는 복제 대상에도 전파, 규칙이 hook 상한을 넘으면 생략 줄과 doctor `fail`, 첫 요청 문장은 꺼내 씀, spool 레코드는 회수하고 10번 실패하면 보존(사용자).
- Decision(2026-10-19, `change-masking-b-and-review-fixes/`): 비밀은 저장할 때가 아니라 나갈 때 가린다(마스킹 B, 2026-10-18 사용자). Core 출력 코덱이 가리고, 색인은 원문 위다. 내보내기와 Drive 스냅샷도 가린다. 결정 검토 수정 넷(parser peer handback, 프로젝트 비교 키와 꼬리표 다시 채우기, `failed_stage` 강제, 도구 메모 가리기 기록)과 함께 epic 2에 스토리 17~20을 더했다(사용자).
- Decision(2026-10-20, `change-discipline-and-metrics/`): 벤더 메모리·graphify 비교 뒤 보강 넷을 인셉션 입력으로 더했다 — Stop hook 기록 점검(epic 3, 토글, 둘째 주에 켜서 SM-4a 비교), `stats show`(epic 5), 검색 회귀 러너와 `recall --count`(epic 4). graphify는 도입하지 않는다(가끔 미러 위에 돌리는 분석 층). 두 번째 하네스 수집은 slice 1 밖이고 조건은 spine Deferred에 있다(사용자).
- Decision(2026-10-26, `change-v1-capture-and-drive/`, 사용자): V1은 대화 수집 + 파일·Drive 수집이다. 순서는 1·2 → 9(가벼운 데몬) → 10(축소) → 5(로컬 백업) → 8(Drive, 문서·폴더명 검색 포함). epic 3·7·6과 4·5의 나머지는 V1 뒤(backlog, 삭제 아님). 데몬은 기본 상주 런타임이고 launchd는 데몬을 띄우고 다시 띄우는 데만 쓴다. 5분 주기 drain LaunchAgent, 두 Label 전환(`[daemon] enabled`), 데몬 켜짐·꺼짐 양쪽 검증은 없앤다. 사용자 스케줄러(배치·예약을 등록하면 그 시각에 실행)는 두 기능 다음의 첫 상주 기능이다.
- Decision(2026-10-26, 진행 방식, 사용자): 에픽 사전 조사는 새 불확실성만 한 편. validate-set은 한 번(고위험 항목만 재검증). plan은 목적·쓰기 경계·재사용 API·완료 조건·위험만. 리뷰는 원본 삭제·마이그레이션·파서·인증·기존 데이터 변경 스토리에만 하고 단순 연결·문서 작업은 생략. 플러그인 배포(app-ref·version)는 기능 묶음마다. Postgres 테스트는 Postgres 코드나 공용 Store 계약을 바꿀 때만. build·typecheck, 마이그레이션·멱등·잠금·삭제 경계 테스트, 마지막 실계정 확인은 유지한다.
- Note(2026-10-26, 트리 검증 제안): V1 에픽(9·10·5·8)은 인셉션 때 Done when에 "기능 묶음이 플러그인 배포(app-ref·version)로 이 Mac의 설치본에 들어가 동작한다"는 확인을 붙인다. V1 뒤 에픽(3·4·7·6)에는 상태 칸이 없고, 순서와 에픽 전체 대기(`after`에 epic-drive)로 미룬 것을 나타낸다.
- Decision(2026-10-27, 사용자): epic 5(운영: 로컬 백업·스키마 가드·`setup upgrade`)를 V1 뒤로 미룬다. V1 순서는 1·2 → 9 → 10 → 8. 쓰면서 확인하고 버그로 고칠 일이고, 백업이 맡던 안전장치는 Drive로 옮긴 원본의 보관 기간(epic-drive E8-1)이 대신한다. Done when 4는 V1 다음.
- Decision(2026-10-27, 사용자): DB가 단일 원천이므로 PC를 옮겨도 따라가야 하는 사용자 설정은 DB에 둔다. `config.toml`은 기계마다 다른 값, `.env`는 비밀. 첫 대상은 epic-drive의 원본 보관 기간과 `brain config get/set`(E8-7). spine AD-19는 `bmad-architecture`로 고친다.
- Decision(2026-10-28, `prep-garmin-absorption/`, 사용자): 준비 패키지를 이 이니셔티브에 채택한다. 저장소는 OrbStack Docker의 PostgreSQL 하나다(S2, C1). 공통 기반과 Garmin 흡수는 별도 이니셔티브가 아니라 이 이니셔티브의 에픽 11~17이다. prep의 `initiative-garmin-absorption.md` 초안과 `roadmap.md`는 이 파일의 R1~R18·C1~C6과 에픽 11~17로 옮겼다. 초안의 R·C 번호를 지키고, C3(준비 단계 전용)은 옮기지 않았다.
- Decision(2026-10-28, 사용자): 순서는 PostgreSQL(11) → 공통 기반·Garmin(12~17) → Drive(8) → V1 뒤 에픽(5·3·4·6)이다. Drive는 Garmin의 선행 조건이 아니다(C2).
- Decision(2026-10-28, 사용자): 기존 `brain.db`는 옮기지 않는다. 운영 전이기 때문이다.
  - PostgreSQL을 빈 DB로 설치하고, 설치 때 디스크의 transcript를 다시 가져온다. transcript로 되살릴 수 없는 첨부 원본은 잃을 수 있다는 점을 받아들였다.
  - 전환 뒤 SQLite adapter와 `node:sqlite` 경로를 지운다. `move-store`는 필요 없다.
  - Garmin 데이터와 분석은 옮기고 보존한다(R5~R7, C6).
- Decision(2026-10-28, 사용자): epic 7(복제 대상과 원본 이전)을 drop한다. 원본·복제 모델이 없어졌다.
- Decision(2026-10-28, 사용자): "Brain은 LLM을 부르지 않는다"는 제약을 없앤다. 공통 스케줄러가 모델을 부르는 작업을 돌리기 때문이다.
  - spec Constraints·Success signal과 Done when 5를 고쳤다.
  - PRD의 같은 문장(§1 Vision, §5 NFR-5, §7 SM-8)은 이 결정으로 대체된다.
- Decision(2026-10-28, 사용자): Core·CLI·플러그인은 TypeScript로 두고, Garmin 확장은 기존 Python을 재사용한다(C4). spec Constraints의 "구현 언어는 TypeScript"를 고쳤다.
- Decision(2026-10-28, 사용자): 공통 텍스트 검색과 원문 읽기는 epic 17이 만든다.
  - epic 17은 대화 검색(CAP-6·7의 대화 조각·도구 메모·넓히기 부분)을 epic 4에서 가져온다.
  - Drive E8-6은 같은 경로에 문서 대상을 더하고, epic 4는 그 위에 시간 조회·로그·미러·EXIF를 더한다.
- Decision(2026-10-28, 사용자): 공통 채널 계약과 Telegram 발신은 별도 에픽(15)으로 Garmin 런타임(16) 앞에 둔다.
- Decision(2026-10-28): 사용자 설정 DB와 `brain config get/set`(epic-drive E8-7)을 epic 11로 옮긴다. 확장 설정(R4)과 같은 계약이고, Drive가 Garmin 뒤로 갔기 때문이다.
- Source conflict(2026-10-28) → 해소(2026-10-28, spine 갱신 commit 3160072): spine이 C1·R3·R18·C4와 다르던 곳을 `bmad-architecture`로 고쳤다.
  - 어긋나던 곳: AD-7·10·18·20·22, Stack, Design Paradigm 표, Structural Seed, Table Contract가 PostgreSQL 하나와 plpgsql trigger로 바뀌었다. AD-10은 SQLite 원본·복제 모델을 없앴다.
  - 함께 정할 것: 공통·확장 schema 경계는 AD-30, 단일 마이그레이션 소유와 소유자별 번호는 AD-31(14의 확장 DDL과 15의 core 채널 표가 부딪히지 않는다), 한국어 텍스트 검색은 AD-15(pg_trgm expression GIN), 잠금·트랜잭션은 AD-7, TS↔Python 포트는 AD-29·33, 컨테이너 수명은 AD-34가 정했다.
  - 구형 Garmin Markdown·facts·PNG는 core 파일로 등록하고 `analyses`가 가리킨다(AD-23·35).
  - 2026-10-27의 AD-19 설정 충돌은 AD-18(사용자 설정은 DB `brain.settings`)이 정했다.
  - 새로 더한 AD: AD-29(확장은 connector), AD-30(schema 경계와 DB 계약), AD-31(마이그레이션 소유와 번호), AD-32(정제 데이터는 버전별로), AD-33(확장 작업 감독), AD-34(컨테이너 수명), AD-35(분석은 core 일감), AD-36(Garmin 이전은 검증한 출처와 배치로만).
  - 남은 미룬 일은 spine Deferred에 owner 에픽과 함께 있다(예: chunk_locator text/jsonb는 epic 11, 정체·놓친 예약·모델 호출 비용은 epic 12).
- Source conflict(2026-10-28): PRD §9 Constraints("로컬 SQLite 파일 하나다… 서버나 Docker가 필요 없다")는 C1과 다르고, NFR-5는 위 LLM 결정과 다르다. 이 파일과 spec이 우선한다. PRD 본문은 `bmad-prd`로 고칠 수 있다.
- Decision(2026-10-28, 사용자, 결정 묶음): 남은 에픽의 사용자 결정을 한 번에 받아 각 에픽 Notes에 적었다. 놓친 예약(깨어난 뒤 빠진 날짜가 있을 때만 한 번)·정체 판정·모델 호출 표시(토큰과 걸린 시간만, 상한 없음)는 epic 12, 확장 끄기(진행 취소, 대기 보류)는 12·13·18, 불명 발신(지수 간격 10번 뒤 doctor와 resend 스킬)은 15, 분석 에이전트·모델을 사용자 설정으로 바꾸기는 18, 수집 사건 알림은 16이다. 위 두 Open question(놓친 예약·정체, 모델 호출 비용)을 대신한다. C6은 그대로 epic 14의 실제 반입 직전에 정한다.
- Open question: 개발/운영 Garmin DB 중 기준 소스는 무엇이고, 겹치는 자연키의 충돌은 어떻게 고르나? epic 14가 실제 반입하기 전에 사용자가 정한다(C6). → 2026-10-28 사용자가 추천 규칙에 위임했다(아래 Decision). 규칙은 epic 14를 쪼갤 때 preflight 증거로 정한다.
- Decision(2026-10-28, 트리 검증): 이니셔티브 `covers`에는 S id를 더하지 않는다. 템플릿상 이니셔티브의 `covers`는 쓰지 않는 칸이고 CAP 목록은 예전 값이다. S·E id는 Requirements 줄에 있다.
- Decision(2026-10-28, 사용자): 시간대를 `config.toml`에서 사용자 설정 DB로 옮긴다(epic 11). 예약과 현지 날짜 질의가 이 값을 쓴다.
- Decision(2026-10-28, 사용자): 이전한 Garmin 알림·전송 이력은 core 채널 이력에 둔다. 그래서 epic 15(채널)를 epic 14(이전) 앞으로 옮겼다. 순서는 11 → 12 → 13 → 15 → 14 → 16 → 17이다.
- Decision(2026-10-28, 사용자): OrbStack은 사용자가 먼저 설치하는 선행 조건이다. 설치기와 doctor는 OrbStack이 없거나 꺼져 있으면 안내하고 멈춘다.
- Decision(2026-10-28, 사용자): 준비 폴더(`prep-garmin-absorption/`)는 Garmin 소스 archive까지 포함해 커밋한다.
- Decision(2026-10-28, 사용자, spine 갱신 뒤 재분할): 옛 epic 16(Garmin 수집·분석)을 둘로 나눈다. 순서는 11 → 12 → 13 → 15 → 14 → 16 → 18 → 17이다.
  - epic 16 `epic-garmin-runtime`은 Garmin connector다(AD-29): 인증, 수집, raw, 정규화, digest, 그래프를 돌고 core 건강 계약 표와 파일 등록 요청에 쓴다. R2·R11을 맡는다.
  - epic 18 `epic-health-analysis`는 core 건강 분석이다(AD-35): 스케줄러가 분석 에이전트를 띄우고, day→7d→30d→all 평가와 리포트를 `analyses`와 리포트 파일로 저장하고, 결과 묶음을 채널로 보낸다. R2·R10·R11(입력 필터)·R12를 맡는다.
- Decision(2026-10-28, 사용자): core 계약 표는 처음 쓰는 에픽이 만든다.
  - epic 14: 건강 측정·요약 표와 "현재" view(AD-32), `analyses` 최소 계약·DDL, `file_requests`와 core 인계 일감.
  - epic 15: 채널 발신 요청·이력 표. epic 14는 legacy 이력을 넣기만 한다.
  - epic 18은 `analyses`를 호환 확장하고, epic 16·17·18은 건강 계약 표를 소비한다.
  - 같은 원칙으로 프로세스 ABI v1은 감독자를 처음 만드는 epic 12가 만들고, manifest JSON Schema와 설정 snapshot은 epic 13이 만든다.
- Source conflict(2026-10-28, 재분할) → 해소(2026-10-28, `bmad-architecture` update): spine이 분할 전 에픽 번호를 쓰던 아래 줄을 고쳤다. AD ID는 그대로다.
  - 분석 쪽 "epic 16"은 이제 epic 18이다: AD-29의 report-input fixture, AD-35의 `analyses` 호환 확장, Table Contract `analyses` 행, Capability Map "분석" 행, Deferred "분석 에이전트의 프롬프트와 출력 schema".
  - AD-33의 "manifest·프로세스 ABI는 epic 13 소유"는 프로세스 ABI v1이 epic 12, manifest가 epic 13이다.
  - frontmatter scope의 "epic 11~17"과 Capability Map 앞의 빌드 순서에 18이 없다. 순서는 11 → 12 → 13 → 15 → 14 → 16 → 18 → 17 → 8이다.
  - Structural Seed의 `tooling/eval`과 Deferred "임베딩 기본 켜기"는 회귀 러너를 epic 17의 것으로 적는다. 사용자 결정(2026-10-28, epic-recall-and-mirror Notes)으로 범용 러너는 epic 4에 남고, epic 17은 자기 회귀 문항을 테스트 fixture로 검증한다.
- Decision(2026-10-28, 트리 검증 A1): epic 17과 18 사이에는 `after`를 두지 않는다. 데이터로는 서로 기다리지 않는다. 둘 다 core 마이그레이션 번호, 출력 코덱 등록부, 명령 메타를 고칠 수 있다. 이것은 Dependencies 규칙의 명시적 예외다. epic 3과 10을 나란히 만든 선례(2026-10-23)를 따른다.
  - 표 순서(18 → 17)대로 만들면 충돌이 없다.
  - 나란히 만들면 뒤에 합치는 쪽이 번호와 목록을 맞춘다. AD-31 실행기가 같은 owner 안의 번호 중복을 거부한다.
- Decision(2026-10-28, 사용자: 사람이 없을 때 최대한 많이 만들기): 남은 V1 에픽(12·13·15·14·16·18·17·8) 파일의 에픽 전체 gate(`after:`)를 없앴다. 에픽 상태는 닫기 때 사람이 `done`으로 쓰므로, 전체 gate가 있으면 각 에픽 끝의 이 Mac 확인(hitl)과 닫기가 끝날 때까지 다음 에픽이 시작되지 않는다. 앞 에픽에서 필요한 것은 이 파일 `tickets.toml`의 에픽 `after`(needs)로 선언해 두고, 스토리를 쪼갤 때 entry의 교차 에픽 `after`(`<epic>.<entry>`)로 고정한다. 그래서 루프는 앞 에픽의 코드 스토리가 끝나면 다음 에픽으로 넘어간다. 이 Mac 확인과 닫기는 막지 않는 사람 일로 모아서 한다. 이 Mac 확인에서 나온 문제는 버그 스토리로 고친다. V1 뒤 에픽(5·3·4·7·6)의 전체 gate는 그대로 둔다.
- Decision(2026-10-28, 사용자: 사람 개입 없이 끝까지): 남은 V1 에픽(12·13·15·14·16·18·17·8)을 쪼갤 때와 루프가 만들 때, 사람이 정할 일은 추천안으로 정하고 `Decision(날짜, 추천으로 정함)`으로 그 티켓 Notes에 적는다. 모든 추천 결정은 `decisions-by-recommendation.md`에 한 줄씩 모은다. hitl은 다음과 같이 다룬다.
  - 이 Mac 확인(설치·명령·doctor 출력)과 로컬 플러그인 배포(app-ref·version)는 에이전트가 하고 증거를 plan에 남긴다(`hitl = false`). 원격 push가 있어야만 하는 배포는 하지 않고 `operator_actions`에 남긴다.
  - C6: 기준 소스와 충돌 처리는 추천 규칙으로 정하고, 에이전트가 실제 반입을 한다. 원본 snapshot은 읽기만 하므로 되돌릴 수 있다. 사용자가 이것을 위임했으므로 C6과 AD-36의 "사용자가 고르기 전 반입 금지"는 이 위임으로 채운다.
  - 이 Mac에 이미 있는 옛 Garmin 토큰과 Telegram 봇 설정은 Brain으로 옮겨 쓴다.
  - 사람만 할 수 있는 일(Drive OAuth 동의, 토큰이 만료됐을 때의 Garmin MFA, 모델 분석 품질 판단, 원격 push)은 스토리를 `awaiting-operator`로 두어 run을 막지 않고, 목록으로 남긴다.
  - 루프 설정 `gates.mode`는 `none`으로 바꿨다. 에픽 경계에서 멈추지 않는다(`.bmad-loop/policy.toml`, 계획과 함께 main에 들어간다).
- Decision(2026-10-28, 사용자): 임베딩 선택 색인은 나중에 확장(extension)으로 만든다. 지금은 구현하지 않고, 남은 에픽을 이어 만드는 무인 파이프라인(V1과 V1 뒤 5·3·4)에서 뺀다. 착수할 때 확장 계약(AD-29·30·33, epic 13) 위에서 다시 정의한다. 이 에픽 파일과 `tickets.toml`의 자리는 그때의 입력으로 남긴다.
- Decision(2026-11-02, 추천으로 정함 → 같은 날 사용자 승인): core·확장 경계를 "확장은 데이터를 가져오는 connector(AD-29), 데이터를 쓰는 방식은 core"로 확인했다. 검색·조각·추출·문서 집계는 core(epic 17·8), Drive는 설치 없는 core 연결(epic 8), 임베딩은 확장이 아니라 core의 선택 기능(epic 6, 2026-10-28 결정을 바꿈). 외부 RAG 앱(RAGFlow·Onyx·Open WebUI·AnythingLLM)은 붙이지 않고 공식·수치·도구 모양만 가져온다(`inputs/rag-oss-patterns.md`). 에이전트가 보는 면(검색·원문·로그·doctor 각 하나)이 하나로 남는 것이 Brain과 플러그인 모음을 가르는 기준이다.
- Note(2026-11-02, 입력): 네 RAG 오픈소스의 동기화·저장·검색 구조 비교는 `inputs/rag-oss-core-architecture.md`, 채택 후보 목록은 `inputs/rag-oss-patterns.md`(R1~R14, D1~D11). 비교의 결론: Brain의 "PG 하나에 원본·문서 행·조각" 구성은 Open WebUI pgvector 구성과 같은 모양이고, 조각은 어디서나 재생성 파생물이다. 위 2026-11-02 Decision(core·확장 경계)의 근거 §2-1·2-2.
- Decision(2026-11-05, 사용자, Garmin 확장 재설계): core는 확장의 내용을 모른다. 확장은 manifest 선언(일감·예약·설정·명령·migration)으로만 붙고 데이터·로직은 확장 안에 있다(spine 확장 원칙, AD-29·30·32·35~40, `architecture-brain-v1-slice-1/garmin-extension-redesign-disposition.md`). Garmin은 옛 프로그램을 거의 그대로 PG `garmin` 표 위에서 쓰고 옛 SQLite를 복사 반입한다. 요구사항 R1~R18은 그대로이고 구현 방식만 바뀐다. epic-extension-platform(20)과 epic-garmin-extension(21)을 더하고, epic 18의 남은 core 분석·14.8·16.9·18.10·19.7을 drop하며, epic 17은 확장 명령을 소비하도록 고친다. 여러 사용자는 키와 "나" 해석까지만 하고 인증·격리는 뒤로 미룬다. S1의 "흡수"를 core가 기능을 가져가는 뜻으로 풀었던 기존 해석(AD-29·30·35 [ADOPTED])을 S11(기존 동작 재사용)에 맞게 바로잡는다.
