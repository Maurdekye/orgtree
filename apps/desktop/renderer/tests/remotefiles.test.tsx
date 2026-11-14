// remotefiles.test.tsx: the Files panel of a window on a remote organization
// (docs/rust-engine/remote-org.md, "The Files panel"). USER 2026-11-14 mda676963aed1
// "Approve as recommended": a tree a folder at a time with zip as an action, downloads through
// the Save dialog, upload conflicts asked (Replace / Keep both), streamed with progress and
// Cancel, 2 GiB a file, local organizations unchanged, an older engine keeps its sentence.
//
// Run:  node tests/run.mjs remotefiles
import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import type { NativeDesktop } from '../src/desktop'
import type { DesktopEvent } from '../../../../packages/contracts'
import { useRemoteHere } from '../src/remotehere'
import { scratchFolderAction } from '../src/scratch-folder'
import { RemoteFilesPanel } from '../src/canvas/remotefiles'
import {
  UPLOAD_MAX, crumbs, downloadNews, downloadUrl, forgetRemoteFiles, keptBeside, olderEngine, openRemoteFiles, progressText,
  remoteFilesOpen, sizeText, transfersNow, uploadFile,
} from '../src/remotefiles'
import type { FileEntry, FilesTarget, UploadRequest } from '../src/remotefiles'
import { remoteFeed, remoteView } from './remotefeed.fixture'

const LEAD: FilesTarget = { org: 'org', node: 'lead', title: "lead's scratch folder" }
const entry = (name: string, kind: FileEntry['kind'] = 'file', bytes: number | null = 5): FileEntry =>
  ({ name, kind, bytes: kind === 'file' ? bytes : null, modified: 1_794_651_630_000 })

/** The other computer's folders, as its engine lists them. */
const FOLDERS: Record<string, FileEntry[]> = {
  '': [entry('logs', 'folder'), entry('elsewhere', 'link'), entry('notes.txt', 'file', 1536), entry('plan.md')],
  'logs': [entry('run.log', 'file', 3 * 1024 * 1024)],
}

interface Sent { method: string; url: string; body: unknown; request: FakeUpload }

/** What an upload is sent with, in place of the browser's: the test ends it. */
class FakeUpload {
  static sent: Sent[] = []
  upload: UploadRequest['upload'] = { onprogress: null }
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  onabort: (() => void) | null = null
  status = 0
  responseText = ''
  private method = ''
  private url = ''
  open(method: string, url: string) { this.method = method; this.url = url }
  send(body: unknown) { FakeUpload.sent.push({ method: this.method, url: this.url, body, request: this }) }
  abort() { this.onabort?.() }
  answer(status: number, body: unknown) { this.status = status; this.responseText = JSON.stringify(body); this.onload?.() }
}

function Here() { useRemoteHere(); return null }

/** A window of the remote engine Galaxy whose engine answers `list`; `calls` are the listings
 *  asked for. `bridge` records what the desktop was asked. */
async function remoteWindow(t: TestContext, list: (path: string, offset: number) => Response = (path, offset) => {
  const all = FOLDERS[path]
  if (!all) return new Response(JSON.stringify({ detail: 'That file or folder is not there.' }), { status: 404 })
  const page = all.slice(offset, offset + 3)
  return new Response(JSON.stringify({ entries: page, total: all.length, next: offset + page.length < all.length ? offset + page.length : null }))
}) {
  forgetRemoteFiles()
  FakeUpload.sent = []
  const calls: string[] = []
  const feed = remoteFeed(t, (url) => {
    const at = new URL(url, 'http://app')
    calls.push(at.pathname + at.search)
    return list(at.searchParams.get('path') ?? '', Number(at.searchParams.get('offset') ?? 0))
  })
  const desktopCalls: string[] = []
  let listener: ((event: DesktopEvent) => void) | null = null
  const value = {
    openAgentScratchFolder: async () => { desktopCalls.push('openAgentScratchFolder'); return { ok: true } },
    scratchFolderScopes: ['team', 'shared'],
    onEvent: (next: (event: DesktopEvent) => void) => { listener = next; return () => { listener = null } },
    cancelRemoteFileDownload: async (id: string) => { desktopCalls.push(`cancel ${id}`); return { ok: true } },
  } as unknown as NativeDesktop
  const globals = globalThis as unknown as { XMLHttpRequest?: unknown }
  const old = { bridge: Object.getOwnPropertyDescriptor(window, 'orgtreeDesktop'), xhr: globals.XMLHttpRequest }
  Object.defineProperty(window, 'orgtreeDesktop', { configurable: true, value })
  globals.XMLHttpRequest = FakeUpload
  const toasts: string[][] = []
  const view = await mountView(<><Here /><RemoteFilesPanel toast={(lines) => { toasts.push(lines) }} /></>, (el) => el)
  t.after(async () => {
    await view.unmount()
    forgetRemoteFiles()
    globals.XMLHttpRequest = old.xhr
    if (old.bridge) Object.defineProperty(window, 'orgtreeDesktop', old.bridge)
    else delete (window as unknown as { orgtreeDesktop?: unknown }).orgtreeDesktop
  })
  return { feed, calls, desktopCalls, toasts, event: (event: DesktopEvent) => inAct(() => { listener?.(event) }) }
}

const q = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector)
const all = <T extends Element = HTMLElement>(selector: string) => [...document.querySelectorAll<T>(selector)]
const names = () => all('.remote-files-entry .remote-files-name').map((el) => el.textContent?.trim())
const click = (el: Element | null | undefined) => inAct(async () => { (el as HTMLElement).click(); await flush() })
const button = (text: string) => all<HTMLButtonElement>('.remote-files button').find((b) => b.textContent?.trim().startsWith(text))
const settle = () => inAct(() => flush())

/** Hand `files` to the panel's file input, as choosing them in the system's dialog does. */
async function choose(files: File[]) {
  const input = q<HTMLInputElement>('.remote-files input[type=file]')!
  Object.defineProperty(input, 'files', { configurable: true, value: files })
  await inAct(async () => { input.dispatchEvent(new window.Event('change', { bubbles: true })); await flush() })
}
const file = (name: string, size = 4): File => {
  const made = new window.File(['data'], name) as unknown as File
  if (size !== 4) Object.defineProperty(made, 'size', { value: size })
  return made
}

test('sizes, paths and names in words', () => {
  assert.deepEqual([0, 1023, 1024, 1536, 5 * 1024 * 1024, 150 * 1024 * 1024, UPLOAD_MAX].map(sizeText),
    ['0 B', '1023 B', '1.0 KB', '1.5 KB', '5.0 MB', '150 MB', '2.0 GB'])
  assert.equal(progressText(12 * 1024 * 1024, 48 * 1024 * 1024), '12.0 MB of 48.0 MB (25%)')
  assert.equal(progressText(12 * 1024 * 1024, null), '12.0 MB', 'a zip has no known whole')
  assert.deepEqual(crumbs('logs/run/today'), [{ name: 'logs', path: 'logs' }, { name: 'run', path: 'logs/run' }, { name: 'today', path: 'logs/run/today' }])
  assert.deepEqual(crumbs(''), [])
  assert.equal(keptBeside('notes.txt', new Set(['notes.txt', 'notes (2).txt'])), 'notes (3).txt')
  assert.equal(keptBeside('Makefile', new Set(['Makefile'])), 'Makefile (2)')
  assert.equal(downloadUrl(LEAD, 'logs/run log.txt'), '/api/orgs/org/nodes/lead/scratch-files/file?path=logs%2Frun+log.txt')
  assert.equal(downloadUrl({ ...LEAD, scope: 'team' }, ''), '/api/orgs/org/nodes/lead/scratch-files/file?scope=team')
  assert.equal(downloadUrl({ org: 'org', node: '', scope: 'shared', title: 'shared' }, 'a'), '/api/orgs/org/nodes/_shared/scratch-files/file?scope=shared&path=a')
  assert.equal(olderEngine(Object.assign(new Error('no route GET /api/orgs/org/nodes/lead/scratch-files'), { status: 404 })), true)
  assert.equal(olderEngine(Object.assign(new Error('That folder does not exist yet.'), { status: 404 })), false)
})

test('in a remote window a scratch-folder entry opens the Files panel, for each kind of folder', async (t) => {
  const { feed, desktopCalls, toasts } = await remoteWindow(t)
  await feed.remotes([remoteView()], remoteView())
  for (const [scope, title] of [[undefined, "lead's scratch folder"], ['team', "lead's team scratch folder"], ['shared', 'the shared scratch folder']] as const) {
    const action = scratchFolderAction('org', 'lead', (lines) => { toasts.push(lines) }, scope)
    assert.ok(action, 'the entry stays')
    assert.equal(action.folderAgentsFile, undefined, 'no AGENTS.md of this computer is offered')
    await inAct(async () => { action(); await flush() })
    assert.deepEqual(remoteFilesOpen(), { org: 'org', node: 'lead', ...(scope ? { scope } : {}), title })
    assert.equal(q('.provider-dialog h3')?.textContent, `Files: ${title}`)
  }
  assert.deepEqual([desktopCalls, toasts], [[], []], 'nothing of this computer is opened, and no sentence stands in for the folder')
})

test('in a local window the entry opens the file manager and no panel', async (t) => {
  const { feed, desktopCalls } = await remoteWindow(t)
  await feed.remotes([remoteView()], undefined)
  await inAct(async () => { scratchFolderAction('org', 'lead', () => {})!(); await flush() })
  assert.deepEqual(desktopCalls, ['openAgentScratchFolder'])
  assert.equal(remoteFilesOpen(), null)
  assert.equal(q('.remote-files'), null)
})

test('the panel lists a folder at a time: folders open, files and folders download, a link does neither', async (t) => {
  const { feed, calls } = await remoteWindow(t)
  await feed.remotes([remoteView()], remoteView())
  await inAct(async () => { openRemoteFiles(LEAD); await flush() })
  assert.match(q('.remote-files-where')?.textContent ?? '', /This folder is on Galaxy\./)
  assert.deepEqual(names(), ['logs', 'elsewhere', 'notes.txt'], 'the first page')
  assert.equal(button('Show more')?.textContent?.trim(), 'Show more (3 of 4)')
  await click(button('Show more'))
  assert.deepEqual(names(), ['logs', 'elsewhere', 'notes.txt', 'plan.md'])
  assert.equal(button('Show more'), undefined)
  const rows = all('.remote-files-entry')
  assert.equal(rows[2]!.querySelector('.remote-files-size')?.textContent, '1.5 KB')
  const links = rows.map((row) => row.querySelector<HTMLAnchorElement>('a.remote-files-act'))
  assert.deepEqual(links.map((a) => a && [a.getAttribute('href'), a.getAttribute('download'), a.getAttribute('aria-label')]), [
    ['/api/orgs/org/nodes/lead/scratch-files/file?path=logs', 'logs.zip', 'Download logs as zip'],
    null,
    ['/api/orgs/org/nodes/lead/scratch-files/file?path=notes.txt', 'notes.txt', 'Download notes.txt'],
    ['/api/orgs/org/nodes/lead/scratch-files/file?path=plan.md', 'plan.md', 'Download plan.md'],
  ])
  assert.equal(rows[1]!.querySelector('.remote-files-act')?.textContent, 'not followed')
  assert.equal(rows[1]!.querySelector('button'), null, 'a link cannot be opened')
  // the whole folder as one zip
  const whole = all<HTMLAnchorElement>('.remote-files-tools a')[0]!
  assert.deepEqual([whole.getAttribute('href'), whole.getAttribute('download')], ['/api/orgs/org/nodes/lead/scratch-files/file', "lead's scratch folder.zip"])
  // into a folder, and back by the trail
  await click(rows[0]!.querySelector('button'))
  assert.deepEqual(names(), ['run.log'])
  assert.deepEqual(all('.remote-files-trail button').map((b) => [b.textContent?.trim(), (b as HTMLButtonElement).disabled]), [["lead's scratch folder", false], ['logs', true]])
  assert.equal(all<HTMLAnchorElement>('.remote-files-tools a')[0]!.getAttribute('download'), 'logs.zip')
  await click(all('.remote-files-trail button')[0])
  assert.deepEqual(names(), ['logs', 'elsewhere', 'notes.txt'])
  assert.deepEqual(calls.filter((c) => c.includes('scratch-files')), [
    '/api/orgs/org/nodes/lead/scratch-files',
    '/api/orgs/org/nodes/lead/scratch-files?offset=3',
    '/api/orgs/org/nodes/lead/scratch-files?path=logs',
    '/api/orgs/org/nodes/lead/scratch-files',
  ])
})

test('an engine older than the Files routes keeps the sentence that says where the folder is', async (t) => {
  const { feed, toasts } = await remoteWindow(t, () =>
    new Response(JSON.stringify({ detail: 'no route GET /api/orgs/org/nodes/lead/scratch-files' }), { status: 404 }))
  await feed.remotes([remoteView()], remoteView())
  await inAct(async () => { scratchFolderAction('org', 'lead', () => {})!(); await flush() })
  await settle()
  assert.equal(remoteFilesOpen(), null, 'the panel closes itself')
  assert.equal(q('.remote-files'), null)
  assert.deepEqual(toasts, [['This folder is on Galaxy, not on this computer. Its Orgtree is older than 4.6.0, which is what shows a folder here.']])
})

test('a folder that cannot be listed says why and stays open', async (t) => {
  const { feed } = await remoteWindow(t, () => new Response(JSON.stringify({ detail: 'That folder does not exist yet.' }), { status: 404 }))
  await feed.remotes([remoteView()], remoteView())
  await inAct(async () => { openRemoteFiles(LEAD); await flush() })
  assert.equal(q('.remote-files [role=alert]')?.textContent, 'That folder does not exist yet.')
  assert.equal(button('Upload files')?.disabled, true)
})

test('an upload goes into the open folder with its progress, and can be cancelled', async (t) => {
  const { feed, toasts, calls } = await remoteWindow(t)
  await feed.remotes([remoteView()], remoteView())
  await inAct(async () => { openRemoteFiles(LEAD); await flush() })
  await click(all('.remote-files-entry button')[0])
  const fresh = file('fresh.bin')
  await choose([fresh])
  assert.equal(q('.remote-files-ask'), null, 'nothing of that name is there: no question')
  assert.deepEqual(FakeUpload.sent.map((s) => [s.method, s.url, s.body === fresh]),
    [['PUT', '/api/orgs/org/nodes/lead/scratch-files/upload?path=logs&name=fresh.bin&conflict=ask', true]], 'the file itself is the body')
  const sent = FakeUpload.sent[0]!.request
  await inAct(() => { sent.upload.onprogress?.({ loaded: 1, total: 4 }) })
  const row = () => q('.remote-files-transfer')
  assert.equal(row()?.querySelector('.remote-files-transfer-name')?.textContent, 'Upload: fresh.bin')
  assert.equal(row()?.querySelector('.remote-files-transfer-words')?.textContent, '1 B of 4 B (25%)')
  assert.equal(row()?.querySelector('progress')?.getAttribute('value'), '0.25')
  const listed = calls.length
  await inAct(async () => { sent.answer(200, { name: 'fresh.bin', bytes: 4 }); await flush() })
  assert.equal(row()?.querySelector('.remote-files-transfer-words')?.textContent, 'Done, 4 B')
  assert.deepEqual(toasts, [['fresh.bin is in logs on Galaxy']])
  assert.equal(calls.length, listed + 1, 'the folder is read again')
  await click(row()?.querySelector('button'))
  assert.equal(row(), null, 'dismissed')
  // a second one, stopped half way
  await choose([file('other.bin')])
  await click(row()?.querySelector('button'))
  assert.equal(row()?.querySelector('.remote-files-transfer-words')?.textContent, 'Stopped. Nothing was changed on the other computer.')
  assert.equal(toasts.length, 1)
})

test('a file of a name that is there is asked about: Replace, Keep both or Skip, once for all on request', async (t) => {
  const { feed } = await remoteWindow(t)
  await feed.remotes([remoteView()], remoteView())
  await inAct(async () => { openRemoteFiles(LEAD); await flush() })
  await click(button('Show more'))
  await choose([file('notes.txt'), file('new.txt'), file('plan.md')])
  // the one that is not there goes at once; the two that are wait for a word
  assert.deepEqual(FakeUpload.sent.map((s) => s.url), ['/api/orgs/org/nodes/lead/scratch-files/upload?name=new.txt&conflict=ask'])
  const ask = () => q('.remote-files-ask')
  assert.match(ask()?.textContent ?? '', /notes\.txt is already in this folder\./)
  assert.deepEqual([...ask()!.querySelectorAll('button')].map((b) => b.textContent), ['Replace', 'Keep both', 'Skip'])
  assert.equal([...ask()!.querySelectorAll('button')][1]!.getAttribute('title'), 'The new one becomes notes (2).txt')
  assert.match(ask()?.querySelector('label')?.textContent ?? '', /Do this for all 2/)
  await click([...ask()!.querySelectorAll('button')][2])
  assert.match(ask()?.textContent ?? '', /plan\.md is already in this folder\./, 'skipped: the next question')
  assert.equal(FakeUpload.sent.length, 1, 'a skipped file is not sent')
  await click([...ask()!.querySelectorAll('button')][1])
  assert.equal(ask(), null)
  assert.equal(FakeUpload.sent[1]!.url, '/api/orgs/org/nodes/lead/scratch-files/upload?name=plan.md&conflict=keep_both')
  // for all: one answer for every file that is there
  await choose([file('notes.txt'), file('plan.md')])
  await inAct(() => { ask()!.querySelector<HTMLInputElement>('input[type=checkbox]')!.click() })
  await click([...ask()!.querySelectorAll('button')][0])
  assert.equal(ask(), null)
  assert.deepEqual(FakeUpload.sent.slice(2).map((s) => s.url), [
    '/api/orgs/org/nodes/lead/scratch-files/upload?name=notes.txt&conflict=replace',
    '/api/orgs/org/nodes/lead/scratch-files/upload?name=plan.md&conflict=replace',
  ])
})

test('a name taken since the folder was listed is asked about when the engine refuses it', async (t) => {
  const { feed } = await remoteWindow(t)
  await feed.remotes([remoteView()], remoteView())
  await inAct(async () => { openRemoteFiles(LEAD); await flush() })
  await choose([file('late.txt')])
  await inAct(async () => { FakeUpload.sent[0]!.request.answer(409, { detail: 'A file of that name is already there.' }); await flush() })
  assert.match(q('.remote-files-ask')?.textContent ?? '', /late\.txt is already in this folder\./)
  assert.equal(q('.remote-files-transfer'), null, 'a question, not a failed transfer')
  await click(q('.remote-files-ask button'))
  assert.equal(FakeUpload.sent[1]!.url, '/api/orgs/org/nodes/lead/scratch-files/upload?name=late.txt&conflict=replace')
})

test('a large file says its size first, and one over 2 GiB is not sent', async (t) => {
  const { feed } = await remoteWindow(t)
  await feed.remotes([remoteView()], remoteView())
  await inAct(async () => { openRemoteFiles(LEAD); await flush() })
  await choose([file('big.bin', 150 * 1024 * 1024), file('huge.bin', UPLOAD_MAX + 1)])
  assert.equal(FakeUpload.sent.length, 0)
  assert.match(q('.remote-files-ask')?.textContent ?? '', /big\.bin is 150 MB\. Upload it\?/)
  assert.equal(q('.remote-files-transfer-words')?.textContent, 'huge.bin is larger than 2 GiB, the most one upload may hold.')
  await click(q('.remote-files-ask button'))
  assert.deepEqual(FakeUpload.sent.map((s) => s.url), ['/api/orgs/org/nodes/lead/scratch-files/upload?name=big.bin&conflict=ask'])
})

test('a download shows how far it is, as the desktop tells it, and Cancel stops it there', async (t) => {
  const { feed, desktopCalls, event } = await remoteWindow(t)
  await feed.remotes([remoteView()], remoteView())
  await inAct(async () => { openRemoteFiles(LEAD); await flush() })
  const news = (received: number, total: number, state: string, id = 'dl-1') =>
    event({ type: 'remote-file-download' as DesktopEvent['type'], data: { id, name: 'run.log', received, total, state } })
  await news(1024 * 1024, 4 * 1024 * 1024, 'progressing')
  const row = () => q('.remote-files-transfer[data-transfer=download]')
  assert.equal(row()?.querySelector('.remote-files-transfer-name')?.textContent, 'Download: run.log')
  assert.equal(row()?.querySelector('.remote-files-transfer-words')?.textContent, '1.0 MB of 4.0 MB (25%)')
  await click(row()?.querySelector('button'))
  assert.deepEqual(desktopCalls, ['cancel dl-1'])
  await news(1024 * 1024, 4 * 1024 * 1024, 'cancelled')
  assert.equal(row()?.querySelector('.remote-files-transfer-words')?.textContent, 'Stopped.')
  // a zip: nobody knows the whole; then done
  await news(2048, 0, 'progressing', 'dl-2')
  assert.equal(all('.remote-files-transfer-words')[1]?.textContent, '2.0 KB')
  assert.equal(all('.remote-files-transfer')[1]?.querySelector('progress')?.hasAttribute('value'), false)
  await news(4096, 0, 'completed', 'dl-2')
  assert.equal(all('.remote-files-transfer-words')[1]?.textContent, 'Done, 4.0 KB')
})

test('uploadFile alone: the row, the answer, and a refusal with its status', async () => {
  forgetRemoteFiles()
  const made: FakeUpload[] = []
  const make = () => { const r = new FakeUpload(); made.push(r); return r as unknown as UploadRequest }
  const sending = uploadFile({ ...LEAD, scope: 'team' }, 'a b', file('x.txt'), 'keep_both', make)
  assert.deepEqual(transfersNow().map((x) => [x.kind, x.name, x.done, x.total, x.state]), [['upload', 'x.txt', 0, 4, 'running']])
  made[0]!.answer(200, { name: 'x (2).txt', bytes: 4 })
  assert.deepEqual(await sending, { name: 'x (2).txt', bytes: 4 })
  assert.deepEqual(transfersNow().map((x) => [x.name, x.state]), [['x (2).txt', 'done']])
  const refused = uploadFile(LEAD, '', file('y.txt'), 'ask', make)
  made[1]!.answer(507, { detail: 'The disk of that computer is full.' })
  await assert.rejects(refused, (e: Error & { status?: number }) => e.message === 'The disk of that computer is full.' && e.status === 507)
  assert.deepEqual(transfersNow().map((x) => [x.name, x.state, x.error ?? null]), [['x (2).txt', 'done', null], ['y.txt', 'failed', 'The disk of that computer is full.']])
  downloadNews({ id: 'dl-9', name: 'z.zip', received: 10, total: 0, state: 'interrupted' })
  assert.deepEqual(transfersNow().at(-1), { id: 'dl-9', kind: 'download', name: 'z.zip', done: 10, total: null, state: 'failed', error: 'The download broke off. What arrived was not kept.' })
})
