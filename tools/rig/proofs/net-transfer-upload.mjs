// Real engine spool + streamed HTTP uploads; no real hub identity or provider.
import http from 'node:http'
import crypto from 'node:crypto'
import { Proof } from '../proof.mjs'

export async function setup() {
  return { fixture: { org: { name: 'Transfer uploads' }, agents: [{ name: 'rhea', tier: 'luna', grant: 4 }],
    scenario: { default: { turns: [{ steps: [{ text: 'OK.' }] }] } } } }
}

export default async function (rig) {
  const proof = new Proof('net-transfer-upload')
  const sessions = new Map()
  const requests = { creates: 0, patches: 0, sends: 0 }
  let loseCompletion = false
  let statusFailure = false
  let statusGone = false
  let holdPatch = false
  let releasePatch
  let heldPatches = 0
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost')
      const reply = (code, data) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)) }
      if (url.pathname === '/healthz') return reply(200, { features: ['uploads'], max_attachment_bytes: 1073741824 })
      if (req.headers['x-org-auth'] !== 'rig.transfer:synthetic-proof') return reply(401, {})
      if (url.pathname === '/api/uploads' && req.method === 'POST') {
        const chunks = []; for await (const chunk of req) chunks.push(chunk)
        const input = JSON.parse(Buffer.concat(chunks))
        const id = crypto.randomUUID().replaceAll('-', '')
        sessions.set(id, { id, bytes: input.bytes, offset: 0, complete: false, expected: input.sha256, hash: crypto.createHash('sha256') })
        requests.creates++
        return reply(200, { id, bytes: input.bytes, offset: 0, complete: false })
      }
      if (url.pathname.startsWith('/api/uploads/')) {
        const s = sessions.get(url.pathname.split('/').at(-1))
        if (!s) return reply(404, {})
        if (req.method === 'GET') {
          if (statusFailure) return reply(503, {})
          if (statusGone) { statusGone = false; sessions.delete(s.id); return reply(410, {}) }
          return reply(200, { id: s.id, bytes: s.bytes, offset: s.offset, complete: s.complete })
        }
        if (Number(url.searchParams.get('offset')) !== s.offset) return reply(409, { offset: s.offset })
        requests.patches++
        for await (const chunk of req) { s.hash.update(chunk); s.offset += chunk.length }
        s.complete = s.offset === s.bytes
        if (s.complete) {
          if (s.hash.digest('hex') !== s.expected) return reply(422, { offset: 0 })
          if (loseCompletion) { loseCompletion = false; return reply(500, {}) }
        }
        if (holdPatch) {
          heldPatches++
          await new Promise(resolve => { releasePatch = resolve })
        }
        return reply(200, { id: s.id, bytes: s.bytes, offset: s.offset, complete: s.complete })
      }
      if (url.pathname === '/api/send') {
        const chunks = []; for await (const chunk of req) chunks.push(chunk)
        const input = JSON.parse(Buffer.concat(chunks))
        if (!input.attachments.every(id => sessions.get(id)?.complete)) return reply(422, { detail: 'unfinished attachment sent' })
        requests.sends++
        return reply(200, { ok: true })
      }
      return reply(404, {})
    } catch (e) { res.writeHead(500); res.end(String(e)) }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = `http://127.0.0.1:${server.address().port}`
  const call = args => rig.api('POST', '/api/rig/hub-mail', { org: rig.org, op: 'transfer', address, ...args })
  const row = id => rig.one(`SELECT state,processed,confirmed,total,attempt,session_id,result_id,error FROM ot.net_transfers WHERE id='${id}'`)
  try {
    const normal = await call({ action: 'plan', bytes: 9 * 1024 * 1024 })
    await call({ action: 'drain' })
    proof.check('mail stays queued before its upload finishes', !normal.ready && requests.sends === 0)
    await call({ action: 'attempt', id: normal.id })
    const finished = row(normal.id)
    proof.check('bounded pieces confirm all bytes and persist the hub ID', finished.state === 'complete' &&
      finished.confirmed === finished.total && finished.processed === finished.total && !!finished.result_id && requests.patches === 2, finished)
    await call({ action: 'drain' })
    proof.check('mail sends only after the completed attachment is persisted', requests.sends === 1 &&
      rig.one(`SELECT state FROM ot.org_inbox WHERE id=${normal.inbox}`).state === 'sent')

    loseCompletion = true
    const lost = await call({ action: 'plan', bytes: 1024 * 1024 })
    await call({ action: 'attempt', id: lost.id })
    const pending = row(lost.id)
    proof.check('lost completion response preserves the session and queued message', pending.state === 'retry_wait' &&
      !!pending.session_id && rig.one(`SELECT state FROM ot.org_inbox WHERE id=${lost.inbox}`).state === 'queued', pending)
    const before = { ...requests }
    statusFailure = true
    await call({ action: 'attempt', id: lost.id })
    proof.check('temporary status failure never creates a replacement upload', requests.creates === before.creates && row(lost.id).state === 'retry_wait')
    statusFailure = false
    await call({ action: 'attempt', id: lost.id })
    proof.check('GET completion recovers without sending the bytes twice', row(lost.id).state === 'complete' &&
      requests.patches === before.patches && requests.creates === before.creates)
    await call({ action: 'drain' })
    proof.check('recovered message sends once', requests.sends === 2)

    loseCompletion = true
    const damaged = await call({ action: 'plan', bytes: 1024 })
    await call({ action: 'attempt', id: damaged.id })
    const oldSession = row(damaged.id).session_id
    const createsBeforeDamage = requests.creates
    statusGone = true
    await call({ action: 'attempt', id: damaged.id })
    proof.check('damaged session restarts with a new ID and completes', row(damaged.id).state === 'complete' &&
      row(damaged.id).session_id !== oldSession && requests.creates === createsBeforeDamage + 1)
    await call({ action: 'drain' })
    proof.check('restarted attachment gates delivery until complete', requests.sends === 3)

    proof.check('success and temporary retry produce no failure notice or mail',rig.sql('SELECT id FROM ot.net_transfer_failures').length===0 &&
      rig.sql("SELECT id FROM ot.mail WHERE extra ? 'transfer_failure'").length===0)
    const missing = await call({ action: 'plan', bytes: 1234, missing: true })
    await call({ action: 'attempt', id: missing.id })
    await call({ action: 'drain' })
    const held = rig.one(`SELECT state,attachments FROM ot.org_inbox WHERE id=${missing.inbox}`)
    proof.check('missing snapshot holds all mail and keeps the attachment manifest', row(missing.id).state === 'failed' &&
      held.state === 'queued' && held.attachments.length === 1 && requests.sends === 3, row(missing.id))
    // Exercise the actual production scheduler, including a real engine restart
    // while its first PATCH response is withheld. The loopback hub retains bytes.
    holdPatch = true
    const worker = await call({ action: 'plan', bytes: 9 * 1024 * 1024 })
    const waiting = await call({ action: 'plan', bytes: 1024 })
    const patchCount = requests.patches
    await call({ action: 'workers' })
    await rig.waitFor(() => heldPatches === 1, { what: 'production worker reaches the hub', timeout: 30000 })
    proof.check('one active upload per hub keeps the next job queued', row(waiting.id).state === 'queued' &&
      ['uploading', 'preparing'].includes(row(worker.id).state))
    const workerSession = row(worker.id).session_id
    await rig.restart()
    holdPatch = false
    releasePatch()
    await call({ action: 'workers' })
    await rig.waitFor(() => row(worker.id).state === 'complete' && row(waiting.id).state === 'complete',
      { what: 'production workers resume after engine restart', timeout: 30000 })
    proof.check('restart reclaims active jobs and resumes the confirmed hub offset',
      row(worker.id).session_id === workerSession && requests.patches - patchCount === 3 && row(worker.id).attempt === 2,
      { worker: row(worker.id), patches: requests.patches - patchCount })
    const userList = await rig.api('GET', `/api/orgs/${rig.org}/transfers`)
    proof.check('user inspection exposes byte counters without local paths or auth', userList.transfers.some(t => t.id === worker.id && t.confirmed === t.total) &&
      !JSON.stringify(userList).includes('synthetic-proof') && !JSON.stringify(userList).includes('path'))
    const denied = await rig.tool('rhea', 'orgtree_transfers', { action: 'get', id: worker.id })
    proof.check('an agent cannot inspect a user-owned outgoing transfer by guessed id', !denied.ok, denied)
    holdPatch = true
    const stalled = await call({ action: 'plan', bytes: 9 * 1024 * 1024 })
    const next = await call({ action: 'plan', bytes: 1024 })
    const heldBefore = heldPatches
    await rig.waitFor(() => heldPatches > heldBefore, { what: 'stalled request to cancel', timeout: 30000 })
    holdPatch = false
    const cancelledAt = Date.now()
    await rig.api('POST', `/api/orgs/${rig.org}/transfers/${stalled.id}`, { action: 'cancel' })
    await rig.waitFor(() => row(next.id).state === 'complete', { what: 'cancel frees same-hub worker while response stays withheld', timeout: 10000 })
    proof.check('cancel interrupts stalled I/O and keeps the message queued', row(stalled.id).state === 'cancelled' &&
      rig.one(`SELECT state FROM ot.org_inbox WHERE id=${stalled.inbox}`).state === 'queued' && Date.now() - cancelledAt < 10000)
    releasePatch()
    const savedSession = row(stalled.id).session_id
    await rig.api('POST', `/api/orgs/${rig.org}/transfers/${stalled.id}`, { action: 'retry' })
    await rig.waitFor(() => row(stalled.id).state === 'complete', { what: 'explicit retry resumes cancelled upload', timeout: 30000 })
    proof.check('explicit retry retains the session and confirms all bytes', row(stalled.id).session_id === savedSession && row(stalled.id).confirmed === row(stalled.id).total)
    await rig.api('POST', `/api/orgs/${rig.org}/transfers/${missing.id}`, { action: 'remove' })
    await call({ action: 'drain' })
    proof.check('explicit remove releases held message without sending missing bytes', row(missing.id).state === 'removed' &&
      rig.one(`SELECT state FROM ot.org_inbox WHERE id=${missing.inbox}`).state === 'sent')
    const visibleInbox=await rig.api('GET',`/api/orgs/${rig.org}/org_inbox`)
    const missingUid=rig.one(`SELECT uid FROM ot.org_inbox WHERE id=${missing.inbox}`).uid
    proof.check('removed file is absent from the visible sent manifest', !visibleInbox.entries.find(i=>i.id===missingUid)?.attachments?.length)
    proof.note('Measured actual production scheduler, user controls, agent denial, cancelled stalled I/O, explicit resume and graceful restart. Explicit held-file removal measured; failure notices, UI and full device/1GiB proofs remain.')
    proof.keep(rig, { grep: /transfer|upload/ })
    return proof.summary()
  } finally {
    if (releasePatch) releasePatch()
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
}
