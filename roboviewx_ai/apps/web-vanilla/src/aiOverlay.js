/**
 * Client-only AI overlay renderer.
 *
 * - Receives DetectionResult v1 via mediasoup DataChannel (DataConsumer)
 * - Keeps a small ring buffer (latest N) and draws the newest
 * - Draws boxes on an overlay canvas aligned with <video>
 */

/**
 * @param {{
 *   videoEl: HTMLVideoElement,
 *   canvasEl: HTMLCanvasElement,
 *   toggleBtn: HTMLButtonElement,
 *   statusEl: HTMLElement,
 *   robotIdProvider: () => string,
 * }} params
 */
export function createAiOverlay(params) {
  const { videoEl, canvasEl, toggleBtn, statusEl, robotIdProvider } = params;
  const ctx = canvasEl.getContext('2d');
  if (!ctx) throw new Error('Failed to get 2D context for AI overlay canvas');

  let disposed = false;
  let latestMsg = null;
  const rxTimes = [];
  let lastDrawLogMs = 0;
  let lastPushLogMs = 0;
  let pushTotal = 0;
  let pushDropped = 0;

  // Track last known video rect to avoid clearing canvas every frame.
  let lastRectKey = '';

  // ---- Canvas positioning (container-anchored above <video>) ----
  // IMPORTANT:
  // The canvas lives inside the video container which has `overflow-hidden`.
  // If we use `position: fixed` + viewport left/top, the canvas gets clipped
  // by the container and becomes invisible. Keep it `absolute` within the
  // parent container instead.
  const containerEl = videoEl.parentElement || document.body;
  try {
    // Ensure stacking context is sane
    const cs = window.getComputedStyle(containerEl);
    if (cs.position === 'static') {
      containerEl.style.position = 'relative';
    }
  } catch {
    // ignore
  }

  canvasEl.style.position = 'absolute';
  canvasEl.style.left = '0px';
  canvasEl.style.top = '0px';
  canvasEl.style.right = '0px';
  canvasEl.style.bottom = '0px';
  canvasEl.style.zIndex = '50';
  canvasEl.style.pointerEvents = 'none';
  canvasEl.style.opacity = '1';
  canvasEl.style.display = 'block';

  function syncCanvasToVideo() {
    // Size the canvas to the *container* box.
    // (The <video> uses object-contain so the displayed pixels may be letterboxed;
    // we account for that in mapping.)
    const w = Math.max(1, Math.round(containerEl.clientWidth || videoEl.clientWidth || 1));
    const h = Math.max(1, Math.round(containerEl.clientHeight || videoEl.clientHeight || 1));
    const key = `${w},${h}`;
    if (key === lastRectKey) return; // No change; skip (avoids clearing canvas).
    lastRectKey = key;
    canvasEl.width = w;
    canvasEl.height = h;
    canvasEl.style.width = `${w}px`;
    canvasEl.style.height = `${h}px`;
  }

  const ro = new ResizeObserver(syncCanvasToVideo);
  ro.observe(containerEl);
  ro.observe(videoEl);
  window.addEventListener('resize', syncCanvasToVideo);
  syncCanvasToVideo();

  // ---- HUD ----
  function setStatus(text, show) {
    if (!statusEl) return;
    statusEl.textContent = text;
    statusEl.classList.toggle('hidden', !show);
  }

  function updateToggleUi() {
    if (!toggleBtn) return;
    toggleBtn.textContent = `AI Overlay: ON`;
    toggleBtn.className =
      'px-3 py-1.5 rounded text-sm font-medium border transition bg-green-600/90 hover:bg-green-600 border-green-400/60';
  }

  // ---- Message ingestion ----
  function pushDetection(msg) {
    pushTotal++;
    if (!msg || typeof msg !== 'object' || msg.type !== 'detection_v1') {
      pushDropped++;
      return;
    }

    // Accept message regardless of robotId (for debug).
    // If robotId exists and doesn't match, still accept (log once).
    latestMsg = msg;

    const now = Date.now();
    rxTimes.push(now);
    while (rxTimes.length && now - rxTimes[0] > 1000) rxTimes.shift();

    const detCount = Array.isArray(msg.detections) ? msg.detections.length : 0;
    const ageMs = Date.now() - Number(msg.ts_ms || 0);
    const fps = rxTimes.length;
    setStatus(`AI: rx ${fps}fps dets=${detCount} age=${ageMs}ms`, true);

    // Debug log once/sec
    if (now - lastPushLogMs >= 1000) {
      lastPushLogMs = now;
      console.log('[Overlay] pushDetection', { type: msg.type, robotId: msg.robotId, dets: detCount, pushTotal, pushDropped });
    }
  }

  // ---- RAF draw loop ----
  let raf = 0;
  function drawLoop() {
    if (disposed) return;
    raf = window.requestAnimationFrame(drawLoop);

    // Only re-sync position (does NOT clear canvas unless rect changed).
    syncCanvasToVideo();

    const cw = canvasEl.width;
    const ch = canvasEl.height;

    // Clear and redraw every frame.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cw, ch);

    // Debug: thin red border proves canvas is alive + aligned.
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(255, 0, 0, 0.5)';
    ctx.strokeRect(0.5, 0.5, cw - 1, ch - 1);

    if (!latestMsg) return;
    if (!latestMsg.frame?.w || !latestMsg.frame?.h) return;

    const frameW = Number(latestMsg.frame.w);
    const frameH = Number(latestMsg.frame.h);
    // Map bbox pixels (frameW/frameH coords) into the *displayed* video pixels.
    // Since <video> is `object-contain`, the actual displayed image is centered
    // with possible letterboxing within the element box.
    const vidW = Number(videoEl.videoWidth || 0) || frameW;
    const vidH = Number(videoEl.videoHeight || 0) || frameH;
    const scale = Math.min(cw / vidW, ch / vidH);
    const dispW = vidW * scale;
    const dispH = vidH * scale;
    const offX = (cw - dispW) / 2;
    const offY = (ch - dispH) / 2;
    const sx = dispW / frameW;
    const sy = dispH / frameH;

    // Draw detections.
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0, 255, 0, 0.95)';
    ctx.font = '14px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial';

    let drawnCount = 0;
    for (const d of latestMsg.detections || []) {
      if (!d) continue;
      const b = d.bbox;
      if (!b) continue;

      const x1 = offX + Number(b.x1) * sx;
      const y1 = offY + Number(b.y1) * sy;
      const x2 = offX + Number(b.x2) * sx;
      const y2 = offY + Number(b.y2) * sy;
      const bw = Math.max(0, x2 - x1);
      const bh = Math.max(0, y2 - y1);

      ctx.strokeRect(x1, y1, bw, bh);
      drawnCount++;

      const label = `${d.label ?? 'obj'} ${Number(d.score ?? 0).toFixed(2)}`;
      const pad = 4;
      const textW = ctx.measureText(label).width;
      const textH = 16;
      const lx = x1;
      const ly = Math.max(0, y1 - textH - 2);
      ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
      ctx.fillRect(lx, ly, textW + pad * 2, textH);
      ctx.fillStyle = 'rgba(0, 255, 0, 0.95)';
      ctx.fillText(label, lx + pad, ly + 12);
    }

    // Debug log once/sec.
    const now = Date.now();
    if (now - lastDrawLogMs >= 1000) {
      lastDrawLogMs = now;
      const first = (latestMsg.detections || [])[0];
      console.log('[Overlay] draw', {
        cw,
        ch,
        fw: frameW,
        fh: frameH,
        vidW,
        vidH,
        dispW: Math.round(dispW),
        dispH: Math.round(dispH),
        offX: Math.round(offX),
        offY: Math.round(offY),
        sx: sx.toFixed(3),
        sy: sy.toFixed(3),
        drawnCount,
        bbox: first?.bbox,
      });
    }
  }

  // ---- Expose test-draw for DevTools debugging ----
  window.__overlayTestDraw = () => {
    syncCanvasToVideo();
    const cw = canvasEl.width;
    const ch = canvasEl.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.lineWidth = 6;
    ctx.strokeStyle = 'lime';
    ctx.strokeRect(20, 20, cw - 40, ch - 40);
    ctx.fillStyle = 'lime';
    ctx.font = '24px monospace';
    ctx.fillText('TEST DRAW OK', 40, 60);
    console.log('[Overlay] __overlayTestDraw done', { cw, ch });
    // Check if it persists after 1s (RAF will clear it, so this is expected to be cleared).
    setTimeout(() => {
      try {
        const px = ctx.getImageData(25, 25, 1, 1).data;
        console.log('[Overlay] pixel@25,25 after 1s:', px[0], px[1], px[2], px[3], px[1] > 0 ? 'SURVIVED' : 'CLEARED (normal: RAF loop repaints)');
      } catch { /* ignore */ }
    }, 1000);
  };

  // ---- Init ----
  updateToggleUi();
  raf = window.requestAnimationFrame(drawLoop);

  return {
    setEnabled() { /* always on */ },
    pushDetection,
    dispose() {
      disposed = true;
      window.cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener('resize', syncCanvasToVideo);
      latestMsg = null;
    },
  };
}
