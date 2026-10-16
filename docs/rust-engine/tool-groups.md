# Scope-dependent tool definitions

Every Orgtree group defaults to **on**, for existing and newly hired agents.
Set individual booleans in `scope.tools.orgtree` through hire, rehire, retool,
staff, hire defaults or the Scope editor. Missing keys mean on. A child's
effective grant is intersected with all ancestors. An agent cannot grant
capabilities it does not hold. User edits retain the existing scope cascade.
Malformed group names and non-boolean values are refused.

`orgtree_status` and the self-only read `orgtree_next_turn` are always
available. All other tools require these groups:

| Key | Tools (without the `orgtree_` prefix) |
| --- | --- |
| `docket` | work; staff also requires team |
| `team` | hire, rehire, retire, dissolve, move, rename, reallocate, switch_model, cheap_compact, retool, swap, self_subjugate; staff also requires docket |
| `messaging` | message, send_notice, inbox, audience, transfers |
| `inspection` | chart, state_inspect, list_tiers, list_orgs, read_transcript, read_scratch |
| `watchdogs` | watchdog |
| `runtime` | interrupt, halt, unhalt, unstick, continue_on, account_mark |
| `user` | ask, withdraw_ask, present, send_file, request_credits, request_scope |
| `logo` | org_logo (set/remove this org's Logo; immediate, logged, undoable) |

User 2026-10-15 22:10Z explicitly made `logo` on by default, including older
scopes with no key. It is independent of `team`, `user` and org-inbox audiences.
The shared Tools controls and org hire defaults expose **Organization Logo**.
Execution rechecks current identity, inherited permission and file grants under
the org mutation lock after decoding, in addition to the ordinary dispatch gate.

Disabled tools are absent from MCP `tools/list` and Codex dynamic tools. The
engine also refuses their invocation, including a call remembered from an
older turn. Claude keepalive requests use the same scoped list. Generated
Orgtree prompt sections follow the groups: docket rules, hiring guidance,
watchdog guidance and user question/delivery guidance are omitted when their
group is off. User-written charters and folder notes remain verbatim.

Changing a scope changes the model's startup prefix and tool definitions;
its next session may therefore lose provider prompt-cache reuse. Scope changes
already participate in runtime configuration fingerprints. No claim of a
provider cache hit follows merely from a warm local process.

## Built-in capabilities

| Switch | Claude Code tools omitted when off | Codex configuration |
| --- | --- | --- |
| Always omitted | AskUserQuestion, EnterPlanMode, ExitPlanMode, CronCreate, CronDelete, CronList, ScheduleWakeup, Monitor, RemoteTrigger | No additional blanket replacement rule; existing scope mappings below apply |
| bash | Bash, PowerShell, BashOutput, KillShell | shell_tool, unified_exec and code_mode feature switches off |
| web | WebSearch, WebFetch | web_search disabled; web_search_request, web_search_cached, standalone_web_search and browser_use off |
| edit | Edit, Write, NotebookEdit, MultiEdit, EnterWorktree, ExitWorktree | resolved model catalog apply_patch_tool_type null; existing write approval policy remains |
| subagents | Task, Agent, SendMessage, Workflow, ListAgents, TeamCreate, TeamDelete | multi_agent and multi_agent_v2 off; resolved model catalog multi_agent_version null |
| bash AND subagents off | TaskStop | covered by shell/subagent switches |
| MCP server not granted | That server's tools | That server's tools |

Claude's `--disallowed-tools` removes definitions from the actual request; it
is also a runtime restriction. Tools with no unambiguous capability mapping,
such as Read, Glob, Grep, Skill and ReportFindings, retain their harness defaults.
SendMessage remains available when ephemeral subagents are enabled.

Codex model metadata can select multi-agent v2 even with its feature switches
off. Before a restricted Codex process starts, Orgtree asks the installed CLI
for its resolved model catalog using that seat's existing environment and
configuration. It writes a content-addressed copy that changes only denied
capability fields, preserving instructions, model names, context sizes and
other metadata. If the CLI cannot supply the catalog, startup fails with a
plain error rather than claiming that tools were removed. This also works
with the custom catalog already used by language-server seats. Catalog calls
never log credential-bearing environment arguments.

## Requesting a group

An agent with the user group may request a missing group using the existing
scope card, for example:

```json
{"items":[{"kind":"tool","tool":"orgtree.docket"}],"reason":"Track the assigned work"}
```

Approval grants the nested group. Without a user audience the existing
request route sends it to the superior. An agent with the user group off
cannot invoke request_scope; scope can still be granted by its superior or
through the user's Scope editor.

## Validation

- `cargo test --bin orgtree-engine`: 65 passed, including all 128 group masks
  across three harnesses and top-level/subordinate generated instructions.
- `tools/rig/proofs/tool-groups.mjs` captures real installed Claude Code and
  Codex first requests against the isolated fake language server; default,
  groups-off (native switches unchanged), all-capabilities-off and local-chores scopes, inherited denials, execution rejection and
  approval paths. **45/45 runtime checks passed**, using real installed
  harnesses and fake inference, after rebase onto `a88b736`.
- Captured Claude first-request JSON sizes were 138,698 bytes by default,
  76,902 with Orgtree groups off, 58,508 for local chores (messaging and
  watchdogs only; bash on), and 32,257 with all capabilities off. These are
  **byte sizes, not token counts**. Evidence: `tool-groups-20261011T095333`.
- `tools/rig/proofs/tool-groups-ui.mjs` exercises the actual Scope editor,
  save/reopen and inherited ceilings in offscreen Electron. **5/5 passed**;
  the inherited-disabled screenshot was inspected. The earlier renderer OOM
  was resolved by waiting for the machine's other heavy work to finish.
  Evidence: `tool-groups-ui-20261011T095301`.
- Post-rebase Rust unit tests passed **65/65**, renderer typecheck passed,
  and the rig engine and renderer built successfully. No live app, installer,
  production accounts or real model generation were used.
- Exact tokenizer measurements are pending the coordinator's notification
  that the user's tokenizer server is available. Only `/tokenize` is approved;
  do not start the server or request generation.
  `tools/rig/count-tool-groups.py` counts saved Claude text and tool parts;
  it excludes chat-template framing, so the sum is not billed prompt usage.
