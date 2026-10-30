#!/usr/bin/env node
/**
 * Session 0 real-renderer visual verification for folded and unfolded request
 * cards (single without ticket, single with ticket, multi with two tickets) at
 * 900 px width.
 *
 * Usage:
 *   ORGTREE_TEST_DEPS=E:/Libraries/Desktop/orgtree/package.json \
 *   node tools/rig/ask-fold-header-visual.mjs \
 *     --out C:/orgtree-build/symmetry-argon/ask-fold-header-capture-20261030 \
 *     --base 1aafe14cc8b191479b144abf1ae515f01d7c4b00
 */
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..', '..')
const rendererDir = path.join(repoRoot, 'apps', 'desktop', 'renderer')

function arg(name, fallback = null) {
  const idx = process.argv.indexOf(name)
  return idx >= 0 && idx + 1 < process.argv.length ? process.argv[idx + 1] : fallback
}

const outDir = path.resolve(
  arg('--out', 'C:/orgtree-build/symmetry-argon/ask-fold-header-capture-20261030'),
)
const baseSha = arg('--base', '1aafe14cc8b191479b144abf1ae515f01d7c4b00')

const depsPkg = process.env.ORGTREE_TEST_DEPS || 'E:/Libraries/Desktop/orgtree/package.json'
const requireFromDeps = createRequire(path.resolve(depsPkg))
const esbuild = requireFromDeps('esbuild')
const nodePaths = [
  path.join(path.dirname(path.resolve(depsPkg)), 'node_modules'),
  path.join(path.dirname(path.resolve(depsPkg)), 'apps', 'desktop', 'node_modules'),
  path.join(path.dirname(path.resolve(depsPkg)), 'apps', 'desktop', 'renderer', 'node_modules'),
].filter((p) => fs.existsSync(p))

function resolveElectronBinary() {
  for (const nm of nodePaths) {
    const candidate = path.join(
      nm,
      'electron',
      'dist',
      process.platform === 'win32' ? 'electron.exe' : 'electron',
    )
    if (fs.existsSync(candidate)) return candidate
  }
  throw new Error('Could not find electron binary via ORGTREE_TEST_DEPS')
}

function readGitFile(sha, relPath) {
  return execFileSync('git', ['-C', repoRoot, 'show', `${sha}:${relPath}`], {
    encoding: 'utf8',
  })
}

async function buildBundle(outfile, overrideFiles = {}) {
  const normOverrides = new Map(
    Object.entries(overrideFiles).map(([absPath, contents]) => [
      path.resolve(absPath).replace(/\\/g, '/').toLowerCase(),
      contents,
    ]),
  )
  const plugin = {
    name: 'in-memory-base-overrides',
    setup(build) {
      build.onLoad({ filter: /\.(tsx?|js)$/ }, (args) => {
        const key = path.resolve(args.path).replace(/\\/g, '/').toLowerCase()
        if (!normOverrides.has(key)) return null
        const ext = path.extname(args.path).slice(1)
        return {
          contents: normOverrides.get(key),
          loader: ext === 'tsx' ? 'tsx' : ext === 'ts' ? 'ts' : 'js',
          resolveDir: path.dirname(args.path),
        }
      })
    },
  }
  await esbuild.build({
    entryPoints: [path.join(rendererDir, 'tests', 'askfoldheader.visual.tsx')],
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'es2022',
    jsx: 'automatic',
    outfile,
    nodePaths,
    plugins: [plugin],
    logLevel: 'silent',
  })
}

function writeHtml(htmlPath, cssFile, jsFile, title) {
  const html = `<!doctype html>
<html lang="en" class="theme-dark">
<head>
  <meta charset="utf-8" />
  <title>${title}</title>
  <link rel="stylesheet" href="/${cssFile}" />
</head>
<body style="margin:0;background:var(--bg);color:var(--ink);">
  <div id="root"></div>
  <script src="/${jsFile}"></script>
</body>
</html>`
  fs.writeFileSync(htmlPath, html, 'utf8')
}

async function main() {
  fs.mkdirSync(outDir, { recursive: true })

  // 1. Build "before" bundle & stylesheet from baseSha in-memory via git show
  const baseAsks = readGitFile(baseSha, 'apps/desktop/renderer/src/canvas/asks.tsx')
  const baseAnswered = readGitFile(baseSha, 'apps/desktop/renderer/src/events/answered.tsx')
  const baseSubmitted = readGitFile(baseSha, 'apps/desktop/renderer/src/asksubmitted.ts')
  const baseCss = readGitFile(baseSha, 'apps/desktop/renderer/src/styles.css')

  await buildBundle(path.join(outDir, 'before.js'), {
    [path.join(rendererDir, 'src', 'canvas', 'asks.tsx')]: baseAsks,
    [path.join(rendererDir, 'src', 'events', 'answered.tsx')]: baseAnswered,
    [path.join(rendererDir, 'src', 'asksubmitted.ts')]: baseSubmitted,
  })
  fs.writeFileSync(path.join(outDir, 'before.css'), baseCss, 'utf8')
  writeHtml(path.join(outDir, 'before.html'), 'before.css', 'before.js', 'Before Ask Fold Header Fix')

  // 2. Build "after" bundle & stylesheet from current working tree
  await buildBundle(path.join(outDir, 'after.js'))
  fs.copyFileSync(path.join(rendererDir, 'src', 'styles.css'), path.join(outDir, 'after.css'))
  writeHtml(path.join(outDir, 'after.html'), 'after.css', 'after.js', 'After Ask Fold Header Fix')

  // 3. Run isolated Session 0 Electron capture
  const electronBin = resolveElectronBinary()
  const cjsRunner = path.join(repoRoot, 'tools', 'rig', 'desktop', 'ask-fold-header-visual.cjs')
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE

  const res = spawnSync(electronBin, [cjsRunner, '--out', outDir], {
    stdio: 'inherit',
    env,
  })
  if (res.status !== 0) {
    throw new Error(`Electron capture exited with status ${res.status}`)
  }

  const summary = JSON.parse(fs.readFileSync(path.join(outDir, 'result.json'), 'utf8'))
  console.log(
    JSON.stringify({
      ok: summary.ok,
      childPid: summary.childPid,
      sessionId: summary.sessionId,
      audioMuted: summary.audioMuted,
      clipboardIsolated: summary.clipboardIsolated,
      checks: summary.checks,
      beforeUnfoldedPng: path.join(outDir, 'before-unfolded.png'),
      beforeFoldedPng: path.join(outDir, 'before-folded.png'),
      afterUnfoldedPng: path.join(outDir, 'after-unfolded.png'),
      afterFoldedPng: path.join(outDir, 'after-folded.png'),
    }),
  )
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
