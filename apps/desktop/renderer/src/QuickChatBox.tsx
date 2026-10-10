// QuickChatBox.tsx — the header's Quick chat box (docket
// `quick-prompt-hire-kick-off-and-focus-an-agent-fr`): type a message, press
// Enter, and a new agent is hired under the chosen superior with the chosen
// model and effort, started on that message, and focused. The rules (what the
// buttons default to, the name, no charter) live in quickchat.ts.

import { useEffect, useMemo, useState, type MouseEvent } from 'react'
import { useAppRead } from './appfeed'
import { getProviders } from './api'
import { useContextMenu, type MenuEntry } from './canvas/contextmenu'
import { EFFORT_LEVELS, resolveOrgDefault } from './canvas/effort'
import { hireOf, hireTierChoices, tierLabel } from './canvas/shared'
import { flatNodes } from './shell/treeinfo'
import {
  onQuickChatMemory, quickChatEffort, quickChatHire, quickChatName, quickChatSuperior,
  quickChatTier, readQuickChat, rememberEffort, rememberSuperior, rememberTier,
  type QuickSuperior,
} from './quickchat'
import type { OpRequest, OpResult, ToastFn, TreePayload } from './types'

// the no-superior choice (user 2026-10-10: "top level", not "switchboard")
export const TOP_LEVEL_LABEL = 'top level'

export function QuickChat({ slug, tree, op, toast, onHired, listOrder }: {
  slug: string
  tree: TreePayload
  op: (body: OpRequest, opts?: { quiet?: boolean }) => Promise<OpResult>
  toast: ToastFn
  /** the new agent's name, once the engine has hired it */
  onHired: (id: string) => void
  /** the live agents in the order the Agents List on screen shows them
   *  (OrgCanvas fills it); absent or empty = the tree's own order */
  listOrder?: { current: (() => string[]) | null }
}) {
  const [memo, setMemo] = useState(() => readQuickChat(slug))
  useEffect(() => {
    setMemo(readQuickChat(slug))
    return onQuickChatMemory(() => setMemo(readQuickChat(slug)))
  }, [slug])
  const providers = useAppRead('providers', getProviders)
  const offered = useMemo(() => {
    if (!providers) return []
    const of = (id: string) => hireOf(providers.providers.find(p => p.id === id))
    return hireTierChoices({ claudeHire: of('claude'), codexHire: of('openai'),
      antigravityHire: of('google'), openrouterHire: of('openrouter'), langserverHire: of('langserver') })
      .filter(c => c.offer === 'offer').map(c => c.tier)
  }, [providers])
  const nodes = useMemo(() => flatNodes(tree), [tree])
  const live = useMemo(() => [...nodes.values()]
    .filter(n => n.state === 'live').map(n => n.id), [nodes])
  const tier = quickChatTier(memo.tier, offered)
  const effort = quickChatEffort(memo.effort)
  const superior = quickChatSuperior(memo.superior, id => live.includes(id))
  const orgDefault = resolveOrgDefault(tree.default_effort, tree.effort_default)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const menu = useContextMenu(toast)

  // (no preventDefault here: `open` ignores an event something already took)
  const pick = (e: MouseEvent, entries: MenuEntry[]) =>
    menu.open(e, entries, e.currentTarget as Element)
  const modelMenu = (e: MouseEvent) => pick(e, offered.length
    ? offered.map(t => ({ label: tierLabel(t) + (t === tier ? ' ✓' : ''),
        onSelect: () => rememberTier(t) }))
    : [{ label: 'No models available', disabled: true, onSelect: () => {} }])
  const effortMenu = (e: MouseEvent) => pick(e, [
    { label: `org default${orgDefault ? ` (${orgDefault})` : ''}` + (effort === '' ? ' ✓' : ''),
      onSelect: () => rememberEffort('') },
    ...EFFORT_LEVELS.map(l => ({ label: l + (l === effort ? ' ✓' : ''),
      onSelect: () => rememberEffort(l) })),
  ])
  // the SAME order as the Agents List (user 2026-10-10), read when the menu
  // opens; anything the list did not name keeps the tree's order after it
  const listed = () => {
    const ordered = (listOrder?.current?.() ?? []).filter(id => live.includes(id))
    return [...ordered, ...live.filter(id => !ordered.includes(id))]
  }
  const superiorMenu = (e: MouseEvent) => pick(e, [
    { label: TOP_LEVEL_LABEL + (superior === null ? ' ✓' : ''),
      title: 'no superior: a top-level agent', onSelect: () => rememberSuperior(slug, null) },
    ...(live.length ? ['sep' as const] : []),
    ...listed().map(id => ({ label: id + (id === superior ? ' ✓' : ''),
      onSelect: () => rememberSuperior(slug, id) })),
  ])

  const send = async () => {
    const message = text.trim()
    if (!message || busy) return
    if (!tier) { toast(['Quick chat: no model is available to hire']); return }
    setBusy(true)
    const grant = superior === null ? (tree.default_top_grant ?? 50) : 0
    const taken = new Set(nodes.keys())
    try {
      // a name can still collide with one this window has not seen (a
      // deleted-but-reserved or just-hired agent): try the next suffix
      for (let attempt = 0; ; attempt++) {
        const name = quickChatName(message, n => taken.has(n))
        try {
          const r = await op(quickChatHire({ message, name, tier, effort, superior, grant }),
            { quiet: true })
          const born = typeof r?.node === 'string' && r.node ? r.node : name
          remember(superior)
          setText('')
          onHired(born)
          return
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          if (attempt < 4 && /already exists/.test(msg)) { taken.add(name); continue }
          toast([`Quick chat: hire failed: ${msg}`])
          return
        }
      }
    } finally { setBusy(false) }
  }
  // a Quick chat hire is a manual hire too: its model and superior become the
  // next default (its effort already is, having been read from the memory)
  const remember = (s: QuickSuperior) => { rememberTier(tier); rememberSuperior(slug, s) }

  return (
    <div className="quickchat" data-testid="quickchat">
      <input className="quickchat-input" value={text} disabled={busy}
        placeholder="Quick chat — message a new agent, Enter to hire"
        aria-label="Quick chat message"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault(); void send()
          }
        }} />
      <button type="button" className="quickchat-btn quickchat-model"
        title="model for the new agent" onClick={modelMenu}>
        {tier ? tierLabel(tier) : 'no model'}</button>
      <button type="button" className="quickchat-btn quickchat-effort"
        title="effort for the new agent" onClick={effortMenu}>
        {effort || `default${orgDefault ? ` (${orgDefault})` : ''}`}</button>
      <button type="button" className="quickchat-btn quickchat-superior"
        title="superior of the new agent" onClick={superiorMenu}>
        {superior ?? TOP_LEVEL_LABEL}</button>
      {menu.node}
    </div>
  )
}
