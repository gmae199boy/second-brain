"""감독 인증 진입점. 검증된 OS 인증 채널이 제공되기 전에는 닫혀 있다."""
import json


def main():
    # UID나 환경 변수만으로는 같은 UID의 미승인 실행물을 구분할 수 없다.
    # 안전한 bootstrap 및 HTTP admission이 구현될 때까지 입력이나 client 생성 금지.
    print(json.dumps({'abi': 1, 'type': 'error', 'code': 'AUTH_PEER_UNVERIFIED',
                      'retryable': False}), flush=True)
    return 1


if __name__ == '__main__':
    raise SystemExit(main())
