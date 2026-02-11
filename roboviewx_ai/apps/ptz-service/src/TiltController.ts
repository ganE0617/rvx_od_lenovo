import { Logger } from '@repo/logger';
import { setUvcPanAbsolute, setUvcTiltAbsolute, setUvcZoomAbsolute } from './uvcControl';

/**
 * PTZ controller - manages PTZ state and hardware interface.
 * Hardware driver: UVC PTZ via v4l2-ctl (pan_absolute / tilt_absolute / zoom_absolute)
 */
export class TiltController {
    private currentPanDeg = 0;
    private currentTiltDeg = 0;
    private currentZoomRatio = 1.0;
    private logger: any;

    // Default logical limits (override via env if your device differs)
    private readonly MIN_PAN = Number(process.env.PTZ_MIN_PAN ?? '-180');
    private readonly MAX_PAN = Number(process.env.PTZ_MAX_PAN ?? '180');
    private readonly MIN_TILT = Number(process.env.PTZ_MIN_TILT ?? '-90');
    private readonly MAX_TILT = Number(process.env.PTZ_MAX_TILT ?? '90');
    private readonly MIN_ZOOM_RATIO = Number(process.env.PTZ_MIN_ZOOM_RATIO ?? '1');
    private readonly MAX_ZOOM_RATIO = Number(process.env.PTZ_MAX_ZOOM_RATIO ?? '3');
    private readonly ZOOM_RAW_MIN = Number(process.env.PTZ_ZOOM_RAW_MIN ?? '0');
    private readonly ZOOM_RAW_MAX = Number(process.env.PTZ_ZOOM_RAW_MAX ?? '100');

    private readonly device =
        process.env.PTZ_DEVICE ?? process.env.TILT_DEVICE ?? '/dev/video0';
    private readonly unitPerDeg = Number(
        process.env.PTZ_UVC_UNIT_PER_DEG ?? process.env.TILT_UVC_UNIT_PER_DEG ?? '3600'
    );

    constructor(logger: Logger) {
        this.logger = logger;
        this.logger.info('Tilt controller initialized');
    }

    public getPtzState(): { pan: number; tilt: number; zoom: number } {
        return {
            pan: this.currentPanDeg,
            tilt: this.currentTiltDeg,
            zoom: this.currentZoomRatio,
        };
    }

    public async setPtz(update: {
        pan?: number;
        tilt?: number;
        zoom?: number;
    }): Promise<{ pan: number; tilt: number; zoom: number }> {
        const nextPan = update.pan;
        const nextTilt = update.tilt;
        const nextZoom = update.zoom;

        // Apply in deterministic order: pan -> tilt -> zoom
        if (nextPan !== undefined) {
            if (!this.isValidPan(nextPan)) {
                throw new Error(
                    `Invalid pan angle: ${nextPan}. Must be between ${this.MIN_PAN} and ${this.MAX_PAN}`
                );
            }
            this.logger.info({ from: this.currentPanDeg, to: nextPan }, 'Setting pan angle');
            const result = await setUvcPanAbsolute({
                device: this.device,
                angleDeg: nextPan,
                minDeg: this.MIN_PAN,
                maxDeg: this.MAX_PAN,
                unitPerDeg: this.unitPerDeg,
            });
            this.currentPanDeg = result.angleDeg;
            this.logger.info({ pan: this.currentPanDeg }, 'Pan angle set');
        }

        if (nextTilt !== undefined) {
            // Reuse existing tilt validation and behavior
            await this.setAngle(nextTilt);
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
            const result = await setUvcZoomAbsolute({
                device: this.device,
                zoomRatio: nextZoom,
                minRatio: this.MIN_ZOOM_RATIO,
                maxRatio: this.MAX_ZOOM_RATIO,
                rawMin: this.ZOOM_RAW_MIN,
                rawMax: this.ZOOM_RAW_MAX,
            });
            this.currentZoomRatio = result.zoomRatio;
            this.logger.info({ zoom: this.currentZoomRatio }, 'Zoom ratio set');
        }

        return this.getPtzState();
    }

    /**
     * Back-compat tilt-only API used by /tilt endpoints.
     * This sets UVC tilt_absolute and updates current tilt state.
     */
    public async setAngle(angle: number): Promise<void> {
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
        const result = await setUvcTiltAbsolute({
            device: this.device,
            angleDeg: angle,
            minDeg: this.MIN_TILT,
            maxDeg: this.MAX_TILT,
            unitPerDeg: this.unitPerDeg,
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
