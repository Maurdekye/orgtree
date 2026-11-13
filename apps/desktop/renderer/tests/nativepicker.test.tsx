// nativepicker.test.tsx — Native OS folder picker for local organizations,
// custom /api/fs picker for remote organizations and surfaces without the
// desktop bridge (USER 2026-11-13 m365cee9110b5, m98bc74e8a3c7).
//
// Run: ORGTREE_TEST_DEPS=S:/orgtree/orgtree/package.json node apps/desktop/renderer/tests/run.mjs nativepicker
import assert from 'node:assert/strict'
import test from 'node:test'
import type { TestContext } from 'node:test'
import { useState } from 'react'
import { flush, inAct, mountView } from './harness'
import { remoteFeed, remoteView } from './remotefeed.fixture'
import { FolderPickerHost, pickFolder } from '../src/picker'
import { useRemoteHere } from '../src/remotehere'
import { noteActionDocument, registerWindow, resetActionDocument } from '../src/windowlife'
import { DraftScopeModal, HireDefaultsTab, NodeConfig } from '../src/canvas/modals'
import { CharterTemplateDirsSetting } from '../src/canvas/chartersettings'
import { AddAccountDialog } from '../src/canvas/accountsregistry'
import { CreateOrgView } from '../src/shell/createorg'
import { NewOrg } from '../src/App'
import { DirList } from '../src/forms'
import type { CanvasNode, DraftScope } from '../src/canvas/shared'
import type { DirGrant, TreePayload } from '../src/types'

function Here() {
  useRemoteHere()
  return null
}

type BridgeCall = { defaultPath: string | null | undefined; popoutName: string | null | undefined }

function installBridge(
  t: TestContext,
  reply: (defaultPath?: string | null, popoutName?: string | null) => Promise<string | null>,
) {
  const win = window as unknown as { orgtreeDesktop?: unknown }
  const prev = win.orgtreeDesktop
  const calls: BridgeCall[] = []
  win.orgtreeDesktop = {
    pickFolder: (defaultPath?: string | null, popoutName?: string | null) => {
      calls.push({ defaultPath, popoutName })
      return reply(defaultPath, popoutName)
    },
  }
  t.after(() => {
    if (prev === undefined) delete win.orgtreeDesktop
    else win.orgtreeDesktop = prev
  })
  return calls
}

function clearBridge(t: TestContext, bridgeValue: unknown = undefined) {
  const win = window as unknown as { orgtreeDesktop?: unknown }
  const prev = win.orgtreeDesktop
  if (bridgeValue === undefined) delete win.orgtreeDesktop
  else win.orgtreeDesktop = bridgeValue
  t.after(() => {
    if (prev === undefined) delete win.orgtreeDesktop
    else win.orgtreeDesktop = prev
  })
}

async function setInput(input: HTMLInputElement, value: string) {
  await inAct(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
    await flush()
  })
}

async function click(el: HTMLElement) {
  await inAct(async () => {
    el.click()
    await flush(4)
  })
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function installEnvironment(
  t: TestContext,
  opts: {
    remote?: boolean
    extraFetch?: (url: string, init?: RequestInit) => Promise<Response | null> | Response | null
  } = {},
) {
  const fsRequests: string[] = []
  const feed = remoteFeed(t, async (url, init) => {
    const u = new URL(url, 'http://127.0.0.1')
    if (u.pathname === '/api/fs') {
      fsRequests.push(url)
      return jsonResponse({
        path: opts.remote ? '/srv/galaxy/work' : 'S:\\fallback\\work',
        home: opts.remote ? '/srv/galaxy' : 'S:\\fallback',
        parent: opts.remote ? '/srv' : 'S:\\',
        dirs: [{ name: 'sub', path: opts.remote ? '/srv/galaxy/work/sub' : 'S:\\fallback\\work\\sub' }],
      })
    }
    const custom = await opts.extraFetch?.(url, init)
    if (custom) return custom
    if (u.pathname === '/api/accounts') return jsonResponse({ accounts: [], host_identity: {} })
    if (u.pathname.endsWith('/accounts')) return jsonResponse({ accounts: [] })
    if (u.pathname === '/api/mcp-servers') return jsonResponse({ servers: [], details: [] })
    if (u.pathname === '/api/hub/probe') return jsonResponse({ ok: false })
    if (u.pathname === '/api/templates') return jsonResponse({ templates: [] })
    if (u.pathname === '/api/app-settings/charter-template-dirs') {
      return jsonResponse({ dirs: [], duplicates: [] })
    }
    return jsonResponse({ ok: true, results: [{}], warnings: [] })
  })
  t.after(async () => {
    const overlay = document.querySelector<HTMLElement>('.picker-overlay')
    if (overlay) {
      await inAct(async () => {
        overlay.click()
        await flush(2)
      })
    }
    resetActionDocument()
  })
  return {
    fsRequests,
    ready: () => feed.remotes([remoteView()], opts.remote ? remoteView() : undefined),
  }
}

const baseTools = { bash: true, edit: true, web: false, subagents: false, mcp: [] as string[] }
const treeFixture: TreePayload = {
  slug: 'org',
  workspace: 'S:\\org\\workspace',
  dirs: [{ path: 'S:\\org\\existing', mode: 'ro' }],
  tiers: { sol: 1, opus: 5 },
  max_top_grant: 50,
  default_effort: '',
  effort_default: 'high',
  cascade_hire: true,
  default_tools: baseTools,
} as unknown as TreePayload

const agentFixture: CanvasNode = {
  id: 'worker-sol',
  kind: 'agent',
  state: 'live',
  tier: 'sol',
  generation: 1,
  parent: 'user',
  children: [],
  charter: 'Test agent',
  grant: 4,
  seat: 1,
  committed: 1,
  free: 3,
  scope: {
    add_dirs: [{ path: 'S:\\agent\\existing', mode: 'ro' }],
    tools: baseTools,
    org_visibility: 'team',
    permission_mode: 'acceptEdits',
  },
} as unknown as CanvasNode

test('pickFolder uses native dialog on local windows with bridge, custom /api/fs on remote windows and without bridge, and forwards popout frame name', async (t) => {
  const env = installEnvironment(t, { remote: false })
  let nextNative: string | null = 'S:\\native\\chosen'
  const calls = installBridge(t, async () => nextNative)

  const view = await mountView(<><Here /><FolderPickerHost /></>, (el) => el)
  t.after(() => view.unmount())
  await env.ready()

  let settledFirst: { path: string | null } | undefined
  await inAct(async () => {
    void pickFolder('S:\\seed\\current').then((r) => { settledFirst = r })
    await flush(4)
  })
  let result = settledFirst ?? { path: '__custom_picker_opened_instead_of_native__' }
  assert.deepEqual(result, { path: 'S:\\native\\chosen' })
  assert.equal(calls.length, 1)
  assert.equal(calls[0]!.defaultPath, 'S:\\seed\\current')
  assert.equal(calls[0]!.popoutName, null)
  assert.equal(env.fsRequests.length, 0, 'local native pick must not query /api/fs')
  assert.equal(document.querySelector('.picker-overlay'), null, 'custom picker overlay must not mount')

  // Cancel returns { path: null } without touching /api/fs.
  nextNative = null
  result = await pickFolder()
  assert.deepEqual(result, { path: null })
  assert.equal(calls.length, 2)
  assert.equal(env.fsRequests.length, 0)

  // Popped-out surface forwards its native popout frame name so dialog.showOpenDialog is modal to the popout.
  const popDoc = document.implementation.createHTMLDocument('popout')
  const fakePopWin = { closed: false, document: popDoc, name: 'orgtree-popout-42', focus() {}, close() {} } as unknown as Window
  Object.defineProperty(popDoc, 'defaultView', { value: fakePopWin, configurable: true })
  const unregister = registerWindow({
    id: 'node-config:1',
    kind: 'node-config:worker-sol',
    name: 'orgtree-popout-42',
    org: 'org',
    editable: true,
    window: fakePopWin,
    redock: () => {},
  })
  t.after(unregister)
  noteActionDocument(popDoc)
  nextNative = 'S:\\native\\from-popout'
  result = await pickFolder('S:\\popout\\seed')
  resetActionDocument()
  assert.deepEqual(result, { path: 'S:\\native\\from-popout' })
  assert.equal(calls.length, 3)
  assert.equal(calls[2]!.defaultPath, 'S:\\popout\\seed')
  assert.equal(calls[2]!.popoutName, 'orgtree-popout-42')
})

test('pickFolder keeps custom /api/fs picker on remote org windows and when native bridge is absent or refuses as remote', async (t) => {
  // 1. Remote org window with desktop bridge present -> custom /api/fs picker opens, bridge.pickFolder never called.
  {
    const env = installEnvironment(t, { remote: true })
    const calls = installBridge(t, async () => 'S:\\wrong\\local-disk')
    const view = await mountView(<><Here /><FolderPickerHost /></>, (el) => el)
    t.after(() => view.unmount())
    await env.ready()

    let settled: { path: string | null } | undefined
    await inAct(async () => {
      void pickFolder('/srv/galaxy/current').then((r) => { settled = r })
      await flush(4)
    })
    assert.equal(calls.length, 0, 'remote org window must never invoke local native folder dialog')
    assert.ok(env.fsRequests.length >= 1, 'remote org window uses /api/fs')
    assert.equal(document.querySelector('.picker h3')?.textContent?.trim(), 'choose a folder on Galaxy')
    const selectBtn = [...document.querySelectorAll<HTMLButtonElement>('.picker button')]
      .find((b) => b.textContent === 'select this folder')!
    await click(selectBtn)
    assert.deepEqual(settled, { path: '/srv/galaxy/work' })
    await view.unmount()
  }

  // 2. Local org window WITHOUT desktop bridge (plain browser / viewer) -> custom /api/fs picker opens.
  {
    const env = installEnvironment(t, { remote: false })
    clearBridge(t, undefined)
    const view = await mountView(<><Here /><FolderPickerHost /></>, (el) => el)
    t.after(() => view.unmount())
    await env.ready()

    let settled: { path: string | null } | undefined
    await inAct(async () => {
      void pickFolder('S:\\browser\\seed').then((r) => { settled = r })
      await flush(4)
    })
    assert.ok(env.fsRequests.length >= 1, 'browser without native bridge uses /api/fs')
    assert.equal(document.querySelector('.picker h3')?.textContent?.trim(), 'choose a folder')
    const cancelBtn = [...document.querySelectorAll<HTMLButtonElement>('.picker button')]
      .find((b) => b.textContent === 'cancel')!
    await click(cancelBtn)
    assert.deepEqual(settled, { path: null })
    await view.unmount()
  }

  // 3. Cold-start race where main refuses as { remote: true } before appfeed remote_link arrives -> falls back to custom picker.
  {
    const env = installEnvironment(t, { remote: false })
    const calls = installBridge(t, async () => {
      throw Object.assign(new Error('Remote organization'), { remote: true })
    })
    const view = await mountView(<><Here /><FolderPickerHost /></>, (el) => el)
    t.after(() => view.unmount())
    await env.ready()

    let settled: { path: string | null } | undefined
    await inAct(async () => {
      void pickFolder().then((r) => { settled = r })
      await flush(4)
    })
    assert.equal(calls.length, 1)
    assert.ok(document.querySelector('.picker-overlay'), 'remote refusal from main falls back to custom /api/fs picker')
    const cancelBtn = [...document.querySelectorAll<HTMLButtonElement>('.picker button')]
      .find((b) => b.textContent === 'cancel')!
    await click(cancelBtn)
    assert.deepEqual(settled, { path: null })
    await view.unmount()
  }
})

test('NodeConfig (agent settings) Scope > Folders uses native picker on local org, passes current field path, preserves RW validation, and keeps custom picker on remote org', async (t) => {
  const savedScopes: Record<string, unknown>[] = []
  const env = installEnvironment(t, {
    remote: false,
    extraFetch: async (url, init) => {
      if (url.includes('/nodes/worker-sol/scope') && init?.method === 'POST') {
        savedScopes.push(JSON.parse(String(init.body)))
        return jsonResponse({ warnings: [] })
      }
      return null
    },
  })
  let nextNative: string | null = null
  const calls = installBridge(t, async () => nextNative)

  const view = await mountView(
    <>
      <Here />
      <FolderPickerHost />
      <NodeConfig
        node={agentFixture}
        map={new Map([[agentFixture.id, agentFixture]])}
        tree={treeFixture}
        slug="org"
        target={{ tab: 'scope', field: '', seq: 1 }}
        op={async () => ({})}
        toast={() => {}}
        close={() => {}}
      />
    </>,
    (el) => el,
  )
  t.after(() => view.unmount())
  await env.ready()

  const input = document.body.querySelector<HTMLInputElement>('input[placeholder="Add a folder path"]')!
  const browseBtn = document.body.querySelector<HTMLButtonElement>('button[title="Browse for a folder"]')!
  await setInput(input, 'S:\\agent\\typed-seed')

  // Cancel changes nothing.
  nextNative = null
  await click(browseBtn)
  assert.equal(calls.length, 1)
  assert.equal(calls[0]!.defaultPath, 'S:\\agent\\typed-seed')
  assert.equal(input.value, 'S:\\agent\\typed-seed')
  assert.equal(document.body.querySelectorAll('.dirlist .chip.mono').length, 1)

  // Picked folder adds RW chip and saves through scope endpoint unchanged.
  nextNative = 'S:\\agent\\picked-native'
  await click(browseBtn)
  assert.equal(calls.length, 2)
  const chips = [...document.body.querySelectorAll('.dirlist .chip.mono')].map((n) => n.textContent)
  assert.deepEqual(chips, ['S:\\agent\\existing', 'S:\\agent\\picked-native'])
  const saveBtn = [...document.body.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Save')!
  await click(saveBtn)
  assert.equal(savedScopes.length, 1)
  assert.deepEqual(savedScopes[0]!.add_dirs, [
    { path: 'S:\\agent\\existing', mode: 'ro' },
    { path: 'S:\\agent\\picked-native', mode: 'rw' },
  ])
  await view.unmount()

  // Remote org -> custom picker opens, zero native calls.
  const remoteEnv = installEnvironment(t, { remote: true })
  const remoteCalls = installBridge(t, async () => 'S:\\wrong')
  const remoteViewMount = await mountView(
    <>
      <Here />
      <FolderPickerHost />
      <NodeConfig
        node={agentFixture}
        map={new Map([[agentFixture.id, agentFixture]])}
        tree={treeFixture}
        slug="org"
        target={{ tab: 'scope', field: '', seq: 1 }}
        op={async () => ({})}
        toast={() => {}}
        close={() => {}}
      />
    </>,
    (el) => el,
  )
  t.after(() => remoteViewMount.unmount())
  await remoteEnv.ready()
  await click(document.body.querySelector<HTMLButtonElement>('button[title="Browse for a folder"]')!)
  assert.equal(remoteCalls.length, 0)
  assert.equal(document.querySelector('.picker h3')?.textContent?.trim(), 'choose a folder on Galaxy')
})

test('DraftScopeModal (hire dialog) Scope > Folders uses native picker on local org and custom picker on remote org', async (t) => {
  const saved: DraftScope[] = []
  const env = installEnvironment(t, { remote: false })
  let nextNative: string | null = null
  const calls = installBridge(t, async () => nextNative)

  const view = await mountView(
    <>
      <Here />
      <FolderPickerHost />
      <DraftScopeModal
        draft={{ parent: null, tier: 'sol' }}
        map={new Map()}
        tree={treeFixture}
        scope={null}
        accounts={[]}
        tab="scope"
        onSave={(s) => saved.push(s)}
        close={() => {}}
      />
    </>,
    (el) => el,
  )
  t.after(() => view.unmount())
  await env.ready()

  const input = document.body.querySelector<HTMLInputElement>('input[placeholder="Add a folder path"]')!
  const browseBtn = document.body.querySelector<HTMLButtonElement>('button[title="Browse for a folder"]')!
  await setInput(input, 'S:\\hire\\seed')

  // Cancel keeps existing inherited folder only.
  nextNative = null
  await click(browseBtn)
  assert.equal(calls.length, 1)
  assert.equal(calls[0]!.defaultPath, 'S:\\hire\\seed')
  assert.deepEqual(
    [...document.body.querySelectorAll('.dirlist .chip.mono')].map((n) => n.textContent),
    ['S:\\org\\existing'],
  )

  // Selection stages RW folder in DraftScopeModal.
  nextNative = 'S:\\hire\\picked'
  await click(browseBtn)
  assert.equal(calls.length, 2)
  assert.deepEqual(saved.at(-1)?.add_dirs, [
    { path: 'S:\\org\\existing', mode: 'ro' },
    { path: 'S:\\hire\\picked', mode: 'rw' },
  ])
  await view.unmount()

  // Remote org -> custom picker opens.
  const remoteEnv = installEnvironment(t, { remote: true })
  const remoteCalls = installBridge(t, async () => 'S:\\wrong')
  const remoteMount = await mountView(
    <>
      <Here />
      <FolderPickerHost />
      <DraftScopeModal
        draft={{ parent: null, tier: 'sol' }}
        map={new Map()}
        tree={treeFixture}
        scope={null}
        accounts={[]}
        tab="scope"
        onSave={() => {}}
        close={() => {}}
      />
    </>,
    (el) => el,
  )
  t.after(() => remoteMount.unmount())
  await remoteEnv.ready()
  await click(document.body.querySelector<HTMLButtonElement>('button[title="Browse for a folder"]')!)
  assert.equal(remoteCalls.length, 0)
  assert.equal(document.querySelector('.picker h3')?.textContent?.trim(), 'choose a folder on Galaxy')
})

test('HireDefaultsTab (Org settings > Org folders) uses native picker on local org and custom picker on remote org', async (t) => {
  const env = installEnvironment(t, { remote: false })
  let nextNative: string | null = null
  const calls = installBridge(t, async () => nextNative)

  function Host() {
    const [dirs, setDirs] = useState<DirGrant[]>([{ path: 'S:\\org\\initial', mode: 'ro' }])
    const [tools, setTools] = useState(baseTools)
    const [vis, setVis] = useState('full')
    const [pm, setPm] = useState('acceptEdits')
    const [acct, setAcct] = useState('')
    return (
      <>
        <Here />
        <FolderPickerHost />
        <HireDefaultsTab
          tree={treeFixture}
          slug="org"
          toast={() => {}}
          close={() => {}}
          tools={tools}
          setTools={setTools}
          vis={vis}
          setVis={setVis}
          pm={pm}
          setPm={setPm}
          dirs={dirs}
          setDirs={setDirs}
          servers={[]}
          account={acct}
          setAccount={setAcct}
          accounts={[]}
        />
      </>
    )
  }

  const view = await mountView(<Host />, (el) => el)
  t.after(() => view.unmount())
  await env.ready()

  const input = document.body.querySelector<HTMLInputElement>('input[aria-label="Add a folder path"]')!
  const browseBtn = document.body.querySelector<HTMLButtonElement>('button[title="Browse for a folder"]')!
  await setInput(input, 'S:\\org\\draft-seed')

  nextNative = null
  await click(browseBtn)
  assert.equal(calls.length, 1)
  assert.equal(calls[0]!.defaultPath, 'S:\\org\\draft-seed')
  assert.deepEqual(
    [...document.body.querySelectorAll('.dirlist .chip.mono')].map((n) => n.textContent),
    ['S:\\org\\workspace', 'S:\\org\\initial'],
  )

  nextNative = 'S:\\org\\added-native'
  await click(browseBtn)
  assert.deepEqual(
    [...document.body.querySelectorAll('.dirlist .chip.mono')].map((n) => n.textContent),
    ['S:\\org\\workspace', 'S:\\org\\initial', 'S:\\org\\added-native'],
  )
  await view.unmount()

  const remoteEnv = installEnvironment(t, { remote: true })
  const remoteCalls = installBridge(t, async () => 'S:\\wrong')
  const remoteMount = await mountView(<Host />, (el) => el)
  t.after(() => remoteMount.unmount())
  await remoteEnv.ready()
  await click(document.body.querySelector<HTMLButtonElement>('button[title="Browse for a folder"]')!)
  assert.equal(remoteCalls.length, 0)
  assert.equal(document.querySelector('.picker h3')?.textContent?.trim(), 'choose a folder on Galaxy')
})

test('CharterTemplateDirsSetting (App settings > Charters & templates) and AddAccountDialog (Import folder) use native picker on local window and custom picker on remote window', async (t) => {
  const savedTemplateDirs: string[][] = []
  const env = installEnvironment(t, {
    remote: false,
    extraFetch: async (url, init) => {
      if (url.endsWith('/api/app-settings/charter-template-dirs')) {
        if (init?.method === 'PUT') {
          const parsed = JSON.parse(String(init.body)) as { dirs: string[] }
          savedTemplateDirs.push(parsed.dirs)
          return jsonResponse({
            dirs: parsed.dirs,
            directories: parsed.dirs.map((path) => ({ path, status: 'ok', count: 2 })),
            duplicates: [],
          })
        }
        return jsonResponse({
          dirs: ['S:\\templates\\existing'],
          directories: [{ path: 'S:\\templates\\existing', status: 'ok', count: 1 }],
          duplicates: [],
        })
      }
      return null
    },
  })
  let nextNative: string | null = null
  const calls = installBridge(t, async () => nextNative)

  const view = await mountView(
    <>
      <Here />
      <FolderPickerHost />
      <CharterTemplateDirsSetting />
      <AddAccountDialog provider="claude" onAdded={async () => {}} close={() => {}} />
    </>,
    (el) => el,
  )
  t.after(() => view.unmount())
  await env.ready()
  await inAct(() => flush(4))

  // 1. CharterTemplateDirsSetting
  const charterInput = document.body.querySelector<HTMLInputElement>('input[aria-label="Add a charter template folder"]')!
  const charterBrowse = document.body.querySelector<HTMLButtonElement>('button[aria-label="Browse for a charter template folder"]')!
  await setInput(charterInput, 'S:\\templates\\seed')

  nextNative = null
  await click(charterBrowse)
  assert.equal(calls.length, 1)
  assert.equal(calls[0]!.defaultPath, 'S:\\templates\\seed')
  assert.equal(savedTemplateDirs.length, 0)

  nextNative = 'S:\\templates\\picked'
  await click(charterBrowse)
  assert.equal(calls.length, 2)
  assert.deepEqual(savedTemplateDirs, [['S:\\templates\\existing', 'S:\\templates\\picked']])

  // 2. AddAccountDialog ("Import a folder")
  const profileInput = document.body.querySelector<HTMLInputElement>('input[aria-label="Profile folder"]')!
  const accountBrowse = [...document.body.querySelectorAll<HTMLButtonElement>('button')]
    .find((b) => b.textContent === 'Browse...')!
  await setInput(profileInput, 'S:\\profiles\\claude-seed')

  nextNative = null
  await click(accountBrowse)
  assert.equal(calls.length, 3)
  assert.equal(calls[2]!.defaultPath, 'S:\\profiles\\claude-seed')
  assert.equal(profileInput.value, 'S:\\profiles\\claude-seed', 'cancel leaves profile folder unchanged')

  nextNative = 'S:\\profiles\\claude-imported'
  await click(accountBrowse)
  assert.equal(calls.length, 4)
  assert.equal(profileInput.value, 'S:\\profiles\\claude-imported')
  await view.unmount()

  // Remote window check for both surfaces
  const remoteEnv = installEnvironment(t, { remote: true })
  const remoteCalls = installBridge(t, async () => 'S:\\wrong')
  const remoteMount = await mountView(
    <>
      <Here />
      <FolderPickerHost />
      <CharterTemplateDirsSetting />
      <AddAccountDialog provider="claude" onAdded={async () => {}} close={() => {}} />
    </>,
    (el) => el,
  )
  t.after(() => remoteMount.unmount())
  await remoteEnv.ready()
  await inAct(() => flush(4))
  await click(document.body.querySelector<HTMLButtonElement>('button[aria-label="Browse for a charter template folder"]')!)
  assert.equal(remoteCalls.length, 0)
  assert.equal(document.querySelector('.picker h3')?.textContent?.trim(), 'choose a folder on Galaxy')
})

test('CreateOrgView, NewOrg and DirList use native picker on local windows, passing each row path as defaultPath and leaving values unchanged on cancel', async (t) => {
  const env = installEnvironment(t, { remote: false })
  let nextNative: string | null = null
  const calls = installBridge(t, async () => nextNative)

  const view = await mountView(
    <>
      <Here />
      <FolderPickerHost />
      <CreateOrgView onCreated={() => {}} onRequestClose={() => {}} />
    </>,
    (el) => el,
  )
  t.after(() => view.unmount())
  await env.ready()

  // Expand Advanced options in CreateOrgView.
  const advBtn = [...document.body.querySelectorAll<HTMLButtonElement>('button.disclosure')]
    .find((b) => b.textContent?.includes('Advanced options'))!
  await click(advBtn)

  const addBrowseBtn = document.body.querySelector<HTMLButtonElement>('button[title="Browse for a folder to add"]')!
  nextNative = null
  await click(addBrowseBtn)
  assert.equal(calls.length, 1)
  assert.equal(document.body.querySelectorAll('.shell-create-advanced .dirrow input').length, 0, 'cancel adds no row')

  nextNative = 'S:\\create\\row-one'
  await click(addBrowseBtn)
  assert.equal(calls.length, 2)
  let rowInputs = [...document.body.querySelectorAll<HTMLInputElement>('.shell-create-advanced .dirrow input')]
  assert.deepEqual(rowInputs.map((i) => i.value), ['S:\\create\\row-one'])

  // Per-row Browse passes that row's current folder as defaultPath.
  const rowBrowseBtn = document.body.querySelector<HTMLButtonElement>('.shell-create-advanced button[title="Browse for a folder"]')!
  nextNative = null
  await click(rowBrowseBtn)
  assert.equal(calls.length, 3)
  assert.equal(calls[2]!.defaultPath, 'S:\\create\\row-one')
  rowInputs = [...document.body.querySelectorAll<HTMLInputElement>('.shell-create-advanced .dirrow input')]
  assert.deepEqual(rowInputs.map((i) => i.value), ['S:\\create\\row-one'], 'cancel leaves row untouched')

  nextNative = 'S:\\create\\row-one-replaced'
  await click(rowBrowseBtn)
  rowInputs = [...document.body.querySelectorAll<HTMLInputElement>('.shell-create-advanced .dirrow input')]
  assert.deepEqual(rowInputs.map((i) => i.value), ['S:\\create\\row-one-replaced'])
  await view.unmount()

  // Also verify NewOrg (App.tsx AdvancedOrgModal > DirList) uses the same DirList native path.
  const newOrgMount = await mountView(
    <>
      <Here />
      <FolderPickerHost />
      <NewOrg onCreate={() => {}} />
    </>,
    (el) => el,
  )
  t.after(() => newOrgMount.unmount())
  await click([...document.body.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === '+ New organization')!)
  await click([...document.body.querySelectorAll<HTMLButtonElement>('button.disclosure')].find((b) => b.textContent?.includes('Advanced'))!)
  nextNative = 'S:\\neworg\\folder'
  await click(document.body.querySelector<HTMLButtonElement>('button[title="Browse for a folder to add"]')!)
  assert.equal(calls.length, 5)
  const modalInputs = [...document.body.querySelectorAll<HTMLInputElement>('.dirlist .dirrow input')]
  assert.deepEqual(modalInputs.map((i) => i.value), ['S:\\neworg\\folder'])

  // Standalone DirList component check without FolderPickerHost mounted.
  let latestDirs = ['S:\\standalone\\initial']
  function StandaloneDirList() {
    const [dirs, setDirs] = useState(latestDirs)
    return <DirList dirs={dirs} onChange={(next) => { latestDirs = next; setDirs(next) }} />
  }
  const standalone = await mountView(<StandaloneDirList />, (el) => el)
  t.after(() => standalone.unmount())
  nextNative = 'S:\\standalone\\updated'
  await click(standalone.el.querySelector<HTMLButtonElement>('button[title="Browse for a folder"]')!)
  assert.equal(calls.at(-1)?.defaultPath, 'S:\\standalone\\initial')
  assert.deepEqual(latestDirs, ['S:\\standalone\\updated'])
})
