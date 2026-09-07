# Orgtree v2.0 original design brief (historical, verbatim)

STATUS: HISTORICAL AND SUPERSEDED. This is the user's first design brief, discussion draft of 5 September 2026, as pasted by the user on 2026-09-07 at 20:13:47 UTC. It is preserved here word for word so the original intent is never lost. It remains the reference for v2 requirements except where the user's later explicit decisions override, defer or remove a point; several of its decisions (multi-account management, the dedicated mobile app, selective parity, "no repository or implementation yet", open framework and engine choice) were changed by the user later on 7 September 2026. The record of those later decisions is `docs/v2-user-decisions.md`; where the two differ, that file wins, and everything here it does not explicitly change still stands. The desktop/engine transport is specified in `docs/engine-contract.md`.

The text below is the exact user brief: 16,087 characters excluding line breaks, unchanged. Nothing after this line has been edited.

---

Orgtree v2.0 — first design brief
Discussion draft, 5 September 2026. Backlog: orgtree-v2-standalone-provider-agnostic-desktop.

The proposal is a desktop product that owns installation and operation of an agent organization. Its value must come from making that organization easier to run, understand, and recover—not simply putting the current webpage inside a window.

Design stays between the user and coordinator-astra. No new repository, implementation, or framework commitment has begun. This brief proposes decisions for that joint design process.

What is already decided
A new repository named orgtree, dropping the Claude prefix.
A standalone Chromium-based application, distributed as an installable Windows executable.
Provider- and harness-neutral architecture, terminology, workflows, and account handling.
Replaceable visual themes, including themes suited to providers the user chooses.
Account registration through alternative configuration directories, symmetric accounts with usage visible together, agent-chosen account placement for new hires, and lighter/darker account tints (user decision, 6 September).
Popout of individual agent or modal tabs into separate windows, alongside pinning, for multiple screens and native OS tiling (user decision, 6 September).
A dedicated mobile app for authenticated, end-to-end remote access to a desktop deployment, direct streaming, NAT punchthrough and QR pairing (user decision, 6 September).
A substantial design process before implementation.
Feature selection rather than automatic v1 parity: kiosk mode and other web-sharing features are candidates for omission.
The application’s name and architecture can be provider-neutral while still showing provider differences honestly. Unsupported features must remain visible as unsupported; neutrality must not manufacture equivalence.

What desktop ownership would give us
Area	Opportunity in v2	What it does not solve by itself
Installation	An installer provisions the application and its own runtime, creates shortcuts, and supports repair and uninstall.	Provider accounts and harness dependencies still need an explicit setup and licensing plan.
Windows	Detach desks, place organizations on different monitors, and restore a useful window arrangement.	Multiple windows must still share one authoritative agent session and avoid competing drafts.
Background work	Close a window while an explicitly running engine continues work, with a tray presence and clear stop controls.	Sleep, power loss, expired credentials, and uncertain tool outcomes still require recovery rules.
OS integration	Notifications can open the exact agent or docket item; files and folders can open directly into an organization workflow.	Every notification or shortcut needs a useful destination and predictable behavior.
Updates	The product can offer controlled upgrades, compatibility checks, and a visible recovery path.	Installing new code while agents execute is still a coordination problem.
Local operation	A clearer boundary between installed application, user data, projects, and provider connections.	Moving into a desktop shell does not automatically improve security or remove network dependencies.
The current local backend already accesses files and launches harnesses. Browsers can also support some notifications and offline behavior. Those are not entirely new capabilities. The gain is more consistent ownership of their setup, lifecycle, and interaction.

Electron is one candidate for the requested Chromium basis: it provides native application windows and a packaging/distribution path. That makes it worth evaluating, not an automatic choice. Electron windows, application distribution.

How using Orgtree could change
First use: install, launch, choose where organization data belongs, connect an account or supported harness, and open or create an organization. The user should not need Git or a development environment merely to operate Orgtree. If an external harness is required, setup must explain and help satisfy that requirement rather than reveal it through a failed agent turn.

Daily use: open the app or a project shortcut. Restore organizations and windows. See which agents are running, waiting, or needing input. Close a desk without accidentally stopping its agent. Quit or stop work through an explicit control whose consequences are clear.

Recovery: after a crash or restart, show what survived, which actions are known to have completed, and which outcomes remain unknown. An unknown result must not become an automatic repeat of a potentially completed action.

Maintenance: upgrade application code separately from organization data. Explain when an update needs agents to pause. Back up before incompatible data changes and define a recoverable import or rollback procedure.

These are proposed workflows. In particular, continuing after window closure is not yet a decided default.

Pinning and popout windows
User decision, 6 September 2026 at 08:40 UTC: in v2, individual agent or modal tabs can be popped out into separate native windows, alongside pinning. Users can spread work across multiple screens or arrange those windows with their operating system's native tiling manager.

Pinning keeps a view inside its current application window. Popout gives the selected tab its own window. Both belong in the v2 interaction design. Detachable agent views are now a requirement, rather than only a candidate interaction; modal tabs are included too.

The underlying organization remains shared across views. Opening a popout is a view operation, not another hire or an independent copy of the agent's work. Closing, returning, and restoring those windows must fit the engine lifecycle and draft-handling rules still to be agreed in the joint design.

Notifications that open the exact pending question and opening a project folder into the app remain candidates. A command palette, optional global shortcut, taskbar progress, and saved workspace layouts could follow if they make frequent actions easier.

Architecture to evaluate
Three responsibilities should have explicit boundaries:

Desktop interface: windows, navigation, notifications, themes, and input.
Organization engine: agents, lifecycle, permissions, work items, mail, storage, scheduling, and recovery.
Provider and harness adapters: authentication, process or API invocation, supported tools, usage receipts, limits, and session behavior.
Separating the interface from the engine would allow a window to restart without necessarily destroying agent work. Separating adapters would let providers participate through declared capabilities rather than exceptions to a Claude-shaped default.

We should distinguish a provider, a model, a harness, an account, and a route. A route is the chosen combination used to execute a turn. A provider can support several models; a harness can have its own session and tool behavior; an account can change cost or availability without changing the model’s name.

The design should specify one neutral contract for starting, interrupting, resuming, and observing a turn. Adapters must report what they can actually establish, including unknown usage and unavailable continuity. We should test the architecture against at least two materially different execution paths before calling it neutral.

A new repository does not require discarding every tested component. We should inventory what can be ported, what must be wrapped behind a better boundary, and what should be rewritten. The engine language and desktop framework remain open decisions.

Account configuration and hire placement
User decision, 6 September 2026 at 08:20 UTC:

Register alternative configuration directories containing other account sign-ins. Replace proprietary setup-token registration for fallback accounts.
Treat all registered accounts symmetrically; no primary-versus-secondary account hierarchy.
Show usage for all accounts together. Unknown or unavailable usage must remain distinguishable from zero usage.
Let agents choose which account receives a new hire, distributing work across accounts to balance load and avoid disruptive fallback rollover.
Tint agents lighter or darker to distinguish the account they were hired for. This is account identity, separate from model and work status.
The intended continuity benefit comes from choosing an account when placing work, rather than relying on fallback rollover. This is a design goal, not a guarantee of provider cache hits. Each account remains a separate cache namespace, and actual cache evidence must remain distinguishable from a routing preference.

This decision authorizes account selection for hires. It does not yet define moving an existing agent between accounts, changing its provider/model, or what should happen when its assigned account becomes unavailable. Those behaviors remain for joint design; the earlier recommendation that all account autonomy require opt-in does not override the approved hire-placement capability.

Next design work should specify registration and validation of config directories, duplicate-account handling, simultaneous usage freshness, how allowed accounts and capacity are exposed to agents, and how account identity stays legible across themes. Credentials remain in the account's configuration context; registration should not turn their contents into renderer data, transcripts, or diagnostic output.

What to leave behind
The first product-boundary review should place every v1 feature into keep, redesign, defer, or omit. Kiosk mode starts in proposed omission, following the user’s direction. Public share links and browser-only visitor flows should be examined with it.

Remote access to the user's own desktop deployment is now a decided v2 requirement, through the dedicated mobile app described below. It is separate from kiosk and public browser-sharing features, whose proposed omission remains unchanged.

Any retained web content inside the app remains untrusted. Agent output, markdown, and external pages must not gain desktop privileges. Chromium renderer isolation and engine permissions are separate controls; sandboxing a window does not sandbox the commands an agent runs. Electron security guidance.

Dedicated mobile remote access
User decision, 6 September 2026 at 08:45 UTC: provide a fully authenticated, end-to-end remote access system through a separate mobile application. The app authenticates, connects to and streams data directly from a desktop deployment of Orgtree, with a remote-desktop-like connection experience. It is not simply browser access to the existing web interface.

Orgtree will perform NAT punchthrough to avoid requiring port forwarding. Setup includes a simple QR scan that registers the user's external IP address and the authentication credentials needed to connect.

User clarification, 6 September 2026 at 09:11 UTC: mobile setup must be as seamless as possible and require minimal technical knowledge, with no servers for the user to set up. The product must handle any necessary discovery, coordination or connection infrastructure. The user should pair through the app rather than configure servers or networking; the external address and credentials described above are handled by pairing, not manual entry. The architecture and any service operations needed to deliver this experience remain design work.

The joint technical design must specify credential issuance and protection, device trust and revocation, endpoint updates when an external address changes, and behavior when a direct connection cannot be established. No port forwarding is the required experience; traversal feasibility and any discovery or relay infrastructure must be evaluated before implementation guarantees. No relay service has been selected. If discovery or relay services are needed, operating or configuring them cannot become a setup task for the user.

The stream format, mobile platforms, authentication and end-to-end protection protocol, reconnect behavior, and desktop availability rules remain architecture work. A remote-desktop-like experience does not by itself decide between pixels and structured application data. These open details do not reopen the decision to include dedicated mobile remote access.

Themes and identity
Use a neutral default theme and a documented set of replaceable visual values: colors, typography, spacing, and supported accents. Provider-inspired themes should not change routing defaults or permission behavior.

Status must remain legible across themes through text and symbols as well as color. Model cards and clickable agent names should remain consistent. Choosing a Claude-colored theme must not imply that Claude agents receive preferred functionality.

Proposed design and delivery sequence
Stage	Reviewable result	Decision before proceeding
1. Product boundaries	Priority workflows and a keep/redesign/defer/omit inventory of v1.	What is v2 for, and what is deliberately absent?
2. Behavioral design	Window and engine lifecycle, account-routing rules, permissions, recovery, and data ownership.	Agree on user-visible behavior before picking implementation details.
3. Architecture comparison	Desktop framework and engine options, adapter contracts, packaging and update strategy, migration outline.	Choose an architecture against the agreed workflows and constraints.
4. Validation plan	Interaction prototypes and a bounded plan for technical experiments, with success criteria.	Explicit approval to begin prototypes or implementation; none begins now.
5. First working slice	Installable app, one organization, real agent lifecycle across different execution paths, and controlled shutdown/recovery.	Demonstrate that the foundation works before porting the broad feature set.
6. Migration and release	Copy-based v1 import, selected features, signed distribution strategy, update/uninstall behavior, support diagnostics.	Approve release readiness and document deliberate differences from v1.
Initial development must use separate data. Import should copy and validate v1 organizations without moving or modifying the live v1 root. Reversibility needs to cover user data as well as executable versions; an older executable cannot safely open every newer database merely because its installer can be restored.

We should not attach a schedule until the feature inventory and architecture decisions reveal the actual scope.

Decisions for our first discussions
I suggest answering the first three before debating frameworks:

Background operation: should closing the last window leave agents running by default, ask each time, or stop them? My preference is a visible background mode with separate Close window and Stop and quit actions.
Remote lifecycle: dedicated mobile access is decided above. Agree on pairing, reconnect behavior and desktop availability while windows are closed, alongside the proposed omission of kiosk mode.
Account behavior after hiring: account selection for new hires is decided above. Still to discuss: what happens when an assigned account becomes unavailable, and whether an existing agent may move accounts or change provider/model.
Then resolve:

Which three current frustrations should v2 improve most?
Which v1 features are indispensable for the first release, and which should disappear?
Should harness installation be managed by Orgtree, discovered from existing installations, or support both?
Is Windows the only intended platform, or simply the first release target?
Must an organization move between machines as an export, or also synchronize continuously?
Should users be able to install third-party adapters and themes, or only reviewed built-in ones initially?
What must be preserved from existing organizations, including historical sessions whose original harness may no longer be installed?
The important deliverable before development is an agreed product specification with concrete workflows, architecture decisions, migration rules, and explicit omissions. The desktop shell is one part of that specification, not its substitute.