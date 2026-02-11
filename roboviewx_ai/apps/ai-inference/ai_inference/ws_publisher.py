from __future__ import annotations

import asyncio
import json
import time
from dataclasses import dataclass
from typing import Optional

import websockets

from ai_inference.types import DetectionV1


@dataclass
class WsPublisher:
    """
    WebSocket publisher with:
    - reconnect loop
    - backpressure: 1-slot latest-only queue (drop old)
    - minimal latency (always newest)
    """

    ws_url: str
    max_hz: float = 15.0

    def __post_init__(self) -> None:
        self._latest: Optional[DetectionV1] = None
        self._latest_event = asyncio.Event()
        self._stopped = asyncio.Event()
        self._last_send = 0.0
        self._send_count = 0
        self._last_log = 0.0

    def publish_latest(self, msg: DetectionV1) -> None:
        self._latest = msg
        self._latest_event.set()

    async def stop(self) -> None:
        self._stopped.set()
        self._latest_event.set()

    async def run(self) -> None:
        backoff = 0.25
        while not self._stopped.is_set():
            try:
                async with websockets.connect(self.ws_url, ping_interval=10, ping_timeout=10, max_queue=1) as ws:
                    print(f"[ai-inference] INFO: connected ws_target={self.ws_url}", flush=True)
                    backoff = 0.25
                    await self._pump(ws)
            except asyncio.CancelledError:
                break
            except Exception:
                # log and reconnect
                print(f"[ai-inference] WARN: ws connect/send failed, retrying in {backoff:.2f}s", flush=True)
                # reconnect
                await asyncio.sleep(backoff)
                backoff = min(5.0, backoff * 2)

    async def _pump(self, ws: websockets.WebSocketClientProtocol) -> None:
        min_interval = 1.0 / max(1e-6, self.max_hz)
        while not self._stopped.is_set():
            await self._latest_event.wait()
            self._latest_event.clear()
            if self._stopped.is_set():
                return

            msg = self._latest
            if msg is None:
                continue

            # throttle to max_hz, but always send the newest
            now = time.time()
            dt = now - self._last_send
            if dt < min_interval:
                await asyncio.sleep(min_interval - dt)

            # re-check newest after sleep
            msg = self._latest
            if msg is None:
                continue

            payload = json.dumps(msg, separators=(",", ":"), ensure_ascii=False)
            await ws.send(payload)
            self._last_send = time.time()
            self._send_count += 1

            # rate-limited send log (1/sec)
            now = time.time()
            if now - self._last_log > 1.0:
                self._last_log = now
                rid = msg.get("robotId", "?")
                dets = msg.get("detections", [])
                frame = msg.get("frame", {})
                print(
                    f"[ai-inference] INFO: tx detection_v1 robotId={rid} dets={len(dets) if isinstance(dets, list) else '?'} "
                    f"frame={frame.get('w','?')}x{frame.get('h','?')} sent={self._send_count}",
                    flush=True,
                )

