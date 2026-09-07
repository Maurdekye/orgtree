import { createRoot } from 'react-dom/client'
import '../src/styles.css'
import { ProcessWarmMark } from '../src/canvas/desk'

function Desk({ codex, warm }: { codex?: boolean; warm: boolean }) {
  return <section className={'sq desk tier-' + (codex ? 'terra prov-openai' : 'opus')
    + (warm ? ' proc-warm' : ' proc-cold')}>
    <div className="cc-head"><span className={'tier t-' + (codex ? 'terra' : 'opus')}>{codex ? 'T' : 'O'}</span>
      <b className="cc-name">{codex ? 'codex-cold' : 'claude-warm'}</b><ProcessWarmMark warm={warm} /></div>
    <p>{warm ? 'ready process · next turn is warm' : 'normal cold start · agent remains live'}</p>
  </section>
}

createRoot(document.querySelector('#root')!).render(<>
  <style>{`body{padding:42px;background:#181818}.warm-probe{display:flex;gap:28px}.warm-probe .sq{position:relative;transform:none;width:300px;height:145px;padding:18px;box-sizing:border-box}.warm-probe p{color:#aaa;margin:20px 0;font:13px var(--mono)}`}</style>
  <div className="warm-probe"><Desk warm /><Desk codex warm={false} /></div>
</>)
