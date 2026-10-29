---
name: orgtree-org-connections
description: "Explain per-organization hub identity, immediate connection changes and adding a hub."
---

Up: [orgtree-mailhub](../SKILL.md)

# Org settings > Connections

This tab controls the selected organization's network identity and the hubs it connects to. It does not configure the computer's hosted hub; use [Mail hub hosting](../mailhub-hosting/SKILL.md) for that. `net_autoconnect` and `net_hubs` are settings request fields whose effective identity/membership state is stored in that org's `ot.orgs.net` record.

## Address and secret

The **External org inbox** group selects Normal operations, Do not disturb, or Closed off inbox and the multiple-holder policy. These fields save immediately, as do hub membership actions. DnD warns that Hubchat and other outside mail is kept but is not read or delivered automatically, including the user's own messages. An agent must check the org inbox. See [inbox policy](../../org-settings/org-policies-inbox/SKILL.md) for extraction, resuming Normal and the user-only mode tool.

The organization has a permanent public network address. **Copy address** copies it for peers. It is separate from a person's Hubchat identity and from a bare local org slug. The address is minted with its ownership secret; changing hub membership does not create a new identity.

**Reveal secret…** reads the secret for the human settings view; **Copy** and **Hide** then appear. The secret proves address ownership. Losing it loses that identity, and a new secret cannot recover the same address. Keep a human backup if the address matters. Agents' tree/discovery projections omit the secret; do not ask an agent to obtain or publish it for routine connection setup.

## Local and remote memberships

**Connect to this computer's mail hub** applies `net_autoconnect` immediately. New identities default to local autoconnect when no preference is stored. **Connect your phone** opens [phone setup](../phone-link/SKILL.md) for this org.

Remote rows have an enabled toggle. Rows show Connected with hub version, Disabled, Connecting, or Retrying with the error; queued/stuck counts and the hub's connections appear when available. Missing version is shown as unknown. Hovering a hub's own dot says Connected or Not connected. A connection being reachable does not imply that the target org's external-inbox policy permits mail.

## A hub's connections

Each hub lists its connections as rows: a presence dot and the contact's link, nothing else. A filled green dot means online and a hollow grey ring means offline, as in Hubchat; hovering the dot says which. Hovering the link shows its presence and type (org, person or independent chat), then its name, the hub's description of it when there is one (for example "Waiting to be linked to a Hubchat identity") and its address. That hover is the same on every link to the address.

Online contacts come first, then offline ones. Within each group the most recent mail with this organization, sent or received, comes first; contacts with no mail come last, A-Z. Past ten rows the list scrolls inside its own box, and rows are drawn as they scroll into view, so a hub with hundreds of contacts stays fast. While the pointer is over the list, rows keep their places; the dots still change, and the new order applies when the pointer leaves.

Contacts are shown as network contact links: click to open in Hubchat, right-click for more. Your own account's link is the exception: it opens your chat with the org it is shown in, never your Hubchat settings.

Adding, enabling, disabling or removing a connection applies immediately; they do not wait for another submission. Removing a working connection or one with queued outgoing mail asks for confirmation. Queued mail can move to another enabled connection or wait with no route. Removal does not erase the org's address/identity.

## Add a mail hub

Enter a hub address and choose **Add**. A bare host probes HTTP ports 7370,
7378 and 7371 plus HTTPS concurrently. An explicit URL, port or path stays
explicit: use the operator's final relay-only endpoint. A successful **Test**
replaces the field with its discovered endpoint so Add uses that same address;
editing the field makes an older in-flight test result irrelevant. Test is
advisory: a failed test does not block Add, and queued mail can wait for the
hub. Clear typos and inspect its stage/error rather than treating an
unreachable test as a permanent identity failure.

Test and real mail use the same transport: direct first, then the system proxy
only if the initial connection failed. A read timeout or response failure is
not replayed through the proxy, because a write may already have arrived.
Redirects are errors; enter the final URL instead of expecting the client to
follow one. Newly saved hub rows receive stable registration IDs so the
connection worker can pick them up. Verified 2026-10-21 at `2ec8c0e`:
`canvas/connections.tsx::AddHub`, `net/discovery.rs`, `net/transport.rs`,
and `net.rs`.

Settings changes can establish connectivity; they do not grant a person user authority or give every agent outside-mail permission. For those rules see `orgtree-external-mail` and `orgtree-org-inbox` (orgtree-working › mail). For an agent's address discovery use `orgtree-tool-list-orgs` (orgtree-working › mail).

## See also

- See `orgtree-external-mail` (orgtree-working › mail).
- See `orgtree-tool-list-orgs` (orgtree-working › mail).
