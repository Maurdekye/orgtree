# Agent settings and hire-default copy

User requests, 2026-10-11 17:35–17:39Z: explain native harness tools, use
MCP Servers for the final section, move Credit Grant into Scope, put all three
tool sections last, and align equivalent labels/descriptions with Hire Defaults.

Shared copy in renderer `canvas/modals.tsx` covers agent settings, org Hire
Defaults and draft permissions. Equivalent fields use Folders, Visible agents,
File and command access, Account, Native Tools, Orgtree Tools and MCP Servers.
Visibility and permission options share labels while retaining their saved values.
Agent-only model/session controls have no Hire Defaults equivalent. Hire Defaults'
Provider chooses the default account's provider, not an agent model. Future-hire
scope notes and existing org folder revocation/downgrade effects remain explicit.
Agent actions retains individual actions in settings and organization-wide retirement
in Hire Defaults. The latter appears before scope controls so tool sections are last.

Native Tools explains: “Tools built into the agent's native harness, such as Claude
Code, Codex or Antigravity.” Each toggle has its own subtitle:

| Toggle | Subtitle |
| --- | --- |
| Run commands | Run terminal commands and programs. |
| Browse the web | Search the web and open web pages. |
| Edit files | Create and change files in granted folders, including notebooks. |
| Use helper agents | Delegate tasks to temporary helper agents within the harness. |

The mappings were checked against Rust `runtime/tool_policy.rs` and `runtime/agy.rs`.
Tool flags, handlers, parent ceilings, MCP wildcard behavior, account eligibility,
folder grants, save/cascade validation and permission values are unchanged.
CreditGrant keeps its original condition, key and props within the always-mounted
Scope panel; its ResizeObserver observes width changes when the panel becomes visible.

Measured verification: existing `npm run typecheck` passes after the final layout/copy
change, and `git diff --check` passes. Source audit checked all three shared forms
and retained bindings. No dependencies installed, app build, live app changes or
renderer launch. Visual layout and actual slider interaction after opening Scope
remain unmeasured during the paired performance benchmark.
