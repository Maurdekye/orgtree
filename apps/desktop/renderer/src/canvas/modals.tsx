import { useSurfaceDocument } from '../popout'
// canvas/modals.tsx — the config modals: the in-page ConfirmModal, the org
// agent-hire defaults panel (UserConfig), the pre-hire permissions modal
// (DraftScopeModal), the per-node ⚙ config (NodeConfig) with the shared MCP
// checklist, and the retired/crowd pile picker. Extracted verbatim from
// Canvas.tsx in the phase-3 split.

import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type {
  ChatInit, DirGrant, ProviderInfo, ToastFn, ToolGrant, TreePayload, Watchdog,
} from '../types'
import {
  assignAccount, dissolveAll, getChat, getMcpServers, removeReplyEvents,
  req, saveHireDefaults, saveScope, saveSettings, watchdogAction,
} from '../api'
import { pickFolder } from '../picker'
import {
  CloseIcon, DeleteIcon, FolderIcon, LayersIcon, SettingsIcon,
} from '../icons'
import { ago, ALL_PRESENT, anyTierSeat, codexTierOffer, CODEX_TIERS, ANTIGRAVITY_TIERS, fmtCredits, hireOf, isOpenRouterTier, MODEL_VERSIONS, openrouterTierIds, pileOrder, PROVIDER_LABEL, providerOf, stateLabel, TIER_LETTER, tierCapabilityNotes, tierLabel, TIERS, tierShown, USER, useEsc } from './shared'
import type { ProviderPresence } from './shared'
import type { CanvasNode, DraftScope, DraftState, OpFn, Pile } from './shared'
import { ProcessLifecycleMark } from './desk'
import { ModalOverPins, PinFrame } from './modalpin'
import { fmtStamp } from '../timefmt'

export interface ConfirmModalProps {
  title: ReactNode
  body?: ReactNode
  confirmLabel: ReactNode
  onConfirm: () => void
  close: () => void
  /** FR-24: an optional SECOND way through — same confirmation gate, a
   *  different action (the compact dialog offers cheap-compact beside the
   *  normal fork). Both run through close-then-act like onConfirm. */
  altLabel?: ReactNode
  onAlt?: () => void
}

// The controls a keyboard can reach inside a dialog box, in document order,
// as they stand RIGHT NOW — asked at every keypress, never cached, so a button
// disabled mid-dialog drops out and one a re-render adds joins in. Attribute
// checks only: the box has no layout-hidden controls, and whether the browser
// really focuses each one is what `confirmfocus_probe.py` measures.
function tabbablesIn(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(
    'button, [href], input, select, textarea, [tabindex]'))
    .filter((el) => el.tabIndex >= 0 && !el.hasAttribute('disabled')
      && !el.closest('[hidden]'))
}

// in-page confirmation (user ruling: never a native OS dialog)
//
// Keyboard access (incremental-UX item 6, 2026-09-04): before this, opening
// the popup left focus on the button that opened it, the next Tab went to a
// background control, and nothing announced a dialog. Now the box is a
// role=dialog named by its title, focus moves INTO it on open, Tab and
// Shift+Tab cycle inside it, and closing hands focus back to the opener when
// that still makes sense. Same popup, same buttons, same Escape, same
// confirmation policy.
//
// Initial focus is CANCEL, not confirm: every caller's confirm is
// destructive (delete, retire, dissolve, rescind, dissolve-all, cross-provider
// reset, compaction), so Enter must not fire it by accident.
export function ConfirmModal({ title, body, confirmLabel, onConfirm, close,
  altLabel, onAlt }: ConfirmModalProps) {
  const ownerDocument = useSurfaceDocument()
  useEsc(close)
  const boxRef = useRef<HTMLDivElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const titleId = useId()
  const bodyId = useId()
  useEffect(() => {
    const box = boxRef.current
    if (!box) return
    // whoever had focus when we opened is the opener — remembered by
    // identity, so a re-render that replaces it is a stale opener, not a
    // focus target
    const opener = ownerDocument.activeElement instanceof (ownerDocument.defaultView!.HTMLElement)
      ? ownerDocument.activeElement : null
    ;(cancelRef.current ?? box).focus()
    if (!box.contains(ownerDocument.activeElement)) box.focus()
    // Tab containment lives on the DOCUMENT rather than the box so that a
    // Tab pressed while focus is on <body> (the opener was removed, or a
    // control the focus sat on vanished) still lands in the dialog instead
    // of walking the page behind it. Registered and removed together with the
    // dialog's own lifetime — the removal below is what keeps a closed dialog
    // from trapping the page.
    const onTab = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || e.defaultPrevented) return
      const items = tabbablesIn(box)
      const i = items.indexOf(ownerDocument.activeElement as HTMLElement)
      e.preventDefault()
      if (!items.length) { box.focus(); return }
      const step = e.shiftKey ? -1 : 1
      const next = i < 0
        ? (e.shiftKey ? items[items.length - 1] : items[0])
        : items[(i + step + items.length) % items.length]
      next?.focus()
    }
    ownerDocument.addEventListener('keydown', onTab, true)
    return () => {
      ownerDocument.removeEventListener('keydown', onTab, true)
      // Return focus to the opener only when nothing else claimed it: the
      // confirmed action may have moved focus itself (a hire walks you to
      // the new desk's composer), and that choice wins. An opener that is
      // gone (its card was deleted, its panel closed with us) is not
      // focused — that would throw focus at a detached node.
      const active = ownerDocument.activeElement
      const focusLeft = active && active !== ownerDocument.body && !box.contains(active)
      if (!focusLeft && opener && opener.isConnected
        && opener !== ownerDocument.body) opener.focus()
    }
  }, [ownerDocument])
  return (
    <div className="overlay" onClick={close} onPointerDown={(e) => e.stopPropagation()}>
      <div className="settings content-height confirm-box" ref={boxRef} tabIndex={-1}
        role="dialog" aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={body ? bodyId : undefined}
        onClick={(e) => e.stopPropagation()}>
        <h3 id={titleId}>{title}</h3>
        {body && <div className="confirm-body" id={bodyId}>{body}</div>}
        <div className="row">
          <button className="danger solid"
            onClick={() => { close(); onConfirm() }}>{confirmLabel}</button>
          {altLabel && onAlt &&
            <button className="danger"
              onClick={() => { close(); onAlt() }}>{altLabel}</button>}
          <button ref={cancelRef} onClick={close}>cancel</button>
        </div>
      </div>
    </div>
  )
}
// FR-18: the watchdog detail panel — the click-through half of the user's
// spec ("clicking on them shows a description of the process / command /
// file they're watching. they have a mail tab showing the events they've
// sent out"). Read-only over the dog's config (a dog is re-created, not
// edited) + the user's pause/resume/remove.
export function WatchdogPanel({ slug, dog, toast, close }: {
  slug: string
  dog: Watchdog
  toast: ToastFn
  close: () => void
}) {
  // user bug 2026-08-12 + 2026-08-14: long commands were unreadable — first
  // truncated with no recourse, then the full text hid behind a click nobody
  // found. The detail panel now OPENS with the whole target/pattern wrapped
  // in view; the click survives as a collapse for a screen-filling one.
  const [expTarget, setExpTarget] = useState(true)
  const [expPattern, setExpPattern] = useState(true)
  const act = (a: 'pause' | 'resume' | 'remove') =>
    watchdogAction(slug, dog.id, a)
      .then((r) => { toast([`${dog.name}: ${r.state}`]); if (a === 'remove') close() })
      .catch((e: Error) => toast([`error: ${e.message}`]))
  return (
    <PinFrame kind="watchdog" restore={{ watchdog: dog.id }} title={`${dog.name} · watchdog`} panel="settings content-height"
      close={close}>
        <h3>🐕 {dog.name}</h3>
        {/* THE DOG'S LIVE STATE IS NOT ITS NAME. It used to sit inside the h3,
            which a pinned window hides along with the duplicated heading —
            and 'departing' is exactly the thing you keep a watchdog window
            open to watch. Outside it, visible in both modes (Astra
            2026-09-06). */}
        <div className="dim modalpin-subtitle">
          watchdog · {dog.spent ? 'departing' : dog.state}
          {dog.once && <span className="wd-once-label">one-shot dog</span>}</div>
        {dog.once && <div className="wd-once-note">
          {dog.spent
            ? 'This one-shot dog has fired. Its spark is travelling to its owner; it will disappear shortly.'
            : 'One-shot dog — it will fire once and then disappear.'}
        </div>}
        <div className="field-label">owner</div>
        <div className="chip mono">{dog.owner}</div>
        <div className="field-label">{dog.kind === 'file' ? 'watched file'
          : dog.kind === 'process' ? 'watched process'
          : dog.kind === 'stream' ? 'listening command (realtime)'
          : 'command (each interval)'}</div>
        <div className={'chip mono grow wd-cmd' + (expTarget ? ' wd-expand' : '')}
          title={expTarget ? 'click to collapse' : 'click to see the full text'}
          onClick={() => setExpTarget((v) => !v)}>{dog.target}</div>
        {dog.pattern && <>
          <div className="field-label">fires on lines matching</div>
          <div className={'chip mono grow wd-cmd' + (expPattern ? ' wd-expand' : '')}
            title={expPattern ? 'click to collapse' : 'click to see the full text'}
            onClick={() => setExpPattern((v) => !v)}>{dog.pattern}</div>
        </>}
        <div className="dim">
          {dog.kind === 'stream'
            ? `realtime — fires at most every ${dog.interval_s}s (coalesced)`
            : `checked every ${dog.interval_s}s`}
          {' · '}{dog.fired} event{dog.fired === 1 ? '' : 's'} sent
          {dog.last_fired ? ` · last ${ago(dog.last_fired)} ago` : ''}
          {' · free (a pet, not a seat)'}
        </div>
        {dog.exit && (
          <div className="ask-warn">stream exited
            {dog.exit.code != null ? ` (code ${dog.exit.code})` : ''} — resume
            re-spawns it</div>
        )}
        <div className="field-label">events sent
          ({(dog.events ?? []).length} kept)</div>
        <div className="wd-events">
          {(dog.events ?? []).length === 0 &&
            <div className="dim">{dog.spent ? 'the one-shot dog has departed' : 'none yet — it is watching'}</div>}
          {[...(dog.events ?? [])].reverse().map((e, i) => (
            <div key={i} className="wd-event">
              <span className="dim">{ago(e.at)} ago</span> {e.gist}
            </div>
          ))}
        </div>
        <div className="row">
          {!dog.spent && (dog.state === 'armed'
            ? <button onClick={() => act('pause')}>pause</button>
            : <button className="primary" onClick={() => act('resume')}>
                {dog.state === 'exited' ? 'resume (re-spawn)' : 'resume'}</button>)}
          <span style={{ flex: 1 }} />
          {!dog.spent && <button className="danger" onClick={() => act('remove')}>remove</button>}
          <button onClick={close}>close</button>
        </div>
    </PinFrame>
  )
}

// ⚙ on the overseer — the org's agent-hire defaults, symmetric with each
// agent's own config modal. Granted to hires that don't state tools: top-level
// agents get exactly this; deeper hires get the ∩ with the superior's
// capability (clamped server-side at hire time). "*" = every registered MCP
// server, present and future.
interface UserConfigProps {
  tree: TreePayload
  slug: string
  toast: ToastFn
  close: () => void
}

export function UserConfig({ tree, slug, toast, close }: UserConfigProps) {
  // Escape belongs to PinFrame now: a CENTRED surface still closes on it, a
  // PINNED window ignores it the way an agent window does.
  // visitors configure the HIRE DEFAULTS too (user ruling 2026-07-31),
  // ceiling-clamped server-side; the org folder holdings stay admin-only
  // (host paths — the public payload only carries basenames anyway)
  const pub = !!tree.public
  const [asking, setAsking] = useState(false)   // dissolve-all confirmation
  const [servers, setServers] = useState<string[]>([])
  const [sandboxMcp, setSandboxMcp] = useState(false)
  // P3: derived from `tree`, with a buffer holding only what has been edited
  // — see NodeConfig for the reasoning. These are org DEFAULTS the server
  // owns, so a snapshot at mount could show yesterday's answer.
  const [edit, setEdit] = useState<Record<string, unknown>>({})
  const val = <T,>(k: string, server: T): T => (k in edit ? edit[k] as T : server)
  const set = <T,>(k: string, cur: T) => (v: T | ((prev: T) => T)) =>
    setEdit((e) => ({ ...e,
      [k]: typeof v === 'function' ? (v as (p: T) => T)(cur) : v }))
  const srvTools = useMemo<ToolGrant>(() => ({
    bash: true, web: true, edit: true, subagents: true,
    ...(tree.default_tools ?? {}),
    mcp: [...(tree.default_tools?.mcp ?? ['*'])],
  }), [tree.default_tools])
  const defTools = val<ToolGrant>('defTools', srvTools)
  const setDefTools = set<ToolGrant>('defTools', defTools)
  const vis = val('vis', tree.default_visibility ?? 'full')
  const setVis = set<string>('vis', vis)
  const pm = val('pm', tree.permission_mode ?? 'acceptEdits')
  const setPm = set<string>('pm', pm)
  // the org's folder holdings (workspace excluded — it is permanent RW).
  // These double as the folder defaults for every hire.
  const srvDirs = useMemo<DirGrant[]>(
    () => (tree.dirs ?? []).filter((d) => d.path !== tree.workspace)
      .map((d) => ({ ...d })), [tree.dirs, tree.workspace])
  const orgDirs = val<DirGrant[]>('orgDirs', srvDirs)
  const setOrgDirs = set<DirGrant[]>('orgDirs', orgDirs)
  const [newPath, setNewPath] = useState('')
  useEffect(() => {
    getMcpServers().then((r) => {
      setServers(r.servers ?? []); setSandboxMcp(!!r.sandbox_mcp)
    }).catch(() => {})
  }, [])
  const allMcp = defTools.mcp.includes('*')
  return (
    <PinFrame kind="user-config" title="you · configuration" panel="settings"
      close={close}>
        <h3><SettingsIcon fontSize="inherit" /> you <span className="dim">· configuration</span></h3>
        <div className="row">
          <button className="danger" onClick={() => setAsking(true)}>
            dissolve all agents</button>
        </div>
        {/* folder access FIRST — same order as the per-agent config (user ruling) */}
        {!pub && <><div className="field-label">folder access</div>
        <div className="dirlist">
          {tree.workspace && (
            <div className="dirrow">
              <span className="chip mono grow">{tree.workspace}</span>
              <span className="modebtn rw"
                title="the org workspace — permanent, always read/write">RW</span>
            </div>
          )}
          {orgDirs.map((d, i) => (
            <div className="dirrow" key={d.path}>
              <span className="chip mono grow">{d.path}</span>
              <button type="button" className={'modebtn ' + d.mode}
                title="toggle read/write vs read-only"
                onClick={() => setOrgDirs(orgDirs.map((x, j) =>
                  j === i ? { ...x, mode: x.mode === 'rw' ? 'ro' : 'rw' } : x))}>
                {d.mode === 'rw' ? 'RW' : 'RO'}
              </button>
              <button type="button" className="iconbtn"
                title="remove from the org (revokes everywhere)"
                onClick={() => setOrgDirs(orgDirs.filter((_, j) => j !== i))}><CloseIcon fontSize="inherit" /></button>
            </div>
          ))}
          <div className="dirrow">
            <input placeholder="add an absolute path"
              value={newPath} onChange={(e) => setNewPath(e.target.value)} />
            <button type="button" className="iconbtn" title="browse for a folder"
              onClick={() => pickFolder().then((r) => {
                if (r.path) setOrgDirs([...orgDirs, { path: r.path, mode: 'rw' }])
              }).catch(() => {})}><FolderIcon fontSize="inherit" /></button>
            <button type="button" className="addrow" onClick={() => {
              if (newPath.trim()) {
                setOrgDirs([...orgDirs, { path: newPath.trim(), mode: 'rw' }])
                setNewPath('')
              }
            }}>add</button>
          </div>
        </div></>}
        <div className="field-label">tools</div>
        {TOOL_LABELS.map(([k, label]) => (
          <label className="checkline" key={k}>
            <input type="checkbox" checked={!!defTools[k]}
              onChange={(e) => setDefTools({ ...defTools, [k]: e.target.checked })} />
            {label}
          </label>
        ))}
        <div className="field-label">MCP servers</div>
        <label className="checkline">
          <input type="checkbox" checked={allMcp}
            onChange={(e) => setDefTools({
              ...defTools, mcp: e.target.checked ? ['*'] : [...servers] })} />
          all registered servers (current and future)
        </label>
        {!allMcp && !pub && <McpChecklist servers={servers} sandboxMcp={sandboxMcp}
          sandboxed={!!tree.sandboxed}
          checked={(s) => defTools.mcp.includes(s)}
          onToggle={(s, on) => setDefTools({
            ...defTools,
            mcp: on ? [...defTools.mcp, s] : defTools.mcp.filter((x) => x !== s),
          })} />}
        {!allMcp && pub && <div className="dim">
          individual server names are admin-side — off means none</div>}
        <div className="field-label">org-structure visibility</div>
        <select value={vis} onChange={(e) => setVis(e.target.value)}>
          {VIS_OPTIONS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
        </select>
        {/* D-101: the born-with mode, editable post-creation. Admin-only —
            it rides /settings (frozen for kiosk visitors), never the
            visitor-open defaults endpoint. It is a DEFAULT: existing agents
            keep the mode they were hired with and change one at a time in
            their own ⚙. */}
        {!pub && <>
          <div className="field-label">permission mode for NEW agents — existing
            ones keep theirs (change those in the agent&apos;s own ⚙)</div>
          <select value={pm} onChange={(e) => setPm(e.target.value)}>
            <option value="plan">plan — read-only planning seat</option>
            <option value="default">default — asks (headless: auto-denies)</option>
            <option value="acceptEdits">acceptEdits — the normal seat</option>
            <option value="bypassPermissions">bypassPermissions ⚠ unguarded</option>
          </select>
        </>}
        <div className="row">
          <button className="primary" onClick={() =>
            // defaults ride their own visitor-open, ceiling-clamped endpoint;
            // the org folder holdings stay on the admin-only /settings
            Promise.all([
              saveHireDefaults(slug, { default_tools: defTools,
                                       default_visibility: vis }),
              pub ? Promise.resolve<{ warnings?: string[] }>({})
                : saveSettings(slug, { org_dirs: orgDirs,
                                       permission_mode: pm }),
            ])
              .then(([r, r2]) => {
                const warns = [...(r.warnings ?? []), ...(r2.warnings ?? [])]
                if (r?.bridge?.raise_ceiling) {
                  toast(warns.length ? warns
                    : ['clamped to the kiosk permission ceiling'],
                  { label: 'raise ceiling & apply',
                    fn: () => saveHireDefaults(slug,
                      { default_tools: defTools, default_visibility: vis,
                        raise_ceiling: true })
                      .then((r3) => toast(r3.warnings?.length ? r3.warnings
                        : ['ceiling raised — defaults applied']))
                      .catch((e: Error) => toast([`error: ${e.message}`])) })
                } else toast(warns)
                close()
              })
              .catch((e: Error) => toast([`error: ${e.message}`]))}>save</button>
          <button onClick={close}>cancel</button>
        </div>
      {/* portaled out: a confirmation nested in a pinned panel is trapped in
          that panel's stacking context — see ModalOverPins */}
      {asking && (
        <ModalOverPins><ConfirmModal title="dissolve ALL agents?"
          body="Every agent in the entire org is retired at once. Context is kept; rehire brings any of them back."
          confirmLabel="dissolve all"
          onConfirm={() => dissolveAll(slug)
            .then((r) => { toast([`dissolved ${r.nodes} node(s), freed ${fmtCredits(r.freed)} credits`]); close() })
            .catch((e: Error) => toast([`error: ${e.message}`]))}
          close={() => setAsking(false)} /></ModalOverPins>
      )}
    </PinFrame>
  )
}
// Pre-hire permissions (user spec): the same scope surface as the per-agent
// ⚙ panel — folders with RW/RO, tool switches, MCP grants, org visibility —
// but staged locally and applied WITH the hire, so nothing needs adjusting
// after the agent exists. Prefilled from what the hire would inherit anyway.
interface DraftScopeModalProps {
  draft: DraftState
  map: Map<string, CanvasNode>
  tree: TreePayload
  scope: DraftScope | null
  onSave: (scope: DraftScope) => void
  close: () => void
}

/** item 12 — the "Prefer reserve" checkbox (user ruling 2026-09-04: "make
 *  the choice to use reserve instead of normal weekly luna usage a checkbox,
 *  defaulted by the app-wide setting. when off, weekly usage is used first,
 *  then reserve"). One
 *  component for the draft's modal and the gear so the wording cannot
 *  drift. It sets the ORDER only: the other pool is the fallback either
 *  way, and the header token reports what actually ran, not this box. */
export function PreferReserveRow({ checked, onChange, onUseAppDefault }: {
  checked: boolean; onChange: (v: boolean) => void
  onUseAppDefault?: () => void
}) {
  return (
    <>
      <div className="field-label">reserve capacity — luna only</div>
      <label className="prefer-reserve">
        <input type="checkbox" checked={checked}
          onChange={(e) => onChange(e.target.checked)} />
        {' '}prefer reserve capacity
      </label>
      {onUseAppDefault && <button type="button" onClick={onUseAppDefault}>
        use app default</button>}
      <div className="dim hub-hint">
        {checked
          ? 'turns use OpenAI’s reserve pool first and fall back to normal weekly Luna usage when reserve is spent or withdrawn'
          : 'turns use normal weekly Luna usage first and fall back to reserve when the weekly pool is spent'}
        {' — the desk header shows which pool a turn actually ran on'}
      </div>
    </>
  )
}

export function DraftScopeModal({ draft, map, tree, scope, onSave, close }: DraftScopeModalProps) {
  const parent = draft.parent ? map.get(draft.parent) : null
  const inherited = (): DraftScope => ({
    add_dirs: (parent ? parent.scope?.add_dirs : tree.dirs) ?? [],
    tools: parent?.scope?.tools
      ?? tree.default_tools
      ?? { bash: true, web: true, edit: true, subagents: true, mcp: ['*'] },
    org_visibility: parent?.scope?.org_visibility
      ?? tree.default_visibility ?? 'full',
  })
  const base = scope ?? inherited()
  // ⚠ These four ARE useState-from-a-prop and are deliberately left that way.
  // This modal stages permissions for an agent that DOES NOT EXIST YET: `base`
  // is a one-time proposal (what the hire would inherit), not a live server
  // value with an authoritative copy elsewhere. Re-deriving it mid-edit would
  // overwrite the user's staged choices from a default they were changing.
  // A snapshot is the correct shape here; the P3 sweep skipped it on purpose.
  const [dirs, setDirs] = useState<DirGrant[]>(base.add_dirs.map((d) => ({ ...d })))
  const [tools, setTools] = useState<Partial<ToolGrant> & { mcp: string[] }>(
    { ...base.tools, mcp: [...(base.tools.mcp ?? [])] })
  const [vis, setVis] = useState(base.org_visibility)
  const [effort, setEffort] = useState(base.effort ?? '')
  // item 12 (user ruling 2026-09-04): "Prefer reserve", seeded from the
  // app-wide default; only a luna draft shows it, and only a luna acts on it
  const [preferReserve, setPreferReserve] = useState(
    base.prefer_reserve ?? tree.prefer_reserve_default ?? true)
  const [preferReserveTouched, setPreferReserveTouched] = useState(
    base.prefer_reserve !== undefined)
  const changePreferReserve = (v: boolean) => {
    setPreferReserve(v); setPreferReserveTouched(true)
  }
  const [newPath, setNewPath] = useState('')
  const [servers, setServers] = useState<string[]>([])
  const [sandboxMcp, setSandboxMcp] = useState(false)
  useEffect(() => {
    getMcpServers().then((r) => {
      setServers(r.servers ?? []); setSandboxMcp(!!r.sandbox_mcp)
    }).catch(() => {})
  }, [])
  const allMcp = tools.mcp.includes('*')
  // portal to <body>: the draft card lives inside the world transform, where
  // position:fixed would resolve against the SCALED ancestor (giant modal)
  return (
    <ModalOverPins><PinFrame kind="draft-scope" title="Draft permissions" panel="settings" close={close} pinnable={false}>
        <h3><SettingsIcon fontSize="inherit" /> permissions <span className="dim">
          · applied with the hire</span></h3>
        <div className="field-label">folder access</div>
        <div className="dirlist">
          {dirs.map((d, i) => (
            <div className="dirrow" key={d.path}>
              <span className="chip mono grow">{d.path}</span>
              <button type="button" className={'modebtn ' + d.mode}
                title="toggle read/write vs read-only"
                onClick={() => setDirs(dirs.map((x, j) =>
                  j === i ? { ...x, mode: x.mode === 'rw' ? 'ro' : 'rw' } : x))}>
                {d.mode === 'rw' ? 'RW' : 'RO'}
              </button>
              <button type="button" className="iconbtn"
                onClick={() => setDirs(dirs.filter((_, j) => j !== i))}>
                <CloseIcon fontSize="inherit" /></button>
            </div>
          ))}
          <div className="dirrow">
            <input placeholder="add an absolute path"
              value={newPath} onChange={(e) => setNewPath(e.target.value)} />
            <button type="button" className="iconbtn" title="browse for a folder"
              onClick={() => pickFolder().then((r) => {
                if (r.path) setDirs([...dirs, { path: r.path, mode: 'rw' }])
              }).catch(() => {})}><FolderIcon fontSize="inherit" /></button>
            <button type="button" className="addrow" onClick={() => {
              if (newPath.trim()) {
                setDirs([...dirs, { path: newPath.trim(), mode: 'rw' }])
                setNewPath('')
              }
            }}>add</button>
          </div>
        </div>
        <div className="field-label">tools</div>
        {TOOL_LABELS.map(([k, label]) => (
          <label className="checkline" key={k}>
            <input type="checkbox" checked={!!tools[k]}
              onChange={(e) => setTools({ ...tools, [k]: e.target.checked })} />
            {label}
          </label>
        ))}
        <div className="field-label">MCP servers</div>
        <label className="checkline">
          <input type="checkbox" checked={allMcp}
            onChange={(e) => setTools({
              ...tools, mcp: e.target.checked ? ['*'] : [...servers] })} />
          all registered servers (current and future)
        </label>
        {!allMcp && <McpChecklist servers={servers} sandboxMcp={sandboxMcp}
          sandboxed={!!tree.sandboxed}
          checked={(s) => tools.mcp.includes(s)}
          onToggle={(s, on) => setTools({
            ...tools,
            mcp: on ? [...tools.mcp, s] : tools.mcp.filter((x) => x !== s),
          })} />}
        <div className="field-label">org-structure visibility</div>
        <select value={vis} onChange={(e) => setVis(e.target.value)}>
          {VIS_OPTIONS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
        </select>
        <div className="field-label">thinking effort</div>
        <select value={effort} onChange={(e) => setEffort(e.target.value)}>
          <option value="">{`inherit — org default (${tree.default_effort || tree.effort_default || 'high'})`}</option>
          <option value="low">low</option>
          <option value="medium">medium</option>
          <option value="high">high</option>
          <option value="xhigh">xhigh</option>
          <option value="max">max</option>
        </select>
        {draft.tier === 'luna' && (
          <PreferReserveRow checked={preferReserve} onChange={changePreferReserve} />
        )}
        <div className="hint">
          Grants clamp to what the parent holds (№30) — anything beyond its
          capability is trimmed at hire with a warning.
        </div>
        <div className="row">
          <button className="primary" onClick={() =>
            onSave({ add_dirs: dirs, tools, org_visibility: vis,
              ...(effort ? { effort } : {}),
              ...(draft.tier === 'luna' && preferReserveTouched
                ? { prefer_reserve: preferReserve } : {}) })}>apply</button>
          <button onClick={close}>cancel</button>
        </div>
    </PinFrame></ModalOverPins>
  )
}
// ------------------------------------------------------------ node ⚙ config
// MCP server checklist shared by the org / per-agent / pre-hire scope panels.
// In a SANDBOXED org, ALL servers grey out (user ruling): they are points of
// external contact the sandbox is explicitly designed to restrict. The
// experimental ORGTREE_SANDBOX_MCP env var re-enables them (url + portable
// stdio passthrough, no full support).
interface McpChecklistProps {
  servers: string[]
  sandboxed: boolean
  sandboxMcp: boolean
  checked: (s: string) => boolean
  onToggle: (s: string, on: boolean) => void
}

function McpChecklist({ servers, sandboxed, sandboxMcp, checked, onToggle }: McpChecklistProps) {
  const dead = sandboxed && !sandboxMcp
  return (
    <>
      {dead && (
        <div className="hint">
          sandboxed org — MCP servers are external contact points the sandbox
          restricts, so none reach its agents (the ORGTREE_SANDBOX_MCP env var
          enables URL/portable servers experimentally)
        </div>
      )}
      {servers.map((s) => (
        <label className={'checkline' + (dead ? ' dead' : '')} key={s}
          title={dead ? 'unavailable in a sandboxed org' : undefined}>
          <input type="checkbox" disabled={dead} checked={checked(s)}
            onChange={(e) => onToggle(s, e.target.checked)} />
          <span className="mono">{s}</span>
        </label>
      ))}
    </>
  )
}

const VIS_OPTIONS = [
  ['self', 'self'],
  ['team', 'team'],
  ['subtree', 'subtree'],
  ['full', 'full (default)'],
] as const

/* D-106 (user ruling 2026-08-07): a grant deeper than the chain can carry no
 * longer refuses — every agent BETWEEN the granter and the grantee is raised
 * to hold it. The user is the granter here, so the chain is every ancestor of
 * the target, and they asked to be WARNED BEFORE saving rather than told
 * after: which agents this grant is about to expand, and in what.
 *
 * Computed client-side from the tree the panel already has — the same union
 * the ledger performs (ledger._raise_along), so the preview and the outcome
 * are one rule expressed twice. ⚠ That duplication is the risk: if the two
 * drift, the warning lies. It is worth it because the alternative is a
 * round-trip on every keystroke, but the ledger stays the authority — its
 * answer, `cascaded`, is what the toast reports after the fact. */
const PM_RANK = ['plan', 'default', 'acceptEdits', 'bypassPermissions']
const VIS_RANK = ['self', 'team', 'subtree', 'full']

export function cascadePreview(
  map: Map<string, CanvasNode>, nodeId: string, want: {
    dirs?: DirGrant[]; tools?: ToolGrant; vis?: string; pm?: string
  },
): { id: string; gains: string[] }[] {
  const out: { id: string; gains: string[] }[] = []
  let cur = map.get(nodeId)?.parent ?? null
  while (cur && cur !== USER) {
    const n = map.get(cur)
    if (!n?.scope) break
    const gains: string[] = []
    if (want.dirs) {
      const held = new Map((n.scope.add_dirs ?? []).map((d) => [d.path, d.mode]))
      for (const d of want.dirs) {
        if (!held.has(d.path)) gains.push(`${d.path} ${d.mode}`)
        else if (held.get(d.path) === 'ro' && d.mode === 'rw') gains.push(`${d.path} ro→rw`)
      }
    }
    if (want.tools) {
      for (const k of ['bash', 'web', 'edit', 'subagents'] as const) {
        if (want.tools[k] && !(n.scope.tools as Record<string, unknown>)?.[k]) gains.push(k)
      }
      const have = (n.scope.tools?.mcp ?? []) as string[]
      const wm = want.tools.mcp ?? []
      if (wm.includes('*') && !have.includes('*')) gains.push('mcp:*')
      else if (!have.includes('*')) {
        for (const s of wm) if (!have.includes(s)) gains.push(`mcp:${s}`)
      }
    }
    if (want.vis) {
      const c = n.scope.org_visibility ?? 'full'
      if (VIS_RANK.indexOf(want.vis) > VIS_RANK.indexOf(c)) gains.push(`visibility ${c}→${want.vis}`)
    }
    if (want.pm) {
      const c = n.scope.permission_mode ?? 'acceptEdits'
      if (PM_RANK.indexOf(want.pm) > PM_RANK.indexOf(c)) gains.push(`mode ${c}→${want.pm}`)
    }
    if (gains.length) out.push({ id: cur, gains })
    cur = n.parent ?? null
  }
  return out
}

const TOOL_LABELS = [
  ['bash', 'terminal (Bash)'],
  ['web', 'web browsing (search + fetch)'],
  ['edit', 'file editing (Write / Edit / notebooks)'],
  ['subagents', 'ephemeral subagents (Task / Agent tool)'],
] as const
interface NodeConfigProps {
  node: CanvasNode
  map: Map<string, CanvasNode>
  tree: TreePayload
  slug: string
  op: OpFn
  toast: ToastFn
  codexProvider?: ProviderInfo | null
  antigravityProvider?: ProviderInfo | null
  openrouterProvider?: ProviderInfo | null
  /** D-202: which provider families this machine has at all. Absent = the
   *  optimistic default (everything), so a caller that has not resolved the
   *  payload behaves exactly as this panel did before. */
  presence?: ProviderPresence
  close: () => void
}

export function NodeConfig({ node, map, tree, slug, op, toast, codexProvider,
  antigravityProvider, openrouterProvider, presence = ALL_PRESENT, close }: NodeConfigProps) {
  // Escape belongs to PinFrame now: a CENTRED surface still closes on it, a
  // PINNED window ignores it the way an agent window does.
  const [asking, setAsking] =
    useState<'delete' | 'dissolve' | 'retire' | 'rescind' | 'crossprovider' | 'reply-quotes' | null>(null)
  const [removingQuotes, setRemovingQuotes] = useState(false)
  // every card that opens a config panel carries a scope (real nodes and
  // bearer stubs both) — only the eye root and drafts lack one
  const scope = node.scope!
  // P3 — these seven were each a useState SEEDED FROM `node`/`scope`, i.e. a
  // snapshot taken once at mount that never looked at the prop again. That is
  // what produced a config panel showing an empty charter: the panel had
  // captured the node before it carried one. One buffer of ACTUAL EDITS now;
  // everything else derives from the prop each render, so the panel cannot
  // drift from the agent it is configuring. The shadowing pairs below keep
  // every use site below unchanged.
  const [edit, setEdit] = useState<Record<string, unknown>>({})
  const val = <T,>(k: string, server: T): T => (k in edit ? edit[k] as T : server)
  const set = <T,>(k: string, cur: T) => (v: T | ((prev: T) => T)) =>
    setEdit((e) => ({ ...e,
      [k]: typeof v === 'function' ? (v as (p: T) => T)(cur) : v }))
  const srvDirs = useMemo(
    () => scope.add_dirs.map((d) => ({ ...d })), [scope.add_dirs])
  const srvTools = useMemo<ToolGrant>(() => ({
    bash: true, web: true, edit: true, subagents: true,
    ...(scope.tools ?? {}),
    mcp: [...(scope.tools?.mcp ?? [])],
  }), [scope.tools])
  const dirs = val<DirGrant[]>('dirs', srvDirs)
  const setDirs = set<DirGrant[]>('dirs', dirs)
  const tools = val<ToolGrant>('tools', srvTools)
  const setTools = set<ToolGrant>('tools', tools)
  const vis = val('vis', scope.org_visibility ?? 'full')
  const setVis = set<string>('vis', vis)
  const charter = val('charter', node.charter ?? '')
  const setCharter = set<string>('charter', charter)
  const teamCharter = val('teamCharter', node.team_charter ?? '')
  const setTeamCharter = set<string>('teamCharter', teamCharter)
  const model = val('model', node.tier!)
  const setModel = set<string>('model', model)
  const effort = val('effort', scope.effort ?? '')
  const setEffort = set<string>('effort', effort)
  const pm = val('pm', scope.permission_mode ?? 'acceptEdits')
  const setPm = set<string>('pm', pm)
  // Per-node known-cold compaction override — '' inherit | 'on' | 'off'
  const srvAcc = (scope as { auto_cheap_compact?: { enabled?: boolean
    occ?: number } }).auto_cheap_compact
  const accMode = val('accMode',
    srvAcc == null ? '' : srvAcc.enabled ? 'on' : 'off')
  const setAccMode = set<string>('accMode', accMode)
  const accOcc = val<number | string>('accOcc',
    Math.round((srvAcc?.occ ?? 0.5) * 100))
  const setAccOcc = set('accOcc', accOcc)
  // D-106: who this pending grant would raise, recomputed as the form changes
  const cascade = useMemo(
    () => cascadePreview(map, node.id,
      { dirs, tools, vis, pm }), [map, node.id, dirs, tools, vis, pm])
  // a model VERSION is a subcategory of the TIER, so it lives here in the gear
  // and never on a chip (user ruling 2026-08-04). It resets when the tier
  // changes: a version belongs to one tier, and the ledger re-validates it
  // against the node's current tier on every read anyway.
  const modelVersion = val('modelVersion', scope.model_version ?? '')
  const setModelVersion = set<string>('modelVersion', modelVersion)
  const versions = MODEL_VERSIONS[model] ?? []
  // item 12 (user ruling 2026-09-04): the per-agent "Prefer reserve"
  // checkbox — which pool a luna tries FIRST. Absent on the wire inherits the
  // app-wide default.
  // Editable here so the preference is not creation-only; shown only when
  // the (possibly just-picked) tier is luna, saved for any tier so it
  // survives a switch away and back.
  const preferReserve = val<boolean>('preferReserve',
    scope.prefer_reserve ?? tree.prefer_reserve_default ?? true)
  const preferReserveChanged = val('preferReserveChanged', false)
  const clearPreferReserve = val('clearPreferReserve', false)
  const setPreferReserve = (v: boolean) => setEdit((e) => ({ ...e,
    preferReserve: v, preferReserveChanged: true, clearPreferReserve: false }))
  const useAppDefault = () => setEdit((e) => ({ ...e,
    preferReserve: tree.prefer_reserve_default ?? true,
    preferReserveChanged: false, clearPreferReserve: true }))
  const reservePayload = clearPreferReserve
    ? { clear_prefer_reserve: true }
    : (scope.prefer_reserve !== undefined || preferReserveChanged)
      ? { prefer_reserve: preferReserve } : {}
  const [newPath, setNewPath] = useState('')
  const [servers, setServers] = useState<string[]>([])
  const [sandboxMcp, setSandboxMcp] = useState(false)
  // multi-account (D5): the node's binding — chosen WITH a cross-provider
  // switch (atomic, backend-required) or reassigned on its own; disclosure
  // (billing/standing) surfaces in the toast at the point of action
  const [acct, setAcct] = useState(node.account ?? '')
  const [acctRows, setAcctRows] = useState<{
    id: string; provider: string; label: string
    standing: { state: string } }[]>([])
  const [initInfo, setInitInfo] = useState<ChatInit | null>(null)   // №14: the CLI's own resolution
  useEffect(() => {
    getMcpServers().then((r) => {
      setServers(r.servers ?? []); setSandboxMcp(!!r.sandbox_mcp)
    }).catch(() => {})
    getChat(slug, node.id, 1).then((c) => setInitInfo(c.init ?? null))
      .catch(() => {})
    req<{ accounts: typeof acctRows }>(`/api/accounts?org=${slug}`)
      .then((r) => setAcctRows(Array.isArray(r?.accounts) ? r.accounts : []))
      .catch(() => setAcctRows([]))
  }, [slug, node.id])
  // D-196: does this save move the agent to a DIFFERENT PROVIDER? Answered by
  // the shared `providerOf`, never by testing tier membership inline — the
  // second copy of that question is what D-182 was about.
  const crossProvider = model !== node.tier
    && providerOf(model) !== providerOf(node.tier ?? '')
  // D-234 (user ruling 2026-09-03): a switch asked for while the agent is
  // MID-TURN is queued, not applied — and the user must understand that at
  // the moment of the action, so a busy node's switch asks too, whatever the
  // provider. `busy` is the supervisor's live answer layered onto the node.
  const midTurn = model !== node.tier && Boolean(node.busy)
  const asksFirst = crossProvider || midTurn
  // ONE save implementation, reached either directly or through the
  // confirmation. Extracted rather than duplicated so the confirmed path
  // cannot drift from the unconfirmed one — and so CANCEL is simply "never
  // call this", which is what makes cancelling total rather than partial.
  const acctChanged = acct !== (node.account ?? '')
  const doSave = () =>
    (model !== node.tier
      ? op({ op: 'switch_model', node: node.id, tier: model,
             // atomic switch+rebind: the account rides the same act (the
             // backend requires it for a cross-provider switch on a bound
             // node and refuses a mismatched one)
             ...(acct ? { account: acct } : {}) })
      : acctChanged && acct
        ? assignAccount(slug, node.id, acct).then((d) => {
            toast([`${node.id} → account ${d.account} (${d.billing_mode})`
              + (d.standing.state === 'limited'
                ? ` — WILL WAIT until ${new Date(
                    ((d.standing as { until?: number }).until ?? 0) * 1000)
                    .toLocaleString()}`
                  + ((d.standing as { provenance?: string }).provenance
                    === 'inferred' ? ' (inferred)' : '')
                : '')
              + (d.session_boundary ? ' — session restarts next turn' : '')])
          })
        : Promise.resolve())
      .then(() => saveScope(slug, node.id,
        { add_dirs: dirs, tools, org_visibility: vis,
          permission_mode: pm,
          charter, team_charter: teamCharter, effort,
          auto_cheap_compact: accMode === '' ? {}
            : { enabled: accMode === 'on',
                occ: (+accOcc || 50) / 100 },
          model_version: versions.includes(modelVersion)
            ? modelVersion : '',
          ...reservePayload }))
      .then((r) => {
        if (r?.bridge?.raise_ceiling) {
          // one-action bridge (ceiling spec §1): same save, flag set
          toast(r.warnings?.length ? r.warnings
            : ['clamped to the kiosk permission ceiling'],
          { label: 'raise ceiling & apply',
            fn: () => saveScope(slug, node.id,
              { add_dirs: dirs, tools, org_visibility: vis,
                permission_mode: pm,
                charter, team_charter: teamCharter, effort,
                auto_cheap_compact: accMode === '' ? {}
                  : { enabled: accMode === 'on',
                      occ: (+accOcc || 50) / 100 },
                model_version: versions.includes(modelVersion)
                  ? modelVersion : '',
                ...reservePayload,
                raise_ceiling: true })
              .then((r2) => toast(r2.warnings?.length ? r2.warnings
                : ['ceiling raised — applied']))
              .catch((e: Error) => toast([`error: ${e.message}`])) })
        } else toast(r.warnings)
        close()
      })
      .catch((e: Error) => toast([`error: ${e.message}`]))
  const parent = map.get(node.id)?.parent
  const parentNode = parent && parent !== USER ? map.get(parent) : null
  const parentTools = parentNode?.scope?.tools ?? null   // null = the user: everything
  const parentDirs = parentNode
    ? (parentNode.scope?.add_dirs ?? [])
    : (tree.dirs ?? []).map((d) => ({ ...d }))   // org holdings carry modes now
  const addable = parentDirs.filter((pd) => !dirs.some((d) => d.path === pd.path))
  const parentHolds = (k: 'bash' | 'web' | 'edit' | 'subagents') =>
    parentTools == null || parentTools[k] !== false
  // "*" = every registered server, present and future
  const parentHoldsMcp = (s: string) => parentTools == null
    || (parentTools.mcp ?? []).includes('*') || (parentTools.mcp ?? []).includes(s)
  const holdsAllMcp = tools.mcp.includes('*')
  // The ledger owns the actual seat table (including customized org values),
  // while the frontend constants are only a startup fallback. Provider is an
  // axis over that one flat tier vocabulary, never a second price table.
  const tierSeat = (t: string) => tree.tiers?.[t] ?? anyTierSeat(t)
  // Keep the same refusal order as provider_hire_gate: provider presence and
  // login first, then org policy, then the headless authentication rule.
  const codexUnavailable = !codexProvider?.hire_enabled
    ? codexProvider?.reason ?? 'provider state unavailable'
    : tree.kiosk
      ? 'unavailable in kiosk orgs'
      : tree.headless && codexProvider.status.kind !== 'api-key'
        ? 'headless requires a Codex API-key login'
        : null
  const antigravityUnavailable = !antigravityProvider?.hire_enabled
    ? antigravityProvider?.reason ?? 'provider state unavailable'
    : tree.kiosk
      ? 'unavailable in kiosk orgs'
      : tree.headless
        // the CLI's only login is a Google account — no keyed lane exists
        ? 'headless orgs cannot hire Antigravity (Google-account login only, no API key)'
        : null
  // the OpenRouter lane: a key IS a keyed login, so headless never refuses
  // it; kiosks hold it out like the other non-Claude lanes
  const openrouterUnavailable = !openrouterProvider?.hire_enabled
    ? openrouterProvider?.reason ?? 'provider state unavailable'
    : tree.kiosk ? 'unavailable in kiosk orgs' : null
  const unavailable = (t: string): string | null => {
    // The current tier remains a truthful selected no-op even if policy has
    // since tightened around it; save does not call switch_model for a no-op.
    if (t === node.tier) return null
    if (CODEX_TIERS.includes(t) && codexUnavailable) return codexUnavailable
    if (ANTIGRAVITY_TIERS.includes(t) && antigravityUnavailable) return antigravityUnavailable
    if (isOpenRouterTier(t)) {
      if (openrouterUnavailable) return openrouterUnavailable
      if (!openrouterTierIds().includes(t)) return 'not among current favorites'
    }
    const cap = tree.kiosk?.max_tier
    if (cap && tierSeat(t) > tierSeat(cap)) return `above kiosk cap (${cap})`
    return null
  }
  // D-202. `tierShown` is the shared rule; `node.tier` is the `keep` that
  // survives it. Note the asymmetry with `unavailable` directly above: a tier
  // whose provider is INSTALLED but signed out is still listed and disabled
  // with its reason (user confirmed 2026-08-30), while one whose provider is
  // absent is not listed at all. Two different claims, two different answers.
  // A LEGACY token (gpt-reserve, item 12) is REMOVED from the dropdown, not
  // listed disabled — `codexTierOffer` answers 'hide' for it unconditionally,
  // the same verdict the hire chips get, so no surface can offer it.
  //
  // `node.tier` survives it, by the same `keep` rule `tierShown` applies one
  // line down: a node ALREADY on gpt-reserve must still see its own tier as
  // the truthful selected no-op, or the select would silently read as some
  // other model. Moving it to luna is the offered way off the token.
  const codexHire = hireOf(codexProvider)
  const shownTiers = (fam: readonly string[]) =>
    fam.filter((t) => tierShown(presence, t, node.tier)
      && !(CODEX_TIERS.includes(t) && codexTierOffer(codexHire, t) === 'hide'
        && t !== node.tier))
  const modelOption = (t: string) => {
    const why = unavailable(t)
    // the OpenRouter catalog's declarations — tools, image input, the
    // reasoning parameter — from the ONE formatter (`tierCapabilityNotes`,
    // '' for every static tier). A switch is a decision about what an agent
    // will be able to do, so it is made where the decision is made rather
    // than only back in the catalog picker. Moved from the tools-only note
    // deliberately (unit C, 2026-09-05).
    const tools = tierCapabilityNotes(t)
    return (
      <option key={t} value={t} disabled={!!why}>
        {tierLabel(t)} · seat {fmtCredits(tierSeat(t))}{tools ? ` · ${tools}` : ''}{why ? ` — ${why}` : ''}
      </option>
    )
  }
  return (
    // pointerdown must not reach the viewport: its pan pointer-CAPTURE retargets
    // the click, so backdrop-close and every button in here silently broke
    <PinFrame kind="node-config" restore={{ agent: node.id, generation: node.generation }} title={`${node.id} · configuration`}
      panel="settings cfg" close={close}>
        <h3><SettingsIcon fontSize="inherit" /> {node.id}</h3>
        {/* ⚠ THE LIFECYCLE MARK IS LIVE STATE, NOT A TITLE — whether this
            agent's process is warm, relaunching or mid-turn is the reason to
            keep this panel open at all, and it used to sit inside the h3, which
            a pinned window hides along with the duplicated heading. Outside it,
            visible in both modes. */}
        <div className="dim modalpin-subtitle">
          {node.state === 'live' && <ProcessLifecycleMark warm={Boolean(node.proc_warm)}
            live={node.proc_live} relaunch={node.proc_relaunch}
            reason={node.proc_relaunch_reason} busy={node.busy} tier={node.tier} />}
          {tierLabel(node.tier ?? '')} · configuration</div>
        {/* FULL identity rename (user ruling 2026-08-05): id, mailbox,
            working folder and session all move; history keeps the old name
            (the warning rides the toast). Refused while mid-turn. */}
        {!node.isBearerOf && (
          <div className="row">
            <input style={{ width: '14em' }} placeholder="rename…"
              value={val('rename', node.id)}
              onChange={(e) => set('rename', node.id)(e.target.value)} />
            {val('rename', node.id) !== node.id && (
              <button onClick={() =>
                op({ op: 'rename', node: node.id,
                     name: String(val('rename', node.id)) })
                  .then((r) => {
                    toast([`renamed ${node.id} → ${String(r?.node ?? '')}`,
                           ...((r?.warnings as string[] | undefined) ?? [])])
                    close()
                  })
                  .catch((e: Error) => toast([`error: ${e.message}`]))}>
                rename</button>
            )}
          </div>
        )}

        <div className="row">
          {/* retire asks too (user bug 2026-08-09) — it sat as the one
              seat-freeing action firing straight off the click, beside a
              dissolve button that asks */}
          {node.state === 'live' && !node.children.some((c) => c.state !== 'archived') &&
            <button className="danger" onClick={() => setAsking('retire')}>
              retire · {fmtCredits(node.seat! + node.grant!)}</button>}
          {node.state === 'live' && node.children.some((c) => c.state !== 'archived') &&
            <button className="danger" onClick={() => setAsking('dissolve')}>
              dissolve subtree · {fmtCredits(node.seat! + node.grant!)}</button>}
          {node.state === 'archived' &&
            <button className="primary" onClick={() =>
              op({ op: 'rehire', node: node.id }).then(close).catch(() => {})}>
              rehire (context intact)</button>}
          {/* FR-22: rescind — retire whose freed stake is CLAWED BACK from the
              superior's grant (user-only; agents have no verb). Only where a
              superior exists to claw from: top-level rescind degrades to a
              plain retire and earns no separate button. */}
          {node.state === 'live' && node.parent && node.parent !== USER &&
            <button className="danger" onClick={() => setAsking('rescind')}>
              rescind</button>}
          <span style={{ flex: 1 }} />
          <button className="danger delete"
            onClick={() => setAsking('delete')}><DeleteIcon fontSize="inherit" /> delete permanently</button>
        </div>

        <div className="row">
          <button className="danger" disabled={removingQuotes}
            onClick={() => setAsking('reply-quotes')}>Remove retained reply quotes</button>
        </div>

        {/* Cache disclosure (user request 2026-09-04). ONE note for the
            common case plus a per-field line only where the blast radius
            DIFFERS — a wider scope, a different mechanism, or no cost at
            all. Eight identical subtitles would train the reader to skip
            them, and the org-wide ones are the expensive ones to miss. */}
        <div className="dim hub-hint">Changing a setting here restarts this
          agent's process and re-sends its prompt: it pays one cold turn.
          Fields whose reach is wider — or free — say so themselves.</div>
        <div className="field-label">folder access</div>
        <div className="dirlist">
          {dirs.map((d, i) => (
            <div className="dirrow" key={d.path}>
              <span className="chip mono grow">{d.path}</span>
              <button type="button" className={'modebtn ' + d.mode}
                title="toggle read/write vs read-only"
                onClick={() => setDirs(dirs.map((x, j) =>
                  j === i ? { ...x, mode: x.mode === 'rw' ? 'ro' : 'rw' } : x))}>
                {d.mode === 'rw' ? 'RW' : 'RO'}
              </button>
              <button type="button" className="iconbtn" title="revoke"
                onClick={() => setDirs(dirs.filter((_, j) => j !== i))}><CloseIcon fontSize="inherit" /></button>
            </div>
          ))}
          {addable.length > 0 && (
            <div className="dirrow">
              <select value="" onChange={(e) => {
                const pd = addable.find((x) => x.path === e.target.value)
                if (pd) setDirs([...dirs, { ...pd }])
              }}>
                <option value="" disabled>+ grant a folder the {parent && parent !== USER ? 'parent holds' : 'org holds'}…</option>
                {addable.map((pd) => <option key={pd.path} value={pd.path}>{pd.path} ({pd.mode})</option>)}
              </select>
            </div>
          )}
          {/* ⚠ this used to be gated on (!parent || parent === USER) — a free
              path could only be typed for a TOP-LEVEL node, because a deeper
              grant had to fit the parent. D-106 removed that constraint from
              the ledger (the chain is raised instead of the grant refused),
              and the user asked for new DIRECTORIES specifically, so the
              control has to be able to express it at any depth. Owner only:
              a kiosk visitor's grants clamp to the ceiling's folder list and
              their payload carries basenames, not host paths. */}
          {!tree.public && (
            <div className="dirrow">
              <input placeholder={parent && parent !== USER
                ? 'or any absolute path — superiors are raised to carry it'
                : 'or any absolute path (top-level: you grant freely)'}
                value={newPath} onChange={(e) => setNewPath(e.target.value)} />
              <button type="button" className="iconbtn" title="browse for a folder"
                onClick={() => pickFolder().then((r) => {
                  if (r.path) setDirs([...dirs, { path: r.path, mode: 'rw' }])
                }).catch(() => {})}><FolderIcon fontSize="inherit" /></button>
              <button type="button" className="addrow" onClick={() => {
                if (newPath.trim()) { setDirs([...dirs, { path: newPath.trim(), mode: 'rw' }]); setNewPath('') }
              }}>add</button>
            </div>
          )}
        </div>

        <div className="field-label">tools</div>
        {TOOL_LABELS.map(([k, label]) => (
          <label className="checkline" key={k}>
            <input type="checkbox" checked={tools[k] && parentHolds(k)}
              disabled={!parentHolds(k)}
              onChange={(e) => setTools({ ...tools, [k]: e.target.checked })} />
            {label}
            {!parentHolds(k) && <span className="dim"> — parent doesn't hold it</span>}
          </label>
        ))}

        <div className="field-label">MCP servers (from your global registry)</div>
        <div className="dim hub-hint">Restarts this agent's process.
          Editing the global registry itself (outside orgtree) restarts every
          agent granted "*", in every org on this machine.</div>
        {servers.length === 0 && <div className="hint">none registered</div>}
        {!!tree.sandboxed && !sandboxMcp && servers.length > 0 && (
          <div className="hint">
            sandboxed org — MCP servers are external contact points the sandbox
            restricts, so none reach its agents (the ORGTREE_SANDBOX_MCP env
            var enables URL/portable servers experimentally)
          </div>
        )}
        {servers.map((s) => {
          const dead = !!tree.sandboxed && !sandboxMcp
          return (
            <label className={'checkline' + (dead ? ' dead' : '')} key={s}
              title={dead ? 'unavailable in a sandboxed org' : undefined}>
              <input type="checkbox"
                checked={(holdsAllMcp || tools.mcp.includes(s)) && parentHoldsMcp(s)}
                disabled={!parentHoldsMcp(s) || dead}
                onChange={(e) => setTools({
                  ...tools,
                  // unchecking under "*" materializes the concrete server list
                  mcp: e.target.checked
                    ? (holdsAllMcp ? tools.mcp : [...tools.mcp, s])
                    : (holdsAllMcp ? servers.filter((x) => x !== s)
                                   : tools.mcp.filter((x) => x !== s)),
                })} />
              <span className="mono">{s}</span>
              {!parentHoldsMcp(s) && <span className="dim"> — parent doesn't hold it</span>}
            </label>
          )
        })}

        <div className="field-label">model (switchable on the fly — context
          survives; cheaper frees the seat difference to the agent, pricier
          bubbles any shortfall up the chain)</div>
        <div className="dim hub-hint">Restarts this agent's process. A
          switch to a different provider also starts a new cache namespace,
          so nothing cached carries over.</div>
        {/* D-202: a family this machine does not have is not listed at all —
            not as a disabled row, not as an empty group. `shownTiers` keeps
            this node's OWN tier whatever happens to its provider, so the
            select can never lose its own value and silently switch the model
            on save (and so the panel never lies about what this agent is). */}
        <select className="model-switch" aria-label="model tier"
          value={model} onChange={(e) => setModel(e.target.value)}>
          {([['Claude', TIERS], ['Codex', CODEX_TIERS],
             ['Antigravity', ANTIGRAVITY_TIERS],
             // the OpenRouter favorites, from the registry the payload fills
             // (preserving this node's own tier if it was since deselected — w76fba70b)
             ['OpenRouter', openrouterTierIds(node.tier)]] as const)
            .map(([label, fam]) => [label, shownTiers(fam)] as const)
            .filter(([, fam]) => fam.length > 0)
            .map(([label, fam]) => (
              <optgroup key={label} label={label}>
                {fam.map(modelOption)}
              </optgroup>
            ))}
        </select>

        <div className="field-label">org-structure visibility</div>
        <div className="dim hub-hint">Moving to or from "self" restarts this
          agent. Between team, subtree and full it costs nothing — the roster
          arrives each turn, not in the cached prompt.</div>
        <select value={vis} onChange={(e) => setVis(e.target.value)}>
          {VIS_OPTIONS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
        </select>

        {versions.length > 1 && (
          <>
            <div className="field-label">model version — {model} runs the
              latest unless you pin one here</div>
            <select value={versions.includes(modelVersion) ? modelVersion : ''}
              onChange={(e) => setModelVersion(e.target.value)}>
              <option value="">{`latest (${versions[0]})`}</option>
              {versions.map((v) => (
                <option key={v} value={v}>{`${model} ${v}`}</option>
              ))}
            </select>
          </>
        )}

        {model === 'luna' && (
          <PreferReserveRow checked={preferReserve} onChange={setPreferReserve}
            onUseAppDefault={scope.prefer_reserve !== undefined
              ? useAppDefault : undefined} />
        )}

        <div className="field-label">thinking effort (user-approved: a deep
          setting, never a hire-row control)</div>
        <select value={effort} onChange={(e) => setEffort(e.target.value)}>
          <option value="">{`inherit — org default (${tree.default_effort || tree.effort_default || 'high'})`}</option>
          <option value="low">low</option>
          <option value="medium">medium</option>
          <option value="high">high</option>
          <option value="xhigh">xhigh</option>
          <option value="max">max</option>
        </select>

        {/* user ruling 2026-08-07: writing the machine's GLOBAL skills is
            gated above every allow-rule and hook — only bypassPermissions
            clears it, so the mode had to become settable per node. It was
            reachable by API alone before this; agents still cannot set it
            (orgtree_retool does not expose it), so raising one is the
            user's act. */}
        <div className="field-label">permission mode — bypassPermissions is
          the ONLY mode that can write ~/.claude/skills, and it removes this
          agent&apos;s prompts for everything else too</div>
        <select value={pm} onChange={(e) => setPm(e.target.value)}>
          <option value="plan">plan — read-only planning seat</option>
          <option value="default">default — asks (headless: auto-denies)</option>
          <option value="acceptEdits">acceptEdits — the normal seat</option>
          <option value="bypassPermissions">bypassPermissions ⚠ unguarded</option>
        </select>

        <div className="field-label">cache-protective cheap compaction</div>
        <div className="dim hub-hint">Expiry is fixed by lane: Claude uses
          60 min after a positive subscription receipt or 5 min after a
          positive API-key receipt; OpenAI subscription uses the documented
          30 min default as a fixed estimate. Known identity changes are cold
          immediately; unknown forecasts never auto-compact.</div>
        <select value={accMode} onChange={(e) => setAccMode(e.target.value)}>
          <option value="">inherit the org setting</option>
          <option value="on">on for this agent</option>
          <option value="off">off for this agent</option>
        </select>
        {accMode === 'on' && <div className="row">
          <label>context ≥ <input type="number" min="5" max="95" step="5"
            style={{ width: '5em' }} value={accOcc}
            onChange={(e) => setAccOcc(e.target.value)} />%</label>
        </div>}

        <div className="field-label">charter</div>
        <div className="dim hub-hint">Restarts this agent's process and re-sends its prompt.</div>
        <textarea rows={10} className="charterbox" value={charter}
          onChange={(e) => setCharter(e.target.value)} />
        <div className="field-label">team charter</div>
        <div className="dim hub-hint">Restarts this agent AND every agent in
          its subtree — the cascade puts this text into each of their
          prompts, so every one of them re-sends.</div>
        <textarea rows={10} className="charterbox" value={teamCharter}
          onChange={(e) => setTeamCharter(e.target.value)} />
        {initInfo && (
          <>
            <div className="field-label">this turn, as the CLI resolved it (№14)</div>
            <div className="initblock dim">
              <div>model {initInfo.model ?? '?'} · {initInfo.permissionMode ?? '?'}
                {' · '}{initInfo.tools ?? '?'} tools</div>
              {(initInfo.mcp_servers ?? []).map((s) => (
                <div key={s.name}>
                  <span className={'mcpdot ' + (s.status === 'connected'
                    ? 'ok' : 'bad')} /> {s.name} · {s.status}
                </div>))}
            </div>
          </>
        )}
        {/* multi-account (D5): placement — visible whenever the registry
            has rows; the picker filters to the SELECTED model's provider
            (the binding validator's rule shown, not just enforced) */}
        {acctRows.length > 0 && (
          <>
            <div className="field-label">account
              {node.account?.startsWith('missing:') &&
                <span className="ask-warn"> — PARKED: {node.account}</span>}
            </div>
            <select aria-label="Account" value={acct}
              onChange={(e) => setAcct(e.target.value)}>
              <option value="">
                {node.account ? '(keep current)' : '(unbound — machine default)'}
              </option>
              {acctRows
                .filter((r) => r.provider === providerOf(model))
                .map((r) => <option key={r.id} value={r.id}>
                  {r.id} · {r.label}
                  {r.standing.state === 'limited' ? ' (limited — will wait)' : ''}
                </option>)}
            </select>
          </>
        )}
        {/* D-106: the cascade preview, BEFORE the save (user ruling) — the
            grant is legal either way, so this warns, never blocks */}
        {/* D-234: the queue is visible where the switch is made, with its one
            control — cancel — which is the same op asked with the current
            tier (the ledger's cancel door). An unchanged save does NOT cancel:
            saving scope must never silently withdraw a switch. */}
        {node.pending_switch && (
          <div className="cascade-warn queued-warn">
            ⏳ a switch to <b>{node.pending_switch.tier}</b> is QUEUED — it applies
            when the current turn ends; interrupting the turn applies it now.{' '}
            <button className="badge queued"
              onClick={() => op({ op: 'switch_model', node: node.id,
                tier: node.tier ?? '' })
                .then((r) => toast(r.warnings ?? [])).catch(() => {})}>
              cancel queued switch</button>
          </div>
        )}
        {cascade.length > 0 && (
          <div className="cascade-warn" title={cascade.map((c) =>
            `${c.id} gains ${c.gains.join(', ')}`).join('\n')}>
            ⚠ this also raises {cascade.length === 1 ? 'the agent' : 'the agents'}
            {' '}between you and {node.id}:{' '}
            <b>{cascade.map((c) => c.id).join(', ')}</b>
            {' — hover for exactly what each one gains. Each also restarts.'}
          </div>
        )}
        <div className="row">
          <button className="primary" onClick={() =>
            // D-196 (user ruling 2026-08-29, "ask me to confirm first"): a
            // switch that CROSSES PROVIDERS asks before it does anything. The
            // whole save is gated, not just the switch_model call — cancelling
            // must leave the agent exactly as it was, and a half-applied save
            // (scope written, model refused) would be worse than no dialog.
            // A within-provider switch stays a plain one-click save.
            (asksFirst ? setAsking('crossprovider') : doSave())}>save</button>
          <button onClick={close}>cancel</button>
        </div>
      {/* every confirmation this panel raises is portaled out of it: nested in
          a pinned panel they would be trapped in its stacking context — see
          ModalOverPins */}
      {asking && <ModalOverPins>
      {asking === 'reply-quotes' && (
        <ConfirmModal title={`Remove retained reply quotes for ${node.id}?`}
          body="Removes this agent's retained reply-source snapshots. Existing references to those snapshots will no longer resolve. Transcripts and sent mail are kept. This cannot be undone."
          confirmLabel="Remove retained reply quotes"
          close={() => setAsking(null)}
          onConfirm={() => {
            setRemovingQuotes(true)
            removeReplyEvents(slug, node.id)
              .then(r => toast([`Removed ${r.removed} retained reply quote${r.removed === 1 ? '' : 's'} for ${node.id}.`]))
              .catch((e: Error) => toast([`error: ${e.message}`]))
              .finally(() => setRemovingQuotes(false))
          }} />
      )}
      {asking === 'crossprovider' && (
        <ConfirmModal
          title={midTurn
            ? `queue ${node.id}'s switch to ${model}?`
            : `move ${node.id} from ${PROVIDER_LABEL[providerOf(node.tier ?? '')]} to ${PROVIDER_LABEL[providerOf(model)]}?`}
          // names what is SPENT and what SURVIVES. Only naming the loss reads
          // as more destructive than it is, and someone would avoid a switch
          // they should make. D-234: a busy node's dialog leads with the
          // QUEUE — nothing changes until this turn ends — and names the
          // escape hatch, because the user's stated way to get an immediate
          // switch is to interrupt first; there is no separate control.
          body={(midTurn
            ? `${node.id} is MID-TURN. A model switch asked for mid-turn is QUEUED, not applied: nothing changes until this turn ends, then ${model} applies from its next turn. To switch it now, interrupt the turn first (⏸ on its desk), then save.${crossProvider ? ' ' : ''}`
            : '')
            + (crossProvider
              ? `${node.id} is running on ${PROVIDER_LABEL[providerOf(node.tier ?? '')]} and ${model} runs on ${PROVIDER_LABEL[providerOf(model)]}. Its conversation CANNOT move between providers, so ${midTurn ? 'when the switch applies it' : 'it'} will be reset from its next turn and it will not remember this conversation. The conversation is not lost: its current self is archived in place as the knowledge bearer ${node.id}@${node.generation ?? 0} — readable from the lineage panel, and rehireable there on ${PROVIDER_LABEL[providerOf(node.tier ?? '')]} to consult it. Its scratch files, breadcrumbs.md and mail all survive, and it is told to read them to pick up where it left off.`
              : '')}
          confirmLabel={midTurn
            ? `queue the switch to ${model}`
            : `switch to ${model} and reset the conversation`}
          onConfirm={doSave}
          close={() => setAsking(null)} />
      )}
      {asking === 'retire' && (
        <ConfirmModal title={`retire ${node.id}?`}
          body={`It stops working and frees ${fmtCredits((node.seat ?? 0) + (node.grant ?? 0))} credit(s) back to its superior. Its context is KEPT — rehire brings it back exactly as it was.`}
          confirmLabel="retire"
          onConfirm={() => op({ op: 'retire', node: node.id })
            .then(close).catch(() => {})}
          close={() => setAsking(null)} />
      )}
      {asking === 'dissolve' && (
        <ConfirmModal title={`dissolve ${node.id}?`}
          body="Its entire suborganization is retired with it. Context is kept; rehire brings nodes back."
          confirmLabel="dissolve"
          onConfirm={() => op({ op: 'dissolve', node: node.id }).then(close).catch(() => {})}
          close={() => setAsking(null)} />
      )}
      {asking === 'rescind' && (
        <ConfirmModal title={`rescind ${node.id}?`}
          body={`Retired (subtree included), AND its superior's grant shrinks by the ${fmtCredits((node.seat ?? 0) + (node.grant ?? 0))}-credit stake — the freed headroom does not return. Rehiring this seat later needs new capacity granted from above. Context is kept.`}
          confirmLabel="rescind"
          onConfirm={() => op({ op: 'rescind', node: node.id })
            .then(close).catch(() => {})}
          close={() => setAsking(null)} />
      )}
      {asking === 'delete' && (() => {
        const count = (function c(n: CanvasNode): number {
          return n.children.reduce((a, k) => a + 1 + c(k), 0)
        })(node)
        const gens = (node.lineage ?? []).length
        return <ConfirmModal title={`permanently delete ${node.id}?`}
          body={'Erased from the organization — seats, records, mail and lineage'
            + (count ? `, plus ${count} descendant(s)` : '')
            + (gens ? ` and ${gens} prior generation(s)` : '')
            + '. Session transcripts remain on disk. This cannot be undone.'}
          confirmLabel="delete permanently"
          onConfirm={() => op({ op: 'delete', node: node.id }).then(close).catch(() => {})}
          close={() => setAsking(null)} />
      })()}
      </ModalOverPins>}
    </PinFrame>
  )
}
// the RETIRED-PILE menu (user spec): pick which retiree sits in front — the
// front card is the one you zoom in on, message, read and can rehire; the
// rest wait stacked beneath it. The current front is highlighted.
interface PilePickerProps {
  pile: Pile
  map: Map<string, CanvasNode>
  onPick: (nid: string) => void
  close: () => void
  /** optional: the delete-all row only renders when an op channel exists */
  op?: OpFn
  toast?: ToastFn
}

export function PilePicker({ pile, map, onPick, close, op, toast }: PilePickerProps) {
  useEsc(close)
  const crowd = pile.kind === 'c'
  const [asking, setAsking] = useState(false)
  // "delete all" (user spec 2026-07-31): clear the whole retired pile at
  // once — permanent, so it sits behind the same confirm as any delete.
  // Sequential ops; each failure is already toasted by op(), the summary
  // counts what actually went through.
  const wipeAll = async () => {
    let ok = 0
    for (const id of pile.list) {
      try {
        await op!({ op: 'delete', node: id })   // reachable only via the op-gated row
        ok++
      } catch { /* op() toasted it */ }
    }
    toast?.([`${ok} of ${pile.list.length} archived agent(s) permanently deleted`])
    close()
  }
  return (
    <div className="overlay" onClick={close} onPointerDown={(e) => e.stopPropagation()}>
      <div className="settings content-height pile-picker" onClick={(e) => e.stopPropagation()}>
        <h3><LayersIcon fontSize="inherit" /> {crowd ? 'team stack' : 'retired pile'}
          <span className="dim"> · {pile.list.length} agents</span></h3>
        <div className="hint">
          {crowd
            ? 'A wide team stacks its leaf agents into one place. The one in '
              + 'front is the one you zoom in on and message; the rest keep '
              + 'working beneath. Pick one to bring it forward.'
            : 'The retiree in front is the one you zoom in on, read, message '
              + 'and can rehire; the rest wait beneath. Pick one to bring it '
              + 'forward.'}
        </div>
        {/* rows run MOST RECENTLY TOUCHED FIRST (user request 2026-08-27) —
            `pileOrder`, which also carries why "touched" means the last turn
            rather than the retire time. The pile's own stack order is
            untouched: this is the list, not the deck. */}
        {pileOrder(pile.list, map).map((id) => {
          const n = map.get(id)
          if (!n) return null
          // the same TurnStat the card badge reads. Absent when the agent
          // never took a turn, and then the row says nothing at all rather
          // than "never" — FR-23's rule, kept so the two surfaces match.
          const lastTurn = n.turns?.[n.turns.length - 1]
          return (
            <button key={id} className={'pile-row' + (id === pile.front ? ' on' : '')}
              onClick={() => onPick(id)}>
              <span className={'tier t-' + n.tier}>{TIER_LETTER[n.tier!] ?? '?'}</span>
              <span className="pile-name">{id}</span>
              {n.bearer_state && <span className="badge dim">{n.bearer_state}</span>}
              {n.busy && <span className="badge">{stateLabel('active')}</span>}
              {n.state === 'unrecoverable' && <span className="badge dim">unrecoverable</span>}
              {(n.mail_pending ?? 0) > 0 &&
                <span className={'badge free prov-' + providerOf(n.tier ?? '')}>
                  {n.mail_pending} mail</span>}
              {id === pile.front && <span className="badge free">in front</span>}
              {lastTurn && (
                <span className="badge dim pile-ago"
                  title={'last turn ended '
                    + fmtStamp(lastTurn.at)
                    + (lastTurn.killed ? ' (killed)' : '')}>
                  {ago(lastTurn.at)} ago</span>
              )}
            </button>
          )
        })}
        {!crowd && op && (
          <div className="row">
            <span className="spacer" />
            <button className="danger" onClick={() => setAsking(true)}>
              <DeleteIcon fontSize="inherit" /> delete all {pile.list.length}
            </button>
          </div>
        )}
        {asking && (
          <ConfirmModal
            title={`permanently delete all ${pile.list.length} archived agents?`}
            body="Every agent in this pile is removed for good, along with each one's knowledge-bearer lineage — no rehire, no consulting, records erased from the org. Transcript files on disk are kept. This cannot be undone."
            confirmLabel="delete all"
            onConfirm={wipeAll}
            close={() => setAsking(false)} />
        )}
      </div>
    </div>
  )
}
