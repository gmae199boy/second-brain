---
type: epic
title: "운영: 내보내기·복구, 업그레이드, 제거"
parent: personal-brain
covers: [CAP-12, CAP-11]
after: ["epic-recall-and-mirror"]
assignee: ""
risk: medium
---

# 운영: 내보내기·복구, 업그레이드, 제거

## Description

`admin export/import`(스냅샷, manifest), 백업 경고, `setup upgrade`(코드 갱신·마이그레이션·hook 재등록), `setup uninstall`을 만든다. 내보내기·복구가 먼저다.

## Outcome

기억을 잃지 않고 Brain을 올리고 내릴 수 있다(NFR-9).

## Requirements

인셉션 때 채운다. spec의 CAP-12, CAP-11와 그것이 인용하는 PRD FR·spine AD가 원천이다.

## Done when

1. 내보낸 뒤 새 DB에 복구하면 메시지 수와 작업 로그 수가 같고, 파생 테이블은 다시 만들어진다.
2. 마지막 내보내기가 설정한 기간보다 오래되면 doctor가 경고한다.
3. 스키마가 다른 코드로 런타임 명령을 실행하면 DB에 쓰지 않고 `SCHEMA_MISMATCH`와 spool로 간다. `setup upgrade` 후 정상이 된다.
4. `setup uninstall` 후 Brain 표식이 붙은 hook과 shim이 없고, 데이터는 별도 확인 없이는 남는다.

## Boundaries

AD-8·20, Conventions(내보내기). 설치·재설정의 기본은 epic-foundation-and-install.

## References

- parent — _bmad-output/personal-brain/initiative-personal-brain.md
- spec — _bmad-output/personal-brain/spec-brain-v1-slice-1/spec-brain-v1-slice-1.md, Capabilities CAP-12, CAP-11
- architecture — _bmad-output/personal-brain/architecture-brain-v1-slice-1/architecture-brain-v1-slice-1.md
- prd — _bmad-output/personal-brain/prd-brain-v1-slice-1/prd-brain-v1-slice-1.md
