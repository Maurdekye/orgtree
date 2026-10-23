# Getting started

[Project overview](../README.md) · [Getting started](getting-started.md) · [Collaboration](collaborating.md) · [Operation and privacy](operating-orgtree.md) · [Development](development.md)

## Install

The published installer is for **64-bit Windows**. Windows builds are unsigned; macOS and Linux builds remain prototypes.

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
| Muse Code | Install and sign into [Muse Code](https://dev.meta.ai/docs/muse-code#install). |
| OpenRouter | Configure your OpenRouter API key and choose the models you want offered. |
| Language model servers | Connect a model server on your machine or network, using an installed Claude Code, Codex or OpenCode harness. See [setup below](#language-servers). |

For providers with secondary-account support, use the add-account button in that provider's header. Create a managed profile, or import an existing profile where that provider supports it, then use the account row to manage it or sign in again. Muse supports managed profiles and API keys, but not profile-folder import. Account usage belongs in the dedicated **Usage** window, opened from the **Orgtree** menu.

Orgtree does not include model access. Your provider's subscription, API charges and usage limits still apply. Availability depends on the provider, installed tools and signed-in account.

<a id="language-servers"></a>

### Language model servers

The **Language model servers** provider runs agents on models you serve yourself with Ollama, LM Studio, llama.cpp, vLLM or a compatible server. Claude Code, Codex or OpenCode supplies the agent harness; the configured server supplies inference. Install the harness on the Orgtree machine, and start the model server separately. Choose a model that supports tool calls and has enough memory and context for coding tasks.

The setup section is available in **App settings > Providers** before you add a server. Servers are registered through **Add server**; Orgtree does not scan your network for them. Configured, enabled servers contribute the models you offer to the hiring menus. The harness dropdown detects installed CLIs and explains unavailable choices.

1. **Start your model server.** Download or load the model using that server's own controls, and enable its HTTP API. Use the address reachable from the machine running Orgtree.
2. **Open App settings > Providers > Language model servers > Add server.** Choose a server preset, enter its **Address**, and select an available **Harness**. Presets supply the API path; enter the server's base address, such as `http://127.0.0.1:11434`.
3. **Find and offer models.** Click **Find models**, select the models to offer, and set each model's context window to match the server. One discovered model is selected automatically; several open the model browser. You can also add the server first and offer models later.
4. **Set capacity and save.** **Agents at once** limits concurrent turns on this server; excess turns wait. It defaults to **1** and accepts **1–64**. **Seat price** is the Orgtree capacity credit cost per agent, default **1**, independently of hosting costs. Give the server an optional **Name**, then click **Add server**.
5. **Allow it in your organization.** Keep the provider and individual server enabled in App settings, and check that server under the org's **Settings > Accounts**. Choose one of its offered models when hiring an agent.

| Preset | Initial address in Orgtree | Setup notes |
| --- | --- | --- |
| [Ollama](https://docs.ollama.com/integrations/claude-code) | `http://127.0.0.1:11434` | Use 0.14 or later. Configure the model's actual context window before offering it. |
| [LM Studio](https://lmstudio.ai/docs/developer/core/server) | `http://127.0.0.1:1234` | Use 0.4.1 or later; start the API server in its Developer tab. Set context when loading the model. |
| [llama.cpp](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md) | `http://127.0.0.1:9931` | Use the port your `llama-server` actually listens on; older builds use 8080. Orgtree's Codex integration was tested with b11540; older Responses implementations may be incompatible. |
| [vLLM](https://docs.vllm.ai/en/latest/serving/integrations/claude_code/) | `http://127.0.0.1:8000` | Enable tool calling for your model. With Claude Code, use a served model name without `/`. Some reasoning models are incompatible with Codex's returned reasoning items. |
| Custom… | Your HTTP or HTTPS address | Select Anthropic-compatible **Messages** for Claude Code, OpenAI-compatible **Responses** for Codex, or **Chat Completions** for OpenCode. The server must implement the protocol for the harness you select. |

For **Custom…**, set **Base path** if needed: it is appended to Address. For a typical Codex endpoint, use Address `https://models.example.net` and Base path `v1`; Codex appends `/responses`. Claude Code appends `/v1/messages` to its configured base; OpenCode uses `/chat/completions` below its configured API base. Enter an **API key** only if your server requires one. If discovery is unavailable, enter exact **Model ids**, separated by spaces or commas, and their **Context size**. A server keeps the harness it was created with; to use multiple harnesses against one address, add a separate entry for each.

**Match the real context window.** Orgtree flags windows below **65,536 tokens**: its agent instructions and tool definitions need substantial space. Changing the number in Orgtree does not enlarge the server's window. Ollama can otherwise run a model with only 4K context and truncate longer prompts. Set its `num_ctx` or `OLLAMA_CONTEXT_LENGTH` to at least `65536`, or use **Create a 64K version of this model** when offered. That action adds a model entry with the same weights and its own context setting; it does not download new weights. Check the displayed window mismatch before hiring.

To change a saved server's address, key, capacity or other settings, use its **edit** button, then **Save**; **Cancel** discards the draft. Model chips offer or withdraw models immediately, and **more** opens the larger browser. Withdrawing a model stops new hires on it while existing agents keep running. Turning a server off makes its agents wait; removing it leaves those agents needing a switch to another tier. Org account switches restrict only that org, and cannot turn on a server disabled app-wide. Language model server agents keep their server rather than automatically moving to another one.

If setup fails, use the server card's **refresh** button to check its answer and reported windows. Check the address, actual listening port and API style; **401/403** indicates an API-key problem. An unavailable harness needs its CLI installed on the Orgtree machine. If a model is absent from hiring, check that it is offered, that both app switches are on, and that the org allows the server. A successful model-list query establishes discovery; try one small agent task to check the model's tool-call behavior. For slow Ollama model loading, its preset notes describe `OLLAMA_LOAD_TIMEOUT=30m` and checking the GPU backend in Ollama's own log.

## Your first organization

1. **Create an organization** from the welcome screen. Give it a name and a capacity budget.
2. **Hire an agent.** Choose a model and describe its role in its *charter*: the instructions it should keep following across tasks. You can start from a bundled charter preset.
3. **Give it access to the project.** Select the folders and tools it needs. These settings control what the agent may work with.
4. **Send a concrete task.** Open the agent and describe the result you want, any constraints, and how you will know it is finished.
5. **Follow up in the workspace.** Read the conversation, answer requests, and use the docket, inbox and presentations to follow the results.

Start with one agent and a small task. Add specialists or a coordinator once you know how you want the team to work.

For shared notes, team connections and phone access, continue with [Collaboration](collaborating.md).
