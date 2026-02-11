import { ViewerStatus } from './viewer.js';

/**
 * UI state management and DOM manipulation
 */
export class UI {
    constructor() {
        this.elements = {
            statusIndicator: document.getElementById('status-indicator'),
            statusText: document.getElementById('status-text'),
            peerId: document.getElementById('peer-id'),
            errorMessage: document.getElementById('error-message'),
            roomIdInput: document.getElementById('room-id-input'),
            connectBtn: document.getElementById('connect-btn'),
            disconnectBtn: document.getElementById('disconnect-btn'),
            videoElement: document.getElementById('video-element'),
            signalingUrlInfo: document.getElementById('signaling-url-info'),
            streamStatusInfo: document.getElementById('stream-status-info'),
            // PTZ Control
            ptzToggleBtn: document.getElementById('ptz-toggle'),
            ptzPanel: document.getElementById('ptz-control-panel'),
            panSlider: document.getElementById('pan-slider'),
            panDisplay: document.getElementById('pan-display'),
            tiltSlider: document.getElementById('tilt-slider'),
            tiltDisplay: document.getElementById('tilt-display'),
            zoomSlider: document.getElementById('zoom-slider'),
            zoomDisplay: document.getElementById('zoom-display'),
            ptzStatus: document.getElementById('ptz-status'),
            ptzLoadingDot: document.getElementById('ptz-loading-dot'),
        };
    }

    init(signalingUrl, defaultRoomId, peerId) {
        this.elements.roomIdInput.value = defaultRoomId;
        this.elements.peerId.textContent = `Viewer ID: ${peerId}`;
        this.elements.signalingUrlInfo.textContent = `Signaling Server: ${signalingUrl}`;

        // PTZ panel toggle (collapse by default; show on click)
        const btn = this.elements.ptzToggleBtn;
        const panel = this.elements.ptzPanel;
        if (btn && panel) {
            let open = false;
            const apply = () => {
                // panel open/close via opacity/scale to avoid blocking video view
                panel.classList.toggle('opacity-0', !open);
                panel.classList.toggle('scale-95', !open);
                panel.classList.toggle('pointer-events-none', !open);
                panel.classList.toggle('opacity-100', open);
                panel.classList.toggle('scale-100', open);
                panel.classList.toggle('pointer-events-auto', open);
                btn.setAttribute('aria-expanded', open ? 'true' : 'false');
            };
            apply();

            btn.addEventListener('click', (e) => {
                e.preventDefault();
                open = !open;
                apply();
            });

            // Click outside closes
            document.addEventListener('click', (e) => {
                if (!open) return;
                const t = e.target;
                if (!(t instanceof Node)) return;
                if (btn.contains(t)) return;
                if (panel.contains(t)) return;
                open = false;
                apply();
            });
        }
    }

    updateStatus(status) {
        this.elements.statusText.textContent = status;

        // Update indicator color
        const colors = {
            [ViewerStatus.DISCONNECTED]: 'bg-gray-500',
            [ViewerStatus.CONNECTING]: 'bg-yellow-500',
            [ViewerStatus.CONNECTED]: 'bg-blue-500',
            [ViewerStatus.PLAYING]: 'bg-green-500',
            [ViewerStatus.ERROR]: 'bg-red-500',
        };

        this.elements.statusIndicator.className = `w-3 h-3 rounded-full ${colors[status] || 'bg-gray-500'}`;

        // Update stream status
        const isPlaying = status === ViewerStatus.PLAYING;
        this.elements.streamStatusInfo.textContent = `Status: ${isPlaying ? 'Streaming' : 'No video'}`;

        // Update button visibility
        const isDisconnected = status === ViewerStatus.DISCONNECTED;
        this.elements.roomIdInput.disabled = !isDisconnected;
        this.elements.connectBtn.classList.toggle('hidden', !isDisconnected);
        this.elements.disconnectBtn.classList.toggle('hidden', isDisconnected);
    }

    showError(error) {
        if (error) {
            this.elements.errorMessage.textContent = `Error: ${error}`;
            this.elements.errorMessage.classList.remove('hidden');
        } else {
            this.elements.errorMessage.classList.add('hidden');
        }
    }

    async attachVideoTrack(mediaStream) {
        const video = this.elements.videoElement;
        video.srcObject = mediaStream;
        video.muted = true;
        video.playsInline = true;
        video.autoplay = true;

        video.onloadedmetadata = () => console.log('[UI] loadedmetadata', video.videoWidth, video.videoHeight);
        video.onplaying = () => console.log('[UI] playing');
        video.onpause = () => console.log('[UI] paused');
        video.onerror = (e) => console.error('[UI] video error', e);

        try {
            await video.play();
            console.log('[UI] video.play() OK');
        } catch (e) {
            console.error('[UI] video.play() FAILED', e);
        }
    }

    clearVideo() {
        this.elements.videoElement.srcObject = null;
    }

    getRoomId() {
        return this.elements.roomIdInput.value.trim() || 'robot-001';
    }

    onConnect(callback) {
        this.elements.connectBtn.addEventListener('click', callback);
    }

    onDisconnect(callback) {
        this.elements.disconnectBtn.addEventListener('click', callback);
    }

    // PTZ Control UI
    updatePtzUI(status) {
        // Apply dynamic ranges if provided
        if (status?.limits) {
            const { pan, tilt, zoom } = status.limits;
            if (pan?.min !== undefined) this.elements.panSlider.min = String(pan.min);
            if (pan?.max !== undefined) this.elements.panSlider.max = String(pan.max);
            if (tilt?.min !== undefined) this.elements.tiltSlider.min = String(tilt.min);
            if (tilt?.max !== undefined) this.elements.tiltSlider.max = String(tilt.max);
            if (zoom?.min !== undefined) this.elements.zoomSlider.min = String(zoom.min);
            if (zoom?.max !== undefined) this.elements.zoomSlider.max = String(zoom.max);
        }

        // Disable unsupported controls (some webcams expose pan/tilt but reject writes)
        const supported = status?.supported;
        if (supported) {
            console.log('[PTZ] supported flags:', supported, 'limits:', status?.limits);
            this.elements.panSlider.disabled = supported.pan === false;
            this.elements.tiltSlider.disabled = supported.tilt === false;
            this.elements.zoomSlider.disabled = supported.zoom === false;
            if (supported.pan === false || supported.tilt === false) {
                this.showPtzStatus('PTZ: pan/tilt not supported by this device', true);
            }
        }

        this.elements.panSlider.value = status.pan;
        this.elements.panDisplay.textContent = `${status.pan}°`;

        this.elements.tiltSlider.value = status.tilt;
        this.elements.tiltDisplay.textContent = `${status.tilt}°`;

        this.elements.zoomSlider.value = status.zoom;
        this.elements.zoomDisplay.textContent = `${status.zoom.toFixed(1)}x`;
    }

    showPtzStatus(text, isError = false) {
        this.elements.ptzStatus.textContent = text;
        this.elements.ptzStatus.classList.toggle('text-red-400', isError);
        this.elements.ptzStatus.classList.toggle('text-gray-500', !isError);
    }

    setPtzLoading(isLoading) {
        this.elements.ptzLoadingDot.classList.toggle('hidden', !isLoading);

        // Non-blocking UI: Sliders remain enabled even during sync
        // this.elements.panSlider.disabled = isLoading;
        // this.elements.tiltSlider.disabled = isLoading;
        // this.elements.zoomSlider.disabled = isLoading;

        if (isLoading) {
            this.showPtzStatus('Syncing...');
        }
    }

    onPtzChange(callback) {
        const sliders = [
            { el: this.elements.panSlider, display: this.elements.panDisplay, key: 'pan', unit: '°' },
            { el: this.elements.tiltSlider, display: this.elements.tiltDisplay, key: 'tilt', unit: '°' },
            { el: this.elements.zoomSlider, display: this.elements.zoomDisplay, key: 'zoom', unit: 'x' },
        ];

        sliders.forEach(({ el, display, key, unit }) => {
            // Immediate UI feedback on input
            el.addEventListener('input', (e) => {
                display.textContent = `${e.target.value}${unit}`;
            });

            // Send command on change (mouse release)
            el.addEventListener('change', (e) => {
                const value = key === 'zoom' ? parseFloat(e.target.value) : parseInt(e.target.value);
                callback({ [key]: value });
            });
        });
    }
}
