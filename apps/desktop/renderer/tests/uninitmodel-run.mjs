// Focused runner without node_modules links. Resolve installed dependencies explicitly.
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '../../../..')
const deps = process.env.ORGTREE_TEST_DEPS || 'E:/Libraries/Desktop/orgtree/node_modules'
const require = createRequire(path.join(deps, '_resolve.cjs'))
const esbuild = require('esbuild')
const out = process.argv[2]
if (!out || !/^C:\/orgtree-build\/uninit-model-sol\//i.test(out.replaceAll('\\', '/'))) throw Error('own C build output required')
fs.mkdirSync(out, { recursive: true })
const entries = process.argv.slice(3)
await esbuild.build({ entryPoints: entries.length ? entries.map(e => path.join(here, e)) : [path.join(here, 'uninitmodel.test.tsx')],
  outdir: out, outExtension: { '.js': '.mjs' }, bundle: true, platform: 'node', format: 'esm', jsx: 'automatic',
  nodePaths: [deps], external: ['node:*'], define: { 'process.env.NODE_ENV': '"development"', __SRC_DIR__: JSON.stringify(path.join(here, '../src')) },
  plugins: [{ name: 'draft-picker-red-control', setup(b) {
    const ref = process.env.ORGTREE_UNINIT_RED_REF
    if (!ref) return
    if (!/^[a-f0-9]{40}$/.test(ref)) throw Error('red control requires an exact commit')
    b.onLoad({filter: /(?:cards|QuickChatBox)\.tsx$/}, ({path: source}) => {
      const relative=path.relative(repo,source).replaceAll('\\','/')
      const result=spawnSync('git',['show',`${ref}:${relative}`],{cwd:repo,encoding:'utf8',windowsHide:true,maxBuffer:4*1024*1024})
      if(result.status!==0) throw Error('cannot read red-control source '+relative)
      return {contents:result.stdout,loader:'tsx'}
    })
  } }, { name: 'external-jsdom', setup(b) { b.onResolve({ filter: /^jsdom$/ }, () => ({ path: pathToFileURL(require.resolve('jsdom')).href, external: true })) } }], logLevel: 'warning' })
await esbuild.stop()
const bundles = (entries.length ? entries : ['uninitmodel.test.tsx']).map(e => path.join(out, e.replace(/\.tsx?$/, '.mjs')))
const args = ['--test', '--test-force-exit', '--test-concurrency=1', '--test-timeout=30000', ...bundles]
const argFile = path.join(out, 'args.txt'); fs.writeFileSync(argFile, args.join('\n'))
const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(here, 'joblimit.ps1'),
  '-LimitMB', '4096', '-TimeoutSec', '120', '-WorkDir', repo, '-Exe', process.execPath, '-ArgFile', argFile], { stdio: 'inherit', windowsHide: true })
console.log(JSON.stringify({ status: r.status, signal: r.signal, error: r.error?.message }))
process.exit(r.status ?? 1)
