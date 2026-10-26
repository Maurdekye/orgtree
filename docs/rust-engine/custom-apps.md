# Custom apps and saved panels (4.5.0)

## Org access and agent window boundary

Created, imported, template-restored and existing apps have implicit access to
this org through org.read, mail.send, events.fire and docket.write, and read/write
access to this org's scratch, uploads and exact retained-delivery files. These
defaults do not depend on older capability declarations. Event names still need
declarations. Explicit user Ask or Deny overrides the default; Deny wins over
temporary, remembered and implicit file authority. Code replacement preserves
restrictive Ask/Deny choices while clearing external grants and old host sessions.
Native Permissions displays effective defaults separately from stored choices.

Import warns that apps from outside this org have full access to the org and its
state, and that untrustworthy apps are dangerous. Authority is derived locally;
exported permissions, paths and references never grant it. The user accepts that
an app created by a subagent can affect a superior's state, as terminal access can.
App-origin content still has no user instruction or approval authority.

Agent panel_open with an app ID always creates a fresh CLOSED saved panel;
panel-ID reopen and panel_update open:true refuse. Agent duplicates stay closed.
Placement edits may change a closed copy but cannot expose/move an already-open
window. Only user UI opens windows. State and events remain usable while
closed. Hidden runtime start/stop is a separate lifecycle feature, never a right
to show a window.

Org-file create/replace/delete commits without per-change confirmation through
the existing pinned, revision-checked staged IO path. This never applies to an
outside target covered by a chosen-folder or whole-computer grant. Those scopes
still require native consent and every change requires native confirmation.
Direct agent file tools also require current org-modifying tools, held folders
and edit/RW scope for writes. App defaults never expand the caller's folders.
Retained artifacts means exact catalog entries, not their parent directories.

Migration0066 stores app origin and marks engine-owned implicit orgtree grant
rows. Their stable per-app/code/mode IDs preserve panel-bound references across
restart without storing a user Allow. Current Deny and org membership are checked
on every use; these rows do not count as explicit external grants. Metadata adds
default_permissions while permissions remains the stored override map.


## Durable declared event delivery

Apps privacy begins before logged agent adapters (MCP, direct tool, Codex and
the test-only rig transport), not merely inside the Apps domain handler. This
also protects read results and reflected refusals; ordinary tools retain normal
diagnostics. Independent dispatch tasks establish their own private scope.

`orgtree_apps fire_event` takes a saved `panel`, exact declared `name` and JSON
`payload` (64 KiB). Agents publish with org-modifying tools; a closed copy is
valid. HTML uses its bound `events.fire` action with no recipient or caller
selector. Migration0063 removes previous target-specific events.fire decisions;
broadcast uses effective defaults/overrides. Definition replacement
revokes external grants and sessions but preserves restrictive user choices. The shared60/minute execution budget survives host closure.

An agent creates `orgtree_watchdog kind=app_listener target=<stable app ID>`
with `event_name` and either one `panel` or explicit `all_panels:true`. Its
current live owner needs watchdog and Apps tools. Overlapping registrations for
the same owner/event are refused. Creator identity confers no right.
Pause/resume/remove, once, notice and explicit fire_actions keep watchdog meaning.
App deletion, removed declarations and specific panel deletion pause affected
registrations with a reason; returning sources do not silently rearm them.
Subscriptions/actions never travel in templates or portable bundles.

Publication locks the app and snapshots armed matching watchdog IDs atomically.
Provisional bounds:4096 registrations/app,128 pending fires/app, retained latest
128 completed fires. Overflow refuses before acceptance; zero subscribers is an
accepted zero-listener result. A listener added or resumed after the snapshot
cannot join that fire. Each recipient transaction locks one owner's ancestry
root-first, then app and watchdog, and rechecks live owner/tools/state/source.
Mail, one-shot spend and durable delivery are committed together. Actions are
claimed durably before execution (an uncertain crash may skip one, never repeat
it). No app gate or database connection spans nested action execution. The
shutdown-bound dispatcher recovers pending work and caps concurrent app drains
at four. Mail uniqueness is event×listener; diagnostics contain metadata only.
Authorized mail retains JSON and server-derived org/app/panel/event/time/producer
provenance. App content is not user instruction or approval. `listeners` lists
registrations in bounded pages. Each accepted fire also appends a metadata-only
`event.fired` row (`{event,id,subscribers}`, actor user/agent/app) to that copy's
bounded panel log inside the publishing transaction, after the app row lock. The
payload never enters that log, and the host does not relay the row into the app
(USER2026-10-26 mc8711410a925, History tab).

By the user's2026-10-26 ruling, docket.write create/assign/wake remains the
documented edge case that wakes a selected local agent without an app event.

Native Panel settings > History shows the copy's log, lists actual scoped
connections with bounded cursor paging, permits explicit user Fire event from that
saved copy and displays acceptance/backpressure without automatic retries.
Agent parity is Apps listeners/fire_event; agent subscription ownership stays
in watchdog controls. SDK orgtree.events.fire forwards only name/payload to
the existing parent-only action client. The native broadcast prompt explicitly
identifies every-listener delivery; no recipient/caller selector is accepted.

## Named event declarations

Migration0062 adds `custom_apps.declared_events`, defaulting to an empty array.
Definition `events` is a portable list of strict `{name,description?}` objects;
create/update/import, full reads, catalog metadata, export and template
capture/restore preserve it. Event names are unique, exact,1–80 characters,
without surrounding whitespace or controls; descriptions allow0–1,000 characters.
The provisional catalog limit is64. Declarations contain no grants, listeners,
recipients or fire actions. Old bundles without the field remain valid.

Declarations alone create no listeners. Durable publication and effective
broadcast permission use the separate explicit paths described above; the copy's
History log remains separate. The user explicitly retains docket
create/assign/wake as the direct-wake edge case without an app event
(USER2026-10-26 m556cde76bd33).

Source ruling: USER2026-10-25, custom panels headline. An org owns app definitions;
each app has zero or more saved panels. Every panel owns an independent JSON
object. Any live agent with org-modifying tools can operate on any copy in its
current org. An app's author does not acquire user authority.

## File access (2026-10-26)

Migration0064 stores app/code-bound native read grants and panel-bound opaque
references. Files are chosen in native Orgtree UI or opened from this org's
scratch/uploads/retained-delivery catalog. Native paths never enter the iframe
SDK or portable bundles. Once grants are host-memory only; Always grants persist
in PG. Ask/Deny overrides org defaults; grant revoke/code replacement clears external authority.
Closing/hiding ends host links. Imported/duplicated state cannot reuse a file id
from another panel. Files settings live in App settings' Permissions tab.

POST apps/files requires the exact native desktop header. It accepts native
Call/Decide/Permissions/Revoke/Browse/Confirm/Confirmations; iframe methods are the fixed file SDK,
validated by parent and engine. Bounded reads allocate at most64KiB. Agent actions
file_permissions/file_open/file_read additionally require live orgmod and current
held folders, rechecked before disclosure; agents never decide grants. Orgtree
artifacts means this org's retained deliveries, not a global output directory.

Sandbox frames never receive desktop headers. Only exact GET apps/media bypasses
the general header check and independently validates a64-hex temporary asset
ticket bound to org/app/code/panel/live host/file grant. Each range revalidates;
active bodies end on cancellation or expiry. CSP adds only the exact generated
host media endpoint; connect stays none and other API paths remain blocked.
Private-app logging omits ticket queries and file/stream data. Opened handles
use the existing ancestor-pinned no-reparse IO. No PG handle/transaction spans
disk IO, native consent or playback. Media cap256MiB; no video is embedded in state.

Migration0065 adds separate read/write modes and folder/computer scopes. Existing
grants remain read-only. Native consent warns about readable data plus declared
mail.send and about whole-computer access under the current Windows user, without
elevation. A chosen folder covers descendants; links/reparse points are refused.
Read and write remain separately overridable capabilities. Grant limits128/app,
refs1024/panel, registry4096/class; prompts120s, sessions/media at most30min.

files.grant(scope,mode) requests native consent for orgtree/folder/computer and
read/write. It returns opaque directory roots; persist these in that panel's
state. files.list(directory,{after,limit}) and files.collection(root,options)
page up to200 entries, scanning at most20,000 with scan_limited disclosure.
Directory enumeration uses the opened directory handle, not path-based read_dir.
files.child(directory,relativeName) opens a descendant reference after checking
the current grant. files.write(directory,name,base64,{replace:false}) changes at
most64KiB; an existing file refuses unless replace:true. files.delete(file)
deletes a regular file only. Every outside-org create/replace/delete needs native confirmation
outside HTML of the exact target, operation, size and new-content SHA256. No
recursive delete, shell command, arbitrary endpoint or permission method exists.

Changes retain no-reparse directory/target handles while consent is pending.
The Windows target pin excludes ordinary data writes/delete. Replacements stage
and flush bytes, rename the exact old handle to a fresh recovery name, then publish
the new handle without overwriting a destination. There is a brief name gap;
a concurrent destination is never overwritten. Failure restores the original
name when possible; otherwise original bytes remain in the reported recovery
file beside the target. Native UI reports retained recovery copies, independently
of the HTML. No path-based fallback or in-place truncation exists. Platforms
without these mutation primitives refuse writes.
Pending changes are bounded64/engine, expire120s with target-pin cleanup, and are
discarded on grant/code/host revocation. Outside-org data never changes before confirmation.

Agent parity adds file_roots/file_list/file_child/file_write/file_delete/file_result. Reads
need current read folders; writes need current edit permission and writable
folders AND effective write authority for the target. The fresh scope chain includes parent
ceilings and implicit shared folders. The readable org instruction workspace is
not an implicit writable folder; writing there requires an explicit effective
RW grant. Outside-org agent changes wait in native App settings → Permissions → Files →
Pending changes; refresh shows exact target/size/hash.
Agents get a pending confirmation ID and can read their own one-shot result for
120s after a decision. They never choose roots, grant permission or confirm a
change. All callbacks recheck the saved panel/code/grant and live caller scope.

## Storage milestone

Migration0058 creates org-scoped custom_apps, custom_panels and a bounded panel
event stream. Composite foreign keys prohibit cross-org panel/app references.
Code and state are separate columns: paged catalog queries exclude both. Closing
sets open=false; it does not delete a panel. Explicit panel deletion removes its
events. App deletion refuses saved copies unless delete_panels=true.

The authenticated user route is POST /api/orgs/{slug}/apps; orgtree_apps is the
agent parity route. Both parse the same deny-unknown-fields request vocabulary.
The agent identity/org come from the trusted Caller, never JSON arguments. Agent
mutations re-read live identity and inherited tool scope under canonical
root-first scope locks, then lock app before panel. These transactions never take
the org revision lock. After commit an org custom_apps_changed frame invalidates
readers; reconnecting readers must perform a fresh bounded read.

Migration0061 adds org-owned `is_new` metadata and a partial unseen-app index.
App list pages include the org's complete `new_count`, independent of the page;
metadata includes `is_new`. Creation/import/template restoration default new,
including existing definitions at migration. Provisional self-import choice:
native user imports count too. Definition updates never reset seen status.
`mark_seen` takes1-200 unique explicit app IDs. It locks matches in ID order,
ignores unknown/deleted/other-org IDs, and returns seen IDs plus the remaining
count. It requires ordinary Apps scope, grants no authority, changes no app/panel
revision and emits the existing invalidation only after a committed change.
GET refuses it. User and agent operations share this contract.

The menu acknowledges only intersecting entries in its owning scroll viewport,
keeping New labels for that visit. Background catalog loads acknowledge nothing.
The header reuses attention-mail glow/count CSS. Reads begun before a local
acknowledgement cannot resurrect the count; local acknowledgements serialize.
Seen flags are UI metadata and never travel in app bundles or templates.

Metadata/state mutations and duplication/deletion require expected_rev. A stale
revision refuses409 rather than silently overwriting. State patch uses RFC7396:
objects merge, arrays replace and null removes a key. State set can retain a null
value inside its replacement object. Events use monotonic sequence cursors and
retain the latest256 per panel; oldest_retained makes truncation explicit.

## Provisional defaults for morning review

The app row (USER2026-10-26 m0d853b77c816) opens its first listed panel by
explicit panel ID, or sends panel_open with only the app when it lists none, so
the engine reopens the most recently used copy or creates the first; its + sends
new=true and always creates another. A new panel without an explicit label is
named "Panel N", the app's lowest unused positive number among exact automatic
labels, chosen under the app row lock (USER me02e165c08fe;
`domain/apps/labels.rs`). Existing, explicit, imported and duplicated labels never
change. Saved-panel rows show state by their dot alone, open filled and closed
hollow, with Open/Closed in the tooltip and accessible label (USER m5ff0338a79da). Definition initial_state is copied, not shared.
Updating initial_state never overwrites existing saved-panel data; it applies
only when a new panel is created. The focused apps-new real-PG proof covers this.

The signed centered-modal rule supersedes the original fixed floating default:
placement float renders a viewport-centered overlay (stored x/y are unused in
that mode). Canvas placement keeps stored geometry; native pop-outs keep the
existing saved-window lifecycle. The header pin pins to the canvas only (USER
2026-10-26 mbb2b54092d1f, "only canvas pin, no screen pin"): it places the copy
at the visible canvas centre and asks its org window for the canvas view; unpin
returns to float. The pin is hidden in a pop-out. Screen placement is retired:
the wire refuses mode screen, and migration0068 moved stored screen pins to
float. The iframe remains the same subtree across pin/unpin.

Separate native settings replace the former combined App/This panel view
(USER2026-10-26 m9f3ddc116f78). App-row gear opens AppSettings: description,
creator, export/delete) in its General tab and the embedded AppPermissions in a
second Permissions tab (USER2026-10-26 m1fcbeca9488e): Files grants, pending
changes and events.fire allow/deny. Panel-row and open-header gears open
PanelSettings bound to one explicit panel ID, including closed copies; no MRU
selection, HTML startup or app actions. Its General tab keeps state/rename/
duplicate/delete on their existing revision-checked tool calls. Its History tab
(USER mc8711410a925) holds the copy's log, merged from the former Activity view,
with Connections and Fire event, which stay per-copy. Linked agents (USER
m66c0f064351c) and placement (USER m79ee175a5283, m5fca61662c5b) left settings;
placement stays on the window and in orgtree_apps. Once stays in live native
host consent. Both use the shared SettingsTabs/SetGroup/SetRow/AppDialog design system and independent
pin identities; owner-document context also wraps their nested dialogs. All
three settings entry points are display only; orgtree_apps retains action parity.

Entry HTML is limited to4MiB, state/initial state to2MiB compact JSON, nesting to64,
and event payloads to64KiB. Pages
default100, maximum200. These are provisional bounds, not new user rulings.

The bound HTML bridge exposes fixed org actions under the effective policy above.
General user operations, question answers, publishing, arbitrary HTTP and caller
selection remain excluded.

Org-modifying tools uses tools.orgtree.orgmod. Logo moves into the category.
The legacy logo key remains an accepted compatibility alias: when orgmod is
absent, an explicit old Logo denial also denies the replacement category. An
explicit orgmod value takes precedence. Parent intersection still clamps the
category. orgtree.logo scope requests resolve to the canonical orgmod grant.

Other provisional choices retained for the next slices: per-app default/Ask/Allow/Deny
outside HTML, exact-request Allow once, no network/no same-origin, suspend hidden
scripts, optional accumulated state in export, no portable execution grants,
and template definitions/initial state only.
Mail identity and creator-retirement policy remain morning questions; no default
may silently turn an agent panel into general user authority.

## Apps host milestone

Migration0059 adds a panel event high-water mark and an open-panel partial index.
The active workspace pages open:true; historical saved copies are fetched only
when the menu is opened. GET /api/orgs/{slug}/apps?request=<JSON> whitelists list,
app_get, panel_get and events; mutations remain POST. The renderer uses dedicated
custom_apps_changed invalidation, not the generic live-bump loop on every edit.

AppsButton/AppsWorkspace own one org menu and stable per-panel MovableSurfaces.
AppsCanvasLayer owns independent world anchors without adding chart nodes or
changing tree layout. Canvas culling and mini icons suspend embedded HTML.
Panel state, not renderer geometry globals, persists placements and open copies.

PanelHtml uses sandbox=allow-scripts (no same-origin), an opaque-origin exact-frame
message check, a per-mount random channel and a restrictive prefixed CSP.
The iframe supplies a reply MessagePort in its ready handshake. Replies use that
port: adopted pop-out handlers still execute in the main JS realm, so their
window.postMessage sender would not equal the iframe's new parent window. The
parent binds state and events to its own panel ID, serializes writes, checks
revisions and caps messages/rate. It exposes no credential, generic HTTP endpoint,
permission decision or caller selection. Frame content is untrusted even after
the envelope check. The bridge rechecks engine-side app revision, panel and
capability and invalidates mounted sessions on code replacement/closure. Self-navigation network containment
requires native-window verification before a no-network execution claim.

The async SDK is window.orgtree state.get/set/patch/onChange; storage.getItem,
setItem, removeItem, clear; on(name,fn); emit(name,payload). Storage values are
JSON, not strings only. State patch follows RFC7396; null removes keys. The host
does not replay the entire retained event history on opening. It forwards new
named events after that panel's initial event_seq. Hidden/closed frame scripts
are discarded and reconstruct from committed state. No background-timer guarantee.

## Permission-checked backend bridge milestone

The engine now owns ephemeral host sessions at POST /api/orgs/{slug}/apps/bridge.
This route and permission_set require the exact desktop root header, not an agent
or standalone client token/bearer. Request/response bodies under apps and every
descendant are excluded from HTTP body logging, including malformed refusals.
Sessions are bound to org, panel and app code revision, expire after30 minutes,
and revoke on host close, panel close/delete and app code replacement/delete.
No session survives engine restart. The registry holds at most4096 sessions.

Local org policy derives defaults; explicit stored choices override them. A Call validates a strict
named action and checks current code revision, open panel and capability under a
per-app async gate. Permission, code and panel mutations acquire that same gate
BEFORE agent/database locks. The gate remains held through dispatch; no database
client is held while another domain service acquires its own. Weak gate entries
are pruned rather than growing with inactive app history. Per-app action rate is
provisionally60 dispatch attempts/minute across all its copies. One admission
point covers direct Allow and successful Once/Always decisions immediately before
dispatch. Ask/Cancel/Deny do not execute. Rate history survives the last session
and weak gate; only inactive histories past the full60s window are pruned.

The private Apps HTTP boundary strips query strings and wraps all awaited nested
services in a task-local opaque-log scope. Logged method arguments/results and
manual event fields are omitted there; request path/status remain visible and
ordinary callers retain diagnostics. Bridge dispatch also enters the scope for
non-HTTP internal callers. The scope does not propagate across spawned tasks.
Every file-access and import/export blocking worker uses
`trace::private_app_blocking`, which enters `PRIVATE_APP.sync_scope` inside the
worker: nested logged path normalizers and manual events remain private there,
including after cancellation of the async caller. The previous worker scope is
restored on return or unwind. Independent async consumers establish their own
scope. A real-file verbose canary covers reads, listing, Windows changes and
bundle IO, preserving authorized results and ordinary worker-log positives.
Invalid read requests return a fixed parser refusal rather than reflecting caller
content.

App event privacy also travels in Event provenance through subscriber channels
and overflow cells. Its Debug formatter is opaque even outside the producer task.
The receiving runner scopes the complete mixed batch and pending delivery before
Access/Pending/save/fire services. Payload remains available for authorized regex
matching and delivery. Diagnostic last_output and fire-history gists omit private
app content, so persisted progress cannot leak it on a later ordinary load. Error
retries retain metadata only. A canary uses actual emit/subscription/overflow with
an independent consumer created before the producer's private scope; it verifies
the original delivery bytes and ordinary-log positives as well as omitted logs.

Ask stores one exact action under an opaque challenge for120 seconds. Decide
consumes it once. Once executes only that action; Always stores Allow for its
capability; Deny stores Deny. permission_set requires current app expected_rev
and expected_permission_rev. Grants have their own revision (migration0060), so
changing a grant does not reload code or lose the action reply. Agent callers
are explicitly forbidden from deciding permissions. Code replacement resets
external grants and revokes sessions, retaining restrictive Ask/Deny. Import/export never carries decisions.

The action vocabulary is limited to org.read (paged active chart metadata, not
private mail/files), mail.send (a live local agent only), docket.create (one new
open non-code item with title/objective/owner) and events.fire (a declared named
event broadcast to subscribed app_listener watchdogs). No general ops/HTTP, identity selection,
question answering, release actions, outside mail, user mail or project mail.

Mail has explicit app:<app>/<panel> provenance, grants no reply audience and
never counts as direct user contact. App content is not a user instruction or
approval. Docket creation records an app/panel actor. events.fire cannot spoof
an arbitrary engine event kind. All payloads/actions are bounded to64KiB.

Provisional docket.write authorizes creation AND assignment, waking the selected
live local owner. The native grant states this explicitly. Both fallback mail
and typed assignment envelopes label app-origin work as app content with no user
instruction/approval authority. The user explicitly retains this direct-wake edge case.

## Whole-app portability backend

Provisional version1 `.orgtree-app` JSON carries format/version, a strict
Definition and optional `{label,state}` copies. Limits:16MiB serialized bundle,
16 copies, existing4MiB HTML/2MiB state/depth bounds. Imports validate before DB
access, generate new IDs, derive local org authority without portable grants, and create copies closed
with default placement. Neither script execution nor host creation happens on
import. No runtime IDs, grants, sessions, geometry or credentials travel.

Export takes expected_rev and the app row lock shared by all panel writers,
giving one app/copy snapshot. It refuses more than16 selected copies rather than
silently truncating; definition-only export is still available. Import is atomic.
HTTP uses strict app_import/app_export requests. Agent tools share that service,
adding import path or export as_file (defaulttrue) adapters with fresh live/orgmod
checks. Authority comes from the original lexical held root, pinned without
following its components, never from canonicalizing a mutable root. Original
relative descendants use pinned handles (Unix openat, Windows NtCreateFile with
RootDirectory and no-reparse options). Windows pins deny data-write/delete
sharing, including pre-opened data mutators; attribute-only writes may not conflict,
so the handle-relative opens are required. Every opened Windows handle's final
path must also match its pinned path.
Final opens refuse links/reparse points. Absolute paths cannot contain parent
components. Imports stay within held roots, bounded by both file metadata and
actual bytes. Exports create_new only in the agent's existing private scratch,
returning path/bytes/SHA256; no DB connection or lock spans file IO. Native Apps-menu
file selection shows a plaintext metadata/capability preview before app_import;
it mounts no imported HTML. Manage app exports through the same app_export route
with an unchecked-by-default saved-data option and an owning-document file anchor.
Whole-app file exports serialize compactly and check the exact UTF-8 bytes before
Blob creation, so valid deep state does not expand past the import cap. Ordinary
panel-state JSON export retains its readable formatting.
These defaults await morning review.

## Templates and the retired panel links

Provisional Save as template carries strict app definitions/initial state only,
within its existing16MiB total file bound. It does not query saved copies,
permissions or runtime IDs. Template App has opaque Debug and generic
validation errors, including when a logged template service returns it. The
new-org transaction inserts fresh implicit-org-authority definitions atomically alongside
its nodes. No panel/iframe/host session is created and no script executes.

Panel links are removed (USER2026-10-26 mbb2b54092d1f, "Remove completely";
m66c0f064351c: agents are linked by listening for panel events now). Panel
metadata omits linked_agents; any Apps request carrying linked_agents is refused
with directions to app_listener; duplicates copy no links; state set/patch and
explicit panel events no longer emit app.event watchdog signals. Migration0068
empties the inert linked_agents column, kept so an older build still reads its
rows. The watchdog event bus keeps its private-payload handling for the retired
app.event name as defensive code with no producer. Agents reconcile through
panel_get/events and their cursor; the latest256 boundary stays explicit.

docs/examples/apps/annotation-notes.orgtree-app is a small inert portable sample:
independent state, explicit save/reload and named mail.send through native consent.
It is not auto-installed or auto-opened and does not reproduce an unavailable
historical annotation editor. The focused wire check validates its actual file.

The explicitly assigned narrow real-engine persistence/privacy proof is
tools/rig/proofs/custom-apps.mjs. It uses isolated PG and fake CLIs, checks the
actual routes/dispatcher, restart/cascade, portability/templates, permission
revocation and the already-running DB watchdog's private-event mail path.
Keep its raw diagnostics and positive delivery controls; unit synthetic Access
coverage alone is not an end-to-end privacy claim.

## Native action host implementation

The SDK exposes `orgtree.call(action,args)`, forwarding only the fixed vocabulary
above. The parent rejects extra identity/action/panel selectors and bounds action
JSON to64KiB before the engine independently validates it. Main-realm requests keep
native desktop authentication after a portal adopts the React DOM. Only the parent
keeps the expiring engine session; replies to HTML contain operation results only.

Permission-required responses render a native owning-document modal OUTSIDE the
iframe, with complete action JSON as text. Buttons send only the engine's exact
session/challenge/choice. Once/Always/Deny are provisional defaults. Cancel,
Escape and120s prompt expiry close the session and discard the action without
persisting Deny. No ambiguous action failure retries automatically. SDK action
timeout150s allows the120s prompt; state requests retain30s.

Lifecycle effects create disposable clients, including StrictMode replay. Hide,
unmount, owner/channel/code changes abort pending native prompts, close reply ports
and sessions, and close a delayed session_open result before it can dispatch.
Permission edits use their separate revision and do not reload code. Native
Permissions saves Ask/Allow/Deny immediately for all copies. Real-PostgreSQL
persistence and capability execution/refusals remain part of the proof before alpha.

The provisional queue also caps pending recipient deliveries at8,192 per app;
publication refuses before that snapshot would exceed the bound.
