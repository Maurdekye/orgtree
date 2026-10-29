// letterchip-centring.test.tsx — METRIC-INDEPENDENT LETTER-CHIP CENTRING
// (docket `hire-tokens-letter-sits-off-centre-on-linux`, USER md447762e475e +
// UX symmetry rule mb6da9f3ee862).
//
// On Linux, fallback fonts carry different ascent/descent and baseline metrics
// than Windows/macOS, so centring a single letter inside a circular or rounded
// chip via default button layout, inherited `line-height: 1.5`, or `font:`
// shorthands (which reset `line-height` to `normal`) shifts the glyph off
// centre. Every letter-in-a-circle / model-letter chip surface shares the
// `.letter-chip` class and metric-independent flex centring (`display:
// inline-flex; align-items: center; justify-content: center; padding: 0;
// line-height: 1; text-align: center`).
//
// Run:  cd apps/desktop/renderer && node tests/run.mjs letterchip-centring

import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import { flush, inAct, mountView } from './harness'
import { TierStandings } from '../src/canvas/accounts'
import { DraftNode, NodeSquare, SpawnChips } from '../src/canvas/cards'
import { DeskModelButton } from '../src/canvas/deskmodel'
import { createTierChipEl, TierChip } from '../src/canvas/identity'
import { NodeConfig, PilePicker } from '../src/canvas/modals'
import { OrgPictureEditor } from '../src/canvas/orgpicture'
import { HubContactChip, setHubchatInstalled } from '../src/canvas/agentmentions'
import { resetNetMentions, setNetRoster } from '../src/canvas/netmentions'
import type { CanvasNode } from '../src/canvas/shared'
import type { NetBlock, OpResult, TreePayload } from '../src/types'

declare const __SRC_DIR__: string

const noop = () => {}
const op = () => Promise.resolve({} as OpResult)
const offer = { enabled: true, installed: true, reason: null }
const signedOutOffer = { enabled: false, installed: true, signedOut: true, reason: 'run codex login' }
const seats = { haiku: 1, sonnet: 2, opus: 5, fable: 10, terra: 2, sol: 5, flash: 1, pro: 2 }

function loadStylesheets(): () => void {
  const css = readFileSync(path.join(__SRC_DIR__, 'styles.css'), 'utf8')
  const logoCss = readFileSync(path.join(__SRC_DIR__, 'canvas', 'orglogo.css'), 'utf8')
  const styleEl = document.createElement('style')
  styleEl.textContent = `${css}\n${logoCss}`
  document.head.appendChild(styleEl)
  return () => styleEl.remove()
}

function assertCentredLetterChip(el: Element | null, label: string): void {
  assert.ok(el, `${label}: element exists`)
  assert.equal(
    el.classList.contains('letter-chip'),
    true,
    `${label}: carries shared .letter-chip class (got "${el.className}")`,
  )
  const cs = window.getComputedStyle(el)
  assert.equal(cs.display, 'inline-flex', `${label}: computed display is inline-flex`)
  assert.equal(cs.alignItems, 'center', `${label}: computed align-items is center`)
  assert.equal(cs.justifyContent, 'center', `${label}: computed justify-content is center`)
  assert.equal(cs.lineHeight, '1', `${label}: computed line-height is 1 (metric-independent)`)
  assert.equal(cs.paddingTop, '0px', `${label}: computed padding-top is 0px`)
  assert.equal(cs.paddingBottom, '0px', `${label}: computed padding-bottom is 0px`)
  assert.equal(cs.paddingLeft, '0px', `${label}: computed padding-left is 0px`)
  assert.equal(cs.paddingRight, '0px', `${label}: computed padding-right is 0px`)
  assert.equal(cs.textAlign, 'center', `${label}: computed text-align is center`)
}

const sampleNode: CanvasNode = {
  id: 'coord-opus',
  title: 'coord-opus',
  tier: 'opus',
  state: 'live',
  children: [],
  seat: 5,
  grant: 20,
  free: 20,
  cost_usd: 0,
  occupancy: null,
  turns: [],
  frozen: null,
  last_denials: [],
  audiences_held: [],
  lineage: [],
  generation: 0, scope: { add_dirs: [], tools: { bash: true, web: true, edit: true, subagents: true, mcp: [] }, org_visibility: 'full', permission_mode: 'acceptEdits' },
}

const sampleTree: TreePayload = {
  slug: 'orgtree',
  name: 'Orgtree',
  roots: [sampleNode],
  dirs: [],
  tiers: seats,
  default_top_grant: 12,
  max_top_grant: 100,
  cascade_hire: true,
  audiences: [],
  audience_requests: [],
  credit_requests: [],
  user_inbox_count: 0,
  default_visibility: 'team',
  default_tools: {},
} as unknown as TreePayload

test('§1 shipped stylesheets define metric-independent flex centring on .letter-chip, .hsof button, .tier, .desk-model-button, and .org-logo-avatar', () => {
  const css = readFileSync(path.join(__SRC_DIR__, 'styles.css'), 'utf8')
  const logoCss = readFileSync(path.join(__SRC_DIR__, 'canvas', 'orglogo.css'), 'utf8')
  const rule = (sheet: string, sel: string) => {
    const escaped = sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); const match = sheet.match(new RegExp(`(?:^|\\r?\\n)${escaped} \\{([^}]*)\\}`))
    assert.ok(match, `stylesheet has top-level "${sel} {" rule`)
    return match[1]!
  }

  const shared = rule(css, '.letter-chip')
  assert.match(shared, /display:\s*inline-flex/, '.letter-chip sets inline-flex')
  assert.match(shared, /align-items:\s*center/, '.letter-chip centres vertically')
  assert.match(shared, /justify-content:\s*center/, '.letter-chip centres horizontally')
  assert.match(shared, /line-height:\s*1\b/, '.letter-chip pins line-height: 1')
  assert.match(shared, /padding:\s*0\b/, '.letter-chip zeroes padding')
  assert.match(shared, /text-align:\s*center/, '.letter-chip centres text')

  const hsofBtn = rule(css, '.hsof button')
  assert.match(hsofBtn, /border-radius:\s*50%/, '.hsof button remains a circle')
  assert.match(hsofBtn, /display:\s*inline-flex/, '.hsof button uses inline-flex')
  assert.match(hsofBtn, /align-items:\s*center/, '.hsof button centres vertically')
  assert.match(hsofBtn, /justify-content:\s*center/, '.hsof button centres horizontally')
  assert.match(hsofBtn, /line-height:\s*1\b/, '.hsof button pins line-height: 1')

  const tierRule = rule(css, '.tier')
  assert.match(tierRule, /display:\s*inline-flex/, '.tier uses inline-flex')
  assert.match(tierRule, /align-items:\s*center/, '.tier centres vertically')
  assert.match(tierRule, /justify-content:\s*center/, '.tier centres horizontally')
  assert.match(tierRule, /line-height:\s*1\b/, '.tier pins line-height: 1')

  const deskBtn = rule(css, '.desk-model-button')
  assert.match(deskBtn, /line-height:\s*1\b/, '.desk-model-button preserves line-height: 1 after font reset')

  const avatarRule = rule(logoCss, '.org-logo-avatar')
  assert.match(avatarRule, /display:\s*inline-flex/, '.org-logo-avatar uses inline-flex')
  assert.match(avatarRule, /align-items:\s*center/, '.org-logo-avatar centres vertically')
  assert.match(avatarRule, /justify-content:\s*center/, '.org-logo-avatar centres horizontally')
  assert.match(avatarRule, /line-height:\s*1\b/, '.org-logo-avatar pins line-height: 1')
  assert.match(avatarRule, /letter-spacing:\s*0\b/, '.org-logo-avatar zeroes trailing letter-spacing')
})

test('§2 hire tokens (offered, signed-out preview, and far-zoom expand arrow) share .letter-chip centring while .hs-none text pills do not', async (t) => {
  const cleanupCss = loadStylesheets()
  t.after(cleanupCss)

  const view = await mountView(
    <SpawnChips
      onSpawn={noop}
      seats={seats}
      claudeHire={offer}
      codexHire={signedOutOffer}
      zoom={0.25}
      expanded={true}
    />,
    (el) => el,
  )
  t.after(() => view.unmount())

  assertCentredLetterChip(
    view.el.querySelector('.hsof button.t-opus'),
    'offered hire token (.hsof button.t-opus)',
  )
  assertCentredLetterChip(
    view.el.querySelector('.hsof button.t-sol.codex-preview'),
    'signed-out preview hire token (.hsof button.t-sol.codex-preview)',
  )
  assertCentredLetterChip(
    view.el.querySelector('.hsof button.hire-expand'),
    'far-zoom compact expand button (.hsof button.hire-expand)',
  )

  const noneView = await mountView(
    <SpawnChips
      onSpawn={noop}
      seats={seats}
      claudeHire={{ enabled: false, installed: false, reason: 'missing' }} codexHire={{ enabled: false, installed: false, reason: 'missing' }} antigravityHire={{ enabled: false, installed: false, reason: 'missing' }} museHire={{ enabled: false, installed: false, reason: 'missing' }}
    />,
    (el) => el,
  )
  t.after(() => noneView.unmount())
  const noneBtn = noneView.el.querySelector('.hsof button.hs-none')
  assert.ok(noneBtn, 'no-harness status pill renders')
  assert.equal(
    noneBtn.classList.contains('letter-chip'),
    false,
    '.hs-none multi-word status pill is not a single-glyph letter chip',
  )
})

test('§3 desk model letter and node model letters (TierChip, createTierChipEl, NodeSquare norm/mini/map, NodeConfig, PilePicker) share .letter-chip centring', async (t) => {
  const cleanupCss = loadStylesheets()
  t.after(cleanupCss)

  const oldFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = oldFetch })
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ tiers: [], providers: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })

  // 1. DeskModelButton (live button and archived span)
  const liveDesk = await mountView(
    <DeskModelButton node={sampleNode} slug="orgtree" op={op} toast={noop} />,
    (el) => el,
  )
  t.after(() => liveDesk.unmount())
  assertCentredLetterChip(
    liveDesk.el.querySelector('button.tier.desk-model-button.t-opus'),
    'live DeskModelButton',
  )

  const archivedDesk = await mountView(
    <DeskModelButton node={{ ...sampleNode, state: 'archived' }} slug="orgtree" op={op} toast={noop} />,
    (el) => el,
  )
  t.after(() => archivedDesk.unmount())
  assertCentredLetterChip(
    archivedDesk.el.querySelector('span.tier.t-opus'),
    'archived DeskModelButton (TierChip)',
  )

  // 2. TierChip and createTierChipEl parity
  const tierChipView = await mountView(<TierChip tier="opus" agentName="coord-opus" />, (el) => el)
  t.after(() => tierChipView.unmount())
  const reactTierEl = tierChipView.el.querySelector('.tier')
  const domTierEl = createTierChipEl(document, 'opus', 'coord-opus')!
  document.body.appendChild(domTierEl)
  t.after(() => domTierEl.remove())
  assertCentredLetterChip(reactTierEl, 'TierChip React element')
  assertCentredLetterChip(domTierEl, 'createTierChipEl DOM element')
  assert.equal(domTierEl.className, reactTierEl?.className, 'createTierChipEl and TierChip emit identical className')

  // 3. NodeSquare in norm, mini, and mapMode
  const map = new Map([[sampleNode.id, sampleNode]])
  const normCard = await mountView(
    <NodeSquare
      node={sampleNode}
      pos={{ x: 0, y: 0 }}
      lod="norm"
      focused={false}
      dragging={false}
      isDrop={false}
      seats={seats}
      claudeHire={offer}
      map={map}
      op={op}
      slug="orgtree"
      toast={noop}
      pxc={1}
      zoom={1}
      onSpawn={noop}
      onConfig={noop}
      onInbox={noop}
      onLineage={noop}
      onDragStart={noop}
      onDragMove={noop}
      onDragEnd={noop}
      onDragCancel={noop}
    />,
    (el) => el,
  )
  t.after(() => normCard.unmount())
  assertCentredLetterChip(
    normCard.el.querySelector('.sq-head .tier.t-opus'),
    'NodeSquare norm header .sq-head .tier',
  )

  const miniCard = await mountView(
    <NodeSquare
      node={sampleNode}
      pos={{ x: 0, y: 0 }}
      lod="mini"
      focused={false}
      dragging={false}
      isDrop={false}
      seats={seats}
      claudeHire={offer}
      map={map}
      op={op}
      slug="orgtree"
      toast={noop}
      pxc={1}
      zoom={0.35}
      onSpawn={noop}
      onConfig={noop}
      onInbox={noop}
      onLineage={noop}
      onDragStart={noop}
      onDragMove={noop}
      onDragEnd={noop}
      onDragCancel={noop}
    />,
    (el) => el,
  )
  t.after(() => miniCard.unmount())
  assertCentredLetterChip(
    miniCard.el.querySelector('.sq-far-tier .tier.t-opus'),
    'NodeSquare mini .sq-far-tier .tier',
  )

  const mapCard = await mountView(
    <NodeSquare
      node={sampleNode}
      pos={{ x: 0, y: 0 }}
      lod="norm"
      mapMode={true}
      focused={false}
      dragging={false}
      isDrop={false}
      seats={seats}
      claudeHire={offer}
      map={map}
      op={op}
      slug="orgtree"
      toast={noop}
      pxc={1}
      zoom={1}
      onSpawn={noop}
      onConfig={noop}
      onInbox={noop}
      onLineage={noop}
      onDragStart={noop}
      onDragMove={noop}
      onDragEnd={noop}
      onDragCancel={noop}
    />,
    (el) => el,
  )
  t.after(() => mapCard.unmount())
  assertCentredLetterChip(
    mapCard.el.querySelector('.map-top .tier.t-opus'),
    'NodeSquare mapMode .map-top .tier',
  )

  // 4. NodeConfig and PilePicker
  const cfgView = await mountView(
    <NodeConfig
      node={sampleNode}
      map={map}
      tree={sampleTree}
      slug="orgtree"
      op={op}
      toast={noop}
      close={noop}
    />,
    (el) => el,
  )
  t.after(() => cfgView.unmount())
  const cfgIcons = [...cfgView.el.querySelectorAll('.agent-model-icon.tier.t-opus')]
  assert.ok(cfgIcons.length >= 1, 'NodeConfig renders .agent-model-icon.tier')
  for (const icon of cfgIcons) {
    assertCentredLetterChip(icon, 'NodeConfig .agent-model-icon.tier')
  }

  const pileView = await mountView(
    <PilePicker
      pile={{ kind: 'r', parent: 'user', list: [sampleNode.id], front: sampleNode.id }}
      map={map}
      onPick={noop}
      close={noop}
    />,
    (el) => el,
  )
  t.after(() => pileView.unmount())
  assertCentredLetterChip(
    document.querySelector('.pile-row .tier.t-opus'),
    'PilePicker .pile-row .tier',
  )
})

test('§4 tier pickers (DraftNode model button + popover, TierStandings) and OrgPictureEditor initials avatar share .letter-chip centring', async (t) => {
  const cleanupCss = loadStylesheets()
  t.after(cleanupCss)

  const oldFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = oldFetch })
  globalThis.fetch = async (url) => {
    if (String(url).includes('/picture')) {
      return new Response(JSON.stringify({ owner: 1, picture: null }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    return new Response(JSON.stringify({ presets: [], tiers: [], providers: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  // 1. DraftNode model button (.df-model.tier)
  const draftView = await mountView(
    <DraftNode
      pos={{ x: 0, y: 0 }}
      draft={{ parent: null, tier: 'haiku' }}
      tree={sampleTree}
      seats={seats}
      claudeHire={offer}
      map={new Map()}
      maxTop={100}
      defaultTop={12}
      zoom={1}
      pxc={1}
      onConfirm={noop}
      onCancel={noop}
      onTierChange={noop}
    />,
    (el) => el,
  )
  t.after(() => draftView.unmount())
  const dfModelBtn = draftView.el.querySelector<HTMLButtonElement>('.df-head button.df-model.tier.t-haiku')
  assertCentredLetterChip(dfModelBtn, 'DraftNode .df-head button.df-model.tier')

  await inAct(async () => {
    dfModelBtn!.click()
    await flush()
  })
  assertCentredLetterChip(
    document.querySelector('.draft-model-picker .hsof button.t-opus'),
    'DraftNode opened .draft-model-picker .hsof button.t-opus',
  )

  // 2. TierStandings in Accounts
  const standingsView = await mountView(
    <TierStandings
      tiers={[
        { tier: 'opus', available: true, refresh_at: null },
        { tier: 'sonnet', available: false, refresh_at: '2026-10-30T00:00:00Z' },
      ]}
    />,
    (el) => el,
  )
  t.after(() => standingsView.unmount())
  assertCentredLetterChip(
    standingsView.el.querySelector('.acct-tier-row .tier.t-opus'),
    'TierStandings available .acct-tier-row .tier.t-opus',
  )
  assertCentredLetterChip(
    standingsView.el.querySelector('.acct-tier-row .tier.t-sonnet.acct-chip-dim'),
    'TierStandings dim .acct-tier-row .tier.t-sonnet.acct-chip-dim',
  )

  // 3. OrgPictureEditor initials avatar (.org-logo-avatar)
  const logoView = await mountView(
    <OrgPictureEditor slug="orgtree" name="One Team" />,
    (el) => el,
  )
  t.after(() => logoView.unmount())
  await inAct(() => flush())
  const avatar = logoView.el.querySelector('.org-logo-avatar')
  assert.equal(avatar?.textContent, 'OT', 'OrgPictureEditor renders fallback initials')
  assertCentredLetterChip(avatar, 'OrgPictureEditor .org-logo-avatar initials circle')
  assert.equal(
    window.getComputedStyle(avatar!).letterSpacing,
    '0px',
    'OrgPictureEditor .org-logo-avatar has 0px letter-spacing so initials sit horizontally centred',
  )
})

// §5 UX symmetry S2 #2 (USER 2026-10-29 m019c9500d23a "A2 use the lettering on
// the colored background as the icon instead of the hubchat icon when hubchat
// is connected for both"): a network chip's letters avatar is one more letter
// in a tile, so it shares .letter-chip and its centring. netmentions.css loads
// after styles.css, as in the app, so the mark's own rule must agree with
// .letter-chip rather than override it.
test('§5 a network chip\'s letters avatar (with Hubchat) shares .letter-chip centring', async (t) => {
  const css = readFileSync(path.join(__SRC_DIR__, 'styles.css'), 'utf8')
  const netCss = readFileSync(path.join(__SRC_DIR__, 'canvas', 'netmentions.css'), 'utf8')
  const styleEl = document.createElement('style')
  styleEl.textContent = `${css}\n${netCss}`
  document.head.appendChild(styleEl)
  const oldFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const body = String(input).endsWith('/api/desktop/phone') ? { hubchat_pc: true } : { picture: null }
    return { ok: true, status: 200, headers: new Headers(), json: async () => body } as unknown as Response
  }) as typeof fetch
  await inAct(async () => {
    setHubchatInstalled(true)
    setNetRoster('orgtree', { slug: 'orgtree.syn.0fff', hubs: [{ id: 'local', address: 'http://127.0.0.1:7370',
      name: 'hub', version: '2.2.0', enabled: true, connected: true, queued: 0,
      roster: [{ slug: 'acme-labs.syn.1001', kind: 'org', online: true, blurb: '', org_name: 'Acme Labs' }] }] } as unknown as NetBlock)
  })
  const view = await mountView(<HubContactChip address="@net:acme-labs.syn.1001" />, h => h)
  t.after(async () => {
    await view.unmount(); styleEl.remove(); globalThis.fetch = oldFetch
    await inAct(async () => { resetNetMentions(); setHubchatInstalled(false); await flush(2) })
  })
  await flush(2)
  const mark = view.el.querySelector('.net-mark')
  assert.ok(mark?.classList.contains('net-mark-letters'), `the mark is the letters avatar (got "${mark?.className}")`)
  assert.equal(mark?.getAttribute('data-initials'), 'AL')
  assertCentredLetterChip(mark, 'network chip letters avatar')
})
