import { createRoot } from 'react-dom/client'
import { ToolChip } from '../src/canvas/desk'
import '../src/styles.css'

const tool = {
  id: 'read-config',
  name: 'Read',
  arg: 'C:\\workspace\\settings.json',
  file_paths: [{ path: 'C:\\workspace\\settings.json', link: true }],
}

createRoot(document.getElementById('root')!).render(
  <main style={{ padding: 24, width: 900 }}>
    <h2>Transcript file link</h2>
    <p>Tool paths stay attached to the call and open the file location.</p>
    <ToolChip t={tool} slug="fixture" nid="agent" />
  </main>,
)

document.body.dataset.ready = 'true'
