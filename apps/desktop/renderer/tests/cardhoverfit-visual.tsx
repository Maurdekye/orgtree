import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import { CardHoverCard } from './cardhoverfit-fixture'
function Fixture() {
  const [state, setState] = useState({ lod: 'norm' as 'norm' | 'mini', crowded: false, serial: 0 })
  Object.assign(window, { cardHoverFixture: {
    render: (lod: 'norm' | 'mini', crowded: boolean) => setState(s => ({ lod, crowded, serial: s.serial + 1 })),
    refresh: () => setState(s => ({ ...s, serial: s.serial + 1 })),
  } })
  return <><div style={{position:'absolute',left:35,top:15}}>Agent / project · stable fit while revealing long names</div>
    <div className="space" style={{position:'absolute',left:25,top:30,width:700,height:350,transform:'scale(1.5)',transformOrigin:'top left'}}>
      <CardHoverCard kind="agent" {...state} /><CardHoverCard kind="project" {...state} />
    </div></>
}
document.body.style.cssText='margin:0;background:var(--bg);color:var(--ink);font:14px sans-serif'
createRoot(document.getElementById('root')!).render(<Fixture />)
