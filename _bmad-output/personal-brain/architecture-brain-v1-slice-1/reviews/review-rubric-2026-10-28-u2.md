수정 필요 — critical 0 / high 1 / medium 2 / low 0

2026-10-28 두 번째 update의 정적 검토다. 변경 diff와 `.memlog.md` 마지막 여섯 줄을 아래 입력·현재 코드와 대조했다. 테스트·빌드·Docker·설치·커밋은 하지 않았다. 기존 사용자/추천 결정은 재심의하지 않았다.

근거의 `약칭:행`은 다음 저장소 상대 파일을 가리킨다.

| 약칭 | 파일 |
| --- | --- |
| spine | `_bmad-output/personal-brain/architecture-brain-v1-slice-1/architecture-brain-v1-slice-1.md` |
| memlog | `_bmad-output/personal-brain/architecture-brain-v1-slice-1/.memlog.md` |
| 추천 | `_bmad-output/personal-brain/decisions-by-recommendation.md` |
| 이전 | `_bmad-output/personal-brain/tickets/epic-garmin-import/epic-garmin-import.md` |
| 세트 | `_bmad-output/personal-brain/tickets/epic-garmin-import/epic-garmin-import-validate-set.md` |
| 분석 | `_bmad-output/personal-brain/tickets/epic-health-analysis/epic-health-analysis.md` |
| 채널 | `_bmad-output/personal-brain/tickets/epic-channels/epic-channels.md` |
| 이니셔티브 | `_bmad-output/personal-brain/initiative-personal-brain.md` |

## 1. Rubric — good-spine checklist

### R1 · high — 저장본 가리기가 bytea 짝 칸까지 갱신한다는 계약이 필요하다

- 근거: `spine:222`, `spine:225`, `spine:226`, `spine:558`, `spine:565`; 현재 구현의 `packages/sqlite/src/sessions.ts:151`, `packages/sqlite/src/sessions.ts:153`, `packages/sqlite/src/sessions.ts:155`.
- 조건/문제: U+0000과 비밀을 함께 포함한 본문·도구 메모를 저장한 뒤 `messages.redact`를 한다. 새 규칙은 읽을 때 bytea를 우선하지만 기존 redact 규칙은 본문 치환과 redactions만 규정한다. 현행 구현처럼 text 칸만 UPDATE하는 경로를 PG로 옮기면, 짝 칸에 지우기 전 원문이 남아 다음 읽기에서 비밀이 되살아난다. VACUUM도 살아 있는 짝 칸을 지우지 않는다. 반대로 짝 칸을 무조건 NULL로 만들면 가리지 않은 U+0000까지 잃는다. 새 저장 표현과 유일한 수정 예외 사이의 강제 조건이 빠졌다.
- 바꿀 문장 제안(AD-11 저장본 가리기에 추가): “`messages.redact`는 짝 칸을 우선 복원한 논리 원문 위에서 위치·해시·치환을 계산하고, 같은 트랜잭션에서 치환 결과를 U+0000 쓰기 코덱으로 다시 나누어 text와 bytea 짝 칸을 함께 갱신한다. 치환 뒤 U+0000이 없으면 짝 칸은 NULL로 지우며, 지우기 전 바이트를 남기지 않는다. 본문과 도구 메모 대상에 같은 규칙을 적용한다.”
- 처리: 명백한 계약 보강. 원문 보존·저장본 삭제 결정을 바꾸지 않고 기존 예외를 새 표현에 연결한다.

### R2 · medium — Deferred의 Python pin이 Stack의 설치·doctor 기준과 갈린다

- 근거: `spine:789` 대 `spine:664`, `spine:666`; 결정 입력 `이전:48`, `이전:108`, `memlog:187`.
- 조건/문제: epic 14는 확정 결정대로 3.14.8로 frozen 설치하고, epic 13 설치기/doctor는 Stack대로 새 배포 pin·보안 기준 3.14.10을 강제한다. 둘은 각자 spine을 따르면서도 설치 결과와 doctor 판정이 갈린다. Deferred 소유권 분리는 잘 됐지만 Stack의 기존 값과 reconciliation이 끝나지 않았다.
- 바꿀 문장 제안(Stack Python 행): “Python은 `>=3.12`이고 epic 14의 이전 확장 배포 pin은 `.python-version` 3.14.8이다(2026-10-28 epic 14 Decision). 이 pin의 frozen 설치·macOS arm64 import·DB 접속은 14.1이 검증한다. 기존 3.14.10 신규 배포 pin 문장은 이 결정으로 대체한다.” Stack psycopg 행의 검증 책임도 “driver 설치·접속은 14.1, 옛 수집 의존 추가·arm64 설치는 epic 16”으로 맞춘다.
- 처리: 새 버전을 고르자는 지적이 아니다. 이번 update가 채택한 3.14.8 결정을 다른 표에도 일치시키는 수정이다.

그 밖의 checklist 결과:

| 점검 | 결과 |
| --- | --- |
| Rule이 divergence를 막는가 | AD-30의 scope 포함 정규형은 day/activity 충돌을 막는다. AD-32는 비선택 보관 후보와 선택 불가능한 ambiguity를 분리한다. AD-35는 CLI 선택·검증·usage·reap의 공통 책임을 정한다. AD-36은 capture 이후 변경을 epic 16으로 분리한다. R1은 남은 저장/삭제 경계다. |
| Deferred가 두 단위를 갈라놓는가 | 건강 의미는 AD-32·epic 14 결정, 물리 DDL/catalog 목록은 14.1·14.2로 분리되어 있다. 분석 schema v1·불명 재시도·C6도 결정 참조가 있어 다시 선택할 필요가 없다. Python pin은 R2. 신규 verb는 CommandSpec/SDK 1:1의 소유권 아래 있다. |
| 다른 AD·Table Contract·Conventions | AD-8의 batch 멱등, AD-13의 날짜/시각, AD-18의 DB 사용자 설정, AD-21의 failures, AD-22의 입력 값 보존, AD-23·24의 파일/추출 경계, AD-29의 connector/core 분석 분리, AD-31의 마이그레이션 소유, AD-33의 감독과 양립한다. U+0000은 저장의 논리 원문과 PG text 표현을 구분하는 예외이므로 AD-15·Conventions의 원문 색인 규칙은 해당 코덱을 함께 참조해 읽어야 한다. |
| 현재 코드와의 차이 | `packages/postgres/src/store.ts:44`는 아직 HealthStore·SchemaStore만 제공하며, `apps/cli/src/dispatch.ts:435`는 SQLite를 기본 조립한다. PG baseline `packages/postgres/migrations/0001_initial.sql:68`·`:83`에는 짝 칸이 없다. 이는 AD-31(`spine:485`)이 이미 교체 대상으로 정한 구현 전 상태이며 이번 문서 변경의 별도 회귀로 세지 않았다. |
| 출력 코드 | `packages/core/src/output/codecs.ts:58`은 JSON.stringify로 JSON escape를 보존하나, `:63`·`:68`의 텍스트 경로는 현재 마스킹만 한다. 새 AD-11의 텍스트 U+0000 escape는 epic 11 구현 인계 사항이다. 저장/읽기 코덱과 함께 적용하기 전에는 구현 완료로 볼 수 없다. |

## 2. 입력 대조

### I1 · medium — 공개 명령 출력의 집계 제한이 보고서·plan 규칙에서 빠졌다

- 근거: `spine:543`, `spine:544` 대 `이전:114`, `이전:130`; `spine:221`의 출력 코덱은 알려진 비밀 패턴을 가릴 뿐 개인 날짜·계정·건강값 전체를 제거하는 공개 투영이 아니다.
- 조건/문제: importer가 private 상세 보고서는 보호하면서 preflight/verify 명령 출력에 자연키·capture 경로·오류 상세를 그대로 낼 수 있다. 새 문장은 “공개 보고서·plan”만 집계로 제한하며, 입력에서 공개 집계로 지정한 “명령 출력”은 명시하지 않았다. 명령 구현과 보고서 구현이 다른 공개 범위를 택할 여지가 남는다.
- 바꿀 문장 제안(AD-36 마지막 문장 교체): “공개 명령 출력·보고서·plan에는 건수, 충돌·제외 사유 수, 단계별 상태와 값 없는 성공 여부만 둔다. 해시 값·원문·계정·개인 날짜·건강값·capture 경로·오류 상세·doctor/조회의 원시 출력은 Brain 홈의 확장 데이터 아래 private 보고서에만 둔다. 공개 실패 원인은 개인 값을 뺀 분류만 쓴다.”
- 처리: 입력의 공개/private 투영 결정을 그대로 명문화한다. 모든 Brain 조회를 집계만 반환하도록 바꾸라는 뜻은 아니며 Garmin 이전 작업의 공개 증거 출력에 적용한다.

| 입력 결정 | spine 반영/판정 |
| --- | --- |
| U+0000 범위·짝 칸·읽기·출력 | `추천:25`, `memlog:182` → `spine:222`·`:558`. transcript 유래 모든 text 칸, U+FFFD 검색·색인·표시, 같은 행 nullable bytea, U+0000 없을 때 NULL, 원문 우선 읽기, 거부 금지, 해당 칸 생성 migration 동반, 텍스트/JSON escape가 적혀 있다. 저장본 가리기 연결은 R1. 이 worktree의 epic 11 Notes보다 지정된 추천 ledger·memlog를 우선했다. |
| 분석 에이전트·모델·effort | `분석:61`·`:62`, `memlog:183` → `spine:534`. DB 설정, Codex/CLI 기본 모델/high/20분, Codex·Claude Code adapter 둘, 같은 schema 검증·그룹 정리·reap·ABI usage, 선택 CLI 로그인 환경으로 Source conflict를 해소했다. |
| 분석 프롬프트·schema | `분석:60` → `spine:777`. 옛 report v1 그대로, 실사용 뒤 새 revision이라는 결정이 보존됐다. R12의 평가 순서·개별 성공 보존과 전송 실패 분리는 `spine:530`·`:533`에 유지된다. |
| 불명 발신 재시도 | `채널:83` → `spine:535`·`:788`. 같은 요청 새 attempt, 지수 간격, 10번 뒤 failures/doctor·resend, 중복 허용이 유지된다. 최초 gate와 의미 키도 남는다. 요청 UUID를 바꿔 우회하는 결정이 아니다. |
| ambiguity의 범위 | `이전:51`·`:128`, `세트:29` → `spine:493`. 규칙으로 고른 현재 값과 보관 후보는 구별되고, 동률 다른 값·동시각 다른 해시·계정 미확인만 제외된다. fetched_at revision 순서·정수 normalization 비교·동값 동률 하나도 반영됐다. |
| raw key·계정 identity | `이전:109`·`:110` → `spine:471`·`:544`, `spine:493`. scope/key 정규형과 raw profile id 확인, 모이지 않는 계정의 미확인 보존·ambiguity 제외가 연결된다. |
| 기준 소스 A·새 수집 | `이전:106`·`:111`, `memlog:185` → `spine:493`·`:544`. A 참조가 D2 → D1 → D4 → D5 → D3을 고정하므로 보관본 순서를 새로 고를 권한은 없다. dataset 역할은 private manifest이며 새 수집 출처를 앞에 놓는 새 규칙 버전은 epic 16 책임이다. |
| 새 capture·전환·C6 | `이전:115`·`:128`, `이니셔티브:188`·`:190` → `spine:543`·`:544`·`:790`. 반입 직전 일관 capture, read-only backup API, 파일 복사 전후 해시, 옛 writer 유지, 이후 변경/옛 예약 중지는 epic 16, 에이전트 실제 반입 위임이 반영됐다. 추가 사용자 선택 gate는 필요 없다. |
| R5~R7·C5 보존 | `이니셔티브:31`·`:32`·`:33`·`:51` → `spine:495`·`:533`·`:542`·`:544`·`:545`. 미선택 원본·출처, batch 재개, 분석 본문·파일 관계 전수 비교, nullable metadata/누락 flag, 재분석 대체 금지가 유지된다. |
| 공개/private 보고서 | `이전:114`·`:130` → `spine:544`. 보고서·plan의 집계 경계는 반영됐지만 공개 명령 출력 범위는 I1 보완 필요. |
| lock·수동 실행 소유 | `이전:108`·`:113` → `spine:789`·`:792`. 14.1 driver/epic 16 옛 의존 분담과 공용 ext run이 반영됐다. Stack pin 불일치는 R2. |
