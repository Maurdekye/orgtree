# Remote organizations

[Rust engine notes](DECISIONS.md) · decision 100

An organization that runs on a standalone (headless) engine elsewhere can be opened in the desktop app
like a local one. The user adds a *remote engine* (an address and a token) once; every organization on
it then appears in the org list, marked remote. This page is the engine's contract. The engine part
landed first (2026-11-11), then Electron main and the first desktop screens.

Decided: USER 2026-11-11 09:28:17Z m959b850c2ab2 (the feature), 10:08:27Z mc7584bf16c13 ("Accept all,
build it": the twelve design recommendations). Docket `remote-org-connect-the-desktop-app-to-an-org-run`.

## Shape

The **local engine is the relay**. The renderer keeps its relative `/api/...` URLs and never holds the
remote's token; Electron main adds one header, `X-Orgtree-Remote: <connection id>`, to the requests of
a window that is bound to a remote organization. The remote engine needs no change: any published
standalone engine from 4.5.11 on works with a full client token.

Code: `engine/rs/orgtree-engine/src/remote/`.

| File | What it owns |
| --- | --- |
| `store.rs` | The saved connections, `<data>/remote-engines.json`, and their sealed tokens |
| `address.rs` | The address and the rule for sending a token there |
| `handshake.rs` | The checks before a token is trusted to an address |
| `link.rs` | One task per connection: state, the mirror of the remote's app feed, the list rows |
| `routes.rs` | The class of every route: an organization's, an engine's, this computer's |
| `relay.rs`, `socket.rs` | Where a request belongs; carrying it; the org socket |
| `api.rs` | `/api/remotes` |
| `text.rs` | Every sentence the feature shows |

## Stored data

`<data>/remote-engines.json` (version 1), replaced whole and atomically (a temporary file beside it,
then one move), like `standalone-clients.json`. Per connection: id, name, tag, address, the remote's
data root id, this desktop's client id and name there, the sealed token, enabled, the last version and
process seen, and its organizations: `remote_slug`, `alias`, `local_id`, uuid, name, the last summary.

The token is sealed with the data root's key (`mqtt/seal.rs`, AES-256-GCM, DPAPI machine scope on
Windows), with the connection id as authenticated data: a row copied to another id does not open. The
promise and its limit are that module's. No route answers the token, the renderer and Electron main
never receive it, and nothing logs it. A file that cannot be read leaves the list empty and refuses
changes; it is never overwritten.

A database table was not used: the relay's tests run on an engine with no database, the sibling
registries (`standalone-clients.json`, `phone.json`) are files, and the sealing key is per data root.

## Names

- **Alias**: the slug this desktop uses for a remote organization. Its slug there when no local
  organization and no other alias holds it, else `<slug>-<tag>`, then `-2`, `-3`. Saved; never changed;
  reserved while the connection exists, also when the organization is gone or the engine is offline.
  Creating a local organization refuses a name an alias holds.
- **Local id**: a negative number per remote organization, never reused: its key in this engine's app
  feed (registry record, summary, working count).
- Text and content are in the remote's namespace. The alias appears only in URL paths, the window
  identity and local keys.
- **The tree under an alias.** The remote engine answers a window's read of its organization with
  the name the organization has there. The window keys desks, drafts and layout by the name it asked
  by and checks every answer against it, so the tree is given that name where it enters the window
  (`treeHere` in `remotehere.ts`, at the two places `App.tsx` takes a tree). Without it no desk of
  such an organization opens ("Loading organization..."); found by the proof's fourth window.
- **References when the alias differs.** A token in text (`@item:acme/x`) names the organization as
  its own engine knows it. In a remote window the renderer reads tokens through
  `canvas/workrefs.tsx` (`parseRef`, `scanRefs`), which gives the reference under this computer's
  name for that organization (`windowOrg`: the remote slug of one of that engine's organizations
  becomes its alias), so `@item:acme/x` in the window "acme-galaxy" is that window's own item and
  never this computer's "acme". `refToken` (`canvas/reflinks.tsx`) writes the name back as the
  remote engine knows it (`contentOrg`), so what is typed or copied there carries no alias. Both
  are the identity in a local window and for a name that is the same on both sides. The map is
  the window's `remote_link.orgs`; an organization the remote engine no longer lists maps nothing.
- **Known gap.** Only reference tokens in text are mapped. Structured fields that carry an
  organization's slug in a request or an answer (a reply target, a notice read straight from a
  route) are not: in a window whose alias differs from the slug there, a reply that quotes an
  object may be refused by the remote engine as naming an unknown organization. A window whose
  alias equals the slug (the usual case) is not affected.

## Adding a remote engine

`POST /api/remotes {url, token, name?}`. In order; the first failure answers its sentence and saves
nothing:

1. **Address.** `http` or `https`, a host, an optional port and path prefix; no user-info, query or
   fragment (a missing scheme means `http`). `https` goes anywhere. Plain `http` only when every
   address the host resolves to is this computer, a private network (10/8, 172.16/12, 192.168/16,
   IPv6 unique local) or Tailscale (100.64/10, `fd7a:115c:a1e0::/48`). The rule is asked again at every
   connect, and for plain http the client is pinned to the addresses it passed. Redirects are never
   followed; no proxy is used.
2. **Reach.** `GET /api/desktop/alive` with the token. Its `dataRootId` identifies the engine.
3. **Version.** `GET /api/host`. Older than `REMOTE_MIN_ENGINE` (4.5.11) is refused; any other
   difference from this app's version connects and is shown.
4. **Scope.** `GET /api/standalone/clients`: the standalone API with a token that may do everything.
   A viewer token is refused in this version.
5. **Own token.** `POST /api/standalone/clients {"name":"Orgtree desktop (<computer>)"}`. The answer's
   token is sealed and used from then on; the pasted token is not kept. An engine that cannot make one
   keeps the pasted token, and the view says so (`own_token: false`).

`PATCH /api/remotes/{id} {name?, enabled?, token?, url?}` renames, disconnects or connects, replaces
the token or moves the address (a new token or address must reach the same data root).
`DELETE /api/remotes/{id}` ends the link and its sockets, revokes this desktop's client token on the
remote when it can be reached, and frees the aliases; nothing on the remote engine is deleted. Its
answer's `revoked` says whether the token was revoked. The remote ends every connection of a client
as it revokes it, the request's own too, and promises no answer (`client_tokens.rs`); a connection
kept from before can then fail once more as it is found dead. So `handshake::revoke` makes a request
that ended without an answer again, with a growing pause, for up to 5 s: 200 is a revocation; 403 is
one only when the engine no longer knows the token (not when it is no longer standalone or takes the
token for reading only); any other answer is final; an engine that cannot be reached (connect error,
timeout) is not asked twice, so removing a connection to an engine that is away stays quick.
`POST /api/remotes/{id}/retry` connects now. `GET /api/remotes` lists the connections; the same list
is the app-feed value `remotes`. These routes answer 404 on a standalone engine (no chained relays),
are refused to viewer tokens, and are not agent tools.

## The link

One task per enabled connection. Connect is steps 1 to 3 with the saved token, then the remote's
`/api/app/ws`; its frames keep a mirror from which the list rows are made.

| State | Meaning | Leaves when |
| --- | --- | --- |
| `connecting` | first dial, or one after a pause or a fixed refusal | the checks end |
| `connected` | the app socket is open | it drops, two relayed requests fail within 10 s, or nothing is heard for 45 s (a ping goes every 15 s) |
| `offline` | not reachable; retried after 1, 2, 4, 8, 16, 30 s (spread by a fifth; starts over after 60 s connected) | a retry succeeds |
| `auth_failed` | the remote refuses the token; retried every 5 minutes | a new token, or a retry succeeds |
| `refused` | too old, not standalone, or another engine at the address | the user fixes it and retries |
| `paused` | the user disconnected | the user connects |

A remote that does not answer never delays this engine's start.

## Where a request goes

`http::guarded` asks `relay::decide` for every request and acts on it only past the desktop token
check.

1. A standalone engine relays nothing and ignores the header.
2. `X-Orgtree-Remote` must name a saved connection, else 400.
3. `/api/orgs/{x}/**`: without the header a local organization `x` is served here, always. An alias is
   carried to its remote engine under the organization's slug there. With the header, `x` may also be
   the organization's own slug on that remote. Anything else with the header is 404: a remote window is
   never served a local organization.
4. A route of class `Engine` (accounts, providers, usage, model servers, defaults, instructions,
   skills, templates, folders, client tokens) with the header is carried to that remote engine.
5. Everything else is served here.

Every route of the router has a class in `routes.rs`; a test fails for a route that has none, so a new
engine-wide route cannot act on the wrong machine by accident. An unknown path is this computer's.

**Carrying.** The body streams both ways. Request headers pass except hop-by-hop ones, `Host`,
`Origin`, `Referer`, `Cookie`, `Authorization`, the desktop token and `X-Orgtree-Remote`; the remote's
token goes as `Authorization: Bearer`. The app media route carries its own ticket: it goes without the
token and keeps a sandboxed frame's `Origin: null`. Response headers are limited to the ones the
engine's API uses (plus `x-orgtree-*`); a remote cannot set cookies or site data here, and a 3xx
(other than 304) is refused rather than passed on. At most 64 requests are in flight per connection.
While the link is not connected a request is answered at once with 503 and
`{"detail": <sentence>, "remote": {"id", "state"}}`: nothing is dialed. The same sentence is the
connection's `refusal` in `GET /api/remotes` and in the pushed `remotes` value (null while connected;
`Remote::refusal` is its one home), so a window can say it before it asks. A 503 that names `remote`
always means nothing was sent. A 502 that names `remote` means the request left this computer and may
have been applied.

**Org socket.** `/api/orgs/{alias}/ws` is accepted here and dialed on the remote; text frames are
copied both ways unchanged. When the remote side ends, the queue toward the window (8192 frames)
overflows, or the link leaves `connected`, the window's socket closes with code 1013 and the
renderer's own loop reconnects.

**Instance stamp.** Answers to a request that carries the header are stamped
`<this process>~<the remote's process>`, carried or not, so such a window reloads when either process
was replaced and not during an outage. The last remote process is saved, so a window that loads before
the link is up is not reloaded by the connect.

**Log.** A carried request logs `RELAY <tag> <METHOD> <path> <status> <ms>`; its bodies are never
logged, and the bodies of `/api/remotes` are omitted before authentication.

## The list

Remote organizations are rows of this engine's app feed and of `GET /api/orgs`: `slug` is the alias,
`org_id` the local id, and `remote: {id, name, tag, slug, state}` says whose they are. While the link
is connected they carry the remote's summary and working count; otherwise the last summary and no
activity. They are not local organizations: no handle, no database row, never in `local-orgs.json`.

What waits on the user in a remote organization (questions, urgent mail and the rest) is among this
computer's notices: the link mirrors the remote's `org_notices` frames, and the app feed sends them
under the organization's local id with `org` set to the alias and the title led by
"<organization> · <connection name>: " (cut to the 200 characters the desktop accepts). So a desktop
notification names its remote engine and a click opens the remote organization's window.
`GET /api/desktop/notifications` lists them after the local ones. While the link is not connected
this engine cannot say what waits there, so it sends `notices: null` for the organization, which a
window reads as "not known" and not as "nothing waits": notifications already shown stay, and none
is shown twice after a reconnect. `GET /api/desktop/status` counts this computer's agents only; it
decides when this engine may restart, which a remote engine's work never holds up. The tray list
(`apps/desktop/main/traylist.ts`) shows a remote row's connection name after its own and no counts
while its link is not connected.

## The app feed of a remote window

The app socket and `GET /api/app/records` of a window that carries `X-Orgtree-Remote` are composed
(`appfeed.rs`). The registry, summaries, notices and working counts are this computer's merged list,
as in every window. The pushed values are the remote engine's own (accounts, providers, usage,
language model servers and the rest), mirrored by the link and stamped with this engine's epoch and
sequence; none of this computer's values is sent, except `remotes`. One more value, `remote_link`,
is the window's own connection: the same record as its entry in `remotes`. A change of a value on
this computer goes to local windows only, and a change on the remote engine to its windows only.
While the link is not connected the window keeps the last values it had, like the list rows; a value
the remote engine no longer has is sent as `null`. A removed connection's values are dropped.

## What depends on the computer

An organization on a remote engine keeps its agents' folders, the files their transcripts name and
its providers' profiles on that engine's computer. A path the remote engine reports is never
opened, revealed or looked for on this disk: the same path here is a different file, and "does it
exist" would tell the remote engine about this computer.

- **The authority is the main process.** `handleHere` in `apps/desktop/main/index.ts` registers the
  commands that open a folder (agent, team and shared scratch folders and their AGENTS.md, the
  templates and charters folders), open, reveal or check a file, or start a provider sign-in. It
  refuses a caller whose window is an organization of a remote engine with
  `{ ok: false, error, remote: true }`. Whose window it is comes from the window's registered
  identity and the alias map the request header is decided from, never from an argument.
- **The window does not ask.** `renderer/src/remotehere.ts` reads `remote_link` (the composed app
  feed gives it to a remote window only). The scratch folder entries stay in their menus and say
  "This folder is on <name>, not on this computer."; the templates and charters "Open folder"
  buttons say the same; a file link's menu has one disabled entry "On <name>" and keeps Copy path
  and Copy file name; a tool row's file is in state `remote` and its path is not checked; the
  provider sign-in control says to sign in on the remote engine itself and offers the profile's
  path to copy.
- Commands that belong to this app on this computer (the engine log folder, preferences, updates,
  the tray) are unchanged in a remote window.
- **What the remote engine does is said to be there.** The folder picker lists folders through
  `/api/fs`, an engine route, so in a remote window it browses the remote engine's disk; its title
  reads "choose a folder on <name>" and the top of its path bar is that name, not "this computer". A language model server's address is dialed by the engine,
  so its Address row adds "Addresses are as seen from <name>."
- **App settings says whose settings it shows.** In a remote window the engine's settings are the
  remote engine's (its routes are relayed and its values come with the composed app feed). Under
  the tab strip a note says so. The tabs that hold only this app's settings (Streaming, Mail hub,
  Keyboard shortcuts, About) carry the badge "this computer"; in the mixed tabs the groups stored
  by this app (startup and updates in Runtime; theme, canvas, desk, quick chat and startup in
  Display) are wrapped in `ThisComputer` (`canvas/settingskit.tsx`), a named group whose group
  heads get the same badge from the style sheet. "Wrap object mentions" and the Enter key rule
  are engine values, so they are the remote engine's.

## Several people on one organization

Decided: USER 2026-11-11 11:49:08Z me1216df27194 (asked for), 18:56:17Z meba39d75fade ("Accept all 9":
the nine recommendations of the amendment). Decision 101. It lands in parts; this section says only
what has landed.

Every connected desktop is the user and has the user's authority. The engine that runs an
organization still knows which computer an action came through, so that people can tell each other
apart. Names grant nothing.

### Who a request came through

`caller.rs`. The request guard (`http::guard`) resolves an **origin** once, from the token that
authenticated the request, and runs the request inside it (a task-local, `caller::scope`). Nothing
reads an origin from a header, a query or a body, so a page or a relayed request cannot claim to be
someone else.

| Token | Origin `id` | Origin `name` |
| --- | --- | --- |
| a named client token | the client's id | its label |
| a standalone engine's startup token | `startup` | "Startup token" |
| a desktop engine's own token | `local` | the name its user chose, else the computer's |

As JSON an origin is `{"id", "name"}`, plus `"on"` when the client's own name says more than the label
("Sam", on "Orgtree desktop (PC2)"). When a request carries the startup token and a client's token,
the client is who it came through. Work done in another task than the request's has no origin, which
means unknown.

### What is recorded

Migration `0086_user_origin`: one nullable `via jsonb` beside each record of a user action. It holds the
origin of the request that made the record, with the label as it was then, so history stays readable
after a rename or a revocation. Nothing is backfilled, and nothing is decided from these columns.

| Record | Column | Written by |
| --- | --- | --- |
| mail from the user (a message, a broadcast, a hire's kickoff, an answer, a docket notice) | `ot.mail.via` | `domain/mail.rs`, `domain/asks.rs`, `domain/ops.rs`, `domain/docket.rs` |
| operations and settings changes | `ot.events.via` | `ops::event` and the routes that write an event themselves |
| a settled request | `ot.asks.answered_via` | `asks::settle` |
| docket changes by the user | `ot.work_events.via` | `docket::history`, attach, detach |
| the user's undo history | `ot.undo_entries.via` | `undo::gesture` |
| a saved org.md | a `notes_saved` event (`ot.events.via`), detail `{"what": "org.md", "rev", "chars"}` | `put_orgmd`, before the file is replaced |
| the saved instructions for all organizations | `saved` (`{"rev", "via", "at"}`) in their `ot.kv` row: they belong to no organization, so no organization's events hold them | `put_app_instructions` |
| an app-wide default | `defaults_changed` in the app settings document: per key the pair `[via, at]` of its last save | `save_defaults` |

The identities stay what they were (`@user`, `"user"`): agents, queries and the wire depend on them.
`caller::via_of(who)` gives the origin only when `who` is the user, so a record of an agent, of the
engine or of an outside party never carries one. A user action that reaches the engine outside a
request (an answer from the phone, through the mail hub) has none either: unknown.

Not recorded yet: the job a project hands on to a member (the copy does not carry who sent the job)
and mail to an outside party.

### What a window is sent

`via` rides beside the identity, never inside a typed event envelope (the renderer validates those
strictly): a mail row (`feed/compute.rs` `mail_entry`, and so the pending list, the mailbox pages and
the transcript's delivered rows), an event (`event_entry`, an agent's history, the History window), a
settled request (`answered_via` on the ask card), a docket history row and an undo history entry. A
record without one is sent exactly as before: the key is absent, never null.

The organization's tree says what its engine can do, in the `capabilities` its settings group already
had: `attribution: true` from this version on. A window of an organization on an older engine sees no
such member and shows names nowhere.

Agents read the user as "user" as before (question 2 of the amendment). The one agent tool that
returns mail rows built by `mail_entry` (`orgtree_project`'s mailbox reads) drops `via`; transcripts
read by `orgtree_read_transcript` never carried the rows.

### The save that would replace a newer change

`domain/expect.rs`. Rule: **a save says what it was based on, and the engine refuses it when that is
no longer what is stored.** With the fields it changes, a save may send `expect`: for each of them the
value the edit started from, as the window was shown it. The engine compares under the lock it writes
under. When any differs it writes nothing and answers 409:

```json
{"detail": "Sam changed charter since you opened it. Nothing was saved.", "code": "save_conflict",
 "conflict": {"target": "agent:lead", "fields": [
   {"field": "charter", "stored": "...", "actor": "@user", "changed_by": {"id": "...", "name": "Sam"}, "changed_at": "..."}]}}
```

`stored` is the value now. `actor` is who changed it (`@user` or an agent's name), `changed_by` the
origin of a user's change, `changed_at` when: null where the engine cannot tell.

- A long text may be named instead of sent back: `{"rev": "<first 16 hex digits of the SHA-256 of its
  UTF-8 bytes>"}`.
- Values compare as values: 80 is 80.0, the order of members does not matter, and nothing is nothing
  however it is spelled (null, "", [], {} and a member that is not there). A list's order is part of it.
- There is no force flag. "Save mine anyway" is a new save whose `expect` is what `stored` said, so a
  third change in between is refused again.
- A save without `expect` is not checked: an older window, an agent's tool, the user MCP.
- `expect` naming a field the save does not have is a mistake: 400.
- The organization's tree announces the check: `capabilities.expect: true`. A window sends `expect`
  only to an engine that does (an older one refuses the unknown key in organization settings).

| Save | Route | `target` | Fields | Who changed it is read from |
| --- | --- | --- | --- | --- |
| an agent's settings | `POST /nodes/{nid}/scope`, a `scope` step of `POST /gesture` | `agent:<name>` | `charter`, `team_charter`, `peer_mail`; and `add_dirs`, `tools`, `org_visibility`, `permission_mode`, `effort`, `model_version`, `fast_mode`, `account_fallback`, `auto_cheap_compact`, `session` as `configured_scope` shows them | the newest `scope` or `retool` event of the agent that changed the field |
| organization settings, hire defaults | `POST /api/orgs/{slug}/settings`, `/defaults` | `org` | `org_name`, `org_dirs` and the settings keys as the settings group shows them (`compact_at` as a fraction or a percentage) | the newest `settings` event that names the key (`org_renamed` for the name) |
| app-wide defaults | `POST /api/defaults` | `defaults` | the same keys, as `GET /api/defaults` shows them | `defaults_changed` |
| org.md | `PUT /orgmd` with `base_rev`, as before | `orgmd` | `org.md`: `stored` is the whole text | the `notes_saved` event of the stored text's revision |
| the instructions for all organizations | `PUT /api/app-settings/instructions` with `base_rev`, as before | `instructions` | `instructions`: `stored` is the whole text | `saved` in the stored row, while the text is still the one that was saved |

- A user's `scope` event lists what the save really changed (`detail.changed`), because an older
  window sends its whole form, the unchanged instructions included, and `detail.change` is what was
  sent. An event without the list counts for a field its `change` names.
- A gesture records before and after, never the step it was sent, so `expect` is not replayed by
  redo. The refused save leaves no entry in the undo history.
- The sentence of an agent's, an organization's and the app-wide settings is "<name> changed <field>
  since you opened it. Nothing was saved.", or "<field> changed since you opened it. Nothing was
  saved." when nobody is known. For org.md and the instructions, `detail` names who saved the newer
  text when a window did ("<name> changed org.md since you opened it. Reload it and make your edit
  again."), and is otherwise the sentence these two refusals always had (Connect your phone changes
  both without a record).
- **A request someone else settled first.** Answering, dismissing or deciding a request that is no
  longer open answers 409 with the sentence it always had, `code: "request_settled"` and `settled`:
  `{"id", "status", "answer", "answered_via", "resolved_at"}`, so a window can show the settled card.
- A refusal with a code (`domain::undo::Coded`) keeps its status, its code and what else it says on
  every route (`http/error.rs`), and the trace counts it as a refusal, not an engine error.

Not covered, on purpose: rename, move, hire and retire (they act on a named agent and fail by
themselves when it changed), single switches of the runtime and watchdogs (the later one wins; the
record says who), templates saved with Replace, the docket and the canvas layout. Custom apps keep
their own revision check; their refusal does not name who changed the app yet (the apps store keeps
no author of a change).

### Labels and who is connected (the engine that is connected to)

A client record has an optional `label`: 1 to 40 characters, no control characters. Without one a
client goes by the computer in "Orgtree desktop (<computer>)", else by its own name.

- `PATCH /api/standalone/clients/{id} {"label": text | null}` sets it; `null` or blank clears it. Any
  full token may set anyone's, because every full token is the user. A viewer token cannot: the route
  is not in its list.
- `GET /api/standalone/clients`: each row gains `label` (the one in effect), `connected` (a connection
  that used the token is open), `connected_since` and `last_seen_at` (the last authenticated request
  since the engine started; it is not kept across a restart). The answer gains `you`: the origin of the
  token that asked.
- `standalone-clients.json` is written as version 3 only while some client has a label. A registry
  with none is still version 2, which an older engine reads.
- The user MCP tool `orgtree_client_tokens` lists the new fields. It does not set labels.

### This desktop among other engines

- The name this desktop shows to others is kept in `remote-engines.json` (`shown_as`; absent means the
  computer's name, and the file is then as it was before). `PUT /api/remotes/shown-as {"label": text |
  null}` sets it. `GET /api/remotes` answers `me`, `{"id": "local", "name"}`: who this desktop's own
  windows are in the records of its own organizations.
- At each connect, and when that name changes, the link reads the remote's client list to learn who it
  is there (`you`). It gives its **own** client the chosen name when the remote was last given another
  one (`label_sent` of the connection). A name the engine's operator set there therefore stays until
  this desktop's user chooses again. A pasted token this desktop only borrowed is never renamed.
- The connection view gains `me`, `{"id", "name"}`: the origin this desktop's actions carry on that
  engine, and the name others see there. Until the engine has said so it is `{"id": <the client this
  desktop made>, "name": null}`, or `null` for a borrowed token. An engine older than 4.6.0 never says.
- `GET /api/remotes/{id}/people` answers `{"supported", "people": [{"id", "label", "name", "connected",
  "since", "last_seen_at", "scope", "you"}]}` from the remote's client list, and 502 while the link is
  not connected. `supported` is false for an engine that does not say who is connected.

Both routes are this computer's (`Local`) and are refused to viewer tokens.

## Tests

`cargo test --bin orgtree-engine remote::` (no database, loopback only): the address rule, the sealed
store, route coverage, the handshake against a stand-in and against a real standalone test engine,
aliases, the routing rule, streaming and header hygiene, the instance stamp, the org socket, link
states, the offline answer, the merged list, removal and log privacy. The tests named `e1_` and `e6_`
cover the origin of a request, labels, who is connected and what a connection learns about itself,
against a real standalone test engine; `caller::` covers the origin itself, and `via_tests` what a
window is sent. What is recorded is proved with two real engines by the rig proof `remote-people`
(below).

## Desktop

Electron main (`main/remotes.ts`, `main/policy.ts` `remoteHeaders`, `main/windows.ts`
`configureEngineSession`) adds `X-Orgtree-Remote` to the permitted engine requests of a window whose
organization is an alias, strips a page-supplied header on every destination, and learns the alias map
from `GET /api/remotes` once before the first window opens and from the app feed's `remotes` value
afterwards. The window identity contract is unchanged: an alias is an ordinary organization slug.

The renderer (`src/remotes.ts`, `src/shell/remotes.tsx`) reads the same `remotes` value and the
`remote` mark of a registry row:

- **Lists** (`shell/orgrows.tsx`): this computer's organizations first, then each engine's under a
  heading (glyph, name, state word when not connected; click or menu: Connection details, Retry now,
  Disconnect or Connect, Remove). A remote row has the glyph and a tooltip; while its engine is away it
  shows no numbers and no spinner. "Add a remote engine..." sits under the list.
- **Add dialog** (`RemoteEngineDialog`, the provider dialogs' frame): Address, Token, Name; one
  "Connecting..." line; a refusal's sentence under the fields, which keep what was typed.
- **Window**: the status strip's first chip (`RemoteChip`: green connected, amber another version, red
  with the state word) opens Connection details; the title carries the engine's name; while the engine
  is away `RemoteBanner` under the header says what is the matter and offers the one action, and the
  canvas is dimmed. Changes are refused by the engine's own 503 with the sentence to show.
- **Streamer mode** masks the address (Add dialog, Connection details) and, in Connection details,
  this computer's name in "Signed in as" (`Orgtree desktop (<computer>)`): both are host fields
  (`data-streamer-field="ip"`). The token field is a secret field. The engine's name is not masked in
  the title or the list; in the chip it is an external name.
- **A message typed while the engine is away stays in the composer** (2026-11-11). The agent desk's
  composer is optimistic: it empties its box and shows the message as on its way before the engine
  answers. Two rules keep the text. While the connection has a `refusal`, Send does nothing but show
  that sentence (`remoteRefusalNow`, read from the feed at that moment; no request). When the engine
  itself answers 503 naming `remote` (a link that dropped before this window heard), the send is
  undone: text, replies and files go back into the composer if nothing newer is there, the busy mark
  and the notice toggle are put back, no failed message stays, and the toast is the sentence alone
  (`nothingSentToRemote` in `api.ts`). A 502 keeps the failed message with its Restore control: that
  one may have arrived. The other composers (mail reply, project desk, Quick chat, listeners) only
  clear after an accepted send or already put the text back.

Tests: `tests/remote-org-window-header.test.mjs` (main), `apps/desktop/renderer/tests/remoteorg.test.tsx`
and `remotedraft.test.tsx`.

## Rig proof

`node tools/rig/rig.mjs run tools/rig/proofs/remote-org.mjs [--ui <bundle>]`. The run's engine is this
computer; the proof starts a second debug engine in standalone mode on a synthetic root inside the
run folder and reaches it through a TCP forwarder, so the network between the two can be cut and
restored without stopping either. Without a bundle it proves the engine part through the routes, in
any session: add with the remote's startup token (this computer gets its own client token; the token
is nowhere in the list, the saved file or the log), aliases including one that collides with a local
organization, the relay both ways, the two-process stamp, an outage (offline, the `refusal`, the 503,
nothing reaching the remote, rows kept), recovery by itself, a restart of the remote engine (a new
stamp), a revoked and replaced token, the local organization untouched, and removal (the client is
revoked on the remote), the app feed of a remote window against a local one (its connection, the
remote engine's values), and a question of a remote organization among this computer's notices.
With a bundle it drives the desktop too (`desktop/remote-org.cjs`), in four
windows: the Homepage (the Add dialog, the list marks), the remote organization's window (its chip and
Connection details, a message with a streamed answer, the desk's docket, presentations and mail, a
question on the desk and in the user's inbox, hire and retire, the outage under the open window with
the refused send and its kept draft, recovery without a reload, the reload after the remote restarts,
the sign-in banner and Replace token), a local organization's window beside it, and the window of
the remote organization that goes by an alias here (its desk opens; the folder entry opens nothing
and says where the folder is; a reference written under the name it has there is that window's own
item; App settings' note and marks; the sign-in sentence; the folder picker's title and top). The
tray row, main's own refusal of the native calls and the file link menu are not in the proof (the rig
has no main process); their unit tests are `tests/traylist-remote.test.mjs`,
`tests/remote-org-native-refusal.test.mjs` and the renderer's `remotehere`. That part opens
windows: Session 0 only. The rig has no main process, so two things stand in for it. The page script
plants a minimal desktop bridge before each page loads, with the identity main gives such a window
(`homepage`; `org` with the organization's alias): without it the page is the plain browser layout,
which has no status strip and so no connection chip. And the rig's desk harness (`desktop/main.cjs`)
adds `X-Orgtree-Remote` for a page at `/o/<alias>` of a remote organization, as Electron main does
for a window bound to one. Measured 2026-11-11 with a bundle: 53 checks, 32 captures, about 200 s; without one, 35 checks.
In Session 0 with a user signed in, an engine holds its first turns for the sign-in helper until 60 s
after its start (`session_settle`), so the far engine's first answer can take that long; the proof's
waits allow for it.

### The people proof

`tools/rig/proofs/remote-people.mjs` (engines only, any session; about 2 minutes): one far engine in
standalone mode, this desktop through its relay, and a second computer with its own client token,
driven as its engine's relay would drive it. It checks who each is on the far engine, the chosen name
as the client's label, who is connected, and that a message, a hire, a settings change, an answer, a
docket change and an undo entry each carry the name of the computer they came through in the OTHER
one's reads; that the startup token's actions say so; that an agent's own records carry nothing and
the agent still reads "user"; and that a renamed person's earlier records keep the earlier name.
Then the save check: a save based on what is stored goes through; one based on an older charter is
refused through a gesture, names who changed it and when, and leaves no undo entry; saving anyway by
revision goes through, and a second "anyway" whose base changed in between is refused again; a save
that names no base is not checked; the same refusal for an organization setting, an app-wide default,
org.md and the instructions for all organizations; and a question two people answer, where the second
is told who answered it and what. A tree read follows a save by a moment (it is built from the feed),
so the proof waits for the tree where it reads one after a write. 33 checks.
`tools/rig/far.mjs` starts the far engine for both proofs.

## Not yet

Creating an organization on a remote engine, watch-only
windows with a viewer token. No app panel action opens a file dialog of this computer today; one
that does must be refused for a remote window (`REMOTE_APP_ACTION` in `remotehere.ts` is its sentence).
