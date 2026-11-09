---
name: orgtree-language-servers
description: Explain local-server fields, compatible APIs, model windows, capacity and pricing effects.
---
Up: [orgtree-providers](../SKILL.md)

# Language model servers

Providers → Language model servers connects local/self-hosted model servers such as Ollama, LM Studio, llama.cpp, vLLM or a custom compatible service. This is inference configuration, not an editor LSP. Account and usage labels use `LM server: <name>`; the compatible provider ID remains `langserver`, account ID `langserver:<id>`, and API `/api/langservers`. App settings store server/model metadata and separate secret storage retains optional keys.

## Add server fields

The form starts on Ollama, its preset address, first available compatible harness, one agent at once, one seat credit, default 65,536-token context, no picked models/key/name override.

| Field | Meaning and limits |
| --- | --- |
| Server | Preset or Custom; changing preset replaces address/harness assumptions and invalidates the old probe. |
| Address | Required base URL. Presets include Ollama 11434, LM Studio 1234, llama.cpp 9931 and vLLM 8000 on localhost. |
| Harness / API style | Claude Code needs Anthropic Messages, Codex needs OpenAI Responses, OpenCode needs OpenAI Chat Completions. Only installed compatible choices are usable. |
| Base path (Custom) | Optional path added to address, such as v1 or api/anthropic; leave blank when already included. |
| API key (Custom add) | Optional password field, stored locally, never returned for display. |
| Model ids (Custom) | Exact server IDs separated by spaces/commas, or chosen after discovery. |
| Context size (Custom) | Actual token window agents are told, default 65,536. Although the input permits smaller draft numbers, engine/hire eligibility requires sufficient context; do not present a smaller input as a supported working window. |
| Agents at once | Integer 1–64, default 1. Additional agents wait for admission. |
| Seat price | Organizational credits per model seat, 0–100, default 1; not provider dollars. |
| Name | Optional on add; names the server in menus. |

Find models asks the server for reachability/catalog metadata without loading a model. The user can add without a selected model and offer models later. A reachable endpoint is not proof it implements the harness's inference API.

## Registering an OpenCode Go subscription (current method)

An OpenCode Go subscription is registered with the **OpenCode Go** preset. Evidence: the underlying settings were reported working by a user on [issue #8](https://github.com/Maurdekye/orgtree/issues/8#issuecomment-6706536279) in 4.5.6; not yet reproduced by the Orgtree team. No dedicated provider exists.

Usage windows: Orgtree asks every enabled server for `<its base URL>/usage` on the usage cadence, with the server's key as a Bearer header (no key, no header; the key is never logged). If the server answers with a `usage` document holding `rolling` (shown as 5 h), `weekly` and `monthly` windows, each with a status, a percent used and a reset time, the Usage panel and the turn's usage board show them like any provider's windows, and a window at 100% blocks starting that server's models. The OpenCode Go preset also tries its own usage route, `https://opencode.ai/zen/go/v1/usage`, when the first route is not there; no other server tries that route. A server that answers 404, 405, 501 or something that is not a usage document has no usage feature: nothing is shown and it is not asked again until Orgtree restarts or the server's address or key changes. A server that reported usage and later fails shows it as unavailable, never 0%. OpenCode Go's route is undocumented, so a window it leaves out is simply not shown, and a value Orgtree cannot read shows as unknown.

1. Open App settings → Providers → Language model servers → Add, and choose **OpenCode Go** as the kind of server.
2. The preset has already filled the address `https://opencode.ai/inference/go`, the base path `openai/v1`, the OpenCode (ACP) harness and the OpenAI Chat Completions API style. Only OpenCode is offered: Claude Code and Codex cannot carry it.
3. Enter your OpenCode Go key (stored locally, never shown again). Context size and typed model ids are not asked: use Find models, which lists the models and takes each window the server reports (65,536 when it reports none). Offer the models to use, then Add server.
4. Hire an agent on that server and pick the model. Chat, streaming and tool calls worked in the report. Seat price and agents-at-once start at the usual defaults.

The endpoint requires an `x-opencode-session` header; the OpenCode harness sends it automatically. If the usage block shows a billing source such as `go` (the subscription allowance), that is what the report observed, not a documented guarantee; native subscription windows are not shown for this route (see [OpenCode](../../harnesses/harness-opencode/SKILL.md)). A second OpenCode Go entry is allowed and is named "OpenCode Go 2".

Fallback: the same server can be entered by hand as **Custom…** with address `https://opencode.ai/inference/go`, base path `openai/v1`, API style OpenAI Chat Completions (OpenCode) and your key, then Find models.

Troubleshooting:

- **401 or 403:** the key is wrong, expired or the subscription is not active; re-enter the key (blank keeps the stored one) and check the subscription.
- **MissingSessionID:** a harness other than OpenCode was chosen, which the preset prevents; on a Custom entry set the harness to OpenCode (ACP) with the Chat Completions API style.
- **Find models finds nothing or fails:** recheck the key and that the address was not edited; on a Custom entry the address has no trailing path (`openai/v1` goes in Base path).

## Existing server and model browser

Active/offering controls gate new hires and existing future turns. Configure edits name, address, harness, optional custom base path, enabled state, concurrency, seat price, models/windows and optional replacement key; blank keeps the stored key and “forget it” explicitly removes it. Save commits the configuration draft; Cancel drops it. Changing a server's harness moves every agent that follows the server at its next turn boundary on a fresh session with a summary while pinned agents keep theirs; on a custom server, changing the API family requires a new base path and warns if any pinned agents are on the other family. One agent on the server can still run another harness the server carries, from its Model tab's **Harness** row (`orgtree-agent-model-tab`); on a custom server only its own API family.

The model browser supplies search/filter and per-model offered/window controls. Opened directly from the saved server, changes save immediately; inside Configure/Add they update the draft. Reported-versus-configured window mismatch is shown; it is not fixed by merely increasing the advertised number. Ollama's 64K variant action creates a variant on that user's server, so suggest it only when wanted.

Seat-price changes reprice existing seats as well as future hires and can hit credit constraints; inspect reported repricing failures. Removing a server leaves existing agents but their next turn cannot find that model. Address/key/model changes affect future launches and can break working routes; no whole-app restart/UAC is inherent.

Minimum/default model context is 65,536. Local Claude Code and OpenCode launches configure an 8,192-token generation-output ceiling. The Codex adapter supplies context and compaction configuration without the same generation-output cap; native CLI/server limits still apply and are not established as unlimited. A tool-output truncation limit is separate from generation tokens. Agents-at-once is a hardware/server scheduling cap, not a subscription bar. Cache lifetime and provider quota remain unsupported; do not invent zero usage.

The llama.cpp preset notes a tested Responses implementation at b11540; older builds can lack required fields. Do not assume an arbitrary server version/API combination works because another harness does.

Agents explain configuration and suggest changes; the user operates these controls. Use the actual server response and runtime error to distinguish unreachable endpoint, missing model, wrong API style, context mismatch and full local concurrency.

## See also

- [orgtree-harness-opencode](../../harnesses/harness-opencode/SKILL.md)
