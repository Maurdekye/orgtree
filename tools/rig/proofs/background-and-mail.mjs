// Proof: background tasks and mid-turn mail through the real engine path.
//   P33 stopped: a background task the CLI reports failed → the agent gets a waking
//                "stopped without finishing" message.
//   P33 orphan:  the CLI dies holding a live background task → the agent is told
//                the task died with the process.
//   P36 unread:  mail waits 45 s while its recipient is in one long step → the
//                sender gets one passive "still unread" notice.
//   hook:        mail sent while the recipient works is handed over at its next
//                tool boundary (PostToolUse hook) and settles as delivered.
// Run: node tools/rig/rig.mjs run tools/rig/proofs/background-and-mail.mjs

import { Proof } from '../proof.mjs'

const bg = (id, tool, desc) => [
  { tool: 'Bash', id: tool, args: { command: desc, run_in_background: true }, result: `Command running in background with ID: ${id}` },
  { system: { subtype: 'task_started', task_id: id, tool_use_id: tool, description: desc, is_background: true } },
  { system: { subtype: 'background_tasks_changed', tasks: [{ task_id: id, description: desc, tool_use_id: tool }] } },
]

export default async function (rig) {
  const p = new Proof('background-and-mail')
  rig.scenario({
    agents: {
      carol: { turns: [
        { name: 'bg-stopped', match: 'PROOF-BG-STOP', once: true, steps: [
          ...bg('bgtask1', 'toolu_bg_stop', 'nightly-build'),
          { text: 'Started nightly-build in the background.' },
          { sleep_ms: 300 },
          { system: { subtype: 'task_notification', task_id: 'bgtask1', tool_use_id: 'toolu_bg_stop', status: 'failed',
                      summary: 'killed by signal 9', output_file: 'C:\\rig\\bgtask1.output' } },
          { text: 'Waiting for it.' },
        ] },
        { name: 'bg-orphan', match: 'PROOF-BG-ORPHAN', once: true, steps: [
          ...bg('bgtask2', 'toolu_bg_orphan', 'long-indexer'),
          { text: 'Indexer running in the background.' },
          { exit: 1 },
        ] },
      ] },
      alice: { turns: [
        { name: 'long-step', match: 'PROOF-LONG-STEP', once: true, steps: [{ text: 'Thinking hard...' }, { sleep_ms: 60000 }, { text: 'Done with the long step.' }] },
        { name: 'poll', match: 'PROOF-POLL', once: true, steps: [{ text: 'Working with tool calls.' }, { poll_mail: { every_ms: 1500, timeout_ms: 40000 } }, { text: 'Read my mail.' }] },
      ] },
    },
    default: { turns: [{ name: 'default', steps: [{ text: 'OK.' }] }] },
  })
  await rig.waitFor(() => rig.sql(`SELECT 1 FROM ot.turns WHERE ended_at IS NULL`).length === 0, { what: 'seed turns to settle', timeout: 60000 })
  const mailTo = (agent, like) => rig.sql(`SELECT m.uid, m.sender, m.notice, m.state, m.body FROM ot.mail m JOIN ot.agents a ON a.id = m.recipient_agent_id
                                            WHERE a.name = '${agent}' AND m.body LIKE '${like.replace(/'/g, "''")}' ORDER BY m.id`)

  // ---------------------------------------------------------------- P33: stopped background task
  await rig.userMail('carol', 'PROOF-BG-STOP: start the nightly build.')
  const stopped = await rig.waitFor(() => mailTo('carol', 'A background task you were waiting on stopped without finishing%'), { what: 'the stopped-task message', timeout: 60000 })
  p.check('P33 stopped: carol gets one waking stopped-task message', stopped.length === 1 && !stopped[0].notice && stopped[0].sender === '@system', stopped)
  p.check('P33 stopped: it names the task, status, missing exit code and output file',
    /nightly-build \(bgtask1\)/.test(stopped[0].body) && /status: failed/.test(stopped[0].body) && /exit code: unavailable/.test(stopped[0].body) && /bgtask1\.output/.test(stopped[0].body), stopped[0].body)
  await rig.waitFor(() => rig.sql(`SELECT 1 FROM ot.turns WHERE ended_at IS NULL`).length === 0, { what: 'carol to settle', timeout: 60000 })

  // ---------------------------------------------------------------- P33: orphaned background task
  await rig.userMail('carol', 'PROOF-BG-ORPHAN: start the indexer.')
  const orphan = await rig.waitFor(() => mailTo('carol', '%background subagent(s) you were waiting on died before finishing%'), { what: 'the orphan message', timeout: 60000 })
  p.check('P33 orphan: carol is told the background task died with its CLI', orphan.length === 1 && /long-indexer/.test(orphan[0].body) && /bgtask2/.test(orphan[0].body), orphan.map(m => m.body))
  p.note('the CLI death also starts the P34 retry (connection freeze); that path is covered by turn-recovery.mjs')

  // ---------------------------------------------------------------- P36: unread 45 s
  await rig.userMail('alice', 'PROOF-LONG-STEP: think hard for a minute.')
  await rig.waitFor(() => rig.sql(`SELECT 1 FROM ot.turns t JOIN ot.agents a ON a.id = t.agent_id WHERE a.name = 'alice' AND t.ended_at IS NULL`).length === 1,
    { what: 'alice to start her long step', timeout: 30000 })
  const sent = await rig.tool('bob', 'orgtree_message', { to: 'alice', body: 'PROOF-UNREAD from bob: please look when you can.' })
  p.check('P36: bob → alice mail accepted', sent.ok, sent.text)
  const sentAt = Date.now()
  const late = await rig.waitFor(() => mailTo('bob', 'Your mail to alice is still unread after%'), { what: 'the unread notice to bob', timeout: 75000, every: 1000 })
  const waited = (Date.now() - sentAt) / 1000
  p.check('P36: bob gets one passive "still unread" notice', late.length === 1 && late[0].notice === true, late)
  p.check('P36: it came after ~45 s', waited >= 44 && waited <= 60, { waitedS: waited, body: late[0].body })
  const settled = await rig.waitFor(() => {
    const m = mailTo('alice', 'PROOF-UNREAD from bob%')[0]
    return m && ['delivered', 'read'].includes(m.state) ? m : null
  }, { what: 'bob\'s mail to reach alice after the long step', timeout: 90000, every: 1000 })
  p.check('P36: the mail is delivered once alice\'s step ends', !!settled, settled)
  await rig.waitFor(() => rig.sql(`SELECT 1 FROM ot.turns WHERE ended_at IS NULL`).length === 0, { what: 'alice to settle', timeout: 90000 })
  p.check('P36: no second notice for the same mail', mailTo('bob', 'Your mail to alice is still unread after%').length === 1)

  // ---------------------------------------------------------------- mid-turn delivery at a tool boundary
  await rig.userMail('alice', 'PROOF-POLL: work with tools for a while.')
  await rig.waitFor(() => rig.fakeLog('alice').some(l => l.kind === 'turn' && l.script === 'poll'), { what: 'alice to start polling', timeout: 30000 })
  await new Promise(r => setTimeout(r, 2000))
  const sent2 = await rig.tool('bob', 'orgtree_message', { to: 'alice', body: 'PROOF-HOOK from bob: mid-turn hello.' })
  p.check('hook: bob → alice mid-turn mail accepted', sent2.ok, sent2.text)
  const handed = await rig.waitFor(() => rig.fakeLog('alice').find(l => l.kind === 'hook_mail' && /PROOF-HOOK from bob/.test(l.text)), { what: 'the hook to hand the mail over', timeout: 30000 })
  p.check('hook: the PostToolUse hook handed bob\'s mail to the CLI mid-turn', !!handed, handed?.text?.slice(0, 300))
  const row = await rig.waitFor(() => {
    const m = mailTo('alice', 'PROOF-HOOK from bob%')[0]
    return m && m.state !== 'pending' ? m : null
  }, { what: 'the hooked mail to leave pending', timeout: 30000 })
  p.check('hook: the mail is no longer pending (claimed by the turn)', !!row, row && { state: row.state })
  await rig.waitFor(() => rig.sql(`SELECT 1 FROM ot.turns WHERE ended_at IS NULL`).length === 0, { what: 'alice to finish', timeout: 60000 })
  const final = mailTo('alice', 'PROOF-HOOK from bob%')[0]
  p.check('hook: delivered once the turn ends', ['delivered', 'read'].includes(final?.state), final && { state: final.state })
  const desk = rig.sql(`SELECT c.body->>'role' AS role, left(c.body->>'text', 120) AS text, c.body->>'note' AS note FROM ot.convo c JOIN ot.agents a ON a.id = c.agent_id
                         WHERE a.name = 'alice' AND c.body::text LIKE '%PROOF-HOOK%' ORDER BY c.seq`)
  p.check('hook: alice\'s desk shows the steered mail row', desk.length >= 1, desk)

  p.keep(rig, { agents: ['carol', 'alice', 'bob'], grep: /carol|alice|bob|orphan|stopped|unread|steer|hook/i })
  return p.summary()
}
