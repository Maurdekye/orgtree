# Documentation source map and upkeep

[Documentation](../README.md#documentation)

This is a maintenance record, outside the numbered reader path. The nine guides adapt the glossary for people: task instructions, visible controls, consequences and recovery. Agent tool schemas and internal implementation protocols remain in the glossary.

## Baseline and evidence

- **Measured (static):** behavior sources are published **v4.4.1**, commit `ab27dbad85fe421b8f6444517f9746e0b216c60f`. This documentation starts from main `2adec97e818ca913a9e703fabb456b6e9f8a020b`; its app/engine sources match that release. The glossary snapshot is the one in this checkout.
- **Measured (static):** the table below maps all 89 app-reference leaves to reader guides. A mapped leaf is a coverage pointer, not a claim that every control was clicked in a live app.
- **Inferred (editorial):** the gradual learning order and task-first grouping make the tutorial a usable entry point. They follow the approved tour's concepts: harnesses, organization, canvas, hire tokens, first message, desk tabs, agent management, projects and larger-team navigation. Later guides expand those concepts and add advanced setup.
- The **Orgtree School 1: Introduction** video link is deliberately a placeholder in [After the tour](getting-started.md#after-the-tour). No unpublished URL or chapter timestamp is asserted. Add the published URL and final chapter links there when available.

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

## Source discrepancies handled in the user text

These are **measured static source findings**, not new native-harness tests:

| Finding | Reader wording and source |
| --- | --- |
| The model-server glossary calls 65,536 tokens a hard gate, but the release computes a `too_small` warning; tier/route construction does not enforce that threshold. | [Providers](providers-and-tools.md#language-model-servers) describes the warning and need to match real context. Source: `engine/rs/orgtree-engine/src/langserver.rs`. |
| One model-settings passage describes only default-account choices; the desk picker accepts an eligible managed account when native is unavailable. | [Managing agents](managing-agents.md#change-model-effort-or-account) describes the native/managed choice and disclosure. Source: `apps/desktop/renderer/src/canvas/deskmodel.tsx`. |
| A turn-limit hint says next turn; the actor consults current settings for an active deadline. | [Settings](settings-and-usage.md#time-limits) does not promise an active turn keeps its old limit. Source: `runtime/actor.rs`, `settings.rs` under the Rust engine. |
| Empty effort is labeled CLI default/no flag; effective resolution falls back to high before harness mapping. | [Settings](settings-and-usage.md#set-organization-defaults-deliberately) states actual resolution. Source: `engine/rs/orgtree-engine/src/providers/catalog.rs`. |
| The phone panel persists keep-awake, but no sleep-inhibition consumer was established by the source audit. | [Collaboration](collaborating.md#link-your-phone) treats its actual power effect as unverified. Source: phone-link glossary and `apps/desktop/renderer/src/canvas/phonelink.tsx`. |
| The standalone packaging index still calls user MCP deferred, while the release routes and detailed guide implement it. | [Operation](operating-orgtree.md#advanced-deployments) includes user MCP and leaves headless sign-in/desktop attachment deferred. Source: `http/mod.rs`, `http/usermcp.rs`, `tools/usermcp.rs` and `docs/rust-engine/STANDALONE-ENGINE.md`. |

## Deliberate exclusions and verification limits

Agent-only schemas, permission matrices, prompt/envelope internals, mail-recall mechanics, telemetry parsing and tool implementation details remain in the glossary/source. Local build permits, machine output roots, Session 0 test recipes and this repository's release routing are contributor practices, not product setup steps. The supplemental developer guide links the current contributor rules instead of imposing them on every user organization.

The guides explain visible consequences of permissions, restart/session changes, skipped data and failures. They do not promise identical sandbox enforcement, provider pricing, model behavior, native GUI capability or cache TTL across harnesses. External provider/Hubchat links are references, not a live availability audit. No live organization, credentials, provider inference or device setup was changed or tested for this documentation pass. The tutorial URL remains pending publication.
