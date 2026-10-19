import { createRoot } from 'react-dom/client'
import { ToolChip } from '../src/canvas/desk'
import '../src/styles.css'

const tools = [
  {
    id: 'read-config',
    name: 'Read',
    arg: 'C:\\workspace\\settings.json',
    file_paths: [{ path: 'C:\\workspace\\settings.json', link: true }],
  },
  {
    id: 'skill-review',
    name: 'Skill',
    arg: 'review',
    file_paths: [{ path: 'C:\\workspace\\skills\\review\\SKILL.md', link: true }],
  },
  {
    id: 'edit-config',
    name: 'Edit',
    arg: 'C:\\workspace\\settings.json',
    file_paths: [{ path: 'C:\\workspace\\settings.json', link: true }],
  },
]

createRoot(document.getElementById('root')!).render(
  <main style={{ padding: 24, width: 900 }}>
    <h2>Transcript file link</h2>
    <p>Tool paths stay attached to the call and open the file location.</p>
    {tools.map(tool => <ToolChip key={tool.id} t={tool} slug="fixture" nid="agent" />)}
  </main>,
)

document.body.dataset.ready = 'true'
