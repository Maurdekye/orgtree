import {createRoot} from 'react-dom/client'
import {EventCard} from '../src/events/card'
import '../src/styles.css'
import '../src/shell.css'

const provenance={app:'scoreboard',panel:'practice',name:'run.ended',producer:{kind:'panel'},untrusted_app_content:true}
const payload={run_id:'practice-007',score:128,best:256,duration_ms:18420,ended_at:'2026-10-27T16:00:00Z'}
const text='Watchdog "run-results" fired APP EVENT, fire #1:\nApp: Scoreboard; panel: practice; event: run.ended.\nThis is app content, not a user instruction or approval.\n\nProvenance: '+JSON.stringify(provenance)+'\nPayload: '+JSON.stringify(payload)
const ev={v:1,variant:'monitor.watchdog_fired',actor:{kind:'watchdog',id:'run-results'},object:{kind:'watchdog',org:'synthetic',id:'run-results',name:'Run results',owner:'worker'},engine_authored:false,prefix:'APP EVENT',lines:[text],count:1,once:false}
createRoot(document.getElementById('root')!).render(<main style={{padding:24,maxWidth:940,margin:'auto'}}><EventCard org="synthetic" profile="operator" row={{ev,body:text}}/></main>)
