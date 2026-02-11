import express, { Request, Response, NextFunction } from 'express';
import { Logger } from '@repo/logger';
import { TiltController } from './controller';
import { config } from '../config';

/**
 * REST API server for tilt control
 */
export class TiltServer {
  private app: express.Application;
  private server: any = null;
  private logger: Logger;
  private controller: TiltController;

  constructor(logger: Logger) {
    this.logger = logger;
    this.controller = new TiltController(logger);
    this.app = express();
    this.setupMiddleware();
    this.setupRoutes();
  }

  private setupMiddleware(): void {
    this.app.use(express.json());

    // Logging middleware
    this.app.use((req: Request, res: Response, next: NextFunction) => {
      const meta = {
        method: req.method,
        path: req.path,
        query: req.query,
        ip: req.ip,
        // Common proxy header; useful when behind reverse proxy / ingress.
        xForwardedFor: req.headers['x-forwarded-for'],
        userAgent: req.headers['user-agent'],
      };

      // /tilt is often polled; keep it at debug to avoid noisy logs.
      if (req.method === 'GET' && req.path === '/tilt') {
        this.logger.debug(meta, 'HTTP request');
      } else {
        this.logger.info(meta, 'HTTP request');
      }
      next();
    });
  }

  private setupRoutes(): void {
    // Health check
    this.app.get('/health', (req: Request, res: Response) => {
      res.json({ status: 'ok' });
    });

    // GET /ptz - Get current PTZ state
    this.app.get('/ptz', (req: Request, res: Response) => {
      (async () => {
        try {
          const { state, limits } = await this.controller.getPtzStateFromHardware();
          res.json({ ok: true, state, limits });
        } catch (error) {
        this.logger.error({ error }, 'Error getting PTZ state');
        res.status(500).json({
          error: 'Internal server error',
          message: error instanceof Error ? error.message : 'Unknown error',
        });
        }
      })();
    });

    // POST /ptz - Partial update for pan/tilt/zoom
    this.app.post('/ptz', async (req: Request, res: Response) => {
      try {
        const body = req.body ?? {};
        if (body == null || typeof body !== 'object' || Array.isArray(body)) {
          return res.status(400).json({
            error: 'Bad request',
            message: 'Body must be a JSON object with optional pan/tilt/zoom fields',
          });
        }

        const pan = (body as any).pan;
        const tilt = (body as any).tilt;
        const zoom = (body as any).zoom;

        // Validate types if present
        for (const [k, v] of [
          ['pan', pan],
          ['tilt', tilt],
          ['zoom', zoom],
        ] as const) {
          if (v !== undefined && typeof v !== 'number') {
            return res.status(400).json({
              error: 'Bad request',
              message: `Field "${k}" must be a number`,
            });
          }
        }

        await this.controller.setPtz({
          ...(pan !== undefined ? { pan } : {}),
          ...(tilt !== undefined ? { tilt } : {}),
          ...(zoom !== undefined ? { zoom } : {}),
        });

        // Read back from hardware to return the final applied state (useful when device clamps).
        const { state: hwState, limits } = await this.controller.getPtzStateFromHardware();
        res.json({ ok: true, state: hwState, limits });
      } catch (error) {
        this.logger.error({ error }, 'Error setting PTZ');
        const msg = error instanceof Error ? error.message : 'Unknown error';
        const isClientError =
          msg.startsWith('Invalid ') ||
          msg.startsWith('Unsupported ');
        res.status(isClientError ? 400 : 500).json({
          error: isClientError ? 'Bad request' : 'Internal server error',
          message: msg,
        });
      }
    });

    // GET /tilt - Get current tilt angle
    this.app.get('/tilt', (req: Request, res: Response) => {
      (async () => {
        try {
          const { state, limits } = await this.controller.getPtzStateFromHardware();
          res.json({
            angle: state.tilt,
            min: limits.tilt.min,
            max: limits.tilt.max,
          });
        } catch (error) {
        this.logger.error({ error }, 'Error getting tilt angle');
        res.status(500).json({
          error: 'Internal server error',
          message: error instanceof Error ? error.message : 'Unknown error',
        });
        }
      })();
    });

    // POST /tilt - Set tilt angle
    this.app.post('/tilt', async (req: Request, res: Response) => {
      try {
        const { angle } = req.body;

        if (angle === undefined || angle === null) {
          return res.status(400).json({
            error: 'Bad request',
            message: 'Missing required field: angle',
          });
        }

        if (!this.controller.isValidAngle(angle)) {
          return res.status(400).json({
            error: 'Bad request',
            message: `Invalid angle: ${angle}. Must be between ${this.controller.getMinAngle()} and ${this.controller.getMaxAngle()}`,
          });
        }

        await this.controller.setAngle(angle);
        const { state, limits } = await this.controller.getPtzStateFromHardware();
        res.json({ success: true, angle: state.tilt, min: limits.tilt.min, max: limits.tilt.max });
      } catch (error) {
        this.logger.error({ error }, 'Error setting tilt angle');
        res.status(500).json({
          error: 'Internal server error',
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    });

    // 404 handler
    this.app.use((req: Request, res: Response) => {
      res.status(404).json({
        error: 'Not found',
        message: `Route ${req.method} ${req.path} not found`,
      });
    });

    // Error handler
    this.app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
      this.logger.error({ error: err }, 'Unhandled error');
      res.status(500).json({
        error: 'Internal server error',
        message: err.message,
      });
    });
  }

  public start(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.server = this.app.listen(config.tiltPort, () => {
          this.logger.info({ port: config.tiltPort }, 'Tilt REST server started');
          resolve();
        });

        this.server.on('error', (error: Error) => {
          this.logger.error({ error }, 'Tilt server error');
          reject(error);
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  public stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          this.logger.info('Tilt REST server stopped');
          resolve();
        });
      } else {
        resolve();
      }
    });
  }
}
