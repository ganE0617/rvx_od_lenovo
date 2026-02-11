from __future__ import annotations

import os
import queue
import threading
import time
import traceback
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple

"""
edge_yolo_detector
=================

Runs Ultralytics YOLO (.pt) on raw frames inside the aiortc worker process.

Design goals:
- Latest-frame-only (queue size=1, drop old frames).
- Throttled inference (AI_FPS).
- Stable output (list of detections in ORIGINAL frame coordinates).
- Robust: logs + keeps running on errors.

Env:
- AI_ENABLE=1|0
- AI_MODEL_PATH=.../yolo11n.pt
- AI_FPS=10
- AI_CONF=0.2
- AI_IOU=0.45
- AI_INPUT_W=640 AI_INPUT_H=360
- AI_CLASSES="0" (optional, comma-separated ints; default: "0" person)
"""


AI_ENABLE = os.environ.get("AI_ENABLE", "").lower() in ("1", "true", "yes", "on")


def _env_float(key: str, default: float) -> float:
    try:
        return float(os.environ.get(key, str(default)))
    except Exception:
        return default


def _env_int(key: str, default: int) -> int:
    try:
        return int(os.environ.get(key, str(default)))
    except Exception:
        return default


def _now_ms() -> int:
    return int(time.time() * 1000)


def _parse_classes(raw: str) -> Optional[List[int]]:
    raw = (raw or "").strip()
    if not raw:
        return None
    out: List[int] = []
    for part in raw.split(","):
        p = part.strip()
        if not p:
            continue
        try:
            out.append(int(p))
        except Exception:
            continue
    return out or None


def _log_info(msg: str) -> None:
    # Prefer mediasoup-client-aiortc logger if available; fallback to stderr.
    # Use Logger.warning so messages appear even at default logLevel=warn.
    try:
        from logger import Logger  # type: ignore

        Logger.warning(msg)
        return
    except Exception:
        pass
    try:
        import sys as _sys
        print(msg, file=_sys.stderr, flush=True)
    except Exception:
        pass


@dataclass
class _FrameItem:
    bgr: Any  # numpy ndarray
    ts_ms: int
    frame_id: int
    orig_wh: Tuple[int, int]


class EdgeYoloDetector:
    def __init__(self) -> None:
        self.robot_id = os.environ.get("AI_ROBOT_ID") or os.environ.get("EDGE_ROOM_ID") or "robot-001"
        self.model_path = os.environ.get("AI_MODEL_PATH", "yolo11n.pt")
        self.fps = max(1.0, _env_float("AI_FPS", 10.0))
        self.conf = _env_float("AI_CONF", 0.2)
        self.iou = _env_float("AI_IOU", 0.45)
        self.input_w = max(0, _env_int("AI_INPUT_W", 640))
        self.input_h = max(0, _env_int("AI_INPUT_H", 360))
        self.classes = _parse_classes(os.environ.get("AI_CLASSES", "")) or [0]

        self._stop = threading.Event()
        self._q: "queue.Queue[_FrameItem]" = queue.Queue(maxsize=1)
        self._lock = threading.Lock()
        self._last_accept_s = 0.0
        self._frame_seq = 0

        self._latest: Dict[str, Any] = {
            "ts_ms": 0,
            "frame_id": -1,
            "frame_w": 0,
            "frame_h": 0,
            "detections": [],
        }
        self._last_error: Optional[str] = None
        self._last_infer_ms: int = 0

        self._started = False
        self._thread: Optional[threading.Thread] = None

        self._model = None
        self._model_device: Optional[str] = None
        self._model_loaded = False
        self._has_deps = False

        # log throttles
        self._last_err_log_s = 0.0
        self._last_stats_log_s = 0.0
        self._infer_count = 0
        self._infer_count_window_s = time.time()

        try:
            import cv2  # noqa: F401
            import numpy as np  # noqa: F401
            from ultralytics import YOLO  # noqa: F401

            self._has_deps = True
        except Exception as e:
            self._last_error = f"deps_missing: {e.__class__.__name__}: {e}"

    def start(self) -> None:
        if self._started:
            return
        self._started = True
        if not AI_ENABLE:
            self._last_error = "AI_ENABLE not set"
            return
        if not self._has_deps:
            return
        t = threading.Thread(target=self._loop, name="edge-yolo-detector", daemon=True)
        self._thread = t
        t.start()

    def stop(self) -> None:
        self._stop.set()
        try:
            while True:
                self._q.get_nowait()
        except Exception:
            pass

    def want_frame(self) -> bool:
        if not AI_ENABLE or not self._has_deps:
            return False
        now_s = time.time()
        interval = 1.0 / max(1e-6, self.fps)
        return (not self._last_accept_s) or ((now_s - self._last_accept_s) >= interval)

    def submit_frame_bgr(self, bgr: Any, ts_ms: Optional[int] = None) -> None:
        """
        Called from decode pipeline thread. Must be fast.
        """
        if not AI_ENABLE or not self._has_deps:
            return
        self.start()

        now_s = time.time()
        interval = 1.0 / max(1e-6, self.fps)
        if self._last_accept_s and (now_s - self._last_accept_s) < interval:
            return
        self._last_accept_s = now_s

        self._frame_seq += 1
        frame_id = self._frame_seq
        ts = int(ts_ms) if ts_ms is not None else _now_ms()
        h, w = int(bgr.shape[0]), int(bgr.shape[1])
        item = _FrameItem(bgr=bgr, ts_ms=ts, frame_id=frame_id, orig_wh=(w, h))

        if self._q.full():
            try:
                self._q.get_nowait()
            except Exception:
                pass
        try:
            self._q.put_nowait(item)
        except Exception:
            pass

    def get_latest(self) -> Tuple[Dict[str, Any], Optional[str], int, bool]:
        with self._lock:
            return dict(self._latest), self._last_error, int(self._last_infer_ms), bool(self._model_loaded)

    def _ensure_model(self) -> None:
        if self._model is not None:
            return
        from ultralytics import YOLO

        self._model = YOLO(self.model_path)
        self._model_loaded = True
        try:
            self._model_device = str(getattr(getattr(self._model, "model", None), "device", None))
        except Exception:
            self._model_device = None
        _log_info(f"yolo: model loaded path={self.model_path} device={self._model_device}")

    def _detect(self, frame_bgr: Any, orig_wh: Tuple[int, int]) -> Dict[str, Any]:
        import cv2

        orig_w, orig_h = orig_wh
        inp = frame_bgr
        in_w, in_h = orig_w, orig_h
        if self.input_w and self.input_h and (orig_w != self.input_w or orig_h != self.input_h):
            inp = cv2.resize(inp, (self.input_w, self.input_h), interpolation=cv2.INTER_AREA)
            in_w, in_h = self.input_w, self.input_h

        self._ensure_model()

        results = self._model.predict(  # type: ignore[union-attr]
            inp,
            verbose=False,
            conf=self.conf,
            iou=self.iou,
            imgsz=max(in_w, in_h),
            classes=self.classes,
        )
        r0 = results[0] if results else None

        dets: List[Dict[str, Any]] = []
        if r0 is not None and getattr(r0, "boxes", None) is not None:
            xyxy = r0.boxes.xyxy.cpu().numpy()
            confs = r0.boxes.conf.cpu().numpy()
            clss = r0.boxes.cls.cpu().numpy()
            sx = float(orig_w) / float(in_w)
            sy = float(orig_h) / float(in_h)

            names = None
            try:
                names = getattr(self._model, "names", None)  # type: ignore[union-attr]
            except Exception:
                names = None

            for (x1, y1, x2, y2), score, cls in zip(xyxy, confs, clss):
                cid = int(cls)
                label = "person" if cid == 0 else (str(names.get(cid)) if isinstance(names, dict) and cid in names else f"class_{cid}")
                dets.append(
                    {
                        "label": label,
                        "classId": cid,
                        "score": float(score),
                        "bbox": {
                            "x1": float(x1) * sx,
                            "y1": float(y1) * sy,
                            "x2": float(x2) * sx,
                            "y2": float(y2) * sy,
                        },
                    }
                )

        return {"frame_w": int(orig_w), "frame_h": int(orig_h), "detections": dets}

    def _loop(self) -> None:
        try:
            self._ensure_model()
            with self._lock:
                self._last_error = None
        except Exception as e:
            with self._lock:
                self._last_error = f"model_load_failed: {e.__class__.__name__}: {e}"
            _log_info(f"yolo: model_load_failed: {e.__class__.__name__}: {e}")
            return

        while not self._stop.is_set():
            try:
                item = self._q.get(timeout=0.25)
            except Exception:
                time.sleep(0.01)
                continue

            try:
                t0 = time.time()
                out = self._detect(item.bgr, item.orig_wh)
                infer_ms = int((time.time() - t0) * 1000)

                with self._lock:
                    self._latest = {
                        "ts_ms": int(item.ts_ms),
                        "frame_id": int(item.frame_id),
                        "frame_w": int(out["frame_w"]),
                        "frame_h": int(out["frame_h"]),
                        "detections": out["detections"],
                    }
                    self._last_infer_ms = infer_ms
                    self._last_error = None

                # stats
                self._infer_count += 1
                now_s = time.time()
                if (now_s - self._infer_count_window_s) >= 2.0:
                    dt = max(1e-6, now_s - self._infer_count_window_s)
                    infer_fps = float(self._infer_count) / dt
                    self._infer_count = 0
                    self._infer_count_window_s = now_s
                    if (now_s - self._last_stats_log_s) >= 2.0:
                        self._last_stats_log_s = now_s
                        dets_len = len(out.get("detections") or [])
                        _log_info(f"yolo: stats inferFps={infer_fps:.1f} lastDetsLen={dets_len} lastInferMs={infer_ms}")

            except Exception:
                now_s = time.time()
                err = traceback.format_exc(limit=1).strip()
                with self._lock:
                    self._last_error = err
                if (now_s - self._last_err_log_s) >= 2.0:
                    self._last_err_log_s = now_s
                    _log_info(f"yolo: infer_error: {err}")


DETECTOR = EdgeYoloDetector()

