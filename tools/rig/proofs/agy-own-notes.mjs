// Fake CLI / synthetic scratch only. No native/model/auth claims.
// Red: 72ea305; first two unit red controls committed separately at e0eb352.
import fs from 'node:fs'
import path from 'node:path'
import { Proof } from '../proof.mjs'

export default async function (rig) {
  const p = new Proof('agy-own-notes')
  rig.scenario({ default: { turns: [{ name: 'default', steps: [{ text: 'OK.' }] }] } })
  await rig.waitFor(() => rig.sql('SELECT 1 FROM ot.turns WHERE ended_at IS NULL').length === 0,
    { what: 'seed turns settle', timeout: 60000 })
  const agents = ['notesowner', 'oldidentity', 'mixednotes']
  const scratch = name => path.join(rig.data, 'scratch', rig.org, name)
  const notes = '# Standing notes\r\nNOTES_ONLY_ONCE_SENTINEL\r\n'
  const preamble = 'You are "oldidentity", an agent in the organization "Proof" (orgtree). '
  const closing = 'Your scratch folder is your own: keep a CLAUDE.md there as standing notes — it is loaded automatically every turn and survives compaction. '
  const legacy = preamble + 'x'.repeat(56918 - Buffer.byteLength(preamble + closing)) + closing
  const mixed = legacy + '\nAUTHORED_OUTSIDE_ENVELOPE\n'
  for (const name of agents) {
    await rig.op({ op: 'hire', name, parent: 'boss', tier: 'flash', title: name, charter: 'Synthetic notes fixture' })
    fs.mkdirSync(scratch(name), { recursive: true })
    fs.writeFileSync(path.join(scratch(name), 'AGENTS.md'), name === 'notesowner' ? notes : name === 'oldidentity' ? legacy : mixed)
  }
  const read = file => { try { return fs.readFileSync(file, 'utf8') } catch (e) { if (e.code === 'ENOENT') return null; throw e } }
  const starts = name => rig.fakeLog(name).filter(x => x.kind === 'start')
  const parts = name => {
    const dir = path.join(scratch(name), '.agents/rules')
    if (!fs.existsSync(dir)) return []
    return fs.readdirSync(dir).filter(n => /^orgtree-identity-\d+\.md$/.test(n)).sort().map(n => read(path.join(dir, n)))
  }
  const body = name => parts(name).map(s => s.slice(s.indexOf('<!-- orgtree:generated-identity:v1 -->\n') + '<!-- orgtree:generated-identity:v1 -->\n'.length)).join('')
  const turn = async name => {
    const count = rig.turns(name).filter(x => x.ended_at).length
    await rig.userMail(name, 'Please complete the synthetic turn.')
    await rig.waitTurns(name, count + 1)
  }
  await turn('notesowner')
  const first = starts('notesowner').at(-1)
  const firstParts = parts('notesowner')
  p.check('control: fake AGY completes a turn in the original scratch cwd',
    !!first?.pid && path.resolve(first.cwd) === path.resolve(scratch('notesowner')) && !rig.turns('notesowner').at(-1)?.error)
  p.check('authored standing notes survive first launch byte-for-byte', read(path.join(scratch('notesowner'), 'AGENTS.md')) === notes)
  p.check('native notes do not appear again in generated identity', firstParts.length > 0 && !body('notesowner').includes('NOTES_ONLY_ONCE_SENTINEL'))
  p.check('discoverable rules have always_on frontmatter and bounded bytes', firstParts.length > 0 && firstParts.every(s => s.startsWith('---\ntrigger: always_on\n') && Buffer.byteLength(s) < 24000))
  // Actual actor timer and a second turn, not merely a helper hash comparison.
  await new Promise(resolve => setTimeout(resolve, 22000))
  await turn('notesowner')
  p.check('unchanged notes retain parked process and byte-identical identity',
    starts('notesowner').at(-1)?.pid === first?.pid && JSON.stringify(parts('notesowner')) === JSON.stringify(firstParts) && firstParts.length > 0)
  fs.writeFileSync(path.join(scratch('notesowner'), 'AGENTS.md'), notes + 'NEW_NATIVE_NOTE\n')
  await turn('notesowner')
  p.check('native note edit causes next-turn refresh without overwriting notes',
    starts('notesowner').at(-1)?.pid !== first?.pid && read(path.join(scratch('notesowner'), 'AGENTS.md')) === notes + 'NEW_NATIVE_NOTE\n' && !body('notesowner').includes('NEW_NATIVE_NOTE'))
  await turn('oldidentity')
  const backups = fs.readdirSync(scratch('oldidentity')).filter(n => /^AGENTS\.generated-identity-.*\.bak$/.test(n))
  p.check('largest-size legacy envelope preserved in unique backup, absent from native file',
    backups.length === 1 && read(path.join(scratch('oldidentity'), backups[0])) === legacy && read(path.join(scratch('oldidentity'), 'AGENTS.md')) === null)
  p.check('migrated agent gets new identity without old payload duplication', parts('oldidentity').length > 0 && !body('oldidentity').includes('x'.repeat(200)))
  await turn('oldidentity')
  p.check('migration is one-time and does not trigger a second process',
    starts('oldidentity').length === 1 && fs.readdirSync(scratch('oldidentity')).filter(n => n.endsWith('.bak')).length === 1)
  await turn('mixednotes')
  p.check('extra authored text excludes envelope from migration and stays native once',
    read(path.join(scratch('mixednotes'), 'AGENTS.md')) === mixed && !body('mixednotes').includes('AUTHORED_OUTSIDE_ENVELOPE') && parts('mixednotes').length > 0)
  p.keep(rig, { agents, grep: /agy|startup|identity/ })
  return p.summary()
}
