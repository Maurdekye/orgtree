import './harness'
import assert from 'node:assert/strict'
import test from 'node:test'
import { KillSwitch } from '../src/KillSwitch'
import { advance, flush, inAct, mountView, realClock, useFakeClock } from './harness'

test('§1 KillSwitch collapsed by default and not clickable', async () => {
  useFakeClock()
  try {
    let killed = false
    const view = await mountView(
      <KillSwitch
        slug="test-org"
        toast={() => {}}
        killFn={async () => {
          killed = true
          return { interrupted: ['agent-1'] }
        }}
      />,
      (el) => el,
    )
    const btn = view.el.querySelector<HTMLButtonElement>('.kill-btn')!
    const latch = view.el.querySelector<HTMLButtonElement>('.kill-latch')!

    assert.ok(btn, 'kill button rendered')
    assert.ok(latch, 'latch rendered')
    assert.ok(btn.classList.contains('collapsed'), 'button has collapsed class by default')
    assert.ok(!btn.classList.contains('expanded'), 'button does not have expanded class')
    assert.ok(!latch.classList.contains('open'), 'latch is not open')
    assert.equal(btn.disabled, true, 'button is disabled when collapsed')
    assert.equal(btn.getAttribute('tabindex'), '-1', 'button is not in tab order')

    // Clicking button while collapsed does nothing
    await inAct(() => { btn.click() })
    await flush()
    assert.equal(killed, false, 'clicking collapsed button does not call killFn')

    await view.unmount()
  } finally {
    realClock()
  }
})

test('§2 Unlatching expands button in disabled state; click during 500ms window does nothing', async () => {
  useFakeClock()
  try {
    let killed = false
    const view = await mountView(
      <KillSwitch
        slug="test-org"
        toast={() => {}}
        killFn={async () => {
          killed = true
          return { interrupted: ['agent-1'] }
        }}
      />,
      (el) => el,
    )
    const btn = view.el.querySelector<HTMLButtonElement>('.kill-btn')!
    const latch = view.el.querySelector<HTMLButtonElement>('.kill-latch')!

    // Unlatch
    await inAct(() => { latch.click() })
    await flush()

    assert.ok(latch.classList.contains('open'), 'latch wears .open')
    assert.ok(btn.classList.contains('expanded'), 'button wears .expanded')
    assert.ok(!btn.classList.contains('collapsed'), 'button no longer wears .collapsed')
    assert.equal(btn.disabled, true, 'button starts disabled upon unlatching')

    // Advance 200ms (still inside the 500ms safety window)
    await advance(200)
    assert.equal(btn.disabled, true, 'button is still disabled after 200ms')

    // Clicking during safety window must do nothing
    await inAct(() => { btn.click() })
    await flush()
    assert.equal(killed, false, 'click during disabled window does not execute killFn')

    await view.unmount()
  } finally {
    realClock()
  }
})

test('§3 Button enables after 500ms and executes kill on click', async () => {
  useFakeClock()
  try {
    let killed = false
    const toasts: string[][] = []
    let refreshed = false
    const view = await mountView(
      <KillSwitch
        slug="test-org"
        toast={(t) => { if (t) toasts.push(t) }}
        refreshTree={async () => { refreshed = true }}
        killFn={async () => {
          killed = true
          return { interrupted: ['agent-1', 'agent-2'] }
        }}
      />,
      (el) => el,
    )
    const btn = view.el.querySelector<HTMLButtonElement>('.kill-btn')!
    const latch = view.el.querySelector<HTMLButtonElement>('.kill-latch')!

    // Unlatch
    await inAct(() => { latch.click() })
    await flush()

    // Advance past 500ms
    await advance(500)
    assert.equal(btn.disabled, false, 'button is enabled after 500ms delay')

    // Click enabled button
    await inAct(() => { btn.click() })
    await flush()

    assert.equal(killed, true, 'killFn was executed')
    assert.deepEqual(toasts, [['interrupted 2 agent(s); queues cleared']])
    assert.equal(refreshed, true, 'tree was refreshed')

    // Once killed, button immediately re-latches and collapses
    assert.ok(!latch.classList.contains('open'), 'latch is closed after kill')
    assert.ok(btn.classList.contains('collapsed'), 'button is collapsed after kill')
    assert.equal(btn.disabled, true, 'button is disabled after kill')

    await view.unmount()
  } finally {
    realClock()
  }
})

test('§4 Re-latching collapses button and cancels pending enable timer (no stale enablement)', async () => {
  useFakeClock()
  try {
    let killed = false
    const view = await mountView(
      <KillSwitch
        slug="test-org"
        toast={() => {}}
        killFn={async () => {
          killed = true
          return { interrupted: ['agent-1'] }
        }}
      />,
      (el) => el,
    )
    const btn = view.el.querySelector<HTMLButtonElement>('.kill-btn')!
    const latch = view.el.querySelector<HTMLButtonElement>('.kill-latch')!

    // Step 1: Unlatch at t=0
    await inAct(() => { latch.click() })
    await flush()
    assert.equal(btn.disabled, true)

    // Step 2: Advance 200ms
    await advance(200)
    assert.equal(btn.disabled, true)

    // Step 3: Re-latch at t=200ms
    await inAct(() => { latch.click() })
    await flush()
    assert.ok(btn.classList.contains('collapsed'), 'button collapsed upon re-latch')
    assert.ok(!latch.classList.contains('open'), 'latch closed')
    assert.equal(btn.disabled, true)

    // Step 4: Advance 400ms (t=600ms from start, would have passed 500ms if timer 1 survived)
    await advance(400)
    assert.equal(btn.disabled, true, 'button remains disabled while collapsed')

    // Step 5: Unlatch again at t=600ms
    await inAct(() => { latch.click() })
    await flush()
    assert.ok(btn.classList.contains('expanded'))
    assert.equal(btn.disabled, true, 'freshly unlatched button starts disabled')

    // Step 6: Advance 100ms (t=700ms from start; only 100ms since second unlatch)
    await advance(100)
    assert.equal(btn.disabled, true, 'stale timer did NOT enable the button early!')

    // Try clicking now
    await inAct(() => { btn.click() })
    await flush()
    assert.equal(killed, false, 'click ignored during second disabled window')

    // Step 7: Advance remaining 400ms (500ms since second unlatch)
    await advance(400)
    assert.equal(btn.disabled, false, 'button becomes enabled after full 500ms delay')

    // Click enabled button
    await inAct(() => { btn.click() })
    await flush()
    assert.equal(killed, true, 'kill executed after proper enablement')

    await view.unmount()
  } finally {
    realClock()
  }
})

test('§5 Auto-relatch collapses after 6s of inactivity', async () => {
  useFakeClock()
  try {
    const view = await mountView(
      <KillSwitch slug="test-org" toast={() => {}} />,
      (el) => el,
    )
    const btn = view.el.querySelector<HTMLButtonElement>('.kill-btn')!
    const latch = view.el.querySelector<HTMLButtonElement>('.kill-latch')!

    // Unlatch
    await inAct(() => { latch.click() })
    await flush()
    await advance(500)
    assert.equal(btn.disabled, false)
    assert.ok(latch.classList.contains('open'))

    // Advance 5500ms (total 6000ms)
    await advance(5500)

    // Auto-relatched
    assert.ok(!latch.classList.contains('open'), 'latch auto-closed after 6s')
    assert.ok(btn.classList.contains('collapsed'), 'button collapsed after auto-relatch')
    assert.equal(btn.disabled, true)

    await view.unmount()
  } finally {
    realClock()
  }
})

test('§6 Mobile onKilled callback is fired', async () => {
  useFakeClock()
  try {
    let killedFired = false
    const view = await mountView(
      <KillSwitch
        slug="test-org"
        toast={() => {}}
        onKilled={() => { killedFired = true }}
        killFn={async () => ({ interrupted: ['agent-1'] })}
      />,
      (el) => el,
    )
    const btn = view.el.querySelector<HTMLButtonElement>('.kill-btn')!
    const latch = view.el.querySelector<HTMLButtonElement>('.kill-latch')!

    await inAct(() => { latch.click() })
    await advance(500)
    await inAct(() => { btn.click() })
    await flush()

    assert.equal(killedFired, true, 'onKilled callback was triggered')
    await view.unmount()
  } finally {
    realClock()
  }
})

test('§7 watchdogs_paused is formatted in toast when present', async () => {
  useFakeClock()
  try {
    const toasts: string[][] = []
    const view = await mountView(
      <KillSwitch
        slug="test-org"
        toast={(t) => { if (t) toasts.push(t) }}
        killFn={async () => ({
          interrupted: ['agent-1', 'agent-2', 'agent-3'],
          watchdogs_paused: [
            { id: 'w1', name: 'dog0', owner: 'boss' },
            { id: 'w2', name: 'dog1', owner: 'lead' },
          ],
        })}
      />,
      (el) => el,
    )
    const btn = view.el.querySelector<HTMLButtonElement>('.kill-btn')!
    const latch = view.el.querySelector<HTMLButtonElement>('.kill-latch')!

    await inAct(() => { latch.click() })
    await advance(500)
    await inAct(() => { btn.click() })
    await flush()

    assert.deepEqual(toasts, [['interrupted 3 agent(s); queues cleared · paused 2 watchdogs']])
    await view.unmount()
  } finally {
    realClock()
  }
})

