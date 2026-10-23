# Operating and troubleshooting

[Documentation](../README.md#documentation) · [Previous: Projects, queues and automation](projects-and-watchdogs.md) · [Supplement: Development](development.md)

Start with the visible state and its error, then choose the matching recovery action. A renderer window, background engine, harness process and remote provider are different components. Restarting the whole application is not the first remedy for every waiting agent.

## Find out what is running

Check **App settings > About** for desktop version and engine identity. The engine row can include its commit and start time. Unknown information stays unknown; a version being present does not prove a particular task succeeded. The footer and tray expose connection/startup errors.

| Symptom | First checks |
| --- | --- |
| No hire choices | Installed harness, sign-in, provider/account Active, org allowlist, model entitlement and credits. See [Providers](providers-and-tools.md). |
| Waiting for a turn slot | App-wide concurrency, current running turns and any model-server limit. Waiting is not a provider freeze. |
| Halted or organization stopped | The individual Halt and organization STOP ALL latch are independent. Clear the intended hold explicitly. |
| Frozen | Read its actual usage, authentication, balance, connection or account-exclusion cause. |
| Tool or folder refused | Effective scope and harness permissions; changing model alone adds no access. |
| Project job never handled | Mail-queue listener state and delivery mode. Event listeners do not receive mailbox jobs. |
| Outside mail pending | Connections, Normal/DND/Closed inbox mode, route/holder availability and attachment custody. Org DND also holds your own Hubchat mail. |
| Large conversation | Measured context, native/cheap compaction and any recorded overflow error. |

Inspect current files/records before repeating a mutation after a timeout or lost response. It may have applied even though the acknowledgment did not arrive.

## Automatic checkups and reminders

Automatic checkups and docket reminders scan agents and unfinished work in
bounded pages, continuing through large organizations over later sweep ticks.
Working-only checkups skip docket preparation; unrelated retired agents do not
delay them. Docket reminder routing reads only the identities and ancestry
needed by the current active work page.
A page does not cap the agents or tickets that can receive reminders. A docket
reminder still displays at most 20 tickets and the omitted count. The optional
all-blocked reminder checks the entire unfinished, unarchived, non-backlogged
work set; a later unblocked ticket prevents that fallback. These reminders are
eligibility-based nudges, rather than exact wall-clock alarms.

## Stop work at the intended scope

**Stop** interrupts a turn. **Halt** keeps an agent stopped until Unhalt. Neither reverses external effects, and neither retires the seat. For an emergency organization-wide stop, open the guard and press **STOP ALL**, or use Shift+F10. F10 only opens the guard; it does not halt or release an already halted org.

STOP ALL sets an organization admission latch, requests interruption of busy turns and pauses armed watchdogs. **HALTED — RELEASE** clears that org latch. It does not clear individual agent halts, resume paused watchdogs or give everyone a new task. Inspect those separately before resuming the intended work.

If an interrupt was queued at a tool/completion boundary, acceptance is not proof the turn already stopped. Boundaries differ by harness, and some asynchronous notifications can cut off the beginning of the next step. Check the settled state. A halt or restart can also stop background work tied to that process.

Unfinished reply text received before a turn stops remains visible in Chat and
saved history as an **incomplete response**. Interrupted or killed turns also
show **interrupted**. The text stays separate from thinking. Where supported, a
later completion matching the saved message identity and text prefix replaces
the partial response and removes the marker; without that matching completion,
the marker remains. This does not recover text the harness never emitted or
confirm whether an interrupted tool finished its external action.

## Updates and background operation

Right-click Orgtree's **system-tray icon** to check for updates, see download progress and choose **Update now** when the download is ready. The update can be completed from that menu.

**Automatic updates** are on by default where the installation supports unattended updates. Turn them off in the tray menu or **App settings > Runtime** to stop background checks and idle installation. Manual update controls remain available. A download already in progress may finish; an installation already started completes.

The tray also provides organization navigation and controls for startup and **Exit on close**. With Exit on close disabled, closing the last window keeps the desktop available in the background; open it again from the tray. With it enabled, the desktop exits when its last visible window closes. On an all-users Windows installation, the separate background engine is not stopped by closing or quitting the desktop.

On an all-users Windows installation, **Run on boot** starts the background engine in Windows Session 0. A sign-in helper runs agent turns in your signed-in session when available; at sign-out, interrupted work resumes in Session 0. On per-user installations, the startup control is **Run on sign-in**. Turning automatic startup off prevents future automatic starts; it does not stop an engine already running or prevent an explicit start or recovery. See the [desktop runtime reference](skills/orgtree-app/app-settings/app-runtime-desktop/SKILL.md).

<a id="account-fallback"></a>

## Recover a frozen agent

Read the freeze badge's reason, deadline and provenance. A quota limit, rejected login, exhausted balance and unavailable connection need different remedies. Old percentages after a reset can be unknown rather than fresh capacity.

For a usage deadline, **Organization settings > Autonomy > auto-resume** permits recovery one minute after the reported reset. It is on by default unless saved defaults/policy differ. A qualifying non-Muse quota refusal without a parseable future reset can use a one-hour fallback retry schedule; that is not a provider-confirmed reset or proof of fresh capacity. Muse keeps its typed quota reset authoritative. Turning auto-resume off keeps the hold; turning it back on is rechecked without an engine restart. Authentication/balance failures do not become quota resets simply because a timestamp exists.

Reset evidence can include a duration, a timestamp or a clock in the CLI host's local zone. Unknown named zones are not guessed. Applicable fresh same-account usage evidence can extend a hold; stale or unrelated readings cannot manufacture recovery. Read the recorded deadline and reason rather than assuming all similar errors use one timer.

**Resume frozen agents now** or a desk's unstick action explicitly clears the hold for retry. It creates no provider allowance and leaves other holds, such as Halt, in place. A provider can refuse again. **Continue on…**, where offered, selects an eligible same-provider account and releases the freeze together. A plain account settings edit is not the same recovery action.

Clearing an account's recorded capacity mark is different again: it resumes nobody. Repair actual sign-in/billing problems at the provider, then use the appropriate retry. Avoid repeated clearing of a still-exhausted lane. Automatic account fallback and paid-key opt-ins are covered in [Providers, models and tools](providers-and-tools.md#automatic-fallback-and-metered-keys).

## Recover context without assuming everything was remembered

The context wheel measures conversation occupancy where the harness supplies it. A saved number is not a provider bill or quota reading. **Normal compact** is available for supported Claude/Muse routes; **Cheap compact** starts a new session with a bounded handoff summary. Unsupported, busy and unmeasured cases can be skipped with reasons.

The ordinary compaction threshold, known-cold fresh-start policy and measured-size/overflow recovery are separate paths. Disabling the known-cold policy does not disable all fresh-session recovery. A summary can omit detail, so keep requirements, next steps and exact evidence in docket items and working notes. Native Claude/Codex context overflow has a bounded fresh-session retry; it is not an unlimited retry loop for every model refusal.

After an engine stop or Windows sign-out interrupts work, an affected agent can receive a waking recovery message. Ask it to inspect its notes, mail, docket and actual files before repeating commands. Retained transcript text, a resumed provider session and a provider cache hit are separate evidence.

## Windows sessions and administrator rights

The all-users engine stays in **Session 0**, including restarts and updates. While signed in, its helper runs eligible agent CLIs in your signed-in session. Agents move between sessions at turn boundaries. Session 0 has no interactive desktop; screen/app automation and interactive sign-ins cannot work there as if a person were present.

An agent's Scope settings can prefer the signed-in, console, remote or Session 0 route for later turns. The Session 0 badge reports actual placement and can explain why the fallback happened; a saved preference alone is not proof of where the current process runs. After restart, turns can wait for the sign-in helper before falling back.

For Muse normal-write agents, actual CLI placement also changes sandbox enforcement: in Session 0 the OS sandbox is disabled, so native operations can exceed folder grants without an approval callback. A normal-write CLI hosted in the signed-in session keeps it. See [Managing agents](managing-agents.md#give-the-agent-the-right-access) for the permission choices and the separate read-only/Unrestricted policies.

**Run as admin**, in Runtime or the tray, changes both the engine and helper together. It is off by default, requires the warning/Windows permission flow and applies by restarting them, interrupting turns. With it on, their agents have full administrator rights on later starts without further prompts. Choose it only for work requiring those rights. Declining or failing the change leaves the saved choice unchanged and reports the reason. There is no separate one-off elevation button. The bundled PostgreSQL database still runs without administrator rights.

## Restart only when needed

The tray's **Restart engine / Start engine** is the explicit engine recovery control. On an all-users install it uses the boot task even with Run on boot turned off. A task-read failure starts no substitute engine; read the reported reason. A busy restart/update refuses a competing restart, and a click is not a readiness receipt.

Restarting stops active turns and can end dependent jobs. After reconnecting, inspect whether the requested operation already happened. The desktop can show a backend-restart notice with Reload now or a deferral for unsaved work. Other windows can reload automatically. Preserve unfinished edits before choosing Reload.

A renderer exception can show **Orgtree hit a problem and had to stop**, its error and Reload. Reload retries the UI and can discard drafts. It is different from resuming a usage-frozen agent. The local crash-report attempt is not proof a report was delivered successfully.

## Read history and collect diagnostics

**Organization settings > History** is a read-only retained-record browser. Select a collection and, where required, a live/archived agent. It includes transcript, agent/user/org mail, notices, documents, events, errors, watchdogs and turn usage. Older/Newer page through retained data; Refresh returns to the newest page. Opening a record does not replay it or undo an operation. The separate undo history reverses supported actions.

The agent History tab contains retained events; Chat contains its conversation. A failed history load is not evidence that no action occurred. The organization mail collection is unavailable while the outside inbox is disabled, without deleting its retained mail.

**Developer > Open logs folder** opens local logs without sending them anywhere. **Verbose engine logging** adds diagnostic detail and volume under the logging/redaction policy; it saves immediately unless a process environment override fixes it. Packaged builds default to normal logging. Review logs before sharing, especially paths, identifiers and third-party output.

The **engine debug view** displays measured memory, socket backlog and docket traffic; its numbers alone do not diagnose a leak. The separate `/debug/freezes` view reads bounded browser-stall observations, with refresh/copy/clear controls. A UI frame gap is different from an agent usage freeze.

The quiet area below Developer controls reveals optional **EPIC Mode**. While enabled, observed thinking, writing, tools, waiting and compaction add audiovisual activity layers and heat; this does not measure useful progress. The tray's **Mute EPIC sounds** appears while enabled, saves across restarts and applies to all windows/popouts. Muting leaves visuals and activity detection running; unmuting follows current activity without replaying missed sounds. Disabling EPIC stops its audiovisual effect.

When [reporting a bug](https://github.com/Maurdekye/orgtree/issues), include app/engine identity, Windows version, reproducible steps, actual error and relevant redacted evidence. Say what was observed versus what you inferred. Do not publish keys, verification codes, private correspondence or personal paths.

## Data and privacy

In the desktop installation, the engine runs locally, and organization data and retained history are stored on your machine in its bundled database. The database listens on the local loopback interface. A standard Windows installation keeps Orgtree's data under **`%APPDATA%\Orgtree v2\data`**. Account profiles can also use provider-specific locations.

Agent requests still go to the providers you configure. Local storage does not mean model inference happens offline. Folder and tool permissions are worth choosing deliberately, just as they are when running the provider's coding tool directly.

Using a mail hub sends the messages and files you route through it to that hub; its operator can read the mail it stores. A self-hosted model server may also run on another machine. Choose those endpoints according to where you intend the work to go.

Retained records are not a backup strategy. Before moving a valuable installation or restoring data, preserve a recoverable copy using a consistent database-aware procedure; copying a live PostgreSQL directory mid-write is not one. User-mail deletion, presentation dismissal, retirement, permanent agent deletion and hub retention have different scopes, so do not treat any one as an erase-everything control.

## Advanced deployments

The packaged desktop is the ordinary starting point. A standalone Rust engine can run without the desktop and be managed through its authenticated HTTP/WebSocket API, directly or with the repository's Docker packaging assets. This is an operator deployment, not a second desktop sign-in wizard. Protect its token and data, and follow the [standalone engine guide](rust-engine/STANDALONE-ENGINE.md) for configuration. The repository's earlier verification did not establish a Docker/Linux real-provider deployment.

Standalone mode requires an absolute data root and a token of at least 32 characters, generated into that root when none is configured. It binds loopback by default and requires authentication for API/socket/UI requests. An explicitly remote bind needs the intended private-network or proxy arrangement; the engine does not add TLS itself. Keep this deployment separate from a desktop's owned data root.

It also exposes a **user MCP endpoint**: the app-wide endpoint finds/creates organizations, and the per-org endpoint provides a selected set of user actions for chart, mail, inbox, docket, hiring/retirement, interrupt and question answers. A compatible client sends authenticated Streamable HTTP requests. These act **as you**, not as a low-privilege agent. The endpoint is only available in standalone mode and does not yet cover attachments/reply quoting, all tree/settings/account operations or every agent tool. Consult the guide's current tool list and limits before connecting a client.

The per-org user inbox tool also reads/configures the outside-inbox mode through its dedicated settings/configure actions. That user-token authority does not let an agent configure it. Each stateless POST accepts one JSON-RPC object or a sequential batch; requests with non-null IDs receive responses, while an all-notification POST returns HTTP 202 without a body. Tool calls require request IDs, and a batch is not atomic. GET does not open a stream. User mail is one recipient with nonblank text, without outside-mail or attachment/reply-reference support in this subset. Use the dedicated [standalone reference](skills/orgtree-working/runtime/standalone-engine/SKILL.md) for endpoint/tool differences instead of applying agent-only contracts to a user client.

User tool cards describe supported user operations. Unsupported options are refused before an action, including queued/restart interrupt flags even when false or null. User mail offers only one recipient, optional passive delivery and text. Agent-mail kind/urgency/tags/options, attachments and reply quoting are absent. Use the served fields rather than copying an agent tool call.

Headless provider sign-in, named/revocable client tokens and desktop attachment to a standalone engine remain deferred. Install and sign into the host's provider tools separately, or configure supported key routes. Serving a renderer bundle is not a supported remote-browser management workflow in this feature. When no user is present, user-bound requests can be denied rather than silently answered by an agent.

An independent mail hub is a different service: it relays mail, not model sessions. [Collaboration](collaborating.md#choose-a-hosting-arrangement) and [developer team setup](team-setup.md) describe that arrangement. For source builds and contributions, use the supplemental [Development](development.md) guide.
