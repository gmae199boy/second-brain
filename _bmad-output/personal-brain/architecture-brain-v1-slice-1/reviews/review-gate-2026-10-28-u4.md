수정 필요 — 지적 3건 (critical 0 / high 1 / medium 2 / low 0)

# Reviewer Gate — 네 번째 update (2026-10-28)

미커밋 spine 변경을 대상으로 rubric·adversary·currency를 검토했다. 정적 문서 검토와 Google 공식 문서 열람만 했으며 테스트·빌드·Docker·설치·커밋·실제 Google 계정 호출은 하지 않았다. 기존 Decision의 선택은 재논의하지 않는다. 아래 지적은 그 선택을 공통 계약으로 옮길 때 남은 경계다. 두 adversary 구성은 기존 지적을 구체화하며 별도 건수로 중복 집계하지 않는다.

근거의 `약칭:행`은 다음 저장소 상대 파일의 현재 행 번호다. 조회에픽의 결과 계약은 `git show HEAD:<경로>`로 커밋본과도 대조했다.

| 약칭 | 파일 |
| --- | --- |
| spine | `_bmad-output/personal-brain/architecture-brain-v1-slice-1/architecture-brain-v1-slice-1.md` |
| memlog | `_bmad-output/personal-brain/architecture-brain-v1-slice-1/.memlog.md` |
| Drive에픽 | `_bmad-output/personal-brain/tickets/epic-drive/epic-drive.md` |
| 세트검증 | `_bmad-output/personal-brain/tickets/epic-drive/epic-drive-validate-set.md` |
| 조회에픽 | `_bmad-output/personal-brain/tickets/epic-search-and-health-query/epic-search-and-health-query.md` |

## 1. rubric — 강제 가능성·내부 일관성·커밋된 결과 계약

`memlog:197`, `Drive에픽:106`·`:112`·`:113`·`:131`, `세트검증:34`~`:38`의 결정은 대체로 옮겨졌다. 다음은 통과한다.

- AD-15(`spine:287`): 이름 전용 항목은 `document`를 유지하고 `source_file_id`로 `files.show`에 내려간다. 가짜 `file_id`·`chunk_locator`를 금지했다. 조회에픽의 기존 본문 결과(`조회에픽:44`·`:45`·`:93`)는 그대로 유효하고, 이름 전용 경로를 나중에 확장하는 분담(`조회에픽:55`·`:69`, `Drive에픽:100`·`:101`)과 맞는다. epic 17에 Drive 검색을 미리 구현하라고 요구할 근거는 없다.
- AD-23(`spine:383`~`:387`): remote id를 locator에 넣지 않고 내용 해시의 순수 함수와 별도 매핑을 유지한다. 임시 추출한 외부 내용에 Brain 사본을 만들지 않는 문장은 앞의 home 규칙에 대한 예외로 읽을 수 있다. 같은 해시의 기존 Brain 사본이 있을 때 그것을 지우거나 home을 비우라는 뜻으로 확대하면 안 된다.
- AD-8과 Table Contract(`spine:181`~`:187`, `:570`~`:578`): 내용 해시는 `files`에, 원격 정체성은 `(source_id, remote_file_id)`에 놓인다. 내려받기 전 null인 `content_id`는 `files`의 가짜 해시나 `file_names.file_id`의 가짜 값을 요구하지 않는다. `document_chunks`의 추출 세대 키·정규 locator도 이름 전용 항목 때문에 느슨해지지 않는다.
- AD-18·21·27 및 Conventions(`spine:318`~`:322`, `:357`~`:367`, `:434`~`:436`, `:629`~`:644`): 새 source 표는 core 표이고 sync는 공통 일감이다. 기존 출력 코덱·8,000자 상한·0건/실패 구분·세대 차단을 면제하는 문장은 없다. 단, 아래 R3의 source 이름 우회는 별도 보강이 필요하다.

### R1 — medium: source별 접근 상태와 AD-24의 파일 공통 경고 규칙을 연결해야 한다

- 근거: `spine:387`은 접근 상실을 source 항목에 남기고 같은 내용의 다른 정상 원본에 퍼뜨리지 말라고 한다. 그러나 `spine:402`는 연동 해제된 원본을 여전히 `files.source_unreachable_at`으로 표시하고 결과에 `FILE_SOURCE_UNREACHABLE`를 붙이며 재추출을 막는다고 한다. `spine:570`도 그 공통 필드의 변경자를 복구·연동 해제로 열어 둔다. `세트검증:38`은 이 경고 적용까지 동기화하라고 요구했다.
- 문제: writer가 새 규칙대로 source A에만 접근 불가를 써도, 기존 reader가 공통 필드만 읽으면 A의 출처에는 경고가 빠진다. 반대로 기존 연동 해제 경로가 공통 필드를 채우면 같은 내용의 정상 source B나 Brain home까지 재추출 불가로 읽힐 수 있다. 새로운 금지 문장만으로는 AD-24 reader가 무엇을 읽어야 하는지 정해지지 않는다.
- 바꿀 문장 제안(AD-24의 접근 불가 문장과 `files` 행에 함께 적용): “외부 source의 접근 불가와 `FILE_SOURCE_UNREACHABLE`는 해당 `source_files` 출처를 기준으로 판정하며 다른 정상 source나 검증된 Brain 위치의 읽기·재추출을 막지 않는다. `files.source_unreachable_at`은 파일 전체에 사용 가능한 원본이 없는 경우에만 쓰고, 정상 원본이 돌아오면 해제한다. 기존 추출 조각은 계속 검색한다.”

## 2. adversary — 계약을 따르는 두 단위가 갈라지는 구성

### R2 — medium: 이전 일감의 매핑과 FileStore adapter의 remote id 조회가 갈라질 수 있다

- 근거: `spine:384`는 remote id를 `drive_uploads`에 둔다고만 하고, `spine:573`의 작성자는 “원본 이전 일감”뿐이다. 반면 `spine:385`의 Drive FileStore는 넣기·가져오기·확인·URL·지우기를 모두 제공한다. `Drive에픽:106`은 이름을 멱등 키로 믿지 않는다고 이미 결정했다.
- 단위 A: 이전 일감은 `(root_folder_id, content_hash)`의 remote id A를 저장하고 검증·home 전환을 한다. locator는 정해진 `<hex><확장자>`다.
- 단위 B: Drive FileStore의 URL·확인·삭제는 같은 locator 이름으로 Drive를 조회해 첫 결과 B를 고른다. remote id를 locator에 넣지 않고 A의 매핑도 보존하므로 새 spine에 적힌 저장 형태는 지킨다. 하지만 같은 이름의 파일이 여럿이면 home 확정에서 검증한 A와 읽거나 지우는 B가 달라진다. 이름의 순수 함수만으로 원격 넣기가 멱등이라는 결론도 성립하지 않는다.
- 바꿀 문장 제안(AD-23과 `drive_uploads` 작성자 칸): “Drive FileStore의 넣기·가져오기·확인·URL·지우기는 모두 `(root_folder_id, content_hash)`의 `drive_uploads` 매핑 하나로 remote id를 해석한다. 이름 검색 결과를 매핑 대신 사용하지 않는다. 매핑의 생성·재개·확정은 이전 일감과 Drive put이 공유하는 저장 함수가 소유하며, 같은 키의 동시 put도 하나의 확정 remote id로 수렴한다.”

### R3 — high: 가린 내용이 source 이름 branch에서 다시 검색될 수 있다

- 근거: `spine:392`는 내용 단위 가리기에서 추출 세대·조각과 `file_names`·`file_metadata`를 지우고 재생성을 막는다. 새 `source_files`의 이름·경로·nullable `content_id`(`spine:572`)와 이름 전용 결과(`spine:287`)에는 연결된 내용의 `redacted_at` 제외 규칙이 없다. 조회에픽의 커밋된 계약(`조회에픽:45`)은 “가린 파일은 나오지 않는다”다.
- 단위 A: 기존 `files.redact`는 연결된 파일 F를 가리고 기존 조각·이름 표를 모두 지운다. 모든 기존 가리기 의무를 지킨다.
- 단위 B: source 이름 검색은 여전히 `source_files`의 이름을 찾는다. 예를 들어 추출 실패 상태인 외부 항목은 이름 전용 결과로 돌려주고 `files.show(source_file_id)`는 원본 URL을 낸다. 본문을 내지 않고 가짜 locator도 만들지 않지만, `content_id = F`인 가린 내용의 이름과 원본 경로가 공개 검색에 다시 나타난다. 출력 코덱은 일반 비밀 패턴 가리기이므로 사용자가 요청한 내용 단위 가리기를 대신하지 못한다.
- 바꿀 문장 제안(AD-15 source 경로와 AD-23 가리기에 적용): “`source_files.content_id`가 가리키는 `files.redacted_at`이 있으면 source 이름 검색과 `files.show(source_file_id)`에서도 그 파일의 표시 이름·경로·원본 URL을 돌려주지 않는다. source 메타데이터 갱신·재연결·재추출은 이 제외를 우회하지 않는다. 아직 내용 해시를 모르는 `content_id = null` 항목을 이미 가린 내용이라고 추정하지는 않는다.”

이 두 구성은 epic 17 검색을 새로 만들거나 Drive locator 결정을 뒤집어 해결할 문제가 아니다. 공통 검색의 제외 조건과 공통 매핑 resolver를 지정하면 기존 분담을 유지하며 막을 수 있다.

## 3. currency — Drive 공식 문서 확인

2026-10-28 열람. 아래는 API 계약과 프로젝트 정책을 구분한 확인이며 새 Decision을 요구하지 않는다.

| 확인 항목 | 공식 사실·출처 | epic 8 및 spine 판정 |
| --- | --- | --- |
| `md5Checksum` | 바이너리 내용에 적용되는 출력 전용 MD5다. [File 리소스](https://developers.google.com/workspace/drive/api/reference/rest/v3/files#File) | `Drive에픽:107`의 로컬 동일 바이트 MD5 비교는 맞는다. `spine:383`의 내용 정체성 SHA-256과 구분해야 하며 MD5를 `content_hash`로 바꾸지 않는 결정과 일치한다. |
| `sha256Checksum` | 사용 가능할 때 채워지는 출력 전용 SHA-256이며 Docs Editors·shortcut에는 채워지지 않는다. [File 리소스](https://developers.google.com/workspace/drive/api/reference/rest/v3/files#File) | `Drive에픽:107`의 SHA-256 우선 → MD5 → 되읽기 SHA-256은 필드 부재를 고려한다. `spine:387`의 저장소 해시 또는 되읽기 검증과 맞는다. Docs export 바이트에 원격 체크섬이 항상 있다고 가정하지 않는다. |
| changes 토큰 | `startPageToken`, `nextPageToken`, `newStartPageToken`은 만료되지 않는다. [getStartPageToken](https://developers.google.com/workspace/drive/api/reference/rest/v3/changes/getStartPageToken), [changes.list](https://developers.google.com/workspace/drive/api/reference/rest/v3/changes/list) | `Drive에픽:30`은 맞다. `Drive에픽:112`의 “cursor가 거부되면 전체 재목록”은 거부 시 방어책이며 정기 만료를 뜻하지 않는다. `spine:571`은 cursor의 TTL을 새로 만들지 않아 충돌하지 않는다. |
| export 상한 | `files.export`가 반환하는 내보낸 내용은 10 MB로 제한된다. [files.export](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/export) | `Drive에픽:30`은 맞다. 이는 PDF 원본 다운로드의 프로젝트 상한 50MiB(`Drive에픽:114`)와 별개다. `spine:287`의 `too_large` 이름 전용 경로는 이 제한을 표현할 수 있고, AD-24의 text locator도 export된 텍스트와 양립한다. |
| resumable 업로드 | 5 MB 초과 또는 중단 위험이 있을 때 권장하며 작은 파일에도 쓸 수 있다. 세션 URI는 1주 후 만료한다. 마지막 조각 외에는 256×1024 바이트 배수로 전송하고, 재개는 서버 `Range`를 확인한다. 상태 조회의 308은 미완료, 404는 세션 만료로 처음부터 재시작한다. [Upload file data](https://developers.google.com/workspace/drive/api/guides/manage-uploads#resumable) | `Drive에픽:107`의 5MiB 초과 사용은 프로젝트 정책이며 공식 문서의 5 MB 표기를 바이트 단위의 프로토콜 금지선으로 읽으면 안 된다. session URI·remote id·확인한 offset의 영속화와 `spine:573`의 업로드 상태는 공식 규칙과 양립한다. 세션 만료 404를 원본 파일 404와 구분해야 하며 AD-21(`spine:363`)의 일반 영구 오류로 그대로 닫아서는 안 된다. URI는 공개 출력에 내보내지 않는 `Drive에픽:138`의 계약을 유지한다. |

currency에서 이번 spine 변경을 뒤집을 공식 사실은 발견하지 않았다. API는 같은 폴더의 이름 유일성이나 내용 주소 기반 멱등성을 보장하지 않으므로, `drive_uploads`를 둔 기존 결정은 유지하고 R2의 모든 소비자 조회 규칙을 보강해야 한다.

이 리뷰의 완료 범위는 위 3건의 문장 제안까지다. spine·memlog·티켓은 수정하지 않았다.
