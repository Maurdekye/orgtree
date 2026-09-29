/** SENT-MESSAGE HISTORY FOR THE MAIN COMPOSER — the thing Up and Down walk.
 *
 *  KEYED PER AGENT, DELIBERATELY WITHOUT THE GENERATION (user ruling
 *  2026-09-19, decisions 2 and 3 on the item). The draft key next door IS
 *  generation-scoped, and copying that here would erase the history at a
 *  compaction, a rehire or a rename — which is the exact moment this feature
 *  exists to rescue, because that is when a half-written message is most
 *  likely to have been eaten. Per agent means per agent IDENTITY, across
 *  generations.
 *
 *  Entries are held OLDEST FIRST, the way a shell history file is. `delivered`
 *  is false for a message that was composed but never sent — one stranded by
 *  an agent state change. Those are marked rather than silently mixed in
 *  (decision 1): the moment they arise is the moment a user is least sure
 *  whether the message went, and guessing wrong is expensive in both
 *  directions — re-sending something already delivered, or believing something
 *  arrived that never did.
 */

export interface HistoryEntry {
  text: string
  /** false = composed but never sent; stranded by an agent state change. */
  delivered: boolean
}

const historyPrefix = 'orgtree-composer-history-'
export const historyKey = (slug: string, id: string) =>
  `${historyPrefix}${JSON.stringify([slug, id])}`

/** A REAL BOUND, not merely a large one (decision 2). localStorage is a
 *  shared, limited budget: an uncapped history of long messages growing over
 *  months can fill it and break unrelated features, and that failure would
 *  surface far from here and be very hard to trace back. Oldest is evicted
 *  first. The per-entry ceiling is what stops one enormous message consuming
 *  the whole budget on its own. */
export const MAX_ENTRIES = 100
export const MAX_ENTRY_CHARS = 32768
export const MAX_TOTAL_CHARS = 131072

function isEntry(value: unknown): value is HistoryEntry {
  return !!value && typeof value === 'object'
    && typeof (value as HistoryEntry).text === 'string'
    && typeof (value as HistoryEntry).delivered === 'boolean'
}

/** The stored history, oldest first. Never throws: unreadable or corrupt
 *  storage reads as an empty history rather than taking the composer down. */
export function readHistory(slug: string, id: string): HistoryEntry[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(historyKey(slug, id)) || '[]')
    return Array.isArray(raw) ? raw.filter(isEntry) : []
  } catch { return [] }
}

function writeHistory(slug: string, id: string, entries: HistoryEntry[]) {
  try {
    if (entries.length) localStorage.setItem(historyKey(slug, id), JSON.stringify(entries))
    else localStorage.removeItem(historyKey(slug, id))
  } catch { /* Same best-effort browser persistence as the composer draft. */ }
}

/** Trim to the caps, evicting OLDEST first. Applied on every write rather than
 *  on read, so the stored value is the bounded one. */
function trim(entries: HistoryEntry[]): HistoryEntry[] {
  const bounded = entries.slice(-MAX_ENTRIES)
  let total = bounded.reduce((sum, e) => sum + e.text.length, 0)
  while (bounded.length > 1 && total > MAX_TOTAL_CHARS) {
    const oldest = bounded.shift()
    if (!oldest) break
    total -= oldest.text.length
  }
  return bounded
}

/** Add one entry. Returns false when nothing was stored.
 *
 *  A message longer than MAX_ENTRY_CHARS is NOT recorded — it would evict the
 *  whole rest of the history to make room for itself. Storing it truncated
 *  would be worse than not storing it: a truncated recall looks ready to send
 *  and would deliver a mangled message.
 *
 *  Repeating the newest entry REPLACES it rather than growing the history, the
 *  way a shell collapses an immediately repeated command. Replacing rather
 *  than skipping is what lets a stranded entry that is later actually sent
 *  stop being marked as undelivered. */
export function record(slug: string, id: string, text: string, delivered: boolean): boolean {
  if (!text || text.length > MAX_ENTRY_CHARS) return false
  const entries = readHistory(slug, id)
  const newest = entries[entries.length - 1]
  if (newest && newest.text === text) entries[entries.length - 1] = { text, delivered }
  else entries.push({ text, delivered })
  writeHistory(slug, id, trim(entries))
  return true
}

/** A message that was actually sent. */
export const recordSent = (slug: string, id: string, text: string) =>
  record(slug, id, text, true)

/** A message composed but never delivered, stranded by an agent state change. */
export const recordStranded = (slug: string, id: string, text: string) =>
  record(slug, id, text, false)

const activePrefix = 'orgtree-draft-v2-'
const recoveryPrefix = 'orgtree-draft-recovery-'
const dismissedRecoveryPrefix = 'orgtree-draft-recovery-dismissed-'
const legacyDraftKey = (slug: string, id: string) => `orgtree-draft-${slug}-${id}`
const partSuffix = (key: string) => key.endsWith('-attachments') ? '-attachments'
  : key.endsWith('-reply') ? '-reply' : ''

function identityOf(key: string, prefix: string): unknown[] | null {
  try {
    const suffix = partSuffix(key)
    const value = JSON.parse(key.slice(prefix.length, suffix ? -suffix.length : undefined))
    return Array.isArray(value) && value.length === 3 ? value : null
  } catch { return null }
}

function dropDraft(textKey: string) {
  try {
    localStorage.removeItem(textKey)
    localStorage.removeItem(`${textKey}-attachments`)
    localStorage.removeItem(`${textKey}-reply`)
  } catch { /* unavailable storage */ }
}

/** A COMPACTION KEEPS WHAT IS IN THE MESSAGE BOX (user request 2026-09-29,
 *  item v3-keep-unsent-chat-text-in-the-message-box-when: "when an agent
 *  compacts, if there's an unsent message in the box, don't save it as a
 *  draft, just keep it there").
 *
 *  A compaction advances the generation, and the draft key is per generation,
 *  so the new desk opens on an empty key while the typed text sits under the
 *  old one. Before anything is absorbed into history, this MOVES the newest
 *  older generation's text and attachments to the current key, so the box
 *  shows them exactly as they were. Nothing is sent.
 *
 *  Only when the current box is empty: text already typed at the new
 *  generation is never overwritten, and the older draft then goes to history
 *  as before. Only the NEWEST older generation moves; anything older than it
 *  was already stranded before this compaction and stays history's.
 *
 *  The reply target is dropped rather than carried: it names an event of the
 *  old generation, and the server refuses such a reply as stale, so carrying
 *  it would turn the kept message into one that cannot be sent.
 *
 *  Returns whether anything moved. Idempotent: once moved, the current key is
 *  no longer empty. */
export function carryDraftForward(slug: string, id: string, generation: number | undefined): boolean {
  if (typeof generation !== 'number') return false
  try {
    const current = `${activePrefix}${JSON.stringify([slug, id, generation])}`
    if (localStorage.getItem(current) || localStorage.getItem(`${current}-attachments`)) return false
    let newest: { generation: number; textKey: string } | null = null
    const keys = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i))
    for (const key of keys) {
      if (!key?.startsWith(activePrefix)) continue
      const identity = identityOf(key, activePrefix)
      if (!identity || identity[0] !== slug || identity[1] !== id || typeof identity[2] !== 'number') continue
      if (identity[2] >= generation || (newest && identity[2] <= newest.generation)) continue
      const suffix = partSuffix(key)
      const textKey = suffix ? key.slice(0, -suffix.length) : key
      if (!localStorage.getItem(textKey) && !localStorage.getItem(`${textKey}-attachments`)) continue
      newest = { generation: identity[2], textKey }
    }
    if (!newest) return false
    const text = localStorage.getItem(newest.textKey)
    const attachments = localStorage.getItem(`${newest.textKey}-attachments`)
    if (text) localStorage.setItem(current, text)
    if (attachments) localStorage.setItem(`${current}-attachments`, attachments)
    dropDraft(newest.textKey)
    return true
  } catch { return false }
}

/** MIGRATION AND ONGOING RESCUE IN ONE PASS, run when a desk mounts.
 *
 *  Three surfaces used to hold a draft stranded by an identity change, and all
 *  three are retired into history here rather than into a panel:
 *
 *  1. `orgtree-draft-v2-[slug,id,oldGeneration]` — the live draft key of a
 *     generation this agent has moved past. carryDraftForward runs first and
 *     moves the newest one back into the box, so what reaches here is only
 *     what could not go there: an older generation, or one whose successor
 *     already had text of its own.
 *  2. `orgtree-draft-recovery-…` — written by the previous release when a node
 *     left the org. Consumed here so an existing installation's stored drafts
 *     are migrated rather than stranded invisibly.
 *  3. `orgtree-draft-<slug>-<id>` — the oldest, pre-generation key, which used
 *     to surface as an "An older saved draft is available" banner. The ticket
 *     does not name it; it is the same category of thing, and leaving it would
 *     half-finish the retirement (recorded as decision 1 on the item).
 *
 *  Oldest generation lands first, so Up reaches the most recent first. The
 *  matching `-dismissed-` bookkeeping key is dropped: with no panel to dismiss
 *  it has nothing left to mean. Idempotent — each source key is deleted as it
 *  is absorbed, so a remount absorbs nothing twice.
 *
 *  Returns how many entries were absorbed, which is what the tests assert on.
 */
export function absorbStrandedDrafts(slug: string, id: string, generation: number | undefined): number {
  let absorbed = 0
  try {
    const found: { generation: number; textKey: string }[] = []
    const keys = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i))
    for (const key of keys) {
      if (!key) continue
      const prefix = key.startsWith(activePrefix) ? activePrefix
        : key.startsWith(recoveryPrefix) && !key.startsWith(dismissedRecoveryPrefix) ? recoveryPrefix
        : null
      if (!prefix) continue
      const identity = identityOf(key, prefix)
      if (!identity || identity[0] !== slug || identity[1] !== id || typeof identity[2] !== 'number') continue
      // The CURRENT generation's draft is the text sitting in the composer
      // right now. It is not stranded and must never be eaten.
      if (prefix === activePrefix && identity[2] === generation) continue
      // Nor is a NEWER generation's: that is the box of a desk that has already
      // moved on (carryDraftForward may just have put the text there), seen
      // from a desk still showing an older generation.
      if (prefix === activePrefix && typeof generation === 'number' && identity[2] > generation) continue
      const suffix = partSuffix(key)
      const textKey = suffix ? key.slice(0, -suffix.length) : key
      if (found.some(f => f.textKey === textKey)) continue
      found.push({ generation: identity[2], textKey })
    }
    found.sort((a, b) => a.generation - b.generation)
    // The pre-generation key predates every numbered generation, so it goes in
    // first and Up reaches it last.
    const legacy = legacyDraftKey(slug, id)
    let legacyText = ''
    try { legacyText = localStorage.getItem(legacy) || '' } catch { /* unavailable */ }
    if (legacyText) {
      if (recordStranded(slug, id, legacyText)) absorbed++
      try { localStorage.removeItem(legacy) } catch { /* unavailable */ }
    }
    for (const { textKey } of found) {
      let text = ''
      try { text = localStorage.getItem(textKey) || '' } catch { /* unavailable */ }
      // A draft with attachments but no text leaves orphan sibling keys behind.
      // There is nothing to recall from it -- recall is text-only -- but the
      // keys still have to go, or they sit in storage forever.
      if (text && recordStranded(slug, id, text)) absorbed++
      dropDraft(textKey)
    }
    try { localStorage.removeItem(`${dismissedRecoveryPrefix}${JSON.stringify([slug, id])}`) } catch { /* unavailable */ }
  } catch { /* unavailable storage */ }
  return absorbed
}

/** A validated rename moves the agent's history with it. Per-agent history is
 *  keyed on the node id, and a rename changes that id while leaving the same
 *  agent in place — so without this, renaming would lose the history exactly
 *  the way a generation-scoped key would. */
export function renameHistory(slug: string, from: string, to: string) {
  try {
    const source = historyKey(slug, from)
    const target = historyKey(slug, to)
    const value = localStorage.getItem(source)
    if (value === null) return
    if (localStorage.getItem(target) === null) localStorage.setItem(target, value)
    localStorage.removeItem(source)
  } catch { /* best effort persistence */ }
}
