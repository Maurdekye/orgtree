// Session 0 real-Electron visual verification for folded and unfolded request
// cards (single without ticket, single with ticket, multi with two tickets) at
// 900 px width. Invoked by tools/rig/ask-fold-header-visual.mjs.
const { app, BrowserWindow, session } = require('electron')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')

function arg(name, fallback = null) {
  const idx = process.argv.indexOf(name)
  return idx >= 0 && idx + 1 < process.argv.length ? process.argv[idx + 1] : fallback
}

const outDir = arg('--out')
if (!outDir) {
  console.error('Missing --out <dir>')
  process.exit(2)
}

function currentWindowsSessionId() {
  if (process.platform !== 'win32') return 0
  const out = execFileSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${process.pid}).SessionId`],
    { encoding: 'utf8', windowsHide: true },
  ).trim()
  return Number.parseInt(out, 10)
}

const sessionId = currentWindowsSessionId()
if (process.platform === 'win32' && sessionId !== 0) {
  console.error(`Refusing to open capture window outside Session 0 (current SessionId=${sessionId}).`)
  process.exit(3)
}

app.commandLine.appendSwitch('mute-audio')
app.commandLine.appendSwitch('autoplay-policy', 'document-user-activation-required')
app.commandLine.appendSwitch('disable-gpu')
app.on('window-all-closed', () => {})

const tempProfile = path.join(outDir, 'electron-profile')
fs.mkdirSync(tempProfile, { recursive: true })
app.setPath('userData', tempProfile)

function startStaticServer(rootDir) {
  const mime = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
  }
  const server = http.createServer((req, res) => {
    const urlPath = new URL(req.url, 'http://127.0.0.1').pathname
    const safeName = path.basename(urlPath === '/' ? 'index.html' : urlPath)
    const filePath = path.join(rootDir, safeName)
    if (!fs.existsSync(filePath)) {
      res.writeHead(404)
      res.end('not found')
      return
    }
    res.writeHead(200, { 'Content-Type': mime[path.extname(safeName)] || 'application/octet-stream' })
    res.end(fs.readFileSync(filePath))
  })
  return new Promise((resolve, reject) => {
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port })
    })
  })
}

async function captureVariant(win, port, variant) {
  const url = `http://127.0.0.1:${port}/${variant}.html?variant=${variant}`
  await win.loadURL(url)
  await win.webContents.executeJavaScript(`
    new Promise((resolve) => {
      const check = () => {
        if (window.__ASK_FOLD_HEADER_VISUAL_READY__ && document.querySelectorAll('.askcard').length === 3) {
          requestAnimationFrame(() => requestAnimationFrame(resolve))
        } else {
          setTimeout(check, 20)
        }
      }
      check()
    })
  `)

  // 1. Measure & capture UNFOLDED state
  const unfoldedMetrics = await win.webContents.executeJavaScript(`
    (() => {
      const readSection = (name) => {
        const sec = document.querySelector('[data-section="' + name + '"]')
        if (!sec) return null
        const card = sec.querySelector('.askcard')
        const cardRect = card.getBoundingClientRect()
        const qHead = sec.querySelector('.ask-q-head')
        const qHeadChip = sec.querySelector('.ask-q-head .ref-item')
        const chipRect = qHeadChip ? qHeadChip.getBoundingClientRect() : null
        return {
          cardWidth: Math.round(cardRect.width),
          cardBottom: Math.round(cardRect.bottom),
          hasQHead: Boolean(qHead),
          hasTicketChip: Boolean(qHeadChip),
          ticketId: qHeadChip ? qHeadChip.getAttribute('data-object-id') : null,
          ticketText: qHeadChip ? (qHeadChip.textContent || '').trim() : null,
          chipWidth: chipRect ? Math.round(chipRect.width) : 0,
          chipHeight: chipRect ? Math.round(chipRect.height) : 0,
        }
      }
      return {
        viewport: { width: window.innerWidth, height: window.innerHeight },
        singleNoTicket: readSection('single-no-ticket'),
        singleWithTicket: readSection('single-with-ticket'),
        multiTwoTickets: readSection('multi-two-tickets'),
      }
    })()
  `)
  const unfoldedImg = await win.webContents.capturePage()
  const unfoldedPngPath = path.join(outDir, `${variant}-unfolded.png`)
  fs.writeFileSync(unfoldedPngPath, unfoldedImg.toPNG())

  // Check tab switching on multi-two-tickets while unfolded
  const tab2Metrics = await win.webContents.executeJavaScript(`
    new Promise((resolve) => {
      const sec = document.querySelector('[data-section="multi-two-tickets"]')
      const btns = sec ? [...sec.querySelectorAll('.ask-tabstrip .ask-tabbtn')] : []
      if (btns[1]) btns[1].click()
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const chip = sec ? sec.querySelector('.ask-q-head .ref-item') : null
        const id = chip ? chip.getAttribute('data-object-id') : null
        if (btns[0]) btns[0].click()
        requestAnimationFrame(() => resolve({ tab2TicketId: id }))
      }))
    })
  `)

  // 2. Fold all 3 cards via their fold buttons, then measure & capture FOLDED state
  const foldedMetrics = await win.webContents.executeJavaScript(`
    new Promise((resolve) => {
      for (const btn of document.querySelectorAll('.askcard button.ask-fold')) {
        btn.click()
      }
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const readFolded = (name) => {
          const sec = document.querySelector('[data-section="' + name + '"]')
          if (!sec) return null
          const tab = sec.querySelector('.ask-tab')
          const label = sec.querySelector('.ask-tab-label')
          const node = sec.querySelector('[data-copy-agent-name]')
          const line = sec.querySelector('.ask-fold-line')
          const text = sec.querySelector('.ask-fold-line .ask-fold-text')
          const chips = [...sec.querySelectorAll('.ask-fold-line .ref-item')]
          const tabRect = tab.getBoundingClientRect()
          const labelRect = label.getBoundingClientRect()
          const nodeRect = node.getBoundingClientRect()
          const lineRect = line ? line.getBoundingClientRect() : null
          const textRect = text ? text.getBoundingClientRect() : null
          const chipMetrics = chips.map((c) => {
            const r = c.getBoundingClientRect()
            const cs = getComputedStyle(c)
            return {
              id: c.getAttribute('data-object-id'),
              left: Math.round(r.left),
              right: Math.round(r.right),
              width: Math.round(r.width),
              height: Math.round(r.height),
              clientWidth: c.clientWidth,
              scrollWidth: c.scrollWidth,
              textOverflow: cs.textOverflow,
              whiteSpace: cs.whiteSpace,
              overflow: cs.overflow,
            }
          })
          return {
            tabHeight: Math.round(tabRect.height),
            labelWidth: Math.round(labelRect.width),
            labelHeight: Math.round(labelRect.height),
            nodeWidth: Math.round(nodeRect.width),
            nodeHeight: Math.round(nodeRect.height),
            lineLeft: lineRect ? Math.round(lineRect.left) : 0,
            lineRight: lineRect ? Math.round(lineRect.right) : 0,
            textContent: text ? (text.textContent || '').trim() : '',
            textLeft: textRect ? Math.round(textRect.left) : 0,
            textRight: textRect ? Math.round(textRect.right) : 0,
            textWidth: textRect ? Math.round(textRect.width) : 0,
            chips: chipMetrics,
          }
        }
        resolve({
          singleNoTicket: readFolded('single-no-ticket'),
          singleWithTicket: readFolded('single-with-ticket'),
          multiTwoTickets: readFolded('multi-two-tickets'),
        })
      }))
    })
  `)
  const foldedImg = await win.webContents.capturePage()
  const foldedPngPath = path.join(outDir, `${variant}-folded.png`)
  fs.writeFileSync(foldedPngPath, foldedImg.toPNG())

  return {
    unfoldedPngPath,
    foldedPngPath,
    unfoldedSize: unfoldedImg.getSize(),
    foldedSize: foldedImg.getSize(),
    unfolded: { ...unfoldedMetrics, ...tab2Metrics },
    folded: foldedMetrics,
  }
}

app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, callback) => callback(false))
  session.defaultSession.setPermissionCheckHandler(() => false)

  const win = new BrowserWindow({
    width: 960,
    height: 768,
    show: false,
    useContentSize: true,
    backgroundColor: '#1e1e1e',
    webPreferences: {
      offscreen: true,
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  win.webContents.setAudioMuted(true)

  const { server, port } = await startStaticServer(outDir)
  try {
    const before = await captureVariant(win, port, 'before')
    const after = await captureVariant(win, port, 'after')

    const af = after.folded
    const au = after.unfolded

    const checks = {
      sessionZero: sessionId === 0,
      audioMuted: true,
      clipboardIsolated: true,
      cardsAre900px:
        au.singleNoTicket.cardWidth === 900 &&
        au.singleWithTicket.cardWidth === 900 &&
        au.multiTwoTickets.cardWidth === 900,
      allUnfoldedCardsInViewport:
        au.singleNoTicket.cardBottom <= au.viewport.height &&
        au.singleWithTicket.cardBottom <= au.viewport.height &&
        au.multiTwoTickets.cardBottom <= au.viewport.height,
      beforeMultiHeaderWrapped:
        before.folded.multiTwoTickets.labelHeight > 26 ||
        before.folded.multiTwoTickets.nodeHeight > 26,
      beforeMultiTextCrushedToZero:
        before.folded.multiTwoTickets.textWidth === 0,
      beforeUnfoldedMissingTicketChips:
        !before.unfolded.singleWithTicket.hasTicketChip &&
        !before.unfolded.multiTwoTickets.hasTicketChip,
      afterFoldedHeadersSingleLine:
        af.singleNoTicket.tabHeight <= 32 &&
        af.singleWithTicket.tabHeight <= 32 &&
        af.multiTwoTickets.tabHeight <= 32 &&
        af.multiTwoTickets.labelHeight <= 24 &&
        af.multiTwoTickets.nodeHeight <= 24,
      afterFoldedTextBeforeTickets:
        af.singleWithTicket.textRight <= af.singleWithTicket.chips[0].left + 2 &&
        af.multiTwoTickets.textRight <= af.multiTwoTickets.chips[0].left + 2 &&
        af.multiTwoTickets.chips[0].right <= af.multiTwoTickets.chips[1].left + 2,
      afterFoldedMultiShowsTabHeaders:
        af.multiTwoTickets.textContent === 'Pop-out X \u00b7 Server harness' &&
        af.multiTwoTickets.textWidth >= 140,
      afterFoldedTicketChipsClipWithEllipsis:
        af.multiTwoTickets.chips.every((c) =>
          c.textOverflow === 'ellipsis' &&
          c.whiteSpace === 'nowrap' &&
          c.overflow === 'hidden' &&
          c.right <= af.multiTwoTickets.lineRight + 2
        ) &&
        af.multiTwoTickets.chips.some((c) => c.scrollWidth > c.clientWidth),
      afterUnfoldedShowsTicketChips:
        !au.singleNoTicket.hasTicketChip &&
        au.singleWithTicket.hasTicketChip &&
        au.singleWithTicket.ticketId === 'pop-out-windows-clicking-the-x-closes-the-pop-ou' &&
        au.multiTwoTickets.hasTicketChip &&
        au.multiTwoTickets.ticketId === 'pop-out-windows-clicking-the-x-closes-the-pop-ou' &&
        au.tab2TicketId === 'language-model-server-entries-harness-can-be-edi',
    }
    const ok = Object.values(checks).every(Boolean)
    const result = {
      ok,
      childPid: process.pid,
      sessionId,
      audioMuted: true,
      clipboardIsolated: true,
      checks,
      before,
      after,
    }
    fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify(result, null, 2))
    win.destroy()
    server.close()
    app.exit(ok ? 0 : 1)
  } catch (err) {
    win.destroy()
    server.close()
    console.error(err)
    app.exit(1)
  }
})
