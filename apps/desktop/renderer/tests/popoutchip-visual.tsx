// popoutchip-visual.tsx — capture fixture for the "<X> is in another window"
// notice (@item:orgtree/x-is-in-another-window-placeholder-covers-parts-o;
// tests/popoutchip.test.tsx holds the behaviour). It uses ONLY production
// MovableSurface + PopoutButton + useSurface, so it bundles unchanged at BASE
// (632c580) and at the tip: the notice it shows is whichever the tree under
// test draws. Fake app chrome stands in for what the notice must not cover:
// a top bar with opener buttons (carrying data-popout-opener, ignored at base),
// bottom-left controls, a canvas strip to click beside the chip, and a menu
// overlay (z 1600) opened by window.popoutChipFixture.menu(true).
// The capture driver (C-only) calls, in the MAIN window:
//   popoutChipFixture.kinds                      -> the seven panel kinds
//   popoutChipFixture.popOut('inbox')            -> real MovableSurface open()
//   popoutChipFixture.redock('inbox')
//   popoutChipFixture.menu(true | false)         -> overlay above the notice
//   popoutChipFixture.hits()                     -> elementFromPoint beside the chip
// Native child windows need the app's window.open handling; a plain Electron
// page allows it. The card-desk route (DeskSlot) is NOT in this fixture.
import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import { MovableSurface, PopoutButton, useSurface } from '../src/popout'

const KINDS = ['desk', 'inbox', 'presentation', 'docket', 'settings', 'usage', 'custom-app:demo'] as const
const TITLES: Record<string, string> = { desk: 'writer · desk', inbox: 'Inbox', presentation: 'Report',
  docket: 'Docket', settings: 'Settings', usage: 'Usage', 'custom-app:demo': 'Demo app · Panel' }
const handles = new Map<string, { open: () => void; redock: () => void }>()

function Panel({ kind }: { kind: string }) {
  const s = useSurface()
  if (s) handles.set(kind, { open: () => s.open(), redock: () => s.redock() })
  return <div className="settings" style={{ padding: 12, minWidth: 220 }}>
    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
      <b>{TITLES[kind]}</b><PopoutButton />
    </div>
    <p>Panel body ({kind})</p>
  </div>
}

function Fixture() {
  const [menu, setMenu] = useState(false)
  const [open, setOpen] = useState<string[]>([...KINDS])
  Object.assign(window, { popoutChipFixture: {
    kinds: [...KINDS],
    popOut: (k: string) => handles.get(k)?.open(),
    redock: (k: string) => handles.get(k)?.redock(),
    menu: (v: boolean) => setMenu(v),
    show: (ks: string[]) => setOpen(ks),
    hits: () => {
      const chip = document.querySelector('.popout-chip'), r = chip?.getBoundingClientRect()
      if (!r) return null
      const at = (x: number, y: number) => document.elementFromPoint(x, y)?.className ?? null
      return { chip: { x: r.x, y: r.y, w: r.width, h: r.height },
        besideRight: at(r.right + 12, r.y + r.height / 2), besideBelow: at(r.x + r.width / 2, r.bottom + 12) }
    },
  } })
  return <div style={{ position: 'fixed', inset: 0 }}>
    <div style={{ height: 44, display: 'flex', gap: 8, padding: 8, borderBottom: '1px solid var(--line)' }}>
      {KINDS.map(k => <button key={k} data-popout-opener={k}>{TITLES[k]}</button>)}
    </div>
    <div id="canvas-strip" style={{ position: 'absolute', top: 60, left: 120, right: 120, bottom: 80,
      background: 'var(--panel)', border: '1px dashed var(--line)' }}>canvas (click beside the chip)</div>
    <div style={{ position: 'absolute', left: 12, bottom: 12, display: 'flex', gap: 6 }}>
      <button>Zoom −</button><button>Fit</button><button>Zoom +</button>
    </div>
    {open.map(k => <MovableSurface key={k} kind={k} title={TITLES[k]} org="demo"><Panel kind={k} /></MovableSurface>)}
    {menu && <div className="ctxmenu" style={{ position: 'fixed', left: 440, top: 52, zIndex: 1600, width: 160,
      background: 'var(--panel)', border: '1px solid var(--line)', padding: 6 }}>menu overlay</div>}
  </div>
}
document.body.style.cssText = 'margin:0;background:var(--bg);color:var(--ink);font:14px sans-serif'
createRoot(document.getElementById('root')!).render(<Fixture />)
