// Proof: the user's question cards (orgtree_ask), end to end.
//   uma (holds a user audience) asks from inside a turn: the card is open on
//       her desk and attached to her docket item (which cannot be deleted
//       meanwhile); asking again amends the same card (one open request per
//       agent); a stale submit is refused; the user's answer reaches her as
//       mail and wakes her; her turns while it is open carry the "still OPEN"
//       line, and the item lets go of the question once it is answered.
//   ned (no audience): his question goes to his superior as mail, no card;
//       a link to an item he may not read is refused before anything is sent.
//   wes: at most 4 questions per call and 8 per card; the same question text
//       amends its tab; he withdraws the card, and answering it is refused.
//   dot: the user closes her card (every tab skipped): the card is
//       dismissed, not answered, and she is told; the older dismiss route too.
//   ray: retired with a card open: the card closes as moot and leaves his item.
//   cal: cheap-compacted with a card open: the card survives, and his fresh
//       session is told he still has it open and must not drop it unread.
//   hal: halted when the answer lands: no turn; unhalted, the answer wakes him.
//   mia: answered while her turn is still running: the answer reaches her
//       mid-turn, and no extra turn runs for it.
//   lex: a malformed tool call leaked the options into the question text:
//       the question and options are recovered; markup that cannot be
//       recovered is refused; labels and descriptions are clipped as in 3.x.
//   olga: the older answer route (/asks/{id}/answer, still called by older
//       clients) with 3.x's guards: a one-question card's picks all count,
//       an empty answer is refused, an unstamped answer to an amended card is
//       refused, and a batch answer needs exactly one answer per tab.
// Run: node tools/rig/rig.mjs run tools/rig/proofs/questions.mjs

import { Proof } from '../proof.mjs'

const Q_COLOUR = 'Which colour should the button be?'
const Q_SHIP = 'Ship it today?'

export default async function (rig) {
  const p = new Proof('questions')
  const agents = ['uma', 'ned', 'wes', 'dot', 'ray', 'cal', 'hal', 'mia', 'lex', 'olga']
  const scenario = slug => ({
    agents: {
      uma: { turns: [
        { name: 'ask', match: 'PROOF-ASK', once: true, steps: [
          { tool: 'orgtree_ask', args: { question: Q_COLOUR, header: 'Colour', work_item: slug,
            options: [{ label: 'Red', description: 'warm' }, { label: 'Blue' }] }, expect: "user's desk" },
          { text: 'Asked; ending my turn.' }] },
        { name: 'amend', match: 'PROOF-AMEND', once: true, steps: [
          { tool: 'orgtree_ask', args: { questions: [
            { question: Q_SHIP, options: ['Yes', 'No'] },
            { question: Q_COLOUR, header: 'Colour', work_item: slug, options: [{ label: 'Red' }, { label: 'Green' }] }] },
            expect: "user's desk" },
          { text: 'Amended.' }] },
      ] },
      mia: { turns: [
        { name: 'wait', match: 'PROOF-WAIT', once: true, steps: [
          { tool: 'orgtree_ask', args: { question: 'Proceed with plan B?', options: ['Yes', 'No'] }, expect: "user's desk" },
          { text: 'Carrying on while the user decides.' },
          { poll_mail: { every_ms: 1000, timeout_ms: 60000 } },
          { text: 'The answer arrived mid-turn.' }] },
      ] },
    },
    default: { turns: [{ name: 'default', steps: [{ text: 'OK.' }] }] },
  })
  rig.scenario(scenario(''))
  await rig.waitFor(() => rig.sql(`SELECT 1 FROM ot.turns WHERE ended_at IS NULL`).length === 0, { what: 'seed turns to settle', timeout: 60000 })
  for (const name of agents) await rig.op({ op: 'hire', name, parent: 'boss', tier: 'haiku', title: 'Question agent' })
  for (const name of agents.filter(n => n !== 'ned')) {
    await rig.api('POST', `/api/orgs/${rig.org}/audiences`, { action: 'grant', node: name, reason: 'proof: may ask the user' })
  }
  const id = name => rig.agentRow(name).id
  const row = name => rig.one(`SELECT uid, status, kind, rev, body, work_items, reason, answer_mail FROM ot.asks
    WHERE agent_id = ${id(name)} ORDER BY id DESC LIMIT 1`)
  const rows = name => rig.sql(`SELECT uid, status FROM ot.asks WHERE agent_id = ${id(name)} ORDER BY id`)
  const userMail = name => rig.sql(`SELECT uid, kind, body, state, notice FROM ot.mail WHERE recipient_agent_id = ${id(name)}
    AND sender = '@user' AND kind = 'decision' ORDER BY id`)
  const log = (agent, kind) => rig.fakeLog(agent).filter(l => !kind || l.kind === kind)
  const qs = r => (r?.body?.parts?.questions ?? r?.body?.questions ?? []).map(q => q.question)
  const tryApi = (method, route, body) => rig.api(method, route, body).then(json => ({ ok: true, json }),
    e => ({ ok: false, status: e.status, detail: String(e.body?.detail ?? e.message).slice(0, 200) }))
  const card = async name => ((await rig.api('GET', `/api/orgs/${rig.org}`)).asks ?? []).find(a => a.node === name && a.status === 'open')
  const item = slug => rig.api('GET', `/api/orgs/${rig.org}/work-items/${slug}`).then(r => r.item ?? {})
  const batch = (name, body) => tryApi('POST', `/api/orgs/${rig.org}/nodes/${name}/batch`, body)
  const settled = async (name, n) => {
    await rig.waitTurns(name, n)
    await rig.waitFor(() => rig.turns(name).every(t => t.ended_at), { what: `${name}'s turns to end`, timeout: 30000 })
  }

  // ---------------------------------------------------------------- uma: ask, amend, answer
  const made = await rig.tool('uma', 'orgtree_work', { action: 'create', kind: 'code', title: 'Button colour',
    objective: 'The button needs a colour.\n\nThe user decides.' })
  const slug = made.json?.slug ?? rig.one(`SELECT slug FROM ot.work_items WHERE title = 'Button colour'`)?.slug
  rig.scenario(scenario(slug))
  await rig.userMail('uma', 'PROOF-ASK: ask the user about the colour.')
  await settled('uma', 1)
  const asked = log('uma', 'tool_result').find(l => l.tool === 'orgtree_ask')
  const r1 = row('uma')
  p.check('uma: orgtree_ask inside a turn puts the card on the user\'s desk', asked?.ok && !asked.is_error && r1?.status === 'open' && r1.rev === 1,
    { tool: asked?.text, row: r1 && { status: r1.status, rev: r1.rev } })
  const c1 = await rig.waitFor(() => card('uma'), { what: 'uma\'s card in the tree', timeout: 15000 }).catch(() => null)
  p.check('uma: the open card shows her question with its header and options', c1?.tabs?.[0]?.question === Q_COLOUR
    && c1.tabs[0].header === 'Colour' && c1.tabs[0].options?.map(o => o.label).join(',') === 'Red,Blue', c1 && { kind: c1.kind, tabs: c1.tabs })
  const it1 = await item(slug)
  p.check('uma: the card is attached to her docket item, which shows it', r1?.work_items?.includes(slug)
    && JSON.stringify(it1.questions ?? []).includes(Q_COLOUR), { work_items: r1?.work_items, questions: it1.questions, sources: it1.attention_sources })
  const del = await rig.tool('boss', 'orgtree_work', { action: 'delete', slug })
  p.check('uma: the item cannot be deleted while the question is open', !del.ok && /open question/i.test(del.text ?? ''), del.text?.slice(0, 200))

  await rig.userMail('uma', 'PROOF-AMEND: add a question.')
  await settled('uma', 2)
  const r2 = row('uma')
  p.check('uma: asking again amends the same card (one open request): a new tab joins, the same text replaces its tab',
    rows('uma').filter(r => r.status === 'open').length === 1 && r2.uid === r1.uid && r2.rev === 2
      && qs(r2).join('|') === `${Q_COLOUR}|${Q_SHIP}`
      && (r2.body.parts?.questions ?? [])[0]?.options?.map(o => o.label).join(',') === 'Red,Green', { uid: [r1.uid, r2.uid], rev: r2.rev, qs: qs(r2) })
  const prompt2 = log('uma', 'turn').at(-1)?.prompt ?? ''
  p.check('uma: her turn while the card is open says it is still OPEN with the user', /still OPEN with the user/.test(prompt2), prompt2.slice(0, 400))

  const stale = await batch('uma', { revs: { ask: 1 }, answers: ['Green', 'Yes'] })
  p.check('uma: a submit against the card as it was before the amend is refused', !stale.ok && stale.status === 409 && row('uma').status === 'open', stale)
  const holes = await batch('uma', { revs: { ask: 2 }, answers: ['Green'] })
  p.check('uma: a submit with a missing answer slot is refused', !holes.ok && holes.status === 400 && row('uma').status === 'open', holes)
  const before = rig.turns('uma').length
  const ans = await batch('uma', { revs: { ask: 2 }, answers: ['Green', 'Yes'] })
  await settled('uma', before + 1)
  const r3 = row('uma')
  const mail = userMail('uma').at(-1)
  const prompt3 = log('uma', 'turn').at(-1)?.prompt ?? ''
  p.check('uma: the answer closes the card as answered', ans.ok && r3.status === 'answered' && r3.answer_mail === mail?.uid, { ans, status: r3.status })
  p.check('uma: the answer reaches her as mail from the user, with each question and its answer', mail?.state === 'delivered'
    && mail.body.includes(`Q: ${Q_COLOUR}\nA: Green`) && mail.body.includes(`Q: ${Q_SHIP}\nA: Yes`), mail)
  p.check('uma: the answer wakes her with each answer, and that turn no longer says the card is open', /should the button be\?\n→ Green/.test(prompt3)
    && /Ship it today\?\n→ Yes/.test(prompt3) && !/still OPEN with the user/.test(prompt3), prompt3.slice(prompt3.indexOf('[MAIL'), prompt3.indexOf('[MAIL') + 400))
  const it2 = await item(slug)
  p.check('uma: the docket item lets go of the answered question', !JSON.stringify(it2.questions ?? []).includes(Q_COLOUR)
    && !(it2.attention_sources ?? []).includes('question'), { questions: it2.questions, sources: it2.attention_sources })

  // ---------------------------------------------------------------- ned: routed to his superior
  const boss = id('boss')
  const fromNed = () => rig.sql(`SELECT kind, body, ev FROM ot.mail WHERE recipient_agent_id = ${boss} AND sender = 'ned' ORDER BY id`)
  const smoke = rig.one(`SELECT slug FROM ot.work_items WHERE title = 'Rig smoke item'`)?.slug
  const hidden = await rig.tool('ned', 'orgtree_ask', { question: 'May I touch the smoke item?', work_item: smoke })
  p.check('ned: a link to an item he may not read is refused, and nothing is sent', !hidden.ok && fromNed().length === 0, hidden.text?.slice(0, 200))
  const routed = await rig.tool('ned', 'orgtree_ask', { question: 'May I refactor the parser?', options: ['Yes', 'No'] })
  const nm = fromNed().at(-1)
  p.check('ned: without a user audience his question goes to his superior as mail, and no card opens', routed.ok
    && /superior boss/.test(routed.text ?? '') && nm?.kind === 'question' && /refactor the parser/.test(nm.body)
    && nm.ev?.variant === 'ask.routed' && rows('ned').length === 0, { text: routed.text, mail: nm && { kind: nm.kind, variant: nm.ev?.variant } })

  // ---------------------------------------------------------------- wes: caps, same-text amend, withdraw
  const w = n => ({ question: `Wes question ${n}?`, options: ['A', 'B'] })
  const five = await rig.tool('wes', 'orgtree_ask', { questions: [1, 2, 3, 4, 5].map(w) })
  p.check('wes: more than 4 questions in one call are refused, and no card opens', !five.ok && /at most 4/.test(five.text ?? '') && rows('wes').length === 0, five.text)
  const four = await rig.tool('wes', 'orgtree_ask', { questions: [1, 2, 3, 4].map(w) })
  const eight = await rig.tool('wes', 'orgtree_ask', { questions: [5, 6, 7, 8].map(w) })
  const nine = await rig.tool('wes', 'orgtree_ask', w(9))
  const rw = row('wes')
  p.check('wes: the card grows to 8 questions and a 9th is refused, leaving the card as it was', four.ok && eight.ok && !nine.ok
    && /cap 8/.test(nine.text ?? '') && qs(rw).length === 8 && rw.rev === 2, { nine: nine.text, n: qs(rw).length, rev: rw.rev })
  const again = await rig.tool('wes', 'orgtree_ask', { question: 'Wes question 1?', options: ['Left', 'Right'] })
  const rw2 = row('wes')
  p.check('wes: asking the same question text again amends its tab in place', again.ok && qs(rw2).length === 8 && rw2.rev === 3
    && rw2.body.parts.questions[0].options.map(o => o.label).join(',') === 'Left,Right', { n: qs(rw2).length, rev: rw2.rev })
  const wd = await rig.tool('wes', 'orgtree_withdraw_ask', {})
  p.check('wes: he withdraws his card', wd.ok && /withdrawn/.test(wd.text ?? '') && row('wes').status === 'withdrawn', { text: wd.text, status: row('wes').status })
  const late = await batch('wes', { revs: { ask: 3 }, answers: Array(8).fill('A') })
  const late2 = await tryApi('POST', `/api/orgs/${rig.org}/asks/${rw.uid}/answer`, { selected: Array(8).fill('A'), rev: 3 })
  p.check('wes: answering the withdrawn card is refused on both routes, and no answer mail is sent', !late.ok && !late2.ok
    && /already withdrawn/.test(late2.detail) && userMail('wes').length === 0, { batch: late, answer: late2 })
  const wd2 = await rig.tool('wes', 'orgtree_withdraw_ask', {})
  p.check('wes: withdrawing again says there is nothing open', wd2.ok && /no open request/i.test(wd2.text ?? ''), wd2.text)

  // ---------------------------------------------------------------- dot: the user closes the card
  await rig.tool('dot', 'orgtree_ask', { question: 'Should I rename the module?', options: ['Yes', 'No'] })
  const closed = await batch('dot', { revs: { ask: 1 }, answers: [null] })
  await settled('dot', 1)
  const rd = row('dot')
  const dm = userMail('dot').at(-1)
  p.check('dot: closing the card (every tab skipped) marks it dismissed, not answered', closed.ok && rd.status === 'dismissed', { status: rd.status, reason: rd.reason })
  p.check('dot: she is told the question went unanswered', dm?.state === 'delivered' && /skipped/i.test(dm.body), dm?.body)
  await rig.tool('dot', 'orgtree_ask', { question: 'Should I delete the old tests?', options: ['Yes', 'No'] })
  const rd2 = row('dot')
  const dis = await tryApi('POST', `/api/orgs/${rig.org}/asks/${rd2.uid}/answer`, { dismiss: true, rev: 1 })
  await settled('dot', 2)
  p.check('dot: the dismiss route closes the card as dismissed and tells her', dis.ok && row('dot').status === 'dismissed'
    && /dismissed your request/.test(userMail('dot').at(-1)?.body ?? ''), { dis, status: row('dot').status })

  // ---------------------------------------------------------------- ray: retired with a card open
  const ri = await rig.tool('ray', 'orgtree_work', { action: 'create', kind: 'code', title: 'Ray item', objective: 'Ray needs a decision.\n\nNothing else.' })
  const raySlug = ri.json?.slug ?? rig.one(`SELECT slug FROM ot.work_items WHERE title = 'Ray item'`)?.slug
  await rig.tool('ray', 'orgtree_ask', { question: 'Which database should I use?', options: ['A', 'B'], work_item: raySlug })
  const rayAsk = row('ray')
  const before2 = JSON.stringify((await item(raySlug)).questions ?? [])
  await rig.op({ op: 'retire', node: 'ray' })
  const rr = rig.one(`SELECT status, reason FROM ot.asks WHERE uid = '${rayAsk.uid}'`)
  const after2 = await rig.waitFor(async () => { const q = JSON.stringify((await item(raySlug)).questions ?? []); return q.includes('Which database') ? null : q },
    { what: 'ray\'s item to let go', timeout: 15000 }).catch(() => 'still attached')
  p.check('ray: retiring him closes his open card as moot (not withdrawn: he did not act) and his item lets go of it',
    /Which database/.test(before2) && rr?.status === 'moot'
    && after2 !== 'still attached' && !(await card('ray')), { row: rr, before: before2.slice(0, 120), after: after2 })

  // ---------------------------------------------------------------- cal: cheap compact keeps the card
  await rig.userMail('cal', 'Hello cal.')
  await settled('cal', 1)
  await rig.tool('cal', 'orgtree_ask', { question: 'Keep the legacy flag?', options: ['Keep', 'Drop'] })
  const cc = await rig.tool('boss', 'orgtree_cheap_compact', { node: 'cal' })
  p.check('cal: his card stays open through a cheap compact', cc.ok && row('cal').status === 'open', { cc: cc.text?.slice(0, 160), status: row('cal').status })
  await rig.userMail('cal', 'Carry on, please.')
  await settled('cal', 2)
  const cp = log('cal', 'turn').at(-1)?.prompt ?? ''
  const handoff = cp.slice(cp.indexOf('fresh session'))
  p.check('cal: his fresh session is told he still has the question open, and not to drop it because he does not remember it',
    /fresh session/.test(cp) && /Keep the legacy flag\?/.test(handoff) && /do not withdraw/i.test(handoff), cp.slice(0, 1500))

  // ---------------------------------------------------------------- hal: halted when the answer lands
  await rig.tool('hal', 'orgtree_ask', { question: 'Pause the migration?', options: ['Yes', 'No'] })
  await rig.api('POST', `/api/orgs/${rig.org}/nodes/hal/halt`)
  const ha = await batch('hal', { revs: { ask: 1 }, answers: ['Yes'] })
  await new Promise(r => setTimeout(r, 5000))
  const hm = userMail('hal').at(-1)
  p.check('hal: answered while halted, the answer waits and no turn runs', ha.ok && rig.turns('hal').length === 0 && hm?.state === 'pending',
    { turns: rig.turns('hal').length, mail: hm?.state })
  await rig.api('POST', `/api/orgs/${rig.org}/nodes/hal/unhalt`)
  await settled('hal', 1)
  p.check('hal: unhalted, the answer wakes him', (log('hal', 'turn').at(-1)?.prompt ?? '').includes('Pause the migration?')
    && userMail('hal').at(-1)?.state === 'delivered', userMail('hal').at(-1)?.state)

  // ---------------------------------------------------------------- mia: answered mid-turn
  await rig.userMail('mia', 'PROOF-WAIT: ask, then keep working.')
  const ma = await rig.waitFor(() => row('mia')?.status === 'open' ? row('mia') : null, { what: 'mia to ask', timeout: 30000 })
  const mres = await batch('mia', { revs: { ask: ma.rev }, answers: ['Yes'] })
  await settled('mia', 1)
  await new Promise(r => setTimeout(r, 3000))
  const hook = log('mia', 'hook_mail').map(l => l.text).join('\n')
  p.check('mia: the answer reaches her mid-turn, and no extra turn runs for it', mres.ok && /Proceed with plan B\?\n→ Yes/.test(hook)
    && log('mia', 'poll_mail').at(-1)?.delivered === true && rig.turns('mia').length === 1,
  { hook: hook.slice(0, 300), turns: rig.turns('mia').length })

  // ---------------------------------------------------------------- lex: a malformed call
  const tab = () => (row('lex')?.body?.parts?.questions ?? []).map(q => ({ q: q.question, o: (q.options ?? []).map(o => o.label + (o.description ? `=${o.description}` : '')) }))
  const leak = await rig.tool('lex', 'orgtree_ask', {
    question: 'Which region should host the cluster?</question>\n<parameter name="options">[{"label": "EU", "description": "Frankfurt"}, {"label": "US"}]' })
  p.check('lex: options leaked into the question text are recovered into a clean question with its options', leak.ok
    && JSON.stringify(tab()) === JSON.stringify([{ q: 'Which region should host the cluster?', o: ['EU=Frankfurt', 'US'] }]), { text: leak.text?.slice(0, 120), tabs: tab() })
  const broken = await rig.tool('lex', 'orgtree_ask', { question: 'Deploy now?</question>\n<parameter name="options">[{"label": "Yes", ' })
  const markup = await rig.tool('lex', 'orgtree_ask', { question: 'Merge it?</question><parameter name="multi">true' })
  p.check('lex: a leaked fragment that cannot be recovered is refused, and the card is unchanged', !broken.ok && !markup.ok
    && /leaked tool-call fragment/.test(broken.text ?? '') && /leaked tool-call fragment/.test(markup.text ?? '') && tab().length === 1,
  { broken: broken.text?.slice(0, 160), markup: markup.text?.slice(0, 160), tabs: tab().length })
  const long = await rig.tool('lex', 'orgtree_ask', { question: 'Pick a name?', options: [{ label: 'L'.repeat(80), description: 'D'.repeat(400) }, { label: '   ' }, 'Short'] })
  const named = row('lex')?.body?.parts?.questions?.find(q => q.question === 'Pick a name?')?.options ?? []
  p.check('lex: an option label is clipped to 60 characters and a description to 300, and a blank option is dropped', long.ok
    && named.length === 2 && named[0].label.length === 60 && named[0].description.length === 300 && named[1].label === 'Short',
  named.map(o => [o.label.length, o.description?.length ?? 0]))

  // ---------------------------------------------------------------- olga: the older answer route
  const old = (uid, body) => tryApi('POST', `/api/orgs/${rig.org}/asks/${uid}/answer`, body)
  await rig.tool('olga', 'orgtree_ask', { question: 'Which colours should the logo use?', options: ['Red', 'Green', 'Blue'], multi: true })
  const o1 = await old(row('olga').uid, { selected: ['Red', 'Blue'], rev: 1 })
  await settled('olga', 1)
  p.check('olga: on a one-question card every pick counts (a multi-select keeps both)', o1.ok
    && /A: Red, Blue/.test(userMail('olga').at(-1)?.body ?? ''), { o1, body: userMail('olga').at(-1)?.body })
  await rig.tool('olga', 'orgtree_ask', { question: 'What should the release be called?' })
  const o2 = row('olga')
  const empty = await old(o2.uid, { selected: [], rev: 1 })
  const typed = await old(o2.uid, { text: 'Aurora', rev: 1 })
  await settled('olga', 2)
  p.check('olga: an answer with no pick and no text is refused; a typed answer is taken', !empty.ok && empty.status === 400
    && typed.ok && /A: Aurora/.test(userMail('olga').at(-1)?.body ?? ''), { empty, typed: typed.ok })
  await rig.tool('olga', 'orgtree_ask', { question: 'Ship on Monday?', options: ['Yes', 'No'] })
  await rig.tool('olga', 'orgtree_ask', { question: 'Tag the release?', options: ['Yes', 'No'] })
  const o3 = row('olga')
  const unstamped = await old(o3.uid, { selected: ['Yes', 'No'] })
  const short = await old(o3.uid, { selected: ['Yes'], rev: 2 })
  const extra = await old(o3.uid, { selected: ['Yes', 'No', 'Maybe'], rev: 2 })
  p.check('olga: an unstamped answer to an amended card is refused, and so are a missing and an extra tab answer', o3.rev === 2
    && !unstamped.ok && unstamped.status === 409 && !short.ok && short.status === 400 && !extra.ok && extra.status === 400
    && row('olga').status === 'open', { unstamped, short, extra, status: row('olga').status })
  const whole = await old(o3.uid, { selected: ['Yes', 'No'], rev: 2 })
  await settled('olga', 3)
  const ob = userMail('olga').at(-1)?.body ?? ''
  p.check('olga: a stamped answer with one answer per tab is taken', whole.ok && /Ship on Monday\?\nA: Yes/.test(ob) && /Tag the release\?\nA: No/.test(ob), ob)

  p.keep(rig, { agents, grep: /ask|question|request/i })
  return p.summary()
}
