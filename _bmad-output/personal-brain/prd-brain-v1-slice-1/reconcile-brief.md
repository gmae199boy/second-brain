# 입력 정산 — brief ↔ PRD (brain v1 slice 1)

목적: PRD finalize 전에 brief/addendum이 가진 것 중 PRD 쌍이 **조용히 떨어뜨린 것**을 찾는다. PRD·addendum은 고치지 않는다.

- source: `../brief-personal-brain/brief-personal-brain.md` (이하 **brief**), `../brief-personal-brain/addendum.md` (**brief-add**), `../brief-personal-brain/.memlog.md` (**brief-log**)
- target: `prd-brain-v1-slice-1.md` (**PRD**), `addendum.md` (**prd-add**), `.memlog.md` (**prd-log**)
- 의도된 변경(기록된 override)으로 생기는 차이는 §1이 아니라 §2로 보낸다. 근거: prd-log L13(요약→작업 로그), L14·L19(범위 모델), L7(시작 주입만)

---

## 1. 실제 gap — PRD/addendum이 근거 없이 떨어뜨리거나 어긋난 것

### G1. 영속성(백업·복구·내보내기) 요구가 없다 — 심각도 **높음**
- source: brief L24 "**영속되지 않는다.** Orca 세션 검색은 workspace 삭제와 함께 사라진다", brief L33 "① 원본 … **절대 안 잃는다**", brief L49 "솔직한 차별점은 … **소유권과 영속성**이다"
- what: brief에서 Brain의 존재 이유 절반이 "영속성"인데, PRD §5 NFR-1~8과 §9 Constraints 어디에도 백업·복구·이식(export)·DB 손실 대비 요구가 없다. NFR-1은 "수정하지 않는다"(불변)만 말하고, 기계 한 대·Postgres 하나(§9)라는 단일 장애점만 있다. 2주 실사용 지표(SM-1~8)에도 데이터 보존 항목이 없다.
- suggested: §5에 `NFR-9 영속성`을 추가 — "원문·작업 로그는 백업과 복구 경로가 있고, Brain 밖으로 읽을 수 있는 형태(덤프/내보내기)로 꺼낼 수 있다. 저장소를 잃으면 색인은 다시 만들 수 있지만 원문은 복구 경로가 있어야 한다." §7에 `SM-9 복구 리허설`(1회 복구 성공) 수준의 확인 1줄.
- severity: 높음 (제품의 핵심 주장이 요구사항으로 내려오지 않았다)

### G2. 에이전트가 적은 **규칙**이 검증 없이 매 세션 주입된다 — 심각도 **높음**
- source: brief L88 Key Decisions "결정·규칙 | 세션 요약 때 후보로 뽑고 **내가 확인해 확정**. 근거는 조각에서"
- what: override로 "요약이 후보를 뽑는" 수단은 사라졌지만, **사람이 확정한다는 통제 자체**가 함께 사라졌다. PRD FR-7은 에이전트가 시키지 않아도 적게 하고, FR-19는 적힌 규칙이 다음 세션부터 자동 주입된다고 한다. FR-21은 사후 수정·끄기만 준다. 즉 에이전트가 잘못 이해한 규칙이 아무 확인 없이 모든 세션에 들어간다. prd-log L11은 "자동 후보 추출 제외, 명시 저장(remember)만"이라고 적었지만 PRD는 반대로 에이전트 자동 기록을 기본으로 삼았고, 그 과정에서 확인 단계가 어디로 갔는지 기록이 없다. PRD §8에도 이 질문이 없다.
- suggested: FR-19 또는 FR-21에 consequence 추가 — "새로 적힌 규칙은 처음 주입될 때 '새 규칙'으로 표시되거나, 점검 명령으로 최근 추가된 규칙 목록을 보여 준다(사후 승인). 규칙은 내가 끌 때까지 유효하다." §8에 "에이전트가 적은 규칙의 정확도를 어떻게 확인하는가"를 Open Question으로.
- severity: 높음 (FR-19 + FR-7의 조합이 만드는 실사용 위험이 어디에도 안 적혀 있음)

### G3. brief가 **명시적으로 제외**한 MCP adapter가 PRD에서 slice 1 후보로 돌아왔다 — 심각도 **중간**
- source: brief L78 "**명시적 제외(V1 slice 1 밖)**: … **MCP adapter**, 다중 사용자·인증, 동적 provider plugin", brief-add L24 "MCP-only | 에이전트가 매번 조회 여부를 판단해야 함(초안 28장)"
- what: PRD §8-4 "CLI와 MCP 중 무엇을 먼저, 또는 둘 다 낼지 … architecture에서 정한다"와 prd-add §4(도구의 형태 둘)는 MCP를 slice 1 선택지로 되살렸다. brief의 제외를 뒤집는 결정이 prd-log에 없다.
- suggested: §8-4에 한 줄 — "brief L78은 MCP adapter를 slice 1 밖으로 두었다. 되살리려면 여기서 그 결정을 뒤집는다고 적고, 아니면 §6.2 Out of Scope에 MCP를 넣고 CLI만 남긴다."
- severity: 중간

### G4. harness 원본의 **보존 기한**이 재수집 가능 창을 끊는다는 사실이 없다 — 심각도 **중간**
- source: brief-log L30 "감수: 도구 출력 내용은 **harness가 지우면(Claude Code 기본 30일) 복구 불가**", brief L89 "harness 원본 파일은 보관 안 함"
- what: PRD FR-5는 "수집이 실패한 세션은 목록으로 확인할 수 있고 **다시 수집할 수 있다**"고 단언하는데, 원천(jsonl)이 30일 뒤 사라지면 다시 수집할 수 없다. 즉 FR-5는 무기한 보장처럼 읽히고, NFR-2(조용한 실패 금지)에는 "언제까지 드러나야 하는가"가 없다. prd-add §5는 수집 원천이 transcript jsonl임을 적었지만 기한은 언급하지 않는다.
- suggested: FR-5에 consequence 추가 — "수집 실패는 harness의 원본 보존 기간(Claude Code 기본 30일) 안에 드러나고 재수집되어야 한다. 그 기간을 넘기면 복구 불가임을 감수한다." §9 Constraints에도 같은 한 줄.
- severity: 중간

### G5. 성공 기준 "Claude → Codex 인계" 가 사라졌다 — 심각도 **중간**
- source: brief L61 Success Criteria "**Claude에서 Codex로 작업을 넘길 때 다시 설명하지 않는다**", brief L23 "Claude로 조사하고 Codex로 리뷰시키려면 처음부터 다시 설명한다"
- what: brief의 4대 성공 기준 중 하나가 PRD §7 SM-1~8에 없다. §6.2는 "Codex, OpenCode 수집 | 다음 조각"으로 수집만 연기했고, FR-23은 harness 비종속을 요구하지만, **인계가 되는가**를 언제 어떻게 판정하는지가 사라져 다음 조각에서도 근거가 남지 않는다.
- suggested: §7 끝에 "다음 조각의 성공 기준(여기서는 재지 않음)" 한 줄로 brief L61을 보존하거나, §6.2 Codex 행 메모에 "성공 기준은 brief L61 — 그 조각에서 SM으로 승격"을 적는다.
- severity: 중간

### G6. "BMad 문서를 Brain의 가장 믿을 만한 자료로 색인한다"가 사라졌다 — 심각도 **중간**
- source: brief L48 "BMad 문서는 Brain의 **가장 믿을 만한 자료로 색인한다**"
- what: PRD는 문서 색인을 전혀 다루지 않는다. §8-2는 **memlog 연계**(쓰기 방향)만 묻고, §6.2 Out of Scope에도 "문서 색인"이 없다. 대화만 색인하고 brief/PRD/architecture 산출물은 Brain이 모르는 상태가 되는데, 그게 의도인지 누락인지 PRD로는 알 수 없다.
- suggested: §6.2에 "프로젝트 문서(BMad 산출물) 색인 | 이후 조각" 행을 추가하거나, §8-2를 "memlog + BMad 문서 색인"으로 넓힌다.
- severity: 중간

### G7. 아키텍처 초안(49절)이 기반 문서에서 빠졌다 — 심각도 **중간**
- source: brief L10 "전체 아키텍처 초안은 `../inputs/personal-brain-final-architecture.md`", brief-add L7 "(Codex와 작성한 49개 섹션). brief와 충돌하는 부분은 없고, brief가 더 좁힌 것은 다음이다" (L9~L12)
- what: PRD §0은 기반 문서를 "brief + brief-add §9"로만 적는다. architecture 단계의 직접 입력인 초안 문서와, brief-add §1이 정리한 "초안 대비 좁힌 4가지"가 PRD 쌍 어디에도 인용되지 않아 architecture 스킬이 초안을 못 집는다.
- suggested: PRD §0 기반 문서에 `../inputs/personal-brain-final-architecture.md`와 brief-add §1을 추가(한 줄), prd-add §2/§3 머리에 "초안 12·26·28·42·45·46장 대비 좁힌 점은 brief-add §1" 참조.
- severity: 중간

### G8. 노출된 Model Studio API 키 재발급이 선행 작업으로 남아 있지 않다 — 심각도 **중간**
- source: brief L110 "**키 노출**: Model Studio API 키가 대화에 평문으로 들어간 적이 있다. **재발급 필요**", brief-add L51 "0. Model Studio API 키 재발급(기존 키가 대화에 평문 노출됨)"
- what: PRD FR-24는 "키는 Brain 저장소 밖에 둔다"만 말한다. 이미 노출된 키를 slice 1 시작 전에 교체해야 한다는 미해결 항목이 PRD·prd-add에 없다. 같은 키로 임베딩·재순위를 계속 쓰면 그대로 넘어간다.
- suggested: §9 Constraints 또는 §8에 "선행 작업: 노출된 Model Studio 키 재발급 후 설정에 반영(brief L110)" 한 줄. FR-24 점검 명령 consequence에 "키가 재발급본인지 내가 확인할 수 있다" 추가는 선택.
- severity: 중간

### G9. Orca·Paseo 같은 **작업 도구** 공유가 PRD에서 통째로 사라졌다 — 심각도 **중간**
- source: brief L14 "내가 쓰는 모든 AI 코딩 에이전트(Claude Code, Codex, OpenCode)와 **작업 도구(Orca, Paseo)**가 같은 기억 … 공유", brief L24 "Orca 세션 검색은 workspace 삭제와 함께 사라진다", brief L47 "Orca 세션 검색과 다른 점"
- what: PRD는 Harness를 "에이전트를 돌리는 도구"로 정의하고 Claude Code 하나만 다룬다(§3, §2.2). Orca·Paseo는 §6.2 Out of Scope에도 없어서, 이 둘이 Harness로 취급되는지(Orca 안의 Claude Code 세션은 어느 Harness인가) 판단 근거가 없다. prd-add §2 `sessions.harness`가 무엇을 담는지도 미정.
- suggested: §3 Harness 정의에 "Orca·Paseo처럼 Claude Code를 감싸는 작업 도구는 Harness가 아니라 추적 정보의 한 필드로 본다" 또는 §6.2에 "Orca·Paseo 연계 | 이후 조각" 행 추가.
- severity: 중간

### G10. 접은 대안 목록이 승계되지 않아, 특히 **MCP-only를 접은 근거가 뒤집힌 사실**이 안 남았다 — 심각도 **낮음**
- source: brief-add L23 "공식 plugin만으로 운영 | 시간 기준 조회·원본 보존·provider 교체·스케줄러 불가. 실험용으로만", L24 "MCP-only | 에이전트가 매번 조회 여부를 판단해야 함", L25 "처음부터 데몬 | …", L21 "로컬 임베딩 `Xenova/bge-m3`", L22 "임베딩 2560차원"
- what: prd-add §7은 자체 목록을 새로 썼고 brief-add §2의 5건을 담지 않았다. 문제는 단순 누락이 아니라 **근거 역전**이다. PRD FR-18 + §8-8은 "에이전트의 판단"에 조회를 맡기는데, 그건 brief-add §2가 MCP-only를 접은 바로 그 이유였다. 또 prd-add §4는 Claude Code plugin을 기록 수단으로 권하는데, brief-add는 "공식 plugin만으로 운영"을 접었다(수단으로서의 plugin과 운영 기반으로서의 plugin이 다르다는 구분이 없다).
- suggested: prd-add §7에 brief-add §2의 5건을 "brief 단계에서 접음"으로 승계하고, MCP-only 행에 "접은 근거(에이전트 판단 의존)는 slice 1 설계가 부분적으로 받아들였다 — PRD §8-8로 추적" 메모.
- severity: 낮음

### G11. "포트는 첫 구현을 붙일 때 하나씩 확정한다" 원칙과 미래 포트 목록이 빠졌다 — 심각도 **낮음**
- source: brief-add L63~L74 §7 포트 표(`KnowledgeProvider`/Graphify, `ResourceProvider`/Drive, 알림 채널, `CalendarProvider`, `Worker`)와 L74 "포트는 첫 구현을 붙일 때 하나씩 확정한다. **구현 없이 한꺼번에 설계하지 않는다**"
- what: prd-add §3은 slice 1 포트 5개만 적는다. 설계 규율 한 줄(=architecture 스킬이 과설계하지 않게 막는 장치)과 미래 포트 이름이 사라져, architecture가 포트를 미리 다 그릴 여지가 생긴다.
- suggested: prd-add §3 밑에 brief-add L74 원칙 한 줄을 그대로 옮기고, 미래 포트는 "brief-add §7 참조"로 링크.
- severity: 낮음

### G12. 내가 직접 규칙·결정을 적는 경로(`remember`)가 FR에 없다 — 심각도 **낮음**
- source: brief L75 Scope "`remember`·`forget`(규칙·결정 **수동 관리**)", prd-log L11 "… **명시 저장(remember)만 둠**"
- what: PRD FR-7은 "에이전트는 … 적을 수 있다", FR-21은 "조회하고, 고치고, 끌 수 있다"다. 내가 세션 밖에서 직접 규칙을 **새로 적는** 경로가 FR 수준에 없다(FR-23 목록의 "작업 로그 적기"가 사람도 쓸 수 있다는 암시만 있다). prd-log가 명시 저장을 남긴다고 적었는데 PRD에 내려오지 않았다.
- suggested: FR-21에 consequence 한 줄 — "나는 세션과 무관하게 규칙·결정을 직접 적을 수 있고, 그 줄은 출처가 '내 직접 입력'으로 남는다."
- severity: 낮음

### G13. "지시하지 않는다"는 성공 기준에 대응하는 지표가 없다 — 심각도 **낮음**
- source: brief L60 "내가 '검색해', 'brain_context 불러와' 같은 **지시를 하지 않는다**"
- what: SM-1은 이어가기 성공률, SM-6은 규칙 반복 횟수다. "내가 조회를 명령한 횟수"는 아무 지표도 세지 않는다. PRD §8-8이 이 위험을 알지만 판정은 SM-1에 떠넘긴다.
- suggested: SM-6을 "규칙 반복 + 내가 조회를 명시 지시한 횟수"로 넓히거나 SM-10을 추가(목표 0에 가깝게).
- severity: 낮음

### G14. 세 층 모델이라는 **설명 틀**이 PRD에 없다 — 심각도 **낮음**
- source: brief L29~L36 "세 층의 기억. 위 층일수록 정확하고, **아래 층은 언제든 위에서 다시 만든다**" (①원본 ②구조화 기록 ③검색 색인)
- what: PRD는 원문·작업 로그·조각을 각각 다루지만 세 층이라는 틀과 "손실 있는 층은 재생성 가능"이라는 원칙을 명시하지 않는다(FR-11이 색인 재생성만 보장). 용어 연속성이 끊겨 architecture 단계에서 층 구분이 흐려질 수 있다.
- suggested: §1 Vision 또는 §3 Glossary에 "세 층(원문 / 작업 로그 / 색인)과 재생성 방향" 2줄. 층 ②의 내용이 요약→작업 로그로 바뀐 것은 §2-B2 참고.
- severity: 낮음

**집계**: 높음 2(G1, G2) · 중간 7(G3~G9) · 낮음 5(G10~G14) = 14건

---

## 2. brief가 뒤처진 곳 (PRD의 기록된 override를 brief에 반영해야 함)

| # | brief 위치와 현재 문장 | 그래야 할 말 | 근거 |
|---|---|---|---|
| B1 | brief L18 "V1 slice 1은 원본 보존 + 조각 검색 + **세션 요약·결정 기록** + Claude Code 수집… **LLM 호출을 세션당 1회만** 쓰고도" | "원본 보존 + 조각 검색 + **에이전트가 적는 작업 로그** + Claude Code 수집. Brain 자체의 LLM 호출은 **0회**" | prd-log L13 (override) |
| B2 | brief L34 "② 구조화 기록 \| **날짜 붙은 세션 요약**, 결정…, 규칙·선호" | "② 구조화 기록 \| 일하는 에이전트가 그 순간에 적은 **작업 로그**(진행·결정·규칙). 대화 원문에 join" | prd-log L13, PRD §4.2 |
| B3 | brief L70 "Core 포트: … `Worker`(요약용)" / L73 "세션 종료 시: … **세션 요약 1회**" / L86 Key Decision "LLM 사용 \| **세션당 요약 1회만. Claude 구독 Worker**" | `Worker` 포트·요약 단계·구독 Worker 행을 모두 삭제. "Brain은 LLM을 부르지 않는다"로 교체. 요약은 안전망 후보로만(PRD §8-1) | prd-log L13, prd-add §3 |
| B4 | brief L87 "시간 질의 \| **세션 요약**을 날짜 범위로 조회(SQL)" | "시간 질의 \| **작업 로그**를 날짜 범위로 조회(SQL). 기본 범위는 나 전체" | PRD FR-12, prd-log L16 |
| B5 | brief L88 "결정·규칙 \| 세션 요약 때 후보로 뽑고 내가 확인해 확정" | "결정·규칙 \| 에이전트가 **그 순간에** 작업 로그로 적는다" — 단 '내가 확인해 확정'이 사라진 것은 override가 아니라 공백이므로 §1 G2로 처리 | prd-log L13 + G2 |
| B6 | brief L74 "세션 시작 시 자동 주입: **최근 세션 요약 + 유효한 결정·규칙 + 상위 조각**" | "세션 시작 시 자동 주입: **켜져 있는 규칙 + 최근 작업 로그 몇 줄 + Brain 사용 안내**. 결정·진행 로그와 조각은 주입하지 않고 조회 대상" | prd-log L7·L15, PRD FR-17 |
| B7 | brief L104 위험 "주입 시점(세션 시작만 / 매 프롬프트)과 후보 수를 **PRD에서 정한다**" | 결론을 반영: "세션 시작만, 검색·LLM 없음, 상한 500토큰 안팎" (해소된 위험으로 이동) | PRD FR-18, SM-C1 |
| B8 | brief L106 위험 "**구독 정책**: `claude -p`는 … 구독 한도에서 차감" / brief-add §4 전체 | slice 1에서 무관(Brain LLM 0회). "요약을 되살릴 때만 되살아나는 위험"으로 격하, brief-add §4는 이력 표시 | prd-log L13, prd-add §3 각주 |
| B9 | brief L107 위험 "**긴 세션 요약**: … 더 긴 세션의 이어 요약은 미검증" | 요약이 없으므로 소멸. 대신 "긴 세션의 작업 로그 누락"(SM-4)이 새 위험 | PRD §4.2, SM-4 |
| B10 | brief L29~L36·L53 — 범위 수준이 "프로젝트" 수준까지만 있고 **워크스페이스·워크트리·꼬리표** 개념이 없음 | "나 ⊃ 워크스페이스 ⊃ 프로젝트 ⊃ 워크트리 ⊃ 세션. 모든 기록은 항상 나에 속하고 중간 수준은 선택적 꼬리표. 칸막이가 아니다" | prd-log L14·L19, PRD §3·FR-4·NFR-8 |
| B11 | brief-add L109 "§7 포트 목록의 `MemoryProvider` 첫 구현은 pgvector 조각 검색으로 바뀐다" | 같은 문장에 "`Worker`(요약용) 행은 slice 1에서 **빠진다**"를 추가 | prd-add §3 |

**11건.**

---

## 3. PRD ↔ addendum 불일치 (※ M6은 PRD 내부 불일치)

| # | PRD | addendum | 어긋난 점 / 권고 |
|---|---|---|---|
| M1 | §3 Glossary·FR-7 "종류는 **진행**, 결정, 규칙" | §2 스케치 `log_entries … kind (**event** \| decision \| rule)`, §2 마지막 bullet "BMad의 종류(decision, change, override, assumption, event)와 맞추려면 `kind`를 넓히거나" | 같은 열의 값 집합이 PRD(3종, '진행')와 스케치('event')와 BMad(5종)로 셋이다. 하나로 못 박거나 "PRD의 진행 = 스케치의 event" 매핑을 명시. 심각도 중간 |
| M2 | FR-7 "적힌 줄은 적은 세션, **그 시점의 메시지 위치**, 시각, 꼬리표를 자동으로 가진다" / FR-8 "한 줄을 고르면 그 시점 앞뒤의 메시지를 읽을 수 있다" | §5 "로그는 메시지 순번 대신 **시각**을 기록하고, join은 '로그 시각 직전의 메시지'로 맞춘다(스케치의 `message_seq`는 **수집 후 채우는 파생값**)" + "로그가 먼저 도착한다" | FR-7은 기록 시점에 메시지 위치가 있다고 읽히지만 addendum은 그때 메시지가 아직 없다고 한다. 수집 전 로그에서는 FR-8이 성립하지 않는 구간이 생긴다. FR-7을 "시각을 기록하고 수집 후 메시지 위치로 맞춘다"로, FR-8에 "수집 전에는 위치가 비어 있을 수 있다"를 명시. PRD §8-7과 묶기. 심각도 중간 |
| M3 | NFR-6 "**대화 원문은 내 기계의 저장소에만 있다.** 외부로 나가는 것은 임베딩과 재순위를 위한 호출뿐" | §1 "조각 … 약 1,200자", "조각 검색 벡터 top-30 → 재순위"; §6 "재순위 … 후보 30개" — 즉 **조각 본문 원문 텍스트**가 Model Studio로 전송된다 | "원문은 내 기계에만"이 사실과 어긋난다(임베딩은 원문 조각을, 재순위는 후보 30개 본문을 외부로 보낸다). NFR-6을 "원문의 **보관**은 내 기계에만. 색인·조회 과정에서 조각 본문이 임베딩·재순위 서비스로 전송된다"로 정정. 심각도 중간 |
| M4 | §9 "한국어 검색 품질은 **사전 시험에서 검증된 구성**을 기준선으로 삼는다" / "저장소는 PostgreSQL 하나다" | §1 "저장소 \| PostgreSQL + pgvector … **기준선은 SQLite+인메모리로 쟀고** 검색 품질은 동일" | 검증된 것은 모델 조합이고 pgvector 경로는 미검증인데 §9는 구성 전체가 검증된 듯 읽힌다. §9에 "pgvector 경로 자체는 미검증(검증된 것은 임베딩·재순위 모델)"을 덧붙일 것. 심각도 낮음 |
| M5 | FR-21 "에이전트가 잘못 적은 줄을 내가 고치면, **고치기 전 내용과 고친 시각이 남는다**" | §2 `log_entries … edited_at?, previous_text?` (단일 컬럼) | 두 번 고치면 첫 내용이 사라져 FR-21과 NFR-1의 "고쳐 쓰지 않는다" 정신이 깨진다. 스케치를 이력 행(또는 append-only revisions)으로 바꿀 필요를 architecture 입력으로 적어 둘 것. 심각도 낮음 |
| M6 | **(PRD 내부)** SM-C1 "시작 맥락 크기 상한 **500토큰 안팎**" vs FR-17 "넘치면 오래된 작업 로그부터 뺀다. **규칙은 빼지 않는다**" | — | 켜진 규칙만으로 500토큰을 넘으면 규칙을 뺄 수도 없고 상한도 못 지킨다. 규칙이 상한을 먹을 때의 행동(경고? 상한 예외? 규칙 정리 유도?)을 FR-17이나 SM-C1에 명시. 심각도 중간 |
| M7 | FR-13 "워크트리 → 프로젝트 → **워크스페이스** → 나 전체 순으로 넓어진다" | §2 `workspaces id, name, **parent_id?**` (워크스페이스가 중첩 가능) | 워크스페이스가 트리면 넓히기 단계가 가변인데 FR-13은 4단계 고정으로 적혀 있다. "중첩 워크스페이스는 바깥쪽으로 한 단계씩" 또는 slice 1에서 중첩 금지. 심각도 낮음 |
| M8 | NFR-4 "영어 전용 기본값으로 **조용히 품질이 떨어지는 구성을 허용하지 않는다**" + NFR-2 조용한 실패 금지 | §3 재순위 "**없으면 벡터 순위 그대로.** 영어 전용 모델로 대체하지 않는다(NFR-4)" | 재순위 없이 도는 것도 품질이 떨어지는 조용한 저하다(기준선에서 1위 정확도 5.0 → 7.5). 이 상태가 조회 결과나 점검 명령에 드러나야 한다는 요구가 PRD에 없다. FR-24 점검 또는 NFR-2에 "재순위 미동작은 조회 결과에 표시된다" 추가. 심각도 중간 |

**8건** (M6은 PRD 내부).

---

## 메모

- PRD가 brief를 **의도대로 더 좁힌** 것으로 확인되어 gap으로 세지 않은 것: `Worker`/요약(B1~B3), 주입 범위(B6), Codex·OpenCode 수집, 데몬·앱·스케줄러·Telegram·Calendar·Graphify·Drive·다중 사용자(brief L78 = PRD §6.2), harness 원본 보관(brief L89 = PRD §6.2), 추출·통합 엔진 보류(brief L93 = PRD §6.1·prd-add §3).
- brief Open Questions 9건 중 PRD가 받은 것: 규모(§8-6), 채점표 편향(SM-3·prd-add §8), 주입 맥락 크기(SM-C1), rerank 비용(prd-add §6), 큰 메시지 2차 분할(FR-10). 소멸한 것: 구독 정책·긴 세션 요약(B8·B9). 남은 것: Codex·OpenCode hook 가정(범위 밖), 키 노출(G8).
