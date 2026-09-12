import { FakeServer, flush, inAct, installFetch, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { DeskChat } from '../src/canvas/desk'
import { ReplyPreview, ReplySourceProvider } from '../src/canvas/replypreview'
import { indexReplySources, ReplySourceContent } from '../src/canvas/replysource'
import { ObjectMenuBoundary } from '../src/canvas/contextmenu'
import { refreshConvo, resetConvos } from '../src/convo'
import { draftKey } from '../src/draftstore'
import { replyWire, storeReply } from '../src/eventReply'
import type { ReplyContext } from '../src/eventReply'
import type { CanvasNode } from '../src/canvas/shared'
import type { ChatMessage } from '../src/types'

declare const __SRC_DIR__: string
const fixture = (name: string) => JSON.parse(readFileSync(
  path.resolve(__SRC_DIR__, '../tests/fixtures/events/' + name + '.json'), 'utf8'))
const STATUS = fixture('status.report'), ASSIGNMENT = fixture('docket.assigned'), STATE = fixture('context.org_state')
const writer: CanvasNode = { id: 'writer', generation: 2, state: 'live', tier: 'haiku', children: [],
  seat: 1, grant: 0, free: 0, scope: { tools: {}, add_dirs: [] } }
const target = (eventId: string): ReplyContext => ({ org: 'org', agent: 'writer', generation: 2, eventId, quote: 'Saved excerpt' })
const desk = () => <DeskChat node={writer} map={new Map([[writer.id, writer]])} slug="org"
  op={async () => ({})} toast={() => {}} pub={false} bare />
async function refresh() { await inAct(async () => { await refreshConvo('org', 'writer'); await flush(5) }) }

test('composing, pending and sent replies retain the same structured source, metadata and attachments', async () => {
  localStorage.clear(); resetConvos()
  const reply = target('structured-source')
  storeReply(draftKey('org', 'writer', 2), reply)
  const server = new FakeServer()
  server.messages = [{ role: 'user', seq: 0, event_id: reply.eventId, ts: '2026-09-12T09:00:00Z',
    text: 'RAW MACHINE ENVELOPE', segments: [
      { kind: 'state', event: STATE.private, text: 'HIDDEN ORG STATE' },
      { kind: 'mail', rows: [
        { id: 'status-mail', from: 'reporter', kind: 'status', body: STATUS.body, at: '2026-09-12T09:00:00Z', ev: STATUS.private,
          relationship: 'subordinate', attachments: [{ path: 'outbox/report.txt', name: 'report.txt', bytes: 42 }],
          reply_to: replyWire(reply) },
        { id: 'assignment-mail', from: 'manager', kind: 'request', body: ASSIGNMENT.body, at: '2026-09-12T09:01:00Z', ev: ASSIGNMENT.private },
      ] },
    ] },
    { role: 'user', seq: 1, event_id: 'settled-reply', text: 'Settled reply',
      segments: [{ kind: 'mail', rows: [{ id: 'settled-mail', from: '@user', kind: 'message', body: 'Settled reply',
        at: '2026-09-12T09:02:00Z', reply_to: replyWire(reply) }] }] },
  ]
  server.pending_mail = [{ id: 'pending-reply', event_id: 'pending-reply-event', from: '@user', kind: 'message',
    body: 'Pending reply', at: '2026-09-12T09:03:00Z', reply_to: replyWire(reply) }]
  installFetch(server)
  const view = await mountView(desk(), el => el)
  try {
    await refresh()
    // The source itself is a reply as well. Every annotation stays one level deep.
    const previews = [...view.el.querySelectorAll('.reply-preview')]
    assert.equal(previews.length, 4)
    assert.equal(view.el.querySelectorAll('.reply-preview-composing').length, 1)
    for (const preview of previews) {
      assert.ok(preview.querySelector('[data-event-variant="status.report"]'))
      assert.ok(preview.querySelector('[data-event-variant="docket.assigned"]'))
      assert.match(preview.textContent!, /status.report·summary/)
      assert.match(preview.textContent!, /docket.assigned·objective/)
      assert.match(preview.textContent!, /docket.assigned·working_on_next\[0\]/)
      assert.match(preview.textContent!, /subordinate/)
      assert.ok(preview.querySelector('time[datetime="2026-09-12T09:00:00Z"]'))
      assert.ok(preview.querySelector('a[download="report.txt"]'))
      assert.equal(preview.querySelectorAll('.reply-preview').length, 0, 'source replies never recurse')
      assert.equal(preview.querySelectorAll('[data-reply-event], [data-mail-id], [data-native-event]').length, 0,
        'copied content cannot become a second source or scroll target')
      assert.doesNotMatch(preview.textContent!, /RAW MACHINE|HIDDEN ORG|context.org_state/)
    }
    assert.equal(view.el.querySelectorAll('[data-mail-id="status-mail"]').length, 1)
    assert.equal(view.el.querySelectorAll('[data-reply-event="structured-source"]').length, 1)
    const original = view.el.querySelector<HTMLElement>('[data-reply-event="structured-source"]')!
    let scrolled = false
    original.scrollIntoView = () => { scrolled = true }
    await inAct(() => view.el.querySelector<HTMLButtonElement>('.reply-preview-composing .reply-preview-head button')!.click())
    assert.equal(scrolled, true)
  } finally { await view.unmount(); resetConvos() }
})

test('message previews preserve markdown past the saved excerpt without including nested tools or thoughts', async () => {
  localStorage.clear(); resetConvos()
  storeReply(draftKey('org', 'writer', 2), target('answer'))
  const server = new FakeServer()
  server.messages = [{ role: 'assistant', seq: 0, event_id: 'answer',
    text: '**Result**\n\n- first item\n- second item\n\n```ts\nconst answer = 42\n```\n\n' + 'x'.repeat(4050) + 'full source tail',
    tools: [{ name: 'Read', event_id: 'call', result_event_id: 'result', result: 'NOT THE ANSWER' }],
    thinking_event_id: 'thought', thinking: 'NOT THE ANSWER EITHER', ts: '2026-09-12T08:00:00Z' }]
  installFetch(server)
  const view = await mountView(desk(), el => el)
  try {
    await refresh()
    const content = view.el.querySelector<HTMLElement>('.reply-preview-content')!
    assert.equal(content.getAttribute('role'), 'region')
    assert.equal(content.tabIndex, 0, 'bounded source is keyboard-scrollable')
    assert.equal(content.querySelectorAll('li').length, 2)
    assert.match(content.querySelector('pre code')!.textContent!, /const answer = 42/)
    assert.match(content.textContent!, /full source tail/)
    assert.doesNotMatch(content.textContent!, /NOT THE ANSWER/)
    assert.equal(content.querySelectorAll('iframe,script,[data-reply-event]').length, 0)
  } finally { await view.unmount(); resetConvos() }
})

test('a nested tool result keeps its diff and error; selecting the call or thought retains separate content', async () => {
  localStorage.clear(); resetConvos()
  storeReply(draftKey('org', 'writer', 2), target('result'))
  const server = new FakeServer()
  server.messages = [{ role: 'assistant', seq: 0, event_id: 'answer', text: 'Final message',
    thinking_event_id: 'thought', thinking: 'Consider the smaller change', think_secs: 3,
    tools: [{ name: 'Edit', event_id: 'call', result_event_id: 'result', arg: 'src/a.ts', error: 'Patch rejected',
      diff: { plus: 1, minus: 1, lines: ['@@ -1 +1 @@', '-old', '+new'], truncated: true } }] }]
  installFetch(server)
  const view = await mountView(desk(), el => el)
  try {
    await refresh()
    const preview = () => view.el.querySelector('.reply-preview-composing')!
    assert.match(preview().textContent!, /Tool result.*Edit.*Patch rejected/s)
    assert.equal(preview().querySelector('.dplus')!.textContent, '+new')
    assert.equal(preview().querySelector('.dminus')!.textContent, '-old')
    assert.match(preview().textContent!, /truncated/)
    assert.doesNotMatch(preview().textContent!, /Final message|Consider the smaller|src\/a.ts/)
    for (const [id, wanted, absent] of [
      ['call', /Tool call.*Edit.*src\/a.ts/s, /Patch rejected|Consider the smaller|Final message/],
      ['thought', /Thinking.*3s.*Consider the smaller change/s, /Patch rejected|src\/a.ts|Final message/],
    ] as const) {
      await inAct(() => view.el.querySelector(`[data-reply-event="${id}"]`)!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })))
      await inAct(() => document.querySelector<HTMLButtonElement>('[role="menuitem"]')!.click())
      assert.match(preview().textContent!, wanted)
      assert.doesNotMatch(preview().textContent!, absent)
    }
  } finally { await view.unmount(); resetConvos() }
})

test('missing snapshot and generation mismatch keep the saved quote, never a newer assistant revision', async () => {
  localStorage.clear(); resetConvos()
  const server = new FakeServer()
  server.messages = [{ role: 'assistant', seq: 0, event_id: 'revision-new', native_event_id: 'same-message', text: 'New content' }]
  installFetch(server)
  for (const reply of [target('revision-old'), { ...target('revision-new'), generation: 1 }]) {
    storeReply(draftKey('org', 'writer', 2), reply)
    const view = await mountView(desk(), el => el)
    try {
      await refresh()
      const preview = view.el.querySelector('.reply-preview')!
      assert.equal(preview.querySelectorAll('.reply-preview-content').length, 0)
      assert.equal(preview.querySelector('blockquote')!.textContent, 'Saved excerpt')
      assert.match(preview.textContent!, /unavailable here; quoted context is retained/)
      assert.doesNotMatch(preview.textContent!, /New content/)
      assert.equal(preview.querySelector<HTMLButtonElement>('button')!.disabled, true)
    } finally { await view.unmount(); resetConvos() }
  }
})

test('the public source renderer validates public events and legacy prose remains an honest fallback', async () => {
  const messages: ChatMessage[] = [
    { event_id: 'public', role: 'user', text: 'unused', segments: [{ kind: 'mail', rows: [
      { from: 'reporter', kind: 'status', body: STATUS.body, at: '2026-09-12T09:00:00Z', ev_public: STATUS.public },
    ] }] },
    { event_id: 'wrong-profile', role: 'user', text: 'Legacy safe excerpt', segments: [{ kind: 'mail', rows: [
      { from: 'reporter', kind: 'status', body: 'SECRET', at: '2026-09-12T09:00:00Z', ev: { ...STATUS.private, summary: 'SECRET' } },
    ] }] },
  ]
  const sources = indexReplySources({ messages })
  const render = (id: string) => <ReplySourceProvider value={reply => <ReplySourceContent source={sources.get(reply.eventId)!}
    slug="org" nid="writer" profile="public" />}><ReplyPreview reply={target(id)} available onLocate={() => {}} /></ReplySourceProvider>
  const view = await mountView(render('public'), el => el)
  try {
    assert.ok(view.el.querySelector('[data-event-variant="status.report"]'))
    assert.match(view.el.textContent!, /status.report·summary/)
    await view.render(render('wrong-profile'))
    assert.equal(view.el.querySelectorAll('[data-event-variant]').length, 0)
    assert.match(view.el.textContent!, /Legacy safe excerpt/)
    assert.doesNotMatch(view.el.textContent!, /SECRET/)
  } finally { await view.unmount() }
})

test('live plans retain step status and sealed thinking stays an indicator', async () => {
  const sources = indexReplySources({ live: [{ event_id: 'plan', kind: 'plan', text: 'generic plan',
    plan: [{ step: 'Run checks', status: 'in_progress' }, { step: 'Commit', status: 'pending' }], explanation: 'Verify the change' }],
    transient: [{ event_id: 'sealed', role: 'assistant', kind: 'thinking_start', text: '' }] })
  const render = (id: string) => <ReplySourceContent source={sources.get(id)!} slug="org" nid="writer" profile="operator" />
  const view = await mountView(render('plan'), el => el)
  try {
    assert.equal(view.el.querySelectorAll('li').length, 2)
    assert.match(view.el.textContent!, /in progress: Run checks/)
    assert.match(view.el.textContent!, /Verify the change/)
    await view.render(render('sealed'))
    assert.match(view.el.textContent!, /Thinking text unavailable/)
    assert.equal(view.el.querySelectorAll('svg').length, 1)
  } finally { await view.unmount() }
})

test('rich previews are bounded in both directions with images and long code kept inside', () => {
  const css = readFileSync(path.join(__SRC_DIR__, 'styles.css'), 'utf8')
  assert.match(css, /\.reply-preview-content\s*\{[^}]*max-height:\s*10rem;[^}]*overflow:\s*auto;/)
  assert.match(css, /\.reply-preview\s*\{[^}]*min-width:\s*0;[^}]*max-width:\s*100%;/)
  assert.match(css, /\.reply-preview-content pre\s*\{[^}]*white-space:\s*pre-wrap;[^}]*overflow-wrap:\s*anywhere;/)
  assert.match(css, /\.reply-preview-content img\s*\{[^}]*max-width:\s*100%;[^}]*max-height:\s*7rem;/)
})

test('nested preview names and titles keep copy menus while text selection and links keep native menus', async () => {
  const savedClip = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
  const writes: string[] = [], feedback: string[][] = []
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
    writeText: async (text: string) => { writes.push(text) },
  } })
  window.getSelection()?.removeAllRanges()
  const sources = indexReplySources({ messages: [{ role: 'assistant', event_id: 'source',
    text: '@agent:org/writer and @item:org/fix-title\n\n[External link](https://example.invalid)' }] })
  let parentMenus = 0
  const title = '  Exact “title” & punctuation  '
  const view = await mountView(<ObjectMenuBoundary toast={lines => feedback.push(lines ?? [])}>
    <div onContextMenu={() => { parentMenus++ }}>
      <ReplySourceProvider value={reply => <ReplySourceContent source={sources.get(reply.eventId)!}
        slug="org" nid="writer" profile="operator" refs={{ world: { org: 'org',
          agents: new Map([['writer', 'writer']]), items: new Map([['fix-title', 'fix-title']]),
          itemTitles: new Map([['fix-title', title]]) }, onOpen: () => assert.fail('copy navigated') }} />}>
        <ReplyPreview reply={target('source')} available onLocate={() => assert.fail('copy located the source')} />
      </ReplySourceProvider>
    </div>
  </ObjectMenuBoundary>, el => el)
  const context = async (element: Element) => {
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 })
    await inAct(() => { element.dispatchEvent(event) })
    await flush(2)
    return event.defaultPrevented
  }
  try {
    for (const [selector, label] of [
      ['[data-copy-agent-name]', 'Copy agent name'], ['[data-copy-ticket-title]', 'Copy ticket title'],
    ]) {
      const object = view.el.querySelector('.reply-preview-content ' + selector)!
      assert.ok(object)
      assert.equal(await context(object), true)
      const choices = [...document.querySelectorAll<HTMLButtonElement>('.ctxmenu [role="menuitem"]')]
      const copy = choices.filter(choice => choice.textContent === label)
      assert.equal(copy.length, 1)
      assert.equal(choices.some(choice => choice.textContent === 'Reply'), false)
      await inAct(() => { copy[0]!.click() })
      await flush(2)
    }
    assert.deepEqual(writes, ['writer', title])
    assert.deepEqual(feedback, [['copied agent name'], ['copied ticket title']])
    const name = view.el.querySelector('.reply-preview-content [data-copy-agent-name]')!
    const range = document.createRange(); range.selectNodeContents(name)
    window.getSelection()!.removeAllRanges()
    window.getSelection()!.addRange(range)
    assert.equal(window.getSelection()!.isCollapsed, false, 'fixture creates a live text selection')
    assert.equal(await context(name), false, 'selected text keeps the browser menu')
    window.getSelection()!.removeAllRanges()
    assert.equal(await context(view.el.querySelector('a[href="https://example.invalid"]')!), false)
    assert.equal(await context(view.el.querySelector('.reply-preview-content')!), false)
    assert.equal(document.querySelectorAll('.ctxmenu').length, 0)
    assert.equal(parentMenus, 0, 'a quoted source never opens the containing message menu')
  } finally {
    await view.unmount(); window.getSelection()?.removeAllRanges()
    if (savedClip) Object.defineProperty(navigator, 'clipboard', savedClip)
    else delete (navigator as unknown as { clipboard?: unknown }).clipboard
  }
})
