// Build the two pages toolclock-turn-capture.cjs paints: the visual fixture
// toolclock-turn-visual.tsx bundled against this renderer tree ("after") and,
// unchanged, against a base renderer tree ("before", the red control's
// picture). Bare imports resolve from this tree's node_modules, so the base
// tree needs none of its own (never copy or junction them).
//   node apps/desktop/renderer/tests/toolclock-turn-pages.mjs <root under C:\orgtree-build\> <base apps/desktop/renderer dir>
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const [root, base] = process.argv.slice(2)
if (!/^C:\\orgtree-build\\/i.test(root || '') || !base || !fs.existsSync(path.join(base, 'src', 'canvas', 'toolclock.tsx'))) {
  throw new Error('usage: toolclock-turn-pages.mjs <C:\\orgtree-build\\...> <base apps/desktop/renderer dir>')
}
const fixture = fs.readFileSync(path.join(HERE, 'toolclock-turn-visual.tsx'), 'utf8')
const modules = path.resolve(HERE, '..', '..', '..', '..', 'node_modules')
for (const [version, renderer] of [['after', path.resolve(HERE, '..')], ['before', path.resolve(base)]]) {
  const out = path.join(root, version)
  fs.mkdirSync(out, { recursive: true })
  await esbuild.build({
    stdin: { contents: fixture, loader: 'tsx', resolveDir: path.join(renderer, 'tests'), sourcefile: 'toolclock-turn-visual.tsx' },
    outfile: path.join(out, 'page.js'),
    bundle: true,
    // a classic script: Chromium refuses module scripts from file:// pages
    format: 'iife',
    platform: 'browser',
    target: 'chrome120',
    jsx: 'automatic',
    nodePaths: [modules],
    loader: { '.svg': 'dataurl', '.png': 'dataurl', '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' },
    define: { 'process.env.NODE_ENV': '"production"' },
    logLevel: 'warning',
  })
  const css = fs.existsSync(path.join(out, 'page.css')) ? `<link rel="stylesheet" href="${version}/page.css">` : ''
  fs.writeFileSync(path.join(root, `${version}.html`), '<!doctype html><html><head><meta charset="utf-8">' + css
    + `</head><body><div id="root"></div><script src="${version}/page.js"></script></body></html>`)
  console.log(`${version}: ${renderer}`)
}
await esbuild.stop()
