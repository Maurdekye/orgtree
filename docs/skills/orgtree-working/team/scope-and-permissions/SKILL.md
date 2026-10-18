---
name: orgtree-scope-and-permissions
description: Interpret effective folder, tool and permission grants and request an authorized change when they block the task.
---
Up: [orgtree-team](../SKILL.md)

# Effective capability

Scope combines granted folders, native-tool switches, external MCP servers, Orgtree tool groups, organization visibility and permission mode. The effective value is clamped through the ancestor chain and org ceiling; a broader stored value is not evidence that the worker can use it. Read [state inspection](../../inspection/tool-state-inspect/SKILL.md) for actual effective fields and [visibility](../../inspection/visibility/SKILL.md) for the chart/read boundary.

Folder entries distinguish read-only (`ro`) and writable (`rw`). A parent's read-only folder cannot become a child's writable grant. A scope edit may affect descendants or intermediate managers; the exact additive/removal and propagation rules live in [retool](../tool-retool/SKILL.md). Org/team shared folders have their own position-based grants; see [shared folders](../../workspace/shared-folders/SKILL.md).

Native switches are bash (shell), web (web capability), edit (file editing), and subagents (provider-native helpers). MCP grants name external servers; they are separate from the engine's own groups. A disabled capability may remove tool definitions and also refuse an invocation retained from an older turn. A charter mentioning an unavailable tool does not restore it.

| Orgtree group | Gated tools, omitting the orgtree_ prefix |
| --- | --- |
| docket | work; staff also needs team. |
| team | hire, rehire, retire, dissolve, move, reorder, rename, reallocate, switch_model, cheap_compact, retool, swap, self_subjugate; staff also needs docket. |
| messaging | message, send_notice, inbox, audience, transfers. |
| inspection | chart, state_inspect, usage, list_tiers, list_orgs, read_transcript, read_scratch. |
| watchdogs | watchdog. |
| runtime | interrupt, halt, unhalt, unstick, continue_on, account_mark; optional usage refresh also needs runtime. |
| user | ask, withdraw_ask, present, send_file, request_credits, request_scope. |
| logo | org_logo: set/remove this organization's Logo, logged and undoable. |

`orgtree_project` slot release and status need **either team or watchdogs**. With watchdogs on and team off, its card exposes only `action=release_slot` (your own lease, optional note) and `action=slots` (your own holds, line entries and history, marked `own_only`; `held` counts your holds). Project reach and lease ownership still apply. All other project actions, full slot status and force release require team. With both groups off, the project tool is absent and calls are refused. Missing switches still default on; inherited denials still apply.

Status reporting is always available. Missing group switches default on; explicit ancestor denials remain effective. The scope API rejects unknown group names and non-boolean values.

Permission modes form the engine hierarchy plan < default < acceptEdits < bypassPermissions, bounded by ancestors. The staffing tool schema offers the latter three. Headless agents cannot answer an interactive plan/approval workflow merely because a guide names it. Each harness maps these modes differently; see `orgtree-harness-claude-code` (orgtree-app › providers), `orgtree-harness-codex` (orgtree-app › providers), `orgtree-harness-muse` (orgtree-app › providers), `orgtree-harness-opencode` (orgtree-app › providers) and `orgtree-harness-antigravity` (orgtree-app › providers).

On the Claude/Codex lanes whose startup instructions describe the sensitive-path gate, writable grants alone do not clear protected components such as .git, .claude, .cargo and .vscode. A required approval can fail headlessly at a non-bypass mode. Use normal git operations for git's own internals, not manual lock-file manipulation or path respelling. This is not a universal claim about every harness's protected-path system; read the active lane's instructions.

For a genuinely needed missing capability, use [request scope](../../user/tool-request-scope/SKILL.md) when that tool is available. Without its user group, ask your superior to grant the scope; do not work around the restriction. User settings are explained in `orgtree-agent-visibility-access` (orgtree-app › agent-settings), `orgtree-agent-folders-tab` (orgtree-app › agent-settings) and `orgtree-agent-tools-tab` (orgtree-app › agent-settings).

## See also

- [orgtree-tool-request-scope](../../user/tool-request-scope/SKILL.md)
- [orgtree-tool-retool](../tool-retool/SKILL.md)
- [orgtree-visibility](../../inspection/visibility/SKILL.md)
