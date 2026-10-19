import { configureOpenTiming } from './opentiming'
import type { QuickChatDefaults } from './quickchat'
import type { MailReplyWire } from './eventReply'
import type { ReplyTarget } from './generated/events'
import { forgetNodeDetail, hydrateTree } from './archived'
import type { NodeDetail } from './archived'
import { bumpLive, flushLive } from './livebus'
import { backendRestart } from './windowlife'
import { desktop } from './desktop'
import { applyWorkDelta } from './workdelta'
import { ForegroundWorkReader } from './workforeground'
import { WorkReferenceReader } from './workreferences'
import type { WorkDelta } from './workdelta'
import { decodeTree, type TreeWire } from './treedelta'
import { ForegroundTreeReader } from './foregroundtree'
import { AgentReferences } from './agentrefs'
import { TreeViewReader } from './treeview'
import { epic } from './epic/tap'
import type { TreeSelection } from './treeview'
import type {
  AudiencesPayload, CharterTemplateDirsPayload, ChartersPayload, ChatPayload, DefaultsPayload,
  EventsPayload, FsPayload,
  HireDefaultsRequest, HistoryPayload, HostPayload,
  InboxPayload, MailEntry,
  LangServer, LangServerDoc, LangServerProbe, LangServerRepriced,
  HarnessesDoc, McpServersPayload, OpenRouterDoc, OpenRouterModelsPage, OpenRouterSort,
  OpRequest, OpResult, OrgListEntry, OrgMdPayload,
  OrgInboxEntry, OrgNetReveal, ProvidersPayload, ReorderRequest,
  RuntimeSettingsPayload,
  ScopeRequest,
  SendMessageResult,
  SettingsRequest, SettingsResult, TreePayload, OrgAccountLane,
  AccountsPayload, AccountUsage, UsageAllPayload,
  AccountRegistryPayload, RegisteredAccountUsage,
  UploadResult, UsagePayload, UsagePeek,
  WorkItemsPayload, WorkItemPayload, WorkItemReplyResult, DismissAttentionResult,
  WorkItemAttachment,
} from './types'

/** THE RESTART DETECTOR.
 *
 *  A redeploy restarts the server and leaves every open tab running the bundle
 *  it loaded — an old client against a new API, which looks fine and is subtly
 *  wrong until someone thinks to press refresh. The backend stamps every
 *  response with the id of the process that answered it (`api.INSTANCE`, fresh
 *  per start), so the first one we see is the server we were built against and
 *  any different one means it was replaced. Reload, whole page.
 *
 *  It costs no request and no poller: the heartbeats this app already runs
 *  (the tree, the conversation, every open panel) all pass through `req`, so
 *  detection is within one poll of the restart.
 *
 *  Detached editable surfaces defer reload for an explicit user choice;
 *  windowlife owns that sticky choice and the single reload operation. */
let instance = ''
function noteInstance(r: Response): void {
  const verbose = r.headers.get('X-Orgtree-Verbose')
  if (verbose !== null) configureOpenTiming(verbose === '1', value => {
    // Diagnostics are not mutations: never invalidate detail caches or wake
    // every polled view just because an open was measured.
    void fetch('/api/diagnostics/ui-open', {method:'POST',
      headers:{'Content-Type':'application/json'},body:JSON.stringify(value),
      signal:timeoutSignal(5000)}).then(r => { noteInstance(r); return r.text() }).catch(() => {})
  })
  const id = r.headers.get('X-Orgtree-Instance')
  if (!id) return
  if (!instance) { instance = id; return }
  if (id === instance) return
  // The window lifecycle coordinator offers an explicit choice when a
  // detached form could be lost. A deferred choice stays latched.
  clearProviderDiscovery()
  backendRestart(id)
}

/** A request that never answers is worse than one that fails.
 *
 *  `fetch` has NO timeout. A backend that accepts the connection and then
 *  never responds — wedged update thread, a handler blocked on something
 *  upstream, a half-open socket after the machine slept — leaves the promise
 *  unsettled for minutes, and every caller that gates on it stalls with it.
 *  On the desk that is visible as a sent message stuck unconfirmed at the
 *  bottom of the conversation: its ghost cannot graduate (no payload) and
 *  cannot retire (no error), so it sits there looking queued forever
 *  (user report 2026-08-10).
 *
 *  A ceiling turns that into an ordinary failure, which every caller already
 *  handles. It is deliberately GENEROUS — this is a liveness backstop, not a
 *  latency policy, and a slow-but-alive request must never be cut off. Calls
 *  that legitimately outlast it (uploads, org creation, sweeps) pass their
 *  own. */
const DEFAULT_TIMEOUT_MS = 45_000
/** for the handful that provision, format or transfer — still bounded, so a
 *  hung one cannot stall its caller for the life of the tab */
const SLOW_TIMEOUT_MS = 600_000
const timeoutSignal = (ms: number): AbortSignal | undefined => {
  // AbortSignal.timeout is unavailable on older Safari; without it the call
  // simply behaves as it always did rather than failing to be made
  const f = (AbortSignal as { timeout?: (n: number) => AbortSignal }).timeout
  return typeof f === 'function' ? f(ms) : undefined
}

/** AbortError is caller/browser cancellation; the request ceiling uses
 * TimeoutError and remains a genuine failure. Check names across windows. */
export const isRequestCancelled = (error: unknown): boolean =>
  !!error && typeof error === 'object' && 'name' in error && error.name === 'AbortError'

/** How much of a non-JSON body is worth putting in front of a person. Long
 *  enough for a real sentence, short enough that an HTML error page does not
 *  become the error message. */
const BODY_EXCERPT = 300

/** Turn ANY failed response into a readable Error — JSON body or not.
 *
 *  ⚠ THIS EXISTS BECAUSE THE OLD CODE ASSUMED JSON. `if (!r.ok) r.json()`
 *  was every error path in this file, and a backend 500 from an unhandled
 *  exception answers `Internal Server Error` as `text/plain`. Feeding that
 *  to `r.json()` rejects with the parser's own complaint, so the user
 *  pressing stop on a stuck agent was shown
 *  `Unexpected token 'I', "Internal S"... is not valid JSON` — a message
 *  about our parser, with nothing in it about the agent or the failure
 *  (user report 2026-09-20).
 *
 *  The body is read ONCE as text and parsed defensively, in this order:
 *  the backend's `detail` (every `HTTPException` on the server uses it, and
 *  so does the server's new catch-all 500 handler), then a `message`/`error`
 *  string, then the raw text, then `statusText`, then the bare status. The
 *  status code is always prefixed, so "500" is visible even when the body
 *  is empty — an empty body used to produce `new Error('')`, which renders
 *  as no message at all. */
/** The server's own words out of a parsed error body, or '' if it has none. */
const stated = (parsed: unknown): string => {
  if (typeof parsed === 'string') return parsed.trim()
  if (!parsed || typeof parsed !== 'object') return ''
  const b = parsed as { detail?: unknown; message?: unknown; error?: unknown }
  for (const v of [b.detail, b.message, b.error]) {
    if (typeof v === 'string' && v.trim()) return v.trim()
    // a FastAPI validation error puts an array of objects on `detail`
    if (v && typeof v === 'object') return JSON.stringify(v).slice(0, BODY_EXCERPT)
  }
  return ''
}

const failure = async (r: Response): Promise<Error> => {
  let text: string | null = null
  let parsed: unknown
  // ⚠ `typeof r.text === 'function'` IS FOR THE TEST DOUBLES, not for real
  // responses. Every browser/Node `Response` has `text()`; a dozen suites in
  // apps/desktop/renderer/tests hand-roll a minimal stub with `json()` and
  // nothing else, and reading a body through an accessor they do not have
  // would turn every one of their error assertions into a different message.
  // Nothing is hidden by the fallback: the real non-JSON path is measured
  // against a real `Response` in tests/stopnonjson.test.tsx.
  if (typeof r.text === 'function') {
    try { text = await r.text() } catch { text = null }
    if (text && text.trim()) {
      try { parsed = JSON.parse(text) } catch { parsed = undefined }
    }
  } else if (typeof r.json === 'function') {
    try { parsed = await r.json() } catch { parsed = undefined }
  }
  // ⚠ WHEN THE SERVER STATED A REASON, THAT REASON IS THE WHOLE MESSAGE —
  // byte for byte what `b.detail || r.statusText` produced before. Every
  // error string this app shows comes through here, so decorating the normal
  // case would change hundreds of user-visible messages to fix one broken
  // one. The status is prefixed ONLY where the alternative is a body that
  // cannot say what it is, such as a bare `Internal Server Error`.
  const detail = stated(parsed)
  const body = (text ?? '').trim()
  const message = detail
    || (body ? `${r.status}: ${body.slice(0, BODY_EXCERPT)}` : '')
    || r.statusText
    || `HTTP ${r.status}`
  const e = new Error(message)
  // kept for callers that want to branch on the status rather than the prose
  Object.assign(e, { status: r.status, body: body.slice(0, BODY_EXCERPT) })
  return e
}

// the one wire-boundary cast in the app: runtime JSON is untyped, and each
// endpoint's declared Promise<T> return type is the contract that types it.
// T infers from that declared return at every call site - no `any` escapes.
export const req = <T,>(path: string, init?: RequestInit,
                 timeoutMs: number = DEFAULT_TIMEOUT_MS,
                 expectedStatuses: readonly number[] = []): Promise<T> =>
  fetch(path, init?.signal || !timeoutMs
    ? init
    : { ...init, signal: timeoutSignal(timeoutMs) }).then((r) => {
    // before the ok/not-ok split: a restart is worth noticing even when the
    // call it rode in on failed
    noteInstance(r)
    if (!r.ok && !expectedStatuses.includes(r.status)) {
      // EPIC Mode's tap (null unless it is on): a refused change gets its alarm
      if ((init?.method ?? 'GET') !== 'GET') epic?.refused(path, r.status)
      return failure(r).then((e) => { throw e })
    }
    // the client's G2 (see livebus.ts): every successful mutation THIS tab
    // makes wakes every mounted polled surface — centrally, so no call site
    // has to remember a refetch and none can be forgotten
    if ((init?.method ?? 'GET') !== 'GET') {
      // §4.8: any mutation can change a seat's charter or scope, so drop what
      // we cached for it. This is the LOCAL half and it is a fast path, not
      // the guarantee: it fires immediately, ahead of the refresh that would
      // carry the seat's new `detail_rev`, and it costs at most one refetch —
      // only when an archived card is actually open. The guarantee is the
      // revision itself, which is the only thing that can see a write made in
      // ANOTHER window or by an agent, where this tab issues no request at all.
      forgetNodeDetail()
      forgetWorkInflight()
      bumpLive()
    }
    // A 2xx whose body is not JSON is still our bug to report readably, not
    // the JSON parser's to announce. The body is already being consumed by
    // json(), so this cannot quote it — it names the status and the content
    // type instead, which is what tells an operator "the backend answered,
    // and it answered with something that is not our protocol".
    return (r.json() as Promise<T>).catch((e: unknown) => {
      if (isRequestCancelled(e)) throw e
      throw new Error(
        `${r.status}: the backend's reply was not JSON `
        + `(content-type ${r.headers.get('Content-Type') || 'unset'}): `
        + (e instanceof Error ? e.message : String(e)))
    })
  })

export const listOrgs = (): Promise<OrgListEntry[]> => req('/api/orgs')
export const retryOrg = (slug: string): Promise<OrgListEntry> =>
  req(`/api/orgs/${encodeURIComponent(slug)}/retry`, { method: 'POST' }, SLOW_TIMEOUT_MS)
export const createOrg = (
  name: string, dirs: string[],
  netAutoconnect = true, netHubs: string[] = [],
  template: TemplatePick | null = null,
): Promise<{ slug: string; hired?: string[] }> =>
  req<{ slug: string; hired?: string[] }>('/api/orgs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name, dirs,
      // F-06: mailserver — local-hub opt-out + typed remote addresses
      ...(netAutoconnect ? {} : { net_autoconnect: false }),
      ...(netHubs.length ? { net_hubs: netHubs } : {}),
      ...(template ? { template } : {}),
    }),
  }, SLOW_TIMEOUT_MS)

// Organization templates: a tree of agents hired with a new org. They are
// the files in ~/.orgtree/templates, read afresh on every listing; the
// engine writes each built-in there once (a deleted one stays deleted).
export interface TemplateSummary {
  id: string | null; name: string; description?: string
  source: 'folder'; path: string
  agents: { name: string; tier: string; depth: number; parent: string | null }[]
  problems: string[]
  availability?: { unusable: boolean; checking: boolean; reason: string | null }
}
export interface TemplatePick {
  id: string
  overrides?: Record<string, { tier?: string; name?: string }>
  removed?: string[]
  kickoff?: boolean
  /** slot → the tier the preview showed; a create whose plan moved is refused */
  expect?: Record<string, string>
}
export interface TemplatePlanRow {
  slot: string; name: string; parent: string | null; depth: number
  tier: string | null; requested_tier: string; note: string | null
  account: string | null; provider: string | null
  seat: number; grant: number; charter: string
  team_charter: string | null; kickoff: boolean; blocked: boolean
  dirs_dropped: string[]
}
export interface TemplatePlan {
  id: string; name: string; agents: TemplatePlanRow[]; blocked: string[]
  ok: boolean; top_grant: number; org_md: boolean
  offered: { tier: string; seat: number; provider: string }[]
  /** the engine has not finished its first sign-in check: ask again shortly */
  loading?: boolean
  unusable_here?: boolean
}
export interface TemplateInclude {
  charters: boolean; credits: boolean; effort: boolean; tools: boolean
  org_md: boolean; accounts: boolean; folders: boolean
  /** Quick chat's defaults for the org (what it shows now) */
  quick_chat: boolean
  /** the org-wide settings this org set itself, never its folders, accounts or hubs */
  settings: boolean
}
export interface SavedTemplate {
  id: string; file: string; path: string; content: string; agents: number; problems: string[]
}
export const listTemplates = (name = ''): Promise<{ templates: TemplateSummary[]; dir: string; folder_error?: string | null; loading?: boolean }> =>
  req('/api/templates' + (name ? `?name=${encodeURIComponent(name)}` : ''))
export const resolveTemplate = (pick: TemplatePick, name: string, dirs: string[]): Promise<TemplatePlan> =>
  req('/api/templates/resolve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...pick, name, dirs }),
  })
// Restore the built-ins the folder lacks (also deleted ones); never overwrites a file.
export const populateTemplates = (): Promise<{ dir: string; created: string[]; existing: string[] }> =>
  req('/api/templates/populate', { method: 'POST' })
export const openTemplatesFolder = async (): Promise<{ ok: boolean; path?: string; error?: string }> => {
  const bridge = desktop()
  try {
    if (typeof bridge?.openTemplatesFolder === 'function') return await bridge.openTemplatesFolder()
    return await req('/api/templates/open', { method: 'POST' })
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
export const saveOrgTemplate = (slug: string, name: string, include: TemplateInclude, replace = false, description = '',
  quickChat?: QuickChatDefaults): Promise<SavedTemplate> =>
  req(`/api/orgs/${encodeURIComponent(slug)}/template`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, include, replace, ...(description ? { description } : {}),
      ...(quickChat && include.quick_chat ? { quick_chat: quickChat } : {}) }),
  })
// §4.8: archived seats arrive without their runtime fields; `hydrateTree`
// refills them from the payload's own `archived_defaults` before anything
// downstream sees the tree, so no reader has to know the seat was summarised.
//
// CONDITIONAL since perf-redesign 2026-09-12 (REPORT.md #3): the server
// stamps the tree with an ETag derived from everything the payload renders,
// and an unchanged org answers 304 with no body — so the heartbeat costs
// ~nothing when nothing moved. The 304 path returns the SAME object the
// last 200 produced, which also lets React's setTree bail out of the
// re-render entirely (Object.is on the unchanged reference). Bespoke fetch
// rather than req(): req treats every non-2xx as an error, and 304 is the
// success case here.
const treeCache = new Map<string, { etag: string; tree: TreePayload; raw: TreePayload; revision: string }>()
// Per-slug invalidation stamp. Deleting the cache entry is not enough for a
// request already IN FLIGHT (perf-review round 3): its captured `hit` would
// still resolve a 304 to the pre-patch tree, and its 200 would re-install a
// cache entry the ws patch just declared stale — either way setTree replaces
// the patched render with the past. getTree captures the stamp before each
// attempt and refuses to publish (return or cache) across a change — and
// that refusal holds on retry exhaustion too (perf-review round 4): a body
// or captured hit known to predate the last invalidation is never returned.
const treeCacheGen = new Map<string, number>()
/** A ws node_stream patch just edited the RENDERED tree in place (cache
 *  forecast, MCP counts). The conditional cache must not hand that edit's
 *  pre-patch snapshot back on the next 304 — drop the entry so the next
 *  heartbeat does a real fetch (whose payload includes the pushed value),
 *  and bump the stamp so an in-flight fetch refetches instead of
 *  publishing its pre-patch result. */
export const invalidateTreeCache = (slug: string): void => {
  treeCache.delete(slug)
  treeCacheGen.set(slug, (treeCacheGen.get(slug) ?? 0) + 1)
  foregroundTreeReader.invalidate()
}
/** A ws metadata patch (cache forecast, MCP counts) that edited the rendered
 *  tree in place. The full-tree cache is fenced exactly as invalidateTreeCache
 *  fences it. The SELECTED tree keeps its ETag (foreground-tree F1): its
 *  server moves the runtime stamp BEFORE it sends the frame, so a 304 there
 *  only ever confirms a body equal to the server's current one, and a changed
 *  body comes back as a delta against the kept base. Dropping the ETag instead
 *  made every such frame cost a full snapshot. */
export const patchedTreeCache = (slug: string): void => {
  treeCache.delete(slug)
  treeCacheGen.set(slug, (treeCacheGen.get(slug) ?? 0) + 1)
}
/** Resolves the tree body — ALWAYS (2026-09-19 base+patch protocol). The
 *  old contract resolved NULL when bounded attempts raced ws-patch
 *  invalidations; under a working swarm's continuous patch traffic every
 *  attempt raced one, refreshes starved, and lifecycle state sat visibly
 *  stale for over a minute (beta.1 wave 2). The payload now carries
 *  `sync_rev` and the CALLER reconciles: buffered patch frames newer than
 *  the body replay on top of it (App.tsx + treesync.ts), so a body that
 *  raced a patch converges instead of being discarded.
 *
 *  The invalidation stamp still guards the CACHE: a body that raced an
 *  invalidation is returned but not cached, so a later 304 can never
 *  revalidate a pre-patch entry. Null survives in the signature for
 *  callers' defensive checks but is no longer produced. */
export const getTree = (slug: string): Promise<TreePayload | null> => {
  const gen = treeCacheGen.get(slug) ?? 0
  const hit = treeCache.get(slug)
  return fetch(`/api/orgs/${slug}?view=delta`, {
    signal: timeoutSignal(DEFAULT_TIMEOUT_MS),
    ...(hit ? { headers: { 'If-None-Match': hit.etag } } : {}),
  }).then((r) => {
    noteInstance(r)
    if (r.status === 304 && hit) {
      // the cached body is unchanged server-side; newer patches replay on
      // top of it in the caller, so returning it is always safe now
      const raw = treeWatermarks(hit.raw, r)
      if (raw === hit.raw) return hit.tree
      const tree = hydrateTree(raw)
      if ((treeCacheGen.get(slug) ?? 0) === gen) treeCache.set(slug, { ...hit, raw, tree })
      return tree
    }
    if (!r.ok) {
      return failure(r).then((e) => { throw e })
    }
    const etag = r.headers.get('ETag')
    return r.json().then((wire: TreePayload | TreeWire) => {
      const raw = treeWatermarks(decodeTree(wire, hit), r)
      const tree = hydrateTree(raw)
      if ((treeCacheGen.get(slug) ?? 0) === gen && etag) {
        const revision = 'format' in wire && wire.format === 'orgtree.tree/v1'
          ? (wire as TreeWire).revision : etag
        treeCache.set(slug, { etag, tree, raw, revision })
      } else if (!etag) {
        treeCache.delete(slug)
      }
      return tree
    })
  })
}

/** Explicit full read for compatibility or a surface that asks for all rows.
 * A closed foreground view must not leave a whole-history legacy cache behind. */
export const getCompleteTree = async (slug: string): Promise<TreePayload> => {
  try {
    const tree = await getTree(slug)
    if (!tree) throw new Error('Missing complete tree response')
    return tree
  } finally { treeCache.delete(slug) }
}
const foregroundTreeReader = new ForegroundTreeReader(async (path, etag) => {
  const response = await fetch(path, { signal: timeoutSignal(DEFAULT_TIMEOUT_MS),
    ...(etag ? { headers: { 'If-None-Match': etag } } : {}) })
  noteInstance(response)
  return response
}, getCompleteTree)
const foregroundTreeViews = new TreeViewReader(foregroundTreeReader, getCompleteTree)
/** Identity facts for agents omitted from a selected tree, per catalog. */
export const agentReferences = new AgentReferences((org, ids) => foregroundTreeReader.references(org, ids))
export const getSelectedTree = async (slug: string, selection: TreeSelection): Promise<TreePayload> =>
  (await foregroundTreeViews.get(slug, selection)).tree
/** App's tree read. A backend without the selected-tree endpoint keeps the
 * conditional (ETag) full read on every later heartbeat instead of an
 * uncached whole-history fetch. */
export const getAppTree = async (slug: string, selection: TreeSelection): Promise<TreePayload | null> =>
  foregroundTreeReader.isUnavailable(slug) ? getTree(slug) : getSelectedTree(slug, selection)

/** An unchanged content token can advance its replay boundary without a body.
 * Never alter a shared cached tree: in-flight readers may still be using it. */
function treeWatermarks(raw: TreePayload, response: Response): TreePayload {
  let result = raw
  for (const [header, key] of [['X-Orgtree-Sync-Rev', 'sync_rev'], ['X-Orgtree-Org-Rev', 'org_rev']] as const) {
    const value = response.headers.get(header)
    if (value === null) continue
    const rev = Number(value)
    if (Number.isSafeInteger(rev) && rev >= 0 && rev !== raw[key]) result = { ...result, [key]: rev }
  }
  return result
}
/** §4.8: the fields a summarised (archived) seat does not carry — full
 *  charter, scope, lineage, turn history. Fetched when a seat is opened. */
export const getNodeDetail = (slug: string, id: string): Promise<NodeDetail> =>
  req(`/api/orgs/${slug}/nodes/${encodeURIComponent(id)}/detail`)
export const deleteOrg = (slug: string): Promise<{ ok: boolean }> =>
  req(`/api/orgs/${slug}`, { method: 'DELETE' })
export const runOp = (slug: string, body: OpRequest): Promise<OpResult> =>
  req<OpResult>(`/api/orgs/${slug}/ops`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then((result: OpResult) => {
    // req already queued the mutation refresh. Start this move's catch-up
    // at acknowledgment instead of adding the normal 120 ms bus delay.
    if (body.op === 'move') flushLive()
    return result
  })

export const getChat = (slug: string, nid: string, last?: number, before?: string, after?: string): Promise<ChatPayload> =>
  req(`/api/orgs/${slug}/nodes/${nid}/chat?last=${last ?? 300}${before ? `&before=${encodeURIComponent(before)}` : ''}${after ? `&after=${encodeURIComponent(after)}` : ''}`)

/** multi-account: reassign a node's account (operator surface). The result
 * is the full disclosure set — billing mode, standing with provenance, the
 * continuity record — shown at the point of action, never silent. */
/** A USER'S OWN SAVE MOVED THE TREE: re-read it now, not after the pacer's gap
 *  (docket v3-changing-an-agent-s-model-does-not-show-at-on). The settings
 *  dialog saves scope (effort, tools, ...) and the account through these direct
 *  routes rather than App's `op`, so without this the new values waited for the
 *  server's `changed` frame, whose tree read is paced like background traffic:
 *  at least TREE_MIN_GAP_MS and up to 2x the last read's duration. App listens
 *  and asks for an URGENT read, which waits only for a read already in flight. */
export const TREE_STALE_EVENT = 'orgtree:tree-stale'
export function markTreeStale(slug: string): void {
  // a hint, never a failure: the save has already succeeded, so nothing here
  // may turn it into a rejected promise (and not every host defines
  // CustomEvent globally)
  try {
    if (typeof window === 'undefined' || typeof window.CustomEvent !== 'function') return
    window.dispatchEvent(new window.CustomEvent(TREE_STALE_EVENT, { detail: { slug } }))
  } catch { /* the next paced read still brings the change */ }
}
const staleAfter = <T,>(slug: string, done: Promise<T>): Promise<T> =>
  done.then((r) => { markTreeStale(slug); return r })

export const assignAccount = (slug: string, nid: string, account: string):
  Promise<{ account: string; label: string; billing_mode?: string
            standing?: { state: string; until?: number; provenance?: string }
            session_boundary: boolean
            /** a busy node: the change waits for the turn boundary and the
             *  reply carries no billing mode or standing yet */
            queued?: boolean; pending_account?: string; cancelled?: string }> =>
  staleAfter(slug, req(`/api/orgs/${slug}/nodes/${nid}/account`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account }),
  }))
export const getMcpServers = (): Promise<McpServersPayload> =>
  req('/api/mcp-servers')
export const refreshMcpServers = (): Promise<McpServersPayload> =>
  req('/api/mcp-servers/refresh', { method: 'POST' })
export const refreshSkills = (): Promise<{ skills: { name: string; sources: string[] }[]; digest: string }> =>
  req('/api/skills/refresh', { method: 'POST' })
export const refreshGlobalInstructions = (): Promise<{ files: number; refreshed: boolean }> =>
  req('/api/global-instructions/refresh', { method: 'POST' })
export const getCharters = (): Promise<ChartersPayload> =>
  req('/api/charters')
// Seed ~/.orgtree/charters from the bundled presets; never overwrites a
// user file, so calling it again is safe. Ran when onboarding completes.
export const populateCharters = (): Promise<{ dir: string; created: string[]; existing: string[] }> =>
  req('/api/charters/populate', { method: 'POST' })
/** Open the canonical user charter directory (~/.orgtree/charters) using
 *  desktop shell integration, creating it first if missing. */
export const openCharterFolder = async (): Promise<{ ok: boolean; path?: string; error?: string }> => {
  const bridge = desktop()
  if (typeof bridge?.openCharterFolder === 'function') {
    try {
      return await bridge.openCharterFolder()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { ok: false, error: message }
    }
  }
  try {
    return await req('/api/charters/open', { method: 'POST' })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, error: message }
  }
}
/** The app-wide list of external charter template folders with each one's
 *  read-only scan state. Saving replaces the whole ordered list. */
export const getCharterTemplateDirs = (): Promise<CharterTemplateDirsPayload> =>
  req('/api/app-settings/charter-template-dirs')
export const setCharterTemplateDirs = (dirs: string[]): Promise<CharterTemplateDirsPayload> =>
  req('/api/app-settings/charter-template-dirs', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dirs }),
  })
export const getFs = (path = ''): Promise<FsPayload> =>
  req(`/api/fs?path=${encodeURIComponent(path)}`)
export const getInbox = (slug: string): Promise<InboxPayload> =>
  req(`/api/orgs/${slug}/inbox`)
/** Bounded retained history, independent of the pushed newest-mail windows. */
export const getMailHistory = (slug: string, folder: 'inbox' | 'sent', before?: string, node?: string): Promise<InboxPayload> =>
  req(`/api/orgs/${slug}/${node ? `nodes/${encodeURIComponent(node)}/` : ''}inbox?folder=${folder}${before ? `&before=${encodeURIComponent(before)}` : ''}`)
export const deleteUserMail = (slug: string, id: string): Promise<{ deleted: boolean }> =>
  req(`/api/orgs/${slug}/inbox/${encodeURIComponent(id)}`, { method: 'DELETE' })
/** Exact tag filter over all retained incoming mail, bounded and cursor-paged. */
export const getTaggedInbox = (slug:string,tags:readonly string[],before?:string):Promise<InboxPayload> =>
  req(`/api/orgs/${slug}/inbox/filter`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({tags,before})})
export interface MailTagPage {tag_choices:string[];next_tag_cursor?:string|null}
export const getMailTagChoices = (slug:string,query='',after?:string):Promise<MailTagPage> =>
  req(`/api/orgs/${slug}/inbox?tags_only=true&prefix=${encodeURIComponent(query)}${after?`&after=${encodeURIComponent(after)}`:''}`)
export const getNodeInbox = (slug: string, nid: string): Promise<InboxPayload> =>
  req(`/api/orgs/${slug}/nodes/${nid}/inbox`)
/** ONE message, by id, from the box that holds it.
 *
 * ⚠ ASKED ONLY WHEN A REFERENCE LANDS OUTSIDE THE LOADED WINDOW. Every box
 * route returns a slice, so "not in what I am holding" is not the same fact
 * as "not there" — and the reading pane used to state the second when it
 * only knew the first. This is the exact question; it is not a bigger poll. */
export const getMailById = (slug: string, box: 'user' | 'org' | 'node',
                            id: string, node?: string, chunk?: number):
  Promise<{ found: boolean; mail: MailEntry | null }> => {
  const params = new URLSearchParams()
  if (node) params.set('node', node)
  if (chunk !== undefined) params.set('chunk', String(chunk))
  const qs = params.toString()
  return req(`/api/orgs/${slug}/mail/${box}/${encodeURIComponent(id)}` + (qs ? `?${qs}` : ''))
}
export const resumeFrozen = (slug: string): Promise<{ resumed: string[] }> =>
  req(`/api/orgs/${slug}/resume`, { method: 'POST' })
export const killAll = (slug: string): Promise<{
  /** absent from an older engine, which only interrupted */
  latched?: boolean
  already_latched?: boolean
  interrupted: string[]
  watchdogs_paused?: Array<{ id: string; name: string; owner: string }>
}> =>
  req(`/api/orgs/${slug}/killswitch`, { method: 'POST' })
export const releaseKillswitch = (slug: string): Promise<{
  released: boolean; merged?: string[]; status?: string
}> =>
  req(`/api/orgs/${slug}/killswitch/release`, { method: 'POST' })
export const dissolveAll = (slug: string): Promise<{ freed: number; nodes: number }> =>
  req(`/api/orgs/${slug}/dissolve-all`, { method: 'POST' })
export const interruptNode = (
  slug: string, nid: string,
): Promise<{ interrupted: boolean; reason?: string }> => {
  const asked = req<{ interrupted: boolean; reason?: string }>(`/api/orgs/${slug}/nodes/${nid}/interrupt`, { method: 'POST' })
  // EPIC Mode's tap: an interrupt leaves no mark in the tree to stage, and
  // only one the engine accepted gets the stop sign (the Astra take: a
  // request never celebrates what did not happen). Off, `epic` is null and
  // this is one check.
  return epic ? asked.then(r => { if (r?.interrupted === true) epic?.action(slug, 'interrupt', nid); return r }) : asked
}
/** A halt that does not finish inside the request now hands off to a named
 *  background operation instead of answering an unowned "still halting":
 *  `operation` identifies it, `blocking` says in plain sentences what is
 *  keeping it open, and `surviving_processes` names the pids. All three are
 *  optional — an older engine sends none of them and the `halted`/`settled`
 *  pair reads exactly as it always did. */
export const haltNode = (slug: string, nid: string): Promise<{
  halted: boolean; settled: boolean; halting?: boolean; status: string
  operation?: { operation_id: string; state: string; requested_at: string }
  blocking?: string[]
  surviving_processes?: { kind: string; pid: number | null }[]
}> => req(`/api/orgs/${slug}/nodes/${nid}/halt`, { method: 'POST' })
export const unhaltNode = (slug: string, nid: string): Promise<{
  unhalted: boolean; status?: string
}> => req(`/api/orgs/${slug}/nodes/${nid}/unhalt`, { method: 'POST' })
export const processControl = (
  slug: string, nid: string, action: 'start' | 'stop',
): Promise<{ ok: boolean; action: 'start' | 'stop'; already?: boolean;
  paused: boolean; proc_warm: boolean; proc_live: boolean; killed?: boolean }> =>
  req(`/api/orgs/${slug}/nodes/${nid}/process`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action }),
  })
export interface CompactCapability { supported: boolean; reason: string | null }
export const compactCapability = (slug: string, nid: string): Promise<CompactCapability> =>
  req(`/api/orgs/${slug}/nodes/${nid}/compact`)
export const compactNode = (slug: string, nid: string): Promise<{ started: boolean; reason?: string }> =>
  req(`/api/orgs/${slug}/nodes/${nid}/compact`, { method: 'POST' })
/** ⭐ the user's per-node override (ruling 2026-08-06): releases EVERY lock
 *  holding the agent — any freeze kind, limit_locked, the org fable_lock if
 *  last holder — and re-drives it */
export const unstickNode = (slug: string, nid: string):
  Promise<{ released: string[]; status?: string; warnings?: string[] }> =>
  req(`/api/orgs/${slug}/nodes/${nid}/unstick`, { method: 'POST' })
/** ⭐ continue a FROZEN agent on another of the operator's accounts (user
 *  requirement 2026-09-14): switch the binding, then release the freeze so the
 *  held work goes on. ⚠ `switched` and `resumed` are SEPARATE answers — the
 *  switch can land while the release fails, and that state is neither a
 *  failure nor a continuation. Render what the backend says rather than
 *  assuming the pair. */
export const continueOnAccount = (slug: string, nid: string, account: string):
  Promise<{
    switched: boolean; resumed: boolean
    state: 'continued' | 'switched_not_resumed' | 'switched_nothing_to_release'
    account: string; status?: string; error?: string; retry?: string
    released?: string[]; warnings?: string[]
  }> =>
  req(`/api/orgs/${encodeURIComponent(slug)}/nodes/${encodeURIComponent(nid)}/continue-on`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ account }),
    })
export const creditDecide = (
  slug: string, id: string, action: string,
  // F-05: `granted` = the counter-offer amount; `dry` = validate + stranding
  // warnings only, mutating nothing (shown BEFORE the user commits)
  granted?: number, dry?: boolean,
): Promise<OpResult & { ok?: boolean; warnings?: string[] }> =>
  req(`/api/orgs/${slug}/credit-requests`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, action,
      ...(granted != null ? { granted } : {}), ...(dry ? { dry: true } : {}) }),
  })
export const answerAsk = (
  slug: string, aid: string,
  // FR-04 batch cards: `selected` is one item per tab, positionally —
  // a string, or a list for a multi tab's picks; `rev` echoes the card
  // revision so a mid-render amend refuses the stale submission
  body: { selected?: (string | string[])[]; text?: string; rev?: number
    dismiss?: boolean },
): Promise<{ answered: string; node: string }> =>
  req(`/api/orgs/${slug}/asks/${aid}/answer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
/** FR-18: the user manages a watchdog from its detail panel */
export const watchdogAction = (
  slug: string, id: string, action: 'pause' | 'resume' | 'remove',
  reason?: string,
): Promise<{ id: string; name: string; state: string }> =>
  req(`/api/orgs/${slug}/watchdogs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, action, ...(reason ? { reason } : {}) }),
  })
/** FR-14: the ONE submit over a node's whole request batch — question
 *  answers (null = explicitly skipped), the credits decision, and per-item
 *  scope grants; `revs` echoes the composed card's per-store CAS stamps */
export const resolveBatch = (
  slug: string, nid: string,
  body: { revs: Record<string, number>
    answers?: (string | string[] | null)[]
    credits?: { granted?: number; deny?: boolean; skip?: boolean }
    scope?: string[] },
): Promise<{ resolved: string }> =>
  req(`/api/orgs/${slug}/nodes/${nid}/batch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
// FR-01: hand an agent's session to claude.ai / the mobile app (and back)
export const remoteControl = (slug: string, nid: string,
  action: 'start' | 'stop'):
  Promise<{ ok?: boolean; note?: string }> =>
  req(`/api/orgs/${slug}/nodes/${nid}/remote-control`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action }),
  })
export const markMentionSeen = (slug: string, nid: string, mentionId?: string):
  Promise<{ ok: boolean }> =>
  req(`/api/orgs/${encodeURIComponent(slug)}/nodes/${encodeURIComponent(nid)}/mention-seen`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(mentionId ? { id: mentionId } : {}),
  })
// FR-03: presented documents — the reader fetches the body on open
export const getDocument = (slug: string, did: string):
  Promise<{ id: string; node: string; presented_by?: string; title: string; body: string; at: string; format?: 'markdown' | 'html'; bytes?: number }> =>
  req(`/api/orgs/${slug}/documents/${did}`)
/** A stable operator-only HTML preview; content isolation is server-enforced. */
export const mockupUrl = (slug: string, did: string): string =>
  `/api/orgs/${encodeURIComponent(slug)}/documents/${encodeURIComponent(did)}/mockup`
// the gallery (user request 2026-09-03): every card, org-wide, newest first —
// metadata only (no body; the reader fetches that on open). `evicted` rows
// are cards the retention prune dropped whose log line survives — no body to
// fetch, but still findable rather than silently gone.
export interface DocRow {
  id: string; node: string; title: string; at: string
  viewed_at?: string | null
  format?: 'markdown' | 'html'
  bytes?: number
  evicted: boolean; node_state: 'live' | 'archived' | 'unrecoverable' | 'deleted'
  /** the presenting agent's model, for the row's tier chip. Served from the
   *  ledger rather than looked up client-side: the gallery lists cards from
   *  agents the tree walk does not carry. Null once the node is gone. */
  tier?: string | null
  /** the agent that PRESENTED it; differs from `node` for a document
   *  presented under a project (user 2026-10-17 22:47:51Z) */
  presented_by?: string
  presenter_tier?: string | null
}
/** `limit` is the size of the WINDOW the caller is holding, not a page size:
 *  the gallery reads from offset 0 and grows the window as the reader scrolls,
 *  so every response is a complete newest-first prefix (canvas/gallery.tsx).
 *  Omitted, the server's own default applies. */
export const getDocuments = (slug: string, offset = 0, node = '', locate = '', limit = 0, team = false): Promise<{ documents: DocRow[]; total: number; next_offset: number | null; offset?: number; located?: string }> =>
  req(`/api/orgs/${slug}/documents?offset=${offset}&node=${encodeURIComponent(node)}`
    + (limit > 0 ? `&limit=${limit}` : '')
    + (team ? '&team=1' : '')
    + (locate ? `&locate=${encodeURIComponent(locate)}` : ''))
export const dismissDocument = (slug: string, did: string):
  Promise<{ ok: boolean; node: string }> =>
  req(`/api/orgs/${slug}/documents/${did}`, { method: 'DELETE' })
// LOCKED docket wire contract v3 (luna-reserve/evidence/docket-wire-
// contract-v3.md) — see types.ts's "work docket" section.
//
// Light rows shared across docket and Attention consumers. Closed groups stay
// out of list requests; opening an item fetches its full detail separately.
// A docket-content ETag returns 304 for unrelated saves, or a delta since the
// retained revision. Concurrent callers of one URL share a request; mutations
// detach older requests so their late answers cannot replace the newer cache.
const workCache = new Map<string, { etag: string; body: WorkItemsPayload }>()
const workInflight = new Map<string, Promise<WorkItemsPayload>>()
let workGeneration = 0
export const forgetWorkInflight = (): void => {
  ++workGeneration; workInflight.clear()
  foregroundWorkReader.invalidate(); workReferenceReader.invalidate()
}
export const getWorkItems = (slug: string, archived = false,
                             backlogged = false): Promise<WorkItemsPayload> => {
  const path = `/api/orgs/${slug}/work-items-view`
    + (archived || backlogged
      ? '?' + [archived ? 'archived=1' : '', backlogged ? 'backlogged=1' : '']
        .filter(Boolean).join('&')
      : '')
  const pending = workInflight.get(path)
  if (pending) return pending
  const hit = workCache.get(path)
  const generation = workGeneration
  const p: Promise<WorkItemsPayload> = fetch(path, {
    signal: timeoutSignal(DEFAULT_TIMEOUT_MS),
    ...(hit ? { headers: { 'If-None-Match': hit.etag } } : {}),
  }).then((r) => {
    noteInstance(r)
    if (r.status === 304 && hit) return hit.body
    if (!r.ok) return failure(r).then((e) => { throw e })
    const etag = r.headers.get('ETag')
    return (r.json() as Promise<WorkItemsPayload | WorkDelta>).then((incoming) => {
      const body = applyWorkDelta(hit?.body, incoming)
      // A response which predates a mutation may finish after its replacement.
      // It can answer its original caller, but must never roll the cache back.
      if (generation === workGeneration && workInflight.get(path) === p) {
        if (etag) workCache.set(path, { etag, body })
        else workCache.delete(path)
        while (workCache.size > 24) workCache.delete(workCache.keys().next().value!)
      }
      return body
    })
  }).finally(() => {
    if (workInflight.get(path) === p) workInflight.delete(path)
  })
  workInflight.set(path, p)
  return p
}
const readWorkResponse = async (path: string, etag?: string): Promise<Response> => {
  const response = await fetch(path, { signal: timeoutSignal(DEFAULT_TIMEOUT_MS),
    ...(etag ? { headers: { 'If-None-Match': etag } } : {}) })
  noteInstance(response)
  return response
}
// Compatibility reads are whole answers and deliberately uncached: retaining
// an explicitly opened archive here would outlive the view that requested it.
const legacyWorkRead = (slug: string, archived: boolean, backlogged: boolean): Promise<WorkItemsPayload> =>
  req(`/api/orgs/${encodeURIComponent(slug)}/work-items-view`
    + (archived || backlogged ? '?' + [archived ? 'archived=1' : '', backlogged ? 'backlogged=1' : ''].filter(Boolean).join('&') : ''))
const foregroundWorkReader = new ForegroundWorkReader(readWorkResponse, legacyWorkRead)
export const getForegroundWorkItems = (slug: string, archived = false, backlogged = false): Promise<WorkItemsPayload> =>
  foregroundWorkReader.get(slug, archived, backlogged)
const workReferenceReader = new WorkReferenceReader(async (org, names) => {
  const response = await readWorkResponse(`/api/orgs/${encodeURIComponent(org)}/work-item-references?names=${encodeURIComponent(names.join(','))}`)
  if (response.status === 409) {
    const control = await response.json()
    if (control.kind === 'compatibility') {
      const legacy = await legacyWorkRead(org, true, true)
      return (legacy.references ?? [...legacy.items, ...(legacy.archived ?? []), ...(legacy.backlogged ?? [])])
        .filter(row => names.includes(row.slug))
    }
    throw new Error(control.detail || 'Could not resolve docket references')
  }
  if (!response.ok) throw await failure(response)
  const body = await response.json()
  if (!Array.isArray(body.references)) throw new Error('Invalid docket reference response')
  return body.references
})
export const getWorkReferences = (org: string, revision: string, names: string[]) =>
  workReferenceReader.get(org, revision, names)
export const getWorkPage = (org: string, group: import('./workpages').WorkGroup,
  options: import('./workpages').WorkPageOptions = {}, offset = 0,
  cursor?: Pick<import('./workpages').WorkPage, 'revision' | 'at'>): Promise<import('./workpages').WorkPage> => {
  const q = new URLSearchParams({ group, offset: String(offset), ...options,
    ...(cursor ? { revision: cursor.revision, at: cursor.at } : {}) })
  return req(`/api/orgs/${encodeURIComponent(org)}/work-items-page?${q}`)
}
export const getWorkItem = (slug: string, id: string): Promise<WorkItemPayload> =>
  req(`/api/orgs/${slug}/work-items/${id}`)
export const replyWorkItem = (slug: string, id: string, body: string, to?: string,
  attachments?: string[], notice?: boolean): Promise<WorkItemReplyResult> =>
  req(`/api/orgs/${slug}/work-items/${id}/reply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ body, ...(to !== undefined ? { to } : {}),
      ...(attachments?.length ? { attachments } : {}),
      // notice-toggle parity (user 2026-09-17): the same flag Message.notice
      // carries on the ordinary send path, wired into the ticket reply box
      ...(notice ? { notice: true } : {}) }),
  })
// ---- ticket attachments (user feature 2026-09-10): files/images ON the
// item itself, not mail to the assignee. Raw-body upload like uploadFile.
export const uploadWorkItemAttachment = (slug: string, id: string, file: File):
  Promise<{ attachment: WorkItemAttachment }> =>
  req(`/api/orgs/${slug}/work-items/${id}/attachments?name=${encodeURIComponent(file.name)}`,
    { method: 'POST', body: file }, SLOW_TIMEOUT_MS)
// direct <img>/<a href> target
export const workItemAttachmentUrl = (slug: string, id: string, aid: string): string =>
  `/api/orgs/${slug}/work-items/${id}/attachments/${encodeURIComponent(aid)}`
// W08 artifacts: immutable evidence recorded by an agent. Download only — the
// UI never uploads one, because an artifact's provenance is the agent's own
// (the recorder is who a `named` grant authorizes against).
export const workItemArtifactUrl = (slug: string, id: string, aid: string): string =>
  `/api/orgs/${slug}/work-items/${id}/artifacts/${encodeURIComponent(aid)}`
// ⚠ permanent: the record and the stored bytes both go; there is no undelete
export const deleteWorkItemAttachment = (slug: string, id: string, aid: string):
  Promise<{ removed: string }> =>
  req(`/api/orgs/${slug}/work-items/${id}/attachments/${encodeURIComponent(aid)}`,
    { method: 'DELETE' })
export const dismissWorkItemAttention = (slug: string, id: string, setRev: number):
  Promise<DismissAttentionResult> =>
  req(`/api/orgs/${slug}/work-items/${id}/dismiss-attention`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ set_rev: setRev }),
  })
export const clearInbox = (slug: string): Promise<{ ok: boolean }> =>
  req(`/api/orgs/${slug}/inbox/clear`, { method: 'POST' })
export const markRead = (slug: string, ids: string[]): Promise<{ read: number }> =>
  req(`/api/orgs/${slug}/inbox/read`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids }),
  })
export const getHistory = (slug: string, nid: string): Promise<HistoryPayload> =>
  req(`/api/orgs/${slug}/nodes/${nid}/history`)
export const getOrgMd = (slug: string): Promise<OrgMdPayload> =>
  req(`/api/orgs/${slug}/orgmd`)
export const putOrgMd = (
  slug: string, content: string, baseRev?: string,
): Promise<{
  path: string; bytes: number; chars?: number; rev?: string
  prompt_max?: number; prompt_truncated?: boolean; warnings?: string[]
}> =>
  req(`/api/orgs/${slug}/orgmd`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content, base_rev: baseRev }),
  })
export const getAudiences = (slug: string): Promise<AudiencesPayload> =>
  req(`/api/orgs/${slug}/audiences`)
export const audienceAction = (
  slug: string, action: string, node: string, target?: string | null,
): Promise<OpResult> =>
  req(`/api/orgs/${slug}/audiences`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, node, target }),
  })
export const getHost = (): Promise<HostPayload> => req('/api/host')
// the provider axis (FR-15 preview): per-vendor tier families + this
// machine's CLI install/connect state — App settings and all hire surfaces
let providerSnapshot: ProvidersPayload | null = null
let providerRequest: Promise<ProvidersPayload> | null = null
let providerGeneration = 0
/** Last successful observation for instant display while discovery refreshes. */
export const peekProviders = (): ProvidersPayload | null => providerSnapshot
export function clearProviderDiscovery(): void {
  providerGeneration++
  providerSnapshot = null
  providerRequest = null
}
export function getProviders(): Promise<ProvidersPayload> {
  if (providerRequest) return providerRequest
  const generation = providerGeneration
  const request = req<ProvidersPayload>('/api/providers').then(payload => {
    if (generation === providerGeneration) providerSnapshot = payload
    return providerSnapshot ?? payload
  }).finally(() => {
    if (providerRequest === request) providerRequest = null
  })
  providerRequest = request
  return request
}
/** A model choice or the providers page opened: ask the engine to re-read
 *  the account's `agy models` list (user 2026-10-14: refresh when it matters,
 *  no polling). The engine debounces (one read in flight, a result under
 *  30 s reused) and republishes the providers value when the list changed,
 *  so hire tokens and selectors follow it live. Fire and forget. */
let agyModelsRequest: Promise<unknown> | null = null
export function refreshAgyModels(): void {
  if (agyModelsRequest) return
  agyModelsRequest = req<ProvidersPayload>('/api/providers/agy-models/refresh', { method: 'POST' })
    .catch(() => undefined)
    .finally(() => { agyModelsRequest = null })
}
/** The two machine-wide per-provider lane choices (2026-09-12 redesign).
 *  Both answer with the SAME providers document a settings read returns, so
 *  the panel cannot end up disagreeing with what was just written. */
export const setApikeyFallbackEnabled = (
  provider: string, enabled: boolean,
): Promise<ProvidersPayload> =>
  req<ProvidersPayload>(`/api/providers/${encodeURIComponent(provider)}/apikey-fallback`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
  }).then(payload => { providerSnapshot = payload; return payload })

export const setSubscriptionInferenceEnabled = (
  provider: string, enabled: boolean,
): Promise<ProvidersPayload> =>
  req<ProvidersPayload>(`/api/providers/${encodeURIComponent(provider)}/subscription-inference`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
  }).then(payload => { providerSnapshot = payload; return payload })

export const setProviderEnabled = (
  provider: string, enabled: boolean,
): Promise<ProvidersPayload> =>
  req<ProvidersPayload>(`/api/providers/${encodeURIComponent(provider)}/enabled`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
  }).then(payload => {
    clearProviderDiscovery()
    providerSnapshot = payload
    return payload
  })
// Sign in to a provider from the app (D-231) rides the NATIVE bridge, not
// this HTTP client — see accounts.tsx's ProviderSignIn and
// apps/desktop/main/providerlogin.ts's module docstring for why the child
// process cannot be spawned on the engine side of this boundary.
// the OpenRouter lane (2026-09-02): machine-wide like the provider switch —
// the key (stored, never returned), the credit standing, the catalog page the
// picker shows, and the favorites that become hireable tiers
export const getOpenRouter = (force = false): Promise<OpenRouterDoc> =>
  req(`/api/openrouter${force ? '?force=true' : ''}`)
export const setOpenRouterKey = (key: string): Promise<OpenRouterDoc> =>
  req('/api/openrouter/key', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key }),
  })
export const clearOpenRouterKey = (): Promise<OpenRouterDoc> =>
  req('/api/openrouter/key', { method: 'DELETE' })
// several keys at once (docket use-several-openrouter-keys-at-once, ruling
// 2026-10-11): each key is its own account, `openrouter-N`, every key alike
// (user 2026-10-14). A key crosses the wire once, inward; the answers are the
// panel's document (`keys` lists them).
export const addOpenRouterKey = (key: string, label?: string, harness?: string): Promise<OpenRouterDoc & { added: string; added_lane: string }> =>
  req('/api/openrouter/keys', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, ...(label?.trim() ? { label } : {}), ...(harness ? { harness } : {}) }),
  })
/** rename a key (`label`; empty clears the name), set its harness
 *  (`harness`; its agents switch at their next turn) and/or replace its
 *  secret (`key`) */
export const updateOpenRouterKey = (id: string, change: { key?: string; label?: string; harness?: string }): Promise<OpenRouterDoc> =>
  req(`/api/openrouter/keys/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(change),
  })
/** switch one key on or off app-wide (user 2026-10-11: every key is
 *  individually disableable; reversible, nothing is deleted). An inactive key
 *  serves no new turn; its agents' mail waits until it is on again or they
 *  move. Answers the refreshed panel document. */
export const setOpenRouterKeyEnabled = (id: string, enabled: boolean): Promise<OpenRouterDoc> =>
  req(`/api/accounts/${encodeURIComponent(id)}/enabled`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
  }).then(() => req<OpenRouterDoc>('/api/openrouter'))
/** every harness the engine knows (App settings › Harnesses): presence
 *  only, nothing is spawned */
export const getHarnesses = (): Promise<HarnessesDoc> => req('/api/harnesses')
/** remove a key, any key alike: each agent on it moves to another key it may
 *  run on, or waits until one is added */
export const removeOpenRouterKey = (id: string): Promise<OpenRouterDoc> =>
  req(`/api/openrouter/keys/${encodeURIComponent(id)}`, { method: 'DELETE' })
export const searchOpenRouterModels = (
  q: string, offset = 0, limit = 8,
  sort: OpenRouterSort = 'relevance', order = '', groupByVendor = false,
): Promise<OpenRouterModelsPage> =>
  req(`/api/openrouter/models?q=${encodeURIComponent(q)}`
    + `&offset=${offset}&limit=${limit}&sort=${sort}`
    + `&order=${order}&group_by_vendor=${groupByVendor}`)
export const setOpenRouterFavorite = (
  id: string, selected: boolean,
): Promise<OpenRouterDoc> =>
  req('/api/openrouter/favorites', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, selected }),
  })
// the Language Server lane: the user's own model servers (Ollama, LM Studio,
// llama.cpp, vLLM, custom). A key crosses the wire once, inward.
export const getLangServers = (): Promise<LangServerDoc> => req('/api/langservers')
export interface LangServerModelPick {
  id: string
  context?: number | null
  offered?: boolean
  label?: string
}
export const addLangServer = (body: {
  preset: string, address: string, harness: string, label?: string,
  base_path?: string, max_agents?: number, seat?: number, key?: string, models?: LangServerModelPick[],
}): Promise<{ server: LangServer, doc: LangServerDoc }> =>
  req('/api/langservers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
export const updateLangServer = (id: string, body: {
  label?: string, address?: string, base_path?: string, max_agents?: number, seat?: number,
  enabled?: boolean, models?: LangServerModelPick[],
}): Promise<{ server: LangServer, doc: LangServerDoc, repriced?: LangServerRepriced[] }> =>
  req(`/api/langservers/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
/** an empty key clears it */
export const setLangServerKey = (id: string, key: string): Promise<LangServerDoc> =>
  req(`/api/langservers/${encodeURIComponent(id)}/key`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key }),
  })
export const removeLangServer = (id: string): Promise<LangServerDoc> =>
  req(`/api/langservers/${encodeURIComponent(id)}`, { method: 'DELETE' })
/** ask a server what it offers: a stored one (`server`), or the one the add
 *  form describes. Loads no model. */
export const probeLangServer = (body: {
  server?: string, preset?: string, address?: string, harness?: string,
  base_path?: string, key?: string,
  /** only these models (a server card's window check); absent: every model */
  only?: string[],
}): Promise<LangServerProbe> =>
  req('/api/langservers/probe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
/** "Create a 64K version of this model": adds `<model>-64k` to the user's
 *  Ollama (the same weights with its own window; nothing is downloaded) and
 *  answers with the server's models again. Only ever on the user's click. */
export const createOllamaVariant = (body: {
  server?: string, address?: string, key?: string, model: string,
}): Promise<{ created: string, context: number, probe: LangServerProbe }> =>
  req('/api/langservers/ollama-variant', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
export const getRuntimeSettings = (): Promise<RuntimeSettingsPayload> =>
  req('/api/app-settings/runtime')
export const setAntigravityClaudeEnabled = (antigravity_claude_enabled: boolean): Promise<RuntimeSettingsPayload> =>
  req('/api/app-settings/runtime', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ antigravity_claude_enabled }),
  })
export const setEnterKeyBehavior = (enter_key_behavior: import('./composerkeys').EnterKeyBehavior): Promise<RuntimeSettingsPayload> =>
  req('/api/app-settings/runtime', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enter_key_behavior }),
  })
export const setGitPeriodicFetchEnabled = (enabled: boolean): Promise<RuntimeSettingsPayload> =>
  req('/api/app-settings/runtime', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ git_periodic_fetch_enabled: enabled }),
  })
export const setWarmingEnabled = (
  enabled: boolean,
): Promise<RuntimeSettingsPayload> =>
  req('/api/app-settings/runtime', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
  })
export const setWorkingCheckupsEnabled = (
  enabled: boolean,
): Promise<RuntimeSettingsPayload> =>
  req('/api/app-settings/runtime', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ working_checkups_enabled: enabled }),
  })
export const setProjectListenerWake = (
  enabled: boolean,
): Promise<RuntimeSettingsPayload> =>
  req('/api/app-settings/runtime', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project_listener_wake_enabled: enabled }),
  })
export const setVerboseLogging = (
  enabled: boolean,
): Promise<RuntimeSettingsPayload> =>
  req('/api/app-settings/runtime', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ verbose_logging: enabled }),
  })
export const setWaitForMcpToolsEnabled = (
  enabled: boolean,
): Promise<RuntimeSettingsPayload> =>
  req('/api/app-settings/runtime', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ wait_for_mcp_tools_enabled: enabled }),
  })
export const setIdleDocketRemindersEnabled = (
  enabled: boolean,
): Promise<RuntimeSettingsPayload> =>
  req('/api/app-settings/runtime', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idle_docket_reminders_enabled: enabled }),
  })
export const setBlockedDocketRemindersEnabled = (
  enabled: boolean,
): Promise<RuntimeSettingsPayload> =>
  req('/api/app-settings/runtime', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ blocked_docket_reminders_enabled: enabled }),
  })
export const setMaxConcurrentTurns = (
  limit: number,
): Promise<RuntimeSettingsPayload> =>
  req('/api/app-settings/runtime', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ max_concurrent_turns: limit }),
  })
export const getUsage = (force = false): Promise<UsagePayload> =>
  req(`/api/usage${force ? '?force=true' : ''}`)
// cache-only — the glow polls this; only the modal above may cost a fetch
export const getUsagePeek = (): Promise<UsagePeek> => req('/api/usage/peek')
export const getCodexUsage = (force = false): Promise<AccountUsage> =>
  req(`/api/codex/usage${force ? '?force=true' : ''}`)
// cache-only, like the Claude peek above
export const getCodexUsagePeek = (): Promise<UsagePeek> => req('/api/codex/usage/peek')
// the modal may run Antigravity's zero-token /usage command; the always-on
// glow remains cache-only so background UI polling never spawns a process
export const getAntigravityUsage = (force = false): Promise<AccountUsage> =>
  req(`/api/antigravity/usage${force ? '?force=true' : ''}`)
export const getAntigravityUsagePeek = (): Promise<UsagePeek> =>
  req('/api/antigravity/usage/peek')
// Muse: the latest standing Muse itself dated (`usage/read` or a turn's
// `usage/changed`); `force` asks Muse again now — a metadata read, never a
// model turn. The glow stays on the cache-only peek.
export const getMuseUsage = (force = false): Promise<AccountUsage> =>
  req(`/api/muse/usage${force ? '?force=true' : ''}`)
export const getMuseUsagePeek = (): Promise<UsagePeek> =>
  req('/api/muse/usage/peek')
// OpenRouter: a prepaid credit balance read off the stored key's
// `GET /api/v1/key`, cached 60s server-side — the modal costs a fetch, the
// glow polls the cache-only peek
/** every key's reading by its id, read alike (cached unless forced) */
export const getOpenRouterUsage = (force = false): Promise<{ provider: string; available: boolean; keys: Record<string, AccountUsage> }> =>
  req(`/api/openrouter/usage${force ? '?force=true' : ''}`)
export const getOpenRouterUsagePeek = (): Promise<UsagePeek> =>
  req('/api/openrouter/usage/peek')
/** every stored OpenRouter key's last reading by its id (`openrouter-N`).
 *  Cache-only: the engine's
 *  usage loop reads the keys and pushes `openrouter_keys_usage`. */
export const getOpenRouterKeysUsage = (): Promise<Record<string, AccountUsage & { name?: string }>> =>
  req('/api/openrouter/keys/usage')
// usage history (docket track-usage-over-time-and-show-usage-analytics,
// phase 2): what the engine recorded over a period, downsampled per series in
// the database — at most ~300 buckets a series, never the raw table
export type UsageHistoryRange = '24h' | '7d' | '30d' | '90d'
export interface UsageHistoryBucket {
  n: number
  /** the first and last reading's time in the bucket */
  t0: string
  t1: string
  first: number | null
  last: number | null
  min: number | null
  max: number | null
  avg: number | null
}
export interface UsageHistorySeries {
  account: string
  account_label: string
  provider: string
  /** the allowance window (session, weekly_all, credits, spend, …) */
  window: string
  group: string
  /** the model scope of a scoped window; '' = every model */
  model: string
  /** percent of the allowance used, or an amount in `unit` */
  kind: 'percent' | 'amount'
  unit: string | null
  label: string | null
  latest: { observed_at: string; used_pct: number | null; amount: number | null; resets_at: string | null }
  points: UsageHistoryBucket[]
}
export interface UsageHistoryReset {
  at: string
  account: string
  window: string
  group: string
  model: string
  used_pct: number | null
  amount: number | null
  resets_at: string | null
  prev_pct: number | null
  prev_amount: number | null
  prev_resets_at: string | null
}
/** an account's availability CHANGED at `at` (only the changes are sent) */
export interface UsageHistoryState {
  account: string
  account_label: string
  provider: string
  at: string
  state: 'ok' | 'unavailable' | 'unsupported' | 'stale' | 'inferred'
  detail: string | null
}
export interface UsageHistory {
  range: UsageHistoryRange
  since: string
  until: string
  bucket_s: number
  retain_days: number
  /** an unchanged series is re-recorded this often */
  keepalive_min: number
  /** the oldest reading kept at all, or null on a new install */
  oldest: string | null
  series: UsageHistorySeries[]
  resets: UsageHistoryReset[]
  states: UsageHistoryState[]
  /** a cap cut the answer short */
  truncated: boolean
}
export const getUsageHistory = (range: UsageHistoryRange): Promise<UsageHistory> =>
  req(`/api/usage/history?range=${range}`)
// ---- machine-local account routing (user redesign 2026-08-25) ----------
// The primary row is the machine's own login; `keys` are pasted
// `claude setup-token` fallbacks. NO token material in any response — a key
// crosses the wire once, inward, and everything after speaks in row ids.
// the LEGACY readout moved to its own path (2026-09-10): GET /api/accounts
// belongs to the account REGISTRY list the accounts section actually renders
export const getAccounts = (): Promise<AccountsPayload> => req('/api/accounts/readout')
// ⚠ STORE FIRST. The CLI shows a minted token exactly once, so the server
// writes it before anything can reject it — do not add client-side format
// validation that could swallow the only copy the user will ever have.
export const addAccountKey = (token: string, mint_config_dir?: string): Promise<AccountsPayload> =>
  req('/api/accounts/keys', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, ...(mint_config_dir ? { mint_config_dir } : {}) }),
  })
// ⚠ Irreversible: the CLI cannot show a token again — re-adding = re-minting.
export const deleteAccountKey = (id: string): Promise<AccountsPayload> =>
  req(`/api/accounts/keys/${encodeURIComponent(id)}`, { method: 'DELETE' })
export const setAccountKeyOrder = (keys: string[]): Promise<AccountsPayload> =>
  req('/api/accounts/order', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keys }),
  })
// the symmetric account REGISTRY list (multi-account D5) — every registered
// account with standing, placements and the `ambient` host-board flag
export const getAccountRegistry = (): Promise<AccountRegistryPayload> =>
  req('/api/accounts')
// a registry account's OWN usage (its lane, never the ambient one). The
// force bypasses the reader's ordinary cache; server cooldown/scope rules stay
// authoritative, as for the native provider readers.
export const getRegisteredAccountUsage = (
  id: string, force = false,
): Promise<RegisteredAccountUsage> =>
  req(`/api/accounts/${encodeURIComponent(id)}/usage${force ? '?force=true' : ''}`)
// one account's usage bars — "primary" or a key row id
export const getAccountUsage = (account: string): Promise<AccountUsage> =>
  req(`/api/accounts/usage/${encodeURIComponent(account)}`)
// every account's usage bars, primary first (the header modal's list)
export const getUsageAll = (): Promise<UsageAllPayload> =>
  req('/api/accounts/usage')

export const getDefaults = (): Promise<DefaultsPayload> =>
  req('/api/defaults')
export const saveDefaults = (body: SettingsRequest): Promise<DefaultsPayload> =>
  req('/api/defaults', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
// F-06: the org mailbox itself, fetched when the panel OPENS. The tree
// payload carries only a preview (see TreePayload['org_inbox']).
export const getOrgInbox = (slug: string): Promise<{
  entries: OrgInboxEntry[]; total: number; unread: number
}> => req(`/api/orgs/${slug}/org_inbox`)
export const orgInboxRead = (slug: string): Promise<{ ok: boolean }> =>
  req(`/api/orgs/${slug}/org_inbox/read`, { method: 'POST' })
export interface UploadProgress { sent: number; total: number; phase: 'preparing' | 'uploading' | 'confirming' }
export interface UploadOptions { draft?: string; signal?: AbortSignal; progress?: (value: UploadProgress) => void }
// F-06: the network-identity reveal — loopback admin only; the ONE call that
// returns the org secret (the settings panel's reveal/export)
export const getOrgNet = (slug: string): Promise<OrgNetReveal> =>
  req(`/api/orgs/${slug}/net`)
export interface OrgPicture { revision: string; sha256: string | null; width: number; height: number; bytes: number; data: string | null }
export interface OrgPictureCrop { x: number; y: number; size: number }
export const getOrgPicture = (slug: string): Promise<{ owner: number; picture: OrgPicture | null }> =>
  req(`/api/orgs/${slug}/profile-picture`)
export const previewOrgPicture = (slug: string, data: string): Promise<{ data: string; width: number; height: number }> =>
  req(`/api/orgs/${slug}/profile-picture/preview`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data }) })
export const setOrgPicture = (slug: string, owner: number, data: string | null, crop?: OrgPictureCrop): Promise<OrgPicture> =>
  req(`/api/orgs/${slug}/profile-picture`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ owner, data, crop }) })
// F-06: is a hub reachable at this address right now? (a HINT — the
// checkbox never gates on it; a hub that is down still gets configured)
export const probeHub = (
  address = '',
): Promise<{ ok: boolean; name?: string | null; address?: string }> =>
  req(`/api/net/probe${address ? `?address=${encodeURIComponent(address)}` : ''}`)
export const saveScope = (slug: string, nid: string, scope: ScopeRequest): Promise<OpResult> =>
  staleAfter(slug, req(`/api/orgs/${slug}/nodes/${nid}/scope`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(scope),
  }))
export const reorderNode = (
  slug: string, nid: string, body: ReorderRequest,
): Promise<OpResult> =>
  req(`/api/orgs/${slug}/nodes/${nid}/reorder`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
export const getEvents = (slug: string, last?: number): Promise<EventsPayload> =>
  // the record tab renders a recent slice, so it asks for one — the bare
  // form used to make the server materialize and ship the ENTIRE event log
  // (19k rows / 357 ms measured) every 5 s poll while the tab was up. An
  // ACTIVE SEARCH passes no `last`: its filter has always looked at the
  // whole record, and a bounded fetch would silently hide older matches
  // (perf-review round 2).
  req(`/api/orgs/${slug}/events${last ? `?last=${last}` : ''}`)
export const retractMail = (
  slug: string, nid: string, mid: string,
): Promise<{ retracted: string }> =>
  req(`/api/orgs/${slug}/nodes/${nid}/mail/${mid}`, { method: 'DELETE' })
export const uploadFile = (slug: string, nid: string, file: File, signal?: AbortSignal): Promise<UploadResult> =>
  // a large file over a slow link legitimately outlasts the default ceiling
  req<UploadResult>(`/api/orgs/${slug}/nodes/${nid}/upload?name=${encodeURIComponent(file.name)}`, {
    method: 'POST', body: file, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(SLOW_TIMEOUT_MS)]) : undefined,
  }, SLOW_TIMEOUT_MS)
// direct <a href> download target (browser handles the transfer)
export const fileBase = (slug: string, nid: string): string =>
  `/api/orgs/${slug}/nodes/${nid}/file?path=`
export const fileUrl = (slug: string, nid: string, path: string): string =>
  fileBase(slug, nid) + encodeURIComponent(path)
export const sendMessage = (
  slug: string, nid: string, text: string, attachments?: string[],
  replyTo?: { id?: string; from: string; at?: string; gist: string } | MailReplyWire,
  clientOp?: string,
  notice?: boolean,
  replies?: MailReplyWire[],
  targets?: ReplyTarget[],
  urgency?: { urgent: true; urgent_reason?: string },
): Promise<SendMessageResult> =>
  req(`/api/orgs/${slug}/nodes/${nid}/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text,
      ...(urgency ?? {}),
      ...(attachments?.length ? { attachments } : {}),
      // FR-05: an inline mailbox reply carries a snapshot of what it answers
      ...(replyTo ? { reply_to: replyTo } : {}),
      ...(replies?.length ? { replies } : {}),
      ...(targets?.length ? { targets } : {}),
      // the composer's pre-send name for this submission — the ghost carries
      // the same value, so the durable copy is recognizable by identity in
      // the first payload that shows it (see PendingMail.client_op)
      ...(clientOp ? { client_op: clientOp } : {}),
      ...(notice ? { notice: true } : {}) }),
  })
/** The project desk's message box (user 2026-10-18 07:33Z): one send to every
 *  live agent under the project, nested projects included; each recipient's
 *  outcome comes back. */
export interface BroadcastResult {
  accepted: boolean; project: string; notice: boolean
  sent: { to: string; id: string; delivery: string; deferred: boolean }[]
  refused: { to: string; why: string }[]
  /** the project's audience to the user, granted after delivery (null: none applied) */
  audience_grant?: AudienceGrantResult | null
}
/** A user send to a project grants it the user's audience after delivery; a
 *  failed grant leaves the mail delivered. */
export interface AudienceGrantResult { granted: boolean; error?: string }
export const broadcastMessage = (slug: string, project: string, text: string, attachments?: string[],
  notice?: boolean, urgency?: {urgent:true;urgent_reason?:string}, targets?: ReplyTarget[]): Promise<BroadcastResult> =>
  req(`/api/orgs/${slug}/nodes/${project}/broadcast`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, ...(urgency ?? {}), ...(attachments?.length ? { attachments } : {}),
      ...(notice ? { notice: true } : {}), ...(targets?.length ? { targets } : {}) }),
  })
/** Object identity only; the server resolves authoritative reply context. */
export const replyMessage = (slug: string, nid: string, text: string, target: ReplyTarget | ReplyTarget[],
  attachments?: string[], clientOp?: string, notice?: boolean): Promise<SendMessageResult> =>
  req(`/api/orgs/${slug}/nodes/${nid}/message`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, ...(Array.isArray(target) ? { targets: target } : { target }),
      ...(attachments?.length ? { attachments } : {}),
      ...(clientOp ? { client_op: clientOp } : {}),
      ...(notice ? { notice: true } : {}) }),
  })
export const getOrgAccounts = (slug: string): Promise<{ org: string; accounts: OrgAccountLane[] }> =>
  req(`/api/orgs/${slug}/accounts-allowed`)
export const saveSettings = (slug: string, opts: SettingsRequest = {}): Promise<SettingsResult> =>
  req(`/api/orgs/${slug}/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(opts),
  })
export const saveHireDefaults = (
  slug: string, opts: HireDefaultsRequest = {},
): Promise<OpResult> =>
  req(`/api/orgs/${slug}/defaults`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(opts),
  })

/* This window's id on the org websocket (`?win=`), so the engine can count one
   window's reconnects across its sockets for the Developer › engine debug
   view. Per window, kept across reloads in sessionStorage; purely a label. */
export const WINDOW_ID: string = (() => {
  const fresh = (): string => Math.random().toString(36).slice(2, 10)
  try {
    const have = sessionStorage.getItem('orgtree-window-id')
    if (have) return have
    const id = fresh()
    sessionStorage.setItem('orgtree-window-id', id)
    return id
  } catch { return fresh() }
})()

export function openWs(
  slug: string,
  onChanged: (ev: MessageEvent) => void,
  onClose?: () => void,
  onOpen?: () => void,
): WebSocket {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  const ws = new WebSocket(
    `${proto}://${location.host}/api/orgs/${slug}/ws?win=${encodeURIComponent(WINDOW_ID)}`)
  ws.onmessage = onChanged
  ws.onopen = () => onOpen?.()
  const ping = setInterval(() => { if (ws.readyState === 1) ws.send('ping') }, 25000)
  ws.onclose = () => { clearInterval(ping); onClose?.() }
  return ws
}

/* Developer › engine debug view: one cheap read of counters the engine keeps
   (api.py `engine_stats`), polled about once a second while the view is on. */
export interface EngineSocketStats {
  org: string; window: string
  pending: number; pending_bytes: number; sent: number; sent_bytes: number
  age_s: number; window_connects: number; window_drops: number
}
export interface EngineStats {
  at: number; pid: number
  memory: { private_bytes: number | null; rss_bytes: number | null }
  websockets: {
    queue_max: number; send_timeout_s: number
    drops: Record<string, number>
    sockets: EngineSocketStats[]
  }
  work_list: {
    full_200: number; not_modified_304: number; bytes_200: number; window_s: number
    cached_bodies: number; cached_bytes: number; cache_idle_s: number
  }
  lazy_rows?: {
    enabled: boolean; epoch: string | null
    counts: Record<string, number>
    stale_epoch_orgs: string[]
    recent_fallbacks: { why: string; stack: string[] }[]
  }
}
export const getEngineStats = (): Promise<EngineStats> =>
  req('/api/diagnostics/engine-stats', undefined, 5000)

export const documentDownloadUrl = (slug: string, id: string): string =>
  `/api/orgs/${encodeURIComponent(slug)}/documents/${encodeURIComponent(id)}/download`

export interface TransferFile {
  id: string; name: string; total: number | null; processed: number; confirmed: number
  complete?: boolean; restart_reason?: string | null
}
export interface MailTransfer extends Partial<TransferFile> {
  id: string; direction: 'upload' | 'download'; message_id: string; peer: string
  state: string; error?: string | null; attempt: number; files?: TransferFile[]
}
export const getMailTransfers = (slug: string, agent?: string, signal?: AbortSignal, cursor?: string): Promise<{transfers: MailTransfer[]; next_cursor: string | null}> =>
  req(`/api/orgs/${slug}/transfers?${new URLSearchParams({...agent ? {agent} : {}, ...cursor ? {cursor} : {}})}`, {signal})
export const changeMailTransfer = (slug: string, id: string, action: 'retry' | 'cancel' | 'remove'): Promise<{transfers: MailTransfer[]}> =>
  req(`/api/orgs/${slug}/transfers/${encodeURIComponent(id)}`, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action})})
