import { ImportSettings } from './importsettings'
import { AccountRegistrySection } from './accountsregistry'
import { ThemeSetting } from '../themes'
import { DesktopSettings } from './desktopsettings'
import { CharterDocumentsSetting } from './chartersettings'
import { useEffect, useState } from 'react'
import type {
  AccountUsage, ProviderInfo, RuntimeSettingsPayload,
  TierStanding, ToastFn, UsageLimit,
} from '../types'
import {
  getProviders, getRuntimeSettings,
  setIdleDocketRemindersEnabled, setProviderEnabled,
  setWaitForMcpToolsEnabled, setWarmingEnabled, setWorkingCheckupsEnabled,
} from '../api'
import { desktop } from '../desktop'
import type { LoginProvider, ProviderLoginStatus } from '../../../../../packages/contracts'
import {
  SetGroup, SetRow, SettingsTabPanel, SettingsTabs, SetToggle,
} from './settingskit'
import type { SettingsTab } from './settingskit'
import { OpenRouterSection } from './openrouter'
import { ModalOverlapSettings, PinFrame } from './modalpin'
import {
  setCrowdPilesOn, setDeskDpi, setOpenRouterTiers, setStartView, setStartZoomOn,
  TIER_LETTER,
  useCrowdPiles, useDeskDpi, useStartView, useStartZoom,
} from './shared'
import { fmtFull, fmtWhen } from '../timefmt'
import type { StartView } from './shared'

// small local copies of the usage-modal label helpers (App.tsx owns the
// originals beside UsageModal; importing them here would cycle App ↔ panel)
const USAGE_LABEL: Record<string, string> = {
  session: 'session (5hr)',
  weekly_all: 'weekly (7 day)',
}
const usageLabel = (l: UsageLimit): string =>
  l.label || (l.kind === 'weekly_scoped' && l.model ? `weekly ${l.model}`
    : USAGE_LABEL[l.kind] ?? l.kind.replace(/_/g, ' ')
  )
const usageResets = (iso: string | null): string => {
  if (!iso) return ''
  const ms = new Date(iso).getTime() - Date.now()
  if (!Number.isFinite(ms)) return ''
  if (ms <= 0) return 'resets soon'
  const h = Math.floor(ms / 3600000)
  const m = Math.floor((ms % 3600000) / 60000)
  if (h >= 48) return `resets in ${Math.floor(h / 24)}d ${h % 24}h`
  return h > 0 ? `resets in ${h}h ${m}m` : `resets in ${m}m`
}
/** the wall-clock time a refresh lands, for the "until when" half of the key
 *  rows' standing view. The relative form above answers "how long"; on its own
 *  it is useless for planning past an hour or two, which is exactly the range
 *  a weekly limit sits in. Dated only when it is not today. */
const atClock = (iso: string | null): string => fmtWhen(iso)
const sevOf = (l: UsageLimit): '' | 'warn' | 'crit' => {
  const pct = Math.max(0, Math.min(100, l.percent ?? 0))
  return l.severity === 'critical' || pct >= 90 ? 'crit'
    : (l.severity && l.severity !== 'normal') || pct >= 75 ? 'warn' : ''
}

/** a key row's answer in place of percentages (user ruling 2026-08-25): the
 *  routing state this machine holds FOR THAT ACCOUNT — which models can still
 *  run on it, which are spent, and when the spent ones come back. It is the
 *  same `usage_refreshes` dict the router reads, so this view cannot describe
 *  a state a spawn would disagree with.
 *
 *  ⚠ WORD IT AS CAPACITY, NEVER AS ROUTING. "has capacity" is a fact about
 *  this account alone; where a tier actually RUNS is the gutter chips' job,
 *  and the two differ constantly — a fallback has capacity for opus the whole
 *  time opus is happily running on the primary above it. */
export function TierStandings({ tiers }: { tiers: TierStanding[] }) {
  return (
    <div className="acct-tiers">
      {tiers.map((t) => (
        <div className="acct-tier-row" key={t.tier}>
          <span className={'tier t-' + t.tier
            + (t.available ? '' : ' acct-chip-dim')}>
            {TIER_LETTER[t.tier] ?? t.tier.slice(0, 1).toUpperCase()}</span>
          <span className="acct-tier-name">{t.tier}</span>
          {t.available
            ? <span className="acct-tier-ok">has capacity</span>
            : <span className="acct-tier-wait">
              {usageResets(t.refresh_at).replace('resets', 'refreshes')
                || 'refreshes soon'}
              {atClock(t.refresh_at)
                && <span className="dim"> · at {atClock(t.refresh_at)}</span>}
            </span>}
        </div>
      ))}
    </div>
  )
}

/** one account's bars — the same markup family as the header usage modal */
export function UsageBars({ u }: { u: AccountUsage }) {
  // A row that has a standing table shows THE TABLE AND NOTHING ELSE (user
  // ruling 2026-08-25): no note explaining why this row reads differently
  // from the primary's, and no footnote about the shared pool. The table
  // answers the question the button was clicked to ask; prose underneath it
  // was answering a question about our own implementation.
  if (u.tiers?.length) return <TierStandings tiers={u.tiers} />
  // ⚠ …but keep this branch. "CAN'T" AND "DIDN'T" MUST NOT LOOK ALIKE: a
  // setup-token key can never report usage (D-147), and rendering that as the
  // same dim line an outage produces invites the user to keep clicking a
  // button that will never do anything. `unsupported` is a settled fact, so
  // it reads as a note; an error is a condition that might clear, so it keeps
  // the warning styling. Unreachable for a key row today — `account_usage`
  // always sends `tiers` — this catches an account that is unsupported with
  // no standing to show, which would otherwise render as a blank modal.
  if (u.unsupported) {
    return <div className="acct-unsupported">{u.error
      ?? 'usage limits are not available for this kind of key'}</div>
  }
  if (!u.available) {
    return <div className="dim">{u.error ?? 'usage unavailable'}</div>
  }
  return (
    <>
      {u.plan && <div className="dim">{u.provider ?? 'Claude'} {u.plan}</div>}
      {(u.limits ?? []).map((l) => {
        // `percent: null` is a real state (UsageLimit's own type), not an
        // absent 0 — OpenRouter reports it for an uncapped key, where the
        // dollar figure rides `label` instead: a bar reading 0% would claim
        // nothing has been spent, which is exactly the fabrication the task
        // must not make. No bar, no badge; the label carries the fact.
        const known = l.percent != null
        const pct = Math.max(0, Math.min(100, l.percent ?? 0))
        const sev = sevOf(l)
        return (
          <div className="usage-row"
            key={l.group + l.kind + (l.model ?? '') + (l.label ?? '')}>
            <div className="u-head">
              <span className="u-label">{usageLabel(l)}</span>
              <span className="u-reset">{usageResets(l.resets_at)}</span>
              {known && <span className={'u-pct' + (sev ? ' ' + sev : '')}>
                {Math.round(l.percent ?? 0)}%</span>}
            </div>
            {known && <div className="usage-track">
              <div className={'usage-fill' + (sev ? ' ' + sev : '')}
                style={{ width: pct + '%' }} />
            </div>}
          </div>
        )
      })}
      {!(u.limits ?? []).length && <div className="dim">no limits reported</div>}
    </>
  )
}

type AppSettingsTab = 'providers' | 'runtime' | 'display' | 'import'
const APP_TABS: SettingsTab<AppSettingsTab>[] = [
  { id: 'providers', label: 'Providers' },
  { id: 'runtime', label: 'Runtime' },
  { id: 'display', label: 'Display', note: 'this computer' },
  { id: 'import', label: 'Import' },
]

function DeskTextSize() {
  const dpi = useDeskDpi()
  const apply = (v: number) => {
    const clamped = Math.min(2.5, Math.max(0.75,
      Math.round(v * 100) / 100))
    setDeskDpi(clamped)
  }
  return (
    <SetRow label="desk text size"
      hint={'scales agent desks, cards and canvas type. '
        + 'Panels like this one keep their own size.'}>
      <button aria-label="smaller desk text" onClick={() => apply(dpi - 0.25)}
        disabled={dpi <= 0.75}>−</button>
      <span className="set-value" aria-live="polite">
        {Math.round(dpi * 100)}%</span>
      <button aria-label="larger desk text" onClick={() => apply(dpi + 0.25)}
        disabled={dpi >= 2.5}>+</button>
      <button onClick={() => apply(1)} disabled={dpi === 1}>reset</button>
    </SetRow>
  )
}

function CrowdStackToggle() {
  const on = useCrowdPiles()
  return (
    <SetToggle label="collapse crowded teams into one stack" checked={on}
      onChange={setCrowdPilesOn}
      hint={'a team with more than 8 active agents draws as a single '
        + 'stack instead of 8+ separate cards'} />
  )
}

/* D-228: where an org opens, and whether the camera glides there. Two rows
   because they are two decisions — a destination and a manner — and the
   second is moot under "where I left off", which the toggle says by going
   inert (disabled, hint rewritten) rather than by vanishing: a control that
   disappears reads as a bug, one that explains itself reads as a rule. */
const START_VIEW_OPTIONS: [StartView, string][] = [
  ['org', 'the full org'],
  ['switchboard', 'the switchboard'],
  ['remember', 'where I left off'],
]
function StartupView() {
  const mode = useStartView()
  const zoom = useStartZoom()
  const remember = mode === 'remember'
  return (
    <>
      <SetRow label="open an org at"
        hint={remember
          ? 'the camera comes back exactly where it was in that org. A brand-new '
            + 'org, with nowhere to come back to, plays the starting zoom once.'
          : mode === 'switchboard'
            ? 'straight to the eye’s desk, every agent in one row'
            : 'the whole tree, fitted to the window'}>
        <select aria-label="open an org at" value={mode}
          onChange={(e) => setStartView(e.target.value as StartView)}>
          {START_VIEW_OPTIONS.map(([v, label]) =>
            <option key={v} value={v}>{label}</option>)}
        </select>
      </SetRow>
      <SetToggle label="play the starting zoom" checked={zoom}
        disabled={remember}
        title={remember ? 'not used by “where I left off”' : undefined}
        onChange={setStartZoomOn}
        hint={remember
          ? 'not used by “where I left off” — a restored view never glides'
          : 'wakes on the eye, then glides out to the org (or in to the switchboard)'} />
    </>
  )
}

function ProviderSwitch({ provider, busy, onChange }: {
  provider: ProviderInfo | undefined
  busy: boolean
  onChange: (provider: ProviderInfo, enabled: boolean) => void
}) {
  if (!provider || (!provider.status.installed && provider.user_enabled !== false))
    return null
  const enabled = provider.user_enabled !== false
  return (
    <label className="provider-switch">
      <input type="checkbox" role="switch" checked={enabled} disabled={busy}
        aria-label={`${provider.label} enabled for new agents`}
        onChange={(e) => onChange(provider, e.target.checked)} />
      <span>{enabled ? 'on' : 'off'}</span>
    </label>
  )
}

/** Whether each provider's door needs a code typed anywhere (D-231
 *  expansion) — see providerlogin.ts's module docstring for the evidence.
 *  Claude's CLI waits on stdin for a pasted code; Codex's own local
 *  redirect server needs nothing typed anywhere and never leaves
 *  'starting'. Antigravity has NO scriptable login door (no `agy login`,
 *  no documented headless contract — see the coordinator report), so its
 *  "code" support is false the same as Codex's; unlike either of them it
 *  never reaches 'starting'/'awaiting_code' at all — see the `ok === null`
 *  branch below, which is unique to it. */
const LOGIN_LABELS: Record<LoginProvider, string> = { claude: 'Claude', codex: 'Codex', antigravity: 'Antigravity' }
const SUPPORTS_CODE: Record<LoginProvider, boolean> = { claude: true, codex: false, antigravity: false }

/** One provider's sign-in control — the settings panel's own row AND the
 *  usage panel's 403-triggered button are the SAME component (imported into
 *  App.tsx's UsageModal), so the two cannot drift on behavior the way two
 *  hand-written copies would. The actual child process is spawned by the
 *  MAIN process (providerlogin.ts), never the engine — see its module
 *  docstring — so every call here rides the native bridge, not HTTP. */
export function ProviderSignIn({ provider, connected, toast, onRefresh,
  profileDir, accountId }: {
  provider: LoginProvider
  connected: boolean
  toast: ToastFn
  onRefresh: () => void
  /** multi-account: sign in AS this account — same flow, the provider's
   *  profile selector pointed at the row's directory; verification reads
   *  that account's own identity */
  profileDir?: string
  accountId?: string
}) {
  const bridge = desktop()
  const label = LOGIN_LABELS[provider]
  const supportsCode = SUPPORTS_CODE[provider]
  const [status, setStatus] = useState<ProviderLoginStatus | null>(null)
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const phase = status?.phase ?? 'idle'
  const active = phase === 'starting' || phase === 'awaiting_code'
  useEffect(() => {
    if (!active || !bridge) return
    let stopped = false
    const id = setInterval(() => {
      bridge.getProviderLoginStatus(provider).then((s) => { if (!stopped) setStatus(s) }).catch(() => {})
    }, 800)
    return () => { stopped = true; clearInterval(id) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, provider, bridge])
  useEffect(() => {
    if (phase === 'done' && status?.ok) onRefresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status])
  if (!bridge) return null
  const begin = () => {
    setBusy(true)
    bridge.startProviderLogin(provider,
      profileDir ? { profileDir, accountId } : undefined).then((s) => {
      setStatus(s)
      if (s.phase === 'error') toast([s.error === 'not-installed'
        ? `${label} is not installed` : (s.error || 'could not start sign-in')])
    }).catch((e: Error) => toast([e.message])).finally(() => setBusy(false))
  }
  const submit = () => {
    const trimmed = code.trim()
    if (!trimmed || !supportsCode) return
    setBusy(true)
    bridge.submitProviderLoginCode(provider, trimmed).then(setStatus)
      .catch((e: Error) => toast([e.message]))
      .finally(() => { setBusy(false); setCode('') })
  }
  const cancel = () => {
    setBusy(true)
    bridge.cancelProviderLogin(provider).then(() => setStatus(null)).catch(() => {})
      .finally(() => setBusy(false))
  }
  if (phase === 'awaiting_code' && supportsCode) {
    return (
      <div className="acct-claude-login">
        <input className="acct-claude-code" placeholder="verification code"
          aria-label={`${label} verification code`} value={code}
          onChange={(e) => setCode(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') submit() }}
          disabled={busy} autoFocus />
        <button onClick={submit} disabled={busy || !code.trim()}>Submit code</button>
        <button onClick={cancel} disabled={busy}>Cancel</button>
      </div>
    )
  }
  if (phase === 'starting' || phase === 'awaiting_code') {
    return (
      <div className="acct-claude-login">
        <span className="dim">
          {supportsCode ? 'Starting sign-in…' : `Waiting for the browser sign-in to ${label}…`}
        </span>
        <button onClick={cancel} disabled={busy}>Cancel</button>
      </div>
    )
  }
  if (phase === 'done' && status?.ok === null) {
    // Antigravity only: providerlogin.ts resolves this the instant it opens
    // a terminal window, without verifying anything — there is nothing to
    // poll (see providerlogin.ts's launchAntigravityTerminal docstring), so
    // this is a manual action, not the auto-refresh the true/false cases
    // below get from the effect above.
    return (
      <div className="acct-claude-login">
        <span className="dim">Terminal opened — sign in there, then refresh.</span>
        <button onClick={onRefresh} disabled={busy}>Refresh</button>
      </div>
    )
  }
  const failed = phase === 'error' || (phase === 'done' && status?.ok === false)
  return (
    <div className="acct-claude-login">
      <button onClick={begin} disabled={busy}>
        {connected ? 'Sign in again' : 'Sign in'}
      </button>
      {failed && <span className="ask-warn">
        {status?.timedOut ? 'Sign-in timed out.' : 'Sign-in did not complete.'}
      </span>}
    </div>
  )
}

export function AccountsPanel({ toast, close }: { toast: ToastFn; close: () => void }) {
  const [tab, setTab] = useState<AppSettingsTab>('providers')
  const [providers, setProviders] = useState<ProviderInfo[] | null>(null)
  const [runtime, setRuntime] = useState<RuntimeSettingsPayload | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const loadProviders = () => getProviders().then(p => {
    setProviders(p.providers)
    setOpenRouterTiers(p.providers.find(p => p.id === 'openrouter')?.tiers)
  }).catch((e: Error) => setError(e.message))
  useEffect(() => {
    void loadProviders()
    getRuntimeSettings().then(setRuntime).catch((e: Error) => setError(e.message))
  }, [])
  const changeRuntime = (put: (value: boolean) => Promise<RuntimeSettingsPayload>, value: boolean) => {
    setBusy(true)
    put(value).then(r => { setRuntime(r); setError('') })
      .catch((e: Error) => { setError(e.message); toast([e.message]) })
      .finally(() => setBusy(false))
  }
  const toggleProvider = (provider: ProviderInfo, value: boolean) => {
    setBusy(true)
    setProviderEnabled(provider.id, value).then(p => { setProviders(p.providers); setError('') })
      .catch((e: Error) => { setError(e.message); toast([e.message]) })
      .finally(() => setBusy(false))
  }
  const downloads: Record<string, string> = {
    claude: 'https://code.claude.com/docs/en/setup',
    openai: 'https://developers.openai.com/codex/cli/',
    google: 'https://antigravity.google/download',
  }
  const openrouter = providers?.find(p => p.id === 'openrouter')
  return <PinFrame kind="app-settings" title="App settings" panel="settings acct-panel"
    close={close} onEsc={() => pickerOpen ? setPickerOpen(false) : close()}>
    <h3>App settings</h3>
    <SettingsTabs tabs={APP_TABS} tab={tab} setTab={setTab} idBase="app-settings" label="Application settings sections" />
    {error && <div className="ask-warn" role="alert">{error}</div>}
    <SettingsTabPanel id="providers" idBase="app-settings" active={tab === 'providers'}>
      {/* multi-account (D5): the symmetric registry, providers together */}
      <AccountRegistrySection toast={toast} />
      {!providers && !error && <p className="dim">Detecting harnesses…</p>}
      {providers && !providers.some(p => p.id !== 'openrouter' && p.status.installed) &&
        <p className="ask-warn">No supported harness was found. Install and sign in to Claude Code, Codex or Antigravity to run agents.</p>}
      {providers?.filter(p => p.id !== 'openrouter').map(p => <div key={p.id} className='set-group acct-provider-group'>
        <div className={'set-group-head acct-provider-head prov-' + p.id}>
          <span>{p.label}<span className='dim'> · {p.cli}</span></span>
          <span className='set-head-right'>
            {p.status.installed && p.user_enabled !== false && !p.hire_enabled && <span className='acct-preview-tag'>preview</span>}
            <ProviderSwitch provider={p} busy={busy} onChange={toggleProvider} />
          </span>
        </div>
        <div className='acct-provider-status'>
          <span className={'acct-provider-state ' + (!p.status.installed ? 'missing' : p.status.connected === true ? 'connected' : p.status.connected === false ? 'requires-signin' : 'unknown')}>
            {p.status.installed ? (p.status.connected === true ? 'Installed · connected' : p.status.connected === false ? 'Installed · sign-in required' : 'Installed · connection unknown') : 'Not installed'}
          </span>
          {p.status.version && <span className='acct-provider-meta'>version {p.status.version}</span>}
          {p.status.email && <span className='acct-provider-meta'>account {p.status.email}</span>}
          {p.status.kind && <span className='acct-provider-meta'>sign-in {p.status.kind}</span>}
          {p.status.source && <span className='acct-provider-meta'>source {p.status.source}</span>}
        </div>
        {p.status.path && <p className='dim mono acct-provider-path'>{p.status.path}</p>}
        {!p.status.installed && downloads[p.id] && <a className='acct-provider-download' href={downloads[p.id]} target='_blank' rel='noopener noreferrer'>Download {p.label}</a>}
        {p.reason && <p className='dim acct-provider-note'>{p.reason}</p>}
        {p.tiers.length ? <div className='acct-provider-tiers' aria-label={p.label + ' model tiers'}>
          <div className='acct-provider-tier-title'>Model tiers</div>
          {p.tiers.map(t => <div className='acct-provider-tier' key={t.tier}>
            <span className={'tier t-' + t.tier}>{t.letter}</span>
            <span className='acct-provider-tier-name'>{t.name ?? t.tier}</span>
            <span className='acct-provider-tier-model'>{t.model}</span>
            <span className='acct-provider-tier-seat'>seat {t.seat}</span>
          </div>)}
        </div> : <p className='dim acct-provider-empty'>No model tiers reported</p>}
        {p.cli_version?.update_available === true && <p className='acct-provider-update'>CLI update available: {p.cli_version.latest ?? 'newer version'}</p>}
        {p.reserve && <p className='dim acct-provider-note'>Reserve capacity: {p.reserve.percent == null ? 'unknown' : p.reserve.percent + '% used'}{p.reserve.resets_at && ' · resets ' + fmtFull(p.reserve.resets_at)}{p.reserve.reason && ' · ' + p.reserve.reason}</p>}
      </div>)}
      <OpenRouterSection provider={openrouter} toast={toast} pickerOpen={pickerOpen}
        setPickerOpen={setPickerOpen} onChanged={() => { void loadProviders() }}
        headRight={<ProviderSwitch provider={openrouter} busy={busy} onChange={toggleProvider} />} />
    </SettingsTabPanel>
    <SettingsTabPanel id="runtime" idBase="app-settings" active={tab === 'runtime'}>
      <DesktopSettings />
      <CharterDocumentsSetting />
      <SetGroup title="Agent processes">
        <SetToggle label="keep agent processes warm" checked={runtime?.warming_enabled !== false}
          disabled={!runtime || busy} onChange={v => changeRuntime(setWarmingEnabled, v)}
          hint="Keep supported harness processes ready between turns." />
      </SetGroup>
      <SetGroup title="Turns">
        <SetToggle label="check on working agents after 20 minutes" checked={runtime?.working_checkups_enabled !== false}
          disabled={!runtime || busy} onChange={v => changeRuntime(setWorkingCheckupsEnabled, v)} />
        <SetToggle label="wait until the MCP tool surface is ready" checked={runtime?.wait_for_mcp_tools_enabled === true}
          disabled={!runtime || busy} onChange={v => changeRuntime(setWaitForMcpToolsEnabled, v)} />
        <SetToggle label="remind idle agents about unfinished docket items" checked={runtime?.idle_docket_reminders_enabled === true}
          disabled={!runtime || busy} onChange={v => changeRuntime(setIdleDocketRemindersEnabled, v)} />
      </SetGroup>
    </SettingsTabPanel>
    <SettingsTabPanel id="display" idBase="app-settings" active={tab === 'display'}>
      <ThemeSetting />
      <SetGroup title="Desk" note="saved on this computer"><DeskTextSize /><CrowdStackToggle /><ModalOverlapSettings /></SetGroup>
      <SetGroup title="Startup" note="saved on this computer"><StartupView /></SetGroup>
    </SettingsTabPanel>
    <SettingsTabPanel id="import" idBase="app-settings" active={tab === 'import'}><ImportSettings active={tab === 'import'} /></SettingsTabPanel>
    <button onClick={close}>close</button>
  </PinFrame>
}
