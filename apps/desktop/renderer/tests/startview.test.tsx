// startview.test.tsx — D-228: where an org OPENS, and whether the camera
// glides there. Two browser-local settings:
//
//   orgtree-start-view   'org' (default) · 'switchboard' · 'remember'
//   orgtree-start-zoom   '1' (default) · '0'
//
// and one per-org record, `orgtree-view-<slug>`, the camera the browser last
// had on that org.
//
// HOW THE CAMERA IS READ — the deskinit idiom. jsdom does no layout, so
// nothing here is measured: the camera is the numbers this code WROTE into
// `.space`'s transform, and the switchboard is the DOM consequence — the eye
// card wearing `.desk`, which `focusId` grants only while the camera is
// actually on it at screen-filling zoom.
//
// HOW "DID IT GLIDE" IS READ. The harness's rAF is a 16ms mocked timer, so
// the frame right after mount is the PRE-glide frame: an intro that glides
// parks the camera on the eye at z=1.6 first and only moves on the first
// tick, while one that does not glide is already at its destination. So:
// read the camera before any `advance()`, and z=1.6 means "gliding".
// (`animateTo` stamps its start from the real `performance.now()`, so the
// glide then completes in its first frame — this suite verifies WHERE the
// camera goes and whether it TRAVELS, never the 1700ms ease itself.)
//
// ANTI-VACUITY. §1 is the control: unset keys give exactly the old
// behaviour (glide, then the fit). Every later section asserts the OPPOSITE
// of §1 on one axis with the same readers, so no section can be green
// because a reader found nothing. §7 pins the zoom toggle's SCOPE — ignored
// by 'remember' — with the same toggle §6 proves is honoured by 'org'.
//
// Run:  cd frontend && node tests/run.mjs startview

import {
  advance, FakeServer, flush, inAct, installFetch, mountView, realClock,
  useFakeClock,
} from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { OrgCanvas } from '../src/canvas/OrgCanvas'
import { AccountsPanel } from '../src/canvas/accounts'
import { Z_DESK } from '../src/canvas/shared'
import { resetConvos } from '../src/convo'
import type { AccountsPayload, ProvidersPayload, TreePayload } from '../src/types'

const noop = () => {}
const EYE_Z0 = 1.6      // the intro's parking zoom on the eye (OrgCanvas)

// ---------------------------------------------------------------- fixtures
const asTree = (v: unknown) => v as TreePayload
interface FixNode { id: string; children?: FixNode[] }
function mk(n: FixNode): unknown {
  return {
    id: n.id, title: n.id, tier: 'haiku', model_id: 'haiku', state: 'live',
    seat: 1, grant: 0, free: 0, ui_order: 0, cost_usd: 0, occupancy: null,
    context_window: null, charter: null, mail_pending: 0, limit_locked: false,
    last_status: null, prev_status: null, inflight_at: null, last_denials: [],
    turns: [], frozen: null, audiences_held: [], bearer_state: null,
    generation: 0, children: (n.children ?? []).map(mk), lineage: [],
    scope: { permission_mode: 'default', add_dirs: [], tools: {}, org_visibility: 'team' },
  }
}
function tree(slug: string, roots: FixNode[]): TreePayload {
  return asTree({
    slug, name: slug, workspace: null, dirs: [], max_top_grant: 1000,
    default_top_grant: 50, compact_at: 0, default_tools: null,
    default_visibility: 'team', default_effort: '', credit_requests: [],
    tiers: { haiku: 1, sonnet: 3, opus: 5, fable: 10 }, audiences: [],
    roots: roots.map(mk), cost_usd_total: 0,
    audit: { live_nodes: roots.length, top_level_holds: 0, no_overdraft: true, problems: [] },
    user_inbox_count: 0, user_inbox_newest: null, fable_lock: null,
    spend_frozen: false, storage_blocked: false, auto_resume: false,
    fable_limit_policy: 'freeze', fable_filter_policy: 'halt',
    cascade_hire: false, cascade_alloc: true, sandboxed: false,
    audience_requests: [], org_inbox: null, net: null,
  })
}
const ORG = tree('mine', [{ id: 'boss', children: [{ id: 'a' }, { id: 'b' }] }])

// ------------------------------------------------------------- the readers
type Cam = { x: number; y: number; z: number }
function camera(host: HTMLElement): Cam {
  const space = host.querySelector('.space') as HTMLElement | null
  assert.ok(space, 'no .space element — the canvas did not render')
  const m = /translate\(([-\d.e+]+)px, ?([-\d.e+]+)px\) scale\(([-\d.e+]+)\)/
    .exec(space.style.transform)
  assert.ok(m, `unparsable world transform: ${space.style.transform}`)
  return { x: Number(m[1]), y: Number(m[2]), z: Number(m[3]) }
}
/** the switchboard is open: the EYE card wears `.desk` */
const switchboardOpen = (host: HTMLElement): boolean =>
  !!host.querySelector('.sq.desk.user')
const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps

// -------------------------------------------------------------- the driver
function canvasTest(name: string,
  body: (k: {
    mount: (t?: TreePayload) => Promise<{ host: HTMLElement; unmount: () => Promise<void> }>
  }) => Promise<void>): void {
  test(name, async (t: TestContext) => {
    useFakeClock()
    installFetch(new FakeServer())
    localStorage.clear()
    const open: { unmount: () => Promise<void> }[] = []
    t.after(async () => {
      for (const m of open) { try { await m.unmount() } catch { /* gone */ } }
      resetConvos()
      realClock()
      localStorage.clear()
    })
    await body({
      mount: async (tp = ORG) => {
        const v = await mountView(
          <OrgCanvas tree={tp} op={(() => Promise.resolve({})) as never}
            slug={tp.slug} toast={noop} mailEvt={null} />,
          (el) => el)
        open.push(v)
        return { host: v.el, unmount: v.unmount }
      },
    })
  })
}

// ==========================================================================
canvasTest('§1 CONTROL: with nothing set, the org opens as it always did — '
  + 'parked on the eye, then the glide out to the whole tree', async (k) => {
  const { host } = await k.mount()
  const before = camera(host)
  assert.ok(near(before.z, EYE_Z0),
    `pre-glide frame is z=${before.z}, not the eye park at ${EYE_Z0} — the `
    + 'default no longer glides, or glides from somewhere else')
  await advance(2000)
  const after = camera(host)
  assert.ok(after.z < Z_DESK,
    `landed at z=${after.z} ≥ Z_DESK ${Z_DESK} — the default did not fit the org`)
  assert.ok(!near(after.z, EYE_Z0), 'the camera never left the eye')
  assert.equal(switchboardOpen(host), false,
    'the switchboard opened under the default startup view')
})

// ==========================================================================
canvasTest('§2 "switchboard" opens on the eye’s desk', async (k) => {
  localStorage.setItem('orgtree-start-view', 'switchboard')
  const { host } = await k.mount()
  assert.ok(near(camera(host).z, EYE_Z0), 'the glide still starts on the eye')
  await advance(2000)
  assert.equal(switchboardOpen(host), true,
    'the eye card does not wear .desk — the camera did not land on the '
    + 'switchboard, or not close enough for focusId to name it')
  assert.ok(camera(host).z >= Z_DESK,
    `camera at z=${camera(host).z}, under the desk threshold ${Z_DESK}`)
})

// ==========================================================================
canvasTest('§3 "remember" restores the saved camera EXACTLY, with no glide',
  async (k) => {
    localStorage.setItem('orgtree-start-view', 'remember')
    const saved = { x: -1234.5, y: 77.25, z: 0.61 }
    localStorage.setItem('orgtree-view-mine', JSON.stringify(saved))
    const { host } = await k.mount()
    // BEFORE any tick: a restored view is already in place, no eye park
    const at = camera(host)
    assert.deepEqual(at, saved,
      `first frame is ${JSON.stringify(at)}, not the saved camera — either `
      + 'the restore glides (a frame at the eye first) or it did not restore')
    await advance(2000)
    assert.deepEqual(camera(host), saved,
      'the camera moved after the restore — something glided it away')
  })

// ==========================================================================
canvasTest('§4 "remember" with NO saved camera plays the intro once, and '
  + 'the landing is then saved', async (k) => {
  localStorage.setItem('orgtree-start-view', 'remember')
  assert.equal(localStorage.getItem('orgtree-view-mine'), null)
  const { host } = await k.mount()
  assert.ok(near(camera(host).z, EYE_Z0),
    'a brand-new org under "remember" did not play the intro')
  await advance(2000)
  const landed = camera(host)
  // ⚠ "left the eye", not merely "< Z_DESK": the park at 1.6 is itself under
  // the desk threshold, so a camera that never moved would pass the weaker
  // check (it did — see §4b's header)
  assert.ok(!near(landed.z, EYE_Z0), 'the first-open intro never left the eye')
  assert.ok(landed.z < Z_DESK, 'the first-open intro did not fit the org')
  const raw = localStorage.getItem('orgtree-view-mine')
  assert.ok(raw, 'the landing camera was never saved')
  assert.deepEqual(JSON.parse(raw), landed,
    'the saved camera is not where the intro landed')
})

// ==========================================================================
// ⚠ THE ONE THE BROWSER PROBE CAUGHT FIRST. React's dev StrictMode runs every
// effect twice on mount (mount → cleanup → mount). A save-effect cleanup that
// flushed the pending write landed the eye-park frame under the slug between
// the intro effect's two runs, and the second run "restored" it: under
// `vite dev`, "remember" on a new org parked on the eye and never glided.
// The production build has no double-mount, so only a StrictMode mount can
// see this — which is why this suite mounts one.
canvasTest('§4b …and still under StrictMode’s double-mount: the first-open '
  + 'intro must not be eaten by a save the first mount left behind', async () => {
  localStorage.setItem('orgtree-start-view', 'remember')
  const { StrictMode } = await import('react')
  const v = await mountView(
    <StrictMode>
      <OrgCanvas tree={ORG} op={(() => Promise.resolve({})) as never}
        slug="mine" toast={noop} mailEvt={null} />
    </StrictMode>, (el) => el)
  try {
    assert.ok(near(camera(v.el).z, EYE_Z0),
      'no eye park under StrictMode — the intro did not start')
    await advance(2000)
    // the failure mode is a camera STUCK AT THE PARK — which is under Z_DESK,
    // so only "it left the eye" can see it (a first draft asserted < Z_DESK
    // and passed against the very bug it was written for)
    assert.ok(!near(camera(v.el).z, EYE_Z0),
      `stuck at z=${camera(v.el).z} — the first mount’s save was restored by `
      + 'the second mount as if it were a remembered camera')
    assert.ok(camera(v.el).z < Z_DESK, 'the intro did not land on the fit')
  } finally { await v.unmount() }
})

// ==========================================================================
canvasTest('§5 the camera is saved in EVERY mode, so switching to '
  + '"remember" later has somewhere to go', async (k) => {
  // default mode ('org'), nothing set
  const { host } = await k.mount()
  await advance(2000)
  const landed = camera(host)
  const raw = localStorage.getItem('orgtree-view-mine')
  assert.ok(raw, 'no camera saved under the default mode')
  assert.deepEqual(JSON.parse(raw), landed)
})

// ==========================================================================
canvasTest('§6 zoom OFF: "org" opens already fitted — no eye park, no glide',
  async (k) => {
    localStorage.setItem('orgtree-start-zoom', '0')
    const { host } = await k.mount()
    const first = camera(host)
    assert.ok(!near(first.z, EYE_Z0),
      'the first frame is the eye park at z=1.6 — the intro glided with the '
      + 'zoom animation turned off')
    assert.ok(first.z < Z_DESK, `first frame z=${first.z} is not the org fit`)
    await advance(2000)
    assert.deepEqual(camera(host), first, 'the camera moved after a snap-open')
  })

// ==========================================================================
canvasTest('§6b zoom OFF: "switchboard" opens straight on the eye’s desk',
  async (k) => {
    localStorage.setItem('orgtree-start-zoom', '0')
    localStorage.setItem('orgtree-start-view', 'switchboard')
    const { host } = await k.mount()
    assert.equal(switchboardOpen(host), true,
      'the switchboard is not open on the very first frame')
    const first = camera(host)
    await advance(2000)
    assert.deepEqual(camera(host), first, 'the camera moved after a snap-open')
  })

// ==========================================================================
canvasTest('§7 SCOPE: zoom OFF is IGNORED by "remember" — a new org still '
  + 'plays its one intro', async (k) => {
  localStorage.setItem('orgtree-start-zoom', '0')
  localStorage.setItem('orgtree-start-view', 'remember')
  const { host } = await k.mount()
  assert.ok(near(camera(host).z, EYE_Z0),
    'the zoom toggle suppressed the first-open intro under "remember" — the '
    + 'toggle only governs "org" and "switchboard"')
  await advance(2000)
  assert.ok(!near(camera(host).z, EYE_Z0), 'the intro never left the eye')
  assert.ok(camera(host).z < Z_DESK, 'the intro did not land on the fit')
})

// ==========================================================================
canvasTest('§8 switching org lands the OLD org’s last camera before the new '
  + 'org takes over', async (k) => {
  localStorage.setItem('orgtree-start-view', 'remember')
  const other = tree('theirs', [{ id: 'chief' }])
  const savedTheirs = { x: 10, y: 20, z: 0.5 }
  localStorage.setItem('orgtree-view-theirs', JSON.stringify(savedTheirs))
  const { createRoot } = await import('react-dom/client')
  const { act } = await import('react')
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  const render = (tp: TreePayload) => act(async () => {
    root.render(<OrgCanvas tree={tp} op={(() => Promise.resolve({})) as never}
      slug={tp.slug} toast={noop} mailEvt={null} />)
  })
  try {
    await render(ORG)
    await advance(2000)
    const mineLanded = camera(host)
    // switch orgs — and do NOT wait out the debounce: the pending write for
    // 'mine' must land on the switch itself, not be dropped
    await render(other)
    assert.deepEqual(camera(host), savedTheirs,
      'the new org did not restore its own saved camera')
    assert.deepEqual(JSON.parse(localStorage.getItem('orgtree-view-mine')!),
      mineLanded, 'the old org’s last camera was lost on the switch')
    await advance(1000)
    assert.deepEqual(JSON.parse(localStorage.getItem('orgtree-view-theirs')!),
      savedTheirs, 'the new org’s restored camera was overwritten by the old '
      + 'org’s view — the debounced save paired a view with the wrong slug')
    assert.deepEqual(JSON.parse(localStorage.getItem('orgtree-view-mine')!),
      mineLanded, 'the old org’s camera was overwritten after the switch')
  } finally {
    await act(async () => { root.unmount() })
    host.remove()
  }
})

// ==========================================================================
canvasTest('§9 a corrupt saved camera is treated as none — the intro plays',
  async (k) => {
    localStorage.setItem('orgtree-start-view', 'remember')
    localStorage.setItem('orgtree-view-mine', '{"x":"nope","y":1}')
    const { host } = await k.mount()
    assert.ok(near(camera(host).z, EYE_Z0),
      'a garbage saved camera was restored instead of ignored')
  })

// ==========================================================================
// the settings surface: App settings → Display → Startup
const ACCOUNTS: AccountsPayload = {
  version: 2,
  primary: { id: 'primary', signed_in: true, email: 'me@example.test' },
  keys: [], assignments: {},
} as unknown as AccountsPayload
const PROVIDERS: ProvidersPayload = { providers: [] }
const g = globalThis as unknown as Record<string, unknown>
function stubFetch(): void {
  g.fetch = (url: string, init?: RequestInit) => {
    const path = new URL(String(url), 'http://localhost').pathname
    const method = init?.method ?? 'GET'
    const payload = path === '/api/accounts' ? ACCOUNTS
      : path === '/api/providers' ? PROVIDERS
        : path === '/api/app-settings/runtime' && method === 'GET'
          ? { warming_enabled: true, working_checkups_enabled: true,
              wait_for_mcp_tools_enabled: false }
          : null
    if (!payload) return Promise.reject(new Error(`unexpected ${method} ${path}`))
    return Promise.resolve({
      ok: true, status: 200, headers: new Headers(),
      json: () => Promise.resolve(payload),
    })
  }
}
async function openDisplay() {
  const view = await mountView(
    <AccountsPanel toast={() => {}} close={() => {}} />, (el) => el)
  await inAct(async () => { await flush(10) })
  const tab = [...view.el.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
    .find((b) => b.textContent?.includes('Display'))!
  await inAct(async () => { tab.click() })
  const panel = view.el.querySelector<HTMLElement>('#app-settings-panel-display')!
  const select = panel.querySelector<HTMLSelectElement>(
    'select[aria-label="open an org at"]')!
  const toggle = panel.querySelector<HTMLInputElement>(
    'input[aria-label="play the starting zoom"]')!
  assert.ok(select, 'no startup-view select in Display')
  assert.ok(toggle, 'no starting-zoom toggle in Display')
  return { view, panel, select, toggle }
}
async function pick(select: HTMLSelectElement, value: string) {
  const w = (globalThis as unknown as { window: Window }).window as unknown as {
    HTMLSelectElement: typeof HTMLSelectElement
    Event: typeof Event
  }
  const setter = Object.getOwnPropertyDescriptor(
    w.HTMLSelectElement.prototype, 'value')?.set
  assert.ok(setter, 'no value setter on HTMLSelectElement')
  await inAct(async () => {
    setter.call(select, value)
    select.dispatchEvent(new w.Event('change', { bubbles: true }))
  })
}

test('§10 Display → Startup: the select and toggle write the browser-local '
  + 'keys, and the toggle goes inert under "where I left off"', async () => {
  localStorage.clear()
  stubFetch()
  let s = await openDisplay()
  try {
    assert.equal(s.select.value, 'org', 'default startup view is not the full org')
    assert.equal(s.toggle.checked, true, 'starting zoom does not default on')
    assert.equal(s.toggle.disabled, false)
    assert.deepEqual([...s.select.options].map((o) => o.value),
      ['org', 'switchboard', 'remember'])

    await inAct(async () => { s.toggle.click() })
    assert.equal(localStorage.getItem('orgtree-start-zoom'), '0')
    assert.equal(s.toggle.checked, false)

    await pick(s.select, 'switchboard')
    assert.equal(localStorage.getItem('orgtree-start-view'), 'switchboard')
    assert.equal(s.toggle.disabled, false, 'the toggle applies to the switchboard')

    await pick(s.select, 'remember')
    assert.equal(localStorage.getItem('orgtree-start-view'), 'remember')
    assert.equal(s.toggle.disabled, true,
      'the toggle stayed live under "where I left off", which ignores it')
    assert.match(s.panel.textContent ?? '', /not used by/)
    // the choice the toggle held is KEPT, not reset, so leaving 'remember'
    // brings it back as it was
    assert.equal(localStorage.getItem('orgtree-start-zoom'), '0')
  } finally { await s.view.unmount() }

  // the reload boundary: a fresh panel reads the stored values back
  s = await openDisplay()
  try {
    assert.equal(s.select.value, 'remember')
    assert.equal(s.toggle.checked, false)
    assert.equal(s.toggle.disabled, true)
    await pick(s.select, 'org')
    assert.equal(s.toggle.disabled, false)
    assert.equal(s.toggle.checked, false, 'the kept choice did not come back')
  } finally { await s.view.unmount(); delete g.fetch; localStorage.clear() }
})
