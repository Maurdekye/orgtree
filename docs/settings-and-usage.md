# Settings, usage and shortcuts

[Documentation](../README.md#documentation) · [Previous: Messages and work](messages-and-work.md) · [Next: Providers, models and tools](providers-and-tools.md)

Use settings to make ordinary work easier first: text size, Enter behavior and the alerts you want. Then tune capacity and defaults with a concrete task in mind. Credits, running-turn capacity, context occupancy and provider allowance measure different things.

## Find the right settings

| Where | What it controls | Saving |
| --- | --- | --- |
| App settings | Appearance, typing, runtime, notifications, providers and future-org defaults. | Most switches save immediately; default-org fields use their own Save. |
| Organization settings | This org's instructions, hire defaults, policies, allowed accounts and connections. | Basic/Hire defaults/Policies and Connections' inbox mode/holder policy share a footer Save; hub memberships and several other actions save immediately. |
| Agent settings | This agent's role, model/account and scope. | Buffered tabs share Save; Rename, lifecycle actions and the credit slider act separately. |

Do not close a form assuming every visible edit was saved. A failed multi-part save may have applied an earlier part. Check the current state before retrying. A setting read that failed can display a fallback; it is not authoritative evidence of your stored value.

## Make the workspace comfortable

**Display > Appearance** separates accent from contrast. Choose a provider-colored or custom accent, and a light/dark contrast scheme. Automatic appearance can follow an installed harness until you make an explicit choice. Agent color can follow the provider or the organization. These choices do not change an account, model or work state.

The named presets are Claude Terracotta, Codex Teal, Antigravity Navy, Muse Eggshell, OpenRouter Lavender and LMS Gold, plus Custom. If Rainbow has already been revealed in this profile, choosing Custom also offers the saved **Rainbow** switch. It animates the accent; turning it off restores the static custom color. The former Orgtree Grey choice is retired: an explicitly saved old selection becomes **Custom #b6bdc8**, preserving its base RGB. An old unset/automatic preference keeps provider detection instead. No separate agent, organization or template theme field is introduced by that migration.

**Canvas background** offers dots, grids, checkerboard, outlined tiles, None and Claude Waves, with an intensity saved per pattern. Lower intensity or None can make a busy canvas calmer. The animated background can pause or reduce work when hidden or under load.

**Display > Desk** includes:

- Row or circular chart layout, desk text size (75–250%), crowded-team stacks and hiding retired agents.
- Bunching consecutive projects, and a separate opt-in to rearrange projects inside a bunch. Bunching alone changes drawing; rearranging changes tree order.
- Card shortcut buttons, folding long jump-card rows, pin snapping, overlap fading and keeping corner controls inside the area left by pins.

**Display > Typing/startup** chooses Enter-to-send or Enter-to-newline, Quick chat at the top/bottom or hidden, restored windows versus a fresh homepage, and the initial organization view. Quick chat has its own Enter-to-hire behavior. Window restoration is different from starting the background engine at boot.

These presentation preferences do not change agent prompts. Some are stored per desktop/browser profile, so a second machine need not share them.

## Choose notifications

Open **Runtime > Notifications**. The master switch pauses native alerts without forgetting the selected categories. Questions, urgent mail, terminal failures, docket attention and mentions start on. Routine **All mail**, new presentations, frozen-agent alerts and **Notify while Orgtree is focused** start off; older saved preferences can differ.

By default a focused visible Orgtree window suppresses desktop banners, even if another organization is in the background. Enable the focused option if you want those banners while working in Orgtree. The **open questions** preference chooses whether taskbar question entries focus the asking desk or open questions as mail.

The persistent taskbar attention dot is separate from banner preferences. It follows unresolved questions, urgent/user-mention mail, docket flags and user mentions; ordinary unread mail does not add it. Resolve the underlying attention to clear it. Neither a native banner nor a read badge implies approval of the work.

## Read current usage

Open **Usage** from the application menu or press F2. From an organization, it initially shows that org's allowed accounts; **Show all accounts** widens the human view. From Home it is app-wide.

Read the observation date, freshness and error alongside each bar:

| Display | Interpretation |
| --- | --- |
| Subscription window | Provider-reported allowance for that account/model pool and reset. Multiple windows can apply together. |
| OpenRouter key | Key spend/cap and account balance, where reported. |
| API key | Local metering, not a guarantee that the remote provider will accept another request. |
| Local server | No provider subscription limit reported; its own concurrency and server capacity still matter. |
| Unavailable / stale | Capacity is unknown or dated. It is not zero usage or spare capacity. |

A Refresh can be pending, rate-limited or fail while preserving old observations with their date. A paused usage service is different from rejected credentials. Muse obtains observations through turns, so its independent refresh stays disabled; **reset; awaiting reading** means the new allowance is unknown. A provider/network error alone is not proof that another sign-in is required.

Changing an account's allowed state is separate from reading its usage. **Organization settings > Accounts** allows or disallows lanes for that org immediately. A disabled application account must first be enabled in Providers. Unticking a serving account lets the running turn finish; later admission moves to another eligible same-provider lane or freezes if none is usable, even with usage-limit fallback off.

## Use usage history

F3 opens **Usage history**. Choose 24 hours, 7, 30 or 90 days, then filter by provider, account, window or model scope. Each chart is one series, with its own percent or money units. Gaps are missing observations, not zero consumption; reset markers break the line.

Readings separated by 30 minutes or more connect as a step: the earlier value stays horizontal until the later timestamp, then changes vertically. Hover within that gap shows the earlier observation, not a newly measured or interpolated value. The step does not mean the engine sampled throughout the gap.

**Projected ahead** controls how much of the chart is a future pane. The dashed projection fits retained readings; it is not a promised exhaustion time. Increasing the future share crops older history rather than squeezing the entire period. CSV/JSONL exports contain the recorded points supplied for the chart, not the projection, and can reflect downsampling. An engine that was off cannot reconstruct readings it never observed.

## Tune runtime capacity and reminders

**Runtime > Turns and agent processes** applies across organizations:

| Control | Starting behavior and purpose |
| --- | --- |
| Most agent turns running at once | Engine default 16; UI range 1–512. Lower for machine pressure. Raising it does not add credits or provider capacity. |
| Keep agent processes warm | On. Keeps eligible idle harnesses ready, within memory and parked-process limits. Off cools idle processes without interrupting active turns. |
| Check on working agents after 20 minutes | On. Eligibility-based checkups for inactive working agents and agents still holding project mail/slot leases, not an exact alarm. |
| Remind idle agents about unfinished docket items | On. Wakes for actionable owed work. |
| Also remind when every ticket is blocked | Off. Adds blocked reminders under that condition; it does not detect an external dependency becoming ready. |
| Wake an agent to listen for project mail | On. If a project receives mail without a queue listener, asks a direct member to arm one. Off leaves mail waiting. |
| Wait until the MCP tool surface is ready | Off. Enables a supported startup readiness wait; it does not install/authenticate/grant a server. |

Lowering concurrency leaves admitted turns running and queues new ones. Scheduling is first-come within an organization and round-robin across organizations. A model server can impose another capacity wait. Checkups defer for busy, halted, frozen or otherwise ineligible agents. An agent holding unacknowledged project mail or a slot lease can receive a resource-custody checkup even after reporting Blocked, Idle or Done. Working checkups and docket reminders are independent; neither substitutes for a real message or event watcher.

The feedback suggestion switch encourages agents to prepare redacted issue drafts when appropriate. It does not authorize posting without your explicit OK. The optional Antigravity Claude-model switch exposes eligible offers; it does not create quota or move existing native Claude seats.

### Time limits

**Turn time limits** distinguishes a total ceiling (built-in 24 hours) from a silence ceiling (built-in 10 minutes without a stream event). A row can be disabled or edited in minutes/hours. Zero disables the corresponding engine limit.

Use actual evidence before increasing a silence allowance for a legitimate quiet operation. Changes apply across organizations and can affect an already running turn at its next timer check. A harness may also retain a timeout supplied when its process launched. Raising a limit does not revive a turn already ended. Some Muse foreground-tool recovery differs, but the total ceiling still applies. See [Operating and troubleshooting](operating-orgtree.md).

## Set organization defaults deliberately

**App settings > Default org settings** supplies defaults for future organizations. Explicit existing-org values remain; missing keys can still inherit effective defaults. For a current org, use its own settings.

**Organization settings > Basic** contains the top-level grant cap, new-hire grant, context-compaction threshold, default effort, logo and org charter. Loaded effective values include saved overrides. Built-in defaults include a 1,000-credit top-level cap, 20-credit hire grant and 80% ordinary compaction threshold. An agent's own effort wins; otherwise it inherits the org setting for its next turn. **Default (high fallback)** uses high only when neither supplies a level, before harness/model mapping.

The **Logo** picker accepts a static PNG/JPEG/WebP up to 5 MiB and 16 million pixels. Crop it, then use **Save logo**; logo saves/removal are independent of the footer. The org logo is also its Hubchat account picture.

**Org charter** supplies instructions to all agents. Keep critical rules near the beginning: only the first 16,000 trimmed Unicode characters are delivered. Longer saved text is warned about. If another writer changed the charter after you opened it, reload and reconcile instead of overwriting the new note. A loaded editable charter is submitted by the shared Save even when you edited another field, which can reconfigure processes. [Collaboration](collaborating.md) explains instruction homes and phone-link trust notes.

**Hire defaults** sets future agents' folders, visibility, permission mode, native/Orgtree/MCP tools, account and supported fast-mode defaults. It is not a bulk rewrite of existing saved agent settings. Removing/downgrading org folder holdings does restrict existing effective grants; adding the holding back does not automatically restore revoked grants. Review that warning before saving.

### Less common policies

- **Credit cost bubbling** is app-wide and controls your own hires separately from allocations/model upgrades. On raises intervening grants as needed within the top-level cap; Off requires the paying parent to have free capacity already. Agents remain bounded by their own allocation under their separate funding rules.
- **Quick staff behavior** chooses request staffing, hire under the assignee or hire at top level. If the assignee is unavailable, the disclosed fallback can be immediate top-level staffing.
- **Policies > Cache-protective cheap compaction** allows summarized fresh sessions before eligible known-cold turns, using measured occupancy. New orgs start on at 25%; existing saved choices remain. This is separate from ordinary context-size compaction and other recovery paths.
- **Connections > External org inbox** offers Normal operations, Do not disturb and Closed off inbox. Org DND keeps all outside mail, including your Hubchat messages, without automatic agent delivery; Closed blocks outside communication and hides retained history. These fields wait for Save. Multiple inbox holders are off by default; revoke extras before disabling that policy. See [outside inbox modes](collaborating.md#choose-an-outside-inbox-mode).
- **Autonomy** controls same-provider account fallback (off by default), reset-time auto-resume (on by default) and **Resume frozen agents now**. These actions are immediate and do not create capacity; details are in [Providers](providers-and-tools.md) and [Operation](operating-orgtree.md).
- **Charter documents/template folders** manage reusable text choices. Populate/Restore writes missing bundled choices without overwriting local files. Selecting a charter supplies text, not tools or audiences. External charter folders are distinct from installed skills and agent folder grants.

  Charter-folder scans skip links, junctions, reparse points and cloud placeholders, including linked parent folders. Use absolute paths without `..`. Each folder examines at most 500 directly contained Markdown entries, counting skipped entries too. Files over 1,000,000 bytes are refused before reading their contents. The folder row reports refused paths, skipped files and a shortened listing. Keep cloud files locally available in a plain folder before using them. The hire form shows at most 100,000 characters from a readable preset and marks truncation; text entered directly into an agent charter keeps its existing rules.
- **History**, **About** and developer diagnostics are reference/recovery surfaces. [Operation](operating-orgtree.md) covers them; [Development](development.md) covers contributor tools.

## Keyboard shortcuts

**App settings > Keyboard shortcuts** is a reference, not a rebinding editor. `Mod` means Ctrl on Windows/Linux and Command on macOS. Main-window function keys work while typing; Ctrl/Alt/Command modifiers prevent their match, and holding a key does not repeat the action. A missing org/panel handler has no effect.

| Key | Action |
| --- | --- |
| F1 / F2 / F3 | Toggle App settings / Usage / Usage history. |
| F4 | Toggle Canvas/Attention, or return to Canvas from an open panel. |
| Shift+F4 | Jump to the newest recorded user mention across transcript, mail and docket sources; separate presses visit older entries without wrapping. |
| F5 | Refresh the app view. |
| F6 / F7 / F8 / F9 | Toggle current-org Inbox / Docket / Presentations / Settings. |
| F10 | Open the STOP ALL guard; does not halt or release an already halted org. |
| Shift+F10 | Halt all immediately, whether armed or not. |
| Shift+F1 / Shift+F2 / Shift+F3 | New Homepage window / app menu at Open organization / create organization. |
| Shift+F6 / Shift+F7 / Shift+F8 | Fit whole org / last live agent desk / switchboard. |
| Escape | Close the top menu/dialog, cancel a drag/draft or clear a staged reply, according to focus. |
| Mod+Z / Ctrl+Y or Mod+Shift+Z | Undo / redo supported persistent actions, deferring to text editing while typing. |
| Mod+Enter | Send or submit a ready answer; ordinary Enter follows the typing preference. |
| Alt+N | Toggle a passive notice in a desk composer. |
| Alt+Up/Down | Previous/next mail; in focused Docket/Presentations, previous/next eligible rendered item. |

Lists, menus, settings tabs, effort and grant controls support keyboard navigation. Question batches use Alt+Left/Right between questions; Alt+Up/Down adjusts a credit offer. Docket/Presentation navigation skips filtered/folded items and clamps at the ends. Draft replies, answers and child editors can block navigation to protect unfinished input. Quick chat has a single-line field: Enter hires/sends; Shift+Enter does not submit or insert a newline.

Shift+F4 includes seen entries and resets to the newest if a newer mention arrives. It opens the desk/mail/ticket reader and highlights the mention. If a ticket edit removed the original text, a labelled recorded excerpt remains available. No history shows **No @user mentions yet**; reaching the oldest shows **No older @user mentions**, keeping the current view in place. Holding the key does not keep stepping.

Its history starts at **4.4.2**, seeded from a bounded set of still-pending markers at upgrade. It keeps the newest **2,000 mentions per organization**, including seen entries recorded since then. Older handled history is not backfilled. The header's glowing @ button remains a separate route through unobserved transcript markers.

The next guide covers [Providers, models and tools](providers-and-tools.md) once ordinary work is running reliably.
