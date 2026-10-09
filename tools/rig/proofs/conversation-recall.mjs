// Proof: conversation recall (orgtree_inbox action=conversation, user
// 2026-10-09): an agent lists the mail it and one correspondent exchanged,
// both directions, newest page first, so a fresh session can pick up what
// it was discussing.
//   order    alice and carol (peers) trade 27 messages with boss's mail mixed
//            in: alice's recall of carol is exactly those 27, oldest to
//            newest, sent and received marked, a reply linked to what it
//            answers; 20 to a page by default, the next_cursor gives the 7
//            before them and says it is the start; limit 5 walks back in
//            six pages with nothing lost or repeated; carol's recall of
//            alice is the same mail with the directions turned round
//   caps     110 messages with boss: limit 1000 gives 100 and says more
//            exists; 40 long messages from bob: previews stop at 500
//            characters (cut, with the whole length) and a page stops at
//            16,000 characters of previews (32 here), the cursor gives the
//            other 8; fetch gives a cut message whole, sent or received
//   user     the user's mail to alice and hers to the user (one with an
//            attachment, named) in order; the user's mail to others not
//   outside  boss holds the org inbox: @org: mail with a second org on this
//            machine and @net: mail through the hosted hub (--hub), his
//            sends and the replies in order on both sides; a bare org name
//            reads the same; alice (no holder) has none
//   bounds   another agent's cursor, an unknown peer, herself and extra
//            arguments are refused; bob has no mail with carol; mail between
//            others is not found by fetch
//   handoff  after a cheap compact alice's first turn starts with the hint
//            to recall a conversation before replying, naming her most
//            recent correspondents newest first
// Run: node tools/rig/rig.mjs run tools/rig/proofs/conversation-recall.mjs [--hub <orgtree-mailhub.exe>]

import fs from 'node:fs'
import path from 'node:path'

import { Proof } from '../proof.mjs'

export async function setup(flags) {
  const hub = flags.hub ?? process.env.ORGTREE_RIG_HUB_BIN
  return hub ? { hub } : {}
}

export default async function (rig) {
  const p = new Proof('conversation-recall')
  rig.scenario({ default: { turns: [{ name: 'default', steps: [{ text: 'OK.' }] }] } })
  const settle = (what = 'turns to settle') => rig.waitFor(() => rig.sql('SELECT 1 FROM ot.turns WHERE ended_at IS NULL').length === 0,
    { what, timeout: 90000 })
  await settle('seed turns to settle')
  const A = rig.org
  const q = s => s.replace(/'/g, "''")
  const id = name => rig.agentRow(name).id
  const uidOf = body => rig.one(`SELECT uid FROM ot.mail WHERE body = '${q(body)}' ORDER BY id DESC LIMIT 1`)?.uid
  const conv = (who, args, opts) => rig.tool(who, 'orgtree_inbox', { action: 'conversation', ...args }, opts)
  const fetchIds = (who, ids, opts) => rig.tool(who, 'orgtree_inbox', { action: 'fetch', message_ids: ids }, opts)
  const note = (from, to, body, extra = {}, opts) => rig.tool(from, 'orgtree_message', { to, body, notice: true, ...extra }, opts)
  const sentId = r => /\(id ([^)\s]+)\)/.exec(r?.text ?? '')?.[1]
  const bodies = page => (page?.json?.messages ?? []).map(m => m.preview)
  const ids = page => (page?.json?.messages ?? []).map(m => m.id)

  // alice gets a session (a cheap compact needs one) and may write to the user
  await rig.userMail('alice', 'U0 hello alice, start here.')
  await settle('alice\'s first turn')
  await rig.api('POST', `/api/orgs/${A}/audiences`, { action: 'grant', node: 'alice', reason: 'proof: may mail the user' })

  // ---------------------------------------------------------------- order
  const seq = [] // { body, sent } from alice's side, in send order
  for (let i = 0; i < 27; i++) {
    let body
    if (i % 3 === 2) {
      body = `C2A-${i} carol to alice`
      const reply = i === 5 ? { reply_to: seq.find(s => s.body.startsWith('A2C-3 '))?.id } : {}
      seq.push({ body, sent: false, id: sentId(await note('carol', 'alice', body, reply)) })
    } else {
      body = i === 13 ? `A2C-${i} alice to carol, long: ` + 'detail '.repeat(300) + 'END' : `A2C-${i} alice to carol`
      seq.push({ body, sent: true, id: sentId(await note('alice', 'carol', body)) })
    }
    if (i % 5 === 0) {
      await note('boss', 'alice', `NOISE-${i} boss to alice`)
      await note('alice', 'boss', `NOISE-${i} alice to boss`)
    }
  }
  const expected = seq.map(s => s.id)
  p.note('alice and carol', { messages: expected.length, missing: expected.filter(x => !x).length })
  const c1 = await conv('alice', { peer: 'carol' })
  const c2 = c1.json?.next_cursor ? await conv('alice', { peer: 'carol', cursor: c1.json.next_cursor }) : null
  p.check('order: the first page is the newest 20 of the 27, oldest to newest, and says older mail exists (with its cursor)',
    c1.ok && JSON.stringify(ids(c1)) === JSON.stringify(expected.slice(-20)) && c1.json.has_more === true && /Older mail with carol exists/.test(c1.json.note ?? ''),
    { ok: c1.ok, text: c1.ok ? undefined : c1.text, got: bodies(c1).map(b => b.slice(0, 8)), note: c1.json?.note })
  p.check('order: next_cursor gives the 7 before them and says it is the start; nothing else (boss\'s mail) appears',
    c2?.ok && JSON.stringify(ids(c2)) === JSON.stringify(expected.slice(0, 7)) && c2.json.has_more === false && !c2.json.next_cursor
    && /start of your mail with carol/.test(c2.json.note ?? ''), { got: bodies(c2).map(b => b.slice(0, 8)), note: c2?.json?.note })
  const all = [...(c2?.json?.messages ?? []), ...(c1.json?.messages ?? [])]
  p.check('order: each message says sent or received, from and to, and its kind',
    all.length === 27 && all.every((m, i) => m.direction === (seq[i].sent ? 'sent' : 'received')
      && m.from === (seq[i].sent ? 'alice' : 'carol') && m.to === (seq[i].sent ? 'carol' : 'alice') && m.kind === 'message' && m.notice === true),
    all.slice(0, 3))
  const replied = all.find(m => m.preview.startsWith('C2A-5 '))
  p.check('order: a reply is linked to the message it answers (id, sender, gist)', replied?.reply_to?.id === seq[3].id
    && replied.reply_to.from === 'alice' && /^A2C-3 /.test(replied.reply_to.gist ?? ''), replied?.reply_to)
  const walk = []
  let cursor = null, pages = 0
  do {
    const r = await conv('alice', { peer: 'carol', limit: 5, ...(cursor ? { cursor } : {}) })
    if (!r.ok) break
    walk.unshift(...ids(r))
    cursor = r.json.next_cursor
    pages++
  } while (cursor && pages < 20)
  p.check('order: limit 5 walks back in six pages with nothing lost or repeated', pages === 6
    && JSON.stringify(walk) === JSON.stringify(expected), { pages, got: walk.length })
  const mirror = await conv('carol', { peer: 'alice', limit: 100 })
  p.check('order: carol\'s recall of alice is the same mail with the directions turned round', mirror.ok
    && JSON.stringify(ids(mirror)) === JSON.stringify(expected)
    && (mirror.json.messages ?? []).every((m, i) => m.direction === (seq[i].sent ? 'received' : 'sent')), { got: ids(mirror).length })

  // ---------------------------------------------------------------- caps
  for (let i = 0; i < 55; i++) {
    await note('boss', 'alice', `CAP-${i} boss to alice`)
    await note('alice', 'boss', `CAP-${i} alice to boss`)
  }
  const capped = await conv('alice', { peer: 'boss', limit: 1000 })
  p.check('caps: limit 1000 gives at most 100 messages and says more exists', capped.ok && capped.json.messages?.length === 100
    && capped.json.has_more === true && !!capped.json.next_cursor, { got: capped.json?.messages?.length, has_more: capped.json?.has_more })
  const dflt = await conv('alice', { peer: 'boss' })
  p.check('caps: the default page is 20', dflt.ok && dflt.json.messages?.length === 20, dflt.json?.messages?.length)
  const longs = []
  for (let i = 0; i < 40; i++) {
    const body = `BUDGET-${i} ` + 'word '.repeat(600) + `END-${i}`
    longs.push(body)
    await note('bob', 'alice', body)
  }
  const b1 = await conv('alice', { peer: 'bob', limit: 100 })
  const b1m = b1.json?.messages ?? []
  const previewChars = b1m.reduce((n, m) => n + [...m.preview].length, 0)
  const longIds = longs.map(uidOf)
  const whole = m => longs[longIds.indexOf(m.id)]
  p.check('caps: previews stop at 500 characters, marked cut, with the whole length', b1.ok && b1m.length > 0
    && b1m.every(m => [...m.preview].length === 500 && m.cut === true && m.chars === whole(m)?.length), b1m[0] && { preview: b1m[0].preview.length, chars: b1m[0].chars, cut: b1m[0].cut })
  p.check('caps: a page stops at 16,000 characters of previews (32 of these) and says so, with the cursor for the rest',
    b1m.length === 32 && previewChars <= 16000 && b1.json.has_more === true && /16000 characters/.test(b1.json.note ?? '') && /fetch/.test(b1.json.note ?? ''),
    { got: b1m.length, previewChars, note: b1.json?.note })
  const b2 = b1.json?.next_cursor ? await conv('alice', { peer: 'bob', limit: 100, cursor: b1.json.next_cursor }) : null
  const bobAll = [...ids(b2), ...ids(b1)]
  p.check('caps: the cursor gives the other 8; together all 40 in order', b2?.ok && ids(b2).length === 8 && b2.json.has_more === false
    && JSON.stringify(bobAll) === JSON.stringify(longIds), { second: ids(b2).length })
  const longSent = seq.find(s => s.body.startsWith('A2C-13 '))
  const f = await fetchIds('alice', [longSent.id, uidOf(longs[0])])
  const fs1 = (f.json?.messages ?? []).find(m => m.id === longSent.id)
  const fr1 = (f.json?.messages ?? []).find(m => m.id === uidOf(longs[0]))
  p.check('caps: fetch gives a cut message whole, one she sent (marked sent, to carol) and one she received', f.ok
    && fs1?.content === longSent.body && fs1.direction === 'sent' && fs1.to === 'carol' && fr1?.content === longs[0] && fr1.direction === 'received',
    { sent: fs1 && { dir: fs1.direction, to: fs1.to, len: fs1.content?.length }, received: fr1 && { dir: fr1.direction, len: fr1.content?.length }, not_found: f.json?.not_found })

  // ---------------------------------------------------------------- user
  const scratch = path.join(rig.data, 'scratch', A, 'alice')
  fs.mkdirSync(scratch, { recursive: true })
  fs.writeFileSync(path.join(scratch, 'summary-for-user.txt'), 'a summary\n')
  const userSeq = [{ body: 'U0 hello alice, start here.', sent: false }]
  await rig.userMail('alice', 'U1 user to alice', { notice: true }); userSeq.push({ body: 'U1 user to alice', sent: false })
  await rig.userMail('carol', 'U-carol user to carol (not alice\'s)', { notice: true })
  await note('alice', 'user', 'A2U-1 alice to the user'); userSeq.push({ body: 'A2U-1 alice to the user', sent: true })
  await note('boss', 'user', 'B2U boss to the user (not alice\'s)')
  await rig.userMail('alice', 'U2 user to alice', { notice: true }); userSeq.push({ body: 'U2 user to alice', sent: false })
  const att = await note('alice', 'user', 'A2U-2 alice sends a file', { attachments: ['summary-for-user.txt'] })
  userSeq.push({ body: 'A2U-2 alice sends a file', sent: true })
  const u = await conv('alice', { peer: 'user' })
  const um = u.json?.messages ?? []
  p.check('user: the user\'s mail to alice and hers to the user, in order, nobody else\'s', u.ok
    && JSON.stringify(um.map(m => m.preview)) === JSON.stringify(userSeq.map(s => s.body))
    && um.every((m, i) => m.direction === (userSeq[i].sent ? 'sent' : 'received')), { got: um.map(m => `${m.direction}:${m.preview}`), attach: att.text })
  p.check('user: the attachment is named', um.at(-1)?.attachments?.[0] === 'summary-for-user.txt', um.at(-1)?.attachments)
  const u2 = await conv('alice', { peer: '@user' })
  p.check('user: "@user" reads the same', u2.ok && JSON.stringify(ids(u2)) === JSON.stringify(ids(u)))

  // ---------------------------------------------------------------- outside
  const B = (await rig.api('POST', '/api/orgs', { name: 'Rig Recall Peer', dirs: [], ...(rig.hubUrl ? {} : { net_autoconnect: false }) })).slug
  await rig.op({ op: 'hire', name: 'zoe', tier: 'haiku', title: 'B lead', grant: 5 }, { org: B })
  await settle('B\'s first hire')
  const orgId = slug => rig.one(`SELECT id FROM ot.orgs WHERE slug = '${q(slug)}' AND state = 'active'`).id
  const mailTo = (slug, agent, body) => rig.one(`SELECT m.uid FROM ot.mail m JOIN ot.agents a ON a.id = m.recipient_agent_id
    WHERE a.org_id = ${orgId(slug)} AND a.name = '${q(agent)}' AND m.body = '${q(body)}' ORDER BY m.id DESC LIMIT 1`)?.uid
  const o1 = await rig.tool('boss', 'orgtree_message', { to: `@org:${B}`, body: 'ORG-1 boss to B' })
  await rig.waitFor(() => mailTo(B, 'zoe', 'ORG-1 boss to B'), { what: 'zoe to get ORG-1', timeout: 30000 })
  await rig.tool('zoe', 'orgtree_message', { to: `@org:${A}`, body: 'ORG-2 zoe answers' }, { org: B })
  const o2 = await rig.waitFor(() => mailTo(A, 'boss', 'ORG-2 zoe answers'), { what: 'boss to get ORG-2', timeout: 30000 })
  const o3 = await rig.tool('boss', 'orgtree_message', { to: `@org:${B}`, body: 'ORG-3 boss replies', reply_to: o2 })
  const ob = await conv('boss', { peer: `@org:${B}` })
  const obm = ob.json?.messages ?? []
  p.check('outside: boss\'s @org: mail, his sends and the answer, in order, the reply linked', ob.ok
    && JSON.stringify(obm.map(m => `${m.direction}:${m.preview}`)) === JSON.stringify(['sent:ORG-1 boss to B', 'received:ORG-2 zoe answers', 'sent:ORG-3 boss replies'])
    && obm[0].id === sentId(o1) && obm[2].id === sentId(o3) && obm[2].reply_to?.id === o2, { got: obm.map(m => `${m.direction}:${m.preview}`), reply: obm[2]?.reply_to })
  const bare = await conv('boss', { peer: B })
  p.check('outside: the bare org name reads the same', bare.ok && bare.json.peer === `@org:${B}` && JSON.stringify(ids(bare)) === JSON.stringify(ids(ob)), bare.json?.peer)
  const fo = await fetchIds('boss', [sentId(o1)])
  p.check('outside: fetch gives boss\'s own outside mail whole (sent, to @org:)', fo.json?.messages?.[0]?.content === 'ORG-1 boss to B'
    && fo.json.messages[0].direction === 'sent' && fo.json.messages[0].to === `@org:${B}`, fo.json)
  const none = await conv('alice', { peer: `@org:${B}` })
  p.check('outside: alice (not a holder, sent nothing) has no mail with B', none.ok && none.json.messages?.length === 0
    && /no mail with/.test(none.json.note ?? ''), none.json?.note)
  if (rig.hubUrl) {
    await rig.api('POST', `/api/orgs/${A}/settings`, { net_autoconnect: true })
    const registered = slug => rig.api('GET', `/api/orgs/${slug}`).then(t => (t.net?.hubs ?? []).find(h => h.connected))
    await rig.waitFor(() => registered(A), { what: 'A to register on the hosted hub', timeout: 90000 })
    await rig.waitFor(() => registered(B), { what: 'B to register on the hosted hub', timeout: 90000 })
    const netSlug = slug => rig.one(`SELECT net->'identity'->>'slug' AS s FROM ot.orgs WHERE slug = '${q(slug)}' AND state = 'active'`).s
    const [nA, nB] = [netSlug(A), netSlug(B)]
    // a fresh registration reaches the other org's roster within a minute
    await rig.waitFor(async () => (await rig.tool('boss', 'orgtree_message', { to: `@net:${nB}`, body: 'NET-1 boss over the hub' })).ok,
      { what: 'boss to reach B over the hub', timeout: 90000, every: 5000 })
    await rig.waitFor(() => mailTo(B, 'zoe', 'NET-1 boss over the hub'), { what: 'zoe to get NET-1', timeout: 60000 })
    await rig.waitFor(async () => (await rig.tool('zoe', 'orgtree_message', { to: `@net:${nA}`, body: 'NET-2 zoe answers over the hub' }, { org: B })).ok,
      { what: 'zoe to reach A over the hub', timeout: 90000, every: 5000 })
    const n2 = await rig.waitFor(() => mailTo(A, 'boss', 'NET-2 zoe answers over the hub'), { what: 'boss to get NET-2', timeout: 60000 })
    await rig.tool('boss', 'orgtree_message', { to: `@net:${nB}`, body: 'NET-3 boss replies over the hub', reply_to: n2 })
    await rig.waitFor(() => mailTo(B, 'zoe', 'NET-3 boss replies over the hub'), { what: 'zoe to get NET-3', timeout: 60000 })
    const nb = await conv('boss', { peer: `@net:${nB}` })
    const nz = await conv('zoe', { peer: `@net:${nA}` }, { org: B })
    const shape = r => (r.json?.messages ?? []).map(m => `${m.direction}:${m.preview}`)
    p.check('outside: boss\'s @net: mail through the hub, his sends and the answer, in order (the @org: mail apart)', nb.ok
      && JSON.stringify(shape(nb)) === JSON.stringify(['sent:NET-1 boss over the hub', 'received:NET-2 zoe answers over the hub', 'sent:NET-3 boss replies over the hub'])
      && nb.json.messages[2].reply_to?.id === n2, { got: shape(nb), reply: nb.json?.messages?.[2]?.reply_to })
    p.check('outside: zoe (B\'s holder) sees the same exchange from her side', nz.ok
      && JSON.stringify(shape(nz)) === JSON.stringify(['received:NET-1 boss over the hub', 'sent:NET-2 zoe answers over the hub', 'received:NET-3 boss replies over the hub']),
    shape(nz))
  } else {
    p.note('no --hub: the @net: checks were skipped (the @org: path ran)')
  }

  // ---------------------------------------------------------------- bounds
  const bossCursor = (await conv('boss', { peer: 'alice', limit: 1 })).json?.next_cursor
  const foreign = bossCursor ? await conv('alice', { peer: 'boss', cursor: bossCursor }) : null
  const unknown = await conv('alice', { peer: 'nobody-here' })
  const self = await conv('alice', { peer: 'alice' })
  const extra = await conv('alice', { peer: 'carol', agent: 'boss' })
  const noPeer = await conv('alice', {})
  p.check('bounds: another agent\'s cursor, an unknown peer, herself, an extra argument and no peer are refused',
    foreign && !foreign.ok && /cursor/.test(foreign.text) && !unknown.ok && /no agent named nobody-here/.test(unknown.text)
    && !self.ok && /that is you/.test(self.text) && !extra.ok && /peer, cursor and limit only/.test(extra.text) && !noPeer.ok,
    { foreign: foreign?.text, unknown: unknown.text, self: self.text, extra: extra.text, noPeer: noPeer.text })
  const bobCarol = await conv('bob', { peer: 'carol' })
  p.check('bounds: bob has no mail with carol', bobCarol.ok && bobCarol.json.messages?.length === 0 && /You have no mail with carol/.test(bobCarol.json.note ?? ''),
    bobCarol.json?.note)
  const peek = await fetchIds('bob', [seq[0].id, seq[2].id])
  p.check('bounds: fetch does not find mail between others', peek.ok && (peek.json?.messages ?? []).length === 0 && peek.json.not_found?.length === 2,
    peek.json)

  // ---------------------------------------------------- handoff and backlog
  // alice has read nothing since her first turn: over a hundred notices wait
  await settle('everyone idle before the compact')
  const cc = await rig.tool('boss', 'orgtree_cheap_compact', { node: 'alice' })
  const pending = () => rig.sql(`SELECT id, notice, body FROM ot.mail WHERE recipient_agent_id = ${id('alice')} AND state = 'pending' ORDER BY id`)
  const claimedBy = t => t ? rig.sql(`SELECT id, notice, body FROM ot.mail WHERE turn_id = ${t.id} ORDER BY id`) : []
  // a real message from the user, and the turn it starts (null: none in 45 s)
  const wake = async body => {
    const done = rig.turns('alice').filter(t => t.ended_at).length
    const before = pending()
    await rig.userMail('alice', body)
    const sent = rig.one(`SELECT id, notice, body FROM ot.mail WHERE recipient_agent_id = ${id('alice')} AND body = '${q(body)}' ORDER BY id DESC LIMIT 1`)
    const waiting = [...before, sent].filter(Boolean)
    try {
      await rig.waitTurns('alice', done + 1, { timeout: 45000 })
    } catch {
      return { waiting, turn: null }
    }
    return { waiting, turn: rig.turns('alice').filter(t => t.ended_at).at(-1) }
  }
  // what a turn should claim: the 64 oldest waiting, and the oldest real one
  const expectedClaim = waiting => [...new Set([...waiting.slice(0, 64), waiting.find(m => !m.notice)].filter(Boolean).map(m => m.id))].sort((a, b) => a - b)
  const w1 = await wake('U-AFTER what were we discussing?')
  const prompt = w1.turn ? rig.fakeLog('alice').filter(l => l.kind === 'turn').at(-1)?.prompt ?? '' : ''
  const k1 = claimedBy(w1.turn)
  p.check('backlog: a real message behind more than 64 waiting notices starts its turn, with the 64 oldest', w1.waiting.filter(m => m.notice).length > 64
    && !!w1.turn && JSON.stringify(k1.map(m => m.id)) === JSON.stringify(expectedClaim(w1.waiting)) && k1.some(m => m.body.startsWith('U-AFTER ')),
  { waiting: w1.waiting.length, notices: w1.waiting.filter(m => m.notice).length, turn: w1.turn?.id ?? "no turn within 45 s", claimed: k1.length })
  const w2 = w1.turn ? await wake('U-AFTER-2 and the rest?') : { waiting: [], turn: null }
  const k2 = claimedBy(w2.turn)
  p.check('backlog: the notices left over ride the next turn, oldest first, and nothing stays waiting', !!w2.turn
    && JSON.stringify(k2.map(m => m.id)) === JSON.stringify(expectedClaim(w2.waiting)) && w2.waiting.length <= 65 && pending().length === 0,
  { leftover: w2.waiting.length, claimed: k2.length, still: pending().length })
  const listed = /You exchanged mail most recently with: ([^\n]*?)\.\n/.exec(prompt)?.[1] ?? ''
  const names = listed.split(', ').map(s => s.replace(/ \([^)]*\)$/, '')).filter(Boolean)
  const want = rig.sql(`SELECT peer FROM (
      SELECT CASE WHEN m.sender_agent_id IS NOT NULL THEN s.name WHEN m.sender = '@user' THEN 'user' END AS peer, m.created_at AS at
        FROM ot.mail m LEFT JOIN ot.agents s ON s.id = m.sender_agent_id WHERE m.recipient_agent_id = ${id('alice')} AND m.state <> 'retracted'
      UNION ALL
      SELECT CASE WHEN m.recipient_kind = 'user' THEN 'user' ELSE r.name END, m.created_at
        FROM ot.mail m LEFT JOIN ot.agents r ON r.id = m.recipient_agent_id WHERE m.sender_agent_id = ${id('alice')}
    ) x WHERE peer IS NOT NULL GROUP BY peer ORDER BY max(at) DESC LIMIT 6`).map(r => r.peer)
  p.check('handoff: the fresh session is told to recall a conversation before replying', cc.ok && /fresh session/.test(prompt)
    && /orgtree_inbox action=conversation peer=<name> before you reply/.test(prompt), { compact: cc.text, prompt: prompt.slice(0, 900) })
  p.check('handoff: it names her most recent correspondents, newest first', names.length > 0 && JSON.stringify(names) === JSON.stringify(want)
    && names[0] === 'user', { names, want })

  p.keep(rig, { agents: ['alice', 'carol', 'boss', 'bob', 'zoe'], grep: /conversation|correspondent|handoff/i })
  return p.summary()
}
