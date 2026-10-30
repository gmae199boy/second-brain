---
type: epic
title: "확장 설치와 install 스킬"
parent: personal-brain
covers: [R1, R16, R17]
sources: [_bmad-output/personal-brain/initiative-personal-brain.md, _bmad-output/personal-brain/architecture-brain-v1-slice-1/architecture-brain-v1-slice-1.md]
companions: [_bmad-output/personal-brain/architecture-brain-v1-slice-1/architecture-brain-v1-slice-1.md, _bmad-output/personal-brain/prep-garmin-absorption/integration-boundaries.md, _bmad-output/personal-brain/tickets/epic-extensions/epic-extensions-research-code.md]
after: []
refined: true
risk: high
---

# 확장 설치와 install 스킬

## Description

선택 확장을 설치·활성화·비활성화하고 그 상태를 Brain이 관리한다. 범위는 다음과 같다.
- 확장 실행 환경(uv·Python ≥3.12와 잠금 파일)과 데이터는 Brain의 공통 설치 위치와 DB에 둔다. 플러그인의 버전별 캐시에는 두지 않는다.
- TS core와 확장 사이의 포트는 spine이 정했다: manifest(AD-29), DB 계약(AD-30), 프로세스 규약(AD-33). 이 에픽은 manifest JSON Schema와 설정 snapshot 전달을 만들고, epic 12가 만든 프로세스 ABI v1을 manifest 버전에 묶는다. TS·Python이 같은 fixture를 통과한다.
- 확장 registry: 설치·활성 상태의 유일한 작성자이고 공개 상태 view를 낸다. 검색·doctor·install 스킬이 이 view를 읽는다. 비활성화는 예약 발화와 새 청구를 막고, 대기·진행 작업의 중단 상태를 기록한다(AD-29).
- 설치 때 확장 schema와 `brain_ext_<name>` role(non-superuser·NOBYPASSRLS, 출처를 role에 결합)을 만들고, 확장 마이그레이션을 core 실행기로 적용한다(AD-30·31). 확장은 `<home>/extensions/<name>/`에 둔다(AD-34).
- 설치 CLI: `brain ext install|list|status|enable|disable <name>`(2026-10-28 정제. 처음 제안한 `brain install <확장>`을 대신한다).
- Brain 플러그인에 기본 포함하는 공통 install 스킬. 순서는 CLI 지원·설치 상태 확인 → 설치 → 사용자 로그인 안내 → 연결 확인 → 공통 스케줄러에 예약 등록 → 단계별 실제 결과 보고다.
- Garmin을 설치하지 않은 Brain은 Python 의존을 요구하지 않는다.

상세 규칙은 integration-boundaries "확장 설치 안내 스킬"에 있다(2026-10-28, 이니셔티브 R1·R16·R17). 코드 조사(2026-10-28, `epic-extensions-research-code.md`)가 찾은 것: `plugin/skills/`는 아직 없다. 지금 설치 결과는 실패 때 성공한 단계를 남기지 않는다. 지금 등록부에 `ext`·`config`·`schedules` 명령이 없다. 이 Mac에는 `uv`(`~/.local/bin/uv`)와 시스템 `python3`가 있지만 버전과 arm64 설치 재현성은 확인되지 않았다.

## Outcome

Garmin을 쓰지 않는 사용자는 아무것도 더 설치하지 않는다. 쓰는 사용자는 "Garmin 연결해 줘"라고 말하면 에이전트가 설치부터 예약까지 실제 상태를 확인하며 안내한다(이니셔티브 Done when 8의 설치 부분).

## Requirements

- E13-1 (R17): 확장 명령 — `brain ext install|list|status|enable|disable <name>`이 CommandSpec·명령 메타·SDK 1:1로 있고 `brain guide schema ext`에 보인다. 설치할 수 있는 확장은 Brain 앱에 함께 오는 `extensions/<name>/` 패키지뿐이다(임의 서드파티 코드 없음). 출력은 Core 출력 코덱을 거친다. (AD-5·29)
- E13-2 (R1, C4): manifest v1 — 버전 있는 JSON Schema다. 이름·버전·호환 core 버전·묶인 프로세스 ABI 버전, 일감 종류와 실행 명령(실행 분류 `supervised`), 기본 예약, DDL 마이그레이션 위치, 설정 키(`<ext>.*`, 타입·기본값·비밀 참조), raw view, 인증·로그인 단계·연결 확인 명령을 담는다. valid/invalid fixture를 epic 12.4와 같은 방식으로 core 패키지와 함께 배포하고, TS 코덱과 Python이 같은 판정을 낸다. 호환되지 않는 manifest는 설치를 거부한다. (AD-29·33)
- E13-3 (R4, AD-33): 설정 snapshot — manifest가 선언한 키를 설정 코덱에 등록한다(선언하지 않은 `<ext>.*` 키는 거부). 실행 시작 때 Runtime이 DB 설정·기계 값·`.env`의 비밀 참조로 그 실행의 불변 snapshot을 만들어 감독자가 자식에게 넘긴다. 확장은 `settings`·`config.toml`·`.env`를 직접 읽지 않고, 비밀은 argv·로그·stdout·공개 상태 view에 나오지 않는다. (AD-18·33)
- E13-4 (R1, R17): 설치 환경 — 확장 패키지와 실행 환경은 `<home>/extensions/<name>/`에 두고 플러그인 캐시에 두지 않는다. Python 확장은 패키지의 `pyproject.toml`·`uv.lock`·`.python-version`으로 `uv sync --frozen`하고, 실제 Python patch 버전을 확인한다. 확장 마이그레이션은 core 실행기가 소유자 `<name>`의 연속 번호로 적용한다. (AD-31·34)
- E13-5 (R16, AD-30): 확장 DB 권한 — 설치가 확장 schema와 `brain_ext_<name>` role을 만든다. role은 non-superuser·NOBYPASSRLS이고 계약 표 owner와 분리되며, 출처는 GUC가 아니라 role에 결합된다. 자기 schema 전부, core 공개 view SELECT, epic 12.3의 attempt 확인 함수 EXECUTE만 갖고, `work_items` 청구·갱신과 그 밖의 core 표 권한은 없다. 비밀번호는 `.env`(0600)에 둔다. 계약 표의 RLS 정책은 그 표를 만드는 epic 14·15가 둔다. (AD-30·33)
- E13-6 (R16, R17): registry와 공개 상태 — registry가 설치·활성 상태의 유일한 작성자다. 설치·활성·로그인·연결 확인·예약 등록을 각각 다른 사실로 남기고(하나의 "설치됨"으로 뭉치지 않음), 단계별 결과와 마지막 실패를 둔다. 공개 상태 view를 doctor·install 스킬·epic 17 검색이 읽는다. (AD-29)
- E13-7 (R17): 단계 보고와 재개 — `ext install`은 단계마다 실제 결과를 registry에 남기고, 다시 돌리면 끝난 단계를 건너뛰어 이어 간다(중복 설치·중복 마이그레이션·중복 예약 없음). 실패·취소·로그인 미완료·연결 실패·스케줄러 미준비를 다른 결과로 보고하고, 끝나지 않은 단계를 완료로 보고하지 않는다. 보고는 registry를 다시 읽은 값이다.
- E13-8 (R16): 켜기·끄기 — `ext disable`은 같은 트랜잭션에서 활성 상태를 바꾸고 epic 12.10의 보류 그룹 `extension:<name>`을 보류한다(진행 일감 취소, 대기 일감 `extension_disabled`, 예약 발화와 새 청구 차단). `ext enable`은 해제해 이어서 돌게 한다. 확장의 schema·데이터·분석·파일은 남는다. doctor와 `ext status`가 꺼진 상태와 멈춘 일감 수를 보인다. (AD-29)
- E13-9 (R17): install 스킬 — `plugin/skills/install/SKILL.md`를 플러그인에 기본으로 넣는다. 스킬은 `brain guide schema ext`로 지원을 확인하고, 명령이 없으면 미구현이라고 알리며 임의 패키지 설치로 우회하지 않는다. 순서는 상태 확인 → 설치 → 로그인 안내(사용자가 직접 끝내고, 비밀번호·MFA를 대화나 스킬에 남기지 않음) → 연결 확인 → epic 12.9의 예약 SDK로 등록 → 재조회한 단계별 결과 보고다. 별도 LaunchAgent를 만들지 않는다.
- E13-10 (R1): Python 없는 기본 Brain — 확장을 설치하지 않은 Brain의 setup·플러그인 bootstrap·hook 수집·doctor는 Python·uv를 찾거나 실행하지 않고 `<home>/extensions/`를 만들지 않는다. 플러그인을 업데이트해도 설치된 확장의 환경·설정·DDL·데이터가 남는다.

## Constraints

- C4 (parent): Core·CLI·플러그인은 TypeScript, 확장은 프로세스 경계 너머의 별도 패키지다. core는 manifest가 선언한 명령을 부르는 것 말고는 확장 코드를 import하지도 부르지도 않는다(AD-29).
- 비밀번호·MFA를 대화나 스킬 본문에 저장하지 않는다. 설치 명령이 없으면 임의 패키지 설치로 우회하지 않는다.
- 새 core 마이그레이션은 epic 11·12 뒤의 다음 번호다. 확장 번호는 core 번호와 따로 간다(AD-31).
- 시험은 fixture 확장으로 한다. 실제 Garmin·실계정·모델을 부르지 않는다. 기본 시험 suite는 Python을 요구하지 않고, Python fixture 시험은 따로 부르는 진입점이다.

## Done when

1. Garmin 미설치 Brain이 Python 없이 설치·수집·doctor를 통과한다(Python·uv를 찾지도 실행하지도 않음을 시험이 확인한다).
2. install 스킬로 미설치 → 설치 → 로그인 → 연결 확인 → 예약 등록의 정상 경로가 테스트 확장에서 돈다.
3. 이미 설치되었거나 부분 설정된 상태에서 다시 돌리면 중복 설치 없이 이어 간다. 설치 실패·취소·로그인 미완료·스케줄러 미준비는 단계별로 구분해 보고하고, 끝나지 않은 단계를 완료로 보고하지 않는다.
4. 확장을 비활성화해도 그 데이터가 남고, 확장 상태와 멈춘 작업이 드러난다. 검색 응답에 꺼진 상태를 보이는 일은 epic-search-and-health-query다.
5. 플러그인을 업데이트해도 확장 환경이 남고, 기능 묶음이 플러그인 배포로 이 Mac의 설치본에 들어가 동작한다(에이전트가 확인한다, 2026-10-28 위임).

## Boundaries

다음은 이 에픽 밖이다.
- Garmin 수집·정제는 epic-garmin-runtime, 건강 분석은 epic-health-analysis, Garmin 스키마와 기존 데이터·Garmin 잠금 파일의 실제 재현성 검증은 epic-garmin-import다.
- 각 core 계약 표의 RLS 정책은 그 표를 만드는 에픽(14·15)이 둔다. 이 에픽은 role과 출처 결합 규칙만 만든다.
- 보류·취소·재개의 실행 수단은 epic 12(12.10)이고, 이 에픽은 registry에서 그것을 부른다.
- 공개 plugin marketplace와 임의 서드파티 확장 코드 실행은 범위 밖이다.
- Must not change: 비밀번호·MFA를 대화나 스킬 본문에 저장하지 않는다. 설치 명령이 없으면 임의 패키지 설치로 우회하지 않는다.

## References

- parent — _bmad-output/personal-brain/initiative-personal-brain.md, Requirements R1, R16, R17, Constraints C4
- design — _bmad-output/personal-brain/prep-garmin-absorption/integration-boundaries.md, "확장 설치 안내 스킬", "실행·의존성"
- architecture — _bmad-output/personal-brain/architecture-brain-v1-slice-1/architecture-brain-v1-slice-1.md, AD-1, AD-5, AD-18, AD-19, AD-29, AD-30, AD-31, AD-33, AD-34
- research — _bmad-output/personal-brain/tickets/epic-extensions/epic-extensions-research-code.md (2026-10-28 정적 코드 조사)

## Notes

- Waits on epic-postgres-primary because: 확장 DDL을 받을 마이그레이션 실행기, 사용자·확장 설정 DB, PostgreSQL 위 설치 흐름이 필요하다.
- Waits on epic-jobs-and-scheduler because: install 스킬의 예약 단계가 공통 스케줄러의 등록 API를 부르고, 연결 확인이 감독자와 프로세스 ABI v1로 테스트 확장의 명령을 자식 프로세스로 부른다.
- Decision(2026-10-28, spine AD-29·30·33·34): TS↔Python 포트는 manifest·DB 계약·프로세스 규약이고, 확장 패키지는 `<home>/extensions/<name>/`(spine [ASSUMPTION])에 둔다. 이전의 Open question을 대신한다.
- Decision(2026-10-28, 사용자): 확장을 끄면 진행 중인 그 확장의 일감은 감독자 취소로 끊고, 대기 일감은 `extension_disabled`로 보류했다가 다시 켜면 이어서 돈다. 그 확장의 데이터를 읽는 core 분석 예약도 멈춘다. registry가 이 상태를 공개 상태 view로 낸다(epic-jobs-and-scheduler Notes 같은 날). 이전의 Open question을 대신한다.
- Decision(2026-10-28): 새 확장 CLI는 AD-5의 `<ns> <verb>` 모양이다. 안은 `brain ext install|status|enable|disable <name>`이고, install 스킬은 이 명령을 부른다. 정제 때 CommandSpec과 SDK를 1:1로 확정한다(spine Deferred "신규 공통 CLI namespace/verb"). → 정제에서 `list`를 더해 확정(아래).
- Handoff(2026-10-28, epic 12 세트 검증 F4): 확장 끄기에서는 registry가 epic 12의 보류 그룹 계약(12.10)을 부른다. 확장의 `<ext>.*` 일감은 자동으로 `extension:<ext>` 그룹이다. 예약 등록은 12.9의 SDK를 쓴다. 연결 확인은 12.1의 감독자와 12.4의 ABI v1 fixture(core 패키지 배포본)를 쓴다. 테스트 확장은 probe worker `process_probe`(12.1)를 바탕으로 한다.
- Decision(2026-10-28, 정제, 추천으로 정함): 명령은 `brain ext install|list|status|enable|disable <name>`이다. 설치할 수 있는 것은 Brain 앱에 함께 오는 `extensions/<name>/` 패키지뿐이다(spine 패키지 표). 시험 fixture는 시험 안에서만 쓰는 패키지 경로 주입으로 설치한다. 사용자용 `--from <경로>` 옵션은 두지 않는다(임의 서드파티 코드 실행은 범위 밖).
- Decision(2026-10-28, 정제, 추천으로 정함): 테스트 확장은 둘이다. `testext`는 Node로 된 fixture(12.1의 `process_probe` 바탕)로 tracer와 설치·스킬·켜기/끄기 경로를 맡는다. `pyfixture`는 `pyproject.toml`·`uv.lock`·`.python-version`을 가진 최소 Python fixture로, `uv sync --frozen`·patch 버전 확인과 manifest·ABI fixture의 Python 판정을 맡는다. 옛 Garmin 잠금 파일(해시는 코드 조사 5절)의 실제 macOS arm64 재현성 검증은 Garmin 확장 뼈대를 처음 만드는 epic 14가 맡는다(spine Deferred "Garmin lock·설치 재현성"의 owner 13·14 분담).
- Decision(2026-10-28, 정제, 추천으로 정함): 단계별 결과는 registry 행에 남기고, `ext install`의 응답은 그 행을 다시 읽은 값이다. 설치 흐름(`setup run`)의 기존 실패 결과에는 성공한 단계 목록이 없으므로(코드 조사 2절) 그것을 그대로 쓰지 않는다.
- Decision(2026-10-28, 정제, 추천으로 정함): `ext disable`의 활성 변경과 epic 12.10의 보류는 같은 DB 트랜잭션에서 확정한다. 12.10 port가 트랜잭션을 받지 못하면, registry가 시작 때와 `ext status` 때 활성 상태와 보류 그룹을 맞추는 재조정 use case를 둔다. 어느 쪽이든 "꺼졌는데 청구되는" 상태는 시험이 막는다.
- Decision(2026-10-28, 정제, 추천으로 정함): install 스킬의 시험은 두 층이다. 정적 검사(스킬이 부르는 명령·옵션이 CommandSpec에 있음, 비밀번호·MFA·임의 설치·LaunchAgent 지시가 없음)와, 가짜 CLI를 둔 행동 시험(정해진 case마다 에이전트가 스킬을 읽고 부른 명령 순서와 최종 보고를 대조)이다. 행동 시험은 기본 suite에 넣지 않고 따로 부르는 진입점이다. 실제 에이전트 실행은 이 Mac 확인(10)에서 한 번 한다.
- Decision(2026-10-28, 스토리 계획): tracer는 1이다. `brain ext install testext`가 최소 manifest를 읽고, `<home>/extensions/testext/`에 패키지를 두고, 소유자 `testext`의 마이그레이션 0001을 적용하고, registry에 설치를 남긴 뒤, 12.1의 감독자로 testext의 연결 확인 명령을 자식 프로세스로 돌려 `brain ext status testext`가 `connected`를 보인다. 실제 Garmin·Python·로그인·스킬은 열지 않는다. 다음은 가장 덜 확실한 경계인 2(manifest·snapshot)와 3(Python 경로)이다.
- Decision(2026-10-28, 스토리 계획): registry·설치·코덱·감독자 조립·CLI 등록부·core 마이그레이션 번호를 거의 모든 스토리가 함께 고친다(코드 조사 8절). 그래서 1~8은 한 줄로 만든다. epic 12와도 같은 파일을 고치므로 1은 epic 12의 마지막 코드 스토리(12.11 Refactor sweep)를 기다린다. epic 11→12의 선례(12.1이 11.11을 기다림)와 같다. Refactor sweep(9) 뒤에 이 Mac 확인(10)을 둔다. 이 Mac 확인은 에이전트가 한다(이니셔티브 2026-10-28 위임).
- Decision(2026-10-28, 세트 검증 F4): epic 11 쪽 entry(11.6·11.10)의 설명에는 13에 주는 인계 문장을 더하지 않는다(루프가 만드는 중). 받는 쪽인 13.1·13.2가 무엇을 받는지 적고, 실제 경로와 시그니처는 epic 11·12가 끝난 HEAD에서 확인한다. Dependencies의 "양쪽 description이 인계를 말한다" 조건의 명시적 예외다(epic 12 F3과 같은 방식).
- Decision(2026-10-28, 세트 검증 F1, 추천으로 정함): testext와 가짜 로그인은 기본 홈이 아닌 Brain 홈에서 환경 변수로만 켜지는 시험용 resolver·harness로 쓴다. 10의 설치본 확인은 격리된 홈·DB·Label에서 설치본과 같은 앱·스킬로 하고, 운영 설치본은 버전과 스킬 발견만 확인한다. 사용자용 설치 옵션이나 testext의 일반 출하는 더하지 않는다.
- Decision(2026-10-28, 세트 검증 F3): 공개 상태 view의 최종 생산자는 6이다. 1(설치·활성·연결)과 5(로그인·예약·실패)가 사실을 만들고, 6이 비밀 없는 한 조회 계약으로 내어 doctor·`ext status`·install 스킬·epic 17이 읽는다.
- Decision(2026-10-28, 세트 검증 S1·S2 채택): 1의 plan은 testext 하나·연결 확인 하나·DDL 0001 하나·정상 결과 한 건으로 제한하고, 넘치면 비필수 완성을 이름 붙인 다음 스토리로 뺀다. 1이 격리 PG·Brain 홈·testext 설치 fixture·정리 도구를 만들고 뒤 스토리가 다시 쓴다. 각 plan은 실행 명령, 사전 조건, 관찰값, 정리를 적고, 기본 Node/PG suite, 선택 Python suite, 선택 스킬 행동 평가를 구분한다. 7의 행동 평가는 실제 SKILL.md를 입력으로 받고 `connection_failed`와 "공개 상태에 비밀 없음"도 case로 둔다.
- Decision(2026-10-28, 세트 검증 F5, 추천으로 정함): risk와 그 이유(잘못됐을 때 영향).
  - 1 high: 설치 경로가 틀리면 그 뒤 모든 확장(Garmin)이 깨진다.
  - 2 high: snapshot이 비밀을 argv·로그로 흘리면 자격 증명이 샌다.
  - 3 high: 잠금이 재현되지 않으면 Garmin 설치가 이 Mac에서 실패한다.
  - 4 high: 권한이 넓으면 확장이 다른 출처 데이터나 core 표를 바꾼다.
  - 5 high: 거짓 완료를 보고하면 사용자가 예약이 됐다고 믿고 데이터를 놓친다.
  - 6 medium: 끈 뒤에도 일감이 돌면 원치 않는 외부 호출이 생긴다. 데이터 손실은 없다.
  - 7 medium: 스킬이 틀리면 안내가 틀리지만, CLI 상태가 진실이다.
  - 8 medium: 기본 Brain이 Python을 요구하면 R1이 깨진다. 발견하면 바로 고칠 수 있다.
  - 9 low: 기능을 바꾸지 않는 정리다.
  - 10 medium: 설치본에서만 드러나는 배포 누락을 놓친다.

- Decision(2026-10-30, 추천으로 정함, 13.2 escalation 해소): ABI v1 선택 snapshot 입력과 단계별 비밀 요구·확장 진단 보호를 13.2 plan intent-contract에 확정한다. 독립 Codex가 기존 코드의 누출 반례와 보완 계약을 검증했다.
- Decision(2026-10-30, 사용자): 에픽마다 두던 Refactor sweep(13.9)을 뺐다(`dropped`). 리뷰가 미룬 기존 결함은 `deferred-work.md` 장부에 남고, 사용자가 원할 때 `bmad-loop sweep`으로 직접 처리한다. 이 Mac 확인(13.10)은 sweep 대신 sweep이 기다리던 스토리들을 기다린다.

- Decision(2026-10-30, 추천으로 정함, 13.4 escalation 해소): `brain.extension_status_public_v1`은 이름·활성 의도·연결 상태만 내고 확장 role에는 자기 행만 허용한다. 명시 ACL과 유효 권한·반례 시험을 적용하며 13.6은 v1을 보존하고 풍부한 공개 상태 계약을 완성한다. 근거는 13.4 plan과 registry migration이다.
- Decision(2026-10-30, 추천으로 정함): 13.4는 Node testext 설치·확장 DDL(13.1)과 attempt 확인(12.3)만 받아 Python 설치(13.3)를 기다리지 않는다. 모든 설치 단계의 결과·재개를 다루는 13.5는 Python 환경 단계를 위해 13.3을 직접 기다린다. Python 없는 기본·갱신 보존(13.8)은 설치·pyfixture(13.3)까지만 필요하고 스킬(13.7)은 필요하지 않다. 앞 에픽 완료 HEAD 대신 착수 시점 main HEAD에서 시그니처를 확인한다.

- Decision(2026-10-31, 추천으로 정함): 사람 개입 없이 진행한다. 13.5의 미완료 구현은 작은 단계별 보고·검증으로 자동 재추진하며 전체 계약은 유지한다.
