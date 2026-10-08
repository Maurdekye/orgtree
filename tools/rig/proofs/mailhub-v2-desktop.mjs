// Desktop smoke for Orgtree 4.0.2's mail hub v2 UI, in the real renderer
// against a rig run that hosts the hub (`up --hub`) and serves this
// worktree's renderer (`up --ui <bundle>`, tools/rig/build-ui.mjs):
//   - the org inbox panel's reading pane quotes what an inbound reply answers
//     ("In reply to boss" and the quoted message);
//   - its Reply goes out as the organization, naming that row (reply_to
//     through the hub, quoted on arrival in the other org), with a file
//     chosen in the reply box (staged the org inbox's way); the box offers
//     no notice toggle (outside recipient);
//   - the mailservers tab and the canvas tile name the hub's version.
// Run: node tools/rig/build-ui.mjs, then
//      node tools/rig/rig.mjs run tools/rig/proofs/mailhub-v2-desktop.mjs --hub <orgtree-mailhub.exe> --ui <bundle>

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { runDesktop } from '../desktop.mjs'
import { Proof } from '../proof.mjs'

const FILE_TEXT = 'a note attached to the reply, from the org inbox panel'

export async function setup(flags) {
  return { hub: flags.hub ?? true }
}

export default async function (rig) {
  const p = new Proof('mailhub-v2-desktop')
  rig.scenario({ default: { turns: [{ steps: [{ text: 'OK.' }] }] } })
  const settle = () => rig.waitFor(() => rig.sql('SELECT 1 FROM ot.turns WHERE ended_at IS NULL').length === 0,
    { what: 'turns to settle', timeout: 90000 })
  await settle()
  const A = rig.org
  const q = s => s.replace(/'/g, "''")
  const orgId = slug => rig.one(`SELECT id FROM ot.orgs WHERE slug = '${q(slug)}' AND state = 'active'`).id
  const netSlug = slug => rig.one(`SELECT net->'identity'->>'slug' AS s FROM ot.orgs WHERE slug = '${q(slug)}' AND state = 'active'`).s
  const inRow = (slug, like) => rig.one(`SELECT uid, body, reply_to, attachments FROM ot.org_inbox
    WHERE org_id = ${orgId(slug)} AND dir = 'in' AND body LIKE '${q(like)}' ORDER BY id DESC LIMIT 1`)
  const outRow = (slug, like) => rig.one(`SELECT uid, by_name, reply_to, net_id FROM ot.org_inbox
    WHERE org_id = ${orgId(slug)} AND dir = 'out' AND body LIKE '${q(like)}' ORDER BY id DESC LIMIT 1`)
  const mailOf = (slug, agent, like) => rig.one(`SELECT m.uid, m.state FROM ot.mail m JOIN ot.agents a ON a.id = m.recipient_agent_id
    WHERE a.org_id = ${orgId(slug)} AND a.name = '${q(agent)}' AND m.body LIKE '${q(like)}' ORDER BY m.id DESC LIMIT 1`)

  await rig.waitFor(async () => (await rig.api('GET', '/api/desktop/hub')).status?.healthy, { what: 'the hosted hub', timeout: 120000 })
  await rig.api('POST', `/api/orgs/${A}/settings`, { net_autoconnect: true })
  const B = (await rig.api('POST', '/api/orgs', { name: 'Rig Hub Peer', dirs: [] })).slug
  await rig.op({ op: 'hire', name: 'zoe', tier: 'haiku', title: 'B lead', grant: 5 }, { org: B })
  const registered = slug => rig.api('GET', `/api/orgs/${slug}`).then(t => (t.net?.hubs ?? []).find(h => h.connected))
  await rig.waitFor(() => registered(A), { what: 'A on the hub', timeout: 90000 })
  await rig.waitFor(() => registered(B), { what: 'B on the hub', timeout: 90000 })
  const [nA, nB] = [netSlug(A), netSlug(B)]
  await rig.tool('boss', 'orgtree_message', { to: `@net:${nB}`, body: 'PROOF-SMOKE-1 boss writes to B' })
  const zoe1 = await rig.waitFor(() => { const m = mailOf(B, 'zoe', 'PROOF-SMOKE-1%'); return m?.state === 'delivered' ? m : null },
    { what: 'zoe to read PROOF-SMOKE-1', timeout: 60000 })
  await rig.tool('zoe', 'orgtree_message', { to: `@net:${nA}`, body: 'PROOF-SMOKE-2 zoe answers boss', reply_to: zoe1.uid }, { org: B })
  const inbound = await rig.waitFor(() => inRow(A, 'PROOF-SMOKE-2%'), { what: 'A to receive zoe\'s answer', timeout: 60000 })
  await settle()

  const ui = await runDesktop(rig, fileURLToPath(new URL('../desktop/orginbox-reply.cjs', import.meta.url)),
    { out: path.join(p.dir, 'desktop'), args: { row: 'PROOF-SMOKE-2', reply: 'PROOF-SMOKE-3 the user replies from the panel',
      file: { name: 'reply-note.txt', text: FILE_TEXT } } })
  const v = ui.value ?? {}
  p.check('the desktop script ran in the real renderer', ui.ok, ui.error ?? ui.electronOutput)
  p.check('the reading pane quotes what the inbound reply answers (In reply to boss, PROOF-SMOKE-1)',
    /In reply to boss/.test(v.pane ?? '') && (v.pane ?? '').includes('PROOF-SMOKE-1'), v.pane)
  p.check('the reply box to an outside sender offers files (staged the org inbox\'s way) and no notice toggle',
    Array.isArray(v.buttons) && !v.buttons.some(b => /notice/i.test(b.label)) && v.buttons.some(b => b.label === 'attach a file' && !b.disabled), v.buttons)
  const sent = await rig.waitFor(() => outRow(A, 'PROOF-SMOKE-3%'), { what: 'the panel\'s reply in A\'s sent rows', timeout: 30000 })
  p.check('the Reply went out as the organization (by the user), naming the row it answers', sent.by_name === 'user'
    && sent.reply_to?.id === inbound.uid, sent)
  const arrived = await rig.waitFor(() => inRow(B, 'PROOF-SMOKE-3%'), { what: 'B to receive the panel\'s reply', timeout: 60000 })
  p.check('over the hub it arrived quoting zoe\'s message', arrived.reply_to?.gist?.startsWith('PROOF-SMOKE-2'), arrived.reply_to)
  const file = (arrived.attachments ?? []).find(a => a.name === 'reply-note.txt')
  p.check('the file chosen in the reply box travelled with it', !!file && fs.readFileSync(file.path, 'utf8') === FILE_TEXT, arrived.attachments)
  p.check('the mailservers tab shows the hub\'s version', /hub version 2\.0\.0/.test(v.servers ?? ''), v.servers)
  p.check('the canvas tile\'s hub tooltip names the version', /hub version 2\.0\.0/.test(v.tile ?? ''), v.tile)
  if ((ui.consoleErrors ?? []).length) p.note('console errors during the desktop script', ui.consoleErrors)
  return p.summary()
}
