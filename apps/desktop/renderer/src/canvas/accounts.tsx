import { ImportSettings } from './importsettings'
import { DesktopSettings } from './desktopsettings'
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
      {!providers && !error && <p className="dim">Detecting harnesses…</p>}
      {providers && !providers.some(p => p.id !== 'openrouter' && p.status.installed) &&
        <p className="ask-warn">No supported harness was found. Install and sign in to Claude Code, Codex or Antigravity to run agents.</p>}
      {providers?.filter(p => p.id !== 'openrouter').map(p => <div key={p.id} className="set-group">
        <div className={'set-group-head acct-provider-head prov-' + p.id}>
          {p.label}<span className="set-head-right">
            {p.status.installed && p.user_enabled !== false && !p.hire_enabled && <span className="acct-preview-tag">preview</span>}
            <ProviderSwitch provider={p} busy={busy} onChange={toggleProvider} />
          </span>
        </div>
        <p>{!p.status.installed ? 'Not installed' : p.status.connected === true ? 'Connected'
          : p.status.connected === false ? 'Sign-in required' : 'Connection status unknown'}
          {p.status.version && ` · ${p.status.version}`}</p>
        {p.status.email && <p className="dim">{p.status.email}</p>}
        {p.reason && <p className="dim">{p.reason}</p>}
        {p.status.path && <p className="dim mono">{p.status.path}</p>}
        {!p.status.installed && downloads[p.id] && <a href={downloads[p.id]} target="_blank" rel="noopener noreferrer">Download {p.label}</a>}
        <div className="row">{p.tiers.map(t => <span className="badge" key={t.tier}>{t.name ?? t.tier}</span>)}</div>
        {p.reserve && <p className="dim">Reserve capacity: {p.reserve.percent == null ? 'unknown' : `${p.reserve.percent}% used`}
          {p.reserve.resets_at && ` · resets ${fmtFull(p.reserve.resets_at)}`}
          {p.reserve.reason && ` · ${p.reserve.reason}`}</p>}
      </div>)}
      <OpenRouterSection provider={openrouter} toast={toast} pickerOpen={pickerOpen}
        setPickerOpen={setPickerOpen} onChanged={() => { void loadProviders() }}
        headRight={<ProviderSwitch provider={openrouter} busy={busy} onChange={toggleProvider} />} />
    </SettingsTabPanel>
    <SettingsTabPanel id="runtime" idBase="app-settings" active={tab === 'runtime'}>
      <DesktopSettings />
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
      <SetGroup title="Desk" note="saved on this computer"><DeskTextSize /><CrowdStackToggle /><ModalOverlapSettings /></SetGroup>
      <SetGroup title="Startup" note="saved on this computer"><StartupView /></SetGroup>
    </SettingsTabPanel>
    <SettingsTabPanel id="import" idBase="app-settings" active={tab === 'import'}><ImportSettings /></SettingsTabPanel>
    <button onClick={close}>close</button>
  </PinFrame>
}
