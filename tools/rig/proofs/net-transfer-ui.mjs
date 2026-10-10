import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Proof } from '../proof.mjs'
import { runDesktop } from '../desktop.mjs'

export async function setup() {
  return { fixture: { org: { name: 'Transfer panels' }, agents: [{ name: 'rhea', tier: 'luna', grant: 4 }],
    scenario: { default: { turns: [{ steps: [{ text: 'OK.' }] }] } } } }
}

export default async function(rig) {
  const proof = new Proof('net-transfer-ui')
  const size = 9 * 1024 * 1024, checkpoint = 8 * 1024 * 1024
  const server = http.createServer((req,res) => {
    res.writeHead(200, { 'content-length': size, etag: '"ui-proof"' })
    res.write(Buffer.alloc(checkpoint, 120)) // Keep the download visibly unfinished.
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = `http://127.0.0.1:${server.address().port}`
  const call = args => rig.api('POST','/api/rig/hub-mail',{org:rig.org,op:'transfer',address,...args})
  try {
    await rig.op({op:'halt',nodes:['rhea']})
    const mine = await call({action:'plan',by:'rhea',missing:true})
    await call({action:'attempt',id:mine.id})
    const user = await call({action:'plan',missing:true})
    await call({action:'attempt',id:user.id})
    await call({action:'receive',message:{id:'ui-download',from:'peer.rig',body:'Hidden until complete',
      attachments:[{id:'ui-file',name:'incoming.bin',bytes:size}]}})
    await call({action:'workers'})
    await rig.waitFor(() => rig.one("SELECT confirmed FROM ot.net_downloads WHERE name='incoming.bin'")?.confirmed === checkpoint,
      {what:'visible download checkpoint',timeout:30000})
    const incoming=rig.one("SELECT id FROM ot.net_incoming WHERE net_id='ui-download'").id
    const filtered=await rig.api('GET',`/api/orgs/${rig.org}/transfers?agent=rhea`)
    proof.check('agent mail panel is scoped to its own sends and held outside inbox',
      filtered.transfers.some(t=>t.id===mine.id) && !filtered.transfers.some(t=>t.id===user.id))
    const ui=await runDesktop(rig,path.join(path.dirname(fileURLToPath(import.meta.url)),'../desktop/net-transfer-ui.cjs'),
      {out:path.join(proof.dir,'desktop'),timeout:60000,args:{mine:mine.id,user:user.id,incoming,checkpoint,size}})
    proof.file('desktop-result.json',ui)
    proof.check('org and agent panels show progress and operate real transfer controls',ui.ok,ui.error ?? ui.value)
    proof.check('UI remove keeps stable manifest and releases only the explicitly removed file',
      rig.one(`SELECT state FROM ot.net_transfers WHERE id='${mine.id}'`).state==='removed')
    proof.check('UI user cancel is silent and leaves the incoming message undelivered',
      rig.one(`SELECT state,cancelled_by FROM ot.net_incoming WHERE id='${incoming}'`).cancelled_by==='user' &&
      rig.sql("SELECT id FROM ot.org_inbox WHERE net_id='ui-download' AND dir='in'").length===0)
    proof.keep(rig,{grep:/transfer|ERROR/})
    proof.note('Real engine/DB/renderer, held HTTP download with confirmed 8 of 9 MiB, failed local uploads. No browser staging/device/1GiB proof.')
    return proof.summary()
  } finally { server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)) }
}
