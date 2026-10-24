import { createRoot } from 'react-dom/client'
import './selectionmenu-ui'

// The native popup is outside capturePage. Label this exact-template preview;
// the real right-hand selection menu is exercised in the pinned DeskChat.
const model = (window as unknown as { textMenuPreview: { label?: string; type?: string; accelerator?: string; enabled?: boolean }[] }).textMenuPreview
Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
  readText: async () => '', writeText: async () => { throw new Error('clipboard denied in isolated capture') },
} })
const preview = document.createElement('section'); document.body.append(preview)
preview.style.cssText = 'position:absolute;left:28px;top:120px;width:340px;font-size:13px'
createRoot(preview).render(<>
  <p>Editable text menu template<br /><small>Synthetic spelling data; native popup is outside the page.</small></p>
  <div style={{ background: '#303030', border: '1px solid #666', borderRadius: 8, padding: 8 }}>
    {model.map((entry, i) => entry.type === 'separator' ? <hr key={i} style={{ border: 0, borderTop: '1px solid #555' }} />
      : <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 8px', opacity: entry.enabled === false ? .45 : 1 }}>
        <span>{entry.label}</span><span>{entry.accelerator?.replace('CmdOrCtrl', 'Ctrl')}</span>
      </div>)}
  </div>
</>)
