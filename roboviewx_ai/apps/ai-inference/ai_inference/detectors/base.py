from __future__ import annotations

from abc import ABC, abstractmethod
from typing import List

import numpy as np

from ai_inference.types import Detection


class Detector(ABC):
    """
    Detector interface for future model swaps.

    Contract:
    - input: a single BGR frame (H,W,3) uint8
    - output: list of Detection in ORIGINAL frame pixel coordinates
    """

    @abstractmethod
    def detect(self, frame_bgr: np.ndarray) -> List[Detection]:
        raise NotImplementedError

