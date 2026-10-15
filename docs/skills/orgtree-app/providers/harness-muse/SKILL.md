---
name: orgtree-harness-muse
description: Explain Muse model entitlement, MSP permissions, Session 0 limits and dated usage.
---
Up: [orgtree-providers](../SKILL.md)

# Muse Code seats

Muse Code uses MSP v1 through one `muse serve` host per agent. Orgtree launches contributor mode off on every process without editing the user's saved setting. A subscription seat never receives META_API_KEY; paid inference is not a silent substitute.

## Model and login entitlement

Wonder costs four organizational seat credits, Wonder Full ten, Spark two. The login's authenticated catalog must offer the exact model/version; a bundled model row without account entitlement is not an offer. Wonder Full is not assumed to share Wonder's quota pool. Each model supplies its own supported effort names; compatibility clamping preserves a saved choice rather than silently rewriting it.

Registered logins are isolated; each is checked independently for placement, continuation and fallback. The own login's catalog cannot prove another login's entitlement. Account controls are in [accounts registry](../accounts-registry/SKILL.md).

## Runtime and permissions

MSP supplies sessions, steering, tools, usage and scope-based approvals. Current writable workspace roots travel with turns; read-only grants are not supplied as roots because Muse treats roots as writable. Read-only seats have shell disabled.

On Windows Session 0, write seats run with Muse's OS sandbox disabled. Some shell/file operations can exceed folder grants without an approval callback. Requests that do arrive are answered from scope once, including all open stages; persistent approval rules are never chosen. This posture must be stated accurately rather than inferred from “ask” mode alone.

Muse reads the first existing workspace-root rule file among AGENTS.md, CLAUDE.md, .agents/AGENTS.md and .claude/CLAUDE.md. Additional granted-folder notes are supplied by Orgtree. Muse advertises its session-loaded skills and read_skill; cross-harness sharing was pending relative to the checked base.

## Usage and unknown values

Muse dates its own five-hour/session and weekly observations. Another model's observed windows do not establish room for this model, while model-less account-wide observations can. Missing is not zero. The provider publishes neither prices nor cache lifetime; keep cost/expiry unknown even when token/cache-read counts exist.

For detailed window interpretation see `orgtree-usage-windows` (orgtree-working › accounts). For held background work, compaction and shutdown policies use the runtime guides; a warm Muse host is not proof of a provider cache hit.

## See also

- See `orgtree-usage-windows` (orgtree-working > accounts).
