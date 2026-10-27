// customapps-firebody.test.tsx — A FIRE'S BODY AS IT WAS SENT (USER 2026-10-27
//   mda08162683ef "this should show the event's body as it was transmitted";
//   mc308cabf3c5f "Save exactly" and "Agents see bodies").
// An expanded fire in History (Connections and the Fire event list use the same
// details) shows the body the engine kept: its size, and its text laid out
// without changing one token.
//   §1 the layout changes only the space between tokens
//   §2 History: a fire's body as sent, a fire whose body was not kept, a start
//
// Run:  cd apps/desktop/renderer && node tests/run.mjs customapps-firebody
import {flush,inAct,mountView} from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import {PanelHistory,layoutJson} from '../src/canvas/apps/events'

// key order, a decimal and an exponent as written, escapes, brackets and commas inside a string
const SENT='{"z":1,"a":{"y":"é","b":[1,2.50,null,true,1e2]},"e":{},"l":[],"note":"tab\\tquote\\" brace{ [x], y: z"}'

test('§1 the layout changes only the space between tokens: strings, numbers and key order stay as sent', () => {
  const laid=layoutJson(SENT)
  assert.equal(laid,[
    '{',
    '  "z": 1,',
    '  "a": {',
    '    "y": "é",',
    '    "b": [',
    '      1,',
    '      2.50,',
    '      null,',
    '      true,',
    '      1e2',
    '    ]',
    '  },',
    '  "e": {},',
    '  "l": [],',
    '  "note": "tab\\tquote\\" brace{ [x], y: z"',
    '}',
  ].join('\n'))
  assert.equal(layoutJson(laid),laid,'laying out a laid-out body changes nothing')
  // a body kept from before 4.5.0 comes as PostgreSQL prints it: the same layout
  assert.equal(layoutJson('{"a": [1, 2], "z": 1}'),layoutJson('{"a":[1,2],"z":1}'))
  assert.equal(layoutJson('"just text"'),'"just text"')
})

test('§2 History: an expanded fire shows its body as sent and its size; one not kept says so; a start has no body',async t=>{
  const panel={id:'one',app:'notes',label:'First',rev:1,open:true,running:true,placement:{mode:'float' as const,x:0,y:0,width:360,height:280},used_at:'',event_seq:3,updated_at:''}
  const at=(s:number)=>new Date(Date.UTC(2026,9,27,6,0,s)).toISOString()
  const events=[
    {seq:3,name:'event.fired',payload:{event:'run.ended',id:'app-event-3',subscribers:1},body:SENT,actor:'boss',at:at(3)},
    {seq:2,name:'event.fired',payload:{event:'run.ended',id:'app-event-2',subscribers:0},body:null,actor:'app',at:at(2)},
    {seq:1,name:'panel.started',payload:{reason:'opened'},body:null,actor:'user',at:at(1)},
  ]
  const original=globalThis.fetch
  globalThis.fetch=(async(raw:RequestInfo|URL,init?:RequestInit)=>{
    const url=new URL(String(raw),'http://local'),input=init?.method==='POST'?JSON.parse(String(init.body)):JSON.parse(url.searchParams.get('request')??'{}')
    const out=input.action==='events'?{panel:'one',events,next_cursor:null,oldest_retained:1}:{items:[],next_cursor:null}
    return new Response(JSON.stringify(out),{headers:{'Content-Type':'application/json'}})
  }) as typeof fetch
  t.after(()=>{globalThis.fetch=original})
  const view=await mountView(<PanelHistory slug="fire-body" panel={panel}/>,e=>e);t.after(()=>view.unmount())
  await inAct(async()=>{for(let i=0;i<6;i++)await flush()})
  const rows=[...document.querySelectorAll<HTMLButtonElement>('ol[aria-label="History"] > li > button[aria-expanded]')]
  assert.equal(rows.length,3)
  const open=async(b:HTMLButtonElement)=>{await inAct(async()=>{b.click();for(let i=0;i<4;i++)await flush()});return document.getElementById(b.getAttribute('aria-controls')??'')!}
  const sent=await open(rows[0]!)
  const body=sent.querySelector<HTMLElement>('pre[aria-label="Event body"]')
  assert.equal(body?.textContent,layoutJson(SENT),'the body, laid out, every token as sent')
  assert.match(sent.textContent??'',new RegExp(`Body${new TextEncoder().encode(SENT).length} bytes as sent`))
  assert.equal(body?.tabIndex,0,'a long body scrolls, from the keyboard too')
  const gone=await open(rows[1]!)
  assert.match(gone.textContent??'',/BodyNot kept/);assert.equal(gone.querySelector('pre'),null,'no metadata stands in for a body that was not kept')
  const start=await open(rows[2]!)
  assert.match(start.textContent??'',/CauseOpened/);assert.equal(start.textContent?.includes('Body'),false,'a start has no body')
})
