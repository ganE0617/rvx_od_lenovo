// P2P mode: PTZ API is served by edge-agent tilt server (default :8080).
// Override with VITE_API_HTTP for remote deployments.
const API_HTTP = process.env.VITE_API_HTTP || 'http://127.0.0.1:8080';

export default {
    root: '.',
    server: {
        proxy: {
            '/api': {
                target: API_HTTP,
                changeOrigin: true,
            },
        },
    },
    build: {
        outDir: 'dist',
    },
}
