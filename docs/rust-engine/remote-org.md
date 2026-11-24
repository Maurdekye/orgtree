# Remote organizations

[Rust engine notes](DECISIONS.md) · decision 102

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
activity. They are not local organizations: no handle and no database row.

`local-orgs.json` lists them after the local organizations, since 4.6.7 (USER 2026-11-20 20:25:34Z
m725c710ca7b4 "Fold into 4.6.7", docket `hubchat-orgtree-chips-and-info-link-for-remote-o`; until then
they were never in it). An entry is `{slug, name, address, remote: {slug}}`: `slug` is the alias,
`remote.slug` its slug on its own engine, and it is written only when the summary names a hub address
(`net_slug`), connected or not. It names no remote engine. This is what lets desktop Hubchat open a
remote organization's badge and mention chips in this computer's Orgtree; the user's rule of
2026-11-08 (m7c183781895c, chips open only for this PC's own orgs) now reads "an org this PC's Orgtree
can open". See [orgtree-links](orgtree-links.md).

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
  templates and charters folders), choose a local folder (`desktop:pick-folder`), open, reveal or
  check a file, or start a provider sign-in. It refuses a caller whose window is an organization of
  a remote engine with `{ ok: false, error, remote: true }`. Whose window it is comes from the
  window's registered identity and the alias map the request header is decided from, never from an
  argument.
- **The window does not ask.** `renderer/src/remotehere.ts` reads `remote_link` (the composed app
  feed gives it to a remote window only). The scratch folder entries stay in their menus and open
  the Files panel on the remote engine's folder (below); with an engine that has no such routes
  they say "Orgtree on <name> needs updating to use the file browser: it runs <version>, and the
  file browser needs 4.6.0 or later. This folder is on <name>, not on this computer." Two things
  tell (USER 2026-11-14 mb1f74cf38dff, after a panel on an engine at 4.5.11 showed "404: no UI
  bundle configured"). First the version the engine gave when this computer connected (`version`
  of `remote_link`): below 4.6.0 by its three numbers, the entry says the sentence and nothing is
  sent (`filesNeedUpdate`). Then, for a version that does not say (none yet, or an alpha of 4.6.0
  from before the routes), the answer to the first listing: a 404 "no route ...", or the plain
  text "no UI bundle configured", which is what an engine started without a UI folder answered an
  unknown `/api/` path until 4.6.0 (`olderEngine`); the panel closes with the sentence. From
  4.6.0 such an engine answers "no route" as the other does (`http/mod.rs` `ui`); the templates and charters "Open
  folder" buttons say that sentence; a file link's menu has one disabled entry "On <name>" and keeps Copy path
  and Copy file name; a tool row's file is in state `remote` and its path is not checked; the
  provider sign-in control says to sign in on the remote engine itself and offers the profile's
  path to copy.
- Commands that belong to this app on this computer (the engine log folder, preferences, updates,
  the tray) are unchanged in a remote window.
- **The Files panel** (USER 2026-11-14 m8e827b770276, approved mda676963aed1). In a remote window
  the three scratch-folder entries (an agent's, its team's, the shared one) open a panel that
  shows that folder on the remote engine, a folder at a time: a folder opens, a file downloads, a
  folder downloads as a zip, and files upload into the open folder. There is no delete and no
  rename. Local organizations still open the operating system's file manager.
  - Engine, `http/scratch_files.rs`, three routes under
    `/api/orgs/{slug}/nodes/{nid}/scratch-files` with `scope=agent|team|shared` and `path` (plain
    names joined by `/`): `GET` lists (folders first, then files by name, `offset` and `limit`,
    200 by default and 500 at most), `GET .../file` sends a file as it is with its length or a
    folder as a zip written as a stream (deflate, ZIP64, no length known before it ends), `PUT
    .../upload?name=&conflict=ask|replace|keep_both` takes one file as the request body.
  - The folder itself is one of the organization's own (`unlinked_root`): as it is written it lies
    in the organization's scratch folders under the data folder, and neither it nor any folder
    above it down from the data folder is a link. That holds for an agent's folder (a path stored
    with the agent) as for the team's and the shared one. It is never made here: a personal folder
    that does not exist yet answers 404.
  - A path never leaves the folder: every name is one plain name (no `..`, no separator, no drive,
    no stream), each step is looked at without following it, a symbolic link or a junction is
    refused (in a listing it is shown as a link and can be neither opened nor downloaded; a zip
    leaves it out), and the resolved target must lie inside the resolved folder. A zip also
    leaves out an entry whose path is longer than a zip can name (65535 bytes) and says so in
    `_not-included.txt`.
  - An upload is written to `.<id>.orgtree-part` beside its target and given its name when the
    last byte is in; one that ends early leaves nothing. A name that is taken is refused with 409
    before the body is read unless the window sent Replace or Keep both. Only Replace ever takes
    the place of a file. Asked, a name taken since the upload began is refused too. Keep both
    takes the first name nothing has ("name (2).ext", past files, folders and links alike), and
    uploads of one name that end at the same moment each get a name of their own (`put_new`: a
    second name for the part, which the system refuses when the name is taken). 2 GiB a file at
    most, by the declared length and by count. Unfinished uploads are in no listing and no zip;
    one left by an engine that was stopped hard is removed at the engine's start once it is a
    day old (`sweep_stale_parts`, scratch folders only, no link followed).
  - A member may use the three routes; a read-only viewer gets none; they are organization routes,
    so the local engine relays them to the remote one as a stream in both directions. Their
    bodies are not logged.
  - Window, `renderer/src/remotefiles.ts` and `canvas/remotefiles.tsx`: the panel asks Replace,
    Keep both or Skip for a name that is there (once for all on request), says the size of a file
    of 100 MB or more before sending it, and shows bytes and percent with Cancel. A download is a
    plain link: Electron's Save dialog asks where, and `main/remote-downloads.ts` tells the window
    how far it is and stops it on Cancel. It touches only downloads of these routes, and the name
    it proposes is the last part of the name the answer gave, never a path.
  - Reviewed by @remote-sec-carbon at c56e8f6 (2026-11-14): no critical or high finding; the
    folder's own link check, the placing that never replaces, the sweep, the zip name length and
    the download name came from it. Accepted as they are: a check and the use that follows it are
    two steps (somebody who can change the folder on the remote computer at that moment already
    has that computer), a zip's directory is held in memory until its end, a sparse file is sent
    by its length, and a member reaches every agent's folder of the organizations it was given.
- **What the remote engine does is said to be there.** On a local desktop window, folder fields open
  the operating system's native directory chooser (`dialog.showOpenDialog`); in a remote window (and
  in any browser without the Electron bridge), `pickFolder` uses the in-app `/api/fs` chooser so it
  browses the remote engine's disk, its title reads "choose a folder on <name>", and the top of its
  path bar is that name, not "this computer" (USER 2026-11-13 m365cee9110b5, m98bc74e8a3c7). A language model server's address is dialed by the engine,
  so its Address row adds "Addresses are as seen from <name>."
- **App settings says whose settings it shows.** In a remote window the engine's settings are the
  remote engine's (its routes are relayed and its values come with the composed app feed). Under
  the tab strip a note says so. The tabs that hold only this app's settings (Streaming, Mail hub,
  Controls, About) carry the badge "this computer"; in the mixed tabs the groups stored
  by this app (startup, updates and Data location in Runtime; theme, canvas, desk, quick chat and startup in
  Display) are wrapped in `ThisComputer` (`canvas/settingskit.tsx`), a named group whose group
  heads get the same badge from the style sheet. "Wrap object mentions" and the Enter key rule
  are engine values, so they are the remote engine's.

## Several people on one organization

Decided: USER 2026-11-11 11:49:08Z me1216df27194 (asked for), 18:56:17Z meba39d75fade ("Accept all 9":
the nine recommendations of the amendment). Decision 103. It lands in parts; this section says only
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

Migration `0088_user_origin`: one nullable `via jsonb` beside each record of a user action. It holds the
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
the transcript's delivered rows), an event (`event_entry`, an agent's history, the History window's
events and its agent-mail and user-sent records), a settled request (`answered_via` on the ask card),
a docket history row and an undo history entry. A record without one is sent exactly as before: the
key is absent, never null.

The desk draws a delivery from its typed rows only when every row passes `isSegments`
(`apps/desktop/renderer/src/events/wire.ts`); one row it does not know turns the whole delivery into
its plain text, cards, headers and names gone, and leaves the message's queued copy standing. `via`
on a mail row is checked there as a record. A string is still read: the delivery word an older engine
wrote under the same key. **A new or changed member of a transcript row goes into that check in the
same landing, with a test that mounts the delivery through `Msg`** (`tests/people.test.tsx`, "a
delivered message that names a person is still drawn as its card"); a test that mounts a card by
itself does not pass through the check. The windowed people proof found this (below).

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

### What a window shows

`apps/desktop/renderer/src/people.tsx`. Rule: **an action by someone else carries their name; one's
own looks as it always did**, and so does a record that names no computer. A window's own origin is
`local` for a local organization, and for a remote one the connection's `me.id` (the pushed value
`remote_link`); until that engine has said who this desktop is, nothing is known to be one's own.

- `ViaName` adds " · Sam" after the label a place already had: "User" in a transcript header
  (`events/card.tsx`) and on a plain mail row (`events/segments.tsx`), "@user" in a mail list
  (`canvas/mail.tsx`). The organization's record says "you" for one's own and "User · Sam" for someone
  else's. The History tab says "by Sam", because a row there may name its recipient. The tooltip is
  "Sam, on Orgtree desktop (PC2)".
- A settled request's tag reads "answered by Sam at 14:02" (`canvas/asks.tsx`, from `answered_via`).
- Undo and redo of someone else's entry ask first: "This was Sam's change. Undo it?"
  (`historycontroller.ts` holds the question in `other`; `historyui.tsx` draws it). What the engine
  itself asks about (a hire whose agent has worked) comes after it. One's own entries, and entries
  that name no computer, are undone as before.
- Connection details gains "Shown to others as" (this desktop's one name, `PUT /api/remotes/shown-as`;
  the hint says what the others still see on that engine while it differs) and "Also connected" (the
  others who are connected now, from `GET /api/remotes/{id}/people`, read when the dialog opens).
- The name is an outside name to Streamer mode (`data-streamer-field="external"`), and its tooltip
  sits on the masked element so it is hidden with it.
- The docket pane draws no history rows, so nothing there is labelled; the rows are sent.

Tests: `tests/run.mjs people` (the rule, each place, the undo question, Connection details).

**A refused save, in the window** (`saveconflict.tsx`; the engine's side is "The save that would
replace a newer change" above). `api.ts` keeps a refusal's `code`, `conflict` and `settled` on the
error it throws.

- The agent settings form (`canvas/modals.tsx`) sends only what was edited: the instructions, the
  effort and the cold-turn reset no longer ride along with every save. For each field it sends, it
  says what the edit started from (`bases`, taken from the tree when the field's edit began), and
  only to an engine whose tree says `capabilities.expect`. A text is named by `{"rev"}`.
- On `save_conflict` the notice (`ConflictNotice`) stands where the Save row was: the sentence
  ("Sam changed the instructions at 14:02. Nothing was saved."; "You ... in another window" for this
  window's own origin; an agent by its name; "The instructions changed since you opened it" when
  nobody is known) and See their version (texts only, with Use theirs), Save mine anyway (a new save
  whose `expect` is what the refusal said is stored), Cancel. The form never closes on a refusal and
  nothing typed is dropped.
- A text being edited whose stored value changes underneath says so under itself at once ("This
  changed while you were editing.", See the new value); other edited settings are named in one line
  above Save.
- A question someone else settled first (`request_settled`): the card does not come back with "not
  sent ... submit again" (`asksubmitted.ts`); a toast says who settled it and when, and the feed shows
  the settled card.

Tests: `tests/run.mjs saveconflict` (the sentences, edited-only fields, `expect`, the three choices,
the line under an edited text, the answer that came second).

- A setting that saves by itself (Org settings; `settingsautosave.tsx`) says what its edit started
  from: the server's value when the field's first unsaved edit began, which a later keystroke of the
  same edit does not move. The organization settings form sends it as `expect` for the settings a
  window is shown the way it saves them (`org_name`, `max_top_grant`, `default_top_grant`,
  `compact_at`, `default_effort`, `permission_mode`, `default_visibility`, `default_account`). The
  folders, the tools, the fast-mode table, the cold-turn reset and the mailbox switches are shown in
  another shape than they are saved, and stay unchecked rather than risk a false refusal. When a
  value is refused, the cell goes back to what is stored and a toast says "Sam set the default effort
  to max just now. Your change was not saved." with **Use mine**: a new save of the same value, based
  on what the refusal said is stored.
- The org.md editor (`App.tsx`) and the instructions editor (`canvas/appinstructions.tsx`) show the
  same notice in place of their Save button. See their version shows the stored text, Use theirs
  loads it into the editor, Save mine anyway reads the stored revision again and saves over it,
  Cancel leaves the editor as it is. A refusal without `conflict` (an older engine) is the plain
  error it always was.

Tests: `tests/run.mjs settingsconflict` (a self-saving setting and Use mine; the instructions editor's
three choices).

Not yet in the window: the app-wide defaults form sends no `expect` (it has no tree to tell it
whether the engine checks); the engine checks them when asked.

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

## A desktop as host

A desktop can let other computers open some of its organizations (phase F, decision 103). It is off
by default and switched on per organization. The other computer uses the same "Add a remote engine"
dialog, list and windows as for a standalone engine; what differs is on the hosting side, and all of
it is in `remote_access/`. The security notes an independent reader needs are in
[remote-access-security](remote-access-security.md).

Built so far: the door's listener and guard, the registry (the switch of each organization, the
port, the computers and the one-time codes), the member route table, the owner's routes and the limit
on refused tokens, where the door stands and when, what a member is sent, the connecting side
(a desktop adds a hosting desktop with a code), the Windows Firewall rules (added by the desktop,
read back by the engine), and the windows ("A hosting desktop's windows" under Desktop below). From
the windows on, a running app can open the door: the switch is in an organization's settings. Two
real engines prove it together in the rig ([The hosting proof](#the-hosting-proof)), and the user's
guide is `docs/collaborating.md`, "Open an organization from another computer". Phase F is not to
reach anybody but its owner before the independent security review.

### The door

A second listener (`remote_access/door.rs`), apart from the loopback listener the app itself uses.
The two share the router and nothing else.

- A connection accepted at the door is marked where it is accepted (`Connection::door`,
  `client_tokens/transport.rs`). The request guard decides by that mark alone which rules a request
  is judged by; nothing in a request can set or clear it.
- A peer is asked about as it is accepted (`PeerRule::admits`, by `remote::address::classify`):
  Tailscale's addresses when Tailscale is chosen, private ones when the private network is, a public
  one never. A connection that is not taken is dropped unread. Loopback peers are taken at the
  listener on this computer itself (`PeerRule::of(listen, true)`, the owner's choice "This computer
  only") and, for tests and the rig, by `PeerRule::with_loopback` (not compiled into a release
  build).

### The connecting side

A desktop adds a hosting desktop in the same dialog and by the same steps as a standalone engine
("Adding a remote engine" above), with these differences. All of them follow from one fact the
engine says about itself: `GET /api/host` answers `mode: "host"` at a door.

- What is pasted is a one-time code. The scope check (step 4) is not made: a code may read no list.
- Step 5 must succeed. `POST /api/standalone/clients` with the code makes this desktop's own token,
  which is a member's. When the hosting desktop makes none, nothing is saved and the dialog says
  E18, "That code was already used or has run out. Ask for a new one." What was pasted is never
  kept: a code is nothing after its use, and pasting the token of a computer that is already in must
  not make two computers one. The same holds for Replace token.
- The connection is called by the hosting computer's name (`computer`) unless the user typed one.
- The saved record has `mode: "host"`, and the connection's view says `mode` (`host` or
  `standalone`) and `scope` (`member` or `full`).
- Everything after that is the link as it is: it reads the feed made for a member, so its list
  holds the organizations this desktop was given and no other; one that is given later arrives on
  the open connection. A request to an organization whose switch went off is answered by the
  hosting desktop with 403 and code `E16`, and that answer reaches the window as it is. Removing
  the connection removes this desktop's own record there.

### Where the door listens

`remote_access/lifecycle.rs`. The door exists only while at least one organization is shared.

- The owner chooses where, each place by itself (`Listen {tailscale, lan, local}`; user ruling
  2026-11-14, remote access is not limited to Tailscale). `plan` is the one place that says where:
  this computer's Tailscale IPv4 address when Tailscale is chosen and `remote::address::classify`
  calls the address Tailscale's; its address on the local network when the private network is chosen
  and the address is a private one; and `127.0.0.1` when "This computer only" is chosen, which is
  where an SSH tunnel (`ssh -L`) or a local https proxy (Caddy, cloudflared, ngrok) hands
  connections on. Nothing else, ever: no public address, no `0.0.0.0`, no port below 1024. A
  separate listener is bound to each address. `PUT /api/remote-access` takes `tailscale`, `lan` and
  `local`; a save that leaves none chosen is refused (400).
- The addresses are read as the phone door reads them (`phone::tailscale`, `phone::lan_ipv4`), every
  30 s while something is shared. Tailscale that does not answer says nothing: its address is taken to
  be what the door has.
- `decide`: what the owner changes (a switch, the port, a place to listen) takes effect at
  once, in the request that changed it (`refresh`). An address that moved by itself is followed only
  when two readings in a row agree (5 s apart), so one odd reading never closes a door people work
  through. An address the door could not be bound to is tried again at every step.
- When the door leaves an address, every connection of every computer is ended
  (`Registry::close_all`): they come back through where the door stands.
- `status`: `state` is `closed` (nothing is shared), `open`, `waiting` (something is shared but this
  computer has no address the door may stand at; `reason` says so) or `blocked` (the port is taken;
  `reason` names it), and `addresses` are where it stands: `kind` (`tailscale`, `lan`, `local`), `ip`, `port`,
  `url` (with the MagicDNS name when Tailscale has one) and `encrypted` (true on Tailscale only; at
  `local` the tunnel or proxy in front encrypts, which the engine cannot see). The status also says
  the three choices (`tailscale`, `lan`, `local`).
- A switch that could let nobody in is not turned on: `PUT .../orgs/{slug} {"on": true}` answers 409
  with the reason when none of the chosen places has an address: Tailscale is chosen and not
  running, the private network is chosen and this computer has no private address. With "This
  computer only" chosen there is always a place. Switching off is never refused.
- The loop (`start`, a desktop only) also looks every 5 s at who is connected while the door stands,
  writes `connected` and `disconnected` into the organizations' histories when someone came or went,
  pushes the app value `remote_access` (the answer of `GET /api/remote-access`) to this desktop's own
  windows when anything changed, and tidies the registry (`Registry::tidy`). A computer that is away
  for less than one look leaves no record.
- While nothing is shared the loop rests a minute at a time. An owner's change wakes it
  (`Doors::wake`, called by `api.rs` `settled`; the loop's wait is `rest`), so a switch that has just
  gone on is looked at in the next step and not when that minute is over. A wake that finds the loop
  busy is kept for its next rest. The hosting proof found this: before it, a computer let in within
  the first minute was missing from the owner's list and chip, and from the history, until the minute
  ended (`an_owners_change_wakes_the_doors_loop_out_of_its_idle_minute`).
- A rig run never listens beyond this computer: the door goes to the loopback address
  `ORGTREE_RIG_REMOTE_DOOR` names, in a debug build, or nowhere. A unit test never asks the computer
  for its addresses at all: it goes by the reading it fixed (`Doors::fix`).

### The firewall rules

Windows Firewall lets nobody reach a new listener by itself, so the door needs rules. There are two,
both inbound, TCP, for the door's port and for the engine's program only:

| Rule | Remote addresses | Profile | When |
| --- | --- | --- | --- |
| `Orgtree remote access` | Tailscale's (`100.64.0.0/10`, `fd7a:115c:a1e0::/48`) | any | only while Tailscale is chosen |
| `Orgtree remote access (private network)` | `LocalSubnet` | Private | only with the private-network choice |

They are two because one rule has one profile: the private network's rule must not hold on a network
Windows calls Public, and Tailscale's must hold whatever Windows calls its adapter. They are separate
from the phone door's rule (`Orgtree phone access`), so turning one off never takes the other's.
The door on this computer itself (127.0.0.1) needs no rule: Windows Firewall does not filter it,
and with that as the only place `door.firewall.state` is `ok` and Windows is never asked.

- **Adding and removing is the desktop's**, behind one administrator prompt
  (`apps/desktop/main/remotefirewall.ts`, as `phonefirewall.ts` does for the phone door): the engine
  may run where there is no desktop to show a prompt on. The page says the port and the choice
  (`desktop:remote-access-firewall {port, lan, tailscale}`; the bridge's
  `addRemoteAccessFirewallRule`; a page that does not say `tailscale` means yes, as before); main
  checks them (an integer from 1024 to 65535, booleans) and finds the engine's program itself, the way
  the launch does. Without that program nothing is added: there is never a rule for every program. The
  script removes the door's earlier rules first, so a changed port or choice leaves nothing of the old
  one. `removeRemoteAccessFirewallRule` removes both.
  The window asks Windows only when what the rules are for changes: the port, Tailscale or the private
  network (`changeListening`). A place that was switched off loses its rule in the same step (the script
  removes both and adds what is still needed; with neither left, the rules that are there are removed).
  Switching "This computer only" alone asks nothing. The engine reads the rules again when such a save
  changes something while an organization is shared (`api::listening`, as `api::switch` does), so the
  answer never offers Allow for a rule just added or Remove for rules just taken out.
- **The engine only reads** (`remote_access/firewall.rs`): one PowerShell whose every command is a
  `Get-`, for the two names. `door.firewall` in the owner's answers is `{state, present}`. `state` is
  `none` (not Windows), `unknown` (not read yet, or it could not be read: nothing is claimed), `ok`,
  or `missing`: the door, as the owner chose it, is not let in, which the windows show as "Windows
  Firewall is blocking this" with **Allow**. A rule lets the door in when it is enabled, inbound,
  allowing, for exactly the door's port and for this engine's own program (two ways of writing one
  file's path are one program); Tailscale's rule is wanted while Tailscale is chosen, the private
  network's while that is. The rule's addresses and profile are not judged: a rule changed by hand is its owner's.
  `present` says a rule of the door's is there at all, so it can be offered for removal once nothing is
  shared.
- **The order in the windows** (`turnOnOrgAccess`, `changeListening` in the renderer's
  `remoteaccess.ts`): the engine is asked first whether the switch could be turned on at all
  (`?fresh=1` answers `refusal`), then Windows, then the switch. A No at the prompt leaves the switch
  off, as it does for phone access. The rule comes before the door because a program that listens
  with no rule makes Windows ask its own "allow this app?" question, and a No there leaves a blocking
  rule that beats ours. A changed port or choice while something is shared asks Windows first too,
  with what the door will have.
- **When it is read.** Never on a timer: a reading starts a process. `GET /api/remote-access` and
  `GET .../orgs/{slug}` answer what is known and, when that is older than 30 s, read again behind the
  answer and push `remote_access` if it changed. With `?fresh=1` the answer waits for a reading: the
  app asks so right after it added or removed a rule. Turning a switch on reads before it answers,
  because the desktop adds the rules just before it asks for the switch. A changed port or choice
  needs no reading: what is known is judged against what the door needs now.
- A unit test reads nothing of the computer (`Firewall::fix`), and a rig run reads the file
  `rig-home\rig-firewall\remote-access.txt` (what the read would print) instead of the firewall.

### The registry

`<data>/remote-access.json` (`remote_access/registry.rs`), version 1. Everything the owner decided
about remote access is in this one file and none of it is in a database:

```json
{ "version": 1, "port": 7431, "lan": false,
  "open": ["<organization uuid>"],
  "clients": [{ "id": "<uuid>", "name": "Orgtree desktop (PC2)", "label": "Sam", "orgs": ["<organization uuid>"],
                "hash": "<sha-256 of its token>", "created_at": "...", "last_seen_at": "..." }],
  "invitations": [{ "id": "<uuid>", "hash": "<sha-256 of the code>", "org": "<organization uuid>",
                    "created_at": "...", "expires_at": "..." }] }
```

- `open` is the switch: the organizations other computers may open. `port` is the door's (7431
  unless the owner chose another, never below 1024); `lan` says whether the door listens on this
  private network, `tailscale` whether on Tailscale and `local` whether on this computer itself.
  The last two are written only when they differ from what a file without them means (Tailscale
  yes, this computer no), so an engine from before them still reads the file.
- Why a file and not the organization's settings in its database (decision 103 says "a per-org
  setting", and to the owner it is one): the door must know what is shared before any database is
  read, and an organization that is restored from a backup, copied, or made from a template must
  never come up shared. A deleted organization's switch goes off (`remote_access::org_deleted`).
- A **computer** holds its own token (64 hex digits) for the organizations it was given. An
  **invitation** is a one-time code (26 characters of Crockford base 32, 130 random bits) for one
  organization, valid 15 minutes. Both are stored as hashes only and shown once.
- Organizations are named by uuid, so renaming one moves nobody's access.
- At most 32 computers and 5 open codes per organization.
- A code does three things and nothing else: `GET /api/desktop/alive`, `GET /api/host`, and
  `POST /api/standalone/clients {"name"}`, which makes the one computer the code is for and uses the
  code up in the same write. The answer carries the computer's token.
- `give` adds an organization to a computer that is already known (no code). `revoke` removes the
  record and ends every connection the computer has open, the asking one too. Switching an
  organization off (`Registry::set_open(uuid, false)`) ends the connections of every computer that
  has it, takes back the codes that are open for it and keeps the computers' records; `stop_all`
  does that for every organization at once.
- Every change is one write of the whole file, and what the door goes by changes only when that
  write succeeded (`commit`).
- One lock admits a token and commits every change, so a connection is never registered after its
  record was removed.
- A file that cannot be read as a registry lets nobody in: it is renamed
  `remote-access.broken-<time>.json` and the registry starts empty.

### The door's guard

`remote_access::admit`, called by `http::guard` for a connection that is the door's, before any
handler or dispatch. In order:

0. An address that was refused too often is answered 429 (`limiter.rs`): after 10 requests within a
   minute that showed no token the door knows, for a minute, to every request that shows none. A
   token the door knows (a computer's, or a one-time code) is still heard, unless the request names
   an `Origin`: behind an SSH tunnel, a local https proxy or a shared router every caller has one
   address, and somebody's guessing must not shut out the computers that were let in (user ruling
   2026-11-14). What a known computer is refused (step 7) is never counted.
1. The desktop token header and `X-Orgtree-Remote` are removed from the request. Neither is read.
2. A path outside `/api/` is 404. The door serves no page, and the language-server proxy and the
   credential bridge are never dispatched for it.
3. A request with an `Origin` header is refused: a page is never a caller. The exception is the app
   media route with `Origin: null` (a sandboxed panel frame).
4. The app media route (`GET /api/orgs/{slug}/apps/media`) without a token is let through for an
   organization whose switch is on; its handler checks the ticket's grant, as on a standalone engine.
5. The token is `Authorization: Bearer` and nothing else. One the registry does not know is 403
   `remote access token required` (the connecting side reads that as E4, "no longer accepts this
   computer's token").
6. A code: its organization's switch must be on, and the request must be one of its three.
7. A computer: `member::verdict`.

The other direction holds by construction: the app's own listener compares the desktop token header
and never reads `Authorization` (`http::guarded`), so a door token is nobody's there.

A request from the door is never carried on to another engine (`http::guarded` asks the relay for
nothing): a hosting desktop is no way into the engines it is connected to.

### What a member may do

`remote_access/member.rs` is a fail-closed table. Every route of `http::router` is in exactly one
of its lists, and `every_route_is_classified_for_members` fails for a route that is in none.

| List | Means |
| --- | --- |
| `ORG` | a route below `/api/orgs/{slug}/`: every method, for an organization the member was given whose switch is on |
| `READ` | `GET` and `HEAD` only: the organization itself (deleting it is its owner's), `/api/desktop/alive`, `/api/host`, the app feed made for a member (`/api/app/ws`, `/api/app/records`), and what a window of an organization needs of the app: `/api/providers`, `/api/accounts`, `/api/harnesses`, `/api/skills`, `/api/charters`, `/api/templates`, `/api/defaults`, `/api/mcp-servers`, `/api/fs`, `/api/markdown-image` |
| `OWN` | its own client record: `GET /api/standalone/clients` (one row and `you`), `PATCH` and `DELETE` of its own id |
| `REFUSED` | everything app-wide and everything of the hosting computer; and two routes below an organization that reach beyond it: `/mcp` and `/template` |

**What this table is, and is not (user rulings 2026-11-14).** A member is trusted with the hosting
computer as an SSH sign-in under the owner's account is: its organizations' agents run commands
there, and routes in `ORG` and `READ` read host files by a path (attachments, the file route,
`/api/fs`, an image by path). That is by design ("Drop the 3 fixes"). The table scopes a member's
windows and API calls to the organizations it was given and refuses app-wide writes, so shared work
stays where it was shared and nothing app-wide changes by accident. It is workspace scoping, and
`shown.rs` is courtesy privacy (the owner's e-mail addresses stay out of lists). Neither is a
security boundary against a member.

- An organization that is not the member's and one that does not exist are refused alike (403, code
  `E17`, "This belongs to <computer>."), so a member's window is not shown what else the desktop has.
- An organization it was given whose switch is off is 403 with code `E16`.
- A new route must be put in a list. A route of an organization goes in `ORG` unless it reaches
  beyond the organization; anything else goes in `REFUSED` unless a computer that was let in must
  read it, and then its answer holds nothing of the owner's that a window has no use for (no e-mail
  address, no other organization): courtesy, not secrecy.
- Still in `REFUSED` among the reads: the usage routes (they read the provider again: refreshing
  is the owner's), the model servers, OpenRouter, the changelog and the organization list
  (`GET /api/orgs`: a member's list is its app feed). A window of a hosted organization shows those
  pages without their figures until each answer has been looked at; the Usage panel's figures come
  from the app feed (below), and its Refresh buttons answer "This belongs to <computer>."
- **Usage (4.6.2, USER 2026-11-17 m1b95cceba206 "Show all members").** A member is sent the owner's
  usage values, the same readings the owner's own Usage panel and badge show. Before, its Usage panel
  waited forever for a value that never came (USER mb356fe1b5546). The panel now says "Usage could
  not be loaded: …" when a read fails or is refused in any window, and in a member window of an owner
  before 4.6.2 that the owner sends no usage. Residual: a provider's error text inside a reading
  (a CLI's message) can name a path on the owner's computer; it is shown as it is, like other
  answers a member reads.

### What a member is sent

Two rules (`remote_access/shown.rs`), and one place that applies each.

- **The owner's e-mail addresses are not shown.** Every JSON answer to a member (`shown::answer`,
  called by `http::guarded`), every frame of an organization's socket (`feed/socket.rs`) and every
  value of the app feed passes `shown::hide`. A text that *is* one of the addresses this engine knows
  its accounts and sign-ins by is replaced by the account's id (the row's own account when it names
  one, so a picker still tells two accounts apart); a member called `email` that holds one becomes
  null. A text that merely contains an address is the organization's content and is left as written.
- **An app-wide answer holds no address at all and names no other organization.** For a path that is
  not an organization's, every member called `email` is nulled whatever it holds, a text that has the
  shape of an address is replaced whether the engine knows it or not, and the members that say where
  else an account is used (`bound`, `origin_org`, `host_identity`) are removed. `bound` is the one
  an app reads of every account row, so a row that had it keeps it as an empty list, with
  `bound_hidden: true` beside it: an app made before 4.7.0 reads `bound.length` unchecked and failed
  on a row without the member (App settings of a 4.6.9 window on a hosting 4.7.0-alpha.1, report
  2026-11-24; the member was removed since 4.6.0). The renderer makes every account row whole
  before it reads it (`normalizeAccountRows`, both the request and the pushed value), shows such a
  row's agents as "not shown", never as none, and does not offer its removal.

This keeps addresses out of lists. It is not a wall: a computer that may run the organization's
agents on the hosting computer can learn whose account they run under.

**The app feed of a member** (`appfeed::Audience::Member`, decided from the token's scope): the
registry, the summaries, the notices and the working counts of the organizations it may open now
(given to it, switch on) and of no other; of this computer's values only `MEMBER_VALUES` (`providers`,
`accounts`, and the usage values: the four provider lanes `usage`, `codex_usage`,
`antigravity_usage`, `muse_usage` with their `*_peek`, `registered_usage`, `openrouter_keys_usage`,
`openrouter_usage_peek` and `langserver_usage`), each through `hide`. Not sent: model-server
configuration (`langservers`) and the OpenRouter document (`openrouter`). It is never among the windows a frame is broadcast to: what it
gets is made for it (`to_members`, `member_frames`, `member_value`). When what a member may open
changes (a switch, an organization given), `lifecycle::publish` tells the feed and each member's
sockets are sent their registry and what they see of it again, on the connection they have. A member
whose organization was switched off, or that was revoked, loses its connections with that.

`GET /api/host` gains `mode` (`standalone`, `host` at the door, `desktop` on a desktop's own
listener) and `computer`.

### The owner's routes

`remote_access/api.rs`, for the desktop's own app alone. They are below `/api/remote-access`, which
is this computer's (`remote/routes.rs` `LOCAL`: a window of a remote organization is never served
another engine's); at the door they are in `member::REFUSED`; a viewer token is denied them; and each
handler refuses a request that carries any token scope. A standalone engine answers 404 (it has client
tokens for this). `{slug}` must be an organization of this computer: a remote organization cannot be
shared on.

| Route | Does |
| --- | --- |
| `GET /api/remote-access` | `computer`, `port`, `default_port`, `lan`, `door` (`lifecycle::status`), and per organization `slug`, `name`, `on`, `computers`, `connected`, `connected_now` (`id`, `label`, `name`, `since`). Also pushed to this desktop's windows as the app value `remote_access` |
| `PUT /api/remote-access {"port"?, "lan"?}` | the door's port (1024 to 65535) and the private-network choice |
| `POST /api/remote-access/stop` | every switch off, every connection ended, every open code taken back; the computers' records stay |
| `GET /api/remote-access/orgs/{slug}` | `on`, `door`, `computers` (that have it), `known` (computers of other organizations, which can be given this one), `invitations` (id and times, never a code), `limits` |
| either `GET` with `?fresh=1` | the same, after Windows Firewall was read again ("The firewall rules" above). The organization's answer also has `refusal`: the sentence turning its switch on would be refused with now, or null. This computer's addresses are read for it; nothing is changed |
| `PUT /api/remote-access/orgs/{slug} {"on"}` | the switch. Turning it on is 409 with the reason while the door would have nowhere to stand |
| `POST /api/remote-access/orgs/{slug}/invitations` | a one-time code: `id`, `code`, `created_at`, `expires_at`, `minutes`. 409 while the switch is off |
| `DELETE /api/remote-access/orgs/{slug}/invitations/{id}` | take a code back |
| `PUT /api/remote-access/orgs/{slug}/computers/{id}` | give a known computer this organization (no code). 409 while the switch is off |
| `DELETE /api/remote-access/computers/{id}` | revoke: every organization it had, connections ended at once |

The bodies of these routes are never in the wire log (`http::quiet_body`): an answer can carry a code.

Each change is written into the organization's history as an event `remote_access` whose `detail.what`
is `on`, `off`, `code`, `code_withdrawn`, `computer_added`, `computer_given`, `computer_revoked`,
`connected` or `disconnected` (with `detail.computer`), and whose `via` is who did it: this desktop,
or the computer itself when it came in with a code, removed its own record, connected or went. The event is written beside the change, not with it
(`remote_access::record`): a database that is away must not keep the owner from switching remote
access off.

## Tests

`cargo test --bin orgtree-engine remote::` (no database, loopback only): the address rule, the sealed
store, route coverage, the handshake against a stand-in and against a real standalone test engine,
aliases, the routing rule, streaming and header hygiene, the instance stamp, the org socket, link
states, the offline answer, the merged list, removal and log privacy. The tests named `e1_` and `e6_`
cover the origin of a request, labels, who is connected and what a connection learns about itself,
against a real standalone test engine; `caller::` covers the origin itself, and `via_tests` what a
window is sent. What is recorded is proved with two real engines by the rig proof `remote-people`
(below).

`cargo test --bin orgtree-engine remote_access::` (no database, loopback only): a desktop engine with
its own listener and the door beside it, through the real router. The two listeners take only their own
tokens; the door serves the API and nothing else; a code makes exactly one computer, runs out, and
opens no organization; a member has its organization and is refused everything else, another
organization and a missing one alike; its own record only; revoke and the switch end connections; the
registry's file; the route table by itself, every route classified. The owner's routes: the whole
round from switching on to revoking, that only the desktop itself reaches them (not a member, a code,
nobody, a door token on the app's listener, or a standalone engine), stop all, the port, and the limit
on refused tokens through the door. Where the door stands: the plan and the decision by themselves
(`lifecycle::tests`), and with real listeners on loopback: no door while nothing is shared, a door at
once when something is, the port followed, a taken port said and retried, and gone when everything is
off; a door with nowhere to stand waits and says why; a switch that could let nobody in is refused; who
is connected now. What a member is sent: the two rules by themselves (`shown::tests`), and through the
door: its app feed holds its organizations and two values and nothing else (no address, no other
organization, no connection of this computer), a second organization that is given arrives on the open
socket, a change in an organization it may not open does not, and every answer passes the filter. The
connecting side, with two engines: what is not a code makes nothing and is not kept (a guess is E4,
another computer's token E18), a code makes this desktop's own member token and is used up, the link
lists what was given, a relayed request reaches the hosting desktop, a second organization arrives, a
switched-off one answers E16 through the relay, and removing the connection removes the record there.
The firewall rules: the read as PowerShell prints it, which rules let the door in, that the read only
reads, the engine's own program however its path is written (`firewall::tests`), and through the
owner's routes: nothing claimed before a reading, the reading behind the answer, `?fresh=1`, the
private-network choice and a changed port judged at once, an unreadable firewall, a member refused
without a reading, and the switch reading before it answers.

`node tests/run.mjs tests/remote-access-firewall.test.mjs` (the desktop's side): the exact script for
each choice (port, program, remote addresses, profile, the old rules removed first), that no rule is
for every address or every program, the quoting of a program's path, a port the door may not have,
removal, one prompt and what it came to (allowed, declined, failed, no engine program) with a recorder
in place of the prompt, that PowerShell parses both scripts, that the engine knows the rules by the
same names, and what main takes from the page. It never changes this computer's firewall.

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

For a hosting desktop, main adds and removes the door's Windows Firewall rules
(`main/remotefirewall.ts`, "The firewall rules" above; `tests/remote-access-firewall.test.mjs`).

### A hosting desktop's windows

`src/remoteaccess.ts` (the pushed value `remote_access`, the owner's routes, the order of a change,
the words) and `src/canvas/remoteaccess.tsx`. Everything is built from a sibling's piece: the
Connections tab's group, rows and switch, the provider dialogs' frame, the shared confirmation, the
status strip's chip.

- **Org settings, Connections, "Remote access"** (`RemoteAccess`, at the end of the tab). Shown only
  where this computer can share: an organization of its own, on a desktop's own engine. The value
  `remote_access` is absent on a standalone engine, and an organization on a remote engine has no
  block (no chains). The switch "Let other computers open this organization" with its plain
  sentence; while on: where the door stands (each address with Copy, and how the bytes travel), the
  door's trouble when it has any, "Windows Firewall is blocking this" with Allow when the engine
  read that the rules are missing, the list Computers (the name others see, what the computer calls
  itself, added, connected since or last seen, Revoke behind a confirmation that says how many
  organizations go), and "Add a computer...". Switching off while somebody is connected says first
  who loses it.
- **Add a computer** (`AddComputerDialog`): one code is made for one opening of the dialog. It shows
  the address, the code (shown here once), both in one line to send, and how long the code holds;
  under it the computers that have another organization of this computer, each with "Give access"
  (no code). The engine's refusal (five open codes, the switch off) is the sentence under the rows.
- **App settings, "Remote access"** (`RemoteAccessSettings`; the tab is listed only where the value
  exists, and is one of this computer's in a remote organization's window): where it listens
  (three switches: Tailscale, this private network, this computer only), the port, what the door does now, the
  organizations that are shared with how many computers each has, "Stop all remote access" behind a
  confirmation, Allow when the rules are missing, and "Remove the rules" when nothing is shared and
  the rules are still there. Opening the page asks the engine once, which reads Windows Firewall
  behind its answer.
- **The chip** (`SharedChip`, in the status strip's lead beside the remote chip): "1 computer
  connected" while another computer is connected to this organization, who in the tooltip, a click to
  the Connections tab. It is pushed; it asks the engine nothing.
- **Streamer mode**: addresses and a computer's own name are host fields; the code, and the line with
  address and code, are secret fields; the name others see is an external name.
- **The other computer** (`shell/remotes.tsx`, `remotes.ts`): the connection's view says `mode` and
  `scope`. Connection details reads "Signed in as ... · these organizations only" for a hosting
  desktop. The Add dialog's Address field takes the one line with address and code and fills both
  fields (`addressWithCode`), unless a token was typed already. A window of an organization its
  hosting desktop no longer shares has the banner "<name> no longer shares this organization."
  (`noLongerShared`: connected, a hosting desktop, the organization gone from its list). In such a
  window App settings says that the hosting computer's settings can be read and that a change is
  refused with its sentence (E17); the controls themselves are not disabled yet.

Not built: links from the App settings page to each organization's settings (the page names them and
says where the switch is), and disabled controls on the hosting computer's settings in the other
computer's window.

The glossary page is `docs/skills/orgtree-app/app-settings/app-remote-access` (every row of the two
screens has its home there; `tests/skills-tree-coverage.test.mjs` fails for a row without one). The
Connections page and the homepage's page point to it.

Tests: `apps/desktop/renderer/tests/remoteaccess.test.tsx` (F-T8): the words; the order of turning
on, with the bridge as a recorder; the block from off to on, the address, the computers and Revoke,
and no block for a remote organization or where nothing is offered; a No at the prompt, a door that
cannot stand, Allow; Add a computer with its code, the one line, a known computer, and a refusal; the
App settings page; the order of a change of port or choice; the chip; and the other computer's
side.

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
remote engine's values), a question of a remote organization among this computer's notices, and the
Files panel's routes: a 32 MiB file goes to a remote agent's scratch folder and comes back whole, a
name that is taken is refused, Keep both and Replace do what they say, the folder comes as a zip that
reads back, and nothing is listed, read or written outside the folder (by `..`, by a drive, through a
junction the proof puts there). What it measured is in the evidence folder (`files-round-trip.json`).
With a bundle it drives the desktop too (`desktop/remote-org.cjs`), in four
windows: the Homepage (the Add dialog, the list marks), the remote organization's window (its chip and
Connection details, a message with a streamed answer, the desk's docket, presentations and mail, a
question on the desk and in the user's inbox, hire and retire, the outage under the open window with
the refused send and its kept draft, recovery without a reload, the reload after the remote restarts,
the sign-in banner and Replace token), a local organization's window beside it, and the window of
the remote organization that goes by an alias here (its desk opens; the scratch-folder entry opens
the Files panel, which lists the folder on the remote engine and opens a folder in it; a reference written under the name it has there is that window's own
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
Measured 2026-11-14 with the Files routes: with a bundle 67 checks, 33 captures, 125 s; without one 48 checks
in 40 s (one check was added after that run). On loopback with debug engines the 32 MiB file went up in about
55 ms and came back in about 420 ms, and the folder's zip took about 475 ms (three runs).
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
so the proof waits for the tree where it reads one after a write. 34 checks.
`tools/rig/far.mjs` starts the far engine for both proofs.

With a renderer bundle (`--ui <bundle>`, Session 0 only; about one more minute) a window of this
desktop opens on the far organization (`tools/rig/desktop/remote-people.cjs`) while the proof keeps
playing the second computer: the page script asks for one thing she does at a time through a small
control server on loopback (`tools/rig/steps.mjs`). The proof names this computer PC-SAM (`setup()`
sets `COMPUTERNAME` before the run's engines start), so a capture carries no name of the machine it
ran on. 16 more checks (50 in all) and 14 captures in the evidence folder's `desktop-window/`:

| Capture | What it shows |
| --- | --- |
| 01 | her message in the transcript reads "User · PC-DANA", this desktop's own "User"; once delivered nothing stays queued |
| 02 | the agent's mail list says "@user · PC-DANA" |
| 03 | a question she answered: the answer in the transcript is hers |
| 04 | the same request in the user's inbox: "answered by PC-DANA at 16:45" |
| 05 | the organization's record: "User · PC-DANA" for hers, "you" for this desktop's own |
| 06, 07 | Connection details: "Shown to others as" and "Also connected"; the name changed there is this desktop's label on the far engine |
| 08 | a text edited here that she changes underneath: "This changed while you were editing." |
| 09, 10 | Save is refused: who changed it and when, what was typed is kept; her version; "Save mine anyway" stores this computer's text |
| 11 | undoing her change asks first; Cancel undoes nothing |
| 12 | a setting she set first: the row goes back and a toast offers "Use mine" |
| 13 | org.md she saved meanwhile: the notice in its editor, this computer's text still there |
| 14 | the History tab: "by PC-DANA" |

A step that misses does not end the script: the log says what the window showed instead and a
`missed-NN.png` is kept, so one run names every miss. Nothing may stay open over what follows: the
script waits for each dialog to close (an undo question left open once swallowed every later click).

### The hosting proof

`tools/rig/proofs/remote-host.mjs` (test F-T10; engines only, any session): two real engines, each
with its own database. The far one is a DESKTOP's own engine, started as an app starts its engine
(`tools/rig/far.mjs` with `desktop`: `serve`, a desktop token, a port it picks, the name PC-HOST),
with its remote door on loopback (`ORGTREE_RIG_REMOTE_DOOR`). The run's own engine is the other
computer (PC-SAM), and a third computer (PC-DANA) is played by the proof straight at the door. What
the far engine "reads from Windows Firewall" is a file the proof writes
(`rig-home\rig-firewall\remote-access.txt`); nothing asks Windows for anything.

It checks, in this order: nothing is shared at first; asked first, the engine says the switch could
go on and that the door is not let in yet; the switch goes on and the door stands at the chosen
port; the door answers no request without a token, and the desktop's own token is nothing there; a
code says whose door it is and reads no organization; this desktop adds the hosting desktop with
the code (called by that computer's name, a member, with a token of its own) and lists only what it
was given; the code is spent and was not kept; the owner sees the computer in the list and in the
pushed value; the organization opens through the relay; an app-wide change is refused with E17 as
the hosting desktop's own answer; the accounts are read without an e-mail address; a message runs
the agent there and the owner reads whose it was, while the agent reads "user"; the organization's
history says what happened and who did it; a member's token at the door opens its organization and
is refused another organization, the list of all, the owner's routes, a new code, the deletion and
the usage, each with E17, and is no token on the desktop's own listener; a code the owner took back
opens nothing; a second organization is given with no code and arrives on the open connection,
and the third computer gets nothing by that; switched off, the organization answers E16 while the
other one stays open and this desktop's list marks it; switched on again, the same computer is
back with no new code; its user disconnects and connects again, and the owner sees it leave (with
when it was last seen) and come back, with both in the history; after a restart of the hosting desktop the switches, the port and the
computers are as they were, the door is open, and this desktop comes back with the token it has; a
revoked computer is out at once while the other stays, and both histories say so; "Stop all remote
access" turns every switch off and takes the door away while the lists stay; and every kind of
record `remote_access::record` writes is read back from the two histories. 31 checks, 42 s
measured (2026-11-13).

With a renderer bundle (`--ui <bundle>`, Session 0 only) two windows follow, one after the other,
with the page script `tools/rig/desktop/remote-host.cjs`: first a window of the HOSTING desktop (the
far engine serves the same bundle; `runDesktop` is handed its address and token), then a window of
this desktop. The planted bridge's two firewall calls are a recorder that the script answers (a No,
then a Yes), and `window.confirm` is recorded and answered Yes. The proof plays Windows: it writes
the rules file when the script says the administrator agreed, and empties it for "the rules went
missing". The page script hands the proof the line the Add a computer dialog shows (a step of
`tools/rig/steps.mjs` can be handed one JSON value), and the proof adds the hosting desktop with it
as the other computer. 19 more checks (50 in all; the whole run took 144 s, measured 2026-11-13) and
15 captures in the evidence folder's `desktop-window/`:

| Capture | What it shows |
| --- | --- |
| 01 | Org settings, Connections on the hosting desktop: the group Remote access, the switch off, its sentence |
| 02 | a No at the administrator prompt: the switch stays off, "Nothing changed: Windows Firewall stays as it was." |
| 03 | a Yes: the switch on, the address with Copy, the computers, "Add a computer..." |
| 04 | Add a computer: the address, the one-time code, both in one line |
| 05 | the other computer used the line: it is in the list, connected |
| 06 | the chip "1 computer connected" on the status strip |
| 07 | its message in the transcript reads "User · PC-SAM" |
| 08 | the rules went missing: "Windows Firewall is blocking this" with Allow |
| 09 | App settings, Remote access: where it listens, the port, what the door does now, the organizations, Stop all |
| 10 | Revoke asks first and says what goes |
| 11 | this desktop: one pasted line fills Address and Token of "Add a remote engine" |
| 12 | the hosting desktop in the list under its computer's name, with the organization it shares |
| 13 | Connection details: "these organizations only" |
| 14 | App settings in the organization's window: whose computer it is, and that a change is refused |
| 15 | the hosting desktop stopped sharing the organization: the window says so |

What to know when reading them, or when changing the page script:

- The rig's click does not scroll. The group Remote access grows downward when its switch goes on,
  so the script brings the group's end into view before every click and capture in it (`showGroup`);
  the first run clicked "Add a computer..." below the fold and hit nothing.
- With a desktop bridge, App settings opens on Providers, which reads whether a sign-in is running:
  the planted bridge answers `getProviderLoginStatus` (none is). Without it the page stops with the
  app's crash screen.
- The switch's toast is still up in 03 to 06 and covers the right end of the last row in 03 to 05;
  08 is the clear view of the whole group.
- 04 shows a one-time code in clear. It was used a second later and its engine is gone; the JSON
  evidence keeps only its length.
- 07 shows two messages of the same computer: the engines' part sent the upper one, and the window
  looks for the lower one by its text (it may still be queued when the capture is taken).
- 09 shows Tailscale switched on (it said "Tailscale only" until the three switches) beside a loopback address: the rig's door is where
  `ORGTREE_RIG_REMOTE_DOOR` puts it.

## Not yet

Creating an organization on a remote engine, watch-only
windows with a viewer token. No app panel action opens a file dialog of this computer today; one
that does must be refused for a remote window (`REMOTE_APP_ACTION` in `remotehere.ts` is its sentence).
