import { build as bundle } from 'esbuild'
import { build as renderer } from 'vite'
import path from 'node:path'

await bundle({ entryPoints: ['apps/desktop/main/index.ts'], outfile: 'dist/main/index.cjs',
  bundle: true, platform: 'node', format: 'cjs', external: ['electron'], sourcemap: true })
await bundle({ entryPoints: ['apps/desktop/preload/index.ts'], outfile: 'dist/preload/index.cjs',
  bundle: true, platform: 'node', format: 'cjs', external: ['electron'], sourcemap: true })
await renderer({ root: 'apps/desktop/renderer', base: './',
  build: { outDir: path.resolve('dist/renderer'), emptyOutDir: true } })
