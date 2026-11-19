import { defineConfig, loadEnv } from 'vite';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath, URL } from 'node:url';
import fs from 'node:fs';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');

  return {
    plugins: [vue(), { name: 'local-review-preview', configureServer(server) {
      server.middlewares.use('/__review_preview/contract.docx', (req, res) => {
        const file = fileURLToPath(new URL('../.local/margin-review/contract.docx', import.meta.url));
        if (!fs.existsSync(file)) { res.statusCode=404; res.end('Preview document not prepared'); return; }
        res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.wordprocessingml.document');
        res.setHeader('Cache-Control','no-store'); fs.createReadStream(file).pipe(res);
      });
    } }],
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
      extensions: ['.mjs', '.js', '.ts', '.jsx', '.tsx', '.json', '.vue'],
    },
    // Keep the engine's import.meta.url ZIP worker next to its package assets.
    optimizeDeps: { exclude: ['superdoc', '@superdoc/docx-engine'] },
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
          onlyExplicitManualChunks: true,
          manualChunks(id) {
            if (id.includes('vite/preload-helper') || id.includes('commonjsHelpers')) return 'vendor';
            if (!id.includes('node_modules')) return undefined;
            if (id.includes('superdoc') || id.includes('docx-engine') || id.includes('konva')) return 'vendor-word-review';
            if (id.includes('pdfjs-dist')) return 'vendor-pdf';
            return 'vendor';
          },
        },
      },
    },
  };
});
