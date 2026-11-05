# 적대적 리뷰 — Garmin 확장 재설계 (2026-11-05)

판정: **수정 필요** — critical 0, high 7, medium 5. 확장 중심 소유권은 명확해졌지만, 명령·예약·전환의 하위 계약은 서로 다른 구현을 허용한다.

범위: spine의 2026-11-05 변경과 `garmin-extension-redesign-disposition.md`. 근거는 같은 디렉터리 `.memlog.md`의 마지막 2026-11-05 결정, `../research-garmin-extension-redesign-2026-11-05/research-garmin-extension-redesign-2026-11-05.md`(이하 연구), 현재 소스의 관련 계약이다. 기존 미커밋 18.10 작업은 구현 완료나 채택 근거로 삼지 않았다. 각 발견은 AD를 따르는 생산자와 소비자를 별도로 구현할 때 가능한 충돌 쌍이며, 현재 발생한 운영 장애를 뜻하지 않는다. 소스·spine·티켓은 수정하지 않았고 실행 시험도 하지 않았다.

## 1. 확장 명령 메타와 SDK/MCP 호출 주소 사이 변환이 없다

- **심각도:** high
- **위치:** AD-37(559~560행), AD-5(114~116행), AD-28(454~456행)
- **충돌 쌍·근거:** manifest 작성자는 AD-37의 `name/run/input/output/risk/timeout`만 선언한다. SDK/MCP 작성자는 AD-5대로 모든 명령의 `used_for/required/examples/output/risk/hook/dryRun`과 `{ns, verb, args}`를 요구한다. CLI의 세 단계 주소 `ext garmin daily-values`를 MCP의 두 부분 이름 `<ns>_<verb>`로 바꾸는 규칙도 없다. 한쪽은 `ext_garmin_daily_values`, 다른 쪽은 `ext_run`과 인자 형태로 구현해도 각자 규칙을 따른다. 특히 manifest의 `write`에 MCP가 요구하는 `session`과 SDK의 `confirm`을 누가 추가하며, 엄격한 입력 schema에 어떻게 넣는지 불명확하다.
- **영향:** help·guide와 실제 MCP가 다른 입력을 요구하거나, MCP 쓰기가 세션 없이 실행되거나, 런타임이 추가한 인자가 확장의 `additionalProperties: false`에 거부된다.
- **제안 수정:** AD-37에 명령 등록 Rule을 추가한다. manifest→공통 명령 메타의 필드 대응·기본값, 충돌 없는 canonical 명령 주소와 MCP 이름 escaping, 런타임 전용 `session/confirm/user_id/settings`와 확장 payload의 별도 봉투를 고정한다. 쓰기·파괴적 동작의 확인 정책과 동일 fixture를 CLI/SDK/MCP에 적용한다.

## 2. 동기 쓰기 명령은 감독자 attempt를 받을 수 없다

- **심각도:** high
- **위치:** AD-37(559~562행), AD-30(482행), AD-33(510~517행)
- **충돌 쌍·근거:** 명령 실행기는 `risk: write`를 큐 없이 직접 실행한다. 저장기는 AD-30·33대로 확장 schema 쓰기와 core 요청 INSERT에 현재 감독자 attempt를 요구한다. AD-37 입력에는 사용자·설정은 있지만 work/attempt 발급자는 없다. 그룹 정리·reap의 재사용만으로 DB fence가 생기지 않는다.
- **영향:** 정상 쓰기 명령이 모두 거부되거나, 구현자가 명령 전용 우회를 만들어 timeout·disable 뒤 살아 있는 프로세스가 평가·요청을 확정한다.
- **제안 수정:** 새 Rule로 동기 명령의 쓰기 권한 수명을 정한다. 이번 범위를 읽기 전용으로 제한하거나, 큐를 만들지 않더라도 실행 ID·token의 발급/취소/DB 검증을 공통 장치로 제공한다. timeout·disable·호출자 종료 뒤 늦은 INSERT 거부까지 계약에 포함한다. 단순 `risk: write`는 attempt 예외가 아님을 명시한다.

## 3. 검증을 통과한 출력이 가리기 뒤에는 schema를 위반할 수 있다

- **심각도:** medium
- **위치:** AD-37(561행), AD-11(224행)
- **충돌 쌍·근거:** 확장은 output schema의 `const/enum/pattern/format`을 만족하는 문자열을 반환한다. 런타임은 AD-37대로 먼저 검증하고 AD-11대로 모든 문자열의 비밀 패턴을 치환한다. 예를 들어 `password=...` 형태를 허용하는 문자열 enum은 검증 후 `[REDACTED:…]`로 변한다. 소비자는 공개된 output schema를 신뢰하지만 실제 응답은 그 schema 밖이다.
- **영향:** schema 기반 에이전트·MCP 소비자가 성공 응답을 파싱하지 못한다. 재검증을 임의로 붙인 구현과 그대로 반환하는 구현도 갈린다.
- **제안 수정:** AD-37에 프로세스 원출력 schema와 공개 `data` schema의 관계를 고정한다. 가리기에 닫힌 문자열 계약을 요구하거나, 가림 표식을 허용하는 공개 schema를 생성한다. 검증·가리기·최종 검증의 순서와 실패 코드를 한 Rule로 정한다.

## 4. 예약 회차는 여럿인데 합쳐진 work에는 예약 하나만 남는다

- **심각도:** high
- **위치:** AD-39(583~585행), AD-21(362·373행), Table Contract `work_items`·`schedules`
- **충돌 쌍·근거:** 예약기는 서로 다른 `schedule_key`의 두 예약을 같은 kind/target에 허용하고 `(schedule_id, occurrence_at)`별로 발화한다. 큐는 AD-21대로 같은 미완료 target을 수동 실행까지 합친다. 현재 `packages/postgres/src/work.ts:117~140`은 `schedule_id = coalesce(schedule_id, 새 값)`과 날짜 최소/최대만 보관하고, `:879~885`는 그 예약 하나의 날짜 범위를 `schedule_successes`에 쓴다. 연구 Q1도 `(schedule_id, local_date)` PK와 이 합치기를 확인했다. AD-39에는 이 완료 회계의 대체 계약이 없다.
- **영향:** 두 번째 예약의 회차는 발화됐으나 성공 귀속이 사라진다. 같은 날 두 cron 회차도 날짜 PK 하나로 압축되며, 실패·retry·수동 실행 합치기 뒤 어느 회차가 끝났는지 복원할 수 없다.
- **제안 수정:** 새 예약 회계 Rule로 occurrence→work/attempt의 다대일 연결을 명시한다. claimed occurrence 집합과 실행 중 새로 붙은 집합을 구분하고, 완료 시 실제 처리 집합만 원자 확정한다. `schedule_successes`를 instant 키로 이전하며 기존 날짜 성공의 이전 정책도 정한다. AD-21 합치기는 유지하되 회차 메타를 버리지 않게 한다.

## 5. coalesce·skip의 의미가 선언 이름뿐이다

- **심각도:** medium
- **위치:** AD-39(583~585행), 동반 문서 B·G
- **충돌 쌍·근거:** tick 작성자는 놓친 월·수·금 세 회차를 `coalesce` 한 작업으로 합치고 가장 최근 instant만 전달한다. 확장 작성자는 `coalesce`를 모든 놓친 회차의 입력 범위 처리로 해석한다. 둘 다 latest만 정의된 현재 문구를 어기지 않는다. `skip`도 tick 시각과 몇 초 차이 나는 정상 due를 놓친 것으로 볼지, 중단 기간만 버릴지 미정이다. 기존 tick은 날짜 범위를 전달한다(`packages/core/src/queue/schedule-tick.ts:48~61`).
- **영향:** 같은 manifest가 adapter마다 다른 데이터를 처리하거나 정상 예약까지 계속 건너뛴다. 최신 한 번 실행과 전체 범위 처리의 성공 회계도 섞인다.
- **제안 수정:** AD-39에 missed 판단 경계, 세 정책의 선택 회차·전달 payload·성공/건너뜀 기록·next 계산을 표로 고정한다. `once`가 지연됐을 때 정책 적용 여부와 trigger/timezone 수정 시 기존 회차의 귀속도 함께 정한다.

## 6. user_id를 운반하라는 규칙과 사용자 문맥 유예 사이에 기본 해석자가 없다

- **심각도:** high
- **위치:** AD-40(592~594행), AD-12(247행), AD-19 setup 순서(333행)
- **충돌 쌍·근거:** CLI·tick 작성자는 사용자 문맥 전달을 Deferred로 보고 입력에 사용자를 요구하지 않는다. 명령·일감 작성자는 AD-37·40대로 반드시 `user_id`를 받으며 계정 연결을 찾는다. 기존 `is_self`가 단일 사용자라는 사실은 있지만 이 경로들에서 누가 조회해 주입하는지는 없다. 새 DB에서는 migration 직후에야 setup이 self를 만든다(AD-12·19). 따라서 migration에서 FK/NOT NULL 기본행을 만드는 구현과 setup에서 나중에 채우는 구현도 갈린다.
- **영향:** 단일 사용자 설치에서도 확장 기본 예약·설정 생성이나 명령 실행이 막힌다. NULL·임의 UUID·외부 계정 문자열을 임시 기본값으로 쓰는 별도 관례가 생긴다.
- **제안 수정:** AD-40에 이번 단계의 단일 사용자 해석 Rule을 둔다. 런타임이 유일한 `is_self`를 읽어 모든 실행 입력·기본행에 주입하고 없으면 `USER_MISSING`으로 중단하며, 사용자 인자 변경을 다중 사용자 기능으로 열지 않는다. schema 변경→self 보장→기존 행 backfill→기본값·예약 생성→제약 확정의 순서를 신규/업그레이드에 각각 고정한다.

## 7. NULL 사용자 설정은 유일성과 값 선택 계약이 없다

- **심각도:** medium
- **위치:** AD-18(323행), AD-40, Table Contract `settings`(631행), 동반 문서 core 설정 행
- **충돌 쌍·근거:** DB 작성자는 `(user_id,key)`를 일반 UNIQUE로 만들고 공통 값은 NULL로 둔다. 설정 코덱 작성자는 이를 하나의 키로 생각해 upsert한다. 일반 UNIQUE에서는 NULL 사용자 행 중복이 허용되며, 복합 PK로 구현하면 NULL 자체가 거부된다. self 행과 NULL 행이 함께 있을 때의 우선순위, manifest 기본값 재설치가 사용자 설정을 덮는지도 없다. 기존 reader는 key만 읽는다(`packages/postgres/src/analysis-inputs.ts:45`).
- **영향:** 같은 설정을 읽는 두 실행이 다른 값을 고르거나 플러그인 재진입 때 기본값이 누적/덮어쓰기된다.
- **제안 수정:** AD-18 또는 Table Contract에 `UNIQUE NULLS NOT DISTINCT` 등 NULL까지 포함한 유일성, 키별 scope 선언, 사용자/공통 lookup 우선순위와 공통값을 허용하지 않는 키의 거부를 적는다. 기본값은 부재 시에만 삽입하고 업그레이드가 명시적 사용자 값을 보존하도록 정한다.

## 8. 동결은 기존 소비자의 실행 중단을 보장하지 않는다

- **심각도:** high
- **위치:** AD-30(478행), AD-32(501행), AD-35(541행), 동반 문서 I→J
- **충돌 쌍·근거:** Garmin 이식자는 새 데이터를 native 표에만 쓰며 core 건강·analyses 쓰기를 멈춘다. core 작성자는 허용된 기존 18.1·18.2 소비자와 읽기 view를 유지한다. 현재 `packages/core/src/analysis/day.ts:8~10,29~33`에는 snapshot을 새로 만들고 `health_analysis`를 enqueue/commit하는 경로가 있고, `packages/postgres/src/analysis-inputs.ts:48~53`은 옛 건강·analyses를 읽는다. 동반 문서는 실제 전환 I 뒤에야 J의 소비 경로 정리를 둔다. '새로 키우지 않는다'와 '기존 소비자만 쓴다'는 기존 등록·예약·pending work를 끄라는 규칙이 아니다.
- **영향:** 새 수집은 native로 갔는데 기존 분석은 빈/과거 snapshot으로 실행되거나, 동결한 `analyses`에 새 INSERT를 시도한다. 신규 확장 분석과 기존 core 분석의 이중 실행도 가능하다.
- **제안 수정:** 이행 Rule에 활성화 장벽을 추가한다. 새 수집·분석 가동 전에 18.1의 생성/claim 등록·예약을 차단하고 pending/running work의 취소·배수·보존 상태를 확정한다. J는 물리 제거만 늦추고, I 이전에 소비 중단 검증을 완료하도록 순서를 바꾼다. 읽기 view의 동결이 실행 허가를 의미하지 않게 적는다.

## 9. 확장 플러그인의 ref는 패키지 바이트를 가져오는 주체를 정하지 않는다

- **심각도:** medium
- **위치:** AD-38(571~574행), AD-19(332·338행)
- **충돌 쌍·근거:** 얇은 플러그인 작성자는 자기 cache의 경로를 installer에 넘긴다. installer 작성자는 경로의 digest를 검사하고 복사할 뿐 ref를 checkout하지 않는다. AD-38은 `app-ref 또는 패키지 ref`를 허용하지만, 그 ref로부터 실제 패키지 디렉터리를 만드는 단계는 없다. 현재 marketplace source는 `./plugin`이며 core bootstrap만 별도 앱 clone을 한다는 점이 연구 Q2에 확인되어 있다. core app-ref를 따라 동봉 `extensions/garmin`을 쓰면 독립 확장 ref와 달라진다.
- **영향:** 설치 경로에 manifest가 없거나, 확장 플러그인 version이 가리키는 ref와 다른 core 동봉 버전이 설치된다. digest만 맞아도 의도한 ref에서 얻은 바이트라는 보장은 생기지 않는다.
- **제안 수정:** AD-38에 패키지 공급 Rule을 추가한다. 캐시에 실제 동봉할 artifact 범위 또는 고정 ref의 fetch/검증 주체·위치, digest 대상 파일 집합, ref→digest 증거, 설치 registry의 패키지 신원을 고정한다. core 앱 clone의 확장을 암묵적 fallback으로 고르지 않게 한다.

## 10. 두 플러그인의 갱신은 호환성 확인 뒤에도 경합할 수 있다

- **심각도:** medium
- **위치:** AD-38(572~574행), AD-19 bootstrap(335행), AD-31(491행)
- **충돌 쌍·근거:** 확장 installer는 현재 core 버전이 호환됨을 확인한 뒤 자기 설치 잠금을 잡고 복사·migration한다. 동시에 core bootstrap은 별도 app-ref로 fast-forward·제자리 dist build와 설치된 확장 migration을 한다. 두 경로 모두 각자의 '설치 잠금'과 migration advisory lock을 지킬 수 있지만 같은 잠금인지, 호환성 검사부터 활성화까지 직렬화하는지는 없다. DB migration lock만으로 앱 바이트·registry·프로세스 ABI는 보호되지 않는다.
- **영향:** 검사한 core와 활성화 시 core가 달라지거나 실행 중 패키지/명령 registry가 교체된다. 같은 확장 migration 파일 집합을 서로 다른 버전으로 검사할 수도 있다.
- **제안 수정:** AD-38에 core/확장 설치·업그레이드의 공통 수명 잠금과 lock 순서를 명시한다. 잠금 안에서 core 신원·호환성 재확인, 작업/직접 명령 quiesce, migration, 패키지·registry 활성 전환을 순서화한다. 자기 ref보다 설치본이 앞선 플러그인은 downgrade하지 않는 비교 규칙도 둔다.

## 11. 같은 모양의 native 표와 모든 데이터의 불변 revision은 다르다

- **심각도:** high
- **위치:** AD-29(469행), AD-32(502행), AD-35(538행), AD-36(548~551행), 동반 문서 E·F
- **충돌 쌍·근거:** 이식자는 옛 자연키와 조회 SQL을 유지하고 평가만 history로 바꾼다(AD-29). 저장기 작성자는 AD-32의 '불변 행·수정은 새 행'을 모든 확장 데이터에 적용해 day_summary/workout에도 revision을 추가한다. 연구의 옛 report_input 설명은 단일 행 전제의 조회와 evaluation `(report_date,scope)` UPSERT를 확인하고, 별도로 최신 view/adapter를 제안한다. spine에는 평가 외 표의 수정·최신 선택·키에 대한 우선 규칙이 없다. 여러 dataset의 겹친 자연키를 선택·보존하는 반입도 어느 키 공간에 쓰는지 정해지지 않았다.
- **영향:** 자연키 충돌로 반입이 멈추거나, 과거/최신 revision을 모두 집계해 옛 계산 의미를 바꾼다. 반대로 옛 upsert를 그대로 살리면 불변 규칙을 위반한다.
- **제안 수정:** Garmin 내부 저장 Rule로 표별 계약을 고정한다. 원본 보존·가변 파생 투영·불변 평가 이력의 범위, `(user, account/dataset, native key, revision)` 중 실제 키, 옛 SQL이 읽는 한 행의 current view/adapter와 결정적 revision 선택을 정한다. '같은 모양'의 예외를 `user_id/계정 연결/평가 이력`과 함께 명시하고 재반입 충돌도 같은 규칙으로 처리한다.

## 12. writer가 계속 쓰는 capture와 Mac 전환 사이 마지막 증분이 빠진다

- **심각도:** high
- **위치:** AD-36(549행), 동반 문서 F→I 및 I 행
- **충돌 쌍·근거:** 반입자는 옛 writer를 멈추지 않고 만든 capture T0를 전수 비교해 완료한다. 전환자는 그 완료 뒤 I에서 옛 LaunchAgent를 내리고 새 확장을 가동한다. 두 동작 모두 명세대로지만 T0~중단 T1 사이 옛 프로그램이 추가한 raw·평가·파일은 최초 capture에 없다. '한 번 복사'와 checkpoint 재개는 동일 capture의 재개만 보장하며 이 창의 최종 capture/delta 반영을 요구하지 않는다. 실수집 한 번은 다시 생성할 수 없는 옛 평가를 회수하지 못한다.
- **영향:** 보고서는 전수 일치인데 전환 후 마지막 옛 평가·파일이 빠진다. R5~7의 손실 방지와 과거 평가 보존을 충족하지 못한다.
- **제안 수정:** AD-36에 최종 handoff Rule을 추가한다. 초기 online capture는 허용하되, 전환 시 옛 writer 정지 확인→최종 일관 capture 또는 watermark 이후 delta 반입→전수 비교/파일 관계 확인→새 writer 활성화를 하나의 절차로 둔다. 운영 반입은 한 번이라는 의미를 최종 확정 단위로 정의하고 원본과 중단/확정 증거를 보존한다.

## 검토 결론

위 보강은 core가 Garmin 지표·계산을 소유하게 만들 필요가 없다. 1~10은 범용 실행·명령·설치 계약과 전환 장벽, 11~12는 Garmin 내부 저장·반입 계약으로 닫을 수 있다. 사용자 문맥·인증·다중 사용자 RLS의 본 구현은 Deferred로 유지하면서도 이번 단일 사용자 기본값과 키·회계 규칙은 확정해야 한다.
