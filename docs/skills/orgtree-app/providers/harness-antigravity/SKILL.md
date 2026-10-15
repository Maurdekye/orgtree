---
name: orgtree-harness-antigravity
description: Explain Antigravity model pools, hook-based scope and mail delivery, and its Claude-model opt-in.
---
Up: [orgtree-providers](../SKILL.md)

# Antigravity seats

Antigravity (`agy`) runs Google's provider lane, including Gemini-family models and optionally its Claude-family offerings. Those Claude models use the Antigravity login and Google's third-party-model windows; they are not Anthropic subscription seats.

## Runtime behavior

The driver keeps a stream-JSON process and can resume its conversation. Orgtree tools use a private MCP bridge. Print mode cannot answer ordinary interactive prompts; scope is enforced through hooks. Read-only seats have shell closed rather than a terminal that could bypass read-only authority.

Invocation hooks can insert mail during a turn without interrupting it. Their local delivery receipt is evidence of the handoff, not proof the model obeyed the content. This lane's message tools retain the flat argument shape; do not blindly copy another harness's nested metadata form. See `orgtree-tool-message` (orgtree-working › mail).

Antigravity has no supported secondary subscription-profile setup in this integration. Native sign-in is completed through the terminal flow; opening that terminal is not a verified successful login.

## Claude-through-Antigravity setting

App settings → Runtime exposes “enable Claude Sonnet 5.5 and Opus 5.5 through Antigravity.” Storage is runtime key `antigravity_claude_enabled`; default false. The user can opt in when the Antigravity account/catalog supplies those models and their pool has capacity. Enabling it makes the offered tiers eligible; it does not install a CLI, sign in, buy capacity or change a model's provider identity.

The toggle is read from effective runtime configuration; it is not an OS/UAC or app-restart action. Any later model/provider/session change has its own context/cache consequences. Agents explain/suggest this setting; they do not change it themselves.

For exact applicable Gemini versus third-party windows and uncertainty, see `orgtree-usage-windows` (orgtree-working › accounts). Read actual discovery/status rather than treating a stale catalog or hidden model as entitlement.

## See also

- See `orgtree-tool-message` (orgtree-working > mail).
