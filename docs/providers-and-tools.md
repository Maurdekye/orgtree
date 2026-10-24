# Providers, models and tools

[Documentation](../README.md#documentation) · [Previous: Settings and usage](settings-and-usage.md) · [Next: Collaborating and Hubchat](collaborating.md)

Start here when one working provider is no longer enough, or when you want to choose accounts, connect your own inference server, or give agents more tools.

## Connect another provider

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

**Installed**, **signed in**, **active**, **allowed by this org** and **able to run this model now** are separate checks. The provider Enabled switch is app-wide; an account's Active switch is another gate; Organization settings > Accounts is a third. Turning one on does not bypass the others. Existing agents can remain visible on a model that is no longer offered for a new hire.

For older catalog choices, **App settings > Runtime > Show legacy models (Terra, Gemini Pro)** controls visibility in hire/model menus. It starts off and is saved in the local desktop/browser profile. It does not change existing agents or create access to a model your account cannot use.

The default Codex row offers **Sign in / Sign in again**, opening Codex's browser authorization with its default profile. A managed account's Sign in targets that row's profile. Complete the authorization yourself; browser-only clients have no native login bridge. Some other harnesses open a terminal and ask you to finish login there: “terminal opened” is not verified sign-in. An unavailable authentication check is different from a confirmed signed-out result. Do not paste keys or verification codes into an agent conversation.

**Providers > Refresh** immediately requests ordinary discovery/sign-in checking instead of only reading the periodic snapshot. One check runs at a time; overlapping requests and results completed within the last two seconds are shared. After a sign-in, verification checks that provider without probing unrelated providers. Discovery is separate from **Usage** account refresh and does not perform model inference, switch accounts or authorize the browser for you. An authorized agent can request the same discovery through its tier-list refresh, while browser sign-in remains a human action.

## Choose a harness and a model

A **harness** runs tools and manages the agent session. A **model provider or server** supplies inference. Claude Code, Codex, Antigravity, Muse Code and OpenCode are harnesses; OpenRouter and Language model servers are routes through installed harnesses. Gemini models use Antigravity in Orgtree.

| Harness | Useful distinctions in this integration |
| --- | --- |
| Claude Code | Hook-boundary mail delivery; native normal compaction; supported native models can accept live effort controls and fast mode. |
| Codex | Exact-turn steering and interrupt, native command-output streaming and a human MCP permission bridge. Orgtree does not offer its normal compaction action. |
| Antigravity | Invocation-hook mail, process-tree interrupt and recovered native thought/tool history where available. The Windows subscription login has a shared-keyring limitation. |
| Muse Code | Exact-turn steering, managed account profiles, native normal compaction and turn-observed allowance. No independent fresh usage query. |
| OpenCode | Chat Completions routes, ACP tool/stream output and supported tool-boundary mail delivery; unavailable hooks leave mail for the next turn. |

All routes share Orgtree's persistent identity, mail, docket and fresh-session handoff facilities. They differ in timing, image delivery, native approval mechanisms and observable output. Antigravity/OpenCode image attachments use a text/path envelope in this adapter; Claude, Codex and Muse have native image-input paths. Missing thought text or live output is not evidence that a tool did nothing.

Codex reasoning steps that supply no readable summary keep a sealed thought
placeholder in saved Chat history. It records the step without exposing
encrypted reasoning; supplied readable summaries remain available. Existing
omitted sealed steps are not backfilled. Agents reading transcripts can receive
supplied thinking and sealed markers from every harness; those reads cap each
row's thinking at 1,200 Unicode characters and report when it was shortened.

Folder and approval enforcement also varies. Read the permission choices in [Managing agents](managing-agents.md#give-the-agent-the-right-access), and use a task with a narrow known scope when trying a new route. No comparison of features guarantees equal model quality, speed, tool obedience or operating-system isolation. The app's **Harnesses** tab lists detected versions and official installation links; installation/version updates are separate from adding a model.

**Muse normal-write seats in Windows Session 0 disable Muse's operating-system sandbox.** Some native shell/file operations can then exceed folder grants without asking Orgtree for approval. A normal-write Muse CLI running in the signed-in session keeps its sandbox; the engine's session alone does not establish the CLI's actual placement. Read-only and Unrestricted use their own policies. See the [Muse permission reference](skills/orgtree-app/harnesses/harness-muse/SKILL.md#tools-permissions-and-sandbox) before relying on folder confinement.

## Manage multiple accounts

Use a provider's add-account dialog to create a managed profile, import a supported existing profile, or enter an API key. These are distinct authentication/billing paths. Claude and Codex support appropriate profile imports; Muse uses isolated managed config/data roots and refuses profile-folder import. Native/default rows cannot be removed like registered accounts.

On Windows, the checked Antigravity CLI uses one Google sign-in in the user's Credential Manager even with different profile folders. A second login can replace the first for all agents. Its dialog therefore does not offer an ordinary second managed subscription login; a separate API key is a different route. Existing registered subscription identities must pass distinct-identity checks rather than silently use the ambient login.

Account rows show identity, Active state, bound-agent count and relevant management actions. A missing or stale identity is not invented. Use **Organization settings > Accounts** to reserve account lanes for particular organizations; newly registered accounts start allowed unless you restrict them. Select an agent's binding in its Model settings when you intend a specific login.

Removing a registered account is consequential: bindings/defaults can move to an eligible replacement or agents can remain frozen. The toast reports the result. Removing and recreating an account is not a way to refresh a stale usage display. For a capacity mark, **clear…** asks for a reason and checks that exact mark; clearing adds no allowance and resumes no agent.

### Automatic fallback and metered keys

**Organization settings > Autonomy > automatically switch accounts after a usage limit** is off by default. An agent can inherit or override it. Eligible same-provider subscription profiles need verified capacity; Muse also needs entitlement to the exact model. A successful fallback retains the new binding. It does not rebalance a running agent continuously or switch to a different provider.

**Fall back to API-key accounts** is a separate app-wide provider opt-in, also off by default. It permits paid failover only with the other fallback and eligibility checks satisfied. Adding an active key alone does not turn it on. Native subscription Active and each registered account's Active are separate controls.

Account changes alter the account/cache namespace. Codex and Muse start new sessions on fallback; an interrupted task continues through the recorded replay/handoff. Neither a saved binding nor clearing a freeze proves the provider now has room. [Operating and troubleshooting](operating-orgtree.md) covers reset-time resume and manual recovery.

## Offer OpenRouter models

Open **Providers > OpenRouter**, add a key and choose an installed compatible harness. Set an optional name; keys are peer entries, not one special primary key. Keep the key Active, enable the provider and allow it in the org. Store the secret in the key field. On Edit, a blank key retains the stored secret; it is not displayed again.

Use the model browser to select the models offered in hire/model menus. Search by name, vendor or exact ID, inspect context/tool/image capabilities and price where known, and choose models appropriate to the task. Unknown capability or price is not zero. Model toggles persist as you choose them; leaving the browser is not a rollback of all selections.

The key card's spend cap and balance come from OpenRouter; they are not editable Orgtree budget fields. Keys on one account can share its balance. A successful catalog query does not prove a selected key has capacity for an agent task.

Changing a key's harness reaches unpinned agents at their next turn with a fresh-session handoff. An agent explicitly pinned to a harness keeps that choice; the dialog reports such seats. A missing harness is refused rather than silently substituted. Removing a key can reassign its agents or leave them waiting. Check those consequences before changing a shared key.

<a id="language-servers"></a>

## Language model servers

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

Changing **Seat price** also attempts to reprice existing agents using that server, across organizations. Each organization's update can succeed or fail separately under its credit constraints. Inspect any reported failures and the current grants before retrying; the saved server price does not prove every existing seat was repriced.

Output settings depend on the harness. Orgtree configures an 8,192-token generation ceiling for local Claude Code and OpenCode launches. Its Codex route supplies context/compaction settings without that same configured generation-output ceiling; the server and native CLI may impose their own limits. This does not imply unlimited output.

If setup fails, use the server card's **refresh** button to check its answer and reported windows. Check the address, actual listening port and API style; **401/403** indicates an API-key problem. An unavailable harness needs its CLI installed on the Orgtree machine. If a model is absent from hiring, check that it is offered, that both app switches are on, and that the org allows the server. A successful model-list query establishes discovery; try one small agent task to check the model's tool-call behavior. For slow Ollama model loading, its preset notes describe `OLLAMA_LOAD_TIMEOUT=30m` and checking the GPU backend in Ollama's own log.

## Add MCP tools

Configure an external MCP server in an installed harness's own user configuration, then use the shared **Refresh** in Orgtree. Orgtree discovers portable definitions from Claude, Codex, Antigravity, Muse and OpenCode, plus applicable recorded installed Claude plugins. It reads configuration; discovery does not execute a server, sign in or edit the original files.

The inventory shows names, sources and transport. Equal definitions merge their source labels; different definitions with the same name receive aliases. Select the alias shown instead of guessing a suffix. Native OAuth/private settings are not automatically portable, so a remote server may need authentication in the destination harness.

Grant discovered names through **Agent settings > Tools > MCP servers**, or use org hire defaults for future agents. A superior must hold the server or a wildcard. **All registered servers** in hire defaults includes future registrations; an explicit checked list does not. Refresh alone changes neither grants nor every running agent's server connections. Changed startup configuration applies at the permitted process boundary.

The shared Refresh independently updates MCP definitions, skills and global instructions. A partial success retains successful sources and names failures. A metadata count is not proof that a model loaded or used a tool. If a tool is absent, check discovery, alias, effective grant and destination authentication separately. Use a human MCP question card only for the specific request it describes.

Claude can load less common Orgtree tool cards on demand. The agent's instructions explain exact-name ToolSearch discovery; a missing eager card is not proof the tool or its permission was removed. This does not change which tools you granted. Native question/plan replacements have a separate per-agent [Disabled by Orgtree opt-in](managing-agents.md#opt-into-native-replacement-tools).

## Share skills and instructions

Skills are on-demand bundles of guidance and resources. Orgtree supplies its built-in **glossary / Orgtree Encyclopaedia**, with app, working and workflow entry points. It also discovers user skills from installed harnesses' global roots and applicable installed plugins. Agent-local discovery checks supported skill folders inside its scratch and explicitly granted folders; those bundles do not become app-wide exports to other agents.

Imported bundles keep their resources. Identical content can combine source labels; different versions receive aliases. The launch selects the appropriate harness variant when alternatives exist. Your original files are not rewritten. Malformed, linked, generated or oversized bundles are skipped under bounded discovery rules. The shared snapshot is not an installation of every skill's dependencies.

Put a skill in the appropriate native skill folder, refresh and inspect the available inventory. Then ask an agent to use it for a task it is authorized to do. Discovery and delivery do not prove that the model followed the instructions, and a skill cannot grant missing tools or folders. Avoid placing secrets in a portable bundle.

Personal global instruction files can be shared across harnesses through read-only snapshots, avoiding copies already loaded natively by that account. Organization, team and personal scratch notes have their own inheritance rules, covered in [Collaboration](collaborating.md#keep-standing-instructions-in-the-right-place). Native file/token limits still apply. An active turn is not rewritten mid-turn by Refresh; changed selected content applies at a permitted launch boundary and can affect cached input reuse.

## Diagnose a route without changing everything

Check one layer at a time: installed harness → usable sign-in/key → enabled provider/account → org allowlist → model offered/entitled → effective tool/folder scope → actual task result. A model-list query proves discovery, a ready marker proves only the readiness it describes, and an accepted send proves input admission rather than obedience. Keep unknown capacity, pricing and cache expiry unknown.

For team contact and durable shared instructions, continue with [Collaborating and Hubchat](collaborating.md).
