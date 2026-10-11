import path from 'node:path'
import { RIG_DIR } from '../lib.mjs'
import { runDesktop } from '../desktop.mjs'
import { Proof } from '../proof.mjs'
import { startFakeLlm } from '../fakellm.mjs'

function steps(codex, thoughtFirst) {
  const blocks = thoughtFirst ? [['thinking','REASON_FIRST'], ['text','REPLY_SECOND']] : [['text','REPLY_FIRST'], ['thinking','REASON_SECOND']]
  const out = [], done = []
  for (const [index, [kind, text]] of blocks.entries()) {
    const thinking = kind === 'thinking', id = `part-${index}`
    if (codex) {
      const item = { type: thinking ? 'reasoning' : 'agentMessage', id, text: '', summary: [] }
      out.push({ raw: { method: 'item/started', params: { item } } })
      out.push({ raw: { method: thinking ? 'item/reasoning/summaryTextDelta' : 'item/agentMessage/delta', params: { itemId: id, delta: text } } })
      done.push({ raw: { method: 'item/completed', params: { item: { ...item, text, summary: [text] } } } })
    } else {
      out.push({ raw: { type: 'stream_event', event: { type: 'content_block_start', index, content_block: { type: kind } } } })
      out.push({ raw: { type: 'stream_event', event: { type: 'content_block_delta', index, delta: thinking ? { type:'thinking_delta', thinking:text } : { type:'text_delta', text } } } })
      done.push({ raw: { type: 'assistant', message: { id:'same-message', content:[thinking ? { type:'thinking', thinking:text } : { type:'text', text }] } } })
    }
    out.push({ sleep_ms: index ? 10000 : 2500 })
  }
  return [...out, done[0], { sleep_ms: 1500 }, done[1], { sleep_ms: 1000 }]
}
export async function setup() {
  return { fixture: { org: { name: 'Partial order' }, agents: [{ name:'root',tier:'sonnet',grant:12 }],
    scenario:{default:{turns:[{steps:[{text:'Ready.'}]}]}} } }
}
export default async function(rig, { flags = {} } = {}) {
  const p = new Proof('partial-order'), llm = await startFakeLlm({ models:[{ name:'fake-model:latest',context:65536 }] })
  try {
    const created = await rig.api('POST','/api/langservers',{preset:'llamacpp',address:llm.url,harness:'claude-code',label:'Partial order',models:[{id:'fake-model:latest',context:65536}]})
    const local = Object.values(created.server.models)[0].tier
    const agents=[]; const scenarios={}
    for (const lane of ['claude','codex','local']) for (const thoughtFirst of [true,false]) {
      const agent=`${lane}-${thoughtFirst ? 'think' : 'text'}`
      await rig.op({op:'hire',name:agent,tier:lane==='local' ? local : lane==='codex' ? 'luna' : 'sonnet',grant:1,charter:'Isolated live ordering proof.'})
      scenarios[agent]={turns:[{steps:steps(lane==='codex',thoughtFirst)}]}
      agents.push({agent,thoughtFirst})
    }
    rig.scenario({agents:scenarios})
    for (const args of agents.filter(a=>!flags.only || a.agent===flags.only)) {
      const result = await runDesktop(rig,path.join(RIG_DIR,'desktop','reasoning-order.cjs'),{args,preset:'tall',out:path.join(p.dir,args.agent),timeout:90000})
      p.file(`${args.agent}.json`,result)
      p.check(`${args.agent}: scenario`,result.ok,result.error)
      if(result.ok) {
        p.check(`${args.agent}: both partials observed before completion`,result.value.live.thinking.length>0 && result.value.live.drafts.length>0,result.value.live)
        p.check(`${args.agent}: live order stable across snapshots`,result.value.samples>10 && result.value.bad.length===0,{samples:result.value.samples,bad:result.value.bad})
        p.check(`${args.agent}: final order matches`,result.value.final.ordered,result.value.final)
        p.check(`${args.agent}: bounded chat requests`,result.value.requests.length<=18,{count:result.value.requests.length})
      }
    }
    p.keep(rig,{agents:agents.map(a=>a.agent)})
    return p.summary()
  } finally { await llm.close() }
}
