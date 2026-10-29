// Retained usage bars visual capture (docket `usage-bars-keep-the-last-good-reading-when-a-usa`).
// Bundles `apps/desktop/renderer/tests/usageretained.visual.tsx` TWICE:
//   1. `fixture-before.js` / `fixture-before.css`: every renderer source/CSS file under
//      `apps/desktop/renderer/src/` is loaded directly from `--base` (default `HEAD~2`) via
//      `git show <base>:<rel>`, so `before.png` renders the genuine unpatched base components and CSS.
//   2. `fixture-after.js` / `fixture-after.css`: bundled against the current worktree (`HEAD`),
//      so `after.png` renders the patched retained-usage components and CSS.
// Then runs Electron in Session 0 (`tools/rig/desktop/usage-retained-visual.cjs`) to capture
// `before.png`, `after.png`, and `result.json`.
//
//   node tools/rig/usage-retained-visual.mjs --out <empty artifact folder> --deps-root <node_modules> [--base <sha>]
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'

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

const baseRef = execFileSync('git', ['rev-parse', args.base ?? 'HEAD~2'], {
  cwd: repo,
  encoding: 'utf8',
  windowsHide: true,
}).trim()
const afterRef = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: repo,
  encoding: 'utf8',
  windowsHide: true,
}).trim()

const deps = path.resolve(
  args['deps-root'] ??
    args.deps ??
    (process.env.ORGTREE_TEST_DEPS
      ? path.join(path.dirname(process.env.ORGTREE_TEST_DEPS), 'node_modules')
      : path.join(repo, 'node_modules')),
)
const esbuild = createRequire(import.meta.url)(path.join(deps, 'esbuild'))
const srcRoot = path.join(repo, 'apps', 'desktop', 'renderer', 'src')

function baseGitPlugin(ref) {
  return {
    name: 'base-git-source',
    setup(build) {
      build.onLoad({ filter: /\.(tsx?|css)$/ }, (loadArgs) => {
        const resolved = path.resolve(loadArgs.path)
        if (!resolved.startsWith(srcRoot + path.sep)) return null
        const rel = path.relative(repo, resolved).replaceAll('\\', '/')
        const p = spawnSync('git', ['show', `${ref}:${rel}`], {
          cwd: repo,
          windowsHide: true,
          encoding: 'utf8',
          maxBuffer: 16 * 1024 * 1024,
        })
        if (p.status !== 0) {
          throw new Error(`git show ${ref}:${rel} failed: ${p.stderr}`)
        }
        const ext = path.extname(resolved).slice(1)
        return {
          contents: p.stdout,
          loader: ext === 'css' ? 'css' : ext === 'tsx' ? 'tsx' : 'ts',
          resolveDir: path.dirname(resolved),
        }
      })
    },
  }
}

const common = {
  entryPoints: [path.join(repo, 'apps/desktop/renderer/tests/usageretained.visual.tsx')],
  bundle: true,
  format: 'iife',
  jsx: 'automatic',
  nodePaths: [deps],
  loader: { '.png': 'file', '.svg': 'file', '.jpg': 'file', '.woff': 'file', '.woff2': 'file', '.ttf': 'file' },
}

try {
  await esbuild.build({
    ...common,
    outfile: path.join(out, 'fixture-before.js'),
    plugins: [baseGitPlugin(baseRef)],
  })
  await esbuild.build({
    ...common,
    outfile: path.join(out, 'fixture-after.js'),
  })
} finally {
  esbuild.stop()
}

fs.writeFileSync(
  path.join(out, 'index-before.html'),
  '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="fixture-before.css"><div id="root"></div><script src="fixture-before.js"></script>',
)
fs.writeFileSync(
  path.join(out, 'index-after.html'),
  '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="fixture-after.css"><div id="root"></div><script src="fixture-after.js"></script>',
)
fs.mkdirSync(path.join(out, 'tmp'), { recursive: true })
const electron = args.electron ?? path.join(deps, 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
const env = { ...process.env, TMP: path.join(out, 'tmp'), TEMP: path.join(out, 'tmp') }
delete env.ELECTRON_RUN_AS_NODE
const child = spawnSync(
  electron,
  [
    path.join(repo, 'tools/rig/desktop/usage-retained-visual.cjs'),
    '--probe-out',
    out,
    '--base-ref',
    baseRef,
    '--after-ref',
    afterRef,
  ],
  {
    env,
    windowsHide: true,
    timeout: 180000,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  },
)
if (child.stdout) process.stdout.write(child.stdout)
if (child.stderr) process.stderr.write(child.stderr)
if (child.error) throw child.error
process.exitCode = child.status ?? 1
