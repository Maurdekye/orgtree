// mailchip.test.tsx — @mail: references wear the chip every other reference wears, named by their message's first words
// (USER 2026-10-31 mdffa16729677 "they do, but they're unstyled, and just look like normal links", m33189c8d6214 "style
// them just like other types (with a mail icon), and make their names the first 20 or so characters truncated with an
// ellipsis"), and every button that opened a mail is that chip (m4ad918885ce9 "also replace this open button with that new
// mail link", m53e1fd94c038 "this is in agent transcripts after orgtree_message tool calls", mf1a79901405e "but also all
// other places too").
//
// Run:  cd apps/desktop/renderer && node tests/run.mjs mailchip

import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import { flush, inAct, mountView } from './harness'
import { MailRefChip } from '../src/canvas/mailchip'
import { MAIL_LABEL_CHARS, mailRefLabel } from '../src/canvas/mailrefs'
import { REF_MARK_PATHS } from '../src/canvas/refmarks'
import { RefChip, resolveRef, type RefWorld } from '../src/canvas/reflinks'
import { RefMdBody } from '../src/canvas/refmd'
import { refNames } from '../src/canvas/refnames'
import { ToolChip } from '../src/canvas/desk'

declare const __SRC_DIR__: string

const ref = (id: string, box: 'user' | 'org' | 'node' = 'user', node?: string) => ({ kind: 'mail' as const, org: 'org', box, node, id })
const world = (answer?: { outcome: 'ready' | 'absent' | 'pending'; label?: string }): RefWorld => ({ org: 'org', ...(answer ? { refName: () => answer } : {}) })
let seq = 0
/** a fetch that answers every mail lookup with `mail`, or with "not found" when it is null */
function mailBackend(t: test.TestContext, mail: Record<string, unknown> | null) {
  const saved = globalThis.fetch, requests: string[] = []
  globalThis.fetch = (async input => {
    const url = new URL(String(input), 'http://test'); requests.push(url.pathname + url.search)
    return new Response(JSON.stringify(mail ? { found: true, mail } : { found: false, mail: null }), { status: 200 })
  }) as typeof fetch
  t.after(() => { globalThis.fetch = saved })
  return requests
}

test('§1 a message\'s link name is its first 20 characters, Markdown and whitespace removed, with an ellipsis when cut', () => {
  assert.equal(MAIL_LABEL_CHARS, 20)
  assert.equal(mailRefLabel('Hello world, this is a long message'), 'Hello world, this is…')
  assert.equal(mailRefLabel('A short one'), 'A short one', 'no ellipsis for a text that fits')
  assert.equal(mailRefLabel('x'.repeat(20)), 'x'.repeat(20), 'exactly 20 fits')
  assert.equal(mailRefLabel('x'.repeat(21)), 'x'.repeat(20) + '…')
  assert.equal(mailRefLabel('**Bold** and _it_ and `code`'), 'Bold and it and code', 'emphasis and code marks go')
  assert.equal(mailRefLabel('# Heading\n\n- first item\n- second'), 'Heading first item s…', 'heading and list markers go, newlines become one space')
  assert.equal(mailRefLabel('> quoted\r\n   reply   text'), 'quoted reply text')
  assert.equal(mailRefLabel('see [the docs](https://example.com/x) now'), 'see the docs now', 'a link keeps its text')
  assert.equal(mailRefLabel('snake_case_name ok'), 'snake_case_name ok', 'underscores inside a word stay')
  assert.equal(mailRefLabel('@item:org/some-slug is done please'), '@item:org/some-slug…', 'a mention token is kept whole, and a space at the cut is not left before the ellipsis')
  assert.equal(mailRefLabel('😀'.repeat(25)), '😀'.repeat(20) + '…', 'cut on characters, never through a surrogate pair')
  assert.equal(mailRefLabel('   \n\t  '), null, 'no text, no name')
  assert.equal(mailRefLabel(undefined), null)
})

test('§2 a mail link is named by its message, a message that is not there is unavailable, and a pending read keeps the generic name', () => {
  const named = resolveRef(ref('m1'), world({ outcome: 'ready', label: 'Hello world, this is…' }))
  assert.equal(named.outcome, 'ready'); assert.equal(named.label, 'Hello world, this is…')
  const generic = resolveRef(ref('m1'), world({ outcome: 'pending' }))
  assert.equal(generic.outcome, 'ready', 'a read still in flight leaves the link live'); assert.equal(generic.label, "mail in the user's inbox")
  const none = resolveRef(ref('m1'), world())
  assert.equal(none.outcome, 'ready'); assert.equal(none.label, "mail in the user's inbox", 'a surface with no name reader keeps the generic name')
  const gone = resolveRef(ref('m1'), world({ outcome: 'absent' }))
  assert.equal(gone.outcome, 'absent'); assert.match(gone.why, /no such mail in the user's inbox/)
  assert.doesNotMatch(gone.label + gone.why, /Hello/, 'nothing of any mail is shown for one that is not there')
  const empty = resolveRef(ref('m1'), world({ outcome: 'ready', label: '' }))
  assert.equal(empty.label, "mail in the user's inbox", 'a message with no text keeps the generic name')
  const foreign = resolveRef({ ...ref('m1'), org: 'elsewhere' }, world({ outcome: 'ready', label: 'secret text' }))
  assert.equal(foreign.outcome, 'foreign'); assert.doesNotMatch(foreign.label + foreign.why, /secret/, 'another org\'s mail is never named')
  let asked = 0
  const user = resolveRef(ref('@user'), { org: 'org', refName: () => { asked++; return { outcome: 'ready', label: 'x' } } })
  assert.equal(asked, 0, '@user is the user\'s inbox identity, not a message: no read'); assert.equal(user.label, 'mail in the user\'s inbox')
})

test('§3 the chip wears the kind\'s mark, the message name and the shared link classes, in React and in Markdown; @user keeps its own look', async t => {
  mailBackend(t, null)
  const r = resolveRef(ref('m1'), world({ outcome: 'ready', label: 'Hello world, this is…' }))
  const v = await mountView(<div>
    <p id="react"><RefChip r={r} onOpen={() => {}} /></p>
    <RefMdBody el="div" id="md" world={world({ outcome: 'ready', label: 'Hello world, this is…' })} onOpen={() => {}} html={{ __html: '<p>@mail:org/user/m1</p>' }} />
    <p id="user"><RefChip r={resolveRef(ref('@user'), world())} onOpen={() => {}} /></p>
    <p id="gone"><RefChip r={resolveRef(ref('m1'), world({ outcome: 'absent' }))} onOpen={() => {}} /></p>
  </div>, el => el)
  t.after(() => v.unmount())
  await inAct(async () => { await flush(3) })
  for (const id of ['react', 'md']) {
    const chip = v.el.querySelector<HTMLElement>(`#${id} .ref-chip.ref-mail`)!
    assert.ok(chip, `${id}: a mail chip`)
    for (const cls of ['ref-ready', 'ref-message']) assert.ok(chip.classList.contains(cls), `${id}: ${cls}`)
    assert.equal(chip.querySelector('.ref-mark.ref-mark-mail path')?.getAttribute('d'), REF_MARK_PATHS.mail, `${id}: the mail icon`)
    assert.equal(chip.textContent, 'Hello world, this is…', `${id}: the message's first words`)
  }
  const user = v.el.querySelector<HTMLElement>('#user .ref-chip.ref-mail')!
  assert.equal(user.textContent, '@user'); assert.ok(!user.classList.contains('ref-message')); assert.equal(user.querySelector('.ref-mark'), null, '@user is not a message link')
  const gone = v.el.querySelector<HTMLElement>('#gone .ref-chip.ref-mail')!
  assert.ok(gone.classList.contains('ref-absent')); assert.match(gone.textContent!, /@mail:org\/user\/m1/); assert.match(gone.textContent!, /unavailable/)
  assert.equal(gone.querySelector('.ref-mark'), null)
})

test('§4 the mail link reads its message through the box it opens, and shows its first words; a message not there is unavailable', async t => {
  const requests = mailBackend(t, { id: 'mail-' + ++seq, from: 'writer', at: '2026-10-21T00:00:00Z', body: '**Hello** world, this is a long mail body', kind: 'message' })
  const id = 'mc-read-' + seq
  const opened: string[] = []
  const v = await mountView(<MailRefChip mail={{ org: 'org', id, box: 'node', node: 'reader' }} onOpen={() => opened.push(id)} />, el => el)
  t.after(() => v.unmount())
  await inAct(async () => { await flush(8) })
  const chip = v.el.querySelector<HTMLElement>('.ref-chip.ref-mail')!
  assert.equal(chip.textContent, 'Hello world, this is…')
  assert.ok(requests.some(url => url.startsWith(`/api/orgs/org/mail/node/${id}`) && url.includes('node=reader')), 'one lookup, in the node\'s own box: ' + requests.join(' '))
  await inAct(async () => { chip.click(); await flush(2) })
  assert.deepEqual(opened, [id], 'a click does what the button did')

  const requests2 = mailBackend(t, null)
  const id2 = 'mc-gone-' + seq
  const w = await mountView(<MailRefChip mail={{ org: 'org', id: id2, box: 'user' }} onOpen={() => opened.push(id2)} />, el => el)
  t.after(() => w.unmount())
  await inAct(async () => { await flush(8) })
  const gone = w.el.querySelector<HTMLElement>('.ref-chip.ref-mail')!
  assert.ok(gone.classList.contains('ref-absent'), 'a message the box does not hold reads as unavailable')
  assert.equal(gone.querySelector('button'), null); assert.ok(requests2.length >= 1)
  assert.ok(refNames.names('mail'))
})

test('§5 a mail-sending tool row ends in the mail link, not an "open" button', async t => {
  const mail = { id: 'mc-tool-' + ++seq, from: 'writer', at: '2026-10-21T00:00:00Z', body: 'Please review the attached plan today', kind: 'message' }
  mailBackend(t, mail)
  const opened: unknown[] = []
  const sent = { id: mail.id, to: 'reader' }
  const v = await mountView(<ToolChip t={{ id: 'sent', name: 'orgtree_message', mail: sent }} slug="org" nid="writer" onMailLink={m => opened.push(m)} />, el => el)
  t.after(() => v.unmount())
  await inAct(async () => { await flush(8) })
  assert.equal(v.el.querySelector('.maillink'), null, 'no "open" button on the row')
  const chip = v.el.querySelector<HTMLElement>('.ref-chip.ref-mail.ref-message')!
  assert.ok(chip, 'the mail link instead'); assert.equal(chip.textContent, 'Please review the at…')
  assert.ok(chip.querySelector('.ref-mark-mail'))
  await inAct(async () => { chip.click(); await flush(2) })
  assert.deepEqual(opened, [sent], 'the click opens the same mail, with the shape the button passed')
})

test('§6b a surface that already holds the message text names the link with it until the message is read; one that is not there is unavailable', async t => {
  const saved = globalThis.fetch
  globalThis.fetch = (async () => new Response(JSON.stringify({}), { status: 200 })) as typeof fetch   // no answer: the read fails
  t.after(() => { globalThis.fetch = saved })
  const id = 'mc-hint-' + ++seq
  const v = await mountView(<MailRefChip mail={{ org: 'org', id, box: 'node', node: 'reader' }} hint={'Review the plan please now'} onOpen={() => {}} />, el => el)
  t.after(() => v.unmount())
  await inAct(async () => { await flush(6) })
  assert.equal(v.el.querySelector('.ref-chip.ref-mail')!.textContent, 'Review the plan plea…', 'the hint, cut like a read message')
  const mailBox = mailBackend(t, null)
  const gone = 'mc-hint-gone-' + ++seq
  const w = await mountView(<MailRefChip mail={{ org: 'org', id: gone, box: 'user' }} hint={'Review the plan please now'} onOpen={() => {}} />, el => el)
  t.after(() => w.unmount())
  await inAct(async () => { await flush(8) })
  assert.ok(w.el.querySelector('.ref-chip.ref-mail')!.classList.contains('ref-absent'), 'the box says there is no such mail: unavailable, whatever the hint says')
  assert.ok(mailBox.length >= 1)
})

test('§6 the stylesheet styles a message link like the other object links', () => {
  const css = readFileSync(path.join(__SRC_DIR__, 'styles.css'), 'utf8')
  const lists = css.split(/\r?\n/).filter(line => line.includes(':is(.ref-item, .ref-doc, .ref-app, .ref-panel'))
  assert.ok(lists.length >= 6, 'the object-link selector lists')
  for (const line of lists) assert.match(line, /\.ref-panel, \.ref-message\)/, 'every list of object links includes .ref-message: ' + line.trim())
})
