# 가짜 Drive tracer 시험 자원

이 fixture는 합성 바이트와 loopback HTTP 서버만 사용한다. `apps/cli/test/fixtures/fake-drive.ts`의 `fakeDrive()`가 동적 포트를 열고 요청 목록과 원격 파일 Map을 노출하며, `fakeClock()`은 `set(ISO)`으로 시각을 바꾼다. 파일 이름 검색은 지원하지 않는다. `loseNextUploadResponse`, `checksum`과 `files`로 응답 유실·검증 불일치·원격 소실을 주입하고 `holdNextUpload()`·`holdNextDownload()`의 entered/release 장벽으로 경합을 제어한다.

`apps/cli/test/drive-tracer.test.ts`는 `pgHome(home, true, createIsolatedTestDatabase)`를 사용한다. 시험 전 전용 관리자 PG URL을 `BRAIN_TEST_DATABASE_URL`에 설정해 기본 공유 Compose 자동 선택을 막고, 독립 Docker context·소유한 checkout 밖 TMPDIR·독립 Brain home과 빌드 산출물을 준비한다. 고정 확장 role은 cluster 전역이므로 다른 티켓과 cluster를 공유하지 않는다. 격리 관리자 및 legacy fixture의 암호 전제를 확인하고 실제 계정·운영 DB·사용자 파일·credential은 사용하지 않는다. 테스트의 홈에는 시험 DB URL만 기록한다.

개발과 리뷰 수정 중에는 이 명령도 실행하지 않는다. 최종 구현 및 독립 후속 확인 뒤 지정된 순서대로 실행한다.

```sh
VITEST_MAX_WORKERS=2 pnpm test
pnpm test:python
```

관련 실패를 고친 뒤 선별 재검증할 때의 예(전용 환경에서만):

```sh
pnpm test:changed -- f1a2f22e1b6026aeeedec88ec310aefbdb947556
pnpm exec vitest run apps/cli/test/drive-tracer.test.ts apps/cli/test/drive-file-store.test.ts packages/postgres/test/drive-migration.test.ts
```

관찰할 것은 각 fake 요청의 `GET ...?alt=media`, 업로드/삭제 수, 단일 root/hash 매핑, home·verified_at·retention due·work 행, 로컬 파일 존재와 클라이언트 출력이다. `fakeClock.set`으로 검증 시각과 30일 직전·만기 시각을 제어하며 실시간 대기는 하지 않는다. 원문은 합성 텍스트뿐이고 secret 문자열도 시험용이다.

각 fixture는 `finally`/`afterEach`에서 자기가 연 HTTP 서버, PG pool·관리 연결, 자신이 만든 DB/컨테이너, 임시 홈만 닫거나 삭제한다. `createIsolatedTestDatabase`는 생성 컨테이너 ID와 동적 포트를 기록하고 정확한 ID를 제거한다. 테스트 종료 후 그 소유 ID와 임시 홈의 부재를 확인하며, 실패로 남은 리소스는 기록된 ID를 확인한 뒤 해당 ID만 정리한다. 다른 티켓의 container·role·home 또는 운영 데이터를 건드리지 않는다.
