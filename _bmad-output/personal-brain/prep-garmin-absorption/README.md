# Garmin → second-brain 흡수 준비 패키지

작성: 2026-10-27. 대상: `~/github/second-brain`. 준비물의 목적은 다음 세션이 제품 통합 설계와 구현 계획을 바로 시작하게 하는 것이다. 아직 제품 코드를 편입하거나 PostgreSQL을 실행한 상태가 아니다.

업데이트(2026-10-28): Brain 플러그인에 기본 포함할 공통 install 스킬(확장 설치 안내)을 R17과 통합 경계/로드맵에 추가했다. `brain install garmin`은 계획한 CLI 사용 형태이며, 실제 설치 CLI/스킬은 후속 구현이다. 자동 예약은 Brain 공통 스케줄러를 선행 조건으로 사용한다.

## 먼저 읽을 것

1. [accepted-intent.md](accepted-intent.md): 사용자의 최신 결정과 현재 코드/데이터에서 확인한 사실. 과거 “데이터 이전 불필요” 판단은 폐기한다.
2. [initiative-garmin-absorption.md](initiative-garmin-absorption.md): 검증 가능한 통합 요구사항 초안.
3. [integration-boundaries.md](integration-boundaries.md): 재사용/교체할 코드, 기존 Brain 설계와의 충돌, 결정할 계약.
4. [migration-contract.md](migration-contract.md): 기존 원본·수치·분석/파일 보존과 검증.
5. [roadmap.md](roadmap.md): 착수 순서 제안과 다음 세션의 구체적인 시작점.

## 코드와 근거

- `inputs/garmin-source.tar.gz`: Garmin 고정 커밋의 추적 파일만 담은 소스 스냅샷. Python 소스, SQL, skills, 테스트, 의존성 잠금, 공개 기본 설정과 README 포함. 기존 deploy/schedule은 참고자료이며 자동 실행하지 않는다.
- `source-manifest.json`: 소스 커밋, 반입 파일별 SHA-256, archive SHA-256, 제외 규칙.
- `inputs/research/`: 두 저장소의 정밀조사와 독립 검증 근거. 구현 사실은 각 문서의 고정 커밋 기준이다. 최신 제품 범위는 이 패키지의 accepted-intent가 우선한다.
- `preparation-checks.json`: 패키지 파일·참조·소스 무결성 검증 결과. 애플리케이션 테스트 통과를 뜻하지 않는다.

## 개인 데이터는 별도 보관

실제 DB·분석·리포트·이미지·facts·로그·운영 설정·토큰은 이 패키지에 넣지 않는다. Garmin 저장소의 Git 제외 경로 `data/absorption-prep/`에 로컬 스냅샷을 보관하고, `LATEST`가 해당 디렉터리를 가리킨다. 안의 `manifest.private.json`은 DB별 스키마/건수와 파일별 크기/해시를 가진다. 이것은 개인 보관본이며 소스 패키지나 공개 커밋에 포함하지 않는다.

현재 준비 시점에 DB 후보 5개를 SQLite backup API로 각각 캡처했고, 관련 파일 349개를 복사·해시 검증했다. DB별 일관성은 확인했으나 모든 DB와 파일을 한 시각에 정지시킨 전역 스냅샷은 아니다. 실제 전환 전에는 새 캡처 또는 변경 없음 확인이 필요하다.

## 다음 세션에서 할 일

`second-brain`에서 이 폴더를 입력으로 기존 personal-brain 요구사항과 아키텍처를 갱신한다. PostgreSQL 주 저장소·공통 설정·확장/작업 계약을 먼저 정하고, 그 계약 아래 Garmin 저장 포트와 데이터 importer를 구현한다. 기존 티켓/active initiative/배포 설정은 이번 준비에서 바꾸지 않았다. 이 폴더의 initiative와 roadmap은 기존 보드에 등록하지 않은 초안이다.

소스 archive를 확인할 때는 staging 디렉터리에서만 풀고, 내부 deploy 스크립트를 실행하지 않는다. 원본 소스 주소와 커밋은 source-manifest에 보존한다.
