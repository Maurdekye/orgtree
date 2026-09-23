import './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import CrashBoundary from '../src/CrashBoundary'
import { WindowControls } from '../src/window-controls'
import type { DesktopBridge, DesktopControlsState, DesktopEvent } from '../../../../packages/contracts'

function setupDesktopBridge(initialMaximized = false) {
  const calls: string[] = []
  const listeners = new Set<(event: DesktopEvent) => void>()
  let currentMaximized = initialMaximized

  const bridge: Partial<DesktopBridge> = {
    getWindowControlsState: async () => ({
      visible: true,
      restoreWindows: true,
      minimized: false,
      maximized: currentMaximized,
    }),
    onEvent: (listener: (event: DesktopEvent) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    minimizeWindow: async () => { calls.push('minimize') },
    toggleMaximizeWindow: async () => {
      currentMaximized = !currentMaximized
      calls.push('toggle-maximize')
      for (const l of listeners) {
        l({
          type: 'window-state',
          data: { visible: true, restoreWindows: true, minimized: false, maximized: currentMaximized } as DesktopControlsState,
        })
      }
    },
    closeWindow: async () => { calls.push('close') },
  }

  ;(window as unknown as { orgtreeDesktop?: typeof bridge }).orgtreeDesktop = bridge as DesktopBridge
  return {
    calls,
    listeners,
    setMaximized(maximized: boolean) {
      currentMaximized = maximized
      for (const l of listeners) {
        l({
          type: 'window-state',
          data: { visible: true, restoreWindows: true, minimized: false, maximized: currentMaximized } as DesktopControlsState,
        })
      }
    },
    cleanup() {
      delete (window as unknown as { orgtreeDesktop?: typeof bridge }).orgtreeDesktop
    },
  }
}

function CrashingChild({ shouldThrow }: { shouldThrow: boolean }) {
  if (shouldThrow) {
    throw new Error('deliberate-renderer-crash-message')
  }
  return <div data-testid="healthy-child">Healthy Child View</div>
}

/** The pre-fix error boundary mutation that replaced page content with only the error fallback. */
class MutatedBrokenCrashBoundary extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  state = { error: null }
  static getDerivedStateFromError(error: Error) { return { error } }
  render() {
    if (this.state.error) {
      return (
        <div data-testid="crash-fallback">
          <h2>Orgtree hit a problem and had to stop.</h2>
        </div>
      )
    }
    return this.props.children
  }
}

test('CrashBoundary renders persistent window controls shell outside replaceable error region', async () => {
  const bridge = setupDesktopBridge(false)
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const originalError = console.error
  console.error = () => {}

  try {
    await act(async () => {
      root.render(
        <CrashBoundary>
          <CrashingChild shouldThrow={true} />
        </CrashBoundary>,
      )
    })

    // Fallback error region is present with error details
    const fallback = document.querySelector('[data-testid="crash-fallback"]')
    assert.ok(fallback, 'crash fallback content is present')
    assert.match(fallback.textContent ?? '', /deliberate-renderer-crash-message/)

    // Window controls header is rendered outside and above the fallback
    const header = document.querySelector('.orgbar.fallback-orgbar.native-header')
    assert.ok(header, 'persistent fallback-orgbar native-header is rendered')
    assert.match(header.querySelector('h2')?.textContent ?? '', /Orgtree/)

    const controls = document.querySelector('.window-controls')
    assert.ok(controls, 'window controls group is rendered')
    assert.equal(controls.getAttribute('role'), 'group')

    // Close, minimize, maximize/restore, and refresh remain visible
    const refreshBtn = document.querySelector('[aria-label="Refresh app view"]') as HTMLButtonElement | null
    const minBtn = document.querySelector('[aria-label="Minimize window"]') as HTMLButtonElement | null
    const maxBtn = document.querySelector('[aria-label="Maximize window"]') as HTMLButtonElement | null
    const closeBtn = document.querySelector('[aria-label="Close window"]') as HTMLButtonElement | null

    assert.ok(refreshBtn, 'refresh control is present')
    assert.ok(minBtn, 'minimize control is present')
    assert.ok(maxBtn, 'maximize control is present')
    assert.ok(closeBtn, 'close control is present')

    // Normal actions are wired through the desktop bridge
    await act(async () => { minBtn.click() })
    await act(async () => { maxBtn.click() })
    await act(async () => { closeBtn.click() })
    assert.deepEqual(bridge.calls, ['minimize', 'toggle-maximize', 'close'])

    // Refresh ACTS too (review W1, 2026-09-20: presence alone proved nothing).
    // jsdom's location.reload is non-configurable, so the click is proven at
    // the component's own seam: the same control the fallback renders fires
    // its refresh action when clicked — an unwired or inert button leaves the
    // counter at zero and fails here. The fallback's instance uses the
    // DEFAULT action, and tests/window-controls.test.mjs pins that default to
    // the renderer-local reload and pins CrashBoundary to the default.
    let refreshed = 0
    const seamContainer = document.createElement('div')
    document.body.appendChild(seamContainer)
    const seamRoot = createRoot(seamContainer)
    try {
      await act(async () => {
        seamRoot.render(<WindowControls onRefresh={() => { refreshed += 1 }} />)
      })
      const seamRefresh = seamContainer.querySelector('[aria-label="Refresh app view"]') as HTMLButtonElement | null
      assert.ok(seamRefresh, 'the control renders at the seam')
      await act(async () => { seamRefresh.click() })
      assert.equal(refreshed, 1, 'the refresh control fires its action when clicked')
    } finally {
      await act(async () => { seamRoot.unmount() })
      seamContainer.remove()
    }

    // Maximize/restore state tracking updates the control
    const restoreBtn = document.querySelector('[aria-label="Restore window"]') as HTMLButtonElement | null
    assert.ok(restoreBtn, 'maximize action flipped control to Restore window')

    await act(async () => { restoreBtn.click() })
    assert.ok(document.querySelector('[aria-label="Maximize window"]'), 'restore flipped back to Maximize window')
  } finally {
    console.error = originalError
    await act(async () => { root.unmount() })
    container.remove()
    bridge.cleanup()
  }
})

test('healthy content renders children without duplicate window controls', async () => {
  const bridge = setupDesktopBridge(false)
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)

  try {
    await act(async () => {
      root.render(
        <CrashBoundary>
          <CrashingChild shouldThrow={false} />
        </CrashBoundary>,
      )
    })

    assert.ok(document.querySelector('[data-testid="healthy-child"]'), 'healthy content is rendered')
    assert.equal(document.querySelector('[data-testid="crash-fallback"]'), null, 'no crash fallback on healthy content')
    assert.equal(document.querySelectorAll('.window-controls').length, 0, 'CrashBoundary does not inject duplicate controls when healthy')
  } finally {
    await act(async () => { root.unmount() })
    container.remove()
    bridge.cleanup()
  }
})

test('mutation proof: an error boundary that omits window controls fails the regression test', async () => {
  const bridge = setupDesktopBridge(false)
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const originalError = console.error
  console.error = () => {}

  try {
    await act(async () => {
      root.render(
        <MutatedBrokenCrashBoundary>
          <CrashingChild shouldThrow={true} />
        </MutatedBrokenCrashBoundary>,
      )
    })

    // The mutated boundary renders the fallback but fails to provide window controls
    assert.ok(document.querySelector('[data-testid="crash-fallback"]'))
    const controls = document.querySelector('.window-controls')
    assert.equal(controls, null, 'mutated boundary produces no window controls')
    // A test expecting controls would fail here, proving the regression test is sensitive!
    assert.throws(() => {
      assert.ok(controls, 'controls must remain present')
    }, /controls must remain present/)
  } finally {
    console.error = originalError
    await act(async () => { root.unmount() })
    container.remove()
    bridge.cleanup()
  }
})
