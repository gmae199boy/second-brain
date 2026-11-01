# 합성 native peer 실험

macOS에서 `extensions/garmin/tests/native/check-native.sh`를 실행한다. Command Line Tools, `codesign`, `rg`가 필요하다. 임시 디렉터리에 ad-hoc 서명 실행물을 빌드하고 종료 시 제거한다. 샌드박스에서 XPC가 차단되는 경우 이 스크립트는 실패하며, 별도로 허용된 환경에서 실행한 결과만 XPC 실험 성공으로 취급한다.

두 다른 합성 실행물에 대해 Unix socket의 `LOCAL_PEERTOKEN`, `SecCodeCopyGuestWithAttributes` 및 고정 cdhash 요구사항을 확인한다. 익명 XPC 실험은 같은 프로세스의 양방향 연결에 code-signing 요구를 설정하고 일치 및 불일치 결과를 관찰한다. 실제 서비스 설치, 서로 다른 프로세스의 XPC 승인 UI, 비밀 FD, OS 신원과 실행물의 보호 배포, tokenstore 격리 또는 Garmin HTTP를 검증하지 않는다. ad-hoc 서명과 같은 UID만으로 운영 신뢰를 주장하지 않는다.
