<img src="apps/desktop/assets/orgtree-eye.svg" alt="Orgtree" width="88">

# Orgtree

**A desktop workspace for running a persistent team of coding agents.**

Give agents jobs, see what they are doing, and keep their conversations, files and work organized in one place. Orgtree shows your team as an interactive organization chart: you sit at the top, agents work beneath you, and they can delegate and communicate with one another within the permissions you give them.

**[Download the latest Windows installer](https://github.com/Maurdekye/orgtree/releases/latest)** | [Release notes](https://github.com/Maurdekye/orgtree/releases) | [Report an issue](https://github.com/Maurdekye/orgtree/issues)

This is **Orgtree V2**, the current desktop application. It replaces [claude-orgtree (V1)](https://github.com/Maurdekye/claude-orgtree).

## What you can do

- **Build a team across providers.** Run agents through Claude Code, Codex and Antigravity, or choose models through OpenRouter. Give each agent a role, a model and its own working instructions.
- **Follow the work as it happens.** Read live conversations and tool activity, send follow-up messages while an agent is working, and return to retained history later.
- **Keep tasks on a shared docket.** Track ownership, status, progress and supporting evidence. Attach images and files to tickets so the work stays connected to its context.
- **Let agents coordinate.** Agents can delegate, exchange mail, request decisions and deliver files or presentations. You can step in wherever needed.
- **Control access and capacity.** Set folder permissions, tools and delegation budgets. Inspect account usage and choose which account an agent uses.
- **Arrange your workspace.** Zoom into an agent, pin panels, open separate windows and choose a theme. Manage multiple organizations from the same app.
- **Keep a team available between visits.** Closing the main window can leave the engine running in the system tray. Retiring an agent preserves its history so it can be brought back later.

A typical workflow: give a coordinator a project, have a specialist investigate one part, ask another agent to review the result, and keep the decisions and deliverables on the project's tickets.

## Install

The published installer is for **64-bit Windows**.

1. Open the [latest release](https://github.com/Maurdekye/orgtree/releases/latest).
2. Download the **`Orgtree-Setup-<version>.exe`** asset and run it. You do not need GitHub's source-code ZIP to install the app.
3. Launch **Orgtree** from the Start menu and follow the welcome screen.

The installer includes the desktop app and its Python engine. You do **not** need to install Node.js or Python to use the packaged app. Provider applications and their accounts are set up separately.

### Set up a provider

Open **App settings > Providers** to discover installed providers and use their setup or sign-in controls. You only need the providers you intend to use.

| Provider | Account / setup |
| --- | --- |
| Claude Code | Install and sign into [Claude Code](https://code.claude.com/docs/en/setup). |
| Codex | Install and sign into the [Codex CLI](https://developers.openai.com/codex/cli). |
| Antigravity | Install and sign into [Antigravity](https://antigravity.google/download). |
| OpenRouter | Configure your OpenRouter API key and choose the models you want offered. |

For a secondary account, use the add-account button in that provider's header. You can import an existing profile folder or create a managed profile, then use the account row to manage it or sign in again. Account usage belongs in the dedicated **Usage** window.

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

**Automatic updates** are on by default. Turn them off in the tray menu or **App settings > Desktop** to stop background checks and idle installation. Manual update controls remain available. A download already in progress may finish; an installation already started completes.

The tray also provides organization navigation and controls for startup and **Exit on close**. With Exit on close disabled, closing the main window keeps Orgtree available in the background; open it again from the tray.

## Coming from V1?

V2 uses its own application data directory. Installing it does not automatically move your V1 organizations or sign you into providers.

An explicit V1 import is available in Settings. It copies selected organizations into V2 and leaves the original V1 data in place. Review the import's warnings, especially if V1 still has agents working on the same projects. Provider sign-in and profile setup are separate from organization import.

See [V1 import details](docs/v2-import.md) for the supported data, checks and limitations.

## Data and privacy

The engine runs locally, and organization data and retained history are stored on your machine. A standard Windows installation keeps V2 data under **`%APPDATA%\Orgtree v2\data`**. Account profiles can also use provider-specific locations.

Agent requests still go to the providers you configure. Local storage does not mean model inference happens offline. Folder and tool permissions are worth choosing deliberately, just as they are when running the provider's coding tool directly.

## Development

The app uses **Electron, React and TypeScript**, with a separately bundled **Python engine**. Windows development and packaging use Node.js and Python with pip; the release tooling provisions an app-local Python runtime.

From a checkout on Windows:

```powershell
npm ci
npm run runtime:provision
npm run typecheck
npm run build

# Keep development separate from your installed app and its organizations.
$env:ORGTREE_V2_PROFILE = Join-Path $env:LOCALAPPDATA 'Orgtree-dev'
$env:ORGTREE_V2_DATA = Join-Path $env:ORGTREE_V2_PROFILE 'data'
$env:ORGTREE_V2_PYTHON = (Resolve-Path .\engine\runtime\python.exe).Path
npm start
```

Useful checks:

```powershell
npm test
node apps/desktop/renderer/tests/run.mjs
```

Use a fresh, separate data directory for backend tests and development scripts, selected **before importing storage modules**. See [development storage](docs/v2-development-storage.md). Build a Windows installer with `npm run package:win`; packaging also checks the bundled runtime and build provenance.

Additional technical notes: [engine boundary](docs/engine-contract.md), [onboarding and charter presets](docs/v2-onboarding.md), [themes](docs/v2-visual-themes.md), and [history retention](docs/v2-history-retention.md). Dated design and acceptance documents record earlier development stages; consult the [release notes](https://github.com/Maurdekye/orgtree/releases) for published changes.

## Feedback and contributions

[Open an issue](https://github.com/Maurdekye/orgtree/issues) for a bug or feature request. For a bug, include your Orgtree version, Windows version, the steps that reproduce it and the error text or a screenshot. Remove tokens, authorization codes and other private information before posting.

## License

[MIT](LICENSE). Third-party notices are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
