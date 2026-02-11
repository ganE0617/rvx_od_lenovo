import { P2PViewer } from './viewer.js';
import { UI } from './ui.js';
import { PtzController } from './ptzController.js';
import { MotClient } from './mot.js';
import { createAiOverlay } from './aiOverlay.js';

// Environment variables
// P2P signaling is WebSocket to edge-agent (e.g. ws://localhost:8082/ws)
const SIGNALING_URL = import.meta.env.VITE_SIGNALING_URL || 'ws://localhost:8082/ws';
const DEFAULT_ROOM_ID = import.meta.env.VITE_DEFAULT_ROOM_ID || 'robot-001';

// Generate unique peer ID
const PEER_ID = `viewer-${Date.now()}`;

// Initialize UI
const ui = new UI();
ui.init(SIGNALING_URL, DEFAULT_ROOM_ID, PEER_ID);

// Initialize viewer
const viewer = new P2PViewer(SIGNALING_URL);

// Initialize AI overlay (server/edge inference; default OFF)
const aiOverlay = createAiOverlay({
    videoEl: document.getElementById('video-element'),
    canvasEl: document.getElementById('ai-overlay'),
    toggleBtn: document.getElementById('ai-toggle'),
    statusEl: document.getElementById('ai-status'),
    robotIdProvider: () => ui.getRoomId(),
});

// Wire up viewer callbacks
viewer.onStatusChange = (status) => {
    ui.updateStatus(status);
    // Safety: if stream stops, disable detection so it doesn't waste CPU
    if (status !== 'PLAYING') {
        aiOverlay.setEnabled(false);
    }
};

viewer.onError = (error) => {
    ui.showError(error);
};

viewer.onVideoTrack = (mediaStream) => {
    ui.attachVideoTrack(mediaStream);
};

// Wire AI detections (DataChannel) -> overlay
viewer.onAiDetection = (msg) => {
    aiOverlay.pushDetection(msg);
};

// Connect handler
ui.onConnect(async () => {
    const roomId = ui.getRoomId();
    ui.showError(null);
    ui.clearVideo();

    // Update PTZ controller with new roomId
    ptzController.roomId = roomId;
    ptzController.baseUrl = `/api/robots/${roomId}/ptz`;
    ptzController.loadPersistedStatus();
    ui.updatePtzUI(ptzController.status);
    await ptzController.fetchStatus();

    try {
        await viewer.connect(roomId, PEER_ID);
    } catch (error) {
        // viewer.onError will surface the error; avoid crashing on null rpcClient
        return;
    }
});

// Disconnect handler
ui.onDisconnect(() => {
    viewer.disconnect();
    ui.showError(null);
    ui.clearVideo();
});

// Cleanup on page unload
window.addEventListener('beforeunload', () => {
    viewer.disconnect();
    aiOverlay.dispose();
});

// Initialize PTZ Controller
const ptzController = new PtzController(DEFAULT_ROOM_ID);

// Initialize MOT Client (optional)
const MOT_WS_URL = import.meta.env.VITE_MOT_WS_URL || 'ws://localhost:8080';
const MOT_ENABLED = (import.meta.env.VITE_MOT_ENABLED ?? 'true') !== 'false';
if (MOT_ENABLED) {
    const motClient = new MotClient(MOT_WS_URL);
    motClient.init(
        document.getElementById('mot-overlay'),
        document.getElementById('video-element')
    );
} else {
    console.log('[MOT] Disabled by VITE_MOT_ENABLED');
}

// Wire up PTZ callbacks
ptzController.onUpdate = (status) => {
    ui.updatePtzUI(status);
    ui.showPtzStatus(ptzController.isUpdating ? 'Updating...' : 'Ready');
    ui.setPtzLoading(ptzController.isUpdating);
};

ptzController.onError = (error) => {
    ui.showPtzStatus(`Error: ${error}`, true);
    ui.setPtzLoading(false);
};

// Start PTZ control
ptzController.init();
ui.updatePtzUI(ptzController.status);

// UI PTZ Events
ui.onPtzChange(async (updates) => {
    try {
        ui.showPtzStatus('Sending...');
        ui.setPtzLoading(true);
        await ptzController.updatePtz(updates);
    } catch (e) {
        // Error handled by ptzController.onError
    }
});

console.log('[App] Initialized');
