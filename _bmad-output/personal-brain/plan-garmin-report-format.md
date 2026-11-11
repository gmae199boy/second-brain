---
title: 'Garmin 저장 평가 리포트 서식과 재발신'
type: feature
ticket: ''
created: '2026-11-11'
status: built
baseline_revision: '39f37cfc9bfc40fcb8e80f8bbd6179de28899508'
route: full
route_source: pinned
risk: medium
review: quick
review_source: pinned
lenses_ran: [quick]
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**문제:** 기존 Garmin 메시지는 하루와 기간 요약을 긴 문단으로 붙여 보내며 한계가 반복된다. 저장 평가를 분석 재실행 없이 새 서식으로 다시 보낼 경로가 없다.

**접근:** 저장된 일일 지표와 분석 평가로 제목·회복 판정·수치·권고·기간별 추세·한계를 렌더링한다. 메신저 중립 마크업을 기존 summary 인자에 명시하고 core Telegram adapter가 안전한 HTML로 변환한다.

## Boundaries & Constraints

**항상:** 일일 수치는 계정 범위 DB에서 읽는다. 판정·권고·추세는 평가에서 온다. 구조 필드가 없는 과거 평가도 결정적 문장 축약으로 처리한다. 같은 날짜·revision 벡터·서식 버전은 같은 의미 키를 사용한다. 자동 발신 경로도 같은 렌더러를 사용한다. 원본 수정 뒤 Garmin package를 재생성하고 package 버전 관례를 따른다.

**금지:** 분석 재실행, 실제 발신·실 건강 데이터 사용, 운영 Brain·중앙 상태 변경, main 병합·push, plugin/app-ref·core plugin version 변경, channel_send 시그니처 변경, 개발 중 시험 실행. 구현은 이 워커가 직접 맡고 지정된 독립 리뷰어 1명만 사용한다.

## I/O & Edge-Case Matrix

| 경우 | 입력·상태 | 기대 결과 | 오류 처리 |
|---|---|---|---|
| 새 평가 | 날짜·구조 평가·일일 지표 | 제목, 수치 3줄, 권고, 7일·30일·전체 추세, 한계 1회 | 누락 수치는 측정 없음 |
| 과거 평가 | summary·기존 judgments/next_checks만 있음 | 원문 기반 짧은 판정·추세, 중복 한계 제거 | 근거 없는 회복 수준·연속 일수 생성 금지 |
| 재발신 | 날짜 생략 또는 ISO 날짜 | 기본 계정 시간대 오늘, 저장 revision 선택 후 send | 평가 누락은 명시적 실패, 분석 호출 없음 |
| 중복 요청 | 같은 revision·서식 버전 | 기존 channel 요청 재사용 | 새 서식 버전은 새 요청 |
| HTML 경계 | 마크업·특수문자·긴 본문 | 안전한 escape와 HTML parse_mode | 길이·변환·확정 parse 거부는 평문 fallback |

</frozen-after-approval>

## Code Map

- `extensions/garmin/src/report_channel.py`: 기존 topic·의미 키·자동 send를 재사용한다.
- `extensions/garmin/src/garmin_pipeline/report.py`: DailyAnalysis 검증·저장과 기존 경로 렌더링을 연결한다.
- `extensions/garmin/src/garmin_pipeline/store/__init__.py`: append_evaluation과 latest_evaluation의 기존 계약을 보존한다.
- `extensions/garmin/migrations/0014_native_store.sql`: day_summary와 evaluation_revisions를 원천으로 쓴다.
- `extensions/garmin/src/report_runtime.py`, `scheduled_date.py`: 감독 계정·시도 fence와 날짜 검증을 재사용한다.
- `packages/core/src/channels/send.ts`, `apps/cli/src/adapters/telegram.ts`: 기존 summary 문자열·마스킹 경계를 유지한다.
- `plugins/garmin/skills/brain-garmin-operations/SKILL.md`, `tooling/bootstrap/test/cli-skill-coverage.test.ts`: 공개 manual 사용법과 커버리지를 갱신한다.
- `tooling/package-garmin/build.mjs`: 배포 package 생성기를 그대로 사용한다.

## Tasks & Acceptance

**실행:**
- [x] `extensions/garmin/src/garmin_pipeline/report_message.py`와 출력 schema·분석 스킬·저장 계약에 구조화된 메시지 필드를 연결한다.
- [x] `extensions/garmin/src/report_channel.py`, `garmin_pipeline/report.py`의 자동 발신에 공용 렌더링을 적용한다.
- [x] `extensions/garmin/src/report_send.py`, `report_runtime.py`, `manifest.json`에 분석 없는 manual을 추가한다.
- [x] `apps/cli/src/adapters/telegram.ts`에서 마크업을 escape·변환하고 안전한 평문 fallback을 구현한다.
- [x] `extensions/garmin/tests/`, `apps/cli/test/telegram.test.ts`에 가짜 데이터 수락 시험을 작성하고 스킬 커버리지·package를 갱신한다.
- [x] 독립 Codex gpt-6.1-sol/medium 리뷰, triage·수정 후 최종 전체 회귀와 브랜치 push를 수행한다.

**수락 기준:**
- Given 합성 지표와 평가, when 렌더링, then 승인된 구획과 실제 날짜 요일·DB 수치를 표시한다.
- Given 과거 평가, when 재발신, then 분석 없이 안전한 축약·중복 한계 제거 메시지를 만들며 같은 revision 재시도는 같은 요청이다.
- Given `<>&`·길이 초과·HTML 거부, when Telegram adapter 사용, then escape 또는 평문 fallback이며 불명확한 네트워크 결과는 중복 전송하지 않는다.
- Given 자동 분석 완료, when 기존 send 경로 실행, then 첨부·앨범을 보존하며 같은 서식의 메시지를 전송한다.

## Implementation Notes

## Plan Change Log

## Review Triage Log

- 1차 리뷰: high 1건, medium 2건, low/false/maybe-false 0건. 모두 수락 기준 안의 직접 결함으로 patch 처리한다.
- high / patch: native_schema_version 함수가 실제 migration 최대값을 반환하므로 migration 17과 런타임 상수 16이 불일치한다. 기대 상수를 17로 갱신했다.
- medium / patch: 기준 단어와 멀리 떨어진 회복 부족도 한계로 분류했다. 자료 명사에 직접 연결된 부족·없음 표현으로 제한하고 회귀 사례를 추가했다.
- medium / patch: next_checks의 한계가 권고와 한계에 중복되었다. 권고 fallback에도 분류를 적용하고 회귀 사례를 추가했다.

## Design Notes

summary에 버전 접두어를 둬 기존 함수 인자를 유지한다. 마크업은 제목·목록·굵게·줄바꿈만 지원하며 임의 HTML은 항상 데이터로 escape한다. 과거 문장에서는 명시적인 한계 표현만 분리하고 나머지 문장을 보수적으로 줄인다.

## Verification

- 개발 중 `pnpm build`, `pnpm typecheck`, `git diff --check`만 실행한다.
- 마지막 구현·리뷰 수정 후 `pnpm test` → `pnpm test:python`을 순차로 1회 실행한다.
- 최종 회귀 실패 수정 후 `pnpm test:changed`와 관련 시험을 실행한다.
- 실제 발신·운영 DB 접근 없이 합성 데이터와 시험 DB만 사용한다.

- 중앙 계획 승인: 접두어 없는 요청은 평문 유지. 확정 HTML parse 거부만 같은 attempt에서 평문 재시도하며 불명확한 결과는 재시도하지 않는다.

- 구현 선택: 기존 ext run에는 별도 입력 인자가 없어 report-send만 target을 ISO 날짜로 해석하며 선택 계정은 사용자 설정에서 가져온다. 다른 manual의 UUID target 계약은 유지한다.
- 컴파일: pnpm build, pnpm typecheck, Python 3.14 compileall, git diff --check 통과. 개발 중 시험은 실행하지 않았다.

- 후속 리뷰: 기존 3건 해결 확인. 추가 medium / patch 1건은 FakeRaw 정상 스키마 기본값 16 잔존으로, 상수 store.NATIVE_SCHEMA_VERSION을 참조하도록 수정했다. 시험 대역의 직접 상수 교정이며 추가 제품 변경은 없다.

- 최종 전체 회귀 1회 완료: pnpm test는 5383 통과/8 실패, pnpm test:python은 82 통과/8 실패/0 skip이다. Python 실패는 과거 평문 본문 기대값 6건과 migration 16 고정 기대값 2건으로, 승인된 새 서식·추가 migration 17에 맞게 갱신했다. TS 실패는 별도 시험 cluster와 직렬 실행으로 원인을 재검증한다.
- 새 Telegram 마크업 모듈의 자식 프로세스 의존성을 test-changed 규칙에 명시했다.

- 독립 TS 재검증: 인증·취소와 Drive는 통과했다. legacy 교체는 첫 재검증의 시험 암호 차이를 맞춘 뒤 30/31 통과, 남은 1건도 migration 16 고정 기대값이었다. 이를 17로 갱신했다. 제품 수정 없이 시험 계약을 갱신한 것이다.

- 최종 재검증: test:changed 기본 4파일 54건 통과, Python 전체 16파일 89건 통과/기존 동시 이관 시간제한 1건 실패/skip 0. 마지막 동시 이관 사례는 변경 없이 독립 단일 실행 13.45초에 통과했다. 최초 전체 Python에서는 해당 사례를 포함한 native 17건이 통과했으며 새 기능 실패는 남지 않았다.
- 수락 행 감사: 서식·과거 fallback·중복 한계·DB 수치·0/NULL은 Python 메시지 시험, 날짜·모델 미호출·평가 누락은 manual 시험, revision·서식 버전 멱등은 channel 시험, 실제 manual 경로는 garmin-report 통합, HTML escape·길이·확정 거부·불명 결과는 Telegram 시험으로 실행 확인했다. 기존 자동 전송 종단 6건과 migration 업그레이드 3건도 통과했다.
- 전체 회귀의 최초 실패를 통과로 기록하지 않는다. 초기 TS 기본 공유 시험 서버의 역할 충돌과 병렬 시간 민감 실패는 전용 cluster·직렬 재검증으로 분리했고, 시간 민감 시험의 환경별 재현성은 검증 한계로 남긴다.
