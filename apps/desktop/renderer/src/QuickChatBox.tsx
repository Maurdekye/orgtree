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

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useAppRead } from './appfeed'
import { getProviders, sendMessage, uploadFile } from './api'
import { AgentTray, trayRows, type TrayRow } from './canvas/agenttray'
import { SpawnChips } from './canvas/cards'
import { resolveOrgDefault } from './canvas/effort'
import { EffortBar } from './canvas/effortbar'
import { tierEffortLevels } from './canvas/staffingoptions'
import {
  ALL_TIER_SEAT, hireOf, hireTierChoices, TIER_LETTER, tierLabel, type CanvasNode,
} from './canvas/shared'
import { AttachIcon, SendIcon } from './icons'
import {
  onQuickChatMemory, quickChatEffort, quickChatHire, quickChatName, quickChatSuperior,
  quickChatTier, readQuickChat, rememberEffort, rememberSuperior, rememberTier,
  type QuickSuperior,
} from './quickchat'
import type { OpRequest, OpResult, ToastFn, TreeNode, TreePayload } from './types'

// the no-superior choice (user 2026-10-10: "top level", not "switchboard";
// two words on purpose, so it can never be read as an agent name)
export const TOP_LEVEL_LABEL = 'top level'

/** What the Agents List on screen shows, for the superior picker: the host's
 *  agent map and its rows in the host's order, filtered by `query`
 *  (OrgCanvas fills it: the Attention drawer's order while that view shows,
 *  the canvas tray's otherwise). */
export type AgentListSource = (query: string) => { map: Map<string, CanvasNode>; rows: TrayRow[] }

type PopKind = 'superior' | 'model' | 'files'
/** the canvas hire strip's fade (`.hsof` opacity transition, styles.css) */
const FADE_MS = 150
/** how far the pointer may stray from the model chips (or their button) before they close */
const LEAVE_PX = 70

export function QuickChat({ slug, tree, op, toast, onHired, agentList, label = 'Quick chat' }: {
  slug: string
  tree: TreePayload
  op: (body: OpRequest, opts?: { quiet?: boolean }) => Promise<OpResult>
  toast: ToastFn
  /** the new agent's name, once the engine has hired it */
  onHired: (id: string) => void
  /** the Agents List on screen; absent = the tree's own order */
  agentList?: { current: AgentListSource | null }
  /** what the box calls itself: "New chat" in the Attention view, where it is
   *  the only way to start one (user 2026-10-10 19:25Z), else "Quick chat" */
  label?: string
}) {
  const [memo, setMemo] = useState(() => readQuickChat(slug))
  useEffect(() => {
    setMemo(readQuickChat(slug))
    return onQuickChatMemory(() => setMemo(readQuickChat(slug)))
  }, [slug])
  const providers = useAppRead('providers', getProviders)
  const hires = useMemo(() => {
    const of = (id: string) => hireOf(providers?.providers.find(p => p.id === id))
    return { claudeHire: of('claude'), codexHire: of('openai'), antigravityHire: of('google'),
      openrouterHire: of('openrouter'), langserverHire: of('langserver') }
  }, [providers])
  const offered = useMemo(() => providers
    ? hireTierChoices(hires).filter(c => c.offer === 'offer').map(c => c.tier) : [],
  [providers, hires])
  const nodes = useMemo(() => treeNodes(tree), [tree])
  const live = useMemo(() => [...nodes.values()]
    .filter(n => n.state === 'live').map(n => n.id), [nodes])
  const tier = quickChatTier(memo.tier, offered)
  const effort = quickChatEffort(memo.effort)
  const superior = quickChatSuperior(memo.superior, id => live.includes(id))
  const orgDefault = resolveOrgDefault(tree.default_effort, tree.effort_default)
  const seats = tree.tiers ?? ALL_TIER_SEAT
  const [text, setText] = useState('')
  const [files, setFiles] = useState<File[]>([])
  const [busy, setBusy] = useState(false)
  const [pop, setPop] = useState<{ kind: PopKind; anchor: HTMLElement } | null>(null)
  const fileRef = useRef<HTMLInputElement | null>(null)
  const open = (kind: PopKind) => (e: { currentTarget: HTMLElement }) => {
    const anchor = e.currentTarget
    setPop(p => p?.kind === kind ? null : { kind, anchor })
  }
  const close = () => setPop(null)
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
          const { kickoff, kickoff_kind, ...bare } = quickChatHire({ message, name, tier, effort: (() => { const lv = tierEffortLevels(slug, tier); return lv && !lv.includes(effort) ? '' : effort })(), superior, grant })
          const r = await op(carry.length ? bare : { ...bare, kickoff, kickoff_kind }, { quiet: true })
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
  const remember = (s: QuickSuperior) => { rememberTier(tier); rememberSuperior(slug, s) }
  const supNode = superior === null ? null : nodes.get(superior)

  return (
    <div className={'quickchat' + (busy ? ' busy' : '')} data-testid="quickchat"
      onDragOver={(e) => { if (e.dataTransfer?.types?.includes('Files')) e.preventDefault() }}
      onDrop={(e) => { if (e.dataTransfer?.files?.length) { e.preventDefault(); addFiles(e.dataTransfer.files) } }}>
      <input className="quickchat-input" value={text} disabled={busy}
        placeholder={`${label} — message a new agent, Enter to hire`}
        title={`${label} — message a new agent, Enter to hire`}
        aria-label={`${label} message`}
        onChange={(e) => setText(e.target.value)}
        onPaste={(e) => { if (e.clipboardData?.files?.length) { e.preventDefault(); addFiles(e.clipboardData.files) } }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault(); void send()
          }
        }} />
      <button type="button" className="quickchat-btn quickchat-model"
        title={tier ? `model for the new agent: ${tierLabel(tier)}`
          + (preview ? ` — it will be named ${preview}` : '') : 'no model is available to hire'}
        aria-expanded={pop?.kind === 'model'} onClick={open('model')}>
        {tier ? <TierIcon tier={tier} /> : <span className="quickchat-label">no model</span>}
        {preview && <span className="quickchat-label quickchat-name">{preview}</span>}
      </button>
      <button type="button" className="quickchat-btn quickchat-superior"
        title={`superior of the new agent: ${superior ?? 'none (a top-level agent)'}`}
        aria-expanded={pop?.kind === 'superior'} onClick={open('superior')}>
        {supNode?.tier && <TierIcon tier={supNode.tier} />}
        <span className="quickchat-label">{superior ?? TOP_LEVEL_LABEL}</span>
      </button>
      <EffortBar compact value={effort} level={effort || orgDefault} levels={tierEffortLevels(slug, tier)}
        title={`effort for the new agent: ${effort || `org default${orgDefault ? ` (${orgDefault})` : ''}`}`
          + ' — click the chosen level again for the org default'}
        onSet={rememberEffort} disabled={busy} />
      <button type="button" className="quickchat-btn quickchat-attach"
        title={files.length ? `${files.length} file${files.length > 1 ? 's' : ''} attached` : 'attach files'}
        aria-label="attachments" aria-expanded={pop?.kind === 'files'}
        onClick={(e) => files.length ? open('files')(e) : fileRef.current?.click()}>
        <AttachIcon fontSize="inherit" />
        {files.length > 0 && <span className="quickchat-count">{files.length}</span>}
      </button>
      <button type="button" className="quickchat-btn quickchat-send" title="hire and send (Enter)"
        aria-label="send" disabled={busy || !text.trim()} onClick={() => void send()}>
        <SendIcon fontSize="inherit" />
      </button>
      <input ref={fileRef} type="file" multiple hidden data-testid="quickchat-files"
        onChange={(e) => { addFiles(e.target.files); e.target.value = '' }} />
      {pop?.kind === 'superior' && (
        <Pop anchor={pop.anchor} onClose={close} kind="superior">
          <SuperiorPicker nodes={nodes} agentList={agentList} superior={superior}
            compactAt={tree.compact_at}
            onPick={(s) => { rememberSuperior(slug, s); close() }} />
        </Pop>
      )}
      {pop?.kind === 'model' && (
        <Pop anchor={pop.anchor} onClose={close} kind="model">
          <SpawnChips onSpawn={(t) => { rememberTier(t); close() }} seats={seats}
            soleHire selected={tier} {...hires} />
        </Pop>
      )}
      {ghost && pop?.kind !== 'model' && (
        <Pop anchor={ghost} onClose={() => {}} kind="model" leaving>
          <SpawnChips onSpawn={() => {}} seats={seats} soleHire selected={tier} {...hires} />
        </Pop>
      )}
      {pop?.kind === 'files' && (
        <Pop anchor={pop.anchor} onClose={close} kind="files">
          <ul className="quickchat-files">
            {files.map((f, i) => (
              <li key={i}>
                <span className="quickchat-file" title={f.name}>{f.name}</span>
                <button type="button" className="iconbtn" title={`remove ${f.name}`}
                  onClick={() => setFiles(fs => {
                    const next = fs.filter((_, j) => j !== i)
                    if (!next.length) close()
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

/** a model's id icon: the tier badge cards and Agents List rows wear */
function TierIcon({ tier }: { tier: string }) {
  return <span className={'tier t-' + tier} title={tierLabel(tier)}>{TIER_LETTER[tier] ?? '?'}</span>
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
 *  order, live agents only, with "top level" above them. The filter box,
 *  arrows and Enter pick; Escape closes. */
function SuperiorPicker({ nodes, agentList, superior, compactAt, onPick }: {
  nodes: Map<string, CanvasNode>
  agentList?: { current: AgentListSource | null }
  superior: QuickSuperior
  compactAt?: number
  onPick: (s: QuickSuperior) => void
}) {
  const [query, setQuery] = useState('')
  const { map, rows } = useMemo(() => {
    const host = agentList?.current?.(query)
    if (host) return host
    return { map: nodes, rows: trayRows(nodes, { query }) }
  }, [agentList, nodes, query])
  // a superior must be live: the archived toggle has nothing to offer here
  const liveMap = useMemo(() => new Map([...map].filter(([, n]) => n.state === 'live')), [map])
  const choices: QuickSuperior[] = useMemo(() =>
    [null, ...rows.filter(r => !r.ghost && r.node.state === 'live').map(r => r.node.id)], [rows])
  const [hi, setHi] = useState<QuickSuperior>(superior)
  const at = Math.max(0, choices.indexOf(hi))
  const ref = useRef<HTMLDivElement | null>(null)
  useEffect(() => { ref.current?.querySelector<HTMLInputElement>('.tray-filter')?.focus() }, [])
  useEffect(() => {
    if (!choices.includes(hi)) setHi(choices[1] ?? null)
  }, [choices, hi])
  useEffect(() => {
    ref.current?.querySelector('.tray-row.sel, .quickchat-top.sel')
      ?.scrollIntoView?.({ block: 'nearest' })
  }, [hi])
  const pick = (id: string) => { if (liveMap.has(id)) onPick(id) }
  return (
    <div className="quickchat-sup" ref={ref}
      onKeyDown={(e) => {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault()
          const n = choices.length
          setHi(choices[(at + (e.key === 'ArrowDown' ? 1 : n - 1)) % n] ?? null)
        } else if (e.key === 'Enter') {
          e.preventDefault()
          onPick(choices[at] ?? null)
        }
      }}>
      {/* an option row like the agents' (user 2026-10-10): same row, hover
          and selection, with the user's eye where an agent's chip sits */}
      <div className={'tray-row quickchat-top' + (hi === null ? ' sel' : '')}
        aria-current={superior === null || undefined} onClick={() => onPick(null)}>
        <div className="tray-primary">
          <button type="button" className="tray-main" title="no superior: a top-level agent">
            <span className="tier quickchat-user-mark" aria-hidden="true">
              <svg className="eye" viewBox="0 0 48 26">
                <path d="M 2 13 C 13 2, 35 2, 46 13 C 35 24, 13 24, 2 13 Z" />
                <circle className="iris" cx="24" cy="13" r="6.5" />
                <circle className="pupil" cx="24" cy="13" r="2.6" />
              </svg>
            </span>
            <span className="tray-name">{TOP_LEVEL_LABEL}</span>
          </button>
        </div>
      </div>
      <AgentTray map={liveMap} rows={rows} query={query} onQuery={setQuery}
        archived={false} onArchived={() => {}} onPick={pick} compactAt={compactAt}
        selected={hi} filterLabel="filter superiors"
        empty={<div className="quickchat-empty">no live agent matches</div>} />
    </div>
  )
}

/** an overlay beside the bar holding the box — above a footer, below a
 *  header — in the anchor's own window; outside press or Escape closes it */
function Pop({ anchor, onClose, kind, leaving, children }: {
  anchor: HTMLElement; onClose: () => void; kind: PopKind; leaving?: boolean; children: ReactNode
}) {
  const ref = useRef<HTMLDivElement | null>(null)
  const doc = anchor.ownerDocument
  const r = anchor.getBoundingClientRect()
  // clear of the whole bar, not just the box (the bar is taller): upward
  // from a footer, downward from anything else
  const bar = anchor.closest('footer, header')
  const up = bar?.tagName === 'FOOTER'
  const b = bar?.getBoundingClientRect()
  const vh = doc.documentElement.clientHeight || (doc.defaultView?.innerHeight ?? 0)
  const place = up
    ? { bottom: vh - Math.min(r.top, b?.top ?? r.top) + 4 }
    : { top: Math.max(r.bottom, b?.bottom ?? 0) + 4 }
  // the model chips hang centred under their button, as the hire strip hangs
  // centred under its card; the lists open from the button's left edge
  const centred = kind === 'model'
  const [left, setLeft] = useState(r.left)
  useLayoutEffect(() => {
    const w = ref.current?.offsetWidth ?? 0
    const vw = doc.documentElement.clientWidth || (doc.defaultView?.innerWidth ?? 0)
    const want = centred ? r.left + r.width / 2 - w / 2 : r.left
    if (w && vw) setLeft(Math.max(8, Math.min(want, vw - w - 8)))
  }, [doc, r.left, r.width, centred])
  const closeRef = useRef(onClose); closeRef.current = onClose
  useEffect(() => {
    if (leaving) return
    const down = (e: Event) => {
      const t = e.target as Node
      if (!ref.current?.contains(t) && !anchor.contains(t)) closeRef.current()
    }
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeRef.current() }
    }
    doc.addEventListener('pointerdown', down, true)
    doc.addEventListener('keydown', key, true)
    return () => {
      doc.removeEventListener('pointerdown', down, true)
      doc.removeEventListener('keydown', key, true)
    }
  }, [doc, anchor, leaving])
  // the model chips close themselves once the pointer wanders off (user
  // 2026-10-10), fading out like any close: farther than LEAVE_PX from both
  // the chips and their button. Armed only once the pointer has been inside
  // that zone, so a picker opened from the keyboard waits for the mouse.
  useEffect(() => {
    if (leaving || kind !== 'model') return
    let armed = false
    const near = (x: number, y: number, el: Element | null) => {
      if (!el) return false
      const b = el.getBoundingClientRect()
      return x >= b.left - LEAVE_PX && x <= b.right + LEAVE_PX && y >= b.top - LEAVE_PX && y <= b.bottom + LEAVE_PX
    }
    const move = (e: PointerEvent) => {
      const inside = near(e.clientX, e.clientY, ref.current) || near(e.clientX, e.clientY, anchor)
      if (inside) armed = true
      else if (armed) closeRef.current()
    }
    doc.addEventListener('pointermove', move, true)
    return () => doc.removeEventListener('pointermove', move, true)
  }, [doc, anchor, kind, leaving])
  return createPortal(
    <div ref={ref} className={(leaving ? 'quickchat-leaving' : 'quickchat-pop') + ' quickchat-pop-' + kind
      + (up ? ' up' : '')}
      role={leaving ? undefined : 'dialog'} aria-hidden={leaving || undefined}
      style={{ ...place, left }}>
      {children}
    </div>, doc.body)
}
