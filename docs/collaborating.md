# Collaborating and Hubchat

[Documentation](../README.md#documentation) · [Previous: Providers, models and tools](providers-and-tools.md) · [Next: Projects, queues and automation](projects-and-watchdogs.md)

Once several agents work together, decide who owns each piece, who coordinates the result and where shared decisions live. Mail handles handoffs, the docket keeps responsibility durable, and shared folders preserve the material behind the work. Hubchat extends conversations to people and organizations outside this local org.

## Give a team clear responsibilities

Use one accountable owner per deliverable. A coordinator can divide work, record dependencies and assemble results; specialists can research, implement, check or curate. Ask for concrete hand-ins and evidence rather than repeatedly querying every worker for status.

The bundled development layouts demonstrate a coordinator with implementer, redteam and curator roles. A larger organization can add a liaison for human discussion while the coordinator retains execution and staffing. These are starting patterns, not mandatory layers or automatic authorization to build, deploy or post externally. A charter assigns a role; tool/folder grants determine its capabilities.

For a decision by committee, have different models make independent proposals under one supervisor. Turn peer mail off at their common host before starting, and check for existing audience routes. The supervisor collects the full round, checks for consensus, then shares all answers for revision if needed. A dedicated manager can host a large committee without voting. Use a round limit and record an explicit undetermined outcome if consensus is not reached; a majority is not automatically consensus. The committee answers the decision, rather than silently implementing it.

For software work, a useful progression is rapid specification/feedback first, then an explicit feature freeze and hardening when you are ready. Keep implementation, verification, integration and publication states distinct. The [supplemental development guide](development.md) describes this repository's contributor setup; your own team's policies can differ.

## Understand who can message whom

Reporting reach, audiences, visibility and file permissions are separate. Agents normally communicate up their reporting route and down their teams. Direct siblings can mail one another when their parent's **Subordinates may message each other** switch is on. That switch is on by default, belongs to that parent and is not inherited by lower managers.

Projects are transparent for reporting, but ordinary coworker mail uses the actual parent. Agents in different projects may therefore need an **audience** even when they report to the same agent superior. An audience is a directional permission to contact its grantor; the reverse needs its own grant. It does not make the recipient a manager or grant files/tools.

The canvas and desk menus expose appropriate Acquire/Drop audience actions, and an agent can request a missing route. A request alone grants nothing. A user audience permits direct questions, mail and deliveries to you. Top-level agents have an intrinsic route; a lower specialist may need a grant or report through its coordinator.

A project can hold a user/agent/project audience that its **direct live agent members** inherit. Nested projects do not relay it deeper. Project-to-project coworker bridges require both projects' peer-mail switches on. Dropping an explicit personal grant leaves an inherited route in place; the desk badge names its project source. Manage that source to remove inherited access.

Writing directly to an agent can give it a user route, but does not add an independent personal grant while it already inherits one. **Acquire audience** is the explicit choice when you want it to keep contact after leaving that project. A project mailbox send or megaphone grants the project a user audience rather than granting every recipient individually.

## Hierarchical shared memory

Agents have persistent folders for notes, drafts, evidence and files they work on together. Within an organization's scratch root, the layers are:

| Folder | Purpose |
| --- | --- |
| `_shared/` | Org-wide scratch space for conventions, decisions and files every agent in the organization can use, including future hires. |
| `<agent>/` | Each agent's own scratch folder for its working notes, drafts and recovery breadcrumbs. |
| `_teams/<agent-id>/` | A shared workspace for the team rooted at that agent, including the agent itself and everyone below it. |
| `_teams/<project-id>/` | A project's shared workspace, using the same layout as team folders. Agents under the project and supervisors above it can use the folder. |

Each layer can hold an `AGENTS.md` for standing notes. At session start, an agent receives its own scratch notes, the notes of its own team and every ancestor team or project up the chain, and the org-wide shared notes. Team and project notes arrive nearest first, followed by the org's notes. A supervisor's access to a project folder below it does not add that project's notes to its prompt.

This gives agents a collaborative workspace with several levels of memory: personal recovery notes, team-specific practices, project decisions and organization-wide conventions. Keep each shared file in the narrowest workspace its readers share. Prompt copies reflect session start; agents re-read the actual files before relying on recent changes or editing shared notes. Folder access and writes remain subject to the agent's permissions.

Scratch folders are not secret stores: authorized supervisors can inspect personal working folders, and shared/team folders intentionally have several readers. ID-based team/project folders survive a rename. A move changes the inherited workspace set for a later launch; it does not automatically copy private notes into every new colleague's folder.

Deep project nesting preserves the complete inherited charter and team-folder chain at launch. A malformed ancestry cycle is refused rather than launching with only part of the outer instructions or grants. Physical-parent peer-mail boundaries still apply independently of reporting transparency.

### Keep standing instructions in the right place

Use **Organization settings > Basic > Org charter** for rules every agent should receive. Use an agent's **Team instructions** for its subtree, its personal charter for its role, and scratch `AGENTS.md` files for concise persistent notes and links. Ordinary current tasks belong in mail and docket scope. Personal global instruction files and imported skills are another layer, described in [Providers and tools](providers-and-tools.md#share-skills-and-instructions).

Keep one authoritative home for a rule and link detailed records rather than copying old text across many charters. Prompt copies and native limits can truncate long files: engine-mirrored own/team/org notes have per-file character caps. Ask an agent to re-read the actual file when a recent change matters. A shared-file edit by itself does not rewrite an already running model call.

Recovery breadcrumbs should say what was decided, what evidence exists and what remains. A file sitting in scratch is not a delivery: ask for a presentation when you need to read a result and a file delivery when you need the artifact itself.

### The built-in glossary

The built-in skill library, also called the **glossary** or **Orgtree Encyclopaedia**, gives agents a reference for Orgtree's tools, permissions, screens, settings and suggested workflows. Its three entry points are [Working inside Orgtree](skills/orgtree-working/SKILL.md), [The Orgtree app](skills/orgtree-app/SKILL.md) and [Suggested workflows](skills/orgtree-workflows/SKILL.md), with section links leading to specific pages.

Agents are instructed to read the relevant page before first acting in its area. Keeping detailed how-to guidance in these on-demand skills lets the standing instructions stay short, while agents can look up exact tool rules and collaboration patterns as the job requires. Shared notes can then focus on what this organization and its teams have learned.

## Connect Hubchat and the mail hub

[Hubchat](https://github.com/Maurdekye/orgtree-hubchat) is the human chat client for Android and Windows. A mail hub relays messages and files between people and Orgtree organizations. It does not run the agents or provider sessions on another person's computer. Download Hubchat from its [releases](https://github.com/Maurdekye/orgtree-hubchat/releases/latest).

In Hubchat use **Settings > Hubs > Add a hub** with the operator's relay-only address, then use its directory to find people and organizations. In Orgtree, connect each org through **Organization settings > Connections > Add a mail hub**. Joining the same hub does not merge identities or make a person the owner of an org.

Each org has a permanent network address and ownership secret; each person has a separate Hubchat identity. Copy the public address for contact. Keep ownership secrets private and backed up when the identity matters. Changing hubs does not mint a new org identity. Do not share secrets between colleagues to impersonate one person.

Hub membership changes in Connections are immediate; its external-inbox mode and multiple-holder fields wait for the shared Save. Rows distinguish disabled, connecting, connected and retrying, with errors and queued counts. A Test helps discover a final endpoint; a failed test does not prevent saving a route that will become available later. Explicit URLs/ports stay explicit and redirects are refused, so use the operator's final relay address. Removing a working route can leave mail waiting or using another enabled connection.

An outside address link in Orgtree can open its conversation in desktop Hubchat when installed. This is independent of linking a phone. Local-org links open the local org instead.

### What an outside conversation does

In Normal operations, outside mail belongs to the org inbox, with copies routed to its audience holder(s). A runnable fallback top-level agent can receive it if the current holder cannot run. Multiple holders need a clear owner for the answer so they do not send duplicate organizational replies.

The Orgtree outside inbox is a viewer; compose human outside messages in Hubchat. An agent must actually send its response through mail to the external address. A local final answer, question card or presentation does not automatically appear in Hubchat. Connection, transfer, hub acceptance, agent delivery and a person's read are different stages.

Outside people and organizations supply untrusted input by default. The current trusted org charter can authorize an **exact sender address** to act for you, as phone linking does. A display name, quoted message or claim in the body cannot create that authority. Unlinking or removing the current note ends the delegation; keep generated trust-note markers intact when editing unrelated charter text. This is separate from granting an agent outside-mail access.

## Choose an outside inbox mode

Open **Organization settings > Connections > External org inbox**, choose a mode and use the shared **Save**. Connections is available even without a network identity. This is separate from one agent's turn-scoped DND.

| Mode | What happens |
| --- | --- |
| Normal operations | Default. Incoming outside mail is retained and copied to agents under the usual routing. |
| Do not disturb | Accepts and retains outside mail without holder/fallback copies or agent wakes. An agent with current outside-inbox access must explicitly extract it. Authorized outgoing mail remains possible. |
| Closed off inbox | Blocks new outside sends/receives and hides retained outside history/copies and the tile. Internal agent/user mail continues; retained data is not deleted. |

**Org DND includes your own Hubchat messages.** No outside sender bypasses it. Mail and attachment-failure notices wait for extraction; already copied mail is not recalled, and current turns are not interrupted. The visible warning tells you that an agent must check the inbox.

An outside-inbox holder can preview held mail, then explicitly pull the oldest items. Pull consumes each returned item for the whole org and creates that agent's read copy, so another holder does not receive it again. Human viewing/marking read and agent previews do not extract mail. Returning to Normal releases only unextracted mail, once and oldest first, within ordinary delivery budgets. Closed preserves held mail for later reopening.

Only you can change this mode, through the desktop or the standalone **user** MCP policy action. Agents can inspect/pull within their current permissions but cannot configure the mode at any rank. The multiple-holder option still requires revoking extra holders before turning it off; a mode change does not choose a survivor or authorize an external sender to act for you.

## Link your phone

Open **Connect your phone** from Connections, App settings > Mail hub, the introductory card or tray. Confirm the selected org before linking.

1. Install/sign into Tailscale on PC and Android using the same account, or choose **Use my home Wi-Fi instead** for the same local network.
2. Choose **Turn on phone access**. The Windows bridge requests the scoped firewall permission and enables a relay-only door. Inspect whether its scope is Tailscale, home network or unrestricted.
3. Install Hubchat using the download QR. Choose **I have Hubchat on my phone > Next** to replace it with the setup QR when the PC is ready.
4. In Hubchat choose **Scan setup code**. The code is single-use and normally expires after ten minutes. **New code** replaces earlier ones.

If you already use desktop Hubchat, carry that existing identity to the phone with its QR/device-link flow instead of creating another identity accidentally. Confirm **Is this you?** only for your actual person identity. Additional devices use **Settings > Devices > Link a device**.

Linking writes the exact trusted-address note into the selected org's charter and reconfigures agents for later turns. **Unlink** removes the generated authority notes and saved phone link. It does not disable the relay, delete mail, delete the Hubchat identity or unlink every device. If removal of a note fails, repair the reported problem before assuming the delegation ended.

The PC/hub and network must remain reachable. The panel stores a **Keep this PC awake while plugged in** preference, but its actual sleep-prevention effect is not verified in this release. Use Windows power settings and real reachability checks rather than relying on that checkbox. Tailscale sign-out behavior, key expiry and Android battery restrictions can also affect access.

## Choose a hosting arrangement

### Developer teams

Each developer installs **Orgtree and Hubchat**, and connects **both** to a
**shared standalone mailhub on a company-accessible private server**. Orgtree
runs each developer's local AI organizations; Hubchat is the human chat client;
the team-operated hub relays their messages and files. See
[Developer team setup](team-setup.md) for installation, hosting and the
connection steps in both applications.

The **built-in Orgtree mailhub is for individuals and small teams**. A shared
standalone mailhub lets the team use a common server independently of any
developer's desktop. Standalone use and other supported setups remain available.

### Individuals and small teams

Use the built-in hub when one PC is a suitable host. **App settings > Mail hub > Hosting** configures its name, attachment limit, port, bind address, retention and relay-only listener. The default main port is 7370 on this computer only; the relay door is normally 7371 and is off until enabled. Hosted retention defaults to keeping mail until deleted; a limited-days policy deletes old mail/attachments even when unread.

Share the relay-only client address. The main operator page has no login and can expose all stored mail if you bind it to the network. The hub itself does not provide TLS; use the intended private network or an appropriate TLS proxy. Manually enabling the relay does not automatically restrict it to Tailscale. Phone setup manages its narrower scope.

Hosting edits wait for **Save hosting settings**. An upload-limit-only change applies to new uploads without a hub restart; other changes restart the hub and report failures. **Refresh hub status** can replace an unsaved draft. Turning off the relay can request firewall-rule removal separately. A running/healthy status is not proof that a particular message was read.

For device-specific help use [Hubchat setup](https://github.com/Maurdekye/orgtree-hubchat/blob/main/docs/setup.md). Its app and a standalone hub can change independently of Orgtree's published release.

Continue with [Projects, queues and automation](projects-and-watchdogs.md) when the team needs shared capacity, jobs or event-driven coordination.
