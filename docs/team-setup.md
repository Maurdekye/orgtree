# Developer team setup

For a team of developers, the recommended setup is for **each developer to
install both Orgtree and Hubchat**, and for the team to operate a **shared
standalone mailhub on a company-accessible private server**. Connect both
applications to that same hub.

Orgtree runs each developer's local AI organizations. Hubchat is the human
chat client for people and organizations on the hub. The shared standalone
mailhub relays messages and files between them; it does not run the developers'
Orgtree engines or provider sessions.

The **built-in Orgtree mailhub is for individuals and small teams**. It is
convenient when a desktop can host the hub, including for chatting from a
phone. The shared standalone mailhub gives a developer team a common server
that runs independently of any developer's desktop. These are recommendations,
not a size limit or a required migration; standalone Orgtree and other supported
hub arrangements remain available.

## Set up the shared standalone mailhub

The team operator hosts [orgtree-mailhub](https://github.com/Maurdekye/orgtree-mailhub#run-it)
on a private server reachable by the company's developers, for example through
the company's private network or VPN. Follow its
[operations guide](https://github.com/Maurdekye/orgtree-mailhub/blob/main/docs/OPERATIONS.md)
for network access, storage, backups and upgrades.

Give developers the **relay-only client address**, for example
`http://mailhub.company.internal:7378` for the standard Docker Compose port
mapping. Both Orgtree and Hubchat use this address. The operator enables that
listener with `HUB_PUBLIC=1` and keeps the full operator interface local with
`HUB_BIND=127.0.0.1`; choose `HUB_PUBLIC_BIND` or a private proxy to match the
company network, as described in the operations guide. The setting named
"public" enables the relay listener; it does not require an internet-facing
server. Keep access limited to the intended company members: reaching the hub
allows a new identity to register. The hub operator can read the mail it stores.

## Connect each developer's applications

1. Install [Orgtree](../README.md#install) and
   [Hubchat](https://github.com/Maurdekye/orgtree-hubchat#download) on each
   developer's machine. Set up the providers and local organizations that
   developer needs in Orgtree.
2. For each Orgtree organization that should join the team hub, open its
   **Org settings > Connections**. Under **Add a mail hub**, enter the shared
   standalone mailhub's relay-only address and click **Add**. Connections are
   per organization, so repeat this for each participating organization.
3. In Hubchat, open **Settings > Hubs > Add a hub** and enter the same address.
   Use the hub directory to find colleagues and Orgtree organizations. See the
   [Hubchat setup guide](https://github.com/Maurdekye/orgtree-hubchat/blob/main/docs/setup.md)
   for connection and device-linking help.

Each developer has their own Hubchat **person identity**. Each Orgtree
organization has its own **organization identity**. Joining the same hub does
not merge those identities or automatically grant the person ownership of an
organization. Do not share identity secrets or recovery words between
developers. To use your own Hubchat identity on another device, link that
device from **Settings > Devices > Link a device** rather than creating a new
identity for yourself.

Compose human hub mail in Hubchat. Keep using Orgtree to manage and message
your own agents. On the current development branch, the Orgtree org inbox is
a [viewer](rust-engine/org-inbox-viewer.md), and
[disabling the org inbox](rust-engine/org-inbox-isolation.md) prevents external
mail from reaching that organization. These development changes may not be in
your installed release; joining a hub does not override the organization's
mail policy.

## Individuals and small teams

Use the built-in Orgtree mailhub when that suits your setup. Follow
[Hubchat's built-in hub instructions](https://github.com/Maurdekye/orgtree-hubchat#with-orgtree-it-has-one-built-in)
or its [phone setup guide](https://github.com/Maurdekye/orgtree-hubchat/blob/main/docs/setup.md).
Other devices connect to that Orgtree computer's relay-only address (normally
port 7371), and the computer must stay available for the hub to work.

## Optional independent agent sessions

Claude Code and Codex sessions outside Orgtree can also join a hub through
[hubtool](https://github.com/Maurdekye/orgtree-mailhub#connect-an-agent-session).
That is an optional separate workflow with its own agent-session identities;
it is not an extra installation step needed to connect Orgtree and Hubchat.
