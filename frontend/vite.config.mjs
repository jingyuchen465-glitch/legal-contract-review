import { defineConfig, loadEnv } from 'vite';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');

  return {
    plugins: [vue()],
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
      extensions: ['.mjs', '.js', '.ts', '.jsx', '.tsx', '.json', '.vue'],
    },
    server: {
      host: '127.0.0.1',
      port: 8080,
      proxy: {
        '/socket.io': { target: 'http://localhost:3000', ws: true },
        '/api': {
          target: env.VITE_APP_BACKEND_API_URL || 'http://localhost:3000',
          changeOrigin: true,
        },
      },
    },
    define: {
      'process.env.BASE_URL': JSON.stringify(env.BASE_URL || '/'),
    },
    build: {
      cssCodeSplit: true,
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (!id.includes('node_modules')) return undefined;
            if (id.includes('pdfjs-dist')) return 'vendor-pdf';
            return 'vendor';
          },
        },
      },
    },
  };
});
