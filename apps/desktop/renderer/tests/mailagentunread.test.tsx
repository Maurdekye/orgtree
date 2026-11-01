// mailagentunread.test.tsx — USER 2026-11-01 07:46:04Z mc13db4358667 ("only uswr mail gets the highlight. can agent mail get it too?
// it has read / unread states") and 07:46:49Z m49a258f12e57 ("also urgent unread mail gets a highlight with the urgent color").
//   §1 a link to an agent's unread message (the node box's lookup says `unread`) wears the unread flare; a read one's does not;
//   §2 an unread urgent message, user or agent, wears the urgent flare (mail-urgent); a read urgent one wears nothing;
//   §3 the tree's pending-mail counts changing reads an unread agent link again (the agent read it, it clears); unchanged counts read nothing;
//   §4 the stylesheet gives the urgent flare the urgent colour, after the unread rule.
// Each test uses its own org slug: answers and read state are kept per org.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { flush, inAct, mountView } from './harness'
import { MailRefChip } from '../src/canvas/mailchip'
import * as mailrefs from '../src/canvas/mailrefs'
import { resetLocalReads } from '../src/mailread'

declare const __SRC_DIR__: string

const tick = async () => { for (let i = 0; i < 8; i++) await flush() }
const noop = () => {}
const flaring = (el: Element | null) => !!el && el.classList.contains('ref-flare') && el.classList.contains('mail-new')
const urgent = (el: Element | null) => !!el && el.classList.contains('mail-urgent')

/** The engine's one-message lookup for every box: `unread` from the set, `urgent` from the other set. */
function engine(t: TestContext, unread: string[], urgentIds: string[] = []) {
  const s = { unread: new Set(unread), urgent: new Set(urgentIds), reads: [] as string[] }
  const original = globalThis.fetch
  globalThis.fetch = (async (raw: RequestInfo | URL) => {
    const url = new URL(String(raw), 'http://local')
    const hit = /\/api\/orgs\/([^/]+)\/mail\/(user|org|node)\/([^/?]+)/.exec(url.pathname)
    if (!hit) return new Response('{}', { status: 404 })
    const [, , box, id] = hit
    const key = decodeURIComponent(id!)
    s.reads.push(box + '/' + key)
    const mail = { id: key, from: 'writer', at: '2026-11-01T08:00:00Z', kind: 'message', body: 'Please review the attached plan today',
      ...(box !== 'org' ? { unread: s.unread.has(key) } : {}), ...(s.urgent.has(key) ? { urgent: true, urgent_reason: 'now' } : {}) }
    return new Response(JSON.stringify({ found: true, mail }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }) as typeof fetch
  t.after(() => { globalThis.fetch = original; resetLocalReads() })
  return s
}

test('§1 an agent message that is unread links with the unread flare; a read one does not', async t => {
  const org = 'ma-flare'
  engine(t, ['n1'])
  const v = await mountView(<div>
    <p id="unread"><MailRefChip mail={{ org, id: 'n1', box: 'node', node: 'reader' }} onOpen={noop} /></p>
    <p id="read"><MailRefChip mail={{ org, id: 'n2', box: 'node', node: 'reader' }} onOpen={noop} /></p>
  </div>, el => el)
  t.after(() => v.unmount())
  await inAct(tick)
  const chip = (sel: string) => v.el.querySelector<HTMLElement>(sel + ' .ref-chip.ref-mail')
  assert.ok(flaring(chip('#unread')), 'an agent-addressed unread message flares like the user mail does')
  assert.equal(chip('#unread')!.getAttribute('title')!.split(' · ')[0], 'Unread')
  assert.ok(!chip('#read')!.classList.contains('ref-flare'), 'a read agent message: no flare')
})

test('§2 an unread urgent message wears the urgent flare, user and agent mail alike; read urgent mail wears none', async t => {
  const org = 'ma-urgent'
  engine(t, ['u1', 'n1'], ['u1', 'n1', 'n3', 'u2'])
  const v = await mountView(<div>
    <p id="user"><MailRefChip mail={{ org, id: 'u1', box: 'user' }} onOpen={noop} /></p>
    <p id="node"><MailRefChip mail={{ org, id: 'n1', box: 'node', node: 'reader' }} onOpen={noop} /></p>
    <p id="plain"><MailRefChip mail={{ org, id: 'n4', box: 'node', node: 'reader' }} onOpen={noop} /></p>
    <p id="readurgent"><MailRefChip mail={{ org, id: 'n3', box: 'node', node: 'reader' }} onOpen={noop} /></p>
    <p id="readurgentuser"><MailRefChip mail={{ org, id: 'u2', box: 'user' }} onOpen={noop} /></p>
  </div>, el => el)
  t.after(() => v.unmount())
  await inAct(tick)
  const chip = (sel: string) => v.el.querySelector<HTMLElement>(sel + ' .ref-chip.ref-mail')
  assert.ok(flaring(chip('#user')) && urgent(chip('#user')), 'unread urgent user mail')
  assert.ok(flaring(chip('#node')) && urgent(chip('#node')), 'unread urgent agent mail')
  assert.match(chip('#node')!.getAttribute('title') ?? '', /^Urgent · Unread/)
  assert.ok(!flaring(chip('#plain')) && !urgent(chip('#plain')), 'ordinary read mail: no edge')
  assert.ok(!chip('#readurgent')!.classList.contains('ref-flare') && !urgent(chip('#readurgent')), 'read urgent agent mail: no edge')
  assert.ok(!chip('#readurgentuser')!.classList.contains('ref-flare') && !urgent(chip('#readurgentuser')), 'read urgent user mail: no edge')
})

test('§3 the tree pending-mail counts changing reads an unread agent link again; unchanged counts read nothing', async t => {
  const org = 'ma-tree', s = engine(t, ['n5'])
  const v = await mountView(<div>
    <p><MailRefChip mail={{ org, id: 'n5', box: 'node', node: 'reader' }} onOpen={noop} /></p>
    <p><MailRefChip mail={{ org, id: 'u9', box: 'user' }} onOpen={noop} /></p>
  </div>, el => el)
  t.after(() => v.unmount())
  await inAct(tick)
  const flares = () => [...v.el.querySelectorAll<HTMLElement>('.ref-chip.ref-mail')].map(c => flaring(c))
  assert.deepEqual(flares(), [true, false])
  const roots = (pending: number) => [{ id: 'reader', mail_pending: pending, children: [{ id: 'kid', mail_pending: 0, children: [] }] }]
  await inAct(async () => { mailrefs.mailTreeChanged(org, roots(1)); await tick() })       // the first tree: the link is read again once, still unread
  const asked = s.reads.length
  await inAct(async () => { mailrefs.mailTreeChanged(org, roots(1)); await tick() })
  assert.equal(s.reads.length, asked, 'same counts: nothing is read again')
  s.unread.delete('n5')                             // the agent read it
  await inAct(async () => { mailrefs.mailTreeChanged(org, roots(0)); await tick() })
  assert.deepEqual(flares(), [false, false], 'the counts moved: the agent link is read again and clears')
  assert.deepEqual(s.reads.slice(asked), ['node/n5'], 'only the unread agent link was read again, not the user one')
})

test('§4 the stylesheet gives the urgent flare the urgent colour, after the unread rule', () => {
  const css = readFileSync(path.join(__SRC_DIR__, 'styles.css'), 'utf8')
  const unread = css.search(/\.ref-flare:is\(\.doc-new, \.mail-new\)\s*\{/)
  const hot = css.search(/\.ref-flare\.mail-new\.mail-urgent\s*\{\s*--ref-flare-color:\s*#ff4500;\s*\}/)
  assert.ok(unread > 0 && hot > unread, 'urgent unread edge in #ff4500, the colour of the urgent mail row')
})
