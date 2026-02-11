from __future__ import annotations

import os
import re
import time
from dataclasses import dataclass
from typing import Optional, Tuple, Union

import cv2
import numpy as np

from ai_inference.sources.base import FrameSource


@dataclass
class OpenCVCaptureSource(FrameSource):
    """
    OpenCV VideoCapture source.

    Supports:
    - device index: "0"
    - device path: "/dev/video0"
    - gstreamer pipeline string (advanced)
    """

    source: Union[int, str]
    width: Optional[int] = None
    height: Optional[int] = None
    fps: Optional[int] = None

    def __post_init__(self) -> None:
        # Robust behavior:
        # - Do not crash if the camera is busy or permissions are missing.
        # - Keep retrying open in read(), with rate-limited logging.
        self.cap: Optional[cv2.VideoCapture] = None
        self._last_warn = 0.0
        self._open_fail_count = 0

    def _warn(self, msg: str) -> None:
        now = time.time()
        if now - self._last_warn > 5.0:
            self._last_warn = now
            print(msg, flush=True)

    def _ensure_open(self) -> bool:
        if self.cap is not None and self.cap.isOpened():
            return True

        # Close previous handle if any
        if self.cap is not None:
            try:
                self.cap.release()
            except Exception:
                pass
            self.cap = None

        backend = None
        src_candidates: list[Union[int, str]] = []

        if isinstance(self.source, str) and self.source.startswith("/dev/video"):
            # Some OpenCV builds warn "can't be used to capture by name" for /dev/videoN strings.
            # Try index N first, then fall back to the path string.
            m = re.match(r"^/dev/video(\d+)$", self.source)
            if m:
                src_candidates.append(int(m.group(1)))
            src_candidates.append(self.source)
            backend = cv2.CAP_V4L2
        else:
            src_candidates.append(self.source)
            if isinstance(self.source, int):
                backend = cv2.CAP_V4L2

        cap = None
        opened = False
        for candidate in src_candidates:
            cap = cv2.VideoCapture(candidate, backend) if backend is not None else cv2.VideoCapture(candidate)
            if cap.isOpened():
                opened = True
                # Track the actual opened source for logs/hints
                self._opened_candidate = candidate
                break
            try:
                cap.release()
            except Exception:
                pass
            cap = None

        if not opened or cap is None:
            self._open_fail_count += 1
            # Provide actionable hints for the common causes.
            if isinstance(self.source, str) and self.source.startswith("/dev/video"):
                can_read = os.access(self.source, os.R_OK)
                hint = "busy (opened by publisher) or permissions"
                if not can_read:
                    hint = "permissions (not in 'video' group?)"
                self._warn(
                    f"[ai-inference] WARN: cannot open {self.source} ({hint}). "
                    f"Retrying... (failCount={self._open_fail_count}) "
                    f"Try '--source jpeg:http://.../snapshot.jpg' or '--source folder:/path' if camera is already in use."
                )
            else:
                self._warn(
                    f"[ai-inference] WARN: cannot open capture source '{self.source}'. "
                    f"Retrying... (failCount={self._open_fail_count})"
                )
            return False

        # Apply requested properties (best effort)
        if self.width:
            cap.set(cv2.CAP_PROP_FRAME_WIDTH, float(self.width))
        if self.height:
            cap.set(cv2.CAP_PROP_FRAME_HEIGHT, float(self.height))
        if self.fps:
            cap.set(cv2.CAP_PROP_FPS, float(self.fps))

        self.cap = cap
        opened_src = getattr(self, "_opened_candidate", self.source)
        self._warn(f"[ai-inference] INFO: capture opened source={opened_src}")
        return True

    def read(self) -> Tuple[bool, Optional[np.ndarray]]:
        if not self._ensure_open():
            # backoff is handled by caller loop sleep
            return False, None
        assert self.cap is not None
        ok, frame = self.cap.read()
        if not ok:
            return False, None
        return True, frame

    def close(self) -> None:
        try:
            if self.cap is not None:
                self.cap.release()
                self.cap = None
        except Exception:
            pass

