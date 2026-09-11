import * as esbuild from 'esbuild'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
const out = path.resolve('node_modules/.orgtree-usagewrap')
const mutation = process.argv[2]
const MUTATIONS = {
  // the grid itself
  'single-column': [['grid-template-columns: repeat(auto-fit, minmax(min(100%, 320px), 1fr));',
    'grid-template-columns: 1fr;']],
  // ⚠ THE DEFECT THE USER PHOTOGRAPHED, put back: the head centred its
  // two sides and the refresh block was free to wrap its own children,
  // so a long identity pushed the age under the button on that card
  // alone. If restoring this does NOT turn the probe red, the probe is
  // not measuring what it claims to.
  'old-head': [['.usage-acct-head { font-size: 13px; display: flex; align-items: flex-start;',
    '.usage-acct-head { font-size: 13px; display: flex; align-items: center;'],
    ['.usage-refresh { display: flex; flex-direction: column; align-items: flex-end;',
      '.usage-refresh { display: inline-flex; align-items: center; flex-wrap: wrap;'],
    ['  flex: 0 1 auto; max-width: 50%; text-align: right; gap: 3px; font-size: 10px; }',
      '  justify-content: flex-end; gap: 5px; font-size: 10px; }'],
    ['.usage-refresh-line { display: inline-flex; align-items: center; flex: none;\r\n  gap: 5px; }',
      '.usage-refresh-line { display: contents; }']],
}
if (mutation && !(mutation in MUTATIONS)) throw new Error('Unknown mutation')
const plugins = mutation ? [{ name: mutation, setup(build) {
  build.onLoad({ filter: /styles\.css$/ }, ({ path: file }) => {
    let text = readFileSync(file, 'utf8')
    for (const [before, after] of MUTATIONS[mutation]) {
      if (text.split(before).length !== 2) throw new Error('INERT ' + mutation + ': ' + before)
      text = text.replace(before, after)
    }
    return { contents: text, loader: 'css' }
  })
} }] : []
mkdirSync(out, { recursive: true })
await esbuild.build({ entryPoints: ['tests/usagewrap-fixture.tsx'], outdir: out, bundle: true, format: 'esm', jsx: 'automatic', plugins })
writeFileSync(path.join(out, 'source.json'), JSON.stringify({ mutation: mutation ?? null }))
