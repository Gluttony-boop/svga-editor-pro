import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

await build({
  absWorkingDir: fileURLToPath(new URL('.', import.meta.url)),
  entryPoints: ['src/worker.mjs'], bundle: true, format: 'esm', platform: 'browser',
  target: 'es2022', outfile: 'dist/worker.mjs', sourcemap: false,
})
