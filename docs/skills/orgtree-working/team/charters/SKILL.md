---
name: orgtree-charters
description: Distinguish role, team and organization instructions and understand how their edits reach an agent.
---
Up: [orgtree-team](../SKILL.md)

# Standing instructions

Your role charter gives your identity and continuing responsibilities. Your team charter gives standing instructions to you and your descendants. Ancestors' team charters are also included. The startup identity renders your own charter, your team charter, ancestor charters, then organization notes from org.md; this rendering order is not a conflict-resolution algorithm or permission to override higher-authority instructions.

Read the actual source and authority of an instruction. The user's organization instructions remain user instructions; a manager's team charter cannot grant denied capabilities or override higher-priority requirements. Keep role/task scope consistent with current user decisions. If standing instructions conflict materially, escalate the concrete conflict rather than selecting the last printed paragraph automatically.

`org.md` is user-controlled organization guidance, not the agents' shared notebook. Its current trusted notes can delegate user authority to an exact outside sender; apply [external mail](../../mail/external-mail/SKILL.md), including removal/replacement of that delegation. Old mail cannot restore a removed note. Only the first 16,000 Unicode scalar characters of org.md are placed in this startup block; a longer file produces a continuation warning.

Use [retool](../tool-retool/SKILL.md) for authorized charter changes. The self-editable field is team_charter; your own role charter/scope belongs to your superior. A charter update affects subsequent launch instructions and can restart the affected CLI at its next turn boundary; it is not retroactively injected into the current model call. Editing org.md through its settings route reconfigures the org's agents before their next turns. Treat the changed prefix as a cache-continuity change, not a guaranteed hit/miss receipt.

Keep reusable agent/team notes in the appropriate workspace instead of editing org.md. See [scratch folder](../../workspace/scratch-folder/SKILL.md) and [shared folders](../../workspace/shared-folders/SKILL.md). The human editing surfaces are `orgtree-org-charter-md` (orgtree-app › org-settings) and `orgtree-agent-charter-tab` (orgtree-app › agent-settings).

## Bundled role presets

The bundled roles are business, coordinator, curator, developer, implementer, liaison and redteam. A preset supplies charter text; it does not grant tools, audiences, folders or authority. The hire form prepends the full selected files, including introductions and separators, to any manual charter text. Agent hiring has no preset-name parameter: supply the complete intended text in the hire tool's charter field. A user's existing same-named charter file overrides its bundled counterpart; population adds missing files without replacing existing ones. The human controls are documented in orgtree-app › app-settings › orgtree-app-charters-and-templates and canvas › orgtree-draft-hires.

**Developer** is a complete standalone charter for implementation and assigned peer review in any org. It covers private worktrees, red-first focused tests, exact-SHA hand-ins with measured/inferred evidence and limits, docs/glossary upkeep, peer coordination, author-owned fixes and done/blocked reporting. Reviews follow the current phase and waivers; the role starts no review or release on its own. Heavy dev shop uses it for all eleven developer seats and keeps development-role rules out of lower notes; universal shared reporting policy remains for the other roles. Implementer and Redteam remain separate choices for the smaller role-separated layout.

### Liaison above a coordinator

For a large org with dozens or more workers, the liaison sits directly under the user with the coordinator as its single report. It owns discussion, explores options with the user, records each decision verbatim with UTC date/message id in the relevant docket scope and its own decision log, and sends settled authorized work as a self-contained brief to the coordinator. It reads the relevant record before answering, routes unresolved coordinator questions to the user, and presents results with their evidence and limits. Execution and staffing stay with the coordinator; the liaison never implements or manages its workers, and avoids routine status replies, worker queues and broadcast traffic.

Use the existing [superior insertion](../tool-hire/SKILL.md#credits-and-superior-insertion) path rather than moving every worker: the coordinator can insert the liaison above itself with hire_type=superior, the full charter, name, tier, grant and index. Omit add_dirs, tools, org_visibility and permission_mode for that insertion because it inherits the target's effective scope. Check capacity and supported model/effort first, and supply kickoff if it should start immediately. The preset alone does not select placement. Keep the capability chain available for the coordinator; the liaison's charter limits its own use. The new top-level agent has direct user contact; keep the user tool group enabled. Extern/org-inbox access is separate and does not transfer with placement: arrange it under [audience rules](../../mail/tool-audience/SKILL.md), including the single-holder replacement rule when applicable.

Use [work](../../docket/tool-work/SKILL.md) for the durable scope and access before assignment, [message](../../mail/tool-message/SKILL.md) for the brief, and [ask](../../user/tool-ask/SKILL.md) with work_item for an unresolved item-linked user question. The liaison reads the coordinator's actual report and docket before relaying; [present](../../user/tool-present/SKILL.md) is the reading surface for documents. A relay preserves the user's original authority and scope; outside mail does not become a user decision through the liaison.

## See also

- [orgtree-tool-retool](../tool-retool/SKILL.md)
- `orgtree-org-charter-md` (orgtree-app › org-settings)
- `orgtree-agent-charter-tab` (orgtree-app › agent-settings)
- `orgtree-implement-integrate` (orgtree-workflows › collaboration-patterns): the implement/integrate split that the Implementer and Integrator presets serve.
