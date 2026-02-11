from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Optional, Tuple

import cv2
import numpy as np
import requests

from ai_inference.sources.base import FrameSource


@dataclass
class HttpJpegSource(FrameSource):
    """
    Fallback source: pull single JPEG frames from an HTTP endpoint.

    Expected endpoint types:
    - snapshot URLs returning image/jpeg
    - any URL returning a JPEG image

    This avoids opening the camera twice when the WebRTC publisher already owns /dev/video0.
    """

    url: str
    poll_fps: float = 5.0
    timeout_connect_s: float = 1.0
    timeout_read_s: float = 2.0

    def __post_init__(self) -> None:
        self._next_t = 0.0
        self._rx = 0
        self._last_log = 0.0
        self._last_ok = 0.0
        self._session = requests.Session()
        self._session.headers.update({"User-Agent": "roboviewx-ai-inference/1.0"})

    def read(self) -> Tuple[bool, Optional[np.ndarray]]:
        interval = 1.0 / max(1e-6, float(self.poll_fps))
        now = time.time()
        if self._next_t and now < self._next_t:
            time.sleep(max(0.0, self._next_t - now))
        self._next_t = time.time() + interval

        try:
            r = self._session.get(
                self.url,
                timeout=(self.timeout_connect_s, self.timeout_read_s),
                stream=False,
            )
            if r.status_code != 200:
                return False, None
            data = r.content
            if not data:
                return False, None
            arr = np.frombuffer(data, dtype=np.uint8)
            img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
            if img is None:
                return False, None
            self._rx += 1
            self._last_ok = time.time()
            if self._last_ok - self._last_log > 2.0:
                self._last_log = self._last_ok
                h, w = img.shape[:2]
                print(
                    f"[ai-inference] INFO: rx jpeg frame={w}x{h} total={self._rx} url={self.url}",
                    flush=True,
                )
            return True, img
        except Exception:
            return False, None

    def close(self) -> None:
        try:
            self._session.close()
        except Exception:
            pass
        return

