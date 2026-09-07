import * as esbuild from 'esbuild'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
const out = path.resolve('node_modules/.orgtree-usagewrap')
const mutation = process.argv[2]
if (mutation && mutation !== 'single-column') throw new Error('Unknown mutation')
const plugins = mutation ? [{ name: mutation, setup(build) {
  build.onLoad({ filter: /styles\.css$/ }, ({ path: file }) => {
    const text = readFileSync(file, 'utf8')
    const before = 'grid-template-columns: repeat(auto-fit, minmax(min(100%, 320px), 1fr));'
    if (text.split(before).length !== 2) throw new Error('INERT grid mutation')
    return { contents: text.replace(before, 'grid-template-columns: 1fr;'), loader: 'css' }
  })
} }] : []
mkdirSync(out, { recursive: true })
await esbuild.build({ entryPoints: ['tests/usagewrap-fixture.tsx'], outdir: out, bundle: true, format: 'esm', jsx: 'automatic', plugins })
writeFileSync(path.join(out, 'source.json'), JSON.stringify({ mutation: mutation ?? null }))
