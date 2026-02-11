// Same-host default: media-server runs locally on 3001.
// Override with VITE_MEDIA_SERVER_HTTP for remote deployments.
const MEDIA_SERVER_HTTP = process.env.VITE_MEDIA_SERVER_HTTP || 'http://127.0.0.1:3001';

export default {
    root: '.',
    server: {
        proxy: {
            '/api': {
                target: MEDIA_SERVER_HTTP,
                changeOrigin: true,
            },
        },
    },
    build: {
        outDir: 'dist',
    },
}
