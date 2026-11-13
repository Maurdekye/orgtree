# Remote access: what a security reviewer needs

A desktop can let other computers open some of its organizations (decision 101, phase F; contract in
[remote-org](remote-org.md#a-desktop-as-host)). That is a new way into a personal computer, and it
ships only after a reader who did not write it has gone through this page against the code.

This page is kept true with each landing. Every line of the tables says whether it is **built** (with
the test that pins it) or **planned** (with the part of the phase that brings it). Nothing planned is
reachable in a running app: until the switch lands, no door is ever opened.

## What is exposed

One more TCP listener on the hosting desktop, the **door** (port 7431 by default). It speaks the
engine's HTTP API and its WebSockets, in plain http. It exists only while at least one organization
has remote access switched on.

## Who is trusted with what

| Party | Trusted with |
| --- | --- |
| The owner (the desktop's own app, loopback, desktop token) | everything, as today |
| A computer that was let in (a **member**) | the organizations it was given, wholly: it can make their agents run commands on the hosting computer under the owner's account. Nothing app-wide, no other organization |
| The holder of a one-time code | making one member for one organization, within 15 minutes |
| Anyone else who can reach the door (the tailnet, or the private network by choice) | nothing |
| Anyone on a public network | not even a connection |

A member is trusted with the hosting computer to the extent that its organization's agents are. The
switch says so in plain words ("add only computers you trust with it"). The boundary this page
defends is therefore not "a member cannot harm the host" but: **only computers the owner let in get
in; each gets only the organizations it was given; nothing app-wide (accounts, sign-ins, tokens,
other organizations, the hosting app itself) is readable or writable through the door; and the owner
can end any computer's access at once.**

## Threats and what answers them

| # | Threat | Answer | Where | Status |
| --- | --- | --- | --- | --- |
| 1 | Someone on the internet reaches the door | It is bound to the Tailscale address and by choice the private-network address, each only when `classify` calls it that; never a public one, loopback or `0.0.0.0`. A peer at a public address is dropped unread. The door does not exist while nothing is shared | `lifecycle.rs` `plan`, `door.rs` `PeerRule` | **built** (`the_door_is_planned_at_the_tailscale_address...`, `the_door_stands_only_while_something_is_shared...`, `a_door_with_nowhere_to_stand...`, `the_door_takes_tailscale_peers...`, `a_peer_the_door_does_not_take...`). The Windows Firewall rules are no wider: Tailscale's addresses, and the local subnet on Private networks by the same choice (row 19) |
| 2 | Someone on the tailnet or LAN guesses a token or code | Tokens are 256 random bits, codes 130; compared by hash in constant time; requests that show no known token are counted per address: 10 within a minute close the door to that address for a minute (429 to everything, a good token included) | `registry.rs`, `limiter.rs`, `admit` | **built** (`an_address_that_is_refused_too_often...`, `limiter::tests`) |
| 3 | A code leaks (chat, screen share) | One use, 15 minutes, one organization; used up in the same write that makes the computer; the owner sees the new computer in the list and can revoke it; a code for an organization switched off opens nothing | `registry.rs` `redeem`, `admit` | **built** (`a_code_makes_exactly_one_computer...`, `a_code_runs_out...`, `a_code_for_an_organization_that_was_switched_off...`) |
| 3a | A token (not a code) is pasted into another computer's Add dialog, so two computers would share one token | The connecting side never keeps what was pasted at a hosting desktop: it must be given a token of its own, and a member token can make none (`POST /api/standalone/clients` is a code's alone). Nothing is saved | `remote/mod.rs` `add` and `update`, `member.rs` | **built** (`a_desktop_adds_a_hosting_desktop_with_a_code...`) |
| 4 | The registry file is read (backup, another local user) | It holds SHA-256 hashes only; the token and the code are shown once | `registry.rs` | **built** (`a_code_makes_exactly_one_computer...` reads the file) |
| 5 | A member reaches another organization | The route table asks, for the organization a path names, whether this computer was given it and its switch is on; anything else is refused the same way as an organization that does not exist | `member.rs` `verdict`, `admit` | **built** (`a_member_has_the_organization...`, `the_table_gives_a_member...`) |
| 6 | A member reaches something app-wide: accounts, sign-ins, defaults, instructions for all orgs, model servers, updates, the phone link, other computers' records | Fail-closed table: every route of the router is in exactly one list, and a test fails for one that is in none | `member.rs` | **built** (`every_route_is_classified_for_members`) |
| 7 | A member uses the hosting desktop's own privileges: the desktop token, the language-server proxy, the credential bridge, the renderer bundle | The door never compares with the desktop token and removes its header; only `/api/` is served; the two dispatches that bypass the API token are not asked for a door request | `admit`, `http::guard` | **built** (`the_door_and_the_apps_own_listener...`, `the_door_serves_the_api_and_nothing_else`) |
| 8 | A member token is used on the app's own listener (malware on the host that read a token off the wire) | That listener reads only the desktop token header, never `Authorization` | `http::guarded` | **built** (same test) |
| 9 | A member uses the host as a way into the engines the host is connected to | A door request is never relayed, and `X-Orgtree-Remote` is removed from it | `http::guarded`, `admit` | **built** (`the_door_serves_the_api_and_nothing_else`) |
| 10 | A web page in a browser on some computer of the tailnet calls the door (cross-site request, DNS rebinding) | No cookie or ambient credential exists: a request needs `Authorization: Bearer`. A request that names an `Origin` is refused outright | `admit` | **built** (same test) |
| 11 | A member changes who may come in: the switch, the lists, codes, the port | None of it is in an organization's settings or database: it is in `remote-access.json`, changed only by the owner's routes. Those are this computer's own (`LOCAL`, never relayed), in `REFUSED` at the door, denied to a viewer, 404 on a standalone engine, and each handler refuses any request with a token scope | `api.rs` `owner`, `member.rs`, `registry.rs` | **built** (`only_this_desktop_itself_reaches_the_owners_routes`) |
| 12 | A member deletes the organization | `DELETE /api/orgs/{slug}` is not in its table (`READ` is `GET` only) | `member.rs` | **built** (`a_member_has_the_organization...`) |
| 13 | A member learns other organizations' names, or the owner's e-mail addresses, from answers it may read (the app feed, accounts, providers) | Its app feed is made for it: its organizations only, two values, never a broadcast frame. An app-wide answer passes a filter that removes every address and every mention of where else an account is used; an organization's answer and socket frame lose the owner's known addresses where one is a whole text. Usage, model servers, OpenRouter and the organization list stay refused | `appfeed.rs` `Audience::Member`, `shown.rs`, `http::guarded`, `feed/socket.rs` | **built** (`a_member_is_sent_its_organizations_and_no_others...`, `an_answer_to_a_member_holds_no_address...`, `shown::tests`). Addresses are a courtesy, not a wall: see "Known and accepted". The twelve app-wide reads are listed one by one under "Review point" below: two of them take a path on this computer |
| 14 | A revoked computer keeps working on an open connection or socket | Revoke ends every connection the computer has open before it returns; the same lock admits tokens and commits the removal | `registry.rs` | **built** (`revoking_a_computer_or_switching...`, `a_member_reads_names_and_removes...`) |
| 15 | The switch is turned off but a connection stays, or a code made before still works | Turning it off ends the connections of every computer that has the organization and takes back its open codes; "Stop all" does it for every organization. The door goes by what was written: a change that could not be written changes nothing | `Registry::set_open`, `stop_all`, `commit` | **built** (same test, `stopping_all_remote_access...`, `the_owner_switches_an_organization_on...`) |
| 15a | An organization comes back shared without the owner saying so (a restored backup, a copy, a template, an organization deleted and restored) | The switch is not in the organization's data at all; deleting an organization switches it off | `registry.rs`, `remote_access::org_deleted` | **built** (the file: `a_registry_file_is_taken_as_a_whole...`; the delete hook is one line in `http/orgops.rs`, not covered by a unit test: it needs a database) |
| 16 | The traffic is read on the wire | On Tailscale the tunnel encrypts it. On a private network plain http is not encrypted; it is off unless the owner chose it, each address the door stands at says `encrypted`, and the connecting side labels the transport | `lifecycle.rs` `status`, the registry's `lan` | choice and status **built**; the words in the windows **planned** (renderer) |
| 17 | A broken or tampered registry file admits someone | A file that does not validate as a whole admits nobody; it is set aside and the registry starts empty | `registry.rs` `read` | **built** (`the_registry_survives_a_restart_and_a_broken_file...`) |
| 18 | A member's requests are attributed to the owner | Every member request runs with the member's origin (phase E), so what it does is recorded as its own | `admit` returns the origin | **built** for the origin (`a_member_reads_names...` reads `you`); events for connect, revoke and codes **planned** |
| 19 | Adding the firewall rules opens more than the door needs, or something makes the desktop add a rule for another program or run other text as administrator | The elevated script is made in main from three things: a port main checked (an integer, 1024 to 65535), a boolean, and the engine's program as main itself finds it, quoted as PowerShell quotes. The page sends the port and the boolean and nothing else. Each rule is inbound TCP for that one port and that one program, with remote addresses limited to Tailscale's, or to the local subnet on Private networks. Without the engine's program nothing is added. The engine never changes the firewall: its read is a constant script of `Get-` commands that no request's text enters, run for the owner only | `apps/desktop/main/remotefirewall.ts`, `main/index.ts` (`desktop:remote-access-firewall`), `remote_access/firewall.rs` | **built** (`tests/remote-access-firewall.test.mjs`; `firewall::tests`, `the_owner_is_told_whether_windows_firewall...`) |

## Review point: the app-wide reads a member has

Twelve routes are in a member's `READ` list (`member.rs`) although they are not about one of its
organizations. They were refused until the scoped feed landed, and were then allowed, `GET` only,
because a window of a hosted organization cannot work without them: it has to offer tiers, accounts,
skills, charters, templates and folders, and show the images in what agents write. This is the one
place where the API itself answers a member about something app-wide, so each route is listed with
what it answers. Every answer except the feed's passes `shown::answer` (no e-mail address, and no
mention of where else an account is used); the feed is made for the member.

| Route | What a member is answered | What to weigh |
| --- | --- | --- |
| `/api/app/records`, `/api/app/ws` | its own app feed: the list rows and summaries of its organizations, and the values `providers` and `accounts` | threat 13 |
| `/api/providers` | each provider and whether it can be used on this computer | it says which AI services the owner is signed in to |
| `/api/accounts` | the accounts by id and provider | no address; the ids are the names the owner gave them |
| `/api/harnesses` | which agent programs this computer has, and their versions | |
| `/api/skills` | the skills' names and where each came from; no content | names of the owner's own skills |
| `/api/mcp-servers` | the servers' names, where each came from, the transport; no command, variable or header | names only |
| `/api/defaults` | the owner's defaults for new organizations and agents | read only |
| `/api/charters` | the owner's charter library: each file's path and whole text | text the owner wrote, whatever organization it was written for |
| `/api/templates` | the owner's organization templates and their folder | the same |
| `/api/fs?path=` | the names of the folders under any path; the drives; the home folder | it names folders anywhere on the hosting computer, among them the folders other organizations work in |
| `/api/markdown-image?path=` | one image file by its path: 10 MB at most, and only if it is an image | it reads an image anywhere the owner's account can read, another organization's folder included |
| `/api/markdown-image?url=` | an image the hosting computer fetches from a public address (`is_public_ip`; private, loopback and Tailscale addresses are refused) | the fetch comes from the hosting computer's address |

None of these gives a member something its organization's agents could not already get for it on
this computer (the first entry of "Known and accepted"), and a member may add any folder of this
computer to its organization. They are listed because they are reads by the API itself, outside the
member's organizations, and the last three rows take a path or an address the member chooses. A
reviewer who wants the API narrower than the agents can ask for `/api/fs` and
`/api/markdown-image?path=` to be held to the folders of the member's organizations, and for
`/api/charters` and `/api/templates` to be refused (a hosted window would then offer no charter
presets, and "New from template" would be empty there). Nothing else app-wide is readable: usage,
model servers, OpenRouter keys, the organization list, Instructions for all orgs, the phone link, the
connections to other engines and every client record but the member's own stay in `REFUSED`.

## Where the door listens

- Default: this computer's Tailscale IPv4 address only, port 7431. The owner may add this computer's
  private-network address (app-wide choice) and change the port (1024 to 65535).
- `plan` (pure, `lifecycle.rs`) is the only code that names an address to bind, and it takes one only
  for what `remote::address::classify` says it is. `PeerRule` asks the same function about every peer.
- What the owner changes takes effect at once. An address that moved by itself is followed after two
  readings that agree. When the door leaves an address, every member connection is ended.
- A rig run binds loopback only, in a debug build, and only the address the run names. No unit test
  reads the computer's addresses.
- Windows Firewall: two rules, added by the desktop behind one administrator prompt and only read by
  the engine ([remote-org](remote-org.md#the-firewall-rules)). `Orgtree remote access` lets
  Tailscale's addresses reach the door's port; `Orgtree remote access (private network)`, only with
  that choice, lets the local subnet reach it on networks Windows calls Private. Both are for the
  engine's program alone. The windows are to add the rules before the first switch goes on (not
  built yet), so the door is never bound first and left to Windows' own "allow this app?" question.

## Token lifecycle

1. The owner makes a code for one organization whose switch is on (owner's route, desktop token,
   loopback). Stored: its hash, the organization's uuid, the expiry.
2. The other computer pastes address and code. Its engine checks the address rule, reads
   `/api/desktop/alive` and `/api/host` with the code (`mode: "host"` tells it what was pasted is a
   code), then `POST /api/standalone/clients`. The host makes the computer's record and its token in
   one write that also removes the code. The connecting side seals the token (machine key) and never
   stores what was pasted; when no token is made, it saves nothing (`remote/mod.rs` `add`).
3. Every request: `Authorization: Bearer <token>`; the registry finds the record by hash and remembers
   the connection.
4. The owner may give the computer another organization (no code), revoke it, or switch an
   organization off. The computer may remove its own record.
5. Nothing rotates by itself. A token lives until revoked.

## What to look at first

- `remote_access/mod.rs` `admit`: the whole of the door's guard, about 80 lines.
- `remote_access/api.rs` `owner`: what every owner's route asks first.
- `remote_access/lifecycle.rs` `plan` and `decide`: where the door stands, 40 lines.
- `http/mod.rs` `guard` and `guarded`: where `admit` is called, and the three places a door request is
  kept from the app's own paths (the two dispatches, the relay decision, the token check).
- `remote_access/member.rs`: the lists. `ORG` is the routes a member has; reading it top to bottom is
  the fastest way to see what "the whole organization" means.
- `client_tokens/transport.rs` `Connection::door`: set in `door.rs` `accept` and nowhere else.
- `apps/desktop/main/remotefirewall.ts` `remoteFirewallScript`: the only text of this feature that
  runs as administrator, 15 lines. `remote_access/firewall.rs` `script`: the engine's read.

## Known and accepted

- A member can do on the hosting computer whatever the organization's agents can. This is the
  feature; the switch says it. It follows that a member can learn things this page says it is not
  shown, by having an agent look: the owner's e-mail address (git's configuration, a CLI's sign-in
  file), the names of folders, what else is installed. The filter in `shown.rs` keeps addresses out
  of lists and pickers; it does not make them secret from a computer the owner trusted with an
  organization. What stays out of reach by construction is the API itself: other organizations'
  routes and databases, tokens, sign-ins and every app-wide write. The API's own reads outside a
  member's organizations are the twelve of the review point above, and no others.
- Plain http on a private network, when the owner chooses it.
- A code is a bearer secret for 15 minutes; whoever redeems it first gets in. The owner sees the
  computer's name in the list.
- The door answers `403` to a wrong token and `404` outside `/api/`, so a port scan can tell an
  Orgtree door from nothing.
- What the engine says about the firewall is a help, not a guard. It judges the two rules by name,
  port, program and whether they are on. It does not see a rule changed by hand to other addresses,
  a blocking rule (which Windows puts before any allowing one), Windows Firewall switched off, or
  another firewall product. The door's own rules (where it is bound, which peers it takes, the
  tokens) do not depend on any of it.
