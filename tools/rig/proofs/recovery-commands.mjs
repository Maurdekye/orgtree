// Synthetic fresh-session recovery: actual retained inputs, live scope and
// superior mail take precedence over stale transcript work. No shell is run.
import fs from 'node:fs'
import { Proof } from '../proof.mjs'

export default async function (rig) {
  const p = new Proof('recovery-commands')
  const command = "cargo test --locked -j2 --bin synthetic\nWrite-Output 'EXACT-COMMAND-TAIL'"
  const huge = 'x'.repeat(8191) + 'éBEYOND-COMMAND-CAP'
  const cwd = 'D:/synthetic/source  worktree'
  rig.scenario({ agents: { tara: { turns: [{ match: 'RECOVERY-SEED', steps: [
    { raw: { type: 'assistant', message: { id: 'recovery-inputs', role: 'assistant', content: [
      { type: 'text', text: 'STALE-EARLIER-TASK: work on the superseded assignment.' },
      { type: 'tool_use', id: 'exact', name: 'PowerShell', input: { command, workdir: cwd, description: 'Focused check description' } },
      { type: 'tool_use', id: 'large', name: 'Bash', input: { command: huge, description: 'Large shell command' } },
      { type: 'tool_use', id: 'other', name: 'Read', input: { description: 'Public read summary', file_path: 'synthetic', command: 'NON-SHELL-PRIVATE-INPUT' } },
    ] } } },
    { raw: { type: 'user', message: { content: ['exact','large','other'].map(id => ({ type: 'tool_result', tool_use_id: id, content: 'synthetic result' })) } } },
    { text: 'RECOVERY-SEED-DONE' },
  ] }] } }, default: { turns: [{ steps: [{ text: 'OK.' }] }] } })
  const settle = name => rig.waitFor(() => rig.turns(name).every(t => t.ended_at), { what: `${name} idle`, timeout: 60000 })
  await settle('boss')
  await rig.op({ op: 'hire', name: 'tara', parent: 'boss', tier: 'haiku', title: 'Recovery proof' })
  await settle('tara')
  const turn = async text => {
    const n = rig.turns('tara').length
    await rig.userMail('tara', text)
    await rig.waitTurns('tara', n + 1)
    await settle('tara')
  }
  await turn('RECOVERY-SEED')
  const work = async args => {
    const result = await rig.tool('tara', 'orgtree_work', args)
    if (!result.ok) throw new Error(result.text)
    return result.json
  }
  const dependency = await work({ action: 'create', title: 'Recovery prerequisite', kind: 'code', owner: 'tara',
    objective: 'A synthetic prerequisite that must finish before the current assignment.' })
  const item = await work({ action: 'create', title: 'Current recovery assignment', kind: 'code', owner: 'tara', dependencies: [dependency.slug],
    objective: 'CURRENT-LIVE-SCOPE: continue source 0123456789abcdef in D:/synthetic/source-worktree.' })
  await work({ action: 'update', slug: item.slug, status: 'blocked', blocked_reason: 'BLOCKING-DEPENDENCY: wait for compiler slot',
    done_so_far: ['Current scope recorded'], working_on_next: ['CURRENT-NEXT-STEP'] })
  // A newer backlog must not evict older active work at the 30-row cutoff.
  rig.exec(`INSERT INTO ot.work_items (org_id,slug,title,status,owner_agent_id,owner,created_by)
    SELECT a.org_id,'new-backlog-'||g,'New backlog '||g,'backlogged',a.id,'{}','{}'
    FROM ot.agents a CROSS JOIN generate_series(1,31) g WHERE a.name='tara'`)
  const beforeSuperior = rig.turns('tara').length
  const sent = await rig.tool('boss', 'orgtree_message', { metadata: { to: 'tara' }, body: 'SUPERIOR-LATEST-CURRENT: continue the current docket only.' })
  if (!sent.ok) throw new Error(sent.text)
  await settle('boss')
  await rig.waitTurns('tara', beforeSuperior + 1)
  await settle('tara')
  const compact = await rig.tool('boss', 'orgtree_cheap_compact', { node: 'tara' })
  p.check('superior can cheap compact the idle agent', compact.ok, compact.text)
  await turn('Resume using the live assignment.')
  const note = rig.fakeLog('tara').filter(l => l.kind === 'turn').at(-1)?.prompt ?? ''
  const live = note.indexOf('CURRENT-LIVE-SCOPE')
  const source = note.indexOf('Source/worktree evidence:')
  const superior = note.indexOf('SUPERIOR-LATEST-CURRENT')
  const older = note.indexOf('Older context follows.')
  p.check('live work survives newer backlog and leads recovery before source, superior and older context',
    live >= 0 && source > live && superior > source && older > superior, { live, source, superior, older })
  p.check('blocker and exact recorded worktree are present', note.includes('BLOCKING-DEPENDENCY') && note.includes(cwd))
  p.check('declared blocking dependency is retained with current scope', note.includes('Declared dependencies (first 10; check current status): ' + dependency.slug))
  p.check('digest retains exact multiline shell input rather than description alone', note.includes(command) && note.includes('Focused check description'))
  p.check('digest marks UTF8 command clipping and omits the clipped tail', note.includes('[command truncated at 8192 UTF-8 bytes]') && !note.includes('BEYOND-COMMAND-CAP'))
  p.check('non-shell full inputs stay out of recovery', !note.includes('NON-SHELL-PRIVATE-INPUT'))
  const saved = note.match(/Your whole earlier conversation is saved at ([^\n]+); read it/)
  const history = saved ? fs.readFileSync(saved[1], 'utf8') : ''
  p.check('saved history retains exact commands with the same cap and no other full inputs', history.includes(command)
    && history.includes('[command truncated at 8192 UTF-8 bytes]') && !history.includes('BEYOND-COMMAND-CAP') && !history.includes('NON-SHELL-PRIVATE-INPUT'))
  const chat = await rig.api('GET', `/api/orgs/${rig.org}/nodes/tara/chat?last=100`)
  p.check('visible transcript chip projection still excludes retained full command inputs',
    chat.messages.flatMap(m => m.tools ?? []).every(t => !('input' in t)))
  p.file('recovery-note.txt', note)
  p.file('saved-history.md', history)
  p.keep(rig, { agents: ['tara'] })
  return p.summary()
}
