// datalocation.test.tsx — App settings -> Runtime -> Data location UI,
// non-empty subfolder preview, unticked-by-default delete checkbox, active-turn
// warning, preflight refusal banner, previous-folder cleanup, envOverride
// lock, and remote-org "This computer" scoping (4.6.0).
//
// Run: ORGTREE_TEST_DEPS=S:/orgtree/orgtree/package.json node apps/desktop/renderer/tests/run.mjs datalocation
import assert from 'node:assert/strict'
import test from 'node:test'
import type { TestContext } from 'node:test'
import type { ComponentType } from 'react'
import * as desktopSettingsMod from '../src/canvas/desktopsettings'
import { AccountsPanel } from '../src/canvas/accounts'
import { flush, inAct, mountView } from './harness'
import { remoteFeed, remoteView } from './remotefeed.fixture'

interface MockState {
  currentRoot: string
  defaultRoot: string
  isCustom: boolean
  envOverride: boolean
  previousRoot: string | null
  movedAt: string | null
  currentBytes: number | null
  previousBytes: number | null
  moving: boolean
}

interface MockPreflight {
  ok: boolean
  cancelled?: boolean
  pickedPath: string
  resolvedRoot: string
  usedSubfolder: boolean
  sourceBytes: number
  freeBytes: number | null
  activeAgents: number
  error?: string
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

async function click(el: HTMLElement) {
  await inAct(async () => {
    el.click()
    await flush(5)
  })
}

function installSettingsFetch(t: TestContext, remote = false) {
  const feed = remoteFeed(t, async url => {
    const u = new URL(url, 'http://127.0.0.1')
    if (u.pathname === '/api/providers') {
      return jsonResponse({ providers: [], apikey_fallback: {}, subscription_inference: {} })
    }
    if (u.pathname === '/api/runtime-settings') {
      return jsonResponse({
        max_concurrent_turns: 4,
        warming_enabled: true,
        working_checkups_enabled: true,
        project_listener_wake_enabled: true,
        credit_bubble_hire_enabled: true,
        credit_bubble_alloc_enabled: true,
        suggest_agent_feedback_enabled: true,
      })
    }
    if (u.pathname === '/api/accounts') return jsonResponse({ accounts: [], host_identity: {} })
    if (u.pathname === '/api/app-settings/charter-template-dirs') {
      return jsonResponse({ dirs: [], directories: [], duplicates: [] })
    }
    if (u.pathname === '/api/templates') return jsonResponse({ templates: [] })
    if (u.pathname === '/api/app-instructions') return jsonResponse({ text: '' })
    if (u.pathname === '/api/remote-access') return jsonResponse({ listening: false })
    if (u.pathname === '/api/version') return jsonResponse({ version: '4.6.0-alpha.3' })
    return jsonResponse({ ok: true })
  })
  return {
    ready: () => feed.remotes([remoteView()], remote ? remoteView() : undefined),
  }
}

function installDesktopBridge(
  t: TestContext,
  initialState: MockState,
  handlers: {
    choose?: (defaultPath?: string | null, popoutName?: string | null) => Promise<string | null>
    preflight?: (candidatePath: string) => Promise<MockPreflight>
    cancelPreflight?: () => Promise<{ ok: boolean }>
    measureSizes?: () => Promise<{
      currentRoot: string
      currentBytes: number | null
      previousRoot: string | null
      previousBytes: number | null
    }>
    move?: (opts: { targetPath: string; deletePrevious: boolean }) => Promise<{
      ok: boolean
      cancelled?: boolean
      error?: string
      relaunching?: boolean
    }>
    deletePrevious?: () => Promise<{ ok: boolean; error?: string }>
    openFolder?: (which: 'current' | 'previous') => Promise<{ ok: boolean; error?: string }>
  } = {},
) {
  const win = window as unknown as { orgtreeDesktop?: unknown }
  const prev = win.orgtreeDesktop
  let currentState = { ...initialState }
  const listeners = new Set<(event: { type: string; data: unknown }) => void>()
  const calls = {
    openFolder: [] as ('current' | 'previous')[],
    choose: [] as [string | null | undefined, string | null | undefined][],
    preflight: [] as string[],
    cancelPreflight: 0,
    measureSizes: 0,
    move: [] as { targetPath: string; deletePrevious: boolean }[],
    deletePrevious: 0,
  }

  win.orgtreeDesktop = {
    getStartupKind: async () => 'boot',
    getPreferences: async () => ({
      startAtLogin: true,
      exitOnClose: false,
      automaticUpdates: true,
      notificationsEnabled: true,
      questionTarget: 'desk',
    }),
    setPreferences: async (patch: Record<string, unknown>) => patch,
    getUpdateCapability: async () => ({ unattendedInstall: true, installDirectory: 'C:\\Program Files\\Orgtree' }),
    getRunAsAdministrator: async () => ({ enabled: false, available: true }),
    setRunAsAdministrator: async (enabled: boolean) => ({ enabled, available: true }),
    onEvent: (listener: (event: { type: string; data: unknown }) => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    getDataLocationState: async () => ({ ...currentState }),
    measureDataLocationSizes: async () => {
      calls.measureSizes += 1
      if (handlers.measureSizes) return handlers.measureSizes()
      return {
        currentRoot: currentState.currentRoot,
        currentBytes: currentState.currentBytes,
        previousRoot: currentState.previousRoot,
        previousBytes: currentState.previousBytes,
      }
    },
    openDataLocationFolder: async (which: 'current' | 'previous') => {
      calls.openFolder.push(which)
      return handlers.openFolder ? handlers.openFolder(which) : { ok: true }
    },
    chooseDataLocation: async (defaultPath?: string | null, popoutName?: string | null) => {
      calls.choose.push([defaultPath, popoutName])
      return handlers.choose ? handlers.choose(defaultPath, popoutName) : null
    },
    preflightDataLocation: async (candidatePath: string) => {
      calls.preflight.push(candidatePath)
      if (handlers.preflight) return handlers.preflight(candidatePath)
      return {
        ok: true,
        pickedPath: candidatePath,
        resolvedRoot: candidatePath,
        usedSubfolder: false,
        sourceBytes: currentState.currentBytes ?? 0,
        freeBytes: 80 * 1024 ** 3,
        activeAgents: 0,
      }
    },
    cancelDataLocationPreflight: async () => {
      calls.cancelPreflight += 1
      return handlers.cancelPreflight ? handlers.cancelPreflight() : { ok: true }
    },
    moveDataLocation: async (opts: { targetPath: string; deletePrevious: boolean }) => {
      calls.move.push(opts)
      if (handlers.move) return handlers.move(opts)
      return { ok: true, relaunching: true }
    },
    cancelDataLocationMove: async () => ({ ok: true }),
    deletePreviousDataLocation: async () => {
      calls.deletePrevious += 1
      const res = handlers.deletePrevious ? await handlers.deletePrevious() : { ok: true }
      if (res.ok) {
        currentState = { ...currentState, previousRoot: null, previousBytes: null }
      }
      return res
    },
  }

  t.after(() => {
    if (prev === undefined) delete win.orgtreeDesktop
    else win.orgtreeDesktop = prev
  })

  return {
    calls,
    emitEvent(event: { type: string; data: unknown }) {
      for (const listener of listeners) listener(event)
    },
    setState(patch: Partial<MockState>) {
      currentState = { ...currentState, ...patch }
    },
  }
}

function getDataLocationComponent(): ComponentType {
  const comp = (desktopSettingsMod as Record<string, unknown>).DataLocationSetting
  assert.equal(
    typeof comp,
    'function',
    'DataLocationSetting must be exported from apps/desktop/renderer/src/canvas/desktopsettings.tsx',
  )
  return comp as ComponentType
}

test('Runtime tab renders Data location inside "This computer" on local and remote-org windows with streamer-safe path markup', async t => {
  const env = installSettingsFetch(t, true)
  const mock = installDesktopBridge(t, {
    currentRoot: 'C:\\Users\\operator\\AppData\\Roaming\\Orgtree v2\\data',
    defaultRoot: 'C:\\Users\\operator\\AppData\\Roaming\\Orgtree v2\\data',
    isCustom: false,
    envOverride: false,
    previousRoot: null,
    movedAt: null,
    currentBytes: 512 * 1024 ** 2,
    previousBytes: null,
    moving: false,
  })

  const view = await mountView(
    <AccountsPanel toast={() => {}} close={() => {}} initialTab="runtime" />,
    el => el,
  )
  t.after(() => view.unmount())
  await env.ready()
  await inAct(async () => { await flush(5) })

  const runtimePanel = document.getElementById('app-settings-panel-runtime')
  assert.ok(runtimePanel, 'Runtime tab panel mounted')

  const hereGroup = runtimePanel.querySelector<HTMLElement>('.settings-here[aria-label="This computer"]')
  assert.ok(hereGroup, 'This computer wrapper present on remote-org Runtime tab')
  const groupHeads = [...hereGroup.querySelectorAll('.set-group-head')].map(el => el.textContent?.trim())
  assert.ok(
    groupHeads.includes('Data location'),
    `Runtime "This computer" section must include Data location; got ${JSON.stringify(groupHeads)}`,
  )

  const row = hereGroup.querySelector<HTMLElement>('[data-settings-field="data-location"]')
  assert.ok(row, 'Current folder row carries field="data-location"')
  const pathSpan = row.querySelector('[data-streamer-field="path"]')
  assert.equal(pathSpan?.textContent, 'C:\\Users\\operator\\AppData\\Roaming\\Orgtree v2\\data')
  assert.match(row.textContent ?? '', /Default location · 512\.0 MB/)

  const openBtn = [...row.querySelectorAll<HTMLButtonElement>('button')]
    .find(b => b.textContent === 'Open folder')
  assert.ok(openBtn)
  await click(openBtn)
  assert.deepEqual(mock.calls.openFolder, ['current'])
})

test('Move dialog explains "Orgtree data" subfolder for non-empty folder, warns on active turns, and keeps delete checkbox unticked by default', async t => {
  const DataLocationSetting = getDataLocationComponent()
  const mock = installDesktopBridge(
    t,
    {
      currentRoot: 'C:\\Users\\operator\\AppData\\Roaming\\Orgtree v2\\data',
      defaultRoot: 'C:\\Users\\operator\\AppData\\Roaming\\Orgtree v2\\data',
      isCustom: false,
      envOverride: false,
      previousRoot: null,
      movedAt: null,
      currentBytes: 2.5 * 1024 ** 3,
      previousBytes: null,
      moving: false,
    },
    {
      choose: async () => 'S:\\',
      preflight: async picked => ({
        ok: true,
        pickedPath: picked,
        resolvedRoot: 'S:\\Orgtree data',
        usedSubfolder: true,
        sourceBytes: 2.5 * 1024 ** 3,
        freeBytes: 120 * 1024 ** 3,
        activeAgents: 3,
      }),
    },
  )

  const view = await mountView(<DataLocationSetting />, el => el)
  t.after(() => view.unmount())
  await inAct(async () => { await flush(5) })

  const changeBtn = [...document.querySelectorAll<HTMLButtonElement>('button')]
    .find(b => b.textContent === 'Change location…')
  assert.ok(changeBtn, 'Change location… button present')
  await click(changeBtn)

  const dialog = document.querySelector<HTMLElement>('.move-data-dialog')
  assert.ok(dialog, 'Move data folder confirmation dialog opened')
  assert.match(dialog.textContent ?? '', /S:\\Orgtree data/)
  assert.match(dialog.textContent ?? '', /is not empty, Orgtree will create and use/)
  assert.match(dialog.textContent ?? '', /3 agent turns are running and will be stopped before copying\./)

  const checkbox = dialog.querySelector<HTMLInputElement>('.dataloc-check input[type="checkbox"]')
  assert.ok(checkbox, 'Delete-previous checkbox present')
  assert.equal(checkbox.checked, false, 'Delete checkbox MUST be unticked by default (user ruling Q4)')
  assert.match(
    dialog.querySelector('.dataloc-check')?.textContent ?? '',
    /Delete the old folder once the new location starts cleanly/,
  )

  const moveBtn = [...dialog.querySelectorAll<HTMLButtonElement>('button')]
    .find(b => b.textContent === 'Stop turns and move')
  assert.ok(moveBtn, 'Primary button reads "Stop turns and move" when activeAgents > 0')

  // Submitting unticked passes deletePrevious: false.
  await click(moveBtn)
  assert.deepEqual(mock.calls.move, [{ targetPath: 'S:\\', deletePrevious: false }])

  // Reopen, tick the checkbox, and verify deletePrevious: true is sent.
  await click(changeBtn)
  const dialog2 = document.querySelector<HTMLElement>('.move-data-dialog')!
  const checkbox2 = dialog2.querySelector<HTMLInputElement>('.dataloc-check input[type="checkbox"]')!
  assert.equal(checkbox2.checked, false, 'Reopening resets delete checkbox to unticked')
  await click(checkbox2)
  assert.equal(checkbox2.checked, true)
  const moveBtn2 = [...dialog2.querySelectorAll<HTMLButtonElement>('button')]
    .find(b => b.textContent === 'Stop turns and move')!
  await click(moveBtn2)
  assert.deepEqual(mock.calls.move[1], { targetPath: 'S:\\', deletePrevious: true })
})

test('Custom location offers "Use default location…", shows "Delete previous folder (<size>)" without unsolicited prompts, surfaces preflight errors, and locks under ORGTREE_V2_DATA', async t => {
  const DataLocationSetting = getDataLocationComponent()
  const mock = installDesktopBridge(
    t,
    {
      currentRoot: 'S:\\Orgtree data',
      defaultRoot: 'C:\\Users\\operator\\AppData\\Roaming\\Orgtree v2\\data',
      isCustom: true,
      envOverride: false,
      previousRoot: 'C:\\Users\\operator\\AppData\\Roaming\\Orgtree v2\\data',
      movedAt: '2026-11-14T09:00:00Z',
      currentBytes: 1.5 * 1024 ** 3,
      previousBytes: 1.25 * 1024 ** 3,
      moving: false,
    },
    {
      choose: async () => 'E:\\SharedUnsafe',
      preflight: async candidate => {
        if (candidate === 'E:\\SharedUnsafe') {
          return {
            ok: false,
            pickedPath: candidate,
            resolvedRoot: candidate,
            usedSubfolder: false,
            sourceBytes: 1.5 * 1024 ** 3,
            freeBytes: 50 * 1024 ** 3,
            activeAgents: 0,
            error: 'Another account or group on this PC has write access to E:\\SharedUnsafe.',
          }
        }
        return {
          ok: true,
          pickedPath: candidate,
          resolvedRoot: candidate,
          usedSubfolder: false,
          sourceBytes: 1.5 * 1024 ** 3,
          freeBytes: 40 * 1024 ** 3,
          activeAgents: 0,
        }
      },
    },
  )

  const view = await mountView(<DataLocationSetting />, el => el)
  t.after(() => view.unmount())
  await inAct(async () => { await flush(5) })

  // No unsolicited post-reopen dialog is shown on mount (user ruling Q4).
  assert.equal(document.querySelector('.move-data-dialog'), null)

  // Preflight refusal displays inline alert without opening move dialog.
  const changeBtn = [...document.querySelectorAll<HTMLButtonElement>('button')]
    .find(b => b.textContent === 'Change location…')!
  await click(changeBtn)
  assert.equal(document.querySelector('.move-data-dialog'), null)
  assert.match(document.querySelector('[role="alert"]')?.textContent ?? '', /write access to E:\\SharedUnsafe/)

  // "Delete previous folder (1.25 GB)" button opens confirmation and removes previous folder.
  const delPrevBtn = [...document.querySelectorAll<HTMLButtonElement>('button')]
    .find(b => b.textContent === 'Delete previous folder (1.25 GB)')
  assert.ok(delPrevBtn, 'Delete previous folder (<size>) button rendered')
  await click(delPrevBtn)
  const confirmDialog = document.querySelector<HTMLElement>('.move-data-dialog')
  assert.ok(confirmDialog, 'Delete previous folder confirmation dialog opened')
  const confirmBtn = [...confirmDialog.querySelectorAll<HTMLButtonElement>('button')]
    .find(b => b.textContent === 'Delete previous folder (1.25 GB)')!
  await click(confirmBtn)
  assert.equal(mock.calls.deletePrevious, 1)
  assert.equal(document.querySelector('[data-settings-field="data-location-previous"]'), null)

  // "Use default location…" opens move dialog targeting defaultRoot with "Move data" button.
  const useDefaultBtn = [...document.querySelectorAll<HTMLButtonElement>('button')]
    .find(b => b.textContent === 'Use default location…')
  assert.ok(useDefaultBtn, 'Use default location… button rendered for custom location')
  await click(useDefaultBtn)
  const backDialog = document.querySelector<HTMLElement>('.move-data-dialog')
  assert.ok(backDialog)
  assert.ok(
    [...backDialog.querySelectorAll<HTMLButtonElement>('button')].some(b => b.textContent === 'Move data'),
    'Primary button reads "Move data" when activeAgents === 0',
  )
  await view.unmount()

  // Under ORGTREE_V2_DATA envOverride, Change location… is disabled and Use default location… is hidden.
  mock.setState({ envOverride: true })
  const viewEnv = await mountView(<DataLocationSetting />, el => el)
  t.after(() => viewEnv.unmount())
  await inAct(async () => { await flush(5) })
  const envChangeBtn = [...document.querySelectorAll<HTMLButtonElement>('button')]
    .find(b => b.textContent === 'Change location…')!
  assert.equal(envChangeBtn.disabled, true)
  assert.equal(
    [...document.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === 'Use default location…'),
    undefined,
  )
  assert.match(document.body.textContent ?? '', /ORGTREE_V2_DATA/)
})

test('DataLocationSetting renders paths and enables buttons immediately with "Measuring size…" while measurement is pending, updates when resolved, and lets the user cancel a slow preflight', async t => {
  const DataLocationSetting = getDataLocationComponent()
  let resolveMeasure!: (res: {
    currentRoot: string
    currentBytes: number | null
    previousRoot: string | null
    previousBytes: number | null
  }) => void
  let resolvePreflight!: (pf: MockPreflight) => void

  const mock = installDesktopBridge(
    t,
    {
      currentRoot: 'S:\\Orgtree data',
      defaultRoot: 'C:\\Users\\operator\\AppData\\Roaming\\Orgtree v2\\data',
      isCustom: true,
      envOverride: false,
      previousRoot: 'C:\\Users\\operator\\AppData\\Roaming\\Orgtree v2\\data',
      movedAt: '2026-11-14T09:00:00Z',
      currentBytes: null,
      previousBytes: null,
      moving: false,
    },
    {
      measureSizes: () =>
        new Promise(resolve => {
          resolveMeasure = resolve
        }),
      preflight: () =>
        new Promise(resolve => {
          resolvePreflight = resolve
        }),
      cancelPreflight: async () => {
        resolvePreflight?.({
          ok: false,
          cancelled: true,
          pickedPath: 'C:\\Users\\operator\\AppData\\Roaming\\Orgtree v2\\data',
          resolvedRoot: 'C:\\Users\\operator\\AppData\\Roaming\\Orgtree v2\\data',
          usedSubfolder: false,
          sourceBytes: 0,
          freeBytes: null,
          activeAgents: 0,
        })
        return { ok: true }
      },
    },
  )

  const view = await mountView(<DataLocationSetting />, el => el)
  t.after(() => view.unmount())
  await inAct(async () => { await flush(5) })

  // 1. Paths and "Measuring size…" appear immediately while background measurement is still unresolved.
  const currentRow = document.querySelector<HTMLElement>('[data-settings-field="data-location"]')
  const prevRow = document.querySelector<HTMLElement>('[data-settings-field="data-location-previous"]')
  assert.ok(currentRow, 'Current folder row rendered immediately')
  assert.ok(prevRow, 'Previous folder row rendered immediately')
  assert.equal(currentRow.querySelector('[data-streamer-field="path"]')?.textContent, 'S:\\Orgtree data')
  assert.equal(
    prevRow.querySelector('[data-streamer-field="path"]')?.textContent,
    'C:\\Users\\operator\\AppData\\Roaming\\Orgtree v2\\data',
  )
  assert.match(currentRow.textContent ?? '', /Custom location · Measuring size…/)
  assert.match(prevRow.textContent ?? '', /Measuring size…/)
  assert.equal(mock.calls.measureSizes, 1, 'Background size measurement kicked off once on mount')

  // 2. Every action button is enabled immediately — none waits on directory size measurement.
  const openCurrentBtn = [...currentRow.querySelectorAll<HTMLButtonElement>('button')]
    .find(b => b.textContent === 'Open folder')
  const changeBtn = [...currentRow.querySelectorAll<HTMLButtonElement>('button')]
    .find(b => b.textContent === 'Change location…')
  const useDefaultBtn = [...currentRow.querySelectorAll<HTMLButtonElement>('button')]
    .find(b => b.textContent === 'Use default location…')
  const openPrevBtn = [...prevRow.querySelectorAll<HTMLButtonElement>('button')]
    .find(b => b.textContent === 'Open folder')
  const delPrevBtn = [...prevRow.querySelectorAll<HTMLButtonElement>('button')]
    .find(b => b.textContent === 'Delete previous folder')

  assert.ok(openCurrentBtn && !openCurrentBtn.disabled, 'Open folder (current) enabled while size pending')
  assert.ok(changeBtn && !changeBtn.disabled, 'Change location… enabled while size pending')
  assert.ok(useDefaultBtn && !useDefaultBtn.disabled, 'Use default location… enabled while size pending')
  assert.ok(openPrevBtn && !openPrevBtn.disabled, 'Open folder (previous) enabled while size pending')
  assert.ok(delPrevBtn && !delPrevBtn.disabled, 'Delete previous folder enabled while size pending')

  await click(openCurrentBtn)
  assert.deepEqual(mock.calls.openFolder, ['current'])

  // 3. Resolving background measurement replaces "Measuring size…" with formatted sizes.
  await inAct(async () => {
    resolveMeasure({
      currentRoot: 'S:\\Orgtree data',
      currentBytes: 3.5 * 1024 ** 3,
      previousRoot: 'C:\\Users\\operator\\AppData\\Roaming\\Orgtree v2\\data',
      previousBytes: 1.25 * 1024 ** 3,
    })
    await flush(5)
  })
  assert.doesNotMatch(currentRow.textContent ?? '', /Measuring size…/)
  assert.match(currentRow.textContent ?? '', /Custom location · 3\.50 GB/)
  assert.ok(
    [...prevRow.querySelectorAll<HTMLButtonElement>('button')]
      .some(b => b.textContent === 'Delete previous folder (1.25 GB)'),
  )

  // 4. Starting a slow preflight shows live scan progress and an enabled Cancel button that aborts immediately.
  await inAct(async () => {
    useDefaultBtn.click()
    await flush(3)
  })
  assert.ok(
    [...currentRow.querySelectorAll<HTMLButtonElement>('button')].some(b => b.textContent === 'Checking…' && b.disabled),
  )
  await inAct(async () => {
    mock.emitEvent({
      type: 'data-location-progress',
      data: {
        phase: 'checking',
        filesCopied: 250000,
        totalFiles: 250000,
        bytesCopied: 4 * 1024 ** 3,
        totalBytes: 0,
        cancellable: true,
        detail: 'Measuring current data folder… (250,000 files · 4.00 GB)',
      },
    })
    await flush(3)
  })
  assert.match(document.body.textContent ?? '', /250,000 files/)
  const cancelCheckBtn = [...currentRow.querySelectorAll<HTMLButtonElement>('button')]
    .find(b => b.textContent === 'Cancel')
  assert.ok(cancelCheckBtn && !cancelCheckBtn.disabled, 'Cancel button enabled while preflight scan is running')
  await click(cancelCheckBtn)
  assert.equal(mock.calls.cancelPreflight, 1)
  assert.equal(document.querySelector('.move-data-dialog'), null)
  const restoredChangeBtn = [...currentRow.querySelectorAll<HTMLButtonElement>('button')]
    .find(b => b.textContent === 'Change location…')
  assert.ok(restoredChangeBtn && !restoredChangeBtn.disabled, 'Change location… re-enabled after preflight cancel')
})

