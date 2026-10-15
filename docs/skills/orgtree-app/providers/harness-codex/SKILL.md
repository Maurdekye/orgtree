---
name: orgtree-harness-codex
description: Explain Codex's Orgtree app-server, sandbox posture, approvals and native instruction loading.
---
Up: [orgtree-providers](../SKILL.md)

# Codex seats

Codex runs OpenAI seats and is a selectable harness for OpenRouter/language servers. Its stdio app-server holds a thread/session; Orgtree supplies dynamic tools, answers approvals from scope, and uses `turn/steer` for supported mid-turn mail.

## Provider and model

Native Codex uses its chosen OpenAI login/profile. OpenRouter and language-server routes configure the selected provider separately. A local Codex route needs Responses API compatibility; see [language servers](../language-servers/SKILL.md). Current model discovery supplies offered model versions and supported reasoning levels. A saved effort/model string is not proof of support.

For quota windows and cache estimates see `orgtree-usage-windows` and `orgtree-cache-continuity` (orgtree-working › accounts).

## Sandbox and command approvals

Sandbox/approval policy follows write capability and permission mode; an Orgtree folder list alone is not proof that the CLI's OS sandbox started successfully. On Windows, non-bypass seats can be hosted in the interactive user's session when the helper is available. Session 0 fallback posture is different. Read-only seats without a working OS sandbox have command access closed through the approval policy.

A known Windows elevated-sandbox failure can occur before a shell starts, with a runner pipe-in timeout. The runtime recognizes that specific completed failure and can steer an eligible same-command retry through the existing shell-and-write approval gate. Read-only/plan seats receive no escape route. Do not prescribe changing permission mode as a generic cure or assume every command timeout has that diagnosis.

## Instructions and skills

Codex reads home AGENTS.md plus the project chain from a .git root to cwd (cwd alone without a root). AGENTS.override.md wins in a directory. Orgtree supplies otherwise omitted scratch/granted standing notes, including legacy CLAUDE.md; Codex does not natively read CLAUDE.md.

Startup files enter the launch fingerprint; their edit can replace a parked app-server on the next turn while resuming its session. That changes startup context and can cost provider-cache continuity.

The checked source predates the shared-skills integration. Use the catalog and paths actually delivered to the session; do not infer native loading from Claude-style paths in generic identity text. Installation, sign-in, model entitlement, scope and tool readiness are independent checks.

## See also

- [orgtree-providers-tab](../providers-tab/SKILL.md)
