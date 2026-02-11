from __future__ import annotations

import glob
import os
import time
from dataclasses import dataclass
from typing import Optional, Tuple

import cv2
import numpy as np

from ai_inference.sources.base import FrameSource


@dataclass
class ImageFolderSource(FrameSource):
    """
    Test source: loops images from a folder.
    Useful for development without a camera.
    """

    folder: str
    interval_ms: int = 66  # ~15fps

    def __post_init__(self) -> None:
        patterns = ["*.jpg", "*.jpeg", "*.png", "*.bmp", "*.webp"]
        files: list[str] = []
        for p in patterns:
            files.extend(glob.glob(os.path.join(self.folder, p)))
        files.sort()
        if not files:
            raise RuntimeError(f"No images found in folder: {self.folder}")
        self.files = files
        self.i = 0
        self._last = 0.0

    def read(self) -> Tuple[bool, Optional[np.ndarray]]:
        now = time.time()
        # simple pacing
        if self._last and (now - self._last) * 1000 < self.interval_ms:
            time.sleep(max(0, self.interval_ms / 1000 - (now - self._last)))
        self._last = time.time()

        path = self.files[self.i]
        self.i = (self.i + 1) % len(self.files)
        img = cv2.imread(path)
        if img is None:
            return False, None
        return True, img

    def close(self) -> None:
        return

