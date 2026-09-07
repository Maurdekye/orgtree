import { build as bundle } from 'esbuild'
import { build as renderer } from 'vite'
import path from 'node:path'
import fs from 'node:fs'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'

await bundle({ entryPoints: ['apps/desktop/main/index.ts'], outfile: 'dist/main/index.cjs',
  bundle: true, platform: 'node', format: 'cjs', external: ['electron'], sourcemap: true })
await bundle({ entryPoints: ['apps/desktop/preload/index.ts'], outfile: 'dist/preload/index.cjs',
  bundle: true, platform: 'node', format: 'cjs', external: ['electron'], sourcemap: true })
await renderer({ root: 'apps/desktop/renderer', base: './',
  build: { outDir: path.resolve('dist/renderer'), emptyOutDir: true } })

const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
let commit = null, dirty = null
try {
  commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  dirty = !!execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], { encoding: 'utf8' }).trim()
} catch { /* Development source archives can build; release preflight requires provenance. */ }
const files = ['dist/main/index.cjs', 'dist/preload/index.cjs', 'dist/renderer/index.html',
  ...fs.readdirSync('dist/renderer/assets').map(name => 'dist/renderer/assets/' + name),
  'engine/launch.py', 'engine/runtime/python.exe', 'engine/runtime/python313._pth', 'engine/runtime/runtime-manifest.json']
fs.writeFileSync('dist/build-info.json', JSON.stringify({ version: JSON.parse(fs.readFileSync('package.json', 'utf8')).version,
  commit, dirty, builtAt: new Date().toISOString(), sha256: Object.fromEntries(files.filter(file => fs.existsSync(file)).map(file => [file, hash(file)])) }, null, 2) + '\n')
