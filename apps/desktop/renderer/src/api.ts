import type { EventReplyWire } from './eventReply'
import type { ReplyTarget } from './generated/events'
// kiosk v2: when the SPA is served from a preauthenticated public URL
// (/k/<token>/…), every API call and the WS must carry the token prefix —
// the public listener serves nothing outside it.
import { bumpLive } from './livebus'
import { backendRestart } from './windowlife'
import type {
  AudiencesPayload, ChartersPayload, ChatPayload, DefaultsPayload,
  DiskDeleteResult, DiskDirPayload, DiskPayload, EventsPayload, FsPayload,
  HireDefaultsRequest, HistoryPayload, HostPayload,
  InboxPayload, KioskCfgRequest, KioskSaveResult, MailEntry,
  McpServersPayload, OpenRouterDoc, OpenRouterModelsPage, OpenRouterSort,
  OpRequest, OpResult, OrgListEntry, OrgMdPayload,
  OrgInboxEntry, OrgNetReveal, ProvidersPayload, ReorderRequest,
  RuntimeSettingsPayload,
  ScopeRequest, ScratchPayload,
  SendMessageResult,
  SettingsRequest, SettingsResult, SweepPreview, SweepResult, TreePayload,
  AccountsPayload, AccountUsage, UsageAllPayload,
  UploadResult, UsagePayload, UsagePeek,
  WorkItemsPayload, WorkItemPayload, WorkItemReplyResult, DismissAttentionResult,
} from './types'

// Desktop uses the private engine origin; public token routes are excluded.
export const BASE: string = ''
const u = (p: string) => BASE + p

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
  const id = r.headers.get('X-Orgtree-Instance')
  if (!id) return
  if (!instance) { instance = id; return }
  if (id === instance) return
  // The window lifecycle coordinator offers an explicit choice when a
  // detached form could be lost. A deferred choice stays latched.
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

// the one wire-boundary cast in the app: runtime JSON is untyped, and each
// endpoint's declared Promise<T> return type is the contract that types it.
// T infers from that declared return at every call site - no `any` escapes.
export const req = <T,>(path: string, init?: RequestInit,
                 timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<T> =>
  fetch(u(path), init?.signal || !timeoutMs
    ? init
    : { ...init, signal: timeoutSignal(timeoutMs) }).then((r) => {
    // before the ok/not-ok split: a restart is worth noticing even when the
    // call it rode in on failed
    noteInstance(r)
    if (!r.ok) {
      return r.json().then((b: { detail?: string }) => {
        throw new Error(b.detail || r.statusText)
      })
    }
    // the client's G2 (see livebus.ts): every successful mutation THIS tab
    // makes wakes every mounted polled surface — centrally, so no call site
    // has to remember a refetch and none can be forgotten
    if ((init?.method ?? 'GET') !== 'GET') bumpLive()
    return r.json() as Promise<T>
  })

export const listOrgs = (): Promise<OrgListEntry[]> => req('/api/orgs')
export const createOrg = (
  name: string, dirs: string[],
  netAutoconnect = true, netHubs: string[] = [],
): Promise<{ slug: string }> =>
  req<{ slug: string }>('/api/orgs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name, dirs,
      // F-06: mailserver — local-hub opt-out + typed remote addresses
      ...(netAutoconnect ? {} : { net_autoconnect: false }),
      ...(netHubs.length ? { net_hubs: netHubs } : {}),
    }),
  }, SLOW_TIMEOUT_MS)
export const getTree = (slug: string): Promise<TreePayload> =>
  req(`/api/orgs/${slug}`)
export const deleteOrg = (slug: string): Promise<{ ok: boolean }> =>
  req(`/api/orgs/${slug}`, { method: 'DELETE' })
export const runOp = (slug: string, body: OpRequest): Promise<OpResult> =>
  req(`/api/orgs/${slug}/ops`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

export const getChat = (slug: string, nid: string, last?: number): Promise<ChatPayload> =>
  req(`/api/orgs/${slug}/nodes/${nid}/chat${last ? `?last=${last}` : ''}`)
export const getMcpServers = (): Promise<McpServersPayload> =>
  req('/api/mcp-servers')
export const getCharters = (): Promise<ChartersPayload> =>
  req('/api/charters')
// Seed ~/.orgtree/charters from the bundled presets; never overwrites a
// user file, so calling it again is safe. Ran when onboarding completes.
export const populateCharters = (): Promise<{ dir: string; created: string[]; existing: string[] }> =>
  req('/api/charters/populate', { method: 'POST' })
export const getFs = (path = ''): Promise<FsPayload> =>
  req(`/api/fs?path=${encodeURIComponent(path)}`)
export const getInbox = (slug: string): Promise<InboxPayload> =>
  req(`/api/orgs/${slug}/inbox`)
export const getNodeInbox = (slug: string, nid: string): Promise<InboxPayload> =>
  req(`/api/orgs/${slug}/nodes/${nid}/inbox`)
/** ONE message, by id, from the box that holds it.
 *
 * ⚠ ASKED ONLY WHEN A REFERENCE LANDS OUTSIDE THE LOADED WINDOW. Every box
 * route returns a slice, so "not in what I am holding" is not the same fact
 * as "not there" — and the reading pane used to state the second when it
 * only knew the first. This is the exact question; it is not a bigger poll. */
export const getMailById = (slug: string, box: 'user' | 'org' | 'node',
                            id: string, node?: string):
  Promise<{ found: boolean; mail: MailEntry | null }> =>
  req(`/api/orgs/${slug}/mail/${box}/${encodeURIComponent(id)}`
    + (node ? `?node=${encodeURIComponent(node)}` : ''))
export const resumeFrozen = (slug: string): Promise<{ resumed: string[] }> =>
  req(`/api/orgs/${slug}/resume`, { method: 'POST' })
export const killAll = (slug: string): Promise<{
  interrupted: string[]
  watchdogs_paused?: Array<{ id: string; name: string; owner: string }>
}> =>
  req(`/api/orgs/${slug}/killswitch`, { method: 'POST' })
export const dissolveAll = (slug: string): Promise<{ freed: number; nodes: number }> =>
  req(`/api/orgs/${slug}/dissolve-all`, { method: 'POST' })
export const interruptNode = (
  slug: string, nid: string,
): Promise<{ interrupted: boolean; reason?: string }> =>
  req(`/api/orgs/${slug}/nodes/${nid}/interrupt`, { method: 'POST' })
export const processControl = (
  slug: string, nid: string, action: 'start' | 'stop',
): Promise<{ ok: boolean; action: 'start' | 'stop'; already?: boolean;
  paused: boolean; proc_warm: boolean; proc_live: boolean; killed?: boolean }> =>
  req(`/api/orgs/${slug}/nodes/${nid}/process`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action }),
  })
export const compactNode = (slug: string, nid: string): Promise<{ started: boolean }> =>
  req(`/api/orgs/${slug}/nodes/${nid}/compact`, { method: 'POST' })
/** ⭐ the user's per-node override (ruling 2026-08-06): releases EVERY lock
 *  holding the agent — any freeze kind, limit_locked, the org fable_lock if
 *  last holder — and re-drives it */
export const unstickNode = (slug: string, nid: string):
  Promise<{ released: string[]; status?: string; warnings?: string[] }> =>
  req(`/api/orgs/${slug}/nodes/${nid}/unstick`, { method: 'POST' })
export const removeReplyEvents = (slug: string, nid: string): Promise<{ removed: number }> =>
  req(`/api/orgs/${encodeURIComponent(slug)}/nodes/${encodeURIComponent(nid)}/reply-events`, { method: 'DELETE' })
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
): Promise<{ id: string; name: string; state: string }> =>
  req(`/api/orgs/${slug}/watchdogs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, action }),
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
// FR-03: presented documents — the reader fetches the body on open
export const getDocument = (slug: string, did: string):
  Promise<{ id: string; node: string; title: string; body: string; at: string; format?: 'markdown' | 'html'; bytes?: number }> =>
  req(`/api/orgs/${slug}/documents/${did}`)
/** A stable operator-only HTML preview; content isolation is server-enforced. */
export const mockupUrl = (slug: string, did: string): string =>
  u(`/api/orgs/${encodeURIComponent(slug)}/documents/${encodeURIComponent(did)}/mockup`)
// the gallery (user request 2026-09-03): every card, org-wide, newest first —
// metadata only (no body; the reader fetches that on open). `evicted` rows
// are cards the retention prune dropped whose log line survives — no body to
// fetch, but still findable rather than silently gone.
export interface DocRow {
  id: string; node: string; title: string; at: string
  format?: 'markdown' | 'html'
  bytes?: number
  evicted: boolean; node_state: 'live' | 'archived' | 'unrecoverable' | 'deleted'
  /** the presenting agent's model, for the row's tier chip. Served from the
   *  ledger rather than looked up client-side: the gallery lists cards from
   *  agents the tree walk does not carry. Null once the node is gone. */
  tier?: string | null
}
export const getDocuments = (slug: string, offset = 0, node = ''): Promise<{ documents: DocRow[]; total: number; next_offset: number | null }> =>
  req(`/api/orgs/${slug}/documents?offset=${offset}&node=${encodeURIComponent(node)}`)
export const dismissDocument = (slug: string, did: string):
  Promise<{ ok: boolean; node: string }> =>
  req(`/api/orgs/${slug}/documents/${did}`, { method: 'DELETE' })
// LOCKED docket wire contract v3 (luna-reserve/evidence/docket-wire-
// contract-v3.md) — see types.ts's "work docket" section.
export const getWorkItems = (slug: string, archived = false,
                             backlogged = false): Promise<WorkItemsPayload> =>
  req(`/api/orgs/${slug}/work-items`
    + (archived || backlogged
      ? '?' + [archived ? 'archived=1' : '', backlogged ? 'backlogged=1' : '']
        .filter(Boolean).join('&')
      : ''))
export const getWorkItem = (slug: string, id: string): Promise<WorkItemPayload> =>
  req(`/api/orgs/${slug}/work-items/${id}`)
export const replyWorkItem = (slug: string, id: string, body: string, to?: string):
  Promise<WorkItemReplyResult> =>
  req(`/api/orgs/${slug}/work-items/${id}/reply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ body, ...(to !== undefined ? { to } : {}) }),
  })
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
export const getScratch = (slug: string, nid: string, path = ''): Promise<ScratchPayload> =>
  req(`/api/orgs/${slug}/nodes/${nid}/scratch?path=${encodeURIComponent(path)}`)
export const getOrgMd = (slug: string): Promise<OrgMdPayload> =>
  req(`/api/orgs/${slug}/orgmd`)
export const putOrgMd = (
  slug: string, content: string,
): Promise<{
  path: string; bytes: number; chars?: number
  prompt_max?: number; prompt_truncated?: boolean; warnings?: string[]
}> =>
  req(`/api/orgs/${slug}/orgmd`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
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
export const getProviders = (): Promise<ProvidersPayload> => req('/api/providers')
export const setProviderEnabled = (
  provider: string, enabled: boolean,
): Promise<ProvidersPayload> =>
  req(`/api/providers/${encodeURIComponent(provider)}/enabled`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
  })
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
export const getRuntimeSettings = (): Promise<RuntimeSettingsPayload> =>
  req('/api/app-settings/runtime')
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
export const getUsage = (force = false): Promise<UsagePayload> =>
  req(`/api/usage${force ? '?force=true' : ''}`)
// cache-only — the glow polls this; only the modal above may cost a fetch
export const getUsagePeek = (): Promise<UsagePeek> => req('/api/usage/peek')
export const getCodexUsage = (force = false): Promise<AccountUsage> =>
  req(`/api/codex/usage${force ? '?force=true' : ''}`)
// cache-only, like the Claude peek above
export const getCodexUsagePeek = (): Promise<UsagePeek> => req('/api/codex/usage/peek')
// the Antigravity standing is OBSERVED from turns (the CLI has no readout),
// so both doors are cache-only; the modal one still owns the install/sign-in
// wording and the always-on glow polls the bare peek
export const getAntigravityUsage = (_force = false): Promise<AccountUsage> =>
  req('/api/antigravity/usage')
export const getAntigravityUsagePeek = (): Promise<UsagePeek> =>
  req('/api/antigravity/usage/peek')
// OpenRouter: a prepaid credit balance read off the stored key's
// `GET /api/v1/key`, cached 60s server-side — the modal costs a fetch, the
// glow polls the cache-only peek
export const getOpenRouterUsage = (force = false): Promise<AccountUsage> =>
  req(`/api/openrouter/usage${force ? '?force=true' : ''}`)
export const getOpenRouterUsagePeek = (): Promise<UsagePeek> =>
  req('/api/openrouter/usage/peek')
// ---- machine-local account routing (user redesign 2026-08-25) ----------
// The primary row is the machine's own login; `keys` are pasted
// `claude setup-token` fallbacks. NO token material in any response — a key
// crosses the wire once, inward, and everything after speaks in row ids.
export const getAccounts = (): Promise<AccountsPayload> => req('/api/accounts')
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
// F-06: the user composes extern mail from the mailbox UI (admin only)
export const orgInboxSend = (
  slug: string, to: string, body: string, attachments: string[] = [],
): Promise<{ id: string; warnings: string[] }> =>
  req(`/api/orgs/${slug}/org_inbox/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ to, body, attachments }),
  })
export const orgInboxUpload = (
  slug: string, file: File,
): Promise<{ id: string; name: string; bytes: number }> =>
  req(`/api/orgs/${slug}/org_inbox/upload?name=${encodeURIComponent(file.name)}`, {
    method: 'POST', body: file,
  })
// F-06: the network-identity reveal — loopback admin only; the ONE call that
// returns the org secret (the settings panel's reveal/export)
export const getOrgNet = (slug: string): Promise<OrgNetReveal> =>
  req(`/api/orgs/${slug}/net`)
// F-06: is a hub reachable at this address right now? (a HINT — the
// checkbox never gates on it; a hub that is down still gets configured)
export const probeHub = (
  address = '',
): Promise<{ ok: boolean; name?: string | null }> =>
  req(`/api/net/probe${address ? `?address=${encodeURIComponent(address)}` : ''}`)
export const saveScope = (slug: string, nid: string, scope: ScopeRequest): Promise<OpResult> =>
  req(`/api/orgs/${slug}/nodes/${nid}/scope`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(scope),
  })
export const reorderNode = (
  slug: string, nid: string, body: ReorderRequest,
): Promise<OpResult> =>
  req(`/api/orgs/${slug}/nodes/${nid}/reorder`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
export const getEvents = (slug: string): Promise<EventsPayload> =>
  req(`/api/orgs/${slug}/events`)
export const retractMail = (
  slug: string, nid: string, mid: string,
): Promise<{ retracted: string }> =>
  req(`/api/orgs/${slug}/nodes/${nid}/mail/${mid}`, { method: 'DELETE' })
export const uploadFile = (slug: string, nid: string, file: File): Promise<UploadResult> =>
  // a large file over a slow link legitimately outlasts the default ceiling
  req<UploadResult>(`/api/orgs/${slug}/nodes/${nid}/upload?name=${encodeURIComponent(file.name)}`, {
    method: 'POST', body: file,
  }, SLOW_TIMEOUT_MS)
// direct <a href> download target (browser handles the transfer) — BASE-aware
// so kiosk visitors download through their token prefix
export const fileBase = (slug: string, nid: string): string =>
  u(`/api/orgs/${slug}/nodes/${nid}/file?path=`)
export const fileUrl = (slug: string, nid: string, path: string): string =>
  fileBase(slug, nid) + encodeURIComponent(path)
export const sendMessage = (
  slug: string, nid: string, text: string, attachments?: string[],
  replyTo?: { id?: string; from: string; at?: string; gist: string } | EventReplyWire,
): Promise<SendMessageResult> =>
  req(`/api/orgs/${slug}/nodes/${nid}/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text,
      ...(attachments?.length ? { attachments } : {}),
      // FR-05: an inline mailbox reply carries a snapshot of what it answers
      ...(replyTo ? { reply_to: replyTo } : {}) }),
  })
/** Object identity only; the server resolves authoritative reply context. */
export const replyMessage = (slug: string, nid: string, text: string, target: ReplyTarget): Promise<SendMessageResult> =>
  req(`/api/orgs/${slug}/nodes/${nid}/message`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, target }),
  })
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
export const saveKiosk = (slug: string, opts: KioskCfgRequest = {}): Promise<KioskSaveResult> =>
  req(`/api/orgs/${slug}/kiosk`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(opts),
  })

// the org-disk recovery browser (its own surface, deliberately not /api/fs)
export const getDisk = (slug: string, offset = 0, limit = 200): Promise<DiskPayload> =>
  req(`/api/orgs/${slug}/disk?offset=${offset}&limit=${limit}`)
export const diskDelete = (slug: string, paths: string[]): Promise<DiskDeleteResult> =>
  req(`/api/orgs/${slug}/disk/delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ paths }),
  })
export interface DiskResizeResult {
  size_mb: number
  pending_mb: number | null
  used?: number | null
  total?: number | null
}
// grow applies online immediately (and clears any pending shrink); a shrink
// stages a PENDING request applied when the org's container is next down
export const diskResize = (slug: string, size_mb: number): Promise<DiskResizeResult> =>
  req(`/api/orgs/${slug}/disk/resize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ size_mb }),
  })
export const diskResizeCancel = (slug: string): Promise<DiskResizeResult> =>
  req(`/api/orgs/${slug}/disk/resize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cancel: true }),
  })
export const diskResizeApply = (slug: string): Promise<DiskResizeResult> =>
  req(`/api/orgs/${slug}/disk/resize/apply`, { method: 'POST' })
export const getDiskDir = (slug: string, path = ''): Promise<DiskDirPayload> =>
  req(`/api/orgs/${slug}/disk/dir?path=${encodeURIComponent(path)}`)
export const getSweepPreview = (slug: string): Promise<SweepPreview> =>
  req(`/api/orgs/${slug}/sweep-legacy`)
export const sweepLegacy = (slug: string): Promise<SweepResult> =>
  req(`/api/orgs/${slug}/sweep-legacy`, { method: 'POST' })
export const diskFileUrl = (slug: string, path: string): string =>
  u(`/api/orgs/${slug}/disk/file?path=${encodeURIComponent(path)}`)

export function openWs(
  slug: string,
  onChanged: (ev: MessageEvent) => void,
  onClose?: () => void,
): WebSocket {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  const ws = new WebSocket(`${proto}://${location.host}${BASE}/api/orgs/${slug}/ws`)
  ws.onmessage = onChanged
  const ping = setInterval(() => { if (ws.readyState === 1) ws.send('ping') }, 25000)
  ws.onclose = () => { clearInterval(ping); onClose?.() }
  return ws
}

export const documentDownloadUrl = (slug: string, id: string): string =>
  u(`/api/orgs/${encodeURIComponent(slug)}/documents/${encodeURIComponent(id)}/download`)
