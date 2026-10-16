import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
const here = path.dirname(fileURLToPath(import.meta.url))
const deps = process.env.ORGTREE_TEST_DEPS || 'E:/Libraries/Desktop/orgtree/node_modules'
const require = createRequire(path.join(deps, '_resolve.cjs'))
const esbuild = require('esbuild')
const out = process.argv[2]
if (!out || !/^C:\/orgtree-build\/uninit-model-sol\//i.test(out.replaceAll('\\', '/'))) throw Error('own C output required')
fs.mkdirSync(out, { recursive: true })
await esbuild.build({ entryPoints: [path.join(here, '../src/main.tsx')], outdir: out,
  bundle: true, platform: 'browser', format: 'esm', jsx: 'automatic', nodePaths: [deps],
  define: { 'process.env.NODE_ENV': '"development"' }, loader: { '.svg': 'dataurl', '.png': 'dataurl', '.woff2': 'dataurl' }, logLevel: 'warning' })
await esbuild.stop()
const html = fs.readFileSync(path.join(here, '../index.html'), 'utf8')
  .replace('<script type="module" src="/src/main.tsx"></script>', '<link rel="stylesheet" href="/main.css"><script type="module" src="/main.js"></script>')
fs.writeFileSync(path.join(out, 'index.html'), html)
console.log(JSON.stringify({ ui: out }))
