import {createRoot} from 'react-dom/client'
import {NodeConfig} from '../src/canvas/modals'
import {ackProject,ackTree,mockAckSettings} from './acksettings-fixture'
import '../src/styles.css'
mockAckSettings()
const node=ackProject({mail_queue:'ack',slots_capacity:2,mail_queue_ack_reminders:5})
createRoot(document.getElementById('root')!).render(<NodeConfig node={node} map={new Map([[node.id,node]])}
  tree={ackTree} slug="synthetic" op={async()=>({} as any)} toast={()=>{}} close={()=>{}} />)
