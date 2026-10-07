# Engine-event watchdogs

User request, 2026-10-07: pushed engine events, including credential bridge readiness,
plus lifecycle, credits, documents, settings, audiences, CLI warmth and count thresholds.

Create with `kind: "event"`, `target: "credentials.bridge.available"`, `once: true`.
Targets accept an exact dotted name or a trailing prefix wildcard, such as `turn.*`.
An optional `pattern` regex matches the safe JSON payload, after access is checked.
No event watchdog polls a target. Producers emit after their durable change commits,
or at an existing in-memory transition seam. Feed adapters expose only an allow-list
of identifiers and state labels, never raw change-log details or feed bodies.

## Catalog

| Event names | Meaning / payload |
| --- | --- |
| `credentials.bridge.available`, `credentials.bridge.unavailable` | Registered broker becomes ready, disconnects or its lease expires; coarse reason only |
| `credentials.isolated`, `credentials.ready` | General boot credential warning raised/cleared; bridge readiness is separate from general vault access |
| `engine.started` | Recovered subscriptions are already registered; commit and PID |
| `agent.hired`, `agent.rehired`, `agent.retired`, `agent.halted`, `agent.unhalted`, `agent.frozen`, `agent.unfrozen`, `agent.moved`, `agent.renamed` | Lifecycle operation; agent identity and operation |
| `agent.changed`, `org.settings.changed` | Existing feed invalidation; identity only (these are change notifications, not an audit diff) |
| `agent.settings.changed` | Retool, model/account change or settings save; field names, never values |
| `turn.started`, `turn.finished`, `turn.failed`, `turn.stalled`, `turn.limited` | Runtime transition or settled outcome; agent ID, no transcript or error body |
| `mail.waiting`, `mail.delivered`, `mail.changed` | Normal mail insertion, end-turn delivery settlement, or mailbox feed change; IDs only. Mid-turn acknowledgements also emit `mail.delivered`; actor receipt bookkeeping updates the feed without a `mail.changed` echo |
| `docket.created`, `docket.status.changed`, `docket.attention`, `docket.question.answered` | Item creation, status change, raised attention, answered question card; slug/status or request ID; no question or answer text |
| `account.signed_in`, `account.signed_out`, `account.limit.reached`, `account.limit.reset` | Published account authentication or limit-mark change/removal; account, pool, horizon, never credentials |
| `hub.up`, `hub.down`, `hub.changed` | An org's existing network hub connection or net feed changed; hub ID only |
| `credits.changed` | Grant/free credit amount changed through operations and cascades; agent ID, grant and free |
| `documents.created`, `documents.updated`, `documents.changed` | Presentation created/replaced, or document feed change; document/agent ID only |
| `audience.requested`, `audience.granted`, `audience.denied`, `audience.revoked` | Existing audience transaction committed; identities only |
| `cli.started`, `cli.ready`, `cli.cold`, `cli.evicted` | Existing process/warmth publication and eviction seams; agent ID |
| `agents.active`, `agents.live` | Mid-turn or live membership changed; count, previous count and scope |

Machine credential/start events are visible to every watcher. Agent events use the
existing self/team/subtree/full visibility predicate within the same org. Docket
events require docket read access. Restricted account events stay in their origin
org. Org-wide settings/hub events are hidden from self-only watchers. The access check precedes regex, stored last event and delivery; queued events
are checked again after any fire cooldown. Watchdog-generated alert mail does not
feed the event adapter: insertion and receipt settlement both exclude it. An
admitted turn containing watchdog mail carries a guard through turn settlement;
its own agent/turn/CLI events cannot trigger event dogs owned by that same agent.
This also covers mid-turn alerts and prevents two dogs on one owner from waking
each other through turn events. Other owners still observe the turn. Ordinary
turns remain observable by the agent's own dogs. Passive watchdog mail mixed into
an ordinary turn uses the same conservative suppression once claimed.

## Count thresholds

`target: "agents.active", threshold: "below 1"` fires when the count changes from
one or more to zero. `threshold: "at least 10"` fires when it changes from below ten
to ten or more. Counts and thresholds use nonnegative integers. Staying beyond the
threshold does not re-fire; leaving and crossing again can. `once: true` removes
the dog from the armed set after its first fire. Without a threshold, each count
change is a match. Threshold state is persisted with normal watchdog progress,
but resume and engine recovery recompute the current baseline before accepting
new count transitions. Changes during a pause/offline period do not manufacture
a crossing on resumption.

`event_scope: "subtree"` is the default and counts only visible strict descendants; the watcher is excluded from both subtree and org counts. `event_scope: "org"` requires full org visibility. It never counts
another organization. Thresholds require an exact count target and cannot be
combined with silence mode. Membership snapshots are captured at publication;
org identity/visibility is checked again by the receiver.

## Recovery, smoke and bounded delivery

Create smoke reports current exact bridge/credential/start/count conditions. It
does not fire for an already true condition. Future matching events fire;
`engine.started` is emitted after persisted dogs subscribe on each restart.
There is no historical event replay for time while the engine was offline.

`interval_s` is the minimum fire gap (floor five seconds), with ordered matches
coalesced during that gap. `fire_mode: "silence"` retains the usual quiet timer,
reset by each matching event and fire; no target polling is introduced. `notice`
and `once` retain their existing meanings. Each subscription has a bounded 256
event queue. A full queue retains the latest overflow sample rather than pausing;
transitions within an overflowing burst can be coalesced. After authorization,
matches coalesce by name and subject into at most 40 summaries, each with a match
count and latest payload; further distinct matches add an overflow summary.
No hidden event contributes to an exposed count or payload.

Each wake drains a bounded batch. Identity, visibility and current membership
are read once per batch; docket permissions and credit values are fetched in
batches only when needed. Progress is saved once per batch. Storage errors keep
the batch for retry with a bounded 1–30 second backoff; the tool and feed expose
retry health and clear it after recovery. An initial storage failure also retries.
A confirmed loss of full visibility pauses an org-count dog; a database failure
is never described as a scope revocation.

Implementation: `runtime/watchdogs/events.rs`, post-commit `Change::EngineEvent`,
and existing producer seams. Renderer cards show the lightning icon, target,
threshold/scope and last safe event. No schema migration is needed.

## Prototype verification (2026-10-07)

Measured: cargo check -j 2 and renderer npm typecheck pass. A disposable debug
binary used a temporary SAFE_START-only HTTP adapter, restored byte-for-byte
after building, to exercise the real watchdog create/emit/fire code on a private
PostgreSQL cluster. Passed: pushed fire, once removal, current bridge-unavailable
smoke without firing, prefix/regex with self visibility, count crossing, subtree
count isolation, suppression of alert-mail feedback, persisted startup fire after
engine/cluster restart, and silence fire without target polling. All fixture
agents were halted, all alerts passive; no provider turn or live data was used.
The private engine and cluster were stopped afterwards. Production emit adapters
were checked from source; this smoke does not simulate every provider lifecycle.

SAFE_START recovers only event dogs, and all watchdog alerts are passive in that mode;
a recovered dog can never launch a provider from a copied database. Normal runs
retain notice/wake semantics. Confirmed count scope revocations pause with a diagnostic; storage failures retry. Credit
parent lookups run only while a matching event subscriber exists.


## Review follow-up (2026-10-07)

The initial ten-check smoke covered only alert insertion. It used halted agents
and passive alerts, so it never exercised later turn publication or delivery
settlement. That missed the two feedback loops reported in review. The follow-up
smoke exercises the production admission guard, runtime publication, feed change
adapter and mail receipt event helper without invoking a provider. Results are
recorded separately after the scratch run; this is not a live paid-turn claim.


Measured follow-up: cargo check and typecheck pass. The expanded private-DB smoke
passed ordinary self events, suppressed self alert-turn/mail/agent settlement
after the five-second fire gap, visibility to another watcher, strict-descendant
idle thresholds, resume/restart baseline refresh, self-only org-event filtering,
and silence/startup behavior. A 1,000-event burst stayed armed and coalesced into
the next fire; a PostgreSQL trigger counted six watchdog UPDATEs across the
watchers in that run. A scratch-only trigger then rejected watchdog writes:
the listener exposed retry health and fired the retained event once the trigger
was removed. These are production helper/runner measurements, not a paid-provider
turn or live-engine claim. All scratch engine and PostgreSQL processes stopped.
