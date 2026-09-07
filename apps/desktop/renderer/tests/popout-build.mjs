import * as esbuild from 'esbuild'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
const out = path.resolve('node_modules/.orgtree-popout-probe')
const mutation = process.argv[2]
const mutations = {
  'no-org-map-guard': ['src/canvas/OrgCanvas.tsx', 'treeSlug={tree.slug}', ''],
  'no-cascade-order': ['src/popout.tsx', 'if (previous) previous.replaceWith(copy)', 'if (previous) { previous.remove(); d.head.appendChild(copy) }'],
  'no-rollback': ['src/popout.tsx', 'destination().appendChild(parts.container)', '/* deliberately leave container in dead child */'],
  'no-failure-rollback': ['src/popout.tsx', '} catch (e) {\n      redock()', '} catch (e) {\n      epoch.current++ /* deliberately omit transactional recovery */'],
  'no-capture-guard': ['src/popout.tsx', 'return (e.target as Node | null)?.ownerDocument !== (e.currentTarget as Node).ownerDocument', 'return false'],
  'no-bubble-guard': ['src/popout.tsx', 'onClick={detached ? stop : undefined}', 'onClick={undefined}'],
  'no-restart-latch': ['src/windowlife.ts', 'if (restart || openSurfaces().some((s) => s.editable))', 'if (openSurfaces().some((s) => s.editable))'],
}
if (mutation && !mutations[mutation]) throw new Error(`Unknown mutation ${mutation}`)
const plugins = mutation ? [{ name: mutation, setup(build) {
  const [file, old, replacement] = mutations[mutation]
  build.onLoad({ filter: /\.[tj]sx?$/ }, ({ path: filePath }) => {
    if (path.resolve(file) !== filePath) return
    const source = readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n')
    if (source.split(old).length !== 2) throw new Error(`Mutation must match once: ${mutation}`)
    let contents = source.replace(old, replacement)
    if (mutation === 'no-cascade-order') {
      const order = 'if (copy.nextElementSibling !== next) d.head.insertBefore(copy, next)'
      if (contents.split(order).length !== 2) throw new Error('Cascade-order mutation must match once')
      contents = contents.replace(order, '/* deliberately omit source order correction */')
    }
    return { contents, loader: filePath.endsWith('tsx') ? 'tsx' : 'ts' }
  })
} }] : []
mkdirSync(out, { recursive: true })
await esbuild.build({ entryPoints: ['tests/popout-fixture.tsx'], bundle: true,
  outdir: out, format: 'esm', jsx: 'automatic', loader: { '.woff2': 'file' }, plugins })
writeFileSync(path.join(out, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/popout-fixture.css"></head><body><div id="root"></div><script type="module" src="/popout-fixture.js"></script></body></html>')
