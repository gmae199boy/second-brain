---
type: epic
title: "기반과 설치"
parent: personal-brain
covers: [CAP-10, CAP-11, CAP-14]
after: []
assignee: ""
status: done
risk: high
---

# 기반과 설치

## Description

pnpm workspace와 패키지 경계, Core의 port, SQLite 원본 스키마(Table Contract, 원문 불변 trigger, schema_version), 설정 코덱, `brain` CLI 뼈대와 `--json` 봉투, shim, 대화형 설치기와 `brain admin doctor`의 기본 점검을 세운다. 이후 모든 에픽이 이 위에 얹힌다.

## Outcome

빈 Mac에서 설치기 한 번으로 DB와 `brain`이 준비되고, doctor가 정상을 보인다.

## Requirements

- E1-1 (CAP-10): pnpm workspace — core(런타임 의존성 0), sqlite(원본), postgres(복제 adapter, epic 7. V1은 계약 테스트만), claude-code, modelstudio, second_brain(재export만), apps/cli. adapter는 core에만 의존. import 시 부작용 없음. (spine AD-1·2·3)
- E1-2 (CAP-10): Core port(Store, Parser, Embedder, Reranker, Clock, IdGen)와 도메인 타입, port별 계약 테스트 틀. Runtime이 Clock과 UUIDv7 IdGen을 구현. (AD-1·8)
- E1-3 (CAP-11, CAP-14 — 스키마 자리만, 동작은 epic 2·4): SQLite 마이그레이션(원본, 0001 대화·로그 + 0002 파일·첨부·추출·work_items) — Table Contract의 모든 테이블과 UNIQUE 멱등 키, schema_version, messages·tool_notes 불변 trigger와 redact 전용 우회 경로, redactions. embeddings는 제외(임베딩을 켤 때 설정 차원으로 생성, AD-15). 마이그레이션은 setup만 실행. Postgres 마이그레이션은 복제 대상용으로 남는다. (AD-7·10·11·20·21·23·24, Table Contract)
- E1-4 (CAP-10, CAP-11): 설정 코덱(config.toml schema_version + .env), `brain <ns> <verb>` 디스패처, `--json` 봉투와 경고 코드, hook 경로 exit 0, 런타임 스키마 버전 확인. (AD-5·18·20, Conventions)
- E1-5 (CAP-11): 설치 — `npx github:gmae199boy/second-brain` 진입, 내려받기·빌드, 의존성 설치 동의, DB 파일 위치(`[store] path`)와 파일 저장소 위치(`[files] path` — 묻지 않고 기록된 값 또는 기본값을 기록한다, epic-capture 2.4, 2026-10-22 맞춤), 설정·키 기록, 마이그레이션, index_configs 기본 행, shim, connector 등록부와 `setup connect`, `setup run` 재실행 멱등. (AD-2·19)
- E1-6 (CAP-11): `brain admin doctor` 틀과 기본 항목 — store(DB 파일·WAL·FTS5), 스키마 버전, shim·node 경로, 설정 유효성, `DB_UNAVAILABLE`. 이후 에픽이 항목을 더한다. (AD-19·20, FR-25)

## Done when

1. `npx github:<owner>/second-brain` 한 번으로 Node와 git만 있는 Mac에서 DB 파일(0600)과 `files/` 루트(0700) 생성, 마이그레이션, shim 설치까지 끝난다. Docker·Postgres는 필요 없다.
2. `brain admin doctor --json`이 store·스키마 버전·shim 실존을 보이고, DB 파일을 열 수 없으면 `DB_UNAVAILABLE`을 보인다.
3. `messages`·`tool_notes`에 UPDATE·DELETE를 시도하면 DB가 거부한다.
4. `brain setup run`을 두 번 돌려도 결과가 같고, 현재 값을 기본값으로 보여 준다.
5. `core` 패키지에 런타임 의존성이 없고, `second_brain` 하나를 import해도 DB 연결이나 키 읽기가 일어나지 않는다.
6. SQLite 마이그레이션(0001·0002)이 Table Contract의 모든 테이블(embeddings 제외)을 만들고, `files`·`file_locations`·`message_attachments`·`document_extractions`·`document_chunks`·`work_items`의 멱등 키가 중복 삽입을 거부하며, FTS5 trigram 질의가 한국어 부분 일치로 동작한다.

## Boundaries

AD-1·2·3·5·10·11(trigger)·18·19·20(schema_version), Table Contract, Conventions. Harness 연결 자체(hook 내용)는 epic-capture가, 업그레이드·제거는 epic-operations가 맡는다.

## References

- parent — _bmad-output/personal-brain/initiative-personal-brain.md
- spec — _bmad-output/personal-brain/spec-brain-v1-slice-1/spec-brain-v1-slice-1.md, Capabilities CAP-10, CAP-11
- architecture — _bmad-output/personal-brain/architecture-brain-v1-slice-1/architecture-brain-v1-slice-1.md
- prd — _bmad-output/personal-brain/prd-brain-v1-slice-1/prd-brain-v1-slice-1.md

## Notes

- Decision: tracer는 story 1(패키지 뼈대 → postgres adapter → CLI doctor). 2·3·5는 병렬 가능. 가장 불확실한 것은 5(설치 진입점)(2026-10-08).
- Decision: 설치 진입점은 의존성 없는 빌드된 단일 파일이 저장소를 ~/.second_brain/app에 받아 빌드한 뒤 설치기에 넘긴다. 루트 package.json에 의존성·prepare 없음. pnpm은 고정하지 않는다: 루트 `engines.pnpm`은 `">=12"`뿐이고, 진입 파일이 major 12 미만이면 `npm install -g pnpm@latest`를 묻는다(corepack에 기대지 않음). epic 5의 setup upgrade도 같은 경로(2026-10-08, pnpm 고정은 2026-10-13에 풀었다 — `packageManager` 고정이 남으면 최신 pnpm도 고정 버전으로 전환하려다 ENOEXEC로 죽는다).
- Decision: spool은 epic 2. 이 에픽의 스키마 불일치는 쓰기 거부 + SCHEMA_MISMATCH까지(2026-10-08).
- Decision: 임베딩 질문은 epic 6 전까지 '아직 지원 안 함'으로 답한다(2026-10-08).
- Decision(2026-10-14): 원본은 로컬 SQLite 파일이고 Postgres·Drive는 복제 대상(epic 7). `packages/postgres`와 설치기의 Docker 흐름은 남기고 연결만 끊는다(`../change-local-sqlite-primary/`).
- Decision(2026-10-14): 파일·첨부·추출·work_items 스키마는 epic 1(story 12)이 만들고, 동작은 epic 2·4가 만든다.
- Decision(2026-10-14): epic 1의 SQLite adapter는 HealthStore·SchemaStore까지다. SQLite `SessionStore`(ensure·ingest·readSession)와 그 계약 사례는 epic 2가 통과시킨다.
- Decision(2026-10-14): 8(doctor)은 10~13 뒤에 둔다. 점검 대상이 store로 바뀌므로. 11(대화·로그)과 12(파일·일감)는 한 세션에 맞추려고 나눴다.
- Decision(2026-10-14): Postgres 전제로 쓴 story 1.8 초안(종료된 세션)은 지웠다.
- Decision(2026-10-15): Done when 1은 대체 증거로 인정하고 닫는다 — `npx --yes git+file://<bare>` 테스트(`tooling/bootstrap/test/npx.test.ts`)와 별도의 `setup run --yes`(DB 0600·`files/` 0700·마이그레이션·shim). 실제 `npx github:` 실행은 push 뒤 확인한다.
- Decision(2026-10-15): 설치기 설정 보존 버그 2건(읽을 수 없는 값 하나에 묻지 않는 값까지 기본값으로 되돌림, 모르는 키를 경고 없이 지움)은 epic 1 밖, epic 2 인셉션에서 다룬다. busy 예산 분기 테스트는 story 9가 더했다.
- Closed(2026-10-15): closure 검증 — E1-1~6 충족, Done when 2~6 충족, 1은 위 대체 증거. 스토리 13개 done.
