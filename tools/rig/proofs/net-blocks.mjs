// Blocking across the engine and a real hub (Mail hub 2.6.0, feature
// `blocking`; docket blocking-contacts-on-the-hub-hubchat-1-4-0-orgtr;
// @coordinator-opus m366025ce9de1 ruling C: the one join neither unit suite
// covers). The run hosts the real hub (ORGTREE_RIG_HUB_BIN or --hub
// <orgtree-mailhub.exe>, the integrated 7c2ef87 build); a person registers over
// HTTP as Hubchat does and blocks the org. Then: the org's blocked-by state
// shows after a poll (and the user is told); the org's next message to that
// person is refused by the hub, ends `failed` with the user's words and is
// never retried; the agent that sent it is told, in the user's words; the
// person never receives it. A message before the block is the control.
// Run: node tools/rig/rig.mjs run tools/rig/proofs/net-blocks.mjs --hub <exe>
import crypto from 'node:crypto'
import { Proof } from '../proof.mjs'

const sleep = ms => new Promise(r => setTimeout(r, ms))

export function setup(flags) {
  return { hub: flags.hub ?? true, fixture: { org: { name: 'Net blocks' }, agents: [{ name: 'rhea', tier: 'haiku', grant: 4 }],
    scenario: { default: { turns: [{ steps: [{ text: 'OK.' }] }] } } } }
}

export default async function (rig) {
  const p = new Proof('net-blocks')
  const A = rig.org
  const hub = rig.hubUrl
  const q = s => String(s).replace(/'/g, "''")
  const call = async (method, route, who, body) => {
    const res = await fetch(hub + route, {
      method, headers: { 'X-Org-Auth': `${who.slug}:${who.secret}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(60000),
    })
    return { status: res.status, json: await res.json().catch(() => null) }
  }

  await rig.waitFor(async () => (await rig.api('GET', '/api/desktop/hub')).status?.healthy || null, { what: 'the hosted hub to answer', timeout: 120000 })
  const health = await (await fetch(`${hub}/healthz`)).json()
  p.check('the hosted hub lists the blocking feature (the 2.6.0 line; its version may still say 2.5.1 before release)', (health.features ?? []).includes('blocking'), { version: health.version, features: health.features })
  await rig.api('POST', `/api/orgs/${A}/settings`, { net_autoconnect: true })
  await rig.waitFor(async () => ((await rig.api('GET', `/api/orgs/${A}`)).net?.hubs ?? []).some(h => h.connected) || null,
    { what: 'the org to connect to the hosted hub', timeout: 90000 })
  const orgAddr = rig.one(`SELECT net->'identity'->>'slug' AS s FROM ot.orgs WHERE slug = '${q(A)}' AND state = 'active'`).s
  const pat = { slug: `pat.person.${crypto.randomBytes(3).toString('hex')}`, secret: crypto.randomBytes(32).toString('hex') }
  const reg = await call('POST', '/api/register', pat, { slug: pat.slug, org_name: 'Pat Example', username: 'pat', kind: 'person' })
  p.check('a person registers on the hub over HTTP, as Hubchat does', reg.status === 200, reg.status)
  const to = `@net:${pat.slug}`
  const patGot = []
  const patPoll = async () => {
    const r = await call('POST', '/api/poll?wait=2', pat)
    for (const m of r.json?.messages ?? []) patGot.push(m.body)
    return r
  }

  // control: before the block, the org's message reaches Pat
  const before = await rig.tool('rhea', 'orgtree_message', { to, body: 'NB-BEFORE: before the block' })
  await rig.waitFor(async () => { await patPoll(); return patGot.includes('NB-BEFORE: before the block') || null }, { what: 'Pat to receive the control message', timeout: 60000 })
  p.check('control: before the block the org\'s message reaches Pat', before.ok && patGot.includes('NB-BEFORE: before the block'), { before, patGot })

  // Pat blocks the org on the hub, as Hubchat's Block does
  const blocked = await call('POST', '/api/blocks', pat, { address: orgAddr, blocked: true, slug: pat.slug })
  p.check('Pat blocks the org on the hub', blocked.status === 200 && (blocked.json?.blocked ?? []).includes(orgAddr), blocked)

  // the org's poll carries `blocking`: its blocked-by state shows, and the user is told
  const seen = await rig.waitFor(async () => {
    const b = await rig.api('GET', `/api/orgs/${A}/net/blocks`)
    return (b.blocked_by ?? []).includes(pat.slug) ? b : null
  }, { what: 'the org to hear that Pat blocks it', timeout: 90000 }).catch(() => null)
  p.check('after a poll the org shows Pat in its blocked-by list (GET /api/orgs/{org}/net/blocks)', !!seen, seen)
  // the tree is the org feed's snapshot, refreshed after the change notice (Change::Net): wait for it, as the window does
  let hubRows = []
  const hubRow = await rig.waitFor(async () => {
    hubRows = (await rig.api('GET', `/api/orgs/${A}`)).net?.hubs ?? []
    return hubRows.find(h => h.connected && (h.blocked_by ?? []).includes(pat.slug)) ?? null
  }, { what: "the org tree's hub row to carry the block", timeout: 30000 }).catch(() => null)
  p.check("the mailservers tab's hub row carries the same word (net.hubs[].blocked_by)", !!hubRow,
    hubRows.map(h => ({ id: h.id, address: h.address, connected: h.connected, hidden: h.hidden, version: h.version, blocks: h.blocks, blocked_by: h.blocked_by })))
  const userNotice = await rig.waitFor(() => rig.one(`SELECT body FROM ot.mail WHERE org_id = (SELECT id FROM ot.orgs WHERE slug = '${q(A)}' AND state = 'active')
      AND recipient_kind = 'user' AND sender = '@system' AND body LIKE '%${q(pat.slug)}%' ORDER BY id DESC LIMIT 1`), { what: 'the user to be told of the block', timeout: 30000 }).catch(() => null)
  p.check('the user is told that Pat blocked the org', !!userNotice, userNotice)

  // the org's next message: the hub refuses it, it ends failed and is never retried
  const words = `you have been blocked by @net:${pat.slug} and cannot message them`
  const after = await rig.tool('rhea', 'orgtree_message', { to, body: 'NB-AFTER: after the block' })
  p.check('the send itself is accepted into the org\'s queue (the hub decides)', after.ok, after)
  const row = await rig.waitFor(() => rig.one(`SELECT id, state, tries, last_err FROM ot.org_inbox WHERE dir = 'out' AND body = 'NB-AFTER: after the block' AND state = 'failed'`),
    { what: 'the refused message to end failed', timeout: 90000 }).catch(() => null)
  p.check('the hub refuses it and it ends failed with the user\'s words', row?.state === 'failed' && row?.last_err === words, row)
  await sleep(20000)
  const later = row && rig.one(`SELECT state, tries, last_err FROM ot.org_inbox WHERE id = ${Number(row.id)}`)
  p.check('it is never retried: 20 s later it is still failed, one try', later?.state === 'failed' && Number(later?.tries) === Number(row?.tries), { row, later })
  await patPoll()
  p.check('Pat never receives it', !patGot.includes('NB-AFTER: after the block'), patGot)
  const told = await rig.waitFor(() => rig.one(`SELECT m.body FROM ot.mail m JOIN ot.agents a ON a.id = m.recipient_agent_id
      WHERE a.name = 'rhea' AND m.sender = '@system' AND m.body LIKE 'Not delivered to @net:%' ORDER BY m.id DESC LIMIT 1`), { what: 'rhea to be told', timeout: 30000 }).catch(() => null)
  p.check('the agent that sent it is told, in the user\'s words', told?.body === `Not delivered to @net:${pat.slug}: ${words}.`, told)

  p.keep(rig, { agents: ['rhea'] })
  return p.summary()
}
