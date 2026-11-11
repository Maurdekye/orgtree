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

## Tests

`cargo test --bin orgtree-engine remote::` (no database, loopback only): the address rule, the sealed
store, route coverage, the handshake against a stand-in and against a real standalone test engine,
aliases, the routing rule, streaming and header hygiene, the instance stamp, the org socket, link
states, the offline answer, the merged list, removal and log privacy.

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
revoked on the remote). With a bundle it drives the desktop too (`desktop/remote-org.cjs`), in three
windows: the Homepage (the Add dialog, the list marks), the remote organization's window (its chip and
Connection details, a message with a streamed answer, the desk's docket, presentations and mail, a
question on the desk and in the user's inbox, hire and retire, the outage under the open window with
the refused send and its kept draft, recovery without a reload, the reload after the remote restarts,
the sign-in banner and Replace token), and a local organization's window beside it. That part opens
windows: Session 0 only. The rig has no main process, so two things stand in for it. The page script
plants a minimal desktop bridge before each page loads, with the identity main gives such a window
(`homepage`; `org` with the organization's alias): without it the page is the plain browser layout,
which has no status strip and so no connection chip. And the rig's desk harness (`desktop/main.cjs`)
adds `X-Orgtree-Remote` for a page at `/o/<alias>` of a remote organization, as Electron main does
for a window bound to one. Measured 2026-11-11 with a bundle: 40 checks, 26 captures, about 150 s.

## Not yet

The composed app feed (a remote window still reads this computer's accounts and providers from the
feed), notifications for remote organizations, creating an organization on a remote engine, watch-only
windows with a viewer token, and the machine-dependent controls of a remote window (open folder,
reveal file, provider sign-in).
