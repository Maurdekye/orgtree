import { createRoot } from 'react-dom/client'
import { ThemeSetting, startThemeSync } from '../src/themes'
import '../src/styles.css'
import '../src/shell.css'
globalThis.fetch = async () => new Response(JSON.stringify({ providers: [] }), { status: 200 })
localStorage.clear(); localStorage.setItem('orgtree-visual-theme', 'orgtree')
startThemeSync()
document.documentElement.dataset.theme = 'dark'
document.body.style.cssText = 'margin:0;padding:30px;background:#202020;color:#ddd'
createRoot(document.getElementById('root')!).render(<div className="settings" style={{ maxWidth: 760, margin: '0 auto' }}>
  <h2>Display</h2><ThemeSetting /></div>)
