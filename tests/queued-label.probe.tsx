import React from 'react'
import {createRoot} from 'react-dom/client'
import {PendingMailRow} from '../apps/desktop/renderer/src/canvas/desk'
const row={id:'receipt',from:'@user',kind:'message',body:'Queued message body',at:'2026-09-10T14:26:21Z',delivering:true,stage:'queued' as const}
createRoot(document.getElementById('root')!).render(<div className="msgs">
  <PendingMailRow m={row} slug="fixture" nid="a"/>
  <PendingMailRow m={{...row,id:'typed',ev:{v:1,variant:'ordinary.message',actor:{kind:'user',id:'@user'},object:null,engine_authored:false,body:row.body}} as any} slug="fixture" nid="a"/>
</div>)
