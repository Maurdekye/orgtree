<img src="apps/desktop/assets/orgtree-eye.svg" alt="Orgtree" width="88">

# Orgtree

**Put a team of AI agents to work. Keep control of the job.**

Orgtree is a desktop power tool for running persistent teams of AI agents. Give them a project, divide the work, and follow it through to delivery. Assign roles, set limits, inspect the work and keep the decisions in one place.

It is a substantial tool, with a learning curve to match. You will need to learn its controls and give clear direction. Start with one agent and a small job. As you gain experience, build a team that can investigate, implement and review different parts of a project in parallel. In practiced hands, one person can keep several lines of work moving at once.

**[Download the latest Windows installer](https://github.com/Maurdekye/orgtree/releases/latest)** | [Release notes](https://github.com/Maurdekye/orgtree/releases) | [Report an issue](https://github.com/Maurdekye/orgtree/issues)

![Workspace in the default rows view, with provider usage across the top and agents arranged beneath their coordinator](docs/images/orgtree-3-rows-workspace.png)

**A workspace in the default rows view.** Agents sit in rows beneath their coordinator, with provider usage across the top.

## Built to carry the work

A project needs more than a conversation. It needs an owner, a clear brief, a record of decisions and a way to tell what is finished.

- **Give every job an owner.** The shared Work docket holds requirements, status, progress, evidence and attachments. Hand a task to another agent without losing its record.
- **Put specialists under a coordinator.** Each agent has a role and standing instructions. Agents can hire, delegate and retire reports within the capacity and permissions you give them.
- **See the work at the desk.** Read live conversations and tool calls. Open several desks side by side, send a correction while an agent works, and return to retained history later.
- **Get decisions and deliverables back.** Agents send mail, ask questions on cards, present plans and reports, and deliver files you can download. The Needs attention list brings together questions, urgent mail and flagged tickets.

For example: give a coordinator a project, assign a specialist to investigate one part, and have another agent review the result. Keep the brief, decisions and evidence on the docket. You direct the work and judge the result; the team handles the steps you delegate.

## Built for work that lasts beyond a session

The local Rust engine stores your organization, mail, docket and retained conversations in bundled PostgreSQL. Those records outlive the agent process. Retire an agent to free its capacity, then rehire it with its history when you need it again.

Recovery is part of the machinery. The desktop can restart an unresponsive engine. After an engine restart or crash, interrupted agents receive a continuation message and pending mail is recovered for delivery. Orgtree does not verify the outcome of tool calls interrupted in flight; agents may need to check what completed before continuing.

Keep the engine running in the system tray while you step away. Persistent **watchdogs** can wake an agent when a file changes, a process stops, command output matches, or an Orgtree event occurs. Agents can wait for the event that matters instead of repeatedly checking for it.

## Capacity you can put to use

Run agents through **Claude Code, OpenAI Codex, Google Antigravity or OpenRouter**. Choose the model and working instructions for each role. Adjust thinking effort as the job demands; supported Claude agents can take effort changes during a turn, while other providers apply them from the next turn.

The **Usage** board shows each account's reported limits and reset times. Use multiple supported accounts, choose which account serves an agent, and let agents use the readings to spread work across them. Disable accounts individually. Optional [account fallback](#account-fallback) lets eligible agents continue on another account when a usage limit is reached.

Orgtree is designed for organizations with hundreds of agents. The Rust engine handles agents concurrently, desks load recent conversation history first, and the docket fetches tasks in pages. Set how many turns may run at once in **App settings > Runtime**; the default is **16**. Actual working capacity depends on your machine, providers and account allowances.

Organizations can exchange mail on the same machine or through a shared **mail hub**. Keep separate teams for separate projects and connect them when the work calls for it.

## Controls within reach

Set folder access, available tools and delegation budgets for each agent. Halt work, change a model, move an agent to another team or bring a retired specialist back. Agents can use your desktop's Git and GitHub sign-in for repository work.

Arrange the workspace around the job: rows or a circular org chart, pinned panels, pop-out windows and multiple desks. Each organization has its own window. Open the detail when you need it; use the docket and attention list to keep track of the larger job.

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

## Screenshots

Select any image to see it full size.

<table>
  <tr>
    <td width="50%" valign="top">
      <a href="docs/images/orgtree-3-rows-workspace.png"><img src="docs/images/orgtree-3-rows-workspace.png" alt="Workspace in the default rows view, with provider usage across the top and agents arranged beneath their coordinator" width="100%"></a>
      <p><strong>Rows workspace.</strong> Keep agents beneath their coordinator with account usage above the team.</p>
    </td>
    <td width="50%" valign="top">
      <a href="docs/images/orgtree-3-canvas.png"><img src="docs/images/orgtree-3-canvas.png" alt="Canvas: an interactive circular org chart of agents, with the Needs attention list, a Usage panel and an open agent desk" width="100%"></a>
      <p><strong>Canvas.</strong> See the org chart alongside questions, usage and an open agent desk.</p>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <a href="docs/images/orgtree-3-docket-usage.png"><img src="docs/images/orgtree-3-docket-usage.png" alt="Window with the Work docket and the Usage panel pinned on the left, and the canvas of agents beside them" width="100%"></a>
      <p><strong>Docket and usage.</strong> Track work and account capacity beside the team.</p>
    </td>
    <td width="50%" valign="top">
      <a href="docs/images/orgtree-3-focused-desk.png"><img src="docs/images/orgtree-3-focused-desk.png" alt="Window with the Work docket pinned on the left showing one ticket's details, and a focused agent desk on the right showing live tool calls and a queued message" width="100%"></a>
      <p><strong>Focused desk.</strong> Follow live tool calls with the task details in view.</p>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <a href="docs/images/orgtree-3-docket.png"><img src="docs/images/orgtree-3-docket.png" alt="Work docket with tickets grouped by status and one ticket's description, progress and next steps open" width="100%"></a>
      <p><strong>Work docket.</strong> See each task's owner, status, progress and next steps.</p>
    </td>
    <td width="50%" valign="top">
      <a href="docs/images/orgtree-3-presented.png"><img src="docs/images/orgtree-3-presented.png" alt="Presented documents panel with a list of reports and a PostgreSQL speed audit open for reading" width="100%"></a>
      <p><strong>Presented documents.</strong> Read and download plans and reports from your agents.</p>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <a href="docs/images/orgtree-3-providers.png"><img src="docs/images/orgtree-3-providers.png" alt="App settings on the Providers page, showing installed providers, signed-in accounts, model tiers and seat prices" width="100%"></a>
      <p><strong>Providers.</strong> Manage providers, signed-in accounts, model tiers and seat prices.</p>
    </td>
    <td width="50%" valign="top">
      <a href="docs/images/orgtree-3-desks.png"><img src="docs/images/orgtree-3-desks.png" alt="Workspace with account usage above two agent desks open side by side, and a coordinator's desk pinned on the right" width="100%"></a>
      <p><strong>Agent desks.</strong> Follow several agents side by side with pinned and tabbed desks.</p>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <a href="docs/images/orgtree-3-inbox.png"><img src="docs/images/orgtree-3-inbox.png" alt="Inbox with audience holders, inbox, sent and record tabs, a message list and a selected message with an attachment" width="100%"></a>
      <p><strong>Inbox.</strong> Read messages and attachments, then reply in place.</p>
    </td>
    <td width="50%" valign="top">
      <a href="docs/images/orgtree-mail-hub.png"><img src="docs/images/orgtree-mail-hub.png" alt="A mail hub window showing message traffic between hosts in a read-only view" width="100%"></a>
      <p><strong>Mail hub.</strong> Inspect message traffic and delivery status between hosts.</p>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <a href="docs/images/orgtree-3-homepage.png"><img src="docs/images/orgtree-3-homepage.png" alt="Home page listing organizations, their capacity counts and a button to create a new organization" width="100%"></a>
      <p><strong>Your organizations.</strong> Open a team or create a new one from the home page.</p>
    </td>
    <td></td>
  </tr>
</table>

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

Build a Windows installer with `npm run package:win`. For the documented Windows release workflow, use `npm run release:windows -- <version>`; publication is a separate explicit `--publish` phase. See [the Windows release workflow](docs/windows-release.md). For the separate development packaging workflow, see [local development builds](docs/dev-builds.md).

More technical notes: [engine boundary](docs/engine-contract.md), [engine plan and decisions](docs/rust-engine/PLAN.md), [event watchdogs](docs/rust-engine/event-watchdogs.md), [credential bridge](docs/rust-engine/credential-bridge.md), [onboarding and charter presets](docs/v2-onboarding.md), [themes](docs/v2-visual-themes.md) and [history retention](docs/v2-history-retention.md). Consult the [release notes](https://github.com/Maurdekye/orgtree/releases) for published changes.

## Feedback and contributions

[Open an issue](https://github.com/Maurdekye/orgtree/issues) for a bug or feature request. For a bug, include your Orgtree version, Windows version, the steps that reproduce it and the error text or a screenshot. Remove tokens, authorization codes and other private information before posting.

## License

[MIT](LICENSE). Third-party notices are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
