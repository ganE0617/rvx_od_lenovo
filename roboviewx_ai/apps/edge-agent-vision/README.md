# edge-agent-vision (Python)

This folder exists to keep **edge inference logic** out of `node_modules`.

In the current integration, the edge aiortc worker imports:
- `edge_ai_detector.py` from `roboviewx_ai_rp/apps/edge-agent/python/`

If you want to relocate the detector into this app, move the module here and ensure the edge-agent sets `PYTHONPATH` to include this directory (already supported by `apps/edge-agent/src/rtc/setAiortcPythonEnv.ts`).

Environment variables (edge-agent):
- `AI_ENABLE=1`
- `AI_MODEL_PATH=/path/to/yolo11n.pt`
- `AI_FPS=10`
- `AI_SEND_HZ=12`
- `AI_CONF=0.2`
- `AI_IOU=0.45`
- `AI_INPUT_W=640` `AI_INPUT_H=360`

