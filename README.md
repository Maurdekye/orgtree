<img src="apps/desktop/assets/orgtree-eye.svg" alt="Orgtree" width="88">

# Orgtree

**A desktop workspace for running a persistent team of coding agents.**

Give agents jobs, see what they are doing, and keep their conversations, files and work organized in one place. Orgtree shows your team as an interactive organization chart: you sit at the top, agents work beneath you, and they can delegate and communicate with one another within the permissions you give them.

**[Download the latest Windows installer](https://github.com/Maurdekye/orgtree/releases/latest)** | [Release notes](https://github.com/Maurdekye/orgtree/releases) | [Report an issue](https://github.com/Maurdekye/orgtree/issues)

## Screenshots

![workspace in the default rows view, with provider usage across the top and agents arranged beneath their coordinator](docs/images/orgtree-3-rows-workspace.png)

**a workspace in the default rows view.** Agents sit in rows beneath their coordinator, with provider usage across the top.

![Canvas: an interactive circular org chart of agents, with the Needs attention list, a Usage panel and an open agent desk](docs/images/orgtree-3-canvas.png)

**Canvas.** The Canvas shows your team as a circular organization chart. Beside it are the "Needs attention" list of tickets and questions waiting for you, a Usage panel, and an agent's desk open for reading its conversation.

![window with the Work docket and the Usage panel pinned on the left, and the canvas of agents beside them](docs/images/orgtree-3-docket-usage.png)

**docket and usage beside the canvas.** The Work docket on the left lists tickets grouped by status, and next to it the Usage panel shows how much of each provider account's limits is used and when they reset. The canvas to the right shows the agents, with you at the centre; account emails and the OpenRouter key are blurred in this picture.

![window with the Work docket pinned on the left showing one ticket's details, and a focused agent desk on the right showing live tool calls and a queued message](docs/images/orgtree-3-focused-desk.png)

**a focused agent desk.** On the left, the Work docket is pinned with one ticket open, showing its description, what is done and what is next. On the right, one agent's desk fills the canvas: its live tool calls and short progress notes scroll by, and a message from another agent waits at the bottom until the agent reaches a safe point to read it.

![Work docket with tickets grouped by status and one ticket's description, progress and next steps open](docs/images/orgtree-3-docket.png)

**the Work docket.** Tickets are grouped by status, including work in progress, blocked work and the backlog. Opening a ticket shows its owner, description, what is done and what comes next.

![presented documents panel with a list of reports and a PostgreSQL speed audit open for reading](docs/images/orgtree-3-presented.png)

**presented documents.** Browse reports from your agents and read or download a selected document. Here an agent has presented a PostgreSQL speed audit.

![App settings on the Providers page, showing installed providers, signed-in accounts, model tiers and seat prices](docs/images/orgtree-3-providers.png)

**providers.** App settings lists installed providers, signed-in accounts, model tiers and their seat prices. You can add secondary accounts and manage sign-ins; account emails and local usernames are blurred in this picture.

![workspace with account usage above two agent desks open side by side, and a coordinator's desk pinned on the right](docs/images/orgtree-3-desks.png)

**agent desks.** Open several agents' desks side by side and switch between them using tabs. Here two desks share the canvas, with Usage above them and a coordinator's desk pinned on the right.

![inbox with audience holders, inbox, sent and record tabs, a message list and a selected message with an attachment](docs/images/orgtree-3-inbox.png)

**your inbox.** See who holds a direct audience with you, browse messages, read attachments and reply in place. The selected message contains an agent's report and a file to download.

![A mail hub window showing message traffic between hosts in a read-only view](docs/images/orgtree-mail-hub.png)

**the mail hub.** A read-only view of message traffic between hosts. Select a host or a message to inspect its delivery status and contents.

### Your organizations

![home page listing organizations, their capacity counts and a button to create a new organization](docs/images/orgtree-3-homepage.png)

**the home page.** Open an existing organization or create a new one. The list shows each organization's capacity counts and marks organizations that are already open.

## Key features

- **An org chart of agents.** You sit at the centre or top; a coordinator and specialists work beneath you. Agents can hire, delegate and retire reports inside the capacity and permissions you give them.
- **Several providers and models.** Run agents through Claude Code, Codex and Antigravity, or pick models through OpenRouter. Each agent has a role (its *charter*), a model and its own working instructions.
- **Live desks.** Read each agent's conversation and tool activity as it happens, send follow-up messages while it works, open several desks side by side, and return to retained history later.
- **Adjustable thinking effort.** Change an agent's effort while it works. Claude Code agents on Opus, Sonnet and Fable apply it mid-turn; Codex and other harnesses apply it from the next turn.
- **A shared docket.** Tickets track ownership, status, progress and evidence, with images and files attached, so work stays connected to its context. A "Needs attention" list gathers flagged tickets, urgent mail and open questions for you.
- **Mail and notices.** Agents exchange mail, request decisions, ask you questions on cards and deliver files. You have an inbox, and an *audience* gives an agent a direct line to you or another agent.
- **Presented documents.** Agents present reports and plans you can read, and download, in the app.
- **Watchdogs.** Free, persistent watchers that wake an agent when a file, command, process or output stream matches, or when the engine itself reports an event such as a turn finishing, new mail, a ticket change, an account hitting its limit or the number of active agents crossing a threshold.
- **Credits and seats.** A capacity budget that limits how many agents the organization can hold and how much each can manage beneath it (see below).
- **Usage board and account balancing.** See each signed-in account's limits and reset times, run several accounts per provider, enable or disable them individually, and let agents spread work across them. Optionally let agents switch account when a limit is hit.
- **Git and GitHub for agents.** Agents use your desktop's git and GitHub login, even when Orgtree started before you signed in to Windows.
- **A mail hub between organizations.** Organizations on the same machine, or on a shared hub, can send each other mail. A read-only hub window shows message traffic.
- **Control over access.** Set folder permissions, tools and delegation budgets per agent.
- **A workspace that scales.** Rows and circular canvas layouts, pinned and pop-out panels, themes, context menus on agents (copy, focus, hire, open, halt, cheap compact, retire), and one window per organization. It stays responsive with hundreds of agents.
- **Runs in the background.** Closing the main window can leave the engine running in the system tray, so a team keeps working between visits. Retiring an agent preserves its history so it can be brought back later.
- **Your choice of Enter behaviour.** In **App settings > Display > Typing**, choose whether Enter sends a message or adds a new line.

A typical workflow: give a coordinator a project, have a specialist investigate one part, ask another agent to review the result, and keep the decisions and deliverables on the project's tickets.

When you change an agent's effort, the app reports delivery. Agent tools return the same information in `effort_delivery`:

| Result | Meaning |
| --- | --- |
| `sent` | Delivered to the running Claude Code turn. This does not confirm that the CLI applied it; if the CLI ignores the request, the new level still applies from the next turn. |
| `unchanged` | The effective level is the same, so nothing was sent. |
| `next_turn` | The change applies from the next turn, with a reason for deferring delivery. |

## Install

The published installer is for **64-bit Windows**.

1. Open the [latest release](https://github.com/Maurdekye/orgtree/releases/latest).
2. Download the **`Orgtree-Setup-<version>.exe`** asset and run it. You do not need GitHub's source-code ZIP to install the app.
3. Launch **Orgtree** from the Start menu and follow the welcome screen.

The installer includes the desktop app, its local engine and the PostgreSQL database it uses. You do **not** need to install Node.js, Rust or PostgreSQL to use the packaged app. Installing a newer build over an existing one keeps your data. Provider applications and their accounts are set up separately.

### Set up a provider

Open **App settings > Providers** to discover installed providers and use their setup or sign-in controls. You only need the providers you intend to use.

| Provider | Account / setup |
| --- | --- |
| Claude Code | Install and sign into [Claude Code](https://code.claude.com/docs/en/setup). |
| Codex | Install and sign into the [Codex CLI](https://developers.openai.com/codex/cli). |
| Antigravity | Install and sign into [Antigravity](https://antigravity.google/download). |
| OpenRouter | Configure your OpenRouter API key and choose the models you want offered. |

For a secondary account, use the add-account button in that provider's header. You can import an existing profile folder or create a managed profile, then use the account row to manage it or sign in again. Account usage belongs in the dedicated **Usage** window, opened from the **Orgtree** menu.

Orgtree does not include model access. Your provider's subscription, API charges and usage limits still apply. Availability depends on the provider, installed tools and signed-in account.

## Your first organization

1. **Create an organization** from the welcome screen. Give it a name and a capacity budget.
2. **Hire an agent.** Choose a model and describe its role in its *charter*: the instructions it should keep following across tasks. You can start from a bundled charter preset.
3. **Give it access to the project.** Select the folders and tools it needs. These settings control what the agent may work with.
4. **Send a concrete task.** Open the agent and describe the result you want, any constraints, and how you will know it is finished.
5. **Follow up in the workspace.** Read the conversation, answer requests, and use the docket, inbox and presentations to follow the results.

Start with one agent and a small task. Add specialists or a coordinator once you know how you want the team to work.

### What are credits?

Orgtree's **credits are a capacity budget**, separate from provider billing. Each agent occupies a model-dependent seat; its grant is the capacity it can use for agents beneath it. Retiring an agent releases that capacity. Credits do not buy tokens or extend a provider's usage allowance.

### Staying in control

An agent's charter describes its job; its folder and tool permissions determine its access. An *audience* gives an agent an additional communication link, such as a direct line to you. You can inspect and change these settings as the organization develops.

Agents have persistent identities and history. Retirement preserves that context; permanent deletion is a separate action.

## Updates and background operation

Right-click Orgtree's **system-tray icon** to check for updates, see download progress and choose **Update now** when the download is ready. The update can be completed from that menu.

**Automatic updates** are on by default. Turn them off in the tray menu or **App settings > Runtime** to stop background checks and idle installation. Manual update controls remain available. A download already in progress may finish; an installation already started completes.

The tray also provides organization navigation and controls for startup and **Exit on close**. With Exit on close disabled, closing the main window keeps Orgtree available in the background; open it again from the tray.

## Account fallback

In an org's **Settings > Autonomy**, you can allow agents to switch to another
account after a usage limit. It is off by default. Each agent's settings can
follow the org default or override it. A switch keeps the replacement account.
Only Claude and Codex profiles with verified capacity qualify; Antigravity
cannot select a separate account for a turn. Switching starts a new provider
cache, and Codex starts a new session. The existing frozen-turn replay continues
the interrupted task. Usage checks can refresh a registered profile's sign-in credentials when needed.

## Data and privacy

The engine runs locally, and organization data and retained history are stored on your machine, in a database that runs only on your computer. A standard Windows installation keeps Orgtree's data under **`%APPDATA%\Orgtree v2\data`**. Account profiles can also use provider-specific locations.

Agent requests still go to the providers you configure. Local storage does not mean model inference happens offline. Folder and tool permissions are worth choosing deliberately, just as they are when running the provider's coding tool directly.

## Development

The desktop app uses **Electron, React and TypeScript**. The background engine is written in **Rust** (`engine/rs`) and talks to a bundled PostgreSQL database; the mail hub lives in the pinned [orgtree-mailhub](https://github.com/Maurdekye/orgtree-mailhub) submodule at `engine/mailhub`, so clone with `--recurse-submodules` (or run `git submodule update --init`).

```powershell
git submodule update --init
npm ci
npm run typecheck
npm run build
cargo check --manifest-path engine/rs/Cargo.toml
```

Keep development separate from your installed app and its organizations by pointing it at its own profile and data folder (`ORGTREE_V2_PROFILE`, `ORGTREE_V2_DATA`) before `npm start`. Renderer checks run with `npm run test:renderer`.

Build a Windows installer with `npm run package:win`. To produce the canonical, locally verified release candidate, use `npm run release:windows -- <version>`; publication is a separate explicit `--publish` phase. See [the Windows release workflow](docs/windows-release.md). To install an in-development build locally without publishing anything, use `npm run package:dev` — see [local development builds](docs/dev-builds.md).

More technical notes: [engine boundary](docs/engine-contract.md), [engine plan and decisions](docs/rust-engine/PLAN.md), [event watchdogs](docs/rust-engine/event-watchdogs.md), [credential bridge](docs/rust-engine/credential-bridge.md), [onboarding and charter presets](docs/v2-onboarding.md), [themes](docs/v2-visual-themes.md) and [history retention](docs/v2-history-retention.md). Consult the [release notes](https://github.com/Maurdekye/orgtree/releases) for published changes.

## Feedback and contributions

[Open an issue](https://github.com/Maurdekye/orgtree/issues) for a bug or feature request. For a bug, include your Orgtree version, Windows version, the steps that reproduce it and the error text or a screenshot. Remove tokens, authorization codes and other private information before posting.

## License

[MIT](LICENSE). Third-party notices are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
