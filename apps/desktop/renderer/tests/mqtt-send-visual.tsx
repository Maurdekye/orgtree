import { createRoot } from 'react-dom/client'
import { WatchdogPanel } from '../src/canvas/modals'
const dog = { id:'synthetic/replies',owner:'synthetic',name:'Reply channel',kind:'mqtt' as const,
  target:'mqtt://broker.example.test:1883',pattern:'jobs/#',state:'armed' as const,interval_s:5,
  fired:2,once:false,spent:false,at:new Date().toISOString(),events:[],sent:3,last_sent_at:new Date().toISOString(),
  connection:{state:'connected' as const,since:new Date().toISOString()} }
globalThis.fetch = (async()=>new Response('{}',{status:200})) as typeof fetch
createRoot(document.getElementById('root')!).render(<WatchdogPanel slug="synthetic" dog={dog} toast={()=>{}} close={()=>{}} />)
