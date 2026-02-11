import express from 'express';
import 'reflect-metadata';
import { createLogger } from '@repo/logger';

const app = express();
const logger = createLogger('storage-service');
const port = process.env.PORT || 3002;

app.get('/', (req, res) => {
    res.send('Storage Service is running');
});

app.listen(port, () => {
    logger.info(`Storage Service listening on port ${port}`);
});
