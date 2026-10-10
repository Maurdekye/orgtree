// Proof: Quick chat (docket quick-prompt-hire-kick-off-and-focus-an-agent-fr).
//   In the real renderer, with no history the header box shows Opus, the org
//   default effort and top level. The user changes each inline (boss,
//   low, haiku), types a message and presses Enter: the engine hires an agent
//   named from the message's words under boss, on haiku at effort low, with
//   no charter; the message is its kickoff mail and its first turn plays it;
//   and the new agent's desk is the one in focus.
// Run: node tools/rig/rig.mjs run tools/rig/proofs/quick-chat.mjs --ui <bundle>

import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { runDesktop } from '../desktop.mjs'
import { Proof } from '../proof.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const MESSAGE = 'Summarize the open docket items for me'
const NAME = 'summarize-open-docket'

export default async function (rig) {
  const p = new Proof('quick-chat')
  await rig.waitFor(() => rig.sql('SELECT 1 FROM ot.turns WHERE ended_at IS NULL').length === 0,
    { what: 'seed turns to settle', timeout: 60000 })
  const r = await runDesktop(rig, path.join(here, '../desktop/quick-chat.cjs'),
    { preset: 'wide', out: path.join(p.dir, 'desktop'), args: { superior: 'boss', effort: 'low', model: 'haiku', message: MESSAGE } })
  p.check('the desktop script ran', r.ok, r.ok ? undefined : r)
  const v = r.value ?? {}
  p.check('no history: the buttons read opus · the org default · top level',
    v.initial?.[0] === 'opus' && /^default/.test(v.initial?.[1] ?? '') && v.initial?.[2] === 'top level', v.initial)
  p.check('the superior menu offers top level and the live agents',
    ['top level', 'boss', 'alice'].every(x => (v.superiorItems ?? []).some(i => i.startsWith(x))), v.superiorItems)
  p.check('after the inline choices the buttons read haiku · low · boss',
    JSON.stringify(v.chosen) === '["haiku","low","boss"]', v.chosen)

  await rig.waitFor(() => rig.sql(`SELECT 1 FROM ot.agents WHERE name = '${NAME}'`).length === 1,
    { what: 'the quick-chat hire', timeout: 20000 })
  const [row] = rig.sql(`SELECT a.tier, a.state, a.charter, a.scope->>'effort' AS effort, b.name AS parent
    FROM ot.agents a LEFT JOIN ot.agents b ON b.id = a.parent_id WHERE a.name = '${NAME}'`)
  p.check(`hired ${NAME} under boss on haiku, effort low, no charter`,
    row?.parent === 'boss' && row?.tier === 'haiku' && row?.effort === 'low' && row?.state === 'live'
      && (row?.charter == null || row?.charter === ''), row)
  const mail = rig.sql(`SELECT m.body, m.kind, m.sender FROM ot.mail m JOIN ot.agents a ON a.id = m.recipient_agent_id
    WHERE a.name = '${NAME}' ORDER BY m.id`)
  p.check('the message is its kickoff mail, from the user', mail.length === 1 && mail[0].body === MESSAGE, mail)
  await rig.waitTurns(NAME, 1)
  const played = rig.fakeLog(NAME).filter(l => JSON.stringify(l).includes(MESSAGE))
  p.check('its first turn was sent the message', played.length > 0, played.slice(0, 2))
  p.check('the new agent\'s desk is in focus', (v.focused ?? '').includes(NAME), { focused: v.focused, heads: v.after?.heads })
  p.check('the box cleared and keeps the choices for the next chat',
    v.after?.input === '' && JSON.stringify(v.after?.buttons) === '["haiku","low","boss"]', v.after)
  // (the rig's Electron prints its own CSP security warning; not the page's)
  const errors = (v.errors ?? []).filter(e => !/Electron Security Warning/.test(String(e)))
  p.check('no console errors', !errors.length, errors)
  if (r.out) p.note('screenshots', r.out)
  p.keep(rig, { agents: [NAME] })
  return p.summary()
}
