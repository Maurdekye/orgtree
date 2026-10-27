// Proof: the bounded presentation-mention read carries what a link needs to tell an unread presentation from one
// modified since it was read, and the ticket read what a ticket link needs for its status flare
// (@item:orgtree/4-5-0-ticket-and-presentation-chips-show-full-ti; USER 2026-10-27 m43beb8089dd4, m919f12828686,
// mc1c4ab23c4bf). Real PG engine, synthetic org, no desktop window:
//   rhea presents three presentations; the user reads two of them through the route the reader posts
//   (`POST documents/viewed`), then rhea replaces one of those two. `GET documents?refs=` answers each with its
//   `at` and `viewed_at`: never read (null), modified since read (earlier than `at`), read (equal). The renderer's
//   rule (canvas/docviewed.ts) applied to the answer reads unread, modified, read.
//   rhea files two docket items and moves one; `GET work-item-references` answers each with its current status.
import { Proof } from '../proof.mjs'
import { SEED_SETTLE_TIMEOUT } from '../seed-settle.mjs'

export function setup() {
  // The rig has no sign-in helper: session0 '0' keeps turns from waiting for one in Session 0.
  return { session0: '0', fixture: { org: { name: 'Synthetic reference flares' },
    agents: [{ name: 'rhea', tier: 'sol', grant: 1 }],
    scenario: { default: { turns: [{ steps: [{ text: 'Ready.' }] }] } } } }
}

/** canvas/docviewed.ts docUnread with no local marks: what the engine's record alone says */
const state = r => (r.viewed_at === undefined ? 'no viewed_at in the answer'
  : r.viewed_at === null ? 'unread' : r.viewed_at < r.at ? 'modified' : 'read')

export default async function (rig) {
  const p = new Proof('ref-flares')
  try {
    await rig.waitFor(() => rig.sql('SELECT 1 FROM ot.turns WHERE ended_at IS NULL').length === 0,
      { what: 'seed turn settles', timeout: SEED_SETTLE_TIMEOUT })
    const org = rig.org
    const present = async args => {
      const r = await rig.tool('rhea', 'orgtree_present', args)
      if (!r.ok) throw Error(`orgtree_present: ${r.text}`)
      return r
    }
    for (const title of ['Launch plan', 'Release notes', 'Old notes']) await present({ title, body: `# ${title}\n\nSynthetic body.` })
    const listed = async () => (await rig.api('GET', `/api/orgs/${org}/documents?node=rhea`)).documents
    const byTitle = Object.fromEntries((await listed()).map(d => [d.title, d]))
    const slugs = ['Launch plan', 'Release notes', 'Old notes'].map(title => byTitle[title]?.id)
    p.check('three presentations, each with its slug', slugs.every(Boolean), slugs)
    const [plan, notes, old] = slugs
    // the user reads two of them, at the version each has now
    await rig.api('POST', `/api/orgs/${org}/documents/viewed`, { marks: [
      { id: notes, at: byTitle['Release notes'].at }, { id: old, at: byTitle['Old notes'].at }] })
    // ...and rhea replaces one of those afterwards
    await new Promise(resolve => setTimeout(resolve, 50))
    await present({ title: 'Release notes', body: '# Release notes\n\nVersion two.', replaces: notes })
    const answer = await rig.api('GET', `/api/orgs/${org}/documents?refs=${[plan, notes, old].join(',')}`)
    p.file('refs.json', answer)
    const refs = Object.fromEntries((answer.refs ?? []).map(r => [r.id, r]))
    p.check('the read answers every reference asked, by its slug', [plan, notes, old].every(id => refs[id]), answer)
    p.check('every answer carries the presentation\'s at and viewed_at',
      [plan, notes, old].every(id => typeof refs[id]?.at === 'string' && 'viewed_at' in (refs[id] ?? {})), answer.refs)
    p.check('the read times are the ones the Presented list shows', (await listed()).every(d => !refs[d.id]
      || (refs[d.id].at === d.at && refs[d.id].viewed_at === d.viewed_at)), { refs: answer.refs, listed: await listed() })
    const seen = [plan, notes, old].map(id => refs[id] ? state(refs[id]) : 'missing')
    p.check('the answer tells unread, modified since read and read apart', JSON.stringify(seen) === JSON.stringify(['unread', 'modified', 'read']), seen)
    // tickets: the reference read answers the current status the flare colours
    for (const title of ['Build the docs site', 'Fix the login redirect']) {
      const r = await rig.tool('rhea', 'orgtree_work', { action: 'create', title, kind: 'code',
        objective: `Problem: synthetic ${title}. Solution: none; a fixture for the flare proof.` })
      if (!r.ok) throw Error(`orgtree_work create: ${r.text}`)
    }
    const items = Object.fromEntries(rig.sql("SELECT slug, title FROM ot.work_items WHERE title IN ('Build the docs site', 'Fix the login redirect')")
      .map(r => [r.title, r.slug]))
    const [docs, login] = [items['Build the docs site'], items['Fix the login redirect']]
    const moved = await rig.tool('rhea', 'orgtree_work', { action: 'update', slug: login, status: 'in_progress' })
    if (!moved.ok) throw Error(`orgtree_work update: ${moved.text}`)
    const tickets = await rig.api('GET', `/api/orgs/${org}/work-item-references?names=${docs},${login}`)
    p.file('tickets.json', tickets)
    const status = Object.fromEntries((tickets.references ?? []).map(r => [r.slug, [r.title, r.status]]))
    p.check('the ticket read answers each title with its current status', JSON.stringify(status)
      === JSON.stringify({ [docs]: ['Build the docs site', 'open'], [login]: ['Fix the login redirect', 'in_progress'] }), status)
    return p.summary()
  } catch (error) {
    p.check('ref-flares proof completed without an exception', false, String(error?.stack ?? error))
    return p.summary()
  }
}
