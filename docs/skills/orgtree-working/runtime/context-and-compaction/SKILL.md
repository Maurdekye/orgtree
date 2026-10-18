---
name: orgtree-context-and-compaction
description: Choose between provider compaction and a fresh-session handoff while respecting context and cache evidence.
---

Up: [orgtree-runtime](../SKILL.md)

# Context and compaction

Context occupancy describes the conversation carried into model requests. It can be measured, estimated, unknown, or empty after a reset; those states are not interchangeable. A stored context-window size and a large transcript file do not establish the next prompt's actual occupancy.

## Two different operations

Provider compaction summarizes within the provider session. The org's `compact_at` setting is handed to supported Claude Code/Codex launches; a running CLI retains the value it launched with. The current desk `/compact` path supports Claude-compatible sessions and Muse's session compaction; unsupported lanes can refuse it. Setting values and defaults live in `orgtree-org-basic` (orgtree-app › org-settings).

A [cheap compact](../tool-cheap-compact/SKILL.md) replaces the conversation context with a fresh session and a runtime-built handoff on the same agent record. Its tool page owns the idle/session/authority gates, export bounds and summary contents. It is useful when recent decisions and durable files are enough to resume, but the entire old conversational context is no longer worth carrying. Prepare [breadcrumbs](../../workspace/breadcrumbs/SKILL.md) and docket progress first.

The agent menu Compact… and the desk context wheel open the same Normal compact / Cheap compact / Cancel choice. Normal support comes from the actual harness route: Claude Code and Muse are supported; Codex, Antigravity, OpenCode and unknown routes show it disabled with a reason. Loading or failed capability reads keep normal disabled while cheap remains available if eligible. A compact request starts only when its response says started:true; started:false carries a refusal reason and must not be presented as a started compaction. Bulk subtree, all-subordinates, project and org-root Compact entries open the same separate confirmation with two counted actions, compact N agents and cheap-compact N agents, plus Cancel. There are no radios; both mode previews show count-only summaries with hover tooltips listing every covered name. Shared skipped reasons appear once; Normal-only reasons stay under Normal. Names, chips and expanders are absent from the body. Each zero-target action is disabled. Normal checks actual capability when the dialog opens: unsupported, no-session and unreadable seats are skipped; while checking, Normal confirmation is disabled. There is no automatic fallback to Cheap. Both types retain existing bulk eligibility and run sequentially under one overlap guard. Cheap rechecks if_idle; Normal rechecks actor admission and reports started, refused and failed requests separately, never claiming a refusal or mere admission completed compaction. Cancel performs no compaction.

## Automatic fresh starts

The optional known-cold policy can choose a cheap compact before a normal turn. It requires an existing eligible session, measured nonzero context at or above the configured occupancy, and a forecast that calls for compaction. Estimated/unknown context, an already reset context or an unknown cache forecast does not justify a reset just because enough time passed.

The policy merges an agent override key by key over effective org policy. Its user-facing controls and numerical defaults belong to `orgtree-org-policies-compaction` (orgtree-app › org-settings) and `orgtree-agent-fresh-start` (orgtree-app › agent-settings).

A reset clears the old session's cache receipt/occupancy evidence before a new forecast is published. Local process replacement by itself is not proof of a provider miss. A new session or changed namespace/prefix has a cache-continuity cost to consider; see [cache continuity](../../accounts/cache-continuity/SKILL.md).

## After any compaction or fresh session

Read the handoff and breadcrumbs, then recover conversations with correspondents before replying; use [inbox conversation recall](../../mail/tool-inbox/SKILL.md). Inspect the docket and actual artifacts rather than reconstructing settled decisions from memory. Earlier history can still be read, but a summary cannot establish whether an interrupted external command finished. Do not close a surviving user question merely because the fresh session does not remember asking it.

## See also

- [orgtree-tool-compact](../tool-compact/SKILL.md): Native normal compaction, capability and admission reporting.

- [orgtree-tool-cheap-compact](../tool-cheap-compact/SKILL.md)
- [orgtree-cache-continuity](../../accounts/cache-continuity/SKILL.md)
- [orgtree-breadcrumbs](../../workspace/breadcrumbs/SKILL.md)
- `orgtree-org-policies-compaction` (orgtree-app › org-settings)
