// "Starting layout" in the Create organization window (docket
// create-organizations-from-agent-layout-templates). Empty is today's
// behaviour and the default; a template hires its tree of agents with the
// org. The list is exactly the files in the templates folder, re-read when
// the picker opens (user 2026-10-10: name and optional description, one
// click to choose). The preview is the engine's own plan for THIS computer: each agent's
// tier (the template's, else its first fallback on offer, else blocked), the
// account it will run on and the grant worked out from the reports' seats.
// User rulings 2026-10-09: the first message is off by default, and Create
// stays disabled while any agent has no tier that can run.
import { useEffect, useMemo, useState } from 'react'
import { listTemplates, openTemplatesFolder, resolveTemplate } from '../api'
import type { TemplatePick, TemplatePlan, TemplateSummary } from '../api'
import './templatepicker.css'

export interface LayoutChoice {
  /** '' = Empty */
  id: string
  overrides: Record<string, { tier?: string; name?: string }>
  removed: string[]
  kickoff: boolean
}
export const EMPTY_LAYOUT: LayoutChoice = { id: '', overrides: {}, removed: [], kickoff: false }

/** The create body's `template`, pinned to the tiers the preview showed. */
export function layoutPick(choice: LayoutChoice, plan: TemplatePlan | null): TemplatePick | null {
  if (!choice.id || !plan || plan.id !== choice.id) return null
  return {
    id: choice.id, overrides: choice.overrides, removed: choice.removed, kickoff: choice.kickoff,
    expect: Object.fromEntries(plan.agents.map((a) => [a.slot, a.tier ?? ''])),
  }
}

const PROVIDER_ORDER = ['claude', 'openai', 'google', 'muse', 'openrouter', 'langserver']
const SIGN_IN: Record<string, string> = {
  claude: 'Claude', openai: 'Codex', google: 'Antigravity', openrouter: 'OpenRouter', langserver: 'Language servers',
  muse: 'Muse',
}

function MiniTree({ t }: { t: TemplateSummary | null }) {
  if (!t) {
    return <svg className="tp-mini" viewBox="0 0 120 44" aria-hidden="true">
      <rect x="45" y="12" width="30" height="18" rx="3" fill="none" stroke="currentColor" strokeDasharray="3 3" opacity=".5" />
    </svg>
  }
  const top = t.agents.filter((a) => a.depth === 0)
  const kids = t.agents.filter((a) => a.depth === 1)
  const k = kids.length
  return <svg className="tp-mini" viewBox="0 0 120 44" aria-hidden="true">
    {top.slice(0, 1).map((a) => <rect key={a.name} x="48" y="2" width="24" height="13" rx="3" className="tp-node tp-top" />)}
    {kids.slice(0, 5).map((a, i) => {
      const x = 60 + (i - (Math.min(k, 5) - 1) / 2) * 24
      return <g key={a.name}>
        <path d={`M60 15 V22 H${x} V29`} className="tp-edge" fill="none" />
        <rect x={x - 9} y="29" width="18" height="13" rx="3" className="tp-node" />
      </g>
    })}
  </svg>
}

export function TemplatePicker({ choice, onChange, plan, onPlan, orgName, dirs }: {
  choice: LayoutChoice
  onChange: (c: LayoutChoice) => void
  plan: TemplatePlan | null
  onPlan: (p: TemplatePlan | null) => void
  orgName: string
  dirs: string[]
}) {
  const [templates, setTemplates] = useState<TemplateSummary[] | null>(null)
  const [listError, setListError] = useState('')
  const [folderError, setFolderError] = useState('')
  const [planError, setPlanError] = useState('')
  const [reload, setReload] = useState(0)
  const [recheck, setRecheck] = useState(0)
  const [listRecheck, setListRecheck] = useState(0)
  const [listPending, setListPending] = useState(true)
  useEffect(() => {
    let live = true
    let again = 0
    setListPending(true)
    // read afresh each time the picker opens (and on Reload): the folder is the list
    listTemplates(orgName).then((r) => {
      if (!live) return
      setTemplates(r.templates); setFolderError(r.folder_error ?? ''); setListError(''); setListPending(false)
      if (r.loading) again = window.setTimeout(() => setListRecheck((n) => n + 1), 1000)
    }).catch((e: Error) => { if (live) { setListError(e.message); setListPending(false) } })
    return () => { live = false; window.clearTimeout(again) }
  }, [reload, orgName, listRecheck])
  // the preview follows every choice; the name and folders matter too
  // (accounts kept for one org, folders a saved template carries)
  const dirsKey = dirs.join('\n')
  useEffect(() => {
    if (!choice.id) { onPlan(null); setPlanError(''); return }
    let live = true
    let again = 0
    const t = window.setTimeout(() => {
      resolveTemplate({ id: choice.id, overrides: choice.overrides, removed: choice.removed }, orgName, dirs)
        .then((p) => {
          if (!live) return
          onPlan(p); setPlanError('')
          // the engine is still checking sign-ins: ask again shortly
          if (p.loading) again = window.setTimeout(() => setRecheck((n) => n + 1), 1000)
        })
        .catch((e: Error) => { if (live) { onPlan(null); setPlanError(e.message) } })
    }, 200)
    return () => { live = false; window.clearTimeout(t); window.clearTimeout(again) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [choice.id, JSON.stringify(choice.overrides), choice.removed.join('\n'), orgName, dirsKey, recheck])
  const offered = useMemo(() => [...(plan?.offered ?? [])].sort((a, b) =>
    PROVIDER_ORDER.indexOf(a.provider) - PROVIDER_ORDER.indexOf(b.provider) || b.seat - a.seat), [plan])
  const pick = (id: string) => onChange({ ...EMPTY_LAYOUT, id })
  const setSlot = (slot: string, v: { tier?: string; name?: string }) =>
    onChange({ ...choice, overrides: { ...choice.overrides, [slot]: { ...choice.overrides[slot], ...v } } })
  const anyKickoff = plan?.agents.some((a) => a.kickoff) ?? false
  const currentPlan = plan?.id === choice.id ? plan : null
  const planUnusable = !!currentPlan && !currentPlan.loading &&
    (currentPlan.unusable_here ?? (currentPlan.agents.length > 0 && currentPlan.agents.every(a => !a.tier)))
  return <div className="tp">
    <div className="field-label tp-label">
      <span>Starting layout</span>
      <button type="button" className="tp-link" onClick={() => { void openTemplatesFolder() }}>
        Open templates folder</button>
      <button type="button" className="tp-link" onClick={() => setReload((n) => n + 1)}>Reload</button>
    </div>
    <div className="tp-list" role="listbox" aria-label="Starting layout">
      <button type="button" role="option" aria-selected={!choice.id}
        className={`tp-row${!choice.id ? ' sel' : ''}`} onClick={() => pick('')}>
        <MiniTree t={null} />
        <span className="tp-name">Empty</span>
        <span className="tp-count">no agents</span>
        <span className="tp-desc">You hire the first agent on the canvas.</span>
      </button>
      {(templates ?? []).map((t) => {
        const usable = !!t.id && t.problems.length === 0
        const desc = usable ? t.description?.trim() : t.problems[0]
        const selected = choice.id === t.id
        const unavailable = usable && !listPending && !listError &&
          (selected && currentPlan ? planUnusable : !!t.availability?.unusable && !t.availability.checking)
        const collapsed = unavailable && !selected
        return <button type="button" role="option" key={t.path} aria-selected={choice.id === t.id}
          className={`tp-row${selected ? ' sel' : ''}${usable ? '' : ' invalid'}${unavailable ? ' unusable' : ''}${collapsed ? ' collapsed' : ''}`}
          disabled={!usable} title={usable ? t.path : t.problems.join('\n')}
          onClick={() => t.id && pick(t.id)}>
          {!collapsed && <MiniTree t={t} />}
          <span className="tp-name">{t.name}</span>
          {!collapsed && <span className="tp-count">{t.agents.length} agent{t.agents.length === 1 ? '' : 's'}</span>}
          {unavailable && <span className="tp-reason">{t.availability?.reason ?? 'models unavailable here'}</span>}
          {!collapsed && desc && <span className="tp-desc">{desc}</span>}
        </button>
      })}
    </div>
    {templates && templates.length === 0 && !folderError && <div className="dim tp-empty">
      Your templates folder has no templates. Add a .json file there, or restore the defaults in App settings.</div>}
    {folderError && <div className="ask-warn" role="alert">{folderError}</div>}
    {listError && <div className="ask-warn" role="alert">Templates could not be listed: {listError}</div>}
    {choice.id && planError && <div className="ask-warn" role="alert">{planError}</div>}
    {choice.id && plan && plan.id === choice.id && <div className="tp-preview">
      {planUnusable && <div className="ask-warn tp-unusable-warning" role="alert">
        These agents can't be hired here unless you change their models. Choose available models below.</div>}
      <div className="tp-ph">
        <span>{plan.agents.length} agent{plan.agents.length === 1 ? '' : 's'} will be hired under you</span>
        <span className="dim">grants add each agent's reports' seats</span>
      </div>
      <table>
        <thead><tr><th>Name</th><th>Tier</th><th>Account</th><th>Charter</th><th className="num">Seat + grant</th><th /></tr></thead>
        <tbody>
          {plan.agents.map((a) => <tr key={a.slot} className={a.blocked && !plan.loading ? 'tp-blocked' : ''}>
            <td className="tp-nm">
              {a.depth > 0 && <span className="tp-indent" aria-hidden="true">{'└'}</span>}
              <input value={choice.overrides[a.slot]?.name ?? a.name} aria-label={`name of ${a.slot}`}
                onChange={(e) => setSlot(a.slot, { name: e.target.value })} />
            </td>
            <td>
              <select value={a.tier ?? ''} aria-label={`tier of ${a.name}`} data-provider={a.provider ?? ''}
                onChange={(e) => setSlot(a.slot, { tier: e.target.value })}>
                {!a.tier && <option value="" disabled>{plan.loading ? 'checking…' : 'needs a sign-in'}</option>}
                {offered.map((o) => <option key={o.tier} value={o.tier}>{o.tier}</option>)}
              </select>
              {a.note && <div className={a.blocked && !plan.loading ? 'tp-bad' : 'tp-note'}>{a.note}</div>}
              {a.dirs_dropped.length > 0 && <div className="tp-note">
                folders not in this organization: {a.dirs_dropped.join(', ')}</div>}
            </td>
            <td className="dim">{a.account === 'primary' ? `${SIGN_IN[a.provider ?? ''] ?? a.provider} sign-in` : a.account ?? '—'}</td>
            <td><span className="tp-chip">{a.charter}</span></td>
            <td className="num">{a.tier ? (a.depth === 0 ? `${a.grant}` : `${a.seat} + ${a.grant}`) : '—'}</td>
            <td>{a.depth > 0 && <button type="button" className="tp-x" title={`Leave ${a.name} out`}
              aria-label={`leave ${a.name} out`}
              onClick={() => onChange({ ...choice, removed: [...choice.removed, a.slot] })}>✕</button>}</td>
          </tr>)}
        </tbody>
      </table>
      <div className="tp-foot">
        <span>{choice.removed.length > 0 && <button type="button" className="tp-link"
          onClick={() => onChange({ ...choice, removed: [] })}>bring back {choice.removed.length} left out</button>}
          {plan.org_md && <span className="dim"> · writes the template's org.md</span>}</span>
        <span>Top-level grant <b>{plan.top_grant}</b></span>
      </div>
    </div>}
    {choice.id && plan && plan.id === choice.id && anyKickoff && <label className="row org-check tp-kick">
      <input type="checkbox" checked={choice.kickoff}
        onChange={(e) => onChange({ ...choice, kickoff: e.target.checked })} />
      Send the coordinator its first message now
      <span className="dim"> · off: nobody spends anything until you write to them</span>
    </label>}
    {choice.id && plan?.loading && <div className="dim tp-checking" role="status">
      Checking the sign-ins on this computer…</div>}
    {choice.id && plan && !plan.ok && !plan.loading && <div className="ask-warn" role="alert">
      {plan.blocked.length} agent{plan.blocked.length === 1 ? '' : 's'} cannot run on this computer now
      ({plan.blocked.join(', ')}): pick another tier or leave {plan.blocked.length === 1 ? 'it' : 'them'} out.</div>}
  </div>
}
