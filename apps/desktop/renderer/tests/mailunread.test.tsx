// mailunread.test.tsx — USER 2026-10-31 10:12:47Z m5345a1e44ad1 ("also make sure that mail has an "unread" highlight like
// presentations do"). A link to a mail the user has not read wears the same flare an unread presentation link wears (the
// accent edge, the words "Unread"), clears under the same rule (when the message is read), and is built on the same
// mechanism: the link's name read (canvas/refnames.ts) carries the flare, a store of read state re-decides the links on screen
// (docrefs.ts: the presentation's viewed marks; mailrefs.ts: the user's local reads) with no read, and a change that happened
// elsewhere reads the links again.
//   §1 an unread message's link flares, in React, in Markdown and on a mail tool row; a read message's, another box's and
//      @user's never do;
//   §2 reading the message here clears every link to it at once without another read, and it stays read once the save settles;
//      a refused save puts the flare back;
//   §3 a message read somewhere else (the inbox no longer lists it as unread) is read again and clears; one still unread is not read again;
//   §4 the hover names the state first, from the fresh read;
//   §5 the stylesheet gives the two flares one colour.
// Each test uses its own org slug: answers and read state are kept per org.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { useMemo } from 'react'
import { flush, inAct, mountView } from './harness'
import { MailRefChip } from '../src/canvas/mailchip'
import * as mailrefs from '../src/canvas/mailrefs'
import { mailLinkProps } from '../src/canvas/mailidentity'
import { objectTooltipProps, registerObjectNativeTooltipDocument } from '../src/canvas/objecttooltip'
import { ToolChip } from '../src/canvas/desk'
import { RefMdBody } from '../src/canvas/refmd'
import { useRefNames } from '../src/canvas/refnames'
import { DOC_UNREAD_WORDS } from '../src/canvas/docviewed'
import { markReadNow, resetLocalReads, settleReadsFromBox, settleReadsFromTree } from '../src/mailread'

declare const __SRC_DIR__: string

const tick = async () => { for (let i = 0; i < 8; i++) await flush() }
const noop = () => {}

/** The engine's one-message lookup, as the user box answers it: `unread` while the message is pending. A node's box carries no
 *  read state, so its rows have no `unread` at all. */
function engine(t: TestContext, unread: string[]) {
  const s = { unread: new Set(unread), reads: [] as string[] }
  const original = globalThis.fetch
  globalThis.fetch = (async (raw: RequestInfo | URL) => {
    const url = new URL(String(raw), 'http://local')
    const hit = /\/api\/orgs\/([^/]+)\/mail\/(user|org|node)\/([^/?]+)/.exec(url.pathname)
    if (!hit) return new Response('{}', { status: 404 })
    const [, , box, id] = hit
    s.reads.push(box + '/' + decodeURIComponent(id!))
    const mail = { id: decodeURIComponent(id!), from: 'writer', at: '2026-10-31T08:00:00Z', kind: 'message', body: 'Please review the attached plan today',
      ...(box === 'user' ? { unread: s.unread.has(decodeURIComponent(id!)) } : {}) }
    return new Response(JSON.stringify({ found: true, mail }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }) as typeof fetch
  t.after(() => { globalThis.fetch = original; resetLocalReads() })
  return s
}

function Md({ org, token }: { org: string; token: string }) {
  const refName = useRefNames(org)
  const world = useMemo(() => ({ org, refName }), [org, refName])
  return <RefMdBody el="div" className="md" world={world} onOpen={noop} html={{ __html: `<p>${token}</p>` }} />
}
const flaring = (el: Element | null) => !!el && el.classList.contains('ref-flare') && el.classList.contains('mail-new')

test('§1 an unread message\'s link wears the unread flare, in React, in Markdown and on a mail tool row; a read one, another box\'s and @user never do', async t => {
  const org = 'mu-flare'
  engine(t, ['u1'])
  const v = await mountView(<div>
    <p id="unread"><MailRefChip mail={{ org, id: 'u1', box: 'user' }} onOpen={noop} /></p>
    <p id="read"><MailRefChip mail={{ org, id: 'r1', box: 'user' }} onOpen={noop} /></p>
    <p id="node"><MailRefChip mail={{ org, id: 'n1', box: 'node', node: 'reader' }} onOpen={noop} /></p>
    <Md org={org} token={`@mail:${org}/user/u1`} />
    <div id="tool"><ToolChip t={{ id: 'sent', name: 'orgtree_message', mail: { id: 'u1', to: 'user_inbox' } } as never} slug={org} nid="writer" onMailLink={noop} /></div>
    <p id="user"><MailRefChip mail={{ org, id: '@user', box: 'user' }} onOpen={noop} /></p>
  </div>, el => el)
  t.after(() => v.unmount())
  await inAct(tick)
  const chip = (sel: string) => v.el.querySelector<HTMLElement>(sel + ' .ref-chip.ref-mail')
  for (const where of ['#unread', '.md', '#tool']) {
    const c = chip(where)
    assert.ok(c, `${where}: a mail chip`)
    assert.ok(flaring(c), `${where}: ref-flare mail-new, the class an unread presentation's flare has as doc-new: ${c!.className}`)
    assert.equal(c!.getAttribute('title')!.split(' · ')[0], DOC_UNREAD_WORDS.new, `${where}: its hover leads with the presentation's word`)
  }
  assert.equal(DOC_UNREAD_WORDS.new, 'Unread')
  assert.ok(!flaring(chip('#read')) && !chip('#read')!.classList.contains('ref-flare'), 'a message the user has read: no flare')
  assert.doesNotMatch(chip('#read')!.getAttribute('title') ?? '', /Unread/)
  assert.ok(!chip('#node')!.classList.contains('ref-flare'), 'a node\'s box keeps no read state: no flare')
  assert.ok(!chip('#user')!.classList.contains('ref-flare'), '@user is the inbox\'s identity, not a message')
})

test('§2 reading the message here clears every link to it at once, without another read, and it stays read; a refused save puts the flare back', async t => {
  const org = 'mu-clear', s = engine(t, ['u2', 'u3'])
  const v = await mountView(<div>
    <p id="a"><MailRefChip mail={{ org, id: 'u2', box: 'user' }} onOpen={noop} /></p>
    <Md org={org} token={`@mail:${org}/user/u2`} />
    <p id="b"><MailRefChip mail={{ org, id: 'u3', box: 'user' }} onOpen={noop} /></p>
  </div>, el => el)
  t.after(() => v.unmount())
  await inAct(tick)
  const flares = () => [...v.el.querySelectorAll<HTMLElement>('.ref-chip.ref-mail')].map(c => flaring(c))
  assert.deepEqual(flares(), [true, true, true])
  const asked = s.reads.length
  await inAct(async () => { await markReadNow(org, { id: 'u2' }, () => Promise.resolve()); await tick() })
  assert.deepEqual(flares(), [false, false, true], 'the message read here: both its links clear; the other message keeps its flare')
  assert.equal(s.reads.length, asked, 'the read mark is this window\'s own: nothing is read again')
  // the save settles (the inbox and the tree agree): the store forgets the read, and the link stays read
  await inAct(async () => { settleReadsFromBox(org, []); settleReadsFromTree(org, Date.now() + 1000); await tick() })
  assert.deepEqual(flares(), [false, false, true], 'a settled read does not bring the flare back')
  // a refused save: the mail is unread again
  let refuse: (e: Error) => void = noop
  const pending = markReadNow(org, { id: 'u3' }, () => new Promise((_ok, no) => { refuse = no })).catch(() => {})
  await inAct(tick)
  assert.deepEqual(flares(), [false, false, false], 'a read in flight shows read at once')
  await inAct(async () => { refuse(new Error('refused')); await pending; await tick() })
  assert.deepEqual(flares(), [false, false, true], 'refused: unread again')
})

test('§3 a message read somewhere else is read again and clears; one still unread is not read again', async t => {
  const org = 'mu-else', s = engine(t, ['u4', 'u5'])
  const v = await mountView(<div>
    <p><MailRefChip mail={{ org, id: 'u4', box: 'user' }} onOpen={noop} /></p>
    <p><MailRefChip mail={{ org, id: 'u5', box: 'user' }} onOpen={noop} /></p>
  </div>, el => el)
  t.after(() => v.unmount())
  await inAct(tick)
  const flares = () => [...v.el.querySelectorAll<HTMLElement>('.ref-chip.ref-mail')].map(c => flaring(c))
  assert.deepEqual(flares(), [true, true])
  const asked = s.reads.length
  await inAct(async () => { mailrefs.mailInboxRead(org, ['u4', 'u5']); await tick() })
  assert.equal(s.reads.length, asked, 'the inbox still lists both as unread: no read')
  s.unread.delete('u4')                             // read in another window, or by "mark all read"
  await inAct(async () => { mailrefs.mailInboxRead(org, ['u5']); await tick() })
  assert.deepEqual(flares(), [false, true], 'u4 is no longer listed as unread: read again, and read')
  assert.deepEqual(s.reads.slice(asked), ['user/u4'], 'only the link that the inbox stopped listing was read again')
})

test('§4 the hover names the state first, from the fresh read', async t => {
  const org = 'mu-hover'
  engine(t, ['u6'])
  const cleanup = registerObjectNativeTooltipDocument(document)
  t.after(cleanup)
  const v = await mountView(<>
    <button id="unread" {...mailLinkProps({ org, id: 'u6', box: 'user' })}>unread</button>
    <button id="read" {...mailLinkProps({ org, id: 'r6', box: 'user' })}>read</button>
    <button id="ticket" {...objectTooltipProps('ticket', 'x', org)}>ticket</button>
  </>, el => el)
  t.after(() => v.unmount())
  const hover = async (id: string) => {
    const link = v.el.querySelector<HTMLElement>('#' + id)!
    await inAct(() => void link.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }))); await inAct(tick)
    const title = link.title
    await inAct(() => void link.dispatchEvent(new MouseEvent('pointerout', { bubbles: true })))
    return title
  }
  assert.match(await hover('unread'), /^Unread · writer · .+ · u6$/)
  assert.match(await hover('read'), /^writer · .+ · r6$/)
})

test('§5 the stylesheet gives an unread message and an unread presentation the same flare colour, the chosen theme colour', () => {
  const css = readFileSync(path.join(__SRC_DIR__, 'styles.css'), 'utf8')
  // USER 2026-10-31 13:54:07Z mb8978d259c97 "the unread highlight (on presentations and mail) should follow the chosen theme color": the
  // theme's own token (--org-accent), not --accent, which a desk or tray row re-points at its provider's colour in provider-colour mode
  assert.match(css, /\.ref-flare:is\(\.doc-new, \.mail-new\)\s*\{\s*--ref-flare-color:\s*var\(--org-accent\);/, 'one rule for both, in the theme colour')
  assert.match(css, /\.ref-flare\.doc-updated\s*\{\s*--ref-flare-color:\s*color-mix\(in srgb, var\(--org-accent\) 45%, transparent\);/, 'the duller modified edge too')
})
