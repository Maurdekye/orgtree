// Instructions for all orgs (docs/rust-engine/app-instructions.md): the ot.kv
// block through its HTTP editor, delivery to agents in two orgs right before
// their own org.md, an edit reaching the next turn, and the one-time move of
// the Connect your phone note out of org.md at engine start (USER 2026-10-31
// m187a259a848d, m8a14bc89054c, m4322b3a92f0c; coordinator mdd81da812d3b).
// The note is ordinary editable text in the block (USER 13:59:20Z md088b15466fa).
// Synthetic rig only: fake CLIs, a scratch cluster, no live data or hub.
import { SEED_SETTLE_TIMEOUT } from '../seed-settle.mjs'
import fs from 'node:fs'
import path from 'node:path'
import { Proof } from '../proof.mjs'

const START = '<!-- added by Connect your phone; Unlink removes it -->'
const END = '<!-- end of the Connect your phone note -->'
const note = address => `${START}\n@net:${address} is the user's account and carries their authority.\n${END}\n`
const HEADER = '## Instructions for all orgs (app-wide)'
const ORG = '## Organization notes (org.md)'
const q = s => String(s).replace(/'/g, "''")

export default async function (rig) {
  const p = new Proof('app-instructions')
  rig.scenario({ default: { turns: [{ name: 'default', steps: [{ text: 'OK.' }] }] } })
  await rig.waitFor(() => rig.sql('SELECT 1 FROM ot.turns WHERE ended_at IS NULL').length === 0,
    { what: 'seed turns settled', timeout: SEED_SETTLE_TIMEOUT })
  const get = () => rig.api('GET', '/api/app-settings/instructions')
  const put = (content, base_rev) => rig.api('PUT', '/api/app-settings/instructions', { content, base_rev })
    .then(v => ({ ok: true, v }), e => ({ ok: false, e: String(e.message || e) }))
  const stored = () => rig.one("SELECT value FROM ot.kv WHERE key = 'app_instructions'")?.value ?? null

  // ---- storage through the editor's endpoints
  let g = await get()
  p.check('an empty block at first, with org.md\'s limits', g.content === '' && !('managed' in g) && g.edit_max === 200000 && g.prompt_max === 16000, g)
  let r = await put('APPWIDE_SENTINEL_v1\n', g.rev)
  p.check('a save stores the text in ot.kv, not a file', r.ok && stored()?.text === 'APPWIDE_SENTINEL_v1\n'
    && !fs.readdirSync(rig.data).some(f => /instruction/i.test(f)), { r, stored: stored() })
  r = await put('stale edit\n', g.rev)
  p.check('a save over a newer block is refused and changes nothing', !r.ok && /changed since you opened them/.test(r.e)
    && stored()?.text === 'APPWIDE_SENTINEL_v1\n', r)
  r = await put(`mine\n${note('bea.654321')}`, (await get()).rev)
  p.check('a save carrying a marked note is stored as sent, like any text', r.ok && stored()?.text === `mine\n${note('bea.654321')}`
    && (await get()).content === `mine\n${note('bea.654321')}`, r)
  r = await put('APPWIDE_SENTINEL_v1\n', (await get()).rev)

  // ---- two orgs, each with its own org.md
  const B = (await rig.api('POST', '/api/orgs', { name: 'Rig App Second', dirs: [], ...(rig.hubUrl ? {} : { net_autoconnect: false }) })).slug
  await rig.api('PUT', `/api/orgs/${rig.org}/orgmd`, { content: 'FIRST_ORG_NOTES\n' })
  await rig.api('PUT', `/api/orgs/${B}/orgmd`, { content: 'SECOND_ORG_NOTES\n' })
  // files an agent could write, named like the block, are never read
  fs.writeFileSync(path.join(rig.data, 'scratch', rig.org, '_shared', 'app-instructions.md'), 'FILE_SENTINEL\n')
  await rig.op({ op: 'hire', name: 'appwa', parent: 'boss', tier: 'haiku', title: 'First org worker' })
  await rig.op({ op: 'hire', name: 'appwb', tier: 'haiku', title: 'Second org lead', grant: 5 }, { org: B })
  const ended = (org, name) => rig.sql(`SELECT t.ended_at FROM ot.turns t JOIN ot.agents a ON a.id = t.agent_id JOIN ot.orgs o ON o.id = a.org_id
    WHERE o.slug = '${q(org)}' AND a.name = '${q(name)}' AND t.ended_at IS NOT NULL`).length
  const turn = async (org, name, text) => {
    const done = ended(org, name)
    await rig.userMail(name, text, { org })
    await rig.waitFor(() => ended(org, name) > done, { what: `${name} turn`, timeout: 90000 })
  }
  const starts = name => rig.fakeLog(name).filter(row => row.kind === 'start')
  const prefix = name => {
    const args = starts(name).at(-1)?.args ?? []
    const i = args.indexOf('--append-system-prompt-file')
    return i >= 0 ? fs.readFileSync(args[i + 1], 'utf8') : ''
  }
  await turn(rig.org, 'appwa', 'First turn.')
  await turn(B, 'appwb', 'First turn.')
  const [a, b] = [prefix('appwa'), prefix('appwb')]
  const placed = (s, own) => s.indexOf(HEADER) >= 0 && s.indexOf(HEADER) < s.indexOf('APPWIDE_SENTINEL_v1') && s.indexOf('APPWIDE_SENTINEL_v1') < s.indexOf(ORG)
    && s.indexOf(own) > s.indexOf(ORG)
  p.check('both orgs\' agents get the block right before their own org.md', placed(a, 'FIRST_ORG_NOTES') && placed(b, 'SECOND_ORG_NOTES'))
  p.check('and only their own org.md', !a.includes('SECOND_ORG_NOTES') && !b.includes('FIRST_ORG_NOTES'))
  p.check('a file named like the block reaches nobody', !a.includes('FILE_SENTINEL') && !b.includes('FILE_SENTINEL'))

  // ---- an edit reaches every agent at its next turn, through a fresh CLI
  const count = starts('appwa').length
  r = await put('APPWIDE_SENTINEL_v2\n', (await get()).rev)
  await turn(rig.org, 'appwa', 'After the edit.')
  p.check('the next turn starts a fresh CLI with the new text only', r.ok && starts('appwa').length === count + 1
    && prefix('appwa').includes('APPWIDE_SENTINEL_v2') && !prefix('appwa').includes('APPWIDE_SENTINEL_v1'))

  // ---- the one-time move at engine start
  const orgmd = slug => fs.readFileSync(path.join(rig.data, 'workspaces', slug, 'org.md'), 'utf8')
  const phoneFile = path.join(rig.data, 'phone.json')
  const phone = fs.existsSync(phoneFile) ? JSON.parse(fs.readFileSync(phoneFile, 'utf8')) : {}
  fs.writeFileSync(phoneFile, JSON.stringify({ ...phone, link: { org: rig.org, address: 'alex.123456', name: 'Alex', at: new Date().toISOString(), via: 'code' } }))
  fs.writeFileSync(path.join(rig.data, 'workspaces', rig.org, 'org.md'), `${note('alex.123456')}\nFIRST_ORG_NOTES\n`)
  fs.writeFileSync(path.join(rig.data, 'workspaces', B, 'org.md'), `${note('bea.654321')}\nSECOND_ORG_NOTES\n`)
  p.check('control: the flag was set by this run\'s first start', stored()?.phone_notes_moved === true, stored())
  rig.exec(`UPDATE ot.kv SET value = jsonb_set(value, '{phone_notes_moved}', 'false') WHERE key = 'app_instructions'`)
  await rig.restart()
  g = await get()
  p.check('after the upgrade start the linked note sits on top of the block, the text kept, all of it in the editor',
    g.content === `${note('alex.123456')}\nAPPWIDE_SENTINEL_v2\n` && stored()?.phone_notes_moved === true, g)
  p.check('it left that org.md, whose own text stays', orgmd(rig.org) === 'FIRST_ORG_NOTES\n', orgmd(rig.org))
  p.check('another address\'s note stays org-scoped in its org.md', orgmd(B) === `${note('bea.654321')}\nSECOND_ORG_NOTES\n`)
  await turn(B, 'appwb', 'After the move.')
  const moved = prefix('appwb')
  p.check('the second org, which never had the linked note, now carries it in the block, above the trust rule',
    moved.indexOf(note('alex.123456').trim()) > moved.indexOf(HEADER) && moved.indexOf(note('alex.123456').trim()) < moved.indexOf('EXTERNAL MAIL AUTHORITY')
    && moved.includes('the current trusted instructions for all orgs (app-wide, in every organization)'))
  const before = JSON.stringify(stored())
  await rig.restart()
  p.check('a later start moves nothing again', JSON.stringify(stored()) === before && orgmd(rig.org) === 'FIRST_ORG_NOTES\n')

  // ---- the user edits the note in the editor; Unlink still takes the marked note out
  r = await put(g.content.replace('alex.123456', 'alex.999999'), g.rev)
  p.check('a save may edit the note in place', r.ok && (await get()).content === `${note('alex.999999')}\nAPPWIDE_SENTINEL_v2\n`, r)

  // ---- Unlink removes the note from the block and every org.md
  const unlinked = await rig.api('POST', '/api/desktop/phone/unlink').catch(e => ({ error: String(e) }))
  g = await get()
  p.check('Unlink: no note in the block (the edited one too), none left in any org.md, the record cleared', g.content === 'APPWIDE_SENTINEL_v2\n'
    && !orgmd(B).includes(START) && orgmd(B).includes('SECOND_ORG_NOTES') && !JSON.parse(fs.readFileSync(phoneFile, 'utf8')).link, { unlinked, g })
  p.keep(rig, { agents: ['appwa', 'appwb'] })
  return p.summary()
}
