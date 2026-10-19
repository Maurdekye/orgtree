import { focusComposerBackground } from './composerfocus'
// QuickChatBox.tsx — the footer's Quick chat box (docket
// `quick-prompt-hire-kick-off-and-focus-an-agent-fr`): type a message, press
// Enter, and a new agent is hired under the chosen superior with the chosen
// model and effort, started on that message, and focused. The rules (what the
// buttons default to, the name, no charter) live in quickchat.ts.
//
// ONE ROW, ONE BOX (docket `quick-chat-the-superior-selector-looks-and-works`,
// user 2026-10-10): the text field and its controls sit inside one box, one
// row — model (its id icon, plus the new agent's name once something is
// typed), superior, effort bar, attachments (a count badge; the list is a
// pop-over) and send. It lives in the window's footer (user 18:48Z; the
// header's empty stretch stays a drag region), so each picker opens as an
// overlay ABOVE the footer — below the bar if a host ever puts the box in a
// header — and is the SAME component the user knows from
// elsewhere: the superior picker is the Agents List (canvas/agenttray.tsx),
// the model picker is the hire tokens' tier chips (SpawnChips in cards.tsx).

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { PickerPopover as Pop } from './canvas/pickerpopover'
import { useAgentMentions, useOrgMentionCandidates } from './canvas/agentmentions'
import { useAppFeed, useAppRead } from './appfeed'
import { useOrgHireProviders } from './orghire'
import { getProviders, sendMessage, uploadFile } from './api'
import { ActiveAgentsFilter, AgentTray, SwitchboardMark, trayRows, type TrayRow } from './canvas/agenttray'
import { SpawnChips } from './canvas/cards'
import { TierChip, nodeTierOf } from './canvas/identity'
import { resolveOrgDefault } from './canvas/effort'
import { EffortBar } from './canvas/effortbar'
import { staffingOptions, tierEffortLevels, type StaffingOptions } from './canvas/staffingoptions'
import { museHireAccount, museLandingAccount } from './canvas/musehire'
import { agentNavProps } from './canvas/agentnav'
import { MUSE_TIERS, museEffortLevels, useAgyModelsRefresh } from './canvas/shared'
import {
  ALL_TIER_SEAT, hireOf, tierLabel, type CanvasNode,
} from './canvas/shared'
import { AttachIcon, ExpandMoreIcon, SendIcon } from './icons'
import {
  onQuickChatMemory, quickChatEffort, quickChatHire, quickChatName, quickChatSuperior,
  quickChatTier, readQuickChat, rememberEffort, rememberSuperior, rememberTier,
  type QuickSuperior,
} from './quickchat'
import type { OpRequest, OpResult, ToastFn, TreeNode, TreePayload } from './types'
import { quickChatChoices } from './quickchat-availability'

// the no-superior choice (user 2026-10-10: "top level", not "switchboard";
// two words on purpose, so it can never be read as an agent name)
export const TOP_LEVEL_LABEL = 'top level'

/** What the Agents List on screen shows, for the superior picker: the host's
 *  agent map and its rows in the host's order, filtered by `query`
 *  (OrgCanvas fills it: the Attention drawer's order while that view shows,
 *  the canvas tray's otherwise). */
export type AgentListSource = (query: string, activeOnly?: boolean) => { map: Map<string, CanvasNode>; rows: TrayRow[] }

type PopKind = 'superior' | 'model' | 'files' | 'options'

/** THE NARROW BOX (user 2026-10-19 13:33Z): the hire options (model, superior,
 *  effort, attachments) are a row while the box has room for them beside a
 *  usable text field, and ONE dropdown button listing them once it does not.
 *  The rule is a pure function of the box's width and the row's natural width
 *  (`rowNeed`, measured from the controls themselves, never from the space they
 *  were squeezed into, as shell/equalsides.ts does), with hysteresis: it
 *  collapses below `need + QUICK_INPUT_MIN` and returns only `QUICK_HYSTERESIS`
 *  px above that, so a width on the boundary cannot flip it back and forth. */
export const QUICK_INPUT_MIN = 140
export const QUICK_HYSTERESIS = 24
export function quickCompact(compact: boolean, width: number, need: number): boolean {
  // unmeasured (no layout yet, or the row is not on screen to measure): keep the state
  if (!(width > 0) || !(need > 0)) return compact
  return width < need + QUICK_INPUT_MIN + (compact ? QUICK_HYSTERESIS : 0)
}
const ROW_CONTROLS = '.quickchat-model, .quickchat-superior, .effort-bar, .quickchat-attach, .quickchat-send'
/** the row's natural width: each control at its own width (a clipped label at
 *  its full text, up to the button's max-width), plus gaps, border and padding;
 *  0 while the row is collapsed. */
export function rowNeed(root: HTMLElement): number {
  if (!root.querySelector('.quickchat-model')) return 0
  const controls = [...root.querySelectorAll<HTMLElement>(ROW_CONTROLS)]
  const cs = getComputedStyle(root)
  const px = (v: string) => parseFloat(v) || 0
  let need = px(cs.columnGap) * controls.length  // one more gap, for the text field
    + px(cs.paddingLeft) + px(cs.paddingRight) + px(cs.borderLeftWidth) + px(cs.borderRightWidth)
  for (const el of controls) {
    let w = el.getBoundingClientRect().width
    for (const label of el.querySelectorAll<HTMLElement>('.quickchat-label')) w += Math.max(0, label.scrollWidth - label.clientWidth)
    const cap = parseFloat(getComputedStyle(el).maxWidth)
    need += Number.isFinite(cap) ? Math.min(w, cap) : w
  }
  return need
}
/** the canvas hire strip's fade (`.hsof` opacity transition, styles.css) */
const FADE_MS = 150

export function QuickChat({ slug, tree, op, toast, onHired, agentList, label = 'Quick chat',
  quickChatActiveAgentsOnly = false, onQuickChatActiveAgentsOnly }: {
  slug: string
  tree: TreePayload
  op: (body: OpRequest, opts?: { quiet?: boolean }) => Promise<OpResult>
  toast: ToastFn
  /** the new agent's name, once the engine has hired it */
  onHired: (id: string) => void
  /** the Agents List on screen; absent = the tree's own order */
  agentList?: { current: AgentListSource | null }
  quickChatActiveAgentsOnly?: boolean
  onQuickChatActiveAgentsOnly?: (value: boolean) => void
  /** what the box calls itself: "New chat" in the Attention view, where it is
   *  the only way to start one (user 2026-10-10 19:25Z), else "Quick chat" */
  label?: string
}) {
  // the org's template defaults arrive with the tree: re-read when they change
  const defaultsKey = JSON.stringify(tree.quick_chat ?? null)
  const [tick, setTick] = useState(0)
  useEffect(() => onQuickChatMemory(() => setTick(t => t + 1)), [])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const memo = useMemo(() => readQuickChat(slug, JSON.parse(defaultsKey)), [slug, defaultsKey, tick])
  const providers = useAppRead('providers', getProviders)
  const orgHireProviders = useOrgHireProviders(slug)
  const { version: feedVersion } = useAppFeed()
  const hires = useMemo(() => {
    const of = (id: string) => hireOf(providers?.providers.find(p => p.id === id),
      providers?.checking === false && ['claude', 'openai', 'google'].includes(id), orgHireProviders?.has(id))
    return { claudeHire: of('claude'), codexHire: of('openai'), antigravityHire: of('google'),
      openrouterHire: of('openrouter'), langserverHire: of('langserver'), museHire: of('muse') }
  }, [providers, orgHireProviders])
  const nodes = useMemo(() => treeNodes(tree), [tree])
  const live = useMemo(() => [...nodes.values()]
    .filter(n => n.state === 'live').map(n => n.id), [nodes])
  const superior = quickChatSuperior(memo.superior, id => live.includes(id))
  const [availability, setAvailability] = useState<{ slug: string; value: StaffingOptions } | null>(null)
  useEffect(() => {
    let current = true
    // Shared single-flight read: the same warm answer used by the hire picker, never provider presence alone.
    void staffingOptions(slug).then(value => { if (current) setAvailability({ slug, value }) }).catch(() => {})
    return () => { current = false }
  }, [slug, providers, tree, feedVersion])
  const choices = useMemo(() => quickChatChoices(availability?.slug === slug ? availability.value : null,
    tree, nodes, superior), [availability, slug, tree, nodes, superior])
  const offered = choices.map(choice => choice.row.tier)
  const tier = quickChatTier(memo.tier, offered)
  const chosen = choices.find(choice => choice.row.tier === tier)
  // Model fallback never erases a separate manual effort choice. Unsupported levels inherit at hire.
  const effort = quickChatEffort(memo.effort)
  const orgDefault = resolveOrgDefault(tree.default_effort, tree.effort_default)
  // a Muse hire's levels are its model's row on the login it lands on
  // (`museHireAccount` names one when the default login cannot run it)
  const levelsFor = (t: string | null | undefined) => choices.find(choice => choice.row.tier === t)?.row.accounts
    .find(account => account.value === chosen?.account)?.efforts
    ?? choices.find(choice => choice.row.tier === t)?.row.efforts
    ?? (t && MUSE_TIERS.includes(t)
    ? museEffortLevels(t, null, museHireAccount(slug, t, tree.default_account) ?? museLandingAccount(tree.default_account))
    : tierEffortLevels(slug, t))
  const seats = tree.tiers ?? ALL_TIER_SEAT
  const [text, setText] = useState('')
  const [files, setFiles] = useState<File[]>([])
  const [busy, setBusy] = useState(false)
  // `via`: the picker was opened from the hire-options dropdown, which stays open beside it
  const [pop, setPop] = useState<{ kind: PopKind; anchor: HTMLElement; via?: boolean } | null>(null)
  const group = useId()
  const rootRef = useRef<HTMLDivElement | null>(null)
  const needRef = useRef(0)
  const [compact, setCompact] = useState(false)
  const fit = useCallback(() => {
    const root = rootRef.current
    if (!root) return
    const need = rowNeed(root)
    if (need > 0) needRef.current = need
    const width = root.getBoundingClientRect().width
    setCompact(c => quickCompact(c, width, needRef.current))
  }, [])
  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root || typeof ResizeObserver === 'undefined') return
    const sizes = new ResizeObserver(fit)
    sizes.observe(root)
    return () => sizes.disconnect()
  }, [fit])
  // also after every render: the row's own width follows the model, the superior's name and the typed name
  useLayoutEffect(fit)
  // a pop-over anchored in the row (or the dropdown) does not outlive the switch
  useEffect(() => { setPop(null) }, [compact])
  const fileRef = useRef<HTMLInputElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const mentionCandidates = useOrgMentionCandidates(slug, tree)
  const mentions = useAgentMentions({
    value: text,
    onChange: setText,
    inputRef,
    candidates: mentionCandidates,
    disabled: busy,
  })
  const open = (kind: PopKind) => (e: { currentTarget: HTMLElement }) => {
    const anchor = e.currentTarget
    setPop(p => p?.kind === kind ? null : { kind, anchor })
  }
  // the hire options: in the row, or listed in the dropdown (`at` is its button,
  // where their pickers open from)
  const hireOptions = (at: HTMLElement | null) => {
    const go = (kind: PopKind) => (e: { currentTarget: HTMLElement }) =>
      at ? setPop(p => p?.kind === kind && p.via ? { kind: 'options', anchor: at } : { kind, anchor: at, via: true }) : open(kind)(e)
    return {
      model: (
        <button key="model" type="button" className="quickchat-btn quickchat-model"
          title={tier ? `model for the new agent: ${tierLabel(tier)}`
            + (preview ? ` — it will be named ${preview}` : '') : 'no model is available to hire'}
          aria-expanded={pop?.kind === 'model'} onClick={go('model')}>
          {tier ? <TierChip tier={tier} /> : <span className="quickchat-label">no model</span>}
          {preview && <span className="quickchat-label quickchat-name">{preview}</span>}
        </button>
      ),
      superior: (
        <button key="superior" type="button" className={'quickchat-btn quickchat-superior' + (superior === null ? ' quickchat-top-superior' : '')}
          title={`superior of the new agent: ${superior ?? 'none (a top-level agent)'}`}
          {...agentNavProps(superior)}
          aria-expanded={pop?.kind === 'superior'} onClick={go('superior')}>
          {/* the shared chip: a project wears its folder mark, not its sentinel tier */}
          {superior === null ? <SwitchboardMark /> : <TierChip tier={nodeTierOf(supNode)} />}
          <span className="quickchat-label">{superior ?? TOP_LEVEL_LABEL}</span>
        </button>
      ),
      effort: (
        <EffortBar key="effort" compact value={effort} level={effort || orgDefault} levels={levelsFor(tier)}
          title={`effort for the new agent: ${effort || `org default${orgDefault ? ` (${orgDefault})` : ''}`}`
            + ' — click the chosen level again for the org default'}
          onSet={(lvl) => rememberEffort(slug, lvl)} disabled={busy} />
      ),
      attach: (
        <button key="attach" type="button" className="quickchat-btn quickchat-attach"
          title={files.length ? `${files.length} file${files.length > 1 ? 's' : ''} attached` : 'attach files'}
          aria-label="attachments" aria-expanded={pop?.kind === 'files'}
          onClick={(e) => {
            if (files.length) go('files')(e)
            // The native picker is not a nested pop-over: keep the options
            // mounted while it is open, whether the user selects or cancels.
            else fileRef.current?.click()
          }}>
          <AttachIcon fontSize="inherit" />
          {files.length > 0 && <span className="quickchat-count">{files.length}</span>}
        </button>
      ),
    }
  }
  const close = () => setPop(null)
  // a picker opened from the dropdown hands back to it; any other just closes
  const back = () => setPop(p => p?.via ? { kind: 'options', anchor: p.anchor } : null)
  // choosing the model: re-read agy's model list
  useAgyModelsRefresh(pop?.kind === 'model')
  // the model pop-out fades out like the canvas hire strip: a non-interactive
  // copy stays for the length of the fade after the picker itself has closed
  const [ghost, setGhost] = useState<HTMLElement | null>(null)
  const wasModel = useRef<HTMLElement | null>(null)
  useEffect(() => {
    const was = wasModel.current
    wasModel.current = pop?.kind === 'model' ? pop.anchor : null
    if (!was || pop?.kind === 'model') return
    setGhost(was)
    const t = setTimeout(() => setGhost(null), FADE_MS)
    return () => clearTimeout(t)
  }, [pop])

  // the name the agent will get, previewed as the user types — by the same
  // rule `send` uses (a collision with a name this window has not seen still
  // takes the next suffix at send; nothing else can differ)
  const [preview, setPreview] = useState('')
  useEffect(() => {
    const message = text.trim()
    if (!message) { setPreview(''); return }
    const t = setTimeout(() => setPreview(quickChatName(message, n => nodes.has(n))), 120)
    return () => clearTimeout(t)
  }, [text, nodes])

  const addFiles = (list: FileList | File[] | null | undefined) => {
    const add = [...(list ?? [])]
    if (add.length) setFiles(f => [...f, ...add])
  }

  const send = async () => {
    const message = text.trim()
    if (!message || busy) return
    if (!tier) { toast(['Quick chat: no model is available to hire']); return }
    setBusy(true); close()
    const grant = superior === null ? (tree.default_top_grant ?? 50) : 0
    const taken = new Set(nodes.keys())
    // with attachments the hire carries no kickoff: the files upload into the
    // new agent's folder and the message goes as its first mail, the way the
    // desk composer sends files (the agent starts on that mail)
    const carry = files
    try {
      // a name can still collide with one this window has not seen (a
      // deleted-but-reserved or just-hired agent): try the next suffix
      for (let attempt = 0; ; attempt++) {
        const name = quickChatName(message, n => taken.has(n))
        let born: string
        try {
          const { kickoff, kickoff_kind, ...bare } = quickChatHire({ message, name, tier, effort: (() => { const lv = levelsFor(tier); return lv && !lv.includes(effort) ? '' : effort })(), superior, grant })
          const account = chosen?.account ?? museHireAccount(slug, tier, tree.default_account)
          const r = await op({ ...(carry.length ? bare : { ...bare, kickoff, kickoff_kind }), ...(account ? { account } : {}) }, { quiet: true })
          born = typeof r?.node === 'string' && r.node ? r.node : name
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          if (attempt < 4 && /already exists/.test(msg)) { taken.add(name); continue }
          toast([`Quick chat: hire failed: ${msg}`])
          return
        }
        if (carry.length) await sendWithFiles(born, message, carry)
        remember(superior)
        setText(''); setFiles([])
        onHired(born)
        return
      }
    } finally { setBusy(false) }
  }
  const sendWithFiles = async (born: string, message: string, carry: File[]) => {
    const paths: string[] = []
    const failed: string[] = []
    for (const f of carry) {
      try { paths.push((await uploadFile(slug, born, f)).path) }
      catch (e) { failed.push(`${f.name} (${e instanceof Error ? e.message : String(e)})`) }
    }
    if (failed.length) toast([`Quick chat: not attached: ${failed.join(', ')}`])
    try { await sendMessage(slug, born, message, paths) }
    catch (e) { toast([`Quick chat: ${born} was hired but the message failed: ${e instanceof Error ? e.message : String(e)}`]) }
  }
  // a Quick chat hire is a manual hire too: its model and superior become the
  // next default (its effort already is, having been read from the memory)
  const remember = (s: QuickSuperior) => { rememberTier(slug, tier); rememberSuperior(slug, s) }
  const supNode = superior === null ? null : nodes.get(superior)
  const row = hireOptions(null)

  return (
    <div ref={rootRef} className={'quickchat' + (busy ? ' busy' : '')} data-testid="quickchat"
      onClick={focusComposerBackground}
      onDragOver={(e) => { if (e.dataTransfer?.types?.includes('Files')) e.preventDefault() }}
      onDrop={(e) => { if (e.dataTransfer?.files?.length) { e.preventDefault(); addFiles(e.dataTransfer.files) } }}>
      <input ref={inputRef} className="quickchat-input" value={text} disabled={busy}
        placeholder={`${label} — message a new agent, Enter to hire`}
        title={`${label} — message a new agent, Enter to hire`}
        aria-label={`${label} message`}
        onChange={(e) => { setText(e.target.value); mentions.syncCaret() }}
        onSelect={mentions.syncCaret}
        onClick={mentions.syncCaret}
        onKeyUp={mentions.syncCaret}
        onPaste={(e) => { if (e.clipboardData?.files?.length) { e.preventDefault(); addFiles(e.clipboardData.files) } }}
        onKeyDown={(e) => {
          if (mentions.onKeyDown(e)) return
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault(); void send()
          }
        }} />
      {mentions.menu}
      {compact
        ? (
          <button type="button" className="quickchat-btn quickchat-options" aria-label="hire options"
            title={`hire options — model ${tier ? tierLabel(tier) : 'none'}, superior ${superior ?? TOP_LEVEL_LABEL}, `
              + `effort ${effort || 'org default'}${files.length ? `, ${files.length} attached` : ''}`}
            aria-haspopup="dialog" aria-expanded={pop?.kind === 'options'} onClick={open('options')}>
            {tier && <TierChip tier={tier} />}
            <ExpandMoreIcon fontSize="inherit" />
            {files.length > 0 && <span className="quickchat-count">{files.length}</span>}
          </button>
        )
        : <>{row.model}{row.superior}{row.effort}{row.attach}</>}
      <button type="button" className="quickchat-btn quickchat-send" title="hire and send (Enter)"
        aria-label="send" disabled={busy || !text.trim()} onClick={() => void send()}>
        <SendIcon fontSize="inherit" />
      </button>
      <input ref={fileRef} type="file" multiple hidden data-testid="quickchat-files"
        onChange={(e) => { addFiles(e.target.files); e.target.value = '' }} />
      {(pop?.kind === 'options' || pop?.via) && (() => {
        const list = hireOptions(pop.anchor)
        return (
          <Pop anchor={pop.anchor} onClose={close} kind="options" label="hire options" group={group} noEscape={!!pop.via}>
            {([['model', list.model], ['superior', list.superior], ['effort', list.effort], ['files', list.attach]] as const).map(([cap, el]) => (
              <div className="quickchat-opt" key={cap}><span className="quickchat-opt-cap">{cap}</span>{el}</div>
            ))}
          </Pop>
        )
      })()}
      {pop?.kind === 'superior' && (
        <Pop anchor={pop.anchor} onClose={back} kind="superior" beside={pop.via} group={group}>
        <SuperiorPicker nodes={nodes} agentList={agentList} superior={superior}
          activeOnly={quickChatActiveAgentsOnly} onActiveOnly={onQuickChatActiveAgentsOnly}
            compactAt={tree.compact_at}
            onPick={(s) => { rememberSuperior(slug, s); back() }} />
        </Pop>
      )}
      {pop?.kind === 'model' && (
        <Pop anchor={pop.anchor} onClose={back} kind="model" beside={pop.via} group={group}>
          <SpawnChips onSpawn={(t) => { rememberTier(slug, t); back() }} seats={seats}
            soleHire selected={tier} allowedTiers={offered} {...hires} />
        </Pop>
      )}
      {ghost && pop?.kind !== 'model' && (
        <Pop anchor={ghost} onClose={() => {}} kind="model" leaving beside={ghost.classList.contains('quickchat-options')}>
          <SpawnChips onSpawn={() => {}} seats={seats} soleHire selected={tier} allowedTiers={offered} {...hires} />
        </Pop>
      )}
      {pop?.kind === 'files' && (
        <Pop anchor={pop.anchor} onClose={back} kind="files" beside={pop.via} group={group}>
          <ul className="quickchat-files">
            {files.map((f, i) => (
              <li key={i}>
                <span className="quickchat-file" title={f.name}>{f.name}</span>
                <button type="button" className="iconbtn" title={`remove ${f.name}`}
                  onClick={() => setFiles(fs => {
                    const next = fs.filter((_, j) => j !== i)
                    if (!next.length) back()
                    return next
                  })}>✕</button>
              </li>
            ))}
          </ul>
          <button type="button" className="quickchat-add" onClick={() => fileRef.current?.click()}>
            add files…</button>
        </Pop>
      )}
    </div>
  )
}

/** the tree's agents with their parents, for when no Agents List is mounted */
function treeNodes(tree: TreePayload): Map<string, CanvasNode> {
  const map = new Map<string, CanvasNode>()
  const walk = (n: TreeNode, parent: string | null) => {
    map.set(n.id, { ...n, parent } as unknown as CanvasNode)
    n.children.forEach(c => walk(c, n.id))
  }
  ;(tree.roots ?? []).forEach(n => walk(n, null))
  return map
}

/** THE AGENTS LIST as a superior picker: the host's rows in the host's
 *  order, live agents only, under the "top level" root row. The filter box,
 *  arrows and Enter pick; Escape closes. */
function SuperiorPicker({ nodes, agentList, superior, compactAt, onPick, activeOnly, onActiveOnly }: {
  nodes: Map<string, CanvasNode>
  agentList?: { current: AgentListSource | null }
  superior: QuickSuperior
  compactAt?: number
  onPick: (s: QuickSuperior) => void
  activeOnly: boolean
  onActiveOnly?: (value: boolean) => void
}) {
  const [query, setQuery] = useState('')
  const { map, rows } = useMemo(() => {
    const host = agentList?.current?.(query, activeOnly)
    if (host) return host
    return { map: nodes, rows: trayRows(nodes, { query, activeOnly }) }
  }, [agentList, nodes, query, activeOnly])
  // a superior must be live: the archived toggle has nothing to offer here
  const liveMap = useMemo(() => new Map([...map].filter(([, n]) => n.state === 'live')), [map])
  const rootMatches = TOP_LEVEL_LABEL.includes(query.trim().toLowerCase())
  // Like filtered agent ancestors, a nonmatching root stays for context.
  const showRoot = rootMatches || rows.length > 0
  const indentedRows = useMemo(() => rows.map(r => ({ ...r, depth: r.depth + 1 })), [rows])
  const choices: QuickSuperior[] = useMemo(() =>
    [...(rootMatches ? [null] : []), ...rows.filter(r => !r.ghost && r.node.state === 'live').map(r => r.node.id)], [rows, rootMatches])
  const [hi, setHi] = useState<QuickSuperior>(superior)
  const at = choices.indexOf(hi)
  const ref = useRef<HTMLDivElement | null>(null)
  useEffect(() => { ref.current?.querySelector<HTMLInputElement>('.tray-filter')?.focus() }, [])
  useEffect(() => {
    ref.current?.querySelector('.tray-row.sel')
      ?.scrollIntoView?.({ block: 'nearest' })
  }, [hi])
  const pick = (id: string) => { if (liveMap.has(id)) onPick(id) }
  return (
    <div className="quickchat-sup" ref={ref}
      onKeyDown={(e) => {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault()
          const n = choices.length
          if (!n) return
          const next = at < 0
            ? (e.key === 'ArrowDown' ? 0 : n - 1)
            : (at + (e.key === 'ArrowDown' ? 1 : n - 1)) % n
          setHi(choices[next] ?? null)
        } else if (e.key === 'Enter') {
          e.preventDefault()
          if (at < 0) {
            // The current superior can remain as a ghost context row under
            // active-only or text filtering. Never turn a missing choice into
            // index zero; preserve a visible live selection. A root typed as
            // the query is still an explicit user choice on Enter.
            if (typeof hi === 'string' && indentedRows.some(r => r.node.id === hi && r.node.state === 'live'))
              onPick(hi)
            else if (rootMatches && query.trim()) onPick(null)
            return
          }
          onPick(choices[at] ?? null)
        }
      }}>
      <AgentTray map={liveMap} rows={indentedRows} query={query} onQuery={setQuery}
        archived={false} onArchived={() => {}} onPick={pick} compactAt={compactAt}
        rowProps={n => agentNavProps(n.id)}
        selected={hi} filterLabel="filter superiors"
        filterActions={onActiveOnly && <ActiveAgentsFilter checked={activeOnly} onChange={onActiveOnly} />}
        leadingRows={showRoot && (
          <div className={'tray-row quickchat-top' + (!rootMatches ? ' ghost' : '') + (hi === null && rootMatches ? ' sel' : '')}
            style={{ paddingLeft: 8 }}
            aria-current={superior === null || undefined} onClick={() => onPick(null)}>
            <div className="tray-primary">
              <button type="button" className="tray-main" title="no superior: a top-level agent">
                <SwitchboardMark />
                <span className="tray-name">{TOP_LEVEL_LABEL}</span>
              </button>
            </div>
          </div>
        )}
        empty={!showRoot && <div className="quickchat-empty">no live agent matches</div>} />
    </div>
  )
}
