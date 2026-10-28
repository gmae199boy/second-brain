수정 후 재검증 — 지적 1(R1, currency); rubric 추가 0 / adversary 추가 0.

2026-10-28. 미커밋 spine diff의 AD-15 키워드 rebuild 문장, Table Contract `index_configs` 행, Stack 문서 추출 라이브러리 행만 검토했다. 근거는 같은 폴더 `.memlog.md:205`다. 정적 검토와 공식 저장소 열람만 했고 테스트·빌드·Docker·설치·커밋은 하지 않았다. 기존 Decision을 새 선택으로 되돌리지 않았다.

약칭 `spine`은 `_bmad-output/personal-brain/architecture-brain-v1-slice-1/architecture-brain-v1-slice-1.md`, `에픽`은 `_bmad-output/personal-brain/tickets/epic-recall-and-mirror/epic-recall-and-mirror.md`, `세트`는 그 에픽의 `tickets/tickets.toml`, `검색계획`은 `_bmad-output/personal-brain/tickets/epic-search-and-health-query/tickets/tickets.toml`이다. 행은 검토 시점 기준이다.

## rubric — 강제 가능성과 공통 계약

추가 지적 0. 활성·요청 설정의 분리, 완성 전 옛 설정만 검색, 증분/가리기를 두 설정에 반영한 뒤 원자 전환, 중단 재개, 오래된 완료의 되돌림 금지는 관찰 가능한 금지·성공 조건이다(`spine:286`). `spine:566`은 종류별 포인터 writer를 `index.rebuild`로 한정한다. 설정 행의 불변성과 별도 가변 포인터는 양립한다. exact DDL·잠금·진행 표의 모양은 구현 plan에서 정할 수 있으며 이 수준의 spine에 요구하지 않는다.

| 대조 계약 | 판단 |
| --- | --- |
| AD-11 가리기 | `spine:229`는 영향받는 조각 삭제·재생성 enqueue를 본문 치환과 같은 트랜잭션에 둔다. 설정 하나로 삭제 범위를 제한하지 않는다. `spine:286`의 두 설정 재생성 완료 조건과 결합하면 대기 중인 새 설정에 가리기 전 값이 남은 채 전환하는 것은 금지된다. `검색계획:20`의 입력 fingerprint 재검사도 재사용한다. |
| AD-15 검색 | `spine:277`의 설정 기반 chunker와 `spine:286`의 활성 설정 하나만 검색은 양립한다. `세트:81`·`세트:82`가 crash 후 옛 설정 검색·재개·전환 뒤 새 설정 검색·가리기 경쟁을 맡고, `에픽:112`가 동시 rebuild의 독립 확인을 맡는다. 불변식만 적고 검증 주체가 없는 상태는 아니다. |
| AD-24 문서 추출 | `spine:401`의 파일별 추출 attempt/current 포인터는 문서 계약이고, 키워드 rebuild는 모든 세션의 대화 조각 계약이다. `세트:81`은 `document_chunks`와 추출 세대를 건드리지 않으며 `세트:82`가 비변경을 검증한다. `spine:402`의 라이브러리 버전과 `extractor_version` 연동도 새 Stack 행이 유지한다. 날짜 원문과 대안 라이브러리 사이의 문제는 아래 R1이다. |
| Table Contract chunks | `spine:564`의 `(session_id, index_config_id, from_at, to_at, part)` 키로 옛/새 설정 조각이 공존할 수 있다. 같은 시각 입력 정규 나열·코드 포인트 분할·part 배정을 Core chunker 하나가 소유한다. rebuild가 별도 part 정책을 만들 근거는 없으며 `세트:81`도 epic 17의 chunker·writer와 part 키를 그대로 소비한다. |

## adversary — 계약을 지키면서 갈라질 두 단위

추가 지적 0. 다음은 설계 문장이 실제로 배제하는 반례이며 동작 시험 결과는 아니다.

| 두 단위와 시도 | 계약에 의한 배제·후속 plan의 확인 |
| --- | --- |
| epic 17의 증분 writer / epic 4 rebuild: 새 설정을 만들 동안 새 메시지는 활성 설정에만 기록하고, 최초 세션 목록을 모두 처리했다는 이유로 전환 | `spine:286`은 그동안 들어온 증분을 두 설정에 반영한 뒤에만 전환하도록 한다. 최초 목록만으로 완료를 정하는 구현은 이 문장을 위반한다. `세트:81`이 통합 책임을 소유하며 plan은 `에픽:113`의 전환 직전 barrier를 이용해 새 메시지/새 세션까지 확인해야 한다. watermark·재확인·직렬화 중 수단을 이 리뷰에서 새로 선택하지 않는다. |
| redact 재생성 / 활성 포인터 전환: rebuild가 가리기 전 snapshot을 읽고, redact가 조각을 삭제한 뒤 낡은 결과를 새 설정에 확정 | `spine:229`의 삭제/enqueue 원자성과 `검색계획:20`의 입력 fingerprint 검사, `spine:286`의 두 설정 반영 조건을 함께 위반한다. `세트:82`는 전환 후에도 가린 값이 없는지 확인한다. 준비 완료 확인과 실제 전환 사이의 redact도 같은 불변식을 지켜야 하므로 plan의 barrier 위치에 포함한다. |
| 서로 다른 설정의 rebuild A / B: B가 먼저 완료돼 활성인데 뒤늦게 끝난 A가 활성 포인터를 되돌림 | `spine:286`이 오래된 완료의 되돌림을 명시적으로 금지하고, `spine:566`이 포인터 writer를 한 경로로 한정한다. `에픽:112`가 동시 요청·완료 역전의 추가 확인을 맡는다. 요청 직렬화와 세대 비교 중 구현 선택은 남아 있어도 금지 결과는 하나다. |
| 대화 rebuild / 문서 추출: 대화 설정 전환을 이유로 파일 추출 포인터도 바꾸거나 원본에 닿을 수 없는 문서 조각을 지움 | `spine:401`·`spine:403`은 파일별 추출 세대와 보존을 소유하고 `세트:81`·`세트:82`가 문서 비변경을 명시한다. 대화의 활성 포인터가 문서의 current 포인터를 대신할 수 없다. |

요청된 세대만 완성됐다는 이유로 최신 입력을 놓치거나, 전환이 트랜잭션이라는 이유만으로 가리기 경쟁을 무시하는 구현은 허용되지 않는다. plan은 이 불변식을 강제할 구체 수단과 barrier를 적어야 한다. 문서의 금지 조건이 이미 분명하므로 수단 미지정 자체를 추가 지적으로 세지 않았다.

## currency — EXIF 원문 보존과 라이선스

2026-10-28 공식 저장소 문서와 고정 태그 소스를 읽었다. 최신 버전 번호·실제 fixture 통과·설치 호환성을 확인했다는 주장은 하지 않는다.

| 라이브러리 | 공식 근거와 판단 |
| --- | --- |
| exifr | 공식 [README의 reviveValues 옵션](https://github.com/MikeKovarik/exifr#optionsrevivevalues)은 기본 true의 날짜 Date 변환을 false로 끄고 문자열로 유지할 수 있음을 문서화한다. [태그 선택 옵션](https://github.com/MikeKovarik/exifr#optionspick)도 제공한다. 따라서 exifr 우선은 공식 설명과 맞으며 실제 DateTimeOriginal/CreateDate·offset 조합과 원문 동일성은 4.1 fixture에서 입증해야 한다. [공식 LICENSE](https://github.com/MikeKovarik/exifr/blob/master/LICENSE)는 MIT다. |
| exif-reader 2.0.3 | 공식 [README](https://github.com/devongovett/exif-reader#usage)의 API는 원시 EXIF buffer를 받아 Image·Photo 등의 객체로 내고 날짜 예시는 Date다. [고정 태그 구현](https://github.com/devongovett/exif-reader/blob/v2.0.3/index.js#L1-L79)은 buffer만 받고 날짜 세 태그에 무조건 parseDate를 적용한다. [parseDate](https://github.com/devongovett/exif-reader/blob/v2.0.3/index.js#L182-L197)는 정해진 형식만 Date.UTC로 바꾸며 원문 보존 옵션이 없다. 공식 [License 절](https://github.com/devongovett/exif-reader#license)은 MIT다. 날짜 원문 대안이라는 보증에는 아래 보완이 필요하다. |

### R1 — 원문 보존 실패 시 exif-reader로 대체한다는 경로에 원문 획득 수단이 없다

- 위치: `spine:663`(변경 Stack 행), `spine:404`(AD-24), 소비자 `에픽:100`, `세트:93`·`세트:94`. 세트 재검증의 F7과 같은 문제다.
- 조건: exifr의 날짜 원문 보존 확인이 실패해 문서화된 대안 exif-reader 2.0.3으로 바꾼다. 공식 API에는 변환을 끄는 옵션이 없어 DateTimeOriginal·DateTimeDigitized·DateTime의 원문은 Date 또는 null로 대체된다. 이름도 exifr의 CreateDate와 달리 DateTimeDigitized이므로 adapter에서 태그 매핑을 확인해야 한다.
- 결과: 대안의 반환값만으로는 `captured_at_local` 원문을 보존할 수 없다. Date를 포맷해 원문이라고 하거나, offset 없는 Date를 절대 시각으로 채우는 구현은 AD-24와 충돌한다. 컨테이너 전체를 받는 exifr와 EXIF buffer를 받는 대안의 입력 범위도 같다고 단정할 수 없다.
- 교정: exifr 우선은 유지하고 4.1 확인에 `reviveValues: false`·날짜/offset 원문 fixture를 명시한다. exif-reader 대안에는 원래 EXIF 문자열을 얻는 별도 경로·태그 매핑·컨테이너 지원을 입증한 경우에만 채택 가능하다는 조건을 Stack/에픽에 연결한다. 원문 경로가 입증되기 전에는 단순 교체 가능한 대안으로 읽히지 않게 한다. 이는 새 공식 증거에 따른 실행 가능성 보완이며 기존 라이브러리 선택을 다시 투표하자는 요청이 아니다.

두 프로젝트의 MIT 표시에서 별도 선택 충돌은 발견하지 않았다. 채택 버전과 해당 배포물의 고지 반영은 구현 때 고정하며, 라이브러리를 바꾸면 `spine:402`의 `extractor_version`도 함께 바뀌어야 한다.
