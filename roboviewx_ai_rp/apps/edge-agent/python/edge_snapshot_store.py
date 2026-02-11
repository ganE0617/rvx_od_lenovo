from __future__ import annotations

import os
import threading
import time
import traceback
from dataclasses import dataclass
from typing import Any, Dict, Optional, Tuple

try:
    import cv2  # type: ignore
    import numpy as np  # type: ignore
    _HAS_CV2 = True
except Exception:  # pragma: no cover
    cv2 = None  # type: ignore
    np = None  # type: ignore
    _HAS_CV2 = False

"""
edge_snapshot_store
===================

Critical design goals:
- Do NOT open the camera device (no /dev/video0 access).
- Accept RAW frames already decoded in the aiortc MediaPlayer decode pipeline.
- Never block the WebRTC pipeline thread with JPEG encoding.
- Background encoder thread keeps latest JPEG bytes ("last frame only", no queues).
- Strong rate limits and failure backoff to avoid destabilizing WebRTC.

This module is imported by the aiortc Python worker via PYTHONPATH injected from the edge-agent Node process.
"""


def _clamp_int(v: int, lo: int, hi: int) -> int:
    return max(lo, min(hi, int(v)))


@dataclass
class SnapshotStatus:
    ok: bool
    pid: int
    hasFrame: bool
    lastFrameTsMs: Optional[int]
    lastJpegTsMs: Optional[int]
    jpegBytes: int
    framesInTotal: int
    encodeOkTotal: int
    encodeFailTotal: int
    lastEncodeError: Optional[str]
    source: str
    port: int
    encoderFps: float
    lastRawShape: Optional[Tuple[int, int, int]]
    lastRawType: Optional[str]

    def to_dict(self) -> Dict[str, Any]:
        return {
            "ok": self.ok,
            "pid": self.pid,
            "hasFrame": self.hasFrame,
            "lastFrameTsMs": self.lastFrameTsMs,
            "lastJpegTsMs": self.lastJpegTsMs,
            "jpegBytes": self.jpegBytes,
            "framesInTotal": self.framesInTotal,
            "encodeOkTotal": self.encodeOkTotal,
            "encodeFailTotal": self.encodeFailTotal,
            "lastEncodeError": self.lastEncodeError,
            "source": self.source,
            "port": self.port,
            "encoderFps": self.encoderFps,
            "lastRawShape": list(self.lastRawShape) if self.lastRawShape else None,
            "lastRawType": self.lastRawType,
        }


class SnapshotStore:
    def __init__(self) -> None:
        self._lock = threading.Lock()

        # config
        self._port = int(os.environ.get("AIORTC_SNAPSHOT_PORT", "8082"))
        self._fps = float(os.environ.get("AIORTC_SNAPSHOT_FPS", "5"))  # safer default than 12
        self._quality = _clamp_int(int(os.environ.get("AIORTC_SNAPSHOT_QUALITY", "80")), 1, 100)
        self._target_w = int(os.environ.get("AIORTC_SNAPSHOT_W", "0"))
        self._target_h = int(os.environ.get("AIORTC_SNAPSHOT_H", "0"))

        self._source: str = ""

        # raw frame buffer (BGR uint8)
        self._raw_bgr = None  # type: ignore[assignment]
        self._last_raw_ts_ms: Optional[int] = None
        self._frames_in_total = 0
        self._last_raw_shape: Optional[Tuple[int, int, int]] = None
        self._last_raw_type: Optional[str] = None

        # cached jpeg
        self._jpeg: Optional[bytes] = None
        self._last_jpeg_ts_ms: Optional[int] = None
        self._jpeg_w: int = 0
        self._jpeg_h: int = 0

        # encode stats
        self._encode_ok_total = 0
        self._encode_fail_total = 0
        self._last_encode_error: Optional[str] = None
        self._consecutive_fail = 0
        self._pause_until_s: float = 0.0

        # encoder control
        self._stopped = threading.Event()
        self._encoder_thread: Optional[threading.Thread] = None
        self._wake = threading.Event()
        self._last_encode_raw_ts_ms: Optional[int] = None
        self._last_accept_s: float = 0.0

        # dynamic request size (for non-blocking on-demand resize)
        self._req_w: int = 0
        self._req_h: int = 0

    def ensure_started(self) -> None:
        if self._encoder_thread and self._encoder_thread.is_alive():
            return
        t = threading.Thread(target=self._encoder_loop, name="snapshot-encoder", daemon=True)
        self._encoder_thread = t
        t.start()

    def stop(self) -> None:
        self._stopped.set()
        self._wake.set()

    def set_source(self, s: str) -> None:
        with self._lock:
            if s and not self._source:
                self._source = s

    def request_size(self, w: int, h: int) -> None:
        w = int(w or 0)
        h = int(h or 0)
        if w and not h:
            h = w
        if h and not w:
            w = h
        w = _clamp_int(w, 0, 4096)
        h = _clamp_int(h, 0, 4096)
        with self._lock:
            self._req_w = w
            self._req_h = h
        self._wake.set()

    def update_raw_frame_bgr(self, bgr: np.ndarray) -> None:
        """
        Called from the decode pipeline.
        Must be fast: only stores the latest raw frame and timestamp.
        """
        if not _HAS_CV2:
            # Do not crash the worker if OpenCV isn't installed; just disable snapshotting.
            with self._lock:
                self._frames_in_total += 1
                self._last_encode_error = "OpenCV (cv2) not available in this Python environment"
            return
        self.ensure_started()
        now_s = time.time()
        # Hard rate-limit raw copies/conversion to configured fps (protect WebRTC thread).
        min_interval = 1.0 / max(1e-6, float(self._fps))
        if self._last_accept_s and (now_s - self._last_accept_s) < min_interval:
            with self._lock:
                self._frames_in_total += 1
                self._last_raw_ts_ms = int(now_s * 1000)
                self._last_raw_shape = tuple(bgr.shape)  # type: ignore[arg-type]
                self._last_raw_type = str(bgr.dtype)
            return
        self._last_accept_s = now_s
        ts_ms = int(time.time() * 1000)
        # Copy is required: underlying buffers may be reused downstream.
        with self._lock:
            self._frames_in_total += 1
            self._last_raw_ts_ms = ts_ms
            self._last_raw_shape = tuple(bgr.shape)  # type: ignore[arg-type]
            self._last_raw_type = str(bgr.dtype)
            self._raw_bgr = bgr.copy()
            self._wake.set()

    def want_frame(self) -> bool:
        """
        Fast check used in the decode thread to avoid converting every VideoFrame to ndarray.
        """
        if not _HAS_CV2:
            return False
        now_s = time.time()
        min_interval = 1.0 / max(1e-6, float(self._fps))
        return (not self._last_accept_s) or ((now_s - self._last_accept_s) >= min_interval)

    def get_cached_jpeg(self) -> Optional[bytes]:
        with self._lock:
            return self._jpeg

    def jpeg_meta(self) -> Dict[str, Any]:
        with self._lock:
            jb = len(self._jpeg) if self._jpeg else 0
            return {"w": self._jpeg_w, "h": self._jpeg_h, "ts_ms": self._last_jpeg_ts_ms, "bytes": jb}

    def status(self, pid: int) -> SnapshotStatus:
        with self._lock:
            jb = len(self._jpeg) if self._jpeg else 0
            return SnapshotStatus(
                ok=True,
                pid=pid,
                hasFrame=self._raw_bgr is not None,
                lastFrameTsMs=self._last_raw_ts_ms,
                lastJpegTsMs=self._last_jpeg_ts_ms,
                jpegBytes=jb,
                framesInTotal=self._frames_in_total,
                encodeOkTotal=self._encode_ok_total,
                encodeFailTotal=self._encode_fail_total,
                lastEncodeError=self._last_encode_error,
                source=self._source,
                port=self._port,
                encoderFps=float(self._fps),
                lastRawShape=self._last_raw_shape,
                lastRawType=self._last_raw_type,
            )

    def _choose_target_size(self) -> Tuple[int, int]:
        # priority: requested size -> configured target size -> original size
        with self._lock:
            rw, rh = self._req_w, self._req_h
            cw, ch = self._target_w, self._target_h
        if rw and rh:
            return rw, rh
        if cw and ch:
            return cw, ch
        return 0, 0

    def _encoder_loop(self) -> None:
        interval = 1.0 / max(1e-6, self._fps)
        while not self._stopped.is_set():
            # wait for new raw or next tick
            self._wake.wait(timeout=interval)
            self._wake.clear()

            if self._stopped.is_set():
                return

            now_s = time.time()
            if self._pause_until_s and now_s < self._pause_until_s:
                time.sleep(0.05)
                continue

            with self._lock:
                raw = self._raw_bgr
                raw_ts = self._last_raw_ts_ms

            if raw is None or raw_ts is None:
                time.sleep(0.05)
                continue

            # Only encode if we haven't encoded this raw timestamp
            if self._last_encode_raw_ts_ms == raw_ts and self.get_cached_jpeg():
                continue

            if not _HAS_CV2:
                with self._lock:
                    self._last_encode_error = "OpenCV (cv2) not available in this Python environment"
                time.sleep(1.0)
                continue

            tw, th = self._choose_target_size()
            try:
                img = raw
                if tw and th:
                    img = cv2.resize(img, (tw, th), interpolation=cv2.INTER_AREA)  # type: ignore[union-attr]
                ok, buf = cv2.imencode(  # type: ignore[union-attr]
                    ".jpg",
                    img,
                    [int(cv2.IMWRITE_JPEG_QUALITY), int(self._quality)],  # type: ignore[union-attr]
                )
                if not ok:
                    raise RuntimeError("cv2.imencode returned ok=False")
                jpeg = bytes(buf)
                with self._lock:
                    self._jpeg = jpeg
                    self._last_jpeg_ts_ms = int(time.time() * 1000)
                    self._jpeg_w = int(img.shape[1])
                    self._jpeg_h = int(img.shape[0])
                    self._encode_ok_total += 1
                    self._last_encode_error = None
                    self._consecutive_fail = 0
                    self._last_encode_raw_ts_ms = raw_ts
                # throttle
                time.sleep(max(0.0, interval * 0.2))
            except Exception:
                err = traceback.format_exc(limit=1).strip()
                with self._lock:
                    self._encode_fail_total += 1
                    self._last_encode_error = err
                    self._consecutive_fail += 1
                # Backoff to protect WebRTC if encoding is failing repeatedly
                if self._consecutive_fail >= 5:
                    self._pause_until_s = time.time() + 2.0
                    time.sleep(0.1)


STORE = SnapshotStore()

