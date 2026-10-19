import {createRoot} from 'react-dom/client'
import {AttentionDeselectFixture,installAttentionServer} from './attentiondeselect-fixture'
import '../src/styles.css'
import '../src/attention/attention.css'

const state=installAttentionServer()
;(window as unknown as {attentionFixture:typeof state}).attentionFixture=state
document.documentElement.dataset.theme='dark'
createRoot(document.getElementById('root')!).render(<main style={{padding:24,height:640,display:'flex',flexDirection:'column'}}>
  <h3>Needs attention</h3><p>Mail mentioning @user uses the inbox reading pane.</p>
  <section style={{flex:1,minHeight:0,display:'flex'}}><AttentionDeselectFixture/></section>
</main>)
