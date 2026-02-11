from __future__ import annotations

import asyncio
import json
import os
import signal
import sys
import time
import traceback
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple

from aiortc import (
    RTCConfiguration,
    RTCIceCandidate,
    RTCIceServer,
    RTCPeerConnection,
    RTCSessionDescription,
    RTCRtpSender,
)
from aiortc.contrib.media import MediaPlayer
from aiortc.mediastreams import MediaStreamTrack

try:
    import av  # type: ignore
except Exception:  # pragma: no cover
    av = None  # type: ignore

try:
    # YOLO detector used previously (latest-frame-only + FPS cap).
    from edge_yolo_detector import DETECTOR as YOLO_DETECTOR  # type: ignore
except Exception:
    YOLO_DETECTOR = None  # type: ignore


def _eprint(msg: str) -> None:
    try:
        sys.stderr.write(msg + "\n")
        sys.stderr.flush()
    except Exception:
        pass


def _send(obj: Dict[str, Any]) -> None:
    """Send a control-plane message to Node over stdout (line-delimited JSON)."""
    sys.stdout.write(json.dumps(obj, separators=(",", ":"), ensure_ascii=False) + "\n")
    sys.stdout.flush()


def _now_ms() -> int:
    return int(time.time() * 1000)


def _env_int(key: str, default: int) -> int:
    try:
        return int(os.environ.get(key, str(default)))
    except Exception:
        return default


def _env_float(key: str, default: float) -> float:
    try:
        return float(os.environ.get(key, str(default)))
    except Exception:
        return default


def _parse_edge_video_source(raw: str) -> Tuple[str, Dict[str, str]]:
    """
    Parse EDGE_VIDEO_SOURCE like:
      v4l2:/dev/video0?size=1280x720&fps=30&format=mjpeg
    Returns (device_path, ffmpeg_options)
    """
    raw = (raw or "v4l2:/dev/video0").strip()
    if raw.startswith("v4l2:"):
        rest = raw[5:]
        if "?" in rest:
            path, qs = rest.split("?", 1)
        else:
            path, qs = rest, ""
        device = (path or "/dev/video0").strip()
        opts: Dict[str, str] = {}
        size = None
        fps = None
        fmt = None
        for pair in (qs or "").split("&"):
            if not pair:
                continue
            if "=" in pair:
                k, v = pair.split("=", 1)
            else:
                k, v = pair, ""
            k = k.strip()
            v = v.strip()
            if k == "size" and v:
                size = v
            elif k == "fps" and v:
                fps = v
            elif k == "format" and v:
                fmt = v
        if size:
            opts["video_size"] = size
        if fps:
            opts["framerate"] = fps
        if fmt:
            # v4l2 demuxer option name in ffmpeg
            opts["input_format"] = fmt
        return device, opts
    # fallback: treat raw as device path
    return raw, {}


def _ice_servers_from_env() -> RTCConfiguration:
    """
    ICE_SERVERS_JSON example:
      [{"urls":["stun:stun.l.google.com:19302"]}]
      [{"urls":["turn:turn.example.com:3478"],"username":"u","credential":"p"}]
    """
    raw = (os.environ.get("ICE_SERVERS_JSON") or "").strip()
    if not raw:
        servers = [RTCIceServer(urls=["stun:stun.l.google.com:19302"])]
        return RTCConfiguration(iceServers=servers)
    try:
        arr = json.loads(raw)
        servers: List[RTCIceServer] = []
        for s in arr:
            urls = s.get("urls")
            if isinstance(urls, str):
                urls = [urls]
            if not isinstance(urls, list) or not urls:
                continue
            servers.append(
                RTCIceServer(
                    urls=urls,
                    username=s.get("username"),
                    credential=s.get("credential"),
                )
            )
        if not servers:
            servers = [RTCIceServer(urls=["stun:stun.l.google.com:19302"])]
        return RTCConfiguration(iceServers=servers)
    except Exception as e:
        _eprint(f"[worker] ICE_SERVERS_JSON parse failed: {type(e).__name__}: {e}")
        servers = [RTCIceServer(urls=["stun:stun.l.google.com:19302"])]
        return RTCConfiguration(iceServers=servers)


class TapVideoTrack(MediaStreamTrack):
    kind = "video"

    def __init__(self, source: MediaStreamTrack) -> None:
        super().__init__()  # type: ignore[misc]
        self._source = source
        self._recv_count = 0
        self._submit_count = 0
        self._last_diag = 0.0

    async def recv(self):  # noqa: ANN001
        frame = await self._source.recv()
        self._recv_count += 1
        try:
            if YOLO_DETECTOR is None:
                return frame
            if av is None:
                return frame
            if not isinstance(frame, av.VideoFrame):
                return frame
            if not YOLO_DETECTOR.want_frame():
                return frame
            bgr = frame.to_ndarray(format="bgr24")
            YOLO_DETECTOR.submit_frame_bgr(bgr, ts_ms=_now_ms())
            self._submit_count += 1

            now = time.time()
            if (now - self._last_diag) > 5.0:
                self._last_diag = now
                _eprint(
                    f"[worker] frame tap diag recvCount={self._recv_count} submitCount={self._submit_count} shape={getattr(bgr, 'shape', None)}"
                )
        except Exception:
            # never break the video pipeline
            if int(time.time()) % 5 == 0:
                _eprint("[worker] frame tap error:\n" + traceback.format_exc(limit=2))
        return frame


@dataclass
class _Session:
    pc: RTCPeerConnection
    player: Optional[MediaPlayer]
    ai_dc: Any  # RTCDataChannel | None
    send_task: Optional[asyncio.Task]
    hb_task: Optional[asyncio.Task]


class P2PWorker:
    def __init__(self) -> None:
        self._session: Optional[_Session] = None
        self._candidate_buffer: List[Dict[str, Any]] = []
        self._closing = False
        self._robot_id = os.environ.get("EDGE_ROOM_ID") or os.environ.get("AI_ROBOT_ID") or "robot-001"
        self._send_hz = max(1.0, _env_float("AI_SEND_HZ", 10.0))
        self._ai_enabled = (os.environ.get("AI_ENABLE") or "").lower() in ("1", "true", "yes", "on")
        self._buffered_max = _env_int("AI_BUFFERED_MAX", 262144)
        self._codec = (os.environ.get("P2P_VIDEO_CODEC") or "vp8").lower()

    async def close_session(self) -> None:
        s = self._session
        self._session = None
        self._candidate_buffer = []
        if not s:
            return
        try:
            if s.send_task:
                s.send_task.cancel()
            if s.hb_task:
                s.hb_task.cancel()
        except Exception:
            pass
        try:
            if s.ai_dc:
                try:
                    s.ai_dc.close()
                except Exception:
                    pass
        except Exception:
            pass
        try:
            if s.player:
                try:
                    await s.player.stop()
                except Exception:
                    pass
        except Exception:
            pass
        try:
            await s.pc.close()
        except Exception:
            pass

    def _set_codec_preferences(self, transceiver) -> None:
        try:
            caps = RTCRtpSender.getCapabilities("video")
            codecs = list(caps.codecs or [])
            want = "video/vp8" if self._codec == "vp8" else "video/h264"
            selected = [c for c in codecs if (c.mimeType or "").lower() == want]
            # include RTX for the selected codec if present
            selected_rtx = [c for c in codecs if (c.mimeType or "").lower() == "video/rtx"]
            if selected:
                transceiver.setCodecPreferences(selected + selected_rtx)
                _eprint(f"[worker] codec preferences set: {want} (+rtx={len(selected_rtx)})")
        except Exception as e:
            _eprint(f"[worker] setCodecPreferences failed: {type(e).__name__}: {e}")

    async def _start_session_if_needed(self) -> _Session:
        if self._session:
            return self._session

        pc = RTCPeerConnection(_ice_servers_from_env())
        player = None
        ai_dc = None
        send_task = None
        hb_task = None

        @pc.on("iceconnectionstatechange")  # type: ignore
        async def on_ice() -> None:
            _eprint(f"[worker] iceConnectionState={pc.iceConnectionState}")
            if pc.iceConnectionState in ("failed", "closed", "disconnected"):
                await self.close_session()

        @pc.on("connectionstatechange")  # type: ignore
        async def on_conn() -> None:
            _eprint(f"[worker] connectionState={pc.connectionState}")
            if pc.connectionState in ("failed", "closed", "disconnected"):
                await self.close_session()

        @pc.on("icecandidate")  # type: ignore
        def on_icecandidate(event) -> None:
            cand = event.candidate
            if cand is None:
                return
            try:
                _send(
                    {
                        "type": "iceCandidate",
                        "candidate": {
                            "candidate": cand.to_sdp(),
                            "sdpMid": cand.sdpMid,
                            "sdpMLineIndex": cand.sdpMLineIndex,
                        },
                    }
                )
            except Exception:
                pass

        @pc.on("datachannel")  # type: ignore
        def on_datachannel(channel) -> None:
            nonlocal ai_dc
            _eprint(f"[worker] datachannel label={getattr(channel,'label',None)}")
            if getattr(channel, "label", "") == "ai":
                ai_dc = channel

        # Create 'ai' channel proactively (viewer may also create one; we accept either).
        try:
            ai_dc = pc.createDataChannel("ai")
        except Exception:
            ai_dc = None

        # Create camera track
        src = os.environ.get("EDGE_VIDEO_SOURCE") or "v4l2:/dev/video0"
        device, opts = _parse_edge_video_source(src)
        try:
            player = MediaPlayer(device, format="v4l2", options=opts, decode=True)
        except Exception as e:
            _eprint(f"[worker] MediaPlayer failed: {type(e).__name__}: {e} src={src}")
            raise

        track: MediaStreamTrack = player.video
        if self._ai_enabled and YOLO_DETECTOR is not None:
            track = TapVideoTrack(track)

        transceiver = pc.addTransceiver(track, direction="sendonly")
        self._set_codec_preferences(transceiver)

        # Start AI send loop
        send_task = asyncio.create_task(self._ai_send_loop(lambda: ai_dc))
        hb_task = asyncio.create_task(self._ai_heartbeat_loop(lambda: ai_dc))

        self._session = _Session(pc=pc, player=player, ai_dc=ai_dc, send_task=send_task, hb_task=hb_task)
        return self._session

    async def _ai_heartbeat_loop(self, get_dc) -> None:
        while True:
            await asyncio.sleep(1.0)
            try:
                dc = get_dc()
                if not dc:
                    continue
                if getattr(dc, "readyState", "") != "open":
                    continue
                dc.send(json.dumps({"type": "ai_heartbeat", "ts_ms": _now_ms()}))
            except asyncio.CancelledError:
                return
            except Exception:
                # keep quiet (logs can be noisy)
                continue

    async def _ai_send_loop(self, get_dc) -> None:
        interval = 1.0 / max(1e-6, float(self._send_hz))
        while True:
            try:
                await asyncio.sleep(interval)
                if not self._ai_enabled or YOLO_DETECTOR is None:
                    continue
                latest, err, infer_ms, model_loaded = YOLO_DETECTOR.get_latest()
                dets = latest.get("detections") or []
                fw = int(latest.get("frame_w") or 0)
                fh = int(latest.get("frame_h") or 0)
                frame_id = int(latest.get("frame_id") or 0)
                ts_ms = int(latest.get("ts_ms") or _now_ms())
                if fw <= 0 or fh <= 0:
                    continue

                dc = get_dc()
                if not dc or getattr(dc, "readyState", "") != "open":
                    continue
                buffered = int(getattr(dc, "bufferedAmount", 0) or 0)
                if buffered > self._buffered_max:
                    continue

                out = {
                    "type": "detection_v1",
                    "robotId": self._robot_id,
                    "ts_ms": ts_ms,
                    "frame": {"w": fw, "h": fh, "id": frame_id},
                    "detections": dets,
                }
                dc.send(json.dumps(out, separators=(",", ":"), ensure_ascii=False))
            except asyncio.CancelledError:
                return
            except Exception:
                if int(time.time()) % 2 == 0:
                    _eprint("[worker] ai_send_loop error:\n" + traceback.format_exc(limit=2))

    async def handle_offer(self, sdp: str, sdp_type: str = "offer") -> None:
        s = await self._start_session_if_needed()
        pc = s.pc

        await pc.setRemoteDescription(RTCSessionDescription(sdp=sdp, type=sdp_type))

        # Apply buffered remote candidates if any (browser trickle may arrive early)
        if self._candidate_buffer:
            for c in list(self._candidate_buffer):
                await self._add_ice_candidate(c)
            self._candidate_buffer = []

        answer = await pc.createAnswer()
        await pc.setLocalDescription(answer)
        _send({"type": "answer", "sdp": pc.localDescription.sdp, "sdpType": pc.localDescription.type})

    async def _add_ice_candidate(self, cand: Dict[str, Any]) -> None:
        s = self._session
        if not s:
            self._candidate_buffer.append(cand)
            return
        cstr = cand.get("candidate")
        if not cstr:
            return
        try:
            ice = RTCIceCandidate(
                sdpMid=cand.get("sdpMid"),
                sdpMLineIndex=cand.get("sdpMLineIndex"),
                candidate=cstr,
            )
            await s.pc.addIceCandidate(ice)
        except Exception:
            # ignore invalid candidates
            pass

    async def handle_ice_candidate(self, cand: Dict[str, Any]) -> None:
        await self._add_ice_candidate(cand)

    async def handle_leave(self) -> None:
        await self.close_session()


async def _stdin_loop(worker: P2PWorker) -> None:
    """
    Read JSON lines from Node (stdin).
    Supported messages:
      - {"type":"offer","sdp":"...","sdpType":"offer"}
      - {"type":"iceCandidate","candidate":{...}}
      - {"type":"leave"}
    """
    loop = asyncio.get_running_loop()
    reader = asyncio.StreamReader()
    protocol = asyncio.StreamReaderProtocol(reader)
    await loop.connect_read_pipe(lambda: protocol, sys.stdin)

    while True:
        line = await reader.readline()
        if not line:
            await worker.close_session()
            return
        try:
            msg = json.loads(line.decode("utf-8", errors="ignore").strip())
        except Exception:
            continue
        t = msg.get("type")
        try:
            if t == "offer":
                await worker.handle_offer(msg.get("sdp", ""), msg.get("sdpType", "offer"))
            elif t == "iceCandidate":
                await worker.handle_ice_candidate(msg.get("candidate") or {})
            elif t == "leave":
                await worker.handle_leave()
            elif t == "shutdown":
                await worker.close_session()
                return
        except Exception:
            _eprint("[worker] handle message error:\n" + traceback.format_exc(limit=2))


async def amain() -> None:
    worker = P2PWorker()
    _send({"type": "worker-ready", "pid": os.getpid()})

    stop = asyncio.Event()

    def _sig(_signum, _frame):  # noqa: ANN001
        stop.set()

    signal.signal(signal.SIGINT, _sig)
    signal.signal(signal.SIGTERM, _sig)

    stdin_task = asyncio.create_task(_stdin_loop(worker))
    await stop.wait()
    stdin_task.cancel()
    await worker.close_session()


if __name__ == "__main__":
    try:
        asyncio.run(amain())
    except KeyboardInterrupt:
        pass
