// node tests/video-fullscreen-native.run.mjs   (from the repo root; Session 0 only, muted, isolated profile)
// ORGTREE_TEST_DEPS = the dependency checkout's package.json (esbuild, electron)
// ORGTREE_AGENT     = the running agent; VIDEOFS_OUT = a folder below C:\orgtree-build\<ORGTREE_AGENT>\
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'

const repo = process.cwd(), deps = process.env.ORGTREE_TEST_DEPS, out = path.resolve(process.env.VIDEOFS_OUT || '')
const owner = process.env.ORGTREE_AGENT || ''
if (!deps) throw Error('ORGTREE_TEST_DEPS required (the dependency checkout package.json)')
if (!/^[A-Za-z0-9_-]{1,64}$/.test(owner) || !out.toLowerCase().startsWith(`c:\\orgtree-build\\${owner}\\`.toLowerCase())) throw Error('VIDEOFS_OUT must be below C:\\orgtree-build\\<ORGTREE_AGENT>\\')
const require = createRequire(deps)
fs.mkdirSync(out, { recursive: true })
await require('esbuild').build({ entryPoints: [path.join(repo, 'tests/video-fullscreen-native.probe.ts')], outfile: path.join(out, 'probe.cjs'),
  bundle: true, platform: 'node', format: 'cjs', external: ['electron'], nodePaths: [path.join(path.dirname(deps), 'node_modules')], logLevel: 'error' })
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const run = spawnSync(require('electron'), [path.join(out, 'probe.cjs')], { env, encoding: 'utf8', windowsHide: true, timeout: 120000, maxBuffer: 4e6 })
const text = (run.stdout || '') + (run.stderr || '')
fs.writeFileSync(path.join(out, 'electron.log'), text)
console.log(text.split(/\r?\n/).filter(line => /VIDEO_FULLSCREEN|RESULTS|AssertionError|Error:/.test(line)).join('\n') || text.slice(-600))
process.exit(run.status ?? 1)
