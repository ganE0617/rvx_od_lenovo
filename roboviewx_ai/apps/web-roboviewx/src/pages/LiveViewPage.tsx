import React, { useState } from 'react';
import { useMediasoupViewer, ViewerStatus } from '../hooks/useMediasoupViewer';
import PtzControl from '../components/PtzControl';

const SIGNALING_URL = import.meta.env.VITE_SIGNALING_URL || 'ws://localhost:3001';
const DEFAULT_ROOM_ID = import.meta.env.VITE_DEFAULT_ROOM_ID || 'robot-001';

export function LiveViewPage() {
    const [roomId, setRoomId] = useState(DEFAULT_ROOM_ID);
    const [peerId] = useState(`viewer-${Date.now()}`);
    const {
        status, error, videoRef, connect, disconnect,
        onNotification, offNotification
    } = useMediasoupViewer(SIGNALING_URL);

    const handleConnect = () => {
        connect(roomId, peerId);
    };

    const handleDisconnect = () => {
        disconnect();
    };

    const getStatusColor = () => {
        switch (status) {
            case ViewerStatus.DISCONNECTED:
                return 'bg-gray-500';
            case ViewerStatus.CONNECTING:
                return 'bg-yellow-500';
            case ViewerStatus.CONNECTED:
                return 'bg-blue-500';
            case ViewerStatus.PLAYING:
                return 'bg-green-500';
            case ViewerStatus.ERROR:
                return 'bg-red-500';
            default:
                return 'bg-gray-500';
        }
    };

    return (
        <div className="min-h-screen bg-gray-900 text-white p-4">
            <div className="max-w-4xl mx-auto">
                <h1 className="text-3xl font-bold mb-6">RoboViewX - Live View</h1>

                {/* Status Bar */}
                <div className="bg-gray-800 rounded-lg p-4 mb-4">
                    <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                            <div className={`w-3 h-3 rounded-full ${getStatusColor()}`}></div>
                            <span className="font-semibold">{status}</span>
                        </div>
                        <div className="text-sm text-gray-400">Viewer ID: {peerId}</div>
                    </div>
                    {error && (
                        <div className="mt-2 text-red-400 text-sm">
                            Error: {error}
                        </div>
                    )}
                </div>

                {/* Controls */}
                <div className="bg-gray-800 rounded-lg p-4 mb-4">
                    <div className="flex gap-4 items-end">
                        <div className="flex-1">
                            <label className="block text-sm font-medium mb-2">Room ID</label>
                            <input
                                type="text"
                                value={roomId}
                                onChange={(e) => setRoomId(e.target.value)}
                                disabled={status !== ViewerStatus.DISCONNECTED}
                                className="w-full px-4 py-2 bg-gray-700 rounded border border-gray-600 focus:border-blue-500 focus:outline-none disabled:opacity-50"
                                placeholder="robot-001"
                            />
                        </div>
                        <div>
                            {status === ViewerStatus.DISCONNECTED ? (
                                <button
                                    onClick={handleConnect}
                                    className="px-6 py-2 bg-blue-600 hover:bg-blue-700 rounded font-medium transition"
                                >
                                    Connect
                                </button>
                            ) : (
                                <button
                                    onClick={handleDisconnect}
                                    className="px-6 py-2 bg-red-600 hover:bg-red-700 rounded font-medium transition"
                                >
                                    Disconnect
                                </button>
                            )}
                        </div>
                    </div>
                </div>

                {/* Video Player & PTZ Control */}
                <div className="relative bg-black rounded-lg overflow-hidden aspect-video group">
                    <video
                        ref={videoRef}
                        autoPlay
                        playsInline
                        muted={false}
                        className="w-full h-full object-contain"
                    />

                    {/* PTZ Control Overlay */}
                    {status === ViewerStatus.PLAYING && (
                        <div className="absolute top-4 right-4 transition-opacity opacity-0 group-hover:opacity-100">
                            <PtzControl
                                roomId={roomId}
                                onNotification={onNotification}
                                offNotification={offNotification}
                            />
                        </div>
                    )}
                </div>

                {/* Info */}
                <div className="mt-4 text-sm text-gray-400">
                    <p>Signaling Server: {SIGNALING_URL}</p>
                    <p className="mt-1">
                        Status: {status === ViewerStatus.PLAYING ? 'Streaming' : 'No video'}
                    </p>
                </div>
            </div>
        </div>
    );
}
