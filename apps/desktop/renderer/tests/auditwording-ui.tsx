import { createRoot } from 'react-dom/client'
import { DefaultsForm } from '../src/shell/defaults'
import { TurnLimitsSetting } from '../src/canvas/turnlimitssetting'
import { shortcutGroups } from '../src/shortcuts'
import '../src/styles.css'
import '../src/shell.css'

globalThis.fetch = async () => new Response(JSON.stringify({
  max_top_grant: 1000, default_top_grant: 20, compact_at: 0.8,
  default_effort: '', auto_resume: true, turn_timeout_s: 86400, turn_idle_s: 600,
}), { status: 200, headers: { 'Content-Type': 'application/json' } })
document.documentElement.dataset.theme = 'dark'
Object.assign(window, { auditQuickChat: shortcutGroups().find(g => g.title === 'Quick chat') })
createRoot(document.getElementById('root')!).render(
  <main style={{ maxWidth: 860, margin: '24px auto', padding: 24 }}>
    <DefaultsForm toast={() => {}} />
    <TurnLimitsSetting />
  </main>,
)
