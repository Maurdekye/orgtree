// The downloads of the Files panel (a scratch folder of a remote organization;
// docs/rust-engine/remote-org.md, "The Files panel"): the main process starts their Save
// dialog in Downloads, tells the window that began one how far it is, lets that window stop
// it, and leaves every other download alone.
//
// WHAT THIS FILE CAN AND CANNOT PROVE. It drives the module with a recorded session and
// download item, so it proves what the module asks of Electron and what it tells the window.
// It opens no window and saves no file: Electron's own Save dialog is not something a test
// can answer.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

// a worktree without node_modules names the dependency checkout (ORGTREE_TEST_DEPS)
const { build } = createRequire(process.env.ORGTREE_TEST_DEPS || import.meta.url)('esbuild')

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-remote-downloads-'))
const out = path.join(dir, 'remote-downloads.cjs')
await build({ entryPoints: ['apps/desktop/main/remote-downloads.ts'], outfile: out, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' })
const { isFilesDownload, watchRemoteFileDownloads } = createRequire(import.meta.url)(out)
const main = fs.readFileSync('apps/desktop/main/index.ts', 'utf8')
const preload = fs.readFileSync('apps/desktop/preload/index.ts', 'utf8')

const ORIGIN = 'http://127.0.0.1:7361'
const FILE = `${ORIGIN}/api/orgs/galaxy/nodes/lead/scratch-files/file?path=logs%2Frun.log`
const DOWNLOADS = path.join('C:', 'Users', 'someone', 'Downloads')

/** A session, one window's web contents and download items, each recording what is asked. */
function rig() {
  let willDownload = null
  const session = { on(event, listener) { assert.equal(event, 'will-download'); willDownload = listener } }
  const window = (id) => ({ id, gone: false, sent: [], isDestroyed() { return this.gone }, send(channel, event) { this.sent.push([channel, event]) } })
  const item = (url, name, total) => ({
    url, name, total, received: 0, savePath: '', dialog: null, cancelled: false, listeners: {},
    getURL() { return this.url }, getFilename() { return this.name }, getReceivedBytes() { return this.received },
    getTotalBytes() { return this.total }, getSavePath() { return this.savePath },
    setSaveDialogOptions(options) { this.dialog = options }, cancel() { this.cancelled = true },
    on(event, listener) { this.listeners[event] = listener }, once(event, listener) { this.listeners[event] = listener },
    update(received, state = 'progressing') { this.received = received; this.listeners.updated?.({}, state) },
    done(state) { this.listeners.done?.({}, state) },
  })
  let clock = 0
  const downloads = watchRemoteFileDownloads(session, () => ORIGIN, () => DOWNLOADS, () => clock)
  return { downloads, window, item, start: (it, contents) => willDownload({}, it, contents), tick: (ms) => { clock += ms } }
}
const news = (contents) => contents.sent.map(([channel, event]) => {
  assert.equal(channel, 'desktop:event')
  assert.equal(event.type, 'remote-file-download')
  return event.data
})

test('only the Files route of this app\'s own engine is a Files download', () => {
  for (const url of [FILE, `${ORIGIN}/api/orgs/a-b/nodes/_shared/scratch-files/file?scope=shared`, `${ORIGIN}/api/orgs/galaxy/nodes/lead/file?path=big.bin`, `${ORIGIN}/api/orgs/galaxy/nodes/lead/scratch-files/file`,
    // a finished export of a node (4.7.0, docs/rust-engine/agent-export.md): up to 256 GiB, saved the same way
    `${ORIGIN}/api/orgs/galaxy/exports/x0123456789ab/file`]) {
    assert.equal(isFilesDownload(url, ORIGIN), true, url)
  }
  for (const url of [
    `${ORIGIN}/api/orgs/galaxy/nodes/lead/file/more?path=x`,
    `${ORIGIN}/api/orgs/galaxy/nodes/lead/scratch-files`,
    `${ORIGIN}/api/orgs/galaxy/nodes/lead/scratch-files/file/more`,
    `${ORIGIN}/api/orgs/galaxy/nodes/a/b/scratch-files/file`,
    `${ORIGIN}/api/orgs/galaxy/exports/x0123456789ab`,
    `${ORIGIN}/api/orgs/galaxy/exports/x0123456789ab/file/more`,
    `${ORIGIN}/api/orgs/galaxy/exports/a/b/file`,
    `${ORIGIN}/api/orgs/galaxy/imports/x0123456789ab/file`,
    'http://127.0.0.1:9999/api/orgs/galaxy/nodes/lead/scratch-files/file',
    'https://example.com/api/orgs/galaxy/nodes/lead/scratch-files/file',
    'not a url', '',
  ]) {
    assert.equal(isFilesDownload(url, ORIGIN), false, url)
  }
  assert.equal(isFilesDownload(FILE, ''), false, 'no engine, no Files download')
})

test('a Files download starts its Save dialog in Downloads and tells its window how far it is', () => {
  const { window, item, start, tick } = rig()
  const contents = window(7), it = item(FILE, 'run.log', 4000)
  start(it, contents)
  assert.deepEqual(it.dialog, { title: 'Save run.log', defaultPath: path.join(DOWNLOADS, 'run.log') })
  // the Save dialog is still open: nothing is said yet
  it.update(0)
  assert.deepEqual(news(contents), [])
  it.savePath = path.join(DOWNLOADS, 'run.log')
  it.update(1000)
  assert.deepEqual(news(contents), [{ id: 'dl-1', name: 'run.log', received: 1000, total: 4000, state: 'progressing' }])
  // not more often than every quarter of a second
  tick(100); it.update(2000)
  assert.equal(news(contents).length, 1)
  tick(200); it.update(3000)
  assert.deepEqual(news(contents).map((n) => n.received), [1000, 3000])
  // a pause Chromium may resume from is not the end
  it.update(3000, 'interrupted')
  assert.equal(news(contents).length, 2)
  it.received = 4000; it.done('completed')
  assert.deepEqual(news(contents).at(-1), { id: 'dl-1', name: 'run.log', received: 4000, total: 4000, state: 'completed' })
})

test('a Save dialog closed with Cancel is no download: the window hears nothing', () => {
  const { window, item, start } = rig()
  const contents = window(7), it = item(FILE, 'run.log', 4000)
  start(it, contents)
  it.done('cancelled')
  assert.deepEqual(news(contents), [])
})

test('a file small enough to end before any progress still says it is done', () => {
  const { window, item, start } = rig()
  const contents = window(7), it = item(FILE, 'tiny.txt', 3)
  start(it, contents)
  it.received = 3; it.done('completed')
  assert.deepEqual(news(contents), [{ id: 'dl-1', name: 'tiny.txt', received: 3, total: 3, state: 'completed' }])
})

test('only the window that began a download can stop it, and only while it runs', () => {
  const { downloads, window, item, start } = rig()
  const mine = window(7), it = item(FILE, 'run.log', 4000)
  start(it, mine)
  it.savePath = 'x'; it.update(10)
  assert.equal(downloads.cancel('dl-1', 8), false, 'another window')
  assert.equal(downloads.cancel('dl-2', 7), false, 'no such download')
  assert.equal(it.cancelled, false)
  assert.equal(downloads.cancel('dl-1', 7), true)
  assert.equal(it.cancelled, true)
  it.done('cancelled')
  assert.equal(news(mine).at(-1).state, 'cancelled')
  assert.equal(downloads.cancel('dl-1', 7), false, 'it has ended')
})

test('every other download is left alone, and a closed window is told nothing', () => {
  const { downloads, window, item, start } = rig()
  const contents = window(7)
  const other = item(`${ORIGIN}/api/orgs/galaxy/nodes/lead/documents/report.pdf`, 'report.pdf', 10)
  start(other, contents)
  assert.deepEqual([other.dialog, Object.keys(other.listeners), news(contents)], [null, [], []])
  assert.equal(downloads.cancel('dl-1', 7), false)
  const it = item(FILE, 'run.log', 4000)
  start(it, contents)
  it.savePath = 'x'
  contents.gone = true
  it.update(10); it.done('completed')
  assert.deepEqual(contents.sent, [])
})

test('the main process watches the app session and the bridge can ask it to stop one', () => {
  assert.match(main, /watchRemoteFileDownloads\(browserSession as unknown as DownloadSession, \(\) => engine\.origin, \(\) => app\.getPath\('downloads'\)\)/)
  assert.match(main, /handle\('desktop:remote-file-download-cancel', \(caller, id\) =>\s*\(\{ ok: typeof id === 'string' && fileDownloads\.cancel\(id, caller\.window\.webContents\.id\) \}\)\)/)
  assert.match(preload, /cancelRemoteFileDownload: \(id: string\) => ipcRenderer\.invoke\('desktop:remote-file-download-cancel', id\)/)
})

test('the name a download is saved under is a name, whatever path the answer named', () => {
  // review F-5 (2026-11-14): the name comes from the other computer's answer; only its last part is used
  const { window, item, start } = rig()
  for (const [given, name] of [['..\\..\\Start Menu\\evil.lnk', 'evil.lnk'], ['../../.ssh/authorized_keys', 'authorized_keys'],
    ['C:\\Windows\\win.ini', 'win.ini'], ['logs/run.log', 'run.log'], ['', 'download'], ['..', 'download'], ['.', 'download']]) {
    const contents = window(9), it = item(FILE, given, 10)
    start(it, contents)
    assert.deepEqual(it.dialog, { title: `Save ${name}`, defaultPath: path.join(DOWNLOADS, name) }, JSON.stringify(given))
    it.savePath = path.join(DOWNLOADS, name)
    it.done('completed')
    assert.equal(news(contents).at(-1)?.name, name, JSON.stringify(given))
  }
})
