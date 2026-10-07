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
| `mail.waiting`, `mail.delivered`, `mail.changed` | Normal mail insertion, end-turn delivery settlement, or mailbox feed change; IDs only. Mid-turn receipt changes are included in `mail.changed` |
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
org. The access check precedes regex, stored last event and delivery; queued events
are checked again after any fire cooldown. Watchdog-generated alert mail does not
feed the event adapter, preventing a mail watchdog from firing on its own alert.

## Count thresholds

`target: "agents.active", threshold: "below 1"` fires when the count changes from
one or more to zero. `threshold: "at least 10"` fires when it changes from below ten
to ten or more. Counts and thresholds use nonnegative integers. Staying beyond the
threshold does not re-fire; leaving and crossing again can. `once: true` removes
the dog from the armed set after its first fire. Without a threshold, each count
change is a match. Threshold state is persisted with normal watchdog progress.

`event_scope: "subtree"` is the default and counts only visible descendants plus
the watcher. `event_scope: "org"` requires full org visibility. It never counts
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
event queue and at most 200 pending matches. Overflow pauses the dog with a
warning instead of silently losing events; narrow its target before resuming.

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
