// The light-mode survey: the real App on lightsurvey-fixture.tsx's fake
// organization in offscreen Electron, on the canvas, the user's inbox, the
// shell menu, the Attention view and the homepage, in the light,
// solarized-light and charcoal contrast families with the Orgtree Grey and
// Claude Terracotta themes. lightsurvey-visual.cjs audits every visible text
// against the background it sits on (WCAG AA: 4.5:1, 3:1 for large text),
// every icon (3:1), every field's edge or fill (3:1), and lists the dark
// fills on the light surfaces. Records result.json, frames and summary.md;
// with --expect it fails on any text below AA on the light surfaces.
//   node lightsurvey-visual.mjs <build-output> <evidence> <node_modules> [--expect]
// Run the whole command, bundling included, under tests/joblimit.ps1 and the
// build slot.
// Electron probes must launch in browser mode even under an inherited Node-mode parent.
delete process.env.ELECTRON_RUN_AS_NODE
// Resolve real dependencies without copying or linking node_modules.
import { createRequire } from 'node:module'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { createServer } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runDesktop } from '../../../../tools/rig/desktop.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const [outputArg, evidenceArg, dependenciesArg, flag] = process.argv.slice(2)
if (!outputArg || !evidenceArg || !dependenciesArg) throw new Error('Supply build-output, evidence and real dependency root')
const output = path.resolve(outputArg), evidence = path.resolve(evidenceArg), dependencies = path.resolve(dependenciesArg)
const require = createRequire(path.join(dependencies, '../package.json'))
const esbuild = require('esbuild')
mkdirSync(output, { recursive: true }); mkdirSync(evidence, { recursive: true })
await esbuild.build({ entryPoints: { survey: path.join(here, 'lightsurvey-fixture.tsx') }, outdir: output,
  nodePaths: [dependencies], bundle: true, platform: 'browser', format: 'esm', jsx: 'automatic', logLevel: 'warning',
  loader: { '.png': 'dataurl', '.svg': 'dataurl', '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' },
  define: { 'process.env.NODE_ENV': '"production"' } })
esbuild.stop()
const html = '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/survey.css"><div id="root"></div><script type="module" src="/survey.js"></script>'
const server = createServer((req, res) => {
  const route = new URL(req.url, 'http://x').pathname
  if (route === '/survey.js' || route === '/survey.css') {
    const file = path.join(output, route.slice(1))
    if (!existsSync(file)) { res.writeHead(404); res.end(); return }
    res.setHeader('Content-Type', route.endsWith('css') ? 'text/css' : 'text/javascript')
    res.end(readFileSync(file)); return
  }
  if (!route.split('/').pop().includes('.')) { res.setHeader('Content-Type', 'text/html'); res.end(html); return }
  res.writeHead(404); res.end()
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
let result
try {
  result = await runDesktop({ dir: evidence, url: `http://127.0.0.1:${server.address().port}`, token: '', org: 'studio' },
    path.join(here, 'lightsurvey-visual.cjs'), { out: path.join(evidence, 'desktop'), timeout: 240000, preset: '1280x800' })
} finally { server.close() }
writeFileSync(path.join(evidence, 'result.json'), JSON.stringify(result, null, 2))
if (!result.ok) { console.log(JSON.stringify({ ok: false, error: result.error, out: evidence })); process.exit(1) }

// summary.md: per frame, the counts and every distinct failing text, icon,
// field and dark fill (what a reviewer reads before the frames)
const { frames, errors } = result.value
const lines = ['# Light-mode survey', '', `frames ${Object.keys(frames).length}, errors ${errors.length}`, ...errors.map(e => `- error: ${e}`), '']
for (const [name, f] of Object.entries(frames)) {
  lines.push(`## ${name}`, '', `theme ${f.root.theme} · ${f.root.cls} · accent ${f.root.accent} · texts ${f.texts} · below AA ${f.low.length} · icons below 3:1 ${f.icons.length} · fields below 3:1 ${f.edges.length} · dark fills ${f.dark.length}`, '')
  for (const t of f.low) lines.push(`- text ${t.ratio}:1 (needs ${t.need}) ${t.color} on ${t.on} ×${t.count} \`${t.el}\` "${t.text}" ${t.font}`)
  for (const t of f.icons) lines.push(`- icon ${t.ratio}:1 ${t.color} on ${t.on} ×${t.count} \`${t.el}\``)
  for (const t of f.edges) lines.push(`- field edge ${t.edgeRatio}:1 / fill ${t.fillRatio}:1 ${t.edge} on ${t.on} ×${t.count} \`${t.el}\``)
  for (const t of f.dark) lines.push(`- dark fill ${t.fill} ${t.size} ×${t.count} \`${t.el}\` "${t.text}"`)
  lines.push('')
}
writeFileSync(path.join(evidence, 'summary.md'), lines.join('\n'))

const checked = []
const light = Object.entries(frames).filter(([n]) => !n.includes('-charcoal-'))
if (flag === '--expect') {
  const failures = []
  for (const [name, f] of light) {
    if (f.texts < 20) failures.push(`${name}: only ${f.texts} texts audited (the frame did not render)`)
    for (const t of f.low) failures.push(`${name}: "${t.text}" (${t.el}) ${t.color} on ${t.on} is ${t.ratio}:1, needs ${t.need}`)
    checked.push(name)
  }
  if (errors.length) failures.push(...errors)
  if (failures.length) { console.log(JSON.stringify({ ok: false, expect: true, failures: failures.slice(0, 60), total: failures.length, out: evidence })); process.exit(1) }
}
const count = k => Object.fromEntries(light.map(([n, f]) => [n, f[k].length]))
console.log(JSON.stringify({ ok: true, expect: flag === '--expect', checked, frames: Object.keys(frames).length, errors, low: count('low'), shots: result.shots?.length, out: evidence }))
