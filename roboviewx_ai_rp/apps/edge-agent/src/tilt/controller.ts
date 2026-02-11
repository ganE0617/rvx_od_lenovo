import { Logger } from '@repo/logger';
import {
  getUvcControlInfo,
  getUvcControlValues,
  setUvcPanAbsolute,
  setUvcTiltAbsolute,
  setUvcZoomAbsolute,
} from './uvcV4l2';
import { readdirSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * PTZ controller - manages PTZ state and hardware interface.
 * Hardware driver: UVC PTZ via v4l2-ctl (pan_absolute / tilt_absolute / zoom_absolute)
 */
export class TiltController {
  private currentPanDeg = 0;
  private currentTiltDeg = 0;
  private currentZoomRatio = 1.0;
  private logger: Logger;

  // Some devices expose UVC pan/tilt controls but reject writes (ERANGE).
  // Track write support based on observed behavior so the UI can disable controls.
  private panWriteSupported: boolean | null = null;
  private tiltWriteSupported: boolean | null = null;
  private zoomWriteSupported: boolean | null = true;

  // Default logical limits (override via env if your device differs)
  private readonly MIN_PAN = Number(process.env.PTZ_MIN_PAN ?? '-180');
  private readonly MAX_PAN = Number(process.env.PTZ_MAX_PAN ?? '180');
  private readonly MIN_TILT = Number(process.env.PTZ_MIN_TILT ?? '-90');
  private readonly MAX_TILT = Number(process.env.PTZ_MAX_TILT ?? '90');
  private readonly MIN_ZOOM_RATIO = Number(process.env.PTZ_MIN_ZOOM_RATIO ?? '1');
  // For many webcams, zoom_absolute range resembles 100..400 (1x..4x). Default to 4x.
  private readonly MAX_ZOOM_RATIO = Number(process.env.PTZ_MAX_ZOOM_RATIO ?? '4');
  private readonly ZOOM_RAW_MIN =
    process.env.PTZ_ZOOM_RAW_MIN !== undefined ? Number(process.env.PTZ_ZOOM_RAW_MIN) : undefined;
  private readonly ZOOM_RAW_MAX =
    process.env.PTZ_ZOOM_RAW_MAX !== undefined ? Number(process.env.PTZ_ZOOM_RAW_MAX) : undefined;

  private device =
    process.env.PTZ_DEVICE ?? process.env.TILT_DEVICE ?? '/dev/video0';
  private readonly deviceExplicit =
    process.env.PTZ_DEVICE !== undefined || process.env.TILT_DEVICE !== undefined;
  private readonly unitPerDeg = Number(
    process.env.PTZ_UVC_UNIT_PER_DEG ?? process.env.TILT_UVC_UNIT_PER_DEG ?? '3600'
  );
  private readonly unitPerDegExplicit =
    process.env.PTZ_UVC_UNIT_PER_DEG !== undefined ||
    process.env.TILT_UVC_UNIT_PER_DEG !== undefined;

  constructor(logger: Logger) {
    this.logger = logger;
    this.logger.info('Tilt controller initialized');
  }

  private async autoDetectPtzDevice(): Promise<string> {
    if (this.deviceExplicit) return this.device;
    // Scan /dev/video* and pick first node that advertises pan/tilt/zoom absolute controls.
    let candidates: string[] = [];
    try {
      candidates = readdirSync('/dev')
        .filter((n) => n.startsWith('video'))
        .map((n) => `/dev/${n}`)
        .sort();
    } catch {
      candidates = ['/dev/video0'];
    }

    for (const d of candidates) {
      try {
        const { stdout } = await execFileAsync('v4l2-ctl', ['-d', d, '-L'], { timeout: 1500 });
        const text = String(stdout ?? '');
        const hasPan = text.includes('pan_absolute');
        const hasTilt = text.includes('tilt_absolute');
        const hasZoom = text.includes('zoom_absolute');
        if (hasPan && hasTilt && hasZoom) {
          if (d !== this.device) {
            this.logger.info({ device: d }, '[PTZ] Auto-detected PTZ device');
          }
          this.device = d;
          return d;
        }
      } catch {
        // ignore nodes that cannot be queried
      }
    }

    // Fallback
    this.logger.warn({ fallback: this.device }, '[PTZ] PTZ device auto-detect failed; using fallback');
    return this.device;
  }

  private clamp01(v: number): number {
    return Math.max(0, Math.min(1, v));
  }

  /**
   * UVC pan/tilt absolute controls are commonly expressed in units of 1/3600 degree.
   * Many devices explicitly report `step=3600` for *_absolute, which is the most reliable
   * way to derive the unit scale. Avoid inferring from min/max because some drivers
   * can report inconsistent logical ranges.
   */
  private unitPerDegFor(info: { step: number }): number {
    if (this.unitPerDegExplicit && isFinite(this.unitPerDeg) && this.unitPerDeg > 0) {
      return this.unitPerDeg;
    }
    const s = Number(info.step);
    if (isFinite(s) && s > 0) return Math.abs(s);
    return isFinite(this.unitPerDeg) && this.unitPerDeg > 0 ? this.unitPerDeg : 3600;
  }

  private clamp(v: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, v));
  }

  private intersectRange(a: { min: number; max: number }, b: { min: number; max: number }): {
    min: number;
    max: number;
  } {
    return { min: Math.max(a.min, b.min), max: Math.min(a.max, b.max) };
  }

  /**
   * Read PTZ from hardware every time (recommended).
   * Returns logical pan/tilt degrees and zoom ratio, plus min/max derived from driver.
   */
  public async getPtzStateFromHardware(): Promise<{
    state: { pan: number; tilt: number; zoom: number };
    limits: {
      pan: { min: number; max: number };
      tilt: { min: number; max: number };
      zoom: { min: number; max: number };
      supported: { pan: boolean; tilt: boolean; zoom: boolean };
      raw: {
        pan: { min: number; max: number };
        tilt: { min: number; max: number };
        zoom: { min: number; max: number };
      };
    };
  }> {
    await this.autoDetectPtzDevice();
    const [panInfo, tiltInfo, zoomInfo, values] = await Promise.all([
      getUvcControlInfo({ device: this.device, control: 'pan_absolute' }),
      getUvcControlInfo({ device: this.device, control: 'tilt_absolute' }),
      getUvcControlInfo({ device: this.device, control: 'zoom_absolute' }),
      getUvcControlValues({
        device: this.device,
        controls: ['pan_absolute', 'tilt_absolute', 'zoom_absolute'],
      }),
    ]);

    const unitPan = this.unitPerDegFor(panInfo);
    const unitTilt = this.unitPerDegFor(tiltInfo);

    let rawPan = values.pan_absolute ?? 0;
    let rawTilt = values.tilt_absolute ?? 0;
    const rawZoom = values.zoom_absolute ?? zoomInfo.min;

    // Some drivers (or certain v4l2-ctl outputs) can show absurd current values.
    // Clamp raw values into the advertised range before converting to degrees.
    if (rawPan < panInfo.min || rawPan > panInfo.max) {
      this.logger.warn({ rawPan, min: panInfo.min, max: panInfo.max }, '[PTZ] pan raw out of range; clamping');
      rawPan = this.clamp(rawPan, panInfo.min, panInfo.max);
    }
    if (rawTilt < tiltInfo.min || rawTilt > tiltInfo.max) {
      this.logger.warn({ rawTilt, min: tiltInfo.min, max: tiltInfo.max }, '[PTZ] tilt raw out of range; clamping');
      rawTilt = this.clamp(rawTilt, tiltInfo.min, tiltInfo.max);
    }

    // IMPORTANT:
    // - "readable" is not a reliable signal for capability (some drivers report garbage values).
    // - "supported" should mean "writes are supported", and must only become false when we have
    //   explicit evidence (ERANGE/driver rejection) from a write attempt.
    const panSupported = this.panWriteSupported !== false;
    const tiltSupported = this.tiltWriteSupported !== false;
    const zoomSupported = this.zoomWriteSupported !== false;

    const pan = rawPan / unitPan;
    const tilt = rawTilt / unitTilt;
    // If unsupported, emit 0 so UI doesn't show absurd values.
    const panOut = panSupported ? this.clamp(pan, this.MIN_PAN, this.MAX_PAN) : 0;
    const tiltOut = tiltSupported ? this.clamp(tilt, this.MIN_TILT, this.MAX_TILT) : 0;

    // Map raw zoom into logical ratio range [MIN_ZOOM_RATIO, MAX_ZOOM_RATIO]
    const rawZoomMin = zoomInfo.min;
    const rawZoomMax = zoomInfo.max;
    const denom = rawZoomMax - rawZoomMin;
    const t = denom === 0 ? 0 : this.clamp01((rawZoom - rawZoomMin) / denom);
    const zoom =
      this.MIN_ZOOM_RATIO + t * (this.MAX_ZOOM_RATIO - this.MIN_ZOOM_RATIO);

    // Update in-memory snapshot (do not treat as source of truth).
    // If the device reports garbage/out-of-range raw values, keep last known good values.
    this.currentPanDeg = panSupported ? panOut : this.currentPanDeg;
    this.currentTiltDeg = tiltSupported ? tiltOut : this.currentTiltDeg;
    this.currentZoomRatio = zoom;

    return {
      state: { pan: panOut, tilt: tiltOut, zoom },
      limits: {
        pan: {
          min: this.clamp(panInfo.min / unitPan, this.MIN_PAN, this.MAX_PAN),
          max: this.clamp(panInfo.max / unitPan, this.MIN_PAN, this.MAX_PAN),
        },
        tilt: {
          min: this.clamp(tiltInfo.min / unitTilt, this.MIN_TILT, this.MAX_TILT),
          max: this.clamp(tiltInfo.max / unitTilt, this.MIN_TILT, this.MAX_TILT),
        },
        zoom: { min: this.MIN_ZOOM_RATIO, max: this.MAX_ZOOM_RATIO },
        supported: { pan: panSupported, tilt: tiltSupported, zoom: zoomSupported },
        raw: {
          pan: { min: panInfo.min, max: panInfo.max },
          tilt: { min: tiltInfo.min, max: tiltInfo.max },
          zoom: { min: zoomInfo.min, max: zoomInfo.max },
        },
      },
    };
  }

  public getPtzState(): { pan: number; tilt: number; zoom: number } {
    // Legacy synchronous snapshot (may be stale after reboot/reconnect).
    return { pan: this.currentPanDeg, tilt: this.currentTiltDeg, zoom: this.currentZoomRatio };
  }

  public async setPtz(update: {
    pan?: number;
    tilt?: number;
    zoom?: number;
  }): Promise<{ pan: number; tilt: number; zoom: number }> {
    // Refresh snapshot so logs show correct "from" values.
    try {
      await this.getPtzStateFromHardware();
    } catch (e) {
      this.logger.warn({ error: e }, 'Failed to refresh PTZ state from hardware (continuing)');
    }

    const nextPan = update.pan;
    const nextTilt = update.tilt;
    const nextZoom = update.zoom;

    // Load driver ranges so we clamp to hardware-supported values (prevents v4l2 out-of-range).
    await this.autoDetectPtzDevice();
    const [panInfo, tiltInfo] = await Promise.all([
      getUvcControlInfo({ device: this.device, control: 'pan_absolute' }),
      getUvcControlInfo({ device: this.device, control: 'tilt_absolute' }),
    ]);
    const unitPan = this.unitPerDegFor(panInfo);
    const unitTilt = this.unitPerDegFor(tiltInfo);
    const panRange = this.intersectRange(
      { min: this.MIN_PAN, max: this.MAX_PAN },
      { min: panInfo.min / unitPan, max: panInfo.max / unitPan }
    );
    const tiltRange = this.intersectRange(
      { min: this.MIN_TILT, max: this.MAX_TILT },
      { min: tiltInfo.min / unitTilt, max: tiltInfo.max / unitTilt }
    );

    // Apply in deterministic order: pan -> tilt -> zoom
    if (nextPan !== undefined) {
      if (this.panWriteSupported === false) {
        throw new Error('Unsupported PTZ control: pan (pan_absolute write rejected by driver)');
      }
      if (typeof nextPan !== 'number' || isNaN(nextPan) || nextPan < panRange.min || nextPan > panRange.max) {
        throw new Error(
          `Invalid pan angle: ${nextPan}. Must be between ${panRange.min} and ${panRange.max} (device + env)`
        );
      }
      this.logger.info({ from: this.currentPanDeg, to: nextPan }, 'Setting pan angle');
      try {
        const result = await setUvcPanAbsolute({
          device: this.device,
          angleDeg: nextPan,
          minDeg: panRange.min,
          maxDeg: panRange.max,
          unitPerDeg: unitPan,
        });
        this.currentPanDeg = result.angleDeg;
        this.logger.info({ pan: this.currentPanDeg }, 'Pan angle set');
      } catch (e: any) {
        const msg = String(e?.stderr ?? e?.message ?? e);
        if (msg.includes('Numerical result out of range')) {
          this.panWriteSupported = false;
          throw new Error('Unsupported PTZ control: pan (driver returns ERANGE on write)');
        }
        throw e;
      }
    }

    if (nextTilt !== undefined) {
      if (this.tiltWriteSupported === false) {
        throw new Error('Unsupported PTZ control: tilt (tilt_absolute write rejected by driver)');
      }
      if (typeof nextTilt !== 'number' || isNaN(nextTilt) || nextTilt < tiltRange.min || nextTilt > tiltRange.max) {
        throw new Error(
          `Invalid tilt angle: ${nextTilt}. Must be between ${tiltRange.min} and ${tiltRange.max} (device + env)`
        );
      }
      this.logger.info(
        { from: this.currentTiltDeg, to: nextTilt },
        'Setting tilt angle'
      );
      try {
        const result = await setUvcTiltAbsolute({
          device: this.device,
          angleDeg: nextTilt,
          minDeg: tiltRange.min,
          maxDeg: tiltRange.max,
          unitPerDeg: unitTilt,
        });
        this.currentTiltDeg = result.angleDeg;
        this.logger.info({ angle: this.currentTiltDeg }, 'Tilt angle set');
      } catch (e: any) {
        const msg = String(e?.stderr ?? e?.message ?? e);
        if (msg.includes('Numerical result out of range')) {
          this.tiltWriteSupported = false;
          throw new Error('Unsupported PTZ control: tilt (driver returns ERANGE on write)');
        }
        throw e;
      }
    }

    if (nextZoom !== undefined) {
      if (!this.isValidZoom(nextZoom)) {
        throw new Error(
          `Invalid zoom ratio: ${nextZoom}. Must be between ${this.MIN_ZOOM_RATIO} and ${this.MAX_ZOOM_RATIO}`
        );
      }
      this.logger.info(
        { from: this.currentZoomRatio, to: nextZoom },
        'Setting zoom ratio'
      );
      try {
        const result = await setUvcZoomAbsolute({
          device: this.device,
          zoomRatio: nextZoom,
          minRatio: this.MIN_ZOOM_RATIO,
          maxRatio: this.MAX_ZOOM_RATIO,
          ...(this.ZOOM_RAW_MIN !== undefined ? { rawMin: this.ZOOM_RAW_MIN } : {}),
          ...(this.ZOOM_RAW_MAX !== undefined ? { rawMax: this.ZOOM_RAW_MAX } : {}),
        });
        this.currentZoomRatio = result.zoomRatio;
        this.logger.info(
          { zoom: this.currentZoomRatio, rawValue: result.rawValue },
          'Zoom ratio set'
        );
      } catch (e: any) {
        const msg = String(e?.stderr ?? e?.message ?? e);
        if (msg.includes('Numerical result out of range')) {
          this.zoomWriteSupported = false;
        }
        throw e;
      }
    }

    return this.getPtzState();
  }

  /**
   * Back-compat tilt-only API used by /tilt endpoints.
   * This sets UVC tilt_absolute and updates current tilt state.
   */
  public async setAngle(angle: number): Promise<void> {
    // Refresh snapshot for accurate "from" logging.
    try {
      await this.getPtzStateFromHardware();
    } catch (e) {
      this.logger.warn({ error: e }, 'Failed to refresh PTZ state from hardware (continuing)');
    }

    // Keep legacy API but validate against env range only.
    if (!this.isValidAngle(angle)) {
      throw new Error(
        `Invalid tilt angle: ${angle}. Must be between ${this.MIN_TILT} and ${this.MAX_TILT}`
      );
    }

    this.logger.info(
      { from: this.currentTiltDeg, to: angle },
      'Setting tilt angle'
    );

    // Send command to actual hardware (UVC tilt_absolute via v4l2-ctl)
    const tiltInfo = await getUvcControlInfo({ device: this.device, control: 'tilt_absolute' });
    const unitTilt = this.unitPerDegFor(tiltInfo);
    const result = await setUvcTiltAbsolute({
      device: this.device,
      angleDeg: angle,
      minDeg: this.MIN_TILT,
      maxDeg: this.MAX_TILT,
      unitPerDeg: unitTilt,
    });

    // Update state only after successful hardware call
    this.currentTiltDeg = result.angleDeg;

    this.logger.info({ angle: this.currentTiltDeg }, 'Tilt angle set');
  }

  public getAngle(): number {
    return this.currentTiltDeg;
  }

  public isValidAngle(angle: number): boolean {
    return (
      typeof angle === 'number' &&
      !isNaN(angle) &&
      angle >= this.MIN_TILT &&
      angle <= this.MAX_TILT
    );
  }

  public isValidPan(angle: number): boolean {
    return (
      typeof angle === 'number' &&
      !isNaN(angle) &&
      angle >= this.MIN_PAN &&
      angle <= this.MAX_PAN
    );
  }

  public isValidZoom(zoomRatio: number): boolean {
    return (
      typeof zoomRatio === 'number' &&
      !isNaN(zoomRatio) &&
      zoomRatio >= this.MIN_ZOOM_RATIO &&
      zoomRatio <= this.MAX_ZOOM_RATIO
    );
  }

  public getMinAngle(): number {
    return this.MIN_TILT;
  }

  public getMaxAngle(): number {
    return this.MAX_TILT;
  }
}
