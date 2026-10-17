// A measurement-only renderer bundle. Inject observations into the bundle,
// never into production sources; dependency resolution requires no junction.
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
const repo = process.env.ORGTREE_STREAM_SOURCE || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const deps = process.env.ORGTREE_TEST_DEPS || 'E:/Libraries/Desktop/orgtree/node_modules'
const require = createRequire(path.join(deps, '_resolve.cjs'))
const esbuild = require('esbuild')
const out = process.argv[2]
if (!out || !/^C:\/orgtree-build\/uninit-model-sol\//i.test(out.replaceAll('\\', '/'))) throw Error('own C output required')
fs.mkdirSync(out, { recursive: true })
const observe = `
globalThis.__streamProbe = null;
const NativeWebSocket = globalThis.WebSocket;
globalThis.WebSocket = class extends NativeWebSocket {
  constructor(...args) { super(...args); this.addEventListener('message', e => {
    const p = globalThis.__streamProbe; if (!p) return;
    try { const v = JSON.parse(e.data); if (v.type === 'node_stream' && ['delta','thinking'].includes(v.kind))
      p.wire.push({at:Date.now(), node:v.node, kind:v.kind, size:(v.text||'').length}); } catch {}
  }); }
};`
await esbuild.build({ entryPoints: [path.join(repo, 'apps/desktop/renderer/src/main.tsx')], outdir: out,
  bundle: true, platform: 'browser', format: 'esm', jsx: 'automatic', nodePaths: [deps],
  define: { 'process.env.NODE_ENV': '"production"' }, banner: { js: observe },
  loader: { '.svg': 'dataurl', '.png': 'dataurl', '.woff2': 'dataurl' }, logLevel: 'warning',
  plugins: [{ name: 'cadence-observers', setup(build) {
    build.onLoad({ filter: /[/\\]canvas[/\\]desk\.tsx$/ }, async ({ path: source }) => {
      let contents = fs.readFileSync(source, 'utf8').replaceAll('\r\n','\n')
      const desk = '  const node = useNodeMetadata(slug, baseNode)'
      const msg = contents.indexOf('export const Msg = memo(function Msg(')
      const body = contents.indexOf('}) {', msg)
      if (!contents.includes(desk) || msg < 0 || body < 0) throw Error('desk observation anchors changed')
      contents = contents.slice(0,body+4) + `
        const renderInstance = useRef<number | null>(null);
        const renderProbe = (globalThis as any).__streamProbe;
        if (renderProbe) {
          if (renderInstance.current === null) renderInstance.current = renderProbe.nextMsgId = (renderProbe.nextMsgId ?? 0) + 1;
          renderProbe.msgRenders.push({at:Date.now(),role:m.role,id:m.row_id,instance:renderInstance.current});
        }
` + contents.slice(body+4)
      contents = contents.replace(desk, `  if ((globalThis as any).__streamProbe) (globalThis as any).__streamProbe.deskRenders++;
` + desk)
      return {contents,loader:'tsx'}
    })
    build.onLoad({ filter: /[/\\]convo\.ts$/ }, async ({ path: source }) => {
      let contents = fs.readFileSync(source, 'utf8')
      const a = 'export function ingestStream(slug: string, ev: StreamEvent): void {'
      const b = '  e.s = { ...e.s, ...p }\n  e.subs.forEach((cb) => cb())'
      const lf = contents.replaceAll('\r\n', '\n')
      if (!lf.includes(a) || !lf.includes(b)) throw Error('cadence instrumentation anchors changed')
      contents = lf.replace(a, a + `
        const probe = (globalThis as any).__streamProbe;
        if (probe && ['delta','thinking'].includes(ev.kind)) probe.ingest.push({at:Date.now(),node:ev.node,kind:ev.kind,size:ev.text.length});`)
        .replace(b, `  const probe = (globalThis as any).__streamProbe;
        if (probe && ('draft' in p || 'thinking' in p)) probe.publish.push({at:Date.now(),key:e.ownerKey,draft:p.draft?.length,thinking:p.thinking?.length});
` + b)
      return { contents, loader: 'ts' }
    })
  } }],
})
await esbuild.stop()
const html = fs.readFileSync(path.join(repo, 'apps/desktop/renderer/index.html'), 'utf8')
  .replace('<script type="module" src="/src/main.tsx"></script>', '<link rel="stylesheet" href="/main.css"><script type="module" src="/main.js"></script>')
fs.writeFileSync(path.join(out, 'index.html'), html)
console.log(JSON.stringify({ fixtureBundle: out }))
