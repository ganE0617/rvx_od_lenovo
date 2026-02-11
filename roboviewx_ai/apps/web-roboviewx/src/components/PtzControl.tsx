import React, { useState, useEffect, useCallback, useRef } from 'react';
import { debounce } from 'lodash';

interface PtzState {
    pan: number;
    tilt: number;
    zoom: number;
}

interface PtzControlProps {
    roomId: string;
    onNotification?: (method: string, handler: (params: any) => void) => void;
    offNotification?: (method: string, handler: (params: any) => void) => void;
}

const PtzControl: React.FC<PtzControlProps> = ({ roomId, onNotification, offNotification }) => {
    const [ptz, setPtz] = useState<PtzState>(() => {
        const saved = localStorage.getItem(`ptz_state_${roomId}`);
        if (saved) {
            try {
                return JSON.parse(saved);
            } catch (e) {
                return { pan: 0, tilt: 0, zoom: 1.0 };
            }
        }
        return { pan: 0, tilt: 0, zoom: 1.0 };
    });
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const lastSentPtz = useRef<PtzState>(ptz);
    const lastInteractionTime = useRef<number>(0);

    const fetchPtzStatus = useCallback(async () => {
        try {
            const response = await fetch(`/api/robots/${roomId}/ptz`);
            if (!response.ok) throw new Error('Failed to fetch PTZ status');
            if (Date.now() - lastInteractionTime.current < 5000) {
                return; // Interaction cooldown
            }

            const data = await response.json();
            const newState = {
                pan: data.pan ?? 0,
                tilt: data.tilt ?? 0,
                zoom: data.zoom ?? 1.0
            };
            setPtz(newState);
            localStorage.setItem(`ptz_state_${roomId}`, JSON.stringify(newState));
            lastSentPtz.current = newState;
        } catch (err: any) {
            console.error('[PTZ] Fetch error:', err);
            setError(err.message);
        }
    }, [roomId]);

    useEffect(() => {
        fetchPtzStatus();
        const interval = setInterval(fetchPtzStatus, 10000); // Polling as fallback

        // Real-time sync
        const handleSync = (data: any) => {
            const isCoolingDown = Date.now() - lastInteractionTime.current < 5000;
            if (isCoolingDown) return;

            console.log('[PTZ] Syncing from server (React):', data);
            const newState = {
                pan: data.pan ?? ptz.pan,
                tilt: data.tilt ?? ptz.tilt,
                zoom: data.zoom ?? ptz.zoom
            };
            setPtz(newState);
            localStorage.setItem(`ptz_state_${roomId}`, JSON.stringify(newState));
            lastSentPtz.current = newState;
        };

        if (onNotification) {
            onNotification('ptz:state', handleSync);
        }

        return () => {
            clearInterval(interval);
            if (offNotification) {
                offNotification('ptz:state', handleSync);
            }
        };
    }, [fetchPtzStatus, onNotification, offNotification, roomId, ptz]);

    const debouncedUpdate = useRef(
        debounce(async (currentPtz: PtzState) => {
            setLoading(true);
            setError(null);
            try {
                // Only send changed fields
                const body: Partial<PtzState> = {};
                if (currentPtz.pan !== lastSentPtz.current.pan) body.pan = currentPtz.pan;
                if (currentPtz.tilt !== lastSentPtz.current.tilt) body.tilt = currentPtz.tilt;
                if (currentPtz.zoom !== lastSentPtz.current.zoom) body.zoom = currentPtz.zoom;

                if (Object.keys(body).length === 0) return;

                const response = await fetch(`/api/robots/${roomId}/ptz`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                });

                if (!response.ok) throw new Error('Failed to update PTZ');

                lastSentPtz.current = { ...currentPtz };
            } catch (err: any) {
                setError(err.message);
            } finally {
                setLoading(false);
            }
        }, 500)
    ).current;

    const handleSliderChange = (key: keyof PtzState, value: number) => {
        lastInteractionTime.current = Date.now();
        const nextPtz = { ...ptz, [key]: value };
        setPtz(nextPtz);
        localStorage.setItem(`ptz_state_${roomId}`, JSON.stringify(nextPtz));
        debouncedUpdate(nextPtz);
    };

    return (
        <div className="bg-gray-900/90 backdrop-blur-sm p-4 rounded-xl border border-gray-700 shadow-2xl text-white w-64">
            <div className="flex items-center justify-between mb-4">
                <h3 className="text-xs font-bold uppercase tracking-widest text-gray-400">Camera PTZ</h3>
                {loading && <div className="w-2 h-2 bg-blue-500 rounded-full animate-pulse" />}
            </div>

            <div className="space-y-4">
                {/* Pan */}
                <div className="space-y-1">
                    <div className="flex justify-between text-[10px] text-gray-400">
                        <span>PAN</span>
                        <span className="font-mono text-blue-400">{ptz.pan}°</span>
                    </div>
                    <input
                        type="range"
                        min="-180"
                        max="180"
                        value={ptz.pan}
                        onChange={(e) => handleSliderChange('pan', parseInt(e.target.value))}
                        // disabled={loading} // Non-blocking: allow interaction during sync
                        className="w-full h-1.5 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-blue-500 disabled:opacity-50"
                    />
                </div>

                {/* Tilt */}
                <div className="space-y-1">
                    <div className="flex justify-between text-[10px] text-gray-400">
                        <span>TILT</span>
                        <span className="font-mono text-blue-400">{ptz.tilt}°</span>
                    </div>
                    <input
                        type="range"
                        min="-90"
                        max="90"
                        value={ptz.tilt}
                        onChange={(e) => handleSliderChange('tilt', parseInt(e.target.value))}
                        // disabled={loading} // Non-blocking
                        className="w-full h-1.5 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-blue-500 disabled:opacity-50"
                    />
                </div>

                {/* Zoom */}
                <div className="space-y-1">
                    <div className="flex justify-between text-[10px] text-gray-400">
                        <span>ZOOM</span>
                        <span className="font-mono text-blue-400">{ptz.zoom.toFixed(1)}x</span>
                    </div>
                    <input
                        type="range"
                        min="1.0"
                        max="3.0"
                        step="0.1"
                        value={ptz.zoom}
                        onChange={(e) => handleSliderChange('zoom', parseFloat(e.target.value))}
                        // disabled={loading} // Non-blocking
                        className="w-full h-1.5 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-blue-500 disabled:opacity-50"
                    />
                </div>
            </div>

            {error && (
                <div className="mt-3 text-[10px] text-red-500 text-center animate-bounce">
                    {error}
                </div>
            )}
        </div>
    );
};

export default PtzControl;
