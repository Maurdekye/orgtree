import { Proof } from '../proof.mjs'

export async function setup() {
  return { fixture: { org: { name: 'Transfer failure notices' }, agents: [{ name: 'rhea', tier: 'luna', grant: 4 }],
    scenario: { default: { turns: [{ steps: [{ text: 'OK.' }] }] } } } }
}

export default async function(rig) {
  const proof = new Proof('net-transfer-failures')
  // These cases fail before HTTP, or cancel queued work; no server is needed.
  const call = args => rig.api('POST','/api/rig/hub-mail',{org:rig.org,op:'transfer',address:'http://127.0.0.1:1',...args})
  const notices = () => rig.sql("SELECT recipient_kind,recipient_name,body,notice,extra FROM ot.mail WHERE extra ? 'transfer_failure' ORDER BY id")
  const change = (id,action) => rig.api('POST',`/api/orgs/${rig.org}/transfers/${id}`,{action})
  try {
    await rig.op({op:'halt',nodes:['rhea']})
    const failure=await call({action:'plan',by:'rhea',missing:true,file_count:2})
    for(const id of failure.ids) await call({action:'attempt',id})
    proof.check('two failed files store one durable message failure intent',failure.ids.length===2 &&
      rig.sql('SELECT id FROM ot.net_transfer_failures').length===1 && notices().length===0)
    await rig.restart()
    await call({action:'notifications'})
    const first=notices()
    proof.check('restart between failure and notification loses neither user notice nor sender mail',first.length===2 &&
      first.some(m=>m.recipient_kind==='user' && m.notice) && first.some(m=>m.recipient_name==='rhea' && !m.notice),first)
    await call({action:'notifications'})
    await rig.restart()
    await call({action:'notifications'})
    proof.check('repeated dispatch and a second restart do not duplicate failure mail',notices().length===2)
    const own=await rig.tool('rhea','orgtree_transfers',{action:'get',id:failure.id})
    proof.check('originating agent can inspect its own failed send',own.ok && own.json.transfers[0].state==='failed',own)
    // A retry of one file while another is held stays in the same episode.
    await change(failure.ids[0],'retry')
    await call({action:'attempt',id:failure.ids[0]})
    await call({action:'notifications'})
    proof.check('another file still held suppresses repeated message-level failure notices',notices().length===2)
    for(const id of failure.ids) await change(id,'retry')
    await call({action:'attempt',id:failure.ids[0]})
    await call({action:'notifications'})
    proof.check('a new explicit retry episode can report a fresh failure once',notices().length===4)
    const silent=await call({action:'plan',by:'rhea'})
    await change(silent.id,'cancel')
    await call({action:'notifications'})
    proof.check('user cancellation is durable and silent',notices().length===4 &&
      rig.one(`SELECT cancelled_by FROM ot.net_transfers WHERE id='${silent.id}'`).cancelled_by==='user')
    const loud=await call({action:'plan',by:'rhea'})
    const cancel=await rig.tool('rhea','orgtree_transfers',{action:'cancel',id:loud.id})
    await call({action:'notifications'})
    proof.check('agent cancellation produces one user notice and one involved-agent mail',cancel.ok && notices().length===6 &&
      rig.one(`SELECT cancelled_by FROM ot.net_transfers WHERE id='${loud.id}'`).cancelled_by.startsWith('agent:'))
    await call({action:'notifications'})
    proof.check('intentional cancellation notification is also deduplicated',notices().length===6)
    proof.keep(rig,{grep:/transfer|failure/})
    proof.note('Real engine/DB/agent tool, two files per message, halted recipient and actual restarts around notification dispatch. Success silence is checked by the upload proof; no renderer/device notification proof here.')
    return proof.summary()
  } finally {}
}
