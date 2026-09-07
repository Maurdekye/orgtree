import * as esbuild from 'esbuild'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
await esbuild.build({
  entryPoints: [path.join(here, 'htmlmockups.browser.tsx')],
  outfile: path.join(here, '../node_modules/.orgtree-mockup-browser/probe.js'),
  bundle: true, format: 'esm', platform: 'browser', target: 'es2022',
  jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' },
})
