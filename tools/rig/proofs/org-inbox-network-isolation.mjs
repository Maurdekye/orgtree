import http from 'node:http'
import { Proof } from '../proof.mjs'

// The debug transfer adapter uses slug "rig"; match the actual fixture owner
// so downloaded-path authorization exercises a real org, not an orphan root.
export async function setup() {
  return { fixture: { org: { name: 'rig' }, agents: [{ name: 'rhea', tier: 'luna', grant: 4 }],
    scenario: { default: { turns: [{ steps: [{ text: 'OK.' }] }] } } } }
}

export default async function (rig) {
  const p = new Proof('org-inbox-network-isolation')
  const calls = []
  let holdDownload = true
  let stalled
  const sessions = new Map()
  const server = http.createServer(async (req, res) => {
    calls.push(req.url)
    const url = new URL(req.url, 'http://localhost')
    const json = data => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)) }
    try {
      if (url.pathname === '/healthz') return json({ features: ['uploads'], max_attachment_bytes: 1048576 })
      if (url.pathname === '/api/uploads') {
        const chunks = []; for await (const chunk of req) chunks.push(chunk)
        const input = JSON.parse(Buffer.concat(chunks))
        const id = `file${sessions.size}`
        const state = { id, bytes: input.bytes, offset: 0, complete: false }
        sessions.set(id, state); return json(state)
      }
      if (url.pathname.startsWith('/api/uploads/')) {
        const state = sessions.get(url.pathname.split('/').at(-1))
        if (req.method !== 'GET') {
          for await (const chunk of req) state.offset += chunk.length
          state.complete = state.offset === state.bytes
        }
        return json(state)
      }
      if (url.pathname.startsWith('/api/attachments/')) {
        if (holdDownload) { stalled = res; return }
        res.writeHead(200, { 'content-length': 1024, etag: '"fixture"' }); res.end(Buffer.alloc(1024, 120)); return
      }
      if (url.pathname === '/api/send') { for await (const chunk of req) {} return json({ ok: true }) }
      res.writeHead(404); res.end()
    } catch { if (!res.headersSent) res.writeHead(500); res.end() }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = `http://127.0.0.1:${server.address().port}`
  const call = args => rig.api('POST', '/api/rig/hub-mail', { org: rig.org, op: 'transfer', address, ...args })
  const set = enabled => rig.api('POST', `/api/orgs/${rig.org}/settings`, { org_inbox_enabled: enabled })
  const row = id => rig.one(`SELECT state FROM ot.net_transfers WHERE id='${id}'`)
  const incoming = () => rig.one("SELECT state FROM ot.net_incoming WHERE net_id='accepted-download'")
  const attempt = async f => { try { await f(); return false } catch (e) { return e.status === 403 } }
  try {
    await rig.op({ op: 'halt', nodes: ['rhea'] })
    const upload = await call({ action: 'plan', bytes: 1024 })
    await call({ action: 'receive', message: { id: 'accepted-download', from: 'peer.rig', body: 'Accepted before off',
      attachments: [{ id: 'download', name: 'fixture.bin', bytes: 1024 }] } })
    await set(false)
    await call({ action: 'workers' }) // deliberately stale participants; real workers still enforce persisted policy
    await call({ action: 'drain' })
    await new Promise(resolve => setTimeout(resolve, 1200))
    p.check('cached worker routes and outbox drain produce zero HTTP while disabled', calls.length === 0, [...calls])
    p.check('new attachment queue admission fails', await attempt(() => call({ action: 'plan', bytes: 1024 })))
    p.check('incoming envelope rejected before durable custody', await attempt(() => call({ action: 'receive',
      message: { id: 'refused-download', from: 'peer.rig', body: 'Must not be accepted' } })))
    p.check('refused inbound has no durable row', rig.sql("SELECT id FROM ot.net_incoming WHERE net_id='refused-download'").length === 0)
    await set(true)
    await rig.waitFor(() => !!stalled && row(upload.id)?.state === 'complete', { what: 'enabled HTTP upload and stalled download', timeout: 15000 })
    p.check('enabled control really issued HTTP and completed upload', calls.some(x => x.startsWith('/api/uploads/')) && !!stalled)
    await set(false)
    const after = calls.length
    await rig.waitFor(() => incoming()?.state === 'retry_wait', { what: 'inflight download cancelled', timeout: 5000 })
    await call({ action: 'drain' })
    await new Promise(resolve => setTimeout(resolve, 1200))
    p.check('disable cancels outstanding download and prevents all new HTTP', calls.length === after, { before: after, after: calls.length })
    p.check('partial download not published to inbox or agent', rig.sql("SELECT id FROM ot.org_inbox WHERE dir='in' AND net_id='accepted-download'").length === 0 &&
      rig.sql("SELECT id FROM ot.mail WHERE net_id='accepted-download'").length === 0)
    p.check('previously accepted outgoing record retained and unsent', rig.one(`SELECT state FROM ot.org_inbox WHERE id=${upload.inbox}`).state === 'queued')
    holdDownload = false; stalled.destroy()
    await set(true)
    await rig.waitFor(() => incoming()?.state === 'complete', { what: 'accepted download resumes after enable', timeout: 20000 })
    await call({ action: 'drain' })
    p.check('previously accepted records can complete after re-enable', rig.one(`SELECT state FROM ot.org_inbox WHERE id=${upload.inbox}`).state === 'sent' &&
      rig.sql("SELECT id FROM ot.org_inbox WHERE dir='in' AND net_id='accepted-download'").length === 1)
    p.check('re-enable never revives rejected inbound', rig.sql("SELECT id FROM ot.org_inbox WHERE net_id='refused-download'").length === 0)
    const C=(await rig.api('POST','/api/orgs',{name:'Download reader',dirs:[],net_autoconnect:false})).slug
    await rig.op({op:'hire',name:'reader',tier:'luna',grant:4},{org:C})
    await rig.op({op:'halt',nodes:['reader']},{org:C})
    const downloaded=rig.one("SELECT d.path FROM ot.net_downloads d JOIN ot.net_incoming n ON n.id=d.incoming_id WHERE n.net_id='accepted-download'").path
    const readFile=async org=>{
      const res=await fetch(`${rig.url}/api/orgs/${org}/nodes/${org===C?'reader':'rhea'}/file?path=${encodeURIComponent(downloaded)}`,
        {headers:{'X-Orgtree-Desktop-Token':rig.token}})
      return {status:res.status,bytes:(await res.arrayBuffer()).byteLength}
    }
    p.check('actual downloaded file enabled control',(await readFile(C)).bytes===1024)
    await set(false)
    p.check('actual downloaded inbox file blocked through unrelated enabled org',(await readFile(C)).status===403)
    await rig.api('POST',`/api/orgs/${C}/settings`,{org_inbox_enabled:false})
    p.check('actual downloaded inbox file blocked when both orgs disabled',(await readFile(C)).status===403)
    await set(true)
    const restored=await readFile(rig.org)
    p.check('actual downloaded file restored after enable',restored.status===200 && restored.bytes===1024)
    p.note('Loopback fixture counts real worker HTTP; no real hub registration, external identity, provider or message. Remote acceptance already dispatched cannot be recalled.')
    p.keep(rig, { grep: /isolation|transfer|incoming|ERROR/ })
    return p.summary()
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
}
