# Documentation source map and upkeep

[Documentation](../README.md#documentation)

This is a maintenance record, outside the numbered reader path. The nine guides adapt the glossary for people: task instructions, visible controls, consequences and recovery. Agent tool schemas and internal implementation protocols remain in the glossary.

## Baseline and evidence

- **Measured (static):** these guides describe **4.4.2**, checked against integration source `b095f2f0920fcd4bcf560d2f4f3dbbbae9bf2d74` and its glossary. The release delta was derived from `git log v4.4.1..b095f2f` and glossary diffs, including corrected descriptions of existing behavior. The earlier main guide set at `70d0e8b` supplies the unchanged learning order and overview.
- **Measured (static):** the table below maps all 89 app-reference leaves to reader guides. A mapped leaf is a coverage pointer, not a claim that every control was clicked in a live app.
- **Inferred (editorial):** the gradual learning order and task-first grouping give readers an approachable entry point: harnesses, organization, canvas, hire tokens, first message, desk tabs, agent management, projects and larger-team navigation. Later guides expand those concepts and add advanced setup.

## Keep both references current

A change that updates the agent glossary also updates the matching user guide in the **same landing**. The release documentation audit covers both. Use this map to find the human page, adapt the changed behavior to a user task, and update the README ToC if navigation changes. Keep precise tool contracts in the glossary instead of copying a second schema here.

When behavior changes, check common paths, limits, defaults, refusal/recovery text and save timing. Distinguish configured, queued and currently serving state. Check links/anchors and public content before hand-in. Label source checks as static/measured and recommendations as inferred; do not call a source read a live-provider test.

## Existing guides folded in

| Earlier guide | New home |
| --- | --- |
| Getting started | Light first-task guide; advanced providers and model servers moved to [Providers, models and tools](providers-and-tools.md). |
| Collaborating | Expanded in place with roles, audiences, Hubchat, phone identity and hosting. |
| Operating Orgtree | Expanded in place with diagnosis, stops/freezes, sessions, history and advanced deployments. |
| Development | Kept as a supplemental contributor guide, outside the numbered reader path. |

## App-reference coverage

### agent settings

| Glossary source | User guide |
| --- | --- |
| [agent-account-tab](skills/orgtree-app/agent-settings/agent-account-tab/SKILL.md) | [managing-agents — change model effort or account](managing-agents.md#change-model-effort-or-account) |
| [agent-charter-tab](skills/orgtree-app/agent-settings/agent-charter-tab/SKILL.md) | [managing-agents — edit instructions and save carefully](managing-agents.md#edit-instructions-and-save-carefully) |
| [agent-config](skills/orgtree-app/agent-settings/agent-config/SKILL.md) | [managing-agents — edit instructions and save carefully](managing-agents.md#edit-instructions-and-save-carefully) |
| [agent-credit-grant](skills/orgtree-app/agent-settings/agent-credit-grant/SKILL.md) | [managing-agents — understand seats and credits](managing-agents.md#understand-seats-and-credits) |
| [agent-fast-mode](skills/orgtree-app/agent-settings/agent-fast-mode/SKILL.md) | [managing-agents — change model effort or account](managing-agents.md#change-model-effort-or-account) |
| [agent-folders-tab](skills/orgtree-app/agent-settings/agent-folders-tab/SKILL.md) | [managing-agents — folders and permission mode](managing-agents.md#folders-and-permission-mode) |
| [agent-fresh-start](skills/orgtree-app/agent-settings/agent-fresh-start/SKILL.md) | [managing-agents — context history and fresh starts](managing-agents.md#context-history-and-fresh-starts) |
| [agent-history-tab](skills/orgtree-app/agent-settings/agent-history-tab/SKILL.md) | [managing-agents — context history and fresh starts](managing-agents.md#context-history-and-fresh-starts) |
| [agent-model-tab](skills/orgtree-app/agent-settings/agent-model-tab/SKILL.md) | [managing-agents — change model effort or account](managing-agents.md#change-model-effort-or-account) |
| [agent-tools-tab](skills/orgtree-app/agent-settings/agent-tools-tab/SKILL.md) | [managing-agents — visibility and tools](managing-agents.md#visibility-and-tools) |
| [agent-visibility-access](skills/orgtree-app/agent-settings/agent-visibility-access/SKILL.md) | [managing-agents — give the agent the right access](managing-agents.md#give-the-agent-the-right-access) |

### app settings

| Glossary source | User guide |
| --- | --- |
| [app-about](skills/orgtree-app/app-settings/app-about/SKILL.md) | [operating-orgtree — find out what is running](operating-orgtree.md#find-out-what-is-running) |
| [app-charters-and-templates](skills/orgtree-app/app-settings/app-charters-and-templates/SKILL.md) | [settings-and-usage — less common policies](settings-and-usage.md#less-common-policies) |
| [app-concurrency-and-checkups](skills/orgtree-app/app-settings/app-concurrency-and-checkups/SKILL.md) | [settings-and-usage](settings-and-usage.md) |
| [app-credit-bubbling](skills/orgtree-app/app-settings/app-credit-bubbling/SKILL.md) | [settings-and-usage](settings-and-usage.md) |
| [app-default-org-settings](skills/orgtree-app/app-settings/app-default-org-settings/SKILL.md) | [settings-and-usage](settings-and-usage.md) |
| [app-developer](skills/orgtree-app/app-settings/app-developer/SKILL.md) | [operating-orgtree — read history and collect diagnostics](operating-orgtree.md#read-history-and-collect-diagnostics) |
| [app-display-appearance](skills/orgtree-app/app-settings/app-display-appearance/SKILL.md) | [settings-and-usage](settings-and-usage.md) |
| [app-display-desk-and-chart](skills/orgtree-app/app-settings/app-display-desk-and-chart/SKILL.md) | [settings-and-usage](settings-and-usage.md) |
| [app-display-input-and-startup](skills/orgtree-app/app-settings/app-display-input-and-startup/SKILL.md) | [settings-and-usage](settings-and-usage.md) |
| [app-keyboard-shortcuts](skills/orgtree-app/app-settings/app-keyboard-shortcuts/SKILL.md) | [settings-and-usage — keyboard shortcuts](settings-and-usage.md#keyboard-shortcuts) |
| [app-notifications](skills/orgtree-app/app-settings/app-notifications/SKILL.md) | [settings-and-usage — choose notifications](settings-and-usage.md#choose-notifications) |
| [app-quick-staff](skills/orgtree-app/app-settings/app-quick-staff/SKILL.md) | [settings-and-usage](settings-and-usage.md) |
| [app-runtime-desktop](skills/orgtree-app/app-settings/app-runtime-desktop/SKILL.md) | [operating-orgtree — updates and background operation](operating-orgtree.md#updates-and-background-operation) |
| [app-turn-limits](skills/orgtree-app/app-settings/app-turn-limits/SKILL.md) | [settings-and-usage — time limits](settings-and-usage.md#time-limits) |

### app shell

| Glossary source | User guide |
| --- | --- |
| [attention-view](skills/orgtree-app/app-shell/attention-view/SKILL.md) | [workspace](workspace.md) |
| [confirm-dialogs](skills/orgtree-app/app-shell/confirm-dialogs/SKILL.md) | [workspace](workspace.md) |
| [crash-and-restart](skills/orgtree-app/app-shell/crash-and-restart/SKILL.md) | [operating-orgtree — restart only when needed](operating-orgtree.md#restart-only-when-needed) |
| [create-organization](skills/orgtree-app/app-shell/create-organization/SKILL.md) | [getting-started — create your first organization](getting-started.md#create-your-first-organization) |
| [folder-picker](skills/orgtree-app/app-shell/folder-picker/SKILL.md) | [managing-agents — folders and permission mode](managing-agents.md#folders-and-permission-mode) |
| [homepage](skills/orgtree-app/app-shell/homepage/SKILL.md) | [workspace](workspace.md) |
| [kill-switch](skills/orgtree-app/app-shell/kill-switch/SKILL.md) | [operating-orgtree — stop work at the intended scope](operating-orgtree.md#stop-work-at-the-intended-scope) |
| [mobile-layout](skills/orgtree-app/app-shell/mobile-layout/SKILL.md) | [workspace](workspace.md) |
| [onboarding](skills/orgtree-app/app-shell/onboarding/SKILL.md) | [getting-started — install orgtree](getting-started.md#install-orgtree) |
| [org-header-and-menu](skills/orgtree-app/app-shell/org-header-and-menu/SKILL.md) | [workspace](workspace.md) |
| [quick-chat](skills/orgtree-app/app-shell/quick-chat/SKILL.md) | [managing-agents — choose a role and hire](managing-agents.md#choose-a-role-and-hire) |
| [status-bar](skills/orgtree-app/app-shell/status-bar/SKILL.md) | [workspace](workspace.md) |
| [toasts-and-undo](skills/orgtree-app/app-shell/toasts-and-undo/SKILL.md) | [workspace](workspace.md) |
| [tray-and-windows](skills/orgtree-app/app-shell/tray-and-windows/SKILL.md) | [operating-orgtree — updates and background operation](operating-orgtree.md#updates-and-background-operation) |

### canvas

| Glossary source | User guide |
| --- | --- |
| [agent-card](skills/orgtree-app/canvas/agent-card/SKILL.md) | [workspace](workspace.md) |
| [agents-list](skills/orgtree-app/canvas/agents-list/SKILL.md) | [workspace](workspace.md) |
| [context-menus](skills/orgtree-app/canvas/context-menus/SKILL.md) | [workspace](workspace.md) |
| [draft-hires](skills/orgtree-app/canvas/draft-hires/SKILL.md) | [managing-agents — choose a role and hire](managing-agents.md#choose-a-role-and-hire) |
| [org-canvas](skills/orgtree-app/canvas/org-canvas/SKILL.md) | [workspace](workspace.md) |
| [org-inbox-tile](skills/orgtree-app/canvas/org-inbox-tile/SKILL.md) | [collaborating — what an outside conversation does](collaborating.md#what-an-outside-conversation-does) |
| [piles](skills/orgtree-app/canvas/piles/SKILL.md) | [workspace — read the canvas](workspace.md#read-the-canvas) |
| [pinned-windows](skills/orgtree-app/canvas/pinned-windows/SKILL.md) | [workspace — keep useful surfaces open](workspace.md#keep-useful-surfaces-open) |
| [user-node](skills/orgtree-app/canvas/user-node/SKILL.md) | [workspace — use the switchboard and header](workspace.md#use-the-switchboard-and-header) |

### desk

| Glossary source | User guide |
| --- | --- |
| [agent-desk](skills/orgtree-app/desk/agent-desk/SKILL.md) | [messages-and-work](messages-and-work.md) |
| [ask-cards](skills/orgtree-app/desk/ask-cards/SKILL.md) | [messages-and-work — answer questions and permission requests](messages-and-work.md#answer-questions-and-permission-requests) |
| [desk-chat](skills/orgtree-app/desk/desk-chat/SKILL.md) | [messages-and-work](messages-and-work.md) |
| [docket-screens](skills/orgtree-app/desk/docket-screens/SKILL.md) | [messages-and-work — keep work in the docket](messages-and-work.md#keep-work-in-the-docket) |
| [inbox-screens](skills/orgtree-app/desk/inbox-screens/SKILL.md) | [messages-and-work — use mail and the user inbox](messages-and-work.md#use-mail-and-the-user-inbox) |
| [presentations](skills/orgtree-app/desk/presentations/SKILL.md) | [messages-and-work — read documents in presented](messages-and-work.md#read-documents-in-presented) |
| [project-desk](skills/orgtree-app/desk/project-desk/SKILL.md) | [projects-and-watchdogs — create a project and explain its purpose](projects-and-watchdogs.md#create-a-project-and-explain-its-purpose) |
| [watchdog-panel](skills/orgtree-app/desk/watchdog-panel/SKILL.md) | [projects-and-watchdogs — inspect and maintain a watch](projects-and-watchdogs.md#inspect-and-maintain-a-watch) |

### harnesses

| Glossary source | User guide |
| --- | --- |
| [harness-antigravity](skills/orgtree-app/harnesses/harness-antigravity/SKILL.md) | [providers-and-tools](providers-and-tools.md) |
| [harness-claude-code](skills/orgtree-app/harnesses/harness-claude-code/SKILL.md) | [providers-and-tools](providers-and-tools.md) |
| [harness-codex](skills/orgtree-app/harnesses/harness-codex/SKILL.md) | [providers-and-tools](providers-and-tools.md) |
| [harness-comparison](skills/orgtree-app/harnesses/harness-comparison/SKILL.md) | [providers-and-tools](providers-and-tools.md) |
| [harness-muse](skills/orgtree-app/harnesses/harness-muse/SKILL.md) | [providers-and-tools](providers-and-tools.md) |
| [harness-opencode](skills/orgtree-app/harnesses/harness-opencode/SKILL.md) | [providers-and-tools](providers-and-tools.md) |
| [harnesses-tab](skills/orgtree-app/harnesses/harnesses-tab/SKILL.md) | [providers-and-tools](providers-and-tools.md) |
| [route-local-server](skills/orgtree-app/harnesses/route-local-server/SKILL.md) | [providers-and-tools — language model servers](providers-and-tools.md#language-model-servers) |
| [route-openrouter](skills/orgtree-app/harnesses/route-openrouter/SKILL.md) | [providers-and-tools — offer openrouter models](providers-and-tools.md#offer-openrouter-models) |

### mailhub

| Glossary source | User guide |
| --- | --- |
| [hubchat](skills/orgtree-app/mailhub/hubchat/SKILL.md) | [collaborating](collaborating.md) |
| [mailhub-hosting](skills/orgtree-app/mailhub/mailhub-hosting/SKILL.md) | [collaborating — choose a hosting arrangement](collaborating.md#choose-a-hosting-arrangement) |
| [org-connections](skills/orgtree-app/mailhub/org-connections/SKILL.md) | [collaborating](collaborating.md) |
| [phone-link](skills/orgtree-app/mailhub/phone-link/SKILL.md) | [collaborating — link your phone](collaborating.md#link-your-phone) |

### org settings

| Glossary source | User guide |
| --- | --- |
| [org-accounts](skills/orgtree-app/org-settings/org-accounts/SKILL.md) | [settings-and-usage — read current usage](settings-and-usage.md#read-current-usage) |
| [org-advanced](skills/orgtree-app/org-settings/org-advanced/SKILL.md) | [workspace — details and limits](workspace.md#details-and-limits) |
| [org-autonomy](skills/orgtree-app/org-settings/org-autonomy/SKILL.md) | [operating-orgtree — recover a frozen agent](operating-orgtree.md#recover-a-frozen-agent) |
| [org-basic](skills/orgtree-app/org-settings/org-basic/SKILL.md) | [settings-and-usage](settings-and-usage.md) |
| [org-charter-md](skills/orgtree-app/org-settings/org-charter-md/SKILL.md) | [collaborating — keep standing instructions in the right place](collaborating.md#keep-standing-instructions-in-the-right-place) |
| [org-hire-defaults-folders](skills/orgtree-app/org-settings/org-hire-defaults-folders/SKILL.md) | [settings-and-usage](settings-and-usage.md) |
| [org-hire-defaults-scope](skills/orgtree-app/org-settings/org-hire-defaults-scope/SKILL.md) | [settings-and-usage](settings-and-usage.md) |
| [org-hire-defaults-tools](skills/orgtree-app/org-settings/org-hire-defaults-tools/SKILL.md) | [settings-and-usage](settings-and-usage.md) |
| [org-history](skills/orgtree-app/org-settings/org-history/SKILL.md) | [operating-orgtree — read history and collect diagnostics](operating-orgtree.md#read-history-and-collect-diagnostics) |
| [org-policies-compaction](skills/orgtree-app/org-settings/org-policies-compaction/SKILL.md) | [settings-and-usage](settings-and-usage.md) |
| [org-policies-inbox](skills/orgtree-app/org-settings/org-policies-inbox/SKILL.md) | [settings-and-usage](settings-and-usage.md) |
| [org-templates](skills/orgtree-app/org-settings/org-templates/SKILL.md) | [workspace — reuse a layout](workspace.md#reuse-a-layout) |

### providers

| Glossary source | User guide |
| --- | --- |
| [accounts-registry](skills/orgtree-app/providers/accounts-registry/SKILL.md) | [providers-and-tools](providers-and-tools.md) |
| [api-key-fallback](skills/orgtree-app/providers/api-key-fallback/SKILL.md) | [providers-and-tools — automatic fallback and metered keys](providers-and-tools.md#automatic-fallback-and-metered-keys) |
| [language-servers](skills/orgtree-app/providers/language-servers/SKILL.md) | [providers-and-tools — language model servers](providers-and-tools.md#language-model-servers) |
| [mcp-servers](skills/orgtree-app/providers/mcp-servers/SKILL.md) | [providers-and-tools — add mcp tools](providers-and-tools.md#add-mcp-tools) |
| [openrouter](skills/orgtree-app/providers/openrouter/SKILL.md) | [providers-and-tools](providers-and-tools.md) |
| [providers-tab](skills/orgtree-app/providers/providers-tab/SKILL.md) | [providers-and-tools](providers-and-tools.md) |
| [skills-and-instructions](skills/orgtree-app/providers/skills-and-instructions/SKILL.md) | [providers-and-tools — share skills and instructions](providers-and-tools.md#share-skills-and-instructions) |
| [usage-screens](skills/orgtree-app/providers/usage-screens/SKILL.md) | [settings-and-usage — read current usage](settings-and-usage.md#read-current-usage) |

## Working and workflow sources

| Source family | Adaptation and limits |
| --- | --- |
| [Team shape](skills/orgtree-working/team/team-shape/SKILL.md), [hiring](skills/orgtree-working/team/hiring/SKILL.md), [credits](skills/orgtree-working/team/credits/SKILL.md), [scope](skills/orgtree-working/team/scope-and-permissions/SKILL.md), [charters](skills/orgtree-working/team/charters/SKILL.md) | [Managing agents](managing-agents.md): human staffing, capacity, permissions, instruction homes and lifecycle. Exact operation authority/arguments remain in the associated tool leaves. |
| [Delegation](skills/orgtree-working/team/delegating/SKILL.md), [peer mail](skills/orgtree-working/team/peer-mail/SKILL.md), [audiences](skills/orgtree-working/mail/chain-and-audiences/SKILL.md), [audience tool](skills/orgtree-working/mail/tool-audience/SKILL.md) | [Collaboration](collaborating.md): responsibility, contact direction, actual-parent peer boundaries and direct-member project inheritance. |
| [Mail](skills/orgtree-working/mail/mail-basics/SKILL.md), [org inbox](skills/orgtree-working/mail/org-inbox/SKILL.md), [outside authority](skills/orgtree-working/mail/external-mail/SKILL.md), [transfers](skills/orgtree-working/mail/tool-transfers/SKILL.md) | [Messages](messages-and-work.md) and [Collaboration](collaborating.md): waking/passive delivery, read/ACK distinctions, outside routing and exact-identity trust. |
| [Docket items](skills/orgtree-working/docket/docket-items/SKILL.md), [statuses](skills/orgtree-working/docket/docket-statuses/SKILL.md), [review/attention](skills/orgtree-working/docket/docket-review-and-attention/SKILL.md), [staffing](skills/orgtree-working/docket/tool-staff/SKILL.md) | [Messages and work](messages-and-work.md#keep-work-in-the-docket): durable scope, ownership, evidence, questions, attention and human Quick staff. |
| [Reaching the user](skills/orgtree-working/user/reaching-the-user/SKILL.md), [questions](skills/orgtree-working/user/tool-ask/SKILL.md), [presenting](skills/orgtree-working/user/tool-present/SKILL.md), [file delivery](skills/orgtree-working/user/tool-send-file/SKILL.md) | [Messages and work](messages-and-work.md): question decisions, source replies and document-versus-file purpose. Agent delivery limits/schemas stay in the glossary. |
| [Visibility](skills/orgtree-working/inspection/visibility/SKILL.md), [reading reports](skills/orgtree-working/inspection/reading-reports/SKILL.md) | [Workspace](workspace.md) and [Managing agents](managing-agents.md): visible evidence is separate from write/contact authority. Agent read-tool procedures remain agent-facing. |
| [Turns/wakes](skills/orgtree-working/runtime/turns-and-wakes/SKILL.md), [DND](skills/orgtree-working/runtime/do-not-disturb/SKILL.md), [checkups](skills/orgtree-working/runtime/checkups-and-reminders/SKILL.md), [context](skills/orgtree-working/runtime/context-and-compaction/SKILL.md), [halts/restarts](skills/orgtree-working/runtime/halts-and-restarts/SKILL.md), [session placement](skills/orgtree-working/runtime/tool-session/SKILL.md) | [Messages](messages-and-work.md), [Settings](settings-and-usage.md) and [Operation](operating-orgtree.md): delivery, runtime gates, context recovery and desktop-session consequences. |
| [Account lanes](skills/orgtree-working/accounts/account-lanes/SKILL.md), [usage windows](skills/orgtree-working/accounts/usage-windows/SKILL.md), [freezes](skills/orgtree-working/accounts/usage-freezes/SKILL.md), [cache continuity](skills/orgtree-working/accounts/cache-continuity/SKILL.md) | [Providers](providers-and-tools.md), [Settings](settings-and-usage.md) and [Operation](operating-orgtree.md): capacity freshness, billing, fallback and honest cache/session claims. |
| [Shared folders](skills/orgtree-working/workspace/shared-folders/SKILL.md), [scratch](skills/orgtree-working/workspace/scratch-folder/SKILL.md), [breadcrumbs](skills/orgtree-working/workspace/breadcrumbs/SKILL.md), [feedback](skills/orgtree-working/workspace/feedback/SKILL.md) | [Collaboration](collaborating.md), [Settings](settings-and-usage.md) and [Operation](operating-orgtree.md): persistent notes, inheritance, deliveries and approved issue reporting. |
| [Projects](skills/orgtree-working/team/projects/SKILL.md), [project tool](skills/orgtree-working/team/tool-project/SKILL.md), [watchdogs](skills/orgtree-working/watchdogs/tool-watchdog/SKILL.md), [waiting](skills/orgtree-working/watchdogs/waiting-for-events/SKILL.md) | [Projects and automation](projects-and-watchdogs.md): human UI, cooperative capacity, jobs, events and agent-created monitoring. Human-owned registrations cannot be managed by agent tools. |
| [Committee](skills/orgtree-workflows/collaboration-patterns/committee-mode/SKILL.md), [development team](skills/orgtree-workflows/collaboration-patterns/dev-team/SKILL.md), [iterative development](skills/orgtree-workflows/collaboration-patterns/iterative-development/SKILL.md) | [Collaboration](collaborating.md#give-a-team-clear-responsibilities): optional patterns and independent decisions, without importing this repository's private machine/release policy. |
| [Concurrency primitives](skills/orgtree-workflows/collaboration-patterns/concurrency-primitives/SKILL.md), [work queues](skills/orgtree-workflows/collaboration-patterns/work-queues/SKILL.md), [build slots](skills/orgtree-workflows/collaboration-patterns/build-slots/SKILL.md) | [Projects and automation](projects-and-watchdogs.md): slots, FIFO/ACK jobs, signals, readiness and resource agreements. Exact agent recipes and organization-specific resource limits remain separate. |
| [Standalone engine](skills/orgtree-working/runtime/standalone-engine/SKILL.md) | [Operating and troubleshooting](operating-orgtree.md#advanced-deployments): authenticated headless operation, user-MCP scope, outside-inbox policy writes and deferred capabilities. This is a user-token API, separate from agent tools. |

## 4.4.2 change coverage

The following is a **measured static** reconciliation of the release log and changed glossary leaves. It identifies where readers find the behavior; it does not claim a new native/device test. Source groups include fixes and reference corrections as well as newly exposed controls.

| Source change group | Human coverage |
| --- | --- |
| Agent DND and next-turn arming; descendant control | [Managing agents](managing-agents.md#hold-mail-for-focused-work), [Messages](messages-and-work.md#continue-a-conversation): current versus armed hold, normal opening batch, clearing/release boundaries, urgent bypass and independent stop gates. Sources: agent-desk, agent-card, do-not-disturb and tool-status. |
| Organization outside-inbox Normal/DND/Closed modes | [Collaboration](collaborating.md#choose-an-outside-inbox-mode), [Settings](settings-and-usage.md#less-common-policies), [Operation](operating-orgtree.md#advanced-deployments), [team setup](team-setup.md): shared Save, all Hubchat senders held, authorized extraction, return to Normal and user-only mode writes. Sources: org-policies-inbox, org-connections, org-inbox, tool-inbox and standalone-engine. |
| Shift+F4 retained mention navigation | [Shortcuts](settings-and-usage.md#keyboard-shortcuts), [Workspace](workspace.md#use-the-switchboard-and-header), [Messages](messages-and-work.md#references-replies-and-formatting): sources, backward/no-wrap behavior, changed ticket excerpt, seen entries, 4.4.2 baseline and 2,000-per-org retention. Sources: app-keyboard-shortcuts and mention-navigation design. |
| Ticket/presentation Mention and Reply, including idle reminder cards | [Messages](messages-and-work.md#references-replies-and-formatting): nearest composer, all live message boxes, canvas Quick chat ownership, recipient preservation, no send/hire until submission. Idle reminder cards are described in transcript reading. Sources: desk-chat, docket-screens, inbox-screens, presentations, quick-chat and events/idledocket.tsx. |
| Template watchdogs and explicit audiences | [Workspace](workspace.md#reuse-a-layout), [Projects](projects-and-watchdogs.md#ask-agents-to-wait-with-watchdogs): default-on include choices, off-by-default machine watchers, preview/remapping/warnings, no credentials/history/leases, staged import and possible wakes. Sources: org-templates, tool-watchdog, tool-audience and template-links. |
| Deep template transport and portable settings | [Workspace](workspace.md#reuse-a-layout): no node/depth ceiling, 16 MiB file bound, paged preview, speed/pins/project policy, standing-note bounds and older-reader limits. Sources: create-organization, org-templates and template-portability. |
| Native replacement-tool opt-in and bounded native questions/plan approval | [Managing agents](managing-agents.md#opt-into-native-replacement-tools), [Messages](messages-and-work.md#answer-questions-and-permission-requests), [Providers](providers-and-tools.md#add-mcp-tools): per-agent off-by-default grant, harness-specific coverage, parent ceiling, no defaults or extra audience, request-specific decisions and expiry. Sources: agent-tools-tab, ask-cards, scope-and-permissions and harness leaves. |
| Complete deep reporting/scope/funding/lifecycle paths | [Managing agents](managing-agents.md#read-reporting-and-placement), [Workspace](workspace.md#read-the-canvas), [Collaboration](collaborating.md#hierarchical-shared-memory), [Projects](projects-and-watchdogs.md#choose-mailbox-delivery-or-broadcast): complete nesting, physical peer distinction, cycle/refusal semantics and paged broadcasts. Sources: team-shape, projects, peer-mail, inspection, turn-envelope and ancestor-chain. |
| Slot cleanup on retirement/dissolve/delete | [Projects](projects-and-watchdogs.md#share-limited-capacity-with-slots): all leases/projects and waiting claims, whole quantities, first-come grants after commit, user hold protection and no process-stop inference. Sources: tool-project, build-slots and concurrency-primitives. |
| Retired Grey preset and legacy preference migration | [Settings](settings-and-usage.md#make-the-workspace-comfortable): current presets, explicit old choice becomes Custom #b6bdc8, unset automatic preference keeps detection. Source: app-display-appearance. |
| First-use feed-order fix, left/right notes and centered Welcome | [Getting started](getting-started.md#install-orgtree), [first org](getting-started.md#create-your-first-organization): visible controls, space-aware callouts and scrollable centered setup. These fixes add no new action. Source: onboarding and first-use renderer. |
| Template picker stability while typing | [Workspace](workspace.md#reuse-a-layout): last confirmed rows/selection remain while availability refreshes; Reload re-reads files. Source: create-organization. |
| Explicit Providers refresh and default Codex sign-in | [Getting started](getting-started.md#connect-one-provider), [Providers](providers-and-tools.md#connect-another-provider): ordinary immediate checking, coalescing, scoped post-login verification, browser action and usage distinction. Sources: providers-tab, accounts-registry and tool-list-tiers. |
| Identity/tool-discovery and proactive watchdog guidance | [Providers](providers-and-tools.md#add-mcp-tools), [Projects](projects-and-watchdogs.md#ask-agents-to-wait-with-watchdogs): discoverable deferred cards retain permissions, native opt-in is separate, and known waits use persistent observations. Tool-name mechanics and eager/deferred inventories remain agent-facing. Sources: harness-claude-code and tool-watchdog. |
| Released-reference audit: images, tool-output estimates, shell tails and usage gaps | [Messages](messages-and-work.md#read-the-transcript), [image limits](messages-and-work.md#image-embedding-limits), [Usage history](settings-and-usage.md#use-usage-history): bounds, estimates versus receipts, missing preview versus silence, stepped sparse observations. These describe measured existing behavior rather than inventing new controls. Sources: desk-chat, presentations, inbox-screens, usage-screens and harness-comparison. |
| Released-reference audit: quota fallback and diagnostic/EPIC behavior | [Operation](operating-orgtree.md#recover-a-frozen-agent), [diagnostics](operating-orgtree.md#read-history-and-collect-diagnostics): fallback retry versus reported reset, typed Muse evidence, audiovisual activity versus useful work, tray mute persistence. Sources: usage-freezes, app-developer and tray-and-windows. |
| Other tool contract/reference corrections | Existing [guide families](#working-and-workflow-sources) cover human consequences. Timing content blocks, optional tool keys, native adapter schemas, fixed agent-status history slices and renderer test-output retention remain in glossary/developer references. Test/control-only, packaging/version bookkeeping and integration commits add no separate reader action. |

## Source discrepancies handled in the user text

These are **measured static source findings**, not new native-harness tests:

| Finding | Reader wording and source |
| --- | --- |
| The model-server glossary calls 65,536 tokens a hard gate, but the release computes a `too_small` warning; tier/route construction does not enforce that threshold. | [Providers](providers-and-tools.md#language-model-servers) describes the warning and need to match real context. Source: `engine/rs/orgtree-engine/src/langserver.rs`. |
| The former model-settings passage described only default-account choices; its 4.4.2 glossary correction now matches the managed-account picker. | [Managing agents](managing-agents.md#change-model-effort-or-account) retains the accurate native/managed choice and disclosure. Source: `apps/desktop/renderer/src/canvas/deskmodel.tsx`. |
| A turn-limit hint says next turn; the actor consults current settings for an active deadline. | [Settings](settings-and-usage.md#time-limits) does not promise an active turn keeps its old limit. Source: `runtime/actor.rs`, `settings.rs` under the Rust engine. |
| Empty effort is labeled CLI default/no flag; effective resolution falls back to high before harness mapping. | [Settings](settings-and-usage.md#set-organization-defaults-deliberately) states actual resolution. Source: `engine/rs/orgtree-engine/src/providers/catalog.rs`. |
| The standalone packaging index still calls user MCP deferred, while the release routes and detailed guide implement it. | [Operation](operating-orgtree.md#advanced-deployments) includes user MCP and leaves headless sign-in/desktop attachment deferred. Source: `http/mod.rs`, `http/usermcp.rs`, `tools/usermcp.rs` and `docs/rust-engine/STANDALONE-ENGINE.md`. |

## Deliberate exclusions and verification limits

Agent-only schemas, permission matrices, prompt/envelope internals, mail-recall mechanics, telemetry parsing and tool implementation details remain in the glossary/source. Local build permits, machine output roots, Session 0 test recipes and this repository's release routing are contributor practices, not product setup steps. The supplemental developer guide links the current contributor rules instead of imposing them on every user organization.

The guides explain visible consequences of permissions, restart/session changes, skipped data and failures. They do not promise identical sandbox enforcement, provider pricing, model behavior, native GUI capability or cache TTL across harnesses. External provider/Hubchat links are references, not a live availability audit. No live organization, credentials, provider inference or device setup was changed or tested for this documentation pass.
