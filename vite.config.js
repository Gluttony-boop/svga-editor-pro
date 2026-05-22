import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
// https://tauri.app/start/frontend/vite/
var host = process.env.TAURI_DEV_HOST;
export default defineConfig({
    server: {
        port: 5174,
        strictPort: false,
        // Tauri 开发模式需要
        host: host || false,
        hmr: host ? {
            protocol: 'ws',
            host: host,
            port: 5174,
        } : undefined,
        watch: {
            ignored: ['**/src-tauri/**'],
        },
    },
    plugins: [
        react(),
    ],
    resolve: {
        alias: {
            '@': path.resolve(__dirname, './src'),
            '@core': path.resolve(__dirname, './src/core'),
            '@components': path.resolve(__dirname, './src/components'),
            '@features': path.resolve(__dirname, './src/features'),
            '@stores': path.resolve(__dirname, './src/stores'),
            '@utils': path.resolve(__dirname, './src/utils'),
            '@types': path.resolve(__dirname, './src/types'),
            '@rendering': path.resolve(__dirname, './src/rendering'),
            '@lib': path.resolve(__dirname, './src/lib'),
        }
    },
    css: {
        postcss: './postcss.config.js'
    },
    build: {
        outDir: 'dist',
        // Tauri 使用 Shadow DOM，需要内联样式
        cssCodeSplit: false,
        rollupOptions: {
            output: {
                manualChunks: {
                    'vendor-react': ['react', 'react-dom'],
                    'vendor-pixi': ['pixi.js'],
                    'vendor-core': ['protobufjs', 'pako', 'jszip']
                }
            }
        }
    },
    // Tauri 环境变量
    define: {
        '__TAURI__': JSON.stringify(typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window),
    }
});
