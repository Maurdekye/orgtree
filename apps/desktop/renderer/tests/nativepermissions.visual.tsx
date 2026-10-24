import { createRoot } from 'react-dom/client'
import { NativeReplacementToggle } from '../src/canvas/nativepermissions'
import { SetGroup, SetToggle } from '../src/canvas/settingskit'

document.body.style.cssText = 'margin:0;background:var(--bg);color:var(--ink);font:14px sans-serif'
createRoot(document.getElementById('root')!).render(<main className="settings-body" style={{ maxWidth: 760, margin: '28px auto', padding: 20 }}>
  <h2>Agent tools</h2>
  <SetGroup title="Native tools">
    <SetToggle label="Use helper agents" hint="Delegate tasks to temporary helper agents within the harness." checked onChange={() => {}} />
    <NativeReplacementToggle checked={false} harness="claude-code" onChange={() => {}} />
  </SetGroup>
  <SetGroup title="Muse · enabled">
    <NativeReplacementToggle checked harness="muse" onChange={() => {}} />
  </SetGroup>
  <SetGroup title="Codex · superior permission off">
    <NativeReplacementToggle checked={false} disabled harness="codex-cli" onChange={() => {}} />
  </SetGroup>
</main>)
