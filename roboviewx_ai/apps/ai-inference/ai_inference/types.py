from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, List, Literal, TypedDict


class BBox(TypedDict):
    x1: float
    y1: float
    x2: float
    y2: float


class DetectionItem(TypedDict):
    label: str
    classId: int
    score: float
    bbox: BBox


class FrameInfo(TypedDict):
    w: int
    h: int


class DetectionV1(TypedDict):
    type: Literal["detection_v1"]
    robotId: str
    ts_ms: int
    frame: FrameInfo
    detections: List[DetectionItem]


@dataclass(frozen=True)
class Detection:
    x1: float
    y1: float
    x2: float
    y2: float
    score: float
    class_id: int
    label: str

    def to_item(self) -> DetectionItem:
        return {
            "label": self.label,
            "classId": int(self.class_id),
            "score": float(self.score),
            "bbox": {"x1": float(self.x1), "y1": float(self.y1), "x2": float(self.x2), "y2": float(self.y2)},
        }

