// remotehere.test.tsx: in a window of an organization on a remote engine, the
// controls that would use THIS computer's disk or sign-in windows do not, and
// each says where the thing is (docs/rust-engine/remote-org.md, "What depends
// on the computer"). A local window is unchanged.
//
// Run:  node tests/run.mjs remotehere
import { flush, mountView } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { ProviderSignIn } from '../src/canvas/accounts'
import { localFileMenu } from '../src/canvas/localfile'
import { revealFileFromEvent } from '../src/canvas/shared'
import { ToolFilePath } from '../src/canvas/toolfilepath'
import type { NativeDesktop } from '../src/desktop'
import { localFolder, remoteHere, useRemoteHere } from '../src/remotehere'
import { scratchFolderAction } from '../src/scratch-folder'
import { remoteFeed, remoteView } from './remotefeed.fixture'

const FOLDER = 'This folder is on Galaxy, not on this computer.'
const FILE = 'This file is on Galaxy. Copy its path to find it there.'
const SIGN_IN = 'Sign in on Galaxy itself: this profile’s folder is /data/profiles/claude-2. See “Sign in to provider CLIs over SSH” in the standalone engine guide.'
const PATH = 'C:\\work\\report.txt'

/** The window keeps its own connection current, as App does. */
function Here() { useRemoteHere(); return null }

/** A desktop bridge that records every call that would touch this computer. */
function bridge(t: TestContext) {
  const calls: string[] = []
  const said = (name: string, answer: unknown) => async () => { calls.push(name); return answer }
  const value = {
    openAgentScratchFolder: said('openAgentScratchFolder', { ok: true }),
    openAgentScratchAgentsFile: said('openAgentScratchAgentsFile', { ok: true }),
    agentScratchAgentsFileExists: said('agentScratchAgentsFileExists', { ok: true, exists: true }),
    scratchFolderScopes: ['team', 'shared'],
    localFileStatus: said('localFileStatus', { ok: true, exists: true }),
    openLocalFile: said('openLocalFile', { ok: true }),
    revealFile: said('revealFile', { ok: true }),
    startProviderLogin: said('startProviderLogin', { phase: 'starting' }),
    getProviderLoginStatus: said('getProviderLoginStatus', { phase: 'idle' }),
    onProviderLoginStatus: () => () => {},
    submitProviderLoginCode: said('submitProviderLoginCode', { phase: 'idle' }),
    cancelProviderLogin: said('cancelProviderLogin', { phase: 'idle' }),
  } as unknown as NativeDesktop
  const old = Object.getOwnPropertyDescriptor(window, 'orgtreeDesktop')
  Object.defineProperty(window, 'orgtreeDesktop', { configurable: true, value })
  t.after(() => old ? Object.defineProperty(window, 'orgtreeDesktop', old)
    : delete (window as unknown as { orgtreeDesktop?: unknown }).orgtreeDesktop)
  return calls
}

/** A window whose app feed is open; `remote` makes it a window of the remote engine Galaxy. */
async function windowOf(t: TestContext, remote: boolean) {
  const feed = remoteFeed(t, () => new Response('{}'))
  const view = await mountView(<Here />, el => el)
  t.after(() => view.unmount())
  await feed.remotes([remoteView()], remote ? remoteView() : undefined)
  return bridge(t)
}

const labels = (menu: Awaited<ReturnType<typeof localFileMenu>>) =>
  menu.filter(e => e !== 'sep').map(e => (e as { label: string }).label)

test('a local window opens folders and files on this computer, as before', async t => {
  const calls = await windowOf(t, false)
  assert.equal(remoteHere(), null)
  const toasts: string[][] = []
  const action = scratchFolderAction('org', 'lead', lines => { toasts.push(lines) })!
  action()
  assert.equal(typeof action.folderAgentsFile?.edit, 'function')
  assert.deepEqual(await localFolder(async () => ({ ok: true, path: 'C:\\templates' })), { ok: true, path: 'C:\\templates' })
  assert.deepEqual(labels(await localFileMenu(document.createElement('a'), PATH, async () => true)),
    ['Open', 'Show in folder', 'Copy path', 'Copy file name'])
  await flush(2)
  assert.deepEqual(calls, ['openAgentScratchFolder', 'localFileStatus'])
  assert.deepEqual(toasts, [])
})

test('a remote window opens no folder of this computer and says where the folder is', async t => {
  const calls = await windowOf(t, true)
  assert.equal(remoteHere()?.name, 'Galaxy')
  const toasts: string[][] = []
  for (const scope of [undefined, 'team', 'shared'] as const) {
    const action = scratchFolderAction('org', 'lead', lines => { toasts.push(lines) }, scope)
    assert.ok(action, 'the menu entry stays: it is never hidden without a word')
    assert.equal(action.folderAgentsFile, undefined, 'no AGENTS.md of this computer is offered for editing')
    action()
  }
  let opened = false
  assert.deepEqual(await localFolder(async () => { opened = true; return { ok: true } }), { ok: false, error: FOLDER, remote: true })
  await flush(2)
  assert.equal(opened, false)
  assert.deepEqual(toasts, [[FOLDER], [FOLDER], [FOLDER]])
  assert.deepEqual(calls, [], 'nothing was asked of this computer')
})

test('a remote window checks, opens and reveals no file of this computer; the path can still be copied', async t => {
  const calls = await windowOf(t, true)
  const copied: string[] = []
  const menu = await localFileMenu(document.createElement('a'), PATH, async (_el, text) => { copied.push(text); return true })
  assert.deepEqual(labels(menu), ['On Galaxy', 'Copy path', 'Copy file name'])
  const first = menu[0] as { disabled?: boolean; title?: string }
  assert.equal(first.disabled, true)
  assert.equal(first.title, `${FILE} — ${PATH}`)
  ;(menu.find(e => e !== 'sep' && e.label === 'Copy path') as { onSelect: () => void }).onSelect()
  await flush(1)
  assert.deepEqual(copied, [PATH])
  // a tool row's file: marked as the remote engine's, never checked against this disk
  const view = await mountView(<ToolFilePath path={PATH} link onContextMenu={() => {}} />, el => el)
  t.after(() => view.unmount())
  await flush(3)
  const link = view.el.querySelector<HTMLElement>('a[data-local-path]')!
  assert.equal(link.getAttribute('data-local-file-state'), 'remote')
  assert.equal(link.title, `${FILE} — ${PATH}`)
  assert.equal(link.textContent, PATH, 'the whole path is shown, since it cannot be opened from here')
  assert.equal(revealFileFromEvent({ target: link }), true)
  // a file link in prose carries no state of its own
  const prose = document.createElement('a')
  prose.setAttribute('data-local-path', PATH)
  assert.equal(revealFileFromEvent({ target: prose }), true)
  await flush(2)
  assert.deepEqual(calls, [], 'nothing was asked of this computer')
})

test('a remote window starts no provider sign-in on this computer and says where to sign in', async t => {
  const calls = await windowOf(t, true)
  const view = await mountView(<ProviderSignIn provider="claude" connected={false} toast={() => {}} onRefresh={() => {}}
    profileDir="/data/profiles/claude-2" accountId="claude-2" />, el => el)
  t.after(() => view.unmount())
  await flush(3)
  assert.equal(view.el.textContent, SIGN_IN + 'Copy path')
  assert.deepEqual([...view.el.querySelectorAll('button')].map(b => b.textContent), ['Copy path'])
  assert.deepEqual(calls, [], 'no sign-in was started or asked about here')
})
