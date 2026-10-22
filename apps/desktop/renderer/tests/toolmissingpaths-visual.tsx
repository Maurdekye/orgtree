import { createRoot } from 'react-dom/client'
import { ToolChip } from '../src/canvas/desk'
import '../src/styles.css'

const existing = 'C:/synthetic/project/README.md'
Object.defineProperty(window, 'orgtreeDesktop', { configurable: true, value: {
  localFileStatus: async (path: string) => ({ ok: true, exists: path === existing }),
  revealFile: async () => { throw Error('capture must not reveal files') },
} })
const tools = [
  { id: 'missing-read', name: 'Read', arg: 'C:/synthetic/project/docs/guide.md', file_paths: [{ path: 'C:/synthetic/project/docs/guide.md', link: true }] },
  { id: 'missing-write', name: 'write_file', file_paths: [{ path: 'D:\\synthetic\\project\\new folder\\settings.json', link: true }] },
  { id: 'relative', name: 'Edit', file_paths: [{ path: '../unknown/package.json', link: false }] },
  { id: 'existing', name: 'Read', file_paths: [{ path: existing, link: true }] },
]
createRoot(document.getElementById('root')!).render(<main style={{ padding: 28, width: 940 }}>
  <h2>Tool paths</h2>
  <p className="dim">Missing paths keep the attempted location. Existing files keep their normal links.</p>
  <section className="msg" style={{ padding: 18, marginTop: 24, minHeight: 210 }}>
    {tools.map(tool => <div key={tool.id} style={{ marginBottom: 20 }}><ToolChip t={tool} slug="synthetic" nid="fixture" /></div>)}
  </section>
</main>)
document.body.dataset.ready = 'true'
