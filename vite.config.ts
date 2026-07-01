import { defineConfig } from 'vite';
import { viteStaticCopy } from 'vite-plugin-static-copy';

const MODULE_ID = 'mediasoup-vtt';

// Vite library build: a single ESM bundle at dist/<id>.mjs (the path
// module.json's `esmodules` references), plus static-copied manifest + assets.
// mediasoup-client is BUNDLED (not externalized) — Foundry has no npm, so the
// SFU client must ship inside this bundle. Foundry serves dist/ as the module
// root, so output paths must byte-match the manifest. The dev server proxies
// everything to Foundry on :30000 except this module's own files, which Vite
// serves with HMR.
export default defineConfig(({ mode }) => ({
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: mode === 'development',
    minify: false,
    target: 'es2022',
    lib: {
      entry: 'src/mediasoup-vtt.ts',
      formats: ['es'],
      fileName: () => `${MODULE_ID}.mjs`,
    },
  },
  plugins: [
    viteStaticCopy({
      targets: [
        { src: 'module.json', dest: '.' },
        { src: 'lang', dest: '.' },
        { src: 'styles', dest: '.' },
        { src: 'templates', dest: '.' },
      ],
    }),
  ],
  server: {
    port: 30001,
    proxy: {
      [`^(?!/modules/${MODULE_ID}/)`]: 'http://localhost:30000/',
      '/socket.io': { target: 'ws://localhost:30000', ws: true },
    },
  },
}));
