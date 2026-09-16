// THE AGENT DESK'S TAB CORNER, IN A REAL WINDOW.
//
// This change is VISUAL and BEHAVIOURAL, so a green jsdom suite proves neither
// half of it: jsdom has no layout, so it cannot say whether a reading pane is
// wide enough to read a document in, and it has no windows, so it cannot say
// whether a pop-out opened one.
//
// This mounts the ACTUAL agent desk (OwnedDeskChat) for an agent that has
// presented documents, docket items and mail, inside the ACTUAL shell wiring
// (AgentSurfaceRoutesProvider handing down the very openers OrgCanvas hands
// down, and the three real modals behind them), in a real production-shaped
// Electron window, against a fixture engine. Then it looks.
//
// What it proves, in order, for each of the three tabs:
//   · the split — measured, with the presented tab's reading pane compared
//     against the same view's own modal
//   · the three buttons are present together in the corner
//   · PIN really pins: the surface becomes a `.modalpin-win` with a stored rect
//   · MODAL really opens the standalone modal the right-click entry opens
//   · POPOUT really asks MovableSurface to open a window
// and photographs every one of those states.
import { app, BrowserWindow, ipcMain, session } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import assert from 'node:assert/strict'
import { Preferences } from '../apps/desktop/main/preferences'
import { configureEngineSession, configureWindow } from '../apps/desktop/main/windows'

const root = process.env.ORGTREE_PANELCORNER_TEST_ROOT!
const shots = process.env.ORGTREE_PANELCORNER_SHOTS || root
app.disableHardwareAcceleration()
app.setPath('userData', path.join(root, 'profile'))
let server: http.Server

const iso = (n: number) => new Date(Date.UTC(2026, 8, 16, 11, 0, 0) - n * 60000).toISOString()
const NID = 'desk-panels'

const DOCS = {
  documents: Array.from({ length: 9 }, (_, i) => ({
    id: `doc${i}`, node: NID,
    title: `Panel split review ${i} — the corrected proportions`,
    at: iso(i * 11), format: 'markdown', bytes: 1200 + i, evicted: false,
    node_state: 'live', tier: 'opus',
  })),
  total: 9, next_offset: null, offset: 0,
}
const DOC_BODY = {
  id: 'doc0', node: NID, title: 'Panel split review 0 — the corrected proportions',
  at: iso(0), format: 'markdown', bytes: 1200,
  body: '# The reading pane\n\n'
    + 'This paragraph exists so that the width of the reading pane is VISIBLE in the '
    + 'capture rather than inferred from a number. Prose lays out as prose when the '
    + 'measure is right, and wraps every few words when it is not — which is exactly '
    + 'what the reporter saw on this tab before the split was corrected.\n\n'
    + '- a list item, for rhythm\n- a second one\n\n'
    + 'A closing paragraph, long enough to show a second and a third line of text at '
    + 'any sensible width, so that the difference between one third and one half of '
    + 'the panel is unmistakable to the eye and not only to the assertion below it.\n',
}
const WORK = {
  items: Array.from({ length: 6 }, (_, i) => ({
    slug: `panel-split-item-${i}`,
    title: `Zoomed-in presented documents view ${i}`,
    status: i === 0 ? 'in_progress' : 'open', kind: 'code', rev: 1,
    objective: 'The panel is split wrong and the corner offers no pin, popout or modal.',
    owner: { node: NID, generation: 0 }, created_by: { node: 'coordinator-opus', generation: 2 },
    at: iso(i * 30), updated_at: iso(i * 30), docket_at: iso(i * 30), status_at: iso(i * 30),
    done_so_far: ['read the ticket'], working_on_next: ['fix the split'],
    acceptance: [], evidence: [], participants: [], history: [], scope: [],
    questions: [], dependencies: [], attachments: [], findings: [],
    artifacts: [], review_packets: [], candidate_verdicts: [], receipts: [],
    dismissals: [], reply_recipients: [], claims: [],
    archived: false, archived_at: null, manual_attention: null,
    // ⚠ `attention_sources` IS NOT OPTIONAL to DocketRow — it calls
    // `.includes('manual')` on it directly (canvas/docket.tsx). A fixture row
    // without it throws inside the row and renders an empty tab.
    attention_sources: [], effective_attention: false,
    owner_current: true, owner_state: 'live', reviewer: null, next_action: null,
    blocked_reason: null, dropped_reason: null, legacy_status: null,
    superseded_by: null, parent: null, accepted: null,
    delivery: { implemented: null, committed: null, pushed: null, deployed: null, in_build: null },
    findings_summary: { total: 0, by_disposition: {}, open: [] },
  })),
}
const MAIL = {
  pending: [],
  delivered: Array.from({ length: 10 }, (_, i) => ({
    id: `m${i}`, from: i % 2 ? 'coordinator-opus' : 'ticket-sections', kind: 'message', at: iso(i * 5),
    body: `Message ${i}. ` + 'A body long enough to wrap, so the reading pane width shows in the capture rather than being inferred. '.repeat(3),
  })),
  sent: [],
}

app.whenReady().then(async () => {
  async function screenshot(w: BrowserWindow, name: string) {
    // wait for a real composited frame — capturePage reads the compositor,
    // which is a step behind the DOM (narrowlist-native.probe.ts's rule)
    await w.webContents.executeJavaScript('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(true))))')
    await new Promise((r) => setTimeout(r, 150))
    let png: Buffer
    try { png = (await w.webContents.capturePage()).toPNG() }
    catch {
      w.webContents.debugger.attach('1.3')
      try {
        const r = await w.webContents.debugger.sendCommand('Page.captureScreenshot', { format: 'png', fromSurface: false })
        png = Buffer.from(r.data, 'base64')
      } finally { w.webContents.debugger.detach() }
    }
    fs.writeFileSync(path.join(shots, name + '.png'), png)
  }
  const prefs = new Preferences(path.join(root, 'preferences.json'))
  ipcMain.handle('desktop:preferences', () => prefs.get())
  ipcMain.handle('desktop:window-state', () => ({ visible: true, restoreWindows: false }))
  ipcMain.handle('desktop:set-effective-theme', () => {})
  ipcMain.handle('desktop:set-preferences', (_e, patch) => prefs.set(patch))

  server = http.createServer((req, res) => {
    const url = req.url || '/'
    const json = (body: unknown) => {
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body))
    }
    if (url === '/panelcorner.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(fs.readFileSync(path.join(root, 'panelcorner.js'))); return }
    if (url === '/panelcorner.css') { res.setHeader('Content-Type', 'text/css'); res.end(fs.readFileSync(path.join(root, 'panelcorner.css'))); return }
    if (url.includes('/documents/')) return json(DOC_BODY)
    if (url.includes('/documents')) return json(DOCS)
    if (url.includes('/work-items')) return json(WORK)
    if (url.includes('/inbox')) return json(MAIL)
    if (url.includes('/detail')) return json({ id: NID, charter: 'renderer/UI engineer', documents: DOCS.documents })
    if (url.includes('/chat')) return json({ events: [], busy: false, pending: [] })
    if (url.startsWith('/api/')) return json({})
    res.setHeader('Content-Type', 'text/html')
    res.end('<link rel="stylesheet" href="/panelcorner.css"><div id="root"></div><script src="/panelcorner.js"></script>')
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const origin = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`
  const register = configureEngineSession(session.defaultSession, origin, 'panelcorner-fixture')
  const win = new BrowserWindow({
    show: true, width: 1180, height: 820, frame: false, autoHideMenuBar: true,
    webPreferences: { preload: path.join(root, 'preload.cjs'), additionalArguments: [`--orgtree-ui-origin=${origin}`], sandbox: true, nodeIntegration: false, contextIsolation: true },
  })
  configureWindow(win, origin, true, register, () => {})
  win.webContents.on('console-message', (e) => console.log('renderer', e.message))
  await win.loadURL(origin)

  const js = <T = any>(code: string): Promise<T> => win.webContents.executeJavaScript(code)
  const waitFor = async (code: string, why: string) => {
    for (let i = 0; i < 240; i++) {
      if (await js(code)) return
      await new Promise((r) => setTimeout(r, 25))
    }
    throw Error(`timed out waiting for ${why}: ${code}`)
  }
  const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms))

  // the geometry and the corner, for whichever tab panel is on screen
  const probe = `(()=>{
    const panel=document.querySelector('.desk-tabpanel'); if(!panel) return null
    const m=panel.querySelector('.mailer')
    const r=(el)=>{ if(!el) return null; const b=el.getBoundingClientRect(); return {x:Math.round(b.x),y:Math.round(b.y),w:Math.round(b.width),h:Math.round(b.height)} }
    const corner=panel.querySelector('.panel-corner')
    const btns=[...panel.querySelectorAll('.panel-corner-btn')]
    return {
      panel:r(panel), mailer:r(m),
      list:r(m&&m.querySelector('.mailer-list')), read:r(m&&m.querySelector('.mailer-read')),
      corner:r(corner),
      cornerLabel:corner?corner.getAttribute('aria-label'):null,
      buttons:btns.map(b=>({label:b.getAttribute('aria-label'),pressed:b.getAttribute('aria-pressed')})),
      cornerInsidePanel: corner&&panel ? (corner.getBoundingClientRect().right<=panel.getBoundingClientRect().right+1
        && corner.getBoundingClientRect().top>=panel.getBoundingClientRect().top-1) : null,
      pinnedWin: !!document.querySelector('.modalpin-win'),
      pinnedWinTitle: document.querySelector('.modalpin-win .modalpin-name')?.textContent ?? null,
      modalOpen: !!document.querySelector('.overlay .settings'),
      modalTitle: document.querySelector('.overlay .settings h3')?.textContent ?? null,
      // WHICH surface the standalone modal actually is. Not its heading text:
      // AgentGalleryModal's body heads itself with a <b>, not an <h3>, so a
      // title check would have been reading a property of the markup rather
      // than of the panel. The BODY COMPONENT is the identity — each of the
      // three modals mounts exactly one of these three views.
      modalKind: (() => {
        const p = document.querySelector('.overlay .settings'); if (!p) return null
        if (p.querySelector('.gallery-agent')) return 'agent-gallery'
        if (p.querySelector('.docket-agent')) return 'agent-docket'
        if (p.querySelector('.mailwrap')) return 'node-inbox'
        return 'other'
      })(),
      storedPins: Object.keys(JSON.parse(localStorage.getItem('orgtree-modal-pins')||'{}')),
      popouts: (window.__popoutsOpened||[]).slice(),
    }})()`
  const clickCorner = (i: number) =>
    js(`(()=>{document.querySelectorAll('.desk-tabpanel .panel-corner-btn')[${i}].click();return true})()`)

  const evidence: Record<string, any> = {}
  const openTab = async (tab: string, readyWhen: string) => {
    await js(`window.__tab(${JSON.stringify(tab)});true`)
    await waitFor(readyWhen, `the ${tab} tab to render`)
    await settle()
  }

  // ───────────────────────────────────────────────── PRESENTED (the split)
  await waitFor(`!!document.querySelector('.cc-tabs')`, 'the desk to render')
  await openTab('presented', `document.querySelectorAll('.desk-presented-card').length>0`)
  // open a document, so the reading pane has something in it to judge
  await js(`(()=>{document.querySelectorAll('.desk-presented-card')[0].click();return true})()`)
  await waitFor(`!!document.querySelector('.mailer-read .mailer-body')`, 'the document body')
  await settle()
  const presented = await js(probe)
  evidence.presented = presented
  await screenshot(win, '01-presented-split')

  assert.ok(presented.list && presented.read, 'the presented tab draws a list beside a reading pane')
  // THE ACTUAL COMPLAINT: the list was the bigger half. It must not be.
  assert.ok(presented.read.w > presented.list.w * 1.7,
    `the reading pane must be the clear majority of the panel; list ${presented.list.w}px vs read ${presented.read.w}px`)
  const share = presented.list.w / presented.mailer.w
  assert.ok(Math.abs(share - 1 / 3) < 0.04,
    `the list takes the gallery collection's third, got ${(share * 100).toFixed(1)}%`)
  // three buttons, together, in the corner
  assert.equal(presented.buttons.length, 3, 'three corner buttons, present together')
  assert.match(presented.buttons[0].label, /pin/i, 'first is pin')
  assert.match(presented.buttons[1].label, /new window|show .* window/i, 'second is popout')
  assert.match(presented.buttons[2].label, /standalone modal/i, 'third is modal')
  assert.equal(presented.cornerInsidePanel, true, 'the cluster sits inside its panel, at the top right')
  assert.equal(presented.buttons[0].pressed, 'false', 'nothing is pinned yet')

  // ── PIN: the desk corner's push-pin pins THIS panel's modal view
  await clickCorner(0)
  await waitFor(`!!document.querySelector('.modalpin-win')`, 'the pinned window')
  await settle(400)
  const pinnedGallery = await js(probe)
  evidence.pinnedGallery = pinnedGallery
  await screenshot(win, '02-presented-pinned')
  assert.ok(pinnedGallery.storedPins.some((k: string) => k.includes('agent-gallery')),
    'a pin rect was stored under the gallery modal\'s own kind, got ' + JSON.stringify(pinnedGallery.storedPins))
  assert.match(String(pinnedGallery.pinnedWinTitle), /Presented documents/,
    'the pinned window is the presentations panel, got ' + pinnedGallery.pinnedWinTitle)
  assert.equal(pinnedGallery.buttons[0].pressed, 'true',
    'the corner push-pin now reads as pressed')

  // the same press again unpins — the title bar push-pin's own two calls
  await clickCorner(0)
  await settle(400)
  const unpinned = await js(probe)
  evidence.unpinned = unpinned
  assert.ok(!unpinned.storedPins.some((k: string) => k.includes('agent-gallery')),
    'pressing it again released the pin')
  assert.equal(unpinned.buttons[0].pressed, 'false', 'and the button says so')
  await js(`window.__closeAll();true`); await settle(300)

  // ── MODAL: the third button opens the standalone presentations modal, and it
  //    is the SAME route the right-click entry takes (the harness records which
  //    opener ran, so this is not "a modal appeared" but "that opener ran")
  await js(`window.__opened=[];true`)
  await clickCorner(2)
  await waitFor(`!!document.querySelector('.overlay .settings')`, 'the standalone modal')
  await settle(400)
  const modalGallery = await js(probe)
  evidence.modalGallery = modalGallery
  evidence.modalGalleryOpener = await js(`window.__opened.slice()`)
  await screenshot(win, '03-presented-modal')
  assert.deepEqual(evidence.modalGalleryOpener, [['open', 'agent-gallery', NID]],
    'the modal button ran the shell\'s Open-presentations route, got ' + JSON.stringify(evidence.modalGalleryOpener))
  assert.equal(modalGallery.modalKind, 'agent-gallery',
    'the standalone modal is the presentations panel, got ' + modalGallery.modalKind)
  // …and THE MODAL AND THE TAB NOW SPLIT THE SAME WAY — that is the "mirror the
  // popout panel's structure" half, measured against the panel it mirrors
  const modalSplit = await js(`(()=>{
    const m=document.querySelector('.overlay .settings .mailer'); if(!m) return null
    const w=(s)=>{const e=m.querySelector(s); return e?Math.round(e.getBoundingClientRect().width):null}
    return {mailer:Math.round(m.getBoundingClientRect().width), list:w('.mailer-list'), read:w('.mailer-read')}})()`)
  evidence.modalSplit = modalSplit
  assert.ok(modalSplit && modalSplit.list,
    'the modal draws the same two-pane layout')
  assert.ok(Math.abs(modalSplit.list / modalSplit.mailer - presented.list.w / presented.mailer.w) < 0.02,
    `the desk tab and its own modal now divide list from content the same way: `
    + `tab ${(presented.list.w / presented.mailer.w * 100).toFixed(1)}%, modal ${(modalSplit.list / modalSplit.mailer * 100).toFixed(1)}%`)
  await js(`window.__closeAll();true`); await settle(300)

  // ── POPOUT: the second button asks the surface to open a native window.
  //    Recorded at the MovableSurface boundary (the harness patches window.open
  //    so the probe does not depend on a child window being creatable here).
  // ⚠ WHAT THIS PROVES, EXACTLY: the corner's pop-out reached the surface's own
  // window opener with the surface's own frame name. The fixture stubs
  // window.open (see the harness), so a native window's CREATION is not
  // exercised here — that half is MovableSurface's, is untouched by this
  // change, and has its own native tests.
  await js(`window.__popoutsOpened=[];window.__opened=[];true`)
  await clickCorner(1)
  await waitFor(`(window.__popoutsOpened||[]).length>0`, 'the pop-out to reach the opener')
  await settle(400)
  const poppedGallery = await js(probe)
  evidence.poppedGallery = poppedGallery
  assert.equal(poppedGallery.popouts.length, 1,
    'exactly one window was asked for, got ' + JSON.stringify(poppedGallery.popouts))
  assert.match(String(poppedGallery.popouts[0]), /orgtree-popout-/,
    'through MovableSurface\'s own named-window path, got ' + poppedGallery.popouts[0])
  // and it was THIS surface that was asked to move: the pop-out route had to
  // open the gallery first, and the shell records which route ran
  assert.deepEqual(await js(`window.__opened.slice()`), [['show', 'agent-gallery', NID]],
    'the pop-out took the non-toggling show route for the gallery')
  await js(`window.__closeAll();true`); await settle(400)

  // ──────────────────────────────────────────────────────────────── DOCKET
  await openTab('docket', `document.querySelectorAll('.docket-row, .mailrow').length>0`)
  const docket = await js(probe)
  evidence.docket = docket
  await screenshot(win, '05-docket-corner')
  assert.equal(docket.buttons.length, 3, 'the docket tab carries the same three buttons')
  assert.equal(docket.cornerInsidePanel, true, 'in its own corner')
  // THE LOOK-FIRST ANSWER, RECORDED AS A NUMBER: the docket's list is the wide
  // half ON PURPOSE (its rows are item NAMES, read in the list) and this change
  // deliberately leaves it alone.
  assert.ok(docket.list && docket.read, 'the docket tab draws a list beside a detail pane')
  evidence.docketShare = docket.list.w / docket.mailer.w

  await js(`window.__opened=[];true`)
  await clickCorner(2)
  await waitFor(`!!document.querySelector('.overlay .settings')`, 'the standalone docket modal')
  await settle(400)
  const docketModal = await js(probe)
  evidence.docketModal = docketModal
  evidence.docketModalOpener = await js(`window.__opened.slice()`)
  await screenshot(win, '06-docket-modal')
  assert.deepEqual(evidence.docketModalOpener, [['open', 'agent-docket', NID]],
    'the docket tab\'s modal button ran the shell\'s agent-docket route')
  assert.equal(docketModal.modalKind, 'agent-docket',
    'the standalone docket modal, got ' + docketModal.modalKind + ' / ' + docketModal.modalTitle)
  await js(`window.__closeAll();true`); await settle(300)

  await clickCorner(0)
  await waitFor(`!!document.querySelector('.modalpin-win')`, 'the pinned docket window')
  await settle(400)
  const docketPinned = await js(probe)
  evidence.docketPinned = docketPinned
  await screenshot(win, '07-docket-pinned')
  assert.ok(docketPinned.storedPins.some((k: string) => k.includes('agent-docket')),
    'the docket tab pinned ITS OWN modal view, got ' + JSON.stringify(docketPinned.storedPins))
  await clickCorner(0); await settle(300)
  await js(`window.__closeAll();true`); await settle(300)

  await js(`window.__popoutsOpened=[];window.__opened=[];true`)
  await clickCorner(1)
  await waitFor(`(window.__popoutsOpened||[]).length>0`, 'the docket pop-out')
  await settle(400)
  evidence.docketPopout = await js(`window.__popoutsOpened.slice()`)
  assert.equal(evidence.docketPopout.length, 1, 'the docket tab popped its own modal out')
  assert.deepEqual(await js(`window.__opened.slice()`), [['show', 'agent-docket', NID]],
    'and it was the DOCKET surface it asked to move, not another tab\'s')
  await js(`window.__closeAll();true`); await settle(400)

  // ───────────────────────────────────────────────────────────────── INBOX
  await openTab('inbox', `document.querySelectorAll('.mailrow').length>0`)
  await js(`(()=>{document.querySelectorAll('.mailrow')[0].click();return true})()`)
  await settle(300)
  const inbox = await js(probe)
  evidence.inbox = inbox
  await screenshot(win, '08-inbox-corner')
  assert.equal(inbox.buttons.length, 3, 'the inbox tab carries the same three buttons')
  assert.equal(inbox.cornerInsidePanel, true, 'in its own corner')
  assert.ok(inbox.list && inbox.read, 'the inbox tab draws a list beside a reading pane')
  evidence.inboxShare = inbox.list.w / inbox.mailer.w

  await js(`window.__opened=[];true`)
  await clickCorner(2)
  await waitFor(`!!document.querySelector('.overlay .settings')`, 'the standalone inbox modal')
  await settle(400)
  const inboxModal = await js(probe)
  evidence.inboxModal = inboxModal
  evidence.inboxModalOpener = await js(`window.__opened.slice()`)
  await screenshot(win, '09-inbox-modal')
  assert.deepEqual(evidence.inboxModalOpener, [['open', 'node-inbox', NID]],
    'the inbox tab\'s modal button ran the shell\'s node-inbox route')
  assert.equal(inboxModal.modalKind, 'node-inbox',
    'the standalone inbox modal, got ' + inboxModal.modalKind + ' / ' + inboxModal.modalTitle)
  await js(`window.__closeAll();true`); await settle(300)

  await clickCorner(0)
  await waitFor(`!!document.querySelector('.modalpin-win')`, 'the pinned inbox window')
  await settle(400)
  const inboxPinned = await js(probe)
  evidence.inboxPinned = inboxPinned
  await screenshot(win, '10-inbox-pinned')
  assert.ok(inboxPinned.storedPins.some((k: string) => k.includes('node-inbox')),
    'the inbox tab pinned ITS OWN modal view, got ' + JSON.stringify(inboxPinned.storedPins))
  await clickCorner(0); await settle(300)
  await js(`window.__closeAll();true`); await settle(300)

  await js(`window.__popoutsOpened=[];window.__opened=[];true`)
  await clickCorner(1)
  await waitFor(`(window.__popoutsOpened||[]).length>0`, 'the inbox pop-out')
  await settle(400)
  evidence.inboxPopout = await js(`window.__popoutsOpened.slice()`)
  assert.equal(evidence.inboxPopout.length, 1, 'the inbox tab popped its own modal out')
  assert.deepEqual(await js(`window.__opened.slice()`), [['show', 'node-inbox', NID]],
    'and it was the INBOX surface it asked to move')
  await js(`window.__closeAll();true`); await settle(300)

  // ⚠ NEGATIVE CONTROL. The corner belongs to the DESK TAB. The modal it opens
  // has a pin and a pop-out of its own in its title bar, so a corner cluster
  // inside that modal would be a second, competing pair — the exact duplication
  // "build it once" was asked for. Prove there is only ever one.
  await js(`window.__opened=[];true`)
  await openTab('presented', `document.querySelectorAll('.desk-presented-card').length>0`)
  await clickCorner(2)
  await waitFor(`!!document.querySelector('.overlay .settings')`, 'the modal again')
  await settle(400)
  const corners = await js(`document.querySelectorAll('.panel-corner').length`)
  const inModal = await js(`document.querySelectorAll('.overlay .settings .panel-corner').length`)
  evidence.cornerCount = corners
  evidence.cornersInModal = inModal
  assert.equal(inModal, 0, 'the standalone modal carries no corner cluster of its own')
  assert.equal(corners, 1, 'exactly one corner cluster is on screen, the desk tab\'s, got ' + corners)
  await screenshot(win, '11-modal-has-no-second-corner')

  // ────────────────────────────── THE SAME TABS IN A SMALL PINNED DESK WINDOW
  // A desk is not always the 900px square it is on the canvas: pinned or
  // popped out it is whatever box the user dragged it to. The corner must
  // still be in the corner there, and the split must still leave a document
  // readable, so the same three tabs are re-measured at a small one.
  await js(`window.__closeAll();true`); await settle(300)
  await js(`window.__deskWidth(430);true`)
  await settle(500)
  for (const [tab, ready, shot] of [
    ['presented', `document.querySelectorAll('.desk-presented-card').length>0`, '12-narrow-presented'],
    ['docket', `document.querySelectorAll('.mailrow').length>0`, '13-narrow-docket'],
    ['inbox', `document.querySelectorAll('.mailrow').length>0`, '14-narrow-inbox'],
  ] as const) {
    await openTab(tab, ready)
    const narrow = await js(probe)
    evidence['narrow_' + tab] = narrow
    await screenshot(win, shot)
    assert.equal(narrow.buttons.length, 3, `${tab} keeps all three buttons at 430px`)
    assert.equal(narrow.cornerInsidePanel, true, `${tab}'s cluster stays inside the panel at 430px`)
    assert.ok(narrow.corner.w < narrow.panel.w / 2,
      `${tab}'s cluster does not eat the panel at 430px (${narrow.corner.w} of ${narrow.panel.w})`)
  }

  evidence.pass = true
  evidence.shots = fs.readdirSync(shots).filter((f) => f.endsWith('.png')).sort()
  fs.writeFileSync(path.join(shots, 'evidence.json'), JSON.stringify(evidence, null, 2))
  console.log(JSON.stringify({ pass: true, shots: evidence.shots, dir: shots }, null, 2))
  win.destroy(); server.close(); app.exit(0)
}).catch((e) => { console.error(e); server?.close(); app.exit(1) })
