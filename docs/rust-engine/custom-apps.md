# Custom apps and saved panels (4.5.0)

Source ruling: USER2026-10-25, custom panels headline. An org owns app definitions;
each app has zero or more saved panels. Every panel owns an independent JSON
object. Any live agent with org-modifying tools can operate on any copy in its
current org. An author or linked agent does not acquire user authority.

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

Metadata/state mutations and duplication/deletion require expected_rev. A stale
revision refuses409 rather than silently overwriting. State patch uses RFC7396:
objects merge, arrays replace and null removes a key. State set can retain a null
value inside its replacement object. Events use monotonic sequence cursors and
retain the latest256 per panel; oldest_retained makes truncation explicit.

## Provisional defaults for morning review

Opening an app creates its first panel or reopens the most recently used one;
new=true always creates another. Definition initial_state is copied, not shared.
Labels can be changed. Placement records distinguish float, screen, popout and
world canvas coordinates; an optional live-node attachment is canvas-only. The
storage milestone does not yet mount those surfaces.

Entry HTML is limited to4MiB, state/initial state to2MiB compact JSON, nesting to64,
event payloads to64KiB and links to64 unique live agents in the same org. Pages
default100, maximum200. These are provisional bounds, not new user rulings.

App declarations may request org.read, mail.send, docket.write and events.fire.
Declarations are NOT grants. This storage milestone does not expose an HTML
action endpoint. App replacement clears stored permissions and increments the
app revision so later frame sessions can be revision-bound. General user ops,
question answers, publishing, arbitrary HTTP and identity selection are excluded.
The sandboxed host and native permission decisions arrive in the following slice.

Org-modifying tools uses tools.orgtree.orgmod. Logo moves into the category.
The legacy logo key remains an accepted compatibility alias: when orgmod is
absent, an explicit old Logo denial also denies the replacement category. An
explicit orgmod value takes precedence. Parent intersection still clamps the
category. orgtree.logo scope requests resolve to the canonical orgmod grant.

Other provisional choices retained for the next slices: per-app Ask/Allow/Deny
outside HTML, exact-request Allow once, no network/no same-origin, suspend hidden
scripts, optional accumulated state in export, no portable execution grants,
template definitions/initial state only, and any-agent links without authority.
Mail identity and creator-retirement policy remain morning questions; no default
may silently turn an agent panel into general user authority.
