# 보호 배치 staging

`node tooling/protected-deployment/stage.mjs`는 임시 디렉터리에 검토 산출물을 만든다. 설치, Docker 명령, 운영 DB·자격·tokenstore 접근은 수행하지 않는다. `node --test tooling/protected-deployment/stage.test.mjs`는 격리 fixture를 실행한다.

엔진 평가는 관리 API, VM, 컨텍스트, 볼륨, 백업, inspect/exec/create, 재부팅 및 업데이트 뒤의 경계를 모두 미검증으로 표시한다. 이 평가는 현재 접근을 검사하거나 차단하는 OS 보안 경계가 아니며, 파일이나 호출자의 주장으로 검증 상태를 변경할 수 없다. 로그인 UID의 모든 동등 관리 경로가 실제로 분리되었는지 증명하기 전까지 보호 배치는 미완료이며 인증 입력과 외부 HTTP는 닫혀 있어야 한다. 별도 principal 또는 소켓만으로 격리가 증명되지 않는다. 운영 이전은 16.9에서 수행한다.

정책 renderer는 역할과 보호 대상 경로의 후보 및 policy digest를 생성한다. `node tooling/protected-deployment/preflight.mjs <staging 경로>`는 root 소유·쓰기 권한과 고정 정책의 일치 여부를 검사하지만 실제 엔진·서비스 신원·서명이 미검증이므로 항상 실패한다. 파일의 digest는 봉인이 아니며 사용자 소유 staging은 신뢰 근거가 아니다. 운영 설치용 권한 상승, 실제 서명·서비스 설치, ACL과 모든 상위 경로 및 교체 경쟁 검사, 별도 UID의 DB와 관리 API 거부, 재부팅·업데이트 검증은 구현 또는 실증되지 않았다. `rollback`은 이 fixture 전용이며 운영 설치 복구에 사용할 수 없다.

`path_guard.py`는 열린 디렉터리 FD를 기준으로 `O_NOFOLLOW`와 소유자·모드·macOS 확장 ACL 부재를 검사하고, 파일은 FD에서 digest와 단일 링크를 검사한다. `installer.py`는 검증된 합성 원본을 새 fixture 디렉터리에 렌더링하며 부분 생성 실패 때 해당 fixture의 생성물을 되돌린다. `python3 -m unittest discover -s tooling/protected-deployment -p 'test_*.py' -v`로 시험한다. 이 코드는 운영 설치기가 아니다. 상위 경로를 root에서부터 고정하는 운영 진입점, 실제 서명된 고정 실행물, 서비스 principal과 launchd 설정, 별도 UID 및 엔진 거부 검증이 없으며 임의 UID·digest 입력을 신뢰 경계로 사용할 수 없다.
