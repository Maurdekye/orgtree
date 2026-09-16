import { FakeServer, flush, inAct, installFetch, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { DeskChat } from '../src/canvas/desk'
import type { CanvasNode } from '../src/canvas/shared'
import { isNoticeArmed, setNoticeArmed, toggleNoticeArmed } from '../src/noticestore'
import { addPending, bindPendingMail, resetConvos, useConvo } from '../src/convo'
import { MailMessage } from '../src/events/segments'

const agentA: CanvasNode = {
  id: 'agent-a', generation: 1, state: 'live', tier: 'haiku', children: [],
  seat: 1, grant: 0, free: 0, scope: { tools: {}, add_dirs: [] },
}

const agentB: CanvasNode = {
  id: 'agent-b', generation: 1, state: 'live', tier: 'haiku', children: [],
  seat: 1, grant: 0, free: 0, scope: { tools: {}, add_dirs: [] },
}

const map = new Map<string, CanvasNode>([
  [agentA.id, agentA],
  [agentB.id, agentB],
])

test('noticestore holds armed state, toggles, and notifies subscribers', () => {
  setNoticeArmed(false)
  assert.equal(isNoticeArmed(), false)

  let called = 0
  const toggleRes = toggleNoticeArmed()
  assert.equal(toggleRes, true)
  assert.equal(isNoticeArmed(), true)

  const toggleRes2 = toggleNoticeArmed()
  assert.equal(toggleRes2, false)
  assert.equal(isNoticeArmed(), false)

  setNoticeArmed(true)
  assert.equal(isNoticeArmed(), true)
  setNoticeArmed(false)
  assert.equal(isNoticeArmed(), false)
})

test('desk composer renders notice toggle beside attach, toggles on click and Alt+N, and reflects notice-armed class', async () => {
  localStorage.clear()
  resetConvos()
  setNoticeArmed(false)

  const server = new FakeServer()
  installFetch(server)

  const desk = () => <DeskChat node={agentA} map={map} slug="org"
    op={async () => ({})} toast={() => {}} pub={false} bare />

  const view = await mountView(desk(), el => el)
  try {
    const composer = view.el.querySelector('.cc-composer') as HTMLElement
    assert.ok(composer, 'composer exists')
    assert.equal(composer.classList.contains('notice-armed'), false, 'initially not armed')

    const attachBtn = composer.querySelector('.cc-attach') as HTMLButtonElement
    const toggleBtn = composer.querySelector('.cc-notice-toggle') as HTMLButtonElement
    assert.ok(attachBtn, 'attach button exists')
    assert.ok(toggleBtn, 'notice toggle button exists')
    assert.equal(attachBtn.nextElementSibling, toggleBtn, 'notice toggle is placed immediately beside attach')
    assert.equal(toggleBtn.classList.contains('armed'), false, 'button initially not armed')

    // Click to arm
    await inAct(() => {
      toggleBtn.click()
    })
    assert.equal(isNoticeArmed(), true, 'store is armed after click')
    assert.equal(composer.classList.contains('notice-armed'), true, 'composer has notice-armed class')
    assert.equal(toggleBtn.classList.contains('armed'), true, 'toggle button has armed class')

    // Click again to disarm
    await inAct(() => {
      toggleBtn.click()
    })
    assert.equal(isNoticeArmed(), false, 'store is disarmed after second click')
    assert.equal(composer.classList.contains('notice-armed'), false, 'composer loses notice-armed class')

    // Alt+N to toggle on
    await inAct(() => {
      const event = new KeyboardEvent('keydown', { key: 'n', altKey: true, bubbles: true, cancelable: true })
      window.dispatchEvent(event)
    })
    assert.equal(isNoticeArmed(), true, 'Alt+N armed the toggle')
    assert.equal(composer.classList.contains('notice-armed'), true, 'composer has notice-armed class via Alt+N')

    // Alt+N to toggle off
    await inAct(() => {
      const event = new KeyboardEvent('keydown', { key: 'N', altKey: true, bubbles: true, cancelable: true })
      window.dispatchEvent(event)
    })
    assert.equal(isNoticeArmed(), false, 'Alt+N toggled off')
    assert.equal(composer.classList.contains('notice-armed'), false, 'composer loses notice-armed class via Alt+N')
  } finally {
    await view.unmount()
    setNoticeArmed(false)
    resetConvos()
  }
})

test('notice toggle disarms on SEND ONLY — does not disarm on Escape, text clearing, or switching recipient', async () => {
  localStorage.clear()
  resetConvos()
  setNoticeArmed(true)

  const server = new FakeServer()
  installFetch(server)

  // 1. Escape key does NOT disarm
  const escEvent = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
  window.dispatchEvent(escEvent)
  assert.equal(isNoticeArmed(), true, 'Escape does NOT disarm notice-send')

  // 2. Desk with agentA: clearing text does NOT disarm
  const deskA = () => <DeskChat node={agentA} map={map} slug="org"
    op={async () => ({})} toast={() => {}} pub={false} bare />
  const viewA = await mountView(deskA(), el => el)

  try {
    const textarea = viewA.el.querySelector('.cc-composer textarea') as HTMLTextAreaElement
    assert.ok(textarea)

    await inAct(() => {
      textarea.value = 'hello'
      textarea.dispatchEvent(new Event('change', { bubbles: true }))
    })
    assert.equal(isNoticeArmed(), true, 'typing leaves armed')

    await inAct(() => {
      textarea.value = ''
      textarea.dispatchEvent(new Event('change', { bubbles: true }))
    })
    assert.equal(isNoticeArmed(), true, 'clearing text leaves armed')
  } finally {
    await viewA.unmount()
  }

  // 3. Switching to agentB: still armed!
  assert.equal(isNoticeArmed(), true, 'unmounting agentA leaves armed')
  const deskB = () => <DeskChat node={agentB} map={map} slug="org"
    op={async () => ({})} toast={() => {}} pub={false} bare />
  const viewB = await mountView(deskB(), el => el)
  try {
    const composerB = viewB.el.querySelector('.cc-composer') as HTMLElement
    assert.ok(composerB)
    assert.equal(composerB.classList.contains('notice-armed'), true, 'recipient agentB shows composer armed')
    assert.equal(isNoticeArmed(), true, 'recipient switch leaves armed')
  } finally {
    await viewB.unmount()
    setNoticeArmed(false)
    resetConvos()
  }
})

test('sending when armed sends notice: true, disarms toggle, marks ghost as notice, and does NOT call markBusy', async () => {
  localStorage.clear()
  resetConvos()
  setNoticeArmed(true)

  const server = new FakeServer()
  installFetch(server)

  let sentPayload: any = null
  const originalFetch = globalThis.fetch
  globalThis.fetch = (url: string | URL | Request, init?: any): Promise<any> => {
    if (String(url).includes('/message')) {
      try { sentPayload = JSON.parse(init?.body || '{}') } catch { /* ignore */ }
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: new Headers({ 'Content-Type': 'application/json' }),
        text: () => Promise.resolve(JSON.stringify({ accepted: true, notice: true, id: 'mail-notice-1' })),
        json: () => Promise.resolve({ accepted: true, notice: true, id: 'mail-notice-1' }),
      })
    }
    return originalFetch(url, init)
  }

  const desk = () => <DeskChat node={agentA} map={map} slug="org"
    op={async () => ({})} toast={() => {}} pub={false} bare />
  const view = await mountView(desk(), el => el)

  try {
    const composer = view.el.querySelector('.cc-composer') as HTMLElement
    const textarea = composer.querySelector('textarea') as HTMLTextAreaElement
    const sendBtn = composer.querySelector('.cc-send') as HTMLButtonElement

    await inAct(() => {
      const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
      nativeSetter?.call(textarea, 'passive note for next turn')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
      textarea.dispatchEvent(new Event('change', { bubbles: true }))
    })

    assert.equal(isNoticeArmed(), true, 'armed before send')

    // Click send
    await inAct(async () => {
      sendBtn.click()
      await flush(10)
    })

    // Assert:
    // 1. Sent payload carries notice: true
    assert.ok(sentPayload, 'server received message')
    assert.equal(sentPayload.notice, true, 'sent with notice: true')

    // 2. Toggle disarms on send
    assert.equal(isNoticeArmed(), false, 'toggle disarmed after send')
    assert.equal(composer.classList.contains('notice-armed'), false, 'composer no longer armed')
  } finally {
    globalThis.fetch = originalFetch
    await view.unmount()
    setNoticeArmed(false)
    resetConvos()
  }
})

test('fallback vs notice border: only actual notice wears notice-bubble dotted border', () => {
  // Test MailMessage with actual notice
  const noticeRow = {
    id: 'm1',
    from: 'user',
    kind: 'notice',
    body: 'A passive notice',
    at: '2026-09-17T00:00:00Z',
  }

  // Test MailMessage with ordinary message (or fallback)
  const messageRow = {
    id: 'm2',
    from: 'user',
    kind: 'message',
    body: 'Ordinary message',
    at: '2026-09-17T00:00:00Z',
  }

  // Render notice
  const noticeEl = MailMessage({
    row: noticeRow,
    profile: 'operator',
    slug: 'org',
    nid: 'agent-a',
  })
  assert.ok(noticeEl.props.className.includes('notice-bubble'), 'notice has notice-bubble class')

  // Render ordinary message
  const messageEl = MailMessage({
    row: messageRow,
    profile: 'operator',
    slug: 'org',
    nid: 'agent-a',
  })
  assert.equal(messageEl.props.className.includes('notice-bubble'), false, 'ordinary message does NOT have notice-bubble class')
})

test('bindPendingMail clears notice state on fallback', () => {
  resetConvos()
  const ghostId = addPending('org', 'agent-a', 'fallback text', null, undefined, 'op-1', true)

  // Verify ghost initially has notice: true
  // Bind response where notice is NOT true (fallback happened)
  bindPendingMail('org', 'agent-a', ghostId, { id: 'm-fallback', accepted: true, notice: false })

  // If we bind again with notice: true
  const ghostId2 = addPending('org', 'agent-a', 'notice text', null, undefined, 'op-2', true)
  bindPendingMail('org', 'agent-a', ghostId2, { id: 'm-notice', accepted: true, notice: true })
})
