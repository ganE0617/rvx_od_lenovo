import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v));
}

function clamp01(v: number) {
  return clamp(v, 0, 1);
}

type UvcControlName = 'pan_absolute' | 'tilt_absolute' | 'zoom_absolute';

async function setUvcControlAbsolute(opts: {
  device: string;
  control: UvcControlName;
  value: number;
}): Promise<void> {
  // v4l2-ctl -d /dev/videoX -c <control>=<value>
  await execFileAsync('v4l2-ctl', ['-d', opts.device, '-c', `${opts.control}=${opts.value}`], {
    timeout: 2000,
  });
}

export interface UvcControlInfo {
  name: UvcControlName;
  min: number;
  max: number;
  step: number;
  default: number;
}

// Cache ranges per (device, control) to avoid repeated execs.
// NOTE: current values should be read from hardware (do not cache values).
const controlInfoCache = new Map<string, UvcControlInfo>();

/**
 * Parse control info from `v4l2-ctl --list-ctrls` output.
 * Example line:
 *   zoom_absolute 0x009a090d (int)    : min=100 max=400 step=1 default=100 value=100
 */
export async function getUvcControlInfo(opts: {
  device: string;
  control: UvcControlName;
}): Promise<UvcControlInfo> {
  const key = `${opts.device}::${opts.control}`;
  const cached = controlInfoCache.get(key);
  if (cached) return cached;

  const { stdout } = await execFileAsync('v4l2-ctl', ['-d', opts.device, '--list-ctrls'], {
    timeout: 2000,
  });
  const text = String(stdout ?? '');
  const lines = text.split('\n');
  const line = lines.find((l) => l.trimStart().startsWith(opts.control));
  if (!line) {
    throw new Error(`UVC control not found: ${opts.control} on ${opts.device}`);
  }

  const m = line.match(
    new RegExp(
      // allow trailing fields like "value=..." and flags
      String.raw`^\s*(${opts.control})\b.*?:\s*min=(-?\d+)\s+max=(-?\d+)\s+step=(-?\d+)\s+default=(-?\d+)\b.*$`
    )
  );
  if (!m) {
    throw new Error(`Failed to parse v4l2-ctl control line: ${line}`);
  }

  const info: UvcControlInfo = {
    name: opts.control,
    min: Number(m[2]),
    max: Number(m[3]),
    step: Number(m[4]),
    default: Number(m[5]),
  };
  controlInfoCache.set(key, info);
  return info;
}

export interface UvcControlValues {
  pan_absolute?: number;
  tilt_absolute?: number;
  zoom_absolute?: number;
}

/**
 * Read current control values from hardware.
 * Uses a single v4l2-ctl call: --get-ctrl=pan_absolute,tilt_absolute,zoom_absolute
 */
export async function getUvcControlValues(opts: {
  device: string;
  controls: UvcControlName[];
}): Promise<UvcControlValues> {
  const arg = `--get-ctrl=${opts.controls.join(',')}`;
  const { stdout } = await execFileAsync('v4l2-ctl', ['-d', opts.device, arg], {
    timeout: 2000,
  });
  const text = String(stdout ?? '');
  const out: UvcControlValues = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([a-z_]+)\s*:\s*(-?\d+)\s*$/);
    if (!m) continue;
    const name = m[1] as UvcControlName;
    const value = Number(m[2]);
    if (opts.controls.includes(name)) {
      (out as any)[name] = value;
    }
  }
  return out;
}

/**
 * UVC PTZ angle controls often use "degrees * 3600" units (1/3600 deg) for *_absolute.
 * This may vary by device/driver. Verify ranges with: v4l2-ctl -d /dev/videoX --all
 */
export interface UvcAngleAbsoluteOptions {
  device: string; // e.g. /dev/video0
  angleDeg: number; // logical degrees
  minDeg: number;
  maxDeg: number;
  unitPerDeg?: number; // default 3600
}

/**
 * Set UVC tilt using v4l2-ctl.
 *
 * Many UVC drivers use "degrees * 3600" units (1/3600 deg) for tilt_absolute.
 */
export async function setUvcTiltAbsolute(
  opts: UvcAngleAbsoluteOptions
): Promise<{ angleDeg: number; rawValue: number }> {
  const unitPerDeg = opts.unitPerDeg ?? 3600;
  const angleDeg = clamp(opts.angleDeg, opts.minDeg, opts.maxDeg);
  let value = Math.round(angleDeg * unitPerDeg);

  // Clamp/snap to actual driver range/step to avoid "Numerical result out of range".
  const info = await getUvcControlInfo({ device: opts.device, control: 'tilt_absolute' });
  value = clamp(value, info.min, info.max);
  if (info.step > 0) {
    value = info.min + Math.round((value - info.min) / info.step) * info.step;
    value = clamp(value, info.min, info.max);
  }

  await setUvcControlAbsolute({ device: opts.device, control: 'tilt_absolute', value });

  return { angleDeg: value / unitPerDeg, rawValue: value };
}

/**
 * Set UVC pan using v4l2-ctl (pan_absolute).
 */
export async function setUvcPanAbsolute(
  opts: UvcAngleAbsoluteOptions
): Promise<{ angleDeg: number; rawValue: number }> {
  const unitPerDeg = opts.unitPerDeg ?? 3600;
  const angleDeg = clamp(opts.angleDeg, opts.minDeg, opts.maxDeg);
  let value = Math.round(angleDeg * unitPerDeg);

  // Clamp/snap to actual driver range/step to avoid "Numerical result out of range".
  const info = await getUvcControlInfo({ device: opts.device, control: 'pan_absolute' });
  value = clamp(value, info.min, info.max);
  if (info.step > 0) {
    value = info.min + Math.round((value - info.min) / info.step) * info.step;
    value = clamp(value, info.min, info.max);
  }

  await setUvcControlAbsolute({ device: opts.device, control: 'pan_absolute', value });

  return { angleDeg: value / unitPerDeg, rawValue: value };
}

export interface UvcZoomAbsoluteOptions {
  device: string; // e.g. /dev/video0
  /**
   * Logical zoom ratio. Example: 1.0 = wide, 2.0 = 2x, etc.
   * (This is mapped linearly into raw units.)
   */
  zoomRatio: number;
  minRatio: number;
  maxRatio: number;
  /**
   * Raw zoom_absolute units range for the device/driver.
   * If unknown, check with: v4l2-ctl -d /dev/videoX --all
   *
   * If not provided, we will auto-detect from `v4l2-ctl --list-ctrls`.
   */
  rawMin?: number;
  rawMax?: number;
}

/**
 * Set UVC zoom using v4l2-ctl (zoom_absolute).
 *
 * UVC zoom_absolute is typically an integer in a device-specific range.
 * We accept a logical zoomRatio and map it linearly into [rawMin, rawMax].
 */
export async function setUvcZoomAbsolute(
  opts: UvcZoomAbsoluteOptions
): Promise<{ zoomRatio: number; rawValue: number }> {
  let rawMin = opts.rawMin;
  let rawMax = opts.rawMax;
  if (rawMin === undefined || rawMax === undefined) {
    const info = await getUvcControlInfo({ device: opts.device, control: 'zoom_absolute' });
    rawMin = info.min;
    rawMax = info.max;
  }

  const zoomRatio = clamp(opts.zoomRatio, opts.minRatio, opts.maxRatio);
  const denom = opts.maxRatio - opts.minRatio;
  const t = denom === 0 ? 0 : clamp01((zoomRatio - opts.minRatio) / denom);
  const value = Math.round((rawMin as number) + t * ((rawMax as number) - (rawMin as number)));

  await setUvcControlAbsolute({ device: opts.device, control: 'zoom_absolute', value });

  return { zoomRatio, rawValue: value };
}

