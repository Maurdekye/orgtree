import { createRoot } from 'react-dom/client'
import { ProjectCreditFixture } from './projectcredit-fixture'
import '../src/styles.css'

createRoot(document.getElementById('root')!).render(<main style={{padding:24}}>
  <div style={{display:'flex',gap:36}}>{[false,true].map(grouped=><section key={String(grouped)} data-group={grouped?'project':'direct'} style={{width:440}}>
    <h3>{grouped?'Same agents in nested projects':'Direct agent reports'}</h3>
    <div style={{position:'relative',height:290}}><ProjectCreditFixture surface="canvas" grouped={grouped}/></div>
    <ProjectCreditFixture surface="settings" grouped={grouped}/>
  </section>)}</div>
</main>)
