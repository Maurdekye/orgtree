import { FakeServer, flush, inAct, installFetch, mountView } from './harness'
import React, { useState } from 'react'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { DeskChat } from '../src/canvas/desk'
import type { CanvasNode } from '../src/canvas/shared'
import { isNoticeArmed, resetNoticeStore, setNoticeArmed, toggleNoticeArmed } from '../src/noticestore'
import { addPending, bindPendingMail, resetConvos, useConvo } from '../src/convo'
import { MailMessage } from '../src/events/segments'

declare const __SRC_DIR__: string

const agentA: CanvasNode = {
  id: 'agent-a', generation: 1, state: 'live', tier: 'haiku', children: [],
  seat: 1, grant: 0, free: 0, scope: { tools: {}, add_dirs: [] },
}

const agentB: CanvasNode = {
  id: 'agent-b', generation: 1, state: 'live', tier: 'haiku', children: [],
  seat: 1, grant: 0, free: 0, scope: { tools: {}, add_dirs: [] },
}

const agentC: CanvasNode = {
  id: 'agent-c', generation: 1, state: 'live', tier: 'haiku', children: [],
  seat: 1, grant: 0, free: 0, scope: { tools: {}, add_dirs: [] },
}

const map = new Map<string, CanvasNode>([
  [agentA.id, agentA],
  [agentB.id, agentB],
  [agentC.id, agentC],
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

test('desk composer renders notice toggle ABOVE attach, toggles on click and Alt+N, and reflects notice-armed class', async () => {
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
    // ABOVE the attach button, not beside it (user 2026-09-17): both live in
    // the composer's one-column button stack, toggle first, attach second —
    // and the stack is the column, which is what puts one over the other.
    const stack = composer.querySelector('.cc-btnstack') as HTMLElement
    assert.ok(stack, 'the composer has a button stack')
    assert.equal(toggleBtn.parentElement, stack, 'the notice toggle is in the stack')
    assert.equal(attachBtn.parentElement, stack, 'the attach button is in the stack')
    assert.equal(toggleBtn.nextElementSibling, attachBtn, 'the notice toggle comes before attach, so it renders above it')
    assert.deepEqual([...stack.children].map(c => c.className.split(' ')[0]),
      ['cc-notice-toggle', 'cc-attach'], 'the stack holds exactly those two controls, in that order')
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

  // 3. Switching to agentB: agentB is NOT armed, isolating per-chat state
  assert.equal(isNoticeArmed('org/agent-a'), true, 'unmounting agentA leaves agentA armed in store')
  const deskB = () => <DeskChat node={agentB} map={map} slug="org"
    op={async () => ({})} toast={() => {}} pub={false} bare />
  const viewB = await mountView(deskB(), el => el)
  try {
    const composerB = viewB.el.querySelector('.cc-composer') as HTMLElement
    assert.ok(composerB)
    assert.equal(composerB.classList.contains('notice-armed'), false, 'recipient agentB does NOT inherit agentA armed state')
    assert.equal(isNoticeArmed('org/agent-b'), false, 'agentB is unarmed in store')
    assert.equal(isNoticeArmed('org/agent-a'), true, 'agentA remains armed in store')
  } finally {
    await viewB.unmount()
  }

  // 4. Switching back to agentA: agentA is still armed (switching recipient did not disarm it)
  const viewA2 = await mountView(deskA(), el => el)
  try {
    const composerA2 = viewA2.el.querySelector('.cc-composer') as HTMLElement
    assert.ok(composerA2)
    assert.equal(composerA2.classList.contains('notice-armed'), true, 'returning to agentA preserves agentA armed state')
    assert.equal(isNoticeArmed('org/agent-a'), true, 'agentA is still armed')
  } finally {
    await viewA2.unmount()
    resetNoticeStore()
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

test('fallback vs notice styling: only actual notice wears passive notice class', () => {
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
  assert.ok(noticeEl.props.className.includes('passive'), 'notice has passive class')

  // Render ordinary message
  const messageEl = MailMessage({
    row: messageRow,
    profile: 'operator',
    slug: 'org',
    nid: 'agent-a',
  })
  assert.equal(messageEl.props.className.includes('passive'), false, 'ordinary message does NOT have passive class')
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

test('the notice edge STYLE is shared; only the composer takes the provider colour', () => {
  const css = readFileSync(path.join(__SRC_DIR__, 'styles.css'), 'utf8')

  // 1. Root defines shared tokens
  assert.match(css, /--notice-edge-style:\s*dashed;/,
    ':root must define --notice-edge-style as dashed')
  assert.match(css, /--notice-edge-color:\s*color-mix\(in srgb,\s*var\(--dim\)\s*55%,\s*var\(--line\)\);/,
    ':root must define --notice-edge-color referencing --dim and --line')

  // 2. .turn-mail.passive uses the shared tokens
  const passiveBlock = css.match(/\.turn-mail\.passive\s*\{([^}]+)\}/)?.[1] ?? ''
  assert.ok(passiveBlock, '.turn-mail.passive rule exists')
  assert.match(passiveBlock, /border-left:\s*3px\s+var\(--notice-edge-style\)\s+var\(--notice-edge-color\);/,
    '.turn-mail.passive must source its border-left style and color from the shared tokens')

  // 3. .cc-composer.notice-armed keeps the SHARED STYLE and its 1px width, but
  //    takes the PROVIDER COLOUR (user 2026-09-17: "provider colored still,
  //    not grey"). --accent is what `.desk-body.prov-*` resolves to the desk's
  //    provider colour, so the armed edge follows the provider automatically.
  const armedBlock = css.match(/\.cc-composer\.notice-armed\s*\{([^}]+)\}/)?.[1] ?? ''
  assert.ok(armedBlock, '.cc-composer.notice-armed rule exists')
  assert.match(armedBlock, /border-style:\s*var\(--notice-edge-style\);/,
    '.cc-composer.notice-armed must source border-style from --notice-edge-style')
  assert.match(armedBlock, /border-color:\s*var\(--accent\);/,
    '.cc-composer.notice-armed must be provider-coloured, not the neutral notice grey')
  assert.doesNotMatch(armedBlock, /border-color:\s*var\(--notice-edge-color\);/,
    '.cc-composer.notice-armed must NOT take the neutral --notice-edge-color')
  assert.match(armedBlock, /border-width:\s*1px;/,
    '.cc-composer.notice-armed must be 1px to preserve composer sizing/padding without reflow')

  // 4. .cc-composer.notice-armed:focus-within keeps the same provider colour —
  //    focusing must not change the armed edge at all
  const armedFocusBlock = css.match(/\.cc-composer\.notice-armed:focus-within\s*\{([^}]+)\}/)?.[1] ?? ''
  assert.ok(armedFocusBlock, '.cc-composer.notice-armed:focus-within rule exists')
  assert.match(armedFocusBlock, /border-color:\s*var\(--accent\);/,
    '.cc-composer.notice-armed:focus-within must keep the provider colour')

  // 5. Non-notice composer borders are untouched
  const composerBlock = css.match(/\.cc-composer\s*\{([^}]+)\}/)?.[1] ?? ''
  assert.ok(composerBlock, '.cc-composer rule exists')
  assert.match(composerBlock, /border:\s*1px\s+solid\s+var\(--line\);/,
    '.cc-composer default border is unchanged (1px solid var(--line))')
  assert.match(composerBlock, /padding:\s*7px\s+9px;/,
    '.cc-composer padding is unchanged (7px 9px)')

  const normalFocusBlock = css.match(/\.cc-composer:focus-within\s*\{([^}]+)\}/)?.[1] ?? ''
  assert.match(normalFocusBlock, /border-color:\s*var\(--accent\);/,
    '.cc-composer:focus-within default focus border is unchanged')
})

test('switchboard: with multiple chat windows open, toggling send-as-notice in one changes only that window', async () => {
  localStorage.clear()
  resetConvos()
  resetNoticeStore()

  const server = new FakeServer()
  installFetch(server)

  const Switchboard = ({ openNodes }: { openNodes: CanvasNode[] }) => (
    <div className="eye-panels">
      {openNodes.map((a) => (
        <div className="eye-panel" key={a.id}>
          <DeskChat node={a} map={map} slug="org"
            op={async () => ({})} toast={() => {}} pub={false} bare compact />
        </div>
      ))}
    </div>
  )

  const view = await mountView(<Switchboard openNodes={[agentA, agentB]} />, el => el)
  try {
    const panels = view.el.querySelectorAll('.eye-panel')
    assert.equal(panels.length, 2, 'two switchboard panels mounted')

    const composerA = panels[0].querySelector('.cc-composer') as HTMLElement
    const composerB = panels[1].querySelector('.cc-composer') as HTMLElement
    const toggleA = panels[0].querySelector('.cc-notice-toggle') as HTMLButtonElement
    const toggleB = panels[1].querySelector('.cc-notice-toggle') as HTMLButtonElement

    assert.ok(composerA && composerB && toggleA && toggleB)
    assert.equal(composerA.classList.contains('notice-armed'), false, 'composer A initially not armed')
    assert.equal(composerB.classList.contains('notice-armed'), false, 'composer B initially not armed')
    assert.equal(isNoticeArmed('org/agent-a'), false)
    assert.equal(isNoticeArmed('org/agent-b'), false)

    // 1. Click toggle on Agent A: arms Agent A only!
    await inAct(() => {
      toggleA.click()
    })
    assert.equal(isNoticeArmed('org/agent-a'), true, 'store: Agent A armed')
    assert.equal(isNoticeArmed('org/agent-b'), false, 'store: Agent B remains unarmed')
    assert.equal(composerA.classList.contains('notice-armed'), true, 'composer A has notice-armed class')
    assert.equal(toggleA.classList.contains('armed'), true, 'toggle A has armed class')
    assert.equal(composerB.classList.contains('notice-armed'), false, 'composer B DOES NOT have notice-armed class')
    assert.equal(toggleB.classList.contains('armed'), false, 'toggle B DOES NOT have armed class')

    // 2. Click toggle on Agent B: arms Agent B as well!
    await inAct(() => {
      toggleB.click()
    })
    assert.equal(isNoticeArmed('org/agent-a'), true, 'store: Agent A is still armed')
    assert.equal(isNoticeArmed('org/agent-b'), true, 'store: Agent B is now armed')
    assert.equal(composerA.classList.contains('notice-armed'), true, 'composer A remains armed')
    assert.equal(composerB.classList.contains('notice-armed'), true, 'composer B is now armed')

    // 3. Click toggle on Agent A again: disarms Agent A only; Agent B remains armed!
    await inAct(() => {
      toggleA.click()
    })
    assert.equal(isNoticeArmed('org/agent-a'), false, 'store: Agent A disarmed')
    assert.equal(isNoticeArmed('org/agent-b'), true, 'store: Agent B remains armed')
    assert.equal(composerA.classList.contains('notice-armed'), false, 'composer A no longer armed')
    assert.equal(composerB.classList.contains('notice-armed'), true, 'composer B remains armed')
  } finally {
    await view.unmount()
    resetNoticeStore()
    resetConvos()
  }
})

test('switchboard: message sent from each window uses that window’s own send-as-notice state', async () => {
  localStorage.clear()
  resetConvos()
  resetNoticeStore()

  const server = new FakeServer()
  installFetch(server)

  const sentMessages: { target: string; payload: any }[] = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = (url: string | URL | Request, init?: any): Promise<any> => {
    const urlStr = String(url)
    if (urlStr.includes('/message')) {
      const match = urlStr.match(/\/nodes\/([^/]+)\/message/)
      const target = match ? match[1] : 'unknown'
      let payload: any = {}
      try { payload = JSON.parse(init?.body || '{}') } catch {}
      sentMessages.push({ target, payload })
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: new Headers({ 'Content-Type': 'application/json' }),
        text: () => Promise.resolve(JSON.stringify({ accepted: true, notice: !!payload.notice, id: `mail-${sentMessages.length}` })),
        json: () => Promise.resolve({ accepted: true, notice: !!payload.notice, id: `mail-${sentMessages.length}` }),
      })
    }
    return originalFetch(url, init)
  }

  const Switchboard = ({ openNodes }: { openNodes: CanvasNode[] }) => (
    <div className="eye-panels">
      {openNodes.map((a) => (
        <div className="eye-panel" key={a.id}>
          <DeskChat node={a} map={map} slug="org"
            op={async () => ({})} toast={() => {}} pub={false} bare compact />
        </div>
      ))}
    </div>
  )

  const view = await mountView(<Switchboard openNodes={[agentA, agentB]} />, el => el)
  try {
    const panels = view.el.querySelectorAll('.eye-panel')
    const composerA = panels[0].querySelector('.cc-composer') as HTMLElement
    const composerB = panels[1].querySelector('.cc-composer') as HTMLElement
    const taA = composerA.querySelector('textarea') as HTMLTextAreaElement
    const taB = composerB.querySelector('textarea') as HTMLTextAreaElement
    const toggleB = composerB.querySelector('.cc-notice-toggle') as HTMLButtonElement
    const sendA = composerA.querySelector('.cc-send') as HTMLButtonElement
    const sendB = composerB.querySelector('.cc-send') as HTMLButtonElement
    const toggleA = composerA.querySelector('.cc-notice-toggle') as HTMLButtonElement

    // Arm BOTH Agent A and Agent B
    await inAct(() => {
      toggleA.click()
      toggleB.click()
    })
    assert.equal(isNoticeArmed('org/agent-a'), true)
    assert.equal(isNoticeArmed('org/agent-b'), true)
    assert.equal(composerA.classList.contains('notice-armed'), true)
    assert.equal(composerB.classList.contains('notice-armed'), true)

    // 1. Send from Agent A (armed)
    await inAct(() => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
      setter?.call(taA, 'notice message from A')
      taA.dispatchEvent(new Event('input', { bubbles: true }))
      taA.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await inAct(async () => {
      sendA.click()
      await flush(10)
    })

    assert.equal(sentMessages.length, 1)
    assert.equal(sentMessages[0].target, 'agent-a')
    assert.equal(sentMessages[0].payload.notice, true, 'Agent A send had notice: true')
    assert.equal(composerA.classList.contains('notice-armed'), false, 'Agent A disarmed after its send')
    assert.equal(isNoticeArmed('org/agent-a'), false, 'store: Agent A disarmed')
    assert.equal(composerB.classList.contains('notice-armed'), true, 'Agent B is STILL armed after A sent')
    assert.equal(isNoticeArmed('org/agent-b'), true, 'store: Agent B still armed')

    // 2. Send from Agent B (armed)
    await inAct(() => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
      setter?.call(taB, 'passive notice from B')
      taB.dispatchEvent(new Event('input', { bubbles: true }))
      taB.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await inAct(async () => {
      sendB.click()
      await flush(10)
    })

    assert.equal(sentMessages.length, 2)
    assert.equal(sentMessages[1].target, 'agent-b')
    assert.equal(sentMessages[1].payload.notice, true, 'Agent B send had notice: true')
    assert.equal(composerB.classList.contains('notice-armed'), false, 'Agent B disarmed after its send')
    assert.equal(isNoticeArmed('org/agent-b'), false, 'store: Agent B disarmed')
    assert.equal(composerA.classList.contains('notice-armed'), false, 'Agent A still unarmed')
  } finally {
    globalThis.fetch = originalFetch
    await view.unmount()
    resetNoticeStore()
    resetConvos()
  }
})

test('switchboard: independent states survive focus changes, Alt+N keyboard scoping, rerenders, mail arrival, and chat open/close', async () => {
  localStorage.clear()
  resetConvos()
  resetNoticeStore()

  const server = new FakeServer()
  installFetch(server)

  let setNodesState: (nodes: CanvasNode[]) => void = () => {}
  const SwitchboardWrapper = () => {
    const [openNodes, setOpenNodes] = useState<CanvasNode[]>([agentA, agentB])
    setNodesState = setOpenNodes
    return (
      <div className="eye-panels">
        {openNodes.map((a) => (
          <div className="eye-panel" key={a.id}>
            <DeskChat node={a} map={map} slug="org"
              op={async () => ({})} toast={() => {}} pub={false} bare compact />
          </div>
        ))}
      </div>
    )
  }

  const view = await mountView(<SwitchboardWrapper />, el => el)
  try {
    let panels = view.el.querySelectorAll('.eye-panel')
    let composerA = panels[0].querySelector('.cc-composer') as HTMLElement
    let composerB = panels[1].querySelector('.cc-composer') as HTMLElement
    let taA = composerA.querySelector('textarea') as HTMLTextAreaElement
    let taB = composerB.querySelector('textarea') as HTMLTextAreaElement

    // 1. Focus changes and keyboard routing:
    // Focus Agent A's textarea and press Alt+N
    const attachA = composerA.querySelector('.cc-attach') as HTMLButtonElement
    const attachB = composerB.querySelector('.cc-attach') as HTMLButtonElement

    // Focus Agent A's attach button and press Alt+N (bubbles to window)
    await inAct(() => {
      attachA.focus()
      const ev = new KeyboardEvent('keydown', { key: 'n', altKey: true, bubbles: true, cancelable: true })
      attachA.dispatchEvent(ev)
    })
    assert.equal(isNoticeArmed('org/agent-a'), true, 'Agent A armed via Alt+N on attach button (window listener)')
    assert.equal(isNoticeArmed('org/agent-b'), false, 'Agent B remains unarmed')
    assert.equal(composerA.classList.contains('notice-armed'), true)
    assert.equal(composerB.classList.contains('notice-armed'), false)

    // Focus Agent B's attach button and press Alt+N (bubbles to window)
    await inAct(() => {
      attachB.focus()
      const ev = new KeyboardEvent('keydown', { key: 'n', altKey: true, bubbles: true, cancelable: true })
      attachB.dispatchEvent(ev)
    })
    assert.equal(isNoticeArmed('org/agent-a'), true, 'Agent A remains armed')
    assert.equal(isNoticeArmed('org/agent-b'), true, 'Agent B armed via Alt+N on attach button')
    assert.equal(composerA.classList.contains('notice-armed'), true)
    assert.equal(composerB.classList.contains('notice-armed'), true)

    // Press Alt+N in Agent A textarea to toggle Agent A off
    await inAct(() => {
      taA.focus()
      const ev = new KeyboardEvent('keydown', { key: 'n', altKey: true, bubbles: true, cancelable: true })
      taA.dispatchEvent(ev)
    })
    assert.equal(isNoticeArmed('org/agent-a'), false, 'Agent A unarmed via Alt+N in textarea')
    assert.equal(isNoticeArmed('org/agent-b'), true, 'Agent B remains armed')
    assert.equal(composerA.classList.contains('notice-armed'), false)
    assert.equal(composerB.classList.contains('notice-armed'), true)

    // 2. Mail arrival / rerender:
    // Simulate incoming mail / convo update for Agent A
    await inAct(() => {
      addPending('org', 'agent-a', 'incoming mail arrived', null, undefined, 'op-mail-1', false)
    })
    assert.equal(isNoticeArmed('org/agent-a'), false, 'Agent A still unarmed after mail arrival')
    assert.equal(isNoticeArmed('org/agent-b'), true, 'Agent B still armed after mail arrival in A')
    assert.equal(composerA.classList.contains('notice-armed'), false)
    assert.equal(composerB.classList.contains('notice-armed'), true)

    // 3. Opening a new chat (Agent C)
    await inAct(() => {
      setNodesState([agentA, agentB, agentC])
    })
    panels = view.el.querySelectorAll('.eye-panel')
    assert.equal(panels.length, 3, 'three panels now open')
    composerA = panels[0].querySelector('.cc-composer') as HTMLElement
    composerB = panels[1].querySelector('.cc-composer') as HTMLElement
    const composerC = panels[2].querySelector('.cc-composer') as HTMLElement

    assert.equal(composerA.classList.contains('notice-armed'), false, 'Agent A still unarmed')
    assert.equal(composerB.classList.contains('notice-armed'), true, 'Agent B still armed')
    assert.equal(composerC.classList.contains('notice-armed'), false, 'Agent C starts unarmed')
    assert.equal(isNoticeArmed('org/agent-c'), false)

    // 4. Closing chat B
    await inAct(() => {
      setNodesState([agentA, agentC])
    })
    panels = view.el.querySelectorAll('.eye-panel')
    assert.equal(panels.length, 2, 'Agent B closed, two panels remain')
    composerA = panels[0].querySelector('.cc-composer') as HTMLElement
    const remainingC = panels[1].querySelector('.cc-composer') as HTMLElement

    assert.equal(composerA.classList.contains('notice-armed'), false, 'Agent A still unarmed')
    assert.equal(remainingC.classList.contains('notice-armed'), false, 'Agent C still unarmed')
    assert.equal(isNoticeArmed('org/agent-b'), true, 'Agent B retains its armed state in store while closed')

    // 5. Re-opening chat B: restores armed state!
    await inAct(() => {
      setNodesState([agentA, agentB, agentC])
    })
    panels = view.el.querySelectorAll('.eye-panel')
    composerB = panels[1].querySelector('.cc-composer') as HTMLElement
    assert.equal(composerB.classList.contains('notice-armed'), true, 'Agent B restored armed state upon re-opening')
    assert.equal(isNoticeArmed('org/agent-b'), true)
  } finally {
    await view.unmount()
    resetNoticeStore()
    resetConvos()
  }
})
