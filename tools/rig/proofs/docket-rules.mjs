// Proof: docket permission and stale-revision rules, called as agents through
// the rig tool route (the dispatcher the CLIs reach), with the DB checked after.
//   The fixture item rig-smoke-item: created by boss, owned by alice.
//   carol (alice's peer) and bob (alice's report) may neither read nor update it.
//   alice's update with a stale expected_rev is refused and changes nothing;
//   with the fresh rev it lands. boss's update naming owner=alice keeps alice.
//   A participant added by alice may read and update.
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
  const keep = await rig.tool('alice', 'orgtree_work', { action: 'update', slug, keep_done: true, next_append: ['alice: tidy up'] })
  p.check('keep/append without expected_rev is refused', !keep.ok && /needs expected_rev/.test(keep.text), keep.text)

  // ---------------------------------------------------------------- participants
  const add = await rig.tool('alice', 'orgtree_work', { action: 'participants', slug, add: ['carol'] })
  p.check('alice adds carol as a participant', add.ok, add.text)
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
