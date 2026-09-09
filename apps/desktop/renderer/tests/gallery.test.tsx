// gallery.test.tsx — the presented-documents gallery.
//
// Redesigned 2026-09-03 on the user's instruction to make it resemble the
// MAIL UI: "a list of entries on the left with their titles, submitted agent,
// and submission time, and a the scrollable document viewer on the right.
// only show non-dismissed documents from agents that are currently hired, and
// allow the dismissal of them from the viewer directly."
//
// The currently-hired filter is the DEFAULT, not the whole rule: asked
// directly (every card in the live org is from a retired agent, so the strict
// list opens empty), the user chose "default hired + 'show retired'". Both
// halves of that are pinned below — a filter that silently swallowed the
// archive and a toggle that failed to reveal it are the two ways this feature
// disappoints, and neither is visible without looking.
//
// Run:  cd frontend && node tests/run.mjs gallery

import { flush, inAct, mountView, realClock, useFakeClock } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { AgentGalleryView, DocGalleryModal } from '../src/canvas/gallery'
import { activeDocCount } from '../src/canvas/shared'
import type { DocCountNode } from '../src/canvas/shared'
import type { DocRow } from '../src/api'

interface Call { method: string; url: string }

/** stubs BOTH endpoints this panel touches: the list, and the per-document
 *  body its right-hand pane fetches on select. Records every call so a test
 *  can assert what was NOT requested (an evicted row must not fetch). */
function mockDocs(rows: DocRow[], bodies: Record<string, string> = {}): Call[] {
  const calls: Call[] = [];
  (globalThis as unknown as { fetch: typeof fetch }).fetch =
    ((url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      const path = String(url)
      calls.push({ method, url: path })
      const headers = new Headers()
      const ok = (body: unknown) => Promise.resolve(
        { ok: true, status: 200, headers, json: () => Promise.resolve(body) })
      if (method === 'DELETE') return ok({ ok: true, node: 'agent1' })
      const m = path.match(/\/documents\/([^/?]+)$/)
      if (m) {
        const id = m[1]!
        const r = rows.find((x) => x.id === id)
        if (!r || bodies[id] == null) {
          return Promise.resolve({ ok: false, status: 404, headers,
            statusText: 'Not Found',
            json: () => Promise.resolve({ detail: `no document ${id}` }) })
        }
        return ok({ id, node: r.node, title: r.title, at: r.at, body: bodies[id] })
      }
      return ok({ documents: rows })
    }) as typeof fetch
  return calls
}

const row = (o: Partial<DocRow>): DocRow => ({
  id: 'd1', node: 'agent1', title: 'a plan', at: '2026-09-03T00:00:00.000Z',
  evicted: false, node_state: 'live', ...o,
})

function uiTest(name: string, body: (mount: (v: React.ReactElement)
  => Promise<{ el: HTMLElement }>) => Promise<void>) {
  test(name, async (t: TestContext) => {
    useFakeClock()
    let open: { el: HTMLElement; unmount: () => Promise<void> } | null = null
    t.after(async () => { try { await open?.unmount() } finally { realClock() } })
    await body(async (v) => {
      const view = await mountView(v, (host) => host)
      open = view
      return { el: view.el }
    })
  })
}

const noop = () => {}
const rows = (el: HTMLElement) => [...el.querySelectorAll('.mailrow')]
const pane = (el: HTMLElement) => el.querySelector('.mailer-read')
const showRetired = (el: HTMLElement) =>
  el.querySelector('.gallery-showretired input') as HTMLInputElement

const gallery = (extra?: Partial<{
  close: () => void
  onFocusAgent: (id: string) => void
  onReply: (node: string, text: string) => void
}>) => (
  <DocGalleryModal slug="org1" toast={noop} close={extra?.close ?? noop}
    onFocusAgent={extra?.onFocusAgent} onReply={extra?.onReply} />
)

uiTest('§1 an empty org says so rather than rendering a blank panel', async (mount) => {
  mockDocs([])
  const { el } = await mount(gallery())
  await flush()
  assert.equal(rows(el).length, 0)
  assert.match(el.textContent ?? '', /no cards have been presented yet/)
})

uiTest('§2 a row carries the three things the user asked for: title, agent, time',
  async (mount) => {
    mockDocs([row({ id: 'd1', title: 'the plan', node: 'planner' })])
    const { el } = await mount(gallery())
    await flush()
    assert.equal(rows(el).length, 1)
    // the mail row's own shape: strong line + time on .l1, detail on .l2
    assert.equal(rows(el)[0].querySelector('.l1 .mfrom')?.textContent, 'the plan',
      'the TITLE is the row headline, where a mail puts its sender')
    assert.ok((rows(el)[0].querySelector('.l1 .mtime')?.textContent ?? '').length,
      'the submission time rides the row, as mail does')
    assert.match(rows(el)[0].querySelector('.l2')?.textContent ?? '', /planner/,
      'the submitting agent is named on the row')
  })

uiTest('§3 THE DEFAULT IS CURRENTLY-HIRED ONLY — a retired agent\'s card is not '
  + 'in the default list, and the empty state says where it went', async (mount) => {
  mockDocs([
    row({ id: 'dret', title: 'from a retired agent', node: 'oldie', node_state: 'archived' }),
    row({ id: 'ddel', title: 'from a deleted agent', node: 'ghost', node_state: 'deleted' }),
  ])
  const { el } = await mount(gallery())
  await flush()
  assert.equal(rows(el).length, 0, 'archived and deleted presenters are filtered out')
  // …and the user is TOLD, rather than left thinking the gallery is broken
  assert.match(el.textContent ?? '', /no cards from currently-hired agents/)
  assert.match(el.textContent ?? '', /2 from retired ones/)
})

uiTest('§4 the checkbox adds retired cards to the SAME list, sorted below the '
  + 'active ones — one list, not a second view', async (mount) => {
  // the retired card is NEWER, so a plain newest-first sort would put it on
  // top: this fixture only passes if the grouping actually happens
  mockDocs([
    row({ id: 'dret', title: 'from a retired agent', node: 'oldie',
      node_state: 'archived', at: '2026-09-03T09:00:00.000Z' }),
    row({ id: 'dlive', title: 'from a live agent',
      at: '2026-09-03T08:00:00.000Z' }),
  ])
  const { el } = await mount(gallery())
  await flush()
  assert.equal(rows(el).length, 1, 'default shows only the live agent\'s card')
  await inAct(() => showRetired(el).click())
  await flush()
  const shown = rows(el)
  assert.equal(shown.length, 2, 'the checkbox brings the retired card into the list')
  assert.match(shown[0]!.textContent ?? '', /from a live agent/,
    'the ACTIVE agent\'s card sorts first even though it is older')
  assert.match(shown[1]!.textContent ?? '', /from a retired agent/,
    'and the retired one sits below it')
  // the way back, so the checkbox is not a one-way door
  await inAct(() => showRetired(el).click())
  await flush()
  assert.equal(rows(el).length, 1)
})

uiTest('§4b active and retired rows are told apart by CLASS, not by a badge '
  + '(the user asked for the "retired" card to go)', async (mount) => {
  // ⚠ neither title nor agent id may contain "retired", or the
  // doesNotMatch below would pass/fail on the fixture's own words
  mockDocs([
    row({ id: 'dlive', title: 'a current plan' }),
    row({ id: 'dret', title: 'an older plan', node: 'oldie',
      node_state: 'archived' }),
  ])
  const { el } = await mount(gallery())
  await flush()
  await inAct(() => showRetired(el).click())
  await flush()
  const [live, past] = rows(el)
  assert.ok(live!.classList.contains('active'),
    'an active agent\'s row carries the unread-mail accent class')
  assert.ok(past!.classList.contains('past'), 'a retired one is marked secondary')
  assert.equal(past!.querySelector('.badge'), null,
    'NO "retired" badge in the row — greying is the whole signal')
  assert.doesNotMatch(past!.textContent ?? '', /retired/i,
    'and the word does not appear in the row either')
  // …but it stays reachable on hover, so grey is never the only explanation
  assert.match(past!.getAttribute('title') ?? '', /retired/)
})

uiTest('§4c each entry shows its agent\'s model chip', async (mount) => {
  mockDocs([
    row({ id: 'dlive', title: 'live one', tier: 'opus' }),
    row({ id: 'dgone', title: 'no node left', node: 'ghost',
      node_state: 'deleted', tier: null }),
  ])
  const { el } = await mount(gallery())
  await flush()
  await inAct(() => showRetired(el).click())
  await flush()
  const chip = rows(el)[0]!.querySelector('.tier')
  assert.ok(chip, 'the row carries the model chip')
  assert.ok(chip.classList.contains('t-opus'), 'coloured by tier, like everywhere else')
  assert.equal(chip.textContent, 'O', 'and wearing the shared tier letter')
  assert.equal(rows(el)[1]!.querySelector('.tier'), null,
    'a deleted node has no tier to show — no empty chip')
})

uiTest('§5 the viewer is a PANE, not a takeover: selecting a row renders the body '
  + 'beside the list and leaves the gallery open', async (mount) => {
  mockDocs([row({ id: 'd1', title: 'the plan' })], { d1: '# heading\n\nthe body text' })
  let closed = false
  const { el } = await mount(gallery({ close: () => { closed = true } }))
  await flush()
  assert.match(pane(el)?.textContent ?? '', /select a document to read it/,
    'nothing is selected on open — the pane invites a click, as mail does')
  await inAct(() => { (rows(el)[0] as HTMLElement).click() })
  await flush()
  assert.match(pane(el)?.textContent ?? '', /the body text/,
    'the fetched markdown renders in the right-hand pane')
  assert.ok(el.querySelector('.mailer-body'), 'it is the mail reading pane markup')
  assert.equal(rows(el).length, 1, 'the list is still there beside it')
  assert.equal(closed, false, 'reading a document must not close the gallery')
})

uiTest('§6 dismiss lives in the viewer and actually deletes that document',
  async (mount) => {
    const calls = mockDocs([row({ id: 'd1', title: 'the plan' })], { d1: 'body' })
    const { el } = await mount(gallery())
    await flush()
    assert.equal(el.querySelector('.mailer-head button'), null,
      'no dismiss control before a document is open')
    await inAct(() => { (rows(el)[0] as HTMLElement).click() })
    await flush()
    const btn = el.querySelector('.mailer-head button.chip-x') as HTMLElement
    assert.ok(btn, 'the viewer carries the dismiss control (user request)')
    assert.match(btn.getAttribute('title') ?? '', /dismiss/, 'button title indicates dismiss')
    await inAct(() => btn.click())
    await flush()
    const del = calls.filter((c) => c.method === 'DELETE')
    assert.equal(del.length, 1, 'exactly one delete')
    assert.match(del[0]!.url, /\/documents\/d1$/, 'and it names the open document')
  })

uiTest('§6b the METADATA row comes first and the title second, each on its own '
  + 'line, with dismiss right-aligned in the title row', async (mount) => {
    mockDocs([row({ id: 'd1', title: 'the plan' })], { d1: 'body' })
    const { el } = await mount(gallery())
    await flush()
    await inAct(() => { (rows(el)[0] as HTMLElement).click() })
    await flush()
    const head = el.querySelector('.mailer-head')!
    const titleRow = head.querySelector('.doc-pane-title-row')
    const metaRow = head.querySelector('.doc-pane-meta-row')
    assert.ok(titleRow, 'title row exists')
    assert.ok(metaRow, 'meta row exists')
    // ORDER is the contract (user, 2026-09-04) — assert on document position,
    // not on which one a querySelector happens to find first
    assert.ok(metaRow!.compareDocumentPosition(titleRow!) & Node.DOCUMENT_POSITION_FOLLOWING,
      'the metadata row is FIRST and the title row SECOND')
    assert.equal(titleRow.querySelector('b')?.textContent, 'the plan')
    assert.ok(titleRow.querySelector('button.chip-x'), 'dismiss button sits on title row')
    assert.equal(metaRow.querySelector('b'), null, 'metadata row has no title')
  })

uiTest('§6c the full view does NOT repeat "this agent has been retired" — the '
  + 'separation from the active entries already says it — but DELETED, which '
  + 'that separation does not distinguish, is still named', async (mount) => {
    mockDocs([
      row({ id: 'dret', title: 'from a retired one', node: 'oldie', node_state: 'archived' }),
      row({ id: 'ddel', title: 'from a deleted one', node: 'goner', node_state: 'deleted' }),
    ], { dret: 'body', ddel: 'body' })
    const { el } = await mount(gallery())
    await flush()
    await inAct(() => { showRetired(el).click() })
    await flush()
    const open = async (title: string) => {
      const r = rows(el).find((x) => x.textContent?.includes(title)) as HTMLElement
      assert.ok(r, `found the row for ${title}`)
      await inAct(() => { r.click() })
      await flush()
      return el.querySelector('.mailer-head .doc-pane-meta-row')!.textContent ?? ''
    }
    assert.doesNotMatch(await open('from a retired one'), /retired/i,
      'no redundant retirement wording in the open document')
    assert.match(await open('from a deleted one'), /deleted/i,
      'a DELETED agent is still named — the layout does not imply which state it is')
  })

uiTest('§7 evicted cards stay out of the menu while available cards remain', async (mount) => {
  const calls = mockDocs([
    row({ id: 'dgone', title: 'gone but logged', evicted: true }),
    row({ id: 'doldgone', title: 'retired and gone', evicted: true, node_state: 'archived' }),
    row({ id: 'dread', title: 'available document' }),
  ])
  const { el } = await mount(gallery())
  await flush()
  assert.equal(rows(el).length, 1)
  assert.match(rows(el)[0]!.textContent ?? '', /available document/)
  await inAct(() => showRetired(el).click())
  await flush()
  assert.equal(rows(el).length, 1, 'retired toggle cannot reveal evicted content')
  assert.equal(calls.filter((c) => /\/documents\/d(?:old)?gone$/.test(c.url)).length, 0)
})

uiTest('§8 CONTROL: the same fixture with the presenter still hired DOES list — '
  + 'so §3 is a filter firing, not an empty render', async (mount) => {
  mockDocs([row({ id: 'dret', title: 'from a retired agent', node: 'oldie' })])
  const { el } = await mount(gallery())
  await flush()
  assert.equal(rows(el).length, 1,
    'flipping only node_state to live makes the row appear — §3 saw the filter')
})

uiTest('§10 clicking the agent name link closes the viewer and focuses that agent',
  async (mount) => {
    let focused: string | null = null
    let closed = false
    mockDocs([row({ id: 'd1', title: 'the plan', node: 'agent-42' })], { d1: 'body' })
    const { el } = await mount(gallery({
      close: () => { closed = true },
      onFocusAgent: (id) => {
        // order check: close before focus
        assert.ok(closed, 'viewer is closed before focusing agent')
        focused = id
      },
    }))
    await flush()
    await inAct(() => { (rows(el)[0] as HTMLElement).click() })
    await flush()
    const link = el.querySelector('.mailer-head .doc-pane-meta-row button.cc-name') as HTMLElement
    assert.ok(link, 'agent name link is rendered')
    assert.equal(link.textContent, 'agent-42')
    await inAct(() => link.click())
    assert.ok(closed, 'modal was closed')
    assert.equal(focused, 'agent-42', 'focused owning agent')
  })

uiTest('§10b agent name link still functions for a retired agent',
  async (mount) => {
    let focused: string | null = null
    let closed = false
    mockDocs([row({ id: 'dret', title: 'old doc', node: 'ret-agent', node_state: 'archived' })], { dret: 'old body' })
    const { el } = await mount(gallery({
      close: () => { closed = true },
      onFocusAgent: (id) => { focused = id },
    }))
    await flush()
    // reveal retired
    await inAct(() => showRetired(el).click())
    await flush()
    await inAct(() => { (rows(el)[0] as HTMLElement).click() })
    await flush()
    const link = el.querySelector('.mailer-head .doc-pane-meta-row button.cc-name') as HTMLElement
    assert.ok(link, 'retired agent link is rendered')
    assert.equal(link.textContent, 'ret-agent')
    await inAct(() => link.click())
    assert.ok(closed, 'modal closed')
    assert.equal(focused, 'ret-agent', 'focuses retired agent')
  })

uiTest('§11 reply box is present below document for live owner and sends message',
  async (mount) => {
    let replied: { node: string; text: string; target: unknown } | null = null
    mockDocs([row({ id: 'd1', title: 'the plan', node: 'agent-live', node_state: 'live' })], { d1: 'body markdown' })
    const { el } = await mount(gallery({
      onReply: (node, text, target) => { replied = { node, text, target } },
    }))
    await flush()
    await inAct(() => { (rows(el)[0] as HTMLElement).click() })
    await flush()
    const replyBox = el.querySelector('.mailer-read .mail-reply')
    assert.ok(replyBox, 'mail-reply box is present below the document')
    const textarea = replyBox.querySelector('textarea') as HTMLTextAreaElement
    assert.ok(textarea, 'textarea is rendered')
    assert.match(textarea.placeholder, /reply to agent-live/, 'placeholder names target agent')
    const sendBtn = replyBox.querySelector('.mail-reply-send') as HTMLButtonElement
    assert.ok(sendBtn.disabled, 'reply button disabled while draft is empty')
    await inAct(() => {
      const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
      nativeSetter?.call(textarea, 'Looks good, proceed!')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await flush()
    assert.ok(!sendBtn.disabled, 'reply button enabled once text is entered')
    await inAct(() => sendBtn.click())
    await flush()
    assert.deepEqual(replied, { node: 'agent-live', text: 'Looks good, proceed!', target: {kind:'document',org:'org1',id:'d1'} })
  })

uiTest('§12 reply box is ABSENT when the owning agent is retired or document is evicted',
  async (mount) => {
    mockDocs([
      row({ id: 'dret', title: 'from retired', node: 'ret-agent', node_state: 'archived' }),
      row({ id: 'devict', title: 'evicted doc', node: 'live-agent', node_state: 'live', evicted: true }),
    ], { dret: 'retired body' })
    const { el } = await mount(gallery())
    await flush()
    await inAct(() => showRetired(el).click())
    await flush()

    // 1. Retired agent document
    const retRow = rows(el).find((r) => r.textContent?.includes('from retired')) as HTMLElement
    assert.ok(retRow, 'found retired row')
    await inAct(() => retRow.click())
    await flush()
    assert.equal(el.querySelector('.mailer-read .mail-reply'), null,
      'no reply box for retired agent')

    assert.equal(rows(el).some((r) => r.textContent?.includes('evicted doc')), false,
      'evicted document is not a menu entry')
  })

// ── the toolbar button's corner count ────────────────────────────────────
// Counted off the TREE rather than the gallery's own fetch, so the button
// costs no extra poll. That makes its agreement with the list a real claim
// worth pinning: two sources, one number.

test('§9 the badge counts documents from CURRENTLY HIRED agents only', () => {
  const node = (o: Partial<DocCountNode> & { state: string }): DocCountNode => ({
    documents: null, children: [], ...o,
  })
  assert.equal(activeDocCount(null), 0, 'no tree yet reads zero, not NaN')
  assert.equal(activeDocCount([]), 0)
  assert.equal(activeDocCount([
    node({ state: 'live', documents: [{ id: 'a' }, { id: 'b' }] }),
  ]), 2)
  // …a retired agent's cards are NOT in the badge, matching the default list
  assert.equal(activeDocCount([
    node({ state: 'archived', documents: [{ id: 'a' }, { id: 'b' }] }),
  ]), 0, 'a retired agent contributes nothing — the badge matches the list')
  assert.equal(activeDocCount([
    node({ state: 'unrecoverable', documents: [{ id: 'a' }] }),
  ]), 0)
  // …and it counts the WHOLE tree, not just the roots
  assert.equal(activeDocCount([
    node({ state: 'live', documents: [{ id: 'a' }],
      children: [
        node({ state: 'live', documents: [{ id: 'b' }, { id: 'c' }] }),
        node({ state: 'archived', documents: [{ id: 'd' }] }),
      ] }),
  ]), 3, 'a deep live report is counted; a deep retired one is not')
})

// -------------------------------------- §13-§15: references inside a document
//
// A presented plan is prose somebody wrote, so it can name an item, an agent
// or the mail it answers. The body is rendered markdown, so this is the DOM
// pass (refmd), and what these three checks are really about is WHO answers:
// the panel for a document it lists, the shell for everything else, and
// nobody at all when no route was supplied.

const refsFor = (opened: unknown[]) => ({
  world: {
    org: 'org1',
    agents: new Map([['agent1', 'agent1']]),
    handles: new Set<'item' | 'agent' | 'doc' | 'mail'>(
      ['item', 'agent', 'doc', 'mail']),
  },
  onOpen: (r: { ref: { kind: string; id: string } }) =>
    opened.push(`${r.ref.kind}:${r.ref.id}`),
})

uiTest('§13 a reference in a document body is a control, and one the shell '
  + 'owns is handed up', async (mount) => {
    mockDocs([row({ id: 'd1' })],
      { d1: 'as agreed in @item:org1/the-plan and @agent:org1/agent1' })
    const opened: unknown[] = []
    const { el } = await mount(
      <DocGalleryModal slug="org1" toast={noop} close={noop}
        refs={refsFor(opened)} />)
    await flush()
    await inAct(() => (rows(el)[0] as HTMLElement).click())
    await flush()
    const chips = [...(pane(el)?.querySelectorAll('[data-ref-token]') ?? [])]
    assert.equal(chips.length, 2, 'both references were decided')
    await inAct(() => (chips[0] as HTMLElement).click())
    await flush()
    assert.deepEqual(opened, ['item:the-plan'])
  })

uiTest('§14 a document referencing a document THIS PANEL LISTS opens it here',
  async (mount) => {
    // ⚠ this panel IS the document reader. Handing a document off to the
    // shell's reader would close the list the reader is part of, to show the
    // same kind of thing somewhere else.
    // ⚠ THE TARGET BELONGS TO A RETIRED AGENT, so it is NOT in the filtered
    // list this panel is showing. A panel that asked what it is SHOWING
    // rather than what it HOLDS would fall through to the shell here, and
    // with two live documents that mistake is invisible.
    mockDocs([row({ id: 'd1', title: 'the plan' }),
      row({ id: 'd2', title: 'the appendix', node: 'agent2',
        node_state: 'archived' })],
    { d1: 'the numbers are in @doc:org1/d2', d2: 'appendix body' })
    const opened: unknown[] = []
    const { el } = await mount(
      <DocGalleryModal slug="org1" toast={noop} close={noop}
        refs={refsFor(opened)} />)
    await flush()
    await inAct(() => (rows(el)[0] as HTMLElement).click())
    await flush()
    await inAct(() => (pane(el)!
      .querySelector('[data-ref-token]') as HTMLElement).click())
    await flush()
    assert.match(pane(el)?.textContent ?? '', /appendix body/,
      'the referenced document opened in this panel')
    assert.deepEqual(opened, [],
      'and the shell was not asked to open it somewhere else')
    // and the row was REVEALED: selecting a row the filter hides would look
    // like the reference did nothing to the list
    assert.ok(showRetired(el).checked, 'the retired group was turned on')
    assert.ok(rows(el).some((r) => (r.textContent ?? '').includes('appendix')),
      'the referenced document is now a visible row')
  })

uiTest('§15 CONTROL — a document this panel does NOT list falls through to '
  + 'the shell, which is the one that has the exact fetch',
async (mount) => {
  mockDocs([row({ id: 'd1' })], { d1: 'see @doc:org1/d9 for the rest' })
  const opened: unknown[] = []
  const { el } = await mount(
    <DocGalleryModal slug="org1" toast={noop} close={noop}
      refs={refsFor(opened)} />)
  await flush()
  await inAct(() => (rows(el)[0] as HTMLElement).click())
  await flush()
  await inAct(() => (pane(el)!
    .querySelector('[data-ref-token]') as HTMLElement).click())
  await flush()
  assert.deepEqual(opened, ['doc:d9'],
    'a document this panel does not hold is the shell\'s to answer for')
})

uiTest('§15b CONTROL — with no refs at all a document body is plain prose',
  async (mount) => {
    mockDocs([row({ id: 'd1' })], { d1: 'as agreed in @item:org1/the-plan' })
    const { el } = await mount(gallery())
    await flush()
    await inAct(() => (rows(el)[0] as HTMLElement).click())
    await flush()
    assert.equal(pane(el)?.querySelector('[data-ref-token]'), null,
      'a panel with nowhere to send anybody draws no controls')
    assert.match(pane(el)?.textContent ?? '', /@item:org1\/the-plan/,
      'and the token is still readable as written')
  })

const agentGallery = (nid: string, extra?: Partial<{
  node: any
  onFocusAgent: (id: string) => void
  onReply: (node: string, text: string) => void
  refs: any
  onChanged: () => void
}>) => (
  <AgentGalleryView slug="org1" nid={nid} toast={noop}
    node={extra?.node}
    onFocusAgent={extra?.onFocusAgent}
    onReply={extra?.onReply}
    refs={extra?.refs}
    onChanged={extra?.onChanged} />
)

uiTest('AgentGalleryView: lists only presentations for the specified agent in two-column mailer', async (mount) => {
  mockDocs([
    row({ id: 'd1', node: 'agent-1', title: 'agent1 report' }),
    row({ id: 'd2', node: 'agent-2', title: 'agent2 report' }),
  ])
  const { el } = await mount(agentGallery('agent-1'))
  await flush()
  assert.equal(rows(el).length, 1)
  assert.match(rows(el)[0]!.textContent ?? '', /agent1 report/)
  assert.doesNotMatch(el.textContent ?? '', /agent2 report/)
  assert.ok(el.querySelector('.mailer'))
  assert.ok(el.querySelector('.mailer-list'))
  assert.ok(el.querySelector('.mailer-read'))
  assert.match(pane(el)?.textContent ?? '', /select a document to read it/)
})

uiTest('AgentGalleryView: selecting a row renders the document in DocPane', async (mount) => {
  mockDocs([row({ id: 'd1', node: 'agent-1', title: 'agent1 report' })], { d1: '# Agent Notes\n\nSome findings here' })
  const { el } = await mount(agentGallery('agent-1'))
  await flush()
  await inAct(() => { (rows(el)[0] as HTMLElement).click() })
  await flush()
  assert.ok(rows(el)[0]!.classList.contains('on'))
  assert.match(pane(el)?.textContent ?? '', /Some findings here/)
  assert.equal(pane(el)?.querySelector('.doc-pane-title-row b')?.textContent, 'agent1 report')
  assert.ok(pane(el)?.querySelector('.chip-x'), 'dismiss button is rendered')
})

uiTest('AgentGalleryView: dismissing a document removes it from the list', async (mount) => {
  const calls = mockDocs([row({ id: 'd1', node: 'agent-1', title: 'agent1 report' })], { d1: 'body' })
  let changed = false
  const { el } = await mount(agentGallery('agent-1', { onChanged: () => { changed = true } }))
  await flush()
  await inAct(() => { (rows(el)[0] as HTMLElement).click() })
  await flush()
  const btn = pane(el)?.querySelector('.doc-pane-title-row .chip-x') as HTMLElement
  assert.ok(btn, 'dismiss button found')
  await inAct(() => btn.click())
  await flush()
  const del = calls.filter((c) => c.method === 'DELETE')
  assert.equal(del.length, 1)
  assert.match(del[0]!.url, /\/documents\/d1$/)
  assert.equal(rows(el).length, 0)
  assert.match(el.textContent ?? '', /No presented documents/)
  assert.ok(changed, 'onChanged was called')
})

uiTest('AgentGalleryView: HTML mockup renders as native link with MockupBadge', async (mount) => {
  mockDocs([row({ id: 'd-html', node: 'agent-1', title: 'HTML mockup', format: 'html' })])
  const { el } = await mount(agentGallery('agent-1'))
  await flush()
  const link = el.querySelector('a.doc-mockup') as HTMLAnchorElement
  assert.ok(link, 'rendered as link')
  assert.match(link.getAttribute('href') ?? '', /mockup/)
  assert.ok(link.querySelector('.mockup-format'), 'renders MockupBadge')
})

uiTest('AgentGalleryView: renders empty state when agent has no presentations', async (mount) => {
  mockDocs([])
  const { el } = await mount(agentGallery('agent-1'))
  await flush()
  assert.match(el.textContent ?? '', /No presented documents/)
  assert.equal(rows(el).length, 0)
})

uiTest('AgentGalleryView: authoritative empty list does not resurrect stale node documents', async (mount) => {
  mockDocs([])
  const { el } = await mount(agentGallery('agent-1', {
    node: { id: 'agent-1', state: 'live', tier: 'opus', documents: [{ id: 'stale', title: 'stale node copy' }] },
  }))
  await flush()
  assert.equal(rows(el).length, 0)
  assert.match(el.textContent ?? '', /No presented documents/)
})

uiTest('AgentGalleryView: authoritative evicted result stays empty over node fallback', async (mount) => {
  mockDocs([row({ id: 'evicted', node: 'agent-1', evicted: true })])
  const { el } = await mount(agentGallery('agent-1', {
    node: { id: 'agent-1', state: 'live', tier: 'opus', documents: [{ id: 'evicted', title: 'old copy' }] },
  }))
  await flush()
  assert.equal(rows(el).length, 0)
  assert.match(el.textContent ?? '', /No presented documents/)
})
