# Managing agents

[Documentation](../README.md#documentation) · [Previous: Workspace](workspace.md) · [Next: Messages and work](messages-and-work.md)

Start with an agent that can do the task. Add a coordinator and specialists when several pieces can proceed independently or one agent needs help organizing them. A larger tree brings more capacity, but also more communication and supervision.

## Read reporting and placement

An agent's **superior** is the nearest agent above it, skipping projects. Its **reports** or **subordinates** are the agents that report directly to it through any intervening projects. With no agent above it, an agent is top-level and reports to you, even when physically inside a project.

**Descendants** are all agents/projects below a node at every depth. A **subtree** includes that node too. **Parent/child** and **sibling/peer** describe immediate physical placement: peers share an actual parent. Two agents can share a superior across different projects without being peers. This distinction matters for contact permissions and bulk actions.

## Choose a role and hire

In **App settings > Display > Desk**, **New hires go** chooses **End** (default),
**Start** or **Centre** for new agents and projects across your organizations.
Centre goes just after the middle of the existing live direct reports: with
three, A B **[new]** C; with four, A B **[new]** C D. Projects count as reports;
retired nodes and grandchildren do not. This applies to ordinary tokens/menus,
the compact hire sheet, Quick chat and immediate Staff. Existing nodes,
side/above tokens, moves and template order retain their placement. Circular
view uses the same sibling position within the team's arc.

Hover the intended superior's card and choose a hire token. The dashed draft lets you set a name, model, grant, charter and permissions before **Hire**. A charter describes the standing role; a message gives the immediate task. Applying the draft's permission gear stages its choices and does not hire by itself.

For a research task, a useful charter might ask for sourced findings and explicit uncertainty. For a developer, name the repository, scope of changes and expected verification. Avoid copying the same long policy into every charter: put a team-wide rule in team instructions and an organization-wide rule in org instructions.

The provider-grouped tokens reflect current availability. A disabled token can explain a missing sign-in, exhausted account, entitlement or capacity restriction. The engine validates again when Hire is submitted. If it refuses, the draft remains available to correct.

**Quick chat** is the short form: select a model, effort and superior, attach material if needed, and send one message to hire a new agent with that task. It has no separate charter field. Use the existing desk to continue an existing task. A later attachment failure can occur after the hire, so inspect the new card before retrying.

## Understand seats and credits

Credits reserve concurrent staffing capacity. They are separate from provider tokens, subscriptions and money.

| Term | Meaning |
| --- | --- |
| Seat | Capacity reserved for the agent's model tier. |
| Grant | Capacity assigned to that agent for its own team. |
| Free | The part of its grant not already committed to live reports and their teams. |

A live agent can hold capacity while idle, halted or waiting for a provider reset. Retiring finished expertise returns capacity; merely stopping its turn does not. Reuse an existing agent when its context fits the work, and rehire archived expertise rather than creating a duplicate solely to recover an old conversation.

The **Credit grant** bar in Scope saves when its gesture commits, independently of the form's Save. Escape cancels an unfinished gesture. The minimum protects capacity already held by reports. The visible scale can grow during dragging; it is not permission to exceed the engine's live limit. Arrow keys adjust it, with Home/End selecting the available bounds.

Projects cost no seat and hold no independent grant. The credit display passes through nested projects to the agents below them. [Settings and usage](settings-and-usage.md) explains the app's credit-bubbling preferences for your own staffing changes.

## Give the agent the right access

Open **Agent settings > Scope**. Choose the folders and tool capabilities needed for the task, then review any warning about expanding access above the agent.

### Folders and permission mode

Add a typed path with **add**, or use the folder picker. New entries start writable; switch to **RO** before Save when read-only access is intended. Removing an entry revokes access; it does not delete the files. The edited desktop list replaces that agent's configured folder list, so inspect the whole list before saving.

The in-app picker browses the **engine computer**, even from a remote UI. Enter a folder and choose **Select current folder**. It selects an existing directory rather than a file or a newly created folder. Choosing only fills the calling field; Save applies the grant. After a failed navigation, verify the displayed path before selecting the previous folder still shown.

Folder and tool grants are bounded by the organization and the agent's superiors. The human settings form can expand intermediate grants to carry a new grant down the tree, and previews that expansion. Restricting a parent restricts descendants' effective access even if a wider configured value is retained below it.

| File and command access | Intended use |
| --- | --- |
| Read only | Investigation without changes. |
| Ask before changes | Approval before changes under the harness's policy. |
| Allow normal changes | Ordinary editing within the granted scope. |
| Unrestricted access | Removes approval prompts where supported. Choose deliberately. |

The harness and Windows session determine actual sandbox and approval enforcement. A writable folder alone does not enable a disabled edit tool, and a permission label does not establish identical protection across every harness. Compare routes in [Providers, models and tools](providers-and-tools.md).

For **Muse with normal write access in Windows Session 0**, Orgtree disables Muse's OS sandbox. Native shell/file operations can exceed granted folders without an approval callback. A normal-write Muse CLI hosted in the signed-in session keeps the sandbox; read-only and Unrestricted have separate policies. Check actual CLI placement and the [Muse permission reference](skills/orgtree-app/harnesses/harness-muse/SKILL.md#tools-permissions-and-sandbox) when folder confinement matters.

### Visibility and tools

**Visible agents** chooses Only this agent, Its team, Its team and all reports, or Everyone. Visibility controls what can be read. It does not grant management authority or permission to message everybody.

**Tools** separates:

- Native tools: commands, web browsing, file editing and temporary harness helper agents.
- Orgtree groups: docket, team management, messaging, organization reading, watchdogs, runtime/accounts, user delivery/questions and organization logo.
- Registered MCP servers, selected individually within the superior's grant.

Temporary helper agents are different from persistent Orgtree hires. A discovered MCP server still needs installation/authentication and an explicit grant; refreshing its list alone does not reconnect every running agent. See [Providers and tools](providers-and-tools.md).

### Opt into native replacement tools

**Native Tools > Disabled by Orgtree** is an opt-in to tools Orgtree normally replaces with its own coordination. It defaults **off** for ordinary new hires and is absent from org hire defaults. Turning it on waits for Save and the next launch boundary, within ancestor permission ceilings; granting it to a manager does not turn it on for future hires.

The hint describes the chosen harness's coverage. Claude can restore native questions, plan-mode and scheduling/monitor tools. Codex and Muse can restore supported native user-input questions. Antigravity and OpenCode currently restore nothing through this switch; their existing scope/security policies remain. Muse reminder observers, proactive workflows and contributor mode remain off. Other folder/tool grants still apply.

Native questions follow the ordinary question destination: direct user access produces a private card; otherwise the superior receives question mail and the native call returns without approval. A Claude plan must receive explicit approval, and an Orgtree Read only/plan scope still needs a superior's scope change before it can leave that mode. The opt-in adds neither an audience nor persistent approval. See [question cards](messages-and-work.md#answer-questions-and-permission-requests).

## Edit instructions and save carefully

The **Charter** tab has personal **Instructions** and **Team instructions**. Team instructions reach the agent itself and agents below it. The separate **Subordinates may message each other** switch controls direct sibling mail under that parent and is on by default. It does not inherit down the tree; [Collaboration](collaborating.md) explains audiences and project peer mail.

Switching settings tabs preserves local edits. **Save** applies the buffered configuration; **Cancel** discards remaining draft edits. Rename, grant-slider gestures, agent actions and queue-cancellation controls have their own submission paths and are not undone by Cancel.

Scope/instruction changes can replace an idle process; a running turn normally finishes before reconfiguration. Startup text and capability changes can affect cached input reuse. A full settings Save is broader than an effort-only or speed-only desk action. If a multi-step save fails, check the current values before repeating it: an earlier step may have succeeded.

**Rename** is its own action. Use a unique short name made from letters, digits, hyphens, underscores or periods. The runtime's stored scratch path remains authoritative; do not assume renaming moved its folder on disk. Open the scratch folder through the menu.

## Change model, effort or account

Click the desk's model mark for the model picker, or use **Settings > Model** for model, version, effort and account together. Choosing a model from the desk picker uses its latest version and an eligible account: the native login when usable, otherwise the compatible managed account named by the picker. Choose a specific account or version in settings when needed.

Busy model/account changes queue for the turn boundary. The next-turn badges show the request, not a change already applied to the current call. To cancel a queued model or account change, explicitly choose the currently serving value again. An untouched Save preserves the queue.

Cross-provider switches start a fresh session with a handoff summary. Scratch files, mail and saved history remain with the agent, but they are not a promise of identical conversation context or a cache hit. Switching a model-server route between different harnesses also needs a fresh session. A more expensive seat must fit the available credit allocation.

**Thinking effort** chooses among the model's offered levels. Inheritance uses the organization's effective level; unsupported saved levels are mapped to a supported launch level. Higher effort can affect time and usage. Some supported running Claude turns can receive an effort update; other changes apply next turn. A sent control request does not prove the provider applied it.

**Fast mode** is separate from effort. Where supported, the lightning button saves a next-turn speed preference immediately. It can use more provider allowance. The serving fast badge and a queued next-turn fast badge describe different times. Unsupported routes hide or refuse the option. Hire defaults affect new hires and Quick chat, not existing agents or rehires.

**Account** chooses an allowed login. An unavailable saved login is shown rather than silently replaced. The **Switch accounts when limited** override can follow the org default, enable fallback or disable it. Fallback is off by default and has provider-specific eligibility and billing rules; read [Providers and tools](providers-and-tools.md) before enabling it. A manual account selection does not itself unlock a genuine usage-limit freeze.

## Hold mail for focused work

The desk header's **DND** hover tooltip briefly explains that it holds non-urgent mail while urgent mail still arrives, and how to turn the hold on or off.

Use **DND** in the desk header to hold non-urgent mail during the current turn. If the agent is idle, it arms **DND next turn**: opening mail starts that turn normally, then the hold applies. The card/desk badge distinguishes armed from active DND. Arming is not yet an urgent-mail bypass target.

Turning DND off clears active or armed state and releases held mail at the harness's next supported delivery boundary, without interrupting/restarting the turn. Large input remains ordered across bounded follow-up deliveries. The target agent can clear its own hold, and authorized agent superiors can control descendants at any depth. A hold set by you is not irrevocable. Active DND also clears when the turn actually ends; it is separate from Halt, freeze and the organization's outside-inbox mode.

Only urgent mail bypasses an active hold. User and superior ordinary mail wait too. An agent can explicitly read selected held mail itself. See [Messages and work](messages-and-work.md#continue-a-conversation) for the composer urgency control and [Collaboration](collaborating.md#choose-an-outside-inbox-mode) for organization-wide outside DND.

## Stop, pause or finish work

The desk header's **retire** and **dissolve** hover tooltips explain their scope, released credits and retained history/files. An agent with a live team offers dissolve; a leaf offers retire. A project's dissolve includes the project and every agent under it; restoring the project alone does not rehire all former members. These buttons still open a confirmation.

| Action | Result |
| --- | --- |
| Stop / interrupt | Ends the current turn. Later mail or another wake can run the agent again. Already completed file or external actions remain. |
| Halt | Keeps the agent stopped until Unhalt. Waiting mail stays queued; its seat remains reserved. |
| Retire / dissolve subtree | Archives a seat or team and releases its live capacity. Review the whole counted subtree before confirming. |
| Rehire | Admits archived expertise again with retained context where available. It is not a guarantee that every former report is restored. |
| Delete permanently | Removes the counted records after destructive confirmation. It cannot be undone and does not promise to erase all session files left on disk. |

Team and root menus offer bulk actions. They show the counted targets and report skipped or failed entries. Existing labels such as **all subordinates** cover descendants at every depth while leaving the selected root live; **subtree** includes that root. A project has no running turn itself: control its agent members, or use the relevant team action. For an emergency, see [Operating and troubleshooting](operating-orgtree.md).

Retirement does not complete unfinished docket items. Hand off their owners and next steps first. Archived cards remain visible unless the display option hides them; finding one in the retired list is different from rehiring it.

## Reorganize a team

Drag a card to move it and its subtree, or use the available Team controls for reordering and other structural changes. Moving existing work transfers its capacity; it does not fund a duplicate. A new ancestor chain can change effective scope, inherited instructions and shared folders.

The superior-insertion hire creates a new manager above a target. Its scope is inherited for that insertion; it is not the same as freely configuring an ordinary child hire. Inspect the proposed seat/grant and target before confirming. Projects can group teams without adding a model seat; [Projects and automation](projects-and-watchdogs.md) covers their purpose.

Reporting, effective scope, funding and lifecycle operations follow the complete nested chain. Outer restrictions remain effective in deep layouts. Malformed cycles or inconsistent concurrent state are refused instead of silently applying a partial chain. A retryable contention refusal rolls back that operation; inspect its reason and current state before retrying, rather than assuming a fixed completion time.

## Context, history and fresh starts

Use **Compact** when the current harness supports native compaction. **Cheap compact** continues in a fresh session using a handoff rather than paying for a separate model summarization call. It can lose detail and does not guarantee lower total future cost. Busy agents and unsupported or unmeasured cases can be skipped; the dialog explains why.

**Start fresh when needed** can follow the organization policy or use an agent override. It uses measured context and cache forecasts; turning it on is not an immediate reset. Turning it off does not disable every size-based split or overflow-recovery path. Native compaction and fresh-session recovery are different mechanisms. [Operating and troubleshooting](operating-orgtree.md) covers recovery when a conversation is too large.

The agent **History** tab shows retained events, not a duplicate full transcript. **Chat** is the conversation. Open the scratch/team folder for notes and saved handoffs; the desk has no Files tab. Retained text, a resumable provider session and reusable provider cache are three separate things.
