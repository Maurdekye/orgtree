import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
const here = path.dirname(fileURLToPath(import.meta.url))
const out = process.argv[2]
if (!out) throw new Error('Supply a new throwaway output directory')
mkdirSync(out, { recursive: true })
await build({ entryPoints: [path.join(here, 'provider-theme-probe.tsx')],
  outfile: path.join(out, 'probe.js'), bundle: true, platform: 'browser',
  format: 'iife', jsx: 'automatic', logLevel: 'warning' })
writeFileSync(path.join(out, 'probe.css'), readFileSync(path.join(here, '../src/styles.css')))
writeFileSync(path.join(out, 'probe.html'), '<!doctype html><meta charset="utf-8">'
  + '<link rel="stylesheet" href="probe.css"><body><div id="root"></div>'
  + '<script src="probe.js"></script></body>')
