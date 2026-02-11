from __future__ import annotations

from typing import List, Optional

import numpy as np
from ultralytics import YOLO

from ai_inference.detectors.base import Detector
from ai_inference.types import Detection


class UltralyticsYoloPersonDetector(Detector):
    """
    Ultralytics YOLO(.pt) person-only detector.
    - Filters COCO classId==0 (person)
    - Output boxes in original frame pixel coords (xyxy)
    """

    def __init__(
        self,
        model_path: str,
        conf: float = 0.35,
        iou: float = 0.45,
        imgsz: int = 640,
        device: Optional[str] = None,
    ) -> None:
        self.model_path = model_path
        self.model = YOLO(model_path)
        self.conf = conf
        self.iou = iou
        self.imgsz = imgsz
        self.device = device

    def detect(self, frame_bgr: np.ndarray) -> List[Detection]:
        # Ultralytics accepts numpy arrays (BGR is fine). We run single-image inference.
        results = self.model.predict(
            frame_bgr,
            verbose=False,
            conf=self.conf,
            iou=self.iou,
            imgsz=self.imgsz,
            device=self.device,
            classes=[0],  # person only (COCO class 0)
        )
        if not results:
            return []

        r0 = results[0]
        if r0.boxes is None:
            return []

        dets: List[Detection] = []
        # r0.boxes.xyxy, r0.boxes.conf, r0.boxes.cls
        xyxy = r0.boxes.xyxy.cpu().numpy()
        confs = r0.boxes.conf.cpu().numpy()
        clss = r0.boxes.cls.cpu().numpy()

        for (x1, y1, x2, y2), score, cls in zip(xyxy, confs, clss):
            class_id = int(cls)
            if class_id != 0:
                continue
            dets.append(
                Detection(
                    x1=float(x1),
                    y1=float(y1),
                    x2=float(x2),
                    y2=float(y2),
                    score=float(score),
                    class_id=0,
                    label="person",
                )
            )
        return dets

