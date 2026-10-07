#!/usr/bin/env node
// tools/rig/build-ui.mjs [--dev]: build THIS worktree's renderer for a rig
// run (`rig up --ui <dir>`), into the rig home (never into the repository).
// --dev: unminified React development build with source maps, so a crash
// reads as names and a full message instead of "Minified React error #185".
//
// Vite and React resolve the normal way, walking up from this worktree to
// the nearest node_modules (a sibling checkout's real install); nothing is
// linked or copied.

import fs from 'node:fs'
import path from 'node:path'

import { REPO, rigHome } from './lib.mjs'

const dev = process.argv.includes('--dev')
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '')
const outDir = path.join(rigHome(), 'ui', `${dev ? 'dev' : 'prod'}-${stamp}`)
const { build } = await import('vite')
await build({
  root: path.join(REPO, 'apps', 'desktop', 'renderer'),
  base: '/',
  mode: dev ? 'development' : 'production',
  logLevel: 'warn',
  define: dev ? { 'process.env.NODE_ENV': '"development"' } : undefined,
  build: { outDir, emptyOutDir: true, minify: !dev, sourcemap: dev },
})
// as tools/build.mjs: the favicon is copied, not a second source
fs.copyFileSync(path.join(REPO, 'apps', 'desktop', 'assets', 'orgtree-eye.svg'), path.join(outDir, 'assets', 'orgtree-eye.svg'))
console.log(JSON.stringify({ ui: outDir, dev }))
