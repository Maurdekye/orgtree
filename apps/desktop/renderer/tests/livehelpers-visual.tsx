import { createRoot } from 'react-dom/client'
import { DeskHead } from '../src/canvas/deskshell'
import { LiveHelpersBadge } from '../src/canvas/livehelpers'
import '../src/styles.css'
import '../src/shell.css'
document.body.style.cssText='margin:0;background:var(--bg);color:var(--ink);font:14px system-ui'
createRoot(document.getElementById('root')!).render(<div style={{padding:20}}>
  <div className="eye-chat" style={{height:600,width:'100%',border:'1px solid var(--line)'}}>
    <DeskHead nodeId="synthetic-worker" left={<><strong>Synthetic worker</strong><LiveHelpersBadge slug="fixture" nid="synthetic-worker" count={2}/></>}
      tabs={<span>Chat</span>} />
    <div style={{padding:20}}>Real renderer · synthetic helper activity</div>
  </div>
</div>)
