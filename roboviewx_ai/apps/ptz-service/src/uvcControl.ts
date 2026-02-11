import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function clamp(v: number, min: number, max: number) {
    return Math.max(min, Math.min(max, v));
}

function clamp01(v: number) {
    return clamp(v, 0, 1);
}

/**
 * MOCK_MODE: Set to true if v4l2-ctl is not available (e.g. developing on Mac)
 */
const MOCK_MODE = process.platform !== 'linux';

async function setUvcControlAbsolute(opts: {
    device: string;
    control: 'pan_absolute' | 'tilt_absolute' | 'zoom_absolute';
    value: number;
}): Promise<void> {
    if (MOCK_MODE) {
        console.log(`[MOCK PTZ] v4l2-ctl -d ${opts.device} -c ${opts.control}=${opts.value}`);
        return;
    }
    // v4l2-ctl -d /dev/videoX -c <control>=<value>
    await execFileAsync('v4l2-ctl', ['-d', opts.device, '-c', `${opts.control}=${opts.value}`], {
        timeout: 2000,
    });
}

export interface UvcAngleAbsoluteOptions {
    device: string; // e.g. /dev/video0
    angleDeg: number; // logical degrees
    minDeg: number;
    maxDeg: number;
    unitPerDeg?: number; // default 3600
}

export async function setUvcTiltAbsolute(
    opts: UvcAngleAbsoluteOptions
): Promise<{ angleDeg: number; rawValue: number }> {
    const unitPerDeg = opts.unitPerDeg ?? 3600;
    const angleDeg = clamp(opts.angleDeg, opts.minDeg, opts.maxDeg);
    const value = Math.round(angleDeg * unitPerDeg);

    await setUvcControlAbsolute({ device: opts.device, control: 'tilt_absolute', value });

    return { angleDeg, rawValue: value };
}

export async function setUvcPanAbsolute(
    opts: UvcAngleAbsoluteOptions
): Promise<{ angleDeg: number; rawValue: number }> {
    const unitPerDeg = opts.unitPerDeg ?? 3600;
    const angleDeg = clamp(opts.angleDeg, opts.minDeg, opts.maxDeg);
    const value = Math.round(angleDeg * unitPerDeg);

    await setUvcControlAbsolute({ device: opts.device, control: 'pan_absolute', value });

    return { angleDeg, rawValue: value };
}

export interface UvcZoomAbsoluteOptions {
    device: string; // e.g. /dev/video0
    zoomRatio: number;
    minRatio: number;
    maxRatio: number;
    rawMin?: number; // default 0
    rawMax?: number; // default 100
}

export async function setUvcZoomAbsolute(
    opts: UvcZoomAbsoluteOptions
): Promise<{ zoomRatio: number; rawValue: number }> {
    const rawMin = opts.rawMin ?? 0;
    const rawMax = opts.rawMax ?? 100;

    const zoomRatio = clamp(opts.zoomRatio, opts.minRatio, opts.maxRatio);
    const denom = opts.maxRatio - opts.minRatio;
    const t = denom === 0 ? 0 : clamp01((zoomRatio - opts.minRatio) / denom);
    const value = Math.round(rawMin + t * (rawMax - rawMin));

    await setUvcControlAbsolute({ device: opts.device, control: 'zoom_absolute', value });

    return { zoomRatio, rawValue: value };
}
