// A new question's card arrives with its notification (user feedback point
// 34, 2026-09-29). The notification showed about 5-10 s before the card.
//
// WHY THE CARD WAS LATE. Both are woken by the same `changed` frame. The
// notification then reads the cheap attention projection
// (/api/desktop/notifications) within about half a second. The card is part of
// the org tree, and the tree is read by a pacer (treepace.ts) that waits
// between reads: at least 1.5 s, and twice the last read's duration, up to 15 s.
// On a busy org a read takes seconds and one is usually in flight, so the ask
// waited for that read, the gap, and a whole read of its own.
//
// WHAT THIS DOES. On the same live bump, it reads the same attention
// projection. For a question it has not seen yet, it reads the asking agent's
// one-node detail (/nodes/{nid}/detail, the tree's own projection of that one
// node) and puts the node's `ask` into the tree on screen: on the node when
// the tree holds it, otherwise into the header's open rows (`tree.asks`),
// which is where the inbox and Attention list an agent outside the selected
// tree (canvas/openasks.ts). The paced full read
// still follows and remains the truth. Until a full read that STARTED after
// the detail arrived lands, `applyPrimedAsks` re-applies the ask, so an older
// read in flight cannot take the card away again.
import { useEffect, useRef } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import { req } from './api'
import { onLiveBump } from './livebus'
import type { AskInfo, TreeNode, TreePayload } from './types'

interface Prime { ask: AskInfo; at: number }
const primes = new Map<string, Map<string, Prime>>()

const live = (a: AskInfo | null | undefined): a is AskInfo =>
  !!a && (a.status === 'open' || a.status === 'pending')

/** The same ask, as far as the card is concerned: same record and revision. */
const sameAsk = (a: AskInfo | null | undefined, b: AskInfo) =>
  !!a && a.id === b.id && a.status === b.status && a.rev === b.rev
  && JSON.stringify(a.revs ?? null) === JSON.stringify(b.revs ?? null)

/** `tree` with node `nid`'s ask put on screen: on the node when the tree
 *  holds it, otherwise among the header's open rows (`tree.asks`), where the
 *  inbox and Attention list an agent outside the selected v3 tree
 *  (canvas/openasks.ts). The same object when nothing changes, so an
 *  unchanged payload keeps React's render bail. */
export function patchNodeAsk<T extends { roots: TreeNode[]; asks?: AskInfo[] }>(
  tree: T, nid: string, ask: AskInfo): T {
  let found = false, changed = false
  const walk = (n: TreeNode): TreeNode => {
    if (n.id === nid) {
      found = true
      if (sameAsk(n.ask, ask)) return n
      changed = true
      return { ...n, ask }
    }
    const kids = n.children ?? []
    const next = kids.map(walk)
    return next.some((c, i) => c !== kids[i]) ? { ...n, children: next } : n
  }
  const roots = tree.roots.map(walk)
  if (found) return changed ? { ...tree, roots } : tree
  const asks = tree.asks ?? []
  const i = asks.findIndex(a => a.id === ask.id)
  if (i >= 0 && sameAsk(asks[i], ask)) return tree
  return { ...tree, asks: i >= 0 ? asks.map((a, j) => j === i ? ask : a) : [...asks, ask] }
}

/** Remember an ask read from a node's detail at `at` (ms). */
export function primeAsk(slug: string, nid: string, ask: AskInfo, at = Date.now()) {
  let m = primes.get(slug)
  if (!m) primes.set(slug, m = new Map())
  m.set(nid, { ask, at })
}

/** A full tree read that started at `readStartedAt` (ms). Primes that are
 *  older than the read are dropped: the read already saw what they saw, and
 *  if the ask is gone now it was answered or withdrawn. Younger primes are
 *  re-applied, because the read may predate the ask. */
export function applyPrimedAsks(slug: string, tree: TreePayload, readStartedAt: number): TreePayload {
  const m = primes.get(slug)
  if (!m?.size) return tree
  let out = tree
  for (const [nid, p] of [...m]) {
    if (p.at <= readStartedAt) { m.delete(nid); continue }
    out = patchNodeAsk(out, nid, p.ask)
  }
  return out
}

/** Test hook. */
export function resetPrimedAsks() { primes.clear() }

interface Notice { kind?: string; org?: string; agent?: string; source_id?: string; id?: string }

/** The ids of the asks the tree on screen already shows as open. */
function openAskIds(tree: TreePayload | null): Set<string> {
  const out = new Set<string>()
  const walk = (n: TreeNode) => {
    if (live(n.ask)) out.add(String(n.ask.id))
    for (const c of n.children ?? []) walk(c)
  }
  for (const r of tree?.roots ?? []) walk(r)
  for (const a of tree?.asks ?? []) if (live(a)) out.add(String(a.id))
  return out
}

interface NoticePage {
  notices?: Notice[]; truncated?: boolean; next_offset?: number | null
}

/** Every row of the attention projection, page by page, the way the
 *  notification reader pages it (notifications.ts readNotices). */
async function readQuestionNotices(slug: string): Promise<Notice[]> {
  const out: Notice[] = []
  let offset = 0
  for (;;) {
    const page = await req<NoticePage>('/api/desktop/notifications' + (offset ? `?offset=${offset}` : ''))
    for (const n of page.notices ?? []) if (n.kind === 'question' && n.org === slug) out.push(n)
    if (!page.truncated || page.next_offset == null || page.next_offset <= offset) return out
    offset = page.next_offset
  }
}

/** Keep `slug`'s tree ahead of the pacer for new questions. `treeRef` must
 *  hold the tree on screen. */
export function useAskPrimer(slug: string | null, treeRef: { current: TreePayload | null },
  setTree: Dispatch<SetStateAction<TreePayload | null>>) {
  const setRef = useRef(setTree); setRef.current = setTree
  useEffect(() => {
    if (!slug) return
    let alive = true, running = false, again = false
    // notice identities already handled, so each question is fetched once
    const seen = new Set<string>()
    const pass = async () => {
      if (running) { again = true; return }
      running = true
      try {
        do {
          again = false
          const notices = await readQuestionNotices(slug)
          if (!alive) return
          const open = openAskIds(treeRef.current)
          // one detail read per asking agent, for the notices not handled yet
          const byAgent = new Map<string, string[]>()
          for (const n of notices) {
            if (!n.agent) continue
            const ident = JSON.stringify([n.id, n.source_id])
            if (seen.has(ident)) continue
            // already on screen (the tree had it first): nothing to fetch
            if (n.source_id != null && open.has(String(n.source_id))) { seen.add(ident); continue }
            byAgent.set(n.agent, [...(byAgent.get(n.agent) ?? []), ident])
          }
          await Promise.all([...byAgent].map(async ([nid, idents]) => {
            try {
              const node = await req<TreeNode>(
                `/api/orgs/${slug}/nodes/${encodeURIComponent(nid)}/detail`)
              if (!alive) return
              // handled only once the read succeeded: a failed read is
              // retried on the next live update
              for (const i of idents) seen.add(i)
              if (!live(node?.ask)) return
              primeAsk(slug, nid, node.ask)
              setRef.current(t => t ? patchNodeAsk(t, nid, node.ask!) : t)
            } catch { /* not marked handled: the next live update retries */ }
          }))
        } while (alive && again)
      } catch { /* the paced tree read still brings the card */ }
      finally { running = false }
    }
    const off = onLiveBump(() => { void pass() })
    return () => { alive = false; off() }
  }, [slug, treeRef])
}
