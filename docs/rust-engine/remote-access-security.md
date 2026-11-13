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
| 1 | Someone on the internet reaches the door | It binds the Tailscale address and by choice the LAN address, never a public one or `0.0.0.0`; a peer at a public address is dropped unread | `door.rs` `PeerRule`; binding: the lifecycle | peer rule **built** (`the_door_takes_tailscale_peers...`, `a_peer_the_door_does_not_take...`); binding **planned** (the switch and lifecycle job) |
| 2 | Someone on the tailnet or LAN guesses a token or code | Tokens are 256 random bits, codes 130; compared by hash in constant time; refusals are rate-limited per address (10 a minute, then 429 for a minute) | `registry.rs`; limiter | entropy and hashing **built**; limiter **planned** (the switch and lifecycle job) |
| 3 | A code leaks (chat, screen share) | One use, 15 minutes, one organization; used up in the same write that makes the computer; the owner sees the new computer in the list and can revoke it; a code for an organization switched off opens nothing | `registry.rs` `redeem`, `admit` | **built** (`a_code_makes_exactly_one_computer...`, `a_code_runs_out...`, `a_code_for_an_organization_that_was_switched_off...`) |
| 4 | The registry file is read (backup, another local user) | It holds SHA-256 hashes only; the token and the code are shown once | `registry.rs` | **built** (`a_code_makes_exactly_one_computer...` reads the file) |
| 5 | A member reaches another organization | The route table asks, for the organization a path names, whether this computer was given it and its switch is on; anything else is refused the same way as an organization that does not exist | `member.rs` `verdict`, `admit` | **built** (`a_member_has_the_organization...`, `the_table_gives_a_member...`) |
| 6 | A member reaches something app-wide: accounts, sign-ins, defaults, instructions for all orgs, model servers, updates, the phone link, other computers' records | Fail-closed table: every route of the router is in exactly one list, and a test fails for one that is in none | `member.rs` | **built** (`every_route_is_classified_for_members`) |
| 7 | A member uses the hosting desktop's own privileges: the desktop token, the language-server proxy, the credential bridge, the renderer bundle | The door never compares with the desktop token and removes its header; only `/api/` is served; the two dispatches that bypass the API token are not asked for a door request | `admit`, `http::guard` | **built** (`the_door_and_the_apps_own_listener...`, `the_door_serves_the_api_and_nothing_else`) |
| 8 | A member token is used on the app's own listener (malware on the host that read a token off the wire) | That listener reads only the desktop token header, never `Authorization` | `http::guarded` | **built** (same test) |
| 9 | A member uses the host as a way into the engines the host is connected to | A door request is never relayed, and `X-Orgtree-Remote` is removed from it | `http::guarded`, `admit` | **built** (`the_door_serves_the_api_and_nothing_else`) |
| 10 | A web page in a browser on some computer of the tailnet calls the door (cross-site request, DNS rebinding) | No cookie or ambient credential exists: a request needs `Authorization: Bearer`. A request that names an `Origin` is refused outright | `admit` | **built** (same test) |
| 11 | A member changes who may come in: the switch, the lists, codes | The switch and the owner's routes take the desktop token on the loopback listener only; at the door they are in `REFUSED`; the `remote_access` setting is refused to a member inside the settings save | the owner's routes | **planned** (the switch and lifecycle job) |
| 12 | A member deletes the organization | `DELETE /api/orgs/{slug}` is not in its table (`READ` is `GET` only) | `member.rs` | **built** (`a_member_has_the_organization...`) |
| 13 | A member learns the owner's e-mail addresses or other organizations' names from answers it may read (the app feed, the organization list, accounts, usage) | Those answers are refused until scoped: a member is sent a feed and lists made for it | scoped feed and reads | **refused today** (in `REFUSED`); scoped versions **planned** (the "what a member is sent" job) |
| 14 | A revoked computer keeps working on an open connection or socket | Revoke ends every connection the computer has open before it returns; the same lock admits tokens and commits the removal | `registry.rs` | **built** (`revoking_a_computer_or_switching...`, `a_member_reads_names_and_removes...`) |
| 15 | The switch is turned off but a connection stays | Turning it off ends the connections of every computer that has the organization | `RemoteAccess::set_open` | **built** (same test) |
| 16 | The traffic is read on the wire | On Tailscale the tunnel encrypts it. On a private network plain http is not encrypted; both sides say so, and it is off unless chosen | the app-wide choice | **planned** (the switch job; the connecting side already labels the transport) |
| 17 | A broken or tampered registry file admits someone | A file that does not validate as a whole admits nobody; it is set aside and the registry starts empty | `registry.rs` `read` | **built** (`the_registry_survives_a_restart_and_a_broken_file...`) |
| 18 | A member's requests are attributed to the owner | Every member request runs with the member's origin (phase E), so what it does is recorded as its own | `admit` returns the origin | **built** for the origin (`a_member_reads_names...` reads `you`); events for connect, revoke and codes **planned** |

## Token lifecycle

1. The owner makes a code for one organization (owner's route, desktop token, loopback). Stored: its
   hash, the organization's uuid, the expiry.
2. The other computer pastes address and code. Its engine checks the address rule, reads
   `/api/desktop/alive` and `/api/host` with the code, then `POST /api/standalone/clients`. The host
   makes the computer's record and its token in one write that also removes the code. The connecting
   side seals the token (machine key) and never stores the code.
3. Every request: `Authorization: Bearer <token>`; the registry finds the record by hash and remembers
   the connection.
4. The owner may give the computer another organization (no code), revoke it, or switch an
   organization off. The computer may remove its own record.
5. Nothing rotates by itself. A token lives until revoked.

## What to look at first

- `remote_access/mod.rs` `admit`: the whole of the door's guard, about 70 lines.
- `http/mod.rs` `guard` and `guarded`: where `admit` is called, and the three places a door request is
  kept from the app's own paths (the two dispatches, the relay decision, the token check).
- `remote_access/member.rs`: the lists. `ORG` is the routes a member has; reading it top to bottom is
  the fastest way to see what "the whole organization" means.
- `client_tokens/transport.rs` `Connection::door`: set in `door.rs` `accept` and nowhere else.

## Known and accepted

- A member can do on the hosting computer whatever the organization's agents can. This is the
  feature; the switch says it.
- Plain http on a private network, when the owner chooses it.
- A code is a bearer secret for 15 minutes; whoever redeems it first gets in. The owner sees the
  computer's name in the list.
- The door answers `403` to a wrong token and `404` outside `/api/`, so a port scan can tell an
  Orgtree door from nothing.
