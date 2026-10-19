import { createRoot } from 'react-dom/client'
import { ToolChip } from '../src/canvas/desk'
import '../src/styles.css'

const file = 'C:\\synthetic\\scratch\\cancel-next.png'
Object.defineProperty(window, 'orgtreeDesktop', { configurable: true, value: {
  localFileStatus: async (path: string) => ({ ok: true, exists: path === file }),
  openLocalFile: async () => ({ ok: true }),
  revealFile: async () => ({ ok: true }),
} })

createRoot(document.getElementById('root')!).render(
  <main style={{ padding: 24, width: 900, color: 'var(--text)' }}>
    <h2>Tool-row file context menu</h2>
    <p>Right-click the filename to open, reveal, or copy its path.</p>
    <ToolChip t={{ id: 'capture-read', name: 'Read',
      file_paths: [{ path: file, link: true }], images: 1 }} slug="synthetic" nid="fixture" />
  </main>,
)
document.body.dataset.ready = 'true'
