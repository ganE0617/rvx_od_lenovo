/// <reference types="vite/client" />

interface ImportMetaEnv {
    readonly VITE_SIGNALING_URL: string;
    readonly VITE_DEFAULT_ROOM_ID: string;
}

interface ImportMeta {
    readonly env: ImportMetaEnv;
}
