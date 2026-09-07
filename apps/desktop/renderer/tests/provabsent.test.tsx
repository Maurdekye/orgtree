// D-202 — a provider this machine does not have is absent from the WHOLE UI.
//
// The user (2026-08-30): "if codex isnt installed at all, then codex shouldnt
// appear anywhere in the ui whatsoever; it should be entirely absent. same
// with antigravity. with claude, since orgtree is built around it, do show that its
// not installed on the accounts page, but make it a very small piece of ui."
//
// D-199 answered that for the HIRE buttons. This widens it to every surface,
// and the widening is where the risk is: the failure mode is one leftover
// mention — a legend entry, an optgroup, a usage heading — on a machine that
// has never had the provider. So each surface is asserted SEPARATELY. A pass
// on the accounts page proves nothing about the model dropdown; that is the
// exact lesson of D-199, where the same rule was implemented four times and
// disagreed with itself.
//
// ⚠ THE DISTINCTION UNDER TEST IS ABSENT vs GREYED-OUT, not "unavailable".
// The user confirmed the middle state separately: "if it is installed but not
// configured, thats when it appears in the ui with greyed out hire tokens."
// So every "is hidden" assertion below is paired with a signed-out case that
// must still be VISIBLE. Without that pairing a blanket `return null` would
// pass this whole file while destroying the behaviour the user asked to keep.

import { flush, inAct, installFetch, FakeServer, mountView } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import {
  ALL_PRESENT, familyOffer, hireOf, presenceOf, presenceOfPayload,
  providerShown, tierShown, USER,
} from '../src/canvas/shared'
import type { CanvasNode, HireState, ProviderPresence } from '../src/canvas/shared'
import { NodeConfig } from '../src/canvas/modals'
import { LineagePanel } from '../src/canvas/desk'
import { AccountsPanel } from '../src/canvas/accounts'
import { UsageModal, usageTitle } from '../src/App'
import type {
  AccountsPayload, AccountUsage, LineageEntry, OpRequest, OpResult,
  ProviderInfo, ProvidersPayload, TreePayload, UsageAllPayload,
} from '../src/types'

const noop = () => {}

const CLAUDE = ['haiku', 'sonnet', 'opus', 'fable']
const CODEX = ['luna', 'terra', 'sol']
const ANTIGRAVITY = ['flash', 'pro']

// ------------------------------------------------------- provider fixtures
// Built from the REAL payload shape (`ProviderInfo`) rather than a hand-made
// HireState, so the narrowing in `hireOf` is exercised too — that adapter is
// where `installed` could quietly stop being read.

function prov(id: string, o: {
  installed?: boolean; connected?: boolean; userEnabled?: boolean
} = {}): ProviderInfo {
  const installed = o.installed ?? true
  const connected = o.connected ?? true
  return {
    id,
    label: id === 'openai' ? 'Codex' : id === 'google' ? 'Antigravity' : 'Claude',
    cli: id === 'openai' ? 'Codex CLI' : id === 'google' ? 'Antigravity CLI'
      : 'Claude Code',
    tiers: [],
    status: { installed, connected, kind: 'chatgpt' },
    hire_enabled: installed && connected,
    reason: !installed ? 'not installed — npm install --prefix /x pkg'
      : !connected ? 'not signed in — run the CLI once' : null,
    ...(o.userEnabled === undefined ? {} : { user_enabled: o.userEnabled }),
  }
}

const ON = (id: string) => prov(id)
const SIGNED_OUT = (id: string) => prov(id, { connected: false })
const ABSENT = (id: string) => prov(id, { installed: false, connected: false })

// ============================================================ §1 the rule
// Every surface below is this pair of functions plus markup, so they are
// pinned directly first — a surface test that passed while the rule was wrong
// would be measuring its own fixture.

test('§1 providerShown: absent is NOT shown', () => {
  assert.equal(providerShown(hireOf(ABSENT('openai'))), false)
})

test('§1 providerShown: installed-but-signed-out IS shown', () => {
  // the anti-vacuity leg, and the whole reason this file pairs its cases.
  // If `providerShown` returned false for everything unavailable, every
  // "is hidden" assertion in §2–§6 would pass while the user-confirmed
  // greyed-out state was silently deleted.
  assert.equal(providerShown(hireOf(SIGNED_OUT('openai'))), true)
})

test('§1 providerShown: configured IS shown', () => {
  assert.equal(providerShown(hireOf(ON('openai'))), true)
})

test('§1 providerShown: UNKNOWN is shown — detection failure must not erase '
  + 'a provider the user actually has', () => {
  assert.equal(providerShown(null), true)
  assert.equal(providerShown(undefined), true)
  assert.equal(hireOf(null), null)
})

test('§1 providerShown is EXACTLY familyOffer — one question, not two', () => {
  // the hire strips and the wider UI must never disagree about whether a
  // provider exists. Pinning the identity is cheaper than discovering the
  // divergence on a surface nobody re-checked.
  for (const p of [ON('openai'), SIGNED_OUT('openai'), ABSENT('openai')]) {
    const h = hireOf(p)
    assert.equal(providerShown(h), familyOffer(h) !== 'hide',
      `disagreement for ${JSON.stringify(p.status)}`)
  }
})

test('§1 tierShown: a family that is absent contributes no tiers', () => {
  const pres = presenceOf({ claude: ON('claude'), openai: ABSENT('openai'),
                            google: ABSENT('google') })
  for (const t of CODEX) assert.equal(tierShown(pres, t), false, t)
  for (const t of ANTIGRAVITY) assert.equal(tierShown(pres, t), false, t)
  for (const t of CLAUDE) assert.equal(tierShown(pres, t), true, t)
})

test('§1 tierShown: `keep` survives its provider vanishing', () => {
  // a node's OWN tier stays listed whatever happened to its CLI. Two reasons,
  // and the second is a data-loss bug rather than a cosmetic one: a <select>
  // whose value is absent from its options renders BLANK, so "open settings,
  // change nothing, save" would silently switch the model.
  const pres = presenceOf({ claude: ON('claude'), openai: ABSENT('openai'),
                            google: ABSENT('google') })
  assert.equal(tierShown(pres, 'sol', 'sol'), true)
  assert.equal(tierShown(pres, 'luna', 'sol'), false,
    'keeping one tier must not readmit its siblings')
})

test('§1 presenceOfPayload: an unresolved payload is ALL_PRESENT', () => {
  assert.deepEqual(presenceOfPayload(null), ALL_PRESENT)
  assert.deepEqual(presenceOfPayload(undefined), ALL_PRESENT)
})

test('§1 presenceOfPayload: an entry the backend omits is shown, not hidden',
  () => {
    // an older backend that serves no 'google' entry must not read as
    // "Antigravity is uninstalled" — same optimism, same reason.
    const pres = presenceOfPayload({ providers: [ABSENT('openai')] })
    assert.equal(pres.openai, false)
    assert.equal(pres.google, true)
    assert.equal(pres.claude, true)
  })

test('§1 D-203 seam: userEnabled === false hides; missing changes nothing',
  () => {
    assert.equal(providerShown(hireOf(prov('openai', { userEnabled: false }))),
      false, 'a provider switched off in settings is hidden like an absent one')
    assert.equal(providerShown(hireOf(prov('openai', { userEnabled: true }))),
      true)
    // ⚠ the load-bearing half: a backend that has never heard of the field
    // must not read as every provider disabled.
    assert.equal(prov('openai').user_enabled, undefined)
    assert.equal(providerShown(hireOf(prov('openai'))), true)
  })

// ================================================ §2 the model-switch panel

function tree(extra: Partial<TreePayload> = {}): TreePayload {
  return {
    slug: 'org', dirs: [], tiers: {
      haiku: 1, sonnet: 2, opus: 5, fable: 10,
      'gpt-reserve': 0.2, luna: 0.2, terra: 2, sol: 5, flash: 1, pro: 2,
    }, max_top_grant: 100, default_effort: '', effort_default: 'high',
    cascade_hire: true, sandboxed: false, ...extra,
  } as TreePayload
}

function node(tier = 'haiku'): CanvasNode {
  return {
    id: 'agent', title: 'agent', state: 'live', tier, model_id: tier,
    parent: USER, children: [], seat: 1, grant: 10, free: 10,
    scope: { permission_mode: 'acceptEdits', add_dirs: [], tools: {
      bash: true, web: true, edit: true, subagents: true, mcp: [],
    }, org_visibility: 'team' },
    charter: '', team_charter: '', turns: [], audiences_held: [],
  } as unknown as CanvasNode
}

function configTest(name: string, body: (mount: (o: {
  node?: CanvasNode; presence: ProviderPresence
  codex?: ProviderInfo | null; antigravity?: ProviderInfo | null
}) => Promise<HTMLElement>) => Promise<void>): void {
  test(name, async (t: TestContext) => {
    installFetch(new FakeServer())
    const open: { unmount: () => Promise<void> }[] = []
    t.after(async () => { for (const v of open) await v.unmount() })
    await body(async (o) => {
      const nd = o.node ?? node()
      const v = await mountView(
        <NodeConfig node={nd} map={new Map([[nd.id, nd]])} tree={tree()}
          slug="org" toast={noop}
          op={(_x: OpRequest) => Promise.resolve({} as OpResult)}
          codexProvider={o.codex === undefined ? ON('openai') : o.codex}
          antigravityProvider={o.antigravity === undefined ? ON('google') : o.antigravity}
          presence={o.presence} close={noop} />,
        (el) => el,
      )
      open.push(v)
      return v.el
    })
  })
}

const groups = (el: HTMLElement) =>
  [...el.querySelectorAll<HTMLOptGroupElement>('.model-switch optgroup')]
    .map((g) => g.label)
const optValues = (el: HTMLElement) =>
  [...el.querySelectorAll<HTMLOptionElement>('.model-switch option')]
    .map((o) => o.value)

configTest('§2 an absent provider contributes no optgroup and no option',
  async (mount) => {
    const el = await mount({
      presence: { claude: true, openai: false, google: false, openrouter: false },
      codex: ABSENT('openai'), antigravity: ABSENT('google'),
    })
    assert.deepEqual(groups(el), ['Claude'],
      'a Codex optgroup on a Codex-less machine is the whole defect')
    const vals = optValues(el)
    for (const t of [...CODEX, ...ANTIGRAVITY]) {
      assert.ok(!vals.includes(t), `${t} must not be listed`)
    }
    for (const t of CLAUDE) assert.ok(vals.includes(t), `${t} missing`)
    // and not as an EMPTY group either — a bare "Codex" heading is still a
    // mention, and an empty optgroup renders its label.
    assert.ok(!(el.textContent ?? '').includes('Codex'))
    assert.ok(!(el.textContent ?? '').includes('Antigravity'))
  })

configTest('§2 SIGNED OUT is the opposite case: listed, disabled, with reason',
  async (mount) => {
    const el = await mount({
      presence: { claude: true, openai: true, google: false, openrouter: false },
      codex: SIGNED_OUT('openai'), antigravity: ABSENT('google'),
    })
    assert.deepEqual(groups(el), ['Claude', 'Codex'])
    const opts = [...el.querySelectorAll<HTMLOptionElement>(
      '.model-switch option')]
    const sol = opts.find((o) => o.value === 'sol')
    assert.ok(sol, 'an installed provider stays listed even when signed out')
    assert.equal(sol.disabled, true)
    assert.match(sol.textContent ?? '', /not signed in/,
      'the greyed-out row must still carry its remedy')
  })

configTest('§2 the node KEEPS ITS OWN TIER when its provider vanished',
  async (mount) => {
    // a codex agent on a machine whose codex CLI has gone. Hiding its own tier
    // would blank the select and let a no-op save rewrite the model.
    const el = await mount({
      node: node('sol'),
      presence: { claude: true, openai: false, google: false, openrouter: false },
      codex: ABSENT('openai'), antigravity: ABSENT('google'),
    })
    const vals = optValues(el)
    assert.ok(vals.includes('sol'), 'the current value must remain selectable')
    for (const t of ['gpt-reserve', 'luna', 'terra']) {
      assert.ok(!vals.includes(t),
        `${t}: keeping the current tier must not readmit its siblings`)
    }
    const sel = el.querySelector<HTMLSelectElement>('.model-switch')!
    assert.equal(sel.value, 'sol', 'the control must not render blank')
  })

configTest('§2 the default (no presence prop) offers everything', async (mount) => {
  // a caller that has not resolved the payload behaves exactly as before —
  // the same optimism as `providerShown(null)`, asserted at the surface.
  const el = await mount({ presence: ALL_PRESENT })
  assert.deepEqual(groups(el), ['Claude', 'Codex', 'Antigravity'])
})

// ============================================== §3 the lineage rehire panel

function withBearer(tier: string): CanvasNode {
  const gen: LineageEntry = {
    id: 'agent@1', generation: 1, state: 'archived',
    bearer_state: 'knowledge', tier,
  } as LineageEntry
  return { ...node(tier), lineage: [gen] } as unknown as CanvasNode
}

function lineageTest(name: string,
                     body: (mount: (n: CanvasNode, p: ProviderPresence)
                       => Promise<HTMLElement>) => Promise<void>): void {
  test(name, async (t: TestContext) => {
    // no fake clock, deliberately — the panel reads no time, and mock.timers
    // is process-global (D-197's note, and the user's 2026-08-29 warning).
    installFetch(new FakeServer())
    const open: { unmount: () => Promise<void> }[] = []
    t.after(async () => { for (const v of open) await v.unmount() })
    await body(async (n, p) => {
      const v = await mountView(
        <LineagePanel node={n} slug="org" close={noop} presence={p}
          op={(_x: OpRequest) => Promise.resolve({} as OpResult)} />,
        (el) => el,
      )
      open.push(v)
      return v.el
    })
  })
}

const rehireOpts = (el: HTMLElement) =>
  [...el.querySelectorAll<HTMLOptionElement>('.lin-row select option')]

lineageTest('§3 the rehire picker drops families this machine lacks',
  async (mount) => {
    const el = await mount(withBearer('haiku'),
      { claude: true, openai: false, google: false, openrouter: false })
    const vals = rehireOpts(el).map((o) => o.value)
    for (const t of [...CODEX, ...ANTIGRAVITY]) {
      assert.ok(!vals.includes(t),
        `${t}: absent providers are not listed, not even disabled`)
    }
    assert.ok(vals.includes('sonnet'), 'the bearer\'s own family stays')
    assert.ok(!(el.textContent ?? '').includes('cannot resume it'),
      'no cross-provider explanation for a provider that does not exist here')
  })

lineageTest('§3 an INSTALLED other provider is still listed and disabled',
  async (mount) => {
    // D-197's behaviour, preserved exactly. "A gap explains nothing" still
    // holds for a provider the user HAS — being told why terra is unavailable
    // is information. D-202 only removes the families that are not there.
    const el = await mount(withBearer('haiku'),
      { claude: true, openai: true, google: false, openrouter: false })
    const sol = rehireOpts(el).find((o) => o.value === 'sol')
    assert.ok(sol, 'codex IS installed here — it stays listed')
    assert.equal(sol.disabled, true)
    assert.match(sol.textContent ?? '', /cannot resume it/)
    for (const t of ANTIGRAVITY) {
      assert.ok(!rehireOpts(el).some((o) => o.value === t),
        `${t}: antigravity is absent and must be gone`)
    }
  })

lineageTest('§3 a codex bearer keeps its own default option', async (mount) => {
  // the "as <tier>" default is the control's identity; it must survive even
  // when codex has been uninstalled under it.
  const el = await mount(withBearer('sol'),
    { claude: true, openai: false, google: false, openrouter: false })
  assert.match(el.textContent ?? '', /as sol · seat 5/,
    'the bearer still IS a sol session — say so, and with a real seat number')
})

// ================================================== §4 the accounts panel

const ACCOUNTS: AccountsPayload = {
  primary: { id: 'primary', signed_in: true, email: 'me@example.test' },
  keys: [], assignments: {},
} as unknown as AccountsPayload

function acctFetch(payload: ProvidersPayload) {
  const g = globalThis as unknown as Record<string, unknown>
  g.fetch = (url: string) => {
    const path = new URL(String(url), 'http://localhost').pathname
    const body = /\/providers$/.test(path) ? payload
      : /\/accounts$/.test(path) ? ACCOUNTS : {}
    return Promise.resolve({ ok: true, status: 200, headers: new Headers(),
      json: () => Promise.resolve(body) })
  }
}

async function accounts(payload: ProvidersPayload): Promise<string> {
  acctFetch(payload)
  const view = await mountView(
    <AccountsPanel toast={noop} close={noop} />, (el) => el)
  await inAct(async () => { await flush(10) })
  const text = view.el.textContent ?? ''
  await view.unmount()
  return text
}

test('§4 THE RULING: an absent Codex has no accounts-page section at all',
  async () => {
    // ⚠ this is the surface the coordinator's D-199 ruling had made the HOME
    // of the "not installed, here is the install command" story. The user
    // overruled that on 2026-08-30, so the section must be gone entirely —
    // head, tier list, preview tag and the "not installed on this machine"
    // line included.
    const text = await accounts({ providers: [
      ON('claude'), ABSENT('openai'), ABSENT('google')] })
    assert.ok(!text.includes('Codex'), `Codex still mentioned: ${text}`)
    assert.ok(!text.includes('Antigravity'), `Antigravity still mentioned: ${text}`)
    assert.ok(!text.includes('not installed on this machine'),
      'the absent-provider note is part of what must disappear')
    assert.ok(text.includes('Claude'), 'Claude is the exception, not a casualty')
  })

test('§4 an INSTALLED but signed-out Codex keeps its full section', async () => {
  const text = await accounts({ providers: [
    ON('claude'), SIGNED_OUT('openai'), ABSENT('google')] })
  assert.ok(text.includes('Codex'), 'installed means present')
  assert.ok(text.includes('not signed in'), 'and it carries its own reason')
  assert.ok(!text.includes('Antigravity'), 'while the absent one is still gone')
})

test('§4 CLAUDE IS THE EXCEPTION: absent, but reported in one small line',
  async () => {
    const text = await accounts({ providers: [
      ABSENT('claude'), ABSENT('openai'), ABSENT('google')] })
    assert.ok(text.includes('Claude'), 'orgtree is built around it — say so')
    assert.match(text, /not installed/,
      'the whole point of the exception is reporting the absence')
    // small: one line, and specifically NOT the provider-section treatment the
    // other two lost. No tier list, no preview tag.
    assert.ok(!text.includes('preview'))
    assert.ok(!text.includes('seat 1'))
    assert.ok(!text.includes('Codex'), 'the exception is Claude ALONE')
    assert.ok(!text.includes('Antigravity'))
  })

test('§4 an installed Claude says nothing — the line is about ABSENCE',
  async () => {
    const text = await accounts({ providers: [
      ON('claude'), ABSENT('openai'), ABSENT('google')] })
    assert.ok(!/not installed/.test(text),
      'a healthy machine must not carry an install nag')
  })

test('§4 unresolved provider state shows the sections, and claims nothing '
  + 'about Claude', async () => {
    // the optimistic default at the surface: an empty payload is not evidence
    // of absence. Asserting BOTH halves — the sections appear, and the Claude
    // line does not (claiming "not installed" on no evidence is the one thing
    // that line could get badly wrong).
    const text = await accounts({ providers: [] })
    assert.ok(text.includes('Codex'))
    assert.ok(text.includes('Antigravity'))
    assert.ok(!/not installed/.test(text))
  })

// ==================================================== §5 the usage surfaces

const CLAUDE_USAGE: UsageAllPayload = { accounts: [{
  account: 'primary', label: 'claude@example.test', available: true,
  plan: 'max', limits: [{ kind: 'session', group: 'session', percent: 17,
    severity: 'normal', resets_at: null, is_active: false, model: null }],
}] } as unknown as UsageAllPayload

// ⚠ THE MEASURED SHAPE, and the reason §5 exists. On a machine with no Codex
// the endpoint does NOT return nothing — codex_limits.fetch returns an
// available:false record with an error string — so the old bare `codex &&`
// gate rendered a "Codex" heading over "Codex CLI is not installed".
const CODEX_ABSENT_USAGE: AccountUsage = {
  account: 'codex', provider: 'Codex', label: 'codex@example.test',
  available: false, error: 'Codex CLI is not installed', limits: [],
} as unknown as AccountUsage

async function usageModal(payload: ProvidersPayload): Promise<string> {
  const g = globalThis as unknown as Record<string, unknown>
  g.fetch = (url: string) => {
    const path = new URL(String(url), 'http://localhost').pathname
    const body = /\/providers$/.test(path) ? payload
      : /\/accounts\/usage$/.test(path) ? CLAUDE_USAGE
        : /\/codex\/usage$/.test(path) ? CODEX_ABSENT_USAGE : {}
    return Promise.resolve({ ok: true, status: 200, headers: new Headers(),
      json: () => Promise.resolve(body) })
  }
  const view = await mountView(<UsageModal close={noop} />, (el) => el)
  await inAct(async () => { await flush(10) })
  const text = view.el.textContent ?? ''
  await view.unmount()
  return text
}

test('§5 the usage modal drops the Codex block on a Codex-less machine',
  async () => {
    const text = await usageModal({ providers: [
      ON('claude'), ABSENT('openai'), ABSENT('google')] })
    assert.ok(text.includes('usage limits'))
    assert.ok(text.includes('claude@example.test'), 'Claude bars still render')
    assert.ok(!text.includes('Codex'),
      'a "Codex" heading over "not installed" is an advertisement, not a bar')
  })

test('§5 …and keeps it when Codex is installed', async () => {
  const text = await usageModal({ providers: [
    ON('claude'), SIGNED_OUT('openai'), ABSENT('google')] })
  assert.ok(text.includes('Codex'),
    'installed-but-signed-out is shown, here as everywhere')
})

test('§5 usageTitle names only the providers present', () => {
  assert.equal(usageTitle(ALL_PRESENT), 'usage limits — Claude and Codex')
  assert.equal(usageTitle({ claude: true, openai: false, google: false, openrouter: false }),
    'usage limits — Claude')
  assert.equal(usageTitle({ claude: false, openai: true, google: false, openrouter: false }),
    'usage limits — Codex')
  // no dangling "— " when neither is present
  assert.equal(usageTitle({ claude: false, openai: false, google: false, openrouter: false }),
    'usage limits')
  // Antigravity has no usage route, so its presence must not add a name
  assert.equal(usageTitle({ claude: true, openai: false, google: true, openrouter: false }),
    'usage limits — Claude')
})
