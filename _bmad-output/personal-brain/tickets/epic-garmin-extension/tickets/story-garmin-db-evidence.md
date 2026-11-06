# 21.8 통합 시험 실행·수정 증거 요약

기준 `505188d3a2259f058988c2dd4f68f8dbce4a7b57`, 구현 `472caa7ec0d1c7c51110996a39863e0113a506fd`, release `dbcd3694e4eed16f58a1e2cfdb5da6cb0d55ac07`이다. 최종시험은 release 위 7a 시험파일 수정 한 개를 포함했으며 최종완료commit은 그 바이트와 이 문서/계획만 기록한다. 계획은 built이며 main 반영과 21.7 gate는 중앙이 확인한다.

## 최종 실제 순차 실행

실행ID `20261105T234612Z-40b825f99136`. 원시증거는 로컬 `.brain-automation/logs/final-20261105T234612Z-40b825f99136/`에 전체 command/start/end/exit/log와 수집·자원·source manifests로 보존한다. 매명령 전 새TCP 인증 SELECT1 exit0을 확인했다.

| 명령 | UTC 시작 | UTC 종료 | exit | 결과 |
|---|---|---|---:|---|
| `pnpm test` | 2026-11-05 23:46:14.343 | 2026-11-05 23:48:08.046 | 0 | 186파일·4204통과·기존skip1 |
| `pnpm test:python` | 2026-11-05 23:48:08.093 | 2026-11-06 00:00:07.586 | 0 | 15파일·66통과·skip0 |

실패/미처리오류 보고0이다. hook의 T 조건부skip1은 P START/PASS marker로 실제본문 실행을 확인했다. Garmin U244호출 모두ok(240고유이름+import노출4중복), capture13메서드 모두ok. 최초185T/15P 이름집합 대비 격리fixture 시험파일1추가·누락0. list의2317T/59P 선언과 실제 동적실행 수는 같지 않다. checker들은 무조건 동기호출·정확문구 assertion·해당P전체파일 통과로 성공을 추론하며 최종reporter에 직접 stdout이 인쇄된 것으로 주장하지 않는다. native 설치·감독통합 시험은 별도로 실행됐다.

환경: Node24.17.0, pnpm12.16.1, 시스템Python3.9.6, uv0.13.1, Garmin Python3.14.10/일반확장fixture3.12.13, macOS27.0.1, Docker29.8.2, PostgreSQL18.6. 전용PG18 tmpfs/loopback33134와 유일DB/role/home·합성SQLite/건강자료·fakeGarmin/Codex/Telegram만 사용했다. 기존54329는 재사용하지 않았다.

최종fixture T117/P56의173생성·제거집합 일치 및 정확ID 부재를 확인했다. 별도전용공용컨테이너 `9a17d0ee4a405aa405349b1474731f8a8f88cd149b2c12bdc52ff64b89f47e7f`는 `docker rm -f <정확ID>` exit0 후 inspect의 정확 no such object/exit1을 확인했다(2026-11-06 00:13:09 UTC). 환경값은 공개하지 않는다. 정리증거 `.brain-automation/cleanup-final/`.

## 누락 및 실패 처분

11선행계획 원문702행을 assertion447/비시험정적66/역사189로 보존했다. 실제2131단언/335메서드 연결과329후보/79checker행 처분 및 세외부표면 보완을 대조했다. 702개시험이라는 뜻이 아니다. 적용migration·고정oracle/legacy117파일은 기준과 동일하다. 상세파일 `coverage-final.md/json`, `failure-disposition-final.md/json`, `final-execution-audit.md/json`은 로컬 `.brain-automation/`에 있다. 원문ID/내용·최초121실패·내부unit7/capture하위14 식별자를 유지했고 최종필수실행공백0이다.

| 원인 경계 | 수정·관련재검증 근거 |
|---|---|
| 고정PG역할의 클러스터 전역 충돌 | 4a~4b 고유컨테이너/owner fixture·설치38·병렬검증,5a/5d 실제실패주입·정리10시험 |
| 현재공용계약과 fixture 차이 | 4c core114/코드문서434/capture13,4d PG32,4e 예약·감독82,4j CLI112,4k npx2/hook8 |
| scoped schema 참조 컴파일 | 4b1 TS 실제값검증·분산fixture와Python parity |
| Python환경이 DDL 뒤 준비됨 | 4f2 same-stage SQL복구184,4f3 환경선행/relocation·기존설치4+이동1,5b/5b1 실제manifest.files package6 |
| Garmin fixture/fence/역할/업그레이드 | 4g U244skip0,4h native7/U244,4i17,4l collect/core6+report15 |
| 누락checker·외부표면 | 4m 두P파일과기존checker79행 처분,4n 외부실패표면55+반입5 |
| 배포version·보존관찰 | 5c Python9/TS41, 이전실제package갱신/native전체보존/capture13 |
| 후보core 경쟁 | 6a 최초500정산후 합성시계전진, core2/hook8; 제어재현은가능경로 증명이며 당시상태 소급확정 아님 |
| release시험 신원과 환경 | 7a strict package/source/plugin 비교·고정이전신원 유지, 정확DSN upgrade3/command-lock2/work-hold2 |

관련재검증은 각 `fix-*-report.md`와 원시 exit/log로 연결한다. 제품/fixture 수정은 구현472caa7, 배포메타데이터는 release dbcd369, 마지막7a시험수정은 최종완료commit이다. 최초 T86/P35 실패 및 오류2/skip1 이력, 후보core1 실패, 잘못추정한DSN T791+suite/추가skip2 및 Pplugin불일치1 실패를 그대로 보존한다. 마지막경우 환경원인과기대신원수정 뒤 정확환경전체성공으로 연결하며 791개 제품수정을 주장하지 않는다.

## 독립 리뷰와 증거 제한

독립 Sol thorough 네렌즈 2회, 최초14 medium 및 후속2 medium을 개별triage·수정·관련재검증했다. Python전환·정리·6a·7a 집중후속은 새확정결함0. 최종 runtime 감사는 해시147항목·source전후/current동등·U/capture개별결과·hookmarker·173ID부재를 직접대조해 필수공백0을 확인했다. reject0/deferred0/high0, 마지막후속 patched high0이므로 추가후속권고false다.

5b에서 기존스크립트를 source하여 최초T raw/start와collection raw를 덮어쓴 증거보존 사고가 있었다. 최초T raw byte/full stdout-stderr동일성·원래start·최초collection raw/정확조회시각은 미복구다. 중앙은 T85397byte 보존텍스트·P원시사본·실패121ID/원래행·출처있는시각·최초185/15파일집합의 제한역사사용만 수용했다(`msg_1c15fbd0bf0b`). 원래raw보존충족이나사고무발생 판정이 아니다. 사고partial 재실행과 옛end/exit를 결합하지 않는다. 퇴역runner는 source/직접실행을 거부하며 신규증거는 고유ID·배타파일생성으로 보호했다. 잘못된DSN 실행의 전체inspect에 포함된 합성환경값은 제한권한 로컬보관하며 공개하지 않는다.

| 고정 바이트 | SHA256 |
|---|---|
| pnpm lock | `8a660ec5b6eeaab862cd7a9b76c8e1cf1d3ea6125f630f86726718ea18e37fac` |
| 전후 source manifest | `f8e5df2acf6964e2a305b31d32ffeefb2a1d092e0b1aee96422c950b2342f01f` |
| 최종7a 시험파일 | `72482076cfd72352d8dcc269c2621c104a4545da344aae748ca177f8eb1e50e7` |
| 실행 dirty diff | `58dd993e51bea4bad2497f570cff43a9c42d9c988496e6765b3bcf87e180dd74` |
| Garmin package digest 값 | `65b6d7c03d67061e5109df8ad8f69510a00f2cc779b66da7444a5f4151397110` |
| 최초 T 보존텍스트 | `fe8e5ac7398d1137f78060eed885fdc43d57441bfdc2b375b87298e6d566914d` |
| 최초 P 원시사본 | `ce026bfbf85f028bbed00d7842b474cc2a2087350f7115c433ff349d1965f892` |

실계정/실모델/운영전환은 검증범위 밖이다. 선행 credential 운영자확인/원본스킬 재생성가정/불명잠금·legacy안전거부·offline/attempts정책은 유지한다. ResourceWarning와기타경고는 원시에 남아 있으며 오류0은 경고0이 아니다. 두app-ref는 이전구현472caa7을 참조하며 coreplugin0.1.17/Garminplugin0.1.4/확장1.2.1,85선언파일·원본바이트·digest 동등을 독립확인했다.

## 변경 파일

- `README.md` — 현재 오류코드·출력 계약 문서 정정.
- `_bmad-output/personal-brain/tickets/epic-garmin-extension/tickets/story-garmin-db-plan.md` — 실행계획·개별리뷰판정·최종built 및 검증결과.
- `apps/cli/python-test/garmin-capture.test.ts` — 누락capture13메서드 전체연결·skip경계 관찰.
- `apps/cli/python-test/garmin-collect.test.ts` — 현재계약 fixture·실패경계·실행관찰 회귀 보완.
- `apps/cli/python-test/garmin-core.test.ts` — 현재계약 fixture·실패경계·실행관찰 회귀 보완.
- `apps/cli/python-test/garmin-import-verify.test.ts` — 현재계약 fixture·실패경계·실행관찰 회귀 보완.
- `apps/cli/python-test/garmin-native.test.ts` — 현재계약 fixture·실패경계·실행관찰 회귀 보완.
- `apps/cli/python-test/garmin-preflight.test.ts` — 현재계약 fixture·실패경계·실행관찰 회귀 보완.
- `apps/cli/python-test/garmin-tracer.test.ts` — 현재계약 fixture·실패경계·실행관찰 회귀 보완.
- `apps/cli/python-test/garmin-unit.test.ts` — 현재계약 fixture·실패경계·실행관찰 회귀 보완.
- `apps/cli/python-test/garmin-upgrade.test.ts` — 실제이전배포 갱신·현재신원엄격비교·기존행보존.
- `apps/cli/python-test/install.test.ts` — 실제manifest.files Python package·중단재개·relocation.
- `apps/cli/src/runtime/extension-python.ts` — relocatable 환경 준비와 격리 빌드 작업공간.
- `apps/cli/src/runtime/extension-transition.ts` — DDL 전 Python환경 준비·재개검증·취소정산.
- `apps/cli/src/runtime/extensions.ts` — prepared stage의 환경 상태 검증 연결.
- `apps/cli/src/runtime/json-schema.ts` — scoped ID/ref 재귀 컴파일 경계 수정.
- `apps/cli/test/command-meta.test.ts` — 현재계약 fixture·실패경계·실행관찰 회귀 보완.
- `apps/cli/test/daemon-run.test.ts` — 현재계약 fixture·실패경계·실행관찰 회귀 보완.
- `apps/cli/test/ext-fixture-isolation.test.ts` — 실제 Docker 생성/정리 실패주입·소유격리 회귀.
- `apps/cli/test/ext-fixture.ts` — 고정역할 설치fixture 격리·독립정리·오류보존.
- `apps/cli/test/ext-install-resume.test.ts` — 현재계약 fixture·실패경계·실행관찰 회귀 보완.
- `apps/cli/test/ext-install.test.ts` — 현재계약 fixture·실패경계·실행관찰 회귀 보완.
- `apps/cli/test/ext-package.test.ts` — 현재계약 fixture·실패경계·실행관찰 회귀 보완.
- `apps/cli/test/extension-commands.test.ts` — 현재계약 fixture·실패경계·실행관찰 회귀 보완.
- `apps/cli/test/extension-python.test.ts` — 현재계약 fixture·실패경계·실행관찰 회귀 보완.
- `apps/cli/test/extension-transition.test.ts` — 현재계약 fixture·실패경계·실행관찰 회귀 보완.
- `apps/cli/test/pg-home.ts` — 격리 fixture DB 수명 연결.
- `apps/cli/test/schedule-cron.test.ts` — 현재계약 fixture·실패경계·실행관찰 회귀 보완.
- `apps/cli/test/schedules-queue-list.test.ts` — 현재계약 fixture·실패경계·실행관찰 회귀 보완.
- `extensions/garmin/manifest.json` — Garmin 확장 배포version 증가.
- `extensions/garmin/src/batch_import.py` — 미지원schema preflight 코드 보존.
- `extensions/garmin/src/role_probe.py` — 공용 conversation 함수 최소권한 탐지.
- `extensions/garmin/tests/check_batch_import.py` — 현재 fence·권한·합성자료 계약 및 checker 관찰 보완.
- `extensions/garmin/tests/check_preflight.py` — 현재 fence·권한·합성자료 계약 및 checker 관찰 보완.
- `extensions/garmin/tests/normalize_oracle_child.py` — 현재 fence·권한·합성자료 계약 및 checker 관찰 보완.
- `extensions/garmin/tests/preservation_entry.py` — 현재 fence·권한·합성자료 계약 및 checker 관찰 보완.
- `extensions/garmin/tests/test_native_artifacts.py` — 현재 fence·권한·합성자료 계약 및 checker 관찰 보완.
- `extensions/garmin/tests/test_native_import.py` — 현재 fence·권한·합성자료 계약 및 checker 관찰 보완.
- `extensions/garmin/tests/test_normalize_oracle_pg.py` — 현재 fence·권한·합성자료 계약 및 checker 관찰 보완.
- `extensions/garmin/tests/test_report_input_pg.py` — 현재 fence·권한·합성자료 계약 및 checker 관찰 보완.
- `extensions/garmin/tests/test_report_store_pg.py` — 현재 fence·권한·합성자료 계약 및 checker 관찰 보완.
- `extensions/garmin/tests/test_store_contract_integration.py` — 현재 fence·권한·합성자료 계약 및 checker 관찰 보완.
- `packages/core/src/extensions/install.ts` — owned prepared stage SQL 멱등수정·중단복구.
- `packages/core/test/codes.test.ts` — 현재계약 fixture·실패경계·실행관찰 회귀 보완.
- `packages/core/test/extensions.test.ts` — 현재계약 fixture·실패경계·실행관찰 회귀 보완.
- `packages/core/test/supervisor-cancel.test.ts` — 현재계약 fixture·실패경계·실행관찰 회귀 보완.
- `packages/postgres/test/fixture.ts` — 현재 self user fixture 및 격리환경 연결.
- `packages/postgres/test/install-orbstack.test.ts` — 현재계약 fixture·실패경계·실행관찰 회귀 보완.
- `packages/postgres/test/schedule-occurrences.test.ts` — 현재계약 fixture·실패경계·실행관찰 회귀 보완.
- `packages/postgres/test/schema.test.ts` — 현재계약 fixture·실패경계·실행관찰 회귀 보완.
- `packages/postgres/test/unavailable.test.ts` — 현재계약 fixture·실패경계·실행관찰 회귀 보완.
- `packages/postgres/test/user-keys.test.ts` — 현재계약 fixture·실패경계·실행관찰 회귀 보완.
- `plugin/.claude-plugin/plugin.json` — app-ref release와 같은commit에서 pluginversion 증가.
- `plugin/app-ref` — 검토된 이전구현commit 참조.
- `plugins/garmin/.claude-plugin/plugin.json` — app-ref release와 같은commit에서 pluginversion 증가.
- `plugins/garmin/app-ref` — 검토된 이전구현commit 참조.
- `plugins/garmin/package/digest` — 배포manifest/version/digest 갱신.
- `plugins/garmin/package/manifest.json` — 배포manifest/version/digest 갱신.
- `plugins/garmin/package/src/batch_import.py` — 검토된 Garmin 제품 수정 배포사본.
- `plugins/garmin/package/src/role_probe.py` — 검토된 Garmin 제품 수정 배포사본.
- `tooling/bootstrap/test/hook.test.ts` — 현재계약 fixture·실패경계·실행관찰 회귀 보완.
- `tooling/bootstrap/test/npx.test.ts` — 현재계약 fixture·실패경계·실행관찰 회귀 보완.
- `tooling/bootstrap/test/plugin.test.ts` — 현재계약 fixture·실패경계·실행관찰 회귀 보완.
- `tooling/test-changed/rules.mjs` — 새 Python/자식전용 경로 시험선택 보완.
- `tooling/test-db/src/index.ts` — 고유PG컨테이너·TCP인증·실패정리 및 재시도.
- `tooling/test-db/test/test-changed.test.ts` — 현재계약 fixture·실패경계·실행관찰 회귀 보완.
- `_bmad-output/personal-brain/tickets/epic-garmin-extension/tickets/story-garmin-db-evidence.md` — 공개 검증·실패처분·리뷰·증거제한 요약.

## 로컬 최종 감사 산출물 해시

- `.brain-automation/coverage-final.json` — SHA256 `3c23d2913b1fd9e0dc0b134417d277c387156205445eb4f26197f8a1d6ae3dab`.
- `.brain-automation/failure-disposition-final.json` — SHA256 `3cb7219046b743bf62b54c199e11dfac686cd995863109670c5d0b4a38dab485`.
- `.brain-automation/final-execution-audit.json` — SHA256 `41e6cbbc1ba1273d00339ce593d7cc9d2cbc71ec16c85ec943ba997ab3320e5a`.
- `.brain-automation/final-regression2-report.md` — SHA256 `31a2468b551c0b562b38ea994a3ea3fa6ae77c6141e68c7cb87105e1898dd4d6`.
