/**
 * Handles communication with the PTZ proxy API
 */
export class PtzController {
    constructor(roomId) {
        this.roomId = roomId;
        this.baseUrl = `/api/robots/${roomId}/ptz`;
        this.status = {
            pan: 0,
            tilt: 0,
            zoom: 1.0
        };
        this.lastSentPtz = { pan: 0, tilt: 0, zoom: 1.0 };
        this.isUpdating = false;
        this.lastInteractionTime = 0;
        this.pollingInterval = null;
        this.fetchInFlight = false;

        // Load persisted status if available
        this.loadPersistedStatus();

        // Callbacks
        this.onUpdate = null;
        this.onError = null;
    }

    async init() {
        await this.fetchStatus();
        this.startPolling();
    }

    async fetchStatus() {
        if (this.fetchInFlight) return;
        this.fetchInFlight = true;
        try {
            const startTime = Date.now();
            const response = await fetch(this.baseUrl);
            const fetchTime = Date.now() - startTime;
            
            if (!response.ok) {
                console.error(`[PTZ] Fetch failed: ${response.status} ${response.statusText} (${fetchTime}ms) URL: ${this.baseUrl}`);
                if (this.onError) this.onError(`Failed to fetch PTZ status: ${response.status}`);
                return { ok: false, state: null, error: `HTTP ${response.status}` };
            }
            
            const data = await response.json();
            if (data?.ok === false) {
                if (this.onError) this.onError(data.error || 'PTZ unreachable');
                return data;
            }
            if (fetchTime > 500) {
                console.warn(`[PTZ] Slow fetch: ${fetchTime}ms`);
            }

            const isCoolingDown = Date.now() - this.lastInteractionTime < 5000;

            if (!this.isUpdating && !isCoolingDown) {
                this.status = {
                    pan: data.pan ?? 0,
                    tilt: data.tilt ?? 0,
                    zoom: data.zoom ?? 1.0,
                    // Optional metadata (passed through from edge-agent via media-server)
                    supported: data.supported ?? data.limits?.supported,
                    limits: data.limits ?? {
                        pan: { min: data.minPan, max: data.maxPan },
                        tilt: { min: data.minTilt, max: data.maxTilt },
                        zoom: { min: data.minZoom, max: data.maxZoom },
                    },
                };
                this.persistStatus();
                this.lastSentPtz = { ...this.status };
                if (this.onUpdate) this.onUpdate(this.status);
            }
            return data;
        } catch (error) {
            console.error('[PTZ] Fetch error:', error.message, 'URL:', this.baseUrl);
            if (this.onError) this.onError(error.message);
            return { ok: false, state: null, error: error.message };
        } finally {
            this.fetchInFlight = false;
        }
    }

    async updatePtz(updates) {
        this.lastInteractionTime = Date.now();
        // Merge updates with local state for immediate feedback
        this.status = { ...this.status, ...updates };
        this.persistStatus();

        // Debounce-like handling logic should be in main.js or here
        // For Vanilla, we'll do a simple check.

        this.isUpdating = true;
        try {
            const response = await fetch(this.baseUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(updates)
            });

            const data = await response.json();
            if (!response.ok || data?.ok === false) {
                const errMsg =
                    data?.detail
                        ? `PTZ failed (status=${data?.status ?? response.status}, reason=${data?.reason ?? 'unknown'}): ${data.detail}`
                        : (data?.error || `Failed to update PTZ (${response.status})`);
                if (this.onError) this.onError(errMsg);
                return { ok: false, state: null, error: errMsg };
            }
            // Server might return full or partial
            if (data.pan !== undefined) this.status.pan = data.pan;
            if (data.tilt !== undefined) this.status.tilt = data.tilt;
            if (data.zoom !== undefined) this.status.zoom = data.zoom;
            if (data.supported !== undefined) this.status.supported = data.supported;
            if (data.limits !== undefined) this.status.limits = data.limits;

            this.lastSentPtz = { ...this.status };
            if (this.onUpdate) this.onUpdate(this.status);
            return data;
        } catch (error) {
            console.error('[PTZ] Update error:', error);
            if (this.onError) this.onError(error.message);
            return { ok: false, state: null, error: error.message };
        } finally {
            this.isUpdating = false;
        }
    }

    updateFromSync(data) {
        const isCoolingDown = Date.now() - this.lastInteractionTime < 5000;

        if (!this.isUpdating && !isCoolingDown) {
            console.log('[PTZ] Syncing from server:', data);
            this.status = {
                pan: data.pan ?? this.status.pan,
                tilt: data.tilt ?? this.status.tilt,
                zoom: data.zoom ?? this.status.zoom
            };
            this.persistStatus();
            if (this.onUpdate) this.onUpdate(this.status);
        }
    }

    startPolling() {
        if (this.pollingInterval) clearInterval(this.pollingInterval);
        // CRITICAL: Increased interval to 30s to reduce event loop blocking
        // PTZ state is also pushed from server via WebSocket, so polling is just backup
        this.pollingInterval = setInterval(() => {
            if (!this.isUpdating) {
                this.fetchStatus();
            }
        }, 30000); // Increased from 5s to 30s
    }

    stopPolling() {
        if (this.pollingInterval) {
            clearInterval(this.pollingInterval);
            this.pollingInterval = null;
        }
    }

    persistStatus() {
        try {
            localStorage.setItem(`ptz_state_${this.roomId}`, JSON.stringify(this.status));
        } catch (e) {
            console.warn('[PTZ] Failed to persist status:', e);
        }
    }

    loadPersistedStatus() {
        try {
            const saved = localStorage.getItem(`ptz_state_${this.roomId}`);
            if (saved) {
                const parsed = JSON.parse(saved);
                this.status = {
                    pan: parsed.pan ?? 0,
                    tilt: parsed.tilt ?? 0,
                    zoom: parsed.zoom ?? 1.0
                };
            }
        } catch (e) {
            console.warn('[PTZ] Failed to load persisted status:', e);
        }
    }
}
