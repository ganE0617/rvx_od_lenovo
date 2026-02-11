# AI Inference Service (server/edge)

Runs **Ultralytics YOLO (.pt)** person detection on frames captured locally (edge/server) and publishes **metadata only** to the media-server.

## Output schema

Publishes JSON messages with schema **DetectionResult v1**:

```json
{
  "type": "detection_v1",
  "robotId": "robot-001",
  "ts_ms": 1730000000000,
  "frame": { "w": 1280, "h": 720 },
  "detections": [
    { "label": "person", "classId": 0, "score": 0.87,
      "bbox": { "x1": 120, "y1": 44, "x2": 420, "y2": 600 } }
  ]
}
```

## Install

```bash
cd apps/ai-inference
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
```

## Run

Capture from a local camera (edge) and publish to media-server:

```bash
python -m ai_inference.main \
  --source /dev/video0 \
  --robot-id robot-001 \
  --ws-target "ws://localhost:3001/ws/ai?robotId=robot-001&role=publisher" \
  --model yolo11n.pt
```

Recommended (no second camera open): pull JPEG snapshots from the edge-agent aiortc worker:

```bash
python -m ai_inference.main \
  --source "jpeg:http://127.0.0.1:8082/snapshot.jpg" \
  --robot-id robot-001 \
  --ws-target "ws://localhost:3001/ws/ai?robotId=robot-001&role=publisher" \
  --poll-fps 5 \
  --conf 0.2 \
  --debug
```

## One-shot snapshot test (debug dets=0)

1) Grab a snapshot JPEG:

```bash
curl -fsS "http://127.0.0.1:8082/snapshot.jpg" --output /tmp/snap.jpg
file /tmp/snap.jpg
```

2) Run YOLO on that file and print number of boxes:

```bash
python - <<'PY'
from ultralytics import YOLO
m = YOLO("yolo11n.pt")
r = m.predict("/tmp/snap.jpg", verbose=False, conf=0.2, iou=0.45, classes=[0])[0]
n = 0 if r.boxes is None else len(r.boxes)
print("person_boxes:", n)
PY
```

Test mode from a folder of images:

```bash
python -m ai_inference.main \
  --source folder:/path/to/images \
  --robot-id robot-001 \
  --ws-target "ws://localhost:3001/ws/ai?robotId=robot-001&role=publisher"
```

## Model swapping

Implement a new `Detector` in `ai_inference/detectors/` and keep the output mapping to `DetectionV1` unchanged.

