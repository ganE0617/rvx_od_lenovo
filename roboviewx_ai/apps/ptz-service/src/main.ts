import express from 'express';
import { createLogger } from '@repo/logger';
import { TiltController } from './TiltController';

const app = express();
app.use(express.json());

const PORT = 8080;
const logger = createLogger('ptz-service');
const controller = new TiltController(logger);

app.get('/ptz', (req, res) => {
    const state = controller.getPtzState();
    res.json({
        ok: true,
        state: {
            ...state,
            minPan: -180,
            maxPan: 180,
            minTilt: -90,
            maxTilt: 90,
            minZoom: 1.0,
            maxZoom: 3.0
        }
    });
});

app.post('/ptz', async (req, res) => {
    try {
        const { pan, tilt, zoom } = req.body;
        const newState = await controller.setPtz({ pan, tilt, zoom });
        res.json({ ok: true, state: newState });
    } catch (err: any) {
        logger.error(`PTZ update failed: ${err.message}`);
        res.status(400).json({ ok: false, error: err.message });
    }
});

// Back-compat for /tilt endpoints if needed
app.post('/tilt', async (req, res) => {
    try {
        const { angle } = req.body;
        await controller.setAngle(angle);
        res.json({ ok: true, angle: controller.getAngle() });
    } catch (err: any) {
        res.status(400).json({ ok: false, error: err.message });
    }
});

app.listen(PORT, () => {
    logger.info(`PTZ Service listening on port ${PORT}`);
});
