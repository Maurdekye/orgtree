// Proof: a person on the mail hub is answered with orgtree_message to their
// @net address (decision 63; user 2026-10-09: agents "should always reply to a
// network address when communicating with a human over hubchat instead of
// replying inline, even if that human is the user who already has direct
// access to orgtree"). A reply that stays in the turn's text never reaches them.
//   tess (a new top-level hire): her launch instructions carry the rule in
//   their org-inbox passage.
//   nova (a new report with no outside audience): her instructions have no
//   org-inbox passage, as before.
//   the inbox holder: a message from @net:peer.rig reaches his turn with a
//   one-line reminder naming that address; the user's own mail has none.
// Run: node tools/rig/rig.mjs run tools/rig/proofs/hubchat-reply.mjs

import fs from 'node:fs'

import { Proof } from '../proof.mjs'

const RULE = 'A person writing over the hub (an @net: sender, e.g. on Hubchat) sees only what you send them: '
  + 'ALWAYS answer with orgtree_message to that @net: address, because a reply only in your turn\'s text never '
  + 'reaches them — even when that person is the user, who could also read Orgtree directly.'
const LINE = '↳ Answer with orgtree_message to @net:peer.rig: a reply only in your turn\'s text never reaches them.'

export default async function (rig) {
  const p = new Proof('hubchat-reply')
  rig.scenario({ default: { turns: [{ name: 'default', steps: [{ text: 'OK.' }] }] } })
  await rig.waitFor(() => rig.sql('SELECT 1 FROM ot.turns WHERE ended_at IS NULL').length === 0, { what: 'seed turns to settle', timeout: 60000 })
  await rig.op({ op: 'hire', name: 'tess', tier: 'haiku', title: 'New top-level hire' })
  await rig.op({ op: 'hire', name: 'nova', parent: 'boss', tier: 'haiku', title: 'New report' })
  const turn = async (name, text) => {
    const done = rig.turns(name).length
    await rig.userMail(name, text)
    await rig.waitTurns(name, done + 1)
  }
  for (const name of ['tess', 'nova']) await turn(name, `Hello ${name}.`)

  // the instructions file each CLI was launched with (--append-system-prompt-file)
  const identity = name => {
    const args = rig.fakeLog(name).filter(l => l.kind === 'start').at(-1)?.args ?? []
    const at = args.indexOf('--append-system-prompt-file')
    const file = at >= 0 ? args[at + 1] : null
    return file && fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
  }
  const around = (text, needle) => {
    const i = (text ?? '').indexOf(needle)
    return i < 0 ? null : text.slice(Math.max(0, i - 120), i + 360)
  }
  const tess = identity('tess'), nova = identity('nova')
  p.check('tess (a new top-level hire): her instructions say to answer a person on the hub with orgtree_message to their @net address, even when that person is the user',
    tess.includes(RULE), { at: around(tess, 'over the hub') ?? around(tess, 'THE ORG INBOX'), bytes: tess.length })
  p.check('nova (a new report with no outside audience): her instructions have no org-inbox passage, as before',
    nova.length > 0 && !nova.includes('THE ORG INBOX') && !nova.includes('over the hub'), { bytes: nova.length })

  // a person on the hub writes in
  await rig.api('POST', '/api/rig/hub-mail', { org: rig.org, op: 'inbound', id: 'hubchat-1', body: 'HUBCHAT-HELLO: are you there?' })
  const delivered = await rig.waitFor(() => rig.one(`SELECT a.name FROM ot.mail m JOIN ot.agents a ON a.id = m.recipient_agent_id
                                                     WHERE m.net_id = 'hubchat-1' ORDER BY m.id LIMIT 1`), { what: 'the hub message to arrive', timeout: 30000 })
  const holder = delivered.name
  const promptWith = needle => rig.fakeLog(holder).filter(l => l.kind === 'turn' && (l.prompt ?? '').includes(needle)).at(-1)?.prompt ?? null
  const hub = await rig.waitFor(() => promptWith('HUBCHAT-HELLO'), { what: `${holder}'s turn with the hub message`, timeout: 60000 }).catch(() => null)
  p.check(`${holder} (the inbox holder): the hub message reaches his turn with the reminder to answer @net:peer.rig with orgtree_message`,
    !!hub && hub.includes(LINE), { at: around(hub, 'HUBCHAT-HELLO') })

  await rig.waitFor(() => rig.turns(holder).every(t => t.ended_at), { what: `${holder} to be idle`, timeout: 60000 })
  await turn(holder, 'USER-HELLO from the desk.')
  const user = promptWith('USER-HELLO')
  p.check('the user\'s own mail carries no hub reminder', !!user && !user.includes('↳ Answer with orgtree_message'), { at: around(user, 'USER-HELLO') })

  p.keep(rig, { agents: ['tess', 'nova', holder] })
  return p.summary()
}
