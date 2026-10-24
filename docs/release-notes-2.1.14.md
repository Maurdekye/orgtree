# Orgtree 2.1.14

GPT-6.1 Sol is now available. New Sol hires and model switches to Sol use
GPT-6.1 Sol (`gpt-6.1-sol`). Every Sol agent that already exists when this
version first opens an organization keeps running the model it runs today: an
agent on the GPT-6 default is pinned to version 6 in its configuration menu,
and an agent already pinned to 6 or 5.6 keeps that version. GPT-6.1 Sol can be
chosen from the same menu at any time. An organization with its own custom Sol
model ID is left unchanged.

GPT-6.1 Sol needs Codex CLI 0.159.0 or newer. Orgtree does not install or
update the Codex CLI itself, so on a machine with an older one, hiring or
switching an agent onto Sol is refused with the installed version and the
update command, instead of a first turn that fails with "not supported with
ChatGPT account". Codex CLI 0.155.1 does not list the model; 0.159.0 lists it
as its default. Existing Sol agents pinned to 6 or 5.6 are not affected.

GPT-6.1 Sol pricing: $2 per million input tokens, $0.10 per million cached
input tokens and $10 per million output tokens, with a 1.05M context window.
The Sol seat stays two credits. Agents pinned to GPT-6 Sol keep GPT-6 Sol's
pricing.

Source verified September 29, 2026: the `model/list` answer of Codex CLI
0.159.0 on a signed-in account, and OpenAI's model page for gpt-6.1-sol.

This stable patch contains no private v3 prototype changes.
