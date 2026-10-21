import { FakeServer, fireResize, flush, inAct, installFetch, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { DeskChat } from '../src/canvas/desk'
import type { CanvasNode } from '../src/canvas/shared'
import { dismissUserMention, resetSeenMentions } from '../src/canvas/agentmentions'
import { refreshConvo, resetConvos } from '../src/convo'

const makeNode = (): CanvasNode => ({
  id: 'taskbar-orgs-sol',
  generation: 1,
  state: 'live',
  tier: 'sol',
  children: [],
  seat: 1,
  grant: 0,
  free: 0,
  scope: { tools: {}, add_dirs: [] },
  user_mention: {
    id: 'um-41-2',
    turn_id: 41,
    seq: 2,
    event_id: 'e2',
    blurb: 'The @user links now pass their first comparison.',
    at: '2026-10-21T07:18:30Z',
  },
})

function installTranscriptGeometry(list: HTMLElement, oldRect: () => DOMRect) {
  const rowStride = 140
  const rowHeight = 120
  const topPad = 40
  Object.defineProperties(list, {
    clientHeight: { configurable: true, get: () => 200 },
    offsetHeight: { configurable: true, get: () => 200 },
    scrollHeight: {
      configurable: true,
      get: () => {
        const rows = list.querySelectorAll('[data-transcript-row]').length
        return Math.max(400, topPad + rows * rowStride + 100)
      },
    },
  })
  window.HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    if (this === list) {
      return { top: 50, bottom: 250, left: 0, right: 500, width: 500, height: 200, x: 0, y: 50, toJSON() {} } as DOMRect
    }
    const row = this.closest<HTMLElement>('[data-transcript-row]')
    if (row && list.contains(row)) {
      const rows = [...list.querySelectorAll<HTMLElement>('[data-transcript-row]')]
      const idx = rows.indexOf(row)
      if (idx >= 0) {
        const rowTop = 50 + topPad + idx * rowStride - list.scrollTop
        return {
          top: rowTop,
          bottom: rowTop + rowHeight,
          left: 0,
          right: 500,
          width: 500,
          height: rowHeight,
          x: 0,
          y: rowTop,
          toJSON() {},
        } as DOMRect
      }
    }
    return oldRect.call(this)
  }
}

test('clicking a mention on initial desk mount scrolls to and stays centered on the mentioning message instead of snapping back to bottom', async () => {
  localStorage.clear()
  resetConvos()
  resetSeenMentions()
  const server = new FakeServer()
  server.messages = [
    { role: 'user', seq: 1, event_id: 'e1', text: 'Check parity' },
    { role: 'assistant', seq: 2, event_id: 'e2', text: 'Contact parity is integrated. The @user links now pass their first comparison.' },
    { role: 'assistant', seq: 3, event_id: 'e3', text: 'Ran unit suite part 1.' },
    { role: 'assistant', seq: 4, event_id: 'e4', text: 'Ran unit suite part 2.' },
    { role: 'assistant', seq: 5, event_id: 'e5', text: 'Ran unit suite part 3.' },
    { role: 'assistant', seq: 6, event_id: 'e6', text: 'Ran unit suite part 4.' },
    { role: 'assistant', seq: 7, event_id: 'e7', text: 'Ran unit suite part 5.' },
    { role: 'assistant', seq: 8, event_id: 'e8', text: 'All final checks done.' },
  ]
  installFetch(server)
  const node = makeNode()
  const proto = window.HTMLElement.prototype
  const oldRect = proto.getBoundingClientRect

  // Click the mention BEFORE the desk finishes its first load (simulating clicking the mention row/button to focus the agent)
  await inAct(async () => {
    await dismissUserMention('synthetic', node.id, 'um-41-2', 'e2', { highlight: true })
  })

  const view = await mountView(
    <div className="outer-frame">
      <DeskChat node={node} map={new Map([[node.id, node]])} slug="synthetic" op={async () => ({})} toast={() => {}} bare />
    </div>,
    el => el,
  )
  try {
    const list = view.el.querySelector<HTMLElement>('.msgs')!
    assert.ok(list, 'transcript scroller mounted')
    installTranscriptGeometry(list, oldRect)

    await inAct(async () => {
      await refreshConvo('synthetic', node.id)
      await flush(8)
    })

    const targetRow = list.querySelector<HTMLElement>('[data-reply-event="e2"]')
    assert.ok(targetRow, 'mentioning row e2 is rendered')
    assert.equal(targetRow.querySelector('.msg.assistant')?.classList.contains('mention-highlight'), true, 'mentioning row has highlight class')

    // Target row is at index 1: offsetTop = 40 + 1*140 = 180, height = 120, clientHeight = 200 -> centered scrollTop = 180 - (200 - 120)/2 = 140.
    // Bottom pin would be scrollHeight (1260).
    assert.equal(list.scrollTop, 140, `expected transcript to stay centered on e2 (140), got scrollTop=${list.scrollTop}`)
    assert.ok(view.el.querySelector('.jumpbottom'), 'jump to bottom button is shown while centered above bottom')
  } finally {
    proto.getBoundingClientRect = oldRect
    await view.unmount()
    resetConvos()
    resetSeenMentions()
  }
})

test('clicking a mention whose event_id is in an older cursor page loads older history and centers the mentioning assistant row without matching a newer user/notice @user text', async () => {
  localStorage.clear()
  resetConvos()
  resetSeenMentions()
  const server = new FakeServer()
  server.cursorPages = true
  // 20 rows total; CHAT_WINDOW = 8 loads seq 13..20 initially.
  // e2 (seq 2) is the assistant message that mentioned @user.
  // e15 (seq 15) is a user/notice row in the newest 8 rows whose text mentions (@user links).
  server.messages = Array.from({ length: 20 }, (_, i) => {
    const seq = i + 1
    if (seq === 2) {
      return {
        role: 'assistant',
        seq,
        event_id: 'e2',
        text: 'Contact parity is integrated, including the missing-Hubchat state. The @user links now pass their first comparison.',
      }
    }
    if (seq === 15) {
      return {
        role: 'user',
        seq,
        event_id: 'e15',
        text: 'Integrated: rust-engine fast-forwarded to 772d907 (@user links).',
      }
    }
    return {
      role: 'assistant',
      seq,
      event_id: `e${seq}`,
      text: `Subsequent tool and progress output ${seq}`,
    }
  })
  installFetch(server)
  const node = makeNode()
  const proto = window.HTMLElement.prototype
  const oldRect = proto.getBoundingClientRect

  const view = await mountView(
    <div className="outer-frame">
      <DeskChat node={node} map={new Map([[node.id, node]])} slug="synthetic" op={async () => ({})} toast={() => {}} bare />
    </div>,
    el => el,
  )
  try {
    const list = view.el.querySelector<HTMLElement>('.msgs')!
    installTranscriptGeometry(list, oldRect)

    await inAct(async () => {
      await refreshConvo('synthetic', node.id)
      await flush(6)
    })
    assert.equal(list.querySelector('[data-reply-event="e2"]'), null, 'positive control: e2 is outside the initial 8-row window')
    assert.ok(list.querySelector('[data-reply-event="e15"]'), 'positive control: newer row e15 with (@user links) is in the initial window')

    // Click the mention to jump to e2
    await inAct(async () => {
      await dismissUserMention('synthetic', node.id, 'um-41-2', 'e2', { highlight: true })
    })
    for (let page = 0; page < 6; page++) {
      await inAct(async () => {
        await flush(6)
      })
    }

    const targetRow = list.querySelector<HTMLElement>('[data-reply-event="e2"]')
    assert.ok(targetRow, 'mention jump paged older history until e2 loaded')
    assert.ok(server.requests.some(r => r.before), 'mention jump requested older cursor pages')

    // Verify e2 is centered in the 200px viewport (its rect center matches list rect center = 150)
    const listRect = list.getBoundingClientRect()
    const targetRect = targetRow.getBoundingClientRect()
    const targetCenter = targetRect.top + targetRect.height / 2
    const listCenter = listRect.top + listRect.height / 2
    assert.ok(
      Math.abs(targetCenter - listCenter) <= 5,
      `expected e2 center (${targetCenter}) to align with viewport center (${listCenter}), scrollTop=${list.scrollTop}`,
    )

    // Verify re-clicking the mention after scrolling away re-centers e2
    list.scrollTop = 900
    await inAct(async () => {
      await dismissUserMention('synthetic', node.id, 'um-41-2', 'e2', { highlight: true })
      await flush(4)
    })
    const afterReclickRect = targetRow.getBoundingClientRect()
    assert.ok(
      Math.abs((afterReclickRect.top + afterReclickRect.height / 2) - listCenter) <= 5,
      `expected re-clicking mention to re-center e2, scrollTop=${list.scrollTop}`,
    )
  } finally {
    proto.getBoundingClientRect = oldRect
    await view.unmount()
    resetConvos()
    resetSeenMentions()
  }
})

test('clicking a mention while the desk scroller has zero height does not consume the one-shot scroll before layout is visible', async () => {
  localStorage.clear()
  resetConvos()
  resetSeenMentions()
  const server = new FakeServer()
  server.messages = [
    { role: 'user', seq: 1, event_id: 'e1', text: 'Start task' },
    { role: 'assistant', seq: 2, event_id: 'e2', text: 'Here is the @user update.' },
    { role: 'assistant', seq: 3, event_id: 'e3', text: 'Follow-up step 1.' },
    { role: 'assistant', seq: 4, event_id: 'e4', text: 'Follow-up step 2.' },
  ]
  installFetch(server)
  const node = makeNode()
  const proto = window.HTMLElement.prototype
  const oldRect = proto.getBoundingClientRect

  const view = await mountView(
    <div className="outer-frame">
      <DeskChat node={node} map={new Map([[node.id, node]])} slug="synthetic" op={async () => ({})} toast={() => {}} bare />
    </div>,
    el => el,
  )
  try {
    const list = view.el.querySelector<HTMLElement>('.msgs')!
    // Initially clientHeight is 0 (jsdom default / hidden stage), so centerTranscriptTarget returns false
    await inAct(async () => {
      await refreshConvo('synthetic', node.id)
      await dismissUserMention('synthetic', node.id, 'um-41-2', 'e2', { highlight: true })
      await flush(4)
    })
    assert.equal(list.scrollTop, 0, 'precondition: zero-height scroller could not scroll yet')

    // Now the stage becomes visible with real geometry via ResizeObserver ONLY (no network refresh)
    const fetchesBeforeReveal = server.requests.length
    installTranscriptGeometry(list, oldRect)
    await inAct(async () => {
      fireResize(list)
      await flush(4)
    })
    assert.equal(server.requests.length, fetchesBeforeReveal, 'reveal resize did not require a transcript refetch')
    assert.equal(list.scrollTop, 140, `expected mention scroll to run on resize once scroller has layout height, got scrollTop=${list.scrollTop}`)

    // Once centered, a manual user scroll away is not undone by a later resize
    list.dispatchEvent(new window.WheelEvent('wheel', { deltaY: 80, bubbles: true }))
    list.scrollTop = 300
    list.dispatchEvent(new window.Event('scroll'))
    await inAct(async () => {
      fireResize(list)
      await flush(2)
    })
    assert.equal(list.scrollTop, 300, 'later resize after manual scroll does not re-center the already-handled mention')
  } finally {
    proto.getBoundingClientRect = oldRect
    await view.unmount()
    resetConvos()
    resetSeenMentions()
  }
})

