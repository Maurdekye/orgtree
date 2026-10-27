// Proof: docket permission and stale-revision rules, called as agents through
// the rig tool route (the dispatcher the CLIs reach), with the DB checked after.
//   The fixture item rig-smoke-item: created by boss, owned by alice.
//   carol (alice's peer) and bob (alice's report) may neither read nor update it.
//   alice's update with a stale expected_rev is refused and changes nothing;
//   with the fresh rev it lands. boss's update naming owner=alice keeps alice.
//   A participant added by alice may read and update.
//   Proposals A-F (USER 2026-10-27): keep/append need no revision and skip
//   entries already listed; a stale rev lands unless a field it replaces
//   changed; a wrong owner name keeps the holder; reopen on open work is
//   ignored; no-op participants/assign succeed without writing.
// Run: node tools/rig/rig.mjs run tools/rig/proofs/docket-rules.mjs

import { Proof } from '../proof.mjs'

export default async function (rig) {
  const p = new Proof('docket-rules')
  const slug = 'rig-smoke-item'
  const row = () => rig.one(`SELECT w.rev, w.status, w.owner->>'node' AS owner, w.participants, w.done_so_far, w.working_on_next
                               FROM ot.work_items w JOIN ot.orgs o ON o.id = w.org_id WHERE o.slug = '${rig.org}' AND w.slug = '${slug}'`)
  const start = row()
  p.check('fixture: the item exists, owned by alice', start?.owner === 'alice', start)

  // ---------------------------------------------------------------- permissions
  const carolRead = await rig.tool('carol', 'orgtree_work', { action: 'get', slug })
  p.check('carol (peer) cannot read it', !carolRead.ok && /not readable to you/.test(carolRead.text), carolRead.text)
  const carolUpd = await rig.tool('carol', 'orgtree_work', { action: 'update', slug, done_so_far: ['carol was here'], working_on_next: [] })
  p.check('carol (peer) cannot update it', !carolUpd.ok && /only the owner, the creator, their superiors, participants, the reviewer or the user may update/.test(carolUpd.text), carolUpd.text)
  const bobUpd = await rig.tool('bob', 'orgtree_work', { action: 'update', slug, done_so_far: ['bob was here'], working_on_next: [] })
  p.check('bob (the owner\'s report) cannot update it', !bobUpd.ok && /may update/.test(bobUpd.text), bobUpd.text)
  p.check('refused updates changed nothing', row().rev === start.rev, { before: start.rev, after: row().rev })
  const typo = await rig.tool('alice', 'orgtree_work', { action: 'get', slug: 'rig-smoke-iten' })
  p.check('G: a misspelt slug names the nearest item the caller may read', !typo.ok && /did you mean rig-smoke-item\?/.test(typo.text), typo.text)
  const typoHidden = await rig.tool('carol', 'orgtree_work', { action: 'get', slug: 'rig-smoke-iten' })
  p.check('G: the hint never names an item the caller may not read',
    !typoHidden.ok && /no docket item named/.test(typoHidden.text) && !/did you mean/.test(typoHidden.text), typoHidden.text)
  p.check('G: the not-readable refusal says whom to ask', /ask the agent who gave you the slug/.test(carolRead.text), carolRead.text)

  // ---------------------------------------------------------------- stale revision
  const read = await rig.tool('alice', 'orgtree_work', { action: 'get', slug })
  const rev = read.json?.rev
  p.check('alice reads her item', read.ok && Number.isInteger(rev), { rev, ok: read.ok })
  const bossUpd = await rig.tool('boss', 'orgtree_work', { action: 'update', slug, owner: 'alice', status: 'in_progress',
    done_so_far: ['boss: scoped the work'], working_on_next: ['alice: build it'] })
  p.check('boss (the creator, her superior) updates it, naming owner=alice', bossUpd.ok, bossUpd.text)
  const afterBoss = row()
  p.check('boss\'s update moved the rev and kept alice as owner', afterBoss.rev === rev + 1 && afterBoss.owner === 'alice', afterBoss)
  const stale = await rig.tool('alice', 'orgtree_work', { action: 'update', slug, expected_rev: rev,
    done_so_far: ['alice: stale write'], working_on_next: ['alice: should not land'] })
  p.check('alice\'s update with the stale rev is refused, naming both revs',
    !stale.ok && new RegExp(`moved to rev ${rev + 1} since you read it \\(you sent ${rev}\\)`).test(stale.text), stale.text)
  const afterStale = row()
  p.check('the refused stale write changed nothing', afterStale.rev === afterBoss.rev && JSON.stringify(afterStale.done_so_far) === JSON.stringify(afterBoss.done_so_far), afterStale)
  const fresh = await rig.tool('alice', 'orgtree_work', { action: 'update', slug, expected_rev: rev + 1,
    done_so_far: ['boss: scoped the work', 'alice: built it'], working_on_next: ['alice: hand it in'] })
  p.check('alice\'s update with the fresh rev lands', fresh.ok && row().rev === rev + 2, { ok: fresh.ok, rev: row().rev, text: fresh.text.slice(0, 200) })
  // Fewer failed docket calls (USER 2026-10-27 m3f52496b06f6, proposals A-F)
  const keep = await rig.tool('alice', 'orgtree_work', { action: 'update', slug, keep_done: true, next_append: ['alice: tidy up'] })
  p.check('A: keep/append without expected_rev lands on the list as stored', keep.ok && row().working_on_next.includes('alice: tidy up'), keep.text)
  const again = await rig.tool('alice', 'orgtree_work', { action: 'update', slug, keep_done: true, next_append: ['alice: tidy up'] })
  p.check('A: a retried append adds nothing twice and says so',
    again.ok && row().working_on_next.filter(x => x === 'alice: tidy up').length === 1 && /already in working_on_next/.test(again.text), again.text)
  const readB = (await rig.tool('alice', 'orgtree_work', { action: 'get', slug })).json?.rev
  const note = await rig.tool('boss', 'orgtree_work', { action: 'evidence', slug, kind: 'note', note: 'boss: a synthetic note' })
  p.check('B setup: boss adds evidence, moving the rev', note.ok && row().rev === readB + 1, note.text)
  const over = await rig.tool('alice', 'orgtree_work', { action: 'update', slug, expected_rev: readB, keep_done: true, working_on_next: ['alice: after the note'] })
  p.check('B: a stale rev lands when only unguarded fields changed since, and says so',
    over.ok && /applied over rev/.test(over.text) && row().working_on_next[0] === 'alice: after the note', over.text)
  const readClash = row().rev
  const plan = await rig.tool('boss', 'orgtree_work', { action: 'update', slug, owner: 'alice', keep_done: true, working_on_next: ['boss: changed the plan'] })
  const clash = await rig.tool('alice', 'orgtree_work', { action: 'update', slug, expected_rev: readClash, keep_done: true, working_on_next: ['alice: the old plan'] })
  p.check('B: a stale rev still refuses when a field it replaces changed, naming the field',
    plan.ok && !clash.ok && /its next changed since then/.test(clash.text) && row().working_on_next[0] === 'boss: changed the plan', clash.text)
  const named = await rig.tool('boss', 'orgtree_work', { action: 'update', slug, owner: 'bob', keep_done: true, next_append: ['boss: named the wrong owner'] })
  p.check('C: naming someone other than the holder keeps the holder, applies the rest and says so',
    named.ok && row().owner === 'alice' && /owner kept: alice/.test(named.text) && row().working_on_next.includes('boss: named the wrong owner'), named.text)
  const reopen = await rig.tool('alice', 'orgtree_work', { action: 'update', slug, reopen: true, keep_done: true, next_append: ['alice: reopen ignored'] })
  p.check('E: reopen on open work is ignored with a note and the rest applies',
    reopen.ok && /reopen was ignored/.test(reopen.text) && row().working_on_next.includes('alice: reopen ignored'), reopen.text)

  // ---------------------------------------------------------------- participants
  const add = await rig.tool('alice', 'orgtree_work', { action: 'participants', slug, add: ['carol'] })
  p.check('alice adds carol as a participant', add.ok, add.text)
  const revF = row().rev
  const addAgain = await rig.tool('alice', 'orgtree_work', { action: 'participants', slug, add: ['carol'] })
  p.check('F: adding a participant already on the item succeeds without writing', addAgain.ok && addAgain.json?.unchanged === true && row().rev === revF, addAgain.text)
  const assignSame = await rig.tool('boss', 'orgtree_work', { action: 'assign', slug, owner: 'alice' })
  p.check('F: assigning the item to its current owner succeeds without writing', assignSame.ok && assignSame.json?.unchanged === true && row().rev === revF, assignSame.text)
  const carolRead2 = await rig.tool('carol', 'orgtree_work', { action: 'get', slug })
  p.check('carol (now a participant) can read it', carolRead2.ok && carolRead2.json?.slug === slug, carolRead2.ok ? 'ok' : carolRead2.text)
  const r2 = row()
  const carolUpd2 = await rig.tool('carol', 'orgtree_work', { action: 'update', slug, owner: 'alice', expected_rev: r2.rev,
    keep_done: true, next_append: ['carol: reviewed'] })
  p.check('carol (participant) may update state, leaving alice the owner', carolUpd2.ok && row().owner === 'alice', { ok: carolUpd2.ok, text: carolUpd2.text.slice(0, 200), owner: row().owner })
  const history = rig.sql(`SELECT e.op, e.by, e.at FROM ot.work_events e JOIN ot.work_items w ON w.id = e.work_id
                            WHERE w.slug = '${slug}' ORDER BY e.id`)
  p.file('history.json', history)
  p.check('history records the landed updates', history.length >= 4, history.map(h => `${h.op}:${h.by?.node ?? JSON.stringify(h.by)}`))
  return p.summary()
}
