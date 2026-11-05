"""보내기 전용 Telegram 경계. 비밀과 응답 본문은 밖으로 내보내지 않는다."""

import json
import logging
import os
import stat
from contextlib import ExitStack
from pathlib import Path
from time import sleep as _sleep

from garmin_pipeline import errors

API_BASE = "https://api.telegram.org"
logger = logging.getLogger(__name__)


class TelegramAdapter:
    """매 요청마다 권한과 비밀을 다시 확인하는 Telegram 전송 어댑터."""

    def __init__(self, tokenstore: Path, *, api_base: str = API_BASE, session=None):
        self._path = tokenstore / "telegram.json"
        self._api_base = api_base.rstrip("/")
        self._session = session

    def _credentials(self):
        for candidate in (self._path, *self._path.parents):
            if stat.S_ISLNK(candidate.lstat().st_mode):
                raise ValueError()
        fd = os.open(self._path, os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(fd, encoding="utf-8") as stream:
            mode = os.fstat(stream.fileno()).st_mode
            if not stat.S_ISREG(mode) or mode & 0o777 != 0o600:
                raise ValueError()
            data = json.load(stream)
        token, chat = data["bot_token"], data["chat_id"]
        if not isinstance(token, str) or not token.strip():
            raise ValueError()
        if type(chat) is not int and not (isinstance(chat, str) and chat.strip()):
            raise ValueError()
        return token, chat

    def send_message(
        self, text: str, *, timeout_seconds: float, wait_rate_limit: bool = False
    ) -> errors.DeliveryReason | None:
        return self._request(
            "sendMessage",
            {"text": text},
            (),
            timeout_seconds,
            wait_rate_limit,
            too_large=len(text.encode("utf-16-le", errors="surrogatepass")) // 2 > 4096,
        )

    def send_photo(
        self, path: Path, *, timeout_seconds: float, wait_rate_limit: bool = False
    ) -> errors.DeliveryReason | None:
        return self._request(
            "sendPhoto",
            {},
            (("photo", path, 10 * 1024 * 1024),),
            timeout_seconds,
            wait_rate_limit,
        )

    def send_document(
        self, path: Path, *, timeout_seconds: float, wait_rate_limit: bool = False
    ) -> errors.DeliveryReason | None:
        return self._request(
            "sendDocument",
            {},
            (("document", path, 50 * 1024 * 1024),),
            timeout_seconds,
            wait_rate_limit,
        )

    def send_media_group(
        self,
        paths: tuple[Path, ...],
        *,
        timeout_seconds: float,
        wait_rate_limit: bool = False,
    ) -> errors.DeliveryReason | None:
        paths = tuple(paths)
        names = [f"photo{i}" for i in range(len(paths))]
        media = [{"type": "photo", "media": f"attach://{name}"} for name in names]
        return self._request(
            "sendMediaGroup",
            {"media": json.dumps(media)},
            tuple((name, path, 10 * 1024 * 1024) for name, path in zip(names, paths)),
            timeout_seconds,
            wait_rate_limit,
            too_large=not 2 <= len(paths) <= 10,
        )

    def _request(
        self,
        method,
        payload,
        uploads,
        timeout_seconds,
        wait_rate_limit,
        *,
        too_large=False,
    ):
        try:
            token, chat = self._credentials()
        except Exception as error:  # noqa: BLE001 - 비밀은 예외 클래스만 기록한다
            return self._failed(errors.DeliveryReason.INVALID_CONFIG, error)
        if too_large:
            return self._failed(errors.DeliveryReason.TOO_LARGE)
        try:
            # 지연 import: 표 전용 경로는 HTTP 라이브러리를 로드하지 않는다.
            import requests

            with ExitStack() as stack:
                files = {}
                for name, path, limit in uploads:
                    stream = stack.enter_context(path.open("rb"))
                    if os.fstat(stream.fileno()).st_size > limit:
                        return self._failed(errors.DeliveryReason.TOO_LARGE)
                    files[name] = (path.name, stream)
                payload = {"chat_id": chat, **payload}
                for attempt in range(2):
                    for _, stream in files.values():
                        stream.seek(0)
                    response = (self._session or requests).post(
                        f"{self._api_base}/bot{token}/{method}",
                        **(
                            {"data": payload, "files": files}
                            if files
                            else {"json": payload}
                        ),
                        allow_redirects=False,
                        timeout=(timeout_seconds / 2, timeout_seconds / 2),
                    )
                    status = response.status_code
                    if status == 429:
                        if not wait_rate_limit or attempt:
                            return self._failed(errors.DeliveryReason.RATE_LIMITED)
                        retry_after = None
                        try:
                            retry_after = response.json()["parameters"]["retry_after"]
                        except (ValueError, TypeError, KeyError):
                            pass
                        if (
                            type(retry_after) is int
                            and 0 <= retry_after <= timeout_seconds
                        ):
                            _sleep(retry_after)
                            continue
                        return self._failed(errors.DeliveryReason.RATE_LIMITED)
                    if 400 <= status < 500:
                        return self._failed(errors.DeliveryReason.HTTP_4XX)
                    if not 200 <= status < 300:
                        return self._failed(errors.DeliveryReason.HTTP_5XX)
                    try:
                        data = response.json()
                        if isinstance(data, dict) and data.get("ok") is True:
                            return None
                    except ValueError:
                        pass
                    return self._failed(errors.DeliveryReason.HTTP_5XX)
        except Exception as error:  # noqa: BLE001 - 본문과 비밀은 기록하지 않는다
            return self._failed(errors.DeliveryReason.NETWORK, error)

    @staticmethod
    def _failed(reason, error=None):
        logger.warning(
            "Telegram: %s (%s)", reason.value, type(error).__name__ if error else "-"
        )
        return reason
