# 2026-11-05 재설계 rubric walker 리뷰

판정: **수정 필요** — 확장 소유권과 동결 방향은 명확하지만, 예약 완료 회계·동기 쓰기·실제 전환의 경계가 후속 티켓마다 달라질 수 있다. critical 0건, high 3건, medium 4건, low 0건.

대상은 `architecture-brain-v1-slice-1.md`의 2026-11-05 변경과 `garmin-extension-redesign-disposition.md`다. `git diff -- _bmad-output/personal-brain/architecture-brain-v1-slice-1/`, 연구 문서의 Q1~Q5, `.memlog.md` 마지막 2026-11-05 기록, 관련 core·postgres·CLI·확장 코드를 대조했다. 기존 미커밋 18.10 구현은 작업자 소유 변경으로 취급했고 수정하지 않았다. 실행 검증이나 운영 DB 조회 없이 문서 계약과 정적 코드만 검토했다.

| 체크리스트 | 판정 |
| --- | --- |
| 티켓 사이의 소유권 | 확장 데이터·분석 소유와 core 파일·채널 소유는 고정됨 |
| AD Rule의 강제 가능성 | 예약 완료 회계와 동기 쓰기에서 미충족(F1·F2) |
| Deferred의 적절성 | 다중 사용자 격리 연기는 사용자 결정과 일치하나, 이번 단일 사용자 입력의 출처까지 미뤄짐(F5) |
| 기존 코드와의 이행 호환 | 날짜 회계·설정 저장기·migration ledger와의 연결 보강 필요(F1·F4·F7) |
| AD 사이 일관성 | AD-37 대 AD-30·33, AD-40 내부, AD-31 내부에 충돌 존재 |
| 운영·배포·환경 | 설치 경로·격리 환경·ref 검증은 명시됨. 최종 capture와 구 writer 종료 사이 인계가 미정(F3) |

## F1 — 발화 회차를 정했지만 성공 회계와 일감 병합의 단위는 정하지 않았다

- **심각도:** high
- **위치:** AD-39, spine 579~585행; Table Contract `work_items`·`schedules`; Deferred의 「임대 갱신 세부, 정체 판정, 놓친 예약 처리」 행.
- **근거:** AD-39는 `(schedule_id, occurrence_at)`와 발화 CAS만 고정한다. `coalesce`와 `skip`의 정확한 의미, 실행 중 새 회차가 생기면 어느 일감에 연결하는지, 성공한 회차만 어떻게 확정하는지는 없다. 기존 `packages/postgres/src/schedules.ts:136~145`는 미성공 날짜의 처음/끝을 하나의 work에 합치며, `packages/postgres/src/work.ts:880~890`은 그 연속 구간의 **매일**을 성공으로 기록한다. `packages/core/src/queue/schedules.ts:21~35`의 수동 실행도 오늘 날짜를 성공 회계에 연결한다. 따라서 새 trigger/CAS만 구현하고 이 완료 경로를 유지하면, 주간 예약이 비예약일을 성공 처리하거나 같은 날 여러 회차를 하나로 처리한다. 연구 Q1의 63행도 이 분기를 명시적으로 경고한다.
- **제안 수정:** 회차→work 연결과 성공 기록의 유일 키를 발화부터 완료까지 동일하게 유지하고, 병합하더라도 실제 회차 집합만 운반·확정한다고 Rule에 적는다. `coalesce`·`latest`·`skip` 각각의 선택 회차, 실행 중 추가 회차의 소속, 수동 실행의 예약 성공 처리 여부를 정한다. 기존 날짜 성공 기록의 이전/종료 방침도 명시하고 Deferred는 이 불변식 아래 구현 세부만 남긴다.

## F2 — 동기 write 명령은 기존 attempt 강제 규칙을 만족할 수 없다

- **심각도:** high
- **위치:** AD-37, spine 559~562행 ↔ AD-30 마지막 Rule·AD-33 attempt Rule; AD-5·28.
- **근거:** AD-37은 `risk(write)`를 허용하면서 모든 명령을 큐 없이 직접 실행한다. 반면 AD-30은 확장 schema 쓰기도 감독자 attempt를 운반하고 평가 저장·요청 INSERT에서 오래된 attempt를 거부하도록 한다. AD-33에서 그 token은 감독자의 일감 청구 때 발급된다. 실제 `packages/postgres/migrations/0022_import_contracts.sql:16~20,45~55`의 파일 요청은 work ID/token이 필수이며 DB trigger가 현재 attempt와 출처 일감을 확인한다. 직접 명령에는 이 청구/attempt 발급 경로가 없다. 쓰기 명령 구현자가 fence를 우회하거나 금지하지 않으면 계약을 동시에 만족할 수 없다. `risk`만으로 AD-5의 확인 게이트 및 AD-28의 쓰기 session 처리 여부도 결정되지 않는다.
- **제안 수정:** 이번 동기 명령을 조회 전용으로 한정하거나, 동기 쓰기에 허용할 범위를 열거하고 별도의 실행 신원·fence·취소/disable 경합 규약을 정의한다. 파일·채널 요청 및 모델 실행은 감독 일감으로 보내는지 명시한다. 선택한 경로에 AD-5·28의 confirm/session 규칙을 어떻게 적용할지도 함께 고정한다.

## F3 — 최종 capture 이후 구 프로그램이 쓴 데이터의 인계가 빠졌다

- **심각도:** high
- **위치:** AD-36, spine 548~551행; companion 「새로 만드는 것」 F·I 및 「이행 순서」 69~78행.
- **근거:** AD-36은 옛 writer를 멈추지 않은 capture를 한 번 복사하고 그 capture와 전수 비교하면 완료한다. companion은 F 반입 완료 후 I에서 옛 LaunchAgent를 내린다. F의 capture 이후 I의 종료 사이에 생긴 raw·평가·파일은 검증 보고서의 모수 밖이며, 마지막 capture/delta 또는 재검증 단계가 없다. I의 「설치본 반입」이 최종 재반입이라는 뜻인지도 정하지 않아 F 구현자와 전환 구현자가 서로 맡았다고 판단할 수 있다. 새 실수집 한 번으로 구 평가 본문·파일 이력까지 복구할 수는 없다.
- **제안 수정:** F를 예비 반입으로 명명하고, I에서 구 예약 중지→진행 writer 종료 확인→최종 일관 capture→차분/새 batch 반입→그 최종 capture 전수 검증→새 예약 활성화의 인계 경계를 고정한다. 대안으로 capture 이후 구 writer의 추가 쓰기가 없음을 증명하는 gate를 둔다. 실패 시 구/신 예약 중 어느 것을 유지하는지도 명시한다.

## F4 — NULL 설정 scope의 멱등 키가 선언만으로 유일하지 않다

- **심각도:** medium
- **위치:** AD-18, spine 323행; Table Contract `settings` 행.
- **근거:** 기계 공통 값에 `user_id NULL`을 허용하면서 멱등 키를 `(user_id,key)`로만 썼다. nullable 복합 UNIQUE는 NULL scope의 같은 key 중복을 막지 못하고, 복합 PK로 구현하면 NULL을 저장할 수 없다. 현재 `packages/postgres/src/settings.ts:17~36`은 key 단독 조회와 `ON CONFLICT(key)`를 쓰므로 scope migration과 조회·upsert를 함께 바꿔야 한다. 해당 저장기가 여러 global 행 중 첫 행을 선택하도록 남으면 설치·config·실행 snapshot이 다른 값을 읽을 수 있다.
- **제안 수정:** global/user scope의 유일성을 `UNIQUE NULLS NOT DISTINCT(user_id,key)` 또는 동등한 제약으로 강제한다고 적는다. global과 user 값이 모두 있을 때의 조회 우선순위, 각 키의 허용 scope, upsert conflict 대상을 설정 코덱 계약으로 고정한다.

## F5 — 이번 실행에 필요한 self 문맥까지 Deferred 문구에 포함돼 있다

- **심각도:** medium
- **위치:** AD-40, spine 592~594행; AD-37 562행; companion B·E·G.
- **근거:** AD-40은 이번 일감·명령 입력에 `user_id`를 운반하고 계정 연결로 범위를 정하라면서 바로 다음 Rule에서 「사용자 문맥 전달(누가 호출했는가)」을 이번에 하지 않는다고 한다. 기존 `packages/core/src/extensions/snapshot.ts`의 설정 snapshot과 `packages/core/src/queue/schedule-tick.ts`의 생성 work에는 사용자 입력이 없다. 과거 행의 self backfill만 정했을 뿐 새 예약·수동 실행·config 조회·자식 입력에 self를 누가 주입할지는 고정하지 않았다. 이는 다중 사용자 인증의 구현 요구가 아니라, 이번 단일 사용자 실행이 새 키를 채울 최소 규칙의 누락이다.
- **제안 수정:** 이번에는 Runtime이 `is_self` 사용자를 명시적으로 해석해 설정·예약·일감·명령·확장 계정 연결까지 전달한다고 정하고, 누락/여러 self/연결 불일치는 오류로 처리한다. Deferred는 외부 principal 인증과 여러 호출 사용자 선택·RLS로 좁힌다.

## F6 — manifest 기본값 재설치가 사용자 변경을 보존하는지 미정이다

- **심각도:** medium
- **위치:** AD-18 323행, AD-39 585행, Table Contract `settings`·`schedules`; AD-38 설치·갱신 경로.
- **근거:** 설치자가 기본 설정·예약을 작성하고 사용자가 값·trigger·활성을 바꿀 수 있도록 했지만, 같은 `schedule_key` 또는 설정 key가 재설치/새 manifest에서 다시 나타날 때 작성 우선순위가 없다. 기존 `packages/core/src/queue/schedules.ts:58~70`의 `ensureDaily`는 기존 시각이 다르면 충돌하며, 설치기는 `packages/core/src/extensions/install.ts:280~292`에서 이를 그대로 실패 처리한다. 새로운 stable key만 도입해도 사용자 변경을 덮을지 보존할지, 업그레이드가 실패할지 갈린다. 설정 기본값의 DB 물질화도 현재 fallback 방식과 달라 같은 문제가 생긴다.
- **제안 수정:** 기본값은 누락 행에만 삽입하고 사용자 값·비활성을 보존하는지 명시한다. manifest에서 삭제/변경된 예약의 처분과 사용자가 삭제한 기본 예약의 재생성 여부도 정한다. 자동 기본값 갱신을 원하면 사용자 override와 기본값 revision을 구별하는 규칙을 둔다.

## F7 — forward-only Rule 아래에 baseline 대체 지시가 남았다

- **심각도:** medium
- **위치:** 수정 AD-31, spine 493~494행.
- **근거:** 새 Rule은 적용 파일을 보존하고 forward migration만 허용한다. 바로 다음 기존 문장은 현재 `0001_initial.sql`을 「초기 설계라 대체한다(운영 PG 데이터 없음)」고 여전히 명령한다. `packages/postgres/src/migrate.ts:17~18,48~55`는 적용 baseline 변경을 금지하고 checksum을 확인한다. 연구 Q2의 106행도 old baseline을 현재 전환 근거로 삼지 말라고 한다. 메모로그의 「운영 Garmin 반입 0건」은 전체 PG ledger가 비었다는 근거가 아니다. 이미 완료한 과거 전환을 설명한 문장이라면 현재형 지시에서 제외해야 한다.
- **제안 수정:** baseline 대체는 과거 완료 결정으로 표시하거나 제거하고, 이번 변경은 기존 core/Garmin owner ledger 위의 새 번호만 사용한다고 명확히 한다. 신규 설치에서 옛 건강 DDL 생성을 없애는 baseline 재편은 별도 호환 정책 없이는 하지 않는다고 덧붙인다.

## 범위와 잔여 사항

확장 소유권 전환·core 건강 계약 동결·원본 SQLite 보존·별도 플러그인·Runtime cron adapter 자체에는 반대 발견이 없다. 다중 사용자 보안 전체를 이번에 구현하라는 제안도 하지 않는다. 위 발견은 선언된 방향을 후속 티켓에서 동일하게 구현하기 위한 경계 수정이며, 소스·spine·티켓 수정은 수행하지 않았다.
