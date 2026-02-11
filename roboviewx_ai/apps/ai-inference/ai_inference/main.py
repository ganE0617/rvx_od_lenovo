from __future__ import annotations

import argparse
import asyncio
import signal
import threading
import time
from queue import Queue, Empty
from typing import Optional

import numpy as np

from ai_inference.detectors.ultralytics_yolo import UltralyticsYoloPersonDetector
from ai_inference.sources.image_folder import ImageFolderSource
from ai_inference.sources.http_jpeg import HttpJpegSource
from ai_inference.sources.opencv_capture import OpenCVCaptureSource
from ai_inference.types import DetectionV1
from ai_inference.ws_publisher import WsPublisher


def parse_source(source: str, poll_fps: float):
    # Priority A: direct capture (device index/path)
    # Optional test: folder:/path
    if source.startswith("folder:"):
        folder = source.split("folder:", 1)[1]
        return ImageFolderSource(folder=folder)
    if source.startswith("jpeg:") or source.startswith("snapshot:"):
        url = source.split(":", 1)[1]
        return HttpJpegSource(url=url, poll_fps=poll_fps)
    if source.isdigit():
        return OpenCVCaptureSource(source=int(source))
    return OpenCVCaptureSource(source=source)


def build_detection_message(robot_id: str, frame: np.ndarray, dets) -> DetectionV1:
    h, w = frame.shape[:2]
    return {
        "type": "detection_v1",
        "robotId": robot_id,
        "ts_ms": int(time.time() * 1000),
        "frame": {"w": int(w), "h": int(h)},
        "detections": [d.to_item() for d in dets],
    }


def run_capture_loop(source, latest_q: Queue, stop_evt: threading.Event):
    """
    Capture loop keeps only the newest frame in a 1-slot queue.
    """
    try:
        while not stop_evt.is_set():
            ok, frame = source.read()
            if not ok or frame is None:
                # backoff when source is not ready (camera busy, permission, network, etc.)
                time.sleep(0.10)
                continue

            # Drop old frame if queue full (latest-only)
            if latest_q.full():
                try:
                    latest_q.get_nowait()
                except Empty:
                    pass
            try:
                latest_q.put_nowait(frame)
            except Exception:
                pass
    finally:
        source.close()


async def run_inference(
    robot_id: str,
    source,
    model_path: str,
    ws_target: str,
    conf: float,
    iou: float,
    publish_hz: float,
    device: Optional[str],
    debug: bool,
):
    stop_evt = threading.Event()
    latest_q: Queue = Queue(maxsize=1)

    detector = UltralyticsYoloPersonDetector(
        model_path=model_path,
        conf=conf,
        iou=iou,
        imgsz=640,
        device=device,
    )
    print(
        f"[ai-inference] INFO: loaded model={model_path} conf={conf} iou={iou} device={device or 'auto'}",
        flush=True,
    )

    publisher = WsPublisher(ws_url=ws_target, max_hz=publish_hz)
    pub_task = asyncio.create_task(publisher.run())

    cap_thread = threading.Thread(target=run_capture_loop, args=(source, latest_q, stop_evt), daemon=True)
    cap_thread.start()

    loop = asyncio.get_running_loop()
    stopped = asyncio.Event()

    def _handle_stop(*_):
        stop_evt.set()
        loop.call_soon_threadsafe(stopped.set)

    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            signal.signal(sig, _handle_stop)
        except Exception:
            pass

    try:
        last_frame_w: int = 0
        last_frame_h: int = 0
        last_heartbeat = 0.0
        last_debug = 0.0
        while not stopped.is_set():
            try:
                frame = latest_q.get(timeout=0.1)
            except Empty:
                # Heartbeat: publish "no detections" at ~1Hz so UI can confirm the pipeline is alive.
                now = time.time()
                if now - last_heartbeat > 1.0:
                    last_heartbeat = now
                    publisher.publish_latest(
                        {
                            "type": "detection_v1",
                            "robotId": robot_id,
                            "ts_ms": int(time.time() * 1000),
                            "frame": {"w": int(last_frame_w), "h": int(last_frame_h)},
                            "detections": [],
                        }
                    )
                await asyncio.sleep(0.01)
                continue

            # single-flight detection (one inference at a time)
            h, w = frame.shape[:2]
            last_frame_w, last_frame_h = int(w), int(h)
            dets = detector.detect(frame)
            msg = build_detection_message(robot_id, frame, dets)
            publisher.publish_latest(msg)

            if debug:
                now = time.time()
                if now - last_debug > 5.0:
                    last_debug = now
                    # small diagnostics to explain "dets=0"
                    try:
                        mean = float(frame.mean())
                    except Exception:
                        mean = float("nan")
                    top3 = [
                        {
                            "score": round(float(d.score), 3),
                            "bbox": [int(d.x1), int(d.y1), int(d.x2), int(d.y2)],
                        }
                        for d in dets[:3]
                    ]
                    print(
                        f"[ai-inference] DEBUG: model={model_path} conf={conf} iou={iou} frame={w}x{h} mean={mean:.1f} dets={len(dets)} top3={top3}",
                        flush=True,
                    )
    finally:
        stop_evt.set()
        await publisher.stop()
        pub_task.cancel()
        try:
            await pub_task
        except Exception:
            pass


def main():
    ap = argparse.ArgumentParser(prog="ai-inference")
    ap.add_argument("--source", required=True, help='e.g. "/dev/video0" or "0" or "folder:/path"')
    ap.add_argument("--robot-id", required=True)
    ap.add_argument("--ws-target", required=True, help="e.g. ws://localhost:3001/ws/ai?robotId=robot-001&role=publisher")
    ap.add_argument("--model", default="yolo11n.pt", help="Path to YOLO .pt model")
    ap.add_argument("--conf", type=float, default=0.2)
    ap.add_argument("--iou", type=float, default=0.45)
    ap.add_argument("--publish-hz", type=float, default=15.0)
    ap.add_argument("--poll-fps", type=float, default=5.0, help="Polling FPS for jpeg:http:// sources (default 5)")
    ap.add_argument("--device", default=None, help='e.g. "cpu" or "0" for GPU if available')
    ap.add_argument("--debug", action="store_true", help="Log frame stats + top detections every 5s")
    args = ap.parse_args()

    source = parse_source(args.source, poll_fps=args.poll_fps)

    asyncio.run(
        run_inference(
            robot_id=args.robot_id,
            source=source,
            model_path=args.model,
            ws_target=args.ws_target,
            conf=args.conf,
            iou=args.iou,
            publish_hz=args.publish_hz,
            device=args.device,
            debug=args.debug,
        )
    )


if __name__ == "__main__":
    main()

