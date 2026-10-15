---
name: orgtree-language-servers
description: Explain local-server fields, compatible APIs, model windows, capacity and pricing effects.
---
Up: [orgtree-providers](../SKILL.md)

# Language servers

Providers → Language Server connects local/self-hosted model servers such as Ollama, LM Studio, llama.cpp, vLLM or a custom compatible service. This is inference configuration, not an editor LSP. App settings store server/model metadata and separate secret storage retains optional keys.

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

## Existing server and model browser

Active/offering controls gate new hires and existing future turns. Configure edits name, address, optional custom base path, enabled state, concurrency, seat price, models/windows and optional replacement key; blank keeps the stored key and “forget it” explicitly removes it. Save commits the configuration draft; Cancel drops it. The chosen server harness stays with the server rather than being an ordinary editable field.

The model browser supplies search/filter and per-model offered/window controls. Opened directly from the saved server, changes save immediately; inside Configure/Add they update the draft. Reported-versus-configured window mismatch is shown; it is not fixed by merely increasing the advertised number. Ollama's 64K variant action creates a variant on that user's server, so suggest it only when wanted.

Seat-price changes reprice existing seats as well as future hires and can hit credit constraints; inspect reported repricing failures. Removing a server leaves existing agents but their next turn cannot find that model. Address/key/model changes affect future launches and can break working routes; no whole-app restart/UAC is inherent.

Minimum/default model context is 65,536; local output is capped at 8,192 by the launch. Agents-at-once is a hardware/server scheduling cap, not a subscription bar. Cache lifetime and provider quota remain unsupported; do not invent zero usage.

The llama.cpp preset notes a tested Responses implementation at b11540; older builds can lack required fields. Do not assume an arbitrary server version/API combination works because another harness does.

Agents explain configuration and suggest changes; the user operates these controls. Use the actual server response and runtime error to distinguish unreachable endpoint, missing model, wrong API style, context mismatch and full local concurrency.

## See also

- [orgtree-harness-opencode](../harness-opencode/SKILL.md)
