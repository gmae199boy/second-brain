# 메신저·채널과 topic 발신 결정 — 2026-11-10

메신저는 종류와 자격 증명을 가진 계정/봇이고, 채널은 한 메신저 안의 목적지다. 기존 `brain.channels`를 메신저, `brain.channel_conversations`를 목적지 채널로 재사용한다. 토큰은 core 전용 `messenger_credentials`에 둔다. 같은 Telegram 종류의 봇 여러 개와 각 봇 안의 목적지 여러 개를 지원한다. 채널 별칭은 메신저 안에서만 유일하다.

경로는 topic에서 메신저와 채널의 쌍으로 간다. 저장 시 채널의 소속을 검증하고, 요청에는 목적지 채널의 UUID를 고정한다. 직접 발신도 소속 검증을 거친다. 공개 목록과 상태는 내부 메신저·채널 ID를 함께 보여 주고 토큰·외부 chat id·본문은 노출하지 않는다. 메신저 등록 결과는 토큰 설정 여부만 반환한다.

확장은 `brain.extension_channel_send(work,attempt,topic,key,purpose,revision,summary,document,albums,send_at)`만 호출한다. 실행 중인 확장 소유 attempt, 확장 이름 접두사 topic, 파일의 생산자·target·소유를 검증한다. `(topic,key)`는 한 번만 접수하고 기존 ID를 반환한다. 기존 `extension_channel_publish`는 호환을 유지한다. 확장 role은 새 테이블을 조회하거나 수정할 수 없다.

지금 발신은 접수 시 경로를 확정한다. 예약은 기존 daemon의 채널 인계 라운드에서 시각 도래를 판정한 뒤 그때 경로를 확정하고 기존 `channel_send` 작업으로 인계한다. 예약 요청을 위한 별도 프로세스나 확장 스케줄러는 두지 않는다. 데몬 중단 중 도래한 예약은 다음 실행에서 처리한다. 직접 예약은 지정한 메신저·채널을 사용한다.

경로가 없으면 정상적으로 `unrouted`에 보관한다. 경로 추가만으로 재발신하지 않는다. `channels send-pending --topic`이 명시적으로 미경로 요청을 다시 경로에 연결하거나 닫힌 실패를 재개한다. 동시 호출은 요청 잠금과 기존 일감 멱등 처리로 한 번만 인계한다. 날짜 선택은 UTC 접수 날짜다. 이미 발신했거나 진행 중인 요청과 아직 도래하지 않은 예약은 건드리지 않는다.

기존 전역 `telegram.bot_token`/`telegram.chat_id`와 `.env`의 `BRAIN_TELEGRAM_*`는 기본 단일 Telegram 메신저의 fallback으로 유지한다. 새 메신저는 DB 자격 증명을 직접 읽으며 전역 chat id 비교를 적용하지 않는다. 어댑터는 메신저 종류별로 선택하며 현재는 Telegram만 지원한다. 실제 네트워크 검증은 합성 토큰과 로컬 가짜 Telegram 서버로만 수행한다.
