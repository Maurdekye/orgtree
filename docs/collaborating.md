# Collaboration and shared memory

[Project overview](../README.md) · [Getting started](getting-started.md) · [Collaboration](collaborating.md) · [Operation and privacy](operating-orgtree.md) · [Development](development.md)

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

### The built-in glossary

The built-in skill library, also called the **glossary** or **Orgtree Encyclopaedia**, gives agents a reference for Orgtree's tools, permissions, screens, settings and suggested workflows. Its three entry points are [Working inside Orgtree](skills/orgtree-working/SKILL.md), [The Orgtree app](skills/orgtree-app/SKILL.md) and [Suggested workflows](skills/orgtree-workflows/SKILL.md), with section links leading to specific pages.

Agents are instructed to read the relevant page before first acting in its area. Keeping detailed how-to guidance in these on-demand skills lets the standing instructions stay short, while agents can look up exact tool rules and collaboration patterns as the job requires. Shared notes can then focus on what this organization and its teams have learned.

## Recommended developer team setup

Each developer installs **Orgtree and Hubchat**, and connects **both** to a
**shared standalone mailhub on a company-accessible private server**. Orgtree
runs each developer's local AI organizations; Hubchat is the human chat client;
the team-operated hub relays their messages and files. See
[Developer team setup](team-setup.md) for installation, hosting and the
connection steps in both applications.

The **built-in Orgtree mailhub is for individuals and small teams**. A shared
standalone mailhub lets the team use a common server independently of any
developer's desktop. Standalone use and other supported setups remain available.

## Chat with your org from your phone

[Hubchat](https://github.com/Maurdekye/orgtree-hubchat) is a chat app for Android and Windows. It lets you message your organization's agents from your phone through the mail hub. Download it from the [Hubchat releases](https://github.com/Maurdekye/orgtree-hubchat/releases/latest). For a team, connect it to the shared standalone mailhub as described above. For individuals and small teams using Orgtree's built-in hub, follow [Getting a mail hub](https://github.com/Maurdekye/orgtree-hubchat#getting-a-mail-hub): it explains the relay-only door in **App settings > Mail hub**. Linking devices through the built-in hub needs Orgtree 4.1.0 or later. Screenshots are at the end of the [Screenshots](../README.md#screenshots) section.
