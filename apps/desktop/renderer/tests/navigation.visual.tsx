import { createRoot } from 'react-dom/client'
import { ShortcutsSettings } from '../src/canvas/shortcutsettings'
import '../src/styles.css'

createRoot(document.getElementById('root')!).render(
  <div className="settings" style={{ width: 960, maxWidth: '100%', maxHeight: 'none', padding: 16, margin: 'auto' }}>
    <h1 style={{ fontSize: 24, margin: '8px 0 16px' }}>Keyboard shortcuts</h1><ShortcutsSettings mac={false} />
  </div>)
