from __future__ import annotations

import json
import os
import queue
import threading
import time
import traceback
from dataclasses import dataclass
from typing import Any, Dict, Optional, Tuple

"""
edge_ai_detector
================

Runs person detection on raw frames inside the aiortc worker process.

Design goals:
- Never block the WebRTC media pipeline.
- Latest-frame-only semantics (1-slot queue, drop old frames).
- Output stable, model-agnostic `detection_v1` JSON.
- Allow downscaled inference while mapping bbox coords back to original frame size.
- Safe when deps are missing: AI simply stays disabled and video continues.

Env (inherited from edge-agent Node process):
- AI_ENABLE=1|0
- AI_MODEL_PATH=.../yolo11n.pt
- AI_FPS=10
- AI_CONF=0.2
- AI_IOU=0.45
- AI_INPUT_W=640 AI_INPUT_H=360
- AI_SEND_HZ=12
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


@dataclass
class _FrameItem:
    bgr: Any  # numpy ndarray
    ts_ms: int
    frame_id: int
    orig_wh: Tuple[int, int]


class EdgeAIDetector:
    def __init__(self) -> None:
        self.robot_id = os.environ.get("AI_ROBOT_ID") or os.environ.get("EDGE_ROOM_ID") or "robot-001"
        self.model_path = os.environ.get("AI_MODEL_PATH", "yolo11n.pt")
        self.fps = max(1.0, _env_float("AI_FPS", 10.0))
        self.send_hz = max(1.0, _env_float("AI_SEND_HZ", min(15.0, self.fps)))
        self.conf = _env_float("AI_CONF", 0.2)
        self.iou = _env_float("AI_IOU", 0.45)
        self.input_w = max(0, _env_int("AI_INPUT_W", 640))
        self.input_h = max(0, _env_int("AI_INPUT_H", 360))

        self._stop = threading.Event()
        self._q: "queue.Queue[_FrameItem]" = queue.Queue(maxsize=1)
        self._lock = threading.Lock()
        self._last_accept_s = 0.0
        self._frame_seq = 0

        self._latest_json: Optional[str] = None
        self._latest_frame_id: int = -1
        self._latest_ts_ms: int = 0

        self._last_error: Optional[str] = None
        self._started = False
        self._thread: Optional[threading.Thread] = None

        self._model = None
        self._has_deps = False

        # Diagnostics
        self._last_infer_ms: int = 0
        self._model_info: Optional[Dict[str, Any]] = None
        self._last_health_log_s: float = 0.0

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
        t = threading.Thread(target=self._loop, name="edge-ai-detector", daemon=True)
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

    def get_latest_json(self) -> Tuple[Optional[str], int, int, Optional[str]]:
        with self._lock:
            return self._latest_json, self._latest_frame_id, self._latest_ts_ms, self._last_error

    def get_diag(self) -> Dict[str, Any]:
        with self._lock:
            return {
                "robotId": self.robot_id,
                "modelPath": self.model_path,
                "conf": self.conf,
                "iou": self.iou,
                "inputW": self.input_w,
                "inputH": self.input_h,
                "fps": self.fps,
                "sendHz": self.send_hz,
                "lastInferMs": self._last_infer_ms,
                "modelInfo": self._model_info,
                "lastError": self._last_error,
                "latestFrameId": self._latest_frame_id,
                "latestTsMs": self._latest_ts_ms,
            }

    def _ensure_model(self) -> None:
        if self._model is not None:
            return
        from ultralytics import YOLO

        self._model = YOLO(self.model_path)
        # Best-effort model/device info (varies by ultralytics version)
        try:
            device = None
            try:
                device = str(getattr(getattr(self._model, "model", None), "device", None))
            except Exception:
                device = None
            self._model_info = {
                "type": str(type(self._model).__name__),
                "device": device,
            }
        except Exception:
            self._model_info = {"type": str(type(self._model).__name__)}

    def _detect_person(self, frame_bgr: Any, orig_wh: Tuple[int, int]) -> Dict[str, Any]:
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
            classes=[0],  # person
        )
        r0 = results[0] if results else None
        dets = []
        if r0 is not None and getattr(r0, "boxes", None) is not None:
            xyxy = r0.boxes.xyxy.cpu().numpy()
            confs = r0.boxes.conf.cpu().numpy()
            clss = r0.boxes.cls.cpu().numpy()
            sx = float(orig_w) / float(in_w)
            sy = float(orig_h) / float(in_h)
            for (x1, y1, x2, y2), score, cls in zip(xyxy, confs, clss):
                if int(cls) != 0:
                    continue
                dets.append(
                    {
                        "label": "person",
                        "classId": 0,
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
        # Preload model (may be expensive) in this background thread.
        try:
            self._ensure_model()
            with self._lock:
                self._last_error = None
        except Exception as e:
            with self._lock:
                self._last_error = f"model_load_failed: {e.__class__.__name__}: {e}"
            return

        interval = 1.0 / max(1e-6, self.fps)
        while not self._stop.is_set():
            try:
                item = self._q.get(timeout=0.25)
            except Exception:
                time.sleep(0.01)
                continue

            try:
                t0 = time.time()
                out = self._detect_person(item.bgr, item.orig_wh)
                infer_ms = int((time.time() - t0) * 1000)
                msg: Dict[str, Any] = {
                    "type": "detection_v1",
                    "robotId": self.robot_id,
                    "ts_ms": int(item.ts_ms),
                    "frame": {"w": int(out["frame_w"]), "h": int(out["frame_h"]), "id": int(item.frame_id)},
                    "detections": out["detections"],
                }
                s = json.dumps(msg, separators=(",", ":"), ensure_ascii=False)
                with self._lock:
                    self._latest_json = s
                    self._latest_frame_id = int(item.frame_id)
                    self._latest_ts_ms = int(item.ts_ms)
                    self._last_infer_ms = infer_ms
                    self._last_error = None
            except Exception:
                err = traceback.format_exc(limit=1).strip()
                with self._lock:
                    self._last_error = err
            finally:
                # Prevent tight loop even if frames arrive very fast
                time.sleep(max(0.0, interval * 0.05))


DETECTOR = EdgeAIDetector()

