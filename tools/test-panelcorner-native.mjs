// Runs tests/panelcorner-native.probe.ts in a real Electron window: the agent
// DESK, its presented/docket/inbox tabs, the corner's pin/popout/modal buttons,
// and the three real modals behind them — measured and photographed.
// ORGTREE_PANELCORNER_SHOTS points the screenshots somewhere you can look at
// them; without it they land in the temp root the probe prints on exit.
import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-panelcorner-'))

// THE SHELL, AS THE APP WIRES IT. The three modal openers here are the same
// shape OrgCanvas/App give the real AgentSurfaceRoutesProvider — one piece of
// state per surface, the gallery's own toggle rule, and `keepOpen` for the two
// buttons that must not close what they are about to move. `__opened` records
// which route ran so the probe can assert the modal button took the SAME road
// the right-click entry takes, not merely that a modal appeared.
const harness = `
import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { CurrentOrg } from './apps/desktop/renderer/src/popout'
import { OwnedDeskChat } from './apps/desktop/renderer/src/canvas/desk'
import { AgentSurfaceRoutesProvider } from './apps/desktop/renderer/src/canvas/panelcorner'
import { AgentGalleryModal } from './apps/desktop/renderer/src/canvas/gallery'
import { AgentDocketModal } from './apps/desktop/renderer/src/canvas/agentdocket'
import { NodeInboxModal } from './apps/desktop/renderer/src/canvas/mail'
import { isModalPinned, pinnedModalBehind, raisePinnedModal } from './apps/desktop/renderer/src/canvas/modalpin'
import './apps/desktop/renderer/src/styles.css'

// RECORD EVERY NATIVE WINDOW MovableSurface ASKS FOR, and hand back a stub.
//
// ⚠ THIS IS THE RIGHT SEAM, AND THE LIMIT OF THE CLAIM. What this change adds
// to the pop-out path is one link: the desk corner reaching MovableSurface's
// own opener. Everything past window.open — the child document, the style
// clone, the surface registration — is MovableSurface's, is unchanged by this
// ticket, and already has its own native tests (tools/test-popout-header-
// regions.mjs and friends). Letting the fixture really open child windows was
// tried and hangs the probe, so it asserts at the boundary instead: the probe
// proves the button CALLS the opener with the surface's own frame name, NOT
// that a native window appeared.
window.__popoutsOpened = []
window.open = (url, name) => {
  window.__popoutsOpened.push(name)
  return null   // MovableSurface treats a null window as blocked and redocks
}
window.__opened = []

const NID = 'desk-panels'
const node = {
  id: NID, generation: 0, tier: 'opus', state: 'live', children: [],
  seat: 5, grant: 0, free: 0, documents: [], charter: 'renderer/UI engineer',
}
const map = new Map([[NID, node]])
const tree = { slug: 'demo', roots: [node], tiers: {}, compact_at: 0, max_top_grant: 1000 }
const world = { org: 'demo' }
const refs = { world, onOpen: () => {} }
const noop = () => {}
const op = () => Promise.resolve({ ok: true })

function Shell() {
  const [gallery, setGallery] = useState(null)
  const [docket, setDocket] = useState(null)
  const [inbox, setInbox] = useState(null)
  const setFor = { 'agent-gallery': setGallery, 'agent-docket': setDocket, 'node-inbox': setInbox }
  const cur = { 'agent-gallery': gallery, 'agent-docket': docket, 'node-inbox': inbox }
  const routes = {
    open: (kind, id) => {
      window.__opened.push(['open', kind, id])
      if (pinnedModalBehind(kind, 'demo')) { raisePinnedModal(kind, 'demo'); setFor[kind](id); return }
      setFor[kind](cur[kind] === id && isModalPinned(kind, 'demo') ? null : id)
    },
    show: (kind, id) => {
      window.__opened.push(['show', kind, id])
      if (pinnedModalBehind(kind, 'demo')) raisePinnedModal(kind, 'demo')
      setFor[kind](id)
    },
  }
  window.__closeAll = () => { setGallery(null); setDocket(null); setInbox(null) }
  // THE DESK'S OWN BOX, NOT THE WINDOW'S. On the canvas the focused desk is
  // authored at a fixed 900px square and counter-scaled into the card
  // (.desk-inner in styles.css) — so 900px IS the width every split inside it
  // is really divided at. Measuring in a 1180px window would flatter the
  // layout by ~30%. window.__deskWidth lets the probe re-measure at a pinned
  // desk window's much smaller width too.
  const [width, setWidth] = useState(900)
  window.__deskWidth = setWidth
  return React.createElement(CurrentOrg.Provider, { value: 'demo' },
    React.createElement(AgentSurfaceRoutesProvider, { value: routes },
      React.createElement('div', { className: 'desk-fixture',
        style: { width: width + 'px', height: '900px', position: 'relative', overflow: 'hidden' } },
        React.createElement(OwnedDeskChat, {
          node, map, op, slug: 'demo', toast: noop, pub: false, bare: true,
          onConfig: noop, onLineage: noop, onJump: noop,
        }),
        gallery && React.createElement(AgentGalleryModal, {
          slug: 'demo', nid: gallery, node, toast: noop, refs,
          close: () => setGallery(null),
        }),
        docket && React.createElement(AgentDocketModal, {
          slug: 'demo', nid: docket, tree, toast: noop, refs,
          close: () => setDocket(null),
        }),
        inbox && React.createElement(NodeInboxModal, {
          node, slug: 'demo', toast: noop, refs,
          close: () => setInbox(null),
        }))))
}
createRoot(document.getElementById('root')).render(React.createElement(Shell))

// the desk's tab strip is the real one; drive it the way a click would
window.__tab = (tab) => {
  const btn = document.querySelector('.cc-tabs button[data-tab="' + tab + '"]')
  if (!btn) throw new Error('no such tab: ' + tab)
  btn.click()
}
`
await build({
  stdin: { contents: harness, loader: 'tsx', resolveDir: process.cwd() },
  outfile: path.join(root, 'panelcorner.js'), bundle: true, platform: 'browser',
  format: 'iife', jsx: 'automatic',
})
await build({ entryPoints: ['tests/panelcorner-native.probe.ts'], outfile: path.join(root, 'probe.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'] })
await build({ entryPoints: ['apps/desktop/preload/index.ts'], outfile: path.join(root, 'preload.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'] })

const shots = process.env.ORGTREE_PANELCORNER_SHOTS || root
fs.mkdirSync(shots, { recursive: true })
const executable = process.env.ORGTREE_HISTORY_ELECTRON || createRequire(import.meta.url)('electron')
const env = {
  ...process.env,
  ORGTREE_PANELCORNER_TEST_ROOT: root,
  ORGTREE_PANELCORNER_SHOTS: shots,
  ORGTREE_DATA: path.join(root, 'data'),
  HOME: path.join(root, 'home'),
  USERPROFILE: path.join(root, 'home'),
}
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(executable, [path.join(root, 'probe.cjs')], { windowsHide: true, stdio: 'inherit', env })
child.on('error', (e) => { console.error(e); process.exitCode = 1 })
child.on('exit', (code) => { console.log('screenshots:', shots); process.exitCode = code ?? 1 })
