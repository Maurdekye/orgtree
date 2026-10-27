// Question notification captures (docket 4-5-0-clicking-a-question-s-desktop-
// notification). Builds tests/questionnotificationdesk.visual.tsx, runs
// desktop/questionnotificationdesk-visual.cjs in an offscreen Electron window,
// and leaves <scene>-1-before.png / <scene>-2-after.png per scene plus
// result.json (each scene's facts and verdict, and the receipt: the window
// process's PID and Windows session, the clipboard denial, muted audio). View
// every PNG. Run it only from a turn in Session 0 or on a never-switched
// private desktop: the harness refuses any other session before it opens a
// window. Exit 0 only when every scene and the isolation receipt pass.
//   node tools/rig/questionnotificationdesk-visual.mjs --out <empty folder outside source> --deps-root <node_modules>
// To capture the red control, run the same command on the test-only commit.
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const args = Object.fromEntries(process.argv.slice(2).reduce((all, value, i, values) => {
  if (value.startsWith('--')) all.push([value.slice(2), values[i + 1]])
  return all
}, []))
if (!args.out) throw new Error('--out is required')
const out = path.resolve(args.out)
if (out === repo || out.startsWith(repo + path.sep)) throw new Error('artifact folder must be outside source')
if (fs.existsSync(out) && fs.readdirSync(out).length) throw new Error('use an empty artifact folder')
fs.mkdirSync(out, { recursive: true })
const deps = path.resolve(args['deps-root'] ?? path.join(repo, 'node_modules'))
const esbuild = createRequire(import.meta.url)(path.join(deps, 'esbuild'))
try {
  await esbuild.build({ entryPoints: [path.join(repo, 'apps/desktop/renderer/tests/questionnotificationdesk.visual.tsx')],
    outfile: path.join(out, 'fixture.js'), bundle: true, format: 'iife', jsx: 'automatic', nodePaths: [deps],
    // the whole App: KaTeX fonts, images and sounds come along
    loader: Object.fromEntries(['.png', '.svg', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.woff', '.woff2', '.ttf',
      '.otf', '.eot', '.mp3', '.wav', '.ogg', '.mp4', '.webm'].map(ext => [ext, 'file'])) })
} finally { esbuild.stop() }
fs.writeFileSync(path.join(out, 'index.html'), '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"><div id="root"></div><script src="fixture.js"></script>')
fs.mkdirSync(path.join(out, 'tmp'), { recursive: true })
const electron = args.electron ?? path.join(deps, 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
const env = { ...process.env, TMP: path.join(out, 'tmp'), TEMP: path.join(out, 'tmp') }
delete env.ELECTRON_RUN_AS_NODE
const child = spawnSync(electron, [path.join(repo, 'tools/rig/desktop/questionnotificationdesk-visual.cjs'), '--probe-out', out],
  { env, windowsHide: true, timeout: 180000, encoding: 'utf8', maxBuffer: 1024 * 1024 })
if (child.stdout) process.stdout.write(child.stdout)
if (child.stderr) process.stderr.write(child.stderr)
if (child.error) throw child.error
const result = path.join(out, 'result.json')
if (fs.existsSync(result)) {
  const { passed, scenes = [], refused } = JSON.parse(fs.readFileSync(result, 'utf8'))
  for (const s of scenes) console.log(`${s.passed ? 'PASS' : 'FAIL'} ${s.scene}`)
  console.log(refused ? `REFUSED ${refused}` : `${passed ? 'PASS' : 'FAIL'} all scenes and the isolation receipt`)
}
process.exitCode = child.status ?? 1
